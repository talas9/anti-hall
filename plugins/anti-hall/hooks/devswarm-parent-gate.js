#!/usr/bin/env node
// anti-hall :: devswarm-parent-gate (Stop hook, Primary only, loop-safe)
//
// Workaround for claude-code#39755 — the failure mode where a DevSwarm Primary
// orchestrator ENDS ITS TURN while a child workspace still has an unread inbox
// backlog past its cursor, or while the liveness supervisor has already judged a
// child STALE/ESCALATED. This gate fires on Stop and, for the PRIMARY session
// only, forces a bounded acknowledgement so the neglected child is attended to
// rather than silently abandoned off the Primary's task list.
//
// WHAT IT READS (audit P1-C — the Stop path has a ~30s budget and MUST stay
// cheap): it NEVER re-runs computeLiveness(). It STAYS fs-only for the
// #36 structural repoKey filter and the primary case below (one memoized git
// spawn per distinct worktree, reused everywhere else in this file). The
// per-descriptor mesh-direct UNION check (root cause b fix, see "UNION" below)
// is the ONE exception: it DOES open the store DB (read-only) for each
// resolvable descriptor whose NDJSON side is conclusively known — this was
// added deliberately to close a real blind spot (a `send --to` direct is
// STORE-ONLY, invisible to the NDJSON-only signals below) and reuses the
// ALREADY-memoized repoKey (never a second git spawn per worktree). Bounded,
// read-only, fail-open (never blocks on failure) — but no longer "never
// touches git/the store"; that invariant applied to the pre-union version of
// this file only. Signals otherwise come from files the supervisor / consumer
// / ingest daemon already wrote:
//   - CHILD unread backlog: the durable NDJSON inbox + its cursor, via the
//     read/ack primitive (companion/lib/devswarm-inbox-cursor.js
//     readUnreadMessages) — pure fs, the SAME projection the staleness
//     detector consumes, no git. Only REAL unread counts toward blocking — a
//     row classified as system-generated poke/mirror noise (companion/lib/
//     devswarm-noise.js isNoiseText) is excluded, so a "ghost" workspace whose
//     entire unread backlog is the Primary's own poke bouncing back no longer
//     nags. FAIL-OPEN: `known:false` (cursor/inbox not conclusively readable,
//     INCLUDING an absent inbox file) always blocks unconditionally — never
//     silently reads as "0 unread". A freshly-registered child does NOT hit
//     this: scripts/devswarm.js's register precreates an EMPTY inbox file
//     (alongside the cursor it already precreated), so "just registered,
//     never messaged" reads as known:true/0-unread (confirmed-empty), not
//     known:false — a descriptor whose inbox is genuinely absent is therefore
//     a real anomaly (e.g. a pre-fix legacy child, or a failed inbox write),
//     not routine startup, and must block. A row that fails to parse is
//     likewise never treated as confirmed-noise — it counts toward realUnread.
//   - STALE / ESCALATED: the supervisor's already-written per-workspace verdict
//     file (companion/lib/liveness.js livenessPathFor -> ~/.anti-hall/devswarm/
//     liveness/<id>.json). Read-only. `escalated` is terminal/sticky (per
//     recovery.js) and counts as BLOCKING — same severity class as `stale`,
//     because escalation means the automatic poke already failed and a human
//     must look (P1-C default: yes, an escalated child also blocks the gate).
//   - PRIMARY's OWN unread (#34): unlike a child, the Primary has no descriptor
//     with its own inboxPath/cursorPath — its inbound is ingested by the daemon
//     directly into the store under workspaceId primary-<worktreeHash> and
//     exposed ONLY via the per-project summary projection (readOwnUnread reads
//     summaries/<worktreeHash>.json -> workspaces[primary-<hash>].unread), the
//     SAME projection devswarm-parent-inbox.js already reads for status/gates. A
//     single small fs read; still no git, no computeLiveness, no store DB open.
//     C3 FIX (polarity parity): an own-summary that is genuinely UNREADABLE
//     (exists but corrupt/truncated — e.g. the daemon crashed mid-write) now
//     surfaces as an explicit unknown/blocking entry, matching the child
//     axis's known:false-always-blocks discipline below, instead of silently
//     reading as "0 unread". A summary that has simply NEVER been derived yet
//     (ENOENT — routine for a brand-new project) stays confirmed-empty, never
//     unknown — see readOwnUnread's own header for the full distinction.
//
// INERTNESS (audit P1-D): this hook is a NO-OP until EITHER (a) workspace
// descriptors exist (~/.anti-hall/devswarm/workspaces/*.json) with a populated
// durable inbox, (b) the Primary's own summary-projected unread is nonzero, OR
// (c) the Primary's own summary is unreadable in the genuinely-anomalous C3
// sense above (never for a plain ENOENT). A public/standalone anti-hall user
// with no descriptors, no inbox tooling
// running, and no own-unread gets zero output, exit 0 — byte-identical to
// today. It is not self-sufficient; it depends on Phase 2's ingest daemon (or a
// consumer's equivalent) to have anything to act on.
//
// CLEAR PATH (audit P1-A, corrected P0-C): the non-skip escape is a real inbox
// read/ack that advances the cursor — `devswarm.js inbox read-primary <id>`,
// the SAME dual-backend verb cmdInboxMessages' ack path already uses (advances
// BOTH the durable-NDJSON cursor via devswarm-inbox-cursor.js's ackTo AND the
// store's own cursor via s.setCursor + deriveSummary). The block reason states
// this exact path. Prior wording named companion/lib/devswarm-inbox-cursor.js's
// bare advanceCursor primitive directly — that primitive is NDJSON-ONLY (its
// own file header says so), so following it as prescribed left a store-backed
// row's unread projection untouched: the gate refired forever demanding a
// remedy that could never structurally satisfy it. skip-guard's TTL
// (~/.anti-hall/skip.json, guard name "devswarm-parent-gate") is the last-resort
// user-consented escape hatch.
//
// LOOP-SAFETY: a bounded per-SET forced-ack cap. The blocking SET is signed
// (workspace id + unread count + verdict status). The cap counter RESETS when
// that signature changes (new unread arrived, a child newly went stale, a
// partial ack moved a count) so each distinct neglect state gets its own small
// budget; once the SAME set has been forced-acked CAP times we go quiet. This
// can never hard-loop even if the model ignores the block. Default cap 3
// (clamped 2..5 via ANTIHALL_DEVSWARM_PARENT_GATE_CAP).
//
// WAKE RE-VERIFY (v0.59 "self-wake"): the Primary is the LONGEST-lived DevSwarm
// session (a child is typically spun for one matter and archived; the Primary
// plausibly outlives a recurring cron job's 7-day auto-expiry), so it also needs
// the MAILBOX WAKE re-assertion devswarm-child-role.js hands it at SessionStart
// (CronList-check, then CronCreate the job that is the only primitive firing
// while the REPL is IDLE). Text-only, reusing this SAME neglect-forced-ack path
// and its EXISTING {sig, blocks} state — no new file, no new field, no new cap.
// This means the wake line rides along ONLY while the Primary is already being
// blocked for a real neglect reason; it is silent on the healthy/no-neglect path
// (blocking.length === 0 clears state and returns below) — extending it to that
// path would need an independent counter un-keyed by the neglect signature, i.e.
// new schema, which the "no new schema" rule this feature is bound by forbids.
// Claude-only (CronCreate is a Claude tool).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id?, cwd?, ... } — cwd (when present) resolves the
//            CURRENT worktree's Primary-own-unread summary (#34); falls back to
//            process.cwd() when absent, same posture as other Stop hooks
//            (e.g. task-guard.js documents cwd? as optional on this event).
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : always — fail-open on any error so a bug never hard-loops Claude.
//
// Pure Node built-ins. Cross-platform. Fail-open on EVERY error.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { isSkipped } = require('./skip-guard.js');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
// stateFileFor: SHARED with scripts/devswarm.js's `gate-intent` CLI verb and
// the intents-shape forward migration below — one path derivation, never
// three (see that module's header).
const { stateFileFor } = require('../companion/lib/devswarm-gate-state.js');
// REUSE (never reimplement): descriptor discovery, the read/ack primitive, and
// the verdict-file path helper all already exist.
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { readUnreadMessages } = require('../companion/lib/devswarm-inbox-cursor.js');
const devswarmUnread = require('../companion/lib/devswarm-unread.js');
const { livenessPathFor, devswarmRoot, hasFreshHeartbeat, isSessionAliveRow } = require('../companion/lib/liveness.js');
const { isArchivedWorkspace } = require('../companion/lib/devswarm-archived.js');
// APP-SIDE archive detection (field: the owner archived children in the DevSwarm
// app, which never writes anti-hall's own archived/<id>.json). READ-ONLY, from a
// cache the supervisor writes — never a hivecontrol spawn on this hot path.
const { readArchivedCache, isAppArchived } = require('../companion/lib/devswarm-archived-cache.js');
// POKE_PREFIX text check (companion/lib/devswarm-noise.js isNoiseText) —
// applied HERE to descriptor durable-inbox NDJSON rows' `.message` (a shape
// with no mtype/sender/recipient at all — see that module's header for why
// this gate uses text while scripts/devswarm.js's isForwardable (#67) uses a
// purely structural check over STORE rows instead). GHOST-WORKSPACE fix: a
// workspace's unread backlog that is ENTIRELY noise (the Primary's own poke
// bouncing back, never a genuine message) no longer nags — see realUnread
// below. Message AGE plays no part in this decision (a prior version of this
// fix keyed exclusion on message/child freshness instead; that failed review
// twice — a ghost's unread is actually FRESH poke traffic, so freshness never
// excluded it, and freshness also risked suppressing a genuinely fresh unread
// on an idle-but-alive child. CONTENT, not age, is the only signal that
// distinguishes real neglect from noise).
const { isNoiseText } = require('../companion/lib/devswarm-noise.js');
// primaryWorkspaceId/worktreeHash: the SAME per-worktree Primary-id convention
// devswarm-parent-inbox.js and the ingest daemon already use (#34 parity — the
// Primary's OWN unread, resolved below via readOwnUnread).
const installIngest = require('../companion/install-devswarm-ingest.js');

// CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper (see
// devswarm-child-gate.js's identical const for the P1 rationale: cwd is the
// project worktree, never the plugin root, so a relative path is unrunnable).
const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// WATCHER — the ABSOLUTE path to the Monitor watch script (self-resolving: no
// required args). Same __dirname-based resolution rationale as CLI above.
// Passed to wakeReassert() below so the Claude branch can arm `Monitor` IN
// ADDITION to CronCreate (never instead — see lib/devswarm-wake.js's
// NON-NEGOTIABLE header comment).
const WATCHER = path.join(__dirname, '..', 'companion', 'lib', 'devswarm-wake-watch.js');

const GUARD_NAME = 'devswarm-parent-gate';
const DEFAULT_CAP = 3; // forced-acks per distinct blocking SET

// STATED-INTENT ABSOLUTE BACKSTOP MULTIPLIER — a Primary that has stated an
// explicit intent for the CURRENT blocking signature (via `devswarm.js
// gate-intent --reason "..."`, or `--session <id>` for a non-default caller)
// gets a LARGER budget before the plain-backlog axis escalates (see the
// intents handling in main() below) — the whole point of recording an intent
// is that repeating the SAME already-explained condition must not accumulate
// toward "a human should look" the way silently ignoring the gate does. It is
// still bounded (never unbounded), per the "no hard-loop" invariant this file
// has always kept: `absoluteCap = resolveCap(env) * INTENT_ABSOLUTE_MULTIPLIER`
// (10..25 for the resolvable cap range 2..5). Fixed, not independently
// configurable — one fewer knob than the base cap; the base cap's own env var
// already scales this proportionally.
const INTENT_ABSOLUTE_MULTIPLIER = 5;

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

// resolveCap(env) -> int in [2,5]. Absent / non-numeric / out-of-range falls
// back to the default (fail-open: a typo never disables or unbounds the gate).
function resolveCap(env) {
  const raw = (env || {}).ANTIHALL_DEVSWARM_PARENT_GATE_CAP;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) return Math.max(2, Math.min(5, n));
  }
  return DEFAULT_CAP;
}

