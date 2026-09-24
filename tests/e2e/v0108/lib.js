'use strict';
// tests/e2e/v0108/lib.js — shared scaffolding for the v0.108.0 end-to-end
// scenario suite. Every helper here is HOME-isolated: nothing reads or writes
// the real machine's ~/.anti-hall, and no test spawns anything that installs
// launchd/systemd units, calls the network, or touches this checkout's git
// state. Hooks/scripts are exercised as REAL subprocesses (spawnSync), the
// same way Claude Code invokes them, with a fixture HOME.
//
// Every v0.108.0 feature this suite covers is integrated, so no test is
// gated or skipped. Exception to "nothing installs companions": the
// repair-on-reload tests let the hook spawn its real detached
// `doctor.js --repair` against the fixture HOME (the installers dry-run under
// a tmp HOME, and a fresh fixture home has the DevSwarm install gate closed);
// each such test kills the child it started.
//
// See tests/e2e/v0108/README.md for the scenario -> requirement map.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'anti-hall');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'hooks');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');

// makeHome() -> fresh temp HOME with <home>/.anti-hall created. Always
// cleaned up by the caller's finally block.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-e2e-v0108-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

function antiHallDir(home) { return path.join(home, '.anti-hall'); }
function settingsPath(home) { return path.join(antiHallDir(home), 'settings.json'); }
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// isolatedEnv(home, extra) — controlled child env: PATH + HOME only, plus
// whatever the caller explicitly asks for. Nothing else leaks in.
function isolatedEnv(home, extra) {
  return Object.assign({ PATH: process.env.PATH, HOME: home }, extra || {});
}

// runHook(hookFile, payload, home, extraEnv) -> { status, stdout, stderr, json }
// Spawns a REAL hook script from plugins/anti-hall/hooks with JSON on stdin,
// exactly as Claude Code's hook dispatcher does.
function runHook(hookFile, payload, home, extraEnv) {
  const hookAbs = path.join(HOOKS_DIR, hookFile);
  const res = spawnSync(process.execPath, [hookAbs], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: isolatedEnv(home, extraEnv),
    timeout: 30000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

// runCliScript(scriptFile, args, home, extraEnv, opts) -> { status, stdout, stderr, json }
// Spawns a REAL CLI script from plugins/anti-hall/scripts with argv, exactly
// as a user or /anti-hall:* skill invokes it.
function runCliScript(scriptFile, args, home, extraEnv, opts) {
  const scriptAbs = path.join(SCRIPTS_DIR, scriptFile);
  const o = opts || {};
  const res = spawnSync(process.execPath, [scriptAbs, ...args], {
    encoding: 'utf8',
    env: isolatedEnv(home, extraEnv),
    timeout: o.timeout || 30000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

// runMigrationsLib(fnName, args, home) -> { status, stdout, stderr, result }
// Spawns a tiny subprocess that requires the REAL companion/lib/migrations.js
// module and calls one exported function (runSettingsMigration /
// migrateSettingsFromLegacy) with the fixture home. This exercises the exact
// production code path `doctor --repair` and `/anti-hall:update` call, WITHOUT
// going through doctor.js's full repair pass — which also installs/verifies
// launchd/systemd companions (supervisor, ingest daemon, statusline) against
// the REAL machine's login session regardless of a HOME override, since
// launchd operates on the user session, not the $HOME env var. That surface
// is out of scope for this suite and must never run from an automated test.
function runMigrationsLib(fnName, home, extraArgObj) {
  const migrationsPath = path.join(PLUGIN_ROOT, 'companion', 'lib', 'migrations.js');
  const code = `
    const lib = require(${JSON.stringify(migrationsPath)});
    const result = lib.${fnName}(${JSON.stringify(home)}, ${JSON.stringify(extraArgObj || {})});
    process.stdout.write(JSON.stringify(result));
  `;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: isolatedEnv(home),
    timeout: 15000,
  });
  let result = null;
  try { result = JSON.parse(res.stdout); } catch (_) { result = null; }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', result };
}

// buildTranscriptLine helpers for auto-handover fixtures (main-thread vs
// sidechain assistant usage entries), matching the Claude Code transcript
// JSONL shape auto-handover.js parses.
function mainAssistantUsageLine({ inputTokens, outputTokens, cacheReadTokens, model, ts }) {
  return {
    type: 'assistant',
    timestamp: ts || new Date().toISOString(),
    message: {
      role: 'assistant',
      model: model || 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: outputTokens || 0,
        cache_read_input_tokens: cacheReadTokens || 0,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
    isSidechain: false,
  };
}
function sidechainAssistantUsageLine(opts) {
  const line = mainAssistantUsageLine(opts);
  line.isSidechain = true;
  return line;
}
function writeTranscript(home, lines) {
  const p = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

module.exports = {
  REPO_ROOT, PLUGIN_ROOT, HOOKS_DIR, SCRIPTS_DIR,
  makeHome, rm, antiHallDir, settingsPath, readJson, writeJson,
  isolatedEnv, runHook, runCliScript, runMigrationsLib,
  mainAssistantUsageLine, sidechainAssistantUsageLine, writeTranscript,
};
