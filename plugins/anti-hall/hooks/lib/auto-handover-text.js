// anti-hall :: auto-handover-text — every message the auto-handover feature
// emits (fire directive, milestone nag, soft advisory, natural-pause nag),
// shared by hooks/auto-handover.js (UserPromptSubmit) and
// hooks/auto-handover-pause-nag.js (Stop: pause nag + the once-only Stop-side
// fire for long autonomous turns that never pass UserPromptSubmit).
//
// Pure Node built-ins only.

'use strict';

// One short, non-alarmist sentence shared by every message this feature
// emits (fire directive, milestone nag, and the Stop-time pause nag) — the
// reason to compact/clear isn't only "you'll hit the limit soon".
const BLOAT_SENTENCE =
  'As context grows the model gets less efficient and more prone to hallucination, ' +
  'so compacting/clearing keeps answers accurate, not just under the limit.';

function buildFireDirective(pct, estimated, windowLabel) {
  let label = '';
  if (estimated) {
    label = windowLabel === 'inferred-1m'
      ? ' (inferred 1M window — observed usage already exceeded the standard 200k, so this session is estimated against a 1,000,000-token window)'
      : ' (ESTIMATED — assuming a standard 200k context window; if this is a 1M-context session, set ANTIHALL_CONTEXT_WINDOW_TOKENS or install the anti-hall statusline for an exact reading)';
  }
  return (
    'CONTEXT AT ~' + Math.round(pct) + '%' + label + ' — AUTO-HANDOVER REQUIRED. Without asking the user first: ' +
    '(1) immediately WRITE an anti-hall session handover YOURSELF, following the /anti-hall:handover ' +
    'skill contract exactly (self-write mandate — never delegate this to a subagent; it never lived ' +
    'this session and would lose decision/trial fidelity); ' +
    '(2) then TELL the user this was done, to preserve the session\'s work against auto-compact (or ' +
    'anything they might otherwise forget), and LIST every path you just saved under .anti-hall/handovers/**; ' +
    '(3) URGE them to run /compact (or /clear) soon, and ASK whether they would like to reach a good ' +
    'stopping point first before they do. ' + BLOAT_SENTENCE + ' ' +
    'This fires once per session at this threshold; you will get brief follow-up reminders as context ' +
    'keeps growing, not a repeat of this whole message.'
  );
}

function buildMilestoneNag(pct) {
  return (
    'CONTEXT NOW ~' + Math.round(pct) + '% (handover already saved earlier this session) — ' +
    BLOAT_SENTENCE + ' Mention /compact or /clear to the user again when convenient.'
  );
}

// buildSoftAdvisory: used ONLY when the estimate's window size is genuinely
// UNKNOWN (windowKnown === false) — an unverified 200k guess is not reliable
// enough to justify the mandatory self-write directive (it could be badly
// wrong on an undetected 1M session), so this is a low-key heads-up instead,
// not a command. Fires once per arm (latch.softFired), same as the mandatory
// directive fires once per arm — never both for the same crossing.
function buildSoftAdvisory(pct) {
  return (
    'Context looks high (~' + Math.round(pct) + '%, ESTIMATED — this session\'s exact context window ' +
    'could not be determined, so treat this as a soft heads-up, not a command). Consider checking with ' +
    'the user about writing a handover and compacting/clearing soon. ' + BLOAT_SENTENCE
  );
}

function buildPauseNag(pct) {
  return (
    'Good stopping point: context is still ~' + Math.round(pct) + '% and a handover is already saved. ' +
    BLOAT_SENTENCE + ' Mention /compact or /clear to the user now.'
  );
}

module.exports = {
  BLOAT_SENTENCE,
  buildFireDirective,
  buildMilestoneNag,
  buildSoftAdvisory,
  buildPauseNag,
};
