// check = "jev-review-reminder" (SessionStart): the gates of hooks/jev-review-reminder.js with those of the two notices it
// carries. With Jev and the semantic judge off only the "recommend Jev" notice can speak: silent when switched off, in a
// non-interactive run, and for 30 days after it was shown; when due the check stamps its latch and shows it. With Jev or the
// judge on, the other two notices are Node's. Keys: engine/defaults/session_gates.toml (session_gates.*, jev_review.*).
'use strict';

// `isSubagentPayload(payload)`
function subagentPayload(p) {
  if (!gates.isObject(p)) return false;
  return ah.cfg('session_gates.agent_key_markers').some(function (k) { return !!p[k]; }) ||
    ah.cfg('session_gates.sidechain_flags').some(function (k) { return p[k] === true; });
}

// `isCodexPayload(payload)`
function codexPayload(p) {
  if (!gates.isObject(p)) return false;
  if (p.tool_name === ah.cfg('session_gates.codex_tool')) return true;
  return ah.cfg('session_gates.codex_fields').every(function (k) { return typeof p[k] === 'string' && p[k] !== ''; });
}

// `realHomeUnderTest(resolveHome(...))`: a test marker is set and the home is the password database one, where the Node hook's
// `resolveHome` throws (and prints nothing). The engine leaves that case to Node.
function realHomeUnderTest() {
  var set = function (k) { var v = ah.env.get(k); return v !== null && v !== ''; };
  if (set(ah.cfg('session_gates.allow_real_home_env')) || !ah.cfg('session_gates.test_markers').some(set)) return false;
  var real = ah.env.passwdHome();
  return real !== null && ah.path.resolveAbs(ah.home()) === ah.path.resolveAbs(real);
}

// jev-recommend `headlessAllowed`: `jev.recommendNoticeHeadless`, whose default turns true under `context.protocolLevel` full
// while the setting is not set anywhere.
function headlessAllowed(root) {
  var set = gates.setting('jev_review.headless_setting', null, root);
  if (set === null) return gates.setting('jev_review.protocol_level_setting', undefined, root) === ah.cfg('jev_review.protocol_full');
  return set === true;
}

function decide(p, opts) {
  if (!gates.homeKnown()) return 'defer';
  return gates.run(function () {
    var root = gates.pluginRoot(opts);
    if (gates.judgeChild() || subagentPayload(p)) return 'allow';
    if (realHomeUnderTest()) return 'defer';
    // credentials.sessionNotice (Jev on, or the judge on) and the review line (Jev on) need the Node hook.
    if (gates.isTrue('session_gates.jev_enabled_setting', false, root) || gates.isTrue('session_gates.jev_semantic_judge_setting', false, root) ||
        gates.isTrue('session_gates.jev_enabled_setting', gates.legacyEnabledStrict(), root)) return 'defer';
    // jev-recommend: applicable only while Jev is off and the notice is not switched off.
    if (gates.setting('jev_review.recommend_setting', true, root) === false) return 'allow';
    var entry = ah.env.get(ah.cfg('session_gates.entrypoint_env'));
    var headless = entry !== null && entry.indexOf(ah.cfg('session_gates.headless_prefix')) === 0;
    if (headless && !codexPayload(p) && !headlessAllowed(root)) return 'allow';
    var rel = ah.cfg('jev_review.recommend_latch_file'), key = ah.cfg('jev_review.latch_key');
    var last = gates.storedTime(rel, key), now = Date.now();
    if (last !== undefined && last > 0 && last <= now && now - last < ah.cfgNum('jev_review.remind_every_ms')) return 'allow';
    if (!ah.state.op(ah.home(), 'write', ah.cfg('session_gates.anti_hall_dir') + '/' + rel, '{' + JSON.stringify(key) + ':' + Math.floor(now) + '}\n')) return 'allow';
    return { advisory: text.advisoryJson(gates.eventName(p), ah.cfg('jev_review.recommend_notice')) };
  });
}
