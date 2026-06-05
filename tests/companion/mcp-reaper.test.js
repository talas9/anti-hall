'use strict';
// mcp-reaper pure-function tests. No real ps, no real kills — synthetic ps tables.
// The KEY tests are findOrphans: parent==reaper => orphan; same MCP under a LIVE
// spawner => NOT flagged (false-positive prevention); Linux systemd --user (ppid!=1)
// MUST be caught (regression vs a ppid==1-only host script).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'mcp-reaper.js');
const m = require(MOD);

test('require is side-effect-free (no ps, no kill; exports present)', () => {
  // If require() ran main(), it would have called process.exit — reaching here proves it did not.
  assert.deepStrictEqual(
    ['parsePs', 'isReaperParent', 'matchesMcp', 'findOrphans'].every((k) => typeof m[k] === 'function'),
    true
  );
});

test('parsePs parses pid/ppid/cmd lines and ignores junk', () => {
  const stdout = [
    '  100     1 /usr/bin/node /x/server-mcp --stdio',
    '  200   100 npm exec foo-mcp',
    'garbage line with no leading pid',
    '',
  ].join('\n');
  const rows = m.parsePs(stdout);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { pid: 100, ppid: 1, cmd: '/usr/bin/node /x/server-mcp --stdio' });
  assert.deepStrictEqual(rows[1], { pid: 200, ppid: 100, cmd: 'npm exec foo-mcp' });
});

test('matchesMcp: true for genuine MCP signatures', () => {
  assert.ok(m.matchesMcp('node @modelcontextprotocol/server-x'));
  assert.ok(m.matchesMcp('node mcp-server.js'));
  assert.ok(m.matchesMcp('node mcp start')); // runtime argv0 + discrete `mcp start` token
  assert.ok(m.matchesMcp('node server-sequential-thinking'));
  // NOTE (FIX 3): `npm exec foo-mcp` and a bare `... mcp --stdio` no longer match —
  // those over-broad rules were the false-positive vector and were intentionally
  // dropped. False negatives are safe; killing a live MCP is the only danger.
});

test('matchesMcp: false for non-MCP and for our own reaper line', () => {
  assert.ok(!m.matchesMcp('node app.js'));
  assert.ok(!m.matchesMcp('/Applications/Visual Studio Code.app vscode'));
  assert.ok(!m.matchesMcp('node /path/mcp-reaper.js')); // never match ourselves
  assert.ok(!m.matchesMcp(''));
  assert.ok(!m.matchesMcp(undefined));
});

test('matchesMcp: ANTIHALL_REAPER_MATCH extra regex extends', () => {
  const extra = /custom-thing/i;
  assert.ok(!m.matchesMcp('node custom-thing'));
  assert.ok(m.matchesMcp('node custom-thing', extra));
});

test('isReaperParent: true for pid 1, systemd --user, launchd, Relay()', () => {
  assert.ok(m.isReaperParent(1, 'anything'));
  assert.ok(m.isReaperParent(900, '/lib/systemd/systemd --user'));
  assert.ok(m.isReaperParent(901, '/sbin/launchd'));
  assert.ok(m.isReaperParent(902, '/init Relay(123)'));
});

test('isReaperParent: false for a live spawner', () => {
  assert.ok(!m.isReaperParent(500, 'node /Users/x/.claude/cli.js'));
  assert.ok(!m.isReaperParent(501, 'npm exec @modelcontextprotocol/server-x')); // a live spawner
});

// ---- THE KEY SAFETY TESTS ----

test('findOrphans: MCP under reaper (systemd --user, ppid!=1) IS flagged (Linux regression)', () => {
  const procs = [
    { pid: 900, ppid: 1, cmd: '/lib/systemd/systemd --user' },
    { pid: 1000, ppid: 900, cmd: 'node @modelcontextprotocol/server-x --stdio' },
  ];
  const orphans = m.findOrphans(procs);
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].pid, 1000);
});

test('findOrphans: SAME MCP under a LIVE spawner is NOT flagged (false-positive prevention)', () => {
  const procs = [
    { pid: 500, ppid: 1, cmd: 'node /Users/x/.claude/cli.js' }, // live session
    { pid: 1000, ppid: 500, cmd: 'node @modelcontextprotocol/server-x --stdio' },
  ];
  const orphans = m.findOrphans(procs);
  assert.strictEqual(orphans.length, 0, 'a live MCP under a live spawner must never be reaped');
});

test('findOrphans: MCP with ppid==1 IS flagged (even when pid 1 absent from snapshot)', () => {
  const procs = [{ pid: 1000, ppid: 1, cmd: 'npx @modelcontextprotocol/server-foo --stdio' }];
  const orphans = m.findOrphans(procs);
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].pid, 1000);
});

