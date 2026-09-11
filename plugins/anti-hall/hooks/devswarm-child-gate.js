#!/usr/bin/env node
// anti-hall :: devswarm-child-gate (Stop hook, child workspace only)
//
// The Stop-side complement to devswarm-child-role.js (SessionStart). When a
// DevSwarm CHILD workspace sub-orchestrator is about to stop, force it — a CAPPED
// number of times — to emit a heartbeat / self-report to its parent BEFORE going
// idle, so a child that finishes a turn pings the parent instead of silently
// dropping off the parent's radar and later reading as stale/neglected.
//
// This satisfies the heartbeat-authorship rule (PLAN.md Phase 2 correction):
// heartbeats are emitted by the working session's OWN turn (this hook fires on
// the child's Stop), NEVER by a background daemon on the child's behalf. The
// forced-ack is the mechanism — it blocks the Stop with a reason telling the
// child to run `hivecontrol workspace message-parent`.
//
// SOUND FORCED-ACK (v0.54.1 correction — reverts the v0.54.0 "fresh heartbeat
// satisfies the Stop gate" logic, which FALSE-SILENCED a child that worked <5min
// then stopped WITHOUT message-parent): the turn-START heartbeat written by
// devswarm-child-turn is NOT a valid "I reported my stop-state" signal — it says
// only that a turn began, not that the child pinged its parent before going idle.
// Treating it as satisfaction let an unreported child drop off the parent's radar.
// So this gate ALWAYS demands at least one real report per unchanged blocking
// state (never false-silence), bounded ONLY by the capped forced-ack below.
//
// v0.58 "mesh-only messaging" BUILDS the v0.54.2 improvement noted above: a
// proper "satisfied-by-actual-report" marker now exists — alreadyReportedThisEpisode()
// below reads the shared store's summaries/<repoKey>.json projection for a
// `recent[]` row this child itself SENT (a real `heartbeat --summary`/`send
// --broadcast` mesh call, never the turn-start heartbeat FILE) since the last
// forced-ack. When found (and no KNOWN durable unread backlog is still pending —
// the INBOUND half of this gate, #29, is a SEPARATE concern this satisfaction
// path does not silence), the block is skipped entirely for this Stop.
//
// INBOUND GATE (#29): alongside the outbound message-parent forcing above, this
// hook also checks whether the child has unpulled/unread PARENT messages waiting.
// When it does, the SAME forced-ack reason (still gated by the SAME MAX_BLOCKS
// cap / state file below — this is not a second, independent budget) is extended
// to tell the child to `inbox pull` / read / ack the backlog before it stops, so a
// child cannot go idle sitting on an unread parent message. The check is layered:
//   1. Durable (pure fs, non-destructive): readUnread() on the child's own
//      descriptor inbox (workspaces/<id>.json -> inboxPath/cursorPath) — the same
//      primitive devswarm-child-turn.js already uses.
//   2. STRICT (default ON; ANTIHALL_DEVSWARM_CHILD_GATE_STRICT=0 disables): when
//      the durable check finds nothing, ONE bounded, NON-DESTRUCTIVE `hivecontrol
//      workspace message-count` spawn (finite timeout, NEVER read-messages /
//      monitor) catches a native backlog the child has never `inbox pull`ed. Only
//      probed when we are about to block anyway (never on the cap-exhausted
//      yield path), so a healthy child pays zero extra spawn cost.
// Fail-open throughout: any probe error/timeout/missing binary -> treated as "no
// unread" (never blocks on an unknown state).
//
// WAKE RE-VERIFY (v0.59 "self-wake"): whenever this gate ALREADY forces a heartbeat
// block below, the reason text also re-asserts the MAILBOX WAKE directive
// (devswarm-child-role.js: CronList-check, then CronCreate the job that is the only
// primitive firing while the REPL is IDLE). No new state, no new cap — it rides
// the SAME MAX_BLOCKS-bounded forced-ack this file already has. Claude-only (a
// Codex workspace has no CronCreate tool, so it never gets the line).
//
// CAPPED + SELF-RESETTING (loop-safe): we block at most MAX_BLOCKS times inside a
// single stop episode, then yield (allow the stop) so we can NEVER hard-loop the
// child. The cap is tracked in this hook's OWN DISTINCT state file (separate from
// task-guard's last-stop-taskset-* and from the liveness verdict). It resets after
// RESET_MS of no forced block — i.e. once the child has done real work and reaches
// a genuinely new stop episode, the heartbeat forcing re-arms.
//
// Gates (identical role detection to devswarm-child-role.js):
//   - liveness supervisor ACTIVE (devswarm-detect: DEVSWARM_REPO_ID / mode), AND
//   - this session is a CHILD workspace (devswarm-role: DEVSWARM_SOURCE_BRANCH
//     non-empty).
// Primary sessions, non-DevSwarm sessions, and any error -> silent no-op, exit 0
// (byte-identical to today). Honors the user's explicit skip marker.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { hook_event_name, session_id, stop_hook_active, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to force the heartbeat, or
//            nothing (allow the stop).
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace, isChildWorkspaceCorroborated } = require('./lib/devswarm-role.js');
const { isSkipped } = require('./skip-guard.js');
const { devswarmRoot, isSafeId } = require('../companion/lib/liveness.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
const devswarmUnread = require('../companion/lib/devswarm-unread.js');

// CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper, resolved ONCE
// from this hook's own on-disk location (never a relative "scripts/devswarm.js"
// string — a DevSwarm child's cwd is its PROJECT WORKTREE, not the plugin
// root, so a relative path in the emitted Stop-block reason is unrunnable
// there; P1 fix).
const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// WATCHER — the ABSOLUTE path to the Monitor watch script (self-resolving: no
// required args). Same __dirname-based resolution rationale as CLI above.
// Passed to wakeReassert() below so the Claude branch can arm `Monitor` IN
// ADDITION to CronCreate (never instead — see lib/devswarm-wake.js's
// NON-NEGOTIABLE header comment).
const WATCHER = path.join(__dirname, '..', 'companion', 'lib', 'devswarm-wake-watch.js');

// wakeReassertLine(env, isChild) -> the Stop-gate wake re-verify text, or '' when
// the agent is not Claude (no CronCreate tool) OR the wake lib cannot be loaded.
// LAZY + GUARDED require (the same idiom as the repokey load below / edit-guard.js):
// a top-level require sits OUTSIDE main()'s try/catch, so a lib missing from a
// package or throwing on load would CRASH this Stop hook instead of failing open.
// Degrade to the pre-wake reason text — never crash, never wedge the stop.
function wakeReassertLine(env, isChild) {
  try {
    const wake = require('./lib/devswarm-wake.js');
    return wake.isClaudeAgent(env) ? wake.wakeReassert(env, CLI, isChild, WATCHER) : '';
  } catch (_) {
    return ''; // fail-open: pre-v0.59 behavior
  }
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry — mirrors devswarm-child-turn.js's/devswarm-parent-
// inbox.js's own copy byte-for-byte (kept local rather than shared so this Stop
// hook's dependency surface stays exactly what it already was).
// resolvedIdSafe(env) -> the real DEVSWARM_BUILDER_ID (hooks/lib/devswarm-wake.js's
// resolvedId — validated against ID_FIELD there) when set/safe, else the literal
// placeholder `<DEVSWARM_BUILDER_ID>`. Same lazy+guarded require idiom as
// wakeReassertLine above — a missing/throwing lib degrades to the placeholder,
// never crashes this Stop hook.
function resolvedIdSafe(env) {
  try {
    const wake = require('./lib/devswarm-wake.js');
    if (wake && typeof wake.resolvedId === 'function') return wake.resolvedId(env);
  } catch (_) { /* fail-open below */ }
  return '<DEVSWARM_BUILDER_ID>';
}

function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

// alreadyReportedThisEpisode(env, home, cwd, episodeSince) -> bool. PROJECTION-
// ONLY "already-reported" satisfaction (v0.58 mesh-only messaging): reads the
// SAME shared summaries/<repoKey>.json projection the Primary/child-turn hooks
// already read (no store DB open — devswarm-store.js layering) and looks for an
// OUTBOUND row THIS CHILD ITSELF sent — a `recent[]` entry (the only place the
// projection carries a `sender`/`from`) with `from === DEVSWARM_BUILDER_ID` and
// `ts >= episodeSince`. `recent[]` is populated by a REAL `devswarm.js heartbeat
// --summary` / `send --broadcast` call (never the mechanical devswarm-child-
// turn.js turn-start heartbeat FILE, which the v0.54.1 correction above already
// ruled out as a false-silence signal — that heartbeat never touches the store).
// Fail-open: ANY error (unresolvable repoKey, missing/corrupt summary, lazy-
// require failure, unsafe id) -> false — never silently skip a required report.
function alreadyReportedThisEpisode(env, home, cwd, episodeSince) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return false;
    let repokeyMod = null;
    try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
    if (!repokeyMod) return false;
    const worktree = findGitToplevel(cwd);
    if (!worktree) return false;
    let repoKey = null;
    try { repoKey = repokeyMod.repoKeyForWorktree(worktree); } catch (_) { repoKey = null; }
    if (!repoKey) return false;
    const p = path.join(devswarmRoot(home), 'summaries', repoKey + '.json');
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    if (!raw) return false;
    const summary = JSON.parse(raw);
    const recent = summary && Array.isArray(summary.recent) ? summary.recent : [];
    return recent.some((r) => r && r.from === id && Number.isFinite(r.ts) && r.ts >= episodeSince);
  } catch (_) {
    return false;
  }
}

