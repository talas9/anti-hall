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
const os = require('os');
const path = require('path');

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
  // anti-hall's own DevSwarm CLI wrapper (scripts/devswarm.js). It is THE
  // structured interface the guard steers users toward (CLI over MCP), so the
  // generic `node <file>.js` HEAVY_PATTERN blocking its own wrapper is the exact
  // catch-22 called out in PLAN.md "Phase 2 — scope corrections". Same NARROW,
  // anchored discipline as the phase.js / agent-watchdog.js carve-outs above:
  // matches ONLY `scripts/devswarm.js` with the parent dir segment anchored at a
  // token start or path separator (so `evilscripts/devswarm.js` is NOT exempt),
  // both `/` and `\` separators for Windows parity.
  // CONFIRMED GENERALIZED (v0.58 PLAN.md "GUARD CONTRACT" EXEMPTION note): this
  // regex has no subcommand restriction — it exempts the WHOLE `node .../scripts/
  // devswarm.js ...` invocation regardless of verb, so every mesh coordination
  // command (`send`, `heartbeat`, `roster`, `mesh`, `inbox`, `archive-request`,
  // `reconcile`, `spawn`, `merge`) already runs inline, exempt from the heavy-
  // command gate, with no further change needed here.
  /\bnode\s+(?:\S*[\\/])?scripts[\\/]devswarm\.js\b/i,
];

// DevSwarm destructive-read redirect: the two CONSUMING native hivecontrol inbox
// reads — `hivecontrol workspace read-messages` (mark-reads / drains the native
// message queue) and `hivecontrol workspace monitor` (a blocking long-poll that
// also consumes the queue). Non-destructive subcommands (message-count,
// message-parent, message-child) and any other subcommand are NOT matched
// (default-allow). Optional flag tokens are tolerated on both sides so
// `hivecontrol --json workspace read-messages` / `hivecontrol workspace --foo
// monitor` cannot slip past by flag insertion. Under DevSwarm BOTH block
// UNCONDITIONALLY (Part B): `read-messages` no longer requires durable-layer
// evidence — a raw native read desyncs the durable cursor regardless, so it blocks
// like `monitor`. Kept as TWO regexes so the block reason can name the specific
// destructive subcommand (see buildDevswarmReason).
const HIVECTL_MONITOR =
  /\bhivecontrol\s+(?:-\S+\s+)*workspace\s+(?:-\S+\s+)*monitor\b/i;
const HIVECTL_READ_MESSAGES =
  /\bhivecontrol\s+(?:-\S+\s+)*workspace\s+(?:-\S+\s+)*read-messages\b/i;

// v0.58 "mesh-only messaging" (PLAN.md GUARD CONTRACT): the two native SEND
// subcommands — `hivecontrol workspace message-child` / `message-parent` — are
// REPLACED by anti-hall's shared mesh store (scripts/devswarm.js send/heartbeat).
// Modeled EXACTLY on HIVECTL_MONITOR/HIVECTL_READ_MESSAGES above (same optional-
// flag tolerance so `hivecontrol --json workspace message-parent` cannot slip
// past by flag insertion). Deliberately does NOT match `message-count` (a
// read-only counter — distinct literal subcommand, never blocked) or any
// lifecycle verb (`create`/`list`/`check-merge`/`merge`) — those are unmatched
// by construction (different literal text) and stay default-allow, so
// `devswarm.js spawn`/`merge` (THIN wraps of hivecontrol create/check-merge/
// merge) keep working.
const HIVECTL_MESSAGE_CHILD =
  /\bhivecontrol\s+(?:-\S+\s+)*workspace\s+(?:-\S+\s+)*message-child\b/i;
const HIVECTL_MESSAGE_PARENT =
  /\bhivecontrol\s+(?:-\S+\s+)*workspace\s+(?:-\S+\s+)*message-parent\b/i;

