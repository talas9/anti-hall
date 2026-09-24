'use strict';
// Hygiene (v0.108.0): workspace DELETION is owner-approved only.
//   1. executePrune (the only code that spawns `hivecontrol workspace delete`)
//      is defined in companion/lib/devswarm-lifecycle.js and CALLED from exactly
//      one place: the `prune-archived --confirm-ids` dispatch in
//      scripts/devswarm.js. No hook, supervisor, scheduler, monitor, statusline
//      or Codex hook references it, the verb, or `--confirm-ids`.
//   2. No production code builds a `workspace delete` argv except via
//      devswarm-lifecycle.js's verbArgv('delete', ...).
//   3. Nobody talks to the DevSwarm app's unauthenticated local HTTP API
//      (port 47836, /api/workspace...) — hivecontrol verbs only.
//   4. The auto-archive path never calls the side-effecting `check-merge`.
// Comment lines are ignored (the docs may name what they forbid).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = 'plugins/anti-hall/';
const LIFECYCLE = PLUGIN + 'companion/lib/devswarm-lifecycle.js';
const CLI = PLUGIN + 'scripts/devswarm.js';

function productionFiles() {
  const r = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', PLUGIN], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files failed: ' + r.stderr);
  return r.stdout.split('\n').filter((f) => /\.(js|cjs|mjs|json|sh)$/.test(f) && fs.existsSync(path.join(REPO, f)));
}
function codeLines(f) {
  return fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')
    .map((t, i) => ({ t, n: i + 1 }))
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l.t));
}
function hits(re, filter) {
  const out = [];
  for (const f of productionFiles()) {
    if (filter && !filter(f)) continue;
    for (const l of codeLines(f)) if (re.test(l.t)) out.push(f + ':' + l.n + ': ' + l.t.trim().slice(0, 120));
  }
  return out;
}

test('executePrune: defined in the lifecycle lib, called ONLY by the prune-archived dispatch', () => {
  const h = hits(/\bexecutePrune\b/);
  const outside = h.filter((x) => !x.startsWith(LIFECYCLE + ':') && !x.startsWith(CLI + ':'));
  assert.deepStrictEqual(outside, [], 'executePrune referenced outside the allowed files');
  const cliCalls = h.filter((x) => x.startsWith(CLI + ':'));
  assert.strictEqual(cliCalls.length, 1, cliCalls.join('\n'));
  const src = fs.readFileSync(path.join(REPO, CLI), 'utf8');
  const caseAt = src.indexOf("case 'prune-archived':");
  const callAt = src.indexOf('executePrune(');
  const nextCase = src.indexOf('\n      case ', caseAt + 1);
  assert.ok(caseAt > 0 && callAt > caseAt && callAt < nextCase, 'executePrune must be called inside case prune-archived');
});

test('no automation path references deletion (hooks, supervisor, schedulers, monitors, codex hooks)', () => {
  const auto = (f) => f.startsWith(PLUGIN + 'hooks/') || f.startsWith(PLUGIN + 'codex/hooks/')
    || f.startsWith(PLUGIN + 'monitors') || f.startsWith(PLUGIN + 'statusline/')
    || /companion\/(devswarm-supervisor|devswarm-ingest|install-[\w-]+|mcp-reaper)\.js$/.test(f)
    || /monitors\.json$/.test(f) || /hooks\.json$/.test(f);
  assert.deepStrictEqual(hits(/executePrune|confirm-ids|prune-archived|verbArgv\(\s*'delete'/, auto), []);
});

test('the only `workspace delete` argv builder is the lifecycle lib', () => {
  const h = hits(/'workspace'\s*,\s*'delete'|verbArgv\(\s*'delete'/).filter((x) => !x.startsWith(LIFECYCLE + ':'));
  assert.deepStrictEqual(h, []);
});

test('nobody calls the DevSwarm app local HTTP API', () => {
  assert.deepStrictEqual(hits(/47836|\/api\/workspace/), []);
});

test('auto-archive never calls the side-effecting check-merge', () => {
  const f = (x) => x === LIFECYCLE || x === PLUGIN + 'companion/devswarm-supervisor.js';
  assert.deepStrictEqual(hits(/check-merge/, f), []);
});
