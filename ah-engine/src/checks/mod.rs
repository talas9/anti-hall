//! Built-in checks: real logic that a regex rule cannot express (D29, D30).
//!
//! A rule names a check (`"check": "git"`); the engine looks it up in the registry here and runs it on the
//! hook payload. Adding a check means implementing [`Check`] in its own module and listing it in
//! [`registry`]; nothing else in the engine changes.
//!
//! Why a trait plus a registry instead of a `match` on names: rules refer to checks by name from data
//! files, so the set of valid names must be discoverable at runtime (rule validation, `docs`, `status`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

pub mod agent_scan;
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
pub mod emit_dedupe;
pub mod failure_nudge;
pub mod git;
pub mod guardkit;
pub mod handover;
pub mod idle_agent_sweep;
pub mod jsport;
pub mod mcp_reaper;
pub mod merge_gate;
pub mod merge_side_pick;
pub mod output_verify;
pub mod phase_tracker;
pub mod replykit;
pub mod scan_throttle;
pub mod scripted;
pub mod session;
pub mod session_gates;
pub mod ship_it;
pub mod silent_agent_nudge;
pub mod spawnctx;
pub mod speculation_guard;
pub mod speculation_judge;
pub mod stale_agent_stop_note;
pub mod task_guard;
pub mod task_lifecycle_log;
pub mod task_tracker;
pub mod taskkit;
pub mod tasklist_guard;
pub mod taskstate;
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
    /// True when the decision logic of this check is a plugin script (D88): the registered struct is a name plus a
    /// summary and holds no decision of its own. The v1.0 gate counts the checks for which this is false.
    fn scripted(&self) -> bool {
        false
    }
}

/// How many registry checks still decide in compiled Rust (`compiled_logic_checks_remaining`, the v1.0 gate of D88: it
/// reaches 0 when every check's logic is a plugin script).
pub fn compiled_logic_checks_remaining() -> usize {
    registry().iter().filter(|c| !c.scripted()).count()
}

