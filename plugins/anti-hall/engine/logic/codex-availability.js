// check = "codex-availability" (SessionStart; codex-quota-detect.js and codex-nudge.js build on this script). The Codex availability and
// quota hooks, which share the quota record in `~/.anti-hall/codex-availability.json`. This one probes PATH for a real codex executable,
// records it (merging into the file, never clobbering the quota half), folds a usage-limit error found in a background Codex job log into
// the quota record, and tells the session: the Codex text when the session is a Codex one, or a Claude tip while Codex is on PATH, plus a
// warning line while a recorded outage is live. A state file or date the script cannot read the way Node reads it defers. Mirrors
// hooks/codex-availability.js and hooks/lib/codex-quota.js. Keys and texts: codex_handover.toml (codex_handover.*).
'use strict';

function cxT(k) { return ah.cfg('codex_handover.' + k); }
function cxN(k) { return ah.cfgNum('codex_handover.' + k); }

// `ANTIHALL_JUDGE_CHILD=1`: the judge child's hooks are no-ops.
function cxJudgeChild() { return ah.env.get(cxT('judge_child_env')) === cxT('judge_child_on'); }

// The home directory state files live under, or null (no usable HOME, or a test run on the real home).
function cxHome() {
  var h = spawn.stateHome();
  return h.ok === undefined || h.ok === '' ? null : h.ok;
}

// `detectPlatform(payload) === 'codex'`: a turn id, or a Codex rollout transcript.
function cxIsCodex(p) {
  if (!jx.isObj(p)) return false;
  if (typeof p.turn_id === 'string' && p.turn_id !== '') return true;
  var tp = p.transcript_path;
  if (typeof tp !== 'string') return false;
  var last = tp.split(/[\/\\]/).pop(), head = cxT('rollout_prefix'), tail = cxT('rollout_suffix');
  if (last.indexOf(head) === 0 && last.slice(-tail.length) === tail && last.length >= head.length + tail.length) return true;
  var dir = cxT('codex_dir_name'), at = tp.indexOf(dir);
  while (at >= 0) {
    if (at > 0 && /[\/\\]/.test(tp.charAt(at - 1)) && /[\/\\]/.test(tp.charAt(at + dir.length))) return true;
    at = tp.indexOf(dir, at + 1);
  }
  return false;
}

var CX_STATE = ah.cfg('codex_handover.availability_file');

// `readRaw`: the file as an object, {} when missing, unreadable, not JSON or not an object; null when it cannot be read the way Node reads it.
function cxReadRaw(home) {
  var f = jx.read(home + '/' + CX_STATE);
  if (f.big) return null;
  if (f.text === undefined) return {};
  var r = jx.parse(f.text);
  if (r.unsure) return null;
  return !r.invalid && jx.isObj(r.v) ? r.v : {};
}

// `readQuota`: the live outage record {until, reason}, `false` for none, null when unsure.
function cxReadQuota(home, now) {
  var raw = cxReadRaw(home);
  if (raw === null) return null;
  var q = raw.quota;
  if (!q || typeof q.until !== 'number' || !isFinite(q.until) || q.until <= now) return false;
  return { until: q.until, reason: typeof q.reason === 'string' ? q.reason : cxT('quota_default_reason') };
}

// The existing file for a merge: `Object.assign` would invoke the `__proto__` setter for such a key.
function cxReadForWrite(home) {
  var raw = cxReadRaw(home);
  return raw === null || Object.prototype.hasOwnProperty.call(raw, cxT('proto_key')) ? null : raw;
}

