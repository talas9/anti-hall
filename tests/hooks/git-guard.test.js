'use strict';
// git-guard (PreToolUse Bash). Block => exit code 2; allow => exit 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';

// Each git-guard invocation gets a fresh fake HOME with no skip.json so the
// escape hatch is inert and the guard is fully active.
function run(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home });
  } finally {
    h.cleanup();
  }
}

// Each BLOCK case asserts BOTH the exit code AND the block REASON (matched
// against stderr). Asserting the reason stops a regression that blocks for the
// WRONG class from staying green — e.g. a force test that silently starts
// blocking via the command-substitution rule instead of force detection.
//
// Reason regexes match the EXACT messages emitted by git-guard.js scanCommand():
//   FORCE    -> 'Force push detected'                 (Rule 2, force flag/+refspec)
//   CMDSUBST -> 'command substitution / backtick'     (Rule 2, $( )/backtick arg)
//   COMMIT   -> 'AI/assistant self-credit trailer'    (Rule 1, inline -m/--trailer)
//   REMAP    -> '-c trailer.*.key=`'                  (Rule 1, trailer-key remap)
const REASON = {
  FORCE: /Force push detected/,
  CMDSUBST: /command substitution \/ backtick/,
  COMMIT: /AI\/assistant self-credit trailer/,
  REMAP: /trailer\.\*\.key=/,
  FILE: /Commit message \(via `-F`\/`--file`/,
};

const BLOCK = [
  // --- Force push (Rule 2): literal force flags / +refspec ---
  { cmd: 'git push --force', reason: REASON.FORCE },
  { cmd: 'git push -f', reason: REASON.FORCE },
  { cmd: 'git push --force-with-lease', reason: REASON.FORCE },
  { cmd: 'git push origin +main', reason: REASON.FORCE },
  { cmd: 'git push origin -- +main:main', reason: REASON.FORCE },
  // Synthetic-force via inline alias and --config-env alias smuggling. These
  // exercise the force-detection path (gitSubcommand ~lines 394/438 -> synthetic
  // `--force`), NOT the command-substitution rule — so they genuinely test force
  // logic. Verified the block message is the FORCE message, not cmd-subst.
  { cmd: 'git -c alias.p=push p origin main --force', reason: REASON.FORCE },
  { cmd: 'git --config-env alias.p=push p origin main --force', reason: REASON.FORCE },
  // Force baked INTO the alias body (no --force at the call site): the body's
  // `--force` must reach isForcePush. Blocker is FORCE, not cmd-subst.
  { cmd: "git -c alias.p='push --force origin main' p", reason: REASON.FORCE },
  // --config-env alias smuggling with NO call-site --force: the alias key alone
  // forces a synthetic force verdict. Confirms FORCE path, not cmd-subst.
  { cmd: 'git --config-env alias.p=push p origin main', reason: REASON.FORCE },
  { cmd: 'sudo git push --force', reason: REASON.FORCE },
  { cmd: 'true && git push -f', reason: REASON.FORCE },
  { cmd: 'eval "git push -f"', reason: REASON.FORCE },
  // --- Command substitution (Rule 2): NOT a force test ---
  // This blocks via the command-substitution rule (an arg produced by $( ) that
  // could smuggle --force), NOT force detection. Proven: `git push origin
  // "$(echo main)"` (no --force) also blocks with this SAME cmd-subst message, so
  // asserting CMDSUBST here is what this case actually verifies. Genuine force
  // detection is covered by the alias/--config-env cases above.
  { cmd: 'git push origin "$(echo --force)"', reason: REASON.CMDSUBST },
  // Companion proof: no --force present, still blocks for the same cmd-subst
  // reason — confirms the rule is about the un-inspectable expansion, not force.
  { cmd: 'git push origin "$(echo main)"', reason: REASON.CMDSUBST },
  // --- Self-credit in inline commit message (Rule 1) ---
  { cmd: 'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX 1: --trailer carries the AI co-author trailer on the command line.
  { cmd: 'git commit -m x --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  { cmd: 'git commit -m x --trailer="Co-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX A.1: git accepts the `key=value` trailer separator too.
  { cmd: 'git commit -m x --trailer "Co-Authored-By=Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX A.2: `-c trailer.<name>.key=<self-credit>` remaps a benign token to emit
  // a Co-Authored-By trailer, dodging the value scan. Blocker is the REMAP rule.
  { cmd: 'git -c trailer.ai.key=Co-Authored-By commit -m x --trailer "ai: Claude <noreply@anthropic.com>"', reason: REASON.REMAP },
  // --- P0-1: `bash -c "..."` / `sh -c "..."` shell-wrapper recursion ---
  // A shell wrapper's verb is not `git`, so without recursing the -c payload
  // these force/self-credit forms would fail-open (total guard bypass). Mirror
  // the eval unwrap: recurse the payload and block on the inner git violation.
  { cmd: 'bash -c "git push --force"', reason: REASON.FORCE },
  { cmd: 'sh -c "git push --force origin main"', reason: REASON.FORCE },
  { cmd: 'zsh -c "git push -f"', reason: REASON.FORCE },
  { cmd: 'sudo bash -c "git push --force"', reason: REASON.FORCE },
  { cmd: `bash -c "git commit -m x --trailer 'Co-Authored-By: Claude <noreply@anthropic.com>'"`, reason: REASON.COMMIT },
  // --- P1: `&` inside a redirection (2>&1 / >&2 / &>) is NOT a control-op ---
  // Splitting on that `&` orphaned a trailing `--force` into a non-git segment
  // so the force flag was never inspected. The push must still block.
  { cmd: 'git push origin main 2>&1 --force', reason: REASON.FORCE },
  { cmd: 'git push origin main >&2 --force', reason: REASON.FORCE },
  { cmd: 'git push origin main &>out.log --force', reason: REASON.FORCE },
  // --- `-F -` / `--file=-` fed by a heredoc (Rule 1, the F-22 fix) ---
  // A `git commit -F -`/`--file=-` reads its message from stdin; when that
  // stdin is a heredoc ON THE SAME command line, the guard must scan the body
  // exactly like an inline -m message. Prior to the fix, the heredoc body's
  // own newlines fragmented it into unrelated segments and the trailer never
  // reached a `git`-verb segment (confirmed bypass, defect report).
  {
    cmd: 'git commit -q -F - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // Unquoted delimiter (<<EOF, not <<'EOF') must ALSO be recognized.
  {
    cmd: 'git commit -F - <<EOF\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `--file=-` long-flag form.
  {
    cmd: 'git commit --file=- <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `--file -` separate-token form.
  {
    cmd: 'git commit --file - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `-F /dev/stdin` explicit-path spelling of stdin.
  {
    cmd: 'git commit -F /dev/stdin <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // --- P0 REGRESSION REPROS (security review, reworked patch) ---
  // A heredoc opener line's TRAILING control operator (&&, ;, |, |&) chains a
  // SEPARATE command that runs after the heredoc body is consumed. A prior
  // version of this fix folded heredoc-body consumption INTO splitSegments
  // itself and appended "the rest of the opener line" (including the chained
  // `&& git push --force ...`) into the SAME segment as the heredoc-opening
  // command verbatim, without re-splitting on the operator — so the chained
  // command's own verb/flags were never inspected as their own segment
  // (confirmed base=BLOCKED / that patched=ALLOWED bypass). splitSegments is
  // now byte-identical to base, so these must block exactly like base does
  // (each simply splits on the operator; the heredoc body's line-by-line
  // fragmentation is incidental to base's plain `\n`-splits, not a heredoc
  // feature of this fix).
  { cmd: 'cat <<EOF && git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF ; git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF | git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF |& git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<-EOF && git push --force origin main\n\tbody\n\tEOF', reason: REASON.FORCE },
  // Unterminated heredoc: base has no heredoc awareness at all, so the
  // `git push --force origin main` line is just its own `\n`-split segment
  // regardless of any (missing) terminator — must still block.
  { cmd: 'cat <<EOF\ngit push --force origin main', reason: REASON.FORCE },
];

const ALLOW = [
  'git push origin main',
  'git push origin -- main',
  'git status',
  'git commit -m "feat: x"',
  'eval "git status"',
  // FIX 1: a benign trailer (human reviewer) must NOT be blocked.
  'git commit -m x --trailer "Reviewed-by: Alice"',
  // FIX A.1: a benign `=`-form trailer must still ALLOW.
  'git commit -m x --trailer "Reviewed-by=Alice"',
  // FIX A.2: a non-self-credit `-c trailer.*.key=` remap stays allowed.
  'git -c trailer.sob.key=Signed-off-by commit -m x --trailer "sob: Alice"',
  // P0-1: a benign shell-wrapped command must NOT be over-blocked.
  'bash -c "git status"',
  'sh -c "npm test"',
  'bash -c "git push origin main"',
  // P1: a legitimate push with a redirection (no force) must still ALLOW —
  // the redirection `&` must not be misread as force, nor over-block.
  'git push origin main 2>&1',
  'git push origin main &>out.log',
  // `-F -` fed by a heredoc with NO self-credit trailer must still ALLOW —
  // proves the new heredoc-body scan doesn't over-block ordinary messages.
  'git commit -q -F - <<\'EOF\'\nsubject\n\nordinary body, no trailer\nEOF',
  'git commit -F - <<EOF\nsubject\n\nordinary body, no trailer\nEOF',
];

// gh self-credit BLOCK cases. All block via ghSelfCreditMessage(), whose message
// names the body/title self-credit. Assert that exact reason class so a
// regression blocking for some other reason can't pass.
const GH_REASON = /gh pr\/issue\/release body or title carries/;
const GH_BLOCK = [
  'gh pr create --title x --body "Done.\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
  'gh issue create --body "Co-Authored-By: Claude <noreply@anthropic.com>"',
  'gh pr edit 5 --body "see claude.com/claude-code"',
  'gh pr create --body="🤖 Generated with Claude Code"',
];

// gh self-credit ALLOW cases
const GH_ALLOW = [
  'gh pr create --title x --body "Fixes the parser bug"',
  'gh pr create --body-file /tmp/body.md',
  'gh release view',
  'gh pr list',
];

for (const { cmd, reason } of BLOCK) {
  test(`BLOCK: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      reason,
      `blocked for the WRONG reason: ${cmd}\nexpected ${reason}\ngot: ${r.stderr}`,
    );
  });
}

for (const cmd of ALLOW) {
  test(`ALLOW: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

for (const cmd of GH_BLOCK) {
  test(`BLOCK gh: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      GH_REASON,
      `blocked for the WRONG reason: ${cmd}\nexpected ${GH_REASON}\ngot: ${r.stderr}`,
    );
  });
}

for (const cmd of GH_ALLOW) {
  test(`ALLOW gh: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// `-F <real path>`: the guard reads the named file directly (no heredoc
// involved). Uses its own disposable temp file per test, separate from the
// fake HOME `run()` uses for the guard's own state.
function writeTempMessageFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-file-msg-'));
  const p = path.join(dir, 'msg.txt');
  fs.writeFileSync(p, body, 'utf8');
  return { path: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('BLOCK: git commit -F <file> with a self-credit trailer', () => {
  const f = writeTempMessageFile('subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  try {
    const r = run(`git commit -F ${f.path}`);
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FILE, `blocked for the WRONG reason\ngot: ${r.stderr}`);
  } finally {
    f.cleanup();
  }
});

test('ALLOW: git commit -F <file> with an ordinary message', () => {
  const f = writeTempMessageFile('subject\n\nordinary body, no trailer\n');
  try {
    const r = run(`git commit -F ${f.path}`);
    assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
  } finally {
    f.cleanup();
  }
});

test('ALLOW: git commit -F <nonexistent file> -> fail-open (unreadable file, no guess)', () => {
  const r = run('git commit -F /nonexistent/path/does-not-exist-git-guard-test.txt');
  assert.strictEqual(r.status, 0, `expected allow/fail-open (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK: git commit -F <relative path> resolved against a leading `cd <dir> &&`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-cd-msg-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'msg.txt'),
      'subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'utf8',
    );
    const r = run(`cd ${dir} && git commit -F msg.txt`);
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FILE, `blocked for the WRONG reason\ngot: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// JEV ADD-BLOCK (gitGuardSelfCredit) — paraphrased self-credit the regexes
// above miss. Default mode "shadow" (never in LEGACY_ON_DEFAULT, see
// hooks/lib/jev-assist.js's getMode).
//
// MOCK SERVER RUNS AS ITS OWN PROCESS (tests/helpers/jev-mock-server.js), NOT
// an in-process http server like tests/hooks/jev-assist.test.js uses. Reason
// (confirmed by reproduction while building this integration): testHook()
// spawns the hook via spawnSync, which BLOCKS this test process's event loop
// for the hook's whole lifetime. The hook's own askSync() then spawns a
// SECOND subprocess (jev-assist-worker.js) that would need to fetch an
// in-process mock server living in THIS (now-blocked) test process — a real
// deadlock; the request handler never fires and every call times out at
// exactly its budget. A mock server in its own process keeps its own event
// loop regardless of what this test process's spawnSync chain is doing.
// ---------------------------------------------------------------------------
const { spawn } = require('node:child_process');

const MOCK_SERVER = path.join(__dirname, '..', 'helpers', 'jev-mock-server.js');

// startMockJevServer(noul) -> Promise<{endpoint, stop()}>. `noul` is the raw
// noul value jev-client.js's math reads as answer=(noul>=0.5): pass a high
// value (e.g. 0.95) for a confident "true", a low value (e.g. 0.05) for a
// confident "false".
function startMockJevServer(noul) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER], {
      env: { PATH: process.env.PATH, ANTIHALL_MOCK_NOUL: String(noul) },
    });
    let buf = '';
    let settled = false;
    const onData = (c) => {
      buf += c;
      const m = buf.match(/PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({
          endpoint: `http://127.0.0.1:${m[1]}/mock`,
          stop: () => { try { child.kill(); } catch (_) { /* ignore */ } },
        });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error('mock server exited early, code ' + code)); }
    });
  });
}

async function withMockJevServer(answer, confidence, fn) {
  const noul = answer ? confidence : 1 - confidence;
  const server = await startMockJevServer(noul);
  try {
    return await fn(server.endpoint);
  } finally {
    server.stop();
  }
}

function runWithJev(command, jevCfg, endpoint) {
  const h = makeHome();
  try {
    h.writeState('jev.json', jevCfg);
    const r = testHook(HOOK, bashPayload(command), {
      home: h.home,
      env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint },
    });
    return r;
  } finally {
    h.cleanup();
  }
}

test('JEV shadow: paraphrased self-credit is logged but NEVER blocks (commit message)', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "wip: written with help from Claude, no big deal"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'shadow' } },
      endpoint,
    );
    assert.strictEqual(r.status, 0, `shadow must never block\nstderr: ${r.stderr}`);
  });
});

test('JEV on: confident paraphrased self-credit BLOCKS the commit', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "wip: written with help from Claude, no big deal"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `expected block\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /flagged by the Jev classifier/);
  });
});

test('JEV on: confident paraphrased self-credit BLOCKS a gh pr body', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'gh pr create --title x --body "this PR was put together with AI assistance"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `expected block\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /flagged by the Jev classifier/);
  });
});

test('JEV on: an ordinary message with no self-credit is NOT blocked (low-confidence/false answer)', async () => {
  await withMockJevServer(false, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "fix the parser bug"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 0, `expected allow\nstderr: ${r.stderr}`);
  });
});

test('JEV on: NEVER relaxes an existing regex block — canonical trailer still blocks even if Jev would say false', async () => {
  await withMockJevServer(false, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `regex block must never be relaxed\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.COMMIT, 'must block via the ORIGINAL regex reason, never reaching the Jev path');
  });
});

test('JEV unavailable (mode on, endpoint unreachable): fails open to baseline (allow)', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 300, integrations: { gitGuardSelfCredit: 'on' } });
    const r = testHook(HOOK, bashPayload('git commit -m "written with help from an assistant"'), {
      home: h.home,
      env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: 'http://127.0.0.1:1/unreachable' },
    });
    assert.strictEqual(r.status, 0, `jev unavailable must fail open to today's behavior\nstderr: ${r.stderr}`);
  } finally {
    h.cleanup();
  }
});

test('JEV disabled entirely (no jev.json): a paraphrase is never consulted, byte-identical to pre-Jev behavior', () => {
  const r = run('git commit -m "written with help from Claude"');
  assert.strictEqual(r.status, 0);
});
