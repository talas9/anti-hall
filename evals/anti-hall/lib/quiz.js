'use strict';
// B3 quiz grading (docs/BENCHMARK-METHOD.md Amendment 3 §B3): deterministic regex
// match of a fixed JSON answer block against 10 planted facts per seed.
//
// quiz spec (lives in the manifest case entry, written by the seed author):
//   { facts: [{ id, stratum: 'workspace'|'conversation'|'superseded', accept: '<regex>', decoy?: '<regex>' }] }
// Answer block: the LAST ```json fenced block, else the last balanced {...} in the
// message, shaped { "<id>": "<answer text>" }. Missing/unparseable block: every fact wrong.

function extractAnswerBlock(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) { const o = tryParse(fences[i][1]); if (o) return o; }
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = s.lastIndexOf('{', start - 1)) {
      const o = tryParse(s.slice(start, end + 1));
      if (o) return o;
    }
  }
  return null;
}

function tryParse(t) {
  try { const o = JSON.parse(t.trim()); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; }
}

function gradeQuiz(quiz, finalMessage) {
  const block = extractAnswerBlock(finalMessage);
  const facts = {}, decoys = {};
  const strata = {};
  for (const f of quiz.facts) {
    const ans = block && f.id in block ? String(block[f.id]) : '';
    const ok = !!ans && new RegExp(f.accept, 'i').test(ans);
    facts[f.id] = ok;
    // wrong-fact rate: the superseded decoy value was given (and the current value was not)
    decoys[f.id] = !!(f.decoy && ans && new RegExp(f.decoy, 'i').test(ans) && !ok);
    const s = (strata[f.stratum || 'all'] ||= { n: 0, ok: 0 });
    s.n++; if (ok) s.ok++;
  }
  const n = quiz.facts.length;
  const decoyN = quiz.facts.filter((f) => f.decoy).length;
  const byStratum = Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, v.ok / v.n]));
  return {
    hasBlock: !!block,
    facts, decoys,
    recall: n ? Object.values(facts).filter(Boolean).length / n : null,
    wrongFactRate: decoyN ? Object.values(decoys).filter(Boolean).length / decoyN : null,
    conversationOnlyRecall: byStratum.conversation ?? null,
    byStratum,
  };
}

// Mediator split: was a fact "kept" or "dropped" by the compaction summary? regex on the frozen summary text.
function summaryKeptFacts(quiz, summaryText) {
  const out = {};
  // answers are anchored (^...$); a summary is prose, so match the un-anchored form unless the fact gives `summary`
  for (const f of quiz.facts) out[f.id] = new RegExp(f.summary ?? f.accept.replace(/^\^/, '').replace(/\$$/, ''), 'i').test(String(summaryText || ''));
  return out;
}

module.exports = { extractAnswerBlock, gradeQuiz, summaryKeptFacts };
