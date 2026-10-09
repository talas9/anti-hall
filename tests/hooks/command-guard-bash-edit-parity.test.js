'use strict';
// command-guard F3 (Bash edit parity) and the shared WORK classifier:
// state-changing git, gh mutations, repo-file writes, and recovery commands.
// A coordinator Bash write into a repo file gets edit-guard's verdict; git
// verbs are classified (WORK / blockable) but never blocked by F3.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'command-guard.js');
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const EXPORTS = ['classifyBashWork', 'isStateChangingGitSegment', 'isRecoveryGitSegment', 'bashWriteTargets',
  'isHeavyCommand', 'isHeavyGhSegment', 'isScratchpadOrTmpPath', 'splitSegmentsDetailed', 'effectiveVerb'];

// Probe in a child first: before the exports exist, requiring the hook runs
// main() (reads stdin, exits), which must not happen inside the test runner.
const probe = spawnSync(process.execPath, ['-e',
  `const m=require(${JSON.stringify(HOOK)});process.stdout.write(${JSON.stringify(EXPORTS)}.map(k=>typeof m[k]).join(','))`],
{ input: '', encoding: 'utf8' });
const cg = probe.stdout === EXPORTS.map(() => 'function').join(',') ? require(HOOK) : {};

const allowLib = require('../../plugins/anti-hall/hooks/lib/command-allow.js');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-parity-')));
  git(dir, 'init', '-q');
  const files = {
    'f.txt': 'a\n', 'a.txt': 'a\n', 'old.js': 'a\n', 'lib.js': 'a\n', 'README.md': 'a\n',
    'docs/x.md': 'a\n', 'src/a.js': 'a\n', 'sub/f.txt': 'a\n', '.github/workflows/test.yml': 'a\n',
    'CLAUDE.md': 'a\n', 'AGENTS.md': 'a\n', 'gen.sh': '#!/bin/sh\necho x\n',
    '.anti-hall/command-allow.json': JSON.stringify({ patterns: ["^sed -i 's/a/b/' docs/x\\.md$", '^\\./gen\\.sh > docs/api\\.md$'] }),
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const REPO = makeRepo();
process.on('exit', () => { try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

function payload(command, extra) {
  return Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: REPO }, extra || {});
}

function run(command, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    const top = allowLib.repoToplevel(o.cwd || REPO);
    const f = allowLib.readAllowFile(top);
    if (f.state === 'ok') allowLib.recordTrust(h.home, top, f.hash);
    if (o.skip) h.writeSkip(o.skip);
    return testHook(HOOK, payload(command, Object.assign({ cwd: o.cwd || REPO }, o.payload || {})), {
      home: h.home, env: Object.assign({}, COORD, o.env || {}),
    });
  } finally { h.cleanup(); }
}

function cls(command) {
  return cg.classifyBashWork(command, { session_id: 't', cwd: REPO });
}

test('exports are present and require does not run main()', () => {
  assert.strictEqual(probe.stdout, EXPORTS.map(() => 'function').join(','), probe.stdout + probe.stderr);
});

test('empty, non-string and malformed commands: all false, exit 0', () => {
  for (const c of ['', '   ', null, 42]) {
    const r = cg.classifyBashWork(c, { cwd: REPO });
    assert.deepStrictEqual([r.work, r.blockable, r.editBlocks.length, r.labels.size], [false, false, 0, 0]);
  }
  assert.strictEqual(run('').status, 0);
  assert.strictEqual(run('echo "unterminated > x').status, 0);
});

test('git commit -qam x: work and blockable, exit 0 (F3 never blocks git)', () => {
  const r = cls('git commit -qam x');
  assert.deepStrictEqual([r.work, r.blockable], [true, true]);
  assert.ok(r.labels.has('git'));
  assert.strictEqual(run('git commit -qam x').status, 0);
});

test('state-changing git forms are WORK and blockable', () => {
  for (const c of ['git checkout -b x', 'git checkout -- a.js', 'git restore a.js', 'git rm a.js', 'git mv a b',
    'git clean -fd', 'git stash', 'git branch -D x', 'git tag v1', 'git tag -d v1', 'git am --skip',
    'git switch -c dev', 'git apply p.diff', 'git -C . revert HEAD', 'git am --continue']) {
    const r = cls(c);
    assert.deepStrictEqual([c, r.work, r.blockable], [c, true, true]);
    assert.strictEqual(cg.isStateChangingGitSegment(c), true, c);
  }
});

