'use strict';
// lib/devswarm-wake.js — direct unit tests for the SHARED wake-directive text
// builders (wakeDirective / wakeReassert). This is the SINGLE SOURCE of the
// DevSwarm idle-wake directive; its 3 consumers are devswarm-child-role.js
// (SessionStart), devswarm-parent-gate.js (Stop, Primary), devswarm-child-gate.js
// (Stop, child) — each has its own consumer-level tests. This file tests the
// shared builders directly (no process spawn needed: pure string functions).
//
// v0.6x "Monitor low-latency wake" adds a trailing `watcher` param to BOTH
// builders. THE NON-NEGOTIABLE RULE under test throughout: Cron must be
// UNCONDITIONALLY present in every Claude-branch output, regardless of whether
// `watcher` is supplied — Monitor layers ON TOP, it never replaces or gates Cron.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const WAKE = require('../../plugins/anti-hall/hooks/lib/devswarm-wake.js');
const { wakeDirective, wakeReassert, WAKE_CRON_DEFAULT, drainCmd } = WAKE;

// fl-wave3 fix (item 3): a bare 38-char fixture path let the pre-fix 3x-
// embedded CLI path in wakeReassert stay under 400 chars by accident, hiding
// the real-world budget blowout — a realistic installed plugin path is far
// longer (~80-100 chars). Use a realistic-length fixture so the LENGTH CAP
// tests below actually exercise the contract.
const CLI = '/Users/someone/.claude/plugins/cache/anti-hall/anti-hall/0.98.0/scripts/devswarm.js';
// fl-wave4 fix (item 1): WATCHER now derived from the SAME root as CLI
// (matches real consumer usage — devswarm-parent-gate.js/devswarm-child-gate.js
// both build WATCHER via __dirname alongside CLI: `<root>/scripts/devswarm.js`
// and `<root>/companion/lib/devswarm-wake-watch.js`), and lengthened to a
// realistic ~100-char fixture — a short fixture path let the pre-fix
// verbatim-embedded watcher literal in wakeReassert stay under 400 chars by
// accident, hiding the real budget blowout the same way the pre-item-1 CLI
// fixture did (see the item-3 comment above).
const WATCHER = path.join(path.dirname(path.dirname(CLI)), 'companion', 'lib', 'devswarm-wake-watch.js');

// ---------------------------------------------------------------------------
// REQUIRED REGRESSION MATRIX (owner-named): the cron half must be present in
// EVERY Claude-branch output. wakeDirective x wakeReassert x child x Primary x
// (watcher present/absent) x (WAKE_CRON custom/unset/garbage). Deleting the
// cron half from either builder must make this fail loudly.
// ---------------------------------------------------------------------------

const CRON_CASES = [
  { label: 'custom valid cron', env: { DEVSWARM_AI_AGENT: 'claude', ANTIHALL_DEVSWARM_WAKE_CRON: '*/1 * * * *' }, expectedSchedule: '*/1 * * * *' },
  { label: 'unset cron (default)', env: { DEVSWARM_AI_AGENT: 'claude' }, expectedSchedule: WAKE_CRON_DEFAULT },
  { label: 'garbage cron (falls back to default)', env: { DEVSWARM_AI_AGENT: 'claude', ANTIHALL_DEVSWARM_WAKE_CRON: 'not a cron at all' }, expectedSchedule: WAKE_CRON_DEFAULT },
];

const WATCHER_CASES = [
  { label: 'watcher present', watcher: WATCHER },
  { label: 'watcher absent', watcher: undefined },
];

