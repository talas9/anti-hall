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

mod ctl;
mod escalate;
mod facts;
mod live;
mod lockwatch;
pub(crate) mod native_wake;
pub mod nudge;
mod procs;
mod repo;
mod signals;
mod sinks;
mod sources;
mod status;
mod wake;
pub use status::cost_report;
#[cfg(test)]
mod tests;
pub mod waste;

use crate::checks::git::util::Settings;
use crate::defaults::{self, V};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub use ctl::{Send, document as web_document, heartbeat, send, session_pids, transcript_path};
pub use nudge::document as nudge_document;
pub(crate) use status::document as status_document;
pub use status::run_cmd;

/// Hand a notice from outside the tracker (the leak sentinel) to the owner notices file and, when a wake-watch covers it, to the
/// wake feed of the most recently active main session. The caller rate-limits.
pub(crate) fn notify_coordinator(signal: &str, text: &str) {
    let Some(env) = Env::current() else { return };
    let r =
        sinks::Reminder { id: format!("{signal}-{}", env.now_ms), ts: env.now_ms, signal: signal.to_string(), agent: String::new(), text: text.to_string() };
    use sinks::Sink;
    crate::discard::harmless(sinks::OwnerNotices.deliver(&env, "", &r)); // keep: the wake feed below is the second route
    let st = load_state(&env);
    let main = st.agents.values().filter(|m| m.kind == kind_name("main")).max_by_key(|m| m.last_output_ms).map(|m| m.id.clone());
    if let Some(id) = main
        && sinks::wake_armed(&env, &id)
    {
        crate::discard::harmless(sinks::WakeFeed.deliver(&env, &id, &r)); // keep: the owner notice already landed
    }
}

