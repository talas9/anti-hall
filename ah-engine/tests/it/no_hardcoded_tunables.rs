//! D17: every tunable, table, message text, path, env-var name, limit and timeout lives in `defaults/*.toml`.
//!
//! This test scans the non-test source for the shapes those things take in Rust and fails on any it finds that is
//! not on the allowlist below. The allowlist is for STRUCTURAL constants only (wire protocol, host protocol field
//! names, shell and regex grammar, security modes, status words); every entry says why it is structural. A new
//! tunable therefore cannot land in code without either moving to the defaults or being justified here in review.
//!
//! What it checks (comments and `#[cfg(test)]` modules are ignored):
//!  1. `Duration::from_*(<number>)`: a timeout or interval.
//!  2. `env::var*("<literal>")`: an environment variable name.
//!  3. `const`/`static` items holding a number, a string or a list of strings.
//!  4. message-like string literals: 30+ characters and 4+ words, not a raw regex pattern.
//!  5. `matches!(.., "a" | "b" | "c" ..)`: a table written as a pattern.
//!  6. array literals of three or more strings: a table.
//!  7. a size, cap or threshold written as a number in a call that bounds something (`.take(n)`, `.truncate(n)`, a buffer
//!     `[0u8; n]`, `with_capacity(n)`, a shift `1 << n`, a `len()`/`count()`/depth compared with a number of 7 or more),
//!     and a default written into a settings read (`int(.., default, min)`).
//!  8. short message text: two or more words and 12 or more characters, not a format string, pattern or SQL.
//!  9. a file or directory name (`.anti-hall`, `x.json`, ...).
//!
//! The ratchet (`no_new_hardcoded_literals`, owner rule: no hardcoding): three broader shapes that the checks above let
//! through, held against `tests/it/hardcoded_baseline.txt`. A line in the baseline is known debt waiting to move to
//! the plugin's `engine/defaults/*.toml`; a NEW line is a failure, and a baseline line that no longer occurs is a failure too, so the list only
//! shrinks. Regenerate it with `AH_BLESS_BASELINE=1 cargo test --test it -- no_hardcoded_tunables::` (review the diff).
//! 10. a number of 10 or more in a limit or comparison context (`.take(N)`, `[..N]`, `.min(N)`, `> N`, `with_capacity(N)`...);
//! 11. a short message: a string literal of 3+ words and 15+ characters that is not a developer diagnostic;
//! 12. a duration built from arithmetic on literals (`Duration::from_secs(5 * 60)`, `sleep(Duration::...)`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::fs;
use std::path::{Path, PathBuf};

