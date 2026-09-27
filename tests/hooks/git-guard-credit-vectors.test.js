'use strict';
// git-guard self-credit: every route a commit message can take past the
// per-flag (-m / -F / --trailer) scan. PreToolUse vectors must BLOCK (exit 2);
// the PostToolUse `--audit` mode must flag a trailer that a repo commit-msg
// hook added (a route no command-line scan can see).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';
const HOOK_ABS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', HOOK);
const CR = 'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';

function run(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home });
  } finally {
    h.cleanup();
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-vectors-'));
const creditFile = path.join(tmp, 'credit.txt');
fs.writeFileSync(creditFile, 'subject\n\n' + CR + '\n');
const cleanFile = path.join(tmp, 'clean.txt');
fs.writeFileSync(cleanFile, 'subject\n\nordinary body\n');

const BLOCK = {
  'pipe into -F -': `printf 'x\\n\\n${CR}\\n' | git commit -F -`,
  'echo into --file=-': `echo -e "x\\n\\n${CR}" | git commit --file=-`,
  'file written in the same command': `printf 'x\\n\\n${CR}\\n' > ${tmp}/m.txt && git commit -F ${tmp}/m.txt`,
  'shell variable': `M="x\n\n${CR}"; git commit -m "$M"`,
  'variable through bash -c': `M="x\n\n${CR}"; bash -c 'git commit -m "$M"'`,
  'git merge -m': `git merge feature -m "x\n\n${CR}"`,
  'git merge -F <file>': `git merge feature -F ${creditFile}`,
  'git merge --squash then commit -F -': `git merge --squash f && printf 'x\\n\\n${CR}\\n' | git commit -F -`,
  'git rebase -x amend': `git rebase -x "git commit --amend -m 'x\n\n${CR}'" HEAD~1`,
  'git commit-tree -m': `git commit-tree HEAD^{tree} -m "x\n\n${CR}"`,
  'interpret-trailers --trailer': `git interpret-trailers --trailer "${CR}" --in-place m.txt && git commit -F m.txt`,
  'gh pr merge --body': `gh pr merge 5 --squash --body "x\n\n${CR}"`,
  'gh pr merge --subject/--body link': 'gh pr merge 5 --squash --subject "x" --body "via claude.com/claude-code"',
  'gh pr create --body-file <file>': `gh pr create --title t --body-file ${creditFile}`,
  'gh pr create --body-file - heredoc': `gh pr create --title t --body-file - <<'EOF'\nbody\n\n${CR}\nEOF`,
};

for (const [name, cmd] of Object.entries(BLOCK)) {
  test(`BLOCK: ${name}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /self-credit|AI attribution/);
  });
}

const ALLOW = {
  'merge -m clean': 'git merge feature -m "merge feature"',
  'merge -F clean file': `git merge feature -F ${cleanFile}`,
  'pipe clean message': "printf 'x\\n\\nbody\\n' | git commit -F -",
  'mid-line mention of the trailer in a grep + commit': 'git log --grep "Co-Authored-By: Claude" | wc -l && git commit -m "docs: explain trailer"',
  'rebase without credit': 'git rebase -x "npm test" HEAD~3',
  'gh pr merge clean': 'gh pr merge 5 --squash --body "Fixes #4"',
  'trailer text in a non-commit command': `printf 'x\\n\\n${CR}\\n' > notes.txt`,
};

for (const [name, cmd] of Object.entries(ALLOW)) {
  test(`ALLOW: ${name}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// ---------------------------------------------------------------------------
// PostToolUse audit: a repo commit-msg hook appends the trailer AFTER the
// PreToolUse scan saw a clean `git commit -m clean`.
function audit(command, cwd, home) {
  const r = spawnSync(process.execPath, [HOOK_ABS, '--audit'], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    env: { PATH: process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1' },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout };
}

function fixtureRepo(home) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-audit-repo-'));
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...a) => {
    const r = spawnSync('git', ['-C', repo, ...a], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a'), 'a\n');
  g('add', 'a');
  return { repo, g };
}

test('AUDIT: commit-msg hook-authored trailer is flagged after a clean-looking commit', () => {
  const h = makeHome();
  const { repo, g } = fixtureRepo(h.home);
  try {
    const hookPath = path.join(repo, '.git', 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '\\n${CR}\\n' >> "$1"\n`, { mode: 0o755 });
    g('commit', '-q', '-m', 'clean');
    // The PreToolUse scan cannot see the hook's trailer: it allows.
    assert.strictEqual(run('git commit -q -m clean').status, 0);
    const r = audit('git commit -q -m clean', repo, h.home);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /git-guard \(audit\)/);
    assert.match(r.stdout, /PostToolUse/);
    // cd-prefixed and -C forms resolve the same repo from another cwd.
    assert.match(audit(`cd ${repo} && git commit -q -m clean`, os.tmpdir(), h.home).stdout, /git-guard \(audit\)/);
    assert.match(audit(`git -C ${repo} commit -q -m clean`, os.tmpdir(), h.home).stdout, /git-guard \(audit\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    h.cleanup();
  }
});

test('AUDIT: clean commit and non-commit commands emit nothing', () => {
  const h = makeHome();
  const { repo, g } = fixtureRepo(h.home);
  try {
    g('commit', '-q', '-m', 'clean');
    assert.strictEqual(audit('git commit -q -m clean', repo, h.home).stdout, '');
    assert.strictEqual(audit('git status', repo, h.home).stdout, '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    h.cleanup();
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
