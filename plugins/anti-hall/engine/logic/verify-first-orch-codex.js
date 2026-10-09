// check = "verify-first-orch-codex" (SessionStart, the Codex hook entry): the verify-first-orch hook without the `--host=claude` flag,
// so the session is never "confident" it runs under Claude Code and the host's config directory is never read. Same logic, same
// texts: this script builds on verify-first-orch.js (script.includes).
'use strict';

function decide(p, opts) { return vfoDecide(p, opts, false); }
