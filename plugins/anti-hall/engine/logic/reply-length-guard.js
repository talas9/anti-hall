// check = "reply-length-guard" (Stop, Claude and Codex, loop-safe, stateless; R-style, GH #488 #489). Replies are short by default,
// detail only when asked: a final reply over reply_length.sw_max_chars / sw_max_lines (counted on the visible text; fenced code and
// markdown tables are free up to their allowances, only the excess counts) is held when the user's last message did not ask for detail,
// a plan, a design, a spec or a report (reply_length.detail_res). Switch guards.styleRule (default off). With it off the answer is
// empty; the reply is still counted (reply_style_observed, by result) so the problem rate can be read before the switch turns on.
// No state file: the retry that follows a hold carries stop_hook_active and is allowed, so the guard cannot loop. A repeated hit in one
// owner turn is told from a first one by the marker (reply_length.marker) in the hook feedback after the user's last prompt
// (reply_style_fired{again}). Reads only the reply (last_assistant_message) and the owner turn's text from the transcript tail.
// Plan mode, subagents and a Codex payload with no reply text allow. Every number, pattern and text: reply_length.toml.
'use strict';

// The number of cells of a table row (GFM): escaped characters do not split, the outer pipes are optional.
function rsCells(row) {
  var t = row.replace(jx.re('reply_length.table_quote_re', ''), '').replace(jx.re('reply_length.table_escape_re', 'g'), 'x').replace(jx.re('reply_length.table_edge_re', 'g'), '');
  return t.split(ah.cfg('reply_length.table_pipe')).length;
}

// The quote depth of a line (its blockquote markers).
function rsQuote(line) {
  var m = jx.re('reply_length.table_quote_re', '').exec(line);
  return m ? m[0].split('>').length - 1 : 0;
}

// Classify every line of the reply: 'fence' (a fence marker line), 'code' (inside a fenced block), 'table' (a GFM table: header, delimiter
// row and body rows), 'blank' or 'text' (prose). Fences follow CommonMark (backtick or tilde runs of 3 or more, an info string, a closer
// of the same character and at least the same length with nothing after it; an unclosed fence runs to the end). A table is found by its
// DELIMITER ROW (outer pipes optional, alignment colons) whose cell count equals the header row's; its body runs to a blank line, a fence,
// another block start (reply_length.table_break_re) or a change of quote depth.
function rsClassify(lines) {
  var fence = jx.re('reply_length.fence_re', ''), delim = ah.cfg('reply_length.table_delim_re'), brk = ah.cfg('reply_length.table_break_re');
  var pipe = ah.cfg('reply_length.table_pipe'), quote = jx.re('reply_length.table_quote_re', ''), slack = ah.cfgNum('reply_length.fence_close_indent');
  var kind = [], inCode = false, run = '', prefixLen = 0, i, fm;
  for (i = 0; i < lines.length; i++) {
    fm = fence.exec(lines[i]);
    if (inCode) {
      // a fence closes only on a run of the same character, at least as long as the opener, with nothing after it
      if (fm && fm[2].charAt(0) === run.charAt(0) && fm[2].length >= run.length && fm[3].trim() === '' && fm[1].length <= prefixLen + slack) {
        inCode = false;
        kind.push('fence');
      } else kind.push('code');
    } else if (fm && !(fm[2].charAt(0) === '`' && fm[3].indexOf('`') >= 0)) {
      inCode = true;
      run = fm[2];
      prefixLen = fm[1].length;
      kind.push('fence');
    } else kind.push(lines[i].trim() === '' ? 'blank' : 'text');
  }
  for (i = 1; i < lines.length; i++) {
    if (kind[i] !== 'text' || kind[i - 1] !== 'text') continue;
    var row = lines[i].replace(quote, '');
    if (row.indexOf(pipe) < 0 || !ah.re.find(delim, '', row) || rsCells(lines[i - 1]) !== rsCells(lines[i])) continue;
    var depth = rsQuote(lines[i - 1]);
    if (rsQuote(lines[i]) !== depth) continue;
    kind[i - 1] = kind[i] = 'table';
    for (i = i + 1; i < lines.length && kind[i] === 'text' && rsQuote(lines[i]) === depth && !ah.re.find(brk, '', lines[i].replace(quote, '')); i++) kind[i] = 'table';
    i--;
  }
  return kind;
}

// {chars, lines} of the visible text: fenced lines and table rows are counted apart and only their excess over the allowance adds to the size.
function rsSize(reply) {
  var lines = reply.split('\n'), kind = rsClassify(lines);
  var chars = 0, rows = 0, codeChars = 0, codeRows = 0, tabChars = 0, tabRows = 0;
  for (var i = 0; i < lines.length; i++) {
    if (kind[i] === 'fence') continue;
    var l = lines[i], n = Array.from(l).length, filled = l.trim() !== '';
    if (kind[i] === 'code') { codeChars += n; if (filled) codeRows++; }
    else if (kind[i] === 'table') { tabChars += n; tabRows++; }
    else { chars += n; if (filled) rows++; }
  }
  return {
    chars: chars + Math.max(0, codeChars - ah.cfgNum('reply_length.code_allow_chars')) + Math.max(0, tabChars - ah.cfgNum('reply_length.table_allow_chars')),
    lines: rows + Math.max(0, codeRows - ah.cfgNum('reply_length.code_allow_lines')) + Math.max(0, tabRows - ah.cfgNum('reply_length.table_allow_lines')),
  };
}

