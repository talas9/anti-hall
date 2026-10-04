//! Outbound secret scrubbing: the one redaction point every Jev request body passes through.
//!
//! Mirrors `hooks/lib/secret-scrub.js` (`scrubSecrets`) rule for rule and in the same order, because the text it
//! returns is part of the request body and parity (D31) is checked byte for byte. The JavaScript source relies on
//! features the `regex` crate does not have (look-behind and back-references) and on JavaScript's own character
//! classes, so each translation is spelled out here:
//!
//! * `(?<![A-Za-z0-9])X` is a search that rejects a hit whose previous character is alphanumeric (`replace_lb`).
//! * `(["'])...\3` (a quote, text without that quote, the same quote) is the alternation of the two quote kinds.
//! * `\b` is ASCII-only in JavaScript, so it is written `(?-u:\b)`.
//! * `\s` is JavaScript's whitespace set (`WS`), not the Unicode `White_Space` property (they differ on U+0085
//!   and U+FEFF).
//! * the `i` flag is ASCII-only in JavaScript (without `u`), so keywords are expanded to explicit `[xX]` classes
//!   instead of using `(?i)`, which would also fold U+017F and U+212A.
use regex::Regex;
use std::sync::OnceLock;

/// The characters JavaScript's `\s` matches, as the inside of a character class.
const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// ASCII-case-insensitive form of a literal: each letter becomes a two-letter class.
fn ci(word: &str) -> String {
    word.chars()
        .map(|c| if c.is_ascii_alphabetic() { format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()) } else { regex::escape(&c.to_string()) })
        .collect()
}

/// Alternation of case-insensitive literals.
fn ci_any(words: &[&str]) -> String {
    words.iter().map(|w| ci(w)).collect::<Vec<_>>().join("|")
}

/// One rule: the expression, what replaces a hit, and whether a hit must not follow an ASCII alphanumeric.
struct Rule {
    re: Regex,
    to: &'static str,
    no_alnum_before: bool,
}

