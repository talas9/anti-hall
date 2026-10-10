'use strict';
require('../helpers/isolate-home.js');
// Row 6 (AGENT-ROUTING -> Explore). Two groups:
//  FIX tests: fail on the pre-fix hook (prove the change). Names start "FIX:".
//  GUARD tests: pass before and after (regression guards). Names start "GUARD:".

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function advisory(description, prompt, model = 'sonnet') {
  const h = makeHome();
  try {
    const r = testHook('model-routing-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 't', cwd: process.cwd(),
      tool_input: { subagent_type: 'general-purpose', model, description, prompt },
    }, { home: h.home });
    if (model === null) return 'status:' + r.status;
    assert.strictEqual(r.status, 0, r.stdout);
    return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  } finally { h.cleanup(); }
}

// FIX: clear write instructions -> no Explore advisory.
const WRITE_FIX = [
  'Find the root cause of the flaky test. Save the full findings to /private/tmp/x/scratchpad/findings.md and report a summary.',
  'Search the repo for stale docs. Clone the repo into scratchpad/work, run the generator, and report which files changed.',
  'Gather the schema keys, then create new files for each group under docs/ and report the paths.',
  'Search for config drift, then save the findings into /private/tmp/out.md',
];
for (const p of WRITE_FIX) {
  test('FIX: write-shaped prompt -> no Explore advisory: ' + p.slice(0, 45), () => {
    assert.strictEqual(advisory('research task', p), '');
  });
}

// GUARD: git format-patch is also caught by the older `patch` stem, so this passes pre-fix.
test('GUARD: format-patch prompt -> no Explore advisory', () => {
  assert.strictEqual(advisory('research task', 'Locate the regression, then run git format-patch for it into the patches dir.'), '');
});

// FIX: read-only prompts whose ambiguous words (build/release/tag/patch/edit) are nouns or negated.
const READ_ONLY_FIX = [
  'research how the build works and report',
  'find where the release tag is created, report only',
  'investigate how fixes are applied; do not edit anything',
  'locate the patch notes and summarize',
];
for (const p of READ_ONLY_FIX) {
  test('FIX: read-only prompt keeps Explore advisory: ' + p, () => {
    assert.match(advisory('research task', p), /read-only-shaped/);
  });
}

// GUARD: read-only prompts that merely mention save/clone/generator/writing.
const READ_ONLY_GUARD = [
  'investigate the codebase structure|research and find all usages of the deprecated API, then gather results',
  'survey the hooks|Locate and map every hook that reads settings.json and report the keys each one reads. Report only.',
  'research task|find where save is handled',
  'research task|investigate how files get saved and the clone logic',
  'research task|find all places that run the generator',
  'research task|describe how the writing of settings happens',
];
for (const row of READ_ONLY_GUARD) {
  const [d, p] = row.split('|');
  test('GUARD: read-only prompt keeps Explore advisory: ' + p.slice(0, 50), () => {
    assert.match(advisory(d, p), /read-only-shaped/);
  });
}

// GUARD: imperative ambiguous stems still suppress.
for (const p of ['find the bug, then fix it', 'Fix the failing hook and report', 'investigate the module and install the deps']) {
  test('GUARD: imperative write stem suppresses: ' + p, () => {
    assert.strictEqual(advisory('research task', p), '');
  });
}

// FIX: the build prompt through the real hook (spawned process) with explicit haiku too.
test('FIX: "research how the build works and report" + model haiku -> Explore advisory', () => {
  assert.match(advisory('research how the build works and report', 'research how the build works and report', 'haiku'), /read-only-shaped/);
});
// GUARD: with the model OMITTED, Row 2 (strict, no exemptions by design) blocks `build`
// as a mechanical word before Row 6 can advise; that is a block, not an advisory.
test('GUARD: same prompt with model omitted -> Row 2 strict block (exit 2), by design', () => {
  assert.strictEqual(advisory('research task', 'research how the build works and report', null), 'status:2');
});

// FIX (dogfood 2026-10-09): a brief that tells the agent to commit is a writing brief even when it quotes "read-only-shaped".
test('FIX: a fix brief that commits and quotes the read-only advisory gets no Explore advisory', () => {
  const brief = 'Fix the misfires. Investigate each, find the root cause (the model-routing check says "read-only-shaped"), then fix it and commit per check.';
  assert.strictEqual(advisory('fix hook misfires', brief), '');
  assert.strictEqual(advisory('fix hook misfires', 'Investigate the checks, set up with git worktree add ../wt lane, then report.'), '');
});
// GUARD: a negated commit stays read-only.
test('GUARD: "do not commit or push anything" research brief keeps the Explore advisory', () => {
  assert.match(advisory('research task', 'Investigate how the hooks read settings and report only. Do not commit or push anything.'), /read-only-shaped/);
  assert.match(advisory('research task', 'Find where the release tag is created. Report only; do not run git commit or git push.'), /read-only-shaped/);
});

// FIX (issue #55a): a brief that creates labels/issues, commits files and pushes is a writing brief even when it quotes "read-only".
test('FIX: a triage brief that creates labels and issues, commits and pushes gets no Explore advisory', () => {
  const brief = 'Research the open issues (read-only scan of the tracker), then create the missing labels with gh label create, file each finding with gh issue create, commit the policy files and push.';
  assert.strictEqual(advisory('triage the tracker', brief), '');
  assert.strictEqual(advisory('triage the tracker', 'Investigate the tracker (read-only listing). Label each issue by area; commits files and pushes.'), '');
});
// GUARD: negated write verbs keep a research brief read-only.
test('GUARD: "do not create issues, never push" research brief keeps the Explore advisory', () => {
  assert.match(advisory('research task', 'Investigate the tracker and report only. Do not create issues or labels; never push.'), /read-only-shaped/);
});

// (issue #55b) the deploy floor and an omitted model: the inherited session model decides.
const fs = require('node:fs');
const path = require('node:path');
function deploySpawn(sessionModel) {
  const h = makeHome();
  try {
    const tp = path.join(h.home, 't.jsonl');
    const lines = sessionModel === null ? [] : [{ type: 'assistant', message: { role: 'assistant', model: sessionModel, content: [{ type: 'text', text: 'ok' }] } }];
    fs.writeFileSync(tp, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = testHook('model-routing-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 't', cwd: process.cwd(), transcript_path: tp,
      tool_input: { subagent_type: 'general-purpose', description: 'enable the docs site', prompt: 'Enable GitHub Pages for the docs site and set the deploy secret in production; report the URL.' },
    }, { home: h.home });
    assert.strictEqual(r.status, 0, r.stdout);
    return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  } finally { h.cleanup(); }
}
test('FIX: deploy-shaped spawn with the model omitted in an opus or fable session -> no deploy-floor advisory', () => {
  assert.strictEqual(deploySpawn('claude-opus-5-5'), '');
  assert.strictEqual(deploySpawn('claude-fable-1'), '');
});
test('GUARD: deploy-shaped spawn with the model omitted in a haiku session (or an unknown one) -> deploy-floor advisory', () => {
  assert.match(deploySpawn('claude-haiku-4-5'), /sets no explicit model/);
  assert.match(deploySpawn(null), /sets no explicit model/);
});
