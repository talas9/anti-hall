//! Every transcript or state parser that classifies "JavaScript reads this, serde does not" locally must catch every
//! class `guardkit::jsdiff::js_reads_differently` catches, in particular an integer of 309 or more digits (JavaScript reads
//! it as `Infinity`, serde rejects it as out of range) and an exponent overflow. One table, one assertion per site: a new
//! local classifier that misses a class fails here.
use super::jsdiff::js_reads_differently_str;

/// The documents JavaScript reads and serde rejects, each as a whole JSON line.
fn hazards() -> Vec<(&'static str, String)> {
    vec![
        ("309-digit integer", format!(r#"{{"type":"assistant","n":{}}}"#, "9".repeat(309))),
        ("400-digit integer", format!(r#"{{"type":"assistant","n":1{}}}"#, "0".repeat(399))),
        ("negative 309-digit integer", format!(r#"{{"type":"assistant","n":-{}}}"#, "9".repeat(309))),
        ("exponent overflow", r#"{"type":"assistant","n":1e400}"#.to_string()),
        ("lone surrogate", r#"{"type":"assistant","t":"\ud800"}"#.to_string()),
        ("nesting past 128", format!(r#"{{"type":"assistant","d":{}{}}}"#, "[".repeat(200), "]".repeat(200))),
    ]
}

#[test]
fn the_table_is_what_the_shared_helper_calls_different() {
    for (name, line) in hazards() {
        assert!(js_reads_differently_str(&line), "{name}");
    }
}

#[test]
fn compact_declaration_turn_scan_defers_on_every_class() {
    for (name, line) in hazards() {
        assert!(crate::checks::compact_decl::turn_texts(&[line]).is_none(), "{name}");
    }
}

#[test]
fn the_message_classified_parsers_defer_on_every_class() {
    for (name, line) in hazards() {
        assert!(crate::checks::replykit::transcript::parse_line(&line).is_err(), "replykit: {name}");
        assert!(crate::checks::agent_scan::parse_json(&line).is_err(), "agent_scan: {name}");
        assert!(crate::checks::jsport::text::parse_line(&line).is_err(), "jsport::text: {name}");
        assert!(matches!(crate::checks::session::jval::parse(&line), crate::checks::session::jval::Parsed::Unsure), "session::jval: {name}");
    }
}
