'use strict';
// plugins/anti-hall/monitors/monitors.json — Claude Code plugin-declared
// Monitor schema (see docs/KB-claude-monitor-tool.md §5, verified against the
// official plugin schema): a TOP-LEVEL ARRAY of {name, command, description,
// when?}. This is the ADDITIVE low-latency wake path layered on top of the
// agent-armed Monitor call (hooks/lib/devswarm-wake.js's monitorArmLine) and
// the unconditional CronCreate fallback — neither of those is replaced by
// this file; it only adds a third path that costs nothing when unavailable
// (project-scope installs never load it at all — §9 of the same KB).
//
// These are pure structural/schema assertions (valid JSON, correct shape,
// substitution syntax, no rejected `${user_config.*}` token, points at a real
// on-disk file) — there is no live Claude Code runtime to actually load this
// manifest against in a unit test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const MONITORS_JSON = path.join(PLUGIN_ROOT, 'monitors', 'monitors.json');

const RAW = fs.readFileSync(MONITORS_JSON, 'utf8');

test('monitors.json is valid JSON', () => {
  assert.doesNotThrow(() => JSON.parse(RAW));
});

test('monitors.json is a TOP-LEVEL ARRAY, not {monitors: [...]} — v2.1.x schema, verified against official docs', () => {
  const parsed = JSON.parse(RAW);
  assert.ok(Array.isArray(parsed), 'top-level value must be an array');
  assert.ok(parsed.length >= 1, 'must declare at least one monitor');
});

test('every entry matches the required schema: name, command, description (all non-empty strings)', () => {
  const parsed = JSON.parse(RAW);
  for (const m of parsed) {
    assert.strictEqual(typeof m.name, 'string');
    assert.ok(m.name.length > 0, 'name must be non-empty');
    assert.strictEqual(typeof m.command, 'string');
    assert.ok(m.command.length > 0, 'command must be non-empty');
    assert.strictEqual(typeof m.description, 'string');
    assert.ok(m.description.length > 0, 'description must be non-empty');
  }
});

test('optional `when` is only ever "always" or "on-skill-invoke:<skill-name>" — no other documented value', () => {
  const parsed = JSON.parse(RAW);
  for (const m of parsed) {
    if (m.when === undefined) continue;
    assert.ok(
      m.when === 'always' || /^on-skill-invoke:.+/.test(m.when),
      'unexpected `when` value: ' + JSON.stringify(m.when),
    );
  }
});

test('names are unique within the plugin', () => {
  const parsed = JSON.parse(RAW);
  const names = parsed.map((m) => m.name);
  assert.strictEqual(new Set(names).size, names.length, 'monitor names must be unique');
});

test('command uses ${CLAUDE_PLUGIN_ROOT} substitution, never a hardcoded absolute path', () => {
  const parsed = JSON.parse(RAW);
  for (const m of parsed) {
    assert.ok(m.command.includes('${CLAUDE_PLUGIN_ROOT}'), 'command should be portable via ${CLAUDE_PLUGIN_ROOT}: ' + m.command);
  }
});

test('command never references ${user_config.*} — REJECTED as of Claude Code v2.1.207', () => {
  assert.doesNotMatch(RAW, /\$\{user_config\./, 'monitors.json must not use ${user_config.*} substitution');
});

test('the devswarm-wake-watch command resolves to a REAL file on disk in this plugin tree', () => {
  const parsed = JSON.parse(RAW);
  const entry = parsed.find((m) => m.name === 'devswarm-wake-watch');
  assert.ok(entry, 'devswarm-wake-watch entry must be present');
  const resolvedCommand = entry.command.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
  const watcherPath = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
  assert.ok(resolvedCommand.includes(watcherPath), 'command must point at the real watcher script path');
  assert.ok(fs.existsSync(watcherPath), 'the watcher script referenced by monitors.json must actually exist on disk');
});

test('the watcher script the entry points at is require()-loadable and side-effect-free on require (main() guarded)', () => {
  const watcherPath = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
  let mod;
  assert.doesNotThrow(() => { mod = require(watcherPath); });
  assert.strictEqual(typeof mod.tick, 'function');
  const src = fs.readFileSync(watcherPath, 'utf8');
  assert.match(src, /require\.main === module/, 'the watcher must guard its main() runner so a bare require() never starts the poll loop');
});
