#!/usr/bin/env node
// preflight.js — flutter-debug capability probe (skill: /anti-hall:flutter-debug).
//
//   node preflight.js [--scope <local|project|user>] [--project <dir>]
//
// Picks the debug-loop capability TIER for a Flutter project and (the ONLY two
// writes it performs) idempotently registers the dart + marionette MCP servers
// and self-provisions the marionette host CLI. Everything else is read-only.
//
// Contract (house style — mirrors skills/update/scripts/update.js):
//   * Pure Node >= 18 built-ins, cross-platform incl. Windows.
//   * FAIL-OPEN: a probe that cannot run reports "unknown" and the loop degrades;
//     it NEVER hard-fails the whole preflight on a missing optional tool.
//   * fs.writeSync(1, …) for stdout (NOT process.stdout.write): on macOS node
//     18/20 process.exit races the async pipe flush and truncates output.
//   * The exported checks are consumed IN-PROCESS by hooks/doctor.js (one
//     implementation, two entry points — no duplicated logic, no subprocess).
//
// MCP strategy (plan workstream B / FP9 / FP10): NO bundled .mcp.json for
// external servers. Each of dart + marionette is registered with the FP9
// idempotent scope-aware flow: `claude mcp get <name>` → absent everywhere ⇒
// `claude mcp add --scope <chosen>` → present in ANY scope ⇒ SKIP (user entries
// win by precedence; never remove/overwrite). `claude mcp get` output is NOT
// documented machine-parseable — parse defensively; unparsable ⇒ "unknown,
// don't add" (never a blind add, never a false FAIL). The SCOPE is passed in as
// an argument — preflight NEVER prompts (the delegated subagent cannot); the
// SKILL asks once in main context before delegating (plan R4-F1).
//
// Android (plan C check 5 / FP7 BINDING LESSON): resolve $ANDROID_HOME /
// $ANDROID_SDK_ROOT / ~/Library/Android/sdk EXPLICITLY + `flutter doctor`
// cross-check — NEVER bare-PATH probes for emulator/adb (a bare-PATH probe once
// falsely reported "no Android tooling" on a machine with a full SDK + AVD).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Status vocabulary (shared by preflight + doctor)
// ---------------------------------------------------------------------------
const FULL = 'full';   // capability present
const WARN = 'warn';   // works but degraded / recommendation
const FAIL = 'fail';   // capability absent — loop degrades
const INFO = 'info';   // neutral note (optional tier)

// Minimum marionette_mcp host version the cited docs [5] describe.
const MARIONETTE_MIN = '0.4.0';

// ---------------------------------------------------------------------------
// Tiny exec wrapper — injectable for tests (no real CLIs in CI).
// Returns { ok, out, err } and NEVER throws: a missing binary, a non-zero exit,
// or a spawn error all collapse to { ok:false, ... } so every caller can stay
// fail-open without its own try/catch.
// ---------------------------------------------------------------------------
function defaultRun(file, args, opts) {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: (opts && opts.timeout) || 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, (opts && opts.env) || {}),
    });
    return { ok: true, out: String(out), err: '' };
  } catch (e) {
    const err = e && (e.stderr || (e.output && e.output[2]));
    return {
      ok: false,
      out: e && e.stdout ? String(e.stdout) : '',
      err: (err ? String(err) : (e && e.message) || String(e)).trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Version helpers (semver-ish; reused from the update.js house pattern)
// ---------------------------------------------------------------------------
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/(\d+(?:\.\d+){1,3})/);
  if (!m) return null;
  const parts = m[1].split('.').map(n => parseInt(n, 10));
  if (parts.some(n => !Number.isFinite(n))) return null;
  return parts;
}

