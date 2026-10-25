'use strict';
// merge-side-pick.js — pure detection + per-session state for the merge-side-pick
// ADVISORY (never blocks). Setting: guards.mergeSidePickAdvisory (default on).
//
// Failure mode: a merge/rebase conflict is "resolved" by taking one side wholesale
// (`git checkout --ours|--theirs`, `git merge -X ours|theirs`, `-s ours`), which
// silently discards the other side's changes, and the result is pushed without
// the tests having run since. PostToolUse records the side-pick; PreToolUse on
// `git push` advises when a side-pick has no test run after it in this session.
//
// State: ~/.anti-hall/merge-side-pick-<session>.json = { seq, pickSeq, testSeq, cmd }.
// A monotonic seq (not timestamps) orders events that land in the same millisecond;
// segments of one command are applied left to right. Pruned with state-prune.js
// (7 days). Every export is fail-open.
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'merge-side-pick';

// Blank heredoc bodies (`<<TAG` ... `TAG`) and quoted spans (same length) so text a command only carries (a commit message, a
// heredoc note, an echo argument) cannot be mistaken for a command. A body is text however many lines it spans, so newlines
// inside it stay but its characters go. Unclosed quotes mask nothing; an unterminated heredoc runs to the end, as the shell reads it.
const HEREDOC_OPEN = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
function maskHeredocs(cmd) {
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  let s = cmd, from = 0;
  for (;;) {
    HEREDOC_OPEN.lastIndex = from;
    const m = HEREDOC_OPEN.exec(s);
    if (!m) return s;
    if (m.index > 0 && s[m.index - 1] === '<') { from = HEREDOC_OPEN.lastIndex; continue; }
    const nl = s.indexOf('\n', HEREDOC_OPEN.lastIndex);
    if (nl < 0) return s;
    const end = new RegExp('\\n[ \\t]*' + m[2] + '[ \\t]*(?=\\n|$)').exec(s.slice(nl));
    const stop = end ? nl + end.index : s.length;
    s = s.slice(0, nl + 1) + blank(s.slice(nl + 1, stop)) + s.slice(stop);
    from = stop;
  }
}
function maskShellQuotes(cmd) {
  return maskHeredocs(String(cmd || '')).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/[^\n]/g, ' '));
}

// Command segments split on ; & | and newlines (quotes already masked).
function segments(cmd) {
  return maskShellQuotes(cmd).split(/[;&|\n]+/).map((s) => s.trim()).filter(Boolean);
}

const GIT = String.raw`(?:^|\s)git(?:\s+-C\s+\S+|\s+-c\s+\S+|\s+--no-pager)*\s+`;
const SIDE = String.raw`(?:ours|theirs)`;
const PICK_RES = [
  new RegExp(GIT + String.raw`(?:checkout|restore)\b[^\n]*?\s--` + SIDE + String.raw`\b`),
  // -X ours | -Xtheirs | --strategy-option=theirs | --strategy-option theirs
  new RegExp(GIT + String.raw`(?:merge|pull|rebase|cherry-pick|revert)\b[^\n]*?\s(?:-X\s*|--strategy-option[= ])` + SIDE + String.raw`\b`),
  // -s ours | --strategy=ours (merge/pull only: the whole other branch is dropped)
  new RegExp(GIT + String.raw`(?:merge|pull)\b[^\n]*?\s(?:-s\s*|--strategy[= ])ours\b`),
];
const PUSH_RE = new RegExp(GIT + String.raw`push\b`);

const TEST_RES = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b/,
  /(?:^|\s)(?:npx|bunx|pnpm\s+exec)\s+(?:jest|vitest|mocha|ava)\b/,
  /(?:^|\s)(?:jest|vitest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|ctest)\b/,
  /(?:^|\s)node\s+(?:\S+\s+)*--test\b/,
  /(?:^|\s)python3?\s+-m\s+(?:pytest|unittest)\b/,
  /(?:^|\s)(?:go|cargo|flutter|dart|deno)\s+test\b/,
  /(?:^|\s)cargo\s+nextest\b/,
  /(?:^|\s)(?:\.\/)?(?:mvn|mvnw|gradle|gradlew)\s+(?:\S+\s+)*(?:test|verify|check)\b/,
  /(?:^|\s)(?:make|just)\s+(?:test|tests|check)\b/,
  /(?:^|\s)(?:bundle\s+exec\s+)?rake\s+test\b/,
  /(?:^|\s)dotnet\s+test\b/,
];

