//! The one answer to "could JavaScript read this JSON where `serde_json` cannot?".
//!
//! `serde_json` rejects a few documents that `JSON.parse` accepts: a lone surrogate escape (what `JSON.stringify` itself emits for a
//! cut-off astral character), a number outside the f64 range (`1e400`, or an integer literal of 309 or more digits, which JavaScript
//! reads as `Infinity`) and nesting past the 128-level recursion limit. A file like that is NOT absent or invalid for Node: Node reads
//! it and acts. An engine check that treated it as absent would decide differently from Node (a silent allow where Node blocks, a
//! missing advisory), so every engine read of a file Node also reads asks this helper first and DEFERS to Node when it says yes.
//! Any other parse error is one JavaScript has too, so the file is missing/invalid for both.
use serde_json::Value;

/// True when `txt` is rejected by `serde_json` for a reason `JSON.parse` does not share.
pub fn js_reads_differently_str(txt: &str) -> bool {
    match serde_json::from_str::<Value>(txt) {
        Ok(_) => false,
        Err(e) => {
            let m = e.to_string();
            m.contains("out of range")
                || m.contains("recursion limit")
                || m.contains("surrogate")
                || m.contains("hex escape")
                || m.contains("unicode code point")
        }
    }
}

/// [`js_reads_differently_str`] on file bytes, decoded as Node decodes them (UTF-8, bad bytes replaced).
pub fn js_reads_differently(bytes: &[u8]) -> bool {
    js_reads_differently_str(&String::from_utf8_lossy(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_class_is_caught() {
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let big_int = format!("{{\"x\":1{}}}", "0".repeat(400));
        for (name, doc) in [
            ("exponent overflow", "{\"x\":1e400}".to_string()),
            ("309+ digit integer", big_int),
            ("lone high surrogate", "{\"x\":\"\\ud800\"}".to_string()),
            ("lone low surrogate", "{\"x\":\"\\udc00\"}".to_string()),
            ("nesting past 128", deep),
        ] {
            assert!(js_reads_differently(doc.as_bytes()), "{name}");
        }
    }

    #[test]
    fn ordinary_documents_are_not() {
        for doc in ["{\"x\":1e300}", "{\"x\":\"\\ud83d\\ude00\"}", "{\"a\":[1,2]}", "{not json", "", "{\"x\":1,}"] {
            assert!(!js_reads_differently(doc.as_bytes()), "{doc}");
        }
    }
}
