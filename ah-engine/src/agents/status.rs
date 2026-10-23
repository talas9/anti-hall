//! `ah-engine agents`: `status` (a table of every tracked agent, read-only) and `tick` (one tracker tick now; what the scheduled job runs).
use super::signals::state_of;
use super::sinks::age;
use super::{Env, State, Totals, fmtc, fmtn, load_state, save_state, tick};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Value, json};

/// The agents each session launched, by the session's id.
fn children(agents: &[&super::Agent]) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut out: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for a in agents.iter().filter(|a| super::is_child(a)) {
        out.entry(a.parent.clone()).or_default().push(a.id.clone());
    }
    out
}

/// One agent's row. `all` is every tracked agent, for the links of the tree: its parent, its children, the project it works in.
fn row(a: &super::Agent, now: u64, all: &std::collections::BTreeMap<&str, &super::Agent>, kids: &std::collections::BTreeMap<String, Vec<String>>) -> Value {
    let roles = defaults::raw("agent_tracker.roles");
    let mine = kids.get(&a.id).cloned().unwrap_or_default();
    let session = a.kind == super::kind_name("main") || a.kind == super::kind_name("workspace");
    let parent = (a.parent != a.id && !a.parent.is_empty()).then(|| a.parent.clone());
    // a launched agent works in its launcher's project when its own transcript named none
    let project = if a.cwd.is_empty() { parent.as_deref().and_then(|p| all.get(p)).map(|p| p.cwd.clone()).unwrap_or_default() } else { a.cwd.clone() };
    let last = if a.last_output_ms == 0 { Value::Null } else { json!(now.saturating_sub(a.last_output_ms) / fmtn("ms_per_s")) };
    json!({
        "agent": a.id, "name": a.name, "kind": a.kind, "state": state_of(a), "source": a.source, "host_state": a.host,
        "tokens_in": a.tin, "tokens_out": a.tout, "cache_read": a.tcr, "cache_write": a.tcw, "tool_calls": a.tools,
        "progress": a.progress, "commits": a.commits, "files_edited": a.files.len(), "tests_passed": a.tests_pass, "steps_done": a.steps_done,
        "errors": a.errors, "step": a.step, "waste": {"score": a.waste.score.round(), "verdict": a.waste.verdict, "confidence": a.waste.confidence, "source": a.waste.source, "action": a.waste.action, "judge_calls": a.waste.judge_calls, "cell": super::waste::cell(a)}, "last_output_s": last, "partial": a.partial,
        "flags": a.flags.iter().map(|(k, f)| json!({"signal": k, "since": f.since, "evidence": f.evidence, "text": f.text, "reminded_at": f.reminded_at, "delivered_at": f.delivered_at})).collect::<Vec<_>>(),
        "workspace": a.ws.as_ref().map(|w| json!({"id": w.id, "watcher_armed": w.armed, "step": w.step})),
        "parent": parent, "children": mine, "project": project, "transcript": a.path, "team": a.team, "pid": (a.pid != 0).then_some(a.pid),
        "role": session.then(|| if mine.is_empty() { roles.str_field("solo") } else { roles.str_field("primary") }),
    })
}

fn totals_json(t: &Totals) -> Value {
    json!({"signals": t.signals, "reminders_queued": t.queued, "reminders_delivered": t.delivered, "reminders_held_back": t.suppressed, "recoveries": t.recovered, "false_positives": t.false_positives, "not_recovered": t.unrecovered, "tokens_burned_by_flagged": t.burned})
}

/// The status document.
pub(crate) fn document(env: &Env, st: &State, l: &super::sources::Listing) -> Value {
    // live agents always show; a finished one only while it is recent
    let done = defaults::raw("agent_tracker.states").str_field("done");
    let keep = super::lim("done_keep_ms");
    let (mut agents, hidden): (Vec<&super::Agent>, Vec<&super::Agent>) =
        st.agents.values().partition(|a| state_of(a) != done || env.now_ms.saturating_sub(a.last_output_ms) <= keep);
    let live: Vec<&super::Agent> = agents.iter().copied().filter(|a| state_of(a) != done).collect();
    let n = |f: &dyn Fn(&super::Agent) -> bool| live.iter().filter(|a| f(a)).count();
    let kc = defaults::raw("agent_tracker.counts");
    let counts = json!({
        kc.str_field("sessions"): n(&|a| a.kind == super::kind_name("main") || a.kind == super::kind_name("workspace")),
        kc.str_field("subagents"): n(&|a| a.kind == super::kind_name("subagent")),
        kc.str_field("teammates"): n(&|a| a.kind == super::kind_name("teammate")),
        kc.str_field("codex"): n(&|a| a.kind == super::kind_name("codex")),
        kc.str_field("headless"): st.headless.len(),
        kc.str_field("done_hidden"): hidden.len(),
        kc.str_field("listed"): agents.len(),
    });
    agents.sort_by(|a, b| b.flags.len().cmp(&a.flags.len()).then(b.last_output_ms.cmp(&a.last_output_ms)));
    let cli = defaults::raw("agent_tracker.claude_cli");
    let by_id: std::collections::BTreeMap<&str, &super::Agent> = st.agents.values().map(|a| (a.id.as_str(), a)).collect();
    let everyone: Vec<&super::Agent> = st.agents.values().collect();
    let kids = children(&everyone);
    json!({
        "generated_ms": env.now_ms,
        "summary": counts,
        "claude": {"version": l.cli_version, "agents_json": st.cli_ok, "used": l.cli_used, "verified_on": cli.get("verified").map(|v| v.to_json())},
        "agents": agents.iter().map(|a| row(a, env.now_ms, &by_id, &kids)).collect::<Vec<_>>(),
        "today": totals_json(&st.today(env)),
    })
}

