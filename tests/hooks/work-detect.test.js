'use strict';
// hooks/lib/work-detect.js — the shared "what counts as a file-changing
// action" primitive (tasklist-guard.js + handover-freshness.js).
//
// defect T4(b) (7-workspace sweep, 2026-09-27): a Bash command that is ONLY
// anti-hall's own DevSwarm mesh housekeeping (the stable launcher's inbox/
// heartbeat/send/roster verbs, or a `crontab` install/check for the
// mailbox-wake cron job) must never count as file-changing work, the same
// way scratchpad-only traffic already doesn't. Agent/Task/CronCreate/
// CronDelete tool_uses (spawn/schedule actions, not file mutations) must
// never count either.

const { test } = require('node:test');
const assert = require('node:assert');
const wd = require('../../plugins/anti-hall/hooks/lib/work-detect.js');

test('isDevswarmHousekeepingOnly: a chained inbox pull && inbox ack is housekeeping-only', () => {
  assert.strictEqual(
    wd.isDevswarmHousekeepingOnly('node /x/devswarm.js inbox pull child-1 && node /x/devswarm.js inbox ack child-1'),
    true
  );
});

test('isDevswarmHousekeepingOnly: a crontab read/install for the mailbox-wake cron is housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('crontab -l > /tmp/cron.txt'), true);
});

test('isDevswarmHousekeepingOnly: a devswarm verb chained with GENUINE other work is NOT housekeeping-only', () => {
  assert.strictEqual(
    wd.isDevswarmHousekeepingOnly('node /x/devswarm.js heartbeat child-1 --summary "x" && rm -rf /project/file.txt'),
    false
  );
});

test('isDevswarmHousekeepingOnly: an unrelated command is not housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('git commit -am "fix bug"'), false);
});

test('isCountedWork: a crontab mailbox-wake install does not count as work', () => {
  assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: 'crontab -l > /tmp/cron.txt' } }), false);
});

test('isCountedWork: devswarm stable-launcher inbox pull/ack chain does not count as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node /x/devswarm.js inbox pull child-1 && node /x/devswarm.js inbox ack child-1' } }),
    false
  );
});

test('isCountedWork: a housekeeping verb chained with a genuine mutation still counts', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node /x/devswarm.js heartbeat child-1 --summary "x" && rm -rf /project/file.txt' } }),
    true
  );
});

test('isCountedWork: a genuine git commit still counts (regression guard)', () => {
  assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: 'git commit -am "fix bug"' } }), true);
});

test('isCountedWork: Agent/Task/CronCreate/CronDelete tool_uses never count', () => {
  for (const name of ['Agent', 'Task', 'CronCreate', 'CronDelete']) {
    assert.strictEqual(wd.isCountedWork({ name, input: { prompt: 'do something' } }), false, `${name} must not count`);
  }
});

// R2A1-WD-1 / R2-RV1-9: crontab is housekeeping only at command position, and
// a newline or a lone background `&` separates segments like `;` does, so real
// work that merely mentions crontab, or rides after a housekeeping verb on a
// new line / after `&`, still counts.
for (const cmd of [
  'node ~/.anti-hall/bin/devswarm.js heartbeat x --summary hi\nsed -i s/a/b/ src/app.js',
  'node ~/.anti-hall/bin/devswarm.js heartbeat x & sed -i s/a/b/ src/app.js',
  "sed -i 's/a/b/' deploy/crontab.txt",
  'git commit -am "tidy crontab docs"',
  'rm -rf build/crontab-cache',
  'npm install crontab-parser',
  'git commit -m "add crontab entry"',
  'echo x > docs/crontab.md',
  'sed -i s/a/b/ scripts/crontab.sh',
]) {
  test(`isCountedWork: real work is counted — ${JSON.stringify(cmd)}`, () => {
    assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: cmd } }), true);
  });
}

test('isDevswarmHousekeepingOnly: `2>&1` is a redirection, not a background separator', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('node ~/.anti-hall/bin/devswarm.js inbox tick x 2>&1'), true);
});

test('isDevswarmHousekeepingOnly: a crontab install in a leading subshell stays housekeeping', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('(crontab -l 2>/dev/null) | crontab -'), true);
});

// defect 4b (peer sweep, 0.116 candidate): tasklist-guard's own required
// bookkeeping (appends to .anti-hall/progress|history/*, which the guard
// itself directs agents to write) and scratch copies outside the repo (an
// os.tmpdir()-rooted scratch copy, not just the literal session scratchpad)
// must not be counted as file-changing work. devswarm.js inbox ack/heartbeat
// are already excluded via isDevswarmHousekeepingOnly (T4(b)/aefb82c —
// verified above); this block covers the two NEW exclusions.

