//! The four operator helper scripts that were Node-only (D81), as `ah-engine` commands.
//!
//! | Command | Node source | What it does |
//! |---|---|---|
//! | `jev-setup` | `scripts/jev-setup.js` | `status`, `enable`, `disable`, `set-key`, `bind-generic-key`, `mode` of the opt-in Jev lane |
//! | `capability-scan` | `scripts/capability-scan.js` | which opt-in capabilities are shipped and active on this machine |
//! | `harvest` | `scripts/harvest-debt.js` | the deliberate-debt markers of a code tree |
//! | `briefing` | `scripts/briefing.js` | a derived inventory of the hooks, skills and docs of a plugin tree |
//!
//! Each command reproduces the script's text and `--json` output byte for byte and leaves the same files behind; the
//! parity tests (`tests/setup_parity.rs`) run the real Node script and the command on the same seeded home and compare
//! both. Where the engine's own Jev module already resolves something (`jev::settings`, `jev::credentials`) it is
//! reused rather than written twice.
//!
//! Left on Node on purpose (named in the plugin's `engine/defaults/setup.toml`): `jev-setup test` (a real gateway call), and the
//! `review-due`, `reviewed` and `snooze` verbs of the shadow-review reminder.
pub mod briefing;
pub mod capability;
pub mod harvest;
pub mod jev_setup;
pub mod jsfmt;

use crate::cli::Parsed;
use crate::defaults;
use crate::jev::settings::Env;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Why a helper command could not finish.
#[derive(Debug)]
pub enum SetupError {
    /// An operating-system call failed; `what` says which.
    Io {
        /// What was being done, with the path.
        what: String,
        /// The operating-system error.
        source: std::io::Error,
    },
    /// A file is larger than the engine reads (the limit is `setup.read_max_bytes`).
    TooLarge {
        /// The file.
        path: String,
    },
    /// Anything else, as a message for the user.
    Msg(String),
}

impl fmt::Display for SetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SetupError::Io { what, source } => f.write_str(&defaults::render("setup.err_io", &[("what", what), ("source", source)])),
            SetupError::TooLarge { path } => {
                f.write_str(&defaults::render("setup.msg_too_large", &[("path", path), ("max", &defaults::num("setup.read_max_bytes"))]))
            }
            SetupError::Msg(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SetupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SetupError::Io { source, .. } => Some(source),
            SetupError::TooLarge { .. } | SetupError::Msg(_) => None,
        }
    }
}

/// An I/O failure with what was being done.
pub(crate) fn io_err(what: impl Into<String>) -> impl FnOnce(std::io::Error) -> SetupError {
    let what = what.into();
    move |source| SetupError::Io { what, source }
}

/// What was being done, with the path it was done to (`setup.fmt_what`).
pub(crate) fn what(action_key: &str, path: &dyn fmt::Display) -> String {
    defaults::render("setup.fmt_what", &[("action", &defaults::text(action_key)), ("path", path)])
}

/// One line on stdout. A write failure (a closed pipe) is an error the caller propagates, never a panic.
pub(crate) fn out(line: &str) -> Result<(), SetupError> {
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(line.as_bytes()).and_then(|()| stdout.write_all(b"\n")).map_err(io_err(defaults::text("setup.what_write_stdout")))
}

/// Text on stdout without a final newline added.
pub(crate) fn out_raw(text: &str) -> Result<(), SetupError> {
    std::io::stdout().lock().write_all(text.as_bytes()).map_err(io_err(defaults::text("setup.what_write_stdout")))
}

/// One line on stderr. When stderr itself cannot be written there is nowhere left to report that, so the failure is
/// dropped here and nowhere else.
pub(crate) fn warn(line: &str) {
    let mut stderr = std::io::stderr().lock();
    if stderr.write_all(line.as_bytes()).and_then(|()| stderr.write_all(b"\n")).is_err() {
        // stderr is closed: nothing can be reported any more
    }
}

/// A command's result as an exit code: an error is reported on stderr and exits 74 (an I/O failure).
pub(crate) fn finish(result: Result<i32, SetupError>) -> i32 {
    match result {
        Ok(code) => code,
        Err(e) => {
            warn(&e.to_string());
            74
        }
    }
}

/// The current directory, as a string.
pub(crate) fn cwd() -> Result<String, SetupError> {
    std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).map_err(io_err(defaults::text("setup.what_cwd")))
}

