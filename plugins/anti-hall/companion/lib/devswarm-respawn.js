'use strict';
// anti-hall :: devswarm-respawn — the git and text helpers behind the
// Primary-run `devswarm.js respawn <id>` verb (Meeseeks P3). The verb itself
// (refusals, send, spawn, archive, metrics) lives in scripts/devswarm.js
// cmdRespawn; everything here is either read-only or writes ONLY new refs.
//
// NO-LOSS CONTRACT: nothing here stashes, resets, checks out, cleans or
// deletes. parkWip() snapshots the child's worktree (tracked changes AND
// untracked, non-ignored files) through a PRIVATE temporary index, so the
// child's own index, HEAD, branch and files are never touched, commits it on
// top of HEAD, points a NEW local branch park/<branch>-<ts> at it and pushes
// that branch. A failed push leaves the local park branch in place and is
// reported; the caller then aborts the respawn.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 30000;
const PUSH_TIMEOUT_MS = 120000;

function git(cwd, args, opts) {
  const o = opts || {};
  const r = spawnSync('git', ['-C', cwd].concat(args), {
    encoding: 'utf8', timeout: o.timeout || GIT_TIMEOUT_MS,
    env: o.env ? Object.assign({}, process.env, o.env) : process.env,
  });
  return {
    ok: !r.error && !r.signal && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || (r.error && r.error.message) || '').trim(),
  };
}

