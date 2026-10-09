'use strict';
require('../helpers/isolate-home.js');
// guards.sharedTreeAgentNote must fire only when the spawns would actually share the
// session's git tree. A spawn (or the running agent) that states it works in a
// scratch/tmp dir or a separate clone shares nothing -> silent. Unsure -> still warns.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function launch(tuid, agentId, input) {
  const text = 'Async agent launched successfully. (This tool result is internal metadata.)\n'
    + 'agentId: ' + agentId + " (internal ID - do not mention to user. Use SendMessage with to: '" + agentId + "')\n"
    + 'The agent is working in the background. You will be notified automatically when it completes.\n'
    + 'output_file: /tmp/none/' + agentId + '.output\n';
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Agent', input }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: [{ type: 'text', text }] }] } },
  ];
}
function run(entries, input) {
  const h = makeHome();
  try {
    const tp = path.join(h.home, 't.jsonl');
    fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = testHook('swarm-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, session_id: 't', transcript_path: tp, cwd: h.home,
    }, { home: h.home });
    assert.strictEqual(r.status, 0);
    return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  } finally { h.cleanup(); }
}
const A1 = 'a1a1a1a1a1a1a1a1a';
const REPO = { description: 'writer', prompt: 'Fix the bug in hooks/foo.js and commit.', subagent_type: 'general-purpose' };
const SCRATCH = { description: 'scratch writer', subagent_type: 'general-purpose',
  prompt: 'Work in a scratch clone: git clone -q -b dev /repo /private/tmp/claude-501/x/scratchpad/sweep && cd /private/tmp/claude-501/x/scratchpad/sweep and edit there.' };

// FIX tests fail on the pre-fix note (which always warns); GUARD tests pass before and after.
test('GUARD: both spawns in the session repo -> still warns', () => {
  assert.match(run(launch('t1', A1, REPO), REPO), /shared-tree:/);
});
const SCRATCH_FIX = [
  SCRATCH,
  { ...REPO, prompt: 'Work in /private/tmp/claude-501/x/scratchpad/clone and make the fix there.' },
  { ...REPO, prompt: 'cwd: /private/tmp/work/clone. Fix hooks/foo.js there and commit.' },
  { ...REPO, prompt: 'cd into /tmp/scratch-clone and apply the change there.' },
  { ...REPO, prompt: 'Experiments only in a fresh scratch clone under /private/tmp/x/scratchpad/rv; edit there.' },
  { ...REPO, prompt: 'Your cwd is /private/tmp/x/scratchpad/rv-adv (a fresh scratch clone)' },
  { ...REPO, prompt: 'Clone into scratchpad/work and edit there' },
];
SCRATCH_FIX.forEach((spawn, n) => {
  test('FIX: new spawn that establishes a scratch work location -> silent #' + n, () => {
    assert.strictEqual(run(launch('t1', A1, REPO), spawn), '');
  });
});
test('FIX: running agent works in a scratch clone -> silent', () => {
  assert.strictEqual(run(launch('t1', A1, SCRATCH), REPO), '');
});

const WARN = [
  'Fix it. Use a tmp path /private/tmp/notes.md for output and edit hooks/foo.js.',
  'Edit hooks/foo.js in the repo in place. Write your report to cwd: /private/tmp/out/report.md',
  'Edit repo files directly. Work from /tmp/notes.md as the spec.',
  'Fix hooks/foo.js; cd /tmp/x && git diff, then cd back and edit in repo.',
  'Edit the files in the repo (not a scratch clone).',
  'Fix it. Clone the repo at the end to verify: git clone /repo /tmp/v',
  'Edit hooks/foo.js and commit. Use a scratch directory for notes.',
  'Implement the fix on main; verify in a scratch clone afterwards.',
  'Fix hooks/foo.js directly in the working copy. Do your scratch clone for verification only.',
  'Modify the checked-out files. Working in /private/tmp/notes you write the report.',
  'Edit hooks/foo.js and commit. Keep a scratch copy of the logs.',
];
for (const prompt of WARN) {
  test('GUARD: in-tree writer still warns: ' + prompt.slice(0, 55), () => {
    assert.match(run(launch('t1', A1, REPO), { ...REPO, prompt }), /shared-tree:/);
  });
}

// FIX (dogfood 2026-10-09): a brief that makes its own git worktree elsewhere shares no tree with the session.
const WORKTREE_FIX = [
  'Worktree: git -C ~/.anti-hall/work/repo fetch origin && git -C ~/.anti-hall/work/repo worktree add ~/.anti-hall/work/wt-x origin/main -b lane-x. Fix the bug there and commit.',
  'Fix hooks/foo.js: git worktree add /Users/x/.anti-hall/work/wt-y origin/dev -b lane-y, then edit and commit in it.',
  'Each lane uses its own worktree under ~/.anti-hall/work; fix hooks/foo.js and commit.',
];
WORKTREE_FIX.forEach((prompt, n) => {
  test('FIX: new spawn with its own git worktree -> silent #' + n, () => {
    assert.strictEqual(run(launch('t1', A1, REPO), { ...REPO, prompt }), '');
  });
});
test('GUARD: a relative worktree add inside the session repo still warns', () => {
  assert.match(run(launch('t1', A1, REPO), { ...REPO, prompt: 'Run git worktree add wt-here then fix hooks/foo.js in the repo in place.' }), /shared-tree:/);
});
