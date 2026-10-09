// Which "recommend compacting" replies are wrongly timed, and the current turn of a transcript (D88 batch 7): a translation of
// hooks/lib/compact-advice.js (`findAdvice`, `lastRetraction`, `stripQuoted`, `readTurn`) for the compact-advice-guard. A check script
// runs in the same language the Node hook does, so the phrase rules are the Node regular expressions as they are; this file is where
// they are edited. A transcript line the interpreter might read differently from Node (JSON that only V8 parses, a timestamp of a
// form only V8 reads) sets `cadv.unsure`, and the caller defers.
'use strict';
var cadv = {
  unsure: false,
  // Injected (not typed) user content never starts a turn.
  NOT_TYPED_RE: /^\s*<(task-notification|local-command-|system-reminder|bash-std(out|err))/,
  LEADING_REMINDERS_RE: /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/,
  NOTIFY_RE: /^\s*<task-notification>/,
  COMPACT_CMD_RE: /^\s*<command-name>\s*\/compact\s*<\/command-name>/,
  // Negation just before a match, conditional and meta lead-ins, negation just after.
  NEGATION_BEFORE_RE: /(?:\bnot\s+yet\b|\bnot\b|n['’]t\b|\bnever\b|\bno\s+need\b|\bno\s+reason\b|\bfar\s+from\b|\bnowhere\s+near\b|\bonce\b[\s\S]{0,60}\bit\s+will\s+be\b|\bretract(?:ed|ing)?\b)[^.!?\n]{0,20}$/i,
  NEGATION_AFTER_RE: /^[^.!?\n]{0,30}[,;]\s*(?:but\s+|and\s+)?first\b|^\s*(?:after|once|when|if)\b/i,
  CONDITIONAL_BEFORE_RE: /\b(?:if|when|once|after|until)\b[^:\n]{0,60}:\s*$/i,
  META_BEFORE_RE: /\bwill\s+(?:only\s+)?(?:say|write|declare)\s*$|\bwhen\s+I\s+(?:say|write|declare)\s*$/i,
  // Explicit recommendation forms only.
  ADVICE_RES: [
    /\bsafe\s+to\s+(?:\/compact|compact|\/clear)\b/gi,
    /\bgood\s+(?:point|time|moment)\s+(?:to|for)\s+(?:\/?compact|\/?clear|\/new)\b/gi,
    /\bsafe\s+for\s+(?:a\s+)?(?:context\s+)?(?:reset|compaction|\/?compact|\/new)\b/gi,
    /\b(?:run|type|use|do|then|now|recommend(?:ed)?|suggest(?:ed)?)\s*:?\s*`*\/compact\b/gi,
    /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*`*\/compact\b(?:[ \t]+(?:now|focus:\s*\S[^\n]*))?[ \t]*`*[ \t]*$/gim,
  ],
  RETRACT_RE: /\bretract(?:ed|ing)?\b[\s:,\-—–*_`"'“”]*(?:the\s+)?(?:[*_`✅🟢]\s*)*(?:safe[\s-]+(?:to|for)[\s-]+(?:compact|clear|reset|a\s+(?:context\s+)?reset)|good\s+point\s+(?:to|for)\s+\/?compact|\/compact)/gi,
  LINE_RETRACT_RE: /^[ \t]*[*_`>\-•]*[ \t]*retract(?:ed|ing)?\b/gim,
  MARKER_LINE_RE: /^[ \t]*(?:#{1,6}[ \t]+)?(?:[-*+•][ \t]+)?[*_`✅🟢⏳ \t]*(?:HANDOVER[ \t]+COMPLETE[ \t]*[—–-]+[ \t]*)?[*_`]*SAFE[ \t]+TO[ \t]+(?:\/?COMPACT|\/CLEAR)(?:[ \t]+(?:OR|AND)[ \t]+\/?(?:CLEAR|COMPACT|NEW))?(?:[ \t]+NOW)?[*_`]*[ \t]*[.!]?[ \t]*$/u,
  LEAD_INTERJECTION_RE: /^(?:yes|yeah|yep|no|nope|ok|okay|sure|right|correct|agreed|indeed|actually|honestly|overall|great|good|alright|well|so|also|anyway|regardless)$/i,

  // Whether a text holds the words of at least one recommendation wording (a necessary condition of findAdvice): the cheap first test.
  mayAdvise: function (t) {
    var lower = String(t).toLowerCase(), has = function (w) { return lower.indexOf(w.toLowerCase()) !== -1; };
    var any = function (key) { return ah.cfg(key).some(has); };
    return (has(ah.cfg('ctxbudget.advice_safe_word')) && any('ctxbudget.advice_needs_safe')) || has(ah.cfg('ctxbudget.advice_slash_compact')) ||
      (has(ah.cfg('ctxbudget.advice_good_word')) && any('ctxbudget.advice_needs_good'));
  },

  // Fenced code, blockquote lines, double-quoted spans and quoted mentions blanked to spaces (same length, so indices stay comparable).
  stripQuoted: function (text) {
    var t = String(text || '');
    // a pass that needs a character the text does not hold changes nothing: skipped, so a very long plain reply costs no regex scans
    var has = function (c) { return t.indexOf(c) !== -1; };
    if (has('```')) t = t.replace(/```[\s\S]*?```/g, function (m) { return m.replace(/[^\n]/g, ' '); });
    if (has('>')) t = t.replace(/^[ \t]*>.*$/gm, function (m) { return ' '.repeat(m.length); });
    if (has('"') || has('“') || has('”')) t = t.replace(/”[^”\n]{0,400}”|“[^”\n]{0,400}”|"[^"\n]{0,400}"/g, function (m) { return ' '.repeat(m.length); });
    if (has('`')) t = t.replace(/`[^`\n]{0,400}`/g, function (m, off) {
      if (!/\/(?:compact|clear|new)\b/i.test(m)) return ' '.repeat(m.length);
      var before = t.slice(Math.max(0, off - 40), off);
      var instruction = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])?[ \t]*$/.test(before) || /\b(?:run|type|use|do|then|now|recommend(?:ed)?|suggest(?:ed)?)\s*:?\s*$/i.test(before);
      return instruction ? m : ' '.repeat(m.length);
    });
    if (has("'")) t = t.replace(/(^|[\s([{])'([^'\n]{0,400})'(?=[\s.,;:!?)\]}]|$)/g, function (m, pre, inner) {
      return /\/(?:compact|clear|new)\b/i.test(inner) ? m : pre + ' '.repeat(inner.length + 2);
    });
    return t;
  },
  isMarkerLine: function (t, index) {
    var start = t.lastIndexOf('\n', index - 1) + 1, end = t.indexOf('\n', index);
    if (end === -1) end = t.length;
    return cadv.MARKER_LINE_RE.test(t.slice(start, end));
  },
  isTableRow: function (t, index) {
    var start = t.lastIndexOf('\n', index - 1) + 1, end = t.indexOf('\n', index);
    if (end === -1) end = t.length;
    var line = t.slice(start, end), rel = index - start;
    return /^\s*\|/.test(line) || (line.slice(0, rel).includes('|') && line.slice(rel).includes('|'));
  },
  isAtSentenceOrLineStart: function (t, index) {
    var i = index, crossedNewline = false;
    while (i > 0 && /[\s*_`"'“”✅🟢⏳❌⚠️\-•>]/.test(t[i - 1])) {
      if (t[i - 1] === '\n') crossedNewline = true;
      i--;
    }
    if (i === 0 || crossedNewline) return true;
    if (/[.!?:]/.test(t[i - 1])) return true;
    if (t[i - 1] === ',') {
      var j = i - 1;
      while (j > 0 && /\s/.test(t[j - 1])) j--;
      var k = j;
      while (k > 0 && /[A-Za-z]/.test(t[k - 1])) k--;
      if (k < j && cadv.LEAD_INTERJECTION_RE.test(t.slice(k, j))) {
        var s = k, crossed2 = false;
        while (s > 0 && /\s/.test(t[s - 1])) {
          if (t[s - 1] === '\n') crossed2 = true;
          s--;
        }
        if (s === 0 || crossed2 || /[.!?:]/.test(t[s - 1])) return true;
      }
    }
    return false;
  },
  isQuestionSentence: function (t, index) {
    var m = /[.!?]/.exec(t.slice(index));
    return !!m && m[0] === '?';
  },
  // The assistant's own compact recommendations as [{index, phrase}] by index, negated, quoted and questioned ones excluded.
  findAdvice: function (text) {
    var t = cadv.stripQuoted(text), out = [];
    cadv.ADVICE_RES.forEach(function (re, reIndex) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(t)) !== null) {
        var before = t.slice(Math.max(0, m.index - 60), m.index), after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
        var negated = cadv.NEGATION_BEFORE_RE.test(before) || cadv.NEGATION_AFTER_RE.test(after) || cadv.CONDITIONAL_BEFORE_RE.test(before) || cadv.META_BEFORE_RE.test(before);
        var questioned = cadv.isQuestionSentence(t, m.index), isBareSafePhrase = reIndex === 0, isCommandForm = reIndex === 3;
        var isAllCaps = isBareSafePhrase && /^SAFE\s+TO\s+(?:\/?COMPACT|\/CLEAR)$/.test(m[0].trim());
        var positioned = isAllCaps ? (cadv.isMarkerLine(t, m.index) || !cadv.isTableRow(t, m.index))
          : ((!isBareSafePhrase && !isCommandForm) || cadv.isAtSentenceOrLineStart(t, m.index));
        if (!negated && !questioned && positioned) out.push({ index: m.index, phrase: m[0].trim() });
        if (m[0].length === 0) re.lastIndex++;
      }
    });
    return out.sort(function (a, b) { return a.index - b.index; });
  },
  // The index of the last retraction line, or -1.
  lastRetraction: function (text) {
    var t = String(text || ''), last = -1, m;
    cadv.RETRACT_RE.lastIndex = 0;
    while ((m = cadv.RETRACT_RE.exec(t)) !== null) last = Math.max(last, m.index);
    cadv.LINE_RETRACT_RE.lastIndex = 0;
    while ((m = cadv.LINE_RETRACT_RE.exec(t)) !== null) last = Math.max(last, m.index);
    return last;
  },

  textOfBlocks: function (content, textTypes) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(function (b) { return b && textTypes.indexOf(b.type) !== -1 && typeof b.text === 'string'; }).map(function (b) { return b.text; }).join('\n');
  },
  // The entry's time in ms, or null; `unsure` is set for a form only V8 reads.
  tsOf: function (e) {
    if (!e || typeof e.timestamp !== 'string') return null;
    var ms = jx.isoMs(e.timestamp);
    if (ms === undefined) { cadv.unsure = true; return null; }
    return isFinite(ms) ? ms : null;
  },
  // One normalized event, a list of them (kind 'multi') or null.
  classify: function (line) {
    if (!line) return null;
    var r = jx.parse(line);
    if (r.unsure) { cadv.unsure = true; return null; }
    if (r.invalid) return null;
    var e = r.v;
    if (!e || typeof e !== 'object') return null;
    if (e.type === 'system' && e.subtype === 'compact_boundary') return { kind: 'compact', at: cadv.tsOf(e) };
    if (e.isSidechain === true) return null;
    if (e.type === 'user' && e.message) {
      if (e.isMeta || e.isCompactSummary) return null;
      var c = e.message.content;
      if (Array.isArray(c) && c.some(function (b) { return b && b.type === 'tool_result'; })) return { kind: 'tool' };
      var txt = cadv.textOfBlocks(c, ['text']);
      if (cadv.NOTIFY_RE.test(txt)) return { kind: 'notify' };
      var typed = txt.replace(cadv.LEADING_REMINDERS_RE, '');
      if (!typed.trim() || cadv.NOT_TYPED_RE.test(typed) || cadv.COMPACT_CMD_RE.test(typed)) return null;
      return { kind: 'user' };
    }
    if (e.type === 'assistant' && e.message) {
      var ac = e.message.content, events = [];
      if (Array.isArray(ac)) {
        for (var i = 0; i < ac.length; i++) {
          var b = ac[i];
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) events.push({ kind: 'text', text: b.text });
          else if (b.type === 'tool_use') events.push({ kind: 'tool' });
        }
      } else if (typeof ac === 'string' && ac.trim()) {
        events.push({ kind: 'text', text: ac });
      }
      return events.length === 1 ? events[0] : (events.length ? { kind: 'multi', events: events } : null);
    }
    if (e.type === 'compacted') return { kind: 'compact', at: cadv.tsOf(e) };
    var p = e.payload;
    if (!p || typeof p !== 'object') return null;
    if (e.type === 'event_msg') {
      if (p.type === 'context_compacted') return { kind: 'compact', at: cadv.tsOf(e) };
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim() && !cadv.NOT_TYPED_RE.test(p.message)) return { kind: 'user' };
      return null;
    }
    if (e.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') {
        var ct = cadv.textOfBlocks(p.content, ['output_text', 'text']);
        return ct.trim() ? { kind: 'text', text: ct } : null;
      }
      if (/(?:function_call|tool_call|shell_call)/.test(String(p.type || ''))) return { kind: 'tool' };
    }
    return null;
  },
  // {turnText, finalText, turnsSinceCompact, compactAt} of the transcript lines, or null when a line cannot be read as Node reads it.
  readTurn: function (lines) {
    var turnParts = [], finalParts = [], since = null, compactAt = null;
    cadv.unsure = false;
    var apply = function (ev) {
      if (ev.kind === 'user') { turnParts = []; finalParts = []; if (since !== null) since++; }
      else if (ev.kind === 'notify') { finalParts = []; if (since !== null) since++; }
      else if (ev.kind === 'compact') { since = 0; compactAt = ev.at; }
      else if (ev.kind === 'tool') finalParts = [];
      else if (ev.kind === 'text') { turnParts.push(ev.text); finalParts.push(ev.text); }
    };
    for (var i = 0; i < (lines || []).length; i++) {
      var ev = cadv.classify(lines[i]);
      if (cadv.unsure) return null;
      if (!ev) continue;
      if (ev.kind === 'multi') ev.events.forEach(apply); else apply(ev);
    }
    return { turnText: turnParts.join('\n'), finalText: finalParts.join('\n'), turnsSinceCompact: since, compactAt: compactAt };
  },
};
