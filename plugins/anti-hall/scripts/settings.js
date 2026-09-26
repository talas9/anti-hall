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
//   node scripts/settings.js set <section.key> <value> [--confirmed] [--json]
//   node scripts/settings.js reset <section.key> [--confirmed] [--json]
//   node scripts/settings.js trust-command-allow [<repo>] [--confirmed] [--json]
//   node scripts/settings.js trust-edit-allow [<repo>] [--confirmed] [--json]
//
// `trust-edit-allow` is the same flow for edit-guard's per-project doc-edit
// allowlist .anti-hall/edit-allow.json ({"paths":[repo-relative globs]}),
// recorded in ~/.anti-hall/trusted-edit-allow.json (0.112).
//
// `trust-command-allow` prints the repo's .anti-hall/command-allow.json
// patterns (valid / ignored) and, with --confirmed, records the sha256 of the
// file bytes in ~/.anti-hall/trusted-command-allow.json keyed by the repo's
// realpath. command-guard applies a project allowlist ONLY while that hash
// matches — a cloned repo cannot authorize itself, and any edit to the file
// needs a fresh trust. Without --confirmed nothing is recorded (same consent
// rule as a safety-locked key: a human's direct command, or a yes to the
// agent's question, is the confirmation).
//
// `show --all` includes advanced (tuning/timeout) settings; by default they
// are collapsed to a count per section. `--section` filters to one section.
//
// SAFETY-LOCKED keys (schema `locked: true`, e.g. safety.gitGuard): `set` to
// the RISKY value (a guard off, a bypass on, a new allow-list path) and a
// `reset` whose fallback value (env, /config, legacy or default once the
// settings.json override is gone) is the risky one — e.g. resetting an armed
// guards.stashGuard, default off — need `--confirmed`; re-arming a guard,
// narrowing a list, or a reset back to a safe default does not. A value in
// ~/.anti-hall/settings.json counts like any other (normal precedence). Without
// `--confirmed` nothing changes and the CLI prints
// one short, factual, human-readable line (built from the key's `safetyNote`)
// explaining what the guard normally protects, then exits non-zero with
// `{ok:false, needsConfirmation:true, warning}` on --json. The confirmation
// is the protection — a human direct command, or the agent asking the user
// and getting a yes, IS that confirmation.

const path = require('path');
const schema = require('../hooks/lib/settings-schema.js');
const settings = require('../hooks/lib/settings.js');

function parseArgs(argv) {
  const out = { _: [], json: false, all: false, section: null, confirmed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--confirmed') out.confirmed = true;
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
      s.key + (s.advanced ? ' (advanced)' : '') + (s.locked ? ' (safety: needs --confirmed)' : ''),
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
          locked: !!s.locked,
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
  if (!args.section) {
    out.push('## Not toggleable');
    out.push('');
    out.push('These parts have no switch on purpose:');
    out.push('');
    for (const n of schema.NOT_TOGGLEABLE) out.push('- `' + n.name + '`: ' + n.reason);
    out.push('');
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
  const result = settings.set(section, key, rawValue, Object.assign({}, opts, { confirmed: args.confirmed }));
  if (!result.ok) {
    if (result.needsConfirmation) {
      if (args.json) process.stdout.write(JSON.stringify({ ok: false, needsConfirmation: true, warning: result.warning }) + '\n');
      else process.stdout.write(result.warning + '\n');
    } else if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + '\n');
    } else {
      process.stderr.write('error: ' + result.error + '\n');
    }
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
  const result = settings.reset(section, key, Object.assign({}, opts, { confirmed: args.confirmed }));
  if (!result.ok) {
    if (result.needsConfirmation) {
      if (args.json) process.stdout.write(JSON.stringify({ ok: false, needsConfirmation: true, warning: result.warning }) + '\n');
      else process.stdout.write(result.warning + '\n');
    } else if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + '\n');
    } else {
      process.stderr.write('error: ' + result.error + '\n');
    }
    process.exitCode = 1;
    return;
  }
  const value = settings.get(section, key, undefined, opts);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, section, key, value }) + '\n');
  else process.stdout.write(section + '.' + key + ' reset -> ' + fmtValue(value) + '\n');
}

