'use strict';
// anti-hall :: devswarm-wake-watch — a PURE-READ Monitor() watcher for DevSwarm
// mesh mail (KB-claude-monitor-tool.md). One watcher per orchestrator: one for
// the Primary, one per child workspace. Inbound daemon->orchestrator wake is
// this Monitor watcher; outbound orchestrator->daemon heartbeat MUST NOT move
// here (a daemon-written heartbeat would keep reading "fresh" even while the
// session it represents is wedged — devswarm-child-turn.js's "Heartbeat
// authorship rule"). Destructive/mutating work stays where it already lives
// (the daemon, hivecontrol, scripts/devswarm.js).
//
// ============================================================================
// THE TRAP THIS FILE MUST NEVER FALL INTO
// ============================================================================
// This watcher must never invoke, shell out to, or require-and-call anything
// that consumes/acks the very unread signal it exists to surface. Concretely:
// no CLI subcommand that marks a mailbox read, pulls/drains a native queue,
// reads-then-acks a mesh row, or force-acks a roster entry. Calling any of
// those here would be a SELF-ERASING WAKE: the watcher destroys its own
// trigger and the agent never learns anything. This module shells out to NO
// mutating command anywhere, ever — it only fs.statSync/readFileSync plain
// projection files that scripts/devswarm.js and the store layer already
// produce as read-only artifacts. A source-scan test (see the paired test
// file) asserts the five forbidden verb phrases never appear in this file's
// own text (including comments) as a regression guard — so this comment
// deliberately never spells them out verbatim.
//
// This module also NEVER opens the SQLite store directly — "HOOKS NEVER OPEN
// THE DB" (devswarm-store.js / devswarm-inbox-paths.js). It reads only the
// already-DERIVED projection: summaries/<hash>.json (written atomically by
// deriveSummary — tmp+rename, so a read here can never observe a torn file)
// and, for a child, its own durable inbox NDJSON + cursor file. It never reads
// store/<hash>/devswarm.db(+ -wal/-shm) or store/<hash>/journal/*.ndjson.
//
// ============================================================================
// v1 SCOPE — DIRECTS ONLY. BROADCASTS ARE AN EXPLICIT, DOCUMENTED GAP.
// ============================================================================
// This watcher edge-triggers ONLY on a workspace's own DIRECT message total
// (workspaces[<id>].total for the Primary; the child's own inbox NDJSON count
// for a child). It intentionally does NOT watch the shared broadcast feed
// (summary.recent[]) for new roster-wide broadcasts.
//
// Why not: `recent[]` is capped (default 50) and, measured live on a real
// project, was observed holding 49 rows from ONE idle sender's heartbeat
// broadcast (same body, ~285s cadence, 1182 accumulated rows over 5.25 days)
// and only 1 row from everyone else combined. That is the NORMAL steady state,
// not a pathological edge case — heartbeats are broadcasts too, sent to the
// same shared partition. A diff-over-`recent[]` design would silently evict
// genuine broadcasts behind duplicate heartbeat noise and LOOK like it works
// while dropping real messages. An honest gap beats a false guarantee, so v1
// ships directs-only. Covering broadcasts correctly needs either an uncapped/
// dedicated broadcast counter or a heartbeat-excluding store projection change
// — both out of scope for this file (store projection changes are owned
// elsewhere).
//
// One direct benefit of directs-only scope: heartbeats live entirely in the
// broadcast partition and NEVER touch workspaces[<id>].total (computeSummary
// derives `total` from `store.messageCount(d.id)`, the workspace's own DIRECT
// partition — BROADCAST_PARTITION_ID is explicitly skipped in that loop). So
// this watcher is immune to heartbeat-flood noise BY CONSTRUCTION, not by a
// filter that could regress — see the paired test's heartbeat-immunity case.
//
// ============================================================================
// IDENTITY FOOTGUN — id vs meshId, do not cross them
// ============================================================================
// A workspace descriptor / roster row carries TWO different ids:
//   - `id`     — the descriptor id used as the summary's `workspaces` MAP KEY.
//                For a child this is DEVSWARM_BUILDER_ID (a UUID). For the
//                real Primary this is `primary-<8hex worktree hash>`.
//   - `meshId` — always `primary-<worktree hash>`, derived from the CALLER's
//                own worktree. This is a SENDER identity (what you'd address a
//                message FROM/TO), not a `workspaces[...]` lookup key. A child
//                has one too, and it looks exactly like a Primary's `id` would
//                — do not use it as a lookup key for a child's own total.
// This file only ever looks up `workspaces[id]` (never `workspaces[meshId]`),
// and only ever derives `id` via DEVSWARM_BUILDER_ID (child) or
// primaryWorkspaceId(resolveMainWorktree(cwd)) (Primary) — see resolveIdentity.
//
// ============================================================================
// Structure: a PURE core (tick + its helpers — no fs/clock/process/random) and
// an IO runner around it (identity resolution once at startup, then a plain
// read-parse-tick loop). Both live in this one file and are both exported so
// the pure half is directly unit-testable.
//
// ============================================================================
// STAT-GATE OMISSION — deliberate, reviewed; do not re-add as an "optimization"
// ============================================================================
// The loop below is a plain read-parse-tick loop, NOT a stat-gate-then-parse
// loop, even though an earlier design sketch called for stat-gating (statSync
// the summary/NDJSON file's mtime+size first, re-parsing only on a change)
// before every parse. That gate was deliberately dropped: an mtime/size-based
// gate risks the exact failure this whole feature exists to prevent — a
// MISSED WAKE — whenever mtime granularity or a same-tick write that happens
// to leave size unchanged makes a genuinely new message look like "nothing
// changed." Measured re-parse cost against a real summary file was ~0.058ms —
// negligible against POLL_MS (default 2000ms) — so a stat-gate would only buy
// an unnecessary re-parse avoidance, at the cost of a narrow but real chance
// of silently missing a wake. Reviewed and agreed on the merits: always parse,
// never gate on stat.
//
// ============================================================================
// EXTERNAL PROJECTION DEPENDENCY — what refreshes the data this file reads
// ============================================================================
// This file never derives anything itself; it only reads whatever is
// CURRENTLY on disk. What keeps that data fresh differs by role:
//
// Primary: reads summaries/<hash>.json. A mesh-direct send (`send --to` /
// `--to-primary`) calls store.deriveSummary in the SAME operation that
// appends the message (scripts/devswarm.js cmdSend), so that path is never
// stale relative to the store. But messages arriving via the Primary's
// NATIVE hivecontrol queue only reach the store — and therefore the summary,
// and therefore this watcher — once companion/devswarm-ingest.js's daemon
// (the ONE consumer of that queue, Primary-scoped) drains and
// re-derives. If that daemon is not running, those messages sit undrained,
// invisible to the store and to this watcher, until the daemon (re)starts
// and catches up. This watcher's silence in that window is a faithful read
// of an unprojected store, not a bug here — this file assumes no minimum
// number of healthy ingest daemons and has no daemon-liveness logic of its
// own.
//
// Child: reads ONLY its own durable inbox NDJSON (readUnread over
// inboxPath/cursorPath) — it never reads the store or any summary file for a
// child. That NDJSON is populated exclusively by the child-side one-shot
// bounded native-queue drain CLI verb (companion/lib/devswarm-pull.js
// pullOnce — see this module's own opening comment for why that verb, unlike
// the forbidden ones, is safe: count-gated, at-most-one bounded read, never
// a blocking monitor call), which folds the native parent->child hivecontrol
// queue into the NDJSON. Nothing runs that drain on a fixed schedule: the
// per-turn child-side reminder is advisory text only — the hook that prints
// it deliberately never spawns hivecontrol itself on the per-turn hot path —
// so the drain happens only when the agent acts on that reminder, or when a
// supervisor/doctor reconcile sweep runs it as a subprocess per registered
// worktree. A child's arrival latency for native-queue traffic is therefore
// bounded by whichever of those two runs next, NOT by this watcher's poll
// interval — a live watcher can sit correctly silent for an arbitrarily long
// stretch if neither one runs.
//
// Separately: a mesh-direct message addressed to a child
// (store.appendMeshMessage via a mesh `send --to <childId>`) is written ONLY
// into the shared store's partition for that child's id — never into any
// NDJSON file. THIS IS NOW COVERED (previously a documented blind spot; fixed
// below): scripts/devswarm.js cmdSend opens store.openStore({..., hash:
// repoKey}) and calls store.deriveSummary(...) in the SAME call that appends
// the message — no daemon or drain in between — so the child's own
// `workspaces[<childId>].total` in that project's summaries/<repoKey>.json
// advances in lockstep with the send, exactly the guarantee the Primary path
// already relied on. The child-role watcher now ALSO reads that summary
// (readPrimarySnapshot reused verbatim, keyed by the child's OWN id via the
// same repoKey-then-legacy-hash two-probe — see readChildCombinedSnapshot),
// IN ADDITION TO its existing NDJSON read. The two channels are independent:
// the NDJSON read remains the ONLY channel for the separate native
// hivecontrol-queue traffic (still bounded by pullOnce/reconcile-sweep drain
// timing as described above); the summary read is the ONLY channel for a
// mesh-direct `send --to <childId>`. Each keeps its own seen-cursor in state,
// and a single tick emits exactly one line even when both advance together.
//
// ============================================================================
// SUPERVISOR PARENT-ESCALATION VISIBILITY
// ============================================================================
// A supervisor escalation (recovery.js notifyParentEscalation) appends into
// `workspaceId: parentId` — the PARENT'S OWN partition key, the SAME key
// computeSummary's workspaces loop iterates and messageCount(id) counts by.
// So an escalation DOES increment `workspaces[parentId].total` and IS
// visible to a `workspaces[<id>].total`-keyed watcher like this one, for any
// Primary whose own `primary-<hash>` id is registered in that store — true
// whenever its native-queue ingest daemon has ever started (it
// self-registers its own primary id at startup) or `register-primary` was
// run. This file previously assumed escalations land in a separate/legacy
// partition the Primary two-probe exists to reach; that assumption was
// checked against the actual append call and is WRONG — do not reintroduce
// it.
//
// There is exactly one genuine boundary, and it is a SHAPE limit, not a bug
// in the escalation write itself: if the parent's own id was NEVER
// registered in that store, computeSummary's workspaces loop never visits
// it at all, and the escalation instead surfaces only in `orphans[]`
// (unregistered-partition detection) — which v1 deliberately does not read
// (see below for why). This is permanent until orphans[] coverage is added,
// separate from and NOT to be confused with a second, independent,
// currently-true DEFECT elsewhere: notifyParentEscalation never re-derives
// the summary after its append (no re-derive call anywhere in that
// function or its caller), so even a correctly-keyed escalation sits
// unprojected until something else re-derives that store — being fixed in
// a separate workspace. One is a shape limit this file cannot fix; the
// other is a missing-refresh defect this file did not cause and cannot fix
// either, but the two must not be described as the same thing.
//
// orphans[] is deliberately NOT read here. `orphans.push` is gated on
// `unread > 0` (devswarm-store.js) — the array is UNREAD-gated, so an
// orphaned partition's entry disappears the moment its unread count reaches
// zero (e.g. once read/acked). That makes `orphans[].messageCount` not
// cleanly monotonic from a consumer's point of view (an entry can pop in
// and back out), unlike `workspaces[].total`, which this file's whole
// edge-trigger design depends on being append-only and never decremented.
// Edge-triggering on orphans[] safely would need materially more care than
// this file's current design. Deferred as a clean follow-up if the
// unregistered-parent case is ever observed live — not attempted here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const role = require('../../hooks/lib/devswarm-role.js');
const supervisor = require('../devswarm-supervisor.js');
const ingest = require('../install-devswarm-ingest.js');
const store = require('./devswarm-store.js');
const repokey = require('./devswarm-repokey.js');
const pull = require('./devswarm-pull.js');
const inboxCursor = require('./devswarm-inbox-cursor.js');
const { devswarmRoot } = require('./liveness.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;
const POLL_MS_MIN = 250;
const POLL_MS_MAX = 60000;
const POLL_ENV_VAR = 'ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS';

// ERROR_TOLERANCE consecutive failed ticks are silent; the (ERROR_TOLERANCE+1)th
// emits immediately, then repeats are gated by ERROR_BACKOFF_MS: 1min, then
// 5min, then 30min-forever (index clamped at the last entry).
const ERROR_TOLERANCE = 3;
const ERROR_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

// A watcher lock is long-lived (the whole Monitor's persistent lifetime), not
// a one-shot pull's — but acquireExclLock's steal rule never touches a
// live-pid holder regardless of staleMs (see devswarm-pull.js), so this only
// governs recovery from a genuinely crashed watcher that never released.
const WATCH_LOCK_STALE_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// PURE CORE
// ---------------------------------------------------------------------------

// normalizeState(state) -> a well-shaped state object. Never throws; any
// missing/malformed field falls back to a safe default so a garbage `state`
// argument degrades to "fresh watcher" instead of crashing.
function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    armed: !!s.armed,
    lastTotal: Number.isFinite(s.lastTotal) ? s.lastTotal : 0,
    // lastTotal2 — a SECOND, INDEPENDENT edge-trigger cursor, used only by the
    // child role's mesh-direct (summary) channel alongside its existing
    // lastTotal (NDJSON/native-queue channel). Never summed/conflated with
    // lastTotal — they count two disjoint message sources. Primary snapshots
    // never carry a `total2`, so this field simply never moves for Primary.
    lastTotal2: Number.isFinite(s.lastTotal2) ? s.lastTotal2 : 0,
    consecErrors: Number.isFinite(s.consecErrors) ? s.consecErrors : 0,
    errorBackoffIdx: Number.isFinite(s.errorBackoffIdx) ? s.errorBackoffIdx : 0,
    lastErrorEmitMs: Number.isFinite(s.lastErrorEmitMs) ? s.lastErrorEmitMs : null,
  };
}

