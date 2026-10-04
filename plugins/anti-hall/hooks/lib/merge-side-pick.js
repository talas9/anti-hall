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

// Blank '...' and "..." spans (same length) so a quoted commit message or echo
// argument cannot be mistaken for a command. Unclosed quotes mask nothing.
function maskShellQuotes(cmd) {
  return String(cmd || '')
    .replace(/'[^'\n]*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length));
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

function stateDir(home) { return path.join(home, '.anti-hall'); }
function stateFile(home, sid) {
  const safe = String(sid || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return safe ? path.join(stateDir(home), PREFIX + '-' + safe + '.json') : '';
}

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object') return { seq: s.seq | 0, pickSeq: s.pickSeq | 0, testSeq: s.testSeq | 0, cmd: String(s.cmd || '') };
  } catch (_) { /* absent or corrupt -> fresh */ }
  return { seq: 0, pickSeq: 0, testSeq: 0, cmd: '' };
}

// record(home, sid, cmd) -> true when state changed. Writes only when something matched.
function record(home, sid, cmd) {
  try {
    const file = stateFile(home, sid);
    if (!file) return false;
    const segs = segments(cmd);
    if (!segs.some((s) => segPick(s) || segTest(s))) return false;
    const st = load(file);
    for (const s of segs) {
      if (segPick(s)) {
        st.seq += 1; st.pickSeq = st.seq;
        st.cmd = s.replace(/\s+/g, ' ').slice(0, 120);
      } else if (segTest(s)) {
        st.seq += 1; st.testSeq = st.seq;
      }
    }
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st), 'utf8');
    try {
      require('./state-prune.js').pruneStale({ stateDir: stateDir(home), prefix: PREFIX, keepFile: file });
    } catch (_) { /* prune is best-effort */ }
    return true;
  } catch (_) { return false; }
}

// pending(home, sid) -> the recorded side-pick command when no test run followed it, else ''.
function pending(home, sid) {
  try {
    const file = stateFile(home, sid);
    if (!file) return '';
    const st = load(file);
    return st.pickSeq > 0 && st.pickSeq > st.testSeq ? (st.cmd || 'a side-pick') : '';
  } catch (_) { return ''; }
}

// pushCheck(home, sid, cmd) -> the side-pick command to warn about when `cmd` pushes
// with an untested side-pick (recorded earlier OR earlier in this same command), else ''.
function pushCheck(home, sid, cmd) {
  try {
    let pend = pending(home, sid);
    for (const s of segments(cmd)) {
      if (segPick(s)) pend = s.replace(/\s+/g, ' ').slice(0, 120);
      else if (segTest(s)) pend = '';
      else if (PUSH_RE.test(s) && !/\s(?:--dry-run|-n)\b/.test(s) && pend) return pend;
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