// readVerdict(id, home) -> { status, pending, notDraining } | null. Reads ONLY
// the supervisor's already-written per-workspace verdict file (no
// computeLiveness, no git). Absent / unreadable / malformed -> null
// (fail-safe: no verdict = not blocking on the liveness axis).
//
// A1 fix: this used to be `readVerdictStatus`, returning ONLY `v.status`,
// discarding the verdict's own `pending`/`notDraining`. Live proof this was
// wrong: a persisted verdict of `{"status":"escalated","pending":false,
// "notDraining":false}` — the verdict itself says nothing is outstanding —
// still force-blocked the Primary ~20 consecutive turns, because `escalated`
// is STICKY (liveness.js's TERMINAL short-circuit returns it unchanged,
// `pending:false`, forever) and is cleared only by a fresh heartbeat a
// finished session will never emit. `pending`/`notDraining` are now threaded
// to main() so `status === 'stale' | 'escalated'` alone can never drive a hard
// block without at least one corroborating axis — see the CORROBORATION
// comment at the family-loop call site below.
// worktreeIsGone(worktreePath) -> boolean. TRUE only when the path is
// DEFINITIVELY absent from disk (a stat that failed with ENOENT). Everything
// else is FALSE — an empty/missing worktreePath field, a path that stats fine,
// and critically a stat that failed for any OTHER reason (EACCES, EIO, ELOOP,
// ENOTDIR on a parent) — because "I could not tell" must never be read as
// "gone" on a path whose only consumer suppresses a nag. This is the
// fail-closed-to-BLOCK half of the un-clearable-axis rule in main().
//
// Memoized per distinct path for the life of the process: one Stop-hook run can
// see the same worktreePath on several descriptors (that is the whole premise of
// the identity-family collapse), and the Stop path is explicitly budgeted to
// touch only already-written files — the same idiom the repoKeyForWorktree call
// site in main() already uses. lstat, not stat: a DANGLING SYMLINK at that path
// is a real entry on disk, not an absent worktree, and must not read as gone.
const worktreeGoneCache = new Map();
function worktreeIsGone(worktreePath) {
  if (!worktreePath) return false;
  const key = String(worktreePath);
  if (worktreeGoneCache.has(key)) return worktreeGoneCache.get(key);
  // NON-ABSOLUTE -> NOT GONE (P1, fail closed). A legacy descriptor can carry a
  // RELATIVE worktreePath, which is only meaningful against the cwd it was
  // registered from — a fact the descriptor does not carry. lstat'ing it from the
  // Primary's cwd answers a DIFFERENT question, and its ENOENT would suppress the
  // missing-inbox block for a workspace that is very much alive. We cannot prove
  // it is gone, so it is not gone. (scripts/devswarm.js now persists ABSOLUTE
  // paths at build time; this is the fail-closed read for values written before.)
  if (!path.isAbsolute(key)) { worktreeGoneCache.set(key, false); return false; }
  let gone = false;
  try {
    fs.lstatSync(key);
    gone = false;
  } catch (e) {
    gone = !!(e && e.code === 'ENOENT');
  }
  worktreeGoneCache.set(key, gone);
  return gone;
}

function readVerdict(id, home) {
  try {
    const p = livenessPathFor(id, home); // throws on an unsafe id
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!v || typeof v.status !== 'string') return null;
    return { status: v.status, pending: v.pending === true, notDraining: v.notDraining === true };
  } catch (_) {
    return null;
  }
}

// archiveReadyCache: repoKey -> parsed summary.workspaces map | null. Memoized
// per distinct repoKey for the life of this Stop-hook run — several family
// members (or several descriptors in one project) can share one project's
// summary file, and this is the SAME summaries/<repoKey>.json file
// readOwnUnread already reads for the Primary's own row, just re-opened here
// for an arbitrary member id.
//
// isArchiveReadyFor(id, repoKey, home) -> bool. DEFECT 0ace80dff415 (P1): once
// the Primary has ruled a child done — via `devswarm.js gate <id> --set done
// --set merged --set tests_passed` (a Primary-settable CLI verb; the required-
// gate set defaults to done,merged,tests_passed — see devswarm-store.js's
// DEFAULT_REQUIRED_GATES) — the store ALREADY derives `archive_ready: true`
// into the per-project summary projection (deriveSummary). This IS the
// "archive-approved ruling" the design note asked for: no new persisted
// field, no forbidden-file touch, just PROJECTING a fact companion/lib/
// devswarm-store.js already computed into the SAME file this hook already
// reads elsewhere. A child the Primary has ruled done+merged+tests-passed is,
// by construction, no longer a wedged/neglected escalation — the automatic
// poke/escalate path exists to get a human to look at a STUCK child, and a
// child the Primary already closed out is not stuck; it is simply waiting on
// the app-side archive action, which is not this gate's concern.
//
// FAIL-CLOSED (never silently un-blocks a real wedge, mirrors hasFreshHeartbeat's
// own "throws -> staleOrEscalated left as-is" posture at its call site): any
// read/parse failure, an absent summary, or an id missing from the projection
// all return false. `repoKey` must be the resolved key for THIS descriptor's
// OWN worktree (dKey, not `selfKey`) so a foreign-but-locally-registered id is
// never looked up under the Primary's own project summary.
const archiveReadyCache = new Map();
function isArchiveReadyFor(id, repoKey, home) {
  if (!id || !repoKey) return false;
  const cacheKey = String(repoKey);
  let workspaces;
  if (archiveReadyCache.has(cacheKey)) {
    workspaces = archiveReadyCache.get(cacheKey);
  } else {
    workspaces = null;
    try {
      const p = path.join(devswarmRoot(home), 'summaries', cacheKey + '.json');
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
          workspaces = parsed.workspaces;
        }
      }
    } catch (_) { workspaces = null; }
    archiveReadyCache.set(cacheKey, workspaces);
  }
  if (!workspaces) return false;
  const entry = workspaces[String(id)];
  return !!(entry && entry.archive_ready === true);
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry — the same root `git rev-parse --show-toplevel`
// would report, WITHOUT spawning git (keeps this Stop hook's ~30s budget cheap).
// Mirrors devswarm-parent-inbox.js / devswarm-child-turn.js byte-for-byte (kept
// as a local copy rather than a shared require so this hook's dependency surface
// stays exactly what it already was — no new cross-file coupling for a few lines
// of pure fs walk).
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

// readOwnUnread(home, cwd, repoKey) -> { unread, id, urgencyMax, unknown }. The
// Primary's OWN inbound (#34) has no descriptor with an inboxPath/cursorPath
// to read via readUnread — it is ingested by the daemon directly into the
// store under workspaceId primary-<worktreeHash> and exposed via the
// per-project summary projection, the SAME projection devswarm-parent-inbox.js
// reads for status/gates. v0.57 mesh (D1/D24): that summary is now keyed by
// repoKey (summaries/<repoKey>.json), NOT the legacy worktreeHash. `repoKey` is
// resolved ONCE by the caller (main(), from `cwd`) and passed in here — a
// SEPARATE internal resolution from `top` used to spawn git a second time for
// the logically identical key, since `--git-common-dir` is subdirectory-
// invariant (Reviewer/Codex P2 dedup) — and falls BACK to the legacy
// worktreeHash-keyed file only when repoKey itself is unresolvable (pre-mesh
// back-compat, mirroring devswarm-parent-inbox.js's own staleness-banner
// fallback). `urgencyMax` (D4, Phase 8 step 4) is the entry's own pending-
// direct urgency, honored ONLY in wording — a DIRECT always gates regardless
// of urgency (D4's type-vs-urgency separation). A single small fs read — no
// store DB open — stays within the Stop hook's cheap-read budget.
//
// C3 FIX — POLARITY PARITY WITH THE CHILD AXIS BELOW. A child's unknown-unread
// (known:false — an inbox that cannot be conclusively read, INCLUDING a
// genuinely absent file) ALWAYS blocks (see the #36 loop below). Pre-fix, this
// function instead swallowed EVERY failure — including the daemon simply being
// down mid-write, leaving a truncated/corrupt summary — into the SAME
// `{unread:0}` shape as "confirmed nothing pending", so the Primary's own
// neglected inbox went invisible exactly when something was actually wrong.
// The fix distinguishes:
//   - ENOENT (the summary has never been derived for this project at all —
//     e.g. the very first session, or genuinely no mesh traffic ever) stays
//     `unknown:false`/confirmed-empty. This is the ROUTINE, expected state
//     (nothing precreates this file the way register precreates a child's
//     inbox), so treating it as an anomaly would nag every brand-new
//     DevSwarm-active Primary on its very first Stop — the reads above the
//     empty-current-file case are still resolvable (no project / no id at all)
//     also stay `unknown:false` for the same "nothing to check" reason.
//   - ANY OTHER read/parse failure (EACCES, EISDIR, a torn zero-byte write,
//     corrupt/truncated JSON, an unexpected shape) means a summary WAS
//     reachable enough to attempt and something is now genuinely wrong — that
//     IS the "daemon crashed mid-write" anomaly this fix targets, so it comes
//     back `unknown:true` and main() below folds it into the blocking set,
//     never silently reading it as a healthy zero.
// pendingQuestions (§4.4 requirement C): every returned shape below carries
// `pendingQuestions` (always an array, `[]` default) so main()'s
// `own.pendingQuestions || []` never needs to special-case a missing field.
// Only the "entry resolved" success path can ever populate it non-empty — it
// is read from the SAME summary entry `unread`/`urgencyMax` already come
// from, defaulting to `[]` if absent or malformed (not an array).
//
// pendingQuestionsTruncated (P2 fix): devswarm-store.js's computeSummary
// caps pendingQuestions at a per-workspace backstop (DEFAULT_PENDING_
// QUESTIONS_CAP) and, ONLY when that cap actually bites, stamps the entry
// with `pendingQuestionsTruncated: {cap, kept, dropped}` — the store's own
// header there is explicit that a truncated list must never be treated as a
// complete one. Nothing downstream consumed that signal until this fix: with
// enough distinct resolved senders holding unanswered questions to exceed
// the cap, the senders past it are silently absent from pendingQuestions, so
// unansweredQuestions() below never sees them and this gate stops blocking
// for exactly those askers — without ever observing a reply. Every returned
// shape below carries `pendingQuestionsTruncated` (`null` default) so
// main()'s `own.pendingQuestionsTruncated` never needs to special-case a
// missing field; only the "entry resolved" success path can populate it,
// read verbatim from the same summary entry (never re-derived here — this
// hook must stay a pure projection of what the store already decided).
function readOwnUnread(home, cwd, repoKey) {
  const top = cwd ? findGitToplevel(cwd) : null;
  if (!top) return { unread: 0, id: null, urgencyMax: null, unknown: false, pendingQuestions: [], pendingQuestionsTruncated: null };

  let id = null;
  try { id = installIngest.primaryWorkspaceId(top); } catch (_) { id = null; }
  if (!id) return { unread: 0, id: null, urgencyMax: null, unknown: false, pendingQuestions: [], pendingQuestionsTruncated: null };

  try {
    let legacyHash = null;
    try { legacyHash = installIngest.worktreeHash(top); } catch (_) { legacyHash = null; }
    const hash = repoKey || legacyHash;
    if (!hash) return { unread: 0, id, urgencyMax: null, unknown: false, pendingQuestions: [], pendingQuestionsTruncated: null };

    const p = path.join(devswarmRoot(home), 'summaries', String(hash) + '.json');

    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      // ENOENT = routine "never derived yet" -> confirmed-empty, not unknown.
      // Anything else (EACCES, EISDIR, ...) means something is actually wrong.
      return { unread: 0, id, urgencyMax: null, unknown: !!(e && e.code !== 'ENOENT'), pendingQuestions: [], pendingQuestionsTruncated: null };
    }

    const trimmed = String(raw).trim();
    if (!trimmed) {
      // A zero-byte file is the SAME torn-write window every O_EXCL lock in
      // this codebase treats as ambiguous (devswarm-pull.js's own TORN-READ
      // GUARD) — a derive-in-progress write, not a confirmed-empty summary.
      // Fail open TOWARD unknown here, never toward a silent 0.
      return { unread: 0, id, urgencyMax: null, unknown: true, pendingQuestions: [], pendingQuestionsTruncated: null };
    }

    const summary = JSON.parse(trimmed); // throws on corrupt/truncated JSON -> caught below
    if (!summary || typeof summary !== 'object' || typeof summary.workspaces !== 'object' || !summary.workspaces) {
      return { unread: 0, id, urgencyMax: null, unknown: true, pendingQuestions: [], pendingQuestionsTruncated: null }; // parses, but not the expected shape
    }

    const entry = summary.workspaces[id];
    const unread = entry && Number.isFinite(entry.unread) && entry.unread > 0 ? entry.unread : 0;
    const urgencyMax = (unread > 0 && entry && entry.urgencyMax) ? entry.urgencyMax : null;
    const pendingQuestions = entry && Array.isArray(entry.pendingQuestions) ? entry.pendingQuestions : [];
    // Presence alone is the signal — trust the store's own decision to stamp
    // it rather than re-validating {cap,kept,dropped} here (this hook never
    // re-derives store state, it only projects it); an unexpected shape still
    // degrades safely since main() only checks truthiness, never reads into it.
    const pendingQuestionsTruncated = entry && entry.pendingQuestionsTruncated ? entry.pendingQuestionsTruncated : null;
    return { unread, id, urgencyMax, unknown: false, pendingQuestions, pendingQuestionsTruncated };
  } catch (_) {
    // Any unanticipated failure past the ENOENT-tolerant read above means a
    // summary WAS reachable enough to attempt reading/parsing and something
    // still went wrong — the C3 anomaly class. Fail toward unknown (surfaced),
    // never toward a silent healthy-looking 0.
    return { unread: 0, id, urgencyMax: null, unknown: true, pendingQuestions: [], pendingQuestionsTruncated: null };
  }
}

