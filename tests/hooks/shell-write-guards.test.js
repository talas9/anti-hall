'use strict';
// Shell writes reach the Edit-family guards (guards.shellWriteChecks,
// guards.bashEditParity): lib/shell-writes.js parsing, api-guard and
// ship-it-guard on Bash, command-guard's Bash edit parity for inline code.
// Both hosts: Claude Bash payload, and the Codex Bash payload shape (turn_id +
// model, no agent_id on the main thread; codex-cli 0.160.0 capture, see
// tests/codex/codex-apply-patch-guards.test.js). Codex needs the block reason
// on stderr.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const sw = require('../../plugins/anti-hall/hooks/lib/shell-writes.js');
const { classifyBashWork } = require('../../plugins/anti-hall/hooks/command-guard.js');

const FAKE_PY = 'import os\nprint(os.getcwdz())\n';
const REAL_PY = 'import os\nprint(os.getcwd())\n';

function withRepo(fn) {
  const h = makeHome();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-shellw-')));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'auth', 'old.js'), 'x\n');
  try { return fn(h.home, repo); } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    h.cleanup();
  }
}

function payload(host, command, cwd, extra) {
  const p = { hook_event_name: 'PreToolUse', session_id: 'sw-1', transcript_path: null, cwd, permission_mode: 'default', tool_name: 'Bash', tool_input: { command } };
  if (host === 'codex') Object.assign(p, { turn_id: 'turn-1', model: 'gpt-5.5', tool_use_id: 'call_1' });
  return Object.assign(p, extra || {});
}
const hostEnv = (host) => (host === 'claude' ? { CLAUDE_CODE_ENTRYPOINT: 'cli' } : {});
function run(hook, host, home, command, cwd, env, extra) {
  return testHook(hook, payload(host, command, cwd, extra), { home, env: Object.assign(hostEnv(host), env || {}) });
}
function assertBlock(r) {
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.trim().length > 0, 'the block reason must be on stderr (Codex reads only stderr on exit 2)');
}

// ------------------------------------------------------------ parsing (lib)
test('shellWrites: targets and visible content per form', () => withRepo((home, repo) => {
  const p = { cwd: repo, session_id: 'sw-1' };
  const got = (c) => sw.shellWrites(c, p).map((w) => [path.relative(repo, w.abs), w.content]);
  assert.deepStrictEqual(got("cat > a.py <<'EOF'\nimport os\nEOF"), [['a.py', 'import os\n']]);
  assert.deepStrictEqual(got('cat >> a.py <<EOF\nx\nEOF'), [['a.py', 'x\n']]);
  assert.deepStrictEqual(got("cat <<'EOF' > a.py && ls\ny\nEOF"), [['a.py', 'y\n']]);
  assert.deepStrictEqual(got("echo 'import os' > a.py"), [['a.py', 'import os\n']]);
  assert.deepStrictEqual(got("printf 'a\\nb\\n' > a.py"), [['a.py', 'a\nb\n\n']]);
  assert.deepStrictEqual(got("tee a.py <<'EOF'\nz\nEOF"), [['a.py', 'z\n']]);
  assert.deepStrictEqual(got("printf 'q\\n' | tee -a a.py"), [['a.py', 'q\n\n']]);
  assert.deepStrictEqual(got("sed -i '' 's/x/y/' src/auth/old.js"), [['src/auth/old.js', null]]);
  assert.deepStrictEqual(got("perl -pi -e 's/x/y/' src/auth/old.js"), [['src/auth/old.js', null]]);
  assert.deepStrictEqual(got("python3 -c \"open('b.py','w').write('x')\""), [['b.py', null]]);
  assert.deepStrictEqual(got('cp /etc/hosts c.js'), [['c.js', null]]);
  assert.deepStrictEqual(got('mv src/auth/old.js d.js'), [['d.js', null], ['src/auth/old.js', null]]);
  assert.deepStrictEqual(got(': > e.js'), [['e.js', null]]);
  assert.deepStrictEqual(got('> e.js'), [['e.js', null]]);
  assert.deepStrictEqual(got('bash -c "echo hi > f.js"'), [['f.js', 'hi\n']]);
  assert.deepStrictEqual(got('x=$(echo hi > g.js)'), [['g.js', 'hi\n']]);
  // a heredoc fed to a shell is a script; one fed to cat is data
  assert.deepStrictEqual(got('bash <<EOF\necho x > h.py\nEOF'), [['h.py', 'x\n']]);
  assert.deepStrictEqual(got("cd src && sh <<'X'\ncat > i.py <<Y\nimport os\nY\nX"), [['src/i.py', 'import os\n']]);
  assert.deepStrictEqual(got('cat > n.txt <<EOF\necho x > j.py\nEOF'), [['n.txt', 'echo x > j.py\n']]);
  assert.deepStrictEqual(got('cd $D && bash -c "echo x > k.py"'), []);
}));