// detectHivectlDestructiveRead(command, depth) -> 'monitor' | 'read-messages' | null.
// Mirrors isHeavyCommand's matching discipline so DATA and CODE are separated the
// same way the heavy path does it: the per-segment regex test runs against the
// DEQUOTED segment — dequoteSegment(seg), the SHELL-EFFECTIVE argv text — so a
// quoted subcommand or verb (`hivecontrol workspace "monitor"`, `"hivecontrol"
// workspace monitor`, a mid-token split `mes"sage-par"ent`) matches IDENTICALLY
// to its unquoted form, because that is what the shell actually executes: quoting
// a bareword does not change argv. (FIXED P0: this previously ran against
// neutralizeQuotedContents(seg), which BLANKS quoted content instead of
// dequoting it — that made every quoted variant of a blocked subcommand
// invisible to the regex, a live-verified bypass of the single-consumer
// invariant.) Quoted DATA passed to an unrelated verb still safely ALLOWS:
// `grep 'hivecontrol workspace read-messages' f` / `echo "...monitor..."`
// dequote to `grep hivecontrol workspace read-messages f` / `echo ...monitor...`,
// but COMMAND-POSITION ANCHORING below reads the FIRST token as `grep`/`echo`,
// not `hivecontrol`, so they still do NOT match. `bash -c "..."`, `eval ...`,
// `$(...)` and backtick payloads ARE unwrapped and recursed (so a smuggled
// `bash -c "hivecontrol workspace read-messages"` / `$(hivecontrol workspace
// monitor)` STILL matches). `monitor` wins over `read-messages` when both
// appear, because monitor blocks unconditionally.
function detectHivectlDestructiveRead(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  let sawReadMessages = false;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    // COMMAND-POSITION ANCHORING: only treat `hivecontrol` as the destructive verb
    // when it is actually THIS segment's command verb (mirrors the heavy path's
    // effectiveVerb discipline — basename + wrapper/assignment skipping), not merely
    // a word that happens to appear somewhere in the args. This drops the
    // false-positive where unquoted data args are literally these words in order —
    // `grep hivecontrol workspace monitor docs/KB.md`, `echo hivecontrol workspace
    // monitor` — which have verb `grep`/`echo`, not `hivecontrol`, so they ALLOW.
    // Smuggling is UNAFFECTED: `bash -c "..."`, `$(...)`, backtick, `eval`, and
    // chained (`a && hivecontrol ...`) forms each put hivecontrol at verb position
    // inside a recursively-extracted payload / its own segment, and a path- or
    // flag-prefixed form (`/usr/bin/hivecontrol workspace monitor`,
    // `sudo hivecontrol ...`) still resolves to `hivecontrol` via effectiveVerb —
    // now checked against the DEQUOTED segment (effectiveVerb(dequoted)) so a
    // quoted verb (`"hivecontrol" workspace monitor`) anchors correctly too.
    //
    // ACCEPTED LIMITATION (drift-guard threat model, NOT an adversary defense):
    // dequoting only recovers quote-delimited obfuscation. Forms that only
    // synthesize the verb/subcommand via shell PARAMETER or COMMAND expansion are
    // still NOT caught — `mon${X:-itor}`, `mon$(printf itor)`. Catching those
    // would need a full shell-expansion simulation, which is out of scope: this
    // guard prevents ACCIDENTAL and quote-obfuscated destructive reads, not a
    // determined shell-expansion bypass. Tests document these as knowingly-allowed.
    if (effectiveVerb(dequoted) === 'hivecontrol') {
      if (HIVECTL_MONITOR.test(dequoted)) return 'monitor';
      if (HIVECTL_READ_MESSAGES.test(dequoted)) sawReadMessages = true;
    }
    if (d < 3) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectHivectlDestructiveRead(payload, d + 1);
        if (inner === 'monitor') return 'monitor';
        if (inner === 'read-messages') sawReadMessages = true;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectHivectlDestructiveRead(evalPayload, d + 1);
        if (inner === 'monitor') return 'monitor';
        if (inner === 'read-messages') sawReadMessages = true;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectHivectlDestructiveRead(inner, d + 1);
      if (r === 'monitor') return 'monitor';
      if (r === 'read-messages') sawReadMessages = true;
    }
  }
  return sawReadMessages ? 'read-messages' : null;
}

