'use strict';
// anti-hall :: devswarm-capabilities — ONE version + runtime-detection gate for
// every DevSwarm surface anti-hall touches (hivecontrol verbs and app-DB
// tables/columns), so a feature whose surface is missing SLEEPS instead of
// failing at runtime.
//
// GATE = minVersion AND detection, both must pass:
//   - version: `hivecontrol --version` (first x.y.z), else the app's own
//     <home>/Library/Application Support/DevSwarm/sentry/session.json
//     `release` ("DevSwarm@2.5.2"). Unknown version -> detection alone decides.
//   - verbs: parsed from `hivecontrol workspace --help` (the Commands: list);
//     for archive/delete also `hivecontrol workspace <verb> --help` (usage +
//     flags) so callers build argv from what the binary actually documents.
//     ONLY `--version` and `--help` are ever spawned here — both read-only.
//   - columns: `PRAGMA table_info(<table>)` on the app DB, opened readOnly.
//   - appfs: existence of an app-owned file/dir (next to the DB, or under home).
//
// DORMANCY:
//   - hivecontrol absent (DevSwarm not installed) -> every verb capability is
//     dormant and SILENT (no doctor line). gatedRun passes the call through
//     untouched so the caller's existing "hivecontrol-unavailable" handling
//     stays byte-identical.
//   - hivecontrol present but a verb is missing / below minVersion -> dormant,
//     and ONE doctor line per (capability, version) is recorded in the cache
//     file ("feature X needs DevSwarm >= Y, you have Z"); doctor reads it
//     (companion/lib/doctor-devswarm.js capabilitiesCheck — no spawn there).
//
// CACHE: <home>/.anti-hall/devswarm/capabilities.json, keyed by the resolved
// binary's (path, mtimeMs, size) — i.e. per installed hivecontrol build — plus
// an in-process memo. A DevSwarm upgrade replaces the binary, so the key
// changes and detection re-runs once. Under `node --test` the cache is only
// written when the caller passed an explicit `home` (never the real home).
//
// API: can(name, opts) -> { ok, reason, version, minVersion, detail }
//      require(name, opts) -> same shape, never throws (alias: requireCap)
//      gatedRun(run) -> a hivecontrol runner that refuses a dormant verb.
//
// SIDE-EFFECTING — NEVER CALL from automation (documented, and asserted by
// tests/hygiene/devswarm-lifecycle-no-auto-delete.test.js):
//   - `hivecontrol workspace check-merge` — despite reading as a status probe,
//     2.5.2 runs "find/create worktree" for the source branch (observed:
//     `git worktree add -b '' ...` attempted from a Primary checkout). The
//     interactive `devswarm.js merge` verb keeps its existing use; nothing in
//     the lifecycle/auto-archive path may call it.
//   - the DevSwarm app's local HTTP API (127.0.0.1:47836: /api/*, /ws,
//     POST /mcp) — unauthenticated, and 2.5.2's DELETE /api/workspace/:id has
//     no Primary/archived guard. anti-hall goes ONLY through hivecontrol verbs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HELP_TIMEOUT_MS = 8000;
const SIDE_EFFECTING_VERBS = Object.freeze(['check-merge']);

// verb(name, minVersion, note) / column(table, col) / table(name) registry rows.
function verbCap(verb, minVersion, note) {
  return { name: 'workspace.' + verb, kind: 'verb', verb, minVersion: minVersion || null, note: note || null };
}
function columnCap(table, col) {
  return { name: 'appdb.' + table + '.' + col, kind: 'column', table, column: col, minVersion: null };
}
function tableCap(table) {
  return { name: 'appdb.' + table, kind: 'table', table, minVersion: null };
}
// appfs.<name>: a file/dir the DevSwarm app keeps on disk (never its content
// unless the reader documents otherwise). `base` = 'db' (next to the app DB)
// or 'home' (under the caller's home); `rel` = path segments below it.
function appFsCap(name, base, rel) {
  return { name: 'appfs.' + name, kind: 'appfs', base, rel, minVersion: null };
}

