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
use std::time::Instant;

pub(crate) fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    // what the engine could not read, the witness cannot read either: an unreadable directory is copied as an empty one and
    // an unreadable file as an empty file, each with the permissions of the original
    if let Ok(rd) = std::fs::read_dir(src) {
        for e in rd.flatten() {
            let (s, d) = (e.path(), dst.join(e.file_name()));
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                copy_tree(&s, &d)?;
            } else if ft.is_file() && std::fs::copy(&s, &d).is_err() {
                std::fs::write(&d, b"")?;
                std::fs::set_permissions(&d, std::fs::metadata(&s)?.permissions())?;
            }
        }
    }
    // the witness must meet the same permissions the engine met (a read-only directory fails Node's write too)
    std::fs::set_permissions(dst, std::fs::metadata(src)?.permissions())
}

/// Remove a scratch tree, first making every directory in it writable again (a copied read-only directory refuses removal).
pub fn discard_tree(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fn unlock(p: &Path) {
        let Ok(m) = std::fs::symlink_metadata(p) else { return };
        if m.is_dir() {
            crate::discard::harmless(std::fs::set_permissions(p, std::fs::Permissions::from_mode(m.permissions().mode() | 0o700))); // keep: best effort, the removal below reports nothing either
            for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
                unlock(&e.path());
            }
        }
    }
    unlock(dir);
    crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: our own scratch directory; leftovers are only disk
}

/// What a verified verb is: they differ in what Node reads and writes, so in what is copied and compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `heartbeat`.
    Heartbeat,
    /// `inbox tick`.
    Tick,
    /// `inbox read-primary`.
    ReadPrimary,
    /// Plain `roster`.
    Roster,
}

/// The kind of a verb argv (`inbox tick <id> ...` or `heartbeat <id> ...`).
pub fn kind_of(argv: &[String]) -> Kind {
    if argv.first().map(String::as_str) == Some(defaults::text("mesh_write.verb_inbox")) {
        if argv.get(1).map(String::as_str) == Some(defaults::text("mesh_write.verb_tick")) {
            return Kind::Tick;
        }
        if argv.get(1).map(String::as_str) == Some(defaults::text("mesh_write.verb_read_primary")) {
            return Kind::ReadPrimary;
        }
    }
    if argv.first().map(String::as_str) == Some(defaults::text("mesh_write.verb_roster")) {
        return Kind::Roster;
    }
    Kind::Heartbeat
}

/// The workspace id of a verb argv.
pub fn id_of(argv: &[String]) -> String {
    argv.get(if kind_of(argv) == Kind::Heartbeat { 1 } else { 2 }).cloned().unwrap_or_default()
}

/// Copy what a heartbeat touches into a scratch home; `None` when that fails (the call is then not verified). A call that
/// writes the store (`--summary`) gets a consistent COPY of it (SQLite's online backup), never a link: Node's write in the
/// scratch home must not reach the real store.
pub fn prepare(inv: &Inv, with_store: bool) -> Option<PathBuf> {
    prepare_for(inv, Kind::Heartbeat, with_store)
}

/// Copy what a tick touches into a scratch home; `None` when that fails (the call is then not verified).
pub fn prepare_tick(inv: &Inv) -> Option<PathBuf> {
    prepare_for(inv, Kind::Tick, false)
}

/// Copy what a read-primary touches into a scratch home (the store as a consistent copy, the stable launcher its
/// `ackCommand` names); `None` when that fails (the call is then not verified).
pub fn prepare_read_primary(inv: &Inv) -> Option<PathBuf> {
    prepare_for(inv, Kind::ReadPrimary, true)
}

/// Copy what a roster reads into a scratch home (the store as a consistent copy); `None` when that fails.
pub fn prepare_roster(inv: &Inv) -> Option<PathBuf> {
    prepare_for(inv, Kind::Roster, true)
}