// formatArmLine(snapshot) -> string. Emitted exactly once, on the very first
// tick, regardless of ok/error/total — proves the watcher is alive so later
// silence genuinely means "nothing new" (KB §3: silence is not success).
function formatArmLine(snapshot) {
  const r = (snapshot && snapshot.role) || 'unknown';
  const id = (snapshot && snapshot.id) || 'unknown';
  return '[wake-watch] armed: watching ' + r + ' ' + id
    + ' for new direct mesh mail (read-only, poll-based; broadcasts not covered in v1).';
}

// formatWakeLine(snapshot, prevTotal, total, opts) -> string. The actionable
// line — tells the agent WHAT happened and what to do next, without the
// watcher ever running that drain itself. `opts.channelLabel` (optional) names
// WHICH channel moved (e.g. 'ndjson' / 'mesh-direct') for a dual-channel child
// snapshot; omitted entirely (undefined `opts`) for the single-channel Primary
// case, which preserves the EXACT original wording byte-for-byte.
//
// EMIT-CONTRACT RULE (encoded here deliberately, not incidentally): never
// decorate an event with a field that was not derived from the SAME
// observation that produced the event. Concretely, this function reads
// nothing from `snapshot` except role/id (identity, constant across ticks)
// and the two total counters passed in explicitly — it never reaches for
// `snapshot.working_on` or any other field that describes a DIFFERENT event
// (e.g. a workspace's `working_on` is the last HEARTBEAT summary text, not the
// body of whatever new direct message just landed; attaching it would show
// confidently-wrong context — three different real messages could all render
// with the SAME stale trailing text). An honest line with only the id + delta
// beats a decorated line with the wrong content. If per-message content is
// ever added, it must come from the SAME parsed projection at THIS emit for
// THIS specific delta, or be omitted entirely. Same rule applies to the arm
// and error lines below: each reports only what that tick's own observation
// actually saw.
function formatWakeLine(snapshot, prevTotal, total, opts) {
  const r = (snapshot && snapshot.role) || 'unknown';
  const id = (snapshot && snapshot.id) || 'unknown';
  const delta = total - prevTotal;
  const label = (opts && opts.channelLabel) ? (String(opts.channelLabel) + ' ') : '';
  return '[wake-watch] new mesh mail for ' + r + ' ' + id + ': ' + label + 'direct total ' + prevTotal
    + ' -> ' + total + ' (+' + delta + '). Drain your own inbox on your next turn.';
}

