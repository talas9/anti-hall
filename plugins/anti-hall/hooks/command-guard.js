#!/usr/bin/env node
// anti-hall :: command-guard (PreToolUse Bash — coordinator only)
//
// WHAT IT DOES
//   Blocks heavy commands (build, test, deploy, push, pull, install, migrate, dumps,
//   bulk scripts) when running in a COORDINATOR context, requiring the model to
//   delegate them to a subagent instead. Silent pass-through in subagent context.
//
// COORDINATOR vs SUBAGENT DETECTION
//   PRIMARY signal (works across environments — including cmux and other wrappers
//   where a subagent inherits the parent's exact env): Claude Code injects `agent_id`
//   and `agent_type` into the PreToolUse hook PAYLOAD for Task-tool subagents. The
//   top-level coordinator's payload has NEITHER. This is the reliable discriminator.
//   SECONDARY signal: CLAUDE_CODE_ENTRYPOINT === "agent_tool" — set on the subagent
//   PROCESS in a vanilla `claude` CLI, but NOT reliable under cmux (stays "cli"), so
//   it is only a fallback.
//   A command is treated as SUBAGENT (allow) if EITHER signal indicates a subagent.
//
//   FAIL-OPEN POLICY: if context is ambiguous (no agent markers in the payload AND an
//   absent/unrecognized entrypoint), we DO NOT block — unknown contexts are treated as
//   subagent (allow). This prevents deadlock in non-standard or future environments.
//
// HEAVY COMMAND HEURISTIC
//   Checks the first verb and common heavy command patterns. Conservative: only blocks
//   commands that are unambiguously long/state-changing/noisy by first verb or pattern.
//   Does NOT block: git status/log/diff/show/branch, node --version, ls, cat, pwd, etc.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { command } }
//   stdout : JSON { decision: "block", reason: "..." } | nothing
//   exit 2 : to block (decision field); exit 0: allow
//   Fail-open on ANY error (exit 0).

'use strict';

const fs = require('fs');

// Commands whose FIRST WORD (verb) are always heavy in coordinator context.
const HEAVY_VERBS = new Set([
  // Package managers / install
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'poetry', 'uv', 'conda',
  // Build / compile / bundle
  'make', 'cmake', 'gradle', 'mvn', 'ant', 'bazel', 'buck', 'ninja',
  'tsc', 'swc', 'esbuild', 'rollup', 'vite', 'webpack', 'turbo',
  // Test runners
  'pytest', 'jest', 'vitest', 'mocha', 'jasmine', 'karma', 'cypress', 'playwright',
  'flutter', 'go', 'cargo', 'dotnet',
  // Deploy / infra
  'firebase', 'gcloud', 'aws', 'az', 'kubectl', 'helm', 'terraform', 'pulumi',
  'serverless', 'vercel', 'netlify', 'heroku',
  // DB / migrate
  'psql', 'mysql', 'mongosh', 'redis-cli', 'sqlite3', 'prisma', 'knex', 'alembic',
  'flyway', 'liquibase',
  // Other long-running / state-changing
  'docker', 'podman', 'vagrant', 'ansible',
]);

// Patterns checked against full command string (case-insensitive).
const HEAVY_PATTERNS = [
  // npm/yarn/pnpm run scripts that are build/test/deploy
  /\bnpm\s+run\s+(?:build|test|deploy|start|lint|typecheck|check)\b/i,
  /\byarn\s+(?:run\s+)?(?:build|test|deploy|start|lint|typecheck|check)\b/i,
  /\bpnpm\s+(?:run\s+)?(?:build|test|deploy|start|lint|typecheck|check)\b/i,
  // git push/pull/fetch/clone (not git status/log/diff etc.)
  /\bgit\s+(?:push|pull|fetch|clone)\b/i,
  // python/node/deno long-running scripts
  /\bpython[23]?\s+\S+\.py\b/i,
  /\bnode\s+\S+\.(?:js|mjs|cjs)\b/i,
  /\bdeno\s+(?:run|task)\b/i,
];

