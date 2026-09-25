'use strict';
// scripts/settings.js — the `/anti-hall:settings` CLI. Every test runs the
// script in-process (via child_process, isolated HOME) so it exercises the
// real argv/stdout path, never the real machine's ~/.anti-hall.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { makeHome } = require('../helpers/fixtures.js');

const CLI = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'settings.js');

function run(args, home) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ? e.stdout.toString() : '', stderr: e.stderr ? e.stderr.toString() : '' };
  }
}

test('show: renders markdown tables grouped by section, headline settings only by default', () => {
  const home = makeHome();
  try {
    const r = run(['show', '--section', 'autoHandover'], home.home);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /## Auto Handover/);
    assert.match(r.stdout, /\| Setting \| Value \| Default \| Source \| Description \|/);
    assert.match(r.stdout, /\| enabled \| true \| true \| default \|/);
  } finally {
    home.cleanup();
  }
});

test('show --json: matches the settings.js get() values exactly', () => {
  const home = makeHome();
  try {
    const r = run(['show', '--section', 'jev', '--json'], home.home);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.jev.enabled.value, false);
    assert.strictEqual(parsed.jev.enabled.source, 'default');
    // advanced settings hidden by default
    assert.strictEqual(parsed.jev.keyFile, undefined);
  } finally {
    home.cleanup();
  }
});

test('show --all: includes advanced settings', () => {
  const home = makeHome();
  try {
    const r = run(['show', '--section', 'jev', '--all', '--json'], home.home);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.jev.keyFile, 'advanced key present with --all');
  } finally {
    home.cleanup();
  }
});

test('get/set/reset round-trip through the CLI with isolated HOME', () => {
  const home = makeHome();
  try {
    let r = run(['get', 'autoHandover.pct', '--json'], home.home);
    assert.deepStrictEqual(JSON.parse(r.stdout), { section: 'autoHandover', key: 'pct', value: 85, source: 'default', default: 85 });

    r = run(['set', 'autoHandover.pct', '77', '--json'], home.home);
    assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, section: 'autoHandover', key: 'pct', value: 77 });

    r = run(['get', 'autoHandover.pct', '--json'], home.home);
    assert.strictEqual(JSON.parse(r.stdout).value, 77);
    assert.strictEqual(JSON.parse(r.stdout).source, 'file');

    r = run(['reset', 'autoHandover.pct', '--json'], home.home);
    assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, section: 'autoHandover', key: 'pct', value: 85 });
  } finally {
    home.cleanup();
  }
});

test('set: an invalid value exits non-zero and reports the error, never writes', () => {
  const home = makeHome();
  try {
    const r = run(['set', 'autoHandover.pct', '999', '--json'], home.home);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(JSON.parse(r.stdout).ok, false);
  } finally {
    home.cleanup();
  }
});

test('get/set: unknown section.key exits non-zero with a clear error', () => {
  const home = makeHome();
  try {
    const r = run(['get', 'nope.nope'], home.home);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /unknown setting/);
  } finally {
    home.cleanup();
  }
});

test('the CLI never touches the real machine HOME (isolated HOME leaves no ~/.anti-hall/settings.json trace in the fixture)', () => {
  const home = makeHome();
  try {
    run(['set', 'autoHandover.pct', '33'], home.home);
    const fs = require('node:fs');
    const p = path.join(home.home, '.anti-hall', 'settings.json');
    assert.ok(fs.existsSync(p));
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).autoHandover.pct, 33);
  } finally {
    home.cleanup();
  }
});

test('get: every /config-exposed key set via CLAUDE_PLUGIN_OPTION_<KEY> reports source /config', () => {
  const SCHEMA = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
  const home = makeHome();
  try {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(ANTIHALL_|CLAUDE_PLUGIN_OPTION_)/.test(k)) base[k] = v;
    }
    Object.assign(base, { HOME: home.home, USERPROFILE: home.home });
    const entries = SCHEMA.pluginOptionEntries();
    assert.ok(entries.length >= 39);
    for (const e of entries) {
      let v;
      if (e.type === 'boolean') v = String(!e.default);
      else if (e.type === 'enum') v = e.values.find((x) => x !== e.default);
      else if (e.type === 'number') v = String(e.default == null ? 7 : (Number.isFinite(e.max) && e.default + 1 > e.max ? e.default - 1 : e.default + 1));
      else v = 'cfg-' + e.key;
      const env = { ...base, ['CLAUDE_PLUGIN_OPTION_' + e.pluginOption.toUpperCase()]: v };
      const out = execFileSync(process.execPath, [CLI, 'get', e.section + '.' + e.key], { env, encoding: 'utf8' });
      assert.strictEqual(out, e.section + '.' + e.key + ' = ' + v + ' (source: /config, default: ' + (e.default === '' || e.default == null ? '(empty)' : String(e.default)) + ')\n');
    }
  } finally {
    home.cleanup();
  }
});
