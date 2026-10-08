// check = "handover-resume" (SessionStart). Points a fresh or compacted session at the newest handover of the project with git facts
// measured now, a note when the session that wrote it kept running, and the PreCompact snapshot when one exists; reports the lack of a
// handover on a clear or a compaction. A request without an absolute HOME, a relative working directory, a time zone of the request's
// own or a repository root the host cannot settle defers to Node. Mirrors hooks/handover-resume.js and lib/handover-find.js
// (lib/73-handover.js). Keys and texts: codex_handover.toml (codex_handover.*).
'use strict';

function hrR(k, a) { return text.render(ah.cfg(k), a || {}); }
function hrC(k) { return ah.cfg(k); }

function hrIndexOutcome(root, date, sid, seq) {
  var raw = ah.fs.readText(root + '/' + hrC('codex_handover.index_file'));
  if (raw === null) return '';
  var want = hrC('codex_handover.index_seq_prefix') + seq, fallback = '', lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(date) === -1 || lines[i].indexOf(sid) === -1) continue;
    var parts = lines[i].split(hrC('codex_handover.index_sep')).map(function (s) { return s.trim(); });
    if (parts.length >= 4 && parts[3]) {
      if (parts[2] === want) return parts[3];
      fallback = parts[3];
    }
  }
  return fallback;
}

function hrGit(cwd, args) {
  var r = ah.exec(hrC('codex_handover.git_binary'), args, { cwd: cwd, timeoutMs: ah.cfgNum('codex_handover.resume_git_timeout_ms') });
  return r === null || r.status !== 0 || r.truncated ? null : r.stdout;
}

function hrFreshness(cwd, sinceMs) {
  var head = hrGit(cwd, hrC('codex_handover.argv_head'));
  if (head === null) return '';
  var at = String(Math.floor(sinceMs / 1000));
  var since = hrGit(cwd, hrC('codex_handover.argv_count').map(function (a) { return a.split('{since}').join(at); }));
  var status = hrGit(cwd, hrC('codex_handover.argv_porcelain'));
  return hrR('codex_handover.resume_freshness', {
    head: head.trim(), commits: since === null ? '?' : String(parseInt(since, 10) || 0),
    dirty: status === null ? '?' : String(status.split('\n').filter(Boolean).length),
  });
}

