//! Node-vs-engine parity for the built-in `devswarm-parent-inbox` and `devswarm-child-turn` checks.
//!
//! Each scenario seeds an isolated HOME (settings files), then runs the REAL Node hook and `ah-engine check <name>`
//! with the same environment and payload. The contract being proved:
//! - when the engine answers (exit 0, no output), the Node hook is silent too (exit 0, empty stdout and stderr) and left
//!   the home directory byte-for-byte unchanged, so answering natively loses nothing;
//! - when the engine defers (`AHFALLBACK`), the scenario is one the Node hook may act on; scenarios flagged `Act` must
//!   additionally make Node produce output or write state (so a check that always deferred would not pass);
//! - scenarios flagged `Silent` must be answered by the engine (a check that always deferred would fail).
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static HOME_ID: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Expect {
    /// The engine must answer natively (Node is silent).
    Silent,
    /// The engine must defer and Node must produce output or state.
    Act,
    /// The engine may do either; parity is checked whichever it does.
    Either,
}

struct Scenario {
    name: String,
    env: Vec<(&'static str, String)>,
    settings: Option<String>,
    claude_settings: Option<String>,
    payload: String,
    // expectation per hook: (parent, child)
    expect: (Expect, Expect),
}

fn good_payload() -> String {
    json!({"hook_event_name":"UserPromptSubmit","session_id":"s-1","prompt":"hello","cwd":std::env::temp_dir()}).to_string()
}

fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("ah-dsprompt-{tag}-{}-{nonce}-{}", std::process::id(), HOME_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(d.join(".claude")).unwrap();
    d
}

fn run(mut cmd: Command, input: &str) -> (i32, Vec<u8>, Vec<u8>) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let so = std::thread::spawn(move || {
        let mut b = Vec::new();
        stdout.read_to_end(&mut b).unwrap();
        b
    });
    let se = std::thread::spawn(move || {
        let mut b = Vec::new();
        stderr.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 60 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(5));
    };
    let _ = writer.join().unwrap();
    (status.code().unwrap_or(-1), so.join().unwrap(), se.join().unwrap())
}

/// Every file under `dir` (relative path -> bytes).
fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    let mut m = BTreeMap::new();
    walk(dir, dir, &mut m);
    m
}