// findRecentDropAttempt(env, home, cwd, episodeSince) -> {ts, reason} | null.
//
// defect a55d6b71a76f fix (root cause A): alreadyReportedThisEpisode() above
// ONLY sees a real mesh broadcast (recent[]). When `heartbeat --summary` is
// refused for a BENIGN reason (unresolvable-caller-identity,
// caller-not-registered, ownership-mismatch — devswarm.js's
// BENIGN_MESH_BROADCAST_REASONS), the summary is DROPPED before it ever
// reaches recent[], so this gate could never see that the child DID attempt
// to report — it re-prescribed the SAME failing heartbeat command forever.
// devswarm.js's cmdHeartbeat now writes a local, bounded attempt record
// (devswarmRoot/summary-attempts/<repoKey>.ndjson) on every such drop; this
// reads it back the same way alreadyReportedThisEpisode reads summaries/.
// Fail-open: any error/missing file -> null (never silently skip a required
// report because of an attempt-record read failure).
//
// P0-1 FORGERY FIX (gate-fix Wave 2 round-1 review): the record is keyed by
// the TARGET id + a PROJECT-WIDE repoKey, with no writer authentication —
// any sibling workspace sharing this worktree could satisfy ANOTHER child's
// Stop gate by simply running `heartbeat <victim-id> --summary ...` itself
// (the refusal is intentionally BENIGN/ok:true, so a forger pays no cost).
// A matching `row.id` alone is therefore not proof — bind acceptance to the
// WRITING PROCESS: `row.instanceNonce` must equal THIS gate's own
// deriveInstanceNonce() (same per-ancestor-session derivation devswarm.js's
// real broadcast path already stamps outbound rows with — the hook process
// and the CLI process the agent's heartbeat command spawns share the same
// top-level session ancestor, so a genuine self-write always nonce-matches;
// a sibling's own process never does). Identity-family exception (Auditor
// P1): a child legitimately registered under two id forms (slug + UUID
// builder-id) can heartbeat under the "other" form of its OWN identity —
// accept that case too when `row.sessionId` is non-null and equals a
// session id belonging to THIS workspace's own identity family.
//
// TWIN-CASE FIX (Wave 3 P1, defect a55d6b71a76f follow-up): the match used
// to require `row.id === id` (env.DEVSWARM_BUILDER_ID) BEFORE even trying
// nonce/session authentication — so a child that heartbeats under its
// meshId (row.id = meshId) while the gate's own env id is a UUID never
// matched, even though the write was genuinely its own. Authentication IS
// the nonce (or the session), not the id: a row is now accepted when
// `row.instanceNonce === ownNonce` REGARDLESS of `row.id` (the nonce alone
// already proves same-process authorship), or when `row.sessionId` is a
// member of `ownSessionIds` (below) REGARDLESS of `row.id`. `row.ts` is
// still required to be within the episode window. If the nonce cannot be
// derived at all (home/cwd unresolvable) -> do NOT accept the record
// (fail CLOSED on authentication, never fail-open into forgeability); the
// pre-existing fail-open posture is preserved only for read/parse errors on
// the attempt file itself (missing/corrupt -> null, same as before).
//
// `diag` (optional, Wave 3 P2): when provided, set `diag.nonceFailClosed =
// true` on the fail-CLOSED nonce-derivation path so the caller can log a
// ONE-per-session diagnostic (this function itself stays silent/pure — it has
// no session id and no state file to dedup against).
//
// Wave 3 addendum item 6: `diag.mismatch = {rowNoncePrefix, ownNoncePrefix}`
// is set when a row FOR THIS EXACT id (`row.id === id`) exists within the
// episode window but authenticates against NEITHER the nonce nor the session
// (a genuine attempt record that this process just cannot recognize as its
// own — e.g. `deriveInstanceNonce`'s documented `self:<ppid>:0` fallback
// changes on every process restart, so a record written by a PRIOR OS
// process for this SAME workspace id legitimately nonce-mismatches after a
// restart; this is deliberately scoped to `row.id === id` ONLY — a
// same-repoKey sibling's own, unrelated, non-matching rows for a DIFFERENT
// id are the expected common case and must not spam this diagnostic).
// Only the freshest such row (by `row.ts`) is recorded, and only when no row
// ultimately authenticated (`latest` stays null) — a caller that logs this
// is explaining exactly the null this function is about to return.
function findRecentDropAttempt(env, home, cwd, episodeSince, diag) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return null;
    let repokeyMod = null;
    try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
    if (!repokeyMod) return null;
    const worktree = findGitToplevel(cwd);
    if (!worktree) return null;
    let repoKey = null;
    try { repoKey = repokeyMod.repoKeyForWorktree(worktree); } catch (_) { repoKey = null; }
    if (!repoKey) return null;

    // cliMod is used for both deriveInstanceNonce (below) and canonicalMeshId
    // (identity-family fallback below) — required once, reused by both.
    let cliMod = null;
    try { cliMod = require('../scripts/devswarm.js'); } catch (_) { cliMod = null; }

    // Own nonce (the gate's own process/ancestor identity) — required for
    // authentication below. Fail CLOSED (return null) if it cannot be
    // derived at all; never treat "can't verify" as "verified".
    let ownNonce = null;
    try {
      if (cliMod && typeof cliMod.deriveInstanceNonce === 'function') {
        ownNonce = cliMod.deriveInstanceNonce({ home, cwd });
      }
    } catch (_) { ownNonce = null; }
    if (typeof ownNonce !== 'string' || !ownNonce) {
      if (diag && typeof diag === 'object') diag.nonceFailClosed = true;
      return null;
    }

    // Own session id(s) (identity-family match set) — every sessionId that
    // provably belongs to THIS workspace's own registered identity, so a row
    // written under a DIFFERENT id form (e.g. this workspace's meshId, when
    // env.DEVSWARM_BUILDER_ID is a UUID that was never separately registered)
    // can still be recognized as self-authored.
    //   1. This workspace's OWN descriptor (workspaces/<id>.json, `id` =
    //      env.DEVSWARM_BUILDER_ID) — the common case.
    //   2. Only when that descriptor is absent/unreadable: scan every
    //      registered descriptor for one that is PROVABLY the same identity —
    //      either its `id` is a uuid-prefix re-registration of `id`
    //      (devswarm-child-turn.js's TRUNCATED_UUID_RE recovery:
    //      `desc.sessionId` there begins with `id`, i.e. `did.indexOf(id) ===
    //      0` here checks the SAME relationship from the descriptor's own id
    //      field), or its worktree resolves to the SAME canonical meshId as
    //      this gate's own worktree (`canonicalMeshId` — scripts/devswarm.js;
    //      a Primary-spawned meshId row for the same physical worktree).
    // Fail-open throughout: any lookup error simply yields fewer candidate
    // session ids, never a crash — sessionMatch below just has less to match.
    const ownSessionIds = new Set();
    try {
      const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
      const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
      if (desc && typeof desc === 'object' && desc.sessionId != null && String(desc.sessionId) !== '') {
        ownSessionIds.add(String(desc.sessionId));
      }
    } catch (_) { /* own descriptor absent/unreadable — try the family fallback below */ }

    if (ownSessionIds.size === 0) {
      try {
        let ownMeshId = null;
        try {
          if (cliMod && typeof cliMod.canonicalMeshId === 'function') ownMeshId = cliMod.canonicalMeshId(worktree);
        } catch (_) { ownMeshId = null; }
        let auditMod = null;
        try { auditMod = require('../companion/lib/devswarm-store-audit.js'); } catch (_) { auditMod = null; }
        const descriptors = auditMod && typeof auditMod.readDescriptors === 'function'
          ? (auditMod.readDescriptors(home).list || [])
          : [];
        for (const d of descriptors) {
          if (!d || typeof d !== 'object' || d.sessionId == null || String(d.sessionId) === '') continue;
          const did = d.id != null ? String(d.id) : '';
          const idPrefixMatch = did !== '' && did.indexOf(id) === 0;
          let meshMatch = false;
          if (!idPrefixMatch && ownMeshId && d.worktreePath) {
            try { meshMatch = cliMod.canonicalMeshId(d.worktreePath) === ownMeshId; } catch (_) { meshMatch = false; }
          }
          if (idPrefixMatch || meshMatch) ownSessionIds.add(String(d.sessionId));
        }
      } catch (_) { /* fail-open: no family fallback available */ }
    }

    // Wave 3 addendum item 7: the writer (cmdHeartbeat, scripts/devswarm.js)
    // now writes PER-ID files under `summary-attempts/<repoKey>/<writerId>.ndjson`
    // (never a single shared per-repoKey file — that was a read-modify-write-
    // rename race between concurrent sibling writers). The reader here must
    // still scan EVERY id's file in this repoKey's attempt directory, not just
    // the one named `id` — the twin-case match above is deliberately
    // id-independent (a row written under a DIFFERENT writerId, e.g. this
    // workspace's meshId, can still be THIS process's own nonce/session), so
    // narrowing the read to `<id>.ndjson` alone would silently un-fix that.
    // Bounded by the number of distinct writer ids that have ever dropped a
    // summary for this project — small in practice, and fail-open throughout
    // (an unreadable directory/file just yields fewer candidate rows, never a
    // crash or a false accept).
    const attemptDir = path.join(devswarmRoot(home), 'summary-attempts', repoKey);
    let attemptFiles = [];
    try { attemptFiles = fs.readdirSync(attemptDir).filter((f) => f.endsWith('.ndjson')); } catch (_) { attemptFiles = []; }
    // Persisted-shape carry-over: the writer (cmdHeartbeat) used to write a
    // SINGLE flat file at summary-attempts/<repoKey>.ndjson (pre-Wave-3-
    // addendum-7, before the per-writer-id directory split above). A row
    // written by a process still on that older code path — or simply never
    // migrated — must still be read back; additive-only, no delete, no
    // migration required. Collected as {dir, name} pairs alongside the
    // directory-scan files so both shapes feed the same read loop below.
    const attemptSources = attemptFiles.map((fname) => ({ dir: attemptDir, name: fname }));
    const legacyAttemptFile = path.join(devswarmRoot(home), 'summary-attempts', repoKey + '.ndjson');
    try {
      if (fs.statSync(legacyAttemptFile).isFile()) {
        attemptSources.push({ dir: path.join(devswarmRoot(home), 'summary-attempts'), name: repoKey + '.ndjson' });
      }
    } catch (_) { /* legacy flat file absent — nothing to add */ }
    let latest = null;
    let mismatchRow = null; // freshest row.id===id in-window that failed BOTH checks
    for (const { dir, name: fname } of attemptSources) {
      let raw;
      try { raw = fs.readFileSync(path.join(dir, fname), 'utf8'); } catch (_) { continue; }
      const lines = String(raw).split('\n').filter(Boolean);
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch (_) { continue; }
        if (!row || !Number.isFinite(row.ts) || row.ts < episodeSince) continue;
        const nonceMatch = typeof row.instanceNonce === 'string' && row.instanceNonce === ownNonce;
        const sessionMatch = typeof row.sessionId === 'string' && row.sessionId !== ''
          && ownSessionIds.has(row.sessionId);
        if (!nonceMatch && !sessionMatch) {
          if (row.id === id && (!mismatchRow || row.ts > mismatchRow.ts)) mismatchRow = row;
          continue;
        }
        if (!latest || row.ts > latest.ts) latest = row;
      }
    }
    if (!latest && mismatchRow && diag && typeof diag === 'object') {
      diag.mismatch = {
        rowNoncePrefix: typeof mismatchRow.instanceNonce === 'string' ? mismatchRow.instanceNonce.slice(0, 12) : null,
        ownNoncePrefix: ownNonce.slice(0, 12),
      };
    }
    return latest;
  } catch (_) {
    return null;
  }
}

