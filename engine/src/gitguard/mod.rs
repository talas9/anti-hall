//! Built-in `check = "git"`: a port of the Node git-guard (PreToolUse on Bash). Blocks are signalled the way the
//! Node guard does: exit code 2 plus the reason on stderr; the handover-budget advisory is a stdout JSON line.
//!
//! Differences from the Node guard (deliberate, listed in the README): the Jev add-block consult is not
//! performed (Node falls back to the regex verdict when Jev has no key, which is the default); the
//! PostToolUse `--audit` pass is not ported; plugin options stored in Claude's own settings are not read
//! (only the `CLAUDE_PLUGIN_OPTION_*` environment variable form).
pub mod alias;
pub mod gitcmd;
pub mod hdmask;
pub mod launcher;
pub mod payloads;
pub mod runner;
pub mod scan;
pub mod shell;
pub mod util;

use regex::Regex;
use shell::Tok;
use std::collections::HashMap;
use std::sync::OnceLock;
use util::Settings;

/// Per-request state (the Node guard keeps these as module-level variables; one process = one call).
pub struct Ctx {
    pub raw_cmd: String,
    pub active_repls: Vec<runner::Repl>,
    pub launcher_fs_budget: i32,
    pub launcher_cmd_text: String,
    pub handover_query_budget: i32,
    pub handover_skipped: i32,
    pub handover_cache: HashMap<String, Option<Vec<String>>>,
    pub handover_adds: Vec<String>,
    pub handover_eval_budget: i32,
    handover_guard_on: Option<bool>,
    pub self_credit_cache: HashMap<String, bool>,
    pub raw_credit: Option<bool>,
    /// A Jev add-block consult would have run (see `Outcome::Fallback`).
    pub jev_wanted: bool,
    pub home: String,
    pub proc_cwd: String,
    pub git_cache: HashMap<String, Option<String>>,
    pub alias_cache: HashMap<String, HashMap<String, String>>,
    pub shell_defs: Option<std::rc::Rc<HashMap<String, alias::ShellDef>>>,
    pub plugin_root: String,
    pub settings: Settings,
    hd_on: Option<bool>,
    alias_on: Option<bool>,
    reuse_on: Option<bool>,
}

impl Ctx {
    pub fn new(settings: Settings, proc_cwd: &str, plugin_root: &str) -> Ctx {
        Ctx {
            raw_cmd: String::new(),
            active_repls: Vec::new(),
            launcher_fs_budget: 64,
            launcher_cmd_text: String::new(),
            handover_query_budget: 8,
            handover_skipped: 0,
            handover_cache: HashMap::new(),
            handover_adds: Vec::new(),
            handover_eval_budget: 50,
            handover_guard_on: None,
            self_credit_cache: HashMap::new(),
            raw_credit: None,
            jev_wanted: false,
            home: settings.home.clone(),
            proc_cwd: proc_cwd.to_string(),
            git_cache: HashMap::new(),
            alias_cache: HashMap::new(),
            shell_defs: None,
            plugin_root: plugin_root.to_string(),
            settings,
            hd_on: None,
            alias_on: None,
            reuse_on: None,
        }
    }

    pub fn heredoc_data_enabled(&mut self) -> bool {
        if self.hd_on.is_none() {
            self.hd_on = Some(self.settings.enabled("guards", "gitGuardHeredocData", "ANTIHALL_GIT_GUARD_HEREDOC_DATA", None));
        }
        self.hd_on.unwrap()
    }

    pub fn alias_enabled(&mut self) -> bool {
        if self.alias_on.is_none() {
            self.alias_on = Some(self.settings.enabled("guards", "gitAliasResolve", "ANTIHALL_GIT_ALIAS_RESOLVE", None));
        }
        self.alias_on.unwrap()
    }

    pub fn reuse_enabled(&mut self) -> bool {
        if self.reuse_on.is_none() {
            self.reuse_on = Some(self.settings.enabled("guards", "gitReusedMessageCheck", "ANTIHALL_GIT_REUSED_MESSAGE_CHECK", None));
        }
        self.reuse_on.unwrap()
    }

    pub fn handover_guard_enabled(&mut self) -> bool {
        if self.handover_guard_on.is_none() {
            self.handover_guard_on = Some(self.settings.enabled("guards", "handoverCommitGuard", "ANTIHALL_HANDOVER_COMMIT_GUARD", Some("guards_handover_commit_guard")));
        }
        self.handover_guard_on.unwrap()
    }

    /// lib/skip-cmd.js skipCommand(key): `node '<plugin>/scripts/devswarm.js' skip <key>`.
    pub fn skip_cmd(&self, key: &str) -> String {
        let p = util::path_join(&self.plugin_root, "scripts/devswarm.js");
        format!("node '{}' skip {}", p.replace('\'', "'\\''"), key)
    }

