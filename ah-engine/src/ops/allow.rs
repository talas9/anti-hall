//! `settings trust-command-allow` and `trust-edit-allow`: print a repository's project allowlist and, with `--confirmed`,
//! record the hash of the file the person trusts. Port of the trust half of `scripts/settings.js` and of
//! `hooks/lib/command-allow.js`.
//!
//! The one place this port cannot be exact by construction is `new RegExp(pattern)` (does the pattern compile in V8): it
//! is answered by the embedded QuickJS-NG, which accepts the same syntax for every pattern that passes the structural
//! checks before it (a literal command word, no unbounded wildcard); the row it affects is informational, the trust record
//! is the file's sha256 either way.
use super::{err, out};
use crate::checks::jsport::ident;
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::setup::jsfmt::{js_string, pretty};
use rquickjs::{CatchResultExt, Context, Runtime};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Which allowlist.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `.anti-hall/command-allow.json`, anchored command patterns.
    Command,
    /// `.anti-hall/edit-allow.json`, repo-relative globs.
    Edit,
}

impl Kind {
    fn field(self, name: &str) -> &'static str {
        let which = if self == Kind::Edit { defaults::text("ops.kind_edit") } else { defaults::text("ops.kind_command") };
        defaults::raw("ops.allow_kinds").get(which).map_or("", |k| k.str_field(name))
    }
}

/// `{pattern, valid, reason}`
struct Row {
    pattern: J,
    ok: bool,
    reason: Option<String>,
}

/// `validatePattern(p)`.
fn validate_pattern(p: &J) -> (bool, Option<String>) {
    let J::Str(s) = p else { return (false, Some(defaults::text("ops.pat_not_string").to_string())) };
    if !s.starts_with('^') {
        return (false, Some(defaults::text("ops.pat_start").to_string()));
    }
    if !s.ends_with('$') || s.ends_with("\\$") {
        return (false, Some(defaults::text("ops.pat_end").to_string()));
    }
    if !literal_command_word(s) {
        return (false, Some(defaults::text("ops.pat_word").to_string()));
    }
    let scan = scan_pattern(s);
    if scan.top_alt {
        return (false, Some(defaults::text("ops.pat_alt").to_string()));
    }
    if let Some(w) = scan.wildcard {
        return (false, Some(defaults::render("ops.pat_wildcard", &[("what", &w)])));
    }
    if !compiles(s) {
        return (false, Some(defaults::text("ops.pat_regex").to_string()));
    }
    (true, None)
}

/// `/^\^(?:[A-Za-z0-9_\/-]|\\\.)+(?: |\$$)/.test(p)`
fn literal_command_word(s: &str) -> bool {
    let c: Vec<char> = s.chars().collect();
    let mut i = 1;
    let mut n = 0;
    while i < c.len() {
        if c[i].is_ascii_alphanumeric() || matches!(c[i], '_' | '/' | '-') {
            i += 1;
        } else if c[i] == '\\' && c.get(i + 1) == Some(&'.') {
            i += 2;
        } else {
            break;
        }
        n += 1;
    }
    n > 0 && (c.get(i) == Some(&' ') || (c.get(i) == Some(&'$') && i + 1 == c.len()))
}

struct Scan {
    top_alt: bool,
    wildcard: Option<String>,
}

fn slice(c: &[char], from: usize, to: usize) -> String {
    c[from.min(c.len())..to.min(c.len())].iter().collect()
}

