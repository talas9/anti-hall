// check = "devswarm-parent-reply-tracker" (PostToolUse on Bash): a Primary's reply tracker. It never prints; it records that the Primary
// answered a child. Answers what the Node hook answers: silent for every call it ignores (the switch is off, this is a child workspace,
// the payload is not an object, the tool is not Bash, the command does not hold both the `devswarm` and `send` words, no project key
// for the payload's working directory, DevSwarm inactive with no summary of the project); the send receipts of this turn's window
// credited as reply records (the project's `<key>-replies.json`, appended as Node appends); else the send's own JSON line: a direct,
// sent, non-question send (or one that answers) recorded as a reply, anything else silent. Where Node only logs to ~/.devswarm/parent-inbox.log (a response with
// no send line, a question send to a child with a pending question) nothing is recorded; a relative working directory resolves against the
// stand-in directory, a receipt without its own time takes the file's time, a file that is no regular file takes no append, and a
// project key the host cannot read exactly records nothing (all counted, native_unable). Mirrors hooks/devswarm-parent-reply-tracker.js `main` and
// companion/lib/devswarm-reply-state.js `recordReply`. This script builds on devswarm-child-gate.js and devswarm-child-role.js
// (script.includes). Keys: devswarm_gates.toml (devswarm_gates.*).
'use strict';

function rtLooksLikeSend(c) {
  return ah.cfg('devswarm_gates.send_words').every(function (w) { return new RegExp('\\b' + w + '\\b', 'i').test(c); });
}

// `parseSendResponse(text)`: the last line that parses to an object whose action is `send`, or null.
function rtParseSend(t) {
  var found = null;
  t.split(/\r\n|\r|\n/).forEach(function (line) {
    var s = line.trim();
    if (!s) return;
    var j = jx.parse(s);
    if (j.unsure) { ah.unable('devswarm-parent-reply-tracker:send_line_unsure'); return; }
    if (!j.invalid && jx.isObj(j.v) && j.v.action === ah.cfg('devswarm_gates.rt_send_action')) found = j.v;
  });
  return found;
}

// `receiptCreditsReply(r, repoKey)`.
function rtCredits(r, key) {
  if (!r || typeof r !== 'object') return false;
  if (r.ok !== true || r.type !== ah.cfg('devswarm_gates.rt_direct_type')) return false;
  if (typeof r.toId !== 'string' || !r.toId) return false;
  if (r.sent === false || r.needsReply === true) return false;
  if (r.repoKey !== null && r.repoKey !== undefined && String(r.repoKey) !== String(key)) return false;
  return true;
}

// The receipts of this turn's window that credit a reply: [{toId, ts}] in the order Node reads them.
function rtReceipts(home, key, now) {
  var days;
  try {
    var day = ah.cfgNum('devswarm_gates.rt_day_ms');
    days = [new Date(now).toISOString().slice(0, 10), new Date(now - day).toISOString().slice(0, 10)];
  } catch (e) { return []; } // a time out of the Date range: Node's sweep throws and credits nothing
  var windowMs = cgSetDefault('devswarm_gates.rt_window_setting'), skew = ah.cfgNum('devswarm_gates.rt_clock_skew_ms'), out = [];
  days.forEach(function (d) {
    var dir = home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_gates.rt_receipts_dir') + '/' + d;
    var names = ah.fs.readdir(dir);
    if (names === null && ah.fs.isDir(dir)) ah.unable('devswarm-parent-reply-tracker:receipts_listing_big'); // the entries listed are the ones read
    (names || []).forEach(function (n) {
      if (!/\.json$/.test(n)) return;
      var full = dir + '/' + n, mt = ah.fs.mtimeMs(full);
      if (mt === null) return;
      var age = now - mt;
      if (age > windowMs || age < -skew) return;
      var r = cgJson(full);
      if (r === undefined || !rtCredits(r, key)) return;
      if (!cgFinite(r.ts)) ah.unable('devswarm-parent-reply-tracker:receipt_time'); // Node records the file's own fractional modification time: its time here
      out.push({ toId: r.toId, ts: cgFinite(r.ts) ? r.ts : mt });
    });
  });
  return out;
}

