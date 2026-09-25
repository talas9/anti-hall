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
const {
  HEREDOC_RE,
  basename,
  parseHeredocAt,
  tokenizeQuoted,
  dequoteSegment,
  extractSubstitutions,
  SHELL_VERBS,
} = require('./lib/shell-scan.js');
// v0.108.0 unified settings (env > ~/.anti-hall/settings.json > default);
// fail-open to `undefined` (never the value that would arm/allow a guard).
function settingsGet(section, key) {
  try { return require('./lib/settings.js').get(section, key); } catch (_) { return undefined; }
}

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

// anchoredAntiHallCli(dir, script, tailSrc) -> RegExp for one of anti-hall's
// own CLI allowlist entries below. Every entry MUST be built through this one
// helper so a future addition can't forget the anchoring discipline that
// bcd0d69 first applied to the defect.js entry alone (a real, shipped bypass:
// the un-anchored `\b`-only form matches ANYWHERE in the segment, so `npm run
// build -- node scripts/devswarm.js list` / `... settings.js show` slipped a
// heavy command through just by mentioning an allowlisted script as trailing
// args).
//
// The produced regex requires the SEGMENT to literally START with (optional
// leading `KEY=val` env assignments, then) `node <path>/<dir>/<script>.js`:
//   - `^\s*` anchors to the segment start (segments are already split on
//     `;`/`&&`/`||`/`|`/newlines by splitSegments before this runs).
//   - `(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` allows leading env assignments
//     only (e.g. `FOO=1 node scripts/defect.js list`), matching the one
//     allowance the pre-existing defect.js anchor already granted.
//   - `node\s+(?:\S*[\\/])?<dir>[\\/]<script>\.js` requires `node` to be the
//     segment's OWN verb (not merely present later in the line), with an
//     optional arbitrary path prefix before `<dir>/<script>.js` (both `/`
//     and `\` accepted for Windows parity), same discipline every pre-
//     existing entry already used for the parent-dir segment.
//   - `tailSrc` is the caller's own subcommand/flag restriction (already
//     regex source, not a literal), appended unchanged right after the
//     script name — e.g. `\s+(?:-\S+\s+)*status\b` for jev-setup.js.
function anchoredAntiHallCli(dir, script, tailSrc) {
  const dirSrc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scriptSrc = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*node\\s+(?:\\S*[\\\\/])?' +
      dirSrc + '[\\\\/]' + scriptSrc + '\\.js' + tailSrc,
    'i'
  );
}

