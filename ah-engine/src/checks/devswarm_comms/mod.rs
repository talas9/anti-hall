//! Built-in `check = "devswarm-comms-guard"`: a port of the Node devswarm-comms-guard (PreToolUse on SendMessage).
//!
//! While DevSwarm is active, a `SendMessage` whose target is a live peer session working inside a DevSwarm workspace is
//! blocked (the mesh is the channel between a Primary and its workspaces); every other target is allowed, and the
//! coordinator address and a live non-workspace peer are labelled. The peer is found by reading the host's per-session
//! index files, exactly as Node does; a target nothing resolves to is allowed without a word (a background agent's own
//! address is the common case).
//!
//! Differences from the Node guard (deliberate): none in what it decides. The cases it cannot decide with the same
//! answer defer to the Node guard: an unreadable home directory, a settings chain that depends on a plugin root the
//! engine does not know, and a session index entry whose directory is relative (Node resolves it against the hook's
//! own working directory, which the engine does not have).
//!
//! Mirrors `hooks/devswarm-comms-guard.js` and `hooks/lib/devswarm-detect.js` `isDevswarmActive`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{enabled, get_setting, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;

#[cfg(test)]
mod tests;

fn agent_id_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("devswarm_comms.agent_id_re"), true))
}

fn ref_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("devswarm_comms.ref_re"), true))
}

/// `stripRef`: `name [3fa9c1]` becomes `name`; a bare name stays, trimmed.
fn strip_ref(to: &str) -> String {
    match ref_re().captures(to) {
        Some(c) => js_trim(c.get(1).map_or("", |m| m.as_str())).to_string(),
        None => js_trim(to).to_string(),
    }
}

/// True when DevSwarm counts as active for this session (`isDevswarmActive`). `Err` when the answer needs a plugin
/// root the caller does not have.
fn devswarm_active(st: &Settings, plugin_root: &str) -> Result<bool, crate::checks::guardkit::settings::Undecidable> {
    if st.env.get(defaults::text("devswarm_comms.disable_env")).map(String::as_str) == Some(defaults::text("devswarm_comms.disable_value")) {
        return Ok(false);
    }
    let mode = get_setting(st, defaults::raw("devswarm_comms.supervisor_setting"), Some(Value::String("auto".into())), plugin_root)?;
    let mode = mode.as_ref().and_then(Value::as_str).map(|m| js_trim(m).to_lowercase()).unwrap_or_default();
    Ok(match mode.as_str() {
        "off" => false,
        "on" => true,
        _ => st.env.get(defaults::text("devswarm_comms.repo_id_env")).is_some_and(|v| !js_trim(v).is_empty()),
    })
}

/// `findSessionByName`: the directory of the first session index file (in name order, as `readdirSync` lists them)
/// whose `name` is exactly `name`. `Ok(None)` when there is none or the index cannot be read; `Err` when a file serde rejects but
/// JavaScript may read comes before a match (Node would read it, so the answer is Node's).
fn find_session(home: &str, name: &str) -> Result<Option<String>, ()> {
    let dir = paths::join(home, defaults::text("devswarm_comms.sessions_dir"));
    let suffix = defaults::text("devswarm_comms.session_file_suffix");
    let mut files: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(None),
    }
    .filter_map(|e| e.ok())
    .filter_map(|e| e.file_name().into_string().ok())
    .collect();
    // libuv sorts a directory listing with strcmp, which is a byte-wise order.
    files.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for f in files.into_iter().filter(|f| f.ends_with(suffix)) {
        let Ok(bytes) = std::fs::read(format!("{dir}/{f}")) else { continue };
        if crate::checks::guardkit::jsdiff::js_reads_differently(&bytes) {
            return Err(());
        }
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else { continue };
        if o.get("name").and_then(Value::as_str) == Some(name) {
            return Ok(Some(o.get("cwd").and_then(Value::as_str).unwrap_or("").to_string()));
        }
    }
    Ok(None)
}

