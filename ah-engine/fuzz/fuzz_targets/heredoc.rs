#![no_main]
//! Oracle: no panic, no hang, no OOM on the heredoc opener parsers behind `shellScan.parseHeredocAt`.
use ah_engine::checks::git::tokenize as tk;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    let chars: Vec<char> = s.chars().collect();
    let mut st = tk::ArithScan::new();
    for i in 0..chars.len().min(64) {
        tk::parse_heredoc_at(&chars, i, &mut st);
        tk::parse_heredoc_raw(&chars, i);
    }
});
