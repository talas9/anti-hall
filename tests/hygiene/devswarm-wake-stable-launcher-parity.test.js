'use strict';
// defect 7 (peer sweep, 0.116 candidate) hygiene ratchet: every hook that
// emits the DevSwarm mailbox-wake directive text (`inbox tick`, the Monitor
// watcher path) must resolve its CLI/WATCHER through the version-independent
// stable launcher (hooks/lib/stable-launcher.js -> ~/.anti-hall/bin/) rather
// than naming the version-pinned plugin-cache path
// (…/cache/anti-hall/anti-hall/<ver>/scripts/devswarm.js) directly in the
// emitted text — and wakeReassert (the Stop-gate re-verify pointer) must
// never re-derive the watcher path from $CLI's dirname (that derivation
// assumes the raw plugin-root layout and silently breaks once
// devswarm.stableLauncher makes CLI/WATCHER sibling files instead — see
// hooks/lib/devswarm-wake.js's wakeReassert for the fix of record).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');

const EMITTERS = [
  'devswarm-child-role.js',   // SessionStart directive
  'devswarm-child-gate.js',   // Stop, child
  'devswarm-parent-gate.js',  // Stop, Primary
];

for (const file of EMITTERS) {
  test(`${file} resolves its emitted CLI/WATCHER via the stable launcher (hooks/lib/stable-launcher.js), not a bare version-pinned path`, () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, file), 'utf8');
    assert.ok(
      /require\(['"]\.\/lib\/stable-launcher\.js['"]\)\.installLaunchers\(/.test(src),
      `${file} must call stable-launcher.js's installLaunchers() to resolve its emitted CLI/WATCHER`
    );
    // A RAW_CLI/RAW_WATCHER const (the __dirname-derived, version-pinned
    // fallback) is fine to KEEP as the fail-open fallback -- what must never
    // happen is the emitted directive text naming RAW_CLI/RAW_WATCHER
    // directly instead of the stable-launcher-resolved CLI/WATCHER.
    assert.ok(/\bCLI\s*=\s*RAW_CLI\b/.test(src), `${file} must default CLI to RAW_CLI before the stable-launcher install attempt`);
  });
}

test('devswarm-wake.js wakeReassert never re-derives the watcher path from $CLI (must embed the real resolved watcher)', () => {
  // Output-based (not a source-text scan, which would false-positive on this
  // very file's own header comment documenting the historical bug): the
  // stable-launcher case is CLI/WATCHER as SIBLING files, where the old
  // $(dirname "$CLI")/../companion/lib/... derivation resolves to a path
  // that does not exist.
  const { wakeReassert } = require('../../plugins/anti-hall/hooks/lib/devswarm-wake.js');
  const stableCli = '/Users/someone/.anti-hall/bin/devswarm.js';
  const stableWatcher = '/Users/someone/.anti-hall/bin/wake-watch.js';
  const out = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, stableCli, true, stableWatcher);
  assert.ok(
    !out.includes('$(dirname "$CLI")/../companion/lib/devswarm-wake-watch.js'),
    `wakeReassert must not derive $WATCH from $CLI's dirname (breaks under devswarm.stableLauncher, where CLI/WATCHER are sibling files); out=${out}`
  );
  assert.ok(out.includes(stableWatcher), `must name the real resolved watcher path instead; out=${out}`);
});

test("wakeReassert's tick command always appends --quiet, matching the cron job wakeDirective actually creates", () => {
  const { wakeDirective, wakeReassert } = require('../../plugins/anti-hall/hooks/lib/devswarm-wake.js');
  const env = { DEVSWARM_AI_AGENT: 'claude' };
  const cli = '/Users/someone/.anti-hall/bin/devswarm.js';
  for (const isChild of [true, false]) {
    const directiveOut = wakeDirective(env, isChild, cli, undefined);
    const reassertOut = wakeReassert(env, cli, isChild, undefined);
    const directiveHasQuiet = / --quiet`/.test(directiveOut);
    const reassertHasQuiet = / --quiet`/.test(reassertOut);
    assert.strictEqual(directiveHasQuiet, true, `wakeDirective's cron prompt must run --quiet; out=${directiveOut}`);
    assert.strictEqual(reassertHasQuiet, directiveHasQuiet, `wakeReassert must match wakeDirective's --quiet usage; out=${reassertOut}`);
  }
});
