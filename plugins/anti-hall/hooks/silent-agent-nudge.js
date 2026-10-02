#!/usr/bin/env node
// anti-hall :: silent-agent-nudge (Stop hook, ADVISORY ONLY, never kills)
//
// Orchestration rule I (verify-first-orch.js) already tells the coordinator:
// "Output/transcript file quiet ~20 min = stalled: TaskStop, re-dispatch
// tighter. 'running' in an agent list is not progress - verify via
// process/output evidence." Nothing mechanically ENFORCES that — a session can sit
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
// `<status>completed|failed|stopped|killed|cancelled</status>`. So:
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
// session, so only the last NUDGE_SCAN_BYTES (64MB — NOT the shared 1.5MB
// transcript-tail.js cap, which hid launches 1.8MB+ back) is scanned: an agent
// launched further back than that is invisible to this scan, degrading
// gracefully (advisory only, never a hard gate).
//
// RESUME: an agent resumed via SendMessage is running from the resume time —
// staleness is measured from the latest of the output file, its sidechain
// transcript and the resume, and the one-nudge cap is per (agent, resume).
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

// scanTranscript / extractTexts live in lib/agent-scan.js (shared with
// task-guard + task-tracker so the running-agent parse never drifts).
const { scanTranscript } = require('./lib/agent-scan.js');

// The shared 1.5MB tail is far too short for THIS hook: a long-running agent's
// launch record sits before it as soon as the coordinator's turns carry large
// attachments (field, 2026-10-02: launches 1.8MB and 2.6MB back, agents silent
// 57+ min, never seen). Read a much wider window for this one Stop-time scan;
// the scanner only JSON-parses pre-filtered lines, so cost is the read + split.
const NUDGE_SCAN_BYTES = 64 * 1024 * 1024;

// sidechainMtimeMs(transcriptPath, id) -> mtime of the agent's own sidechain
// transcript (<dir>/<session>/subagents/agent-<id>.jsonl), NaN when absent.
// The harness's output_file is normally a symlink to it (statSync follows), but
// when the output file is missing this is still the fresher/true liveness signal.
function sidechainMtimeMs(transcriptPath, id) {
  try {
    const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
    return fs.statSync(path.join(dir, 'agent-' + id + '.jsonl')).mtimeMs;
  } catch (_) { return NaN; }
}


// transcriptCandidates(transcriptPath, now, thresholdMs) -> [{ key, id, label, age, snapshot }]
// `snapshot` is the dedupe key: output_file mtime in ms, or 'missing'.
function transcriptCandidates(transcriptPath, now, thresholdMs) {
  let scan = null;
  if (transcriptPath) {
    const { readTail } = require('./lib/transcript-tail.js');
    scan = scanTranscript(transcriptPath, readTail(transcriptPath, NUDGE_SCAN_BYTES) || undefined);
  }
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
      // An agent adopted from a task_status attachment with no timestamp and
      // no output file has no evidence of age at all -> never nudge it.
      if (rec.adopted && !Number.isFinite(rec.launchedAtMs)) continue;
      referenceMs = Number.isFinite(rec.launchedAtMs) ? rec.launchedAtMs : 0;
      snapshot = 'missing';
    }

    // Staleness runs from the LATEST sign of life: output file / launch time,
    // the sidechain transcript, and — for an agent resumed via SendMessage —
    // the resume itself (a resumed agent is running from the resume time).
    const sc = sidechainMtimeMs(transcriptPath, id);
    if (Number.isFinite(sc) && !(sc <= referenceMs)) referenceMs = sc;
    const resumedAtMs = Number.isFinite(rec.resumedAtMs) ? rec.resumedAtMs : 0;
    if (resumedAtMs > referenceMs) referenceMs = resumedAtMs;
    if (resumedAtMs) snapshot += '@r' + resumedAtMs;

    const age = now - referenceMs;
    if (!(age >= thresholdMs)) continue; // fresh, or unparseable reference -> nothing

    out.push({
      key: 't:' + id,
      id,
      resumedAtMs,
      label: rec.description ? oneLine(rec.description, 60) : oneLine(id, 60),
      age,
      snapshot,
    });
  }
  return out;
}

