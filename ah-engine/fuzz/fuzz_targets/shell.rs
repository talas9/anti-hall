#![no_main]
//! `command::shell` is ASCII-only by contract (the command check defers anything else), so the primitives run on ASCII input
//! and the public gate runs on everything. Oracle: no panic, no hang, no OOM; segments are never blank and match their delimiters one to one.
use ah_engine::checks::command::shell;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    ah_engine::checks::command::decide_in(&s, Some("/repo"), data.first().is_some_and(|b| b & 1 == 1));
    if !s.is_ascii() {
        return;
    }
    let sp = shell::split_detailed(&s);
    assert_eq!(sp.segments.len(), sp.delims.len());
    assert!(sp.segments.iter().all(|x| !shell::trim(x).is_empty()));
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
    shell::segment_heredoc_bodies(&sp.segments, &s);
});
