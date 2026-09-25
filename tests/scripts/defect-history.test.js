'use strict';
// anti-hall :: defect bug-history tests — hooks/lib/defect-history.js and the
// backfill / recurring / similar verbs of scripts/defect.js.
//
// Every test runs against an isolated tmp HOME and a throwaway git repo
// fixture; nothing here reads or writes the developer's real ~/.anti-hall.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const store = require('../../plugins/anti-hall/hooks/lib/defect-store.js');
const hist = require('../../plugins/anti-hall/hooks/lib/defect-history.js');
const CLI = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'defect.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// ---------------------------------------------------------------------------
// fake git repo fixture
// ---------------------------------------------------------------------------
let REPO;
let GIT_HOME;
const SHAS = {};

function git(args, date) {
  const env = Object.assign({}, process.env, {
    HOME: GIT_HOME, USERPROFILE: GIT_HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
  return cp.execFileSync('git', ['-C', REPO, ...args], { env, encoding: 'utf8' }).trim();
}
function write(rel, content) {
  const p = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function lines(n, tag) {
  return Array.from({ length: n }, (_, i) => `// ${tag} ${i}`).join('\n') + '\n';
}
function commit(key, msg, date) {
  git(['add', '-A']);
  git(['commit', '-q', '--no-verify', '-m', msg], date);
  SHAS[key] = git(['rev-parse', 'HEAD']);
}

before(() => {
  GIT_HOME = tmpDir('anti-hall-dh-githome-');
  REPO = tmpDir('anti-hall-dh-repo-');
  git(['init', '-q']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);

  write('plugins/anti-hall/hooks/alpha-gate.js', lines(5, 'a'));
  write('CHANGELOG.md', '# Changelog\n');
  commit('init', 'feat: add alpha gate', '2026-01-01T00:00:00Z');
  git(['tag', 'v0.1.0']);

  // fix #1 on alpha-gate: the TEST file is the biggest change, but tests are
  // excluded, so the component must still be hooks/alpha-gate.
  write('plugins/anti-hall/hooks/alpha-gate.js', lines(15, 'a'));
  write('tests/hooks/alpha-gate.test.js', lines(200, 't'));
  write('CHANGELOG.md', '# Changelog\n\n## 0.1.1\n\n### Fixes\n\n- **Archived workspaces no longer block the alpha gate.** The gate skipped nothing.\n- Unrelated bullet about statusline colors.\n');
  commit('fixA1', 'fix(alpha-gate): archived workspaces never block the gate', '2026-01-02T00:00:00Z');
  git(['tag', 'v0.1.1']);

  write('plugins/anti-hall/companion/lib/beta-lock.js', lines(30, 'b'));
  write('docs/GUIDE.md', lines(300, 'doc'));
  commit('fixB', 'fix(beta-lock): lock acquire race let two callers both win\n\nTOCTOU between check and rename.', '2026-01-03T00:00:00Z');
  git(['tag', 'v0.2.0']);

  write('plugins/anti-hall/hooks/other.js', lines(3, 'o'));
  commit('feat', 'feat: something new, not a fix', '2026-01-04T00:00:00Z');

  write('plugins/anti-hall/hooks/alpha-gate.js', lines(25, 'a'));
  commit('fixA2', 'fix(alpha-gate): archived row blocks the gate again', '2026-01-05T00:00:00Z');
  // Tagged v0.10.0 BEFORE v0.3.0 exists on a later commit: lexical order
  // would say "v0.10.0" < "v0.2.0"; semver order must not be fooled.
  git(['tag', 'v0.10.0']);

  write('plugins/anti-hall/hooks/alpha-gate.js', lines(35, 'a'));
  commit('fixA3', 'fix: alpha gate held partition still blocks', '2026-01-06T00:00:00Z');
  // untagged -> fixedIn null
});

after(() => { rm(REPO); rm(GIT_HOME); });

function runCli(args, home) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('normalizeComponent maps file paths to a stable module name', () => {
  assert.equal(hist.normalizeComponent('plugins/anti-hall/hooks/devswarm-parent-gate.js'), 'hooks/devswarm-parent-gate');
  assert.equal(hist.normalizeComponent('hooks/devswarm-parent-gate.js'), 'hooks/devswarm-parent-gate');
  assert.equal(hist.normalizeComponent('hooks/devswarm-parent-gate'), 'hooks/devswarm-parent-gate');
  assert.equal(hist.normalizeComponent('plugins/anti-hall/companion/devswarm-ingest.js'), 'companion/devswarm-ingest');
  assert.equal(hist.normalizeComponent('plugins/anti-hall/companion/lib/row-state.js'), 'companion/row-state');
  assert.equal(hist.normalizeComponent('plugins/anti-hall/hooks/lib/defect-store.js'), 'hooks/defect-store');
  assert.equal(hist.normalizeComponent('plugins\\anti-hall\\hooks\\x.js'), 'hooks/x');
  assert.equal(hist.normalizeComponent(''), null);
});

test('isSourceFile excludes tests, docs and manifests', () => {
  assert.equal(hist.isSourceFile('plugins/anti-hall/hooks/a.js'), true);
  assert.equal(hist.isSourceFile('tests/hooks/a.test.js'), false);
  assert.equal(hist.isSourceFile('plugins/anti-hall/hooks/a.test.js'), false);
  assert.equal(hist.isSourceFile('docs/GUIDE.md'), false);
  assert.equal(hist.isSourceFile('CHANGELOG.md'), false);
  assert.equal(hist.isSourceFile('plugins/anti-hall/skills/x/SKILL.md'), false);
  assert.equal(hist.isSourceFile('plugins/anti-hall/.claude-plugin/plugin.json'), false);
});

test('dominantComponent: source beats tests/docs; test-only fixes name the tested module', () => {
  const f = (file, n) => ({ file, added: n, deleted: 0 });
  assert.equal(hist.dominantComponent([f('tests/hooks/a.test.js', 500), f('plugins/anti-hall/hooks/b.js', 2), f('docs/X.md', 900)], null), 'hooks/b');
  assert.equal(hist.dominantComponent([f('plugins/anti-hall/hooks/b.js', 2), f('plugins/anti-hall/companion/lib/c.js', 9)], null), 'companion/c');
  assert.equal(hist.dominantComponent([f('CHANGELOG.md', 3)], 'jev-report'), 'jev-report', 'no source -> conventional scope');
  assert.equal(hist.dominantComponent([f('CHANGELOG.md', 3), f('tests/hooks/api-guard.test.js', 4)], null), 'hooks/api-guard', 'test-only fix -> tested module');
  assert.equal(hist.dominantComponent([f('plugins/anti-hall/skills/deadly-loop/SKILL.md', 4)], null), 'skills/deadly-loop');
  assert.equal(hist.dominantComponent([f('CHANGELOG.md', 3)], null), null);
});

test('fixedInFor prefers a release the subject names when it predates the first containing tag', () => {
  assert.equal(hist.fixedInFor('fix: v0.4.7 - swarm-guard false positive', '0.20.3'), '0.4.7');
  assert.equal(hist.fixedInFor('fix: v0.57 Wave F CI - test-only', '0.58.0'), '0.57.0');
  assert.equal(hist.fixedInFor('fix: v0.99.0 - later than the tag', '0.20.3'), '0.20.3', 'never later than the tag');
  assert.equal(hist.fixedInFor('fix: statusline test version assumptions for v0.37.0', '0.37.0'), '0.37.0');
  assert.equal(hist.fixedInFor('fix(x): plain', null), null);
});

test('classifyCause picks a class from the fixed taxonomy', () => {
  for (const c of ['archived-or-held-state', 'lock-or-race', 'home-or-state-leak', 'other']) {
    assert.ok(hist.CAUSE_ENUM.includes(c), c);
  }
  assert.equal(hist.classifyCause('archived workspaces never block'), 'archived-or-held-state');
  assert.equal(hist.classifyCause('acquireLock TOCTOU let two concurrent callers both win'), 'lock-or-race');
  assert.equal(hist.classifyCause('stop npm test from writing into the developer\'s real HOME'), 'home-or-state-leak');
  assert.equal(hist.classifyCause('recognize completions in all 3 transcript shapes'), 'transcript-parse');
  assert.equal(hist.classifyCause('default postHandoverGate to off, not shadow'), 'wrong-default');
  assert.equal(hist.classifyCause('rename a variable'), 'other');
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

test('backfill derives component (tests excluded), fixedIn (earliest semver tag) and CHANGELOG link', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    const res = hist.backfill({ repo: REPO, home, dryRun: true });
    const bySha = Object.fromEntries(res.records.map((r) => [r.fixCommit, r]));
    assert.equal(res.records.length, 4, 'exactly the 4 fix commits (feat commits are skipped)');
    assert.equal(bySha[SHAS.feat], undefined);

    const a1 = bySha[SHAS.fixA1];
    assert.equal(a1.component, 'hooks/alpha-gate');
    assert.equal(a1.fixedIn, '0.1.1');
    assert.equal(a1.cause, 'archived-or-held-state');
    assert.equal(a1.status, 'fixed');
    assert.equal(a1.source, 'backfill');
    assert.match(a1.changelog || '', /Archived workspaces no longer block the alpha gate/);

    const b = bySha[SHAS.fixB];
    assert.equal(b.component, 'companion/beta-lock', 'docs/GUIDE.md is bigger but excluded');
    assert.equal(b.fixedIn, '0.2.0', 'earliest SEMVER tag, not lexical v0.10.0');
    assert.equal(b.cause, 'lock-or-race');

    assert.equal(bySha[SHAS.fixA2].fixedIn, '0.10.0');
    assert.equal(bySha[SHAS.fixA3].fixedIn, null, 'untagged commit is unreleased');
    assert.equal(bySha[SHAS.fixA3].component, 'hooks/alpha-gate');
  } finally { rm(home); }
});

test('backfill --dry-run writes nothing; real run is idempotent and never mixes with reported defects', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    const dry = hist.backfill({ repo: REPO, home, dryRun: true });
    assert.equal(dry.imported, 4);
    assert.equal(fs.existsSync(hist.historyDir(home)), false, 'dry run touched no disk');

    const first = hist.backfill({ repo: REPO, home });
    assert.equal(first.imported, 4);
    assert.equal(first.existing, 0);
    const files = fs.readdirSync(hist.historyDir(home)).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 4);

    const second = hist.backfill({ repo: REPO, home });
    assert.equal(second.imported, 0, 're-run adds nothing');
    assert.equal(second.existing, 4);
    assert.equal(fs.readdirSync(hist.historyDir(home)).filter((f) => f.endsWith('.jsonl')).length, 4);
    for (const f of files) {
      assert.equal(store.readRawLines(path.join(hist.historyDir(home), f)).length, 1, 'one line per record, never re-appended');
    }

    assert.deepEqual(store.listDefects({ home }), [], 'backfill records are not user-reported defects');
    const cliList = runCli(['list', '--open', '--json'], home);
    assert.equal(cliList.status, 0);
    assert.deepEqual(JSON.parse(cliList.stdout), []);

    const shown = store.showDefect(SHAS.fixA1.slice(0, 12), home);
    assert.ok(shown, 'show finds a backfill record by its fp');
    assert.equal(shown.status, 'fixed');
    assert.equal(shown.component, 'hooks/alpha-gate');
  } finally { rm(home); }
});

