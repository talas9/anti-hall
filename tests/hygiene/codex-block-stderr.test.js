'use strict';
// Hygiene: every hook registered in the Codex hooks.json that can exit 2 must
// write a reason to stderr on that path. Codex ignores stdout JSON on exit 2 and
// lets the tool call through when stderr is empty
// (codex-rs/hooks/src/events/pre_tool_use.rs and stop.rs, rust-v0.160.0).
//
// Static rule, per `process.exit(2)` site: one of the few statements just before
// it (comments skipped) writes fd 2 (`fs.writeSync(2, …)` / `process.stderr.write`).
// A block routed through lib/emit-block.js satisfies this inside the helper. Any
// other exit-2 spelling (`process.exit(code)`, `process.exitCode = 2`) fails, so a
// new block path cannot dodge the scan. tests/codex/codex-block-stderr.test.js
// runs the block paths for real.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const HOOKS_JSON = path.join(PLUGIN, 'codex', 'hooks', 'hooks.registry.json');
const LOOKBACK = 4;
const STDERR_RE = /fs\.writeSync\(\s*2\s*,|process\.stderr\.write\(/;

function registeredHookFiles() {
  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const files = new Set();
  for (const groups of Object.values(cfg.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /\$\{PLUGIN_ROOT\}\/(hooks\/[^"\s]+\.js)/.exec(h.command);
        if (m) files.add(m[1]);
      }
    }
  }
  return [...files].sort();
}

// Local modules a hook requires (hooks/lib/*.js and sibling hooks), one level
// deep: an exit 2 inside a helper counts for the hook that calls it.
function localRequires(rel) {
  const src = fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)) {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    const withExt = p.endsWith('.js') ? p : p + '.js';
    if (withExt.startsWith('hooks/') && fs.existsSync(path.join(PLUGIN, withExt))) out.add(withExt);
  }
  return [...out];
}

function violations(rel, src) {
  const lines = (src === undefined ? fs.readFileSync(path.join(PLUGIN, rel), 'utf8') : src).split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/process\.exitCode\s*=\s*2\b/.test(code) || /process\.exit\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code)) {
      bad.push(`${rel}:${i + 1} exit-2 spelled indirectly (route it through lib/emit-block.js): ${line.trim()}`);
      return;
    }
    if (!/process\.exit\(\s*2\s*\)/.test(code)) return;
    const prev = [];
    for (let j = i; j >= 0 && prev.length <= LOOKBACK; j--) {
      const t = lines[j].trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      prev.push(t);
    }
    if (!prev.some((t) => STDERR_RE.test(t))) bad.push(`${rel}:${i + 1} exit 2 without a stderr reason`);
  });
  return bad;
}

test('hygiene: every Codex-registered hook writes a stderr reason on each exit-2 path', () => {
  const hooks = registeredHookFiles();
  assert.ok(hooks.length >= 10, 'expected to parse the Codex hooks.json; got ' + hooks.length);
  const scanned = new Set();
  const bad = [];
  for (const rel of hooks) {
    for (const f of [rel, ...localRequires(rel)]) {
      if (scanned.has(f)) continue;
      scanned.add(f);
      bad.push(...violations(f));
    }
  }
  assert.deepStrictEqual(bad, [], 'Codex would let these blocks through:\n' + bad.join('\n'));
});

test('hygiene: the scan catches a stdout-only exit-2 block (self-check)', () => {
  const stdoutOnly = "fs.writeSync(1, JSON.stringify({ decision: 'block', reason: 'x' }) + '\\n');\nprocess.exit(2);\n";
  assert.strictEqual(violations('probe.js', stdoutOnly).length, 1);
  const withStderr = "fs.writeSync(1, JSON.stringify({ decision: 'block', reason: 'x' }) + '\\n');\nfs.writeSync(2, 'x\\n');\nprocess.exit(2);\n";
  assert.strictEqual(violations('probe.js', withStderr).length, 0);
  assert.strictEqual(violations('probe.js', 'process.exit(code);\n').length, 1);
});
