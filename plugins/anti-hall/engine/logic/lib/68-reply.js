// Reading a reply out of a transcript the way the Node Stop hooks do (D88 batch 6): the bounded tail as lines, the text of one
// entry (`collectTextFromEntry`, which reads a nested message again after its parent, so a text can appear twice) and the text of the
// last assistant entry. Shared by the reply checks (speculation-guard, speculation-judge).
'use strict';
var rp = {
  // Native Codex message records carry the role/content in payload. Other response items are not conversation messages.
  entry: function (entry) {
    if (entry && entry.type === 'response_item' && entry.payload && entry.payload.type === 'message') return entry.payload;
    return entry;
  },
  // Filter candidate hits with the host's Unicode word class (letters, marks, numbers, connector punctuation and joiners).
  wordBoundary: function (text, hit) {
    return !ah.re.test(ah.cfg('replykit.word_before_re'), 'r', text.slice(0, hit[0])) &&
      !ah.re.test(ah.cfg('replykit.word_after_re'), 'r', text.slice(hit[1]));
  },
  wordHits: function (src, flags, text) {
    return ah.re.findAll(src, flags, text).filter(function (hit) { return rp.wordBoundary(text, hit); });
  },
  phraseHits: function (phrase, text) {
    if (!phrase) return [];
    var src = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return rp.wordHits(src, 'i', text);
  },
  // The last `window` bytes of a transcript as lines (`split(/\r?\n/)`, a line cut by the window dropped), or null when unreadable.
  // `needles` (optional): only the lines holding one of them come back (the host picks them; a caller that skips every other line
  // anyway never sees the rest, which is what keeps a 512 KB window out of the interpreter).
  lines: function (path, window, needles) {
    return ah.fs.tailLines(path, window, true, needles);
  },
  // The text of one transcript entry; `map` (optional) is applied to every collected string. `dedup` (Jev's input only) skips the
  // nested message when this entry's own `content` was already collected, so the text is not read twice.
  collect: function (node, map, dedup) {
    if (!node || typeof node !== 'object') return '';
    var f = map || function (s) { return s; };
    var parts = [];
    if (typeof node.text === 'string') parts.push(f(node.text));
    var content = node.content || (node.message && node.message.content);
    if (typeof content === 'string') {
      parts.push(f(content));
    } else if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (!b || typeof b !== 'object') continue;
        if (typeof b.text === 'string') parts.push(f(b.text));
      }
    }
    if (node.message && typeof node.message === 'object' && node.message !== node && (!dedup || node.content)) {
      var sub = rp.collect(node.message, map, dedup);
      if (sub) parts.push(sub);
    }
    return parts.join(' ');
  },
  // The text of the last assistant entry of `lines` that has any: {text} (null when none) or {unsure: true}. `dedup`: see collect.
  lastAssistant: function (lines, map, dedup) {
    var last = null;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      // an entry whose role is `assistant` names it in the text (or spells it with an escape): the rest need no parse
      if (raw.indexOf('assistant') < 0 && raw.indexOf('\\u') < 0) continue;
      var t = raw.trim();
      if (!t) continue;
      var r = jx.parse(t);
      if (r.unsure) return { unsure: true };
      if (r.invalid) continue;
      var e = rp.entry(r.v);
      var role = e && (e.role || (e.message && e.message.role));
      if (role !== ah.cfg('replykit.role_assistant')) continue;
      var text = rp.collect(e, map, dedup);
      if (text) last = text;
    }
    return { text: last };
  },
};