/// (file suffix, substring of the offending line, reason it is structural).
const ALLOW: &[(&str, &str, &str)] = &[
    // ---- wire and host protocols: part of the interface, versioned with it, not tunables --------------------
    (
        "src/diag.rs",
        "",
        "the `diag heap` developer report (`--features diag`, absent from every release build): its table layout and usage text are the tool's own output format, not engine messages or tunables",
    ),
    (
        "src/main.rs",
        "static ALLOC",
        "the dhat allocator hook of the `diag` feature (developer diagnostics only, not compiled into a release build): a global-allocator declaration, not a tunable",
    ),
    ("src/frame.rs", "const MAGIC", "reply frame magic: the wire format identifier"),
    ("src/frame.rs", "const END", "reply frame trailer: the wire format identifier"),
    ("src/spool.rs", "const MAGIC", "spool record magic: the on-disk spool format identifier, versioned with the format"),
    (
        "src/hooksgen.rs",
        "",
        "layout of the generated JSON files (indentation and punctuation of hooks.json and its registry): a file format the plugin ships byte for byte, not a tunable and not a message the engine shows",
    ),
    ("src/hookio.rs", "pub const EXIT2", "reply-body marker for an exit-2 block: internal wire contract between daemon and client"),
    ("src/hookio.rs", "pub const EXACT", "reply-body marker for a check's exact exit code and bytes: internal wire contract between daemon and client"),
    ("src/hookio.rs", "pub const FALLBACK", "reply-body marker for a deferral: internal wire contract between daemon and client"),
    (
        "src/docs.rs",
        "writeln!",
        "layout of the generated Markdown reference (headings, table headers): the generator's own format, not a tunable and not a message the engine shows at run time",
    ),
    ("src/docs.rs", "\"| `{}` |", "row layout of the generated Markdown reference"),
    ("src/docs.rs", "\\n## ", "section headings and intro lines of the generated Markdown reference: the generator's own format"),
    ("src/checks/git/tokenize.rs", "pub const CMDSUBST", "internal sentinel the tokenizer inserts for a command substitution; never shown to a user"),
    ("src/memstat.rs", "static INNER", "the allocator the counters wrap: a compile-time choice by target, code not configuration"),
    ("src/main.rs", "static ALLOC", "the global allocator item: a language construct, not a value"),
    ("src/load.rs", "static SCAN_BYTES", "a thread-local counter initialised to zero: state, not a tunable"),
    ("src/load.rs", "static REQUEST", "a thread-local slot initialised empty: state, not a tunable"),
    (
        "src/checks/scripted.rs",
        "Scripted::new(",
        "the registry identity of a scripted check: its name and the defaults key of its summary, which is how the registry is addressed, not a tunable",
    ),
    ("src/checks/scripted.rs", "const fn new(", "the constructor signature of the registry identity above"),
    ("src/script/mod.rs", "static POOL", "a thread-local slot for the worker's interpreter, initialised empty: state, not a tunable"),
    ("src/script/host.rs", "static CALL", "a thread-local slot for the request state of one script call, initialised empty: state, not a tunable"),
    ("src/script/host.rs", "static RES", "a thread-local regex cache, initialised empty (its size bound is script.regex_cache_max): state, not a tunable"),
    ("src/deadline.rs", "static REQ", "a thread-local slot initialised empty (the request being served): state, not a tunable"),
    ("src/telemetry/mod.rs", "static STAGE", "a thread-local slot initialised empty (what a request staged): state, not a tunable"),
    ("src/checks/mod.rs", "static ALL", "the check registry: the list of compiled-in checks is code, not configuration"),
    ("src/cli.rs", "for name in [\"kind\"", "the impact command's filter flag names: part of the command line itself"),
    ("src/cli.rs", "for name in [\"check\"", "the metrics command's flag names: part of the command line itself"),
    ("src/cli.rs", "for name in [\"job\"", "the schedule history command's flag names: part of the command line itself"),
    ("src/rules.rs", "for k in [\"command\"", "tool_input field names a rule can match by default: the host hook payload schema, an adapter concern (D30)"),
    (
        "src/dispatch/combine.rs",
        "const ",
        "field names of the host's hook output JSON (hookSpecificOutput, additionalContext, ...): the host protocol schema the merge reads, an adapter concern (D30)",
    ),
    (
        "src/dispatch/mod.rs",
        "dispatch-stdin-",
        "temporary stdin spool filename prefix: an internal file naming pattern under the private state dir, not a tunable",
    ),
    (
        "src/dispatch/mod.rs",
        "could not create unique dispatch stdin file",
        "internal I/O error text for exhausting unique temp names; not user-facing configuration",
    ),
    ("src/health.rs", "for key in [\"breaker_until\"", "keys of the files.* settings the operator reset clears: names of settings, not values"),
    // ---- telemetry: the event schema and the recorder's memory layout ------------------------------------------------
    (
        "src/telemetry/event.rs",
        "",
        "the telemetry event schema: the field names of the line format shared with the Node route log, and the length of a UTC day; versioned with the format, not tunables",
    ),
    (
        "src/telemetry/recorder.rs",
        "const F_",
        "offsets of a counter slot's fields (count, latency sum, injected bytes, first bucket): the in-memory layout of the recorder, not a tunable",
    ),
    ("src/telemetry/recorder.rs", "static THREAD_ID", "a thread-local cell holding the thread's shard number: structural"),
    (
        "src/telemetry/emit.rs",
        "static BATCH",
        "a thread-local buffer that starts empty and holds the current call's events until they are written: state, not a tunable",
    ),
    (
        "src/telemetry/emit.rs",
        "static ITEMS",
        "a thread-local counter initialised to zero: the items the running command reports as changed: state, not a tunable",
    ),
    (
        "src/checks/jsport/date.rs",
        "static ZONE_OK",
        "a thread-local cell holding whether the local time zone matches the request's: per-check scratch state, structural",
    ),
    // ---- bootstrap: what must be known to find the configuration (D17 amended) -------------------------------------
    (
        "src/bootstrap.rs",
        "",
        "the fixed layout the engine needs to find the plugin's files, which no file can say about itself: the plugin-relative index path, the root environment variables, the cache and error file names, the wrapper's fallback exit code, the dev-checkout search depth",
    ),
    (
        "src/defaults.rs",
        "",
        "the loader's own diagnostics and storage: they report on the very files that supply every other text, so they cannot come from them",
    ),
    (
        "src/defaults/load.rs",
        "",
        "the loader's validation diagnostics and the snapshot-cache format identifiers (magic and trailer): they describe the files that would supply every other text, and the cache layout is a file format versioned with the binary",
    ),
    (
        "src/cli.rs",
        "[\"version\", \"status\"",
        "the commands that start with the daemon's snapshot cache instead of parsing the files: decided before any defaults are loaded, so it cannot be a shipped setting",
    ),
    ("src/cli.rs", "schedule history", "control-verb grammar of the daemon socket (like CTL ping): a protocol word, not a message"),
    ("src/cli.rs", "schedule list", "control-verb grammar of the daemon socket (like CTL ping): a protocol word, not a message"),
    // ---- JavaScript parity: formats and error names that mirror V8, compared with Node ------------------------------
    ("src/checks/agent_scan/mod.rs", ".take(3)", "the three-letter zone abbreviation of a JavaScript Date string (a format)"),
    (
        "src/checks/ctxbudget/phrase.rs",
        "const STAND_IN: u32",
        "a Unicode plane (private use B) holding the stand-ins of UTF-16 surrogate units: an encoding fact, not a tunable",
    ),
    ("src/checks/ctxbudget/phrase.rs", "const SURROGATE: u32", "the first UTF-16 high-surrogate code unit: an encoding fact, not a tunable"),
    ("src/checks/ctxbudget/limit.rs", ".take(3)", "milliseconds are three digits of an ISO timestamp (a format)"),
    ("src/transcript/record.rs", ".take(3)", "milliseconds are three digits of an ISO timestamp (a format)"),
    ("src/transcript/record.rs", "b.len() < 20", "the shortest ISO-8601 timestamp is 20 characters (a format)"),
    ("src/jev/keep.rs", "b.len() < 20", "the shortest ISO-8601 timestamp is 20 characters (a format)"),
    ("src/checks/taskstate/tail.rs", "b.len() >= 20", "the shortest ISO-8601 timestamp is 20 characters (a format)"),
    ("src/checks/ctxbudget/mod.rs", "#[doc = concat!", "a generated rustdoc attribute, not run-time text"),
    (
        "src/migrate/mod.rs",
        "out.len() < 11",
        "the length of `Math.random().toString(36).slice(2)` that the Node migration writes: a JavaScript format, compared byte for byte",
    ),
    ("src/checks/jsport/json.rs", "[0u8; 4]", "the encoding buffer of one UTF-8 character (at most 4 bytes)"),
    ("src/checks/guardkit/filelock.rs", "[0u8; 256]", "the hostname buffer of gethostname (HOST_NAME_MAX is 255 on every supported system)"),
    ("src/checks/guardkit/nodelock.rs", "[0u8; 256]", "the hostname buffer of gethostname (HOST_NAME_MAX is 255 on every supported system)"),
    ("src/checks/guardkit/nodelock.rs", "out.len() < 11", "a base-36 u32 is at most 7 digits plus the separators of Node's lock name (a format)"),
    ("src/checks/jsport/home.rs", "16384", "the buffer of getpwuid_r, sized by the C library's recommendation"),
    ("src/checks/guardkit/jsval/mod.rs", "b.len() > 10", "a JavaScript array index is at most 10 digits (4294967294): the language's own limit"),
    ("src/checks/guardkit/ojson.rs", "k.len() > 10", "a JavaScript array index is at most 10 digits (4294967294): the language's own limit"),
    (
        "src/checks/guardkit/jsdiff.rs",
        "m.contains(",
        "the names serde_json uses for the errors JavaScript's JSON.parse does not give: the parity boundary, compared with Node",
    ),
    (
        "src/checks/session/jval.rs",
        "m.contains(",
        "the names serde_json uses for the errors JavaScript's JSON.parse does not give: the parity boundary, compared with Node",
    ),
    (
        "src/checks/guardkit/jsdiff_sites.rs",
        "",
        "the corpus of inputs JavaScript reads differently, run through every local classifier: test data in a shared helper file",
    ),
    ("src/checks/guardkit/jsval/mod.rs", "f.write_str(", "a serde visitor's type description (a developer diagnostic)"),
    ("src/checks/guardkit/ojson.rs", "f.write_str(", "a serde visitor's type description (a developer diagnostic)"),
    ("src/checks/session/jval.rs", "f.write_str(", "a serde visitor's type description (a developer diagnostic)"),
    ("src/jev/question.rs", "f.write_str(", "a serde visitor's type description (a developer diagnostic)"),
    ("src/checks/guardkit/turn_gate.rs", "t.jsonl", "a file name in a unit-test fixture"),
    // ---- git output and flag layouts ------------------------------------------------------------------------------
    ("src/checks/git/segments.rs", ".take(2)", "the XY status columns of `git status --porcelain` (a format)"),
    ("src/checks/git/segments.rs", ".skip(3)", "the path starts after the XY columns and a space of `git status --porcelain` (a format)"),
    ("src/checks/git/runner.rs", "chars().count() > 10", "a `--replace=` flag carries a value when it is longer than the flag name (a flag's own shape)"),
    // ---- layouts of generated output and the wire --------------------------------------------------------------------
    ("src/docs.rs", "chars().count() > 80", "the width a value is cut to in the generated Markdown reference (the generator's format)"),
    ("src/frame.rs", ".take(64)", "the longest reply-frame header scanned: a bound of the wire format"),
    // ---- the database schema: code, versioned by its migrations; every tunable value is a bound parameter ---------
    (
        "src/sql.rs",
        "",
        "the SQL schema migrations and statements: the schema is code, versioned with the binary, and every tunable value is bound as a parameter at run time",
    ),
];