// detectHivectlMessageSend(command, depth) -> 'message-child' | 'message-parent' | null.
// Mirrors detectHivectlDestructiveRead's matching discipline byte-for-byte: the
// per-segment regex test runs against the DEQUOTED segment — dequoteSegment(seg),
// the SHELL-EFFECTIVE argv text — so a quoted subcommand or verb
// (`hivecontrol workspace "message-parent"`, `"hivecontrol" workspace
// message-parent`, a mid-token split `mes"sage-par"ent`) matches IDENTICALLY to
// its unquoted form, because quoting a bareword does not change argv. (FIXED
// P0: this previously ran against neutralizeQuotedContents(seg), which BLANKS
// quoted content instead of dequoting it — a live-verified bypass of v0.58's
// mesh-only-messaging invariant, since the guard's own block reason echoes the
// blocked subcommand back, making "just quote it" the natural retry.) Quoted
// DATA passed to an unrelated verb still safely ALLOWS: `grep 'hivecontrol
// workspace message-parent' docs/KB.md` / `echo "...message-child..."` dequote
// to `grep hivecontrol workspace message-parent docs/KB.md` / `echo
// ...message-child...`, but COMMAND-POSITION ANCHORING below reads the FIRST
// token as `grep`/`echo`, not `hivecontrol`, so they still do NOT match.
// `bash -c "..."`, `eval ...`, `$(...)` and backtick payloads ARE unwrapped and
// recursed (a smuggled `bash -c "hivecontrol workspace message-parent ..."` /
// `$(hivecontrol workspace message-child ...)` STILL matches).
// COMMAND-POSITION ANCHORING via effectiveVerb(dequoted) === 'hivecontrol' (the
// same false-positive protection as the destructive-read detector, now also
// dequoted so a quoted verb anchors correctly). message-child is checked first
// (arbitrary tie-break; both matching one command is not a realistic shape) —
// MUST match ONLY its own literal subcommand, never `message-count`/`create`/
// `list`/`check-merge`/`merge`.
function detectHivectlMessageSend(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    if (effectiveVerb(dequoted) === 'hivecontrol') {
      if (HIVECTL_MESSAGE_CHILD.test(dequoted)) return 'message-child';
      if (HIVECTL_MESSAGE_PARENT.test(dequoted)) return 'message-parent';
    }
    if (d < 3) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectHivectlMessageSend(payload, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectHivectlMessageSend(evalPayload, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectHivectlMessageSend(inner, d + 1);
      if (r) return r;
    }
  }
  return null;
}

// buildDevswarmSendReason(kind) -> closed-vocabulary block reason (NEVER reflects
// command/stdin text — injection hygiene). Redirects to the mesh CLI verbs from
// PLAN.md's CLI VERB CONTRACT: `send --to-primary|--to <meshId>` to direct-
// message, `heartbeat <id> --summary "<text>"` to report status.
function buildDevswarmSendReason(kind) {
  const killSwitch = ' To disable this guard entirely, set DISABLE_ANTIHALL_DEVSWARM=1.';
  return 'DEVSWARM MESH-ONLY MESSAGING: `hivecontrol workspace ' + kind + '` is blocked. ' +
    'anti-hall\'s shared mesh store is the SOLE agent-initiated messaging transport for ' +
    'DevSwarm — native per-worktree messaging (no from/to/broadcast) is replaced. Do NOT ' +
    'delegate this to a subagent either — a delegated send writes the native queue ' +
    'identically. Use the anti-hall DevSwarm CLI instead: `node scripts/devswarm.js send ' +
    '--to-primary --message "<text>"` (or `--to <meshId>`) to direct-message, or `node ' +
    'scripts/devswarm.js heartbeat <id> --summary "<text>"` to report status.' + killSwitch;
}

// File-read verbs whose path ARGUMENTS must be classified against the DevSwarm
// inbox/store taxonomy. cat/head/tail/less/more/od/xxd/strings/nl take file args
// directly; grep/sed/awk take a file arg after their pattern/script.
const FILE_READ_VERBS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'od', 'xxd', 'strings', 'nl',
  'grep', 'sed', 'awk',
]);

