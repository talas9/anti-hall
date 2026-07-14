'use strict';
// edit-guard (PreToolUse Write|Edit|MultiEdit|NotebookEdit). Coordinator => may
// block (exit 2 + decision); subagent => always allow (exit 0). Mirrors
// command-guard.test.js's structure for the Edit-family tools instead of Bash.
//
// COORDINATOR env: CLAUDE_CODE_ENTRYPOINT='cli' AND no agent_id in the payload.
// SUBAGENT: agent_id in the PAYLOAD (the cmux-reliable signal).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'edit-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

// Coordinator run with a fresh fake HOME (no skip.json -> guard active).
function runCoord(payload, env) {
  const h = makeHome();
  try {
    return testHook(HOOK, payload, { home: h.home, env: Object.assign({}, COORD, env || {}) });
  } finally {
    h.cleanup();
  }
}

test('COORD BLOCK: cli + Edit on src/app.js', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }));
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) {
  test(`COORD BLOCK: ${tool} variant`, () => {
    const r = runCoord(editPayload(tool, { filePath: 'src/app.js' }));
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

test('SUBAGENT ALLOW: cli + Edit + agent_id/agent_type present', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js', agentId: 'test-agent' }));
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('FAIL-OPEN: no entrypoint env -> allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test("FAIL-OPEN: unknown entrypoint 'weird' -> allow", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }), { CLAUDE_CODE_ENTRYPOINT: 'weird' });
  assert.strictEqual(r.status, 0);
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

const ALLOWLIST_PATHS = ['CLAUDE.md', '.claude/settings.json', '.anti-hall/x.md', 'PLAN.md'];
for (const p of ALLOWLIST_PATHS) {
  test(`ALLOWLIST: cli + Edit on ${p}`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test("ALLOWLIST: env ANTIHALL_EDIT_GUARD_ALLOW='docs/**' on docs/x.md", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'docs/x.md' }), { ANTIHALL_EDIT_GUARD_ALLOW: 'docs/**' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// BARE-FILENAME ROOT ANCHORING (P0 fix): DEFAULT_ALLOW patterns with no '/'
// ('CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'PLAN.md', 'STATE.json') must match
// ONLY a root-level file, never a same-named file nested anywhere else in the
// tree (a bug that previously allow-listed e.g. 'src/deep/nested/CLAUDE.md'
// because isAllowed tested the pattern against basename() with no path check).
const NESTED_BARE_BLOCKED = [
  'src/nested/CLAUDE.md',
  'src/app/PLAN.md',
  'a/b/STATE.json',
  'sub/AGENTS.md',
  'x/GEMINI.md',
  'src/nested/CONTINUE-HERE.md',
];
for (const p of NESTED_BARE_BLOCKED) {
  test(`BARE-FILENAME NOT ROOT-ANCHORED: cli + Edit on ${p} -> BLOCKED`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

const ROOT_BARE_ALLOWED = ['CLAUDE.md', 'PLAN.md', 'STATE.json', 'CONTINUE-HERE.md'];
for (const p of ROOT_BARE_ALLOWED) {
  test(`BARE-FILENAME ROOT-ANCHORED: cli + Edit on root ${p} -> ALLOWED`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test("ALLOWLIST: env ANTIHALL_EDIT_GUARD_ALLOW='**/CLAUDE.md' still opts nested CLAUDE.md back in", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/nested/CLAUDE.md' }), { ANTIHALL_EDIT_GUARD_ALLOW: '**/CLAUDE.md' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// CONTINUE-HERE.md: coordinator's own session-handover artifact. No subagent
// has seen the coordinator's conversation, so this is the coordinator's own
// synthesis of its own context — the same class as PLAN.md/STATE.json above,
// not delegatable. Root-anchored bare filename (see BARE-FILENAME tests above
// for the generic mechanism); these tests pin the specific allowlist entry
// and the mandated regression checks (normal file still blocked with the
// UNCHANGED reason string; a traversal/lookalike does not slip through).

for (const tool of ['Write', 'Edit']) {
  test(`CONTINUE-HERE.md ALLOWLIST: coordinator ${tool} on root CONTINUE-HERE.md -> ALLOWED`, () => {
    const r = runCoord(editPayload(tool, { filePath: 'CONTINUE-HERE.md' }));
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test('CONTINUE-HERE.md REGRESSION: normal source file still BLOCKED with unchanged reason', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/foo.js' }));
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.strictEqual(
    r.json.reason,
    'EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
    'a subagent to make this edit and have it report a tight summary. The ' +
    'coordinator synthesizes the summary; raw edits never happen in the main ' +
    'thread. (tool: Edit)',
  );
});

const CONTINUE_HERE_LOOKALIKES_BLOCKED = [
  'notes/CONTINUE-HERE.md',            // nested, not root
  '../../CONTINUE-HERE.md',            // traversal, contains '/'
  'foo/CONTINUE-HERE.md.js',           // suffix lookalike, not an exact match
  'CONTINUE-HERE.md.bak',              // suffix lookalike at root
  'notCONTINUE-HERE.md',               // substring-contains lookalike at root
];
for (const p of CONTINUE_HERE_LOOKALIKES_BLOCKED) {
  test(`CONTINUE-HERE.md LOOKALIKE NOT ALLOWLISTED: cli + Edit on ${p} -> BLOCKED`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

test("SKIP: writeSkip({'edit-guard': future}) -> allow", () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'edit-guard': Date.now() + 60000 });
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test("SKIP: writeSkip({all: future}) -> allow (honors broad 'all')", () => {
  const h = makeHome();
  try {
    h.writeSkip({ all: Date.now() + 60000 });
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('INJECTION: block reason does not echo file_path text', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/INJECTSECRET.js' }));
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect file_path text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect file_path text');
});

// ---------------------------------------------------------------------------
// SYMLINK BYPASS (security). isAllowed() matches a NAME; the OS writes to a
// TARGET. Before allowlistIsHonest(), a coordinator could `ln -s
// hooks/command-guard.js CONTINUE-HERE.md`, Edit the allowlisted NAME, and the
// write landed on the guard itself — an arbitrary-write bypass of the whole
// delegation gate. Verified live: pre-fix, all three bare-filename allowlist
// entries exited 0 through a symlink. The hole was PRE-EXISTING for
// PLAN.md/STATE.json, so every entry is covered here, not just the newest.
//
// win32 skip: creating a symlink there needs SeCreateSymbolicLinkPrivilege
// (Developer Mode / elevation), which CI runners do not reliably have — same
// idiom as the other win32-skipped fs tests in this suite.
const NO_SYMLINKS = process.platform === 'win32';

// realCwd(): a throwaway project root the guard treats as the session cwd.
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-guard-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

function runIn(project, tool, file) {
  const h = makeHome();
  try {
    return testHook(HOOK, editPayload(tool, { filePath: path.join(project.dir, file), cwd: project.dir }),
      { home: h.home, env: COORD });
  } finally {
    h.cleanup();
  }
}

for (const name of ['CONTINUE-HERE.md', 'PLAN.md', 'STATE.json', 'CLAUDE.md']) {
  test(`SYMLINK BYPASS: allowlisted ${name} that is a SYMLINK -> BLOCKED`, { skip: NO_SYMLINKS }, () => {
    const p = makeProject();
    try {
      // The exploit target: a file the guard exists to keep the coordinator away from.
      const target = path.join(p.dir, 'command-guard.js');
      fs.writeFileSync(target, 'ORIGINAL\n', 'utf8');
      fs.symlinkSync(target, path.join(p.dir, name));
      const r = runIn(p, 'Write', name);
      assert.strictEqual(r.status, 2, `symlinked ${name} must NOT be allowlisted; stdout: ${r.stdout}`);
      assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
    } finally {
      p.cleanup();
    }
  });
}

test('SYMLINK BYPASS: an allowlisted DIRECTORY glob reached through a symlinked dir -> BLOCKED', { skip: NO_SYMLINKS }, () => {
  const p = makeProject();
  try {
    fs.mkdirSync(path.join(p.dir, 'elsewhere'));
    fs.symlinkSync(path.join(p.dir, 'elsewhere'), path.join(p.dir, '.claude'));
    const r = runIn(p, 'Write', path.join('.claude', 'settings.json'));
    assert.strictEqual(r.status, 2, `a symlink TRAVERSED by the path must block too; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  } finally {
    p.cleanup();
  }
});

test('SYMLINK BYPASS: a symlinked allowlisted file blocks with the UNCHANGED reason string', { skip: NO_SYMLINKS }, () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.dir, 'target.js'), 'x\n', 'utf8');
    fs.symlinkSync(path.join(p.dir, 'target.js'), path.join(p.dir, 'CONTINUE-HERE.md'));
    const r = runIn(p, 'Edit', 'CONTINUE-HERE.md');
    assert.strictEqual(r.status, 2);
    assert.strictEqual(
      r.json.reason,
      'EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
      'a subagent to make this edit and have it report a tight summary. The ' +
      'coordinator synthesizes the summary; raw edits never happen in the main ' +
      'thread. (tool: Edit)',
    );
  } finally {
    p.cleanup();
  }
});

// FIRST-WRITE MUST STILL WORK: an ENOENT is the EXPECTED case (Write CREATES
// these files), never an fs error — if this regressed, the coordinator could no
// longer create its own handover/plan/state files at all.
for (const name of ['CONTINUE-HERE.md', 'PLAN.md', 'STATE.json']) {
  test(`SYMLINK CHECK: NON-EXISTENT ${name} (first Write) -> still ALLOWED`, () => {
    const p = makeProject();
    try {
      assert.strictEqual(fs.existsSync(path.join(p.dir, name)), false, 'precondition: file must not exist');
      const r = runIn(p, 'Write', name);
      assert.strictEqual(r.status, 0, `first Write must be allowed; stdout: ${r.stdout}`);
    } finally {
      p.cleanup();
    }
  });
}

test('SYMLINK CHECK: a REAL regular-file CONTINUE-HERE.md -> still ALLOWED', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.dir, 'CONTINUE-HERE.md'), '# handover\n', 'utf8');
    const r = runIn(p, 'Edit', 'CONTINUE-HERE.md');
    assert.strictEqual(r.status, 0, `a real regular file must stay allowed; stdout: ${r.stdout}`);
  } finally {
    p.cleanup();
  }
});

test('SYMLINK CHECK: a real allowlisted file under a real directory -> still ALLOWED', () => {
  const p = makeProject();
  try {
    fs.mkdirSync(path.join(p.dir, '.claude'));
    fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'), '{}\n', 'utf8');
    const r = runIn(p, 'Edit', path.join('.claude', 'settings.json'));
    assert.strictEqual(r.status, 0, `a real file in a real dir must stay allowed; stdout: ${r.stdout}`);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DevSwarm topology-aware wording. isDevswarmActive follows DEVSWARM_REPO_ID (auto
// mode); isChildWorkspace follows DEVSWARM_SOURCE_BRANCH (non-empty = child).
// Both roles still BLOCK a non-allowlisted edit — only the orchestrator noun in
// the reason string differs (child = "sub-orchestrator", root = "primary").

test('DEVSWARM CHILD: coordinator + child env + Edit -> block, reason says sub-orchestrator', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }),
    { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
  assert.ok(/sub-orchestrator/.test(r.json.reason), `reason: ${r.json.reason}`);
});

test('DEVSWARM PRIMARY: coordinator + primary env (no source branch) + Edit -> block, reason says primary', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }),
    { DEVSWARM_REPO_ID: 'repo-x' }); // DEVSWARM_SOURCE_BRANCH unset -> Primary
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
  assert.ok(/primary/.test(r.json.reason), `reason: ${r.json.reason}`);
  assert.ok(!/sub-orchestrator/.test(r.json.reason),
    `Primary reason must NOT say sub-orchestrator: ${r.json.reason}`);
});

// ---------------------------------------------------------------------------
// WORKSPACE-TIER REDIRECT (P0: anti-hall's own doctrine used to name "spawn a
// subagent" as the Primary's ONLY exit at the exact point it was blocked from
// editing — the decision point where a DevSwarm Primary should have spun a child
// workspace instead). What is BLOCKED is unchanged; only the redirect text differs,
// and only for a Primary.

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-x' }; // no SOURCE_BRANCH -> Primary
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' };

test('DEVSWARM PRIMARY: block reason names `devswarm.js spawn` as the PRIMARY exit', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }), PRIMARY_ENV);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  const reason = r.json.reason;
  assert.ok(/devswarm\.js spawn <branch> -p/.test(reason),
    `Primary reason must name devswarm.js spawn: ${reason}`);
  assert.ok(/workspace-scale/i.test(reason), `Primary reason must state the choice rule: ${reason}`);
  // The workspace must be named BEFORE the subagent — the subagent is the
  // alternative for small/scoped work, never the headline exit.
  assert.ok(reason.indexOf('devswarm.js spawn') < reason.indexOf('subagent'),
    `workspace exit must precede the subagent alternative: ${reason}`);
  assert.ok(/Do NOT hand a workspace-scale matter to a subagent/.test(reason),
    `Primary reason must forbid subagent-for-workspace-scale: ${reason}`);
});

test('DEVSWARM CHILD: block reason is UNCHANGED (no workspace redirect — children never spawn workspaces)', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }), CHILD_ENV);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.strictEqual(
    r.json.reason,
    'DEVSWARM EDIT-DELEGATION RULE: the sub-orchestrator does not touch files ' +
    'directly in its workspace — spawn a subagent to make this edit and have it ' +
    'report a tight summary. (tool: Edit)',
  );
});

test('NON-DEVSWARM: block reason is byte-for-byte the pre-fix baseline (no DevSwarm text)', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' })); // no DEVSWARM_* env
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.strictEqual(
    r.json.reason,
    'EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
    'a subagent to make this edit and have it report a tight summary. The ' +
    'coordinator synthesizes the summary; raw edits never happen in the main ' +
    'thread. (tool: Edit)',
  );
  assert.ok(!/devswarm/i.test(r.stdout), 'non-DevSwarm output must not mention DevSwarm');
});
