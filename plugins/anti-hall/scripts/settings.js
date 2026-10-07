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
//   node scripts/settings.js judge on|off|status
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

// effectiveIntegrations(opts) -> one entry per jevIntegrations id with the
// mode the runtime actually applies (not just the stored value):
//   - every id except triage: jev-assist.js getMode(), which also folds in the
//     master switch (jev.json "enabled" / ANTIHALL_JEV) and the per-id env
//     kill switch ANTIHALL_JEV_<ID>=0.
//   - triage: jev-triage.js loadTriageConfig().enabled ("on"/"off"); its
//     labels go to jev-triage.ndjson and only its reply outcomes go to
//     jev-assist.ndjson.
// `configured`/`source` are the stored jevIntegrations value and the tier
// that answered it (env, file = settings.json, /config, legacy = jev.json
// "integrations" map, default = schema default).
function effectiveIntegrations(opts) {
  const home = require('../companion/lib/test-home-guard.js').resolveHome(opts && opts.home, process.env);
  const sec = schema.SECTIONS.find((x) => x.key === 'jevIntegrations');
  if (!sec) return [];
  let assist = null; let triage = null; let fileCfg = {};
  try { assist = require('../hooks/lib/jev-assist.js'); fileCfg = assist.readJevJson(home); } catch (_) { assist = null; }
  try { triage = require('../hooks/lib/jev-triage.js'); } catch (_) { triage = null; }
  return sec.settings.map((s) => {
    let effective = 'unknown';
    try {
      if (s.key === 'triage') effective = triage && triage.loadTriageConfig(home).enabled ? 'on' : 'off';
      else if (assist) effective = assist.getMode(s.key, fileCfg, home);
    } catch (_) { effective = 'unknown'; }
    return {
      id: s.key,
      effective,
      configured: settings.get('jevIntegrations', s.key, undefined, { home }),
      source: settings.source('jevIntegrations', s.key, { home }),
      logs: s.key === 'triage' ? 'jev-triage.ndjson (+ outcome rows in jev-assist.ndjson)' : 'jev-assist.ndjson',
    };
  });
}