test('shellWrites: unknowable targets and non-writes come back empty (fail open)', () => withRepo((home, repo) => {
  const p = { cwd: repo, session_id: 'sw-1' };
  for (const c of ['echo hi > $OUT', 'echo hi > "${F}.py"', 'echo hi > *.py', 'echo hi > ~/x.py', 'cd "$D" && echo x > a.py',
    'git status', 'echo hi 2>/dev/null', 'ls >&2', '[[ a > b ]]', 'grep x a.py', "echo 'a > b.py'", 'cat a.py']) {
    assert.deepStrictEqual(sw.shellWrites(c, p), [], c);
  }
  assert.deepStrictEqual(sw.shellWrites(null, p), []);
  assert.strictEqual(sw.mayWrite('git status'), false);
}));

test('shellWrites: scratch/tmp targets outside a repo are flagged scratch', () => withRepo((home, repo) => {
  const ws = sw.shellWrites("cat > /tmp/ah-sw-probe.py <<'EOF'\nx\nEOF", { cwd: repo, session_id: 'sw-1' });
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].scratch, true);
  const inRepo = sw.shellWrites('echo x > a.py', { cwd: repo, session_id: 'sw-1' });
  assert.strictEqual(inRepo[0].scratch, false); // a repo under a tmp root is still a repo
}));

// ------------------------------------------------------------ api-guard on Bash
for (const host of ['claude', 'codex']) {
  for (const [name, cmd] of [
    ['cat heredoc', "cat > src/x.py <<'EOF'\n" + FAKE_PY + 'EOF'],
    ['cat >> heredoc', 'cat >> src/x.py <<EOF\n' + FAKE_PY + 'EOF'],
    ['echo', "echo 'import os; os.getcwdz()' > src/x.py"],
    ['printf', "printf 'import os\\nos.getcwdz()\\n' > src/x.py"],
    ['tee heredoc', "tee src/x.py <<'EOF'\n" + FAKE_PY + 'EOF'],
    ['printf | tee -a', "printf 'import os\\nos.getcwdz()\\n' | tee -a src/x.py"],
    ['bash -c', "bash -c \"printf 'import os\\nos.getcwdz()\\n' > src/x.py\""],
  ]) {
    test(`api-guard ${host}: fabricated API via ${name} -> BLOCK`, () => withRepo((home, repo) => {
      const r = run('api-guard.js', host, home, cmd, repo);
      assertBlock(r);
      assert.match(r.stderr, /os\.getcwdz/);
    }));
  }

  test(`api-guard ${host}: real API, unknown text, non-code target, scratch probe -> allow`, () => withRepo((home, repo) => {
    for (const cmd of ["cat > src/x.py <<'EOF'\n" + REAL_PY + 'EOF', 'cp /etc/hosts src/x.py', "sed -i '' 's/a/b/' src/x.py",
      "cat > notes.md <<'EOF'\n" + FAKE_PY + 'EOF', 'echo "$CODE" > src/x.py', 'git status']) {
      assert.strictEqual(run('api-guard.js', host, home, cmd, repo).status, 0, cmd);
    }
  }));

  test(`api-guard ${host}: subagent Bash write is checked too (same as Write)`, () => withRepo((home, repo) => {
    const sub = host === 'codex' ? { agent_id: '01a102e5-9d51-7063-9dd8-8bda5c51b741', agent_type: 'executor' } : { agent_id: 'a1', agent_type: 'executor' };
    assertBlock(run('api-guard.js', host, home, "cat > src/x.py <<'EOF'\n" + FAKE_PY + 'EOF', repo, {}, sub));
  }));

  test(`api-guard ${host}: guards.shellWriteChecks off / api-guard skip -> allow`, () => withRepo((home, repo) => {
    const cmd = "cat > src/x.py <<'EOF'\n" + FAKE_PY + 'EOF';
    assert.strictEqual(run('api-guard.js', host, home, cmd, repo, { ANTIHALL_SHELL_WRITE_CHECKS: 'off' }).status, 0);
    fs.writeFileSync(path.join(home, '.anti-hall', 'skip.json'), JSON.stringify({ 'api-guard': Date.now() + 60000 }));
    assert.strictEqual(run('api-guard.js', host, home, cmd, repo).status, 0);
  }));
}

