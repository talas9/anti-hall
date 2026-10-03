# anti-hall for Codex

This directory contains the Codex-native port layer. It does not modify the
Claude Code plugin files.

Install project-local Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js
```

Install global Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

Dry-run:

```bash
node plugins/anti-hall/codex/install-codex.js --dry-run
```

### Enable Jev

<!-- jev-recommend:start -->
> **Recommended: enable Jev, the optional classifier, for more accurate guards.**
>
> It gives guards such as the speculation check a model's second opinion on top of pattern matching, and it can only add blocks, never remove one. **Costs:** optional and off by default; needs your own Vercel AI Gateway or TypeSafe API key; sends the text a guard judges to the provider you choose; uses provider credits. Details: [PRIVACY.md](https://github.com/talas9/anti-hall/blob/main/PRIVACY.md).
>
> Enable: say "activate jev" (runs the `anti-hall-jev` skill). Codex has no plugin options, so the key file is read only after you opt in with `jev.allowLegacyKeyRead`; the skill walks you through it. The full text and the measured result are in the Jev page of the documentation (linked at the end of this file).
<!-- jev-recommend:end -->

anti-hall writes per-project session notes under `.anti-hall/`. Add `.anti-hall/` to your project's `.gitignore` so a `git add .` can't commit them (or run `doctor --repair`, which appends it to the untracked `.git/info/exclude`). Doctor warns while it is not ignored.

## Parity Notes

Codex hooks are not a 1:1 Claude Code hook runtime. Current official Codex docs
list hook support for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SubagentStart`, `SubagentStop`, and `Stop`, with `PreToolUse` matchers that can
include `Bash`, `apply_patch`/`Edit`/`Write`, and MCP tools.

This port currently hard-registers the anti-hall hooks whose payload
contracts are live-aligned and regression-tested for Codex, PLUS one
documented exception (the `PostToolUse` pair below, registered but still
UNVERIFIED against a real Codex payload):

