'use strict';
// anti-hall :: devswarm-recover — ON-DEMAND kill+resume for ONE workspace, by id.
// This is the ONLY path in DevSwarm that ever kills a process; the automatic
// supervisor (devswarm-supervisor.js) never resolves a pid and never kills — it
// only pokes (an optional nudgeCommand) or escalates. Invoke explicitly:
//   node devswarm-recover.js <workspace-id>
// Workaround for claude-code#39755.
//
// allowInteractive:true is set HERE, and ONLY here — an operator running this by
// hand is explicitly asking to recover the ONE named workspace, so a lone
// INTERACTIVE claude session (a human at the keyboard) is a valid target too,
// under the SAME exactly-one-or-abstain + identity+cwd confirm-gate a headless
// target goes through (see lib/target-session.js).
//
// Exit code: 0 on any HANDLED outcome (resumed / escalate / abstain / skip) —
// these are all legitimate, non-error results the caller should read from
// stdout. Non-zero ONLY on an internal error (bad/unsafe argv, unreadable or
// malformed workspace descriptor, findTarget/recover throwing past their own
// fail-open guards).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { devswarmRoot, isSafeId } = require('./lib/liveness.js');
const { findTarget } = require('./lib/target-session.js');
const { recover, DEFAULT_MAX_RECOVERIES, DEFAULT_GRACE_MS } = require('./lib/recovery.js');
const { parseEnvNum } = require('./devswarm-supervisor.js');

function workspaceDescriptorPath(home, id) {
  return path.join(devswarmRoot(home), 'workspaces', String(id) + '.json');
}

// resolveCliThresholds(env) -> { maxRecoveries, graceMs }. DECOUPLED from the
// sweep's resolveThresholdsFromEnv (which no longer carries these — the
// automatic path never kills) — the CLI reads its OWN env vars directly, same
// names/defaults recover() has always used.
function resolveCliThresholds(env) {
  const e = env || process.env;
  const maxRecoveries = parseEnvNum(e, 'ANTIHALL_DEVSWARM_MAX_RECOVERIES', DEFAULT_MAX_RECOVERIES, { min: 1, max: 20 });
  const graceSec = parseEnvNum(e, 'ANTIHALL_DEVSWARM_GRACE_SEC', DEFAULT_GRACE_MS / 1000, { min: 1, max: 60 });
  return { maxRecoveries, graceMs: graceSec * 1000 };
}

// run(argv, opts) -> { ok, id, target, result } | { ok: false, error }.
// deps (findTarget/recover/fs/io/targetRunners/selfPid) injectable for tests —
// no real process is touched unless the real defaults are used.
function run(argv, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const F = o.fs || fs;
  const id = argv && argv[0];
  if (!id || !isSafeId(id)) {
    return { ok: false, error: 'usage: devswarm-recover.js <workspace-id> (id must be a safe path segment)' };
  }

  let descriptor;
  try {
    descriptor = JSON.parse(F.readFileSync(workspaceDescriptorPath(home, id), 'utf8'));
  } catch (e) {
    return { ok: false, error: 'unreadable workspace descriptor: ' + String(e && e.message) };
  }
  if (!descriptor || !descriptor.worktreePath || !descriptor.sessionId) {
    return { ok: false, error: 'malformed workspace descriptor (missing worktreePath/sessionId)' };
  }
  descriptor.id = descriptor.id || id;

  const target = (o.findTarget || findTarget)({
    worktreePath: descriptor.worktreePath, sessionId: descriptor.sessionId, home,
    runners: o.targetRunners, selfPid: o.selfPid, allowInteractive: true,
  });
  const { maxRecoveries, graceMs } = resolveCliThresholds(env);
  const result = (o.recover || recover)({
    descriptor, target, home, io: o.io, maxRecoveries, graceMs, allowInteractive: true,
  });
  return { ok: true, id, target, result };
}

function main() {
  const argv = process.argv.slice(2);
  let out;
  try {
    out = run(argv, {});
  } catch (e) {
    fs.writeSync(2, 'devswarm-recover: internal error: ' + String(e && e.message) + '\n');
    process.exit(1);
    return;
  }
  fs.writeSync(1, JSON.stringify(out) + '\n');
  process.exit(out.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { run, workspaceDescriptorPath, resolveCliThresholds };
