// check = "auto-handover" (UserPromptSubmit). The threshold fire, the soft advisory, the milestone nag, the latch re-arm and the
// post-handover new-work gate with its backstop. The hooks share one per-session latch (<home>/.anti-hall/auto-handover/<tag>.json);
// it is read and written in Node's shape. Every write is collected while deciding and done at the end, so a case that must defer
// (a request without an absolute HOME, a relative transcript path or working directory, a time zone of the request's own, a
// repository root the host cannot settle) defers before anything is written. A prompt with text on an armed gate also asks the
// postHandoverGate Jev integration without waiting. Mirrors hooks/auto-handover.js and lib/auto-handover-*.js, lib/context-pct.js
// (lib/75-ctxbudget.js). Keys and texts: ctxbudget.toml (ctxbudget.*).
'use strict';

function ahEmpty() { return { exact: { code: 0, out: ah.cfg('ctxbudget.ups_empty'), err: '' } }; }
function ahOut(t) { return t === '' ? ahEmpty() : { exact: { code: 0, out: text.render(ah.cfg('ctxbudget.ups_line'), { text: JSON.stringify(t) }), err: '' } }; }

function ahConsultJev(p, cfg, result) {
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) return;
  var tokK = isFinite(result.max) && result.max > 0 ? text.render(ah.cfg('ctxbudget.ah_jev_tokens'), { k: Math.round((result.max * cfg.gateBudgetPct) / 100 / 1000) }) : '';
  var spec = {
    id: ah.cfg('ctxbudget.ah_jev_id'),
    question: { type: 'noul', instructions: text.render(ah.cfg('ctxbudget.ah_jev_instructions'), { b: cfg.gateBudgetPct, tok: tokK }), criteria: [['true', ah.cfg('ctxbudget.ah_jev_true')], ['false', ah.cfg('ctxbudget.ah_jev_false')]] },
    state: p.prompt.slice(0, ah.cfgNum('ctxbudget.ah_jev_state_chars')), trust: 'advisory', baseline: null,
  };
  if (p.session_id) spec.sessionId = String(p.session_id);
  if (typeof p.transcript_path === 'string' && p.transcript_path) spec.turnRefFrom = p.transcript_path;
  ah.jev.ask(spec);
}

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  if (!p || typeof p !== 'object' || ah.cfg('coordinator_work.agent_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return ahEmpty();
  var home = ah.env.get(ah.cfg('ctxbudget.home_env'));
  if (home === null || !ah.path.isAbsolute(home)) return 'defer';
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_auto_handover'))) return ahEmpty();
  var cfg = cb.resolveEffective(), tag = cb.sessionTag(p);
  if (!tag) return ahEmpty();
  var latch = cb.readLatch(tag), fired = latch.fired === true, w = { latch: null, inferred: null }, out = '', jev = null;
  if (!cfg.enabled) {
    if (fired) cb.writeLatch(tag, { fired: false });
    return ahEmpty();
  }
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : null;
  var result = cb.getContextPct(tp, p.session_id, w);
  if (result === 'defer') return 'defer';
  if (result && isFinite(result.pct)) {
    var now = ah.clock.now(), over = cb.overThreshold(result, cfg);
    if (!over) {
      if (fired || latch.softFired) w.latch = { fired: false, softFired: false };
    } else if (!fired) {
      if (over === 'pct-unknown-window') {
        if (latch.softFired !== true) { out = cb.soft(result.pct); w.latch = Object.assign({}, latch, { softFired: true, lastNagAt: now }); }
      } else {
        var hp = cb.expectedHandoverPath(p);
        if (hp === false) return 'defer';
        out = cb.fire(result, over, p, cfg.maxTokens, hp);
        w.latch = { fired: true, firedAt: now, firedPct: result.pct, firedVia: over, lastNagPct: result.pct, lastNagAt: now, softFired: false };
      }
    } else {
      var cur = latch, dirty = false, parts = [], backstop = false, housekeeping = cb.isHousekeeping(p.prompt, cfg.gateHousekeepingMarkers);
      if (cfg.gateNewWork && !housekeeping) {
        var noted = cb.noteHandover(cur, p, result.pct, now);
        if (noted === 'defer') return 'defer';
        if (noted) { cur = noted; dirty = true; }
        if (cb.isArmed(cfg, cur)) {
          if (cb.backstopDue(cfg, cur, result.pct)) {
            parts.push(cb.gateBackstop(result.pct, cur, cfg, p));
            cur = Object.assign({}, cur, { gateBackstopAt: now, gateBackstopPct: result.pct, lastNagPct: result.pct, lastNagAt: now });
            dirty = true;
            backstop = true;
          }
          parts.push(cb.gateDirective(result, cur, cfg, p));
          jev = { result: result };
        }
      }
      if (!backstop && cfg.nag) {
        var lastNagPct = typeof cur.lastNagPct === 'number' && isFinite(cur.lastNagPct) ? cur.lastNagPct : (cur.firedPct || cfg.pct);
        if (result.pct >= lastNagPct + cfg.nagStepPct) {
          parts.push(cb.milestone(result.pct, p));
          cur = Object.assign({}, cur, { lastNagPct: result.pct, lastNagAt: now });
          dirty = true;
        }
      }
      if (dirty) w.latch = cur;
      out = parts.join(cb.c('ctxbudget.ah_parts_sep'));
    }
  }
  if (w.inferred) cb.writeInferred(w.inferred);
  if (w.latch) cb.writeLatch(tag, w.latch);
  if (jev) ahConsultJev(p, cfg, jev.result);
  return ahOut(out);
}
