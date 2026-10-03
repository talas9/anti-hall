'use strict';
// B3 fix: devswarm-parent-gate.js's own UNANSWERED QUESTION remediation text
// used to teach the shell-unsafe `send --to <id> --message "..."` form —
// exactly the form whose mangling users hit is caller-side shell expansion
// (`--message "$(cat file)"` in THEIR shell), not anything `cmdSend` does
// (it reads argv/fd-0 and writes via a parameterized sqlite INSERT — no
// exec, no shell:true). `--message-file <path>` / `--message-stdin` (shipped
// v0.77.0, scripts/devswarm.js) bypass shell quoting entirely and are the
// safer form to teach.
//
// This is a STATIC content check (not a spawned-hook behavioral test) —
// deliberate: tests/hooks/devswarm-parent-gate.test.js already owns the full
// spawned-hook behavioral suite for this file and is intentionally left
// untouched by this change (owner instruction). This file only proves the
// remediation STRING itself was fixed, independent of that suite.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const GATE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-gate.js');

// B3 MUTATION-CHECK (killed):
//   1. Revert to the pre-fix `--message "..."` string (no --message-file) ->
//      fails on the `includes('--message-file')` assertion. This is also the
//      RED baseline verified against the pre-fix source.
//   2. Append `--message "..."` alongside `--message-file <path>` (partial
//      revert, e.g. a bad merge leaving both forms) -> fails on the
//      `!fnBody.includes('--message "')` assertion.
test('B3: devswarm-parent-gate.js UNANSWERED QUESTION remediation teaches --message-file, not --message "..."', () => {
  const src = fs.readFileSync(GATE_PATH, 'utf8');
  const fnStart = src.indexOf('function buildUnansweredSegment');
  assert.ok(fnStart !== -1, 'buildUnansweredSegment must exist in devswarm-parent-gate.js');
  const fnEnd = src.indexOf('\n}', fnStart);
  const fnBody = src.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('--message-file'), `remediation must teach --message-file; body=${fnBody}`);
  assert.ok(!fnBody.includes('--message "'), `remediation must NOT teach the shell-unsafe --message " form; body=${fnBody}`);
});