// formatDualWakeLine(snapshot, prevTotal, total, prevTotal2, total2) -> string.
// Used ONLY when BOTH the child's channels advance in the SAME tick — collapses
// what would otherwise be two separate wake lines into exactly one, naming both
// channels and both deltas honestly (same emit-contract rule as formatWakeLine:
// every value here comes from THIS tick's own two reads, nothing decorative).
function formatDualWakeLine(snapshot, prevTotal, total, prevTotal2, total2) {
  const r = (snapshot && snapshot.role) || 'unknown';
  const id = (snapshot && snapshot.id) || 'unknown';
  const delta = total - prevTotal;
  const delta2 = total2 - prevTotal2;
  return '[wake-watch] new mesh mail for ' + r + ' ' + id + ': ndjson total ' + prevTotal + ' -> ' + total
    + ' (+' + delta + '), mesh-direct total ' + prevTotal2 + ' -> ' + total2 + ' (+' + delta2 + '). '
    + 'Drain your own inbox on your next turn.';
}

// formatErrorLine(snapshot, consecErrors) -> string. Edge-triggered (never
// every tick) — see the backoff schedule in tickInner.
function formatErrorLine(snapshot, consecErrors) {
  const r = (snapshot && snapshot.role) || 'unknown';
  const id = (snapshot && snapshot.id) || 'unknown';
  const err = (snapshot && snapshot.error) || 'unknown read error';
  return '[wake-watch] ERROR watching ' + r + ' ' + id + ': ' + consecErrors
    + ' consecutive read failures (' + err + '). Watcher still alive; will keep retrying.';
}