/// Evaluate `check` for one request: the one place every dispatcher goes through. When the request's environment is
/// incomplete (dropped over the cap, absent, or no usable `HOME`) the check is not evaluated at all and the answer is
/// [`Verdict::Defer`], so Node, which sees the real environment, decides. Evaluating with no home and default switches
/// would read a gate that is on as off and allow what Node blocks.
pub fn run_env_guarded(check: &dyn Check, subject: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
    if env.is_incomplete() {
        return Some(crate::script::failed(check.name(), subject.event, crate::defaults::text("script.msg_env_incomplete")));
    }
    // a settings file only JavaScript can parse (a number like 1e400, nesting past 128) is not "missing": defer to Node
    let home = env.get(crate::defaults::env_name("home")).or_else(|| env.get(crate::defaults::env_name("home_alt"))).unwrap_or_default();
    if guardkit::settings::unreadable_settings_file(home) {
        return Some(crate::script::failed(check.name(), subject.event, crate::defaults::text("script.msg_settings_unreadable")));
    }
    // D88: a check whose logic ships as a plugin script runs the script (unless `script.enabled` is 0).
    if let Some(v) = crate::script::run(check.name(), payload, opts, subject.event, env) {
        return v;
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
    static ALL: [&dyn Check; 65] = [
        &scripted::GIT_GUARD,
        &merge_side_pick::MergeSidePick,
        &ship_it::ShipItGuard,
        &scan_throttle::ScanThrottle,
        &coordinator_work::CoordinatorWorkGuard,
        &compact_decl::CompactDeclarationGuard,
        &command::CommandGuard,
        &scripted::MODEL_ROUTING,
        &failure_nudge::FailureRootCauseNudge,
        &scripted::GIT_AUDIT,
        &scripted::VERIFY_FIRST_SUBAGENT,
        &scripted::VERIFY_FIRST_FULL,
        &scripted::FABLE_AVAILABILITY,
        &scripted::INBOX_READ_GUARD,
        &phase_tracker::PhaseTracker,
        &scripted::ORCH_ON_SPAWN,
        &verify_first_orch::VerifyFirstOrch,
        &verify_first_orch::VerifyFirstOrchCodex,
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
        &scripted::API_GUARD,
        &scripted::EDIT_GUARD,
        &devswarm_comms::DevswarmCommsGuard,
        &scripted::SWARM_GUARD,
        &session_gates::JevWeeklyScorecard,
        &session_gates::JevReviewReminder,
        &session_gates::RepairOnReload,
        &codex::availability::CodexAvailability,
        &codex::detect::CodexQuotaDetect,
        &codex::nudge::CodexNudge,
        &handover::precompact::PrecompactSnapshot,
        &handover::resume::HandoverResume,
        &task_lifecycle_log::TaskLifecycleLog,
        &scripted::DISPATCH_TIER,
        &task_guard::TaskGuard,
        &tasklist_guard::TasklistGuard,
        &devswarm_prompt::DevswarmParentInbox,
        &devswarm_prompt::DevswarmChildTurn,
        &devswarm_role::DevswarmChildRole,
        &devswarm_role::DevswarmParentGate,
        &devswarm_gates::DevswarmChildGate,
        &devswarm_gates::DevswarmParentReplyTracker,
        &devswarm_gates::DevswarmChildDrain,
        &scripted::SIBLING_SWEEP,
        &mcp_reaper::SessionEndMcpReaper,
        &task_tracker::TaskTracker,
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
    // a one-shot process: the speculation judge may wait for its model call here, never in the daemon
    crate::judge::allow_blocking_calls();
    let Some(check) = get(name) else {
        crate::discard::harmless(writeln!(std::io::stderr(), "{}", crate::defaults::render("msg.err_unknown_check", &[("name", &format!("{name:?}"))]))); // keep: a closed pipe leaves nobody to tell
        return 64;
    };
    let mut raw = String::new();
    crate::discard::harmless(std::io::stdin().read_to_string(&mut raw)); // keep: a closed pipe leaves nobody to tell
    // A payload serde_json rejects is deferred to Node, which may still parse it (a lone surrogate escape): the engine
    // must not block what Node would decide on (D74).
    let Ok(p) = serde_json::from_str::<Value>(&raw) else {
        crate::discard::harmless(writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK)); // keep: a closed pipe leaves nobody to tell
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
            crate::discard::harmless(writeln!(std::io::stderr(), "{m}")); // keep: a closed pipe leaves nobody to tell
            2
        }
        Some(Verdict::Advisory(j)) => {
            crate::discard::harmless(writeln!(std::io::stdout(), "{j}")); // keep: a closed pipe leaves nobody to tell
            0
        }
        Some(Verdict::Exact(x)) => {
            crate::discard::harmless(std::io::stderr().write_all(x.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
            crate::discard::harmless(std::io::stdout().write_all(x.out.as_bytes())); // keep: a closed pipe leaves nobody to tell
            x.code
        }
        Some(Verdict::Defer) => {
            crate::discard::harmless(writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK)); // keep: a closed pipe leaves nobody to tell
            0
        }
        Some(Verdict::Routed(inner, _)) => match *inner {
            Verdict::Allow => 0,
            Verdict::Block(m) => {
                crate::discard::harmless(writeln!(std::io::stderr(), "{m}")); // keep: a closed pipe leaves nobody to tell
                2
            }
            Verdict::Advisory(j) => {
                crate::discard::harmless(writeln!(std::io::stdout(), "{j}")); // keep: a closed pipe leaves nobody to tell
                0
            }
            Verdict::Exact(x) => {
                crate::discard::harmless(std::io::stderr().write_all(x.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
                crate::discard::harmless(std::io::stdout().write_all(x.out.as_bytes())); // keep: a closed pipe leaves nobody to tell
                x.code
            }
            Verdict::Defer => {
                crate::discard::harmless(writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK)); // keep: a closed pipe leaves nobody to tell
                0
            }
            Verdict::Routed(_, _) => 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review P0 (D74): a settings file that exists but that serde cannot parse while JavaScript can (`1e400` is `Infinity`; nesting
    /// past 128) was read as missing, so an opt-in block mode was ignored and the engine allowed where Node blocks. Every check now
    /// defers; a file both parsers reject is missing for both and changes nothing.
    #[test]
    fn a_settings_file_only_javascript_can_parse_defers_every_check() {
        let home = std::env::temp_dir().join(format!("ah-badsettings-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        let h = home.to_string_lossy().to_string();
        let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
        let payload = serde_json::json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"header": "DESTRUCTIVE", "question": "q"}]}});
        let null = Value::Null;
        let subject = Subject { event: "PreToolUse", tool: Some("AskUserQuestion"), cwd: None, tool_input: &null, prompt: None };
        let run = || run_env_guarded(&ask_guard::AskGuard, &subject, &payload, &Value::Null, &env);
        let write = |text: &str| std::fs::write(home.join(".anti-hall/settings.json"), text).unwrap();
        // the baseline: a readable file with the block mode on is answered, not deferred
        write(r#"{"guards":{"noBlockingQuestions":"block"}}"#);
        assert_ne!(run(), Some(Verdict::Defer), "a readable settings file is answered by the check");
        // a number beyond f64 (JavaScript: Infinity)
        write(r#"{"guards":{"noBlockingQuestions":"block"},"x":1e400}"#);
        assert_eq!(run(), Some(Verdict::Defer), "1e400");
        // nesting past serde's recursion limit
        write(&format!(r#"{{"guards":{{"noBlockingQuestions":"block"}},"deep":{}1{}}}"#, "[".repeat(200), "]".repeat(200)));
        assert_eq!(run(), Some(Verdict::Defer), "depth 200");
        // a lone surrogate escape
        write(r#"{"guards":{"noBlockingQuestions":"block"},"s":"\ud800"}"#);
        assert_eq!(run(), Some(Verdict::Defer), "lone surrogate");
        // text both parsers reject is a missing file for both: the check answers (with the defaults)
        write("{oops");
        assert_ne!(run(), Some(Verdict::Defer), "a syntax error is missing for Node too");
        // review 3: the legacy Jev file (`jev.json`) is read below settings.json by Node's resolver, so it counts too
        write(r#"{"guards":{"noBlockingQuestions":"block"}}"#);
        let jev = home.join(".anti-hall/jev.json");
        for (name, body) in [
            ("jev 1e400", r#"{"enabled":true,"integrations":{"dispatchTier":"on"},"x":1e400}"#.to_string()),
            ("jev bigint", format!(r#"{{"enabled":true,"x":1{}}}"#, "0".repeat(400))),
            ("jev surrogate", r#"{"enabled":true,"x":"\ud800"}"#.to_string()),
        ] {
            std::fs::write(&jev, body).unwrap();
            assert_eq!(run(), Some(Verdict::Defer), "{name}");
        }
        std::fs::write(&jev, r#"{"enabled":true}"#).unwrap();
        assert_ne!(run(), Some(Verdict::Defer), "a readable jev.json is answered");
        crate::discard::harmless(std::fs::remove_file(&jev)); // keep: cleanup that raced; an absent file is the goal state
        // the host's settings file and the skip file are read by the same chain
        write(r#"{"guards":{"noBlockingQuestions":"block"}}"#);
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"pluginConfigs":{"a":{"n":1e999}}}"#).unwrap();
        assert_eq!(run(), Some(Verdict::Defer), "~/.claude/settings.json");
        std::fs::write(home.join(".claude/settings.json"), "{}").unwrap();
        std::fs::write(home.join(".anti-hall/skip.json"), r#"{"ask-guard":1e999}"#).unwrap();
        assert_eq!(run(), Some(Verdict::Defer), "skip.json");
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent file is the goal state
    }

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
