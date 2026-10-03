'use strict';
// Hygiene: every relative Markdown link to a .md file in README.md,
// plugins/anti-hall/README.md, and docs/**/*.md must resolve to a file that
// exists on disk, and every docs/*.md (top-level KB/guide docs) must be
// reachable from docs/README.md (the full doc index) or the root README.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function extractMdLinks(text) {
  const links = [];
  let m;
  while ((m = LINK_RE.exec(text))) {
    let target = m[1].trim();
    // strip markdown title syntax: (path "title")
    target = target.split(/\s+"/)[0];
    if (!target.endsWith('.md') && !target.includes('.md#')) continue;
    if (/^https?:\/\//.test(target)) continue; // external, not our concern here
    if (target.includes('<') || target.includes('>')) continue; // template placeholder, e.g. <date>/<session-id>.md
    target = target.split('#')[0];
    if (!target) continue;
    links.push(target);
  }
  return links;
}

function checkFile(relFile) {
  const abs = path.join(REPO, relFile);
  const text = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(abs);
  const violations = [];
  for (const target of extractMdLinks(text)) {
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      violations.push(`${relFile}: link "${target}" -> ${path.relative(REPO, resolved)} does not exist`);
    }
  }
  return violations;
}

test('README.md relative .md links resolve', () => {
  const violations = checkFile('README.md');
  assert.deepStrictEqual(violations, []);
});

test('plugins/anti-hall/README.md relative .md links resolve', () => {
  const violations = checkFile('plugins/anti-hall/README.md');
  assert.deepStrictEqual(violations, []);
});

test('plugins/anti-hall/codex/README.md relative .md links resolve', () => {
  const violations = checkFile('plugins/anti-hall/codex/README.md');
  assert.deepStrictEqual(violations, []);
});

// docsMarkdown(repo) -> repo-relative (forward-slash) paths of every docs/**/*.md.
// Tracked files only (`git ls-files`), so a local, git-ignored file such as
// docs/*-session-handoff.md never fails the check on a maintainer's checkout.
// Falls back to a filesystem walk when git is unavailable or `repo` is not a
// git repository (e.g. a tarball).
function docsMarkdown(repo) {
  try {
    const out = execFileSync('git', ['ls-files', '--', 'docs'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((f) => f.endsWith('.md'));
  } catch (_) {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path.relative(repo, full).split(path.sep).join('/'));
      }
    };
    try { walk(path.join(repo, 'docs')); } catch (_e) { /* no docs dir */ }
    return found;
  }
}

test('docs/**/*.md relative .md links resolve', () => {
  const violations = [];
  for (const rel of docsMarkdown(REPO)) violations.push(...checkFile(rel));
  assert.deepStrictEqual(violations, []);
});

test('docsMarkdown ignores an untracked, git-ignored docs/x-session-handoff.md (fixture repo)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-fixture-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/*-session-handoff.md\n');
    fs.writeFileSync(path.join(repo, 'docs', 'README.md'), '# idx\n');
    fs.writeFileSync(path.join(repo, 'docs', 'GUIDE.md'), '# guide\n');
    git('add', '-A');
    fs.writeFileSync(path.join(repo, 'docs', 'x-session-handoff.md'), '# local only\n');
    assert.deepStrictEqual(docsMarkdown(repo).sort(), ['docs/GUIDE.md', 'docs/README.md']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('every docs/*.md is linked from docs/README.md or the root README', () => {
  const docsDir = path.join(REPO, 'docs');
  const topLevelDocs = docsMarkdown(REPO)
    .filter((f) => f.split('/').length === 2 && f !== 'docs/README.md')
    .map((f) => f.slice('docs/'.length));

  const indexText = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  const rootReadmeText = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const combined = indexText + '\n' + rootReadmeText;

  const missing = topLevelDocs.filter((name) => !combined.includes(name));
  assert.deepStrictEqual(missing, [], `docs not linked from docs/README.md or README.md: ${missing.join(', ')}`);
});