// tickInner — the real logic. Never call directly from a runner; wrapped by
// tick() below so a thrown exception here can never escape and end the loop.
function tickInner(state, snapshot) {
  const st = normalizeState(state);
  const lines = [];
  const now = snapshot && Number.isFinite(snapshot.nowMs) ? snapshot.nowMs : Date.now();
  const firstTick = !st.armed;
  if (firstTick) {
    st.armed = true;
    lines.push(formatArmLine(snapshot));
  }

  const ok = !!(snapshot && snapshot.ok !== false);

  if (!ok) {
    st.consecErrors += 1;
    if (st.consecErrors > ERROR_TOLERANCE) {
      const tier = Math.min(st.errorBackoffIdx, ERROR_BACKOFF_MS.length - 1);
      const wasFirstEmission = st.lastErrorEmitMs === null;
      const dueMs = wasFirstEmission ? 0 : ERROR_BACKOFF_MS[tier];
      const due = wasFirstEmission || (now - st.lastErrorEmitMs) >= dueMs;
      if (due) {
        lines.push(formatErrorLine(snapshot, st.consecErrors));
        if (!wasFirstEmission) {
          // The immediate first emission does not consume a backoff tier —
          // only a REPEAT that actually waited one out advances the schedule
          // (1min -> 5min -> 30min-forever).
          st.errorBackoffIdx = Math.min(st.errorBackoffIdx + 1, ERROR_BACKOFF_MS.length - 1);
        }
        st.lastErrorEmitMs = now;
      }
    }
    return { state: st, lines };
  }

  // Recovery — reset error state SILENTLY (no line; KB: "recover silently
  // when reads succeed again").
  if (st.consecErrors > 0) {
    st.consecErrors = 0;
    st.errorBackoffIdx = 0;
    st.lastErrorEmitMs = null;
  }

  // Edge-trigger on a monotonic total delta ONLY (directs-only v1 scope).
  // Dropping any additional "unread > 0" gate is deliberate — total already
  // only advances when a genuinely new direct message lands (append-only,
  // never decremented), so gating on it too adds no safety and only risks a
  // missed wake in a narrow ack-race window. Ack-driven unread flapping can
  // never cause a false fire here because total never moves on an ack alone.
  //
  // TWO INDEPENDENT CHANNELS (child role only): `total` is the existing
  // NDJSON/native-queue channel; `total2` (only ever present on a child
  // snapshot — see readChildCombinedSnapshot) is the mesh-direct/summary
  // channel. A Primary snapshot never sets `total2` at all (missing key, not
  // null-vs-number), so `hasChannel2` is false and this collapses back to the
  // original single-channel behavior byte-for-byte. Each channel's own
  // "missing key ≠ zero" rule is preserved independently: a null total (resp.
  // total2) never advances that channel's cursor and never emits for it.
  const hasChannel2 = !!(snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'total2'));
  const total = snapshot && Number.isFinite(snapshot.total) ? snapshot.total : null;
  const total2 = snapshot && Number.isFinite(snapshot.total2) ? snapshot.total2 : null;

  const moved1 = total !== null && total > st.lastTotal;
  const moved2 = total2 !== null && total2 > st.lastTotal2;

  // SINGLE-EMIT RULE: when both channels advance in the same tick, this must
  // produce exactly ONE line (formatDualWakeLine), never two. Each channel's
  // cursor still advances independently below regardless of which line fired.
  if (moved1 && moved2) {
    lines.push(formatDualWakeLine(snapshot, st.lastTotal, total, st.lastTotal2, total2));
  } else if (moved1) {
    lines.push(formatWakeLine(snapshot, st.lastTotal, total, hasChannel2 ? { channelLabel: 'ndjson' } : undefined));
  } else if (moved2) {
    lines.push(formatWakeLine(snapshot, st.lastTotal2, total2, { channelLabel: 'mesh-direct' }));
  }

  if (moved1) st.lastTotal = total;
  if (moved2) st.lastTotal2 = total2;

  return { state: st, lines };
}

