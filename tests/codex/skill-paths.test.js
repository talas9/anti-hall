'use strict';
// Regression guard for the clone-relative-path P1: Codex skills used to hardcode
// `node plugins/anti-hall/...` invocations that assume cwd == the git clone root.
// Once anti-hall is installed as a real Codex plugin (.codex-plugin/plugin.json),
// cwd is the user's own project, not the clone, so every such invocation would
// ENOENT/MODULE_NOT_FOUND. Codex does not expand ${PLUGIN_ROOT} inside a skill's
// own instructions -- that variable is only set for plugin-bundled hook commands
// (docs/KB-codex-platform-hooks-plugins.md), and there is no other Codex-native
// equivalent for skill bodies -- so every skill must instead resolve its own
// plugin root at runtime (see the "Resolve the plugin root" preamble each
// SKILL.md now carries) and route commands through that resolved variable.
//
// This test scans every codex skill's SKILL.md for the anti-pattern: a `node`
// invocation or `require(...)` call using a literal clone-relative
// `plugins/anti-hall/...` path. Any match means the file still assumes cwd ==
// clone root and will break once installed as a real plugin.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'skills');

// Matches `node plugins/anti-hall/...`, `node "plugins/anti-hall/...`, and
// `require('./plugins/anti-hall/...')` / `require("plugins/anti-hall/...")` --
// the two shapes the original bug used. Deliberately does NOT match plain prose
// mentions of the repo-relative path (e.g. a sentence identifying a script by
// name) since those aren't invocations and don't break at runtime.
const CLONE_RELATIVE_INVOCATION = /\bnode\s+(?:--\S+\s+)*["']?plugins\/anti-hall\/|require\(\s*["']\.{0,2}\/?plugins\/anti-hall\//;

function listSkillFiles() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SKILLS_DIR, entry.name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file));
}

test('no codex skill hardcodes a clone-relative node/require invocation', () => {
  const files = listSkillFiles();
  assert.ok(files.length > 0, 'expected to find at least one SKILL.md under codex/skills');

  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (CLONE_RELATIVE_INVOCATION.test(content)) {
      offenders.push(path.relative(SKILLS_DIR, file));
    }
  }

  assert.deepStrictEqual(offenders, [], `clone-relative invocations found in: ${offenders.join(', ')}`);
});

test('every skill that references the plugin root resolves it via ANTI_HALL_ROOT', () => {
  const files = listSkillFiles();
  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const usesRoot = /\$ANTI_HALL_ROOT\b/.test(content);
    const resolvesRoot = /ANTI_HALL_ROOT="\$\(cd/.test(content);
    // A file that uses $ANTI_HALL_ROOT must also define it (the resolver
    // preamble); a file with neither is simply out of scope for this fix.
    if (usesRoot && !resolvesRoot) offenders.push(path.relative(SKILLS_DIR, file));
  }

  assert.deepStrictEqual(offenders, [], `references $ANTI_HALL_ROOT without resolving it: ${offenders.join(', ')}`);
});
