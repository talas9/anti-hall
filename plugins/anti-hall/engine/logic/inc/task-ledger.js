// The session's task ledger, kept by the engine (GH #682): one Cause/Fix/Verified entry per finished task in the per-session history
// file `<root>/.anti-hall/history/<UTC date>/<session>.md` (the file task-lifecycle-log appends its event lines to, registered once in
// `.anti-hall/history/INDEX.md`). Not a check of its own: tasklist-hygiene (PostToolUse TaskUpdate status=completed) and task-pair-guard
// (Stop, rule `ledger`) list it in script.includes. An entry is found by its marker (pair_rule.strict_ledger_marker) in any of the
// session's history files of the last pair_rule.strict_ledger_scan_days dates, so a UTC date change never reads as a missing entry and
// an entry is never written twice. Every field is one line, cut to pair_rule.strict_ledger_field_max. Keys: pair_rule.toml
// (pair_rule.strict_ledger_*), task_guards.toml (task_lifecycle_log.*, taskstate.store_*).
'use strict';

// The project root the session's history lives under (task-lifecycle-log's resolution); null when it cannot be confirmed.
function tlgRoot(p, home) {
  var cwd = typeof p.cwd === 'string' ? p.cwd : '';
  if (cwd === '' || !ah.path.isAbsolute(cwd) || !home) return null;
  var root = task.sessionProjectRoot(cwd, home);
  if (root === null) root = ho.sessionProjectRoot(cwd);
  return root;
}

function tlgSid(p) { return task.sessionPathId(p.session_id === undefined || p.session_id === null ? '' : String(p.session_id)); }

// The history directory relative to the root, and the session's ledger file name.
function tlgDir() { return ah.cfg('task_lifecycle_log.history_dir').join('/'); }
function tlgName(sid) { return sid + ah.cfg('task_lifecycle_log.ledger_ext'); }

// The text of the session's ledger files of the newest scan_days date directories, joined; null when the history cannot be listed.
function tlgText(root, sid) {
  var base = root + '/' + tlgDir(), dates = ah.fs.readdir(base);
  if (dates === null) return '';
  var re = new RegExp(ah.cfg('pair_rule.strict_ledger_date_re'));
  dates = dates.filter(function (d) { return re.test(d); }).sort().reverse().slice(0, ah.cfgNum('pair_rule.strict_ledger_scan_days'));
  var out = [], max = ah.cfgNum('script.read_max_bytes');
  dates.forEach(function (d) {
    var t = ah.fs.readText(base + '/' + d + '/' + tlgName(sid), max);
    if (t !== null) out.push(t);
  });
  return out.join('\n');
}

function tlgMarker(id) { return text.render(ah.cfg('pair_rule.strict_ledger_marker'), { id: id }); }

// True when the ledger already holds the entry of task `id` (`all` is tlgText's answer).
function tlgHas(all, id) { return all.indexOf(tlgMarker(id)) >= 0; }

// The raw store record of task `id` (Claude Code's own `<home>/<store_base>/<list>/<id>.json`), or null: the store carries the metadata
// the transcript reconstruction drops (metadata.cause, metadata.fix, metadata.verified).
function tlgStoreRec(home, sid, id) {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(String(id))) return null;
  var base = home + '/' + ah.cfg('taskstate.store_base').join('/') + '/', dirs = [];
  var listId = ah.env.get(ah.cfg('taskstate.list_id_env'));
  if (typeof listId === 'string' && new RegExp(ah.cfg('taskstate.list_id_re')).test(listId)) dirs.push(base + listId);
  if (typeof sid === 'string' && sid !== '' && !/[^A-Za-z0-9_-]/.test(sid)) {
    ah.cfg('taskstate.store_dir_names').forEach(function (n) { dirs.push(base + text.render(n, { sid: sid, sid8: sid.slice(0, 8) })); });
  }
  for (var i = 0; i < dirs.length; i++) {
    var raw = ah.fs.readText(dirs[i] + '/' + id + ah.cfg('taskstate.store_file_suffix'), ah.cfgNum('taskstate.store_file_max_bytes'));
    if (raw === null) continue;
    try { var rec = JSON.parse(raw); if (rec !== null && typeof rec === 'object') return rec; } catch (e) { /* not JSON: the next directory */ }
  }
  return null;
}