/// `scanPattern(src)`.
fn scan_pattern(src: &str) -> Scan {
    let c: Vec<char> = src.chars().collect();
    let mut depth: usize = 0;
    let mut top_alt = false;
    let mut wildcard: Option<String> = None;
    let mut starts: Vec<usize> = Vec::new();
    let unbounded = |i: usize| -> bool {
        match c.get(i) {
            Some('*' | '+') => true,
            Some('{') => {
                let mut j = i + 1;
                while c.get(j).is_some_and(char::is_ascii_digit) {
                    j += 1;
                }
                c.get(j) == Some(&',') && c.get(j + 1) == Some(&'}')
            }
            _ => false,
        }
    };
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '\\' {
            i += 2;
            continue;
        }
        if ch == '[' {
            let mut j = i + 1;
            if c.get(j) == Some(&'^') {
                j += 1;
            }
            if c.get(j) == Some(&']') {
                j += 1;
            }
            while j < c.len() && c[j] != ']' {
                if c[j] == '\\' {
                    j += 1;
                }
                j += 1;
            }
            let body = slice(&c, i + 1, j);
            let spans_space = if body.starts_with('^') {
                !(body.contains(' ') || body.contains("\\s"))
            } else {
                body.contains("\\s") || body.contains("\\W") || body.contains("\\D") || body.contains(' ')
            };
            if spans_space && unbounded(j + 1) && wildcard.is_none() {
                wildcard = Some(slice(&c, i, j + 2));
            }
            i = j + 1;
            continue;
        }
        if ch == '(' {
            depth += 1;
            starts.push(i);
            i += 1;
            continue;
        }
        if ch == ')' {
            depth = depth.saturating_sub(1);
            let start = starts.pop().unwrap_or(0);
            let body: Vec<char> = c[(start + 1).min(i)..i].to_vec();
            if unbounded(i + 1) && group_wide(&body) && wildcard.is_none() {
                wildcard = Some(slice(&c, start, i + 2));
            }
            i += 1;
            continue;
        }
        if ch == '|' && depth == 0 {
            top_alt = true;
        }
        if ch == '.' && unbounded(i + 1) && wildcard.is_none() {
            wildcard = Some(slice(&c, i, i + 2));
        }
        i += 1;
    }
    Scan { top_alt, wildcard }
}

/// `/(^|[^\\])\.|\\[sWD]|\[\^| /.test(body)`
fn group_wide(body: &[char]) -> bool {
    for (k, ch) in body.iter().enumerate() {
        match ch {
            '.' if k == 0 || body[k - 1] != '\\' => return true,
            '\\' if matches!(body.get(k + 1), Some('s' | 'W' | 'D')) => return true,
            '[' if body.get(k + 1) == Some(&'^') => return true,
            ' ' => return true,
            _ => {}
        }
    }
    false
}

/// `new RegExp(p)` does not throw.
fn compiles(src: &str) -> bool {
    let Ok(rt) = Runtime::new() else { return false };
    rt.set_memory_limit(defaults::num("script.call_memory_bytes") as usize);
    let Ok(cx) = Context::full(&rt) else { return false };
    let ok = cx.with(|c| {
        if c.globals().set(defaults::text("ops.js_pattern_var"), src).catch(&c).is_err() {
            return false;
        }
        c.eval::<(), _>(defaults::text("ops.js_compile")).catch(&c).is_ok()
    });
    drop(cx);
    drop(rt);
    ok
}

/// `validateEditPath(p)`.
fn validate_edit_path(p: &J) -> (bool, Option<String>) {
    let J::Str(t) = p else { return (false, Some(defaults::text("ops.pat_not_string").to_string())) };
    if t.is_empty() || crate::checks::guardkit::text::js_trim(t) != t {
        return (false, Some(defaults::text("ops.edit_empty").to_string()));
    }
    let drive = {
        let mut ch = t.chars();
        ch.next().is_some_and(|c| c.is_ascii_alphabetic()) && ch.next() == Some(':')
    };
    if t.starts_with('/') || drive {
        return (false, Some(defaults::text("ops.edit_absolute").to_string()));
    }
    if t.starts_with('~') {
        return (false, Some(defaults::text("ops.edit_home").to_string()));
    }
    if t.contains('\\') {
        return (false, Some(defaults::text("ops.edit_backslash").to_string()));
    }
    if t.split('/').any(|seg| seg == "..") {
        return (false, Some(defaults::text("ops.edit_dotdot").to_string()));
    }
    if t.chars().all(|c| c == '*' || c == '/') {
        return (false, Some(defaults::text("ops.edit_everything").to_string()));
    }
    (true, None)
}

// ---- files ------------------------------------------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

enum Allow {
    Missing,
    Symlink,
    Unreadable,
    InvalidJson,
    Ok { hash: String, patterns: Vec<J> },
}

/// `readAllowFile(top, kind)`.
/// Whether `<top>/.git` is a file holding a line break the gitdir parse treats differently from JavaScript.
fn git_file_exotic(top: &str) -> bool {
    let breaks = defaults::list("ops.trust_exotic_breaks");
    std::fs::read(Path::new(top).join(".git")).is_ok_and(|b| {
        let t = String::from_utf8_lossy(&b);
        breaks.iter().any(|x| t.contains(*x))
    })
}

