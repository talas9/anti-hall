// check = "task-lifecycle-log" (TaskCreated, TaskCompleted): append one line per task event to the per-session history ledger
// `<root>/.anti-hall/history/<UTC date>/<session>.md` and register that file once in `<root>/.anti-hall/history/INDEX.md`.
// Log-only: it never blocks, so the answer is always allow (after doing what Node does) (a cut through a surrogate pair drops the half pair, an unresolved checkout skips the write, an index too big to search is not re-registered; each counted). Mirrors hooks/task-lifecycle-log.js and hooks/session-history-index.js.
// Keys and limits: engine/defaults/task_guards.toml (task_lifecycle_log.*).
'use strict';

function present(o, k) { return o[k] === undefined || o[k] === null ? undefined : o[k]; }

// A field cut through a surrogate pair drops the half pair (counted) instead of handing the event back.
function tllSan(s, max) {
  var t = task.sanitizeText(s, max);
  if (t !== null) return t;
  ah.unable('task-lifecycle-log:surrogate_cut');
  return task.sanitizeText(s, max - 1);
}

function decide(p) {
  if (!ah.settings.bool('task_lifecycle_log.setting')) return 'allow';
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return 'allow';
  var event = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
  if (ah.cfg('task_lifecycle_log.events').indexOf(event) < 0) return 'allow';
  if (typeof p.cwd !== 'string' || p.cwd === '') return 'allow';
  var rawId = present(p, 'task_id');
  var taskId = tllSan(rawId === undefined ? '' : String(rawId), ah.cfgNum('task_lifecycle_log.task_id_max'));
  if (taskId === '') return 'allow';
  var rawSid = present(p, 'session_id');
  var sid = task.sessionPathId(rawSid === undefined ? '' : String(rawSid));
  var subject = tllSan(p.task_subject, ah.cfgNum('task_lifecycle_log.subject_max'));
  var teammate = tllSan(p.teammate_name, ah.cfgNum('task_lifecycle_log.teammate_max'));
  var iso = new Date(Date.now()).toISOString(), date = iso.slice(0, 10), sep = ah.cfg('task_lifecycle_log.separator');
  var line = '- ' + iso + sep + event + sep + 'task_id=' + taskId;
  if (teammate !== '') line += sep + 'teammate=' + teammate;
  if (subject !== '') line += sep + subject;
  if (ah.home() === '') { ah.unable('task-lifecycle-log:no_home', 'abandoned'); return 'allow'; } // no home: nowhere to keep the ledger
  var cwd = p.cwd;
  if (!ah.path.isAbsolute(cwd)) { ah.unable('task-lifecycle-log:relative_cwd'); cwd = hookProc.cwd(p); } // resolved against the stand-in directory
  // The session's project: the outermost superproject's work tree. Where the cheap file-level answer cannot classify the checkout (a
  // submodule or nested repository), ask the host's git-aware resolver; a cwd inside a submodule keys on its superproject.
  var root = task.sessionProjectRoot(cwd, ah.home());
  if (root === null) root = ho.sessionProjectRoot(cwd);
  if (root === null) { ah.unable('task-lifecycle-log:root_unsure', 'abandoned'); return 'allow'; } // never create state at an unconfirmed project root
  var dir = ah.cfg('task_lifecycle_log.history_dir').join('/'), ext = ah.cfg('task_lifecycle_log.ledger_ext');
  var index = dir + '/' + ah.cfg('task_lifecycle_log.index_name');
  // The index is read whole in Node; one larger than a script may read cannot be searched here: the ledger line is written and the index left as it is (counted).
  var abs = root + '/' + index, size = ah.fs.size(abs), indexBig = size !== null && size > ah.cfgNum('script.read_max_bytes');
  if (indexBig) ah.unable('task-lifecycle-log:index_big');
  if (!ah.state.op(root, 'mkdir', dir + '/' + date)) return 'allow';
  // A name the file system cannot hold: Node's append fails and the hook stops quietly, after the directory was made.
  if ((sid + ext).length > ah.cfgNum('task_lifecycle_log.name_max')) return 'allow';
  if (!ah.state.op(root, 'append', dir + '/' + date + '/' + sid + ext, line + '\n')) return 'allow';
  if (indexBig) return 'allow';
  var existing = ah.fs.readText(abs);
  if (existing !== null && existing.indexOf(sid) >= 0) return 'allow';
  ah.state.op(root, 'append', index, '- ' + date + sep + sid + sep + '[history](../' + date + '/' + sid + ext + ')\n');
  return 'allow';
}
