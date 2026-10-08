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

/// Copy what a heartbeat touches into a scratch home; `None` when that fails (the call is then not verified). A call that
/// writes the store (`--summary`) gets a consistent COPY of it (SQLite's online backup), never a link: Node's write in the
/// scratch home must not reach the real store.
pub fn prepare(inv: &Inv, with_store: bool) -> Option<PathBuf> {
    let scratch = crate::paths::dir().join(defaults::text("mesh_write.verify_dir")).join(format!("{}-{}", std::process::id(), now_ms()));
    let root = devswarm_root(&inv.home);
    let sroot = devswarm_root(&scratch.join(defaults::text("mesh_write.shadow_home")));
    std::fs::create_dir_all(&sroot).ok()?;
    for d in defaults::list("mesh_write.verify_copy_dirs") {
        if root.join(d).is_dir() {
            copy_tree(&root.join(d), &sroot.join(d)).ok()?;
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
    // the sender-alias map the summary refresh attributes rows with
    let alias = defaults::text("mesh_write.alias_file");
    if root.join(alias).is_file() {
        std::fs::copy(root.join(alias), sroot.join(alias)).ok()?;
    }
    // the settings and the Jev label cache the summary refresh reads, from the home
    let (hh, sh) = (
        inv.home.join(defaults::text("mesh_write.dir_anti_hall")),
        scratch.join(defaults::text("mesh_write.shadow_home")).join(defaults::text("mesh_write.dir_anti_hall")),
    );
    for rel in [
        PathBuf::from(defaults::text("guardkit.settings_file")),
        PathBuf::from(defaults::text("mesh_write.dir_cache")).join(defaults::text("mesh_write.jev_cache_file")),
    ] {
        let src = if rel.starts_with(defaults::text("mesh_write.dir_cache")) { hh.join(&rel) } else { inv.home.join(&rel) };
        let dst = if rel.starts_with(defaults::text("mesh_write.dir_cache")) {
            sh.join(&rel)
        } else {
            scratch.join(defaults::text("mesh_write.shadow_home")).join(&rel)
        };
        if src.is_file() {
            std::fs::create_dir_all(dst.parent()?).ok()?;
            std::fs::copy(&src, &dst).ok()?;
        }
    }
    if with_store {
        let real = super::real_store(inv).ok()?;
        let key = real.parent()?.file_name()?.to_string_lossy().to_string();
        let dir = sroot.join(defaults::text("mesh_write.dir_store")).join(&key);
        std::fs::create_dir_all(&dir).ok()?;
        if let Ok(marker) = std::fs::read(real.parent()?.join(defaults::text("mesh.backend_marker"))) {
            std::fs::write(dir.join(defaults::text("mesh.backend_marker")), marker).ok()?;
        }
        let max_id = super::snapshot(&real, &dir.join(defaults::text("mesh_write.store_file"))).ok()?;
        std::fs::write(scratch.join("snap-max-id"), max_id.to_string()).ok()?;
        std::fs::write(scratch.join("snap-key"), &key).ok()?;
    }
    for d in defaults::list("mesh_write.verify_link_dirs") {
        if with_store && d == defaults::text("mesh_write.dir_store") {
            continue;
        }
        if root.join(d).exists() {
            std::os::unix::fs::symlink(root.join(d), sroot.join(d)).ok()?;
        }
    }
    Some(scratch)
}

/// The files a heartbeat writes: its record, the liveness verdict and the app-state cache.
fn id_files(root: &Path, id: &str) -> [PathBuf; 3] {
    let j = defaults::text("mesh_write.json_suffix");
    [
        root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{j}")),
        root.join(defaults::text("mesh_write.dir_liveness")).join(format!("{id}{j}")),
        root.join(defaults::text("mesh_write.app_cache_dir")).join(defaults::text("mesh_write.app_cache_file")),
    ]
}

/// After the engine answered: save what it printed and wrote, and start the detached verifier.
pub fn launch(scratch: &Path, inv: &Inv, id: &str, argv: &[String], stdout: &str) {
    let real = id_files(&devswarm_root(&inv.home), id);
    let (mut written, row) = super::take_written();
    // the summary file is refreshed by the same call; it is read back (the engine's refresh is not captured as it is written)
    if let (Some(_), Ok(key)) = (&row, std::fs::read_to_string(scratch.join("snap-key"))) {
        let rel = format!(
            "{}/{}/{}/{key}{}",
            defaults::text("mesh_write.dir_anti_hall"),
            defaults::text("mesh_write.dir_devswarm"),
            defaults::text("mesh_write.dir_summaries"),
            defaults::text("mesh_write.json_suffix")
        );
        written.push((rel.clone(), std::fs::read(inv.home.join(&rel)).unwrap_or_default()));
    }
    let save = || -> std::io::Result<()> {
        std::fs::write(scratch.join("expect-stdout"), stdout)?;
        for (i, f) in real.iter().enumerate() {
            std::fs::write(scratch.join(format!("expect-{i}")), std::fs::read(f).unwrap_or_default())?;
        }
        let mut manifest = Vec::new();
        for (i, (rel, bytes)) in written.iter().enumerate() {
            std::fs::write(scratch.join(format!("expect-w{i}")), bytes)?;
            manifest.push(serde_json::json!([rel, format!("expect-w{i}")]));
        }
        std::fs::write(scratch.join("expect-manifest"), serde_json::Value::Array(manifest).to_string())?;
        if let Some(h) = &row {
            std::fs::write(scratch.join("expect-hash"), h)?;
            if let Ok(key) = std::fs::read_to_string(scratch.join("snap-key")) {
                let db = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(key).join(defaults::text("mesh_write.store_file"));
                std::fs::write(scratch.join("expect-row"), row_text(&db, h).unwrap_or_default())?;
            }
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
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    crate::discard::harmless(c.spawn()); // keep: a verifier that does not start only leaves this call unverified
}

/// The physical row with `hash`, every column but the rowid and the writing process's reader nonce (the detached checker
/// does not share the engine's process ancestry).
pub fn row_text(db: &Path, hash: &str) -> Option<String> {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    c.busy_timeout(defaults::millis("mesh.busy_timeout_ms")).ok()?;
    let nonce_col = defaults::num("mesh_write.verify_nonce_col") as usize;
    c.query_row(crate::sql::MESHW_ROW_BY_HASH, [hash], |r| {
        let mut parts = Vec::new();
        for i in (0..r.as_ref().column_count()).filter(|i| *i != nonce_col) {
            parts.push(match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => "null".to_string(),
                rusqlite::types::ValueRef::Integer(x) => x.to_string(),
                rusqlite::types::ValueRef::Real(x) => x.to_string(),
                rusqlite::types::ValueRef::Text(t) => serde_json::to_string(&String::from_utf8_lossy(t)).unwrap_or_default(),
                rusqlite::types::ValueRef::Blob(b) => format!("blob:{}", b.len()),
            });
        }
        Ok(parts.join("|"))
    })
    .ok()
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
    let id = argv.get(1).cloned().unwrap_or_default();
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
        .args(["-e", defaults::text("mesh_write.verify_node_snippet")])
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
            let files = id_files(&devswarm_root(&home), &id);
            let got = [o.stdout.clone(), read(&files[0]), read(&files[1]), read(&files[2])];
            let expected =
                [read(&scratch.join("expect-stdout")), read(&scratch.join("expect-0")), read(&scratch.join("expect-1")), read(&scratch.join("expect-2"))];
            // what a --summary or a plan step wrote besides: each file the engine wrote, and the mesh row it appended
            let mut diff: Vec<String> = Vec::new();
            let mut detail = serde_json::Map::new();
            let manifest: Vec<(String, String)> = serde_json::from_slice::<Vec<(String, String)>>(&read(&scratch.join("expect-manifest"))).unwrap_or_default();
            for (rel, file) in &manifest {
                let (want, node_has) = (read(&scratch.join(file)), read(&home.join(rel)));
                if want != node_has {
                    diff.push(rel.clone());
                    let at = want.iter().zip(node_has.iter()).position(|(x, y)| x != y).unwrap_or(want.len().min(node_has.len()));
                    let (before, after) = (defaults::num("mesh_write.verify_window_before") as usize, defaults::num("mesh_write.verify_window_after") as usize);
                    let win = |b: &[u8]| cap(&b[at.saturating_sub(before).min(b.len())..(at + after).min(b.len())]);
                    detail.insert(rel.clone(), serde_json::json!({"at": at, "engine": win(&want), "node": win(&node_has)}));
                }
            }
            let mut concurrent = false;
            if let Ok(hash) = std::fs::read_to_string(scratch.join("expect-hash")) {
                let key = std::fs::read_to_string(scratch.join("snap-key")).unwrap_or_default();
                let db = |h: &Path| devswarm_root(h).join(defaults::text("mesh_write.dir_store")).join(&key).join(defaults::text("mesh_write.store_file"));
                if row_text(&db(&home), &hash).unwrap_or_default().as_bytes() != read(&scratch.join("expect-row")).as_slice() {
                    diff.push(defaults::text("mesh_write.verify_row_name").to_string());
                }
                let max_id: i64 = std::fs::read_to_string(scratch.join("snap-max-id")).ok().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
                concurrent = super::count_after(&db(&real_home), max_id) > 1;
            }
            if same(&expected, &got) && diff.is_empty() {
                log(defaults::text("mesh_write.verify_match"), serde_json::json!({}));
            } else {
                let result = if concurrent { defaults::text("mesh_write.shadow_concurrent") } else { defaults::text("mesh_write.verify_mismatch") };
                log(
                    result,
                    serde_json::json!({"engine": cap(&expected[0]), "node": cap(&got[0]), "sameHeartbeat": expected[1] == got[1], "sameVerdict": expected[2] == got[2], "sameCache": expected[3] == got[3], "diff": diff, "detail": detail}),
                );
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
