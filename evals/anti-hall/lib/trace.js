'use strict';
// Transcript (stream-json trace) extraction for the strength studies
// (docs/BENCHMARK-METHOD.md Amendment 3, B1-B4). Pure Node, no network.
//
// Shapes relied on (verified in the Amendment 3 draft against pilot traces):
//   result line   {type:'result', total_cost_usd, modelUsage:{model:{costUSD,...}}, subagent_stats, result}
//   Agent spawn   assistant tool_use {name:'Agent'|'Task', id, input:{model?, run_in_background?}}
//                 user tool_use_result {resolvedModel, usage, totalTokens} for that tool_use_id
//   sidechain     events with parent_tool_use_id set (or isSidechain: true) belong to a subagent
// Anything absent is reported as null/0, never invented.

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const MUTATING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const ROUTING_BLOCK_RE = /model-routing-guard|model routing/i;
// Assumption (P8 not yet run): the harness surfaces a Stop-hook block as text containing this.
const STOP_BLOCK_RE = /Stop hook (blocking error|feedback)|Stop hook error/i;
const TESTS_LINE_RE = /ℹ tests \d+/;

function parseTrace(input) {
  if (Array.isArray(input)) return input;
  const out = [];
  for (const line of String(input || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip a torn line */ }
  }
  return out;
}

function tierOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return m ? 'other' : null;
}

const isSidechain = (e) => e.isSidechain === true || (e.parent_tool_use_id != null && e.parent_tool_use_id !== '');
const blocksOf = (e) => (e && e.message && Array.isArray(e.message.content) ? e.message.content : []);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('\n') : '');
const sumTokens = (u) => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0);

