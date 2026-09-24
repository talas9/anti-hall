#!/usr/bin/env node
'use strict';
// anti-hall :: settings CLI — the ONE place every anti-hall setting is shown,
// read, or changed. Backed by hooks/lib/settings.js (~/.anti-hall/settings.json)
// and hooks/lib/settings-schema.js (the declarative registry of every
// user-facing setting). See `/anti-hall:settings` for the conversational
// front-end this CLI powers.
//
// USAGE
//   node scripts/settings.js show [--section <key>] [--all] [--json]
//   node scripts/settings.js get <section.key> [--json]
//   node scripts/settings.js set <section.key> <value> [--json]
//   node scripts/settings.js reset <section.key> [--json]
//
// `show --all` includes advanced (tuning/timeout) settings; by default they
// are collapsed to a count per section. `--section` filters to one section.

const path = require('path');
const schema = require('../hooks/lib/settings-schema.js');
const settings = require('../hooks/lib/settings.js');

function parseArgs(argv) {
  const out = { _: [], json: false, all: false, section: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--section') out.section = argv[++i];
    else out._.push(a);
  }
  return out;
}

function splitKey(dotted) {
  const idx = String(dotted || '').indexOf('.');
  if (idx < 0) return [null, null];
  return [dotted.slice(0, idx), dotted.slice(idx + 1)];
}

function sourceLabel(src) {
  return { env: 'env', file: 'file', 'plugin-option': '/config', legacy: 'legacy', default: 'default' }[src] || src;
}

function fmtValue(v) {
  if (v === '' || v === undefined || v === null) return '(empty)';
  if (typeof v === 'object') return '`' + JSON.stringify(v).replace(/\|/g, '\\|') + '`'; // object settings (jev.prices)
  return String(v);
}

function renderTable(rows, headers) {
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const r of rows) lines.push('| ' + r.join(' | ') + ' |');
  return lines.join('\n');
}

// sectionRows(sectionDef, opts, advanced) -> the rows of ONE tier: headline
// (advanced=false) or advanced-only (advanced=true). Filtered by the flag, not
// by position — a section may interleave headline and advanced entries.
function sectionRows(sectionDef, opts, advanced) {
  const list = sectionDef.settings.filter((s) => !!s.advanced === !!advanced);
  return list.map((s) => {
    const value = settings.get(sectionDef.key, s.key, undefined, opts);
    const src = settings.source(sectionDef.key, s.key, opts);
    return [
      s.key + (s.advanced ? ' (advanced)' : ''),
      fmtValue(value),
      fmtValue(s.default),
      sourceLabel(src),
      s.description || '',
    ];
  });
}

function cmdShow(args, opts) {
  const target = args.section ? schema.SECTIONS.filter((s) => s.key === args.section) : schema.SECTIONS;
  if (args.section && target.length === 0) {
    process.stderr.write('unknown section: ' + args.section + '\n');
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    const out = {};
    for (const sec of target) {
      out[sec.key] = {};
      for (const s of sec.settings) {
        if (!args.all && s.advanced) continue;
        out[sec.key][s.key] = {
          value: settings.get(sec.key, s.key, undefined, opts),
          default: s.default,
          source: settings.source(sec.key, s.key, opts),
          advanced: !!s.advanced,
        };
      }
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const out = [];
  for (const sec of target) {
    out.push('## ' + sec.label);
    out.push('');
    if (sec.description) { out.push(sec.description); out.push(''); }
    const headline = sectionRows(sec, opts, false);
    if (headline.length) {
      out.push(renderTable(headline, ['Setting', 'Value', 'Default', 'Source', 'Description']));
      out.push('');
    }
    const advancedCount = sec.settings.filter((s) => s.advanced).length;
    if (advancedCount) {
      if (args.all) {
        out.push('**Advanced:**');
        out.push('');
        out.push(renderTable(sectionRows(sec, opts, true), ['Setting', 'Value', 'Default', 'Source', 'Description']));
        out.push('');
      } else {
        out.push('_' + advancedCount + ' advanced setting(s) hidden — rerun with `--all` to show them._');
        out.push('');
      }
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

function cmdGet(args, opts) {
  const [section, key] = splitKey(args._[0]);
  const entry = section && schema.findSetting(section, key);
  if (!entry) {
    process.stderr.write('unknown setting: ' + args._[0] + ' (expected section.key)\n');
    process.exitCode = 1;
    return;
  }
  const value = settings.get(section, key, undefined, opts);
  const src = settings.source(section, key, opts);
  if (args.json) {
    process.stdout.write(JSON.stringify({ section, key, value, source: src, default: entry.default }) + '\n');
  } else {
    process.stdout.write(section + '.' + key + ' = ' + fmtValue(value) + ' (source: ' + sourceLabel(src) + ', default: ' + fmtValue(entry.default) + ')\n');
  }
}

function cmdSet(args, opts) {
  const [section, key] = splitKey(args._[0]);
  const rawValue = args._[1];
  const entry = section && schema.findSetting(section, key);
  if (!entry) {
    process.stderr.write('unknown setting: ' + args._[0] + ' (expected section.key)\n');
    process.exitCode = 1;
    return;
  }
  if (rawValue === undefined) {
    process.stderr.write('usage: settings.js set <section.key> <value>\n');
    process.exitCode = 1;
    return;
  }
  const result = settings.set(section, key, rawValue, opts);
  if (!result.ok) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + '\n');
    else process.stderr.write('error: ' + result.error + '\n');
    process.exitCode = 1;
    return;
  }
  const value = settings.get(section, key, undefined, opts);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, section, key, value }) + '\n');
  else process.stdout.write(section + '.' + key + ' = ' + fmtValue(value) + '\n');
}

function cmdReset(args, opts) {
  const [section, key] = splitKey(args._[0]);
  const entry = section && schema.findSetting(section, key);
  if (!entry) {
    process.stderr.write('unknown setting: ' + args._[0] + ' (expected section.key)\n');
    process.exitCode = 1;
    return;
  }
  const result = settings.reset(section, key, opts);
  if (!result.ok) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + '\n');
    else process.stderr.write('error: ' + result.error + '\n');
    process.exitCode = 1;
    return;
  }
  const value = settings.get(section, key, undefined, opts);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, section, key, value }) + '\n');
  else process.stdout.write(section + '.' + key + ' reset -> ' + fmtValue(value) + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const opts = {}; // real HOME; tests require this module directly with {home}

  switch (cmd) {
    case 'show': return cmdShow(args, opts);
    case 'get': return cmdGet(args, opts);
    case 'set': return cmdSet(args, opts);
    case 'reset': return cmdReset(args, opts);
    default:
      process.stderr.write('usage: settings.js <show|get|set|reset> [args] [--json]\n');
      process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, splitKey, cmdShow, cmdGet, cmdSet, cmdReset };