// Verbs whose FIRST non-flag operand is a PATTERN/script, not a path — it must
// never be classified as a file argument even when it is quoted and its text
// happens to look like (or literally BE) a real path. Only operands AFTER the
// pattern/script are candidate file paths for these verbs. cat/head/tail/etc.
// are NOT in this set — every one of their non-flag operands is a path.
const PATTERN_FIRST_VERBS = new Set(['grep', 'sed', 'awk']);

// Tokenize a segment respecting single/double quotes, STRIPPING the quote
// delimiters but PRESERVING their contents (unlike neutralizeQuotedContents,
// which blanks quoted content out for pattern matching). This recovers the
// real text of a quoted argument — `cat "…/inbox/x"` yields the token
// `…/inbox/x`, identical to the unquoted form — so a quoted path argument is
// visible to detectProtectedFileRead's classifier instead of disappearing.
// Mirrors the quote-handling already used by extractShellCPayload/
// extractEvalPayload (best-effort tokenization; no backslash-escape support,
// consistent with those siblings).
function tokenizeQuoted(segment) {
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
  return tokens;
}

// dequoteSegment(segment) -> the SHELL-EFFECTIVE argv text: quote delimiters
// stripped, quoted/unquoted fragments WITHIN one token concatenated (via
// tokenizeQuoted), tokens rejoined with single spaces. Models what the shell
// actually passes as argv — quoting a bareword does NOT change argv, the shell
// executes it identically — so `"hivecontrol"`, `'message-parent'`, and
// `mes"sage-par"ent` all dequote to the same literal text as their unquoted
// form (`hivecontrol`, `message-parent`). Used (instead of
// neutralizeQuotedContents, which BLANKS quoted content and was the source of
// a live-verified P0 bypass — quoting a subcommand or the verb made the
// hivectl guards below miss it entirely) so verb-anchoring and subcommand
// matching run against the same text the shell would. Quoted DATA passed to
// an unrelated verb stays safe: `grep -n "hivecontrol workspace
// message-parent" f` dequotes to `grep -n hivecontrol workspace
// message-parent f`, but the verb-anchoring check below still reads the FIRST
// token as `grep`, not `hivecontrol`, so it still ALLOWS. NOT a shell parser —
// no backslash-escape or parameter/command-substitution support, matching the
// existing best-effort tokenization used throughout this file.
function dequoteSegment(segment) {
  return tokenizeQuoted(segment).join(' ');
}

// detectProtectedFileRead(command, home, cwd, depth) -> 'deny-inbox' | 'deny-store' | null.
// Parallels detectHivectlDestructiveRead: the SAME effectiveVerb command-position
// anchoring (computed on the RAW segment, as effectiveVerb always does), and the
// SAME recursion into bash -c / eval / $()/backtick payloads. For a read verb, its
// path args are recovered via tokenizeQuoted (quote delimiters stripped, content
// kept — so a bare, double-quoted, OR single-quoted path all yield the identical
// path string) and classified via the shared devswarm-inbox-paths module; the
// FIRST arg resolving to a deny path wins.
//   - This does NOT over-block quoted DATA: `echo "…/inbox/x"` never reaches here
//     because echo is not a read verb. For grep/sed/awk (PATTERN_FIRST_VERBS), the
//     first non-flag operand is the PATTERN/script and is SKIPPED — never
//     classified — regardless of quoting or content, so `grep 'inbox' docs/KB.md`
//     and even `grep '<the literal inbox path>' docs/KB.md` stay ALLOW; only a
//     trailing FILE operand (e.g. `grep pattern <realInboxPath>`) can classify deny.
// Fully fail-open: any throw / unavailable classifier -> null (never block).
function detectProtectedFileRead(command, home, cwd, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  let classify;
  try {
    classify = require('./lib/devswarm-inbox-paths.js').classifyDevswarmPath;
  } catch (_) {
    return null; // classifier unavailable -> fail-open
  }
  for (const seg of splitSegments(command)) {
    const verb = effectiveVerb(seg);
    if (verb && FILE_READ_VERBS.has(verb)) {
      const tokens = tokenizeQuoted(seg);
      let idx = 0;
      while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== verb) idx++;
      idx++; // skip the verb token itself
      // grep/sed/awk: the first non-flag operand is a PATTERN/script, not a path —
      // skip it once before classifying any further operands as files.
      let skipNextOperand = PATTERN_FIRST_VERBS.has(verb);
      for (; idx < tokens.length; idx++) {
        const tok = tokens[idx];
        if (!tok || tok.startsWith('-')) continue; // skip flags / empties
        if (skipNextOperand) { skipNextOperand = false; continue; }
        let v = 'allow';
        try { v = classify(tok, home, cwd); } catch (_) { v = 'allow'; }
        if (v === 'deny-inbox' || v === 'deny-store') return v;
      }
    }
    if (d < 3) {
      const payload = extractShellCPayload(seg);
      if (payload) {
        const inner = detectProtectedFileRead(payload, home, cwd, d + 1);
        if (inner) return inner;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const inner = detectProtectedFileRead(evalPayload, home, cwd, d + 1);
        if (inner) return inner;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectProtectedFileRead(inner, home, cwd, d + 1);
      if (r) return r;
    }
  }
  return null;
}

