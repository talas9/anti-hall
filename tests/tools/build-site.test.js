'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');

test('build-site emits index, llms.txt, sitemap, converted docs and rewritten links', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-site-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-site-home-'));
  const out = path.join(tmp, 'site');
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, SITE_URL: 'https://example.test/x/' };
    cp.execFileSync(process.execPath, [path.join(REPO, 'tools', 'build-site.js'), out], { env, encoding: 'utf8' });
    for (const f of ['index.html', 'llms.txt', 'sitemap.xml', 'robots.txt', 'docs/index.html', 'docs/GUIDE.html']) {
      assert.ok(fs.existsSync(path.join(out, f)), f + ' missing');
    }
    assert.strictEqual(fs.readFileSync(path.join(out, 'llms.txt'), 'utf8'), fs.readFileSync(path.join(REPO, 'llms.txt'), 'utf8'));
    const sm = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    assert.match(sm, /<loc>https:\/\/example\.test\/x\/docs\/GUIDE\.html<\/loc>/);
    assert.match(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/example\.test\/x\/sitemap\.xml/);
    const html = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : /\.html$/.test(e.name) && html.push(p); } })(out);
    let rewritten = 0;
    for (const f of html) {
      const h = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(h, /href="(?!https?:)[^"#]*\.md(#[^"]*)?"/, f + ' still links to a .md file');
      if (/href="(docs\/[^"]+|[^":]+)\.html/.test(h)) rewritten++;
    }
    assert.ok(rewritten > 0, 'no rewritten .html links found');
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /href="docs\/[A-Za-z0-9_-]+\.html/);
    assert.match(fs.readFileSync(path.join(out, 'docs', 'GUIDE.html'), 'utf8'), /<h1 id=/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
