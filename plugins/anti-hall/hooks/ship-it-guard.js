#!/usr/bin/env node
'use strict';
// ship-it-guard.js — OPT-IN PreToolUse gate (Edit|Write|MultiEdit) for the
// ship-it skill's "plan before L-tier code" discipline. DEFAULT OFF.
//
// WHAT IT DOES (only when ANTIHALL_SHIPIT_GATE is on):
//   1. EXISTENCE GATE (BLOCK): if a code file on a HARD-RISK path (migrations,
//      auth, .github/workflows, …) is about to be edited AND no PLAN.md exists
//      (repo root PLAN.md), it blocks (exit 2) with a reason telling
//      the agent to plan first. This is the ship-it skill's L-tier "plan mode
//      gate" given a thin mechanical backstop.
//   2. CONFORMANCE ADVISORY (never blocks): when a PLAN.md DOES exist and parses
//      as a real Step-2 artifact (a "## Phases" section with at least one phase
//      declaring a `files:` list — the structured field the ship-it SKILL.md
//      Step 2 template produces), every Write/Edit/MultiEdit target is checked
//      against the union of all phases' declared `files:` paths. A target that
//      matches NONE of them gets an ADVISORY (PreToolUse additionalContext, exit
//      0) — never a hard block, because `files:` is free-text prose and false
//      positives on legitimate shared-file touches are expected. This mirrors
//      model-routing-guard.js's default-advisory-first posture rather than
//      inventing a new enforcement pattern.
//
//      "The work is L-tier" is inferred structurally, not asserted: per
//      skills/ship-it/SKILL.md Step 2, PLAN.md's "## Phases" + per-phase `files:`
//      shape is written ONLY at L-tier (M skips the file; S never has one) — so a
//      PLAN.md that actually parses into that shape IS the L-tier signal. A stub
//      `# Plan` file (no Phases section, or phases with no `files:` field) has no
//      declared scope to check against, so conformance is skipped entirely
//      (fail-open) rather than flagging every edit as "out of scope."
//
//      CLAUDE-ONLY BY DESIGN: PLAN.md's `## Phases` / `files:` structure is a
//      Workflow-tool-era (Claude Code) artifact shape. The Codex port has no
//      equivalent structured plan file, so this conformance-advisory mechanism
//      is intentionally NOT mirrored to the Codex side in this change.
//
// HONEST LIMITS (read before trusting this):
//   1. ENFORCES ARTIFACT-EXISTENCE ONLY (existence gate) — it checks that *a*
//      PLAN.md exists, NOT that the plan is good, current, or actually covers
//      this change. A stub `# Plan` file satisfies it. Plan QUALITY is the
//      deadly-loop's job, not this hook's. The conformance advisory (mechanism 2
//      above) goes one step further — checking declared SCOPE, not just
//      existence — but is advisory-only precisely because `files:` is prose, not
//      a schema.
//   2. BYPASSABLE — PreToolUse fires on Edit|Write|MultiEdit only. An agent can
//      route the same write through `Bash` (e.g. a heredoc `cat > file`), which
//      this hook does not see. It is a speed-bump for the honest path, not a
//      sandbox.
//   3. DEFAULT-OFF — with the env unset it is a pure no-op (exit 0), so it can
//      never disrupt an unsuspecting user. You must opt in.
//   4. CONSERVATIVE — the BLOCK path ONLY fires on hard-risk paths, never on
//      ordinary single edits, to keep false positives near zero. A genuinely
//      large but ordinary-pathed change will NOT be gated (by design — better to
//      under-gate than to nag). The conformance ADVISORY is broader by design (it
//      checks any non-doc/non-test target, not just hard-risk paths) because it
//      never blocks — advisories are cheap to ignore, blocks are not.
//   5. FAIL-OPEN — any error (bad stdin, fs failure, unparseable PLAN.md, etc.)
//      exits 0 (allow). A buggy gate must never block the user.
//   6. CONFORMANCE PARSING IS A HEURISTIC, NOT A PARSER — `files:` is free text.
//      Paths are extracted by tokenizing on commas/whitespace/quotes and keeping
//      tokens that look path-like (contain `/` or a dot-extension), then matched
//      by suffix/equality against each edit target. Prose that happens to embed
//      a real path, unconventional formatting, or a path written differently
//      than the target (e.g. a glob) can produce a false ADVISORY. This is
//      accepted because the mechanism only ever advises, never blocks.

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

