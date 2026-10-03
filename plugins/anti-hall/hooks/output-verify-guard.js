#!/usr/bin/env node
// anti-hall :: output-verify-guard (PostToolUse, matcher Bash, ADVISORY ONLY)
//
// Fires after a Bash tool call completes. Scans the tool's own output for
// common test/build-runner signatures (jest/vitest/pytest/go test/npm run
// build/tsc) and flags when the output shows BOTH a "passing" signal (e.g.
// "8 passed", "PASS", "ok") AND a "failing" signal (e.g. "2 failed", "FAIL",
// a parsed non-zero exit code) in the SAME run — the shape of a partial-pass
// summary line that is easy to mis-read or mis-report as a clean "tests
// pass". Never blocks: this only injects an advisory reminder to verify the
// actual result before claiming success.
//
// WHY DUAL-SIGNAL (not "any failure -> annotate"): PostToolUse fires
// immediately after the tool call, BEFORE the model's own next turn — so
// there is no "claimed tests pass" text yet to check against. A pure
// failure-only trigger would fire on every legitimately-reported failure,
// which is noise, not signal. Requiring pass+fail (or pass-text alongside a
// confirmed non-zero exit) targets the actual risk: a mixed/partial result
// that could plausibly be summarized as a false "tests pass".
//
// FIELD-SHAPE CAVEAT: the exact `tool_response` shape for a PostToolUse Bash
// event is UNDOCUMENTED (unverified against a captured real payload in this
// repo — see tests/fixtures/step0-probe-record*.md, which has no PostToolUse
// entry). Rather than assume a specific field name, this hook stringifies
// whatever `tool_response`/`tool_output` it receives and pattern-matches the
// resulting blob — robust to nesting/naming we cannot verify. If the harness
// ever ships without one of the fields probed here, this fails open (no
// annotation), never throws.
//
// DELIVERY CAVEAT: docs/KB-claude-codex.md:47 (updated through 2026-07-03)
// states PostToolUse `additionalContext` does NOT reach the model on the
// harness build it was audited against ("context-injection is event-gated"
// to UserPromptSubmit/UserPromptExpansion/SessionStart). That claim is
// SUPERSEDED by live, first-party evidence from the current build: this
// session's own transcript received real `PostToolUse:Read` /
// `PostToolUse:Bash` "additional context" system-reminders throughout this
// task (see the 2026-08-02 harness-feature-adoption spec's Fable review,
// "(b) ... AGREE — Live-proven this session"). Harness-version-dependent
// like every other hook here — re-probe if the harness changes; either way
// this hook fails open if delivery ever regresses (worst case: silent
// no-op, never a block).
//
// CONFIG (env):
//   ANTIHALL_OUTPUT_VERIFY_GUARD=off  -> disable entirely (fail-open exit 0)
// Escape hatch: ~/.anti-hall/skip.json {"output-verify-guard": <future-ts>}.
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise, ever.
//
// Contract (Claude Code PostToolUse hook):
//   stdin  : JSON { hook_event_name: 'PostToolUse', tool_name, tool_input,
//                    tool_response?, tool_output?, session_id, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//            or nothing when no mismatch is detected.
//   exit 0 : always (PostToolUse cannot block per KB-claude-codex.md:28
//            regardless; this hook never attempts to).

'use strict';

const fs = require('fs');

// Bound how much text we regex-scan so a pathological multi-MB tool output
// can never make this hook slow or memory-heavy. Head+tail keeps both the
// command's leading context and its trailing summary line (where runners
// print the pass/fail totals).
const SCAN_CAP = 200000; // chars

// Count-bearing patterns (e.g. "0 failed", "0 passed", "0 errors") must NOT
// match on a zero count — a clean `cargo test` summary line ("test result:
// ok. 5 passed; 0 failed") would otherwise be flagged as a mixed pass/fail
// result purely because the literal digit "0" preceded "failed". These use a
// captured \d+ group so firstMatch() (below) can reject zero-count hits;
// plain marker patterns (no count) are unaffected.
const FAIL_PATTERNS = [
  /\bFAIL\b/, // jest/vitest per-file marker ("FAIL src/foo.test.js")
  /--- FAIL:/, // go test per-test marker
  /^FAIL\t/m, // go test package-level summary
  /\b(\d+)\s+failing\b/i, // mocha-style summary
  /\b(\d+)\s+failed\b/i, // jest/vitest/pytest/cargo/go summary ("2 failed")
  /error TS\d+:/, // tsc compiler error
  /ERROR in /, // webpack/build error
  /\bBuild failed\b/i,
  /AssertionError/,
  /Traceback \(most recent call last\)/, // pytest/python failure
];

