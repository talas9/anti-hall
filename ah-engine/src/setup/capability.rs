//! `ah-engine capability-scan`: a read-only gap report, "what is missing on THIS machine". For each opt-in capability:
//! is it shipped in this plugin build, is it active (installed or scheduled) here, and how is it enabled. Port of
//! `scripts/capability-scan.js`.
//!
//! Like Node, nothing is hardcoded: companions are discovered from `companion/install-*.js` on disk, and each
//! installer's own `LABEL` and `UNIT` constants are read from its source (Node `require`s the installer; the engine has
//! no JavaScript to run, so it reads the two `const` lines the installers declare). Pending state migrations are
//! detected without writing: a legacy progress or history file that has no identical copy in `.anti-hall/history/legacy`.
use super::jsfmt::{js_string, obj};
use super::{SetupError, cwd, home_dir, io_err, list_dir, out, read_capped, read_text_or_warn, take_root, text_of, warn, what};
use crate::checks::guardkit::paths::{join, resolve, resolve_abs};
use crate::checks::jsport::json::{self, J, stringify};
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::settings::Env;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

/// `active`: a verdict, or "unknown" when a probe could not tell.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Active {
    Yes,
    No,
    Unknown,
}

struct Capability {
    name: String,
    active: Active,
    how: String,
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// The platform name Node reports.
fn platform() -> String {
    let os = std::env::consts::OS;
    defaults::raw("setup.cap_os_names").get(os).and_then(|v| v.as_str()).unwrap_or(os).to_string()
}

/// `const <name> = '<value>';` from an installer's source.
fn const_string(src: &str, name: &str) -> Option<String> {
    let head = defaults::render("setup.cap_const_fmt", &[("name", &name)]);
    let line = src.lines().find(|l| l.starts_with(&head))?;
    let rest = &line[head.len()..];
    let q = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let body = &rest[1..];
    Some(body[..body.find(q)?].to_string())
}

/// True when the installer exports `listInstalledIngestUnits` (the per-worktree readback contract).
fn exports_unit_listing(src: &str) -> bool {
    let name = defaults::text("setup.cap_listing_fn");
    let exports = defaults::list("setup.cap_export_fmts");
    let export_line = |l: &str| {
        let t = l.trim();
        exports.iter().enumerate().any(|(i, f)| {
            let want = defaults::fill(f, &[("name", &name)]);
            // the first form is the whole line (`name,`), the others only start it (`name:`)
            if i == 0 { t == want } else { t.starts_with(&want) }
        })
    };
    src.contains(&defaults::render("setup.cap_fn_decl_fmt", &[("name", &name)])) && src.lines().any(export_line)
}

/// The installers under `<root>/companion`, by name.
fn discover(root: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = list_dir(Path::new(&join(root, defaults::text("setup.cap_companion_dir"))))
        .into_iter()
        .filter_map(|(f, _, _)| {
            let name = f.strip_prefix(defaults::text("setup.cap_installer_prefix"))?.strip_suffix(defaults::text("setup.cap_installer_suffix"))?;
            (!name.is_empty()).then(|| (name.to_string(), f.clone()))
        })
        .collect();
    // `localeCompare`: case-insensitive first, then lower case before upper case
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| b.0.cmp(&a.0)));
    out
}

fn is_hex(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A per-worktree suffix (a fixed number of hexadecimal digits) or a per-project key (a lower-case head of letters, digits
/// and hyphens, then a hyphen and a short hexadecimal tail).
fn suffix_ok(suffix: &str) -> bool {
    if suffix.len() == defaults::num("setup.cap_hash_len") as usize && is_hex(suffix) {
        return true;
    }
    match suffix.rsplit_once('-') {
        Some((head, tail)) => {
            (1..=defaults::num("setup.cap_key_max") as usize).contains(&head.len())
                && head.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && tail.len() == defaults::num("setup.cap_key_tail") as usize
                && tail.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        }
        None => false,
    }
}

/// The lines of the user's crontab; none when there is no crontab program or no crontab.
fn crontab_lines() -> Vec<String> {
    let mut child =
        match Command::new(defaults::text("setup.cap_crontab_binary")).arg("-l").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn(&defaults::render(
                    "setup.msg_treated_absent",
                    &[("error", &SetupError::Io { what: defaults::text("setup.what_crontab").to_string(), source: e })],
                ));
                return Vec::new();
            }
        };
    let mut text = Vec::new();
    if let Some(stdout) = child.stdout.take()
        && let Err(e) = stdout.take(defaults::num("setup.read_max_bytes")).read_to_end(&mut text)
    {
        warn(&defaults::render(
            "setup.msg_treated_absent",
            &[("error", &SetupError::Io { what: defaults::text("setup.what_crontab").to_string(), source: e })],
        ));
    }
    if let Err(e) = child.wait() {
        warn(&defaults::render(
            "setup.msg_treated_absent",
            &[("error", &SetupError::Io { what: defaults::text("setup.what_crontab").to_string(), source: e })],
        ));
    }
    text_of(text).lines().map(str::to_string).collect()
}

