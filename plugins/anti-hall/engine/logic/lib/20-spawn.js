// Shared helpers of the spawn / path context checks (mirror hooks/lib/devswarm-detect.js, companion/lib/test-home-guard.js
// and hooks/coordinator-detect.js). The home / state-home / DevSwarm tests are decisions, so they live here, not in the engine.
'use strict';
var spawn = {
  // `os.homedir()` on POSIX: HOME when it is an absolute path.
  osHome: function () {
    var h = ah.env.get(ah.cfg('env.home'));
    return h !== null && ah.path.isAbsolute(h) ? h : null;
  },
  // `resolveHome()`: {ok: home} | {guarded: true} (a test run on the real home: state unavailable) | {unknown: true}.
  stateHome: function () {
    var home = spawn.osHome();
    if (home === null) return { unknown: true };
    var set = function (k) { var v = ah.env.get(k); return v !== null && v !== ''; };
    if (set(ah.cfg('spawn_ctx.real_home_optout_env'))) return { ok: home };
    if (ah.cfg('spawn_ctx.test_markers').some(set)) {
      var real = ah.env.passwdHome();
      if (real !== null && ah.path.resolveAbs(home) === ah.path.resolveAbs(real)) return { guarded: true };
    }
    return { ok: home };
  },
  judgeChild: function () { return ah.env.get(ah.cfg('spawn_ctx.judge_child_env')) === ah.cfg('spawn_ctx.judge_child_value'); },
  devswarmActive: function () {
    if (ah.env.get(ah.cfg('spawn_ctx.devswarm_kill_env')) === ah.cfg('spawn_ctx.devswarm_kill_value')) return false;
    var mode = ah.settings.enum('spawn_ctx.supervisor_setting').trim().toLowerCase();
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    var repo = ah.env.get(ah.cfg('spawn_ctx.devswarm_repo_env'));
    return repo !== null && repo.trim() !== '';
  },
};
