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
  // A case only Node's own process state settles exactly (what it is is `why`): logged under ctxbudget.ah_unsure_log_kind and counted
  // (native_unable at ctxbudget:<why>); the caller goes on with the stated stand-in.
  unsure: function (why) { ah.log(ah.cfg('ctxbudget.ah_unsure_log_kind'), why); ah.unable('ctxbudget:' + why); },
  // The transcript path to open (hookProc.openKnown); a relative one without an absolute payload cwd opens against the stand-in directory.
  open: function (p, tp) { var o = hookProc.openKnown(p, tp); if (o === null) { cb.unsure('relative_transcript'); o = hookProc.open(p, tp); } return o; },
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
  // `tp` is the path to open (a relative payload path joined to the hook's directory by the caller, hookProc.open), so it is read as
  // Node's process reads it. `writes.inferred` is set when the inferred window must be recorded.
  getContextPct: function (tp, sessionId, writes) {
    var tag = cb.tagFromSessionId(sessionId);
    if (tag) {
      var stored = cb.readStore(tag, cb.n('ctxbudget.pct_fresh_ms'));
      if (stored) return { pct: stored.pct, used: stored.usedTokens, max: stored.maxTokens, source: 'statusline', estimated: false, windowKnown: true, windowLabel: null };
    }
    if (typeof tp !== 'string' || !tp) return null;
    var size = ah.fs.size(tp);
    if (size === null || size <= 0) return null;
    // both readers below look at the newest line holding their marker and skip every other, so only those lines are fetched
    var lines = ah.fs.tailLines(tp, cb.n('ctxbudget.tail_bytes'), false, [cb.c('ctxbudget.token_count_marker'), cb.c('ctxbudget.usage_marker')]);
    if (lines === null) return null;
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
  // The payload's working directory, or null without one; a relative one (resolved by Node against its own directory) resolves
  // against the stand-in directory (counted).
  cwdOf: function (p) {
    if (!p || typeof p.cwd !== 'string' || !p.cwd) return null;
    if (!ah.path.isAbsolute(p.cwd)) { cb.unsure('relative_cwd'); return hookProc.cwd(p); }
    return p.cwd;
  },
  // ho.localDate(); a request time zone other than UTC (which only Node applies) takes the UTC date (counted).
  localDate: function () {
    var d = ho.localDate();
    if (d === null) { cb.unsure('local_date'); d = new Date(ah.clock.now()).toISOString().slice(0, 10); }
    return d;
  },
  // handover-find repoRoot(cwd): the git top level unless it is the home directory, else cwd. The home compared is the call's own
  // (ah.home(): HOME, or the passwd home hookProc.adoptHome made it), as Node's realHome(). A checkout the resolver cannot classify
  // exactly is read as the directory itself (counted).
  repoRoot: function (cwd) {
    var ctx = ho.context(cwd), h = ah.home(), rh = ah.fs.realpath(h || '') || h;
    if (ctx.unsure) { cb.unsure('repo_root'); ctx = { unsure: false, toplevel: null, root: null }; }
    return ctx.toplevel && ctx.toplevel !== rh ? ctx.toplevel : cwd;
  },
  // `expectedHandoverPath(payload)`: the repo-relative path of the next handover; null with no cwd.
  expectedHandoverPath: function (p) {
    var cwd = cb.cwdOf(p);
    if (cwd === null) return null;
    var date = cb.localDate(), rr = cb.repoRoot(cwd);
    var sid = ho.sanitize(p.session_id), name = cb.nextHandoverName(ah.path.join(rr, cb.c('ctxbudget.ah_handover_dir_rel')) + '/' + date + '/' + sid);
    return [cb.c('ctxbudget.ah_handover_dir_rel'), date, sid, name].join('/');
  },
  // `sessionHandover(payload)`: {filePath, mtimeMs} of this session's newest handover; null.
  sessionHandover: function (p) {
    var cwd = cb.cwdOf(p);
    if (cwd === null) return null;
    var rr = cb.repoRoot(cwd);
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
  // `noteHandover`: the latch with the newest handover recorded, null when none is new.
  noteHandover: function (latch, p, pct, now) {
    if (!latch || latch.fired !== true || !isFinite(pct)) return null;
    var h = cb.sessionHandover(p);
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
  // ---- the pause nag and the decisive prompt (hooks/auto-handover-pause-nag.js, hooks/lib/handover-freshness.js) ----
  pause: function (pct, p) {
    return text.message('tip', cb.c('ctxbudget.ah_guard'), { what: cb.r('ctxbudget.ah_pause_what', { pct: Math.round(pct) }), instead: cb.r('ctxbudget.ah_pause_instead', { bloat: cb.c('ctxbudget.ah_bloat'), reset: cb.words(p).reset }) });
  },
  // `relativeHandoverPath(payload, filePath)`: the path relative to the working directory when it lies under it.
  relativeHandoverPath: function (p, file) {
    var cwd = cb.cwdOf(p);
    if (!cwd || !file) return file;
    var rel = ah.path.relative(cwd, file);
    return rel && rel.indexOf('..') !== 0 ? rel : file;
  },
  // `buildDecisiveSuffix(payload, handoverPath, freshness, taskComplete)`.
  decisiveSuffix: function (p, path, fresh, complete) {
    var clear = cb.codexPayload(p) ? cb.c('ctxbudget.ah_clear_codex') : cb.c('ctxbudget.ah_clear_claude'), shown = path || cb.c('ctxbudget.ah_suffix_no_path');
    var line = function () { return cb.r(complete ? 'ctxbudget.ah_line_complete' : 'ctxbudget.ah_line_continue', { clear: clear, path: shown }); };
    if (fresh === false) return cb.r('ctxbudget.ah_suffix_stale', { line: line() });
    if (fresh === null) return cb.r('ctxbudget.ah_suffix_unknown', { path: shown });
    return cb.r('ctxbudget.ah_suffix_fresh', { line: line() });
  },
  // The tool uses inside an entry (`collectToolUses`).
  toolUses: function (node, out) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.type === 'tool_use' && node.name) out.push(node);
    var keys = ah.cfg('taskstate.tools_collect_keys');
    for (var i = 0; i < keys.length; i++) {
      var v = node[keys[i]];
      if (Array.isArray(v)) v.forEach(function (it) { cb.toolUses(it, out); });
      else if (v !== null && typeof v === 'object') cb.toolUses(v, out);
    }
  },
  // `isFresh(lines, handoverMtimeMs, cwd)`: null (unknown), true (no counted work after the handover) or false. `cwd` is the hook's
  // physical directory (the payload's absolute cwd, links resolved; null without one): Node's isUnderTmpRoot resolves a relative
  // written path against it with path.resolve, which is exactly the lexical resolution below; with no cwd known that path resolves
  // against the stand-in directory (counted). A line or a timestamp only V8 reads leaves the freshness unknown (null, counted).
  isFresh: function (lines, mtime, cwd) {
    if (typeof mtime !== 'number' || !isFinite(mtime)) return null;
    var under = wd.underTmp;
    wd.underTmp = function (q, c) {
      if (!q) return false;
      var base = c.cwd;
      if (q.charAt(0) !== '/' && !base) { cb.unsure('fresh_path'); base = hookProc.base(); }
      return wd.isUnder(ah.path.resolveAbs(q.charAt(0) === '/' ? q : base + '/' + q), c.tmp);
    };
    try { return cb.freshScan(lines, mtime, { tmp: wd.tmpdir(), cwd: cwd }); } finally { wd.underTmp = under; }
  },
  freshScan: function (lines, mtime, cx) {
    var recognized = false, last = 0;
    for (var i = 0; i < (lines || []).length; i++) {
      var line = lines[i];
      if (!line) continue;
      var r = jx.parse(line);
      if (r.unsure) { cb.unsure('fresh_line'); return null; }
      if (r.invalid) continue;
      var e = r.v;
      if (!e || typeof e !== 'object' || !e.message || typeof e.message !== 'object') continue;
      recognized = true;
      var ts = typeof e.timestamp === 'string' ? jx.isoMs(e.timestamp) : NaN;
      if (ts === undefined) ts = jx.dateParse(e.timestamp);
      if (ts === undefined) { cb.unsure('fresh_timestamp'); return null; }
      if (!isFinite(ts)) continue;
      var uses = [];
      cb.toolUses(e, uses);
      for (var u = 0; u < uses.length; u++) {
        if (wd.counted(uses[u], cx) && ts > last) last = ts;
      }
    }
    return recognized ? last <= mtime + cb.n('ctxbudget.ah_freshness_grace_ms') : null;
  },
  extractSection: function (t, heading) {
    var escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var m = new RegExp('^' + cb.c('ctxbudget.ah_heading_mark') + '\\s+' + escaped + '\\s*$', 'im').exec(t);
    if (!m) return null;
    var rest = t.slice(m.index + m[0].length), next = rest.search(new RegExp('^' + cb.c('ctxbudget.ah_heading_mark') + '\\s+', 'm'));
    return (next === -1 ? rest : rest.slice(0, next)).trim();
  },
  wholeWords: function (key) { return new RegExp('^(?:' + cb.c(key).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }).join('|') + ')\\.?$', 'i'); },
  // `isTaskCompleteFromFile(filePath)`: false on any read problem; a file over the read cap (a capped read shows another file) is not
  // complete (counted).
  taskComplete: function (file) {
    var f = jx.read(file);
    if (f.big) { cb.unsure('handover_big'); return false; }
    if (f.absent || !f.text) return false;
    var open = cb.extractSection(f.text, cb.c('ctxbudget.ah_heading_open'));
    if (open !== null && cb.wholeWords('ctxbudget.ah_open_empty_words').test(open)) return true;
    var next = cb.extractSection(f.text, cb.c('ctxbudget.ah_heading_next'));
    return next !== null && cb.wholeWords('ctxbudget.ah_next_done_words').test(next);
  },
  // `hasOpenTasks(lines)`: true, false, or null when no task tool appeared in the tail.
  hasOpenTasks: function (lines) {
    if (!lines) return null;
    var tools = cb.c('ctxbudget.ah_task_tools'), todo = tools[0], create = tools[1], update = tools[2], dflt = cb.c('ctxbudget.ah_default_status');
    var saw = false, map = {}, keys = cb.c('ctxbudget.ah_task_id_keys'), i, j;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (!tools.some(function (t) { return line.indexOf(t) !== -1; })) continue;
      var r = jx.parse(line);
      if (r.invalid) continue;
      if (r.unsure) { cb.unsure('task_line'); continue; }
      var e = r.v;
      if (!e || e.type !== 'assistant' || e.isSidechain === true) continue;
      var content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
      for (j = 0; j < content.length; j++) {
        var item = content[j];
        if (!item || item.type !== 'tool_use') continue;
        if (item.name === todo) {
          var todos = item.input && Array.isArray(item.input.todos) ? item.input.todos : [], n = 0;
          map = {};
          saw = true;
          for (var k = 0; k < todos.length; k++) {
            var t = todos[k], id = (t && (t.id || t.content)) || String(n++);
            map['todo:' + id] = (t && t.status) || dflt;
          }
          continue;
        }
        if (item.name === create) {
          saw = true;
          var inp = item.input || {}, tuid = item.id || '';
          if (tuid) map['task:' + tuid] = inp.status || dflt;
          continue;
        }
        if (item.name === update) {
          saw = true;
          var up = item.input || {}, uid = null;
          for (var q = 0; q < keys.length && uid === null; q++) if (up[keys[q]] !== undefined && up[keys[q]] !== null) uid = String(up[keys[q]]);
          if (uid !== null && up.status) map['task:' + uid] = up.status;
        }
      }
    }
    if (!saw) return null;
    var open = cb.c('ctxbudget.ah_open_statuses');
    return Object.keys(map).some(function (key) { return open.indexOf(map[key]) !== -1; });
  },
  // `hasRecentSpawn(tag, now)`: a `<ms> <tag>` line of the spawn log within the activity window; a log over the read cap shows no
  // spawn (counted).
  recentSpawn: function (tag, now) {
    if (!tag) return false;
    var rel = cb.c('ctxbudget.ah_spawn_log'), size = ah.fs.size(ah.home() + '/' + rel);
    if (size !== null && size > ah.cfgNum('script.read_max_bytes')) { cb.unsure('spawn_log_big'); return false; }
    var txt = ah.state.readText(rel);
    if (txt === null) return false;
    var lines = txt.trim().split(/\r?\n/), win = cb.n('ctxbudget.ah_spawn_activity_ms');
    return lines.some(function (line) {
      if (!line) return false;
      var sp = line.indexOf(' ');
      if (sp < 0) return false;
      var ms = parseInt(line.slice(0, sp), 10);
      return line.slice(sp + 1) === tag && isFinite(ms) && (now - ms) <= win;
    });
  },
  // `decisiveSuffixFor(payload, settings, lines)`: '' when off or without a handover file.
  decisiveSuffixFor: function (p, cfg, lines) {
    if (!cfg.decisivePrompt) return '';
    var h = cb.sessionHandover(p);
    if (!h) return '';
    // Node's process.cwd() is the physical directory (getcwd resolves links, e.g. /tmp to /private/tmp)
    var dir = cb.cwdOf(p), fresh = cb.isFresh(lines, h.mtimeMs, dir === null ? null : ah.fs.realpath(dir) || dir);
    var complete = fresh === true ? cb.taskComplete(h.filePath) : false;
    return cb.decisiveSuffix(p, cb.relativeHandoverPath(p, h.filePath), fresh, complete);
  },
};
