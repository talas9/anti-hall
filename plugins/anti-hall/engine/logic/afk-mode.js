// check = "afk-mode" (UserPromptSubmit, PreToolUse, PostToolUse, Stop on Claude; SessionStart, UserPromptSubmit, PostToolUse, Stop on Codex; engine-only,
// no Node twin; GH #425). AFK mode: a machine-wide flag (afk.flag_file) set by `ah-engine afk on`, by the owner typing `afk`, or by
// idle detection; the rule injected once per session per AFK period plus capped reminders; an AFK marker in the session progress
// file, whose checklist bullets are the digest `back` / `progress` print; a capped Stop hold of overlong AFK replies; output tokens
// per turn split AFK vs present; no blocking questions (the question tool denied with the ladder every time, a capped Stop hold of
// a turn ending on a plain-text question, NEEDS OWNER bullets listed first). Subagents never get the rule nor touch the parent's
// once-per-session state; their question-tool calls are denied too. The flag is only rewritten under its lock, re-read inside it
// (OFF wins), with one lock budget per hook call (afk.lock_wait_ms); owner presence never goes backwards and idle detection never
// re-enters AFK before the last `back` plus the idle time. While AFK the plan-approval tool is approved (allow + updatedInput) only
// after a hook-recorded advisor consult that is sequence-newer than the last plan write, attempt and owner prompt, bound to the plan
// file's hash and the AFK period, with no clock rollback; anything uncertain fails closed (afk.planAutoApprove). Every pattern, list, number and text: afk.toml. `afkDigest` is pure (cfg and files in, text out) so
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
function afkOn(f) { return f !== null && f.on === true; }
function afkIsAgent(p) { return coordinator.subagentByPayload(p); }

// Every read-modify-write of the flag: under its cross-process lock (afk.lock_file, the same lock `ah-engine afk` / `back` take),
// `fn(cur)` gets the flag as it is NOW and returns the object to write, or null to leave it. Without the lock nothing is written
// and null is returned, so a copy read before another writer's OFF can never overwrite it.
// One lock budget per hook call (afk.lock_wait_ms), reset by decide(): every try waits only what is left of it, and once a try
// fails the call takes no other (a contended hook returns within the budget, writing nothing). Date.now() is the real clock (the
// hook clock ah.clock.now() can be pinned).
var afkLockBudget = { until: 0, failed: false };
function afkLockReset() { afkLockBudget = { until: Date.now() + ah.cfgNum('afk.lock_wait_ms'), failed: false }; }
// `fn` may return {flag, guard}: `guard` ([[rel, key, max], ...]) is re-checked by the host after the ownership check,
// immediately before the rename; a watched number above its bound discards the commit (counted afk_idle_revoked, GH #426).
function afkUpdate(fn) {
  if (afkLockBudget.failed) return null;
  var h = null;
  try { h = ah.state.lock(afkRel(ah.cfg('afk.lock_file')), 'afk', Math.max(0, afkLockBudget.until - Date.now())); } catch (e) { h = null; }
  if (h === null) { afkLockBudget.failed = true; return null; }
  try {
    // fenced commit (GH #426): sweep earlier holders' staged copies BEFORE reading, then publish only while the lock is still
    // ours, so a holder whose expired lock was taken over can never land a stale ON over the new holder's OFF
    var rel = afkRel(ah.cfg('afk.flag_file')), infix = ah.cfg('afk.fence_infix');
    try { ah.state.fenceSweep(rel, infix); } catch (e) { /* nothing to sweep */ }
    // `prev`: a copy of the flag as read under the lock, before `fn` may change `cur` in place
    var cur = afkFlag(), prev = cur === null ? null : JSON.parse(JSON.stringify(cur)), next = fn(cur), guard;
    if (next === null) return { flag: cur, prev: prev };
    if (next.guard !== undefined) { guard = next.guard; next = next.flag; }
    var ok = false;
    try { ok = ah.state.writeFenced(rel, JSON.stringify(next), h, infix, guard); } catch (e) { ok = false; }
    if (!ok) afkMetric(guard !== undefined && afkGuardMoved(guard) ? 'afk_idle_revoked' : 'afk_lock_lost', {});
    return ok ? { flag: next, prev: prev } : null;
  } finally {
    try { ah.state.unlock(h); } catch (e) { /* the host releases a lock still held when the call ends */ }
  }
}

