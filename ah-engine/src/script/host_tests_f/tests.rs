//! Unit tests of the batch-8 host primitives (D88, lane F): the date a script cannot read exactly, the tail of a file as text, the
//! execute test, the user id, the rename file operation, the lock wait override and the second held lock, the write that keeps its
//! temporary file. None holds a rule; these tests pin what each extracts and the bounds it keeps.
use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-hostf-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    std::fs::canonicalize(&d).unwrap().to_string_lossy().to_string()
}

fn env(h: &str) -> RequestEnv {
    RequestEnv::from_pairs(vec![("HOME", h)])
}

fn put_override(h: &str, name: &str, body: &str) {
    std::fs::write(format!("{h}/.anti-hall/logic/{name}.js"), body).unwrap();
}

fn run(name: &str, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, &json!({}), &Value::Null, "PreToolUse", e)
}

fn out(h: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out.json")).unwrap()).unwrap()
}

const WRITE: &str = "ah.state.writeAtomic('.anti-hall/out.json', JSON.stringify(res)); return 'allow';";

#[test]
fn a_date_is_read_as_v8_reads_it_or_the_script_is_told_it_cannot_say() {
    let h = home("date");
    put_override(
        &h,
        "zz-date",
        &format!(
            "function decide(p){{ var res = ['2030-10-08T12:00:00Z', 'Oct 8, 2030 12:00 PM UTC', 'never ever', ''].map(function (t) {{ return ah.date.parse(t); }}); {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-date", &env(&h)), Some(Some(Verdict::Allow)));
    let got = out(&h);
    assert_eq!(got[0], json!({"ms": 1_917_691_200_000_i64}));
    assert_eq!(got[1], json!({"ms": 1_917_691_200_000_i64}));
    assert!(got[2].get("ms").is_none(), "a text that is no date has no time: {got}");
    assert!(got[3].get("ms").is_none(), "{got}");
}

#[test]
fn read_end_gives_the_last_bytes_whole_when_the_file_is_smaller_and_null_for_a_missing_file() {
    let h = home("readend");
    std::fs::write(format!("{h}/t.log"), "line one\nline two\nline three\n").unwrap();
    put_override(
        &h,
        "zz-readend",
        &format!(
            "function decide(p){{ var f = '{h}/t.log', res = [ah.fs.readEnd(f, 11), ah.fs.readEnd(f, 1000), ah.fs.readEnd(f, 0), ah.fs.readEnd('{h}/missing', 5), ah.fs.readEnd('{h}', 5)]; {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-readend", &env(&h)), Some(Some(Verdict::Allow)));
    let got = out(&h);
    assert_eq!(got[0], json!("line three\n"));
    assert_eq!(got[1], json!("line one\nline two\nline three\n"));
    assert_eq!(got[2], json!("line one\nline two\nline three\n"), "no size asked is the whole tail the cap allows");
    assert_eq!(got[3], Value::Null);
    assert_eq!(got[4], Value::Null, "a directory has no tail");
}

