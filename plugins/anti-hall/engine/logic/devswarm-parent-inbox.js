// check = "devswarm-parent-inbox" (UserPromptSubmit; devswarm-child-turn.js builds on this script). The gate of the two DevSwarm prompt
// hooks: both Node hooks are silent (no output, no state written) unless this session is an active DevSwarm Primary (parent inbox) or an
// active DevSwarm child workspace (child turn), so only the silent cases are decided here and everything else defers to the Node hook,
// which owns the roster, the shared store, the app database and the heartbeat. A session is silent for a hook when it is a Jev judge
// child, the role does not match (the Primary hook in a child workspace, the child hook outside one), the kill switch is set, the
// hook's switch (devswarm.parentInbox / devswarm.childTurn) is off, or DevSwarm is inactive (devswarm.supervisorMode off, or auto mode
// without a repository id). Mirrors hooks/lib/devswarm-primary-gate.js `inert`, hooks/lib/devswarm-detect.js `isDevswarmActive` and
// hooks/lib/devswarm-role.js `isChildWorkspace`. Keys: small_guards.toml (devswarm_prompt.*).
'use strict';

function dpNonBlank(v) { return v !== null && v.trim() !== ''; }

function dpActive() {
  var mode = ah.settings.enum('devswarm_prompt.mode_setting');
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return dpNonBlank(ah.env.get(ah.cfg('devswarm_prompt.repo_env')));
}

// True when the Node hook for `role` ('parent' or 'child') is provably silent in this environment. The home is HOME exactly: Node resolves
// the settings file against `os.homedir()`, so a request without HOME proves nothing about the files and only the environment-only
// conditions are used.
function dpSilent(role) {
  if (ah.env.get(ah.cfg('devswarm_prompt.judge_env')) === ah.cfg('devswarm_prompt.judge_value')) return true;
  var child = dpNonBlank(ah.env.get(ah.cfg('devswarm_prompt.branch_env')));
  if ((role === 'parent' && child) || (role === 'child' && !child)) return true;
  if (ah.env.get(ah.cfg('devswarm_prompt.kill_env')) === ah.cfg('devswarm_prompt.kill_value')) return true;
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || home === '') return false;
  return !ah.settings.bool(role === 'parent' ? 'devswarm_prompt.parent_setting' : 'devswarm_prompt.child_setting') || !dpActive();
}

function decide() { return dpSilent('parent') ? 'allow' : 'defer'; }
