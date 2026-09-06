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
//
// MONITOR ADDITION (v0.6x "low-latency wake"): a SECOND, faster wake path layers
// ON TOP of the CronCreate directive above — Claude Code's built-in `Monitor`
// tool, armed with a watcher script (companion/lib/devswarm-wake-watch.js) whose
// every stdout line becomes a transcript event, waking even a fully IDLE session
// with far lower latency than a 5-minute cron tick.
//
// NON-NEGOTIABLE (owner rule — see docs/KB-claude-monitor-tool.md §7 and §9):
// Cron is NEVER disarmed, nor made conditional on Monitor's availability.
// `Monitor` is UNAVAILABLE on Bedrock/Vertex/Microsoft Foundry, whenever
// DISABLE_TELEMETRY or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, in
// non-interactive sessions, and project-scope (`@skills-dir`) plugin installs
// never load plugin monitors at all — none of that is detectable from a hook,
// and a SILENTLY DEAF orchestrator is strictly worse than a redundant poll. So
// both halves ship in the SAME breath, ALWAYS. Do NOT add an
// `if (monitorAvailable)`-style check that suppresses the cron text — that is
// exactly the bug this rule exists to prevent.
//
// `watcher` (new trailing param on wakeDirective/wakeReassert) is the ABSOLUTE
// path to the watch script. Present + non-empty -> the Claude branch emits the
// Monitor-arm instruction IN ADDITION to the cron instruction. Absent/empty ->
// today's cron-only text, byte-identical (fail-open for any caller not yet
// updated to pass it). The non-Claude branch NEVER sees this — Monitor is a
// Claude-only tool.

// WAKE_CRON_DEFAULT — 30 minutes (D13, v0.97.0; was 5 minutes through v0.96.x).
// FIELD MEASUREMENT that drove the change: a child session's mailbox-wake loop
// (5-min cron + `inbox count` + a forced heartbeat on every Stop) produced 1,225
// polling lines / 2.29 MB — about HALF that session's real content — while
// `Monitor` (armed alongside, §7/§9 of docs/KB-claude-monitor-tool.md) delivered
// the actual wakes; the cron ticks were near-100% redundant no-ops. Monitor is
// STILL the primary, low-latency wake path (per-message, ~1s) — this cron is,
// and remains, the NON-NEGOTIABLE fallback for every context where Monitor is
// absent (§9: Bedrock/Vertex/Foundry, DISABLE_TELEMETRY, non-interactive,
// project-scope plugin installs) — see the NON-NEGOTIABLE header below; 30
// minutes is simply a cheaper fallback cadence, not a demotion of cron's role.
// The interval is a real cost: 1-minute = 1,440 wake-turns/day/workspace,
// 5-minute (the old default) = 288, 30-minute = 48. ANTIHALL_DEVSWARM_WAKE_CRON is the one
// knob for machines that want tighter latency and are willing to pay for it.
const WAKE_CRON_DEFAULT = '*/30 * * * *';

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

