#![no_main]
//! Oracle: no panic, no hang, no OOM. The first byte splits the input into pattern and text.
use ah_engine::hookcfg::when::glob_match;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&k, rest)) = data.split_first() else { return };
    let s = String::from_utf8_lossy(rest);
    let cut = (k as usize) % (s.len() + 1);
    let cut = (0..=cut).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0);
    glob_match(&s[..cut], &s[cut..]);
});
