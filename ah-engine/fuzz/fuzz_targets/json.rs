#![no_main]
//! Oracle: no panic, no hang, no OOM; whatever parses re-serializes to text that parses back to the same text.
use ah_engine::checks::guardkit::jsval::{self, Js};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    if let Some(v) = Js::parse(&s) {
        let t = v.stringify();
        assert_eq!(Js::parse(&t).map(|x| x.stringify()), Some(t));
    }
    jsval::parse_line(&s);
    jsval::fix_lone_surrogates(&s);
    jsval::to_number(&s);
    jsval::date_parse(&s);
});
