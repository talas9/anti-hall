//! Built-in checks `devswarm-child-role` (SessionStart) and `devswarm-parent-gate` (Stop): the parts of the two Node
//! hooks that can be decided exactly without the DevSwarm mailbox store or the DevSwarm CLI (D45 is not done).
//!
//! `devswarm-parent-gate` is a Stop guard, so it is never weaker than Node (D74). The engine answers only the silent
//! exits that happen in the Node hook BEFORE it reads any mailbox, in the same order: the judge-child exit, the
//! `devswarm.parentGate` switch, the user skip, a supervisor that is not active, and a child workspace (a child is gated
//! by its own hook). Everything else, which is every session that might be blocked, defers to the Node gate, which
//! reads the store, the descriptors and the liveness files, may spawn git, and keeps the forced-acknowledgement
//! counters. The engine never blocks.
//!
//! `devswarm-child-role` injects a fixed directive. A child workspace's directive is reproduced byte for byte when the
//! stable launchers the Node hook would install already exist with exactly the content it would write (checked by
//! reading them; the engine never writes them, so the Node hook's file effects are unchanged: Node installs them when it
//! is loaded, before it looks at anything else, so the engine answers only when that install would be a no-op). A Primary needs the
//! Primary-seat adoption of `scripts/devswarm.js` (it reads and writes the mailbox store), so a Primary defers; so does
//! a child whose launchers are missing or differ (Node installs them), and anything the check cannot prove identical
//! (unusual home path, non-ASCII agent name, an unresolvable plugin root).
//!
//! The engine's request environment is the host's (D76), limited to the allowlist, which carries the DevSwarm
//! variables these hooks read.
//!
//! Mirrors `hooks/devswarm-child-role.js`, `hooks/devswarm-parent-gate.js` (early exits), `hooks/lib/devswarm-primary-gate.js`,
//! `hooks/lib/devswarm-detect.js` `isDevswarmActive`, `hooks/lib/devswarm-role.js` `isChildWorkspace` and `hooks/skip-guard.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::{Settings, posix_normalize};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

pub mod settings;
pub mod text;

#[cfg(test)]
mod tests;

/// The home directory of the settings reads and the file paths, when it is one this check can use exactly as Node
/// does: `HOME` set, absolute, already normalized (Node joins paths lexically), and not the real home under a test
/// marker (where the Node settings reader refuses).
pub(crate) fn usable_settings(env: &RequestEnv) -> Option<Settings> {
    let home = env.get(defaults::env_name("home"))?;
    if !home.starts_with('/') || posix_normalize(home) != home {
        return None;
    }
    let marked = defaults::list("devswarm_role.test_markers").iter().any(|m| env.get(m).is_some_and(|v| !v.is_empty()));
    let escape = env.get(defaults::text("devswarm_role.real_home_escape")).is_some_and(|v| !v.is_empty());
    if marked && !escape && passwd_home().is_none_or(|real| posix_normalize(&real).trim_end_matches('/') == posix_normalize(home).trim_end_matches('/')) {
        return None;
    }
    Some(Settings::from_env(env))
}

/// The home directory the password database names for this user (`os.userInfo().homedir`).
fn passwd_home() -> Option<String> {
    // SAFETY: `getpwuid` returns null or a pointer to a static record; the directory is copied out before any other call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*pw).pw_dir).to_str().ok().map(str::to_string)
    }
}

/// True when the claude -p judge child is running: every anti-hall hook is a silent no-op there.
pub(crate) fn judge_child(env: &RequestEnv) -> bool {
    env.get(defaults::text("devswarm_role.judge_env")) == Some("1")
}

/// `isDevswarmActive(env)`: the kill switch, then the supervisor mode (`on`, `off` or detect from the environment).
fn supervisor_active(st: &Settings, env: &RequestEnv) -> bool {
    if env.get(defaults::text("devswarm_role.kill_env")) == Some("1") {
        return false;
    }
    match settings::get_enum(st, defaults::raw("devswarm_role.sw_supervisor_mode")).as_str() {
        "off" => false,
        "on" => true,
        _ => env.get(defaults::text("devswarm_role.repo_env")).is_some_and(|v| !js_trim(v).is_empty()),
    }
}

/// `isChildWorkspace(env)`: the source-branch variable is set and not blank.
fn is_child(env: &RequestEnv) -> bool {
    env.get(defaults::text("devswarm_role.branch_env")).is_some_and(|v| !js_trim(v).is_empty())
}

/// The Stop gate's decision (see the module docs): `Allow` for a silent Node exit, `Defer` for everything else.
///
/// Mirrors `hooks/lib/devswarm-primary-gate.js` `inert` (the same checks in the same order) and `main` of
/// `hooks/devswarm-parent-gate.js`.
pub fn parent_gate(env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(st) = usable_settings(env) else { return Verdict::Defer };
    if !get_bool(&st, defaults::raw("devswarm_role.sw_parent_gate")) {
        return Verdict::Allow;
    }
    if is_skipped(&st, defaults::text("devswarm_role.gate_guard")) {
        return Verdict::Allow;
    }
    if !supervisor_active(&st, env) || is_child(env) {
        return Verdict::Allow;
    }
    Verdict::Defer
}