function extractRunMetrics(input) {
  const ev = parseTrace(input);
  const m = {
    totalCostUsd: null, modelUsage: null, costByTier: {}, subagentStats: null,
    initTools: null, firstCacheRead: null, finalMessage: null, compactBoundary: false,
    spawns: [], spawnCount: 0, omittedModelSpawns: 0, routingBlocks: 0, respawnTiers: [],
    bashByTier: { main: 0 }, mainToolCalls: 0, mainMutatingCalls: 0, sidechainToolCalls: 0, sidechainMutatingCalls: 0,
    mainShareAll: null, mainShareMutating: null,
    mainTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    subagentTokensByTier: {}, subagentCostByTierEstimate: {},
    stopBlocks: 0, testsAfterLastEdit: false, sessionId: null,
  };
  const spawnById = new Map();
  const mainUsageById = new Map();
  let lastText = null, lastEditIdx = -1, lastTestsIdx = -1, awaitingRespawn = false;
  ev.forEach((e, idx) => {
    if (e.session_id && !m.sessionId) m.sessionId = e.session_id;
    if (e.type === 'system' && e.subtype === 'init' && Array.isArray(e.tools)) m.initTools = e.tools.map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
    if (e.subtype === 'compact_boundary' || (e.type === 'system' && e.compact_metadata)) m.compactBoundary = true;
    if (e.type === 'result') {
      if (typeof e.total_cost_usd === 'number') m.totalCostUsd = e.total_cost_usd;
      if (e.modelUsage && typeof e.modelUsage === 'object') {
        m.modelUsage = e.modelUsage;
        for (const [model, u] of Object.entries(e.modelUsage)) {
          const t = tierOf(model) || 'other';
          m.costByTier[t] = (m.costByTier[t] || 0) + (u.costUSD || 0);
        }
      }
      if (e.subagent_stats) m.subagentStats = e.subagent_stats;
      if (typeof e.result === 'string') m.finalMessage = e.result;
    }
    const side = isSidechain(e);
    if (e.type === 'assistant') {
      const u = e.message && e.message.usage;
      // stream-json splits one API response into one assistant event per content block, all sharing
      // message.id and identical usage: keep the last usage per id, sum once after the loop.
      if (!side && u) mainUsageById.set((e.message && e.message.id) || `anon:${idx}`, u);
      for (const b of blocksOf(e)) {
        if (b.type === 'text' && !side) lastText = b.text;
        if (b.type !== 'tool_use') continue;
        if (side) { m.sidechainToolCalls++; if (MUTATING.has(b.name)) m.sidechainMutatingCalls++; } else { m.mainToolCalls++; if (MUTATING.has(b.name)) m.mainMutatingCalls++; }
        if (MUTATING.has(b.name) && !side) lastEditIdx = idx;
        if (b.name === 'Bash') {
          if (!side) m.bashByTier.main++;
          else {
            const sp = spawnById.get(e.parent_tool_use_id);
            const t = (sp && sp.tier) || 'unknown';
            m.bashByTier[t] = (m.bashByTier[t] || 0) + 1;
          }
        }
        if (!side && SPAWN_TOOLS.has(b.name)) {
          const input = b.input || {};
          const sp = { id: b.id, requestedModel: input.model || null, background: input.run_in_background === true, resolvedModel: null, tier: tierOf(input.model), totalTokens: null, usage: null, blocked: false };
          if (!input.model) m.omittedModelSpawns++;
          m.spawns.push(sp); spawnById.set(b.id, sp);
          if (awaitingRespawn) { m.respawnTiers.push(sp.tier); awaitingRespawn = false; }
        }
      }
    }
    if (e.type === 'user') {
      const results = blocksOf(e).filter((b) => b.type === 'tool_result');
      for (const b of results) {
        const sp = spawnById.get(b.tool_use_id);
        const txt = textOf(b.content);
        if (sp) {
          const tur = e.tool_use_result || b.tool_use_result || {};
          if (b.is_error && ROUTING_BLOCK_RE.test(txt)) { sp.blocked = true; m.routingBlocks++; awaitingRespawn = true; }
          if (tur.resolvedModel) { sp.resolvedModel = tur.resolvedModel; sp.tier = tierOf(tur.resolvedModel) || sp.tier; }
          if (tur.usage) sp.usage = tur.usage;
          sp.totalTokens = typeof tur.totalTokens === 'number' ? tur.totalTokens : (tur.usage ? sumTokens(tur.usage) : null);
        }
        if (!side && TESTS_LINE_RE.test(txt)) lastTestsIdx = idx;
        if (STOP_BLOCK_RE.test(txt)) m.stopBlocks++;
      }
      if (!results.length && typeof (e.message && e.message.content) === 'string' && STOP_BLOCK_RE.test(e.message.content)) m.stopBlocks++;
    }
  });
  for (const u of mainUsageById.values()) {
    if (m.firstCacheRead == null) m.firstCacheRead = u.cache_read_input_tokens || 0;
    m.mainTokens.input += u.input_tokens || 0; m.mainTokens.output += u.output_tokens || 0;
    m.mainTokens.cacheRead += u.cache_read_input_tokens || 0; m.mainTokens.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  m.spawnCount = m.spawns.length;
  if (m.finalMessage == null) m.finalMessage = lastText;
  m.testsAfterLastEdit = lastEditIdx >= 0 && lastTestsIdx > lastEditIdx;
  const all = m.mainToolCalls + m.sidechainToolCalls, mut = m.mainMutatingCalls + m.sidechainMutatingCalls;
  m.mainShareAll = all ? m.mainToolCalls / all : null;
  m.mainShareMutating = mut ? m.mainMutatingCalls / mut : null;
  // per-tier subagent tokens, and a $ estimate = tokens x that model's own effective $/token (modelUsage).
  const rate = {};
  if (m.modelUsage) for (const [model, u] of Object.entries(m.modelUsage)) {
    const toks = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
    if (toks > 0 && typeof u.costUSD === 'number') rate[tierOf(model) || 'other'] = { c: (rate[tierOf(model) || 'other'] ? rate[tierOf(model) || 'other'].c : 0) + u.costUSD, t: (rate[tierOf(model) || 'other'] ? rate[tierOf(model) || 'other'].t : 0) + toks };
  }
  for (const sp of m.spawns) {
    if (sp.totalTokens == null || !sp.tier) continue;
    m.subagentTokensByTier[sp.tier] = (m.subagentTokensByTier[sp.tier] || 0) + sp.totalTokens;
    if (rate[sp.tier]) m.subagentCostByTierEstimate[sp.tier] = (m.subagentCostByTierEstimate[sp.tier] || 0) + sp.totalTokens * (rate[sp.tier].c / rate[sp.tier].t);
  }
  return m;
}

module.exports = { parseTrace, extractRunMetrics, tierOf, ROUTING_BLOCK_RE, STOP_BLOCK_RE };