// tick(state, snapshot) -> { state, lines }. PURE: no fs, no clock read beyond
// snapshot.nowMs, no process, no randomness. Never throws — any internal
// failure (garbage/partial/null snapshot, corrupt state) degrades to a no-op
// tick (state passed through normalizeState, zero lines) rather than
// propagating, because an exception escaping the runner's loop would silently
// END the Monitor — the exact deaf failure this whole feature exists to
// prevent.
function tick(state, snapshot) {
  try {
    return tickInner(state, snapshot);
  } catch (_) {
    return { state: normalizeState(state), lines: [] };
  }
}

// ---------------------------------------------------------------------------
// IO HELPERS (runner side — fs/process/child_process touch points; each
// exported individually so tests can exercise them without spawning the full
// process loop)
// ---------------------------------------------------------------------------

// pollMsFromEnv(env) -> ms. Mirrors devswarm-wake.js's wakeCron() posture:
// charset-validate untrusted env input, fail OPEN to the default on anything
// malformed, clamp to a sane range. Digits only (no injection surface).
function pollMsFromEnv(env) {
  try {
    const raw = (env || process.env)[POLL_ENV_VAR];
    if (typeof raw !== 'string') return DEFAULT_POLL_MS;
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) return DEFAULT_POLL_MS;
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_MS;
    return Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, n));
  } catch (_) {
    return DEFAULT_POLL_MS;
  }
}

// realFormsOf(p, fsi) -> Set<string> of the raw-resolved AND realpath'd forms
// of `p`. GOTCHA (verified): descriptor.worktreePath is written via
// findGitToplevel() (devswarm-child-turn.js), which is NOT realpath'd, while
// the primary/hash identity path DOES realpath. Comparing both forms on BOTH
// sides is the only way a symlinked checkout doesn't silently fail to match.
function realFormsOf(p, fsi) {
  const F = fsi || fs;
  const forms = new Set();
  if (typeof p !== 'string' || p === '') return forms;
  let resolved;
  try { resolved = path.resolve(p); } catch (_) { return forms; }
  forms.add(resolved);
  try { forms.add(F.realpathSync(resolved)); } catch (_) { /* not on disk / no perms — raw form still compared */ }
  return forms;
}

