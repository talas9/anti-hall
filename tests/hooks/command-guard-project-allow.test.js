'use strict';
// command-guard.js — per-project command allowlist (owner-approved
// 2026-09-26, "Allow this command for this project"). A repo opts itself
// INTO a bounded set of sanctioned exact commands (e.g. its own deploy
// script — that project's own rule says a deploy is never delegated to a
// subagent) by committing `<repo-toplevel>/.anti-hall/command-allow.json`.
// Applies ONLY in the MAIN THREAD (coordinator) — a subagent already passes
// straight through command-guard before this carve-out is ever reached.
//
// Rules under test:
//   - default (no config file) is a no-op — behavior unchanged.
//   - a pattern must be LITERALLY anchored (`^...$`); anything else is
//     ignored (ignored, not a crash, not a match).
//   - the WHOLE command must be exactly one unbroken segment — no chaining
//     (`;`/`&&`/`||`), no pipes, no subshells/`{ }`/`( )` groups, no
//     backtick or `$( )` command substitution.
//   - no unquoted `<`/`>` redirect anywhere in the command.
//   - a match writes ONE audit line to
//     ~/.anti-hall/logs/command-allow.ndjson.
//   - guards.projectCommandAllow=false kills the whole carve-out.
//   - a subagent payload is never exempted through this path (it never even
//     reaches it, but assert the observable behavior anyway).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
// `firebase` is a HEAVY_VERB (see command-guard.js HEAVY_VERBS), so this
// exact deploy invocation is genuinely blocked without the allowlist —
// unlike a custom `bin/deploy.sh` wrapper, which isHeavyCommand() would
// never flag in the first place (nothing to carve an exception INTO). Using
// a command the guard already blocks is what actually exercises the
// carve-out under test.
const DEPLOY_PATTERN = '^firebase deploy --only functions:[a-z0-9,:]+ --project [a-z0-9-]+$';
const DEPLOY_CMD = 'firebase deploy --only functions:api,jobs --project acme-prod';

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdallow-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

function writeAllowConfig(repo, patterns) {
  fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.anti-hall', 'command-allow.json'),
    JSON.stringify({ patterns }, null, 2),
  );
}

function payload(command, { agentId, cwd } = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd: cwd || process.cwd(),
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

function run(command, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    const res = testHook(HOOK, payload(command, { agentId: o.agentId, cwd: o.cwd }), {
      home: h.home, env: Object.assign({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, o.env || {}),
    });
    return { res, home: h.home };
  } finally {
    if (!o.keepHome) h.cleanup();
  }
}

function auditLines(home) {
  const p = path.join(home, '.anti-hall', 'logs', 'command-allow.ndjson');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('project-command-allow: no config file at all -> a heavy command still blocks exactly as before (default is a no-op)', () => {
  const repo = makeGitRepo();
  try {
    const { res, home } = run('npm run build', { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'a repo with no command-allow.json must behave byte-identically to pre-feature: heavy still blocks');
      assert.deepStrictEqual(auditLines(home), [], 'no audit line without a config file');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: config file present but a DIFFERENT command runs -> still blocks, no audit line', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, [DEPLOY_PATTERN]);
    const { res, home } = run('npm run build', { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'a non-matching heavy command must still block');
      assert.deepStrictEqual(auditLines(home), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: exact allowed command matches an anchored pattern -> allowed + ONE audit line', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, [DEPLOY_PATTERN]);
    const { res, home } = run(DEPLOY_CMD, { cwd: repo, keepHome: true });
    try {
      assert.notStrictEqual(res.status, 2, 'exact allowed command must not block: ' + res.stdout);
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 1, 'exactly one audit line expected');
      assert.strictEqual(lines[0].command, DEPLOY_CMD);
      assert.strictEqual(lines[0].pattern, DEPLOY_PATTERN);
      assert.strictEqual(lines[0].cwd, repo);
      assert.ok(lines[0].repo, 'repo field should be populated');
      assert.ok(lines[0].ts, 'ts field should be populated');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: chained variant (&&) is blocked even though the base command matches', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, [DEPLOY_PATTERN]);
    const { res, home } = run(DEPLOY_CMD + ' && rm -rf /tmp/x', { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'chained command must still block');
      assert.deepStrictEqual(auditLines(home), [], 'chaining must never produce an audit line');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: piped variant (|) is blocked', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, [DEPLOY_PATTERN]);
    const { res, home } = run(DEPLOY_CMD + ' | tee /tmp/out', { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'piped command must still block');
      assert.deepStrictEqual(auditLines(home), [], 'a pipe must never produce an audit line');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: redirect variant (>) is blocked even as a single segment', () => {
  const repo = makeGitRepo();
  try {
    // A pattern permissive enough to literally match the redirected text,
    // to prove the redirect check is a SEPARATE, unconditional veto, not
    // just relying on the pattern's own strictness.
    const cmd = DEPLOY_CMD + ' > /tmp/out.log';
    writeAllowConfig(repo, ['^' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$']);
    const { res, home } = run(cmd, { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'a redirect must still block the underlying heavy command');
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 0, 'a redirect must never produce an audit line / allow');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: command substitution ($( )) is blocked', () => {
  const repo = makeGitRepo();
  try {
    const cmd = 'firebase deploy --only functions:$(cat x) --project acme-prod';
    writeAllowConfig(repo, ['^' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$']);
    const { res, home } = run(cmd, { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'command substitution must still block the underlying heavy command');
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 0, 'command substitution must never be allowed through this carve-out');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: backtick substitution is blocked', () => {
  const repo = makeGitRepo();
  try {
    const cmd = 'firebase deploy --only functions:`cat x` --project acme-prod';
    writeAllowConfig(repo, ['^' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$']);
    const { res, home } = run(cmd, { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'backtick substitution must still block the underlying heavy command');
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 0, 'backtick substitution must never be allowed through this carve-out');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: an UNANCHORED pattern (missing ^ or $) is ignored, never matches', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, ['firebase deploy --only functions:[a-z0-9,:]+ --project [a-z0-9-]+']);
    const { res, home } = run(DEPLOY_CMD, { cwd: repo, keepHome: true });
    try {
      assert.strictEqual(res.status, 2, 'an unanchored pattern must never allow the command through');
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 0, 'unanchored pattern must never match');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: SUBAGENT context is not exempted (never reaches the carve-out; heavy cmd still allowed through the ordinary subagent pass-through, not this carve-out — no audit line)', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, ['^npm run build$']);
    const { res, home } = run('npm run build', { cwd: repo, agentId: 'sub-1', keepHome: true });
    try {
      assert.notStrictEqual(res.status, 2, 'a subagent must never be blocked by command-guard at all');
      const lines = auditLines(home);
      assert.strictEqual(lines.length, 0, 'a subagent pass-through must never write a project-command-allow audit line');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('project-command-allow: kill-switch guards.projectCommandAllow=false disables the carve-out entirely', () => {
  const repo = makeGitRepo();
  try {
    writeAllowConfig(repo, [DEPLOY_PATTERN]);
    const h = makeHome();
    try {
      fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
      fs.writeFileSync(
        path.join(h.home, '.anti-hall', 'settings.json'),
        JSON.stringify({ guards: { projectCommandAllow: false } }),
      );
      const res = testHook(HOOK, payload(DEPLOY_CMD, { cwd: repo }), {
        home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      });
      const lines = auditLines(h.home);
      assert.strictEqual(lines.length, 0, 'kill-switch off must never write an audit line / allow via this carve-out');
    } finally {
      h.cleanup();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
