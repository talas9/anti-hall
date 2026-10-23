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
                        step: text(a, "step").chars().take(step_max).collect(),
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
    Pulse { cpu_permille: v.get("cpu_permille").and_then(Value::as_u64), rss_kb: num(v, "rss_kb"), requests: num(v, "requests"), errors: num(v, "errors"), uptime_s: num(v, "uptime_s") }
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
    Decision { seq: num(row, "seq"), ts_ms: num(row, "ts_ms"), event: text(row, "event"), check: text(row, "check"), decision, rule: text(row, "rule"), us: num(row, "us"), injected_bytes, fx }
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

/// One round of reads. Nothing is written to the engine.
async fn read_round(app: &App, s: &Settings, mesh_due: bool, pulse_due: bool) -> Found {
    let timeout = Duration::from_millis(s.ctl_timeout_ms);
    let call = |req: String| {
        let sock = app.socket.clone();
        let max = s.ctl_max_bytes;
        async move { ctl::call(&sock, &req, timeout, max).await }
    };
    let mut f = Found::default();
    // the vital signs are read once per `web.pulse_min_interval_ms` (the engine's CPU figure is the time since the previous pulse);
    // in between, the decisions call below tells whether the engine still answers
    if pulse_due {
        let Ok(p) = call("pulse".into()).await else {
            f.engine_ok = Some(false);
            return f;
        };
        f.pulse = Some(pulse(&p));
    }
    f.engine_ok = Some(true);
    let (rev, dseq, mesh_after, mesh_reads) = {
        let m = app.model();
        (m.rev.clone(), m.decisions_seq, m.mesh_after, m.mesh_reads_after)
    };
    if let Ok(doc) = call(if rev.is_empty() { "agents".into() } else { format!("agents since={rev}") }).await
        && doc.get("unchanged").is_none()
        && doc.get("error").is_none()
    {
        f.generated_ms = doc.get("generated_ms").and_then(Value::as_u64);
        f.rev = doc.get("rev").and_then(Value::as_str).map(str::to_string);
        f.agents = Some(reduce(&doc, s.step_max_chars));
    }
    let decisions = call(format!("decisions since={dseq}")).await;
    if decisions.is_err() && !pulse_due {
        f.engine_ok = Some(false);
        return f;
    }
    if let Ok(doc) = decisions {
        let rows = doc.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        f.feed.extend(rows.iter().filter_map(|r| decision_line(s, r)));
        f.decisions = rows.iter().map(|r| decision_of(s, r)).collect();
        let last = rows.iter().map(|r| num(r, "seq")).max().unwrap_or(dseq);
        app.model().decisions_seq = last.max(dseq);
    }
    {
        let mut m = app.model();
        f.actions = crate::live::new_actions(s, &app.socket, &mut m.actions_off);
    }
    if mesh_due && let Some(db) = mesh_db(s) {
        // the first read takes only the newest rows; later reads continue after the last id seen
        let req = if mesh_after < 0 { format!("mesh-events db={db} latest={}", s.feed_max) } else { format!("mesh-events db={db} after={mesh_after} reads_after={mesh_reads} limit={}", s.mesh_limit) };
        if let Ok(doc) = call(req).await
            && doc.get("error").is_none()
        {
            let rows = doc.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            f.feed.extend(rows.iter().filter_map(|r| mesh_line(s, r)));
            let last = rows.iter().filter_map(|r| r.get("id").and_then(Value::as_i64)).max().unwrap_or(mesh_after.max(0));
            let mut m = app.model();
            m.mesh_after = last.max(mesh_after.max(0));
        }
    }
    f
}

/// The pause between two rounds: the faster tier that has a viewer sets it, never faster than `web.push_hz_max`.
fn period(app: &App, s: &Settings) -> Duration {
    let hz = if app.full_streams.load(Ordering::SeqCst) > 0 { s.full_push_hz } else { s.lite_push_hz };
    Duration::from_secs_f64(1.0 / hz.min(s.push_hz_max).max(0.01))
}

/// Read while someone is listening; stops (and may be started again) when the last stream closes.
pub async fn poll(app: Arc<App>) {
    let mut last_mesh: Option<Instant> = None;
    let mut engine_was_ok = true;
    let mut last_pulse: Option<Instant> = None;
    loop {
        if app.streams() == 0 {
            app.polling.store(false, Ordering::SeqCst);
            // a stream that connected between the check and the store must not be left without a poller
            if app.streams() == 0 || app.polling.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let s = app.settings();
        let mesh_due = last_mesh.is_none_or(|t| t.elapsed() >= Duration::from_millis(s.mesh_poll_ms));
        if mesh_due {
            last_mesh = Some(Instant::now());
        }
        let pulse_due = last_pulse.is_none_or(|t| t.elapsed() >= Duration::from_millis(s.pulse_min_interval_ms));
        if pulse_due {
            last_pulse = Some(Instant::now());
        }
        let mut found = read_round(&app, &s, mesh_due, pulse_due).await;
        // a change of the engine's reachability is a line in the feed
        if let Some(ok) = found.engine_ok.filter(|ok| *ok != engine_was_ok) {
            engine_was_ok = ok;
            if let Some(t) = s.feed_text.get(if ok { "engine_up" } else { "engine_down" }) {
                found.feed.push((std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64), if ok { "mesh" } else { "error" }.into(), t.clone()));
            }
        }
        app.model().commit(found);
        tokio::time::sleep(period(&app, &s)).await;
    }
}

