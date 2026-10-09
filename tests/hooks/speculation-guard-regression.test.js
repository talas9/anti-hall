'use strict';
// speculation-guard REGRESSION corpus (test-only). All sentences are SYNTHETIC.
// Locks in today's protection: each line below is blocked by the guard now and must
// stay blocked. The 6 EVASION_DEV_ALLOWS lines are known dev tail bypasses (an
// exempted requirement phrase followed by a second clause); they are listed, not
// asserted -- see the CHANGELOG/finding for the separate fix decision.
const test = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

function verdict(reply) {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('ok')]);
    const r = testHook('speculation-guard.js',
      { hook_event_name: 'Stop', transcript_path: tp, session_id: 'ka', last_assistant_message: reply },
      { home: h.home });
    return r.status === 0 && r.json && r.json.decision === 'block' ? 'block' : 'allow';
  } finally {
    h.cleanup();
  }
}


const TRUE_POSITIVES = [
  'So the likely honest answer is that the two modules cannot share one interpreter.',
  'The signal is most likely a reporting gap in the uploader.',
  'Those failures were likely revealed rather than introduced by the refactor.',
  'The order is most likely never saved because the writer exits early.',
  'The stale value is likely coming from the daemon\'s own working directory.',
  'My repeated reads were resetting the board, which likely kept interrupting your attempt.',
  'The failure is probably a stale lockfile.',
  'The crash is probably not encryption related.',
  'I suspect the cache is serving old bundles.',
  'This must be the cache.',
  'That must be a race between the two writers.',
  'The deploy should be done by now.',
  'The queue should be fine.',
  'The migration should be fixed already.',
  'It seems to be a permissions problem on the shared folder.',
  'The error appears to be coming from the retry loop.',
  'I think it\'s the proxy dropping idle connections.',
  'Those two jobs are plausibly red in CI on main today.',
  'The binding should be intact after the move.',
  'The slowdown is very likely neighbor crosstalk on the shared channel.',
];

const ADVERSARIAL = require('node:fs').readFileSync(
  require('node:path').join(__dirname, 'fixtures-speculation-adversarial.txt'), 'utf8').split('\n').filter(Boolean);
const EVASION_ALL = require('node:fs').readFileSync(
  require('node:path').join(__dirname, 'fixtures-speculation-evasion.txt'), 'utf8').split('\n').filter(Boolean);
const EVASION_DEV_ALLOWS = new Set([
  'The patch must be reviewed, the decoder is dropping frames.',
  'The change should be tested; the proxy is the culprit.',
  'The job must be run: the queue is wedged.',
  'The config should be updated -- the parser is rejecting it.',
  'Requirement: the setting must be < 64 KB, so the encoder is at fault.',
  'AC: the loader must be tested; the allocator leaks.',
]);
const EVASION = EVASION_ALL.filter((l) => !EVASION_DEV_ALLOWS.has(l));

test('set sizes', () => {
  assert.ok(TRUE_POSITIVES.length >= 10 && ADVERSARIAL.length === 67 && EVASION.length === 19);
});
for (const s of TRUE_POSITIVES) test('TP block: ' + s.slice(0, 70), () => assert.strictEqual(verdict(s), 'block', 'missed: ' + s));
for (const s of ADVERSARIAL) test('ADVERSARIAL block: ' + s.slice(0, 70), () => assert.strictEqual(verdict(s), 'block', 'missed: ' + s));
for (const s of EVASION) test('EVASION block: ' + s.slice(0, 70), () => assert.strictEqual(verdict(s), 'block', 'missed: ' + s));
