// check = "orch-on-spawn" (PreToolUse on Agent, Task, Workflow; Codex's spawn tool). The silent half of the Node hook: it
// answers every case where Node prints nothing (not a spawn, no session, feature off or skipped, `full` protocol, a
// subagent's own call, a missing or settled marker). A pending marker defers to Node, which owns the claim race and the
// transcript scan. Mirrors hooks/orch-on-spawn.js `main` up to the marker check. Keys: spawn_context.toml (orch_*).
'use strict';

function decide(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return 'allow';
  if (typeof p.tool_name === 'string' && ah.cfg('orch_on_spawn.spawn_tools').indexOf(p.tool_name) < 0) return 'allow';
  var sid = p.session_id;
  if (typeof sid !== 'string' || sid === '') return 'allow';
  if (spawn.osHome() === null) return 'defer';
  if (!ah.settings.bool('orch_state.setting') || ah.settings.skipped(ah.cfg('orch_state.skip_name'))) return 'allow';
  if (ah.settings.enum('orch_state.protocol_setting') === ah.cfg('orch_state.full_level') || spawn.subagentByPayload(p)) return 'allow';
  var sh = spawn.stateHome();
  if (sh.ok === undefined) return 'allow';
  var m = spawn.readMarker(sh.ok, sid);
  return m !== null && m.decision === ah.cfg('orch_state.decisions')[0] ? 'defer' : 'allow';
}
