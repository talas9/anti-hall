'use strict';
// git-guard (PreToolUse Bash). Block => exit code 2; allow => exit 0.

const { test } = require('node:test');
const assert = require('node:assert');
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
