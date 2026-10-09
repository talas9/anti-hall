// check = "devswarm-rt-advisory" (UserPromptSubmit, main thread). DECISION logic only: given what the engine read (the session's last
// seen state generation, the state's generation and the changes since), say whether to advise, the text, and the generation to
// remember. The engine does the I/O (the live state, the per-session marker file). Everything configurable is in devswarm_wire.toml.
'use strict';

function fill(tpl, vars) {
  var t = String(tpl);
  for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) t = t.split('{' + k + '}').join(String(vars[k]));
  return t;
}

function build(parts, left, generation) {
  var more = left > 0 ? fill(ah.cfg('devswarm_wire.msg_more'), { n: left }) : '';
  return fill(ah.cfg('devswarm_wire.msg_advisory'), { changes: parts.join(ah.cfg('devswarm_wire.msg_separator')), more: more, generation: generation });
}

function decide(p, opts, event) {
  var res = { advise: null, mark: null };
  if (p && p.enabled === true && p.sessionOk === true) {
    var gen = p.generation, seen = p.seen;
    if (typeof seen !== 'number') {
      // the first look of a session starts from now: a new session is not told the whole history
      res.mark = gen;
    } else {
      var kinds = ah.cfg('devswarm_wire.advisory_kinds');
      var edges = (p.edges || []).filter(function (e) { return kinds.indexOf(e.kind) >= 0; });
      if (gen !== seen) res.mark = gen;
      if (edges.length > 0) {
        var maxEdges = ah.cfg('devswarm_wire.advisory_max_edges'), maxChars = ah.cfg('devswarm_wire.advisory_max_chars');
        var parts = edges.slice(0, maxEdges).map(function (e) {
          return fill(ah.cfg(e.from === '' ? 'devswarm_wire.msg_edge_new' : 'devswarm_wire.msg_edge'), { ws: e.label, kind: e.kind, from: e.from, to: e.to });
        });
        var shown = parts.length, text = build(parts, edges.length - shown, gen);
        while (text.length > maxChars && shown > 1) {
          shown -= 1;
          text = build(parts.slice(0, shown), edges.length - shown, gen);
        }
        res.advise = text.slice(0, maxChars);
      }
    }
  }
  return { exact: { code: 0, out: JSON.stringify(res), err: '' } };
}
