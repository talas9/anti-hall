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

// isClaudeConfident(payload, argv, opts) -> bool. POSITIVE evidence that this hook runs under
// Claude Code (cost-trim D3): argv carries `--host=claude` (the flag exists only in the Claude
// hooks.json command, never on Codex) AND the payload is an object with a non-empty string
// session_id AND detectPlatform() is not 'codex' AND transcript_path is CANONICALLY inside
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/. Canonical = realpath of the projects dir vs the
// realpath of the deepest existing ancestor of transcript_path plus its remaining segments (any
// '.', '..' or empty segment rejects; a symlink anywhere on the existing part is resolved first).
// Every failure, including any throw, is "not confident": the caller then sends the full text.
// `opts.env` / `opts.home` are injectable for tests.
function isClaudeConfident(payload, argv, opts) {
  try {
    const fs = require('fs');
    const os = require('os');
    if (!Array.isArray(argv) || !argv.includes('--host=claude')) return false;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (typeof payload.session_id !== 'string' || !payload.session_id) return false;
    if (detectPlatform(payload) === 'codex') return false;
    const tp = payload.transcript_path;
    if (typeof tp !== 'string' || !tp || !path.isAbsolute(tp)) return false;
    const env = (opts && opts.env) || process.env;
    let cfg = env.CLAUDE_CONFIG_DIR;
    if (!cfg) {
      const home = (opts && opts.home) || require('../../companion/lib/test-home-guard.js').resolveHome(undefined, env);
      cfg = path.join(home, '.claude');
    }
    const base = fs.realpathSync.native(path.join(path.resolve(cfg), 'projects'));
    const parsed = path.parse(tp);
    const segs = tp.slice(parsed.root.length).split(path.sep);
    if (segs.some((x) => x === '' || x === '.' || x === '..')) return false;
    // Deepest existing ancestor (lstat so a dangling symlink counts as existing and is rejected below).
    let existing = parsed.root;
    let i = 0;
    for (; i < segs.length; i++) {
      const next = path.join(existing, segs[i]);
      try { fs.lstatSync(next); } catch (_) { break; }
      existing = next;
    }
    const real = fs.realpathSync.native(existing); // throws on a dangling link -> not confident
    const candidate = path.join(real, ...segs.slice(i));
    return candidate.startsWith(base + path.sep);
  } catch (_) {
    return false;
  }
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

// buildFireDirective(result, via, payload, maxTokens)
//   result    : hooks/lib/context-pct.js's reading ({ pct, used, estimated, windowLabel })
//   via       : 'pct' | 'tokens' (hooks/lib/auto-handover-config.js overThreshold())
//   payload   : the hook payload (cwd + session_id -> the expected handover path)
//   maxTokens : the caller's resolved autoHandover.maxTokens ceiling (cfg.maxTokens
//               from resolveEffective()) — only meaningful when via === 'tokens'
//               (that crossing is only reachable when the user opted a ceiling
//               in; maxTokens defaults to 0 = off). Optional for backward
//               compatibility with any caller not yet passing it.
function buildFireDirective(result, via, payload, maxTokens) {
  const pct = result.pct;
  const platform = detectPlatform(payload);
  const w = WORDS[platform];
  const hp = expectedHandoverPath(payload);
  const bm = require('./block-message.js');
  let what;
  if (via === 'tokens') {
    // A token-ceiling fire is only possible when the user explicitly opted into
    // autoHandover.maxTokens (default 0 = off): lead with the ceiling that fired.
    const usedK = Math.round((result.used || 0) / 1000);
    const ceilingK = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens / 1000) : null;
    what = 'context is ~' + usedK + 'K tokens, past your autoHandover.maxTokens ceiling' +
      (ceilingK != null ? ' (' + ceilingK + 'K)' : '') + ': write a handover now.';
  } else {
    let label = '';
    if (result.estimated) {
      label = result.windowLabel === 'inferred-1m'
        ? ' (inferred 1M window: observed usage already exceeded the standard 200k, so this session is estimated against 1,000,000 tokens)'
        : ' (ESTIMATED, assuming a standard 200k window; for a 1M-context session set ANTIHALL_CONTEXT_WINDOW_TOKENS or install the anti-hall statusline for an exact reading)';
    }
    what = 'context is at ~' + Math.round(pct) + '%' + label + ': write a handover now.';
  }
  const step3 = platform === 'codex'
    ? '(3) urge them to run /compact (or /new for a fresh chat) soon (Codex re-points the post-compaction context at the handover through the anti-hall SessionStart hook, source "compact", so a plain `/compact` is enough) and ask '
    : '(3) urge them to compact (or /clear) soon and give them this exact command to paste: `' +
      compactCommand(hp, platform) + '` (substitute the real path if you wrote the handover elsewhere), and ask ';
  return bm.message({
    kind: 'warn',
    guard: 'auto-handover',
    what,
    why: 'It preserves the session\'s work against auto-compact. Do it without asking the user first.',
    instead: '(1) write an anti-hall session handover YOURSELF, following the contract of ' + w.skill +
      ' exactly (self-write mandate: never delegate it to a subagent, which never lived this session; use the Write/Edit tool for every handover file, never a Bash heredoc, since git-guard scans its body as shell)' +
      (hp ? '; by the skill\'s own date/sequence rules its main file is ' + hp : '') +
      '; (2) tell the user it was done and list every path you saved under .anti-hall/handovers/**; ' + step3 +
      'whether they would like to reach a good stopping point first. ' + BLOAT_SENTENCE +
      ' This fires once per session at this threshold; later reminders are brief.',
  });
}

