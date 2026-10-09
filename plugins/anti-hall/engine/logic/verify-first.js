// check = "verify-first" (UserPromptSubmit): the short per-turn verify-first reminder. It rotates among a fixed list of lines, picked by
// the SHA-1 of the whole raw stdin envelope (the dispatcher hands the digest as opts.payload_sha1: the first four bytes, big endian,
// modulo the number of lines), and goes through the emit-dedupe store under one key so a queued burst collapses to one copy and an
// unchanged reminder repeats only every guards.injectionRepeatEvery delivered turns. A session that could get the DevSwarm Primary
// sentence (its text reads the repo's CLAUDE.md / AGENTS.md chain) defers to Node before anything is written. Mirrors
// hooks/verify-first.js. Keys, texts and switches: prompt_emit.toml (verify_first.*).
'use strict';

function decide(p, opts) {
  if (ah.env.get(ah.cfg('prompt_emit.judge_child_env')) === '1') return 'allow';
  var digest = jx.isObj(opts) ? opts.payload_sha1 : undefined;
  if (typeof digest !== 'string') return 'defer';
  if (!ah.settings.bool('verify_first.sw_turn')) return 'allow';
  if (vf.primaryPossible()) return 'defer';
  var nudges = ah.cfg('verify_first.nudges');
  if (!/^[0-9a-fA-F]{8}/.test(digest) || nudges.length === 0) return 'defer';
  var t = ah.cfg('verify_first.prefix') + nudges[parseInt(digest.slice(0, 8), 16) % nudges.length];
  var sid = vf.sessionOf(p), tp = vf.transcriptOf(p);
  if (sid === undefined || tp === undefined) return 'defer';
  var emit = true;
  if (sid !== null && !dedupe.disabled()) {
    if (spawn.osHome() === null) return 'defer';
    var every = ah.settings.num('verify_first.num_repeat_every'), norm = ah.cfg('verify_first.dedupe_normalized');
    emit = dedupe.shouldEmit({
      sessionId: sid, transcriptPath: tp, key: ah.cfg('verify_first.dedupe_key'), content: t,
      keepaliveTurns: isFinite(every) && every > 0 ? every : 0, normalize: function () { return norm; },
    });
  }
  return emit ? { advisory: text.advisoryJson(ah.cfg('verify_first.event'), t) } : 'allow';
}
