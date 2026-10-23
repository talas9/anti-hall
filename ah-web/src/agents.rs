//! The live agent list: the engine's own `agents status --json`, run while at least one tab is connected and reduced to
//! what the page shows. Nothing here changes engine state (the command is read-only).
use crate::app::App;
use ah_web_proto::{Agent, Snapshot};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

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

/// Turn the engine's JSON into a snapshot (finished agents are left out).
pub fn reduce(doc: &Value, step_max: usize) -> Snapshot {
    let agents = doc
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
        .unwrap_or_default();
    Snapshot { generated_ms: doc.get("generated_ms").and_then(Value::as_u64).unwrap_or(0), engine_ok: true, agents }
}

async fn read_engine(app: &App) -> Result<Snapshot, String> {
    let s = app.settings();
    let mut child = Command::new(&app.engine)
        .args(&s.agents_cmd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut buf = Vec::new();
    let read = async {
        // one byte past the cap is enough to know the reply is too large
        (&mut out).take(s.agents_max_bytes as u64 + 1).read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        child.wait().await.map_err(|e| e.to_string())
    };
    let status = tokio::time::timeout(Duration::from_millis(s.agents_timeout_ms), read).await.map_err(|_| "timeout".to_string())??;
    if !status.success() || buf.len() > s.agents_max_bytes {
        return Err(format!("engine exit {status}, {} bytes", buf.len()));
    }
    let doc: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    Ok(reduce(&doc, s.step_max_chars))
}

/// Refresh while someone is listening; stops (and may be started again) when the last stream closes.
pub async fn poll(app: Arc<App>) {
    loop {
        if app.streams.load(Ordering::Relaxed) == 0 {
            app.polling.store(false, Ordering::SeqCst);
            // a stream that connected between the check and the store must not be left without a poller
            if app.streams.load(Ordering::SeqCst) == 0 || app.polling.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let snap = match read_engine(&app).await {
            Ok(s) => s,
            Err(_) => {
                let mut last = app.last_good.lock().map(|g| g.clone()).unwrap_or_default();
                last.engine_ok = false;
                last
            }
        };
        if snap.engine_ok
            && let Ok(mut g) = app.last_good.lock()
        {
            *g = snap.clone();
        }
        if let Ok(json) = serde_json::to_string(&snap) {
            app.tx.send_if_modified(|cur| if *cur == json { false } else { *cur = json; true });
        }
        tokio::time::sleep(Duration::from_millis(app.settings().agents_poll_ms)).await;
    }
}
