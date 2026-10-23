//! The live data: the engine's control socket asked for its vital signs (`pulse`), the agent list (`agents since=<rev>`), the check
//! decisions and the mesh traffic, while at least one tab is connected. Every call is a read; the replies are reduced to what the
//! page shows and folded into the model as changes.
use crate::app::App;
use crate::cfg::Settings;
use crate::ctl;
use crate::model::Found;
use ah_web_proto::{Agent, Decision, Pulse};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn label(v: &Value, id: &str) -> String {
    let name = text(v, "name");
    if !name.is_empty() {
        return name;
    }
    let project = text(v, "project");
    if let Some(base) = project.rsplit('/').find(|s| !s.is_empty()) {
        return base.to_string();
    }
    id.chars().take(8).collect()
}

/// A step that is only a task number (older engines recorded the id of a TaskUpdate that carried no subject) says nothing: left empty.
fn human_step(step: &str) -> String {
    if step.chars().all(|c| c.is_ascii_digit()) { String::new() } else { step.to_string() }
}

/// The agents of the engine's status document (finished agents are left out).
pub fn reduce(doc: &Value, step_max: usize) -> Vec<Agent> {
    doc
        .get("agents")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|a| a.get("state").and_then(Value::as_str) != Some("done"))
                .map(|a| {
                    let id = text(a, "agent");
                    Agent {
                        label: label(a, &id),
                        kind: text(a, "kind"),
                        role: text(a, "role"),
                        state: text(a, "state"),
                        parent: text(a, "parent"),
                        project: text(a, "project"),
                        last_output_s: a.get("last_output_s").and_then(Value::as_u64),
                        step: human_step(&text(a, "step")).chars().take(step_max).collect(),
                        tokens_out: a.get("tokens_out").and_then(Value::as_u64).unwrap_or(0),
                        tool_calls: a.get("tool_calls").and_then(Value::as_u64).unwrap_or(0),
                        id,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn pulse(v: &Value) -> Pulse {
    Pulse { cpu_permille: v.get("cpu_permille").and_then(Value::as_u64), rss_kb: num(v, "rss_kb"), requests: num(v, "requests"), errors: num(v, "errors"), uptime_s: num(v, "uptime_s"), version: text(v, "version"), build_sha: text(v, "build_sha"), plugin_version: text(v, "plugin_version") }
}

fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    pairs.iter().fold(template.to_string(), |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
}

/// A decision row as a plain sentence; `None` for the decisions the feed does not show (`web.feed_decisions_shown`).
fn decision_line(s: &Settings, row: &Value) -> Option<(u64, String, String)> {
    let decision = text(row, "decision");
    if !s.feed_decisions_shown.contains(&decision) {
        return None;
    }
    let event = text(row, "event");
    let event = s.feed_events.get(&event).cloned().unwrap_or(event);
    let template = s.feed_text.get(&decision)?;
    Some((num(row, "ts_ms"), decision.clone(), fill(template, &[("check", &text(row, "check")), ("event", &event), ("rule", &text(row, "rule"))])))
}

/// A decision row, ready for the Live screen: with the effect colour its decision plays in.
fn decision_of(s: &Settings, row: &Value) -> Decision {
    let decision = text(row, "decision");
    let injected_bytes = num(row, "injected_bytes");
    let fx = if decision == s.live_inject_decision && injected_bytes > 0 { s.live_inject_fx.clone() } else { s.live_decision_fx.get(&decision).cloned().unwrap_or_default() };
    Decision { seq: num(row, "seq"), ts_ms: num(row, "ts_ms"), event: text(row, "event"), check: text(row, "check"), session: text(row, "session"), decision, rule: text(row, "rule"), us: num(row, "us"), injected_bytes, fx }
}

/// A mesh message row as a plain sentence. The store keeps times in seconds or milliseconds; both are taken.
fn mesh_line(s: &Settings, row: &Value) -> Option<(u64, String, String)> {
    let who = |k: &str, none: &str| row.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map_or_else(|| s.feed_text.get(none).cloned().unwrap_or_default(), str::to_string);
    let ts = num(row, "ts");
    let ts_ms = if ts < 100_000_000_000 { ts * 1000 } else { ts };
    let template = s.feed_text.get("mesh")?;
    Some((ts_ms, "mesh".into(), fill(template, &[("sender", &who("sender", "unknown")), ("recipient", &who("recipient", "everyone")), ("type", &who("type", "unknown"))])))
}

fn mesh_db(s: &Settings) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let p = std::path::Path::new(&home).join(&s.mesh_db_rel);
    p.is_file().then(|| p.display().to_string())
}

/// Which sources are due this round (each has its own interval, so a quiet one costs the engine nothing).
#[derive(Clone, Copy, Default)]
struct Due {
    pulse: bool,
    agents: bool,
    decisions: bool,
    mesh: bool,
}

impl Due {
    fn any(self) -> bool {
        self.pulse || self.agents || self.decisions || self.mesh
    }
}

/// One round of reads, only of the sources that are due. Nothing is written to the engine. `engine_ok` is set only when a call was
/// made: a round with nothing due says nothing about the engine.
async fn read_round(app: &App, s: &Settings, due: Due) -> Found {
    let timeout = Duration::from_millis(s.ctl_timeout_ms);
    let call = |req: String| {
        let sock = app.socket.clone();
        let max = s.ctl_max_bytes;
        async move { ctl::call(&sock, &req, timeout, max).await }
    };
    let mut f = Found::default();
    let (rev, dseq, mesh_after, mesh_reads) = {
        let m = app.model();
        (m.rev.clone(), m.decisions_seq, m.mesh_after, m.mesh_reads_after)
    };
    // the vital signs: the engine's CPU figure is the time since the previous pulse, so they are read at their own pace
    if due.pulse {
        let Ok(p) = call("pulse".into()).await else {
            f.engine_ok = Some(false);
            return f;
        };
        f.pulse = Some(pulse(&p));
        f.engine_ok = Some(true);
    }
    if due.agents {
        match call(if rev.is_empty() { "agents".into() } else { format!("agents since={rev}") }).await {
            Ok(doc) => {
                f.engine_ok = Some(true);
                if doc.get("unchanged").is_none() && doc.get("error").is_none() {
                    f.generated_ms = doc.get("generated_ms").and_then(Value::as_u64);
                    f.rev = doc.get("rev").and_then(Value::as_str).map(str::to_string);
                    f.agents = Some(reduce(&doc, s.step_max_chars));
                }
            }
            Err(_) => {
                f.engine_ok = Some(false);
                return f;
            }
        }
    }
    if due.decisions {
        match call(format!("decisions since={dseq}")).await {
            Ok(doc) => {
                f.engine_ok = Some(true);
                let rows = doc.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
                f.feed.extend(rows.iter().filter_map(|r| decision_line(s, r)));
                f.decisions = rows.iter().map(|r| decision_of(s, r)).collect();
                let last = rows.iter().map(|r| num(r, "seq")).max().unwrap_or(dseq);
                // a ring that is behind the cursor belongs to a restarted engine: read it from its start next time
                let mut m = app.model();
                m.decisions_seq = if num(&doc, "last_seq") < dseq { 0 } else { last.max(dseq) };
                f.actions = crate::live::new_actions(s, &app.socket, &mut m.actions_off);
                f.jev = crate::live::new_jev(s, &mut m.jev_off);
            }
            Err(_) => {
                f.engine_ok = Some(false);
                return f;
            }
        }
    }
    if due.mesh && let Some(db) = mesh_db(s) {
        // the first read takes only the newest rows; later reads continue after the last id seen
        let req = if mesh_after < 0 { format!("mesh-events db={db} latest={}", s.feed_max) } else { format!("mesh-events db={db} after={mesh_after} reads_after={mesh_reads} limit={}", s.mesh_limit) };
        if let Ok(doc) = call(req).await
            && doc.get("error").is_none()
        {
            let rows = doc.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            f.feed.extend(rows.iter().filter_map(|r| mesh_line(s, r)));
            let last = rows.iter().filter_map(|r| r.get("id").and_then(Value::as_i64)).max().unwrap_or(mesh_after.max(0));
            app.model().mesh_after = last.max(mesh_after.max(0));
        }
    }
    f
}

/// The pause between two rounds: the faster tier that has a viewer sets it, never faster than `web.push_min_ms`.
fn period(app: &App, s: &Settings) -> Duration {
    let ms = if app.full_streams.load(Ordering::SeqCst) > 0 { s.full_push_ms } else { s.lite_push_ms };
    Duration::from_millis(ms.max(s.push_min_ms))
}

/// A source is due when it has not been read yet or its interval has passed; due sources are stamped as read.
fn due(last: &mut Option<Instant>, every_ms: u64) -> bool {
    let is_due = last.is_none_or(|t| t.elapsed() >= Duration::from_millis(every_ms));
    if is_due {
        *last = Some(Instant::now());
    }
    is_due
}

/// Read while someone is listening; stops (and may be started again) when the last stream closes.
pub async fn poll(app: Arc<App>) {
    let (mut last_mesh, mut last_pulse, mut last_agents, mut last_decisions): (Option<Instant>, Option<Instant>, Option<Instant>, Option<Instant>) = (None, None, None, None);
    let mut engine_was_ok = true;
    loop {
        if app.streams() == 0 {
            app.polling.store(false, Ordering::SeqCst);
            // a stream that connected between the check and the store must not be left without a poller
            if app.streams() == 0 || app.polling.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let s = app.settings();
        let d = Due {
            pulse: due(&mut last_pulse, s.pulse_min_interval_ms),
            agents: due(&mut last_agents, s.agents_poll_ms),
            decisions: due(&mut last_decisions, s.decisions_poll_ms),
            mesh: due(&mut last_mesh, s.mesh_poll_ms),
        };
        if d.any() {
            let mut found = read_round(&app, &s, d).await;
            // a change of the engine's reachability is a line in the feed
            if let Some(ok) = found.engine_ok.filter(|ok| *ok != engine_was_ok) {
                engine_was_ok = ok;
                if let Some(t) = s.feed_text.get(if ok { "engine_up" } else { "engine_down" }) {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
                    found.feed.push((now, if ok { "mesh" } else { "error" }.into(), t.clone()));
                }
            }
            app.model().commit(found);
        }
        tokio::time::sleep(period(&app, &s)).await;
    }
}