// One metadata field as text ('' when absent): a string as it is, anything else as JSON.
function tlgMeta(meta, key) {
  if (meta === null || typeof meta !== 'object' || meta[key] === undefined || meta[key] === null) return '';
  return typeof meta[key] === 'string' ? meta[key] : JSON.stringify(meta[key]);
}

// The entry text of task `t` ({id, content, description}) with the metadata `meta` (the call's own metadata over the store's).
function tlgEntry(t, meta) {
  var keys = ah.cfg('pair_rule.strict_ledger_meta_keys'), max = ah.cfgNum('pair_rule.strict_ledger_field_max');
  function one(s) { return tk.oneLine(String(s), max); }
  var subject = one(t.content || t.id), desc = one(t.description || '');
  var cause = one(tlgMeta(meta, keys.cause)), fix = one(tlgMeta(meta, keys.fix)), verified = one(tlgMeta(meta, keys.verified));
  return text.render(ah.cfg('pair_rule.strict_ledger_entry'), {
    id: t.id, subject: subject,
    cause: cause !== '' ? cause : subject,
    fix: fix !== '' ? fix : (desc !== '' ? desc : subject),
    verified: verified !== '' ? verified : ah.cfg('pair_rule.strict_ledger_unverified'),
  });
}

// Write the entry of task `t` unless the ledger holds it. `meta` is the metadata the call carried (may be null). Returns 'present',
// 'written' or 'failed' (no confirmed root, a name the file system cannot hold, a write that did not happen). `rel` is the ledger path
// relative to the root, for the message.
function tlgEnsure(p, home, t, meta, now) {
  var root = tlgRoot(p, home), sid = tlgSid(p);
  if (root === null || sid === '') return { result: 'failed' };
  var date = new Date(now).toISOString().slice(0, 10), dir = tlgDir(), rel = dir + '/' + date + '/' + tlgName(sid);
  if (tlgHas(tlgText(root, sid), t.id)) return { result: 'present', rel: rel };
  if (tlgName(sid).length > ah.cfgNum('task_lifecycle_log.name_max')) return { result: 'failed', rel: rel };
  var rec = tlgStoreRec(home, sid, t.id), merged = {};
  var storeMeta = rec !== null && rec.metadata !== null && typeof rec.metadata === 'object' ? rec.metadata : {};
  Object.keys(storeMeta).forEach(function (k) { merged[k] = storeMeta[k]; });
  if (meta !== null && typeof meta === 'object') Object.keys(meta).forEach(function (k) { merged[k] = meta[k]; });
  var full = { id: t.id, content: t.content, description: t.description };
  if (rec !== null) {
    if (!full.content && typeof rec.subject === 'string') full.content = rec.subject;
    if (!full.description && typeof rec.description === 'string') full.description = rec.description;
  }
  if (!ah.state.op(root, 'mkdir', dir + '/' + date)) return { result: 'failed', rel: rel };
  if (!ah.state.op(root, 'append', rel, tlgEntry(full, merged))) return { result: 'failed', rel: rel };
  var index = dir + '/' + ah.cfg('task_lifecycle_log.index_name'), existing = ah.fs.readText(root + '/' + index, ah.cfgNum('script.read_max_bytes'));
  if (existing === null || existing.indexOf(sid) < 0) {
    var sep = ah.cfg('task_lifecycle_log.separator');
    ah.state.op(root, 'append', index, '- ' + date + sep + sid + sep + '[history](../' + date + '/' + tlgName(sid) + ')\n');
  }
  return { result: 'written', rel: rel };
}