/// A unit file counts when it can be opened (Node reads it and skips one it cannot).
fn readable(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}

/// `listInstalledIngestUnits(...).length > 0` for the installed-unit files and crontab markers.
fn ingest_units_installed(label: &str, unit: &str, home: &str, plat: &str) -> Active {
    if plat == defaults::text("setup.cap_plat_win32") {
        return Active::Unknown;
    }
    let mut any = false;
    if plat == defaults::text("setup.cap_plat_darwin") {
        let sep = defaults::text("setup.cap_label_sep");
        for (name, _, path) in list_dir(Path::new(&join(home, defaults::text("setup.cap_launchagents_dir")))) {
            let Some(rest) = name.strip_prefix(label).and_then(|r| r.strip_suffix(defaults::text("setup.cap_plist_suffix"))) else { continue };
            if !rest.is_empty() && !rest.strip_prefix(sep).is_some_and(suffix_ok) {
                continue;
            }
            any |= readable(&path);
        }
    } else if plat == defaults::text("setup.cap_plat_linux") {
        let sep = defaults::text("setup.cap_unit_sep");
        for (name, _, path) in list_dir(Path::new(&join(home, defaults::text("setup.cap_systemd_dir")))) {
            let Some(rest) = name.strip_prefix(unit).and_then(|r| r.strip_suffix(defaults::text("setup.cap_service_suffix"))) else { continue };
            if !rest.is_empty() && !rest.strip_prefix(sep).is_some_and(suffix_ok) {
                continue;
            }
            any |= readable(&path);
        }
        let marker = defaults::render("setup.cap_cron_marker", &[("unit", &unit)]);
        for l in crontab_lines() {
            let Some(rest) = js_trim(&l).strip_prefix(&marker).map(str::to_string) else { continue };
            if rest.is_empty() || rest.strip_prefix(sep).is_some_and(suffix_ok) {
                any = true;
            }
        }
    }
    bool_active(any)
}

fn js_trim(s: &str) -> &str {
    crate::jev::js_trim(s)
}

/// `companionActive`: the real artifact the installer writes.
fn companion_active(installer: &str, home: &str, plat: &str) -> Active {
    let Some(src) = read_text_or_warn(Path::new(installer)) else { return Active::Unknown };
    let label = const_string(&src, defaults::text("setup.cap_const_label"));
    let unit = const_string(&src, defaults::text("setup.cap_const_unit"));
    if exports_unit_listing(&src) {
        return match (label, unit) {
            (Some(l), Some(u)) => ingest_units_installed(&l, &u, home, plat),
            _ => Active::Unknown,
        };
    }
    if plat == defaults::text("setup.cap_plat_darwin") {
        return match label {
            Some(l) => {
                bool_active(exists(&join(home, &format!("{}/{l}{}", defaults::text("setup.cap_launchagents_dir"), defaults::text("setup.cap_plist_suffix")))))
            }
            None => Active::Unknown,
        };
    }
    if plat == defaults::text("setup.cap_plat_win32") {
        return Active::Unknown;
    }
    let Some(unit) = unit else { return Active::Unknown };
    let base = join(home, defaults::text("setup.cap_systemd_dir"));
    if exists(&join(&base, &format!("{unit}{}", defaults::text("setup.cap_timer_suffix"))))
        || exists(&join(&base, &defaults::render("setup.cap_enabled_service", &[("unit", &unit)])))
        || exists(&join(&base, &defaults::render("setup.cap_enabled_timer", &[("unit", &unit)])))
    {
        return Active::Yes;
    }
    let marker = defaults::render("setup.cap_cron_marker", &[("unit", &unit)]);
    bool_active(crontab_lines().iter().any(|l| js_trim(l) == marker))
}

