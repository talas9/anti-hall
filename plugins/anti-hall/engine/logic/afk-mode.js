// check = "afk-mode" (UserPromptSubmit, PreToolUse, PostToolUse, Stop on Claude; SessionStart, UserPromptSubmit, PostToolUse, Stop on Codex; engine-only,
// no Node twin; GH #425). AFK mode: a machine-wide flag (afk.flag_file) set by `ah-engine afk on`, by the owner typing `afk`, or by
// idle detection; the rule injected once per session per AFK period plus capped reminders; an AFK marker in the session progress
// file, whose checklist bullets are the digest `back` / `progress` print; a capped Stop hold of overlong AFK replies; output tokens
// per turn split AFK vs present; no blocking questions (the question tool denied with the ladder every time, a capped Stop hold of
// a turn ending on a plain-text question, NEEDS OWNER bullets listed first); ExitPlanMode approved (allow + updatedInput) after an
// advisor call newer than the owner's last prompt (hook-recorded watermarks). Subagents never get the rule nor touch the parent's
// once-per-session state; their question-tool calls are denied too. The flag is only rewritten under its lock (OFF wins). Every pattern, list, number and text: afk.toml. `afkDigest` is pure (cfg and files in, text out) so
// the `ah-engine back` command and the typed `back` share it.
'use strict';

function afkC(C, k) { return C[k]; }
// The digest's part of afk.toml, read here when the hook renders the digest (the engine's `back` passes the same table).
function afkDigestCfg() {
  return {
    msg_digest_head: ah.cfg('afk.msg_digest_head'), msg_digest_none: ah.cfg('afk.msg_digest_none'), msg_digest_more: ah.cfg('afk.msg_digest_more'),
    msg_pct: ah.cfg('afk.msg_pct'), msg_pct_na: ah.cfg('afk.msg_pct_na'), msg_no_sessions: ah.cfg('afk.msg_no_sessions'),
    marker_prefix: ah.cfg('afk.marker_prefix'), bullet_re: ah.cfg('afk.bullet_re'), done_re: ah.cfg('afk.done_re'), open_re: ah.cfg('afk.open_re'),
    digest_max_entries: ah.cfgNum('afk.digest_max_entries'), needs_owner_re: ah.cfg('afk.needs_owner_re'), msg_needs_owner_head: ah.cfg('afk.msg_needs_owner_head'),
  };
}
function afkR(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; }); }

// The digest of one progress file's text: { lines: [...], entries: n }. `C` is the afk.* table without the prefix.
function afkDigestOne(C, path, txt) {
  var head = afkR(afkC(C, 'msg_digest_head'), { path: path });
  if (typeof txt !== 'string') return { lines: [afkR(afkC(C, 'msg_digest_none'), { path: path })], entries: 0, parked: [] };
  var at = txt.lastIndexOf(afkC(C, 'marker_prefix'));
  if (at < 0) return { lines: [afkR(afkC(C, 'msg_digest_none'), { path: path })], entries: 0, parked: [] };
  var rest = txt.slice(at).split('\n').slice(1);
  var bullet = new RegExp(afkC(C, 'bullet_re')), done = new RegExp(afkC(C, 'done_re')), open = new RegExp(afkC(C, 'open_re'));
  var needs = new RegExp(afkC(C, 'needs_owner_re'));
  var bullets = [], parked = [], nDone = 0, nOpen = 0;
  for (var i = 0; i < rest.length; i++) {
    var l = rest[i];
    if (!bullet.test(l)) continue;
    if (needs.test(l)) parked.push(l.replace(/^\s+/, '')); // listed first by afkDigest, never cut
    else bullets.push(l.replace(/^\s+/, ''));
    if (done.test(l)) nDone++;
    else if (open.test(l)) nOpen++;
  }
  if (bullets.length === 0 && parked.length === 0) return { lines: [afkR(afkC(C, 'msg_digest_none'), { path: path })], entries: 0, parked: [] };
  var max = Number(afkC(C, 'digest_max_entries')), out = [head], cut = Math.max(0, bullets.length - max);
  if (cut > 0) out.push(afkR(afkC(C, 'msg_digest_more'), { n: cut }));
  for (var j = cut; j < bullets.length; j++) out.push('  ' + bullets[j]);
  var total = nDone + nOpen;
  out.push(total > 0 ? afkR(afkC(C, 'msg_pct'), { pct: Math.round((nDone * 100) / total), done: nDone, total: total }) : afkC(C, 'msg_pct_na'));
  return { lines: out, entries: bullets.length - cut + parked.length, parked: parked };
}

