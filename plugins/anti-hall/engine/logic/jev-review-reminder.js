// check = "jev-review-reminder" (SessionStart): everything hooks/jev-review-reminder.js can say, decided here. It carries three notices,
// in this order: the one-time "legacy key present but unused" notice (Jev or the semantic judge on; the state file that records it is
// kept by the host primitive `ah.jev.keyNotice`), the "recommend Jev" notice (Jev off only: silent when switched off, in a
// non-interactive run, and for 30 days after it was shown; when due the check stamps its latch and shows it) and the "review due" line
// (Jev on and `jev.reviewReminder` on; the shadow review state is kept by `ah.jev.reviewDue`). A state the engine cannot read
// exactly as Node does adds no notice (counted). Keys: engine/defaults/session_gates.toml (session_gates.*, jev_review.*).
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

// jev-review buildLine(due): the single directive line, capped, naming up to `max_named` integrations and then "+N more".
function reviewLine(due) {
  var max = ah.cfgNum('jev_review.max_line_chars'), named = ah.cfgNum('jev_review.max_named'), joiner = ah.cfg('jev_review.line_list_joiner');
  function item(d) { return text.render(ah.cfg('jev_review.line_item'), { id: d.id, days: d.days, decisions: d.decisions }); }
  function build(n) {
    var list = due.slice(0, n).map(item).join(joiner), rest = due.length - n;
    if (rest > 0) list += text.render(ah.cfg('jev_review.line_more'), { n: rest });
    return text.render(ah.cfg('jev_review.line_text'), { list: list });
  }
  var line = build(Math.min(named, due.length));
  if (line.length > max) {
    for (var n = Math.min(named, due.length) - 1; n >= 1; n--) {
      var candidate = build(n);
      if (candidate.length <= max) { line = candidate; break; }
      line = candidate;
    }
    if (line.length > max) line = line.slice(0, max - 1) + ah.cfg('jev_review.line_ellipsis');
  }
  return line;
}

function decide(p, opts) {
  if (!gates.homeKnown()) { ah.unable('jev-review-reminder:no_home', 'abandoned'); return 'allow'; } // no absolute HOME: no state to read or keep
  var root = gates.pluginRoot(opts);
  if (gates.judgeChild() || subagentPayload(p)) return 'allow';
  if (realHomeUnderTest()) { ah.unable('jev-review-reminder:test_guard', 'abandoned'); return 'allow'; } // the real home under a test is never touched
  var lines = [];
  // `credentials.sessionNotice`: Jev on (settings chain, default off) or the semantic judge on.
  var jevOn = gates.isTrue('session_gates.jev_enabled_setting', false, root);
  var judgeOn = gates.isTrue('session_gates.jev_semantic_judge_setting', false, root);
  if (jevOn || judgeOn) {
    var k = ah.jev.keyNotice(jevOn, judgeOn, gates.isTrue('session_gates.allow_anthropic_setting', false, root));
    if (k.unsure) ah.unable('jev-review-reminder:key_notice_unsure'); // a key state the host cannot read exactly: no key notice
    else if (k.notice) lines.push(k.notice);
  }
  // jev-recommend: applicable only while Jev is off and the notice is not switched off.
  if (!jevOn && gates.setting('jev_review.recommend_setting', true, root) !== false) {
    var entry = ah.env.get(ah.cfg('session_gates.entrypoint_env'));
    var headless = entry !== null && entry.indexOf(ah.cfg('session_gates.headless_prefix')) === 0;
    if (!(headless && !codexPayload(p) && !headlessAllowed(root))) {
      var rel = ah.cfg('jev_review.recommend_latch_file'), key = ah.cfg('jev_review.latch_key');
      var last = gates.storedTime(rel, key), now = Date.now();
      if (!(last !== undefined && last > 0 && last <= now && now - last < ah.cfgNum('jev_review.remind_every_ms'))) {
        // a latch that cannot be written means no notice (never one at every session start)
        if (ah.state.op(ah.home(), 'write', ah.cfg('session_gates.anti_hall_dir') + '/' + rel, '{' + JSON.stringify(key) + ':' + Math.floor(now) + '}\n')) {
          lines.push(ah.cfg('jev_review.recommend_notice'));
        }
      }
    }
  }
  // the review line: Jev on (the strict legacy file value is the fallback Node passes) and the reminder not switched off
  if (gates.isTrue('session_gates.jev_enabled_setting', gates.legacyEnabledStrict(), root) && gates.setting('jev_review.reminder_setting', true, root) !== false) {
    var after = Number(ah.settings.numStrict('jev_review.after_days_setting')) || ah.cfgNum('jev_review.after_days_fallback');
    var min = Number(ah.settings.numStrict('jev_review.min_decisions_setting'));
    if (!isFinite(min)) min = ah.cfgNum('jev_review.min_decisions_fallback');
    var due = ah.jev.reviewDue(after, min);
    if (due === null) return 'allow'; // the review state is unusable: Node throws here and says nothing
    if (due.length) {
      var shown = due.map(function (d) { return { id: d[0], days: d[1], decisions: d[2] }; });
      lines.push(reviewLine(shown));
      ah.jev.reviewShown(shown.map(function (d) { return d.id; }));
    }
  }
  if (!lines.length) return 'allow';
  return { advisory: text.advisoryJson(gates.eventName(p), lines.join(ah.cfg('jev_review.line_joiner'))) };
}
