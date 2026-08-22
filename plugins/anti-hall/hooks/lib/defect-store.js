'use strict';
// anti-hall :: defect-store — durable, file-based, two-way defect channel
// between agents running anti-hall in ANY repo and the anti-hall maintainer.
//
// WHY FILE-BASED (not the DevSwarm mesh/messaging layer): bug reports about
// anti-hall's OWN messaging layer must not travel through that layer. Real
// defects found in this codebase's own history: a meshId partitioned across
// two registry rows so a drain read "0 unread" from the wrong row while 4
// messages sat stranded; `diagnose`'s splits array empty while that partition
// was live; `inbox count` returning `unread:400` beside `storeUnread:0`; an
// ack returning `ok:true` while changing nothing. A defect channel built on
// top of the thing it reports bugs about inherits every one of those bugs.
// This channel is plain NDJSON files under ~/.anti-hall/defects/ — no store,
// no cursor, no registry-of-registries, nothing that can itself desync.
//
// LOCATION: ~/.anti-hall/defects/ — home-scoped (any repo reaches it), never
// inside a git worktree (so it can never accidentally ship). NOT `reports/`
// — that name is already used in-repo (plugins/anti-hall/... reports dirs).
//
// ONE FILE PER DEFECT, APPEND-ONLY: ~/.anti-hall/defects/<fp>.jsonl where
// <fp> is a 12-hex-char fingerprint (see fingerprint() below). Archived
// (ruled + stale) defects move (never copy+delete, never rewrite) to
// ~/.anti-hall/defects/archive/<YYYY-MM>/<fp>.jsonl.
//
// NO INDEX FILE. An index is a second source of truth about the SAME data —
// exactly the shape of bug that produced `unread:400` beside `storeUnread:0`
// in the DevSwarm inbox. Every reader (list/show/nudge) derives state by
// reading the .jsonl file(s) directly, every time. Derived state is the ONLY
// state: `status` = the last ruling line's status, else 'open'; `occurrences`
// = count of report lines; `firstSeen`/`lastSeen` = first/last line's `at`.
// No counts or flags are ever STORED — two fields stored separately can
// disagree (see unread:400/storeUnread:0 above); a single derivation cannot.
//
// WRITE DISCIPLINE: create with fs.openSync(file, 'wx') (O_EXCL — refuses to
// clobber); on EEXIST, fall through to append. Append with exactly ONE
// fs.appendFileSync(file, line + "\n") call. Every line is hard-capped at
// MAX_LINE_BYTES (4096) — small enough that concurrent O_APPEND writes from
// separate processes/repos do not interleave in practice (each write() is a
// single syscall for a buffer well under the typical atomic-append size). A
// torn/corrupt line (JSON.parse throws) is SKIPPED on read, never rewritten
// or repaired in place — nothing here ever rewrites a line's body. Rulings
// append too. Only whole-file archival uses rename(2); nothing is ever
// deleted.
//
// NO SILENT SUCCESS: every write returns a closed-vocabulary outcome. After
// every append, the file's tail is re-read and byte-compared against the
// line just written — if it doesn't match, the outcome is 'write-unverified'
// (never 'recorded'/'occurrence-appended'/'ruled'). This is precisely the
// check `read-primary --ack-as-owner` lacked when it returned `ok:true`
// while changing nothing.
//
// `home` threading: every function that touches disk accepts an optional
// `home` (matches the doctor-repair.js / devswarm-inbox-paths.js convention
// of `opts.home || os.homedir()`) so tests can point at an isolated tmp HOME
// without any module-reload or env-var hackery.
//
// Pure Node built-ins only. Cross-platform.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseSemver } = require('./drift-baseline.js');

function resolveHome(home) {
  return home || os.homedir();
}
function defectsDir(home) {
  return path.join(resolveHome(home), '.anti-hall', 'defects');
}
function archiveDir(home) {
  return path.join(defectsDir(home), 'archive');
}
function nudgeStampFile(home) {
  return path.join(resolveHome(home), '.anti-hall', '.defects-nudge-stamp.json');
}