function buildMilestoneNag(pct, payload) {
  const w = WORDS[detectPlatform(payload)];
  return require('./block-message.js').message({
    kind: 'tip',
    guard: 'auto-handover',
    what: 'context is now ~' + Math.round(pct) + '% (handover already saved earlier this session).',
    instead: BLOAT_SENTENCE + ' Mention ' + w.reset + ' to the user again when convenient.',
  });
}

// buildSoftAdvisory: used ONLY when the estimate's window size is genuinely
// UNKNOWN (windowKnown === false) — an unverified 200k guess is not reliable
// enough to justify the mandatory self-write directive (it could be badly
// wrong on an undetected 1M session), so this is a low-key heads-up instead,
// not a command. Fires once per arm (latch.softFired), same as the mandatory
// directive fires once per arm — never both for the same crossing.
function buildSoftAdvisory(pct) {
  return require('./block-message.js').message({
    kind: 'tip',
    guard: 'auto-handover',
    what: 'context looks high (~' + Math.round(pct) + '%, ESTIMATED).',
    why: 'This session\'s exact context window could not be determined, so treat this as a soft heads-up, not a command.',
    instead: 'consider checking with the user about writing a handover and compacting/clearing soon. ' + BLOAT_SENTENCE,
  });
}

// buildDecisiveSuffix(payload, handoverPath, freshness, taskComplete) —
// appended to the Stop-time directive (hooks/auto-handover-pause-nag.js)
// once autoHandover.decisivePrompt is on AND this session's handover file
// exists. Tells the agent to END its reply with one glyph-led, bolded,
// unmissable line naming the exact command:
//   fresh + in-progress task -> 🟢 GOOD POINT TO /compact NOW
//   fresh + handover reads as done -> 🟢 GOOD POINT TO /clear (or /new) NOW
//   stale (work continued since the handover was written) -> refresh now, then
//     the same 🟢 line once saved (say so plainly if the refresh could not be done)
//   unknown (no readable/parseable transcript, e.g. Codex) -> 📝 neutral line
// freshness: true (fresh -> the good-point line) | false (stale -> the
// refresh line) | null (UNKNOWN -> neutral line; never 🟢 on an unprovable
// freshness). taskComplete only matters when fresh.
function buildDecisiveSuffix(payload, handoverPath, freshness, taskComplete) {
  const platform = detectPlatform(payload);
  const clearCmd = platform === 'codex' ? '/new' : '/clear';
  const path = handoverPath || '<the HANDOVER*.md path you saved>';
  if (freshness === false) {
    // Stale: the agent refreshes in THIS turn, so the closing line is the normal
    // good-point line (the fresh case's builder), not a fixed "refresh first"
    // line that would be untrue once the refresh is done.
    return '\n\n⚠️ The saved handover is stale (work continued after it was written): refresh it now. ' +
      'Once it is saved, end your reply to the user with exactly this line, verbatim: ' +
      goodPointLine(path, clearCmd, taskComplete) +
      ' Only if you could not refresh it, say so plainly instead of that line.';
  }
  if (freshness !== true) {
    return '\n\nEnd your reply to the user with exactly this line, verbatim: ' +
      '📝 Handover saved at ' + path + ". If you've continued working since, refresh it; then /compact.";
  }
  return '\n\nEnd your reply to the user with exactly this line, verbatim: ' +
    goodPointLine(path, clearCmd, taskComplete);
}

