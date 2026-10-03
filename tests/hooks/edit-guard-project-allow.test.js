'use strict';
// edit-guard per-project doc-edit allowlist (0.112, owner-approved 2026-09-26).
// <repo>/.anti-hall/edit-allow.json {"paths":[repo-relative globs]} lets the
// MAIN THREAD edit matching files directly, but only once the user trusted the
// exact file bytes (~/.anti-hall/trusted-edit-allow.json, the same
// lib/command-allow.js machinery as command-allow.json). Every run uses a fresh
// isolated HOME and an explicit fixture repo/cwd.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'edit-guard.js';
const allowLib = require('../../plugins/anti-hall/hooks/lib/command-allow.js');
const SETTINGS_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'settings.js');
const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egallow-repo-')));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# guide\n');
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'x\n');
  return dir;
}

function writeAllow(repo, paths) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.anti-hall', 'edit-allow.json'), JSON.stringify({ paths }));
}

function trust(home, repo) {
  const f = allowLib.readAllowFile(repo, 'edit');
  allowLib.recordTrust(home, repo, f.hash, 'edit');
}

// edit(repo, home, filePath, extra, env) -> spawn result for a main-thread Edit.
function edit(repo, home, filePath, extra, env) {
  return testHook(HOOK, Object.assign({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
    session_id: 't',
    cwd: repo,
  }, extra || {}), { home, env: Object.assign({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, env || {}) });
}

// withTrusted(paths, fn): fresh repo + home with `paths` written and TRUSTED.
function withTrusted(paths, fn, { trusted = true } = {}) {
  const repo = makeRepo();
  const h = makeHome();
  try {
    writeAllow(repo, paths);
    if (trusted) trust(h.home, repo);
    return fn(repo, h.home);
  } finally {
    h.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const DOCS = ['docs/**', 'NOTES.md'];

test('allowed: a trusted glob lets the main thread edit a matching doc', () => {
  withTrusted(DOCS, (repo, home) => {
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 0);
    assert.strictEqual(edit(repo, home, path.join(repo, 'docs', 'new', 'page.md')).status, 0, 'absolute path inside the repo');
    assert.strictEqual(edit(repo, home, 'NOTES.md').status, 0);
  });
});

test('control: a path the allowlist does not match stays blocked', () => {
  withTrusted(DOCS, (repo, home) => {
    const r = edit(repo, home, 'src/x.js');
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.stdout, /EDIT-DELEGATION RULE/);
  });
});

test('untrusted: a never-trusted allowlist applies nothing', () => {
  withTrusted(DOCS, (repo, home) => {
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 2);
  }, { trusted: false });
});

test('edited: changing the file after trust revokes it', () => {
  withTrusted(DOCS, (repo, home) => {
    writeAllow(repo, DOCS.concat(['src/**']));
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 2);
    assert.strictEqual(edit(repo, home, 'src/x.js').status, 2);
  });
});

test('self-edit: the main thread may never edit .anti-hall/edit-allow.json (any case)', () => {
  withTrusted(['docs/**', '.anti-hall/**', '**/*.json'], (repo, home) => {
    for (const p of ['.anti-hall/edit-allow.json', path.join(repo, '.anti-hall', 'edit-allow.json'), '.anti-hall/EDIT-ALLOW.json', 'docs/../.anti-hall/edit-allow.json']) {
      for (const tool of ['Edit', 'Write']) {
        const r = edit(repo, home, p, { tool_name: tool });
        assert.strictEqual(r.status, 2, tool + ' ' + p + ': ' + r.stdout);
        assert.match(r.stdout, /EDIT-ALLOW SELF-EDIT/);
      }
    }
  });
});

