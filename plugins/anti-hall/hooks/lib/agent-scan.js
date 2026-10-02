'use strict';
// anti-hall :: agent-scan — THIS SESSION's background-agent lifecycle, read
// from the transcript (launch tool_result "Async agent launched successfully"
// + agentId, terminal <task-notification> in any of its three shapes).
// Extracted verbatim from silent-agent-nudge.js so task-guard / task-tracker
// share ONE parser instead of a drifting copy (see notificationTexts note
// below). Session-scoped by construction: only this transcript is read — unlike
// the global ~/.anti-hall/agents/recent-spawn.json heartbeat, which any spawn in
// ANY session/project refreshes.

// Transcript notification statuses that mean the agent has actually ended
// (observed values: completed/failed/stopped; killed/cancelled/canceled are
// terminal too), case-insensitive.
const TERMINAL_NOTIFICATION_STATUS = /^(completed|failed|stopped|killed|cancelled|canceled)$/i;

// extractTexts(node) -> string[] — recursively collect every string leaf
// under a message `content` value, which the harness renders in more than
// one shape across transcript lines: a bare string, an array of
// {type:'text', text} blocks, or a tool_result whose own `content` is either
// of those. Bounded by the caller's tail-read size, not here.
function extractTexts(node) {
  const out = [];
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) out.push(...extractTexts(item));
    return out;
  }
  if (node && typeof node === 'object') {
    if (typeof node.text === 'string') out.push(node.text);
    if (node.content !== undefined) out.push(...extractTexts(node.content));
  }
  return out;
}

