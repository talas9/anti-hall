'use strict';
// scan-throttle (PreToolUse Bash) — additive background-throttle prefix for
// heavy repo-wide scan commands, via `hookSpecificOutput.updatedInput`. Never
// blocks; never changes what a command does, only its OS scheduling priority.
//
// This hook ships with ZERO built-in scan patterns (graphify support was
// retired) — every match in this suite is driven by ANTI_HALL_THROTTLE_PATTERNS.
// A neutral stand-in command (`reindex-repo --full`) plays the role a
// project-specific heavy scanner would play in a real deployment.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');

const HOOK = 'scan-throttle.js';

// A pattern matching the neutral stand-in command used throughout this suite,
// anchored to the start of the segment (tolerating the leading whitespace
// splitSegments() leaves on a non-first segment after `&&`/`(`/etc). This
// mirrors how an operator would anchor a real pattern to avoid matching the
// scan command's NAME showing up incidentally inside unrelated text (e.g.
// inside an `echo "..."` argument — see the "as data" test below).
const SCAN_PATTERN = '^\\s*reindex-repo\\b';

// A looser pattern (no start anchor — the command NAME preceded by start-of-
// string or whitespace) for fixtures where the scan command itself is
// preceded by a wrapper word or a NAME=value assignment on the SAME segment
// (`time reindex-repo ...`, `FOO=1 reindex-repo ...`) — the plain regex
// matcher has no wrapper/assignment awareness (that classification lived only
// in the retired graphify-specific classifier), so these fixtures configure a
// pattern tolerant of a single leading token instead.
const PREFIXED_PATTERN = '(^|\\s)reindex-repo\\b';

// Build a fake bin dir on PATH containing stub files for the named tools, so
// availability is deterministic across the ubuntu/macos CI matrix regardless
// of what is actually installed on the runner. The hook only fs.statSync's
// for file existence (no exec), so an empty placeholder file is sufficient.
function fakeBinDir(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-scanthrottle-bin-'));
  for (const tool of tools) {
    fs.writeFileSync(path.join(dir, tool), '');
  }
  return dir;
}

// The exact prefix this hook generates on THIS platform when every relevant
// tool is available (mirrors computeThrottlePrefix in scan-throttle.js).
function expectedFullPrefix() {
  if (process.platform === 'darwin') return 'taskpolicy -c utility nice -n 19 ';
  if (process.platform === 'linux') return 'ionice -c 3 nice -n 19 ';
  return null; // unsupported platform in this test's own model
}

const ALL_TOOLS = ['taskpolicy', 'nice', 'ionice'];