function main() {
  // Read stdin (fd 0 — cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return; }

  // Escape hatch: an explicit, user-consented skip outranks the guard.
  if (isSkipped(GUARD_NAME)) return;

  // Primary + DevSwarm-active only. A child workspace, a non-DevSwarm session, or
  // an inactive supervisor is a silent no-op.
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { return; }

  const home = os.homedir();

  // `cwd` falls back to process.cwd() when the payload omits it, same fallback
  // posture other Stop hooks use (e.g. task-guard.js documents `cwd?` as
  // optional on this event).
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd : process.cwd();

  // Resolve repoKey ONCE for this whole hook invocation (v0.57 mesh, D1/D2) —
  // reused for BOTH the Primary's own-unread summary lookup (readOwnUnread)
  // AND the #36 structural filter's `selfKey` comparison below (Reviewer/Codex
  // P2 dedup: these used to spawn `git rev-parse --git-common-dir` twice for
  // the logically identical key, since it is subdirectory-invariant). Lazy-
  // required, fail-open (D27): a missing/corrupt module -> null, never throws.
  let repokeyMod = null;
  try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
  let selfKey = null;
  try { selfKey = repokeyMod ? repokeyMod.repoKeyForWorktree(cwd) : null; } catch (_) { selfKey = null; }

  // Primary's OWN inbound unread (#34 parity — the parent is gated on its OWN
  // unread too, not just children's).
  const own = readOwnUnread(home, cwd, selfKey);

  // descriptors (moved up from its original position below `unanswered`,
  // read-only, no dependency on `own`/`unanswered`): needed HERE now too, for
  // the identity-family cross-check the unanswered-questions block below
  // performs (defect 427dbff95f28). The original later use (building
  // `rawEntries`/`families` for the blocking-set reduction) is unchanged —
  // this is the SAME `descriptors` value, just resolved once, earlier.
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }

  // UNANSWERED QUESTIONS (§4.4 requirement C): cross-reference this PROJECT's
  // OBSERVED replies (companion/lib/devswarm-reply-state.js — pure fs, never
  // opens the store DB, same Stop-hook budget constraint as everything else
  // in this file) against own.pendingQuestions. Reuses `selfKey` (already
  // resolved above for readOwnUnread/the #36 filter) rather than
  // `payload.session_id`: pendingQuestions is now PERMANENT (devswarm-store.js
  // computeSummary), so the reply record that clears it must share that same
  // durable per-project lifetime, not a short-lived Claude session_id — a
  // fresh session's empty session-keyed reply-state used to resurrect every
  // already-answered question (Bug 1a). Lazy-required inside this try/catch
  // (same idiom as repokeyMod/wakeReassertLine above) so a missing or
  // throwing lib degrades instead of crashing the Stop hook. Fail-open TOWARD
  // UNANSWERED on any surprise here — matches the lib's own posture, but this
  // caller must independently never let an unexpected shape (e.g. a
  // non-array own.pendingQuestions) throw past this point.
  let unanswered = [];
  try {
    const replyStateLib = require('../companion/lib/devswarm-reply-state.js');
    const replyState = replyStateLib.readReplyState(selfKey, home);
    const rawUnanswered = replyStateLib.unansweredQuestions(own.pendingQuestions || [], replyState);

    // IDENTITY-FAMILY CROSS-CHECK (defect 427dbff95f28, P1 field report): a
    // pendingQuestion's `from` is the sender's resolved REGISTRY-ROW id —
    // devswarm-store.js's resolveSenderRegistryId picks whichever row is
    // "freshest LIVE" among every row sharing that sender's worktree-derived
    // meshId. A reply's recorded key, by contrast, is whichever row
    // scripts/devswarm.js's resolveSendTarget ACTUALLY resolved `--to` to —
    // an EXACT registry-id match (e.g. a plain `send --to <uuid-row>`) wins
    // there regardless of liveness. These are two INDEPENDENTLY computed
    // identities for the very same logical agent (a child can be known by a
    // UUID row, a slug row, AND a primary-<8hex> builder id — see
    // devswarm-identity-family.js's own header), and they can legitimately
    // diverge: the reply then lands under a DIFFERENT row than the question's
    // `from`, and unansweredQuestions()'s raw string compare never sees it —
    // reproduced via companion/lib/devswarm-store.js + devswarm-reply-state.js
    // directly (field defect repro, 2026-08-31).
    //
    // Before trusting a rawUnanswered entry, re-check every OTHER member of
    // q.from's identity family — grouped by resolved worktree via
    // devswarm-identity-family.js's collapseFamilies, the SAME grouping this
    // file already uses below (families/rawEntries) to reduce the blocking
    // set — for a reply recorded at-or-after this question's effective ts.
    // Any family member's reply counts as answering the question; this can
    // ONLY ever remove a FALSE POSITIVE (a real reply the raw string compare
    // missed because it landed on a sibling row of the SAME worktree), never
    // manufacture a FALSE NEGATIVE: collapseFamilies groups strictly by
    // canonicalMeshId(worktreePath), so two DIFFERENT children (different
    // worktrees) can never share a family, and a genuinely unresolvable/
    // unknown `from` or a family with no later reply anywhere is returned
    // completely UNCHANGED (kept unanswered). A non-finite q.ts (unparsable —
    // "always newer" per devswarm-store.js's pendingQuestionEffTs) can never
    // satisfy `qTs <= lastReplyTs` against any finite recorded reply ts, so a
    // permanently-blocking malformed-ts question stays permanently blocking,
    // exactly as before. Fail-open toward the ORIGINAL rawUnanswered set on
    // any surprise (missing module, throwing resolver, empty descriptors) —
    // this cross-check is strictly additive, never a replacement for the
    // underlying unansweredQuestions() computation.
    if (rawUnanswered.length > 0 && descriptors.length > 0) {
      let crossChecked = null;
      try {
        const identityFamily = require('../companion/lib/devswarm-identity-family.js');
        const devswarmCli = require('../scripts/devswarm.js');
        const meshIdCache = new Map();
        const resolveMeshId = (wt) => {
          if (meshIdCache.has(wt)) return meshIdCache.get(wt);
          let k = null;
          try { k = devswarmCli.canonicalMeshId(wt); } catch (_) { k = null; }
          meshIdCache.set(wt, k);
          return k;
        };
        const crossFamilies = identityFamily.collapseFamilies(descriptors, { resolve: resolveMeshId });
        const familyByMemberId = new Map();
        for (const fam of crossFamilies) {
          for (const m of (fam && fam.members) || []) {
            if (m && m.id != null) familyByMemberId.set(String(m.id), fam);
          }
        }
        crossChecked = rawUnanswered.filter((q) => {
          if (!q || q.from == null) return true; // malformed -> keep (fail-open, unchanged)
          const fam = familyByMemberId.get(String(q.from));
          if (!fam) return true; // no known family for this sender -> unchanged
          const qTs = Number.isFinite(q.ts) ? q.ts : Infinity;
          for (const m of (fam.members || [])) {
            const mid = m && m.id != null ? String(m.id) : null;
            if (!mid) continue;
            const entry = replyState[mid];
            const lastReplyTs = entry && Number.isFinite(entry.lastReplyTs) ? entry.lastReplyTs : 0;
            if (qTs <= lastReplyTs) return false; // answered via a family sibling's reply record
          }
          return true; // no family member's reply covers this question -> still unanswered
        });
      } catch (_) {
        crossChecked = null; // fail-open: fall through to rawUnanswered below
      }
      unanswered = crossChecked || rawUnanswered;
    } else {
      unanswered = rawUnanswered;
    }
  } catch (_) {
    // The lib itself is fail-open-toward-unanswered; mirror that here too —
    // an unreadable reply-state module must never silently clear a question.
    unanswered = Array.isArray(own.pendingQuestions) ? own.pendingQuestions.slice() : [];
  }

  // TRUNCATED pendingQuestions (P2 fix — see readOwnUnread's header). This is
  // a THIRD, independent blocking axis alongside unread/unanswered: even a
  // CORRECTLY-computed `unanswered` above is unanswered over an INCOMPLETE
  // view when truncation is present — a sender past the cap simply never
  // reached `own.pendingQuestions` at all, so it cannot show up in
  // `unanswered` no matter how faithfully unansweredQuestions() runs. The
  // presence of the signal is itself the fact to act on; blocking must not
  // wait for `unanswered` to (impossibly) reflect the missing senders.
  const truncated = own.pendingQuestionsTruncated || null;

  // INERT until descriptors exist (P1-D) OR the Primary itself has unread OR
  // its own summary is unreadable in a genuinely anomalous way (C3 — see
  // readOwnUnread's header: `own.unknown` is only ever true when something
  // WAS derivable and is now broken, never for the routine "never derived
  // yet" ENOENT case, so this override can never make a vanilla/never-touched
  // DevSwarm Primary noisy) OR an unanswered question is pending (requirement
  // C's "ALWAYS emits a block ... under any circumstance" — a pendingQuestion
  // is structurally a subset of own.unread in the normal case, so this arm
  // rarely fires on its own, but it must never be possible for an unanswered
  // question to be swallowed by inertness before `unanswered` is even
  // consulted below) OR pendingQuestions is truncated (same "never swallow a
  // real signal before it's consulted" reasoning — a fresh/never-touched
  // Primary can never hit the 200-sender backstop, so this cannot make a
  // vanilla project noisy either). `descriptors` was already resolved above
  // (moved up for the identity-family cross-check) — reused here unchanged.
  if (descriptors.length === 0 && own.unread === 0 && !own.unknown && unanswered.length === 0 && !truncated) return;

  // Build the blocking SET: workspaces with unread backlog past their cursor OR a
  // stale/escalated verdict, PLUS the Primary's own unread. All reads are pure fs
  // (no git, no computeLiveness, no store DB open) — `selfKey` above is the
  // ONLY repoKey git spawn this hook invocation needs; the #36 structural
  // filter below reuses it rather than re-resolving.
  // IDENTITY-FAMILY COLLAPSE (fixes the parent-gate workspace-count
  // divergence from the app's own count): `readDescriptors(home)` yields one
  // row per descriptor FILE, and two descriptor files can legitimately share
  // ONE worktreePath (a builder-id UUID row and a slug row for the SAME
  // worktree — including the Primary's OWN worktree, which is exactly the
  // live-evidence case of the self/"(you)" row appearing twice). Rather than
  // pushing directly into `blocking` per-own/per-descriptor as before, every
  // candidate (own's synthetic self-row PLUS every descriptor) is collected
  // into `rawEntries` UNCONDITIONALLY here, grouped into identity families
  // below (companion/lib/devswarm-identity-family.js), and only THEN reduced
  // to one blocking entry per family with unioned counts. This is a pure
  // READ-TIME grouping — nothing here retires/deletes/tombstones any
  // descriptor or state file; the store-layer fold (scripts/devswarm.js) and
  // retirePhantomWorktreeDuplicates (hooks/devswarm-child-turn.js) are
  // unchanged and still own the legitimate "two live tabs on one worktree"
  // case.
  const rawEntries = [];
  if (own.id) {
    // `cwd` is the same input readOwnUnread resolved `own.id` from (via
    // findGitToplevel(cwd) -> primaryWorkspaceId) — passing it as this
    // synthetic entry's worktreePath lets the family resolver below
    // (canonicalMeshId) group it with any descriptor sharing the SAME
    // worktree, which is what closes the self-row duplication.
    rawEntries.push({
      id: own.id,
      worktreePath: cwd,
      realUnread: own.unread,
      unreadUnknown: !!own.unknown,
      // own-summary-unreadable: a DISTINCT failure mode from a descriptor's
      // inbox/cursor read (own.unknown comes from readOwnUnread's own-summary
      // projection, never from inboxPath/cursorPath) — labeled distinctly so
      // a family's unknownMembers list never confuses the two.
      unreadReason: own.unknown ? 'own-summary-unreadable' : null,
      unreadReasonPath: null,
      unreadReasonErrno: null,
      staleOrEscalated: false,
      status: '',
      urgencyMax: own.urgencyMax != null ? own.urgencyMax : null,
    });
  }
  // #36 STRUCTURAL cross-project filter (D29 — REPLACES the spoofable v0.56 env
  // filter `d.repoId !== currentRepoId`; env DEVSWARM_REPO_ID is in the SAME
  // trust class as the #39 ack-guard spoof). This loop builds its blocking SET
  // from raw machine-global `readDescriptors` + `readUnread` — NOT the
  // per-project summary — so it needs its OWN explicit filter (re-scoping the
  // summary alone, as devswarm-parent-inbox.js does, does NOT close this
  // gate-path bleed). `selfKey` is resolved ONCE (above, shared with
  // readOwnUnread); each descriptor's `repoKeyForWorktree(d.worktreePath)` is
  // memoized by worktreePath so N descriptors sharing one worktree (siblings
  // of one repo) never re-spawn git more than once each — and is skipped
  // entirely (Opus-auditor P2) once `selfKey` itself is unresolvable, since the
  // filter is then disabled for every descriptor regardless of `dKey`. Fail-
  // open: keep a descriptor when EITHER side is unresolvable (nothing that
  // showed before this fix can vanish); exclude it ONLY when BOTH resolve AND
  // differ.
  // appArchivedCache() — the supervisor-written app-side archive snapshot, read
  // ONCE per hook invocation (ONE small fs read for N descriptors) and reused
  // for every row. Freshness is applied inside readArchivedCache: a stale/
  // missing/malformed file yields an EMPTY map, so this can only ever suppress
  // on evidence that is currently valid.
  let appArchivedCacheMemo;
  function appArchivedCache() {
    if (appArchivedCacheMemo === undefined) {
      try { appArchivedCacheMemo = readArchivedCache({ home, env: process.env }); }
      catch (_) { appArchivedCacheMemo = null; }
    }
    return appArchivedCacheMemo;
  }
  const repoKeyCache = new Map(); // worktreePath -> repoKey | null
  repoKeyCache.set(cwd, selfKey); // seed with the already-resolved key for `cwd`
  function repoKeyOfWorktree(wt) {
    if (!wt) return null;
    if (repoKeyCache.has(wt)) return repoKeyCache.get(wt);
    let k = null;
    try { k = repokeyMod ? repokeyMod.repoKeyForWorktree(wt) : null; } catch (_) { k = null; }
    repoKeyCache.set(wt, k);
    return k;
  }
  // registeredRepoKeyOf(d) (defect e586afdaa968) — THE SHARED definition, from
  // companion/lib/devswarm-repokey.js, so this hook and scripts/devswarm.js can
  // never disagree about which project an id is registered under (they did:
  // this file fell back to `repoKey` only, the CLI fell back `repoKey` ->
  // `ownerKey`, and `rehomeCore` emits descriptors carrying ONLY an ownerKey —
  // so an ownerKey-only descriptor read as "no project" here and as "project X"
  // there). `resolveFresh` injects the memoized per-worktreePath resolver above
  // so this never re-spawns git for a worktree already resolved this Stop.
  // Fail-open (null) when the descriptor names no project at all.
  function registeredRepoKeyOf(d) {
    if (!repokeyMod || typeof repokeyMod.registeredRepoKey !== 'function') return null;
    try { return repokeyMod.registeredRepoKey(d, d && d.id, { resolveFresh: repoKeyOfWorktree }); }
    catch (_) { return null; }
  }
  for (const d of descriptors) {
    // ---- CROSS-PROJECT HANDLING (defect e586afdaa968, P1) ----
    // Two DIFFERENT facts, deliberately given two DIFFERENT treatments:
    //
    //  * `freshKey` — the descriptor's worktree resolves, right now, to a
    //    project. That is a live filesystem fact and the ONLY basis on which a
    //    descriptor is DROPPED from this gate (unchanged #36 behavior).
    //
    //  * `registeredKey` with NO fresh key — the worktree is gone/moved and all
    //    we have is the PERSISTED key. An intermediate revision of this fix
    //    dropped these rows too. That was wrong and hid real work: `repoKey` is
    //    a store-PARTITION fact, while `realUnread` below is counted from the
    //    descriptor's NDJSON inbox — which is id-derived and partition-
    //    INDEPENDENT, and which `devswarm.js inbox read <id>` returns from ANY
    //    cwd (verified live). Dropping the row turned "the Primary is nagged
    //    about mail it cannot drain" into "the Primary is never told about mail
    //    it CAN drain" — a strictly worse failure. Worse still, `repoKey` is
    //    only ever (re)written while the worktree still resolves, so once it
    //    stops the stale key can never be refreshed and the row would vanish
    //    permanently.
    //    So the row is KEPT and DOWNGRADED instead: the NDJSON (drainable) axis
    //    still gates, but the two axes that are genuinely NOT actionable from
    //    here are suppressed — the store-partition union (that partition is the
    //    other project's) and the liveness stale/escalated verdict (recovering
    //    another project's wedged child is not this Primary's to do) — and the
    //    remediation names `inbox read <id>`, which works, instead of
    //    `inbox peek-primary <id>`, which the CLI refuses outright.
    const freshKey = selfKey ? repoKeyOfWorktree(d && d.worktreePath) : null;
    if (selfKey && freshKey && freshKey !== selfKey) continue;
    const registeredKey = (selfKey && !freshKey) ? registeredRepoKeyOf(d) : freshKey;
    const foreignProject = !!(selfKey && !freshKey && registeredKey && registeredKey !== selfKey);
    const dKey = freshKey;

    // realUnread (P0 fix): count only unread rows classified REAL — excludes
    // system-generated poke/mirror noise (isNoiseText — see the require
    // above). A workspace whose unread is ALL noise (a "ghost" repeatedly
    // poked by this same gate, whose only "unread" is that poke bouncing
    // back) no longer nags.
    //
    // FAIL-OPEN TO BLOCK (Codex P0 #2): unknown/unreadable beats silently
    // dropping a real neglect signal.
    //   - a row that fails to parse (malformed JSON / non-object) -> counts
    //     toward realUnread (never assumed noise).
    //   - `known:false` (cursor/inbox not conclusively readable) -> blocks. A
    //     corrupt cursor, an unreadable inbox behind a real file, or an
    //     absent inbox must never read as "0 unread". This does NOT nag a
    //     freshly-registered child: scripts/devswarm.js's register now
    //     precreates an EMPTY inbox file (alongside the cursor), so "just
    //     registered, never messaged" reads as known:true/0-unread
    //     (confirmed-empty), not known:false. An absent inbox is therefore
    //     normally a genuine anomaly (a pre-fix legacy child, or a failed
    //     inbox write) that must not be silently swallowed.
    //
    //     ONE REFINEMENT (this comment previously read "INCLUDING an absent
    //     inbox file -> ALWAYS blocks, unconditionally, per spec" — that
    //     absolute WAS the defect, and a stale comment asserting it next to
    //     code that no longer does would be its own defect):
    //     `inbox-missing` (ENOENT, and ONLY ENOENT) on a descriptor whose
    //     `worktreePath` is ALSO gone from disk does NOT set unreadUnknown.
    //     WHY: that conjunction is not neglect, it is a DEAD DESCRIPTOR — the
    //     workspace is physically gone, so the unknown axis is UN-CLEARABLE by
    //     construction. There is no inbox to read, no child to poke, and no
    //     acknowledgement the Primary can perform that would ever retire it,
    //     so it blocked EVERY turn, permanently. The original spec conflated
    //     "anomaly worth blocking on" with "workspace physically gone".
    //     NOTHING IS HIDDEN BY THIS: only the UN-CLEARABLE axis stops firing.
    //     The other two axes are untouched — a gone worktree that still has
    //     STORE-side unread still blocks on `unionUnread`, and a stale/
    //     escalated verdict still blocks on `staleOrEscalated`.
    //     STRICTLY SCOPED, FAIL-CLOSED-TO-BLOCK: any OTHER reason
    //     (inbox-unreadable/EACCES/EISDIR, cursor-*, no-inbox-path,
    //     read-threw) still blocks regardless of the worktree, and the
    //     worktree is treated as GONE only on a definitive ENOENT stat — a
    //     missing/empty worktreePath, or a stat failing for ANY other reason
    //     (EACCES, EIO), is NOT provably gone and therefore still blocks.
    // Only a row that PARSES and whose message text POSITIVELY matches the
    // noise marker is excluded — everything else (including an ambiguous
    // parsed row with no recognizable text field) counts as real.
    let realUnread = 0;
    let unreadUnknown = false;
    // unreadReason/unreadReasonPath/unreadReasonErrno (regression fix — see
    // this file's own d1c8625 identity-family-collapse note below): a bare
    // `unreadUnknown` boolean gave no way to tell a malformed/phantom
    // descriptor (no inboxPath at all) apart from a genuinely missing or
    // unreadable inbox/cursor file. Carried per-member so the family reduce
    // step below can name WHICH descriptor failed and WHY, instead of a
    // single generic "inbox unreadable" blamed on the family survivor.
    let unreadReason = null;
    let unreadReasonPath = null;
    let unreadReasonErrno = null;
    // deadDescriptor: the un-clearable-axis rule below fired for this row (ENOENT
    // inbox AND a gone worktree). Carried out of the try so the UNION guard can
    // widen for exactly this row — see its own note there.
    let deadDescriptor = false;
    try {
      const u = readUnreadMessages(d.inboxPath, d.cursorPath);
      if (!u || !u.known) {
        const reason = (u && u.reason) || 'unknown';
        // UN-CLEARABLE-AXIS RULE — see the design note above. ENOENT inbox AND a
        // gone worktree = a dead descriptor, not neglect: do not raise the
        // unknown axis. Every other axis (unionUnread, staleOrEscalated) is
        // untouched, so nothing is silently hidden.
        if (reason === 'inbox-missing' && worktreeIsGone(d.worktreePath)) {
          deadDescriptor = true;
          // realUnread stays 0 and unreadUnknown stays false; the row survives
          // into the family reduce and still blocks if another axis fires.
        } else if (reason === 'inbox-missing' && !foreignProject) {
          // A2 FIX — LIVE-TEARDOWN WINDOW. worktreeIsGone(d.worktreePath) is
          // FALSE here (the branch above didn't fire): the worktree still
          // EXISTS on disk, so this is NOT a dead descriptor — most likely a
          // mid-teardown or pre-first-message window where the native NDJSON
          // inbox hasn't been (re)written yet. The v0.85.0 fix only covered
          // the dead-descriptor half; this is the other half. Before
          // surrendering to the unknown axis, ask the STORE — the actual
          // source of delivery truth (storeSeq) — whether it can answer
          // conclusively. STRICTLY ENOENT-SCOPED: only the literal
          // `reason === 'inbox-missing'` string reaches this branch;
          // inbox-unreadable/EACCES/EISDIR/ENOTDIR/no-inbox-path/cursor-* all
          // still fall to the `else` below and fail closed exactly as before.
          // `foreignProject` is checked BEFORE attempting the store open — an
          // inbox-missing row on a foreign project's descriptor must never
          // open that other project's store partition (keeps the v0.84.0
          // cross-project-read closure intact); it falls to the `else` below
          // and fails closed, same as an unresolvable store.
          //
          // REAL-HISTORY GUARD (regression caught while writing THIS fix's own
          // tests — pinned by "FAIL-OPEN (P0-2, REAL registration path): a real
          // child whose inbox file is later REMOVED still BLOCKS
          // unconditionally"). `storeMod.openStore` ALWAYS `mkdirSync`s the
          // project's store dir and creates `devswarm.db` on first open
          // (devswarm-store.js openSqlite) — AND the real per-turn registration
          // path (devswarm-child-turn.js) already opens/closes that SAME
          // project-wide store on every child's very first turn (an
          // `upsertRegistry` write, unrelated to messages). So checking merely
          // "does the store partition dir exist" is NOT a reliable "was this
          // conclusively drained" signal — it is true for nearly every real
          // project immediately after ANY workspace registers, message or not.
          // The actual discriminator this fix's own incident narrative (storeSeq
          // 27107-27109) rests on is REAL MESSAGE HISTORY: `cursorValue(id) ===
          // messageCount(id)` is ONLY conclusive when `messageCount(id) > 0` —
          // i.e. the store has actually recorded and fully drained at least one
          // message for THIS workspace, EITHER unread or already drained. A
          // workspace the store has never recorded ANY message for
          // (messageCount === 0, the untouched-registration case) is NOT
          // evidence of "nothing pending" — it is simply "the store never saw
          // this id do anything", indistinguishable from a store that was
          // never asked, and per the governing "when in doubt, keep blocking"
          // constraint must NOT clear the unknown axis. Real (nonzero) history
          // that is STILL unread is equally conclusive — it flows through the
          // UNION block below and blocks on the realUnread axis instead.
          let storeConclusive = false;
          try {
            const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: d.worktreePath, id: d.id, home, env: process.env, repoKey: freshKey });
            if (storeHandle) {
              try {
                // Both calls throw if the store cannot actually answer (corrupt
                // DB, unreadable partition, etc.) — that failure is caught below
                // and falls through to the unknown axis, same as today.
                storeHandle.cursorValue(d.id);
                const allRows = storeHandle.listMessages(d.id);
                storeConclusive = allRows.length > 0;
              } finally {
                try { storeHandle.close(); } catch (_) {}
              }
            }
          } catch (_) { storeConclusive = false; }
          if (storeConclusive) {
            // Store answered conclusively -> unreadUnknown stays false. Do NOT
            // increment realUnread here: the UNION block below (unchanged)
            // resolves `unionKey` to this SAME `freshKey` (dKey) since
            // unreadUnknown is now false and foreignProject is false, and opens
            // its own store handle there to compute realUnread from
            // storeOnlyUnreadRows with the identical noise + own-sender
            // filtering every other descriptor already gets — never duplicated
            // here.
          } else {
            // Store ALSO unreadable -> genuinely unknown; fail closed exactly
            // as before this fix.
            unreadUnknown = true;
            unreadReason = reason;
            unreadReasonPath = (u && u.path) || null;
            unreadReasonErrno = (u && u.errno) || null;
          }
        } else {
          unreadUnknown = true;
          unreadReason = reason;
          unreadReasonPath = (u && u.path) || null;
          unreadReasonErrno = (u && u.errno) || null;
        }
      } else {
        for (const row of u.rows) {
          if (row === null) { realUnread++; continue; } // unparseable -> fail open (real)
          if (isNoiseText(row.message)) continue; // positively-classified noise -> excluded
          realUnread++;
        }
      }
    } catch (_) {
      unreadUnknown = true; // hard failure reading the primitive itself -> fail open
      unreadReason = 'read-threw';
    }

    // UNION (root cause b fix): a mesh-direct `send --to` is STORE-ONLY (see
    // companion/lib/devswarm-unread.js's header) — the NDJSON-only read above
    // is blind to it. `dKey` is ALREADY resolved (the #36 structural filter
    // just above), so reuse it rather than re-spawning git. Only attempted
    // when dKey resolved AND the NDJSON side was conclusively readable (an
    // unreadUnknown row already blocks unconditionally — no need to also
    // union it). LAZY + GUARDED, fail-open: never turns a passing row newly
    // unknown/blocking, only ADDS store-only real rows already excluded by
    // the same isNoiseText check applied to their `.body`.
    //
    // OUTBOUND-NOT-NEGLECT fix (root cause a — live incident, storeSeq
    // 27107-27109): `union.storeOnlyUnreadRows` is this CHILD descriptor's
    // OWN mailbox partition (workspace_id === recipient === d.id, see
    // devswarm-store.js appendMeshMessage's D3 wire-contract comment) — a row
    // this Primary itself just sent via `send --to <childId>` lands here with
    // `sender === own.id` and is awaiting the CHILD's read, not this Primary's.
    // Counting it as parent neglect flagged the Primary for its own outbound
    // send within seconds of sending it. Exclude any row whose `sender`
    // matches this Primary's own workspace id (`own.id`, already resolved
    // above via readOwnUnread/#34) — a row with no resolvable sender (absent/
    // malformed) still counts as real (fail-open toward blocking, unchanged).
    // UNION KEY (dead-descriptor widening — NOTHING IS SILENTLY HIDDEN). `dKey`
    // is `freshKey`, and freshKey is by DEFINITION null for a gone worktree
    // (repoKeyOfWorktree spawns git against a path that no longer exists), so
    // without this the union axis is structurally unreachable on exactly the rows
    // the un-clearable-axis rule above just stopped blocking on — the store-side
    // backlog of a removed workspace would go from "nagged about generically,
    // forever" to "never mentioned at all". Live evidence: the descriptor that
    // motivated this fix has 11 real store-side rows.
    // So for THAT row and only that row, fall back to the PERSISTED key
    // (`registeredKey`), which is the only key still knowable once the worktree
    // is gone. This can only ever ADD blocking — `foreignProject` still gates it
    // (another project's partition is not this Primary's to drain), and every
    // other row keeps using `dKey` exactly as before.
    const unionKey = dKey || (deadDescriptor ? registeredKey : null);
    if (!unreadUnknown && unionKey && !foreignProject) {
      try {
        // `repoKey: dKey` reuses the ALREADY-RESOLVED (memoized, above) repoKey
        // for this descriptor's worktree instead of letting openStoreForUnread
        // re-spawn git for the SAME worktree a second time this Stop invocation.
        const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: d.worktreePath, id: d.id, home, env: process.env, repoKey: unionKey });
        if (storeHandle) {
          try {
            const union = devswarmUnread.unionUnread({ inboxPath: d.inboxPath, cursorPath: d.cursorPath, id: d.id, storeHandle });
            for (const row of union.storeOnlyUnreadRows) {
              if (isNoiseText(row && row.body)) continue;
              // This Primary's own outbound send, sitting in the recipient's
              // mailbox awaiting THEIR read — not parent neglect.
              if (own.id && row && row.sender != null && String(row.sender) === String(own.id)) continue;
              realUnread++;
            }
          } finally {
            try { storeHandle.close(); } catch (_) {}
          }
        }
      } catch (_) { /* fail-open: NDJSON-only realUnread stands */ }
    }

    const verdict = foreignProject ? null : readVerdict(d.id, home);
    const status = verdict ? verdict.status : '';
    let staleOrEscalated = status === 'stale' || status === 'escalated';
    // A1 fix: carried forward per-member (OR'd at the family loop below,
    // alongside unreadUnknown) as one of the four corroborating axes a
    // stale/escalated STATUS needs before it can drive a hard block.
    const verdictPending = !!(verdict && verdict.pending);
    // v0.62 heartbeat-alive decouple (owner-approved — see liveness.js header): a
    // FRESH heartbeat is definitive proof the env is ALIVE (emitted only by the
    // workspace's OWN live session), so it must NOT be nudged as gone/stale/
    // escalated. Suppress ONLY the liveness axis — a live, heartbeating workspace
    // with REAL unread still gates (that is genuine coordination neglect, a
    // separate axis), so realUnread/unreadUnknown are untouched here. A single
    // cheap fs read (heartbeats/<id>.json), no git/computeLiveness/store-DB open,
    // so the Stop hook's cheap-read budget is preserved. Fail-open: if the read
    // throws, staleOrEscalated is left as-is (never silently un-blocks a wedge).
    if (staleOrEscalated) {
      try { if (hasFreshHeartbeat(d.id, home)) staleOrEscalated = false; } catch (_) {}
    }
    // DEFECT 0ace80dff415 (P1) — see isArchiveReadyFor's header. Suppress ONLY
    // the liveness axis, same scoping discipline as the heartbeat check just
    // above: a done-but-still-mailing child would be an odd shape, but if it
    // ever happens realUnread/unreadUnknown are untouched and still gate.
    if (staleOrEscalated) {
      try { if (isArchiveReadyFor(d.id, dKey, home)) staleOrEscalated = false; } catch (_) {}
    }
    // DEFECT 699a236129c5 (P1) — SESSION-SOURCED LIVENESS. Same scoping
    // discipline as the two suppressors above: a row whose sessionId maps to a
    // RUNNING harness process (companion/lib/liveness.js sessionPidAlive — a
    // live pid, not a timestamp) is `idle (alive)`, not gone. Every axis the
    // stale/escalated verdict is built from is an ACTIVITY timestamp, and all
    // of them go quiet for an interactive Primary sitting at its prompt; past
    // the window that read as dead and escalated a session the operator was
    // looking straight at. Liveness axis ONLY — realUnread/unreadUnknown are
    // untouched, so a live-but-idle workspace with REAL unread still gates
    // (that is coordination neglect, a separate axis). Fail-soft: no session
    // file, a dead pid, or an unreadable sessions dir leaves the verdict as-is.
    let idleAlive = false;
    if (d.sessionId) {
      try { idleAlive = isSessionAliveRow({ sessionId: d.sessionId }, home); } catch (_) { idleAlive = false; }
    }
    if (staleOrEscalated && idleAlive) staleOrEscalated = false;
    // FIELD (archived rows still alerting): a workspace the owner already
    // ARCHIVED is done and put away — it must never render as escalated /
    // not-draining. Liveness axis ONLY, same as every suppressor above; the row
    // is still LISTED (under `archived`), never hidden. `isArchivedWorkspace`
    // is fail-closed and strict (archived record present AND the archived
    // record's OWN worktreePath names THIS worktree) — it does NOT require the
    // active descriptor to be gone (that stricter condition is
    // `isArchivedOnlyWorkspace`'s, a different predicate for a different,
    // mutating caller — see devswarm-archived.js's header, which is explicit
    // that requiring the active descriptor gone here would make this check
    // unreachable, since this caller classifies rows FROM readDescriptors,
    // which by construction only yields ids whose active descriptor still
    // exists). See that module's header for why archived/<id>.json alone
    // (without the worktreePath match) is not proof either.
    let archived = false;
    try { archived = isArchivedWorkspace(home, d.id, d.worktreePath); } catch (_) { archived = false; }
    if (archived) staleOrEscalated = false;
    // FIELD (owner archived children in the DevSwarm APP): the app never calls
    // anti-hall's `archive` verb, so `archived/<id>.json` is never written and
    // the check above stays false forever — those rows kept escalating. The
    // supervisor's reconcile sweep caches the app's own view; this reads that
    // cache ONLY (never a hivecontrol spawn on this every-turn Stop path) and
    // believes it ONLY while it is FRESH (a stale cache suppresses nothing —
    // see devswarm-archived-cache.js). Liveness axis ONLY, same scoping as every
    // suppressor above: realUnread/unreadUnknown are untouched, so an
    // app-archived row with REAL unread still gates.
    let appArchived = false;
    try { appArchived = isAppArchived({ home, repoKey: dKey, id: d.id, env: process.env, cache: appArchivedCache() }); }
    catch (_) { appArchived = false; }
    if (appArchived) staleOrEscalated = false;

    // Pushed UNCONDITIONALLY (not gated on unreadUnknown/realUnread/
    // staleOrEscalated here) — the gate is applied ONCE per FAMILY after the
    // collapse below, so a family with one blocking member and one quiet
    // twin still blocks (and the quiet twin's 0/false contributes nothing to
    // the union either way).
    rawEntries.push({
      id: String(d.id),
      worktreePath: d.worktreePath,
      // sessionId (defect 773e3e0c7e59, P1): carried through from the raw
      // descriptor so the identity-family merge below can run
      // `crossLinkedIdentity` against the Primary's own synthetic self-row —
      // without it, a same-worktree UUID twin registered under a different id
      // could never be detected as cross-linked here, since this was the ONLY
      // shape rawEntries pushed for a descriptor (own's synthetic self-row has
      // no sessionId of its own; the LINK lives on the twin descriptor side).
      sessionId: d.sessionId != null ? String(d.sessionId) : null,
      realUnread,
      unreadUnknown,
      unreadReason,
      unreadReasonPath,
      unreadReasonErrno,
      staleOrEscalated,
      // idleAlive / archived: REPORT-ONLY provenance for the two new
      // suppressors above, so a reader can tell "not alerting because the
      // session is provably running" and "not alerting because it is archived"
      // apart from "never had a stale verdict at all".
      idleAlive,
      archived,
      // appArchived: REPORT-ONLY provenance, same purpose as `archived` above —
      // "not alerting because the DevSwarm app itself says this workspace is
      // archived (per a FRESH supervisor-written cache)".
      appArchived,
      status: staleOrEscalated ? status : '',
      verdictPending,
      urgencyMax: null,
      foreignProject,
    });
  }

  // Collapse rawEntries into identity families and reduce each family to ONE
  // blocking entry (union realUnread, OR unreadUnknown, OR staleOrEscalated).
  // `resolveMeshId` reuses `canonicalMeshId` (scripts/devswarm.js) — the SAME
  // derivation the store-layer fold already uses, NOT a fourth reimplementation
  // — memoized per distinct worktreePath so N rawEntries sharing one worktree
  // never re-spawn git more than once each (mirrors `repoKeyOfWorktree` above).
  // Fail-open (outer try/catch): if collapsing throws for any reason, fall back
  // to today's one-row-per-descriptor behavior rather than blocking or crashing.
  let families;
  try {
    const identityFamily = require('../companion/lib/devswarm-identity-family.js');
    const devswarmCli = require('../scripts/devswarm.js'); // lazy: side-effect-free (guarded by require.main===module), see scripts/devswarm.js's own precedent for lazy self-requires
    const meshIdCache = new Map(); // worktreePath -> canonicalMeshId | null
    const resolveMeshId = (wt) => {
      if (meshIdCache.has(wt)) return meshIdCache.get(wt);
      let k = null;
      try { k = devswarmCli.canonicalMeshId(wt); } catch (_) { k = null; }
      meshIdCache.set(wt, k);
      return k;
    };
    families = identityFamily.collapseFamilies(rawEntries, { resolve: resolveMeshId });

    // DEFECT 773e3e0c7e59 (P1): collapseFamilies groups strictly by resolved
    // worktree (canonicalMeshId) or falls back to an id-only key when the
    // worktree cannot be resolved/matched to the self row's — so the
    // Primary's OWN identity family (a same-worktree UUID twin descriptor
    // registered under a DIFFERENT id than `own.id`, e.g. because its
    // worktreePath is relative/missing/resolves differently) can survive as
    // its OWN separate family instead of collapsing with the self row. That
    // separate family's survivor id then differs from `own.id`, so the
    // label/branch logic below (buildReason) reports it as a neglected CHILD
    // workspace (URGENT child alert) instead of the Primary's own mailbox.
    // `crossLinkedIdentity` (identity-family.js) is the STRONGER, unambiguous
    // same-identity predicate already used for the mutating archive path (one
    // row's sessionId IS the other row's id) — reused here, read-only, to
    // fold any family containing a member cross-linked to the self row into
    // the self row's own family. The block itself is KEPT (the twin's mail is
    // still real and the Primary must still drain it — see the ownEntry
    // branch in buildReason); only the reported branch and the URGENT/child
    // tier change. `mergedTwinIds` records the folded-in member ids (all
    // members of the merged twin family EXCEPT the self row itself) so
    // buildReason can still name the actual twin id(s) in its drain hint
    // instead of silently absorbing them into `own.id`'s count with no trace.
    const selfEntry = own.id ? rawEntries.find((e) => e.id === own.id) : null;
    if (selfEntry) {
      const selfFamilyIdx = families.findIndex((f) => f.members.indexOf(selfEntry) !== -1);
      if (selfFamilyIdx !== -1) {
        const selfFamily = families[selfFamilyIdx];
        const keptFamilies = [selfFamily];
        for (let i = 0; i < families.length; i++) {
          if (i === selfFamilyIdx) continue;
          const fam = families[i];
          const isTwinFamily = fam.members.some((m) => identityFamily.crossLinkedIdentity(selfEntry, m));
          if (!isTwinFamily) { keptFamilies.push(fam); continue; }
          if (!Array.isArray(selfFamily.mergedTwinIds)) selfFamily.mergedTwinIds = [];
          for (const m of fam.members) {
            if (selfFamily.members.indexOf(m) === -1) selfFamily.members.push(m);
            if (m !== selfEntry) selfFamily.mergedTwinIds.push(String(m.id));
          }
        }
        // Force the merged family's survivor back to the self row so it is
        // still reported under `own.id` (the "(you)" branch), regardless of
        // whichever member collapseFamilies' own sort would otherwise pick.
        selfFamily.survivor = selfEntry;
        families = keptFamilies;
      }
    }
  } catch (_) {
    // Fall back to one family per rawEntry (== today's uncollapsed behavior).
    families = rawEntries.map((e) => ({ key: 'id:' + e.id, members: [e], survivor: e }));
  }

  const blocking = [];
  for (const fam of families) {
    const members = (fam && fam.members) || [];
    let unionUnread = 0;
    let unreadUnknown = false;
    let staleOrEscalated = false;
    let verdictPending = false;
    let status = '';
    let urgencyMax = null;
    // unknownMembers (regression fix, d1c8625): the family-wide `unreadUnknown`
    // OR is still computed as before (a family with ANY unreadable member
    // still blocks), but WHICH member(s) actually failed — and why — is now
    // carried alongside it, so the label built below can name the real
    // culprit instead of blaming the survivor id for a DIFFERENT member's
    // read failure.
    const unknownMembers = [];
    // foreignProject (defect e586afdaa968, P1): true only when EVERY member of
    // this family is a foreign-project row. A family with even one member in
    // THIS project is a normal local row — the ordinary remediation applies and
    // must not be weakened.
    let foreignProject = members.length > 0;
    // worktreeGone (defect 45cf1659f54f, P2 re-scope): true when ANY member's
    // worktreePath is CONFIRMED absent from disk via the existing, fail-closed
    // `worktreeIsGone` check (ENOENT-only; a transient/other stat error never
    // sets this — see that function's header). This does NOT change any
    // blocking decision — a gone-worktree row's mail is still real and still
    // drainable, from outside that worktree, via `inbox ack <id>
    // --ack-as-owner` (verified end-to-end; a plain `inbox read <id>` does
    // NOT clear it — see buildReason()'s worktreeGoneChildren comment for the
    // full trace), so it must keep blocking exactly as before. This flag only
    // drives an ADDITIONAL hint line in buildReason() telling the Primary the
    // clearing command, since a gone worktree means the ordinary
    // "peek-primary"/cd-in workflow is unrunnable and the block previously
    // looked unclearable.
    let worktreeGone = false;
    for (const m of members) {
      unionUnread += Number.isFinite(m.realUnread) ? m.realUnread : 0;
      if (worktreeIsGone(m.worktreePath)) worktreeGone = true;
      if (m.unreadUnknown) {
        unreadUnknown = true;
        unknownMembers.push({
          id: m.id != null ? String(m.id) : null,
          reason: m.unreadReason || 'unknown',
          path: m.unreadReasonPath || null,
          errno: m.unreadReasonErrno || null,
        });
      }
      if (m.staleOrEscalated) { staleOrEscalated = true; if (m.status) status = m.status; }
      if (m.verdictPending) verdictPending = true;
      if (m.urgencyMax != null) urgencyMax = m.urgencyMax;
      if (!m.foreignProject) foreignProject = false;
    }
    // A1 CORROBORATION (owner's governing constraint: fix the misclassification,
    // never the alarm — a status-only `stale`/`escalated` must never drive a hard
    // block by itself). `staleOrEscalated` alone is corroborated ONLY by an OR of
    // FOUR independent axes:
    //   1. verdictPending    — the verdict file's OWN `pending` flag (any member).
    //   2. unionUnread > 0   — this family's REAL union-unread backlog.
    //   3. unreadUnknown     — a member's unread axis could not be read at all
    //                          (fail-open toward blocking, never toward silence).
    //   4. an unanswered question FROM one of this family's own member ids.
    // This set MUST stay an OR — narrowing it (e.g. to `unread > 0` alone) would
    // drop a genuinely wedged child holding an unanswered question with an
    // otherwise-drained mailbox. Uncorroborated -> ONE-TIME advisory line on
    // stderr (never on the stdout decision channel), NOT a hard block; the
    // family still blocks normally on any other real axis (unionUnread/
    // unreadUnknown) it may separately carry.
    if (staleOrEscalated) {
      const memberIdSet = new Set(members.map((m) => (m && m.id != null ? String(m.id) : null)).filter(Boolean));
      const familyHasUnansweredQuestion = unanswered.some((q) => q && q.from != null && memberIdSet.has(String(q.from)));
      const corroborated = verdictPending || unionUnread > 0 || unreadUnknown || familyHasUnansweredQuestion;
      if (!corroborated) {
        try {
          const advisoryId = (fam && fam.survivor && fam.survivor.id != null) ? String(fam.survivor.id) : (members[0] && members[0].id);
          fs.writeSync(2, 'anti-hall: workspace ' + advisoryId + ' verdict is \'' + status
            + '\' but uncorroborated (no pending unread, no unanswered question) — not blocking\n');
        } catch (_) {}
        staleOrEscalated = false;
        status = '';
      }
    }
    if (!(unreadUnknown || unionUnread > 0 || staleOrEscalated)) continue; // this family has nothing to report
    const survivor = fam && fam.survivor;
    const survivorId = survivor && survivor.id != null ? String(survivor.id) : (members[0] && members[0].id != null ? String(members[0].id) : null);
    if (!survivorId) continue;
    const entry = { id: survivorId, unread: unionUnread, unknown: unreadUnknown, status };
    if (foreignProject) entry.foreignProject = true;
    if (worktreeGone) entry.worktreeGone = true;
    if (urgencyMax != null) entry.urgencyMax = urgencyMax;
    if (unknownMembers.length) entry.unknownMembers = unknownMembers;
    if (Array.isArray(fam.mergedTwinIds) && fam.mergedTwinIds.length) entry.mergedTwinIds = fam.mergedTwinIds;
    blocking.push(entry);
  }

  const stateFile = stateFileFor(payload.session_id, home);

  // Nothing neglected AND no unanswered question AND no truncation -> clear
  // any prior loop-state and stay quiet. An unanswered question (requirement
  // C) must never be silenced by this path either — structurally this should
  // already be covered by `own.unread > 0` above (a pendingQuestion is itself
  // an unread row), but the `unanswered.length` check here is kept as an
  // explicit belt-and-suspenders guard so a future/edge-case divergence
  // between the two counts can never silently drop a real unanswered
  // question. `truncated` gets the same treatment (P2 fix): it names a set
  // of questions this Primary structurally CANNOT see, so it must never be
  // waved through just because the visible `blocking`/`unanswered` happen to
  // be empty this pass.
  if (blocking.length === 0 && unanswered.length === 0 && !truncated) {
    try { fs.unlinkSync(stateFile); } catch (_) {}
    return;
  }

  // Signature of the blocking SET. The cap RESETS whenever this changes (P1: cap
  // resets when the unread SET changes). Includes unread counts, the unknown
  // flag, AND verdict status so a new message, a fresh stale/escalation, an
  // inbox becoming (un)readable, or a partial ack all re-open the small budget.
  const sig = crypto.createHash('sha1').update(
    blocking
      .map((b) => b.id + '\x00' + b.unread + '\x00' + (b.unknown ? '1' : '0') + '\x00' + b.status)
      .sort()
      .join('\x1f')
  ).digest('hex');

  // Load prior loop-state { sig, blocks, escalated }.
  let lastSig = '';
  let blocks = 0;
  let escalated = false;
  let lastQSig = '';
  let qBlocks = 0;
  let qEscalated = false;
  let intents = {};
  let intentAcks = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
      blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
      escalated = parsed.escalated === true;
      lastQSig = typeof parsed.qSig === 'string' ? parsed.qSig : '';
      qBlocks = Number.isFinite(parsed.qBlocks) ? parsed.qBlocks : 0;
      qEscalated = parsed.qEscalated === true;
      // STATED-INTENT (additive, fail-open): a state file predating this
      // feature simply has no `intents` key -> defaults to `{}`, byte-for-
      // byte the old no-intent behavior. A malformed `intents` (non-object,
      // array, ...) is treated the same as absent rather than thrown on.
      if (parsed.intents && typeof parsed.intents === 'object' && !Array.isArray(parsed.intents)) {
        intents = parsed.intents;
      }
      intentAcks = Number.isFinite(parsed.intentAcks) ? parsed.intentAcks : 0;
    }
  } catch (_) { /* first time / cleared / corrupt -> fail-open, behaves exactly as pre-intent */ }

  // hasIntent: true only when an explicit intent was recorded for THIS EXACT
  // blocking signature (via `devswarm.js gate-intent --reason "..."`) — keyed
  // by `sig` itself, so a sig change (new unread, new workspace, status
  // change) automatically drops out of scope with no separate "is this
  // stale" check needed: a DIFFERENT sig simply never has a matching key.
  // `nextIntents` is the pruned map persisted below — carries forward ONLY
  // the current sig's entry (if any), so the file can never accumulate a
  // history of stale per-sig intents across a long session.
  const hasIntent = !!(intents && Object.prototype.hasOwnProperty.call(intents, sig));
  const nextIntents = hasIntent ? { [sig]: intents[sig] } : {};

  // Per-SET cap: the counter AND the escalated flag are only meaningful while
  // the set is unchanged — a new blocking-set signature gets a fresh budget
  // AND a fresh escalation opportunity (mirrors the existing blocks reset).
  const effectiveBlocks = sig === lastSig ? blocks : 0;
  const effectiveEscalated = sig === lastSig ? escalated : false;
  const effectiveIntentAcks = sig === lastSig ? intentAcks : 0;
  const cap = resolveCap(process.env);
  // ABSOLUTE BACKSTOP (see INTENT_ABSOLUTE_MULTIPLIER's header): the cap a
  // stated-intent pass is measured against instead of the plain `cap` — never
  // unbounded, just a larger, still-finite budget.
  const absoluteCap = cap * INTENT_ABSOLUTE_MULTIPLIER;

  // CAP BYPASS (requirement C) + ESCALATION-NOT-SILENCE (requirement D).
  //   - unanswered.length > 0 OR truncated: the cap NEVER silences this pass —
  //     always block, unconditionally. `truncated` joins `unanswered.length >
  //     0` in this bypass (P2 fix) for the same reason: it names questions
  //     this Primary structurally cannot see, so "we've already nagged about
  //     this N times" can never be a reason to stop — there is no way to
  //     confirm the hidden senders were ever addressed. The per-signature
  //     `blocks` counter still advances normally underneath (bookkeeping/
  //     telemetry for the OTHER, non-question blocking reasons), it just
  //     never causes a `return` here — and the `escalated` flag is left
  //     untouched (carried forward as-is): it belongs strictly to the plain-
  //     backlog axis below, so however long a bypass phase runs, it can never
  //     itself trip or clear escalation.
  //   - unanswered.length === 0 && !truncated (the only case the cap/
  //     escalation still governs): whether escalation has ALREADY fired for
  //     this exact, unchanged signature is tracked EXPLICITLY via the
  //     persisted `escalated` boolean (P0-C fix) — never re-derived from
  //     `effectiveBlocks === cap`. That arithmetic equality broke the moment
  //     a prior unanswered-question bypass phase pushed `blocks` past `cap`
  //     WITHOUT ever escalating (the bypass branch above always takes the
  //     `else`, so the exact-cap pass can be skipped over entirely) — the
  //     next unanswered.length===0 pass would then have effectiveBlocks > cap
  //     already and silently fall into the old "go quiet" branch, having
  //     never escalated at all.
  //       * effectiveEscalated -> already escalated once for this unchanged
  //         signature -> go quiet exactly as before.
  //       * !effectiveEscalated && effectiveBlocks >= cap -> the FIRST
  //         exhaustion pass for this signature — reached either by normal
  //         per-pass counting (effectiveBlocks === cap, the common case) or
  //         by a bypass-phase overshoot (effectiveBlocks > cap, the P0-C
  //         scenario) — emit ONE escalation-worded block, set
  //         `escalated = true`, and persist.
  //       * otherwise -> the normal, unexhausted forced-ack block.
  const bypassCap = unanswered.length > 0 || !!truncated;
  let nextBlocks;
  let nextEscalated = effectiveEscalated;
  let escalateTimes = null;
  let nextIntentAcks = effectiveIntentAcks;

  // QUESTION-SET ESCALATION CEILING (spec item 5 / C2): bound the unanswered
  // bypass — it exists precisely so a hidden/structurally-unclearable question
  // can never be silenced by the plain-backlog cap above, but that same
  // unconditional-block property means it must have ITS OWN bounded ceiling or
  // it refires forever. Keyed to a signature of the QUESTION SET itself (not
  // `sig`, which is the blocking-workspace set — a question can be pending with
  // an otherwise-empty blocking list), tracked independently of the
  // plain-backlog `blocks`/`escalated` pair above so the two axes can never
  // desync one another.
  //
  // `truncated` deliberately does NOT participate in this ceiling (unlike its
  // inclusion in `bypassCap` above): a truncation names an UNENUMERABLE set of
  // hidden senders — there is no way to ever confirm they were addressed, so
  // "we've nagged N times" can never be a legitimate reason to go quiet on it
  // the way it can for a concrete, individually-repliable question set. Only
  // genuine named `unanswered` entries (with `truncated` false) are eligible
  // for the ceiling; a pass where `truncated` is true always takes the
  // unconditional-block path below, exactly as before this fix, regardless of
  // `unanswered`'s own state.
  const qSig = crypto.createHash('sha1').update(
    unanswered
      .map((q) => (q && q.from != null ? String(q.from) : '') + '\x00' + (q && Number.isFinite(q.ts) ? q.ts : ''))
      .sort()
      .join('\x1f')
  ).digest('hex');
  const questionCeilingApplies = !truncated && unanswered.length > 0;
  const effectiveQBlocks = qSig === lastQSig ? qBlocks : 0;
  const effectiveQEscalated = qSig === lastQSig ? qEscalated : false;
  let nextQBlocks = effectiveQBlocks;
  let nextQEscalated = effectiveQEscalated;
  let qEscalateTimes = null;

  // IN-FLIGHT DRAIN MARKER (defect 13dedc334eb6, P2 — R11 Auditor A2 fix,
  // 2026-09): MOVED HERE, evaluated BEFORE any of the cap/escalation
  // arithmetic below and BEFORE the state persist. The pre-fix ordering
  // computed nextBlocks/nextEscalated (including bumping the per-signature
  // counter and, on the exhaustion pass, setting escalated:true) and
  // PERSISTED that incremented/escalated state UNCONDITIONALLY, only
  // consulting the drain marker afterward to decide whether the STDOUT
  // decision itself should be downgraded to a stderr notice. That meant a
  // drain turn — which is never real neglect, the Primary is already
  // actively reading its own mailbox — still burned budget from the cap and
  // could flip `escalated` to true while only ever emitting a stderr
  // notice; the very next Stop pass would then read `effectiveEscalated ===
  // true` and go silent forever (line "if (effectiveEscalated) return;"
  // below), even though no hard block had ever actually been surfaced to the
  // model. A downgraded turn must count for NOTHING against either the
  // plain-backlog cap or the question-set ceiling: it persists the SAME
  // `effectiveBlocks`/`effectiveEscalated` (and `effectiveQBlocks`/
  // `effectiveQEscalated`) it read in, unchanged, then emits the notice and
  // returns — never reaching the increment logic below at all.
  //
  // IDENTITY MATCH (R11 Reviewer item 2 + Critic iv): sessionId is now the
  // SOLE match. `pid` is no longer compared here — the Stop hook (this
  // process) and the CLI verb that calls markDrainStart (a separate `devswarm.js
  // inbox read-primary` child process) are DIFFERENT OS processes by
  // construction, so a marker's `pid` never legitimately equals
  // `process.pid` in the first place; worse, OS pid reuse inside the
  // marker's 10-minute TTL window means a stale marker's recorded pid can
  // coincide with an unrelated LATER process's pid purely by chance,
  // wrongly downgrading a real block. `pid` is still recorded in the marker
  // file (devswarm-drain-marker.js) and still returned by readDrainMarker,
  // but purely for human diagnostics now — never consulted for the gating
  // decision. BOTH sides of the sessionId comparison must be non-empty
  // strings: an empty-string session_id (or an empty-string marker.sessionId)
  // is treated the same as absent/null and can never match anything.
  let draining = false;
  try {
    const drainMarker = require('../companion/lib/devswarm-drain-marker.js');
    if (own.id) {
      const marker = drainMarker.readDrainMarker(home, own.id, { now: Date.now() });
      if (marker && !marker.stale) {
        draining = drainMarker.matchesSession(marker, payload && payload.session_id);
      } else if (marker && marker.stale) {
        try { drainMarker.clearDrainMarker(home, own.id); } catch (_) {}
      }
    }
  } catch (_) { draining = false; }

  if (draining) {
    // Persist UNCHANGED cap/escalation state — this turn consumes no budget
    // and can never itself trip escalation on either axis.
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        sig, blocks: effectiveBlocks, escalated: effectiveEscalated,
        qSig, qBlocks: effectiveQBlocks, qEscalated: effectiveQEscalated,
        intents: nextIntents, intentAcks: effectiveIntentAcks,
      }), 'utf8');
    } catch (_) { /* fail-open: best-effort persist, notice still fires this pass */ }
    try {
      const reason = buildReason(blocking, own.id, unanswered, null, truncated, null, hasIntent, !!own.unknown);
      fs.writeSync(2, 'anti-hall: ' + reason.split('\n')[0]
        + ' — not blocking (in-flight drain marker fresh for this session)\n');
    } catch (_) {}
    return;
  }

  if (!bypassCap) {
    if (effectiveEscalated) return; // already escalated once — go quiet
    nextBlocks = effectiveBlocks + 1;
    // STATED-INTENT: while an intent is on file for THIS EXACT sig, measure
    // against the larger `absoluteCap` instead of the normal `cap` — the
    // escalation branch is what's suppressed, never the block itself (the
    // block above/below this branch still fires every pass regardless).
    // `intentAcks` is bumped ONLY on a pass where the intent axis is actually
    // in play, so it visibly counts "acks covered by a stated reason"
    // distinctly from the plain `blocks` telemetry (which keeps counting
    // every pass either way, intent or not).
    const effectiveCap = hasIntent ? absoluteCap : cap;
    if (hasIntent) nextIntentAcks = effectiveIntentAcks + 1;
    if (effectiveBlocks >= effectiveCap) {
      escalateTimes = nextBlocks;
      nextEscalated = true;
    }
  } else {
    nextBlocks = effectiveBlocks + 1; // unchanged telemetry bump — bypass axis never silences on `blocks`/`escalated`
    if (questionCeilingApplies) {
      if (effectiveQEscalated) {
        // Already escalated once for this EXACT unchanged question set — go
        // quiet on the Stop-block loop. The question itself is untouched
        // (still live in computeSummary/pendingQuestions); only re-blocking
        // stops.
        try {
          fs.mkdirSync(path.dirname(stateFile), { recursive: true });
          fs.writeFileSync(stateFile, JSON.stringify({
            sig, blocks: nextBlocks, escalated: nextEscalated, qSig, qBlocks: effectiveQBlocks, qEscalated: true,
            intents: nextIntents, intentAcks: nextIntentAcks,
          }), 'utf8');
        } catch (_) { /* fail-open: best-effort persist, silence still holds this pass */ }
        return;
      }
      nextQBlocks = effectiveQBlocks + 1;
      if (effectiveQBlocks >= cap) {
        qEscalateTimes = nextQBlocks;
        nextQEscalated = true;
      }
    }
  }

  // Persist BEFORE blocking so the cap is honored even if the model re-stops with
  // the same set. Can't persist -> fail-open (skip the block to avoid any loop).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      sig, blocks: nextBlocks, escalated: nextEscalated, qSig, qBlocks: nextQBlocks, qEscalated: nextQEscalated,
      intents: nextIntents, intentAcks: nextIntentAcks,
    }), 'utf8');
  } catch (_) { return; }

  // WAKE RE-VERIFY (v0.59, reused not re-invented — see header): rides along on
  // this SAME forced block, bounded by the SAME per-SET cap above. Claude-only.
  const wakeLine = wakeReassertLine(process.env, false);

  const reason = buildReason(blocking, own.id, unanswered, escalateTimes, truncated, qEscalateTimes, hasIntent, !!own.unknown) + wakeLine;

  // IN-FLIGHT DRAIN MARKER: evaluated ABOVE now (before this persist), not
  // here — see the "R11 Auditor A2 fix" comment at that earlier call site for
  // why the ordering moved.

  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

