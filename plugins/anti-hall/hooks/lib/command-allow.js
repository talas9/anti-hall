'use strict';
// Per-project command allowlist helpers, shared by command-guard.js (the
// enforcement point), doctor.js (the report) and scripts/settings.js
// (`trust-command-allow`). One validator and one trust check so the three can
// never disagree about which patterns count.
//
// TRUST: `<repo>/.anti-hall/command-allow.json` lives in the working tree, so
// a cloned or otherwise untrusted repo could ship one and authorize itself.
// It applies only when the user has trusted that EXACT file content: a
// per-user record OUTSIDE every repo, ~/.anti-hall/trusted-command-allow.json
// = { "<realpath of repo toplevel>": "<sha256 hex of the file bytes>" }.
// Any edit to the file changes the hash -> untrusted until re-trusted. The
// file is opened with O_NOFOLLOW after an lstat of its directory: a symlinked
// `.anti-hall` dir or allowlist file is refused outright.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOW_REL = path.join('.anti-hall', 'command-allow.json');
const TRUST_FILE = 'trusted-command-allow.json';

// validatePattern(p) -> { ok: true } | { ok: false, reason }.
//
// A pattern must:
//   - be a string that starts with `^` and ends with an unescaped `$`;
//   - continue after `^` with a LITERAL command word (letters, digits,
//     `_`, `/`, `-`, or an escaped `\.`) followed by a literal space or the
//     closing `$` — so the allowed program is fixed text, never a regex;
//   - contain no unbounded wildcard: `.` quantified by `*`, `+` or `{n,}`
//     (`.*`, `.+`, `(.*)`, `.*?`), nor a negated / whitespace-spanning
//     character class quantified the same way (`[^x]*`, `[\s\S]+`);
//   - contain no top-level alternation (`^a$|^.*$` escapes the anchors);
//   - compile as a JavaScript RegExp.
function validatePattern(p) {
  if (typeof p !== 'string') return { ok: false, reason: 'not a string' };
  if (!p.startsWith('^')) return { ok: false, reason: 'must start with ^' };
  if (!p.endsWith('$') || p.endsWith('\\$')) return { ok: false, reason: 'must end with $' };
  if (!/^\^(?:[A-Za-z0-9_\/-]|\\\.)+(?: |\$$)/.test(p)) {
    return { ok: false, reason: 'must begin with a literal command word after ^' };
  }
  const scan = scanPattern(p);
  if (scan.topLevelAlternation) return { ok: false, reason: 'top-level | alternation' };
  if (scan.unboundedWildcard) return { ok: false, reason: 'unbounded wildcard (' + scan.unboundedWildcard + ')' };
  try { new RegExp(p); } catch (_) { return { ok: false, reason: 'invalid regex' }; }
  return { ok: true };
}

// scanPattern(src) -> { topLevelAlternation, unboundedWildcard } — a small
// structural walk (escape / class / group depth) over a regex source.
function scanPattern(src) {
  let depth = 0;
  let topLevelAlternation = false;
  let unboundedWildcard = null;
  const groupStarts = [];
  const isUnboundedQuant = (i) => {
    const q = src[i];
    if (q === '*' || q === '+') return true;
    if (q === '{') return /^\{\d*,\}/.test(src.slice(i));
    return false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
      const body = src.slice(i + 1, j);
      const spansSpace = body.startsWith('^') || /\\s|\\S|\\W|\\D| /.test(body);
      if (spansSpace && isUnboundedQuant(j + 1) && !unboundedWildcard) {
        unboundedWildcard = src.slice(i, j + 2);
      }
      i = j;
      continue;
    }
    if (c === '(') { depth++; groupStarts.push(i); continue; }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      const start = groupStarts.length ? groupStarts.pop() : 0;
      // A quantified group is as wide as its widest member: `(.|x)*`,
      // `(?:\S|\s)+`, `( [^ ]*)*` all span arbitrary text.
      const body = src.slice(start + 1, i);
      if (isUnboundedQuant(i + 1) && /(^|[^\\])\.|\\[sWD]|\[\^| /.test(body) && !unboundedWildcard) {
        unboundedWildcard = src.slice(start, i + 2);
      }
      continue;
    }
    if (c === '|' && depth === 0) topLevelAlternation = true;
    if (c === '.' && isUnboundedQuant(i + 1) && !unboundedWildcard) unboundedWildcard = src.slice(i, i + 2);
  }
  return { topLevelAlternation, unboundedWildcard };
}

