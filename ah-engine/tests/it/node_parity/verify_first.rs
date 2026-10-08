//! Parity of the built-in `verify-first-subagent`, `verify-first-full` and `fable-availability` checks against the real Node
//! hooks. Every scenario gets its own isolated HOME (settings, skip file, host settings, `~/.claude.json`) and runs BOTH sides
//! as processes: `node <hook>.js` and `ah-engine check <name>` (the one-shot path; the plugin root reaches it through
//! `AH_ENGINE_PLUGIN_ROOT`). Compared: exit code, stdout BYTES (not trimmed), stderr, and the state file the hook leaves behind
//! (fable-availability; `checkedAt` must be a plausible clock reading on both sides and is then masked). A side the engine
//! answers with `AHFALLBACK` is a deferral (Node decides, D11), counted apart; a deferral that Node would have answered without
//! needing it is listed.

use super::guard::Doc;
use super::support::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Default)]
struct Home {
    env: Env,
    settings: Option<Doc>,
    skip: Option<Doc>,
    claude: Option<Doc>,
    /// `~/.claude.json`: absent when `None`.
    claude_json: Option<Vec<u8>>,
    files: Option<Vec<(String, Vec<u8>)>>,
    dot_anti_hall_file: bool,
    state_is_dir: bool,
    no_dot_dir: bool,
}

impl Home {
    fn env(mut self, k: &str, v: &str) -> Home {
        self.env.push((k.into(), Some(v.into())));
        self
    }
    fn settings(mut self, v: Value) -> Home {
        self.settings = Some(Doc::Json(v));
        self
    }
    fn settings_raw(mut self, v: &str) -> Home {
        self.settings = Some(Doc::Raw(v.into()));
        self
    }
    fn skip(mut self, v: Value) -> Home {
        self.skip = Some(Doc::Json(v));
        self
    }
    fn skip_raw(mut self, v: &str) -> Home {
        self.skip = Some(Doc::Raw(v.into()));
        self
    }
    fn claude(mut self, v: Value) -> Home {
        self.claude = Some(Doc::Json(v));
        self
    }
    fn claude_raw(mut self, v: &str) -> Home {
        self.claude = Some(Doc::Raw(v.into()));
        self
    }
    fn claude_json(mut self, v: impl Into<Vec<u8>>) -> Home {
        self.claude_json = Some(v.into());
        self
    }
    fn files(mut self, f: &[(&str, &str)]) -> Home {
        self.files = Some(f.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect());
        self
    }
}

struct Case {
    check: &'static str,
    id: String,
    ctx: Home,
    stdin: String,
}

fn ev(name: &str, extra: Value) -> String {
    assign(json!({"hook_event_name": name, "session_id": "s1", "cwd": "/tmp"}), extra).to_string()
}

