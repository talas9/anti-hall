//! The LLM judge calls the engine makes itself: the local Claude CLI client and what the two Node judge paths build around
//! it.
//!
//! | File | Node source | What it does |
//! |---|---|---|
//! | `cli` | `judge-core.js` `cliArgs`, `runCliJudge`, `parseDecision` | runs `claude -p` isolated, under one timeout, and parses its answer |
//! | `evidence` | `inference-check.js` `collectEvidence`, `lastUserPrompt` | the tool evidence and the user request a reply is judged against |
//! | `host` | `hooks/speculation-judge.js` main | the one host function the speculation judge's plugin script calls: evidence, input, the CLI call, a telemetry row |
//! | `input` | `judge-core.js` `buildJudgeInput` | the speculation judge's user-turn text |
//! | `settings` | `settings.js` reads of `jev.judgeModel`, `jev.judgeBackend`, `credentials.js` `resolveKey('anthropic')` | model alias, backend, key presence |
//! | `telemetry` | (new) | one row per model call: integration, backend, model, latency, confidence, error |
//! | `triage` | `jev-triage-worker.js` | `ah-engine jev triage`: the worker's stdin/stdout contract, answered by the engine |
//!
//! What the engine does not do: call the Anthropic Messages API. A call that needs it (`jev.judgeBackend` `api`, or `auto`
//! with a key visible) is left to the Node hook or worker, so a key never travels through a new code path.
//!
//! A CLI judge call takes seconds (5 to 25 s for the speculation judge). The resident daemon must answer a hook within the
//! client's exchange deadline and trips its watchdog on a worker busy longer than `daemon.stuck_ms`, so a check never makes
//! the call there: its script defers, and the dispatcher process (a one-shot process under the hook's own timeout, which
//! calls [`allow_blocking_calls`] before it runs a check listed in `judge.dispatch_blocking_checks`) runs the check again and
//! makes the call itself, so the Node hook runs only if the check still defers. A one-shot command (`ah-engine check`, `ah-engine
//! jev triage`) calls [`allow_blocking_calls`] first too.
pub mod cli;
pub mod evidence;
pub mod host;
pub mod input;
pub mod settings;
pub mod telemetry;
pub mod triage;

use std::sync::atomic::{AtomicBool, Ordering};

static BLOCKING_OK: AtomicBool = AtomicBool::new(false);

/// Mark this process as one that may wait seconds for a model call (a one-shot command, never the daemon).
pub fn allow_blocking_calls() {
    BLOCKING_OK.store(true, Ordering::Relaxed);
}

/// True when this process may make a model call that takes seconds.
pub fn blocking_calls_allowed() -> bool {
    BLOCKING_OK.load(Ordering::Relaxed)
}
