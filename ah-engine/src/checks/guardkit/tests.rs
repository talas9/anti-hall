//! Unit tests of the shared guard helpers.
use super::jsre;
use super::settings::{get_bool, is_skipped};
use super::state::{MemoryState, SessionState, session_key};
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
fn plugin_option_counts_only_when_it_differs_from_the_default() {
    let h = home("opt");
    let e = defaults::raw("ship_it.setting");
    assert!(!get_bool(&st(&h, &[]), e), "the gate is off by default");
    assert!(get_bool(&st(&h, &[("CLAUDE_PLUGIN_OPTION_GUARDS_SHIPIT_GATE", "true")]), e));
    assert!(!get_bool(&st(&h, &[("CLAUDE_PLUGIN_OPTION_GUARDS_SHIPIT_GATE", "false")]), e));
    std::fs::write(format!("{h}/.claude/settings.json"), r#"{"pluginConfigs":{"anti-hall":{"options":{"guards_shipit_gate":true}}}}"#).unwrap();
    assert!(get_bool(&st(&h, &[]), e), "the host settings file is read");
    std::fs::write(format!("{h}/.claude/settings.json"), r#"{"pluginConfigs":{"anti-hall@anti-hall":{"guards_shipit_gate":"false"}}}"#).unwrap();
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"shipitGate":true}}"#).unwrap();
    assert!(get_bool(&st(&h, &[]), e), "settings.json outranks the plugin option");
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

#[test]
fn ordered_json_keeps_the_key_order_and_number_text_javascript_writes() {
    use super::ojson::{OVal, js_number_text};
    // insertion order, integer-like keys first ascending, a repeated key keeps its first place and takes the last value
    let v = OVal::parse(r#"{"z":1,"10":2,"a":{"y":[1,2.5,-0,1e21,1e-7],"b":null},"2":3,"01":4,"z":9}"#).unwrap();
    assert_eq!(v.stringify(), r#"{"2":3,"10":2,"z":9,"a":{"y":[1,2.5,0,1e+21,1e-7],"b":null},"01":4}"#);
    for (n, t) in [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (-12.5, "-12.5"),
        (1e21, "1e+21"),
        (1.5e-7, "1.5e-7"),
        (123456789012345680000.0, "123456789012345680000"),
        (0.000001, "0.000001"),
        (0.1, "0.1"),
    ] {
        assert_eq!(js_number_text(n), t, "{n}");
    }
    assert!(OVal::parse("{nope").is_none() && OVal::parse("").is_none());
    let mut o = OVal::parse(r#"{"a":1}"#).unwrap();
    o.set("b", OVal::Bool(true));
    o.set("a", OVal::Null);
    assert_eq!(o.stringify(), r#"{"a":null,"b":true}"#);
}

#[test]
fn javascript_number_coercions_match_number_and_int32() {
    use super::text::{js_number_of_str, js_to_int32};
    use serde_json::json;
    for (s, n) in [("5", 5.0), ("  7  ", 7.0), ("", 0.0), ("0x10", 16.0), ("0b11", 3.0), ("1e3", 1000.0), ("-2.5", -2.5), ("Infinity", f64::INFINITY)] {
        assert_eq!(js_number_of_str(s), n, "{s:?}");
    }
    for s in ["abc", "inf", "nan", "1,5", "0x", "0x+1", "0b2", "1 2", "--1"] {
        assert!(js_number_of_str(s).is_nan(), "{s:?}");
    }
    for (v, n) in [
        (json!(4294967297u64), 1),
        (json!(4294967299u64), 3),
        (json!(2147483648u64), -2147483648),
        (json!("3"), 3),
        (json!([4]), 4),
        (json!(true), 1),
        (json!(null), 0),
        (json!({}), 0),
        (json!(1.9), 1),
        (json!(-1.9), -1),
        (json!("x"), 0),
    ] {
        assert_eq!(js_to_int32(&v), n, "{v}");
    }
}

#[test]
fn an_old_file_of_a_family_is_pruned_once_per_window_and_the_live_one_is_kept() {
    use super::fsio::{prune_stale, write_atomic};
    let h = home("prune");
    let d = format!("{h}/.anti-hall");
    let age = |f: &str| {
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600);
        std::fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
    };
    for n in ["fam-old.json", "fam-live.json", "fam-new.json", "other-old.json", "fam-old.txt"] {
        write_atomic(&format!("{d}/{n}"), "{}").unwrap();
    }
    for n in ["fam-old.json", "fam-live.json", "other-old.json", "fam-old.txt"] {
        age(&format!("{d}/{n}"));
    }
    assert_eq!(prune_stale(&d, "fam", Some(&format!("{d}/fam-live.json"))), 1);
    let left: Vec<bool> = ["fam-old.json", "fam-live.json", "fam-new.json", "other-old.json", "fam-old.txt"]
        .iter()
        .map(|n| std::path::Path::new(&format!("{d}/{n}")).exists())
        .collect();
    assert_eq!(left, [false, true, true, true, true]);
    // throttled: a second sweep inside the window does nothing, even for a file that has since aged
    write_atomic(&format!("{d}/fam-again.json"), "{}").unwrap();
    age(&format!("{d}/fam-again.json"));
    assert_eq!(prune_stale(&d, "fam", None), 0);
    assert!(std::path::Path::new(&format!("{d}/fam-again.json")).exists());
    assert_eq!(std::fs::read_to_string(format!("{d}/.prune-stamp-fam.json")).unwrap().chars().take(13).collect::<String>(), "{\"lastSweep\":");
}

fn num_settings(files: &[(&str, &str)], env: &[(&str, &str)]) -> Settings {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("ah-num-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&d);
    for (rel, body) in files {
        let p = d.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    std::fs::create_dir_all(&d).unwrap();
    Settings { home: d.to_string_lossy().to_string(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
}

#[test]
fn a_number_switch_resolves_env_then_file_then_plugin_option_then_default() {
    use crate::checks::guardkit::settings::get_number;
    let e = defaults::raw("emit_dedupe.num_window_min"); // default 20, min 0
    assert_eq!(get_number(&num_settings(&[], &[]), e), 20.0);
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_DEDUPE_WINDOW_MIN", " 7 ")]), e), 7.0);
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_DEDUPE_WINDOW_MIN", "junk")]), e), 20.0, "an unreadable value falls through");
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_DEDUPE_WINDOW_MIN", "-5")]), e), 0.0, "clamped up to the minimum");
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_DEDUPE_WINDOW_MIN", "0x10")]), e), 16.0);
    let file = |body: &'static str| num_settings(&[(".anti-hall/settings.json", body)], &[]);
    assert_eq!(get_number(&file("{\"context\":{\"dedupeWindowMin\":3}}"), e), 3.0);
    assert_eq!(get_number(&file("{\"context\":{\"dedupeWindowMin\":\"4\"}}"), e), 4.0);
    assert_eq!(get_number(&file("{\"context\":{\"dedupeWindowMin\":true}}"), e), 20.0);
    assert_eq!(get_number(&file("{\"context\":{\"dedupeWindowMin\":null}}"), e), 20.0);
    assert_eq!(get_number(&file("{{"), e), 20.0);
    let mut s = num_settings(&[(".anti-hall/settings.json", "{\"context\":{\"dedupeWindowMin\":3}}")], &[("ANTIHALL_DEDUPE_WINDOW_MIN", "9")]);
    assert_eq!(get_number(&s, e), 9.0, "env beats the file");
    s.env.clear();
    s.env.insert("CLAUDE_PLUGIN_OPTION_CONTEXT_DEDUPE_WINDOW_MIN".into(), "12".into());
    assert_eq!(get_number(&s, e), 3.0, "the file beats the plugin option");
    let opt = num_settings(&[], &[("CLAUDE_PLUGIN_OPTION_CONTEXT_DEDUPE_WINDOW_MIN", "12")]);
    assert_eq!(get_number(&opt, e), 12.0);
    let stored = num_settings(&[(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"context_dedupe_window_min\":6}}}}")], &[]);
    assert_eq!(get_number(&stored, e), 6.0);
    // a minimum that rejects instead of clamping does not exist for these entries; the idle count clamps up to 1
    let count = defaults::raw("idle_sweep.num_count");
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "0")]), count), 1.0);
    assert_eq!(get_number(&num_settings(&[], &[("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "2.5")]), count), 2.5);
}

#[test]
fn an_enum_switch_is_trimmed_lower_cased_and_one_of_its_values() {
    use crate::checks::guardkit::settings::get_enum;
    let e = defaults::raw("verify_first.sw_supervisor_mode");
    assert_eq!(get_enum(&num_settings(&[], &[]), e), "auto");
    assert_eq!(get_enum(&num_settings(&[], &[("ANTIHALL_DEVSWARM_SUPERVISOR", "  OFF ")]), e), "off");
    assert_eq!(get_enum(&num_settings(&[], &[("ANTIHALL_DEVSWARM_SUPERVISOR", "banana")]), e), "auto");
    assert_eq!(get_enum(&num_settings(&[(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"On\"}}")], &[]), e), "on");
    assert_eq!(get_enum(&num_settings(&[(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":5}}")], &[]), e), "auto");
    assert_eq!(get_enum(&num_settings(&[], &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]), e), "off");
}