// drainCmd(cli, isChild) -> the mailbox-drain instruction text for this role.
//
// C1 fix: the pre-fix text unconditionally told the agent to run the FULL
// drain+read sequence on every wake turn — the model's own cron prompt then
// (routinely, per the guard's LIGHT_EXCEPTIONS carve-out for `node …/scripts/
// devswarm.js`) spawns a subagent to run it, even when the mailbox is empty.
// That is a full subagent context spent on a no-op. `inbox count` is a cheap,
// inline, non-mutating read — running it FIRST lets the instruction tell the
// agent to stop (never spawn anything) when there is nothing to do, and only
// pay for a drain/read (optionally delegated) when `unreadTotal > 0`.
//
// Child ordering is deliberately NOT "count, then maybe pull": `inbox count`
// reads only the durable NDJSON + store union — it does NOT see whatever is
// still sitting in the native hivecontrol queue, which `inbox pull` is what
// imports. Gating pull itself behind count would make a native-only backlog
// permanently invisible (count would keep reporting 0 forever, since nothing
// ever pulls it in). `inbox pull` is cheap/inline either way (no subagent
// needed to run it), so it stays unconditional for the child branch; only the
// READ (and any processing of the messages it returns) is gated on count.
// G1 fix (Fix Wave 3, P0): the stop condition used to be `unreadTotal === 0`
// alone. `count` can report `unreadTotal: 0` while ALSO carrying
// `meshGapWithheld: true` (a sibling window whose leading row is a gap
// trigger, so nothing in it counted as delivered YET) — treating that as
// "nothing to do" left the automatic wake loop silently never draining a
// mailbox that genuinely has mail sitting behind the gap. The stop condition
// now requires BOTH `unreadTotal` is 0 AND `meshGapWithheld` is absent/false;
// `meshGapWithheld: true` alone is enough to force the read step, which is
// exactly what makes the corrupt/gap slot get consumed and the ack cursor
// advance past it (scripts/devswarm.js foldSiblingGapRows consumedCount fix).
//
// Wave 4 P1 fix (Round-4 Reviewer, corroborated by a second auditor): the
// child branch used to send `inbox read <id>` on the "otherwise" leg — but
// `inbox read` is a NON-MUTATING peek (devswarm.js cmdInbox `sub === 'read'`,
// ~line 4826: returns lines/meshMessages, never calls ackTo/setCursor). Only
// `inbox ack`/`inbox read-primary` (`inbox messages --unread --ack`) advance
// any cursor. So the child was told to run a verb that structurally CANNOT
// clear a `meshGapWithheld:true` condition — the gate could re-fire forever
// for children, unmet objective for Wave 3.
// Fixed to `inbox read-primary <id>` (cmdInboxMessages with ack:true), NOT a
// bare `inbox ack <id>`, for two independently-verified reasons:
//   1. Precedent/consistency: hooks/devswarm-child-turn.js:305-311 ALREADY
//      prescribes `inbox read-primary <id>` as "the ACTUAL cursor-advancing
//      command" for a child with a mesh-direct-unread condition, explicitly
//      noting `inbox read <id>` does NOT advance any cursor. `inbox read`
//      here was NOT actually the only place in the codebase prescribing the
//      non-acking verb to a child (Fix Wave 5 Item 3 found and fixed two
//      more: hooks/devswarm-child-turn.js's `buildUnreadSegment` and
//      `RECEIVE_NUDGE`, both since routed to `read-primary` too) — but it
//      was still an internal inconsistency here, not a deliberate choice.
//   2. Safety: `read-primary`'s sibling-partition ack target
//      (devswarm.js ~line 4247-4302) uses the EXACT SAME shared fold
//      (foldSiblingGapRows, ~line 1478) and the same
//      `part.cursor + physicalConsumed` derivation as `inbox ack`'s own
//      sibling loop (~line 4931-4940) — `physicalConsumed` is `consumedCount`/
//      `consumedThrough[k-1]`, which by construction excludes every row for
//      which `wasGapSeen` was already true when it was processed (the
//      withheld suffix), so it cannot advance past a real withheld message.
//      `read-primary`'s OWN-channel (NDJSON) ack targets the highest
//      `.index` of a row it actually delivered (`ownDeliveredMaxIndex`,
//      devswarm.js ~line 4218). Plain `inbox ack`'s NDJSON side (no `--to`)
//      used to be a whole-file `advanceCursor()` sweep (marks the ENTIRE
//      current inbox file read, regardless of what this call actually
//      returned) — Fix Wave 5 Item 2 closed that gap too: it now acks only
//      over the same read-time tail snapshot (`union.cursor +
//      union.ndjsonUnreadLines.length`) it delivered, matching
//      `read-primary`'s own invariant. See tests/hooks/devswarm-wake.test.js:210-223
//      and tests/hooks/devswarm-child-role.test.js:178-181 for the regression
//      proof.
// D13 (v0.97.0) addendum: `useTick` (3rd param, default falsy) swaps the
// leading `inbox count`/`inbox pull`+`inbox count` step for the single
// `inbox tick <id>` verb (pull-if-child + count + a liveness marker write, in
// ONE command — devswarm.js's cmdInboxTick). ONLY the two Claude-branch CRON
// PROMPT embeds (wakeDirective's CronCreate prompt, wakeReassert's RE-CREATE
// prompt) pass `true` — the cron tick is what the D13 field measurement (see
// WAKE_CRON_DEFAULT's comment above) was actually about, and the marker it
// writes is what lets devswarm-child-gate.js's Stop hook skip a redundant
// forced heartbeat when the tick already proved liveness with nothing to do.
// Every OTHER caller (turn-native non-Claude instruction text; the 2-arg
// `drainCmd(cli, isChild)` calls this file's own C1/Wave-4 golden tests pin)
// keeps the pre-D13 `inbox count` wording BYTE-IDENTICAL — omitting the 3rd
// arg is exactly the pre-D13 call shape, so nothing here can silently regress
// those tests.
function drainCmd(cli, isChild, useTick) {
  const id = '<DEVSWARM_BUILDER_ID>';
  const stopCond = 'if `unreadTotal` is 0 AND `meshGapWithheld` is NOT `true`';
  if (useTick) {
    const tickCmd = '`node ' + cli + ' inbox tick ' + id + (isChild ? ' --child' : '') + '`';
    const childNote = isChild
      ? ' — this is the cursor-advancing verb, matching devswarm-child-turn.js\'s own ' +
        'mesh-direct instruction; `inbox read` is a non-mutating peek and cannot clear the ' +
        'withheld gap)'
      : ')';
    return 'run ' + tickCmd + ' (with `--child` it first imports anything waiting in your ' +
      'native queue, then reports the SAME `unreadTotal`/`meshGapWithheld` fields `inbox count` ' +
      'does, and writes a liveness marker + refreshes your heartbeat — one command instead of ' +
      'pull+count); ' + stopCond + ', say so and stop — do NOT spawn a subagent; otherwise ' +
      '(either `unreadTotal` is greater than 0, or `meshGapWithheld` is `true`), run `node ' + cli +
      ' inbox read-primary ' + id + '` (delegate to a subagent only if the payload is large' + childNote;
  }
  const countCmd = '`node ' + cli + ' inbox count ' + id + '`';
  if (isChild) {
    return 'first run `node ' + cli + ' inbox pull ' + id + '` (cheap, inline — imports ' +
      'anything waiting in your native queue) then ' + countCmd + '; ' + stopCond + ', ' +
      'say so and stop — do NOT spawn a subagent; otherwise (either `unreadTotal` is greater ' +
      'than 0, or `meshGapWithheld` is `true`), run `node ' + cli + ' inbox read-primary ' + id +
      '` (delegate to a subagent only if the payload is large — this is the cursor-advancing ' +
      'verb, matching devswarm-child-turn.js\'s own mesh-direct instruction; `inbox read` is a ' +
      'non-mutating peek and cannot clear the withheld gap)';
  }
  return 'first run ' + countCmd + '; ' + stopCond + ', say so and stop — do NOT spawn a ' +
    'subagent; otherwise (either `unreadTotal` is greater than 0, or `meshGapWithheld` is ' +
    '`true`), run `node ' + cli + ' inbox read-primary ' + id +
    '` (delegate to a subagent only if the payload is large)';
}

