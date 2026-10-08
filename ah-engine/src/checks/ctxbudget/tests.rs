//! Unit tests of the context-budget checks. They pin which cases the engine answers itself and which it defers, so a
//! change that makes a check defer less (a missed state write) or more (a lost offload) fails here. The Node-versus-
//! engine comparison over a large corpus is `tests/node_parity` (the Rust Node-parity test); the expected values of the JavaScript coercions
//! below were computed with Node (`Number()`, `parseInt(x, 10)`, `new Date(x).getTime()`).
use crate::dispatch::inject::iso_ms;
use super::pct::{Pct, context_pct};
use super::setting::{get, js_number, js_parse_int};
use crate::checks::git::util::Settings;
use crate::checks::{Check, Verdict, registry};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::{Value, json};
use std::path::PathBuf;


fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}


/// A scratch home with the files given (path relative to the home, content).
struct Home(PathBuf);

impl Home {
    fn new(tag: &str, files: &[(&str, String)]) -> Home {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("ah-ctxb-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
        for (rel, body) in files {
            let f = d.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
        Home(d)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().to_string()
    }

    fn env(&self, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs = vec![("HOME".to_string(), self.path())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    fn settings(&self, extra: &[(&str, &str)]) -> Settings {
        Settings { home: self.path(), env: self.env(extra).to_map() }
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.0));
    }
}

fn check(name: &str) -> &'static dyn Check {
    registry().iter().copied().find(|c| c.name() == name).unwrap()
}

fn call(name: &str, payload: &Value, env: &RequestEnv) -> Verdict {
    let null = Value::Null;
    let s = Subject { event: "x", tool: None, cwd: None, tool_input: &null, prompt: None };
    check(name).run_env(&s, payload, &Value::Null, env).expect("these checks always answer")
}

fn empty() -> Verdict {
    Verdict::Exact(crate::checks::Exact { code: 0, out: defaults::text("ctxbudget.ups_empty").to_string(), err: String::new() })
}

/// A native answer that injects or blocks (not the quiet answer, not a deferral).
fn loud(v: &Verdict) -> bool {
    matches!(v, Verdict::Exact(e) if !e.out.is_empty() && *e != match empty() { Verdict::Exact(x) => x, _ => unreachable!() })
}

fn usage_line(tokens: u64) -> String {
    json!({"type":"assistant","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":tokens - 10,"cache_read_input_tokens":0},"content":[{"type":"text","text":"x"}]}}).to_string()
}

fn lines(ls: &[String]) -> String {
    ls.join("\n") + "\n"
}


fn stop(home: &Home) -> Value {
    json!({"hook_event_name":"Stop","session_id":"sess1","stop_hook_active":false,"transcript_path":format!("{}/tr.jsonl", home.path())})
}

// ---- JavaScript coercions ----------------------------------------------------------------------------------

#[test]
fn number_parsing_matches_javascript_number() {
    let some: &[(&str, f64)] = &[
        ("85", 85.0),
        (" 85", 85.0),
        ("0x55", 85.0),
        ("0X55", 85.0),
        ("8.5e1", 85.0),
        ("+85", 85.0),
        ("-85", -85.0),
        (".85e2", 85.0),
        ("85.", 85.0),
        ("1e-999", 0.0),
        ("0b101", 5.0),
        ("0B11", 3.0),
        ("0o17", 15.0),
        ("0O7", 7.0),
        ("1.e5", 100000.0),
        ("5e+3", 5000.0),
        ("0x1F", 31.0),
        ("0", 0.0),
        ("-0", 0.0),
        ("+0", 0.0),
        ("+.5", 0.5),
        ("-.5e1", -5.0),
        ("00012", 12.0),
        ("0.0000001", 1e-7),
        ("123456789012345678901234567890", 1.2345678901234568e29),
    ];
    for (s, want) in some {
        assert_eq!(js_number(s), Some(*want), "{s:?}");
    }
    for s in [
        "0x",
        "0xg",
        "1_0",
        "Infinity",
        "-Infinity",
        "NaN",
        "85abc",
        "1e999",
        "0b2",
        ".e5",
        "e5",
        "5e",
        "5e+",
        "--5",
        "+-5",
        "0xff.8",
        "1 2",
        ".",
        "\u{661}\u{662}",
    ] {
        assert_eq!(js_number(s), None, "{s:?}");
    }
}

