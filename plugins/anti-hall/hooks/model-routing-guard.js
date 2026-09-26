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
// generic agent), and even then a debate-role exemption AND a research-shaped
// exemption apply (a research/investigate-flavored task with no unambiguous
// execution verb present downgrades to advisory, never a hard block).
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
const os = require('os');
const path = require('path');

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

// Subset of MECHANICAL that is UNAMBIGUOUSLY execution (ship/run/change something) —
// as opposed to data-I/O verbs ('export', 'dump', 'list', 'check status', etc.) that
// are equally at home as the reporting step of a genuine investigation. Used ONLY to
// gate the research exemption below: a hard-execution signal always means "no, this
// really is mechanical," even if a research word is also present.
const HARD_EXECUTION = ['run script', 'install', 'build', 'run tests', 'git push', 'deploy'];

// DEPLOY / MIGRATION / SECRET FLOOR (0.112, setting guards.modelRoutingDeployFloor,
// default 'sonnet'). Production deploys, migrations, rollbacks and secret/credential
// work are exactly where auth/secret edge cases get mishandled by a cheap model, so
// the guard must never push such a spawn toward haiku. A deploy-shaped spawn:
//   - at or above the floor: the rows that push toward haiku (1 and 3; row 2 cannot
//     apply to an explicit model) are suppressed — every other row still evaluates;
//   - below the floor, or with no explicit model: an ADVISORY naming the floor
//     replaces the haiku push (row 2's omitted-model block included). Never a block.
// 'off' restores the plain table.
// DEPLOY-SHAPED = one STRONG action signal (deploy/migrate/rollback/rotation/infra
// tool), or TWO distinct WEAK context words (prod, production, secret, credential).
// A single stray weak word ("grep for TODO, no secrets") is not enough.
const DEPLOY_STRONG_RE =
  /\b(deploy\w*|redeploy\w*|migrat\w*|rollbacks?|roll\s+back|token\s+rotation|rotat\w*\s+(?:the\s+|a\s+)?(?:api\s+)?(?:tokens?|keys?|secrets?|credentials?)|wrangler|terraform|kubectl\s+apply|helm\s+(?:install|upgrade)|firebase\s+deploy|db\s+migrate)\b/i;
const DEPLOY_WEAK_RE = /\b(prod|production|secrets?|credentials?)\b/gi;
function isDeployShaped(corpus) {
  if (DEPLOY_STRONG_RE.test(corpus)) return true;
  const kinds = new Set();
  for (const m of corpus.matchAll(DEPLOY_WEAK_RE)) {
    kinds.add(m[1].toLowerCase().replace(/s$/, '').replace(/^production$/, 'prod'));
  }
  return kinds.size >= 2;
}
const MODEL_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };

// Complex signals -> opus/fable. COMPLEX ANYWHERE (description OR prompt) => never
// block: a single planning signal vetoes the misroute classification.
// 'validate' is DELIBERATELY broad (R2-N3): it anchors the deadly-loop seat-brief
// interplay and errs fail-open — it can only suppress a block, never cause one.
const COMPLEX = [
  'plan', 'planning', 'design', 'architect', 'review', 'audit', 'regression',
  'coupling', 'merge order', 'critique', 'debate', 'validate', 'simulate',
  'root cause', 'workflow analysis', 'logic', 'mockup', 'security',
];

// Row-4 ONLY (planning-shaped-on-haiku advisory) uses a STRICTER intent regex,
// not the broad COMPLEX list above. Field data (2026-09-25, ~316 real haiku
// spawns sampled from this project's own transcripts) showed COMPLEX's bare
// single words ('review', 'audit', 'design', 'plan', 'root cause', 'regression',
// 'logic') false-positiving at a 24% rate on mechanical work — matching inside
// backtick-quoted config keys/CLI flags (`jev.audit.snippets`), inside ledger
// content being copied verbatim ("## Release v0.95.0 ... design decision..."),
// and against generic status/report/check words that were never actually in
// COMPLEX but rode along with it. PLANNING_INTENT_RE requires an actual planning
// VERB PHRASE (design/plan + article, deep/code/security review, brainstorm,
// architecture, root-cause/regression ANALYSIS, security audit, etc.), matched
// only against the corpus with backtick-quoted spans stripped (mechanical CLI
// syntax and config keys live there). Row 4 is additionally suppressed only
// when the corpus is read-only (READONLY_RE) AND mechanical (MECHANICAL_SHAPE_RE:
// fixed commands, "run exactly", "return ≤N lines") AND carries no review/
// design/audit/analysis verb (REVIEW_DESIGN_VERB_RE). Read-only alone never
// suppresses: "read-only code review/security audit of X" is genuine planning
// that a read-only marker must not hide.
// COMPLEX itself is UNCHANGED and still backs the Rows 1-3 veto (being generous
// there only prevents a block, which is the safe direction).
const PLANNING_INTENT_RE =
  /\b(architect(?:ure)?|brainstorm|design\s+(?:a|the|an)\b|plan\s+(?:a|the|an|out)\b|deep\s+review|code\s+review|design\s+review|security\s+review|review\s+the\s+(?:code|design|architecture|plan)|review\s+(?:this|the|a)\s+(?:pr|pull\s+request|diff|patch|change(?:s|set)?)|audit\s+(?:the|this)\b|critique|debate|merge\s+order|workflow\s+analysis|root[- ]cause\s+analysis|(?:find|identify|determine|diagnose|trace)\s+(?:the\s+)?root[- ]cause|root[- ]cause\s+(?:why|how|the|this)|regression\s+analysis|security\s+audit)\b/i;

