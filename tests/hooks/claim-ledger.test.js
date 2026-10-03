'use strict';
// claim-ledger (Stop hook, LEDGER-ONLY). Never blocks, never prints, exit 0
// always. Records would-be flags to ~/.anti-hall/claim-ledger/<session>.jsonl.
//
// Session id 't' -> ~/.anti-hall/claim-ledger/t.jsonl (+ t.last hash marker).
// The hook reads the LAST assistant text as the message under test and
// everything before it in the transcript as cumulative evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'claim-ledger.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

function userPrompt(text) {
  return { type: 'user', message: { role: 'user', content: text } };
}

function toolUse(name, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  };
}

function toolResult(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  };
}

function readLedger(h) {
  const p = path.join(h.antiHall, 'claim-ledger', 't.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function silentAllow(r) {
  return r.status === 0 && r.stdout.trim() === '';
}

test('HARD: "task N of" absent from evidence is recorded, never blocks', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('status?'),
      toolUse('Bash', { command: 'git status' }),
      toolResult('On branch main\nnothing to commit'),
      assistantMessage('You are on task 3 of your queue.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r), `expected silent exit 0; stdout: ${r.stdout}`);
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].tools_this_turn, 1);
    assert.deepStrictEqual(
      recs[0].flags.map((f) => [f.cls, f.kind, f.token]),
      [['hard', 'task', 'task 3 of']]
    );
  } finally {
    h.cleanup();
  }
});

test('HARD: a count NOT in evidence is recorded; a rounded count IS in evidence (value match)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('time it'),
      toolUse('Bash', { command: 'time claude -p' }),
      toolResult('14.40s user 22.57s system 128% cpu 28.706 total\n10.32s user 41.33s system 148% cpu 34.887 total'),
      assistantMessage('Measured 28.7 s and 34.9 s; I would estimate ~37 s per turn.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(
      recs[0].flags.map((f) => [f.cls, f.kind, f.token]),
      [['hard', 'count', '37 s']]
    );
  } finally {
    h.cleanup();
  }
});

test('HARD: thousands separators are normalized on both sides', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('count'),
      toolUse('Bash', { command: 'wc -l' }),
      toolResult('1326 messages'),
      assistantMessage('That is 1,326 messages and 12 files.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['12 files']);
  } finally {
    h.cleanup();
  }
});

test('HARD: SHA absent from evidence is recorded; SHA present is not', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('which commit'),
      toolUse('Bash', { command: 'git log -1' }),
      toolResult('d941e62 release: v0.99.2'),
      assistantMessage('Released as d941e62; the fix landed in 7f253cd earlier.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.kind, f.token]), [['sha', '7f253cd']]);
  } finally {
    h.cleanup();
  }
});

test('SOFT: state word with ZERO tool calls this turn is recorded as soft; with a tool call it is not', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('is it done?'),
      assistantMessage('The V2-4 workspace spawn is still running.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].tools_this_turn, 0);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.cls, f.kind]), [['soft', 'state-no-tool']]);
  } finally {
    h.cleanup();
  }

  const h2 = makeHome();
  try {
    const tp = h2.writeTranscript([
      userPrompt('is it done?'),
      toolUse('Bash', { command: 'devswarm roster' }),
      toolResult('V2-4 live'),
      assistantMessage('The V2-4 workspace spawn is still running.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h2.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h2), []);
  } finally {
    h2.cleanup();
  }
});

test('SOFT: "N days ago" is always recorded as soft (date arithmetic is unverifiable)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('how old'),
      toolUse('Bash', { command: 'cat ts' }),
      toolResult('ts: 2026-08-04T00:00:00Z'),
      assistantMessage('Those rows are from eight days ago; the newest is 8 days ago.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.cls, f.kind, f.token]), [['soft', 'days-ago', '8 days ago']]);
  } finally {
    h.cleanup();
  }
});

test('EVIDENCE is cumulative across turns, includes tool inputs, hook attachments and prompts', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('run it'),
      toolUse('Bash', { command: 'sleep 5 seconds' }),
      toolResult('done'),
      assistantMessage('Ran it.'),
      { type: 'attachment', attachment: { type: 'hook_success', stdout: 'roster: 29 workspaces' } },
      userPrompt('we have 7 hooks, right?'),
      assistantMessage('Yes: 7 hooks, 29 workspaces, and the run took 5 seconds.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), []);
    // The .last marker still records the examined message hash.
    assert.ok(fs.existsSync(path.join(h.antiHall, 'claim-ledger', 't.last')));
  } finally {
    h.cleanup();
  }
});

test('The message under test does not vouch for itself; an EARLIER assistant message does', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('a'),
      assistantMessage('There are 4 files.'),
      userPrompt('b'),
      toolUse('Bash', { command: 'ls' }),
      toolResult('x'),
      assistantMessage('Still 4 files, and now 9 rows.'),
    ]);
    testHook(HOOK, stopPayload(tp), { home: h.home });
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['9 rows']);
  } finally {
    h.cleanup();
  }
});