fn cell(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::Null => fmtc("none").to_string(),
        Value::String(s) if s.is_empty() => fmtc("none").to_string(),
        Value::String(s) => s.clone(),
        o => o.to_string(),
    }
}

/// The document as a table plus the summary lines.
pub(crate) fn render(doc: &Value) -> String {
    let agents = doc["agents"].as_array().map_or(&[][..], Vec::as_slice);
    if agents.is_empty() {
        return defaults::render("msg.agent_status_empty", &[]);
    }
    let cols = defaults::raw("agent_tracker.fmt").get("columns").map(defaults::V::strings).unwrap_or_default();
    let sep = fmtc("sep");
    let name_max = fmtn("name_max") as usize;
    let mut rows: Vec<Vec<String>> = vec![cols.iter().map(|c| c.to_string()).collect()];
    for a in agents {
        let who = if a["name"].as_str().is_some_and(|n| !n.is_empty()) { a["name"].as_str().unwrap_or("") } else { a["agent"].as_str().unwrap_or("") };
        let cache = a["cache_read"].as_u64().unwrap_or(0) + a["cache_write"].as_u64().unwrap_or(0);
        let last = a["last_output_s"].as_u64().map_or(fmtc("none").to_string(), |s| age(s * fmtn("ms_per_s")));
        let flags = a["flags"]
            .as_array()
            .map(|f| f.iter().filter_map(|x| x["signal"].as_str()).collect::<Vec<_>>().join(fmtc("flags_sep")))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fmtc("none").to_string());
        rows.push(vec![
            who.chars().take(name_max).collect(),
            cell(a, "kind"),
            cell(a, "state"),
            cell(a, "tokens_in"),
            cell(a, "tokens_out"),
            cache.to_string(),
            cell(a, "tool_calls"),
            cell(a, "progress"),
            last,
            a["waste"]["cell"].as_str().unwrap_or("").to_string(),
            flags,
        ]);
    }
    let widths: Vec<usize> = (0..cols.len()).map(|i| rows.iter().map(|r| r.get(i).map_or(0, |c| c.chars().count())).max().unwrap_or(0)).collect();
    let mut out = String::new();
    for r in &rows {
        let line: Vec<String> = r.iter().enumerate().map(|(i, c)| format!("{c:<w$}", w = widths[i])).collect();
        out.push_str(line.join(sep).trim_end());
        out.push('\n');
    }
    let t = &doc["today"];
    let n = |k: &str| t[k].as_u64().unwrap_or(0);
    let flagged = agents.iter().filter(|a| a["flags"].as_array().is_some_and(|f| !f.is_empty())).count();
    out.push_str(&defaults::render(
        "msg.agent_status_totals",
        &[
            ("agents", &agents.len()),
            ("flagged", &flagged),
            ("signals", &n("signals")),
            ("queued", &n("reminders_queued")),
            ("delivered", &n("reminders_delivered")),
            ("suppressed", &n("reminders_held_back")),
            ("recovered", &n("recoveries")),
            ("fp", &n("false_positives")),
            ("burned", &n("tokens_burned_by_flagged")),
        ],
    ));
    let used = if doc["claude"]["used"].as_bool() == Some(true) {
        defaults::render("msg.agent_status_source_ok", &[])
    } else {
        defaults::render("msg.agent_status_source_off", &[])
    };
    out.push('\n');
    out.push_str(&defaults::render("msg.agent_status_source", &[("version", &doc["claude"]["version"].as_str().unwrap_or("")), ("ok", &used)]));
    out
}

/// `ah-engine agents status|tick [--json]`.
pub fn run_cmd(p: &Parsed) -> i32 {
    let sub = p.rest.first().map(String::as_str).unwrap_or("status");
    let Some(mut env) = Env::current() else { return 64 };
    if sub == defaults::text("agent_tracker.wake_verb") {
        return super::wake::run(p);
    }
    if sub != "status" && sub != "tick" {
        eprintln!("{}", defaults::render("msg.agent_usage", &[]));
        return 64;
    }
    if !env.switch("agent_tracker.setting") {
        println!("{}", if p.json { json!({"enabled": false}).to_string() } else { defaults::render("msg.agent_disabled", &[]) });
        return 0;
    }
    let mut st = load_state(&env);
    env.act = sub == "tick";
    let l = tick(&env, &mut st);
    if env.act {
        save_state(&env, &st);
    }
    let doc = document(&env, &st, &l);
    println!("{}", if p.json { doc.to_string() } else { render(&doc) });
    0
}
