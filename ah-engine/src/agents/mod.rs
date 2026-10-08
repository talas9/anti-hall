//! The agent tracker (owner feature 21): follow every agent, keep its progress, raise signals, remind, measure.
//!
//! An agent is a main Claude Code session, a subagent or background task of one, a DevSwarm workspace's session, or an agent known
//! only by a heartbeat file. A tick (the scheduled job `agent_tick`, or `ah-engine agents tick`) reads what each agent did since the
//! last tick from its transcript (the Claude Code CLI's `agents --json` listing adds the host's own busy or waiting state where it
//! was verified), keeps per-agent totals and a series of samples, derives six signals (hung, looping, token waste, drift, stale
//! heartbeat, no Monitor armed), and queues reminders through three sinks. It never stops or kills an agent.
//!
//! The honest limit: the engine cannot wake an idle session. A reminder reaches a session at its next hook event (the scripted check
//! `agent-reminders`), a DevSwarm workspace through the mesh outbox, or the owner through the notices file. Keeping a Monitor or cron
//! armed is what lets an idle session wake at all, which is why "no wake path armed" is itself a signal.
//!
//! Every threshold, weight, path, pattern, word and text is in `engine/defaults/agent_tracker.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as the Node hooks' try/catch)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

mod facts;
mod signals;
mod sinks;
mod sources;
mod status;
#[cfg(test)]
mod tests;

use crate::checks::git::util::Settings;
use crate::defaults::{self, V};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub use status::run_cmd;

pub(crate) fn lim(k: &str) -> u64 {
    defaults::raw("agent_tracker.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
pub(crate) fn weight(k: &str) -> u64 {
    defaults::raw("agent_tracker.weights").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
pub(crate) fn pth(k: &str) -> &'static str {
    defaults::raw("agent_tracker.paths").str_field(k)
}
pub(crate) fn tr(k: &str) -> &'static str {
    defaults::raw("agent_tracker.transcript").str_field(k)
}
pub(crate) fn tools(role: &str) -> Vec<&'static str> {
    defaults::raw("agent_tracker.tools").get(role).map(V::strings).unwrap_or_default()
}
pub(crate) fn fmtc(k: &str) -> &'static str {
    defaults::raw("agent_tracker.fmt").str_field(k)
}
pub(crate) fn fmtn(k: &str) -> u64 {
    defaults::raw("agent_tracker.fmt").get(k).and_then(V::as_integer).unwrap_or(1).max(1) as u64
}
pub(crate) fn kind_name(k: &str) -> &'static str {
    defaults::raw("agent_tracker.kinds").str_field(k)
}
pub(crate) fn state_name(k: &str) -> &'static str {
    defaults::raw("agent_tracker.states").str_field(k)
}
pub(crate) fn chan(k: &str) -> &'static str {
    defaults::raw("agent_tracker.channels").str_field(k)
}
/// `Math.min`-style cap of a text to `n` characters.
pub(crate) fn cap(s: &str, n: u64) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(n as usize).collect()
}

/// The signals the tick evaluates, in order.
pub(crate) fn defaults_signals() -> Vec<&'static str> {
    defaults::list("agent_tracker.signals")
}

/// What a tick needs from its surroundings; tests build their own.
pub struct Env {
    /// The user home directory.
    pub home: PathBuf,
    /// The clock, ms since the epoch.
    pub now_ms: u64,
    /// The plugin root (the wake-watch script lives under it).
    pub plugin_root: Option<PathBuf>,
    /// Ask the Claude Code CLI for the host's session listing (tests turn it off or point it at a stand-in).
    pub use_cli: bool,
    /// Switch resolution (environment, then the settings files).
    pub settings: Settings,
    /// Queue reminders and write telemetry (false for a read-only `status`).
    pub act: bool,
}

