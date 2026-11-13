// Reading a reply out of a transcript the way the Node Stop hooks do (D88 batch 6): the bounded tail as lines, the text of one
// entry (`collectTextFromEntry`, which reads a nested message again after its parent, so a text can appear twice) and the text of the
// last assistant entry. Shared by the reply checks (speculation-guard, speculation-judge).
'use strict';
var rp = {
  // Only authored prose is eligible for reply guards. Keep injection/feedback patterns in TOML, and preserve line boundaries.
  ownText: function (value) {
    var t = value;
    ah.cfg('replykit.injected_text_patterns').forEach(function (src) {
      t = t.replace(new RegExp(src, 'gim'), function (m) { return m.replace(/[^\r\n]/g, ' '); });
    });
    return t;
  },
  authoredEntry: function (entry) {
    if (!entry || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false;
    var origin = entry.origin;
    if (!origin) return true;
    return typeof origin === 'object' && ah.cfg('replykit.human_origins').indexOf(origin.kind) >= 0;
  },
  // The host deliberately keeps an all-quoted reply. Appending plain prose makes quoted-only protocol mask identically to
  // quoted material in a mixed reply, without changing the host or bringing its raw-text fallback back into these guards.
  ownMasked: function (value) {
    var t = rp.ownText(value), suffix = '\n' + ah.cfg('replykit.mask_boundary');
    // Mask open fences too: the host masks closed pairs only. This leaves prose after a real closing fence intact.
    var fence = new RegExp(ah.cfg('speculation_guard.fence_line_re')), open = null;
    t = t.split('\n').map(function (line) {
      var match = fence.exec(line), masked = open !== null || match !== null;
      if (match) {
        var marker = match[1].charAt(0);
        if (open === null) open = marker;
        else if (open === marker) open = null;
      }
      return masked ? line.replace(/[^\r]/g, ' ') : line;
    }).join('\n');
    return ah.text.maskQuoted(t + suffix).slice(0, t.length);
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
  lastAssistant: function (lines, map, dedup, authored) {
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
      if (role !== ah.cfg('replykit.role_assistant') || (authored && !rp.authoredEntry(e))) continue;
      var text = rp.collect(e, map, dedup);
      if (text) last = text;
    }
    return { text: last };
  },
};