const PASS_PATTERNS = [
  /\bPASS\b/, // jest/vitest per-file marker
  /--- PASS:/, // go test per-test marker
  /^ok\s+\S+/m, // go test package pass ("ok  \tpkg\t0.002s")
  /\b(\d+)\s+passing\b/i, // mocha-style summary
  /\b(\d+)\s+passed\b/i, // jest/vitest/pytest/cargo summary ("8 passed")
  /\bCompiled successfully\b/i,
  /\bFound 0 errors\b/i, // tsc clean run
  /\bAll tests passed\b/i,
];

// Test-runner detection: only evaluate output for commands whose
// COMMAND-POSITION verb (or verb+subcommand) is an actual test runner — not
// a substring match anywhere in the command text. Fixes a false positive
// where `grep PASS FAIL src/foo.js` (a plain source-code grep, not a test
// run) tripped the mismatch below because both words appeared in ITS OWN
// output (the matched source lines), not a runner's summary.
//
// Mirrors merge-gate.js's own isAutoMerge(): split on shell separators,
// skip a leading env-assignment, use path.basename-style normalization
// (shell-scan's basename) so `/usr/local/bin/pytest` still matches `pytest`.
const { basename } = require('./lib/shell-scan.js');
// v0.108.0 unified settings (env > ~/.anti-hall/settings.json > default);
// fail-open to `undefined` (never the value that would disable a guard).
function settingsGet(section, key) {
  try { return require('./lib/settings.js').get(section, key); } catch (_) { return undefined; }
}

const RUNNER_VERBS = new Set(['pytest', 'jest', 'vitest', 'cargo']);
// verb -> required first positional arg (subcommand-shaped runners).
const RUNNER_SUBCOMMANDS = {
  node: 'test',
  go: 'test',
  flutter: 'test',
  dart: 'test',
  npm: 'test',
  yarn: 'test',
  pnpm: 'test',
};

function splitSegments(cmd) {
  return cmd.split(/&&|\|\||[;&|\n]/);
}

// isTestRunnerCommand(cmd): true if ANY segment's command-position verb is a
// known test-runner invocation (`node --test`, `npm test`/`npm run test`,
// `yarn test`, `pnpm test`, `pytest`, `jest`, `vitest`, `go test`,
// `cargo test`, `flutter test`, `dart test`).
function isTestRunnerCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  for (const seg of splitSegments(cmd)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i >= words.length) continue;
    const verb = basename(words[i]);
    const rest = words.slice(i + 1);
    if (RUNNER_VERBS.has(verb)) return true;
    if (Object.prototype.hasOwnProperty.call(RUNNER_SUBCOMMANDS, verb)) {
      const want = RUNNER_SUBCOMMANDS[verb];
      // `npm test`/`npm run test` — allow an optional `run` before the verb.
      if (rest[0] === want) return true;
      if (rest[0] === 'run' && rest[1] === want) return true;
    }
  }
  return false;
}

// Returns the first match text for the first pattern that has a genuine hit.
// A pattern with a captured \d+ count group (e.g. /\b(\d+)\s+failed\b/i) only
// counts as a hit when that count is non-zero — otherwise "0 failed"/"0
// passed"/"0 errors" would falsely trip the mixed-result check. Scans ALL
// occurrences of a count pattern (via a global-flagged clone) so a later
// non-zero occurrence still counts even if an earlier "0 X" occurs first.
function firstMatch(patterns, text) {
  for (const re of patterns) {
    if (re.source.includes('(\\d+)')) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(text))) {
        if (parseInt(m[1], 10) !== 0) return m[0];
        if (g.lastIndex === m.index) g.lastIndex++; // avoid infinite loop on zero-width
      }
      continue;
    }
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// Build a bounded scan blob from whatever shape tool_response/tool_output
// turn out to be. Stringifying is deliberate — see FIELD-SHAPE CAVEAT above.
function buildBlob(payload) {
  const parts = [];
  for (const key of ['tool_response', 'tool_output']) {
    const v = payload && payload[key];
    if (typeof v === 'undefined' || v === null) continue;
    try {
      parts.push(typeof v === 'string' ? v : JSON.stringify(v));
    } catch (_) { /* unserializable — skip this source */ }
  }
  let blob = parts.join('\n');
  if (blob.length > SCAN_CAP) {
    const half = Math.floor(SCAN_CAP / 2);
    blob = blob.slice(0, half) + '\n...(truncated)...\n' + blob.slice(-half);
  }
  return blob;
}

