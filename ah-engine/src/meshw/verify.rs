//! The Node shadow of an answered WRITING verb (owner rule: every ported verb keeps its Node version as a background check
//! until proven). Node's write is never run twice against the real home: before the engine writes, the parts of the
//! DevSwarm root a heartbeat touches are copied into a scratch home (the store is linked, it is only read); after the
//! engine answers, a detached copy of the engine runs the real `devswarm.js` there with the engine's clock and compares
//! Node's stdout and the two files it wrote with what the engine printed and wrote. The result is one line in
//! `mesh_write.verify_log`; a difference never changes what the caller already got.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep: the verifier is advisory, a step that
// fails only means this call is not verified (the `error` line says so when it can).
use crate::defaults;
use crate::meshw::common::{Inv, now_ms};
use crate::meshw::idlock::devswarm_root;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let (s, d) = (e.path(), dst.join(e.file_name()));
        let ft = e.file_type()?;
        if ft.is_dir() {
            copy_tree(&s, &d)?;
        } else if ft.is_file() {
            std::fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

/// What a verified verb is: they differ in what Node reads and writes, so in what is copied and compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `heartbeat`.
    Heartbeat,
    /// `inbox tick`.
    Tick,
}

/// The kind of a verb argv (`inbox tick <id> ...` or `heartbeat <id> ...`).
pub fn kind_of(argv: &[String]) -> Kind {
    if argv.first().map(String::as_str) == Some(defaults::text("mesh_write.verb_inbox"))
        && argv.get(1).map(String::as_str) == Some(defaults::text("mesh_write.verb_tick"))
    {
        Kind::Tick
    } else {
        Kind::Heartbeat
    }
}

/// The workspace id of a verb argv.
pub fn id_of(argv: &[String]) -> String {
    argv.get(if kind_of(argv) == Kind::Tick { 2 } else { 1 }).cloned().unwrap_or_default()
}

/// Copy what a heartbeat touches into a scratch home; `None` when that fails (the call is then not verified).
pub fn prepare(inv: &Inv) -> Option<PathBuf> {
    prepare_for(inv, Kind::Heartbeat)
}

/// Copy what a tick touches into a scratch home; `None` when that fails (the call is then not verified).
pub fn prepare_tick(inv: &Inv) -> Option<PathBuf> {
    prepare_for(inv, Kind::Tick)
}

fn prepare_for(inv: &Inv, kind: Kind) -> Option<PathBuf> {
    let scratch = crate::paths::dir().join(defaults::text("mesh_write.verify_dir")).join(format!("{}-{}", std::process::id(), now_ms()));
    let root = devswarm_root(&inv.home);
    let sroot = devswarm_root(&scratch.join(defaults::text("mesh_write.shadow_home")));
    std::fs::create_dir_all(&sroot).ok()?;
    let dirs = if kind == Kind::Tick { "mesh_write.verify_tick_copy_dirs" } else { "mesh_write.verify_copy_dirs" };
    for d in defaults::list(dirs) {
        if root.join(d).is_dir() {
            copy_tree(&root.join(d), &sroot.join(d)).ok()?;
        }
    }
    if kind == Kind::Tick {
        for f in defaults::list("mesh_write.verify_tick_copy_files") {
            if root.join(f).is_file() {
                std::fs::copy(root.join(f), sroot.join(f)).ok()?;
            }
        }
    }
    // a descriptor that names a file of the copied `cursors` directory must name the copy (Node compares that path with the
    // shared cursor path of ITS home)
    let (from, to) = (
        format!("{}/{}/", root.display(), defaults::text("mesh_write.dir_cursors")),
        format!("{}/{}/", sroot.display(), defaults::text("mesh_write.dir_cursors")),
    );
    if let Ok(rd) = std::fs::read_dir(sroot.join(defaults::text("mesh_write.dir_workspaces"))) {
        for e in rd.flatten() {
            if let Ok(text) = std::fs::read_to_string(e.path())
                && text.contains(&from)
            {
                std::fs::write(e.path(), text.replace(&from, &to)).ok()?;
            }
        }
    }
    for d in defaults::list("mesh_write.verify_link_dirs") {
        if root.join(d).exists() {
            std::os::unix::fs::symlink(root.join(d), sroot.join(d)).ok()?;
        }
    }
    Some(scratch)
}

/// The files a verb writes: for a heartbeat its record, the liveness verdict and the app-state cache; for a tick the
/// refreshed heartbeat record, the wake-tick marker and the cron-found-mail file.
fn id_files(root: &Path, argv: &[String]) -> [PathBuf; 3] {
    let id = id_of(argv);
    let j = defaults::text("mesh_write.json_suffix");
    let heartbeat = root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{j}"));
    if kind_of(argv) == Kind::Tick {
        return [
            heartbeat,
            root.join(defaults::text("mesh_write.dir_wake_tick")).join(format!("{id}{j}")),
            root.join(defaults::text("mesh_write.file_cron_found_mail")),
        ];
    }
    [
        heartbeat,
        root.join(defaults::text("mesh_write.dir_liveness")).join(format!("{id}{j}")),
        root.join(defaults::text("mesh_write.app_cache_dir")).join(defaults::text("mesh_write.app_cache_file")),
    ]
}