// goodPointLine(path, clearCmd, taskComplete) — the 🟢 closing line shared by the
// fresh case and (after the in-turn refresh) the stale case.
function goodPointLine(path, clearCmd, taskComplete) {
  if (taskComplete) {
    return '🟢 **GOOD POINT TO ' + clearCmd + ' NOW**: handover saved at ' + path + '. ' +
      'Task looks complete — ' + clearCmd + ' starts fresh; /compact if you want to keep going in this session.';
  }
  return '🟢 **GOOD POINT TO /compact NOW**: handover saved at ' + path + '. ' +
    '/compact keeps working on the same task; ' + clearCmd + ' if the next task is different.';
}

function buildPauseNag(pct, payload) {
  const w = WORDS[detectPlatform(payload)];
  return require('./block-message.js').message({
    kind: 'tip',
    guard: 'auto-handover',
    what: 'good stopping point: context is still ~' + Math.round(pct) + '% and a handover is already saved.',
    instead: BLOAT_SENTENCE + ' Mention ' + w.reset + ' to the user now.',
  });
}

// budgetLabel(budgetPct, max) -> '~5% of the context window (~10K tokens)'.
function budgetLabel(budgetPct, max) {
  const tokK = Number.isFinite(max) && max > 0 ? Math.round((max * budgetPct) / 100 / 1000) : null;
  return '~' + budgetPct + '% of the context window' + (tokK ? ' (~' + tokK + 'K tokens)' : '');
}

// buildGateDirective(result, latch, cfg, payload) — the post-handover
// new-work gate (hooks/lib/auto-handover-gate.js), injected on every prompt
// while armed. The size judgment is the AGENT's own, made before starting.
function buildGateDirective(result, latch, cfg, payload) {
  const platform = detectPlatform(payload);
  const w = WORDS[platform];
  const ask = platform === 'codex'
    ? 'ask the user to choose between two options'
    : 'ask the user with AskUserQuestion (two options)';
  return require('./block-message.js').message({
    kind: 'warn',
    guard: 'auto-handover',
    what: 'post-handover new-work gate (context ~' + Math.round(result.pct) + '%, handover saved at ~' + Math.round(latch.handoverPct) + '%; budget ' + budgetLabel(cfg.gateBudgetPct, result.max) + ').',
    why: 'Before starting this request, judge YOURSELF whether it needs more than that budget.',
    instead: 'if it is bigger than the budget, do not start it; ' + ask + ': (a) add it to the task list and the handover, then start it after ' + w.reset + '; (b) proceed now anyway.',
    allowed: 'a quick question, finishing the in-flight task the handover names, or spawning a DevSwarm workspace (it runs in its own context).',
    override: 'if the user has explicitly insisted on proceeding, proceed',
  });
}

// buildGateBackstop(pct, latch, cfg, payload) — the ONE measured reminder
// per handover baseline once usage grew more than gateBudgetPct points past it.
function buildGateBackstop(pct, latch, cfg, payload) {
  const platform = detectPlatform(payload);
  const w = WORDS[platform];
  return require('./block-message.js').message({
    kind: 'warn',
    guard: 'auto-handover',
    what: 'post-handover budget exceeded: context is ~' + Math.round(pct) + '%, more than ' + cfg.gateBudgetPct + ' points past the ~' + Math.round(latch.handoverPct) + '% at which the handover was saved.',
    instead: 'refresh the handover now (' + w.skill + ': write the next HANDOVER-<n>.md) so it covers the work since, then offer the user to park the rest in the task list + handover and continue after ' + w.reset + '. This reminder fires once per handover.',
  });
}

module.exports = {
  BLOAT_SENTENCE,
  buildGateDirective,
  buildGateBackstop,
  detectPlatform,
  isClaudeConfident,
  buildFireDirective,
  expectedHandoverPath,
  compactCommand,
  buildMilestoneNag,
  buildSoftAdvisory,
  buildPauseNag,
  buildDecisiveSuffix,
};
