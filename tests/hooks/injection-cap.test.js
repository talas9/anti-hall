'use strict';
// injection-cap.test.js — the regression net that would have caught the
// verify-first-full SPILL bug (task #58).
//
// THE BUG IT GUARDS: Claude Code caps a hook's `additionalContext` (and the
// `systemMessage` / Stop `reason` model-reaching fields) at ~10,000 chars. The
// failure mode is NOT clean truncation — a payload over the cap SPILLS TO FILE:
// the model receives only the first ~2,000 chars inline plus a file path it must
// choose to open. verify-first-full.js emitted ~15,323 chars, so its entire
// orchestration doctrine reached NObody's context inline. The cap is PER HOOK
// COMMAND, which is why the fix splits the doctrine across two SessionStart hooks
// each under the cap.
//
// This suite EXECUTES every context-injecting hook registered in hooks.json
// (SessionStart / UserPromptSubmit / Stop) plus the SubagentStart injector, on a
// representative payload for each event (and a DevSwarm-Primary env variant, which
// is the maximal-emission path), and asserts every emitted additionalContext /
// systemMessage / Stop reason is <= 10,000 chars. A hook that re-grows past the
// cap fails HERE with its measured length — before it silently spills in prod.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

// The documented cap (code.claude.com/docs/en/hooks). At/under 10,000 -> 100%
// inline; over 10,000 -> spill-to-file (~2,000 inline + a file path). Target
// headroom for the injectors we own is <=9,000 (see verify-first-*.test.js), but
// the HARD regression line is the cap itself.
const CAP = 10000;

const HOOKS_JSON = path.join(HOOKS_DIR, 'hooks.json');

// Representative payloads for each context-injecting event.
function payloadFor(event) {
  const base = { session_id: 't', cwd: process.cwd() };
  if (event === 'SessionStart') return { hook_event_name: 'SessionStart', source: 'startup', ...base };
  if (event === 'SubagentStart') return { hook_event_name: 'SubagentStart', ...base };
  if (event === 'UserPromptSubmit') return { hook_event_name: 'UserPromptSubmit', prompt: 'x', ...base };
  if (event === 'Stop') return { hook_event_name: 'Stop', ...base };
  return { hook_event_name: event, ...base };
}

// The model-reaching text fields a hook can emit. additionalContext is the
// SessionStart/SubagentStart/UserPromptSubmit channel; systemMessage is a
// general channel; a Stop hook's decision.reason is its model-reaching field.
function emittedTexts(json) {
  if (!json || typeof json !== 'object') return [];
  const out = [];
  const hso = json.hookSpecificOutput;
  if (hso && typeof hso.additionalContext === 'string') out.push(['additionalContext', hso.additionalContext]);
  if (typeof json.additionalContext === 'string') out.push(['additionalContext', json.additionalContext]);
  if (typeof json.systemMessage === 'string') out.push(['systemMessage', json.systemMessage]);
  if (json.decision === 'block' && typeof json.reason === 'string') out.push(['reason', json.reason]);
  return out;
}

// Unique hook files registered on each context-injecting event, read from the
// canonical Claude hooks.json (SubagentStart is not in hooks.json's main events —
// it is a distinct SDK event — so it is added explicitly).
function hooksForEvents(events) {
  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const map = new Map(); // event -> Set(file)
  for (const event of events) {
    const set = new Set();
    const groups = (cfg.hooks && Array.isArray(cfg.hooks[event])) ? cfg.hooks[event] : [];
    for (const g of groups) {
      for (const h of (Array.isArray(g.hooks) ? g.hooks : [])) {
        const m = String((h && h.command) || '').match(/[\w-]+\.js/);
        if (m) set.add(m[0]);
      }
    }
    map.set(event, set);
  }
  return map;
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
// DevSwarm-Primary is the maximal-emission path for the SessionStart injectors
// (rule W) and the parent per-turn hooks — measure it too.
const ENV_VARIANTS = [
  ['baseline', undefined],
  ['devswarm-primary', { DEVSWARM_REPO_ID: 'repo-x' }],
];

test('every context-injecting hook emits <= 10,000 chars (no spill-to-file)', () => {
  const map = hooksForEvents(EVENTS);
  // SubagentStart injector — registered as a distinct SDK event, not in hooks.json.
  map.set('SubagentStart', new Set(['verify-first-subagent.js']));

  const violations = [];
  for (const [event, files] of map) {
    for (const file of files) {
      for (const [envLabel, env] of ENV_VARIANTS) {
        const h = makeHome();
        try {
          const r = testHook(file, payloadFor(event), { home: h.home, env });
          for (const [field, text] of emittedTexts(r.json)) {
            if (text.length > CAP) {
              violations.push(`${file} [${event}/${envLabel}] ${field}=${text.length} chars (> ${CAP})`);
            }
          }
        } finally {
          h.cleanup();
        }
      }
    }
  }

  assert.deepStrictEqual(
    violations, [],
    `SPILL RISK — hook(s) emit context over the ~${CAP}-char cap (spills to file, ~2k inline):\n  ` +
    violations.join('\n  '),
  );
});
