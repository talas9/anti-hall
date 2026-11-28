//! `ah.transcript.features`: the patterns a script hands it.
use crate::script::host_ts::features;

fn file(tag: &str, text: &str) -> String {
    let p = crate::tmpsweep::scratch("ah-feat-", tag).join("t.jsonl");
    std::fs::write(&p, text).unwrap();
    p.to_string_lossy().to_string()
}

/// A configured pattern in JavaScript-only syntax (a lookahead) is an error to the script, counted, and never an abort of the daemon.
#[test]
fn a_pattern_the_engine_cannot_compile_is_an_error_to_the_script_not_an_abort() {
    let p = file("lookahead", "x12 foo bar\n");
    let spec = r#"{"needles":["x"],"res":[{"src":"foo(?=bar)","flags":""}]}"#;
    let before = crate::metrics::bumped_on_this_thread("script_regex_invalid", &[]);
    let e = features(&p, 1e6, spec).expect_err("a lookahead is not compilable here");
    assert!(format!("{e}").contains("foo(?=bar)"), "{e}");
    assert_eq!(crate::metrics::bumped_on_this_thread("script_regex_invalid", &[]), before + 1);
}

#[test]
fn a_valid_pattern_reports_its_captures() {
    let p = file("captures", "x12 and y\nnothing\n");
    let spec = r#"{"needles":["x"],"res":[{"src":"x(\\d+)","flags":""},{"src":"nomatch","flags":""}]}"#;
    assert_eq!(features(&p, 1e6, spec).unwrap(), r#"[{"m":[],"p":{},"r":[["x12","12"],null]}]"#);
}