// Commands that look heavy by verb but are actually lightweight inspection commands.
// We allow these even if the verb matches HEAVY_VERBS.
const LIGHT_EXCEPTIONS = [
  // git subcommands that are read-only / instant
  /\bgit\s+(?:status|log|diff|show|branch|rev-parse|config\s+--get|config\s+--list|worktree\s+list|remote\s+-v|shortlog|stash\s+list|tag\s+-l|describe)\b/i,
  // npm/node version queries
  /\bnpm\s+(?:--version|-v|view|info|ls)\b/i,
  /\bnode\s+(?:--version|-v|-e\s+"[^"]*"|-e\s+'[^']*')\b/i,
  /\bflutter\s+--version\b/i,
  /\bgo\s+version\b/i,
  /\bcargo\s+(?:--version|version)\b/i,
  // go env (read-only) — but NOT `go env -w KEY=VAL` which mutates config.
  /\bgo\s+env\b(?![^\n]*\s-w\b)/i,
  // git push/pull/fetch with --dry-run is non-mutating (no refs/objects change).
  /\bgit\s+(?:push|pull|fetch)\b[^\n]*\s--dry-run\b/i,
  // docker ps/images/inspect (read-only)
  /\bdocker\s+(?:ps|images|inspect|logs|stats)\b/i,
  // anti-hall's own coordinator-owned phase-state helpers. These are documented
  // to run INLINE on the main thread on purpose — phase-state is written by the
  // coordinator, never a subagent (orchestration/SKILL.md, ship-it/SKILL.md).
  // Without this carve-out the generic `node <file>.js` HEAVY_PATTERN would make
  // the documented workflow impossible (a catch-22). NARROW by design: it matches
  // ONLY the exact plugin-relative helper paths `statusline/phase.js` and
  // `hooks/agent-watchdog.js`, with the parent dir segment anchored (either at the
  // token start or immediately after a path separator) so a look-alike prefix
  // (`evilstatusline/phase.js`) or an arbitrary `node evil.js` is NOT exempted.
  // Both `/` and `\` separators are accepted so it resolves identically on Windows.
  /\bnode\s+(?:\S*[\\/])?statusline[\\/]phase\.js\b/i,
  /\bnode\s+(?:\S*[\\/])?hooks[\\/]agent-watchdog\.js\b/i,
];

// Split a full command line into logical segments on the shell operators
// ; && || | (and newlines), honoring single/double quotes so an operator inside
// a quoted string does not create a spurious segment. Mirrors git-guard.js's
// splitter (kept self-contained — hooks are standalone scripts). This is what
// makes per-segment heuristics work: `cd app && npm test` is two segments, and
// `npm test` is correctly seen as heavy even though the FIRST verb is `cd`.
function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;

  function flush() {
    if (cur.trim().length) segments.push(cur);
    cur = '';
  }

  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';

    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }

    // Line continuation: backslash-newline joins lines.
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) {
      cur += ' '; i += (c2 === '\r') ? 3 : 2; continue;
    }

    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') { flush(); i++; continue; }
    if (c === ';') { flush(); i++; continue; }
    if (c === '&') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }
    // Subshell / grouping / command-substitution boundaries -> segment splits.
    if (c === ')' || c === '(' || c === '{' || c === '}') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flush(); i += 2; continue; }
    if (c === '`') { flush(); i++; continue; }

    cur += c;
    i++;
  }
  flush();
  return segments;
}

// Cross-platform basename: handle both / and \ path separators so /usr/bin/npm
// and \npm resolve to npm (mirrors git-guard.js).
function basename(p) {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

// Wrapper words to skip when finding a segment's effective verb (mirrors
// git-guard.js WRAPPERS, plus the shell control keywords that can lead a segment).
const WRAPPERS = new Set([
  'command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout',
  'then', 'do', 'else', 'if', 'while', 'until',
]);

// Find the effective command verb of one segment: skip leading VAR=value
// assignment prefixes and wrapper words (command/builtin/exec/sudo/env/...).
// Returns the lowercased cross-platform basename of the verb, or '' if none.
function effectiveVerb(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let idx = 0;
  // Skip leading VAR=value assignments (FOO=1 docker build .).
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  // Skip wrapper words; for env/timeout/nice, skip their leading operands too so
  // the wrapped verb is found (e.g. `timeout 5 npm test` -> npm).
  while (idx < tokens.length) {
    const word = basename(tokens[idx]).toLowerCase();
    if (!WRAPPERS.has(word)) break;
    idx++;
    if (word === 'sudo') {
      // sudo [-flags [value]] command...   Skip option flags so
      // `sudo -u deploy npm install` resolves to `npm`, not `-u`.
      const SUDO_VAL = new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '-h',
        '--user', '--group', '--prompt', '--close-from', '--role', '--type',
        '--other-user', '--host']);
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if (f === '--') break;
        if (SUDO_VAL.has(f) && idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    } else if (word === 'env') {
      while (idx < tokens.length &&
             (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]) || tokens[idx].startsWith('-'))) idx++;
    } else if (word === 'timeout') {
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-s' || f === '--signal' || f === '-k' || f === '--kill-after') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
      if (idx < tokens.length) idx++; // DURATION operand
    } else if (word === 'nice') {
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-n' || f === '--adjustment') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    }
  }
  if (idx >= tokens.length) return '';
  // Strip Windows/Unix path separators on the verb (/usr/bin/npm, \git -> npm/git).
  return basename(tokens[idx]).toLowerCase();
}

