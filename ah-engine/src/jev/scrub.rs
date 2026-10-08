//! Outbound secret scrubbing: the one redaction point every Jev request body passes through.
//!
//! The rules are data (`jev.scrub_rules` in the plugin's `jev.toml`), compiled per defaults snapshot. They mirror
//! `hooks/lib/secret-scrub.js` (`scrubSecrets`) rule for rule and in the same order, because the text this returns is part
//! of the request body and parity (D31) is checked byte for byte. The JavaScript source relies on features the `regex`
//! crate does not have (look-behind and back-references) and on JavaScript's own character classes, so the shipped
//! patterns spell each translation out:
//!
//! * `(?<![A-Za-z0-9])X` is a search that rejects a hit whose previous character is alphanumeric (`replace_lb`).
//! * `(["'])...\3` (a quote, text without that quote, the same quote) is the alternation of the two quote kinds.
//! * `\b` is ASCII-only in JavaScript, so it is written `(?-u:\b)`.
//! * `\s` is JavaScript's whitespace set (an explicit class), not the Unicode `White_Space` property (they differ on U+0085
//!   and U+FEFF).
//! * the `i` flag is ASCII-only in JavaScript (without `u`), so keywords are expanded to explicit `[xX]` classes
//!   instead of using `(?i)`, which would also fold U+017F and U+212A.
use crate::defaults::{self, V};
use regex::Regex;

/// One rule: the expression, what replaces a hit, and whether a hit must not follow an ASCII alphanumeric.
struct Rule {
    re: Regex,
    to: String,
    no_alnum_before: bool,
}

/// The rules of `jev.scrub_rules`, compiled once per defaults snapshot (a reload applies an edit). `None` when a rule is
/// malformed or does not compile: the scrubber then redacts the whole text.
fn rules() -> Option<&'static [Rule]> {
    static RULES: defaults::Cache<Option<Vec<Rule>>> = defaults::Cache::new();
    RULES
        .get_or_init(|| {
            defaults::raw("jev.scrub_rules")
                .as_array()?
                .iter()
                .map(|r| {
                    Some(Rule {
                        re: Regex::new(r.get("pattern").and_then(V::as_str)?).ok()?,
                        to: r.get("to").and_then(V::as_str)?.to_string(),
                        no_alnum_before: r.get("no_alnum_before").and_then(V::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .as_deref()
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
    let Some(rules) = rules() else { return defaults::text("jev.scrub_failed_text").to_string() };
    let mut s = text.to_string();
    for r in rules {
        s = if r.no_alnum_before { replace_lb(&r.re, &s, &r.to) } else { r.re.replace_all(&s, r.to.as_str()).into_owned() };
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert_eq!(rules().map(<[Rule]>::len), Some(17), "one rule per replace() in secret-scrub.js");
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