fn read_allow_file(top: &str, kind: Kind) -> Result<Allow, ()> {
    let cfg = Path::new(top).join(kind.field("rel"));
    let Some(dir) = cfg.parent() else { return Ok(Allow::Missing) };
    match std::fs::symlink_metadata(dir) {
        Err(_) => return Ok(Allow::Missing),
        Ok(m) if m.file_type().is_symlink() => return Ok(Allow::Symlink),
        Ok(_) => {}
    }
    match std::fs::symlink_metadata(&cfg) {
        Err(_) => return Ok(Allow::Missing),
        Ok(m) if m.file_type().is_symlink() => return Ok(Allow::Symlink),
        Ok(m) if !m.is_file() => return Ok(Allow::Unreadable),
        Ok(_) => {}
    }
    let mut f = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&cfg) {
        Ok(f) => f,
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Ok(Allow::Symlink),
        Err(_) => return Ok(Allow::Unreadable),
    };
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return Ok(Allow::Unreadable);
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return Ok(Allow::Unreadable);
    }
    let hash = sha256_hex(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    let parsed = match json::parse(&text, defaults::num("setup.json_max_depth") as usize) {
        Ok(p) => p,
        Err(json::Fail::Invalid) => return Ok(Allow::InvalidJson),
        Err(json::Fail::Unsupported) => return Err(()),
    };
    let patterns = match parsed.get(kind.field("list_key")) {
        Some(J::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    Ok(Allow::Ok { hash, patterns })
}

fn trust_path(home: &str, kind: Kind) -> std::path::PathBuf {
    Path::new(home).join(defaults::text("paths.base_dir")).join(kind.field("trust_file"))
}

fn repo_key(top: &str) -> String {
    match std::fs::canonicalize(top) {
        Ok(r) => r.to_string_lossy().into_owned(),
        Err(_) => crate::checks::git::util::resolve(top, "", &std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()),
    }
}

/// `recordTrust(home, top, hash, kind)`; the error is the Node message.
fn record_trust(home: &str, top: &str, hash: &str, kind: Kind) -> Result<(), String> {
    let p = trust_path(home, kind);
    if let Some(dir) = p.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        return Err(crate::migrate::node_err(&e, "mkdir", dir));
    }
    let mut records = match std::fs::read_to_string(&p).ok().and_then(|t| json::parse(&t, defaults::num("setup.json_max_depth") as usize).ok()) {
        Some(o @ J::Obj(_)) => o,
        _ => J::Obj(Vec::new()),
    };
    records.set(&repo_key(top), J::Str(hash.to_string()));
    let mut tmp = p.as_os_str().to_os_string();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    let text = pretty(&records) + "\n";
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
    if let Err(e) = written {
        return Err(crate::migrate::node_err(&e, "open", &tmp));
    }
    std::fs::rename(&tmp, &p).map_err(|e| crate::migrate::node_err(&e, "rename", &tmp))
}

fn fail(json_out: bool, error: &str) -> i32 {
    if json_out {
        out(&(json::stringify(&J::Obj(vec![("ok".into(), J::Bool(false)), ("error".into(), J::Str(error.to_string()))])) + "\n"));
    } else {
        err(&(defaults::render("ops.settings_err", &[("error", &error)]) + "\n"));
    }
    1
}

fn rows_json(rows: &[Row]) -> J {
    J::Arr(
        rows.iter()
            .map(|r| {
                J::Obj(vec![
                    ("pattern".into(), r.pattern.clone()),
                    ("valid".into(), J::Bool(r.ok)),
                    ("reason".into(), r.reason.clone().map_or(J::Null, J::Str)),
                ])
            })
            .collect(),
    )
}

fn row_lines(rows: &[Row]) -> String {
    let mut s = String::new();
    for r in rows {
        let mark = if r.ok { defaults::text("ops.row_ok") } else { defaults::text("ops.row_bad") };
        let note = match &r.reason {
            Some(why) if !r.ok => defaults::render("ops.row_ignored", &[("why", why)]),
            _ => String::new(),
        };
        s.push_str(&format!("{}{mark}{}{note}\n", defaults::text("ops.row_indent"), js_string(&r.pattern)));
    }
    s
}

/// `cmdTrustAllow(kind, args, opts)`; the result is the exit code.
pub fn run_trust(kind: Kind, positional: &[String], json_out: bool, confirmed: bool, env: &BTreeMap<String, String>, home: &str) -> i32 {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let target = match positional.first() {
        Some(p) if !p.is_empty() => crate::checks::git::util::resolve(p, "", &cwd),
        _ => cwd.clone(),
    };
    let rctx = ident::resolve_context(&target, true, &RequestEnv::from_pairs(env.clone()));
    let rel = kind.field("rel");
    // Node reads only `toplevel` (repoToplevel). `unsure` flags layouts the port cannot classify exactly; the toplevel is fixed before
    // the superproject climb that sets most of them, so only a `.git` file with exotic line breaks (or no toplevel at all) is unsure
    // for this command: refuse, recording nothing.
    if rctx.unsure && rctx.toplevel.as_deref().is_none_or(git_file_exotic) {
        return fail(json_out, &defaults::render("ops.trust_unsure", &[("target", &target)]));
    }
    let Some(top) = rctx.toplevel else { return fail(json_out, &defaults::render("ops.trust_not_git", &[("target", &target)])) };
    let file = match read_allow_file(&top, kind) {
        Ok(f) => f,
        // JSON JavaScript reads but the parser does not reproduce (lone surrogate escape, nesting past the limit): refuse
        Err(()) => return fail(json_out, &defaults::render("ops.trust_unparsable", &[("rel", &rel), ("top", &top)])),
    };
    let (hash, patterns) = match file {
        Allow::Missing => return fail(json_out, &defaults::render("ops.trust_missing", &[("rel", &rel), ("top", &top)])),
        Allow::Symlink => return fail(json_out, &defaults::render("ops.trust_symlink", &[("rel", &rel), ("top", &top)])),
        Allow::Unreadable => {
            return fail(json_out, &defaults::render("ops.trust_state", &[("rel", &rel), ("top", &top), ("state", &defaults::text("ops.state_unreadable"))]));
        }
        Allow::InvalidJson => {
            return fail(json_out, &defaults::render("ops.trust_state", &[("rel", &rel), ("top", &top), ("state", &defaults::text("ops.state_invalid_json"))]));
        }
        Allow::Ok { hash, patterns } => (hash, patterns),
    };
    let rows: Vec<Row> = patterns
        .into_iter()
        .map(|p| {
            let (ok, reason) = if kind == Kind::Edit { validate_edit_path(&p) } else { validate_pattern(&p) };
            Row { pattern: p, ok, reason }
        })
        .collect();
    let repo = repo_key(&top);
    if !confirmed {
        let what = if kind == Kind::Edit { defaults::text("ops.trust_what_edit") } else { defaults::text("ops.trust_what_command") };
        let warning = defaults::render("ops.trust_warning", &[("what", &what), ("repo", &repo), ("hash", &hash)]);
        if json_out {
            out(&(json::stringify(&J::Obj(vec![
                ("ok".into(), J::Bool(false)),
                ("needsConfirmation".into(), J::Bool(true)),
                ("repo".into(), J::Str(repo)),
                ("sha256".into(), J::Str(hash)),
                ("patterns".into(), rows_json(&rows)),
                ("warning".into(), J::Str(warning)),
            ])) + "\n"));
        } else {
            out(&format!("{repo}/{rel}:\n{}{warning}\n", row_lines(&rows)));
        }
        return 1;
    }
    if let Err(e) = record_trust(home, &top, &hash, kind) {
        return fail(json_out, &defaults::render("ops.trust_write_failed", &[("path", &trust_path(home, kind).display()), ("error", &e)]));
    }
    if json_out {
        out(&(json::stringify(&J::Obj(vec![
            ("ok".into(), J::Bool(true)),
            ("repo".into(), J::Str(repo)),
            ("sha256".into(), J::Str(hash)),
            ("patterns".into(), rows_json(&rows)),
        ])) + "\n"));
    } else {
        out(&(defaults::render("ops.trust_done", &[("repo", &repo), ("rel", &rel), ("hash", &hash)]) + "\n" + &row_lines(&rows)));
    }
    0
}
