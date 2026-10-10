// check = "orch-on-spawn" (PreToolUse on Agent, Task, Workflow; Codex's spawn tool). Delivers the full orchestration rules once per
// context epoch, on the coordinator's first spawn: SessionStart left a marker saying `pending`, and the first spawn that wins the
// claim (a file created only when absent) sends the text. Silent in every other case: not a spawn, no session, feature off or
// skipped, the `full` protocol, a subagent's own call, a missing or settled marker, a claim another spawn already holds. The one
// path that stays with Node is the retry slot, which opens after the claim's lease and needs the transcript scan that proves no
// delivered copy exists: it defers before anything is written. Mirrors hooks/orch-on-spawn.js `main` and hooks/lib/orch-full-state.js
// (`tryClaim`, `claimAt`, `claimPath`, `tokenFor`); the text is the one verify-first-orch.js sends at SessionStart (`vfoFull`, a
// library of this check: script.includes). Keys: spawn_context.toml (orch_on_spawn.*, orch_state.*), guards_l12.toml.
'use strict';

function oosClaimRel(sid, epochId, suffix) {
  return ah.cfg('spawn_ctx.state_root') + '/' + ah.cfg('orch_state.dir') + '/' + ah.cfg('orch_state.prefix') + '-' + spawn.sanitize(sid) + '-' +
    String(epochId).replace(new RegExp(ah.cfg('orch_on_spawn.epoch_unsafe'), 'g'), '') + '-' + suffix + ah.cfg('orch_on_spawn.claim_ext');
}

// `claimAt(file)`: the time stored in the claim, else the file's modification time, else null.
function oosClaimAt(abs) {
  var raw = ah.fs.readText(abs);
  if (raw !== null) {
    try {
      var c = JSON.parse(raw);
      if (c && typeof c.at === 'number' && isFinite(c.at)) return c.at;
    } catch (e) { /* fall through */ }
  }
  return ah.fs.mtimeMs(abs);
}

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
  if (m === null || m.decision !== ah.cfg('orch_state.decisions')[0]) return 'allow';

  var abs = function (rel) { return sh.ok + '/' + rel; };
  var t = ah.clock.now();
  // a live session's marker stays out of the retention sweep: touch it on every spawn read
  var markerRel = ah.cfg('spawn_ctx.state_root') + '/' + ah.cfg('orch_state.dir') + '/' + ah.cfg('orch_state.prefix') + '-' + spawn.sanitize(sid) + '.json';
  ah.commit();
  try { ah.state.op(sh.ok, 'touch', markerRel); } catch (e) { /* best effort, as in Node */ }

  var claim1 = oosClaimRel(sid, m.epochId, ah.cfg('orch_on_spawn.claim_suffix'));
  var won = false;
  try { won = ah.state.op(sh.ok, 'create', claim1, JSON.stringify({ at: t, pid: ah.pid() })); } catch (e) { won = false; }
  if (!won) {
    // the retry slot: only after the lease, only when no delivered copy is visible; once the second slot exists the epoch is done
    if (ah.fs.kind(abs(oosClaimRel(sid, m.epochId, ah.cfg('orch_on_spawn.claim2_suffix')))) !== null) return 'allow';
    var at = oosClaimAt(abs(claim1));
    if (at === null || t - at < ah.cfgNum('orch_on_spawn.lease_ms')) return 'allow';
    return 'defer'; // the transcript scan that proves a delivered copy absent stays with Node
  }

  var event = typeof p.hook_event_name === 'string' && p.hook_event_name ? p.hook_event_name : ah.cfg('orch_on_spawn.default_event');
  var codex = new RegExp(ah.cfg('orch_on_spawn.codex_tool_suffix')).test(String(p.tool_name)) || vf.codexPayload(p);
  var body = vfoFull(codex) + '\n' + text.render(ah.cfg('orch_on_spawn.token_format'), { epoch: m.epochId });
  return { advisory: text.advisoryJson(event, body) };
}