const READONLY_RE =
  /\b(verbatim|read[- ]?only|mechanical|append\s*only|run\s+exactly|do\s+nothing\s+else|nothing\s+else|no\s+other\s+file\s+edits|no\s+repo\s+edits|no\s+source\s+edits)\b/i;

// Fixed-command / bounded-output shape: the caller already decided WHAT to do.
const MECHANICAL_SHAPE_RE =
  /\b(run\s+exactly|run\s+only|run\s+(?:this|these|the\s+following)\s+(?:exact\s+)?commands?|exactly\s+(?:this|these)\s+commands?|verbatim|append\s*only|do\s+nothing\s+else|nothing\s+else|return\s+(?:only\s+)?(?:at\s+most\s+|no\s+more\s+than\s+|under\s+|up\s+to\s+)?\d+\s+lines?)\b|return\s+(?:only\s+)?(?:≤|<=)\s*\d+\s+lines?\b/i;

// A review/design/analysis verb anywhere (code spans stripped) keeps Row 4 live.
const REVIEW_DESIGN_VERB_RE =
  /\b(review|audit|design|architect(?:ure)?|plan|brainstorm|critique|analy[sz]e|analysis|investigate|root[- ]cause)\b/i;

function readOnlyMechanical(corpus) {
  return READONLY_RE.test(corpus) && MECHANICAL_SHAPE_RE.test(corpus)
    && !REVIEW_DESIGN_VERB_RE.test(stripCodeSpans(corpus));
}

// Strip fenced/inline code spans before Row-4 intent matching — mechanical CLI
// syntax and dotted config keys (e.g. `jev.audit.snippets`) live inside them and
// must not count as planning-intent language.
function stripCodeSpans(s) {
  return s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

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

// HANDOVER-DELEGATION ADVISORY (owner amendment 2026-08-07, thread 1). A
// field failure showed a session delegating handover-writing to a subagent
// EVEN AFTER loading the handover skill — a subagent never lived the session,
// so its reconstruction loses decision/trial fidelity. This is a SEPARATE,
// advisory-only concern from the model-tier routing table above: it fires on
// intent (handover|handoff AND write|prepare|create|author|draft), independent
// of model/subagent_type, and NEVER blocks. Capped once per session via its
// own state file so it nudges exactly once, not on every spawn.
const HANDOVER_NOUN_RE = /\b(handover|handoff)\b/i;
const HANDOVER_VERB_RE = /\b(write|prepare|create|author|draft)\b/i;

function handoverDelegationAdvisory(payload, corpus) {
  if (!HANDOVER_NOUN_RE.test(corpus) || !HANDOVER_VERB_RE.test(corpus)) return;
  const rawSessionId = payload && payload.session_id != null ? String(payload.session_id) : '';
  const safeSession = (rawSessionId || 'unknown-session').replace(/[^A-Za-z0-9_.-]/g, '_');
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'model-routing-guard-handover-state-' + safeSession + '.json');
  try {
    if (fs.existsSync(stateFile)) return; // already advised this session
  } catch (_) {
    return; // can't check the cap -> fail-open, stay silent rather than risk a loop
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ advised: true }), 'utf8');
  } catch (_) {
    return; // can't persist the cap -> fail-open, don't advise uncapped
  }
  advise(
    'HANDOVER-DELEGATION (advisory): this spawn looks like it is being asked to write/prepare ' +
    'a session handover. The handover must be authored by the session holding the memory — ' +
    'invoke the handover skill yourself, do not delegate the writing. A subagent never lived ' +
    'this session, so its reconstruction loses decision/trial fidelity.'
  );
}

