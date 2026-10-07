//! Built-in checks: real logic that a regex rule cannot express (D29, D30).
//!
//! A rule names a check (`"check": "git"`); the engine looks it up in the registry here and runs it on the
//! hook payload. Adding a check means implementing [`Check`] in its own module and listing it in
//! [`registry`]; nothing else in the engine changes.
//!
//! Why a trait plus a registry instead of a `match` on names: rules refer to checks by name from data
//! files, so the set of valid names must be discoverable at runtime (rule validation, `docs`, `status`).
pub mod agent_scan;
pub mod api_guard;
pub mod ask_guard;
pub mod claim_ledger;
pub mod codex;
pub mod command;
pub mod compact_decl;
pub mod coordinator_work;
pub mod ctxbudget;
pub mod devswarm_comms;
pub mod devswarm_gates;
pub mod devswarm_prompt;
pub mod devswarm_role;
pub mod dispatch_tier;
pub mod edit_guard;
pub mod emit_dedupe;
pub mod fable_availability;
pub mod failure_nudge;
pub mod git;
pub mod guardkit;
pub mod handover;
pub mod idle_agent_sweep;
pub mod inbox_read_guard;
pub mod jsport;
pub mod merge_gate;
pub mod merge_side_pick;
pub mod model_routing;
pub mod orch_on_spawn;
pub mod output_verify;
pub mod phase_tracker;
pub mod replykit;
pub mod scan_throttle;
pub mod session;
pub mod session_gates;
pub mod ship_it;
pub mod silent_agent_nudge;
pub mod spawnctx;
pub mod speculation_guard;
pub mod speculation_judge;
pub mod stale_agent_stop_note;
pub mod swarm_guard;
pub mod task_guard;
pub mod task_lifecycle_log;
pub mod taskkit;
pub mod tasklist_guard;
pub mod taskstate;
pub mod verify_first;
pub mod verify_first_orch;
pub mod verify_first_prompt;

use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// What a check decided about one payload.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Verdict {
    /// Nothing to say.
    Allow,
    /// Refuse: exit code 2 with this reason on stderr (the way the Node guards block).
    Block(String),
    /// Exit 0 with this stdout JSON line, no decision.
    Advisory(String),
    /// Exact exit code, stdout and stderr bytes, for a Node guard whose output is not one of the shapes above
    /// (for example the JSON block of `io.blockDecision`).
    Exact(Exact),
    /// The Node guard may decide differently (for example a Jev consult would run): the engine answers with a
    /// deferral and the client runs the Node hook, so a deferral is never a silent allow (D11).
    Defer,
    /// A verdict plus rich telemetry events the daemon should record before handling the verdict.
    Routed(Box<Verdict>, Vec<RouteMeta>),
}

/// The exact output of a Node guard: exit code, stdout and stderr, byte for byte.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Exact {
    /// The exit code.
    pub code: i32,
    /// What goes to stdout.
    pub out: String,
    /// What goes to stderr.
    pub err: String,
}

/// Rich route telemetry emitted by a routing check.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct RouteMeta {
    /// The model named in the spawn, or the inherited marker for omitted models.
    pub requested_model: String,
    /// The selected or inherited model known to the guard.
    pub parent_model: String,
    /// The classified task class.
    pub task_class: String,
    /// Recommended model tier.
    pub recommended_tier: String,
    /// Model selected by the decision, or the inherited parent model when no child model was named.
    pub selected_model: String,
    /// Route decision outcome (`allow`, `advise`, or `deny`).
    pub outcome: String,
    /// Opaque key for linking with spawn telemetry.
    pub spawn_key: String,
    /// Whether this deny forces delegation to another model.
    pub delegate: bool,
    /// Whether the verdict this route rides on blocks the spawn (exit 2), forced delegation or not.
    pub blocked: bool,
}

impl Exact {
    /// The block `io.blockDecision(reason)` produces (`hooks/lib/guard-io.js`): the JSON decision and a newline on
    /// stdout, the reason and a newline on stderr, exit 2. The JSON is written by hand so the key order is the Node
    /// object's (`decision`, then `reason`), whatever the JSON library's map order is.
    pub fn json_block(reason: &str) -> Exact {
        let quoted = serde_json::to_string(reason).unwrap_or_else(|_| String::from("\"\""));
        Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{quoted}}}\n"), err: format!("{reason}\n") }
    }
}

