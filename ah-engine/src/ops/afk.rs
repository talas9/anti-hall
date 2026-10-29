//! `ah-engine afk on|off|status` and `ah-engine back` (GH #425): the machine-wide AFK flag file the `afk-mode` check reads, and the
//! digest of each session's progress file since its AFK marker. The digest is rendered by the plugin script (`afkDigest` in
//! `engine/logic/afk-mode.js`), so the command and the typed `back` print the same thing. Counts this process cannot add to the
//! daemon's metrics (`afk_entered`, `digest_entries`) are left in the flag file for the next hook to add. Every name and text:
//! `afk.toml`.
use super::{env_snapshot, err, home, out};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// The per-user state directory the check writes under (`<home>/<replykit.state_dir>`).
fn state_dir(home: &str) -> PathBuf {
    Path::new(home).join(defaults::text("replykit.state_dir"))
}

fn flag_path(home: &str) -> PathBuf {
    state_dir(home).join(defaults::text("afk.flag_file"))
}

fn read_json(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn write_flag(home: &str, flag: &Map<String, Value>) -> bool {
    let path = flag_path(home);
    let res = std::fs::create_dir_all(state_dir(home)).and_then(|()| crate::atomic::write(&path, Value::Object(flag.clone()).to_string()));
    match res {
        Ok(()) => true,
        Err(e) => {
            err(&(defaults::render("afk.msg_write_failed", &[("path", &path.display()), ("why", &e)]) + "\n"));
            false
        }
    }
}

fn is_on(flag: Option<&Map<String, Value>>) -> bool {
    flag.and_then(|f| f.get("on")).and_then(Value::as_bool) == Some(true)
}

fn field(flag: &Map<String, Value>, key: &str) -> String {
    match flag.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

fn since(flag: &Map<String, Value>) -> String {
    let ms = flag.get("since").and_then(Value::as_i64).unwrap_or_default();
    crate::checks::taskkit::time::iso(ms)
}

fn now_ms() -> i64 {
    crate::checks::taskkit::time::now_ms()
}

/// Print `text` (and a JSON object with it under `--json`).
fn say(p: &Parsed, text: &str, extra: Value) {
    if p.json {
        let mut v = extra;
        if let Value::Object(m) = &mut v {
            m.insert("text".into(), Value::String(text.to_string()));
        }
        out(&(v.to_string() + "\n"));
    } else {
        out(&(text.to_string() + "\n"));
    }
}

/// Run `f` under the flag's cross-process lock (`afk.lock_file`, the lock the hooks take for every flag update), so the flag is
/// read and written with no hook in between. When the lock cannot be taken in `afk.lock_wait_ms` the command runs anyway: the
/// owner's command wins, and a hook that cannot take the lock writes nothing.
fn locked<T>(home: &str, f: impl FnOnce() -> T) -> T {
    let path = state_dir(home).join(defaults::text("afk.lock_file"));
    let held = std::fs::create_dir_all(state_dir(home))
        .ok()
        .and(crate::checks::guardkit::nodelock::Params::from_group("afk"))
        .and_then(|params| crate::checks::guardkit::nodelock::acquire(&path.to_string_lossy(), params));
    let r = f();
    if let Some(h) = held
        && !h.release()
    {
        err(&(defaults::render("afk.msg_write_failed", &[("path", &path.display()), ("why", &defaults::text("afk.msg_lock_released"))]) + "\n"));
    }
    r
}

/// The owner ran `afk off` / `back`: they are present now, so idle detection does not start a new AFK right after.
fn mark_present(home: &str) {
    let path = state_dir(home).join(defaults::text("afk.presence_file"));
    if let Err(e) = crate::atomic::write(&path, json!({"last": now_ms()}).to_string()) {
        err(&(defaults::render("afk.msg_write_failed", &[("path", &path.display()), ("why", &e)]) + "\n"));
    }
}

/// Start AFK (manual); `false` when the flag could not be written.
fn turn_on(p: &Parsed, home: &str) -> i32 {
    locked(home, || turn_on_locked(p, home))
}

fn turn_on_locked(p: &Parsed, home: &str) -> i32 {
    let cur = read_json(&flag_path(home));
    if let Some(f) = cur.as_ref().filter(|f| is_on(Some(f))) {
        say(p, &defaults::render("afk.msg_already", &[("how", &field(f, "how")), ("since", &since(f))]), json!({"on": true}));
        return 0;
    }
    let now = now_ms();
    let how = defaults::text("afk.how_manual");
    let mut f = Map::new();
    f.insert("on".into(), Value::Bool(true));
    f.insert("how".into(), Value::String(how.to_string()));
    f.insert("since".into(), json!(now));
    f.insert("epoch".into(), Value::String(now.to_string()));
    f.insert("counted".into(), Value::Bool(false));
    for k in ["pending_digest", "pending_parked"] {
        if let Some(n) = cur.as_ref().and_then(|c| c.get(k)).cloned() {
            f.insert(k.into(), n);
        }
    }
    if !write_flag(home, &f) {
        return 1;
    }
    say(p, &defaults::render("afk.msg_on", &[("how", &how)]), json!({"on": true}));
    0
}

/// The progress files the sessions of the current AFK period recorded (their `afk-sess-*` state files), bounded.
fn session_files(home: &str, epoch: &str) -> Vec<Value> {
    let prefix = defaults::text("afk.session_prefix");
    let max_files = defaults::num("afk.digest_max_files") as usize;
    let max_bytes = defaults::num("afk.read_max_bytes");
    let mut names: Vec<String> = std::fs::read_dir(state_dir(home))
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(prefix)).collect())
        .unwrap_or_default();
    names.sort();
    let mut seen = std::collections::BTreeSet::new();
    let mut files = Vec::new();
    for n in names {
        if files.len() >= max_files {
            break;
        }
        let Some(s) = read_json(&state_dir(home).join(&n)) else { continue };
        let progress = field(&s, "progress");
        if field(&s, "epoch") != epoch || progress.is_empty() || !seen.insert(progress.clone()) {
            continue;
        }
        files.push(json!({"path": progress, "text": tail_text(Path::new(&progress), max_bytes)}));
    }
    files
}

