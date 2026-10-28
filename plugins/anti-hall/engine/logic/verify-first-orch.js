// check = "verify-first-orch" (SessionStart, the Claude hook entry; verify-first-orch-codex.js is the Codex entry). Emits the
// orchestration discipline text: the full text, or the compact text plus a marker that makes the first spawn deliver the rest (an
// opt-in mode), and keeps that marker in step with what it sent. Everything is decided here, a DevSwarm Primary included (the gate is
// `vf.tierTextOn`: DevSwarm active, not a child workspace, the dispatch-tier switch on, the repository not forbidding workspaces); a
// repository layout or working directory the engine cannot classify counts as not a Primary (native_unable). Mirrors hooks/verify-first-orch.js `main` and hooks/lib/auto-handover-text.js `isClaudeConfident`.
// Keys, texts and switches: spawn_context.toml (verify_first_orch.*, orch_state.*).
'use strict';

var vfoDecisions = ah.cfg('orch_state.decisions');

// `isClaudeConfident(payload, ['--host=claude'])`: positive evidence that the session runs under Claude Code, namely a session id and a
// transcript path that lies, after resolving links, under the host's `projects` directory. A relative config directory resolves against the stand-in directory (counted); no home is not confident.
function vfoConfident(p) {
  if (!jx.isObj(p) || typeof p.session_id !== 'string' || p.session_id === '' || vf.codexPayload(p)) return false;
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '' || !ah.path.isAbsolute(tp)) return false;
  var cfg = ah.env.get(ah.cfg('verify_first_orch.config_dir_env'));
  if (cfg === null || cfg === '') {
    var h = spawn.stateHome();
    if (h.guarded) return false;
    if (h.unknown) { ah.unable('verify-first-orch:confident_no_home'); return false; }
    cfg = h.ok + '/' + ah.cfg('verify_first_orch.config_dir_default');
  }
  if (!ah.path.isAbsolute(cfg)) { ah.unable('verify-first-orch:relative_config_dir'); cfg = hookProc.base() + '/' + cfg; }
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

// ORCH_FULL, or ORCH_FULL_PRIMARY (rule W after the header line) for a DevSwarm Primary.
function vfoFull(codex, primary) {
  var lines = ah.cfg(codex ? 'verify_first_orch.full_lines_codex' : 'verify_first_orch.full_lines').slice();
  if (primary) lines.splice(1, 0, ah.cfg('verify_first_orch.primary_rule'));
  return lines.join('\n');
}

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
  if (spawn.osHome() === null) { ah.unable('verify-first-orch:no_home'); return null; } // no absolute HOME: no marker to keep, nothing said
  var confident = claudeHost ? vfoConfident(p) : false;
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
  // `primaryTierTextOn(env, cwd)`: null = the answer needs what the engine does not reproduce, so Node decides (nothing written yet).
  var primary = vf.tierTextOn(p);
  if (primary === null) { ah.unable('verify-first-orch:tier_text_unsure'); primary = false; } // a layout the host cannot classify: not a Primary
  function emit(t) { return { advisory: text.advisoryJson(ah.cfg('verify_first_orch.event'), t) }; }
  if (ah.settings.enum('orch_state.protocol_setting') === ah.cfg('orch_state.full_level') || primary) { writeNone(); return emit(vfoFull(codex, primary)); }
  var mode = ah.settings.enum('orch_state.orch_full_on_setting');
  if (mode === 'auto') mode = ah.cfg('orch_state.auto_mode');
  if (mode === 'spawn' && !confident) mode = 'session';
  if (codex && !confident && mode !== 'off') {
    mode = 'session';
    if (sid !== null && ah.settings.enum('orch_state.codex_orch_full_on_setting') === 'spawn') mode = 'spawn';
  }
  if (mode === 'spawn' && ah.settings.skipped(ah.cfg('orch_state.skip_name'))) mode = 'session';
  // The compact text names the plugin root: without it the full text is sent (counted).
  var root = mode === 'off' || mode === 'spawn' ? vfoRoot(opts) : null;
  if (root === null && (mode === 'off' || mode === 'spawn')) ah.unable('verify-first-orch:no_plugin_root');
  if (root !== null) {
    if (mode === 'off') { writeNone(); return emit(vfoCompact(false, root, codex)); }
    if (state.ok !== undefined && sid !== null && vfoWriteMarker(sid, pending)) return emit(vfoCompact(true, root, codex));
  }
  writeNone();
  return emit(vfoFull(codex));
}

function decide(p, opts) { return vfoDecide(p, opts, true); }
