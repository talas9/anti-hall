//! #764: rules that fire but never reach the agent. Reads the shipped TOML (both the live `defaults/` and the non-pinned
//! `defaults.pristine/` copy) so a value cannot drift in one place only.
use std::path::PathBuf;

fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine")
}

/// The `value` of key `section.name` in `<dir>/<file>`, for both shipped copies. The shipped files are the engine's own
/// format (one `[key]` table per setting, redefinitions allowed), so the one table is cut out and parsed alone.
fn both(file: &str, key: &str) -> Vec<(&'static str, toml::Value)> {
    ["defaults", "defaults.pristine"]
        .iter()
        .map(|d| {
            let text = std::fs::read_to_string(engine_dir().join(d).join(file)).unwrap_or_else(|e| panic!("{d}/{file}: {e}"));
            let header = format!("[{key}]");
            let mut body = String::new();
            let mut inside = false;
            for line in text.lines() {
                if inside && line.starts_with('[') {
                    break;
                }
                if inside {
                    body.push_str(line);
                    body.push('\n');
                } else if line.trim_end() == header {
                    inside = true;
                }
            }
            assert!(inside, "{d}/{file}: no {key}");
            let doc: toml::Table = body.parse().unwrap_or_else(|e| panic!("{d}/{file}: {key}: {e}"));
            (*d, doc.get("value").unwrap_or_else(|| panic!("{d}/{file}: {key} has no value")).clone())
        })
        .collect()
}

fn text_of(file: &str, key: &str) -> Vec<(&'static str, String)> {
    both(file, key).into_iter().map(|(d, v)| (d, v.as_str().unwrap_or_else(|| panic!("{d}/{file}: {key} is not text")).to_string())).collect()
}

/// Item 2: the checks the owner relies on are never shed past the hard CPU limit.
#[test]
fn the_reminders_the_owner_relies_on_are_in_shed_never() {
    for (d, v) in both("diagnostics.toml", "diagnostics.shed_never") {
        let t = v.as_table().unwrap();
        for c in ["idle-agent-sweep", "gh-rt-advisory", "procwatch-advisory", "switch-notice", "limit-conserve-inject"] {
            assert!(t.get(c).and_then(|r| r.as_str()).is_some_and(|r| !r.is_empty()), "{d}: {c} must be in diagnostics.shed_never with a reason");
        }
    }
}

/// Item 3: a Jev integration that is on but has no key is not a failed call in the report.
#[test]
fn a_missing_jev_key_is_not_a_counted_failure() {
    for (d, v) in both("jev_report.toml", "jevrep.thr_failure_reasons") {
        let reasons: Vec<&str> = v.as_array().unwrap().iter().filter_map(|r| r.as_str()).collect();
        assert!(!reasons.contains(&"no-key"), "{d}: no-key must not count as a real failure: {reasons:?}");
        assert!(reasons.contains(&"timeout"), "{d}: a timeout still counts: {reasons:?}");
    }
}

/// Item 6: coordinator-work-guard counts Bash steps only (dispatch matcher `Bash`; classifyBashWork: git/gh mutations and Bash
/// writes), so its texts must not claim it counts "edits".
#[test]
fn coordinator_work_texts_say_what_the_guard_counts() {
    for key in ["coordinator_work.nudge_what", "coordinator_work.block_what"] {
        for (d, t) in text_of("small_guards.toml", key) {
            assert!(t.contains("shell step"), "{d}: {key} must say shell steps: {t}");
            assert!(!t.contains("edits"), "{d}: {key} must not say edits: {t}");
        }
    }
    for (d, t) in text_of("small_guards.toml", "coordinator_work.block_digest") {
        assert!(t.contains("shell steps") && !t.contains("after {cfg:coordinator_work.block_setting} edits"), "{d}: digest: {t}");
    }
}

/// Item 7: when silent-agent-nudge throws, the error text is kept (one bounded line in its own log) and the error still reaches
/// the engine's failure policy. The host is a stub whose first call throws, so the test needs no real failure to provoke.
#[test]
fn a_silent_agent_nudge_error_keeps_its_text() {
    use rquickjs::{Context, Runtime};
    let src = std::fs::read_to_string(engine_dir().join("logic/silent-agent-nudge.js")).unwrap();
    let prelude = r#"
var captured = { rel: null, line: null }, cfgs = { 'silent_nudge.err_file': 'err.log', 'procwatch.f_event': 'hook_event_name' };
var nums = { 'silent_nudge.err_max_bytes': 1000000, 'silent_nudge.err_text_max': 2000 };
var ah = {
  cfg: function (k) { return cfgs[k]; }, cfgNum: function (k) { return nums[k]; }, home: function () { return '/h'; },
  fs: { lstat: function () { return null; } },
  state: { appendFile: function (rel, s) { captured.rel = rel; captured.line = s; }, op: function () {} },
  clock: { now: function () { return 0; } },
  env: { get: function () { throw new Error('boom-764'); } },
};
"#;
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    let out: String = ctx.with(|c| {
        c.eval::<(), _>(prelude).unwrap();
        c.eval::<(), _>(src.as_str()).unwrap();
        c.eval::<String, _>(
            "var thrown = ''; try { decide({ hook_event_name: 'Stop' }, null); } catch (e) { thrown = e.message; }\nJSON.stringify([thrown, String(captured.rel), String(captured.line)])",
        )
        .unwrap()
    });
    let got: Vec<String> = serde_json::from_str(&out).unwrap();
    let (thrown, rel, line) = (&got[0], &got[1], &got[2]);
    assert_eq!(thrown, "boom-764", "the error must still reach the engine's failure policy");
    assert_eq!(rel, "err.log");
    assert!(line.contains("boom-764") && line.contains("\"event\":\"Stop\""), "the error text is recorded: {line}");
}
