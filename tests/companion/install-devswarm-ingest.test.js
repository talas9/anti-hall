'use strict';
// install-devswarm-ingest tests. Pure-builder assertions (no real
// launchctl/systemctl/fs writes) mirroring install-devswarm-supervisor.test.js,
// PLUS a subprocess dry-run idempotence check (install twice -> ONE unit file,
// same fixed target) and a capability-scan-reports-it check. The subprocess runs
// with an isolated HOME so no real scheduler/unit is ever touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
const m = require(MOD);

const SUP = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');
const sup = require(SUP);

const NASTY = '/Users/a b & c/<x>/"q\'/node';
const NASTY_SCRIPT = '/Users/a b & c/devswarm-ingest.js';

// ---------------------------------------------------------------------------
// Distinct identity from the supervisor (own label + log path).
// ---------------------------------------------------------------------------

test('label/unit are distinct from the supervisor (own scheduler identity)', () => {
  assert.strictEqual(m.LABEL, 'com.anti-hall.devswarm-ingest');
  assert.strictEqual(m.UNIT, 'anti-hall-devswarm-ingest');
  assert.notStrictEqual(m.LABEL, sup.LABEL);
  assert.notStrictEqual(m.UNIT, sup.UNIT);
});

// ---------------------------------------------------------------------------
// macOS plist — CONTINUOUS daemon (KeepAlive), not a periodic sweep.
// ---------------------------------------------------------------------------

test('buildPlist uses KeepAlive (continuous relaunch), NOT StartInterval', () => {
  const xml = m.buildPlist({ exec: '/usr/bin/node', script: '/x/ingest.js', log: '/x/log' });
  assert.ok(/<key>KeepAlive<\/key>\s*<true\/>/.test(xml), 'must relaunch on exit');
  assert.ok(!xml.includes('StartInterval'), 'a continuous daemon must not be interval-scheduled');
  assert.ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(xml));
});

