'use strict';
// doctor: the read-only "handover format" WARN. Lists handover-named files
// tracked by git and handover-like files outside the canonical layout, each with
// the canonical destination; never moves or deletes anything. Fixture repo +
// isolated HOME only.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function fixture(files, trackedNames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-handover-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-handover-home-'));
  const git = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git('add', 'README.md');
  if (trackedNames.length) git('add', '-f', ...trackedNames);
  git('commit', '-qm', 'init');
  return { dir, home, cleanup: () => { for (const p of [dir, home]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ } } } };
}

function runDoctor(f) {
  // never default HOME to the real home (see doctor-default-home-isolation.test.js)
  const home = f.home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const r =cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd: f.dir, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, DEVSWARM_REPO_ID: undefined, ANTIHALL_INGEST_DRY_RUN: '1' }),
  });
  return (r.stdout || '') + (r.stderr || '');
}

test('doctor: tracked handover + stray root/flat handover files are WARNED with the canonical destination; nothing is moved', () => {
  const files = {
    'HANDOVER.md': 'h\n',
    'session-handover-notes.md': 'h\n',
    '.anti-hall/handovers/2026-10-02-flat.md': 'h\n',
    '.anti-hall/handovers/INDEX.md': 'index\n',
    '.anti-hall/handovers/2026-10-02/s1/HANDOVER.md': 'ok\n',
    'docs/templates/HANDOVER.md': 'template\n',
  };
  const f = fixture(files, ['HANDOVER.md', 'docs/templates/HANDOVER.md']);
  try {
    const out = runDoctor(f);
    assert.doesNotMatch(out, /tracked by git: docs\/templates/, 'a template below the repo root is not a handover');
    assert.match(out, /handover format/);
    assert.match(out, /tracked by git: HANDOVER\.md - run `git rm --cached HANDOVER\.md`/);
    assert.match(out, /canonical location: \.anti-hall\/handovers\/\d{4}-\d\d-\d\d\/<session_id>\/HANDOVER\.md/);
    assert.match(out, /outside the canonical layout: session-handover-notes\.md - move it to \.anti-hall\/handovers\//);
    assert.match(out, /outside the canonical layout: \.anti-hall\/handovers\/2026-10-02-flat\.md/);
    assert.doesNotMatch(out, /layout: \.anti-hall\/handovers\/INDEX\.md/, 'INDEX.md is excluded');
    assert.doesNotMatch(out, /layout: \.anti-hall\/handovers\/2026-10-02\/s1/, 'the canonical layout is not flagged');
    for (const rel of Object.keys(files)) assert.ok(fs.existsSync(path.join(f.dir, rel)), `${rel} must not be moved or deleted`);
  } finally { f.cleanup(); }
});

test('doctor: a repo with no handover files prints no handover-format section', () => {
  const f = fixture({ 'src/a.js': 'a\n' }, []);
  try {
    assert.doesNotMatch(runDoctor(f), /handover format/);
  } finally { f.cleanup(); }
});
