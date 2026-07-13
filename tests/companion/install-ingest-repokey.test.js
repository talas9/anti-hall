'use strict';
// v0.57 mesh — PER-PROJECT ingest identity + REAP-BEFORE-DRAIN (D1/D9/D21/D28,
// Phase 5). Companion to tests/companion/install-devswarm-ingest.test.js (which
// covers the PRE-EXISTING per-worktree builders/identity unchanged by this
// phase). This file covers ONLY the v0.57 additions:
//   - repoKey-keyed unit naming (labelForProject/unitForProject/cronMarkerForProject)
//   - legacy-worktree ENUMERATION via `git worktree list --porcelain` (mocked —
//     NEVER a real git spawn in these tests), never by inverting the one-way
//     worktreeHash (Gap-2)
//   - reapLegacyUnitsForRepo: fully injectable, NEVER touches a real
//     launchd/systemd/cron/file in these tests (opts.io.schedRun/schedFs mocks)
//   - listInstalledIngestUnits recognizing the NEW repoKey shape, DISJOINT from
//     the legacy 8-hex shape (D28)
//   - a real-git subprocess dry-run proving the FULL install-path ordering:
//     reap BEFORE the new per-project unit is written

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { execFileSync } = require('node:child_process');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
const m = require(MOD);
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-repokey-'));
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// makeGitRepo(tag) -> a real, committed git repo dir (git-common-dir resolution
// needs a real .git). Mirrors tests/scripts/devswarm-send.test.js's own helper.
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-repokey-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}

// ---------------------------------------------------------------------------
// Per-project identity (D1) — repoKey-keyed, DISTINCT from the per-worktree
// (worktreeHash-keyed) identity, which stays unchanged.
// ---------------------------------------------------------------------------

test('labelForProject/unitForProject/cronMarkerForProject are keyed by repoKey, not worktreeHash', () => {
  const repoKey = 'anti-hall-a1b2c3';
  assert.equal(m.labelForProject(repoKey), m.LABEL + '.' + repoKey);
  assert.equal(m.unitForProject(repoKey), m.UNIT + '-' + repoKey);
  assert.equal(m.cronMarkerForProject(repoKey), '# ' + m.UNIT + '-' + repoKey);
  // Distinct from the per-worktree identity for an unrelated worktree path.
  assert.notEqual(m.labelForProject(repoKey), m.labelForWorktree('/some/worktree'));
});

// ---------------------------------------------------------------------------
// Legacy-worktree ENUMERATION (Gap-2): `git worktree list --porcelain` is the
// ONLY correct way to recover a repo's worktrees — worktreeHash is a one-way
// sha256 and cannot be inverted. Mocked here — no real git spawn.
// ---------------------------------------------------------------------------

const PORCELAIN_TWO_WORKTREES = [
  'worktree /repo/main',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo/main-wt-feature',
  'HEAD def456',
  'branch refs/heads/feature',
  '',
].join('\n');

test('parseWorktreeListPorcelain extracts every `worktree <path>` line', () => {
  const paths = m.parseWorktreeListPorcelain(PORCELAIN_TWO_WORKTREES);
  assert.deepEqual(paths, ['/repo/main', '/repo/main-wt-feature']);
});

test('parseWorktreeListPorcelain fail-opens to [] on empty/garbage input', () => {
  assert.deepEqual(m.parseWorktreeListPorcelain(''), []);
  assert.deepEqual(m.parseWorktreeListPorcelain('not porcelain output at all'), []);
  assert.deepEqual(m.parseWorktreeListPorcelain(null), []);
});

test('listRepoWorktrees uses a MOCKED `git worktree list --porcelain` — no real git spawn', () => {
  let calls = 0;
  const io = {
    run(spec) {
      calls++;
      assert.deepEqual(spec.args, ['-C', '/repo/main', 'worktree', 'list', '--porcelain']);
      return { ok: true, raw: PORCELAIN_TWO_WORKTREES };
    },
  };
  const worktrees = m.listRepoWorktrees('/repo/main', { io });
  assert.equal(calls, 1, 'exactly one git spawn, via the injected mock only');
  assert.deepEqual(worktrees, ['/repo/main', '/repo/main-wt-feature']);
});

