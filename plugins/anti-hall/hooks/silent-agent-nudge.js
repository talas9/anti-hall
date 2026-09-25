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
const TERMINAL_NOTIFICATION_STATUS = /^(completed|failed|stopped)$/;

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
const TASK_ID_RE = /<task-id>([^<]*)<\/task-id>/;
const STATUS_RE = /<status>([^<]*)<\/status>/;

// scanTranscript(transcriptPath) -> { launched: Map<id, {outputFile, description, launchedAtMs}>, terminal: Set<id> } | null
function scanTranscript(transcriptPath) {
  const { readTail } = require('./lib/transcript-tail.js');
  const lines = readTail(transcriptPath);
  if (!lines) return null;

  const launched = new Map();
  const terminal = new Set();
  const descByToolUseId = new Map();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Cheap pre-filter before JSON.parse: skip lines that can't possibly matter.
    const hasLaunch = line.indexOf('Async agent launched successfully') !== -1;
    const hasNotif = line.indexOf('<task-notification>') !== -1;
    const hasAgentToolUse = line.indexOf('"name":"Agent"') !== -1 || line.indexOf('"name": "Agent"') !== -1;
    if (!hasLaunch && !hasNotif && !hasAgentToolUse) continue;

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

    if (entry.type !== 'user') continue;

    // Walk each content block (or the single string/object content itself)
    // so a launch tool_result's own tool_use_id can be correlated with its
    // agentId, while a plain-string notification message still works.
    const blocks = Array.isArray(content) ? content : [{ content, tool_use_id: undefined }];
    for (const block of blocks) {
      if (!block) continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const blockContent = block.content !== undefined ? block.content : block;
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
        if (hasNotif && text.indexOf('<task-notification>') !== -1) {
          const tidm = TASK_ID_RE.exec(text);
          const statm = STATUS_RE.exec(text);
          if (tidm && tidm[1] && statm && TERMINAL_NOTIFICATION_STATUS.test(statm[1])) {
            terminal.add(tidm[1]);
          }
        }
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
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.nudged && typeof parsed.nudged === 'object') {
      prevNudged = parsed.nudged;
    }
  } catch (_) { prevNudged = {}; }

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

  if (stale.length === 0) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ nudged: nextNudged }), 'utf8');
    } catch (_) { /* best-effort prune, never blocks */ }
    process.exit(0);
  }

  for (const c of stale) nextNudged[c.key] = c.snapshot;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ nudged: nextNudged }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist the cap -> fail-open by staying silent (never risk a repeat-nudge loop)
  }

  const MAX_NAMED = 3;
  const shown = stale.slice(0, MAX_NAMED).map((c) => {
    const mins = Math.floor(c.age / 60000);
    return c.label + ' — silent ' + mins + 'm';
  }).join('; ');
  const more = stale.length > MAX_NAMED ? ', +' + (stale.length - MAX_NAMED) + ' more' : '';

  const reason =
    'anti-hall silent-agent-nudge: ' + stale.length +
    ' of your own background subagent(s) have gone silent past the ' + minMinutes +
    'm threshold: ' + shown + more + '. This is advisory only — nothing was ' +
    'auto-killed. Check on ' + (stale.length === 1 ? 'it' : 'them') + ' (TaskOutput) or ' +
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
