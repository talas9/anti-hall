#![no_main]
//! Oracle: no panic, no hang, no OOM; every extracted body is a substring of the command.
use ah_engine::checks::command::shell;
use ah_engine::checks::git::tokenize as tk;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    // `<<-` strips leading tabs from the body, so compare tab-free.
    let flat = s.replace('\t', "");
    if s.is_ascii() {
        for b in shell::heredoc_bodies_in(&s) {
            assert!(flat.contains(&b.replace('\t', "")));
        }
    }
    let chars: Vec<char> = s.chars().collect();
    let mut st = tk::ArithScan::new();
    for i in 0..chars.len().min(64) {
        tk::parse_heredoc_at(&chars, i, &mut st);
        tk::parse_heredoc_raw(&chars, i);
    }
});
