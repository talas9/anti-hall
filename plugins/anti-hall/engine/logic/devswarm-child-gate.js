// check = "devswarm-child-gate" (Stop; devswarm-parent-reply-tracker.js and devswarm-child-drain.js build on this script). The part of the
// three DevSwarm hooks that can be decided exactly without the mailbox store or scripts/devswarm.js: what the Node hook decides before it
// touches anything but the environment, the settings files and the payload, where it then says nothing and writes nothing. The child
// Stop gate allows a stop when its switch is off, a skip is recorded, DevSwarm is not active, or this is not a child workspace (the same
// `exitIfInert`); a child workspace defers (heartbeat, inbox state, shared stop budgets, store reads, the message-count probe and the block
// text are Node's). Mirrors hooks/lib/devswarm-primary-gate.js, hooks/lib/devswarm-detect.js `isDevswarmActive` and
// hooks/lib/devswarm-role.js `isChildWorkspace`. Keys: small_guards.toml (devswarm_gates.*).
'use strict';

function dgNonEmpty(name) { var v = ah.env.get(name); return v !== null && v.trim() !== ''; }
function dgChild() { return dgNonEmpty(ah.cfg('devswarm_gates.source_branch_env')); }

function dgActive() {
  if (ah.env.get(ah.cfg('devswarm_gates.kill_env')) === ah.cfg('devswarm_gates.kill_env_value')) return false;
  var mode = ah.settings.enum('devswarm_gates.supervisor_mode');
  if (mode === ah.cfg('devswarm_gates.mode_off')) return false;
  if (mode === ah.cfg('devswarm_gates.mode_on')) return true;
  return dgNonEmpty(ah.cfg('devswarm_gates.repo_id_env'));
}

// `devswarm-primary-gate.js` `inert`: the hook would exit silently before doing anything (child role).
function dgInertForChild(switchKey, guard) {
  return !ah.settings.bool(switchKey) || (guard !== null && ah.settings.skipped(guard)) || !dgActive() || !dgChild();
}

function decide() { return dgInertForChild('devswarm_gates.child_gate_setting', ah.cfg('devswarm_gates.child_gate_guard_name')) ? 'allow' : 'defer'; }
