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
    // GH #764: the order form is the one single-line form of the idle orders (prompt_emit.toml idle_order.msg_*): icon, "Do now:" and
    // the action in one template, guardkit.order_form (placeholders {name}, {what}, {action}).
    var ordered = kind === 'order', form = ordered ? ah.cfg('guardkit.order_form') : '';
    var prefix = ordered ? '' : (icons[kind] || icons.tip) + ' ' + name + ': ';
    var needsDetails = !!p.details || action.length > 115 || ah.cfg('guardkit.details_actions').indexOf(action) !== -1;
    var path = p.skipSave ? p.savedDetails : text.saveDetails(guard, p, session);
    if (action.length > 115) action = path ? 'follow the saved instructions.' : 'restore access to the details folder and retry.';
    if (needsDetails && !path) action = 'restore access to the details folder and retry.';
    if (needsDetails && path) action += ' (details: ' + path + ')';
    var second = action ? '\n' + labels.instead + action : '';
    if (ordered) {
      var over = text.render(form, { name: name, what: '', action: action }).length;
      return text.render(form, { name: name, what: text.short(what, Math.min(115, Math.max(20, 250 - over))), action: action }).replace(/\s+$/, '');
    }
    // Bound dynamic claims, lists and names without cutting executable instructions or file paths.
    var room = 250 - prefix.length - second.length;
    if (room < 20) {
      action = path ? 'follow the saved instructions. (details: ' + path + ')' : 'restore access to the details folder and retry.';
      second = '\n' + labels.instead + action;
      room = 250 - prefix.length - second.length;
    }
    // a must-keep tail of the claim (the rule that fired, the named heavy segment: GH #417, #857) outranks the generic head: the head
    // shows only when it fits whole beside the tail (a cut head reads as a stub, "this heavy…"), else the tail stands alone
    var tail = typeof p.whatTail === 'string' ? text.plain(p.whatTail) : '', lim = Math.min(115, room);
    if (tail) return prefix + (what && what.length + 1 + tail.length <= lim ? what + ' ' + tail : text.short(tail, lim)) + second;
    return prefix + text.short(what, lim) + second;
  },
  detailsMessage: function (kind, guard, p, session) {
    var what = ah.cfg('guardkit.brief_what')[guard];
    var instead = ah.cfg('guardkit.brief_instead')[guard];
    // an addition to the short action (Part C of GH #800): joined to it with a comma, the original text kept whole in the saved details
    var base = instead;
    if (instead && typeof p.briefInsteadExtra === 'string' && p.briefInsteadExtra) instead = instead.replace(/[.\s]+$/, '') + ', ' + p.briefInsteadExtra;
    // Save the complete original instructions, even when the short action needs no link.
    var path = text.saveDetails(guard, p, session);
    var tail = typeof p.briefExtra === 'string' ? p.briefExtra : '';
    var out = text.message(kind, guard, { what: what || p.what, whatTail: tail, instead: instead || p.instead, savedDetails: path, skipSave: true, details: !!p.details }, session);
    // the named heavy segment outranks the action's addition when both do not fit (both stay whole in the saved details the link names)
    if (tail && base !== instead && out.indexOf(text.plain(tail)) === -1) out = text.message(kind, guard, { what: what || p.what, whatTail: tail, instead: base, savedDetails: path, skipSave: true, details: !!p.details }, session);
    return out;
  },
  // `io.blockDecision(reason)`: the JSON decision and a newline on stdout.
  blockJson: function (reason) { return JSON.stringify({ decision: 'block', reason: reason }) + '\n'; },
  advisoryJson: function (event, t) { return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: t } }); },
};
