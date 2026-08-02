# anti-hall harness-feature adoption plan (2026-08-01)

**Status:** Fable-reviewed 2026-08-02; phased subset approved for build.
Companion doc:
[`docs/KB-claude-code-harness-features.md`](../../KB-claude-code-harness-features.md)
(the full feature-vs-usage audit this plan draws from).

## 1. Goal

Adopt the Claude Code harness features that **mechanize anti-hall's own
disciplines** — turn soft "nudges" into enforced gates — plus add
**ground-truth verification** where anti-hall currently only pattern-matches.
Scope = the recommended GAP features in §2 below.

**Explicitly EXCLUDED** (deliberate; Fable to confirm or overturn in §4):

| Excluded | Reason |
|---|---|
| MCP server ship/consume | anti-hall's standing CLI-over-MCP posture (process-leak + parity cost — see memory: "Prefers CLI over MCP"). |
| Agent SDK / headless mode | anti-hall is pure-Node-by-design; the SDK pulls in a different runtime model. |
| Output styles | Prompt injection via hooks is more surgical and already dual-platform-portable; output styles are Claude-only. |

## 2. Per-feature adoption entries

### TOP TIER

#### (a) `TaskCreated` / `TaskCompleted` hooks
- **What:** fire when a task is added to / marked complete in the task list.
- **Why it fits:** mechanizes rule 6, "no fake completion" — today this is only
  a soft `Stop`-hook nudge (`task-guard.js`, `tasklist-guard.js`) that fires at
  the *end* of a turn, not at the moment a task is claimed done.
- **Implementation sketch:** new `hooks/task-completed-guard.js` registered on
  `TaskCompleted`; checks the just-completed task's description against a
  cheap heuristic set (shares logic with `speculation-guard.js`'s hedge-phrase
  list) and blocks/annotates if the completion looks premature (no verification
  command run this turn, hedge language present). Wire into `hooks.json` under
  a new `TaskCompleted` key.
- **Effort:** M. **Risk:** Low (new hook, no existing behavior touched).
- **Fable verdict:** MODIFY — Events exist + exit-2 can block completion, but
  the task payload schema is UNDOCUMENTED. Ship annotate-only first (no
  exit-2 block); add a log-only probe hook to capture the real payload
  before building the heuristic. No dup with `task-guard.js:2-24` /
  `tasklist-guard.js:2-16` (those fire at `Stop`; `TaskCompleted` fires at
  claim time — complementary).

#### (b) `PostToolUse` hook
- **What:** fires after a tool call completes successfully, with the tool's
  output available.
- **Why it fits:** the missing "verify after the action" half — anti-hall's
  guards today only fire *before* the tool call (`PreToolUse`) or at `Stop`;
  nothing inspects what a test/build/edit tool actually *returned*.
- **Implementation sketch:** new `hooks/output-verify-guard.js` on
  `PostToolUse`, matcher `Bash`; parses stdout/exit-code for common
  test/build-runner signatures (jest/vitest/pytest/go test/npm run
  build/tsc) and flags a mismatch between a claimed "tests pass" and an
  actual non-zero exit or failure line in the same turn's transcript.
- **Effort:** M. **Risk:** Medium — false positives on non-standard test
  runners; must fail open (never block, only annotate) until proven reliable.
- **Fable verdict:** AGREE — Live-proven this session (received
  `PostToolUse:Read` injections). matcher-by-tool-name, `additionalContext` +
  `updatedToolOutput` supported. Zero `PostToolUse` entries in `hooks.json`
  today; `PreToolUse` Bash guards run in a different phase — no conflict.

#### (c) `SubagentStop` hook
- **What:** fires when a spawned subagent session stops.
- **Why it fits:** mechanizes rule L, "verify delegated work" — it is the
  exact mirror of the existing `SubagentStart` injection
  (`verify-first-subagent.js`), but for the *return* side; today nothing
  re-checks a subagent's "done" claim before it lands back in the parent's
  context.
- **Implementation sketch:** new `hooks/verify-first-subagent-stop.js` on
  `SubagentStop`; injects an `additionalContext` reminder into the parent
  turn that the subagent's completion claim is unverified until the parent
  re-runs the check itself (same wording as rule L already carries in
  `verify-first-core.js`, just re-surfaced at the right moment).