// ------------------------------------------------------------ ship-it-guard on Bash
const GATE = { ANTIHALL_SHIPIT_GATE: '1' };
for (const host of ['claude', 'codex']) {
  for (const [name, cmd] of [
    ['cat heredoc', "cat > src/auth/login.py <<'EOF'\nx\nEOF"],
    ['cat >>', 'cat >> src/auth/login.py <<EOF\nx\nEOF'],
    ['echo', 'echo x > src/auth/login.py'],
    ['printf', "printf 'x' > src/auth/login.py"],
    ['tee', 'echo x | tee src/auth/login.py'],
    ['tee -a', 'echo x | tee -a src/auth/login.py'],
    ['sed -i', "sed -i '' 's/x/y/' src/auth/old.js"],
    ['perl -pi', "perl -pi -e 's/x/y/' src/auth/old.js"],
    ['python -c', "python3 -c \"open('src/auth/login.py','w').write('x')\""],
    ['cp', 'cp /etc/hosts src/auth/login.py'],
    ['mv', 'mv src/auth/old.js src/auth/new.js'],
    ['> truncation', ': > src/auth/old.js'],
    ['workflow yaml', 'echo x > .github/workflows/ci.yml'],
    ['bash heredoc script', 'bash <<EOF\necho x > src/auth/login.py\nEOF'],
  ]) {
    test(`ship-it-guard ${host}: hard-risk shell write via ${name}, no PLAN.md -> BLOCK`, () => withRepo((home, repo) => {
      const r = run('ship-it-guard.js', host, home, cmd, repo, GATE);
      assertBlock(r);
      assert.match(r.stderr, /PLAN\.md/);
    }));
  }

  test(`ship-it-guard ${host}: PLAN.md present, ordinary path, scratch, docs, gate off, setting off -> allow`, () => withRepo((home, repo) => {
    const risky = 'echo x > src/auth/login.py';
    assert.strictEqual(run('ship-it-guard.js', host, home, risky, repo).status, 0, 'gate off by default');
    assert.strictEqual(run('ship-it-guard.js', host, home, risky, repo, Object.assign({ ANTIHALL_SHELL_WRITE_CHECKS: 'off' }, GATE)).status, 0);
    for (const cmd of ['echo x > src/app.js', 'echo x > src/auth/README.md', 'echo x > /tmp/auth/login.py',
      'echo x > "$AUTH_FILE"', 'git status']) {
      assert.strictEqual(run('ship-it-guard.js', host, home, cmd, repo, GATE).status, 0, cmd);
    }
    fs.writeFileSync(path.join(repo, 'PLAN.md'), '# Plan\n');
    const r = run('ship-it-guard.js', host, home, risky, repo, GATE);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'no conformance advisory on Bash');
  }));
}

