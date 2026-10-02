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
// (observed values: completed/failed/stopped), case-insensitive.
const TERMINAL_NOTIFICATION_STATUS = /^(completed|failed|stopped)$/i;

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

const AGENT_ID_RE = /agentId:\s*([0-9a-fA-F]{6,40})/;
const OUTPUT_FILE_RE = /output_file:\s*(\S+)/;
// SendMessage-resumed agent (field report, 0.117): a background subagent that
// stopped for a usage limit and was resumed via SendMessage counts as RUNNING
// again, until its NEXT completion notification — not as still-terminal from
// whatever ended it before the resume. The harness's own SendMessage
// tool_result reads "Resuming agent <id> ...".
const RESUME_RE = /Resuming\s+agent\s+([0-9a-fA-F]{6,40})/i;
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
  // SendMessage-resumed agent (field report, 0.117): a background subagent
  // resumed via SendMessage after a usage-limit stop counts as RUNNING again
  // — until its NEXT completion notification, not whatever marked it terminal
  // BEFORE the resume (e.g. a "stopped" notification from the usage limit
  // itself). terminalSeq/resumeSeq track the transcript ORDER (line index) of
  // the newest evidence of each kind per agent id so the final reconciliation
  // pass below can tell which happened last.
  const terminalSeq = new Map();
  const resumeSeq = new Map();
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
    const hasResume = line.indexOf('Resuming agent') !== -1;
    const hasTaskStatus = line.indexOf('"task_status"') !== -1;
    if (!hasLaunch && !hasNotif && !hasAgentToolUse && !hasToolResult && !hasResume && !hasTaskStatus) continue;

    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object') continue;

    // (a0) compaction re-injects each live background agent as a
    // `task_status` attachment (taskId, status, outputFilePath) — the launch
    // tool_result may by then sit OUTSIDE the capped tail window (the
    // compaction's own large attachments push it out), so adopt the agent here.
    const att = entry.attachment;
    if (att && att.type === 'task_status' && typeof att.taskId === 'string' && att.taskId) {
      if (att.status === 'running') {
        if (!launched.has(att.taskId)) {
          const t = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
          launched.set(att.taskId, {
            outputFile: typeof att.outputFilePath === 'string' ? att.outputFilePath : '',
            description: typeof att.description === 'string' ? att.description : '',
            launchedAtMs: Number.isFinite(t) ? t : NaN,
          });
        }
      } else if (TERMINAL_NOTIFICATION_STATUS.test(String(att.status))) {
        terminal.add(att.taskId);
        terminalSeq.set(att.taskId, seq);
      }
    }

    const content = entry.message && entry.message.content;
    const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;

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
            terminal.add(tidm[1]);
            terminalSeq.set(tidm[1], seq);
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
      for (const text of extractTexts(blockContent)) {
        if (hasLaunch && text.indexOf('Async agent launched successfully') !== -1) {
          const idm = AGENT_ID_RE.exec(text);
          if (idm) {
            const ofm = OUTPUT_FILE_RE.exec(text);
            launched.set(idm[1], {
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
        const resumeMatch = RESUME_RE.exec(text);
        if (resumeMatch) {
          resumeSeq.set(resumeMatch[1], seq);
          continue;
        }
        if (isToolResult) otherToolResultTexts.push({ toolUseId, text, seq });
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

  // SAFETY NET pass: for any launched-but-not-yet-terminal agent, check
  // whether a tool_result OTHER than its own launch result later quotes its
  // agentId. Ordering note: completion can only come AFTER launch (the
  // launch line is what creates the agentId in the first place), so scanning
  // the whole tail after the fact is safe — there is no ordering case where a
  // completion reference could precede or be misattributed to a launch that
  // has not happened yet.
  for (const [id, rec] of launched) {
    if (terminal.has(id)) continue;
    for (const { toolUseId, text, seq: evidenceSeq } of otherToolResultTexts) {
      if (toolUseId !== undefined && toolUseId === rec.toolUseId) continue; // the launch's own result already named it — not "later" evidence
      if (text.split('\n').some((ln) => ln.indexOf(id) !== -1 && !RUNNING_ROW_RE.test(ln))) { terminal.add(id); terminalSeq.set(id, evidenceSeq); break; }
    }
  }

  // RESUME RECONCILIATION: an id resumed via SendMessage AFTER the newest
  // terminal evidence seen for it (or with no terminal evidence recorded at
  // all — the resume itself is proof it is not done) is treated as running
  // again. A terminal notification/evidence that arrives LATER than the
  // resume (the agent's actual next completion) still correctly marks it
  // terminal — this only reverses an ordering where the resume is newer.
  for (const [id, rSeq] of resumeSeq) {
    if (!terminal.has(id)) continue;
    const tSeq = terminalSeq.has(id) ? terminalSeq.get(id) : -1;
    if (rSeq > tSeq) terminal.delete(id);
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
