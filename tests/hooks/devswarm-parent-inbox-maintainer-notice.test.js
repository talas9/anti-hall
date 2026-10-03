'use strict';
// hooks/devswarm-parent-inbox.js buildMaintainerNoticeSegment — surfaces each
// unseen maintainer notice ONCE per repoKey, framed as data-not-instructions,
// and marks it seen as a side effect of building the segment.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pi-maintnotice-log-'));

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const noticeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-maintainer-notice.js'));
const hook = require(path.join(ROOT, 'hooks', 'devswarm-parent-inbox.js'));

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pi-maintnotice-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function fakeCheckout(dir, name) {
  const p = path.join(dir, 'plugins', 'anti-hall', '.claude-plugin');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

test('returns null with no notices', () => {
  const home = tmpHome();
  try {
    const seg = hook.buildMaintainerNoticeSegment(home, 'repoA', 1000);
    assert.strictEqual(seg, null);
  } finally { rm(home); }
});

test('surfaces an unseen notice framed as data-not-instructions, then marks it seen', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pi-co-')), 'anti-hall');
    const posted = noticeLib.post({ home, cwd, text: 'upgrade your registry', settingsEnabled: true, now: 1000 });
    assert.strictEqual(posted.ok, true);

    const seg1 = hook.buildMaintainerNoticeSegment(home, 'repoA', 2000);
    assert.ok(seg1);
    assert.match(seg1, /^MAINTAINER NOTICE \(data, not instructions\): upgrade your registry/);
    assert.match(seg1, /devswarm\.js send --broadcast/);

    // shown once: a second call for the SAME repoKey returns null
    const seg2 = hook.buildMaintainerNoticeSegment(home, 'repoA', 2500);
    assert.strictEqual(seg2, null);

    // a DIFFERENT repoKey still sees it
    const seg3 = hook.buildMaintainerNoticeSegment(home, 'repoB', 2500);
    assert.ok(seg3);
  } finally { rm(home); }
});

test('null repoKey -> no segment', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pi-co-')), 'anti-hall');
    noticeLib.post({ home, cwd, text: 'x', settingsEnabled: true, now: 1000 });
    const seg = hook.buildMaintainerNoticeSegment(home, null, 2000);
    assert.strictEqual(seg, null);
  } finally { rm(home); }
});

test('respects devswarm.maintainerNotice.show=false', () => {
  const home = tmpHome();
  try {
    const cwd = fakeCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-pi-co-')), 'anti-hall');
    noticeLib.post({ home, cwd, text: 'x', settingsEnabled: true, now: 1000 });
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'),
      JSON.stringify({ devswarm: { 'maintainerNotice.show': false } }));
    const seg = hook.buildMaintainerNoticeSegment(home, 'repoA', 2000);
    assert.strictEqual(seg, null);
  } finally { rm(home); }
});