/// The shapes of rule 7: a bound or threshold written as a literal number.
fn bound_literal(line: &str) -> bool {
    use regex::Regex;
    use std::sync::OnceLock;
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    let res = RES.get_or_init(|| {
        [
            r"\.(take|truncate|skip)\(\s*(?:[2-9]|\d{2,})\b",
            r"with_capacity\([^)]*\d",
            r"\[\s*0u8\s*;\s*[^\]]*\d",
            r"\b1\s*<<\s*\d{2}\b",
            r"(?:len\(\)|count\(\)|\.rec|\.depth)\s*(?:>=|<=|>|<)\s*(?:[7-9]|\d{2,})\b",
            r"\bint\([^;]*\),\s*\d+\s*,\s*\d+\)",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    res.iter().any(|r| r.is_match(line))
}

/// Rule 8: a short message (two or more words, 12 or more characters) that is not a format string, a pattern or SQL.
fn short_message(s: &str) -> bool {
    s.chars().count() >= 12
        && s.split_whitespace().count() >= 2
        && s.chars().filter(|c| c.is_alphabetic()).count() >= 6
        && !s.contains(['{', '}', '\\', '^', '$', '|', '[', ']', '(', ')', '+', '*', '?', '<', '>', '=', ';', ':'])
        && !s.contains("PRAGMA")
}

/// Rule 9: a file or directory name.
fn file_name_literal(s: &str) -> bool {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    s == ".anti-hall" || RE.get_or_init(|| Regex::new(r"^[\w.-]+\.(json|toml|md|log|lock|db|sock|txt|jsonl|ndjson|sh)$").unwrap()).is_match(s)
}

/// Files that are not engine code paths (test helpers).
const SKIP_FILES: &[&str] = &["tests.rs", "golden.rs"]; // golden.rs: the cfg(test) corpus harness of the scripted checks

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") && !SKIP_FILES.iter().any(|s| p.ends_with(s)) {
            out.push(p);
        }
    }
}

