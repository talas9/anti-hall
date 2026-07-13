'use strict';
// anti-hall :: ingest-health — Phase 7 shared per-project ingest-daemon health
// check (PLAN-v0.57-mesh.md D25). Used by BOTH per-turn hooks
// (devswarm-parent-inbox.js, devswarm-child-turn.js — the stale-data banner)
// AND devswarm.js's send-time self-heal wrapper, so every consumer agrees on a
// single definition of "the daemon is alive".
//
// HEALTH = RUNNING + HEALTHY, NOT freshness-only (D25). A fresh heartbeat file
// alone is not proof the daemon is alive (a dead process can leave a
// fresh-looking file within the staleness window, e.g. a crash right after its
// last write); a live process can also have a missing/never-written heartbeat
// (freshly installed, first sweep not yet run). daemonHealth() therefore reports
// on TWO INDEPENDENT signals, both fs-only:
//   (1) heartbeat freshness  — heartbeats/ingest-<repoKey>.json,
//       `now - ts <= HEARTBEAT_STALE_MS`.
//   (2) lock/process evidence — the per-project O_EXCL ingest lock
//       (locks/ingest-project-<repoKey>.lock, devswarm-ingest.js's
//       ingestLockPath project shape) is held by a LIVE pid.
// BOTH must hold for 'healthy'. A missing or unparsable heartbeat/lock file is
// NOT-fresh / NOT-live respectively — fail-open means "never throw", NEVER
// "assume healthy" (D25 fixes exactly this "missing == healthy" contradiction).
//
// WINDOWS CARVE-OUT (D28): the ingest installer is a documented no-op on win32
// (install-devswarm-ingest.js), so the daemon heartbeat is NEVER fresh there.
// `daemonHealth` short-circuits to `status:'unsupported'` on win32 so callers
// render NO stale-banner spam and attempt NO futile per-turn/per-send installer
// spawn on a platform that structurally cannot run the daemon.
//
// PURE FS ON THE HOT PATH — no spawn, no git, here. `repoKey` is resolved by
// the CALLER (e.g. `repokeyForWorktree(cwd)`, which DOES spawn `git`); that
// cost is the caller's own documented choice (once per turn / once per send),
// never hidden inside this helper.
//
// Deliberately does NOT require devswarm-ingest.js / install-devswarm-ingest.js
// (both pull in the store + spawnSync + scheduler-unit code, far heavier than a
// helper meant to be LAZILY required inside two per-turn hot-path hooks should
// depend on — same rationale already documented in devswarm-child-turn.js's
// defaultInboxPath/defaultCursorPath comment). The two path-format functions
// below are a deliberate small duplication of devswarm-ingest.js's own
// `ingestHeartbeatPath`/`ingestLockPath` (project shape), mirrored byte-for-byte.
//
// Every fs/process call is injectable via `opts.io` ({ fs, isAlive }) so tests
// exercise both D25 failure modes deterministically, without depending on a
// real OS pid's liveness.

const fs = require('fs');
const path = require('path');

const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // mirrors devswarm-parent-inbox.js's own constant

function devswarmRoot(home) {
  return path.join(home, '.anti-hall', 'devswarm');
}

// ingestHeartbeatPath(home, repoKey) — mirrors devswarm-ingest.js's own
// ingestHeartbeatPath(home, hash) byte-for-byte (heartbeats/ingest-<hash>.json).
function ingestHeartbeatPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'heartbeats', 'ingest-' + String(repoKey) + '.json');
}

// ingestProjectLockPath(home, repoKey) — mirrors devswarm-ingest.js's
// ingestLockPath's PER-PROJECT shape (locks/ingest-project-<repoKey>.lock) —
// the shape written once `repoKey` resolves, NOT the legacy per-worktree
// `locks/ingest-<hash>.lock` shape (that legacy shape has no repoKey-keyed
// equivalent and is out of scope for this repoKey-only health check).
function ingestProjectLockPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'locks', 'ingest-project-' + String(repoKey) + '.lock');
}

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// formatRelative(ts, now) -> compact relative age ("18m", "2h", "3d", "5s") or
// "—" when the signal is unknown/absent. Byte-for-byte copy of
// devswarm-parent-inbox.js's own helper (kept local — that hook's copy also
// drives its live-table "last" column, an unrelated concern this module has no
// business reaching into).
function formatRelative(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  let delta = now - ts;
  if (delta < 0) delta = 0;
  const s = Math.floor(delta / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// buildStaleBanner(beatTs, now) -> the SAME visible daemon-liveness warning
// text devswarm-parent-inbox.js renders (byte-for-byte), so a child sees
// IDENTICAL wording to the Primary when its project's daemon looks stopped.
function buildStaleBanner(beatTs, now) {
  return (
    '⚠ DEVSWARM STALE DATA: ingest daemon last alive ' + formatRelative(beatTs, now)
    + ' ago — data may be stale (the daemon may have stopped or never started for '
    + 'this worktree). Run /anti-hall:doctor to check the DevSwarm ingest daemon.'
  );
}

// daemonHealth(home, repoKey, opts) -> { status, fresh, liveLock }
//   status: 'healthy'     — fresh heartbeat AND a live-pid lock holder
//           'stale'       — either signal fails (incl. repoKey null/unresolved)
//           'unsupported' — win32 (D28); the daemon cannot run there at all
// Pure fs; fail-open throughout — any read/parse error degrades the SPECIFIC
// signal to false, never throws the whole call.
function daemonHealth(home, repoKey, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform === 'win32') return { status: 'unsupported', fresh: false, liveLock: false };

  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const F = (o.io && o.io.fs) || fs;
  const isAlive = (o.io && o.io.isAlive) || isAliveDefault;

  let fresh = false;
  if (repoKey) {
    try {
      const raw = F.readFileSync(ingestHeartbeatPath(home, repoKey), 'utf8');
      const beat = JSON.parse(raw);
      const ts = beat && Number.isFinite(beat.ts) ? beat.ts : null;
      fresh = ts !== null && (now - ts) <= HEARTBEAT_STALE_MS;
    } catch (_) { fresh = false; } // missing/unreadable/malformed = NOT-fresh (D25)
  }

  let liveLock = false;
  if (repoKey) {
    try {
      const raw = F.readFileSync(ingestProjectLockPath(home, repoKey), 'utf8');
      const holder = JSON.parse(raw);
      const pid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      liveLock = pid !== null && isAlive(pid);
    } catch (_) { liveLock = false; } // missing/unreadable/malformed = NOT-live (D25)
  }

  return { status: (fresh && liveLock) ? 'healthy' : 'stale', fresh, liveLock };
}

module.exports = {
  HEARTBEAT_STALE_MS,
  ingestHeartbeatPath,
  ingestProjectLockPath,
  daemonHealth,
  buildStaleBanner,
};
