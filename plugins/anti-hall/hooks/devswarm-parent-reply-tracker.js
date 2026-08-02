#!/usr/bin/env node
// anti-hall :: devswarm-parent-reply-tracker (PostToolUse, matcher Bash, Primary only)
//
// Observation mechanism for PLAN §4.3 (see
// docs/superpowers/specs/2026-08-02-devswarm-parent-decide-gate.md §4.3). Watches
// every Bash tool call for a successful `devswarm.js send --to <id>
// --question ...`-style DIRECT send, and records it via
// companion/lib/devswarm-reply-state.js's recordReply() so the Stop-gate
// (devswarm-parent-gate.js) can tell "read" apart from "decided and replied",
// letting an unanswered child question keep blocking past the forced-ack cap
// while a genuine reply clears it.
//
// PER-PROJECT SCOPING (fix-wave, was per-Claude-session_id — WRONG): this hook
// originally keyed the recorded reply by the PostToolUse payload's
// `session_id`. That broke the moment devswarm-store.js's computeSummary made
// `pendingQuestions` PERMANENT (never cursor-scoped) — a reply record must
// share that SAME durable lifetime or every new Claude session starts with an
// empty (session-keyed) reply-state file and every already-answered question
// resurrects as unanswered. This hook now resolves a durable per-project
// `repoKey` from the payload's `cwd` (via `findGitToplevel` +
// devswarm-repokey.js's `repoKeyForWorktree` — resolveRepoKey below,
// replicating the SAME resolution devswarm-parent-gate.js/
// devswarm-parent-inbox.js already do) and records the reply under THAT key
// instead — matching the gate/inbox hooks' own reply-state reads.
//
// PAYLOAD CONTRACT — CONFIRMED, not assumed (2026-08-02, per spec §7 item 1):
// this plugin had no prior PostToolUse hook to copy from, so before writing this
// file the exact field names were verified directly against the shipped Claude
// Code agent runtime (@anthropic-ai/claude-agent-sdk's cli.js bundle — the same
// hook-dispatch code path the `claude` CLI binary runs), NOT guessed:
//   hookInput = { ...WE(ctx), hook_event_name: 'PostToolUse', tool_name,
//                 tool_input, tool_response, tool_use_id }
// (source line, minified: `hook_event_name:"PostToolUse",tool_name:A,
// tool_input:B,tool_response:G,tool_use_id:Q`). For the Bash tool specifically,
// `tool_response` is NOT a raw string — its own zod outputSchema (same bundle)
// is `{ stdout: string, stderr: string, summary?: string, ... }`, confirmed via
// a live consumer in the same bundle that does
// `qD0.safeParse(A.tool_response)` then destructures `{stdout, stderr}`. So
// cmdSend's one JSON line (scripts/devswarm.js, `fs.writeSync(1,
// JSON.stringify(out) + '\n')`) lands in `tool_response.stdout` — that is what
// this hook parses. A bare-string `tool_response` is ALSO accepted defensively
// (extractResponseText below), since the fail-open contract must survive a
// shape surprise on a future/other harness build either way. A top-level
// `timestamp` field on the PostToolUse payload itself was NOT confirmed in the
// same source dig — recordReply falls back to Date.now() when absent, which is
// harmless (recordReply is monotonic: max(existing, ts)).
//
// OBSERVE-ONLY: this hook never emits a `decision` field, never blocks, and
// writes NOTHING to stdout on any pass — a silent side-effecting hook, matching
// the fact that PostToolUse stdout/additionalContext has no bearing on gating
// (PostToolUse "observes only", KB-claude-codex.md) and there is no reason to
// inject additionalContext for a pure fs side effect. Fail-open on EVERY error:
// malformed JSON, non-Bash tool, non-Primary session, wrong response shape,
// missing fields — all silently no-op.
//
// ANTI-SPOOF GUARD: the parsed `tool_response.stdout` shape alone is NOT
// trusted — any Bash command whose stdout happens to look like a send
// response (e.g. `cat` of a fixture, or `echo`) would otherwise be
// indistinguishable from a real send. Before trusting the shape,
// `tool_input.command` must also plausibly BE a `devswarm.js send` call
// (looksLikeDevswarmSend below). This is a cheap defense-in-depth heuristic,
// not a cryptographic guarantee. Also: a dedupe hit (`sent:false` — cmdSend's
// `sent: !!res.inserted`, scripts/devswarm.js) means nothing was newly
// inserted, so it is not recorded as a reply either.
//
// Contract (Claude Code PostToolUse hook):
//   stdin  : JSON { hook_event_name?, tool_name, tool_response, cwd?, ... } —
//            `cwd` (when present) resolves the repoKey the reply is recorded
//            under (see PER-PROJECT SCOPING above); absent/unresolvable cwd
//            fails open (recordReply is skipped, never guessed).
//   stdout : nothing, ever (this hook never emits decision/additionalContext)
//   exit 0 : always — fail-open on any error so a bug never affects the session.
//
// Pure Node built-ins. Cross-platform. Fail-open on EVERY error.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { recordReply } = require('../companion/lib/devswarm-reply-state.js');

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs
// walk-up looking for a `.git` entry — the same root `git rev-parse
// --show-toplevel` would report, WITHOUT spawning git. Mirrors
// devswarm-parent-gate.js / devswarm-parent-inbox.js BYTE-FOR-BYTE (kept as a
// local copy rather than a shared require, matching this codebase's existing
// convention for this exact primitive — see those files' own copies).
function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

