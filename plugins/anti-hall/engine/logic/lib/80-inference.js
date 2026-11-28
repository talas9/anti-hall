// The unsupported-inference scan of the speculation guard (guards.inferenceCheck, default off; mirrors hooks/lib/inference-check.js):
// a causal sentence in the reply whose stated cause no tool evidence in the transcript tail mentions. Every pattern and word list is in
// inference.toml. Total: bad input answers null / [].
'use strict';
var inf = {
  re: function (key, flags) { return jx.re(key, flags); },
  stop: function () {
    var g = ah.cfgGen();
    if (inf.stopGen !== g) { inf.stopGen = g; inf.stopSet = new Set(ah.cfg('inference.stop_words').split(/\s+/)); }
    return inf.stopSet;
  },
  connectives: function () {
    var out = [];
    ah.cfg('inference.connectives_after').forEach(function (s) { out.push({ src: s, before: false }); });
    ah.cfg('inference.connectives_before').forEach(function (s) { out.push({ src: s, before: true }); });
    return out;
  },
  // Cheap pre-filter: does the reply hold any causal wording?
  anyConnective: function (t) {
    var all = ah.cfg('inference.connectives_after').concat(ah.cfg('inference.connectives_before'));
    for (var i = 0; i < all.length; i++) if (new RegExp(all[i], 'i').test(t)) return true;
    return false;
  },
  stem: function (w) { return w.replace(new RegExp(ah.cfg('inference.stem_re'), 'i'), '').slice(0, ah.cfgNum('inference.stem_len')); },
  // { idents: [lowercased], words: [stems] }
  tokens: function (clause) {
    var idents = new Set(), words = new Set(), stop = inf.stop();
    var raw = String(clause).match(new RegExp(ah.cfg('inference.token_re'), 'g')) || [];
    var trim = new RegExp(ah.cfg('inference.token_trim_re'), 'g'), ident = new RegExp(ah.cfg('inference.ident_re'));
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i].replace(trim, '');
      if (!t) continue;
      var lower = t.toLowerCase();
      if (stop.has(lower)) continue;
      if (ident.test(t) && (/[a-z]/i.test(t) ? t.length >= ah.cfgNum('inference.ident_min_len_letters') : t.length >= ah.cfgNum('inference.ident_min_len_other'))) { idents.add(lower); continue; }
      if (lower.length < ah.cfgNum('inference.word_min_len') || !/^[a-z]+$/.test(lower)) continue;
      words.add(inf.stem(lower));
    }
    return { idents: Array.from(idents), words: Array.from(words) };
  },
  // [{text, start}] with offsets into `text`: split on newlines and on sentence punctuation followed by white space and a capital.
  sentences: function (text) {
    var out = [], src = String(text), lineRe = /[^\n]+/g, lm, sep = ah.cfg('inference.sentence_sep_re');
    while ((lm = lineRe.exec(src)) !== null) {
      var line = lm[0], cuts = [0], sepRe = new RegExp(sep, 'g'), sm;
      while ((sm = sepRe.exec(line)) !== null) { cuts.push(sm.index + sm[0].length); if (sm[0].length === 0) sepRe.lastIndex++; }
      cuts.push(line.length + 1);
      for (var i = 0; i + 1 < cuts.length; i++) {
        var seg = line.slice(cuts[i], Math.min(cuts[i + 1], line.length));
        var lead = seg.length - seg.replace(/^\s+/, '').length, body = seg.trim();
        if (body) out.push({ text: body, start: lm.index + cuts[i] + lead });
      }
    }
    return out;
  },
  // [{sentence, cause}] of the masked reply (quoted spans blanked, offsets unchanged); the sentence and cause are read from `raw` when given.
  claims: function (masked, raw) {
    if (typeof masked !== 'string' || !inf.anyConnective(masked)) return [];
    var src = typeof raw === 'string' && raw.length === masked.length ? raw : masked, claims = [], cons = inf.connectives();
    var hyp = new RegExp(ah.cfg('inference.hypothetical_re'), 'i'), first = new RegExp(ah.cfg('inference.first_person_re')), question = new RegExp(ah.cfg('inference.question_re'));
    var plan = new RegExp(ah.cfg('inference.plan_prefix_re'), 'i'), clauseEnd = new RegExp(ah.cfg('inference.cause_clause_split_re'));
    var ss = inf.sentences(masked);
    for (var i = 0; i < ss.length; i++) {
      var s = ss[i].text, start = ss[i].start;
      if (question.test(s) || plan.test(s)) continue;
      var best = null;
      for (var c = 0; c < cons.length; c++) {
        var m = new RegExp(cons[c].src, 'i').exec(s);
        if (m && (best === null || m.index < best.m.index)) best = { c: cons[c], m: m };
      }
      if (!best) continue;
      var head = s.slice(0, best.m.index), tail = s.slice(best.m.index + best.m[0].length);
      if (hyp.test(head) || hyp.test(tail.split(clauseEnd)[0])) continue;
      if (first.test(head)) continue;
      var rs = src.slice(start, start + s.length);
      claims.push({ sentence: rs, cause: best.c.before ? rs.slice(0, best.m.index) : rs.slice(best.m.index + best.m[0].length) });
    }
    return claims;
  },
  textOf: function (v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(function (b) { return (b && typeof b === 'object') ? inf.textOf(b.text !== null && b.text !== undefined ? b.text : b.content) : inf.textOf(b); }).join('\n');
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (v.content !== null && v.content !== undefined) return inf.textOf(v.content);
      if (typeof v.output === 'string') return v.output;
      try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v);
  },
  fenced: function (s) {
    var out = [], re = new RegExp(ah.cfg('inference.fence_re'), 'g'), m;
    s = String(s);
    while ((m = re.exec(s)) !== null) { out.push(m[2]); if (m[0].length === 0) re.lastIndex++; }
    return out;
  },
  // Lowercased evidence chunks, oldest first, from transcript lines (Claude and Codex shapes).
  evidence: function (lines) {
    var chunks = [], max = ah.cfgNum('inference.max_chunk'), observe = new RegExp(ah.cfg('inference.observe_tools_re'), 'i'), notice = new RegExp(ah.cfg('inference.task_notification_re'));
    function push(s) { var t = String(s || ''); if (t.trim()) chunks.push(t.slice(0, max).toLowerCase()); }
    for (var i = 0; i < (lines || []).length; i++) {
      var trimmed = typeof lines[i] === 'string' ? lines[i].trim() : '';
      if (!trimmed || trimmed.charAt(0) !== '{') continue;
      var pr = jx.parse(trimmed);
      if (pr.unsure) { ah.unable('inference:line_unsure'); continue; }
      var e = pr.v;
      if (pr.invalid || !e || typeof e !== 'object') continue;
      if (e.type === 'response_item' && e.payload && typeof e.payload === 'object') {
        var p = e.payload;
        if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
          if (observe.test(String(p.name || 'shell'))) push(inf.textOf(p.arguments != null ? p.arguments : (p.input != null ? p.input : p.action)));
        } else if (/_output$/.test(String(p.type || ''))) push(inf.textOf(p.output));
        continue;
      }
      if (e.type === 'event_msg' && e.payload && e.payload.type === 'user_message') { inf.fenced(e.payload.message).forEach(push); continue; }
      var msg = e.message && typeof e.message === 'object' ? e.message : e, role = e.role || msg.role || e.type, content = msg.content;
      if (role === 'assistant') {
        if (Array.isArray(content)) content.forEach(function (b) { if (b && b.type === 'tool_use' && observe.test(String(b.name || ''))) push(inf.textOf(b.input)); });
      } else if (role === 'user') {
        if (Array.isArray(content)) {
          content.forEach(function (b) {
            if (!b || typeof b !== 'object') return;
            if (b.type === 'tool_result') push(inf.textOf(b.content));
            else if (b.type === 'text') { if (notice.test(b.text || '')) push(b.text); else inf.fenced(b.text).forEach(push); }
          });
        } else if (typeof content === 'string') { if (notice.test(content)) push(content); else inf.fenced(content).forEach(push); }
      }
    }
    return chunks;
  },
  supported: function (cause, chunks) {
    var t = inf.tokens(cause);
    if (t.idents.length === 0 && t.words.length === 0) return true; // nothing assessable: do not flag
    var need = Math.min(ah.cfgNum('inference.words_needed'), t.words.length);
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      if (t.idents.some(function (x) { return ch.indexOf(x) >= 0; })) return true;
      var hits = 0;
      t.words.forEach(function (w) { if (ch.indexOf(w) >= 0) hits++; });
      if (need > 0 && hits >= need) return true;
    }
    return false;
  },
  // { sentence, cause } of the first causal claim the evidence does not support, or null.
  unsupported: function (masked, lines, raw) {
    try {
      if (typeof masked !== 'string' || new RegExp(ah.cfg('inference.unverified_re'), 'i').test(masked)) return null;
      var claims = inf.claims(masked, raw);
      if (claims.length === 0) return null;
      var chunks = inf.evidence(lines);
      for (var i = 0; i < claims.length; i++) if (!inf.supported(claims[i].cause, chunks)) return claims[i];
      return null;
    } catch (e) { return null; }
  },
  // The reply's own sentence quoted back into the block reason.
  oneLine: function (s, max) {
    var o = String(s).replace(new RegExp(ah.cfg('inference.oneline_control_re'), 'g'), ' ').replace(new RegExp(ah.cfg('inference.oneline_bidi_re'), 'g'), '').replace(/\s+/g, ' ').trim();
    if (o.length > max) o = jx.sliceUnits(o, max).replace(/\s+$/, '') + ah.cfg('inference.ellipsis');
    return o;
  },
};
