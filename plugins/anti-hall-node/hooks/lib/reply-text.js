// anti-hall :: reply-text — which text a Stop/SubagentStop hook should judge.
//
// At Stop time the transcript may not yet contain the reply being stopped, so a
// transcript-tail read can return the PREVIOUS turn's message. The Stop and
// SubagentStop payloads carry the reply itself in `last_assistant_message`
// (docs/KB-claude-code-hooks.md rows 11 and 28; Codex's Stop payload uses the
// same field name, docs/KB-handover-research.md). Prefer it; fall back to the
// transcript only when it is absent, not a string, or blank.
//
// Pure Node built-ins only.

'use strict';

// payloadReplyText(payload) -> string | null. The payload's own reply text when
// it is a non-blank string, else null.
function payloadReplyText(payload) {
  const v = payload && payload.last_assistant_message;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// selectReplyText(payload, fromTranscript) -> string | null. `fromTranscript`
// is the caller's existing transcript extraction, called only on fallback.
function selectReplyText(payload, fromTranscript) {
  const own = payloadReplyText(payload);
  if (own !== null) return own;
  return typeof fromTranscript === 'function' ? fromTranscript() : null;
}

module.exports = { payloadReplyText, selectReplyText };
