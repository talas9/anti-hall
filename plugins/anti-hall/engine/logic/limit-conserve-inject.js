// check = "limit-conserve-inject" (UserPromptSubmit). Conservation is active when the mode is `on`, or when `auto` and a usage bucket
// of the OMC cache is at or over the threshold and the account-switch guard does not hold the reading stale. Then the directive is
// built and emit-dedupe (lib/74-emit-dedupe.js) decides whether to send it this turn; everything else prints the empty context line.
// The account-switch state file is read and written as Node does. The home is Node's os.homedir() (hookProc.adoptHome: HOME unset
// adopts the passwd home); a relative transcript path is opened for emit-dedupe from the payload cwd or the stand-in
// directory; a number or boolean reset time is read by Date exactly as V8 reads it. What the engine cannot reproduce exactly is decided
// natively and counted (native_unable): no home or the real home under a test marker prints nothing, a usage cache, ~/.claude.json
// or account state over the read cap means no conservation / no account change, an object reset time is skipped, an emit-dedupe
// timestamp only V8 reads is decided on what the engine reads. Mirrors hooks/limit-conserve-inject.js and hooks/limit-conserve.js. Keys and texts: ctxbudget.toml (ctxbudget.*).
'use strict';

function lcEmpty() { return { exact: { code: 0, out: ah.cfg('ctxbudget.ups_empty'), err: '' } }; }

// The reset time at minute precision (Node's minuteRounded): the cache's millisecond jitter would change the text every turn.
function lcMinuteRounded(iso) {
  var r = ah.cfg('ctxbudget.lc_reset_round'), t = new Date(iso).getTime();
  if (!isFinite(t)) return String(iso);
  return new Date(Math.round(t / r.ms) * r.ms).toISOString().replace(r.cut, r.to);
}

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  var pend = { w: null };
  var active = lcSessionConserving(p, pend);
  var tp = p && typeof p.transcript_path === 'string' && p.transcript_path !== '' ? p.transcript_path : null;
  if (active === null) { if (pend.w) pend.w(); return lcEmpty(); }
  var resets = active.resetsAt !== null ? text.render(ah.cfg('ctxbudget.lc_resets_at'), { at: lcMinuteRounded(active.resetsAt) }) : ah.cfg('ctxbudget.lc_resets_next');
  var built = text.message('warn', ah.cfg('ctxbudget.lc_guard'), {
    what: text.render(ah.cfg('ctxbudget.lc_what'), { reason: active.reason }), why: ah.cfg('ctxbudget.lc_why'),
    instead: ah.cfg('ctxbudget.lc_instead') + resets + ' ' + ah.cfg('ctxbudget.lc_downshift'),
  });
  var sid = p && typeof p.session_id === 'string' ? p.session_id : null;
  var emit = true;
  if (sid !== null) {
    var o = { sessionId: sid, transcriptPath: tp, readPath: tp !== null ? hookProc.open(p, tp) : null, key: ah.cfg('ctxbudget.lc_dedupe_key'), content: built, keepaliveTurns: ah.cfgNum('ctxbudget.lc_keepalive_turns') };
    if (!dedupe.canDecide(o)) ah.unable('limit-conserve-inject:dedupe_unsure'); // a transcript timestamp only V8 reads: decided on what the engine reads
    if (pend.w) pend.w();
    emit = dedupe.shouldEmit(o);
  }
  if (sid === null && pend.w) pend.w();
  return emit ? { exact: { code: 0, out: text.render(ah.cfg('ctxbudget.ups_line'), { text: JSON.stringify(built) }), err: '' } } : lcEmpty();
}