// resolveRepoKey(cwd) -> repoKey | null. The SAME durable per-project
// identity devswarm-parent-gate.js's `selfKey` and devswarm-parent-inbox.js's
// `repoKey` already resolve (companion/lib/devswarm-repokey.js's
// repoKeyForWorktree) — replicated here via the SAME
// findGitToplevel-then-repoKeyForWorktree idiom so all three hooks agree on
// what one project's key is; a mismatch between how this tracker resolves it
// and how the gate/inbox hooks do would silently reintroduce the exact
// session-scoping bug this fix closes. Lazy-required + try/catch (D27
// idiom, matching the sibling hooks) so a missing/corrupt module fails this
// open (returns null) rather than crashing the hook.
function resolveRepoKey(cwd) {
  try {
    const top = cwd ? findGitToplevel(cwd) : null;
    if (!top) return null;
    const repokeyMod = require('../companion/lib/devswarm-repokey.js');
    return repokeyMod.repoKeyForWorktree(top);
  } catch (_) {
    return null;
  }
}

// extractResponseText(toolResponse) -> string | null. The Bash tool's
// tool_response is an object shaped { stdout, stderr, ... } (confirmed above)
// — stdout carries cmdSend's one JSON line. Defensively also accepts a bare
// string, in case a differing harness build ever collapses the shape.
function extractResponseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object' && typeof toolResponse.stdout === 'string') {
    return toolResponse.stdout;
  }
  return null;
}