const CLASS_ENUM = [
  'guard-false-positive', 'guard-miss', 'hook-crash', 'state-leak',
  'messaging', 'doc', 'install', 'other',
];
const SEVERITY_ENUM = ['p0', 'p1', 'p2'];
const RULING_STATUS_ENUM = ['ack', 'fixed', 'wontfix', 'notabug', 'dup'];

// Bounds (concrete, precedent: hooks/lib/state-prune.js's bounded-sweep shape
// for the 47,084-file leak). At any cap the write is REFUSED with a distinct
// outcome — never silently dropped.
const MAX_OPEN_FILES = 200;      // open dir (defectsDir, top level .jsonl files)
const MAX_FILE_BYTES = 64 * 1024; // per defect file
const MAX_REPORT_LINES = 20;      // per defect file, report lines only
const REGRESSION_EXTRA = 3;       // extra report lines allowed past MAX_REPORT_LINES
                                   // when the defect's derived status is 'fixed' — a
                                   // regression report on a long-lived defect is the
                                   // highest-value report and must not be refused by
                                   // the occurrence cap alone (still bounded by
                                   // MAX_FILE_BYTES).
const MAX_LINE_BYTES = 4096;      // per NDJSON line (any type)
const MAX_ARCHIVE_FILES = 1000;   // archive dir, total across all month buckets
const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days since lastSeen