/// The last `max` bytes of a file as text, `null` when it cannot be read.
fn tail_text(path: &Path, max: u64) -> Value {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return Value::Null };
    let len = f.metadata().map(|m| m.len()).unwrap_or_default();
    if len > max && f.seek(SeekFrom::Start(len - max)).is_err() {
        return Value::Null;
    }
    let mut b = Vec::new();
    if f.read_to_end(&mut b).is_err() {
        return Value::Null;
    }
    Value::String(String::from_utf8_lossy(&b).into_owned())
}

/// The digest text, entry count and NEEDS OWNER bullet count of the AFK period `epoch` (the plugin script renders it).
pub(crate) fn digest(home: &str, epoch: &str) -> (String, u64, u64) {
    let cfg: Map<String, Value> =
        defaults::with_prefix("afk.").into_iter().filter_map(|e| e.key.strip_prefix("afk.").map(|k| (k.to_string(), e.value.to_json()))).collect();
    let input = json!({"cfg": Value::Object(cfg), "files": session_files(home, epoch)});
    match super::opcli_call("back", "afk-mode", "afkDigest", &input) {
        Some(v) => (
            v.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
            v.get("entries").and_then(Value::as_u64).unwrap_or_default(),
            v.get("parked").and_then(Value::as_u64).unwrap_or_default(),
        ),
        None => (defaults::text("afk.msg_no_sessions").to_string(), 0, 0),
    }
}

/// End AFK; with `print_digest`, print the digest of the period that ended (or of the last one). Owner presence is refreshed.
fn turn_off(p: &Parsed, home: &str, print_digest: bool) -> i32 {
    locked(home, || turn_off_locked(p, home, print_digest))
}

fn turn_off_locked(p: &Parsed, home: &str, print_digest: bool) -> i32 {
    mark_present(home);
    let Some(mut f) = read_json(&flag_path(home)) else {
        say(p, defaults::text("afk.msg_not_on"), json!({"on": false}));
        return 0;
    };
    let was_on = is_on(Some(&f));
    let head = if was_on {
        defaults::render("afk.msg_off", &[("how", &field(&f, "how")), ("since", &since(&f))])
    } else {
        defaults::text("afk.msg_not_on").to_string()
    };
    f.insert("on".into(), Value::Bool(false));
    if was_on {
        f.insert("ended".into(), json!(now_ms()));
    }
    let mut text = head;
    if print_digest {
        let (d, n, parked) = digest(home, &field(&f, "epoch"));
        let pending = f.get("pending_digest").and_then(Value::as_u64).unwrap_or_default();
        f.insert("pending_digest".into(), json!(pending + n));
        let pending_parked = f.get("pending_parked").and_then(Value::as_u64).unwrap_or_default();
        f.insert("pending_parked".into(), json!(pending_parked + parked));
        text = format!("{text}\n{d}");
    }
    if (was_on || print_digest) && !write_flag(home, &f) {
        return 1;
    }
    say(p, &text, json!({"on": false}));
    0
}