// Does a tool_use input name this agent — by full id, or by a >=7-hex prefix
// that matches exactly one launched id (SendMessage/TaskOutput accept prefixes).
function namesAgent(input, id, launched) {
  const s = JSON.stringify(input || {});
  if (s.indexOf(id) !== -1) return true;
  for (const m of s.matchAll(/[0-9a-fA-F]{7,40}/g)) {
    if (!id.startsWith(m[0])) continue;
    let n = 0;
    for (const k of launched.keys()) if (k.startsWith(m[0])) n++;
    if (n === 1) return true;
  }
  return false;
}
// Calls whose tool_result can be a launch / a resume / delivery of an agent's result.
const LAUNCH_TOOLS = new Set(['Agent', 'Task']);
const RESUME_TOOLS = new Set(['SendMessage', 'Agent', 'Task']);
const DELIVERY_TOOLS = new Set(['TaskOutput', 'SendMessage']);
const AGENT_ID_RE =/agentId:\s*([0-9a-fA-F]{6,40})/;
const OUTPUT_FILE_RE = /output_file:\s*(\S+)/;
// SendMessage-resumed agent (field report, 0.117): a background subagent that
// stopped for a usage limit and was resumed via SendMessage counts as RUNNING
// again, until its NEXT completion notification — not as still-terminal from
// whatever ended it before the resume. The harness's own SendMessage
// tool_result reads "Resuming agent <id> ...".
//
// REAL SHAPE (verified against a live transcript, 2026-10-02): the result is
// JSON, {"success":true,"message":"Resuming agent a180b19","resumedAgentId":
// "a180b191000d7a82e",...} — the message quotes only a SHORT id PREFIX, the
// full id is in `resumedAgentId`. The terminal/launched maps are keyed by the
// FULL id, so a prefix is resolved against them (resumeTargets below).
//
// GENUINE RECORDS ONLY (field, 2026-10-02): a resume counts ONLY when the text of
// a tool_result block IS that JSON result (success:true + a `message` that
// BEGINS "Resuming agent <id>", and/or a structured `resumedAgentId`). A
// task-notification / assistant text / user-typed text / tool_use input that
// merely QUOTES "Resuming agent a180b19" is not a resume — it once re-opened an
// agent killed hours earlier. parseResumeResult returns null for anything else.
const RESUME_MESSAGE_RE = /^Resuming\s+agent\s+([0-9a-fA-F]{6,40})/i;
const HEX_ID_RE = /^[0-9a-fA-F]{6,40}$/;
function parseResumeResult(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  // Older plain-text shape: the result text itself BEGINS "Resuming agent <id> (…".
  if (t.charAt(0) !== '{') {
    const pm0 = RESUME_MESSAGE_RE.exec(t);
    return pm0 ? { id: pm0[1], full: false } : null;
  }
  if ((t.indexOf('Resuming') === -1 && t.indexOf('resumedAgentId') === -1)) return null;
  let o;
  try { o = JSON.parse(t); } catch (_) { return null; }
  if (!o || typeof o !== 'object' || o.success !== true) return null;
  const full = typeof o.resumedAgentId === 'string' && HEX_ID_RE.test(o.resumedAgentId) ? o.resumedAgentId : null;
  const pm = typeof o.message === 'string' ? RESUME_MESSAGE_RE.exec(o.message) : null;
  if (full) return { id: full, full: true };
  if (pm) return { id: pm[1], full: false };
  return null;
}
// SendMessage to a STILL-RUNNING agent: {"success":true,"message":"Message
// queued for delivery to <full id> at its next tool round.","pin":{...}} — the
// coordinator talking TO the agent, never the agent's result delivered. It
// quotes the full id on a non-"running" line, so without this it tripped the
// delivered-but-unnotified safety net and marked a live agent terminal (field,
// 2026-10-02: a background agent messaged 4x was never nudged).
// Anchored to the real shape: the leaf must be the JSON result whose `message`
// field BEGINS with the phrase; a leaf that merely quotes it is not skipped.
function isQueuedMessageResult(text) {
  if (typeof text !== 'string' || text.indexOf('Message queued for delivery to') === -1) return false;
  try {
    const o = JSON.parse(text);
    return !!o && typeof o.message === 'string' && /^Message queued for delivery to\s/.test(o.message);
  } catch (_) { return false; }
}
// A single transcript text leaf can hold SEVERAL <task-notification> blocks
// (several agents can finish in the same turn) — TASK_NOTIFICATION_BLOCK_RE
// (global) splits the leaf into each individual block first, and TASK_ID_RE/
// STATUS_RE are then applied WITHIN that one block only, so a task-id from
// one notification never pairs with a status from another.
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_RE = /<task-id>([^<]*)<\/task-id>/;
const STATUS_RE = /<status>([^<]*)<\/status>/;
// A ListAgents-style row ("<id>  ·  <type>  ·  running  ·  started 20m ago")
// states the agent is STILL RUNNING — the opposite of delivery evidence, so the
// safety net below must not count the id appearing in such a row (field: the
// coordinator's own status check silently disarmed silent-agent-nudge).
const RUNNING_ROW_RE = /·\s*running\b/i;

// notificationTexts(entry) -> string[] of this transcript entry's texts that
// contain '<task-notification>', across all THREE real shapes the harness
// uses for a completion notice: a 'user' entry (bare string or array of text
// blocks), a queued 'attachment' entry (attachment.prompt), or a
// 'queue-operation' entry (entry.content). REUSED from
// companion/lib/devswarm-idle.js — that module already had to solve this
// exact multi-shape problem for the DevSwarm idle gate, and a second,
// independently-drifting copy of the same parsing here is exactly how this
// bug happened: this hook's own scanner only ever recognized the 'user'
// shape, so a completion notice delivered as an 'attachment' or
// 'queue-operation' entry was silently invisible to it (verified against
// live transcripts: all three shapes co-occur with <task-notification> in
// real sessions).
const { notificationTexts: idleNotificationTexts } = require('../../companion/lib/devswarm-idle.js');

// A genuine final notice can be stamped slightly BEFORE the resume record it
// follows (transcript write lag / clock skew between writers). Terminal evidence
// is dropped as stale only when stamped more than this far before the resume.
const RESUME_SKEW_SLACK_MS = 2000;