fn payloads(event: &str) -> Vec<(&'static str, String)> {
    let huge = "x".repeat(1 << 20);
    vec![
        ("empty-object", "{}".into()),
        ("event", ev(event, json!({}))),
        ("event-startup", ev(event, json!({"source": "startup"}))),
        ("event-resume", ev(event, json!({"source": "resume"}))),
        ("event-clear", ev(event, json!({"source": "clear"}))),
        ("event-compact", ev(event, json!({"source": "compact"}))),
        ("other-event", ev("Stop", json!({}))),
        ("event-number", json!({"hook_event_name": 5}).to_string()),
        ("codex-turn", ev(event, json!({"turn_id": "abc", "model": "gpt-5"}))),
        ("codex-turn-empty", ev(event, json!({"turn_id": ""}))),
        ("codex-turn-number", ev(event, json!({"turn_id": 7}))),
        ("codex-rollout", ev(event, json!({"transcript_path": "/Users/u/.codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-abc.jsonl"}))),
        ("codex-rollout-bare", ev(event, json!({"transcript_path": "rollout-x.jsonl"}))),
        ("codex-rollout-bak", ev(event, json!({"transcript_path": "/a/rollout-x.jsonl.bak"}))),
        ("codex-rollout-nested", ev(event, json!({"transcript_path": "/a/rollout-x/y.jsonl"}))),
        ("codex-dir", ev(event, json!({"transcript_path": "/home/u/.codex/x"}))),
        ("codex-dir-win", ev(event, json!({"transcript_path": "C:\\Users\\u\\.codex\\x"}))),
        ("codex-dir-end", ev(event, json!({"transcript_path": "/home/u/.codex"}))),
        ("claude-transcript", ev(event, json!({"transcript_path": "/Users/u/.claude/projects/p/s.jsonl"}))),
        ("transcript-number", ev(event, json!({"transcript_path": 5}))),
        (
            "unicode",
            ev(event, json!({"prompt": "h\u{e9}llo \u{1F600} \u{2028} \u{65e5}\u{672c}\u{8a9e}", "transcript_path": "/tmp/\u{1F600}/rollout-\u{e9}.jsonl"})),
        ),
        ("huge", ev(event, json!({"prompt": huge}))),
        ("deep", format!("{{\"a\":{}{}}}", "[".repeat(100), "]".repeat(100))),
        ("array", "[1,2,3]".into()),
        ("null", "null".into()),
        ("number", "42".into()),
        ("string", "\"SessionStart\"".into()),
        ("true", "true".into()),
        ("empty-stdin", String::new()),
        ("whitespace", " \n\t ".into()),
        ("bad-json", "{".into()),
        ("bad-trailing", "{\"a\":1,}".into()),
        ("bom", "\u{feff}{}".into()),
        ("lone-surrogate", "{\"a\":\"\\ud800\",\"turn_id\":\"x\"}".into()),
        ("duplicate-keys", "{\"turn_id\":\"\",\"turn_id\":\"x\"}".into()),
        ("agent-fields", ev(event, json!({"agent_id": "a", "agent_type": "Explore"}))),
    ]
}

fn po(name: &str, v: &str) -> Home {
    Home::default().env(&format!("CLAUDE_PLUGIN_OPTION_{name}"), v)
}
fn stored(opts: Value, nested: bool) -> Home {
    Home::default().claude(json!({"pluginConfigs": {"anti-hall": if nested { json!({"options": opts}) } else { opts }}}))
}

fn full_ctxs() -> Vec<(&'static str, Home)> {
    let d = Home::default;
    let cx = |k: &str, v: &str| d().env(k, v);
    let s = |v: Value| d().settings(v);
    vec![
        ("default", d()),
        ("level_full", cx("ANTIHALL_PROTOCOL_LEVEL", "full")),
        ("level_full_sp", cx("ANTIHALL_PROTOCOL_LEVEL", "  FuLL ")),
        ("level_compact", cx("ANTIHALL_PROTOCOL_LEVEL", "compact")),
        ("level_junk", cx("ANTIHALL_PROTOCOL_LEVEL", "zz")),
        ("level_empty", cx("ANTIHALL_PROTOCOL_LEVEL", "")),
        ("level_file_full", s(json!({"context": {"protocolLevel": "full"}}))),
        ("level_file_junk", s(json!({"context": {"protocolLevel": 7}}))),
        ("level_file_upper", s(json!({"context": {"protocolLevel": "FULL"}}))),
        ("level_env_beats_file", s(json!({"context": {"protocolLevel": "full"}})).env("ANTIHALL_PROTOCOL_LEVEL", "compact")),
        ("level_junk_env_file_full", s(json!({"context": {"protocolLevel": "full"}})).env("ANTIHALL_PROTOCOL_LEVEL", "zz")),
        ("level_file_not_object", s(json!({"context": "full"}))),
        ("level_file_array", d().settings_raw("[1]")),
        ("level_file_corrupt", d().settings_raw("{not json")),
        ("session_off_file", s(json!({"context": {"verifyFirstSession": false}}))),
        ("session_off_str", s(json!({"context": {"verifyFirstSession": "off"}}))),
        ("session_off_zero", s(json!({"context": {"verifyFirstSession": 0}}))),
        ("session_junk_file", s(json!({"context": {"verifyFirstSession": "maybe"}}))),
        ("session_off_opt", po("CONTEXT_VERIFY_FIRST_SESSION", "false")),
        ("session_default_opt", po("CONTEXT_VERIFY_FIRST_SESSION", "true")),
        ("session_off_stored", stored(json!({"context_verify_first_session": false}), false)),
        ("session_off_stored_nested", stored(json!({"context_verify_first_session": "no"}), true)),
        ("session_on_file_beats_opt", s(json!({"context": {"verifyFirstSession": true}})).env("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_SESSION", "false")),
        ("orch_off_file", s(json!({"context": {"verifyFirstOrchestration": false}}))),
        ("orch_off_opt", po("CONTEXT_VERIFY_FIRST_ORCHESTRATION", "0")),
        ("orch_off_stored", stored(json!({"context_verify_first_orchestration": "false"}), false)),
        ("orch_off_full", s(json!({"context": {"verifyFirstOrchestration": false, "protocolLevel": "full"}}))),
        ("orch_default_opt", po("CONTEXT_VERIFY_FIRST_ORCHESTRATION", "true")),
        ("judge1", cx("ANTIHALL_JUDGE_CHILD", "1")),
        ("judge_true", cx("ANTIHALL_JUDGE_CHILD", "true")),
        ("judge_sp", cx("ANTIHALL_JUDGE_CHILD", " 1")),
        ("skip_all", d().skip(json!({"all": 99999999999999_i64}))),
        ("child_branch", cx("DEVSWARM_SOURCE_BRANCH", "feat/x")),
        ("home_unset_settings", d()),
    ]
}