const segPick = (s) => PICK_RES.some((re) => re.test(s));
const segTest = (s) => TEST_RES.some((re) => re.test(s));

function isSidePick(cmd) { return segments(cmd).some(segPick); }
function isTestRun(cmd) { return segments(cmd).some(segTest); }
function isPush(cmd) {
  return segments(cmd).some((s) => PUSH_RE.test(s) && !/\s(?:--dry-run|-n)\b/.test(s));
}


// ---- which branch a side-pick belongs to (mirrors engine merge_side_pick.*) ------------------------------------------------------
// A pick is recorded with the git directory and branch it happened on; a push draws the advisory only when it may push that branch.
// Anything this cannot tell (a quoted push, a cd, GIT_DIR, a detached HEAD, --all) keeps the advisory, as before.
const SCOPE_UNKNOWN_RE = /(?:^|\s)(?:cd|pushd|GIT_DIR=|GIT_WORK_TREE=|--git-dir|--work-tree)(?:\s|=|$)/;
const PUSH_UNSCOPED_OPTS_RE = /^(?:--(?:all|mirror|tags|follow-tags|prune|branches|push-option|repo|receive-pack|exec)|-o)$/;
const PLAIN_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;
const GIT_FILE_MAX = 4096;

const quoted = (cmd) => maskShellQuotes(cmd) !== String(cmd || '');
const words = (s) => s.split(/\s+/).filter(Boolean);
const cdLike = (s) => SCOPE_UNKNOWN_RE.test(s);

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(GIT_FILE_MAX); const n = fs.readSync(fd, b, 0, GIT_FILE_MAX, 0); return b.slice(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// The directory a git segment runs in: the payload cwd, moved by one plain `-C <dir>`; '' when that cannot be told.
function segDir(s, cwd, cmdQuoted) {
  const w = words(s);
  const at = w.indexOf('-C');
  if (at < 0) return cwd;
  if (w.indexOf('-C', at + 1) >= 0 || cmdQuoted || at + 1 >= w.length) return '';
  const d = w[at + 1];
  return path.isAbsolute(d) ? d : (cwd === '' ? '' : path.join(cwd, d));
}

// { gitdir, branch } of the checkout around `dir` ('' for each when unknown).
function scopeOf(dir) {
  const none = { gitdir: '', branch: '' };
  if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) return none;
  const gitdir = require('../../companion/lib/identity.js').checkoutGitdir(dir) || '';
  if (gitdir === '') return none;
  const head = readHead(path.join(gitdir, 'HEAD'));
  const r = head === null ? null : /^ref:\s*refs\/heads\/[^\s]+/.exec(head);
  return { gitdir, branch: r ? r[0].replace(/^ref:\s*refs\/heads\//, '') : '' };
}

// The local branches a push segment may push, or null when that cannot be told (the advisory then stays).
function pushedBranches(s, current) {
  const w = words(s);
  const rest = w.slice(w.indexOf('push') + 1), args = [];
  for (const a of rest) {
    if (PUSH_UNSCOPED_OPTS_RE.test(a)) return null;
    if (a.charAt(0) === '-') continue;
    args.push(a);
  }
  if (args.length <= 1) return [current];
  const out = [];
  for (const a of args.slice(1)) {
    let src = a.replace(/^\+/, '').split(':')[0];
    if (src === 'HEAD') src = current;
    else if (src.indexOf('refs/heads/') === 0) src = src.slice('refs/heads/'.length);
    if (src === '') continue;
    if (!PLAIN_BRANCH_RE.test(src)) return null;
    out.push(src);
  }
  return out.length === 0 ? [current] : out;
}

// True when a push segment is, for sure, not a push of `pick`'s branch: another checkout, or other branches than the picked one.
function pushLeavesPick(pick, segsBefore, s, cwd, cmdQuoted) {
  if (pick.gitdir === '' || pick.branch === '' || cwd === '' || cmdQuoted) return false;
  if (segsBefore.some(cdLike) || cdLike(s)) return false;
  const dir = segDir(s, cwd, cmdQuoted);
  if (dir === '') return false;
  const here = scopeOf(dir);
  if (here.gitdir === '') return false;
  if (here.gitdir !== pick.gitdir) return true;
  if (here.branch === '') return false;
  const pushed = pushedBranches(s, here.branch);
  return pushed !== null && !pushed.includes(pick.branch);
}

function stateDir(home) { return path.join(home, '.anti-hall'); }
function stateFile(home, sid) {
  const safe = String(sid || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return safe ? path.join(stateDir(home), PREFIX + '-' + safe + '.json') : '';
}

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object') return { seq: s.seq | 0, pickSeq: s.pickSeq | 0, testSeq: s.testSeq | 0, cmd: String(s.cmd || ''), gitdir: String(s.gitdir || ''), branch: String(s.branch || '') };
  } catch (_) { /* absent or corrupt -> fresh */ }
  return { seq: 0, pickSeq: 0, testSeq: 0, cmd: '', gitdir: '', branch: '' };
}

// record(home, sid, cmd) -> true when state changed. Writes only when something matched.
function record(home, sid, cmd, cwd) {
  try {
    const file = stateFile(home, sid);
    if (!file) return false;
    const segs = segments(cmd);
    if (!segs.some((s) => segPick(s) || segTest(s))) return false;
    const st = load(file), cq = quoted(cmd), dir0 = typeof cwd === 'string' ? cwd : '';
    let moved = false;
    for (const s of segs) {
      if (segPick(s)) {
        st.seq += 1; st.pickSeq = st.seq;
        st.cmd = s.replace(/\s+/g, ' ').slice(0, 120);
        const at = moved || cdLike(s) ? { gitdir: '', branch: '' } : scopeOf(segDir(s, dir0, cq));
        st.gitdir = at.gitdir; st.branch = at.branch;
      } else if (segTest(s)) {
        st.seq += 1; st.testSeq = st.seq;
      }
      if (cdLike(s)) moved = true;
    }
    const o = { seq: st.seq, pickSeq: st.pickSeq, testSeq: st.testSeq, cmd: st.cmd };
    if (st.gitdir !== '' && st.branch !== '') { o.gitdir = st.gitdir; o.branch = st.branch; }
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(o), 'utf8');
    try {
      require('./state-prune.js').pruneStale({ stateDir: stateDir(home), prefix: PREFIX, keepFile: file });
    } catch (_) { /* prune is best-effort */ }
    return true;
  } catch (_) { return false; }
}

