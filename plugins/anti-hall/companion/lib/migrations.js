'use strict';
// anti-hall :: migrations — THE ONE registry of the all-store DevSwarm
// forward-migrations and their completion markers (mesh redesign Phase 4).
//
// WHY: the same all-store migrations used to run from doctor UNMARKED (a full
// scan of every store on every `doctor` call — a large part of the measured
// 722-1023 s doctor wall time) while `update` and the supervisor ran them
// behind a per-version stamp in ~/.anti-hall/update-sweep-state.json. Two
// schedules, two notions of "done". Now:
//   - this file lists each migration once ({id, key, fn, detect}),
//   - the marker store is ONE file (update-sweep-state.json, the file update.js
//     and the supervisor already stamp), read/written only through here,
//   - `doctor --repair` runs runMigrations() — a marked entry is skipped with an
//     O(1) marker read, an unmarked one gets ONE live scan and is stamped only
//     when isRunComplete() says nothing is left (the bootstrap rule: never infer
//     "already migrated" from data shape — only an explicit marker write counts),
//   - update.js's throttled per-store stages honour the SAME keys and hand their
//     results to recordRun(), and the supervisor's deferred sweep calls those
//     stages, so all three share ONE definition of "done for this version".
//
// CONTRACT for every default entry: idempotent, fail-open (a per-store error is
// counted, never thrown, and blocks the marker so the next run retries),
// NO-DELETE of messages or files (rows are forwarded before any registry row is
// tombstoned). An entry that REMOVES registry rows without a forward-then-
// tombstone survivor (a deletion-class repair) is `optIn: true` and is NEVER in
// the default set — opting into `--repair` is not opting into deletion-class
// repairs (defect df54edf54804: re-retire-resurrected once ran from bare doctor
// and removed rows with no operator intent).

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- marker store --------------------------------------------------------
function markerPath(home) { return path.join(home || os.homedir(), '.anti-hall', 'update-sweep-state.json'); }

