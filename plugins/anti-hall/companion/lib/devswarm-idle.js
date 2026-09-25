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
//   * EVERY tool call in it is mailbox-class: one
//     `node <path>/devswarm.js inbox|heartbeat|roster|mesh <plain args>`,
//     optionally `2>&1` and `| grep|head|tail|wc <plain args>` (provably
//     read-only; no chain, file redirect, substitution or other filter),
//     exactly `node <path>/devswarm-wake-watch.js` as a Monitor, CronList, a
//     mailbox CronCreate, a Cron/Monitor ToolSearch.
// SAFETY PRINCIPLE: in doubt, a turn is REAL — an extra reset only delays
// archiving; a false ping would archive a child mid-work. Background work
// (a background Agent/Bash launch with no final <task-notification>, or a
// turn_duration pendingBackgroundAgentCount > 0) reports pendingBackground,
// which blocks archiving outright; ping turns never hide it.
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
const MAILBOX_VERBS = new Set(['inbox', 'heartbeat', 'roster', 'mesh']);

// STRICT ALLOWLIST (safety review, 0.109): a command is mailbox-class only
// when it is ONE mailbox command, optionally followed by PROVABLY READ-ONLY
// output handling:
//   node <path>/devswarm.js <inbox|heartbeat|roster|mesh> <words> [2>&1] [| grep|head|tail|wc <words>]...
// A word is a plain token [A-Za-z0-9_@%+=:,./~-]+, a '...' literal, or a
// "..." string with no `$`, backtick or backslash; words are separated by
// spaces/tabs only. `2>&1` (fd duplication, no file) is allowed once, right
// after the mailbox command; `|` only between segments. ANY other shell
// syntax — `;` `&` `>`/`>>`/`<` to a file, `<(`, `$(`, backticks, `(` `{`,
// a newline, `||`, adjacent quoted pieces — or any other filter (python3,
// sed, sort, awk, jq, tee, xargs, ...), or `grep -f/--file`, is REAL work.
const WORD_RE = /[ \t]+|2>&1(?=[ \t|]|$)|\||'[^'\n]*'|"[^"$`\\\n]*"|[A-Za-z0-9_@%+=:,./~-]+/y;
const PIPE_FILTERS = new Set(['grep', 'head', 'tail', 'wc']);

// segments(cmd) -> [[word, ...], ...] split on `|` (the DUP token '2>&1' kept
// as a word), or null when anything outside the grammar above appears.
function segments(cmd) {
  const s = String(cmd == null ? '' : cmd);
  const segs = [[]];
  let prevWord = false; // the previous token was a word (no separator since)
  WORD_RE.lastIndex = 0;
  while (WORD_RE.lastIndex < s.length) {
    const at = WORD_RE.lastIndex;
    const m = WORD_RE.exec(s);
    if (!m || m.index !== at) return null;
    const t = m[0];
    if (/^[ \t]+$/.test(t)) { prevWord = false; continue; }
    if (t === '|') { if (!segs[segs.length - 1].length) return null; segs.push([]); prevWord = false; continue; }
    if (prevWord) return null; // adjacent pieces (e.g. 'a'b) — not provably one plain word
    const q = t[0];
    segs[segs.length - 1].push(t === '2>&1' ? { dup: true } : (q === '"' || q === "'") ? t.slice(1, -1) : t);
    prevWord = true;
  }
  if (!segs[segs.length - 1].length) return null;
  return segs;
}

function isReadOnlyFilter(words) {
  if (!words.length || typeof words[0] !== 'string' || !PIPE_FILTERS.has(words[0])) return false;
  for (const w of words.slice(1)) {
    if (typeof w !== 'string') return false; // no 2>&1 inside a filter
    if (words[0] === 'grep' && (/^--file(=|$)/.test(w) || /^-[A-Za-z0-9]*f/.test(w))) return false;
  }
  return true;
}