// Commands that look heavy by verb but are actually lightweight inspection commands.
// We allow these even if the verb matches HEAVY_VERBS.
const LIGHT_EXCEPTIONS = [
  // git subcommands that are read-only / instant
  /\bgit\s+(?:status|log|diff|show|branch(?:\s+--list)?|rev-parse|config\s+--get|config\s+--list|worktree\s+list|remote\s+-v|shortlog|stash\s+list|tag\s+-l|describe|ls-remote|ls-tree|merge-base|reflog\s+show)\b/i,
  // git fetch alone only updates local remote-tracking refs/objects — it never
  // touches the working tree or any local branch, so it is read-only from the
  // working-tree's perspective (unlike push/pull, which stay gated below).
  // The actual exemption is isSafeGitFetch() below (P1 fix: a `:` refspec, a
  // leading `+` refspec, or --prune/-p/--prune-tags/--force/-f can rewrite or
  // delete local remote-tracking refs, so a bare `\bgit\s+fetch\b` match here
  // would wrongly exempt those too — checked per-segment in isHeavySegment).
  // npm/node version queries
  /\bnpm\s+(?:--version|-v|view|info|ls)\b/i,
  // `node -e "..."` / `-e '...'` is intentionally NOT blanket-exempted here —
  // its content is classified by isSafeNodeEval() below (write/spawn-API
  // deny-list) instead of a blind quoted-content match, so a write/spawn
  // payload (e.g. `-e "require('fs').writeFileSync(...)"`) is correctly
  // still gated.
  /\bnode\s+(?:--version|-v)\b/i,
  /\bflutter\s+--version\b/i,
  /\bgo\s+version\b/i,
  /\bcargo\s+(?:--version|version)\b/i,
  // go env (read-only) — but NOT `go env -w KEY=VAL` which mutates config.
  /\bgo\s+env\b(?![^\n]*\s-w\b)/i,
  // git push/pull with --dry-run is non-mutating (no refs/objects change).
  /\bgit\s+(?:push|pull)\b[^\n]*\s--dry-run\b/i,
  // docker ps/images/inspect (read-only)
  /\bdocker\s+(?:ps|images|inspect|logs|stats)\b/i,
  // sqlite3 opened with -readonly, and gcloud/gh/kubectl read-only inspection
  // subcommands: the actual exemptions are isSafeSqliteReadonly() and
  // isReadOnlyCloudInspect() below (P1/P2 fix: the old regexes here did a
  // \b-boundary SUBSTRING match, so `-readonly` matched even as a substring
  // of a longer flag and `list`/`get`/`describe`/`view` matched inside a
  // LATER compound word like `list-users` or `get-worker-1` — e.g. `gcloud
  // functions deploy list-users` and `kubectl delete pod get-worker-1` both
  // slipped through as "read-only" even though the real verb was the
  // mutating `deploy`/`delete`. Checked per-segment in isHeavySegment().
  // anti-hall's own read-only CLI subcommands. Each is a NARROW, anchored
  // exemption of one specific script + one specific read-only subcommand set
  // (not the whole script), mirroring the devswarm.js carve-out's anchoring
  // discipline (parent dir segment anchored at token start or path separator,
  // both `/` and `\` accepted) so a look-alike prefix is never exempted.
  //
  // ALL of the entries below are built with anchoredAntiHallCli() (see its
  // doc comment further down this file for why). Every one is ALSO anchored
  // to the START of the segment (optional leading env assignments only):
  // `node` must be the segment's own verb, so a heavy command merely
  // carrying an allowlisted script as trailing args (`npm run build -- node
  // scripts/devswarm.js list`) is never exempted. bcd0d69 anchored only the
  // defect.js entry this way; every entry below now shares that same
  // discipline through the one helper so a future addition can't forget it.
  //   jev-setup.js status        — read-only status report (enable/disable/
  //                                 set-key/test/mode are NOT matched, still gated)
  anchoredAntiHallCli('scripts', 'jev-setup', '\\s+(?:-\\S+\\s+)*status\\b'),
  //   settings.js show|get       — read-only (set/reset are NOT matched)
  anchoredAntiHallCli('scripts', 'settings', '\\s+(?:-\\S+\\s+)*(?:show|get)\\b'),
  //   jev-report.js (default)    — read-only report/scorecard UNLESS its first
  //                                 positional argument is the mutating `label`
  //                                 or `prune-audit` subcommand (negative lookahead)
  anchoredAntiHallCli('scripts', 'jev-report', '\\b(?![^\\n]*\\b(?:label|prune-audit)\\b)'),
  //   defect.js report|list|show|recurring|similar — anti-hall's own
  //   defect-report CLI (see scripts/defect.js). ONLY these subcommands are
  //   exempt: `report` appends one line to a defect file (never
  //   rewrites/deletes); `list`/`show` and the bug-history reads
  //   `recurring`/`similar` are pure reads (the root-cause skill tells the
  //   main thread to run `similar` before an anti-hall fix). Deliberately
  //   NARROWER than this: `rule` (maintainer ruling), `archive` (rotation
  //   sweep — MOVES files between directories) and `backfill` (writes
  //   history records) are NOT matched here, so they stay gated like every
  //   other mutating command.
  anchoredAntiHallCli('scripts', 'defect', '\\s+(?:-\\S+\\s+)*(?:report|list|show|recurring|similar)\\b'),
  // hooks/doctor.js: read-only diagnostics by default — --repair/--fix (and the
  // explicit opt-in repair flags, including --reclaim-ingest-lock, which forces
  // a stale-lock takeover — a mutating action) switch it to a mutating repair
  // pass, so any of those flags anywhere on the line disqualifies the exemption.
  anchoredAntiHallCli('hooks', 'doctor', '\\b(?![^\\n]*--(?:repair|fix|repair-ingest-orphans|repair-test-stores|reclaim-ingest-lock)\\b)'),
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
  anchoredAntiHallCli('statusline', 'phase', '\\b'),
  anchoredAntiHallCli('hooks', 'agent-watchdog', '\\b'),
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
  anchoredAntiHallCli('scripts', 'devswarm', '\\b'),
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
// DEVSWARM_CLI_VERBS: `devswarm` is the PRIMARY DevSwarm CLI binary name;
// `hivecontrol` is a thin sh shim that `exec`s the SAME sibling `devswarm`
// binary (both ship on PATH as the identical program). Every regex/verb-check
// below that reasons about "the DevSwarm CLI verb" MUST treat both names as
// equivalent, or the guard is trivially bypassed by typing the other name —
// this is exactly the confirmed bypass this block fixes (`devswarm workspace
// monitor`/`read-messages`/`message-child`/`message-parent` sailed through
// while the byte-identical `hivecontrol` form correctly blocked). ONE shared
// alternation fragment feeds all four regexes AND the two effectiveVerb
// equality checks below so the names can never drift apart again.
const DEVSWARM_CLI_VERBS = new Set(['hivecontrol', 'devswarm']);
const DEVSWARM_CLI_VERB_ALT = '(?:hivecontrol|devswarm)';
const HIVECTL_MONITOR =
  new RegExp('\\b' + DEVSWARM_CLI_VERB_ALT + '\\s+(?:-\\S+\\s+)*workspace\\s+(?:-\\S+\\s+)*monitor\\b', 'i');
const HIVECTL_READ_MESSAGES =
  new RegExp('\\b' + DEVSWARM_CLI_VERB_ALT + '\\s+(?:-\\S+\\s+)*workspace\\s+(?:-\\S+\\s+)*read-messages\\b', 'i');

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
  new RegExp('\\b' + DEVSWARM_CLI_VERB_ALT + '\\s+(?:-\\S+\\s+)*workspace\\s+(?:-\\S+\\s+)*message-child\\b', 'i');
const HIVECTL_MESSAGE_PARENT =
  new RegExp('\\b' + DEVSWARM_CLI_VERB_ALT + '\\s+(?:-\\S+\\s+)*workspace\\s+(?:-\\S+\\s+)*message-parent\\b', 'i');

// hivectlSegmentHasHelpFlag(seg) -> true iff this SEGMENT's argv (tokenized the
// same quote-aware way as every other token scan in this file — tokenizeQuoted,
// shared with git-guard.js via ./lib/shell-scan.js) contains a bare `--help` or
// `-h` token. A read-only `--help`/`-h` invocation of a gated hivecontrol/devswarm
// subcommand (`hivecontrol workspace read-messages --help`, `... monitor -h`,
// `... message-child --help`) never touches the mailbox/mesh — it just prints
// usage and exits — so it is not the destructive-read / native-send action this
// guard exists to stop. Checked PER SEGMENT (splitSegments already isolates
// shell-chained commands: `;`, `&&`, `||`, `|`, newlines), so a smuggled
// `hivecontrol workspace message-child --help ; hivecontrol workspace
// message-child x` still blocks on its SECOND segment, which carries no
// --help/-h token of its own. Token-exact match only (`--help`/`-h` as their
// own argv word) — a token that merely CONTAINS "help" as a substring
// (`--help-me`, a file literally named `-h`) does not count, mirroring how a
// real arg parser distinguishes a flag from an arbitrary operand.
function hivectlSegmentHasHelpFlag(seg) {
  const tokens = tokenizeQuoted(seg);
  return tokens.some((t) => t === '--help' || t === '-h');
}

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
    if (DEVSWARM_CLI_VERBS.has(effectiveVerb(dequoted)) && !hivectlSegmentHasHelpFlag(seg)) {
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
    if (DEVSWARM_CLI_VERBS.has(effectiveVerb(dequoted)) && !hivectlSegmentHasHelpFlag(seg)) {
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

// devswarm-subagent-mailbox-guard: defect f0958b13fe2b (P0, field-measured by
// SkyCrew 2026-09-08). Inside a DevSwarm child workspace, the child's OWN
// subagents ran `node .../scripts/devswarm.js inbox pull <id> && ... inbox
// ack <id>` — 155 executions across 120 subagent transcripts in one
// workspace. Each ack ADVANCES THE SHARED CURSOR, so the workspace's own MAIN
// THREAD silently missed mail it never got to read. Brief-level prohibitions
// ("subagents must not touch the mailbox") were proven NON-MITIGATING in the
// field — only a mechanical guard closes it.
//
// Matches the devswarm.js CLI (any path prefix — dev clone, marketplace
// cache, absolute path — with or without a `node` prefix; same anchored
// `scripts[\\/]devswarm\.js` suffix EXEMPT_PATTERNS already uses above, so it
// resolves identically) invoking a CURSOR-ADVANCING / MAILBOX-CONSUMING verb
// (per scripts/devswarm.js's own cmdInbox ~line 8134-8180, cmdHeartbeat,
// cmdMeshRead ~line 12332, and reap-orphans's cursor writes ~line 13396):
//   inbox pull | inbox ack | inbox read | inbox read-primary | inbox tick
//   heartbeat (top-level) | reap-orphans (top-level, writes cursors on reap)
//   inbox messages ... --ack | --ack-as-owner (P0 Wave R3 fix: the DOCUMENTED
//     expansion of read-primary — SKILL.md — DOES write the cursor via
//     cmdInboxMessagesInner's doAck path, ~line 7521-7522; NOT the same as
//     the safe, non-acking `inbox messages` this guard otherwise allows)
//   mesh read (WITHOUT --peek/--seq — ~line 12332 advances the broadcast
//     cursor by default; `--peek`/`--seq N` are the documented non-mutating
//     forms and stay allowed)
//   roster --ack (an ALIAS of `mesh read`, D23 — scripts/devswarm.js's own
//     `case 'roster'` dispatches to cmdMeshRead when `--ack` is present;
//     plain `roster` with no `--ack` is a pure read-only projection)
//   register | archive (top-level; Wave R3 P2, R4 Critic: both advance
//     cursors through foldGroupIntoSurvivor ~line 2654, invoked from
//     retireWorktreeDuplicates ~2562 and retireArchivedWorktreeGroup ~3350 —
//     a subagent never legitimately registers or archives a workspace, that
//     is a main-thread/coordinator lifecycle action. `register-primary` and
//     `archive-request`/`archive-ignore`/`archive-unignore`/`unarchive` are
//     SEPARATE verbs, deliberately unaffected.)
// Deliberately ALLOWS (verified against scripts/devswarm.js: does NOT advance
// the durable cursor):
//   inbox count, inbox messages (incl. --tail, WITHOUT --ack/--ack-as-owner —
//   non-acking per cmdInbox's own `sub !== 'messages'` window-rejection
//   guard), inbox peek-primary (opts `{ ack: false, unread: true }` at
//   cmdInbox ~line 8165 — a non-mutating view by design, its own error text
//   at ~line 7101 recommends it FOR this exact purpose), mesh read --peek /
//   --seq N, plain roster (no --ack), send, register-primary,
//   archive-request/archive-ignore/archive-unignore/unarchive,
//   workspaces/gate/etc (unmatched by construction).
//
// NOTE: an earlier draft of this defect's brief also named a `drain` verb —
// scripts/devswarm.js has NO such verb (confirmed: no `case 'drain'`
// anywhere in the file); not matched here since it does not exist.
//
// Fires whenever the payload shows SUBAGENT context via PAYLOAD MARKERS ONLY
// (isSubagentByPayload(payload) — coordinator-detect.js; Wave R3 P2 fix: the
// general-purpose isSubagent()'s CLAUDE_CODE_ENTRYPOINT=agent_tool env
// fallback is deliberately NOT used here — a DevSwarm child workspace's env
// is inherited by its entire process tree, so a leaked agent_tool value from
// how the CHILD SESSION ITSELF was originally spawned would otherwise
// misclassify that workspace's own main-thread cron tick / Monitor wake as a
// subagent forever, blocking it from its own mailbox), REGARDLESS of
// DevSwarm-active/child-workspace status: an accidental subagent
// mailbox-touch is wrong even outside a recognized child workspace (it may
// be running against the PARENT's own registry). Modeled on
// devswarm-read-guard/devswarm-send-guard above: its OWN skip name
// (`devswarm-subagent-mailbox-guard`), independent of command-guard's own
// skip/coordinator gate below, PLUS a dedicated env override
// (`ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1`) for a deliberate one-off.
// Fully fail-open: any throw -> fall through (never block on a guard bug).
//
// Codex parity: this guard is registered via the SHARED command-guard.js in
// codex/hooks/hooks.json — no separate Codex code path. Its DENY behavior
// depends on the harness actually supplying subagent markers (agent_id/
// agent_type) in the hook payload; this has been VERIFIED ON CLAUDE CODE
// ONLY. A grep of plugins/anti-hall/codex for agent_id/agent_type returns 0
// hits (codex/README.md:48 confirms no such payload-marker mapping exists
// there), so whether Codex's harness populates these fields the same way is
// UNVERIFIED — the guard is registered either way (fail-open if the markers
// are simply absent, same as any other unmatched context), but its blocking
// behavior for Codex subagents specifically has not been demonstrated.
//
// FLAG_SKIP_SRC allows an optional non-flag VALUE after each flag (Wave R3
// P2 fix, Reviewer 1: the prior `(?:-\S+\s+)*` skipped only bare flags, so a
// valued flag BEFORE the verb — `--session X inbox ack Y` — broke the match
// entirely at "X" and silently bypassed the guard; this consumes the
// optional value too).
const FLAG_SKIP_SRC = '(?:-\\S+(?:\\s+[^-\\s]\\S*)?\\s+)*';
const DEVSWARM_JS_PREFIX_SRC = '(?:node\\s+)?(?:\\S*[\\\\/])?scripts[\\\\/]devswarm\\.js';

// register/archive (Wave R3 P2, R4 Critic): both advance cursors through
// foldGroupIntoSurvivor (scripts/devswarm.js ~2654, invoked from
// retireWorktreeDuplicates ~2562 and retireArchivedWorktreeGroup ~3350) — a
// subagent never legitimately registers or archives a workspace, that is a
// main-thread/coordinator lifecycle action. Negative lookahead `(?!-)`
// excludes the SEPARATE, allowed lifecycle verbs `register-primary` and
// `archive-request`/`archive-ignore`/`archive-unignore`/`unarchive` (the
// leading `\b` this alternation is embedded under already excludes
// `unarchive`'s mid-word "archive" substring — no boundary exists between
// "un" and "archive").
const MAILBOX_VERB_ALT = '(?:inbox\\s+' + FLAG_SKIP_SRC
  + '(?:pull|ack|read-primary|drain-primary-legacy|read|tick)\\b|heartbeat\\b|reap-orphans\\b|register(?!-)\\b|archive(?!-)\\b)';
const DEVSWARM_JS_MAILBOX_RE = new RegExp(
  '\\b' + DEVSWARM_JS_PREFIX_SRC + '\\s+' + FLAG_SKIP_SRC + MAILBOX_VERB_ALT,
  'i'
);

// inbox messages + --ack/--ack-as-owner: TWO-PART detection (base-verb match
// AND a flag scan across the whole segment) because the flag can legally
// appear before OR after the target id / other flags.
const DEVSWARM_JS_INBOX_MESSAGES_RE = new RegExp(
  '\\b' + DEVSWARM_JS_PREFIX_SRC + '\\s+' + FLAG_SKIP_SRC + 'inbox\\s+' + FLAG_SKIP_SRC + 'messages\\b',
  'i'
);
const ACK_FLAG_RE = /--ack-as-owner\b|--ack\b/i;

// mesh read WITHOUT --peek/--seq. Two-part for the same reason as above.
const DEVSWARM_JS_MESH_READ_RE = new RegExp(
  '\\b' + DEVSWARM_JS_PREFIX_SRC + '\\s+' + FLAG_SKIP_SRC + 'mesh\\s+' + FLAG_SKIP_SRC + 'read\\b',
  'i'
);
const MESH_READ_SAFE_FLAG_RE = /--peek\b|--seq\b/i;

// roster --ack (mesh-read alias, D23). Two-part: base verb + flag scan.
const DEVSWARM_JS_ROSTER_RE = new RegExp(
  '\\b' + DEVSWARM_JS_PREFIX_SRC + '\\s+' + FLAG_SKIP_SRC + 'roster\\b',
  'i'
);
const ROSTER_ACK_FLAG_RE = /--ack\b/i;

function mailboxTouchInSegment(dequoted) {
  if (DEVSWARM_JS_MAILBOX_RE.test(dequoted)) return true;
  if (DEVSWARM_JS_INBOX_MESSAGES_RE.test(dequoted) && ACK_FLAG_RE.test(dequoted)) return true;
  if (DEVSWARM_JS_MESH_READ_RE.test(dequoted) && !MESH_READ_SAFE_FLAG_RE.test(dequoted)) return true;
  if (DEVSWARM_JS_ROSTER_RE.test(dequoted) && ROSTER_ACK_FLAG_RE.test(dequoted)) return true;
  return false;
}

function detectSubagentMailboxTouch(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const dequoted = dequoteSegment(seg);
    if (mailboxTouchInSegment(dequoted)) return true;
    if (d < 3) {
      const payload = extractShellCPayload(seg);
      if (payload && detectSubagentMailboxTouch(payload, d + 1)) return true;
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload && detectSubagentMailboxTouch(evalPayload, d + 1)) return true;
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      if (detectSubagentMailboxTouch(inner, d + 1)) return true;
    }
  }
  return false;
}
function buildSubagentMailboxReason() {
  return 'DEVSWARM SUBAGENT MAILBOX GUARD: this Bash command invokes the DevSwarm mailbox ' +
    '(inbox pull/ack/ack-primary/read/read-primary/drain-primary-legacy/tick, inbox messages --ack, mesh read, roster --ack, ' +
    'reap-orphans, register, archive, or heartbeat) from SUBAGENT context. Only the workspace MAIN THREAD may own ' +
    'the mailbox — a subagent that acks/reads it advances the shared cursor, so the main thread ' +
    'silently misses mail (defect f0958b13fe2b). Do NOT delegate mailbox verbs to a subagent. ' +
    'Report what you learned back to your parent instead; the main thread will drain the ' +
    'mailbox itself. Read-only verbs (`inbox count`, `inbox peek-primary`, `mesh read --peek`, ' +
    'plain `roster`) are unaffected. To disable this guard entirely, set ' +
    'ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1.';
}

// git-stash-guard (defect b08b26566b92): mutating `git stash` detection —
// mirrors detectSubagentMailboxTouch's own segment/shell-c/eval/substitution
// recursion above so a wrapped invocation (`bash -c "git stash"`, `$(...)`,
// a `&&`/`;`/`|` chain) is caught the same way that guard already is.
// `git stash list`/`show`/`branch` are read-only or non-destructive-enough to
// be OUT of this defect's stated scope and are never matched. A BARE
// `git stash` (no subcommand) is git's own shorthand for `git stash push` —
// treated identically.
//
// R2 Critic P1 fixes (3 bypasses in the original adjacency-regex version):
//   1. `git stash -u|--include-untracked|-k|--keep-index|-m X|-p|-q|-a` are
//      ALL flag-only forms of `push` per git-stash(1) — the old regex only
//      captured the token immediately after `stash` and treated anything
//      that wasn't a KNOWN subcommand word as "no match", so a flag-only
//      invocation slipped through unclassified. Now: after the `stash` token,
//      leading flags are walked (STASH_PUSH_ONLY_FLAGS) until either a real
//      subcommand word is found or the tokens run out (-> push).
//   2. `git -C <path> stash` / `git --git-dir=X stash` bypassed the old
//      `\bgit\s+stash\b` adjacency regex (git's own global options sit
//      between `git` and `stash`). Now: `git`'s token is located explicitly,
//      then GIT_GLOBAL_OPTS_TAKE_VALUE/`--opt=value` are walked past to find
//      the actual subcommand, mirroring the git-argv contract instead of
//      assuming zero-distance adjacency.
//   3. `grep -rn "git stash drop" docs/` and `git commit -m "...git stash
//      pop..."` used to false-positive: `dequoteSegment` (which this used to
//      run against) FLATTENS quote boundaries, so a quoted commit message
//      containing the literal text "git stash pop" became indistinguishable
//      from a real invocation. Fixed at the root: this now runs against the
//      RAW segment via `effectiveVerb` (must resolve to `git`, so `grep ...`
//      never even enters git-argv parsing) and `tokenizeQuoted` (which keeps
//      a quoted phrase as ONE token, so a `-m "...git stash pop..."` value
//      is never split back into bare `git`/`stash`/`pop` words).
const GIT_GLOBAL_OPTS_TAKE_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const STASH_PUSH_FLAG_VALUE = new Set(['-m', '--message']);
function mutatingGitStashInSegment(seg) {
  if (effectiveVerb(seg) !== 'git') return null;
  const tokens = tokenizeQuoted(seg);
  let idx = 0;
  while (idx < tokens.length && basename(tokens[idx]).toLowerCase() !== 'git') idx++;
  if (idx >= tokens.length) return null;
  idx++; // skip the `git` token itself
  // Walk git's own GLOBAL options (before the subcommand) — `-C <path>`,
  // `--git-dir[=path]`, `-c <key>=<val>`, flag-only globals (`--no-pager`,
  // `--bare`, ...). Any unrecognized `-`-prefixed token is consumed as a
  // single (flag-only) token — a global option this file does not know about
  // can only cause a FALSE NEGATIVE here (miss a stash call), never a false
  // positive, which is the safe failure direction for a blocking guard.
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === '--') { idx++; break; }
    if (!tok.startsWith('-')) break;
    if (/^--[A-Za-z-]+=/.test(tok)) { idx++; continue; }
    if (GIT_GLOBAL_OPTS_TAKE_VALUE.has(tok)) {
      idx++;
      if (idx < tokens.length) idx++;
      continue;
    }
    idx++;
  }
  if (idx >= tokens.length || tokens[idx].toLowerCase() !== 'stash') return null;
  idx++; // skip the `stash` token itself
  // Walk `stash`'s own flags. A flag-only form (no subcommand word at all)
  // is git's own `push` shorthand — see STASH_PUSH_FLAG_VALUE / the header
  // comment's item 1.
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (!tok.startsWith('-')) break;
    if (/^--message=/.test(tok)) { idx++; continue; }
    if (STASH_PUSH_FLAG_VALUE.has(tok)) {
      idx++;
      if (idx < tokens.length) idx++;
      continue;
    }
    idx++;
  }
  if (idx >= tokens.length) return 'push';
  const sub = tokens[idx].toLowerCase();
  if (sub === 'list' || sub === 'show' || sub === 'branch') return null;
  if (sub === 'push' || sub === 'pop' || sub === 'drop' || sub === 'clear' || sub === 'apply' || sub === 'save') {
    return sub;
  }
  return null;
}
function detectMutatingGitStash(command, depth) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const d = typeof depth === 'number' ? depth : 0;
  for (const seg of splitSegments(command)) {
    const hit = mutatingGitStashInSegment(seg);
    if (hit) return hit;
    if (d < 3) {
      const shellCPayload = extractShellCPayload(seg);
      if (shellCPayload) {
        const r = detectMutatingGitStash(shellCPayload, d + 1);
        if (r) return r;
      }
      const evalPayload = extractEvalPayload(seg);
      if (evalPayload) {
        const r = detectMutatingGitStash(evalPayload, d + 1);
        if (r) return r;
      }
    }
  }
  if (d < 3) {
    for (const inner of extractSubstitutions(command)) {
      const r = detectMutatingGitStash(inner, d + 1);
      if (r) return r;
    }
  }
  return null;
}
// findGitToplevelForStashGuard used to live here as its own PURE fs walk-up
// (no git spawn) — Phase 2 mesh redesign, B3: retired in favor of the one
// canonical resolver (companion/lib/identity.js's resolveContext), which is
// the same zero-spawn-first walk. `ctx.toplevel`, not `worktreeRoot`, is the
// right field here: a stash acts on the nearest repo actually checked out at
// cwd (a submodule included), not its superproject.
// hasProtectedStashesMarker(cwd) -> bool. The repo opts INTO stash protection
// by creating `.anti-hall/protected-stashes` at its git toplevel (any
// content, existence-only check) — this marker (or the ANTIHALL_STASH_GUARD=1
// env opt-in, see the call site) is how a repo/operator ARMS the guard; a
// repo that has never heard of it stays fully unaffected (R2 Critic P1 —
// "no unconditional default block in a public plugin").
function hasProtectedStashesMarker(cwd) {
  try {
    const top = require('../companion/lib/identity.js').resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel;
    if (!top) return false;
    fs.statSync(path.join(top, '.anti-hall', 'protected-stashes'));
    return true;
  } catch (_) {
    return false;
  }
}
// buildGitStashReason(sub, subagent) -> closed-vocabulary block reason (NEVER
// reflects command/stdin text). `sub` is drawn from a fixed, code-defined set
// (see mutatingGitStashInSegment), never raw input.
function buildGitStashReason(sub, subagent) {
  const scope = subagent
    ? 'SUBAGENT context (a worker must never touch the coordinator\'s working tree via stash)'
    : 'this repo (this guard is armed — .anti-hall/protected-stashes exists or ANTIHALL_STASH_GUARD=1)';
  return 'GIT STASH GUARD: `git stash ' + sub + '` is blocked in ' + scope + ' (defect b08b26566b92 — ' +
    'a worker ran `git stash push` despite an explicit no-stash brief, stopped only by an ' +
    '.git/index.lock race, not by any guard). Do NOT stash here. If you need to preserve ' +
    'uncommitted work, commit it (even as a WIP commit) instead — never delegate a stash ' +
    'to a subagent, and never stash over another agent\'s protected WIP. `git stash list` ' +
    '(read-only) is unaffected.';
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
    '--to-primary --message-file <path>` (or `--to <meshId>`) to direct-message, or `node ' +
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

// tokenizeQuoted()/dequoteSegment() are imported from ./lib/shell-scan.js
// (shared with git-guard.js). dequoteSegment(segment) is the SHELL-EFFECTIVE
// argv text: quote delimiters stripped, quoted/unquoted fragments WITHIN one
// token concatenated (via tokenizeQuoted), tokens rejoined with single
// spaces. Models what the shell actually passes as argv — quoting a bareword
// does NOT change argv, the shell executes it identically — so
// `"hivecontrol"`, `'message-parent'`, and `mes"sage-par"ent` all dequote to
// the same literal text as their unquoted form (`hivecontrol`,
// `message-parent`). Used (instead of neutralizeQuotedContents, which BLANKS
// quoted content and was the source of a live-verified P0 bypass — quoting a
// subcommand or the verb made the hivectl guards below miss it entirely) so
// verb-anchoring and subcommand matching run against the same text the shell
// would. Quoted DATA passed to an unrelated verb stays safe: `grep -n
// "hivecontrol workspace message-parent" f` dequotes to `grep -n hivecontrol
// workspace message-parent f`, but the verb-anchoring check below still reads
// the FIRST token as `grep`, not `hivecontrol`, so it still ALLOWS. NOT a
// shell parser — no backslash-escape or parameter/command-substitution
// support, matching the existing best-effort tokenization used throughout
// this file. tokenizeQuoted is also used by detectProtectedFileRead below to
// recover a quoted path argument's real text.

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
  let inboxCmd;
  try { inboxCmd = require('./lib/settings.js').getWithEnv('devswarm', 'inboxCmd', '', e); }
  catch (_) { inboxCmd = e.ANTIHALL_DEVSWARM_INBOX_CMD; }
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

// Heredoc handling (opener kept, body skipped) fixes the confirmed root cause
// of P2 fp dd88d2a72562/b183a9f1bbd5: without heredoc awareness, a heredoc
// BODY's own newlines are ordinary segment-split points (see the `\n` case
// below), so a message body written as `devswarm.js send ... <<'EOF' ... EOF`
// gets each body LINE parsed as its own command segment. A body line that
// happens to START with a heavy word ("make progress on X") then has
// effectiveVerb === 'make' (a HEAVY_VERB) and is misclassified as an executed
// command, not prose. The fix: keep the heredoc OPENER text (e.g. `<<'EOF'`)
// in the invoking segment so that command's own verb is still classified
// normally, but SKIP the heredoc BODY entirely — it is DATA, never re-parsed
// as segments/commands. HEREDOC_RE/parseHeredocAt live in ./lib/shell-scan.js
// (shared with git-guard.js — see that file's SCOPE DISCIPLINE note for why
// only the low-level heredoc-construct parser is shared, not segmentation
// itself).

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

    // Heredoc: consume the opener on the current segment, then skip the BODY
    // (up to and including the terminator line) without emitting it as
    // segments. See the heredoc-handling comment above splitSegments.
    if (c === '<' && c2 === '<') {
      const parsed = parseHeredocAt(cmd, i);
      if (parsed) {
        cur += parsed.openerText;
        i = parsed.end;
        // The heredoc construct closes the current logical command/segment.
        flush();
        continue;
      }
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

// basename() is imported from ./lib/shell-scan.js (shared with git-guard.js).

// Wrapper words to skip when finding a segment's effective verb (mirrors
// git-guard.js WRAPPERS, plus the shell control keywords that can lead a segment).
const WRAPPERS = new Set([
  'command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout',
  'taskpolicy', 'xargs',
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
    } else if (word === 'taskpolicy') {
      // taskpolicy [-c class] [-b|-B] [-t class] [-p pid] ... command. Skip
      // option flags, consuming a separated value for -c/-t (the class arg).
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const f = tokens[idx]; idx++;
        if ((f === '-c' || f === '-t' || f === '-p') &&
            idx < tokens.length && !tokens[idx].startsWith('-')) idx++;
      }
    } else if (word === 'xargs') {
      // xargs [-n N] [-I repl] [-P N] ... command. Best-effort: skip leading
      // flag tokens so the wrapped runner (e.g. `xargs pytest`) is found.
      while (idx < tokens.length && tokens[idx].startsWith('-')) idx++;
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

// blankPatternArgument(text, verb): for a grep/sed/awk (PATTERN_FIRST_VERBS)
// segment, its FIRST non-flag operand is a search PATTERN/script — DATA, not
// a command — so blank it (replace with spaces, preserving length/offsets)
// before running HEAVY_PATTERNS against the text. Fixes P2 fp b183a9f1bbd5:
// `git show <ref>:<path> | grep deploy` was misread as an executed "deploy"
// command because the pattern argument's own text was scanned like command
// text. Mirrors detectProtectedFileRead's skipNextOperand discipline (best-
// effort: does not special-case a SEPARATED flag value, e.g. `-A 5`, where
// the numeric operand would itself be (wrongly) treated as the pattern and
// blanked instead — same accepted limitation as the existing skipNextOperand
// logic above, not a new gap). Only ever narrows what is blanked (i.e. only
// ever ALLOWS more), never widens a block.
function blankPatternArgument(text, verb) {
  if (!verb || !PATTERN_FIRST_VERBS.has(verb)) return text;
  const tokenRe = /\S+/g;
  let m;
  let foundVerb = false;
  while ((m = tokenRe.exec(text))) {
    const tok = m[0];
    if (!foundVerb) {
      if (basename(tok).toLowerCase() === verb) foundVerb = true;
      continue;
    }
    if (tok.startsWith('-')) continue; // flag: skip, keep scanning for the pattern
    // First non-flag operand after the verb is the PATTERN/script -> blank it.
    const start = m.index;
    const end = start + tok.length;
    return text.slice(0, start) + ' '.repeat(tok.length) + text.slice(end);
  }
  return text;
}

// isSafeNodeEval(segment) -> true iff this segment is `node -e <code>` (or
// `--eval`) AND <code> contains no recognizable write/spawn API call. This is
// a GENERALIZATION of the existing quoted `-e "..."` LIGHT_EXCEPTIONS entry
// above (which only matches the exact `-e "..."` / `-e '...'` literal shape):
// this one tokenizes the segment (quote-aware, via tokenizeQuoted, so the
// payload's own spaces/quoting do not confuse it) and inspects the ACTUAL
// eval payload text for a closed, conservative deny-list of Node.js APIs that
// write, delete, or spawn a process (fs write/rm/rename/chmod/etc.,
// child_process spawn/exec/fork, or any reference to `child_process` at all).
// Deliberately CONSERVATIVE: this only ever WIDENS what is allowed (never
// narrows a block) — any payload it cannot confidently classify as safe
// (no recognized `-e`/`--eval` flag, or a payload containing ANY of the
// deny-listed substrings) returns false, leaving the normal heavy-command
// checks below to decide as before. Only the SPACED `-e <code>` / `--eval
// <code>` form is recognized (matching the existing quoted LIGHT_EXCEPTIONS
// entry's own scope) — an unrecognized shape is never exempted here, it is
// simply left for the pre-existing checks.
const NODE_EVAL_UNSAFE_RE =
  /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?|symlink(?:Sync)?|copyFile(?:Sync)?|spawn(?:Sync)?|exec(?:Sync)?|execFile(?:Sync)?|fork)\s*\(|child_process/;

// P2 fix (`node -e "require('fs')['writeFileSync']('x','y')"`): bracket
// member access (`obj['methodName']`) calls the SAME method as
// `obj.methodName(`, but hides the method NAME from NODE_EVAL_UNSAFE_RE's
// name-based `\bwriteFile(?:Sync)?\s*\(` matching (the char right after the
// name is `]`/`'`, never `(`) — a live-verified bypass of the deny-list
// above. Rather than try to enumerate every bracket-hiding shape, deny ANY
// bracket member access outright: `[` followed (optionally through
// whitespace) by a quote is never legitimate in a one-line eval payload
// safe enough to run inline, so "when in doubt, deny".
const NODE_EVAL_BRACKET_ACCESS_RE = /\[\s*['"]/;

// Small, closed allowlist of `fs` READ methods a safe `-e` payload may call.
// Everything else fs-namespaced is denied outright — this is a DEFAULT-DENY
// allowlist for the fs module specifically (not another deny-list item),
// so an fs method absent from BOTH the original NODE_EVAL_UNSAFE_RE deny-
// list and this allowlist (e.g. `fs.cpSync`, `fs.linkSync`,
// `fs.utimesSync`, `fs.createWriteStream`, `fs.watch`, `fs.opendirSync`)
// still denies, per "when in doubt, deny".
const NODE_FS_READ_ALLOWLIST = new Set([
  'readFileSync', 'readdirSync', 'statSync', 'existsSync', 'lstatSync',
]);
// Matches an ACTUAL fs API invocation — `fs.<method>(` or
// `require('fs').<method>(` — never an unrelated `.method(` call elsewhere
// in the payload that merely happens to follow some other object.
const NODE_FS_METHOD_CALL_RE =
  /(?:\brequire\(\s*['"]fs['"]\s*\)|\bfs)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

function isSafeNodeEvalPayload(payload) {
  if (!payload) return false;
  if (NODE_EVAL_UNSAFE_RE.test(payload)) return false;
  if (NODE_EVAL_BRACKET_ACCESS_RE.test(payload)) return false;
  if (/\bchild_process\b/.test(payload)) return false;
  if (/\bfs\/promises\b/.test(payload)) return false;
  if (/\bprocess\s*\.\s*binding\s*\(/.test(payload)) return false;
  if (/\beval\s*\(/.test(payload)) return false;
  if (/\bFunction\s*\(/.test(payload)) return false;
  if (/\bimport\s*\(/.test(payload)) return false;
  NODE_FS_METHOD_CALL_RE.lastIndex = 0;
  let m;
  while ((m = NODE_FS_METHOD_CALL_RE.exec(payload))) {
    if (!NODE_FS_READ_ALLOWLIST.has(m[1])) return false;
  }
  return true;
}

function isSafeNodeEval(segment) {
  if (effectiveVerb(segment) !== 'node') return false;
  const tokens = tokenizeQuoted(segment);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-e' || tokens[i] === '--eval') {
      const payload = i + 1 < tokens.length ? tokens[i + 1] : '';
      return isSafeNodeEvalPayload(payload);
    }
  }
  return false;
}

// isNodeDashEInvocation(segment) -> true iff this segment is a `node -e`/
// `node --eval` invocation (regardless of payload safety). Root-cause fix:
// `node` is NOT in HEAVY_VERBS and `node -e "..."` never matches the
// `\bnode\s+\S+\.(?:js|mjs|cjs)\b` HEAVY_PATTERN (there is no script FILE
// argument), so isSafeNodeEval()/isSafeNodeEvalPayload() above were
// previously dead code as far as isHeavySegment's BLOCK decision goes —
// an unsafe `-e` payload never got flagged heavy in the first place,
// regardless of what isSafeNodeEval returned. isHeavySegment now calls this
// after the isSafeNodeEval(segment) exemption check, so: safe payload ->
// exempted (returns false further up); unsafe/unknown payload -> this
// returns true -> BLOCKED.
function isNodeDashEInvocation(segment) {
  if (effectiveVerb(segment) !== 'node') return false;
  const tokens = tokenizeQuoted(segment);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-e' || tokens[i] === '--eval') return true;
  }
  return false;
}

// isSafeGitFetch(segment) -> true iff this segment is `git fetch ...` AND
// carries no argument that can rewrite/delete a local ref: no `:` refspec
// (src:dst form), no leading `+` refspec (force-updates the dst even past a
// non-fast-forward), and none of --prune/-p/--prune-tags/--force/-f (which
// delete or force-overwrite local remote-tracking refs). P1 fix: the old
// LIGHT_EXCEPTIONS entry was a bare `\bgit\s+fetch\b` match, so it exempted
// ALL of those mutating forms too — `git fetch --prune origin` and
// `git fetch origin +refs/heads/*:refs/remotes/origin/*` both slipped through
// as "read-only". A `false` return here only means this specific exemption
// does not apply — `git fetch` still matches HEAVY_PATTERNS unconditionally
// (push|pull|fetch|clone) and is gated exactly as it was before the exemption
// existed, so this is fail-safe (never wrongly widens the block, only
// narrows the ALLOW).
const GIT_FETCH_DANGEROUS_FLAGS = new Set(['--prune', '-p', '--prune-tags', '--force', '-f']);

// git GLOBAL options (git's own top-level flags, recognized BEFORE the
// subcommand — never a subcommand's own flag) that gitSubcommandIndex must
// skip to find the real subcommand token. P1 fix: `git -c
// core.hooksPath=/tmp/x push --force origin main` and `git -C dir fetch
// +main:main` both slipped past every git check (the HEAVY_PATTERNS git
// regex, isSafeGitFetch) unflagged, because each one assumed the subcommand
// sits IMMEDIATELY after `git` with nothing in between — a global option
// broke that assumption and the whole invocation was never even classified
// as a git push/fetch at all.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-c', '-C', '--namespace', '--super-prefix', '--exec-path',
  '--config-env', '--git-dir', '--work-tree',
]);
const GIT_GLOBAL_FLAG_OPTS = new Set([
  '--no-pager', '-p', '-P', '--paginate', '--bare',
  '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks',
]);

// gitSubcommandIndex(tokens, gitIdx) -> index of the REAL git subcommand
// token (push/fetch/status/...), skipping any global options between `git`
// and the subcommand. Returns -1 if none is found. A value-taking global
// option (`-c`, `-C`, ...) consumes one extra token UNLESS its value is
// attached via `=` (`--git-dir=/x`). An unrecognized `-`-prefixed token
// before the subcommand is conservatively skipped by exactly one token too
// — git's own grammar never allows a subcommand-specific flag to appear
// before the subcommand name, so any leading `-` token here IS necessarily
// a global option, known or not.
function gitSubcommandIndex(tokens, gitIdx) {
  let idx = gitIdx + 1;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.startsWith('-')) return idx;
    const eq = t.indexOf('=');
    const base = eq === -1 ? t : t.slice(0, eq);
    if (GIT_GLOBAL_VALUE_OPTS.has(base)) { idx += (eq === -1) ? 2 : 1; continue; }
    if (GIT_GLOBAL_FLAG_OPTS.has(t)) { idx++; continue; }
    idx++; // unknown global flag: skip just this one token (fail-safe)
  }
  return -1;
}

function isSafeGitFetch(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1 || (tokens[subIdx] || '').toLowerCase() !== 'fetch') return false;
  for (let i = subIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_FETCH_DANGEROUS_FLAGS.has(t)) return false;
    if (t.startsWith('+')) return false;
    if (t.includes(':')) return false;
  }
  return true;
}

// isHeavyGitSegment(segment) -> true iff this segment's git invocation has a
// REAL subcommand (found via gitSubcommandIndex, so a global option in
// between `git` and the subcommand cannot hide it) of push/pull/clone
// (always heavy) or fetch without isSafeGitFetch's safety. This is the fix
// for the P1 bypass above: the plain-substring git HEAVY_PATTERN
// (`\bgit\s+(?:push|pull|fetch|clone)\b`) only matches when the subcommand
// is textually ADJACENT to `git`, so it never even sees a global-option-
// prefixed invocation — this check runs the same tokenized, option-aware
// parse used by isSafeGitFetch, so the two can never disagree about where
// the subcommand actually is. Gated on effectiveVerb(segment) === 'git'
// first (same discipline as isSafeGitFetch/isSafeSqliteReadonly/
// isSafeNodeEval below) so `git` appearing only as quoted DATA in an
// unrelated command (`echo "git push origin"`) is never misread as a real
// git invocation.
function isHeavyGitSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1) return false;
  const sub = tokens[subIdx].toLowerCase();
  if (sub === 'push' || sub === 'pull' || sub === 'clone') return true;
  if (sub === 'fetch') return !isSafeGitFetch(segment);
  return false;
}

// isSafeSqliteReadonly(segment) -> true iff this is a `sqlite3` invocation
// with `-readonly` present as its OWN argv token before the db path, and the
// SQL/args after the db path contain none of sqlite3's dangerous dot-commands
// (.shell/.system/.output/.once/.import/.save — several of these can write
// files or run arbitrary shell commands even on a read-only CONNECTION) or a
// standalone ATTACH (which opens a second, non-readonly database file).
// P2 fix: the old LIGHT_EXCEPTIONS entry was `/\bsqlite3\b[^\n]*\s-readonly\b/i`
// — a whole-string substring match, not an argv-position check, so it did not
// verify -readonly was an actual flag token (vs. e.g. part of a quoted SQL
// string) nor that no dangerous dot-command followed.
const SQLITE_DANGEROUS_RE = /(^|[\s;])\.(shell|system|output|once|import|save)\b|\bATTACH\b/i;

// isPipedIntoSegment(wholeCommand, segment) -> true iff `segment` (an exact,
// contiguous substring of wholeCommand — guaranteed by how splitSegments
// builds it: characters are copied straight from the source, never
// reordered) is immediately preceded, modulo whitespace, by a single `|`
// (not `||`) in the original command text. splitSegments CONSUMES the `|`
// operator itself when it flushes a segment (see its `if (c === '|')`
// branch), so the piped-into segment's own text never contains any trace of
// the pipe — this is the only way to recover that fact.
function isPipedIntoSegment(wholeCommand, segment) {
  if (typeof wholeCommand !== 'string' || typeof segment !== 'string') return false;
  const idx = wholeCommand.indexOf(segment);
  if (idx <= 0) return false;
  let i = idx - 1;
  while (i >= 0 && /\s/.test(wholeCommand[i])) i--;
  return i >= 0 && wholeCommand[i] === '|' && wholeCommand[i - 1] !== '|';
}

// isSafeSqliteReadonly(segment, wholeCommand) -> true iff this is a
// `sqlite3` invocation with `-readonly` present as its OWN argv token before
// the db path, the SQL/args after the db path contain none of sqlite3's
// dangerous dot-commands (see SQLITE_DANGEROUS_RE below), AND the
// invocation has NO stdin input at all (P1 fix below).
//
// P1 fix (`sqlite3 -readonly db.sqlite <<'EOF'` + a `.shell rm -rf /`
// heredoc BODY): the heredoc body is intentionally treated as inert DATA by
// splitSegments — it is never re-parsed as SQL/args, by design (see the
// heredoc-handling comment above splitSegments), so SQLITE_DANGEROUS_RE
// below can NEVER see a dangerous dot-command hidden in a heredoc body, a
// herestring, an input-file redirect, or piped stdin. The only sound fix is
// to deny the WHOLE exemption whenever this invocation has any stdin input
// at all: a heredoc (`<<`), herestring (`<<<`), input-file redirect (`<`),
// or being the receiving end of a shell pipe (`... | sqlite3 ...`) — the SQL
// text sqlite3 will actually execute is then not fully visible to this
// static check, so it is never eligible for the read-only exemption, full
// stop. The `<`/`<<`/`<<<` check runs against the QUOTE-NEUTRALIZED segment
// (neutralizeQuotedContents) so a literal `<` inside quoted SQL DATA
// (`"select 1 < 2"`) does not itself trigger this — only a real, unquoted
// shell redirect/heredoc/herestring token does.
function isSafeSqliteReadonly(segment, wholeCommand) {
  if (effectiveVerb(segment) !== 'sqlite3') return false;
  if (/</.test(neutralizeQuotedContents(segment))) return false;
  if (isPipedIntoSegment(wholeCommand, segment)) return false;
  const tokens = tokenizeQuoted(segment);
  const verbIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'sqlite3');
  if (verbIdx === -1) return false;
  let readonlyIdx = -1;
  let dbPathIdx = -1;
  for (let i = verbIdx + 1; i < tokens.length; i++) {
    if (tokens[i] === '-readonly') { readonlyIdx = i; continue; }
    if (tokens[i].startsWith('-')) continue; // some other flag
    dbPathIdx = i;
    break; // first non-flag token is the db path (sqlite3 [OPTS] FILE [SQL])
  }
  if (readonlyIdx === -1 || dbPathIdx === -1 || readonlyIdx > dbPathIdx) return false;
  const rest = tokens.slice(dbPathIdx + 1).join(' ');
  return !SQLITE_DANGEROUS_RE.test(rest);
}