function hrWriterLine(cwd, root, cand, home) {
  var sid = String(cand.sessionId || '');
  if (!/^[A-Za-z0-9._-]+$/.test(sid)) return '';
  var repo = ah.path.join(root, '../..'), roots = [repo];
  if (cwd && roots.indexOf(cwd) === -1) roots.push(cwd);
  for (var i = 0; i < roots.length; i++) {
    var file = ah.path.join(ah.path.join(home, hrC('codex_handover.projects_dir')), String(roots[i]).replace(/[/\\:.]/g, '-')) + '/' + sid + '.jsonl';
    var m = ah.fs.mtimeMs(file);
    if (m === null) continue;
    var gap = m - cand.mtimeMs;
    if (!(gap > ah.cfgNum('codex_handover.writer_grace_ms'))) return '';
    return hrR('codex_handover.resume_writer', { sid: sid, min: Math.round(gap / 60000), iso: new Date(m).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  return '';
}

function hrBuild(cand, outcome, prefix, freshness, codex, writer) {
  var md = hrC('codex_handover.md_suffix'), seqLabel = cand.seq > 1 ? hrC('codex_handover.handover_prefix') + '-' + cand.seq + md : hrC('codex_handover.handover_plain');
  var pred = cand.seq > 1 ? (cand.seq === 2 ? hrC('codex_handover.handover_plain') : hrC('codex_handover.handover_prefix') + '-' + (cand.seq - 1) + md) : null;
  var rule = codex ? hrC('codex_handover.rule_file_codex') : hrC('codex_handover.rule_file_claude');
  var hasChecklist = false, existing = [];
  var content = ah.fs.readText(cand.filePath);
  if (content !== null) hasChecklist = new RegExp('^##\\s*' + hrC('codex_handover.checklist_title') + '\\b', 'im').test(content);
  var dir = cand.filePath.slice(0, cand.filePath.lastIndexOf('/'));
  existing = hrC('codex_handover.detail_files').filter(function (f) { return ah.fs.isFile(dir + '/' + f); });
  var L = [];
  L.push(hrR('codex_handover.resume_head', { prefix: prefix, path: cand.filePath, seq_label: seqLabel, pred: pred ? hrR('codex_handover.resume_pred', { pred: pred }) : '', date: cand.date, sid: cand.sessionId, outcome: outcome ? hrR('codex_handover.resume_outcome', { outcome: outcome }) : '' }));
  if (freshness) L.push(freshness);
  if (writer) L.push(writer);
  L.push('', hrC('codex_handover.resume_do_instead'));
  var steps = [hrR('codex_handover.step_read', { path: cand.filePath })];
  steps.push(hasChecklist ? hrR('codex_handover.step_checklist', { rule: rule, path: cand.filePath }) : hrR('codex_handover.step_generic', { rule: rule, path: cand.filePath }));
  if (existing.length) steps.push(hrR('codex_handover.step_details', { files: existing.join(hrC('codex_handover.details_sep')) }));
  if (existing.indexOf(hrC('codex_handover.detail_trials')) >= 0) steps.push(hrC('codex_handover.step_trials'));
  steps.push(hrC('codex_handover.step_readback'), hrC('codex_handover.step_continue'));
  if (existing.indexOf(hrC('codex_handover.detail_state')) >= 0) steps.push(hrC('codex_handover.step_tasks'));
  steps.forEach(function (s, i) { L.push((i + 1) + '. ' + s); });
  L.push('', hrC('codex_handover.resume_note'));
  return L.join('\n');
}

function hrNegative(event) {
  return { advisory: text.advisoryJson(event, text.message('tip', hrC('codex_handover.resume_guard'), { what: hrC('codex_handover.neg_what'), why: hrC('codex_handover.neg_why'), instead: hrC('codex_handover.neg_instead') })) };
}

function decide(p) {
  if (ah.env.get(hrC('codex_handover.judge_child_env')) === hrC('codex_handover.judge_child_on')) return 'allow';
  if (!ah.settings.bool('codex_handover.setting_resume') || !p || typeof p !== 'object' || Array.isArray(p)) return 'allow';
  var cwd = p.cwd;
  if (!cwd || typeof cwd !== 'string') return 'allow';
  var home = spawn.osHome();
  if (home === null || !ah.path.isAbsolute(cwd)) return 'defer';
  var source = typeof p.source === 'string' ? p.source : '', compactOrClear = hrC('codex_handover.resume_sources').indexOf(source) >= 0;
  var event = typeof p.hook_event_name === 'string' && p.hook_event_name ? p.hook_event_name : hrC('codex_handover.resume_event');
  var rr = ho.repoRoot(cwd);
  if (rr === null) return 'defer';
  var root = ah.path.join(rr, hrC('codex_handover.handovers_dir'));
  if (!ah.fs.isDir(root)) return compactOrClear ? hrNegative(event) : 'allow';
  var rawSid = p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  var want = rawSid ? ho.sanitize(rawSid) : '';
  var now = ah.clock.now(), maxAge = ah.cfgNum('codex_handover.resume_max_age_ms');
  var snap = want ? (function () {
    var c = ho.collect(root, ho.precompactRe, want);
    if (c.length === 0) return null;
    c.sort(function (a, b) { return (b.mtimeMs - a.mtimeMs) || (b.seq - a.seq); });
    return c[0];
  })() : null;
  if (snap && (now - snap.mtimeMs) > maxAge) snap = null;
  var found = ho.newestHandover(root, want);
  if (!found || (now - found.mtimeMs) > maxAge) {
    if (snap) {
      return { advisory: text.advisoryJson(event, text.message('tip', hrC('codex_handover.resume_guard'), {
        what: hrR('codex_handover.snaponly_what', { path: snap.filePath, written: new Date(snap.mtimeMs).toISOString() }), why: hrC('codex_handover.snaponly_why'), instead: hrC('codex_handover.snaponly_instead'),
      })) };
    }
    return !found && compactOrClear ? hrNegative(event) : 'allow';
  }
  var prefix = compactOrClear ? hrC('codex_handover.prefix_continuation') : hrC('codex_handover.prefix_previous');
  var ctx = hrBuild(found, hrIndexOutcome(root, found.date, found.sessionId, found.seq), prefix, hrFreshness(cwd, found.mtimeMs), cb.codexPayload(p), hrWriterLine(cwd, root, found, home));
  if (snap) ctx += '\n\n' + hrR(snap.mtimeMs > found.mtimeMs ? 'codex_handover.snap_newer' : 'codex_handover.snap_older', { path: snap.filePath });
  if (rawSid) {
    try { ah.state.writeAtomic(hrC('codex_handover.state_dir') + '/' + hrC('codex_handover.resume_state_prefix') + ho.sanitize(rawSid) + '.json', JSON.stringify({ handoverFile: found.filePath, ts: now })); } catch (e) { /* the verification rail just stays inactive */ }
  }
  return { advisory: text.advisoryJson(event, ctx) };
}