// approxAge(ms) -> a short human-readable age string (minutes/hours/days),
// or 'unknown age' for a non-finite/negative input. Kept deliberately coarse
// (this is a nudge, not a precise clock) — mirrors the file's other terse,
// no-frills wording (e.g. buildReason's own unread/status bits).
function approxAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m ago';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

// buildUnansweredSegment(unanswered) -> the loudest/first segment of the reason
// body (§4.4 requirement C+D wording): names each still-unanswered question's
// asker + approximate age, and states explicitly that READING alone
// (`inbox read-primary`) does NOT clear it — the Primary must DECIDE from
// context and REPLY via `send --to <id>`. `q.from`/`q.ts` come from the
// summary projection's `pendingQuestions` (companion/lib/devswarm-store.js
// computeSummary) — `from` is now a REGISTRY ROW id (resolveSenderRegistryId
// normalizes it there), not necessarily the sender's raw meshId, though both
// work as a `send --to` target (resolveSendTarget); `ts` a numeric epoch-ms;
// either may be malformed on a fail-open path, so both are defensively
// coerced rather than trusted.
function buildUnansweredSegment(unanswered) {
  const now = Date.now();
  const items = unanswered.slice(0, 5).map((q) => {
    const from = q && q.from != null ? String(q.from) : 'unknown sender';
    const ts = q && Number.isFinite(q.ts) ? q.ts : NaN;
    return from + ' (' + approxAge(now - ts) + ')';
  }).join('; ');
  const more = unanswered.length > 5 ? ' (and ' + (unanswered.length - 5) + ' more)' : '';
  return (
    'UNANSWERED QUESTION' + (unanswered.length > 1 ? 'S' : '') + ' — ' + items + more + ': ' +
    'reading it via `inbox read-primary` is NOT sufficient to clear this. ' +
    'You must DECIDE from context and REPLY: `send --to <id> --message-file <path>` (or ' +
    '--message-stdin). '
  );
}

