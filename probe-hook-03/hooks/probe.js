'use strict';
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  process.stdout.write('{"decision":"block","reason":"x"}');
  process.exit(0);
});