// cmdTrustAllow(kind, args, opts) — shared by trust-command-allow (kind
// 'command': .anti-hall/command-allow.json, anchored regex patterns) and
// trust-edit-allow (kind 'edit': .anti-hall/edit-allow.json, repo-relative
// globs). One flow so the two can never disagree about consent or hashing.
function cmdTrustAllow(kind, args, opts) {
  const allowLib = require('../hooks/lib/command-allow.js');
  const testHomeGuard = require('../companion/lib/test-home-guard.js');
  const rel = kind === 'edit' ? '.anti-hall/edit-allow.json' : '.anti-hall/command-allow.json';
  const validate = kind === 'edit' ? allowLib.validateEditPath : allowLib.validatePattern;
  const target = args._[0] ? path.resolve(args._[0]) : process.cwd();
  const top = allowLib.repoToplevel(target);
  const fail = (error) => {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    else process.stderr.write('error: ' + error + '\n');
    process.exitCode = 1;
  };
  if (!top) return fail('not inside a git repository: ' + target);
  const f = allowLib.readAllowFile(top, kind);
  if (f.state === 'missing') return fail('no ' + rel + ' in ' + top);
  if (f.state === 'symlink') return fail('refusing a symlinked ' + rel + ' (or .anti-hall dir) in ' + top);
  if (f.state !== 'ok') return fail(rel + ' in ' + top + ' is ' + (f.state === 'invalid-json' ? 'not valid JSON' : 'unreadable'));
  const rows = f.patterns.map((p) => {
    const v = validate(p);
    return { pattern: p, valid: v.ok, reason: v.ok ? null : v.reason };
  });
  const home = testHomeGuard.resolveHome(opts.home, process.env);
  const repo = allowLib.repoKey(top);
  if (!args.confirmed) {
    const what = kind === 'edit'
      ? 'Trusting lets the main thread edit files matching these paths in '
      : 'Trusting lets the main thread run these commands in ';
    const warning = what + repo +
      ' without delegating them. Re-run with --confirmed to trust this exact file content (sha256 ' + f.hash + ').';
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, needsConfirmation: true, repo, sha256: f.hash, patterns: rows, warning }) + '\n');
    } else {
      process.stdout.write(repo + '/' + rel + ':\n');
      for (const r of rows) process.stdout.write('  ' + (r.valid ? '  ' : '! ') + r.pattern + (r.valid ? '' : '   (ignored: ' + r.reason + ')') + '\n');
      process.stdout.write(warning + '\n');
    }
    process.exitCode = 1;
    return;
  }
  try {
    allowLib.recordTrust(home, top, f.hash, kind);
  } catch (e) {
    return fail('could not write ' + allowLib.trustFilePath(home, kind) + ': ' + (e && e.message));
  }
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, repo, sha256: f.hash, patterns: rows }) + '\n');
  } else {
    process.stdout.write('trusted ' + repo + '/' + rel + ' (sha256 ' + f.hash + '):\n');
    for (const r of rows) process.stdout.write('  ' + (r.valid ? '  ' : '! ') + r.pattern + (r.valid ? '' : '   (ignored: ' + r.reason + ')') + '\n');
  }
}

function cmdTrustCommandAllow(args, opts) { return cmdTrustAllow('command', args, opts); }
function cmdTrustEditAllow(args, opts) { return cmdTrustAllow('edit', args, opts); }

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
    case 'trust-command-allow': return cmdTrustCommandAllow(args, opts);
    case 'trust-edit-allow': return cmdTrustEditAllow(args, opts);
    default:
      process.stderr.write('usage: settings.js <show|get|set|reset|trust-command-allow|trust-edit-allow> [args] [--json]\n');
      process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, splitKey, cmdShow, cmdGet, cmdSet, cmdReset, cmdTrustCommandAllow, cmdTrustEditAllow };
