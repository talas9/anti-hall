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
    var names = ah.cfg('guardkit.plain_names');
    var lines = [icons[kind] + ah.cfg('guardkit.msg_head') + text.clean(names[guard] || guard) + ': ' + text.clean(p.what || '')];
    var opt = [['why', p.why], ['instead', p.instead], ['allowed', p.allowed], ['override', p.override ? text.render(ah.cfg('guardkit.override_human'), { guard: guard }) : '']];
    for (var i = 0; i < opt.length; i++) if (opt[i][1]) lines.push(labels[opt[i][0]] + text.clean(opt[i][1]));
    (p.extra || []).forEach(function (l) { if (l) lines.push(text.clean(l)); });
    return lines.join('\n');
  },
  // Save the complete instructions before shortening the visible block. A failed write keeps the full message.
  detailsMessage: function (kind, guard, p, session) {
    var full = text.message(kind, guard, p);
    var home = ah.home();
    if (!home) return full;
    var safe = String(session || ah.cfg('guardkit.details_session_default')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfg('guardkit.session_key_max'));
    var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('guardkit.details_dir') + '/' + guard + '-' + safe + ah.cfg('guardkit.details_ext');
    try { if (!ah.state.writeAtomic(rel, full + '\n')) return full; } catch (e) { return full; }
    return text.message(kind, guard, {
      what: ah.cfg('guardkit.brief_what')[guard],
      why: ah.cfg('guardkit.brief_why')[guard],
      instead: ah.cfg('guardkit.brief_instead')[guard],
      override: true,
      extra: [ah.cfg('guardkit.msg_labels').details + home + '/' + rel],
    });
  },
  // `io.blockDecision(reason)`: the JSON decision and a newline on stdout.
  blockJson: function (reason) { return JSON.stringify({ decision: 'block', reason: reason }) + '\n'; },
  advisoryJson: function (event, t) { return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: t } }); },
};
