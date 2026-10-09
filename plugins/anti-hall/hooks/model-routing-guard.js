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
  /\b(write|edit|modif|commit|push|changelog|create\s+(?:an?\s+|the\s+|new\s+)?files?|migrat|refactor|implement)\b/i;

// Ambiguous stems (also nouns: "the build", "release tag", "patch notes", "fixes") count
// as write signals only in INSTRUCTION position: at the start of a line/sentence or
// after then/and/also/please/to ("Fix the bug", "...then build it", "and install deps").
const WRITE_IMPERATIVE_RE =
  /(?:^|[.;:!?]\s+|\b(?:then|and|also|please|to)\s+)(?:tag|release|bump|apply|patch|build|deploy|install|fix)\b/im;

// Imperative/object forms a bare word would over-match ("find where save is handled",
// "the clone logic", "places that run the generator" are read-only): save ... to <path>,
// clone <repo> into/to <path>, git clone / git format-patch, or run the generator/
// tests/build as an instruction (sentence start, "then", "and").
const WRITE_PHRASE_RE =
  /\bsave\s+(?:[\w-]+\s+){0,4}?(?:to|into)\s+\S|\bclone\s+(?:\S+\s+){0,3}?(?:into|to)\s+\S|\bgit\s+(?:clone|format-patch)\b|(?:^|[.;:]\s+|\b(?:then|and)\s+)run\s+(?:the\s+)?(?:generators?|tests?|test\s+suite|build)\b/im;

// A brief that tells the agent to commit (or to open a git worktree) is a writing brief however many read-only words it quotes
// (dogfood 2026-10-09: a fix brief naming the check "read-only-shaped" was judged read-only). A negated commit ("never commit",
// "do not push") is removed first, so a genuinely read-only brief stays read-only. Unlike READONLY_OVERRIDE_RE this is not overridable.
const COMMIT_PHRASE_RE =
  /\bgit\s+(?:commit|push|worktree\s+add|checkout\s+-b)\b|\bcommit(?:s|ting)?\s+(?:per|each|every|it\b|them\b|your\b|after|before|the\s+(?:fix|fixes|change|changes|work)|with\s+a)\b|\bcommit\s+(?:and|&)\s+push\b/i;
