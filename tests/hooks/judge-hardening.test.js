'use strict';
// Judge hardening: secret scrub coverage (and scrub-before-slice), a private
// empty cwd for the judge child, and the ANTIHALL_JUDGE_CHILD early exit in every
// Stop / SessionStart / UserPromptSubmit hook. Fake token values only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOKS = path.resolve(__dirname, '../../plugins/anti-hall/hooks');
const { scrubSecrets } = require(HOOKS + '/lib/secret-scrub.js');
const jc = require(HOOKS + '/lib/judge-core.js');

const SHAPES = [
  ['stripe live', 'sk_' + 'live_FAKEFAKEFAKE1234', 'FAKEFAKEFAKE1234'],
  ['stripe test', 'sk_' + 'test_FAKEFAKEFAKE1234', 'FAKEFAKEFAKE1234'],
  ['stripe restricted', 'rk_' + 'live_FAKEFAKEFAKE1234', 'FAKEFAKEFAKE1234'],
  ['gitlab pat', 'glpat-' + 'FAKEFAKEFAKE-1234', 'FAKEFAKEFAKE'],
  ['npm token', 'npm_' + 'FAKEFAKEFAKEFAKEFAKEFAKE12', 'FAKEFAKEFAKEFAKE'],
  ['basic auth', 'Authorization: Basic ' + 'ZmFrZXVzZXI6ZmFrZXBhc3M=', 'ZmFrZXVzZXI6'],
  ['bearer auth w/ slash', 'Authorization: Bearer ' + 'fake/Bearer+Value123==', 'Value123'],
  ['quoted multi-word', 'SECRET_KEY = "alpha beta gamma"', 'beta'],
  ['quoted single-quote', "api_key: 'one two three'", 'two'],
];

for (const [name, text, leak] of SHAPES) {
  test('scrub: ' + name, () => {
    const out = scrubSecrets('before ' + text + ' after');
    assert.ok(!out.includes(leak), out);
    assert.ok(out.includes('[REDACTED'), out);
    assert.ok(out.startsWith('before ') && out.endsWith(' after'), out);
  });
}

test('scrub: ordinary prose and npm env names untouched', () => {
  const t = 'basic understanding of npm_config_registry and sk_ prefixes in the key store';
  assert.strictEqual(scrubSecrets(t), t);
});

test('buildJudgeInput scrubs each evidence chunk BEFORE the 1500-char slice', () => {
  // A token straddling the 1500 boundary: slicing first would leave a fragment
  // below every pattern threshold.
  const tok = 'sk_' + 'live_' + 'A1b2C3d4E5f6G7h8';
  const chunk = 'x'.repeat(1490) + ' ' + tok;
  const out = jc.buildJudgeInput('msg', [chunk], 'req');
  assert.ok(!out.includes('A1b2C3'), 'token fragment leaked across the slice');
  assert.ok(!out.includes('live_'), 'token prefix fragment leaked');
});

test('runCliJudge: child cwd is a private empty dir, removed after exit', { skip: process.platform === 'win32' }, async () => {
  const h = makeHome();
  try {
    const bin = path.join(h.home, 'claude');
    fs.writeFileSync(bin, '#!/usr/bin/env node\n' +
      "const fs = require('fs');\n" +
      "fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync('.') }));\n" +
      "process.stdout.write(JSON.stringify({ is_error: false, result: '{\"decision\":\"allow\"}' }));\n");
    fs.chmodSync(bin, 0o755);
    const log = path.join(h.home, 'cwd.json');
    const d = await jc.runCliJudge({ input: 'x', bin, env: Object.assign({}, process.env, { FAKE_LOG: log, HOME: h.home, USERPROFILE: h.home }) });
    assert.deepStrictEqual(d, { decision: 'allow' });
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(path.basename(seen.cwd).startsWith('antihall-judge-'), seen.cwd);
    assert.deepStrictEqual(seen.entries, []);
    assert.ok(!fs.existsSync(seen.cwd), 'private cwd must be removed after the child exits');
  } finally { h.cleanup(); }
});

// ---- ANTIHALL_JUDGE_CHILD early exit in every Stop/SessionStart/UserPromptSubmit hook
const hooksJson = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8')).hooks;
const GUARDED = new Set();
for (const ev of ['Stop', 'SessionStart', 'UserPromptSubmit']) {
  for (const g of hooksJson[ev] || []) {
    for (const x of g.hooks) GUARDED.add(x.command.match(/hooks\/([\w.-]+\.js)/)[1]);
  }
}

test('hooks.json lists the Stop/SessionStart/UserPromptSubmit hooks (sanity)', () => {
  assert.ok(GUARDED.size >= 30, String(GUARDED.size));
});

for (const f of GUARDED) {
  test('judge child: ' + f + ' exits 0 silently when ANTIHALL_JUDGE_CHILD=1', () => {
    const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
    assert.match(src, /require\('\.\/lib\/judge-child-exit'\)/, 'missing early-exit require');
    const h = makeHome();
    try {
      const payload = JSON.stringify({ hook_event_name: 'X', session_id: 'jch', prompt: 'hello', cwd: h.home, last_assistant_message: 'The bug is caused by the cache.' });
      const r = testHookRaw(f, payload, { home: h.home, env: { ANTIHALL_JUDGE_CHILD: '1' } });
      assert.strictEqual(r.status, 0, f);
      assert.strictEqual((r.stdout || '').trim(), '', f + ' printed: ' + r.stdout);
    } finally { h.cleanup(); }
  });
}