// Neutralize the CONTENTS of single- and double-quoted string literals in a
// segment, replacing each quoted char with a space so a HEAVY_PATTERN cannot
// match text that is merely a quoted DATA argument (e.g. `echo "npm run build"`).
// The quote delimiters themselves are also turned into spaces; unquoted text is
// left intact so a real unquoted `npm run build` still matches. This is used FOR
// THE PATTERN TEST ONLY — the effective-verb check and the $(...)/backtick/`-c`/
// `eval` extraction all run against the ORIGINAL segment, so command
// substitutions and shell payloads are still extracted and recursed BEFORE this
// neutralization can affect anything (extraction order preserved).
function neutralizeQuotedContents(segment) {
  let out = '';
  let i = 0;
  const n = segment.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = segment[i];
    const c2 = i + 1 < n ? segment[i + 1] : '';
    if (inSingle) { out += ' '; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { out += '  '; i += 2; continue; }
      out += ' '; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; out += ' '; i++; continue; }
    if (c === '"') { inDouble = true; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Evaluate one segment: heavy if (its effective verb is a HEAVY_VERB) OR (it
// matches a HEAVY_PATTERN), AND it is NOT itself a LIGHT_EXCEPTION. Light
// exceptions are checked PER SEGMENT so `git status && npm run build` blocks on
// the build segment instead of being exempted by the whole-string status match.
function isHeavySegment(segment) {
  for (const re of LIGHT_EXCEPTIONS) {
    if (re.test(segment)) return false;
  }
  const verb = effectiveVerb(segment);
  if (verb && HEAVY_VERBS.has(verb)) return true;
  // For PATTERN matching only, neutralize quoted string contents so a benign
  // command whose only heavy-looking text is inside a quoted DATA arg
  // (`echo "npm run build"`, `printf 'go test ./...'`) is NOT flagged. Real
  // unquoted heavy commands survive neutralization and still match.
  const forPatterns = neutralizeQuotedContents(segment);
  for (const re of HEAVY_PATTERNS) {
    if (re.test(forPatterns)) return true;
  }
  return false;
}

// Extract nested command strings hidden inside a segment so they are evaluated
// too (the original splitter treats $(...) / backticks as plain boundaries and
// never inspects their CONTENTS, and never unwraps `bash -c '...'` payloads).
//   (a) command substitution: $( ... ) and ` ... ` -> the inner command text.
//   (b) shell -c payloads: when the effective verb is bash/sh/zsh/dash and a
//       -c flag is present, the QUOTED argument after -c is itself command(s).
// Returns an array of inner command strings (possibly empty). Quote-aware for the
// substitution scan; depth bounding is handled by the recursive caller below.
const SHELL_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

function extractSubstitutions(s) {
  const found = [];
  let i = 0;
  const n = s.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = s[i];
    const c2 = i + 1 < n ? s[i + 1] : '';
    // Single quotes suppress $(...) but NOT — by POSIX — they also suppress
    // backticks; inside single quotes nothing expands, so skip the whole span.
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (!inDouble && c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = !inDouble; i++; continue; }
    // $( ... ) — balance nested parens so $(echo $(date)) is captured whole.
    if (c === '$' && c2 === '(') {
      let depth = 1; let j = i + 2; let inner = '';
      while (j < n && depth > 0) {
        const cj = s[j];
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        inner += cj; j++;
      }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    // ` ... ` backtick command substitution (active inside double quotes too).
    if (c === '`') {
      let j = i + 1; let inner = '';
      while (j < n && s[j] !== '`') { inner += s[j]; j++; }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

// If a segment is `bash -c '<payload>'` (or sh/zsh/dash -c "..."), return the
// unquoted payload command string, else ''. Best-effort tokenization.
function extractShellCPayload(segment) {
  const verb = effectiveVerb(segment);
  if (!verb || !SHELL_VERBS.has(verb)) return '';
  // Tokenize respecting quotes so the payload (which contains spaces) stays whole.
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  // Find the -c flag; the NEXT token is the command payload.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c' || t === '--command') {
      return i + 1 < tokens.length ? tokens[i + 1] : '';
    }
    // Bundled short flags like -lc / -xc also carry a payload in the next token.
    if (/^-[a-z]*c$/.test(t)) {
      return i + 1 < tokens.length ? tokens[i + 1] : '';
    }
  }
  return '';
}

// If a segment is `eval <payload>`, return the payload as a COMMAND string to be
// re-parsed (NOT treated as a quoted data literal). `eval` runs its argument(s)
// as a shell command, so heavy commands can hide behind it (`eval "npm test"`,
// `eval npm test`). We collect every token AFTER the `eval` verb, honoring quotes
// so a quoted multi-word payload (`eval "npm run build"`) stays a single command
// string, and join them with spaces. The quote delimiters are stripped so the
// payload is the COMMAND text itself — this is what makes `eval "npm test"` parse
// as `npm test` (heavy) rather than a benign quoted data arg. Returns '' if the
// effective verb is not `eval` or there is no payload. Best-effort tokenization,
// mirroring extractShellCPayload.
function extractEvalPayload(segment) {
  const verb = effectiveVerb(segment);
  if (verb !== 'eval') return '';
  // Tokenize respecting quotes; strip quote delimiters so the payload is raw cmd.
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  // Drop everything up to and including the `eval` verb token (basename-aware:
  // a path like /usr/bin/eval still resolves to eval). Leading wrapper/assignment
  // prefixes are already accounted for because effectiveVerb confirmed `eval`.
  let idx = 0;
  while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== 'eval') idx++;
  idx++; // skip the eval token itself
  const payloadTokens = tokens.slice(idx).filter(t => t.length);
  return payloadTokens.join(' ');
}

// A command is heavy if ANY of its segments is heavy. This fixes the core bug:
// the old code only inspected the first verb of the whole unsegmented string and
// short-circuited LIGHT_EXCEPTIONS on the whole string, so `cd app && npm test`,
// `git status && npm run build`, and `FOO=1 docker build .` all bypassed.
//
// RECURSION: also evaluates commands hidden in command substitution `$(...)` /
// backticks and in `bash -c '...'` payloads, so `echo "$(npm run build)"` and
// `bash -c "npm run build"` are caught. Depth-bounded to avoid pathological input.
function isHeavyCommand(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    if (isHeavySegment(seg)) return true;
    if (d < 3) {
      // (b) shell -c payload: unwrap and evaluate as command(s).
      const payload = extractShellCPayload(seg);
      if (payload && isHeavyCommand(payload, d + 1)) return true;
      // (c) eval payload: unwrap eval's argument(s) and evaluate as command(s).
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload && isHeavyCommand(evalPayload, d + 1)) return true;
    }
  }
  // (a) command substitution: scan the WHOLE command (substitutions can span
  // segment boundaries / quotes) and recurse into each captured inner command.
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      if (isHeavyCommand(inner, d + 1)) return true;
    }
  }
  return false;
}

