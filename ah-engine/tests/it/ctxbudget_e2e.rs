//! The context-budget checks through the real dispatcher (`ah-engine hook --event <Event>`), with the Node hooks replaced
//! by shell commands in a `--fallback-map`: a quiet turn is answered by the engine without running any of them, and every
//! case the checks defer reaches the Node stand-in.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-ctxb-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        // These cases exercise the configured 85% threshold, independently of the shipped default.
        std::fs::write(dir.join("home/.anti-hall/settings.json"), r#"{"autoHandover":{"pct":85}}"#).unwrap();
        Env { dir }
    }

    /// A map that makes every Node hook of `event` silent, except the ones in `loud`, which print their id (stdout) or
    /// block (a Stop hook: stderr and exit 2).
    fn map(&self, event: &str, loud: &[&str], cmd: &str) -> PathBuf {
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> =
            ids.iter().map(|id| (id.clone(), if loud.contains(&id.as_str()) { cmd.replace("{id}", id) } else { "true".to_string() }.into())).collect();
        let p = self.dir.join(format!("{event}-map.json"));
        std::fs::write(&p, serde_json::json!({ event: m }).to_string()).unwrap();
        p
    }

    fn run(&self, event: &str, map: &Path, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "ctxbudget-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .envs(extra.iter().copied())
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    fn transcript(&self, tokens: u64) -> String {
        let line = serde_json::json!({"type":"assistant","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":tokens - 10,"cache_read_input_tokens":0},"content":[{"type":"text","text":"x"}]}});
        let p = self.dir.join("tr.jsonl");
        std::fs::write(&p, format!("{line}\n")).unwrap();
        p.to_string_lossy().to_string()
    }
}

/// A quiet prompt turn says nothing: the context-budget checks print an empty context, which the host skips, so the
/// dispatcher leaves it out instead of printing an empty field (`dispatch::combine::tidy`).
const QUIET_PROMPT: &str = "";

fn prompt(tr: &str) -> String {
    serde_json::json!({"session_id":"e2e","hook_event_name":"UserPromptSubmit","prompt":"x","cwd":"/tmp","transcript_path":tr}).to_string()
}

fn stop(tr: &str) -> String {
    serde_json::json!({"session_id":"e2e","hook_event_name":"Stop","stop_hook_active":false,"cwd":"/tmp","transcript_path":tr}).to_string()
}

const WINDOW: (&str, &str) = ("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000");