test('DEDUP: the same message is recorded once across repeated Stop events; a new message is recorded again', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('a'),
      toolUse('Bash', { command: 'x' }),
      toolResult('y'),
      assistantMessage('task 3 of 9 is next.'),
    ]);
    testHook(HOOK, stopPayload(tp), { home: h.home });
    testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(readLedger(h).length, 1);
    fs.appendFileSync(tp, JSON.stringify(assistantMessage('Actually task 4 of 9 is next.')) + '\n');
    testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(readLedger(h).length, 2);
  } finally {
    h.cleanup();
  }
});

test('SKIP: ~/.anti-hall/skip.json {"claim-ledger": future} suppresses recording', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'claim-ledger': Date.now() + 60_000 });
    const tp = h.writeTranscript([userPrompt('a'), assistantMessage('task 3 of 9, still running.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.ok(!fs.existsSync(path.join(h.antiHall, 'claim-ledger')));
  } finally {
    h.cleanup();
  }
});

test('WINDOW: a transcript larger than the 2 MB tail cap is read from the tail only, still exit 0', () => {
  const h = makeHome();
  try {
    const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(4096) } };
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push(filler); // ~2.5 MB
    lines.push(userPrompt('late'), assistantMessage('task 3 of 9.'));
    const tp = h.writeTranscript(lines);
    assert.ok(fs.statSync(tp).size > 2 * 1024 * 1024);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].window_truncated, true);
    assert.deepStrictEqual(recs[0].flags.map((f) => f.token), ['task 3 of']);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin, malformed JSON, missing transcript, no transcript_path, malformed lines', () => {
  const h = makeHome();
  try {
    for (const raw of ['', '{bad', 'null', '[]']) {
      const r = testHookRaw(HOOK, raw, { home: h.home });
      assert.ok(silentAllow(r), `raw=${JSON.stringify(raw)} stdout=${r.stdout} stderr=${r.stderr}`);
    }
    let r = testHook(HOOK, { hook_event_name: 'Stop', session_id: 't' }, { home: h.home });
    assert.ok(silentAllow(r));
    r = testHook(HOOK, stopPayload(path.join(h.home, 'missing.jsonl')), { home: h.home });
    assert.ok(silentAllow(r));
    const tp = path.join(h.home, 'garbage.jsonl');
    fs.writeFileSync(tp, '{not json\n\n' + JSON.stringify({ type: 'assistant', message: { content: 'x' } }) + '\n{"type":"user"}\n', 'utf8');
    r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), []);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: unwritable ledger dir still exits 0 silently', () => {
  const h = makeHome();
  try {
    // Occupy the ledger path with a FILE so mkdirSync(recursive) fails.
    fs.writeFileSync(path.join(h.antiHall, 'claim-ledger'), 'not a dir', 'utf8');
    const tp = h.writeTranscript([userPrompt('a'), assistantMessage('task 3 of 9.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(silentAllow(r), `stdout=${r.stdout} stderr=${r.stderr}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// last_assistant_message: at Stop time the transcript may not yet hold the
// reply being stopped. The payload text is then the reply; the transcript's own
// last assistant text becomes evidence; tools_this_turn is the running count.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const CLAIM = 'There are 7 files changed in the repo.';
// Pinned: sha1 of CLAIM, i.e. the hash the unfixed hook records for this text.
const CLAIM_HASH = '4cae11f408ef52e9e4931618e238429af46059ac';

function withLam(tp, lam) {
  return Object.assign(stopPayload(tp), { last_assistant_message: lam });
}

test('LAM: stale transcript + payload claim -> flag under the payload hash with this turn tool count', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('go'),
      toolUse('Bash', { command: 'ls' }),
      toolResult('a b'),
      assistantMessage('Looking at it.'),
      toolUse('Bash', { command: 'git status' }),
      toolResult('clean'),
    ]);
    const r = testHook(HOOK, withLam(tp, CLAIM), { home: h.home });
    assert.ok(silentAllow(r), `expected silent exit 0; stdout: ${r.stdout}`);
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].hash, CLAIM_HASH);
    assert.strictEqual(recs[0].tools_this_turn, 2);
    assert.strictEqual(recs[0].msg_chars, CLAIM.length);
    assert.deepStrictEqual(recs[0].flags.map((f) => [f.cls, f.kind, f.token]), [['hard', 'count', '7 files']]);
  } finally {
    h.cleanup();
  }
});

test('LAM: stale transcript - the previous message is EVIDENCE for the payload reply', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('go'),
      assistantMessage('The count is 7 files so far.'),
    ]);
    const r = testHook(HOOK, withLam(tp, CLAIM), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), [], 'a number the previous message stated is a legitimate referent');
  } finally {
    h.cleanup();
  }
});