// DROP_REMEDY — per-reason remedy text for findRecentDropAttempt()'s result,
// so the forced-block reason (when a block still fires despite an attempted
// report — e.g. an independent unread-inbox backlog) tells the child what to
// actually DO differently, instead of re-prescribing the exact heartbeat
// command that just failed for this same reason.
// P2 fix: 'no-project' was a DEAD entry — that cause is set in cmdHeartbeat's
// OUTER branch (repoKey unresolvable), which is exactly the branch that never
// reaches the attempt-record write below it (the write requires a resolved
// repoKey to name the ndjson file). A drop attempt with reason 'no-project'
// can therefore never be read back here; removed rather than left unreachable.
const DROP_REMEDY = {
  'unresolvable-caller-identity': 'run `inbox pull <DEVSWARM_BUILDER_ID>` to establish your identity with the parent, then re-run the heartbeat',
  'caller-not-registered': 'run `inbox pull <DEVSWARM_BUILDER_ID>` to register with the parent, then re-run the heartbeat',
  'ownership-mismatch': 'run the heartbeat from the workspace root (cwd was not recognized as this workspace)',
};

// P0-2 INJECTION FIX (gate-fix Wave 2 round-1 review): dropAttempt.reason
// (and .summary) are attacker-influenceable — either a hand-crafted
// summary-attempts ndjson row, or (pre-nonce-fix) a forged one from a
// sibling — and the Stop-block text below is fed straight back into the
// agent's own context. Never interpolate the raw field. Render ONLY a fixed,
// whitelisted label for a KNOWN reason key (one that also has a DROP_REMEDY
// entry); an unrecognized reason renders a generic message that carries no
// attacker-controlled bytes at all.
const DROP_REASON_LABEL = {
  'unresolvable-caller-identity': 'your caller identity could not be resolved',
  'caller-not-registered': 'your workspace is not yet registered with the parent',
  'ownership-mismatch': 'the heartbeat was not recognized as coming from this workspace',
};
function describeDropAttempt(dropAttempt, env) {
  const reason = dropAttempt && typeof dropAttempt.reason === 'string' ? dropAttempt.reason : null;
  const label = reason && Object.prototype.hasOwnProperty.call(DROP_REASON_LABEL, reason)
    ? DROP_REASON_LABEL[reason]
    : null;
  let remedy = reason && Object.prototype.hasOwnProperty.call(DROP_REMEDY, reason)
    ? DROP_REMEDY[reason]
    : null;
  // Substitute the real id (when set/safe) for the literal placeholder in the
  // whitelisted remedy text — same resolvedId(env) substitution wakeReassertLine
  // already applies, so the Stop text names the real id the child can run with
  // instead of a placeholder it has nothing to fill in.
  if (remedy) remedy = remedy.split('<DEVSWARM_BUILDER_ID>').join(resolvedIdSafe(env));
  if (label && remedy) return 'your last heartbeat summary was DROPPED — ' + label + '. ' + remedy;
  return 'your last heartbeat summary was dropped (reason not recognized)';
}