#[test]
fn parse_int_matches_javascript_parse_int_with_radix_ten() {
    let some: &[(&str, f64)] = &[
        ("0", 0.0),
        ("-0", 0.0),
        ("+0", 0.0),
        ("0x32", 0.0),
        ("0abc", 0.0),
        ("  12abc", 12.0),
        ("\n7", 7.0),
        ("\u{a0}\u{feff} 9", 9.0),
        ("-5", -5.0),
        ("+5", 5.0),
        ("1e3", 1.0),
        ("0.5", 0.0),
        ("99999999999999999999999", 1e23),
    ];
    for (s, want) in some {
        assert_eq!(js_parse_int(s), Some(*want), "{s:?}");
    }
    for s in ["abc", "", "  ", "- 5", "\u{663}", &format!("1{}", "0".repeat(400))] {
        assert_eq!(js_parse_int(s), None, "{s:?}");
    }
}

#[test]
fn iso_dates_match_javascript_date_or_are_refused() {
    let some: &[(&str, f64)] = &[
        ("2026-10-07T12:00:00.034Z", 1791374400034.0),
        ("2026-10-14T07:00:00Z", 1791961200000.0),
        ("2001-02-30T00:00:00Z", 983491200000.0),
        ("2001-01-01T00:00:00.123456Z", 978307200123.0),
        ("2001-01-01T00:00:00.1Z", 978307200100.0),
        ("2099-01-01T00:00:00+05:30", 4070889000000.0),
        ("2001-01-01T00:00:00-08:00", 978336000000.0),
        ("1970-01-01T00:00:00Z", 0.0),
        ("1969-12-31T23:59:59.999Z", -1.0),
        ("2000-02-29T12:00:00Z", 951825600000.0),
        ("2100-03-01T00:00:00Z", 4107542400000.0),
        ("0000-01-01T00:00:00Z", -62167219200000.0),
        ("2026-12-31T23:59:59.999+23:59", 1798675259999.0),
        ("9999-12-31T23:59:59.999Z", 253402300799999.0),
    ];
    for (s, want) in some {
        assert_eq!(iso_ms(s), Some(*want), "{s:?}");
    }
    // text JavaScript reads some other way (or not at all) is never guessed
    for s in [
        "2026-13-01T00:00:00Z",
        "2026-00-10T00:00:00Z",
        "2026-01-32T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T23:59:60Z",
        "2026-01-01T00:00:00",
        "2026-01-01",
        "2026-01-01T00:00:00+0530",
        "2026-01-01T00:00Z",
        "2026-01-01t00:00:00Z",
        "2026-01-01 00:00:00Z",
        "2026-01-01T00:00:00z",
        "2026-01-01T00:00:00.Z",
        "2026-01-01T00:00:00+24:00",
        "soon",
        "",
    ] {
        assert_eq!(iso_ms(s), None, "{s:?}");
    }
}

#[test]
fn the_shipped_manifest_defaults_equal_the_plugin_manifest() {
    // the three headline entries take their "never touched" value from plugin.json in Node
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/.claude-plugin/plugin.json");
    let Ok(txt) = std::fs::read_to_string(path) else { return }; // the engine can be built outside the monorepo
    let uc: Value = serde_json::from_str(&txt).unwrap();
    for key in ["ctxbudget.set_ah_enabled", "ctxbudget.set_ah_pct", "ctxbudget.set_limit_mode"] {
        let e = defaults::raw(key);
        let want = &uc["userConfig"][e.str_field("option")]["default"];
        let got = e.str_field("manifest_default");
        let want_s = want.as_str().map_or_else(|| want.to_string(), str::to_string);
        assert_eq!(got, want_s, "{key}");
    }
}

// ---- settings --------------------------------------------------------------------------------------------------

