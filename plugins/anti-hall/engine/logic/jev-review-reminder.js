// check = "jev-review-reminder" (SessionStart; jev-weekly-scorecard.js and repair-on-reload.js build on this script). The gates of three
// Node hooks that run at session start (and, for the repair, on every prompt) and are silent almost every time. Each answers "nothing to
// say" itself when it can prove the Node hook would print nothing and write nothing, and answers natively the fire paths it can reproduce
// byte for byte: the recommend-Jev notice with its latch (this check) and the weekly latch of a check that finds no Jev decision rows
// (jev-weekly-scorecard). It defers to the Node hook in every other case (the Jev report, the review log, the legacy-key notice, the
// migration engine and the detached repair), so a deferral is the exact Node behavior and nothing is decided twice. Mirrors the early
// exits of hooks/jev-review-reminder.js (with the recommend notice of hooks/lib/jev-recommend.js), hooks/jev-weekly-scorecard.js and
// hooks/repair-on-reload.js. Keys and texts: session_gates.toml (session_gates.*, jev_review.*, jev_weekly.*, repair_reload.*).
'use strict';

function sgT(k) { return ah.cfg('session_gates.' + k); }

// True when a Jev judge child runs this hook (every one of these hooks then does nothing).
function sgJudgeChild() { return ah.env.get(sgT('judge_child_env')) === sgT('judge_child_value'); }

// The home directory the Node hook would use (`os.homedir()` is $HOME), or false when the request has none.
function sgHomeKnown() { var h = ah.env.get(ah.cfg('env.home')); return h !== null && ah.path.isAbsolute(h); }

function sgDir() { return ah.home() + '/' + sgT('anti_hall_dir'); }

// `get(section, key, dflt)` of a setting under the plugin root: {value} (undefined when nothing sets it), or null when the answer needs
// a plugin root the caller does not have.
function sgGet(key, dflt, root) {
  var r = ah.settings.get(key, dflt, root);
  return r.status === 'undecidable' ? null : { value: r.status === 'value' ? r.value : undefined };
}

// `get(section, key, dflt) === true` of a boolean setting: true / false, or null when undecidable.
function sgIsTrue(key, dflt, root) { var g = sgGet(key, dflt, root); return g === null ? null : g.value === true; }

// An object stored under `anti_hall_dir` in a small JSON file: the object, or null (absent, not an object, not JSON).
function sgReadObject(rel) {
  var f = jx.read(sgDir() + '/' + rel);
  if (f.text === undefined) return null;
  var r = jx.parse(f.text.trim());
  return r.invalid || r.unsure || !jx.isObj(r.v) ? null : r.v;
}

// `readJevJson(home).enabled === true`: the strict reading of the legacy file, the fallback value Node passes.
function sgLegacyEnabledStrict() { var o = sgReadObject(sgT('jev_config_file')); return o !== null && o.enabled === true; }

// The time stored under `key` in a small JSON state file, when it is a finite number.
function sgStoredTime(rel, key) { var o = sgReadObject(rel); return o !== null && typeof o[key] === 'number' && isFinite(o[key]) ? o[key] : null; }

function sgEventName(p) { return jx.isObj(p) && typeof p.hook_event_name === 'string' && p.hook_event_name !== '' ? p.hook_event_name : sgT('default_event'); }

function sgSubagentPayload(p) {
  if (!jx.isObj(p)) return false;
  // `payload.agent_id || payload.agent_type`, then `isSidechain === true || is_sidechain === true`
  return sgT('agent_key_markers').some(function (k) { return !!p[k]; }) || sgT('sidechain_flags').some(function (k) { return p[k] === true; });
}

function sgCodexPayload(p) {
  if (!jx.isObj(p)) return false;
  if (p.tool_name === sgT('codex_tool')) return true;
  return sgT('codex_fields').every(function (k) { return typeof p[k] === 'string' && p[k] !== ''; });
}

function sgRealHomeUnderTest() {
  var set = function (k) { var v = ah.env.get(k); return v !== null && v !== ''; };
  if (set(sgT('allow_real_home_env')) || !sgT('test_markers').some(set)) return false;
  var real = ah.env.passwdHome();
  return real !== null && ah.path.resolveAbs(ah.env.get(ah.cfg('env.home'))) === ah.path.resolveAbs(real);
}

function sgHeadlessAllowed(root) {
  var set = sgGet('jev_review.headless_setting', null, root);
  if (set === null) return null;
  if (set.value === null) {
    var level = sgGet('jev_review.protocol_level_setting', undefined, root);
    return level === null ? null : level.value === ah.cfg('jev_review.protocol_full');
  }
  return set.value === true;
}

function sgRoot(opts) { return jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : (ah.env.get(ah.cfg('env.plugin_root')) || ''); }

function decide(p, opts) {
  if (!sgHomeKnown()) return 'defer';
  var root = sgRoot(opts);
  if (sgJudgeChild() || sgSubagentPayload(p)) return 'allow';
  if (sgRealHomeUnderTest()) return 'defer';
  // credentials.sessionNotice (Jev on, or the judge on) and the review line (Jev on) need the Node hook.
  var on = sgIsTrue('session_gates.jev_enabled_setting', false, root);
  if (on === null || on) return 'defer';
  var judge = sgIsTrue('session_gates.jev_semantic_judge_setting', false, root);
  if (judge === null || judge) return 'defer';
  var legacy = sgIsTrue('session_gates.jev_enabled_setting', sgLegacyEnabledStrict(), root);
  if (legacy === null || legacy) return 'defer';
  // jev-recommend: applicable only while Jev is off and the notice is not switched off.
  var rec = sgGet('jev_review.recommend_setting', true, root);
  if (rec === null) return 'defer';
  if (rec.value === false) return 'allow';
  var ep = ah.env.get(sgT('entrypoint_env')), headless = ep !== null && ep.indexOf(sgT('headless_prefix')) === 0;
  if (headless && !sgCodexPayload(p)) {
    var allowed = sgHeadlessAllowed(root);
    if (allowed === null) return 'defer';
    if (!allowed) return 'allow';
  }
  var rel = ah.cfg('jev_review.recommend_latch_file'), key = ah.cfg('jev_review.latch_key');
  var last = sgStoredTime(rel, key), now = ah.clock.now();
  if (last !== null && last > 0 && last <= now && now - last < ah.cfgNum('jev_review.remind_every_ms')) return 'allow';
  var body = {}; body[key] = Math.floor(now);
  var ok = false;
  try { ok = ah.state.writeAtomic(sgT('anti_hall_dir') + '/' + rel, JSON.stringify(body) + '\n'); } catch (e) { ok = false; }
  if (!ok) return 'allow';
  return { advisory: text.advisoryJson(sgEventName(p), ah.cfg('jev_review.recommend_notice')) };
}