test('CLI backfill --repo --dry-run --json reports counts and exits 0', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    const r = runCli(['backfill', '--repo', REPO, '--dry-run', '--json'], home);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.imported, 4);
    assert.equal(out.dryRun, true);
    assert.equal(fs.existsSync(hist.historyDir(home)), false);
    const bad = runCli(['backfill', '--repo', path.join(home, 'nope')], home);
    assert.notEqual(bad.status, 0, 'a non-repo path fails loudly');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// recurring
// ---------------------------------------------------------------------------

test('recurring flags component and component+cause hotspots and likely regressions', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    hist.backfill({ repo: REPO, home });
    const records = hist.loadAllRecords(home);
    assert.equal(records.length, 4);
    const rep = hist.recurring(records, {});

    const compHot = rep.hotspots.find((h) => h.kind === 'component' && h.component === 'hooks/alpha-gate');
    assert.ok(compHot, 'alpha-gate fixed 3 times is a component hotspot');
    assert.equal(compHot.count, 3);
    const ccHot = rep.hotspots.find((h) => h.kind === 'component+cause' && h.component === 'hooks/alpha-gate' && h.cause === 'archived-or-held-state');
    assert.ok(ccHot, 'same component+cause >= 2 is a hotspot');
    assert.ok(ccHot.count >= 2);
    assert.equal(rep.hotspots.find((h) => h.component === 'companion/beta-lock'), undefined, 'a single fix is not a hotspot');

    const reg = rep.regressions.find((g) => g.fixCommit === SHAS.fixA2);
    assert.ok(reg, 'alpha-gate archived fix again within 5 releases is a likely regression');
    assert.equal(reg.earlierCommit, SHAS.fixA1);

    const comp = rep.byComponent.find((c) => c.component === 'hooks/alpha-gate');
    assert.equal(comp.count, 3);
    assert.deepEqual(comp.versions, ['0.1.1', '0.10.0']);
    assert.equal(comp.firstDate.slice(0, 10), '2026-01-02');
    assert.equal(comp.lastDate.slice(0, 10), '2026-01-06');
    assert.ok(rep.byCause.find((c) => c.cause === 'lock-or-race' && c.count === 1));
  } finally { rm(home); }
});