// looksLikeDevswarmSend(command) -> bool. Defense-in-depth heuristic (NOT a
// cryptographic guarantee): the parsed stdout shape alone is spoofable by any
// Bash command whose output happens to look like a send response (e.g. `cat`
// of a fixture file, or a plain `echo`) — so before trusting that shape we
// also require the executed command text to plausibly BE a real
// `devswarm.js send` invocation. Same \b-word-boundary regex idiom
// command-guard.js already uses for its own tool_input.command matching.
//
// P1 FIX (Round 2 review — a regression Wave 1 itself introduced): a SINGLE
// regex requiring `send` to appear within the same match as `devswarm`/
// `devswarm.js`, joined by `[^\n]*`, is bound to ONE LINE — it fails to match
// a completely ordinary multi-line shell invocation (e.g. a `CLI=...` var
// assignment on one line, the actual `node "$CLI" send ...` call on the
// next), silently dropping a genuine reply and — combined with the
// unanswered-question cap-bypass — creating an unbounded Stop-block for a
// Primary that did everything right. Fixed via TWO INDEPENDENT tests instead
// of one line-bound regex: `devswarm`/`devswarm.js` and `send` may now appear
// ANYWHERE in the full (possibly multi-line) command string, in either order.
const DEVSWARM_TOKEN_RE = /\bdevswarm(?:\.js)?\b/i;
const SEND_TOKEN_RE = /\bsend\b/i;
function looksLikeDevswarmSend(command) {
  return typeof command === 'string' && DEVSWARM_TOKEN_RE.test(command) && SEND_TOKEN_RE.test(command);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return; }

  // Primary + DevSwarm-active only — same guards as the sibling Stop/
  // UserPromptSubmit hooks (devswarm-parent-gate.js / devswarm-parent-inbox.js).
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  let payload = null;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;

  // Defensive (per task): even though the hooks.json matcher restricts this
  // hook to Bash, never assume the matcher was honored — check explicitly.
  if (payload.tool_name !== 'Bash') return;

  // Anti-spoof guard: the executed command itself must plausibly BE a
  // `devswarm.js send` call, not just have output shaped like one — a bare
  // `cat`/`echo` of send-shaped JSON must never be mistaken for a real send.
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!looksLikeDevswarmSend(command)) return;

  const text = extractResponseText(payload.tool_response);
  if (typeof text !== 'string' || !text.trim()) return;

  let resp = null;
  try { resp = JSON.parse(text.trim()); } catch (_) { return; }
  if (!resp || typeof resp !== 'object') return;

  // Only a genuine successful DIRECT send counts as an observed reply — never
  // a failed send (ok:false) and never a broadcast (type:'broadcast'), even if
  // it somehow carried a toId.
  if (resp.ok !== true) return;
  if (resp.action !== 'send') return;
  if (resp.type !== 'direct') return;
  if (typeof resp.toId !== 'string' || !resp.toId) return;
  // A dedupe hit (`sent:false`, cmdSend's `sent: !!res.inserted`) means the
  // message was NOT newly inserted — nothing new was actually delivered, so
  // it must not count as an observed reply either.
  if (resp.sent === false) return;
  // P1 FIX (Round 3 review): a response that ITSELF carries `needsReply:true`
  // is a NEW question the Primary just sent (e.g. "what's your status?"), not
  // an answer to anything. Recording it as a reply would clear the sender's
  // ORIGINAL unanswered question without the Primary ever actually deciding/
  // answering it — reintroducing the exact starvation this feature exists to
  // prevent, through the observation mechanism itself. cmdSend echoes
  // `needsReply` right next to `toId` (scripts/devswarm.js), so this is the
  // same trusted response shape already checked above.
  if (resp.needsReply === true) return;

  const home = os.homedir();
  // Prefer the payload's own timestamp if this PostToolUse event ever carries
  // one; otherwise Date.now(). recordReply is monotonic (max(existing, ts)),
  // so an imprecise fallback timestamp can never regress a real reply record.
  const ts = Number.isFinite(payload.timestamp) ? payload.timestamp : Date.now();
  // repoKey (not session_id — see the PER-PROJECT SCOPING header comment):
  // resolved from the payload's `cwd`, the SAME common field every other hook
  // in this plugin reads (e.g. devswarm-parent-gate.js/devswarm-parent-
  // inbox.js's own Stop/UserPromptSubmit payloads document `cwd` this way).
  // Fail-open: an unresolvable repoKey (no cwd, non-git cwd, a corrupt
  // repokey module) means recordReply is skipped entirely for this pass —
  // never guessed/recorded under a wrong key, and never a crash.
  const repoKey = resolveRepoKey(typeof payload.cwd === 'string' ? payload.cwd : null);
  if (!repoKey) return;
  try { recordReply(repoKey, home, resp.toId, ts); } catch (_) {}
}

try {
  main();
} catch (_) {
  // Fail-open: a bug here must never block or hard-loop the session.
}
process.exit(0);
