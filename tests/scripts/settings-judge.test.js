'use strict';
// `settings.js judge on|off|status` + the doctor info hint (off only).
require('../helpers/isolate-home.js'); // HOME -> empty temp dir
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CLI = path.join(ROOT, 'scripts', 'settings.js');
const DOCTOR = path.join(ROOT, 'hooks', 'doctor.js');
const SECRET = 'sk-ant-TESTSECRET-0123456789';
const COST = 'about $0.0001–0.001 and 1–3 s per turn end, estimated, not measured; no precision eval yet';

function envFor(home, extra) {
  const e = Object.assign({}, process.env, { HOME: home, USERPROFILE: home }, extra || {});
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY', 'ANTIHALL_SEMANTIC_JUDGE', 'ANTIHALL_JUDGE_MODEL']) {
    if (!(extra && k in extra)) delete e[k];
  }
  return e;
}
function cli(args, home, extra) {
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { env: envFor(home, extra), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function stored(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'settings.json'), 'utf8')); } catch { return {}; }
}

test('judge on, no key: sets the flag, prints cost line and how to add a key', () => {
  const h = makeHome();
  try {
    const r = cli(['judge', 'on'], h.home);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(stored(h.home).jev.semanticJudge, true);
    assert.ok(r.out.includes(COST), r.out);
    assert.match(r.out, /no key/i);
    assert.match(r.out, /anthropic_api_key/);
    assert.match(r.out, /allowAnthropicEnvKey/);
  } finally { h.cleanup(); }
});

test('judge on, key present: reports key found, never prints it', () => {
  const h = makeHome();
  try {
    const r = cli(['judge', 'on'], h.home, { CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: SECRET });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(stored(h.home).jev.semanticJudge, true);
    assert.match(r.out, /key: found/i);
    assert.ok(r.out.includes(COST));
    assert.ok(!r.out.includes(SECRET), 'key leaked');
    assert.ok(!r.out.includes('TESTSECRET'), 'key fragment leaked');
  } finally { h.cleanup(); }
});

test('judge off: clears the flag', () => {
  const h = makeHome();
  try {
    cli(['judge', 'on'], h.home);
    const r = cli(['judge', 'off'], h.home);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(stored(h.home).jev.semanticJudge, false);
    assert.match(r.out, /off/i);
  } finally { h.cleanup(); }
});

test('judge status: off / on, key, model; key never printed', () => {
  const h = makeHome();
  try {
    let r = cli(['judge', 'status'], h.home);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /judge: off/);
    assert.match(r.out, /key: not visible/i);
    assert.match(r.out, /model: claude-haiku-4-5/);
    cli(['judge', 'on'], h.home);
    r = cli(['judge', 'status'], h.home, { CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY: SECRET });
    assert.match(r.out, /judge: on/);
    assert.match(r.out, /key: found/i);
    assert.ok(!r.out.includes('TESTSECRET'));
  } finally { h.cleanup(); }
});

test('judge with a bad verb exits non-zero with usage', () => {
  const h = makeHome();
  try {
    const r = cli(['judge', 'bogus'], h.home);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.out, /judge on\|off\|status/);
  } finally { h.cleanup(); }
});

function doctor(home) {
  const r = cp.spawnSync(process.execPath, [DOCTOR, '--check'], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-judge-cwd-')),
    env: envFor(home), encoding: 'utf8', timeout: 60000,
  });
  return (r.stdout || '') + (r.stderr || '');
}

test('doctor: info hint when the judge is off (not a warning), absent when on', () => {
  const h = makeHome();
  try {
    const off = doctor(h.home);
    const line = off.split('\n').find((l) => /judge on/.test(l));
    assert.ok(line, 'hint missing:\n' + off);
    assert.match(line, /settings\.js judge on/);
    assert.ok(!line.includes('!'), 'hint must be info, not a warning: ' + line);
    cli(['judge', 'on'], h.home);
    const on = doctor(h.home);
    assert.ok(!/settings\.js judge on/.test(on), 'hint must be absent when on');
  } finally { h.cleanup(); }
});

test('judge status/on report the ACTIVE backend: lexical, api, jev', () => {
  const h = makeHome();
  try {
    let r = cli(['judge', 'status'], h.home);
    assert.match(r.out, /backend: lexical/);
    r = cli(['judge', 'on'], h.home);
    assert.match(r.out, /backend: api/);
    // Jev enabled + speculation integration on: speculation-guard's Jev call is
    // the semantic judge; the paid API judge exits early (speculation-judge.js).
    cli(['set', 'jev.enabled', 'true'], h.home);
    r = cli(['judge', 'status'], h.home);
    assert.match(r.out, /backend: jev/);
    assert.match(r.out, /API judge skipped/);
    cli(['set', 'jevIntegrations.speculation', 'shadow'], h.home);
    r = cli(['judge', 'status'], h.home);
    assert.match(r.out, /backend: api/);
  } finally { h.cleanup(); }
});

test('doctor hint names the active backend and stays info-only when Jev handles speculation', () => {
  const h = makeHome();
  try {
    cli(['set', 'jev.enabled', 'true'], h.home);
    const out = doctor(h.home);
    assert.match(out, /semantic judge: Jev \(speculation-guard\)/);
    assert.ok(!/settings\.js judge on/.test(out));
  } finally { h.cleanup(); }
});
