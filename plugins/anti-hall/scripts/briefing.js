#!/usr/bin/env node
'use strict';
// anti-hall :: briefing — a DERIVED (never hardcoded) system briefing for the
// agent that INSTALLS or OPERATES anti-hall. It answers "what is actually in this
// build, and where do I read more?" by ENUMERATING the real files on disk:
//
//   - every hook registered in hooks/hooks.json, grouped by event, each annotated
//     with the one-line purpose pulled from its OWN header comment (so a renamed /
//     re-purposed hook updates this briefing automatically — it cannot drift);
//   - the shipped skills (name + description read from each SKILL.md frontmatter);
//   - the DevSwarm coordination substrate (the 4 mechanical hooks, the store, the
//     CLI, the migration path) discovered from the files themselves;
//   - a docs/KB map (each doc's first heading) when the repo docs/ tree is present
//     (docs/ is repo-clone-only; it does NOT ship with `/plugin install`).
//
// This is the sibling of doctor.js: doctor answers "is it RUNNING / do the guards
// FIRE?" (behavioral self-tests); briefing answers "what IS it / how is it WIRED?"
// (a derived inventory). Neither hardcodes the hook list — both read hooks.json.
//
// Pure Node built-ins, cross-platform, read-only. Fail-soft: a bad section prints
// a note and the rest of the briefing still renders.
//
//   node scripts/briefing.js          human-readable briefing
//   node scripts/briefing.js --json   machine-readable JSON (same data)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');            // plugin root
const HOOKS_DIR = path.join(ROOT, 'hooks');
const JSON_OUT = process.argv.includes('--json');

const C = (!JSON_OUT && process.stdout.isTTY)
  ? { b: '\x1b[1m', c: '\x1b[36m', d: '\x1b[2m', y: '\x1b[33m', g: '\x1b[32m', x: '\x1b[0m' }
  : { b: '', c: '', d: '', y: '', g: '', x: '' };

// ---- helpers ---------------------------------------------------------------
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function listFiles(dir, re) {
  let e = [];
  try { e = fs.readdirSync(dir); } catch (_) { return []; }
  return e.filter((f) => (re ? re.test(f) : true)).sort();
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

// One-line purpose from a JS file's header comment. The repo convention is a
// leading `// <name> — purpose` or `// anti-hall :: <name> — purpose` block; we
// take the first substantive comment line and strip the boilerplate prefix.
function purposeOf(file) {
  const txt = readText(file);
  if (!txt) return '(unreadable)';
  const lines = txt.split('\n');
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    let l = lines[i].trim();
    if (!l) continue;
    if (l.startsWith('#!')) continue;                 // shebang
    if (/^['"]use strict['"];?$/.test(l)) continue;   // 'use strict'
    if (!l.startsWith('//')) {
      // a require()/const before any header comment -> no header; stop looking
      if (/^(const|let|var|require|module|function|import)\b/.test(l)) break;
      continue;
    }
    let out = l.replace(/^\/\/\s?/, '').trim();
    if (!out) continue;
    // Strip the boilerplate lead-in WITHOUT tripping on hyphens inside the project
    // token or the filename. Order matters: drop "anti-hall ::" first, then a
    // "<name>.js — " / "<name> — " prefix (— = em-dash U+2014, the repo convention;
    // an ASCII hyphen is NOT treated as the separator so `merge-gate` survives).
    out = out.replace(/^anti-hall\s*::\s*/i, '');
    out = out.replace(/^[\w.-]+\.js\s*[—–]\s*/, '');   // "merge-gate.js — ..." -> "..."
    const base = path.basename(file, '.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('^' + base + '\\b[\\s—–:]*'), '');
    out = out.trim();
    // Some headers put only a "(Event, scope)" qualifier or the bare module name
    // on line 1, with the real prose two lines down (after a blank `//`). When the
    // line-1 remainder is empty, a pure module name, or JUST a parenthetical scope
    // tag, look ahead for the first substantive comment line and use it (keeping
    // the scope tag as a lead-in when there was one).
    const scopeOnly = /^\([^)]*\)$/.test(out);
    if (!out || /^[\w.-]+$/.test(out) || scopeOnly) {
      const scope = scopeOnly ? out : '';
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const c = lines[j].trim();
        if (!c.startsWith('//')) break;
        const t = c.replace(/^\/\/\s?/, '').trim();
        if (!t) continue;                                 // blank comment spacer
        if (/^[-=*]{3,}$/.test(t)) continue;              // rule line
        if (/[a-z]/.test(t) === false && t.length <= 40) continue; // ALL-CAPS section header
        out = scope ? scope + ' — ' + t : t;
        break;
      }
    }
    return out.replace(/\s+/g, ' ').slice(0, 240);
  }
  return '(no header comment)';
}

// YAML-frontmatter name/description from a SKILL.md (first --- … --- block).
function skillMeta(skillMd) {
  const txt = readText(skillMd);
  if (!txt) return null;
  const m = txt.match(/^---\s*\n([\s\S]*?)\n---/);
  const body = m ? m[1] : '';
  const name = (body.match(/^name:\s*(.+)$/m) || [])[1];
  let desc = (body.match(/^description:\s*(.+)$/m) || [])[1] || '';
  desc = desc.replace(/\s+/g, ' ').trim();
  if (desc.length > 200) desc = desc.slice(0, 197) + '…';
  return { name: (name || '').trim(), description: desc };
}

function firstHeading(mdPath) {
  const txt = readText(mdPath);
  if (!txt) return '';
  const m = txt.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

// ---- gather ----------------------------------------------------------------
const briefing = { version: '(unknown)', hooksByEvent: {}, sharedHelpers: [], skills: [], devswarm: {}, docs: null };

try { briefing.version = JSON.parse(readText(path.join(ROOT, '.claude-plugin', 'plugin.json'))).version; } catch (_) {}

// Hooks — derive strictly from hooks.json (event -> [files]) + a purpose per file.
let hooksCfg = null;
try { hooksCfg = JSON.parse(readText(path.join(HOOKS_DIR, 'hooks.json'))); } catch (_) {}
const registered = new Set();
if (hooksCfg && hooksCfg.hooks) {
  for (const [event, groups] of Object.entries(hooksCfg.hooks)) {
    const seen = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = group.matcher || '';
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        const mm = String((h && h.command) || '').match(/[\w-]+\.js/);
        if (!mm) continue;
        registered.add(mm[0]);
        seen.push({ file: mm[0], matcher, purpose: purposeOf(path.join(HOOKS_DIR, mm[0])) });
      }
    }
    briefing.hooksByEvent[event] = seen;
  }
}
// Shared helpers: .js files in hooks/ (and hooks/lib/) NOT registered in hooks.json.
for (const f of listFiles(HOOKS_DIR, /\.js$/)) {
  if (!registered.has(f)) briefing.sharedHelpers.push({ file: f, purpose: purposeOf(path.join(HOOKS_DIR, f)) });
}
for (const f of listFiles(path.join(HOOKS_DIR, 'lib'), /\.js$/)) {
  briefing.sharedHelpers.push({ file: 'lib/' + f, purpose: purposeOf(path.join(HOOKS_DIR, 'lib', f)) });
}

