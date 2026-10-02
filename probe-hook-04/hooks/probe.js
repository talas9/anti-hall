'use strict';
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}');
  process.exit(0);
});