// resolveIdentity(env, cwd, io) -> { role, id, home, cwd, descriptor?, mainWorktree? } | null.
// Env inheritance into a Monitor-spawned process is UNVERIFIED, so this never
// depends on it alone: DEVSWARM_SOURCE_BRANCH/DEVSWARM_BUILDER_ID are tried
// first, then a descriptor cwd-match fallback, then Primary as the default.
function resolveIdentity(env, cwd, io) {
  const ioo = io || {};
  const e = env || process.env;
  const wd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const F = ioo.fs || fs;
  const home = ioo.home || os.homedir();

  try {
    if (role.isChildWorkspace(e)) {
      const raw = e.DEVSWARM_BUILDER_ID;
      const bid = typeof raw === 'string' ? raw.trim() : '';
      if (bid) return { role: 'child', id: bid, home, cwd: wd };
    }
  } catch (_) { /* fall through to the descriptor-match fallback */ }

  try {
    const readDescriptors = ioo.readDescriptors || supervisor.readDescriptors;
    const descriptors = readDescriptors(home, F) || [];
    const cwdForms = realFormsOf(wd, F);
    for (const d of descriptors) {
      if (!d || !d.worktreePath || !d.id) continue;
      const dForms = realFormsOf(d.worktreePath, F);
      let hit = false;
      for (const f of cwdForms) { if (dForms.has(f)) { hit = true; break; } }
      if (hit) return { role: 'child', id: d.id, home, cwd: wd, descriptor: d };
    }
  } catch (_) { /* fall through to the Primary default */ }

  try {
    const resolveMainWorktree = ioo.resolveMainWorktree || ingest.resolveMainWorktree;
    const primaryWorkspaceId = ioo.primaryWorkspaceId || ingest.primaryWorkspaceId;
    const main = resolveMainWorktree(wd, ioo.gitIo);
    if (!main) return null;
    const id = primaryWorkspaceId(main);
    if (!id) return null;
    return { role: 'primary', id, home, cwd: wd, mainWorktree: main };
  } catch (_) {
    return null;
  }
}

// resolvePrimaryHashes(cwd, io) -> { repoKey, fallbackHash, primaryId } | null.
// TWO-PROBE, replicating scripts/devswarm.js cmdRoster's own fold (repoKey
// bucket first, legacy primary-<8hex> hash bucket as fallback) — NOT optional.
// A supervisor parent-escalation currently still writes the LEGACY hash bucket
// until that projection gap is closed elsewhere (out of scope here), so a
// Primary watcher that only ever checked the repoKey bucket could silently
// miss an escalation. Called ONCE at startup (git spawn is cheap but not free
// enough to repeat every poll tick).
function resolvePrimaryHashes(cwd, io) {
  const ioo = io || {};
  const repoKeyForWorktree = ioo.repoKeyForWorktree || repokey.repoKeyForWorktree;
  const resolveMainWorktree = ioo.resolveMainWorktree || ingest.resolveMainWorktree;
  const primaryWorkspaceId = ioo.primaryWorkspaceId || ingest.primaryWorkspaceId;
  const hashFromWorkspaceId = ioo.hashFromWorkspaceId || store.hashFromWorkspaceId;

  let repoKey = null;
  try { repoKey = repoKeyForWorktree(cwd, ioo.gitIo ? { io: ioo.gitIo } : undefined); } catch (_) { repoKey = null; }

  let primaryId = null;
  let fallbackHash = null;
  try {
    const main = resolveMainWorktree(cwd, ioo.gitIo);
    if (main) {
      primaryId = primaryWorkspaceId(main);
      if (primaryId) fallbackHash = hashFromWorkspaceId(primaryId);
    }
  } catch (_) { /* leave primaryId/fallbackHash null */ }

  if (!repoKey && !fallbackHash) return null;
  return {
    repoKey: repoKey || null,
    fallbackHash: (fallbackHash && fallbackHash !== repoKey) ? fallbackHash : null,
    primaryId,
  };
}

// resolveChildHashes(cwd, childId, io) -> { repoKey, fallbackHash } | null.
// The CHILD-side counterpart of resolvePrimaryHashes — same repoKey-bucket-
// first, legacy-hash-bucket-fallback two-probe, but keyed by the CHILD's OWN
// id (never primaryId/meshId). Verified (devswarm-repokey.js): repoKey derives
// from `--git-common-dir`, which is IDENTICAL across every worktree of one
// project (Primary and every child), so a child's cwd resolves to the SAME
// repoKey bucket scripts/devswarm.js cmdSend writes into via
// store.openStore({..., hash: repoKey}) + store.deriveSummary(...) in that
// same call. fallbackHash = hashFromWorkspaceId(childId) — the child's own
// legacy per-id bucket (parity with the Primary path's stranded-row case),
// suppressed when it would equal repoKey. Called once at startup, like its
// Primary counterpart.
function resolveChildHashes(cwd, childId, io) {
  const ioo = io || {};
  const repoKeyForWorktree = ioo.repoKeyForWorktree || repokey.repoKeyForWorktree;
  const hashFromWorkspaceId = ioo.hashFromWorkspaceId || store.hashFromWorkspaceId;

  let repoKey = null;
  try { repoKey = repoKeyForWorktree(cwd, ioo.gitIo ? { io: ioo.gitIo } : undefined); } catch (_) { repoKey = null; }

  let fallbackHash = null;
  try {
    if (childId) {
      const h = hashFromWorkspaceId(childId);
      if (h) fallbackHash = h;
    }
  } catch (_) { fallbackHash = null; }

  if (!repoKey && !fallbackHash) return null;
  return {
    repoKey: repoKey || null,
    fallbackHash: (fallbackHash && fallbackHash !== repoKey) ? fallbackHash : null,
  };
}