fn sub_ctxs(now: i64) -> Vec<(&'static str, Home)> {
    let d = Home::default;
    let cx = |k: &str, v: &str| d().env(k, v);
    let s = |v: Value| d().settings(v);
    let vs = |v: Value| s(json!({"context": {"verifyFirstSubagent": v}}));
    vec![
        ("default", d()),
        ("level_full", cx("ANTIHALL_PROTOCOL_LEVEL", "full")),
        ("level_file_full", s(json!({"context": {"protocolLevel": "full"}}))),
        ("level_junk", cx("ANTIHALL_PROTOCOL_LEVEL", "x")),
        ("child", cx("DEVSWARM_SOURCE_BRANCH", "feat/a")),
        ("child_full", d().env("DEVSWARM_SOURCE_BRANCH", "b").env("ANTIHALL_PROTOCOL_LEVEL", "full")),
        ("child_blank", cx("DEVSWARM_SOURCE_BRANCH", "   ")),
        ("child_tab_bom", cx("DEVSWARM_SOURCE_BRANCH", "\t\u{feff}")),
        ("child_empty", cx("DEVSWARM_SOURCE_BRANCH", "")),
        ("child_unicode", cx("DEVSWARM_SOURCE_BRANCH", "f\u{e9}\u{1F600}")),
        ("off_file", vs(json!(false))),
        ("off_str", vs(json!("off"))),
        ("off_no", vs(json!("No"))),
        ("off_zero", vs(json!(0))),
        ("on_junk", vs(json!("maybe"))),
        ("off_opt", po("CONTEXT_VERIFY_FIRST_SUBAGENT", "false")),
        ("default_opt", po("CONTEXT_VERIFY_FIRST_SUBAGENT", "true")),
        ("off_stored", stored(json!({"context_verify_first_subagent": false}), false)),
        ("off_stored_nested", stored(json!({"context_verify_first_subagent": "off"}), true)),
        ("off_stored_bad", d().claude_raw("{broken")),
        ("off_file_corrupt", d().settings_raw("{broken")),
        ("skip_named", d().skip(json!({"verify-first-subagent": now + 3600000}))),
        ("skip_all", d().skip(json!({"all": now + 3600000}))),
        ("skip_expired", d().skip(json!({"verify-first-subagent": 1000}))),
        ("skip_other", d().skip(json!({"verify-first-full": now + 3600000}))),
        ("skip_str", d().skip(json!({"verify-first-subagent": (now + 3600000).to_string()}))),
        ("skip_bad", d().skip_raw("{x")),
        ("skip_array", d().skip_raw("[1]")),
        ("skip_empty", d().skip_raw("")),
        ("skip_all_expired_named_live", d().skip(json!({"all": 5, "verify-first-subagent": now + 3600000}))),
        ("judge1", cx("ANTIHALL_JUDGE_CHILD", "1")),
        ("off_and_child", vs(json!(false)).env("DEVSWARM_SOURCE_BRANCH", "x")),
    ]
}