// monitorArmLine(watcher) -> the Monitor-arm addition to the Claude-branch wake
// text, or '' when no watcher path is supplied (fail-open: a caller not yet
// updated to pass `watcher` keeps getting exactly today's cron-only text).
//
// SANITIZATION CONCLUSION: `watcher` is NOT run through any charset/backtick
// guard the way CRON_FIELD gates ANTIHALL_DEVSWARM_WAKE_CRON above, and that is
// deliberate rather than an oversight. CRON_FIELD exists because the cron env
// var is UNTRUSTED input (operator/machine-supplied, reflected verbatim). Every
// caller of `watcher`, by contrast, computes it as
// `path.join(__dirname, '..', 'companion', 'lib', 'devswarm-wake-watch.js')` —
// derived solely from the HOOK'S OWN on-disk install location, never from an
// env var, CLI flag, or any other attacker-reachable input. There is no path by
// which a prompt-injection payload could substitute a crafted string for this
// parameter, so gating it would be theatre with no attacker it defends against.
function monitorArmLine(watcher) {
  if (typeof watcher !== 'string' || !watcher) return '';
  return ' ALSO arm the `Monitor` tool as your PRIMARY wake path (Cron above is the 30-minute ' +
    'FALLBACK — it still fires independently; Monitor is IN ADDITION, never instead): first ' +
    'check whether a mailbox-wake Monitor is already armed so you never arm a second one ' +
    '(double-arming causes duplicate wakes; the watcher script also self-guards with a lock, ' +
    'but do not rely on that alone). If none is armed, call `Monitor` with command `node ' +
    watcher + '`, `persistent: true`, and a description like "devswarm mailbox wake watcher" — ' +
    'every line it prints on stdout becomes a transcript event, waking this session even while ' +
    'fully idle, with far lower latency than the cron tick above. A first line starting ' +
    '`[wake-watch] REFUSED TO ARM` means you do NOT have this coverage — do not assume ' +
    'you do; the cron job above is still your only wake path.';
}

