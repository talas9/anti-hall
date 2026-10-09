// check = "emit-dedupe-reset" (SessionStart, every source). The UserPromptSubmit hooks suppress blocks the model already received
// (lib/74-emit-dedupe.js). After a context loss (/compact keeps the same session id; /clear, resume and startup begin a new context)
// the model no longer holds those blocks, so this check writes a per-session reset marker { resetAt, lastSeenAt } and every record
// emitted before it counts as absent. State only: it says nothing. A request without HOME defers. Mirrors hooks/emit-dedupe-reset.js.
// Keys: prompt_emit.toml (emit_dedupe.*).
'use strict';
function decide(p) {
  if (ah.env.get(ah.cfg('prompt_emit.judge_child_env')) === '1') return 'allow';
  var sid = p && p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  if (dedupe.disabled() || !sid) return 'allow';
  if (spawn.osHome() === null) return 'defer';
  dedupe.reset(sid);
  return 'allow';
}
