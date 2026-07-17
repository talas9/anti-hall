#!/usr/bin/env node
// anti-hall :: devswarm-child-turn (UserPromptSubmit)
//
// Layer 1 of the DevSwarm layered recovery model, per-turn complement to the
// SessionStart devswarm-child-role hook. Fires ONLY for a DevSwarm CHILD
// workspace sub-orchestrator (liveness supervisor active AND
// DEVSWARM_SOURCE_BRANCH non-empty). Does two things, both cheap:
//
//   1. HEARTBEAT (mechanical). Writes a durable, turn-authored heartbeat at
//      ~/.anti-hall/devswarm/heartbeats/<DEVSWARM_BUILDER_ID>.json (falling back to
//      a sanitized <branch> key ONLY when BUILDER_ID is absent) carrying `ts` = now.
//      Keyed by the child's OWN builder id — NOT DEVSWARM_SOURCE_BRANCH, which is
//      the PARENT's branch (KB §6) shared by every sibling forked from that parent;
//      keying by branch would collide all siblings onto one heartbeat file AND
//      never match what the parent-inbox hook reads (heartbeats/<d.id>.json where
//      d.id = DEVSWARM_BUILDER_ID — devswarm-parent-inbox.js's readHeartbeat), so
//      the parent's heartbeat join would always fail. This is authored by THIS
//      turn — proof the child session actually processed a prompt — and NEVER by a
//      background ticker (PLAN.md "Heartbeat authorship rule": a daemon-written
//      heartbeat stays "fresh" even while the session it represents is wedged,
//      producing a false-active read). We assert ONLY what this turn can
//      truthfully assert (a fresh `ts` plus the env correlators); progress_pct/
//      phase/wip/blockers are the child's to report and are NOT fabricated here
//      (absent = unknown).
//
//   2. REMINDER (advisory). Injects a short per-turn nudge to keep the parent
//      updated (`hivecontrol workspace message-parent`) and to stay responsive
//      to parent messages, so a child stays visible on the parent's task list.
//
//   3. UNREAD-INBOX SURFACING (advisory, reception gap). A child cannot run
//      `hivecontrol workspace monitor` / `read-messages` (command-guard blocks them
//      as destructive queue drains), so a parent->child message can sit unseen. This
//      hook does a NON-DESTRUCTIVE unread check on the child's OWN durable descriptor
//      inbox (workspaces/<DEVSWARM_BUILDER_ID>.json -> inboxPath/cursorPath, via the
//      inbox-cursor primitive — pure fs, no native-queue drain, no hivecontrol spawn)
//      and, when unread>0, tells the child it has N unread parent message(s) and the
//      SAFE (non-draining) way to read them. Empty-when-zero: with no durable inbox
//      populated it is a pure no-op. KNOWN GAP (v0.54.2): nothing shipped drains the
//      child's NATIVE parent->child queue into this durable inbox, so this fires only
//      once a child-side ingest/drain populates it — see the report/PLAN follow-up.
//
//   4. DESCRIPTOR REGISTRATION (mechanical, HOTFIX #31). The parent-inbox hook
//      (devswarm-parent-inbox.js) and the supervisor sweep both discover children
//      ONLY through ~/.anti-hall/devswarm/workspaces/*.json descriptors that pass
//      readDescriptors' filter (d.worktreePath && d.sessionId && isSafeId(d.id) —
//      companion/devswarm-supervisor.js:89-106). Nothing mechanically WRITES that
//      descriptor for a child — the per-turn nudges above only tell the child to
//      run a CLI command, and a child never reliably does. Since this hook is
//      itself a Node process running on the child's own turn, it writes/refreshes
//      the child's own descriptor directly via fs (no command execution, no
//      hivecontrol spawn) every turn: id = DEVSWARM_BUILDER_ID, worktreePath =
//      resolved from payload.cwd via a pure fs git-toplevel walk (mirrors
//      devswarm-parent-inbox.js's findGitToplevel), sessionId = payload.session_id.
//      Idempotent (rewritten every turn) and MERGE-preserving: an existing
//      inboxPath/cursorPath (e.g. set by a prior `devswarm.js inbox pull`) is never
//      clobbered, so this hook and the CLI's auto-ensure path converge on the same
//      inbox file. Skipped (fail-open) when the id is unsafe, no cwd/git-toplevel
//      resolves, or any fs op errors — never blocks or crashes a turn.
//
// Primary / non-DevSwarm sessions and malformed stdin are silent no-ops (no
// output, exit 0) — byte-identical to dormant. Fail-open on ANY error. Pure
// Node built-ins only.
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { hook_event_name, session_id, prompt, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//            (only when this session is a child; nothing otherwise)
//   exit 0 : always.
//
// stdout uses fs.writeSync(1, ...) — synchronous, avoids the macOS Node 18/20
// async-flush race (mirrors limit-conserve-inject.js / devswarm-child-role.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { devswarmRoot, isSafeId } = require('../companion/lib/liveness.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
const { ARCHIVE_REQUEST_MARKER } = require('../companion/lib/devswarm-store.js');

// FULL_UUID_RE / TRUNCATED_UUID_RE (F3 defensive hardening) — narrow UUID-shape
// detectors for ONE proven failure mode: hivecontrol's DEVSWARM_BUILDER_ID (a
// UUID per docs/KB-devswarm-hivecontrol.md:215) arriving TRUNCATED by a few
// trailing hex chars — an env-plumbing bug OUTSIDE anti-hall (hivecontrol sets
// the var) that a live incident proved happens: the last UUID segment lost its
// final 2 chars (`c45c1d4196ac` -> `c45c1d4196`), and registerChildDescriptor
// below then wrote a phantom workspace descriptor under that short id every
// turn — a SECOND, dead-inbox roster entry alongside the real one — because it
// trusted the env var as a filename with zero shape validation. Deliberately
// narrow: only an id that is otherwise EXACTLY UUID-shaped (four hyphens in the
// 8-4-4-4-N positions) but whose LAST group is short (1-11 hex instead of the
// required 12) trips TRUNCATED_UUID_RE — a plain mnemonic id like `child-1` or
// `b-1` (used throughout this file's own tests, and any future non-UUID scheme)
// never matches either pattern and is completely unaffected.
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUNCATED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{1,11}$/i;

// CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper, resolved ONCE
// from this hook's own on-disk location. A DevSwarm child's cwd is its PROJECT
// WORKTREE, not the plugin root — a relative "scripts/devswarm.js" string in
// emitted text only resolves when cwd happens to be the plugin root, so every
// emitted instruction below embeds this absolute path instead (P1 fix).
const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// REMINDER — names `heartbeat --summary` as the verb that actually satisfies
// the Stop-gate report requirement (devswarm-child-gate.js's
// alreadyReportedThisEpisode() reads the shared store's `recent[]` projection,
// which is populated ONLY by a broadcast/heartbeat --summary call, never a
// direct `send --to-primary` — a direct message lands in the RECIPIENT's own
// partition, not anywhere this child's own "did I report" check can see it).
// `send --to-primary` is called out as a SEPARATE, additional channel — not a
// substitute — so a child that direct-messages only does not mistakenly believe
// it has satisfied the Stop-gate and then get blocked anyway.
const REMINDER =
  'DEVSWARM CHILD WORKSPACE (per turn): keep the parent orchestrator updated — ' +
  'run `node ' + CLI + ' heartbeat <DEVSWARM_BUILDER_ID> --summary ' +
  '"<status>"` to report progress/blockers as you make them — this is what satisfies ' +
  'your Stop-gate report (`send --to-primary --message "<text>"` is a SEPARATE direct ' +
  'message, not a substitute) — and check for + act on any parent ' +
  'messages before continuing, so you stay visible on the parent\'s task list ' +
  'instead of drifting off it.';

// OVERRIDE_REASSERT — terse (<=160 char) per-turn re-assertion of the SessionStart
// COMMUNICATION OVERRIDE (devswarm-child-role.js): DevSwarm's own `--system-
// prompt-file` REPLACES the system prompt at every child spawn (PLAN.md "Locked
// design" — the only lever against that erasure is per-turn UserPromptSubmit
// injection), so this is injected UNCONDITIONALLY every turn, same as REMINDER
// below. Avoids the literal `message-child`/`message-parent` strings (uses the
// `message-*` wildcard form) so it never re-introduces the blocked native verbs
// into emitted hook text.
const OVERRIDE_REASSERT =
  'DEVSWARM COMMS OVERRIDE: mesh only — native hivecontrol messaging blocked. ' +
  'Report: `heartbeat <id> --summary`. Direct: `send --to-primary`.';

// RECEPTION nudge (advisory, static — NO spawn in the hook). Tells the child the
// SAFE way to RECEIVE parent messages: run the bounded `inbox pull` drain (native
// message-count gate -> at-most-one bounded read-messages, never `monitor`), which
// folds the native parent->child queue into the durable inbox, THEN read it via the
// non-draining cursor. This is what makes the unreadParentSegment below fire — the
// pull is what populates the durable inbox it checks. Static string only: the hook
// itself never spawns hivecontrol (that would put a destructive read on the hot
// per-turn path); it just tells the child which command to run.
const RECEIVE_NUDGE =
  'DEVSWARM CHILD RECEPTION: to RECEIVE parent messages, run ' +
  '`node ' + CLI + ' inbox pull <DEVSWARM_BUILDER_ID>` (anti-hall devswarm ' +
  'CLI) — a SAFE, bounded drain that folds the native parent->child queue into your ' +
  'durable inbox (non-destructive count gate, one bounded read, never `monitor`). ' +
  'Then read them the non-draining way via `node ' + CLI + ' inbox read ' +
  '<DEVSWARM_BUILDER_ID>`. Substitute your own DEVSWARM_BUILDER_ID for <...>.';

// heartbeatKey(builderId, branch) -> a safe single path segment for the heartbeat
// filename. Keyed by the child's OWN DEVSWARM_BUILDER_ID whenever it is a safe id
// — this is what devswarm-parent-inbox.js's readHeartbeat(home, d.id) looks up
// (d.id = DEVSWARM_BUILDER_ID), and it is unique PER CHILD, unlike
// DEVSWARM_SOURCE_BRANCH which is the shared PARENT branch every sibling forked
// from that parent carries identically (keying by branch would cross-contaminate
// sibling liveness onto one file AND never match what the parent reads). Falls
// back to the branch key ONLY when BUILDER_ID is absent/unsafe, preserving the
// prior sanitize+hash behavior for that legacy path: a plain branch like `main`
// stays clean, but a branch can carry `/` or other chars unsafe as a file name,
// so when it isn't already a safe id we sanitize AND append a short deterministic
// hash of the RAW branch so two distinct branches that sanitize to the same
// string (e.g. `a/b` vs `a-b`) can never collide onto one heartbeat file.
function heartbeatKey(builderId, branch) {
  if (isSafeId(builderId)) return builderId;
  if (isSafeId(branch)) return branch;
  const safe = String(branch).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '_').slice(0, 80) || 'branch';
  const hash = crypto.createHash('sha1').update(String(branch)).digest('hex').slice(0, 8);
  return safe + '-' + hash;
}