fn acc(e: Value) -> Vec<u8> {
    json!({"modelAccessCache": e}).to_string().into_bytes()
}
fn opt(e: Value) -> Vec<u8> {
    json!({"additionalModelOptionsCache": e}).to_string().into_bytes()
}

/// `~/.claude.json` bodies; `None` is an absent file.
fn claude_jsons() -> Vec<(&'static str, Option<Vec<u8>>)> {
    let t = |s: &str| Some(s.as_bytes().to_vec());
    let j = |v: Value| Some(v.to_string().into_bytes());
    let mut invalid = b"{\"x\":\"".to_vec();
    invalid.extend([0xff, 0xfe, 0xc3]);
    invalid.extend(b"\",\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}");
    vec![
        ("missing", None),
        ("empty", t("")),
        ("ws", t(" \n")),
        ("corrupt", t("{\"modelAccessCache\":[")),
        ("bom", t("\u{feff}{\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}")),
        ("trailing_comma", t("{\"a\":1,}")),
        ("null", t("null")),
        ("array", t("[{\"apiName\":\"fable\",\"entitled\":true}]")),
        ("number", t("5")),
        ("string", t("\"fable\"")),
        ("bool", t("true")),
        ("obj_empty", t("{}")),
        ("entitled", Some(acc(json!([{"apiName": "claude-fable-5", "entitled": true}])))),
        ("entitled_upper", Some(acc(json!([{"apiName": "CLAUDE-FABLE-5", "entitled": true}])))),
        ("entitled_mixed", Some(acc(json!([{"apiName": "Fable", "entitled": true}])))),
        ("not_entitled", Some(acc(json!([{"apiName": "fable", "entitled": false}])))),
        ("entitled_missing", Some(acc(json!([{"apiName": "fable"}])))),
        ("entitled_one", Some(acc(json!([{"apiName": "fable", "entitled": 1}])))),
        ("entitled_str", Some(acc(json!([{"apiName": "fable", "entitled": "true"}])))),
        ("entitled_null", Some(acc(json!([{"apiName": "fable", "entitled": null}])))),
        ("access_not_array", j(json!({"modelAccessCache": {"apiName": "fable", "entitled": true}}))),
        ("access_string", j(json!({"modelAccessCache": "fable"}))),
        ("access_null", j(json!({"modelAccessCache": null}))),
        ("access_empty", Some(acc(json!([])))),
        (
            "access_mixed_entries",
            Some(acc(json!([null, 0, "", "fable", 7, [1], {"apiName": 5}, {"apiName": null}, {"apiName": "x"}, {"apiName": "fable-2", "entitled": true}]))),
        ),
        ("access_first_wins", Some(acc(json!([{"apiName": "fable", "entitled": false}, {"apiName": "fable-2", "entitled": true}])))),
        ("access_other_models", Some(acc(json!([{"apiName": "claude-opus", "entitled": true}, {"apiName": "sonnet", "entitled": true}])))),
        ("access_name_field_other", Some(acc(json!([{"name": "fable", "entitled": true}])))),
        ("access_nested", j(json!({"a": {"modelAccessCache": [{"apiName": "fable", "entitled": true}]}}))),
        ("options_enabled", Some(opt(json!([{"value": "fable", "label": "x"}])))),
        ("options_label", Some(opt(json!([{"label": "Try Fable now"}])))),
        ("options_model", Some(opt(json!([{"model": "FABLE-1"}])))),
        ("options_disabled", Some(opt(json!([{"value": "fable", "disabled": true}])))),
        ("options_disabled_str", Some(opt(json!([{"value": "fable", "disabled": "true"}])))),
        ("options_disabled_false", Some(opt(json!([{"value": "fable", "disabled": false}])))),
        ("options_not_array", j(json!({"additionalModelOptionsCache": {"value": "fable"}}))),
        ("options_mixed", Some(opt(json!([null, 3, "fable", {"value": 5}, {"value": "sonnet"}, {"model": "fable"}])))),
        ("options_other_field", Some(opt(json!([{"id": "fable"}])))),
        (
            "access_no_options_yes",
            j(json!({"modelAccessCache": [{"apiName": "fable", "entitled": false}], "additionalModelOptionsCache": [{"value": "fable"}]})),
        ),
        (
            "access_nofable_options_yes",
            j(json!({"modelAccessCache": [{"apiName": "opus", "entitled": true}], "additionalModelOptionsCache": [{"value": "fable-x", "disabled": true}]})),
        ),
        (
            "unicode",
            j(
                json!({"modelAccessCache": [{"apiName": "F\u{c4}BLE"}, {"apiName": "\u{1F600}fable\u{1F600}", "entitled": true}], "note": "\u{65e5}\u{672c}\u{8a9e} \u{2028}"}),
            ),
        ),
        ("turkish_dotted", Some(acc(json!([{"apiName": "FABLE\u{130}", "entitled": true}])))),
        ("kelvin", Some(acc(json!([{"apiName": "\u{212A}able", "entitled": true}])))),
        ("fullwidth", Some(acc(json!([{"apiName": "\u{FF26}\u{FF21}\u{FF22}\u{FF2C}\u{FF25}", "entitled": true}])))),
        ("lone_surrogate_other", t("{\"history\":\"cut \\ud83d here\",\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}")),
        ("lone_surrogate_low", t("{\"h\":\"\\udc00\",\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":false}]}")),
        ("lone_surrogate_name", t("{\"modelAccessCache\":[{\"apiName\":\"fable\\ud800\",\"entitled\":true}]}")),
        ("pair_ok", t("{\"x\":\"\\ud83d\\ude00\",\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}")),
        ("escaped_backslash_u", t("{\"x\":\"\\\\ud800\",\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}")),
        ("escaped_name", t("{\"modelAccessCache\":[{\"apiName\":\"\\u0066able\",\"entitled\":true}]}")),
        ("dup_keys", t("{\"modelAccessCache\":[{\"apiName\":\"x\"}],\"modelAccessCache\":[{\"apiName\":\"fable\",\"entitled\":true}]}")),
        ("big_unrelated", j(json!({"junk": "x".repeat(5 << 20), "modelAccessCache": [{"apiName": "fable", "entitled": true}]}))),
        ("deep_ok", t(&format!("{{\"a\":{}{},\"modelAccessCache\":[{{\"apiName\":\"fable\",\"entitled\":true}}]}}", "[".repeat(120), "]".repeat(120)))),
        ("deep_over_serde", t(&format!("{{\"a\":{}{},\"modelAccessCache\":[{{\"apiName\":\"fable\",\"entitled\":true}}]}}", "[".repeat(400), "]".repeat(400)))),
        ("invalid_utf8", Some(invalid)),
        ("crlf_pretty", t("{\r\n  \"modelAccessCache\": [\r\n    { \"apiName\": \"fable\", \"entitled\": true }\r\n  ]\r\n}\r\n")),
    ]
}