// Field length caps (chars) from the schema.
const FIELD_CAPS = { sym: 200, repro: 1200, claimed: 300, observed: 300, note: 300 };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// clampField(value, maxLen) -> string, control-char/ANSI-stripped and length
// clamped. Reports are written by OTHER agents in OTHER repos — untrusted
// data. Strips full ANSI escape sequences, then any remaining C0 control
// bytes (including \n/\r/\0 — a raw newline in a field would forge a fake
// NDJSON line boundary, corrupting file structure).
function clampField(value, maxLen) {
  let s = typeof value === 'string' ? value : (value == null ? '' : String(value));
  s = s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // ANSI CSI sequences
  s = s.replace(/[\x00-\x1f\x7f]/g, '');        // remaining control chars
  s = s.trim();
  if (typeof maxLen === 'number' && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// normSym(sym) -> lowercase, collapse whitespace, strip runs of digits/hex
// chars >= 6 long (so a session id or timestamp embedded in the symptom text
// cannot defeat dedup across reports of the same underlying defect).
function normSym(sym) {
  let s = String(sym || '').toLowerCase();
  s = s.replace(/[0-9a-f]{6,}/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// cmpSemver(a, b) -> -1 | 0 | 1 | null. null means either side is unparseable
// (per drift-baseline.parseSemver's [major,minor,patch]-or-null contract) —
// callers MUST treat null as "not comparable", never coerce it to a number
// (fail-closed: an unparseable version is never treated as a regression).
// Deliberately built directly on parseSemver rather than reusing
// classifyVersionDrift(), which collapses patch-only differences
// (advise:false for e.g. 0.79.0 vs 0.79.1) — exactly the case a regression
// check must NOT collapse: a defect fixed in 0.79.0 that reappears in
// 0.79.1 is a real regression, not noise to suppress.
function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// fingerprint(cls, sym) -> 12 hex chars. Deterministic across repos/sessions.
function fingerprint(cls, sym) {
  const h = crypto.createHash('sha256');
  h.update(String(cls) + '\n' + normSym(sym));
  return h.digest('hex').slice(0, 12);
}

function fpFile(fp, home) {
  return path.join(defectsDir(home), fp + '.jsonl');
}

// readRawLines(file) -> array of non-empty raw string lines, or [] if the
// file does not exist. Never throws.
function readRawLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  return raw.split('\n').filter((l) => l.length > 0);
}

// parseLines(rawLines) -> array of parsed objects. A torn/corrupt line
// (JSON.parse throws, or result isn't an object) is SKIPPED, never repaired.
function parseLines(rawLines) {
  const out = [];
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_) {
      // torn/corrupt line -> skip, file untouched
    }
  }
  return out;
}

// deriveState(parsedLines) -> { status, occurrences, firstSeen, lastSeen,
// reportCount, rulingCount, staleBuild }. Derived-state-only: nothing here is
// ever persisted separately from the lines themselves. `status` starts as
// the last ruling line's status in FILE ORDER (append order == chronological
// order for a single append-only file; robust against clock skew between
// writers, unlike sorting by `at`), then a REPORT line can further derive it
// to 'regressed':
//   - a 'ruling' line sets status = line.status, remembers { status, fixedIn }
//     as lastRuling, and resets staleBuild — a new ruling always resets the
//     regression cycle.
//   - a 'report' line, when lastRuling.status === 'fixed' and lastRuling has
//     a fixedIn, compares this report's `v` against fixedIn via cmpSemver:
//       - cmpSemver >= 0 (report's v is at or past the fix)  -> status =
//         'regressed'. Repeatable: a later ruling resets it, a later report
//         re-evaluates it — no counters, no stored regression flag.
//       - cmpSemver < 0 (report's v predates the fix -> a stale build still
//         reporting the old bug) -> status is left UNCHANGED (stays
//         'fixed'), only `staleBuild` is set true.
//       - cmpSemver === null (either version unparseable) -> fail CLOSED:
//         neither branch fires, status and staleBuild are left unchanged.
// `RULING_STATUS_ENUM` is unaffected — 'regressed' is derived-only, never a
// writable ruling status.
function deriveState(parsedLines) {
  let status = 'open';
  let occurrences = 0;
  let firstSeen = null;
  let lastSeen = null;
  let rulingCount = 0;
  let staleBuild = false;
  let lastRuling = null; // { status, fixedIn }
  for (const obj of parsedLines) {
    if (typeof obj.at === 'string' && obj.at) {
      if (firstSeen === null) firstSeen = obj.at;
      lastSeen = obj.at;
    }
    if (obj.t === 'report') {
      occurrences++;
      if (lastRuling && lastRuling.status === 'fixed' && lastRuling.fixedIn) {
        const cmp = cmpSemver(obj.v, lastRuling.fixedIn);
        if (cmp !== null) {
          if (cmp >= 0) {
            status = 'regressed';
          } else {
            staleBuild = true;
          }
        }
      }
    } else if (obj.t === 'ruling') {
      rulingCount++;
      if (typeof obj.status === 'string') {
        status = obj.status;
        lastRuling = { status: obj.status, fixedIn: typeof obj.fixedIn === 'string' ? obj.fixedIn : null };
        staleBuild = false;
      }
    }
  }
  return {
    status, occurrences, firstSeen, lastSeen,
    reportCount: occurrences, rulingCount, staleBuild,
  };
}

// countOpenFiles(home) -> number of *.jsonl files directly under defectsDir
// (the 'archive' subdirectory does not end in .jsonl so it's naturally
// excluded — no special-casing needed).
function countOpenFiles(home) {
  let entries;
  try {
    entries = fs.readdirSync(defectsDir(home));
  } catch (_) {
    return 0;
  }
  return entries.filter((f) => f.endsWith('.jsonl')).length;
}

// countArchiveFiles(home) -> total *.jsonl files under archiveDir,
// recursively (across all YYYY-MM buckets).
function countArchiveFiles(home) {
  let months;
  try {
    months = fs.readdirSync(archiveDir(home));
  } catch (_) {
    return 0;
  }
  let n = 0;
  for (const m of months) {
    try {
      const entries = fs.readdirSync(path.join(archiveDir(home), m));
      n += entries.filter((f) => f.endsWith('.jsonl')).length;
    } catch (_) { /* skip unreadable bucket */ }
  }
  return n;
}

// readLastRawLine(file) -> the last non-empty raw line, or null.
function readLastRawLine(file) {
  const lines = readRawLines(file);
  return lines.length ? lines[lines.length - 1] : null;
}

// lineWasWritten(file, lineStr) -> true iff `lineStr` appears verbatim as
// its own line somewhere in `file`. Deliberately a full-file scan rather
// than a tail-only check: under real concurrent writers (multiple repos'
// agents appending to the same defect file at once), another process can
// append its own line between this write and this read, so "my line is the
// LAST line" is not a safe verification predicate — it produces false
// 'write-unverified' failures for writes that landed correctly. Checking
// "my line is IN the file" preserves the actual guarantee (no silent
// success: the byte-exact write is confirmed to exist on disk) without
// being racy against other legitimate concurrent writers. Files are bounded
// (<=64KiB, <=20 report lines) so a full scan is cheap.
function lineWasWritten(file, lineStr) {
  return readRawLines(file).includes(lineStr);
}

// appendLine(file, lineStr, { create }) -> { outcome } low-level write
// primitive. `create`=true uses O_EXCL (falls through to a normal append on
// EEXIST); `create`=false requires the file to already exist. Always ends
// with a byte-exact verification that the written line exists on disk —
// 'write-unverified' on any mismatch (see lineWasWritten above for why this
// is a full-file check, not a tail-only one). This is the ONLY function
// that ever calls openSync/appendFileSync for defect files.
// Any real filesystem error (EACCES on a read-only dir, ENOSPC, ...) is
// caught here and folded into 'write-unverified' rather than thrown — the
// caller asked for a defect write, and either it verifiably happened or it
// didn't; there is no third "crashed instead" outcome for callers to handle.
function appendLine(file, lineStr, opts) {
  const create = !!(opts && opts.create);
  try {
    if (create) {
      let fd;
      try {
        fd = fs.openSync(file, 'wx');
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          return appendLine(file, lineStr, { create: false });
        }
        return { outcome: 'write-unverified' };
      }
      try {
        fs.writeSync(fd, lineStr + '\n');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      if (!fs.existsSync(file)) return { outcome: 'not-found' };
      fs.appendFileSync(file, lineStr + '\n');
    }
  } catch (_) {
    return { outcome: 'write-unverified' };
  }
  let verified;
  try { verified = lineWasWritten(file, lineStr); } catch (_) { verified = false; }
  if (!verified) return { outcome: 'write-unverified' };
  return { outcome: create ? 'recorded' : 'occurrence-appended' };
}

// report(input) -> { outcome, fp }. outcome is one of: 'recorded',
// 'occurrence-appended', 'invalid-class', 'invalid-severity',
// 'registry-full', 'occurrence-capped', 'defect-full', 'too-large',
// 'write-unverified'. `input.home` optionally overrides os.homedir().
function report(input) {
  const cls = input && input.class;
  if (!CLASS_ENUM.includes(cls)) return { outcome: 'invalid-class' };
  const sev = input && input.sev;
  if (!SEVERITY_ENUM.includes(sev)) return { outcome: 'invalid-severity' };

  const home = input.home;
  ensureDir(defectsDir(home));

  const sym = clampField(input.sym, FIELD_CAPS.sym);
  const fp = fingerprint(cls, sym);
  const lineObj = {
    t: 'report',
    at: (input.at && typeof input.at === 'string') ? input.at : new Date().toISOString(),
    v: clampField(input.v, 40),
    // proj/sid have no schema-mandated cap (only sym/repro/claimed/observed
    // do). The clamp here is deliberately looser than MAX_LINE_BYTES (4096)
    // — it exists only to bound pathological input, not to prevent
    // 'too-large'; the real backstop for an oversize whole line is the
    // MAX_LINE_BYTES check below.
    proj: clampField(input.proj, 5000),
    sid: clampField(input.sid, 5000),
    class: cls,
    sev,
    sym,
    repro: clampField(input.repro, FIELD_CAPS.repro),
    claimed: clampField(input.claimed, FIELD_CAPS.claimed),
    observed: clampField(input.observed, FIELD_CAPS.observed),
  };
  const lineStr = JSON.stringify(lineObj);
  if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) return { outcome: 'too-large', fp };

  const file = fpFile(fp, home);
  const exists = fs.existsSync(file);

  if (!exists) {
    if (countOpenFiles(home) >= MAX_OPEN_FILES) return { outcome: 'registry-full', fp };
    const res = appendLine(file, lineStr, { create: true });
    return Object.assign({ fp }, res);
  }

  const parsed = parseLines(readRawLines(file));
  const reportCount = parsed.filter((p) => p.t === 'report').length;
  // A defect currently derived 'fixed' OR already 'regressed' gets
  // REGRESSION_EXTRA extra report slots past the normal cap — a regression
  // report on a long-lived defect is the highest-value report and must not
  // be refused solely because the defect already accumulated 20 pre-fix
  // occurrence reports. 'regressed' is included (not just 'fixed') because
  // the FIRST regression report itself flips status to 'regressed' — a
  // second confirming report of the same live regression must not be capped
  // again the instant the first one lands.
  const priorState = deriveState(parsed);
  const inExtraWindow = priorState.status === 'fixed' || priorState.status === 'regressed';
  const cap = inExtraWindow ? MAX_REPORT_LINES + REGRESSION_EXTRA : MAX_REPORT_LINES;
  if (reportCount >= cap) return { outcome: 'occurrence-capped', fp };

  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { size = 0; }
  if (size + Buffer.byteLength(lineStr + '\n', 'utf8') > MAX_FILE_BYTES) {
    return { outcome: 'defect-full', fp };
  }

  const res = appendLine(file, lineStr, { create: false });
  return Object.assign({ fp }, res);
}

