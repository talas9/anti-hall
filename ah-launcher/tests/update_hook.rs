//! `ah-hook update` with an archive that also ships the thin client: the client is swapped atomically, kept as `.prev`, put back at once
//! when it fails its own self-test, and brought back by `--rollback`. Scratch HOME and plugin root only; the "engines" are shell scripts.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;
use common::Env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const ENGINE: &str = "#!/bin/sh\n[ \"$1\" = version ] && echo 3.0.0\nexit 0\n";
const BAD_HOOK: &str = "#!/bin/sh\necho 'self-test refused'\nexit 1\n";

fn exe(p: &Path, body: &[u8]) {
    std::fs::write(p, body).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A release archive `top/ah-engine` + `top/ah-hook`; returns (archive, its sha256).
fn archive(e: &Env, hook: &[u8]) -> (PathBuf, String) {
    let top = "ah-engine-v3.0.0-x86_64-unknown-linux-gnu";
    let pkg = e.path("pkg");
    let _ = std::fs::remove_dir_all(&pkg);
    std::fs::create_dir_all(pkg.join(top)).unwrap();
    exe(&pkg.join(top).join("ah-engine"), ENGINE.as_bytes());
    exe(&pkg.join(top).join("ah-hook"), hook);
    let tgz = e.path("release.tar.gz");
    assert!(
        Command::new("tar")
            .arg("-czf")
            .arg(&tgz)
            .arg("-C")
            .arg(&pkg)
            .arg(top)
            .status()
            .unwrap()
            .success()
    );
    let o = Command::new("shasum")
        .args(["-a", "256"])
        .arg(&tgz)
        .output()
        .unwrap();
    (
        tgz,
        String::from_utf8_lossy(&o.stdout)
            .split_whitespace()
            .next()
            .unwrap()
            .to_string(),
    )
}

fn update(e: &Env, args: &[&str]) -> (i32, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_ah-hook"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &e.home)
        .env("AH_WRAPPER_TEST", "1")
        .arg("--plugin-root")
        .arg(&e.root)
        .arg("update")
        .args(args)
        .output()
        .unwrap();
    (
        o.status.code().unwrap_or(-1),
        format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
    )
}

fn setup(tag: &str) -> (Env, PathBuf, PathBuf, Vec<u8>) {
    let e = Env::new(tag);
    let bin = e.state.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    exe(
        &bin.join("ah-engine"),
        "#!/bin/sh\n[ \"$1\" = version ] && echo 1.0.0\nexit 0\n".as_bytes(),
    );
    // the installed thin client: a copy of the real one, so it passes its own self-test when it is put back
    let real = std::fs::read(env!("CARGO_BIN_EXE_ah-hook")).unwrap();
    exe(&bin.join("ah-hook"), &real);
    (e, bin.join("ah-engine"), bin.join("ah-hook"), real)
}

#[test]
fn a_good_thin_client_in_the_archive_replaces_the_installed_one_and_the_old_is_kept() {
    let (e, engine, hook, real) = setup("uh-good");
    let mut newhook = real.clone();
    newhook.extend_from_slice(b"\n"); // a different file that is still the real program
    let (tgz, sha) = archive(&e, &newhook);
    let (code, out) = update(
        &e,
        &[
            "--from",
            tgz.to_str().unwrap(),
            "--sha256",
            &sha,
            "--no-restart",
        ],
    );
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        std::fs::read(&hook).unwrap(),
        newhook,
        "the new thin client is in place\n{out}"
    );
    assert_eq!(
        std::fs::read(hook.with_extension("prev")).unwrap(),
        real,
        "the old one is kept as .prev"
    );
    assert!(out.contains("ah-hook: updated"), "{out}");
    assert_eq!(std::fs::read_to_string(&engine).unwrap(), ENGINE);
}

#[test]
fn a_thin_client_that_fails_its_self_test_is_put_back_at_once() {
    let (e, engine, hook, real) = setup("uh-bad");
    let (tgz, sha) = archive(&e, BAD_HOOK.as_bytes());
    // the candidate launcher is the new (bad) one, so the pre-swap self-test already refuses: nothing at all is replaced
    let (code, out) = update(
        &e,
        &[
            "--from",
            tgz.to_str().unwrap(),
            "--sha256",
            &sha,
            "--no-restart",
        ],
    );
    assert_eq!(code, 1, "{out}");
    assert_eq!(
        std::fs::read(&hook).unwrap(),
        real,
        "the installed thin client is untouched\n{out}"
    );
    assert!(
        std::fs::read_to_string(&engine).unwrap().contains("1.0.0"),
        "so is the engine"
    );
    // the same archive with an explicit good launcher for the pre-swap test: the swap happens, the post-swap self-test refuses the
    // new client, and it is put back at once while the engine update stands
    let good = e.path("good-launcher");
    exe(&good, &real);
    let (code, out) = update(
        &e,
        &[
            "--from",
            tgz.to_str().unwrap(),
            "--sha256",
            &sha,
            "--no-restart",
            "--launcher",
            good.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        std::fs::read(&hook).unwrap(),
        real,
        "the failing client was put back\n{out}"
    );
    assert!(out.contains("put back at once"), "{out}");
    assert_eq!(
        std::fs::read_to_string(&engine).unwrap(),
        ENGINE,
        "the engine update stands"
    );
}

#[test]
fn rollback_brings_back_the_previous_engine_and_thin_client() {
    let (e, engine, hook, real) = setup("uh-rb");
    let mut newhook = real.clone();
    newhook.extend_from_slice(b"\n");
    let (tgz, sha) = archive(&e, &newhook);
    assert_eq!(
        update(
            &e,
            &[
                "--from",
                tgz.to_str().unwrap(),
                "--sha256",
                &sha,
                "--no-restart"
            ]
        )
        .0,
        0
    );
    let (code, out) = update(&e, &["--rollback", "--no-restart"]);
    assert_eq!(code, 0, "{out}");
    assert!(
        std::fs::read_to_string(&engine).unwrap().contains("1.0.0"),
        "{out}"
    );
    assert_eq!(
        std::fs::read(&hook).unwrap(),
        real,
        "the previous thin client is back\n{out}"
    );
    assert!(out.contains("ah-hook: rolled back"), "{out}");
}
