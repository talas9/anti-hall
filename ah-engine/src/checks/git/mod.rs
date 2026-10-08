//! Built-in `check = "git"`: a port of the Node git-guard (PreToolUse on Bash). Blocks are signalled the way the
//! Node guard does: exit code 2 plus the reason on stderr; the handover-budget advisory is a stdout JSON line.
//!
//! The Jev add-block consult (`gitGuardSelfCredit`) is performed as Node performs it: after the regex scan found nothing,
//! at the same three places, synchronously inside a 1500 ms budget, memoised per text, at most eight distinct texts and
//! four seconds per command; in `shadow` (the default) the ask is logged and never changes the verdict.
//!
//! Differences from the Node guard (deliberate, listed in the README): the
//! PostToolUse `--audit` pass is the separate `git-audit` check ([`audit`]); plugin options stored in Claude's own settings are not read
//! (only the `CLAUDE_PLUGIN_OPTION_*` environment variable form).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

pub mod aliases;
pub mod audit;
pub mod gitcmd;
pub mod heredoc;
pub mod launcher;
pub mod payloads;
pub mod runner;
pub mod segments;
pub mod tables;
#[cfg(test)]
mod tests;
pub mod tokenize;
pub mod util;

use crate::checks::lit_re;
use crate::checks::{Check, Verdict};
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use tables::{note, plain, tables};
use util::Settings;

/// Per-request state (the Node guard keeps these as module-level variables; one process = one call).
pub struct Ctx {
    /// The whole command text as the hook received it.
    pub raw_cmd: String,
    /// Placeholder replacements of the xargs/parallel/find runner currently being expanded.
    pub active_repls: Vec<runner::Repl>,
    /// How many filesystem probes the launcher check may still spend on this command.
    pub launcher_fs_budget: i32,
    /// The command text the launcher check is currently looking at.
    pub launcher_cmd_text: String,
    /// How many `git` subprocesses the handover-commit check may still run for this command.
    pub handover_query_budget: i32,
    /// Commits the handover check had to skip once its budgets ran out (reported as an advisory).
    pub handover_skipped: i32,
    /// Per repo and query, the handover paths found, so repeated commits in one command ask git once.
    pub handover_cache: HashMap<String, Option<Vec<String>>>,
    /// Handover paths staged earlier in the same command.
    pub handover_adds: Vec<String>,
    /// How many commit evaluations the handover check may still do for this command.
    pub handover_eval_budget: i32,
    handover_guard_on: Option<bool>,
    /// Memo of `has_self_credit` results per text.
    pub self_credit_cache: HashMap<String, bool>,
    /// Whether the raw command text itself credits an AI tool (computed once).
    pub raw_credit: Option<bool>,
    /// Memo of the Jev self-credit consult per exact text (Node: `consultGitGuardSelfCreditJevMemo`).
    pub jev_memo: HashMap<String, bool>,
    /// Milliseconds this command has spent on Jev consults so far (Node: `jevSpentMs`).
    pub jev_spent_ms: u64,
    /// The payload's session id, for the Jev decision rows.
    pub session_id: Option<String>,
    /// Runner recursion depth and whether it hit its bound (the answer is then deferred to the Node hook).
    pub rec: usize,
    /// Set when a bounded recursion (runner expansion) hit its limit; the verdict is then deferred to the Node hook.
    pub overflow: bool,
    /// The user home directory used for tilde expansion and settings files.
    pub home: String,
    /// The directory relative paths are resolved against (the hook payload `cwd`).
    pub proc_cwd: String,
    /// Memo of `git` subprocess answers keyed by repo and arguments.
    pub git_cache: HashMap<String, Option<String>>,
    /// Memo of git alias tables read from config, keyed by repo.
    pub alias_cache: HashMap<String, HashMap<String, String>>,
    /// Shell aliases and functions defined so far in this command.
    pub shell_defs: Option<std::rc::Rc<HashMap<String, aliases::ShellDef>>>,
    /// The plugin install directory, used to build the override command in block messages.
    pub plugin_root: String,
    /// Environment and settings snapshot taken once per request.
    pub settings: Settings,
    hd_on: Option<bool>,
    alias_on: Option<bool>,
    reuse_on: Option<bool>,
}