// buildTruncatedSegment(truncated) -> the loudest/first segment (alongside
// buildUnansweredSegment) naming a pendingQuestions TRUNCATION (P2 fix): the
// store's own backstop cap (devswarm-store.js DEFAULT_PENDING_QUESTIONS_CAP)
// bit, meaning some distinct senders' unanswered questions are NOT reflected
// in `unanswered` above at all — the true unanswered count is HIGHER than
// what this Primary can currently see. `truncated` is the store's own
// `{cap, kept, dropped}` object (see readOwnUnread) — `dropped` is how many
// DISTINCT SENDERS are missing, not how many messages. Defensively coerced
// (this hook must never throw on an unexpected shape from a fail-open path).
function buildTruncatedSegment(truncated) {
  const kept = Number.isFinite(truncated && truncated.kept) ? truncated.kept : '?';
  const dropped = Number.isFinite(truncated && truncated.dropped) ? truncated.dropped : '?';
  const cap = Number.isFinite(truncated && truncated.cap) ? truncated.cap : '?';
  return (
    'PENDING QUESTIONS LIST TRUNCATED — ' + kept + ' sender(s) shown, ' + dropped +
    ' more sender(s) with an unanswered question are NOT shown (cap ' + cap + '). ' +
    'The true unanswered count is HIGHER than what this message can list. ' +
    'This is not resolvable by replying to only the senders named below — ' +
    'check `devswarm.js inbox read-primary` / registry state directly. '
  );
}