test('findOrphans: non-MCP proc under a reaper parent is NOT flagged', () => {
  const procs = [
    { pid: 900, ppid: 1, cmd: '/lib/systemd/systemd --user' },
    { pid: 1001, ppid: 900, cmd: 'node app.js' }, // not MCP
  ];
  const orphans = m.findOrphans(procs);
  assert.strictEqual(orphans.length, 0);
});

// FIX 2: parent absent from a (non-atomic / possibly truncated) ps snapshot is UNSURE,
// not proof of death. Unsure -> skip. A truly reparented orphan has ppid rewritten to
// 1/reaper and is caught by the normal branch, so no real orphan is lost.
test('findOrphans: parent missing from list -> UNSURE -> NOT flagged (snapshot race safety)', () => {
  const procs = [{ pid: 1000, ppid: 777, cmd: 'node server-sequential-thinking/dist/index.js' }];
  const orphans = m.findOrphans(procs);
  assert.strictEqual(orphans.length, 0, 'absent parent line is unsure, must not be reaped');
});

// =====================================================================
// FIX 1 — isReaperParent anchors to the parent argv0 BASENAME, not substring
// =====================================================================

test('FIX1 isReaperParent: LIVE parents with init/claude in a PATH are NOT reapers', () => {
  // These would have been mis-flagged by the old substring REAPER_CMD_RE -> child killed.
  assert.ok(!m.isReaperParent(500, 'node /opt/app/scripts/init.js --serve'));
  assert.ok(!m.isReaperParent(501, 'node /home/u/proj/init/index.js'));
  assert.ok(!m.isReaperParent(502, 'node /home/u/.local/bin/claude'));
  assert.ok(!m.isReaperParent(503, '/usr/bin/npm exec @modelcontextprotocol/inspector'));
});

test('FIX1 isReaperParent: genuine reapers (basename / pid1 / Relay / systemd --user) ARE reapers', () => {
  assert.ok(m.isReaperParent(1, 'literally anything'));     // pid 1 always
  assert.ok(m.isReaperParent(900, '/sbin/launchd'));
  assert.ok(m.isReaperParent(901, 'launchd'));
  assert.ok(m.isReaperParent(902, '/lib/systemd/systemd --user'));
  assert.ok(m.isReaperParent(903, '/usr/lib/systemd/systemd --user'));
  assert.ok(m.isReaperParent(904, 'Relay(123)'));
});

test('FIX1 isReaperParent: system-wide systemd WITHOUT --user is NOT a reaper basename', () => {
  // (pid-1 systemd is already covered by the pid===1 rule; a non-pid-1 systemd w/o
  //  --user is not a per-user subreaper.)
  assert.ok(!m.isReaperParent(905, '/lib/systemd/systemd'));
});

// findOrphans end-to-end: live parent with init.js in path must NOT yield an orphan.
test('FIX1 findOrphans: MCP under LIVE parent whose path contains init.js is NOT flagged', () => {
  const procs = [
    { pid: 500, ppid: 1, cmd: 'node /opt/app/scripts/init.js --serve' }, // live spawner
    { pid: 1000, ppid: 500, cmd: 'node @modelcontextprotocol/server-x --stdio' },
  ];
  assert.strictEqual(m.findOrphans(procs).length, 0);
});

// =====================================================================
// FIX 3 — matchesMcp must not match ordinary tools that merely mention "mcp"
// =====================================================================

test('FIX3 matchesMcp: NON-MCP strings that merely mention mcp are FALSE', () => {
  assert.ok(!m.matchesMcp('vim mcp-server.js'));
  assert.ok(!m.matchesMcp('tail -f mcp-server.log'));
  assert.ok(!m.matchesMcp('grep mcp-server /var/log/syslog'));
  assert.ok(!m.matchesMcp('node build-mcp-server.js --watch')); // no boundary before mcp
  assert.ok(!m.matchesMcp('npm exec eslint . mcp config'));
  assert.ok(!m.matchesMcp('python train.py --mcp --stdio'));    // dropped bare --stdio rule
  assert.ok(!m.matchesMcp('less ~/notes/mcp start.md'));
});

test('FIX3 matchesMcp: REAL MCP strings are TRUE', () => {
  assert.ok(m.matchesMcp('npx @modelcontextprotocol/server-foo --stdio'));
  assert.ok(m.matchesMcp('node /path/mcp-server-everything/index.js'));
  assert.ok(m.matchesMcp('node mcp-server.js'));
  assert.ok(m.matchesMcp('mcp-server-everything'));             // token is argv0
  assert.ok(m.matchesMcp('node server-sequential-thinking/dist/index.js'));
});

// =====================================================================
// FIX A — drop the `init` basename branch: a LIVE daemon argv0-named `init`
// (pid != 1) must NOT be classified as a reaper.
// =====================================================================

test('FIXA isReaperParent: LIVE daemon basenamed init (pid!=1) is NOT a reaper', () => {
  assert.ok(!m.isReaperParent(500, '/opt/init --serve'));
  assert.ok(!m.isReaperParent(501, 'init --serve')); // bare basename, still pid!=1
});