/// A built-in check.
pub trait Check: Send + Sync {
    /// Stable name used in rules (`"check": "<name>"`) and in `docs`.
    fn name(&self) -> &'static str;
    /// One line for the generated reference.
    fn summary(&self) -> &'static str;
    /// Run on a payload. `None` means the check does not apply to this event or tool; `opts` is the rule's
    /// free-form `options` object.
    fn run(&self, subject: &Subject<'_>, opts: &Value) -> Option<Verdict>;
    /// Like [`Check::run`] but also given the whole hook payload, for checks that need fields a [`Subject`] does not
    /// carry (`session_id`, `transcript_path`, `agent_id`, `tool_use_id`, the exact event name). The dispatcher calls
    /// this one; a check that needs only the subject keeps this default.
    fn run_payload(&self, subject: &Subject<'_>, _payload: &Value, opts: &Value) -> Option<Verdict> {
        self.run(subject, opts)
    }
    /// Like [`Check::run_payload`] but also given the environment of the request (D76): the variables the host's
    /// hook process had, never the daemon's own. Every caller that evaluates a check goes through this one; a check that
    /// reads no environment keeps this default.
    fn run_env(&self, subject: &Subject<'_>, payload: &Value, opts: &Value, _env: &RequestEnv) -> Option<Verdict> {
        self.run_payload(subject, payload, opts)
    }
}

/// Evaluate `check` for one request: the one place every dispatcher goes through. When the request's environment is
/// incomplete (dropped over the cap, absent, or no usable `HOME`) the check is not evaluated at all and the answer is
/// [`Verdict::Defer`], so Node, which sees the real environment, decides. Evaluating with no home and default switches
/// would read a gate that is on as off and allow what Node blocks.
pub fn run_env_guarded(check: &dyn Check, subject: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
    if env.is_incomplete() {
        return Some(Verdict::Defer);
    }
    check.run_env(subject, payload, opts, env)
}

/// Compile a regular expression that is a literal in this source.
///
/// Why this exists instead of `Regex::new(..).unwrap()` at every call site: the pattern is fixed text compiled
/// the first time its code path runs, so a failure is a bug in the source, not a runtime condition. The tests that
/// exercise each code path compile every such pattern, so an invalid one fails the build, not a user.
pub(crate) fn lit_re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap_or_else(|e| panic!("{}: {e}", crate::defaults::text("msg.regex_literal_invalid")))
}

/// Every built-in check, in a fixed order.
pub fn registry() -> &'static [&'static dyn Check] {
    static ALL: [&dyn Check; 61] = [
        &git::GitGuard,
        &merge_side_pick::MergeSidePick,
        &ship_it::ShipItGuard,
        &scan_throttle::ScanThrottle,
        &coordinator_work::CoordinatorWorkGuard,
        &compact_decl::CompactDeclarationGuard,
        &command::CommandGuard,
        &model_routing::ModelRouting,
        &failure_nudge::FailureRootCauseNudge,
        &git::audit::GitAudit,
        &verify_first::VerifyFirstSubagent,
        &verify_first::VerifyFirstFull,
        &fable_availability::FableAvailability,
        &inbox_read_guard::InboxReadGuard,
        &phase_tracker::PhaseTracker,
        &orch_on_spawn::OrchOnSpawn,
        &verify_first_orch::VerifyFirstOrch,
        &verify_first_prompt::VerifyFirst,
        &idle_agent_sweep::IdleAgentSweep,
        &emit_dedupe::EmitDedupeReset,
        &ctxbudget::limit::LimitConserveInject,
        &ctxbudget::handover::AutoHandover,
        &ctxbudget::handover::AutoHandoverPauseNag,
        &ctxbudget::advice::CompactAdviceGuard,
        &session::version_alert::VersionAlert,
        &session::devswarm_version::DevswarmVersion,
        &session::claude_cli_version::ClaudeCliVersion,
        &session::repo_self_drift::RepoSelfDrift,
        &session::defect_nudge::DefectNudge,
        &session::progress_prune::ProgressPrune,
        &speculation_guard::SpeculationGuard,
        &speculation_judge::SpeculationJudge,
        &claim_ledger::ClaimLedger,
        &output_verify::OutputVerifyGuard,
        &ask_guard::AskGuard,
        &silent_agent_nudge::SilentAgentNudge,
        &stale_agent_stop_note::StaleAgentStopNote,
        &merge_gate::MergeGate,
        &api_guard::ApiGuard,
        &edit_guard::EditGuard,
        &devswarm_comms::DevswarmCommsGuard,
        &swarm_guard::SwarmGuard,
        &session_gates::JevWeeklyScorecard,
        &session_gates::JevReviewReminder,
        &session_gates::RepairOnReload,
        &codex::availability::CodexAvailability,
        &codex::detect::CodexQuotaDetect,
        &codex::nudge::CodexNudge,
        &handover::precompact::PrecompactSnapshot,
        &handover::resume::HandoverResume,
        &task_lifecycle_log::TaskLifecycleLog,
        &dispatch_tier::DispatchTier,
        &task_guard::TaskGuard,
        &tasklist_guard::TasklistGuard,
        &devswarm_prompt::DevswarmParentInbox,
        &devswarm_prompt::DevswarmChildTurn,
        &devswarm_role::DevswarmChildRole,
        &devswarm_role::DevswarmParentGate,
        &devswarm_gates::DevswarmChildGate,
        &devswarm_gates::DevswarmParentReplyTracker,
        &devswarm_gates::DevswarmChildDrain,
    ];
    &ALL
}