// rule(fp, input) -> { outcome, fp }. outcome: 'ruled', 'not-found',
// 'invalid-status', 'defect-full', 'too-large', 'write-unverified'.
function rule(fp, input) {
  const home = input && input.home;
  const file = fpFile(fp, home);
  if (!fs.existsSync(file)) return { outcome: 'not-found', fp };
  const status = input && input.status;
  if (!RULING_STATUS_ENUM.includes(status)) return { outcome: 'invalid-status', fp };

  const lineObj = {
    t: 'ruling',
    at: (input.at && typeof input.at === 'string') ? input.at : new Date().toISOString(),
    status,
    note: clampField(input.note || '', FIELD_CAPS.note),
  };
  if (input.fixedIn) lineObj.fixedIn = clampField(input.fixedIn, 40);
  if (input.commit) lineObj.commit = clampField(input.commit, 64);
  if (input.supersededBy) lineObj.supersededBy = clampField(input.supersededBy, 12);

  const lineStr = JSON.stringify(lineObj);
  if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) return { outcome: 'too-large', fp };

  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { size = 0; }
  if (size + Buffer.byteLength(lineStr + '\n', 'utf8') > MAX_FILE_BYTES) {
    return { outcome: 'defect-full', fp };
  }

  const res = appendLine(file, lineStr, { create: false });
  const outcome = res.outcome === 'occurrence-appended' ? 'ruled' : res.outcome;
  return { outcome, fp };
}