/** compareVersions(a,b) → -1 / 0 / 1; unparseable sorts as 0.0.0. */
function compareVersions(a, b) {
  const pa = parseVersion(a) || [0];
  const pb = parseVersion(b) || [0];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `claude` CLI discovery — Windows best-effort (R1-F10).
// `claude` on Windows is a `.cmd` shim that execFileSync rejects; try `claude`
// then `claude.cmd`. We do NOT shell-resolve (no `where`/`command -v`): we just
// try each candidate name and let defaultRun's catch decide. The first that
// answers `--version`-shaped (or any non-spawn-error) wins.
// ---------------------------------------------------------------------------
function claudeCandidates() {
  return process.platform === 'win32' ? ['claude', 'claude.cmd'] : ['claude'];
}

/**
 * runClaude(args, run) → { ok, out, err, bin }
 * Tries each candidate name; returns the first invocation that did not fail
 * with a spawn-level error (ENOENT). A binary that ran but exited non-zero is a
 * REAL answer (e.g. `mcp get <absent>` exits non-zero) and is returned as-is.
 */
function runClaude(args, run) {
  const r = run || defaultRun;
  let last = { ok: false, out: '', err: 'claude not found', bin: null };
  for (const bin of claudeCandidates()) {
    const res = r(bin, args);
    // ENOENT / "not recognized" ⇒ this candidate name doesn't exist; try next.
    if (!res.ok && /ENOENT|not recognized|not found|No such file/i.test(res.err)) {
      last = Object.assign({}, res, { bin: null });
      continue;
    }
    return Object.assign({}, res, { bin });
  }
  return last;
}

// ===========================================================================
// CHECK 1 — Dart / Flutter toolchain
// ===========================================================================
/**
 * checkDart(run) → { id, status, version, message }
 *   dart >= 3.12 ⇒ FULL (zero-config Agentic Hot Reload [3]);
 *   3.9 – 3.11   ⇒ WARN (server shipped with 3.9 [4][1]; manual DTD-URI handling
 *                  possible; recommend 3.12) (R1-F6);
 *   < 3.9 / missing ⇒ FAIL.
 */
function checkDart(run) {
  const r = run || defaultRun;
  const res = r('dart', ['--version']);
  if (!res.ok) {
    return {
      id: 'dart',
      status: FAIL,
      version: null,
      message: 'dart not found — install Dart/Flutter SDK >= 3.12 (the Dart MCP server is required for the debug loop)',
    };
  }
  // `dart --version` prints to stderr on some channels; check both.
  const text = (res.out || '') + (res.err || '');
  const ver = parseVersion(text);
  const verStr = ver ? ver.join('.') : '(unparsed)';
  const flutter = r('flutter', ['--version']);
  const flutterNote = flutter.ok ? '' : ' (flutter CLI not detected on PATH)';
  if (!ver) {
    return { id: 'dart', status: WARN, version: null, message: 'dart present but version unparsed — recommend >= 3.12' + flutterNote };
  }
  if (compareVersions(verStr, '3.12.0') >= 0) {
    return { id: 'dart', status: FULL, version: verStr, message: 'dart ' + verStr + ' — zero-config Agentic Hot Reload [3]' + flutterNote };
  }
  if (compareVersions(verStr, '3.9.0') >= 0) {
    return {
      id: 'dart',
      status: WARN,
      version: verStr,
      message: 'dart ' + verStr + ' — loop works; DTD URI may need a manual copy [4][3]. Recommend upgrading to >= 3.12' + flutterNote,
    };
  }
  return { id: 'dart', status: FAIL, version: verStr, message: 'dart ' + verStr + ' < 3.9 — upgrade to >= 3.12 (Dart MCP server unavailable below 3.9)' };
}

// ===========================================================================
// CHECK 2 — MCP registration (FP9 idempotent scope-aware add)
// ===========================================================================
/**
 * parseMcpGet(text) → 'present' | 'absent' | 'unknown'
 * `claude mcp get` output is NOT documented machine-parseable (FP9) — parse
 * DEFENSIVELY. A clearly-present marker ⇒ 'present'; a clearly-absent marker ⇒
 * 'absent'; anything else ⇒ 'unknown' (caller does NOT add — "unknown, don't
 * add").
 */
function parseMcpGet(name, res) {
  // A spawn-level failure to even run claude ⇒ unknown.
  if (res == null) return 'unknown';
  const text = ((res.out || '') + '\n' + (res.err || '')).toLowerCase();
  if (!text.trim()) return res.ok ? 'unknown' : 'absent';
  // Absent shapes: claude prints a "No MCP server found" / "not found" line and
  // typically exits non-zero.
  if (/no mcp server|not found|no server|does not exist|couldn't find|could not find/.test(text)) return 'absent';
  // Present shapes: the server name echoed with config detail (scope/command/
  // transport/status). Require the name AND a config-ish token to avoid matching
  // an error that merely echoes the name.
  if (text.includes(String(name).toLowerCase()) &&
      /(scope|command|transport|type|status|stdio|connected|args)/.test(text)) {
    return 'present';
  }
  // claude ran cleanly (exit 0) and echoed something we can't classify ⇒ unknown.
  return 'unknown';
}

/**
 * registerServer(name, addArgs, scope, run) → { name, action, status, message }
 * FP9 idempotent flow for ONE server. action ∈
 *   'present' | 'added' | 'skip-unknown' | 'add-failed' | 'cli-unavailable'.
 * NEVER removes/overwrites; a same-scope duplicate add hard-errors (atomic), so
 * add-if-absent is naturally safe. Best-effort spawn (Windows .cmd); any
 * spawn/parse failure ⇒ a manual-verify note, never a false FAIL, never a blind add.
 */
function registerServer(name, addArgs, scope, run) {
  const r = run || defaultRun;
  const got = runClaude(['mcp', 'get', name], r);
  // Could not run claude at all (no candidate resolved) ⇒ manual note.
  if (got.bin == null && !got.ok && /not found|ENOENT/i.test(got.err || '')) {
    return {
      name,
      action: 'cli-unavailable',
      status: WARN,
      message: 'could not query/modify MCP registration for "' + name + '" — claude CLI not reachable; verify/register manually',
    };
  }
  const state = parseMcpGet(name, got);
  if (state === 'present') {
    return { name, action: 'present', status: FULL, message: name + ' MCP already registered — skipping (user entries win by precedence)' };
  }
  if (state === 'unknown') {
    return {
      name,
      action: 'skip-unknown',
      status: WARN,
      message: 'could not determine MCP registration state for "' + name + '" (unparsable `claude mcp get` output) — not adding; verify manually',
    };
  }
  // absent everywhere ⇒ add in the chosen scope.
  const sc = (scope === 'project' || scope === 'user') ? scope : 'local'; // CLI default = local (FP9)
  const args = ['mcp', 'add', '--scope', sc].concat(addArgs);
  const added = runClaude(args, r);
  if (added.ok) {
    return {
      name,
      action: 'added',
      status: FULL,
      message: name + ' MCP registered (--scope ' + sc + ') — restart Claude Code to surface its tools (/reload-plugins may suffice)',
    };
  }
  // A same-scope duplicate add hard-errors ("Server already exists") — that is a
  // benign race (someone added it between our get and add), treat as present.
  if (/already exists/i.test(added.err || '')) {
    return { name, action: 'present', status: FULL, message: name + ' MCP already registered (concurrent add) — skipping' };
  }
  return {
    name,
    action: 'add-failed',
    status: WARN,
    message: 'could not register "' + name + '" MCP (' + (added.err || 'unknown error') + ') — register manually: claude ' + args.join(' '),
  };
}

/**
 * checkMcpRegistration(scope, run) → { id, status, servers:[…], message }
 * Registers dart + marionette via the FP9 flow. Aggregate status = FAIL only if
 * the REQUIRED dart server could neither be confirmed present nor added; the
 * marionette outcome only ever WARNs (visual tier degrades, loop still runs).
 */
function checkMcpRegistration(scope, run) {
  const dart = registerServer('dart', ['--transport', 'stdio', 'dart', '--', 'dart', 'mcp-server'], scope, run);
  const marionette = registerServer('marionette', ['marionette', '--', 'marionette_mcp'], scope, run);
  const servers = [dart, marionette];
  // dart must end up present/added; cli-unavailable/unknown is a WARN (manual path).
  let status = FULL;
  if (dart.action === 'add-failed') status = FAIL;
  else if (dart.action !== 'present' && dart.action !== 'added') status = WARN;
  if (status === FULL && marionette.action !== 'present' && marionette.action !== 'added') status = WARN;
  return {
    id: 'mcp',
    status,
    servers,
    scope: (scope === 'project' || scope === 'user') ? scope : 'local',
    message: servers.map(s => '• ' + s.message).join('\n'),
  };
}

// ===========================================================================
// CHECK 3 — marionette host CLI + app-side integration
// ===========================================================================
/**
 * pubCacheBinDir(opts) → the `bin` dir Dart drops global-package wrappers into.
 * `$PUB_CACHE/bin` if set, else `~/.pub-cache/bin` (POSIX) / `%LOCALAPPDATA%\Pub\
 * Cache\bin` (Windows, best-effort). Used for the F-PATH-01 PATH-resolution warn.
 */
function pubCacheBinDir(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const home = opts.homedir || os.homedir();
  if (env.PUB_CACHE) return path.join(env.PUB_CACHE, 'bin');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'Pub', 'Cache', 'bin');
  }
  return path.join(home, '.pub-cache', 'bin');
}

