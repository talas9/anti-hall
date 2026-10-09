// check = "devswarm-parent-reply-tracker" (PostToolUse on Bash): a Primary's reply tracker. Allows every call the Node hook ignores before it
// reads anything but the payload: the switch is off, this is a child workspace, the payload is not an object, the tool is not Bash, or
// the command does not hold both the `devswarm` and `send` words (either order). A plausible `devswarm send` defers: the reply-state file,
// the send receipts and the repository key are Node's. Mirrors hooks/devswarm-parent-reply-tracker.js `main` up to that point and
// `looksLikeDevswarmSend`. This script builds on devswarm-child-gate.js (script.includes). Keys: small_guards.toml (devswarm_gates.*).
'use strict';

function decide(p) {
  if (!ah.settings.bool('devswarm_gates.reply_tracker_setting') || dgChild() || !jx.isObj(p)) return 'allow';
  if (p.tool_name !== ah.cfg('devswarm_gates.bash_tool')) return 'allow';
  var c = jx.isObj(p.tool_input) ? p.tool_input.command : undefined;
  if (typeof c !== 'string') return 'allow';
  return ah.cfg('devswarm_gates.send_words').every(function (w) { return new RegExp('\\b' + w + '\\b', 'i').test(c); }) ? 'defer' : 'allow';
}