function yyyymm(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// archiveSweep(now, home) -> array of { fp, moved, reason?, dest? }.
// Rotation: a file whose derived status is fixed|wontfix|notabug|dup AND
// whose lastSeen is older than ARCHIVE_AGE_MS is rename()d into
// archive/<YYYY-MM>/. A move, never a delete or a copy+delete. An OPEN
// defect never moves regardless of age. Archived-time (now) decides the
// month bucket.
function archiveSweep(now, home) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  ensureDir(defectsDir(home));
  let entries;
  try {
    entries = fs.readdirSync(defectsDir(home)).filter((f) => f.endsWith('.jsonl'));
  } catch (_) {
    return [];
  }
  const results = [];
  for (const name of entries) {
    const fp = name.replace(/\.jsonl$/, '');
    const file = path.join(defectsDir(home), name);
    let parsed;
    try {
      parsed = parseLines(readRawLines(file));
    } catch (_) {
      results.push({ fp, moved: false, reason: 'read-error' });
      continue;
    }
    const state = deriveState(parsed);
    if (state.status === 'open' || state.status === 'regressed') {
      results.push({ fp, moved: false, reason: state.status });
      continue;
    }
    const lastSeenMs = state.lastSeen ? Date.parse(state.lastSeen) : NaN;
    if (!Number.isFinite(lastSeenMs) || (nowMs - lastSeenMs) < ARCHIVE_AGE_MS) {
      results.push({ fp, moved: false, reason: 'too-recent' });
      continue;
    }
    if (countArchiveFiles(home) >= MAX_ARCHIVE_FILES) {
      results.push({ fp, moved: false, reason: 'archive-full' });
      continue;
    }
    const destDir = path.join(archiveDir(home), yyyymm(nowMs));
    ensureDir(destDir);
    const dest = path.join(destDir, name);
    fs.renameSync(file, dest);
    results.push({ fp, moved: true, dest });
  }
  return results;
}