/**
 * marionetteBinResolves(f, opts) → bool. True if the freshly-activated
 * marionette wrapper actually resolves — either as a file under the pub-cache
 * bin dir, OR somewhere on $PATH. A successful `dart pub global activate` does
 * NOT imply either (the pub-cache bin dir is often not on PATH), so we check.
 */
function marionetteBinResolves(f, opts) {
  opts = opts || {};
  const fimpl = f || fs;
  const env = opts.env || process.env;
  const exe = process.platform === 'win32' ? ['.bat', '.exe', ''] : [''];
  // 1) the canonical pub-cache bin dir.
  const binDir = pubCacheBinDir(opts);
  for (const ext of exe) {
    try { if (fimpl.statSync(path.join(binDir, 'marionette_mcp' + ext)).isFile()) return true; } catch (_) {}
  }
  // 2) anywhere on $PATH.
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || '').split(sep).filter(Boolean)) {
    for (const ext of exe) {
      try { if (fimpl.statSync(path.join(dir, 'marionette_mcp' + ext)).isFile()) return true; } catch (_) {}
    }
  }
  return false;
}

/** fsImplFor(opts) → the injected fs (tests) or the real fs. */
function fsImplFor(opts) { return (opts && opts.fsImpl) || fs; }

/**
 * checkMarionetteHost(run, opts) → { id, status, version, action, message }
 * Host CLI on PATH + version >= 0.4.0 (lenient parse). AUTO-FIX: if missing, run
 * `dart pub global activate marionette_mcp`. After a successful activate, VERIFY
 * the wrapper actually resolves (F-PATH-01) — WARN with the manual PATH fix if
 * not. A failed activate degrades to a note (loop still runs via coordinate
 * fallback). opts carries fsImpl/env/homedir (injectable for tests).
 */