fn cases() -> Vec<Case> {
    let mut out: Vec<Case> = Vec::new();
    let mut add =
        |check: &'static str, id: String, ctx: Home, stdin: Option<String>| out.push(Case { check, id, ctx, stdin: stdin.unwrap_or_else(|| "{}".into()) });
    // verify-first-full
    let full_payloads = payloads("SessionStart");
    let narrow = ["event", "event-compact", "codex-turn", "codex-rollout", "unicode", "empty-object"];
    for (cid, ctx) in full_ctxs() {
        let wide = cid == "default" || cid.starts_with("level_full") || cid == "orch_off_file" || cid == "judge1" || cid == "level_file_full";
        for (pid, p) in &full_payloads {
            if wide || narrow.contains(pid) {
                add("verify-first-full", format!("{cid}/{pid}"), ctx.clone(), Some(p.clone()));
            }
        }
    }
    // verify-first-subagent
    let now = now_ms() as i64;
    let sub_payloads = payloads("SubagentStart");
    let narrow = ["event", "empty-object", "agent-fields", "unicode", "empty-stdin"];
    for (cid, ctx) in sub_ctxs(now) {
        let wide = cid == "default" || cid == "child";
        for (pid, p) in &sub_payloads {
            if wide || narrow.contains(pid) {
                add("verify-first-subagent", format!("{cid}/{pid}"), ctx.clone(), Some(p.clone()));
            }
        }
    }
    // fable-availability
    let start = ev("SessionStart", json!({"source": "startup"}));
    for (id, body) in claude_jsons() {
        let h = Home { claude_json: body, ..Home::default() };
        add("fable-availability", format!("claudejson/{id}"), h, Some(start.clone()));
    }
    let fa = || Home::default().claude_json(acc(json!([{"apiName": "fable", "entitled": true}])));
    add("fable-availability", "ctx/judge1".into(), fa().env("ANTIHALL_JUDGE_CHILD", "1"), None);
    add("fable-availability", "ctx/judge_true".into(), fa().env("ANTIHALL_JUDGE_CHILD", "true"), None);
    add("fable-availability", "ctx/dot_is_file".into(), Home { dot_anti_hall_file: true, ..fa() }, None);
    add("fable-availability", "ctx/state_preexisting".into(), fa().files(&[(".anti-hall/fable-availability.json", "{\"old\":true}")]), None);
    add("fable-availability", "ctx/state_is_dir".into(), Home { state_is_dir: true, ..fa() }, None);
    add("fable-availability", "ctx/no_dot_dir".into(), Home { no_dot_dir: true, ..fa() }, None);
    add("fable-availability", "ctx/settings_off_irrelevant".into(), fa().settings(json!({"context": {"verifyFirstSession": false}})), None);
    add("fable-availability", "ctx/skip_irrelevant".into(), fa().skip(json!({"all": 99999999999999_i64})), None);
    for (pid, p) in payloads("SessionStart") {
        add("fable-availability", format!("payload/{pid}"), fa(), Some(p));
    }
    out
}