fn prepare_for(inv: &Inv, kind: Kind, with_store: bool) -> Option<PathBuf> {
    let scratch = crate::paths::dir().join(defaults::text("mesh_write.verify_dir")).join(format!("{}-{}", std::process::id(), now_ms()));
    let root = devswarm_root(&inv.home);
    let sroot = devswarm_root(&scratch.join(defaults::text("mesh_write.shadow_home")));
    std::fs::create_dir_all(&sroot).ok()?;
    let dirs = match kind {
        Kind::Tick => "mesh_write.verify_tick_copy_dirs",
        Kind::ReadPrimary => "mesh_write.verify_read_primary_copy_dirs",
        Kind::Roster => "mesh_write.verify_roster_copy_dirs",
        Kind::Heartbeat => "mesh_write.verify_copy_dirs",
    };
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
    if kind == Kind::Roster {
        for f in defaults::list("mesh_write.verify_roster_copy_files") {
            if root.join(f).is_file() {
                std::fs::copy(root.join(f), sroot.join(f)).ok()?;
            }
        }
        // what a roster reads under the home and the witness must see as the engine does (it only reads them)
        for rel in defaults::list("mesh_write.verify_roster_home_links") {
            let (src, dst) = (inv.home.join(rel), scratch.join(defaults::text("mesh_write.shadow_home")).join(rel));
            if src.exists() {
                std::fs::create_dir_all(dst.parent()?).ok()?;
                std::os::unix::fs::symlink(&src, &dst).ok()?;
            }
        }
    }
    if kind == Kind::ReadPrimary {
        // the `ackCommand` names the stable launcher under the home: the scratch home needs one, at the same relative place
        let rel = PathBuf::from(defaults::text("mesh_write.dir_anti_hall"))
            .join(defaults::text("mesh_write.launcher_dir"))
            .join(defaults::text("mesh_write.launcher_devswarm"));
        let (src, dst) = (inv.home.join(&rel), scratch.join(defaults::text("mesh_write.shadow_home")).join(&rel));
        if src.is_file() {
            std::fs::create_dir_all(dst.parent()?).ok()?;
            std::fs::copy(&src, &dst).ok()?;
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
    if kind == Kind::ReadPrimary {
        snapshot_descriptor_files(&inv.home, &scratch.join(defaults::text("mesh_write.shadow_home")), &sroot)?;
    }
    // the central log: the witness appends to a copy, and what it appended is compared with what the engine appended
    for rel in defaults::list("devswarm_cli.log_witness_files") {
        let (src, dst) = (inv.home.join(rel), scratch.join(defaults::text("mesh_write.shadow_home")).join(rel));
        if src.is_file() {
            std::fs::create_dir_all(dst.parent()?).ok()?;
            std::fs::copy(&src, &dst).ok()?;
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
    // a caller outside any project has no store to copy: the verb answers without one (a refusal), and Node meets none either
    if with_store && let Some(real) = super::real_store(inv).ok().filter(|r| r.is_file()) {
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

/// A descriptor's NDJSON inbox and cursor file are named by absolute path: a witness that read them in place would race
/// with whoever moves the real cursor next. Each that sits under the real home is copied to the same place under the scratch
/// home and the copied descriptor names the copy (so a path printed by the witness maps back by swapping the two homes).
fn snapshot_descriptor_files(real_home: &Path, scratch_home: &Path, sroot: &Path) -> Option<()> {
    let dir = sroot.join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Some(()) };
    for e in rd.flatten() {
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(mut d) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let mut changed = false;
        for field in [defaults::text("mesh_write.field_inbox_path"), defaults::text("mesh_write.field_cursor_path")] {
            let Some(p) = d[field].as_str().map(PathBuf::from) else { continue };
            let Ok(rel) = p.strip_prefix(real_home) else { continue };
            if !p.is_file() {
                continue;
            }
            let dst = scratch_home.join(rel);
            std::fs::create_dir_all(dst.parent()?).ok()?;
            std::fs::copy(&p, &dst).ok()?;
            d[field] = serde_json::Value::String(dst.to_string_lossy().into_owned());
            changed = true;
        }
        if changed {
            std::fs::write(e.path(), d.to_string()).ok()?;
        }
    }
    Some(())
}

/// The files a verb writes: for a heartbeat its record, the liveness verdict and the app-state cache; for a tick the
/// refreshed heartbeat record, the wake-tick marker and the cron-found-mail file; a read-primary writes one receipt, named
/// by a random id, which the verifier finds through the written-file manifest instead.
fn id_files(root: &Path, argv: &[String]) -> Vec<PathBuf> {
    let id = id_of(argv);
    let j = defaults::text("mesh_write.json_suffix");
    let heartbeat = root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{j}"));
    match kind_of(argv) {
        Kind::ReadPrimary | Kind::Roster => Vec::new(),
        Kind::Tick => vec![
            heartbeat,
            root.join(defaults::text("mesh_write.dir_wake_tick")).join(format!("{id}{j}")),
            root.join(defaults::text("mesh_write.file_cron_found_mail")),
        ],
        Kind::Heartbeat => vec![
            heartbeat,
            root.join(defaults::text("mesh_write.dir_liveness")).join(format!("{id}{j}")),
            root.join(defaults::text("mesh_write.app_cache_dir")).join(defaults::text("mesh_write.app_cache_file")),
        ],
    }
}

/// After the engine answered: save what it printed and wrote, and start the detached verifier.
pub fn launch(scratch: &Path, inv: &Inv, argv: &[String], stdout: &str) {
    let real = id_files(&devswarm_root(&inv.home), argv);
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
        discard_tree(scratch);
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut c = Command::new(exe);
    c.arg(defaults::text("mesh_write.verb_mesh")).arg(defaults::text("mesh_write.verify_flag")).arg(scratch).arg(inv.now.to_string()).args(argv);
    if kind_of(argv) != Kind::Heartbeat
        && let Some(nonce) = crate::meshw::tick::reader_nonce_cached(&inv.home)
    {
        c.env(defaults::text("mesh_write.env_verify_nonce"), nonce);
    }
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

/// Whether a manifest path is a read receipt (named by a random id) rather than a file both sides write at one path.
fn is_receipt(rel: &str) -> bool {
    rel.split('/').any(|part| part == defaults::text("mesh_write.dir_read_receipts"))
}

/// What Node printed and wrote for a read-primary, as the engine's output is spelled: Node's receipt id replaced by the
/// engine's, Node's scratch home by the real one. Returns the stdout and `(engine's relative path, Node's receipt)` pairs.
fn read_primary_view(node_home: &Path, real_home: &Path, manifest: &[(String, String)], stdout: &[u8]) -> (Vec<u8>, Vec<(String, Vec<u8>)>) {
    let suffix = defaults::text("mesh_write.json_suffix");
    let (node_home_text, real_home_text) = (node_home.to_string_lossy().into_owned(), real_home.to_string_lossy().into_owned());
    let mut files = Vec::new();
    let mut out = String::from_utf8_lossy(stdout).replace(&node_home_text, &real_home_text);
    for (rel, _) in manifest.iter().filter(|(r, _)| is_receipt(r)) {
        let rel_path = Path::new(rel);
        let (Some(dir), Some(engine_rid)) = (rel_path.parent(), rel_path.file_stem().and_then(|x| x.to_str())) else { continue };
        let real_names: std::collections::HashSet<String> =
            std::fs::read_dir(real_home.join(dir)).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        // Node's receipt is the file its scratch directory holds that the real directory did not hold before the engine wrote
        let mut fresh: Vec<(String, std::time::SystemTime)> = std::fs::read_dir(node_home.join(dir))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        (name.ends_with(suffix) && !real_names.contains(&name))
                            .then(|| (name, e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        fresh.sort_by_key(|(_, t)| *t);
        let Some((name, _)) = fresh.pop() else { continue };
        let node_rid = name.trim_end_matches(suffix).to_string();
        let bytes = std::fs::read(node_home.join(dir).join(&name)).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes).replace(&node_home_text, &real_home_text).replace(&node_rid, engine_rid);
        out = out.replace(&node_rid, engine_rid);
        files.push((rel.clone(), text.into_bytes()));
    }
    (out.into_bytes(), files)
}

/// Both outputs equal.
pub fn same(expected: &[Vec<u8>], got: &[Vec<u8>]) -> bool {
    expected == got
}

fn cap(b: &[u8]) -> String {
    String::from_utf8_lossy(b).chars().take(defaults::num("mesh_write.verify_cap") as usize).collect()
}

/// `Command::output`, bounded: Node's own `spawnSync` waits for a child that ignores its termination signal for ever (a hung
/// `hivecontrol`), and the witness must never be what holds a process or a scratch directory for ever. Node runs in a process
/// group of its own, so the whole group is killed at the bound.
pub(crate) fn bounded_output(c: &mut Command) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    c.stdout(Stdio::piped()).process_group(0);
    let mut child = c.spawn()?;
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = stdout.as_mut() {
            crate::discard::harmless(o.read_to_end(&mut buf)); // keep: a short read is judged by the exit status
        }
        buf
    });
    let deadline = Instant::now() + defaults::millis("mesh_write.verify_node_timeout_ms");
    let poll = defaults::millis("mesh_write.verify_node_poll_ms");
    let status = loop {
        match child.try_wait()? {
            Some(st) => break st,
            None if Instant::now() >= deadline => {
                // SAFETY: killing the process group this function created for its own child.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                crate::discard::harmless(child.wait()); // keep: reaping
                crate::discard::harmless(reader.join()); // keep: the pipe closed with the group
                return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
            }
            None => std::thread::sleep(poll),
        }
    };
    let stdout = reader.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr: Vec::new() })
}

/// The verifier process: `args` = scratch dir, clock, the verb's argv.
pub fn run_verifier(args: &[String]) -> i32 {
    let t0 = now_ms();
    let (Some(scratch), Some(now)) = (args.first().map(PathBuf::from), args.get(1)) else { return 1 };
    let argv = &args[2..];
    let kind = kind_of(argv);
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
    node.arg("-e")
        .arg(defaults::text(match kind {
            Kind::Tick => "mesh_write.verify_tick_node_snippet",
            Kind::ReadPrimary => "mesh_write.verify_read_primary_node_snippet",
            Kind::Roster => "mesh_write.verify_roster_node_snippet",
            Kind::Heartbeat => "mesh_write.verify_node_snippet",
        }))
        .arg(root.join(defaults::text("mesh_write.node_cli")))
        .arg(now)
        .args(argv)
        .env(defaults::text("mesh_write.env_home"), &home)
        // Node's central log goes to the scratch home whatever the caller's environment says
        .env(defaults::text("devswarm_cli.env_log_dir"), crate::meshw::clog::witness_dir(&home))
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let log_before = crate::meshw::clog::size_of(&home);
    let out = bounded_output(&mut node);
    match out {
        Ok(o) if o.status.success() => {
            let read = |p: &Path| std::fs::read(p).unwrap_or_default();
            let files = id_files(&devswarm_root(&home), argv);
            let manifest: Vec<(String, String)> = serde_json::from_slice::<Vec<(String, String)>>(&read(&scratch.join("expect-manifest"))).unwrap_or_default();
            // a read-primary's receipt is named by a random id: Node's copy of it is found in its scratch directory and both
            // outputs are compared with the two ids, and the two homes, made equal
            let mut node_stdout = o.stdout.clone();
            let mut node_files: Vec<(String, Vec<u8>)> = Vec::new();
            if kind == Kind::ReadPrimary {
                let (out, found) = read_primary_view(&home, &real_home, &manifest, &o.stdout);
                node_stdout = out;
                node_files = found;
            }
            if kind == Kind::Tick {
                // the JSON form of a tick names the home (storePath): the witness ran in the scratch one
                node_stdout = String::from_utf8_lossy(&node_stdout).replace(&home.to_string_lossy().into_owned(), &real_home.to_string_lossy()).into_bytes();
            }
            let mut got = vec![node_stdout];
            got.extend(files.iter().map(|f| read(f)));
            let mut expected = vec![read(&scratch.join("expect-stdout"))];
            expected.extend((0..files.len()).map(|i| read(&scratch.join(format!("expect-{i}")))));
            // what a --summary or a plan step wrote besides: each file the engine wrote, and the mesh row it appended
            let mut diff: Vec<String> = Vec::new();
            let mut detail = serde_json::Map::new();
            for (rel, file) in &manifest {
                let want = read(&scratch.join(file));
                if crate::meshw::clog::is_log_rel(rel) {
                    // the central log: what Node appended, with the timestamp and the writer's pid blanked on both sides
                    if !crate::meshw::clog::delta_equal(&read(&home.join(rel)), log_before, &want) {
                        diff.push(rel.clone());
                    }
                    continue;
                }
                let node_has = if kind == Kind::ReadPrimary && is_receipt(rel) {
                    node_files.iter().find(|(r, _)| r == rel).map(|(_, b)| b.clone()).unwrap_or_default()
                } else {
                    read(&home.join(rel))
                };
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
                let names = defaults::list(match kind {
                    Kind::Tick => "mesh_write.verify_names_tick",
                    Kind::ReadPrimary => "mesh_write.verify_names_read_primary",
                    Kind::Roster => "mesh_write.verify_names_roster",
                    Kind::Heartbeat => "mesh_write.verify_names_heartbeat",
                });
                let mut rec = serde_json::json!({"engine": cap(&expected[0]), "node": cap(&got[0]), "diff": diff, "detail": detail});
                for (i, name) in names.iter().enumerate() {
                    rec[*name] = serde_json::json!(if kind == Kind::ReadPrimary { diff.is_empty() } else { expected.get(i + 1) == got.get(i + 1) });
                }
                let result = if concurrent { defaults::text("mesh_write.shadow_concurrent") } else { defaults::text("mesh_write.verify_mismatch") };
                log(result, rec);
            }
        }
        _ => log(defaults::text("mesh_write.verify_error"), serde_json::json!({"reason": "node"})),
    }
    discard_tree(&scratch);
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
