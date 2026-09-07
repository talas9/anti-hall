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
  // known-guard (Wave F1, P0): a store-unavailable `count`/`tick` reports
  // `known: false` alongside a numeric `unreadTotal` (often 0 — the NDJSON
  // side alone) — see devswarm.js cmdInbox 'count'/'read' (`known: union.known
  // && !storeUnavailable`). Treating that as "nothing to do" silently stops
  // the drain loop on a store the caller could not actually read. The stop
  // condition now ALSO requires `known` is not `false` (absent/true both
  // count as known, matching every existing caller that never emits `known`
  // at all — e.g. an older `count` shape — so this is additive, never a
  // regression on a caller that already worked).
  const stopCond = 'if `unreadTotal` is 0 AND `meshGapWithheld` is NOT `true` AND `known` is NOT `false`';
  const otherwise = 'either `unreadTotal` is greater than 0, or `meshGapWithheld` is `true`, or `known` is `false`';
  // fl-wave5 fix (item 4), broadened fl-wave6 (item 2, P1): the final
  // `inbox read-primary` step this prose sends the agent to run can REFUSE
  // with `ok:false` for ANY reason — not just the literal `store-unavailable`
  // bucket. `resolveWorkspaceStoreForRead` (scripts/devswarm.js) also refuses
  // with `project-context-mismatch`, `unregistered-workspace`, or an
  // ownership-mismatch reason, each carrying its own `reason` (and,
  // depending on the refusal, `storeUnavailableReason`/
  // `storeUnavailableDetail`) — pre-fix, this clause only fired its terminal
  // branch when `reason` was exactly `store-unavailable`, so every OTHER
  // `ok:false` refusal fell through this prose with no guidance at all,
  // leaving the agent free to loop (re-running the same doomed command) or
  // spawn a subagent over a refusal no subagent can resolve. Terminal
  // branch now fires on ANY `ok:false`: report the reason (and
  // `storeUnavailableReason`/`storeUnavailableDetail` when present) in one
  // line and stop.
  const storeUnavailableClause = ' — if that reports `ok:false`, '
    + 'report the `reason` (and `storeUnavailableReason`/`storeUnavailableDetail` when present) '
    + 'in one line and stop (do not loop, do not spawn a subagent)';
  if (useTick) {
    const tickCmd = '`node ' + cli + ' inbox tick ' + id + (isChild ? ' --child' : '') + '`';
    const childNote = isChild
      ? ' — this is the cursor-advancing verb, matching devswarm-child-turn.js\'s own ' +
        'mesh-direct instruction; `inbox read` is a non-mutating peek and cannot clear the ' +
        'withheld gap)'
      : ')';
    return 'run ' + tickCmd + ' (with `--child` it first imports anything waiting in your ' +
      'native queue, then reports the SAME `unreadTotal`/`meshGapWithheld`/`known` fields ' +
      '`inbox count` does, and writes a liveness marker + refreshes your heartbeat — one ' +
      'command instead of pull+count); ' + stopCond + ', say so and stop — do NOT spawn a ' +
      'subagent; otherwise (' + otherwise + '), run `node ' + cli +
      ' inbox read-primary ' + id + '` (delegate to a subagent only if the payload is large' + childNote + storeUnavailableClause;
  }
  const countCmd = '`node ' + cli + ' inbox count ' + id + '`';
  if (isChild) {
    return 'first run `node ' + cli + ' inbox pull ' + id + '` (cheap, inline — imports ' +
      'anything waiting in your native queue) then ' + countCmd + '; ' + stopCond + ', ' +
      'say so and stop — do NOT spawn a subagent; otherwise (' + otherwise + '), run `node ' +
      cli + ' inbox read-primary ' + id +
      '` (delegate to a subagent only if the payload is large — this is the cursor-advancing ' +
      'verb, matching devswarm-child-turn.js\'s own mesh-direct instruction; `inbox read` is a ' +
      'non-mutating peek and cannot clear the withheld gap)' + storeUnavailableClause;
  }
  return 'first run ' + countCmd + '; ' + stopCond + ', say so and stop — do NOT spawn a ' +
    'subagent; otherwise (' + otherwise + '), run `node ' + cli + ' inbox read-primary ' + id +
    '` (delegate to a subagent only if the payload is large)' + storeUnavailableClause;
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
// (leading space), TRIMMED (C, hook-injection-byte-budget follow-up): the
// pre-trim version re-stated the FULL CronCreate prompt body inline on every
// Stop-gate firing — the same paragraph SessionStart's wakeDirective() already
// delivered once, repeated verbatim on every forced-ack block for the life of
// the session. Now a POINTER: name the two conditions CronList/Monitor must
// satisfy, and if either is missing, send the agent back to re-run
// `wake-directive <id>` (scripts/devswarm.js's on-demand reprint of the FULL
// SessionStart text, cmdWakeDirective — see that function's own header) rather
// than re-inline the whole prompt here. The contract is on the FIXED text
// only — everything except the one embedded CLI path — capped at 360 chars
// (fl-wave6 fix, item 5: raised from 320 — backslash escapes in the emitted
// text count toward the measured length too, and the real fixed-text length
// already peaked at 315/320, a 5-char headroom too thin to safely add or
// reword any clause without tripping the cap; 360 restores real headroom
// without trimming any existing wording)
// (see tests/hooks/devswarm-wake.test.js's own length assertion, which
// computes fixed length as output.length minus the literal cli length): the
// path itself is caller-controlled (a real install path) and cannot be
// bounded by this function, so a flat "total output <= N" cap either failed
// to catch a real-world budget blowout (a short fixture path hid it) or was
// unmeetable for a genuinely long install path through no fault of this
// text. A Stop-gate reason competes with every other line in that same forced-ack block for the
// hook-injection budget.
//
// Still worded as a VERIFY, never a bare "create it": a job created >7 days
// ago has since self-deleted (contract clause 3 above), so the Stop gate is
// also the RENEWAL path. Claude-only by construction (callers gate on
// isClaudeAgent) — a Codex workspace has no job to create, so it is never
// nagged. `isChild` selects the role-correct drain verb suffix (` --child`)
// so the pointed-at `inbox tick` command matches what THIS caller would
// actually need to run. `watcher`, when a non-empty string, is the ABSOLUTE
// path to the Monitor watch script; adds the Monitor re-verify condition IN
// ADDITION to the cron condition (never instead — see the NON-NEGOTIABLE
// header comment above). Absent/empty `watcher` -> the Monitor clause is
// omitted entirely (fail-open for a caller not yet passing it), matching
// wakeDirective's own contract for an omitted watcher.
function wakeReassert(env, cli, isChild, watcher) {
  try {
    const child = isChild === undefined ? true : !!isChild;
    const id = '<DEVSWARM_BUILDER_ID>';
    // fl-wave3 fix (item 3): `cli` — the ABSOLUTE plugin path, realistically
    // 80-100+ chars once installed from the plugin cache (e.g.
    // `/Users/x/.claude/plugins/cache/anti-hall/anti-hall/0.98.0/scripts/devswarm.js`)
    // — used to be embedded 3 TIMES in this one short pointer (twice in the
    // `node <cli> ...` commands below, once more via `tickCmd`'s own
    // interpolation), blowing well past the 400-char contract this function
    // is capped at (see the header comment above + tests/hooks/
    // devswarm-wake.test.js's LENGTH CAP test) for any real install path,
    // not just the short fixture paths this suite happened to use pre-fix.
    // Emit it ONCE, up front, as a `CLI=` assignment the agent can literally
    // run as a shell variable — every later reference is the short `"$CLI"`
    // token instead of the long literal path.
    //
    // fl-wave4 fix (item 1): `watcher` (the WATCHER const both callers derive
    // via __dirname — hooks/devswarm-parent-gate.js and
    // hooks/devswarm-child-gate.js's own header comments) was STILL
    // interpolated here VERBATIM, undoing the exact same budget fix the `cli`
    // literal got above for any real (deeply-nested plugin-cache) install
    // path. Both consts resolve from the SAME plugin root — CLI is
    // `<root>/scripts/devswarm.js`, WATCHER is
    // `<root>/companion/lib/devswarm-wake-watch.js` — so WATCHER's absolute
    // path is always exactly `$(dirname "$CLI")/../companion/lib/devswarm-wake-watch.js`.
    // Emitting that DERIVATION (relative to the already-emitted `$CLI`)
    // instead of a second long literal keeps this pointer well under the
    // 400-char cap regardless of `watcher`'s own literal length. `watcher`
    // itself is used ONLY as a presence gate now (non-null/non-empty ->
    // include the Monitor clause; falsy -> omit it entirely, unchanged
    // fail-open contract for a caller not yet passing it).
    const tickCmd = '`node "$CLI" inbox tick ' + id + (child ? ' --child' : '') + '`';
    let w = '';
    try {
      if (watcher) {
        w = '; `WATCH="$(dirname "$CLI")/../companion/lib/devswarm-wake-watch.js"`, `Monitor` on `node "$WATCH"` armed (never two)';
      }
    } catch (_) { w = ''; }
    const cliStr = cli ? String(cli) : '<unset>';
    // fl-wave5 fix (item 3): this pointer tells the agent to run `CLI=...`
    // literally as a shell assignment (see the tickCmd/`$CLI` usage below) —
    // but the pre-fix text wrapped the path in BACKTICKS (`CLI=\`<path>\``),
    // which in an actual shell means COMMAND SUBSTITUTION, not a literal
    // string. An agent that took the instruction literally would have
    // EXECUTED the path as a command instead of assigning it. Double-quote
    // it instead — the correct, directly-runnable shell assignment shape —
    // with the path's own `"`/`\`/`` ` ``/`$` escaped so an unusual install
    // path (spaces are already safe inside double quotes) can never break
    // out of the quoting.
    const cliQuoted = '"' + cliStr.replace(/(["\\$`])/g, '\\$1') + '"';
    return ' MAILBOX WAKE CHECK (CLI=' + cliQuoted + '): CronList must show `' + wakeCron(env) + '` running '
      + tickCmd + w + '. If missing, re-run `node "$CLI" wake-directive ' + id + '`.';
  } catch (_) {
    return '';
  }
}

module.exports = { WAKE_CRON_DEFAULT, wakeCron, isClaudeAgent, wakeDirective, wakeReassert, drainCmd };