for (const isChild of [true, false]) {
  const roleLabel = isChild ? 'child' : 'Primary';
  for (const wCase of WATCHER_CASES) {
    for (const cCase of CRON_CASES) {
      test(`MATRIX wakeDirective: ${roleLabel} x ${wCase.label} x ${cCase.label} -> cron half always present`, () => {
        const out = wakeDirective(cCase.env, isChild, CLI, wCase.watcher);
        assert.ok(/`CronList`/.test(out), `must name CronList; out=${out}`);
        assert.ok(/`CronCreate`/.test(out), `must name CronCreate; out=${out}`);
        assert.ok(out.includes('`' + cCase.expectedSchedule + '`'), `must carry schedule ${cCase.expectedSchedule}; out=${out}`);
      });

      // C (hook-injection byte-budget trim): wakeReassert no longer re-states
      // the full CronCreate prompt inline — it POINTS at `wake-directive <id>`
      // (scripts/devswarm.js's on-demand reprint of the full SessionStart
      // text) instead. So this half of the matrix checks for CronList + the
      // schedule + the wake-directive pointer, never CronCreate itself.
      test(`MATRIX wakeReassert: ${roleLabel} x ${wCase.label} x ${cCase.label} -> CronList + schedule + wake-directive pointer always present`, () => {
        const out = wakeReassert(cCase.env, CLI, isChild, wCase.watcher);
        assert.ok(/CronList/.test(out), `must name CronList; out=${out}`);
        assert.ok(!/`CronCreate`/.test(out), `trimmed reassert must NOT re-state CronCreate inline; out=${out}`);
        assert.ok(out.includes('`' + cCase.expectedSchedule + '`'), `must carry schedule ${cCase.expectedSchedule}; out=${out}`);
        assert.ok(/wake-directive/.test(out), `must point at the wake-directive re-run; out=${out}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// GOLDEN: the NON-Claude branch is byte-identical to today's captured string,
// and never contains Monitor or CronCreate — regardless of `watcher`.
// ---------------------------------------------------------------------------

// C1 fix (v0.86.0): drainCmd now gates the read/spawn-worthy step behind a
// cheap inline `inbox count` check first, literal golden text kept
// independent of drainCmd itself (not a call-through) so a regression in
// drainCmd's own logic cannot silently rewrite its own expectation.
function nonClaudeGolden(agent, cli, isChild) {
  const id = '<DEVSWARM_BUILDER_ID>';
  const stopCond = 'if `unreadTotal` is 0 AND `meshGapWithheld` is NOT `true` AND `known` is NOT `false`';
  const otherwise = 'either `unreadTotal` is greater than 0, or `meshGapWithheld` is `true`, or `known` is `false`';
  // fl-wave5 fix (item 4), broadened fl-wave6 (item 2): drainCmd's terminal
  // `inbox read-primary` step now names its own ANY-`ok:false`-refusal stop
  // condition — kept here as literal golden text too (not a call-through),
  // matching this file's own "independent of drainCmd itself" convention
  // above.
  const storeUnavailableClause = ' — if that reports `ok:false`, '
    + 'report the `reason` (and `storeUnavailableReason`/`storeUnavailableDetail` when present) '
    + 'in one line and stop (do not loop, do not spawn a subagent)';
  const drain = isChild
    ? 'first run `node ' + cli + ' inbox pull ' + id + '` (cheap, inline — imports ' +
      'anything waiting in your native queue) then `node ' + cli + ' inbox count ' + id +
      '`; ' + stopCond + ', say so and stop — do NOT spawn a subagent; otherwise (' +
      otherwise + '), run `node ' + cli +
      ' inbox read-primary ' + id + '` (delegate to a subagent only if the payload is large ' +
      '— this is the cursor-advancing verb, matching devswarm-child-turn.js\'s own ' +
      'mesh-direct instruction; `inbox read` is a non-mutating peek and cannot clear the ' +
      'withheld gap)' + storeUnavailableClause
    : 'first run `node ' + cli + ' inbox count ' + id + '`; ' + stopCond + ', say so ' +
      'and stop — do NOT spawn a subagent; otherwise (' + otherwise + '), run `node ' + cli +
      ' inbox read-primary ' + id + '` (delegate to a subagent only if the payload is large)' + storeUnavailableClause;
  return ' MAILBOX WAKE: this workspace runs `' + agent + '`, which has NO idle-wake ' +
    'primitive — once you go idle, nothing can wake you, so a message that lands after ' +
    'you stop waits for your next turn. Drain your mailbox at the START of every turn ' +
    'and again BEFORE you stop: ' + drain + '.';
}

for (const isChild of [true, false]) {
  test(`GOLDEN: non-Claude branch (${isChild ? 'child' : 'Primary'}) is BYTE-IDENTICAL to today's text, with or without watcher`, () => {
    const env = { DEVSWARM_AI_AGENT: 'codex' };
    const expected = nonClaudeGolden('codex', CLI, isChild);
    const withoutWatcher = wakeDirective(env, isChild, CLI, undefined);
    const withWatcher = wakeDirective(env, isChild, CLI, WATCHER);
    assert.strictEqual(withoutWatcher, expected, `non-Claude branch must be byte-identical; got=${withoutWatcher}`);
    assert.strictEqual(withWatcher, expected, `watcher must NEVER affect the non-Claude branch; got=${withWatcher}`);
    assert.ok(!/Monitor/.test(withWatcher), `non-Claude branch must never name Monitor; out=${withWatcher}`);
    assert.ok(!/CronCreate/.test(withWatcher), `non-Claude branch must never name CronCreate; out=${withWatcher}`);
  });
}

// ---------------------------------------------------------------------------
// Wave F1 (P0): known-guard. `count`/`tick` can report `known: false` (store
// unreadable) alongside a numeric `unreadTotal` (e.g. 0, the NDJSON-only
// component) — the stop condition text must require `known` is not `false`
// on top of the existing unreadTotal/meshGapWithheld checks, for every
// isChild x useTick combination, so an agent following this instruction
// never treats a store-unavailable count as "nothing to do".
// ---------------------------------------------------------------------------
for (const isChild of [true, false]) {
  for (const useTick of [true, false]) {
    test(`KNOWN-GUARD: drainCmd(isChild=${isChild}, useTick=${useTick}) requires known is NOT false to stop`, () => {
      const out = drainCmd(CLI, isChild, useTick);
      assert.ok(/`known` is NOT `false`/.test(out), `stop condition must gate on known; out=${out}`);
      assert.ok(/`known` is `false`/.test(out), `otherwise-branch must name known:false as a reason to keep draining; out=${out}`);
    });
  }
}

test('GOLDEN: wakeReassert is Claude-only by construction — callers gate on isClaudeAgent, never called for non-Claude', () => {
  // wakeReassert itself has no agent branch (unlike wakeDirective) — its callers
  // (devswarm-parent-gate.js / devswarm-child-gate.js) gate on isClaudeAgent()
  // before ever invoking it. Documented here so a future refactor cannot quietly
  // drop that external gate without a test noticing the contract changed.
  assert.strictEqual(typeof WAKE.isClaudeAgent, 'function');
  assert.strictEqual(WAKE.isClaudeAgent({ DEVSWARM_AI_AGENT: 'codex' }), false);
  assert.strictEqual(WAKE.isClaudeAgent({ DEVSWARM_AI_AGENT: 'claude' }), true);
});

// ---------------------------------------------------------------------------
// Monitor half: present when `watcher` is passed, ABSENT when it is not.
// ---------------------------------------------------------------------------

for (const isChild of [true, false]) {
  test(`MONITOR: wakeDirective ${isChild ? 'child' : 'Primary'} -> Monitor arm text present iff watcher supplied`, () => {
    const env = { DEVSWARM_AI_AGENT: 'claude' };
    const withWatcher = wakeDirective(env, isChild, CLI, WATCHER);
    const withoutWatcher = wakeDirective(env, isChild, CLI, undefined);
    assert.ok(/`Monitor`/.test(withWatcher), `watcher present -> must arm Monitor; out=${withWatcher}`);
    assert.ok(withWatcher.includes('node ' + WATCHER), `must emit the exact watcher path; out=${withWatcher}`);
    assert.ok(/persistent/i.test(withWatcher), `must mention persistent:true; out=${withWatcher}`);
    assert.ok(!/`Monitor`/.test(withoutWatcher), `watcher absent -> Monitor text must be ABSENT; out=${withoutWatcher}`);
    // Absent watcher must not change the cron-only text at all vs. a call with no 4th arg.
    const implicit = wakeDirective(env, isChild, CLI);
    assert.strictEqual(withoutWatcher, implicit, 'explicit undefined watcher === omitted watcher arg');
  });

  test(`MONITOR: wakeReassert ${isChild ? 'child' : 'Primary'} -> Monitor arm text present iff watcher supplied`, () => {
    const withWatcher = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, isChild, WATCHER);
    const withoutWatcher = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, isChild, undefined);
    assert.ok(/`Monitor`/.test(withWatcher), `watcher present -> must arm Monitor; out=${withWatcher}`);
    // fl-wave4 fix (item 1): wakeReassert no longer embeds the literal
    // `watcher` path a second time — it derives $WATCH from the already-
    // emitted $CLI (same root, see the WATCHER fixture comment above), so
    // this checks for the DERIVATION, not a literal watcher-path substring.
    assert.ok(withWatcher.includes('$(dirname "$CLI")/../companion/lib/devswarm-wake-watch.js'),
      `must derive the watcher path from $CLI rather than re-embed the literal path; out=${withWatcher}`);
    assert.ok(!withWatcher.includes(WATCHER), `must NOT re-embed the long literal watcher path a second time (budget fix); out=${withWatcher}`);
    assert.ok(!/`Monitor`/.test(withoutWatcher), `watcher absent -> Monitor text must be ABSENT; out=${withoutWatcher}`);
  });
}

// ---------------------------------------------------------------------------
// fl-wave4 fix (item 1): null-guard — neither a null/undefined `cli` NOR a
// null/undefined `watcher` may ever leak a literal "undefined" string into
// the output. `watcher` falsy already omits the Monitor clause entirely
// (unchanged); `cli` falsy must render as an explicit placeholder, never the
// string coercion of `undefined`/`null`.
// ---------------------------------------------------------------------------
for (const isChild of [true, false]) {
  test(`NULL-GUARD: wakeReassert(isChild=${isChild}) never prints the literal string "undefined" for a null cli or watcher`, () => {
    for (const cliVal of [null, undefined]) {
      for (const watcherVal of [null, undefined]) {
        const out = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, cliVal, isChild, watcherVal);
        assert.ok(!/undefined/.test(out), `must never print the literal "undefined"; cli=${cliVal} watcher=${watcherVal} out=${out}`);
        assert.ok(!/\bnull\b/.test(out), `must never print the literal "null"; cli=${cliVal} watcher=${watcherVal} out=${out}`);
      }
    }
  });
}

test('MONITOR: instruction tells the agent to check whether one is already armed before arming a second', () => {
  const out = wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, true, CLI, WATCHER);
  assert.ok(/already armed|double-arming/i.test(out), `must warn against double-arming; out=${out}`);
});

// ---------------------------------------------------------------------------
// Unknown agent (DEVSWARM_AI_AGENT unset) -> '' for wakeDirective. wakeReassert
// has no agent branch of its own (callers gate via isClaudeAgent), but must
// still never throw and must still respect fail-open on garbage env.
// ---------------------------------------------------------------------------

test("UNKNOWN AGENT: DEVSWARM_AI_AGENT unset -> wakeDirective yields '' regardless of watcher", () => {
  assert.strictEqual(wakeDirective({}, true, CLI, WATCHER), '');
  assert.strictEqual(wakeDirective({}, false, CLI, undefined), '');
});

test('FAIL-OPEN: never throws for hostile env / watcher values', () => {
  const hostile = [null, undefined, 42, 'x'.repeat(5000), { toString() { throw new Error('boom'); } }];
  for (const w of hostile) {
    assert.doesNotThrow(() => wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, true, CLI, w));
    assert.doesNotThrow(() => wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, true, w));
  }
});

