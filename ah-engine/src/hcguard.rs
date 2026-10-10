//! The test guard for hivecontrol: a test build (or a run that asks for it) never reaches the REAL DevSwarm CLI.
//!
//! Every place the engine starts `hivecontrol` asks [`permit`] first. When the guard is active the call goes ahead only if the
//! executable it would run is a stub the test harness put there: it resolves (symlinks followed) to a file inside a directory
//! the harness named in the stub variable, or inside one of the scratch roots in `devswarm_act.hc_guard_roots`. Anything else,
//! such as the app's installed CLI found on the developer's PATH, is refused and the caller treats it as a missing binary.
//! Whether the guard is active is `devswarm_act.hc_guard`: `auto` (active in a debug build, which is what `cargo test`
//! builds and the shipped release is not), `on` or `off`. Names, roots and texts: `devswarm_act.toml`.
use crate::defaults;
use std::path::{Path, PathBuf};

fn active() -> bool {
    match defaults::text("devswarm_act.hc_guard") {
        v if v == defaults::text("devswarm_act.hc_guard_on") => true,
        v if v == defaults::text("devswarm_act.hc_guard_off") => false,
        _ => cfg!(debug_assertions),
    }
}

/// The executable `bin` would run: itself when it names a path, else the first file of that name on `path_env`.
fn resolve(bin: &str, path_env: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        return Some(PathBuf::from(bin));
    }
    path_env.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(bin)).find(|p| p.is_file())
}

fn roots(stub_env: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in stub_env.unwrap_or("").split(':').filter(|d| !d.is_empty()) {
        out.push(PathBuf::from(dir));
    }
    for r in defaults::list("devswarm_act.hc_guard_roots") {
        if r == defaults::text("devswarm_act.hc_guard_root_temp") {
            out.push(std::env::temp_dir());
        } else if let Some(rest) = r.strip_prefix(defaults::text("devswarm_act.hc_guard_root_home")) {
            if let Some(h) = std::env::var_os(defaults::text("env.home")) {
                out.push(Path::new(&h).join(rest.trim_start_matches('/')));
            }
        } else {
            out.push(PathBuf::from(r));
        }
    }
    // a root is compared in its real spelling (/tmp is /private/tmp on macOS)
    out.into_iter().map(|p| std::fs::canonicalize(&p).unwrap_or(p)).collect()
}

/// Whether the engine may start `bin` (a name looked up on `path_env`, or a path) as hivecontrol. Always true while the guard is
/// off; `Err` carries the line to log when it refuses.
pub fn permit(bin: &str, path_env: Option<&str>) -> Result<(), String> {
    // the shared runner also starts node, git and others: only a program named like the DevSwarm CLI is guarded
    let name = Path::new(bin).file_name().and_then(|n| n.to_str()).unwrap_or(bin);
    if !active() || name != defaults::text("devswarm_act.hc_bin") {
        return Ok(());
    }
    let stub_env = std::env::var(defaults::text("devswarm_act.hc_guard_stub_env")).ok();
    decide(bin, path_env, &roots(stub_env.as_deref()))
}

fn decide(bin: &str, path_env: Option<&str>, allowed: &[PathBuf]) -> Result<(), String> {
    let process_path = std::env::var(defaults::text("devswarm_act.hc_guard_path_env")).unwrap_or_default();
    let target = resolve(bin, path_env.unwrap_or(&process_path));
    let real = target.as_ref().map(|t| std::fs::canonicalize(t).unwrap_or_else(|_| t.clone()));
    match real {
        Some(r) if allowed.iter().any(|root| r.starts_with(root)) => Ok(()),
        other => Err(defaults::render(
            "devswarm_act.hc_guard_refused",
            &[
                ("bin", &bin),
                ("resolved", &other.map_or(String::new(), |p| p.display().to_string())),
                ("var", &defaults::text("devswarm_act.hc_guard_stub_env")),
            ],
        )),
    }
}

#[cfg(all(test, debug_assertions, unix))]
mod tests;
