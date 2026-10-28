'use strict';
// anti-hall :: devswarm-token-usage — per-workspace token burn for DevSwarm
// supervision (Meeseeks P2). Reads a child's OWN session transcript
// (~/.claude/projects/<encoded worktree>/<sessionId>.jsonl) INCREMENTALLY:
// a byte offset per workspace, only complete lines, at most MAX_READ_BYTES per
// sweep. Never re-parses the whole file.
//
// TOKENS = input + output + cache_creation + cacheReadWeight × cache_read, from
// `message.usage` on assistant entries. Claude Code writes one transcript
// entry per content block with the SAME message id and usage, so usage is
// counted once per message id. cacheReadWeight (devswarm.burnCacheReadPct / 100,
// default 10% = 0.1) mirrors prompt-cache pricing, where a cache read bills at a
// tenth of the base input rate — without it every turn of a long session
// would count its whole cached context again.
//
// SINCE-STEP: tokens from entries whose timestamp is at/after the plan's last
// step progress (step_ts, or created_at before any progress). When the
// progress mark moves, the previous period is closed (returned as `closed`,
// for the metrics `tokens` event) and counting restarts at the new mark.
//
// STATE: ~/.anti-hall/devswarm/token-usage/<planKey>.json. Main-session
// transcript only (sub-agent sidechains are separate files, not counted).
// Fail-open: any error -> null, the sweep and the table carry on without it.

const fs = require('fs');
const path = require('path');
const { devswarmRoot, isSafeId } = require('./liveness.js');

const MAX_READ_BYTES = 8 * 1024 * 1024;
const SEEN_IDS_KEEP = 32;

function statePath(home, key) { return path.join(devswarmRoot(home), 'token-usage', key + '.json'); }
function readState(home, key) {
  try {
    if (!isSafeId(key)) return null;
    const v = JSON.parse(fs.readFileSync(statePath(home, key), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (_) { return null; }
}
function writeState(home, key, st) {
  const p = statePath(home, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, p);
}

function transcriptFile(home, d) {
  if (!d || typeof d.sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(d.sessionId) || !d.worktreePath) return null;
  const { projectDirFor } = require('./target-session.js');
  return path.join(projectDirFor(d.worktreePath, home), d.sessionId + '.jsonl');
}

function weigh(u, w) {
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  return n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens) + w * n(u.cache_read_input_tokens);
}

// update(home, key, d, markTs, opts) -> { total, sinceStep, markTs, closed } | null.
// opts = { cacheReadWeight }. markTs = the plan's progress mark (ms).
function update(home, key, d, markTs, opts) {
  try {
    if (!isSafeId(key)) return null;
    const w = Number.isFinite(opts && opts.cacheReadWeight) ? opts.cacheReadWeight : 0.1;
    const st = readState(home, key) || { v: 1, file: null, offset: 0, total: 0, sinceStep: 0, markTs: null, seen: [] };
    let closed = null;
    if (Number.isFinite(markTs) && st.markTs !== markTs) {
      if (Number.isFinite(st.markTs)) closed = { tokens: Math.round(st.sinceStep), fromTs: st.markTs, toTs: markTs };
      st.markTs = markTs;
      st.sinceStep = 0;
    }
    const file = transcriptFile(home, d);
    if (file) {
      if (st.file !== file) { st.file = file; st.offset = 0; st.seen = []; }
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        if (size < st.offset) { st.offset = 0; st.seen = []; } // truncated / replaced
        const len = Math.min(size - st.offset, MAX_READ_BYTES);
        if (len > 0) {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, st.offset);
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl >= 0) {
            st.offset += lastNl + 1;
            const seen = new Set(st.seen);
            for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
              if (!line.includes('"usage"')) continue;
              let j; try { j = JSON.parse(line); } catch (_) { continue; }
              const m = j && j.type === 'assistant' && j.message;
              if (!m || !m.usage || typeof m.usage !== 'object') continue;
              const mid = typeof m.id === 'string' ? m.id : null;
              if (mid) {
                if (seen.has(mid)) continue;
                seen.add(mid);
                st.seen.push(mid);
                if (st.seen.length > SEEN_IDS_KEEP) st.seen.shift();
              }
              const t = weigh(m.usage, w);
              st.total += t;
              const ts = Date.parse(j.timestamp);
              if (!Number.isFinite(st.markTs) || !Number.isFinite(ts) || ts >= st.markTs) st.sinceStep += t;
            }
          }
        }
      } catch (_) { /* no transcript yet: totals unchanged */ }
      finally { try { if (fd != null) fs.closeSync(fd); } catch (_) {} }
    }
    st.updated_at = Date.now();
    writeState(home, key, st);
    return { total: Math.round(st.total), sinceStep: Math.round(st.sinceStep), markTs: st.markTs, closed };
  } catch (_) { return null; }
}

// fmt(n) -> '1.8M' | '420k' | '900'.
function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (Math.round(v / 1e5) / 10) + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(Math.round(v));
}

function setting(key, dflt, opts) {
  try {
    const o = opts || {};
    return require('../../hooks/lib/settings.js').get('devswarm', key, dflt, { env: o.env || process.env, home: o.home });
  } catch (_) { return dflt; }
}
function burnTokensWarn(opts) {
  const v = Number(setting('burnTokensWarn', 2000000, opts));
  return Number.isFinite(v) && v >= 0 ? v : 2000000;
}
function cacheReadWeight(opts) {
  const v = Number(setting('burnCacheReadPct', 10, opts));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v / 100 : 0.1;
}

module.exports = { update, readState, statePath, transcriptFile, fmt, weigh, burnTokensWarn, cacheReadWeight, MAX_READ_BYTES };