#[test]
fn settings_resolve_env_then_file_then_option_then_default() {
    let pct = defaults::raw("ctxbudget.set_ah_pct");
    let h = Home::new("set", &[]);
    assert_eq!(get(&h.settings(&[]), pct).num(), 85.0);
    assert_eq!(get(&h.settings(&[("ANTIHALL_AUTO_HANDOVER_PCT", " 50 ")]), pct).num(), 50.0);
    assert_eq!(get(&h.settings(&[("ANTIHALL_AUTO_HANDOVER_PCT", "500")]), pct).num(), 99.0, "clamped to the schema maximum");
    assert_eq!(get(&h.settings(&[("ANTIHALL_AUTO_HANDOVER_PCT", "abc")]), pct).num(), 85.0, "an unreadable value falls through");
    assert_eq!(get(&h.settings(&[("CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT", "40")]), pct).num(), 40.0);
    assert_eq!(get(&h.settings(&[("CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT", "85")]), pct).num(), 85.0, "the manifest default is not a choice");
    let f = Home::new("setf", &[(".anti-hall/settings.json", r#"{"autoHandover":{"pct":" 60 ","enabled":"no"}}"#.into())]);
    assert_eq!(get(&f.settings(&[]), pct).num(), 60.0);
    assert_eq!(get(&f.settings(&[("ANTIHALL_AUTO_HANDOVER_PCT", "70")]), pct).num(), 70.0, "env beats the file");
    assert!(!get(&f.settings(&[]), defaults::raw("ctxbudget.set_ah_enabled")).flag());
    let s = Home::new("sets", &[(".claude/settings.json", r#"{"pluginConfigs":{"anti-hall@anti-hall":{"auto_handover_pct":55}}}"#.into())]);
    assert_eq!(get(&s.settings(&[]), pct).num(), 55.0);
    let env_wins = [("CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT", "85")];
    assert_eq!(get(&s.settings(&env_wins), pct).num(), 85.0, "an exported option hides the stored ones, as in Node");
    let mode = defaults::raw("ctxbudget.set_limit_mode");
    assert_eq!(get(&h.settings(&[("ANTIHALL_LIMIT_CONSERVE", " OFF ")]), mode), super::setting::Sv::Str("off".into()));
    assert_eq!(get(&h.settings(&[("ANTIHALL_LIMIT_CONSERVE", "maybe")]), mode), super::setting::Sv::Str("auto".into()));
}

// ---- limit-conserve-inject -----------------------------------------------------------------------------------



// ---- context percent -----------------------------------------------------------------------------------------

#[test]
fn the_context_reading_follows_the_node_sources_and_defers_where_node_writes() {
    let h = Home::new("pct", &[]);
    let st = |extra: &[(&str, &str)]| h.settings(extra);
    let sid = json!("sess1");
    let write = |rel: &str, body: String| {
        let f = h.0.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    };
    let tr = format!("{}/tr.jsonl", h.path());
    write("tr.jsonl", lines(&[usage_line(100_000)]));
    let reading = |p: Pct| match p {
        Pct::Reading(r) => Some((r.pct, r.window_known)),
        _ => None,
    };
    assert_eq!(reading(context_pct(&st(&[]), Some(&sid), Some(&tr), None)), Some((50.0, false)), "an estimate against the assumed window");
    assert_eq!(reading(context_pct(&st(&[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "400000")]), Some(&sid), Some(&tr), None)), Some((25.0, true)));
    write(".anti-hall/context-pct/sess1.json", json!({"pct": 95, "usedTokens": 1, "maxTokens": 200_000, "ts": now_ms() - 1000}).to_string());
    assert_eq!(reading(context_pct(&st(&[]), Some(&sid), Some(&tr), None)), Some((95.0, true)), "a fresh statusline reading wins");
    write(".anti-hall/context-pct/sess1.json", json!({"pct": 95, "maxTokens": 400_000, "ts": now_ms() - 3_600_000}).to_string());
    assert_eq!(reading(context_pct(&st(&[]), Some(&sid), Some(&tr), None)), Some((25.0, true)), "a stale reading only lends its window size");
    write("tr.jsonl", lines(&[usage_line(300_000)]));
    assert_eq!(reading(context_pct(&st(&[]), Some(&sid), Some(&tr), None)), Some((75.0, true)), "the sticky window beats the inference");
    std::fs::remove_file(h.0.join(".anti-hall/context-pct/sess1.json")).unwrap();
    assert!(
        matches!(context_pct(&st(&[]), Some(&sid), Some(&tr), None), Pct::Reading(r) if r.pct == 30.0 && r.infer_write),
        "Node records the inferred window here: the reading asks its caller to"
    );
    assert_eq!(reading(context_pct(&st(&[]), None, Some(&tr), None)), Some((30.0, true)), "without a tag nothing is recorded");
    write(
        "tr.jsonl",
        lines(&[
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120_000},"model_context_window":200_000}}})
                .to_string(),
        ]),
    );
    assert_eq!(reading(context_pct(&st(&[]), Some(&sid), Some(&tr), None)), Some((60.0, true)), "a Codex rollout states its window");
    write("tr.jsonl", "{\"usage\":1e999}\n".into());
    assert_eq!(context_pct(&st(&[]), Some(&sid), Some(&tr), None), Pct::Defer, "a number only JavaScript can read");
    assert_eq!(context_pct(&st(&[]), Some(&sid), Some("t/tr.jsonl"), None), Pct::Defer, "a relative path is Node's to resolve");
    assert_eq!(context_pct(&st(&[]), Some(&sid), Some("/nonexistent/x.jsonl"), None), Pct::None);
    assert_eq!(context_pct(&st(&[]), Some(&sid), None, None), Pct::None);
}