// readMarkers(home) -> plain object, fail-open (missing/corrupt/non-object -> {}).
function readMarkers(home) {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath(home), 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

// writeMarkers(home, state) -> bool. Atomic (tmp + rename); a failure is
// swallowed — the next run simply re-scans instead of trusting a missing stamp.
function writeMarkers(home, state) {
  try {
    const file = markerPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

function isApplied(state, key, version) {
  const s = state && state[key];
  return !!(version && s && s.completedVersion === version);
}

// markApplied(home, key, version) -> bool. Re-reads the file first so a
// concurrent writer's other keys are kept (read-modify-write of one key).
function markApplied(home, key, version) {
  if (!version) return false;
  const state = readMarkers(home);
  state[key] = Object.assign({}, state[key], {
    completedVersion: version, completedTs: Date.now(), pendingVersion: null, pendingHashes: [], lastCompletedHash: null,
  });
  return writeMarkers(home, state);
}

// ---- the ONE completeness predicate ----------------------------------------
// A migration pass is DONE for a version only when nothing is left that a
// re-run could still do. This is the ONLY place that decides it, and
// recordRun() below the ONLY place that stamps a per-version marker for a
// registry entry — stages (update.js, the supervisor's deferred sweep, doctor)
// just hand over their raw result shape.
//
// NOT done when any of:
//   ok === false | errors > 0          a store/row failed; the next run retries
//   budgetExhausted                    a resume list was written; work remains
//   pendingRows > 0                    rows the pass knows it has not processed
//   forwardFailed (array or count) > 0 unread that could not be forwarded yet
//   left[] entry with a RETRYABLE reason — anything not in the TERMINAL list
//     below. An unknown reason counts as retryable, so a new reason can only
//     delay a stamp, never bless unfinished work.
// A reason is TERMINAL only if the answer can never become "doable" for THIS
// migration later. Anything derived from current, changeable state (a worktree
// that may disappear, a session that may end, a lock, a race) is retryable —
// stamping on it would skip that work forever at this version.
// `left` entries that are bare ids (no reason; foldMeshDuplicates' descriptor-
// backed survivors) are terminal for the same reason as 'live-descriptor'.
// `pending` is deliberately NOT read: foldArchivedRegistryRows reuses it for
// the RETIRED count on an applying run (scripts/devswarm.js `if (!dryRun)
// out.pending = out.retired.length`), so it is not a remaining-work signal.
const TERMINAL_LEFT_REASONS = new Set([
  // A DIFFERENT, real-session descriptor backs the row: it is an active
  // workspace, never this migration's work. If that workspace is archived
  // later, cmdArchive's whole-group retire (retireArchivedWorktreeGroup)
  // handles it at archive time — this forward-migration never needs to.
  'live-descriptor',
  // The archived/<id>.json tombstone already holds DIFFERENT bytes: the
  // never-clobber rule refuses forever; only a human can reconcile it.
  'archived-tombstone-differs',
  // The mesh anchor has reader evidence; reader_cursors are MAX-only, so that
  // evidence can never go away and the anchor can never become unattended.
  'mesh-anchor-attended',
]);
// Deliberately RETRYABLE (can become doable later):
//   'live-or-unprovable-worktree' — the worktree may be removed later.
//   'descriptor-no-live-session'  — the session may be promoted/ended later.
//   'lock-busy', 'raced-re-register', 'forward-failed', 'row-unreadable',
//   'descriptor-changed-since-scan', 'descriptor-unreadable-at-retire',
//   'retire-failed: …' — transient.

function isRetryableLeft(x) {
  if (x == null || typeof x !== 'object') return false; // bare id: terminal
  return !TERMINAL_LEFT_REASONS.has(String(x.reason || ''));
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// incompleteReasons(result) -> string[]. Why a pass is NOT done, with counts
// (empty = done). Surfaced verbatim in doctor rows and update stage details so
// an unstamped pass is never invisible.
function incompleteReasons(result) {
  const r = result;
  if (!r || typeof r !== 'object') return ['no result'];
  const out = [];
  if (r.ok === false) out.push('pass did not complete' + (r.error ? ' (' + r.error + ')' : ''));
  if (countOf(r.errors) > 0) out.push(countOf(r.errors) + ' error(s)');
  if (r.budgetExhausted) out.push('budget hit' + (countOf(r.skipped) ? ' (' + countOf(r.skipped) + ' deferred)' : '') + ' — resumes next run');
  if (countOf(r.pendingRows) > 0) out.push(countOf(r.pendingRows) + ' pending row(s)');
  if (countOf(r.forwardFailed) > 0) out.push(countOf(r.forwardFailed) + ' forward failure(s)');
  if (Array.isArray(r.left)) {
    const byReason = new Map();
    for (const x of r.left) {
      if (!isRetryableLeft(x)) continue;
      const k = String((x && x.reason) || 'unknown');
      byReason.set(k, (byReason.get(k) || 0) + 1);
    }
    if (byReason.size) out.push('retryable: ' + Array.from(byReason, ([k, n]) => k + '×' + n).join(', '));
  }
  return out;
}

// isRunComplete(result) -> bool.
function isRunComplete(result) { return incompleteReasons(result).length === 0; }

// recordRun(home, key, version, result) -> bool stamped. The ONLY stamper.
function recordRun(home, key, version, result) {
  if (!version || !isRunComplete(result)) return false;
  return markApplied(home, key, version);
}

// runBudgetMs(env) -> the wall-clock budget for one migration run: the SAME
// constant/env update.js's overall post-pull budget uses
// (ANTIHALL_UPDATE_POSTPULL_BUDGET_MS, default 90 s; 0 = unlimited).
const DEFAULT_RUN_BUDGET_MS = 90000;
function runBudgetMs(env) {
  const n = Number((env || process.env || {}).ANTIHALL_UPDATE_POSTPULL_BUDGET_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RUN_BUDGET_MS;
}

// pluginVersion() -> this plugin tree's own version (the marker's version key).
function pluginVersion() {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return pj && typeof pj.version === 'string' ? pj.version : null;
  } catch (_) { return null; }
}

// ---- the registry --------------------------------------------------------
// detect(dw, home, ctx) -> { pending, detail, notice?, raw } via the entry's
// own dry-run; `fn` is the devswarm.js export that applies it (the SAME
// function the dry-run called — one code path for detect and apply).
const MIGRATIONS = [
  {
    // defect #10 follow-up (backend-consistency marker leaves PRE-EXISTING
    // split stores' non-chosen side invisible). Merges the other physical
    // backend's messages/registry/cursors into the chosen one; NO-DELETE
    // (neither physical form is ever removed/renamed), idempotent (message
    // dedupe by hash/content, registry union, cursors max-only). Runs FIRST
    // so every later repair below sees one unified store, not a split one.
    id: 'merge-split-backend-stores',
    key: 'mergeSplitBackendStores',
    fn: 'mergeSplitBackendStoresAllStores',
    pendingIsUnfinished: true,
    detect(dw, home, ctx) {
      const r = dw.mergeSplitBackendStoresAllStores(home, Object.assign({}, ctx, { dryRun: true })) || {};
      return {
        pending: (r.pending || 0) > 0,
        raw: r,
        detail: (r.splitStores || 0) + ' split store(s) found across ' + (r.stores || 0) + ' store(s)'
          + (r.messagesMerged || r.registryMerged ? ' (' + (r.messagesMerged || 0) + ' message(s), ' + (r.registryMerged || 0) + ' registry row(s) only on the other side)' : '')
          + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
      };
    },
  },
  {
    id: 'fold-all-stores',
    key: 'foldAllStores',
    fn: 'foldMeshDuplicatesAllStores',
    pendingIsUnfinished: true,
    detect(dw, home, ctx) {
      const r = dw.foldMeshDuplicatesAllStores(home, Object.assign({}, ctx, { dryRun: true })) || {};
      return {
        pending: (r.retired || 0) > 0,
        raw: r,
        detail: (r.retired || 0) + ' duplicate mesh row(s) to fold across ' + (r.stores || 0) + ' store(s)'
          + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
      };
    },
  },
  {
    id: 'heal-orphan-partitions',
    key: 'healOrphanPartitions',
    fn: 'healOrphanPartitionsAllStores',
    pendingIsUnfinished: true,
    detect(dw, home, ctx) {
      const r = dw.healOrphanPartitionsAllStores(home, Object.assign({}, ctx, { dryRun: true })) || {};
      const n = (r.adopted || 0) + (r.forwarded || 0);
      return {
        pending: n > 0,
        raw: r,
        // archivedDrained/archivedStale are visibility only, never `pending`:
        // an archived-drained id has nothing to heal and an archived-stale id is
        // deliberately left un-forwarded (age cap).
        detail: (r.adopted || 0) + ' orphan partition(s) to adopt'
          + (r.forwarded ? ' + ' + r.forwarded + ' message(s) to forward' : '')
          + ' across ' + (r.stores || 0) + ' store(s), scope: all-stores'
          + (r.archivedDrained ? ' (' + r.archivedDrained + ' archived-drained, nothing to heal)' : '')
          + (r.archivedStale ? ' (' + r.archivedStale + ' archived-stale — past the age cap, detect-only)' : '')
          + (r.unhealable ? ' (' + r.unhealable + ' unhealable — no descriptor/family)' : '')
          + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
      };
    },
  },
  {
    id: 'fold-archived-rows',
    key: 'foldArchivedRows',
    fn: 'foldArchivedRegistryRows',
    honorsDeadline: true,
    detect(dw, home, ctx) {
      const r = dw.foldArchivedRegistryRows(home, Object.assign({}, ctx, { dryRun: true })) || {};
      const leftN = Array.isArray(r.left) ? r.left.length : 0;
      return {
        pending: (r.pending || 0) > 0,
        raw: r,
        detail: (r.pending || 0) + ' registry row(s) of archived workspace(s) to retire'
          + (leftN ? ' (' + leftN + ' safety-gated row(s) left in place)' : ''),
      };
    },
  },
  {
    id: 'fold-archived-family-descriptors',
    key: 'foldArchivedFamilyDescriptors',
    fn: 'foldArchivedFamilyDescriptors',
    honorsDeadline: true,
    detect(dw, home, ctx) {
      const r = dw.foldArchivedFamilyDescriptors(home, Object.assign({}, ctx, { dryRun: true })) || {};
      // Safety refusals (`left`) and errors are surfaced as a notice on every
      // path — a refusal must never read as "nothing to migrate". They do not
      // set `pending` (apply cannot clear them).
      const leftN = Array.isArray(r.left) ? r.left.length : 0;
      const errN = r.errors || 0;
      const notice = (leftN ? leftN + ' twin descriptor(s) left in place (safety-gated: '
          + r.left.map((x) => (x && x.reason) || 'unknown').join(', ') + ')' : '')
        + (errN ? (leftN ? '; ' : '') + errN + ' error(s)' : '')
        + (r.ok === false ? ((leftN || errN) ? '; ' : '') + 'pass did NOT complete: ' + (r.error || 'unknown') : '');
      return {
        pending: (r.pending || 0) > 0,
        raw: r,
        detail: (r.pending || 0) + ' orphaned twin descriptor(s) of archived workspace(s) to retire',
        notice: notice || null,
      };
    },
  },
  {
    // v0.106.1: floors pinned by the v0.106.0 reader_cursors import (every
    // live session on the machine declared on every partition; nd floor 0).
    // Retires (never deletes) the import-seeded rows of non-local/ended
    // sessions and recomputes the floor max-only — never below a local live
    // reader. Same pass as update.js's 'reader-floor-repair' stage.
    id: 'repair-reader-floors',
    key: 'repairReaderFloors',
    fn: 'repairReaderFloorsAllStores',
    detect(dw, home, ctx) {
      const r = dw.repairReaderFloorsAllStores(home, Object.assign({}, ctx, { dryRun: true })) || {};
      return {
        pending: (r.pending || 0) > 0,
        raw: r,
        detail: (r.pending || 0) + ' partition(s) with a reader floor pinned by the v0.106.0 import across ' + (r.stores || 0) + ' store(s)'
          + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : ''),
      };
    },
  },
  {
    // Dual-partition defect: an identity's anchor row and its DEVSWARM_BUILDER_ID
    // row on the same worktree hold the same sends, acked in only one of them.
    // Raises the other partition's floor through its contiguous prefix of sends
    // already consumed there — MAX-only, no delete.
    id: 'reconcile-dual-partition-acks',
    key: 'reconcileDualPartitionAcks',
    fn: 'reconcileDualPartitionAcksAllStores',
    detect(dw, home, ctx) {
      const r = dw.reconcileDualPartitionAcksAllStores(home, Object.assign({}, ctx, { dryRun: true })) || {};
      return {
        pending: (r.wouldRaise || 0) > 0,
        raw: r,
        detail: (r.rows || 0) + ' already-acked duplicate row(s) unread in ' + (r.wouldRaise || 0)
          + ' twin partition(s) across ' + (r.stores || 0) + ' store(s)'
          + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
      };
    },
  },
  {
    // v0.107.1: workspaces archived in the DevSwarm APP (its builders table:
    // isActive=0, isHidden=1) that anti-hall never learned about — writes the
    // existing archived/<id>.json marker for each ACTIVE descriptor the app DB
    // proves archived. Never-clobber, no-delete (descriptors untouched),
    // idempotent; no app DB on this machine = nothing to do.
    id: 'mark-app-archived',
    key: 'markAppArchived',
    fn: 'markAppArchivedDescriptors',
    detect(dw, home, ctx) {
      const r = dw.markAppArchivedDescriptors(home, Object.assign({}, ctx, { dryRun: true })) || {};
      return {
        pending: (r.pending || 0) > 0,
        raw: Object.assign({}, r, { pending: 0 }),
        detail: (r.pending || 0) + ' descriptor(s) of workspace(s) archived in the DevSwarm app to mark archived'
          + (r.appDb ? '' : ' (no DevSwarm app database found)')
          + (r.errors ? ' (' + r.errors + ' error(s), fail-open)' : ''),
      };
    },
  },
  {
    // DELETION-CLASS: removes registry rows (forwarding first where it can).
    // Opt-in ONLY via `doctor --repair-resurrected [--apply]`; update reports it
    // (dry-run) once per version. Never run by runMigrations().
    id: 're-retire-resurrected',
    key: 'reRetireResurrected',
    fn: 'reRetireResurrectedRowsAllStores',
    optIn: true,
    deletes: true,
  },
];

function defaultMigrations() { return MIGRATIONS.filter((m) => !m.optIn); }
function byId(id) { return MIGRATIONS.find((m) => m.id === id) || null; }

// runMigrations({ home, cwd, env, version, dryRun, devswarm, deadline, now }) -> [{id, action, status, msg}]
// BUDGET: one run is bounded by runBudgetMs(env) (or an explicit `deadline`).
// An entry that would START past the deadline is deferred whole (reported,
// unstamped). Entries with `honorsDeadline` (their pass reports budgetExhausted
// and keeps its own resume list) also get the deadline passed in; the all-store
// fold/heal passes do not — their all-stores aggregate does not report a
// per-store partial, so bounding them inside would risk an early stamp.
// Every unstamped pass reports WHY (incompleteReasons) in its row.
//   status ∈ 'fixed' | 'skipped' | 'failed' — the SAME row shape doctor-repair's
//   runRepairs pushes, so doctor renders these unchanged.
// Per default entry:
//   marked for `version`  -> skipped "already applied" (no scan)
//   detect: not pending   -> skipped "nothing to migrate"; stamped if isRunComplete
//   --dry-run             -> skipped "[dry-run] would migrate", no write
//   apply, re-detect      -> fixed (stamped if apply AND re-scan are complete) | failed
function runMigrations(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const version = o.version !== undefined ? o.version : pluginVersion();
  const dryRun = !!o.dryRun;
  const env = o.env || process.env;
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const budget = runBudgetMs(env);
  const deadline = Number.isFinite(o.deadline) ? o.deadline : (budget > 0 ? nowFn() + budget : Infinity);
  const out = [];
  let dw = o.devswarm || null;
  const state = readMarkers(home);
  for (const m of defaultMigrations()) {
    const push = (status, msg) => out.push({ id: m.id, action: m.id, status, msg });
    if (isApplied(state, m.key, version)) { push('skipped', 'already applied for ' + version + ' (marker)'); continue; }
    if (nowFn() >= deadline) {
      push('skipped', 'deferred — migration budget (' + budget + 'ms) used up before this entry started; not stamped, runs next time');
      continue;
    }
    const ctx = { cwd: o.cwd || process.cwd(), env };
    if (m.honorsDeadline && Number.isFinite(deadline)) ctx.deadline = deadline;
    try {
      if (!dw) dw = require(path.join(__dirname, '..', '..', 'scripts', 'devswarm.js'));
      if (typeof dw[m.fn] !== 'function') { push('skipped', 'build has no ' + m.fn); continue; }
      const before = m.detect(dw, home, ctx);
      const note = (d, s) => (d.notice ? s + ' — ' + d.notice : s);
      // unstamped(results...) -> '' when stamped, else " — not stamped, retries next run: <why>".
      // pendingIsUnfinished: this pass's `pending` counts rows it could NOT act
      // on (lock busy / survivor gone) — fed to the predicate as pendingRows.
      // Other passes use `pending` for work found/done, so it is not generic.
      const norm = (r) => (m.pendingIsUnfinished && r && countOf(r.pending) > 0
        ? Object.assign({}, r, { pendingRows: countOf(r.pendingRows) + countOf(r.pending) }) : r);
      const stampOrExplain = (...raw) => {
        const results = raw.map(norm);
        const why = [];
        for (const r of results) for (const x of incompleteReasons(r)) if (!why.includes(x)) why.push(x);
        if (!why.length && recordRun(home, m.key, version, results[results.length - 1])) return '';
        if (!why.length) return version ? ' — marker write failed; retries next run' : '';
        return ' — not stamped, retries next run: ' + why.join('; ');
      };
      if (!before.pending) {
        const tail = dryRun ? '' : stampOrExplain(before.raw);
        push('skipped', note(before, 'nothing to migrate') + tail);
        continue;
      }
      if (dryRun) { push('skipped', note(before, '[dry-run] would migrate: ' + (before.detail || 'pending'))); continue; }
      const applied = dw[m.fn](home, Object.assign({}, ctx));
      const after = m.detect(dw, home, ctx);
      if (!after.pending) {
        // Both the applying pass and the verifying scan must be complete.
        push('fixed', note(after, 'migrated: ' + (before.detail || 'pending')) + stampOrExplain(applied, after.raw));
      } else {
        push('failed', note(after, 'still pending after migrate: ' + (after.detail || '')));
      }
    } catch (e) {
      push('failed', m.id + ' raised: ' + ((e && e.message) || String(e)));
    }
  }
  return out;
}

module.exports = {
  MIGRATIONS, defaultMigrations, byId, runMigrations,
  isRunComplete, incompleteReasons, recordRun, TERMINAL_LEFT_REASONS, runBudgetMs, DEFAULT_RUN_BUDGET_MS,
  markerPath, readMarkers, writeMarkers, isApplied, markApplied, pluginVersion,
};