// mailboxCommand(cmd, scriptRe, verbs) -> true when cmd fits the grammar.
function mailboxCommand(cmd, scriptRe, verbs, allowTail) {
  const segs = segments(cmd);
  if (!segs) return false;
  const first = segs[0].slice();
  if (!allowTail && (segs.length > 1 || first.some((w) => typeof w !== 'string'))) return false;
  if (first.length && typeof first[first.length - 1] !== 'string') first.pop(); // trailing 2>&1
  if (first.some((w) => typeof w !== 'string')) return false;
  if (first.length < (verbs ? 3 : 2) || first[0] !== 'node' || !scriptRe.test(first[1])) return false;
  if (verbs && !verbs.has(first[2])) return false;
  return segs.slice(1).every(isReadOnlyFilter);
}

const isTrue = (v) => v === true || v === 'true';

// isMailboxTool(block) -> bool for one assistant tool_use block.
//   Bash    : `node <path>/devswarm.js <inbox|heartbeat|roster|mesh> <plain args>`
//             [2>&1] [| grep|head|tail|wc <plain args>]... (never backgrounded)
//   Monitor : exactly `node <path>/devswarm-wake-watch.js <plain args>`
function isMailboxTool(block) {
  const name = String((block && block.name) || '');
  const input = (block && block.input) || {};
  if (name === 'Bash') {
    if (isTrue(input.run_in_background)) return false;
    return mailboxCommand(input.command, /^(?:.*\/)?devswarm\.js$/, MAILBOX_VERBS, true);
  }
  if (name === 'Monitor') {
    return mailboxCommand(input.command, /^(?:.*\/)?devswarm-wake-watch\.js$/, null, false);
  }
  if (name === 'CronList') return true;
  if (name === 'CronCreate') return /devswarm\.js/.test(String(input.prompt || '')) && /\binbox\b/.test(String(input.prompt || ''));
  if (name === 'ToolSearch') {
    const q = String(input.query || '');
    return /^select:/.test(q) && q.slice(7).split(',').every((t) => /^(Cron(List|Create|Delete)|Monitor)$/.test(t.trim()));
  }
  return false;
}

// Background work (P1): a background Agent/Bash launch stays PENDING until a
// <task-notification> with the same task id (or tool-use id) reports a final
// status. Several notifications can share one text leaf; they reach the
// transcript as a user prompt, a queued_command attachment, or a queue-operation.
const BG_TOOLS = new Set(['Agent', 'Task', 'Bash']);
const FINAL_STATUS = /<status>\s*(completed|failed|stopped)\s*<\/status>/i;
function notificationTexts(e) {
  const out = [];
  const c = e && e.message && e.message.content;
  if (e.type === 'user') {
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  } else if (e.type === 'attachment' && e.attachment && typeof e.attachment.prompt === 'string') {
    out.push(e.attachment.prompt);
  } else if (e.type === 'queue-operation' && typeof e.content === 'string') {
    out.push(e.content);
  }
  return out.filter((t) => t.includes('<task-notification>'));
}
function finishedTaskKeys(text) {
  const keys = [];
  for (const m of String(text).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    if (!FINAL_STATUS.test(body)) continue;
    const tid = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body);
    const tu = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(body);
    if (tid) keys.push(tid[1]);
    if (tu) keys.push(tu[1]);
  }
  return keys;
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

