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
// CLEAR PATH (audit P1-A): the non-skip escape is a real inbox read/ack that
// advances the cursor — the primitive in companion/lib/devswarm-inbox-cursor.js
// (advanceCursor(inboxPath, cursorPath) marks all current messages read; ackTo
// for a partial ack). The block reason states this exact path. skip-guard's TTL
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
// REUSE (never reimplement): descriptor discovery, the read/ack primitive, and
// the verdict-file path helper all already exist.
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { readUnreadMessages } = require('../companion/lib/devswarm-inbox-cursor.js');
const devswarmUnread = require('../companion/lib/devswarm-unread.js');
const { livenessPathFor, devswarmRoot, hasFreshHeartbeat } = require('../companion/lib/liveness.js');
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

// readVerdictStatus(id, home) -> string | null. Reads ONLY the supervisor's
// already-written per-workspace verdict file (no computeLiveness, no git).
// Absent / unreadable / malformed -> null (fail-safe: no verdict = not
// blocking on the liveness axis).
function readVerdictStatus(id, home) {
  try {
    const p = livenessPathFor(id, home); // throws on an unsafe id
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v.status === 'string' ? v.status : null;
  } catch (_) {
    return null;
  }
}

// stateFileFor(sessionId, home) — DISTINCT per-session loop-state, under
// ~/.anti-hall/devswarm/parent-gate/ (never the user's project tree; survives
// `cd`; keyed by session so dedupe is per-session).
function stateFileFor(sessionId, home) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate', safe + '.json');
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
    unanswered = replyStateLib.unansweredQuestions(own.pendingQuestions || [], replyState);
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
  // vanilla project noisy either).
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  if (descriptors.length === 0 && own.unread === 0 && !own.unknown && unanswered.length === 0 && !truncated) return;

  // Build the blocking SET: workspaces with unread backlog past their cursor OR a
  // stale/escalated verdict, PLUS the Primary's own unread. All reads are pure fs
  // (no git, no computeLiveness, no store DB open) — `selfKey` above is the
  // ONLY repoKey git spawn this hook invocation needs; the #36 structural
  // filter below reuses it rather than re-resolving.
  const blocking = [];
  if (own.unread > 0 && own.id) {
    blocking.push({ id: own.id, unread: own.unread, status: '', urgencyMax: own.urgencyMax });
  } else if (own.unknown && own.id) {
    // C3 fix: align polarity with the child #36 loop's known:false handling
    // below — an unreadable/corrupt own-summary (e.g. the daemon crashed
    // mid-write) surfaces as an explicit unknown, never a silent "0 unread".
    blocking.push({ id: own.id, unread: 0, unknown: true, status: '' });
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
  for (const d of descriptors) {
    const dKey = selfKey ? repoKeyOfWorktree(d && d.worktreePath) : null;
    if (selfKey && dKey && dKey !== selfKey) continue;

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
    //   - `known:false` (cursor/inbox not conclusively readable, INCLUDING an
    //     absent inbox file) -> ALWAYS blocks, unconditionally, per spec. A
    //     corrupt cursor, an unreadable inbox behind a real file, or an
    //     absent inbox must never read as "0 unread". This does NOT nag a
    //     freshly-registered child: scripts/devswarm.js's register now
    //     precreates an EMPTY inbox file (alongside the cursor), so "just
    //     registered, never messaged" reads as known:true/0-unread
    //     (confirmed-empty), not known:false. An absent inbox at this point
    //     is therefore a genuine anomaly (a pre-fix legacy child, or a failed
    //     inbox write) that must not be silently swallowed.
    // Only a row that PARSES and whose message text POSITIVELY matches the
    // noise marker is excluded — everything else (including an ambiguous
    // parsed row with no recognizable text field) counts as real.
    let realUnread = 0;
    let unreadUnknown = false;
    try {
      const u = readUnreadMessages(d.inboxPath, d.cursorPath);
      if (!u || !u.known) {
        unreadUnknown = true;
      } else {
        for (const row of u.rows) {
          if (row === null) { realUnread++; continue; } // unparseable -> fail open (real)
          if (isNoiseText(row.message)) continue; // positively-classified noise -> excluded
          realUnread++;
        }
      }
    } catch (_) {
      unreadUnknown = true; // hard failure reading the primitive itself -> fail open
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
    if (!unreadUnknown && dKey) {
      try {
        // `repoKey: dKey` reuses the ALREADY-RESOLVED (memoized, above) repoKey
        // for this descriptor's worktree instead of letting openStoreForUnread
        // re-spawn git for the SAME worktree a second time this Stop invocation.
        const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: d.worktreePath, id: d.id, home, env: process.env, repoKey: dKey });
        if (storeHandle) {
          try {
            const union = devswarmUnread.unionUnread({ inboxPath: d.inboxPath, cursorPath: d.cursorPath, id: d.id, storeHandle });
            for (const row of union.storeOnlyUnreadRows) {
              if (isNoiseText(row && row.body)) continue;
              realUnread++;
            }
          } finally {
            try { storeHandle.close(); } catch (_) {}
          }
        }
      } catch (_) { /* fail-open: NDJSON-only realUnread stands */ }
    }

    const status = readVerdictStatus(d.id, home);
    let staleOrEscalated = status === 'stale' || status === 'escalated';
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

    if (unreadUnknown || realUnread > 0 || staleOrEscalated) {
      blocking.push({
        id: String(d.id),
        unread: realUnread,
        unknown: unreadUnknown,
        status: staleOrEscalated ? status : '',
      });
    }
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
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
      blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
      escalated = parsed.escalated === true;
    }
  } catch (_) { /* first time / cleared */ }

  // Per-SET cap: the counter AND the escalated flag are only meaningful while
  // the set is unchanged — a new blocking-set signature gets a fresh budget
  // AND a fresh escalation opportunity (mirrors the existing blocks reset).
  const effectiveBlocks = sig === lastSig ? blocks : 0;
  const effectiveEscalated = sig === lastSig ? escalated : false;
  const cap = resolveCap(process.env);

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
  if (!bypassCap) {
    if (effectiveEscalated) return; // already escalated once — go quiet
    nextBlocks = effectiveBlocks + 1;
    if (effectiveBlocks >= cap) {
      escalateTimes = nextBlocks;
      nextEscalated = true;
    }
  } else {
    nextBlocks = effectiveBlocks + 1;
  }

  // Persist BEFORE blocking so the cap is honored even if the model re-stops with
  // the same set. Can't persist -> fail-open (skip the block to avoid any loop).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig, blocks: nextBlocks, escalated: nextEscalated }), 'utf8');
  } catch (_) { return; }

  // WAKE RE-VERIFY (v0.59, reused not re-invented — see header): rides along on
  // this SAME forced block, bounded by the SAME per-SET cap above. Claude-only.
  const wakeLine = wakeReassertLine(process.env, false);

  const reason = buildReason(blocking, own.id, unanswered, escalateTimes, truncated) + wakeLine;
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
    'You must DECIDE from context and REPLY: `send --to <id> --message "..."`. '
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
function buildReason(blocking, ownId, unanswered, escalateTimes, truncated) {
  const shown = blocking.slice(0, 5).map((b) => {
    const bits = [];
    if (b.unread > 0) bits.push(b.unread + ' unread');
    if (b.unknown) bits.push('inbox unreadable'); // fail-open: unknown, not silently dropped
    if (b.status) bits.push(b.status);
    return b.id + (b.id === ownId ? ' (you)' : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  const more = blocking.length > 5 ? ' (and ' + (blocking.length - 5) + ' more)' : '';

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
      'forced-acknowledged ' + escalateTimes + ' times with no observed resolution — ' +
      'a human should look. This will not repeat automatically after this message. ' +
      'Escape hatch: the user may direct a skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").';
    return body;
  }

  const ownEntry = ownId ? blocking.find((b) => b.id === ownId && (b.unread > 0 || b.unknown)) : null;
  const anyChildUnread = blocking.some((b) => (b.unread > 0 || b.unknown) && b.id !== ownId);
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
  if (ownEntry && ownEntry.unknown) {
    // C3 fix: the own-summary projection could not be conclusively read (e.g.
    // the daemon crashed mid-write) — surfaced as an explicit unknown, never
    // silently treated as "nothing pending".
    body +=
      'YOUR OWN inbound status could not be confirmed (own-summary unreadable or corrupt — ' +
      'possibly a daemon problem) — treat this as UNKNOWN, not "no messages". Check explicitly via ' +
      '`devswarm.js inbox read-primary ' + ownId + '` (and `devswarm.js healthcheck` / `devswarm.js logs` ' +
      'to check the daemon) before assuming there is nothing pending. ';
  } else if (ownEntry) {
    // v0.57 mesh (D4, Phase 8 step 4): urgencyMax is HONORED in wording only —
    // a DIRECT always gates regardless of urgency (type governs gating; urgency
    // governs loudness/tier). urgent/high gets an explicit "URGENT" callout.
    const urgent = ownEntry.urgencyMax === 'urgent' || ownEntry.urgencyMax === 'high';
    body +=
      (urgent ? 'URGENT — ' : '') +
      'YOU (the Primary) have ' + ownEntry.unread + ' unread parent/peer message(s) — ' +
      'STOP and read them FIRST via `devswarm.js inbox read-primary ' + ownId + '`. ';
  }
  if (anyChildUnread) {
    body +=
      'CLEAR the unread backlog by READING each workspace\'s unread inbox message(s), ' +
      'ACTING on them, then ADVANCING its cursor with the read/ack primitive at ' +
      'plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js ' +
      '(advanceCursor(inboxPath, cursorPath) marks all current messages read; ' +
      'ackTo for a partial ack). ';
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