// minVersion null = present in every build anti-hall has observed (verified in
// 2.5.2); the floor is unknown, so detection alone gates it.
const CAPABILITIES = Object.freeze([
  verbCap('list'), verbCap('info'), verbCap('create'), verbCap('update-title'),
  verbCap('check-merge', null, 'side-effecting: may create a source worktree — interactive merge verb only'),
  verbCap('merge-from-source'), verbCap('merge-into-source'),
  verbCap('message-child'), verbCap('message-parent'),
  verbCap('read-messages'), verbCap('message-count'), verbCap('monitor'),
  // 2.5.3 (verified against the real 2.5.3 --help): `archive [idOrBranch]`
  // (recoverable, keeps the worktree) and `delete [idOrBranch]` (archived-only,
  // refuses uncommitted work). Both DEFAULT TO THE CURRENT WORKSPACE, have no
  // --yes and never prompt — callers always pass the explicit id.
  verbCap('archive', '2.5.3', 'auto-archive of done workspaces'),
  verbCap('delete', '2.5.3', 'prune of old archived workspaces'),
  // App-DB tables/columns: every column companion/lib/devswarm-app-db.js SCHEMA
  // reads is registered here (a test pins SCHEMA ⊆ registry).
  tableCap('builders'),
  columnCap('builders', 'id'), columnCap('builders', 'terminalId'), columnCap('builders', 'createdAt'),
  columnCap('builders', 'lastAccessed'), columnCap('builders', 'isPinned'),
  columnCap('builders', 'isActive'), columnCap('builders', 'isHidden'), columnCap('builders', 'label'),
  columnCap('builders', 'rank'), columnCap('builders', 'lastSelectedAt'), columnCap('builders', 'builderType'),
  columnCap('builders', 'branchName'), columnCap('builders', 'sourceBranch'), columnCap('builders', 'worktreePath'),
  columnCap('builders', 'repositoryId'), columnCap('builders', 'pullRequestId'),
  tableCap('builder_terminals'),
  columnCap('builder_terminals', 'id'), columnCap('builder_terminals', 'builderId'),
  columnCap('builder_terminals', 'terminalId'), columnCap('builder_terminals', 'terminalType'),
  columnCap('builder_terminals', 'aiAgent'), columnCap('builder_terminals', 'isActive'),
  columnCap('builder_terminals', 'createdAt'), columnCap('builder_terminals', 'lastViewedAt'),
  columnCap('builder_terminals', 'initialPromptDeliveredAt'), columnCap('builder_terminals', 'initialPromptWithheldAt'),
  columnCap('builder_terminals', 'ai_session_config'), columnCap('builder_terminals', 'initialPrompt'),
  columnCap('builder_terminals', 'panelStatus'),
  tableCap('pull_requests'),
  columnCap('pull_requests', 'id'), columnCap('pull_requests', 'repositoryId'), columnCap('pull_requests', 'number'),
  columnCap('pull_requests', 'isDraft'), columnCap('pull_requests', 'url'), columnCap('pull_requests', 'checkStatus'),
  columnCap('pull_requests', 'reviewStatus'), columnCap('pull_requests', 'lastSyncedAt'),
  columnCap('pull_requests', 'state'), columnCap('pull_requests', 'branchName'), columnCap('pull_requests', 'targetBranch'),
  tableCap('repositories'),
  columnCap('repositories', 'id'), columnCap('repositories', 'path'), columnCap('repositories', 'name'),
  columnCap('repositories', 'defaultBaseBranch'),
  tableCap('workspace_messages'),
  columnCap('workspace_messages', 'repositoryId'), columnCap('workspace_messages', 'toBranch'),
  columnCap('workspace_messages', 'createdAt'),
  // App files outside the DB (stat / names only — see devswarm-app-db.js).
  appFsCap('terminal-scrollback', 'db', ['terminal-scrollback']),
  appFsCap('sentry-session', 'db', ['sentry', 'session.json']),
  appFsCap('scheduled-for-deletion', 'home', ['.devswarm', 'scheduled-for-deletion']),
]);
const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

// ---------- version helpers ----------
function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s == null ? '' : s));
  return m ? m[1] + '.' + m[2] + '.' + m[3] : null;
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

