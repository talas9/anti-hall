// check = "inbox-read-guard" (PreToolUse on Read). Blocks a Read-tool read of the raw DevSwarm inbox, which must only be read
// through the wrapper; dormant unless DevSwarm is active. A path inside the raw store defers to Node (it blocks only when the
// wrapper's store-read command exists, which only Node can load). Mirrors hooks/inbox-read-guard.js `main` and
// hooks/lib/devswarm-inbox-paths.js `classifyDevswarmPath`. Everything configurable is in spawn_context.toml (inbox_read.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function slashes(s) { return s.split('\\').join('/').replace(/\/+$/, ''); }

function isStoreTarget(rest) {
  return ah.cfg('inbox_read.store_patterns').some(function (src) { return ah.re.test(src, '', rest); });
}

// 'allow' | 'inbox' | 'store', or null when Node would resolve a relative path against its own working directory.
function classify(raw, home, cwd) {
  if (raw === '') return 'allow';
  var abs;
  if (ah.path.isAbsolute(raw)) {
    abs = raw;
  } else {
    var base = cwd !== null && cwd !== '' ? cwd : home;
    if (!ah.path.isAbsolute(base)) return null;
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

function block() {
  var reason = text.message('block', ah.cfg('inbox_read.guard_inbox'), {
    what: ah.cfg('inbox_read.msg_inbox_what'), why: ah.cfg('inbox_read.msg_inbox_why'),
    instead: ah.cfg('inbox_read.msg_inbox_instead'), override: ah.cfg('inbox_read.msg_override'),
  });
  return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
}

function decide(p) {
  var home = spawn.osHome();
  if (home === null) return 'defer';
  if (!ah.settings.bool('inbox_read.setting') || ah.settings.skipped(ah.cfg('inbox_read.skip_name')) || !spawn.devswarmActive()) return 'allow';
  if (!isObj(p) || p.tool_name !== ah.cfg('inbox_read.tool')) return 'allow';
  var ti = p.tool_input;
  if (!isObj(ti) || typeof ti.file_path !== 'string') return 'allow';
  var verdict = classify(ti.file_path, home, typeof p.cwd === 'string' ? p.cwd : null);
  if (verdict === null || verdict === 'store') return 'defer';
  return verdict === 'inbox' ? block() : 'allow';
}
