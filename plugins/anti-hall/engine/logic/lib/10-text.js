// Shared text helpers of the check scripts (mirror hooks/lib/block-message.js and the guard I/O shapes).
'use strict';
var text = {
  isSpace: function (c) { return /^\s$/.test(c); },
  clean: function (s) { return String(s).replace(/\s+/g, ' ').trim(); },
  // `{name}` placeholders filled from args; an unknown one is left as written; a value is never re-scanned.
  render: function (t, args) {
    return t.replace(/\{([^{}]*)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(args, n) ? String(args[n]) : m; });
  },
  // The one message layout every guard block or advisory uses.
  message: function (kind, guard, p) {
    var icons = ah.cfg('guardkit.icons'), labels = ah.cfg('guardkit.msg_labels');
    var lines = [icons[kind] + ah.cfg('guardkit.msg_head') + text.clean(guard) + ': ' + text.clean(p.what || '')];
    var opt = [['why', p.why], ['instead', p.instead], ['allowed', p.allowed], ['override', p.override]];
    for (var i = 0; i < opt.length; i++) if (opt[i][1]) lines.push(labels[opt[i][0]] + text.clean(opt[i][1]));
    (p.extra || []).forEach(function (l) { if (l) lines.push(text.clean(l)); });
    return lines.join('\n');
  },
  // `io.blockDecision(reason)`: the JSON decision and a newline on stdout.
  blockJson: function (reason) { return JSON.stringify({ decision: 'block', reason: reason }) + '\n'; },
  advisoryJson: function (event, t) { return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: t } }); },
};
