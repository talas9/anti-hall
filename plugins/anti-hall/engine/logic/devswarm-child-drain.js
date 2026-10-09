// check = "devswarm-child-drain" (PostToolUse): a child workspace's mailbox drain nudge. Allows the call when the hook cannot act (switch
// off, not an active DevSwarm child) and, for an active child, when the Node hook would stay silent before counting anything: the
// stable launchers it would install are already current, the call is not a Bash call of the main thread, it reads the Primary's inbox, or
// the workspace descriptor holds no inbox. Anything else defers: the unread count and the throttle state are Node's. Mirrors
// hooks/devswarm-child-drain.js `main`. This script builds on devswarm-child-gate.js (script.includes). Keys: small_guards.toml
// (devswarm_gates.*) and devswarm_role.toml (the launchers).
'use strict';

function dgSafeId(id) {
  var extra = ah.cfg('devswarm_gates.readside_id_extra');
  return id !== '' && id !== '.' && id.indexOf('..') < 0 && id.split('').every(function (c) { return /[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0; });
}

function decide(p, opts) {
  if (dgInertForChild('devswarm_gates.child_drain_setting', null)) return 'allow';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  var st = dwLaunchersCurrent(root, false);
  if (!st) return 'defer';
  if (!jx.isObj(p)) return 'defer'; // a payload that is not an object takes Node paths this script does not follow
  var tool = p[ah.cfg('devswarm_gates.readside_tool_field')];
  if (tool !== undefined && tool !== ah.cfg('devswarm_gates.bash_tool')) return 'allow';
  if (ah.cfg('devswarm_gates.readside_subagent_fields').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
  var inp = p[ah.cfg('devswarm_gates.readside_input_field')], command = jx.isObj(inp) && typeof inp[ah.cfg('devswarm_gates.readside_command_field')] === 'string' ? inp[ah.cfg('devswarm_gates.readside_command_field')] : '';
  if (new RegExp(ah.cfg('devswarm_gates.readside_read_primary_re'), 'i').test(command)) return 'allow';
  var id = ah.env.get(ah.cfg('devswarm_gates.readside_builder_env'));
  if (id === null || !dgSafeId(id)) return 'allow';
  var f = ah.fs.readText(st.home + '/' + ah.cfg('devswarm_gates.readside_descriptor_dir') + '/' + id + ah.cfg('devswarm_gates.readside_descriptor_ext'));
  if (f === null) return 'allow'; // missing or unreadable: Node's catch, no descriptor
  var r = jx.parse(f);
  if (r.invalid || r.unsure) return 'defer'; // text that is not JSON is not proof of "no descriptor"
  return jx.isObj(r.v) && r.v[ah.cfg('devswarm_gates.readside_inbox_field')] ? 'defer' : 'allow';
}
