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
// cheap): it NEVER re-runs computeLiveness() and NEVER shells out to git, and
// NEVER opens the store DB. Signals come from files the supervisor / consumer /
// ingest daemon already wrote:
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
//
// INERTNESS (audit P1-D): this hook is a NO-OP until EITHER (a) workspace
// descriptors exist (~/.anti-hall/devswarm/workspaces/*.json) with a populated
// durable inbox, OR (b) the Primary's own summary-projected unread is nonzero.
// A public/standalone anti-hall user with no descriptors, no inbox tooling
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
const { livenessPathFor, devswarmRoot } = require('../companion/lib/liveness.js');
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
    return wake.isClaudeAgent(env) ? wake.wakeReassert(env, CLI, isChild) : '';
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

// readOwnUnread(home, cwd, repoKey) -> { unread, id, urgencyMax }. The
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
// store DB open — stays within the Stop hook's cheap-read budget. Fail-open:
// ANY failure -> { unread: 0, id: null, urgencyMax: null } (never blocks or
// throws on a missing/malformed summary).
function readOwnUnread(home, cwd, repoKey) {
  try {
    const top = cwd ? findGitToplevel(cwd) : null;
    if (!top) return { unread: 0, id: null, urgencyMax: null };
    const id = installIngest.primaryWorkspaceId(top);
    const legacyHash = installIngest.worktreeHash(top);

    const hash = repoKey || legacyHash;
    const p = path.join(devswarmRoot(home), 'summaries', String(hash) + '.json');
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    if (!raw) return { unread: 0, id, urgencyMax: null };
    const summary = JSON.parse(raw);
    const entry = summary && summary.workspaces && summary.workspaces[id];
    const unread = entry && Number.isFinite(entry.unread) && entry.unread > 0 ? entry.unread : 0;
    const urgencyMax = (unread > 0 && entry && entry.urgencyMax) ? entry.urgencyMax : null;
    return { unread, id, urgencyMax };
  } catch (_) {
    return { unread: 0, id: null, urgencyMax: null };
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

  // INERT until descriptors exist (P1-D) OR the Primary itself has unread. No
  // descriptors and no own-unread -> nothing to gate.
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  if (descriptors.length === 0 && own.unread === 0) return;

  // Build the blocking SET: workspaces with unread backlog past their cursor OR a
  // stale/escalated verdict, PLUS the Primary's own unread. All reads are pure fs
  // (no git, no computeLiveness, no store DB open) — `selfKey` above is the
  // ONLY repoKey git spawn this hook invocation needs; the #36 structural
  // filter below reuses it rather than re-resolving.
  const blocking = [];
  if (own.unread > 0 && own.id) {
    blocking.push({ id: own.id, unread: own.unread, status: '', urgencyMax: own.urgencyMax });
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

    const status = readVerdictStatus(d.id, home);
    const staleOrEscalated = status === 'stale' || status === 'escalated';

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

  // Nothing neglected -> clear any prior loop-state and stay quiet.
  if (blocking.length === 0) {
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

  // Load prior loop-state { sig, blocks }.
  let lastSig = '';
  let blocks = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
      blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
    }
  } catch (_) { /* first time / cleared */ }

  // Per-SET cap: the counter is only meaningful while the set is unchanged.
  const effectiveBlocks = sig === lastSig ? blocks : 0;
  const cap = resolveCap(process.env);
  if (effectiveBlocks >= cap) return; // this exact set has been forced-acked enough — go quiet

  // Persist BEFORE blocking so the cap is honored even if the model re-stops with
  // the same set. Can't persist -> fail-open (skip the block to avoid any loop).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig, blocks: effectiveBlocks + 1 }), 'utf8');
  } catch (_) { return; }

  // WAKE RE-VERIFY (v0.59, reused not re-invented — see header): rides along on
  // this SAME forced block, bounded by the SAME per-SET cap above. Claude-only.
  const wakeLine = wakeReassertLine(process.env, false);

  const reason = buildReason(blocking, own.id) + wakeLine;
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

// buildReason(blocking, ownId) -> string. Names up to 5 neglected workspaces with
// their unread counts / verdict status, then states the EXACT non-skip clear path
// for each axis (the child read/ack primitive, plus the distinct Primary-own-
// inbound read-primary path when ownId is among the blocking set) plus the
// skip-guard escape. Workspace ids are already path-safe (readDescriptors filters
// via isSafeId: /^[A-Za-z0-9._-]+$/; ownId comes from primaryWorkspaceId, same
// charset), so they carry no control chars / injection surface.
function buildReason(blocking, ownId) {
  const shown = blocking.slice(0, 5).map((b) => {
    const bits = [];
    if (b.unread > 0) bits.push(b.unread + ' unread');
    if (b.unknown) bits.push('inbox unreadable'); // fail-open: unknown, not silently dropped
    if (b.status) bits.push(b.status);
    return b.id + (b.id === ownId ? ' (you)' : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  const more = blocking.length > 5 ? ' (and ' + (blocking.length - 5) + ' more)' : '';

  const ownEntry = ownId ? blocking.find((b) => b.id === ownId && b.unread > 0) : null;
  const anyChildUnread = blocking.some((b) => (b.unread > 0 || b.unknown) && b.id !== ownId);
  const anyStale = blocking.some((b) => b.status === 'stale' || b.status === 'escalated');

  let body =
    'DEVSWARM NEGLECT: ' + blocking.length + ' workspace(s) still need attention ' +
    'before this Primary turn ends: ' + shown + more + '. ';
  if (ownEntry) {
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
