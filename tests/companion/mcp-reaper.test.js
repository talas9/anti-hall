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

// =====================================================================
// Codex app-server-broker class (additive, field report 2026-09-25, reworked
// after a BLOCKER: ~/.claude/plugins/cache/openai-codex/codex/*/scripts/lib/
// broker-lifecycle.mjs:64-67 spawns the broker `detached: true` + `unref()`
// ON PURPOSE, so PPID 1 is the NORMAL state for a LIVE, in-use broker — NOT
// evidence of death. This class therefore never gates on parent liveness; it
// proves abandonment via (a) the broker's --cwd no longer existing, or (b) no
// live claude/codex process owning a cwd at/under it — plus a conservative
// age floor. matchesMcp / findOrphans (the generic MCP class) are untouched.
// =====================================================================

const BROKER_CWD = '/Users/talas9/.devswarm/repos/0/11f7ff9d/fix-roster-image-only-message/skyflutter';
const REAL_BROKER_CMD =
  '/Users/talas9/.nvm/versions/node/v24.14.0/bin/node ' +
  '/Users/talas9/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs ' +
  'serve --endpoint unix:/var/folders/x/T/cxc-abc/broker.sock ' +
  `--cwd ${BROKER_CWD} ` +
  '--pid-file /var/folders/x/T/cxc-abc/broker.pid';

test('matchesCodexBroker: true for the real observed app-server-broker.mjs cmdline', () => {
  assert.ok(m.matchesCodexBroker(REAL_BROKER_CMD));
});

test('matchesCodexBroker: false for a similarly-named unrelated process (no /codex/ path segment)', () => {
  assert.ok(
    !m.matchesCodexBroker('/usr/local/bin/node /Users/x/myproject/scripts/app-server-broker.mjs serve')
  );
  // A path that merely CONTAINS "codex" as a substring but not as its own segment
  // (e.g. a project named "codex-tools") must not match either.
  assert.ok(
    !m.matchesCodexBroker('/usr/local/bin/node /Users/x/codex-tools/scripts/app-server-broker.mjs serve')
  );
  // A file that only mentions the script name (grep/log/editor) must not match.
  assert.ok(!m.matchesCodexBroker('grep app-server-broker.mjs /var/log/codex/history.log'));
  assert.ok(!m.matchesCodexBroker(''));
  assert.ok(!m.matchesCodexBroker(undefined));
});

test('extractBrokerCwd: parses the --cwd argument; null when absent', () => {
  assert.strictEqual(m.extractBrokerCwd(REAL_BROKER_CMD), BROKER_CWD);
  assert.strictEqual(m.extractBrokerCwd('node app-server-broker.mjs serve --endpoint x'), null);
});

test('hasLiveOwnerAtCwd: true when a live claude/codex process has that cwd (or a descendant)', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = (pid) => (pid === 500 ? BROKER_CWD : null);
  assert.ok(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf));
  const cwdOfSub = (pid) => (pid === 500 ? BROKER_CWD + '/nested' : null);
  assert.ok(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOfSub), 'a descendant cwd still counts as owned');
});

test('hasLiveOwnerAtCwd: false when no claude/codex process has that cwd', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => '/Users/talas9/some/other/project';
  assert.strictEqual(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf), false);
});

test('hasLiveOwnerAtCwd: fail-soft true when a candidate owner\'s cwd cannot be resolved', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => null; // lsof/proc lookup failed
  assert.strictEqual(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf), true);
});

// BLOCKER (2026-09-25): the real field case has the broker's --cwd INSIDE a git
// submodule (`<workspace>/skyflutter`) while the owning Claude session's cwd is the
// workspace ROOT — an ANCESTOR of the broker's --cwd, not the same dir or a
// descendant. A descendant-only check would have reaped that live broker.
test('hasLiveOwnerAtCwd: true when the owner is at an ANCESTOR dir (workspace root) of a submodule broker', () => {
  const workspaceRoot = '/Users/talas9/.devswarm/repos/0/11f7ff9d/fix-roster-image-only-message';
  const submoduleBrokerCwd = workspaceRoot + '/skyflutter';
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = (pid) => (pid === 500 ? workspaceRoot : null);
  assert.ok(
    m.hasLiveOwnerAtCwd(submoduleBrokerCwd, procs, cwdOf),
    'an owner at the workspace root must count as owning a broker in a submodule under it'
  );
});

test('isPathAncestorOrSame: segment-boundary-safe — /a/bc is NOT related to /a/b', () => {
  assert.strictEqual(m.isPathAncestorOrSame('/a/b', '/a/bc'), false);
  assert.strictEqual(m.isPathAncestorOrSame('/a/bc', '/a/b'), false);
  // Sanity: real ancestor/descendant/same relationships DO hold.
  assert.strictEqual(m.isPathAncestorOrSame('/a/b', '/a/b'), true);
  assert.strictEqual(m.isPathAncestorOrSame('/a/b', '/a/b/c'), true);
  assert.strictEqual(m.isPathAncestorOrSame('/a/b/c', '/a/b'), false);
});

test('hasLiveOwnerAtCwd: sibling-prefix path /a/bc does NOT count as owning a broker at /a/b', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = (pid) => (pid === 500 ? '/a/bc' : null); // sibling dir, shares a string prefix only
  assert.strictEqual(m.hasLiveOwnerAtCwd('/a/b', procs, cwdOf), false);
  // And the reverse direction: an owner at /a/b must not count for a broker at /a/bc.
  const cwdOfB = (pid) => (pid === 500 ? '/a/b' : null);
  assert.strictEqual(m.hasLiveOwnerAtCwd('/a/bc', procs, cwdOfB), false);
});