// pending(home, sid) -> { cmd, gitdir, branch } of the recorded side-pick when no test run followed it, else null.
function pendingPick(home, sid) {
  try {
    const file = stateFile(home, sid);
    if (!file) return null;
    const st = load(file);
    return st.pickSeq > 0 && st.pickSeq > st.testSeq ? { cmd: st.cmd || 'a side-pick', gitdir: st.gitdir, branch: st.branch } : null;
  } catch (_) { return null; }
}
function pending(home, sid) { const p = pendingPick(home, sid); return p ? p.cmd : ''; }

// pushCheck(home, sid, cmd, cwd) -> the side-pick command to warn about when `cmd` pushes with an untested side-pick
// (recorded earlier OR earlier in this same command) that the push may carry, else ''.
function pushCheck(home, sid, cmd, cwd) {
  try {
    let pend = pendingPick(home, sid);
    const segs = segments(cmd), cq = quoted(cmd), dir0 = typeof cwd === 'string' ? cwd : '';
    let moved = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (segPick(s)) {
        const at = moved || cdLike(s) ? { gitdir: '', branch: '' } : scopeOf(segDir(s, dir0, cq));
        pend = { cmd: s.replace(/\s+/g, ' ').slice(0, 120), gitdir: at.gitdir, branch: at.branch };
      } else if (segTest(s)) pend = null;
      else if (PUSH_RE.test(s) && !/\s(?:--dry-run|-n)\b/.test(s) && pend && !pushLeavesPick(pend, segs.slice(0, i), s, dir0, cq)) return pend.cmd;
      if (cdLike(s)) moved = true;
    }
  } catch (_) { /* fail open */ }
  return '';
}

function advisory(pickCmd) {
  return require('./block-message.js').message({
    kind: 'warn',
    guard: 'merge-side-pick',
    what: 'pushing after a conflict was resolved by taking one side wholesale (' + pickCmd + ') with no test run since',
    why: "taking --ours/--theirs (or -X ours/theirs) silently drops the other side's changes, and nothing has verified the result.",
    instead: 'run the tests first, review the discarded side in `git diff`, then push.',
  });
}

module.exports = { isSidePick, isTestRun, isPush, record, pending, pushCheck, advisory, stateFile };