fn bool_active(b: bool) -> Active {
    if b { Active::Yes } else { Active::No }
}

/// A JSON file as a value; `None` for a missing, unreadable or malformed file (the Node probe treats all three as "no
/// answer"; an unreadable one is said on stderr).
fn read_json(p: &str) -> Option<J> {
    let text = read_text_or_warn(Path::new(p))?;
    json::parse(&text, defaults::num("setup.json_max_depth") as usize).ok()
}

/// The effective status-line scope: project-local, then project, then user; the first with a command wins.
fn statusline(cwd: &str, home: &str) -> Active {
    let mut scopes: Vec<String> = defaults::list("setup.cap_status_project_files").into_iter().map(|f| join(cwd, f)).collect();
    scopes.extend(defaults::list("setup.cap_status_user_files").into_iter().map(|f| join(home, f)));
    for p in &scopes {
        let Some(v) = read_json(p) else { continue };
        let Some(cmd) = v.get(defaults::text("setup.cap_status_key")).and_then(|s| s.get(defaults::text("setup.cap_status_command_key"))) else { continue };
        let truthy = match cmd {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(n) => *n != 0.0 && !n.is_nan(),
            J::Str(s) => !s.is_empty(),
            J::Arr(_) | J::Obj(_) => true,
        };
        if truthy {
            let text = match cmd {
                J::Str(s) => s.clone(),
                other => js_string(other),
            };
            return bool_active(text.contains(defaults::text("setup.cap_statusline_marker")));
        }
    }
    Active::No
}

/// True when `path` is valid UTF-8, checked in chunks (a character may straddle two chunks).
fn valid_utf8(path: &Path) -> Result<bool, SetupError> {
    let mut f = std::fs::File::open(path).map_err(io_err(what("setup.what_read", &path.display())))?;
    let mut chunk = vec![0u8; defaults::num("setup.compare_chunk_bytes") as usize];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let n = f.read(&mut chunk).map_err(io_err(what("setup.what_read", &path.display())))?;
        if n == 0 {
            return Ok(carry.is_empty());
        }
        carry.extend_from_slice(&chunk[..n]);
        match std::str::from_utf8(&carry) {
            Ok(_) => carry.clear(),
            Err(e) if e.error_len().is_some() => return Ok(false),
            Err(e) => carry = carry[e.valid_up_to()..].to_vec(),
        }
    }
}

/// Byte-for-byte equality of two files, streamed.
fn same_bytes(a: &Path, b: &Path) -> Result<bool, SetupError> {
    let what = |p: &Path| what("setup.what_read", &p.display());
    let (mut fa, mut fb) = (std::fs::File::open(a).map_err(io_err(what(a)))?, std::fs::File::open(b).map_err(io_err(what(b)))?);
    let n = defaults::num("setup.compare_chunk_bytes") as usize;
    let (mut ba, mut bb) = (vec![0u8; n], vec![0u8; n]);
    loop {
        let (ra, rb) = (read_full(&mut fa, &mut ba).map_err(io_err(what(a)))?, read_full(&mut fb, &mut bb).map_err(io_err(what(b)))?);
        if ra != rb || ba[..ra] != bb[..rb] {
            return Ok(false);
        }
        if ra == 0 {
            return Ok(true);
        }
    }
}