// ---- auto-handover ------------------------------------------------------------------------------------------

fn latch(v: Value) -> (&'static str, String) {
    (".anti-hall/auto-handover/sess1.json", v.to_string())
}


// ---- auto-handover-pause-nag -----------------------------------------------------------------------------------

#[test]
fn the_pause_nag_answers_quiet_fire_nag_and_rearm_cases() {
    let name = "auto-handover-pause-nag";
    let env200 = [("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")];
    let case = |used: u64, files: Vec<(&str, String)>, env: &[(&str, &str)], edit: &dyn Fn(&mut Value)| {
        let mut files = files;
        files.insert(0, ("tr.jsonl", lines(&[usage_line(used)])));
        let h = Home::new("pn", &files);
        let mut p = stop(&h);
        edit(&mut p);
        call(name, &p, &h.env(env))
    };
    let keep = |_: &mut Value| {};
    let fired = |extra: Value| {
        let mut base = json!({"fired": true, "firedPct": 85, "lastNagPct": 90, "lastNagAt": now_ms() - 10_000});
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        latch(base)
    };
    assert_eq!(case(100_000, vec![], &env200, &keep), Verdict::Allow, "below the threshold, latch not set");
    assert!(loud(&case(170_000, vec![], &env200, &keep)), "the Stop-side fire");
    assert_eq!(case(100_000, vec![latch(json!({"fired": true}))], &env200, &keep), Verdict::Allow, "back below: re-arm");
    assert_eq!(case(184_000, vec![fired(json!({}))], &env200, &keep), Verdict::Allow, "92 percent, 2 over the baseline, inside the quiet window");
    assert!(loud(&case(192_000, vec![fired(json!({}))], &env200, &keep)), "96 percent: a step past the baseline");
    assert!(loud(&case(184_000, vec![fired(json!({"lastNagAt": now_ms() - 16 * 60_000}))], &env200, &keep)), "the quiet period has passed");
    assert_eq!(
        case(184_000, vec![fired(json!({"lastNagAt": now_ms() - 16 * 60_000, "lastPauseNagPct": 92}))], &env200, &keep),
        Verdict::Allow,
        "the identical text is not repeated"
    );
    assert_eq!(
        case(185_200, vec![fired(json!({"lastNagAt": now_ms() - 16 * 60_000, "lastPauseNagPct": 93}))], &env200, &keep),
        Verdict::Allow,
        "92.6 shows as 93 (Math.round)"
    );
    assert!(loud(&case(184_800, vec![fired(json!({"lastNagAt": now_ms() - 16 * 60_000, "lastPauseNagPct": 93}))], &env200, &keep)), "92.4 shows as 92");
    assert_eq!(
        case(184_000, vec![fired(json!({})), (".anti-hall/settings.json", r#"{"autoHandover":{"nag":false}}"#.into())], &env200, &keep),
        Verdict::Allow,
        "nag off"
    );
    assert!(
        loud(&case(
            184_000,
            vec![fired(json!({"lastNagAt": now_ms() - 120_000})), (".anti-hall/settings.json", r#"{"autoHandover":{"nagQuietMin":1}}"#.into())],
            &env200,
            &keep
        )),
        "a one minute quiet period"
    );
    assert_eq!(
        case(192_000, vec![fired(json!({})), (".anti-hall/settings.json", r#"{"autoHandover":{"nagStepPct":10}}"#.into())], &env200, &keep),
        Verdict::Allow,
        "a ten point step"
    );
    assert_eq!(case(192_000, vec![fired(json!({}))], &env200, &|p| p["stop_hook_active"] = json!(true)), Verdict::Allow, "the stop was already continued");
    assert!(loud(&case(192_000, vec![fired(json!({}))], &env200, &|p| p["stop_hook_active"] = json!("true"))), "only a literal true counts");
    assert_eq!(case(192_000, vec![fired(json!({}))], &env200, &|p| p["agent_id"] = json!("a")), Verdict::Allow, "a subagent");
    assert_eq!(case(192_000, vec![fired(json!({}))], &env200, &|p| p["transcript_path"] = json!("t/tr.jsonl")), Verdict::Defer, "a relative path is Node's");
    assert!(
        loud(&case(192_000, vec![fired(json!({}))], &env200, &|p| {
            p.as_object_mut().unwrap().remove("session_id");
        })),
        "the tag is a hash of the path: no latch under it, so the Stop-side fire"
    );
    assert_eq!(
        case(192_000, vec![fired(json!({}))], &[("ANTIHALL_AUTO_HANDOVER_PCT", "0"), ("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")], &keep),
        Verdict::Allow,
        "disabled"
    );
    assert_eq!(case(192_000, vec![fired(json!({}))], &[("ANTIHALL_JUDGE_CHILD", "1")], &keep), Verdict::Allow);
}

// ---- compact-advice-guard ------------------------------------------------------------------------------------------

#[test]
fn compact_advice_blocks_once_at_low_context_and_allows_the_rest() {
    let name = "compact-advice-guard";
    let asst = |t: &str| json!({"type":"assistant","message":{"content":[{"type":"text","text":t}]}}).to_string();
    let user = |t: &str| json!({"type":"user","message":{"content":t}}).to_string();
    let case = |ls: Vec<String>, env: &[(&str, &str)], files: Vec<(&str, String)>, edit: &dyn Fn(&mut Value)| {
        let mut files = files;
        files.insert(0, ("tr.jsonl", lines(&ls)));
        let h = Home::new("ca", &files);
        let mut p = stop(&h);
        edit(&mut p);
        call(name, &p, &h.env(env))
    };
    let keep = |_: &mut Value| {};
    let turn = |t: &str| vec![user("go"), asst(t)];
    assert_eq!(case(turn("All done, tests pass."), &[], vec![], &keep), Verdict::Allow);
    assert_eq!(case(turn("a compact layout"), &[], vec![], &keep), Verdict::Allow, "the word alone is no recommendation");
    assert_eq!(case(turn("this code is safe"), &[], vec![], &keep), Verdict::Allow);
    assert_eq!(case(turn("good job, nice point"), &[], vec![], &keep), Verdict::Allow);
    for t in [
        "\u{2705} SAFE TO COMPACT NOW",
        "it is safe to compact now",
        "safe for a context reset",
        "GOOD POINT TO /compact NOW",
        "good time to clear",
        "then /compact",
        "/compact",
        "safe\nto compact",
        "safe to /clear",
        "good point for /new",
    ] {
        // no context reading and no compact boundary: neither rule applies
        assert_eq!(case(turn(t), &[], vec![], &keep), Verdict::Allow, "{t:?}");
    }
    assert_eq!(
        case(turn("safe to compact"), &[], vec![], &|p| p["last_assistant_message"] = json!("fine")),
        Verdict::Allow,
        "the last message replaces the transcript"
    );
    assert_eq!(case(turn("fine"), &[], vec![], &|p| p["last_assistant_message"] = json!("safe to compact")), Verdict::Allow);
    assert_eq!(
        case(turn("safe to compact"), &[], vec![], &|p| p["last_assistant_message"] = json!("  ")),
        Verdict::Allow,
        "a blank last message falls back to the turn"
    );
    assert_eq!(case(vec![user("go"), asst("safe to compact"), user("next"), asst("ok")], &[], vec![], &keep), Verdict::Allow, "an earlier turn does not count");
    assert_eq!(
        case(
            vec![asst("safe to compact"), json!({"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}).to_string(), asst("ok")],
            &[],
            vec![],
            &keep
        ),
        Verdict::Allow,
        "a tool result does not start a turn, but ends the final part"
    );
    assert_eq!(
        case(vec!["{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"s\\u0061fe to compact\"}]}}".into()], &[], vec![], &keep),
        Verdict::Allow,
        "an escape can spell the words"
    );
    assert_eq!(
        case(turn("safe to compact"), &[], vec![(".anti-hall/settings.json", r#"{"guards":{"compactAdviceGuard":false}}"#.into())], &keep),
        Verdict::Allow,
        "switched off"
    );
    assert_eq!(
        case(turn("safe to compact"), &[("CLAUDE_PLUGIN_OPTION_GUARDS_COMPACT_ADVICE_GUARD", "false")], vec![], &keep),
        Verdict::Allow,
        "switched off by the plugin option"
    );
    assert_eq!(
        case(turn("safe to compact"), &[], vec![(".anti-hall/skip.json", format!("{{\"compact-advice-guard\":{}}}", now_ms() + 60_000))], &keep),
        Verdict::Allow,
        "skipped"
    );
    assert_eq!(case(turn("safe to compact"), &[], vec![], &|p| p["stop_hook_active"] = json!(true)), Verdict::Allow);
    assert_eq!(case(turn("safe to compact"), &[], vec![], &|p| p["agent_type"] = json!("x")), Verdict::Allow);
    assert_eq!(case(turn("safe to compact"), &[], vec![], &|p| p["transcript_path"] = json!("/nonexistent/x.jsonl")), Verdict::Allow, "no transcript");
    assert_eq!(
        case(turn("safe to compact"), &[], vec![], &|p| {
            p.as_object_mut().unwrap().remove("transcript_path");
        }),
        Verdict::Allow
    );
    assert_eq!(case(turn("safe to compact"), &[], vec![], &|p| p["transcript_path"] = json!("t/tr.jsonl")), Verdict::Defer, "a relative path is Node's");
    assert_eq!(case(turn("safe to compact"), &[("ANTIHALL_JUDGE_CHILD", "1")], vec![], &keep), Verdict::Allow);
    assert_eq!(case(turn("x"), &[], vec![], &|p| *p = json!([1])), Verdict::Allow);
}

#[test]
fn compact_advice_blocks_a_recommendation_at_low_context_once() {
    let low = json!({"type":"assistant","message":{"content":[{"type":"text","text":"SAFE TO COMPACT NOW"}],"usage":{"input_tokens":20000}}}).to_string();
    let h = Home::new("cab", &[("tr.jsonl", lines(&[json!({"type":"user","message":{"content":"go"}}).to_string(), low]))]);
    let env = h.env(&[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")]);
    let p = stop(&h);
    assert!(loud(&call("compact-advice-guard", &p, &env)), "10 percent is low");
    assert!(h.0.join(".anti-hall/compact-advice/sess1.json").is_file(), "the declaration is recorded");
    assert_eq!(call("compact-advice-guard", &p, &env), Verdict::Allow, "the same declaration is blocked once");
    let mut q = p.clone();
    q["last_assistant_message"] = json!("Not safe to compact yet.");
    assert_eq!(call("compact-advice-guard", &q, &env), Verdict::Allow, "a negated one is no recommendation");
}

#[test]
fn every_check_is_registered_once_and_summarised() {
    for n in ["limit-conserve-inject", "auto-handover", "auto-handover-pause-nag", "compact-advice-guard"] {
        let c = check(n);
        assert!(c.summary().len() > 40, "{n}");
        assert_eq!(registry().iter().filter(|x| x.name() == n).count(), 1);
    }
}
