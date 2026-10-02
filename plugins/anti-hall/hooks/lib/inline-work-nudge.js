'use strict';
// anti-hall :: inline-work-nudge — advisory note for a DevSwarm PRIMARY that keeps
// doing file edits itself while workspace-scale work sits pending and it has no
// live child workspace. Called from edit-guard.js (PreToolUse Write|Edit|MultiEdit|
// NotebookEdit, coordinator calls only), which writes the note as additionalContext.
//
// evaluate(payload, env) -> { text, commit } | null. Counts every main-thread
// mutating call of the session (state file ~/.anti-hall/inline-work-<session>.json),
// and returns the note ONCE per session when ALL hold:
//   - devswarm.inlineWorkNudge is on; DevSwarm Primary (not a child workspace);
//   - the repo does not forbid workspaces (dispatch-tier.js noWorkspaceRepo);
//   - the call count is MORE than devswarm.inlineWorkNudgeThreshold (default 5);
//   - the transcript shows at least one pending ACTIONABLE task (task-state.js);
//   - hasLiveChild() === false (positive proof of zero live children: that
//     predicate fails open to TRUE on any doubt, so unknown liveness stays silent).
// The caller invokes commit() only after it actually emitted the note, so a blocked
// call never uses up the once-per-session note. Never blocks; fail-open to null.

const fs = require('fs');
const path = require('path');

const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NOTE = 'DEVSWARM PRIMARY: you have made several direct file edits while actionable tasks are pending and no child workspace is live. Workspace-scale work (a feature/fix/deploy: multi-step, own branch, own review) belongs in a child workspace: `node scripts/devswarm.js spawn <branch> -p "<brief>"`. Keep inline edits to small, scoped changes.';

function stateFile(home, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return path.join(home, '.anti-hall', 'inline-work-' + safe + '.json');
}

function evaluate(payload, env) {
  try {
    if (!payload || !MUTATING.has(payload.tool_name) || !payload.session_id) return null;
    const e = env || process.env;
    const settings = require('./settings.js');
    if (!settings.enabled('devswarm', 'inlineWorkNudge')) return null;
    const { isDevswarmActive } = require('./devswarm-detect.js');
    const { isChildWorkspace } = require('./devswarm-role.js');
    if (!isDevswarmActive(e) || isChildWorkspace(e)) return null;
    const cwd = payload.cwd || process.cwd();
    if (require('./dispatch-tier.js').noWorkspaceRepo(cwd)) return null;

    const home = require('../../companion/lib/test-home-guard.js').resolveHome(undefined, e);
    const file = stateFile(home, payload.session_id);
    let st = { count: 0, nudged: false };
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p && typeof p === 'object') st = { count: Number(p.count) || 0, nudged: !!p.nudged }; } catch (_) { /* first call */ }
    if (st.nudged) return null;
    st.count += 1;
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(st), 'utf8');
        require('./state-prune.js').pruneStale({ stateDir: path.dirname(file), prefix: 'inline-work', keepFile: file });
      } catch (_) { /* best-effort */ }
    };
    write();

    let threshold = 5;
    try { const t = Number(settings.get('devswarm', 'inlineWorkNudgeThreshold', 5)); if (Number.isFinite(t) && t >= 1) threshold = t; } catch (_) { threshold = 5; }
    if (st.count <= threshold) return null;

    const tp = payload.transcript_path;
    if (!tp || typeof tp !== 'string') return null;
    const lines = require('./transcript-tail.js').readTail(tp);
    if (!lines) return null;
    const { reconstructTasks, openOf, classifyOpen } = require('./task-state.js');
    const state = reconstructTasks({ data: lines.join('\n'), truncated: false });
    if (classifyOpen(openOf(state.taskMap), state.taskMap).length === 0) return null;
    if (require('../../companion/lib/devswarm-live-children.js').hasLiveChild(home, cwd) !== false) return null;

    return { text: NOTE, commit: () => { st.nudged = true; write(); } };
  } catch (_) {
    return null;
  }
}

module.exports = { evaluate, NOTE };