test('read-only git forms are not WORK', () => {
  for (const c of ['git stash list', 'git stash show -p', 'git checkout dev', 'git tag -l', 'git tag', 'git clean -n',
    'git apply --check p.diff', 'git status', 'git log -1', 'git branch -a', 'git switch dev']) {
    const r = cls(c);
    assert.deepStrictEqual([c, r.work, r.blockable], [c, false, false]);
  }
});

test('recovery commands are WORK but never blockable', () => {
  for (const c of ['git am --abort && git log -1 --format=%h && git status --short | head -3',
    'git rebase --quit', 'git stash apply', 'git stash pop', 'git merge --abort', 'git cherry-pick --abort', 'git revert --quit']) {
    const r = cls(c);
    assert.deepStrictEqual([c, r.work, r.blockable], [c, true, false]);
    assert.ok(r.labels.has('recovery'), c);
  }
  assert.strictEqual(cg.isRecoveryGitSegment('git am --skip'), false);
});

test('a recovery plus a real git verb is blockable', () => {
  const r = cls('git am --abort && git am -3 -q p.patch');
  assert.deepStrictEqual([r.work, r.blockable], [true, true]);
});

test('gh api graphql mutation is WORK', () => {
  const r = cls("gh api graphql -f query='mutation{x}'");
  assert.deepStrictEqual([r.work, r.blockable], [true, true]);
  assert.ok(r.labels.has('gh'));
  assert.strictEqual(cls("gh api graphql -f query='query { viewer { login } }'").work, false);
});

test('repo-file writes are WORK with the repo-write label; notes and tmp writes are not', () => {
  const w = cls("sed -i 's/a/b/' f.txt");
  assert.deepStrictEqual([w.work, w.blockable], [true, true]);
  assert.ok(w.labels.has('repo-write'));
  assert.deepStrictEqual(w.editBlocks, [path.join(REPO, 'f.txt')]);
  for (const c of ['echo x > .anti-hall/notes.md', 'printf x >> /tmp/x.log', 'sed -n 1p f.txt', 'echo "a > b"', 'exec 3>&-']) {
    const r = cls(c);
    assert.deepStrictEqual([c, r.work, r.editBlocks.length], [c, false, 0]);
  }
});

test('bashWriteTargets: sed/perl/tee/cp/mv/redirect parsing', () => {
  assert.deepStrictEqual(cg.bashWriteTargets("sed -i '' 's/a/b/' x.yml"), ['x.yml']);
  assert.deepStrictEqual(cg.bashWriteTargets("sed -i -e 's/a/b/' -e 's/c/d/' a b"), ['a', 'b']);
  assert.deepStrictEqual(cg.bashWriteTargets("sed -n 's/a/b/p' a"), []);
  assert.deepStrictEqual(cg.bashWriteTargets("perl -pi -e 's/a/b/' lib.js"), ['lib.js']);
  assert.deepStrictEqual(cg.bashWriteTargets("perl -i script.pl x"), ['x']);
  assert.deepStrictEqual(cg.bashWriteTargets('tee -a README.md 2>/dev/null'), ['README.md']);
  assert.deepStrictEqual(cg.bashWriteTargets('mv old.js new.js'), ['new.js', 'old.js']);
  assert.deepStrictEqual(cg.bashWriteTargets('cp -t out a b'), ['out/a', 'out/b']);
  assert.deepStrictEqual(cg.bashWriteTargets('cp a.txt docs/'), ['docs/a.txt']);
  assert.deepStrictEqual(cg.bashWriteTargets('cp a.txt docs', REPO), ['docs/a.txt']);
  assert.deepStrictEqual(cg.bashWriteTargets('echo x > "src/a b.js" 2>&1'), ['src/a b.js']);
  assert.deepStrictEqual(cg.bashWriteTargets('echo x >/dev/null'), []);
});

// ---- hook exit codes (coordinator) ----