// wakeDirective(env, isChild, cli, watcher) -> the SessionStart directive text
// (leading space, appended to the COMMUNICATION OVERRIDE), or '' when the agent
// is unknown. `cli` MUST be the ABSOLUTE path to scripts/devswarm.js — a
// workspace's cwd is its PROJECT WORKTREE, never the plugin root, so a relative
// path is unrunnable there. `watcher`, when a non-empty string, is the ABSOLUTE
// path to the Monitor watch script; the Claude branch then emits the Monitor-arm
// instruction IN ADDITION to the cron instruction (never instead — see the
// NON-NEGOTIABLE header comment above). Absent/empty `watcher` -> cron-only,
// byte-identical to pre-Monitor behavior.
function wakeDirective(env, isChild, cli, watcher) {
  try {
    const agent = agentName(env);
    if (!agent) return ''; // unknown agent -> say nothing rather than guess
    if (agent !== 'claude') {
      // Never names the Claude idle-cron tool: an agent that does not have it must
      // not be handed the tool's name at all (a named tool is an invitation to call
      // a hallucinated one). It gets the honest instruction it CAN actually follow.
      // NEVER touch this branch for Monitor: Monitor is ALSO a Claude-only tool, so
      // it belongs strictly in the `claude` branch below, same as CronCreate.
      // No `useTick` here (2-arg call): this text is a TURN-NATIVE instruction, not
      // a cron prompt (Codex has no CronCreate) — pre-D13 wording, byte-identical.
      const drain = drainCmd(cli, isChild);
      return ' MAILBOX WAKE: this workspace runs `' + agent + '`, which has NO idle-wake ' +
        'primitive — once you go idle, nothing can wake you, so a message that lands after ' +
        'you stop waits for your next turn. Drain your mailbox at the START of every turn ' +
        'and again BEFORE you stop: ' + drain + '.';
    }
    // useTick:true — this `drain` text becomes the BODY of the CronCreate prompt
    // below (a cron tick, not a turn-native instruction), so it gets the D13
    // `inbox tick` verb (pull-if-child + count + marker write, one command).
    const drain = drainCmd(cli, isChild, true);
    return ' MAILBOX WAKE (do this NOW, on your FIRST turn): call `CronList`; if your mailbox-' +
      'wake job is ABSENT — never created, or auto-expired (recurring tasks self-delete 7 days ' +
      'after creation) — call `CronCreate` with schedule `' + wakeCron(env) + '` and a prompt ' +
      'that runs ' + drain + ' and acts on anything unread. If the job is already listed, do ' +
      'nothing — never create a second one. Cron jobs fire while this session is IDLE (each ' +
      'tick is a full turn) — this cron is now a 30-MINUTE FALLBACK cadence (cheaper than the ' +
      'pre-D13 5-minute default), NEVER disarmed — it is the only thing that will wake you to ' +
      'drain your mailbox once you go idle; a message that lands after you stop is otherwise ' +
      'never seen.' +
      monitorArmLine(watcher);
  } catch (_) {
    return ''; // fail-open: a broken directive must never break SessionStart
  }
}

// wakeReassert(env, cli, isChild, watcher) -> the Stop-gate RE-VERIFY text
// (leading space). Worded as a CronList re-verify, never a bare "create it": a
// job created >7 days ago has since self-deleted (contract clause 3 above), so
// the Stop gate is also the RENEWAL path — it costs nothing extra, and it is why
// anti-hall needs no 7-day timer of its own. Claude-only by construction
// (callers gate on isClaudeAgent) — a Codex workspace has no job to create, so
// it is never nagged. `isChild` selects the role-correct drain verb (default
// true = child pull->read, matching this function's original child-gate caller;
// devswarm-parent-gate.js passes false for the Primary's read-primary verb).
// `watcher`, when a non-empty string, is the ABSOLUTE path to the Monitor watch
// script; adds the Monitor re-verify/arm line IN ADDITION to the cron re-verify
// (never instead — see the NON-NEGOTIABLE header comment above). Absent/empty
// `watcher` -> cron-only, byte-identical to pre-Monitor behavior.
function wakeReassert(env, cli, isChild, watcher) {
  try {
    const child = isChild === undefined ? true : !!isChild;
    // useTick:true — same reasoning as wakeDirective's Claude branch above: this
    // `drainCmd` output becomes the RE-CREATED CronCreate prompt's body, a cron
    // tick, so it gets the D13 `inbox tick` verb, not turn-native `inbox count`.
    return ' MAILBOX WAKE — before you stop, VERIFY your self-wake cron job: call `CronList`. ' +
      'If your mailbox-wake job is GONE (never created, or auto-expired — recurring tasks ' +
      'self-delete 7 days after creation), RE-CREATE it now with `CronCreate`, schedule `' +
      wakeCron(env) + '`, prompt runs ' + drainCmd(cli, child, true) + ' and acts on anything unread. ' +
      'Cron jobs fire while this session is IDLE — without one, any message that arrives after ' +
      'you stop is never seen. If `CronList` already shows it, just say so and stop (this ' +
      'reminder is capped and stops on its own).' +
      monitorArmLine(watcher);
  } catch (_) {
    return '';
  }
}

module.exports = { WAKE_CRON_DEFAULT, wakeCron, isClaudeAgent, wakeDirective, wakeReassert, drainCmd };