fn doc_bytes(d: &Doc) -> Vec<u8> {
    match d {
        Doc::Json(v) => v.to_string().into_bytes(),
        Doc::Raw(s) => s.clone().into_bytes(),
    }
}

fn mk_home(tmp: &Path, n: usize, ctx: &Home) -> std::path::PathBuf {
    let home = tmp.join(format!("h{n}"));
    std::fs::create_dir_all(&home).expect("home");
    if !ctx.no_dot_dir {
        std::fs::create_dir_all(home.join(".anti-hall")).expect("state dir");
    }
    if ctx.dot_anti_hall_file {
        std::fs::remove_dir_all(home.join(".anti-hall")).ok();
        write_file(&home.join(".anti-hall"), b"x");
    }
    if ctx.state_is_dir {
        std::fs::create_dir_all(home.join(".anti-hall").join("fable-availability.json")).expect("state dir");
    }
    if let Some(d) = &ctx.settings {
        write_file(&home.join(".anti-hall/settings.json"), &doc_bytes(d));
    }
    if let Some(d) = &ctx.skip {
        write_file(&home.join(".anti-hall/skip.json"), &doc_bytes(d));
    }
    if let Some(d) = &ctx.claude {
        write_file(&home.join(".claude/settings.json"), &doc_bytes(d));
    }
    if let Some(b) = &ctx.claude_json {
        write_file(&home.join(".claude.json"), b);
    }
    for (rel, body) in ctx.files.iter().flatten() {
        write_file(&home.join(rel), body);
    }
    home
}