// scanTranscript(transcriptPath) -> { launched: Map<id, {outputFile, description, launchedAtMs}>, terminal: Set<id> } | null
// preLines (optional): already-read tail lines, so a caller that also parses
// the transcript for other reasons reads it only once.
function scanTranscript(transcriptPath, preLines) {
  const { readTail } = require('./transcript-tail.js');
  const lines = Array.isArray(preLines) ? preLines : readTail(transcriptPath);
  if (!lines) return null;

  const launched = new Map();
  const terminal = new Set();
  const descByToolUseId = new Map();
  // SAFETY NET (delivered-but-unnotified): every OTHER tool_result's text
  // (not the launch's own tool_result), so that if none of the three
  // <task-notification> shapes above ever appear, but a LATER tool_result
  // still literally quotes the agentId (e.g. a follow-up SendMessage/
  // TaskOutput result the coordinator triggered once it had already acted on
  // the agent's output), that counts as the result having been delivered.
  const otherToolResultTexts = [];
  // tool_use id -> { name, input } for every assistant tool_use seen, so a
  // tool_result can be judged by the call it answers (a Read/Bash/grep result
  // that merely contains an agent id or launch text is not a harness record).
  const toolUses = new Map();
  const taskStops = [];
  const erroredToolUseIds = new Set();
  const answersCall = (toolUseId, names) => {
    const c = toolUseId !== undefined ? toolUses.get(toolUseId) : undefined;
    return !c || names.has(c.name);
  };
  // SendMessage-resumed agent (field report, 0.117): a background subagent
  // resumed via SendMessage after a usage-limit stop counts as RUNNING again
  // — until its NEXT completion notification, not whatever marked it terminal
  // BEFORE the resume (e.g. a "stopped" notification from the usage limit
  // itself). terminalEv/resumeSeq track the transcript ORDER (line index) of
  // the newest evidence of each kind per agent id so the final reconciliation
  // pass below can tell which happened last.
  // terminalEv: id -> [{seq, ts}] of EVERY terminal evidence (ts = its entry
  // timestamp ms, NaN when missing/unparseable). Reconciliation needs them all,
  // not just the newest by order: a stop notification that sits LATER in the
  // transcript but is stamped BEFORE the resume describes the earlier run.
  const terminalEv = new Map();
  const markTerminal = (id, evSeq, evTs) => {
    terminal.add(id);
    if (!terminalEv.has(id)) terminalEv.set(id, []);
    terminalEv.get(id).push({ seq: evSeq, ts: evTs });
  };
  const resumeSeq = new Map();
  const resumeFull = new Set(); // resume ids that came from resumedAgentId (full ids)
  const resumeTs = new Map(); // id-or-prefix -> entry timestamp ms of its newest resume
  let seq = 0;

  for (const raw of lines) {
    seq++;
    const line = raw.trim();
    if (!line) continue;
    // Cheap pre-filter before JSON.parse: skip lines that can't possibly matter.
    const hasLaunch = line.indexOf('Async agent launched successfully') !== -1;
    const hasNotif = line.indexOf('<task-notification>') !== -1;
    const hasAgentToolUse = line.indexOf('"name":"Agent"') !== -1 || line.indexOf('"name": "Agent"') !== -1;
    const hasToolResult = line.indexOf('tool_result') !== -1;
    const hasTaskStop = line.indexOf('"name":"TaskStop"') !== -1 || line.indexOf('"name": "TaskStop"') !== -1;
    const hasTaskStatus = line.indexOf('"task_status"') !== -1;
    const hasToolUse = line.indexOf('"tool_use"') !== -1;
    if (!hasLaunch && !hasNotif && !hasAgentToolUse && !hasToolResult && !hasToolUse && !hasTaskStop && !hasTaskStatus) continue;

    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object') continue;

    // (a0) compaction re-injects each live background agent as a
    // `task_status` attachment (taskId, status, outputFilePath) — the launch
    // tool_result may by then sit OUTSIDE the capped tail window (the
    // compaction's own large attachments push it out), so adopt the agent here.
    const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const att = entry.attachment;
    if (att && att.type === 'task_status' && typeof att.taskId === 'string' && att.taskId) {
      if (att.status === 'running') {
        if (!launched.has(att.taskId)) {
          const t = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp)
            : (typeof att.timestamp === 'string' ? Date.parse(att.timestamp) : NaN);
          launched.set(att.taskId, {
            adopted: true,
            outputFile: typeof att.outputFilePath === 'string' ? att.outputFilePath : '',
            description: typeof att.description === 'string' ? att.description : '',
            launchedAtMs: Number.isFinite(t) ? t : NaN,
          });
        }
      } else if (TERMINAL_NOTIFICATION_STATUS.test(String(att.status))) {
        markTerminal(att.taskId, seq, entryTs);
      }
    }

    const content = entry.message && entry.message.content;

    if (hasToolUse && entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') toolUses.set(block.id, { name: block.name, input: block.input });
      }
    }

    // (a) assistant Agent tool_use -> capture its description, keyed by the
    // tool_use id, so a later matching tool_result can be named.
    if (hasAgentToolUse && entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name === 'Agent' && typeof block.id === 'string') {
          const inp = block.input && typeof block.input === 'object' ? block.input : {};
          const desc = typeof inp.description === 'string' ? inp.description : '';
          if (desc) descByToolUseId.set(block.id, desc);
        }
      }
    }

    // (a2) assistant TaskStop tool_use {task_id} = the coordinator stopped that
    // agent: terminal, ordered by sequence like a notification (a later genuine
    // resume re-opens it). A real harness field, not free text.
    if (hasTaskStop && entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name === 'TaskStop' && block.input && typeof block.input.task_id === 'string' && block.input.task_id) {
          // Applied after the walk: an errored TaskStop (its paired tool_result
          // is_error) stopped nothing. Result not visible -> still terminal.
          taskStops.push({ id: block.input.task_id, seq, toolUseId: block.id, ts: entryTs });
        }
      }
    }

    // (b) terminal notification, any of the three real shapes — checked for
    // EVERY entry type (not gated on entry.type === 'user' the way the
    // launch/tool_result walk below is), since that gate is exactly what
    // made 'attachment' and 'queue-operation' notifications invisible.
    if (hasNotif) {
      for (const text of idleNotificationTexts(entry)) {
        for (const blockMatch of text.matchAll(TASK_NOTIFICATION_BLOCK_RE)) {
          const body = blockMatch[1];
          const tidm = TASK_ID_RE.exec(body);
          const statm = STATUS_RE.exec(body);
          if (tidm && tidm[1] && statm && TERMINAL_NOTIFICATION_STATUS.test(statm[1])) {
            markTerminal(tidm[1], seq, entryTs);
          }
        }
      }
    }

    if (entry.type !== 'user') continue;

    // Walk each content block (or the single string/object content itself)
    // so a launch tool_result's own tool_use_id can be correlated with its
    // agentId, while a plain-string notification message still works.
    const blocks = Array.isArray(content) ? content : [{ content, tool_use_id: undefined }];
    for (const block of blocks) {
      if (!block) continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const blockContent = block.content !== undefined ? block.content : block;
      const isToolResult = block.type === 'tool_result';
      if (isToolResult && block.is_error === true && toolUseId) erroredToolUseIds.add(toolUseId);
      for (const text of extractTexts(blockContent)) {
        // Launch = a tool_result whose text BEGINS with the harness phrase; a
        // notification/typed text that merely quotes a launch result is not one.
        // It must also answer an Agent/Task call: a seen tool_use of any other
        // name (Read/Bash/grep of a notes file) is not a launch. A tool_use
        // outside the scanned window is unseen -> judged on the text alone.
        if (isToolResult && hasLaunch && answersCall(toolUseId, LAUNCH_TOOLS) && text.trimStart().startsWith('Async agent launched successfully')) {
          const idm = AGENT_ID_RE.exec(text);
          const sid = entry.toolUseResult && typeof entry.toolUseResult.agentId === 'string' && HEX_ID_RE.test(entry.toolUseResult.agentId) ? entry.toolUseResult.agentId : null;
          if (idm || sid) {
            const ofm = OUTPUT_FILE_RE.exec(text);
            launched.set(sid || idm[1], {
              outputFile: ofm ? ofm[1] : '',
              toolUseId,
              launchedAtMs: Number.isFinite(entryTs) ? entryTs : NaN,
            });
          }
        }
        // A "Resuming agent <id>" tool_result (SendMessage to a background
        // agent) is evidence the COORDINATOR is continuing it, not evidence
        // the agent's output was delivered — it must NOT feed the generic
        // safety-net match below (which would otherwise immediately
        // re-mark a just-resumed agent terminal merely because this text
        // quotes its own id). Record it separately instead.
        const resumeMatch = isToolResult && answersCall(toolUseId, RESUME_TOOLS) ? parseResumeResult(text) : null;
        if (resumeMatch) {
          const rid = resumeMatch.id;
          if (resumeMatch.full) resumeFull.add(rid);
          resumeSeq.set(rid, seq);
          if (Number.isFinite(entryTs)) resumeTs.set(rid, entryTs); else resumeTs.delete(rid);
          continue;
        }
        if (isQueuedMessageResult(text)) continue;
        if (isToolResult) otherToolResultTexts.push({ toolUseId, text, seq, ts: entryTs });
      }
    }
  }

  // Attach descriptions where the originating Agent tool_use was also in the
  // tail window; otherwise the id alone is shown (best-effort, never fatal).
  for (const rec of launched.values()) {
    if (rec.toolUseId && descByToolUseId.has(rec.toolUseId)) {
      rec.description = descByToolUseId.get(rec.toolUseId);
    }
  }

  for (const s of taskStops) {
    if (erroredToolUseIds.has(s.toolUseId)) continue;
    markTerminal(s.id, s.seq, s.ts);
  }

  // SAFETY NET pass: for any launched-but-not-yet-terminal agent, check
  // whether a tool_result OTHER than its own launch result later quotes its
  // agentId. Ordering note: completion can only come AFTER launch (the
  // launch line is what creates the agentId in the first place), so scanning
  // the whole tail after the fact is safe — there is no ordering case where a
  // completion reference could precede or be misattributed to a launch that
  // has not happened yet.
  for (const [id, rec] of launched) {
    if (terminal.has(id)) continue;
    for (const { toolUseId, text, seq: evidenceSeq, ts: evidenceTs } of otherToolResultTexts) {
      if (toolUseId !== undefined && toolUseId === rec.toolUseId) continue; // the launch's own result already named it — not "later" evidence
      // Delivery evidence only from the answer to a TaskOutput/SendMessage call
      // naming this agent; a Read/Bash/grep result that merely contains the id
      // (a notes file, a log) is not. An unseen call (outside the window) is
      // judged on the text alone.
      const call = toolUseId !== undefined ? toolUses.get(toolUseId) : undefined;
      if (call && !(DELIVERY_TOOLS.has(call.name) && namesAgent(call.input, id, launched))) continue;
      if (text.split('\n').some((ln) => ln.indexOf(id) !== -1 && !RUNNING_ROW_RE.test(ln))) { markTerminal(id, evidenceSeq, evidenceTs); break; }
    }
  }

  // RESUME RECONCILIATION: an id resumed via SendMessage AFTER the newest
  // terminal evidence seen for it (or with no terminal evidence recorded at
  // all — the resume itself is proof it is not done) is treated as running
  // again. A terminal notification/evidence that arrives LATER than the
  // resume (the agent's actual next completion) still correctly marks it
  // terminal — this only reverses an ordering where the resume is newer.
  // A resume names the agent by its full id (resumedAgentId) or only a short
  // prefix (message text); resolve the key against every id seen so far.
  const knownIds = new Set([...launched.keys(), ...terminal]);
  for (const [rid, rSeq] of resumeSeq) {
    const targets = [];
    for (const k of knownIds) if (k === rid || k.startsWith(rid)) targets.push(k);
    // A prefix-only resume (no resumedAgentId) may act only on a UNIQUE match;
    // 0 or 2+ matches are ambiguous -> do nothing.
    if (!resumeFull.has(rid) && targets.length !== 1) targets.length = 0;
    // KNOWN PRE-EXISTING LIMITATION (not a regression): a genuinely resumed
    // agent whose launch record sits outside the tail window is only adopted
    // below when the resume names the full id (resumedAgentId); a prefix-only
    // resume of such an agent resolves to nothing and it reads as not running.
    // Launch record outside the scanned window but the resume names the full
    // id: adopt it as running from the resume time (output file unknown).
    if (!targets.length && resumeFull.has(rid) && resumeTs.has(rid)) {
      launched.set(rid, { adopted: true, outputFile: '', description: '', launchedAtMs: resumeTs.get(rid) });
      targets.push(rid);
    }
    for (const id of targets) {
      const rec = launched.get(id);
      if (rec && resumeTs.has(rid)) rec.resumedAtMs = Math.max(rec.resumedAtMs || 0, resumeTs.get(rid));
      if (!terminal.has(id)) continue;
      // Terminal evidence still stands only if it is AFTER the resume by order
      // and not stamped MORE than RESUME_SKEW_SLACK_MS before the resume (a
      // late-arriving record of the previous run). Inside the slack, and with
      // missing/unparseable timestamps, transcript order alone decides.
      const rTs = resumeTs.get(rid);
      const stands = (terminalEv.get(id) || []).some((e) =>
        e.seq > rSeq && !(Number.isFinite(e.ts) && Number.isFinite(rTs) && e.ts < rTs - RESUME_SKEW_SLACK_MS));
      if (!stands) terminal.delete(id);
    }
  }

  return { launched, terminal };
}

