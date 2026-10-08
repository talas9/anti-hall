//! Property tests for the hand-written parsers (D74: never weaker than the Node reference). Every property here is an
//! invariant the Node code also holds: no panic on any input, bounded time, and the structural guarantees the doc
//! comments state (segments are never blank, a body is a substring of the command, JSON round-trips, glob = regex).
//! The case count follows `PROPTEST_CASES` (default below), so a soak run can raise it without editing the file.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::checks::command::shell;
use ah_engine::checks::git::tokenize as tk;
use ah_engine::checks::guardkit::jsval::{self, Js};
use ah_engine::hookcfg::when::glob_match;
use proptest::prelude::*;
use std::time::{Duration, Instant};

fn cfg() -> ProptestConfig {
    let cases = std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(1000);
    ProptestConfig { cases, failure_persistence: None, ..ProptestConfig::default() }
}

/// Run `f` and fail when one input takes longer than `limit` (a hang or a super-linear blow-up).
fn bounded<T>(what: &str, input: &str, limit: Duration, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let out = f();
    assert!(t0.elapsed() < limit, "{what} took {:?} on {} bytes: {input:?}", t0.elapsed(), input.len());
    out
}

const SLOW: Duration = Duration::from_secs(2);

/// Shell-looking text: chunks that exercise every quoting, substitution, heredoc and separator rule, plus arbitrary
/// Unicode, so the parsers meet both well-formed and truncated constructs.
fn shellish() -> impl Strategy<Value = String> {
    let chunk = prop_oneof![
        3 => prop::sample::select(vec![
            "git", " ", "  ", "\t", "'", "\"", "\\", "$(", ")", "`", "<<", "<<-", "<<<", "EOF", "'EOF'", "\"EOF\"", "\n", "\r\n",
            ";", "&&", "||", "|", "&", "$((", "))", "<(", ">(", "$'", "{", "}", "(", "#", "push", "--force", "-C", "commit",
            "-m", "=", "FOO=bar", "sh -c ", "eval ", "\\\n", "$", "${", ">", ">>", "2>&1", "*", "?", "[", "]",
        ]).prop_map(String::from),
        1 => any::<char>().prop_map(String::from),
        1 => "[a-z]{1,6}",
    ];
    prop::collection::vec(chunk, 0..60).prop_map(|v| v.concat())
}

fn any_text() -> impl Strategy<Value = String> {
    prop_oneof![shellish(), any::<String>(), ".{0,200}"]
}

/// `command::shell` documents ASCII-only input (its module doc: byte indexes stand for JavaScript's UTF-16 indexes; the
/// command check defers every non-ASCII command before it reaches the splitter), so its properties draw ASCII text.
fn ascii_text() -> impl Strategy<Value = String> {
    prop_oneof![shellish().prop_map(|s| s.chars().filter(char::is_ascii).collect::<String>()), "[ -~\\t\\n\\r]{0,200}",]
}