/// Source lines worth checking: no comments, no inline `#[cfg(test)] mod tests { .. }` tail.
fn code_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim_start();
        if t.starts_with("#[cfg(test)]") {
            if lines.get(i + 1).is_some_and(|n| n.trim_start().starts_with("mod tests {")) {
                break; // inline test module: everything after is test code
            }
            continue; // `#[cfg(test)] mod tests;` points at tests.rs
        }
        if t.starts_with("//") {
            continue;
        }
        out.push((i + 1, strip_trailing_comment(l)));
    }
    out
}

/// Drop a `// ...` tail that is not inside a string literal.
fn strip_trailing_comment(l: &str) -> String {
    let b = l.as_bytes();
    let (mut in_str, mut i) = (false, 0);
    while i < b.len() {
        match b[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'/' if !in_str && b.get(i + 1) == Some(&b'/') => return l[..i].to_string(),
            _ => {}
        }
        i += 1;
    }
    l.to_string()
}

fn string_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '"' && !(i > 0 && b[i - 1] == '\'' && b.get(i + 1) == Some(&'\'')) {
            let raw = i > 0 && (b[i - 1] == 'r' || b[i - 1] == '#');
            let mut j = i + 1;
            let mut s = String::new();
            while j < b.len() && b[j] != '"' {
                if b[j] == '\\' && !raw {
                    j += 1;
                }
                if j < b.len() {
                    s.push(b[j]);
                }
                j += 1;
            }
            if !raw {
                out.push(s);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// True when the line has `["..."` that starts an array literal (not an index such as `v["key"]`, and not a
/// `[` that is itself inside a string).
fn has_array_literal(line: &str) -> bool {
    let b: Vec<char> = line.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == '\\' {
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' && !(i > 0 && b[i - 1] == '\'' && b.get(i + 1) == Some(&'\'')) {
            in_str = true;
        } else if c == '[' && b.get(i + 1) == Some(&'"') {
            let prev = b[..i].iter().rev().find(|c| !c.is_whitespace());
            if !prev.is_some_and(|c| c.is_alphanumeric() || *c == '_' || *c == ']' || *c == ')') {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn violations(file: &Path, text: &str) -> Vec<String> {
    let mut v = Vec::new();
    let name = file.to_string_lossy().replace('\\', "/");
    for (n, line) in code_lines(text) {
        let t = line.trim();
        let mut hit = |rule: &str| {
            if !ALLOW.iter().any(|(f, sub, _)| name.ends_with(f) && line.contains(sub)) {
                v.push(format!("{name}:{n}: [{rule}] {}", t.chars().take(150).collect::<String>()));
            }
        };
        let re_dur = ["from_millis(", "from_secs(", "from_micros(", "from_nanos("];
        for d in re_dur {
            if let Some(p) = line.find(&format!("Duration::{d}")) {
                let rest = &line[p + "Duration::".len() + d.len()..];
                if rest.trim_start().starts_with(|c: char| c.is_ascii_digit()) {
                    hit("timeout literal");
                }
            }
        }
        for f in ["env::var(\"", "env::var_os(\""] {
            if line.contains(f) {
                hit("env var literal");
            }
        }
        let is_item = ["const ", "static "].iter().any(|k| t.starts_with(k) || t.starts_with(&format!("pub {k}")) || t.starts_with(&format!("pub(crate) {k}")));
        if is_item && !t.contains("defaults::Cache") && !t.contains("OnceLock") && !t.contains("Atomic") && !t.contains("Mutex") {
            hit("const/static literal");
        }
        let lits = string_literals(&line);
        // developer-facing diagnostics of a bug (never shown to a user or agent) are not message text
        let dev_diag = ["panic!(", ".expect(", "unreachable!("].iter().any(|k| line.contains(k));
        if !is_item && !dev_diag && lits.iter().any(|s| s.chars().count() >= 30 && s.split_whitespace().count() >= 4) {
            hit("message text");
        }
        if let Some(p) = line.find("matches!(") {
            let alts = line[p..].matches("\" | \"").count();
            if alts >= 2 {
                hit("matches! table");
            }
        }
        if !is_item && !line.contains("assert") && bound_literal(&line) {
            hit("bound literal");
        }
        if !is_item && !dev_diag && lits.iter().any(|s| short_message(s)) {
            hit("short message");
        }
        if !is_item && !line.contains("defaults::") && lits.iter().any(|s| file_name_literal(s)) {
            hit("file name");
        }
        if !is_item && lits.len() >= 3 && !line.contains("format!") && !line.contains("assert") && has_array_literal(&line) {
            hit("string array");
        }
    }
    v
}

#[test]
fn no_hardcoded_tunables() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    files.sort();
    let mut all = Vec::new();
    for f in &files {
        all.extend(violations(f, &fs::read_to_string(f).unwrap()));
    }
    assert!(all.is_empty(), "{} hard-coded tunables (move them to defaults/*.toml or justify them in the allowlist):\n{}", all.len(), all.join("\n"));
}

#[test]
fn allowlist_entries_are_justified_and_still_needed() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    for (suffix, sub, reason) in ALLOW {
        assert!(reason.split_whitespace().count() >= 3, "allowlist entry for {suffix} {sub:?} needs a reason");
        let used = files.iter().filter(|f| f.to_string_lossy().ends_with(suffix)).any(|f| fs::read_to_string(f).unwrap().contains(sub));
        assert!(used, "stale allowlist entry: {suffix} no longer contains {sub:?}");
    }
}

/// Owner rule: model values are family aliases (`haiku`, `sonnet`, `opus`, `fable`), never a versioned id, so a request always
/// routes to the latest. Doc text (comments, `doc = ` lines) is exempt.
#[test]
fn no_versioned_model_ids_in_source_or_plugin_config() {
    let re = regex::Regex::new(r"claude-(haiku|sonnet|opus|fable)-\d|claude-\d|gpt-\d+(\.\d+)?(-\w+)?").unwrap();
    // Price tables key on exact model names without the vendor prefix, so they are not matched at all.
    let mut hits = Vec::new();
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    for f in &files {
        for (n, line) in code_lines(&fs::read_to_string(f).unwrap()) {
            if re.is_match(&line) {
                hits.push(format!("{}:{n}: {}", f.display(), line.trim()));
            }
        }
    }
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    let mut stack = vec![engine];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "toml" || x == "json") {
                for (i, l) in fs::read_to_string(&p).unwrap().lines().enumerate() {
                    if re.is_match(l) && !l.trim_start().starts_with("doc") && !l.trim_start().starts_with('#') {
                        hits.push(format!("{}:{}: {}", p.display(), i + 1, l.trim().chars().take(120).collect::<String>()));
                    }
                }
            }
        }
    }
    assert!(hits.is_empty(), "versioned model ids (use the alias haiku/sonnet/opus/fable, or a tier word):\n{}", hits.join("\n"));
}

