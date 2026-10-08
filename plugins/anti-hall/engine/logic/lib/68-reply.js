// Reading a reply out of a transcript the way the Node Stop hooks do (D88 batch 6): the bounded tail as lines, the text of one
// entry (`collectTextFromEntry`, which reads a nested message again after its parent, so a text can appear twice) and the text of the
// last assistant entry. Shared by the reply checks (speculation-guard, speculation-judge).
'use strict';
var rp = {
  // The last `window` bytes of a transcript as lines (`split(/\r?\n/)`, a line cut by the window dropped), or null when unreadable.
  lines: function (path, window) {
    var t = ah.fs.readTail(path, window);
    return t === null ? null : t.split(/\r?\n/);
  },
  // The text of one transcript entry; `map` (optional) is applied to every collected string.
  collect: function (node, map) {
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
    if (node.message && typeof node.message === 'object' && node.message !== node) {
      var sub = rp.collect(node.message, map);
      if (sub) parts.push(sub);
    }
    return parts.join(' ');
  },
  // The text of the last assistant entry of `lines` that has any: {text} (null when none) or {unsure: true}.
  lastAssistant: function (lines, map) {
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
      var e = r.v;
      var role = e && (e.role || (e.message && e.message.role));
      if (role !== ah.cfg('replykit.role_assistant')) continue;
      var text = rp.collect(e, map);
      if (text) last = text;
    }
    return { text: last };
  },
};