// heartbeatCandidates(home, now, thresholdMs, sessionId) -> [{ key, id, label, age, snapshot }]
//
// The ~/.anti-hall/agents/ directory is SHARED machine-wide (home-scoped, not
// per-session/per-project): phase-tracker.js writes a rolling
// recent-spawn.json = {ts} "orchestration live" marker (not an agent) into the
// very same directory, and other projects'/workspaces' DevSwarm tooling can
// drop devswarm-<branch>.json files there too. Globbing every *.json and
// treating it as a subagent heartbeat (falling back to the filename as `id`)
// misreads either as a silently-dead agent and blocks Stop with no subagent
// involved at all. Only a file matching the genuine per-agent heartbeat
// convention (SKILL.md "orchestration" skill: `{ id, ts, status, step,
// session }`, self-reported by a subagent) may become a candidate.
function heartbeatCandidates(home, now, thresholdMs, sessionId) {
  const dir = path.join(home, '.anti-hall', 'agents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    // Defense-in-depth: exclude known non-heartbeat files by name explicitly,
    // even though the shape checks below already reject them.
    if (f === 'recent-spawn.json') continue; // phase-tracker.js orchestration-live marker
    if (/^devswarm-/.test(f)) continue; // DevSwarm workspace tooling, not a subagent heartbeat

    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!data || typeof data !== 'object') continue;

    // Explicit discriminator: a genuine heartbeat always carries its OWN `id`
    // and `status` fields (never fall back to the filename — that's exactly
    // how recent-spawn.json/devswarm-*.json got misread as agents before).
    if (typeof data.id !== 'string' || !data.id) continue;
    if (typeof data.status !== 'string') continue;

    // Session scoping: only nudge for THIS session's own subagent. A
    // heartbeat that names a `session` must match payload.session_id exactly;
    // one from another session/project sharing this home dir is never ours.
    // A heartbeat with no `session` field at all predates this discriminator
    // and cannot be attributed to any session — treat as not-ours (fail-open
    // toward no block, never toward a nudge for an unverified owner).
    if (typeof data.session !== 'string' || !data.session) continue;
    if (!sessionId || data.session !== sessionId) continue;

    const id = data.id;
    const ts = (typeof data.ts === 'number' && Number.isFinite(data.ts)) ? data.ts : 0;
    if (!ts) continue; // no timestamp -> can't judge staleness -> skip (fail-open toward no nudge)

    const status = data.status;
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

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';

  let minMinutes = settingsGet('guards', 'silentAgentNudgeMin', DEFAULT_MIN);
  if (!Number.isFinite(minMinutes) || minMinutes < 1) minMinutes = DEFAULT_MIN;
  const thresholdMs = minMinutes * 60 * 1000;

  const now = Date.now();
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';

  let candidates = [];
  try { candidates = candidates.concat(transcriptCandidates(transcriptPath, now, thresholdMs)); } catch (_) { /* fail-open: skip this source */ }
  try { candidates = candidates.concat(heartbeatCandidates(home, now, thresholdMs, sessionId)); } catch (_) { /* fail-open: skip this source */ }

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
  // A resume starts a new life for the agent: the cap is per (agent, resume).
  const everKey = (id, resumedAtMs) => sessionId + '::' + id + (resumedAtMs ? '@r' + resumedAtMs : '');
  const EVER_NUDGED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const nextEverNudged = {};
  for (const k of Object.keys(everNudged)) {
    const ts = Number(everNudged[k]);
    if (Number.isFinite(ts) && (now - ts) < EVER_NUDGED_TTL_MS) nextEverNudged[k] = ts;
  }
  // Without a session id there is nothing safe to scope the hard cap to —
  // fall back to snapshot-only dedup rather than caping across unrelated
  // sessions.
  const hardCapped = sessionId ? stale.filter((c) => !Object.prototype.hasOwnProperty.call(nextEverNudged, everKey(c.id, c.resumedAtMs))) : stale;

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

  // STALE-BUILD DOWNGRADE (peer complaint #2): a newer anti-hall version was
  // already re-registered (installed_plugins.json) than this running hook
  // process — the fix, if any, may already be on disk waiting on a restart.
  // Skip the block WITHOUT persisting: a suppressed nudge must not burn the
  // once-per-agent cap, or the fixed build that loads after /reload-plugins
  // could never nudge for that agent.
  try {
    if (require('./lib/stop-version-gate.js').isStale(path.join(__dirname, '..'), { env: process.env, home })) {
      process.exit(0);
    }
  } catch (_) { /* fail-open: block normally on any error */ }

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
    for (const c of shownCandidates) nextEverNudged[everKey(c.id, c.resumedAtMs)] = now;
  }
  persist();

  const MAX_NAMED = 3;
  const shown = shownCandidates.slice(0, MAX_NAMED).map((c) => {
    const mins = Math.floor(c.age / 60000);
    return c.label + ' — silent ' + mins + 'm';
  }).join('; ');
  const more = shownCandidates.length > MAX_NAMED ? ', +' + (shownCandidates.length - MAX_NAMED) + ' more' : '';

  // SIGNATURE-ACK (peer complaint #1): a stable signature over the exact set
  // of currently-stale agent ids. Once the user has explicitly confirmed
  // this exact set is fine and the agent has acked it (see stop-ack.js), this
  // hook stays silent for it for the rest of the session — a DIFFERENT set
  // of stale agents is a new signature and nudges normally.
  const stopAck = require('./lib/stop-ack.js');
  const ackSubject = shownCandidates.map((c) => c.id).sort().join(',');
  const signature = stopAck.signatureFor(ackSubject);
  if (sessionId && stopAck.isAcked(home, sessionId, 'silent-agent-nudge', signature)) {
    process.exit(0);
  }

  const reason =
    'anti-hall silent-agent-nudge: ' + shownCandidates.length +
    ' of your own background subagent(s) have gone silent past the ' + minMinutes +
    'm threshold: ' + shown + more + '. This is advisory only — nothing was ' +
    'auto-killed. Check on ' + (shownCandidates.length === 1 ? 'it' : 'them') + ' (TaskOutput) or ' +
    're-dispatch with tighter scope if it is dead (TaskStop first, per orchestration rule I) ' +
    '— do not assume, verify. Set ANTIHALL_SILENT_AGENT_NUDGE=off to silence. ' +
    (sessionId ? stopAck.ackHint('silent-agent-nudge', signature, home, sessionId) : '');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0); // fail-open: never wedge a Stop
}
process.exit(0);
