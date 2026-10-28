'use strict';
// anti-hall :: defect-history — turns the defect channel into a bug HISTORY,
// so the same thing does not get fixed in circles.
//
//   backfill(opts)          one-time, idempotent import of FIXED bugs from a
//                           repo's git history (fix/fix(scope) commits).
//   loadAllRecords(home)    reported defects + backfill records, normalized.
//   recurring(records, o)   group by component / cause, flag hotspots and
//                           likely regressions.
//   similar(records, text)  past fixes that look like a new bug.
//
// Storage: backfill records live under defect-store's historyDir()
// (~/.anti-hall/defects/history/<sha12>.jsonl) — one self-contained
// `t:'backfill'` line per fix commit, written through defect-store's
// appendLine() (O_EXCL create, byte-verified). The file name is the commit
// key, so a re-run finds the file and adds nothing. Because it is a
// subdirectory, the open-defect readers (list/nudge/archive) never see it.
//
// Pure Node built-ins only. Cross-platform (git is invoked via execFileSync
// with an argv array, never a shell string).

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const store = require('./defect-store.js');

const { CAUSE_ENUM, normalizeComponent, historyDir, cmpSemver } = store;

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

// CAUSE_RULES: keyword rules for classifyCause(), checked against the
// lower-cased subject+body. Every class that matches scores its number of
// distinct keyword hits; the highest score wins and ties go to the class
// listed first (the more specific classes are listed first on purpose).
const CAUSE_RULES = [
  ['archived-or-held-state', [/\barchiv/, /\bheld\b/, /\bheldpartition/, /\bunarchiv/, /\bretire/, /\bresurrect/, /\borphan/, /\bghost\b/, /\breused id\b/]],
  ['lock-or-race', [/\block\b/, /\blocks\b/, /acquirelock/, /\brace\b/, /\bracers?\b/, /toctou/, /lost-update/, /\bconcurren/, /\batomic/, /both win/]],
  ['home-or-state-leak', [/\bhome\b/, /\bleak/, /unbounded/, /grow without limit/, /real machine/, /\bpollut/, /real launchd/, /\bisolat/]],
  ['transcript-parse', [/transcript/, /\bpars(e|ing|er)\b/, /\bregex/, /\bcrlf\b/, /\bshapes?\b/, /quote-aware/, /\bescap/, /line-ending/, /\btokeniz/]],
  ['id-mismatch', [/\bidentit/, /\bsession ?id\b/, /\bsessionid/, /\bpartition/, /\brepokey/, /\balias/, /\btwin\b/, /\bfamil(y|ies)\b/, /attribution/, /\bshortid/, /builder_?id/, /builderType/i, /\bmesh ?id/, /\bwrong row\b/, /\bid\b/]],
  ['timing-or-load-flake', [/\bflak/, /timeout/, /timed out/, /deadline/, /contention/, /\bpacing\b/, /\bpace\b/, /\bttl\b/, /grace window/, /\bmtime\b/, /\bslow\b/, /\bbudget\b/]],
  ['platform-compat', [/\bwindows\b/, /\bwin32\b/, /cross-platform/, /\bmacos\b/, /\blinux\b/, /\bnode (18|20|22)\b/, /\bcmux\b/, /8\.3 short/]],
  ['blocking-hook-loop', [/\bblocks?\b/, /\bblocking\b/, /\bblocked\b/, /stop gate/, /stop-gate/, /\bnag/, /\bescalat/, /false[- ]positiv/, /false-block/, /\bhard-block/, /\bloop\b/]],
  ['fail-open-missing', [/fail[- ]open/, /fail[- ]closed/, /\bsilent/, /\binert\b/, /\bswallow/, /\bcrash/, /\bthrows?\b/, /no silent/, /\bhonest/]],
  ['stale-path-or-version', [/\bstale\b/, /\bpath\b/, /\bpaths\b/, /\bversion\b/, /\bcache\b/, /\bcached\b/, /\bresolv/, /\brelative\b/, /re-register/, /\bre-exec/]],
  ['wrong-default', [/\bdefaults?\b/, /\bopt-in\b/, /\bopt-out\b/, /\bto off\b/]],
];

// classifyCause(text) -> one of CAUSE_ENUM (never null).
function classifyCause(text) {
  const s = String(text || '').toLowerCase();
  let best = 'other';
  let bestScore = 0;
  for (const [cause, res] of CAUSE_RULES) {
    let score = 0;
    for (const re of res) if (re.test(s)) score++;
    if (score > bestScore) { best = cause; bestScore = score; }
  }
  return best;
}

