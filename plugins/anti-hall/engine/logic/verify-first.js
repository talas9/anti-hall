// check = "verify-first" (UserPromptSubmit): the short per-turn verify-first reminder. It rotates among a fixed list of lines, picked by
// the SHA-1 of the whole raw stdin envelope (the dispatcher hands the digest as opts.payload_sha1: the first four bytes, big endian,
// modulo the number of lines), and goes through the emit-dedupe store under one key so a queued burst collapses to one copy and an
// unchanged reminder repeats only every guards.injectionRepeatEvery delivered turns. A DevSwarm Primary session appends the
// dispatch-tier sentence (gate: vf.tierTextOn, which reads the repo's CLAUDE.md / AGENTS.md chain); a layout it cannot classify gets no sentence (counted). Mirrors
// hooks/verify-first.js. Keys, texts and switches: prompt_emit.toml (verify_first.*).
'use strict';

function decide(p, opts) {
  if (ah.env.get(ah.cfg('prompt_emit.judge_child_env')) === '1') return 'allow';
  var digest = jx.isObj(opts) ? opts.payload_sha1 : undefined;
  // the rotation seed: the dispatcher's digest of the stdin envelope, else the digest of the payload itself (counted)
  if (typeof digest !== 'string') { ah.unable('verify-first:no_digest'); digest = ah.sha1(JSON.stringify(p === undefined ? null : p)); }
  if (!ah.settings.bool('verify_first.sw_turn')) return 'allow';
  var primary = vf.tierTextOn(p);
  if (primary === null) { ah.unable('verify-first:tier_text_unsure'); primary = false; } // a layout the host cannot classify: no dispatch-tier sentence
  var nudges = ah.cfg('verify_first.nudges');
  if (!/^[0-9a-fA-F]{8}/.test(digest) || nudges.length === 0) { ah.unable('verify-first:no_rotation', 'abandoned'); return 'allow'; } // nothing to rotate
  var t = ah.cfg('verify_first.prefix') + nudges[parseInt(digest.slice(0, 8), 16) % nudges.length];
  if (primary) t += ah.cfg('verify_first.primary_joiner') + ah.cfg('verify_first.primary_nudge');
  var sid = vf.sessionOf(p), tp = vf.transcriptOf(p);
  if (sid === undefined) { ah.unable('verify-first:session_shape'); sid = null; } // a session id of another type keeps no dedupe state
  if (tp === undefined) { ah.unable('verify-first:transcript_shape'); tp = null; }
  var emit = true;
  if (sid !== null && !dedupe.disabled()) {
    if (spawn.osHome() === null) { ah.unable('verify-first:no_home', 'abandoned'); return 'allow'; } // no absolute HOME: no dedupe state to keep
    var every = ah.settings.num('verify_first.num_repeat_every'), norm = ah.cfg(primary ? 'verify_first.dedupe_normalized_primary' : 'verify_first.dedupe_normalized');
    emit = dedupe.shouldEmit({
      sessionId: sid, transcriptPath: tp, key: ah.cfg('verify_first.dedupe_key'), content: t,
      keepaliveTurns: isFinite(every) && every > 0 ? every : 0, normalize: function () { return norm; },
    });
  }
  return emit ? { advisory: text.advisoryJson(ah.cfg('verify_first.event'), t) } : 'allow';
}