- **Effort:** S. **Risk:** Low — purely additive injection, same shape as an
  existing hook.
- **Fable verdict:** MODIFY — Live docs indicate injected context lands in
  the SUBAGENT's own turn, not the parent — which defeats the goal (remind
  the PARENT). Use `PostToolUse` with matcher `Agent|Task` instead (fires in
  the parent when the subagent result returns; `additionalContext`
  confirmed). Verify destination empirically with a log-only probe before
  building. Keep S sizing; pattern proven by
  `verify-first-subagent.js:74-84`.

#### (d) LSP servers (`.lsp.json`)
- **What:** plugin-declared Language Server Protocol integration for
  real compiler/type diagnostics.
- **Why it fits:** extends `api-guard.js`'s fabricated-API pattern check
  (regex/heuristic-based) to real compiler ground truth — a genuine
  type/symbol error the LSP reports is a fact, not an inference.
- **Implementation sketch:** ship a `.lsp.json` manifest wiring
  language-appropriate servers (tsserver/pyright/gopls, best-effort,
  fail-open if absent); a new `PostToolUse`-on-`Edit` hook queries
  diagnostics for the touched file and surfaces new errors introduced by the
  edit.
- **Effort:** L. **Risk:** Medium-High — LSP servers are external
  dependencies per language (violates the "pure Node built-ins only" hook
  convention unless scoped carefully to invocation of an already-installed
  server, never a bundled one).
- **Fable verdict:** REJECT the build; doc-only guidance instead. `.lsp.json`
  is real but: binary must be pre-installed; FIRST-server-registered-WINS
  (our server could BLOCK the official one); marketplace already ships
  pyright-lsp/typescript-lsp/rust-analyzer-lsp; native LSP already gives
  instant post-edit diagnostics; no hook API can query the harness LSP
  session. So the proposed `PostToolUse`-on-`Edit` diagnostics hook
  duplicates native behavior and risks collision. Do doc guidance
  recommending the official LSP plugins. Effort L→S.

### SECOND TIER

#### (e) `PreCompact` / `PostCompact` hooks
- **What:** fire immediately before/after context compaction.
- **Why it fits:** addresses the observed RESUME-TRAP context loss — today
  only `SessionStart` with `source=compact` re-injects the protocol, which is
  *after* compaction already happened and state may already be gone from the
  model's live context.
- **Implementation sketch:** `hooks/precompact-snapshot.js` (writes a small
  state snapshot — active task, current file, last verified fact — to
  `.anti-hall/state/`) and `hooks/postcompact-restore.js` (re-injects it).
- **Effort:** M. **Risk:** Low-Medium — snapshot format must be forward-only
  and never assumed present (fail-open if missing).
- **Fable verdict:** MODIFY — PostCompact is side-effect-only — its stdout
  is IGNORED, cannot inject `additionalContext`. Keep
  `precompact-snapshot.js` (file writes work); route RESTORE through the
  existing `SessionStart` `source=compact` path (already wired — KB row
  21). Effort stays M.

#### (f) `PostToolUseFailure` hook
- **What:** fires after a tool call fails.
- **Why it fits:** turns a failed command into an explicit root-cause
  trigger — today a failure just shows up in the transcript with no
  mechanical nudge toward `root-cause`-style investigation.
- **Implementation sketch:** `hooks/failure-root-cause-nudge.js`; injects a
  short reminder (reuse the rationalization-table wording already in
  `verify-first-core.js`) pointing at the `/anti-hall:root-cause` skill when
  a Bash/build/test command exits non-zero.
- **Effort:** S. **Risk:** Low.
- **Fable verdict:** AGREE — Live-proven this session (a failed command
  triggered `PostToolUseFailure:Bash`). matcher + `additionalContext`. No
  overlap: `codex-nudge.js:2-16` and `speculation-guard.js:2-13` are `Stop`
  hooks, neither touches tool failures. Note OMC already injects here —
  keep wording short to avoid stacked noise. Effort S accurate.

