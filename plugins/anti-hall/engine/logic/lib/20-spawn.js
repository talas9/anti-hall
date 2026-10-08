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
  // `sanitizeSessionId`: only letters, digits, `_` and `-` survive; the unknown-session name when nothing is left.
  sanitize: function (raw) {
    var safe = String(raw).replace(/[^A-Za-z0-9_-]/g, '');
    return safe === '' ? ah.cfg('spawn_ctx.unknown_session') : safe;
  },
  // `isSubagentByPayload`: one of the agent marker keys is present and not null (a present but falsy value still counts).
  subagentByPayload: function (p) {
    return p !== null && typeof p === 'object' && !Array.isArray(p) && ah.cfg('orch_on_spawn.agent_markers').some(function (k) {
      return Object.prototype.hasOwnProperty.call(p, k) && p[k] !== null;
    });
  },
  // The orchestration marker of a session (`readMarker`): {decision, epochId, sentAt}, or null when missing or malformed.
  readMarker: function (home, sid) {
    var file = ah.path.join(ah.path.join(ah.path.join(home, ah.cfg('spawn_ctx.state_root')), ah.cfg('orch_state.dir')),
      ah.cfg('orch_state.prefix') + '-' + spawn.sanitize(sid) + '.json');
    var raw = ah.fs.readText(file);
    if (raw === null) return null;
    var v;
    try { v = JSON.parse(raw); } catch (e) { return null; }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.epochId !== 'string' || v.epochId === '') return null;
    if (typeof v.decision !== 'string' || ah.cfg('orch_state.decisions').indexOf(v.decision) < 0) return null;
    if (typeof v.sentAt !== 'number' || !isFinite(v.sentAt)) return null;
    return v;
  },
};