// buildRawFileReadReason(kind) -> closed-vocabulary block reason for a raw shell
// read (cat/head/…) of the inbox/store. Uses the ACCURATE harm model (cursor
// desync + store-layering violation — NOT "drains the queue", which is false for
// the append-only inbox). NEVER echoes the path (injection hygiene).
function buildRawFileReadReason(kind) {
  const killSwitch = ' To disable this guard entirely, set DISABLE_ANTIHALL_DEVSWARM=1.';
  if (kind === 'deny-store') {
    return 'DEVSWARM STORE READ-GUARD: reading the raw DevSwarm store (the SQLite db + ' +
      'sidecars, or the store journal NDJSON) via a shell read is blocked. The store is ' +
      'the write/derive layer — hooks/agents NEVER open it (devswarm-store.js layering); ' +
      'a raw read risks a partial/inconsistent view and a store-layering violation. Read ' +
      'through the wrapper: `devswarm.js inbox read <id>` (or `devswarm.js inbox pull ' +
      '<id>` to import first).' + killSwitch;
  }
  return 'DEVSWARM INBOX READ-GUARD: reading the raw DevSwarm inbox file via a shell ' +
    'read is blocked. This does NOT drain the queue (append-only NDJSON), but a raw read ' +
    'BYPASSES THE DURABLE CURSOR — it causes CURSOR DESYNC (messages re-processed or ' +
    'skipped) and violates the store layering. Read the safe, cursor-tracked way: ' +
    '`devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>`.' + killSwitch;
}