// `afkDigest({cfg, files: [{path, text}]})` -> {text, entries, parked}: called by the engine's `back` command (cfg = the afk.*
// table). The NEEDS OWNER bullets of every file come first (parked = their count).
function afkDigest(input) {
  var C = input && input.cfg ? input.cfg : afkDigestCfg(), files = input && Array.isArray(input.files) ? input.files : [];
  if (files.length === 0) return { text: afkC(C, 'msg_no_sessions'), entries: 0, parked: 0 };
  var lines = [], n = 0, parked = [];
  for (var i = 0; i < files.length; i++) {
    var d = afkDigestOne(C, String(files[i].path), files[i].text);
    lines = lines.concat(d.lines);
    n += d.entries;
    parked = parked.concat(d.parked);
  }
  if (parked.length > 0) lines = [afkR(afkC(C, 'msg_needs_owner_head'), { n: parked.length })].concat(parked.map(function (b) { return '  ' + b; }), lines);
  return { text: lines.join('\n'), entries: n, parked: parked.length };
}

// ---- state ----------------------------------------------------------------------------------------------------------------

function afkRel(name) { return ah.cfg('replykit.state_dir') + '/' + name; }
function afkReadJson(rel) {
  var t = ah.state.readText(rel);
  if (t === null) return null;
  try { var v = JSON.parse(t); return v !== null && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
function afkWrite(rel, obj) { try { return ah.state.writeAtomic(rel, JSON.stringify(obj)); } catch (e) { return false; } }
function afkMetric(name, labels, by) { try { ah.metric(name, labels || {}, by === undefined ? 1 : by); } catch (e) { /* counting never fails a hook */ } }

function afkFlag() { return afkReadJson(afkRel(ah.cfg('afk.flag_file'))); }
function afkSetFlag(f) { return afkWrite(afkRel(ah.cfg('afk.flag_file')), f); }
function afkOn(f) { return f !== null && f.on === true; }
function afkIsAgent(p) { return coordinator.subagentByPayload(p); }

// Every read-modify-write of the flag: under its cross-process lock (afk.lock_file, the same lock `ah-engine afk` / `back` take),
// `fn(cur)` gets the flag as it is NOW and returns the object to write, or null to leave it. Without the lock nothing is written
// and null is returned, so a copy read before another writer's OFF can never overwrite it.
function afkUpdate(fn) {
  var h = null;
  try { h = ah.state.lock(afkRel(ah.cfg('afk.lock_file')), 'afk'); } catch (e) { h = null; }
  if (h === null) return null;
  try {
    var cur = afkFlag(), next = fn(cur);
    if (next === null) return { flag: cur };
    return afkSetFlag(next) ? { flag: next } : null;
  } finally {
    try { ah.state.unlock(h); } catch (e) { /* the host releases a lock still held when the call ends */ }
  }
}

function afkStart(how, now) {
  var r = afkUpdate(function (cur) { return afkOn(cur) ? null : { on: true, how: how, since: now, epoch: String(now), counted: false }; });
  return r !== null && afkOn(r.flag) ? r.flag : null;
}

function afkEnd(f, now, idleOnly) {
  return afkUpdate(function (cur) {
    if (!afkOn(cur) || (idleOnly && cur.how !== ah.cfg('afk.how_idle'))) return null;
    cur.on = false; cur.ended = now;
    return cur;
  });
}

// Counts the CLI could not add (it runs outside the daemon) are added by the first hook that sees them, from the flag as it is under
// the lock (a stale ON copy is never written back); without the lock the counts wait for the next hook.
function afkFlush(f) {
  if (f === null) return f;
  var due = (f.on === true && f.counted !== true) || f.pending_digest > 0 || f.pending_parked > 0;
  if (!due) return f;
  var counts = [];
  var r = afkUpdate(function (cur) {
    if (cur === null) return null;
    var changed = false;
    counts = [];
    if (cur.on === true && cur.counted !== true) {
      counts.push(['afk_entered', { how: String(cur.how) }, 1]);
      if (cur.how === ah.cfg('afk.how_idle')) counts.push(['idle_trips', {}, 1]);
      cur.counted = true; changed = true;
    }
    if (typeof cur.pending_digest === 'number' && cur.pending_digest > 0) {
      counts.push(['digest_entries', {}, cur.pending_digest]);
      cur.pending_digest = 0; changed = true;
    }
    if (typeof cur.pending_parked === 'number' && cur.pending_parked > 0) {
      counts.push(['afk_question_parked', { action: ah.cfg('afk.action_listed') }, cur.pending_parked]);
      cur.pending_parked = 0; changed = true;
    }
    return changed ? cur : null;
  });
  if (r === null) return f;
  for (var i = 0; i < counts.length; i++) afkMetric(counts[i][0], counts[i][1], counts[i][2]);
  return r.flag;
}

// The session's watermarks (afk.mark_prefix): the hook clock's time of its last real owner prompt and of its own last advisor call.
function afkMarkRel(sid) { return afkRel(ah.cfg('afk.mark_prefix') + sid + ah.cfg('replykit.json_ext')); }
function afkMark(p, key, now) {
  var sid = afkSid(p);
  if (!sid) return;
  var rel = afkMarkRel(sid), m = afkReadJson(rel) || {};
  m[key] = now;
  afkWrite(rel, m);
  ah.state.prune(ah.cfg('afk.mark_prefix'), ah.cfg('afk.mark_prefix') + sid + ah.cfg('replykit.json_ext'));
}

function afkSid(p) {
  var raw = p && p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  return raw.replace(new RegExp(ah.cfg('afk.session_id_unsafe'), 'g'), '');
}
function afkSessRel(sid) { return afkRel(ah.cfg('afk.session_prefix') + sid + ah.cfg('replykit.json_ext')); }

// The session's progress file: <project root>/.anti-hall/progress/<UTC date>/<sid>.md (the task-list guard's layout).
function afkProgress(p, sid, now) {
  var cwd = p && typeof p.cwd === 'string' && p.cwd.charAt(0) === '/' ? p.cwd : null;
  if (cwd === null || !sid) return null;
  var root = ah.project.root(cwd);
  if (root === null) root = cwd;
  var segs = ah.cfg('tasklist_guard.progress_dir').concat([new Date(now).toISOString().slice(0, 10), sid + '.md']);
  return { root: root, rel: segs.join('/'), abs: root + '/' + segs.join('/') };
}

// The session's view of the current AFK period; a new period writes the marker and returns {fresh: true}.
function afkSession(p, f, now) {
  var sid = afkSid(p);
  if (!sid) return null;
  var rel = afkSessRel(sid), s = afkReadJson(rel);
  if (s !== null && s.epoch === f.epoch) return { sid: sid, rel: rel, s: s, fresh: false };
  var pr = afkProgress(p, sid, now), path = pr !== null ? pr.abs : '';
  if (pr !== null) {
    var mark = afkR(ah.cfg('afk.marker_text'), { epoch: f.epoch, iso: new Date(Number(f.since) || now).toISOString(), how: f.how });
    try { ah.state.op(pr.root, 'append', pr.rel, mark); } catch (e) { path = ''; }
  }
  s = { epoch: f.epoch, progress: path, reminded: now, reminders: 0, nudge: null, nudged: false, blocks: 0 };
  afkWrite(rel, s);
  ah.state.prune(ah.cfg('afk.session_prefix'), ah.cfg('afk.session_prefix') + sid + ah.cfg('replykit.json_ext'));
  return { sid: sid, rel: rel, s: s, fresh: true };
}

function afkCtx(event, t) { return { exact: { code: 0, out: afkR(ah.cfg('afk.ctx_line'), { event: event, text: JSON.stringify(t) }), err: '' } }; }

// Idle detection: no owner prompt on this machine for afk.idleMinutes. Never trips without a recorded prompt.
function afkIdleTrip(f, now) {
  if (afkOn(f) || !ah.settings.bool('afk.set_idle')) return f;
  var pr = afkReadJson(afkRel(ah.cfg('afk.presence_file')));
  if (pr === null || typeof pr.last !== 'number') return f;
  if (now - pr.last < ah.settings.num('afk.set_idle_minutes') * 60000) return f;
  return afkStart(ah.cfg('afk.how_idle'), now) || f;
}

function afkWordIn(list, t) {
  for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === t) return true;
  return false;
}

function afkDigestHere(f) {
  var files = [], seen = {};
  // the sessions that recorded a progress file for this period (their state files), newest first, bounded
  var dir = ah.home() + '/' + ah.cfg('replykit.state_dir'), names = ah.fs.readdir(dir) || [], pre = ah.cfg('afk.session_prefix');
  var max = ah.cfgNum('afk.digest_max_files');
  for (var i = 0; i < names.length && files.length < max; i++) {
    if (names[i].indexOf(pre) !== 0) continue;
    var s = afkReadJson(afkRel(names[i]));
    if (s === null || f === null || s.epoch !== f.epoch || typeof s.progress !== 'string' || s.progress === '' || seen[s.progress]) continue;
    seen[s.progress] = true;
    files.push({ path: s.progress, text: ah.fs.readText(s.progress, ah.cfgNum('afk.read_max_bytes')) });
  }
  return afkDigest({ cfg: null, files: files });
}

function afkFmt(ms) { return new Date(Number(ms) || 0).toISOString(); }

function afkPrompt(p, f, now) {
  var prompt = typeof p.prompt === 'string' ? p.prompt : '';
  var notOwner = ah.cfg('afk.non_owner_prompt_res').some(function (r) { return ah.re.test(r, 'i', prompt); });
  if (notOwner) return null;
  afkWrite(afkRel(ah.cfg('afk.presence_file')), { last: now });
  afkMark(p, 'owner', now);
  var word = prompt.trim().toLowerCase(), reply = null;
  if (ah.settings.bool('afk.set_prompt_commands')) {
    if (afkWordIn(ah.cfg('afk.words_on'), word)) {
      if (afkOn(f)) reply = afkR(ah.cfg('afk.msg_already'), { how: f.how, since: afkFmt(f.since) });
      else { var n = afkStart(ah.cfg('afk.how_prompt'), now); afkFlush(n); reply = afkR(ah.cfg('afk.msg_on'), { how: n !== null ? n.how : ah.cfg('afk.how_prompt') }); }
    } else if (afkWordIn(ah.cfg('afk.words_off'), word) || afkWordIn(ah.cfg('afk.words_progress'), word)) {
      var off = afkWordIn(ah.cfg('afk.words_off'), word), d = afkDigestHere(f), head = '';
      if (off) {
        head = afkOn(f) ? afkR(ah.cfg('afk.msg_off'), { how: f.how, since: afkFmt(f.since) }) : ah.cfg('afk.msg_not_on');
        if (afkOn(f)) afkEnd(f, now, false);
      }
      afkMetric('digest_entries', {}, d.entries);
      if (d.parked > 0) afkMetric('afk_question_parked', { action: ah.cfg('afk.action_listed') }, d.parked);
      reply = (head ? head + '\n' : '') + d.text;
    }
  }
  if (reply !== null) return { exact: { code: 0, out: afkR(ah.cfg('afk.ups_block'), { reason: JSON.stringify(reply) }), err: '' } };
  if (afkOn(f) && f.how === ah.cfg('afk.how_idle')) {
    var r = afkEnd(f, now, true);
    if (r !== null && !afkOn(r.flag)) return afkCtx('UserPromptSubmit', ah.cfg('afk.msg_idle_ended'));
  }
  return null;
}

// The output tokens of the turn that just ended (deduplicated by message id) and nothing else: {tokens} or null.
function afkTurnTokens(tp) {
  var keep = [['type'], ['message', 'id'], ['message', 'usage', 'output_tokens'], ['message', 'content'], ['message', 'content', '*', 'type']];
  var r = ah.transcript.tailEntries(tp, ah.cfgNum('afk.window_bytes'), ah.cfgNum('afk.line_max_bytes'), keep, ah.cfgNum('afk.max_lines'));
  if (r === null || !Array.isArray(r.lines)) return null;
  var byId = {}, anon = 0;
  for (var i = r.lines.length - 1; i >= 0; i--) {
    var e = r.lines[i][1];
    if (e === null || typeof e !== 'object') continue;
    var m = e.message;
    if (e.type === 'user' && m && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some(function (c) { return c && c.type === 'text'; })))) break;
    if (e.type !== 'assistant' || !m || !m.usage || typeof m.usage.output_tokens !== 'number') continue;
    if (typeof m.id === 'string' && m.id) byId[m.id] = Math.max(byId[m.id] || 0, m.usage.output_tokens);
    else anon += m.usage.output_tokens;
  }
  var t = anon;
  for (var k in byId) if (Object.prototype.hasOwnProperty.call(byId, k)) t += byId[k];
  return t;
}