function checkMarionetteHost(run, opts) {
  const r = run || defaultRun;
  opts = opts || {};
  // `dart pub global list` is the authoritative version source (FP6 note in the
  // probe record: a stale wrapper-file reading is NOT authoritative).
  const list = r('dart', ['pub', 'global', 'list']);
  const present = list.ok && /marionette_mcp\s+\d/i.test(list.out || '');
  if (present) {
    const m = (list.out || '').match(/marionette_mcp\s+(\d[\d.]*)/i);
    const ver = m ? m[1] : null;
    if (ver && compareVersions(ver, MARIONETTE_MIN) < 0) {
      return {
        id: 'marionette-host',
        status: WARN,
        version: ver,
        action: 'present-old',
        message: 'marionette_mcp ' + ver + ' < ' + MARIONETTE_MIN + ' — upgrade: dart pub global activate marionette_mcp',
      };
    }
    return { id: 'marionette-host', status: FULL, version: ver, action: 'present', message: 'marionette_mcp ' + (ver || 'present') + ' (host CLI) [5]' };
  }
  // Auto-fix: self-provision the host CLI.
  const act = r('dart', ['pub', 'global', 'activate', 'marionette_mcp']);
  if (act.ok) {
    // F-PATH-01: a successful `activate` does NOT guarantee the binary is on
    // PATH — `~/.pub-cache/bin` is frequently absent from PATH on a fresh setup,
    // so the freshly-activated `marionette_mcp` won't resolve and the MCP server
    // launch would silently fail. Verify the wrapper actually resolves; if not,
    // WARN with the exact manual PATH fix line (fail-open — never hard-fail).
    const resolved = marionetteBinResolves(fsImplFor(opts), opts);
    if (!resolved) {
      const binDir = pubCacheBinDir(opts);
      return {
        id: 'marionette-host',
        status: WARN,
        version: null,
        action: 'provisioned-not-on-path',
        message: 'marionette_mcp activated but its wrapper is not on PATH (expected in ' + binDir + ') — '
          + 'add it: export PATH="$PATH":"' + binDir + '" (or set $PUB_CACHE/bin); '
          + 'then re-run the flutter-debug skill [5]',
      };
    }
    return { id: 'marionette-host', status: FULL, version: null, action: 'provisioned', message: 'marionette_mcp host CLI auto-provisioned (dart pub global activate marionette_mcp) [5]' };
  }
  return {
    id: 'marionette-host',
    status: WARN,
    version: null,
    action: 'absent',
    message: 'marionette_mcp host CLI absent and auto-provision failed (' + (act.err || 'no dart') + ') — semantic taps unavailable; coordinate fallback applies',
  };
}