proptest! {
    #![proptest_config(cfg())]

    #[test]
    fn git_tokenize_never_panics(s in any_text()) {
        bounded("tokenize", &s, SLOW, || { let t = tk::tokenize(&s); tk::effective_verb(&t); });
        bounded("split_segments", &s, SLOW, || tk::split_segments(&s));
    }

    #[test]
    fn git_backstop_and_heredocs(s in any_text()) {
        bounded("backstop_pieces", &s, SLOW, || tk::backstop_pieces(&s));
        bounded("backstop_verb", &s, SLOW, || tk::backstop_verb(&s));
        let bodies = bounded("extract_heredoc_bodies", &s, SLOW, || tk::extract_heredoc_bodies(&s));
        // `<<-` strips leading tabs from the body (Node's parseHeredocAt does too, `dashStrip`), so compare tab-free.
        let flat = s.replace('\t', "");
        for b in &bodies {
            prop_assert!(flat.contains(&b.body.replace('\t', "")), "body {:?} is not a substring of {:?}", b.body, s);
        }
    }

    #[test]
    fn heredoc_opener_parse_total(s in any_text(), at in 0usize..80) {
        let cs: Vec<char> = s.chars().collect();
        bounded("parse_heredoc_raw", &s, SLOW, || tk::parse_heredoc_raw(&cs, at));
        let mut st = tk::ArithScan::new();
        bounded("parse_heredoc_at", &s, SLOW, || tk::parse_heredoc_at(&cs, at, &mut st));
    }

    /// The public gate answers (or defers) on any text, ASCII or not, and never panics.
    #[test]
    fn command_decide_total(s in any_text(), sub in any::<bool>()) {
        bounded("decide_in", &s, SLOW, || ah_engine::checks::command::decide_in(&s, Some("/repo"), sub));
    }

    #[test]
    fn shell_split_invariants(s in ascii_text()) {
        let sp = bounded("split_detailed", &s, SLOW, || shell::split_detailed(&s));
        prop_assert_eq!(sp.segments.len(), sp.delims.len());
        for seg in &sp.segments {
            prop_assert!(!shell::trim(seg).is_empty(), "blank segment {:?} from {:?}", seg, s);
        }
        prop_assert_eq!(shell::split_segments(&s), sp.segments.clone());
    }

    #[test]
    fn shell_helpers_never_panic(s in ascii_text()) {
        bounded("shell helpers", &s, SLOW, || {
            shell::words(&s);
            shell::effective_verb(&s);
            shell::tokenize_quoted(&s);
            shell::dequote_segment(&s);
            shell::extract_substitutions(&s);
            shell::extract_shell_c_payload(&s);
            shell::extract_eval_payload(&s);
            shell::neutralize_quoted_contents(&s);
            shell::blank_pattern_argument(&s, "grep");
            shell::has_unquoted_redirect_char(&s);
            shell::has_shell_expansion_anywhere(&s);
            shell::mask_process_substitutions(&s);
            shell::blank_test_operators(&s);
        });
        let bodies = bounded("heredoc_bodies_in", &s, SLOW, || shell::heredoc_bodies_in(&s));
        let flat = s.replace('\t', "");
        for b in &bodies {
            prop_assert!(flat.contains(&b.replace('\t', "")), "body {:?} is not a substring of {:?}", b, s);
        }
        let segs = shell::split_segments(&s);
        bounded("segment_heredoc_bodies", &s, SLOW, || shell::segment_heredoc_bodies(&segs, &s));
    }
}

// ---- JavaScript-semantics JSON readers ------------------------------------------------------------------------

fn js_value() -> impl Strategy<Value = Js> {
    let leaf = prop_oneof![
        Just(Js::Null),
        any::<bool>().prop_map(Js::Bool),
        prop::num::f64::NORMAL.prop_map(Js::Num),
        (-1_000_000i64..1_000_000).prop_map(|n| Js::Num(n as f64)),
        any::<String>().prop_map(Js::Str),
    ];
    leaf.prop_recursive(4, 48, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..5).prop_map(Js::Arr),
            prop::collection::vec(("[a-z0-9]{0,4}", inner), 0..5).prop_map(|kv| {
                let mut seen = std::collections::HashSet::new();
                Js::Obj(kv.into_iter().filter(|(k, _)| seen.insert(k.clone())).collect())
            }),
        ]
    })
}

proptest! {
    #![proptest_config(cfg())]

    #[test]
    fn js_parse_never_panics(s in any::<String>()) {
        bounded("Js::parse", &s, SLOW, || Js::parse(&s));
        bounded("parse_line", &s, SLOW, || jsval::parse_line(&s));
        bounded("fix_lone_surrogates", &s, SLOW, || jsval::fix_lone_surrogates(&s));
        bounded("to_number", &s, SLOW, || jsval::to_number(&s));
        bounded("date_parse", &s, SLOW, || jsval::date_parse(&s));
    }

    /// Text built from JSON punctuation: truncated and mangled documents, the shapes a half-written state file has.
    #[test]
    fn js_parse_mangled_json_never_panics(s in prop::collection::vec(prop::sample::select(vec![
        "{", "}", "[", "]", ",", ":", "\"", "\\", "\\u", "\\ud800", "\\udc00", "null", "true", "-", "1e999", "0.5", "a", " ", "\n",
    ]), 0..40).prop_map(|v| v.concat())) {
        bounded("Js::parse", &s, SLOW, || Js::parse(&s));
        bounded("parse_line", &s, SLOW, || jsval::parse_line(&s));
    }

    #[test]
    fn js_stringify_parse_roundtrip(v in js_value()) {
        let text = v.stringify();
        let back = Js::parse(&text);
        prop_assert!(back.is_some(), "stringify produced unparsable {:?}", text);
        let back = back.unwrap();
        prop_assert_eq!(back.stringify(), text.clone());
        // serde_json agrees the text is valid JSON.
        prop_assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok(), "{:?}", text);
    }

    #[test]
    fn js_number_text_roundtrip(x in prop::num::f64::NORMAL | prop::num::f64::SUBNORMAL | prop::num::f64::ZERO) {
        let t = jsval::number_to_string(x);
        let y = jsval::to_number(&t);
        prop_assert!(y == x, "{x:e} -> {t:?} -> {y:e}");
    }

    #[test]
    fn js_quote_roundtrip(s in any::<String>()) {
        let mut q = String::new();
        jsval::quote(&s, &mut q);
        prop_assert_eq!(Js::parse(&q), Some(Js::Str(s)));
    }

    #[test]
    fn js_integer_text_is_plain_digits(n in -9_007_199_254_740_991i64..=9_007_199_254_740_991) {
        prop_assert_eq!(jsval::number_to_string(n as f64), n.to_string());
    }
}

