#!/usr/bin/env node
// anti-hall :: devswarm-child-role (SessionStart)
//
// v0.58 "mesh-only messaging": injects the FULL DEVSWARM COMMUNICATION OVERRIDE
// directive for BOTH DevSwarm roles (Primary AND child workspace sub-
// orchestrator) at SessionStart — the primacy slot, and the only lever against
// DevSwarm's own `--system-prompt-file` REPLACE at spawn (PLAN.md "Locked
// design"). It tells the session anti-hall's shared mesh store is the ONLY
// messaging channel for DevSwarm coordination (native hivecontrol SEND commands
// — `workspace message-child`/`message-parent` — are now guard-blocked,
// command-guard.js), gives the mesh CLI verbs to report/direct-message/check in,
// and states the Tier-0 RESTING-state posture (keep polling the mesh instead of
// idling silently). A CHILD additionally gets a short idle-self-report nudge.
// Scope = COMMUNICATION ONLY — this never touches or replaces DevSwarm's own
// task-brief system prompt.
//
// v0.59 "self-wake": both roles additionally get the MAILBOX WAKE directive —
// create a CronCreate job (the only primitive that fires while the REPL is IDLE)
// that drains this workspace's mailbox. See lib/devswarm-wake.js for the full
// rationale, the agent-correctness rule, and the interval knob.
//
// Safe no-op for non-DevSwarm sessions: no output, exit 0. Pure Node built-ins.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const path = require('path');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');

// RAW_CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper, resolved
// ONCE from this hook's own on-disk location (never a relative
// "scripts/devswarm.js" string — see P1 fix below: a DevSwarm child's cwd is
// its PROJECT WORKTREE, not the plugin root, so a relative path in emitted
// text is unrunnable there). This is the version-pinned plugin-cache path —
// correct right now, but stale-across-updates once baked into a cron/Monitor/
// handover (peer report, SkyCrew Primary, 2026-09-26); it is only the
// FALLBACK for the stable launcher below.
const RAW_CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// RAW_WATCHER — the ABSOLUTE path to the Monitor watch script (self-resolving:
// it takes no required args, deriving role/id from env + on-disk descriptors
// at run time). Same __dirname-based resolution rationale as RAW_CLI above —
// this hook's cwd is never the plugin root. Also only the FALLBACK for the
// stable launcher below.
const RAW_WATCHER = path.join(__dirname, '..', 'companion', 'lib', 'devswarm-wake-watch.js');

// CLI/WATCHER — the paths actually embedded in injected directive text.
// devswarm.stableLauncher (default on) installs/refreshes two tiny,
// version-independent launcher scripts under ~/.anti-hall/bin/ that resolve
// the CURRENTLY REGISTERED anti-hall install at RUN TIME (see
// lib/stable-launcher.js header) and point CLI/WATCHER at those instead of
// the version-pinned RAW_* paths — so a cron/Monitor/handover created today
// keeps working after the NEXT anti-hall update. Fail-open: any install
// failure, or the setting turned off, falls straight back to RAW_CLI/
// RAW_WATCHER (byte-identical to pre-fix behavior).
let CLI = RAW_CLI;
let WATCHER = RAW_WATCHER;
try {
  if (require('./lib/settings.js').enabled('devswarm', 'stableLauncher') !== false) {
    const stable = require('./lib/stable-launcher.js').installLaunchers({
      cliFallback: RAW_CLI,
      watcherFallback: RAW_WATCHER,
    });
    CLI = stable.cli;
    WATCHER = stable.watcher;
  }
} catch (_) {
  // fail-open: keep RAW_CLI/RAW_WATCHER
}

// OVERRIDE_CORE — the full COMMUNICATION OVERRIDE directive (PLAN.md "OVERRIDE +
// WAKE-TIER0"), identical for both roles. Deliberately avoids the literal
// strings `message-child`/`message-parent` (uses the `message-*` wildcard form
// instead) so this text itself never re-introduces the blocked native verbs
// into emitted hook output (the hook-text-sweep acceptance criterion).
const OVERRIDE_CORE =
  'DEVSWARM COMMUNICATION OVERRIDE: anti-hall\'s shared mesh store is this workspace\'s ' +
  'ONLY messaging channel for DevSwarm coordination — native hivecontrol send commands ' +
  '(`workspace message-*`) are BLOCKED. Report status: `node ' + CLI + ' ' +
  'heartbeat <id> --summary "<text>"`. Direct-message: `node ' + CLI + ' send ' +
  '--to-primary --message-file <path>` (or `--to <meshId>`). Check in: `node ' + CLI + ' ' +
  'roster`, `mesh read`, `inbox read-primary <id>` (read-only — then run the `ackCommand` it returns). RESTING state = ' +
  'keep polling the mesh — do not idle silently. Scope: COMMUNICATION ONLY; this never ' +
  'changes your assigned task.';

