// check = "auto-handover-pause-nag" (Stop). The Stop-side fire (the fire directive once per arm, when the main agent is over the
// threshold at a Stop and the shared latch has not fired), the natural-pause reminder (context risen nagStepPct points past the last
// nag, or nagQuietMin elapsed, at a quiet point: no open tasks, no subagent spawned in the last two minutes), the re-arm (back below
// the threshold) and the decisive prompt appended when the session has a handover file. The latch is the one auto-handover.js shares
// (<home>/.anti-hall/auto-handover/<tag>.json) and is written in Node's shape; every write is collected while deciding and done at the
// end, so a case that cannot be settled writes nothing. A Stop blocks with {"decision":"block","reason":...}. The home is
// Node's os.homedir() (hookProc.adoptHome: HOME unset adopts the passwd home); a relative transcript path is opened from the payload cwd
// or the stand-in directory; what the engine cannot reproduce exactly says nothing (counted, native_unable). Mirrors
// hooks/auto-handover-pause-nag.js and hooks/lib/auto-handover-*.js, handover-freshness.js (lib/75-ctxbudget.js).
// Keys and texts: ctxbudget.toml (ctxbudget.*).
'use strict';

function pnBlock(reason) { return { exact: { code: 0, out: text.render(cb.c('ctxbudget.stop_block_line'), { reason: JSON.stringify(reason) }), err: '' } }; }

// Node's os.homedir() for this call: false when there is none or it is the real home under a test marker (Node's own guard then writes
// nothing); a relative HOME is resolved against the stand-in directory (counted).
function pnAdopt(p) {
  var why = hookProc.adoptHome();
  if (why === null) return true;
  ah.unable('auto-handover-pause-nag:' + why);
  if (why !== 'relative_home') return false;
  var h = hookProc.home(p);
  if (h === null) return false;
  ah.useHome(h);
  return true;
}

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  if (p === null || typeof p !== 'object' || ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; }) || p.stop_hook_active === true) return 'allow';
  if (!pnAdopt(p)) return 'allow';
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_auto_handover'))) return 'allow';
  var cfg = cb.resolveEffective();
  if (!cfg.enabled) return 'allow';
  var tag = cb.sessionTag(p);
  if (!tag) return 'allow';
  var latch = cb.readLatch(tag);
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : null;
  if (tp) { if (hookProc.openKnown(p, tp) === null) ah.unable('auto-handover-pause-nag:relative_transcript'); tp = hookProc.open(p, tp); } // a relative path opens against the stand-in directory
  // the tail's lines are read only by the fire and nag branches below (most Stops take neither), so they are fetched on first use
  var linesLoaded = false, linesMemo = null;
  var linesOf = function () {
    if (!linesLoaded) { linesLoaded = true; if (tp) linesMemo = ah.fs.tailLines(tp, cb.n('ctxbudget.tail_bytes'), false); }
    return linesMemo;
  };
  var w = { latch: null, inferred: null }, reason = null, now = ah.clock.now(), result;
  if (latch.fired !== true) {
    // the Stop-side fire, once per arm; never for a crossing against a guessed window
    result = cb.getContextPct(tp, p.session_id, w);
    var over = cb.overThreshold(result, cfg);
    if (over === cb.c('ctxbudget.ah_via_pct') || over === cb.c('ctxbudget.ah_via_tokens')) {
      var hp = cb.expectedHandoverPath(p);
      var suffix = cb.decisiveSuffixFor(p, cfg, linesOf());
      w.latch = { fired: true, firedAt: now, firedPct: result.pct, firedVia: cb.c('ctxbudget.ah_via_stop_prefix') + over, lastNagPct: result.pct, lastNagAt: now, softFired: latch.softFired === true };
      reason = cb.fire(result, over, p, cfg.maxTokens, hp) + suffix;
    }
  } else if (cfg.nag) {
    result = cb.getContextPct(tp, p.session_id, w);
    if (result && isFinite(result.pct)) {
      if (!cb.overThreshold(result, cfg)) {
        w.latch = { fired: false }; // dropped back below: re-arm
      } else {
        var fin = function (v) { return typeof v === 'number' && isFinite(v); };
        var lastNagAt = fin(latch.lastNagAt) ? latch.lastNagAt : 0;
        var lastNagPct = fin(latch.lastNagPct) ? latch.lastNagPct : (fin(latch.firedPct) ? latch.firedPct : cfg.pct);
        var shown = Math.round(result.pct), risen = result.pct >= lastNagPct + cfg.nagStepPct, quietElapsed = now - lastNagAt >= cfg.nagQuietMin * 60 * 1000;
        if ((risen || quietElapsed) && !(!risen && latch.lastPauseNagPct === shown)) {
          var open = cb.hasOpenTasks(linesOf());
          var spawned = open === true ? false : cb.recentSpawn(tag, now);
          if (open !== true && !spawned) {
            var sfx = cb.decisiveSuffixFor(p, cfg, linesOf());
            w.latch = Object.assign({}, latch, { lastNagAt: now, lastPauseNagPct: shown });
            if (risen) w.latch.lastNagPct = result.pct;
            reason = cb.pause(result.pct, p) + sfx;
          }
        }
      }
    }
  }
  if (w.inferred) cb.writeInferred(w.inferred);
  if (w.latch) cb.writeLatch(tag, w.latch);
  return reason === null ? 'allow' : pnBlock(reason);
}