function runAvailable(command, extraEnv) {
  const bin = fakeBinDir(ALL_TOOLS);
  try {
    return testHook(HOOK, bashPayload(command), {
      env: { PATH: bin, ...(extraEnv || {}) },
      expectJson: false,
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

function runUnavailable(command, extraEnv) {
  const bin = fakeBinDir([]); // empty: no throttle tool at all
  try {
    return testHook(HOOK, bashPayload(command), {
      env: { PATH: bin, ...(extraEnv || {}) },
      expectJson: false,
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// Convenience: run with the suite's standard scan pattern configured.
function runWithPattern(command, extraEnv) {
  return runAvailable(command, { ANTI_HALL_THROTTLE_PATTERNS: SCAN_PATTERN, ...(extraEnv || {}) });
}

// ---------------------------------------------------------------------------
// No built-in patterns: with NOTHING configured, the hook matches nothing —
// not even a command that would match once a pattern IS configured.
// ---------------------------------------------------------------------------
test('scan-throttle: with NO ANTI_HALL_THROTTLE_PATTERNS configured, nothing is matched', () => {
  const r = runAvailable('reindex-repo --full');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'no built-in patterns ship anymore — an unconfigured hook must be a no-op');
});

// ---------------------------------------------------------------------------
// Core rewrite: a command matching ANTI_HALL_THROTTLE_PATTERNS at segment 0
// -> prefixed, updatedInput set.
// ---------------------------------------------------------------------------
test('scan-throttle: rewrites a command matching ANTI_HALL_THROTTLE_PATTERNS with the platform throttle prefix', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return; // unsupported platform for this test model — skip
  const r = runWithPattern('reindex-repo --full');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json, 'expected JSON output for a rewrite');
  assert.strictEqual(
    r.json.hookSpecificOutput.updatedInput.command,
    prefix + 'reindex-repo --full'
  );
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
});

// ---------------------------------------------------------------------------
// Idempotency (mutation-checked): only the EXACT, ANCHORED (startsWith) known
// prefix at the very start of the trimmed command counts as "already
// prefixed." A command that merely CONTAINS the prefix text later, or an
// almost-but-not-exactly-matching prefix, must NOT be treated as prefixed.
// Idempotency is checked BEFORE pattern matching, so no ANTI_HALL_THROTTLE_
// PATTERNS is needed for these cases.
// ---------------------------------------------------------------------------
test('scan-throttle: idempotent — already-prefixed command is left unchanged', () => {
  const already = 'taskpolicy -c utility nice -n 19 reindex-repo --full';
  const r = runAvailable(already);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'must not double-prefix an already-prefixed command');
});

test('scan-throttle: idempotent — bare `nice -n 19` prefix form is also recognized', () => {
  const already = 'nice -n 19 reindex-repo --full';
  const r = runAvailable(already);
  assert.strictEqual(r.stdout.trim(), '');
});

test('scan-throttle: idempotent — `ionice -c 3 nice -n 19` combined prefix is recognized', () => {
  const already = 'ionice -c 3 nice -n 19 reindex-repo --full';
  const r = runAvailable(already);
  assert.strictEqual(r.stdout.trim(), '');
});

// MUTATION CHECK: the idempotency guard must be an ANCHORED startsWith, not a
// substring/`includes` test anywhere in the command. If it were mutated to
// `.includes(prefix)`, this case would wrongly be treated as "already
// prefixed" and skipped — it must NOT be: the prefix text only appears after
// a `#` comment / trailing text, not at the very start, so this is a FRESH,
// unprefixed scan command and must still be rewritten.
test('scan-throttle: MUTATION-CHECK idempotency is anchored, not a substring match', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const command = 'reindex-repo --full # note: nice -n 19 is what this becomes';
  const r = runWithPattern(command);
  assert.ok(r.json, 'a command that only CONTAINS prefix-like text later must still be rewritten');
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + command);
});

// ---------------------------------------------------------------------------
// Untouched: non-matching commands.
// ---------------------------------------------------------------------------
test('scan-throttle: unrelated command is left untouched', () => {
  const r = runWithPattern('git status');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('scan-throttle: a command that merely mentions the scan command as data is untouched', () => {
  const r = runWithPattern('echo "run reindex-repo --full later"');
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Heredoc (mutation-checked): a heredoc BODY that looks like a scan command is
// DATA, never re-parsed as a command segment.
// ---------------------------------------------------------------------------
test('scan-throttle: heredoc body containing a scan-looking line is untouched', () => {
  const command = "cat <<'EOF'\nreindex-repo --full\nEOF";
  const r = runWithPattern(command);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'heredoc BODY must never be parsed as a command');
});

// MUTATION CHECK: combine heredoc skip AND first-segment positioning in one
// case. The heredoc-invoking `cat <<'EOF' ... EOF` is segment 0 (verb `cat`,
// no match). A REAL scan command chained AFTER the heredoc closes is a
// separate segment at index 1 (not 0) — so even though it DOES match, it must
// be left untouched (mid-compound rule), not accidentally caught by a broken
// heredoc skip that fails to close the segment and merges everything into
// segment 0.
test('scan-throttle: MUTATION-CHECK heredoc-close boundary + mid-compound match stays untouched', () => {
  const command = "cat <<'EOF'\nsome body text\nEOF\n && reindex-repo --full";
  const r = runWithPattern(command);
  assert.strictEqual(r.status, 0);
  // Must not rewrite (mid-compound); may emit an advisory note instead.
  assert.strictEqual(r.stdout.includes('updatedInput'), false);
});

// ---------------------------------------------------------------------------
// Mid-compound: match exists but is not the first simple command -> untouched,
// advisory note only (fail-open — never guess a rewrite position).
// ---------------------------------------------------------------------------
test('scan-throttle: mid-compound match is untouched, with an advisory note', () => {
  const r = runWithPattern('cd app && reindex-repo --full');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json, 'expected an advisory JSON note');
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
  assert.ok(
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
});

// ---------------------------------------------------------------------------
// P1 fix #1: leading NAME=value assignments must be RE-ATTACHED before the
// prefix, not left after it (`taskpolicy ... FOO=1 reindex-repo ...` is a
// shell syntax/exec error — `nice` tries to exec the literal string `FOO=1`).
// Verified end-to-end with a real `sh -c` execution using `env` as a
// harmless stand-in for the scan command (see the report for the raw
// output); here we assert the exact rewritten TEXT the hook produces.
// ---------------------------------------------------------------------------
test('scan-throttle: P1 — leading NAME=value assignment is re-attached BEFORE the prefix', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('SCANENV=1 reindex-repo --full', { ANTI_HALL_THROTTLE_PATTERNS: PREFIXED_PATTERN });
  assert.ok(r.json);
  assert.strictEqual(
    r.json.hookSpecificOutput.updatedInput.command,
    'SCANENV=1 ' + prefix + 'reindex-repo --full'
  );
});

test('scan-throttle: P1 — multiple leading assignments (one quoted) are all re-attached, in order', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('FOO=1 BAR="baz" reindex-repo --full', { ANTI_HALL_THROTTLE_PATTERNS: PREFIXED_PATTERN });
  assert.ok(r.json);
  assert.strictEqual(
    r.json.hookSpecificOutput.updatedInput.command,
    'FOO=1 BAR="baz" ' + prefix + 'reindex-repo --full'
  );
});

// ---------------------------------------------------------------------------
// P1 fix #2: a command wrapped in a subshell `( ... )` or brace group
// `{ ... ; }` must NEVER be rewritten — the naive segment-0 match used to
// misfire here because splitSegments() flushes an empty segment at `(`/`{`
// before any real text is accumulated, so the "first segment" it reports
// does not actually start at offset 0 of the raw string. Prefixing there
// produces a bash syntax error (verified separately via `sh -c`).
// ---------------------------------------------------------------------------
test('scan-throttle: P1 — subshell-wrapped `( reindex-repo --full )` is never rewritten', () => {
  const r = runWithPattern('( reindex-repo --full )');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
  assert.ok(typeof r.json.hookSpecificOutput.additionalContext === 'string');
});

test('scan-throttle: P1 — brace-group-wrapped `{ reindex-repo --full ; }` is never rewritten', () => {
  const r = runWithPattern('{ reindex-repo --full ; }');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
});

test('scan-throttle: P1 — subshell wrapped AFTER a leading assignment is also refused', () => {
  const r = runWithPattern('FOO=1 ( reindex-repo --full )');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
});

// Regression: env-assignment-prefixed mid-compound command must still be
// refused for the RIGHT reason (mid-compound), not accidentally accepted
// because its rest-of-string happens to look like plain text.
test('scan-throttle: P1 — leading assignment does not mask a mid-compound match', () => {
  const r = runWithPattern('FOO=1 cd app && reindex-repo --full');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
});

// ---------------------------------------------------------------------------
// Regression: still-valid wrapper shapes (`time`, `sudo`) must continue to be
// rewritten normally — the P1 fixes must not over-correct into refusing
// everything with a leading wrapper word. Verified separately via `sh -c`
// that the rewritten shape actually executes (reaches the wrapped program,
// no syntax error / no exit 127 from the prefix itself).
// ---------------------------------------------------------------------------
// NOTE: user-supplied ANTI_HALL_THROTTLE_PATTERNS is matched as a plain regex
// against the whole segment TEXT (no wrapper-word awareness like the old
// built-in graphify classifier had) — a pattern that only matches at segment
// start (`^reindex-repo`) will not match `time reindex-repo ...`. These two
// tests use PREFIXED_PATTERN, tolerant of a leading wrapper word, matching
// how an operator would actually configure this for a wrapped scan command.
test('scan-throttle: regression — `time reindex-repo --full` still rewrites normally', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('time reindex-repo --full', { ANTI_HALL_THROTTLE_PATTERNS: PREFIXED_PATTERN });
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + 'time reindex-repo --full');
});

test('scan-throttle: regression — `sudo reindex-repo --full` still rewrites normally', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('sudo reindex-repo --full', { ANTI_HALL_THROTTLE_PATTERNS: PREFIXED_PATTERN });
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + 'sudo reindex-repo --full');
});