/// Compile a pattern that is a literal of this module (a failure is a bug the unit tests catch).
fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|e| panic!("jev scrub pattern {pattern:?}: {e}"))
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let b = r"(?-u:\b)";
        let key_words = ci_any(&["secret", "password", "passwd", "token", "apikey", "api_key", "key"]);
        // Any identifier containing a secret-ish word, then `:` or `=`.
        let named = format!(r"{b}([A-Za-z0-9_.-]*(?:{key_words})[A-Za-z0-9_.-]*)([\x22']?[{WS}]*[:=][{WS}]*)");
        let mut v: Vec<Rule> = Vec::new();
        let mut add = |pattern: String, to: &'static str, lb: bool| v.push(Rule { re: compile(&pattern), to, no_alnum_before: lb });
        // PEM blocks first (multi-line): header, body and footer all go.
        add(r"-----BEGIN [A-Z0-9 ]+-----(?s:.)*?(?:-----END [A-Z0-9 ]+-----|$)".into(), "[REDACTED_PEM]", false);
        // URL credentials: scheme://user:pass@host -> scheme://[REDACTED]@host
        add(format!(r"{b}([a-zA-Z][a-zA-Z0-9+.-]*://)[^{WS}/:@]+:[^{WS}/@]+@"), "${1}[REDACTED]@", false);
        // JWTs (three base64url segments, the first starting with eyJ).
        add(format!(r"{b}eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[REDACTED_JWT]", false);
        // Authorization header values, then bare Bearer tokens.
        add(
            format!(r#"{b}({}[\x22']?[{WS}]*[:=][{WS}]*[\x22']?)({}|{})[{WS}]+[^{WS}\x22']+"#, ci("Authorization"), ci("Basic"), ci("Bearer")),
            "${1}${2} [REDACTED]",
            false,
        );
        add(format!(r"{b}{}[{WS}]+[A-Za-z0-9\-_.=]+", ci("Bearer")), "Bearer [REDACTED]", false);
        // Standalone provider tokens.
        add(format!(r"[sr]k_(?:live|test)_[A-Za-z0-9]{{8,}}{b}"), "[REDACTED_KEY]", true);
        add(r"glpat-[A-Za-z0-9_-]{10,}".into(), "[REDACTED_KEY]", true);
        add(format!(r"npm_[A-Za-z0-9]{{20,}}{b}"), "[REDACTED_KEY]", true);
        add(format!(r"{b}(?:sk|pk)-[A-Za-z0-9]{{10,}}{b}"), "[REDACTED_KEY]", false);
        add(format!(r"{b}AIza[0-9A-Za-z_-]{{10,}}{b}"), "[REDACTED_KEY]", false);
        add(format!(r"{b}gh[pousr]_[A-Za-z0-9]{{10,}}{b}"), "[REDACTED_KEY]", false);
        add(format!(r"{b}xox[baprs]-[A-Za-z0-9-]{{10,}}{b}"), "[REDACTED_KEY]", false);
        // AWS access key ids (long-term AKIA, temporary ASIA).
        add(format!(r"{b}(?:AKIA|ASIA)[0-9A-Z]{{16}}{b}"), "[REDACTED_AWS_KEY]", false);
        // key=value assignments: a quoted value may hold spaces and runs to the closing quote; an unquoted one ends at
        // whitespace, a quote, a comma or a brace.
        add(format!(r#"{named}(?:\x22[^\x22\n]*\x22|'[^'\n]*')"#), "${1}${2}[REDACTED]", false);
        add(format!(r#"{named}(?:\x22[^{WS}\x22',}}]+\x22|'[^{WS}\x22',}}]+'|[^{WS}\x22',}}]+)"#), "${1}${2}[REDACTED]", false);
        add(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}".into(), "[REDACTED_EMAIL]", false);
        // Generic catch-all: any remaining long base64 or hex-like run.
        add(format!(r"{b}[A-Za-z0-9+/=_-]{{32,}}{b}"), "[REDACTED_TOKEN]", false);
        v
    })
}

/// True when `c` is an ASCII letter or digit.
fn alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// Replace every hit of `re`, skipping those that directly follow an ASCII alphanumeric (a look-behind). A rejected hit
/// resumes the search one character later, exactly as a backtracking engine would at the next start position.
fn replace_lb(re: &Regex, hay: &str, to: &str) -> String {
    let mut out = String::with_capacity(hay.len());
    let (mut last, mut at) = (0, 0);
    while at <= hay.len() {
        let Some(m) = re.find_at(hay, at) else { break };
        let rejected = hay[..m.start()].chars().next_back().is_some_and(alnum);
        if rejected {
            at = m.start() + hay[m.start()..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        out.push_str(&hay[last..m.start()]);
        out.push_str(to);
        last = m.end();
        at = if m.end() > m.start() { m.end() } else { m.end() + 1 };
    }
    out.push_str(&hay[last..]);
    out
}

/// Redact common secret shapes in `text` (best effort, not a security boundary by itself). Idempotent, pure, no I/O.
///
/// Node: `secret-scrub.js` `scrubSecrets`. The rules run in the same order, because the named shapes must be scrubbed
/// before the generic long-run catch-all so their short placeholders never re-trigger it.
pub fn scrub_secrets(text: &str) -> String {
    let mut s = text.to_string();
    for r in rules() {
        s = if r.no_alnum_before { replace_lb(&r.re, &s, r.to) } else { r.re.replace_all(&s, r.to).into_owned() };
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert_eq!(rules().len(), 17, "one rule per replace() in secret-scrub.js");
    }

    #[test]
    fn named_shapes_are_redacted() {
        assert_eq!(scrub_secrets("Authorization: Bearer abc.def"), "Authorization: Bearer [REDACTED]");
        assert_eq!(scrub_secrets("token=hunter2 x"), "token=[REDACTED] x");
        assert_eq!(scrub_secrets(r#"{"apiKey": "a b c"}"#), r#"{"apiKey": [REDACTED]}"#);
        assert_eq!(scrub_secrets("SECRET_KEY = 'a b c' tail"), "SECRET_KEY = [REDACTED] tail");
        assert_eq!(scrub_secrets("mail me@example.com now"), "mail [REDACTED_EMAIL] now");
        assert_eq!(scrub_secrets("postgres://u:p@host/db"), "postgres://[REDACTED]@host/db");
        assert_eq!(scrub_secrets("ghp_abcdefghij1234"), "[REDACTED_KEY]");
        assert_eq!(scrub_secrets("AKIAABCDEFGHIJKLMNOP"), "[REDACTED_AWS_KEY]");
    }

    #[test]
    fn lookbehind_rules_only_fire_after_a_non_alphanumeric() {
        assert_eq!(scrub_secrets("x glpat-abcdefghijk"), "x [REDACTED_KEY]");
        assert_eq!(scrub_secrets("xglpat-abcdefghijk"), "xglpat-abcdefghijk");
        assert_eq!(scrub_secrets("sk_live_abcdefgh1"), "[REDACTED_KEY]");
        assert_eq!(scrub_secrets("asksk_live_abcdefgh1"), "asksk_live_abcdefgh1");
    }

    #[test]
    fn pem_blocks_and_long_runs_go_and_plain_text_stays() {
        assert_eq!(scrub_secrets("a -----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY----- b"), "a [REDACTED_PEM] b");
        assert_eq!(scrub_secrets("run abcdefghijklmnopqrstuvwxyz0123456789 now"), "run [REDACTED_TOKEN] now");
        assert_eq!(scrub_secrets("just words, nothing to hide."), "just words, nothing to hide.");
    }

    #[test]
    fn scrubbing_is_idempotent() {
        let once = scrub_secrets("password=abc token: 'x y' me@a.io Bearer zzz");
        assert_eq!(scrub_secrets(&once), once);
    }
}