/**
 * checkMarionetteApp(projectDir) → { id, status, integrated, message }
 * Read-only: does the target pubspec.yaml list marionette_flutter? If not, the
 * skill AUTO-APPLIES it (plan B) — preflight only REPORTS, it does not edit the
 * user's app (that write lives in the skill, where the git-diff is shown).
 */
function checkMarionetteApp(projectDir, fsImpl) {
  const f = fsImpl || fs;
  const pubspec = path.join(projectDir || '.', 'pubspec.yaml');
  let text = '';
  try { text = f.readFileSync(pubspec, 'utf8'); } catch (_) { text = ''; }
  const integrated = /^\s*marionette_flutter\s*:/m.test(text);
  if (integrated) {
    return { id: 'marionette-app', status: FULL, integrated: true, message: 'app integrates marionette_flutter (semantic taps available) [5]' };
  }
  return {
    id: 'marionette-app',
    status: INFO,
    integrated: false,
    message: 'app does not list marionette_flutter — the skill auto-applies it (regular dependency + kDebugMode init; git diff shown) or uses the coordinate fallback',
  };
}

// ===========================================================================
// CHECK 4 — iOS simulator (macOS, SUPPLEMENT tier)
// ===========================================================================
function checkIos(run) {
  const r = run || defaultRun;
  if (process.platform !== 'darwin') {
    return { id: 'ios', status: INFO, message: 'not macOS — iOS simulator tier not applicable' };
  }
  const booted = r('xcrun', ['simctl', 'list', 'devices', 'booted']);
  const haveBooted = booted.ok && /\(Booted\)/.test(booted.out || '');
  const idb = r('idb', ['--version']);
  const haveIdb = idb.ok;
  const parts = [];
  parts.push(haveBooted ? 'booted iOS simulator present' : 'no booted iOS simulator (boot one for iOS visual control)');
  parts.push(haveIdb ? 'idb reachable [9][10] (ios-simulator-mcp supplement available)' : 'idb not found — ios-simulator-mcp supplement unavailable (brew tap facebook/fb && brew install idb-companion) [9]');
  return { id: 'ios', status: haveBooted ? FULL : INFO, booted: haveBooted, idb: haveIdb, message: parts.join('; ') };
}

// ===========================================================================
// CHECK 5 — Android (FP7 BINDING LESSON: explicit SDK paths, NEVER bare PATH)
// ===========================================================================
/**
 * resolveAndroidSdk(env, homedir, fsImpl) → { sdkRoot, source } | { sdkRoot:null }
 * Resolve the SDK from $ANDROID_HOME → $ANDROID_SDK_ROOT → ~/Library/Android/sdk
 * (macOS) / ~/Android/Sdk (linux/win default) — EXPLICITLY, never a bare-PATH
 * `which adb` (a bare-PATH probe once false-negatived a full SDK + AVD — FP7).
 */
function resolveAndroidSdk(env, homedir, fsImpl) {
  const e = env || {};
  const f = fsImpl || fs;
  const home = homedir || os.homedir();
  const candidates = [
    e.ANDROID_HOME ? { p: e.ANDROID_HOME, source: '$ANDROID_HOME' } : null,
    e.ANDROID_SDK_ROOT ? { p: e.ANDROID_SDK_ROOT, source: '$ANDROID_SDK_ROOT' } : null,
    { p: path.join(home, 'Library', 'Android', 'sdk'), source: '~/Library/Android/sdk' },
    { p: path.join(home, 'Android', 'Sdk'), source: '~/Android/Sdk' },
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (f.statSync(c.p).isDirectory()) return { sdkRoot: c.p, source: c.source };
    } catch (_) { /* next */ }
  }
  return { sdkRoot: null, source: null };
}

/**
 * checkAndroid(opts) → { id, status, sdkRoot, message }
 * Reports SDK / adb / emulator / AVDs via the EXPLICITLY-resolved SDK paths +
 * a `flutter doctor` cross-check. Never a bare-PATH probe. INFO/WARN only — an
 * absent Android SDK never fails the (iOS-capable) preflight.
 */
