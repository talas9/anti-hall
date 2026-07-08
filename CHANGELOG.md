# Changelog

All notable changes to the anti-hall plugin are documented here. The plugin pins an
explicit `version` in `plugin.json` only (the authority); the marketplace entry carries
no `version` to avoid the silent-precedence trap where `plugin.json` wins silently. Every
behavioral change MUST bump `plugin.json` `version` or installed users will not receive
the update.

## 0.47.0

**New OPT-IN DevSwarm liveness supervisor — a pure-Node companion that detects a wedged/idle
DevSwarm workspace agent from its OUTBOUND activity and precisely recovers it (targeted kill +
`claude --resume`), fully dormant unless DevSwarm is in use. Hardened by a 3-seat deadly-loop that
found 15 issues (incl. a wrong-victim P0) — all fixed with non-vacuous tests BEFORE any code
shipped. `node --test` = 855 pass / 0 fail / 2 Windows-skips (+74 tests).**

### What it is
- A background companion (`companion/devswarm-supervisor.js`, installed via
  `companion/install-devswarm-supervisor.js` — the same opt-in launchd / systemd-user / cron model
  as the `mcp-reaper`). Per active DevSwarm workspace it computes liveness from **OUTBOUND** signals
  (the agent's own session-transcript activity + git/worktree activity — not inbound messages, which
  are blind to the hang) and recovers the agent only when BOTH signals are idle past a threshold AND
  the workspace has pending work it should be servicing.
- Works around an upstream Claude Code core hang (process stays alive but can't service the next
  turn, so crash-restarters never fire) — labeled a documented workaround for `claude-code#39755`,
  to re-evaluate when a real upstream fix lands.

### Optional — exactly like OMC/OMX
- Entirely feature-detected via `DEVSWARM_REPO_ID` (new `hooks/lib/devswarm-detect.js`, modeled on
  `omc-detect.js`). When DevSwarm is not in use, the supervisor and its doctor check are completely
  dormant — zero effect, nothing installed, no context. Opt-in install; kill-switch + config env.
  Documented as optional in README + llms.txt alongside OMC/OMX.

### Safety (it kills processes, so it is hardened accordingly)
- **Precise targeting, never a broad `pkill`:** maps a workspace to exactly one `claude` pid via the
  process's own argv session-id + a real cwd match, and **ABSTAINS** on any ambiguity (0 or >1
  candidates).
- **Identity-bound:** the target's session-id must match the workspace's declared id AND the process
  must be **headless (`-p`)** — so a human who takes over a worktree interactively is never killed.
- Re-confirms identity on fresh data immediately **before every kill signal** (PID-recycle/TOCTOU
  defense, mirroring `mcp-reaper`); **group-kills** so it never orphans MCP children; **detached
  `--resume`** so it can't time-out and kill legitimate long-running work; **stale-lock steal**
  (mirroring `swarm-guard`) so a supervisor crash can't permanently disable recovery; a per-workspace
  recovery cap that escalates instead of looping; single-flight sweep; descriptor-id sanitization;
  bounded `ps`/`lsof` probes. **Fail-open throughout** — any error logs and continues, never kills a
  healthy agent. **Windows = detection-only** (a running process's cwd isn't obtainable in pure Node
  there), matching the `mcp-reaper` platform stance.
- **doctor** gains a per-active-workspace listener + liveness PASS/WARN/FAIL check (dormant when no
  DevSwarm) and now syntax-checks the new `lib/` files.

### The seam — anti-hall stays generic; the consumer owns the DevSwarm glue
- anti-hall ships only the generic, agnostic supervisor. The DevSwarm-specific transport (inbox
  daemon, done-report contract, `hivecontrol` wiring) stays consumer-side. Interface: the consumer
  publishes a per-workspace descriptor `~/.anti-hall/devswarm/workspaces/<id>.json =
  { id, worktreePath, inboxPath, cursorPath, sessionId }`; anti-hall derives pid/session itself and
  writes a liveness verdict + recovery log. Full design + implementation plan under
  `docs/superpowers/`.

## 0.46.0

**Whole-plugin ultracode audit remediated: 2 critical guard/data-loss bugs + 21
correctness/parity fixes, plus 3 opt-in DevSwarm/hivecontrol integration hooks. Every fix
ships with a non-vacuous test; `node --test` = 783 pass / 0 fail / 2 Windows-skips.**

### Critical (P0)
- **git-guard `bash -c`/`sh -c` bypass closed.** `scanCommand()` unwrapped only `eval`, so
  `bash -c "git push --force"` and `bash -c '… Co-Authored-By: Claude …'` both passed (exit 0)
  — a total bypass of the one guard the repo treats as non-skippable. Added
  `extractShellCPayload()` (SHELL_VERBS `bash/sh/zsh/dash/ksh/ash` + `-c`/`--command`) with
  depth-bounded recursion, mirroring `command-guard.js` / `graphify-guard.js`. Also fixed
  `splitSegments` splitting on the `&` in `2>&1` / `>&2` / `&>`, which had orphaned a trailing
  `--force` into a non-`git` segment. Both classes now block (exit 2).
- **statusline uninstall no longer clobbers a committed settings file.** `uninstall --project`
  targeted `.claude/settings.json` while the installer writes `.claude/settings.local.json`, and
  Strategy A overwrote it with the global base — no backup, no check it was even anti-hall's.
  Now resolves `settings.local.json` first, only rewrites when the current value is the anti-hall
  dispatcher, and backs up before mutating.

### Correctness & parity (P1)
- **Guards:** command-guard adds a narrow, path-anchored exception for the coordinator-owned
  helpers `statusline/phase.js` + `hooks/agent-watchdog.js` (arbitrary `node *.js` still blocked in
  coordinator context); tasklist-guard's `BASH_WORK_RE` no longer counts read-only Bash (quoted
  content, `2>` stderr redirects, mid-command write-verbs) as file-changing work.
- **Workflows / skills:** `ship-it.workflow.js` now begins with `export const meta` (the Workflow
  runtime previously rejected it, so `/ship-it` could not run), its audit gate blocks on new P0
  **or** P1 (was P0-only), and Codex-implemented code is reviewed by an Opus Critic (implementer ≠
  reviewer). `deadly-loop.workflow.js` re-checks a respawned seat for drift before trusting it as a
  live GO. `deadly-loop/SKILL.md` swarm-mode Reviewer is Sonnet 5 (Fable routing is policy-disabled).
- **Codex port:** every Codex skill resolves the plugin root via a `$ANTI_HALL_ROOT` preamble —
  verified against official Codex docs that `${PLUGIN_ROOT}` is expanded only for hook commands,
  never in skill bodies — instead of clone-relative `node plugins/anti-hall/…` paths that break
  once the port is installed as a plugin. The Codex ship-it `STATE.json` gained the 0.45.0
  `gate:"locked"|"not-run"` field + PLAN.md `## Goal coverage` (anti-false-completion parity);
  `install-codex.js` dedup is backslash-safe so a Windows re-install no longer duplicates all 15
  hook groups.
- **Statusline:** `install --consolidate` on the already-installed path no longer throws a TDZ
  `ReferenceError`.
- **Docs accuracy:** model-routing-guard default documented correctly (strict by default since
  v0.35.0; `=advisory` opts out — was documented backwards); the dead OMC companion link repointed
  to the real upstream; the `docs/KB.md` version row refreshed; and a private project codename
  scrubbed from a committed doc (agnostic-mandate fix).

### DevSwarm / hivecontrol integration (opt-in, off by default)
- **merge-gate** also recognizes `hivecontrol workspace merge-into-source` / `merge-from-source`
  (stays default-OFF via `ANTIHALL_MERGE_GATE`; `skip.json` override intact).
- **deadly-loop** writes an explicitly-**advisory** `~/.anti-hall/approvals/<repo>@<HEAD-sha>.json`
  on convergence (`"proof": false` — an audit record, never an authorization token; the reader must
  enforce its own real gating). Mirrored into the Codex deadly-loop skill.
- **swarm-guard** appends a blocked-spawn trip to a separate `~/.anti-hall/swarm-trips.log` so a cap
  trip leaves a forensic trace (the rate window and `SPAWN_CAP` are untouched — observation only).

### Also in this release (carried-forward cleanup + docs)
- **Codex `anti-hall-feature-launch` fully removed** — completes the 0.45.0 GSD/feature-launch
  retirement on the Codex side. The skill is deleted and every reference (`codex/README.md`,
  `docs/KB-omx.md`, `codex/skills/anti-hall-omx/SKILL.md`, and the plugin-manifest description)
  now points at `anti-hall-ship-it`.
- **graphify guidance modernized.** `doctor.js`, `graphify-reminder.js`, `graphify-session.js`, and
  the SessionStart primer now say `graphify update .` (code graph) / `/graphify . --update --obsidian`
  (docs + Obsidian) instead of the retired `/graphify --obsidian`, and the legacy `.planning/graphs/`
  fallback is dropped (GSD is gone) — with a regression test asserting `.planning/graphs` alone no
  longer triggers the graphify-first injection.
- **New DevSwarm / hivecontrol docs.** `docs/KB-devswarm-hivecontrol.md` — a reference KB for the
  `hivecontrol` CLI (v2.3.3), the `.devswarm/config.json` schema, and workspace role-detection —
  plus the approved DevSwarm-aware workspace-tier orchestration design + implementation plan under
  `docs/superpowers/`. The feature itself is not built yet; these are the hardened design/plan for a
  separate later effort.

## 0.45.0

**GSD discontinued and removed as a live dependency; 4 new research KBs; a 17-item cross-KB
feature audit resolved; a plugin-wide KB-contradiction sweep; 2 real bugs fixed in
`deadly-loop.workflow.js`.**

### GSD (`.planning/`) removed — owner decision, GSD itself is discontinued
- `ship-it/SKILL.md`, `ship-it-guard.js`, and `docs/KB.md` no longer recognize `.planning/PLAN.md`
  — `PLAN.md` at the repo root is the only location. `graphify-guard.js`, `graphify-reminder.js`,
  and `doctor.js` no longer treat `.planning/graphs/` as an alternate graph location.
- `scripts/migrate-state.js` gained `migrateGsdPlanning()`: folds an existing `.planning/` tree
  into `.anti-hall/history/legacy/planning/`, then **deletes each source file once its own copy
  is verified byte-identical** — the `.planning/` directory (and any subdirectory) is never
  removed, only the individual files inside it, one at a time. A file whose copy can't be
  verified is left in place, reported as `verify-failed`, never silently deleted. Wired into
  `/anti-hall:update`'s existing migration step (same command, no new invocation needed).
- `AGENTS.md`'s dual-platform-parity section now documents two accepted structural limitations
  (Codex has no Dynamic-Workflows equivalent; Claude→Codex integration is one-directional) so
  future work stops re-litigating them, and explicitly extends the parity mandate to KBs.

### 4 new research KBs (all source-count-verified, none padded)
- `docs/KB-model-modes.md` (47 sources) — Claude/Codex effort levels, Plan Mode, the Workflow
  tool + "ultracode" (confirmed officially documented), `/code-review ultra`. Found and fixed a
  real terminology-drift bug (prompt text said "max thinking"/"max reasoning" when the actual
  code passes `effort:"high"`/`"xhigh"` — Codex has no `max` tier at all) across 10 files.
- `docs/KB-overengineering.md` (15 sources) — general SE + AI-agent-specific causes of
  overengineering, empirical bloat measurement.
- `docs/KB-false-completion.md` (21 sources) — reward hacking / specification-gaming research;
  identified that ship-it v2's own `STATE.json` protocol (shipped last release) was prose-only
  and mechanically unenforced — the exact failure mode the research catalogs, now fixed (below).
- `docs/KB-goal-setting.md` (15 sources) — goal-clarity research; identified a gap between
  Step 1's intent and Step 2's decomposed phases with no reconciliation check — now fixed (below).

### KB-contradiction sweep — 13 real contradictions found and fixed across 15 KB docs
Including a within-document self-contradiction in `KB-sonnet-5.md` (TL;DR vs its own cited
source), a benchmark figure mis-attributed to the wrong model, a pre-Sonnet-5 routing doc never
flagged as superseded, and a stale error-code claim contradicting its own correction three
sections later. All 13 independently re-verified against the actual working tree (grep/ls
counts), not just re-read.

### Feature-improvement audit — all 17 findings resolved
- **Doc/text fixes:** `deadly-loop-multi` retry-arithmetic (wrong tier referenced), `task-guard.js`
  under-description, `gpt-5.3-codex-spark` presented as interchangeable with `gpt-5.4-mini` (fixed
  across 9 Codex files + added an Effort column to the Codex model-policy table), a 4-location
  Fable stale-language sweep, `update`/`doctor` SKILL.md delegation instructions missing an
  explicit model (live-verified to trigger `model-routing-guard.js`'s own block).
- **Real code fixes:** `ship-it.workflow.js`'s `buildAgent()` now pins explicit effort
  (`medium`/`high`, opt-up via `phase.effort`) instead of silently inheriting a model default;
  `ship-it-guard.js` gained a plan-conformance advisory (flags — never blocks — an edit outside
  every phase's declared `files:`); `graphify-guard.js` is now subagent-aware (a delegated
  subagent's search no longer burns the coordinator's one-time nudge) and re-arms its nudge after
  ~240KB of transcript growth instead of firing once per session forever; `task-tracker.js` gained
  the same token-growth re-arm trigger alongside its wall-clock one; `doctor.js` now sums the
  footprint of every registered SessionStart hook (was undercounting) and gained a behavioral test
  for `version-alert.js`; Codex-native deadly-loop documents its same-model-TRIO as a disclosed
  degraded config with an opt-in cross-model escalation path for L-tier hard-risk work.
- **Empirical verification, not assumed:** ran a real experiment confirming SubagentStart's
  `additionalContext` genuinely reaches a spawned subagent's model context (cross-checked against
  37 historical subagent transcripts) — `docs/KB-claude-codex.md` updated accordingly.
- **`ship-it/SKILL.md` protocol additions** (from the two false-completion/goal-setting KB
  findings above): `STATE.json` gained a `gate:"locked"|"not-run"` field, set only after Step 5's
  deadly-loop actually locks — a resumed phase can no longer be trusted `done` from inference
  alone. `PLAN.md`'s template gained a "Goal coverage" field mapping each intent clause to the
  phase that proves it, plus a new Step 3 Reviewer-checklist bullet verifying that mapping.

### 2 real bugs fixed in `deadly-loop.workflow.js` (not doc-only — logic changes)
- The Opus Reviewer-fallback silently inherited the Sonnet-5 seat's `effort:"xhigh"` via object
  spread instead of using Opus's own tier — fixed with a fresh options object (`effort:"high"`).
- Phase 2b (Argue) dispatched using each seat's *static* role-defined opts, never the opts that
  actually answered in Phase 2a — meant a seat whose primary model failed over during Investigate
  would silently retry the dead model in Argue with zero fallback and zero signal in
  `verdictSummary`. Fixed by threading the resolved per-seat opts from 2a into 2b.

### GSD removal, part 2 — statusline + Codex-side parity gaps
A deeper sweep found GSD support was more extensive than the first pass caught:
- `statusline-monorepo.js` was an entire dedicated rendering mode for GSD state
  (`readGsdState`/`formatGsdState`/`.planning/config.json`) — stripped down to its
  non-GSD content (model/context/current-task/dir); `.gsd/`/`.planning/` dropped as
  monorepo-detection triggers in `statusline.js` (`.gitmodules` still triggers monorepo
  mode for real git-submodule projects); `statusline-rich.js`'s GSD phase chip removed.
- Two Codex-side skills contradicted their own stated intent: `anti-hall-feature-launch`
  explicitly said "do not invoke GSD commands, GSD was removed" while still instructing
  every artifact write into `.planning/` — fixed to `.anti-hall/feature-launch/`.
  `anti-hall-ship-it` still preferred `.planning/PLAN.md` — fixed to repo-root only,
  matching the Claude-side fix.
- `install-statusline`'s SKILL.md and llms.txt's Codex README were also swept.
- Historical/research docs (`docs/gsd-distilled.md`, `docs/KB-claude-codex.md` §12,
  `docs/superpowers-planning.md`) were deliberately left untouched — they document GSD's
  design as research provenance for anti-hall's own swarm/debate model, not live
  coexistence, matching this repo's "historical artifacts are frozen" convention.

### Process note
Codex's independent verification of this release's implementation batch flagged one genuine
defect (not environmental noise): a probe-record fixture claimed a grep returned zero matches
when it actually returns one — corrected in place, logged rather than silently patched.

Suite 729 (727 pass / 0 fail / 2 skip, up from 703 at the start of this release).

## 0.44.0

**Ship-it v2: resumable state, a global P0+P1 convergence gate, Codex-primary build seats, and legacy-state migration.**

- **Global deadly-loop convergence gate now blocks on confirmed P0 *or* P1** (was P0-only).
  `deadly-loop.workflow.js`'s `VERDICT_SCHEMA` already tagged every finding P0/P1/P2/P3; the
  gate simply never checked P1 until now. This is a plugin-wide change — every deadly-loop
  consumer (ship-it, root-cause debugging, deadly-loop-multi) now requires zero NEW P0s AND
  P1s to converge, not just P0s. Mirrored in the Codex-native `anti-hall-deadly-loop` skill.
- **ship-it v2, L-tier only:**
  - Resumable `.anti-hall/ship-it/<slug>/STATE.json` (coordinator-owned protocol — Dynamic
    Workflow scripts have no filesystem access, so this lives in `SKILL.md`, not the
    `.workflow.js` template): `plan_hash` (drift detection against `PLAN.md`), per-phase
    status, and an `escalations` counter. Reuses the existing `~/.anti-hall/agents/*.json`
    heartbeat convention (`agent-watchdog.js`) rather than inventing a new one.
  - P2-severity findings from a converged deadly-loop no longer vanish — they're appended to
    `.anti-hall/ship-it/<slug>/decisions.md`.
  - Build-to-plan escalations (a fix that needs re-planning, not just another fix-wave) are
    capped at 2; the 3rd stops and surfaces to the owner instead of looping.
  - Step 6 now auto-writes a session-history entry (via the existing per-session system) plus
    `.anti-hall/ship-it/<slug>/SUMMARY.md`, then triggers `/graphify --obsidian --update`.
- **Build seats now try Codex-primary / Sonnet-5-failover** (`buildAgent()` in
  `ship-it.workflow.js`, mirroring the existing `criticAgent()` fallback shape) instead of
  always going straight to Sonnet 5 — matching MODEL-POLICY.md's already-documented
  implementation-seat routing. Surfaced a real cross-model gap: when a phase's build falls
  back to Sonnet 5, that phase's Reviewer seat (also Sonnet-5-by-default) would otherwise be
  reviewing its own model's output. Fixed — the Reviewer now skips Sonnet 5 and goes straight
  to Opus for any phase Sonnet 5 itself built.
- **`scripts/migrate-state.js`** (new) — non-destructive (copy-only, never deletes/moves),
  idempotent script that folds legacy root `.anti-hall-progress.md` / `.anti-hall-history.md`
  files into `.anti-hall/history/legacy/` for repos that haven't been through that migration
  yet. Wired into the `update` skill as a post-pull step.
- **Codex-native `anti-hall-ship-it` parity** — same L-tier resumable-state convention, P0+P1
  LOCK threshold, P2 decisions log, migrate-state.js reference, and wrap-up/summarize step,
  written as protocol text (this port has no Dynamic Workflow runtime, so nothing here relies
  on one). Codex-native ship-it is already the Codex-primary implementer by construction, so
  the cross-model self-review guard above doesn't apply on this port.
- Doc sweep: README (root + plugin) and llms.txt updated for the above; also corrected
  drifted test-pass counts (623/625 → 701/703) that had gone stale since 0.43.0.

Suite 703 (701 pass / 0 fail / 2 skip, up from 688 — 15 new tests across the deadly-loop and
ship-it workflow suites plus the new migrate-state suite).

## 0.44.1

**Fixed a Windows-only CI failure in 0.44.0: the new determinism test's comment-stripping
regex silently no-op'd on CRLF checkouts.**

- `tests/hooks/ship-it-workflow.test.js`'s determinism test stripped `//` comments by
  splitting on `\n` then matching `\/\/.*$` per line. On a Windows (CRLF) checkout each
  split line keeps a trailing `\r`; since regex `.` never matches a line terminator, `.*`
  can't reach the line's true end, so `$` (no multiline flag) never matches and the strip
  silently does nothing. The file's own doc-comment ("no Date.now() / Math.random() /
  argless new Date()") then survives verbatim into the "code" being scanned, and the test
  fails on every Windows Node version (18.x/20.x/22.x/24.x) — confirmed via `gh run view`
  after v0.44.0's push, reproduced locally with a CRLF-line simulation, and root-caused by
  comparing against `deadly-loop-workflow.test.js`'s equivalent test, which uses a `gm`-flag
  regex over the whole string instead (CRLF-safe by construction) and passed on the same run.
- Fix: normalize `\r\n` → `\n` before splitting, matching the CRLF-safe approach already
  used elsewhere. v0.44.0's tag is left as-is (not retagged) since it was never propagated
  to the marketplace or given a GitHub Release.

Suite 703 (701 pass / 0 fail / 2 skip locally); Windows CI re-verified green after this fix.

## 0.43.2

**Fable routing policy-disabled: negative community feedback (over-restrictive/refusal-prone).**

- `reviewerAgent()`/`buildFormation()` in ship-it.workflow.js and deadly-loop.workflow.js no
  longer attempt Fable for the Reviewer seat, even when `args.fableAvailable === true`. Reason:
  a soft refusal from an over-restrictive model would pass StructuredOutput schema validation
  as a "successful" verdict and get silently treated as real analysis -- worse than the
  already-handled unavailable/null case, and not worth building refusal-detection for given
  the community's reported experience with Fable's current behavior. Sonnet 5 is now the fixed
  primary Reviewer regardless of the flag; Opus stays the final fallback.