/// The state file of fable-availability, with `checkedAt` masked once it is a plausible clock reading.
fn state(home: &Path, t0: u64, t1: u64) -> String {
    let f = home.join(".anti-hall/fable-availability.json");
    let Ok(md) = std::fs::metadata(&f) else { return "absent".into() };
    if !md.is_file() {
        return "not-a-file".into();
    }
    let Ok(bytes) = std::fs::read(&f) else { return "absent".into() };
    let raw = String::from_utf8_lossy(&bytes).to_string();
    if let Ok(o) = serde_json::from_str::<Value>(&raw)
        && let Some(c) = o.get("checkedAt").filter(|c| c.is_number()).and_then(Value::as_f64)
    {
        if c < t0 as f64 - 5.0 || c > t1 as f64 + 5.0 {
            return format!("bad-checkedAt:{raw}");
        }
        return regex::Regex::new(r#""checkedAt":\d+"#).unwrap().replace(&raw, "\"checkedAt\":T").to_string();
    }
    raw
}

#[derive(Default)]
struct St {
    n: usize,
    same: usize,
    deferred: usize,
    unneeded: usize,
    mismatch: usize,
    node_out: usize,
    node_silent: usize,
}

fn hook_file(check: &str) -> &'static str {
    match check {
        "verify-first-full" => "verify-first-full.js",
        "verify-first-subagent" => "verify-first-subagent.js",
        _ => "fable-availability.js",
    }
}