test('FIXA isReaperParent: real SysV init at pid 1 IS still a reaper (via pid-1 rule)', () => {
  assert.ok(m.isReaperParent(1, '/sbin/init'));
});

test('FIXA findOrphans: MCP under LIVE parent /opt/init (pid!=1) is NOT flagged', () => {
  const procs = [
    { pid: 500, ppid: 1, cmd: '/opt/init --serve' }, // live custom daemon, not a reaper
    { pid: 1000, ppid: 500, cmd: 'node @modelcontextprotocol/server-x --stdio' },
  ];
  assert.strictEqual(m.findOrphans(procs).length, 0);
});

// =====================================================================
// FIX B — match Python / uv-based MCP servers (uvx/uv runtimes, mcp_server_ form)
// =====================================================================

test('FIXB matchesMcp: uv / uvx / python -m Python MCP servers are TRUE', () => {
  assert.ok(m.matchesMcp('uvx mcp-server-fetch'));
  assert.ok(m.matchesMcp('python -m mcp_server_time'));
  assert.ok(m.matchesMcp('uv run mcp_server_git'));
});

// =====================================================================
// FIX C — ANTIHALL_REAPER_EXCLUDE opt-out: an excluded orphan is never reaped,
// a non-excluded orphan in the same list still is.
// =====================================================================

test('FIXC findOrphans: excludeRe skips matching orphans, keeps others', () => {
  const procs = [
    { pid: 1000, ppid: 1, cmd: 'node @modelcontextprotocol/server-keep --stdio' },
    { pid: 1001, ppid: 1, cmd: 'node @modelcontextprotocol/server-mine --stdio' },
  ];
  const excludeRe = /server-mine/i;
  const orphans = m.findOrphans(procs, undefined, excludeRe);
  assert.strictEqual(orphans.length, 1, 'only the non-excluded orphan is flagged');
  assert.strictEqual(orphans[0].pid, 1000);
});

// =====================================================================
// argv0Basename — direct unit coverage of the exported pure helper that
// underpins matchesMcp + isReaperParent. (run-section audit gap A.)
// =====================================================================

test('argv0Basename: strips dir of first whitespace-delimited token', () => {
  assert.strictEqual(m.argv0Basename('/usr/bin/node /x/s.js'), 'node');
  assert.strictEqual(m.argv0Basename('/usr/bin/python3 -m mcp_server_time'), 'python3');
});

test('argv0Basename: leading whitespace is trimmed before splitting', () => {
  assert.strictEqual(m.argv0Basename('   /usr/local/bin/uvx mcp-server-fetch'), 'uvx');
  assert.strictEqual(m.argv0Basename('\t\n  node app.js'), 'node');
});

test('argv0Basename: empty / undefined / null -> empty string', () => {
  assert.strictEqual(m.argv0Basename(''), '');
  assert.strictEqual(m.argv0Basename(undefined), '');
  assert.strictEqual(m.argv0Basename(null), '');
});

test('argv0Basename: no-slash argv0 returned as-is', () => {
  assert.strictEqual(m.argv0Basename('nodewithoutslash --flag'), 'nodewithoutslash');
  assert.strictEqual(m.argv0Basename('launchd'), 'launchd');
});

test('argv0Basename: trailing-slash token has empty basename', () => {
  // basename of `/only/path/` strips everything after the last slash -> ''.
  assert.strictEqual(m.argv0Basename('/only/path/ arg'), '');
});

// =====================================================================
// Truncation guard (mcp-reaper.js enumerate() r.signal -> return []).
// enumerate() is NOT exported (it owns the spawnSync of `ps`), so the guard
// itself cannot be invoked as a unit without spawning a real process. We
// instead pin the OBSERVABLE contract the guard protects: findOrphans over a
// partial/truncated proc list must never kill on an absent (non-pid-1) parent.
// A truncated `ps` (the maxBuffer/SIGTERM case the guard catches) can only
// drop lines; the dropped-parent path below proves that even if the guard were
// bypassed and a partial list leaked through, no live MCP would be reaped —
// the guard is belt-and-suspenders on top of this invariant.
// (run-section audit gap A: r.signal guard — covered at the seam, see report.)
// =====================================================================

test('truncation-safety: partial list with a dropped non-pid-1 parent yields NO orphan', () => {
  // Simulates what a truncated `ps` would look like: the MCP's real live parent
  // line (pid 500) was cut off, leaving an orphan-looking row whose parent is absent.
  const truncated = [
    { pid: 1000, ppid: 500, cmd: 'node @modelcontextprotocol/server-x --stdio' },
  ];
  assert.strictEqual(m.findOrphans(truncated).length, 0,
    'a truncated snapshot that drops the live parent must not cause a kill');
});
