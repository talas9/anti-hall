// check = "reply-length-guard" (Stop, Claude and Codex, loop-safe). Replies are short by default, detail only when asked: a final reply
// over reply_length.max_chars / max_lines (counted on the visible text; fenced code is free up to code_allow_lines / code_allow_chars,
// only the excess counts) is held ONCE per owner turn (blockCap, reply_length.max_blocks, so it can never loop) unless the user's
// last message asked for detail (reply_length.detail_res). A reply under both limits (a short ack included) is never read further.
// Reads only the reply (last_assistant_message) and the owner turn's text from the transcript tail (blockCap.ownerTurn: the last
// real user message, no scan beyond it). stop_hook_active, subagents and a script failure allow. mode = log writes the hit and allows.
// Every number, pattern and text: reply_length.toml.
'use strict';

// {chars, lines} of the visible text: fenced lines are counted apart and only their excess over the allowance adds to the size.
function rlSize(reply) {
  var fence = jx.re('reply_length.fence_re', ''), lines = reply.split('\n'), inCode = false;
  var chars = 0, rows = 0, codeChars = 0, codeRows = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (fence.test(l)) { inCode = !inCode; continue; }
    var n = Array.from(l).length;
    if (inCode) { codeChars += n; if (l.trim() !== '') codeRows++; continue; }
    chars += n;
    if (l.trim() !== '') rows++;
  }
  return { chars: chars + Math.max(0, codeChars - ah.cfgNum('reply_length.code_allow_chars')), lines: rows + Math.max(0, codeRows - ah.cfgNum('reply_length.code_allow_lines')) };
}

function rlAsked(userText) {
  var res = ah.cfg('reply_length.detail_res');
  for (var i = 0; i < res.length; i++) if (ah.re.find(res[i], 'i', userText)) return true;
  return false;
}

function rlState(path) {
  var none = { blocks: 0 };
  var f = jx.read(path);
  if (f.big || f.text === undefined) return none;
  var r = jx.parse(f.text.trim());
  if (r.unsure || r.invalid || !jx.isObj(r.v)) return none;
  return Object.assign({}, r.v, { blocks: typeof r.v.blocks === 'number' && isFinite(r.v.blocks) ? r.v.blocks : 0 });
}

function decide(p) {
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  if (!ah.settings.bool('reply_length.sw_guard')) return 'allow';
  if (p === null || typeof p !== 'object' || p.stop_hook_active === true) return 'allow';
  if (ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
  var guard = ah.cfg('reply_length.guard_name');
  if (ah.settings.skipped(guard)) return 'allow';
  var reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (!reply.trim() || !tp) return 'allow';

  // the cheap gate: sizes of the reply alone (a short ack, the common case, ends here)
  var maxChars = ah.settings.num('reply_length.sw_max_chars'), maxLines = ah.settings.num('reply_length.sw_max_lines');
  var size = rlSize(reply);
  if (size.chars <= maxChars && size.lines <= maxLines) return 'allow';

  // the user's last message: detail asked for means a long reply is wanted
  var owner = blockCap.ownerTurn(hookProc.open(p, tp));
  if (owner === null || typeof owner.text !== 'string') return 'allow';
  var kind = ah.cfg('reply_length.log_kind');
  if (rlAsked(owner.text)) { ah.log(kind, ah.cfg('reply_length.log_suppressed_asked')); return 'allow'; }

  // loop safety: a bounded number of holds per owner turn
  var home = ah.env.get(ah.cfg('env.home')) || ah.home();
  if (!home) return 'allow';
  var sid = (p.session_id && String(p.session_id)) || ah.sha1(tp).slice(0, 16);
  var stateName = ah.cfg('reply_length.state_prefix') + sid.replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('replykit.json_ext');
  var stateRel = ah.cfg('replykit.state_dir') + '/' + stateName;
  var cap = blockCap.open(rlState(home + '/' + stateRel), hookProc.open(p, tp), 'reply_length.cap_scope', home, stateRel);
  var prior = cap.state;
  if (prior.blocks >= ah.cfgNum('reply_length.max_blocks')) { ah.log(kind, ah.cfg('reply_length.log_suppressed_cap')); return 'allow'; }
  var vars = { chars: String(size.chars), lines: String(size.lines), max_chars: String(maxChars), max_lines: String(maxLines) };
  ah.log(kind, text.render(ah.cfg('reply_length.log_fired'), vars));
  if (ah.cfg('reply_length.mode') !== 'block') return 'allow';
  if (!cap.backup()) return 'allow';
  if (!ah.state.writeAtomic(stateRel, JSON.stringify(Object.assign({}, cap.blocked(), { blocks: prior.blocks + 1 })))) return 'allow';
  ah.state.prune(ah.cfg('reply_length.state_prefix'), stateName);
  var reason = text.message('block', guard, { what: text.render(ah.cfg('reply_length.msg_what'), vars), instead: text.render(ah.cfg('reply_length.msg_instead'), vars) });
  return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: reason }) + '\n', err: '' } };
}