// How many times a single stop episode may be forced to heartbeat before we
// yield. One forced-ack is usually enough; a small budget lets a child that
// didn't actually report on the first bounce get one more chance, and the cap
// then guarantees the child is never hard-looped.
const MAX_BLOCKS = 2;

// After this long with no forced block, the cap re-arms: a genuinely new stop
// episode (the child worked for a while, then stopped again) gets a fresh
// heartbeat forcing. Within a tight bounce-loop this window has NOT elapsed, so
// the cap holds and the loop terminates.
const RESET_MS = 5 * 60 * 1000;

// defect a55d6b71a76f fix (root cause B): the per-window cap above resets
// unconditionally once RESET_MS elapses, so MAX_BLOCKS re-arms every window
// forever — a child stuck in the SAME failing state (e.g. its heartbeat keeps
// getting benignly dropped, see root cause A) gets blocked without limit over
// a long session, never just capped-then-yielded. This SEPARATE, NEVER-RESET
// lifetime bound stops that: once a session's forced-acks (state.totalBlocks,
// tracked across every window) reach this count, the gate stops blocking for
// the REST of the session, even after RESET_MS re-arms the per-window cap.
const MAX_BLOCKS_PER_SESSION = 6;

// D13 (v0.97.0): a fresh, zero-unread mailbox-wake TICK marker (written by
// `devswarm.js inbox tick <id>` — the cron prompt's own drain step, see
// devswarm-wake.js's drainCmd useTick branch) is itself a liveness+no-op proof
// — the cron fired, ran `inbox count` (and `inbox pull` first, for a child),
// found nothing, and already bumped heartbeats/<id>.json's ts. Forcing a
// SEPARATE heartbeat report on top of that is redundant overhead — exactly
// what the D13 field measurement (1,225 polling lines / 2.29 MB, ~half a
// session's real content, almost entirely "mailbox empty" no-ops) was about.
// 120s window: generous enough to cover the tick's own subprocess latency,
// tight enough that a marker from a PRIOR tick (this cron now fires every 30
// min) can never be mistaken for "just happened" satisfaction of THIS Stop.
const TICK_MARKER_FRESH_MS = 120 * 1000;