// ---- the ratchet ---------------------------------------------------------------------------------------------------

/// Numbers that are unit conversions or format widths, not tunables.
const STRUCTURAL_NUMBERS: &[&str] = &["1000", "1_000", "1_000_000", "1000000", "1024", "60", "3600", "24", "255", "256"];

fn numeric_literals(line: &str) -> Vec<String> {
    // strip string literals first so digits inside text are not counted
    let mut code = String::new();
    let mut in_str = false;
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            '\\' if in_str => i += 1,
            '"' => in_str = !in_str,
            c if !in_str => code.push(c),
            _ => {}
        }
        i += 1;
    }
    let mut out = Vec::new();
    let cs: Vec<char> = code.chars().collect();
    let mut j = 0;
    while j < cs.len() {
        if cs[j].is_ascii_digit() && !(j > 0 && (cs[j - 1].is_alphanumeric() || cs[j - 1] == '_' || cs[j - 1] == '.' || cs[j - 1] == '\'')) {
            let mut k = j;
            while k < cs.len() && (cs[k].is_ascii_digit() || cs[k] == '_') {
                k += 1;
            }
            // hex, floats and suffixed forms are left to the other rules
            if !(k < cs.len() && (cs[k] == 'x' || cs[k] == '.' && cs.get(k + 1).is_some_and(|c| c.is_ascii_digit()))) {
                out.push(cs[j..k].iter().collect::<String>());
            }
            j = k;
        } else {
            j += 1;
        }
    }
    out
}

