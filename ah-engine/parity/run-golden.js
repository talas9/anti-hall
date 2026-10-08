#!/usr/bin/env node
'use strict';
// Replays a golden corpus (tests/golden/<check>.jsonl) against the Node hook, the oracle of a scripted check (D88).
// Usage: node parity/run-golden.js <check> <hook relative to the plugin, e.g. hooks/api-guard.js> [hook args...]
// A case the corpus expects to `defer` (or marks `"node": false`: a fixture Node cannot mirror) is skipped (Node decides it by definition); every other case must give the same
// exit code, stdout and stderr as the stored answer. Exit 0 = no mismatch.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const [check, hook, ...hookArgs] = process.argv.slice(2);
if (!check || !hook) { console.error('usage: run-golden.js <check> <hook> [args]'); process.exit(64); }
const plugin = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');
const corpus = path.resolve(__dirname, '..', 'tests', 'golden', check + '.jsonl');
const cases = fs.readFileSync(corpus, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pluginReal = fs.realpathSync(plugin);
const fill = (s, home, real) => s.split('{PLUGIN}').join(pluginReal).split('{HOMEREAL}').join(real).split('{HOME}').join(home);
const sub = (v, home, real) => {
  if (typeof v === 'string') return fill(v, home, real);
  if (Array.isArray(v)) return v.map((x) => sub(x, home, real));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[sub(k, home, real)] = sub(v[k], home, real); return o; }
  return v;
};
let compared = 0, skipped = 0, bad = 0;
for (const c of cases) {
  if (['defer', 'none'].includes(c.expect.v) || c.node === false) { skipped++; continue; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-gold-node-'));
  const real = fs.realpathSync(home);
  for (const [rel, spec] of Object.entries(c.files || {})) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof spec === 'string') fs.writeFileSync(p, sub(spec, home, real));
    else if (spec && spec.link !== undefined) fs.symlinkSync(sub(spec.link, home, real), p);
    else fs.mkdirSync(p, { recursive: true });
  }
  const env = { PATH: process.env.PATH, ...sub(c.env || {}, home, real) };
  if (c.opts && c.opts.plugin_root) env.CLAUDE_PLUGIN_ROOT = sub(c.opts.plugin_root, home, real); else env.CLAUDE_PLUGIN_ROOT = plugin;
  const r = cp.spawnSync('node', [path.join(plugin, hook), ...hookArgs], { input: JSON.stringify(sub(c.payload, home, real)), env, encoding: 'utf8' });
  const fix = (s) => s.split(pluginReal).join('{PLUGIN}').split(real).join('{HOMEREAL}').split(home).join('{HOME}');
  const e = c.expect, out = fix(r.stdout || ''), err = fix(r.stderr || '');
  let ok;
  if (e.v === 'allow') ok = r.status === 0 && out === '' && err === '';
  else if (e.v === 'advisory') ok = r.status === 0 && out === e.text + '\n' && err === '';
  else if (e.v === 'block') ok = r.status === 2 && err === e.text + '\n';
  else if (e.v === 'exact') ok = r.status === e.code && out === e.out && err === e.err;
  else ok = false;
  compared++;
  if (!ok) { bad++; console.log('MISMATCH', c.n, JSON.stringify(c.payload).slice(0, 200), JSON.stringify({ status: r.status, out, err }).slice(0, 400), JSON.stringify(e).slice(0, 400)); }
  if (c.watch) {
    for (const rel of c.watch) {
      let text = null;
      try { text = fix(fs.readFileSync(path.join(home, rel), 'utf8')).replace(/[0-9]{12,}/g, '{TS}'); } catch (_) { /* absent */ }
      if (text !== c.writes[rel]) { bad++; console.log('MISMATCH (file)', c.n, rel, JSON.stringify(text), JSON.stringify(c.writes[rel])); }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${check}: compared=${compared} skipped(defer)=${skipped} MISMATCH=${bad}`);
process.exit(bad ? 1 : 0);