/// Fill `buf` from `f` until it is full or the file ends; returns how many bytes were read.
fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        let n = f.read(&mut buf[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    Ok(got)
}

/// Node compares the two files as decoded text: the same bytes are the same text, different bytes are different text unless
/// one of them holds invalid UTF-8 (every bad sequence decodes to U+FFFD), which is then compared decoded.
fn same_text(src: &Path, dest: &Path) -> Result<bool, SetupError> {
    if !dest.exists() {
        return Ok(false);
    }
    if same_bytes(src, dest)? {
        return Ok(true);
    }
    if valid_utf8(src)? && valid_utf8(dest)? {
        return Ok(false);
    }
    match (read_capped(src)?, read_capped(dest)?) {
        (Some(a), Some(b)) => Ok(text_of(a) == text_of(b)),
        _ => Ok(false),
    }
}

/// Whether a legacy progress or history file is waiting to be copied under `.anti-hall/history/legacy`.
fn migrations_pending(cwd: &str, home: &str) -> Result<bool, SetupError> {
    let root = crate::checks::taskkit::root::repo_root(&resolve_abs(cwd), home).unwrap_or_else(|| cwd.to_string());
    let legacy = join(&root, defaults::text("setup.cap_legacy_dir"));
    for name in defaults::list("setup.cap_legacy_files") {
        let src = join(&root, name);
        if !std::fs::metadata(&src).is_ok_and(|m| m.is_file()) {
            continue; // not-found (a directory or an unreadable file reads as absent in Node, too)
        }
        if !same_text(Path::new(&src), Path::new(&join(&legacy, name)))? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn scan(root: &str, home: &str, cwd: &str) -> Result<Vec<Capability>, SetupError> {
    let plat = platform();
    let mut caps = Vec::new();
    for (name, file) in discover(root) {
        let active = companion_active(&join(root, &format!("{}/{file}", defaults::text("setup.cap_companion_dir"))), home, &plat);
        caps.push(Capability { name, active, how: defaults::render("setup.cap_how_companion", &[("file", &file)]) });
    }
    caps.push(Capability {
        name: defaults::text("setup.cap_name_statusline").to_string(),
        active: statusline(cwd, home),
        how: defaults::text("setup.cap_how_statusline").to_string(),
    });
    caps.push(Capability {
        name: defaults::text("setup.cap_name_migrations").to_string(),
        active: bool_active(!migrations_pending(cwd, home)?),
        how: defaults::text("setup.cap_how_migrations").to_string(),
    });
    Ok(caps)
}

fn report_json(caps: &[Capability]) -> String {
    let items = caps
        .iter()
        .map(|c| {
            let active = match c.active {
                Active::Yes => J::Bool(true),
                Active::No => J::Bool(false),
                Active::Unknown => J::Str(defaults::text("setup.word_unknown").to_string()),
            };
            obj(vec![("name", J::Str(c.name.clone())), ("available", J::Bool(true)), ("active", active), ("how", J::Str(c.how.clone()))])
        })
        .collect();
    stringify(&obj(vec![("capabilities", J::Arr(items))]))
}

/// The command: `capability-scan [--root <plugin>] [--json]`.
pub fn run(p: &Parsed) -> Result<i32, SetupError> {
    let env = Env::process();
    let (root, _) = take_root(&p.rest, &env);
    let Some(root) = root else {
        warn(defaults::text("setup.msg_no_plugin_root"));
        return Ok(64);
    };
    let Some(home) = home_dir(&env) else {
        warn(defaults::text("setup.msg_no_home"));
        return Ok(64);
    };
    let here = cwd()?;
    let given = resolve(&here, &root);
    let root = std::fs::canonicalize(&given).map_err(io_err(what("setup.what_resolve", &given)))?.to_string_lossy().into_owned();
    let caps = scan(&root, &home.to_string_lossy(), &here)?;
    out(&report_json(&caps))?;
    if !p.json {
        for c in &caps {
            let state = match c.active {
                Active::Yes => defaults::text("setup.cap_state_active"),
                Active::No => defaults::text("setup.cap_state_inactive"),
                Active::Unknown => defaults::text("setup.word_unknown"),
            };
            let hint = if c.active == Active::No { defaults::render("setup.fmt_cap_hint", &[("how", &c.how)]) } else { String::new() };
            out(&defaults::render("setup.fmt_cap_line", &[("name", &c.name), ("state", &state), ("hint", &hint)]))?;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_const_line_gives_the_installers_constant() {
        let src = "'use strict';\nconst LABEL = 'com.x.y';\nconst UNIT = \"x-y\";\n";
        assert_eq!(const_string(src, "LABEL").as_deref(), Some("com.x.y"));
        assert_eq!(const_string(src, "UNIT").as_deref(), Some("x-y"));
        assert_eq!(const_string(src, "OTHER"), None);
    }

    #[test]
    fn a_unit_suffix_is_a_worktree_hash_or_a_project_key() {
        assert!(suffix_ok("0123abcd"));
        assert!(suffix_ok("my-repo-0a1b2c"));
        assert!(!suffix_ok("nope"));
        assert!(!suffix_ok("UPPER-0a1b2c"));
    }
}