// Watcher path sanity: absolute-path callers (the real consumers) always pass an
// absolute path — verify our fixture constant actually is one, so the matrix
// above is representative of real usage.
test('sanity: WATCHER fixture used throughout this file is absolute (matches real consumer usage)', () => {
  assert.ok(path.isAbsolute(WATCHER));
});

// ---------------------------------------------------------------------------
// C1 fix (v0.86.0): every no-op mailbox drain used to unconditionally spend a
// full subagent context (drainCmd emitted an unconditional drain instruction,
// funneled by wakeDirective/wakeReassert into SessionStart/Stop/cron text).
// Now drainCmd runs a cheap inline `inbox count` FIRST and tells the agent
// explicitly not to spawn anything when it comes back empty.
// ---------------------------------------------------------------------------

// C1 MUTATION-CHECK (killed):
//   1. Revert drainCmd to the pre-fix unconditional form (no `inbox count`, no
//      "do NOT spawn") -> all 3 tests below fail. This is also the RED
//      baseline verified against the pre-fix source.
//   2. Swap the child branch's leading `inbox pull` for `inbox count` (so
//      count would run before pull instead of after) -> the "keeps inbox pull
//      unconditional" test below fails (pullIdx < countIdx assertion trips).
test('C1: drainCmd(cli, false) [Primary] gates the drain behind an inline `inbox count` check and forbids spawning on empty', () => {
  const out = drainCmd(CLI, false);
  assert.ok(out.includes('inbox count'), `must run inbox count first; out=${out}`);
  assert.ok(/do NOT spawn/.test(out), `must explicitly forbid spawning a subagent on empty; out=${out}`);
  assert.ok(out.includes('inbox read-primary'), `must still name the drain verb for the non-empty branch; out=${out}`);
});

