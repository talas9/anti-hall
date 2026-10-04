'use strict';
// Shared fixtures for the cost-trim Phase 3 tests (compact core, conditional orchestration).
// Everything runs in a disposable HOME; nothing touches the real home.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('./spawn-hook.js');
const { makeHome } = require('./fixtures.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CORE = require(path.join(PLUGIN, 'hooks', 'verify-first-core.js'));
const SID = 'ct-session-0001';
const FLAG = ['--host=claude'];
// 64-char representative root, as the injection profile uses.
const REP_ROOT = '/home/user/.claude/plugins/cache/anti-hall/anti-hall/0.100.0'.padEnd(64, 'x');

const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const normRoot = (t) => String(t).split(CORE.PLUGIN_ROOT).join(REP_ROOT);
const isFull = (t) => /ORCHESTRATION DISCIPLINE/.test(t);
const isCompact = (t) => /ORCHESTRATION \(main thread/.test(t);

// A HOME with a Claude-style transcript at <home>/.claude/projects/-tmp-p/<sid>.jsonl.
function claudeHome() {
  const h = makeHome();
  const dir = path.join(h.home, '.claude', 'projects', '-tmp-p');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(transcript, '');
  return Object.assign(h, { transcript, projects: path.join(h.home, '.claude', 'projects') });
}

function sessionPayload(h, extra) {
  return Object.assign({ hook_event_name: 'SessionStart', source: 'startup', session_id: SID, transcript_path: h.transcript, cwd: h.home }, extra || {});
}

function runOrch(h, payload, opts) {
  const o = opts || {};
  return testHook('verify-first-orch.js', payload, { home: h.home, env: o.env, args: o.noFlag ? [] : FLAG, expectJson: o.expectJson !== false });
}
function runFull(h, payload, opts) {
  const o = opts || {};
  return testHook('verify-first-full.js', payload, { home: h.home, env: o.env, args: o.noFlag ? [] : FLAG, expectJson: true });
}
function runSpawn(h, payload, opts) {
  const o = opts || {};
  return testHook('orch-on-spawn.js', payload, { home: h.home, env: Object.assign({ ANTIHALL_TEST_ISOLATION: '1' }, o.env) });
}

function spawnPayload(h, extra) {
  return Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: SID, transcript_path: h.transcript, cwd: h.home, tool_input: { description: 'x', prompt: 'y', subagent_type: 'general-purpose' } }, extra || {});
}

function markerOf(h) {
  try { return JSON.parse(fs.readFileSync(path.join(h.home, '.anti-hall', 'orch-full', 'orch-full-' + SID + '.json'), 'utf8')); } catch (_) { return null; }
}
function orchDir(h) { return path.join(h.home, '.anti-hall', 'orch-full'); }

module.exports = { PLUGIN, CORE, SID, FLAG, REP_ROOT, ctxOf, normRoot, isFull, isCompact, claudeHome, sessionPayload, runOrch, runFull, runSpawn, spawnPayload, markerOf, orchDir, os, fs, path };
