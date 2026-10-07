//! The context-budget checks through the real dispatcher (`ah-engine hook --event <Event>`), with the Node hooks replaced
//! by shell commands in a `--fallback-map`: a quiet turn is answered by the engine without running any of them, and every
//! case the checks defer reaches the Node stand-in.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-ctxb-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
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

const QUIET_PROMPT: &str = "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}\n";

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
    let (code, out, err) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, QUIET_PROMPT, ""));
}

#[test]
fn a_prompt_the_checks_defer_runs_their_node_hooks() {
    let e = Env::new("ups-defer");
    let loud = ["limit-conserve-inject", "auto-handover"];
    let map = e.map("UserPromptSubmit", &loud, "echo NODE-{id}");
    let tr = e.transcript(180_000); // 90 percent: the fire is Node's
    let (code, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW]);
    assert_eq!(code, 0);
    assert!(out.contains("NODE-auto-handover") && !out.contains("NODE-limit-conserve-inject"), "{out:?}");
    let (_, out, _) = e.run("UserPromptSubmit", &map, &prompt(&tr), &[WINDOW, ("ANTIHALL_LIMIT_CONSERVE", "on")]);
    assert!(out.contains("NODE-auto-handover") && out.contains("NODE-limit-conserve-inject"), "{out:?}");
}

#[test]
fn a_quiet_stop_is_answered_by_the_engine_and_a_fire_reaches_node() {
    let e = Env::new("stop");
    let loud = ["auto-handover-pause-nag", "compact-advice-guard"];
    let map = e.map("Stop", &loud, "echo NODEBLOCK-{id} >&2; exit 2");
    let quiet = e.transcript(50_000);
    let (code, out, err) = e.run("Stop", &map, &stop(&quiet), &[WINDOW]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "nothing to nag about, no compact recommendation");
    let high = e.transcript(180_000);
    let (code, _, err) = e.run("Stop", &map, &stop(&high), &[WINDOW]);
    assert_eq!(code, 2, "{err:?}");
    assert!(err.contains("NODEBLOCK-auto-handover-pause-nag") && !err.contains("NODEBLOCK-compact-advice-guard"), "{err:?}");
}