- The `fable-availability.js` SessionStart hook and its cache stay in place for visibility
  (informational only, no longer acted on) -- easy to re-enable if Fable's track record improves.
- MODEL-POLICY.md (both copies) documents the policy decision and its reasoning.
- Fixed a doc-currency gap the 0.43.0 doc sweep missed: `orchestration/SKILL.md` still
  described the OLD single `.anti-hall-progress.md` file as the enforced mechanism; now
  references the per-session path.

2 tests updated to assert the new behavior (Fable never attempted); suite 688
(686 pass / 0 fail / 2 skip).

## 0.43.1

**History-entry writes now delegate to a cheap model; fixed a stale path left by 0.43.0.**

- `verify-first-full.js`'s always-injected orchestration rule B previously told the coordinator
  to compose and append history entries itself (an expensive-model tokens spent on a mechanical
  write). Now it says to delegate the write to a cheap model (Haiku): hand it the cause/fix/
  verification facts, let it compose and append the entry.
- The same instruction still referenced the OLD flat-file path (`.anti-hall-history.md`) from
  before 0.43.0's per-session restructuring -- missed by that release's doc sweep since it's a
  hardcoded string, not a doc file. Now points at `.anti-hall/history/<date>/<session-id>.md`.

Suite 688 (686 pass / 0 fail / 2 skip), no test/code changes beyond the instruction string.

## 0.43.0

**Fable-5 availability flag (auto-detected, gated) + collision-free per-session progress/history.**

### New: automatic Fable-5 detection — no manual "reconsider this seat" needed
`fable-availability.js` (new SessionStart hook) reads `~/.claude.json`'s `modelAccessCache`/
`additionalModelOptionsCache` -- the exact same data Claude Code's own `/model` selector renders
from -- ONCE per session (never re-probed every turn), fail-open, silent unless Fable 5 is
actually available. When it is, the flag threads into ship-it/deadly-loop Workflow invocations
via `args.fableAvailable`, and the Reviewer seat's fallback chain automatically extends to
Fable 5 → Sonnet 5 → Opus (previously Sonnet 5 → Opus). No live API probe as the primary path
(many Claude Code sessions have no `ANTHROPIC_API_KEY` to probe with); this reuses Claude Code's
own already-maintained entitlement cache.

### New: per-session progress/history files — collision-free across concurrent sessions
`.anti-hall-progress.md` and the fix/history ledger used to be single shared files at the repo
root -- two Claude Code sessions running concurrently on the same project could clobber each
other's writes. Now each session gets its own file: `.anti-hall/progress/<date>/<session-id>.md`
and `.anti-hall/history/<date>/<session-id>.md`. `tasklist-guard.js`'s freshness check now
targets the current session's own path (session_id + UTC date, sanitized). Both get a running
`INDEX.md` maintained via single-line atomic appends only (`fs.appendFileSync` with the `'a'`
flag, idempotent, never read-modify-rewrite -- safe even if two sessions finish at the same
moment). The old root-level ledgers are preserved untouched (`.anti-hall-history.md` also copied
to `.anti-hall/history/legacy/pre-2026-07-01.md`); local `CLAUDE.md` now points at both new
`INDEX.md` files as the entry point for finding prior session work.

### New: progress-file pruning — dated+timed, auto-archived into history
Per-session progress files solve the single-huge-file problem but would otherwise accumulate
unboundedly (one small file per session, forever). `progress-prune.js` (new SessionStart hook,
per-cwd 24h-throttled) archives stale ones automatically: a newly-created progress file now
carries a `<!-- session: ... | started: <ISO-8601 UTC> -->` header (dated *and* timed, human-
readable); today's UTC date-folder is never touched; a past-date file is only pruned once its
mtime is more than 6 hours stale (so a session still running across a midnight boundary is never
touched mid-flight); pruning always appends the file's full content to that session's own history
ledger under an "Archived progress" heading *before* deleting it — never deletes if the archive
append fails, so no data is ever lost, only relocated.

### Hardening
- Fixed a real gap the adversarial verify step caught: the history-side index maintenance was
  dead code (`kind !== 'progress'` guard) despite being part of the spec -- now both progress
  and history are mechanically indexed, existence-triggered for history (no per-turn freshness
  concept applies there) so nothing depends on the agent remembering a manual bookkeeping step.
- `ship-it/SKILL.md`'s Reviewer-seat prose updated to describe the automatic fallback chain
  instead of the stale "if Fable returns, reconsider this seat" note.

17 new tests (fable-availability.test.js, ship-it-workflow.test.js, progress-prune.test.js,
+ additions to deadly-loop-workflow.test.js and tasklist-guard.test.js); suite 688
(686 pass / 0 fail / 2 skip).

## 0.42.1

**Bug-fix patch: root-causes the recurring ubuntu/node22 statusline flake and hardens `harvest-debt.js` / `eval/rescore.js`.**

### Fixed: statusline base-command timeout flake
`runBaseCommand`'s `spawnSync` timeout raised from 3000ms to 10000ms. Root-caused via
code read (not a re-run guess) to CI runner contention on the `ubuntu-latest`/node22 job
specifically; the flake had recurred 3 times across prior releases.

### Hardened: `harvest-debt.js`
- Fixed a multi-marker-per-line drop (only the first `// anti-hall:` marker on a line was
  picked up).
- Fixed a comment-closer (`-->`, `*/`) leaking into the parsed `when` field.
- Oversized files are now skipped, not silently truncated.
- Directory walk converted from recursive to iterative (avoids stack-depth risk on deep
  trees).
- Added tests covering `<!-- -->` and `--` marker styles.

### Hardened: `eval/rescore.js`
- `--selftest` now warns (instead of silently disagreeing) on a non-boolean `fabricated`
  value, a missing `condition`, or a duplicate `task_id` in the aggregate.
- Removed a duplicate `'use strict'` directive.
- Added missing selftest branch tests for the above.

Full suite: 664 tests, 662 pass, 2 skipped, 0 fail.

## 0.42.0

**Sonnet 5 routing update + `KB-sonnet-5.md`; retires the Fable-disabled temp patch.**

### New: `docs/KB-sonnet-5.md` — model routing KB (Claude + Codex)
Benchmark tables for Opus 4.8 / Sonnet 5 / Haiku 4.5 **and** the parallel Codex table (gpt-5.5 / gpt-5.4 / gpt-5.4-mini), effort-tier behavior, pricing, a task→model decision matrix, switch thresholds, the anti-hall seat routing, and cross-platform equivalence (gpt-5.5↔Opus, gpt-5.4↔Sonnet 5, gpt-5.4-mini↔Haiku). 17 sources (2 official Anthropic + 3 official OpenAI); benchmark figures are directional (system-card PDFs unparsed) and source-tagged. Indexed in `docs/KB.md` + `llms.txt`.

### Routing: Sonnet 5 lands; Fable-temp retired
The `sonnet` tier token now resolves to `claude-sonnet-5`. MODEL-POLICY (both byte-identical copies) + the ship-it/deadly-loop workflow seats updated: **implementation → Codex primary, Sonnet 5 failover**; **deadly-loop Reviewer + M/secondary planning → Sonnet 5 @xhigh** (Auditor stays Opus @high, Critic stays Codex); Opus keeps top-level planning / root-cause / deep-debug. New rules: (1) the code implementer and its correctness reviewer are **always different models** (cross-model, no self-review); (2) Codex is the primary implementer (own limit → conserves the Claude bucket), failover to Sonnet 5 on unavailable/rate-limited — backoff, never retry-loop; (3) **never run Sonnet 5 at `max` inside a loop** (TTFT ~163s). The long-standing `TEMP(fable-disabled)` patch on the Reviewer seat is **removed** (Sonnet 5 fills it; a one-line "if Fable returns, reconsider" pointer remains).

### Limit-conservation: main-model downshift directive
When conservation is active, `limit-conserve-inject.js` now advises downshifting the **main coordinator** off the flagship (Claude Opus → Sonnet 5; Codex gpt-5.5 → gpt-5.4) to preserve the flagship weekly bucket — **but only to a 1M-context target** (never gpt-5.4-mini / 400k), so no context is lost. The flagship stays for delegated hard seats + escalation. Conditional advisory (the model isn't exposed in the UserPromptSubmit payload); the agent surfaces it (it can't self-`/model`). Codex mirror in the `anti-hall-context-conserve` skill.

### Dual-platform parity
Committed the standing **parity mandate** to `AGENTS.md`: every plan/work covers both platform variations (Claude + Codex) AND both orchestration layers (OMC ↔ OMX); model-routing artifacts get a Claude table AND a Codex table. Codex `anti-hall-model-policy` skill updated with the Claude-side mapping.

## 0.41.1

**CI fix for Codex installer tests.**

- Fixed the new Codex installer regression test to accept both POSIX and Windows path separators when checking generated hook commands. No runtime behavior change.

## 0.41.0

**Codex/OMX port without disturbing the Claude plugin surface.**

### New: Codex-native plugin layer
- Added `plugins/anti-hall/.codex-plugin/plugin.json` and `plugins/anti-hall/codex/install-codex.js`. The installer writes Codex `.codex/hooks.json` plus `[features].hooks = true` for the supported Codex hook subset.
- Added plugin-scoped Codex hooks at `plugins/anti-hall/codex/hooks/hooks.json` using `${PLUGIN_ROOT}` commands, matching installed Codex plugin examples.
- Added Codex repo marketplace compatibility via `.agents/plugins/marketplace.json`, pointing at `./plugins/anti-hall` with the official local marketplace shape.
- Added project/global install and dry-run modes for Codex activation. The installer preserves unrelated hook groups and replaces stale anti-hall hook groups.
- Added regression coverage in `tests/codex/install-codex.test.js` for dry-run behavior, hook/config writing, and merge behavior.

### New: Codex skills and OMX workflow mapping
- Added Codex-native skills for activate, doctor, update, root-cause, orchestration, deadly-loop, ship-it, model policy, context-conserve, feature-launch, OMX integration, OMC integration, statusline install, flutter-debug, simplify, and debt.
- `anti-hall-context-conserve` ports the limit/context conservation behavior to Codex model routing and output hygiene.
- `anti-hall-feature-launch` replaces the removed GSD path with a Codex/OMX planning protocol, graphify-first setup, `gpt-5.5` debate gates, phased execution, and launch verification.

### New: Codex KB equivalents
- Added `docs/CODEX-KB-MIGRATION-MAP.md` to classify existing KBs into Claude-specific, Codex/agnostic, and historical buckets.
- Added source-audited Codex KBs: `docs/KB-codex-platform-hooks-plugins.md`, `docs/KB-codex-workflow-orchestration.md`, and `docs/KB-omx.md`. Each has at least 10 sources and at least 2 official OpenAI sources.
- Updated `docs/KB.md` and `llms.txt` to include the Codex KBs.

### Codex parity boundary
Current official Codex docs expose more hook events than the first migration note used for the initial port, including edit and subagent lifecycle hook names. This release intentionally registers only the Codex hook subset whose anti-hall payload contracts are currently adapted/tested: SessionStart, UserPromptSubmit, Bash PreToolUse, and Stop. Edit-time guards (`api-guard`, `ship-it-guard`) and lifecycle/compaction hooks are tracked as documented-but-not-yet-adapted Codex parity work until Codex payload adapters and tests prove them. Claude Workflow JS remains non-portable; use Codex skills/native subagents/OMX/scripts instead.

Codex/OMX statusline parity is explicitly bounded: Claude Code supports a command-backed `statusLine`, so anti-hall can append the `AH: Vx.y.z` chip there. Codex `[tui].status_line` is documented as built-in footer item IDs only, so the Codex port documents the limitation rather than injecting an unsupported custom item.

### Claude compatibility
The Claude manifest remains present and versioned, and the Claude hook/skill files remain in their existing locations. The Codex port lives in separate `codex/` and `.codex-plugin/` paths.

## 0.40.0

**Ponytail-derived heavier features: two new skills (`simplify`, `debt`) + a zero-API eval rescorer.**

### New skill: `/anti-hall:simplify` — measured, behavior-preserving simplification
A harvest-then-prove pass over recently-changed (or named) code. Each finding gets exactly one tag — `delete:` (dead code), `stdlib:` (reinvented stdlib), `native:` (reimplemented builtin), `yagni:` (premature generality), `shrink:` (verbose equivalent), `slop:` (AI-slop filler) — the safe set is applied, the SAME tests are re-run, and the result is scored as a single `net: -N lines`. Crucially the score is the **measured** post-apply diff delta (`git diff --shortstat`), never a projected "you'll save ~X" estimate — that's the exact unverifiable saved-X claim verify-first rule 10 forbids. Behavior-preserving by contract: anything that removes a capability is declined as a scope change, not applied.

### New skill: `/anti-hall:debt` — a register for *deliberate*, budgeted debt
Introduces the `// anti-hall: <ceiling>,<when>` marker — a budgeted, harvestable alternative to vague TODOs. `<ceiling>` is the limit you consciously accepted (e.g. `30 lines`, `O(n^2)`); `<when>` is the concrete payback trigger (e.g. `when >3 callers`). New `plugins/anti-hall/scripts/harvest-debt.js` (pure Node, comment-syntax-agnostic across `//` `#` `--` `/* */` `<!-- -->`) greps the tree, parses each marker, and flags **rot-risk** (`no-trigger`) when a marker has no `<when>` *or* sits in code git-untouched past a staleness threshold (default 90 days; fail-open when git is absent). Explicitly **not** a license to skip real work — lazy TODO/stub patterns remain blockers; the marker is the narrow, defensible exception.

### New: `eval/rescore.js` — recompute eval stats with zero API calls
Recomputes the summary block (protocol/baseline fabrication rates, delta, per-task differences) straight from saved `records[].fabricated` — no answer calls *and* no judge calls (distinct from `grade.js`, which re-calls the judge). Aggregates across multiple result files. `--selftest` is an integrity gate: it re-derives each file's summary from its own records and fails (exit 1) on any schema violation or count/rate mismatch, catching hand-edited or corrupted result files. 21 new tests (`tests/eval/rescore.test.js`, `tests/hooks/harvest-debt.test.js`); suite 646 (644 pass / 2 skip).

## 0.39.0

**Subagents now receive the verify-first Iron Law (new SubagentStart hook) + guard/hardening refinements.**

### New: SubagentStart re-injection — discipline finally reaches subagents
`verify-first-full.js` was SessionStart-only, so every Task-spawned subagent ran verify-first-UNAWARE. New `verify-first-subagent.js` (SubagentStart hook) injects the Iron Law + rationalization table + positive rules + scope-fidelity into each spawned subagent — but DELIBERATELY omits the orchestration "delegate everything" block (subagents are workers; re-injecting it would recreate deep nesting). The shared core is extracted to `verify-first-core.js` (one source of truth for both hooks, no drift). 9 tests. (SubagentStart confirmed as a real Claude Code event via docs/KB-claude-codex.md §1.1.)

### model-routing-guard: research→Explore nudge no longer false-positives on write tasks
The 0.37.0 anti-nesting advisory nudged any research-shaped `general-purpose` spawn toward Explore — but Explore can't write, so release/commit/build agents were wrongly nudged. Now suppressed when the spawn has write/execute signals.

### Hardening (ponytail-derived)
- `install-statusline.js`: `isShellSafe()` allowlist guards paths before embedding them in a settings.json command (unsafe → manual-setup fallback).
- verify-first rule 10: never display a per-run "you saved X tokens/lines" number — the unbuilt baseline was never run; cite a benchmark median with provenance, or say it's unmeasured.

## 0.38.2

**Fix: `agentsRunning()` was inert — the parallel-orchestration guard exemptions never fired.**

`agentsRunning()` (consumed by task-guard, tasklist-guard, task-tracker) reads `~/.anti-hall/agents/*.json` heartbeats, but NOTHING wrote them, so it always returned false — the 0.36.1 multiple-in_progress exemption and the idle-neglect "no agents running" signal were no-ops, and the Stop guards nagged even while background agents were actively working. Fix:
- `phase-tracker.js` now writes a rolling heartbeat `~/.anti-hall/agents/recent-spawn.json` (`{ts}`) on every Agent/Task spawn (fail-open; the existing `agent-spawns.log` write is unchanged). `agentsRunning()` returns true for ~20 min after the most recent spawn = active orchestration, so the agent-aware exemptions ACTUALLY fire now. (A single agent running >20 min with no new spawn is a known limitation — a per-subagent refresh is a future enhancement.)
- `task-guard.js`: the generic "open tasks remain at Stop" block now suppresses when agents are live (it was firing on in_progress/owned tasks regardless of agent state). Genuinely-neglected work (open tasks + no live agent) still blocks.
- +6 tests.

## 0.38.1

Test + docs maintenance: de-coupled the statusline minor/major-ahead test fixtures from the hardcoded version (now derived from plugin.json so they never go stale on a bump); refreshed stale test-count references in README/llms.txt/KB.md.

## 0.38.0

**Limit-conservation mode + consolidated statusline merge + OMC as recommended optional dependency.**

### New: `limit-conserve-inject` hook (UserPromptSubmit) + `limit-conserve.js` helper

`limit-conserve-inject.js` — a UserPromptSubmit hook that injects a token-conservation nudge when the session context usage is at or above a threshold. Env knobs:

- `ANTIHALL_LIMIT_CONSERVE` — `auto` (default), `on`, or `off`. In `auto` mode the hook reads the OMC usage cache (`~/.anti-hall/omc-usage-cache.json`) to detect the current context percentage; `on` forces the nudge unconditionally; `off` disables it.
- `ANTIHALL_LIMIT_THRESHOLD` — integer percentage (default `85`). The nudge fires only when detected context usage ≥ this value.

Auto mode requires an OMC installation that populates the usage cache; without it the hook operates in manual mode (`on`/`off` only) and auto silently behaves as off. Skip-guard hatch: `limit-conserve`. UserPromptSubmit hooks 2 → 3.

`limit-conserve.js` is the shared helper consumed by the hook (reads the OMC usage cache, applies threshold logic). It is not itself a hook.

### Statusline: consolidated merge mode (`--consolidate`)

`install-statusline --consolidate` merges the anti-hall statusline with an existing statusline (e.g., the OMC HUD) instead of replacing it. The existing base `statusLine` value is read from `ANTIHALL_STATUSLINE_BASE` (env) or detected from the current settings; the anti-hall bar is appended as an additional component. The resolved base is persisted to `~/.anti-hall/consolidated-base.json` so subsequent sessions can restore it without re-reading the env var.

New env knob: `ANTIHALL_STATUSLINE_BASE` — explicitly sets the base statusline expression when using consolidated mode.

### OMC: recommended optional dependency

oh-my-claudecode (OMC) is now explicitly documented as a **recommended optional** dependency. Anti-hall is and remains fully standalone without it. Two features unlock automatic behavior when OMC is installed:

1. `limit-conserve` auto mode — reads the OMC usage cache to detect the live context percentage.
2. Consolidated statusline mode — the version chip and base-merge work with the OMC HUD out of the box.

Without OMC, both features fall back to manual/off behavior; no errors, no breaking change.

### Temporary: Fable removed from all spawn sites

- Temporary: Fable removed from all spawn sites (Anthropic disabled it) — Reviewer/flagship-Claude seats in `deadly-loop` and `ship-it` run on Opus until re-enabled. All changed spawn sites are marked `TEMP(fable-disabled 2026-06-29)` for easy grep-revert when Fable is restored.

## 0.37.0

**Version awareness + priority-aware guards + anti-nesting backstop + cmux/OMC KBs.**

### New: SessionStart `version-alert` hook
`version-alert.js` (+ detached `version-alert-refresh.js`): a NON-BLOCKING SessionStart check that alerts when a newer anti-hall version is available. Reads the running version vs a cached latest (`~/.anti-hall/version-check.json`); if behind, emits a one-line "vX available — /anti-hall:update". When the cache is absent/stale it spawns a DETACHED, unref'd `git ls-remote --tags` refresh and stays silent that session — SessionStart never blocks or does synchronous network. Off-switch `ANTIHALL_VERSION_ALERT=off`; skip-guard hatch. SessionStart hooks 2 -> 3. 8 tests.

### Statusline: version chip with update indicator
The statusline shows `AH: Vx.y.z` between the cost chip and the email segment. When the version-check cache shows a newer release: `★ AH: …` in YELLOW for a new MINOR, RED for a new MAJOR; plain dim otherwise (fail-open if no cache).

### Priority-aware Stop guards (less nag noise)
`task-guard` (idle-neglect) and `tasklist-guard` (multi-in_progress) now read each task's `metadata.priority` and only chase ACTIONABLE P0/P1 work — a backlog of P2/deferred tasks no longer triggers a nudge, and P2 in_progress doesn't count toward the stale-multi check. Missing/garbage priority is treated as actionable (P1) so a real high-priority task is never under-nagged. Encodes "priority = check the top first/more often, never neglect the rest, don't nag about backlog."

### Anti-nesting backstop in `model-routing-guard`
A new advisory fires when research/read-only-shaped work is spawned as `general-purpose` (carries the Agent tool, can recurse) — nudging to use the `Explore` agent type (has WebSearch/WebFetch but NO Agent tool, so it structurally cannot nest). Advisory only; the structural complement to rule M's anti-deep-nesting discipline.

### New KBs
`docs/KB-cmux.md` (cmux terminal multiplexer) + `docs/KB-omc.md` (oh-my-claudecode + the cmux+OMC+Claude stack). Both agnostic; registered in llms.txt + docs/KB.md.

## 0.36.1

**Fix: `tasklist-guard` multiple-in_progress false-positive was crippling parallel orchestration.**