test('recurring honours an explicit regressionOf on a reported defect and --since filters', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    hist.backfill({ repo: REPO, home });
    const earlier = SHAS.fixB.slice(0, 12);
    const r = store.report({
      home, class: 'hook-crash', sev: 'p1', sym: 'beta lock double win again', v: '0.10.0',
      proj: 'p', sid: 's', component: 'plugins/anti-hall/companion/lib/beta-lock.js',
      cause: 'lock-or-race', regressionOf: earlier,
    });
    assert.equal(r.outcome, 'recorded');
    const rep = hist.recurring(hist.loadAllRecords(home), {});
    const reg = rep.regressions.find((g) => g.fp === r.fp);
    assert.ok(reg, 'explicit regressionOf is flagged');
    assert.equal(reg.explicit, true);
    const beta = rep.byComponent.find((c) => c.component === 'companion/beta-lock');
    assert.equal(beta.count, 2, 'reported + backfill records group together');

    const since = hist.recurring(hist.loadAllRecords(home), { since: '0.10.0' });
    assert.equal(since.byComponent.find((c) => c.component === 'hooks/alpha-gate').count, 2, 'only 0.10.0+ fixes (unreleased counts as newest)');
    const sinceDate = hist.recurring(hist.loadAllRecords(home), { since: '2026-01-05' });
    assert.equal(sinceDate.byComponent.find((c) => c.component === 'hooks/alpha-gate').count, 2);

    const cli = runCli(['recurring', '--top', '5'], home);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /HOTSPOTS/);
    assert.match(cli.stdout, /hooks\/alpha-gate/);
    assert.match(cli.stdout, /REGRESSIONS/);
    const cliJson = runCli(['recurring', '--json'], home);
    assert.equal(cliJson.status, 0);
    assert.ok(Array.isArray(JSON.parse(cliJson.stdout).hotspots));
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------