// writeHeartbeat(env, sessionId, home) — atomic tmp+rename write of the
// turn-authored heartbeat. Best-effort: any fs error is swallowed by the caller
// (a heartbeat-write failure must NEVER block a turn).
function writeHeartbeat(env, sessionId, home) {
  const branch = env.DEVSWARM_SOURCE_BRANCH;
  const key = heartbeatKey(env.DEVSWARM_BUILDER_ID, branch);
  const dir = path.join(devswarmRoot(home), 'heartbeats');
  const target = path.join(dir, key + '.json');
  // Only what this turn can truthfully assert. `source` marks it turn-authored
  // (not a ticker); env correlators are copied verbatim (each is a real env
  // value), never relabeled into an unverified workspace-id claim.
  const beat = {
    ts: Date.now(),
    source: 'child-turn',
    branch: branch,
    repoId: env.DEVSWARM_REPO_ID || null,
    builderId: env.DEVSWARM_BUILDER_ID || null,
    builderName: env.DEVSWARM_BUILDER_NAME || null,
    sessionId: sessionId || null,
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(beat));
  fs.renameSync(tmp, target);
}

// unreadInfo(env, home) -> { id, count, lines } | null. NON-DESTRUCTIVE unread
// check on the child's OWN durable descriptor inbox (workspaces/<DEVSWARM_
// BUILDER_ID>.json). Uses the inbox-cursor primitive (pure fs; never drains the
// native queue, never spawns hivecontrol). `lines` is the raw unread NDJSON/text
// lines, kept so the caller can additionally scan them for the archive-request
// marker (see ARCHIVE_REQUEST_MARKER below) without a second read. Returns null
// when there is no unread backlog (empty-when-zero: a child with no populated
// durable inbox stays a pure no-op). Fail-safe: ANY error -> null (never blocks
// or crashes a turn).
function unreadInfo(env, home) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return null;
    const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
    let desc;
    try { desc = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch (_) { return null; }
    if (!desc || typeof desc !== 'object' || !desc.inboxPath) return null;
    const u = readUnread(desc.inboxPath, desc.cursorPath);
    if (!u.known || u.count <= 0) return null;
    return { id, count: u.count, lines: u.lines };
  } catch (_) {
    return null;
  }
}

