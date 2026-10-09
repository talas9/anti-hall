//! Where the tracker finds agents: Claude Code transcripts (sessions and their subagents), heartbeat files, DevSwarm descriptors, plans
//! and wake-watch locks, and the Claude Code CLI's own session listing (`claude agents --json`).
//!
//! The CLI is used only where it beats a transcript (whether a session is busy, waiting or gone). It runs as a bounded subprocess,
//! is probed once per Claude Code version and cached, and a failed or unverified probe falls back to the transcripts. Only the
//! `--json` form is read; no human-formatted output is ever parsed.
use super::facts;
use super::{Agent, Env, State, Ws, fmtn, kind_name, lim, pth};
use crate::checks::agent_scan::mtime_ms;
use crate::defaults::{self, V};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// What a refresh learned about its sources, for the status footer.
#[derive(Debug, Clone, Default)]
pub struct Listing {
    /// The Claude Code version the CLI source was checked on.
    pub cli_version: String,
    /// The CLI listing was used this tick.
    pub cli_used: bool,
}

struct Found {
    id: String,
    kind: &'static str,
    parent: String,
    name: String,
    path: String,
    mtime: u64,
}

fn read_dir(p: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(p).map(|r| r.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default()
}

fn json_of(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn discover(env: &Env) -> Vec<Found> {
    let cutoff = env.now_ms.saturating_sub(lim("active_window_ms"));
    let ext = pth("transcript_ext");
    let mut out = Vec::new();
    for proj in read_dir(&env.home.join(pth("projects"))) {
        for f in read_dir(&proj) {
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if let Some(stem) = name.strip_suffix(ext) {
                if let Some(m) = mtime_ms(&f).map(|m| m as u64).filter(|m| *m >= cutoff) {
                    out.push(Found {
                        id: stem.to_string(),
                        kind: kind_name("main"),
                        parent: stem.to_string(),
                        name: String::new(),
                        path: f.to_string_lossy().to_string(),
                        mtime: m,
                    });
                }
            } else if f.is_dir() {
                for s in read_dir(&f.join(pth("subagents"))) {
                    let n = s.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let Some(stem) = n.strip_suffix(ext) else { continue };
                    let Some(m) = mtime_ms(&s).map(|m| m as u64).filter(|m| *m >= cutoff) else { continue };
                    let path = s.to_string_lossy().to_string();
                    let label = json_of(Path::new(&facts::meta_path(&path)))
                        .and_then(|v| v.get(super::tr("description")).and_then(Value::as_str).map(str::to_string))
                        .unwrap_or_default();
                    out.push(Found {
                        id: stem.strip_prefix(pth("agent_prefix")).unwrap_or(stem).to_string(),
                        kind: kind_name("subagent"),
                        parent: name.clone(),
                        name: label,
                        path,
                        mtime: m,
                    });
                }
            }
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    out.truncate(lim("max_agents") as usize);
    out
}

/// Heartbeat files (`<base>/agents/<id>.json`): the agents only a heartbeat shows.
fn heartbeats(env: &Env, st: &mut State) {
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let done = defaults::raw("agent_tracker.words").get("hb_final").map(V::strings).unwrap_or_default();
    for p in read_dir(&env.base().join(pth("heartbeats"))) {
        if p.extension().is_none_or(|e| e.to_string_lossy() != pth("json_ext").trim_start_matches('.')) {
            continue;
        }
        let Some(v) = json_of(&p) else { continue };
        let ts = v.get(f.str_field("hb_ts")).and_then(Value::as_u64).unwrap_or(0);
        let status = v.get(f.str_field("hb_status")).and_then(Value::as_str).unwrap_or("").to_string();
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let id = format!("{}{}", kind_name("heartbeat"), v.get(f.str_field("hb_id")).and_then(Value::as_str).unwrap_or(&stem));
        if ts == 0 || ts + lim("active_window_ms") < env.now_ms || done.contains(&status.as_str()) {
            st.agents.remove(&id);
            continue;
        }
        let a = st.agents.entry(id.clone()).or_insert_with(|| Agent {
            id,
            kind: kind_name("heartbeat").into(),
            source: defaults::raw("agent_tracker.sources").str_field("heartbeat").into(),
            first_seen: env.now_ms,
            running: true,
            ..Agent::default()
        });
        a.seen = env.now_ms;
        a.hb_ts = ts;
        a.last_output_ms = ts;
        a.hb_status = status;
        a.hb_step = super::cap(v.get(f.str_field("hb_step")).and_then(Value::as_str).unwrap_or(""), lim("text_cap"));
        a.name = stem;
    }
}

/// DevSwarm workspaces: inert unless the DevSwarm descriptor directory exists.
fn devswarm(env: &Env, st: &mut State) {
    let root = env.base().join(pth("devswarm"));
    let descs = read_dir(&root.join(pth("workspaces")));
    if descs.is_empty() {
        return;
    }
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let g = |v: &Value, k: &str| v.get(f.str_field(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let plans: Vec<Value> = read_dir(&root.join(pth("plans"))).iter().filter_map(|p| json_of(p)).collect();
    for p in descs {
        let Some(d) = json_of(&p) else { continue };
        let (id, session, wt) = (g(&d, "id"), g(&d, "session"), g(&d, "worktree"));
        if id.is_empty() || root.join(pth("archived")).join(format!("{id}{}", pth("json_ext"))).exists() {
            continue;
        }
        let key = if st.agents.contains_key(&session) {
            Some(session)
        } else {
            st.agents.iter().find(|(_, a)| a.kind == kind_name("main") && !wt.is_empty() && a.cwd == wt).map(|(k, _)| k.clone())
        };
        let Some(a) = key.and_then(|k| st.agents.get_mut(&k)) else { continue };
        a.kind = kind_name("workspace").into();
        let (mut step, mut done) = (String::new(), 0u64);
        if let Some(plan) = plans.iter().find(|pl| g(pl, "worktree") == wt) {
            let steps = plan.get(f.str_field("steps")).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            let open: Vec<&Value> = steps.iter().filter(|s| g(s, "step_status") != f.str_field("step_done")).collect();
            done = (steps.len() - open.len()) as u64;
            let live = |s: &&&Value| g(s, "step_status") == f.str_field("step_doing") || g(s, "step_status") == f.str_field("step_blocked");
            let cur = open.iter().filter(live).max_by_key(|s| s.get(f.str_field("step_ts")).and_then(Value::as_u64).unwrap_or(0)).or(open.first());
            step = cur.map(|s| g(s, "step_text")).unwrap_or_default();
        }
        let before = a.ws.as_ref().map_or(0, |w| w.done);
        if a.ws.is_some() && done > before {
            a.progress += (done - before) * super::weight("step");
        }
        if !step.is_empty() {
            facts::set_step(a, &step);
        }
        a.ws = Some(Ws { id: id.clone(), armed: Some(watcher_armed(env, &root, &id)), step, done });
    }
}

fn watcher_armed(env: &Env, root: &Path, id: &str) -> bool {
    let lock = root.join(pth("locks")).join(format!("{}{id}{}", pth("lock_prefix"), pth("lock_ext")));
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let Some(v) = json_of(&lock) else { return false };
    let ts = v.get(f.str_field("lock_ts")).and_then(Value::as_u64).unwrap_or(0);
    let alive = v.get(f.str_field("lock_pid")).and_then(Value::as_u64).is_none_or(|p| crate::health::pid_alive(p as u32));
    ts != 0 && env.now_ms.saturating_sub(ts) <= lim("stale_lock_ms") && alive
}

// ---- the Claude Code CLI --------------------------------------------------------------------------------

fn cli_cfg(k: &str) -> &'static V {
    defaults::raw("agent_tracker.claude_cli").get(k).unwrap_or(&V::Int(0))
}

fn cli_run(args: &[&'static str]) -> Option<String> {
    let bin = defaults::env_var("claude_bin").filter(|b| !b.is_empty()).unwrap_or_else(|| cli_cfg("bin").as_str().unwrap_or("").to_string());
    let mut c = Command::new(&bin);
    c.args(args);
    let o = crate::proc::run(c, &bin, std::time::Duration::from_millis(lim("claude_cli_timeout_ms")), defaults::millis("health.probe_poll_ms")).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

fn cli_rows(out: &str) -> Option<Vec<Value>> {
    let v: Value = serde_json::from_str(out).ok()?;
    let rows = v.as_array()?;
    let id = cli_cfg("id").as_str().unwrap_or("");
    rows.iter().all(|r| r.get(id).is_some()).then(|| rows.clone())
}

fn cli(env: &Env, st: &mut State) -> Listing {
    let mut l = Listing { cli_version: st.cli_version.clone(), cli_used: false };
    if !env.use_cli {
        return l;
    }
    if st.cli_ok.is_none() || env.now_ms.saturating_sub(st.cli_checked) > lim("probe_ttl_ms") {
        let ver = cli_run(&cli_cfg("version_args").strings()).and_then(|t| t.split_whitespace().next().map(str::to_string)).unwrap_or_default();
        let changed = ver != st.cli_version || st.cli_ok.is_none();
        if changed {
            st.cli_ok = Some(!ver.is_empty() && cli_run(&cli_cfg("agents_args").strings()).and_then(|o| cli_rows(&o)).is_some());
        }
        st.cli_version = ver;
        st.cli_checked = env.now_ms;
        l.cli_version = st.cli_version.clone();
    }
    if st.cli_ok != Some(true) {
        return l;
    }
    let Some(rows) = cli_run(&cli_cfg("agents_args").strings()).and_then(|o| cli_rows(&o)) else { return l };
    l.cli_used = true;
    let field = |r: &Value, k: &str| r.get(cli_cfg(k).as_str().unwrap_or("")).and_then(Value::as_str).unwrap_or("").to_string();
    let live: std::collections::HashSet<String> = rows.iter().map(|r| field(r, "id")).collect();
    for a in st.agents.values_mut() {
        // an interactive or background session the host no longer lists has no process: it cannot be hung, only gone
        a.gone = (a.kind == kind_name("main") || a.kind == kind_name("workspace")) && !live.contains(&a.id);
    }
    for r in rows {
        let Some(a) = st.agents.get_mut(&field(&r, "id")) else { continue };
        let s = [field(&r, "status"), field(&r, "state")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        a.host = s;
        a.gone = r.get(cli_cfg("pid").as_str().unwrap_or("")).and_then(Value::as_u64).is_some_and(|p| !crate::health::pid_alive(p as u32));
    }
    l
}

/// Discover and ingest every source; drop agents that disappeared.
pub(crate) fn refresh(env: &Env, st: &mut State) -> Listing {
    let now = env.now_ms;
    for f in discover(env) {
        let a = st.agents.entry(f.id.clone()).or_insert_with(|| Agent {
            id: f.id.clone(),
            kind: f.kind.into(),
            parent: f.parent.clone(),
            path: f.path.clone(),
            source: defaults::raw("agent_tracker.sources").str_field("transcript").into(),
            first_seen: now,
            ..Agent::default()
        });
        a.seen = now;
        a.path = f.path;
        a.host.clear();
        a.gone = false;
        if !f.name.is_empty() {
            a.name = f.name;
        }
        facts::ingest(a, now);
        if a.kind != kind_name("subagent") && a.kind != kind_name("workspace") {
            a.kind = kind_name("main").into();
        }
    }
    heartbeats(env, st);
    devswarm(env, st);
    let l = cli(env, st);
    let keep = lim("active_window_ms");
    st.agents.retain(|_, a| now.saturating_sub(a.seen) <= keep);
    l
}

/// The seconds a duration reads as in the status table's age column.
pub(crate) fn unit_ms() -> Vec<u64> {
    defaults::raw("agent_tracker.fmt")
        .get("unit_ms")
        .and_then(V::as_array)
        .map(|a| a.iter().filter_map(V::as_integer).map(|n| n.max(1) as u64).collect())
        .unwrap_or_else(|| vec![fmtn("ms_per_s")])
}
