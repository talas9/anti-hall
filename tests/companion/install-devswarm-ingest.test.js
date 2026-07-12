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
  assert.ok(line.endsWith('>/dev/null 2>&1'));
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