// The UTF-8 size of a text, in bytes.
function cxBytes(t) {
  var n = 0;
  for (var i = 0; i < t.length; i++) {
    var c = t.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// One atomic write of the record: true / false when the disk refused, null when the text is larger than one script write may carry (Node writes it).
function cxWriteRecord(obj) {
  var t = JSON.stringify(obj), cap = ah.cfgNum('script.write_max_bytes');
  if (t.length > cap || (t.length * 3 > cap && cxBytes(t) > cap)) return null;
  try { return ah.state.writeAtomic(CX_STATE, t); } catch (e) { return false; }
}

// `writeMerged`: merge `patch` into the file and write it atomically; true / false when the disk refused, null when unsure.
function cxWriteMerged(home, patch) {
  var merged = cxReadForWrite(home);
  if (merged === null) return null;
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  return cxWriteRecord(merged);
}

// `recordQuota`: record an outage lasting until `until` (epoch ms, or none/unparseable for the default cooldown).
function cxRecordQuota(home, until, reason, now) {
  var u = typeof until === 'number' && isFinite(until) && until > now ? until : now + cxN('default_cooldown_ms');
  var r = (reason || '').trim();
  r = r === '' ? cxT('quota_default_reason') : jx.sliceUnits(r, cxN('quota_reason_max'));
  return cxWriteMerged(home, { quota: { available: false, until: u, reason: r, recordedAt: now } });
}

// True when `text` mentions none of the words a quota message needs.
function cxCannotMatch(t) { var l = t.toLowerCase(); return !cxT('quota_target_words').some(function (w) { return l.indexOf(w) >= 0; }); }

// `parseWhen`: strip ordinals and trailing punctuation, then parse the longest word prefix that is a date: ms, null (none), or 'unsure'.
function cxParseWhen(s) {
  var trimmed = s.replace(new RegExp(cxT('ordinal_re'), 'gi'), '$1').replace(/[.,;\s]+$/, '');
  var words = trimmed.split(/\s+/);
  while (words.length > 0) {
    var d = ah.date.parse(words.join(' '));
    if (d.unsure) return 'unsure';
    if (d.ms !== undefined) return d.ms;
    words.pop();
  }
  return null;
}

// `detectQuotaMessage(text)`: {reason, until} or null; 'unsure' when a date only V8 reads exactly is in it.
function cxDetect(t) {
  if (t === '' || cxCannotMatch(t)) return null;
  var m = new RegExp(cxT('quota_re'), 'i').exec(t);
  if (!m) return null;
  var from = t.slice(m.index), head = from.slice(0, Math.min(from.length, cxN('quota_reason_chars')));
  // a cut through a surrogate pair cannot cross into the engine's string handling: the Node hook decides
  var last = head.charCodeAt(head.length - 1);
  if (head.length === cxN('quota_reason_chars') && last >= 0xd800 && last <= 0xdbff) return 'unsure';
  var reason = head.replace(/\s+/g, ' ').trim(), until = null;
  var tm = new RegExp(cxT('try_again_re'), 'i').exec(from);
  if (tm) { until = cxParseWhen(tm[1]); if (until === 'unsure') return 'unsure'; }
  if (until === null) {
    var um = new RegExp(cxT('until_re'), 'i').exec(from);
    if (um) {
      var d = ah.date.parse(um[1].trim());
      if (d.unsure) return 'unsure';
      if (d.ms !== undefined) until = d.ms;
    }
  }
  return { reason: reason, until: until };
}

// The newest entries of a directory (by modification time) at least `minMtime` new, at most `limit`.
function cxNewest(dir, filter, limit, minMtime) {
  var names = ah.fs.readdir(dir);
  if (names === null) return null;
  var out = [];
  names.forEach(function (n) {
    if (!filter(n)) return;
    var full = dir + '/' + n, m = ah.fs.mtimeMs(full);
    if (m !== null && m >= minMtime) out.push({ full: full, mtime: m });
  });
  out.sort(function (a, b) { return b.mtime - a.mtime; });
  return out.slice(0, limit);
}

// `scanJobLogs`: fold a usage-limit error found in a background Codex job log into the quota record; false when unsure.
function cxScanJobLogs(home, now) {
  var root = home + '/' + cxT('job_state_dir'), maxFiles = cxN('job_max_files'), minMtime = now - cxN('job_max_age_ms');
  var repos = cxNewest(root, function () { return true; }, cxN('job_max_dirs'), minMtime);
  if (repos === null) return true;
  var suffix = cxT('job_log_suffix'), logs = [];
  repos.forEach(function (r) {
    var l = cxNewest(r.full + '/' + cxT('job_logs_dir'), function (n) { return n.slice(-suffix.length) === suffix; }, maxFiles, minMtime);
    if (l !== null) logs = logs.concat(l);
  });
  logs.sort(function (a, b) { return b.mtime - a.mtime; });
  logs = logs.slice(0, maxFiles);
  for (var i = 0; i < logs.length; i++) {
    var tailText = ah.fs.readEnd(logs[i].full, cxN('job_tail_bytes'));
    if (tailText === null) continue;
    var hit = cxDetect(tailText);
    if (hit === 'unsure') return false;
    if (hit === null) continue;
    var until = hit.until !== null ? hit.until : logs[i].mtime + cxN('default_cooldown_ms');
    if (until <= now) continue;
    var cur = cxReadQuota(home, now);
    if (cur === null) return false;
    if (!(cur && cur.until >= until)) { if (cxRecordQuota(home, until, hit.reason, now) === null) return false; }
    return true;
  }
  return true;
}

function cxProbe(pathVar) {
  var name = cxT('codex_binary');
  return pathVar.split(cxT('path_separator')).some(function (d) { return d !== '' && ah.fs.isExecutable(posix.normalize(d + '/' + name)); });
}

function cxContext(codex) {
  if (codex) return cxT('avail_context_codex');
  return text.message('tip', cxT('avail_guard'), { what: cxT('avail_what'), why: cxT('avail_why'), instead: cxT('avail_instead') });
}

// `quotaNote`: a warning line while a recorded outage is live, else ''; null when unsure.
function cxQuotaNote(home, codex) {
  var q = cxReadQuota(home, ah.clock.now());
  if (q === null) return null;
  if (q === false) return '';
  var iso;
  try { iso = new Date(q.until).toISOString(); } catch (e) { return ''; }
  var what = text.render(cxT('avail_note_what'), { until: iso, reason: q.reason });
  var instead = text.render(cxT('avail_note_instead'), { tier: cxT(codex ? 'avail_tier_codex' : 'avail_tier_claude') });
  return text.message('warn', cxT('avail_guard'), { what: what, instead: instead }) + '\n';
}

function decide(p) {
  if (cxJudgeChild()) return 'allow';
  var home = cxHome();
  if (home === null) return 'defer';
  var codex = cxIsCodex(p), available = cxProbe(ah.env.get('PATH') || '');
  // writeState: merge, never clobber the quota half of the file.
  var merged = cxReadForWrite(home);
  if (merged === null) return 'defer';
  merged.available = available;
  merged.checkedAt = ah.clock.now();
  merged.source = cxT('avail_source');
  var ok = cxWriteRecord(merged);
  if (ok === null) return 'defer';
  if (!ok) return 'allow';
  if (ah.settings.bool('codex_handover.setting_quota_detect') && !cxScanJobLogs(home, ah.clock.now())) return 'defer';
  var prefix = cxQuotaNote(home, codex);
  if (prefix === null) return 'defer';
  if (!available && prefix === '') return 'allow';
  return { advisory: text.advisoryJson(cxT('avail_event'), prefix + cxContext(codex)) };
}