// buildUnreadSegment(info) -> string. IMPERATIVE PRIORITY wording (escalated from
// advisory, #29): a child must not treat parent messages as optional background
// noise — it is told to stop and address them before continuing.
function buildUnreadSegment(info) {
  return (
    'DEVSWARM CHILD INBOX — PRIORITY: you have ' + info.count + ' unread parent '
    + 'message(s). STOP and address these parent message(s) FIRST before '
    + 'continuing. Read them the SAFE, NON-DRAINING way via the durable inbox '
    + 'cursor — `node ' + CLI + ' inbox read ' + info.id + '` (anti-hall devswarm CLI). '
    + 'Do NOT run `hivecontrol workspace read-messages` or `monitor` — those '
    + 'DESTRUCTIVELY drain the native queue.'
  );
}

// buildMeshDirectSegment(count, id, urgencyMax) -> string. D26/D4 (Phase 8 step
// 3): urgency-tiered nudge for a mesh DIRECT addressed to THIS child's meshId —
// urgent/high gets the LOUDEST imperative wording (parity with the Primary's
// own buildOwnUnreadSegment posture); everything else (null/'normal'/
// unrecognized) gets the standard read nudge (edge_cases: unknown -> normal).
// A DIRECT always surfaces regardless of urgency (D4's type-vs-urgency
// separation — urgency governs wording/loudness only).
function buildMeshDirectSegment(count, id, urgencyMax) {
  const urgent = urgencyMax === 'urgent' || urgencyMax === 'high';
  if (urgent) {
    return (
      'DEVSWARM MESH DIRECT — URGENT: you have ' + count + ' unread mesh direct '
      + 'message(s) addressed to you. STOP and read them FIRST via `node ' + CLI + ' '
      + 'inbox read-primary ' + id + '` before continuing.'
    );
  }
  return (
    'DEVSWARM MESH DIRECT: you have ' + count + ' unread mesh direct message(s) '
    + 'addressed to you. Read them via `node ' + CLI + ' inbox read-primary ' + id + '`.'
  );
}

// ARCHIVE_REQUEST_MARKER — a parent embeds this literal token in a message body to
// ask the child to archive its own workspace. A plain substring scan (format-
// agnostic: works whether the durable line is raw text or NDJSON-wrapped) over the
// already-fetched unread lines, so detecting it costs no extra read. Imported from
// companion/lib/devswarm-store.js (the canonical definition) rather than kept as a
// second local literal — no circular require (devswarm-store.js only pulls in
// ./liveness.js).

