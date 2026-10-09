//! The central DevSwarm log (`~/.anti-hall/logs/devswarm.jsonl`), written the way `companion/lib/anti-hall-log.js` writes it.
//!
//! Node's verbs log a refusal (`logVerbOutcome`) and a few events (an unclaimed session promoted) to ONE machine-wide file.
//! The engine writes the same lines with the same rules:
//!
//! * the line is `JSON.stringify(entry) + "\n"`, the entry's keys in Node's order (`devswarm_cli.log_entry_fields`);
//! * the file lives in `ANTI_HALL_LOG_DIR` when that is set, else `<home>/.anti-hall/logs`;
//! * before an append that would take the file past `log_max_bytes` it is renamed to `devswarm.jsonl.1` (replacing the
//!   previous generation), and the rotate check and the append both happen under one lock (`devswarm.jsonl.rotate.lock`,
//!   the `lock.js` protocol, taken over only when stale and not held by a live process); a writer that cannot get the lock
//!   within the wait budget appends without it, exactly as Node does;
//! * the append is one `write(2)` on an `O_APPEND` descriptor, so interleaved writers never split a line;
//! * it never fails the caller: every step that fails drops the line.
//!
//! The entry carries the writer's pid; the engine's entry carries the engine's own pid, which is the true writer. The
//! parity tests and the Node witness blank the timestamp and the pid on both sides (`devswarm_cli.log_masks`).
//!
//! Node refuses the real-home fallback under `node --test` (`NODE_TEST_CONTEXT` without a log directory): the engine hands
//! such a call to Node ([`ready`]), before anything is written.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep: a log line is advisory and Node's own
// logger drops it silently on any failure (its fail-open doctrine).
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::taskkit::time;
use crate::defaults;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{R, defer};
use std::io::Write;
use std::path::PathBuf;

/// `logDir()`: `Some` with the directory, `None` when Node would refuse (a test context without a directory).
fn dir_of(inv: &Inv) -> Option<PathBuf> {
    if let Some(d) = inv.env.get(defaults::text("devswarm_cli.env_log_dir")).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    if inv.env.get(defaults::text("devswarm_cli.env_test_context")).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    Some(inv.write_home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs")))
}

/// Defers (before anything is written) when Node would not write the log at all: the call is then Node's, which also
/// reports why on its stderr.
pub fn ready(inv: &Inv) -> R<()> {
    if dir_of(inv).is_none() {
        return defer("log-test-context");
    }
    Ok(())
}

/// The log file's path under the home, as the witness's manifest spells it.
pub fn rel() -> String {
    format!("{}/{}/{}", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_logs"), defaults::text("devswarm_cli.log_file"))
}

fn lock_params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("devswarm_cli.log_lock_stale_ms"),
        wait_ms: defaults::num("devswarm_cli.log_lock_wait_ms"),
        step_ms: defaults::num("devswarm_cli.log_lock_step_ms"),
        reclaim_stale_ms: defaults::num("devswarm_cli.log_lock_reclaim_stale_ms"),
        release_tries: defaults::num("devswarm_cli.log_lock_release_tries"),
        release_step_ms: defaults::num("devswarm_cli.log_lock_release_step_ms"),
        boot_slop_s: defaults::num("devswarm_cli.log_lock_boot_slop_s"),
        steal_dead: false,
    }
}

/// `writeEntry`: append one finished line, rotating first when it would not fit. Fail-open.
fn write_line(dir: &std::path::Path, line: &str) {
    crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: Node's mkdirSync is try/caught; the append below fails the same way
    let target = dir.join(defaults::text("devswarm_cli.log_file"));
    let lock_path = format!("{}{}", target.display(), defaults::text("devswarm_cli.log_lock_suffix"));
    let lock = nodelock::acquire_stale_unless_live(&lock_path, lock_params());
    // rotateIfNeededLocked: an unreadable or missing file is not rotated
    if let Ok(m) = std::fs::metadata(&target)
        && m.len() + line.len() as u64 > defaults::num("devswarm_cli.log_max_bytes")
    {
        let rotated = dir.join(defaults::text("devswarm_cli.log_rotated_file"));
        crate::discard::harmless(std::fs::rename(&target, rotated)); // keep: Node keeps appending to whatever exists
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&target) {
        crate::discard::harmless(f.write_all(line.as_bytes())); // keep: a dropped line is Node's fail-open too
    }
    if let Some(l) = lock {
        l.release();
    }
}