// JEV (opt-in, default mode SHADOW — see lib/jev-assist.js). Consulted ONLY on
// the two "block a flagship/omitted-model mechanical spawn" paths below (Rows
// 1-2), via the 'relax-block' trust rule: Jev may only turn a block that was
// about to fire into an advisory, never the reverse, and it is never
// consulted on an allow/advisory-only row. In SHADOW mode (the default for
// this integration — jev.json must set integrations.modelRouting:"on" to let
// it actually relax a block) Jev is still called and logged for `jev report`,
// but the block always proceeds unchanged.
const JEV_ROUTING_QUESTION = {
  type: 'choice',
  instructions:
    'Classify the SHAPE of this agent-spawn task from its description/prompt.',
  criteria: {
    mechanical: 'Execution-only: running commands, fetching/building/testing/' +
      'deploying, no authoring or judgment calls required.',
    authoring: 'Writing or editing substantial code/content that requires judgment.',
    research: 'Investigation, research, or audit work — read-only or reporting.',
    'plan-review': 'Planning, architecture, review, critique, or debate work.',
  },
};

// consultModelRoutingJev(corpus) -> true when Jev confidently relaxed this
// block to an advisory (mode "on" + non-mechanical answer above threshold).
// Fully synchronous (askSync spawns the Jev call in a subprocess with its own
// hard timeout) since this hook's main() cannot await. Any failure -> false
// (block proceeds), matching jev-assist's own fail-open contract.
function consultModelRoutingJev(corpus, payload) {
  try {
    const { askSync } = require('./lib/jev-assist.js');
    const result = askSync({
      id: 'modelRouting',
      question: JEV_ROUTING_QUESTION,
      state: String(corpus).slice(0, 4000),
      trust: 'relax-block',
      baseline: true,
      judge: (answer) => answer === 'mechanical',
      budgetMs: 1200,
      sessionId: payload && payload.session_id != null ? String(payload.session_id) : undefined,
    });
    return result.final === false;
  } catch (_) {
    return false;
  }
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
  // Settings switch guards.modelRouting (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('guards', 'modelRouting')) return; } catch (_) { /* run */ }
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

  // Handover-delegation advisory runs FIRST and independently of the model-tier
  // table below — it is about WHO writes the handover, not which model runs it.
  // advise() exits the process when it fires; a no-match/already-capped call
  // returns normally and the model-tier table below still runs.
  handoverDelegationAdvisory(payload, corpus);

  const tokens = tokenize(corpus);

  const mechanical = countSignals(tokens, MECHANICAL);
  const complex = countSignals(tokens, COMPLEX);

  // COMPLEX-ANYWHERE veto: any planning signal => never block (rows 1-3 can't fire).
  const isMechanicalOnly = mechanical > 0 && complex === 0;

  // Strict mode (now the default). Setting guards.modelRouting (env
  // ANTIHALL_MODEL_ROUTING > settings.json > /config > 'strict'); never inferred.
  // 'advisory' reverts to advisory-only behavior ('off' already returned above).
  let routingMode = 'strict';
  try { routingMode = require('./lib/settings.js').get('guards', 'modelRouting'); } catch (_) { routingMode = process.env.ANTIHALL_MODEL_ROUTING; }
  const strict = routingMode !== 'advisory';

  // Exemption: role word against DESCRIPTION ONLY (description tokens, not prompt).
  // INTENTIONAL ASYMMETRY (R1-8): the role-word test runs on the RAW description
  // while mechanical/complex signals are NFKC-folded. A homoglyph in a role word
  // merely fails the exemption (conservative: BLOCK may stand, never silently
  // widened), so normalizing here would only enlarge the bypass surface.
  const exempt = ROLE_WORD_RE.test(description);

  // Research exemption: a RESEARCH_RE signal (investigate/audit/trace/etc) downgrades
  // Row 1's block to advisory too, UNLESS a HARD_EXECUTION verb is also present. This
  // closes a real gap: RESEARCH_RE was previously consulted only by Row 6 (advisory),
  // which never runs once Row 1 has already blocked+exited — so a genuinely
  // research-shaped task (e.g. "investigate X, export the findings") could get
  // hard-blocked just because it used a data-I/O verb ('export'/'dump'/'list'/'check
  // status') from MECHANICAL instead of one of the 17 exact COMPLEX words. Gating on
  // "no HARD_EXECUTION verb" keeps the guard's actual anti-waste purpose intact: a
  // task that says 'deploy'/'install'/'build'/etc is still unambiguously mechanical
  // regardless of any research word also present, so it still blocks.
  const hardExecution = countSignals(tokens, HARD_EXECUTION) > 0;
  const researchExempt = !hardExecution && RESEARCH_RE.test(corpus);

  // subagent_type qualifies for the generic-agent rows when missing OR
  // 'general-purpose'. A named custom type takes the row-3 advisory path.
  const isGenericAgent = subagentType === '' || subagentType === 'general-purpose';
  const isCustomAgent = subagentType !== '' && subagentType !== 'general-purpose';

  const isFlagship = FLAGSHIP_MODELS.has(model);

  // Deploy/migration/secret floor (see isDeployShaped): runs BEFORE rows 1-4 so no
  // row can steer this spawn toward haiku; it only ever suppresses those rows.
  let deployFloor = 'sonnet';
  try { deployFloor = require('./lib/settings.js').get('guards', 'modelRoutingDeployFloor'); } catch (_) { deployFloor = 'sonnet'; }
  let suppressHaikuRows = false;
  if (deployFloor !== 'off' && isDeployShaped(corpus)) {
    const floor = MODEL_RANK[deployFloor] ? deployFloor : 'sonnet';
    if (modelOmitted) {
      advise(
        'MODEL-ROUTING (advisory, deploy/migration/secret-shaped): this spawn sets no ' +
        "explicit model. Deploys, migrations and secret/credential work need at least " +
        "model:'" + floor + "' — never haiku (auth/secret edge cases get mishandled)."
      );
    }
    if (MODEL_RANK[model] && MODEL_RANK[model] < MODEL_RANK[floor]) {
      advise(
        "MODEL-ROUTING (advisory, deploy/migration/secret-shaped): this spawn runs on '" +
        model + "'. Deploys, migrations and secret/credential work need at least " +
        "model:'" + floor + "' (auth/secret edge cases get mishandled by a cheap model)." +
        // Keep Row 4's planning-shaped note when it would also have fired.
        (model === 'haiku' && !readOnlyMechanical(corpus) && PLANNING_INTENT_RE.test(stripCodeSpans(corpus))
          ? ' It also looks planning-shaped (architecture/design/plan/brainstorm/deep review) — consider opus or fable for deeper reasoning.'
          : '')
      );
    }
    suppressHaikuRows = true; // at/above the floor (or an unknown tier): rows 1 and 3 never fire
  }

  // ---- Decision table (rows computed exemption-blind; modifier applied after) ----

  // Row 1: mechanical-only ∧ explicit flagship ∧ generic agent => BLOCK
  //        (exemption modifier may downgrade to advisory).
  if (!suppressHaikuRows && isMechanicalOnly && !modelOmitted && isFlagship && isGenericAgent) {
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
    if (researchExempt) {
      advise(
        'MODEL-ROUTING (advisory, research-shaped exempt): this spawn looks ' +
        "execution-shaped on a flagship model ('" + model + "'), but it also reads " +
        'as research/investigation work with no unambiguous execution verb present, ' +
        'so it is exempt from blocking. If this is genuinely mechanical work, prefer ' +
        "model:'haiku' (or 'sonnet' if it authors code)."
      );
    }
    if (consultModelRoutingJev(corpus, payload)) {
      advise(
        'MODEL-ROUTING (advisory, Jev-relaxed): this spawn looks execution-shaped ' +
        "on a flagship model ('" + model + "') by keyword, but Jev classified it as " +
        'non-mechanical with high confidence, so the block is downgraded to this ' +
        "advisory. If this is genuinely mechanical work, prefer model:'haiku'."
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
      if (consultModelRoutingJev(corpus, payload)) {
        advise(
          'MODEL-ROUTING (advisory, Jev-relaxed): this omitted-model spawn looks ' +
          'execution-shaped by keyword, but Jev classified it as non-mechanical ' +
          "with high confidence, so the strict block is downgraded to this " +
          "advisory. If this is genuinely mechanical work, prefer model:'haiku'."
        );
      }
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
  if (!suppressHaikuRows && isMechanicalOnly && !modelOmitted && isFlagship && isCustomAgent) {
    advise(
      "MODEL-ROUTING (advisory): execution-shaped task on a flagship model ('" +
      model + "') via a custom subagent_type ('" + subagentType + "'). If that " +
      "agent isn't pinned to a flagship for a reason, prefer model:'haiku'."
    );
  }

  // Row 4: genuine planning-intent phrase ∧ explicit haiku => advisory
  // (planning-shaped task on haiku). Uses PLANNING_INTENT_RE (stricter than
  // COMPLEX — see its comment above), matched with code spans stripped, and
  // suppressed only when the corpus is read-only AND mechanical with no
  // review/design verb (readOnlyMechanical).
  if (model === 'haiku' &&
      !readOnlyMechanical(corpus) &&
      PLANNING_INTENT_RE.test(stripCodeSpans(corpus))) {
    advise(
      'MODEL-ROUTING (advisory): this looks planning-shaped (architecture/design/' +
      'plan/brainstorm/deep review) but runs on haiku — consider opus or fable for ' +
      'deeper reasoning.'
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
