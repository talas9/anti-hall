'use strict';
// merge-side-pick: advisory (never blocks) on a push after a wholesale side-pick
// conflict resolution with no test run since. Claude + Codex payloads; isolated HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');
const HOOK = path.join(PLUGIN, 'hooks', 'merge-side-pick.js');
const lib = require(path.join(PLUGIN, 'hooks', 'lib', 'merge-side-pick.js'));

function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-msp-')); }

function run(home, event, cmd, sid, extra) {
  const payload = Object.assign({ hook_event_name: event, tool_name: 'Bash', tool_input: { command: cmd }, session_id: sid || 's1', cwd: home }, extra || {});
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
  assert.strictEqual(r.status, 0);
  return r.stdout.trim();
}
const post = (h, c, s, e) => run(h, 'PostToolUse', c, s, e);
const pre = (h, c, s, e) => run(h, 'PreToolUse', c, s, e);

test('detects side-pick forms', () => {
  for (const c of [
    'git checkout --theirs .', 'git checkout --ours src/a.js', 'git restore --theirs f',
    'git merge -X ours main', 'git merge -Xtheirs origin/main', 'git pull --strategy-option=theirs',
    'git rebase -X theirs main', 'git merge -s ours dev', 'git -C repo checkout --theirs -- a',
  ]) assert.ok(lib.isSidePick(c), c);
  for (const c of [
    'git checkout main', 'git merge main', 'git commit -m "used git checkout --theirs"',
    'echo "git merge -X ours"', 'git log --oneline', 'git rebase -X patience main',
  ]) assert.ok(!lib.isSidePick(c), c);
});

test('detects test runs', () => {
  for (const c of ['npm test', 'npm run test:unit', 'pnpm test', 'node --test', 'node --test tests/', 'pytest -q', 'python3 -m pytest',
    'go test ./...', 'cargo test', 'cargo nextest run', 'flutter test', 'make test', './gradlew test', 'npx vitest run'])
    assert.ok(lib.isTestRun(c), c);
  for (const c of ['npm install', 'git status', 'echo "npm test"', 'cat tests.md']) assert.ok(!lib.isTestRun(c), c);
});

test('advises on push after a side-pick with no test run (Claude payload)', () => {
  const h = mkHome();
  assert.strictEqual(post(h, 'git checkout --theirs . && git add -A', 's1'), '');
  const out = pre(h, 'git push origin dev', 's1');
  const ctx = JSON.parse(out).hookSpecificOutput;
  assert.strictEqual(ctx.hookEventName, 'PreToolUse');
  assert.match(ctx.additionalContext, /^⚠️ anti-hall · merge-side-pick: /);
  assert.match(ctx.additionalContext, /\nWhy: /);
  assert.match(ctx.additionalContext, /\nDo instead: run the tests first/);
  assert.ok(!('decision' in JSON.parse(out)) && !('permissionDecision' in ctx), 'never blocks');
});

test('no advisory when tests ran after the side-pick', () => {
  const h = mkHome();
  post(h, 'git merge -X theirs main', 's2');
  post(h, 'npm test', 's2');
  assert.strictEqual(pre(h, 'git push', 's2'), '');
});

test('a side-pick after the last test run re-arms the advisory', () => {
  const h = mkHome();
  post(h, 'npm test', 's3');
  post(h, 'git checkout --ours .', 's3');
  assert.match(pre(h, 'git push', 's3'), /merge-side-pick/);
});

test('side-pick, tests and push in one command', () => {
  const h = mkHome();
  assert.match(pre(h, 'git checkout --theirs . && git commit -am x && git push', 's4'), /merge-side-pick/);
  assert.strictEqual(pre(h, 'git checkout --theirs . && npm test && git push', 's4'), '');
});

test('silent without a side-pick, on non-push, on dry-run, and per-session', () => {
  const h = mkHome();
  assert.strictEqual(pre(h, 'git push', 's5'), '');
  post(h, 'git checkout --theirs .', 's5');
  assert.strictEqual(pre(h, 'git status', 's5'), '');
  assert.strictEqual(pre(h, 'git push --dry-run', 's5'), '');
  assert.strictEqual(pre(h, 'git push', 'other-session'), '');
  assert.match(pre(h, 'git push', 's5'), /merge-side-pick/);
});

test('Codex payload path (turn_id + model, no hook_event_name reliance on --post)', () => {
  const h = mkHome();
  const codex = { turn_id: 't1', model: 'gpt-5.5' };
  post(h, 'git merge -X ours origin/main', 'cx1', codex);
  assert.match(pre(h, 'git push origin HEAD', 'cx1', codex), /merge-side-pick/);
  post(h, 'cargo test', 'cx1', codex);
  assert.strictEqual(pre(h, 'git push origin HEAD', 'cx1', codex), '');
});

test('setting off silences both halves', () => {
  const h = mkHome();
  fs.mkdirSync(path.join(h, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(h, '.anti-hall', 'settings.json'), JSON.stringify({ guards: { mergeSidePickAdvisory: false } }));
  post(h, 'git checkout --theirs .', 's6');
  assert.strictEqual(pre(h, 'git push', 's6'), '');
  assert.ok(!fs.existsSync(lib.stateFile(h, 's6')));
});

test('corrupt state fails open; old state files are pruned', () => {
  const h = mkHome();
  const f = lib.stateFile(h, 's7');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not json');
  assert.strictEqual(pre(h, 'git push', 's7'), '');
  const old = lib.stateFile(h, 'ancient');
  fs.writeFileSync(old, '{}');
  const t = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(old, t, t);
  post(h, 'git checkout --theirs .', 's7');
  assert.ok(!fs.existsSync(old), 'stale session file pruned');
});

test('registered on both ports; setting declared default-on', () => {
  const claude = fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.registry.json'), 'utf8');
  const codexCfg = fs.readFileSync(path.join(PLUGIN, 'codex', 'hooks', 'hooks.registry.json'), 'utf8');
  for (const t of [claude, codexCfg]) {
    assert.match(t, /merge-side-pick\.js\\"",/);
    assert.match(t, /merge-side-pick\.js\\" --post/);
  }
  const e = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));
  const all = JSON.stringify(e);
  assert.match(all, /mergeSidePickAdvisory/);
});