// worktreeState(wt) -> { branch, head, dirty, unpushed } | { error }.
// unpushed = commits on HEAD that no origin ref contains (null when unknown).
function worktreeState(wt) {
  if (!wt || !fs.existsSync(wt)) return { error: 'worktree not found: ' + wt };
  const head = git(wt, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (!head.ok) return { error: 'cannot read HEAD in ' + wt };
  const br = git(wt, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const st = git(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (!st.ok) return { error: 'git status failed in ' + wt + ': ' + st.err };
  const up = git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  return {
    branch: br.ok && br.out ? br.out : null,
    head: head.out,
    dirty: st.out.length > 0,
    unpushed: up.ok ? Number(up.out) || 0 : null,
  };
}

// needsPark(state) -> true when work would be lost without a park branch.
function needsPark(st) {
  return !!(st && (st.dirty || st.unpushed === null || st.unpushed > 0));
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}
function parkBranchName(branch, now) { return 'park/' + branch + '-' + stamp(now); }

// nextBranch(branch, exists) -> '<base>-r<N>': feat-x -> feat-x-r2, feat-x-r2 ->
// feat-x-r3; skips any name `exists(name)` reports taken.
function nextBranch(branch, exists) {
  const m = /^(.*)-r(\d+)$/.exec(branch);
  const base = m ? m[1] : branch;
  let n = m ? Number(m[2]) + 1 : 2;
  while (exists && exists(base + '-r' + n) && n < 1000) n++;
  return { branch: base + '-r' + n, n };
}
function localBranchExists(cwd, name) {
  return git(cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/' + name]).ok;
}

// parkWip(wt, { branch, parkBranch, id, dirty }) -> { ok, parkBranch, commit,
// pushed } | { ok:false, stage, error, parkBranch?, commit? }.
function parkWip(wt, o) {
  let commit = null;
  if (o.dirty) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-park-'));
    const idx = path.join(tmpDir, 'index');
    const env = { GIT_INDEX_FILE: idx };
    try {
      const rt = git(wt, ['read-tree', 'HEAD'], { env });
      if (!rt.ok) return { ok: false, stage: 'snapshot', error: 'read-tree failed: ' + rt.err };
      const add = git(wt, ['add', '-A'], { env });
      if (!add.ok) return { ok: false, stage: 'snapshot', error: 'add failed: ' + add.err };
      const tree = git(wt, ['write-tree'], { env });
      if (!tree.ok) return { ok: false, stage: 'snapshot', error: 'write-tree failed: ' + tree.err };
      const who = git(wt, ['config', 'user.email']).ok ? [] : ['-c', 'user.name=anti-hall respawn', '-c', 'user.email=respawn@anti-hall.invalid'];
      const c = git(wt, who.concat(['commit-tree', tree.out, '-p', 'HEAD', '-m',
        'WIP parked by devswarm respawn of ' + o.id + ' (' + (o.branch || 'detached') + ')']));
      if (!c.ok) return { ok: false, stage: 'commit', error: 'commit-tree failed: ' + c.err };
      commit = c.out;
    } finally {
      // Our own private temp index — never the child's.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  } else {
    const h = git(wt, ['rev-parse', 'HEAD']);
    if (!h.ok) return { ok: false, stage: 'commit', error: 'cannot read HEAD' };
    commit = h.out;
  }
  const b = git(wt, ['branch', o.parkBranch, commit]);
  if (!b.ok) return { ok: false, stage: 'branch', error: 'git branch ' + o.parkBranch + ' failed: ' + b.err, commit };
  const p = git(wt, ['push', 'origin', 'refs/heads/' + o.parkBranch + ':refs/heads/' + o.parkBranch], { timeout: PUSH_TIMEOUT_MS });
  if (!p.ok) {
    return { ok: false, stage: 'push', parkBranch: o.parkBranch, commit,
      error: 'push of ' + o.parkBranch + ' failed (the local branch keeps the work): ' + p.err.split('\n').slice(-3).join(' ') };
  }
  return { ok: true, parkBranch: o.parkBranch, commit, pushed: true };
}

// handoverText(info) -> markdown. Steps are written as "#N text", never
// "N. text", so parseSteps reads only the brief's own numbered plan.
// handoverText(info): info = { id, branch, plan, parkBranch,
// mergeRef, newBranch, lastWorkingOn, now }.
function handoverText(info) {
  const plan = info.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const done = steps.filter((s) => s.status === 'done');
  const remaining = steps.filter((s) => s.status !== 'done');
  const extras = Array.isArray(plan.extras) ? plan.extras : [];
  const lines = [
    '# Handover: respawn of ' + info.id,
    '',
    '- Old workspace: `' + info.id + '` on branch `' + (info.branch || '?') + '`',
    '- New branch: `' + info.newBranch + '` (from the default branch `' + info.defaultBranch + '`)',
    '- Previous work to merge first: `' + info.mergeRef + '`' + (info.parkBranch ? ' (WIP park branch, pushed)' : ''),
    '- Written: ' + new Date(info.now).toISOString(),
    '',
    '## Steps done',
  ];
  if (done.length) for (const s of done) lines.push('- #' + s.n + ' ' + s.text);
  else lines.push('- none');
  lines.push('', '## Remaining steps');
  if (remaining.length) for (const s of remaining) lines.push('- #' + s.n + ' ' + s.text + (s.status !== 'todo' ? ' (' + s.status + ')' : ''));
  else lines.push('- none');
  lines.push('', '## Last working on', '', info.lastWorkingOn ? info.lastWorkingOn : '(no summary reported)');
  lines.push('', '## Scope', '', (plan.scope_globs || []).length ? plan.scope_globs.join(', ') : '(none)');
  lines.push('', '## Extras the user asked for');
  if (extras.length) for (const e of extras) lines.push('- `' + e.glob + '`: ' + e.note);
  else lines.push('- none');
  return lines.join('\n') + '\n';
}

// briefText(info, handover) -> the new workspace's -p brief: the handover, then
// a numbered plan whose step 1 merges the old work and whose later steps are
// the remaining ones, then the old scope line.
function briefText(info, handover) {
  const plan = info.plan || {};
  const remaining = (Array.isArray(plan.steps) ? plan.steps : []).filter((s) => s.status !== 'done');
  const out = [
    'Respawn of ' + info.id + ' (' + (info.branch || '?') + '): continue its plan from the handover below.',
    '',
    handover.trim(),
    '',
    'Plan:',
    '1. Merge the previous work first: `git merge ' + info.mergeRef + '` (step 0 of the respawn), resolve conflicts, commit.',
  ];
  remaining.forEach((s, i) => out.push((i + 2) + '. ' + s.text));
  if (!remaining.length) out.push('2. Verify the merged work, then report done.');
  if ((plan.scope_globs || []).length) out.push('', 'Scope: ' + plan.scope_globs.join(', '));
  return out.join('\n');
}

module.exports = {
  git, worktreeState, needsPark, parkBranchName, nextBranch, localBranchExists,
  parkWip, handoverText, briefText,
};