// isReadOnlyCloudInspect(segment) -> true iff this is a gcloud/gh/kubectl
// invocation whose verb position is exactly describe|list|get|view (or, for
// gcloud only, the literal `logging read`), tokenized and matched by EXACT
// token equality — never a substring/\b match. P1 fix: the old regex
// `\b(?:gcloud|gh|kubectl)\s+(?:\S+\s+)*?(?:describe|list|get|view)\b` matched
// those words as a SUBSTRING anywhere later on the line, including inside an
// unrelated LATER compound token — `gcloud functions deploy list-users` and
// `kubectl delete pod get-worker-1` both matched (on `list`/`get` inside
// `list-users`/`get-worker-1`) even though the real, earlier verb was the
// mutating `deploy`/`delete`.
//   - gcloud: `gcloud <group...> <verb> [resource] [flags]` — the first
//     non-flag token is always a product/resource-group name (e.g. `run` in
//     `gcloud run services describe foo`, Cloud Run — never itself a verb),
//     so it is excluded from both the verb search and the mutating-verb scan.
//     Every OTHER non-flag token is checked: ANY exact match to a mutating
//     verb rejects the whole segment; a read-only verb token being present
//     is what allows it.
//   - gh / kubectl: no product-group prefix — the verb is exactly the FIRST
//     token after the binary.
// Belt + suspenders: a standalone mutating-verb token anywhere in the
// (non-exempt) argv rejects the exemption outright, even if a read-only verb
// also appears — a real gcloud/kubectl/gh invocation never combines the two.
const CLOUD_BINARIES = new Set(['gcloud', 'gh', 'kubectl']);
const CLOUD_READONLY_VERBS = new Set(['describe', 'list', 'get', 'view']);
const CLOUD_MUTATING_VERBS = new Set([
  'deploy', 'delete', 'create', 'update', 'set', 'patch', 'apply', 'rm',
  'remove', 'scale', 'rollout', 'run', 'exec', 'push', 'merge', 'close', 'edit',
]);
function isReadOnlyCloudInspect(segment) {
  const tokens = tokenizeQuoted(segment);
  const binIdx = tokens.findIndex((t) => CLOUD_BINARIES.has(basename(t).toLowerCase()));
  if (binIdx === -1) return false;
  const bin = basename(tokens[binIdx]).toLowerCase();
  const rest = tokens.slice(binIdx + 1);
  if (bin === 'gcloud') {
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i].toLowerCase() === 'logging' && rest[i + 1].toLowerCase() === 'read') return true;
    }
    let exemptedProductWord = false;
    let sawReadonlyVerb = false;
    for (const t of rest) {
      if (t.startsWith('-')) continue;
      if (!exemptedProductWord) { exemptedProductWord = true; continue; }
      const low = t.toLowerCase();
      if (CLOUD_MUTATING_VERBS.has(low)) return false;
      if (CLOUD_READONLY_VERBS.has(low)) sawReadonlyVerb = true;
    }
    return sawReadonlyVerb;
  }
  // gh / kubectl: the verb is exactly the first token after the binary.
  const first = (rest[0] || '').toLowerCase();
  if (!CLOUD_READONLY_VERBS.has(first)) return false;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i].startsWith('-')) continue;
    if (CLOUD_MUTATING_VERBS.has(rest[i].toLowerCase())) return false;
  }
  return true;
}

