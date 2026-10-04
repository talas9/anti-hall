// Node baseline doing the same job as `engine hook` (parse payload, regex-match rules.json, emit deny).
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(0, 'utf8'));
const rules = JSON.parse(fs.readFileSync(process.env.ANTIHALL_ENGINE_RULES, 'utf8')).rules;
const subject = (j.tool_input && (j.tool_input.command || j.tool_input.file_path)) || '';
for (const r of rules) {
  if (r.events && !r.events.includes(j.hook_event_name)) continue;
  if (r.tools && !r.tools.includes(j.tool_name)) continue;
  if (new RegExp(r.pattern.replace(/^\(\?[is]+\)/, ''), /^\(\?i/.test(r.pattern) ? 'is' : '').test(subject) && r.action === 'deny') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.message } }));
    break;
  }
}