// CHILD_IDLE_LINE — appended for a child only: the self-report nudge this hook
// carried pre-v0.58, now via the mesh `heartbeat --summary` verb instead of the
// blocked native `hivecontrol workspace message-parent`.
const CHILD_IDLE_LINE =
  ' If you have been idle with no active task for a while, proactively run `node ' +
  CLI + ' heartbeat <id> --summary "idle — reassign me a task or archive ' +
  'me"` so the parent orchestrator\'s task list stays honest instead of you sitting ' +
  'idle unnoticed.';

// CHILD_DONE_LINE (0.108.3) — appended for a child only: the structured
// done-report. `done` sets the `done` gate on the child's own id and sends ONE
// [[ANTIHALL_DONE]] message to the Primary; auto-archive then retires the
// workspace once the merge is proven and it is clean, read and idle — no user
// archive step.
const CHILD_DONE_LINE =
  ' WHEN MERGED run `node ' + CLI + ' done --summary "..."` once; auto-archived after.';

// CHILD_QUESTION_LINE / PARENT_QUESTION_LINE — the blocking-question escalation
// protocol, condensed from skills/devswarm/SKILL.md "Blocking questions — CHILD
// asks, PARENT answers (never child -> human)". That section is the canonical
// wording; this is a faithful TL;DR so it reaches every workspace at birth
// instead of living only in a skill a session may never read. Must never
// contradict the SKILL — if the two ever diverge, the SKILL wins and this must
// be re-condensed from it, not the other way round. Reuses the `send --to-primary`
// verb already given in OVERRIDE_CORE rather than repeating the CLI path, to stay
// tight against the ~10k hook-injection cap (Claude Code caps additionalContext
// per hook and spills overflow to a file — see verify-first-full.js header).
const CHILD_QUESTION_LINE =
  ' BLOCKED ON A DECISION? Never ask the human directly, never halt all work — a ' +
  'question parks ONE sub-task, not the workspace. Send it to the parent with the ' +
  '`send --to-primary --question` command above, message = what\'s blocked / options / your ' +
  'recommendation / the DEFAULT you\'ll take / your deadline. Keep working every ' +
  'other unblocked item meanwhile. DEFAULT-AND-PROCEED: no reply by your deadline ' +
  '-> take that default, proceed, and flag it LOUDLY as an explicit assumption in ' +
  'your report — never silently. Hard-stop ONLY for a destructive/irreversible ' +
  'action you\'re not authorized to take: park + report, do not guess a default. ' +
  'Ladder: child -> parent -> human, never child -> human.';

const PARENT_QUESTION_LINE =
  ' BLOCKED-QUESTION REPLIES: a child\'s question means YOU decide from the plan ' +
  'context, replying via `send --to <meshId>`; escalate to the human only for a ' +
  'genuine human call (destructive/irreversible, scope-changing, unsafe to assume). ' +
  'Ladder: child -> parent -> human, never child -> human.';

// PARENT_VERB_LIST_LINE (peer request, 2026-09-26): a Primary spent a day
// driving raw hivecontrol because it never discovered `devswarm.js archive`
// existed — this file only ever names the handful of verbs OVERRIDE_CORE/
// PARENT_QUESTION_LINE use, never the full set. One line, Primary only, kept
// tight against the hook-injection budget: points at `help --short` (the
// one-line-per-verb index, generated from the same source of truth as the
// dispatcher itself — see buildShortHelpText() in scripts/devswarm.js).
const PARENT_VERB_LIST_LINE =
  ' Full verb list: `node ' + CLI + ' help --short`.';

// MAILBOX WAKE (v0.59): appended for BOTH roles (both have mailboxes). A workspace
// that finishes its turn goes IDLE and nothing wakes it, so a message landing after
// that point is never read. The fix is a directive — the agent itself CronList-checks
// and (re-)creates a Claude `CronCreate` job (the one primitive that fires while the
// REPL is idle; recurring tasks self-delete after 7 days, so the check is a RENEWAL,
// not a one-shot create); a hook cannot call a tool. Role-correct by construction:
// only an agent hivecontrol names as `claude` is told about CronCreate; Codex/other
// gets the honest "no idle-wake primitive here, drain every turn" line; an unknown
// agent gets nothing. Text + cron knob live in lib/devswarm-wake.js (shared with
// devswarm-child-gate.js's bounded Stop re-verify, so the two can never drift).
//
// LAZY + GUARDED require (the idiom edit-guard.js / devswarm-child-gate.js already
// use for their DevSwarm libs): a top-level require sits OUTSIDE main()'s try/catch,
// so a lib that is missing from a package or throws on load would CRASH this
// SessionStart hook instead of failing open. Degrade to the pre-wake output (the
// COMMUNICATION OVERRIDE, no wake directive) — never crash, never block.
// `explicitId` (MAILBOX WAKE fix, field evidence 2026-09-26): for a Primary,
// the caller resolves and passes the REGISTERED `primary-<hash>` id (the SAME
// id wake-watch and the store use — see primarySeatResult() below) so the
// emitted `inbox tick <id>` command is directly runnable instead of naming
// whatever raw env var (session id / DEVSWARM_BUILDER_ID) happened to be set.
// A child keeps its existing (registered) id unchanged — omit explicitId.
function wakeLine(env, isChild, explicitId) {
  try {
    return require('./lib/devswarm-wake.js').wakeDirective(env, isChild, CLI, WATCHER, explicitId);
  } catch (_) {
    return ''; // fail-open: pre-v0.59 behavior
  }
}