// Whether a watched value of a discarded guarded commit moved past its bound (a newer owner presence or `back`).
function afkGuardMoved(guard) {
  return guard.some(function (g) { var v = afkReadJson(g[0]); return v !== null && typeof v[g[1]] === 'number' && v[g[1]] > g[2]; });
}

function afkStart(how, now) {
  var r = afkUpdate(function (cur) {
    if (afkOn(cur)) return null;
    var on = { on: true, how: how, since: now, epoch: String(now), counted: false };
    if (how !== ah.cfg('afk.how_idle')) return on;
    // idle: re-checked against the flag as it is NOW, so a `back` written after this hook read the flag wins; and again by the
    // host right before the rename, so an owner presence or `back` that lands while this commit is pending wins too (GH #426)
    var base = afkIdleBase(cur);
    if (base === null || now - base < ah.settings.num('afk.set_idle_minutes') * 60000) return null;
    return { flag: on, guard: [[afkRel(ah.cfg('afk.presence_file')), 'last', base], [afkRel(ah.cfg('afk.flag_file')), 'ended', base]] };
  });
  return r !== null && afkOn(r.flag) ? r.flag : null;
}

// idleOnly: end an idle period only. Otherwise (the owner's `back` / `afk off`): ALWAYS bump the `ended` watermark under the lock,
// even when the published flag is OFF (and with no flag yet), so an idle entry pending in another hook loses (GH #426).
function afkEnd(f, now, idleOnly) {
  return afkUpdate(function (cur) {
    if (idleOnly && (!afkOn(cur) || cur.how !== ah.cfg('afk.how_idle'))) return null;
    var next = cur !== null ? cur : { on: false };
    next.on = false;
    next.ended = typeof next.ended === 'number' && next.ended > now ? next.ended : now;
    return next;
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

// Owner presence (afk.presence_file) only moves forward: a write older than the recorded time (a hook that read its clock before
// a `back`) never moves it back.
function afkPresent(now) {
  var rel = afkRel(ah.cfg('afk.presence_file')), pr = afkReadJson(rel);
  if (pr !== null && typeof pr.last === 'number' && pr.last >= now) return;
  afkWrite(rel, { last: now });
}

// Idle due: no owner prompt on this machine for afk.idleMinutes, counted from the later of the last prompt and the last end of AFK
// (`ended`, the back watermark). Never due without a recorded prompt.
// The idle base: the later of the last owner prompt and the flag's `ended`; null without a recorded prompt.
function afkIdleBase(f) {
  var pr = afkReadJson(afkRel(ah.cfg('afk.presence_file')));
  if (pr === null || typeof pr.last !== 'number') return null;
  return f !== null && typeof f.ended === 'number' && f.ended > pr.last ? f.ended : pr.last;
}
function afkIdleDue(f, now) {
  var base = afkIdleBase(f);
  return base !== null && now - base >= ah.settings.num('afk.set_idle_minutes') * 60000;
}

function afkIdleTrip(f, now) {
  if (afkOn(f) || !ah.settings.bool('afk.set_idle') || !afkIdleDue(f, now)) return f;
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

// An owner prompt: not matched by afk.non_owner_prompt_res (task notifications and the like).
function afkOwnerPrompt(p) {
  var prompt = typeof p.prompt === 'string' ? p.prompt : '';
  return !ah.cfg('afk.non_owner_prompt_res').some(function (r) { return ah.re.test(r, 'i', prompt); });
}
function afkPrompt(p, f, now) {
  var prompt = typeof p.prompt === 'string' ? p.prompt : '';
  if (!afkOwnerPrompt(p)) return null;
  afkPresent(now);
  var word = prompt.trim().toLowerCase(), reply = null;
  if (ah.settings.bool('afk.set_prompt_commands')) {
    if (afkWordIn(ah.cfg('afk.words_on'), word)) {
      if (afkOn(f)) reply = afkR(ah.cfg('afk.msg_already'), { how: f.how, since: afkFmt(f.since) });
      else {
        var n = afkStart(ah.cfg('afk.how_prompt'), now);
        afkFlush(n);
        reply = n !== null ? afkR(ah.cfg('afk.msg_on'), { how: n.how }) : ah.cfg('afk.msg_lock_busy');
      }
    } else if (afkWordIn(ah.cfg('afk.words_off'), word) || afkWordIn(ah.cfg('afk.words_progress'), word)) {
      var off = afkWordIn(ah.cfg('afk.words_off'), word), d = afkDigestHere(f), head = '';
      if (off) {
        // under the lock, whatever the published flag says (an idle ON may be pending); the head reflects the flag as it was then
        var e = afkEnd(f, now, false), was = e !== null ? e.prev : null;
        if (e === null) head = ah.cfg('afk.msg_lock_busy'); // the watermark was not written: say so
        else head = afkOn(was) ? afkR(ah.cfg('afk.msg_off'), { how: was.how, since: afkFmt(was.since) }) : ah.cfg('afk.msg_not_on');
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

// ---- plan auto-approve (afk.planAutoApprove) ---------------------------------------------------------------------------------
// FAIL CLOSED: anything uncertain leaves the normal approval prompt. One per-session record (afk.plan_state_ns) orders events by a
// sequence number, never by wall-clock time: every stamp (plan-file write, owner prompt, advisor consult, plan-approval attempt)
// takes seq+1 inside one atomic update and is verified by reading it back. The record also keeps the newest wall-clock time it saw
// (wall); a clock earlier than that is a rollback and nothing is approved. A consult binds the plan file's path and SHA-256, the AFK
// period (flag epoch) and the owner-prompt witness (afk.plan_prompt_ns, a separate per-session counter file, so a failed record write
// on an owner prompt still changes what the consult saw). Subagents never stamp a consult.
function afkPlanKey(p) { var sid = afkSid(p); return sid ? ah.sessionState.key(sid) : ''; }
function afkPlanParse(t) { if (t === null) return {}; try { var v = JSON.parse(t); return v !== null && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function afkPlanNum(s, k) { return typeof s[k] === 'number' ? s[k] : 0; }
// Atomic read-modify-write of ns/key; `fn(s)` mutates the parsed record and returns the seq it assigned (or 0 to write nothing).
// true only when the read-back shows that seq (the host does not report a failed write).
// Under the per-session cross-process lock (afk.plan_lock_prefix): the host's state mutex is per process only, and a one-shot hook
// process next to the daemon could otherwise lose an update. No lock = a failed write. A seq that does not grow is a failed write too.
function afkPlanLock(key) {
  try { return ah.state.lock(afkRel(ah.cfg('afk.plan_lock_prefix') + key), 'afk', ah.cfgNum('afk.lock_wait_ms')); } catch (e) { return null; }
}
function afkPlanUnlock(h) { try { ah.state.unlock(h); } catch (e) { /* the host releases a lock still held when the call ends */ } }
// The read-modify-write itself (the caller holds the lock); true only when the read-back shows the seq `fn` assigned.
function afkPlanWrite(ns, key, fn) {
  var want = 0, before = 0;
  try {
    ah.sessionState.update(ns, key, function (cur) { var s = afkPlanParse(cur); before = afkPlanNum(s, 'seq'); want = fn(s); return want > before ? JSON.stringify(s) : null; });
    return want > before && afkPlanNum(afkPlanParse(ah.sessionState.get(ns, key)), 'seq') === want;
  } catch (e) { return false; }
}
function afkPlanUpdate(ns, key, fn) {
  var h = afkPlanLock(key);
  if (h === null) return false;
  try { return afkPlanWrite(ns, key, fn); } finally { afkPlanUnlock(h); }
}
// The poison marker (afk.plan_poison_ns, pruned like the other namespaces): clean only when it is a regular file that a recorded
// consult wrote, under the lock and after its own record was read back, naming that consult's seq ({clear: consultSeq}). Absent,
// not a regular file, unreadable, set ({poisoned}) or naming another consult: poisoned. A stamp that could not be recorded also sets
// an in-process mark (ah.mem), so even when every disk write fails the daemon that saw it approves nothing until a new consult.
function afkPlanMemName(key) { return ah.cfg('afk.plan_state_ns') + ':' + ah.home() + ':' + key; }
function afkPlanPoison(key) {
  try { ah.mem.set(afkPlanMemName(key)); } catch (e) { /* the disk marker below still applies */ }
  // no cross-process lock: the poison must land even while the lock is contended (a later consult then re-clears it legitimately)
  var ok = false;
  try {
    ah.sessionState.update(ah.cfg('afk.plan_poison_ns'), key, function () { return JSON.stringify({ poisoned: true }); });
    ok = afkPlanParse(ah.sessionState.get(ah.cfg('afk.plan_poison_ns'), key)).poisoned === true;
  } catch (e) { ok = false; }
  if (!ok) afkPlanFailed('poison');
}
function afkPlanPoisonPath(key) { return ah.home() + '/' + afkRel(ah.cfg('afk.plan_poison_ns') + '-' + key + ah.cfg('guardkit.state_ext')); }
function afkPlanPoisonClean(key, consultSeq) {
  try {
    if (ah.mem.has(afkPlanMemName(key))) return false;
    var st = ah.fs.lstat(afkPlanPoisonPath(key));
    if (st === null || st.kind !== 'file') return false;
    var t = ah.sessionState.get(ah.cfg('afk.plan_poison_ns'), key);
    if (t === null) return false;
    var v = afkPlanParse(t);
    return v.poisoned !== true && typeof v.clear === 'number' && v.clear > 0 && v.clear === consultSeq;
  } catch (e) { return false; }
}
// A live consult record for this session: absent = none (owner prompts then skip the lock entirely); present but unreadable = live.
function afkPlanLive(key) {
  var path = ah.home() + '/' + afkRel(ah.cfg('afk.plan_state_ns') + '-' + key + ah.cfg('guardkit.state_ext'));
  try {
    if (ah.fs.lstat(path) === null) return false;
    var t = ah.sessionState.get(ah.cfg('afk.plan_state_ns'), key);
    return t === null || afkPlanNum(afkPlanParse(t), 'consultSeq') > 0 || afkPlanParse(t).consultSeq !== undefined;
  } catch (e) { return true; }
}
function afkPlanBump(s, field, now) {
  s.seq = afkPlanNum(s, 'seq') + 1;
  s[field] = s.seq;
  if (now < afkPlanNum(s, 'wall')) s.backSeq = s.seq; // the clock went backwards: no consult up to here is trusted
  s.wall = Math.max(now, afkPlanNum(s, 'wall'));
  return s.seq;
}
function afkPlanPromptWitness(key) {
  try { var t = ah.sessionState.get(ah.cfg('afk.plan_prompt_ns'), key); return t === null ? 0 : afkPlanNum(afkPlanParse(t), 'seq'); } catch (e) { return -1; }
}
function afkPlanFailed(field) { afkMetric('afk_plan_stamp_failed', { field: field }); }
// Owner prompt (always, any setting): the separate witness counter first, then the record. Either failing is counted.
function afkPlanPrompt(p, now) {
  if (coordinator.isCodexPayload(p)) return;
  var key = afkPlanKey(p);
  if (!key || !afkPlanLive(key)) return; // no consult to void: no stamp, no lock wait
  var w = afkPlanUpdate(ah.cfg('afk.plan_prompt_ns'), key, function (s) { s.seq = afkPlanNum(s, 'seq') + 1; return s.seq; });
  if (!w) afkPlanFailed('witness');
  var r = afkPlanUpdate(ah.cfg('afk.plan_state_ns'), key, function (s) { return afkPlanBump(s, 'promptSeq', now); });
  if (!r) afkPlanFailed('promptSeq');
  if (!w || !r) afkPlanPoison(key); // either failing: the consult is poisoned (a third, separate file)
}
// PostToolUse: the advisor tool (advisor.tool_names) or an edit of a plan file (advisor.edit_tools + advisor.plan_file_re). Plan writes
// are stamped for every thread (a subagent rewriting the plan makes the consult stale); a consult only for the main thread.
function afkPlanRecord(p, f, now) {
  if (coordinator.isCodexPayload(p)) return;
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '', key = afkPlanKey(p);
  if (!key) return;
  if (ah.cfg('advisor.tool_names').indexOf(tool) >= 0) {
    if (!ah.settings.bool('afk.set_plan_autoapprove') || afkIsAgent(p)) return;
    var witness = afkPlanPromptWitness(key), h = afkPlanLock(key), seq = 0;
    if (h === null) { afkPlanFailed('consultSeq'); return; }
    try {
      // record first (read back), then clear the poison for exactly this consult, both under the lock; a consult that cannot do
      // both leaves the poison as it was (an earlier consult can never be revived by a later, unrecorded one)
      var recorded = afkPlanWrite(ah.cfg('afk.plan_state_ns'), key, function (s) {
        var path = typeof s.planPath === 'string' ? s.planPath : '', hash = null;
        try { hash = path !== '' ? ah.fs.sha256File(path) : null; } catch (e) { hash = null; }
        s.consultHash = hash; s.consultPath = path; s.consultWitness = witness;
        s.consultEpoch = afkOn(f) && typeof f.epoch === 'string' ? f.epoch : '';
        seq = afkPlanBump(s, 'consultSeq', now);
        return seq;
      });
      if (!recorded) { afkPlanFailed('consultSeq'); return; }
      var cleared = false;
      try {
        ah.sessionState.update(ah.cfg('afk.plan_poison_ns'), key, function () { return JSON.stringify({ clear: seq }); });
        cleared = afkPlanParse(ah.sessionState.get(ah.cfg('afk.plan_poison_ns'), key)).clear === seq;
      } catch (e) { cleared = false; }
      if (!cleared) { afkPlanFailed('poison'); return; }
      try { ah.mem.clear(afkPlanMemName(key)); } catch (e) { /* a mark that stays only denies */ }
    } finally { afkPlanUnlock(h); }
    return;
  }
  if (ah.cfg('advisor.edit_tools').indexOf(tool) < 0) return;
  var i = jx.isObj(p.tool_input) ? p.tool_input : {}, file = typeof i.file_path === 'string' ? i.file_path : '';
  if (file === '' || !ah.re.test(ah.cfg('advisor.plan_file_re'), 'r', file)) return;
  if (!afkPlanUpdate(ah.cfg('afk.plan_state_ns'), key, function (s) { s.planPath = file; return afkPlanBump(s, 'planSeq', now); })) { afkPlanFailed('planSeq'); afkPlanPoison(key); }
}
function afkPlanDeny(reasonKey) { afkMetric('afk_plan_autoapprove_denied', { reason: ah.cfg(reasonKey) }); return 'allow'; }
// PreToolUse of the plan-approval tool: allow + updatedInput only when every check passes; every other path says nothing. The
// attempt is stamped (and read back) in the same update that judges the consult, so one consult approves at most one attempt.
function afkPlanPre(p, f, now) {
  if (!ah.settings.bool('afk.set_plan_autoapprove') || ah.settings.skipped(ah.cfg('afk.guard_name'))) return afkPlanDeny('afk.plan_reason_off');
  if (!afkOn(f)) return afkPlanDeny('afk.plan_reason_afk_off');
  if (afkIsAgent(p)) return afkPlanDeny('afk.plan_reason_subagent');
  var key = afkPlanKey(p);
  if (!key || !jx.isObj(p.tool_input)) return afkPlanDeny('afk.plan_reason_no_input');
  var input = p.tool_input, pf = typeof input.planFilePath === 'string' ? input.planFilePath : '';
  var witness = afkPlanPromptWitness(key), seen = null;
  var wrote = afkPlanUpdate(ah.cfg('afk.plan_state_ns'), key, function (s) {
    seen = JSON.parse(JSON.stringify(s));
    return afkPlanBump(s, 'attemptSeq', now);
  });
  if (!wrote || seen === null) return afkPlanDeny('afk.plan_reason_state_error');
  var c = afkPlanNum(seen, 'consultSeq');
  if (c <= 0) return afkPlanDeny('afk.plan_reason_no_marker');
  if (now < afkPlanNum(seen, 'wall') || afkPlanNum(seen, 'backSeq') >= c) return afkPlanDeny('afk.plan_reason_clock_backwards');
  if (!afkPlanPoisonClean(key, c)) return afkPlanDeny('afk.plan_reason_stamp_poisoned');
  if (witness < 0 || witness !== afkPlanNum(seen, 'consultWitness')) return afkPlanDeny('afk.plan_reason_owner_prompt');
  if (c <= Math.max(afkPlanNum(seen, 'planSeq'), afkPlanNum(seen, 'attemptSeq'), afkPlanNum(seen, 'promptSeq'))) return afkPlanDeny('afk.plan_reason_stale');
  var cp = typeof seen.consultPath === 'string' ? seen.consultPath : '', ch = typeof seen.consultHash === 'string' ? seen.consultHash : '';
  if (cp === '' || ch === '' || pf === '' || !ah.path.isAbsolute(pf) || pf !== cp) return afkPlanDeny('afk.plan_reason_plan_unbound');
  // one read: the hash is of the very text compared below (no window between hashing the file and reading it)
  var hash = null, text = null;
  try { text = ah.fs.readText(pf, ah.cfgNum('afk.read_max_bytes')); hash = text === null ? null : ah.fs.sha256Text(text); } catch (e) { hash = null; }
  if (hash === null || hash !== ch) return afkPlanDeny('afk.plan_reason_plan_changed');
  // what is approved is the echoed input: its plan text (when given) must be the consulted file's text (surrounding whitespace aside)
  if (input.plan !== undefined && (typeof input.plan !== 'string' || text === null || input.plan.trim() !== text.trim())) return afkPlanDeny('afk.plan_reason_plan_mismatch');
  // last step: re-read the flag now (it may have been switched off since this hook started) and bind the consult's AFK period
  var f2 = afkFlag();
  if (!afkOn(f2)) return afkPlanDeny('afk.plan_reason_afk_off');
  if (typeof f2.epoch !== 'string' || f2.epoch === '' || f2.epoch !== seen.consultEpoch || f2.epoch !== f.epoch) return afkPlanDeny('afk.plan_reason_afk_changed');
  afkMetric('afk_plan_autoapproved', {});
  return { exact: { code: 0, out: afkR(ah.cfg('afk.plan_allow'), { reason: JSON.stringify(ah.cfg('afk.msg_plan_approved')), input: JSON.stringify(input) }), err: '' } };
}

// PreToolUse while AFK: the question tool is denied every time with the ladder; the plan-approval tool goes to afkPlanPre.
function afkPre(p, f, now) {
  var ptool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('afk.plan_tools').indexOf(ptool) >= 0 && !coordinator.isCodexPayload(p)) return afkPlanPre(p, f, now);
  if (!afkOn(f) || ah.settings.skipped(ah.cfg('afk.guard_name'))) return 'allow';
  var tool = ptool;
  if (ah.cfg('afk.question_tools').indexOf(tool) >= 0) {
    if (!ah.settings.bool('afk.set_no_questions')) return 'allow';
    afkMetric('afk_question_denied', { tool: tool });
    return { exact: { code: 0, out: afkR(ah.cfg('afk.pre_deny'), { reason: JSON.stringify(ah.cfg('afk.msg_ladder_deny')) }), err: '' } };
  }
  return 'allow';
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
  if (!ah.home()) return 'allow';
  var ev = typeof p.hook_event_name === 'string' ? p.hook_event_name : '', now = ah.clock.now();
  // owner prompts are stamped for plan auto-approve whatever afk.enabled says (the dispatch row runs without the setting gate), so a
  // prompt while AFK mode was disabled still voids an earlier consult when it is re-enabled
  if (ev === 'UserPromptSubmit' && afkOwnerPrompt(p)) afkPlanPrompt(p, now);
  if (!ah.settings.bool('afk.set_enabled')) return 'allow';
  afkLockReset();
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
  if (ev === 'PreToolUse') return afkPre(p, f, now);
  if (ev === 'PostToolUse') afkPlanRecord(p, f, now);
  if (ev === 'PostToolUse' && !afkIsAgent(p) && afkOn(f)) return afkInject(p, f, now, ev); // a subagent never gets the rule nor consumes the parent's once-per-session state
  return 'allow';
}