/// `afk on|off|status`
pub fn cmd_afk(p: &Parsed) -> i32 {
    let env = env_snapshot();
    let home = home(&env);
    if home.is_empty() {
        err(&(defaults::text("afk.msg_usage").to_string() + "\n"));
        return 2;
    }
    match p.rest.first().map(String::as_str) {
        Some("on") => turn_on(p, &home),
        Some("off") => turn_off(p, &home, false),
        Some("status") => {
            let f = read_json(&flag_path(&home));
            match f.as_ref().filter(|f| is_on(Some(f))) {
                Some(f) => say(
                    p,
                    &defaults::render("afk.msg_status_on", &[("how", &field(f, "how")), ("since", &since(f))]),
                    json!({"on": true, "how": field(f, "how")}),
                ),
                None => say(p, defaults::text("afk.msg_status_off"), json!({"on": false})),
            }
            0
        }
        _ => {
            err(&(defaults::text("afk.msg_usage").to_string() + "\n"));
            2
        }
    }
}

/// `back`: end AFK and print the digest.
pub fn cmd_back(p: &Parsed) -> i32 {
    let env = env_snapshot();
    let home = home(&env);
    if home.is_empty() {
        err(&(defaults::text("afk.msg_usage").to_string() + "\n"));
        return 2;
    }
    turn_off(p, &home, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-afk-cli-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover of an earlier run; absent is the goal state
        std::fs::create_dir_all(&d).expect("scratch home");
        d
    }

    fn parsed(cmd: &str, rest: &[&str]) -> Parsed {
        Parsed { command: cmd.into(), json: false, rest: rest.iter().map(|s| s.to_string()).collect(), raw: Vec::new() }
    }

    #[test]
    fn on_status_back_round_trip_in_a_scratch_home() {
        let dir = scratch("round");
        let home = dir.to_string_lossy().into_owned();
        assert_eq!(turn_on(&parsed("afk", &["on"]), &home), 0);
        let f = read_json(&flag_path(&home)).expect("flag written");
        assert!(is_on(Some(&f)));
        assert_eq!(field(&f, "how"), defaults::text("afk.how_manual"));
        assert_eq!(f.get("counted"), Some(&Value::Bool(false)), "the next hook counts afk_entered");
        // a second `on` keeps the period
        assert_eq!(turn_on(&parsed("afk", &["on"]), &home), 0);
        assert_eq!(field(&read_json(&flag_path(&home)).expect("flag"), "epoch"), field(&f, "epoch"));
        // a session of this period with a progress file: `back` ends AFK and leaves the digest count for the next hook
        let prog = dir.join("p.md");
        std::fs::write(&prog, format!("# p\n- [x] old\n<!-- afk:{e} -->\n## AFK\n- [x] one\n- [ ] two\n", e = field(&f, "epoch"))).expect("write");
        let sess = state_dir(&home).join(format!("{}s1.json", defaults::text("afk.session_prefix")));
        std::fs::write(&sess, json!({"epoch": field(&f, "epoch"), "progress": prog.to_string_lossy()}).to_string()).expect("write");
        let files = session_files(&home, &field(&f, "epoch"));
        assert_eq!(files.len(), 1);
        assert_eq!(turn_off(&parsed("back", &[]), &home, false), 0);
        let g = read_json(&flag_path(&home)).expect("flag");
        assert!(!is_on(Some(&g)));
    }

    #[test]
    fn afk_off_refreshes_owner_presence_so_idle_detection_does_not_re_enter_afk() {
        let dir = scratch("presence");
        let home = dir.to_string_lossy().into_owned();
        assert_eq!(turn_on(&parsed("afk", &["on"]), &home), 0);
        let pres = state_dir(&home).join(defaults::text("afk.presence_file"));
        std::fs::write(&pres, json!({"last": 0}).to_string()).expect("write");
        assert_eq!(turn_off(&parsed("afk", &["off"]), &home, false), 0);
        let last = read_json(&pres).and_then(|m| m.get("last").and_then(Value::as_f64)).unwrap_or_default();
        assert!(last > 0.0, "the owner ran the command: presence is now");
        let env = crate::reqenv::RequestEnv::from_pairs(vec![("HOME".to_string(), home.clone())]);
        let p = json!({"hook_event_name": "PostToolUse", "session_id": "s1", "cwd": home, "tool_name": "Bash"});
        crate::script::run_forced("afk-mode", &p, &Value::Null, "PostToolUse", &env);
        assert!(!is_on(read_json(&flag_path(&home)).as_ref()), "an old presence before `off` does not re-enter idle AFK");
    }

    #[test]
    fn back_without_a_flag_is_a_no_op() {
        let dir = scratch("noop");
        let home = dir.to_string_lossy().into_owned();
        assert_eq!(turn_off(&parsed("back", &[]), &home, true), 0);
        assert!(!flag_path(&home).exists(), "nothing written when AFK was never on");
    }
}