// buildDevswarmReason(kind, env) -> closed-vocabulary block reason. NEVER reflects
// command/stdin text (injection hygiene). Names ANTIHALL_DEVSWARM_INBOX_CMD (the
// var, not its value) as the read path when configured; always includes the
// do-not-delegate line, the wrapper redirect (`devswarm.js inbox pull`/`read`), and
// the DISABLE_ANTIHALL_DEVSWARM=1 kill-switch; for read-messages, states that
// message-count reflects the NATIVE queue only (a 0 there does NOT mean no pending
// messages under a durable inbox). References no wrapper/CLI that does not exist.
function buildDevswarmReason(kind, env) {
  const e = env || process.env;
  const inboxCmd = e.ANTIHALL_DEVSWARM_INBOX_CMD;
  const hasInboxCmd = typeof inboxCmd === 'string' && inboxCmd.trim() !== '';
  const doNotDelegate =
    ' Do NOT delegate this to a subagent either — a delegated read drains the ' +
    'queue identically.';
  const viaDurable = hasInboxCmd
    ? ' Read pending messages via the consumer-configured ANTIHALL_DEVSWARM_INBOX_CMD ' +
      'command instead — it does not drain the native queue.'
    : '';
  const viaWrapper =
    ' Use the anti-hall DevSwarm CLI instead — `devswarm.js inbox pull <id>` then ' +
    '`devswarm.js inbox read <id>` — which reads via the durable cursor.';
  const killSwitch =
    ' To disable the DevSwarm read-guard entirely, set DISABLE_ANTIHALL_DEVSWARM=1.';
  if (kind === 'monitor') {
    return 'DEVSWARM COORDINATOR-READ REDIRECT: `hivecontrol workspace monitor` is ' +
      'a blocking long-poll with no default timeout — running it inline hangs the ' +
      'shell/Bash call until a message arrives or the process is killed, and it ' +
      'consumes the native message queue. Do NOT run it here.' +
      doNotDelegate + viaDurable + viaWrapper + killSwitch;
  }
  return 'DEVSWARM COORDINATOR-READ REDIRECT: `hivecontrol workspace read-messages` ' +
    'is a DESTRUCTIVE read — it mark-reads / drains the native message queue. Under ' +
    'DevSwarm the durable inbox cursor is the read path, so draining the native queue ' +
    'loses messages the durable layer still needs. Do NOT run it here.' +
    doNotDelegate + viaDurable + viaWrapper + killSwitch +
    ' Note: `hivecontrol workspace message-count` reflects the NATIVE queue only; a ' +
    '0 there does NOT mean there are no pending messages when a durable inbox is in use.';
}

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

  const { isSkipped } = require('./skip-guard.js');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const command = (payload && payload.tool_input && payload.tool_input.command) || '';

  // DevSwarm destructive-read redirect branch. DIFFERENT protection goal from the
  // heavy-command gate below (data-loss / shell-hang vs coordinator context-hygiene),
  // so it is evaluated FIRST — in ALL session contexts (coordinator AND subagent: a
  // delegated read drains the queue identically), with its OWN skip name
  // (`devswarm-read-guard`), independent of command-guard's own skip/coordinator gate.
  //   - monitor / read-messages (hivecontrol native reads): block UNCONDITIONALLY
  //     when DevSwarm-active (Part B — read-messages no longer needs durable-layer
  //     evidence; a raw native read desyncs the durable cursor regardless).
  //   - raw file reads (cat/head/… of ~/.anti-hall/devswarm/inbox/** or the store):
  //     the Bash-side companion to inbox-read-guard.js (the Read-tool guard), closing
  //     the `cat` bypass that this Bash-verb-only guard could not otherwise see.
  // Fully fail-open: any throw -> fall through (never block).
  try {
    let devswarmActive = false;
    try {
      devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
    } catch (_) {
      devswarmActive = false; // fail-open: dormant
    }
    if (devswarmActive && !isSkipped('devswarm-read-guard')) {
      // Emit via fs.writeSync(1,…) not process.stdout.write per CLAUDE.md: on macOS
      // node 18/20 a synchronous exit right after process.stdout.write can race the
      // async pipe flush and truncate the JSON; writeSync is atomic.
      const kind = detectHivectlDestructiveRead(command);
      if (kind) {
        const reason = buildDevswarmReason(kind, process.env);
        fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
        process.exit(2);
      }
      const cwd = (payload && payload.cwd) || '';
      const fileKind = detectProtectedFileRead(command, os.homedir(), cwd);
      if (fileKind) {
        const reason = buildRawFileReadReason(fileKind);
        fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
        process.exit(2);
      }
    }
  } catch (_) {
    // fail-open: never block a turn on a devswarm-branch bug.
  }

  // v0.58 "mesh-only messaging" branch: blocks the native `hivecontrol workspace
  // message-child`/`message-parent` SENDS — anti-hall's shared mesh store
  // (scripts/devswarm.js send/heartbeat) is now the SOLE agent-initiated
  // messaging transport for DevSwarm (native per-worktree messaging has no
  // from/to/broadcast and is REPLACED, PLAN.md "Locked design"). Modeled on the
  // devswarm-read-guard branch above: fires in ALL contexts (coordinator AND
  // subagent — a delegated send writes the native queue identically), its OWN
  // skip name (`devswarm-send-guard`, independent of both devswarm-read-guard
  // and command-guard's own skip below), honors DISABLE_ANTIHALL_DEVSWARM.
  // Deliberately does NOT touch message-count (read-only) or any lifecycle verb
  // (create/list/check-merge/merge) — unmatched by the regexes above, so
  // `devswarm.js spawn`/`merge` (THIN wraps of hivecontrol create/check-merge/
  // merge) are unaffected. Fully fail-open: any throw -> fall through.
  try {
    let devswarmActive = false;
    try {
      devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
    } catch (_) {
      devswarmActive = false; // fail-open: dormant
    }
    if (devswarmActive && !isSkipped('devswarm-send-guard')) {
      const sendKind = detectHivectlMessageSend(command);
      if (sendKind) {
        const reason = buildDevswarmSendReason(sendKind);
        fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
        process.exit(2);
      }
    }
  } catch (_) {
    // fail-open: never block a turn on a devswarm-send-guard bug.
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  if (isSkipped('command-guard')) process.exit(0);
  const { isCoordinator } = require('./coordinator-detect.js');

  // Only block heavy commands in coordinator context (subagents pass through).
  if (!isCoordinator(payload)) {
    process.exit(0);
  }

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

  // DevSwarm PRIMARY redirect (lazy-require, fail-open to the baseline wording).
  // The Primary's TOP fan-out tier is a CHILD WORKSPACE, not a subagent
  // (docs/KB-devswarm-hivecontrol.md §8.1-8.2). Naming "spawn a subagent" as the
  // only exit at the exact point the Primary is blocked from running the command
  // is what drove Primaries to decompose feature-scale work into subagents instead
  // of workspaces. NOTHING about WHAT is blocked changes — same isHeavyCommand()
  // decision, same exit 2 — only the redirect text, and only for a Primary. A
  // DevSwarm CHILD, and any non-DevSwarm session, gets the byte-identical baseline
  // reason below. No mechanical scale classifier (a false positive would break
  // legitimate subagent use): the reason states the CHOICE, the model classifies.
  let devswarmPrimary = false;
  try {
    devswarmPrimary =
      require('./lib/devswarm-detect.js').isDevswarmActive(process.env) &&
      !require('./lib/devswarm-role.js').isChildWorkspace(process.env);
  } catch (_) {
    devswarmPrimary = false;
  }

  const reason = devswarmPrimary
    ? ('DEVSWARM COMMAND-DELEGATION RULE: the primary/main orchestrator never runs ' +
       'heavy/long/state-changing commands inline — raw output floods the main thread. ' +
       'CHOOSE THE TIER: if this command belongs to a workspace-scale MATTER (a ' +
       'feature/fix/deploy — multi-step, own branch, own review), spin a CHILD WORKSPACE ' +
       'and let it own the work end-to-end: `node scripts/devswarm.js spawn <branch> ' +
       '-p "<brief>"` (guard-exempt, run it inline). ALTERNATIVE, only for genuinely ' +
       'small/scoped work (one command, a lookup, a scoped check): delegate to a subagent ' +
       '(cheap model: Haiku or similar) that runs it and returns only a tight summary. Do ' +
       'NOT hand a workspace-scale matter to a subagent. Heavy command detected ' + detail +
       ' — spin a workspace, or delegate to a subagent if it is genuinely small.')
    : ('COMMAND-DELEGATION RULE: heavy/long/state-changing commands must NEVER run ' +
       'inline in the main coordinator context — they fill the main thread with raw ' +
       'output and the most counterproductive thing a coordinator can do. ' +
       'DELEGATE to a subagent (cheap model: Haiku or similar): ' +
       'spawn a subagent, pass the command, let it run and return only a tight ' +
       'summary. The coordinator synthesizes the summary; raw output never reaches ' +
       'the main thread. Heavy command detected ' + detail +
       ' — delegate to a subagent.');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);