// Best-effort exit-code extraction: check common field-name spellings on a
// tool_response object, then fall back to a loose textual "exit code: N"
// scan of the blob (some Bash tool renders append this as plain text).
function extractExitCode(payload, blob) {
  const tr = payload && payload.tool_response;
  if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
    const candidates = [tr.exit_code, tr.exitCode, tr.exit_status, tr.exitStatus];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) return c;
    }
  }
  const m = blob.match(/exit[_ ]?code["']?\s*[:=]\s*(-?\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  if (settingsGet('guards', 'outputVerifyGuard') === false) {
    process.exit(0);
  }

  // Escape hatch: shared user-consented skip. Outer main() try/catch fails
  // OPEN on any skip-guard error, matching codex-nudge/speculation-guard.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('output-verify-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }
  if (!payload || payload.tool_name !== 'Bash') process.exit(0);

  // DETERMINISTIC FIX: only evaluate output from an actual test-runner
  // invocation (command-position verb, not a substring of the command or
  // its output) — a `grep PASS FAIL <file>` on source code is not a test
  // run and must never trigger this advisory.
  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string'
    ? payload.tool_input.command : '';
  if (!isTestRunnerCommand(cmd)) process.exit(0);

  const blob = buildBlob(payload);
  if (!blob) process.exit(0);

  const failHit = firstMatch(FAIL_PATTERNS, blob);
  const passHit = firstMatch(PASS_PATTERNS, blob);
  const exitCode = extractExitCode(payload, blob);
  const nonZeroExit = typeof exitCode === 'number' && exitCode !== 0;

  const mismatch = Boolean(passHit) && (Boolean(failHit) || nonZeroExit);

  // JEV SHADOW (outputVerifyGuard, default mode "shadow"): only on
  // test-runner output (scope established above). Fire-and-forget — this is
  // PostToolUse, a critical-path hook, so the ask MUST add zero latency;
  // dispatched via askDetached. baseline = the regex mismatch verdict; the
  // label lands in jev-assist.ndjson only and never changes the advisory
  // emitted below.
  try {
    require('./lib/jev-assist.js').askDetached({
      id: 'outputVerifyGuard',
      question: {
        type: 'noul',
        instructions: 'Does this test-runner output show a GENUINELY mixed ' +
          'pass/fail result (some tests failed alongside others passing), as ' +
          'opposed to both words merely appearing in unrelated text?',
        criteria: { true: 'genuinely mixed pass/fail', false: 'not a genuine mixed result' },
      },
      state: blob.slice(0, 4000),
      trust: 'advisory',
      baseline: mismatch,
      sessionId: payload && payload.session_id ? String(payload.session_id) : undefined,
    });
  } catch (_) { /* best-effort — never affects the advisory below */ }

  if (!mismatch) process.exit(0);

  const bits = [];
  if (passHit) bits.push('a passing signal (' + JSON.stringify(passHit) + ')');
  if (failHit) bits.push('a failure signal (' + JSON.stringify(failHit) + ')');
  if (nonZeroExit) bits.push('a non-zero exit code (' + exitCode + ')');

  const reason =
    'anti-hall output-verify-guard (advisory, not a block): this Bash command\'s ' +
    'output contains ' + bits.join(' AND ') + ' in the same run. Before reporting ' +
    '"tests pass" / "build succeeded", re-read the full output and confirm the ' +
    'actual pass/fail counts and exit code — a mixed summary is not a clean pass.';

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reason,
    },
  };

  // fs.writeSync(1,...) not process.stdout.write: on macOS node 18/20 async
  // pipe flush can race process.exit(0) and truncate the JSON; writeSync is
  // atomic (same reasoning as verify-first-subagent.js / command-guard.js).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block or wedge a PostToolUse turn.
}
process.exit(0);