function checkAndroid(opts) {
  opts = opts || {};
  const run = opts.run || defaultRun;
  const f = opts.fsImpl || fs;
  const { sdkRoot, source } = resolveAndroidSdk(opts.env || process.env, opts.homedir || os.homedir(), f);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bat = process.platform === 'win32' ? '.bat' : '';
  const parts = [];
  let status = INFO;

  if (sdkRoot) {
    parts.push('Android SDK at ' + sdkRoot + ' (' + source + ')');
    // adb / emulator resolved UNDER the SDK root — never bare PATH.
    const adb = path.join(sdkRoot, 'platform-tools', 'adb' + exe);
    const emulator = path.join(sdkRoot, 'emulator', 'emulator' + exe);
    let haveAdb = false, haveEmu = false;
    try { haveAdb = f.statSync(adb).isFile(); } catch (_) {}
    try { haveEmu = f.statSync(emulator).isFile(); } catch (_) {}
    parts.push(haveAdb ? 'adb present' : 'adb missing under platform-tools/');
    parts.push(haveEmu ? 'emulator present' : 'emulator missing under emulator/');
    // AVDs from ~/.android/avd/*.ini (explicit, not a bare `emulator -list-avds`).
    try {
      const avdDir = path.join(opts.homedir || os.homedir(), '.android', 'avd');
      const avds = f.readdirSync(avdDir).filter(n => /\.ini$/.test(n)).map(n => n.replace(/\.ini$/, ''));
      parts.push(avds.length ? 'AVDs: ' + avds.join(', ') : 'no AVDs defined');
    } catch (_) { parts.push('no AVDs defined'); }
  } else {
    status = INFO;
    parts.push('no Android SDK at $ANDROID_HOME/$ANDROID_SDK_ROOT/~/Library/Android/sdk (Android target optional)');
  }

  // flutter doctor cross-check (authoritative — FP7 lesson). Best-effort.
  const fd = run('flutter', ['doctor']);
  if (fd.ok) {
    const text = fd.out || '';
    if (/Android toolchain[\s\S]*?\[(✓|√|!)\]|\[(✓|√|!)\][^\n]*Android toolchain/.test(text) || /Android toolchain/.test(text)) {
      const green = /\[(✓|√)\][^\n]*Android toolchain|Android toolchain[\s\S]{0,80}?(✓|√)/.test(text);
      parts.push('flutter doctor: Android toolchain ' + (green ? 'green' : 'present (see flutter doctor for detail)'));
    }
  }
  // Honesty: marionette taps/screenshots VERIFIED on Android emulator (FP7 2026-06-11).
  // Scope boundary: one AVD / android_arm64; physical device / other arch not yet probed.
  parts.push('run/reload/error-reading + marionette taps/screenshots VERIFIED on Android emulator [2] (FP7 2026-06-11 — one AVD / android_arm64; physical device unprobed)');
  return { id: 'android', status, sdkRoot, message: parts.join('; ') };
}

// ===========================================================================
// CHECK 6 — Project sanity (pubspec.yaml present in the target dir)
// ===========================================================================
function checkProject(projectDir, fsImpl) {
  const f = fsImpl || fs;
  const pubspec = path.join(projectDir || '.', 'pubspec.yaml');
  let ok = false;
  try { ok = f.statSync(pubspec).isFile(); } catch (_) { ok = false; }
  return ok
    ? { id: 'project', status: FULL, message: 'pubspec.yaml found — Flutter project detected' }
    : { id: 'project', status: FAIL, message: 'no pubspec.yaml in ' + (projectDir || '.') + ' — not a Flutter project root' };
}

