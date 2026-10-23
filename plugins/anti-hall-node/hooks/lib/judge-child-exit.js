'use strict';
// judge-child-exit.js — recursion belt-and-braces. The `claude -p` judge child
// runs with disableAllHooks and ANTIHALL_JUDGE_CHILD=1; if hooks ever load
// anyway, requiring this FIRST makes the hook a no-op: drain stdin, print
// nothing, exit 0. Synchronous so no hook code runs after it.
const fs = require('fs');

if (process.env.ANTIHALL_JUDGE_CHILD === '1') {
  try { fs.readFileSync(0); } catch (_) { /* no stdin / closed — nothing to drain */ }
  process.exit(0);
}