// ---------------------------------------------------------------------------
// Kill switch.
// ---------------------------------------------------------------------------
test('scan-throttle: ANTI_HALL_SCAN_THROTTLE=0 disables the hook entirely', () => {
  const r = runWithPattern('reindex-repo --full', { ANTI_HALL_SCAN_THROTTLE: '0' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Tool unavailable -> unchanged, silently (no output at all).
// ---------------------------------------------------------------------------
test('scan-throttle: no throttle tool on PATH -> command left unchanged, no output', () => {
  const r = runUnavailable('reindex-repo --full', { ANTI_HALL_THROTTLE_PATTERNS: SCAN_PATTERN });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// ANTI_HALL_THROTTLE_PATTERNS env-configured allowlist — the ONLY source of
// matches this hook has (see the "no built-in patterns" test above).
// ---------------------------------------------------------------------------
test('scan-throttle: ANTI_HALL_THROTTLE_PATTERNS drives the match', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('some-custom-scanner --all', {
    ANTI_HALL_THROTTLE_PATTERNS: '^some-custom-scanner\\b',
  });
  assert.ok(r.json);
  assert.strictEqual(
    r.json.hookSpecificOutput.updatedInput.command,
    prefix + 'some-custom-scanner --all'
  );
});

test('scan-throttle: an invalid ANTI_HALL_THROTTLE_PATTERNS regex is skipped, fail-open', () => {
  const r = runAvailable('git status', {
    ANTI_HALL_THROTTLE_PATTERNS: '(unterminated[',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Non-Bash tool / malformed input / empty command -> fail-open silently.
// ---------------------------------------------------------------------------
test('scan-throttle: non-Bash tool_name is ignored', () => {
  const bin = fakeBinDir(ALL_TOOLS);
  try {
    const r = testHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    }, { env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('scan-throttle: malformed JSON stdin fails open', () => {
  const { testHookRaw } = require('../helpers/spawn-hook.js');
  const bin = fakeBinDir(ALL_TOOLS);
  try {
    const r = testHookRaw(HOOK, '{not json', { env: { PATH: bin } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('scan-throttle: empty command is a no-op', () => {
  const r = runWithPattern('');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});
