//! The optional Jev lane (D34 to D38).
//!
//! Jev is TypeSafe's "System One" decision model, reached through the Vercel AI Gateway or TypeSafe's own API. It is a
//! judgement lane, not a rule engine: anything a deterministic rule can decide never goes to Jev (D34), and nothing here
//! is on a hot path while Jev is off.
//!
//! The module is a port of the Node client and layer it replaces, each file citing the Node functions it mirrors:
//!
//! | File | Node source | What it does |
//! |---|---|---|
//! | `scrub` | `secret-scrub.js` | redacts secrets from every outbound text |
//! | `settings` | `jev-client.js` `loadJevConfig`, `jev-assist.js` `getMode`, `settings.js` | resolves settings and each integration's mode |
//! | `credentials` | `credentials.js` | a key goes only to the vendor it was entered for |
//! | `question` | the question objects callers build | the Noul and Choice questions and their wire form |
//! | `loopback` | `jev-client.js` `loopbackEndpointOrNull` | which test endpoint may receive a key, canonicalised |
//! | `transport` | `jev-client.js` `postSystemone` | one HTTP request under one deadline; no redirects, no proxy |
//! | `breaker` | `jev-client.js` breaker | per-vendor circuit breaker with a half-open probe |
//! | `client` | `jev-client.js` `jevDecide`, `runWithFallback` | a decision call with an optional backup vendor |
//! | `cache`, `log` | `jev-assist.js` cache and `appendLog` | content-hash cache and the `jev-assist.ndjson` rows |
//! | `keep` | `jev-assist.js` `maybeWarnBudget`, `maybeWriteAuditSnippet`, `writeDailyRollups` | the budget watch, the audit snippets and the daily rollups |
//! | `shared` | `jev-assist.js` `turnRefFromTranscript` | the process-wide lanes the checks ask through |
//! | `cascade` | (new) | re-judges a Jev answer under the escalation threshold with the Claude CLI |
//! | `assist` | `jev-assist.js` `ask`, `finalize` | modes, trust rules, budget, async queue, metrics |
//!
//! The decision record's rules for this lane: static checks never route to Jev (D34); every Jev decision has a
//! deterministic non-Jev path and the engine behaves as if Jev were absent when it is off, missing, over budget or
//! failing (D35); Jev may add a block or advisory, and an explicitly enabled relax-block integration may relax a
//! blocking baseline when Jev confidently says it should not stand; Jev is never the sole safety gate (D36);
//! the per-call budget, timeout, cache, warm connection and async queue live in [`assist::Jev`] (D36).
pub mod assist;
pub mod breaker;
pub mod cache;
pub mod cascade;
pub mod cli;
pub mod client;
pub mod credentials;
pub mod error;
pub mod keep;
pub mod log;
pub mod loopback;
pub mod question;
pub mod scrub;
pub mod settings;
pub mod shared;
pub mod transport;

#[cfg(test)]
pub(crate) mod testkit;

pub use assist::{AskRequest, Decision, Jev, Trust};
pub use error::{JevError, Reason};
pub use question::Question;
pub use settings::{Env, JevSettings, Mode, Vendor};

/// True for the characters JavaScript's `String.prototype.trim` and the `\s` class treat as whitespace.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `text.trim()` as JavaScript does it (not Rust's `str::trim`, whose whitespace set differs on U+0085 and U+FEFF).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}