#### (g) `SessionEnd` hook
- **What:** fires when a session terminates.
- **Why it fits:** auto-writes the `.anti-hall/history/<date>/<session>.md`
  ledger entry the project already asks every session to write manually
  (memory: "always write .anti-hall/history/ entries proactively") — turns a
  discipline into a guarantee.
- **Implementation sketch:** `hooks/session-end-ledger.js`; reads the
  session's task list + any in-memory fix notes and appends a
  Cause/Fix/Verified stub row, best-effort (never fails the session teardown).
- **Effort:** M. **Risk:** Low — write-only, additive, fail-open.
- **Fable verdict:** AGREE — Exists, matcher by end reason,
  context-only/side-effect — fine for a write-only ledger.
  `tasklist-guard.js:38` already imports `session-history-index.js` (append
  pattern exists). Must tolerate abrupt teardown (best-effort). Effort M
  fair.

#### (h) `ConfigChange` hook
- **What:** fires when settings/config files change.
- **Why it fits:** guard-integrity — detects tampering with
  `~/.anti-hall/skip.json` or `settings.json` guard toggles outside the
  sanctioned user-override path (Positive Rule 10's TTL'd escape hatch),
  closing a gap where a guard could be silently disabled.
- **Implementation sketch:** `hooks/config-integrity-guard.js`; diffs the
  changed config against the last-known-good hash, flags unexpected
  guard-disabling edits.
- **Effort:** M. **Risk:** Medium — must not false-positive on the
  legitimate skip.json TTL flow.
- **Fable verdict:** MODIFY — matcher sources are ONLY
  user_settings/project_settings/local_settings/policy_settings/skills —
  `~/.anti-hall/skip.json` is NOT a watched config source, so the plan's
  primary tamper target won't fire. Split: `ConfigChange` for
  settings.json guard toggles; `FileChanged` for skip.json (whether
  `FileChanged` watches paths outside the project is UNVERIFIED — test
  first).

#### (i) Sandboxing (`/sandbox`)
- **What:** contains tool execution inside a restricted filesystem/network
  boundary.
- **Why it fits:** given the runaway-process incident history (memguard /
  MCP-reaper installs were reactive fixes to a fork-bomb near-miss), a
  harness-native sandbox is a more direct containment layer for autonomous
  swarm work than after-the-fact process reaping.
- **Implementation sketch:** documentation + settings guidance only at
  first (no code) — recommend `/sandbox` for autonomous/AFK sessions running
  build-heavy chains; evaluate mechanical enforcement in a later phase.
- **Effort:** S (doc-only) / L (if enforced). **Risk:** Low for doc-only;
  Medium if it later blocks legitimate network/file access anti-hall's own
  guards need.
- **Fable verdict:** AGREE (doc-only). `/sandbox` real; macOS Seatbelt /
  Linux+WSL2 bubblewrap; native Windows UNSUPPORTED (our CI matrix has
  windows — doc must state this); subagents inherit parent sandbox config;
  jest+watchman and docker are incompatible (doc must note both — directly
  relevant to the fork-bomb history). Effort S accurate.

## 3. Phasing proposal (Fable-revised 2026-08-02 — supersedes the original
tier grouping below)

- **Phase 1 — AGREE, live-proven, lowest risk: (b) `PostToolUse`, (f)
  `PostToolUseFailure`, (i) sandboxing doc-only.** All three verdicts came
  back AGREE with live-session proof this review already captured
  (`PostToolUse:Read` and `PostToolUseFailure:Bash` injections were both
  observed firing this session). No probe needed — build directly.
  Parallelizable; each is a self-contained new hook file (or, for (i), a
  doc-only change) with no shared state.
- **Phase 2 — MODIFIED verdicts: (a), (c), (e), (g), (h).** Each of (a), (c),
  (e), (h) is preceded by a cheap **log-only probe hook** that empirically
  confirms the specific contract Fable flagged as UNVERIFIED or corrected
  from the original doc-read (task payload shape for (a); injection
  destination for (c); PostCompact no-inject for (e); config-source list for
  (h)) before any heuristic/blocking logic is built on top. (g) `SessionEnd`
  came back AGREE and needs no probe, but stays in this phase because it
  shares state-snapshot concerns with (e) — **sequence e before g** (or
  share the snapshot module) to avoid two hooks writing divergent
  session-state formats, per the original dependency note. (h) is otherwise
  independent and parallelizable against the e/g pair.
