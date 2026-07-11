'use strict';
// tests/e2e/helpers.js — shared scaffolding for the DevSwarm substrate E2E suite.
//
// EVERYTHING here operates inside an ISOLATED temp HOME: HOME (and, on Windows,
// USERPROFILE/HOMEDRIVE/HOMEPATH) are pointed at a tmpdir so ~/.anti-hall resolves
// UNDER the fixture, never the real machine. No test writes outside its tmp HOME,
// and every test rm()'s its HOME in a finally. This mirrors tests/helpers/
// spawn-hook.js's isolation contract (os.homedir() reads USERPROFILE first on
// win32, so all three vars must be set or a hook escapes the fixture).
//
// The hooks are spawned via tests/helpers/spawn-hook.js (they call os.homedir()
// and cannot take a home arg); the CLI is spawned here as a real `node
// scripts/devswarm.js ... ` subprocess so the E2E path exercises the true entry
// point, not an in-process shortcut.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js');

// makeHome() -> fresh temp HOME with ~/.anti-hall/devswarm created.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-e2e-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// isolatedEnv(home, extra) — controlled child env pointing at the fake HOME,
// cross-platform. PATH is preserved so `node` resolves; nothing else leaks in, so
// coordinator-vs-subagent detection in the guard stays deterministic.
function isolatedEnv(home, extra) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.platform === 'win32') {
    const root = path.parse(home).root;
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
  }
  return Object.assign(env, extra || {});
}

// runCli(home, args, extraEnv) -> { status, stdout, stderr, json }. A real
// `node scripts/devswarm.js <args>` subprocess with the isolated HOME. json is
// JSON.parse(stdout) or null. Default store backend is feature-detected inside the
// CLI (sqlite on node>=22.5, journal otherwise) — force with
// extraEnv.ANTIHALL_DEVSWARM_STORE_BACKEND when a test needs a specific backend.
function runCli(home, args, extraEnv) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: isolatedEnv(home, extraEnv), timeout: 30000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

// ----- on-disk paths under the isolated HOME -----
const swarmRoot = (home) => path.join(home, '.anti-hall', 'devswarm');
const workspacesDir = (home) => path.join(swarmRoot(home), 'workspaces');
const heartbeatsDir = (home) => path.join(swarmRoot(home), 'heartbeats');
const livenessDir = (home) => path.join(swarmRoot(home), 'liveness');
const archiveNudgesDir = (home) => path.join(swarmRoot(home), 'archive-nudges');
const descriptorPath = (home, id) => path.join(workspacesDir(home), id + '.json');
const summaryPath = (home) => path.join(swarmRoot(home), 'summary.json');

// seedWorkspace(home, id, opts) — write a DUMMY workspace descriptor plus its
// durable inbox/cursor and (optionally) a supervisor verdict + heartbeat, exactly
// as the shipped registry contract expects (worktreePath/sessionId/inboxPath/
// cursorPath/nudgeCommand). Returns { descriptor, inboxPath, cursorPath }.
function seedWorkspace(home, id, opts) {
  const o = opts || {};
  const root = swarmRoot(home);
  const inboxPath = o.inboxPath || path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = o.cursorPath || path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(workspacesDir(home), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });

  const inbox = o.inbox || [];
  fs.writeFileSync(inboxPath, inbox.length ? inbox.join('\n') + '\n' : '');
  fs.writeFileSync(cursorPath, String(o.cursor == null ? 0 : o.cursor));

  const descriptor = {
    id,
    worktreePath: o.worktreePath || path.join(root, 'wt', id),
    sessionId: o.sessionId || ('sess-' + id),
    inboxPath,
    cursorPath,
    nudgeCommand: o.nudgeCommand || null,
  };
  fs.writeFileSync(descriptorPath(home, id), JSON.stringify(descriptor));

  if (o.verdict) {
    fs.mkdirSync(livenessDir(home), { recursive: true });
    fs.writeFileSync(path.join(livenessDir(home), id + '.json'), JSON.stringify(o.verdict));
  }
  if (o.heartbeatTs != null) {
    fs.mkdirSync(heartbeatsDir(home), { recursive: true });
    fs.writeFileSync(path.join(heartbeatsDir(home), id + '.json'),
      JSON.stringify({ id, ts: o.heartbeatTs, source: 'seed' }));
  }
  return { descriptor, inboxPath, cursorPath };
}

// writeSummary(home, obj) — the derived hook read-surface (parent hooks read this
// for archive_ready / status). Direct write used where a test seeds it explicitly.
function writeSummary(home, obj) {
  fs.mkdirSync(swarmRoot(home), { recursive: true });
  fs.writeFileSync(summaryPath(home), JSON.stringify(obj));
}

// setArchiveNudgeState(home, id, lastNudgedAt) — force the per-workspace archive
// reminder cooldown timestamp (used to simulate an elapsed cooldown across turns).
function setArchiveNudgeState(home, id, lastNudgedAt) {
  fs.mkdirSync(archiveNudgesDir(home), { recursive: true });
  fs.writeFileSync(path.join(archiveNudgesDir(home), id + '.json'),
    JSON.stringify({ lastNudgedAt }));
}

module.exports = {
  REPO_ROOT, CLI,
  makeHome, rm, isolatedEnv, runCli,
  swarmRoot, workspacesDir, heartbeatsDir, livenessDir, archiveNudgesDir,
  descriptorPath, summaryPath,
  seedWorkspace, writeSummary, setArchiveNudgeState,
};
