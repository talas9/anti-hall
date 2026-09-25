#!/usr/bin/env node
// anti-hall :: silent-agent-nudge (Stop hook, ADVISORY ONLY, never kills)
//
// Orchestration rule I (verify-first-orch.js) already tells the coordinator:
// "if an agent misses its heartbeat ... for ~20 min, TaskStop and
// re-dispatch." Nothing mechanically ENFORCES that — a session can sit
// waiting on a dead background subagent forever with no reminder.
//
// PRIMARY SIGNAL: the harness ALWAYS produces this, unlike the
// ~/.anti-hall/agents/<id>.json heartbeat convention below (nothing writes it
// automatically — it only exists if a subagent chooses to self-report). Every
// background Agent launch appends a tool_result to the MAIN transcript
// containing the literal text "Async agent launched successfully", an
// `agentId: <id>` line, and an `output_file: <path>` line (the harness's own
// per-agent JSONL, which grows while the agent works). When that agent
// finishes/fails/is stopped, a LATER transcript entry carries a
// `<task-notification>` block with `<task-id>` (== the agentId) and
// `<status>completed|failed|stopped</status>`. So:
//   SILENT = launched (seen in the transcript), no terminal notification for
//   it yet, AND its output_file's mtime (or, if the file is missing, the
//   launch line's own timestamp — "missing" counts as silent/dead too) is
//   older than the threshold.
//
// SECONDARY SIGNAL (kept, additive): the ~/.anti-hall/agents/<id>.json
// heartbeat convention some subagents self-report per the orchestration
// skill. Both sources are scanned; candidates are merged (transcript-sourced
// ids and heartbeat-sourced ids use disjoint id spaces in practice, but are
// namespaced in state regardless so they can never collide).
//
// NEVER KILLS ANYTHING. This hook only emits text. It never calls TaskStop,
// never deletes/moves any file, never touches the agent itself — it only
// suggests checking on it or re-dispatching (mirrors the repo-wide
// "automatic paths detect+report only" rule).
//
// STOP HOOK OUTPUT: every existing Stop-hook nudge in this repo (task-guard,
// tasklist-guard, speculation-guard, speculation-judge, devswarm-parent-gate,
// devswarm-child-gate, auto-handover-pause-nag, codex-nudge) emits
// `{"decision":"block","reason":...}` — Stop has no separate non-blocking
// advisory channel in this harness, so a soft block IS the established
// once-only-nudge convention here (see auto-handover-pause-nag.js's comment:
// "the only non-blocking-adjacent way a Stop hook can surface text"). This
// hook follows the same convention: the model reads the reason, then
// continues/stops cleanly.
//
// BOUNDED READ: the transcript can be tens of thousands of lines on a long
// session, so only the last MAX_TAIL_BYTES (shared hooks/lib/transcript-tail.js
// cap, 1.5MB) is scanned — same trade-off transcript-tail.js's other
// consumers (context-pct.js, auto-handover-pause-nag.js) already accept: an
// agent launched/resolved further back than the tail window is invisible to
// this scan, degrading gracefully (advisory only, never a hard gate).
//
// DEDUP / CAP: one nudge per stale SNAPSHOT — transcript source keyed by
// (agentId, output_file mtime or 'missing'); heartbeat source keyed by
// (id, heartbeat ts) — persisted in ~/.anti-hall/silent-agent-nudge-state.json.
// Once nudged, that exact snapshot never nudges again; a later change (file
// updated again, or the agent resolving) is a new snapshot and may nudge
// once more. State self-prunes to ids currently observed live, so it never
// grows unbounded.
//
// CONFIG:
//   guards.silentAgentNudge    (boolean, default true)  — ANTIHALL_SILENT_AGENT_NUDGE=off disables
//   guards.silentAgentNudgeMin (number,  default 20)     — ANTIHALL_SILENT_AGENT_NUDGE_MIN=<n> minutes
// Escape hatch: ~/.anti-hall/skip.json {"silent-agent-nudge": <future-ts>}.
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { hook_event_name: 'Stop', session_id?, transcript_path?, cwd?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to nudge, or nothing
//   exit 0 : always

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN = 20; // minutes — mirrors agent-watchdog.js's 20-min default
// A heartbeat's status is considered "finished" (never nudge) when it matches
// one of these free-form terminal values (agent-watchdog.js documents status
// as free-form: "running", "done", "error", etc.).
const FINISHED_HEARTBEAT_STATUS = /^(done|complete|completed|finished|stopped|success|succeeded|error|failed)$/i;
// Transcript notification statuses that mean the agent has actually ended
// (see task-notification's <status> — observed values: completed/failed/stopped).
// Case-insensitive, matching FINISHED_HEARTBEAT_STATUS above -- a harness or
// agent that emits a differently-cased status (e.g. "Completed") must still
// be recognized as terminal, not misread as still-silent.
const TERMINAL_NOTIFICATION_STATUS = /^(completed|failed|stopped)$/i;

function settingsGet(section, key, dflt) {
  try { return require('./lib/settings.js').get(section, key, dflt); } catch (_) { return dflt; }
}

// oneLine(s, max) — strip control chars/newlines and bound length so an
// agent-supplied id/description/step can never inject instruction-shaped
// content or blow up the reason line (mirror task-tracker.js's oneLine).
function oneLine(s, max) {
  if (typeof s !== 'string') return '';
  let o = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

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
// A single transcript text leaf can hold SEVERAL <task-notification> blocks
// (several agents can finish in the same turn) — TASK_NOTIFICATION_BLOCK_RE
// (global) splits the leaf into each individual block first, and TASK_ID_RE/
// STATUS_RE are then applied WITHIN that one block only, so a task-id from
// one notification never pairs with a status from another.
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_RE = /<task-id>([^<]*)<\/task-id>/;
const STATUS_RE = /<status>([^<]*)<\/status>/;

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
const { notificationTexts: idleNotificationTexts } = require('../companion/lib/devswarm-idle.js');

// scanTranscript(transcriptPath) -> { launched: Map<id, {outputFile, description, launchedAtMs}>, terminal: Set<id> } | null
function scanTranscript(transcriptPath) {
  const { readTail } = require('./lib/transcript-tail.js');
  const lines = readTail(transcriptPath);
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

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Cheap pre-filter before JSON.parse: skip lines that can't possibly matter.
    const hasLaunch = line.indexOf('Async agent launched successfully') !== -1;
    const hasNotif = line.indexOf('<task-notification>') !== -1;
    const hasAgentToolUse = line.indexOf('"name":"Agent"') !== -1 || line.indexOf('"name": "Agent"') !== -1;
    const hasToolResult = line.indexOf('tool_result') !== -1;
    if (!hasLaunch && !hasNotif && !hasAgentToolUse && !hasToolResult) continue;

    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object') continue;

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
        if (isToolResult) otherToolResultTexts.push({ toolUseId, text });
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
    for (const { toolUseId, text } of otherToolResultTexts) {
      if (toolUseId !== undefined && toolUseId === rec.toolUseId) continue; // the launch's own result already named it — not "later" evidence
      if (text.indexOf(id) !== -1) { terminal.add(id); break; }
    }
  }

  return { launched, terminal };
}

// transcriptCandidates(transcriptPath, now, thresholdMs) -> [{ key, id, label, age, snapshot }]
// `snapshot` is the dedupe key: output_file mtime in ms, or 'missing'.
function transcriptCandidates(transcriptPath, now, thresholdMs) {
  const scan = transcriptPath ? scanTranscript(transcriptPath) : null;
  if (!scan) return [];
  const out = [];
  for (const [id, rec] of scan.launched) {
    if (scan.terminal.has(id)) continue; // already resolved -> nothing

    let referenceMs = NaN;
    let snapshot = 'missing';
    let outputMissing = true;
    if (rec.outputFile) {
      try {
        const st = fs.statSync(rec.outputFile);
        referenceMs = st.mtimeMs;
        snapshot = String(Math.floor(st.mtimeMs));
        outputMissing = false;
      } catch (_) {
        outputMissing = true; // missing/unreadable output file -> counts as silent/dead
      }
    }
    if (outputMissing) {
      // No file to judge freshness from — fall back to the launch entry's
      // own timestamp so a JUST-launched agent (file not created yet) isn't
      // immediately flagged; if the transcript carried no parseable
      // timestamp either, treat it as silent right away (fail toward
      // surfacing a dead-looking agent rather than hiding it forever).
      referenceMs = Number.isFinite(rec.launchedAtMs) ? rec.launchedAtMs : 0;
      snapshot = 'missing';
    }

    const age = now - referenceMs;
    if (!(age >= thresholdMs)) continue; // fresh, or unparseable reference -> nothing

    out.push({
      key: 't:' + id,
      id,
      label: rec.description ? oneLine(rec.description, 60) : oneLine(id, 60),
      age,
      snapshot,
    });
  }
  return out;
}

// heartbeatCandidates(home, now, thresholdMs) -> [{ key, id, label, age, snapshot }]
function heartbeatCandidates(home, now, thresholdMs) {
  const dir = path.join(home, '.anti-hall', 'agents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!data || typeof data !== 'object') continue;

    const id = (typeof data.id === 'string' && data.id) || f.replace(/\.json$/, '');
    const ts = (typeof data.ts === 'number' && Number.isFinite(data.ts)) ? data.ts : 0;
    if (!ts) continue; // no timestamp -> can't judge staleness -> skip (fail-open toward no nudge)

    const status = typeof data.status === 'string' ? data.status : '';
    if (FINISHED_HEARTBEAT_STATUS.test(status.trim())) continue; // finished agent -> nothing

    const age = now - ts;
    if (age < thresholdMs) continue; // fresh -> nothing

    out.push({
      key: 'h:' + id,
      id,
      label: (typeof data.step === 'string' && data.step) ? oneLine(data.step, 60) : oneLine(id, 60),
      age,
      snapshot: String(ts),
    });
  }
  return out;
}

function main() {
  // Settings switch guards.silentAgentNudge: off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('guards', 'silentAgentNudge')) return; } catch (_) { /* run */ }

  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }

  // Escape hatch: shared user-consented skip.
  try {
    const { isSkipped } = require('./skip-guard.js');
    if (isSkipped('silent-agent-nudge')) process.exit(0);
  } catch (_) { /* skip-guard unavailable — proceed */ }

  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }
  if (!payload || typeof payload !== 'object') process.exit(0);

  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) process.exit(0);

  let minMinutes = settingsGet('guards', 'silentAgentNudgeMin', DEFAULT_MIN);
  if (!Number.isFinite(minMinutes) || minMinutes < 1) minMinutes = DEFAULT_MIN;
  const thresholdMs = minMinutes * 60 * 1000;

  const now = Date.now();
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';

  let candidates = [];
  try { candidates = candidates.concat(transcriptCandidates(transcriptPath, now, thresholdMs)); } catch (_) { /* fail-open: skip this source */ }
  try { candidates = candidates.concat(heartbeatCandidates(home, now, thresholdMs)); } catch (_) { /* fail-open: skip this source */ }

  if (candidates.length === 0) process.exit(0);

  const stateFile = path.join(home, '.anti-hall', 'silent-agent-nudge-state.json');
  let prevNudged = {};
  let everNudged = {}; // HARD CAP state: { 'sessionId::id': tsMs } — see below.
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.nudged && typeof parsed.nudged === 'object') prevNudged = parsed.nudged;
      if (parsed.everNudged && typeof parsed.everNudged === 'object') everNudged = parsed.everNudged;
    }
  } catch (_) { prevNudged = {}; everNudged = {}; }

  const liveKeys = new Set(candidates.map((c) => c.key));
  const stale = candidates.filter((c) => prevNudged[c.key] !== c.snapshot);

  // Self-prune: only keep prior nudge records for keys still observed live in
  // THIS run's candidate set, so the state file never grows unbounded. (A key
  // that scrolled out of the transcript tail window or whose heartbeat file
  // was removed is simply dropped — if it reappears later it can nudge once
  // more, which is the safe direction.)
  const nextNudged = {};
  for (const k of Object.keys(prevNudged)) {
    if (liveKeys.has(k)) nextNudged[k] = prevNudged[k];
  }

  // HARD CAP (independent of the snapshot dedup above): at most ONE nudge per
  // agentId per SESSION, ever — regardless of the snapshot changing (output
  // file re-touched, a heartbeat re-written, a self-prune round-trip losing
  // the record, or any other reason the snapshot-keyed dedup above might miss
  // a repeat). Keyed by sessionId + agentId so two different sessions with a
  // coincidentally equal agent id never share a cap, and TTL-pruned (30 days)
  // so the map does not grow unbounded across many past sessions.
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const everKey = (id) => sessionId + '::' + id;
  const EVER_NUDGED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const nextEverNudged = {};
  for (const k of Object.keys(everNudged)) {
    const ts = Number(everNudged[k]);
    if (Number.isFinite(ts) && (now - ts) < EVER_NUDGED_TTL_MS) nextEverNudged[k] = ts;
  }
  // Without a session id there is nothing safe to scope the hard cap to —
  // fall back to snapshot-only dedup rather than caping across unrelated
  // sessions.
  const hardCapped = sessionId ? stale.filter((c) => !Object.prototype.hasOwnProperty.call(nextEverNudged, everKey(c.id))) : stale;

  function persist() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ nudged: nextNudged, everNudged: nextEverNudged }), 'utf8');
    } catch (_) { /* best-effort persist, never blocks */ }
  }

  if (hardCapped.length === 0) {
    // Keep the snapshot map in sync even when every stale candidate got
    // suppressed by the hard cap, so it does not look "not yet nudged" next
    // time and keep re-entering `stale` above for no reason.
    for (const c of stale) nextNudged[c.key] = c.snapshot;
    persist();
    process.exit(0);
  }

  for (const c of stale) nextNudged[c.key] = c.snapshot;

  // Dedup by agent id ACROSS sources for the DISPLAYED message only (state
  // above still tracks both the 't:' and 'h:' keys separately, so each
  // source's own snapshot dedup keeps working) -- the same agent id can show
  // up as both a transcript-sourced AND a heartbeat-sourced candidate in one
  // Stop (an agent that both self-reports a heartbeat AND is watched via the
  // harness's own task-notification), and that must read as ONE stale agent
  // to the user, not two duplicate lines for the same thing.
  const seenIds = new Set();
  const shownCandidates = [];
  for (const c of hardCapped) {
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);
    shownCandidates.push(c);
  }

  // Exactly ONE block per Stop cycle: this whole hook only ever emits a
  // single {decision:'block'} response per invocation already (one `reason`
  // string covering up to MAX_NAMED names + a "+N more" tail) — recorded here
  // explicitly since the hard cap above is what makes that hold true across
  // repeated Stops for the SAME agent too, not just within one Stop.
  if (sessionId) {
    for (const c of shownCandidates) nextEverNudged[everKey(c.id)] = now;
  }
  persist();

  const MAX_NAMED = 3;
  const shown = shownCandidates.slice(0, MAX_NAMED).map((c) => {
    const mins = Math.floor(c.age / 60000);
    return c.label + ' — silent ' + mins + 'm';
  }).join('; ');
  const more = shownCandidates.length > MAX_NAMED ? ', +' + (shownCandidates.length - MAX_NAMED) + ' more' : '';

  const reason =
    'anti-hall silent-agent-nudge: ' + shownCandidates.length +
    ' of your own background subagent(s) have gone silent past the ' + minMinutes +
    'm threshold: ' + shown + more + '. This is advisory only — nothing was ' +
    'auto-killed. Check on ' + (shownCandidates.length === 1 ? 'it' : 'them') + ' (TaskOutput) or ' +
    're-dispatch with tighter scope if it is dead (TaskStop first, per orchestration rule I) ' +
    '— do not assume, verify. Set ANTIHALL_SILENT_AGENT_NUDGE=off to silence.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0); // fail-open: never wedge a Stop
}
process.exit(0);