/// `buildEntry` + `writeEntry`. `repo_key` is the explicit `ctx.repoKey` (`Some(None)` = explicit null); `None` = not given,
/// so the environment's `DEVSWARM_REPO_KEY` or null.
fn write_entry(inv: &Inv, op: &str, level: &str, repo_key: Option<Option<&str>>, mesh_id: Option<&str>, msg: &str, err: Option<&str>, ctx: Vec<(&str, OVal)>) {
    let Some(dir) = dir_of(inv) else { return };
    let f = defaults::list("devswarm_cli.log_entry_fields");
    let repo = match repo_key {
        Some(r) => r.map(str::to_string),
        None => inv.env.get(defaults::text("devswarm_cli.log_env_repo_key")).filter(|v| !v.is_empty()).cloned(),
    };
    let mut e = Obj::default();
    e.put(f[0], s(&time::iso(time::now_ms())))
        .put(f[1], s(defaults::text("devswarm_cli.log_component")))
        .put(f[2], s(op))
        .put(f[3], s(level))
        .put(f[4], repo.as_deref().map_or(OVal::Null, s))
        .put(f[5], mesh_id.map_or(OVal::Null, s))
        .put(f[6], n(f64::from(std::process::id())))
        .put(f[7], s(msg));
    if let Some(text) = err {
        let mut o = Obj::default();
        o.put(defaults::text("devswarm_cli.log_err_message"), s(text));
        e.put(f[8], o.done());
    }
    if !ctx.is_empty() {
        let mut o = Obj::default();
        for (k, v) in ctx {
            o.put(k, v);
        }
        e.put(f[9], o.done());
    }
    let line = format!("{}\n", e.done().stringify());
    write_line(&dir, &line);
    crate::meshw::note_written(&rel(), line.as_bytes());
}

/// Whether a manifest path is the central log.
pub fn is_log_rel(rel: &str) -> bool {
    rel == self::rel()
}

/// The directory the Node witness writes its log into: the scratch home's own, whatever the caller's environment says.
pub fn witness_dir(scratch_home: &std::path::Path) -> PathBuf {
    scratch_home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs"))
}

/// The log blanked where the engine and Node differ by design: the entry's timestamp and the writer's pid
/// (`devswarm_cli.log_masks`).
pub fn masked(text: &str) -> String {
    let (from, to) = (defaults::list("devswarm_cli.log_masks"), defaults::list("devswarm_cli.log_masks_to"));
    let mut out = text.to_string();
    for (pat, rep) in from.iter().zip(to.iter()) {
        if let Ok(re) = regex::Regex::new(&format!("(?m){pat}")) {
            out = re.replace_all(&out, regex::NoExpand(rep)).into_owned();
        }
    }
    out
}

/// What Node appended to a witness's copy of the log equals what the engine appended: `prior` is the copy's size before Node
/// ran. A file that is now shorter than that was rotated, so the whole of it is Node's.
pub fn delta_equal(after: &[u8], prior: u64, expected: &[u8]) -> bool {
    let from = if after.len() as u64 >= prior { prior as usize } else { 0 };
    masked(&String::from_utf8_lossy(&after[from..])) == masked(&String::from_utf8_lossy(expected))
}

/// The size of the witness's copy of the log before Node runs.
pub fn size_of(scratch_home: &std::path::Path) -> u64 {
    std::fs::metadata(witness_dir(scratch_home).join(defaults::text("devswarm_cli.log_file"))).map_or(0, |m| m.len())
}

/// `logVerbOutcome(op, id, r, ctx)` for a result `{ ok: false, error | reason }`: ONE error entry with the repo key of the
/// caller's directory (null outside a project), the verb's target id, the message and the refusal's reason.
pub fn refusal(inv: &Inv, op: &str, repo_key: Option<&str>, id: Option<&str>, msg: &str, reason: Option<&str>) {
    let mut ctx = Vec::new();
    if let Some(r) = reason {
        ctx.push((defaults::text("devswarm_cli.log_ctx_reason"), s(r)));
    }
    ctx.push((defaults::text("devswarm_cli.log_ctx_msg"), s(msg)));
    write_entry(inv, op, defaults::text("devswarm_cli.log_level_error"), Some(repo_key), id, msg, Some(msg), ctx);
}

