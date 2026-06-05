'use strict';
// graphify-session (SessionStart hook). When the project has a graphify graph
// (graphify-out/ or .planning/graphs/ under cwd or git toplevel) it injects
// hookSpecificOutput.additionalContext telling the model to QUERY THE GRAPH
// FIRST, naming the graph dir. Safe no-op (exit 0, no additionalContext) when no
// graph exists. JSON is built via JSON.stringify, so a graph path containing `"`
// or `\` must still yield VALID JSON (F-10).
//
// Graph presence is faked via a temp PROJECT dir used as the payload cwd that
// contains a graphify-out/ directory. The temp dir is created under os.tmpdir()
// (not a git repo) so gitToplevel() returns null and the only graph root checked
// is our controlled cwd — neither this repo nor the real machine is touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'graphify-session.js';

// makeProject({ graph, suffix }) -> { dir, cleanup }. A disposable temp dir used
// as the hook's cwd. When graph:true a graphify-out/ subdir is created. `suffix`
// lets a caller embed tricky characters (e.g. a quote/backslash) in the dir name.
function makeProject({ graph, suffix }) {
  let base = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-sess-'));
  if (suffix) {
    const tricky = base + suffix;
    fs.mkdirSync(tricky, { recursive: true });
    base = tricky;
  }
  if (graph) fs.mkdirSync(path.join(base, 'graphify-out'), { recursive: true });
  return { dir: base, cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} } };
}

function sessionPayload(cwd) {
  return { hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('INJECT: graph exists -> additionalContext present (JSON parses) and names the graph dir', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be valid JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart', 'echoes SessionStart event');
    const c = ctx(r);
    assert.ok(c.length > 0, 'additionalContext must be non-empty');
    assert.ok(c.includes('GRAPHIFY-FIRST PROTOCOL'), 'mentions the GRAPHIFY-FIRST protocol');
    // Names the graph dir. sanitizePath truncates the reflected path to 80 chars
    // + ellipsis (a deliberate cap), so on hosts with a long os.tmpdir() (e.g.
    // macOS CI's /var/folders/.../T) the trailing 'graphify-out' leaf is cut off.
    // Assert on the project BASE dir name instead — it always lands within the
    // first 80 chars (the mkdtemp prefix sits well before the cap) and proves the
    // graph dir is reflected without depending on the host's tmpdir length.
    const baseName = path.basename(proj.dir);
    assert.ok(c.includes(baseName), `additionalContext must name the graph dir; ctx=${c}`);
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('NO-OP: no graph -> empty output, no additionalContext injected', () => {
  const h = makeHome();
  const proj = makeProject({ graph: false });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout (no injection); got: ${r.stdout}`);
    assert.strictEqual(ctx(r), '', 'no additionalContext when no graph');
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('F-10: graph path with a quote (") -> output is still valid JSON (no corruption)', () => {
  const h = makeHome();
  // Embed a literal double-quote in the project dir name. JSON.stringify must
  // escape it so stdout parses; a naive string concat would corrupt the JSON.
  // win32: a double-quote is an ILLEGAL filename char (mkdir throws ENOENT), so
  // this path-with-a-quote scenario cannot exist on Windows — skip there. The
  // JSON-escaping guarantee is still exercised on POSIX by this test and by the
  // backslash test below.
  if (process.platform === 'win32') return;
  const proj = makeProject({ graph: true, suffix: 'q"uote' });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0');
    // The load-bearing assertion: stdout PARSES (testHook sets json only if so).
    assert.ok(r.json, `stdout must be valid JSON despite a quote in the path; stdout=${r.stdout}`);
    assert.ok(ctx(r).length > 0, 'additionalContext present');
    assert.ok(ctx(r).includes('GRAPHIFY-FIRST PROTOCOL'), 'protocol intact, not corrupted');
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('F-10: graph path with a backslash (\\) -> output is still valid JSON (no corruption)', () => {
  const h = makeHome();
  // Embed a literal backslash in the project dir name. On win32 a backslash is a
  // path separator so skip there; on POSIX it is a valid filename char and
  // exercises JSON.stringify backslash-escaping.
  if (process.platform === 'win32') return;
  const proj = makeProject({ graph: true, suffix: 'back\\slash' });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be valid JSON despite a backslash in the path; stdout=${r.stdout}`);
    assert.ok(ctx(r).length > 0, 'additionalContext present');
    assert.ok(ctx(r).includes('GRAPHIFY-FIRST PROTOCOL'), 'protocol intact, not corrupted');
  } finally {
    proj.cleanup();
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0 (cwd falls back; no crash)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});