// repoToplevel(cwd) -> the repo toplevel for cwd, or null.
function repoToplevel(cwd) {
  try {
    return require('../../companion/lib/identity.js')
      .resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel || null;
  } catch (_) {
    return null;
  }
}

function repoKey(top) {
  try { return fs.realpathSync(top); } catch (_) { return path.resolve(top); }
}

// readAllowFile(top) -> { cfgPath, state, bytes?, hash?, patterns?, error? }.
// state: 'missing' | 'symlink' | 'unreadable' | 'invalid-json' | 'ok'.
function readAllowFile(top) {
  const cfgPath = path.join(top, ALLOW_REL);
  const dir = path.dirname(cfgPath);
  let dst;
  try { dst = fs.lstatSync(dir); } catch (_) { return { cfgPath, state: 'missing' }; }
  if (dst.isSymbolicLink()) return { cfgPath, state: 'symlink' };
  let fst;
  try { fst = fs.lstatSync(cfgPath); } catch (_) { return { cfgPath, state: 'missing' }; }
  if (fst.isSymbolicLink()) return { cfgPath, state: 'symlink' };
  if (!fst.isFile()) return { cfgPath, state: 'unreadable' };
  let bytes;
  let fd = null;
  try {
    const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(cfgPath, fs.constants.O_RDONLY | NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return { cfgPath, state: 'unreadable' };
    bytes = fs.readFileSync(fd);
  } catch (e) {
    return { cfgPath, state: e && e.code === 'ELOOP' ? 'symlink' : 'unreadable' };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) {
    return { cfgPath, state: 'invalid-json', bytes, hash };
  }
  const patterns = parsed && Array.isArray(parsed.patterns) ? parsed.patterns : [];
  return { cfgPath, state: 'ok', bytes, hash, patterns };
}

function trustFilePath(home) {
  return path.join(home, '.anti-hall', TRUST_FILE);
}

function readTrustRecords(home) {
  try {
    const obj = JSON.parse(fs.readFileSync(trustFilePath(home), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

// trustState(home, top, hash) -> 'trusted' | 'untrusted' | 'mismatch'.
function trustState(home, top, hash) {
  const rec = readTrustRecords(home)[repoKey(top)];
  if (typeof rec !== 'string' || !rec) return 'untrusted';
  return rec === hash ? 'trusted' : 'mismatch';
}

// loadTrustedPatterns(cwd, home) -> valid patterns of a TRUSTED allowlist, or
// []. Fails closed: missing/symlinked/unreadable/invalid/untrusted -> [].
function loadTrustedPatterns(cwd, home) {
  const top = repoToplevel(cwd);
  if (!top || !home) return [];
  const f = readAllowFile(top);
  if (f.state !== 'ok') return [];
  if (trustState(home, top, f.hash) !== 'trusted') return [];
  return f.patterns.filter((p) => validatePattern(p).ok);
}

// recordTrust(home, top, hash) -> writes the trust record (atomic rename,
// mode 600). Throws on failure — the CLI reports it.
function recordTrust(home, top, hash) {
  const p = trustFilePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const records = readTrustRecords(home);
  records[repoKey(top)] = hash;
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

module.exports = {
  validatePattern,
  repoToplevel,
  repoKey,
  readAllowFile,
  trustFilePath,
  trustState,
  loadTrustedPatterns,
  recordTrust,
};