pub(crate) fn lim(k: &str) -> u64 {
    defaults::raw("agent_tracker.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
/// When the agent started: the creation time of its transcript (the tracker's `first_seen` is only the first tick that saw it, which
/// is later for an agent that ran before the engine looked), else `first_seen`.
pub(crate) fn started_ms(a: &Agent) -> u64 {
    let born = std::fs::metadata(&a.path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    match (born, a.first_seen) {
        (0, f) => f,
        (b, 0) => b,
        (b, f) => b.min(f),
    }
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
/// A subagent or an in-process teammate: an agent a session launched, which finishes ("done") rather than waits.
pub(crate) fn is_child(a: &Agent) -> bool {
    a.kind == kind_name("subagent") || a.kind == kind_name("teammate")
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
    /// A background shell command: its result names the task whose end the session is told of.
    #[serde(default)]
    pub bg: bool,
    /// A push command: a successful result counts a push (alongside `class`, which a `commit && push` line keeps as `commit`).
    #[serde(default)]
    pub push: bool,
    /// A background subagent launch: its result is only the launch acknowledgement, the report comes later as a task notice.
    #[serde(default)]
    pub ack: bool,
    /// Files the shell command creates or appends (`>`, `>>`, `tee`, a download's output option; patterns.shell_write): each new one is
    /// an outcome when the command succeeds (GH #458).
    #[serde(default)]
    pub writes: Vec<String>,
    /// A shell command with a segment backgrounded by a top-level `&` (agent_tracker.bg_delims, found by the engine shell splitter):
    /// its success is only the launching shell's, so it earns no HARD outcome (PR #472).
    #[serde(default)]
    pub amp: bool,
    /// The directory the call ran in: the transcript line's working directory, its literal `cd`s followed (PR #472 round 5: its
    /// repository's state decides HARD credit).
    #[serde(default)]
    pub cwd: String,
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
    /// The session key the delivered row names (the parent that got it).
    #[serde(default)]
    pub delivered_to: String,
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
    /// The workspace is the Primary checkout of its project (judged by the checkout, whatever id the app registered it under).
    #[serde(default)]
    pub primary: bool,
}

/// Everything the tracker keeps about one agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Agent {
    /// The agent id (a session id, a subagent id, a heartbeat id).
    pub id: String,
    /// `main`, `subagent`, `teammate`, `codex`, `workspace` or `heartbeat`.
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
    /// This tick consumed a complete, valid transcript through its current end.
    #[serde(default)]
    pub transcript_complete: bool,
    /// Proven coverage from byte zero (older cached offsets alone cannot prove it).
    #[serde(default)]
    pub transcript_from_start: bool,
    /// Work runs in a background Codex job; wrapper tool counts do not measure it.
    #[serde(default)]
    pub codex_rescue: bool,
    /// Rescue launches awaiting their host result.
    #[serde(default)]
    pub rescue_calls: std::collections::BTreeSet<String>,
    /// Children whose launch or returned Codex job identified them as rescue wrappers.
    #[serde(default)]
    pub rescue_children: std::collections::BTreeSet<String>,
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
    /// Successful pushes.
    #[serde(default)]
    pub pushes: u64,
    /// Successful merges and deploys (`gh pr merge`, a deploy command): the work that reaches users, counted as outcomes.
    #[serde(default)]
    pub shipped: u64,
    /// When the last commit, push, merge or deploy of the agent succeeded.
    #[serde(default)]
    pub last_ship_ms: u64,
    /// Tool results that carried an anti-hall guard block (the cost report's "guard fires").
    #[serde(default)]
    pub guard_fires: u64,
    /// Test runs that passed.
    pub tests_pass: u64,
    /// Builds and compile checks that finished.
    #[serde(default)]
    pub builds_ok: u64,
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
    /// No live process and nothing left to come back to (its project directory or transcript is gone, or it has been silent past
    /// `limits.dead_idle_ms` with no live parent): state `dead`, out of the live list. Decided afresh each tick; nothing is deleted.
    #[serde(default)]
    pub dead: bool,
    /// Its parent was told once that it died.
    #[serde(default)]
    pub dead_noticed: bool,
    /// The team a teammate belongs to (its meta file).
    #[serde(default)]
    pub team: String,
    /// The host's meta file records the agent as finished.
    #[serde(default)]
    pub finished: bool,
    /// A Codex rollout as last read: (mtime, size), so an unchanged file is not read again.
    #[serde(default)]
    pub codex_stamp: (u64, u64),
    /// A Codex rollout's last turn has ended (a terminal record is the last mark in its tail).
    #[serde(default)]
    pub codex_terminal: bool,
    /// A Codex rollout is a one-shot run (its originator is one of `exec_originators`).
    #[serde(default)]
    pub codex_exec: bool,
    /// Its transcript start was checked and is not a headless run (checked once).
    #[serde(default)]
    pub interactive: bool,
    /// The pid of the live process the session registry joined to this agent (0 = none).
    #[serde(default)]
    pub pid: u32,
    /// A nudge about one of its children is open: its turns are kept (`turns`).
    #[serde(default)]
    pub watch: bool,
    /// While `watch`: its newest turns after the nudge, (time, kind, text) - a tool call as `<tool>\t<value>...`, or a reply's text.
    #[serde(default)]
    pub turns: Vec<(u64, String, String)>,
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
    /// When its soft outcomes happened (a file the shell wrote, a passing check, a completed live probe; GH #458): they never reset the
    /// burn accounting, they may only hold off the pause (burn.soft_hold).
    #[serde(default)]
    pub soft_ts: Vec<u64>,
    /// The burn episode the pause hold-offs belong to: the progress (hard outcomes) it started at, when it started (the last hard outcome,
    /// or when the agent was first seen) and how many events (soft outcomes, build launches) came since. A hard outcome (progress moves)
    /// starts a new episode; burn.soft_hold caps the events and the length of an episode (PR #472).
    #[serde(default)]
    pub soft_episode: (u64, u64, u64),
    /// Real changes seen (PR #472 round 4): a successful edit, a fresh shell write, a commit. Outside a repository (or with git
    /// unavailable) a passing check, build or test with no change since the last HARD credit is no HARD credit (PR #472 round 5).
    #[serde(default)]
    pub changes: u64,
    /// The repo state (agents::repo::state) at the last HARD credit in each repository, by its top-level directory (PR #472 round 5):
    /// a passing check, build or test, or a verified write, earns HARD only when its repository's state differs.
    #[serde(default)]
    pub repo_states: BTreeMap<String, String>,
    /// `changes` at the last HARD credit (PR #472 round 5): outside a repository a check, build or test earns HARD only after a change.
    #[serde(default)]
    pub hard_changes: Option<u64>,
    /// The declared step.
    pub step: String,
    /// The task whose subject is the declared step (empty when the step came from elsewhere).
    #[serde(default)]
    pub step_task: String,
    /// Task id -> subject, from the task-list creates and updates this agent made (names the step of a status-only update).
    #[serde(default)]
    pub task_names: std::collections::BTreeMap<String, String>,
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
    /// A task is open (a declared step not yet completed): set when a step is declared, cleared when the task list or an update completes it.
    #[serde(default)]
    pub open: bool,
    /// Background shell tasks it started and has not seen end: task id, when it started.
    #[serde(default)]
    pub bg_ids: BTreeMap<String, u64>,
    /// Background tasks among `bg_ids` whose command is of a doubt class (burn.doubt.classes: a build), GH #458.
    #[serde(default)]
    pub bg_builds: Vec<String>,
    /// The outcome a background shell task among `bg_ids` stands to earn once it ends with success (PR #472): it is a check, and the
    /// files it writes. A background launch is at most a SOFT outcome; its completion notice with a success status is the HARD one.
    #[serde(default)]
    pub bg_outcomes: BTreeMap<String, (bool, Vec<String>)>,
    /// When the call that launched each task in `bg_outcomes` began and its working directory: a file it claims counts only when
    /// modified at or after that.
    #[serde(default)]
    pub bg_starts: BTreeMap<String, (u64, String)>,
    /// Background shell tasks that ended and are not yet reported: task id, when it ended.
    #[serde(default)]
    pub exited: Vec<(String, u64)>,
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
    /// The waste sensor's last evaluation of this agent (score, judge verdict, action).
    #[serde(default)]
    pub waste: waste::Mark,
    /// Signals up now.
    pub flags: BTreeMap<String, Flag>,
    /// Its last distinct progress lines (the first line of each reply text), newest last (GH #518, `nudges.stall.lines_kept`).
    #[serde(default)]
    pub said: Vec<String>,
    /// When the newest of `said` first appeared, and its progress units then.
    #[serde(default)]
    pub said_since: u64,
    /// Progress units when the newest line of `said` first appeared.
    #[serde(default)]
    pub said_progress: u64,
    /// Its last reply text, cut at `nudges.parallel.reply_chars` (GH #517: the gap lines).
    #[serde(default)]
    pub last_reply: String,
    /// The observable stall fingerprint of the last sample (transcript offset, tool calls, commits, changes, progress, edits, line).
    #[serde(default)]
    pub stall_obs: Vec<u64>,
    /// Since when `stall_obs` holds.
    #[serde(default)]
    pub stall_since: u64,
    /// When each signal was last reminded.
    pub last_sent: BTreeMap<String, u64>,
    /// Reminders queued (signal, time), for the daily cap.
    pub sent_log: Vec<(String, u64)>,
    /// When the owner last sent this session a message (0 = not seen); only read for main and workspace sessions.
    #[serde(default)]
    pub owner_ms: u64,
    /// Subagent results returned to this agent (a foreground launch's result, a completed task notice), counted as outcomes.
    #[serde(default)]
    pub reports: u64,
    /// Task ids whose notice was already counted as a result (a task may notify more than once).
    #[serde(default)]
    pub report_ids: Vec<String>,
    /// Hash of the step text the drift reminder was last sent for (0 = none): one drift reminder per declared step.
    #[serde(default)]
    pub drift_step: u64,
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
    /// Lock-holder stalls the watchdog alerted on.
    #[serde(default)]
    pub lock_stalls: u64,
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
    /// When the host's session listing was last taken, and the main and workspace agents it named.
    #[serde(default)]
    pub cli_listed: u64,
    /// The ids of the main and workspace agents the last listing was taken for.
    #[serde(default)]
    pub cli_seen: Vec<String>,
    /// Headless one-shot transcripts seen in the active window (not agents: never tracked or listed).
    #[serde(default)]
    pub headless: std::collections::BTreeSet<String>,
    /// The lock-holder watchdog's memory per lock file.
    #[serde(default)]
    pub locks: BTreeMap<String, lockwatch::LockWatch>,
    /// When the watchdog last ran.
    #[serde(default)]
    pub lock_checked: u64,
    /// The open nudges, by child id.
    #[serde(default)]
    pub nudges: BTreeMap<String, nudge::Nudge>,
    /// The closed nudges, oldest first (bounded by agent_nudge.limits.log_max).
    #[serde(default)]
    pub nudge_log: Vec<nudge::Nudge>,
    /// Rows of the nudge answers file already read.
    #[serde(default)]
    pub nudge_answer_lines: u64,
    /// Children the health judge called busy: no nudge until the time given.
    #[serde(default)]
    pub nudge_hold: BTreeMap<String, u64>,
    /// Children the health judge called done (#430): held while idle, read only with agents.nudgeScope on.
    #[serde(default)]
    pub nudge_done_hold: BTreeMap<String, nudge::DoneHold>,
    /// Snoozes by child and trigger (`<child>|<trigger>`): they outlive the nudge they were given to (#333).
    #[serde(default)]
    pub nudge_snooze: BTreeMap<String, nudge::Snooze>,
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

/// A child's launch identity for the guards: (the tool call id that launched it, its agent type), each "" when unknown. Both come
/// from the host's meta file (`agent_tracker.meta` tool_use_id, `agent_tracker.no_work` agent_type_fields); a child the tracker
/// knows as a Codex rescue wrapper has the rescue type even when its meta names none (hosts that keep the type in the launch input).
fn launch_of(a: &Agent) -> (String, String) {
    let meta = if is_child(a) { sources::json_of(std::path::Path::new(&facts::meta_path(&a.path))) } else { None };
    let field = |k: &str| meta.as_ref().and_then(|m| m.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let nw = defaults::raw("agent_tracker.no_work");
    let tool_use_id = field(defaults::raw("agent_tracker.meta").str_field("tool_use_id"));
    let named = nw.get("agent_type_fields").map(V::strings).unwrap_or_default().iter().map(|k| field(k)).find(|t| !t.is_empty()).unwrap_or_default();
    // an explicit type in the meta wins (a general-purpose child that merely runs Codex stays general-purpose); the rescue type is inferred only when none is named
    let agent_type = if named.is_empty() && a.codex_rescue { nw.str_field("rescue_type").to_string() } else { named };
    (tool_use_id, agent_type)
}

/// A read-only, request-local reconciliation of retained tracker rows for guards.
/// Reuse the tracker's ingestion and state rules; never tick, save, probe a CLI,
/// deliver reminders or rewrite the user's history from a hook decision.
pub(crate) fn guard_rows(env: &Env, session: &str, transcript: &str, cwd: &str) -> Vec<Value> {
    let mut st = load_state(env);
    let owner = st.agents.values().find(|a| a.path == transcript).map(|a| a.id.clone()).unwrap_or_else(|| session.to_string());
    st.agents.retain(|_, a| a.id == owner || a.parent == owner || (!cwd.is_empty() && a.cwd == cwd));
    let sessions = live::registry(env);
    live::apply(&mut st, sessions.as_deref(), false);
    let mut readable = std::collections::BTreeSet::new();
    for a in st.agents.values_mut() {
        let mtime = crate::checks::agent_scan::mtime_ms(std::path::Path::new(&a.path));
        if a.kind == kind_name("codex") {
            if let Some(mtime) = mtime {
                live::codex_state(env, a, mtime as u64);
                if std::fs::File::open(&a.path).is_ok() {
                    readable.insert(a.id.clone());
                }
            }
        } else if mtime.is_some() {
            facts::ingest(a, env.now_ms);
            if a.transcript_complete {
                readable.insert(a.id.clone());
            }
            if is_child(a)
                && let Some(meta) = sources::json_of(std::path::Path::new(&facts::meta_path(&a.path)))
                && let Some(finished) = meta.get(defaults::raw("agent_tracker.meta").str_field("finished")).and_then(Value::as_bool)
            {
                a.finished |= finished;
            }
        }
    }
    sources::reconcile_children(env, &mut st);
    sources::mark_dead(env, &mut st);
    let mut out = Vec::new();
    for a in st.agents.values() {
        let state = signals::state_of(a);
        let known = readable.contains(&a.id) && a.last_output_ms > 0 && env.now_ms.saturating_sub(a.last_output_ms) <= lim("active_window_ms");
        let (tool_use_id, agent_type) = launch_of(a);
        out.push(serde_json::json!({"id": a.id, "name": a.name, "parent": a.parent, "kind": a.kind,
            "state": state, "known": known, "lastSeenMs": a.last_output_ms, "toolUseId": tool_use_id, "agentType": agent_type}));
        for (id, started) in &a.bg_ids {
            out.push(serde_json::json!({"id": id, "name": id, "parent": a.id,
                "kind": defaults::text("agent_tracker.guard_job_kind"), "state": if a.dead || a.gone || a.finished { state } else { state_name("running") },
                "known": known && env.now_ms.saturating_sub(*started) <= lim("bg_bash_ms"), "lastSeenMs": a.last_output_ms}));
        }
    }
    out
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