// `recordReply` for each reply, in order: the appends Node makes ({m, t} lines, a separating newline first when the file does not end
// with one, a record over the byte cap skipped). A file that is no regular file takes no append (counted).
function rtAppends(home, key, replies) {
  var rel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_gates.rt_state_dir') + '/' + String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('devswarm_gates.rt_replies_suffix');
  var st = ah.fs.lstat(home + '/' + rel), needSep;
  if (st === null) needSep = false;
  else if (st.kind !== 'file') { ah.unable('devswarm-parent-reply-tracker:replies_not_file'); return { home: home, dir: rel.slice(0, rel.lastIndexOf('/')), rel: rel, texts: [], any: false }; }
  else if (st.size === 0) needSep = false;
  else {
    var tail = ah.fs.readEnd(home + '/' + rel, 1);
    if (tail === null) { ah.unable('devswarm-parent-reply-tracker:replies_tail'); return { home: home, dir: rel.slice(0, rel.lastIndexOf('/')), rel: rel, texts: [], any: false }; }
    needSep = tail !== '\n';
  }
  var out = [];
  replies.forEach(function (x) {
    var rec = JSON.stringify({ m: x.toId, t: x.ts }) + '\n';
    var payload = needSep ? '\n' + rec : rec;
    if (jx.utf8Len(payload) > ah.cfgNum('devswarm_gates.rt_record_cap')) return;
    out.push(payload);
    needSep = false;
  });
  return { home: home, dir: rel.slice(0, rel.lastIndexOf('/')), rel: rel, texts: out, any: replies.length > 0 };
}

// recordReply makes the directory before it checks the byte cap, so a skipped record still leaves it.
function rtApply(w) {
  if (w.any) {
    ah.commit();
    ah.state.op(w.home, 'mkdir', w.dir);
    w.texts.forEach(function (t) { ah.state.appendFile(w.rel, t); });
  }
  return 'allow';
}

function rtDecide(p) {
  var home = hookProc.home(p);
  if (home === null) { ah.unable('devswarm-parent-reply-tracker:no_home', 'abandoned'); return 'allow'; } // no home at all: no receipts or replies file
  if (posix.normalize(home) !== home) { ah.unable('devswarm-parent-reply-tracker:home_form'); home = posix.normalize(home); }
  var tr = p.tool_response;
  var textOut = typeof tr === 'string' ? tr : (tr && typeof tr === 'object' && typeof tr.stdout === 'string' ? tr.stdout : null);
  var cwd = typeof p.cwd === 'string' ? p.cwd : null;
  if (!cwd) return 'allow';
  if (cwd.charAt(0) !== '/') { ah.unable('devswarm-parent-reply-tracker:relative_cwd'); cwd = hookProc.cwd(p); } // resolved against the stand-in directory
  var key = ah.mesh.contextKey(cwd); // a project the host cannot resolve is counted (mesh:context_key) and records nothing: the tracker never prints
  if (!key) return 'allow';
  if (!dgActive() && ah.fs.realpath(home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + key + '.json') === null) return 'allow';
  var now = cgFinite(p.timestamp) ? p.timestamp : ah.clock.now();
  var credited = rtReceipts(home, key, now);
  if (credited.length > 0) return rtApply(rtAppends(home, key, credited));
  if (typeof textOut !== 'string' || !textOut.trim()) return 'allow';
  var resp = rtParseSend(textOut);
  if (!resp) { ah.unable('devswarm-parent-reply-tracker:no_send_line', 'abandoned'); return 'allow'; } // Node only logs the parse drop to ~/.devswarm/parent-inbox.log
  if (resp.ok !== true || resp.type !== ah.cfg('devswarm_gates.rt_direct_type')) return 'allow';
  if (typeof resp.toId !== 'string' || !resp.toId || resp.sent === false) return 'allow';
  if (resp.needsReply === true && resp.answers !== true) {
    // a question send to a child with a pending question: Node logs the --answers hint to ~/.devswarm/parent-inbox.log
    var r = jx.read(home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + key + '.json');
    if (r.big) { ah.unable('devswarm-parent-reply-tracker:summary_big', 'abandoned'); return 'allow'; }
    if (r.text !== undefined && r.text.trim() !== '') {
      var j = jx.parse(r.text);
      if (j.unsure) { ah.unable('devswarm-parent-reply-tracker:summary_unsure', 'abandoned'); return 'allow'; }
      var s = j.invalid ? null : j.v, ws = s && typeof s === 'object' ? s.workspaces : null;
      if (ws && typeof ws === 'object' && Object.keys(ws).some(function (k) {
        var pq = ws[k] && Array.isArray(ws[k].pendingQuestions) ? ws[k].pendingQuestions : null;
        return pq !== null && pq.some(function (q) { return q && String(q.from) === resp.toId; });
      })) { ah.unable('devswarm-parent-reply-tracker:question_hint', 'abandoned'); return 'allow'; } // Node only logs the --answers hint
    }
    return 'allow';
  }
  var ts = cgFinite(p.timestamp) ? p.timestamp : ah.clock.now();
  return rtApply(rtAppends(home, key, [{ toId: resp.toId, ts: ts }]));
}

function decide(p) {
  if (!ah.settings.bool('devswarm_gates.reply_tracker_setting') || dgChild() || !jx.isObj(p)) return 'allow';
  if (p.tool_name !== ah.cfg('devswarm_gates.bash_tool')) return 'allow';
  var c = jx.isObj(p.tool_input) ? p.tool_input.command : undefined;
  if (typeof c !== 'string' || !rtLooksLikeSend(c)) return 'allow';
  return rtDecide(p);
}
