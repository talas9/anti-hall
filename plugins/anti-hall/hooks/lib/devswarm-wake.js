'use strict';
// anti-hall :: devswarm-wake — the DevSwarm IDLE SELF-WAKE directive (shared text).
//
// THE PROBLEM: a DevSwarm workspace that finishes its turn goes IDLE, and NOTHING
// wakes an idle Claude Code session — a mesh message landing after that point sits
// unread forever. Verified dead ends: channels do not wake an idle session
// (anthropics/claude-code#44380); an agent-started `/loop` does not fire while
// idle; hivecontrol cannot inject into the session's pty.
//
// THE FIX: `CronCreate` — a Claude Code tool whose jobs fire while the REPL is
// IDLE. It is a TOOL, so only the AGENT can call it (a hook is a plain Node
// process with no tool access). So this is a DIRECTIVE, not a mechanism:
// devswarm-child-role.js (SessionStart) tells the workspace agent to CronList-
// check then CronCreate the job itself; devswarm-child-gate.js (Stop) re-asserts
// the same text, bounded by ITS OWN EXISTING forced-ack cap (no new state).
// Recurring cron tasks self-delete 7 days after creation, which is exactly why
// both directives say "check CronList, (re-)create if absent" rather than a bare
// one-shot create — that check is also the renewal, so nothing else needs to
// track the 7-day window.
//
// AGENT-CORRECTNESS: `CronCreate` is a CLAUDE tool. DEVSWARM_AI_AGENT names the
// active agent (`claude`/`codex`/… — KB-devswarm-hivecontrol.md §6). A non-Claude
// workspace must never be told to call a tool it does not have, so it gets the
// honest equivalent instead (drain every turn); an unknown agent (var absent)
// gets nothing — we do not guess which agent we are talking to.
//
// Pure Node built-ins. Never throws to the caller (fail-open = empty directive).

// WAKE_CRON_DEFAULT — 5 minutes. The interval is a real cost: 1-minute = 1,440
// wake-turns/day/workspace, 5-minute = 288. ANTIHALL_DEVSWARM_WAKE_CRON is the one
// knob for machines that want tighter latency and are willing to pay for it.
const WAKE_CRON_DEFAULT = '*/5 * * * *';

// CRON_FIELD — the ONLY characters a cron field may contain. This is a PROMPT-
// INJECTION boundary, not cosmetics: ANTIHALL_DEVSWARM_WAKE_CRON is untrusted
// input that is reflected VERBATIM into model-visible text, inside a backtick code
// span. An arity check alone lets `*/5 * * * *`IGNORE_PREVIOUS_INSTRUCTIONS:`
// through — the backtick CLOSES the span and the rest lands on the model as
// instructions. Restricting every field to `0-9 * / , -` makes a backtick, quote,
// newline or letter unrepresentable. Deliberately NOT a cron parser (ranges/steps
// are not semantically validated — a bad-but-well-formed value is the user's own
// cron job to fix); this only guarantees nothing but cron syntax can be emitted.
const CRON_FIELD = /^[0-9*/,-]+$/;

// wakeCron(env) -> cron expression string. Honors ANTIHALL_DEVSWARM_WAKE_CRON when
// it is exactly 5 whitespace-separated fields AND every field is cron-charset-clean;
// anything else (garbage, injection payload, wrong arity, empty, non-string) falls
// back to WAKE_CRON_DEFAULT. Returns the RE-JOINED fields, never the raw string, so
// an interior newline (5 fields split across lines) cannot survive into the output.
// Never throws.
function wakeCron(env) {
  try {
    const raw = (env || process.env).ANTIHALL_DEVSWARM_WAKE_CRON;
    if (typeof raw !== 'string') return WAKE_CRON_DEFAULT;
    const expr = raw.trim();
    if (!expr) return WAKE_CRON_DEFAULT;
    const fields = expr.split(/\s+/);
    if (fields.length !== 5) return WAKE_CRON_DEFAULT;
    if (!fields.every((f) => CRON_FIELD.test(f))) return WAKE_CRON_DEFAULT;
    return fields.join(' ');
  } catch (_) {
    return WAKE_CRON_DEFAULT; // fail-open = the safe default, never a crash
  }
}