function stateFileFor(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  // Own DISTINCT state file, namespaced under devswarm/ so it never collides with
  // task-guard's ~/.anti-hall/last-stop-taskset-* or the liveness verdict files.
  return path.join(os.homedir(), '.anti-hall', 'devswarm', 'child-gate', safe + '.json');
}

function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        blocks: Number.isFinite(parsed.blocks) ? parsed.blocks : 0,
        lastBlockAt: Number.isFinite(parsed.lastBlockAt) ? parsed.lastBlockAt : 0,
        // defect a55d6b71a76f fix (root cause B): lifetime counter, NEVER
        // reset by the RESET_MS window logic below (unlike `blocks`).
        totalBlocks: Number.isFinite(parsed.totalBlocks) ? parsed.totalBlocks : 0,
        lifetimeCapLogged: parsed.lifetimeCapLogged === true,
        // Wave 3 P2: dedup flag for the "instance nonce could not be derived"
        // stderr diagnostic below — same one-line-per-session convention as
        // lifetimeCapLogged, so a session stuck unable to derive its own
        // nonce (e.g. an unresolvable home/cwd) does not spam stderr once per
        // Stop.
        nonceFailClosedLogged: parsed.nonceFailClosedLogged === true,
        // Wave 3 addendum item 6: dedup flag for the "attempt record exists
        // but did not authenticate" stderr diagnostic — same convention.
        mismatchLogged: parsed.mismatchLogged === true,
      };
    }
  } catch (_) { /* first time / unreadable -> fresh state */ }
  return {
    blocks: 0, lastBlockAt: 0, totalBlocks: 0,
    lifetimeCapLogged: false, nonceFailClosedLogged: false, mismatchLogged: false,
  };
}

function writeState(stateFile, state) {
  // Atomic tmp + rename so a crash mid-write can never leave a torn state file.
  // Returns true iff the cap state was persisted; false lets the caller FAIL OPEN
  // (a guard that cannot track its own cap must never block — see main()).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch (_) {
    return false; // could not persist the cap -> caller fails open (never blocks)
  }
}

