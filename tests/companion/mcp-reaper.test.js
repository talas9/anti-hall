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
// Codex app-server-broker class: REPORT-ONLY, NEVER KILLED (field report
// 2026-09-25; reworked twice after BLOCKERs, then made report-only after a
// safety review found 2 P1s):
//   - PPID 1 is the NORMAL state for a LIVE broker (spawned detached+unref
//     ON PURPOSE — ~/.claude/plugins/cache/openai-codex/codex/*/scripts/lib/
//     broker-lifecycle.mjs:64-67), so this class never gates on parent
//     liveness at all.
//   - P1: an earlier \S+ --cwd parse truncated a path containing a space
//     (`/Users/x/My Proj` -> `/Users/x/My`), misreading a live broker's cwd
//     as gone.
//   - P1: comparing raw (non-realpath'd) path strings missed e.g.
//     `--cwd /tmp/proj` vs an owner's OS-reported `/private/tmp/proj`.
//   - P2: the broker's own `codex app-server` child always matched as an
//     "owner" (it inherits the broker's cwd), so real orphans were almost
//     never detected.
// The DECISION for 0.109.0: detect + list only, via findAbandonedCodexBrokers
// — its output NEVER reaches findOrphans / the SIGTERM / SIGKILL passes in
// main(). matchesMcp / findOrphans (the generic, killable MCP class) are
// completely untouched by any of this.
// =====================================================================

const BROKER_CWD = '/Users/talas9/.devswarm/repos/0/11f7ff9d/fix-roster-image-only-message/skyflutter';
const REAL_BROKER_CMD =
  '/Users/talas9/.nvm/versions/node/v24.14.0/bin/node ' +
  '/Users/talas9/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs ' +
  'serve --endpoint unix:/var/folders/x/T/cxc-abc/broker.sock ' +
  `--cwd ${BROKER_CWD} ` +
  '--pid-file /var/folders/x/T/cxc-abc/broker.pid';

// A realpathSync stub where every path resolves to itself (the common case: no symlinks
// involved). Tests that need a symlink mismatch override this per-test.
function identityRealpath(p) {
  return p;
}

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

// ---- P1 fix #1: --cwd paths containing spaces ----

test('extractBrokerCwd: a --cwd path containing a SPACE is captured whole, not truncated (P1 fix)', () => {
  const cmd =
    'node /x/codex/1.0.6/scripts/app-server-broker.mjs serve ' +
    '--endpoint unix:/tmp/x.sock --cwd /Users/x/My Proj --pid-file /tmp/x.pid';
  assert.strictEqual(m.extractBrokerCwd(cmd), '/Users/x/My Proj');
});

test('extractBrokerCwd: a --cwd with no trailing flag captures to end of string', () => {
  assert.strictEqual(m.extractBrokerCwd('node app-server-broker.mjs serve --cwd /a/b/c'), '/a/b/c');
});

test('extractBrokerCwd: parses the --cwd argument; null when absent', () => {
  assert.strictEqual(m.extractBrokerCwd(REAL_BROKER_CMD), BROKER_CWD);
  assert.strictEqual(m.extractBrokerCwd('node app-server-broker.mjs serve --endpoint x'), null);
});

test('hasLiveOwnerAtCwd: true when a live claude/codex process has that cwd (or a descendant)', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = (pid) => (pid === 500 ? BROKER_CWD : null);
  assert.ok(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: identityRealpath }));
  const cwdOfSub = (pid) => (pid === 500 ? BROKER_CWD + '/nested' : null);
  assert.ok(
    m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOfSub, { realpathSync: identityRealpath }),
    'a descendant cwd still counts as owned'
  );
});

test('hasLiveOwnerAtCwd: false when no claude/codex process has that cwd', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => '/Users/talas9/some/other/project';
  assert.strictEqual(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: identityRealpath }), false);
});

test('hasLiveOwnerAtCwd: fail-soft true when a candidate owner\'s cwd cannot be resolved', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => null; // lsof/proc lookup failed
  assert.strictEqual(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: identityRealpath }), true);
});

