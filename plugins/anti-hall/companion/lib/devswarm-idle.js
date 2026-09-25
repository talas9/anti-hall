'use strict';
// anti-hall :: devswarm-idle — "real work" activity for the auto-archive idle
// gate (devswarm-lifecycle.js gate g), 0.109.0.
//
// ROOT CAUSE this exists for: gate (g) measured idle from the NEWEST of the
// heartbeat file ts and the session transcript mtime (liveness.readActivityTs).
// A finished child keeps being woken by its OWN mailbox cron / Monitor watcher /
// Stop-hook self-report nag. Every wake is a full turn: the UserPromptSubmit
// hook rewrites heartbeats/<id>.json (devswarm-child-turn.js writeHeartbeat),
// `inbox tick` rewrites it again (scripts/devswarm.js cmdInboxTick effect 2),
// and every line appends to the transcript. So both signals refresh every wake
// and the idle clock never expires (field: SkyCrew workspace 1842f5f8 — wake
// turns every ~10-30 min, each only `inbox tick` / `inbox read-primary` /
// `heartbeat` / a Monitor re-arm).
//
// FIX (the data supports it: the transcript records each turn's trigger and
// every tool call): classify the transcript turn by turn and IGNORE only the
// child's own mailbox-wake / ping / heartbeat / status-report turns. A turn is
// PING-ONLY when BOTH hold:
//   * its trigger is a wake: a cron fire (system scheduled_task_fire), a
//     mailbox-wake Monitor notification, or a Stop-hook feedback prompt — a
//     prompt a human typed is never a wake;
//   * EVERY tool call in it is mailbox-class: `devswarm.js inbox|heartbeat|
//     roster|mesh|wake-directive` (plus harmless output filters), the wake
//     watcher Monitor, CronList, a mailbox CronCreate, a Cron/Monitor ToolSearch.
// Anything else is REAL and resets idle: any other tool (Read, Grep, Bash,
// Agent, AskUserQuestion, `devswarm.js send|done|gate`, ...), and any turn a
// human started. A turn that is still OPEN (no stop_hook_summary/turn_duration
// after its last entry) and is real means an AI turn is live -> never idle.
//
// Unknown -> { known:false } and the caller keeps the pre-0.109 rule (heartbeat
// + transcript mtime), which can only block, never archive early. Unknown is:
// no sessionId, no/unreadable transcript, or a heartbeat written by a DIFFERENT
// session than the descriptor names (a restarted child whose new transcript
// this reader cannot see).
//
// Pure fs reads, bounded (tail window), never throws, never writes.

const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 2 * 1024 * 1024;
const MAILBOX_VERBS = new Set(['inbox', 'heartbeat', 'roster', 'mesh', 'wake-directive']);
const FILTER_CMDS = new Set(['head', 'tail', 'jq', 'wc', 'grep', 'tr', 'sort', 'uniq', 'cut']);

// splitShell(cmd) -> [{ seg, piped }] | null. Quote-aware split on ; && ||
// | and newlines; `piped` is true when the segment reads the previous one's
// stdout (a `|`). null (= not classifiable, treated as real work) when the
// command uses command substitution, backticks, a background `&`, or has an
// unterminated quote.
function splitShell(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let q = null;
  let piped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && (ch === '`' || (ch === '$' && s[i + 1] === '('))) return null;
      else if (q === '"' && ch === '\\') { cur += ch + (s[i + 1] || ''); i++; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '`' || (ch === '$' && s[i + 1] === '(')) return null;
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      // `2>&1` / `>&2` are redirects, not separators.
      if (ch === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) { cur += ch; continue; }
      if (ch === '&' && s[i + 1] !== '&') return null; // a background `&` — not a status ping
      const pipe = ch === '|' && s[i + 1] !== '|';
      if ((ch === '|' || ch === '&') && s[i + 1] === ch) i++;
      if (cur.trim()) out.push({ seg: cur.trim(), piped });
      piped = pipe;
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (q) return null;
  if (cur.trim()) out.push({ seg: cur.trim(), piped });
  return out;
}