// ------------------------------------------------------------ edit parity (command-guard)
for (const host of ['claude', 'codex']) {
  test(`command-guard ${host}: main-thread python -c / node -e literal repo write -> BLOCK (edit parity)`, () => withRepo((home, repo) => {
    for (const cmd of ["python3 -c \"open('src/a.py','w').write('x')\"", "node -e 'require(\"fs\").writeFileSync(\"src/a.js\",\"x\")'"]) {
      const r = run('command-guard.js', host, home, cmd, repo);
      assertBlock(r);
      assert.match(r.stdout, /does not touch files directly/, cmd);
    }
  }));

  test(`command-guard ${host}: python -c reads, scratch writes, notes writes -> allow`, () => withRepo((home, repo) => {
    for (const cmd of ["python3 -c \"print(open('src/a.py').read())\"", "python3 -c \"open('/tmp/ah-sw.txt','w').write('x')\"",
      "python3 -c \"open('.anti-hall/history/n.md','w').write('x')\""]) {
      assert.strictEqual(run('command-guard.js', host, home, cmd, repo).status, 0, cmd);
    }
  }));

  test(`command-guard ${host}: guards.bashEditParity off -> python -c write allowed`, () => withRepo((home, repo) => {
    const r = run('command-guard.js', host, home, "python3 -c \"open('src/a.py','w').write('x')\"", repo, { ANTIHALL_BASH_EDIT_PARITY: 'off' });
    assert.strictEqual(r.status, 0);
  }));
}

// ------------------------------------------------------------ commands over the classify cap
const bigBody = (n) => FAKE_PY.repeat(n);
for (const host of ['claude', 'codex']) {
  test(`api-guard ${host}: 96 KB heredoc write with a fake API -> BLOCK; 1 MB command stays fast`, () => withRepo((home, repo) => {
    const cmd = "cat > src/auth/big.py <<'EOF'\n" + bigBody(3000) + 'EOF\necho done\n';
    assert.ok(cmd.length > 65536);
    const r = run('api-guard.js', host, home, cmd, repo);
    assertBlock(r);
    assert.match(r.stderr, /os\.getcwdz/);
    // over api-guard's own 600 KB chunk cap (same as the Write tool): allowed, but not slow
    const t = Date.now();
    const r2 = run('api-guard.js', host, home, "cat > src/auth/big.py <<'EOF'\n" + bigBody(35000) + 'EOF\n', repo);
    assert.strictEqual(r2.status, 0);
    assert.ok(Date.now() - t < 1500, 'hook wall time ' + (Date.now() - t) + ' ms (incl. node startup)');
  }));

  test(`ship-it-guard ${host}: 96 KB heredoc write to a hard-risk path -> BLOCK`, () => withRepo((home, repo) => {
    assertBlock(run('ship-it-guard.js', host, home, "cat > src/auth/big.py <<'EOF'\n" + bigBody(3000) + 'EOF\n', repo, GATE));
  }));

  test(`api-guard ${host}: big command with real API, or a big non-heredoc command -> allow`, () => withRepo((home, repo) => {
    assert.strictEqual(run('api-guard.js', host, home, "cat > src/x.py <<'EOF'\n" + REAL_PY.repeat(5000) + 'EOF\n', repo).status, 0);
    assert.strictEqual(run('api-guard.js', host, home, 'echo ok\n' + '# pad\n'.repeat(12000), repo).status, 0);
  }));
}

test('shellWrites: big command keeps its target, real body, and a write after the heredoc', () => withRepo((home, repo) => {
  const p = { cwd: repo, session_id: 'sw-1' };
  const cmd = "cat > src/a.py <<'EOF'\n" + bigBody(3000) + 'EOF\necho x > b.js\n';
  const got = (c) => sw.shellWrites(c, p).map((w) => [path.relative(repo, w.abs), w.content && w.content.length]);
  assert.deepStrictEqual(got(cmd), [['src/a.py', bigBody(3000).length], ['b.js', 2]]);
  // a cd on the header line: the target is resolved, the text after the heredoc is not guessed at
  assert.deepStrictEqual(got(cmd.replace('cat > src/a.py', 'cd src && cat > a.py')), [['src/a.py', bigBody(3000).length]]);
  // a big command without a heredoc is judged on its first 16 KB
  const big = 'echo x > a.py\n' + '# pad\n'.repeat(12000);
  assert.deepStrictEqual(sw.shellWrites(big, p).map((w) => path.relative(repo, w.abs)), ['a.py']);
}));

