#!/usr/bin/env node
// phase-bar.js — anti-hall line-2 renderer (ALWAYS ON, hybrid).
//
//   - If a FRESH orchestration phase-state exists -> phase progress bar:
//       [████◐──────────] 40% | P2 - build api 2/5 | 12m | 3 agents | step
//   - Otherwise -> context-window usage bar, from the session JSON on stdin:
//       [███████████◐────────] 56% context · 128k/230k tokens
//
// The dispatcher (statusline.js) passes the same session JSON it received on its
// own stdin to this script's stdin, so the context bar has real data. This makes
// line 2 ALWAYS present (the plugin ships both lines), never blank, never stale.
//
// Fail-open: any error prints nothing and exits 0. No emoji. OS-agnostic. Pure Node.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// --- Phase state (line-2 primary source) ------------------------------------
// Read state from a location consistent across ALL processes. os.tmpdir() is
// NOT reliable here: the statusline runner's TMPDIR can differ from a hook's or
// a tool's, so a state file written under one tmpdir is invisible to another.
// os.homedir() is identical for every process; check it first, tmpdir as fallback.
const STATE_CANDIDATES = [
  path.join(os.homedir(), '.anti-hall', 'phase-state.json'),
  path.join(os.tmpdir(),  'anti-hall', 'phase-state.json'),
];
// Hide a phase bar whose state file has not been touched recently. An active
// orchestration rewrites phase-state.json on every set/advance/step/agents call
// (and the watchdog heartbeat is well under this window), so a fresh run always
// renders. A run that ended without calling `phase.js clear` leaves an ORPHAN
// state file; once its mtime ages past STALE_MS we treat it as absent (and fall
// through to the context bar) so the bar never shows a frozen, stale phase.
const STALE_MS = 30 * 60 * 1000; // 30 minutes

function readState() {
  for (const f of STATE_CANDIDATES) {
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs > STALE_MS) continue; // stale orphan -> treat as absent
      return fs.readFileSync(f, 'utf8');
    } catch (e) { /* missing/unreadable -> try next */ }
  }
  return null;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

// safeLabel — strip terminal-escape injection from dynamic text rendered into
// the statusline. A crafted phase desc / code / step (written to phase-state by
// a tool) or a branch name could carry ANSI/OSC/C0/C1 control sequences that
// move the cursor, recolor the whole line, set the window title (OSC), or smuggle
// hidden text. We render with our OWN ANSI codes, so any escape from DATA is an
// injection. Drop: ESC-introduced sequences (CSI/OSC/other), bare C0 (except none
// kept), DEL, and C1 control bytes. Cheap (linear) + fail-open (returns '' on a
// non-string). Apply to every field rendered from cwd/git/phase-state.
function safeLabel(s) {
  if (typeof s !== 'string') return '';
  return s
    // OSC: ESC ] ... (BEL | ESC \) — window-title / hyperlink injection.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // CSI and other ESC-introduced sequences.
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\x1b./g, '')
    // Bare C0 control chars (incl. newlines/tabs) + DEL + C1 range.
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    // Unicode bidi overrides (U+202A–U+202E) + isolates (U+2066–U+2069):
    // survive the C0/C1 strip but visually reorder terminal output.
    .replace(/[‪-‮⁦-⁩]/g, '');
}

const BAR_WIDTH = 20;
// Rotating half-disc (Unicode geometric shapes, cross-OS: macOS/Linux/Windows
// Terminal). Full-bodied so it aligns with the block fill and reads as a clear
// "work head" at the progress frontier. 4 frames -> snappy even at a 1s refresh.
const SPINNER = ['◐', '◓', '◑', '◒'];

// Time-cycled spinner so the bar "spins" each statusline refresh, giving a
// live/working feel even between activity.
function spinner() {
  return SPINNER[Math.floor(Date.now() / 1000) % SPINNER.length];
}

// ANSI colors (not emojis). Statusline output is rendered with ANSI by Claude Code.
const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m',
  dim: '\x1b[2m', bold: '\x1b[1m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', white: '\x1b[97m', blue: '\x1b[34m',
};

// Progress bar with a moving spinner head at the fill frontier (for the phase bar).
function renderBar(done, total, color) {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  const empty   = BAR_WIDTH - clamped;
  return '[' + (color || C.green) + '█'.repeat(clamped) + C.reset +
         C.cyan + spinner() + C.reset +
         C.dim + '─'.repeat(empty) + C.reset + ']';
}

// Static level bar (no spinner) for the context gauge — it is a level, not motion.
function renderLevelBar(pct, color) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * BAR_WIDTH);
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  const empty   = BAR_WIDTH - clamped;
  return '[' + color + '█'.repeat(clamped) + C.reset +
         C.dim + '─'.repeat(empty) + C.reset + ']';
}

function levelColor(pct) {
  return pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.green;
}

function kfmt(n) {
  return Math.abs(n) >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));
}

