'use strict';
// anti-hall :: skill-pointer integrity test.
//
// Every `/anti-hall:<name>` string emitted anywhere in the shipped
// hooks/scripts/companion/monitors/skills tree is a promise that a real
// skill exists at that pointer. Two historical dead pointers slipped through
// without a test: a graphify wiki-index path that never existed, and (until
// this task) `/anti-hall:defects` referenced from defect-nudge.js on BOTH
// ports before the `defects` skill itself existed. This test makes that
// class of bug permanently mechanical, not something a human has to notice.
//
// NO ALLOWLIST — every captured name is checked, unconditionally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const SCAN_DIRS = ['hooks', 'scripts', 'companion', 'monitors', 'skills'];
const PTR_RE = /\/anti-hall:([a-z0-9-]+)/g;

// walk(dir) -> array of absolute file paths under dir, recursive.
function walk(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// scanPointers(root, scanDirs) -> Map<name, Set<absoluteFilePath>> of every
// /anti-hall:<name> pointer found under root/<scanDirs[i]>/**.
function scanPointers(root, scanDirs) {
  const found = new Map();
  for (const d of scanDirs) {
    const files = walk(path.join(root, d));
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (_) {
        continue; // unreadable (binary, permissions) -> skip, not our concern here
      }
      PTR_RE.lastIndex = 0;
      let m;
      while ((m = PTR_RE.exec(content))) {
        const name = m[1];
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(file);
      }
    }
  }
  return found;
}

// frontmatterName(skillMdPath) -> the `name:` value from the YAML frontmatter
// block, or null if unreadable/absent.
function frontmatterName(skillMdPath) {
  let content;
  try {
    content = fs.readFileSync(skillMdPath, 'utf8');
  } catch (_) {
    return null;
  }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return null;
  const nm = /^name:\s*(.+?)\s*$/m.exec(fm[1]);
  return nm ? nm[1].trim() : null;
}

test('every /anti-hall:<name> pointer resolves to skills/<name>/SKILL.md with matching frontmatter name', () => {
  const found = scanPointers(ROOT, SCAN_DIRS);
  assert.ok(found.size > 0, 'sanity: the scan should find at least one pointer in this repo');
  const problems = [];
  for (const [name, files] of found) {
    const skillPath = path.join(ROOT, 'skills', name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      problems.push(`/anti-hall:${name} (referenced in: ${[...files].join(', ')}) -> no skills/${name}/SKILL.md`);
      continue;
    }
    const fmName = frontmatterName(skillPath);
    if (fmName !== name) {
      problems.push(`/anti-hall:${name} -> skills/${name}/SKILL.md frontmatter name is "${fmName}", expected "${name}"`);
    }
  }
  assert.deepEqual(problems, [], 'dead or mismatched skill pointers found:\n' + problems.join('\n'));
});

test('every /anti-hall:<name> pointer referenced from a codex-invoked file also has codex/skills/anti-hall-<name>/SKILL.md', () => {
  const codexHooksPath = path.join(ROOT, 'codex', 'hooks', 'hooks.json');
  const codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));

  // Collect every hook script basename Codex's hooks.json actually invokes.
  const invokedBasenames = new Set();
  for (const eventArr of Object.values(codexHooks.hooks || {})) {
    for (const group of eventArr || []) {
      for (const h of (group.hooks || [])) {
        const cmd = h.command || '';
        const m = /([A-Za-z0-9_.-]+\.js)/.exec(cmd);
        if (m) invokedBasenames.add(m[1]);
      }
    }
  }
  assert.ok(invokedBasenames.size > 0, 'sanity: codex/hooks/hooks.json should invoke at least one .js file');

  const found = scanPointers(ROOT, SCAN_DIRS);
  const problems = [];
  for (const [name, files] of found) {
    const referencedFromCodexInvoked = [...files].some((f) => invokedBasenames.has(path.basename(f)));
    if (!referencedFromCodexInvoked) continue;
    const codexSkillPath = path.join(ROOT, 'codex', 'skills', `anti-hall-${name}`, 'SKILL.md');
    if (!fs.existsSync(codexSkillPath)) {
      problems.push(`/anti-hall:${name} is referenced from a codex-invoked file but has no codex/skills/anti-hall-${name}/SKILL.md`);
    }
  }
  assert.deepEqual(problems, [], 'codex-invoked files reference a pointer with no codex mirror skill:\n' + problems.join('\n'));
});

test('the pointer scan catches a deliberately-introduced fake /anti-hall:nonexistent reference', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-skillptr-'));
  try {
    fs.mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hooks', 'fake-hook.js'), "// see /anti-hall:nonexistent for details\n");

    const found = scanPointers(tmp, SCAN_DIRS);
    assert.ok(found.has('nonexistent'), 'the scan found the deliberately-introduced fake pointer');

    const skillPath = path.join(tmp, 'skills', 'nonexistent', 'SKILL.md');
    assert.ok(!fs.existsSync(skillPath), 'the fake pointer resolves to no skill -> the real assertion above would fail on this input');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