test('hasLiveOwnerAtCwd: fail-soft true when the broker\'s own cwd cannot be realpathed', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => BROKER_CWD;
  const throwingRealpath = () => {
    throw new Error('EACCES');
  };
  assert.strictEqual(m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: throwingRealpath }), true);
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
    m.hasLiveOwnerAtCwd(submoduleBrokerCwd, procs, cwdOf, { realpathSync: identityRealpath }),
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
  assert.strictEqual(m.hasLiveOwnerAtCwd('/a/b', procs, cwdOf, { realpathSync: identityRealpath }), false);
  // And the reverse direction: an owner at /a/b must not count for a broker at /a/bc.
  const cwdOfB = (pid) => (pid === 500 ? '/a/b' : null);
  assert.strictEqual(m.hasLiveOwnerAtCwd('/a/bc', procs, cwdOfB, { realpathSync: identityRealpath }), false);
});

// ---- P1 fix #2: realpath both sides (symlink mismatch, e.g. /tmp vs /private/tmp) ----

test('hasLiveOwnerAtCwd: a symlinked cwd mismatch (raw /tmp/proj vs raw /private/tmp/proj) IS resolved as the same owner', () => {
  const rawBrokerCwd = '/tmp/proj';
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => '/private/tmp/proj'; // what lsof/proc actually reports (OS-resolved)
  const symlinkRealpath = (p) => (p === '/tmp/proj' ? '/private/tmp/proj' : p);
  assert.ok(
    m.hasLiveOwnerAtCwd(rawBrokerCwd, procs, cwdOf, { realpathSync: symlinkRealpath }),
    'realpath must canonicalize both sides so a symlinked cwd is recognized as owned'
  );
});

test('hasLiveOwnerAtCwd: fail-soft true when a candidate\'s cwd cannot be realpath\'d', () => {
  const procs = [{ pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }];
  const cwdOf = () => '/some/path';
  const partiallyThrowingRealpath = (p) => {
    if (p === BROKER_CWD) return BROKER_CWD;
    throw new Error('ENOENT');
  };
  assert.strictEqual(
    m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: partiallyThrowingRealpath }),
    true
  );
});

// ---- P2 fix: exclude the broker's own descendants from the owner-candidate list ----

test('descendantsOf: finds transitive children, excludes the root pid itself', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: 'launchd' },
    { pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }, // the broker
    { pid: 2001, ppid: 2000, cmd: 'codex app-server' }, // its direct child
    { pid: 2002, ppid: 2001, cmd: 'codex some-grandchild' }, // transitive
    { pid: 9999, ppid: 1, cmd: 'unrelated' },
  ];
  const d = m.descendantsOf(procs, 2000);
  assert.ok(d.has(2001) && d.has(2002));
  assert.ok(!d.has(2000), 'root pid itself must not be in its own descendant set');
  assert.ok(!d.has(9999));
});

test('hasLiveOwnerAtCwd: excludePids removes the broker\'s own child from the owner candidates (P2 fix)', () => {
  // The broker's own "codex app-server" child inherits the broker's cwd and matches
  // OWNER_PROC_RE — without excludePids it would ALWAYS look like a live owner.
  const procs = [{ pid: 2001, ppid: 2000, cmd: 'codex app-server' }];
  const cwdOf = () => BROKER_CWD; // the child shares the broker's own cwd
  const withoutExclusion = m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, { realpathSync: identityRealpath });
  assert.strictEqual(withoutExclusion, true, 'sanity: the child alone would look like an owner');

  const withExclusion = m.hasLiveOwnerAtCwd(BROKER_CWD, procs, cwdOf, {
    realpathSync: identityRealpath,
    excludePids: new Set([2000, 2001]),
  });
  assert.strictEqual(withExclusion, false, 'the broker\'s own child must be excluded from ownership proof');
});

function agesOf(map) {
  return (pids) => new Map(pids.filter((p) => map.has(p)).map((p) => [p, map.get(p)]));
}

// A test-only realpathSync default for findAbandonedCodexBrokers calls that don't care
// about symlinks (identity function, applied via opts.realpathSync).
const RP = { realpathSync: identityRealpath };

