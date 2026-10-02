'use strict';
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  process.exit(0);
});
