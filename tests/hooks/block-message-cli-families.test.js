'use strict';
// Shape coverage for the CLI / installer / SessionStart-note / DevSwarm-segment
// families converted to the shared shape (lib/block-message.js). Every message
// starts with exactly one icon from the fixed set + `anti-hall · <name>: <what>`.
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { assertShape } = require('../helpers/block-shape.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const HEAD = /^(⛔|⚠️|💡|✅|⬆️|❌) anti-hall · [a-z0-9-]+: \S/;
// Segment shape: first line is the headline; later lines are free-form body.
const assertHead = (text, guard, label) => {
  const first = String(text).split('\n')[0];
  assert.match(first, HEAD, label + ': headline shape\n' + first);
  if (guard) assert.ok(first.includes(' · ' + guard + ':'), label + ': guard ' + guard + '\n' + first);
  assert.doesNotMatch(first, /\bDEVSWARM [A-Z]{3,}|^WARNING|^ERROR|^BLOCKED/, label + ': no old banner');
};
const run = (script, args, home, extra) => cp.spawnSync(process.execPath, [path.join(ROOT, script)].concat(args || []), {
  cwd: home, encoding: 'utf8', timeout: 30000,
  env: Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, extra || {}),
});

test('fable-availability note has the shared shape and keeps the args.fableAvailable fact', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, '.claude.json'), JSON.stringify({ modelAccessCache: [{ apiName: 'claude-fable-x', entitled: true }] }));
    const r = testHook('fable-availability.js', {}, { home: h.home, expectJson: true });
    const c = ctx(r);
    assertShape(c, 'fable-availability', 'fable', { requireWhy: true });
    assert.match(c, /args\.fableAvailable=true/);
  } finally { h.cleanup(); }
});