function agesOf(map) {
  return (pids) => new Map(pids.filter((p) => map.has(p)).map((p) => [p, map.get(p)]));
}

// ---- The 4 coordinator-required scenarios ----

test('findCodexBrokerOrphans: a LIVE broker (PPID 1, live claude owns its cwd) is NOT selected', () => {
  const procs = [
    { pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }, // live Claude session, PPID 1 too — normal
    { pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }, // detached+unref -> PPID 1 while ALIVE, by design
  ];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 999999]])), // very old, but still owned
    cwdOf: (pid) => (pid === 500 ? BROKER_CWD : null),
    existsSync: () => true,
  });
  assert.strictEqual(orphans.length, 0, 'PPID 1 must never be treated as evidence of death for this class');
});

test('findCodexBrokerOrphans: end-to-end submodule case — owner at the workspace root is NOT selected', () => {
  const workspaceRoot = '/Users/talas9/.devswarm/repos/0/11f7ff9d/fix-roster-image-only-message';
  const submoduleBrokerCmd =
    '/Users/talas9/.nvm/versions/node/v24.14.0/bin/node ' +
    '/Users/talas9/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs ' +
    'serve --endpoint unix:/var/folders/x/T/cxc-abc/broker.sock ' +
    `--cwd ${workspaceRoot}/skyflutter ` +
    '--pid-file /var/folders/x/T/cxc-abc/broker.pid';
  const procs = [
    { pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }, // owning session cwd = workspace ROOT
    { pid: 2000, ppid: 1, cmd: submoduleBrokerCmd }, // broker --cwd = a SUBMODULE under that root
  ];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 999999]])), // well past the age floor
    existsSync: () => true,
    cwdOf: (pid) => (pid === 500 ? workspaceRoot : null),
  });
  assert.strictEqual(orphans.length, 0, 'an owner at an ancestor dir must block the reap');
});

test('findCodexBrokerOrphans: a broker whose --cwd is gone IS selected', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false, // worktree removed/archived
    cwdOf: () => null, // must not even need the owner-process check for proof (a)
  });
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].pid, 2000);
});

test('findCodexBrokerOrphans: cwd exists but no owner process, and old enough, IS selected', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])), // 1h, past the 30min floor
    existsSync: () => true,
    cwdOf: () => '/Users/talas9/some/unrelated/project', // no claude/codex process owns it
  });
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].pid, 2000);
});

test('findCodexBrokerOrphans: a YOUNG abandoned-looking broker is NOT selected', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 5]])), // 5s old, well below the 30min floor
    existsSync: () => false, // cwd gone, but too young -> still not selected
    cwdOf: () => null,
  });
  assert.strictEqual(orphans.length, 0);
});

// ---- Additional safety-net coverage ----

test('findCodexBrokerOrphans: a similarly-named unrelated process is NOT selected', () => {
  const procs = [
    { pid: 2000, ppid: 1, cmd: '/usr/local/bin/node /Users/x/myproject/scripts/app-server-broker.mjs --cwd /Users/x/myproject serve' },
  ];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
  });
  assert.strictEqual(orphans.length, 0);
});

test('findCodexBrokerOrphans: disabled (enabled:false) selects nothing, even a textbook orphan', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: false,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
  });
  assert.strictEqual(orphans.length, 0);
});

test('findCodexBrokerOrphans: unresolvable age (getAgesForPids omits the pid) is skipped, never reaped', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map()), // age unknown
    existsSync: () => false,
    cwdOf: () => null,
  });
  assert.strictEqual(orphans.length, 0);
});

test('findCodexBrokerOrphans: no getAgesForPids available (settings.js/hook require failed) skips all', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: null,
    existsSync: () => false,
  });
  assert.strictEqual(orphans.length, 0);
});

test('findCodexBrokerOrphans: cwd exists and no cwdOf runner provided -> unresolvable, skipped', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => true, // cwd still exists -> must fall through to the owner-process
    // check, but no cwdOf runner is given -> can't verify -> must skip, not reap
  });
  assert.strictEqual(orphans.length, 0);
});

test('findCodexBrokerOrphans: unparseable --cwd is skipped, never reaped', () => {
  const procs = [
    { pid: 2000, ppid: 1, cmd: 'node .../app-server-broker.mjs serve --endpoint unix:/tmp/x.sock' }, // no --cwd
  ];
  const orphans = m.findCodexBrokerOrphans(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
  });
  assert.strictEqual(orphans.length, 0);
});

test('exports include the codex-broker class', () => {
  assert.strictEqual(typeof m.matchesCodexBroker, 'function');
  assert.strictEqual(typeof m.extractBrokerCwd, 'function');
  assert.strictEqual(typeof m.isPathAncestorOrSame, 'function');
  assert.strictEqual(typeof m.hasLiveOwnerAtCwd, 'function');
  assert.strictEqual(typeof m.findCodexBrokerOrphans, 'function');
  assert.strictEqual(typeof m.defaultCwdOf, 'function');
  assert.strictEqual(m.DEFAULT_CODEX_BROKER_MIN_AGE_S, 1800);
});