const BLOCKED = [
  "git switch -c dev && sed -i '' 's/a/b/' .github/workflows/test.yml",
  "sed -i 's/a/b/' f.txt",
  "cd sub && sed -i 's/a/b/' f.txt",
  "cd sub; sed -i 's/a/b/' f.txt",
  "cat > src/a.js <<'EOF'\nx > y\nEOF",
  'tee >(grep x) out.txt',
  'tee -a README.md 2>/dev/null',
  'cp a.txt docs/',
  'mv old.js new.js',
  "perl -pi -e 's/a/b/' lib.js",
  'bash -c "sed -i s/a/b/ f.txt"',
  'echo $(sed -i s/a/b/ f.txt)',
  'echo x > notes.md',
  './gen.sh > docs/api.md',
];
for (const c of BLOCKED) {
  test('exit 2: ' + JSON.stringify(c), () => {
    const r = run(c);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.json.reason, /skip edit-guard/);
  });
}

const ALLOWED = [
  'cd "$X" && sed -i s/a/b/ f.txt',
  'echo "a > b"',
  'echo x > .anti-hall/notes.md',
  'printf x >> /tmp/x.log',
  "cat >> .anti-hall/n.md <<'EOF'\na > b\nEOF",
  'exec 3>&-',
  'sed -n 1p f.txt',
  'echo x >> AGENTS.md',
  'echo x >> CLAUDE.md',
  "sed -i 's/a/b/' docs/x.md",
  'git commit -qam x',
  "gh api graphql -f query='query { viewer { login } }'",
];
for (const c of ALLOWED) {
  test('exit 0: ' + JSON.stringify(c), () => {
    const r = run(c);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });
}

test('symlinked CLAUDE.md: exit 2', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cg-parity-link-')));
  try {
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'real.js'), 'a\n');
    fs.symlinkSync(path.join('src', 'real.js'), path.join(dir, 'CLAUDE.md'));
    const r = run('echo x >> CLAUDE.md', { cwd: dir });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('subagent: exit 0', () => {
  assert.strictEqual(run("sed -i 's/a/b/' f.txt", { payload: { agent_id: 'a1', agent_type: 'executor' } }).status, 0);
});

test('skip edit-guard: exit 0', () => {
  assert.strictEqual(run("sed -i 's/a/b/' f.txt", { skip: { 'edit-guard': Date.now() + 600000 } }).status, 0);
});

test('guards.bashEditParity off: exit 0', () => {
  assert.strictEqual(run("sed -i 's/a/b/' f.txt", { env: { ANTIHALL_BASH_EDIT_PARITY: 'off' } }).status, 0);
});

test('safety.editGuard off: exit 0', () => {
  assert.strictEqual(run("sed -i 's/a/b/' f.txt", { env: { ANTIHALL_EDIT_GUARD: 'off' } }).status, 0);
});

test('a 70,000-char command is not classified: exit 0', () => {
  const c = 'echo ' + 'a'.repeat(70000) + ' > src.txt';
  assert.strictEqual(cg.classifyBashWork(c, { cwd: REPO }).work, false);
  assert.strictEqual(run(c).status, 0);
});

test('plan mode with notes.md: exit 0', () => {
  assert.strictEqual(run('echo x > notes.md', { payload: { permission_mode: 'plan' } }).status, 0);
});

// The coordinator's own auto-memory (~/.claude/projects/<slug>/memory/*.md) is a
// notes write OUTSIDE the repo: never repo-write WORK, never F3-blocked — also
// after a `cd` into that (non-git) dir, which must not become a project root.
// The HOME is a non-tmp absolute path, so no tmp-root skip can mask the verdict.
test('auto-memory write under a non-tmp HOME, cwd = repo: not WORK, exit 0', () => {
  const mem = path.join('/nonexistent-cw-home-' + process.pid, '.claude', 'projects', 'p', 'memory');
  for (const c of ['echo x >> ' + path.join(mem, 'MEMORY.md'), 'cd ' + mem + ' && echo x >> MEMORY.md',
    'cd ' + mem + " && sed -i '' 's/a/b/' MEMORY.md"]) {
    const r = cg.classifyBashWork(c, { cwd: REPO, session_id: 't' });
    assert.strictEqual(r.work, false, c);
    assert.deepStrictEqual(r.editBlocks, [], c);
    assert.strictEqual(run(c).status, 0, c);
  }
});