impl Ctx {
    /// A fresh per-request context with the Node guard's default budgets.
    pub fn new(settings: Settings, proc_cwd: &str, plugin_root: &str) -> Ctx {
        Ctx {
            raw_cmd: String::new(),
            active_repls: Vec::new(),
            launcher_fs_budget: tables().budget_launcher_fs,
            launcher_cmd_text: String::new(),
            handover_query_budget: tables().budget_handover_queries,
            handover_skipped: 0,
            handover_cache: HashMap::new(),
            handover_adds: Vec::new(),
            handover_eval_budget: tables().budget_handover_evals,
            handover_guard_on: None,
            self_credit_cache: HashMap::new(),
            raw_credit: None,
            jev_memo: HashMap::new(),
            jev_spent_ms: 0,
            session_id: None,
            rec: 0,
            overflow: false,
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

    /// Whether the heredoc-data masking setting is on (read once per request).
    ///
    /// Mirrors `git-guard.js` `heredocDataEnabled`.
    pub fn heredoc_data_enabled(&mut self) -> bool {
        *self.hd_on.get_or_insert_with(|| self.settings.enabled(&tables().setting_heredoc_data))
    }

    /// Whether git alias resolution is on (read once per request).
    ///
    /// Mirrors `lib/git-alias-scan.js` `aliasEnabled`.
    pub fn alias_enabled(&mut self) -> bool {
        *self.alias_on.get_or_insert_with(|| self.settings.enabled(&tables().setting_alias_resolve))
    }

    /// Whether the reused-commit-message check is on (read once per request).
    ///
    /// Mirrors `lib/git-alias-scan.js` `reuseEnabled`.
    pub fn reuse_enabled(&mut self) -> bool {
        *self.reuse_on.get_or_insert_with(|| self.settings.enabled(&tables().setting_reused_message))
    }

    /// Whether the handover-commit guard is on (read once per request).
    pub fn handover_guard_enabled(&mut self) -> bool {
        *self.handover_guard_on.get_or_insert_with(|| self.settings.enabled(&tables().setting_handover_guard))
    }

    /// lib/skip-cmd.js skipCommand(key): `node '<plugin>/scripts/devswarm.js' skip <key>`.
    ///
    /// Mirrors `git-guard.js` `skipCmd`.
    pub fn skip_cmd(&self, key: &str) -> String {
        let script = util::path_join(&self.plugin_root, plain("skip_script"));
        crate::defaults::fill(plain("skip_command"), &[("script", &script.replace('\'', "'\\''")), ("key", &key)])
    }

    /// `consultGitGuardSelfCreditJev(text)`: true when Jev, running `on`, confidently judges `text` to credit an AI assistant
    /// in words the regexes miss. Add-block trust with a baseline of `false`: it can only add a block. A repeated text is
    /// answered from the memo, a command asks about at most `git.jev_consult_cap` distinct texts and spends at most
    /// `git.jev_total_budget_ms`; past either the regex verdict (no block) stands. A text window that would cut a surrogate
    /// pair is Node's lone surrogate: the whole verdict is deferred.
    pub fn jev_consult(&mut self, text: &str) -> bool {
        use crate::jev::{AskRequest, Env as JevEnv, Question, Trust};
        if let Some(v) = self.jev_memo.get(text) {
            return *v;
        }
        if self.jev_memo.len() >= crate::defaults::num("git.jev_consult_cap") as usize {
            return false;
        }
        let budget = crate::defaults::num("git.jev_budget_ms");
        if self.jev_spent_ms + budget + crate::defaults::num("git.jev_backstop_ms") > crate::defaults::num("git.jev_total_budget_ms") {
            return false;
        }
        // inside a daemon request whose client stops waiting before this consult could finish: the reply would be lost
        // after the regex verdict was taken without Jev, so the whole verdict goes to Node, whose hook consults Jev with its
        // full budget (review finding 4; never weaker than Node)
        if crate::deadline::remaining().is_some_and(|left| (left.as_millis() as u64) < budget + crate::defaults::num("git.jev_backstop_ms")) {
            self.overflow = true;
            return false;
        }
        let Some(state) = crate::checks::replykit::io::prefix_utf16(text, crate::defaults::num("git.jev_state_chars") as usize) else {
            self.overflow = true;
            return false;
        };
        let start = std::time::Instant::now();
        let env = JevEnv::from_pairs(self.settings.env.clone());
        let q = Question::noul(crate::defaults::text("git.jev_instructions"), crate::defaults::text("git.jev_true"), crate::defaults::text("git.jev_false"));
        let mut req = AskRequest::new(crate::defaults::text("git.jev_id"), q, &state, Trust::AddBlock, Value::Bool(false));
        req.budget_ms = Some(budget);
        req.session_id = self.session_id.clone();
        req.project = crate::jev::shared::project_for(Some(&self.proc_cwd));
        req.env = Some(env.clone());
        let verdict = crate::jev::shared::lane(std::path::Path::new(&self.home), &env).ask(&req).outcome == Value::Bool(true);
        self.jev_memo.insert(text.to_string(), verdict);
        self.jev_spent_ms += start.elapsed().as_millis() as u64;
        verdict
    }

    /// A path as the Node process would open it (relative paths resolve against the hook's cwd).
    pub fn abs_from_cwd(&self, p: &str) -> String {
        if p.starts_with('/') || self.proc_cwd.is_empty() { p.to_string() } else { format!("{}/{}", self.proc_cwd.trim_end_matches('/'), p) }
    }
}

/// Mirrors `git-guard.js` `looksLikeFileWriteShape`.
fn looks_like_file_write_shape(cmd: &str) -> bool {
    static HD: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static RED: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static TEE: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static ECHO: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let hd = HD.get_or_init(|| lit_re(r#"<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?"#));
    let red = RED.get_or_init(|| lit_re(r#"(?:^|[\s;&|(])>{1,2}\s*[^\s&;|<>()0-9][^\s&;|<>()]*"#));
    let tee = TEE.get_or_init(|| lit_re(r#"(?-u:\b)tee(?-u:\b)\s+(?:-a\s+)?[^\s&;|<>()-][^\s&;|<>()]*"#));
    let echo = ECHO.get_or_init(|| lit_re(r"(?-u:\b)(?:echo|printf)(?-u:\b)"));
    let redirects = red.is_match(cmd);
    if hd.is_match(cmd) {
        return redirects || tee.is_match(cmd);
    }
    echo.is_match(cmd) && redirects
}

/// The git-guard PreToolUse decision for one Bash command. Runs on a thread with a large stack and turns a panic
/// into `Defer`, so a bug or a pathological command can never take a daemon worker down.
///
/// Mirrors `git-guard.js` `main`.
pub fn check_bash(cmd: &str, cwd: Option<&str>, plugin_root: &str, env: &crate::reqenv::RequestEnv) -> Verdict {
    check_bash_session(cmd, cwd, plugin_root, env, None)
}

/// [`check_bash`] with the payload's session id, which tags the Jev decision rows.
pub fn check_bash_session(cmd: &str, cwd: Option<&str>, plugin_root: &str, env: &crate::reqenv::RequestEnv, session: Option<&str>) -> Verdict {
    let settings = Settings::from_env(env);
    let r = std::thread::scope(|sc| {
        std::thread::Builder::new()
            .stack_size(tables().stack_bytes)
            .spawn_scoped(sc, || check_with_session(settings, cmd, cwd, plugin_root, session))
            .map(|h| h.join())
    });
    match r {
        Ok(Ok(o)) => o,
        // The check thread could not start (for example a data-segment limit smaller than its stack): say so in the
        // event log, because the engine would otherwise defer every command to Node without a visible reason.
        Err(e) => {
            crate::health::log_event(
                "check_spawn_fail",
                &format!("os{}", e.raw_os_error().unwrap_or(0)),
                &crate::defaults::render("msg.log_check_spawn", &[("err", &e)]),
            );
            Verdict::Defer
        }
        Ok(Err(_)) => Verdict::Defer, // the check panicked: Node decides
    }
}

/// `check_bash` with explicit settings (tests pass an isolated home).
///
/// Mirrors `git-guard.js` `main`.
pub fn check_with(settings: Settings, cmd: &str, cwd: Option<&str>, plugin_root: &str) -> Verdict {
    check_with_session(settings, cmd, cwd, plugin_root, None)
}

/// [`check_with`] with the payload's session id.
pub fn check_with_session(settings: Settings, cmd: &str, cwd: Option<&str>, plugin_root: &str, session: Option<&str>) -> Verdict {
    if !settings.enabled(&tables().setting_git_guard) {
        return Verdict::Allow;
    }
    if settings.is_skipped(&tables().guard_name) {
        return Verdict::Allow;
    }
    if cmd.is_empty() {
        return Verdict::Allow;
    }
    let cwd_s = cwd.unwrap_or("");
    let proc_cwd = if cwd_s.is_empty() { std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default() } else { cwd_s.to_string() };
    let mut ctx = Ctx::new(settings, &proc_cwd, plugin_root);
    ctx.session_id = session.map(str::to_string);
    ctx.raw_cmd = cmd.to_string();
    let base = if cwd_s.is_empty() { None } else { Some(cwd_s) };
    let hit = segments::scan_command(&mut ctx, cmd, 0, base);
    if ctx.overflow {
        return Verdict::Defer;
    }
    if let Some(m) = hit {
        if looks_like_file_write_shape(cmd) {
            return Verdict::Block(format!("{m}{}", tables().file_write_tip));
        }
        return Verdict::Block(m);
    }
    if ctx.handover_skipped > 0 {
        let text = note("handover_skipped_advisory", &[("n", &ctx.handover_skipped)]);
        let t = serde_json::to_string(&text).unwrap_or_default();
        return Verdict::Advisory(format!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"additionalContext\":{t}}}}}"));
    }
    Verdict::Allow
}

/// The registered `git` check: git-guard's PreToolUse decision for Bash commands (a port of `git-guard.js`).
pub struct GitGuard;

impl Check for GitGuard {
    fn name(&self) -> &'static str {
        "git"
    }

    fn summary(&self) -> &'static str {
        plain("check_summary")
    }

    fn run(&self, s: &Subject<'_>, opts: &Value) -> Option<Verdict> {
        self.run_env(s, &Value::Null, opts, &crate::reqenv::RequestEnv::default())
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, opts: &Value, env: &crate::reqenv::RequestEnv) -> Option<Verdict> {
        if s.event != "PreToolUse" || s.tool != Some("Bash") {
            return None;
        }
        let cmd = s.tool_input.get("command").and_then(Value::as_str)?;
        let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(crate::defaults::env_name("plugin_root"))).unwrap_or_default();
        let session = payload.get("session_id").filter(|v| crate::checks::replykit::io::truthy(v)).and_then(crate::checks::replykit::io::js_id_string);
        Some(check_bash_session(cmd, s.cwd, root, env, session.as_deref()))
    }
}