// ---- The 4 originally-required scenarios (still true even though this class is now
// report-only: these prove the DETECTION logic, not a kill decision) ----

test('findAbandonedCodexBrokers: a LIVE broker (PPID 1, live claude owns its cwd) is NOT listed', () => {
  const procs = [
    { pid: 500, ppid: 1, cmd: '/opt/homebrew/bin/claude' }, // live Claude session, PPID 1 too — normal
    { pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }, // detached+unref -> PPID 1 while ALIVE, by design
  ];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 999999]])), // very old, but still owned
    cwdOf: (pid) => (pid === 500 ? BROKER_CWD : null),
    existsSync: () => true,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0, 'PPID 1 must never be treated as evidence of death for this class');
});

test('findAbandonedCodexBrokers: end-to-end submodule case — owner at the workspace root is NOT listed', () => {
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
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 999999]])), // well past the age floor
    existsSync: () => true,
    cwdOf: (pid) => (pid === 500 ? workspaceRoot : null),
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0, 'an owner at an ancestor dir must block the report');
});

test('findAbandonedCodexBrokers: a broker whose --cwd is gone IS listed (reason: cwd-gone)', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false, // worktree removed/archived
    cwdOf: () => null, // must not even need the owner-process check for proof (a)
    ...RP,
  });
  assert.strictEqual(abandoned.length, 1);
  assert.strictEqual(abandoned[0].pid, 2000);
  assert.strictEqual(abandoned[0].reason, 'cwd-gone');
  assert.strictEqual(abandoned[0].cwd, BROKER_CWD);
  assert.strictEqual(abandoned[0].age, 3600);
});

test('findAbandonedCodexBrokers: cwd exists but no owner process, and old enough, IS listed (reason: no-live-owner)', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])), // 1h, past the 30min floor
    existsSync: () => true,
    cwdOf: () => '/Users/talas9/some/unrelated/project', // no claude/codex process owns it
    ...RP,
  });
  assert.strictEqual(abandoned.length, 1);
  assert.strictEqual(abandoned[0].pid, 2000);
  assert.strictEqual(abandoned[0].reason, 'no-live-owner');
});

test('findAbandonedCodexBrokers: a YOUNG abandoned-looking broker is NOT listed', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 5]])), // 5s old, well below the 30min floor
    existsSync: () => false, // cwd gone, but too young -> still not listed
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

// ---- P2 end-to-end: the broker's own child must not mask a genuine orphan ----

test('findAbandonedCodexBrokers: the broker\'s own "codex app-server" child does NOT mask an abandoned broker (P2 fix)', () => {
  const procs = [
    { pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }, // the broker itself, genuinely abandoned
    { pid: 2001, ppid: 2000, cmd: 'codex app-server' }, // its own child, shares its cwd
  ];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => true,
    cwdOf: (pid) => (pid === 2001 ? BROKER_CWD : null), // only the broker's OWN child shares the cwd
    ...RP,
  });
  assert.strictEqual(abandoned.length, 1, 'the broker\'s own child must not count as a live owner');
  assert.strictEqual(abandoned[0].reason, 'no-live-owner');
});

// ---- Additional safety-net coverage ----

test('findAbandonedCodexBrokers: a similarly-named unrelated process is NOT listed', () => {
  const procs = [
    { pid: 2000, ppid: 1, cmd: '/usr/local/bin/node /Users/x/myproject/scripts/app-server-broker.mjs --cwd /Users/x/myproject serve' },
  ];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: disabled (enabled:false) lists nothing, even a textbook abandoned broker', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: false,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: unresolvable age (getAgesForPids omits the pid) is skipped, never listed', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map()), // age unknown
    existsSync: () => false,
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: no getAgesForPids available (settings.js/hook require failed) skips all', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: null,
    existsSync: () => false,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: cwd exists and no cwdOf runner provided -> unresolvable, skipped', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => true, // cwd still exists -> must fall through to the owner-process
    // check, but no cwdOf runner is given -> can't verify -> must skip, not list
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: unparseable --cwd is skipped, never listed', () => {
  const procs = [
    { pid: 2000, ppid: 1, cmd: 'node .../app-server-broker.mjs serve --endpoint unix:/tmp/x.sock' }, // no --cwd
  ];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: () => false,
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 0);
});

