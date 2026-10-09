#!/usr/bin/env node
'use strict';
// Builds the static docs site (GitHub Pages) from README.md + docs/*.md.
// Pure Node built-ins, no dependencies.  Usage: node tools/build-site.js [outDir]
// Env: SITE_URL (absolute base for sitemap.xml), REPO_URL (blob links for repo files).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const SITE_URL = (process.env.SITE_URL || 'https://talas9.github.io/anti-hall/').replace(/\/?$/, '/');
const REPO_URL = (process.env.REPO_URL || 'https://github.com/talas9/anti-hall').replace(/\/$/, '');
const ASSETS = ['assets/anti-hall-icon.png', 'assets/anti-hall-logo.png', 'assets/demo/anti-hall.gif'];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

// Source path (repo-relative, posix) -> output path.
function outPathFor(src) { return src === 'README.md' ? 'index.html' : src.replace(/\.md$/, '.html'); }

// Resolve a link found in `fromSrc` (repo-relative file). Returns the rewritten href.
function rewriteHref(href, fromSrc, pages) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const m = href.match(/^([^#?]*)([#?].*)?$/);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromSrc), m[1] || '.'));
  const suffix = m[2] || '';
  if (pages.has(target)) {
    const rel = path.posix.relative(path.posix.dirname(outPathFor(fromSrc)), outPathFor(target));
    return rel + suffix;
  }
  if (ASSETS.includes(target)) {
    return path.posix.relative(path.posix.dirname(outPathFor(fromSrc)), target) + suffix;
  }
  if (target.startsWith('..')) return href;
  const abs = path.join(ROOT, target);
  if (fs.existsSync(abs)) {
    return REPO_URL + (fs.statSync(abs).isDirectory() ? '/tree/main/' : '/blob/main/') + target + suffix;
  }
  return href;
}

function inline(s, ctx) {
  const stash = [];
  const keep = (h) => '\u0000' + (stash.push(h) - 1) + '\u0000';
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => keep('<code>' + esc(c.trim()) + '</code>'));
  s = s.replace(/<(\/?[a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\/?>/g, (t) => keep(t)); // inline raw HTML
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (_, alt, src) => '<img alt="' + alt + '" src="' + rewriteHref(src.replace(/&amp;/g, '&'), ctx.src, ctx.pages) + '">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (_, text, href) => '<a href="' + rewriteHref(href.replace(/&amp;/g, '&'), ctx.src, ctx.pages) + '">' + text + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => '<strong>' + (a || b) + '</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

const BLOCK_HTML = /^<\/?(p|div|details|summary|img|picture|a|br|hr|table|thead|tbody|tr|td|th|h[1-6]|ul|ol|li|center|sub|sup|kbd|span|pre|blockquote|!--)\b/i;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function renderList(lines, i, ctx) {
  const base = lines[i].match(LIST_ITEM)[1].length;
  const ordered = /\d/.test(lines[i].match(LIST_ITEM)[2]);
  let html = '<' + (ordered ? 'ol' : 'ul') + '>';
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || m[1].length !== base) break;
    let text = m[3];
    i++;
    let sub = '';
    while (i < lines.length) {
      const l = lines[i];
      const mm = l.match(LIST_ITEM);
      if (mm && mm[1].length > base) { const r = renderList(lines, i, ctx); sub += r.html; i = r.next; continue; }
      if (l.trim() && !mm && /^\s+\S/.test(l) && (l.match(/^\s*/)[0].length > base)) { text += ' ' + l.trim(); i++; continue; }
      break;
    }
    html += '<li>' + inline(text, ctx) + sub + '</li>';
  }
  return { html: html + '</' + (ordered ? 'ol' : 'ul') + '>', next: i };
}

function render(md, ctx) {
  const lines = md.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = [];
  let title = null;
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if ((m = l.match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/))) { // fenced code
      const fence = m[2];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++].replace(new RegExp('^\\s{0,' + m[1].length + '}'), ''));
      i++;
      out.push('<pre><code' + (m[3] ? ' class="language-' + esc(m[3]) + '"' : '') + '>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = m[1].length;
      const text = inline(m[2], ctx);
      if (n === 1 && !title) title = m[2].replace(/[`*_]/g, '');
      out.push('<h' + n + ' id="' + slug(m[2].replace(/[`*_]/g, '')) + '">' + text + '</h' + n + '>');
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(l);
      i += 2;
      let t = '<table><thead><tr>' + head.map((c) => '<th>' + inline(c, ctx) + '</th>').join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        t += '<tr>' + splitRow(lines[i++]).map((c) => '<td>' + inline(c, ctx) + '</td>').join('') + '</tr>';
      }
      out.push(t + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + render(q.join('\n'), ctx).html + '</blockquote>');
      continue;
    }
    if (LIST_ITEM.test(l)) { const r = renderList(lines, i, ctx); out.push(r.html); i = r.next; continue; }
    if (BLOCK_HTML.test(l.trim())) { // raw HTML block, pass through to next blank line
      const h = [];
      while (i < lines.length && lines[i].trim()) h.push(lines[i++]);
      out.push(h.join('\n'));
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*>)/.test(lines[i]) && !LIST_ITEM.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) p.push(lines[i++]);
    if (!p.length) { p.push(lines[i++]); }
    out.push('<p>' + inline(p.join('\n'), ctx) + '</p>');
  }
  return { html: out.join('\n'), title };
}