// A turn that ends on a plain-text question while AFK: held with the ladder at most afk.question_max_holds times (null = not held).
function afkQuestionHold(p, f, now, reply) {
  if (!ah.settings.bool('afk.set_no_questions')) return null;
  var last = reply.split('\n').filter(function (l) { return l.trim() !== ''; }).pop();
  if (last === undefined || !new RegExp(ah.cfg('afk.question_re')).test(last)) return null;
  var se = afkSession(p, f, now);
  if (se === null) return null;
  var held = typeof se.s.qholds === 'number' ? se.s.qholds : 0;
  if (held >= ah.cfgNum('afk.question_max_holds')) { afkMetric('afk_question_parked', { action: ah.cfg('afk.action_capped') }); return null; }
  se.s.qholds = held + 1;
  if (!afkWrite(se.rel, se.s)) return null; // the cap cannot be recorded: never hold
  afkMetric('afk_question_parked', { action: ah.cfg('afk.action_nudged') });
  return { exact: { code: 0, out: afkR(ah.cfg('afk.stop_block'), { reason: JSON.stringify(ah.cfg('afk.msg_ladder_stop')) }), err: '' } };
}

function afkStop(p, f, now) {
  if (p.stop_hook_active === true) return 'allow';
  var codex = coordinator.isCodexPayload(p);
  if (ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
  var on = afkOn(f), tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (on && !codex) afkMetric('afk_turns', {});
  if (tp && !codex && ah.settings.bool('afk.set_measure')) {
    var tok = afkTurnTokens(hookProc.open(p, tp));
    if (tok !== null) {
      var mode = on ? ah.cfg('afk.mode_afk') : ah.cfg('afk.mode_present');
      afkMetric('afk_output_tokens', { mode: mode }, tok);
      afkMetric('afk_turns_measured', { mode: mode });
    }
  }
  if (!on || ah.settings.skipped(ah.cfg('afk.guard_name'))) return 'allow';
  var reply = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  var q = afkQuestionHold(p, f, now, reply);
  if (q !== null) return q;
  if (codex || !ah.settings.bool('afk.set_enforce')) return 'allow'; // Codex: Stop only holds a question
  var lines = reply.split('\n').filter(function (l) { return l.trim() !== ''; }).length;
  var maxC = ah.cfgNum('afk.max_reply_chars'), maxL = ah.cfgNum('afk.max_reply_lines');
  if (reply.length <= maxC && lines <= maxL) return 'allow';
  var se = afkSession(p, f, now);
  if (se === null) return 'allow';
  var vars = { chars: reply.length, lines: lines, max_chars: maxC, max_lines: maxL };
  if (!se.s.nudged) {
    se.s.nudged = true; se.s.nudge = afkR(ah.cfg('afk.msg_nudge'), vars);
    afkWrite(se.rel, se.s);
    afkMetric('afk_overlong_turns', { action: ah.cfg('afk.action_nudge') });
    return 'allow';
  }
  if (se.s.blocks >= ah.cfgNum('afk.max_blocks')) { afkMetric('afk_overlong_turns', { action: ah.cfg('afk.action_capped') }); return 'allow'; }
  se.s.blocks += 1;
  if (!afkWrite(se.rel, se.s)) return 'allow'; // the cap cannot be recorded: never hold
  afkMetric('afk_overlong_turns', { action: ah.cfg('afk.action_block') });
  return { exact: { code: 0, out: afkR(ah.cfg('afk.stop_block'), { reason: JSON.stringify(afkR(ah.cfg('afk.msg_block'), vars)) }), err: '' } };
}

// PreToolUse while AFK: the question tool is denied every time with the ladder; ExitPlanMode is approved (allow WITH updatedInput,
// the documented shape) when an advisor call follows the owner's last message, else left to the normal approval.
function afkPre(p, f) {
  if (!afkOn(f) || ah.settings.skipped(ah.cfg('afk.guard_name'))) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('afk.question_tools').indexOf(tool) >= 0) {
    if (!ah.settings.bool('afk.set_no_questions')) return 'allow';
    afkMetric('afk_question_denied', { tool: tool });
    return { exact: { code: 0, out: afkR(ah.cfg('afk.pre_deny'), { reason: JSON.stringify(ah.cfg('afk.msg_ladder_deny')) }), err: '' } };
  }
  if (ah.cfg('afk.plan_tools').indexOf(tool) < 0 || !ah.settings.bool('afk.set_plan_autoapprove') || !jx.isObj(p.tool_input) || afkIsAgent(p)) return 'allow';
  // the advisor call must be NEWER than the owner's last prompt, both by the hook's own clock (the transcript is written
  // asynchronously, so its order can lag a prompt the UserPromptSubmit hook already recorded); the transcript entry's own
  // timestamp counts as an advisor time too
  var sid = afkSid(p), m = sid ? afkReadJson(afkMarkRel(sid)) : null;
  var owner = m !== null && typeof m.owner === 'number' ? m.owner : null;
  var adv = m !== null && typeof m.advisor === 'number' ? m.advisor : -1;
  var scan = owner === null ? null : advisorKit.scan(p);
  if (scan !== null && scan.lastAdvisorTs > adv) adv = scan.lastAdvisorTs;
  if (owner === null || adv <= owner) {
    afkMetric('afk_plan_autoapproved', { result: ah.cfg('afk.result_no_advisor') });
    return 'allow';
  }
  afkMetric('afk_plan_autoapproved', { result: ah.cfg('afk.result_approved') });
  return { exact: { code: 0, out: afkR(ah.cfg('afk.pre_allow_input'), { reason: JSON.stringify(ah.cfg('afk.msg_plan_approved')), input: JSON.stringify(p.tool_input) }), err: '' } };
}