test('findAbandonedCodexBrokers: a --cwd path containing a space is still detected correctly when genuinely abandoned', () => {
  const cmd =
    'node /x/codex/1.0.6/scripts/app-server-broker.mjs serve ' +
    '--endpoint unix:/tmp/x.sock --cwd /Users/x/My Proj --pid-file /tmp/x.pid';
  const procs = [{ pid: 2000, ppid: 1, cmd }];
  const abandoned = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 3600]])),
    existsSync: (p) => p !== '/Users/x/My Proj', // the space-containing dir is gone
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(abandoned.length, 1);
  assert.strictEqual(abandoned[0].cwd, '/Users/x/My Proj');
  assert.strictEqual(abandoned[0].reason, 'cwd-gone');
});

// =====================================================================
// REPORT-ONLY SAFETY: this class must NEVER be able to reach a kill. main()
// feeds SIGTERM/SIGKILL exclusively from findOrphans() (the generic MCP
// class) — findAbandonedCodexBrokers's output is only ever passed to
// formatAbandonedBrokerLogLine/logLine. These tests pin the structural
// guarantee at the function level (no real process is spawned or killed).
// =====================================================================

test('kill-list safety: findOrphans (the ONLY feed to SIGTERM/SIGKILL) never selects an app-server-broker.mjs process, even old + ppid=1', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const orphans = m.findOrphans(procs); // no extraRe/excludeRe — the widest possible match
  assert.strictEqual(orphans.length, 0, 'matchesMcp must never match a codex broker');
});

test('kill-list safety: an ABANDONED codex broker is never present in findOrphans, only in findAbandonedCodexBrokers', () => {
  const procs = [{ pid: 2000, ppid: 1, cmd: REAL_BROKER_CMD }];
  const killable = m.findOrphans(procs);
  const reportOnly = m.findAbandonedCodexBrokers(procs, {
    enabled: true,
    minAgeS: 1800,
    getAgesForPids: agesOf(new Map([[2000, 999999]])),
    existsSync: () => false, // genuinely abandoned (cwd gone)
    cwdOf: () => null,
    ...RP,
  });
  assert.strictEqual(killable.length, 0, 'the abandoned broker must not appear in the killable list');
  assert.strictEqual(reportOnly.length, 1, 'sanity: it IS detected by the report-only class');
  assert.strictEqual(reportOnly[0].pid, 2000);
});

test('formatAbandonedBrokerLogLine: the report line names pid, age, cwd, and reason', () => {
  const line = m.formatAbandonedBrokerLogLine({ pid: 2000, cwd: BROKER_CWD, age: 3600, reason: 'cwd-gone' });
  assert.strictEqual(
    line,
    `abandoned codex broker (report-only): pid=2000 age=3600s cwd=${BROKER_CWD} reason=cwd-gone`
  );
});

test('formatAbandonedBrokerLogLine: an unknown age renders as "unknown", not NaN/undefined', () => {
  const line = m.formatAbandonedBrokerLogLine({ pid: 2000, cwd: BROKER_CWD, age: undefined, reason: 'no-live-owner' });
  assert.match(line, /age=unknown/);
});

test('exports include the codex-broker report-only class', () => {
  assert.strictEqual(typeof m.matchesCodexBroker, 'function');
  assert.strictEqual(typeof m.extractBrokerCwd, 'function');
  assert.strictEqual(typeof m.isPathAncestorOrSame, 'function');
  assert.strictEqual(typeof m.descendantsOf, 'function');
  assert.strictEqual(typeof m.hasLiveOwnerAtCwd, 'function');
  assert.strictEqual(typeof m.findAbandonedCodexBrokers, 'function');
  assert.strictEqual(typeof m.formatAbandonedBrokerLogLine, 'function');
  assert.strictEqual(typeof m.defaultCwdOf, 'function');
  assert.strictEqual(m.DEFAULT_CODEX_BROKER_MIN_AGE_S, 1800);
});