const CSS = 'body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#1f2328;background:#fff}' +
  '@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#58a6ff}pre,code,th{background:#161b22!important}td,th{border-color:#30363d!important}}' +
  'header{padding:12px 16px;border-bottom:1px solid #8885;display:flex;gap:16px;flex-wrap:wrap;align-items:center}' +
  'header a{font-weight:600;text-decoration:none}main{max-width:900px;margin:0 auto;padding:16px}' +
  'pre{overflow:auto;padding:12px;background:#f6f8fa;border-radius:6px}code{background:#8882;border-radius:4px;padding:0 4px}pre code{background:none;padding:0}' +
  'table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #d0d7de;padding:6px 12px}th{background:#f6f8fa}' +
  'img{max-width:100%}blockquote{margin:0;padding:0 1em;border-left:4px solid #8886;color:#8b949e}';

function page(title, body, outRel) {
  const up = path.posix.relative(path.posix.dirname(outRel), '.') || '.';
  const root = up === '.' ? '' : up + '/';
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + ' | anti-hall</title><link rel="icon" href="' + root + 'assets/anti-hall-icon.png">' +
    '<style>' + CSS + '</style></head><body><header><a href="' + root + 'index.html">anti-hall</a>' +
    '<a href="' + root + 'docs/index.html">Docs</a><a href="' + root + 'llms.txt">llms.txt</a><a href="' + REPO_URL + '">GitHub</a></header>' +
    '<main>' + body + '</main></body></html>\n';
}

function write(rel, data) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const srcs = ['README.md'];
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir).sort()) if (/\.md$/.test(f) && f !== 'index.md') srcs.push('docs/' + f);
  }
  const pages = new Set(srcs);
  const written = ['index.html'];
  const docList = [];
  for (const src of srcs) {
    const r = render(fs.readFileSync(path.join(ROOT, src), 'utf8'), { src, pages });
    const title = r.title || path.basename(src, '.md');
    const outRel = outPathFor(src);
    write(outRel, page(title, r.html, outRel));
    if (src !== 'README.md') { docList.push({ href: path.posix.basename(outRel), title, src }); written.push(outRel); }
  }
  // docs/index.html: navigation over every converted docs page
  const nav = '<h1>Documentation</h1><p><a href="../index.html">Back to the README</a></p><ul>' +
    docList.map((d) => '<li><a href="' + d.href + '">' + esc(d.title) + '</a> <small><code>' + esc(d.src) + '</code></small></li>').join('') + '</ul>';
  write('docs/index.html', page('Documentation', nav, 'docs/index.html'));
  written.push('docs/index.html');

  if (fs.existsSync(path.join(ROOT, 'llms.txt'))) { fs.copyFileSync(path.join(ROOT, 'llms.txt'), path.join(OUT, 'llms.txt')); }
  for (const a of ASSETS) {
    const s = path.join(ROOT, a);
    if (fs.existsSync(s)) { fs.mkdirSync(path.dirname(path.join(OUT, a)), { recursive: true }); fs.copyFileSync(s, path.join(OUT, a)); }
  }
  write('.nojekyll', '');
  const urls = written.map((w) => w === 'index.html' ? '' : w).concat(fs.existsSync(path.join(OUT, 'llms.txt')) ? ['llms.txt'] : []);
  write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + esc(SITE_URL + u) + '</loc></url>').join('\n') + '\n</urlset>\n');
  write('robots.txt', 'User-agent: *\nAllow: /\n\nSitemap: ' + SITE_URL + 'sitemap.xml\n');
  return { pages: written.length, out: OUT };
}

if (require.main === module) {
  const r = build();
  console.log('site built: ' + r.pages + ' pages -> ' + r.out);
}
module.exports = { build, render };