// ---------- help parsing (pure; unit-tested against real 2.5.2 text) ----------
// parseCommands(helpText) -> Map(verb -> { usage, desc }). Reads the
// `Commands:` block of a commander-style help page: two-space-indented rows
// `name [args...]   description`; deeper-indented continuation lines ignored.
function parseCommands(helpText) {
  const out = new Map();
  const lines = String(helpText || '').split(/\r?\n/);
  let inCmds = false;
  for (const line of lines) {
    if (/^Commands:\s*$/.test(line)) { inCmds = true; continue; }
    if (!inCmds) continue;
    if (/^\S/.test(line)) break; // next section header
    const m = /^ {2}([a-z][\w-]*)((?: \S+)*?)(?: {2,}(.*))?$/.exec(line);
    if (!m) continue;
    out.set(m[1], { usage: (m[2] || '').trim(), desc: (m[3] || '').trim() });
  }
  return out;
}

// parseVerbHelp(helpText) -> { usage, args:[{name, required}], flags:[string] }.
function parseVerbHelp(helpText) {
  const text = String(helpText || '');
  const u = /^Usage:\s*(.*)$/m.exec(text);
  const usage = u ? u[1].trim() : '';
  const args = [];
  const argRe = /([<[])([\w-]+)[>\]]/g;
  let a;
  // Only positional tokens after the verb; `[options]` is not an argument.
  while ((a = argRe.exec(usage.replace(/\[options\]/g, ''))) !== null) {
    args.push({ name: a[2], required: a[1] === '<' });
  }
  const flags = [];
  let inOpts = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^Options:\s*$/.test(line)) { inOpts = true; continue; }
    if (!inOpts) continue;
    if (/^\S/.test(line)) break;
    const re = /(?:^|[\s,])(--?[A-Za-z][\w-]*)/g;
    const head = line.split(/ {2,}/).filter(Boolean)[0] || '';
    let f;
    while ((f = re.exec(head)) !== null) flags.push(f[1]);
  }
  return { usage, args, flags };
}

// ---------- binary resolution (fs-only; no shell lookup) ----------
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
function resolveBin(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const explicit = env.ANTIHALL_DEVSWARM_HIVECONTROL;
  if (typeof explicit === 'string' && path.isAbsolute(explicit.trim()) && isFile(explicit.trim())) return explicit.trim();
  const PATH = typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'hivecontrol');
    if (isFile(p)) return p;
  }
  if (o.home) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(o.home, '.anti-hall', 'devswarm', 'hivecontrol-path.json'), 'utf8'));
      if (c && typeof c.hivecontrol === 'string' && path.isAbsolute(c.hivecontrol) && isFile(c.hivecontrol)) return c.hivecontrol;
    } catch (_) {}
  }
  const known = Array.isArray(o.knownLocations) ? o.knownLocations
    : ((o.platform || process.platform) === 'darwin' ? ['/Applications/DevSwarm.app/Contents/Resources/cli/hivecontrol'] : []);
  for (const k of known) if (isFile(k)) return k;
  return null;
}

function defaultSpawn(bin, args, env) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: HELP_TIMEOUT_MS, env: env || process.env });
    if (r.error || r.signal) return { ok: false, out: '' };
    return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') };
  } catch (_) { return { ok: false, out: '' }; }
}

function sentryVersion(home) {
  if (!home) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'Library', 'Application Support', 'DevSwarm', 'sentry', 'session.json'), 'utf8'));
    return parseVersion(j && j.release);
  } catch (_) { return null; }
}

// ---------- cache ----------
function cachePath(home) { return path.join(home, '.anti-hall', 'devswarm', 'capabilities.json'); }
let memo = null; // { key, probe }

