'use strict';
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  process.stderr.write('blocked by probe\n');
  process.exit(2);
});