// buildReason(blocking, ownId, unanswered, escalateTimes, truncated) -> string. Names up to
// 5 neglected workspaces with their unread counts / verdict status, then states
// the EXACT non-skip clear path for each axis (the child read/ack primitive,
// plus the distinct Primary-own-inbound read-primary path when ownId is among
// the blocking set) plus the skip-guard escape. Workspace ids are already
// path-safe (readDescriptors filters via isSafeId: /^[A-Za-z0-9._-]+$/; ownId
// comes from primaryWorkspaceId, same charset), so they carry no control
// chars / injection surface.
//
// `unanswered` (requirement C) — when non-empty, a loud leading segment is
// prepended naming each still-unanswered question, BEFORE everything else
// (loudest/most urgent reason first).
//
// `escalateTimes` (requirement D) — when set (only ever alongside an EMPTY
// `unanswered`, the one axis the cap still governs), this pass is the FIRST
// cap-exhaustion for this exact signature: replace the normal nag body with a
// standalone escalation-worded block instead, naming the exhausted count.
// `hasIntent` (STATED-INTENT) — when the plain-backlog axis escalates
// (`escalateTimes` set) WHILE an intent was on file for this exact signature,
// the wording notes that fact — CLOSED VOCABULARY ONLY: it names that an
// intent exists, never the stored reason text itself (injection hygiene; the
// reason is stored, never reflected — same discipline command-guard.js
// applies to untrusted text elsewhere in this codebase).
// reasonLabel(m) -> string. Renders ONE unknownMembers entry's taxonomy'd
// cause (see liveness.js's unreadBacklog header for the full reason list)
// into a concise, falsifiable fragment — including the failing path/errno
// where available, since those are our OWN descriptor's fields (not
// untrusted message content) and are exactly what makes the claim checkable.
function reasonLabel(m) {
  const suffix = m.path ? ' (' + m.path + (m.errno ? ', ' + m.errno : '') + ')' : '';
  switch (m.reason) {
    case 'no-inbox-path': return 'descriptor has no inboxPath' + suffix;
    case 'no-cursor-path': return 'descriptor has no cursorPath' + suffix;
    case 'inbox-missing': return 'inbox file missing' + suffix;
    case 'inbox-unreadable': return 'inbox file unreadable' + suffix;
    case 'cursor-missing': return 'cursor file missing' + suffix;
    case 'cursor-unreadable': return 'cursor unreadable/corrupt' + suffix;
    case 'cursor-invalid': return 'cursor value invalid' + suffix;
    case 'own-summary-unreadable': return 'own-summary unreadable/corrupt' + suffix;
    case 'read-threw': return 'inbox read raised an error' + suffix;
    default: return 'inbox status could not be confirmed' + suffix;
  }
}