// listDefects(opts) -> array of { fp, proj, class, sev, ...deriveState() }
// for every *.jsonl file directly under opts.dir (default defectsDir(home)
// — open defects only; pass an archive month bucket to inspect archived
// ones).
function listDefects(opts) {
  const o = opts || {};
  const base = o.dir || defectsDir(o.home);
  let entries;
  try {
    entries = fs.readdirSync(base).filter((f) => f.endsWith('.jsonl'));
  } catch (_) {
    return [];
  }
  return entries.map((name) => {
    const fp = name.replace(/\.jsonl$/, '');
    const parsed = parseLines(readRawLines(path.join(base, name)));
    const state = deriveState(parsed);
    const lastReport = [...parsed].reverse().find((p) => p.t === 'report');
    return Object.assign({
      fp,
      proj: lastReport ? lastReport.proj : undefined,
      class: lastReport ? lastReport.class : undefined,
      sev: lastReport ? lastReport.sev : undefined,
    }, state);
  });
}

// showDefect(fp, home) -> { fp, lines, ...deriveState() } or null if not
// found (in either the open dir or any archive bucket).
function showDefect(fp, home) {
  let file = fpFile(fp, home);
  if (!fs.existsSync(file)) {
    let months = [];
    try { months = fs.readdirSync(archiveDir(home)); } catch (_) { months = []; }
    let found = null;
    for (const m of months) {
      const candidate = path.join(archiveDir(home), m, fp + '.jsonl');
      if (fs.existsSync(candidate)) { found = candidate; break; }
    }
    if (!found) return null;
    file = found;
  }
  const parsed = parseLines(readRawLines(file));
  const state = deriveState(parsed);
  return Object.assign({ fp, lines: parsed }, state);
}

module.exports = {
  defectsDir, archiveDir, nudgeStampFile,
  CLASS_ENUM, SEVERITY_ENUM, RULING_STATUS_ENUM,
  MAX_OPEN_FILES, MAX_FILE_BYTES, MAX_REPORT_LINES, REGRESSION_EXTRA, MAX_LINE_BYTES,
  MAX_ARCHIVE_FILES, ARCHIVE_AGE_MS, FIELD_CAPS,
  ensureDir, clampField, normSym, fingerprint, fpFile, cmpSemver,
  readRawLines, parseLines, deriveState,
  countOpenFiles, countArchiveFiles, readLastRawLine,
  appendLine, report, rule, archiveSweep, listDefects, showDefect, yyyymm,
};