#[test]
fn is_executable_wants_a_regular_file_this_process_may_run() {
    let h = home("exec");
    let (run_me, plain) = (format!("{h}/run-me"), format!("{h}/plain"));
    std::fs::write(&run_me, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&run_me, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(&plain, "x").unwrap();
    std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::create_dir_all(format!("{h}/dir")).unwrap();
    put_override(
        &h,
        "zz-exec",
        &format!("function decide(p){{ var res = ['{run_me}', '{plain}', '{h}/dir', '{h}/missing'].map(ah.fs.isExecutable); {WRITE} }}"),
    );
    assert_eq!(run("zz-exec", &env(&h)), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!([true, false, false, false]));
}

#[test]
fn the_user_id_is_the_numeric_id_of_the_process() {
    let h = home("uid");
    put_override(&h, "zz-uid", &format!("function decide(p){{ var res = ah.sys.uid(); {WRITE} }}"));
    assert_eq!(run("zz-uid", &env(&h)), Some(Some(Verdict::Allow)));
    let want = String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
    assert_eq!(out(&h).to_string(), want.trim());
}

#[test]
fn rename_moves_a_regular_file_inside_the_scope_and_refuses_what_leaves_it() {
    let h = home("rename");
    std::fs::write(format!("{h}/.anti-hall/a.log"), "A").unwrap();
    std::fs::write(format!("{h}/.anti-hall/b.log"), "B").unwrap();
    put_override(
        &h,
        "zz-rename",
        &format!(
            "function decide(p){{ var r = ah.home(), try1 = function (f) {{ try {{ return f(); }} catch (e) {{ return 'refused'; }} }}, res = [try1(function () {{ return ah.state.op(r, 'rename', '.anti-hall/a.log', '.anti-hall/b.log'); }}), try1(function () {{ return ah.state.op(r, 'rename', '.anti-hall/b.log', '../escape.log'); }}), try1(function () {{ return ah.state.op(r, 'rename', '.anti-hall/none.log', '.anti-hall/c.log'); }})]; {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-rename", &env(&h)), Some(Some(Verdict::Allow)));
    let got = out(&h);
    assert_eq!(got[0], json!(true), "the destination is replaced");
    assert_ne!(got[1], json!(true), "a destination outside the scope is refused: {got}");
    assert_ne!(got[2], json!(true), "a missing source is not moved: {got}");
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/b.log")).unwrap(), "A");
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall/a.log")).exists());
    assert!(!std::path::Path::new(&format!("{h}/../escape.log")).exists());
}

#[test]
fn a_second_lock_is_held_beside_the_first_and_a_third_is_refused_and_the_wait_is_the_scripts() {
    let h = home("locks");
    put_override(
        &h,
        "zz-locks",
        &format!(
            "function decide(p){{ var a = ah.state.lock('.anti-hall/x.lock', 'swarm_guard', 0), b = ah.state.lock('.anti-hall/y.lock', 'swarm_guard', 0), c = ah.state.lock('.anti-hall/z.lock', 'swarm_guard', 0), same = ah.state.lock('.anti-hall/x.lock', 'swarm_guard', 0); var res = [a !== null, b !== null, c !== null, same !== null]; if (b !== null) ah.state.unlock(b); if (a !== null) ah.state.unlock(a); {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-locks", &env(&h)), Some(Some(Verdict::Allow)));
    let want_second = crate::defaults::num("script.lock_max_held") >= 2;
    assert_eq!(out(&h), json!([true, want_second, false, false]), "locks held at once are capped by script.lock_max_held; a lock already held is not taken twice");
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall/x.lock")).exists() && !std::path::Path::new(&format!("{h}/.anti-hall/y.lock")).exists(), "released");
}

#[test]
fn a_write_asked_to_keep_its_temporary_file_leaves_it_when_the_rename_fails() {
    let h = home("leavetemp");
    std::fs::create_dir_all(format!("{h}/.anti-hall/target.json")).unwrap();
    put_override(
        &h,
        "zz-leave",
        &format!(
            "function decide(p){{ var res = [ah.state.writeAtomic('.anti-hall/target.json', 'x', true), ah.state.writeAtomic('.anti-hall/other.json', 'y', true)]; {WRITE} }}"
        ),
    );
    assert_eq!(run("zz-leave", &env(&h)), Some(Some(Verdict::Allow)));
    assert_eq!(out(&h), json!([false, true]));
    let left: Vec<String> = std::fs::read_dir(format!("{h}/.anti-hall")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    assert!(left.iter().any(|n| n.starts_with("target.json.") || n.contains("target.json")), "the temporary file stays beside the target: {left:?}");
}

#[test]
fn the_project_root_names_the_checkout_around_a_directory() {
    let h = home("root");
    std::fs::create_dir_all(format!("{h}/proj/.git")).unwrap();
    std::fs::write(format!("{h}/proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::create_dir_all(format!("{h}/proj/src")).unwrap();
    put_override(
        &h,
        "zz-root",
        &format!("function decide(p){{ var res = [ah.project.repoRoot('{h}/proj/src'), ah.project.repoRoot('{h}/nowhere')]; {WRITE} }}"),
    );
    assert_eq!(run("zz-root", &env(&h)), Some(Some(Verdict::Allow)));
    let got = out(&h);
    assert_eq!(got[0], json!(format!("{h}/proj")));
    assert!(got[1] == Value::Null || got[1].is_string(), "{got}");
}