// ===========================================================================
// Degradation table (printed by preflight AND stated verbatim in SKILL.md)
// Plan workstream C — each row's "Skill says" text is the honest contract.
// ===========================================================================
const DEGRADATION_ROWS = [
  {
    missing: 'Dart MCP',
    degradesTo: 'STOP — no reload/error reading; print install step',
    skillSays: 'refuse to claim debug-loop capability',
  },
  {
    missing: 'dart 3.9–3.11',
    degradesTo: 'loop works; DTD URI may need manual copy [4][3]',
    skillSays: 'WARN + upgrade recommendation',
  },
  {
    missing: 'marionette (host or app-side)',
    degradesTo: 'ios-simulator-mcp fallback: coordinate taps + screenshots [10], FP2 caveat (marionette = PRIMARY per owner directive, overriding KB §5)',
    skillSays: 'semantic taps unavailable — coordinate fallback',
  },
  {
    missing: 'marionette missing AND flutter_driver_command considered',
    degradesTo: 'flutter_driver_command path REQUIRES an in-app `enableFlutterDriverExtension()` before runApp (FP1b NEGATIVE — probe record): same invasiveness class as marionette, which is strictly richer (the only semantic input/screenshot route). widget_inspector tree inspection still works WITHOUT the extension; driver tap/screenshot do NOT',
    skillSays: 'driver-command tap/screenshot needs an app-side extension edit — marionette is the only semantic input/screenshot path; inspection-only works without it',
    gated: 'FP1b',
  },
  {
    missing: 'both visual MCPs (and FP1b false/unprobed)',
    degradesTo: 'error-driven loop only (get_runtime_errors/widget_inspector [2]); NO visual verification',
    skillSays: 'cannot visually verify — evidence is runtime-error state only',
  },
  {
    missing: 'lifecycle tools (disabled by default [2])',
    degradesTo: 'user runs flutter run --print-dtd; agent connects dtd→listDtdUris→connect [2]',
    skillSays: 'get_app_logs unavailable on this path (loop step 3)',
  },
  {
    missing: 'Android target',
    degradesTo: 'run/reload/errors/taps/screenshots work today [2]; marionette taps + screenshots VERIFIED on Android emulator (FP7 2026-06-11 — one AVD / android_arm64; physical device / other arch not yet probed)',
    skillSays: 'Android visual status = FP7 VERIFIED (emulator; one arch); physical device unprobed',
  },
];

function renderDegradationTable() {
  const lines = ['Degradation table (missing → loop degrades to → skill says):'];
  for (const row of DEGRADATION_ROWS) {
    lines.push('  • ' + row.missing + (row.gated ? ' [gated on ' + row.gated + ']' : ''));
    lines.push('      → ' + row.degradesTo);
    lines.push('      skill says: "' + row.skillSays + '"');
  }
  return lines.join('\n');
}

// ===========================================================================
// Orchestration — run all checks (exported for doctor.js to call in-process)
// ===========================================================================
/**
 * runAllChecks(opts) → { results:[…], tier, summary }
 * opts: { scope, projectDir, run, fsImpl, env, homedir, skipRegistration }
 *   - scope: passed straight to the FP9 add (NEVER prompted here).
 *   - skipRegistration: doctor sets this true (a read-only health check must not
 *     perform the two write side-effects); preflight leaves it false.
 */
function runAllChecks(opts) {
  opts = opts || {};
  const run = opts.run || defaultRun;
  const fsImpl = opts.fsImpl || fs;
  const projectDir = opts.projectDir || process.cwd();

  const results = [];
  results.push(checkProject(projectDir, fsImpl));
  results.push(checkDart(run));
  if (opts.skipRegistration) {
    // Doctor: read-only — query state without adding (re-uses parseMcpGet).
    const dartGet = parseMcpGet('dart', runClaude(['mcp', 'get', 'dart'], run));
    const marGet = parseMcpGet('marionette', runClaude(['mcp', 'get', 'marionette'], run));
    results.push({
      id: 'mcp',
      status: dartGet === 'present' ? FULL : WARN,
      readonly: true,
      message: 'dart MCP: ' + dartGet + '; marionette MCP: ' + marGet + ' (read-only — run the flutter-debug skill to auto-register)',
    });
  } else {
    results.push(checkMcpRegistration(opts.scope, run));
  }
  results.push(checkMarionetteHost(opts.skipRegistration ? readOnlyRun(run) : run, { fsImpl, env: opts.env, homedir: opts.homedir }));
  results.push(checkMarionetteApp(projectDir, fsImpl));
  results.push(checkIos(run));
  results.push(checkAndroid({ run, fsImpl, env: opts.env, homedir: opts.homedir }));

  const tier = pickTier(results);
  return { results, tier, summary: tier.summary };
}

/**
 * readOnlyRun(run) → a wrapped runner that BLOCKS the marionette auto-fix
 * (`dart pub global activate`) so doctor stays read-only. The version-LIST probe
 * still runs; only the activate write is suppressed.
 */