// classifyTranscript(text, opts) -> { realTs, openRealTurn, pendingBackground,
// windowStartTs, pingTurns, realTurns }. Pure; exported for tests.
// pendingBackground is true when background work may still be running: a
// background Agent/Bash launch in the window with no final <task-notification>,
// or a turn_duration entry (of the latest real turn, or the newest one of any
// turn — a ping turn's count is still the truth) with
// pendingBackgroundAgentCount > 0.
function classifyTranscript(text, opts) {
  const o = opts || {};
  const turns = [];
  let cur = null;
  let cronFired = false;
  let windowStartTs = null;
  const bgLaunches = new Map(); // launch tool_use id -> true (pending)
  const bgAlias = new Map(); // task id / tool_use id -> launch tool_use id
  let lastBgCount = 0; // newest turn_duration pendingBackgroundAgentCount, any turn
  const open = (wake, ts) => { cur = { wake, tools: [], lastTs: ts, closed: false, prompted: true, bgCount: 0 }; turns.push(cur); };
  const orphan = (ts) => { cur = { wake: null, tools: [], lastTs: ts, closed: false, prompted: false, bgCount: 0 }; turns.push(cur); };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    const ts = tsOf(e);
    if (ts !== null && windowStartTs === null) windowStartTs = ts;
    for (const t of notificationTexts(e)) {
      for (const k of finishedTaskKeys(t)) { const id = bgAlias.get(k); if (id) bgLaunches.delete(id); }
    }
    if (e.type === 'system') {
      if (e.subtype === 'scheduled_task_fire') cronFired = true;
      else if ((e.subtype === 'stop_hook_summary' || e.subtype === 'turn_duration') && cur) cur.closed = true;
      if (e.subtype === 'turn_duration') {
        // The harness omits the field when the count is 0 (never observed as a
        // literal 0 in real transcripts); present but unparseable -> pending.
        const v = e.pendingBackgroundAgentCount;
        const n = v === undefined || v === null ? 0 : Number(v);
        lastBgCount = Number.isFinite(n) ? n : 1;
        if (cur) cur.bgCount = lastBgCount;
      }
      continue;
    }
    if (e.type === 'user') {
      const c = e.message && e.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result' || !bgLaunches.has(b.tool_use_id)) continue;
          if (b.is_error === true) { bgLaunches.delete(b.tool_use_id); continue; } // never started
          const r = e.toolUseResult;
          if (r && typeof r === 'object') {
            for (const k of [r.agentId, r.agent_id, r.backgroundTaskId, r.taskId, r.task_id]) {
              if (k != null && k !== '') bgAlias.set(String(k), b.tool_use_id);
            }
          }
        }
      }
      const p = promptText(e);
      // A harness-injected (isMeta) prompt opens a turn only when it is a
      // cron fire or a hook/notification wake; other meta lines (a skill body,
      // an image, a caveat) belong to the turn already running. The cron flag
      // belongs to the next META prompt only: a non-meta prompt (a human, or a
      // notification) consumes it and is judged on its own text, so a human
      // prompt is never classified as a wake.
      if (p !== null && !e.isMeta) { cronFired = false; open(wakeTrigger(p, false), ts); continue; }
      if (p !== null && (cronFired || wakeTrigger(p, false))) {
        open(wakeTrigger(p, cronFired), ts); cronFired = false; continue;
      }
      // tool_result / meta line: part of the current turn.
      if (!cur) orphan(ts);
      if (ts !== null) cur.lastTs = ts;
      cur.closed = false;
      continue;
    }
    if (e.type === 'assistant') {
      if (!cur) orphan(ts);
      const c = (e.message && Array.isArray(e.message.content)) ? e.message.content : [];
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        cur.tools.push(b);
        if (BG_TOOLS.has(String(b.name)) && b.input && isTrue(b.input.run_in_background) && b.id) {
          bgLaunches.set(String(b.id), true);
          bgAlias.set(String(b.id), String(b.id));
        }
      }
      if (ts !== null) cur.lastTs = ts;
      cur.closed = false;
    }
  }
  let realTs = null;
  let pingTurns = 0;
  let realTurns = 0;
  let openRealTurn = false;
  let lastReal = null;
  turns.forEach((t, i) => {
    const allMailbox = t.tools.every(isMailboxTool);
    // A turn whose prompt fell before the tail window (prompted:false) is
    // judged on its tools alone and needs at least one mailbox call.
    const ping = t.prompted ? (t.wake === true && allMailbox) : (t.tools.length > 0 && allMailbox);
    if (ping) { pingTurns++; return; }
    realTurns++;
    lastReal = t;
    if (Number.isFinite(t.lastTs) && (realTs === null || t.lastTs > realTs)) realTs = t.lastTs;
    if (i === turns.length - 1 && !t.closed) openRealTurn = true;
  });
  // No real turn in a TRUNCATED window: real work is at most as recent as the
  // window start, so that bound is used (never an older guess).
  if (realTs === null && o.truncated) realTs = windowStartTs;
  // No real turn in the WHOLE transcript: the session's first entry.
  if (realTs === null) realTs = windowStartTs;
  const pendingBackground = bgLaunches.size > 0 || lastBgCount > 0 || !!(lastReal && lastReal.bgCount > 0);
  return { realTs, openRealTurn, pendingBackground, windowStartTs, pingTurns, realTurns };
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

module.exports = { realActivity, classifyTranscript, isMailboxTool, TAIL_BYTES };