impl Env {
    /// The environment of the running process.
    pub fn current() -> Option<Env> {
        let settings = Settings::from_env(&crate::reqenv::RequestEnv::capture());
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        (!settings.home.is_empty()).then(|| Env {
            home: PathBuf::from(&settings.home),
            now_ms,
            plugin_root: defaults::root(),
            use_cli: true,
            settings,
            act: true,
        })
    }
    /// The tracker's own directory.
    pub fn dir(&self) -> PathBuf {
        self.home.join(pth("base")).join(pth("dir"))
    }
    pub(crate) fn base(&self) -> PathBuf {
        self.home.join(pth("base"))
    }
    pub(crate) fn switch(&self, key: &str) -> bool {
        crate::checks::guardkit::settings::get_bool(&self.settings, defaults::raw(key))
    }
}

// ---- persisted state ----------------------------------------------------------------------------------------

/// A cumulative sample of one agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Sample {
    /// When it was taken.
    pub t: u64,
    /// Cumulative input tokens.
    pub tin: u64,
    /// Cumulative output tokens.
    pub tout: u64,
    /// Cumulative cache-read tokens.
    pub tcr: u64,
    /// Cumulative cache-write tokens.
    pub tcw: u64,
    /// Cumulative tool calls.
    pub tools: u64,
    /// Cumulative progress units.
    pub progress: u64,
}

/// A tool call waiting for its result.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pending {
    /// The tool name.
    pub name: String,
    /// When it was called.
    pub ts: u64,
    /// What it was (a short label).
    pub label: String,
    /// `commit`, `test` or empty.
    pub class: String,
}

/// A raised signal on one agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Flag {
    /// When it was first raised.
    pub since: u64,
    /// The number it tripped on.
    pub evidence: u64,
    /// The words it carries (a step, a repeated call).
    pub text: String,
    /// Consecutive ticks it has been up.
    pub ticks: u64,
    /// When the first reminder for it was queued (0 = none yet).
    pub reminded_at: u64,
    /// When the hook delivered a reminder for it (0 = none yet).
    pub delivered_at: u64,
    /// Progress at the time it was raised.
    pub base_progress: u64,
    /// Input plus output tokens at the time it was raised.
    pub base_tokens: u64,
    /// The outcome was already recorded as not recovered.
    pub timed_out: bool,
}

/// The wake-watch and plan facts of a DevSwarm workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ws {
    /// The workspace id.
    pub id: String,
    /// Whether a live wake-watch covers it (`None` = unknown).
    pub armed: Option<bool>,
    /// The plan step it is on.
    pub step: String,
    /// Plan steps done.
    pub done: u64,
}

/// Everything the tracker keeps about one agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Agent {
    /// The agent id (a session id, a subagent id, a heartbeat id).
    pub id: String,
    /// `main`, `subagent`, `workspace` or `heartbeat`.
    pub kind: String,
    /// The session that launched it (a subagent), or its own session id.
    pub parent: String,
    /// A readable name.
    pub name: String,
    /// Its working directory.
    pub cwd: String,
    /// Its transcript.
    pub path: String,
    /// Where its numbers come from.
    pub source: String,
    /// Bytes of the transcript already read.
    pub offset: u64,
    /// Its totals count from part way into the transcript.
    pub partial: bool,
    /// First tick that saw it.
    pub first_seen: u64,
    /// Last tick that saw it.
    pub seen: u64,
    /// Cumulative input tokens.
    pub tin: u64,
    /// Cumulative output tokens.
    pub tout: u64,
    /// Cumulative cache-read tokens.
    pub tcr: u64,
    /// Cumulative cache-write tokens.
    pub tcw: u64,
    /// Tool calls.
    pub tools: u64,
    /// Failed tool calls.
    pub errors: u64,
    /// File edits.
    pub edits: u64,
    /// Commits.
    pub commits: u64,
    /// Test runs that passed.
    pub tests_pass: u64,
    /// Plan steps completed.
    pub steps_done: u64,
    /// Progress units (commits, steps, passing tests, new files, weighted).
    pub progress: u64,
    /// Its last activity (an assistant line, a tool result, a prompt).
    pub last_output_ms: u64,
    /// The turn is not finished.
    pub running: bool,
    /// The host's own word for its state (from the CLI listing), empty when not asked.
    pub host: String,
    /// The host reports it exited.
    pub gone: bool,
    /// Unanswered tool calls by id.
    pub pending: BTreeMap<String, Pending>,
    /// Message ids already counted (the transcript repeats a message's usage on every line).
    pub ids: Vec<String>,
    /// The last tool calls: signature, label, is-edit, time.
    pub recent: Vec<(String, String, bool, u64)>,
    /// The last error texts: hash, label, time.
    pub errs: Vec<(u64, String, u64)>,
    /// Files it edited.
    pub files: Vec<String>,
    /// The declared step.
    pub step: String,
    /// Edits and commands since the step was declared.
    pub step_events: u64,
    /// Words of the recent work.
    pub work: Vec<String>,
    /// Task-list items completed (for the transition).
    pub todo_done: u64,
    /// When background shell commands were started.
    pub bg_bash: Vec<u64>,
    /// Until when its last wake path reaches it.
    pub armed_until: u64,
    /// The last time a wake path was armed (0 = never in the window).
    pub armed_at: u64,
    /// DevSwarm facts, when it is a workspace.
    pub ws: Option<Ws>,
    /// Heartbeat file facts.
    pub hb_ts: u64,
    /// Heartbeat status text.
    pub hb_status: String,
    /// Heartbeat step text.
    pub hb_step: String,
    /// Series samples.
    pub samples: Vec<Sample>,
    /// When the last series record was written.
    pub last_series: u64,
    /// Signals up now.
    pub flags: BTreeMap<String, Flag>,
    /// When each signal was last reminded.
    pub last_sent: BTreeMap<String, u64>,
    /// Reminders queued (signal, time), for the daily cap.
    pub sent_log: Vec<(String, u64)>,
}