// findPlanPath(cwd): the PLAN.md path if found at <cwd>/PLAN.md, else null.
// GSD's `.planning/` convention is discontinued (owner decision, 2026-07-03) —
// `scripts/migrate-state.js` folds any existing `.planning/` content into
// `.anti-hall/history/legacy/planning/`; this hook no longer looks there.
function findPlanPath(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const candidate = path.join(cwd, 'PLAN.md');
  try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* ignore */ }
  return null;
}

// planExists(cwd): true if a PLAN.md is found (existence-gate check). Thin
// wrapper over findPlanPath for callers that don't need the actual path.
function planExists(cwd) {
  return findPlanPath(cwd) !== null;
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

// ---------------------------------------------------------------------------
// PLAN-CONFORMANCE ADVISORY (mechanism 2 — see header). Parses PLAN.md's
// "## Phases" section and each phase's `files:` bullet (the Step 2 SKILL.md
// template field), producing the union of declared path tokens across ALL
// phases. Heuristic by design (see HONEST LIMITS #6) — this is prose, not a
// schema, so it errs toward under-matching (fewer false ADVISORIES) rather
// than a strict parse that could misfire constantly.
// ---------------------------------------------------------------------------

// extractPathTokens(text): pull path-looking tokens out of a `files:` bullet's
// raw captured text (which may span multiple lines / nested sub-bullets).
// Strips leading bullet markers, splits on separators, keeps tokens that
// contain a `/` or end in a dot-extension (filters out prose words like "and").
function extractPathTokens(text) {
  if (typeof text !== 'string' || !text.length) return [];
  const cleaned = text.replace(/^[ \t]*-[ \t]*/gm, ' ');
  const rawTokens = cleaned.split(/[,\s`"'()]+/).filter(Boolean);
  const tokens = [];
  for (let t of rawTokens) {
    t = t.replace(/^\.\/+/, '').replace(/[.,;:]+$/, '');
    if (!t) continue;
    if (t.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(t)) {
      tokens.push(t.replace(/\\/g, '/'));
    }
  }
  return tokens;
}

// parsePlanDeclaredFiles(planContent): returns a non-empty Set of declared
// path tokens across every phase's `files:` field, or null when the content
// doesn't parse into a real Step-2 plan (no "## Phases" section, no "### "
// phase headings inside it, or phases present but none declared any files —
// nothing to compare against). null means "skip conformance entirely."
function parsePlanDeclaredFiles(planContent) {
  if (typeof planContent !== 'string' || !planContent.length) return null;

  // Bound the "## Phases" section to the text between that heading and the
  // next H2 heading (e.g. "## Progress"), or end of file. NOTE: deliberately NOT
  // using the 'm' flag here — under 'm', a trailing `$` in the lookahead would
  // match end-of-EVERY-line (including the "## Phases" heading line itself),
  // truncating the match to just the heading. `(?:^|\n)` gets us line-start
  // matching for the heading without making `$` line-relative too.
  const phasesMatch = planContent.match(/(?:^|\n)##[ \t]+Phases\b[\s\S]*?(?=\n##[ \t]+\S|$)/i);
  if (!phasesMatch) return null;
  const phasesBlock = phasesMatch[0];

  // Split into individual "### Phase N: ..." sections (splitting right before
  // each heading means every resulting section but the first starts with
  // "### " at position 0; the leading "## Phases" preamble section does not
  // and is dropped by the filter).
  const sections = phasesBlock.split(/\n(?=###[ \t]+)/).filter((s) => /^###[ \t]+/.test(s));

  const declared = new Set();
  let phaseCount = 0;
  for (const section of sections) {
    phaseCount++;
    // Capture everything after "- files:" up to the next top-level field
    // bullet ("\n- word:"), the next phase heading, or end of section.
    const filesMatch = section.match(/\n-[ \t]*files:[ \t]*([\s\S]*?)(?=\n-[ \t]*[\w][\w ]*:|\n###[ \t]|$)/i);
    if (!filesMatch) continue;
    for (const tok of extractPathTokens(filesMatch[1])) declared.add(tok);
  }

  if (phaseCount === 0 || declared.size === 0) return null;
  return declared;
}

// fileMatchesDeclared(filePath, declaredSet, cwd): true when filePath matches
// (exactly or by path-suffix, in either direction) any declared token. Loose
// on purpose — a missed match produces an advisory (cheap, ignorable), a wrong
// match produces silence (also fine — this never blocks either way).
function fileMatchesDeclared(filePath, declaredSet, cwd) {
  if (typeof filePath !== 'string' || !filePath.length) return false;
  const abs = filePath.replace(/\\/g, '/');
  let rel = abs;
  try {
    if (path.isAbsolute(filePath) && cwd) {
      const r = path.relative(cwd, filePath);
      if (r && !r.startsWith('..')) rel = r.replace(/\\/g, '/');
    }
  } catch (_) { /* keep abs as rel fallback */ }

  for (const tok of declaredSet) {
    if (!tok) continue;
    if (abs === tok || rel === tok) return true;
    if (abs.endsWith('/' + tok) || rel.endsWith('/' + tok)) return true;
    if (tok.endsWith('/' + rel) || tok.endsWith('/' + abs)) return true;
  }
  return false;
}

// advise(additionalContext): nested hookSpecificOutput shape (matches
// model-routing-guard.js's advisory convention exactly) — exit 0, never blocks.
function advise(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  };
  try { fs.writeSync(1, JSON.stringify(out) + '\n'); } catch (_) { /* best-effort */ }
  process.exit(0);
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

  // 4. CODE files only — docs/tests/PLAN.md itself are never gated, by either
  //    mechanism.
  const codeFiles = files.filter((f) => !isNonCode(f));
  if (!codeFiles.length) process.exit(0);

  const risky = codeFiles.filter(isHardRisk);
  const planPath = findPlanPath(cwd);

  // 5. MECHANISM 1 — EXISTENCE GATE (BLOCK): hard-risk file(s), no PLAN.md at
  //    all. Unchanged from the prior behavior.
  if (risky.length && !planPath) {
    const shown = risky[0];
    const reason =
      'ship-it gate: L-risk file ' + shown + ' edited with no PLAN.md — plan first ' +
      '(ANTIHALL_SHIPIT_GATE).\n' +
      'This path is a hard-risk trigger (migration / auth / CI-workflow / security). ' +
      'Per the ship-it skill, L-tier changes go through plan mode and a PLAN.md before code. ' +
      'Create PLAN.md (repo root), or — if this is genuinely a smaller ' +
      'change — disable the gate (unset ANTIHALL_SHIPIT_GATE) or use the documented skip-hatch.';

    process.stderr.write(reason + '\n');
    process.exit(2);
  }

  // 6. MECHANISM 2 — CONFORMANCE ADVISORY (never blocks): only runs when a
  //    PLAN.md exists at all (mechanism 1 already handled the no-plan case).
  //    Structural L-tier signal: the plan must actually parse into a Step-2
  //    shape (a "## Phases" section with >=1 phase declaring `files:`) — a stub
  //    `# Plan` (as used by the existence-gate tests) has nothing to compare
  //    against, so it's skipped (fail-open), not treated as "everything is out
  //    of scope."
  if (planPath) {
    let planContent = '';
    try { planContent = fs.readFileSync(planPath, 'utf8'); } catch (_) { planContent = ''; }
    const declared = parsePlanDeclaredFiles(planContent);
    if (declared) {
      const outOfScope = codeFiles.filter((f) => !fileMatchesDeclared(f, declared, cwd));
      if (outOfScope.length) {
        const shown = outOfScope[0];
        advise(
          'SHIP-IT PLAN-CONFORMANCE (advisory, not a block): ' + shown + ' does not ' +
          'appear in any phase\'s declared "files:" list in ' + planPath + '.\n' +
          'This may be a legitimate shared-file touch (`files:` is free text — false ' +
          'positives on genuinely shared files are expected) or scope drift from the ' +
          'plan. If intentional, proceed; if not, update PLAN.md\'s Blast radius / phase ' +
          '`files:` list, or re-plan this phase.'
        );
      }
    }
  }

  process.exit(0);
}

try { main(); } catch (_) { process.exit(0); } // fail-open on anything unexpected