// Produce a SAFE classification label for the block reason — describes WHY the
// command was flagged WITHOUT reflecting any arbitrary user/command text back into
// the model-visible reason (injection hygiene). Returns either a detected heavy
// verb drawn from the fixed HEAVY_VERBS allowlist, or a fixed category name.
// Every returned value is from a closed, code-defined set — never raw input.
function classifyHeavy(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    if (isHeavySegment(seg)) {
      const verb = effectiveVerb(seg);
      if (verb && HEAVY_VERBS.has(verb)) return { kind: 'verb', label: verb };
      return { kind: 'category', label: 'heavy-pattern' };
    }
    if (d < 3) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = classifyHeavy(payload, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = classifyHeavy(evalPayload, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const c = classifyHeavy(inner, d + 1);
      if (c) return c;
    }
  }
  return null;
}

function main() {
  // Read + parse the payload FIRST — coordinator/subagent detection needs the
  // payload's agent_id/agent_type markers (the only reliable signal under cmux).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('command-guard')) process.exit(0);
  const { isCoordinator } = require('./coordinator-detect.js');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  // Only block in coordinator context (subagents pass through).
  if (!isCoordinator(payload)) {
    process.exit(0);
  }

  const command = (payload && payload.tool_input && payload.tool_input.command) || '';

  if (!isHeavyCommand(command)) {
    process.exit(0);
  }

  // Classification label is derived from a closed, code-defined set (heavy verb
  // allowlist or a fixed category name) — NEVER raw command/stdin text — so no
  // attacker-controlled content is reflected into the model-visible reason.
  const cls = classifyHeavy(command);
  const detail = cls
    ? (cls.kind === 'verb'
        ? '(verb: ' + cls.label + ')'
        : '(category: ' + cls.label + ')')
    : '(category: heavy)';

  const reason =
    'COMMAND-DELEGATION RULE: heavy/long/state-changing commands must NEVER run ' +
    'inline in the main coordinator context — they fill the main thread with raw ' +
    'output and the most counterproductive thing a coordinator can do. ' +
    'DELEGATE to a subagent (cheap model: Haiku or similar): ' +
    'spawn a subagent, pass the command, let it run and return only a tight ' +
    'summary. The coordinator synthesizes the summary; raw output never reaches ' +
    'the main thread. Heavy command detected ' + detail +
    ' — delegate to a subagent.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);