// unknownMemberLabel(b) -> string. Builds the "inbox unreadable"-replacement
// bit for one blocking (family-reduced) entry `b`. `b.unknownMembers` (set by
// main()'s family-reduce loop) carries per-MEMBER cause + failing id — this
// names the actual failing member(s) whenever one differs from the survivor
// id `b.id` already printed just before this bit, so the message never
// silently blames the survivor for a sibling descriptor's failure. Falls back
// to the old generic wording only if unknownMembers is somehow absent (should
// not happen once unreadUnknown is true — defensive, never crashes on it).
const MAX_UNKNOWN_MEMBERS_SHOWN = 3;
function unknownMemberLabel(b) {
  const members = Array.isArray(b.unknownMembers) ? b.unknownMembers : [];
  if (members.length === 0) return 'inbox unreadable';
  const shown = members.slice(0, MAX_UNKNOWN_MEMBERS_SHOWN).map((m) => {
    const who = (m.id && m.id !== b.id) ? m.id + ': ' : '';
    return who + reasonLabel(m);
  });
  const more = members.length > MAX_UNKNOWN_MEMBERS_SHOWN ? ' (+' + (members.length - MAX_UNKNOWN_MEMBERS_SHOWN) + ' more)' : '';
  return shown.join('; ') + more;
}