// The rule once per session per period, a pending nudge, else a reminder at the capped interval.
function afkInject(p, f, now, event) {
  var se = afkSession(p, f, now);
  if (se === null) return 'allow';
  var parts = [];
  if (se.fresh) parts.push(afkR(ah.cfg('afk.rule_text'), { progress: se.s.progress || ah.cfg('tasklist_guard.progress_dir').join('/') }));
  if (typeof se.s.nudge === 'string' && se.s.nudge) { parts.push(se.s.nudge); se.s.nudge = null; }
  if (!se.fresh && event === 'PostToolUse' && se.s.reminders < ah.cfgNum('afk.reminder_max') && now - (se.s.reminded || 0) >= ah.cfgNum('afk.reminder_interval_s') * 1000) {
    parts.push(ah.cfg('afk.reminder_text'));
    se.s.reminders += 1; se.s.reminded = now;
  }
  if (parts.length === 0) return 'allow';
  if (!se.fresh) afkWrite(se.rel, se.s);
  else if (parts.length > 1) afkWrite(se.rel, se.s);
  return afkCtx(event, parts.join('\n'));
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  if (ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on')) return 'allow';
  if (!ah.settings.bool('afk.set_enabled') || !ah.home()) return 'allow';
  var ev = typeof p.hook_event_name === 'string' ? p.hook_event_name : '', now = ah.clock.now();
  if (ev === 'SessionStart') {
    if (coordinator.isCodexPayload(p) && ah.settings.bool('afk.set_concise_codex')) return afkCtx(ev, ah.cfg('afk.concise_text'));
    return 'allow';
  }
  var f = afkFlush(afkFlag());
  if (ev === 'UserPromptSubmit') {
    var r = afkPrompt(p, f, now);
    if (r !== null) return r;
    f = afkFlag();
    return afkOn(f) ? afkInject(p, f, now, ev) : 'allow';
  }
  f = afkFlush(afkIdleTrip(f, now));
  if (ev === 'Stop') return afkStop(p, f, now);
  if (ev === 'PreToolUse') return afkPre(p, f);
  if (ev === 'PostToolUse' && !afkIsAgent(p)) {
    if (ah.cfg('advisor.tool_names').indexOf(p.tool_name) >= 0) afkMark(p, 'advisor', now);
    if (afkOn(f)) return afkInject(p, f, now, ev); // a subagent never gets the rule nor consumes the parent's once-per-session state
  }
  return 'allow';
}
