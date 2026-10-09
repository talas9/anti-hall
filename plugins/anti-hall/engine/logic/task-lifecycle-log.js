// check = "task-lifecycle-log" (TaskCreated and TaskCompleted). The hook is log-only: it appends one line per task event to the per-session
// history ledger `<root>/.anti-hall/history/<UTC date>/<session>.md` and registers that file once in `<root>/.anti-hall/history/INDEX.md`.
// It never prints and never blocks, so the answer is always an allow; the work is the file effects, which this script performs itself (the
// Node hook is then not run). A payload the Node hook would write for but this script cannot reproduce byte for byte (a relative `cwd`, a
// field cut through a surrogate pair) defers to Node. Mirrors hooks/task-lifecycle-log.js and hooks/session-history-index.js.
// Keys: task_guards.toml (task_lifecycle_log.*, taskkit.*).
'use strict';

function lcT(k) { return ah.cfg('task_lifecycle_log.' + k); }

// `sanitizeText(s, max)`: a non-string is empty; null when the cut would split a surrogate pair.
function lcSan(v, max) { return typeof v === 'string' ? tk.oneLine(v, max) : ''; }

function decide(p) {
  if (!ah.settings.bool('task_lifecycle_log.setting')) return 'allow';
  if (!jx.isObj(p)) return 'allow';
  var event = typeof p.hook_event_name === 'string' ? p.hook_event_name : '';
  if (lcT('events').indexOf(event) < 0) return 'allow';
  if (typeof p.cwd !== 'string' || p.cwd === '') return 'allow';
  var taskId = lcSan(p.task_id !== undefined && p.task_id !== null ? String(p.task_id) : '', ah.cfgNum('task_lifecycle_log.task_id_max'));
  if (taskId === null) return 'defer';
  if (taskId === '') return 'allow';
  var sidRaw = p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  var sid = jx.replaceAll(ah.cfg('taskkit.session_id_unsafe'), '', sidRaw, '');
  if (sid === '') sid = ah.cfg('taskkit.unknown_session');
  var subject = lcSan(p.task_subject, ah.cfgNum('task_lifecycle_log.subject_max')), teammate = lcSan(p.teammate_name, ah.cfgNum('task_lifecycle_log.teammate_max'));
  if (subject === null || teammate === null) return 'defer';
  var iso = new Date(ah.clock.now()).toISOString(), date = iso.slice(0, 10), sep = lcT('separator');
  var line = '- ' + iso + sep + event + sep + 'task_id=' + taskId;
  if (teammate !== '') line += sep + 'teammate=' + teammate;
  if (subject !== '') line += sep + subject;
  var root = ah.project.repoRoot(p.cwd);
  if (root === null) return 'defer';
  // the ledger append and the index registration; every failure stops quietly, as the Node `try` does
  var dir = lcT('history_dir').join('/'), ext = lcT('ledger_ext');
  var historyRel = dir + '/' + date;
  if (!ah.state.op(root, 'mkdir', historyRel)) return 'allow';
  if (!ah.state.op(root, 'append', historyRel + '/' + sid + ext, line + '\n')) return 'allow';
  var indexRel = dir + '/' + lcT('index_name'), existing = ah.fs.readText(root + '/' + indexRel);
  if (existing !== null && existing.indexOf(sid) >= 0) return 'allow';
  ah.state.op(root, 'append', indexRel, '- ' + date + sep + sid + sep + '[history](../' + date + '/' + sid + ext + ')\n');
  return 'allow';
}
