'use strict';
// Regression test for defect a9ac2fc7e368 (hooks/devswarm-parent-inbox.js):
// computeSummary's staleRegistryPartitions[] only excludes anti-hall's OWN
// internal archive tombstone (archivedOnlyIds — the `archived/<id>.json`
// anti-hall itself writes), never the owner archiving the SAME workspace in
// the DevSwarm app — that signal (isAppArchived, the absence-from-the-
// supervisor's ACTIVE-set snapshot) is already consulted a few hundred lines
// above for the live workspace table's own liveness label, but was never
// applied here, so this table kept naming an app-archived-era partition as
// "STALE WORKSPACE" forever.
//
// Fix under test: the stale-registry segment now filters
// summary.staleRegistryPartitions through the SAME appArchivedCache()/
// isAppArchived() this file already uses for the live table, before ever
// building the segment — fail-open on any isAppArchived error (row stays
// visible), so this can only ever SUPPRESS on positive evidence.
//
// Points at ANTIHALL_TEST_PLUGIN_ROOT (a `plugins/anti-hall`-shaped tree) so
// this SAME file proves RED against HEAD (pre-fix) and GREEN against the live,
// already-fixed working tree without duplication. Defaults to the real repo
// tree (the current, already-patched working copy).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const hookPath = path.join(ROOT, 'hooks', 'devswarm-parent-inbox.js');
const archivedCachePath = path.join(ROOT, 'companion', 'lib', 'devswarm-archived-cache.js');
const repokeyPath = path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js');
if (!fs.existsSync(hookPath) || !fs.existsSync(archivedCachePath) || !fs.existsSync(repokeyPath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find:\n  ' + hookPath + '\n  ' + archivedCachePath + '\n  ' + repokeyPath
  );
}
const archivedCache = require(archivedCachePath);
const repokey = require(repokeyPath);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-a9ac2fc7e368-home-'));
  return home;
}
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-a9ac2fc7e368-repo-' + tag + '-'));
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// isolatedEnv(home) — controlled env for the spawned hook, mirroring
// tests/helpers/spawn-hook.js's isolatedEnv (never leaks the real dev HOME).
function isolatedEnv(home, extra) {
  return Object.assign({
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    // Grace period zeroed so conjunct 4 (age-since-first-seen) never blocks
    // the app-archived match in this test.
    ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS: '0',
  }, extra || {});
}

test('an app-archived stale-registry row is suppressed from the STALE WORKSPACE(S) segment', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a9ac2');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const now = Date.now();

    // Registry descriptor backdated well past any grace window, and the shared
    // summary carries a stale-registry row for the SAME id whose worktreePath
    // sits under the DevSwarm-app-managed repos root (isUnderDevswarmReposRoot
    // conjunct 2) — the exact shape isAppArchived requires to ever suppress.
    const staleWt = path.join(home, '.devswarm', 'repos', 'proj1', 'gone-workspace');
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'stale-1.json'), JSON.stringify({ id: 'stale-1', worktreePath: staleWt, sessionId: 's-stale' }));
    fs.utimesSync(path.join(wsDir, 'stale-1.json'), new Date(now - 20 * 60 * 1000), new Date(now - 20 * 60 * 1000));

    const summaryDir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(path.join(summaryDir, repoKey + '.json'), JSON.stringify({
      generatedAt: now,
      requiredGates: [],
      workspaces: {},
      recent: [],
      archivedRegistryRows: [],
      staleRegistryPartitions: [{ id: 'stale-1', worktreePath: staleWt, unread: 3 }],
    }));

    // App-side archive evidence: stale-1 is ABSENT from the active snapshot,
    // but SOME other row for this repoKey IS present (real evidence, not "no
    // snapshot at all").
    archivedCache.writeActiveCache({
      home, now,
      byRepoKey: { [repoKey]: [{ id: 'some-other-live-id', worktreePath: path.join(home, '.devswarm', 'repos', 'proj1', 'other') }] },
    });

    const res = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: repo }),
      env: isolatedEnv(home, { DEVSWARM_REPO_ID: 'repo-1' }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(res.status, 0);
    let json = null;
    try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
    const ctxText = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || '';
    assert.ok(!/STALE WORKSPACE/.test(ctxText),
      'an app-archived row must never be named as a stale workspace; additionalContext=' + ctxText);
  } finally { rm(home); rm(repo); }
});

test('a stale-registry row with NO app-archive evidence is still surfaced (no false suppression)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a9ac2-nofix');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const now = Date.now();

    const staleWt = path.join(home, '.devswarm', 'repos', 'proj1', 'gone-workspace-2');
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'stale-2.json'), JSON.stringify({ id: 'stale-2', worktreePath: staleWt, sessionId: 's-stale-2' }));
    fs.utimesSync(path.join(wsDir, 'stale-2.json'), new Date(now - 20 * 60 * 1000), new Date(now - 20 * 60 * 1000));

    const summaryDir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
    fs.mkdirSync(summaryDir, { recursive: true });
    fs.writeFileSync(path.join(summaryDir, repoKey + '.json'), JSON.stringify({
      generatedAt: now,
      requiredGates: [],
      workspaces: {},
      recent: [],
      archivedRegistryRows: [],
      staleRegistryPartitions: [{ id: 'stale-2', worktreePath: staleWt, unread: 3 }],
    }));
    // Deliberately NO writeActiveCache call — no app-archive snapshot at all.

    const res = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: repo }),
      env: isolatedEnv(home, { DEVSWARM_REPO_ID: 'repo-1' }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(res.status, 0);
    let json = null;
    try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
    const ctxText = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || '';
    assert.ok(/STALE WORKSPACE/.test(ctxText),
      'without any app-archive evidence the row must still be surfaced; additionalContext=' + ctxText);
  } finally { rm(home); rm(repo); }
});