// isSourceFile(p) -> true iff a changed file can name a fix's component:
// shipped code, not tests, docs, changelogs, manifests or skill prose.
const SOURCE_EXT = /\.(c|m)?js$|\.(sh|py|ts)$/;
function isSourceFile(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!SOURCE_EXT.test(s)) return false;
  if (/(^|\/)(tests?|__tests__|fixtures|docs|eval)\//.test(s)) return false;
  if (/\.test\.(c|m)?js$|\.spec\.(c|m)?js$/.test(s)) return false;
  return true;
}

// testedModule(p) -> the module a test file exercises
// (tests/hooks/api-guard.test.js -> hooks/api-guard), or null.
function testedModule(p) {
  const m = /^tests\/(.+?)(\.[a-z0-9-]+)*\.test\.(c|m)?js$/.exec(String(p || '').replace(/\\/g, '/'));
  return m ? normalizeComponent(m[1]) : null;
}

// dominantComponent(files, scope) -> component of the source file with the
// most changed lines (added + deleted); ties keep git's file order. Tests and
// docs never compete with source. Only when a fix touched NO source file
// (a test-only CI fix, a skill-prose fix) does it fall back, in order, to:
// the commit's conventional scope; the module its biggest test file tests;
// the skill directory it edited; else null.
function dominantComponent(files, scope) {
  const biggest = (pred) => {
    let best = null;
    for (const f of files || []) {
      if (!pred(f.file)) continue;
      const n = (f.added || 0) + (f.deleted || 0);
      if (!best || n > best.n) best = { file: f.file, n };
    }
    return best ? best.file : null;
  };
  const src = biggest(isSourceFile);
  if (src) return normalizeComponent(src);
  if (scope) return normalizeComponent(scope);
  const t = biggest((p) => !!testedModule(p));
  if (t) return testedModule(t);
  const sk = biggest((p) => /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(p));
  if (sk) return normalizeComponent(sk.replace(/\/SKILL\.md$/, ''));
  return null;
}

// ---------------------------------------------------------------------------
// git + changelog readers
// ---------------------------------------------------------------------------

function git(repo, args) {
  return cp.execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const FIX_SUBJECT_RE = /^fix(\(([^)]*)\))?!?:\s*/i;
// A subject that NAMES its own release ("fix: v0.4.7 - ...", "fix: v0.57 Wave
// F ..."). Older history predates the first tag, so `first tag containing`
// would lump every such fix into that first tag; the stated release is the
// better answer whenever it is not later than the tag.
const SUBJECT_VERSION_RE = /^fix(\([^)]*\))?!?:\s*v(\d+\.\d+(?:\.\d+)?)\b/i;

function fixedInFor(subject, tagVersion) {
  const m = SUBJECT_VERSION_RE.exec(subject);
  if (!m) return tagVersion || null;
  const sv = m[2].split('.').length === 2 ? m[2] + '.0' : m[2];
  if (!tagVersion) return sv;
  const c = cmpSemver(sv, tagVersion);
  return c !== null && c < 0 ? sv : tagVersion;
}

// collectFixCommits(repo) -> [{ sha, date, subject, body, scope, files }]
// for every non-merge commit whose subject starts with fix: / fix(scope):.
function collectFixCommits(repo) {
  const RS = '\x1e';
  const US = '\x1f';
  const out = git(repo, ['log', '--no-merges', '--no-renames', '--numstat',
    `--format=${RS}%H${US}%aI${US}%s${US}%b${US}`]);
  const commits = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(US);
    if (parts.length < 5) continue;
    const [sha, date, subject, body] = parts;
    const m = FIX_SUBJECT_RE.exec(subject);
    if (!m) continue;
    const files = [];
    for (const line of parts.slice(4).join(US).split('\n')) {
      const t = line.split('\t');
      if (t.length < 3) continue;
      files.push({ file: t.slice(2).join('\t'), added: parseInt(t[0], 10) || 0, deleted: parseInt(t[1], 10) || 0 });
    }
    commits.push({ sha, date, subject, body: body.trim(), scope: m[2] || null, files });
  }
  return commits;
}

