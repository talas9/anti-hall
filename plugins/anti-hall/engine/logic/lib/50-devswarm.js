// Gate helpers of the DevSwarm prompt hooks (mirror hooks/lib/devswarm-primary-gate.js `inert`, devswarm-detect.js
// `isDevswarmActive` and devswarm-role.js `isChildWorkspace`). Keys: small_guards.toml (devswarm_prompt.*).
'use strict';
var devswarmGate = {
  nonBlank: function (v) { return v !== null && v.trim() !== ''; },
  isChild: function () { return devswarmGate.nonBlank(ah.env.get(ah.cfg('devswarm_prompt.branch_env'))); },
  // True when the Node hook for `child` (true: devswarm-child-turn, false: devswarm-parent-inbox) is provably silent in this
  // environment. Node resolves the settings file against the home directory, so a request without HOME proves nothing
  // about the files and only the environment-only conditions count.
  silent: function (child, switchKey) {
    if (ah.env.get(ah.cfg('devswarm_prompt.judge_env')) === ah.cfg('devswarm_prompt.judge_value')) return true;
    var isChild = devswarmGate.isChild();
    if ((!child && isChild) || (child && !isChild)) return true;
    if (ah.env.get(ah.cfg('devswarm_prompt.kill_env')) === ah.cfg('devswarm_prompt.kill_value')) return true;
    var home = ah.env.get(ah.cfg('env.home'));
    if (home === null || home === '') return false;
    if (!ah.settings.bool(switchKey)) return true;
    var mode = ah.settings.enum('devswarm_prompt.mode_setting');
    if (mode === 'off') return true;
    if (mode === 'on') return false;
    return !devswarmGate.nonBlank(ah.env.get(ah.cfg('devswarm_prompt.repo_env')));
  },
};