// Skills.
for (const d of listFiles(path.join(ROOT, 'skills'))) {
  const sm = path.join(ROOT, 'skills', d, 'SKILL.md');
  if (!isFile(sm)) continue;
  const meta = skillMeta(sm);
  if (meta) briefing.skills.push(meta);
}

// DevSwarm substrate — discovered from the files, not hardcoded prose.
const substrate = {
  mechanicalHooks: [],
  store: null,
  cli: null,
  migration: [],
  supervisor: [],
};
for (const f of ['devswarm-parent-inbox.js', 'devswarm-parent-gate.js', 'devswarm-child-turn.js', 'devswarm-child-gate.js', 'devswarm-child-role.js']) {
  if (isFile(path.join(HOOKS_DIR, f))) substrate.mechanicalHooks.push({ file: f, purpose: purposeOf(path.join(HOOKS_DIR, f)) });
}
const storeP = path.join(ROOT, 'companion', 'lib', 'devswarm-store.js');
if (isFile(storeP)) substrate.store = { file: 'companion/lib/devswarm-store.js', purpose: purposeOf(storeP) };
const cliP = path.join(ROOT, 'scripts', 'devswarm.js');
if (isFile(cliP)) {
  // The CLI documents its own subcommands in a `// SUBCOMMANDS` header block —
  // parse the leading token of each documented line so this list can't drift.
  const txt = readText(cliP) || '';
  const cmds = [];
  const start = txt.indexOf('// SUBCOMMANDS');
  if (start >= 0) {
    const block = txt.slice(start).split('\n');
    for (let i = 1; i < block.length; i++) {
      const l = block[i];
      if (!/^\/\//.test(l)) break;
      // capture only the top-level subcommand token (the first word of each
      // documented "//   <cmd> …" line); dedupe preserves first-seen order.
      const m = l.match(/^\/\/\s{3}([a-z][\w-]*)\b/);
      if (m && !cmds.includes(m[1])) cmds.push(m[1]);
    }
  }
  substrate.cli = { file: 'scripts/devswarm.js', purpose: purposeOf(cliP), subcommands: cmds };
}
for (const f of ['devswarm-migrate.js', 'devswarm-ingest.js']) {
  const p = path.join(ROOT, 'companion', f);
  if (isFile(p)) substrate.migration.push({ file: 'companion/' + f, purpose: purposeOf(p) });
}
for (const f of ['devswarm-supervisor.js', 'devswarm-recover.js', 'install-devswarm-supervisor.js']) {
  const p = path.join(ROOT, 'companion', f);
  if (isFile(p)) substrate.supervisor.push({ file: 'companion/' + f, purpose: purposeOf(p) });
}
briefing.devswarm = substrate;

// docs/KB map — repo-clone-only (docs/ lives at the REPO root, two levels up from
// the plugin, and is NOT bundled by `/plugin install`). Map it when present.
const docsDir = path.resolve(ROOT, '..', '..', 'docs');
if (isDir(docsDir)) {
  const kb = [];
  for (const f of listFiles(docsDir, /^KB.*\.md$/)) kb.push({ file: 'docs/' + f, title: firstHeading(path.join(docsDir, f)) });
  briefing.docs = { present: true, dir: docsDir, kb };
} else {
  briefing.docs = { present: false, note: 'docs/ is repo-clone-only and not bundled with /plugin install — clone github.com/talas9/anti-hall to read the KB set' };
}

// ---- emit ------------------------------------------------------------------
if (JSON_OUT) {
  process.stdout.write(JSON.stringify(briefing, null, 2) + '\n');
  process.exit(0);
}

const out = [];
out.push(`${C.c}${C.b}anti-hall system briefing${C.x} ${C.d}v${briefing.version}${C.x}`);
out.push(`${C.d}Derived live from hooks.json + the files on disk — not a hardcoded list.${C.x}`);

out.push(`\n${C.b}Hooks (by event)${C.x}`);
for (const [event, arr] of Object.entries(briefing.hooksByEvent)) {
  out.push(`  ${C.y}${event}${C.x}`);
  for (const h of arr) {
    const mt = h.matcher ? ` ${C.d}[${h.matcher}]${C.x}` : '';
    out.push(`    ${C.g}${h.file}${C.x}${mt} — ${h.purpose}`);
  }
}

if (briefing.sharedHelpers.length) {
  out.push(`\n${C.b}Shared helpers (not registered as hooks)${C.x}`);
  for (const h of briefing.sharedHelpers) out.push(`  ${C.g}${h.file}${C.x} — ${h.purpose}`);
}

out.push(`\n${C.b}Skills${C.x}`);
for (const s of briefing.skills) out.push(`  ${C.g}${s.name}${C.x} — ${s.description}`);

out.push(`\n${C.b}DevSwarm coordination substrate${C.x}`);
if (substrate.mechanicalHooks.length) {
  out.push(`  ${C.y}mechanical triggers (hooks)${C.x}`);
  for (const h of substrate.mechanicalHooks) out.push(`    ${C.g}${h.file}${C.x} — ${h.purpose}`);
}
if (substrate.store) out.push(`  ${C.y}store${C.x}\n    ${C.g}${substrate.store.file}${C.x} — ${substrate.store.purpose}`);
if (substrate.cli) {
  out.push(`  ${C.y}CLI${C.x}\n    ${C.g}${substrate.cli.file}${C.x} — ${substrate.cli.purpose}`);
  if (substrate.cli.subcommands.length) out.push(`    ${C.d}subcommands: ${substrate.cli.subcommands.join(' · ')}${C.x}`);
}
if (substrate.migration.length) {
  out.push(`  ${C.y}migration (auto-safe: idempotent, non-destructive, single-consumer-locked, count-verified)${C.x}`);
  for (const h of substrate.migration) out.push(`    ${C.g}${h.file}${C.x} — ${h.purpose}`);
}
if (substrate.supervisor.length) {
  out.push(`  ${C.y}liveness supervisor + recovery${C.x}`);
  for (const h of substrate.supervisor) out.push(`    ${C.g}${h.file}${C.x} — ${h.purpose}`);
}

out.push(`\n${C.b}docs / KB map${C.x}`);
if (briefing.docs.present) {
  for (const d of briefing.docs.kb) out.push(`  ${C.g}${d.file}${C.x} — ${d.title}`);
} else {
  out.push(`  ${C.d}${briefing.docs.note}${C.x}`);
}

out.push(`\n${C.d}Health check (do the guards actually fire?): node hooks/doctor.js${C.x}`);
process.stdout.write(out.join('\n') + '\n');
process.exit(0);