- **(d) LSP servers — doc-only, no build.** Fable's verdict was REJECT-BUILD:
  ship guidance recommending the official LSP marketplace plugins
  (pyright-lsp/typescript-lsp/rust-analyzer-lsp) instead of a competing
  `.lsp.json` + diagnostics hook. Do **not** build the hook or ship
  `.lsp.json`. Effort revised L→S.

<details>
<summary>Original (pre-Fable-review) tier grouping — superseded, kept for
history</summary>

- Phase 1 — top tier (a, b, c): highest leverage, pure-Node, low blast
  radius. Each a self-contained new hook file with no shared state —
  parallelizable, one DevSwarm child workspace per feature.
- Phase 2 — second tier (e, f, g, h): sequence e before g (shared snapshot
  concerns); f and h independent/parallelizable.
- Phase 3 — heavier lifts (d LSP, i sandboxing): own design spec before a
  build phase, sequenced after Phase 1/2.

</details>

**Load-bearing doc-reads note:** three of the mechanism corrections above —
(c) injection destination, (e) PostCompact no-inject, (h) config-source list
— flip the plan's original assumption entirely (not a refinement). Per
Fable's own recommendation, each Phase-2 build for (c)/(e)/(h) MUST
empirically confirm the contract with a log-only probe hook before relying
on it — the doc-read alone is not sufficient evidence to build against.

## 4. Fable code-investigation review (NEXT STEP, post-compaction)

Dispatch a **Fable** agent (fallback: Opus, then Sonnet, if Fable refuses or
returns null) to read **this plan + `docs/KB-claude-code-harness-features.md`
+ the actual anti-hall code**, and per feature (a)–(i) above, verify:

1. **The hook EVENT actually exists**, with its exact payload/contract, in
   the currently installed Claude Code version — re-fetch
   `code.claude.com/docs/en/hooks` at review time. Do **not** assume the
   2026-08-01 doc-verified event list in the KB is still current; confirm
   the specific events being built against.
2. **Where in the codebase it wires in** — the `hooks.json` entry plus the
   new pure-Node hook file, mirroring an existing hook's shape
   (`verify-first-subagent.js` for pattern, `install-reaper.js`/companion
   pattern for anything long-running).
3. **Conflicts with existing guards** — does a new hook duplicate or race an
   existing one (e.g. does (f)'s failure nudge overlap `codex-nudge.js`;
   does (a)/(c) double up with `task-guard.js`/`tasklist-guard.js`)?
4. **Effort/risk** — sanity-check the S/M/L and risk labels above against
   actual code complexity.

**Output:** a per-feature verdict — **AGREE / MODIFY(how) / REJECT(why)** —
filled into the "Fable verdict: __" line for each (a)–(i) entry above, plus
one overall **"implement all?"** recommendation.

## 5. Global constraints reminder

- Pure-Node, fail-open hooks (no throw ever blocks a session).
- OS-agnostic (macOS/Linux/Windows) — no POSIX-only calls.
- Dual-platform parity: **Codex parity is currently ZERO for every one of
  these events.** The Codex port
  (`plugins/anti-hall/codex/install-codex.js:60-91`) registers only
  `SessionStart`/`UserPromptSubmit`/`PreToolUse(Bash)`/`Stop` and explicitly
  exposes subagent-lifecycle + edit-time behavior as skill/workflow
  protocols, not hard hooks. So EACH adopted feature (a)–(h) ships with a
  STATED Claude-only exception, not just (c) — this is not an edge case,
  it's the default. (Whether the Codex runtime now supports more events is
  unverified — confirm before assuming, including before building (c).)
- Agnostic repo — no private names/paths in any shipped file.
- No AI self-credit anywhere (commits, PR/issue/release bodies).
- Right-sized rigor — each feature gets its own scoped build + deadly-loop
  review; no bandaids, no overbuilding past what the feature needs.