// ---- glob_match against a regex oracle ------------------------------------------------------------------------

/// The documented rule as a regex: `*` any run but `/`, `**` any run, `?` one character but `/`, the rest literal.
fn glob_regex(pattern: &str) -> regex::Regex {
    let cs: Vec<char> = pattern.chars().collect();
    let mut src = String::from("(?s)^");
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            '*' if cs.get(i + 1) == Some(&'*') => {
                src.push_str(".*");
                i += 2;
                continue;
            }
            '*' => src.push_str("[^/]*"),
            '?' => src.push_str("[^/]"),
            c => src.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    src.push('$');
    regex::Regex::new(&src).unwrap()
}

fn glob_alpha() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(vec!["a", "b", "/", "*", "**", "?", ".", "é", "\n"]), 0..14).prop_map(|v| v.concat())
}

proptest! {
    #![proptest_config(cfg())]

    #[test]
    fn glob_equals_regex_oracle(p in glob_alpha(), t in glob_alpha()) {
        let want = glob_regex(&p).is_match(&t);
        prop_assert_eq!(glob_match(&p, &t), want, "pattern {:?} text {:?}", p, t);
    }

    #[test]
    fn glob_equals_regex_oracle_unicode(p in any::<String>(), t in any::<String>()) {
        let want = glob_regex(&p).is_match(&t);
        prop_assert_eq!(glob_match(&p, &t), want, "pattern {:?} text {:?}", p, t);
    }

    /// A pattern without wildcards matches exactly itself; `**` alone matches everything.
    #[test]
    fn glob_literal_and_universal(t in "[^*?]{0,30}") {
        prop_assert!(glob_match(&t, &t));
        prop_assert!(glob_match("**", &t));
    }
}

/// Worst case for a backtracking matcher: many wildcard-then-literal units against a long text that cannot match
/// (the old recursive matcher took O(text^units) here, i.e. never finished at these sizes).
#[test]
fn glob_pathological_is_linear() {
    for unit in ["*a", "**a", "**/a", "?*a", "**?a"] {
        let pat = unit.repeat(12) + "b";
        for text in ["a".repeat(2000), "a/".repeat(1000)] {
            let t0 = Instant::now();
            assert!(!glob_match(&pat, &text));
            assert!(t0.elapsed() < Duration::from_secs(2), "{unit:?} x12 on {} bytes took {:?}", text.len(), t0.elapsed());
        }
    }
    // And a pathological pattern that does match is still answered right.
    assert!(glob_match(&("**a".repeat(12) + "b"), &("a".repeat(2000) + "b")));
}

/// Regression (found by `heredoc_opener_parse_total`): `parse_heredoc_at` with a position past the end of the text indexed
/// out of bounds, where the JavaScript original reads `undefined` and answers.
#[test]
fn heredoc_opener_position_past_the_end_is_total() {
    let mut st = tk::ArithScan::new();
    assert!(tk::parse_heredoc_at(&[], 1, &mut st).is_none());
    let cs: Vec<char> = "a $((".chars().collect();
    let mut st = tk::ArithScan::new();
    assert!(tk::parse_heredoc_at(&cs, 99, &mut st).is_none());
}