// ------------------------------------------------------------ inline-code write literals
test('inlineWriteLiterals: perl 2/3-arg open, ruby File.open/write, node write/append/createWriteStream', () => withRepo((home, repo) => {
  const p = { cwd: repo, session_id: 'sw-1' };
  const got = (c) => sw.shellWrites(c, p).map((w) => path.relative(repo, w.abs));
  assert.deepStrictEqual(got(`perl -e "open(F,'>','src/a.pl')"`), ['src/a.pl']);
  assert.deepStrictEqual(got(`perl -e 'open(F,">src/b.pl")'`), ['src/b.pl']);
  assert.deepStrictEqual(got(`perl -e 'open(my $f, ">>", "src/c.pl")'`), ['src/c.pl']);
  assert.deepStrictEqual(got(`perl -e 'open(F,"<src/h.pl")'`), []);
  assert.deepStrictEqual(got(`perl -e 'open(F,"<","src/h.pl")'`), []);
  // dup-handle opens are not file writes
  for (const c of [
    `perl -e 'open(F,">&STDERR")'`,
    `perl -e 'open(F,">&=2")'`,
    `perl -e 'open(F,">-")'`,
    `perl -e 'open(F,">>&STDOUT")'`,
    `perl -e 'open(F,">&",\\*STDOUT)'`,
    `perl -e 'open(F,">&=",2)'`,
    `perl -e 'open(F,">>&","STDOUT")'`,
  ]) {
    assert.deepStrictEqual(got(c), [], c);
    assert.deepStrictEqual(classifyBashWork(c, p, { sessionStartTs: Date.now() - 1000 }).editBlocks || [], [], c);
  }
  assert.deepStrictEqual(got(`ruby -e "File.open('src/d.rb','w'){}"`), ['src/d.rb']);
  assert.deepStrictEqual(got(`ruby -e "File.write('src/e.rb','x')"`), ['src/e.rb']);
  assert.deepStrictEqual(got(`node -e "require('fs').appendFileSync('src/f.js','x')"`), ['src/f.js']);
  assert.deepStrictEqual(got(`node -e "require('fs').writeFileSync('src/f.js','x')"`), ['src/f.js']);
  assert.deepStrictEqual(got(`node -e "require('fs').createWriteStream('src/g.js')"`), ['src/g.js']);
}));

for (const host of ['claude', 'codex']) {
  test(`command-guard ${host}: commands over 64 KB still get Bash edit parity -> BLOCK`, () => withRepo((home, repo) => {
    assertBlock(run('command-guard.js', host, home, "python3 -c \"open('src/a.py','w').write('x')\"\n" + '# pad\n'.repeat(15000), repo));
    assertBlock(run('command-guard.js', host, home, "cat > src/auth/big.py <<'EOF'\n" + bigBody(3000) + 'EOF\n', repo));
    assert.strictEqual(run('command-guard.js', host, home, "python3 -c \"print(1)\"\n" + '# pad\n'.repeat(15000), repo).status, 0);
  }));
}

// ------------------------------------------------------------ registration
test('api-guard and ship-it-guard are registered on Bash for both hosts', () => {
  const root = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  for (const [file, re] of [['hooks/hooks.json', /Bash/], ['codex/hooks/hooks.json', /Bash/]]) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const hook of ['api-guard.js', 'ship-it-guard.js']) {
      const entry = cfg.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes(hook)));
      assert.ok(entry && re.test(entry.matcher), file + ' ' + hook + ' matcher ' + (entry && entry.matcher));
      assert.ok(new RegExp('^(?:' + entry.matcher + ')$').test('Bash'), entry.matcher);
    }
  }
});