test('LAM: a claim in the PREVIOUS message is not treated as the reply at this Stop', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('go'),
      assistantMessage(CLAIM),
    ]);
    const r = testHook(HOOK, withLam(tp, 'Done.'), { home: h.home });
    assert.ok(silentAllow(r));
    assert.deepStrictEqual(readLedger(h), [], 'the older flaggable message must not be recorded');
  } finally {
    h.cleanup();
  }
});

test('LAM: up-to-date transcript + same text (whitespace differs) in payload -> one record, hash unchanged from the unfixed hook', () => {
  const h = makeHome();
  try {
    const items = [
      userPrompt('status?'),
      toolUse('Bash', { command: 'git status' }),
      toolResult('clean'),
      assistantMessage(CLAIM),
    ];
    const tp = h.writeTranscript(items);
    const r = testHook(HOOK, withLam(tp, CLAIM.replace('7 files', '7\n files') + '\n'), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].hash, CLAIM_HASH);
    assert.strictEqual(recs[0].hash, sha1(CLAIM));
    assert.strictEqual(recs[0].tools_this_turn, 1);
    assert.strictEqual(recs[0].msg_chars, CLAIM.length);
  } finally {
    h.cleanup();
  }
});

test('LAM: payload absent / blank -> today\'s transcript-only record, same hash', () => {
  for (const lam of [undefined, '', '   \n']) {
    const h = makeHome();
    try {
      const tp = h.writeTranscript([
        userPrompt('status?'),
        toolUse('Bash', { command: 'git status' }),
        toolResult('clean'),
        assistantMessage(CLAIM),
      ]);
      const payload = lam === undefined ? stopPayload(tp) : withLam(tp, lam);
      const r = testHook(HOOK, payload, { home: h.home });
      assert.ok(silentAllow(r));
      const recs = readLedger(h);
      assert.strictEqual(recs.length, 1);
      assert.strictEqual(recs[0].hash, CLAIM_HASH);
      assert.strictEqual(recs[0].tools_this_turn, 1);
    } finally {
      h.cleanup();
    }
  }
});

test('LAM: repeated Stop with the same payload is recorded once', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([userPrompt('go'), assistantMessage('Looking.')]);
    testHook(HOOK, withLam(tp, CLAIM), { home: h.home });
    testHook(HOOK, withLam(tp, CLAIM), { home: h.home });
    assert.strictEqual(readLedger(h).length, 1);
  } finally {
    h.cleanup();
  }
});

// One assistant message can span several transcript lines (same message.id):
// text, tool_use, text. The payload joins its text blocks with "\n". Text that
// is part of the reply being judged must never be evidence for that reply.
function asstLine(id, content) {
  const m = { role: 'assistant', content };
  if (id) m.id = id;
  return { type: 'assistant', message: m };
}
const PART1 = 'Part one: Fixed in commit abcdef1 and 47 tests pass.';
const PART2 = 'Part two done.';

function flagKinds(rec) { return rec.flags.map((f) => f.kind + ':' + f.token).sort(); }

for (const withIds of [true, false]) {
  test(`LAM: multi-text-block reply is not vouched for by itself (${withIds ? 'message.id' : 'no ids, containment safety net'})`, () => {
    const h = makeHome();
    try {
      const id = withIds ? 'msg_1' : null;
      const tp = h.writeTranscript([
        userPrompt('go'),
        asstLine(id, [{ type: 'text', text: PART1 }]),
        asstLine(id, [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'true' } }]),
        asstLine(id, [{ type: 'text', text: PART2 }]),
      ]);
      const r = testHook(HOOK, withLam(tp, PART1 + '\n' + PART2), { home: h.home });
      assert.ok(silentAllow(r));
      const recs = readLedger(h);
      assert.strictEqual(recs.length, 1, 'the count and sha must be recorded');
      assert.deepStrictEqual(flagKinds(recs[0]), ['count:47 tests', 'sha:abcdef1']);
    } finally {
      h.cleanup();
    }
  });
}

test('LAM: payload that merely contains the transcript last text (suffix) -> transcript up to date, payload judged, own text not evidence', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('go'),
      toolUse('Bash', { command: 'true' }),
      toolResult('ok'),
      assistantMessage(PART2),
    ]);
    const full = 'Intro: 47 tests pass. ' + PART2;
    const r = testHook(HOOK, withLam(tp, full), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].hash, sha1(full));
    assert.strictEqual(recs[0].tools_this_turn, 1, 'transcript is up to date: count as of its last text');
    assert.deepStrictEqual(flagKinds(recs[0]), ['count:47 tests']);
  } finally {
    h.cleanup();
  }
});