function readCache(home) {
  try { return JSON.parse(fs.readFileSync(cachePath(home), 'utf8')); } catch (_) { return null; }
}
function writeCache(home, data, o) {
  if (!home) return;
  // Never write the REAL home under `node --test` (repo rule: tests never
  // touch the real home) — os.userInfo() is the passwd home, immune to HOME.
  if (process.env.NODE_TEST_CONTEXT || (o.env && o.env.NODE_TEST_CONTEXT)) {
    let real = null;
    try { real = os.userInfo().homedir; } catch (_) { real = null; }
    if (!o.home || (real && path.resolve(home) === path.resolve(real))) return;
  }
  try {
    const p = cachePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (_) {}
}

// probe(opts) -> { present, bin, version, versionSource, verbs:{verb:{usage,desc,args?,flags?}} }.
// Cached per binary build; `opts.spawn(bin,args,env)` is the test seam.
function probe(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const bin = resolveBin({ env, home, knownLocations: o.knownLocations, platform: o.platform });
  if (!bin) return { present: false, bin: null, version: sentryVersion(home), versionSource: 'sentry', verbs: {} };
  let st = null;
  try { st = fs.statSync(bin); } catch (_) {}
  const key = bin + '|' + (st ? st.mtimeMs + '|' + st.size : '?');
  if (!o.fresh && memo && memo.key === key) return memo.probe;
  const cached = o.fresh ? null : readCache(home);
  if (cached && cached.key === key && cached.probe && cached.probe.present) {
    memo = { key, probe: cached.probe };
    return cached.probe;
  }
  const sp = o.spawn || defaultSpawn;
  let version = null;
  let versionSource = null;
  const v = sp(bin, ['--version'], env);
  if (v && v.ok) { version = parseVersion(v.out); versionSource = version ? 'hivecontrol' : null; }
  if (!version) { version = sentryVersion(home); versionSource = version ? 'sentry' : null; }
  const verbs = {};
  const h = sp(bin, ['workspace', '--help'], env);
  const cmds = parseCommands(h && h.out);
  for (const [name, row] of cmds) verbs[name] = { usage: row.usage, desc: row.desc };
  for (const name of ['archive', 'delete']) {
    if (!verbs[name]) continue;
    const vh = sp(bin, ['workspace', name, '--help'], env);
    if (vh && vh.out) Object.assign(verbs[name], parseVerbHelp(vh.out));
  }
  const result = { present: true, bin, version, versionSource, verbs, helpParsed: cmds.size > 0 };
  memo = { key, probe: result };
  const prev = readCache(home);
  const dormantLog = prev && prev.key === key && prev.dormantLog ? prev.dormantLog : {};
  writeCache(home, { key, checkedAt: new Date(o.now || Date.now()).toISOString(), probe: result, dormantLog }, o);
  return result;
}

// ---------- app-DB detection ----------
function appDbFile(o) {
  try { return require('./devswarm-app-db.js').appDbPath({ env: o.env || process.env, home: o.home, platform: o.platform }); }
  catch (_) { return null; }
}
const tableMemo = new Map(); // file|table -> Set(cols) | null
function tableColumns(file, table) {
  const k = file + '|' + table;
  if (tableMemo.has(k)) return tableMemo.get(k);
  let cols = null;
  let db = null;
  try {
    const sqlite = require('node:sqlite');
    if (isFile(file)) {
      db = new sqlite.DatabaseSync(file, { readOnly: true });
      const rows = db.prepare('PRAGMA table_info(' + JSON.stringify(table) + ')').all();
      cols = rows.length ? new Set(rows.map((r) => String(r.name))) : null;
    }
  } catch (_) { cols = null; } finally { try { if (db) db.close(); } catch (_) {} }
  tableMemo.set(k, cols);
  return cols;
}

// ---------- the gate ----------
function recordDormant(o, cap, res) {
  if (!res.version && !res.present) return;
  const home = o.home || os.homedir();
  const c = readCache(home);
  if (!c || !c.key) return;
  const line = 'feature ' + cap.name + (cap.note ? ' (' + cap.note + ')' : '') + ' is dormant: '
    + (cap.minVersion ? 'needs DevSwarm >= ' + cap.minVersion + ', you have ' + (res.version || 'unknown') : res.reason);
  c.dormantLog = c.dormantLog || {};
  if (c.dormantLog[cap.name] === line) return;
  c.dormantLog[cap.name] = line;
  writeCache(home, c, o);
}

function can(name, opts) {
  const o = opts || {};
  const cap = BY_NAME.get(String(name));
  if (!cap) return { ok: false, reason: 'unknown-capability', version: null, minVersion: null };
  try {
    if (cap.kind === 'verb') {
      const p = o.probeResult || probe(o);
      const base = { version: p.version, minVersion: cap.minVersion, present: p.present };
      if (!p.present) return Object.assign(base, { ok: false, reason: 'hivecontrol-absent', silent: true });
      if (cap.minVersion && p.version && cmpVersion(p.version, cap.minVersion) < 0) {
        const r = Object.assign(base, { ok: false, reason: 'requires DevSwarm >= ' + cap.minVersion + ' (have ' + p.version + ')' });
        recordDormant(o, cap, r);
        return r;
      }
      const v = p.verbs && p.verbs[cap.verb];
      if (!v) {
        const r = Object.assign(base, {
          ok: false,
          reason: (cap.minVersion ? 'requires DevSwarm >= ' + cap.minVersion + '; ' : '')
            + '`hivecontrol workspace ' + cap.verb + '` not in this build\'s --help',
        });
        recordDormant(o, cap, r);
        return r;
      }
      return Object.assign(base, { ok: true, reason: null, detail: v });
    }
    if (cap.kind === 'appfs') {
      let base = null;
      if (cap.base === 'home') base = o.home || null;
      else { const f = o.appDbFile || appDbFile(o); base = f ? path.dirname(f) : null; }
      if (!base) return { ok: false, reason: 'app-path-unavailable', version: null, minVersion: null, silent: true };
      const p = path.join(base, ...cap.rel);
      if (!fs.existsSync(p)) return { ok: false, reason: 'app path ' + cap.rel.join('/') + ' missing', version: null, minVersion: null, silent: true };
      return { ok: true, reason: null, version: null, minVersion: null };
    }
    // opts.appDbFile: the DB the caller already has open (so the gate checks
    // THAT file, not one re-derived from env/home).
    const file = o.appDbFile || appDbFile(o);
    if (!file) return { ok: false, reason: 'app-db-unavailable', version: null, minVersion: null, silent: true };
    const cols = tableColumns(file, cap.table);
    if (!cols) return { ok: false, reason: 'app-db table ' + cap.table + ' missing', version: null, minVersion: null };
    if (cap.kind === 'column' && !cols.has(cap.column)) {
      return { ok: false, reason: 'app-db column ' + cap.table + '.' + cap.column + ' missing', version: null, minVersion: null };
    }
    return { ok: true, reason: null, version: null, minVersion: null };
  } catch (e) {
    return { ok: false, reason: 'capability check failed: ' + String((e && e.message) || e), version: null, minVersion: null };
  }
}

// requireCap(name, opts) — "use this feature or sleep": same result as can(),
// plus `dormant: true` when not ok. NEVER throws.
function requireCap(name, opts) {
  const r = can(name, opts);
  return r.ok ? r : Object.assign({}, r, { dormant: true });
}

// capabilityForArgs(args) -> capability name | null. `workspace <verb> ...`
// maps to `workspace.<verb>`; anything else (health, repo, --help) is ungated.
function capabilityForArgs(args) {
  const a = Array.isArray(args) ? args : [];
  if (a[0] !== 'workspace' || typeof a[1] !== 'string' || a[1].startsWith('-')) return null;
  const name = 'workspace.' + a[1];
  return BY_NAME.has(name) ? name : null;
}

// gatedRun(run) -> runner(spec). Refuses (without spawning) a verb this build
// POSITIVELY lacks. Absent binary / ungated args / check failure -> passes the
// call through unchanged, so every caller's existing error handling holds.
function gatedRun(run, gateOpts) {
  const g = gateOpts || {};
  return function gated(spec) {
    const s = spec || {};
    const name = capabilityForArgs(s.args);
    if (name) {
      const env = s.env || process.env;
      const r = can(name, Object.assign({}, g, { env, home: s.home || (env && env.HOME) || os.homedir() }));
      if (!r.ok && !r.silent) {
        return { ok: false, raw: '', error: 'capability dormant: ' + name + ' — ' + r.reason, dormant: true, status: null, signal: null, stderr: '' };
      }
    }
    return run(s);
  };
}

// dormantLines(home) -> string[] — the recorded doctor lines (no spawn).
function dormantLines(home) {
  const c = readCache(home || os.homedir());
  if (!c || !c.dormantLog) return [];
  return Object.keys(c.dormantLog).sort().map((k) => c.dormantLog[k]);
}

function resetCache() { memo = null; tableMemo.clear(); }

module.exports = {
  CAPABILITIES, SIDE_EFFECTING_VERBS,
  can, requireCap, require: requireCap, gatedRun, capabilityForArgs,
  probe, parseCommands, parseVerbHelp, parseVersion, cmpVersion, resolveBin,
  cachePath, readCache, dormantLines, resetCache,
};