// emitBlock(reason) — the ONE place this hook writes its Stop verdict.
// fs.writeSync(1): a synchronous write to fd 1 — process.stdout.write races the
// async pipe flush with process.exit() on macOS node 18/20 (project convention).
function emitBlock(reason) {
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

// ONE bounded, NON-DESTRUCTIVE probe timeout — must never wedge a Stop.
const MESSAGE_COUNT_TIMEOUT_MS = 5000;

// strictEnabled(env) -> bool. ANTIHALL_DEVSWARM_CHILD_GATE_STRICT default ON;
// '0' disables the native fallback probe (pure-fs durable-unread check only).
function strictEnabled(env) {
  const e = env || {};
  const raw = e.ANTIHALL_DEVSWARM_CHILD_GATE_STRICT;
  return String(raw === undefined ? '1' : raw).trim() !== '0';
}

// readDurableUnread(env, home) -> { known, count }. NON-DESTRUCTIVE unread check
// on the child's OWN durable descriptor inbox (workspaces/<DEVSWARM_BUILDER_ID>
// .json -> inboxPath/cursorPath), via the same inbox-cursor primitive devswarm-
// child-turn.js uses. Pure fs — never drains the native queue, never spawns
// hivecontrol. Fail-safe: ANY error -> { known: false, count: 0 }.
//
// UNION-AWARE (root cause b fix): a mesh-direct `send --to` is STORE-ONLY (see
// companion/lib/devswarm-unread.js's header) — the NDJSON-only readUnread()
// above is blind to it. When the descriptor carries a worktreePath, ALSO
// consult the union (NDJSON ∪ store-only) count via the shared lib, LAZY +
// GUARDED (same D27 idiom as devswarm-child-turn.js's registerStoreDescriptor)
// so a missing/corrupt module or a store-open failure degrades to the
// pre-fix NDJSON-only count — never throws, never regresses the known:false
// fail-open-to-blocking posture below.
function readDurableUnread(env, home) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return { known: false, count: 0 };
    const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
    let desc;
    try { desc = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch (_) { return { known: false, count: 0 }; }
    if (!desc || typeof desc !== 'object' || !desc.inboxPath) return { known: false, count: 0 };
    if (desc.worktreePath) {
      try {
        const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: desc.worktreePath, id, home, env });
        if (storeHandle) {
          try {
            // OWN-INSTANCE PROJECTION (defect f061789267c1 / a77b85571dfa, P0)
            // — same fix as devswarm-child-drain.js's identical pattern: this
            // is the child reading its OWN mailbox, so size the store side
            // from THIS instance's position (scripts/devswarm.js's
            // siblingBaseCursor), not the cross-instance min floor. Fail-open
            // to the pre-fix default on any resolution failure.
            let unionStoreBase;
            try {
              const devswarmCli = require('../scripts/devswarm.js'); // lazy: side-effect-free
              const nonce = devswarmCli.deriveInstanceNonce({ home, cwd: desc.worktreePath });
              const shortNonce = devswarmCli.shortInstanceNonce(nonce);
              unionStoreBase = shortNonce ? devswarmCli.siblingBaseCursor(storeHandle, home, id, shortNonce) : undefined;
            } catch (_) { unionStoreBase = undefined; }
            const union = devswarmUnread.unionUnread({ inboxPath: desc.inboxPath, cursorPath: desc.cursorPath, id, storeHandle, storeBaseCursor: unionStoreBase });
            return { known: !!union.known, count: union.known ? union.unread : 0 };
          } finally {
            try { storeHandle.close(); } catch (_) {}
          }
        }
      } catch (_) { /* fall through to NDJSON-only below */ }
    }
    const u = readUnread(desc.inboxPath, desc.cursorPath);
    return { known: !!u.known, count: u.known ? u.count : 0 };
  } catch (_) {
    return { known: false, count: 0 };
  }
}

