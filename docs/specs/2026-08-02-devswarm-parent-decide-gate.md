# DevSwarm Parent Decide+Reply Gate — Design Spec

Date: 2026-08-02
Branch: `fix/devswarm-parent-decide-gate`
Scope: `plugins/anti-hall/{hooks,companion,scripts,skills,codex}`

## 1. Problem

A DevSwarm Primary can satisfy its Stop-gate by merely reading/acking a child's mesh
message, even when that message is an unresolved blocking question. A child that asks
"what do I do?" gets acked and starved.

## 2. Confirmed root causes (re-verified against current source, not trusted from the bug report blindly)

All five claims from the originating report were re-checked directly against source and are **TRUE**:

1. **`hooks/devswarm-child-role.js:95-99`** — `PARENT_QUESTION_LINE` ("decide from the
   plan context, replying via `send --to <meshId>`") is injected only once, at
   SessionStart (`buildAdditionalContext`, called only from `main()`). The per-turn
   segments in `hooks/devswarm-parent-inbox.js` (`buildUnreadSegment` L442-452,
   `buildOwnUnreadSegment` L508-518) only say "STOP and read ... FIRST" — no
   decide/reply language anywhere in that file. After context compaction the SessionStart
   injection is gone; only "read" survives per-turn.
2. **`hooks/devswarm-parent-gate.js`** clears purely on unread-count/cursor state
   (L407-445, L462) plus a liveness check (L448-460) — never on whether an outbound
   `send --to <meshId>` occurred. No `replySent`/`hasReplied`/equivalent state exists
   anywhere in the codebase (verified via full-repo grep).
3. **Forced-ack cap** (`DEFAULT_CAP = 3`, L149) silently disarms the gate: once
   `effectiveBlocks >= cap` for an unchanged blocking-set signature (L484-489, sha1 of
   id+unread+unknown+status), the next Stop just returns with **zero output** (L502-505).
   The per-session state file is `~/.anti-hall/devswarm/parent-gate/<sessionId>.json`
   (`{sig, blocks}`) — silence is scoped to that session's lifetime, not literally
   forever, but still a quiet give-up with no signal.
4. **No question-vs-heartbeat distinction.** `companion/lib/devswarm-noise.js` has no
   mtype-aware classifier at all (`isNoiseText` is pure text-prefix; `isForwardableRow`
   only checks `mtype !== 'direct'`). `mtype` is constrained by construction to exactly
   `'direct'` / `'broadcast'` (`scripts/devswarm.js` `cmdSend`, the ternary at the `send`
   ~L3327 build of `type`) — a heartbeat is `mtype='broadcast'` + orthogonal
   `is_heartbeat=1` (never a third mtype value, confirmed at `scripts/devswarm.js:1822-1823`
   and `companion/lib/devswarm-store.js`'s `appendMeshMessage`/`appendMeshRow` comments).
   Every `direct` message gates identically regardless of whether it's an actual
   decision-blocking question — `urgency` (a real validated enum, `ALLOWED_URGENCY =
   ['low','normal','high','urgent']`) affects wording/tier only, never whether the gate
   fires (`hooks/devswarm-parent-inbox.js:455-460`, `hooks/devswarm-parent-gate.js:556-559`).
5. **`inbox read-primary`** (`scripts/devswarm.js` `cmdSend`'s sibling `cmdInboxMessages`,
   dispatched at `sub === 'read-primary'` around L2184) always runs with `{ack: true}`,
   which advances both the durable ACK-cursor file and the store cursor to the current
   total (L2162-2165) — a plain "safe, non-draining" read (the wording used in
   `hooks/devswarm-parent-inbox.js:512-517` and `hooks/devswarm-parent-gate.js:563`,
   where "non-draining" means it doesn't drain the *native hivecontrol* queue) silently
   drains anti-hall's own unread cursor too, with no separate reply step enforced.

### Correction to the report's assumptions

The report asked for "dual-platform: mirror the injection + gate behavior in the Codex
port." Investigation found **no separate Codex reimplementation exists for these hook
files.** `codex/install-codex.js` registers `devswarm-child-role.js`,
`devswarm-parent-inbox.js`, and `devswarm-parent-gate.js` **verbatim** from the same
`plugins/anti-hall/hooks/` directory Claude uses (`HOOK_ROOT = path.join(ROOT, 'hooks')`,
`ROOT = path.resolve(__dirname, '..')` — i.e. the parent of `codex/`, the shared `hooks/`
folder). Both `hooks/hooks.json` and `codex/hooks/hooks.json` wire the **same physical
files** to the **same events** (verified line-by-line):

| File | Claude event | Codex event |
|---|---|---|
| `devswarm-child-role.js` | SessionStart | SessionStart |
| `devswarm-parent-inbox.js` | UserPromptSubmit | UserPromptSubmit |
| `devswarm-parent-gate.js` | Stop | Stop |

A single fix to the shared files under `plugins/anti-hall/hooks/` (and
`companion/lib/`, `scripts/devswarm.js`) covers both platforms automatically for
requirements A-D. The one genuinely new piece (a `PostToolUse` hook, see §4.4) is a
supported event on both platforms — Codex's `codex/README.md` lists `PostToolUse` among
its supported hook events, it is simply unwired in this plugin today — so it too is
mirrored via both `hooks.json` files, no exception needed. (Pre-existing, unrelated to
this fix: `devswarm-child-role.js`'s CronCreate-based mailbox self-wake is already
documented Claude-only, since CronCreate is a Claude-only tool.)

## 3. Design goals (restated from the required fix, now made concrete)

- (A) Per-turn re-assertion of decide+reply for an unread CHILD QUESTION, surviving compaction.
- (B) A STRUCTURAL child-question signal, not text-sniffed.
- (C) Gate keeps blocking on an unanswered question, independent of the forced-ack cap; clears only on an OBSERVED reply.
- (D) Cap-exhaustion becomes an escalation line, never a silent return.
- (E) Dual-platform coverage, exceptions stated explicitly (none required beyond §2's correction).

## 4. Design

### 4.1 Structural signal: `needs_reply` (requirement B)

Add a `needs_reply INTEGER` column to the `messages` table, **orthogonal** to `mtype`
(same established pattern as `is_heartbeat` — see `devswarm-store.js`'s own comment:
"`isHeartbeat` sets the orthogonal D22 marker; it does NOT change `mtype`"). Never a new
mtype value — this preserves every existing `mtype`-only consumer unmodified.

- `companion/lib/devswarm-store.js`:
  - `ensureMessagesMeshColumns`: add `['needs_reply', 'INTEGER']` to the migration list.
  - `CREATE TABLE IF NOT EXISTS messages (...)` (sqlite backend): add `needs_reply INTEGER,`.
  - `appendMeshMessage(store, fields)`: accept `fields.needsReply`, thread `needsReply:
    !!fields.needsReply` into the `appendMeshRow` call.
  - `appendMeshRow` — **both backends** (sqlite around L458-478, journal around L958+):
    read/write the new field, mirroring exactly how `isHeartbeat` is threaded today.
  - `listMessages` — **both backends** (sqlite around L665-689, journal around L1159+):
    return `needsReply: <col> === 1 || <col> === 1n` (sqlite) / boolean (journal) on every
    row, mirroring `isHeartbeat`'s own read-back shape.
- `scripts/devswarm.js` `cmdSend`:
  - New bare boolean flag `--question` (`hasFlag(flags, 'question')`).
  - Validation: reject `--question` combined with `--broadcast` — a broadcast cannot be a
    blocking question addressed to one decision-maker. Error text: `"send --question is
    only valid for a direct message (--to/--to-primary), not --broadcast"`.
  - Thread `needsReply: questionFlag` into the `fields` object passed to
    `appendMeshMessage` inside `doAppend()`.
  - Response object (`{ok:true, action:'send', ...}`): echo `needsReply: questionFlag`
    (parity with the existing `urgency` echo), and for a direct (non-`--to-primary`) send
    add `toId: targetPartition` — the **resolved** recipient's registered row id (already
    computed at L3424 as `targetPartition = resolved.target.id`), not the raw `--to`
    string the caller typed. This resolved id is what §4.3's reply-tracker keys on, so it
    matches exactly the `sender` value recorded on that recipient's own outbound rows
    (verified: `callerIdentity()` in `scripts/devswarm.js` resolves via
    `inst.primaryWorkspaceId(resolveCallerWorktree(cwd))` — the SAME derivation used for
    a workspace's own registered `id` everywhere else, so `sender` on a message row and
    that sender's own registry `id` are the same value by construction).

### 4.2 Projection: `pendingQuestions[]` (feeds both A and C)

The Stop-gate (`devswarm-parent-gate.js`) is explicitly forbidden from opening the store
DB on its hot path ("NEVER opens the store DB" — its own header). All "is there an
unanswered question" computation must therefore happen where the store IS already open:
`computeSummary` (`companion/lib/devswarm-store.js`, ~L1321-1394), which the ingest
daemon (or a hook's own H4 fallback) calls off the interactive hot path.

In `computeSummary`'s per-workspace loop, immediately after `unreadRows`/`urgencyMax` are
computed (mirrors the existing `archive_requested` pattern exactly — same `unreadRows`
source, same `mtype === 'direct'` filter):

```js
const pendingQuestions = unreadRows
  .filter((r) => r && r.mtype === 'direct' && r.needsReply)
  .map((r) => ({ from: r.sender, ts: r.ts, seq: r.storeSeq }));
```

Add `pendingQuestions` (always an array, `[]` when none — matching `archive_requested`'s
always-present-scalar precedent, not the top-level orphans/staleRegistryPartitions
omit-when-empty precedent, since this is a per-workspace field like `archive_requested`)
to `workspaces[d.id]`.

This is a pure structural fact — "which pending rows in this workspace's own inbox are
flagged needs_reply, from whom, when" — no session/reply-state awareness belongs here.

### 4.3 Per-session reply-state (requirement C)

Per the task's own explicit wording: "Add per-session replied-state keyed by
meshId+cursor." New shared module `companion/lib/devswarm-reply-state.js`:

- `replyStatePathFor(sessionId, home)` → `~/.anti-hall/devswarm/parent-gate/<safe
  session>-replies.json` (co-located with the existing per-session gate state; reuse
  `devswarm-parent-gate.js`'s `stateFileFor` id-sanitization regex
  `/[^A-Za-z0-9_.-]/g`).
- `readReplyState(sessionId, home)` → `{ [meshId]: { lastReplyTs: number } }`. Fail-open:
  any read/parse error → `{}`.
- `recordReply(sessionId, home, meshId, ts)` → atomic tmp+rename write (mirrors
  `hooks/devswarm-parent-inbox.js`'s `markArchiveNudged` idiom). Monotonic:
  `lastReplyTs = max(existing, ts)`, so a racing/late write can never regress it.
- `unansweredQuestions(pendingQuestions, replyState)` → filters to entries whose `ts` is
  **strictly after** `replyState[q.from]?.lastReplyTs` (no entry for that sender at all
  ⇒ unanswered). Fail-open toward **unanswered** (the safer, more-cautious state) on any
  malformed input — this feature exists to stop starvation, so an ambiguous read must
  never silently clear a question.

**Observation mechanism** (how a reply gets recorded): a new `PostToolUse` hook,
`hooks/devswarm-parent-reply-tracker.js`, matcher `Bash`, Primary + DevSwarm-active only
(same `isDevswarmActive`/`!isChildWorkspace` guards as the other two hooks). On every
Bash tool call, it inspects the payload's `tool_response` (the tool's actual stdout/
result — **the exact field name must be confirmed against Claude Code's real PostToolUse
contract and the test harness `tests/helpers/spawn-hook.js` at implementation time**;
this plugin has no prior PostToolUse hook to copy from). If the response parses as JSON
with `{ok:true, action:'send', type:'direct', toId:<string>}`, call
`recordReply(session_id, home, toId, <payload timestamp or Date.now() fallback>)`.

Rationale for parsing the tool's own JSON response rather than regexing the Bash command
string: `cmdSend` already emits one structured JSON line per the CLI's own documented
verb contract (`skills/devswarm/SKILL.md`: "Every verb emits one JSON line on stdout,
exit 0=ok:true"), and `toId` (§4.1) is the CLI's own resolved identity — far more robust
than trying to parse arbitrary shell quoting/`${CLI}` expansion out of a command string.
This hook is **observe-only**: it never emits a `decision` field, never blocks, fails
open on every error (malformed JSON, non-Bash tool, non-Primary session, wrong shape —
all silently skip recording, never throw).

Wire into **both** `plugins/anti-hall/hooks/hooks.json` and
`plugins/anti-hall/codex/hooks/hooks.json` under a new `PostToolUse` → matcher `Bash`
section (mirrors the structure of the existing `PreToolUse`/Bash entries in each file) —
genuine dual-platform parity, since Codex supports this event, it is just unused in the
plugin today.

### 4.4 Gate changes (requirement C + D) — `hooks/devswarm-parent-gate.js`

- `readOwnUnread` (or the `main()` caller directly) additionally surfaces
  `entry.pendingQuestions` from the summary — currently only `unread`/`urgencyMax` are
  read; extend the same `summaryEntry` lookup to pass `pendingQuestions` through.
- In `main()`, after computing `own`, read `readReplyState(payload.session_id, home)` and
  compute `unansweredQuestions = unansweredQuestions(own.pendingQuestions, replyState)`
  (the shared lib function from §4.3).
- **Cap bypass (C):** when `unansweredQuestions.length > 0`, the gate ALWAYS emits a
  block this Stop, regardless of `effectiveBlocks >= cap` — skip the cap-return path
  entirely for this pass. The per-signature state file is still updated for bookkeeping/
  telemetry continuity, but it can never suppress this specific reason. This is
  deliberately outside the existing loop-safety cap, per the task's explicit
  requirement — an indefinitely-reasserted "you have an unanswered question" is judged
  preferable to a starved child, unlike the general unread/stale nag the cap still governs.
- **Escalation instead of silence (D):** for the *non-question* axes (plain unread
  backlog, stale/escalated liveness — the ORIGINAL cap purpose), change the
  `effectiveBlocks >= cap` branch (current L502-505 silent `return`) to: on the pass
  where `effectiveBlocks === cap` exactly (the first exhaustion), emit ONE
  escalation-worded block ("DEVSWARM ESCALATION: forced-acknowledged N times with no
  observed resolution — a human should look") and persist `blocks = cap + 1`; on any
  later pass with the same signature (`effectiveBlocks > cap`), go quiet as before. This
  bounds the total blocks-per-signature to `cap + 1` (still loop-safe) while eliminating
  the silent give-up.
- `buildReason` gains: (1) an unanswered-question branch, listed first/loudest, naming
  each asker + question age + the exact `send --to <meshId>` reply command — explicit
  "reading it is NOT sufficient, DECIDE and REPLY" wording; (2) the escalation branch
  described above.

### 4.5 Per-turn injection (requirement A) — `hooks/devswarm-parent-inbox.js`

`buildOwnUnreadSegment` (L508-518) currently only says "STOP and read ... FIRST ... via
`inbox read-primary`." Read `pendingQuestions` from the same summary entry already
fetched (`summaryEntry(summary, primaryId)`), cross-reference against
`readReplyState(payload.session_id, home)` (this hook's stdin payload already carries
`session_id` per its own documented contract) via the same `unansweredQuestions` helper.
When any survive, the segment must explicitly say: read is not enough — DECIDE from
context and REPLY via `` `send --to <meshId> --message "..."` `` — this is the fix for
claim 1: this hook fires every turn (unlike SessionStart), so the decide+reply
instruction now survives compaction.

### 4.6 Child-side wiring (requirement B, child side)

`--question` only protects messages that set it. Update the guidance that tells a child
HOW to ask a blocking question so new questions actually carry the flag going forward
(no retroactive effect on already-sent messages, which is expected/fine):

- `hooks/devswarm-child-role.js` `CHILD_QUESTION_LINE`: change the example from
  `` `send --to-primary` `` to `` `send --to-primary --question` `` (keep existing
  `--urgency`/`--message` guidance).
- `skills/devswarm/SKILL.md` "CHILD rules" step 2's example command: same addition.
- `codex/skills/anti-hall-devswarm/SKILL.md`: check whether it duplicates this example
  text; if so, mirror the same change (state explicitly if it does not duplicate it and
  therefore needs no change).

## 5. Constraints (restated, all binding)

Pure Node built-ins; every new function fails open (try/catch, never throw-blocks a
session); OS-agnostic paths (`path.join`, no shell-specific syntax); stdout JSON via
`fs.writeSync(1, ...)`; the new reply-state file is single-writer/atomic (tmp+rename,
matching `markArchiveNudged`); no self-credit in comments/commits; public-repo-agnostic
throughout (no project-specific names beyond anti-hall's own). Preserve existing
behavior for heartbeats (still never gate — `needs_reply` can only ever be set on a
`type==='direct'` send, never a broadcast/heartbeat, enforced by §4.1's validation) and
for the skip-guard override path (`isSkipped(GUARD_NAME)` still short-circuits
everything, checked first in `main()`, untouched).

## 6. Test plan

Mapped to the task's required list; extend existing files where a matching one already
exists rather than duplicating coverage:

| Requirement | Test file | Coverage |
|---|---|---|
| question-vs-heartbeat classification | `tests/companion/devswarm-store-mesh.test.js` / `devswarm-store-projection.test.js` (extend) | `needs_reply` never settable on a broadcast/heartbeat send; `computeSummary`'s `pendingQuestions` filter excludes non-direct and heartbeat rows |
| gate stays blocked past old cap on unanswered question | `tests/hooks/devswarm-parent-gate.test.js` (extend) | 4+ Stop calls with an unanswered pendingQuestion present and no reply recorded still block, not silent |
| gate clears once `send --to` that meshId observed | same file (extend) | seed reply-state (via the reply-tracker hook or direct fixture) with `lastReplyTs` after the question's `ts`; that question no longer appears in `unansweredQuestions` |
| cap-exhaustion emits escalation not silent-return | same file (extend) | drive `cap+1` Stop calls with a plain (non-question) unread backlog; the `(cap+1)`th call emits escalation-worded block text, not empty stdout; `(cap+2)`th goes quiet |
| per-turn injection contains decide+reply after simulated compaction | `tests/hooks/devswarm-parent-inbox.test.js` (extend) | seed a pendingQuestion, invoke the hook fresh (no prior SessionStart context, simulating post-compaction), assert additionalContext contains decide/reply + `send --to` wording, not just "read" |
| fail-open on malformed mesh rows | new `tests/companion/devswarm-reply-state.test.js` + extend `devswarm-parent-gate.test.js`/`devswarm-parent-inbox.test.js` | corrupt/malformed reply-state file, malformed `pendingQuestions` shape on the summary entry → hooks still exit 0, never throw, fall back to the safer (still-blocking) state |
| new hook itself | new `tests/hooks/devswarm-parent-reply-tracker.test.js` | records on a genuine successful direct send; ignores non-Bash tools, non-Primary sessions, `ok:false` sends, malformed `tool_response`; never emits a blocking decision |
| `--question` flag | `tests/scripts/devswarm-send.test.js` (extend) | rejects with `--broadcast`; echoes `needsReply`/`toId` in the response on a direct send |
| child-side wording | `tests/hooks/devswarm-question-protocol.test.js` (extend) | `CHILD_QUESTION_LINE` now contains `--question` |

Both storage backends (sqlite via `node:sqlite`, and the journal/JSON fallback) must be
exercised for every store-level change (`needsReply` threading through
`appendMeshRow`/`listMessages`) — confirm the existing test files already parametrize
over both backends before assuming single-backend coverage is sufficient.

Run the full `node:test` suite and report actual pass/fail counts — no assumed numbers.

## 7. Open verification items for the implementer

Flagged explicitly rather than guessed, per this project's verify-first discipline:

1. Exact PostToolUse payload field name(s) for the tool's result (`tool_response` is the
   working assumption here; confirm against Claude Code's actual contract and whatever
   `tests/helpers/spawn-hook.js` supports/needs extending for this event before finalizing).
2. Whether `codex/skills/anti-hall-devswarm/SKILL.md` duplicates the CHILD blocking-
   question example text (§4.6) — if not, state explicitly that no change is needed there
   rather than skipping silently.
3. If Codex's actual PostToolUse payload shape differs meaningfully from Claude Code's,
   the reply-tracker hook must branch defensively (already covered by the universal
   fail-open constraint) — note any such divergence explicitly in the implementation
   report rather than silently normalizing it away.