// releaseMap(repo) -> Map<sha, version> — the EARLIEST semver tag containing
// each commit (the same answer as `git tag --contains` + a semver sort, but
// one rev-list per tag instead of one tag query per commit).
function releaseMap(repo) {
  const tags = git(repo, ['tag', '--list']).split('\n').map((t) => t.trim())
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => cmpSemver(a.replace(/^v/, ''), b.replace(/^v/, '')) || 0);
  const map = new Map();
  for (const tag of tags) {
    const v = tag.replace(/^v/, '');
    for (const sha of git(repo, ['rev-list', tag]).split('\n')) {
      if (sha && !map.has(sha)) map.set(sha, v);
    }
  }
  return map;
}

// parseChangelog(text) -> Map<version, string[]> of top-level bullets per
// `## X.Y.Z` section (continuation lines folded into their bullet).
function parseChangelog(text) {
  const map = new Map();
  let cur = null;
  let bullet = null;
  const flush = () => { if (cur && bullet) map.get(cur).push(bullet.replace(/\s+/g, ' ').trim()); bullet = null; };
  for (const line of String(text || '').split('\n')) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(line);
    if (h) { flush(); cur = h[1]; if (!map.has(cur)) map.set(cur, []); continue; }
    if (!cur) continue;
    if (/^#/.test(line)) { flush(); continue; }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) { flush(); bullet = b[1]; continue; }
    if (bullet && /^\s+\S/.test(line)) bullet += ' ' + line.trim();
    else if (!line.trim()) flush();
  }
  flush();
  return map;
}

// ---------------------------------------------------------------------------
// token scoring (shared by changelog linking and `similar`)
// ---------------------------------------------------------------------------

const STOP = new Set(('the and for not but with from into that this than then when what does never now '
  + 'its it\'s are was were has have had can could should would will all any one two out off via per '
  + 'fix fixes fixed only also still just more less new old instead again after before').split(' '));

