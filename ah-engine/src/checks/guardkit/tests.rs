//! Unit tests of the shared guard helpers.
use super::jsre;
use super::settings::{get_bool, is_skipped};
use super::state::{session_key, MemoryState, SessionState};
use super::text::{collapse_ws, is_js_space, js_trim, slice_utf16};
use crate::checks::git::util::Settings;
use crate::defaults;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-gk-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(d.join(".claude")).unwrap();
    d.to_string_lossy().to_string()
}

fn st(home: &str, env: &[(&str, &str)]) -> Settings {
    Settings { home: home.to_string(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

#[test]
fn js_space_is_the_ecmascript_set_not_rusts() {
    assert!(is_js_space('\u{feff}') && is_js_space('\u{a0}') && is_js_space('\u{2028}') && is_js_space('\u{3000}'));
    assert!(!is_js_space('\u{85}') && !is_js_space('\u{200b}') && !is_js_space('\u{180e}'));
    assert_eq!(js_trim("\u{feff} x\u{a0}"), "x");
    assert_eq!(collapse_ws("a \u{2029}\t b"), "a b");
}

#[test]
fn the_shipped_class_matches_the_function() {
    let re = jsre::compile(r"^\s$", false);
    for c in (0u32..=0xffff).filter_map(char::from_u32) {
        assert_eq!(re.is_match(&c.to_string()), is_js_space(c), "U+{:04X}", c as u32);
    }
}

#[test]
fn slice_counts_utf16_units_and_refuses_to_split_a_pair() {
    assert_eq!(slice_utf16("abc", 2).as_deref(), Some("ab"));
    assert_eq!(slice_utf16("a\u{1F600}b", 3).as_deref(), Some("a\u{1F600}"));
    assert_eq!(slice_utf16("a\u{1F600}b", 2), None);
    assert_eq!(slice_utf16("ab", 9).as_deref(), Some("ab"));
}

#[test]
fn translate_keeps_javascript_meaning() {
    assert!(jsre::compile(r"\bgit\b", false).is_match("a git b"));
    // Rust's Unicode \b would not match between an accented letter and `g`; JavaScript's ASCII one does
    assert!(jsre::compile(r"\bgit", false).is_match("\u{e9}git"));
    // the dot excludes all four JS line terminators
    for t in ['\n', '\r', '\u{2028}', '\u{2029}'] {
        assert!(!jsre::compile("^a.b$", false).is_match(&format!("a{t}b")));
    }
    assert!(jsre::compile("^a.b$", false).is_match("a\u{85}b"));
    // the i flag folds ASCII only: the Kelvin sign is not k
    assert!(jsre::compile("kelvin", true).is_match("KELVIN"));
    assert!(!jsre::compile("kelvin", true).is_match("\u{212a}elvin"));
    assert!(jsre::compile("[a-c]x", true).is_match("Bx"));
    assert!(jsre::compile(r"[\s;]+x", false).is_match("\u{a0};x"));
}

#[test]
fn switch_chain_env_then_file_then_plugin_option_then_default() {
    let h = home("chain");
    let e = defaults::raw("merge_side_pick.setting");
    assert!(get_bool(&st(&h, &[]), e));
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"mergeSidePickAdvisory":"off"}}"#).unwrap();
    assert!(!get_bool(&st(&h, &[]), e));
    assert!(get_bool(&st(&h, &[("ANTIHALL_MERGE_SIDE_PICK_ADVISORY", " YES ")]), e), "env outranks the file");
    assert!(!get_bool(&st(&h, &[("ANTIHALL_MERGE_SIDE_PICK_ADVISORY", "zzz")]), e), "an unreadable env value falls through to the file");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), "{not json").unwrap();
    assert!(get_bool(&st(&h, &[]), e), "a corrupt file means the default");
}

#[test]
fn skip_file_covers_named_guards_and_all_but_not_destructive_ones() {
    let h = home("skip");
    let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
    std::fs::write(format!("{h}/.anti-hall/skip.json"), format!(r#"{{"all":{future}}}"#)).unwrap();
    assert!(is_skipped(&st(&h, &[]), "merge-side-pick"));
    assert!(!is_skipped(&st(&h, &[]), "git-guard"));
    std::fs::write(format!("{h}/.anti-hall/skip.json"), r#"{"merge-side-pick":1}"#).unwrap();
    assert!(!is_skipped(&st(&h, &[]), "merge-side-pick"), "expired");
}

#[test]
fn session_keys_replace_like_the_node_file_names() {
    assert_eq!(session_key("ID.1-2_3"), "ID.1-2_3");
    assert_eq!(session_key("a b/c"), "a_b_c");
    assert_eq!(session_key("\u{1F600}"), "__");
    assert_eq!(session_key(&"x".repeat(300)).len(), 120);
}

#[test]
fn the_memory_state_evicts_the_oldest_entry_past_its_cap() {
    let s = MemoryState::new();
    let cap = defaults::num("guardkit.state_cap") as usize;
    for i in 0..cap + 5 {
        s.update("ns", &format!("k{i}"), &mut |_| Some(i.to_string()));
    }
    assert!(s.get("ns", "k0").is_none() && s.get("ns", &format!("k{}", cap + 4)).is_some());
}
