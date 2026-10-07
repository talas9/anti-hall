#![no_main]
//! Oracle: no panic, no hang, no OOM on any bytes (the libFuzzer timeout and rss limit are the hang and OOM checks).
use ah_engine::checks::git::tokenize as tk;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    let t = tk::tokenize(&s);
    tk::effective_verb(&t);
    tk::split_segments(&s);
    tk::backstop_pieces(&s);
    tk::backstop_verb(&s);
});
