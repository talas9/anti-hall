'use strict';
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(s); } catch (e) { p = {}; }
  const obj = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'tool ' + String(p.tool_name || '') } };
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
});
