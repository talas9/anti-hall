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
            &[("bin", &bin), ("resolved", &other.map_or(String::new(), |p| p.display().to_string())), ("var", &defaults::text("devswarm_act.hc_guard_stub_env"))],
        )),
    }
}

#[cfg(all(test, debug_assertions, unix))]
#[allow(clippy::unwrap_used, clippy::expect_used)] // a test module: a panic is the failure report
mod tests {
    use super::{decide, permit};
    use crate::dsact::runner::{RunSpec, Runner, System};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    /// A scratch directory holding an executable `hivecontrol` that prints a word.
    fn bin_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hcguard-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("hivecontrol");
        std::fs::write(&f, "#!/bin/sh\necho stub\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        d
    }

    #[test]
    fn only_a_hivecontrol_inside_an_allowed_root_may_run() {
        let (stub, real) = (bin_dir("stub"), bin_dir("real"));
        let allowed = [std::fs::canonicalize(&stub).unwrap()];
        let on_path = |d: &Path| format!("{}:/usr/bin", d.display());
        // looked up on a PATH: the stub passes, the "installed" one is refused with the line to log
        assert!(decide("hivecontrol", Some(&on_path(&stub)), &allowed).is_ok());
        let e = decide("hivecontrol", Some(&on_path(&real)), &allowed).unwrap_err();
        assert!(e.contains("not a test stub") && e.contains("hivecontrol"), "{e}");
        // given as a path
        assert!(decide(stub.join("hivecontrol").to_str().unwrap(), None, &allowed).is_ok());
        assert!(decide(real.join("hivecontrol").to_str().unwrap(), None, &allowed).is_err());
        // a name found nowhere has nothing to vouch for
        assert!(decide("hivecontrol", Some("/usr/bin"), &allowed).is_err());
        // a link inside the allowed root that leads out of it is judged by where it leads
        let link = stub.join("linked-hivecontrol");
        let _gone = std::fs::remove_file(&link); // keep: a link left by an earlier run
        symlink(real.join("hivecontrol"), &link).unwrap();
        assert!(decide(link.to_str().unwrap(), None, &allowed).is_err(), "a link into the real CLI is refused");
        std::fs::remove_dir_all(&stub).unwrap();
        std::fs::remove_dir_all(&real).unwrap();
    }

    #[test]
    fn programs_that_are_not_hivecontrol_are_not_guarded() {
        assert!(permit("/usr/bin/true", None).is_ok());
        assert!(permit("node", None).is_ok());
    }

    #[test]
    fn the_runner_treats_a_refused_call_as_a_missing_binary_and_still_runs_a_scratch_stub() {
        let spec = RunSpec { args: vec!["--version".into()], timeout_ms: 5000, ..RunSpec::default() };
        // outside every scratch root, wherever the file is (or is not): refused before any process starts
        let refused = System { hc: "/nonexistent-installed-dir/hivecontrol".to_string() }.run(&spec);
        assert!(refused.missing && refused.error.as_deref().is_some_and(|e| e.contains("hivecontrol refused")), "{refused:?}");
        let d = bin_dir("run");
        let ran = System { hc: d.join("hivecontrol").display().to_string() }.run(&spec);
        assert!(ran.ok && ran.stdout.contains("stub"), "{ran:?}");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
