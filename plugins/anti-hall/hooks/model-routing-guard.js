#!/usr/bin/env node
// anti-hall :: model-routing-guard (PreToolUse Agent/Task — anti-waste routing)
//
// Nudges agent spawns toward the cheapest model that fits the task SHAPE:
//   - execution-shaped (mechanical) work belongs on haiku (10x cheaper than the
//     flagship), or sonnet if it authors code;
//   - planning-shaped (complex) work belongs on opus/fable.
//
// This is an ANTI-WASTE NET, NOT A SECURITY BOUNDARY. It classifies by keyword
// signals in the spawn's description/prompt; keyword stuffing trivially evades it
// (an accepted waste-ALLOW). The block path only fires on the unambiguous
// expensive-misroute case (mechanical-only task pinned to a flagship model on a
// generic agent), and even then a debate-role exemption applies.
//
// PARENT-MODEL BLINDNESS: the hook CANNOT see the orchestrator's own model — it
// is not in PreToolUse stdin. A spawn that OMITS `model` inherits the parent.
// STRICT MODE IS NOW THE DEFAULT: omitted-model mechanical spawns are BLOCKED
// unconditionally unless ANTIHALL_MODEL_ROUTING=advisory is set. Set
// ANTIHALL_MODEL_ROUTING=advisory to revert to the old advisory-only behavior.
// The hook NEVER reads ~/.claude.json or otherwise infers the parent model (the
// live lastModelUsage sample carries only cumulative counters, no timestamps — no
// reliable parent-model signal; see probe record P6).
//
// ADVISORY MODE (opt-out): set ANTIHALL_MODEL_ROUTING=advisory via the PROJECT's
// .claude/settings.json env block (or a per-session export) to downgrade
// omitted-model mechanical spawn blocks back to advisories. Use this only on
// projects where the orchestrator is reliably cheap-modeled and you want advisory
// nudges instead of blocks. Remedies when a strict block is wrong: set an explicit
// cheap model on the spawn (model:'haiku' or 'sonnet'), or set
// ANTIHALL_MODEL_ROUTING=advisory.
//
// ADVISORY DELIVERY: advisories ride PreToolUse additionalContext. On a harness
// that does not deliver it, advisories are inert no-ops (fail-open, nothing
// breaks); only the block path is guaranteed. A hook cannot enforce a harness
// min-version. This is a documented limitation.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { model?, subagent_type?, description?, prompt? }, ... }
//   block  : fs.writeSync(1, JSON { decision: "block", reason }) + exit 2
//   advise : fs.writeSync(1, JSON { hookSpecificOutput: { hookEventName, additionalContext } }) + exit 0
//   allow  : exit 0, no output
//   Fail-open on ANY error (exit 0). Honors the shared skip hatch.

'use strict';

const fs = require('fs');

// Bound the amount of stdin we scan for keywords. A pathological multi-MB prompt
// must not turn classification into a CPU sink. 128 KB covers any real brief.
const SCAN_LIMIT = 128 * 1024;

// Agent-tool `model` param is an ENUM token (sonnet|opus|haiku|fable), NOT a model
// id — so we match the exact tokens, not id segments. Unknown strings => allow
// (forward-compat: a new tier we don't know about must not be misrouted).
const FLAGSHIP_MODELS = new Set(['opus', 'fable']);

// Debate-role exemption: short metadata role words against the DESCRIPTION ONLY
// (narrowed from prompt-wide). A match downgrades a row-1 BLOCK to advisory — it
// never silences it, and never defeats strict row 2. Prompt-body role words do
// NOT exempt (keyword-stuffing the prompt must not buy a flagship pass).
const ROLE_WORD_RE = /\b(reviewer|auditor|critic|debate|deadly[- ]?loop)\b/i;

// Research/read-only signals for the Row-6 Explore-type advisory. Matched against
// the bounded corpus (raw, case-insensitive) — no tokenizer needed because the
// regex is word-boundary anchored (\b) so substring false hits (e.g. "searching"
// matching "search") are already blocked by the word-boundary rules.
// "look up" / "read-only" are multi-word; read[ -]?only also matches "readonly".
const RESEARCH_RE =
  /\b(research|investigate|find|search|audit|survey|read[ -]?only|locate|map|gather|explore|scout|look\s+up|trace|reconnaissance)\b/i;

// Write/execute signals that SUPPRESS the Row-6 Explore advisory. If the corpus
// contains any of these the task needs write/Agent tools that Explore lacks, so
// nudging toward Explore would recommend the wrong agent type. Checked against the
// bounded corpus (same RESEARCH_RE approach: raw, case-insensitive, \b-anchored).
// Prefix stems (modif, migrat, refactor, implement) match common inflections.
const WRITE_RE =
  /\b(write|edit|modif|commit|push|tag|release|bump|changelog|create\s+(?:a\s+|the\s+)?file|apply|patch|build|deploy|install|migrat|refactor|implement|fix)\b/i;