test('isCountedWork: an Edit into the repo .anti-hall/progress dir is NOT counted as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Edit', input: { file_path: '/Users/x/proj/.anti-hall/progress/2026-09-27/sess1.md' } }),
    false
  );
});

test('isCountedWork: a Write into the repo .anti-hall/history dir is NOT counted as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Write', input: { file_path: '/Users/x/proj/.anti-hall/history/2026-09-27/sess1.md' } }),
    false
  );
});

test('isCountedWork: a bash append to .anti-hall/progress is NOT counted as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'echo "did stuff" >> /Users/x/proj/.anti-hall/progress/2026-09-27/sess1.md' } }),
    false
  );
});

test('isCountedWork: an Edit into a real repo file (NOT .anti-hall state) still counts (regression guard)', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Edit', input: { file_path: '/Users/x/proj/src/app.js' } }),
    true
  );
});

// R3A1-WD-1: a segment that matches the housekeeping-verb anchor at ITS START
// can still do real project work via a trailing redirect or a nested command
// substitution — that must not be swallowed just because the segment opens
// with `crontab` or a devswarm verb. Judged per segment: any real work
// anywhere in the command counts.
test('isDevswarmHousekeepingOnly: a crontab segment redirecting to a project file is NOT housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('crontab -l > src/app.js'), false);
});

test('isDevswarmHousekeepingOnly: a crontab segment with a nested command substitution doing real work is NOT housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('crontab -l $(sed -i s/a/b/ src/x.js)'), false);
});

test('isDevswarmHousekeepingOnly: a devswarm-verb segment redirecting to a project file is NOT housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('node ~/.anti-hall/bin/devswarm.js roster > README.md'), false);
});

test('isCountedWork: crontab chained with a redirect into a project file counts as work', () => {
  assert.strictEqual(wd.isCountedWork({ name: 'Bash', input: { command: 'crontab -l > src/app.js' } }), true);
});

test('isCountedWork: crontab with a nested real-work command substitution counts as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'crontab -l $(sed -i s/a/b/ src/x.js)' } }),
    true
  );
});

test('isCountedWork: a Write into a scratch copy under os.tmpdir() outside the repo is NOT counted as work', () => {
  const os = require('os');
  const path = require('path');
  const fp = path.join(os.tmpdir(), 'ghidra-copy', 'binary.c');
  assert.strictEqual(wd.isCountedWork({ name: 'Write', input: { file_path: fp } }), false);
});

test('isCountedWork: a bash cp into an os.tmpdir() scratch copy is NOT counted as work', () => {
  const os = require('os');
  const path = require('path');
  const a = path.join(os.tmpdir(), 'ghidra-copy', 'a.c');
  const b = path.join(os.tmpdir(), 'ghidra-copy', 'b.c');
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'cp ' + a + ' ' + b } }),
    false
  );
});

test('isCountedWork: a bash cp FROM os.tmpdir() scratch TO a real repo file still counts (regression guard)', () => {
  const os = require('os');
  const path = require('path');
  const a = path.join(os.tmpdir(), 'ghidra-copy', 'a.c');
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'cp ' + a + ' /Users/x/proj/src/a.c' } }),
    true
  );
});

test('isCountedWork: devswarm roster redirected into a project file counts as work', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node ~/.anti-hall/bin/devswarm.js roster > README.md' } }),
    true
  );
});

// Verify devswarm.js inbox ack / heartbeat exclusion already holds (no
// regression from the fix above).
test('isCountedWork: devswarm.js inbox ack is NOT counted as work (pre-existing T4(b) exclusion, verified)', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node ~/.anti-hall/bin/devswarm.js inbox ack child-1' } }),
    false
  );
});

test('isCountedWork: devswarm.js heartbeat is NOT counted as work (pre-existing T4(b) exclusion, verified)', () => {
  assert.strictEqual(
    wd.isCountedWork({ name: 'Bash', input: { command: 'node ~/.anti-hall/bin/devswarm.js heartbeat child-1' } }),
    false
  );
});

