// Shared helpers of the context-budget checks (mirror hooks/lib/context-pct.js, context-pct-store.js, auto-handover-config.js,
// auto-handover-state.js, auto-handover-gate.js and auto-handover-text.js): the context reading, the per-session latch, the effective
// auto-handover settings, the post-handover gate and every text the checks inject. Files, limits, switches and texts:
// ctxbudget.toml (ctxbudget.*).
'use strict';
var cb = {
  r: function (k, a) { return text.render(ah.cfg(k), a || {}); },
  c: function (k) { return ah.cfg(k); },
  n: function (k) { return ah.cfgNum(k); },
  sanitizeTag: function (s) { return s.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, cb.n('ctxbudget.session_tag_max')); },
  // `tagFromSessionId`: a non-blank string id, sanitized; null otherwise.
  tagFromSessionId: function (sid) {
    if (typeof sid !== 'string' || !sid.trim()) return null;
    return cb.sanitizeTag(sid) || null;
  },
  // `sessionTag(payload)`: the sanitized session id, else the first 16 hex digits of the transcript path's SHA-1.
  sessionTag: function (p) {
    if (p && typeof p.session_id === 'string' && p.session_id.trim()) {
      var safe = cb.sanitizeTag(p.session_id);
      if (safe) return safe;
    }
    if (p && typeof p.transcript_path === 'string' && p.transcript_path) return ah.sha1(p.transcript_path).slice(0, cb.n('ctxbudget.ah_hash_tag_len'));
    return null;
  },
  rel: function (dir, name) { return cb.c('ctxbudget.state_root') + '/' + dir + '/' + name; },
  readObj: function (rel) {
    var raw = ah.state.readText(rel);
    if (raw === null) return null;
    try { var o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
  },
  atomic: function (rel, obj) { try { ah.state.writeAtomic(rel, JSON.stringify(obj)); } catch (e) { /* best effort */ } },
  // ---- the latch ----
  latchRel: function (tag) { return cb.rel(cb.c('ctxbudget.latch_dir'), tag + '.json'); },
  readLatch: function (tag) { return cb.readObj(cb.latchRel(tag)) || {}; },
  writeLatch: function (tag, obj) { cb.atomic(cb.latchRel(tag), obj); },
  // ---- the context reading ----
  readStore: function (tag, maxAge) {
    var raw = cb.readObj(cb.rel(cb.c('ctxbudget.pct_dir'), tag + '.json'));
    if (!raw || typeof raw.pct !== 'number' || !isFinite(raw.pct)) return null;
    var ts = typeof raw.ts === 'number' ? raw.ts : 0;
    if (!ts || (ah.clock.now() - ts) > maxAge) return null;
    return { pct: raw.pct, usedTokens: typeof raw.usedTokens === 'number' ? raw.usedTokens : null, maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : null };
  },
  readSticky: function (tag) {
    var raw = cb.readObj(cb.rel(cb.c('ctxbudget.pct_dir'), tag + '.json'));
    return raw && typeof raw.maxTokens === 'number' && isFinite(raw.maxTokens) && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : null;
  },
  inferredRel: function (tag) { return cb.rel(cb.c('ctxbudget.pct_dir'), tag + cb.c('ctxbudget.inferred_suffix')); },
  readInferred: function (tag) { var o = cb.readObj(cb.inferredRel(tag)); return !!(o && o.inferred === true); },
  writeInferred: function (tag) { cb.atomic(cb.inferredRel(tag), { inferred: true, ts: ah.clock.now() }); },
  lastUsage: function (lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      if (!line || line.indexOf(cb.c('ctxbudget.usage_marker')) === -1) continue;
      var e;
      try { e = JSON.parse(line); } catch (x) { continue; }
      if (!e || typeof e !== 'object' || e.type !== 'assistant' || e.isSidechain === true) continue;
      var u = e.message && e.message.usage;
      if (!u || typeof u !== 'object') continue;
      var input = typeof u.input_tokens === 'number' ? u.input_tokens : 0, cc = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0, cr = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
      if (input === 0 && cc === 0 && cr === 0) continue;
      return { input: input, cacheCreate: cc, cacheRead: cr };
    }
    return null;
  },
  lastCodex: function (lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      if (!line || line.indexOf(cb.c('ctxbudget.token_count_marker')) === -1) continue;
      var e;
      try { e = JSON.parse(line); } catch (x) { continue; }
      if (!e || e.type !== 'event_msg') continue;
      var pl = e.payload;
      if (!pl || pl.type !== 'token_count') continue;
      var info = pl.info;
      if (!info || typeof info !== 'object') continue;
      var used = info.total_token_usage && typeof info.total_token_usage.total_tokens === 'number' ? info.total_token_usage.total_tokens : null;
      var max = typeof info.model_context_window === 'number' ? info.model_context_window : null;
      if (used === null || max === null || max <= 0) continue;
      return { used: used, max: max };
    }
    return null;
  },
  // `getContextPct(transcriptPath, env, {home, sessionId})`: {pct, used, max, source, estimated, windowKnown, windowLabel} or null.
  // A transcript path that is not absolute is for Node: 'defer'. `writes.inferred` is set when the inferred window must be recorded.
  getContextPct: function (tp, sessionId, writes) {
    var tag = cb.tagFromSessionId(sessionId);
    if (tag) {
      var stored = cb.readStore(tag, cb.n('ctxbudget.pct_fresh_ms'));
      if (stored) return { pct: stored.pct, used: stored.usedTokens, max: stored.maxTokens, source: 'statusline', estimated: false, windowKnown: true, windowLabel: null };
    }
    if (typeof tp !== 'string' || !tp) return null;
    if (!ah.path.isAbsolute(tp)) return 'defer';
    var size = ah.fs.size(tp);
    if (size === null || size <= 0) return null;
    var tail = ah.fs.readTail(tp, cb.n('ctxbudget.tail_bytes'));
    if (tail === null) return null;
    var lines = tail.split('\n');
    var codex = cb.lastCodex(lines);
    if (codex) return { pct: Math.max(0, Math.min(100, (codex.used / codex.max) * 100)), used: codex.used, max: codex.max, source: 'codex-transcript', estimated: false, windowKnown: true, windowLabel: null };
    var usage = cb.lastUsage(lines);
    if (!usage) return null;
    var used = usage.input + usage.cacheCreate + usage.cacheRead, max, label, known = true;
    var envMaxRaw = ah.env.get(cb.c('ctxbudget.context_window_env')), envMax = envMaxRaw === null ? NaN : parseInt(envMaxRaw, 10);
    if (isFinite(envMax) && envMax > 0) { max = envMax; label = 'env'; }
    else {
      var sticky = tag ? cb.readSticky(tag) : null, already = tag ? cb.readInferred(tag) : false, over = used > cb.n('ctxbudget.default_window');
      if (sticky && isFinite(sticky.maxTokens) && sticky.maxTokens > 0) { max = sticky.maxTokens; label = 'sticky'; }
      else if (over || already) { max = cb.n('ctxbudget.inferred_window'); label = 'inferred-1m'; if (over && tag && writes) writes.inferred = tag; }
      else { max = cb.n('ctxbudget.default_window'); label = 'default'; known = false; }
    }
    return { pct: Math.max(0, Math.min(100, (used / max) * 100)), used: used, max: max, source: 'estimate', estimated: true, windowKnown: known, windowLabel: label };
  },
  // ---- effective settings ----
  markers: function () {
    var entry = ah.cfg('ctxbudget.set_ah_markers'), raw = ah.state.readText(ah.cfg('guardkit.settings_file')), v = '';
    if (raw !== null) {
      try {
        var o = JSON.parse(raw), sec = o && o[entry.section], x = sec && typeof sec === 'object' ? sec[entry.key] : undefined;
        if (typeof x === 'string') v = x.trim(); else if (typeof x === 'number' || typeof x === 'boolean') v = String(x);
      } catch (e) { /* no file settings */ }
    }
    return v ? v.split(new RegExp('[' + cb.c('ctxbudget.ah_marker_seps').join('') + ']')).map(function (s) { return s.trim(); }).filter(Boolean) : [];
  },
  resolveEffective: function () {
    var off = { enabled: false, pct: 0, maxTokens: 0, nag: false, nagStepPct: 0, nagQuietMin: 0, gateNewWork: false, gateBudgetPct: 0, decisivePrompt: false, gateHousekeepingMarkers: [] };
    var envRaw = ah.env.get(cb.c('ctxbudget.env_pct_off'));
    if (envRaw !== null && String(envRaw).trim() !== '' && parseInt(envRaw, 10) === 0) return off;
    if (!ah.settings.bool('ctxbudget.set_ah_enabled')) return off;
    return {
      enabled: true, pct: ah.settings.num('ctxbudget.set_ah_pct'), maxTokens: Math.floor(ah.settings.num('ctxbudget.set_ah_max_tokens')),
      nag: ah.settings.bool('ctxbudget.set_ah_nag'), nagStepPct: ah.settings.num('ctxbudget.set_ah_nag_step'), nagQuietMin: ah.settings.num('ctxbudget.set_ah_nag_quiet'),
      gateNewWork: ah.settings.bool('ctxbudget.set_ah_gate'), gateBudgetPct: ah.settings.num('ctxbudget.set_ah_gate_budget'),
      decisivePrompt: ah.settings.bool('ctxbudget.set_ah_decisive'), gateHousekeepingMarkers: cb.markers(),
    };
  },
  overThreshold: function (result, cfg) {
    if (!result || !cfg || !cfg.enabled) return null;
    var byPct = isFinite(result.pct) && result.pct >= cfg.pct, byTokens = cfg.maxTokens > 0 && typeof result.used === 'number' && isFinite(result.used) && result.used >= cfg.maxTokens;
    if (byPct && result.windowKnown !== false) return cb.c('ctxbudget.ah_via_pct');
    if (byTokens) return cb.c('ctxbudget.ah_via_tokens');
    if (byPct) return 'pct-unknown-window';
    return null;
  },
  // ---- platform, handover paths ----
  codexPayload: function (p) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.turn_id === 'string' && p.turn_id) return true;
    var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
    return /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(tp) || /[\\/]\.codex[\\/]/.test(tp);
  },
  words: function (p) { return cb.codexPayload(p) ? { skill: cb.c('ctxbudget.ah_skill_codex'), reset: cb.c('ctxbudget.ah_reset_codex') } : { skill: cb.c('ctxbudget.ah_skill_claude'), reset: cb.c('ctxbudget.ah_reset_claude') }; },
  nextHandoverName: function (sessionDir) {
    var names = ah.fs.readdir(sessionDir) || [], count = names.filter(function (f) { return ho.handoverRe.test(f); }).length, seq = count + 1;
    return seq > 1 ? text.render(cb.c('ctxbudget.ah_handover_name_n'), { n: seq }) : cb.c('ctxbudget.ah_handover_name');
  },
  // `expectedHandoverPath(payload)`: the repo-relative path of the next handover; null with no cwd; false when the host cannot say.
  expectedHandoverPath: function (p) {
    var cwd = p && typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    if (cwd === null) return null;
    if (!ah.path.isAbsolute(cwd)) return false;
    var date = ho.localDate(), rr = ho.repoRoot(cwd);
    if (date === null || rr === null) return false;
    var sid = ho.sanitize(p.session_id), name = cb.nextHandoverName(ah.path.join(rr, cb.c('ctxbudget.ah_handover_dir_rel')) + '/' + date + '/' + sid);
    return [cb.c('ctxbudget.ah_handover_dir_rel'), date, sid, name].join('/');
  },
  // `sessionHandover(payload)`: {filePath, mtimeMs} of this session's newest handover; null; false when the host cannot say.
  sessionHandover: function (p) {
    var cwd = p && typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    if (cwd === null) return null;
    if (!ah.path.isAbsolute(cwd)) return false;
    var rr = ho.repoRoot(cwd);
    if (rr === null) return false;
    var sid = ho.sanitize(p.session_id), root = ah.path.join(rr, cb.c('ctxbudget.ah_handover_dir_rel'));
    var c = ho.collect(root, ho.handoverRe, sid);
    if (c.length === 0) return null;
    c.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
    return { filePath: c[0].filePath, mtimeMs: c[0].mtimeMs };
  },
  // ---- the gate ----
  isHousekeeping: function (prompt, extra) {
    if (typeof prompt !== 'string' || !prompt.trim()) return false;
    var lower = prompt.toLowerCase(), markers = cb.c('ctxbudget.ah_housekeeping').concat(Array.isArray(extra) ? extra : []);
    for (var i = 0; i < markers.length; i++) if (typeof markers[i] === 'string' && markers[i].trim() && lower.indexOf(markers[i].toLowerCase()) !== -1) return true;
    return false;
  },
  isArmed: function (cfg, latch) { return !!(cfg && cfg.enabled && cfg.gateNewWork && latch && latch.fired === true && typeof latch.handoverPct === 'number' && isFinite(latch.handoverPct)); },
  backstopDue: function (cfg, latch, pct) {
    if (!cb.isArmed(cfg, latch) || !isFinite(pct)) return false;
    if (typeof latch.gateBackstopAt === 'number' && isFinite(latch.gateBackstopAt)) return false;
    return pct > latch.handoverPct + cfg.gateBudgetPct;
  },
  // `noteHandover`: the latch with the newest handover recorded, null when none is new; 'defer' when the host cannot say.
  noteHandover: function (latch, p, pct, now) {
    if (!latch || latch.fired !== true || !isFinite(pct)) return null;
    var h = cb.sessionHandover(p);
    if (h === false) return 'defer';
    if (!h) return null;
    var since = typeof latch.firedAt === 'number' && isFinite(latch.firedAt) ? latch.firedAt - cb.n('ctxbudget.ah_mtime_slack_ms') : 0;
    if (h.mtimeMs < since) return null;
    if (typeof latch.handoverMtime === 'number' && isFinite(latch.handoverMtime) && h.mtimeMs <= latch.handoverMtime) return null;
    var next = Object.assign({}, latch, { handoverMtime: h.mtimeMs, handoverPath: h.filePath, handoverPct: pct, handoverSeenAt: now });
    delete next.gateBackstopAt;
    delete next.gateBackstopPct;
    return next;
  },
  // ---- texts ----
  compactCommand: function (hp, codex) { return codex ? cb.c('ctxbudget.ah_compact_codex') : cb.r('ctxbudget.ah_compact_claude', { path: hp || cb.c('ctxbudget.ah_compact_no_path') }); },
  fire: function (result, via, p, maxTokens, hp) {
    var codex = cb.codexPayload(p), w = cb.words(p), what;
    if (via === cb.c('ctxbudget.ah_via_tokens')) {
      var ceilingK = isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens / 1000) : null;
      what = cb.r('ctxbudget.ah_what_tokens', { usedK: Math.round((result.used || 0) / 1000), ceiling: ceilingK != null ? cb.r('ctxbudget.ah_ceiling', { k: ceilingK }) : '' });
    } else {
      var label = '';
      if (result.estimated) label = result.windowLabel === 'inferred-1m' ? cb.c('ctxbudget.ah_label_inferred') : cb.c('ctxbudget.ah_label_estimated');
      what = cb.r('ctxbudget.ah_what_pct', { pct: Math.round(result.pct), label: label });
    }
    var step3 = codex ? cb.c('ctxbudget.ah_fire_step3_codex') : cb.r('ctxbudget.ah_fire_step3_claude', { cmd: cb.compactCommand(hp, codex) });
    return text.message('warn', cb.c('ctxbudget.ah_guard'), {
      what: what, why: cb.c('ctxbudget.ah_fire_why'),
      instead: cb.r('ctxbudget.ah_fire_step1', { skill: w.skill }) + (hp ? cb.r('ctxbudget.ah_fire_main_file', { path: hp }) : '') + cb.c('ctxbudget.ah_fire_step2') + step3 + cb.r('ctxbudget.ah_fire_tail', { bloat: cb.c('ctxbudget.ah_bloat') }),
    });
  },
  milestone: function (pct, p) {
    return text.message('tip', cb.c('ctxbudget.ah_guard'), { what: cb.r('ctxbudget.ah_nag_what', { pct: Math.round(pct) }), instead: cb.r('ctxbudget.ah_nag_instead', { bloat: cb.c('ctxbudget.ah_bloat'), reset: cb.words(p).reset }) });
  },
  soft: function (pct) {
    return text.message('tip', cb.c('ctxbudget.ah_guard'), { what: cb.r('ctxbudget.ah_soft_what', { pct: Math.round(pct) }), why: cb.c('ctxbudget.ah_soft_why'), instead: cb.r('ctxbudget.ah_soft_instead', { bloat: cb.c('ctxbudget.ah_bloat') }) });
  },
  budgetLabel: function (b, max) {
    var tokK = isFinite(max) && max > 0 ? Math.round((max * b) / 100 / 1000) : null;
    return cb.r('ctxbudget.ah_budget', { b: b, tok: tokK ? cb.r('ctxbudget.ah_budget_tokens', { k: tokK }) : '' });
  },
  gateDirective: function (result, latch, cfg, p) {
    var codex = cb.codexPayload(p), w = cb.words(p);
    return text.message('warn', cb.c('ctxbudget.ah_guard'), {
      what: cb.r('ctxbudget.ah_gate_what', { pct: Math.round(result.pct), hp: Math.round(latch.handoverPct), budget: cb.budgetLabel(cfg.gateBudgetPct, result.max) }),
      why: cb.c('ctxbudget.ah_gate_why'), instead: cb.r('ctxbudget.ah_gate_instead', { ask: codex ? cb.c('ctxbudget.ah_gate_ask_codex') : cb.c('ctxbudget.ah_gate_ask_claude'), reset: w.reset }),
      allowed: cb.c('ctxbudget.ah_gate_allowed'), override: cb.c('ctxbudget.ah_gate_override'),
    });
  },
  gateBackstop: function (pct, latch, cfg, p) {
    var w = cb.words(p);
    return text.message('warn', cb.c('ctxbudget.ah_guard'), {
      what: cb.r('ctxbudget.ah_backstop_what', { pct: Math.round(pct), b: cfg.gateBudgetPct, hp: Math.round(latch.handoverPct) }),
      instead: cb.r('ctxbudget.ah_backstop_instead', { skill: w.skill, reset: w.reset }),
    });
  },
};