test('C1: drainCmd(cli, true) [child] also gates the READ step behind `inbox count`, but keeps `inbox pull` unconditional', () => {
  const out = drainCmd(CLI, true);
  assert.ok(out.includes('inbox count'), `must run inbox count; out=${out}`);
  assert.ok(/do NOT spawn/.test(out), `must forbid spawning on empty; out=${out}`);
  // inbox pull must NOT be gated behind count: count cannot see the native
  // queue pull imports, so gating pull itself would make native-only mail
  // permanently invisible (count would keep reporting 0 forever).
  const pullIdx = out.indexOf('inbox pull');
  const countIdx = out.indexOf('inbox count');
  assert.ok(pullIdx !== -1 && countIdx !== -1 && pullIdx < countIdx,
    `inbox pull must run BEFORE inbox count, unconditionally; out=${out}`);
});

// Wave 4 P1 fix: the child branch used to send bare `inbox read <id>` on the
// "otherwise" (unreadTotal>0 || meshGapWithheld) leg — a NON-MUTATING peek
// (devswarm.js cmdInbox `sub === 'read'` never calls ackTo/setCursor), so a
// child could never clear a `meshGapWithheld:true` condition; the gate could
// re-fire forever. Must now say `inbox read-primary` (the cursor-advancing
// verb, matching devswarm-child-turn.js's own mesh-direct instruction) and
// must NEVER emit the bare non-acking `inbox read <id>` form.
test('P1 (Wave 4): drainCmd(cli, true) [child] names the cursor-advancing `inbox read-primary`, never the non-mutating bare `inbox read`', () => {
  const out = drainCmd(CLI, true);
  assert.ok(out.includes('inbox read-primary'), `child otherwise-branch must run inbox read-primary (cursor-advancing); out=${out}`);
  const id = '<DEVSWARM_BUILDER_ID>';
  assert.ok(!out.includes('inbox read ' + id), `must never emit the non-mutating bare "inbox read <id>" form; out=${out}`);
});

