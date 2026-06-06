#!/usr/bin/env node
'use strict';
// ship-it-guard.js — OPT-IN PreToolUse gate (Edit|Write|MultiEdit) for the
// ship-it skill's "plan before L-tier code" discipline. DEFAULT OFF.
//
// WHAT IT DOES (only when ANTIHALL_SHIPIT_GATE is on):
//   If a code file on a HARD-RISK path (migrations, auth, .github/workflows, …)
//   is about to be edited AND no PLAN.md exists (repo root or .planning/PLAN.md),
//   it blocks (exit 2) with a reason telling the agent to plan first. This is the
//   ship-it skill's L-tier "plan mode gate" given a thin mechanical backstop.
//
// HONEST LIMITS (read before trusting this):
//   1. ENFORCES ARTIFACT-EXISTENCE ONLY — it checks that *a* PLAN.md exists, NOT
//      that the plan is good, current, or actually covers this change. A stub
//      `# Plan` file satisfies it. Plan QUALITY is the deadly-loop's job, not this
//      hook's.
//   2. BYPASSABLE — PreToolUse fires on Edit|Write|MultiEdit only. An agent can
//      route the same write through `Bash` (e.g. a heredoc `cat > file`), which
//      this hook does not see. It is a speed-bump for the honest path, not a
//      sandbox.
//   3. DEFAULT-OFF — with the env unset it is a pure no-op (exit 0), so it can
//      never disrupt an unsuspecting user. You must opt in.
//   4. CONSERVATIVE — it ONLY fires on hard-risk paths, never on ordinary single
//      edits, to keep false positives near zero. A genuinely large but
//      ordinary-pathed change will NOT be gated (by design — better to under-gate
//      than to nag).
//   5. FAIL-OPEN — any error (bad stdin, fs failure, etc.) exits 0 (allow). A
//      buggy gate must never block the user.

const fs = require('fs');
const path = require('path');

// ON only when the env var is an explicit affirmative. Anything else = off.
function gateEnabled() {
  const v = process.env.ANTIHALL_SHIPIT_GATE;
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
}

// HARD-RISK path heuristics — the L-tier forcing triggers from the ship-it skill
// ("security/auth, schema/migration, CI/workflow YAML, …"). CONSERVATIVE: a path
// must match one of these to be gated. Plain feature files are never gated.
const HARD_RISK = [
  /(^|[\\/])\.github[\\/]workflows[\\/]/i,   // CI/workflow YAML
  /(^|[\\/])migrations?[\\/]/i,              // schema migrations
  /(^|[\\/])migrate[\\/]/i,
  /[._-]migration[s]?\.[a-z]+$/i,
  /(^|[\\/])(auth|authn|authz)[\\/]/i,       // auth dirs
  /[._-](auth|authn|authz|login|session|password|credential|token|secret)s?\.[a-z]+$/i,
  /(^|[\\/])(security|crypto)[\\/]/i,
];

// Files that are NOT code (docs / tests / plans) — never gated regardless of path.
function isNonCode(fp) {
  const base = path.basename(fp).toLowerCase();
  if (base === 'plan.md') return true;
  if (/\.(md|mdx|markdown|txt|rst)$/i.test(base)) return true;        // docs
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(base)) return true;          // test files
  if (/(^|[\\/])(tests?|__tests__|spec)([\\/]|$)/i.test(fp)) return true; // test dirs
  return false;
}

function isHardRisk(fp) {
  const norm = String(fp).replace(/\\/g, '/');
  return HARD_RISK.some((re) => re.test(norm) || re.test(fp));
}

// planExists(cwd): true if PLAN.md is found at <cwd>/PLAN.md or
// <cwd>/.planning/PLAN.md (the two locations the ship-it skill writes it to).
function planExists(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  const candidates = [
    path.join(cwd, 'PLAN.md'),
    path.join(cwd, '.planning', 'PLAN.md'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return true; } catch (_) { /* ignore */ }
  }
  return false;
}

// Extract the target file path(s) from the tool input across Edit/Write/MultiEdit.
function targetPaths(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = [];
  if (typeof toolInput.file_path === 'string') out.push(toolInput.file_path);
  // MultiEdit can carry an edits[] array but file_path is still top-level; cover
  // the rare per-edit file_path shape defensively.
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e && typeof e.file_path === 'string') out.push(e.file_path);
    }
  }
  return out;
}

function main() {
  // 1. Read stdin first; on any read failure fail-open.
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }

  // 2. Skip-hatch: an explicit user opt-out disables this guard (TTL'd).
  let isSkipped;
  try { ({ isSkipped } = require('./skip-guard.js')); } catch (_) { isSkipped = () => false; }
  try { if (isSkipped('ship-it-guard')) process.exit(0); } catch (_) { /* fail-open */ }

  // 3. DEFAULT OFF — no-op unless explicitly enabled.
  if (!gateEnabled()) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }

  const cwd = (payload && typeof payload.cwd === 'string') ? payload.cwd : process.cwd();
  const files = targetPaths(payload && payload.tool_input);
  if (!files.length) process.exit(0);

  // 4. Only consider CODE files on HARD-RISK paths.
  const risky = files.filter((f) => !isNonCode(f) && isHardRisk(f));
  if (!risky.length) process.exit(0);

  // 5. If a PLAN.md already exists, allow (artifact-existence satisfied).
  if (planExists(cwd)) process.exit(0);

  // 6. Block: L-risk file, no plan artifact.
  const shown = risky[0];
  const reason =
    'ship-it gate: L-risk file ' + shown + ' edited with no PLAN.md — plan first ' +
    '(ANTIHALL_SHIPIT_GATE).\n' +
    'This path is a hard-risk trigger (migration / auth / CI-workflow / security). ' +
    'Per the ship-it skill, L-tier changes go through plan mode and a PLAN.md before code. ' +
    'Create PLAN.md (repo root or .planning/PLAN.md), or — if this is genuinely a smaller ' +
    'change — disable the gate (unset ANTIHALL_SHIPIT_GATE) or use the documented skip-hatch.';

  process.stderr.write(reason + '\n');
  process.exit(2);
}

try { main(); } catch (_) { process.exit(0); } // fail-open on anything unexpected
