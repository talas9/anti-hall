// Main-thread detection shared by the delegation checks (mirrors hooks/coordinator-detect.js `isCoordinator`,
// `isSubagentByPayload`, `isCodexPayload`). The request's own CLAUDE_CODE_ENTRYPOINT is read, never the daemon's.
'use strict';
var coordinator = {
  own: function (p, k) { return p !== null && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, k) ? p[k] : undefined; },
  present: function (p, k) { var v = coordinator.own(p, k); return v !== undefined && v !== null; },
  // Both Codex marker fields are non-empty strings.
  payloadIsCodex: function (p) {
    return ah.cfg('coordinator_work.codex_markers').every(function (k) { var v = coordinator.own(p, k); return typeof v === 'string' && v !== ''; });
  },
  // Codex: any present, non-null marker; Claude: a truthy one.
  subagentByPayload: function (p) {
    var markers = ah.cfg('coordinator_work.agent_markers');
    return coordinator.payloadIsCodex(p) ? markers.some(function (k) { return coordinator.present(p, k); }) : markers.some(function (k) { return !!coordinator.own(p, k); });
  },
  isCodexPayload: function (p) {
    return p !== null && typeof p === 'object' && !Array.isArray(p) && (p.tool_name === ah.cfg('coordinator_work.codex_tool') || coordinator.payloadIsCodex(p));
  },
  // True when the session is the main thread. An absent or unknown entry point is not the main thread (the Node guards fail open).
  isCoordinator: function (p) {
    var entry = ah.env.get(ah.cfg('coordinator_work.entrypoint_env'));
    if (entry === null) entry = '';
    if (coordinator.isCodexPayload(p)) {
      return entry === '' && !ah.cfg('coordinator_work.agent_markers').some(function (k) { return coordinator.present(p, k); });
    }
    if (coordinator.subagentByPayload(p) || entry === ah.cfg('coordinator_work.subagent_entrypoint')) return false;
    return ah.cfg('coordinator_work.main_entrypoints').indexOf(entry) >= 0 || entry.indexOf(ah.cfg('coordinator_work.main_entrypoint_prefix')) === 0;
  },
};