// tokens(text) -> Set of lower-cased word tokens (>= 3 chars, no stop words,
// no bare numbers) with a plural 's' stripped, so "blocks"/"block" and
// "workspaces"/"workspace" overlap.
function tokens(text) {
  const set = new Set();
  for (let t of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) set.add(t);
  }
  return set;
}
function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// linkChangelog(subject, bullets) -> the bullet sharing the most tokens with
// the subject (at least 2 shared tokens), or null.
function linkChangelog(subject, bullets) {
  const st = tokens(subject.replace(FIX_SUBJECT_RE, ''));
  let best = null;
  let bestN = 1;
  for (const b of bullets || []) {
    const n = overlap(st, tokens(b));
    if (n > bestN) { best = b; bestN = n; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

// backfill({ repo, home, dryRun }) -> { repo, dryRun, scanned, imported,
// existing, failed, records }. `records` are the would-be/actual record
// objects for every fix commit scanned. Idempotent: a commit whose record
// file exists is counted `existing` and left untouched. Throws only when
// `repo` is not a readable git repository.
function backfill(opts) {
  const o = opts || {};
  const repo = path.resolve(o.repo || process.cwd());
  const commits = collectFixCommits(repo);
  const releases = releaseMap(repo);
  let changelog = new Map();
  try { changelog = parseChangelog(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8')); } catch (_) { /* no changelog */ }

  const dir = historyDir(o.home);
  const res = { repo, dryRun: !!o.dryRun, scanned: commits.length, imported: 0, existing: 0, failed: 0, records: [] };
  for (const c of commits) {
    const fixedIn = fixedInFor(c.subject, releases.get(c.sha) || null);
    const rec = {
      t: 'backfill',
      at: c.date,
      source: 'backfill',
      status: 'fixed',
      fixCommit: c.sha,
      subject: store.clampField(c.subject, 200),
      component: dominantComponent(c.files, c.scope),
      cause: classifyCause(c.subject + '\n' + c.body),
      fixedIn,
    };
    const cl = fixedIn ? linkChangelog(c.subject, changelog.get(fixedIn)) : null;
    if (cl) rec.changelog = store.clampField(cl, 600);
    res.records.push(rec);

    const file = path.join(dir, c.sha.slice(0, 12) + '.jsonl');
    if (fs.existsSync(file)) { res.existing++; continue; }
    if (o.dryRun) { res.imported++; continue; }
    store.ensureDir(dir);
    const w = store.appendLine(file, JSON.stringify(rec), { create: true, exclusive: true });
    if (w.outcome === 'recorded') res.imported++;
    else if (w.outcome === 'exists') res.existing++;
    else res.failed++;
  }
  return res;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function jsonlFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch (_) { return []; }
}

// normalizeRecord(fp, parsedLines) -> one flat record for recurring/similar.
// Works for old records (no component/cause -> null) and backfill lines.
function normalizeRecord(fp, parsed) {
  const st = store.deriveState(parsed);
  const lastReport = [...parsed].reverse().find((p) => p.t === 'report');
  const bf = parsed.find((p) => p.t === 'backfill');
  return {
    fp,
    source: bf ? 'backfill' : 'reported',
    status: st.status,
    component: st.component || null,
    cause: st.cause || null,
    fixedIn: st.fixedIn || null,
    fixCommit: st.fixCommit || null,
    regressionOf: st.regressionOf || null,
    date: bf ? bf.at : (st.firstSeen || null),
    subject: bf ? bf.subject : (lastReport ? lastReport.sym : ''),
    changelog: bf && bf.changelog ? bf.changelog : null,
    class: lastReport ? lastReport.class : null,
  };
}

// loadAllRecords(home) -> every reported defect (open dir + archive
// buckets) plus every backfill record, normalized.
function loadAllRecords(home) {
  const files = jsonlFiles(store.defectsDir(home));
  let months = [];
  try { months = fs.readdirSync(store.archiveDir(home)); } catch (_) { months = []; }
  for (const m of months) files.push(...jsonlFiles(path.join(store.archiveDir(home), m)));
  files.push(...jsonlFiles(historyDir(home)));
  const out = [];
  for (const f of files) {
    const parsed = store.parseLines(store.readRawLines(f));
    if (!parsed.length) continue;
    out.push(normalizeRecord(path.basename(f, '.jsonl'), parsed));
  }
  return out;
}

// ---------------------------------------------------------------------------
// recurring
// ---------------------------------------------------------------------------

const UNCLASSIFIED = '(unclassified)';
const HOTSPOT_COMPONENT_MIN = 3;
const HOTSPOT_PAIR_MIN = 2;
const REGRESSION_WINDOW = 5; // releases

function isVersion(s) { return /^v?\d+\.\d+\.\d+$/.test(String(s || '')); }

// sinceFilter(since) -> predicate. A version keeps records fixed in that
// release or later (unreleased fixes count as newest); anything else is
// parsed as a date and compared against the record's date.
function sinceFilter(since) {
  if (!since) return () => true;
  if (isVersion(since)) {
    const v = String(since).replace(/^v/, '');
    return (r) => {
      if (!r.fixedIn) return true; // unreleased fix / still-open report: newer than any release
      const c = cmpSemver(r.fixedIn, v);
      return c !== null && c >= 0; // unparseable version: not comparable, excluded
    };
  }
  const t = Date.parse(since);
  if (Number.isNaN(t)) return () => true;
  return (r) => (r.date ? Date.parse(r.date) >= t : false);
}

function span(list) {
  const versions = [...new Set(list.map((r) => r.fixedIn).filter(Boolean))]
    .sort((a, b) => cmpSemver(a, b) || 0);
  const dates = list.map((r) => r.date).filter(Boolean).sort();
  return { versions, firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null };
}

function groupBy(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// recurring(records, { since }) -> { total, byComponent, byCause, hotspots,
// regressions }.
//   hotspot: a component with >= 3 records, or a component+cause pair with
//            >= 2 (unclassified components never qualify).
//   regression: (a) a record with an explicit regressionOf, or (b) a fix of
//            the same component+cause whose release is within 5 releases of
//            an earlier fix of that pair. Release distance is counted over
//            the ordered set of releases that appear in the records (a fix
//            not yet in any release sorts as the newest).
function recurring(allRecords, opts) {
  const o = opts || {};
  const records = allRecords.filter(sinceFilter(o.since));
  const comp = (r) => r.component || UNCLASSIFIED;
  const cause = (r) => r.cause || UNCLASSIFIED;

  const byComponent = [...groupBy(records, comp)].map(([component, list]) => Object.assign({
    component, count: list.length,
    causes: Object.fromEntries([...groupBy(list, cause)].map(([k, v]) => [k, v.length])),
  }, span(list))).sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));

  const byCause = [...groupBy(records, cause)].map(([c, list]) => Object.assign({
    cause: c, count: list.length, components: new Set(list.map(comp)).size,
  }, span(list))).sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));

  const hotspots = [];
  for (const c of byComponent) {
    if (c.component === UNCLASSIFIED) continue;
    if (c.count >= HOTSPOT_COMPONENT_MIN) {
      hotspots.push({ kind: 'component', component: c.component, cause: null, count: c.count, versions: c.versions, firstDate: c.firstDate, lastDate: c.lastDate });
    }
  }
  const pairs = groupBy(records.filter((r) => r.component && r.cause), (r) => r.component + '\u0000' + r.cause);
  for (const [k, list] of pairs) {
    if (list.length < HOTSPOT_PAIR_MIN) continue;
    const [component, c] = k.split('\u0000');
    hotspots.push(Object.assign({ kind: 'component+cause', component, cause: c, count: list.length }, span(list)));
  }
  hotspots.sort((a, b) => b.count - a.count || (a.kind === 'component' ? -1 : 1) - (b.kind === 'component' ? -1 : 1) || a.component.localeCompare(b.component));

  // release ordering for the regression window
  const rel = [...new Set(records.map((r) => r.fixedIn).filter(Boolean))].sort((a, b) => cmpSemver(a, b) || 0);
  const idx = (r) => (r.fixedIn ? rel.indexOf(r.fixedIn) : rel.length);
  const regressions = [];
  const byFp = new Map(allRecords.map((r) => [r.fp, r]));
  for (const r of records) {
    if (r.regressionOf) {
      const e = byFp.get(r.regressionOf);
      regressions.push({ explicit: true, fp: r.fp, fixCommit: r.fixCommit, component: r.component, cause: r.cause, fixedIn: r.fixedIn,
        subject: r.subject, earlierFp: r.regressionOf, earlierCommit: e ? e.fixCommit : null, earlierFixedIn: e ? e.fixedIn : null, distance: null });
    }
  }
  for (const [, list] of pairs) {
    const fixed = list.filter((r) => r.status === 'fixed' || r.source === 'backfill')
      .sort((a, b) => idx(a) - idx(b) || String(a.date).localeCompare(String(b.date)));
    for (let i = 1; i < fixed.length; i++) {
      const cur = fixed[i];
      if (regressions.some((g) => g.fp === cur.fp)) continue;
      const prev = fixed[i - 1];
      const d = idx(cur) - idx(prev);
      if (d >= 1 && d <= REGRESSION_WINDOW) {
        regressions.push({ explicit: false, fp: cur.fp, fixCommit: cur.fixCommit, component: cur.component, cause: cur.cause, fixedIn: cur.fixedIn,
          subject: cur.subject, earlierFp: prev.fp, earlierCommit: prev.fixCommit, earlierFixedIn: prev.fixedIn, distance: d });
      }
    }
  }
  return { total: records.length, since: o.since || null, byComponent, byCause, hotspots, regressions };
}

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------

function componentMatches(recComp, want) {
  if (!recComp || !want) return false;
  return recComp === want || recComp.endsWith('/' + want) || want.endsWith('/' + recComp);
}

// similar(records, text, { component, top }) -> up to `top` (default 10)
// past records ranked by: +5 when the component matches --component, plus
// one point per query token shared with the record's subject, changelog
// bullet, component and cause. Records scoring 0 are dropped; ties go to the
// most recent.
function similar(records, text, opts) {
  const o = opts || {};
  const want = o.component ? normalizeComponent(String(o.component)) : null;
  const q = tokens(text);
  const top = o.top > 0 ? o.top : 10;
  const scored = [];
  for (const r of records) {
    const hay = tokens([r.subject, r.changelog, r.component ? r.component.replace(/[/-]/g, ' ') : '', r.cause ? r.cause.replace(/-/g, ' ') : ''].join(' '));
    let score = overlap(q, hay);
    if (want && componentMatches(r.component, want)) score += 5;
    if (score > 0) scored.push(Object.assign({ score }, r));
  }
  scored.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return scored.slice(0, top);
}

// ---------------------------------------------------------------------------
// plain-text formatting
// ---------------------------------------------------------------------------

// pad(s, n) -> s in an n-wide column, always leaving one separating space.
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n - 2) + '~ ' : s + ' '.repeat(n - s.length); }
function vspan(v) { return !v || !v.length ? '-' : (v.length === 1 ? v[0] : `${v[0]}..${v[v.length - 1]}`); }
function dspan(a, b) { return a ? `${String(a).slice(0, 10)}..${String(b).slice(0, 10)}` : '-'; }
function short(sha) { return sha ? String(sha).slice(0, 7) : '-'; }