/// After the engine answered: save what it printed and wrote, and start the detached verifier.
pub fn launch(scratch: &Path, inv: &Inv, argv: &[String], stdout: &str) {
    let real = id_files(&devswarm_root(&inv.home), argv);
    let save = || -> std::io::Result<()> {
        std::fs::write(scratch.join("expect-stdout"), stdout)?;
        for (i, f) in real.iter().enumerate() {
            std::fs::write(scratch.join(format!("expect-{i}")), std::fs::read(f).unwrap_or_default())?;
        }
        Ok(())
    };
    if save().is_err() {
        crate::discard::harmless(std::fs::remove_dir_all(scratch)); // keep: nothing to verify
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut c = Command::new(exe);
    c.arg(defaults::text("mesh_write.verb_mesh")).arg(defaults::text("mesh_write.verify_flag")).arg(scratch).arg(inv.now.to_string()).args(argv);
    if kind_of(argv) == Kind::Tick
        && let Some(nonce) = crate::meshw::tick::reader_nonce_cached(&inv.home)
    {
        c.env(defaults::text("mesh_write.env_verify_nonce"), nonce);
    }
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    crate::discard::harmless(c.spawn()); // keep: a verifier that does not start only leaves this call unverified
}

/// Both outputs equal.
pub fn same(expected: &[Vec<u8>], got: &[Vec<u8>]) -> bool {
    expected == got
}

fn cap(b: &[u8]) -> String {
    String::from_utf8_lossy(b).chars().take(defaults::num("mesh_write.verify_cap") as usize).collect()
}

/// The verifier process: `args` = scratch dir, clock, the verb's argv.
pub fn run_verifier(args: &[String]) -> i32 {
    let t0 = now_ms();
    let (Some(scratch), Some(now)) = (args.first().map(PathBuf::from), args.get(1)) else { return 1 };
    let argv = &args[2..];
    let tick = kind_of(argv) == Kind::Tick;
    let verb = argv.first().cloned().unwrap_or_default();
    let log = |result: &str, extra: serde_json::Value| {
        let mut rec = serde_json::json!({"ts": t0, "verb": verb, "result": result, "ms": now_ms() - t0});
        if let (Some(r), Some(e)) = (rec.as_object_mut(), extra.as_object()) {
            r.extend(e.clone());
        }
        crate::meshw::verify_log(&rec);
    };
    let home = scratch.join(defaults::text("mesh_write.shadow_home"));
    let Some(root) = defaults::root() else {
        log(defaults::text("mesh_write.verify_error"), serde_json::json!({"reason": "no-plugin-root"}));
        return 0;
    };
    // the scratch home has no app database of its own: Node reads the real one (read only), as the engine did
    let real_home = std::env::var_os(defaults::text("mesh_write.env_home")).map(PathBuf::from).unwrap_or_default();
    let env_now: crate::meshw::ident::Env = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let app_db = crate::meshw::ident::app_db_path(&real_home, &env_now);
    let mut node = Command::new(defaults::text("mesh_write.node_bin"));
    if let Some(db) = &app_db {
        node.env(defaults::text("mesh_write.env_app_db"), db);
    }
    let out = node
        .arg("-e")
        .arg(defaults::text(if tick { "mesh_write.verify_tick_node_snippet" } else { "mesh_write.verify_node_snippet" }))
        .arg(root.join(defaults::text("mesh_write.node_cli")))
        .arg(now)
        .args(argv)
        .env(defaults::text("mesh_write.env_home"), &home)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let read = |p: &Path| std::fs::read(p).unwrap_or_default();
            let files = id_files(&devswarm_root(&home), argv);
            let got = [o.stdout.clone(), read(&files[0]), read(&files[1]), read(&files[2])];
            let expected =
                [read(&scratch.join("expect-stdout")), read(&scratch.join("expect-0")), read(&scratch.join("expect-1")), read(&scratch.join("expect-2"))];
            if same(&expected, &got) {
                log(defaults::text("mesh_write.verify_match"), serde_json::json!({}));
            } else {
                let names = defaults::list(if tick { "mesh_write.verify_names_tick" } else { "mesh_write.verify_names_heartbeat" });
                let mut rec = serde_json::json!({"engine": cap(&expected[0]), "node": cap(&got[0])});
                for (i, name) in names.iter().enumerate() {
                    rec[*name] = serde_json::json!(expected[i + 1] == got[i + 1]);
                }
                log(defaults::text("mesh_write.verify_mismatch"), rec);
            }
        }
        _ => log(defaults::text("mesh_write.verify_error"), serde_json::json!({"reason": "node"})),
    }
    crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: our own scratch directory
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_difference_in_stdout_or_a_written_file_is_a_mismatch() {
        let a = vec![b"x".to_vec(), b"h".to_vec(), b"v".to_vec(), b"c".to_vec()];
        assert!(same(&a, &a.clone()));
        for i in 0..4 {
            let mut b = a.clone();
            b[i].push(b'!');
            assert!(!same(&a, &b), "difference in part {i} must be seen");
        }
    }
}
