// check = "inbox-read-guard" (PreToolUse on Read). Blocks a Read-tool read of the raw DevSwarm inbox, which must only be read
// through the wrapper; dormant unless DevSwarm is active. A path inside the raw store is blocked too while the store-read
// command exists (inbox_read_v1.store_cli_present: the shipped plugin has it). Home and a relative path resolve as the Node hook
// process resolves them (lib/78-hook-proc.js). Mirrors hooks/inbox-read-guard.js `main` and hooks/lib/devswarm-inbox-paths.js
// `classifyDevswarmPath`. Keys: spawn_context.toml (inbox_read.*) and guards_v1.toml (inbox_read_v1.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function slashes(s) { return s.split('\\').join('/').replace(/\/+$/, ''); }

function isStoreTarget(rest) {
  return ah.cfg('inbox_read.store_patterns').some(function (src) { return ah.re.test(src, '', rest); });
}

// 'allow' | 'inbox' | 'store'.
function classify(p, raw, home) {
  if (raw === '') return 'allow';
  var abs;
  if (ah.path.isAbsolute(raw)) {
    abs = raw;
  } else {
    var cwd = p.cwd, base = cwd && typeof cwd === 'string' ? cwd : home;
    // path.resolve(base, raw): a relative base resolves against the hook process's own directory
    if (!ah.path.isAbsolute(base)) base = hookProc.base() + '/' + base;
    abs = ah.path.resolveAbs(base + '/' + raw);
  }
  var nAbs = slashes(abs), nRoot = slashes(ah.path.join(home, ah.cfg('inbox_read.devswarm_root')));
  if (nAbs === nRoot || nAbs.indexOf(nRoot + '/') !== 0) return 'allow';
  var rel = nAbs.slice(nRoot.length + 1);
  if (rel === '') return 'allow';
  var seg = rel.split('/')[0];
  if (seg === ah.cfg('inbox_read.inbox_segment')) return 'inbox';
  if (seg === ah.cfg('inbox_read.store_segment')) return isStoreTarget(rel.slice(seg.length + 1)) ? 'store' : 'allow';
  return 'allow';
}

function block(store) {
  var reason = store ? text.message('block', ah.cfg('inbox_read_v1.guard_store'), {
    what: ah.cfg('inbox_read_v1.msg_store_what'), why: ah.cfg('inbox_read_v1.msg_store_why'),
    instead: ah.cfg('inbox_read_v1.msg_store_instead'), override: ah.cfg('inbox_read.msg_override'),
  }) : text.message('block', ah.cfg('inbox_read.guard_inbox'), {
    what: ah.cfg('inbox_read.msg_inbox_what'), why: ah.cfg('inbox_read.msg_inbox_why'),
    instead: ah.cfg('inbox_read.msg_inbox_instead'), override: ah.cfg('inbox_read.msg_override'),
  });
  return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
}

function decide(p) {
  if (!ah.settings.bool('inbox_read.setting') || ah.settings.skipped(ah.cfg('inbox_read.skip_name')) || !spawn.devswarmActive()) return 'allow';
  if (!isObj(p) || p.tool_name !== ah.cfg('inbox_read.tool')) return 'allow';
  var ti = p.tool_input;
  if (!isObj(ti) || typeof ti.file_path !== 'string') return 'allow';
  var home = hookProc.home(p);
  if (home === null) return 'allow';
  var verdict = classify(p, ti.file_path, home);
  if (verdict === 'store') return ah.cfg('inbox_read_v1.store_cli_present') ? block(true) : 'allow';
  return verdict === 'inbox' ? block(false) : 'allow';
}