function rsAsked(userText) {
  var res = ah.cfg('reply_length.detail_res');
  for (var i = 0; i < res.length; i++) if (ah.re.find(res[i], 'i', userText)) return true;
  return false;
}

// The user's last real prompt in the transcript tail: {text, again}, again = an earlier hit of this guard (its marker inside hook
// feedback, not in an assistant message) stands after that prompt. null when the transcript cannot be read or holds no prompt.
function rsOwner(tp) {
  var types = ah.cfg('block_cap.record_types'), marker = ah.cfg('reply_length.marker');
  var lines = ah.fs.tailLines(tp, ah.cfgNum('reply_length.tail_bytes'), true, [types.claude_user, types.codex_event, '\\u', marker]);
  if (lines === null) return null;
  var flags = ah.cfg('block_cap.non_owner_flags'), origins = ah.cfg('block_cap.owner_origins');
  for (var i = lines.length - 1; i >= 0; i--) {
    var r = jx.parse(lines[i]);
    if (r.unsure) return null;
    if (r.invalid || !jx.isObj(r.v)) continue;
    var e = r.v, msg = e.message, content;
    if (e.type === types.claude_user && jx.isObj(msg)) content = msg.content;
    else if (e.type === types.codex_event && jx.isObj(e.payload) && e.payload.type === types.codex_user) {
      msg = e.payload;
      content = msg.message;
    } else continue;
    if ([e, msg].some(function (o) {
      if (flags.some(function (f) { return !!o[f]; })) return true;
      var origin = o.origin;
      return !!origin && origins.indexOf(jx.isObj(origin) ? origin.kind : origin) < 0;
    })) continue;
    var t = '';
    if (typeof content === 'string') t = content;
    else if (Array.isArray(content)) {
      if (content.some(function (b) { return b && b.type === types.tool_result; })) continue;
      t = content.filter(function (b) { return b && b.type === types.text && typeof b.text === 'string'; })
        .map(function (b) { return b.text; }).join('\n');
    }
    t = t.replace(jx.re('block_cap.leading_reminders_re', 'i'), '');
    if (!t.trim() || jx.re('block_cap.injected_re', 'i').test(t)) continue;
    return { text: t, again: rsAgain(lines, i + 1, marker) };
  }
  return null;
}

// True when a line from `from` on is hook feedback carrying the marker (an assistant message that quotes the marker is not feedback).
function rsAgain(lines, from, marker) {
  var tokens = ah.cfg('reply_length.feedback_tokens'), assistant = ah.cfg('reply_length.assistant_type');
  for (var j = from; j < lines.length; j++) {
    var l = lines[j];
    if (l.indexOf(marker) < 0 || !tokens.some(function (k) { return l.indexOf(k) >= 0; })) continue;
    var r = jx.parse(l);
    if (r.unsure || r.invalid || !jx.isObj(r.v)) continue;
    if (r.v.type !== assistant) return true;
  }
  return false;
}

function decide(p) {
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  if (p === null || typeof p !== 'object') return 'allow';
  var on = ah.settings.bool('reply_length.sw_guard'), res = ah.cfg('reply_length.results'), why = ah.cfg('reply_length.reasons');
  // an exempt reply: counted whatever the switch, and as suppressed only while the guard is on
  var exempt = function (reason) {
    ah.metric('reply_style_observed', ['result', res.exempt, 'reason', reason]);
    if (on) ah.metric('reply_style_suppressed', ['reason', reason]);
    return 'allow';
  };
  if (ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return exempt(why.subagent);
  if (p.stop_hook_active === true) return exempt(why.stop_hook_active);
  var reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  if (!reply.trim()) return exempt(why.no_reply_text);

  // the cheap gate: sizes of the reply alone (a short ack, the common case, ends here)
  var maxChars = ah.settings.num('reply_length.sw_max_chars'), maxLines = ah.settings.num('reply_length.sw_max_lines');
  var size = rsSize(reply);
  if (size.chars <= maxChars && size.lines <= maxLines) {
    ah.metric('reply_style_observed', ['result', res.ok, 'reason', res.none]);
    if (on) ah.metric('reply_style_suppressed', ['reason', why.short]);
    return 'allow';
  }
  if (typeof p.permission_mode === 'string' && p.permission_mode.toLowerCase() === ah.cfg('tasklist_guard.plan_mode_value')) return exempt(why.plan_mode);

  // the user's last message: detail, a plan, a design, a spec or a report asked for means a long reply is wanted
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  var owner = tp ? rsOwner(tp) : null;
  if (owner === null) return exempt(why.no_owner_text);
  if (rsAsked(owner.text)) return exempt(why.asked);
  ah.metric('reply_style_observed', ['result', res.over, 'reason', res.none]);
  var guard = ah.cfg('reply_length.guard_name');
  if (!on || ah.settings.skipped(guard)) return 'allow';

  var vars = { chars: String(size.chars), lines: String(size.lines), max_chars: String(maxChars), max_lines: String(maxLines) };
  var form = ah.cfg('reply_length.form') === 'note' ? 'note' : 'block';
  ah.log(ah.cfg('reply_length.log_kind'), text.render(ah.cfg('reply_length.log_fired'), vars));
  ah.metric('reply_style_fired', ['form', form, 'again', owner.again ? 'true' : 'false']);
  var reason = text.message('block', guard, { what: text.render(ah.cfg('reply_length.msg_what'), vars), instead: text.render(ah.cfg('reply_length.msg_instead'), vars) });
  var out = form === 'note' ? { systemMessage: reason } : { decision: 'block', reason: reason };
  return { exact: { code: 0, out: JSON.stringify(out) + '\n', err: '' } };
}