// buildArchiveRequestSegment(id) -> string. A DISTINCT segment from the unread
// nudge: teardown is never automatic — the child must get its OWN user's
// confirmation before running the archive command.
function buildArchiveRequestSegment(id) {
  return (
    'DEVSWARM ARCHIVE REQUEST: your parent asks you to archive this workspace. '
    + 'Confirm with YOUR user, then run `node ' + CLI + ' archive ' + id + '`. NEVER '
    + 'auto-archive.'
  );
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry (a directory for a normal checkout, a FILE for a
// linked worktree/submodule) — the same root `git rev-parse --show-toplevel`
// would report for that cwd, WITHOUT spawning git. Mirrors devswarm-parent-
// inbox.js's own findGitToplevel byte-for-byte (kept as a local copy rather than a
// shared require so this hot per-turn hook's dependency surface stays exactly what
// it already was — no new cross-file coupling for a few lines of pure fs walk).
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

// Default inbox/cursor locations for a FRESH descriptor — must match
// companion/lib/devswarm-pull.js's inboxDefaultPath/cursorDefaultPath byte-for-
// byte (duplicated in-line rather than required: that module pulls in devswarm-
// ingest.js + devswarm-store.js, both far heavier than this hot per-turn hook
// should depend on, and a require-time failure there would throw BEFORE this
// hook's own try/catch could fail it open). Only used when a descriptor has no
// inboxPath/cursorPath yet, so a later `devswarm.js inbox pull` (which auto-
// ensures with the SAME defaults) converges on the identical file.
function defaultInboxPath(home, id) {
  return path.join(devswarmRoot(home), 'inbox', id + '.ndjson');
}
function defaultCursorPath(home, id) {
  return path.join(devswarmRoot(home), 'cursors', id + '.cursor');
}

// registerChildDescriptor(env, sessionId, cwd, home) — mechanically write/refresh
// this child's own descriptor at workspaces/<id>.json so the parent-inbox hook and
// the supervisor sweep (both gated on readDescriptors' d.worktreePath && d.sessionId
// && isSafeId(d.id) filter) can see it. MERGES over any existing descriptor
// (preserves inboxPath/cursorPath/nudgeCommand already set — e.g. by a prior
// `inbox pull` — never clobbers them); only id/worktreePath/sessionId are always
// refreshed from this turn's truthful values. Atomic tmp+rename write, mirroring
// writeDescriptorAtomic in scripts/devswarm.js. Skips silently (fail-open) when the
// id is unsafe, sessionId is absent, or no git worktree resolves from cwd — a child
// running outside a worktree, or a malformed env, must never crash or block a turn.
function registerChildDescriptor(env, sessionId, cwd, home) {
  let id = env.DEVSWARM_BUILDER_ID;
  if (typeof id !== 'string' || !isSafeId(id)) return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;

  // F3 defensive fix: a truncated hivecontrol builder id must never be trusted
  // as a filename — writing under it every turn creates a NEW phantom
  // descriptor (dead inbox/cursor paths) that still passes readDescriptors'
  // filter (worktreePath && sessionId && isSafeId(id)), split-braining the
  // real child's registration across two files. Recover the TRUE id when this
  // turn's OWN sessionId (payload.session_id — a value this hook already
  // trusts, NOT derived from the suspect env var) is a full UUID that the
  // truncated id is a strict prefix of: that is exactly the observed failure
  // shape (a real UUID sliced short by whatever set the env var), so sessionId
  // IS the correct id. That is the only safe recovery source available at this
  // layer; if it doesn't hold, skip registration entirely this turn rather
  // than write a known-bad id (fail-open — never crash/block a turn on a
  // malformed env var; the next turn gets another chance).
  if (TRUNCATED_UUID_RE.test(id) && !FULL_UUID_RE.test(id)) {
    if (FULL_UUID_RE.test(sessionId) && sessionId !== id && sessionId.indexOf(id) === 0) {
      try {
        process.stderr.write('[devswarm-child-turn] DEVSWARM_BUILDER_ID ' + JSON.stringify(id)
          + ' looks truncated (UUID-shaped, short last group) — recovered the full id '
          + JSON.stringify(sessionId) + ' from this turn\'s own sessionId; registering under '
          + 'the recovered id instead of writing a phantom.\n');
      } catch (_) {}
      id = sessionId;
    } else {
      try {
        process.stderr.write('[devswarm-child-turn] DEVSWARM_BUILDER_ID ' + JSON.stringify(id)
          + ' looks truncated (UUID-shaped, short last group) and no full id could be safely '
          + 'recovered from this turn\'s sessionId — skipping descriptor registration this turn '
          + 'rather than writing a phantom.\n');
      } catch (_) {}
      return null;
    }
  }

  const worktreePath = findGitToplevel(cwd);
  if (!worktreePath) return null;

  const dir = path.join(devswarmRoot(home), 'workspaces');
  const target = path.join(dir, id + '.json');
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { existing = null; }
  const base = existing && typeof existing === 'object' ? existing : {};

  const desc = Object.assign({}, base, { id, worktreePath, sessionId, repoId: env.DEVSWARM_REPO_ID || null });
  if (desc.inboxPath === undefined || desc.inboxPath === null) desc.inboxPath = defaultInboxPath(home, id);
  if (desc.cursorPath === undefined || desc.cursorPath === null) desc.cursorPath = defaultCursorPath(home, id);
  if (desc.nudgeCommand === undefined) desc.nudgeCommand = null;

  // Best-effort, non-destructive cursor init (mirrors cmdRegister in
  // scripts/devswarm.js) so a brand-new descriptor's inbox reads known:true
  // (0 unread) instead of known:false. Never clobbers an existing cursor file.
  // Runs BEFORE the descriptor is published below (see that comment for why).
  if (desc.cursorPath && !fs.existsSync(desc.cursorPath)) {
    try {
      fs.mkdirSync(path.dirname(desc.cursorPath), { recursive: true });
      fs.writeFileSync(desc.cursorPath, '0');
    } catch (_) { /* best-effort; inbox ops still degrade to known:false */ }
  }
  // Co-located TRUNCATION-PROOF precreate of an EMPTY durable inbox file (P0-2
  // fix, real production path): this hook — NOT cmdRegister in
  // scripts/devswarm.js — is the mechanical, per-turn, hook-driven
  // registration entry point every real child actually goes through first
  // (fires on EVERY UserPromptSubmit turn, before a child ever runs the
  // separate CLI `devswarm.js inbox pull`). Without this, a genuinely
  // registered child's inbox stays ABSENT (known:false) until its first
  // `inbox pull`, so devswarm-parent-gate.js's Stop-hook gate — which blocks
  // unconditionally on known:false — nags on every real child's early turns.
  // Mirrors cmdRegister's own SAME hardened fix (P0 data-loss race): an
  // earlier version used `wx` (exclusive create, fails closed on EEXIST), but
  // O_EXCL exclusivity is documented as unreliable over some network
  // filesystems (NFS). `a` (append) opens for append and CREATES the file if
  // absent, and appending '' never truncates existing content on ANY
  // filesystem — no reliance on O_EXCL exclusivity at all — so this can NEVER
  // clobber a concurrently pull-written inbox. Cross-platform (supported on
  // win32/macOS/linux). Fail-open: any error is swallowed — best-effort init
  // only, and inbox ops still degrade to known:false if it never succeeds.
  // Runs BEFORE the descriptor is published below (see that comment for why).
  if (desc.inboxPath) {
    try {
      fs.mkdirSync(path.dirname(desc.inboxPath), { recursive: true });
      fs.writeFileSync(desc.inboxPath, '', { flag: 'a' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal to registration */ }
  }

  // Publish the descriptor LAST, only after the cursor/inbox init above has
  // run. The descriptor is what makes this child DISCOVERABLE to the parent-
  // gate and supervisor sweep (both gated on readDescriptors' worktreePath &&
  // sessionId filter) — publishing it FIRST left a transient window where a
  // just-discoverable child's inbox did not exist yet, which
  // devswarm-parent-gate.js's Stop-hook gate reads as known:false (its
  // genuine-anomaly signal) and blocks on, even though the child is about to
  // create its own empty inbox one statement later. Reordering closes that
  // window: by the time the descriptor is visible, the inbox/cursor already
  // exist. `dir` (the workspaces directory the descriptor itself lives under)
  // is independent of inboxPath/cursorPath (which live under devswarmRoot's
  // own inbox/ and cursors/ dirs), so this reorder has no other dependency.
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(desc));
  fs.renameSync(tmp, target);

  // F3 defensive fix, part 2: retire any OTHER descriptor file in this SAME
  // dir that shares this worktreePath but carries a DIFFERENT id — the
  // phantom-duplicate shape cmdRegister's retireWorktreeDuplicates already
  // dedups at the STORE-registry layer (scripts/devswarm.js ~line 1343), but
  // that helper explicitly LEAVES any row backed by an on-disk descriptor file
  // (foldGroupIntoSurvivor: "a candidate that HAS a descriptor ... is LEFT,
  // never tombstoned" — it only tombstones store-only rows). The truncation
  // incident's phantom IS a real descriptor FILE (dead inbox/cursor paths but
  // otherwise well-formed), so it survives that layer untouched forever. This
  // auto-cleans it on the NEXT real registration for the same worktree.
  try { retirePhantomWorktreeDuplicates(dir, id, worktreePath, home, env); }
  catch (_) { /* fail-open: phantom retirement must never block a turn */ }

  return desc;
}

// retirePhantomWorktreeDuplicates(dir, keepId, worktreePath, home, env) — scan
// the workspaces/ dir for OTHER *.json descriptors pointing at the SAME
// worktreePath as `keepId` (the child that just registered/refreshed) and
// retire any that are PROVEN phantoms. "Proven" is deliberately narrow (HARD
// RULE: never delete a descriptor that could be live):
//   - the candidate's id is itself UUID-shaped-but-short (TRUNCATED_UUID_RE
//     and not FULL_UUID_RE) — malformed on its face, a self-contained signal
//     that needs no cross-system assumption to trust.
// P1 FIX (ground-truth audit): this used to ALSO retire on `id !== sessionId`
// alone, reasoning a live registration always has id === sessionId. That is
// FALSE in the general case — auditing every real descriptor under
// ~/.anti-hall/devswarm/workspaces/ showed 100% have id !== sessionId
// (sessionId is null or a DIFFERENT Claude-session UUID; descriptor `id` is
// the workspace/builder id, a distinct namespace — see
// docs/KB-devswarm-hivecontrol.md). Using that as a retirement trigger meant
// a genuinely-live workspace merely sharing a worktreePath with the
// registering child would be wrongly archived. Truncation-shape is the ONLY
// retirement signal now; id/sessionId equality is irrelevant either way.
// "Retire" = the SAME sanctioned archive path cmdRegister/cmdArchive use
// (hardlink into archived/, tombstone the store registry row, THEN unlink the
// active file) — NEVER a raw fs.unlinkSync of anything that could be live
// data. cmdArchive re-validates the SAME proof INSIDE its own per-id lock
// (opts.revalidate) immediately before mutating, closing the race where a
// candidate becomes self-consistent between this scan and the archive call.
// No deadlock: registerChildDescriptor (the sole caller) holds no lock of its
// own — cmdArchive's withIdLock(candidateId, ...) is keyed on the CANDIDATE's
// id, which is by construction different from `keepId`, so this can never
// contend with a lock this call already holds. Fail-open throughout: any
// require/read/archive failure is swallowed by the caller's own try/catch.
// F-A (v0.61.2): a truncated-id phantom retired here CAN still hold unread
// direct messages — mesh routes traffic via the registry/worktree, not the
// phantom's (dead) inboxPath, so a message can land in the phantom's store
// partition even though nothing ever reads its descriptor inbox. cmdArchive
// (unlike foldGroupIntoSurvivor, used by retireWorktreeDuplicates/
// foldMeshDuplicates) does NOT forward unread directs — it only tombstones the
// registry row. So BEFORE archiving a candidate here, forward its unread
// backlog into the surviving real workspace (`keepId`) using the SAME shared
// foldGroupIntoSurvivor forward step those other paths already use (reused,
// not reimplemented) — then archive. If forwarding fails, the candidate is
// left in place (NOT archived) so its unread backlog is never lost; a later
// turn retries.
function retirePhantomWorktreeDuplicates(dir, keepId, worktreePath, home, env) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  let cliMod = null;
  let storeMod = null;
  let repokeyMod = null;
  let s = null; // lazily-opened shared store, reused across candidates for this call
  try {
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const candId = n.slice(0, -5);
      if (candId === keepId) continue; // never touch our own just-written file
      if (!isSafeId(candId)) continue; // never path.join / archive an unsafe name
      let cand = null;
      try { cand = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
      if (!cand || typeof cand !== 'object') continue;
      if (cand.worktreePath !== worktreePath) continue; // different worktree — not our concern
      if (cand.id == null || String(cand.id) !== candId) continue; // filename/id mismatch — be conservative, leave it
      const idLooksTruncated = TRUNCATED_UUID_RE.test(candId) && !FULL_UUID_RE.test(candId);
      if (!idLooksTruncated) continue; // not proven-corrupt — could be a distinct live child, never retire
      if (!cliMod) {
        try { cliMod = require('../scripts/devswarm.js'); } catch (_) { cliMod = null; }
        if (!cliMod || typeof cliMod.cmdArchive !== 'function') return; // can't retire safely -> no-op
      }
      // Forward this candidate's unread directs into keepId BEFORE archiving.
      // Best-effort store/repoKey resolution mirrors registerStoreDescriptor
      // below (lazy, guarded requires) — any resolution failure aborts THIS
      // candidate's archive (fail-open toward never losing a message, not
      // toward always retiring the phantom).
      let forwardOk = false;
      if (typeof cliMod.foldGroupIntoSurvivor === 'function') {
        if (!storeMod) { try { storeMod = require('../companion/lib/devswarm-store.js'); } catch (_) { storeMod = null; } }
        if (!repokeyMod) { try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; } }
        if (storeMod) {
          try {
            let repoKey = null;
            if (repokeyMod) { try { repoKey = repokeyMod.repoKeyForWorktree(worktreePath); } catch (_) { repoKey = null; } }
            if (!s) s = storeMod.openStore({ home, workspaceId: keepId, hash: repoKey || undefined, env });
            const result = cliMod.foldGroupIntoSurvivor(s, home, keepId, [cand]);
            forwardOk = !(result && result.forwardFailed && result.forwardFailed.length);
          } catch (_) { forwardOk = false; }
        }
      }
      if (!forwardOk) continue; // abort archive for this candidate — never lose its unread backlog
      try {
        cliMod.cmdArchive(candId, { home, cwd: worktreePath, env }, {
          revalidate: (d) => (d && !(TRUNCATED_UUID_RE.test(String(d.id)) && !FULL_UUID_RE.test(String(d.id))))
            ? 'now-consistent' : null,
        });
      } catch (_) { /* fail-open: a single candidate's archive failure must not block the rest */ }
    }
  } finally {
    if (s) { try { s.close(); } catch (_) {} }
  }
}

// registerStoreDescriptor(desc, home) — v0.57 mesh (D24, Phase 8 gap-close):
// registerChildDescriptor above (the #31 HOTFIX) writes ONLY the fs descriptor
// file — under mesh, devswarm-parent-inbox.js discovers workspaces EXCLUSIVELY
// through the shared store's registry (summaries/<repoKey>.json, Phase 8 step
// 1), so a child that never happens to run `devswarm.js inbox pull` (the ONLY
// other path that upserts the store registry, via cmdRegister) would be
// invisible to the Primary forever — breaking #31's whole "mechanical, no-CLI-
// dependency" guarantee. This mirrors the ingest daemon's own self-registration
// (devswarm-ingest.js runIngestLoop: read-existing, merge-preserving, upsert,
// re-derive) so the SAME mechanical guarantee holds for children under mesh.
// Best-effort + isolated: ANY failure (missing/corrupt devswarm-repokey.js or
// devswarm-store.js, unresolvable repoKey, a store-open error) must NEVER
// block or crash a turn — lazy/guarded requires (D27), swallowed here.
function registerStoreDescriptor(desc, home) {
  if (!desc || !desc.id || !desc.worktreePath) return;
  try {
    let repokeyMod = null;
    try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
    let storeMod = null;
    try { storeMod = require('../companion/lib/devswarm-store.js'); } catch (_) { storeMod = null; }
    if (!repokeyMod || !storeMod) return;
    let repoKey = null;
    try { repoKey = repokeyMod.repoKeyForWorktree(desc.worktreePath); } catch (_) { repoKey = null; }
    if (!repoKey) return;

    // P1c (v0.62.2 lock hardening): registerStoreDescriptor is a THIRD writer of
    // this SAME registry row (id/worktree_path/session_id/inbox_path/cursor_path),
    // alongside cmdRegister and rekeySubdirRegistryRows — BOTH of which run their
    // upsertRegistry write under withIdLock(id). This one didn't, so it could race
    // either of those (classic lost-update: a concurrent register/rekey's write
    // gets clobbered back to this call's stale-relative-to-that-write values, or
    // vice versa). Lazy-require devswarm.js for `withIdLock` (guarded, same
    // fail-open posture as the repokey/store requires above; ALSO reused below for
    // the phantom-rescue call, so only one require). No deadlock: this hook's
    // main() is the sole entry point into registerStoreDescriptor and holds no
    // lock of its own (writeHeartbeat/registerChildDescriptor above only touch the
    // fs descriptor file, never the per-id registry lock), so this is never
    // re-entrant into an already-held lock for this id.
    let cliMod = null;
    try { cliMod = require('../scripts/devswarm.js'); } catch (_) { cliMod = null; }
    if (!cliMod || typeof cliMod.withIdLock !== 'function') return; // can't lock -> skip the write rather than proceed unlocked

    const lockResult = cliMod.withIdLock(desc.id, home, () => {
      const s = storeMod.openStore({ home, workspaceId: desc.id, hash: repoKey });
      try {
        s.upsertRegistry({
          id: desc.id,
          worktreePath: desc.worktreePath,
          sessionId: desc.sessionId,
          inboxPath: desc.inboxPath,
          cursorPath: desc.cursorPath,
          nudgeCommand: desc.nudgeCommand,
        });
        storeMod.deriveSummary(s, { home });
      } finally {
        try { s.close(); } catch (_) {}
      }
      return { ok: true };
    });
    if (lockResult && lockResult.lockBusy) {
      // FAIL CLOSED on the write (never proceed unlocked), but never block/crash
      // the turn: surfaced to stderr, and this hook runs every turn — the next
      // turn's call retries. Idempotent (upsertRegistry is a plain field write).
      try {
        process.stderr.write('[devswarm-child-turn] registerStoreDescriptor: id '
          + JSON.stringify(desc.id) + ' is locked by another operation in progress'
          + ' — skipped this turn (retried next turn)\n');
      } catch (_) {}
      return;
    }

    // P0 phantom-rescue (money path): on the child's FIRST mechanical self-register,
    // fold any same-worktree spawn phantom (`cmdSpawn` registers {id:meshId,
    // sessionId:null}) into THIS builder-id partition — forward its real directs, then
    // tombstone the phantom. A Primary `send --to <meshId>` issued before the child
    // existed lands in that dead phantom partition; without this the rescue only ran if
    // a later CLI `inbox pull` happened to hit cmdRegister's identical fold (NOT
    // guaranteed on the child's first turn) -> silent message loss. Reuse the CLI's
    // retireWorktreeDuplicates VERBATIM (no logic duplication); it self-gates
    // (no-op for a meshId-keyed row, only tombstones a descriptor-less phantom) and is
    // fully fail-open. Own try so a rescue failure never blocks or crashes a turn.
    try {
      // Reuse the SAME cliMod handle required above for withIdLock (already
      // confirmed truthy at this point, since we returned earlier otherwise).
      if (typeof cliMod.retireWorktreeDuplicates === 'function') {
        cliMod.retireWorktreeDuplicates(home, desc, { cwd: desc.worktreePath, env: process.env });
      }
    } catch (_) { /* fail-open: phantom-rescue must never block a turn */ }
  } catch (_) { /* fail-open: never block a turn on a mesh registration failure */ }
}

function main() {
  // Read stdin for contract completeness; the only field we use is session_id
  // (a heartbeat correlator). Absent/malformed stdin is fine — fail-open.
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch (_) { payload = {}; }

  const env = process.env;
  // No-op for Primary / non-DevSwarm sessions: emit NOTHING (zero per-turn
  // overhead), byte-identical to dormant.
  if (!isDevswarmActive(env)) return;
  if (!isChildWorkspace(env)) return;

  const home = os.homedir();

  // Heartbeat first, isolated so a write failure still lets the reminder through.
  try {
    writeHeartbeat(env, payload.session_id, home);
  } catch (_) { /* fail-open: never block a turn on a heartbeat write */ }

  // Mechanical descriptor registration (#31 HOTFIX), isolated the same way — a
  // registration failure must never suppress the reminder/unread segments below.
  try {
    const desc = registerChildDescriptor(env, payload.session_id, payload.cwd, home);
    // v0.57 mesh (D24, Phase 8 gap-close): ALSO mechanically upsert into the
    // shared store's registry — see registerStoreDescriptor's own doc comment.
    // Isolated in its OWN try (already internally fail-open) so a store-side
    // failure can never suppress the fs descriptor write above.
    try { registerStoreDescriptor(desc, home); } catch (_) {}
  } catch (_) { /* fail-open: never block a turn on a descriptor write */ }

  // Daemon-LIVENESS staleness banner (Phase 7, PLAN-v0.57-mesh.md D25) — the
  // SAME warning devswarm-parent-inbox.js renders to the Primary, so a child
  // sees identical wording when its OWN project's per-project ingest daemon
  // looks stopped (children depend on that daemon too — it is what drains their
  // native parent->child queue via `inbox pull`). Lazy/guarded requires (D27):
  // a missing/corrupt `ingest-health.js`/`devswarm-repokey.js` fails this block
  // open (no banner), never the whole hook. `status==='healthy'` or
  // `'unsupported'` (win32, D28) also render nothing. `worktree`/`repokeyMod`/
  // `repoKey` are resolved ONCE here and reused below for the D26 mesh-direct
  // surfacing block (one git spawn, not two).
  let staleBanner = null;
  let meshDirectSegment = null;
  // v0.58 (item 6): Lane B's deriveSummary additively marks archive_requested on
  // a workspace entry once the store observes the parent's archive-request
  // marker. Read DEFENSIVELY — undefined (an older store/summary shape, or Lane
  // B not yet landed) is falsy, so this stays a pure no-op until it ships.
  let archiveRequestedId = null;
  try {
    const worktree = findGitToplevel(payload.cwd);
    if (worktree) {
      let ingestHealthMod = null;
      try { ingestHealthMod = require('../companion/lib/ingest-health.js'); } catch (_) { ingestHealthMod = null; }
      let repokeyMod = null;
      try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
      let repoKey = null;
      try { repoKey = repokeyMod ? repokeyMod.repoKeyForWorktree(worktree) : null; } catch (_) { repoKey = null; }

      if (ingestHealthMod && repoKey) {
        const now = Date.now();
        let beatTs = null;
        try {
          const beat = JSON.parse(fs.readFileSync(ingestHealthMod.ingestHeartbeatPath(home, repoKey), 'utf8'));
          beatTs = beat && Number.isFinite(beat.ts) ? beat.ts : null;
        } catch (_) { beatTs = null; }
        const health = ingestHealthMod.daemonHealth(home, repoKey, { now });
        if (health.status === 'stale') staleBanner = ingestHealthMod.buildStaleBanner(beatTs, now);
      }

      // D26 (Phase 8 step 3): mesh DIRECT surfacing. A mesh direct addressed to
      // this CHILD's meshId (D19) lands, via the mesh addressing join, in the
      // child's OWN builder-id partition inside the shared store — but the
      // child's mechanical read surfaces (this hook) previously read ONLY the
      // durable NDJSON inbox (unreadInfo below), so a mesh direct was never
      // seen. Read the SAME shared summaries/<repoKey>.json projection the
      // Primary reads, for THIS child's OWN builder-id entry's
      // directUnread/urgencyMax, and render the SAME urgency-tiered nudge
      // (D4) — projection-only, fail-open, no store DB open.
      if (repoKey) {
        const id = env.DEVSWARM_BUILDER_ID;
        if (typeof id === 'string' && isSafeId(id)) {
          try {
            const p = path.join(devswarmRoot(home), 'summaries', repoKey + '.json');
            const raw = String(fs.readFileSync(p, 'utf8')).trim();
            const summary = raw ? JSON.parse(raw) : null;
            const entry = summary && summary.workspaces && summary.workspaces[id];
            const directUnread = entry && Number.isFinite(entry.directUnread) ? entry.directUnread
              : (entry && Number.isFinite(entry.unread) ? entry.unread : 0);
            if (directUnread > 0) {
              meshDirectSegment = buildMeshDirectSegment(directUnread, id, entry.urgencyMax || null);
            }
            if (entry && entry.archive_requested) {
              archiveRequestedId = id;
            }
          } catch (_) { meshDirectSegment = null; }
        }
      }
    }
  } catch (_) { staleBanner = null; meshDirectSegment = null; archiveRequestedId = null; }

  // REMINDER is always present; append the unread-inbox nudge only when the child's
  // durable descriptor inbox actually has unread parent message(s) (empty-when-zero).
  const segments = [];
  if (staleBanner) segments.push(staleBanner);
  segments.push(OVERRIDE_REASSERT, REMINDER, RECEIVE_NUDGE);
  if (meshDirectSegment) segments.push(meshDirectSegment);
  const info = unreadInfo(env, home);
  let archiveSegmentPushed = false;
  if (info) {
    segments.push(buildUnreadSegment(info));
    if (info.lines.some((l) => typeof l === 'string' && l.includes(ARCHIVE_REQUEST_MARKER))) {
      segments.push(buildArchiveRequestSegment(info.id));
      archiveSegmentPushed = true;
    }
  }
  // v0.58 (item 6): the store-projected archive_requested flag surfaces the SAME
  // segment as the NDJSON-marker path above, deduped so a turn with both signals
  // present never double-pushes it.
  if (archiveRequestedId && !archiveSegmentPushed) {
    segments.push(buildArchiveRequestSegment(archiveRequestedId));
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: segments.join('\n\n'),
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: any error -> no block, no crash.
}
process.exit(0);