test('traversal: `..` / absolute / outside-repo / symlinked targets never match', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egallow-outside-')));
  try {
    fs.mkdirSync(path.join(outside, 'docs'), { recursive: true });
    withTrusted(['docs/**', '../**', '/etc/**', '**/*.js'], (repo, home) => {
      // `..` inside the file_path that escapes docs/ into src/ -> src/x.js is matched on its real path
      assert.strictEqual(edit(repo, home, 'docs/../src/x.js').status, 0, '**/*.js matches the real repo path src/x.js (control)');
      // a path outside the repo, even one whose tail looks like docs/**
      assert.strictEqual(edit(repo, home, path.join(outside, 'docs', 'a.md')).status, 2);
      assert.strictEqual(edit(repo, home, '../' + path.basename(outside) + '/docs/a.md').status, 2);
      // a symlink inside docs/ pointing out of the repo
      fs.symlinkSync(path.join(outside, 'docs'), path.join(repo, 'docs', 'link'));
      assert.strictEqual(edit(repo, home, 'docs/link/a.md').status, 2);
      // a symlinked file inside docs/ pointing at an in-repo source file
      fs.symlinkSync(path.join(repo, 'src', 'x.js'), path.join(repo, 'docs', 'alias.md'));
      assert.strictEqual(edit(repo, home, 'docs/alias.md').status, 2);
    });
    withTrusted(['../**', '/etc/**', '**', '*', '**/*'], (repo, home) => {
      assert.strictEqual(edit(repo, home, 'src/x.js').status, 2, 'match-everything globs are ignored');
      assert.strictEqual(edit(repo, home, path.join(outside, 'docs', 'a.md')).status, 2, '../** is ignored');
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('never matches .git, hook config or tool config, whatever the glob says', () => {
  withTrusted(['**/*.md', '**/*.json', '.git/**', '.codex/**', '.husky/**'], (repo, home) => {
    for (const p of ['.git/info/x.md', '.git/config', '.codex/hooks.json', 'sub/hooks.json', '.husky/pre-commit']) {
      assert.strictEqual(edit(repo, home, p).status, 2, p);
    }
    assert.strictEqual(edit(repo, home, 'docs/a.md').status, 0, 'control');
  });
});

test('F2: unicode-folded spellings of denied names are denied too (NFKC + lowercase)', () => {
  withTrusted(['**/*.json', '**/*.md', 'sub/**', '.huſky/**', '.anti-hall/**'], (repo, home) => {
    // U+017F LATIN SMALL LETTER LONG S folds to "s" under NFKC; U+FF41 fullwidth a -> "a".
    for (const p of ['sub/hook\u017f.json', 'sub/HOOK\u017f.JSON', '.hu\u017fky/pre-commit.md', '.GIT/x.md', '.\uff41nti-hall/edit-allow.json']) {
      assert.strictEqual(edit(repo, home, p).status, 2, JSON.stringify(p));
    }
    assert.strictEqual(edit(repo, home, 'sub/ok.json').status, 0, 'control');
  });
});

test('a symlinked edit-allow.json is refused even when its bytes are trusted', () => {
  withTrusted(DOCS, (repo, home) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egallow-link-'));
    try {
      const real = path.join(outside, 'allow.json');
      fs.copyFileSync(path.join(repo, '.anti-hall', 'edit-allow.json'), real);
      fs.rmSync(path.join(repo, '.anti-hall', 'edit-allow.json'));
      fs.symlinkSync(real, path.join(repo, '.anti-hall', 'edit-allow.json'));
      assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 2);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('subagent context is unchanged (edit-guard never applies there)', () => {
  withTrusted(DOCS, (repo, home) => {
    const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
    assert.strictEqual(edit(repo, home, 'src/x.js', sub).status, 0);
    assert.strictEqual(edit(repo, home, '.anti-hall/edit-allow.json', sub).status, 0);
  }, { trusted: false });
});

test('guards.projectEditAllow=false turns the allowlist (and its self-edit block) off', () => {
  withTrusted(DOCS, (repo, home) => {
    const off = { ANTIHALL_PROJECT_EDIT_ALLOW: 'false' };
    assert.strictEqual(edit(repo, home, 'docs/guide.md', null, off).status, 2);
    assert.strictEqual(edit(repo, home, '.anti-hall/edit-allow.json', null, off).status, 0, "0.111 behaviour: '.anti-hall/**' default allow");
  });
});

test('trust CLI: without --confirmed records nothing; with it the allowlist applies', () => {
  withTrusted(DOCS.concat(['**', '../x']), (repo, home) => {
    const cli = (args) => cp.spawnSync(process.execPath, [SETTINGS_JS].concat(args), {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
    });
    const dry = cli(['trust-edit-allow', repo]);
    assert.strictEqual(dry.status, 1);
    assert.match(dry.stdout, /docs\/\*\*/);
    assert.match(dry.stdout, /ignored: matches every file/);
    assert.match(dry.stdout, /ignored: \.\. path segment/);
    assert.ok(!fs.existsSync(allowLib.trustFilePath(home, 'edit')), 'nothing recorded without --confirmed');
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 2);

    const yes = cli(['trust-edit-allow', repo, '--confirmed', '--json']);
    assert.strictEqual(yes.status, 0, yes.stderr);
    const out = JSON.parse(yes.stdout);
    const rec = JSON.parse(fs.readFileSync(allowLib.trustFilePath(home, 'edit'), 'utf8'));
    assert.strictEqual(rec[fs.realpathSync(repo)], out.sha256);
    assert.ok(!fs.existsSync(allowLib.trustFilePath(home, 'command')), 'edit trust never writes the command trust file');
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 0);
  }, { trusted: false });
});

test('command-allow trust does not trust an edit-allow.json (separate records)', () => {
  withTrusted(DOCS, (repo, home) => {
    const f = allowLib.readAllowFile(repo, 'edit');
    allowLib.recordTrust(home, repo, f.hash, 'command');
    assert.strictEqual(edit(repo, home, 'docs/guide.md').status, 2);
  }, { trusted: false });
});

function runDoctor(cwd, home) {
  // Never the real machine home: fall back to a disposable temp HOME.
  const fallbackHome = home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }),
  });
  return (res.stdout || '') + (res.stderr || '');
}

test('doctor: reports an untrusted, then a changed, edit-allow.json with the trust command', () => {
  withTrusted(DOCS.concat(['**']), (repo, home) => {
    let out = runDoctor(repo, home);
    assert.match(out, /edit-allow\.json is NOT trusted/);
    assert.match(out, /trust-edit-allow/);
    assert.match(out, /edit-allow\.json has 1 ignored path/);
    trust(home, repo);
    writeAllow(repo, DOCS);
    out = runDoctor(repo, home);
    assert.match(out, /edit-allow\.json CHANGED since you trusted it/);
  }, { trusted: false });
});