test('C1: unreadTotal field is the value gated on (matches `inbox count`s real JSON field name)', () => {
  assert.ok(drainCmd(CLI, false).includes('unreadTotal'));
  assert.ok(drainCmd(CLI, true).includes('unreadTotal'));
});

// ---------------------------------------------------------------------------
// fl-wave5 fix (item 4), broadened fl-wave6 (item 2, P1): the terminal
// `inbox read-primary` step drainCmd sends the agent to run can itself
// refuse with `ok:false` for ANY reason — not just the literal
// `store-unavailable` bucket (project-context-mismatch, unregistered-
// workspace, an ownership-mismatch reason, … — every refusal
// `resolveWorkspaceStoreForRead` can produce). Pre-fix (fl-wave5), drainCmd's
// prose only named the terminal branch when `reason` was exactly
// `store-unavailable`, leaving the agent free to loop or spawn a subagent
// over every OTHER `ok:false` refusal. Present for EVERY isChild x useTick
// combination — the terminal step is always the same `inbox read-primary`
// verb regardless of which leading drain step ran.
// ---------------------------------------------------------------------------
for (const isChild of [true, false]) {
  for (const useTick of [true, false]) {
    test(`item4: drainCmd(isChild=${isChild}, useTick=${useTick}) names the ANY-ok:false terminal branch for its final inbox read-primary step`, () => {
      const out = drainCmd(CLI, isChild, useTick);
      assert.match(out, /`ok:false`/, `must name the ok:false outcome; out=${out}`);
      assert.match(out, /`reason`/, `must tell the agent to report the reason; out=${out}`);
      assert.match(out, /storeUnavailableReason/, `must tell the agent to report storeUnavailableReason; out=${out}`);
      assert.match(out, /storeUnavailableDetail/, `must tell the agent to report storeUnavailableDetail; out=${out}`);
      assert.doesNotMatch(out, /`reason`\s+`store-unavailable`/, `must NOT be scoped to the literal store-unavailable reason only; out=${out}`);
      assert.match(out, /stop \(do not loop, do not spawn a subagent\)/, `must be an explicit stop — no loop, no spawn; out=${out}`);
    });
  }
}

