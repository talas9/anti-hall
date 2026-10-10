//! Tests of this module.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test module: a panic is the failure report

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