// runningAgents(transcriptPath) -> [{ id, description, launchedAtMs }] —
// launched in this transcript and not yet terminal. null when unreadable.
function runningAgents(transcriptPath, preLines) {
  const scan = scanTranscript(transcriptPath, preLines);
  if (!scan) return null;
  const out = [];
  for (const [id, rec] of scan.launched) {
    if (scan.terminal.has(id)) continue;
    out.push({ id, description: rec.description || '', launchedAtMs: rec.launchedAtMs });
  }
  return out;
}

// runningAgentsOrNull(transcriptPath, preLines) -> [{...}] | null. Like
// runningAgents, but null ("unknown") when the count cannot be trusted: the scan
// is unreadable, or the transcript is larger than the capped tail window and no
// agent was found in it — a launch that sits BEFORE the window is invisible, so
// an empty result there is "unknown", not "0 running" (L34 field: DISPATCH NOW
// said "0 running" while a pre-window agent was still pending).
function runningAgentsOrNull(transcriptPath, preLines) {
  const out = runningAgents(transcriptPath, preLines);
  if (out === null) return null;
  if (out.length === 0) {
    try {
      const { MAX_TAIL_BYTES } = require('./transcript-tail.js');
      if (require('fs').statSync(transcriptPath).size > MAX_TAIL_BYTES) return null;
    } catch (_) { return null; }
  }
  return out;
}

module.exports = { scanTranscript, runningAgents, runningAgentsOrNull, extractTexts, TERMINAL_NOTIFICATION_STATUS };