function cmdShow(args, opts) {
  const target = args.section ? schema.SECTIONS.filter((s) => s.key === args.section) : schema.SECTIONS;
  if (args.section && target.length === 0) {
    process.stderr.write('\u274C anti-hall \u00B7 settings: unknown section: ' + args.section + '\n');
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
    if (target.some((sec) => sec.key === 'jev' || sec.key === 'jevIntegrations')) {
      out.jevEffectiveIntegrations = effectiveIntegrations(opts);
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
    if (sec.key === 'jev' || (sec.key === 'jevIntegrations' && args.section)) {
      out.push('**Jev integrations — effective mode** (what the runtime applies, including the master switch and env kill switches):');
      out.push('');
      out.push(renderTable(effectiveIntegrations(opts).map((r) => [
        r.id, r.effective, fmtValue(r.configured), sourceLabel(r.source), r.logs,
      ]), ['Integration', 'Effective', 'Configured', 'Source', 'Logs to']));
      out.push('');
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
    process.stderr.write('\u274C anti-hall \u00B7 settings: unknown setting: ' + args._[0] + ' (expected section.key)\n');
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
    process.stderr.write('\u274C anti-hall \u00B7 settings: unknown setting: ' + args._[0] + ' (expected section.key)\n');
    process.exitCode = 1;
    return;
  }
  if (rawValue === undefined) {
    process.stderr.write('\uD83D\uDCA1 anti-hall \u00B7 settings: usage: settings.js set <section.key> <value>\n');
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
      process.stderr.write('\u274C anti-hall \u00B7 settings: ' + result.error + '\n');
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
    process.stderr.write('\u274C anti-hall \u00B7 settings: unknown setting: ' + args._[0] + ' (expected section.key)\n');
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
      process.stderr.write('\u274C anti-hall \u00B7 settings: ' + result.error + '\n');
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
    else process.stderr.write('\u274C anti-hall \u00B7 settings: ' + error + '\n');
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

const JUDGE_COST = 'about $0.0001\u20130.001 and 1\u20133 s per turn end, estimated, not measured; precision 0.78\u20130.81 and recall 1.0 measured on eval/inference-bench.js (84 synthetic cases)';
const JUDGE_COST_CLI = 'no API bill (your Claude login\'s usage) and about 5\u20136 s per turn end, measured; precision 0.78\u20130.81 and recall 1.0 measured on eval/inference-bench.js (84 synthetic cases)';

// judge on|off|status — the opt-in semantic speculation-judge (jev.semanticJudge).
// The key is only RESOLVED here (never printed). A key stored as a Claude Code
// plugin option is exported to hook processes only, so this CLI cannot see it:
// "not visible" means "unverified from here", not "absent".
function cmdJudge(args, opts) {
  const verb = args._[0];
  if (verb !== 'on' && verb !== 'off' && verb !== 'status') {
    process.stderr.write('\uD83D\uDCA1 anti-hall \u00B7 settings: usage: settings.js judge on|off|status\n');
    process.exitCode = 1;
    return;
  }
  if (verb !== 'status') {
    const r = settings.set('jev', 'semanticJudge', verb === 'on' ? 'true' : 'false', opts);
    if (!r.ok) {
      process.stderr.write('\u274C anti-hall \u00B7 settings: ' + r.error + '\n');
      process.exitCode = 1;
      return;
    }
  }
  const on = settings.get('jev', 'semanticJudge', false, opts) === true;
  let hasKey = false;
  try { hasKey = !!require('../hooks/lib/credentials.js').resolveKey('anthropic', { env: process.env }).key; } catch (_) { /* unverifiable */ }
  const be = require('../hooks/lib/jev-assist.js').speculationBackend().backend;
  const model = settings.get('jev', 'judgeModel', 'haiku', opts);
  const out = [];
  out.push('judge: ' + (on ? 'on' : 'off') + (verb === 'off' && on ? ' (still on via env ANTIHALL_SEMANTIC_JUDGE)' : ''));
  const jb = settings.get('jev', 'judgeBackend', 'api', opts);
  const viaCli = jb === 'cli' || (jb === 'auto' && !hasKey);
  out.push('backend: ' + be + (be === 'jev' ? ' (speculation-guard asks Jev; the paid API judge exits early' + (on ? ', API judge skipped)' : ')') : be === 'api' ? (viaCli ? ' (speculation-judge calls the local claude CLI, jev.judgeBackend=' + jb + ')' : ' (speculation-judge calls the Anthropic API)') : ' (lexical speculation-guard only)'));
  if (verb === 'on' || verb === 'status') {
    out.push('key: ' + (hasKey ? 'found (value not shown)' : 'not visible to this process'));
    if (verb === 'status') out.push('model: ' + model);
  }
  if (verb === 'on') {
    if (!hasKey && !viaCli) {
      out.push('No key visible here. Add one so the judge can call the Anthropic API:');
      out.push('  Claude Code: plugin options screen, anti-hall -> anthropic_api_key (visible to hooks only, so this CLI cannot confirm it).');
      out.push('  Codex: set guards.allowAnthropicEnvKey to true in ~/.anti-hall/settings.json and export ANTHROPIC_API_KEY.');
      out.push('Without a key the judge is fail-open (does nothing). Or use your Claude login instead of a key: settings.js set jev.judgeBackend cli');
    }
    out.push('Cost: ' + (viaCli ? JUDGE_COST_CLI : JUDGE_COST) + '.');
  }
  process.stdout.write(out.join('\n') + '\n');
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
    case 'judge': return cmdJudge(args, opts);
    case 'trust-command-allow': return cmdTrustCommandAllow(args, opts);
    case 'trust-edit-allow': return cmdTrustEditAllow(args, opts);
    default:
      process.stderr.write('\uD83D\uDCA1 anti-hall \u00B7 settings: usage: settings.js <show|get|set|reset|judge|trust-command-allow|trust-edit-allow> [args] [--json]\n');
      process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, splitKey, effectiveIntegrations, cmdShow, cmdGet, cmdSet, cmdReset, cmdJudge, cmdTrustCommandAllow, cmdTrustEditAllow };
