//! Unit tests of the JavaScript-behavior helpers. Every expected value was produced by Node.
use super::date::{self, Parsed};
use super::json::{self, Fail, J};
use super::num::{self, JsNum};
use super::text;
use serde_json::json;

#[test]
fn numbers_print_the_way_string_of_n_does() {
    for (n, s) in [
        (1e21, "1e+21"),
        (1.5, "1.5"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (123456789012345680000.0, "123456789012345680000"),
        (0.1 + 0.2, "0.30000000000000004"),
        (-1.25e-9, "-1.25e-9"),
        (100.0, "100"),
        (1234567890123456789.0, "1234567890123456800"),
        (5e-324, "5e-324"),
        (f64::MAX, "1.7976931348623157e+308"),
        (0.000001234, "0.000001234"),
        (-0.0, "0"),
        (9007199254740992.0, "9007199254740992"),
        (1e20, "100000000000000000000"),
        (1.23e-18, "1.23e-18"),
        (4.35, "4.35"),
        (1e100, "1e+100"),
    ] {
        assert_eq!(num::to_js_string(n), s, "{n:e}");
    }
    assert_eq!(num::to_js_string(f64::NAN), "NaN");
    assert_eq!(num::to_js_string(f64::NEG_INFINITY), "-Infinity");
}

#[test]
fn math_round_ties_go_up() {
    for (x, r) in [(0.5, 1.0), (1.5, 2.0), (2.5, 3.0), (-0.5, 0.0), (-1.5, -1.0), (0.49999999999999994, 0.0), (7.0, 7.0)] {
        assert_eq!(num::js_round(x), r, "{x}");
    }
}

#[test]
fn number_of_a_string_follows_the_ecmascript_grammar() {
    use JsNum::{Nan, Val};
    for (s, want) in [
        ("5", Val(5.0)),
        ("+5", Val(5.0)),
        ("-5", Val(-5.0)),
        (".5", Val(0.5)),
        ("5.", Val(5.0)),
        ("1e3", Val(1000.0)),
        ("0x10", Val(16.0)),
        ("0b11", Val(3.0)),
        ("0o17", Val(15.0)),
        ("", Val(0.0)),
    ] {
        assert_eq!(num::parse_js_number(s), want, "{s:?}");
    }
    for s in ["abc", "1_000", "inf", "nan", "NaN", "5x", "1e", ".", "+", "--5", "0x", "0xZZ", "-0x10", "1 2", "٣"] {
        assert_eq!(num::parse_js_number(s), Nan, "{s:?}");
    }
    assert_eq!(num::parse_js_number("Infinity"), Val(f64::INFINITY));
    assert_eq!(num::parse_js_number("-Infinity"), Val(f64::NEG_INFINITY));
    assert_eq!(num::parse_js_number("0xFFFFFFFFFFFFFFFF"), JsNum::Unsure);
}

#[test]
fn json_keeps_insertion_order_and_orders_index_keys_first() {
    let v = json::parse(r#"{"b":1,"2":"x","a":[1,{"z":1,"y":2}],"1":"y","b":9}"#, 64).unwrap();
    assert_eq!(json::stringify(&v), r#"{"1":"y","2":"x","b":9,"a":[1,{"z":1,"y":2}]}"#);
    let v = json::parse(r#"{"n":1e21,"m":1.5e-7,"k":12345678901234567890,"z":-0,"i":1e999}"#, 64).unwrap();
    assert_eq!(json::stringify(&v), r#"{"n":1e+21,"m":1.5e-7,"k":12345678901234567000,"z":0,"i":null}"#);
}

#[test]
fn json_rejects_what_json_parse_rejects() {
    for t in ["", "{", "{'a':1}", "[1,]", "{\"a\":1,}", "01", "+1", "1.", ".5", "NaN", "\u{feff}{}", "{\"a\":\"\t\"}", "\"\\x41\"", "[1] x", "tru"] {
        assert_eq!(json::parse(t, 64), Err(Fail::Invalid), "{t:?}");
    }
    assert_eq!(json::parse(r#""\ud83d""#, 64), Err(Fail::Unsupported));
    assert_eq!(json::parse(r#""\ude00""#, 64), Err(Fail::Unsupported));
    assert_eq!(json::parse(r#""\ud83d\ude00""#, 64), Ok(J::Str("\u{1F600}".into())));
    assert_eq!(json::parse(&format!("{}1{}", "[".repeat(10), "]".repeat(10)), 5), Err(Fail::Unsupported));
}

#[test]
fn json_strings_are_quoted_like_stringify() {
    assert_eq!(json::quote("a\"b\\c\n\r\t\u{8}\u{c}\u{1}\u{1f}\u{7f}\u{2028}é"), "\"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f\u{7f}\u{2028}é\"");
}

#[test]
fn iso_strings_match_to_iso_string() {
    for (ms, s) in [
        (0.0, "1970-01-01T00:00:00.000Z"),
        (1.0, "1970-01-01T00:00:00.001Z"),
        (86399999.0, "1970-01-01T23:59:59.999Z"),
        (951782400000.0, "2000-02-29T00:00:00.000Z"),
        (-1.0, "1969-12-31T23:59:59.999Z"),
        (-62198755200000.0, "-000001-01-01T00:00:00.000Z"),
        (253402300800000.0, "+010000-01-01T00:00:00.000Z"),
        (8.64e15, "+275760-09-13T00:00:00.000Z"),
        (-8.64e15, "-271821-04-20T00:00:00.000Z"),
        (1788789012345.678, "2026-09-07T13:50:12.345Z"),
        (1000000000000.9, "2001-09-09T01:46:40.000Z"),
    ] {
        assert_eq!(date::to_iso(ms).as_deref(), Some(s), "{ms}");
    }
    assert_eq!(date::to_iso(8.64e15 + 1.0), None);
    assert_eq!(date::to_iso(f64::NAN), None);
}

#[test]
fn date_strings_with_a_zone_parse_as_node_does() {
    for (s, ms) in [
        ("2030-10-08T12:00:00Z", 1917691200000.0),
        ("2030-10-08T12:00:00.5Z", 1917691200500.0),
        ("2030-10-08", 1917648000000.0),
        ("2030-10-08T12:00:00+05:30", 1917671400000.0),
        ("2030-10-08T12:00:00.123456Z", 1917691200123.0),
        ("Oct 3 2030 9:11 PM UTC", 1917292260000.0),
        ("Oct 3, 2030 9:11 PM GMT", 1917292260000.0),
        ("Sat, Oct 3 2030 1:00 AM GMT", 1917219600000.0),
        ("Feb 31 2030 10:00 AM UTC", 1898762400000.0),
        ("Feb 29 2032 12:00 AM Z", 1961625600000.0),
        ("+002030-10-08T12:00:00Z", 1917691200000.0),
    ] {
        assert_eq!(date::parse(s), Parsed::Ms(ms), "{s}");
    }
    for s in ["hello", "May", "tomorrow at noon", ""] {
        assert_eq!(date::parse(s), Parsed::Nan, "{s:?}");
    }
    // shapes V8 reads in ways this port does not reproduce are unknown, never guessed
    for s in ["10/08/2030", "2030/10/08", "Oct 8 30", "2030-13-08T12:00:00Z", "Oct 3rd 2030", "12:00 PM", "Oct 3 2030 9:11 PM extra"] {
        assert_eq!(date::parse(s), Parsed::Unknown, "{s:?}");
    }
}

#[test]
fn utf16_helpers_count_units() {
    assert_eq!(text::len16("a\u{1F600}"), 3);
    assert_eq!(text::slice16_lossy("a\u{1F600}b", 2), "a\u{FFFD}");
    assert_eq!(text::slice16_lossy("a\u{1F600}b", 3), "a\u{1F600}");
    assert_eq!(text::tail16("a\u{1F600}b", 1).as_deref(), Some("b"));
    assert_eq!(text::tail16("a\u{1F600}b", 2), None);
    // default sort order is by UTF-16 unit: an astral character sorts before U+E000
    let mut v = vec!["\u{E000}", "\u{1F600}", "a"];
    v.sort_by(|a, b| text::cmp16(a, b));
    assert_eq!(v, ["a", "\u{1F600}", "\u{E000}"]);
}

#[test]
fn string_of_a_value_follows_javascript() {
    assert_eq!(text::js_string(&json!(null)), "null");
    assert_eq!(text::js_string(&json!([1, null, "a", [2, 3]])), "1,,a,2,3");
    assert_eq!(text::js_string(&json!({"a": 1})), "[object Object]");
    assert_eq!(text::js_string(&json!(1e21)), "1e+21");
    assert_eq!(text::string_or_empty(Some(&json!(0))), "");
    assert_eq!(text::string_or_empty(Some(&json!([]))), "");
    assert_eq!(text::string_or_empty(Some(&json!("x"))), "x");
    assert_eq!(text::sanitize_session("a/b_c-d é", "unknown"), "ab_c-d");
    assert_eq!(text::sanitize_session("///", "unknown"), "unknown");
}

#[test]
fn names_are_made_safe_per_utf16_unit() {
    assert_eq!(text::safe_name("a b.c\u{1F600}é"), "a_b.c___");
    assert_eq!(text::dash_name("/a.b\u{1F600}"), "-a-b--");
    assert_eq!(text::sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
}

#[test]
fn civil_dates_round_trip() {
    for d in [-800000i64, -1, 0, 1, 11016, 20000, 100000, 2932896] {
        let (y, m, dd) = date::civil_from_days(d);
        assert_eq!(date::days_from_civil(y, m, dd), d);
    }
}