// P2 fix: `gh` mutating subcommands were never classified heavy at all — `gh`
// is not a HEAVY_VERB and no HEAVY_PATTERN mentions it, so isReadOnlyCloudInspect
// (an EXEMPTION check, only ever relevant once something is already flagged
// heavy) never mattered: `gh pr merge`, `gh issue delete`, `gh release
// upload`, etc. all sailed through unflagged. GH_MUTATING_SUBCOMMANDS +
// isHeavyGhSegment below are the actual DETECTOR this needed; read-only verbs
// (view/list/status/diff/checks) and `gh run watch|view` are simply absent
// from every set here, so they fall through to "not heavy" by construction —
// no separate allowlist regex needed.
const GH_MUTATING_SUBCOMMANDS = {
  pr: new Set(['merge', 'close', 'edit', 'create', 'review']),
  issue: new Set(['create', 'close', 'delete', 'edit']),
  release: new Set(['create', 'delete', 'edit', 'upload']),
  repo: new Set(['delete', 'edit']),
  secret: new Set(['set', 'delete']),
};
const GH_API_MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// isHeavyGhSegment(segment) -> true iff this is a `gh` invocation of a
// mutating subcommand: pr merge/close/edit/create/review, issue
// create/close/delete/edit, release create/delete/edit/upload, repo
// delete/edit, secret set/delete, `gh workflow run`, or `gh api` used with
// -X/--method POST|PATCH|PUT|DELETE or any -f/-F/--field/--raw-field data
// argument (all of which mutate via the REST/GraphQL API regardless of
// method). Gated on effectiveVerb(segment) === 'gh' first, same discipline
// as isHeavyGitSegment, so `gh` appearing only as quoted DATA is never
// misread as a real invocation.
function isHeavyGhSegment(segment) {
  if (effectiveVerb(segment) !== 'gh') return false;
  const tokens = tokenizeQuoted(segment);
  const ghIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'gh');
  if (ghIdx === -1) return false;
  const group = (tokens[ghIdx + 1] || '').toLowerCase();
  const sub = (tokens[ghIdx + 2] || '').toLowerCase();
  if (group === 'workflow' && sub === 'run') return true;
  if (GH_MUTATING_SUBCOMMANDS[group] && GH_MUTATING_SUBCOMMANDS[group].has(sub)) return true;
  if (group === 'api') {
    for (let i = ghIdx + 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') return true;
      if (t === '-X' || t === '--method') {
        if (GH_API_MUTATING_METHODS.has((tokens[i + 1] || '').toUpperCase())) return true;
      }
    }
  }
  return false;
}