/// Look a check up by its rule name.
pub fn get(name: &str) -> Option<&'static dyn Check> {
    registry().iter().copied().find(|c| c.name() == name)
}

/// `ah-engine check <name>`: run one check in-process on a hook payload from stdin and print what the Node guard
/// would (exit 2 + stderr for a block, a stdout JSON line for an advisory, `AHFALLBACK` for a deferral). The
/// parity harness drives this to compare a Rust check with its Node original without a daemon.
pub fn cli_main(name: &str) -> i32 {
    use std::io::{Read, Write};
    let Some(check) = get(name) else {
        let _ = writeln!(std::io::stderr(), "{}", crate::defaults::render("msg.err_unknown_check", &[("name", &format!("{name:?}"))]));
        return 64;
    };
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    // A payload serde_json rejects is deferred to Node, which may still parse it (a lone surrogate escape): the engine
    // must not block what Node would decide on (D74).
    let Ok(p) = serde_json::from_str::<Value>(&raw) else {
        let _ = writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK);
        return 0;
    };
    let null = Value::Null;
    let subject = Subject {
        event: p.get("hook_event_name").and_then(Value::as_str).unwrap_or("PreToolUse"),
        tool: p.get("tool_name").and_then(Value::as_str),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    let opts = serde_json::json!({ "payload_sha1": emit_dedupe::sha1_hex(raw.as_bytes()) });
    match run_env_guarded(check, &subject, &p, &opts, &RequestEnv::capture()) {
        None | Some(Verdict::Allow) => 0,
        Some(Verdict::Block(m)) => {
            let _ = writeln!(std::io::stderr(), "{m}");
            2
        }
        Some(Verdict::Advisory(j)) => {
            let _ = writeln!(std::io::stdout(), "{j}");
            0
        }
        Some(Verdict::Exact(x)) => {
            let _ = std::io::stderr().write_all(x.err.as_bytes());
            let _ = std::io::stdout().write_all(x.out.as_bytes());
            x.code
        }
        Some(Verdict::Defer) => {
            let _ = writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK);
            0
        }
        Some(Verdict::Routed(inner, _)) => match *inner {
            Verdict::Allow => 0,
            Verdict::Block(m) => {
                let _ = writeln!(std::io::stderr(), "{m}");
                2
            }
            Verdict::Advisory(j) => {
                let _ = writeln!(std::io::stdout(), "{j}");
                0
            }
            Verdict::Exact(x) => {
                let _ = std::io::stderr().write_all(x.err.as_bytes());
                let _ = std::io::stdout().write_all(x.out.as_bytes());
                x.code
            }
            Verdict::Defer => {
                let _ = writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK);
                0
            }
            Verdict::Routed(_, _) => 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected values computed with Node: `io.blockDecision(reason)` from `hooks/lib/guard-io.js`.
    #[test]
    fn the_json_block_matches_node_io_block_decision() {
        let cases = [
            ("plain reason", "{\"decision\":\"block\",\"reason\":\"plain reason\"}\n", "plain reason\n"),
            ("quote \" back \\ nl\nend", "{\"decision\":\"block\",\"reason\":\"quote \\\" back \\\\ nl\\nend\"}\n", "quote \" back \\ nl\nend\n"),
            (
                "tab\t ctl\u{1} uni é \u{1F600} \u{2028}",
                "{\"decision\":\"block\",\"reason\":\"tab\\t ctl\\u0001 uni é \u{1F600} \u{2028}\"}\n",
                "tab\t ctl\u{1} uni é \u{1F600} \u{2028}\n",
            ),
        ];
        for (reason, out, err) in cases {
            assert_eq!(Exact::json_block(reason), Exact { code: 2, out: out.into(), err: err.into() }, "{reason:?}");
        }
    }

    #[test]
    fn registry_names_are_unique_and_resolvable() {
        let names: Vec<&str> = registry().iter().map(|c| c.name()).collect();
        for n in &names {
            assert_eq!(names.iter().filter(|x| *x == n).count(), 1, "duplicate check {n}");
            assert!(get(n).is_some());
        }
        assert!(get("nope").is_none());
    }
}