The Stop-hook `hasStaleInProgress` sub-cause fired on ANY 2+ in_progress tasks and told the
agent to "keep one task in_progress at a time" — i.e. to **serialize**, the exact opposite of
the parallel fan-out anti-hall itself promotes. With background agents legitimately working N
tasks at once, it nagged on every Stop and pushed agents to collapse their parallel work. Fix:

- **Exempt the multi-in_progress block when a live background-agent heartbeat exists** — reuse
  `agentsRunning()` (`~/.anti-hall/agents/*.json` fresh within 20 min). Multiple in_progress is
  CORRECT while agents are live; only genuinely STALLED in_progress (no live agent) now flags.
- **Rewrite the message** from "keep one in_progress at a time" (serialize) to "dispatch a
  background agent for EACH so they run in PARALLEL, or set idle ones back to pending; priority
  = check it first and more often, never pause the rest."
- Fail-open: an `agentsRunning()` error reads as not-running (can only permit a nudge, never
  wrongly silence a real stall). +2 tests.

## 0.36.0

**Codex everyday-routing + Workflow model-distribution discipline + new `codex-nudge` advisory hook.**

### New hook: `codex-nudge` (Stop, advisory)
A loop-safe, fail-open Stop hook that nudges ONCE per session to get an independent OpenAI-Codex second opinion when the session shipped a substantial code change (>= `ANTIHALL_CODEX_NUDGE_MIN`, default 3 code-file edits) with no Codex review (no `codex:codex-rescue` spawn / codex skill). Mechanizes the everyday-routing policy for the MAIN agent (the deadly-loop/ship-it Critic seat already covers those skills). Codex is the cross-model correctness reviewer (off-by-one, races, subtle bugs); Opus keeps architecture/design review. Deduped on the edited-file signature, hard cap 2 nudges/session. Off-switch `ANTIHALL_CODEX_NUDGE=off`; skip-guard hatch `codex-nudge`. 10 tests + doctor smoke test. Stop hooks: 5 -> 6.

### Everyday-routing + Workflow model-distribution discipline
`verify-first-full.js` gains orchestration rules M (shallow+wide; a subagent is a worker that does not re-delegate; lift 3+ nested/parallel spawns into a deterministic Workflow; Explore for read-only) and N (distribute models per seat — implementation->sonnet, correctness/verify review->Codex, planning/architecture->opus; NEVER an all-Opus fan-out; the model-routing guard does NOT police models inside a workflow review fan-out, so it is an authoring responsibility), a `model-routing` ALWAYS-APPLY bullet, and two per-turn nudges. Reconciled against a 13-source Codex-vs-Opus coding KB (`docs/KB-codex-vs-opus-coding.md`) + the Workflow KB (`docs/KB-claude-workflow-orchestration.md`).

### Fix: ship-it build seats set an explicit model
`ship-it.workflow.js` implementation seats omitted `model` — under strict model-routing (default since 0.35.0) a mechanical omitted-model spawn is BLOCKED, so the build could self-block, and an omitted model inherits the flagship orchestrator. Build seats now set `model: phase.model || 'sonnet'` (implementation -> Sonnet per the KB; override per phase).

### MODEL-POLICY: everyday routing section
`skills/MODEL-POLICY.md` (+ the deadly-loop copy) gains an "Everyday agent routing" section: Codex = second-opinion/correctness review (always) + bounded code-apply/terminal/migration; Opus = planning/architecture/design + design-level review; Sonnet = implementation; Haiku = trivial/nav. The TRIO debate roster is unchanged.

## 0.35.1

**ship-it Workflow Fable→Opus availability fallback (bug fix) + Workflow orchestration KB.**

- **Fixed: the ship-it deadly-loop gate broke when Fable was unavailable.** The Reviewer
  seat in `skills/ship-it/references/ship-it.workflow.js` hardcoded `model: 'fable'` with
  no guard, so when the `fable` tier token is disabled at the account level the Reviewer
  spawn died and the whole per-phase gate could not complete. `MODEL-POLICY.md` *documented*
  a fable✗→Opus fallback matrix, but it was never wired into the workflow script (only the
  Codex seat had a runtime probe). Added `reviewerAgent(p)`: it attempts the latest flagship
  and, on a terminal `null` return (the Workflow contract's unavailable-model signal), falls
  back to an Opus Reviewer — or short-circuits straight to Opus when the coordinator passes
  `args.fableAvailable === false` (no wasted spawn). Floor stays Opus; never a cheaper model.
  Validated: 3 branches (Fable healthy / Fable null / coordinator-off), 8/8 assertions green
  against the real shipped function. `ship-it/SKILL.md` snippet updated to show the wrapper.
- **New: `docs/KB-claude-workflow-orchestration.md`** — a 14-source (8 official Anthropic)
  knowledge base on programmatic multi-agent orchestration (the `Workflow` tool): what it is
  vs ad-hoc subagent spawns, when to use it vs a single/shallow agent, the core patterns
  (orchestrator-worker, pipeline/parallel, map-reduce, loop-until-done, adversarial verify),
  the ~15× token / 90.2% / depth-nesting cost numbers, and a "how to make an agent utilize it
  more" section. Reconciled against in-repo live verification (Workflow runs under Opus 4.8 —
  it is **not** Fable-bound). Registered in `llms.txt` and the `docs/KB.md` doc table.

## 0.35.0

**Strict-by-default model routing + `anti-hall:activate` first-run setup skill.**

### model-routing-guard: strict is now the default

`model-routing-guard.js` row-2 behavior flipped: **strict mode is the default** as of
v0.35.0. Previously strict was opt-in (`ANTIHALL_MODEL_ROUTING=strict`); now advisory
is the opt-out (`ANTIHALL_MODEL_ROUTING=advisory`).

- **Before (≤ 0.34.1):** omitted-model mechanical spawns → advisory by default; set
  `ANTIHALL_MODEL_ROUTING=strict` to block.
- **After (≥ 0.35.0):** omitted-model mechanical spawns → **blocked unconditionally**
  by default; set `ANTIHALL_MODEL_ROUTING=advisory` to revert to advisory-only.

Rationale: an omitted model silently inherits the orchestrator's model. On a flagship
orchestrator this produces an all-flagship swarm with no warning and no signal — the
most common and most expensive misroute. Strict is the right default; advisory opt-out
covers projects where the orchestrator is verifiably cheap-modeled.

The row-1 behavior (explicit flagship + mechanical task → block, debate-role exemption
downgrades to advisory) is unchanged. The row-2 strict block message now says "default"
and names `ANTIHALL_MODEL_ROUTING=advisory` as the remedy. All existing tests updated.

### New skill: `anti-hall:activate`

`skills/activate/SKILL.md` — one-shot, idempotent first-run setup. User-invoked only;
**never** auto-runs as a SessionStart side-effect (the always-on hooks need no
activation). What it does:

- Checks `~/.claude/settings.json` for an existing `statusLine`. If none → installs
  the anti-hall statusline at user scope (delegates to `install-statusline.js --user`).
  If one exists (conflict) → reports it and lets the user choose: wrap as line 1
  (global), install at project scope, or skip.
- Reports model-routing state: strict (default, unset) or advisory (opt-out set).
  No action taken — informational only.
- Writes `~/.anti-hall/activated.json` sentinel so re-runs report "already activated"
  and exit 0 immediately (idempotent).
- Prints a "restart Claude Code" note only when the statusline was actually changed.

Reuses `install-statusline.js` — no reimplemented logic.

### What stays opt-in (unchanged)

`mcp-reaper`, `ANTIHALL_API_GUARD_THIRDPARTY`, `ANTIHALL_SHIPIT_GATE`,
`ANTIHALL_MERGE_GATE`, `ANTIHALL_SEMANTIC_JUDGE` — all remain off by default; activate
does not touch them. On-demand skills (deadly-loop, ship-it, etc.) unchanged.

Skills shipped: 9 → 10.

## 0.34.1

**Honest-fix wave on the shipped `flutter-debug` agent/skill** (retroactive hardening of v0.34.0).