// Mechanical signals -> haiku (execution-only). Multi-word phrases are checked as
// adjacent tokens after tokenization (see hasToken / hasPhrase).
const MECHANICAL = [
  'fetch', 'download', 'curl', 'grep', 'glob', 'search files', 'run command',
  'run script', 'install', 'build', 'run tests', 'git push', 'deploy', 'dump',
  'export', 'tail', 'read logs', 'list', 'check status',
];

// Complex signals -> opus/fable. COMPLEX ANYWHERE (description OR prompt) => never
// block: a single planning signal vetoes the misroute classification.
// 'validate' is DELIBERATELY broad (R2-N3): it anchors the deadly-loop seat-brief
// interplay and errs fail-open — it can only suppress a block, never cause one.
const COMPLEX = [
  'plan', 'planning', 'design', 'architect', 'review', 'audit', 'regression',
  'coupling', 'merge order', 'critique', 'debate', 'validate', 'simulate',
  'root cause', 'workflow analysis', 'logic', 'mockup', 'security',
];

// Normalize for token matching: NFKC (fold homoglyph/compatibility forms) +
// casefold (lowercase). Then split into word tokens on non-letter/digit runs so
// matching is word-boundary-anchored (no substring false hits like "list" in
// "listen" — "listen" tokenizes whole and won't equal "list").
function tokenize(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  let t = s;
  try { t = t.normalize('NFKC'); } catch (_) { /* keep raw on bad input */ }
  t = t.toLowerCase();
  // Split on anything that is not a letter or digit (Unicode-aware).
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// hasPhrase(tokens, phrase): true when the phrase's word sequence appears as
// consecutive tokens. Single words reduce to a simple membership test.
function hasPhrase(tokens, phrase) {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return tokens.includes(parts[0]);
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      if (tokens[i + j] !== parts[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function countSignals(tokens, list) {
  let n = 0;
  for (const sig of list) if (hasPhrase(tokens, sig)) n++;
  return n;
}

// Advisory: nested hookSpecificOutput schema (KB §1.4, verify-first.js pattern).
// fs.writeSync(1, …) is synchronous so exit cannot race an async pipe flush.
function advise(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  };
  try { fs.writeSync(1, JSON.stringify(out) + '\n'); } catch (_) {}
  process.exit(0);
}

// Block: top-level {decision:"block", reason} + exit 2 (swarm-guard pattern). The
// reason does NOT advertise the skip hatch (a routing nudge, not an obstacle).
function block(reason) {
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
  process.exit(2);
}

function main() {
  // Read stdin (bounded scan downstream; read is unbounded but a brief is small).
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }

  // Escape hatch: honor an explicit, user-consented skip.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('model-routing-guard')) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); } // fail-open
  if (!payload || typeof payload !== 'object') process.exit(0);

  const input = (payload.tool_input && typeof payload.tool_input === 'object')
    ? payload.tool_input
    : {};

  // typeof-string guards on every field we read.
  const model = typeof input.model === 'string' ? input.model.trim().toLowerCase() : '';
  const modelOmitted = !(typeof input.model === 'string' && input.model.trim().length > 0);
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  // Bounded scan corpus: description + prompt, capped at SCAN_LIMIT.
  const corpus = (description + '\n' + prompt).slice(0, SCAN_LIMIT);
  const tokens = tokenize(corpus);

  const mechanical = countSignals(tokens, MECHANICAL);
  const complex = countSignals(tokens, COMPLEX);

  // COMPLEX-ANYWHERE veto: any planning signal => never block (rows 1-3 can't fire).
  const isMechanicalOnly = mechanical > 0 && complex === 0;

  // Strict mode (now the default). Env-driven; never inferred.
  // Set ANTIHALL_MODEL_ROUTING=advisory to revert to advisory-only behavior.
  const strict = process.env.ANTIHALL_MODEL_ROUTING !== 'advisory';

  // Exemption: role word against DESCRIPTION ONLY (description tokens, not prompt).
  // INTENTIONAL ASYMMETRY (R1-8): the role-word test runs on the RAW description
  // while mechanical/complex signals are NFKC-folded. A homoglyph in a role word
  // merely fails the exemption (conservative: BLOCK may stand, never silently
  // widened), so normalizing here would only enlarge the bypass surface.
  const exempt = ROLE_WORD_RE.test(description);

  // subagent_type qualifies for the generic-agent rows when missing OR
  // 'general-purpose'. A named custom type takes the row-3 advisory path.
  const isGenericAgent = subagentType === '' || subagentType === 'general-purpose';
  const isCustomAgent = subagentType !== '' && subagentType !== 'general-purpose';

  const isFlagship = FLAGSHIP_MODELS.has(model);

  // ---- Decision table (rows computed exemption-blind; modifier applied after) ----

  // Row 1: mechanical-only ∧ explicit flagship ∧ generic agent => BLOCK
  //        (exemption modifier may downgrade to advisory).
  if (isMechanicalOnly && !modelOmitted && isFlagship && isGenericAgent) {
    const blockReason =
      'anti-hall model-routing-guard: execution-shaped task on a flagship model ' +
      "(model: '" + model + "'). Respawn with model:'haiku' (or 'sonnet' if it " +
      'authors code). This hook cannot see the parent model; an explicit cheap ' +
      'model is required for execution-only work.';
    if (exempt) {
      advise(
        'MODEL-ROUTING (advisory, debate-role exempt): this spawn looks ' +
        "execution-shaped on a flagship model ('" + model + "'), but a debate-role " +
        'word in its description exempts it from blocking. If this is genuinely ' +
        "mechanical work, prefer model:'haiku'."
      );
    }
    block(blockReason);
  }

  // Row 2: mechanical-only ∧ flagship-or-not but model OMITTED ∧ generic agent.
  //   default (strict) : BLOCK UNCONDITIONALLY — no heuristic, NO exemption downgrade,
  //                      NO ~/.claude.json read ever.
  //   advisory opt-out : set ANTIHALL_MODEL_ROUTING=advisory to downgrade to advisory.
  if (isMechanicalOnly && modelOmitted && isGenericAgent) {
    if (strict) {
      block(
        'anti-hall model-routing-guard (strict, default): execution-shaped spawn ' +
        "with no explicit model. Set model:'haiku' (or 'sonnet' for code). Strict " +
        'is the default because an omitted model inherits the orchestrator\'s model ' +
        'and cannot be verified here — an omitted model on a flagship orchestrator ' +
        'silently produces an all-flagship swarm. Remedies: set an explicit cheap ' +
        "model on the spawn, or set ANTIHALL_MODEL_ROUTING=advisory to opt out of " +
        'blocking.'
      );
    }
    advise(
      'MODEL-ROUTING (advisory): this execution-shaped spawn sets no explicit ' +
      "model — an omitted model inherits the orchestrator's. Set model:'haiku' " +
      "(or 'sonnet' if it authors code) so mechanical work doesn't run on a flagship."
    );
  }

  // Row 3: mechanical-only ∧ explicit flagship ∧ NAMED custom subagent_type =>
  //        advisory (custom defs may pin models).
  if (isMechanicalOnly && !modelOmitted && isFlagship && isCustomAgent) {
    advise(
      "MODEL-ROUTING (advisory): execution-shaped task on a flagship model ('" +
      model + "') via a custom subagent_type ('" + subagentType + "'). If that " +
      "agent isn't pinned to a flagship for a reason, prefer model:'haiku'."
    );
  }

  // Row 4: complex ∧ explicit haiku => advisory (planning-shaped task on haiku).
  if (complex > 0 && model === 'haiku') {
    advise(
      'MODEL-ROUTING (advisory): this looks planning-shaped (review/plan/audit/' +
      'design) but runs on haiku — consider opus or fable for deeper reasoning.'
    );
  }

  // Row 6: research/read-only-shaped ∧ generic agent => advisory (suggest Explore).
  //
  // A general-purpose spawn carries the Agent tool and CAN recurse (general-purpose
  // → general-purpose chains waste ~7x tokens by depth 5). The Explore agent type
  // has WebSearch/WebFetch but NO Agent tool, so it structurally CANNOT recurse.
  // This is advisory-only: a research spawn on general-purpose is legitimate, just
  // suboptimal. Only fires for generic agents (subagent_type '' or 'general-purpose');
  // named types (Explore, codex:*, custom) are already non-generic and skip this row.
  //
  // SUPPRESSED when the corpus contains write/execute signals (WRITE_RE): tasks that
  // commit, edit, build, release, etc. need write/Agent tools that Explore lacks —
  // nudging them toward Explore would recommend the wrong agent type (false-positive
  // guard added v0.37.x after a release agent was wrongly nudged due to "audit/find"
  // in its description).
  if (isGenericAgent && RESEARCH_RE.test(corpus) && !WRITE_RE.test(corpus)) {
    advise(
      'AGENT-ROUTING (advisory): this spawn looks research/read-only-shaped but uses ' +
      "subagent_type:'general-purpose', which carries the Agent tool and can recurse " +
      '(general-purpose → general-purpose chains waste ~7x tokens by depth 5). ' +
      "Consider re-dispatching as subagent_type:'Explore' — it has WebSearch/WebFetch " +
      'but NO Agent tool, so it structurally cannot recurse. Only keep general-purpose ' +
      'if the task genuinely needs to write files or spawn sub-agents.'
    );
  }

  // Row 5: everything else (mixed signals, no signals, unknown model, explicit
  //        haiku/sonnet on mechanical, etc.) => allow, silent.
  process.exit(0);
}

try {
  main();
} catch (_) {
  // Fail-open on ANY error.
}
process.exit(0);
