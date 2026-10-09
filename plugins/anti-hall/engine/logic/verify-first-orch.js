// check = "verify-first-orch" (SessionStart, the Claude hook entry; verify-first-orch-codex.js is the Codex entry). Emits the
// orchestration discipline text: the full text, or the compact text plus a marker that makes the first spawn deliver the rest (an
// opt-in mode), and keeps that marker in step with what it sent. Everything is decided here except a DevSwarm session (whether it is a
// Primary, with a different text, depends on the role of the workspace and on CLAUDE.md doctrine), which defers to Node before any
// file is touched. Mirrors hooks/verify-first-orch.js `main` and hooks/lib/auto-handover-text.js `isClaudeConfident`.
// Keys, texts and switches: spawn_context.toml (verify_first_orch.*, orch_state.*).
'use strict';

var vfoDecisions = ah.cfg('orch_state.decisions');

// `isClaudeConfident(payload, ['--host=claude'])`: positive evidence that the session runs under Claude Code, namely a session id and a
// transcript path that lies, after resolving links, under the host's `projects` directory. 'defer' when the answer depends on Node's
// own working directory (a relative config directory).
function vfoConfident(p) {
  if (!jx.isObj(p) || typeof p.session_id !== 'string' || p.session_id === '' || vf.codexPayload(p)) return false;
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '' || !ah.path.isAbsolute(tp)) return false;
  var cfg = ah.env.get(ah.cfg('verify_first_orch.config_dir_env'));
  if (cfg === null || cfg === '') {
    var h = spawn.stateHome();
    if (h.guarded) return false;
    if (h.unknown) return 'defer';
    cfg = h.ok + '/' + ah.cfg('verify_first_orch.config_dir_default');
  }
  if (!ah.path.isAbsolute(cfg)) return 'defer';
  var base = ah.fs.realpath(ah.path.resolveAbs(cfg + '/' + ah.cfg('verify_first_orch.projects_dir')));
  if (base === null) return false;
  var segs = tp.slice(1).split('/');
  for (var j = 0; j < segs.length; j++) if (segs[j] === '' || segs[j] === '.' || segs[j] === '..') return false;
  var existing = '/', i = 0;
  while (i < segs.length) {
    var next = existing === '/' ? '/' + segs[i] : existing + '/' + segs[i], st = ah.fs.lstat(next);
    if (st === null || st.kind === 'error') break;
    existing = next;
    i++;
  }
  var real = ah.fs.realpath(existing);
  if (real === null) return false;
  var cand = real;
  for (; i < segs.length; i++) cand = cand === '/' ? '/' + segs[i] : cand + '/' + segs[i];
  var under = base === '/' ? cand !== '/' : cand.indexOf(base + '/') === 0;
  return under;
}

// `orchCompact(spawnDelivery, root, codex)`.
function vfoCompact(spawnDelivery, root, codex) {
  var first = ah.cfg('verify_first_orch.compact_first').split(ah.cfg('verify_first_orch.delivery_placeholder')).join(spawnDelivery ? ah.cfg('verify_first_orch.compact_delivery') : '');
  var mn = ah.cfg('verify_first_orch.mn_prefix'), body = ah.cfg('verify_first_orch.compact_body'), swapped = -1;
  for (var i = 0; i < body.length; i++) if (body[i].indexOf(mn) === 0) { swapped = i; break; }
  var lines = [first];
  for (var k = 0; k < body.length; k++) lines.push(codex && k === swapped ? ah.cfg('verify_first_orch.compact_mn_codex') : body[k]);
  return lines.join('\n').split(ah.cfg('verify_first_orch.root_placeholder')).join(root);
}

function vfoFull(codex) { return ah.cfg(codex ? 'verify_first_orch.full_lines_codex' : 'verify_first_orch.full_lines').join('\n'); }

// The orchestration marker file of a session (hooks/lib/orch-full-state.js `writeMarker`): written atomically, then stale state swept.
function vfoWriteMarker(sid, decision) {
  var dir = ah.cfg('script.write_root') + '/' + ah.cfg('orch_state.dir');
  var now = Math.floor(ah.clock.now());
  var body = '{"epochId":"' + now + '","decision":' + JSON.stringify(decision) + ',"sentAt":' + now + '}';
  try {
    if (!ah.state.writeAtomic(dir + '/' + ah.cfg('orch_state.prefix') + '-' + spawn.sanitize(sid) + '.json', body)) return false;
  } catch (e) { return false; }
  gk.pruneStale(dir, ah.cfg('orch_state.prefix'));
  return true;
}

// The plugin root as Node computes it (`path.resolve(__dirname, '..')`, links resolved): the option the dispatcher passes, else the
// plugin-root variable; null when there is none or it does not resolve.
function vfoRoot(opts) {
  var given = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  return given === null ? null : ah.fs.realpath(given);
}

function vfoDecide(p, opts, claudeHost) {
  if (spawn.judgeChild()) return null;
  if (spawn.osHome() === null) return 'defer';
  var confident = claudeHost ? vfoConfident(p) : false;
  if (confident === 'defer') return 'defer';
  var state = spawn.stateHome();
  var none = vfoDecisions[1], pending = vfoDecisions[0];
  var sid = jx.isObj(p) && typeof p.session_id === 'string' && p.session_id !== '' ? p.session_id : null;
  // writeNone: clear a pending marker of an earlier epoch (a confident session always has a marker).
  function writeNone() {
    if (state.ok === undefined) return;
    if (confident) { if (sid !== null) vfoWriteMarker(sid, none); }
    else if (sid !== null && spawn.readMarker(state.ok, sid) !== null) vfoWriteMarker(sid, none);
  }
  if (!ah.settings.bool('orch_state.setting')) { writeNone(); return null; }
  var codex = vf.codexPayload(p);
  if (spawn.devswarmActive()) return 'defer';
  function emit(t) { return { advisory: text.advisoryJson(ah.cfg('verify_first_orch.event'), t) }; }
  if (ah.settings.enum('orch_state.protocol_setting') === ah.cfg('orch_state.full_level')) { writeNone(); return emit(vfoFull(codex)); }
  var mode = ah.settings.enum('orch_state.orch_full_on_setting');
  if (mode === 'auto') mode = 'session';
  if (mode === 'spawn' && !confident) mode = 'session';
  if (codex && !confident && mode !== 'off') {
    mode = 'session';
    if (sid !== null && ah.settings.enum('orch_state.codex_orch_full_on_setting') === 'spawn') mode = 'spawn';
  }
  if (mode === 'spawn' && ah.settings.skipped(ah.cfg('orch_state.skip_name'))) mode = 'session';
  // The compact text names the plugin root: without it nothing may be written, so the deferral comes first.
  if (mode === 'off' || mode === 'spawn') {
    var root = vfoRoot(opts);
    if (root === null) return 'defer';
    if (mode === 'off') { writeNone(); return emit(vfoCompact(false, root, codex)); }
    if (state.ok !== undefined && sid !== null && vfoWriteMarker(sid, pending)) return emit(vfoCompact(true, root, codex));
  }
  writeNone();
  return emit(vfoFull(codex));
}

function decide(p, opts) { return vfoDecide(p, opts, true); }
