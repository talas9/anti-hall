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
  // docker ps/images/inspect (read-only)
  /\bdocker\s+(?:ps|images|inspect|logs|stats)\b/i,
];

function isHeavyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;

  // Check light exceptions first (bail-out: if it matches, NOT heavy)
  for (const re of LIGHT_EXCEPTIONS) {
    if (re.test(command)) return false;
  }

  // Check first verb
  const firstToken = command.trim().split(/\s+/)[0] || '';
  // Strip path prefix (e.g. /usr/bin/npm -> npm)
  const verb = firstToken.replace(/^.*\//, '').toLowerCase();
  if (HEAVY_VERBS.has(verb)) return true;

  // Check heavy patterns
  for (const re of HEAVY_PATTERNS) {
    if (re.test(command)) return true;
  }

  return false;
}

// A Task-tool subagent is identified by agent markers in the hook payload
// (reliable everywhere, incl. cmux) OR by the agent_tool entrypoint (vanilla CLI).
function isSubagent(payload) {
  if (payload && (payload.agent_id || payload.agent_type)) return true;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'agent_tool') return true;
  return false;
}

// Coordinator = NOT a subagent, running under a recognized interactive entrypoint.
// Takes the parsed hook payload so it can use the payload's agent markers.
function isCoordinator(payload) {
  // Subagents are never the coordinator — allow them (the whole point of the guard
  // is to keep the MAIN thread clean by pushing heavy work down to subagents).
  if (isSubagent(payload)) return false;

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  // Fail-open: if absent or unknown, allow (treat as subagent)
  if (!entrypoint || typeof entrypoint !== 'string') return false;
  // cli, vscode, jetbrains, vim, emacs, terminal_ide_* = coordinator
  if (entrypoint === 'cli') return true;
  if (entrypoint.startsWith('terminal_ide_')) return true;
  if (['vscode', 'jetbrains', 'vim', 'emacs'].includes(entrypoint)) return true;
  // Unknown/future values: fail-open (allow)
  return false;
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

  const reason =
    'COMMAND-DELEGATION RULE: heavy/long/state-changing commands must NEVER run ' +
    'inline in the main coordinator context — they fill the main thread with raw ' +
    'output and the most counterproductive thing a coordinator can do. ' +
    'DELEGATE to a subagent (cheap model: Haiku or similar): ' +
    'spawn a subagent, pass the command, let it run and return only a tight ' +
    'summary. The coordinator synthesizes the summary; raw output never reaches ' +
    'the main thread. Heavy command detected: ' + command.slice(0, 120);

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);