/// What `isDevswarmWorkspacePath` says about a session directory; `Err` for a relative one (see the module docs).
fn is_workspace_path(home: &str, cwd: &str) -> Result<bool, ()> {
    if cwd.is_empty() {
        return Ok(false);
    }
    if !paths::is_absolute(cwd) {
        return Err(());
    }
    let root = paths::join(home, defaults::text("devswarm_comms.repos_root"));
    let resolved = paths::resolve_abs(cwd);
    Ok(resolved == root || resolved.starts_with(&format!("{root}/")))
}

fn block_exact(reason: &str) -> Verdict {
    let quoted = serde_json::to_string(reason).unwrap_or_else(|_| String::from("\"\""));
    // Node writes the decision to stdout only (no stderr text) and exits 2.
    Verdict::Exact(Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{quoted}}}\n"), err: String::new() })
}

fn label(kind: Kind, what: String) -> Verdict {
    let text = msg::message(kind, defaults::text("devswarm_comms.label_name"), &Parts { what: &what, ..Parts::default() });
    Verdict::Advisory(msg::advisory_json("PreToolUse", &text))
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/devswarm-comms-guard.js` `main`.
pub fn decide(p: &Value, st: &Settings, plugin_root: &str) -> Option<Verdict> {
    let setting = defaults::raw("devswarm_comms.setting");
    if st.env.get(defaults::env_name("home")).is_none_or(|h| !paths::is_absolute(h)) {
        return Some(Verdict::Defer);
    }
    match enabled(st, setting, plugin_root) {
        Ok(true) => {}
        Ok(false) => return None,
        Err(_) => return Some(Verdict::Defer),
    }
    if is_skipped(st, defaults::text("devswarm_comms.guard_name")) {
        return None;
    }
    let obj = p.as_object()?;
    let tool = obj.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !tool.is_empty() && tool != defaults::text("devswarm_comms.tool") {
        return None;
    }
    match devswarm_active(st, plugin_root) {
        Ok(true) => {}
        Ok(false) => return None,
        Err(_) => return Some(Verdict::Defer),
    }
    let to = obj.get("tool_input").and_then(Value::as_object).and_then(|i| i.get("to")).and_then(Value::as_str).map(js_trim).unwrap_or("");
    if to.is_empty() {
        return None;
    }
    if to.to_lowercase() == defaults::text("devswarm_comms.coordinator_target") {
        return Some(label(Kind::Tip, defaults::text("devswarm_comms.msg_main_what").to_string()));
    }
    let name = strip_ref(to);
    let Ok(session) = find_session(&st.home, &name) else { return Some(Verdict::Defer) };
    if let Some(cwd) = &session {
        match is_workspace_path(&st.home, cwd) {
            Ok(true) => {
                let what = msg::render("devswarm_comms.msg_block_what", &[("to", to), ("cwd", cwd)]);
                let text = msg::message(
                    Kind::Block,
                    defaults::text("devswarm_comms.guard_name"),
                    &Parts {
                        what: &what,
                        why: defaults::text("devswarm_comms.msg_block_why"),
                        instead: defaults::text("devswarm_comms.msg_block_instead"),
                        ..Parts::default()
                    },
                );
                return Some(block_exact(&text));
            }
            Ok(false) => {}
            Err(()) => return Some(Verdict::Defer),
        }
    }
    if agent_id_re().is_match(to) {
        return None;
    }
    let cwd = session?;
    Some(label(Kind::Ok, msg::render("devswarm_comms.msg_ok_what", &[("to", to), ("cwd", &cwd)])))
}

/// The registered `devswarm-comms-guard` check.
pub struct DevswarmCommsGuard;

impl Check for DevswarmCommsGuard {
    fn name(&self) -> &'static str {
        "devswarm-comms-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_comms.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        let root = crate::checks::guardkit::settings::plugin_root(opts, env);
        decide(payload, &Settings::from_env(env), &root).or(Some(Verdict::Allow))
    }
}