/// The real path of the plugin root's parent of `hooks`, which is where a Node hook's `path.join(__dirname, '..')` points.
pub(crate) fn node_root(plugin_root: &str) -> Option<String> {
    let hooks = std::fs::canonicalize(std::path::Path::new(plugin_root).join(defaults::text("devswarm_role.hooks_dir"))).ok()?;
    Some(hooks.parent()?.to_str()?.to_string())
}

/// The path of a launcher the Node hook would install, when it is already there with exactly the content Node would
/// write (so Node would neither write nor change it); `None` when Node would have to install it.
pub(crate) fn current_launcher(home: &str, root: &str, key: &str) -> Option<String> {
    let l = defaults::raw(key);
    let (name, target) = (l.str_field("name"), l.str_field("target"));
    let dest = posix_normalize(&format!("{home}/{}/{name}", defaults::text("devswarm_role.bin_dir")));
    let want = text::launcher_source(target, &posix_normalize(&format!("{root}/{target}")));
    (std::fs::read_to_string(&dest).ok()? == want).then_some(dest)
}

/// What a valid workspace id looks like: ASCII letters, digits and the extra characters, at least one.
fn id_of(env: &RequestEnv) -> String {
    let extra = defaults::text("devswarm_role.id_extra_chars");
    match env.get(defaults::text("devswarm_role.builder_env")) {
        Some(v) if !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c)) => v.to_string(),
        _ => defaults::text("devswarm_role.id_placeholder").to_string(),
    }
}

/// The child-role hook's decision (see the module docs).
///
/// The Node hook installs the stable launchers when it is loaded, before it looks at its switch, the supervisor or the
/// role, so the engine may answer (silent or not) only when that install would change nothing: the switch is off, or both
/// launchers already hold exactly what Node would write. Otherwise Node runs, installs them, and the next session is
/// answered here.
///
/// Mirrors `main` of `hooks/devswarm-child-role.js` and the module-level launcher install above it.
pub fn child_role(env: &RequestEnv, plugin_root: Option<&str>) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(st) = usable_settings(env) else { return Verdict::Defer };
    let Some(root) = plugin_root.filter(|r| !r.is_empty()).and_then(node_root) else { return Verdict::Defer };
    let (cli, watcher) = if get_bool(&st, defaults::raw("devswarm_role.sw_stable_launcher")) {
        let (Some(c), Some(w)) =
            (current_launcher(&st.home, &root, "devswarm_role.launcher_cli"), current_launcher(&st.home, &root, "devswarm_role.launcher_watcher"))
        else {
            return Verdict::Defer;
        };
        (c, w)
    } else {
        let raw = |key: &str| posix_normalize(&format!("{root}/{}", defaults::raw(key).str_field("target")));
        (raw("devswarm_role.launcher_cli"), raw("devswarm_role.launcher_watcher"))
    };
    if !get_bool(&st, defaults::raw("devswarm_role.sw_child_role")) || !supervisor_active(&st, env) {
        return Verdict::Allow;
    }
    if !is_child(env) {
        return Verdict::Defer; // a Primary adopts or registers its seat through the DevSwarm CLI
    }
    let agent_raw = env.get(defaults::text("devswarm_role.agent_env")).unwrap_or("");
    if !agent_raw.is_ascii() {
        return Verdict::Defer; // JavaScript and Rust lower-case some non-ASCII letters differently
    }
    let agent = js_trim(agent_raw).to_ascii_lowercase();
    let ctx = text::child_context(&text::Child {
        cli: &cli,
        watcher: &watcher,
        agent: &agent,
        id: &id_of(env),
        cron: &settings::wake_cron(&st),
        tick_only: get_bool(&st, defaults::raw("devswarm_role.sw_rearm")),
    });
    let quoted = serde_json::to_string(&ctx).unwrap_or_default();
    let out = format!("{}{quoted}{}\n", defaults::text("devswarm_role.out_prefix"), defaults::text("devswarm_role.out_suffix"));
    Verdict::Exact(Exact { code: 0, out, err: String::new() })
}

/// The registered `devswarm-child-role` check.
pub struct DevswarmChildRole;

impl Check for DevswarmChildRole {
    fn name(&self) -> &'static str {
        "devswarm-child-role"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_role.child_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event != "SessionStart" {
            return Some(Verdict::Defer);
        }
        let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root")));
        Some(child_role(env, root))
    }
}

/// The registered `devswarm-parent-gate` check.
pub struct DevswarmParentGate;

impl Check for DevswarmParentGate {
    fn name(&self) -> &'static str {
        "devswarm-parent-gate"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_role.gate_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event != "Stop" {
            return Some(Verdict::Defer);
        }
        let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root")));
        Some(match parent_gate(env) {
            Verdict::Defer => crate::checks::devswarm_gates::readside::parent_gate(payload, env, root),
            v => v,
        })
    }
}