// Per-segment checks that need tokenized/positional logic (not a plain regex
// substring match) — evaluated alongside LIGHT_EXCEPTIONS in isHeavySegment.
const LIGHT_EXCEPTION_FNS = [isSafeGitFetch, isSafeSqliteReadonly, isReadOnlyCloudInspect];

// Evaluate one segment: heavy if (its effective verb is a HEAVY_VERB) OR (it
// matches a HEAVY_PATTERN) OR (it is a heavy git/gh invocation per the
// tokenized checks above), AND it is NOT itself a LIGHT_EXCEPTION. Light
// exceptions are checked PER SEGMENT so `git status && npm run build` blocks on
// the build segment instead of being exempted by the whole-string status match.
// `command` is the FULL original command string this segment came from —
// needed only by isSafeSqliteReadonly's pipe-into-stdin check; every other
// LIGHT_EXCEPTION_FNS entry ignores the extra argument.
function isHeavySegment(segment, command) {
  for (const re of LIGHT_EXCEPTIONS) {
    if (re.test(segment)) return false;
  }
  for (const fn of LIGHT_EXCEPTION_FNS) {
    if (fn(segment, command)) return false;
  }
  if (isSafeNodeEval(segment)) return false;
  if (isNodeDashEInvocation(segment)) return true;
  if (isHeavyGitSegment(segment)) return true;
  if (isHeavyGhSegment(segment)) return true;
  const verb = effectiveVerb(segment);
  if (verb && HEAVY_VERBS.has(verb)) return true;
  // For PATTERN matching only, neutralize quoted string contents so a benign
  // command whose only heavy-looking text is inside a quoted DATA arg
  // (`echo "npm run build"`, `printf 'go test ./...'`) is NOT flagged. Real
  // unquoted heavy commands survive neutralization and still match.
  let forPatterns = neutralizeQuotedContents(segment);
  // Also blank the search-PATTERN operand of grep/sed/awk (PATTERN_FIRST_VERBS)
  // — a heavy word appearing inside a search pattern, quoted OR unquoted
  // (`grep deploy file`, `grep -n 'npm run build' f`), is DATA describing what
  // to search for, not a command to run. See blankPatternArgument().
  forPatterns = blankPatternArgument(forPatterns, verb);
  for (const re of HEAVY_PATTERNS) {
    if (re.test(forPatterns)) return true;
  }
  return false;
}

