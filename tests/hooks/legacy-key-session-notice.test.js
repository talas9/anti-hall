'use strict';
// One-time SessionStart notice (carried by jev-review-reminder.js) that a legacy
// key exists but is unused; plus the one-line "no key visible" reasons from
// non-hook processes. Isolated tmp HOME; presence-only, never the value.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'jev-review-reminder.js');
const FINDING_DEDUP = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'finding-dedup.js');
const SECRET = 'sk-' + 'ant-session-notice-secret';

function runNode(script, home, { env, input } = {}) {
  const e = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, env);
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete e[k];
  Object.assign(e, env);
  return spawnSync(process.execPath, [script], { env: e, input: input || '{}', encoding: 'utf8', timeout: 30000 });
}
function additionalContext(r) {
  const line = (r.stdout || '').trim();
  return line ? JSON.parse(line).hookSpecificOutput.additionalContext : '';
}

test('shows once per kind when a legacy key exists, Jev is on and the opt-in is off; never the value', () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true } });
    const keyPath = path.join(h.home, '.config', 'vercel', 'ai-gateway-key');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, 'file-secret-value');
    const env = { ANTHROPIC_API_KEY: SECRET };
    const first = additionalContext(runNode(HOOK, h.home, { env }));
    assert.match(first, /shown once/);
    assert.match(first, /the plugin's options screen \(anti-hall -> jev_api_key\)/);
    assert.match(first, /the plugin's options screen \(anti-hall -> anthropic_api_key\)/);
    assert.doesNotMatch(first, /secret/);
    const state = JSON.parse(fs.readFileSync(path.join(h.home, '.anti-hall', 'legacy-key-notice-state.json'), 'utf8'));
    assert.ok(state.shown.jev && state.shown.anthropic);
    const second = additionalContext(runNode(HOOK, h.home, { env }));
    assert.doesNotMatch(second, /shown once/, 'deduped: not shown again');
  } finally { h.cleanup(); }
});

test('silent when Jev is off, when no legacy key exists, or when the opt-in is on', () => {
  const h = makeHome();
  try {
    assert.doesNotMatch(additionalContext(runNode(HOOK, h.home, { env: { ANTHROPIC_API_KEY: SECRET } })), /shown once/, 'Jev off');
    h.writeState('settings.json', { jev: { enabled: true } });
    assert.doesNotMatch(additionalContext(runNode(HOOK, h.home, {})), /shown once/, 'no legacy key');
    h.writeState('settings.json', { jev: { enabled: true }, guards: { allowAnthropicEnvKey: true } });
    assert.doesNotMatch(additionalContext(runNode(HOOK, h.home, { env: { ANTHROPIC_API_KEY: SECRET } })), /shown once/, 'opt-in on');
  } finally { h.cleanup(); }
});

test('fail-open: a corrupt dedupe state file and corrupt settings never crash the hook', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), '{ nope');
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'legacy-key-notice-state.json'), '{ nope');
    const r = runNode(HOOK, h.home, { env: { ANTHROPIC_API_KEY: SECRET } });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /secret/);
  } finally { h.cleanup(); }
});

test('finding-dedup (a non-hook process) says WHY it has no key instead of a silent no-key', () => {
  const h = makeHome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-finding-dedup-'));
  try {
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ jev: { enabled: true } }));
    const r = runNode(FINDING_DEDUP, home, { input: '[]' });
    assert.match(r.stderr, /no Jev key visible to this process/);
    assert.match(r.stderr, /only visible to hooks/);
    assert.match(r.stderr, /jev\.allowLegacyKeyRead/);
  } finally { h.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('jev-report (a non-hook process) prints the one-line reason instead of silently hiding the credit line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-jev-report-'));
  try {
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ jev: { enabled: true } }));
    const r = runNode(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'jev-report.js'), home, { input: '' });
    assert.match(r.stdout, /credit balance(?: \(vercel\))?: n\/a — no Jev key visible to this process/);
    assert.match(r.stdout, /only visible to hooks/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