test('listRepoWorktrees fail-opens to [] when the mocked git spawn fails, and when mainWorktree is null', () => {
  assert.deepEqual(m.listRepoWorktrees('/repo/main', { io: { run: () => ({ ok: false, raw: '' }) } }), []);
  assert.deepEqual(m.listRepoWorktrees(null, { io: { run: () => { throw new Error('must not be called'); } } }), []);
});

test('reapPlanForRepo derives {worktree,hash,label,unit,marker} per enumerated worktree — PURE, no side effects', () => {
  const io = { run: () => ({ ok: true, raw: PORCELAIN_TWO_WORKTREES }) };
  const plan = m.reapPlanForRepo('/repo/main', { io });
  assert.equal(plan.length, 2);
  for (const entry of plan) {
    assert.equal(entry.hash, m.worktreeHash(entry.worktree));
    assert.equal(entry.label, m.labelForWorktree(entry.worktree));
    assert.equal(entry.unit, m.unitForWorktree(entry.worktree));
    assert.equal(entry.marker, m.cronMarkerForWorktree(entry.worktree));
  }
  assert.deepEqual(plan.map((e) => e.worktree), ['/repo/main', '/repo/main-wt-feature']);
});

// ---------------------------------------------------------------------------
// reapLegacyUnitsForRepo — D9 REAP-BEFORE-DRAIN. Fully injectable: NEVER
// touches a real launchd/systemd/cron/file when opts.io.schedRun/schedFs are
// supplied (every test below supplies them) — this is the mechanical proof
// that "never run the real reap on this machine" holds for these tests.
// ---------------------------------------------------------------------------

test('reapLegacyUnitsForRepo (darwin) unloads + removes EVERY enumerated worktree\'s legacy plist — via MOCKS only, zero real launchctl/fs calls', () => {
  const schedCalls = [];
  const rmCalls = [];
  // NOTE: schedRun/schedFs MUST live INSIDE io (reapLegacyUnitsForRepo reads
  // o.io.schedRun/o.io.schedFs, deliberately keyed apart from io.run — the git
  // worktree-listing spawn — see the function's own header comment). Passing
  // them at the top level would silently fall through to the REAL
  // defaultSchedRunViaPlan/defaultSchedRm and hit a real launchctl/fs — this
  // exact mistake was caught live while writing this test (see git history).
  const io = {
    run: () => ({ ok: true, raw: PORCELAIN_TWO_WORKTREES }),
    schedRun: (spec) => { schedCalls.push(spec); return { status: 0, stdout: '', error: null }; },
    schedFs: (p) => { rmCalls.push(p); },
  };
  const result = m.reapLegacyUnitsForRepo('/repo/main', { platform: 'darwin', io });
  assert.equal(result.plan.length, 2);
  assert.equal(result.stopped.length, 2, 'both legacy worktrees are stopped');
  // launchctl unload for EACH worktree's OWN label.
  const unloadCmds = schedCalls.filter((c) => c.cmd === 'launchctl' && c.args[0] === 'unload');
  assert.equal(unloadCmds.length, 2);
  for (const entry of result.plan) {
    const expectedPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', entry.label + '.plist');
    assert.ok(unloadCmds.some((c) => c.args[1] === expectedPlist), `unload issued for ${entry.label}`);
    assert.ok(rmCalls.includes(expectedPlist), `plist removal issued for ${entry.label}`);
  }
});

test('reapLegacyUnitsForRepo (linux) attempts BOTH systemctl-disable AND cron-marker removal per worktree — via MOCKS only', () => {
  const schedCalls = [];
  const io = {
    run: () => ({ ok: true, raw: PORCELAIN_TWO_WORKTREES }),
    schedRun: (spec) => { schedCalls.push(spec); return { status: 0, stdout: '', error: null }; },
    schedFs: () => {},
  };
  const result = m.reapLegacyUnitsForRepo('/repo/main', { platform: 'linux', io });
  assert.equal(result.stopped.length, 2);
  const systemctlCalls = schedCalls.filter((c) => c.cmd === 'systemctl' && c.args.includes('disable'));
  assert.equal(systemctlCalls.length, 2, 'systemctl disable attempted for each worktree');
  const crontabReads = schedCalls.filter((c) => c.cmd === 'crontab' && c.args[0] === '-l');
  assert.equal(crontabReads.length, 2, 'crontab read attempted for each worktree (self-healing, no scheduler-detection needed)');
});

