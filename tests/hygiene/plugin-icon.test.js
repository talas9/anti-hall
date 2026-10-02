'use strict';
// plugin-icon: the plugin ships exactly one image, the icon at the directory's default path
// `.claude-plugin/icon.png`, and the Claude manifest has no `icon` key (an `icon` key is held
// by the directory validator). No other image or font is shipped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');
const EXT = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svg|avif|tiff?|woff2?|ttf|otf|eot)$/i;

function trackedPluginFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'plugins/anti-hall'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function magic(buf) {
  const h = buf.subarray(0, 12);
  const s = (a, b) => h.subarray(a, b).toString('latin1');
  if (h[0] === 0x89 && s(1, 4) === 'PNG') return 'png';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (s(0, 3) === 'GIF') return 'gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(0, 2) === 'BM' && buf.length > 14 && buf.readUInt32LE(2) === buf.length) return 'bmp';
  if (h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0) return 'ico';
  if (s(0, 4) === 'wOFF' || s(0, 4) === 'wOF2' || s(0, 4) === 'OTTO') return 'font';
  if (h[0] === 0 && h[1] === 1 && h[2] === 0 && h[3] === 0) return 'ttf';
  return null;
}

test('Claude manifest declares no icon key', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.ok(!('icon' in manifest), 'plugin.json must not declare icon');
});

const ICON = 'plugins/anti-hall/.claude-plugin/icon.png';

test('exactly one image/font file is tracked under plugins/anti-hall: .claude-plugin/icon.png', () => {
  const found = [];
  for (const rel of trackedPluginFiles()) {
    if (EXT.test(rel)) { found.push(rel); continue; }
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const kind = magic(fs.readFileSync(abs));
    if (kind) found.push(rel);
  }
  assert.deepStrictEqual(found, [ICON]);
});

test('the icon is a square PNG, 512-2048 px per side, under 2 MB', () => {
  const buf = fs.readFileSync(path.join(ROOT, ICON));
  assert.strictEqual(magic(buf), 'png');
  assert.strictEqual(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.strictEqual(w, h, `icon must be square, got ${w}x${h}`);
  assert.ok(w >= 512 && w <= 2048, `icon side ${w} must be 512-2048`);
  assert.ok(buf.length < 2 * 1024 * 1024, `icon is ${buf.length} bytes`);
});