test('similar ranks past fixes by component match and token overlap', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    hist.backfill({ repo: REPO, home });
    const records = hist.loadAllRecords(home);

    const byText = hist.similar(records, 'archived workspace blocks the alpha gate', {});
    assert.ok(byText.length >= 3);
    assert.ok(byText.slice(0, 3).every((m) => m.component === 'hooks/alpha-gate'), 'alpha-gate fixes rank first');
    assert.equal(byText[0].fixCommit, SHAS.fixA1, 'most overlapping subject wins');
    assert.ok(byText.length <= 10);

    const byComp = hist.similar(records, 'double win', { component: 'companion/lib/beta-lock.js' });
    assert.equal(byComp[0].fixCommit, SHAS.fixB, '--component (normalized) ranks the matching module first');

    assert.deepEqual(hist.similar(records, 'zzzz qqqq', {}), [], 'no overlap -> nothing');

    const cli = runCli(['similar', 'archived', 'gate', '--component', 'hooks/alpha-gate'], home);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp(SHAS.fixA1.slice(0, 7)));
    assert.match(cli.stdout, /0\.1\.1/);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// backward compatibility
// ---------------------------------------------------------------------------

test('old records without the new fields still load everywhere', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    fs.mkdirSync(store.defectsDir(home), { recursive: true });
    const old = [
      { t: 'report', at: '2026-01-01T00:00:00Z', v: '0.50.0', proj: 'x', sid: 's', class: 'guard-miss', sev: 'p2', sym: 'old style', repro: '', claimed: '', observed: '' },
      { t: 'ruling', at: '2026-01-02T00:00:00Z', status: 'fixed', note: 'n', fixedIn: '0.51.0', commit: 'abc1234' },
    ];
    fs.writeFileSync(path.join(store.defectsDir(home), 'aaaaaaaaaaaa.jsonl'), old.map((o) => JSON.stringify(o)).join('\n') + '\n');

    const listed = store.listDefects({ home });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'fixed');
    assert.equal(listed[0].component, undefined);

    const recs = hist.loadAllRecords(home);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].component, null);
    assert.equal(recs[0].fixCommit, 'abc1234', 'legacy ruling `commit` maps to fixCommit');
    assert.equal(recs[0].fixedIn, '0.51.0');
    const rep = hist.recurring(recs, {});
    assert.equal(rep.hotspots.length, 0);
    assert.equal(hist.formatRecurring(rep).length > 0, true);
  } finally { rm(home); }
});