/// `alog.logEvent('devswarm-cli', op, 'info', msg, ctx)`: an informational entry without an error payload; the repo key is
/// the environment's, as Node's `buildEntry` takes it when the caller names none.
pub fn event(inv: &Inv, op: &str, msg: &str, ctx: Vec<(&str, OVal)>) {
    write_entry(inv, op, defaults::text("devswarm_cli.log_level_info"), None, None, msg, None, ctx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::common::Inv;
    use std::collections::HashMap;

    fn inv(home: &std::path::Path, env: &[(&str, &str)]) -> Inv {
        Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            env: env.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect::<HashMap<_, _>>(),
            cwd: "/".into(),
            now: 0,
            stdin: None,
            store_override: None,
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-clog-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap_or_default();
        d
    }

    #[test]
    fn a_refusal_line_has_nodes_shape_and_key_order() {
        let home = scratch("shape");
        let i = inv(&home, &[]);
        refusal(&i, "inbox-read-primary", Some("repo-1"), Some("child-1"), "boom", Some("why"));
        let text = std::fs::read_to_string(home.join(".anti-hall/logs/devswarm.jsonl")).unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(text.trim_end()).unwrap_or_default();
        assert_eq!(v["component"], "devswarm-cli");
        assert_eq!(v["op"], "inbox-read-primary");
        assert_eq!(v["level"], "error");
        assert_eq!(v["repoKey"], "repo-1");
        assert_eq!(v["meshId"], "child-1");
        assert_eq!(v["pid"], std::process::id());
        assert_eq!(v["msg"], "boom");
        assert_eq!(v["err"]["message"], "boom");
        assert_eq!(v["ctx"]["reason"], "why");
        assert_eq!(v["ctx"]["msg"], "boom");
        let keys: Vec<&str> =
            ["\"ts\"", "\"component\"", "\"op\"", "\"level\"", "\"repoKey\"", "\"meshId\"", "\"pid\"", "\"msg\"", "\"err\"", "\"ctx\""].to_vec();
        let at: Vec<usize> = keys.iter().map(|k| text.find(k).unwrap_or(usize::MAX)).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "keys out of order: {text}");
    }

    #[test]
    fn a_missing_reason_and_repo_key_read_as_node_writes_them() {
        let home = scratch("null");
        let i = inv(&home, &[]);
        refusal(&i, "done", None, None, "m", None);
        let text = std::fs::read_to_string(home.join(".anti-hall/logs/devswarm.jsonl")).unwrap_or_default();
        assert!(text.contains("\"repoKey\":null,\"meshId\":null,"), "{text}");
        assert!(text.contains("\"ctx\":{\"msg\":\"m\"}"), "{text}");
    }

    #[test]
    fn an_event_has_no_error_and_takes_the_repo_key_from_the_environment() {
        let home = scratch("event");
        let i = inv(&home, &[("DEVSWARM_REPO_KEY", "env-key")]);
        event(&i, "unclaimed-session-promoted", "promoted", vec![("id", s("a")), ("to", s("b"))]);
        let text = std::fs::read_to_string(home.join(".anti-hall/logs/devswarm.jsonl")).unwrap_or_default();
        assert!(text.contains("\"level\":\"info\",\"repoKey\":\"env-key\",\"meshId\":null,"), "{text}");
        assert!(!text.contains("\"err\""), "{text}");
        assert!(text.contains("\"ctx\":{\"id\":\"a\",\"to\":\"b\"}"), "{text}");
    }

    #[test]
    fn the_log_directory_override_wins_and_a_test_context_without_one_defers() {
        let home = scratch("env");
        let dir = home.join("elsewhere");
        let i = inv(&home, &[("ANTI_HALL_LOG_DIR", dir.to_str().unwrap_or_default())]);
        refusal(&i, "x", None, None, "m", None);
        assert!(dir.join("devswarm.jsonl").is_file());
        assert!(!home.join(".anti-hall/logs/devswarm.jsonl").exists());
        assert!(ready(&inv(&home, &[("NODE_TEST_CONTEXT", "child-v8")])).is_err());
        assert!(ready(&inv(&home, &[("NODE_TEST_CONTEXT", "child-v8"), ("ANTI_HALL_LOG_DIR", dir.to_str().unwrap_or_default())])).is_ok());
    }

    #[test]
    fn a_full_file_is_rotated_to_dot_one_before_the_append() {
        let home = scratch("rotate");
        let dir = home.join(".anti-hall/logs");
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let fill = "x".repeat(defaults::num("devswarm_cli.log_max_bytes") as usize - 10);
        std::fs::write(dir.join("devswarm.jsonl"), format!("{fill}\n")).unwrap_or_default();
        std::fs::write(dir.join("devswarm.jsonl.1"), "older generation\n").unwrap_or_default();
        refusal(&inv(&home, &[]), "op", None, None, "m", None);
        let rotated = std::fs::read_to_string(dir.join("devswarm.jsonl.1")).unwrap_or_default();
        assert!(rotated.starts_with('x'), "the full file became the rotated generation, replacing the older one");
        let current = std::fs::read_to_string(dir.join("devswarm.jsonl")).unwrap_or_default();
        assert_eq!(current.lines().count(), 1);
        assert!(current.contains("\"op\":\"op\""));
        assert!(!dir.join("devswarm.jsonl.rotate.lock").exists(), "the lock is released");
    }
}