pub(crate) fn run_lane(hooks: &Path, mutate: Option<usize>) -> String {
    let plugin_root = hooks.parent().expect("hooks directory has a parent").to_path_buf();
    let mut all = cases();
    if let Some(n) = mutate {
        all.truncate(n);
    }
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        let mut s = String::new();
        for c in &all {
            let doc = |d: &Option<Doc>| match d {
                None => Value::Null,
                Some(Doc::Json(v)) => v.clone(),
                Some(Doc::Raw(r)) => json!({"$raw": r}),
            };
            let env: BTreeMap<String, Option<String>> = c.ctx.env.iter().cloned().collect();
            let files: Option<BTreeMap<String, String>> =
                c.ctx.files.as_ref().map(|f| f.iter().map(|(k, v)| (k.clone(), String::from_utf8_lossy(v).to_string())).collect());
            let cj = c.ctx.claude_json.as_ref().map(|b| String::from_utf8_lossy(b).to_string());
            s.push_str(&json!({"check": c.check, "id": c.id, "ctx": {"env": env, "settings": doc(&c.ctx.settings), "skip": doc(&c.ctx.skip), "claude": doc(&c.ctx.claude), "claudeJson": cj, "files": files, "dot": c.ctx.dot_anti_hall_file, "stateIsDir": c.ctx.state_is_dir, "noDot": c.ctx.no_dot_dir}, "stdin": c.stdin}).to_string());
            s.push('\n');
        }
        std::fs::create_dir_all(&dir).ok();
        std::fs::write(Path::new(&dir).join("verify-first.scenarios.jsonl"), s).expect("dump");
        if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
            return String::new();
        }
    }
    let scratch = Scratch::new("vf");
    let tmp = scratch.path().to_path_buf();
    let base_path = std::env::var("PATH").unwrap_or_default();
    let stats: Mutex<BTreeMap<&'static str, St>> = Mutex::new(BTreeMap::new());
    let mism: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let defers: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let home_n = std::sync::atomic::AtomicUsize::new(0);
    pool(&all, 6, |s, _| {
        let base_env = |home: &str| {
            env_merge(
                &env_of(&[("PATH", &base_path), ("HOME", home), ("USERPROFILE", home), ("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_INGEST_DRY_RUN", "1")]),
                &s.ctx.env,
            )
        };
        let n_home = mk_home(&tmp, home_n.fetch_add(1, std::sync::atomic::Ordering::SeqCst), &s.ctx);
        let e_home = mk_home(&tmp, home_n.fetch_add(1, std::sync::atomic::Ordering::SeqCst), &s.ctx);
        let t0 = now_ms();
        let mut n = node(&strs(&[&hooks.join(hook_file(s.check)).to_string_lossy()]), s.stdin.as_bytes(), &base_env(&n_home.to_string_lossy()), "/tmp");
        if mutate.is_some() {
            n.out.push_str("~mutant");
        }
        let n_st = state(&n_home, t0, now_ms());
        let t1 = now_ms();
        let e = run(
            ENGINE,
            &strs(&["check", s.check]),
            s.stdin.as_bytes(),
            &env_merge(&base_env(&e_home.to_string_lossy()), &env_of(&[("AH_ENGINE_PLUGIN_ROOT", &plugin_root.to_string_lossy())])),
            "/tmp",
        );
        let mut all_stats = stats.lock().unwrap();
        let st = all_stats.entry(s.check).or_default();
        st.n += 1;
        if n.out.is_empty() {
            st.node_silent += 1;
        } else {
            st.node_out += 1;
        }
        if e.out.trim() == "AHFALLBACK" {
            st.deferred += 1;
            if n.out.is_empty() && n.code_is(0) {
                st.unneeded += 1;
            }
            defers.lock().unwrap().push(s.id.clone());
            // a deferral must leave the state to Node: the engine wrote nothing
            let e_st = state(&e_home, t1, now_ms());
            if s.check == "fable-availability" && e_st != "absent" && !(s.ctx.files.is_some() || s.ctx.state_is_dir || s.ctx.dot_anti_hall_file) {
                st.mismatch += 1;
                mism.lock().unwrap().push(format!("{}: deferred but wrote state {e_st}", s.id));
            }
            return;
        }
        let e_st = state(&e_home, t1, now_ms());
        let same = n.code == e.code && n.out == e.out && n.err == e.err && (s.check != "fable-availability" || n_st == e_st);
        if same {
            st.same += 1;
        } else {
            st.mismatch += 1;
            mism.lock().unwrap().push(format!(
                "{} {}: node=({}, {:?}, {:?}, state {:?}) engine=({}, {:?}, {:?}, state {:?})",
                s.check,
                s.id,
                n.code,
                clip(&n.out, 160),
                clip(&n.err, 160),
                n_st,
                e.code,
                clip(&e.out, 160),
                clip(&e.err, 160),
                e_st
            ));
        }
    });
    let stats = stats.into_inner().unwrap();
    let mut report = String::new();
    for (c, st) in &stats {
        report.push_str(&format!(
            "{c}: scenarios={} same={} deferred={} (Node silent anyway: {}) MISMATCH={} node-printed={} node-silent={}\n",
            st.n, st.same, st.deferred, st.unneeded, st.mismatch, st.node_out, st.node_silent
        ));
    }
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    for d in defers.into_inner().unwrap() {
        *by.entry(d.split('/').nth(1).map_or(d.clone(), str::to_string)).or_insert(0) += 1;
    }
    report.push_str(&format!("deferred by payload/config: {}\n", serde_json::to_string(&by).unwrap()));
    let mism = mism.into_inner().unwrap();
    for m in mism.iter().take(25) {
        report.push_str(&format!("MISMATCH {m}\n"));
    }
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        std::fs::write(Path::new(&dir).join("verify-first.summary.txt"), &report).expect("summary");
    }
    println!("{report}");
    if mutate.is_some() {
        return report;
    }
    assert!(mism.is_empty(), "verify-first mismatches:\n{report}");
    for check in ["verify-first-full", "verify-first-subagent", "fable-availability"] {
        let st = stats.get(check).unwrap_or_else(|| panic!("no scenarios ran for {check}"));
        assert!(st.same > 0, "{check}: nothing was compared exactly\n{report}");
    }
    report
}