test('reapLegacyUnitsForRepo is FAIL-OPEN: one worktree that throws mid-stop never blocks reaping the rest', () => {
  let calls = 0;
  const io = {
    run: () => ({ ok: true, raw: PORCELAIN_TWO_WORKTREES }),
    schedRun: () => { calls++; if (calls === 1) throw new Error('boom'); return { status: 0, stdout: '', error: null }; },
    schedFs: () => {},
  };
  const result = m.reapLegacyUnitsForRepo('/repo/main', { platform: 'darwin', io });
  assert.equal(result.plan.length, 2, 'both worktrees are still enumerated');
  assert.equal(result.stopped.length, 1, 'the throwing worktree is skipped, the other still reaped');
});

test('reapLegacyUnitsForRepo returns {plan:[],stopped:[]} when no worktrees are enumerated (empty repo listing)', () => {
  const io = {
    run: () => ({ ok: false, raw: '' }),
    schedRun: () => { throw new Error('must not be called — nothing to reap'); },
    schedFs: () => { throw new Error('must not be called — nothing to reap'); },
  };
  const result = m.reapLegacyUnitsForRepo('/repo/main', { platform: 'darwin', io });
  assert.deepEqual(result, { plan: [], stopped: [] });
});

// ---------------------------------------------------------------------------
// listInstalledIngestUnits — repoKey shape recognized, DISJOINT from the
// legacy 8-hex shape (D28): a repoKey unit is NEVER matched by the legacy
// reap filter, and vice versa.
// ---------------------------------------------------------------------------

test('D28: LEGACY_UNIT_HASH_RE and PROJECT_UNIT_KEY_RE are mutually exclusive — a repoKey suffix never matches the legacy regex and vice versa', () => {
  const repoKeyShaped = 'anti-hall-a1b2c3';
  const legacyShaped = 'deadbeef';
  assert.equal(m.LEGACY_UNIT_HASH_RE.test(repoKeyShaped), false, 'a repoKey (has a dash) never matches the legacy 8-hex-only regex');
  assert.equal(m.PROJECT_UNIT_KEY_RE.test(legacyShaped), false, 'a bare 8-hex legacy hash never matches the repoKey regex (no dash)');
  assert.equal(m.LEGACY_UNIT_HASH_RE.test(legacyShaped), true);
  assert.equal(m.PROJECT_UNIT_KEY_RE.test(repoKeyShaped), true);
});

test('listInstalledIngestUnits reads back a PER-PROJECT (repoKey) unit alongside a LEGACY per-worktree unit, correctly disjoint', { skip: process.platform === 'win32' }, () => {
  const platform = process.platform;
  const home = tmpHome();
  try {
    const repoKey = 'anti-hall-a1b2c3';
    const wtA = '/repo/a';
    const hashA = m.worktreeHash(wtA);
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, m.labelForProject(repoKey) + '.plist'),
        m.buildPlist({ label: m.labelForProject(repoKey), exec: '/n', script: '/proj.js', log: '/l', workdir: '/repo/main' }));
      fs.writeFileSync(path.join(dir, m.labelForWorktree(wtA) + '.plist'),
        m.buildPlist({ label: m.labelForWorktree(wtA), exec: '/n', script: '/a.js', log: '/l', workdir: wtA }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, m.unitForProject(repoKey) + '.service'),
        m.buildService({ exec: '/n', script: '/proj.js', workdir: '/repo/main' }));
      fs.writeFileSync(path.join(dir, m.unitForWorktree(wtA) + '.service'),
        m.buildService({ exec: '/n', script: '/a.js', workdir: wtA }));
    }
    const units = m.listInstalledIngestUnits({ home, platform });
    assert.equal(units.length, 2, 'both the project unit AND the legacy per-worktree unit are discovered');
    const project = units.find((u) => u.repoKey === repoKey);
    const legacy = units.find((u) => u.hash === hashA);
    assert.ok(project, 'per-project (repoKey) unit found');
    assert.equal(project.hash, null, 'a project unit never carries a legacy hash');
    assert.equal(project.workingDir, '/repo/main');
    assert.equal(project.scriptPath, '/proj.js');
    assert.ok(legacy, 'legacy per-worktree unit found by hash');
    assert.equal(legacy.repoKey, null, 'a legacy unit never carries a repoKey');
    assert.equal(legacy.workingDir, wtA);
    assert.equal(legacy.scriptPath, '/a.js');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// resolveMainWorktree — dirname of `--git-common-dir`, mocked via repokey's
