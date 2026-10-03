'use strict';
// anti-hall :: gitignore-hint — is the project's `.anti-hall/` (progress,
// history, handovers, reports) git-ignored in the USER's repo? Shared by
// doctor (WARN), doctor --repair (append to the repo-local, untracked
// `<git-dir>/info/exclude` ONLY) and the SessionStart reminder in
// progress-prune.js. Never edits a tracked file (.gitignore), never deletes.
// Every function is fail-open: any error / missing git / non-repo => 'skip'.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DIR = '.anti-hall';
const EXCLUDE_LINE = '.anti-hall/';
const REMINDER_LINE = 'anti-hall: .anti-hall/ is not git-ignored in this repo — add `.anti-hall/` to .gitignore ' +
  '(or run /anti-hall:doctor --repair) so session notes are never committed.';
const REMINDER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

function gitEnv() {
  const env = Object.assign({}, process.env);
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}

function git(root, args, timeoutMs) {
  try {
    const r = cp.spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', env: gitEnv(), timeout: timeoutMs || 2000 });
    return r && !r.error ? r : null;
  } catch (_) { return null; }
}

// projectRoot(cwd) -> the git toplevel of cwd via the canonical resolver
// (companion/lib/identity.js), or null when cwd is not inside a git work tree.
function projectRoot(cwd) {
  try {
    if (typeof cwd !== 'string' || !cwd) return null;
    const ctx = require('../../companion/lib/identity.js').resolveContext(cwd, { memo: false });
    return (ctx && ctx.toplevel) || null;
  } catch (_) { return null; }
}

// status(cwd, {timeoutMs}) -> { status: 'skip'|'ignored'|'not-ignored', root }
//   skip = not a repo, no .anti-hall/ dir, git missing/errored/timed out.
function status(cwd, opts) {
  const root = projectRoot(cwd);
  if (!root) return { status: 'skip', root: null };
  try { if (!fs.statSync(path.join(root, DIR)).isDirectory()) return { status: 'skip', root }; } catch (_) { return { status: 'skip', root }; }
  const r = git(root, ['check-ignore', '-q', DIR + '/probe'], (opts && opts.timeoutMs) || 2000);
  if (!r) return { status: 'skip', root };
  if (r.status === 0) return { status: 'ignored', root };
  if (r.status === 1) return { status: 'not-ignored', root };
  return { status: 'skip', root };
}

// excludePath(root) -> absolute <git-dir>/info/exclude (worktree/submodule
// aware via `git rev-parse --git-path`), or null.
function excludePath(root) {
  const r = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!r || r.status !== 0) return null;
  const p = String(r.stdout || '').trim();
  return p ? path.resolve(root, p) : null;
}

// repairExclude(cwd, {dryRun}) -> { status: 'fixed'|'skipped'|'failed', msg }
// Appends `.anti-hall/` to info/exclude when the dir exists and is not ignored.
// Idempotent (a second run sees it ignored). Creates info/ if missing.
function repairExclude(cwd, opts) {
  try {
    const s = status(cwd);
    if (s.status === 'skip') return { status: 'skipped', msg: 'no .anti-hall/ in a git work tree here (nothing to ignore)' };
    if (s.status === 'ignored') return { status: 'skipped', msg: '.anti-hall/ is already git-ignored' };
    const file = excludePath(s.root);
    if (!file) return { status: 'failed', msg: 'could not resolve <git-dir>/info/exclude' };
    if (opts && opts.dryRun) return { status: 'skipped', msg: '[dry-run] would append `' + EXCLUDE_LINE + '` to ' + file };
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch (_) { cur = ''; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + EXCLUDE_LINE + '\n', 'utf8');
    return { status: 'fixed', msg: 'appended `' + EXCLUDE_LINE + '` to ' + file + ' (repo-local, untracked; .gitignore not touched)' };
  } catch (e) {
    return { status: 'failed', msg: 'append to info/exclude raised: ' + (e && e.message) };
  }
}

module.exports = { DIR, EXCLUDE_LINE, REMINDER_LINE, REMINDER_EVERY_MS, projectRoot, status, excludePath, repairExclude };
