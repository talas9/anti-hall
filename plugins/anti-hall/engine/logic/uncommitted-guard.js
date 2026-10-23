// check = "uncommitted-guard" (PreToolUse on Edit, Write, MultiEdit, NotebookEdit and apply_patch; engine-only, no Node twin). GH #270:
// a SUBAGENT's worktree may hold only git.max_uncommitted_lines uncommitted lines (insertions plus deletions against HEAD, plus the lines
// of untracked files). Past git.soft_uncommitted_lines it is warned; past the hard line its edit is blocked with "commit first". The
// main session (no agent_id in the payload) is never judged. The count is cached per directory for uncommitted.cache_ttl_ms, but only
// while it is under the soft line: a count at or over a line is re-read before it blocks or warns, so a commit lifts the block at once.
// Every name, number, argument and text is in uncommitted_guard.toml. A failure of this script allows (script.failure_mode_by_check).
'use strict';

function ugGit(dir, argv) {
  var r = ah.exec(ah.cfg('git.git_binary'), argv.map(function (a) { return a.replace('{dir}', dir); }), { timeoutMs: ah.cfgNum('uncommitted.git_timeout_ms') });
  return r === null || r.status !== 0 || r.truncated ? null : r.stdout;
}

function ugNum(re, text) {
  var m = new RegExp(re).exec(text);
  return m === null ? 0 : parseInt(m[1], 10);
}

// The uncommitted lines of the checkout around `dir`, or null when git cannot say (not a repository, no commit yet).
function ugCount(dir) {
  var stat = ugGit(dir, ah.cfg('uncommitted.argv_diff'));
  if (stat === null) return null;
  var lines = ugNum(ah.cfg('uncommitted.insertions_re'), stat) + ugNum(ah.cfg('uncommitted.deletions_re'), stat);
  var list = ugGit(dir, ah.cfg('uncommitted.argv_untracked'));
  if (list === null) return lines;
  var files = list.split('\n').filter(function (f) { return f !== ''; }), maxFiles = ah.cfgNum('uncommitted.max_untracked_files');
  var maxRead = ah.cfgNum('uncommitted.untracked_read_max'), unread = ah.cfgNum('uncommitted.lines_per_unread_file');
  for (var i = 0; i < files.length; i++) {
    var abs = ah.path.join(dir, files[i]), size = i < maxFiles ? ah.fs.size(abs) : null, body = size !== null && size <= maxRead ? ah.fs.readText(abs) : null;
    lines += body === null ? unread : body.split('\n').length - (body.slice(-1) === '\n' ? 1 : 0);
  }
  return lines;
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var id = p[ah.cfg('uncommitted.agent_field')], dir = typeof p.cwd === 'string' ? p.cwd : '';
  if (typeof id !== 'string' || id === '' || dir === '' || !ah.path.isAbsolute(dir)) return 'allow';
  if (!ah.settings.bool('uncommitted.sw') || ah.settings.skipped(ah.cfg('uncommitted.guard_name'))) return 'allow';
  var hard = ah.cfgNum('git.max_uncommitted_lines'), soft = ah.cfgNum('git.soft_uncommitted_lines');
  if (hard === 0 && soft === 0) return 'allow';
  var rel = ah.cfg('uncommitted.state_dir') + '/' + ah.fnv(dir) + ah.cfg('uncommitted.state_ext'), now = ah.clock.now(), c = null, raw = ah.state.readText(rel);
  if (raw !== null) { try { c = JSON.parse(raw); } catch (e) { c = null; } }
  if (c !== null && typeof c === 'object' && typeof c.ts === 'number' && typeof c.lines === 'number' && now - c.ts <= ah.cfgNum('uncommitted.cache_ttl_ms')
      && c.lines < Math.min(soft || hard, hard || soft)) return 'allow';
  var lines = ugCount(dir);
  if (lines === null) return 'allow';
  var warned = c !== null && typeof c === 'object' && typeof c.warned === 'number' ? c.warned : 0;
  var over = hard > 0 && lines >= hard, warn = !over && soft > 0 && lines >= soft && now - warned > ah.cfgNum('uncommitted.soft_warn_every_ms');
  ah.state.writeAtomic(rel, JSON.stringify({ ts: now, lines: lines, warned: warn ? now : warned }));
  if (over) {
    var reason = text.message('block', ah.cfg('uncommitted.guard_name'), {
      what: text.render(ah.cfg('uncommitted.msg_what'), { lines: String(lines), max: String(hard) }),
      why: ah.cfg('uncommitted.msg_why'),
      instead: ah.cfg('uncommitted.msg_instead'),
      override: ah.cfg('uncommitted.msg_override'),
    });
    // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
    return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
  }
  if (!warn) return 'allow';
  var event = typeof p.hook_event_name === 'string' && p.hook_event_name !== '' ? p.hook_event_name : ah.cfg('uncommitted.event');
  return { advisory: text.advisoryJson(event, text.render(ah.cfg('uncommitted.msg_soft'), { lines: String(lines), soft: String(soft), max: String(hard) })) };
}