// extractSubstitutions() and SHELL_VERBS are imported from
// ./lib/shell-scan.js (shared with git-guard.js). extractSubstitutions finds
// nested command strings hidden inside a segment so they are evaluated too
// (the segment splitter treats $(...) / backticks as plain boundaries and
// never inspects their CONTENTS):
//   (a) command substitution: $( ... ) and ` ... ` -> the inner command text.
// It is heredoc-aware (mirrors splitSegments' handling): a QUOTED delimiter
// (<<'EOF', <<"EOF") means the body is INERT DATA in a real shell — no
// $(...)/backtick expansion inside it — so its body is skipped from this
// substitution scan entirely, never treated as executable content. Root
// cause (field report): without this, a backtick-quoted span appearing as
// ordinary prose inside a `<<'EOF'` message body (e.g. `` `pytest tests -k
// <codebase>` `` inside a devswarm.js send message) was extracted as a real
// command substitution and recursed into isHeavyCommand, misclassifying
// quoted DATA as an executed command (verb: pytest). An UNQUOTED delimiter
// (<<EOF) DOES expand $(...)/backticks in a real shell, so its body is
// intentionally NOT skipped — the scan falls through and continues over it
// normally, still catching substitutions inside.
//   (b) shell -c payloads (extractShellCPayload below): when the effective
//       verb is a SHELL_VERBS member and a -c flag is present, the QUOTED
//       argument after -c is itself command(s).
// Depth bounding is handled by the recursive caller below (isHeavyCommand).

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
    if (isHeavySegment(seg, command)) return true;
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
    if (isHeavySegment(seg, command)) {
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

  // devswarm-subagent-mailbox-guard (defect f0958b13fe2b): fires ONLY in
  // SUBAGENT context, in ALL DevSwarm-active/child/coordinator combinations —
  // its OWN skip name, independent of command-guard's own skip/coordinator
  // gate below, PLUS the dedicated ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1 env
  // override. Uses isSubagentByPayload (PAYLOAD MARKERS ONLY, no
  // CLAUDE_CODE_ENTRYPOINT env fallback — see that function's own header for
  // why the env fallback is unsafe HERE specifically). Fully fail-open: any
  // throw -> fall through (never block).
  try {
    const { isSubagentByPayload } = require('./coordinator-detect.js');
    if (isSubagentByPayload(payload)
      && settingsGet('guards', 'allowSubagentMailbox') !== true
      && !isSkipped('devswarm-subagent-mailbox-guard')
      && detectSubagentMailboxTouch(command)) {
      fs.writeSync(1, JSON.stringify({ decision: 'block', reason: buildSubagentMailboxReason() }) + '\n');
      process.exit(2);
    }
  } catch (_) {
    // fail-open: never block a turn on a devswarm-subagent-mailbox-guard bug.
  }

  // git-stash-guard (defect b08b26566b92): a mutating `git stash` (push/pop/
  // drop/clear/apply/save, or bare `git stash` == push) is blocked — in
  // BOTH subagent and coordinator context — ONLY when the guard is ARMED:
  // this repo has opted into stash protection (.anti-hall/protected-stashes
  // at the git toplevel — see hasProtectedStashesMarker's own header) OR the
  // operator set ANTIHALL_STASH_GUARD=1. R2 Critic P1 (policy): the prior
  // version blocked SUBAGENT context unconditionally with no opt-in at all —
  // wrong for a PUBLIC plugin where most repos have never heard of this
  // guard and never asked for it; this file's own convention elsewhere
  // (devswarm-read-guard/devswarm-subagent-mailbox-guard fail-open by
  // default, merge-gate/ship-it gated behind an explicit env opt-in) is that
  // nothing blocks by default without a signal the operator (or the repo)
  // actually chose. `git stash list` is never matched (already a
  // LIGHT_EXCEPTIONS read-only allowance below too). Own skip name —
  // `git-stash-guard` is in skip-guard.js's DESTRUCTIVE set, so a blanket
  // "all" skip cannot silence it once armed (same protection level as
  // git-guard). Fires BEFORE the coordinator-only heavy-command gate below
  // (this is a data-safety guard, not a context-hygiene one — same
  // rationale as devswarm-read-guard/devswarm-subagent-mailbox-guard
  // above). Fully fail-open: any throw -> fall through (never block).
  try {
    if (!isSkipped('git-stash-guard')) {
      const stashSub = detectMutatingGitStash(command);
      if (stashSub) {
        const cwd = (payload && payload.cwd) || '';
        const armed = hasProtectedStashesMarker(cwd) || settingsGet('guards', 'stashGuard') === true;
        if (armed) {
          const { isSubagentByPayload } = require('./coordinator-detect.js');
          const subagent = isSubagentByPayload(payload);
          fs.writeSync(1, JSON.stringify({ decision: 'block', reason: buildGitStashReason(stashSub, subagent) }) + '\n');
          process.exit(2);
        }
      }
    }
  } catch (_) {
    // fail-open: never block a turn on a git-stash-guard bug.
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  if (isSkipped('command-guard')) process.exit(0);
  // Settings switch safety.commandGuard (0.108.4, safety: set/reset need --confirmed).
  // Off -> the core heavy-command gate below no-ops; the data-safety
  // sub-guards above (DevSwarm read/send/mailbox, armed stash) already ran.
  // Fail-open: any error runs the gate.
  try { if (!require('./lib/settings.js').enabled('safety', 'commandGuard')) process.exit(0); } catch (_) { /* run */ }
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