test('report/rule accept the optional new fields and validate cause/regressionOf', () => {
  const home = tmpDir('anti-hall-dh-home-');
  try {
    const bad = store.report({ home, class: 'other', sev: 'p2', sym: 'x', proj: 'p', sid: 's', v: '1.0.0', cause: 'not-a-cause' });
    assert.equal(bad.outcome, 'invalid-cause');
    const badReg = store.report({ home, class: 'other', sev: 'p2', sym: 'x', proj: 'p', sid: 's', v: '1.0.0', regressionOf: 'nope' });
    assert.equal(badReg.outcome, 'invalid-regression-of');

    const r = runCli(['report', '--class', 'other', '--sev', 'p2', '--sym', 'cli new fields',
      '--component', 'plugins/anti-hall/hooks/lib/defect-store.js', '--cause', 'wrong-default', '--json'], home);
    assert.equal(r.status, 0, r.stderr);
    const fp = JSON.parse(r.stdout).fp;
    const ruled = runCli(['rule', fp, '--status', 'fixed', '--fixed-in', '1.2.3', '--commit', 'deadbeef', '--cause', 'fail-open-missing', '--json'], home);
    assert.equal(ruled.status, 0, ruled.stderr);
    const shown = store.showDefect(fp, home);
    assert.equal(shown.component, 'hooks/defect-store');
    assert.equal(shown.cause, 'fail-open-missing', 'the ruling (later line) wins');
    assert.equal(shown.fixedIn, '1.2.3');
    assert.equal(shown.fixCommit, 'deadbeef');
  } finally { rm(home); }
});