function formatRecurring(rep, opts) {
  const top = (opts && opts.top > 0) ? opts.top : 10;
  const L = [];
  L.push(`${rep.total} records${rep.since ? ` since ${rep.since}` : ''} (reported + backfill)`);
  L.push('');
  L.push(`HOTSPOTS (component fixed >= ${HOTSPOT_COMPONENT_MIN}x, or same component+cause >= ${HOTSPOT_PAIR_MIN}x) — fix the class, not the instance`);
  if (!rep.hotspots.length) L.push('  none');
  else {
    L.push('  ' + pad('COUNT', 6) + pad('COMPONENT', 38) + pad('CAUSE', 24) + pad('VERSIONS', 18) + 'DATES');
    for (const h of rep.hotspots.slice(0, top)) {
      L.push('  ' + pad(h.count, 6) + pad(h.component, 38) + pad(h.cause || '(any)', 24) + pad(vspan(h.versions), 18) + dspan(h.firstDate, h.lastDate));
    }
  }
  L.push('');
  L.push(`LIKELY REGRESSIONS (same component+cause fixed again within ${REGRESSION_WINDOW} releases, or explicit regressionOf)`);
  if (!rep.regressions.length) L.push('  none');
  else {
    for (const g of rep.regressions.slice(0, top)) {
      const what = g.fixCommit ? short(g.fixCommit) : g.fp;
      const was = g.earlierCommit ? short(g.earlierCommit) : g.earlierFp;
      L.push(`  ${pad(what, 12)} ${pad(g.fixedIn || 'unreleased', 11)} re-fixes ${pad(was, 12)} ${pad(g.earlierFixedIn || '-', 9)} ${g.component || ''} [${g.cause || ''}]${g.explicit ? ' (explicit)' : ''}`);
    }
    if (rep.regressions.length > top) L.push(`  ... ${rep.regressions.length - top} more (--top N / --json)`);
  }
  L.push('');
  L.push('BY COMPONENT');
  L.push('  ' + pad('COUNT', 6) + pad('COMPONENT', 38) + pad('TOP CAUSE', 24) + pad('VERSIONS', 18) + 'DATES');
  for (const c of rep.byComponent.slice(0, top)) {
    const tc = Object.entries(c.causes).sort((a, b) => b[1] - a[1])[0];
    L.push('  ' + pad(c.count, 6) + pad(c.component, 38) + pad(tc ? `${tc[0]} (${tc[1]})` : '-', 24) + pad(vspan(c.versions), 18) + dspan(c.firstDate, c.lastDate));
  }
  L.push('');
  L.push('BY CAUSE');
  L.push('  ' + pad('COUNT', 6) + pad('CAUSE', 24) + pad('COMPONENTS', 12) + pad('VERSIONS', 18) + 'DATES');
  for (const c of rep.byCause) {
    L.push('  ' + pad(c.count, 6) + pad(c.cause, 24) + pad(c.components, 12) + pad(vspan(c.versions), 18) + dspan(c.firstDate, c.lastDate));
  }
  return L.join('\n') + '\n';
}