    /// A path as the Node process would open it (relative paths resolve against the hook's cwd).
    pub fn abs_from_cwd(&self, p: &str) -> String {
        if p.starts_with('/') || self.proc_cwd.is_empty() {
            p.to_string()
        } else {
            format!("{}/{}", self.proc_cwd.trim_end_matches('/'), p)
        }
    }
}

/// What the check decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Allow,
    /// Exit 2, reason on stderr.
    Block(String),
    /// Exit 0 with this stdout JSON line (no decision).
    Advisory(String),
    /// The Node guard may decide differently (a Jev add-block consult in mode `on` would run): defer to it.
    Fallback,
}

fn looks_like_file_write_shape(cmd: &str) -> bool {
    static HD: OnceLock<Regex> = OnceLock::new();
    static RED: OnceLock<Regex> = OnceLock::new();
    static TEE: OnceLock<Regex> = OnceLock::new();
    static ECHO: OnceLock<Regex> = OnceLock::new();
    let hd = HD.get_or_init(|| Regex::new(r#"<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?"#).unwrap());
    let red = RED.get_or_init(|| Regex::new(r#"(?:^|[\s;&|(])>{1,2}\s*[^\s&;|<>()0-9][^\s&;|<>()]*"#).unwrap());
    let tee = TEE.get_or_init(|| Regex::new(r#"(?-u:\b)tee(?-u:\b)\s+(?:-a\s+)?[^\s&;|<>()-][^\s&;|<>()]*"#).unwrap());
    let echo = ECHO.get_or_init(|| Regex::new(r"(?-u:\b)(?:echo|printf)(?-u:\b)").unwrap());
    let redirects = red.is_match(cmd);
    if hd.is_match(cmd) {
        return redirects || tee.is_match(cmd);
    }
    echo.is_match(cmd) && redirects
}

const TIP: &str = "\nTip: this file's content was scanned as shell. Write the file with the Write or Edit tool (not shell-scanned) instead of a Bash heredoc, then reference its path in a plain follow-up command (e.g. `devswarm.js send --message-file <path>`).";

/// The git-guard PreToolUse decision for one Bash command.
pub fn check_bash(cmd: &str, cwd: Option<&str>, plugin_root: &str) -> Outcome {
    let settings = Settings::from_process();
    if !settings.enabled("safety", "gitGuard", "ANTIHALL_GIT_GUARD", Some("safety_git_guard")) {
        return Outcome::Allow;
    }
    if settings.is_skipped("git-guard") {
        return Outcome::Allow;
    }
    if cmd.is_empty() {
        return Outcome::Allow;
    }
    let cwd_s = cwd.unwrap_or("");
    let proc_cwd = if cwd_s.is_empty() { std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default() } else { cwd_s.to_string() };
    let mut ctx = Ctx::new(settings, &proc_cwd, plugin_root);
    ctx.raw_cmd = cmd.to_string();
    let base = if cwd_s.is_empty() { None } else { Some(cwd_s) };
    let hit = scan::scan_command(&mut ctx, cmd, 0, base);
    if ctx.jev_wanted && ctx.settings.jev_self_credit_on() {
        return Outcome::Fallback;
    }
    if let Some(m) = hit {
        if looks_like_file_write_shape(cmd) {
            return Outcome::Block(format!("{m}{TIP}"));
        }
        return Outcome::Block(m);
    }
    if ctx.handover_skipped > 0 {
        let text = format!(
            "anti-hall git-guard: the handover-commit check was skipped for {} commit(s) in this command (too many distinct commits/repos to check). Make sure none of them includes a session handover (.anti-hall/handovers/**, HANDOVER*.md, CONTINUE-HERE.md).",
            ctx.handover_skipped
        );
        let t = serde_json::to_string(&text).unwrap_or_default();
        return Outcome::Advisory(format!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"additionalContext\":{t}}}}}"));
    }
    Outcome::Allow
}

#[allow(dead_code)]
fn _unused(_: &[Tok]) {}

/// `engine gitguard`: run the check in-process on a hook payload from stdin and print what the Node guard would
/// (exit 2 + stderr for a block, a stdout JSON line for the advisory). Used by the parity harness.
pub fn cli_main() -> i32 {
    use std::io::{Read, Write};
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let Ok(p) = serde_json::from_str::<serde_json::Value>(&raw) else { return 0 };
    let Some(cmd) = p.pointer("/tool_input/command").and_then(|v| v.as_str()) else { return 0 };
    let cwd = p.get("cwd").and_then(|v| v.as_str());
    let root = std::env::var("ANTIHALL_ENGINE_PLUGIN_ROOT").unwrap_or_default();
    match check_bash(cmd, cwd, &root) {
        Outcome::Allow => 0,
        Outcome::Block(m) => {
            let _ = writeln!(std::io::stderr(), "{m}");
            2
        }
        Outcome::Advisory(j) => {
            let _ = writeln!(std::io::stdout(), "{j}");
            0
        }
        Outcome::Fallback => {
            let _ = writeln!(std::io::stdout(), "AHFALLBACK");
            0
        }
    }
}