test('buildPlist XML-escapes exec/script/log, embeds the label, well-formed', () => {
  const xml = m.buildPlist({ exec: NASTY, script: NASTY_SCRIPT, log: '/log/a & b.log' });
  assert.ok(xml.includes('<string>/Users/a b &amp; c/&lt;x&gt;/&quot;q&apos;/node</string>'));
  assert.ok(xml.includes('<string>/Users/a b &amp; c/devswarm-ingest.js</string>'));
  assert.ok(xml.includes('<string>/log/a &amp; b.log</string>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no bare ampersands allowed');
  assert.strictEqual((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length);
  assert.ok(xml.includes(m.LABEL));
});

// ---------------------------------------------------------------------------
// systemd service — Type=simple + Restart=always (continuous), no timer.
// ---------------------------------------------------------------------------

test('buildService is a continuous Type=simple service with Restart=always (not a timer)', () => {
  const unit = m.buildService({ exec: '/usr/bin/node', script: '/x/ingest.js', restartSec: 5 });
  assert.ok(/Type=simple/.test(unit));
  assert.ok(/Restart=always/.test(unit));
  assert.ok(/RestartSec=5/.test(unit));
  assert.ok(/WantedBy=default\.target/.test(unit));
  assert.ok(!/\[Timer\]/.test(unit), 'a continuous daemon must not carry a [Timer] section');
  assert.ok(!/OnUnitActiveSec/.test(unit));
});

test('buildService wires StandardOutput/StandardError into the stable log (append, not discard)', () => {
  const unit = m.buildService({ exec: '/usr/bin/node', script: '/x/ingest.js', log: '/x/log' });
  assert.ok(unit.includes('StandardOutput=append:/x/log'), 'stdout captured, appended');
  assert.ok(unit.includes('StandardError=append:/x/log'), 'stderr captured, appended');
  // Default `log` param falls back to the module-level stable LOG constant.
  const defaulted = m.buildService({ exec: '/n', script: '/s' });
  assert.ok(defaulted.includes(`StandardOutput=append:${m.LOG}`));
  assert.ok(defaulted.includes(`StandardError=append:${m.LOG}`));
});

// P0-2: ExecStart must be systemd-escaped (NOT emit a raw path). systemd does its
// own tokenizing + $VAR expansion, so ", \, and $ must be escaped or a path can
// break the token / inject an env expansion.
test('buildService systemd-escapes exec + script in ExecStart (no unescaped injection survives)', () => {
  const inject = '/tmp/x"; touch /tmp/pwn #/node';
  const unit = m.buildService({ exec: inject, script: '/x/ingest.js' });
  const line = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.ok(line, 'ExecStart line present');
  // The bare double-quote is escaped as \" (systemd rule) — the raw break-out is gone.
  assert.ok(line.includes('/tmp/x\\"; touch /tmp/pwn #/node'), 'double-quote must be escaped as \\"');
  assert.ok(!line.includes('x"; touch'), 'no raw unescaped double-quote may survive (would break the token)');
  // Space-safe: an ordinary spaced path is double-quoted verbatim.
  assert.ok(m.buildService({ exec: '/a b/node', script: '/c d/i.js' }).includes('ExecStart="/a b/node" "/c d/i.js"'));
});

// P0-2: the cron line runs through a shell, so each path must be POSIX
// single-quoted with ' -> '\'' escaping — nothing inside single quotes is special.
test('buildCronLine POSIX single-quotes exec + script (no shell break-out survives)', () => {
  const inject = "/tmp/x'; touch /tmp/pwn #/node";
  const line = m.buildCronLine({ exec: inject, script: '/x/ingest.js' });
  // The embedded single-quote is escaped as '\'' so the shell cannot break out.
  assert.ok(line.includes("/tmp/x'\\''; touch /tmp/pwn #/node"), "single-quote must be POSIX-escaped as '\\''");
  assert.ok(!line.includes("x'; touch"), 'no raw quote-close followed by a live command may survive');
  assert.ok(line.endsWith(`>> ${m.shSingleQuote(m.LOG)} 2>&1`), 'appends into the stable log, not /dev/null');
});

// P0-2 belt: a path with control/quote characters is refused by the emit guard.
test('pathIsEmittable rejects control/quote chars, accepts ordinary (spaced) paths', () => {
  assert.strictEqual(m.pathIsEmittable('/usr/local/bin/node'), true);
  assert.strictEqual(m.pathIsEmittable('/Users/a b c/node'), true); // spaces are fine (quoted)
  assert.strictEqual(m.pathIsEmittable('/tmp/a"b/node'), false);    // double-quote
  assert.strictEqual(m.pathIsEmittable("/tmp/a'b/node"), false);    // single-quote
  assert.strictEqual(m.pathIsEmittable('/tmp/a\nb/node'), false);   // newline (control)
});

// ---------------------------------------------------------------------------
// WorkingDirectory: the daemon must run FROM the install-time git worktree, else
// `hivecontrol workspace monitor` fails "Not in a git repository" and drains nothing
// (launchd/systemd/cron default a unit's cwd to $HOME, which is not a git repo).
// Each unit type bakes the worktree in, escaped per its own quoting rules.
// ---------------------------------------------------------------------------

const NASTY_WT = '/Users/a b & c/<w>/"q\'/tree';

test('buildPlist embeds an XML-escaped WorkingDirectory when a worktree is given (and omits it otherwise)', () => {
  const xml = m.buildPlist({ exec: '/usr/bin/node', script: '/x/ingest.js', log: '/x/log', workdir: NASTY_WT });
  assert.ok(/<key>WorkingDirectory<\/key>/.test(xml), 'WorkingDirectory key present');
  assert.ok(xml.includes('<string>/Users/a b &amp; c/&lt;w&gt;/&quot;q&apos;/tree</string>'), 'worktree XML-escaped');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no bare ampersands allowed');
  assert.strictEqual((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length, 'balanced string tags');
  // No worktree -> no WorkingDirectory key (backward compatible).
  assert.ok(!/WorkingDirectory/.test(m.buildPlist({ exec: '/n', script: '/s', log: '/l' })), 'omitted when no worktree');
});

test('buildService emits a systemd-escaped WorkingDirectory under [Service] before ExecStart (no injection survives)', () => {
  const inject = '/tmp/wt"; touch /tmp/pwn #';
  const unit = m.buildService({ exec: '/usr/bin/node', script: '/x/ingest.js', workdir: inject });
  const line = unit.split('\n').find((l) => l.startsWith('WorkingDirectory='));
  assert.ok(line, 'WorkingDirectory line present');
  assert.ok(line.includes('/tmp/wt\\"; touch /tmp/pwn #'), 'double-quote escaped as \\" (systemd rule)');
  assert.ok(!line.includes('wt"; touch'), 'no raw unescaped double-quote may survive');
  const idxSvc = unit.indexOf('[Service]');
  const idxWd = unit.indexOf('WorkingDirectory=');
  const idxExec = unit.indexOf('ExecStart=');
  assert.ok(idxSvc >= 0 && idxSvc < idxWd && idxWd < idxExec, 'WorkingDirectory sits in [Service] before ExecStart');
  // No worktree -> no WorkingDirectory line (backward compatible).
  assert.ok(!/WorkingDirectory/.test(m.buildService({ exec: '/n', script: '/s' })), 'omitted when no worktree');
});

test('buildCronLine prefixes a POSIX single-quoted `cd <worktree> &&` (no shell break-out survives)', () => {
  const inject = "/tmp/wt'; touch /tmp/pwn #";
  const line = m.buildCronLine({ exec: '/usr/bin/node', script: '/x/ingest.js', workdir: inject });
  assert.ok(line.startsWith('* * * * * cd '), 'cron line cds into the worktree first');
  assert.ok(line.includes("cd '/tmp/wt'\\''; touch /tmp/pwn #'"), "worktree single-quote POSIX-escaped as '\\''");
  assert.ok(!line.includes("cd '/tmp/wt'; touch"), 'no raw quote-close followed by a live command may survive');
  assert.ok(line.includes(' && '), 'the cd is chained before the daemon exec');
  assert.ok(line.endsWith(`>> ${m.shSingleQuote(m.LOG)} 2>&1`), 'redirection into the stable log preserved');
  // No worktree -> no cd prefix (backward compatible with the plain form).
  assert.ok(!/\bcd /.test(m.buildCronLine({ exec: '/n', script: '/s' })), 'omitted when no worktree');
});

test('buildCronLine / buildService append into a custom `log` path when given (not just the default LOG)', () => {
  const cronLine = m.buildCronLine({ exec: '/n', script: '/s', log: '/custom/x.log' });
  assert.ok(cronLine.endsWith(`>> ${m.shSingleQuote('/custom/x.log')} 2>&1`));
  const svc = m.buildService({ exec: '/n', script: '/s', log: '/custom/x.log' });
  assert.ok(svc.includes('StandardOutput=append:/custom/x.log'));
  assert.ok(svc.includes('StandardError=append:/custom/x.log'));
});

// ---------------------------------------------------------------------------
// Install refuses (skips, non-fatal) when cwd is not inside a git worktree — a
// daemon launched from $HOME can never resolve a workspace, so we install nothing.
// ---------------------------------------------------------------------------

test('install refuses (skips, non-fatal exit 0) and writes no unit when cwd is not a git worktree', () => {
  if (process.platform === 'win32') return; // Windows is a documented no-op (no scheduler)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-nogit-home-'));
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-nogit-cwd-'));
  try {
    // execFileSync throws on non-zero exit; reaching here proves exit 0 (non-fatal).
    const out = execFileSync(process.execPath, [MOD, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      cwd: nogit,
    });
    assert.ok(/no git worktree resolved from cwd/.test(out), 'must log the refuse message');
    assert.ok(!/\[dry-run\] would write .+\.(plist|service)/.test(out), 'must not write any unit when no worktree resolves');
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(nogit, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// P1-2: cron fallback installs a MANAGED MARKER entry (not just a printed line),
// and the merge is idempotent — so it is a real scheduling signal, installed once.
// ---------------------------------------------------------------------------

test('cron fallback: the managed marker is `# <UNIT>` and the entry carries the marker + escaped line', () => {
  assert.strictEqual(m.CRON_MARKER, `# ${m.UNIT}`);
  const entry = m.buildCronEntry({ exec: '/n', script: '/s' });
  assert.ok(entry.split('\n')[0] === m.CRON_MARKER, 'first line is the managed marker');
  assert.ok(entry.includes(m.buildCronLine({ exec: '/n', script: '/s' })), 'entry carries the cron line');
});

test('cron fallback: mergeCrontab appends the entry once, is idempotent, and preserves existing entries', () => {
  const existing = '# some other job\n*/5 * * * * /bin/true\n';
  const entry = m.buildCronEntry({ exec: '/n', script: '/s' });
  const first = m.mergeCrontab(existing, entry, m.CRON_MARKER);
  assert.strictEqual(first.changed, true, 'first merge installs the entry');
  assert.ok(first.next.includes('# some other job'), 'existing entries preserved');
  assert.ok(first.next.includes(m.CRON_MARKER), 'managed marker present after install');

  const second = m.mergeCrontab(first.next, entry, m.CRON_MARKER);
  assert.strictEqual(second.changed, false, 'second merge is a no-op (marker already present)');
  assert.strictEqual(second.next, first.next, 'crontab unchanged on re-install (idempotent)');
});

test('cron fallback: removeCronEntry strips the managed marker AND its command line, leaving others', () => {
  const withEntry = m.mergeCrontab('# keep\n*/5 * * * * /bin/true\n', m.buildCronEntry({ exec: '/n', script: '/s' }), m.CRON_MARKER).next;
  const removed = m.removeCronEntry(withEntry, m.CRON_MARKER);
  assert.strictEqual(removed.changed, true);
  assert.ok(!removed.next.includes(m.CRON_MARKER), 'managed marker removed');
  assert.ok(!removed.next.includes("'/n'"), 'managed command line removed');
  assert.ok(removed.next.includes('# keep'), 'unrelated entries preserved');
});

// ---------------------------------------------------------------------------
// Idempotence: install twice -> ONE unit file, same fixed target. Proven via a
// --dry-run subprocess with an isolated HOME (no real scheduler is touched). A
// file installer that writes a single fixed path is idempotent by construction:
// a second install overwrites that path rather than creating a second unit.
// ---------------------------------------------------------------------------

test('install (--dry-run) targets ONE fixed unit file and is idempotent across runs', () => {
  if (process.platform === 'win32') return; // Windows is a documented no-op (no scheduler)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-install-'));
  try {
    const runOnce = () => execFileSync(process.execPath, [MOD, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    const out1 = runOnce();
    const out2 = runOnce();

    // Exactly ONE unit file is written (a .plist on darwin, a .service on linux).
    const writeLines = (out) => out.split('\n').filter((l) => /^\[dry-run\] would write .+\.(plist|service)$/.test(l));
    const w1 = writeLines(out1);
    const w2 = writeLines(out2);
    assert.strictEqual(w1.length, 1, 'exactly one unit file per install');
    assert.strictEqual(w2.length, 1, 'exactly one unit file per install');
    // Same fixed target both times -> reinstall overwrites, never duplicates.
    assert.strictEqual(w1[0], w2[0], 'the unit target must be a single stable path');
    // The target lives under the isolated HOME (no real scheduler dir touched).
    assert.ok(w1[0].includes(home), 'unit file must resolve under the injected HOME');
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// capability-scan discovers + reports the ingest installer (same shape as the
// supervisor entry): name, available, active, how.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PER-WORKTREE identity (multi-repo additive installs) + listInstalledIngestUnits.
// ---------------------------------------------------------------------------

test('worktreeHash is a stable 8-hex fingerprint; label/unit/primaryWorkspaceId derive per-worktree', () => {
  const a = m.worktreeHash('/repo/a');
  const b = m.worktreeHash('/repo/b');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'different worktrees -> different hashes');
  assert.equal(m.worktreeHash('/repo/a'), a, 'stable across calls');
  assert.equal(m.labelForWorktree('/repo/a'), m.LABEL + '.' + a);
  assert.equal(m.unitForWorktree('/repo/a'), m.UNIT + '-' + a);
  assert.equal(m.cronMarkerForWorktree('/repo/a'), '# ' + m.UNIT + '-' + a);
  assert.equal(m.primaryWorkspaceId('/repo/a'), 'primary-' + a);
});

test('buildPlist embeds the PER-WORKTREE label so a second repo never overwrites the first', () => {
  const la = m.labelForWorktree('/repo/a');
  const lb = m.labelForWorktree('/repo/b');
  assert.notEqual(la, lb);
  const xmlA = m.buildPlist({ label: la, exec: '/n', script: '/s', log: '/l', workdir: '/repo/a' });
  assert.ok(xmlA.includes('<string>' + la + '</string>'), 'plist carries the per-worktree label');
});

test('listInstalledIngestUnits reads back BOTH a legacy base unit AND per-worktree units', { skip: process.platform === 'win32' }, () => {
  const platform = process.platform;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-listunits-'));
  try {
    const wtA = '/repo/a';
    const hashA = m.worktreeHash(wtA);
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      // legacy base-name unit (hash null)
      fs.writeFileSync(path.join(dir, m.LABEL + '.plist'),
        m.buildPlist({ label: m.LABEL, exec: '/n', script: '/legacy.js', log: '/l', workdir: '/legacy/wt' }));
      // per-worktree unit
      fs.writeFileSync(path.join(dir, m.labelForWorktree(wtA) + '.plist'),
        m.buildPlist({ label: m.labelForWorktree(wtA), exec: '/n', script: '/a.js', log: '/l', workdir: wtA }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, m.UNIT + '.service'),
        m.buildService({ exec: '/n', script: '/legacy.js', workdir: '/legacy/wt' }));
      fs.writeFileSync(path.join(dir, m.unitForWorktree(wtA) + '.service'),
        m.buildService({ exec: '/n', script: '/a.js', workdir: wtA }));
    }
    const units = m.listInstalledIngestUnits({ home, platform });
    assert.equal(units.length, 2, 'both units discovered');
    const legacy = units.find((u) => u.hash === null);
    const perwt = units.find((u) => u.hash === hashA);
    assert.ok(legacy, 'legacy (hash-null) unit found');
    assert.equal(legacy.workingDir, '/legacy/wt');
    assert.equal(legacy.scriptPath, '/legacy.js');
    assert.ok(perwt, 'per-worktree unit found by hash');
    assert.equal(perwt.workingDir, wtA);
    assert.equal(perwt.scriptPath, '/a.js');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('listInstalledIngestUnits fail-opens to [] when nothing is installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-listunits-empty-'));
  try {
    assert.deepEqual(m.listInstalledIngestUnits({ home, platform: process.platform }), []);
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('capability-scan discovers and reports the devswarm-ingest companion', () => {
  const { scanCapabilities } = require('../../plugins/anti-hall/scripts/capability-scan.js');
  // Real plugin root so the actual install-devswarm-ingest.js is discovered.
  const root = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-capscan-'));
  try {
    const report = scanCapabilities({ root, home, cwd: home, platform: 'darwin' });
    const entry = report.capabilities.find((c) => c.name === 'devswarm-ingest');
    assert.ok(entry, 'devswarm-ingest must be reported');
    assert.strictEqual(entry.available, true);
    // No plist under the empty HOME -> not active (but discovered).
    assert.strictEqual(entry.active, false);
    assert.ok(/install-devswarm-ingest\.js/.test(entry.how), 'how must point at the installer');
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// STABLE baked script path (P0 fix): the daemon's launchd/systemd/cron unit must
// bake the git marketplace clone's copy of devswarm-ingest.js — the exact path
// update.js `git pull --ff-only`s IN PLACE — NOT a version-pinned cache dir or
// this installer's own __dirname, either of which the plugin manager can
// relocate out from under an already-running daemon on update (confirmed root
// cause of the crash-loop-after-update bug).
// ---------------------------------------------------------------------------

test('resolveStableScript prefers the marketplace clone devswarm-ingest.js when present', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-'));
  try {
    const mktCompanion = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall', 'plugins', 'anti-hall', 'companion');
    fs.mkdirSync(mktCompanion, { recursive: true });
    const scriptFile = path.join(mktCompanion, 'devswarm-ingest.js');
    fs.writeFileSync(scriptFile, '// fixture\n');
    assert.strictEqual(m.resolveStableScript({}, home), scriptFile);
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('resolveStableScript returns null (caller falls back to __dirname) when no marketplace clone is present', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-none-'));
  try {
    assert.strictEqual(m.resolveStableScript({}, home), null);
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('resolveStableScript honors ANTIHALL_MARKETPLACE_DIR (same test-only override update.js uses)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-override-home-'));
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-override-'));
  try {
    const companion = path.join(override, 'plugins', 'anti-hall', 'companion');
    fs.mkdirSync(companion, { recursive: true });
    const scriptFile = path.join(companion, 'devswarm-ingest.js');
    fs.writeFileSync(scriptFile, '// fixture\n');
    assert.strictEqual(m.resolveStableScript({ ANTIHALL_MARKETPLACE_DIR: override }, home), scriptFile);
    // An invalid override (relative / nonexistent) is IGNORED, same as update.js —
    // falls through to the default (home-derived) location, absent here -> null.
    assert.strictEqual(m.resolveStableScript({ ANTIHALL_MARKETPLACE_DIR: 'relative/dir' }, home), null);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(override, { recursive: true, force: true }); } catch (_) {}
  }
});

test('SCRIPT (module-load-time): resolves to the marketplace clone path when present under HOME, not __dirname/cache', () => {
  if (process.platform === 'win32') return; // os.homedir() does not honor HOME on win32
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-subproc-'));
  try {
    const mktCompanion = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall', 'plugins', 'anti-hall', 'companion');
    fs.mkdirSync(mktCompanion, { recursive: true });
    const stableScript = path.join(mktCompanion, 'devswarm-ingest.js');
    fs.writeFileSync(stableScript, '// fixture\n');
    const out = execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(MOD)}).SCRIPT)`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    }).trim();
    assert.strictEqual(out, stableScript, 'SCRIPT resolves to the STABLE marketplace-clone path, not __dirname');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('SCRIPT (module-load-time): falls back to __dirname/devswarm-ingest.js when no marketplace clone is present under HOME', () => {
  if (process.platform === 'win32') return; // os.homedir() does not honor HOME on win32
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-stablepath-fallback-'));
  try {
    const out = execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(MOD)}).SCRIPT)`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    }).trim();
    assert.strictEqual(out, path.join(path.dirname(MOD), 'devswarm-ingest.js'), 'falls back to the real file next to the installer');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});