function buildAdditionalContext(isChild, env, explicitId) {
  return OVERRIDE_CORE +
    (isChild ? CHILD_QUESTION_LINE : PARENT_QUESTION_LINE) +
    (isChild ? CHILD_DONE_LINE : '') +
    (isChild ? CHILD_IDLE_LINE : '') +
    (isChild ? '' : PARENT_VERB_LIST_LINE) +
    wakeLine(env, isChild, explicitId);
}

// seatMarkerPath(home, sid) — per-session "seat conflict shown" counter; the
// Primary's first UserPromptSubmit (devswarm-parent-inbox.js) repeats the
// conflict warning once while it persists.
function seatMarkerPath(home, sid) {
  return path.join(home, '.anti-hall', 'devswarm', 'primary-seat', String(sid).replace(/[^A-Za-z0-9_-]/g, '') + '.json');
}

// primarySeatResult(payload) -> { notices: string[], id: string|null }
// (v0.108.0 Primary seat; `id` added by the MAILBOX WAKE fix, field evidence
// 2026-09-26). In the Primary checkout: adopt the SAME Primary id when its
// recorded session is closed, REGISTER it for the first time when it has
// never been registered at all (adoptPrimarySeat's 'none' handling — see that
// function's header comment for the field symptom this closes: a never-
// registered seat left `inbox tick <resolved id>` permanently refusing with
// `unregistered-workspace`), warn (and let devswarm.js refuse send/ack/spawn)
// when another LIVE session holds it, warn without adopting when liveness is
// unknown, and flag a stale resume. `id` is the deterministic
// `primary-<hash>` seatVerdict() always resolves for a real Primary checkout
// (present even when adoption/registration did not happen, e.g. a live
// conflict) — the SAME id wake-watch and the store already key on. Fail-open:
// any error -> no notices, id null (caller falls back to the pre-fix
// placeholder text rather than naming a wrong id).
function primarySeatResult(payload) {
  try {
    const sid = payload && typeof payload.session_id === 'string' ? payload.session_id : '';
    const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    if (!sid) return { notices: [], id: null };
    const home = require('os').homedir();
    const env = Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: sid });
    // RAW_CLI, never CLI: this is an in-process `require()` of the real
    // devswarm.js MODULE (for its adoptPrimarySeat export) — the generated
    // stable launcher is a standalone SCRIPT, not a module, and requiring it
    // would execute its own main()/spawnSync immediately with this hook's
    // own (empty) argv. CLI is only ever a TEXT literal embedded in directive
    // strings; every actual require()/spawn of the CLI module stays on
    // RAW_CLI.
    const res = require(RAW_CLI).adoptPrimarySeat({ home, env, cwd });
    const v = res && res.verdict;
    if (!v || v.state === 'n/a') return { notices: [], id: null };
    if (v.state === 'conflict') {
      try {
        const p = seatMarkerPath(home, sid);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ holder: v.holder, id: v.id, shown: 1, at: Date.now() }));
      } catch (_) { /* marker is best-effort */ }
    }
    const notices = require('../companion/lib/primary-seat.js').seatNotices(v, { cli: CLI, adopted: !!res.adopted, currentSessionId: sid });
    return { notices, id: v.id || null };
  } catch (_) { return { notices: [], id: null }; }
}

function main() {
  // Settings switch devswarm.childRole (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('devswarm', 'childRole')) return; } catch (_) { /* run */ }
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }

  if (!isDevswarmActive(process.env)) return;

  const isChild = isChildWorkspace(process.env);
  let explicitId = null;
  let additionalContext;
  if (!isChild) {
    const seat = primarySeatResult(payload);
    explicitId = seat.id;
    additionalContext = buildAdditionalContext(isChild, process.env, explicitId);
    if (seat.notices.length) additionalContext = seat.notices.join('\n\n') + '\n\n' + additionalContext;
  } else {
    additionalContext = buildAdditionalContext(isChild, process.env, null);
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  // Synchronous write to fd 1 (macOS node 18/20 flush-safety convention — see
  // verify-first-full.js for the full rationale).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