test('codex-availability note has the shared shape and keeps the args.codexAvailable fact', () => {
  const h = makeHome();
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cliFam-codex-'));
  try {
    const cand = path.join(pathDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.writeFileSync(cand, '#!/bin/sh\necho codex\n');
    fs.chmodSync(cand, 0o755);
    const r = testHook('codex-availability.js', {}, { home: h.home, env: { PATH: pathDir }, expectJson: true });
    const c = ctx(r);
    assertShape(c, 'codex-availability', 'codex', { requireWhy: true });
    assert.match(c, /args\.codexAvailable=true/);
    assert.match(c, /codex:codex-rescue/);
  } finally { h.cleanup(); fs.rmSync(pathDir, { recursive: true, force: true }); }
});

test('handover-resume: negative report, snapshot-only note and the full pointer all use the shared shape', () => {
  const h = makeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cliFam-hr-'));
  try {
    const neg = ctx(testHook('handover-resume.js', { session_id: 's1', cwd, source: 'compact', hook_event_name: 'SessionStart' }, { home: h.home, expectJson: true }));
    assertShape(neg, 'handover-resume', 'negative report', { requireWhy: true });
    assert.match(neg, /\.anti-hall\/handovers\//);

    const sdir = path.join(cwd, '.anti-hall', 'handovers', '2026-10-01', 's2');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'PRECOMPACT-1.md'), '# snap\n');
    const snap = ctx(testHook('handover-resume.js', { session_id: 's2', cwd, source: 'compact', hook_event_name: 'SessionStart' }, { home: h.home, expectJson: true }));
    assertShape(snap, 'handover-resume', 'snapshot only', { requireWhy: true });
    assert.match(snap, /PRECOMPACT-1\.md/);

    const hdir = path.join(cwd, '.anti-hall', 'handovers', '2026-10-02', 's3');
    fs.mkdirSync(hdir, { recursive: true });
    const hp = path.join(hdir, 'HANDOVER.md');
    fs.writeFileSync(hp, '# Handover\n\n## Situation\nx\n');
    const full = ctx(testHook('handover-resume.js', { session_id: 's4', cwd, source: 'startup', hook_event_name: 'SessionStart' }, { home: h.home, expectJson: true }));
    assertHead(full, 'handover-resume', 'full pointer');
    assert.ok(full.includes(hp));
    assert.match(full, /^Do instead: follow this guided resume path\./m);
    assert.match(full, /resume-verified: <ISO timestamp>/);
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('installer forced-dry-run notices keep their facts in the Why / Override shape', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cliFam-inst-'));
  try {
    const bare = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', 'install-reaper.js'), '--dry-run'], { cwd: home, env: bare, encoding: 'utf8', timeout: 30000 });
    // --dry-run is explicit, so the guard stays quiet; run without it to see the notice.
    const r2 = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', 'install-reaper.js')], { cwd: home, env: bare, encoding: 'utf8', timeout: 30000 });
    assert.ok(r.status === 0 || r.status === 1);
    const lines = assertShape(r2.stderr, 'install-reaper', 'install-reaper notice', { requireWhy: true });
    assert.match(r2.stderr, /forced dry-run \(HOME .* temp directory\)/);
    assert.ok(lines.some((l) => /^Override \(only if the user explicitly asked\): .*ANTIHALL_REAPER_ALLOW_TMP_HOME=1/.test(l)));
    const sup = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', 'install-devswarm-supervisor.js')], { cwd: home, env: bare, encoding: 'utf8', timeout: 30000 });
    assertShape(sup.stderr, 'install-devswarm-supervisor', 'supervisor notice', { requireWhy: true });
    assert.match(sup.stderr, /ANTIHALL_SUPERVISOR_ALLOW_TMP_HOME=1/);
    const ing = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', 'install-devswarm-ingest.js'), '--bogus'], { cwd: home, env: bare, encoding: 'utf8', timeout: 30000 });
    assert.match(ing.stderr.split('\n')[0], /^❌ anti-hall · install-devswarm-ingest: unknown option: --bogus$/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI error lines (auto-handover-config, jev-setup, defect, phase) carry the shared headline', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cliFam-cli-'));
  try {
    const a = run('scripts/auto-handover-config.js', ['set', 'abc'], home);
    assertShape(a.stderr, 'auto-handover-config', 'auto-handover-config');
    assert.match(a.stderr, /invalid percent "abc"/);
    const j = run('scripts/jev-setup.js', ['mode'], home);
    assertShape(j.stderr, 'jev-setup', 'jev-setup');
    assert.match(j.stderr, /mode <integration> on\|shadow\|off/);
    const d = run('scripts/defect.js', ['show'], home);
    assertShape(d.stderr, 'defect', 'defect usage');
    assert.match(d.stderr, /usage: defect\.js show <fp>/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('statusline installer refuses under a test with the shared shape', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cliFam-sl-'));
  try {
    // A settings path outside any temp dir is refused under a test marker.
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'statusline', 'install-statusline.js')], {
      cwd: home, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: '/Users/nobody-antihall', USERPROFILE: '/Users/nobody-antihall', ANTIHALL_TEST_ISOLATION: '1' },
    });
    const lines = assertShape(r.stderr, 'install-statusline', 'install-statusline');
    assert.match(r.stderr, /refused under a test: .* is outside a temp dir/);
    assert.ok(lines.some((l) => /^Do instead: isolate HOME\/cwd\.$/.test(l)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('DevSwarm injection segments lead with the shared headline (no ALL-CAPS banners)', () => {
  const health = require(path.join(ROOT, 'companion', 'lib', 'ingest-health.js'));
  const stale = health.buildStaleBanner(Date.now() - 3600 * 1000, Date.now());
  assertHead(stale, 'devswarm-stale-data', 'stale data');
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'devswarm-parent-inbox.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'hooks', 'devswarm-child-turn.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'companion', 'lib', 'primary-seat.js'), 'utf8');
  assert.doesNotMatch(src, /['"`](⚠ )?DEVSWARM [A-Z]{3,}[A-Z -]*[:(—]/, 'no old DEVSWARM <KIND>: banners left in code strings');
  for (const g of ['devswarm-parent-inbox', 'devswarm-urgent-inbox', 'devswarm-workspaces', 'devswarm-archive-ready', 'devswarm-child-inbox', 'devswarm-child-workspace', 'devswarm-plan']) {
    assert.ok(src.includes(' · ' + g + ': '), g + ' headline present');
  }
});

test('no old-style banners remain in shipped hook/CLI strings', () => {
  const files = [
    'codex/install-codex.js', 'statusline/install-statusline.js', 'statusline/uninstall-statusline.js',
    'companion/install-devswarm-ingest.js', 'companion/install-reaper.js', 'companion/install-devswarm-supervisor.js',
    'scripts/devswarm-lib/core.js', 'scripts/devswarm-lib/misc-verbs.js',
  ];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /(console\.(error|log)|stderr\.write)\(\s*['"`](ERROR|WARNING|SAFETY|anti-hall): /, f + ': old prefix');
    assert.doesNotMatch(s, /\[devswarm\] WARNING/, f + ': old [devswarm] WARNING');
  }
});