/// One day's totals.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Totals {
    /// Signals raised.
    pub signals: u64,
    /// Reminders queued.
    pub queued: u64,
    /// Reminders a hook delivered.
    pub delivered: u64,
    /// Reminders held back by a cooldown, a cap or a full queue.
    pub suppressed: u64,
    /// Agents that recovered after a signal.
    pub recovered: u64,
    /// Flags that cleared on their own while the agent was productive.
    pub false_positives: u64,
    /// Reminded signals still up after the outcome window.
    pub unrecovered: u64,
    /// Tokens (input plus output) flagged agents spent.
    pub burned: u64,
}

/// The tracker's persisted state; only a cache, a damaged file is discarded.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// Followed agents by id.
    pub agents: BTreeMap<String, Agent>,
    /// Daily totals by day number.
    pub days: BTreeMap<String, Totals>,
    /// Lines of the delivered file already read.
    pub delivered_lines: u64,
    /// The Claude Code version the CLI source was last checked on, and its result.
    pub cli_version: String,
    /// Whether `agents --json` worked on that version.
    pub cli_ok: Option<bool>,
    /// When the CLI source was last probed.
    pub cli_checked: u64,
}

impl State {
    pub(crate) fn day(&mut self, env: &Env) -> &mut Totals {
        let key = (env.now_ms / fmtn("day_ms")).to_string();
        self.days.entry(key).or_default()
    }
    /// Today's totals (zero when none).
    pub fn today(&self, env: &Env) -> Totals {
        self.days.get(&(env.now_ms / fmtn("day_ms")).to_string()).cloned().unwrap_or_default()
    }
}

pub(crate) fn load_state(env: &Env) -> State {
    let p = env.dir().join(pth("state"));
    match std::fs::metadata(&p) {
        Ok(m) if m.len() <= lim("state_max_bytes") => std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default(),
        _ => State::default(),
    }
}

pub(crate) fn save_state(env: &Env, st: &State) {
    let dir = env.dir();
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: a failed write below reports it
    if let Ok(t) = serde_json::to_string(st)
        && let Err(e) = crate::atomic::write(dir.join(pth("state")), t)
    {
        crate::health::log_event("agents", "state_write", &e.to_string());
    }
}

/// One tick: discover, ingest, sample, evaluate, remind. Returns the state it ended with.
pub fn tick(env: &Env, st: &mut State) -> sources::Listing {
    let listing = sources::refresh(env, st);
    signals::evaluate_all(env, st);
    listing
}