test('LAM: NFC vs NFD spelling of the same reply is treated as equal (hash stays the transcript raw text)', () => {
  const h = makeHome();
  try {
    const nfc = 'Café has 7 files changed.';
    const nfd = nfc.normalize('NFD');
    assert.notStrictEqual(nfc, nfd);
    const tp = h.writeTranscript([
      userPrompt('go'),
      toolUse('Bash', { command: 'true' }),
      toolResult('ok'),
      assistantMessage(nfc),
    ]);
    const r = testHook(HOOK, withLam(tp, nfd), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].hash, sha1(nfc));
    assert.strictEqual(recs[0].tools_this_turn, 1);
  } finally {
    h.cleanup();
  }
});

test('LAM: payload present but NO assistant text in the transcript window -> recorded against the payload, silent', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      userPrompt('go'),
      toolUse('Bash', { command: 'true' }),
      toolResult('ok'),
    ]);
    const r = testHook(HOOK, withLam(tp, CLAIM), { home: h.home });
    assert.ok(silentAllow(r));
    const recs = readLedger(h);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].hash, CLAIM_HASH);
    assert.strictEqual(recs[0].tools_this_turn, 1);
  } finally {
    h.cleanup();
  }
});

test('LAM: Jev turnRef is omitted when the reply came from the payload (transcript may be a turn behind)', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { HOOKS_DIR } = require('../helpers/spawn-hook.js');
  const h = makeHome();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.9 } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    h.writeState('jev.json', { enabled: true, integrations: { claimLedger: 'shadow' } });
    const stamp = (m) => Object.assign({ timestamp: '2026-09-25T10:00:00.000Z' }, m);
    const run = (tp, payload) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HOOKS_DIR, HOOK)], {
        env: {
          PATH: process.env.PATH, HOME: h.home, USERPROFILE: h.home, ANTIHALL_TEST_ISOLATION: '1',
          CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/mock`,
        },
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(payload));
    });
    const logFile = path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson');
    const rows = async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const got = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            .filter((r) => r.id === 'claimLedger' && r.type !== 'outcome');
          if (got.length) return got;
        } catch (_) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      return [];
    };

    // Payload differs from the transcript's last text -> no turnRef.
    const tp1 = h.writeTranscript([stamp(userPrompt('go')), stamp(assistantMessage('Looking.'))]);
    await run(tp1, withLam(tp1, CLAIM));
    const fromPayload = await rows();
    assert.ok(fromPayload.length >= 1, 'expected a claimLedger decision row');
    assert.strictEqual(fromPayload[0].turnRef, undefined, 'payload-sourced reply must not carry a transcript turnRef');
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    h.cleanup();
  }
});

test('LAM: Jev turnRef is kept when the transcript is up to date (payload equals its last text)', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { HOOKS_DIR } = require('../helpers/spawn-hook.js');
  const h = makeHome();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.9 } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    h.writeState('jev.json', { enabled: true, integrations: { claimLedger: 'shadow' } });
    const tp = h.writeTranscript([
      { timestamp: '2026-09-25T10:00:00.000Z', type: 'user', message: { role: 'user', content: 'go' } },
      { timestamp: '2026-09-25T10:00:05.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: CLAIM }] } },
    ]);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HOOKS_DIR, HOOK)], {
        env: {
          PATH: process.env.PATH, HOME: h.home, USERPROFILE: h.home, ANTIHALL_TEST_ISOLATION: '1',
          CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}/mock`,
        },
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(withLam(tp, CLAIM)));
    });
    const logFile = path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson');
    let row = null;
    for (let i = 0; i < 100 && !row; i++) {
      try {
        row = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
          .find((r) => r.id === 'claimLedger' && r.type !== 'outcome') || null;
      } catch (_) { /* not yet */ }
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(row, 'expected a claimLedger decision row');
    assert.strictEqual(row.turnRef, '2026-09-25T10:00:05.000Z');
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    h.cleanup();
  }
});

test('unit: numberInEvidence matches by value at the claim precision', () => {
  const { numberInEvidence, collectNumbers } = require('../../plugins/anti-hall/hooks/claim-ledger.js');
  const ev = 'cpu 34.887 total; 28.706 total; 1326 messages; 0.3421s';
  const nums = collectNumbers(ev);
  assert.strictEqual(numberInEvidence('34.9', ev, nums), true);
  assert.strictEqual(numberInEvidence('35', ev, nums), true); // 34.887 rounds to 35 at 0 decimals
  assert.strictEqual(numberInEvidence('34', ev, nums), false);
  assert.strictEqual(numberInEvidence('28.71', ev, nums), true);
  assert.strictEqual(numberInEvidence('28.72', ev, nums), false);
  assert.strictEqual(numberInEvidence('1,326', ev, nums), true);
  assert.strictEqual(numberInEvidence('0.3', ev, nums), true);
  assert.strictEqual(numberInEvidence('37', ev, nums), false);
});
