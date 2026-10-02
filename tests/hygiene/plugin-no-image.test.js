'use strict';
// plugin-no-image: the plugin ships no image or font file and the Claude manifest has no
// `icon` key (the directory listing icon is uploaded in the portal instead).

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

test('no image or font file is tracked under plugins/anti-hall (by extension or magic bytes)', () => {
  const bad = [];
  for (const rel of trackedPluginFiles()) {
    if (EXT.test(rel)) { bad.push(rel); continue; }
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const kind = magic(fs.readFileSync(abs));
    if (kind) bad.push(`${rel} (${kind})`);
  }
  assert.deepStrictEqual(bad, []);
});