function buildReason(blocking, ownId, unanswered, escalateTimes, truncated, qEscalateTimes, hasIntent, ownSelfUnknown) {
  const shown = blocking.slice(0, 5).map((b) => {
    const bits = [];
    if (b.unread > 0) bits.push(b.unread + ' unread');
    // unknownLabel (regression fix, d1c8625 identity-family collapse): the
    // bare "inbox unreadable" used to be printed under the FAMILY SURVIVOR's
    // id regardless of which member actually failed to read, or why — a
    // descriptor with `inboxPath: null` (a malformed/phantom descriptor) read
    // identically to a genuinely missing/corrupt inbox file, and a DIFFERENT
    // family member's failure could render under this survivor's own id.
    // `unknownMemberLabel` names the taxonomy'd cause AND the actual failing
    // member (only when it differs from the survivor id shown just before
    // this) so the claim is falsifiable and correctly attributed.
    if (b.unknown) bits.push(unknownMemberLabel(b));
    if (b.status) bits.push(b.status);
    return b.id + (b.id === ownId ? ' (you)' : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  const more = blocking.length > 5 ? ' (and ' + (blocking.length - 5) + ' more)' : '';

  // QUESTION-SET escalation (spec item 5 / C2) — the ONE loud line the
  // unanswered bypass degrades to after its own cap is exhausted. Deliberately
  // separate wording from the plain-backlog `escalateTimes` branch below: this
  // fires with an EMPTY (or unrelated) `blocking` list in the common case, so
  // it must name the QUESTION senders, not a neglected-workspace list.
  if (qEscalateTimes) {
    const who = unanswered.slice(0, 5).map((q) => (q && q.from != null ? String(q.from) : 'unknown sender')).join('; ');
    const moreQ = unanswered.length > 5 ? ' (and ' + (unanswered.length - 5) + ' more)' : '';
    return (
      'DEVSWARM ESCALATION: ' + (truncated ? 'a truncated set of unanswered questions' : 'unanswered question(s) from ' + who + moreQ) +
      ' has forced-blocked this Stop ' + qEscalateTimes + ' times with no reply sent — ' +
      'a human should look. This will not repeat automatically after this message ' +
      '(the question itself is still tracked and unresolved). ' +
      'Escape hatch: the user may direct a skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").'
    );
  }

  let body = '';
  // Truncation (P2 fix) is named FIRST, ahead of even the unanswered-question
  // segment — it is the loudest possible signal ("what you are about to read
  // below is known to be incomplete") and must not be buried under a partial
  // list it is warning about.
  if (truncated) {
    body += buildTruncatedSegment(truncated);
  }
  if (Array.isArray(unanswered) && unanswered.length > 0) {
    body += buildUnansweredSegment(unanswered);
  }

  if (escalateTimes) {
    // Standalone escalation wording (requirement D) — deliberately NOT the
    // normal nag body below: forced-acknowledging the same unresolved
    // signature `escalateTimes` times with no observed change is itself the
    // signal, distinct from "here is what to go read/ack".
    body +=
      'DEVSWARM ESCALATION: this neglect signature (' + shown + more + ') has been ' +
      'forced-acknowledged ' + escalateTimes + ' times with no observed resolution' +
      (hasIntent ? ' (a stated intent was on file for this exact condition, but the absolute backstop was still reached)' : '') +
      ' — a human should look. This will not repeat automatically after this message. ' +
      'Escape hatch: the user may direct a skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").';
    return body;
  }

  const ownEntry = ownId ? blocking.find((b) => b.id === ownId && (b.unread > 0 || b.unknown)) : null;
  const anyChildUnread = blocking.some((b) => (b.unread > 0 || b.unknown) && b.id !== ownId && !b.foreignProject);
  const anyStale = blocking.some((b) => b.status === 'stale' || b.status === 'escalated');

  // Small fix (Round 2 review): only append this paragraph when there is an
  // actual neglected workspace to name — `blocking` can be EMPTY here while
  // still reaching this function (the sole blocking reason was an unanswered
  // question, already handled above via buildUnansweredSegment), and an
  // unconditional append produced a self-contradicting "0 workspace(s) ... :
  // ." sentence with nothing after the colon.
  if (blocking.length > 0) {
    body +=
      'DEVSWARM NEGLECT: ' + blocking.length + ' workspace(s) still need attention ' +
      'before this Primary turn ends: ' + shown + more + '. ';
  }
  // SELF-ROW GATING (regression fix, d1c8625 identity-family collapse):
  // `ownEntry.unknown` is a FAMILY-WIDE union — it goes true whenever ANY
  // member sharing this Primary's worktree family (e.g. a duplicate/phantom
  // descriptor row for the same worktree) failed to read, not only when
  // readOwnUnread's own-summary projection itself failed. Gating this
  // paragraph on that union misattributed a SIBLING descriptor's failure as
  // "YOUR OWN inbound status could not be confirmed" for the Primary itself.
  // `ownSelfUnknown` is `own.unknown` — computed directly by readOwnUnread,
  // entirely independent of the descriptor-side family collapse — so this
  // paragraph now fires ONLY when the Primary's OWN summary read genuinely
  // failed, never as a side effect of another member's inbox/cursor fault
  // (that fault is still named, per-member, in the `shown` list above).
  if (ownSelfUnknown) {
    // C3 fix: the own-summary projection could not be conclusively read (e.g.
    // the daemon crashed mid-write) — surfaced as an explicit unknown, never
    // silently treated as "nothing pending".
    body +=
      'YOUR OWN inbound status could not be confirmed (own-summary unreadable or corrupt — ' +
      'possibly a daemon problem) — treat this as UNKNOWN, not "no messages". Check explicitly via ' +
      '`devswarm.js inbox read-primary ' + ownId + '` (and `devswarm.js healthcheck` / `devswarm.js logs` ' +
      'to check the daemon) before assuming there is nothing pending. ';
  } else if (ownEntry && ownEntry.unread > 0) {
    // v0.57 mesh (D4, Phase 8 step 4): urgencyMax is HONORED in wording only —
    // a DIRECT always gates regardless of urgency (type governs gating; urgency
    // governs loudness/tier). urgent/high gets an explicit "URGENT" callout.
    const urgent = ownEntry.urgencyMax === 'urgent' || ownEntry.urgencyMax === 'high';
    body +=
      (urgent ? 'URGENT — ' : '') +
      'YOU (the Primary) have ' + ownEntry.unread + ' unread parent/peer message(s) — ' +
      'STOP and read them FIRST via `devswarm.js inbox read-primary ' + ownId + '`. ';
  }
  // SAME-WORKTREE TWIN FOLD (defect 773e3e0c7e59, P1): `ownEntry.unread` above
  // is a UNION that can include a same-worktree UUID twin descriptor folded in
  // by the identity-family merge (devswarm-parent-gate.js, `mergedTwinIds`) —
  // it is registered under a DIFFERENT id than `ownId`, so `inbox read-primary
  // <ownId>` (the verb just prescribed) will NOT drain it: read-primary only
  // ever advances the caller's OWN id's cursor. Name the actual twin id(s) and
  // the read-only verb that inspects them (`inbox read <id>`, the same
  // non-mutating verb already prescribed for foreign-project/gone-worktree
  // rows above) so the count above is not silently unaccountable.
  if (ownEntry && Array.isArray(ownEntry.mergedTwinIds) && ownEntry.mergedTwinIds.length > 0) {
    const twinIds = ownEntry.mergedTwinIds;
    body +=
      'NOTE — the unread count above includes ' + twinIds.length + ' same-worktree twin descriptor' +
      (twinIds.length === 1 ? '' : 's') + ' registered under a different id (' +
      twinIds.slice(0, 5).join('; ') + (twinIds.length > 5 ? ' and ' + (twinIds.length - 5) + ' more' : '') +
      ') — this is the SAME identity as this Primary under a duplicate registration, not a separate child. ' +
      'Inspect/drain each via `devswarm.js inbox read <id>` (read-only, safe from any worktree). ';
  }
  // FOREIGN-PROJECT rows (defect e586afdaa968, P1): these are workspaces whose
  // registered project is NOT this session's (their worktree is gone, so only
  // the persisted key remains). Their NDJSON backlog IS readable from here —
  // `inbox read <id>` is fail-open and partition-independent — but
  // `inbox peek-primary <id>` is NOT: the CLI refuses it outright with
  // project-context-mismatch. Naming the working command is the whole point of
  // keeping these rows: the original defect was a Primary blocked with a
  // remediation that could never succeed.
  const foreignChildren = blocking.filter((b) => b.foreignProject && b.id !== ownId).map((b) => b.id);
  if (foreignChildren.length > 0) {
    body +=
      'NOTE — ' + foreignChildren.slice(0, 5).join('; ') +
      (foreignChildren.length > 5 ? ' (and ' + (foreignChildren.length - 5) + ' more)' : '') +
      ' ' + (foreignChildren.length === 1 ? 'is' : 'are') + ' registered under a DIFFERENT project ' +
      '(their worktree no longer resolves), so `inbox peek-primary` will refuse them with ' +
      'project-context-mismatch. Read that backlog with `devswarm.js inbox read <id>` instead — ' +
      'it is read-only, works from any project, and shows the durable-inbox messages counted above. ';
  }
  // GONE-WORKTREE rows (defect 45cf1659f54f, P2 re-scope): naming a command
  // that actually CLEARS the gate is the whole point of keeping these rows
  // blocking — a gone worktree means the ordinary `peek-primary`/cd-in-and-
  // check workflow is unrunnable, and without a working clearing verb the
  // block looks stuck forever.
  //
  // `inbox read <id>` (the verb the FOREIGN-PROJECT branch below prescribes,
  // and this branch's own FIRST-DRAFT wording) does NOT clear this: verified
  // end-to-end (tests/hooks/devswarm-parent-gate.test.js, DEFECT 45cf1659f54f
  // section) that `cmdInbox`'s `read` sub (scripts/devswarm.js ~line 5002)
  // never writes cursorPath or the store cursor — it is read-only, by design
  // (see that function's own comment: "count/read above are non-mutating").
  // A prior incident this same week had a child told to run a non-mutating
  // read to clear a gate that only an acking verb can clear, and it looped
  // forever — do not repeat that shape here.
  //
  // Plain `inbox ack <id>` (no flag) is ALSO not enough for the field case
  // that matters most (store-backed unread, e.g. a mesh-direct `send --to`
  // message — the union axis a gone-worktree row's NDJSON-missing state
  // structurally cannot corroborate on its own, see the un-clearable-axis
  // comment above): the STORE-side cursor sync is gated on `owns` (this
  // Primary's own caller identity === `id`), which is false for the Primary
  // acking on a CHILD's behalf — so it silently no-ops (returns ok:true,
  // cursor unchanged) with NO signal that nothing happened. `--ack-as-owner`
  // is the codebase's own sanctioned override for exactly this shape
  // (scripts/devswarm.js ~line 5096: "a legitimate cross-workspace ack (e.g.
  // a supervisor clearing a dead workspace's backlog on its behalf)") and is
  // what verified end-to-end to clear both channels.
  //
  // Scoped OUT of foreignProject rows: a family can be BOTH worktreeGone AND
  // foreignProject (foreignProject's own derivation, ~line 768, requires
  // `!freshKey`, which a gone worktree also produces) — for a GENUINE
  // cross-project mismatch, `ack` refuses UNCONDITIONALLY regardless of
  // `--ack-as-owner` (scripts/devswarm.js ~line 5040, checked before the
  // ownership branch), so prescribing it there would recreate the exact
  // same "remediation that could never succeed" shape this fix closes.
  // WEAK-SIGNAL WARNING (P0 fix, this wave): `worktreeGone` is derived from
  // `worktreeIsGone` (~line 243) — an lstat ENOENT at the RECORDED
  // worktreePath. A workspace whose worktree was simply MOVED (not retired)
  // reads exactly the same way, because the check never re-resolves the
  // current location. `--ack-as-owner` (scripts/devswarm.js ~line 4087)
  // bypasses the ownership guard outright and performs NO liveness check on
  // its own target, so this hint must not hand it out as an unconditional
  // one-liner — that would prescribe a destructive override on a signal that
  // cannot distinguish "retired" from "moved". Inspect FIRST via the
  // read-only verb, confirm the workspace is genuinely retired, THEN ack.
  const worktreeGoneChildren = blocking.filter((b) => b.worktreeGone && !b.foreignProject).map((b) => b.id);
  if (worktreeGoneChildren.length > 0) {
    body +=
      'NOTE — ' + worktreeGoneChildren.slice(0, 5).join('; ') +
      (worktreeGoneChildren.length > 5 ? ' (and ' + (worktreeGoneChildren.length - 5) + ' more)' : '') +
      ' ' + (worktreeGoneChildren.length === 1 ? 'has' : 'have') + ' a GONE worktree at its recorded path — this ' +
      'cannot be cleared by cd-ing in. WARNING: a MOVED (not retired) worktree reads exactly the same way — this ' +
      'is a path-existence check only, not proof the workspace is dead — and `--ack-as-owner` bypasses ownership ' +
      'with no liveness check of its own, so do not apply it on this signal alone. FIRST inspect with ' +
      '`devswarm.js inbox read <id>` (read-only, works from any project/cwd, and will NOT clear this block either ' +
      'way) to see what is actually pending. Only once you have CONFIRMED the workspace is genuinely retired ' +
      '(not just relocated), clear it with `devswarm.js inbox ack <id> --ack-as-owner` — the sanctioned ' +
      'cross-workspace-ack override for a confirmed-dead workspace\'s backlog. ';
  }
  if (anyChildUnread) {
    // NON-DESTRUCTIVE remediation (root cause b fix — live incident): the
    // prior wording told the Primary to ADVANCE a child's cursor via
    // `inbox read-primary <id>`. That mailbox partition belongs to the CHILD
    // (workspace_id === recipient === that workspace's own id, per
    // devswarm-store.js's D3 wire-contract), so advancing its cursor marks a
    // message read that the CHILD itself has never seen — and read-primary
    // against a workspace this Primary does not own is refused anyway
    // (ownership-mismatch, scripts/devswarm.js cmdInboxMessages), so the old
    // advice could never even succeed. `inbox peek-primary <id>` is the
    // existing NON-MUTATING verb (scripts/devswarm.js cmdInbox 'peek-primary')
    // — same unread-only view, never touches any cursor. Detect-and-report
    // only: inspect here, let the workspace itself clear its own backlog by
    // reading it.
    body +=
      'INSPECT the unread backlog via `devswarm.js inbox peek-primary <id>` ' +
      '(read-only — does not advance any cursor) to see what is pending for each ' +
      'workspace, then follow up with that workspace as needed; a workspace\'s own ' +
      'cursor is only advanced by that workspace reading its own inbox, never by this ' +
      'Primary. ';
  }
  if (anyStale) {
    body +=
      'A stale child is wedged (claude-code#39755); an escalated one already ' +
      'exhausted the automatic poke and needs a human — attend to it (on-demand ' +
      'devswarm-recover for a confirmed wedge, or reassign/archive). ';
  }
  body +=
    'If this is intentional, say so explicitly. Escape hatch: the user may direct a ' +
    'skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").';
  return body;
}

try {
  main();
} catch (_) {
  // Fail-open: a bug here must never block or hard-loop the session.
}
process.exit(0);