// agentName(env) -> lowercased DEVSWARM_AI_AGENT, or '' when absent/unknown.
function agentName(env) {
  try {
    const v = (env || process.env).DEVSWARM_AI_AGENT;
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

// isClaudeAgent(env) -> boolean. TRUE only when hivecontrol explicitly names this
// workspace's agent as `claude` — the only agent that HAS the CronCreate tool.
// Fail-open = false (never tell a non-Claude/unknown agent to call a Claude tool).
function isClaudeAgent(env) {
  return agentName(env) === 'claude';
}

// drainCmd(cli, isChild) -> the mailbox-drain command text for this role. A child
// pulls its native queue into the durable inbox first, then reads it (the same
// pull->read sequence devswarm-child-gate.js already instructs); a Primary uses the
// read-primary verb (read + ack in one).
function drainCmd(cli, isChild) {
  return isChild
    ? '`node ' + cli + ' inbox pull <DEVSWARM_BUILDER_ID>` then `node ' + cli +
      ' inbox read <DEVSWARM_BUILDER_ID>`'
    : '`node ' + cli + ' inbox read-primary <DEVSWARM_BUILDER_ID>`';
}

// wakeDirective(env, isChild, cli) -> the SessionStart directive text (leading
// space, appended to the COMMUNICATION OVERRIDE), or '' when the agent is unknown.
// `cli` MUST be the ABSOLUTE path to scripts/devswarm.js — a workspace's cwd is its
// PROJECT WORKTREE, never the plugin root, so a relative path is unrunnable there.
function wakeDirective(env, isChild, cli) {
  try {
    const agent = agentName(env);
    if (!agent) return ''; // unknown agent -> say nothing rather than guess
    const drain = drainCmd(cli, isChild);
    if (agent !== 'claude') {
      // Never names the Claude idle-cron tool: an agent that does not have it must
      // not be handed the tool's name at all (a named tool is an invitation to call
      // a hallucinated one). It gets the honest instruction it CAN actually follow.
      return ' MAILBOX WAKE: this workspace runs `' + agent + '`, which has NO idle-wake ' +
        'primitive — once you go idle, nothing can wake you, so a message that lands after ' +
        'you stop waits for your next turn. Drain your mailbox at the START of every turn ' +
        'and again BEFORE you stop: ' + drain + '.';
    }
    return ' MAILBOX WAKE (do this NOW, on your FIRST turn): call `CronList`; if your mailbox-' +
      'wake job is ABSENT — never created, or auto-expired (recurring tasks self-delete 7 days ' +
      'after creation) — call `CronCreate` with schedule `' + wakeCron(env) + '` and a prompt ' +
      'that runs ' + drain + ' and acts on anything unread. If the job is already listed, do ' +
      'nothing — never create a second one. Cron jobs fire while this session is IDLE (each ' +
      'tick is a full turn) — this is the ONLY thing that will wake you to drain your mailbox ' +
      'once you go idle; a message that lands after you stop is otherwise never seen.';
  } catch (_) {
    return ''; // fail-open: a broken directive must never break SessionStart
  }
}

// wakeReassert(env, cli, isChild) -> the Stop-gate RE-VERIFY text (leading space).
// Worded as a CronList re-verify, never a bare "create it": a job created >7 days
// ago has since self-deleted (contract clause 3 above), so the Stop gate is also
// the RENEWAL path — it costs nothing extra, and it is why anti-hall needs no
// 7-day timer of its own. Claude-only by construction (callers gate on
// isClaudeAgent) — a Codex workspace has no job to create, so it is never nagged.
// `isChild` selects the role-correct drain verb (default true = child pull->read,
// matching this function's original child-gate caller; devswarm-parent-gate.js
// passes false for the Primary's read-primary verb).
function wakeReassert(env, cli, isChild) {
  try {
    const child = isChild === undefined ? true : !!isChild;
    return ' MAILBOX WAKE — before you stop, VERIFY your self-wake cron job: call `CronList`. ' +
      'If your mailbox-wake job is GONE (never created, or auto-expired — recurring tasks ' +
      'self-delete 7 days after creation), RE-CREATE it now with `CronCreate`, schedule `' +
      wakeCron(env) + '`, prompt runs ' + drainCmd(cli, child) + ' and acts on anything unread. ' +
      'Cron jobs fire while this session is IDLE — without one, any message that arrives after ' +
      'you stop is never seen. If `CronList` already shows it, just say so and stop (this ' +
      'reminder is capped and stops on its own).';
  } catch (_) {
    return '';
  }
}

module.exports = { WAKE_CRON_DEFAULT, wakeCron, isClaudeAgent, wakeDirective, wakeReassert };