const NEGATED_COMMIT_RE = /\b(?:do\s+not|don'?t|never|without|no)\s+(?:\w+\s+){0,3}?(?:git\s+)?(?:commit|push|worktree)\w*(?:\s*(?:,|or|and|nor)\s+(?:git\s+)?(?:commit|push|worktree)\w*)*/gi;

// Explicit read-only statements. They override the ambiguous/bare WRITE_RE and
// imperative stems, but NOT WRITE_PHRASE_RE (saving a report file is still a write).
const READONLY_OVERRIDE_RE =
  /\b(?:report\s+only|read[- ]?only|(?:do\s+not|don'?t|never)\s+(?:edit|modify|write|change|commit)|no\s+(?:edits|changes|writes))\b/i;

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
const DEPLOY_STRONG_RE = new RegExp(
  [
    '\\b(deploy\\w*|redeploy\\w*|migrat\\w*|rollbacks?|roll\\s+back|token\\s+rotation|',
    'rotat\\w*\\s+(?:the\\s+|a\\s+)?(?:api\\s+)?(?:tokens?|keys?|secrets?|credentials?)|wrangler|',
    'terraform|kubectl\\s+apply|helm\\s+(?:install|upgrade)|firebase\\s+deploy|db\\s+migrate)\\b',
  ].join(''),
  'i',
);
const DEPLOY_WEAK_RE = /\b(prod|production|secrets?|credentials?)\b/gi;
function isDeployShaped(corpus) {
  if (DEPLOY_STRONG_RE.test(corpus)) return true;
  const kinds = new Set();
  for (const m of corpus.matchAll(DEPLOY_WEAK_RE)) {
    kinds.add(m[1].toLowerCase().replace(/s$/, '').replace(/^production$/, 'prod'));
  }
  return kinds.size >= 2;
}
// A spawn brief that RUNS anti-hall's update helper (see main()).
const UPDATE_NODE_RE = /\bnode\s+["']?\S*update\.js\b/i;
const UPDATE_SKILL_PATH_RE = /\bnode\s+["']?\S*skills[\\/]update[\\/]scripts[\\/]update\.js\b/i;
const UPDATE_SLASH_RE = /\b(?:run|invoke|execute)\s+`?\/anti-hall:update\b/i;
function runsAntiHallUpdate(corpus) {
  return UPDATE_SKILL_PATH_RE.test(corpus) || UPDATE_SLASH_RE.test(corpus) ||
    (UPDATE_NODE_RE.test(corpus) && /anti-hall/i.test(corpus));
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
const PLANNING_INTENT_RE = new RegExp(
  [
    '\\b(architect(?:ure)?|brainstorm|design\\s+(?:a|the|an)\\b|plan\\s+(?:a|the|an|out)\\b|',
    'deep\\s+review|code\\s+review|design\\s+review|security\\s+review|review\\s+the\\s+(?:code|design|',
    'architecture|plan)|review\\s+(?:this|the|a)\\s+(?:pr|pull\\s+request|diff|patch|change(?:s|set)?)|',
    'audit\\s+(?:the|this)\\b|critique|debate|merge\\s+order|workflow\\s+analysis|',
    'root[- ]cause\\s+analysis|(?:find|identify|determine|diagnose|trace)\\s+(?:the\\s+)?root[- ]cause|',
    'root[- ]cause\\s+(?:why|how|the|this)|regression\\s+analysis|security\\s+audit)\\b',
  ].join(''),
  'i',
);

const READONLY_RE =
  /\b(verbatim|read[- ]?only|mechanical|append\s*only|run\s+exactly|do\s+nothing\s+else|nothing\s+else|no\s+other\s+file\s+edits|no\s+repo\s+edits|no\s+source\s+edits)\b/i;

// Fixed-command / bounded-output shape: the caller already decided WHAT to do.
const MECHANICAL_SHAPE_RE = new RegExp(
  [
    '\\b(run\\s+exactly|run\\s+only|run\\s+(?:this|these|the\\s+following)\\s+(?:exact\\s+)?commands?|',
    'exactly\\s+(?:this|these)\\s+commands?|verbatim|append\\s*only|do\\s+nothing\\s+else|nothing\\s+else|',
    'return\\s+(?:only\\s+)?(?:at\\s+most\\s+|no\\s+more\\s+than\\s+|under\\s+|up\\s+to\\s+)?\\d+\\s+lines?)\\b|',
    'return\\s+(?:only\\s+)?(?:≤|<=)\\s*\\d+\\s+lines?\\b',
  ].join(''),
  'i',
);

// A review/design/analysis verb anywhere (code spans stripped) keeps Row 4 live.
const REVIEW_DESIGN_VERB_RE =
  /\b(review|audit|design|architect(?:ure)?|plan|brainstorm|critique|analy[sz]e|analysis|investigate|root[- ]cause)\b/i;

// REASONING signals (L33): heavy reading + synthesis/reconciliation is not
// mechanical even when the brief also says commit/push/list/export. Like COMPLEX
// this can only VETO a block (isMechanicalOnly), never cause one. Matched with
// code spans stripped (config keys / CLI syntax must not count). investigate/
// research are NOT here: they keep their own RESEARCH_RE path (a HARD_EXECUTION
// verb still blocks them). A bare "read X"
// is not enough — it needs a non-trivial source (document/pdf/paper/N-page/
// "page by page"), so "read logs" and "run npm test and report" stay mechanical.
const REASONING_RE = new RegExp(
  [
    '\\b(analy[sz]\\w*|synthesi[sz]\\w*|summari[sz]\\w*|reconcil\\w*|evaluat\\w*|interpret\\w*|distill\\w*|',
    'compare|comparison)\\b|\\bread\\w*\\b[^.\\n]{0,60}\\b(?:pdf|pdfs|pages?|papers?|documents?|specs?|',
    'transcripts?|articles?|books?|manuals?|whitepapers?)\\b|\\b\\d+[- ]page\\b|\\bpage[- ]by[- ]page\\b',
  ].join(''),
  'i',
);
function isReasoningShaped(corpus) {
  return REASONING_RE.test(stripCodeSpans(corpus));
}

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
  advise(bmsg.message({
    kind: 'tip',
    guard: 'handover',
    what: 'this spawn looks like it writes a session handover.',
    why: 'A subagent never lived this session, so its reconstruction loses decision/trial fidelity.',
    instead: 'invoke the handover skill yourself in the session that holds the memory.',
  }));
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
      recordDisagreement: true, // log would-change (+ audit snippet) whenever Jev's tier differs from the rule-based verdict
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
const bmsg = require('./lib/block-message.js');
// tip(what, instead, why) -> advisory text in the shared shape.
const tip = (what, instead, why) => bmsg.message({ kind: 'warn', guard: 'model-routing', what, why, instead });

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

  // anti-hall's own update must run in the MAIN session (update.js runs
  // migrations; the main session judges a failure). Block a spawn whose brief RUNS
  // it: `node <..>/update.js` under skills/update/scripts (or any `node .../update.js`
  // in a brief that names anti-hall), or an explicit "run /anti-hall:update".
  // A brief that merely mentions updating something else does not match.
  try {
    if (require('./lib/settings.js').enabled('guards', 'updateInSession') && runsAntiHallUpdate(corpus)) {
      block(bmsg.blockMessage({
        guard: 'model-routing-guard',
        what: 'a subagent spawn that runs the anti-hall update is blocked.',
        why: 'update.js runs migrations and the main session must judge the result.',
        instead: 'run `node <path>/update.js ...` directly in the main session.',
      }));
    }
  } catch (_) { /* fail-open */ }

  // Handover-delegation advisory runs FIRST and independently of the model-tier
  // table below — it is about WHO writes the handover, not which model runs it.
  // advise() exits the process when it fires; a no-match/already-capped call
  // returns normally and the model-tier table below still runs.
  handoverDelegationAdvisory(payload, corpus);

  const tokens = tokenize(corpus);

  const mechanical = countSignals(tokens, MECHANICAL);
  const complex = countSignals(tokens, COMPLEX);

  // COMPLEX-ANYWHERE veto: any planning signal => never block (rows 1-3 can't fire).
  // L33: heavy reading/synthesis (REASONING_RE) vetoes the same way, so such a
  // brief is never blocked nor told to use haiku just because it also commits/lists.
  const isMechanicalOnly = mechanical > 0 && complex === 0 && !isReasoningShaped(corpus);

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
      advise(tip(
        'deploy/migration/secret-shaped spawn sets no explicit model.',
        "set model:'" + floor + "' or higher, never haiku.",
        'Auth/secret edge cases get mishandled by a cheap model.'
      ));
    }
    if (MODEL_RANK[model] && MODEL_RANK[model] < MODEL_RANK[floor]) {
      advise(tip(
        "deploy/migration/secret-shaped spawn runs on '" + model + "'.",
        "use model:'" + floor + "' or higher." +
          // Keep Row 4's planning-shaped note when it would also have fired.
          (model === 'haiku' && !readOnlyMechanical(corpus) && PLANNING_INTENT_RE.test(stripCodeSpans(corpus))
            ? ' It also looks planning-shaped; consider opus or fable for deeper reasoning.'
            : ''),
        'Auth/secret edge cases get mishandled by a cheap model.'
      ));
    }
    suppressHaikuRows = true; // at/above the floor (or an unknown tier): rows 1 and 3 never fire
  }

  // ---- Decision table (rows computed exemption-blind; modifier applied after) ----

  // Row 1: mechanical-only ∧ explicit flagship ∧ generic agent => BLOCK
  //        (exemption modifier may downgrade to advisory).
  if (!suppressHaikuRows && isMechanicalOnly && !modelOmitted && isFlagship && isGenericAgent) {
    const blockReason = bmsg.blockMessage({
      guard: 'model-routing-guard',
      what: "execution-shaped task on a flagship model (model: '" + model + "') is blocked.",
      why: 'This hook cannot see the parent model; execution-only work needs an explicit cheap model.',
      instead: "respawn with model:'haiku' (or 'sonnet' if it authors code).",
    });
    if (exempt) {
      advise(tip(
        "execution-shaped spawn on a flagship model ('" + model + "'), exempt because a debate-role word is in its description.",
        "if it is genuinely mechanical work, prefer model:'haiku'."
      ));
    }
    if (researchExempt) {
      advise(tip(
        "execution-shaped spawn on a flagship model ('" + model + "'), exempt from blocking because it reads as research with no unambiguous execution verb."
      ));
    }
    if (consultModelRoutingJev(corpus, payload)) {
      advise(tip(
        "execution-shaped spawn on a flagship model ('" + model + "'); Jev judged it non-mechanical, so the block is downgraded.",
        "if it is genuinely mechanical work, prefer model:'haiku'."
      ));
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
        advise(tip(
          'omitted-model spawn looks execution-shaped; Jev judged it non-mechanical, so the strict block is downgraded.',
          "if it is genuinely mechanical work, prefer model:'haiku'."
        ));
      }
      block(bmsg.blockMessage({
        guard: 'model-routing-guard',
        what: 'execution-shaped spawn with no explicit model is blocked (strict default).',
        why: "An omitted model inherits the orchestrator's and cannot be verified here; on a flagship orchestrator that silently makes an all-flagship swarm.",
        instead: "set model:'haiku' (or 'sonnet' for code) on the spawn.",
        override: 'set ANTIHALL_MODEL_ROUTING=advisory to downgrade this block to an advisory',
      }));
    }
    advise(tip(
      'execution-shaped spawn sets no explicit model.',
      "set model:'haiku' (or 'sonnet' if it authors code).",
      "An omitted model inherits the orchestrator's, so mechanical work may run on a flagship."
    ));
  }

  // Row 3: mechanical-only ∧ explicit flagship ∧ NAMED custom subagent_type =>
  //        advisory (custom defs may pin models).
  if (!suppressHaikuRows && isMechanicalOnly && !modelOmitted && isFlagship && isCustomAgent) {
    advise(tip(
      "execution-shaped task on a flagship model ('" + model + "') via custom subagent_type '" + subagentType + "'.",
      "unless that agent is pinned to a flagship on purpose, prefer model:'haiku'."
    ));
  }

  // Row 4: genuine planning-intent phrase ∧ explicit haiku => advisory
  // (planning-shaped task on haiku). Uses PLANNING_INTENT_RE (stricter than
  // COMPLEX — see its comment above), matched with code spans stripped, and
  // suppressed only when the corpus is read-only AND mechanical with no
  // review/design verb (readOnlyMechanical).
  if (model === 'haiku' &&
      !readOnlyMechanical(corpus) &&
      PLANNING_INTENT_RE.test(stripCodeSpans(corpus))) {
    advise(tip(
      'planning-shaped task (architecture/design/plan/brainstorm/deep review) runs on haiku.',
      'consider opus or fable for deeper reasoning.'
    ));
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
  const writeShaped = WRITE_PHRASE_RE.test(corpus) || COMMIT_PHRASE_RE.test(corpus.replace(NEGATED_COMMIT_RE, ' ')) ||
    (!READONLY_OVERRIDE_RE.test(corpus) && (WRITE_RE.test(corpus) || WRITE_IMPERATIVE_RE.test(corpus)));
  if (isGenericAgent && RESEARCH_RE.test(corpus) && !writeShaped) {
    advise(tip(
      "research/read-only-shaped spawn uses subagent_type:'general-purpose'.",
      "re-dispatch as subagent_type:'Explore' (WebSearch/WebFetch, no Agent tool, so it cannot recurse). Keep general-purpose only if it must write files or spawn sub-agents.",
      'general-purpose carries the Agent tool and can recurse; chains waste ~7x tokens by depth 5.'
    ));
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
