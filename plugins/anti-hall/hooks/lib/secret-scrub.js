'use strict';
// secret-scrub.js — best-effort redaction of common secret shapes. Shared by
// every path that sends free text off-box (Jev gateway, Anthropic-direct
// judges) and by the opt-in local audit snippet. Pure, no I/O.

// scrubSecrets(text) -> text with common secret shapes replaced by a
// bracketed placeholder. Best-effort, not a security boundary by itself --
// combined with the 200-char cap and the opt-in default, it bounds what a
// snippet can leak. Order matters: named shapes (Bearer tokens, known key
// prefixes, key=/token= assignments, emails) are scrubbed BEFORE the generic
// long-alnum-run catch-all, so their placeholders (short) never re-trigger it.
function scrubSecrets(text) {
  if (typeof text !== 'string') return '';
  let s = text;
  // PEM blocks first (multi-line): header, body and footer all go.
  s = s.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[REDACTED_PEM]');
  // URL credentials: scheme://user:pass@host -> scheme://[REDACTED]@host
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // JWTs (three base64url segments, first starts with eyJ).
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  // Authorization header values (Basic base64 / Bearer), whole value incl. + / =.
  s = s.replace(/\b(Authorization["']?\s*[:=]\s*["']?)(Basic|Bearer)\s+[^\s"']+/gi, '$1$2 [REDACTED]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9\-_.=]+/gi, 'Bearer [REDACTED]');
  // Standalone provider tokens: Stripe (sk_/rk_ live|test), GitLab PAT, npm.
  s = s.replace(/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]');
  s = s.replace(/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\b(sk|pk)-[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_KEY]');
  // AWS access key ids (long-term AKIA, temporary ASIA).
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  // Any identifier CONTAINING secret/password/passwd/token/apikey/api_key/key,
  // then optional spaces and ':' or '=' — AWS_SECRET_ACCESS_KEY=…,
  // DB_PASSWORD=short, "apiKey": "…". Values of any length (>=1 char).
  // Quoted values may hold spaces (SECRET_KEY = "a b c"): redact to the closing quote.
  s = s.replace(/\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|apikey|api_key|key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["'])(?:(?!\3)[^\n])*\3/gi, '$1$2[REDACTED]');
  s = s.replace(/\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|apikey|api_key|key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)[^\s"',}]+\3/gi, '$1$2[REDACTED]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  // Generic catch-all: any remaining long base64/hex-ish run (>=32 chars) is
  // treated as a likely token/credential fragment, whatever it actually is.
  s = s.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[REDACTED_TOKEN]');
  return s;
}

module.exports = { scrubSecrets };
