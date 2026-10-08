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
// {NOW}, {NOW-<ms>}, {NOW+<ms>}: the current time in ms; {ISO}, {ISO-<ms>}, {ISO+<ms>}: the same as ISO text, {DATE}: its UTC day (see script::expand_now)
const expandNow = (s) => s.replace(/\{(NOW|ISO|DATE)([-+][0-9]+)?\}/g, (m, k, d) => { const t = Date.now() + (d ? Number(d) : 0); return k === 'NOW' ? String(t) : k === 'DATE' ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString(); });
// time tokens ({MS:-300000}, {ISO:..}, {HM:..}): offsets from the real clock here (the Node hook has no pinned clock); the stored
// answer carries the same tokens, turned back into text below
const NOW = Date.now();
const timeText = (kind, off) => { const t = NOW + off; return kind === 'MS' ? String(t) : kind === 'DATE' ? new Date(t).toISOString().slice(0, 10) : kind === 'LDATE' ? (() => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })() : kind === 'ISO' ? new Date(t).toISOString() : new Date(t).toISOString().slice(11, 16) + ' UTC'; };
const timeTokens = (s) => [...s.matchAll(/\{(MS|ISO|HM|DATE|LDATE):(-?[0-9]+)\}/g)].map((m) => [m[0], timeText(m[1], Number(m[2]))]);
const fillTime = (s) => { let o = s; for (const [tok, txt] of timeTokens(s)) o = o.split(tok).join(txt); return o; };
const fill = (s, home, real) => fillTime(expandNow(s.split('{PLUGIN}').join(pluginReal).split('{HOMEENC}').join(real.replace(/[/\\:.]/g, '-')).split('{HOMEREAL}').join(real).split('{HOME}').join(home)));
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
  for (const [relRaw, spec] of Object.entries(c.files || {})) {
    const rel = fillTime(relRaw);
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof spec === 'string') fs.writeFileSync(p, sub(spec, home, real));
    else if (spec && spec.link !== undefined) fs.symlinkSync(sub(spec.link, home, real), p);
    else if (spec && spec.text !== undefined) { fs.writeFileSync(p, sub(spec.text, home, real)); if (spec.age_ms !== undefined) { const at = new Date(NOW - spec.age_ms); fs.utimesSync(p, at, at); } }
    else fs.mkdirSync(p, { recursive: true });
  }
  const env = { PATH: process.env.PATH, ...sub(c.env || {}, home, real) };
  if (c.opts && c.opts.plugin_root) env.CLAUDE_PLUGIN_ROOT = sub(c.opts.plugin_root, home, real); else env.CLAUDE_PLUGIN_ROOT = plugin;
  const run = () => cp.spawnSync('node', [path.join(plugin, hook), ...hookArgs], { input: JSON.stringify(sub(c.payload, home, real)), env, encoding: 'utf8' });
  for (let i = 1; i < (c.repeat || 1); i++) run(); // earlier runs only leave their state behind
  const r = run();
  const times = timeTokens(JSON.stringify(c)).sort((a, b) => b[1].length - a[1].length);
  // normTs: a clock reading (12 or more digits) is {TS} in the stored and compared answers
  const fix = (s) => { let t = s.split(pluginReal).join('{PLUGIN}').split(real).join('{HOMEREAL}').split(home).join('{HOME}'); for (const [tok, txt] of times) t = t.split(txt).join(tok); return c.normTs ? t.replace(/[0-9]{12,}/g, '{TS}').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '{ISO}').replace(/(?<!\d)\d{4}-\d\d-\d\d(?!\d)/g, '{DATE}') : t; };
  // a routing check's answer is a verdict plus telemetry rows: the oracle compares the verdict
  const vm = (t) => { let o = t; for (const m of (c.vmask || [])) o = o.replace(new RegExp(m, 'g'), '{V*}'); return o; };
  const e = c.expect.v === 'routed' ? c.expect.verdict : c.expect, out = vm(fix(r.stdout || '')), err = vm(fix(r.stderr || ''));
  let ok;
  if (e.v === 'allow') ok = r.status === 0 && out === '' && err === '';
  else if (e.v === 'advisory') ok = r.status === 0 && out === e.text + '\n' && err === '';
  else if (e.v === 'block') ok = r.status === 2 && err === e.text + '\n';
  else if (e.v === 'exact') ok = r.status === e.code && out === e.out && err === e.err;
  else ok = false;
  compared++;
  if (!ok) { bad++; console.log('MISMATCH', c.n, JSON.stringify(c.payload).slice(0, 200), JSON.stringify({ status: r.status, out, err }).slice(0, 400), JSON.stringify(e).slice(0, 400)); }
  if (c.watch) {
    for (const rel0 of c.watch) {
      const rel = fillTime(expandNow(rel0));
      let text = null;
      try {
        let raw = fs.readFileSync(path.join(home, fillTime(rel)), 'utf8');
        if (c.mask_iso) raw = raw.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z/g, '{ISO*}').replace(/"project":"[^"]*"/g, '"project":"{P*}"');
        text = fix(raw);
        for (const m of (c.mask || [])) text = text.replace(new RegExp(m, 'g'), '{M*}');
        text = text.replace(/[0-9]{12,}/g, '{TS}').replace(/\{TS\}\.[0-9]+/g, '{TS}');
        if (c.normTs) text = text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '{ISO}').replace(/(?<!\d)\d{4}-\d\d-\d\d(?!\d)/g, '{DATE}');
      } catch (_) { /* absent */ }
      if (text !== c.writes[rel0]) { bad++; console.log('MISMATCH (file)', c.n, rel, JSON.stringify(text), JSON.stringify(c.writes[rel0])); }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${check}: compared=${compared} skipped(defer)=${skipped} MISMATCH=${bad}`);
process.exit(bad ? 1 : 0);