// --- Line 2 case A: orchestration phase bar ---------------------------------
function phaseBarLine() {
  const raw = readState();
  if (raw === null) return null;
  let state;
  try { state = JSON.parse(raw); } catch (e) { return null; }

  const code  = safeLabel((state.code || '').toString()).trim();
  let   desc  = safeLabel((state.desc || '').toString()).trim();
  const done  = parseInt(state.done,  10);
  const total = parseInt(state.total, 10);
  if (!code || !desc || isNaN(done) || isNaN(total) || total <= 0) return null;

  if (desc.length > 32) desc = desc.slice(0, 31) + '...';
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const bar = renderBar(done, total, C.green);

  const extras = [];
  const started = parseInt(state.started, 10);
  if (!isNaN(started) && started > 0) {
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const human = secs >= 3600 ? Math.floor(secs / 3600) + 'h' + Math.floor((secs % 3600) / 60) + 'm'
                : secs >= 60   ? Math.floor(secs / 60) + 'm'
                :                secs + 's';
    extras.push((secs > 1200 ? C.yellow : C.dim) + human + C.reset);
  }
  const agents = parseInt(state.agents, 10);
  if (!isNaN(agents) && agents >= 0) {
    extras.push(C.blue + agents + (agents === 1 ? ' agent' : ' agents') + C.reset);
  }
  let step = safeLabel((state.step || '').toString()).trim();
  if (step) {
    if (step.length > 28) step = step.slice(0, 27) + '...';
    extras.push(C.dim + step + C.reset);
  }
  const extraStr = extras.length ? ` ${C.dim}|${C.reset} ` + extras.join(' ') : '';

  return `${bar} ${C.yellow}${pct}%${C.reset} ${C.dim}|${C.reset} ` +
         `${C.bold}${C.magenta}${code}${C.reset} ${C.dim}-${C.reset} ${C.white}${desc}${C.reset} ` +
         `${C.cyan}${done}/${total}${C.reset}${extraStr}`;
}

// --- Line 2 case B (fallback): context-window usage bar ----------------------
function contextLine(input) {
  let data;
  try { data = JSON.parse(input); } catch (e) { return null; }
  const cw = data && data.context_window;
  if (!cw || typeof cw !== 'object') return null;

  let pct = cw.used_percentage;
  if (typeof pct !== 'number') {
    if (typeof cw.remaining_percentage === 'number') pct = 100 - cw.remaining_percentage;
    else return null;
  }
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const col = levelColor(pct);
  const bar = renderLevelBar(pct, col);

  // Optional token counts — only if the harness actually provides them.
  let tokens = '';
  const used = (typeof cw.used_tokens === 'number') ? cw.used_tokens
             : (typeof cw.tokens === 'number') ? cw.tokens : null;
  const max  = (typeof cw.max_tokens === 'number') ? cw.max_tokens
             : (typeof cw.total_tokens === 'number') ? cw.total_tokens
             : (typeof cw.context_size === 'number') ? cw.context_size : null;
  if (used != null && max != null && max > 0) {
    tokens = ` ${C.dim}·${C.reset} ${C.dim}${kfmt(used)}/${kfmt(max)} tokens${C.reset}`;
  }

  return `${bar} ${col}${pct}%${C.reset} ${C.dim}context${C.reset}${tokens}`;
}

// --- Line 2 case A2: auto-tracked live swarm activity ------------------------
// When no semantic phase-state was set by the coordinator but subagents are
// actively spawning (recorded by the phase-tracker hook in a HOMEDIR log), show
// an animated "orchestrating" bar so a running swarm is visible with ZERO
// coordinator effort.
const SPAWN_LOG   = path.join(os.homedir(), '.anti-hall', 'agent-spawns.log');
const ACTIVITY_MS = 2 * 60 * 1000; // "active" if a subagent spawned in the last 2 min

function recentSpawns() {
  try {
    const now = Date.now();
    return fs.readFileSync(SPAWN_LOG, 'utf8').trim().split(/\r?\n/)
      .map(n => parseInt(n, 10))
      .filter(n => Number.isFinite(n) && (now - n) < ACTIVITY_MS).length;
  } catch (e) { return 0; }
}

// Indeterminate "working" bar: a lit cell sweeps across (no known done/total).
function renderSweep() {
  const pos = Math.floor(Date.now() / 400) % BAR_WIDTH;
  let cells = '';
  for (let i = 0; i < BAR_WIDTH; i++) {
    cells += (i === pos) ? (C.cyan + '█' + C.reset) : (C.dim + '─' + C.reset);
  }
  return '[' + cells + ']';
}

function activityLine() {
  const n = recentSpawns();
  if (n <= 0) return null;
  return `${renderSweep()} ${C.cyan}orchestrating${C.reset} ${C.dim}·${C.reset} ` +
         `${C.blue}${n} agent${n === 1 ? '' : 's'}${C.reset} ${C.dim}active${C.reset}`;
}

// --- Main: phase bar (coordinator) > live activity (auto) > context gauge -----
try {
  const input = readStdin();
  let line = phaseBarLine();                 // 1. semantic phase set via phase.js
  if (line === null) line = activityLine();  // 2. auto-tracked live swarm activity
  if (line === null) line = contextLine(input); // 3. idle context-window gauge
  if (line) process.stdout.write(line + '\n');
} catch (e) {
  process.exit(0); // fail-open
}