// readPrimarySnapshot(home, hashes, primaryId, io) -> { ok, error, total }.
// Reads the repoKey-bucket summary FIRST; falls back to the legacy hash bucket
// only when the primary's own row is absent there (mirrors cmdRoster's fold —
// see resolvePrimaryHashes). A MISSING summary file reads as "no data yet"
// (total: null), NEVER as "zero messages" (readSummaryForHash already returns
// null for an absent/unparseable file; this function must not coerce that into
// 0, or the first real message would look like a fabricated delta from zero).
function readPrimarySnapshot(home, hashes, primaryId, io) {
  const ioo = io || {};
  const readSummaryForHash = ioo.readSummaryForHash || store.readSummaryForHash;
  try {
    if (!hashes || !primaryId || (!hashes.repoKey && !hashes.fallbackHash)) {
      return { ok: false, error: 'unresolvable-repo-identity', total: null };
    }
    const a = hashes.repoKey ? readSummaryForHash(home, hashes.repoKey, ioo.fs) : null;
    const wa = a && a.workspaces && a.workspaces[primaryId];
    if (wa && Number.isFinite(wa.total)) return { ok: true, error: null, total: wa.total };

    const b = hashes.fallbackHash ? readSummaryForHash(home, hashes.fallbackHash, ioo.fs) : null;
    const wb = b && b.workspaces && b.workspaces[primaryId];
    if (wb && Number.isFinite(wb.total)) return { ok: true, error: null, total: wb.total };

    return { ok: true, error: null, total: null }; // no data yet, never zero
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'read-failed', total: null };
  }
}

// readChildSnapshot(paths, io) -> { ok, error, total }. `paths` = { inboxPath,
// cursorPath }. Uses readUnread() purely for its `.total` (a monotonic count
// of non-empty NDJSON lines) — this watcher never advances the cursor itself,
// never acks, never drains; that stays entirely the agent's/CLI's job.
function readChildSnapshot(paths, io) {
  const ioo = io || {};
  const readUnread = ioo.readUnread || inboxCursor.readUnread;
  try {
    const p = paths || {};
    const r = readUnread(p.inboxPath, p.cursorPath, ioo.fs);
    const total = r && Number.isFinite(r.total) ? r.total : null;
    return { ok: true, error: null, total };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'read-failed', total: null };
  }
}

// readChildCombinedSnapshot(paths, hashes, childId, home, io) -> { ok, error,
// total, total2 }. Combines the child's TWO independent read-only sources into
// one snapshot for tick(): `total` = the existing NDJSON/native-queue channel
// (readChildSnapshot, unchanged); `total2` = the mesh-direct/summary channel —
// REUSES readPrimarySnapshot verbatim (never duplicated), keyed by the
// child's OWN id instead of a primaryId. Each read is independent: `total2`
// stays null ("no data yet", never a fabricated zero) exactly when
// readPrimarySnapshot's own missing-key rule says so, regardless of what the
// NDJSON channel reports, and vice versa. `ok` is fail-closed AND (both reads
// must succeed) — a read exception on EITHER channel surfaces as one error tick,
// matching this module's existing single error-tolerance/backoff schedule
// rather than adding a second one.
function readChildCombinedSnapshot(paths, hashes, childId, home, io) {
  const ioo = io || {};
  const ndjson = readChildSnapshot(paths, ioo);
  const mesh = readPrimarySnapshot(home, hashes, childId, ioo);
  const ok = !!(ndjson.ok && mesh.ok);
  let error = null;
  if (!ndjson.ok && !mesh.ok) error = 'ndjson: ' + ndjson.error + '; mesh-direct: ' + mesh.error;
  else if (!ndjson.ok) error = 'ndjson: ' + ndjson.error;
  else if (!mesh.ok) error = 'mesh-direct: ' + mesh.error;
  return { ok, error, total: ndjson.total, total2: mesh.total };
}

// ---- persisted watcher-private "seen" cursor (SEPARATE from the agent's ack
// cursor — this file must never read/write the agent's own cursorPath as a
// write target, only as a read-only input via readUnread for the child case).

function seenPath(home, id) {
  return path.join(devswarmRoot(home), 'wake', String(id) + '.seen');
}

function loadSeenState(home, id, fsi) {
  const F = fsi || fs;
  try {
    const raw = String(F.readFileSync(seenPath(home, id), 'utf8'));
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && Number.isFinite(obj.lastTotal)) {
      // lastTotal2 (mesh-direct channel, child role only) persists ALONGSIDE
      // lastTotal — without this, a restart would re-baseline it to 0 and
      // falsely re-fire on every message the summary already reported before
      // the restart (the exact fabricated-delta-from-zero bug this file's
      // "missing key ≠ zero" rule elsewhere guards against).
      return { lastTotal: obj.lastTotal, lastTotal2: Number.isFinite(obj.lastTotal2) ? obj.lastTotal2 : 0 };
    }
  } catch (_) { /* absent/corrupt -> fresh baseline below */ }
  return { lastTotal: 0, lastTotal2: 0 };
}