#[test]
fn a_quiet_prompt_is_answered_without_running_any_node_hook_and_adds_no_joiner() {
    let e = Env::new("ups-quiet");
    let loud = ["limit-conserve-inject", "auto-handover"];
    let map = e.map("UserPromptSubmit", &loud, "echo NODE-{id}");
    let tr = e.transcript(50_000);
    // with the verify-first reminder switched off the turn is no output at all
    let (code, out, err) = e.run(
        "UserPromptSubmit",
        &map,
        &prompt(&tr),
        &[WINDOW, ("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "false"), ("CLAUDE_PLUGIN_OPTION_CONTEXT_TASK_TRACKER", "false")],
    );
    assert_eq!((code, out.as_str(), err.as_str()), (0, QUIET_PROMPT, ""));
}

/// Regression for the empty-context rule of `dispatch::combine` (a quiet hook adds no joiner): on a quiet UserPromptSubmit turn
/// every check that answers natively (the context-budget gates print an empty context, the verify-first reminder prints a line,
/// the idle-agent sweep and the others print nothing) is combined into ONE context with no stray newline, whichever
/// reminder line the payload happens to pick.
#[test]
fn a_quiet_prompt_has_no_stray_newlines_whichever_checks_answer_natively() {
    let e = Env::new("ups-newlines");
    let map = e.map("UserPromptSubmit", &[], "true");
    let tr = e.transcript(50_000);
    let mut lines = std::collections::BTreeSet::new();
    for i in 0..40 {
        let p = serde_json::json!({"session_id": format!("nl{i}"), "hook_event_name": "UserPromptSubmit", "prompt": format!("p{i}"), "cwd": "/tmp", "transcript_path": tr}).to_string();
        let (code, out, err) = e.run("UserPromptSubmit", &map, &p, &[WINDOW, ("CLAUDE_PLUGIN_OPTION_CONTEXT_TASK_TRACKER", "false")]);
        assert_eq!((code, err.as_str()), (0, ""), "{out:?}");
        let v: serde_json::Value = serde_json::from_str(out.trim_end()).unwrap_or_else(|_| panic!("not JSON: {out:?}"));
        let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or_else(|| panic!("no context: {out:?}"));
        assert!(!ctx.contains("\n\n") && ctx == ctx.trim(), "stray newline in {ctx:?}");
        assert_eq!(out.matches('\n').count(), 1, "one JSON line, got {out:?}");
        lines.insert(ctx.to_string());
    }
    assert!(lines.len() > 1, "the payloads must reach more than one reminder line");
}

#[test]
fn a_prompt_fire_and_the_post_handover_gate_are_answered_by_the_scripts() {
    let e = Env::new("ups-defer");
    let loud = ["limit-conserve-inject", "auto-handover"];
    let map = e.map("UserPromptSubmit", &loud, "echo NODE-{id}");
    let tr = e.transcript(180_000); // 90 percent: the fire directive
    let (code, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert_eq!(code, 0);
    assert!(!out.contains("NODE-") && out.contains("handover: context is at ~90%"), "{out:?}");
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW, ("ANTIHALL_LIMIT_CONSERVE", "on")]);
    assert!(!out.contains("NODE-") && out.contains("limit conservation is active (manual-on)"), "{out:?}");
    // the post-handover gate on a prompt with text (it asks Jev without waiting, as Node does) is answered by the script too
    std::fs::create_dir_all(e.dir.join("home/.anti-hall/auto-handover")).unwrap();
    std::fs::write(e.dir.join("home/.anti-hall/auto-handover/e2e.json"), r#"{"fired":true,"firedPct":85,"lastNagPct":89,"handoverPct":80}"#).unwrap();
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert!(!out.contains("NODE-") && out.contains("new work exceeds the post-handover budget"), "{out:?}");
}

#[test]
fn a_quiet_stop_a_stop_fire_and_a_relative_transcript_are_answered_by_the_engine() {
    let e = Env::new("stop");
    let loud = ["auto-handover-pause-nag", "compact-advice-guard"];
    let map = e.map("Stop", &loud, "echo NODEBLOCK-{id} >&2; exit 2");
    let quiet = e.transcript(50_000);
    let (code, out, err) = e.run("Stop", &map, &stop(&quiet), &[WINDOW]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "nothing to nag about, no compact recommendation");
    let high = e.transcript(180_000);
    let (_, out, err) = e.run("Stop", &map, &stop(&high), &[WINDOW]);
    assert!(!err.contains("NODEBLOCK-") && format!("{out}{err}").contains("handover: context is at ~90%"), "{out:?} {err:?}");
    // a relative transcript path is opened from the hook's directory (the payload cwd, /tmp, holds no such file): answered natively
    let (code, _, err) = e.run("Stop", &map, &stop("tr.jsonl"), &[WINDOW]);
    assert_eq!(code, 0, "{err:?}");
    assert!(!err.contains("NODEBLOCK-"), "{err:?}");
}

/// #68 C2: what the engine cannot reproduce exactly (a file over the read cap, a line only V8 parses) says nothing this call
/// (counted `native_unable`; there is no Node to answer). A usage cache over the read cap means no conservation notice (dropped on
/// purpose); the pause nag and the Stop fire are decided natively from the big files.
const BIG: usize = 4_300_000; // over script.read_max_bytes
fn deep(d: usize) -> String {
    format!("{}{}", "[".repeat(d), "]".repeat(d))
}
fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

#[test]
fn a_usage_cache_or_claude_json_over_the_read_cap_says_nothing() {
    let e = Env::new("lc-big");
    let map = e.map("UserPromptSubmit", &["limit-conserve-inject"], "echo NODE-{id}");
    let tr = e.transcript(50_000);
    let cache = e.dir.join("home/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json");
    std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
    let fresh = serde_json::json!({"timestamp": now_ms() as u64, "data": {"fiveHourPercent": 99, "weeklyPercent": 1, "sonnetWeeklyPercent": 1}});
    let mut big = fresh.clone();
    big["pad"] = "x".repeat(BIG).into();
    std::fs::write(&cache, big.to_string()).unwrap();
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert!(!out.contains("NODE-") && !out.contains("limit conservation is active"), "a cache over the read cap: no conservation: {out:?}");
    // a small cache over the threshold, answered natively; then ~/.claude.json over the cap: the account is assumed unchanged
    std::fs::write(&cache, fresh.to_string()).unwrap();
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert!(!out.contains("NODE-") && out.contains("limit conservation is active (5h)"), "{out:?}");
    // a fresh state (the same line is not repeated within a session): ~/.claude.json over the cap changes nothing, the notice stays
    let e = Env::new("lc-bigjson");
    let map = e.map("UserPromptSubmit", &["limit-conserve-inject"], "echo NODE-{id}");
    let tr = e.transcript(50_000);
    let cache = e.dir.join("home/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json");
    std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
    std::fs::write(&cache, fresh.to_string()).unwrap();
    std::fs::write(e.dir.join("home/.claude.json"), serde_json::json!({"userID": "u2", "pad": "x".repeat(BIG)}).to_string()).unwrap();
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert!(!out.contains("NODE-") && out.contains("limit conservation is active (5h)"), "{out:?}");
}

#[test]
fn a_big_spawn_log_or_a_deep_task_line_still_fires_the_pause_nag_natively() {
    let e = Env::new("pn-big");
    let map = e.map("Stop", &["auto-handover-pause-nag"], "echo NODEBLOCK-{id} >&2; exit 2");
    let latch = e.dir.join("home/.anti-hall/auto-handover/e2e.json");
    std::fs::create_dir_all(latch.parent().unwrap()).unwrap();
    let armed = r#"{"fired":true,"firedPct":86,"lastNagPct":89,"lastNagAt":0}"#;
    let high = e.transcript(180_000); // 90 percent, nag due (quiet time elapsed)
    let log = e.dir.join("home/.anti-hall/agent-spawns.log");
    std::fs::write(&log, "0 old\n".repeat(BIG / 6)).unwrap();
    std::fs::write(&latch, armed).unwrap();
    let (code, out, err) = e.run("Stop", &map, &stop(&high), &[WINDOW]);
    assert!(code == 0 && !err.contains("NODEBLOCK-") && out.contains(r#""decision":"block""#) && out.contains("good stopping point"), "{out:?} {err:?}");
    // a small log: the same answer (the nag fires again from the re-armed latch)
    std::fs::write(&log, "0 old\n").unwrap();
    std::fs::write(&latch, armed).unwrap();
    let (_, out, err) = e.run("Stop", &map, &stop(&high), &[WINDOW]);
    assert!(!err.contains("NODEBLOCK-") && format!("{out}{err}").contains("good stopping point"), "{out:?} {err:?}");
    // a task line only V8 parses: deferred
    std::fs::write(&latch, armed).unwrap();
    let usage = std::fs::read_to_string(&high).unwrap();
    std::fs::write(&high, format!("{{\"type\":\"assistant\",\"name\":\"TodoWrite\",\"x\":{}}}\n{usage}", deep(100_000))).unwrap();
    let (code, out, err) = e.run("Stop", &map, &stop(&high), &[WINDOW]);
    assert!(code == 0 && !err.contains("NODEBLOCK-") && out.contains(r#""decision":"block""#) && out.contains("good stopping point"), "{out:?} {err:?}");
}

#[test]
fn a_handover_over_the_read_cap_still_fires_the_stop_fire_natively() {
    let e = Env::new("pn-hbig");
    let map = e.map("Stop", &["auto-handover-pause-nag"], "echo NODEBLOCK-{id} >&2; exit 2");
    let date = String::from_utf8(Command::new("date").arg("+%Y-%m-%d").output().unwrap().stdout).unwrap().trim().to_string();
    let proj = e.dir.join("proj");
    let hdir = proj.join(format!(".anti-hall/handovers/{date}/e2e"));
    std::fs::create_dir_all(&hdir).unwrap();
    std::fs::write(hdir.join("HANDOVER.md"), format!("# H\n## Open items\nnone\n## Pad\n{}\n", "x".repeat(BIG))).unwrap();
    let high = e.transcript(180_000);
    let p = serde_json::json!({"session_id":"e2e","hook_event_name":"Stop","stop_hook_active":false,"cwd":proj,"transcript_path":high}).to_string();
    let (code, out, err) = e.run("Stop", &map, &p, &[WINDOW]);
    assert!(
        code == 0 && !err.contains("NODEBLOCK-") && out.contains(r#""decision":"block""#) && out.contains("Do instead: follow the saved instructions."),
        "{out:?} {err:?}"
    );
}
