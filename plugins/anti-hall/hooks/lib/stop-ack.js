'use strict';
// anti-hall :: stop-ack — ONE shared signature-ack mechanism for
// advisory-only Stop-hook nudges (silent-agent-nudge.js, tasklist-guard.js).
//
// PEER COMPLAINT this addresses (SkyCrew + tf3 Primaries, 2026-09-26):
// "When a blocking Stop hook fires on a condition I've already confirmed
// false, let me ack that exact signature for the session." devswarm-parent-
// gate.js already has an equivalent per-signature forced-ack (its own
// `intents`/`intentAcks` state, driven by `devswarm.js gate-intent
// --reason`), but that mechanism is deeply coupled to that gate's own
// blocking-set/escalation shape (see companion/lib/devswarm-gate-state.js) —
// NOT reused here on purpose, to avoid destabilizing its escalation-ceiling
// logic. silent-agent-nudge.js and tasklist-guard.js had NO user-triggered
// ack at all (only automatic same-snapshot dedup) — this module gives them
// one, generalized so any future nudge-class Stop hook can adopt it too.
//
// MECHANISM (documented skip-file entry, same shape convention as
// skip-guard.js's ~/.anti-hall/skip.json — the agent, not the user directly,
// writes it once the user has EXPLICITLY confirmed the condition is a false
// positive):
//   ~/.anti-hall/stop-ack/<sessionId>.json = {
//     "<hook>:<signature>": <unix-ms ackedAt>, ...
//   }
// A signature is `sha1(hook + '\x00' + subject).slice(0, 16)` — subject is a
// STABLE, content-derived string the caller controls (e.g. a sorted agent-id
// list, or an already-computed content hash) so the SAME condition always
// acks the SAME signature, and a genuinely different condition (new agent,
// new open task) never inherits an old ack.
//
// SCOPE: once acked, that exact (hook, signature) pair is ADVISORY for the
// rest of THIS session — the calling hook skips emitting `decision:block`
// entirely for it (Stop has no separate non-blocking channel; see
// docs/KB-claude-code-hooks.md row 11 — going silent IS the advisory form
// here). A changed signature (condition actually changed) is a NEW pair and
// blocks again normally — an ack never silences a hook forever, only this
// one confirmed-false condition.
//
// NEVER used for safety guards (command-guard/edit-guard/git-guard stay out
// of scope — callers opt in per call site; this file makes no global change).
//
// Pure Node built-ins. Fail-open: isAcked() returns false (stay blocking) on
// any read/parse error — a broken ack file must never silently suppress a
// real nudge. Self-prunes to the CURRENT session's own file only (state-prune
// sweeps siblings, mirroring every other per-session state file in this repo).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function stateDir(home) {
  return path.join(home, '.anti-hall', 'stop-ack');
}

const PREFIX = 'stop-ack';

function statePath(home, sessionId) {
  const safe = String(sessionId == null ? 'nosession' : sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return path.join(stateDir(home), PREFIX + '-' + safe + '.json');
}

// signatureFor(subject) -> stable 16-hex-char signature. `subject` should be
// a deterministic string built from the condition's own content (ids, hash),
// never wall-clock time or anything that changes without the condition
// itself changing.
function signatureFor(subject) {
  return crypto.createHash('sha1').update(String(subject == null ? '' : subject)).digest('hex').slice(0, 16);
}

function readState(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

function ackKey(hook, signature) {
  return String(hook) + ':' + String(signature);
}

// isAcked(home, sessionId, hook, signature) -> boolean. Fail-open: false on
// any error (missing home/sessionId, unreadable/corrupt file) — never
// suppress a nudge on unverifiable state. Kill switch:
// guards.stopAck=false / ANTIHALL_STOP_ACK=off disables the whole mechanism
// (every isAcked() call returns false — hooks block exactly as before this
// feature existed).
function isAcked(home, sessionId, hook, signature) {
  try {
    if (!home || !sessionId || !hook || !signature) return false;
    try {
      if (require('./settings.js').get('guards', 'stopAck', true, { home }) === false) return false;
    } catch (_) { /* settings unavailable -> proceed with the check */ }
    const state = readState(statePath(home, sessionId));
    const v = state[ackKey(hook, signature)];
    return Number.isFinite(v) && v > 0;
  } catch (_) {
    return false;
  }
}

// recordAck(home, sessionId, hook, signature, now) — best-effort, atomic
// write (tmp + rename). Never throws.
function recordAck(home, sessionId, hook, signature, now) {
  try {
    if (!home || !sessionId || !hook || !signature) return false;
    const p = statePath(home, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const state = readState(p);
    state[ackKey(hook, signature)] = Number.isFinite(now) ? now : Date.now();
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
    try {
      require('./state-prune.js').pruneStale({ stateDir: stateDir(home), prefix: PREFIX, keepFile: p });
    } catch (_) { /* best-effort */ }
    return true;
  } catch (_) {
    return false;
  }
}

// ackHint(hook, signature, home, sessionId) -> one sentence to append to a
// nudge's reason text, telling the agent how to ack it once the user has
// explicitly confirmed the condition is a false positive.
function ackHint(hook, signature, home, sessionId) {
  const p = statePath(home || os.homedir(), sessionId || 'nosession');
  return 'If the user has explicitly confirmed this exact condition is fine, ack it for the ' +
    'rest of this session (advisory only afterward, never blocks again for this exact signature) ' +
    'by writing {"' + ackKey(hook, signature) + '": ' + Date.now() + '} into ' + p + ' (merge with any existing keys).';
}

module.exports = { signatureFor, isAcked, recordAck, ackHint, statePath, stateDir };