// Regression guard: the legitimate mailbox-wake crontab install shape (redirect
// target is an OS tmp path, not a project file) must stay housekeeping-only —
// re-asserted alongside the escape cases so a future change can't silently
// widen the escape check to swallow this too.
test('isDevswarmHousekeepingOnly: crontab redirecting to an OS tmp path stays housekeeping-only', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly('crontab -l > /tmp/cron.txt'), true);
});

// L6(b): crash-recovery bookkeeping (.anti-hall/handovers/**, and cwd-relative
// .anti-hall/progress|history paths) never counts; a mixed command still does.
test('isCountedWork: handovers/progress/history bookkeeping (absolute or relative) is NOT work', () => {
  const B = (command) => ({ name: 'Bash', input: { command } });
  const w = (p) => wd.isCountedWork({ name: 'Write', input: { file_path: p } });
  assert.strictEqual(w('/Users/x/proj/.anti-hall/handovers/2026-09-30/sid/HANDOVER.md'), false);
  assert.strictEqual(wd.isCountedWork(B('echo hi >> .anti-hall/handovers/2026-09-30/sid/HANDOVER.md')), false);
  assert.strictEqual(wd.isCountedWork(B('echo hi >> /Users/x/proj/.anti-hall/handovers/d/s/HANDOVER.md')), false);
  assert.strictEqual(wd.isCountedWork(B('echo hi >> .anti-hall/progress/2026-09-30/sid.md')), false);
  assert.strictEqual(wd.isCountedWork(B('echo hi >> .anti-hall/history/2026-09-30/sid.md')), false);
});

test('isCountedWork: bookkeeping chained with a real project write, or a lookalike path, still counts', () => {
  const B = (command) => ({ name: 'Bash', input: { command } });
  assert.strictEqual(wd.isCountedWork(B('echo a >> .anti-hall/handovers/d/s/H.md && echo b >> src/app.js')), true);
  assert.strictEqual(wd.isCountedWork(B('echo a >> x.anti-hall/handovers/d/s/H.md')), true);
  assert.strictEqual(wd.isCountedWork({ name: 'Write', input: { file_path: '/Users/x/proj/.anti-hall/other/f.md' } }), true);
});

// L18 (2): a multi-line mesh message handed over via heredoc is DATA, not work.
const bashWork = (command) => wd.isCountedWork({ name: 'Bash', input: { command } });
const LAUNCHER = 'node ~/.anti-hall/bin/devswarm.js';

test('heredoc-fed devswarm send with arrow prose in the body is not counted work', () => {
  assert.strictEqual(bashWork(LAUNCHER + ' send primary <<\'EOF\'\nstep a -> step b\nEOF'), false);
});

test('devswarm relay/notice/nudge are comms verbs (not work)', () => {
  assert.strictEqual(wd.isDevswarmHousekeepingOnly(LAUNCHER + ' relay a b'), true);
  assert.strictEqual(wd.isDevswarmHousekeepingOnly(LAUNCHER + ' notice x'), true);
  assert.strictEqual(wd.isDevswarmHousekeepingOnly(LAUNCHER + ' nudge x'), true);
});

test('heredoc stripping fails closed: expansion in body, command after terminator, quoted << and redirects still count', () => {
  assert.strictEqual(bashWork(LAUNCHER + ' send primary <<EOF\nhi $(sed -i s/a/b/ f)\nEOF'), true);
  assert.strictEqual(bashWork(LAUNCHER + ' send primary <<EOF\nhi\nEOF\nsed -i s/a/b/ f'), true);
  assert.strictEqual(bashWork(LAUNCHER + ' send x "a <<EOF"\nsed -i s/a/b/ f'), true);
  assert.strictEqual(bashWork(LAUNCHER + ' relay a b > src/x.js'), true);
});

test('a << after an unquoted # is a comment, not a heredoc: the lines below it are real commands and count as work', () => {
  assert.strictEqual(bashWork(LAUNCHER + ' send primary # <<EOF\nsed -i s/a/b/ f\nEOF'), true);
  assert.strictEqual(bashWork(LAUNCHER + ' roster # note <<"EOF"\nrm -f src/a.js\nEOF'), true);
  // controls: a real heredoc (incl. a # inside the body or a quoted/mid-word #) is still data
  assert.strictEqual(bashWork(LAUNCHER + " send primary <<'EOF'\n# heading -> x\nEOF"), false);
  assert.strictEqual(bashWork(LAUNCHER + ' send primary "a # b" <<EOF\nstep a -> step b\nEOF'), false);
  assert.strictEqual(bashWork(LAUNCHER + ' send primary a#b <<EOF\nstep a -> step b\nEOF'), false);
});