/// At most `setup.read_max_bytes` of a file. `Ok(None)` when it does not exist; a larger file is an error, never a
/// silently truncated read.
pub(crate) fn read_capped(path: &Path) -> Result<Option<Vec<u8>>, SetupError> {
    let cap = defaults::num("setup.read_max_bytes");
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(SetupError::Io { what: what("setup.what_read", &path.display()), source: e }),
    };
    let mut buf = Vec::new();
    file.take(cap + 1).read_to_end(&mut buf).map_err(io_err(what("setup.what_read", &path.display())))?;
    if buf.len() as u64 > cap {
        return Err(SetupError::TooLarge { path: path.display().to_string() });
    }
    Ok(Some(buf))
}

/// The first `n` bytes of a file (for scans that only look at the start), `Ok(None)` when it does not exist.
pub(crate) fn read_prefix(path: &Path, n: u64) -> Result<Option<Vec<u8>>, SetupError> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(SetupError::Io { what: what("setup.what_read", &path.display()), source: e }),
    };
    let mut buf = Vec::new();
    file.take(n).read_to_end(&mut buf).map_err(io_err(what("setup.what_read", &path.display())))?;
    Ok(Some(buf))
}

/// A best-effort read, as the Node scripts do it (a file they cannot read is treated as absent): a missing file is
/// silent, anything else is said on stderr before the file is treated as absent.
pub(crate) fn read_or_warn(path: &Path) -> Option<Vec<u8>> {
    match read_capped(path) {
        Ok(v) => v,
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            None
        }
    }
}

/// Bytes as text without a second copy when they are valid UTF-8 (the usual case); invalid sequences become U+FFFD, as
/// `fs.readFileSync(p, 'utf8')` decodes them.
pub(crate) fn text_of(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// [`read_or_warn`] as text (see [`text_of`]).
pub(crate) fn read_text_or_warn(path: &Path) -> Option<String> {
    read_or_warn(path).map(text_of)
}

/// The entries of a directory with their names, in no particular order. A missing directory is empty and silent; any other
/// failure is said on stderr and the entries read so far are kept.
pub(crate) fn list_dir(dir: &Path) -> Vec<(String, std::fs::FileType, PathBuf)> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: what("setup.what_list", &dir.display()), source: e })]));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in rd {
        match entry.and_then(|e| e.file_type().map(|t| (e.file_name().to_string_lossy().into_owned(), t, e.path()))) {
            Ok(x) => out.push(x),
            Err(e) => {
                warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: what("setup.what_list", &dir.display()), source: e })]))
            }
        }
    }
    out
}

/// The home directory: `HOME`, else the password database (Node's `os.homedir()`).
pub(crate) fn home_dir(env: &Env) -> Option<PathBuf> {
    env.get(defaults::text("env.home")).filter(|h| !h.is_empty()).map(PathBuf::from).or_else(|| crate::checks::jsport::home::real_home().map(PathBuf::from))
}

/// Remove `--root <dir>` from the arguments and return it: the plugin tree to read (Node derives it from the script's own
/// location; the engine has no such location, so the host's plugin-root variable is the default).
pub(crate) fn take_root(args: &[String], env: &Env) -> (Option<String>, Vec<String>) {
    let mut root = None;
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--root" && i + 1 < args.len() {
            root = Some(args[i + 1].clone());
            i += 2;
            continue;
        }
        rest.push(args[i].clone());
        i += 1;
    }
    let root = root.or_else(|| env.get_nonempty(defaults::text("env.setup_host_plugin_root"))).or_else(|| env.get_nonempty(defaults::text("env.plugin_root")));
    (root, rest)
}

/// `jev-setup <verb> ...`
pub fn cmd_jev_setup(p: &Parsed) -> i32 {
    finish(jev_setup::run(&p.rest))
}

/// `capability-scan [--root <plugin>] [--json]`
pub fn cmd_capability_scan(p: &Parsed) -> i32 {
    finish(capability::run(p))
}

/// `harvest [--dir <path>] [--stale-days <n>] [--json]`
pub fn cmd_harvest(p: &Parsed) -> i32 {
    finish(harvest::run(p))
}

/// `briefing [--root <plugin>] [--json]`
pub fn cmd_briefing(p: &Parsed) -> i32 {
    finish(briefing::run(p))
}