// probeNativeMessageCount(env) -> int | null. ONE bounded, NON-DESTRUCTIVE
// `hivecontrol workspace message-count` spawn (finite timeout, NEVER read-messages
// or monitor). Returns null on any error/timeout/non-zero exit/unparseable output
// (unknown -> fail-open, never counted as unread).
//
// shell: win32-only. Node's spawnSync resolves a bare command name via Windows
// CreateProcess, which (unlike cmd.exe) does NOT consult PATHEXT — an npm-style
// `hivecontrol.cmd`/`.bat` shim (how JS-based global CLIs install on Windows)
// silently fails to spawn without a shell to do that resolution. args stay a
// fixed, hardcoded literal array (never user input), so shell:true here carries
// no injection risk. POSIX is unaffected (shell stays false; plain PATH search).
function probeNativeMessageCount(env) {
  try {
    const r = spawnSync('hivecontrol', ['workspace', 'message-count'], {
      encoding: 'utf8', timeout: MESSAGE_COUNT_TIMEOUT_MS, env,
      shell: process.platform === 'win32',
    });
    if (r.error || r.status !== 0 || r.signal) return null;
    const m = String(r.stdout || '').trim().match(/-?\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

// hasUnreadParentMessages(env, home) -> bool. Durable (pure-fs) check FIRST; when
// it shows nothing AND STRICT mode is enabled, a bounded native message-count
// probe catches a backlog the child has never `inbox pull`ed. Fail-open: any probe
// error -> false (never blocks on an unknown state).
function hasUnreadParentMessages(env, home) {
  const durable = readDurableUnread(env, home);
  if (durable.known && durable.count > 0) return true;
  if (!strictEnabled(env)) return false;
  const native = probeNativeMessageCount(env);
  return Number.isFinite(native) && native > 0;
}

// tickMarkerFreshZero(env, home, now) -> bool. D13: true iff `inbox tick`'s own
// marker (devswarmRoot(home)/wake-tick/<id>.json — written by devswarm.js's
// cmdInboxTick) is fresh (within TICK_MARKER_FRESH_MS) AND reported a genuine
// no-op (`unreadTotal === 0` AND `meshGapWithheld` falsy AND `known === true`
// — the SAME three-part stop condition drainCmd's own prose uses, matching
// G1's Fix Wave 3 fix so this can never treat a withheld-gap tick as
// satisfaction). Wave F1 (P0) added the `known` conjunct: a store-unavailable
// tick reports `known: false` alongside a numeric (often 0) `unreadTotal` —
// without this check that silently satisfied "fresh zero" and skipped the
// forced heartbeat on a session with mail the store just couldn't be read
// for. `known` MUST be strictly `true` (not merely truthy/absent) so a marker
// written by pre-Wave-F1 code (no `known` field at all, i.e. `undefined`) is
// treated as known-unknown -> NOT fresh-zero -> the heartbeat is still
// forced; this keeps the fail-open direction (never silently skip on an old
// marker shape) rather than fail-closed. Fail-open throughout: ANY error
// (missing/corrupt marker, unsafe id, unresolvable home) -> false — never
// silently skips a heartbeat this gate would otherwise force.
function tickMarkerFreshZero(env, home, now) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return false;
    const p = path.join(devswarmRoot(home), 'wake-tick', id + '.json');
    const raw = fs.readFileSync(p, 'utf8');
    const marker = JSON.parse(raw);
    if (!marker || typeof marker !== 'object') return false;
    if (!Number.isFinite(marker.ts)) return false;
    if ((now - marker.ts) > TICK_MARKER_FRESH_MS) return false;
    if (marker.unreadTotal !== 0) return false;
    if (marker.meshGapWithheld) return false;
    if (marker.known !== true) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  // Read stdin (fd 0 — cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return; // no stdin -> fail-open
  }

  // Escape hatch: honor an explicit, user-consented skip.
  if (isSkipped('devswarm-child-gate')) return;

  // ROLE GATE: only a DevSwarm child workspace with the supervisor active. A
  // Primary / non-DevSwarm session is a byte-identical no-op (matches
  // devswarm-child-role.js). Env-based, so it works even before stdin is parsed.
  if (!isDevswarmActive(process.env)) return;
  if (!isChildWorkspace(process.env)) return;
  // defect a55d6b71a76f fix (root cause C): DEVSWARM_SOURCE_BRANCH alone can
  // leak into a Primary's env with no corroborating on-disk evidence, which
  // would gate the Primary as a child and force it into the child-only
  // heartbeat loop below. Require on-disk corroboration (registered
  // descriptor OR cwd under the real DevSwarm worktree layout) before
  // treating this session as gate-eligible. No corroboration -> silent
  // no-op (same as "not a child" — fail-open toward never blocking).
  if (!isChildWorkspaceCorroborated(process.env, os.homedir(), process.cwd())) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return; // malformed stdin -> fail-open (never block on a parse error)
  }

  const now = Date.now();

  // NO turn-start-heartbeat-satisfaction check (reverted — see header): the
  // child's turn-start heartbeat FILE is NOT proof it reported its stop-state.
  // What CAN satisfy the gate (v0.58) is a REAL mesh report — see
  // alreadyReportedThisEpisode below, evaluated AFTER the cap state is read
  // (it needs state.lastBlockAt to bound "this stop episode").

  // Session key: prefer session_id; fall back to a stable hash of the transcript
  // path so the per-session cap still works when session_id is absent.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    (payload && payload.transcript_path
      ? crypto.createHash('sha1').update(String(payload.transcript_path)).digest('hex').slice(0, 16)
      : 'unknown');

  const stateFile = stateFileFor(sessionId);
  const state = readState(stateFile);

  // Already-reported satisfaction (v0.58, projection-only): "this stop episode"
  // is bounded to the more recent of (a) the last time this gate actually forced
  // a block, or (b) RESET_MS ago — the same episode window the cap-reset logic
  // below already uses, so a stale lastBlockAt from long ago never makes an
  // ancient report count. If satisfied, skip the block UNLESS a KNOWN (durable,
  // pure-fs, cheap) unread backlog is still pending — the INBOUND half of this
  // gate (#29) stays intact; deliberately checks ONLY the cheap durable read
  // here (never the STRICT native probe) so a healthy/reported child never pays
  // the native spawn cost just to evaluate this satisfaction path.
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd : process.cwd();
  const episodeSince = Math.max(state.lastBlockAt, now - RESET_MS);
  const reported = alreadyReportedThisEpisode(process.env, os.homedir(), cwd, episodeSince);
  // defect a55d6b71a76f fix (root cause A): a benignly-dropped broadcast never
  // reaches recent[] (reported above stays false forever for it), so also
  // treat a fresh local drop-attempt record as satisfying this episode — the
  // child DID try; the drop was a security control doing its job, not a
  // missed report. Still deliberately checked BEFORE the durable-unread guard
  // below, same as `reported`, so a known pending inbox backlog still forces
  // a block (the INBOUND half of this gate is untouched by this change).
  const dropDiag = {};
  const dropAttempt = reported ? null : findRecentDropAttempt(process.env, os.homedir(), cwd, episodeSince, dropDiag);
  // Wave 3 P2: log ONCE per session (same dedup convention as
  // lifetimeCapLogged below) when findRecentDropAttempt fails CLOSED on nonce
  // derivation — this is a silent re-block otherwise (the child sees the SAME
  // forced-heartbeat text as "never attempted", indistinguishable from every
  // other null cause, with no diagnostic trail explaining why an attempt
  // record that may well exist was not accepted).
  if (dropDiag.nonceFailClosed && !state.nonceFailClosedLogged) {
    state.nonceFailClosedLogged = true;
    try {
      process.stderr.write('[anti-hall] devswarm-child-gate: instance nonce could not be derived for session '
        + JSON.stringify(sessionId) + ' — findRecentDropAttempt fails CLOSED (any existing drop-attempt '
        + 'record is not accepted as authenticated; this Stop re-blocks as if no attempt was made).\n');
    } catch (_) { /* best-effort diagnostic only */ }
    // Best-effort immediate persist so this logs at most once per session even
    // across multiple Stop invocations; a failed persist only degrades the
    // dedup (never blocks/crashes — diagnostic only, downstream cap logic is
    // unaffected either way).
    writeState(stateFile, {
      blocks: state.blocks, lastBlockAt: state.lastBlockAt,
      totalBlocks: state.totalBlocks, lifetimeCapLogged: state.lifetimeCapLogged,
      nonceFailClosedLogged: true, mismatchLogged: state.mismatchLogged,
    });
  }
  // Wave 3 addendum item 6: same ONE-per-session dedup convention, for the
  // DIFFERENT diagnostic case — a genuine attempt record for THIS id exists
  // in-window but authenticated against NEITHER this process's nonce nor its
  // session (see findRecentDropAttempt's own header for why this is scoped
  // to `row.id === id` only, and why it can legitimately fire after a
  // process restart even with no forgery involved).
  if (dropDiag.mismatch && !state.mismatchLogged) {
    state.mismatchLogged = true;
    try {
      process.stderr.write('[anti-hall] devswarm-child-gate: an attempt record for this workspace\'s own id '
        + 'exists for session ' + JSON.stringify(sessionId) + ' but authenticated against NEITHER this '
        + 'process\'s nonce nor its session (row nonce prefix ' + JSON.stringify(dropDiag.mismatch.rowNoncePrefix)
        + ' vs own nonce prefix ' + JSON.stringify(dropDiag.mismatch.ownNoncePrefix) + ') — treated as '
        + 'unauthenticated; this Stop re-blocks as if no attempt was made.\n');
    } catch (_) { /* best-effort diagnostic only */ }
    writeState(stateFile, {
      blocks: state.blocks, lastBlockAt: state.lastBlockAt,
      totalBlocks: state.totalBlocks, lifetimeCapLogged: state.lifetimeCapLogged,
      nonceFailClosedLogged: state.nonceFailClosedLogged, mismatchLogged: true,
    });
  }
  if (reported || dropAttempt) {
    const durable = readDurableUnread(process.env, os.homedir());
    if (!(durable.known && durable.count > 0)) return;
  }

  // D13 (v0.97.0): a fresh, zero-unread `inbox tick` marker is ITSELF a
  // liveness proof (the cron fired, drained, found nothing, and already
  // refreshed heartbeats/<id>.json's ts) — forcing a SEPARATE heartbeat report
  // on top is the exact overhead the D13 field measurement identified. Gated
  // the SAME way alreadyReportedThisEpisode's satisfaction is above: never
  // silences a KNOWN durable unread backlog (the cheap durable check only,
  // never the STRICT native probe — a satisfied/ticked child never pays that
  // spawn cost just to re-evaluate this).
  if (tickMarkerFreshZero(process.env, os.homedir(), now)) {
    const durable = readDurableUnread(process.env, os.homedir());
    if (!(durable.known && durable.count > 0)) return;
  }

  // Cap reset: once RESET_MS has elapsed since the last forced block, treat this
  // as a genuinely new stop episode and re-arm the heartbeat forcing. lastBlockAt
  // defaults to 0, so the very first Stop always arms.
  let blocks = state.blocks;
  if ((now - state.lastBlockAt) >= RESET_MS) blocks = 0;

  // Cap: after MAX_BLOCKS forced-acks in this episode, yield — allow the stop.
  // Do NOT rewrite lastBlockAt here, so the RESET_MS window keeps measuring from
  // the last ACTUAL block and can still re-arm later (never a hard loop).
  if (blocks >= MAX_BLOCKS) return;

  // defect a55d6b71a76f fix (root cause B): the per-window cap above resets
  // every RESET_MS, so a child stuck in the same failing state gets blocked
  // without limit across a long session. This lifetime bound (never reset)
  // stops that once and for all for the rest of the session — logged once
  // (stderr; this gate has no dedicated diagnostic log file of its own, and
  // never writes to another hook's log).
  if (state.totalBlocks >= MAX_BLOCKS_PER_SESSION) {
    if (!state.lifetimeCapLogged) {
      writeState(stateFile, { blocks, lastBlockAt: state.lastBlockAt, totalBlocks: state.totalBlocks, lifetimeCapLogged: true, nonceFailClosedLogged: state.nonceFailClosedLogged, mismatchLogged: state.mismatchLogged });
      try {
        process.stderr.write('[anti-hall] devswarm-child-gate: lifetime forced-ack cap ('
          + MAX_BLOCKS_PER_SESSION + ') reached for session ' + JSON.stringify(sessionId)
          + ' — no further Stop blocks this session.\n');
      } catch (_) { /* best-effort diagnostic only */ }
    }
    return;
  }

  // Force the heartbeat: persist the cap BEFORE blocking so it is honored even if
  // the child re-stops. If the cap state can't be persisted (e.g. unwritable HOME),
  // FAIL OPEN — do NOT block. A guard that blocks while unable to track its own cap
  // would block EVERY Stop forever (fail-closed). Mirrors devswarm-parent-gate.js.
  if (!writeState(stateFile, {
    blocks: blocks + 1,
    lastBlockAt: now,
    totalBlocks: state.totalBlocks + 1,
    lifetimeCapLogged: state.lifetimeCapLogged,
    nonceFailClosedLogged: state.nonceFailClosedLogged,
    mismatchLogged: state.mismatchLogged,
  })) return;

  // INBOUND check only now that we are actually about to block (never on the
  // cap-exhausted yield path above) — a healthy child never pays the probe cost.
  const unreadPending = hasUnreadParentMessages(process.env, os.homedir());
  const inboundPrefix = unreadPending
    ? 'DEVSWARM CHILD INBOX — you have unpulled/unread parent message(s): run ' +
      '`node ' + CLI + ' inbox pull ' + resolvedIdSafe(process.env) + '` (or `inbox read` ' +
      'if already pulled), then `inbox ack` once addressed — BEFORE you stop. '
    : '';

  // WAKE RE-VERIFY (v0.59, reused not re-invented — see header): rides along on
  // this SAME forced block, bounded by the SAME MAX_BLOCKS cap above. Claude-only.
  const wakeLine = wakeReassertLine(process.env, true);

  // defect a55d6b71a76f fix (root cause A): if the child already ATTEMPTED to
  // report and it was benignly dropped (findRecentDropAttempt above), and we
  // are still blocking anyway (only possible here because of a KNOWN durable
  // unread backlog — the `reported || dropAttempt` satisfaction path above
  // already returned otherwise), name the actual drop reason + remedy
  // instead of re-prescribing the exact heartbeat command that just failed
  // for this same reason on this same episode.
  const outboundLine = dropAttempt
    ? 'DEVSWARM CHILD WORKSPACE — ' + describeDropAttempt(dropAttempt, process.env) + ', THEN stop.'
    : 'DEVSWARM CHILD WORKSPACE — before you stop, emit a heartbeat / self-report to ' +
      'your parent orchestrator so you do not silently drop off its radar and later ' +
      'read as stale. Run `node ' + CLI + ' heartbeat ' + resolvedIdSafe(process.env) + ' ' +
      '--summary "<status>"` with a one-line status (e.g. "done — awaiting next task", ' +
      '"blocked on X", or "idle — reassign or archive me"), THEN stop. This keeps the ' +
      'parent\'s task list honest instead of leaving you unnoticed.';

  const reason = inboundPrefix + outboundLine + wakeLine;

  emitBlock(reason);
}

try {
  main();
} catch (_) {
  // Fail-open: any error must never block the child.
}
process.exit(0);
