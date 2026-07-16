'use strict';
// anti-hall :: devswarm-noise — two SEPARATE checks that happen to live in
// one file for organizational convenience (both are #67/ghost-fix era
// classifiers). They do NOT both consume POKE_PREFIX — only isNoiseText does:
//   - isForwardableRow(msg) — scripts/devswarm.js's isForwardable (#67
//     retire-forward filter), a purely STRUCTURAL rule over STORE-shaped rows
//     (mtype/sender/recipient/isHeartbeat). Body text plays NO part in it.
//   - isNoiseText(text) — devswarm-parent-gate.js's Stop-hook realUnread
//     count, applied to descriptor durable-inbox NDJSON rows' `.message`
//     (this shape carries NO mtype/sender/recipient/isHeartbeat at all; every
//     row is native-pulled, so its `_h` is ALWAYS `native:`-prefixed by
//     construction — there is no structural signal on THIS shape the way
//     there is in the store, so the gate has only the text marker to go on).
// These are NOT the same classifier layered on different shapes — the store
// has a reliable structural signal (mtype/sender/recipient) and uses ONLY
// that; the descriptor-inbox shape has none, so the gate falls back to text.
// Extracted here only so POKE_PREFIX itself can never drift between the two.
//
// Pure, synchronous, no fs/state. Never throws.

// POKE_PREFIX — the marker hivecontrol's own nudge notices carry when they are
// mirrored back through the native queue (anti-hall does not generate this
// text; it only recognizes it). A message that is really just the Primary's
// own poke bouncing back is not something a human needs to act on.
const POKE_PREFIX = '[Primary poke]';

// isNoiseText(text) -> bool. True when `text` (a message body/display string)
// is a Primary-generated poke/mirror notice. Non-string / empty -> false
// (never speculatively noise — an ambiguous or absent text field must NOT be
// treated as noise by this check; callers that need fail-open-to-real for a
// missing/malformed row handle that themselves, since this function only
// judges TEXT it was actually given). PREFIX match only (trimStart+startsWith),
// NOT a substring/contains check — a genuine message that merely mentions or
// echoes the phrase mid-body is never misclassified as noise; only a message
// that literally OPENS with the marker is. Investigated (v0.55.x P0-1): the
// native-pulled row this is applied to (devswarm-pull.js) carries no
// provenance field distinguishing a system poke from a genuine child message
// — every row is shaped identically ({_h, fromBranch, message, createdAt,
// status}) with `_h` always `native:`-prefixed regardless of origin — so this
// remains a residual, documented assumption: a genuine child never authors a
// message that itself OPENS with the exact `[Primary poke]` text.
function isNoiseText(text) {
  return typeof text === 'string' && text.trimStart().startsWith(POKE_PREFIX);
}

// isForwardableRow(msg) — the #67 STORE-row rule, byte-for-byte unchanged
// from its original shipped form (now just extracted here so it lives beside
// the shared POKE_PREFIX text). A forwardable row must be a real mesh direct
// — mtype==='direct' (excludes broadcast, heartbeat, and every null-mtype
// native/poke/hash-mirror row, since native ingest never sets mtype) with a
// non-empty sender AND recipient. Deliberately NOT body-text-filtered: a
// structurally-valid direct (real mtype/sender/recipient — i.e. actually
// mesh-`send`) is a genuine message regardless of what its body says, and a
// human could legitimately author or quote text starting with the poke
// marker. `isNoiseText` (below) is for the GATE's descriptor-inbox rows,
// which carry NO mtype/sender/recipient at all and so have no structural
// signal to fall back on — it must not ALSO gate store-row forwarding here.
function isForwardableRow(msg) {
  if (!msg || msg.isHeartbeat) return false;
  if (msg.mtype !== 'direct') return false;
  const sender = msg.sender != null ? String(msg.sender).trim() : '';
  const recipient = msg.recipient != null ? String(msg.recipient).trim() : '';
  return sender !== '' && recipient !== '';
}

module.exports = { POKE_PREFIX, isNoiseText, isForwardableRow };