- `SessionStart`: full verify-first protocol, DevSwarm child-role communication override (`devswarm-child-role.js`), version alert, codex-availability probe, handover resume (`handover-resume.js`), progress-prune (`progress-prune.js` — platform-neutral, now registered as of 0.105.2)
- `UserPromptSubmit`: rotating verify-first nudge, task tracker, limit-conserve nudge, DevSwarm parent-inbox + child-turn per-turn reminders (`devswarm-parent-inbox.js`, `devswarm-child-turn.js`)
- `PreToolUse`: shell command guards (`git-guard`, `command-guard`, `merge-gate`) — `command-guard.js` is a single shared file, so its DevSwarm destructive-read redirect (0.53.0/Part B: blocks `hivecontrol workspace monitor` AND `read-messages` unconditionally whenever DevSwarm is active, no durable-inbox evidence required; own skip `devswarm-read-guard`) auto-applies to Codex sessions with no separate adapter. **v0.98.2 (defect b08b26566b92):** the same shared file's `git-stash-guard` branch (blocks a mutating `git stash` — see `skills/devswarm/SKILL.md`'s own section on it — once ARMED via `.anti-hall/protected-stashes` or `ANTIHALL_STASH_GUARD=1`) likewise auto-applies to Codex sessions with no separate adapter; it is NOT DevSwarm-specific and fires regardless of `DEVSWARM_REPO_ID`
- `PreToolUse` (matcher `apply_patch`, Codex >= 0.134): `edit-guard`, `api-guard` (blocking path) and `ship-it-guard` (existence gate only; its PLAN.md conformance advisory stays Claude-only). Codex reports every file edit as ONE call with `tool_name: "apply_patch"` and the raw patch in `tool_input.command` (no `file_path`/`content`); `hooks/lib/codex-apply-patch.js` ports Codex's own lenient patch parser (`codex-rs/apply-patch/src/parser.rs` + `streaming_parser.rs`, rust-v0.160.0) and the guards check every Add/Update/Delete path and Move-to destination, resolved against `cwd`. Main thread vs subagent: Codex stamps `agent_id`/`agent_type` on hook payloads only inside a spawned subagent (`codex-rs/core/src/hook_runtime.rs`, first stable rust-v0.134.0; confirmed by a captured codex-cli 0.160.0 payload), so an `apply_patch` payload without them is the main thread, unless the Codex process inherited `CLAUDE_CODE_ENTRYPOINT` (launched from a Claude Code session as its worker), which fails open. A patch the parser rejects is blocked by edit-guard on the main thread (fail closed) and ignored by api-guard/ship-it-guard (fail open). On a Codex block the reason is also written to stderr: Codex parses stdout JSON only on exit 0 and treats exit 2 with empty stderr as a failed hook, so the tool call proceeds (`codex-rs/hooks/src/events/pre_tool_use.rs`, rust-v0.160.0; reproduced live with codex-cli 0.160.0). The same rule means `command-guard` and `compact-declaration-guard`, which block with stdout JSON + exit 2 and no stderr, do not block on Codex today (from source; not reproduced live); `git-guard` and `merge-gate` write stderr and are unaffected. Known gaps: shell writes (`cat >`, `tee`, `sed -i`) never reach these guards (on Codex, `command-guard`'s coordinator gate also fails open, because it keys on `CLAUDE_CODE_ENTRYPOINT`); api-guard sees only a hunk's added lines, so an import outside the hunk is missed; an `apply_patch` sent as a non-freeform (JSON function) tool call produces no PreToolUse payload (`apply_patch_payload_command` returns None).
- `PreCompact`: `precompact-snapshot.js` — mechanical pre-compaction snapshot (`PRECOMPACT-<n>.md`); Codex docs (`learn.chatgpt.com/docs/hooks`, "PreCompact") give it `trigger` + `turn_id`, ignore plain stdout, and stop compaction only on JSON `continue: false`, which this hook never prints; user messages are read from rollout `event_msg`/`user_message` entries
- `PostToolUse`: DevSwarm parent-decide/reply gate reply-tracker (`devswarm-parent-reply-tracker.js`, matcher `Bash`) and, as of v0.73.0, the child-only inbox-drain reminder (`devswarm-child-drain.js`, matcher `Bash`) — **registered, but their Codex payload contract is UNVERIFIED**: both have only been checked against the Claude Agent SDK's documented `PostToolUse` payload shape, not against a real Codex runtime. Unlike the other hooks in this list, they do not yet meet this port's own "live-aligned and regression-tested for Codex" bar; treat both as best-effort until confirmed against an actual Codex `PostToolUse` payload.
- `Stop`: task guards, speculation guard/judge (`speculation-guard.js` — shared file, so its optional Jev backend applies identically on Codex: off by default, enable via `~/.anti-hall/jev.json` or `ANTIHALL_JEV=1`; only a confident "speculative" Jev answer blocks, everything else falls back to the regex check; routed through the shared `hooks/lib/jev-assist.js` on/shadow/off + trust layer, see [`https://github.com/talas9/anti-hall/blob/main/docs/KB-jev-classifier.md` §10](https://github.com/talas9/anti-hall/blob/main/docs/KB-jev-classifier.md) — `speculation-judge.js`, also shared, skips its paid Haiku call for the same reason when `integrations.speculation` is `"on"`), DevSwarm parent-gate + child-gate forced-ack (`devswarm-parent-gate.js`, `devswarm-child-gate.js`)

Documented-but-not-yet-adapted anti-hall hard-hook parity:

- subagent lifecycle hooks: Codex documents `SubagentStart`/`SubagentStop`, but anti-hall has not yet added Codex-specific payload tests
- `PostCompact`: Codex documents it; anti-hall registers nothing there (`PreCompact` is now registered — see above)
- `TaskCreated`/`TaskCompleted` and Claude Workflow JS files: no direct Codex equivalent documented; use skills, native subagents, OMX, or scripts instead
- `hooks/task-lifecycle-log.js` (`TaskCreated`/`TaskCompleted` history ledger logging): Claude-only — confirmed by diffing this port's own `codex/hooks/hooks.json` (six events only: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `PreCompact`, `PostToolUse`) and `install-codex.js`'s `ANTI_HALL_HOOKS` map against the same set; no Codex task-lifecycle event exists to register it under
- `hooks/stale-agent-stop-note.js` (PreToolUse `TaskStop`, advisory): Claude-only, no Codex hook entry. The Codex docs this port tracks list `PreToolUse` matchers for `Bash`, `apply_patch`/`Edit`/`Write` and MCP tools only; none names a `TaskStop`-equivalent agent-stop tool, and the named in-process teammate records it reads (`teammate_spawned`, inbox sends, teammate reports) are Claude Code transcript shapes. Not verified against a live Codex session; revisit if Codex documents an agent-stop tool matcher.
- DevSwarm liveness supervisor (`companion/devswarm-supervisor.js`, 0.47.0): intentionally **Claude-only, no Codex mirror** — it recovers wedged *Claude Code* sessions specifically (targets `claude` processes, `claude --resume`, and `~/.claude/projects` transcripts). Like the Claude side it is OPT-IN and fully dormant unless DevSwarm is in use (`DEVSWARM_REPO_ID`). A Codex-side equivalent would be a separate future effort keyed to Codex's own session/transcript model.
- DevSwarm Phase-1 mechanical-trigger hooks — `hooks/devswarm-child-role.js` (SessionStart), `hooks/devswarm-parent-inbox.js` / `hooks/devswarm-child-turn.js` (UserPromptSubmit), and `hooks/devswarm-parent-gate.js` / `hooks/devswarm-child-gate.js` (Stop): **now mirrored in `codex/hooks/hooks.json`, unmodified** (corrected — a prior version of this note claimed these five hooks were Claude-only because their gating `DEVSWARM_*` env vars were assumed set only for the `claude` child sessions hivecontrol spawns; that premise was disproven against [`https://github.com/talas9/anti-hall/blob/main/docs/KB-devswarm-hivecontrol.md`](https://github.com/talas9/anti-hall/blob/main/docs/KB-devswarm-hivecontrol.md) §6/§8.7's live-verified env fingerprint, which shows `DEVSWARM_REPO_ID`/`DEVSWARM_SOURCE_BRANCH`/`DEVSWARM_BUILDER_ID` are set by hivecontrol per-workspace regardless of which agent runs there — `DEVSWARM_AI_AGENT` is the separate var naming claude vs codex, and `command-guard.js`'s own DevSwarm gate already relies on this same agent-agnostic fact). Their output contracts (`hookSpecificOutput.additionalContext` on SessionStart/UserPromptSubmit, `{decision:"block"}` on Stop) and the payload fields they read (`session_id`/`cwd`/`transcript_path`) match what `verify-first-full.js`/`task-tracker.js`/`task-guard.js`/`tasklist-guard.js` already prove works on Codex — so this was a pure wiring change, zero code changes to the five hook files themselves. **v0.93.0** (shared file, applies identically on Codex): `devswarm-parent-gate.js`/`devswarm-parent-inbox.js` now fold app-side archive detection (a registry row absent from the supervisor-cached `hivecontrol-active.json` by id and worktree path, stale by a 10-minute grace) and `archivedRegistryRows` into their known-registry set — an archived-but-still-live sender still blocks; a question is informational only when its sender matches no registry row of any kind, active or archived, and no descriptor. Pending-question sender attribution excludes the recipient's own identity family first, so a reply from the recipient or a cross-linked twin no longer wrongly clears someone else's question (`pendingQuestions[].from` contract change: now the true sender's identity-family id). **v0.94.0** (shared files, applies identically on Codex): when a worktree's meshId maps to more than one sibling registry row, sender attribution is now picked by a new pure, liveness-free function (`companion/lib/devswarm-attribution.js`'s `pickAttributionRow`: real-sessionId row wins, then the branch-slug row, then ascending lexical id) instead of the freshest-live picker, closing a bug where the same stored message could report a different sender across passes (defect f3b8f326bfc3). `reconcile` now bounds itself to a total wall-clock budget (60s default, `ANTIHALL_RECONCILE_BUDGET_MS`, `0` = unlimited), skips a row whose worktree is already gone before spawning, and defers whatever is left when the budget runs out to a resume marker drained first next run. `update.js` prints per-stage progress on stderr (`ANTIHALL_UPDATE_QUIET=1` silences it); `devswarm-repokey.js`'s git spawn now times out at 10s instead of hanging. `doctor --check` reports (never deletes) leaked test-fixture stores, and a new hygiene test lints for the leak pattern. **v0.95.0** (shared file, applies identically on Codex): `diagnose` resolves `sessionId` through the descriptor when the registry is stale, reporting a `descriptorSessionId` field on disagreement; `unclaimed:` promotion derives the caller's real session id from `--session`, `CLAUDE_CODE_SESSION_ID`, or — only for a row still carrying the marker or lacking a sessionId — the harness's own session file found by walking the parent-pid chain (cwd-in-worktree check plus a pid-reuse/staleness liveness guard); descriptor/registry divergence is repaired in both directions, and a registry write failure during promotion is now reported as `promotion.registryWriteError` on `inbox pull`/`read-primary`/`inbox messages` output (plus a stderr line) instead of being swallowed — the next read repairs the registry from the descriptor. **v0.96.0** (shared files, applies identically on Codex): `send`/fold target selection now uses a strict, heartbeat-aware liveness gate instead of a bare sessionId shape test, so a real-but-dormant session no longer outranks a genuinely live sibling for routing (the fold/rehome paths are deliberately left on the older predicate — an identity-match question, not a routing decision); `callerOwnsRow`'s "sole row on this worktree" ownership proof now also requires that row be unclaimed. `send`/`heartbeat` results and every ownership refusal carry an additive `identity: {id, kind}`. `inbox ack` refuses the whole verb (instead of half-acking) on a resolvable ownership mismatch — an unresolvable-caller-identity or unregistered-caller shape still fails open. `diagnose` rows carry an additive `archivedInApp` field, forcing `live:false` even against a fresh heartbeat; the app-side archive-cache match now also requires `repositoryId` agreement when both sides carry one. `reconcile` skips a worktree whose git root cannot resolve (`skippedNotGitRoot`) and now checks its own wall-clock budget before that git-root probe, not just before the resulting spawn. `update.js` applies one overall wall-clock budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default 90s) across every post-pull DevSwarm stage, deferring whole stages past the deadline. **Phase 5:** both Stop gates share `hooks/lib/stop-policy.js` — Codex's Stop payload carries `stop_hook_active` (Codex hooks docs), so a continuing turn is never re-blocked; the cap is keyed by stable block kind; no Monitor-equivalent grace is assumed for OMX. The delivery WAL, the `read-primary` → `ack-primary --receipt` split and stale-twin send routing live in the shared `companion/`/`scripts/` code and apply to Codex identically. **v0.106.0** (shared files, applies identically on Codex): (1) an archive-ready workspace from a PREVIOUS session whose entire unread backlog is the Primary's own `archive-request` send (`computeSummary`'s new `archive_request_only_unread` field) and whose session is no longer running no longer nags in the loud per-turn URGENT/`not-draining` segment (`devswarm-parent-inbox.js`) or the Stop gate — it still gets the existing cooldown'd archive-ready nudge, and still shows in the roster table, just not as `not-draining` forever with nobody left to drain it. (2) A new, simple user-editable ignore list, `~/.anti-hall/devswarm/ignore.json` (`{"ids": ["<id>", ...]}`, `companion/lib/devswarm-ignore.js`), suppresses the same urgent/not-draining nag for any explicitly-listed id on BOTH `devswarm-parent-inbox.js` and the `devswarm-parent-gate.js` Stop gate, while leaving the id fully visible in the roster/table — it only ever changes whether a turn gets interrupted, never what is tracked. (3) `spawn <branch> -t "<title>"` (or `--title=...`) now actually applies that title via the follow-up `update-title` call — an earlier cut skipped that follow-up whenever the caller had already passed `-t`, so an explicitly-titled spawn came back `titled:false` and the roster showed the raw meshId for that lane; see the main README's v0.106.0 note for the full root cause. Any lane mistitled by that bug self-heals on the next `reconcile` sweep (already run periodically by the supervisor) via its existing hivecontrol-`label` name backfill — no migration was needed.
- `hooks/ask-guard.js` (PreToolUse `AskUserQuestion`, optional `guards.noBlockingQuestions`): intentionally **Claude-only, no Codex mirror** — Codex has no `AskUserQuestion` ask tool to gate. The standing "do not hold work on a question" rule still applies to Codex agents as guidance only.
- `devswarm.inlineWorkNudge` (rides `hooks/edit-guard.js`): edit-guard is now registered on Codex's `apply_patch` matcher, so the nudge is reachable there, but it also needs a pending actionable task found in the transcript by `hooks/lib/task-state.js`, which has not been checked against a Codex transcript. `devswarm.dispatchTierText` and the no-workspace-repo suppression DO apply to Codex: `task-tracker.js`, `verify-first.js` and `verify-first-orch.js` are shared scripts behind the same gate.
- `hooks/coordinator-work-guard.js` (PreToolUse + PostToolUse `Bash`, the main-thread WORK window): **F1 is Claude-only, no Codex registration.** The Codex `PostToolUse` contract and Codex coordinator detection are both unverified, so the hook is not registered in `codex/hooks/hooks.json`. The Bash edit parity (F3) and the conservative `gh api graphql` read rule (F4) live in the shared `hooks/command-guard.js`, so they are shared files; F3 is Claude-host behaviour (it is gated by the same coordinator check as the heavy-command block), and whether it fires on Codex is unverified.
- `hooks/devswarm-comms-guard.js` (SendMessage mesh-only-comms gate, added for
  defect 1c74863863e5): intentionally **Claude-only, no Codex mirror** —
  `SendMessage` (Claude Code's cross-session/remote-agent messaging tool) has
  no Codex CLI equivalent to gate against. The underlying RULE still applies
  conceptually to Codex: a Codex-run DevSwarm Primary/child must channel
  workspace comms through the DevSwarm mesh (`devswarm.js send --to
  <meshId>`), not any future cross-session messaging mechanism Codex might add.
- `hooks/fable-availability.js`: intentionally **Claude-only, no Codex mirror** — it probes Claude's own user config for a Fable model entitlement to inform the Claude Reviewer-seat fallback, which is irrelevant to gpt-5.x Codex/OMX sessions (Fable is an Anthropic-exclusive model tier, not reachable from the Codex CLI). Like the DevSwarm supervisor, it has no Codex mirror by design — this holds regardless of whether Fable routing itself is policy-enabled or disabled on the Claude side (see `MODEL-POLICY.md`; Fable routing is RE-ENABLED as of 2026-07-12).

Model routing for Codex uses Codex model CATEGORIES, resolved from the live
catalog at the time you act — never a slug pinned in this doc. See
`anti-hall-model-policy` for the resolution steps:

- planning, validation, debate: **frontier** (reasoning `xhigh`)
- implementation: **workhorse** (reasoning `medium`)
- cheap mechanical work: **fast**; if a category can't be resolved with
  confidence, omit `-m` and let the CLI use its configured default.


## Ported Codex skills

The Codex port exposes first-pass equivalents for the anti-hall skill surface:

- `anti-hall-activate` — install/enable supported Codex hooks
- `anti-hall-root-cause` — root-cause debugging protocol
- `anti-hall-orchestration` — delegation/task discipline
- `anti-hall-deadly-loop` — Reviewer/Critic hardening loop with the **frontier** category
- `anti-hall-ship-it` — scaled plan/build/verify workflow (replaces the retired `anti-hall-feature-launch`)
- `anti-hall-context-conserve` — context/usage conservation and model routing
- `anti-hall-model-policy` — Codex model routing table
- `anti-hall-doctor`, `anti-hall-update`, `anti-hall-debt`, `anti-hall-simplify`, `anti-hall-flutter-debug`, `anti-hall-install-statusline`, `anti-hall-omx`, `anti-hall-omc`
- `anti-hall-defects` — file/list/show/rule on anti-hall defect reports
- `anti-hall-devswarm` — DevSwarm integration: mesh CLI, recovery, auto-archive/prune, retention, app DB
- `anti-hall-jev` — activate/configure/check the opt-in Jev classifier
- `anti-hall-system-briefing` — live enumeration of every installed hook, skill and substrate
- `anti-hall-settings` — show/change any anti-hall setting; numbered-choice menu fallback (Codex has no `AskUserQuestion`) and no `/config` panel equivalent (Claude Code's `/config` carries only the headline switches, the safety guards and the keys) — `scripts/settings.js` is the only front door, grouped by category (`show`, then `show --section <category>`)
- `deadly-loop-multi` (the double/triple/quadruple deadly loop) is intentionally **Claude-only, not ported** — it multiplies the Claude Sonnet/Opus/Codex trio, and there is no `anti-hall-deadly-loop-multi` Codex skill; use `anti-hall-deadly-loop` instead.
- `anti-hall-handover` — comprehensive session handoff (index + per-session HANDOVER.md + detail files) so a fresh session can resume without re-deriving or guessing anything

Context conservation is also wired as a `UserPromptSubmit` hook via `limit-conserve-inject.js`.
Feature launch is intentionally a Codex/OMX planning protocol, not a GSD wrapper, because GSD was removed from active Codex config.

## Codex/OMX statusline

Claude Code supports command-backed `statusLine` renderers, so anti-hall can wrap
an existing statusline and append the `AH: Vx.y.z` chip. Codex/OMX currently
configures `[tui].status_line` as an ordered list of built-in item IDs only
(for example `model-with-reasoning`, `git-branch`, `context-remaining`,
`codex-version`, token counters, and limit counters). No supported custom item
ID or command-backed footer renderer is documented in the local Codex/OMX docs
used for this port.

Codex-safe behavior:

- anti-hall does **not** inject an unsupported `anti-hall-version` footer item
- `anti-hall-install-statusline` documents the supported Codex/OMX HUD path
- the Claude statusline installer remains unchanged for Claude Code

## Known tradeoffs and false positives

Guards are pattern- and rule-based, so they sometimes block or nag when they should not. What the repo documents:

- **Legitimate commands can be blocked.** Fixed in the [CHANGELOG](https://github.com/talas9/anti-hall/blob/main/CHANGELOG.md): `command-guard` matched heredoc lines such as "make sure..." and grep/sed/awk search patterns as heavy commands; `output-verify-guard` flagged a clean `cargo test` line ("0 failed") as a mixed result; `model-routing-guard` had a measured 24% false-positive rate on mechanical haiku spawns (24.1% to 0% on that sample after the fix). Still open: text inside a heredoc is scanned as shell, so a note that merely mentions a push command can be blocked ([GUIDE](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#git-guard)).
- **Escape hatches.** Tell the assistant to skip a guard for a while (`~/.anti-hall/skip.json`, 15 minutes by default; `"all"` never covers `git-guard`), or turn it off with its setting: `safety.*` (`gitGuard`, `commandGuard`, `editGuard`, `swarmGuard`; changing them needs `--confirmed`) and `guards.*` (for example `guards.apiGuard`, `guards.speculationGuard`, `guards.modelRouting` = `advisory` or `off`). Table: [what it blocks and how to turn it off](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#what-it-blocks-and-how-to-turn-it-off).
- **Hook latency is not measured.** The repo has no end-to-end hook-overhead figure. Only the optional parts have numbers: the semantic judge is documented at about 1-3 s per Stop when enabled (off by default), and the Jev classifier benchmark reports a 379 ms p50 per call ([KB](https://github.com/talas9/anti-hall/blob/main/docs/KB-jev-classifier.md)).
- **Advisory messages can be noisy.** Silence them individually: `guards.failureRootCauseNudge`, `guards.silentAgentNudge`, `guards.scanThrottle`, `codexNudge.enabled`, `autoHandover.nag`, `limitConserve.mode` = `off`. After a confirmed false positive, `guards.stopAck` lets a session ack it for `silent-agent-nudge` and `tasklist-guard`. All keys: [settings](https://github.com/talas9/anti-hall/blob/main/docs/GUIDE.md#settings-anti-hallsettings).
- **What it does NOT protect against.** `speculation-guard` is lexical: it misses a confident inference with no hedge word (only the opt-in semantic judge targets that). `git-guard` does not cover `xargs`, aliases, or interactive-editor commits with no `-m`/`-F`. The verify-first eval found no net fabrication reduction from the prompt alone in its four runs ([eval/README.md](https://github.com/talas9/anti-hall/blob/main/eval/README.md)); the guards' blocking is covered by unit tests, not that eval. On this Codex port, `edit-guard`, `api-guard` and `ship-it-guard`'s existence gate run only on `apply_patch` edits (Codex 0.134+): shell writes bypass them (see Parity Notes).

## Documentation

Everything else starts at the
[documentation start page](https://github.com/talas9/anti-hall/blob/main/docs/README.md).
