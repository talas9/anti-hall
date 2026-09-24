#!/usr/bin/env node
'use strict';
// anti-hall :: auto-handover-config — get/set the auto-handover trigger's
// persisted settings (hooks/lib/auto-handover-config.js / settings.js,
// section "autoHandover" of ~/.anti-hall/settings.json).
//
// The agent runs this on the user's behalf when they ask to change/disable/
// show the auto-handover threshold or its nags — see
// skills/settings/SKILL.md (the auto-handover section; this CLI is its alias). It never edits settings.json by
// hand: settings.js's set() is the only writer, atomic and read-modify-write,
// so this stays safe alongside any other feature sharing the same file (a
// future settings page included). Deliberately thin — a stable get/set
// surface over hooks/lib/settings.js that can become a settings.js CLI alias
// later without changing its behavior.
//
// USAGE
//   node auto-handover-config.js get [--json]
//   node auto-handover-config.js set <1-99>
//   node auto-handover-config.js off
//   node auto-handover-config.js on
//   node auto-handover-config.js nag on|off
//   node auto-handover-config.js nag-step <n>
//   node auto-handover-config.js nag-quiet <n>
//   node auto-handover-config.js max-tokens <n>   (absolute token ceiling; 0 = off)

const path = require('path');
const {
  readConfig,
  writeConfig,
  resolveEffective,
  isValidPct,
  isPositiveInt,
  isValidMaxTokens,
  DEFAULT_PCT,
} = require(path.join(__dirname, '..', 'hooks', 'lib', 'auto-handover-config.js'));

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function cmdGet(opts) {
  const cfg = readConfig();
  const effective = resolveEffective({});
  if (opts.json) {
    console.log(JSON.stringify({ raw: cfg, effective }));
    return;
  }
  console.log(`enabled: ${effective.enabled}`);
  console.log(`pct: ${effective.pct} (source: ${effective.source})`);
  console.log(`maxTokens: ${effective.maxTokens}${effective.maxTokens === 0 ? ' (ceiling off)' : ''}`);
  console.log(`nag: ${effective.nag}`);
  console.log(`nagStepPct: ${effective.nagStepPct}`);
  console.log(`nagQuietMin: ${effective.nagQuietMin}`);
}

function cmdSet(pctArg) {
  const n = parseInt(pctArg, 10);
  if (!isValidPct(n)) {
    fail(`set: invalid percent "${pctArg}" — expected an integer 1-99`);
    return;
  }
  writeConfig(undefined, (cfg) => {
    cfg.pct = n;
    cfg.enabled = true;
    return cfg;
  });
  console.log(`auto-handover threshold set to ${n}%`);
}

function cmdOff() {
  writeConfig(undefined, (cfg) => {
    cfg.enabled = false;
    return cfg;
  });
  console.log('auto-handover disabled');
}

function cmdOn() {
  writeConfig(undefined, (cfg) => {
    cfg.enabled = true;
    if (!isValidPct(cfg.pct)) cfg.pct = DEFAULT_PCT;
    return cfg;
  });
  console.log('auto-handover enabled');
}

function cmdNag(value) {
  if (value !== 'on' && value !== 'off') {
    fail('nag: usage is `nag on|off`');
    return;
  }
  writeConfig(undefined, (cfg) => {
    cfg.nag = value === 'on';
    return cfg;
  });
  console.log(`auto-handover nag ${value}`);
}

function cmdNagStep(nArg) {
  const n = parseInt(nArg, 10);
  if (!isPositiveInt(n)) {
    fail(`nag-step: invalid value "${nArg}" — expected a positive integer`);
    return;
  }
  writeConfig(undefined, (cfg) => {
    cfg.nagStepPct = n;
    return cfg;
  });
  console.log(`auto-handover nag-step set to ${n}`);
}

function cmdNagQuiet(nArg) {
  const n = parseInt(nArg, 10);
  if (!isPositiveInt(n)) {
    fail(`nag-quiet: invalid value "${nArg}" — expected a positive integer (minutes)`);
    return;
  }
  writeConfig(undefined, (cfg) => {
    cfg.nagQuietMin = n;
    return cfg;
  });
  console.log(`auto-handover nag-quiet set to ${n} minutes`);
}

function cmdMaxTokens(nArg) {
  const n = parseInt(nArg, 10);
  if (!isValidMaxTokens(n) || String(n) !== String(nArg).trim()) {
    fail(`max-tokens: invalid value "${nArg}" — expected an integer >= 0 (0 turns the ceiling off)`);
    return;
  }
  writeConfig(undefined, (cfg) => {
    cfg.maxTokens = n;
    return cfg;
  });
  console.log(n === 0 ? 'auto-handover token ceiling off' : `auto-handover token ceiling set to ${n} tokens`);
}

function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const jsonFlag = argv.includes('--json');

  switch (verb) {
    case 'get': return cmdGet({ json: jsonFlag });
    case 'set': return cmdSet(argv[1]);
    case 'off': return cmdOff();
    case 'on': return cmdOn();
    case 'nag': return cmdNag(argv[1]);
    case 'nag-step': return cmdNagStep(argv[1]);
    case 'nag-quiet': return cmdNagQuiet(argv[1]);
    case 'max-tokens': return cmdMaxTokens(argv[1]);
    default:
      console.error('usage: auto-handover-config.js get [--json] | set <1-99> | off | on | nag on|off | nag-step <n> | nag-quiet <n> | max-tokens <n>');
      process.exitCode = 1;
  }
}

module.exports = { cmdGet, cmdSet, cmdOff, cmdOn, cmdNag, cmdNagStep, cmdNagQuiet, cmdMaxTokens };

if (require.main === module) {
  main();
}