- **FP1b resolution (NEGATIVE verdict, now stated honestly).** The step-0 probe captured `flutter_driver_command` tap/screenshot FAILING against a plain debug app — they REQUIRE an in-app `enableFlutterDriverExtension()` before `runApp` (same invasiveness class as marionette, which is strictly richer — the only semantic input/screenshot route). The shipped degradation row, SKILL.md honest-scope, and the agent's honesty discipline now say so; the previous "tap + screenshot with NO app package" claim is removed. The `widget_inspector` tree-inspection-without-extension nuance is retained.
- **Private-identifier scrub + lint extension.** Owner-private identifiers (the owner's Flutter app name, a configured AVD name) were scrubbed from the public probe record, the plan doc, and this CHANGELOG. The repo-agnostic lint test is extended to a denylist constant (no `/Users/` home paths, no private app/device names) and now covers the probe record, the plan doc, and the CHANGELOG 0.34.x sections — future names add one denylist entry.
- **doctor-conditionality + Windows-path test hardening.** A subprocess test asserts the doctor's `flutter-debug` section is silent without a `pubspec.yaml` and present with one; a platform-monkeypatched test asserts BOTH `claude` CLI candidates failing on Windows ⇒ `cli-unavailable` (a manual-verify WARN), never a false FAIL.
- **Auto-apply pre-write safety checks.** SKILL.md app-integration now skips when `MarionetteBinding` is already present, locates the entrypoint via `lib/main.dart`, and WARN-AND-STOPs (never guess-edits) on non-standard layouts or multiple `runApp()` call sites. The applied-diff visibility stays.
- **marionette PATH-resolution warning.** After a successful `dart pub global activate marionette_mcp`, preflight now verifies the wrapper actually resolves (`$PUB_CACHE/bin` ~ `~/.pub-cache/bin` or `$PATH`); if not, it WARNs with the exact manual `export PATH` fix line (fail-open).

- **Android support VERIFIED via live FP7 (marionette taps/screenshots on emulator).** The
  live FP7 probe (2026-06-11) confirmed all 15 `ext.flutter.marionette.*` extensions
  registered on android_arm64; semantic tap drove a counter 0→1; screenshots returned valid
  PNG. Scope: one AVD / android_arm64 arch — physical device and other architectures not yet
  probed. All shipped Android-pending text updated to reflect the verified status with honest
  scope boundaries.
- **Full E2E debug loop validated live (plant→reproduce→read→fix→hot-reload→verify).** A
  `StateError` was planted in the scratch app, reproduced via marionette tap,
  `get_runtime_errors` captured "Bad state: planted bug", the fix was applied, `hot_reload`
  succeeded, 3 taps past the old throw point produced zero new errors, and the screenshot was
  verified. Closes the loop on every agent-loop step being exercised against a real AVD.
- **`get_runtime_errors` timestamp guidance added.** The tool accumulates errors since DTD
  connection — it does NOT reset on `hot_reload`. The agent's mandatory re-verify step now
  requires comparing each error's timestamp against the `hot_reload` time; only post-reload
  errors count as new failures. Added to the agent loop (step 7) and SKILL.md MCP-usage notes.

**Transparency (house rules):** v0.34.0 was tagged against a RED CI run; the corrective fix landed in commit `31a7451`. This 0.34.1 wave addresses the substance flagged in the retroactive review.

## 0.34.0

**New agent + skill: `/anti-hall:flutter-debug`** — drive a Flutter app in debug mode, close the fix loop via agent-controlled hot reload + visually verified UI changes.

### Workstream A — Agent + Skill architecture

**`agents/flutter-debug.md`** — anti-hall's first shipped agent. Self-contained executor persona carries the full debug-loop protocol (reproduce → read error → root-cause → fix → hot reload → **visually re-verify**), so direct spawns work without the skill. Frontmatter: `{name: flutter-debug, description: <>, model: sonnet}` (sonnet is the code-authoring floor — never haiku). **No `tools` allowlist** — MCP tool names vary by alias; a wrong allowlist bricks the agent (FP5 validates MCP reachability).

**`skills/flutter-debug/SKILL.md`** — user-facing workflow: setup orchestration, zero-setup MCP registration (scope-aware atomic `claude mcp add` per FP9/FP10), app-side marionette integration, capability tier degradation table, and escalation-report trigger. Loop protocol lives ONCE in the agent; the skill delegates to it (non-blocking coordinator).

### Workstream B — MCP strategy: zero-setup via scope-aware `claude mcp add`

**NO bundled `.mcp.json` for external servers** (owner directive; duplicated processes when user already has dart/marionette registered). Each of dart + marionette is registered idempotently via FP9 flow: `claude mcp get <name>` → absent everywhere ⇒ `claude mcp add --scope <chosen>` (scope question asked once in main context; non-interactive = default local) → present in ANY scope ⇒ SKIP (user entries win by precedence).

**Composition:** official Dart MCP (reload/reload/get_runtime_errors/widget_inspector/vm_service/analyze_files) **REQUIRED** [2]; marionette_mcp ≥ 0.4.0 (semantic tap/enter_text/scroll_to + screenshots + logs) **PRIMARY** [5]; joshuayoes/ios-simulator-mcp (coordinate taps + screenshots, fallback, Flutter reliability UNVERIFIED [10]). Auto-apply: marionette `pubspec.yaml` dependency + upstream-verbatim kDebugMode init (FP6 verified; app-side, invisible to release builds).

### Workstream C — Preflight + doctor integration

**`scripts/preflight.js`** — pure Node ≥ 18, cross-platform, fail-open. **ONE implementation, TWO entry points:** exports its checks; `doctor.js` require()s and CALLS them in-process (not subprocess — matches the G test contract). Runs ONLY on Flutter projects (pubspec.yaml or flutter-debug in use). **Checks:** (1) `dart --version` ≥ 3.12 FULL / 3.9–3.11 WARN / <3.9 FAIL [1][3]; (2) FP9 idempotent MCP registration; (3) marionette host on PATH ≥ 0.4.0, auto-fix via `dart pub global activate marionette_mcp`; (4) iOS booted simulator + idb reachable [9][10]; (5) **Android SDK explicit-path resolution** (BINDING LESSON — bare-PATH probe once falsely reported "no tooling" on a machine with SDK 36 + AVD; now explicit env/path checks + `flutter doctor` cross-check [FP7]); (6) project sanity (pubspec.yaml present). Degradation table per missing capability. Honest on Android visual status (taps/screenshots PENDING FP7, now ACTIVE).

**doctor.js § 6b:** conditional flutter-debug section (silent in non-Flutter cwd). Calls preflight exports in-process (skipRegistration:true = read-only mode). Scope context inherited from the user's current work. Fail-open on any probe error.

### Workstream D — The debug loop (agent body; mirrors KB §5 + root-cause discipline)

Agent executes: (0) preflight + announce tier; (1) run + DTD connect; (2) reproduce (marionette/coordinate/fallback semantic/coordinate/coordinate taps); **screenshot BEFORE** [5][10]; (3) read error routed by kind (exceptions → get_runtime_errors; layout → widget_inspector; prints → marionette get_logs / get_app_logs **double-gated: launch_app-enabled path only** [2]); (4) **NO CAUSE NO FIX** — root-cause with evidence (error + widget tree + code); (5) edit + verify with analyze_files [2]; (6) reload (hot_reload state-preserved, hot_restart for const/init/reset [2]); (7) **MANDATORY re-verify:** re-run get_runtime_errors until clean (matches official demo [1]); on visual tier, BEFORE/AFTER screenshot compare (visual MCP required for "verified", else "error-clear but visually unverified"); (8) **escalation trigger:** after 2 full iterations without proven root cause OR fix needs redesign → report `escalate: opus` with collected evidence (agent never respawns itself); (9) loop until clean. Report = tier + per-fix evidence (errors, screenshots).

### Workstream E — Step-0 probes (tests/fixtures/step0-probe-record-v0.34.0.md)

- **FP1 DONE:** `flutter_driver_command` exposes tap + screenshot + semantic finders (ByValueKey/ByText/BySemanticsLabel…) IN-SCHEMA [2]; schema forbids guessing (widget_inspector first).
- **FP1b RESIDUAL:** runtime vs plain debug app (no enableFlutterDriverExtension()). Gates no-package degradation. No shipped promise pre-FP1b.
- **FP2 UNVERIFIED:** Flutter widgets in iOS a11y trees [10][9]. Grades SUPPLEMENT tier only.
- **FP3 EXCLUDED:** mcp_flutter untested-merge warning [6]. Revisit gate = stable tag (tracked in KB staleness ledger).
- **FP4 CONFIRMED:** lifecycle tools ABSENT from default list (disabled by default [2]). Manual `flutter run --print-dtd` stays the path. get_app_logs correction = double-gate logic.
- **FP5 GENERIC PASS:** subagent spawns surface mcp__ tools via ToolSearch and invoke live. Architecture viable; skill-only fallback retained as contingency (executable spec: SKILL.md → CI test omitted, AC1/AC3 branches, CHANGELOG note).
- **FP6 DONE MATCH:** regular dep, upstream-verbatim kDebugMode if/else (quoted in B). Release-safe per upstream (LogCollector optional, non-fatal).
- **FP7 UN-DEFERRED ACTIVE:** bare-PATH false-negative corrected (SDK 36 at ~/Library/Android/sdk; a configured AVD; adb + emulator functional). Probe = boot AVD → marionette → tap/screenshot. Upstream silent on Android ⇒ no promise pre-FP7. Binding baked into preflight check 5.
- **FP9 CAPTURED:** `claude mcp add` scope/precedence/atomicity semantics (full consequences in B registration flow; B2 shims dropped).
- **FP10 CAPTURED:** ecosystem precedent (OMC bundles only its own server; ecc bundles 6 externals REJECTED for duplicate-server hazard). Directs decision to FP9 registration flow.

### Workstream F — Model routing + escalation

Agent default **`model: sonnet`** (code-authoring floor). Escalation split: TRIGGER in agent body (D step 8, `escalate: opus`); RESPAWN via caller. SKILL.md instructs coordinator to respawn at `model: opus` on signal. Tier tokens only (v0.32.0 policy).

### Workstream G — Tests

**41 new tests** (≥19 required): agent frontmatter parse (1); SKILL.md lint (1); preflight dart full/warn/fail (3), degradation rows (7), malformed-output fail-open (2), Windows `.cmd` best-effort (1); FP9 registration flow (≥4): get-absent → add, get-present → SKIP, get-unparsable → no add, add hard-error surfaced; Android SDK-path units (2); doctor shared-checks (1); repo-agnostic lint (1). All 535 tests pass (2 skip unrelated).

### Workstream H — Documentation

**`docs/KB-flutter-claude-debug.md`** — 13 sources synthesized (KB + probe evidence cited via `[n]` = KB numbering + FP-ids). Drives every capability claim in the agent/skill/preflight (honesty contract: every promise traces to KB or probe).

**`docs/2026-06-10-v0.34.0-flutter-debug-plan.md`** — development log (rounds 1–3 converged GO×3, v5 baseline + 2026-06-11 amendments for FP9/FP10 MCP strategy + FP7 Android binding). For future context.

**`tests/fixtures/step0-probe-record-v0.34.0.md`** — raw probe captures (FP1–FP10 with dates + tooling inventory). Supports KB staleness tracking.

**README / llms.txt:** new agent listed; 8 skills → 9 skills (including flutter-debug); test count 461 → 535; total checks 49; doctor integration noted.

Skills shipped: 8 → 9.

## 0.33.0

**New skill: `/anti-hall:update`** — in-session self-update with cache sync and changelog delta.

`scripts/update.js` (pure Node ≥ 18, cross-platform including Windows) implements the
full update lifecycle: resolves the installed version from `installed_plugins.json` (v2
schema, harness-owned — read-only), `git pull --ff-only` the marketplace clone (fail-closed on
dirty tree or non-fast-forward divergence — hard STOP with a clear message, no merge/rebase/force),
mirrors the new version into the version-pinned cache so `/reload-plugins` can resolve it
(semver-anchored, traversal-proof path join — no writes outside the clone dir + cache),
extracts the CHANGELOG delta between installed and latest, and emits a JSON status +
human summary. `--check` mode: `git fetch` + local-vs-remote version compare, no pull,
no writes. Unknown failures are fail-closed (exit 1 with message) per a conservative
posture; offline/no-git is reported and exits 0.

Hardened by a 2-round deadly-swarm: a path-traversal P1 (unsanitized cache path join) and a
live E2E registry-shape bug (v2 `installed_plugins.json` parsing) were caught and fixed before
ship. 47 dedicated tests cover both modes, all STOP / fail-open / offline / already-up-to-date
branches, traversal-proof cache sync, changelog extraction, and JSON status output.

On a successful update the skill instructs the user to run `/reload-plugins` to load the new
version in-session (hooks and statusline pick up changes from disk automatically; `/reload-plugins`
refreshes the skill list and version label). Rarely, a harness build may require a restart instead —
the skill says so when relevant and does not over-promise.

Skills shipped: 7 → 8.

## 0.32.1

Docs: refresh test counts (459 pass / 461 total) across README (root+plugin), llms.txt, KB.md; index KB-fable-5.md and the v0.32.0 design plan in llms.txt + KB.md. No behavioral changes.

## 0.32.0

**Fable 5 awareness, model-routing guard, OMC-deference, TRIO debate roster, 3-phase deadly-swarm workflow, statusline segment-matching + latent-bug fix, `ANTIHALL_JUDGE_MODEL`.**

### model-routing-guard (new hook)

`model-routing-guard.js` — PreToolUse Agent/Task, always-on anti-waste net. Classifies
spawn descriptions by keyword signals (mechanical vs complex) and nudges toward the
cheapest model that fits the task shape:

- **Default (advisory):** emits a `hookSpecificOutput.additionalContext` advisory when
  an explicit flagship model (`opus`/`fable`) is paired with a purely mechanical task
  (fetch, grep, build, deploy, run tests, etc.), or when `model` is omitted on a
  mechanical spawn (omitted model inherits the orchestrator's — on a flagship
  orchestrator that silently produces an all-flagship swarm).
- **Strict mode** (`ANTIHALL_MODEL_ROUTING=strict`): upgrades omitted-model mechanical
  spawns to an unconditional block (exit 2). Opt-in and **project-scoped** — enable via
  the PROJECT's `.claude/settings.json` env block, NOT a global shell profile. A
  globally-exported strict blocks omitted-model mechanical spawns in EVERY project,
  including genuinely-cheap-orchestrator ones. Remedy: set an explicit cheap model on the
  spawn, or unset strict.
- **Debate-role exemption:** row-1 blocks (explicit flagship + mechanical) are downgraded
  to advisory when a role-word (`reviewer`/`auditor`/`critic`/`debate`/`deadly-loop`)
  appears in the spawn `description` — TRIO debate seats legitimately need flagship
  models. The exemption does NOT apply to strict row-2 (role words must not defeat the
  user's explicit strict opt-in).
- Fail-open on any error; never blocks unknown model tokens (forward-compat).
- Hooks shipped: 21 → 23 (+`model-routing-guard.js`, +`omc-detect.js`).

### omc-detect (new shared helper)

`omc-detect.js` — shared pure-Node helper (not a hook) exported as
`isOmcLoopActive({ cwd, sessionId })`. Returns `true` when an oh-my-claudecode
autonomous loop (ralph, ultrawork, autopilot, ultraqa, team, ultrapilot, pipeline,
omc-teams) is currently active AND fresh (any of `last_checked_at`/`updated_at`/`started_at`
within 2 h, per OMC's own staleness rule) AND session-affinity-matched. Consumed by
`task-guard` and `tasklist-guard` to suppress Stop-blocks to an advisory when an OMC
loop is running — preventing the deadlock where the guard stops the loop it was meant to
coexist with. Fail-open direction = NOT deferring (false): missing/malformed state = not
active. Kill-switches: `DISABLE_OMC=1` or `OMC_SKIP_HOOKS` including `persistent-mode`.
Version fragility documented in-file (state filenames stable since OMC 4.14.6).

### TRIO debate roster (Workstream C)

`MODEL-POLICY.md` (both copies) rewritten to a **three-agent TRIO**:

| Role | Model | Thinking | Persona |
|---|---|---|---|
| **Reviewer** | latest flagship Claude (`model:"fable"`) | adaptive, effort `xhigh` (→ `high`) | correctness / architecture auditor |
| **Auditor** | latest Claude Opus (`model:"opus"`) | `xhigh` | divergent: regression & coupling hunter |
| **Critic** | latest OpenAI Codex | max reasoning (`xhigh` → `high`) | adversarial failure-mode hunter |

Floor for every seat = Opus. Availability fallback matrix covers all four availability
combinations. Round governance: DEGRADED round (seat dead after retry) may iterate but
cannot grant final GO. Dissent adjudication: single-seat re-run for evidence only (no
code change); any fix wave → full TRIO next round.

**Latest-model policy (owner directive):** all spawn paths use harness tier tokens only
(`fable`/`opus`/`sonnet`/`haiku`; Codex = latest the installed CLI reports) — resolved
latest-at-call-time. NO versioned IDs in executable snippets. API call sites are the
sole exception (no evergreen tier alias; `claude-haiku-4-5` is the alias-form for its
tier).

### deadly-loop skill + workflow (Workstream E / E.1)

`skills/deadly-loop/SKILL.md` updated:
- Phase B header + B0-B2 skeletons now describe the full TRIO (Reviewer + Auditor + Critic).
- New **Swarm mode** section documents `references/deadly-loop.workflow.js` as the
  swarm-first path (plain Agent-tool path stays fully supported for no-consent sessions).
- **Three-phase architecture per round:** (1) CONTEXT AGENT (`model:"sonnet"`, shared
  pack, graphify freshness check round-1 only); (2) THE DUEL (2a independent
  investigation + 2b structured argument); (3) CONVERGE & CONFIRM (VERDICT_SCHEMA dedup,
  RESPAWN-ON-DRIFT with objective criteria only).
- Workflow consent friction, guard-coverage boundary, no cross-round caching — all stated
  honestly.

`references/deadly-loop.workflow.js` — new Workflow template (args contract): accepts
`{round, multiplier, targetSHA, branch, scope, handoffPath, prevPackPath, findings,
fixesApplied, contextMode, argue, respawnQuota, seats, codexAvailable}`. MODEL INVARIANT
in file header: tier tokens only, never versioned IDs. DETERMINISM: no `Date.now()` /
`Math.random()` / argless `new Date()`.

### statusline (Workstream A2)

`statusline-rich.js` `getModelName()`: token-segment matching (split model id on `-`,
compare segments) for fable/opus/sonnet/haiku, fable-first. Fixes `confable`-class
false-positive collisions. Latent bug fixed: the `:361-366` "pick max lastUsedAt" loop
read a phantom field absent in real `~/.claude.json` (ts always 0, masked by last-key
fall-through — P6 probe); simplified to explicit last-key with a comment stating the
verified data shape (cumulative counters only, no timestamps).

### ANTIHALL_JUDGE_MODEL

`speculation-judge.js:194` now honors `ANTIHALL_JUDGE_MODEL` env override (house
convention for all anti-hall LLM call sites). Default remains `claude-haiku-4-5`
(alias-form, auto-tracking). `eval/run.js` / `eval/grade.js` were already env-overridable.

## 0.31.1

**Fix: statusline swarm-activity count is now per-session — no more cross-session/cross-project bleed.**

The line-2 "orchestrating · N agents active" bar counted EVERY recent subagent
spawn from EVERY Claude Code session on the machine, so a swarm running in one
project showed its count on every other open project's statusline. Root cause:
`phase-tracker.js` wrote bare `Date.now()` timestamps to the GLOBAL
`~/.anti-hall/agent-spawns.log` with no session identity, and `phase-bar.js`
`activityLine()` counted lines by TIME ONLY.

Fix (per-session isolation):
- `phase-tracker.js` now tags each spawn line as `"<ms> <tag>"`, where `<tag>`
  is the PreToolUse `session_id` (sanitized to `[A-Za-z0-9_-]`), falling back to
  `cwd-<sha1(cwd)[:12]>`, else `unknown`. Retention prune (5 min) and fail-open /
  never-block behavior are unchanged; other sessions' fresh lines are preserved.
- `phase-bar.js` `activityLine()` now derives THIS session's tag from the
  statusline's own session JSON (stdin: `session_id`, else `cwd`-hash) and counts
  ONLY entries whose tag matches AND fall within the 2-min activity window. LEGACY
  untagged lines belong to no session and are never counted (they age out). When
  no session identity is available, NO activity line is rendered (safer than a
  wrong count). Fail-open intact.

## 0.31.0

**Feature (OPT-IN, default OFF): `merge-gate` — a mechanical backstop for the v0.30.0 "false done" discipline.**

Mechanizes the one *checkable* part of the false-done failure: the agent wrote a
self-hedge ("first-pass" / "pending review" / "do not merge" / "needs your eyes")
in its OWN recent output, then auto-merged anyway. `merge-gate` is a PreToolUse
(Bash) hook that, **only when `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}**, detects an
auto-merge intent (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git
merge --no-ff/--ff` into `main`/`master`/`develop`) and does a bounded (128 KB)
tail-scan of the recent **assistant** transcript text for an UNRESOLVED hedge. A
hedge is RESOLVED (and the merge allowed) when a resolution token follows it
("owner approved", "owner signed off", "fidelity verified", "verified against",
"resolved:", "sign-off received"). Unresolved hedge + auto-merge → block (exit 2)
with a verify-or-get-sign-off reason.

HONEST limits (in the header): keyword-heuristic, bypassable (alternate merge
syntax / heredoc / GitHub UI / API), **default-OFF**, fail-open on every error (no
transcript, parse error, fs error, bad stdin). Cannot hard-loop — PreToolUse is
single-shot and holds no state. A backstop on the v0.30.0 discipline, NOT a
guarantee. Honors the `merge-gate` skip-hatch. Hooks shipped 19 → 20 (+`hooks.json`
= 20 → 21 files); +18 tests.

## 0.30.0

**Fix (P0): "false done" — DONE now requires verification against the AGREED acceptance criteria, not tests-pass or a subagent "per-spec" report.**

Fidelity that can't be mechanically verified (UI vs agreed mockup) is reported
PENDING OWNER VERIFICATION, never folded into done as a hidden follow-up;
coordinator verifies delegated acceptance (rule L); autonomy doesn't lower the bar.
Grounded in a real field failure (UI shipped "done" off green behavior-tests +
subagent self-reports, never compared to the agreed design HTML). Touches ship-it
Step 4/6 + Autonomous-mode, always-on protocol rule 6, +1 per-turn nudge (17 → 18).
A self-issued hedge (e.g., "first-pass / not pixel-perfect / pending review / needs your eyes") about a deliverable hard-blocks both its "done" status and any auto-merge; the coordinator's own written doubt is a verification signal.

## 0.29.0

**Feature (P0): `task-guard` now catches IDLE NEGLECT — the orchestrator sitting on dispatchable work instead of spinning parallel agents.**

The #1 field pain: an autonomous run ends a turn with non-blocked, unassigned tasks
pending and NO subagents running — it just stops instead of fanning out. The old Stop
hook only knew "open tasks exist → generic nudge", which the model learned to ignore.

`task-guard` now **classifies** open tasks into **ACTIONABLE NOW** = status `pending`
AND unowned (no `owner`, or owner is the main thread) AND no **OPEN** `blockedBy` (every
blocker already in a done state). It also **detects in-flight agents** by scanning
`~/.anti-hall/agents/*.json` for a FRESH heartbeat (numeric `ts`, or file mtime fallback,
within ~20 min — same format `agent-watchdog.js` writes; absent dir = no agents).

- **Sharp block (the new condition):** if ≥1 actionable-now task AND no agents running →
  **IDLE NEGLECT** → block naming those tasks: *"IDLE NEGLECT: N non-blocked, unassigned
  task(s) and NO agents running — dispatch them in PARALLEL NOW (one background agent each,
  cap ~min(16, cores-2)): &lt;names&gt;. Do not end the turn idle; only stop if a task truly
  needs the user (then say which + why)."*
- **Gentle path (no nagging real work):** if agents ARE in flight, or the only open tasks
  are blocked/owned/in_progress, it falls back to the existing generic drain nudge.

**Loop-safety (cannot hard-loop):** the idle-neglect block dedupes on a hash of
(actionable-set + `"no-agents"`) so it re-fires only when that set actually changes; an
absolute `MAX_BLOCKS` cap — raised modestly **3 → 5**, counting BOTH modes — guarantees a
genuinely-stuck set goes quiet after a few nudges. All existing safety kept (top-level
try/catch → exit 0, skip-hatch, per-session state under `~/.anti-hall/`, fail-open on any
error, bounded transcript tail-read).

Also: **orchestration rule C** (`verify-first-full.js` SessionStart protocol) reworded to
demand **PROACTIVE** parallel dispatch — fire a background agent for a pending, unblocked,
unassigned task the moment it exists, *without being asked*; ending a turn with such tasks
and no agents running is explicitly named IDLE NEGLECT.

**Complementary per-turn layer — `task-tracker` (UserPromptSubmit) now nudges BEFORE the
turn, not only at Stop.** The Stop-hook idle-neglect block fires after the model already
decided to stop; `task-tracker` now reviews the actionable-now set on *every* prompt and,
when ≥1 pending+unowned+unblocked task exists AND no agents are in flight, injects a
SPECIFIC review line into `additionalContext`:
*"TASK REVIEW (every turn): N non-blocked, unassigned pending task(s) — dispatch a
background agent for EACH now, in parallel (cap ~min(16, cores-2)), unless already
in-flight: &lt;up to 4 names&gt;. Do not leave them idle; only hold one if it truly needs
the user."* It reuses task-guard's exact definitions — `normOwner` / `normBlockedBy` /
`classifyOpen` (owner main/orchestrator/coordinator = ours; blocker open unless its task
is done/completed/cancelled) and the `~/.anti-hall/agents/*.json` fresh-heartbeat check.
Task subjects are control-char-stripped then `JSON.stringify`'d (inert quoted strings — no
prompt injection). When 0 actionable, the existing generic discipline + open-tasks
freshness note are unchanged. Reconstruction now also captures `owner`/`blockedBy` per
task (status-only `TaskUpdate` does not clear them). Bounded (same 256 KB tail read) and
fully fail-open — any error → existing generic text or nothing, never wedges the turn.

Tests: +6 task-guard cases (actionable-now + no-agents → idle-neglect naming tasks;
agents-running → generic not idle-neglect; all-blocked → generic; owned-pending → not
actionable; idle-neglect dedupe; churn-cap loop-safety). +5 task-tracker cases
(actionable-now → review line names tasks + says parallel; 0 actionable → generic only;
owned/blocked → not listed; fresh agent → no review line; malformed transcript →
fail-open). +E2E system test for the task-neglect enforcement (`tests/hooks/task-neglect-e2e.test.js`):
one realistic 3-pending-task transcript driving BOTH real hooks together against shared,
real fs heartbeat state — no-agents → tracker review line + guard idle-neglect block naming
only the actionable task; fresh heartbeat planted → both back off; actionable in_progress →
neither flags; loop-safety end-to-end (dedupe once, churn capped at MAX_BLOCKS). Suite
**340 passing / 342 total**.

## 0.28.2

**Fix (P0): `ship-it` plan-approval gate now honors granted autonomy — no more blocking for a "go" already given.**

Reported in the field: an autonomous run sat idle for hours at `ship-it`'s `ExitPlanMode`
plan-approval gate, waiting on approval the owner had already granted ("full autonomy / build
it / AFK"). Root cause: when the lean `ship-it` replaced feature-launch, it dropped
feature-launch's autonomous-mode handling, so the plan-approval and brainstorm gates became
**unconditional human stops** with no autonomy carve-out.

Fix — the two human gates (Step 1 brainstorm, Step 3 `ExitPlanMode`) are now explicitly
**SOFT**: under granted autonomy they are satisfied by *forming/recording the design* and
*converging the plan via the deadly-loop to zero NEW P0s*, then the run **proceeds straight
into the build** — it does not re-stop for an already-given go. A new **Autonomous mode**
section makes this the rule: stop only at a **hard safety boundary** (destructive /
irreversible / financial / secret / prod-deploy / force-push — these still NEVER
autonomy-bypass) or a **genuine ambiguity**, never the plan-approval gate itself. Interactive
behavior is unchanged (present plan, wait for approval).

## 0.28.1

**Loose-end closeout — cross-model (Codex) review fixes for `ship-it` + a full doc-currency pass. No new features.**

A cross-model Codex review of the shipped `ship-it` skill + its workflow template caught five real correctness/honesty gaps, all fixed:

- **Plan-mode write claim corrected.** Plan mode is read-only *for the repo* (it writes only to `~/.claude/plans/`), so `ship-it` no longer claims it can write the repo `PLAN.md` inside plan mode — the plan is drafted + presented via `ExitPlanMode`, and `PLAN.md` is written as the first action *after* approval.
- **Two-phase tier-sizing closed a gap.** Even an S-classified change now does a ~30-second blast-radius sanity glance before the tier is locked, so a deceptively-large "simple" ask can't skip the re-tier (S stays lean otherwise).
- **Workflow template hardened.** Takes `files[]` (not a diff string) and `validateGroup()` fails closed unless a fan-out group is conflict-free (disjoint files, unique labels, no intra-group dependency) before any `parallel()`.
- **Template honesty.** The template is now labelled a SINGLE-PASS audit *scaffold* (shows the fan-out shape); the full iterate-to-zero-NEW-P0 fix-wave + D1.5 gate is run by invoking the `deadly-loop` skill — no false convergence claim.
- **Commit ownership clarified.** The template never commits; agents return results and the coordinator commits serially on the main thread.

Plus a thorough doc-currency pass: test counts reconciled to **329 pass / 331 total / 2 platform-skip**, and `ship-it-guard` added to every user-facing hook inventory (it was only in the KB).

## 0.28.0

**`ship-it` v2 — 2-phase tier-sizing, an OPT-IN enforcement gate, and a copyable `/ship-it` workflow template.**

This release hardens the `ship-it` workflow with a thin mechanical backstop and a reusable
execution script, without changing its default behavior (the new gate is OFF by default).

- **2-phase tier-sizing (skill).** Step 0 now decides the S/M/L tier **twice**: a PROVISIONAL
  tier from the initial prompt (sets how much exploration to do), then a CONFIRMED/REVISED tier
  at the blast-radius map after the Step-2 graphify-first research reveals the true blast radius.
  A deceptively-large "simple" ask (one-liner that touches auth, or fans out to many callers)
  gets upgraded; an over-estimate gets downgraded — re-decided **before** plan mode locks rigor.
- **`ship-it-guard` hook (new; OPT-IN, default OFF).** PreToolUse on `Write|Edit|MultiEdit`.
  A pure no-op (exit 0) unless `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}. When ON: blocks
  (exit 2) a CODE edit on a **hard-risk path** (migration / auth / `.github/workflows` /
  security/crypto) when **no `PLAN.md`** exists (repo root or `.planning/PLAN.md`) — nudging
  the agent to plan first. **Honest limits (in the hook header):** enforces artifact-EXISTENCE
  only, NOT plan quality (a stub `# Plan` satisfies it); bypassable via a `Bash` heredoc write
  (PreToolUse sees Edit/Write/MultiEdit only); **conservative** — never gates ordinary
  single edits, docs, or tests; **fail-open** on any error; honors the shared
  `isSkipped('ship-it-guard')` escape-hatch. Registered in `hooks.json` (timeout 10).
- **Copyable `/ship-it` workflow template (new).** Investigated feasibility: per the official
  [Dynamic Workflows docs](https://code.claude.com/docs/en/workflows), a plugin **cannot ship**
  a workflow command — there is no `workflows` field in `plugin.json`, and a workflow only
  becomes a `/command` by saving a *live run's* script via `/workflows` → `s` into
  `.claude/workflows/` (project) or `~/.claude/workflows/` (user). So `ship-it` ships a
  **copyable template** at `skills/ship-it/references/ship-it.workflow.js` (deterministic — no
  `Date.now`/`Math.random`/`new Date`; inputs via `args`) that automates the L-tier Step-4
  build fan-out (`parallel([...])` over disjoint phases) + the Step-5 per-phase deadly-loop
  (Reviewer + Codex Critic via `agentType: "codex:codex-rescue"`), plus a one-line pointer in
  the skill telling the user to save it as `/ship-it`.
- **Tests:** `tests/hooks/ship-it-guard.test.js` (13 cases — default-off no-op, ON+L-risk+no-PLAN
  ⇒ exit 2 + reason, PLAN.md present ⇒ allow, ordinary/doc/test file ⇒ allow, env-value parsing,
  fail-open on malformed/empty stdin, skip-hatch). Full suite: 331 tests, 0 fail.

## 0.27.0

**`ship-it` workflow replaces `feature-launch`. deadly-loop gains a D1.5 verification gate.**

This release retires the `feature-launch` skill and ships `ship-it` in its place — one lean,
anti-hall-native workflow for shipping any change correctly, from a one-line fix to a
multi-phase feature.

- **`ship-it` (new, replaces `feature-launch`).** A tier-scaled (S / M / L) fusion of the
  best of superpowers-planning + the GSD phase loop + the deadly-loop, with the bloat removed.
  Brainstorm + plan happen **in plan mode** (`ExitPlanMode` is the build-unlock approval gate;
  no code before approval); the plan is hardened with the deadly-loop **before** any code; on
  large (L) work the disjoint build phases and the per-phase deadly-loop fan out as a **Workflow
  swarm**; each phase is verified with fresh evidence and a vacuous-test guard, then hardened
  until zero NEW P0s. Wired to real Claude Code primitives (plan mode + the Workflow tool) plus
  anti-hall's own deadly-loop and always-on guards — **standalone**, no GSD/superpowers
  dependency. Hard safety boundaries (force-push, prod deploy, destructive/financial actions)
  never autonomy-bypass and are enforced by the always-on guards, which swarm agents inherit.
- **`feature-launch` removed.** Its bespoke `references/` (including the per-project
  `PRE-TOOL-USE-HOOK.md` template) are gone; `ship-it` relies on the always-on guards instead
  of a bespoke per-feature sentinel, and reuses the deadly-loop's `MODEL-POLICY.md`, A3
  branch/SHA verification preamble, validation table, and D1.5 gate. The shared
  `MODEL-POLICY.md` is now duplicated in 2 places (canonical + `deadly-loop/references/`)
  instead of 3.
- **deadly-loop D1.5 verification gate.** A GO verdict is no longer valid without a D1.5
  check — fresh evidence (re-run the authoritative check this round, not a stale prior result)
  plus a vacuous-test guard (a passing test that asserts nothing, or never exercises the
  changed path, does not count). Inherited by **all** deadly-loop-driven workflows, including
  `ship-it`'s per-phase gates and `deadly-loop-multi`.

## 0.26.0

**Structured-return discipline (rule G) made concrete + measured.**

Rule G (SYNTHESIZE, NEVER RELAY) already required subagents to return tight summaries
under an OUTPUT BUDGET. This release makes the SUBSTANTIAL-return case concrete and grounds
it in measurement, with no mechanical or behavioral change to any guard.

- **Schema now specified.** For a SUBSTANTIAL return (a review/audit/research dump, many
  claims), rule G now names the exact compact shape to require:
  `{claim, evidence:"file:line", verdict, blockers/uncertainty, next}`.
- **Measured, not asserted.** A deadly-loop-hardened study (S4) measured these structured
  subagent returns at **~5× smaller than verbose prose with zero decision-relevant loss**,
  judged on a claim/evidence/uncertainty/blockers/next rubric (N=8, directional). Rule G
  cites the figure inline.
- **Reconciles the earlier ~1.4× number.** The prior pilot's ~1.43× density figure measured
  *small, already-summarized* content (where a schema is a minor lever, and JSON overhead can
  make tiny outputs LARGER). The ~5× figure is for *verbose* returns. Both hold; they measure
  different inputs. The **prose-for-tiny caveat is kept** — a single prose line still wins for
  a SMALL result; do not impose JSON there.
- **Enforce, don't just request.** Rule G notes that passing a **schema to the Agent/Task
  tool** validates the structured return rather than merely asking for it. The biggest levers
  remain the output budget + no-raw-relay rule; the schema is the multiplier on large returns.
- The per-turn SYNTHESIZE nudge (#57) was updated in place to carry the schema + the ~5×
  figure. Nudge count unchanged (**17**).

No guard mechanics or hook behavior changed — this is prompt discipline (rule G text + one
nudge) only. `node --test` green: 316 passing (+2 platform-skipped), 318 total.

## 0.25.2

**CI green on all platforms — root-cause fixes for the macOS stdout race and Windows base-command env.**

0.25.1's test-gating fixes were incomplete; CI stayed red on macOS node 18/20 and all
Windows legs. Root-caused properly (from real CI logs) and fixed at the source:

- **macOS (hook source fix):** `verify-first-full.js` and `graphify-session.js` emit a
  ~10 KB JSON payload, then `process.exit(0)`. On a pipe, `process.stdout.write` is async
  once the payload exceeds the OS pipe buffer, so `exit(0)` could race the flush and the
  reader saw empty/partial stdout (intermittent on macOS node 18/20). Switched both to a
  blocking `fs.writeSync(1, …)` so every byte is handed to the pipe before exit. The
  test-side `expectJson` retry is kept as defense-in-depth and corrected to re-spawn on
  any parse failure (empty OR partial), not just empty.
- **Windows (test harness fix):** the statusline base-command test starved `cmd.exe` with
  a stripped env (a hand-picked `SystemRoot/ComSpec/PATHEXT` allowlist was insufficient),
  so the base command failed and the dispatcher fell back. The statusline test harness now
  inherits the full parent env and overrides only the HOME-pointing vars (statusline
  scripts read no Claude Code markers, so only HOME needs isolating).

No user-facing behavior change beyond more reliable hook stdout. `node --test` green on
Ubuntu, macOS, and Windows × Node 18/20/22/24.

## 0.25.1

**CI fix — cross-platform test gating. No plugin behavior change from 0.25.0.**

The 0.25.0 test suite passed locally but failed on CI macOS + Windows: all failures were
test-side environment assumptions, not plugin bugs (source behavior is correct on every
platform). Fixed test-side only:

- **macOS:** a graphify reflected-path test asserted a substring (`graphify-out`) that the
  hook's 80-char `sanitizePath` cap truncates under CI's long `/var/folders/.../T/` tmpdir
  (passed locally only because the dev tmpdir is short) — now asserts the always-in-cap
  base-dir name. Added an opt-in single retry for a macOS `spawnSync` empty-stdout pipe
  flake on the large-JSON SessionStart hook (node 18/20).
- **Windows:** install-reaper `--dry-run` tests now assert the `win32` no-op message
  (the installer correctly short-circuits before reading flags); tests that `mkdir` a
  directory whose name contains characters illegal in Windows filenames (`"`, control,
  bidi) are `win32`-skipped; statusline base-command tests invoke `node "<abspath>"`
  (survives both `sh -c` and `cmd /c`) instead of a nested-quote `node -e`.

Net: `node --test` green on Ubuntu, macOS, and Windows × Node 18/20/22/24.

## 0.25.0

**Always-on SCOPE & FIDELITY discipline + an opt-in mcp-reaper companion (macOS + Linux).**

**A — SCOPE & FIDELITY discipline (prompt layer).** A new always-on discipline injected by
the SessionStart protocol (`verify-first-full.js`) and reinforced by 2 new per-turn nudges
(`verify-first.js`, NUDGES 12 → 14; later 14 → 15 with the verify-delegated-work nudge in
section C). It enforces: solve the ACTUAL problem with the
**simplest sufficient solution** (over-engineering is confabulating work the user never asked
for); **intent over letter** (serve what the user means; do the small reading and say what you
skipped rather than guess-big); **confirm before expanding scope** (new platform / file /
dependency / phase / abstraction); **match rigor to blast radius** (heavy process is for risky
or large work, not a reflex on small asks); and **finish what was asked / drop nothing
silently**. It is now named in the "ALWAYS APPLY" disciplines list alongside
root-cause / orchestration / anti-sycophancy, and mirrored in `AGENTS.md` for Codex.

**B — mcp-reaper companion (OPT-IN, macOS + Linux).** A new pure-Node background **companion**
(NOT a hook — an interval job via a macOS LaunchAgent / Linux `systemd --user` timer, cron
fallback) that kills **orphaned** MCP-server processes — ones leaked when their spawner (a
Claude / codex / npm / node session) exits without cleaning them up (on macOS these reparent
to launchd and pile up over a workday). Files: `companion/mcp-reaper.js`,
`companion/install-reaper.js`, `companion/README.md`. Install with
`node plugins/anti-hall/companion/install-reaper.js` (`--uninstall` to remove). Env knobs:
`MCP_REAP_DRYRUN=1`, `MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`
(regex of cmd substrings to NEVER reap). Also recognizes **Python MCPs** (`uvx`/`uv` +
underscore `mcp_server_*` forms), not just Node.

- **Safety invariant:** a process is reaped only if its command matches a generic MCP
  signature **and** its parent is a reaper/init (pid1 / launchd / `systemd --user` / WSL
  `Relay()`). Because Unix always reparents a dead process's children, a *live* MCP's parent
  is always a live spawner — never a reaper — so "parent is a reaper" means the spawner died,
  i.e. the MCP is a true orphan. Killing an in-use server is impossible by construction.
- **Limitation — service-managed MCPs:** an MCP run as a macOS LaunchAgent / `systemd --user`
  unit / other OS service shares init (ppid 1) as a parent **while alive** — indistinguishable
  from a leaked orphan — so it could be reaped. Exclude it via
  `ANTIHALL_REAPER_EXCLUDE='your-service-name|another'` (case-insensitive regex of cmd
  substrings that are never reaped).
- **Windows is a documented no-op (rescope rationale):** Windows has no parent-death
  reparenting **and** recycles PIDs, so external orphan detection is unsafe there — a matched
  signature on a recycled PID with an `init`-ish parent could kill an unrelated live process.
  The correct fix on Windows is **Job Objects set by the spawner**, which a companion cannot
  do. So the installer prints why and installs no scheduler.

**C — VERIFY DELEGATED WORK discipline (prompt layer).** Orchestration now requires the
coordinator to **independently verify delegated work** — a subagent's "done / fixed / tests
pass / N passing" is an UNVERIFIED CLAIM, never a fact. Before marking any delegated task
complete, the coordinator RE-RUNS the authoritative check (or dispatches a separate verifier)
and reconciles multiple workers against GROUND TRUTH, not against each other. Added as rule L
in `verify-first-full.js`, folded into the "ALWAYS APPLY" orchestration summary, mirrored in
`AGENTS.md`, and reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 14 → **15**).

**D — Background-default orchestration (prompt layer).** Orchestration now defaults delegated
heavy/parallel/long work to the **background** (the coordinator passes `run_in_background`
itself) so the user needn't background it manually, while still verifying each on completion —
never fire-and-forget. Extended into rule F in `verify-first-full.js`, mirrored in `AGENTS.md`,
and reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 15 → **16**).

**E — Fix-history ledger discipline (prompt layer).** The `tasklist-guard` Stop reminder now
also prompts appending each **completed task** to `.anti-hall-history.md` — an append-only fix
ledger (one entry per task: **Cause / Fix / Verified**) so the fix history persists for the
knowledge layer. Same reminder, enriched (no new hard Stop-block condition), fully fail-open.
Mirrored as full-protocol text in rule B of `verify-first-full.js` and documented in
`docs/TASKLIST-GUARD.md` / `docs/KB.md`. The hook never creates the file — it is gitignored,
local session state.

**F — Message-context bloat prevention (#45, prompt layer).** Orchestration rule G is rewritten
from "synthesize, don't paste raw output" into **SYNTHESIZE, NEVER RELAY**: the coordinator
reports findings in its own words and NEVER pastes a subagent's raw return into the user thread
(that verbatim relay is the **#1 cause of message-context bloat**), and subagents must return
TIGHT summaries under an explicit **OUTPUT BUDGET** (findings only; a compact
`{claim, evidence:"file:line", verdict}` schema only when >~5 claims or >~200 tokens, else one
prose line). Reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 16 → **17**).
**Pilot finding:** a
compact JSON return schema is only **~1.43× denser than prose on average** (and *worse* for
tiny outputs), so schema enforcement is a MINOR lever — the real levers are the output budget +
the no-raw-relay rule, which is why this ships as prompt discipline, not a schema-enforcement
system. A `PostToolUse`-on-`Task` hook to flag oversized subagent returns was evaluated and is
**NOT feasible**: per the Claude Code hook contract (KB-claude-codex §1.4), `PostToolUse` stdout
/`additionalContext` never reaches the model and `PostToolUse` cannot block — so it cannot
inject a reminder back. No hook was faked; the discipline is the mechanism.

Suite 318 total, **316 passing** (+2 platform-skipped).

## 0.24.1

**Doc-currency pass — descriptions + test counts brought to current reality.**

No behavioral change. The `plugin.json` and `marketplace.json` descriptions predated
api-guard and the v0.24.0 gh-PR guard — both now name the two signature mechanical guards
(api-guard: fabricated-API blocking, opt-in 3rd-party; git-guard: AI self-credit in commits
**and** gh pr/issue/release bodies). Test-count references corrected to **173** across
README (root + plugin), `llms.txt`, and `docs/KB.md`; KB snapshot provenance refreshed to
post-0.24.0.

## 0.24.0

**git-guard now also blocks AI self-credit in `gh` PR / issue / release bodies.**

Previously git-guard blocked AI co-author trailers in `git commit` only; PRs created
with `gh pr create --body "… 🤖 Generated with Claude Code …"` slipped through. Now the
same self-credit markers (the `🤖 Generated with [Claude Code](…)` footer, `Co-Authored-By:
Claude`, `noreply@anthropic.com`, a bare `claude.com/claude-code` link) are blocked in the
inline `--body`/`--title`/`--notes` of `gh pr|issue|release create|edit|comment`. Reuses the
existing commit markers + a bare-link marker; quote/segment-aware via git-guard's tokenizer.
Inline values only — `--body-file`/`-F` and heredoc/command-substitution bodies put the text
off the command line and are a documented fail-open limitation. +8 gh tests; suite 173/173.

## 0.23.0

**api-guard v2 — opt-in 3rd-party API verification + security hardening.**

api-guard can now verify installed **3rd-party** packages (pandas, lodash, …) — the
highest-hallucination class (38–80% per the literature) — not just stdlib/builtins.
But a double deadly-loop (2 Opus + 2 Codex) **proved that verifying a 3rd-party
package = importing it = running its top-level code at edit time** (a confirmed RCE,
triggered even when the write is blocked; Codex bypassed the first fix via bare
`node_modules` packages and `.pth` files). You cannot check an installed package's
API without executing it. So 3rd-party checking is **opt-in, off by default**:

- **Default (unchanged):** stdlib/builtin modules + JS globals only — importing those
  to introspect is side-effect-free, so the probe never runs untrusted code. Safe.
- **Opt-in:** set `ANTIHALL_API_GUARD_THIRDPARTY=1` to also verify installed packages,
  accepting that referenced installed packages are imported at edit time.

**Security hardening (both modes):**
- Local/relative modules are NEVER probed: path-spec rejection (`./x`, `/abs`, `..`,
  `C:\`), Python probe runs with `cwd=<tmp>` + scrubs cwd/`''` from `sys.path`, so a
  bare `import localmod` can't resolve to a repo file.
- `SAFE_ENV` now also strips `PYTHONUSERBASE`/`PYTHONSAFEPATH`, and the Python probe
  runs with `-s` (no user site) — closes the `.pth` startup-exec vector.
- Batched **one import per module** (not per attribute); **30s wall-clock deadline**
  under the hook timeout (raised 30→45s); JS requires extracted from comment-stripped
  code; function/lambda-parameter and `with/except as` names excluded from checking
  (no false-block on `def f(pd): pd.x`).

165 tests (3rd-party gated + RCE-no-execute regression), bench 21/21 catch / 0 FP.
Known v2.1 gaps (fail-open, documented): dotted-submodule receivers (`os.path.x`) and
JS member chains (`fs.promises.x`) are not yet checked.

## 0.22.2

**Fix: api-guard CI flake on Windows/node (probe timeout too tight).**

After 0.22.1 the windows-latest leg still flaked intermittently (same commit green on
`main`, red on the tag run): a COLD `python`/`node` spawn on a loaded Windows runner
occasionally exceeded the `1500ms` probe timeout → the check timed out → fail-open →
the `asyncio.run_all` test expecting a block got an allow. Raised `SPAWN_TIMEOUT_MS` to
`5000ms` (a CEILING, not added latency — a normal spawn returns in <300ms; this just
stops us giving up too early on a cold start), lowered `MAX_CHECKS` 12→6 to keep the
worst case bounded, and bumped the hook's outer timeout 30→45s for headroom. Suite
159/159.

## 0.22.1

**Fix: api-guard now works on Windows (CI was red on the windows-latest matrix legs).**

The probe env was a PATH-only allowlist, which is secure but too minimal for Windows —
Python could not spawn without `APPDATA`/`LOCALAPPDATA`/`TEMP`/etc., so `pyBin()` returned
null and the hook fail-opened (Python fabrications silently allowed) on Windows. Changed
`SAFE_ENV` to a **denylist**: the full parent environment minus the interpreter-injection
vectors (`NODE_OPTIONS`, `NODE_PATH`, `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`,
`PYTHONINSPECT`, `PYTHONEXECUTABLE`). Keeps the security property (a poisoned env can't
influence the existence check) while letting Python spawn on every OS. Suite 159/159;
the exact failing case (`asyncio.run_all`) now blocks. Doc-only follow-up `547e184`
(corrected stale test counts to 159) also rolled up here.

## 0.22.0

**`api-guard` — a mechanical guard against API hallucination, built on eval evidence.**

A controlled A/B eval (see [`eval/`](eval/)) established that the verify-first *prompt*
does not reliably reduce API fabrication: across four rounds (incl. a powered 122-trap,
tools-on run with a naive baseline) the protocol netted **no statistically-significant
reduction** (McNemar p=0.26), and the model ran a verification tool only ~5% of the time —
*the same as baseline*. The model ignores "go verify." So this release does the verifying
mechanically:

- **`api-guard`** (new) — a `PreToolUse` hook on `Write`/`Edit`/`MultiEdit`. It extracts
  `module.attribute` references from the code about to be written and resolves them against
  the **installed** runtime (`python3` / `node`): Python stdlib `mod.attr` and `from mod
  import Name; Name.attr` (via `hasattr`), Node builtins `require('mod').attr`, and JS
  global builtins incl. `.prototype.attr` (via `typeof`). If a real module/object is missing
  the referenced attribute, the write is **blocked** — the symbol was fabricated.
  - **Substantiated: 100% in-scope catch, 0 false positives** on a committed, reproducible
    bench — `node eval/api-guard-bench.js` (labeled corpus + a sweep of every `plugins/**.js`).
    Contrast the prompt's unproven ~18%.
  - **Fail-open by construction:** blocks ONLY on a positively-verified missing attribute;
    any uncertainty (no interpreter, import error, 3rd-party package, receiver-typed instance
    method, version skew) → allow. From-import bindings resolve before module names so
    `datetime.fromisoformat` (class method) is not mistaken for a module attribute.
  - **Hardened by a double deadly-loop (2 Opus + 2 Codex) + empirical sweep.** Security review
    found injection/ReDoS/resource genuinely closed. Correctness review found and fixed a P0
    false-positive cluster: stdlib/global names used as **local variables** (`array = [1,2];
    array.append(3)`, `const Math = myLib; Math.x`), require-vars **reassigned** to a 3rd-party
    (`fs = require('fs-extra')`), and from-import names rebound — now all resolve correctly
    (require a real `import`; exclude locally-bound names). Added `Buffer` to JS globals;
    `python` (3.x) fallback for non-`python3` systems; probe env pinned to PATH-only.
  - Skip-hatch via `~/.anti-hall/skip.json` (`api-guard`); 27 tests (block/allow/fail-open/
    scope/skip/regression/shadowing/portability), `python3`-gated for Windows CI. Full suite **159/159**.
- **eval/** harness added: `claude -p` subscription backend (no API key), naive-baseline +
  tools-on knobs, 122 execution-verified traps, `analyze.js` (McNemar exact + bootstrap CI).
  Documents the honest finding that prompt-only fabrication reduction is unproven.

## 0.21.1

Refresh marketplace.json plugin description to current capability set (tasklist-guard, skip-guard, deadly-loop-multi, speculation guards, rule K, escape hatch) for the public listing; add assets/demo/ (VHS .tape + storyboard) to generate a demo GIF.

## 0.21.0

Pre-publish **triple-deadly-loop** hardening pass (3 Opus reviewers + 3 Codex critics, two re-converge passes) before the first public release. Closes a cluster of deliberate-evasion gaps in the always-on guards and the reflected-text sanitizers:

- **git-guard** — now blocks AI/assistant self-credit trailers slipped in via `git commit --trailer`, including the `key=value` separator form (`Co-Authored-By=Claude <…>`) alongside the `key: value` form, and a `-c trailer.<name>.key=<self-credit>` remap that would emit a `Co-Authored-By` / `Generated-with` trailer from a benign-looking custom token. Benign trailers (`Reviewed-by=Alice`, `-c trailer.sob.key=Signed-off-by`) still pass.
- **tasklist-guard** — fail-open when the state dir is unwritable instead of wedging.
- **swarm-guard** — steals a zero-byte / corrupt lock instead of deadlocking, and resolves `vm_stat` by absolute path.
- **graphify-reminder** — bounds the `git rev-parse` probe with a timeout.
- **sanitizers** — reflected-text + terminal-control + **Unicode bidi** hygiene across `graphify-guard`, `graphify-session`, `speculation-judge`, and both statuslines: bidi overrides (U+202A–U+202E) and isolates (U+2066–U+2069) are now stripped so a crafted path/claim can't visually reorder terminal/model output. Regexes stay linear (no ReDoS); legit UTF-8 and branch names are preserved.
- **docs** — accuracy fixes (`KB.md` → `0.21.0`, `TASK-WORK` >1/checks wording, README statusline + doctor list, E2E +24.x); README badges (tests / version / license / node / plugin).

Accepted residuals (deliberate evasion of a safety net, documented not closed): `base64 | sh`, pipe-to-shell, process-substitution, deeply-nested `eval`, `commit -F <file>` / editor commits, and Unicode-confusable token swaps. These require an adversary actively defeating their own guardrail and are out of scope for a fail-open static hook.

## 0.20.3

Add RELEASING.md — the ordered release + doc-currency checklist the agent follows on every ship (manual tagging by agent, no CD); pointer from AGENTS.md.

## 0.20.2

Doc currency sync — `llms.txt` + `plugins/anti-hall/README.md` were stale (predated tasklist-guard / skip-guard / rule K); added the missing hooks (`tasklist-guard`, `skip-guard`, `command-guard`, `swarm-guard`, `phase-tracker`, `agent-watchdog`), the user-override escape hatch, rule K output-presentation, the E2E test suite + CI, and the new docs (`CONTEXT-PRESERVATION-KB`, `TASK-WORK`, `TASKLIST-GUARD`, `KB`, `E2E-TESTING`). Fixed "four Stop hooks" → five. CHANGELOG + tests were already current.

## 0.20.1

- orchestration skill gains a concise "References & context guardrails" section —
  points to `docs/CONTEXT-PRESERVATION-KB.md` (the swarm-researched context-discipline
  KB) and the findings-discipline (externalize durable findings to memory, case
  findings to `.anti-hall-progress.md`; compact early once externalized; context-rot
  sweet spot is a cadence not a length). Outcome of a deadly-loop on 3 candidate
  context enhancements: the other two (an always-on findings protocol line, a
  statusline pressure cue) were DROPPED as footprint regression / redundant with the
  existing color gradient + native Auto Memory; only the skill-reference survived.

## 0.20.0

New `tasklist-guard.js` Stop hook + a per-turn freshness note (in `task-tracker.js`) that enforce live task-list + fresh `.anti-hall-progress.md` discipline for non-trivial work, so real work is tracked and never silently dropped or declared-done by a later agent. It **coexists with `task-guard`** (which drains declared tasks); each keeps an independent block cap so the two never compound.

- **When it blocks (Stop):** ≥ `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default 3) file-mutating actions (`Edit`/`Write`/`MultiEdit`/`NotebookEdit` + mutating `Bash`) AND (no task activity for it, OR more than one task `in_progress`, OR no fresh `.anti-hall-progress.md`). Blocks via `{decision:"block"}` (never exit 2 — plugin Stop hooks don't reliably continue on it), capped at `MAX_BLOCKS=3` cumulative per session, fully fail-open.
- **Progress file:** `<cwd>/.anti-hall-progress.md` (done/in-progress/next), must be updated this session to count fresh (window `ANTIHALL_PROGRESS_FRESH_MS`, default 30 min). Gitignored, never ships; the hook never creates it.
- **Per-turn freshness note:** when open/stale tasks exist, `task-tracker` injects a one-line reminder (open-task count + oldest `in_progress` subject).
- **Escape hatch:** `~/.anti-hall/skip.json` `{"tasklist-guard": <unix-ms expiry>}` (or `"all"`) via the shared skip-guard, or ask the agent to skip.
- **Hardened via 2 deadly-loop passes (Opus + Codex):** multi-`in_progress`-only staleness (a single `in_progress` — the healthy flow — never false-blocks), emit-before-persist (a state-write failure can't retract an emitted block), `lstat` + `isFile` progress check (rejects a dir/symlink named like the file), cwd-missing fail-open, command-position-aware + broadened `Bash` work regex (ReDoS-safe), task-subject injection neutralized via `JSON.stringify`.
- **Coverage:** 120-test E2E suite incl. 21 `Bash`-regex cases; `doctor` gains a tasklist-guard self-test (4 edits, no tasks, no progress file ⇒ block).
- **Accepted deferrals (fail-open by design):** cumulative work counters vs the 512 KB transcript tail-clip (work before the window is unseen, can only *suppress* a block — the safe direction); sync-I/O stall on a network-mounted cwd (the 30 s hook timeout makes a non-block the outcome).
- New doc [`docs/TASKLIST-GUARD.md`](docs/TASKLIST-GUARD.md) (usage); README + `docs/KB.md` pointers added.

## 0.19.0

Strengthened deadly-loop auditor instructions with explicit depth requirements to prevent surface-skimming and ensure genuine issue discovery. Both `deadly-loop` and `deadly-loop-multi` skills now mandate:

- **DIG DEEP.** Read full implementations end-to-end, trace control and data flow across files, follow every branch and error path. Never judge from names, signatures, or diff hunks. Cite file:line ranges actually read.
- **ENUMERATE & SIMULATE EDGE CASES.** Systematically exercise boundary conditions, empty/malformed/oversized/unicode/concurrent inputs, missing files, permission denials, clock skew, truncation, and injection-shaped data. Mentally execute or write throwaway harnesses; report predicted outcomes.
- **REAFFIRMED 3-TIER SEVERITY.** P0/P1/P2 categories (plus EASY-WIN) ranked by heat — correctness > reliability > ergonomics.
- **CARRY-FORWARD DISCIPLINE.** Verify each prior finding's fix resolved without regression before hunting genuinely NEW issues. Distinguish new discoveries from re-reported findings.

For `deadly-loop/SKILL.md`: added new "B0. Auditor depth requirements" section with B1/B2 forward pointers. For `deadly-loop-multi/SKILL.md`: expanded the mandatory brief-footer and step-6 reconverge to enforce carry-forward discipline across iterations. Auditor reviews now drill into implementation to surface root causes instead of polish-layer issues.

## 0.18.0

Performance: trimmed the always-on SessionStart protocol (`verify-first-full.js`) footprint by
condensing VERBOSE PROSE ONLY — every rule, every rationalization trigger phrase, all orchestration
labels A-K, the USER OVERRIDE mechanism, and the DISCIPLINES section are preserved verbatim. The
SessionStart injection dropped from 8074 B to 7474 B (~7.4 KB, ~160-180 tokens saved) with zero
efficacy loss. Hardened by a new 77-test zero-dep E2E net that asserts every marker is present (so a
dropped rule fails the build), plus TWO deadly-loop passes (Opus reviewer + Codex critic) that caught
8 semantic nuances the trim over-cut and restored them. Also fixed a stale "compact-matcher" comment
in `verify-first.js` to match the verified no-matcher SessionStart mechanism. Net: smaller one-time
injection, identical protocol.

## 0.17.1

Bug fix: task-tracker self-heals corrupted or future throttle state. A future or non-finite
`lastFull` timestamp (from clock skew, manual edit, or corruption) previously left the throttle
window permanently "within window", so the full task directive never re-showed. The throttle now
detects a future-beyond-tolerance (5 min) or non-finite value as window-expired and rewrites
the state to now, allowing the full task output to surface again on the next turn.

## 0.17.0

Tier-B guard hardening. Tightens the static command analysis so a quoted data literal is no
longer mistaken for a heavy command, and unwraps a single `eval` payload so a guard sees the
real command it would run — in both command-guard and git-guard.

- **command-guard is quote-aware.** Heavy-pattern matching now distinguishes a heavy command
  from a heavy-looking string literal: `echo "npm run build"` / `printf 'go test ./...'` pass a
  quoted data argument and are no longer false-blocked in the coordinator, while an unquoted
  heavy command (`npm run build`), a command-substitution payload (`echo "$(npm run build)"`),
  and a `bash -c "npm run build"` wrapper still block. The intent is to stop flagging strings
  that merely *contain* a heavy verb without losing any real execution path.
- **`eval` payload unwrapping in BOTH command-guard and git-guard.** A single `eval "…"` is now
  unwrapped and its inner command re-scanned, so `eval "npm test"` blocks in the coordinator and
  `eval "git push -f"` is caught by git-guard, instead of slipping past as an opaque `eval`
  argument. `eval "echo hi"` / `eval "git status"` still pass.
- **Known residual gaps (accepted, by design).** `base64 | sh`, process-substitution
  (`<(…)`), and `git commit -F <file>` trailer smuggling remain accepted defense-in-depth gaps:
  they cannot be closed by static inspection without over-blocking legitimate use. The guards are
  a safety net against the common slip, not a sandbox — a determined evasion is out of scope.

## 0.16.0

Round-2 Tier-A guard hardening, surfaced by the double deadly-loop on the round-1 changes.
Closes the fail-closed and OOM cases that could wedge or crash a guard, and seals two guard
evasion paths the round-1 hardening missed.

- **swarm-guard memory gate fails OPEN, not closed.** The free-memory parser previously fell
  back to `os.freemem()` on a parse failure, which on some platforms reports near-zero and
  could block every spawn (fail-closed safety guard left silently disabled is the opposite of
  what a coordinator wants). It now SKIPS the memory gate entirely when the platform memory
  read can't be parsed, so a spawn is never blocked on bad telemetry.
- **swarm-guard lock uses an owner token — no blind `unlink`.** The advisory spawn lock now
  writes an owner token and only releases a lock it actually owns, instead of blindly
  `unlink`-ing whatever lock file is present (which could stomp a concurrent holder).
- **Bounded transcript tail-reads (512 KB) — OOM guard.** `speculation-guard.js`,
  `speculation-judge.js`, `task-guard.js`, and `graphify-reminder.js` previously
  `readFileSync`'d the entire transcript; a long session could grow that to hundreds of MB and
  OOM the hook. They now tail-read only the last 512 KB, which is more than enough for the
  recent-turn inspection each performs.
- **task-guard subject sanitization.** The task subject is now sanitized before it is echoed
  into the block reason, closing a reflected-content path.
- **graphify rev-parse timeouts (2000 ms) + non-echoing block reason.** `graphify-session.js`
  and `graphify-guard.js` now bound their `git rev-parse` calls at 2000 ms so a wedged git
  can't hang the hook; `graphify-guard.js` no longer echoes the raw command into its block
  reason (label only).
- **git-guard seals two evasion paths.** It now catches a `+refspec` force-push smuggled
  AFTER a `--` end-of-options marker (`git push origin -- +main:main`), and blocks
  `git --config-env alias.*` config smuggling that could alias a benign verb to `push
  --force`. Normal pushes and literal `--`-separated operands are unaffected.
- **command-guard light exceptions + non-echoing reason.** Read-only `git push --dry-run`
  and read-only `go env` (without `-w`) are now treated as light and allowed in the
  coordinator; the heavy-command block reason no longer echoes the raw command (label/verb
  only), removing a reflected-injection surface.
- **Windows-safe installer.** `statusline/install-statusline.js` now uses a shell-free
  `execFileSync` for the git-tracked check, so the install path no longer depends on a POSIX
  shell.

Tier B remains pending: the command-guard quote-aware false-positive and the
`eval`/base64/process-substitution evasion cluster are not addressed here.

## 0.15.0

Adds a user-override escape hatch across all guards, hardens the speculation hooks against
a Stop-loop wedge, bounds the deadly-loop convergence, and lands several doc fixes.

- **User-override escape hatch.** New shared primitive `hooks/skip-guard.js` exports
  `isSkipped(name)`, which reads a TTL'd marker at `~/.anti-hall/skip.json`
  (`{"<guard>": <unix-ms expiry>}`). When the user EXPLICITLY asks to skip a guard, the
  agent records consent there and the guard fail-opens (does not interfere) until it expires
  — default TTL 15 minutes so a safety guard is never left silently disabled. Granular: the
  broad key `"all"` covers the noisy guards but **NOT** `git-guard` (force-push / self-credit
  must be named explicitly). Fail direction is safe: a missing/corrupt marker keeps every
  guard ACTIVE. Wired into all 7 guards (`git-guard`, `command-guard`, `swarm-guard`,
  `speculation-guard`, `speculation-judge`, `graphify-guard`, `task-guard`) immediately after
  the stdin read. The SessionStart protocol (`verify-first-full.js`) and `AGENTS.md` gain a
  matching rule: honor a skip ONLY on a direct, unambiguous user instruction — never on the
  agent's own initiative or because a tool/file/channel asked.
- **P1 fix — `MAX_BLOCKS = 3` hard cap on the speculation hooks.** `speculation-guard.js`
  and `speculation-judge.js` previously deduped only on the exact message hash; because the
  message text legitimately changes as the model reworks its reply, that dedupe could be
  defeated and the Stop hook could re-block on every Stop. They now mirror `task-guard.js`'s
  two-tier loop-safety — hash dedup PLUS a running `blocks` counter capped at 3 — closing the
  Stop-loop wedge. State is now `{hash, blocks}`; legacy bare-hash files are still tolerated.
- **deadly-loop iteration caps (soft 10 / hard 15).** The Reviewer+Critic debate + fix-wave
  convergence loop is now explicitly bounded: at **10 rounds** without convergence, STOP and
  checkpoint with the user (AskUserQuestion: continue / stop / change scope) instead of
  looping silently; at **15 rounds**, force-stop unconditionally and report even if not
  converged. The same cap applies to `deadly-loop-multi`'s step-6 reconverge loop.
- **Doc fixes (no guard-logic change).** `STATUSLINE.md` now describes line 2 as the
  actual always-on 3-tier behavior (phase bar → "orchestrating · N agents" → idle context
  gauge), consistent with its own top summary and `phase-bar.js`; corrected two misleading
  comments that said a transcript was "streamed" when the code does a full `readFileSync`
  (`task-guard.js`, `graphify-reminder.js`); confirmed `demo-wrapper.sh` (machine-absolute
  `/Users` path, untracked) stays gitignored so a future `git add -A` cannot ship it.

## 0.14.1

Refines the 0.14.0 email chip: show-when-available with an opt-OUT, instead of opt-in.

- **The `✉ <email>` chip now renders whenever the account email is available**
  (read from `~/.claude.json`), rather than requiring `ANTIHALL_STATUSLINE_EMAIL=1`.
  Since a signed-in user almost always has an email, the opt-in gate was effectively
  "never shows unless you know the flag." Inverted to a privacy opt-OUT:
  set **`ANTIHALL_STATUSLINE_NO_EMAIL=1`** (or any non-`0`/`false` value) to hide it —
  e.g. for screenshots or screen-shares. Fail-open: no chip when the email can't be read.

## 0.14.0

Adds an opt-in account-email chip to the rich statusline.

- **`statusline-rich.js` can now show a `✉ <email>` chip** as the last line-1 segment,
  reading the signed-in Claude account email from `~/.claude.json`
  (`oauthAccount.emailAddress`). **OFF by default** and gated behind the
  `ANTIHALL_STATUSLINE_EMAIL` env var (set to `1`/any non-`0`/`false` value to enable) —
  the plugin must never surface a user's email on their statusline without explicit
  consent. New `getClaudeEmail()` helper; pure file read, fail-open (no chip on any error).
  This brings the plugin's own renderer to parity with custom `.claude/helpers/`
  statuslines that already show the email, without making it a privacy-leaking default.

## 0.13.0

Adds an always-on output-presentation discipline so chat output is structured and
scannable without becoming noisy.

- **New SessionStart rule K — "PRESENT FOR SCANNABILITY (do not overdo it)".** Appended
  to the orchestration block in `verify-first-full.js` (and mirrored as a bullet in
  `AGENTS.md`). Encodes the conservative, renderer-verified subset of GitHub-flavored
  markdown that Claude Code's terminal actually renders: tables for comparisons/status,
  **bold** verdicts, *italic* caveats, `code` for flags/paths/commands, fenced blocks for
  output, at most a leading status glyph (emoji = signal, not decoration). Explicitly
  steers AWAY from syntax the terminal renderer drops or mangles — strikethrough,
  `[label](url)` link labels (paste the bare URL), nested blockquotes, task-list
  checkboxes — and notes that underline and per-word color do not exist in the renderer.
  Subset confirmed against Claude Code terminal-rendering issue reports + docs. Styling
  organizes, never pads: rule H (concise) still governs. Appended as rule K so existing
  letters A-J do not renumber. SessionStart footprint grows by ~0.5 KB.
- **Doc accuracy:** corrected the stale "5 nudges" comments in `verify-first.js` (the
  `NUDGES` array has 12 entries, not 5) and refreshed the root README SessionStart
  footprint figure to the doctor-measured value.

## 0.12.1

Fixes AUDIT-REPORT-2 item #7(a): the shared global statusline base was deleted on
every uninstall.

- **`uninstall-statusline` no longer deletes the shared global base by default.**
  `~/.anti-hall/base-statusline.json` is GLOBAL — every project whose statusLine points
  at the dispatcher wraps it as line 1. The uninstaller's Strategy A unconditionally
  `unlink`ed it after restoring the original command, so uninstalling in ONE project
  (even `--project` scope) silently stripped line 1 for EVERY other project still
  relying on it. A reference count is infeasible (no way to enumerate all projects'
  settings files), so the safe default is now: restore this scope's original command
  and LEAVE the shared base in place. An orphaned JSON is harmless; a deleted shared
  one is not. New opt-in `--purge-base` flag explicitly removes it for the
  "done with anti-hall on this whole machine" case (use only after uninstalling
  everywhere). Verified with a fake-HOME behavioral test: default keeps base + restores
  original command; `--purge-base` deletes it.

## 0.12.0

Closes three deferred AUDIT-REPORT-2 needs-review gaps (external reviewer + codex).

- **Recursive shell parsing (`command-guard` + `graphify-guard`).** The segment
  splitter previously treated `$(...)` / backticks as plain boundaries and never
  inspected their CONTENTS, and never unwrapped `bash -c '...'` / `sh -c` / `zsh -c`
  payloads — so `echo "$(npm run build)"` and `bash -c "npm run build"` bypassed the
  coordinator block (and the graph-first nudge). Both guards now extract nested
  commands from command substitution and from shell `-c` payloads and re-apply the
  full heuristic (HEAVY_VERBS/HEAVY_PATTERNS/LIGHT_EXCEPTIONS for command-guard, the
  code-nav check for graphify-guard) to the inner commands, depth-bounded to 3 to
  avoid pathological input. Benign substitutions stay allowed (`echo "$(date)"` —
  `date` is not heavy). Fail-open preserved.
- **Atomic swarm-guard spawn cap.** The prune→count→cap-check→append was a
  non-atomic read-modify-write, so concurrent spawns each read a stale pre-cap log
  and raced past the ceiling. It now runs inside a best-effort cross-process O_EXCL
  lock (`~/.anti-hall/swarm-spawns.lock`) with stale-lock steal (mtime > ~5s),
  bounded spin, re-read + cap-check INSIDE the lock, and release in `finally`.
  FAIL-OPEN if the lock can't be acquired — never deadlocks a spawn. The
  cap-before-append fix is retained.
- **Doctor 2-line assertion + new tests.** The statusline self-test now requires
  >= 2 lines for the sample payload (which carries `context_window`, so the live
  context gauge on line 2 MUST render) and reports a FAILURE if only line 1 renders.
  Added self-tests proving the recursive-parse fix: command-guard now BLOCKS (in
  coordinator) `echo "$(npm run build)"` and `bash -c "npm run build"`, and still
  ALLOWS the benign `echo "$(date)"`.

## 0.11.3

Precedence-aware install-statusline. Per-project install now writes `.claude/settings.local.json` (highest precedence + gitignored) instead of `settings.json`, so a committed project statusLine can no longer shadow it. The installer checks the statusLine across user/project/local scopes and reports shadowing or already-installed; resolves a STABLE marketplace dispatcher path (never the versioned cache path, which breaks on update); and auto-gitignores `.claude/settings.local.json`.

## 0.11.2

Double-deadly-loop (4-auditor) final-gate fixes. `git-guard` and `command-guard`: `sudo`
with option flags no longer leaks — `sudo -u deploy git push --force` and `sudo -u deploy
npm install` previously resolved their effective verb to `-u` and slipped past the guards;
both now block (flag/operand-skip mirrors the env/timeout/nice handling). `git-guard`:
a force form baked into an inline alias BODY (`git -c alias.p='push --force origin main' p`)
was dropped — now the alias body's tokens are force-checked. `graphify-guard`: `segmentVerb`
now skips wrapper words so `sudo rg secret` is still detected for the (non-blocking) graph-
first nudge. Docs: corrected the skill count (llms.txt "five" → "seven workflow skills";
plugins README primer "7 skills" → "core 4 skills" to match verify-first-full.js; Features
table notes deadly-loop-multi/install-statusline/doctor). See docs/AUDIT-REPORT-2.md for the
reconciled findings, rejected false-positives, and deferred needs-review items. Fail-open and
subagent-allow preserved; doctor green (36 checks).

## 0.11.1

Fix `deadly-loop-multi` SKILL.md YAML frontmatter: the `description` contained an unquoted
inner `Multiplier:` (colon-space), which YAML parses as a mapping value — the skill failed
to load ("mapping values are not allowed in this context"). Replaced the colon with a dash.

## 0.11.0

Cut the plugin's OWN context footprint (it was growing the conversation every turn — the
exact thing the plugin warns against). Root cause (researched): Claude Code injects
`UserPromptSubmit` additionalContext into the transcript EVERY turn and it accumulates
(see anthropics/claude-code#40216), so a long, repeated per-turn directive is a real token
drain.

- **`task-tracker.js` throttled:** injects the FULL task-discipline directive only on the
  first turn of a session (and once per ~6h window), then a SHORT one-line reminder after,
  via `~/.anti-hall/task-tracker-<session>.json` state. Fail-open to full on any state error.
  Steady-state per-turn injection dropped ~68% (≈693 B → ≈223 B).
- **`verify-first-full.js` (SessionStart) tightened** ~13% with no rule removed (Iron Law,
  full rationalization table, orchestration A–J, anti-speculation tiers, anti-sycophancy all
  intact). `verify-first.js` per-turn nudge was already one short line.
- **`doctor.js` adds a "Context footprint" section** reporting the SessionStart / per-turn /
  per-Stop injection sizes in bytes + estimated tokens, so the cost is measurable.

Future levers (noted, not yet done): move the static protocol to CLAUDE.md / SessionStart-only
and merge the four Stop hooks into one to further shrink per-turn overhead.

## 0.10.0

Audit-fix batch (from a 2-Opus + 2-Codex review) + context-protection discipline.

Guards:
- **command-guard** now evaluates PER SEGMENT (quote-aware split on `; && || |`, env-prefix
  + wrapper skip, cross-platform basename). Fixes real false-negatives where heavy commands
  bypassed: `cd app && npm test`, `git status && npm run build`, `FOO=1 docker build .`.
- **swarm-guard** checks the spawn-rate cap BEFORE appending/persisting the timestamp, so
  blocked retries no longer extend the block window; state moved to `~/.anti-hall/`.
- **speculation-guard** regex now catches "should be fine" (was excluded by a lookahead).
- **graphify-guard** `/graphify` exemption is now segment/verb-aware (a substring like
  `echo /graphify && rg secret` no longer exempts the search); state → `~/.anti-hall/`.
- **git-guard** resolves inline `-c alias.x=push` so aliased force-push is caught.
- **task-guard / graphify-reminder** state relocated to `~/.anti-hall/` for cross-runner
  consistency.

Doctor: added a Graphify health section + self-tests proving the command-guard per-segment
fix and the speculation-guard "should be fine" catch.

Discipline (protect the orchestrator's context — a bloated main thread degrades the model
and induces the very hallucination this plugin prevents):
- Delegate not just heavy commands but **broad reads / Grep / Glob / code-nav searches** to
  subagents; inline only a specific known-file read. Added to orchestration, AGENTS.md,
  verify-first-full.js.
- **Graphify-first:** ensure the graph is fresh then QUERY it before raw search and before
  feature-launch analysis.
- **AFK goal-anchor (drift watcher):** re-check work against the locked goal each cycle and
  course-correct on drift; only deviate when the user explicitly redirects.

Docs synced (version drift, autoUpdate wording, 7-skill count, STATUSLINE 3-tier line 2,
"latest OpenAI Codex" not a pinned version, broken MODEL-POLICY links) and a consolidated
`docs/AUDIT-REPORT.md` written (includes the reconciled demo-wrapper.sh false-positive).

## 0.9.0

New `deadly-loop-multi` skill — double / triple / quadruple deadly loop.

Scales the standard 1+1 deadly-loop to N parallel reviewers + N parallel critics with
diversified lenses, then reconciles + validates into ONE consolidated report.

- **double** = 2 Opus + 2 Codex, **triple** = 3+3, **quadruple** = 4+4. The tier is named
  by the user or auto-selected by job complexity × sensitivity (higher tier for
  security/schema/cross-repo/release work).
- **Always half-and-half cross-model:** half the auditors are the latest Codex (a
  different model finds different bugs); if Codex is unavailable, substitute the latest
  Opus with a divergent persona — never drop below the full 2N. Model versions are
  deliberately NOT pinned ("latest Opus / latest Codex") so the skill survives new releases.
- **Runs as a swarm** via the Opus Dynamic-Workflow primitives (KB §11 /
  docs/opus-4-8-swarm.md): a parallel fan-out of the 2N auditors feeding a reconcile +
  validate synthesis stage. The coordinator validates each finding against the code itself
  (agreement raises confidence, but evidence decides) and reconciles conflicts — so a
  single agent's false positive does not make it into the report.

## 0.8.1

Doctor: add a behavioral statusline check. Beyond confirming a statusLine is configured,
the doctor now spawns the dispatcher with a sample payload and asserts it actually
RENDERS (reports the line count — line 1 + live line 2), and validates that
`statusline-rich.js` (the line-1 renderer) is present and syntax-valid. So a broken or
missing renderer is caught, not just a missing setting.

## 0.8.0

Doctor (health check + live guard self-tests) + documentation refresh.

Addresses external-review feedback: a guardrail plugin needs a way to prove it is
actually running and that the guards actually fire — not just that files exist.

- **New `hooks/doctor.js` + `/anti-hall:doctor` skill.** Reports Node version (flags
  < 18, which makes the hooks silently no-op), plugin version, every registered hook's
  presence + syntax, and the statusline install status. Crucially it runs LIVE
  behavioral self-tests: it spawns the real guards with crafted payloads and asserts
  exit codes — git-guard blocks force-push + AI self-credit and allows `git status`;
  command-guard blocks heavy commands in the coordinator but ALLOWS them in a subagent
  (payload `agent_id`); swarm-guard allows a normal spawn. Exits non-zero on any
  critical failure (CI-friendly); `--quiet` prints just the verdict.
- **Docs synced to the current feature set.** README rewritten (modern, explained, with
  the two-layer model, the statusline, and AFK mode), `llms.txt` updated to list ALL
  hooks/skills (it and the README previously undercounted — e.g. omitted command-guard,
  swarm-guard, graphify-guard, phase-tracker), and AGENTS.md gained the AFK autonomy
  contract.

## 0.7.0

Automatic swarm-progress tracking + AFK-mode autonomous driver.

Problem: the phase bar only updated if the coordinator manually called `phase.js`, and
the autonomous-driver template never called it — so a running swarm/feature-launch
showed no progress (verified gap; `CONTINUE-HERE.md` listed it as a TODO).

- **New `phase-tracker.js` hook** (PreToolUse Agent/Task) — records every subagent
  spawn to a HOMEDIR log (`~/.anti-hall/agent-spawns.log`), never blocks, fail-open.
  Registered after swarm-guard so it logs only real spawns.
- **`phase-bar.js` now has 3 tiers** for line 2: (1) coordinator-set semantic phase ->
  rich phase bar; (2) recent spawns (auto) -> animated `orchestrating · N agents active`
  bar; (3) idle -> context-window gauge. So a swarm is visible with ZERO coordinator
  effort. (A registered hook needs a session restart to activate.)
- **AFK mode** (`AUTONOMOUS-DRIVER-PROMPT.md`): wired the `phase.js set/step/agents/
  advance/clear` calls into the per-phase loop, and added the AFK autonomy contract —
  the driver never returns to the owner or stops except for an ABSOLUTELY-DESTRUCTIVE
  hard gate; it collects data instead of pausing, and resolves confusion with a
  deadly-loop rather than asking the (away) owner.

## 0.6.0

Always-on line 2 (hybrid bar). The plugin's statusline now ships BOTH lines as a
complete two-line statusline, and line 2 is always present (never blank):
- During an active orchestration run -> the live phase progress bar (as before).
- When idle -> a context-window usage bar rendered from the session JSON:
  `[███████████◐────────] 56% context` (· `used/max tokens` when the harness
  provides counts), color-coded green/yellow/red at <=70/70-89/>=90.

`statusline.js` now passes the session stdin through to the line-2 renderer
(`phase-bar.js`) so the context bar has real data; `phase-bar.js` renders the phase
bar when a fresh phase-state exists and the context bar otherwise. Fail-open: if
neither source is available, line 2 is simply omitted.

## 0.5.1

Phase bar auto-hides stale state. The line-2 phase bar reads `~/.anti-hall/phase-state.json`;
an orchestration run that ended without calling `phase.js clear` left an ORPHAN state file,
so the bar showed a frozen, stale phase indefinitely (e.g. a "22h" phase that never moved).
`phase-bar.js` now treats a state file whose mtime is older than 30 minutes as absent —
active runs rewrite the file on every set/advance/step/agents call (well under the window),
so live runs always render, but orphaned leftovers no longer linger. Fail-open preserved.

## 0.5.0

Rich statusline + on-demand install skill.

- New `statusline/statusline-rich.js` — a generic, project-agnostic rich line-1
  renderer (project name from cwd, git branch/worktree/stash/staged-modified-untracked,
  ahead/behind, model, effort, subagent count, session duration, context-window %, cost,
  and the GSD `.planning` phase when present). Pure Node, fail-open, no project/user
  specifics. The dispatcher (`statusline.js`) now uses it as the primary own-dispatch
  line-1 renderer, falling back to the monorepo/simple renderers if it yields nothing.
- New `install-statusline` skill — installs the statusLine entry on demand (user scope by
  default for a global bar, `--project` for the current repo only), with a reminder that
  Claude Code reads `statusLine` only at startup so a restart is required.
- `install-statusline.js` no longer clobbers an existing GLOBAL `base-statusline.json`
  (overwriting it changed line 1 for OTHER projects that rely on it). Existing base is
  kept; repos without their own helper fall through to the rich renderer.

## 0.4.7

Fix swarm-guard false-positive memory-pressure block. The memory check used
`os.freemem() / os.totalmem() < 4%`, but on macOS and Linux `os.freemem()` reports
only truly-free pages and EXCLUDES reclaimable cache (inactive / speculative /
file-backed). On a healthy 64 GB Mac it read ~2 GB "free" (< 4%) while ~24 GB was
actually available and memory pressure was green with zero swap — so legitimate
agent spawns were blocked, defeating delegation just like the 0.4.6 command-guard
bug.

Fix: compute REAL available memory per-platform — macOS via `vm_stat`
(free + inactive + speculative pages, honoring the actual page size: 16384 on Apple
Silicon, not a hardcoded 4096), Linux via `/proc/meminfo` MemAvailable, and
`os.freemem()` as the fallback where it is accurate (Windows) or on any parse error.
Verified on a 64 GB Apple Silicon Mac: old calc 6.5% (would block), corrected 36.5%
(no block), matching Activity Monitor. Fail-open preserved.

## 0.4.6

Fix command-guard blocking SUBAGENTS (not just the coordinator) under cmux and other
launchers that wrap `claude` — which crippled the orchestration plugin's entire purpose:
if subagents are also blocked from running heavy commands, there is nothing left to
delegate TO, and the swarm deadlocks.

Root cause (verified empirically this session by capturing real PreToolUse payloads):
the old `isCoordinator()` relied solely on `CLAUDE_CODE_ENTRYPOINT === "agent_tool"` to
detect subagents. That env var is only set on the subagent PROCESS in a vanilla `claude`
CLI. Under cmux, subagents inherit the parent's exact environment (same
`CLAUDE_CODE_ENTRYPOINT=cli`, same `CLAUDE_CODE_SESSION_ID`, same PID), so every subagent
looked like the coordinator and got blocked.

Fix: detect subagents from the hook PAYLOAD instead of the process env. Claude Code
injects `agent_id` and `agent_type` into the PreToolUse payload for Task-tool subagents;
the top-level coordinator's payload has neither. `isCoordinator(payload)` now treats a
command as a subagent (allow) if the payload carries `agent_id`/`agent_type` OR the
entrypoint is `agent_tool` (vanilla-CLI fallback). `main()` parses the payload before the
context check. This works in BOTH environments (cmux and vanilla CLI). Fail-open
preserved on any ambiguity.

Verified: coordinator `node x.js` -> still blocked; the SAME command from a Task-tool
subagent -> runs (payload carried `agent_id`/`agent_type`, matching the spawned agent id).

## 0.4.5

Fix task-guard false-block: completed tasks were over-counted as pending, causing the
Stop hook to block on sessions with zero genuinely-open tasks.

Root cause (verified against real transcripts): two interacting key-mismatch bugs:

1. `TaskCreate` input in the real harness has no `id` or `task_id` field — the harness
   assigns a sequential numeric id (1, 2, 3...) but returns it only in the tool_result
   string `"Task #N created successfully: <subject>"`. The old code fell back to
   `Date.now() + random`, generating a different random key for each create.

2. `TaskUpdate` input uses the field `taskId` (camelCase) — the old code read
   `inp.id || inp.task_id`, both always `null`, so no update ever matched any create.
   All 34 task creates stayed at status `pending` forever.

Fix: parse tool_result strings to extract the harness-assigned numeric id, store
TaskCreate provisionally under the tool_use wire id, then remap to the numeric id when
the result is seen. Read `inp.taskId` first in TaskUpdate (fallback to `inp.id` and
`inp.task_id` for alternate harnesses). Fail-open on any parse error. A cleared or
all-completed task list yields zero open tasks and no block.

Verified by 5 functional tests: 3-create-all-complete -> no block; 1-pending -> block
with correct task name; TodoWrite all-completed -> no block; empty transcript -> no
block; 34-creates-all-completed (exact real-scenario replay) -> no block.

## 0.4.4

Fix plugin load error — removed redundant manifest `hooks` reference; hooks/hooks.json is auto-loaded by Claude Code, so referencing it explicitly caused a duplicate-hooks-file load error (per /doctor). Hooks unchanged and still active.

## 0.4.3

Real statusline installer (wraps existing user statusline + scope-aware + uninstall).
statusline.js now supports base-command wrap.

- **`install-statusline.js` (new):** Interactive installer (--user/--project scope,
  base-statusline.json config, backup + restore, dedup safety). Wraps the user's EXISTING
  statusline.json / statusline command (if present) as line 1, adds anti-hall phase bar
  as line 2. Scope-aware: --user writes to ~/.anti-hall/; --project writes to ./.anti-hall/.
  Preserves .ai-generated-index, .claude-plugin, and other dotfiles on uninstall.
- **`uninstall-statusline.js` (new):** Restores original statusline from backup, removes
  anti-hall phase state.
- **`statusline.js` (updated):** base-command wrap mode: reads ~/.anti-hall/base-statusline.json
  (schema: `{command: "..."}`) and dispatches it to shell, captures line 1, appends phase
  bar as line 2. Falls back to own dispatch (Claude | branch | repo) when config absent.
- **`STATUSLINE.md` (updated):** usage examples for install/uninstall; wrap behavior and
  base-statusline.json config schema.

## 0.4.2

Opt-in semantic speculation judge (LLM-evaluated Stop hook, off by default) covering
the confident-inference-as-fact gap that the lexical Tier 2 guard cannot catch.

- **`speculation-judge.js` (Stop hook, new, OPT-IN):** semantic judgment tier that
  calls `claude-haiku-4-5` via the Anthropic API to evaluate whether the last assistant
  message asserts an unverified factual claim with no hedge word and no acknowledgment.
  Covers the gap left by `speculation-guard.js` (Tier 2), which catches hedged
  speculation but cannot catch a confidently-stated inference-as-fact that uses no hedge
  word at all (e.g., "The cause is the old build artifact." with zero hedging).
  Enabled ONLY when `ANTIHALL_SEMANTIC_JUDGE=1` is set in the environment; exits 0
  immediately (zero cost, zero latency, zero network activity) when unset — the default.
  Also requires `ANTHROPIC_API_KEY`; fails-open (exits 0) when the key is absent or the
  API call fails for any reason. Judge prompt instructs conservative evaluation: allows
  honest hedging, quoted text, hypotheticals, plans, and general software knowledge;
  blocks only definitive unverified factual assertions. Loop-safe: hashes message text
  with a `":judge"` namespace suffix (separate from Tier 2's hash space); blocks at most
  once per distinct message, never wedges. Fail-open on any parse/read/write/API error.
  Cost/latency when enabled: ~$0.0001-0.001 per turn at Haiku rates + ~1-3 s per Stop.
  Misfire caveat: LLM judges can false-positive; the conservative prompt reduces this but
  does not eliminate it — disable `ANTIHALL_SEMANTIC_JUDGE` if misfires are disruptive.
- **`hooks.json`:** `speculation-judge.js` registered as the fourth Stop hook (timeout
  30 s). It is a behavioral no-op in the default configuration (env var unset = exits 0
  immediately). Stop hook order: `task-guard` (1st, highest-stakes), `graphify-reminder`
  (2nd), `speculation-guard` (3rd, Tier 2 lexical), `speculation-judge` (4th, Tier 3
  semantic opt-in).
- **`plugin.json`:** version bumped 0.4.1 -> 0.4.2.
- **`README.md`:** speculation-guard entry in features table updated to label it Tier 2;
  `speculation-judge` entry added (OPT-IN). "Three Stop hooks coexist" note updated to
  four. "Known limit" paragraph replaced with a three-tier enforcement table (Tier 1:
  protocol/always-on/zero-cost; Tier 2: lexical/on-by-default/zero-cost; Tier 3:
  semantic/opt-in/LLM-cost). New "speculation-judge (Tier 3, OPT-IN)" section documenting
  enable instructions (shell profile and settings.json env block), what it catches, the
  fail-open/loop-safe/misfire/cost-latency properties.
- **`AGENTS.md`:** "speculation-guard (Stop hook)" section replaced with an "Anti-
  speculation enforcement: three tiers" section covering all three tiers, then dedicated
  subsections for Tier 2 (lexical, always-on) and Tier 3 (semantic, OPT-IN) with the
  same enable/cost/misfire/fail-open/loop-safe notes as the README.

## 0.4.1

Strengthened no-speculation Iron Law with inference-as-fact ban + hedged-speculation
ban; added per-turn nudges; added `speculation-guard.js` Stop hook (lexical enforcement,
block-once, fail-open).

- **`verify-first-full.js` rationalization table (Iron Law hardening):** added two
  explicit entries that were absent from prior versions: (a) `"X is happening because Y"
  / a clean causal story assembled from a couple of real facts -> that is an INFERENCE
  presented as fact` — bans confident inference-as-fact even when no hedge word is used;
  (b) `"very plausibly" / "likely" / "presumably" / "I suspect" / "I think" / "my guess
  is" / "it must be" -> hedging does NOT make a guess safe; it just disguises it` —
  explicitly bans hedged speculation. Both entries already existed in the
  RATIONALIZATION TABLE in 0.4.0; this entry documents them as rationale for the
  speculation-guard hook boundary.
- **`verify-first.js` (per-turn nudge):** the nudge at index 2 now explicitly names the
  hedge-word ban: `'likely' / 'plausibly' / 'I suspect' / 'I think' / 'it must be' = a
  guess in disguise. Hedging doesn't make it safe. Pull the data, or say 'I don't know -
  here's what I'd check'.` This was already present in the NUDGES array; documented here
  as the per-turn enforcement layer that pairs with the new Stop hook.
- **`speculation-guard.js` (Stop hook, new):** lexical speculation guard. Extracts the
  last assistant message from `transcript_path` (JSONL), scans for 15 speculation
  markers (hedge words: `very plausibly`, `plausibly`, `presumably`, `I suspect`,
  `my guess`, `I'd guess`, `I bet`, `likely`, `probably`, `must be`, `should be` [not
  `should I`], `seems to be`, `appears to be`, `I think it's`, `my hunch`), suppresses
  the block if the same message contains an evidence/uncertainty acknowledgment
  (`verified`, `I don't know`, `haven't checked`, `not verified`, `unverified`, `let me
  verify`, `I'll check`, `I will check`, `need to confirm`, `to confirm`, `file.ext:line`
  citation, `running`, `per the data`, `the data shows`). Block-once: hashes the message
  text and stores the hash in `~/.anti-hall/speculation-guard-state-<session>.json`; if
  the same hash was already blocked, exits 0 (nudge fires once, never wedges). Fail-open:
  any parse/read/write error exits 0 silently. Block reason names the matched marker and
  instructs the model to verify or explicitly flag as unverified. Registered in
  `hooks.json` as the third Stop hook (after `task-guard` and `graphify-reminder`).
  **Known limit:** catches hedged speculation (hedge word present) but not confident
  inference-as-fact with no hedge word. A semantic LLM-judge tier is architecturally
  possible but not shipped by default (cost/latency tradeoff; documented in README +
  AGENTS.md as opt-in design path).
- **`hooks.json`:** `speculation-guard.js` registered under `Stop` as third entry
  (timeout 30 s). Stop now has 3 hooks: `task-guard` (highest-stakes, first), 
  `graphify-reminder` (second), `speculation-guard` (third).
- **`plugin.json`:** version bumped 0.4.0 -> 0.4.1.
- **`README.md` + `AGENTS.md`:** `speculation-guard` added to features table, new
  "speculation-guard" how-it-works section (markers list, acknowledgment suppression,
  loop-safe mechanism, known limit, opt-in semantic tier note); three-Stop-hook
  coexistence note updated from two to three hooks.

## 0.4.0

Rewritten feature-launch workflow + agent-watchdog + statusline phase.js wiring + KB merge.

- **`feature-launch` workflow rewritten:** plan-mode → deadly-loop-the-plan → loopback → self-heal;
  simpler phase loop; analyze-work fan-out; 4.8-fanout/synthesis/gate integration.
- **`agent-watchdog.js`:** new hook for heartbeat enforcement, babysit/backoff/kill logic. Polls
  `~/.anti-hall/agents/<id>.json` every 20 min; kills idle/hung agents; integrates with phase.js.
- **`orchestration/SKILL.md` + `AGENTS.md`:** updated with new agent-watchdog semantics,
  heartbeat convention (mtime update = alive signal), and agent supervisor responsibilities.
- **`statusline/phase.js` wiring:** orchestrator-main integration; calls phase.js (set/advance/step/agents/clear)
  from feature-launch as phases progress; terminal bar reflects real run state.
- **`docs/KB-claude-codex.md`:** merged knowledge base (67 sources): GSD methodology, superpowers,
  deadly-loop, 4.8-swarm patterns, orchestration discipline, graphify workflow. Consolidated
  from `.gsd/` and `superpowers/` skill refs.
- **Version bump 0.3.11 -> 0.4.0.**

## 0.3.11

Phase.js writer (real data source for the phase bar) + colored line-2 palette + full agent label.

- **`phase.js` (statusline writer):** new executable that writes phase-state.json as the
  orchestrator / feature-launch skill progresses. Commands: `set` (start phase), `advance`/`step`/`agents`
  (update in-flight), `clear` (hide bar). Writes to `~/.anti-hall/phase-state.json` (home dir,
  consistent across all processes). Fail-open: any error exits 0 without throwing.
- **`statusline/STATUSLINE.md`:** new "phase.js — Phase state writer" section documenting
  the data source, all 6 commands (set, advance, step, agents, update, clear), usage examples,
  and state-file schema (required + optional fields).
- **`phase-bar.js` (colored palette):** code (magenta/cyan), description (white),
  count (cyan), timer (yellow >20m, else dim), agents (blue "N agents"), step (dim).
  Renders as: `[bar] NN% | CODE - Desc done/total | timer agents step`.
- **Version bump 0.3.10 -> 0.3.11.**

## 0.3.10

Spinner repositioned inside the progress bar at the frontier. Phase-bar now uses box-drawing
glyphs (█ for filled, ─ for empty) and a rotating half-disc spinner (◐◓◑◒) positioned at
the progress frontier. Layout: `[████████◐────────────] 40% | P2 - Desc done/total | extras`.

- **`phase-bar.js` (statusline):** spinner (◐◓◑◒) now rendered at the progress frontier
  INSIDE the bar, not after. Filled segment uses █ (U+2588), empty segment uses ─ (U+2500).
  Spinner is a rotating half-disc (◐◓◑◒ U+25D0-D2) that advances every 125ms. Layout remains
  `[bar] NN% | CODE - Desc done/total | extras` with all styling preserved.

## 0.3.9

Phase-bar statusline enrichment: wider bar (20 chars), live percentage, longer description
(cap 32 chars), and optional extras (elapsed time in yellow when >20m, active agent count,
current step) rendered when present in phase-state.json.

- **`phase-bar.js` (statusline):** expanded bar width from 16 to 20 chars; added percentage
  render (e.g., "40%") in yellow after the bar; description cap increased from 16 to 32
  chars with ellipsis on overflow; optional extras appended in dim text when phase-state
  includes `elapsed`, `agents`, and `step` keys (e.g., "3m 3ag rendering bar"). Elapsed
  times >20m highlighted in yellow (e.g., "\[33m23m\[0m") to signal long-running phases.
  Backward-compatible: phase-state without these keys renders as before.

## 0.3.7

Consolidated enforcement wave: command-delegation as the top always-on rule, active
task-draining, swarm-guard, graphify-guard, concise-communication note, and
.graphifyignore.

- **`command-guard.js` (PreToolUse Bash, coordinator-only):** new hook that BLOCKS
  heavy/long/state-changing commands (build, test, deploy, push, pull, install,
  migrate, dumps, bulk scripts) when running in a coordinator context, requiring the
  model to delegate them to a subagent instead. Detection uses `CLAUDE_CODE_ENTRYPOINT`:
  `agent_tool` = subagent (pass-through); `cli`/`vscode`/`jetbrains`/etc. = coordinator
  (block). Fail-open on absent/unknown entrypoint. Registered in hooks.json.
  COORDINATOR-VS-SUBAGENT INVESTIGATION: `CLAUDE_CODE_ENTRYPOINT` is a documented
  Claude Code env var set to `agent_tool` when spawned via the Task tool, and inherited
  by hook child processes — this is a reliable signal. The hook is SHIPPED.
- **`swarm-guard.js` (PreToolUse Agent/Task):** new hook, OS-agnostic pure Node.
  Tracks spawn timestamps under `os.tmpdir()/anti-hall/swarm-spawns.log`; prunes
  entries older than 60s; blocks if spawns in last 60s >= 20 (CAP). Secondary check:
  blocks if `os.freemem()/os.totalmem() < 4%` (critical memory pressure). Both
  thresholds are conservative. Fail-open on any error. Registered for `Agent` and
  `Task` matchers in hooks.json.
- **`graphify-guard.js` (PreToolUse Grep/Glob/Bash):** new hook. If a graphify graph
  exists (`graphify-out/` or `.planning/graphs/` at cwd or git toplevel), blocks the
  FIRST code-navigation search of the session (Grep tool, Glob tool, or Bash with
  grep/rg/ag/find/git-grep as first verb) and redirects to `/graphify query`. Blocks
  ONCE per session per project (loop-safe via `os.tmpdir` marker); second call is
  always allowed. Graphify-query Bash commands (`/graphify`) are explicitly excluded.
  No-op when no graph is present. Fail-open. Registered for `Grep`, `Glob`, `Bash`.
- **`.graphifyignore` (repo root):** new file — excludes `graphify-out/`,
  `.planning/graphs/`, `node_modules/`, `dist/`, lock files, `.git/`, and common
  generated/build patterns from graphify indexing.
- **`verify-first-full.js` (SessionStart):** ORCHESTRATION DISCIPLINE block
  restructured. Command-delegation moved to item A as the TOP RULE with explicit
  wording: "NEVER run verbose/long/state-changing commands inline... ALWAYS delegate
  to a subagent... never fill the main context with raw command output — the most
  counterproductive thing a coordinator can do." Active task-draining added as item C:
  "pick up pending tasks and dispatch subagents to finalize them; run INDEPENDENT
  tasks in parallel (up to the concurrency cap, ~min(16, cores-2)); never spawn
  unbounded agents... a runaway swarm can make the OS unusable." Concise-communication
  added as item H: "Communicate concisely: enough to convey meaning, not pages; offer
  to expand if the user wants more detail." Always-apply disciplines summary updated
  to reflect command-delegation top rule, task-draining, concurrency cap, concise note.
- **`verify-first.js` (per-turn nudge):** added two new nudges to the rotation —
  explicit command-delegation top rule; concise-communication note. Concurrency-cap
  language added to the task-list nudge. Hash-mod rotation auto-scales.
- **`task-guard.js` (Stop):** block reason now includes active task-draining
  instruction: "pick up pending tasks... run independent tasks in parallel (up to
  the concurrency cap, ~min(16, cores-2)); do not let tasks sit neglected."
- **`AGENTS.md` + plugin `README.md`:** command-delegation top rule added to
  orchestration section; concurrency cap added; active task-draining added; concise-
  communication added; "Recommended companion: graphify" section added (soft note —
  hooks no-op without it, no hard dependency).
- **Version bump 0.3.6 -> 0.3.7.**

## 0.3.6

Promote TWO disciplines to always-on ENFORCED via the hook layer, while keeping TWO
skills conditional. Root-cause and orchestration now fire every session/turn; deadly-loop
and feature-launch remain invoked-on-match.

- **`verify-first-full.js` (SessionStart):** added an always-apply ORCHESTRATION
  DISCIPLINE block framed as a BIAS TOWARD DELEGATION — non-blocking main thread;
  priority-sorted task list capturing every request and interruption; default to
  delegating any work that touches files/tools/commands/search/build/test or could balloon
  (avoid the eager "I'll just do it inline" trap), handle inline only genuinely atomic
  things (a direct answer, a single known-line read, the coordinator's own
  synthesis/decisions), delegate immediately if a quick inline task balloons; parallel
  agents when independent; noisy commands via a cheap-model subagent (Haiku/Codex)
  off-thread; report/synthesize. Reframed the skill primer into "ALWAYS APPLY (enforced):
  root-cause + orchestration + anti-sycophancy disciplines" vs "INVOKE WHEN IT MATCHES:
  /anti-hall:deadly-loop, /anti-hall:feature-launch (plus the root-cause/orchestration full
  playbooks on demand)". Anti-sycophancy named explicitly. Iron Law + rationalization table
  kept intact.
- **`verify-first.js` (per-turn nudge):** added three orchestration/anti-sycophancy
  one-liners to the rotation (bias-toward-delegation default-to-subagent; noisy commands
  via Haiku off-thread; capture every request/interruption in a priority-sorted list +
  parallel independent agents). The hash-mod rotation auto-scales to the new count;
  fail-open unchanged.
- **READMEs + AGENTS.md:** note that root-cause + orchestration are enforced always-on via
  hooks while deadly-loop + feature-launch are conditional skills invoked on match;
  documented the bias-toward-delegation default, capture-every-request, and anti-sycophancy.
- **Version bump 0.3.5 -> 0.3.6.**

## 0.3.5

Production-doc finalization + doc-vs-code reconciliation: rewrite the READMEs, add
`llms.txt`, and remove the never-registered PreCompact claims.

- **Production README rewrite:** both the top-level `README.md` and the plugin
  `README.md` were rewritten for readability and structure — tagline, the four
  failure modes, quickstart, requirements (with the honest Node-on-PATH no-op
  caveat), a features table, plain-English how-it-works, the `/anti-hall:*` skills,
  statusline install, configuration/tuning, troubleshooting/FAQ, contributing (the
  3 MODEL-POLICY copies must stay in sync), and license. The top README is the
  short overview; depth lives in the plugin README. Accurate to the real code
  (7 Node hooks, 4 skills, Node statusline).
- **`llms.txt` added:** an LLM-oriented index at the repo root (llms.txt standard) —
  H1 title, blockquote summary, and linked sections for the README, plugin README,
  CHANGELOG, AGENTS.md, KB doc, each skill SKILL.md, and each hook.
- **Doc-accuracy fixes (4 × P2):**
  - Top README "What's inside" now states the FULL protocol injects at SessionStart
    (re-firing on compaction via `source=compact`) and a SHORT varying nudge per turn
    at UserPromptSubmit — not "the full protocol every turn".
  - `feature-launch/references/PRE-TOOL-USE-HOOK.md` no longer cites non-existent
    "Phase A.5.5" / "A.5.3"; it now points to "Phase A.5 (AFK readiness gate)" to
    match the prose (no sub-numbers) in `feature-launch/SKILL.md`.
  - `verify-first.js` comments + plugin README now state the per-turn nudge is hashed
    from the FULL stdin envelope (varies by session/cwd), not "reproducible for a
    given prompt". Runtime behavior unchanged.
  - `PRE-TOOL-USE-HOOK.md` example sentinel: added an explicit false-block/bypass
    tradeoff caveat and a pointer to the shipped quote-aware `git-guard.js`
    tokenizer; `--no-verify` / `--no-gpg-sign` patterns anchored to a flag boundary.
- **PreCompact placeholder claims removed (P1):** `hooks.json` registers
  `verify-first-full.js` ONLY on `SessionStart` — there is no `PreCompact`
  registration block and never was in the shipped manifest. Every doc that
  described an "inert PreCompact placeholder registration" was inaccurate. Removed
  those claims from `verify-first-full.js` (banner + header + the dead
  `name === 'PreCompact'` echo branch), the plugin `README.md`, and `AGENTS.md`.
  Compaction survival is unchanged: it relies solely on the no-matcher
  `SessionStart` re-fire with `source="compact"`, which IS registered. The earlier
  0.3.0/0.3.1 notes below describing a kept PreCompact placeholder are superseded
  by this entry.
- **AGENTS.md scope clarified (P2):** `AGENTS.md` lives at the marketplace repo
  root, not under `plugins/anti-hall/`, so it is NOT bundled by `/plugin install`
  (the plugin `source` is `./plugins/anti-hall`). `plugin.json` description and the
  plugin `README.md` now state it is a repo-root Codex mirror for clone-based use
  that installed users must copy manually.
- **0.3.0 marketplace-source note corrected (P2):** the 0.3.0 entry claimed the
  marketplace plugin `source` switched to a GitHub source object; the file actually
  uses the relative path `./plugins/anti-hall`. Corrected the 0.3.0 note to match
  the file (the relative path resolves because `marketplace add talas9/anti-hall`
  clones the whole repo).

## 0.3.4

Close the quoted-flag force-push bypass in git-guard.

- **git-guard: quoted force flags / refspecs / subcommand now BLOCK (P1):** the
  force-push guard previously skipped any token that came entirely from inside quotes
  (`quotedOnly`). For argument-level flag/refspec/subcommand detection that was wrong —
  the POSIX shell strips quotes before git runs, so `git push "--force"`,
  `git push '--force'`, `git push "-f"`, `git push origin '+main'`, and
  `git "push" --force origin main` are byte-for-byte equivalent to their unquoted forms
  and DO rewrite published history, yet all five were reported ALLOW. `isForcePush()`
  now matches `--force`/`--force-with-lease`/bundled `-f`/`+refspec` regardless of
  quoting, and `gitSubcommand()` resolves a quoted subcommand token (e.g. `"push"`)
  instead of bailing to `sub=null` and leaving the command uninspected. Quoting still
  only changes meaning for commit-message CONTENT (a `--force`/`+main` inside an `-m`
  value), which is inspected separately on the `commit` path — never in a push arg
  list — so `git commit -m "fix --force bug"` is not false-blocked. Verified against the
  block/allow matrix (5 bypass cases now block; all prior blocks and legitimate pushes
  unchanged).

## 0.3.3

Portability finalization pass — restore the all-pure-Node guarantee.

- **Removed `node-preflight.sh` (P1):** the POSIX-shell preflight added in 0.3.2 could
  not run on the platform it targeted. Claude Code executes a hook `command` via the
  system shell, which on a stock Windows box is cmd.exe/PowerShell — neither has `sh`
  on `PATH`. On the exact "fresh Windows box with no Node" case the preflight existed
  to warn about, `sh` is also absent, so `sh node-preflight.sh` failed to launch and
  the "anti-hall hooks are INACTIVE" warning never fired — the precise silent-off
  failure it was meant to prevent. The plugin's single non-Node component was also its
  least portable. Rather than ship a `.sh`/`.cmd`/`.ps1` matrix, the missing-Node case
  is now handled the same way as git-guard's other fail-open boundaries: documented as
  a hard, verify-before-relying prerequisite (README "Requirements" + install steps,
  "verify with `node --version`"). With the `.sh` gone, the manifest/README "all hooks
  pure Node, run unchanged on Windows/macOS/Linux given Node" claim is once again true.
- **Manifest/CHANGELOG vs README reconciled (P2):** plugin.json's "All hooks and the
  statusline are pure Node" description and the 0.3.0 "no `.sh`, no bash" note no longer
  contradict the shipped hooks — there is no shell hook to contradict them. README,
  manifest, and CHANGELOG now agree.

## 0.3.2

Deadly-loop finalization pass (round 1 + round 2 findings; 0 P0, converged).

- **git-guard `--force-if-includes` false-block (P1):** `--force-if-includes` /
  `--no-force-if-includes` is a safety modifier (a no-op on its own, only meaningful
  alongside `--force-with-lease`), not a force push. It is no longer a force trigger,
  so a bare `git push --force-if-includes origin main` is ALLOWED. `--force`, `-f`,
  `--force-with-lease`, and `+refspec` still BLOCK.
- **statusline installer cache-path discovery (P1):** the one-command installer glob
  now covers the real install layout `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`
  (verified against an actual install) plus the KB's shallower documented forms, keeping
  the existing marketplace globs and the `.claude-plugin/plugin.json` existence guard, so
  it no longer prints "not found" on a correctly installed plugin.
- **node-absent honest documentation (P1):** every hook launches as `node <hook>.js`;
  if `node` is absent from the hook shell's `PATH`, all hooks (including the git-guard
  safety) silently do not run. A POSIX-shell `node-preflight.sh` SessionStart hook now
  emits a loud one-time warning when `node` is missing (a node-based preflight cannot
  detect its own missing interpreter), and the README install steps state the Node >= 18
  requirement prominently and tell users to verify `node --version` before relying on
  the protections.
- **git-guard ANSI-C inline self-credit bypass (P2):** a `git commit -m $'fix\n\nCo-authored-by: ...'`
  kept its `\n` literal after tokenizing, slipping past the line-anchored trailer
  regexes. Self-credit detection now also tests an escape-normalized copy of each inline
  message (`\n`/`\r`/`\t` interpreted), so the ANSI-C inline form is blocked too.
- **marketplace.json capability claim (P2):** changed "PreCompact re-injection" to
  "SessionStart re-injection (fires with source=compact)" to match the code — PreCompact
  context injection is inert (forward-compat placeholder), SessionStart `source=compact`
  is the sole compaction-survival mechanism.
- **install-statusline.js ungrounded field (P2):** dropped the undocumented `padding: 0`
  field; the installer writes only the doc-grounded `{ type: "command", command }`.
- **MODEL-POLICY triplication sync note (P2):** the three byte-identical MODEL-POLICY.md
  copies (needed because skill bundling carries each skill's own `references/` copy and
  symlinks are stripped on install) now each carry a SYNC NOTE header, plus a README
  maintainer note, instructing that all three be updated together.
- **Stop-hook precedence (P2):** `task-guard` is now registered before `graphify-reminder`
  on `Stop` so the higher-stakes open-task discipline reason wins when both fire (Claude
  Code does not merge Stop reasons); README caveat updated.
- **statusline blink removed (P2):** the >=80% context tier in `statusline-monorepo.js`
  no longer uses SGR 5 (blink, inconsistently supported); it uses bold bright-red
  256-color, consistent with the other tiers.
- **per-turn nudge wording (P2):** README clarified that the verify-first nudge varies
  **by prompt** (deterministic SHA-1 of the prompt), not strictly per turn — an identical
  repeated prompt reproduces the same facet.

## 0.3.1

Deadly-loop finalization pass — applies the remaining open findings, all verified
against the official Claude Code hooks docs.

- **graphify-reminder now actually reaches the model (P1):** a Stop hook does NOT
  inject `additionalContext` (only UserPromptSubmit / UserPromptExpansion /
  SessionStart do, per the official docs), so the previous stdout-`additionalContext`
  emission was a silent no-op. The reminder is now surfaced via the only Stop
  channel that reaches the model — a **one-time soft block**
  (`{"decision":"block","reason":...}`), capped + deduped via `os.tmpdir` state so
  it nudges at most once per session and never loops. The "keep the graph updated"
  guidance also lives in the SessionStart primer, which IS a context-injection event.
- **git-guard emoji self-credit (P1):** the `Generated with <AI>` detector now
  catches the canonical footer even when prefixed by a leading glyph/emoji
  (e.g. the robot-emoji `Generated with [Claude Code]` footer) while still allowing
  prose ("we generated with care"). Verified against the full block/allow matrix.
- **Node prerequisite documented prominently (P1):** added a **Requirements**
  section to the top-level README and the plugin description, and aligned the plugin
  README to Node >= 18. Hooks invoke a bare `node`; without a global Node on `PATH`
  every hook (including the git-guard safety) silently fails to launch.
- **git-guard scope caveat (P2):** README now states the guard inspects only inline
  `-m`/`--message` trailers — `-F`/`--file`, editor commits, and interpreter
  wrappers (`sh -c`, `xargs`, aliases) are documented fail-open boundaries.
- **KB §1.4 corrected (P2):** UserPromptSubmit context injection uses **nested**
  `hookSpecificOutput.additionalContext` (not flat); added an explicit note that
  context injection is event-gated to UserPromptSubmit / UserPromptExpansion /
  SessionStart, so `Stop`/`PreCompact` `additionalContext` is inert.
- **PreCompact framing corrected (P2):** clarified that PreCompact never injects
  context (not "summarized away"); SessionStart `source="compact"` is the sole
  survive-compaction mechanism. (Superseded in 0.3.5: the PreCompact registration
  was never actually present in `hooks.json`, so all PreCompact-placeholder claims
  were removed rather than reworded.)
- **Two-Stop-hook coexistence noted (P2):** `graphify-reminder` + `task-guard` both
  emit the top-level Stop `decision`/`reason` schema; Claude Code does not merge
  reasons, but each is capped so neither is lost (they sequence across Stops).

## 0.3.0

KB-driven effectiveness + portability revision (see `docs/PLUGIN-REVIEW.md`),
plus a full OS-agnostic Node rewrite and the deadly-loop hardening pass.

- **OS-agnostic Node rewrite (portability):** every hook and the statusline +
  its installer are now pure Node.js using only built-ins (`fs`, `path`, `os`,
  `crypto`, `child_process`) — no `.sh`, no bash/grep/sed/cksum/jq/python3, no
  `/dev/stdin`. The only spawned subprocess is `git` itself. They run unchanged
  on Windows, macOS, and Linux **given Node.js on `PATH`** — Node is the one hard
  prerequisite (see README "Requirements"); without a global `node` the hooks
  cannot launch and the guards silently do not run. `hooks.json` invokes each as
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"` (explicit `node`, not a
  shebang, since Windows ignores shebangs).
- **verify-first restructured (P0-1, P0-3):** the FULL protocol moved to a
  SessionStart injection (`verify-first-full.js`), rewritten in the Superpowers
  "ONE Iron Law + rationalization/excuse table" form (names the specific bypass
  excuses: "probably", "should work", "seems to", "I'll just assume", "this looks
  done", "tests pass on first run"). The per-turn `UserPromptSubmit`
  (`verify-first.js`) is now a SHORT nudge that VARIES per turn (one of 5
  one-liners, chosen deterministically by a SHA-1 hash (Node `crypto`) of the
  prompt) to fight habituation. JSON emitted via `JSON.stringify`, no jq.
- **Survive compaction (P0-2):** the protocol persists across the compaction
  reset via the no-matcher `SessionStart` registration — Claude Code re-fires
  `SessionStart` after a compaction with `source="compact"`, and that injection
  is fresh post-reset context. (This note originally also described keeping a
  `PreCompact` registration as an inert placeholder; superseded in 0.3.5 — no
  PreCompact registration was ever present in `hooks.json`, and all such claims
  were removed. Per the official docs `additionalContext` is injected on exit 0
  for UserPromptSubmit / UserPromptExpansion / SessionStart only, so a PreCompact
  hook would deliver nothing.) A duplicate matcher-`"compact"` SessionStart entry
  was removed so the protocol is not double-injected after a compaction.
- **git-guard force-push hardening (deadly-loop):** force-push detection now
  resists prefix/wrapper/subshell bypasses and `+refspec` variants — env-prefix
  (`FOO=bar git push --force`), wrappers (`command`/`exec`/`sudo`/`env`/`time`/
  `nohup`/`nice -n N`/`timeout 5`), subshell grouping (`(git push --force)`),
  global git options (`-c x=y push --force`), positional `+refspec` (with `--`
  end-of-options handling), and backslash-newline line continuations. Self-credit
  trailer detection is anchored to start-of-line trailer form so a prose mention
  ("docs: explain output generated with claude code") no longer false-blocks,
  while real `Co-Authored-By:` / `Generated with <AI>` trailer lines still block.
  Verified against an 18-case block/allow matrix.
- **AGENTS.md mirror (P0-4):** new repo-root `AGENTS.md` (<32 KiB) mirroring the
  verify-first Iron Law + commit/push hygiene + task discipline, so Codex
  subagents inherit the discipline (Codex `PreToolUse` cannot inject context).
- **Skill primer (P1-1):** SessionStart now lists the plugin's skills
  (root-cause, deadly-loop, feature-launch, orchestration) + when to reach for
  each, folded into `verify-first-full.js`.
- **MODEL-POLICY (P1-2):** documented `effort` default `high` / recommended max
  `xhigh` with fallback-to-`high` when unsupported (gpt-5.4-mini, Bedrock cmb);
  added the `codex` CLI-alias-in-subprocess caveat (detect in the executing
  shell, try an absolute path); added an anti-sycophancy clause (user agreement
  != correctness).
- **marketplace.json (P1-5, P1-6):** plugin `source` is the relative path
  `"./plugins/anti-hall"`, which resolves because `/plugin marketplace add
  talas9/anti-hall` clones the whole repo (the relative path is taken from the
  marketplace root inside that clone); removed the per-plugin `version`
  duplication (version now lives only in `plugin.json`).
- **KB (`docs/KB-claude-codex.md`):** added §9 "Anthropic Prompting 101" and §10
  "Claude Opus 4.8 features relevant to this plugin", plus their source URLs.
- **CHANGELOG header:** corrected "bump both manifests" to "bump `plugin.json`
  only (the authority)".

## 0.2.1

- Fix `git-guard` self-credit regex: removed the bare `ai` alternation that
  false-blocked legitimate human trailers (e.g. `Co-authored-by: Ai ...`). Now matches
  specific AI/assistant signatures only.
- Add this CHANGELOG.

## 0.2.0

- Add skills: `root-cause` (evidence-driven debugging), `orchestration` (non-blocking
  swarm; Claude+Codex load split; commands via Haiku), `feature-launch` (plan-first,
  deadly-loop-hardened, edge-case/scenario simulated), `deadly-loop` (iterative
  Reviewer+Critic debate), and shared `MODEL-POLICY.md` (Opus + Codex roster).
- Add graphify hooks: `graphify-session` (SessionStart, query-graph-first) and
  `graphify-reminder` (Stop, keep-graph-updated).
- Add `git-guard` (PreToolUse/Bash): block self-credit commit trailers and force push.
- Add conditional statusline (rich for monorepos, simple otherwise) + installer.
- Strengthen `verify-first` injection: no-jumping-to-conclusions, no-cause-no-fix,
  instrument-don't-guess, no-fake-completion, label claims.

## 0.1.0

- Initial release: `verify-first` UserPromptSubmit hook + marketplace scaffold.