fn base_cmd(prog: &str, home: &Path, env: &[(&'static str, String)]) -> Command {
    let mut c = Command::new(prog);
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("AH_ENGINE_DIR", home.join("engine"))
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in env {
        c.env(k, v);
    }
    c
}

fn seed(home: &Path, s: &Scenario) {
    if let Some(t) = &s.settings {
        std::fs::write(home.join(".anti-hall/settings.json"), t).unwrap();
    }
    if let Some(t) = &s.claude_settings {
        std::fs::write(home.join(".claude/settings.json"), t).unwrap();
    }
}

fn scenarios() -> Vec<Scenario> {
    let mut out: Vec<Scenario> = Vec::new();
    let repo = ("DEVSWARM_REPO_ID", "repo-1".to_string());
    let branch = ("DEVSWARM_SOURCE_BRANCH", "feature/x".to_string());
    let builder = ("DEVSWARM_BUILDER_ID", "child-1".to_string());
    let mut add = |name: &str, env: Vec<(&'static str, String)>, settings: Option<&str>, claude: Option<&str>, payload: String, expect: (Expect, Expect)| {
        out.push(Scenario { name: name.into(), env, settings: settings.map(str::to_string), claude_settings: claude.map(str::to_string), payload, expect });
    };
    use Expect::{Act, Either, Silent};
    let g = good_payload;

    // no DevSwarm at all: both hooks silent
    add("plain-session", vec![], None, None, g(), (Silent, Silent));
    // Primary: parent acts, child silent
    add("primary-active", vec![repo.clone()], None, None, g(), (Act, Silent));
    // child: parent silent, child acts
    add("child-active", vec![repo.clone(), branch.clone(), builder.clone()], None, None, g(), (Silent, Act));
    add("source-branch-only-auto-inactive", vec![branch.clone()], None, None, g(), (Silent, Silent));
    add("blank-repo-id", vec![("DEVSWARM_REPO_ID", "  \t".into())], None, None, g(), (Silent, Silent));
    add("blank-source-branch", vec![repo.clone(), ("DEVSWARM_SOURCE_BRANCH", " ".into())], None, None, g(), (Act, Silent));
    add("repo-id-unicode", vec![("DEVSWARM_REPO_ID", "r\u{e9}po-\u{1F600}".into())], None, None, g(), (Act, Silent));
    // kill switch
    add("kill-switch", vec![repo.clone(), ("DISABLE_ANTIHALL_DEVSWARM", "1".into())], None, None, g(), (Silent, Silent));
    add("kill-switch-child", vec![repo.clone(), branch.clone(), ("DISABLE_ANTIHALL_DEVSWARM", "1".into())], None, None, g(), (Silent, Silent));
    add("kill-switch-not-one", vec![repo.clone(), ("DISABLE_ANTIHALL_DEVSWARM", "0".into())], None, None, g(), (Act, Silent));
    add("kill-switch-true-word", vec![repo.clone(), ("DISABLE_ANTIHALL_DEVSWARM", "true".into())], None, None, g(), (Act, Silent));
    // supervisor mode via env
    add("mode-off-env", vec![repo.clone(), ("ANTIHALL_DEVSWARM_SUPERVISOR", "off".into())], None, None, g(), (Silent, Silent));
    add("mode-off-env-spaced-upper", vec![repo.clone(), ("ANTIHALL_DEVSWARM_SUPERVISOR", "  OFF ".into())], None, None, g(), (Silent, Silent));
    add("mode-on-env-no-repo", vec![("ANTIHALL_DEVSWARM_SUPERVISOR", "on".into())], None, None, g(), (Act, Silent));
    add("mode-on-env-child-no-repo", vec![("ANTIHALL_DEVSWARM_SUPERVISOR", "on".into()), branch.clone(), builder.clone()], None, None, g(), (Silent, Act));
    add("mode-garbage-env-with-repo", vec![repo.clone(), ("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe".into())], None, None, g(), (Act, Silent));
    add("mode-auto-env-no-repo", vec![("ANTIHALL_DEVSWARM_SUPERVISOR", "auto".into())], None, None, g(), (Silent, Silent));
    add(
        "mode-env-beats-file",
        vec![repo.clone(), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on".into())],
        Some(r#"{"devswarm":{"supervisorMode":"off"}}"#),
        None,
        g(),
        (Act, Silent),
    );
    // supervisor mode via settings.json / plugin options
    add("mode-off-file", vec![repo.clone()], Some(r#"{"devswarm":{"supervisorMode":"off"}}"#), None, g(), (Silent, Silent));
    add("mode-on-file-no-repo", vec![], Some(r#"{"devswarm":{"supervisorMode":"on"}}"#), None, g(), (Act, Silent));
    add("mode-file-number", vec![repo.clone()], Some(r#"{"devswarm":{"supervisorMode":0}}"#), None, g(), (Act, Silent));
    add("mode-file-bad-word-falls-through", vec![repo.clone()], Some(r#"{"devswarm":{"supervisorMode":"zzz"}}"#), None, g(), (Act, Silent));
    add("mode-off-plugin-option-env", vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off".into())], None, None, g(), (Silent, Silent));
    add("mode-auto-plugin-option-env", vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto".into())], None, None, g(), (Act, Silent));
    add(
        "mode-off-plugin-option-stored",
        vec![repo.clone()],
        None,
        Some(r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_supervisor_mode":"off"}}}}"#),
        g(),
        (Silent, Silent),
    );
    add(
        "mode-off-plugin-option-stored-flat",
        vec![repo.clone()],
        None,
        Some(r#"{"pluginConfigs":{"anti-hall@anti-hall":{"devswarm_supervisor_mode":"off"}}}"#),
        g(),
        (Silent, Silent),
    );
    add(
        "mode-file-beats-plugin-option",
        vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off".into())],
        Some(r#"{"devswarm":{"supervisorMode":"on"}}"#),
        None,
        g(),
        (Act, Silent),
    );
    add("settings-file-corrupt", vec![repo.clone()], Some("{not json"), None, g(), (Act, Silent));
    add("settings-file-array", vec![repo.clone()], Some("[1,2]"), None, g(), (Act, Silent));
    add("claude-settings-corrupt", vec![repo.clone()], None, Some("{{{"), g(), (Act, Silent));
    // judge child
    add("judge-child", vec![repo.clone(), ("ANTIHALL_JUDGE_CHILD", "1".into())], None, None, g(), (Silent, Silent));
    add("judge-child-child", vec![repo.clone(), branch.clone(), ("ANTIHALL_JUDGE_CHILD", "1".into())], None, None, g(), (Silent, Silent));
    add("judge-zero", vec![repo.clone(), ("ANTIHALL_JUDGE_CHILD", "0".into())], None, None, g(), (Act, Silent));
    // hook switches
    add("parent-switch-off-file", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":false}}"#), None, g(), (Silent, Silent));
    add("parent-switch-off-word", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":"off"}}"#), None, g(), (Silent, Silent));
    add("parent-switch-off-zero-string", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":"0"}}"#), None, g(), (Silent, Silent));
    add("parent-switch-off-zero-number", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":0}}"#), None, g(), (Silent, Silent));
    add("parent-switch-on-explicit", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":true}}"#), None, g(), (Act, Silent));
    add("parent-switch-garbage-stays-on", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":"maybe"}}"#), None, g(), (Act, Silent));
    add("parent-switch-null-stays-on", vec![repo.clone()], Some(r#"{"devswarm":{"parentInbox":null}}"#), None, g(), (Act, Silent));
    add("parent-switch-off-plugin-env", vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_INBOX", "false".into())], None, None, g(), (Silent, Silent));
    add(
        "parent-switch-default-plugin-env-is-unset",
        vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_INBOX", "true".into())],
        None,
        None,
        g(),
        (Act, Silent),
    );
    add(
        "parent-switch-off-plugin-stored",
        vec![repo.clone()],
        None,
        Some(r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_parent_inbox":false}}}}"#),
        g(),
        (Silent, Silent),
    );
    add(
        "parent-switch-file-beats-plugin",
        vec![repo.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_INBOX", "false".into())],
        Some(r#"{"devswarm":{"parentInbox":true}}"#),
        None,
        g(),
        (Act, Silent),
    );
    add("child-switch-off-file", vec![repo.clone(), branch.clone(), builder.clone()], Some(r#"{"devswarm":{"childTurn":false}}"#), None, g(), (Silent, Silent));
    add("child-switch-off-word", vec![repo.clone(), branch.clone(), builder.clone()], Some(r#"{"devswarm":{"childTurn":"no"}}"#), None, g(), (Silent, Silent));
    add(
        "child-switch-off-plugin-env",
        vec![repo.clone(), branch.clone(), builder.clone(), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_TURN", "0".into())],
        None,
        None,
        g(),
        (Silent, Silent),
    );
    add(
        "child-switch-off-plugin-stored",
        vec![repo.clone(), branch.clone(), builder.clone()],
        None,
        Some(r#"{"pluginConfigs":{"anti-hall":{"devswarm_child_turn":"false"}}}"#),
        g(),
        (Silent, Silent),
    );
    add(
        "child-switch-on-parent-off",
        vec![repo.clone(), branch.clone(), builder.clone()],
        Some(r#"{"devswarm":{"parentInbox":false}}"#),
        None,
        g(),
        (Silent, Act),
    );
    add("parent-switch-on-child-off", vec![repo.clone()], Some(r#"{"devswarm":{"childTurn":false}}"#), None, g(), (Act, Silent));
    // payload variants on an active Primary / child and on a plain session: the gate never reads the payload
    for (tag, payload) in [
        ("empty-stdin", String::new()),
        ("not-json", "this is not json".to_string()),
        ("json-null", "null".to_string()),
        ("json-array", "[]".to_string()),
        ("json-empty-object", "{}".to_string()),
        ("missing-cwd", json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"p"}).to_string()),
        ("nonexistent-cwd", json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"p","cwd":"/nonexistent/zzz/qq"}).to_string()),
        ("cwd-wrong-type", json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"p","cwd":7}).to_string()),
        (
            "unicode-prompt",
            json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"\u{4f60}\u{597d} \u{1F600} \u{202e}","cwd":std::env::temp_dir()})
                .to_string(),
        ),
        ("huge-prompt", json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"x".repeat(300_000),"cwd":std::env::temp_dir()}).to_string()),
        ("lone-surrogate-escape", r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"\ud800","cwd":"/tmp"}"#.to_string()),
        ("trailing-garbage", format!("{} trailing", good_payload())),
    ] {
        add(&format!("plain-{tag}"), vec![], None, None, payload.clone(), (Either, Either));
        add(&format!("primary-{tag}"), vec![repo.clone()], None, None, payload.clone(), (Either, Either));
        add(&format!("child-{tag}"), vec![repo.clone(), branch.clone(), builder.clone()], None, None, payload, (Either, Either));
    }
    out
}

const NAMES: [(&str, &str); 2] = [("devswarm-parent-inbox", "devswarm-parent-inbox.js"), ("devswarm-child-turn", "devswarm-child-turn.js")];

#[test]
fn engine_and_node_agree_on_every_scenario() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let all = scenarios();
    let (mut rows, mut native, mut deferred, mut acted) = (0, 0, 0, 0);
    let mut problems: Vec<String> = Vec::new();
    for (hook_ix, (check, file)) in NAMES.iter().enumerate() {
        for s in &all {
            rows += 1;
            let want = if hook_ix == 0 { s.expect.0 } else { s.expect.1 };
            let home = temp_home("n");
            seed(&home, s);
            let before = snapshot(&home);
            let mut node = base_cmd("node", &home, &s.env);
            node.arg(repo.join("plugins/anti-hall/hooks").join(file));
            let (ncode, nout, nerr) = run(node, &s.payload);
            let after = snapshot(&home);
            let state_changed = before != after;
            let node_silent = ncode == 0 && nout.is_empty() && nerr.is_empty() && !state_changed;

            let ehome = temp_home("e");
            seed(&ehome, s);
            let mut eng = base_cmd(env!("CARGO_BIN_EXE_ah-engine"), &ehome, &s.env);
            eng.arg("check").arg(check);
            let (ecode, eout, _) = run(eng, &s.payload);
            let answered = ecode == 0 && eout.is_empty();
            let deferred_out = String::from_utf8_lossy(&eout).trim() == "AHFALLBACK";
            let label = format!("[{check}] {}", s.name);
            if !answered && !deferred_out {
                problems.push(format!("{label}: engine gave neither an answer nor a deferral (code {ecode}, out {:?})", String::from_utf8_lossy(&eout)));
                continue;
            }
            if answered {
                native += 1;
                if !node_silent {
                    problems.push(format!(
                        "{label}: engine answered but Node acted (code {ncode}, out {:?}, state changed {state_changed})",
                        String::from_utf8_lossy(&nout)
                    ));
                }
                if want == Expect::Act {
                    problems.push(format!("{label}: engine answered a scenario Node must act on"));
                }
            } else {
                deferred += 1;
                if want == Expect::Silent {
                    problems.push(format!("{label}: engine deferred a scenario that must be answered natively"));
                }
                if want == Expect::Act {
                    if node_silent {
                        problems.push(format!("{label}: scenario flagged Act but Node was silent (vacuous row)"));
                    } else {
                        acted += 1;
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&home);
            let _ = std::fs::remove_dir_all(&ehome);
        }
    }
    eprintln!("rows {rows}: engine answered {native}, deferred {deferred} (Node acted in {acted} flagged rows)");
    assert!(problems.is_empty(), "{} mismatches:\n{}", problems.len(), problems.join("\n"));
    assert!(rows >= 60 && native >= 40 && acted >= 4, "corpus too small or vacuous: rows {rows}, native {native}, acted {acted}");
}

#[test]
fn the_manifest_default_of_the_supervisor_option_is_the_one_the_gate_assumes() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let pj: Value = serde_json::from_str(&std::fs::read_to_string(repo.join("plugins/anti-hall/.claude-plugin/plugin.json")).unwrap()).unwrap();
    let d = &pj["userConfig"]["devswarm_supervisor_mode"]["default"];
    assert_eq!(d, &json!("auto"), "defaults/small_guards.toml devswarm_prompt.mode_setting.manifest_default must follow the plugin manifest");
}