// own injectable io (no real git spawn).
// ---------------------------------------------------------------------------

test('resolveMainWorktree returns dirname(git-common-dir), via a mocked git spawn — never a linked worktree path', () => {
  const io = { run: (spec) => ({ ok: true, raw: '/repo/main/.git' }), fs: { realpathSync: (p) => p } };
  const main = m.resolveMainWorktree('/repo/main-wt-feature', io);
  assert.equal(main, '/repo/main');
});

test('resolveMainWorktree fail-opens to null on a non-git cwd', () => {
  const io = { run: () => ({ ok: false, raw: '' }) };
  assert.equal(m.resolveMainWorktree('/tmp/not-a-repo', io), null);
});

// ---------------------------------------------------------------------------
// FULL install-path ORDERING, real git, subprocess dry-run: reap the LEGACY
// per-worktree unit BEFORE writing the NEW per-project unit. `--dry-run`
// throughout, so NOTHING real is ever touched by this test.
// ---------------------------------------------------------------------------

test('install (--dry-run, REAL git repo + a linked worktree): reaps the MAIN worktree\'s pre-existing LEGACY unit and installs the per-project unit, keyed by repoKey', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-repokey-install-'));
  const repo = makeGitRepo('reap');
  const linked = addLinkedWorktree(repo, 'reap');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    assert.ok(repoKey, 'repoKey resolves for a real git repo');
    // Pre-seed a LEGACY per-worktree unit for the MAIN worktree, as an
    // earlier (<0.57) install would have left behind.
    const legacyHash = m.worktreeHash(repo);
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${m.LABEL}.${legacyHash}.plist`),
        m.buildPlist({ label: `${m.LABEL}.${legacyHash}`, exec: '/n', script: '/legacy.js', log: '/l', workdir: repo }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${m.UNIT}-${legacyHash}.service`),
        m.buildService({ exec: '/n', script: '/legacy.js', workdir: repo }));
    }
    // Install from the LINKED worktree's cwd — the per-project unit must
    // still bake the MAIN worktree (repo), never `linked`.
    const out = execFileSync(process.execPath, [MOD, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      cwd: linked,
    });
    // The legacy unit's removal is attempted (reap-before-drain).
    assert.ok(
      new RegExp('would (run: launchctl unload|remove).*' + legacyHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(out)
        || out.includes(legacyHash),
      'the pre-existing legacy per-worktree unit is targeted for reap: ' + out
    );
    // The NEW per-project unit is written, keyed by repoKey, baking the MAIN
    // worktree (never the linked one).
    assert.ok(out.includes(repoKey), 'the new unit is keyed by repoKey: ' + out);
    assert.ok(!out.includes(linked), 'the per-project unit never bakes the LINKED worktree as WorkingDirectory');
    const writeLines = out.split('\n').filter((l) => /^\[dry-run\] would write .+\.(plist|service)$/.test(l));
    assert.equal(writeLines.length, 1, 'exactly one NEW unit file is written (the per-project one)');
    assert.ok(writeLines[0].includes(repoKey), 'the written unit path is repoKey-keyed: ' + writeLines[0]);
  } finally { rm(home); rm(repo); rm(linked); }
});