// ---------------------------------------------------------------------------
// C (hook-injection byte-budget trim): wakeReassert must stay a SHORT pointer
// (name what CronList/Monitor must show, then send the agent to re-run
// `wake-directive <id>` for the full text) — never balloon back into
// re-stating the entire SessionStart prompt inline on every Stop-gate firing.
// ---------------------------------------------------------------------------
// fl-wave5 fix (item 3): the "<= 400 total" cap this replaces conflated the
// FIXED pointer text with the caller-controlled embedded CLI path — a real
// install path is not bounded by this function at all, so a flat total cap
// either hid a real fixed-text blowout behind a short fixture (the pre-fix
// state) or would be unmeetable for a long real path through no fault of
// this text. The honest contract is on the FIXED text ONLY: total output
// length minus the literal `cli` argument's own length (the path appears
// in the output exactly once — proven by the separate "exactly ONCE" test
// below) must stay <= 360 chars, at BOTH an 86-char and a 160-char cli
// fixture, for child and Primary alike.
// fl-wave6 fix (P2, item 5): raised from 320 to 360. Backslash escapes in
// the emitted text (e.g. \`ok:false\`) count toward the MEASURED length the
// same as any other character — the real fixed-text length already peaked
// at 315 chars against the old 320 cap, only 5 chars of headroom. The raise
// is NOT because this wave's own item 2 fix (widening drainCmd's
// storeUnavailableClause wording) would have tripped it — wakeReassert
// never calls drainCmd and carries no storeUnavailableClause at all, so
// that fix could not have touched this text; the measured fixed length is
// 315 chars both before and after item 2. The raise is headroom against
// FUTURE backslash-escaped characters and wording changes to wakeReassert's
// own text, given how thin 5 chars already was. The measurement method is
// unchanged (output.length minus the literal cli length) — this only raises
// the ceiling, and does not trim any existing wording.
function cliOfLength(n) {
  const suffix = '/devswarm.js';
  const padLen = Math.max(0, n - suffix.length - 1);
  return '/' + 'a'.repeat(padLen) + suffix;
}
const FIXED_TEXT_CAP = 360;
for (const isChild of [true, false]) {
  for (const wCase of WATCHER_CASES) {
    for (const cliLen of [86, 160]) {
      test(`FIXED TEXT LENGTH CAP: wakeReassert(isChild=${isChild}, ${wCase.label}, cli=${cliLen} chars) fixed text stays <= ${FIXED_TEXT_CAP} chars`, () => {
        const fixtureCli = cliOfLength(cliLen);
        assert.equal(fixtureCli.length, cliLen, 'test fixture setup sanity check');
        const out = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, fixtureCli, isChild, wCase.watcher);
        const fixedLen = out.length - fixtureCli.length;
        assert.ok(fixedLen <= FIXED_TEXT_CAP,
          `wakeReassert fixed text (excluding the embedded cli path) must stay <= ${FIXED_TEXT_CAP} chars, got ${fixedLen}; out=${out}`);
      });
    }
  }
}

test('wakeReassert points at the on-demand wake-directive CLI verb for the full SessionStart text', () => {
  const out = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, true, WATCHER);
  // fl-wave3 fix (item 3): the CLI path is now emitted ONCE, up front, as a
  // `CLI=` assignment — every later reference (including this wake-directive
  // pointer) uses the short `"$CLI"` token instead of re-embedding the long
  // literal path a second/third time.
  // fl-wave5 fix (item 3): the assignment is now DOUBLE-quoted (`CLI="<path>"`,
  // a directly shell-runnable literal-string assignment), not backtick-quoted
  // (`CLI=\`<path>\``) — backticks in an actual shell mean COMMAND
  // SUBSTITUTION, so the pre-fix text told the agent to run something that
  // would EXECUTE the path as a command instead of assigning it.
  assert.ok(out.includes('CLI="' + CLI + '"'), `must name the CLI path exactly once, up front, as a shell-quoted assignment; out=${out}`);
  assert.ok(out.includes('node "$CLI" wake-directive'), `must point at the wake-directive verb via the $CLI token; out=${out}`);
  assert.strictEqual(out.split(CLI).length - 1, 1, `the long CLI path must appear exactly ONCE in the output, not repeated; out=${out}`);
});