function formatSimilar(list) {
  if (!list.length) return 'no similar past fixes found\n';
  const L = ['  ' + pad('SCORE', 6) + pad('COMMIT', 9) + pad('VERSION', 11) + pad('COMPONENT', 34) + pad('CAUSE', 23) + 'SUMMARY'];
  for (const r of list) {
    const sum = String(r.subject || '').replace(/\s+/g, ' ').slice(0, 100);
    L.push('  ' + pad(r.score, 6) + pad(r.fixCommit ? short(r.fixCommit) : r.fp, 9) + pad(r.fixedIn || (r.source === 'backfill' ? 'unreleased' : r.status), 11)
      + pad(r.component || '-', 34) + pad(r.cause || '-', 23) + sum);
  }
  return L.join('\n') + '\n';
}

module.exports = {
  CAUSE_ENUM, CAUSE_RULES, classifyCause, normalizeComponent, isSourceFile, dominantComponent,
  historyDir, collectFixCommits, testedModule, fixedInFor, releaseMap, parseChangelog, linkChangelog, tokens,
  backfill, loadAllRecords, normalizeRecord, recurring, similar, formatRecurring, formatSimilar,
  HOTSPOT_COMPONENT_MIN, HOTSPOT_PAIR_MIN, REGRESSION_WINDOW,
};