fn ratchet_violations(file: &Path, text: &str) -> Vec<String> {
    let name = file.to_string_lossy().replace('\\', "/");
    let rel = name.split("/src/").last().map(|s| format!("src/{s}")).unwrap_or(name.clone());
    let mut v = Vec::new();
    for (_, line) in code_lines(text) {
        let t = line.trim();
        if t.is_empty()
            || t.starts_with("#[")
            || t.starts_with("use ")
            || t.contains("assert")
            || ALLOW.iter().any(|(f, sub, _)| name.ends_with(f) && line.contains(sub))
        {
            continue;
        }
        let limit_ctx = [".take(", ".truncate(", "with_capacity(", "[..", ".min(", ".max(", ".saturating_sub(", ".clamp("].iter().any(|k| line.contains(k))
            || line.contains(" > ")
            || line.contains(" >= ")
            || line.contains(" < ")
            || line.contains(" <= ");
        let is_item = t.starts_with("const ") || t.starts_with("static ") || t.starts_with("pub const ") || t.starts_with("pub static ");
        if limit_ctx
            && !is_item
            && numeric_literals(&line).iter().any(|n| n.replace('_', "").parse::<u64>().is_ok_and(|x| x >= 10) && !STRUCTURAL_NUMBERS.contains(&n.as_str()))
        {
            v.push(format!("[number] {rel}: {t}"));
        }
        let dev_diag = ["panic!(", ".expect(", "unreachable!(", "debug_assert"].iter().any(|k| line.contains(k));
        if !is_item
            && !dev_diag
            && string_literals(&line)
                .iter()
                .any(|s| s.chars().count() >= 15 && s.split_whitespace().filter(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 2).count() >= 3)
        {
            v.push(format!("[message] {rel}: {t}"));
        }
        if line.contains("Duration::from_") && line.contains(" * ") && numeric_literals(&line).len() >= 2 {
            v.push(format!("[duration] {rel}: {t}"));
        }
    }
    v
}

fn baseline_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/hardcoded_baseline.txt")
}

#[test]
fn no_new_hardcoded_literals() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    files.sort();
    let mut now: Vec<String> = Vec::new();
    for f in &files {
        now.extend(ratchet_violations(f, &fs::read_to_string(f).unwrap()));
    }
    now.sort();
    now.dedup();
    if std::env::var("AH_BLESS_BASELINE").is_ok() {
        fs::write(baseline_path(), now.join("\n") + "\n").unwrap();
        return;
    }
    let known: std::collections::BTreeSet<String> = fs::read_to_string(baseline_path()).unwrap_or_default().lines().map(str::to_string).collect();
    let current: std::collections::BTreeSet<String> = now.into_iter().collect();
    let new: Vec<&String> = current.difference(&known).collect();
    let gone: Vec<&String> = known.difference(&current).collect();
    assert!(
        new.is_empty(),
        "{} NEW hard-coded literals (move them to the plugin's engine/defaults/*.toml; the baseline only shrinks):\n{}",
        new.len(),
        new.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
    );
    assert!(
        gone.is_empty(),
        "{} baseline lines no longer occur (good: delete them from tests/it/hardcoded_baseline.txt, or re-bless):\n{}",
        gone.len(),
        gone.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
    );
}
