// anti-hall :: auto-handover-text — every message the auto-handover feature
// emits (fire directive, milestone nag, soft advisory, natural-pause nag),
// shared by hooks/auto-handover.js (UserPromptSubmit) and
// hooks/auto-handover-pause-nag.js (Stop: pause nag + the once-only Stop-side
// fire for long autonomous turns that never pass UserPromptSubmit).
//
// PLATFORM-AWARE: the same hook files run on Claude Code and on the Codex
// port (codex/hooks/hooks.json), so every message names the right skill and
// the right session commands for the platform that sent the payload
// (detectPlatform() below).
//
// Pure Node built-ins only.

'use strict';

const path = require('path');
const find = require('./handover-find.js');

// detectPlatform(payload) -> 'codex' | 'claude'. Codex-only payload facts
// (official Codex hooks reference, https://learn.chatgpt.com/docs/hooks):
// turn-scoped events (UserPromptSubmit, Stop, PreCompact) carry `turn_id`;
// Claude Code carries `turn_id` only on MessageDisplay
// (https://code.claude.com/docs/en/hooks). A Codex `transcript_path` is a
// rollout file (rollout-*.jsonl under ~/.codex/sessions — the same files
// hooks/lib/context-pct.js parses), which also covers SessionStart, where
// Codex sends no turn_id.
function detectPlatform(payload) {
  if (!payload || typeof payload !== 'object') return 'claude';
  if (typeof payload.turn_id === 'string' && payload.turn_id) return 'codex';
  const tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (/(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(tp) || /[\\/]\.codex[\\/]/.test(tp)) return 'codex';
  return 'claude';
}

// Per-platform wording. Claude Code: /anti-hall:handover skill, /compact
// (free-text focus documented) or /clear. Codex CLI slash commands
// (https://learn.chatgpt.com/docs/developer-commands?surface=cli): /compact
// (no focus argument documented), /new or /clear for a fresh chat, /skills
// to pick a skill; the plugin's skill is named anti-hall-handover.
const WORDS = {
  claude: { skill: 'the /anti-hall:handover skill', reset: '/compact or /clear' },
  codex: { skill: 'the anti-hall-handover skill (pick it with /skills if it is not already loaded)', reset: '/compact or /new' },
};

// One short, non-alarmist sentence shared by every message this feature
// emits (fire directive, milestone nag, and the Stop-time pause nag) — the
// reason to compact/clear isn't only "you'll hit the limit soon".
const BLOAT_SENTENCE =
  'As context grows the model gets less efficient and more prone to hallucination, ' +
  'so compacting/clearing keeps answers accurate, not just under the limit.';

// expectedHandoverPath(payload) -> the repo-relative path the handover skill
// will write next for this session ('.anti-hall/handovers/<today>/<sid>/
// HANDOVER[-N].md'), by the skill's own date + sequencing rules; null
// without a cwd.
function expectedHandoverPath(payload) {
  const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!cwd) return null;
  const date = find.localDate();
  const sid = find.sanitizeSessionId(payload.session_id);
  const name = find.nextHandoverName(path.join(find.handoversRoot(cwd), date, sid));
  return ['.anti-hall', 'handovers', date, sid, name].join('/');
}

// compactCommand(handoverPath) -> the exact /compact line for the user.
// Claude Code documents free-text focus after /compact ("/compact focus on
// the API changes" — https://code.claude.com/docs/en/how-claude-code-works).
function compactCommand(handoverPath, platform) {
  if (platform === 'codex') return '/compact';
  return '/compact focus: continuation state is in ' + (handoverPath || '<the HANDOVER*.md path you wrote>') +
    '; keep pending tasks, the user\'s session rules, and unverified items';
}

// buildFireDirective(result, via, payload)
//   result : hooks/lib/context-pct.js's reading ({ pct, used, estimated, windowLabel })
//   via    : 'pct' | 'tokens' (hooks/lib/auto-handover-config.js overThreshold())
//   payload: the hook payload (cwd + session_id -> the expected handover path)
function buildFireDirective(result, via, payload) {
  const pct = result.pct;
  const platform = detectPlatform(payload);
  const w = WORDS[platform];
  let label = '';
  if (via === 'tokens') {
    label = ' (~' + Math.round((result.used || 0) / 1000) + 'K tokens — over the absolute autoHandover.maxTokens ' +
      'ceiling; long contexts degrade with length, not just near the window limit)';
  } else if (result.estimated) {
    label = result.windowLabel === 'inferred-1m'
      ? ' (inferred 1M window — observed usage already exceeded the standard 200k, so this session is estimated against a 1,000,000-token window)'
      : ' (ESTIMATED — assuming a standard 200k context window; if this is a 1M-context session, set ANTIHALL_CONTEXT_WINDOW_TOKENS or install the anti-hall statusline for an exact reading)';
  }
  const hp = expectedHandoverPath(payload);
  return (
    'CONTEXT AT ~' + Math.round(pct) + '%' + label + ' — AUTO-HANDOVER REQUIRED. Without asking the user first: ' +
    '(1) immediately WRITE an anti-hall session handover YOURSELF, following the contract of ' + w.skill + ' ' +
    'exactly (self-write mandate — never delegate this to a subagent; it never lived ' +
    'this session and would lose decision/trial fidelity)' +
    (hp ? '; by the skill\'s own date/sequence rules its main file is ' + hp : '') + '; ' +
    '(2) then TELL the user this was done, to preserve the session\'s work against auto-compact (or ' +
    'anything they might otherwise forget), and LIST every path you just saved under .anti-hall/handovers/**; ' +
    (platform === 'codex'
      ? '(3) URGE them to run /compact (or /new for a fresh chat) soon — Codex re-points the ' +
        'post-compaction context at the handover through the anti-hall SessionStart hook (source ' +
        '"compact"), so a plain `/compact` is enough — and ASK '
      : '(3) URGE them to compact (or /clear) soon and give them this exact command to paste: `' +
        compactCommand(hp, platform) + '` (substitute the real path if you wrote the handover elsewhere), and ASK ') +
    'whether they would like to reach a good stopping point first before they do. ' + BLOAT_SENTENCE + ' ' +
    'This fires once per session at this threshold; you will get brief follow-up reminders as context ' +
    'keeps growing, not a repeat of this whole message.'
  );
}

function buildMilestoneNag(pct, payload) {
  const w = WORDS[detectPlatform(payload)];
  return (
    'CONTEXT NOW ~' + Math.round(pct) + '% (handover already saved earlier this session) — ' +
    BLOAT_SENTENCE + ' Mention ' + w.reset + ' to the user again when convenient.'
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

function buildPauseNag(pct, payload) {
  const w = WORDS[detectPlatform(payload)];
  return (
    'Good stopping point: context is still ~' + Math.round(pct) + '% and a handover is already saved. ' +
    BLOAT_SENTENCE + ' Mention ' + w.reset + ' to the user now.'
  );
}

module.exports = {
  BLOAT_SENTENCE,
  detectPlatform,
  buildFireDirective,
  expectedHandoverPath,
  compactCommand,
  buildMilestoneNag,
  buildSoftAdvisory,
  buildPauseNag,
};
