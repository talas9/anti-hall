'use strict';
// scan-throttle (PreToolUse Bash) — additive background-throttle prefix for
// heavy repo-wide scan commands (graphify update / graphify <path>), via
// `hookSpecificOutput.updatedInput`. Never blocks; never changes what a
// command does, only its OS scheduling priority.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');

const HOOK = 'scan-throttle.js';

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

// ---------------------------------------------------------------------------
// Core rewrite: `graphify update .` at segment 0 -> prefixed, updatedInput set.
// ---------------------------------------------------------------------------
test('scan-throttle: rewrites `graphify update .` with the platform throttle prefix', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return; // unsupported platform for this test model — skip
  const r = runAvailable('graphify update .');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json, 'expected JSON output for a rewrite');
  assert.strictEqual(
    r.json.hookSpecificOutput.updatedInput.command,
    prefix + 'graphify update .'
  );
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('scan-throttle: rewrites bare `graphify <path>` (no query subcommand)', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('graphify src/');
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + 'graphify src/');
});

test('scan-throttle: rewrites the /graphify slash-command write form', () => {
  const prefix = expectedFullPrefix();
  if (!prefix) return;
  const r = runAvailable('/graphify update .');
  assert.ok(r.json);
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + '/graphify update .');
});

test('scan-throttle: `graphify query ...` (a read) is never rewritten', () => {
  const r = runAvailable('graphify query "where is X defined"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Idempotency (mutation-checked): only the EXACT, ANCHORED (startsWith) known
// prefix at the very start of the trimmed command counts as "already
// prefixed." A command that merely CONTAINS the prefix text later, or an
// almost-but-not-exactly-matching prefix, must NOT be treated as prefixed.
// ---------------------------------------------------------------------------
test('scan-throttle: idempotent — already-prefixed command is left unchanged', () => {
  const already = 'taskpolicy -c utility nice -n 19 graphify update .';
  const r = runAvailable(already);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'must not double-prefix an already-prefixed command');
});

test('scan-throttle: idempotent — bare `nice -n 19` prefix form is also recognized', () => {
  const already = 'nice -n 19 graphify update .';
  const r = runAvailable(already);
  assert.strictEqual(r.stdout.trim(), '');
});

test('scan-throttle: idempotent — `ionice -c 3 nice -n 19` combined prefix is recognized', () => {
  const already = 'ionice -c 3 nice -n 19 graphify update .';
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
  const command = 'graphify update . # note: nice -n 19 is what this becomes';
  const r = runAvailable(command);
  assert.ok(r.json, 'a command that only CONTAINS prefix-like text later must still be rewritten');
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput.command, prefix + command);
});

// ---------------------------------------------------------------------------
// Untouched: non-matching commands.
// ---------------------------------------------------------------------------
test('scan-throttle: unrelated command is left untouched', () => {
  const r = runAvailable('git status');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('scan-throttle: a command that merely mentions graphify as data is untouched', () => {
  const r = runAvailable('echo "run graphify update . later"');
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Heredoc (mutation-checked): a heredoc BODY that looks like a scan command is
// DATA, never re-parsed as a command segment.
// ---------------------------------------------------------------------------
test('scan-throttle: heredoc body containing a scan-looking line is untouched', () => {
  const command = "cat <<'EOF'\ngraphify update .\nEOF";
  const r = runAvailable(command);
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
  const command = "cat <<'EOF'\nsome body text\nEOF\n && graphify update .";
  const r = runAvailable(command);
  assert.strictEqual(r.status, 0);
  // Must not rewrite (mid-compound); may emit an advisory note instead.
  assert.strictEqual(r.stdout.includes('updatedInput'), false);
});

// ---------------------------------------------------------------------------
// Mid-compound: match exists but is not the first simple command -> untouched,
// advisory note only (fail-open — never guess a rewrite position).
// ---------------------------------------------------------------------------
test('scan-throttle: mid-compound match is untouched, with an advisory note', () => {
  const r = runAvailable('cd app && graphify update .');
  assert.strictEqual(r.status, 0);
  assert.ok(r.json, 'expected an advisory JSON note');
  assert.strictEqual(r.json.hookSpecificOutput.updatedInput, undefined);
  assert.ok(
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
});

// ---------------------------------------------------------------------------
// Kill switch.
// ---------------------------------------------------------------------------
test('scan-throttle: ANTI_HALL_SCAN_THROTTLE=0 disables the hook entirely', () => {
  const r = runAvailable('graphify update .', { ANTI_HALL_SCAN_THROTTLE: '0' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Tool unavailable -> unchanged, silently (no output at all).
// ---------------------------------------------------------------------------
test('scan-throttle: no throttle tool on PATH -> command left unchanged, no output', () => {
  const r = runUnavailable('graphify update .');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// ANTI_HALL_THROTTLE_PATTERNS env-extendable allowlist.
// ---------------------------------------------------------------------------
test('scan-throttle: ANTI_HALL_THROTTLE_PATTERNS extends the allowlist', () => {
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
  const r = runAvailable('');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});
