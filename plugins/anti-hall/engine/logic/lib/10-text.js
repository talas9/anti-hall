// Shared text helpers of the check scripts (mirror hooks/lib/block-message.js and the guard I/O shapes).
'use strict';
var text = {
  isSpace: function (c) { return /^\s$/.test(c); },
  clean: function (s) { return String(s).replace(/\s+/g, ' ').trim(); },
  // `{name}` placeholders filled from args; an unknown one is left as written; a value is never re-scanned.
  render: function (t, args) {
    return t.replace(/\{([^{}]*)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(args, n) ? String(args[n]) : m; });
  },
  // Visible text has one leading icon, at most two lines and at most 250 UTF-16 units.
  // Full context, exceptions and consent instructions belong only in the saved details.
  plain: function (s) {
    return text.clean(s).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2300-\u27BF\uFE0F\u200D]/g, '').replace(/`/g, '').trim();
  },
  short: function (s, max) {
    if (s.length <= max) return s;
    var cut = s.slice(0, max - 1), space = cut.lastIndexOf(' ');
    return (space > max / 2 ? cut.slice(0, space) : cut) + '…';
  },
  saveDetails: function (guard, p, session) {
    var home = ah.home();
    if (!home) return null;
    var safe = String(session || ah.cfg('guardkit.details_session_default')).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32);
    var id = String(guard).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
    var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('guardkit.details_dir') + '/' + id + '-' + safe + ah.cfg('guardkit.details_ext');
    var lines = [p.what || '', p.why || '', p.instead || '', p.allowed || ''];
    if (p.override) lines.push(ah.cfg('guardkit.msg_labels').override + (typeof p.override === 'string' ? p.override : text.render(ah.cfg('guardkit.override_human'), { guard: guard })));
    lines = lines.concat(p.extra || []);
    var instructions = ah.cfg('guardkit.long_instructions')[guard];
    if (instructions) lines.push(instructions);
    try { if (!ah.state.writeAtomic(rel, lines.filter(Boolean).join('\n\n') + '\n')) return null; } catch (e) { return null; }
    return '~/' + rel;
  },
  message: function (kind, guard, p, session) {
    var icons = ah.cfg('guardkit.icons'), labels = ah.cfg('guardkit.msg_labels');
    var names = ah.cfg('guardkit.plain_names');
    var name = text.short(text.plain(names[guard] || String(guard).replace(/-/g, ' ')), 40);
    var what = text.plain(p.what || ''), action = text.plain(p.instead || '');
    var prefix = (icons[kind] || icons.tip) + ' ' + name + ': ';
    var needsDetails = !!p.details || action.length > 115 || ah.cfg('guardkit.details_actions').indexOf(action) !== -1;
    var path = p.skipSave ? p.savedDetails : text.saveDetails(guard, p, session);
    if (action.length > 115) action = path ? 'follow the saved instructions.' : 'restore access to the details folder and retry.';
    if (needsDetails && !path) action = 'restore access to the details folder and retry.';
    if (needsDetails && path) action += ' (details: ' + path + ')';
    var second = action ? '\n' + labels.instead + action : '';
    // Bound dynamic claims, lists and names without cutting executable instructions or file paths.
    var room = 250 - prefix.length - second.length;
    if (room < 20) {
      action = path ? 'follow the saved instructions. (details: ' + path + ')' : 'restore access to the details folder and retry.';
      second = '\n' + labels.instead + action;
      room = 250 - prefix.length - second.length;
    }
    return prefix + text.short(what, Math.min(115, room)) + second;
  },
  detailsMessage: function (kind, guard, p, session) {
    var what = ah.cfg('guardkit.brief_what')[guard];
    var instead = ah.cfg('guardkit.brief_instead')[guard];
    // Save the complete original instructions, even when the short action needs no link.
    var path = text.saveDetails(guard, p, session);
    return text.message(kind, guard, { what: (what || p.what) + (typeof p.briefExtra === 'string' ? p.briefExtra : ''), instead: instead || p.instead, savedDetails: path, skipSave: true, details: !!p.details }, session);
  },
  // `io.blockDecision(reason)`: the JSON decision and a newline on stdout.
  blockJson: function (reason) { return JSON.stringify({ decision: 'block', reason: reason }) + '\n'; },
  advisoryJson: function (event, t) { return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: t } }); },
};