function saveSeenState(home, id, state, fsi) {
  const F = fsi || fs;
  const p = seenPath(home, id);
  try {
    F.mkdirSync(path.dirname(p), { recursive: true });
    const payload = JSON.stringify({
      lastTotal: Number.isFinite(state && state.lastTotal) ? state.lastTotal : 0,
      lastTotal2: Number.isFinite(state && state.lastTotal2) ? state.lastTotal2 : 0,
    });
    const tmp = p + '.' + process.pid + '.tmp';
    F.writeFileSync(tmp, payload);
    F.renameSync(tmp, p);
  } catch (_) { /* best-effort; a failed persist only risks one re-notify after a restart, never a crash */ }
}

function lockPathFor(home, id) {
  return path.join(devswarmRoot(home), 'locks', 'wake-watch-' + String(id) + '.lock');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function emitLine(line) {
  const s = line.endsWith('\n') ? line : line + '\n';
  // fs.writeSync(1, …) not process.stdout.write — repo-wide rule: on macOS
  // node 18/20 a synchronous exit right after an async stdout write can race
  // the pipe flush and truncate output; writeSync is atomic (command-guard.js,
  // skills/update/scripts/update.js follow the same rule).
  fs.writeSync(1, s);
}

function main() {
  const env = process.env;
  const cwd = process.cwd();
  const identity = resolveIdentity(env, cwd, {});
  if (!identity) {
    try { process.stderr.write('[wake-watch] could not resolve a DevSwarm identity for cwd=' + cwd + '; exiting quietly.\n'); } catch (_) {}
    process.exitCode = 0;
    return;
  }

  const home = identity.home;
  const id = identity.id;
  const watchedRole = identity.role;

  const lockPath = lockPathFor(home, id);
  const release = pull.acquireExclLock(lockPath, {}, WATCH_LOCK_STALE_MS);
  if (!release) {
    // Double-arm refused. MUST write to stderr only, zero stdout — stdout is
    // what wakes the agent, so a refused double-arm must fire ZERO events.
    try {
      process.stderr.write('[wake-watch] another watcher already holds the lock for '
        + watchedRole + ' ' + id + '; exiting quietly (not double-arming).\n');
    } catch (_) {}
    process.exitCode = 0;
    return;
  }

  let paths = null;
  let hashes = null;
  if (watchedRole === 'child') {
    const d = identity.descriptor || {};
    paths = {
      inboxPath: d.inboxPath || pull.inboxDefaultPath(home, id),
      cursorPath: d.cursorPath || pull.cursorDefaultPath(home, id),
    };
    // Second, independent channel: the mesh-direct/summary bucket keyed by
    // this child's OWN id (see resolveChildHashes / readChildCombinedSnapshot).
    hashes = resolveChildHashes(cwd, id, {});
  } else {
    hashes = resolvePrimaryHashes(cwd, {});
  }

  let st = normalizeState(loadSeenState(home, id, fs));
  const pollMs = pollMsFromEnv(env);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { saveSeenState(home, id, st, fs); } catch (_) {}
    try { release(); } catch (_) {}
  }
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  function loop() {
    let snapshot;
    try {
      snapshot = watchedRole === 'child'
        ? readChildCombinedSnapshot(paths, hashes, id, home, {})
        : readPrimarySnapshot(home, hashes, identity.id, {});
    } catch (e) {
      snapshot = { ok: false, error: (e && e.message) || 'snapshot-failed', total: null };
    }
    snapshot.role = watchedRole;
    snapshot.id = id;
    snapshot.nowMs = Date.now();

    const res = tick(st, snapshot);
    st = res.state;
    for (const line of res.lines) {
      try { emitLine(line); } catch (_) { /* never let an output error kill the loop */ }
    }
    try { saveSeenState(home, id, st, fs); } catch (_) {}

    setTimeout(loop, pollMs);
  }
  loop();
}

module.exports = {
  // pure core
  tick,
  normalizeState,
  formatArmLine,
  formatWakeLine,
  formatDualWakeLine,
  formatErrorLine,
  ERROR_TOLERANCE,
  ERROR_BACKOFF_MS,
  // IO helpers
  pollMsFromEnv,
  realFormsOf,
  resolveIdentity,
  resolvePrimaryHashes,
  resolveChildHashes,
  readPrimarySnapshot,
  readChildSnapshot,
  readChildCombinedSnapshot,
  seenPath,
  loadSeenState,
  saveSeenState,
  lockPathFor,
  DEFAULT_POLL_MS,
  POLL_ENV_VAR,
};

if (require.main === module) main();
