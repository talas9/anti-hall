// check = "devswarm-child-drain" (PostToolUse): a child workspace's mailbox drain nudge. Answers what the Node hook answers: silent when
// it cannot act (switch off, not an active DevSwarm child), when the call is not a Bash call of the main thread or reads the Primary's
// inbox, when the workspace id is unusable or its descriptor names no inbox, and when its own unread count is zero; otherwise the nudge
// with the unread count and the oldest message's age, throttled by its state file (child-drain/<id>.json: re-shown when the count
// changed or the throttle window passed). The count is the child's own mailbox: the descriptor's durable inbox and, when its worktree
// names a project with a store, the store rows no inbox line covers, read with this hook's own reader (ah.mesh.countFor). A case it cannot
// settle exactly is decided natively and counted (native_unable): no usable home or plugin root, a payload that is not an object or a
// path that is not a string say nothing; a relative path resolves against the stand-in directory; a project or store the host cannot read exactly
// gets the nudge with an unknown count. Mirrors hooks/devswarm-child-drain.js `main`. This script builds on devswarm-child-gate.js and
// devswarm-child-role.js (script.includes). Keys: devswarm_gates.toml (devswarm_gates.*) and devswarm_role.toml (the launchers).
'use strict';

// `shouldInject(home, id, count, now)`: whether the nudge is shown, and the throttle state it then records.
function cdThrottle(home, id, count, now) {
  var rel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_gates.cd_state_dir') + '/' + id + '.json';
  var prev = cgJson(home + '/' + rel);
  var lastCount = prev && cgFinite(prev.lastCount) ? prev.lastCount : null;
  var lastAt = prev && cgFinite(prev.lastInjectedAt) ? prev.lastInjectedAt : null;
  var changed = lastCount === null || lastCount !== count;
  var elapsed = lastAt === null || (now - lastAt) >= ah.cfgNum('devswarm_gates.cd_throttle_ms');
  if (!changed && !elapsed) return null;
  return { rel: rel, body: JSON.stringify({ lastCount: count, lastInjectedAt: now }) };
}

function cdAge(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return ah.cfg('devswarm_gates.cd_unknown_age');
  return Math.floor(ms / ah.cfgNum('devswarm_role.pg_ms_per_min')) + ah.cfg('devswarm_gates.cd_minutes_suffix');
}

function cdDecide(p, st) {
  var tool = p[ah.cfg('devswarm_gates.readside_tool_field')];
  if (tool !== undefined && tool !== ah.cfg('devswarm_gates.bash_tool')) return 'allow';
  if (ah.cfg('devswarm_gates.readside_subagent_fields').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
  var inp = p[ah.cfg('devswarm_gates.readside_input_field')], command = jx.isObj(inp) && typeof inp[ah.cfg('devswarm_gates.readside_command_field')] === 'string' ? inp[ah.cfg('devswarm_gates.readside_command_field')] : '';
  if (new RegExp(ah.cfg('devswarm_gates.readside_read_primary_re'), 'i').test(command)) return 'allow';
  var id = cgBuilder();
  if (!dgSafeId(id)) return 'allow';
  var desc = cgJson(st.home + '/' + ah.cfg('devswarm_gates.readside_descriptor_dir') + '/' + id + ah.cfg('devswarm_gates.readside_descriptor_ext'));
  if (!desc || typeof desc !== 'object' || !desc[ah.cfg('devswarm_gates.readside_inbox_field')]) return 'allow';
  var inbox = desc.inboxPath, cursor = desc.cursorPath, wt = desc.worktreePath;
  if (typeof inbox !== 'string' || inbox.charAt(0) !== '/') { ah.unable('devswarm-child-drain:inbox_path'); if (typeof inbox !== 'string') return 'allow'; inbox = hookProc.resolve(p, inbox); } // resolved against the stand-in directory
  if (cursor === undefined || cursor === null || cursor === '' || cursor === false || cursor === 0) cursor = null;
  else if (typeof cursor !== 'string' || cursor.charAt(0) !== '/') { ah.unable('devswarm-child-drain:cursor_path'); cursor = typeof cursor === 'string' ? hookProc.resolve(p, cursor) : null; }
  var key = null, keyUnsure = false;
  if (wt) {
    if (typeof wt !== 'string') ah.unable('devswarm-child-drain:worktree_shape');
    else { var kd = ah.mesh.repoKeyDetail(wt); key = kd.key; keyUnsure = kd.unsure === true; }
  }
  var now = ah.clock.now();
  // a project or a store the host cannot read exactly: the count is unknown, and the nudge says so (never a silent pass)
  var c = keyUnsure ? { state: 'nd', unread: 0, known: false, unsure: true } : ah.mesh.countFor(key, id, inbox, cursor, now);
  var unknown = c.unsure === true;
  var unread = c.state === 'ok' ? c.unread : (c.known ? c.unread : 0), age = c.state === 'ok' ? c.age : null;
  if (!unknown && !(unread > 0)) return 'allow';
  var w = cdThrottle(st.home, id, unknown ? ah.cfgNum('devswarm_gates.cd_unknown_count') : unread, now);
  if (w === null) return 'allow';
  ah.commit();
  ah.state.writeAtomic(w.rel, w.body); // best-effort: a failed persist still lets this one nudge through
  var msg = text.render(ah.cfg(unknown ? 'devswarm_gates.cd_message_unknown' : 'devswarm_gates.cd_message'), { n: String(unread), age: cdAge(age), cli: st.cli, id: id });
  return { exact: { code: 0, out: JSON.stringify({ hookSpecificOutput: { hookEventName: ah.cfg('devswarm_gates.cd_event'), additionalContext: msg } }) + '\n', err: '' } };
}

function decide(p, opts) {
  if (dgInertForChild('devswarm_gates.child_drain_setting', null)) return 'allow';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  var st = dwLaunchersNative(root, false);
  if (!st) { ah.unable('devswarm-child-drain:no_launchers', 'abandoned'); return 'allow'; } // no usable home or plugin root: no launcher can be named
  if (!jx.isObj(p)) { ah.unable('devswarm-child-drain:payload_shape', 'abandoned'); return 'allow'; }
  return cdDecide(p, st);
}