function readOnlyRun(run) {
  const r = run || defaultRun;
  return function (file, args, optsX) {
    if (file === 'dart' && Array.isArray(args) && args[0] === 'pub' && args.includes('activate')) {
      return { ok: false, out: '', err: 'read-only mode: marionette auto-provision suppressed (run the flutter-debug skill to provision)' };
    }
    return r(file, args, optsX);
  };
}

/**
 * pickTier(results) → { tier, summary }
 * The capability tier the loop announces (plan D step 0). dart FAIL or project
 * FAIL ⇒ blocked; otherwise the visual tier is derived from the marionette/iOS
 * results.
 */
function pickTier(results) {
  const byId = {};
  for (const r of results) byId[r.id] = r;
  if (byId.project && byId.project.status === FAIL) {
    return { tier: 'blocked', summary: 'BLOCKED — not a Flutter project (no pubspec.yaml)' };
  }
  if (byId.dart && byId.dart.status === FAIL) {
    return { tier: 'blocked', summary: 'BLOCKED — Dart MCP prerequisite missing; cannot claim the debug loop' };
  }
  const marHostOk = byId['marionette-host'] && byId['marionette-host'].status === FULL;
  const marAppOk = byId['marionette-app'] && byId['marionette-app'].integrated === true;
  if (marHostOk && marAppOk) {
    return { tier: 'full-visual', summary: 'FULL — semantic taps + screenshots (marionette) + reload/error loop' };
  }
  const iosOk = byId.ios && byId.ios.idb === true;
  if (iosOk) {
    return { tier: 'coordinate-visual', summary: 'COORDINATE — ios-simulator-mcp taps + screenshots; semantic taps unavailable' };
  }
  return { tier: 'error-only', summary: 'ERROR-ONLY — reload + runtime-error loop; cannot visually verify (no visual MCP)' };
}

// ===========================================================================
// CLI entrypoint
// ===========================================================================
function parseArgs(argv) {
  const out = { scope: 'local', projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope' && argv[i + 1]) { out.scope = argv[++i]; }
    else if (argv[i] === '--project' && argv[i + 1]) { out.projectDir = argv[++i]; }
  }
  return out;
}

function renderReport(report, scope) {
  const lines = [];
  lines.push('flutter-debug preflight');
  lines.push('  scope (MCP add): ' + scope);
  lines.push('');
  for (const r of report.results) {
    const mark = r.status === FAIL ? '✗' : r.status === WARN ? '!' : r.status === INFO ? '·' : '✓';
    lines.push('  ' + mark + ' [' + r.id + '] ' + String(r.message).replace(/\n/g, '\n      '));
  }
  lines.push('');
  lines.push('  TIER: ' + report.tier.tier + ' — ' + report.tier.summary);
  lines.push('');
  lines.push(renderDegradationTable());
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let report;
  try {
    report = runAllChecks({ scope: args.scope, projectDir: args.projectDir });
  } catch (e) {
    // Fail-open: a crash in any probe must not block the skill — report + exit 0.
    fs.writeSync(1, 'flutter-debug preflight: probe error (fail-open) — ' + (e && e.message) + '\n');
    process.exit(0);
    return;
  }
  // fs.writeSync(1, …) NOT process.stdout.write — macOS node 18/20 exit/flush race.
  fs.writeSync(1, JSON.stringify({ tier: report.tier.tier, summary: report.tier.summary, scope: args.scope }) + '\n');
  fs.writeSync(1, renderReport(report, args.scope) + '\n');
  // Fail-open contract: exit 0 even on a blocked tier — the report carries the
  // verdict; the skill decides what to do (it never relies on the exit code).
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  // status vocabulary
  FULL, WARN, FAIL, INFO,
  // version helpers
  parseVersion, compareVersions,
  // claude CLI discovery
  claudeCandidates, runClaude, parseMcpGet,
  // checks (consumed in-process by hooks/doctor.js)
  checkDart,
  registerServer, checkMcpRegistration,
  checkMarionetteHost, checkMarionetteApp,
  pubCacheBinDir, marionetteBinResolves,
  checkIos,
  resolveAndroidSdk, checkAndroid,
  checkProject,
  // degradation + orchestration
  DEGRADATION_ROWS, renderDegradationTable,
  runAllChecks, pickTier, readOnlyRun,
  renderReport,
};