function unquote(t) { return String(t || '').replace(/^["']|["']$/g, ''); }

// isMailboxSegment({seg, piped}) — `node <.../devswarm.js | "$CLI"> <mailbox
// verb> ...`, `CLI=<.../devswarm.js>`, `cd <dir>`, or — only when reading a
// pipe — an output filter (a `python3 -c` / `sed` that could write files is
// accepted only as a pipe reader, and `sed -i` never).
function isMailboxSegment(part) {
  const seg = part.seg;
  const toks = seg.split(/\s+/);
  if (/^CLI=/.test(toks[0]) && toks.length === 1 && /devswarm\.js["']?$/.test(toks[0])) return true;
  if (toks[0] === 'cd' && toks.length === 2) return true;
  if (part.piped) {
    if (FILTER_CMDS.has(toks[0])) return true;
    if (toks[0] === 'sed' && !toks.some((t) => /^-[a-zA-Z]*i/.test(t) || t === '--in-place')) return true;
    if ((toks[0] === 'python3' || toks[0] === 'python') && toks[1] === '-c') return true;
  }
  if (toks[0] !== 'node' || toks.length < 3) return false;
  const script = unquote(toks[1]);
  if (!(/(^|\/)devswarm\.js$/.test(script) || script === '$CLI' || script === '${CLI}')) return false;
  return MAILBOX_VERBS.has(toks[2]);
}

// isMailboxTool(block) -> bool for one assistant tool_use block.
function isMailboxTool(block) {
  const name = String((block && block.name) || '');
  const input = (block && block.input) || {};
  if (name === 'Bash') {
    const segs = splitShell(input.command);
    return !!(segs && segs.length && segs.every(isMailboxSegment));
  }
  if (name === 'Monitor') return /devswarm-wake-watch\.js/.test(String(input.command || ''));
  if (name === 'CronList') return true;
  if (name === 'CronCreate') return /devswarm\.js/.test(String(input.prompt || '')) && /\binbox\b/.test(String(input.prompt || ''));
  if (name === 'ToolSearch') {
    const q = String(input.query || '');
    return /^select:/.test(q) && q.slice(7).split(',').every((t) => /^(Cron(List|Create|Delete)|Monitor)$/.test(t.trim()));
  }
  return false;
}

function promptText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    const t = c.find((b) => b && b.type === 'text');
    return t ? String(t.text || '') : '';
  }
  return null;
}

// wakeTrigger(text, cronFired) -> true when the prompt is the child's own wake.
function wakeTrigger(text, cronFired) {
  if (cronFired) return true;
  const t = String(text || '').trimStart();
  if (t.startsWith('<task-notification>')) return /mailbox wake|wake-watch/i.test(t);
  if (t.startsWith('Stop hook feedback:')) return true;
  return false;
}

function tsOf(e) {
  const t = Date.parse(e && e.timestamp);
  return Number.isFinite(t) ? t : null;
}

// readTail(file, fsi) -> { text, truncated } | null.
function readTail(file, F) {
  let fd = null;
  try {
    const size = F.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    fd = F.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    F.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
    return { text, truncated: start > 0 };
  } catch (_) {
    return null;
  } finally { try { if (fd !== null) F.closeSync(fd); } catch (_) {} }
}

// classifyTranscript(text, opts) -> { realTs, openRealTurn, windowStartTs,
// pingTurns, realTurns }. Pure; exported for tests.
function classifyTranscript(text, opts) {
  const o = opts || {};
  const turns = [];
  let cur = null;
  let cronFired = false;
  let windowStartTs = null;
  const open = (wake, ts) => { cur = { wake, tools: [], lastTs: ts, closed: false, prompted: true }; turns.push(cur); };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    const ts = tsOf(e);
    if (ts !== null && windowStartTs === null) windowStartTs = ts;
    if (e.type === 'system') {
      if (e.subtype === 'scheduled_task_fire') cronFired = true;
      else if ((e.subtype === 'stop_hook_summary' || e.subtype === 'turn_duration') && cur) cur.closed = true;
      continue;
    }
    if (e.type === 'user') {
      const p = promptText(e);
      // A harness-injected (isMeta) prompt opens a turn only when it is a
      // cron fire or a hook/notification wake; other meta lines (a skill body,
      // an image, a caveat) belong to the turn already running.
      if (p !== null && (!e.isMeta || cronFired || wakeTrigger(p, false))) {
        open(wakeTrigger(p, cronFired), ts); cronFired = false; continue;
      }
      // tool_result / meta line: part of the current turn.
      if (!cur) { cur = { wake: null, tools: [], lastTs: ts, closed: false, prompted: false }; turns.push(cur); }
      if (ts !== null) cur.lastTs = ts;
      cur.closed = false;
      continue;
    }
    if (e.type === 'assistant') {
      if (!cur) { cur = { wake: null, tools: [], lastTs: ts, closed: false, prompted: false }; turns.push(cur); }
      const c = (e.message && Array.isArray(e.message.content)) ? e.message.content : [];
      for (const b of c) if (b && b.type === 'tool_use') cur.tools.push(b);
      if (ts !== null) cur.lastTs = ts;
      cur.closed = false;
    }
  }
  let realTs = null;
  let pingTurns = 0;
  let realTurns = 0;
  let openRealTurn = false;
  turns.forEach((t, i) => {
    const allMailbox = t.tools.every(isMailboxTool);
    // A turn whose prompt fell before the tail window (prompted:false) is
    // judged on its tools alone and needs at least one mailbox call.
    const ping = t.prompted ? (t.wake === true && allMailbox) : (t.tools.length > 0 && allMailbox);
    if (ping) { pingTurns++; return; }
    realTurns++;
    if (Number.isFinite(t.lastTs) && (realTs === null || t.lastTs > realTs)) realTs = t.lastTs;
    if (i === turns.length - 1 && !t.closed) openRealTurn = true;
  });
  // No real turn in a TRUNCATED window: real work is at most as recent as the
  // window start, so that bound is used (never an older guess).
  if (realTs === null && o.truncated) realTs = windowStartTs;
  // No real turn in the WHOLE transcript: the session's first entry.
  if (realTs === null) realTs = windowStartTs;
  return { realTs, openRealTurn, windowStartTs, pingTurns, realTurns };
}

// realActivity(desc, home, opts) -> { known, ts, openRealTurn, reason, ... }.
function realActivity(desc, home, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const liveness = require('./liveness.js');
  const id = desc && desc.id != null ? String(desc.id) : null;
  if (!id || !desc.sessionId || !desc.worktreePath) return { known: false, reason: 'no session id' };
  try {
    const beat = JSON.parse(F.readFileSync(liveness.heartbeatPathFor(id, home), 'utf8'));
    if (beat && beat.sessionId && String(beat.sessionId) !== String(desc.sessionId)) {
      return { known: false, reason: 'heartbeat from another session' };
    }
  } catch (_) { /* no/unsafe/torn heartbeat: the transcript alone decides */ }
  let file;
  try { file = path.join(liveness.projectDirFor(desc.worktreePath, home), String(desc.sessionId) + '.jsonl'); }
  catch (_) { return { known: false, reason: 'no transcript path' }; }
  const tail = readTail(file, F);
  if (!tail || !tail.text) return { known: false, reason: 'transcript unreadable' };
  const r = classifyTranscript(tail.text, { truncated: tail.truncated });
  if (!Number.isFinite(r.realTs)) return { known: false, reason: 'no timestamps' };
  return Object.assign({ known: true, ts: r.realTs }, r);
}

module.exports = { realActivity, classifyTranscript, isMailboxTool, splitShell, TAIL_BYTES };
