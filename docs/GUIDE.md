# anti-hall — extended guide

> Detail moved out of the READMEs during the v0.107.0 doc sweep so the top-level
> READMEs stay a scannable landing page. Nothing here is deleted — every fact that
> used to live in README.md / plugins/anti-hall/README.md is preserved below,
> verbatim where practical.

**New in 0.108.0** (full list: [CHANGELOG](../CHANGELOG.md)): automatic handover at
85% context (`auto-handover.js`, `auto-handover-pause-nag.js`); one settings store and the
`/anti-hall:settings` skill ([Settings](#settings-anti-hallsettings)); repairs on every
reload (`repair-on-reload.js`); update-vs-reload version alerts; Jev cost, precision,
budget watch and credit balance; and for DevSwarm the app database as ground truth
([KB-devswarm-app-db.md](KB-devswarm-app-db.md)), a capability gate, auto-archive,
owner-approved prune and message retention. Per-component detail is in the
[Features table](#hook-reference--plugin-features-table-detailed-per-hook).

## Contents
- [Hook reference (detailed)](#hook-reference-detailed) — how it works, per mechanism
- [Skills reference (detailed)](#skills-reference-detailed)
- [DevSwarm (current state)](#devswarm-current-state)
- [Contributing / testing (plugin)](#contributing--testing-plugin)
- [Features table — every hook and component](#hook-reference--plugin-features-table-detailed-per-hook)
- [Statusline](#statusline-opt-in-one-command)
- [Settings (`/anti-hall:settings`)](#settings-anti-hallsettings)
- [Configuration / tuning](#configuration--tuning)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Test locally](#test-locally)

## Hook reference (detailed)

Moved from plugins/anti-hall/README.md "How it works" (v0.107.0 doc sweep).

## How it works

### Verify-first protocol (the core)

- **SessionStart full protocol** — `verify-first-full.js` injects the FULL
  verify-first + root-cause protocol in the Superpowers **Iron Law +
  rationalization-table** form. It names the specific bypass excuses ("probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run") and includes a skill primer listing the core 4 skills (root-cause, orchestration,
  deadly-loop, ship-it) and when to reach for each. It also carries the always-on
  **output-presentation rule K** ("PRESENT FOR SCANNABILITY"): organize output with
  GitHub-flavored markdown — tables for comparisons/status, **bold** verdicts, `code` for
  flags/paths/commands, fenced blocks for output, emoji as a leading status glyph (signal,
  not decoration), and avoid renderer-dropped syntax. Styling organizes, never pads.
  SessionStart is the primacy slot. Its companion `verify-first-orch.js` (also
  SessionStart) carries the always-on orchestration ruleset (rules A–N + the
  DevSwarm-Primary workspace-tier rule W) — split out in 0.60.0 so both halves
  clear the ~10k per-hook injection cap and land 100% inline instead of one
  spilling to a file past ~2k chars.
- **Surviving compaction** — SessionStart re-fires after a compaction with
  `source="compact"`. The no-matcher SessionStart registration therefore re-injects
  the protocol across the compaction boundary, exactly when context is largest and
  adherence is worst. This is the sole compaction-survival mechanism. The hook is
  deliberately **not** registered on `PreCompact`: per the official docs, only
  UserPromptSubmit / UserPromptExpansion / SessionStart can inject
  `additionalContext`, so a PreCompact hook would deliver nothing.
- **Per-turn nudge** — `verify-first.js` injects ONE short one-liner per turn
  (one of 17 facets of the Iron Law), so the per-turn slot stays high-salience
  instead of being habituated and tuned out. The facet is chosen deterministically
  by a SHA-1 hash of the **entire UserPromptSubmit stdin envelope** — which carries
  `session_id` / `transcript_path` / `cwd` alongside the prompt. So the nudge is
  reproducible for a given full envelope, and the same prompt text in a different
  session or cwd intentionally rotates to a different facet (extra novelty against
  habituation). Nothing from stdin is echoed back into the injected text.

### git-guard

`git-guard.js` (PreToolUse on Bash) mechanically **blocks** two things:

- Commits whose `-m` / `--message`, or whose `-F` / `--file` message (a `-F -` /
  `--file=-` / `-F /dev/stdin` heredoc, or `-F <path>` naming a real, readable
  file, relative to a preceding `cd`), carries a `Co-Authored-By` / self-credit
  trailer (including the canonical emoji-prefixed `Generated with [Claude Code]`
  footer). Commits take no AI credit. An unreadable `-F` file fails open (not
  scanned) rather than guessing at its contents.
- `git push --force` (and quoted/bundled variants). History rewrites are a
  deliberate human action.

It uses a **quote-aware tokenizer** that inspects argv positions, so quoted force
flags (`git push "--force"`), bundled `-f`, `+refspec` pushes, and a trailing
`--force` after a `2>&1` redirect are all caught. It also **unwraps** `bash -c` /
`sh -c` / `zsh -c` / `dash -c` / `ksh -c` / `ash -c` shell wrappers and re-inspects
the payload, so `bash -c "git push --force"` and `bash -c '...Co-Authored-By:
Claude...'` cannot smuggle either block past it that way.
It scans commit messages both INLINE (`-m` / `--message` / `--trailer`) and via
`-F -` / `--file=-` / `-F /dev/stdin` fed by a heredoc on the same command
line, or via `-F <path>` naming a real, readable file (a relative path
resolves against a preceding `cd` in the same command). **Documented fail-open
scope:** an interactive EDITOR commit (no `-m`, no `-F`) is not scanned — the
message is typed live and never appears on the command line — and `xargs` /
an aliased `g push` can still bypass the force-push block. These are
documented boundaries, not silent gaps.

### Task discipline

- `task-tracker.js` (UserPromptSubmit) injects the directive every turn: capture
  every request as a task before acting, assign priority (`P0/P1/P2`), keep the list
  sorted highest-priority-first and work in that order, keep statuses current,
  delegate heavy work to background subagents, and report progress. Nothing is
  silently dropped.
- `task-guard.js` (Stop, loop-safe) blocks **once** when the session is about to
  stop with open tasks (`pending` / `in_progress`) still in the list, prompting the
  model to continue, complete, or explicitly defer them. If the exact same open-task
  set was already blocked on (nothing changed), it skips to prevent infinite loops.
  Fail-open on any parse/read/state error.
- `tasklist-guard.js` (Stop) blocks when **non-trivial work** — ≥
  `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default 3) file-mutating actions — happened without
  task tracking (or with more than one task `in_progress`, or without a fresh
  **per-session** progress file at `<cwd>/.anti-hall/progress/<date>/<session-id>.md`
  (`<date>` = UTC `YYYY-MM-DD`, `<session-id>` = the sanitized Claude Code session id) —
  collision-free across concurrent sessions on the same project, replacing the old
  single shared `.anti-hall-progress.md`. Writes that land only under the session's own scratchpad (inter-agent message files, temp scripts that write nowhere else) do not count as work, and a write to the progress file seen in the transcript counts as fresh even before its mtime is visible (v0.107.0). It coexists with `task-guard` (which drains
  declared tasks) and keeps an **independent block cap** (`MAX_BLOCKS=3` cumulative/session)
  so the two never compound. The progress file is gitignored, never created by the hook, and
  must be updated this session (default 30 min freshness window) to count. A running
  `.anti-hall/progress/INDEX.md` (and the history-side equivalent) is maintained via
  atomic single-line appends only — never a read-modify-rewrite. Fully fail-open.
  See [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md).

### User-override escape hatch (skip-guard)

The user's explicit instruction outranks any guard. When the user **clearly and directly**
asks the agent to skip a guard, the agent records that consent via the shared `skip-guard.js`
primitive — a TTL'd JSON marker at `~/.anti-hall/skip.json`, e.g.
`{ "tasklist-guard": <unix-ms expiry>, "all": <unix-ms expiry> }`. Every guard checks it at
startup and fail-opens while it is in effect; the marker auto-expires (default 15 min) so a
safety guard is never left silently disabled.

- **Granular:** name a single guard (`"speculation-guard"`, `"tasklist-guard"`, `"limit-conserve"`, …) or use
  `"all"` to cover the noisy guards at once.
- **Safe default:** a broad `"all"` skip does **not** cover the destructive `git-guard`
  (force-push / AI-credit trailer) — to skip that, the agent must name `"git-guard"`
  explicitly.
- **Fail direction is inverted from the hooks:** a missing/corrupt skip file makes
  `isSkipped` return false, so the guard stays **active**. A broken skip file must never
  silently disable protection.

> **Several Stop hooks are registered** (`task-guard`, `speculation-guard`,
> `speculation-judge`, `tasklist-guard`, `codex-nudge`), all emitting the top-level `{"decision":"block","reason":...}`
> Stop schema. Claude Code does not merge `reason` strings across Stop hooks: if multiple fire on
> the same Stop, all block but only one reason is shown that turn. `task-guard` is registered
> **first** because open-task discipline is higher-stakes, so its reason wins precedence.
> Each is capped (task-guard caps at `MAX_BLOCKS`;
> speculation-guard blocks once per distinct speculative message hash; speculation-judge
> blocks once per distinct message hash; `tasklist-guard` has its own independent block cap
> — `MAX_BLOCKS=3` cumulative per session — so it never compounds with `task-guard`), so the
> others surface on subsequent Stops.
> `speculation-judge` is a no-op unless `ANTIHALL_SEMANTIC_JUDGE=1` — it never blocks in
> the default configuration.

### speculation-guard

`speculation-guard.js` (Stop) provides **lexical enforcement** of the no-speculation
Iron Law at the output boundary — after the model has already produced a reply.

**How it works:**

1. Reads `transcript_path` from stdin, parses the JSONL, and extracts the **last
   assistant message** (all text content blocks concatenated).
2. Scans for **speculation markers** (case-insensitive, word-boundary):
   `very plausibly`, `plausibly`, `presumably`, `I suspect`, `my guess`, `I'd guess`,
   `I bet`, `likely`, `probably`, `must be`, `should be` (but not `should I`),
   `seems to be`, `appears to be`, `I think it's`, `my hunch`.
3. Suppresses the block if the **same message** also contains an evidence/uncertainty
   **acknowledgment**: `verified`, `I don't know`, `haven't checked`, `not verified`,
   `unverified`, `let me verify`, `I'll check`, `I will check`, `need to confirm`,
   `to confirm`, a `file.ext:line` citation, `running`, `per the data`, `the data shows`.
   This allows honest hedging ("I haven't checked, but it might be X — let me verify")
   while blocking silent inference-as-fact.
4. **Block-once / loop-safe:** hashes the last message text; stores the blocked hash
   in `~/.anti-hall/speculation-guard-state-<session>.json`. If the same message hash
   was already blocked (nothing changed between Stops), skips the block — the model
   was nudged once and had a chance to respond. Never wedges.
5. **Fail-open:** any parse/read/write error exits 0 without blocking or writing to
   stderr. A bug here never wedges a session.

**Known limit — confident inference without hedge words.** The guard is lexical: it
catches hedged speculation (`probably`, `likely`, `I suspect`, etc.) but cannot catch a
confidently-stated inference-as-fact that uses no hedge word at all ("the cause is the
old build" with zero hedging). That class requires semantic judgment — covered by the
opt-in **Tier 3 semantic judge** described below.

### Three tiers of anti-speculation enforcement

| Tier | Component | On by default | Mechanism | Cost / latency |
|---|---|---|---|---|
| 1 | `verify-first-full.js` + `verify-first-orch.js` + `verify-first.js` | Always-on | Protocol injection (SessionStart + per-turn nudge): names every rationalization bypass including confident inference-as-fact and hedge-word speculation. | Zero (no API call; text injection only). |
| 2 | `speculation-guard.js` | On by default | Lexical Stop hook: scans for 15 hedge-word markers, suppresses when acknowledgment present. Catches hedged speculation. Cannot catch confident inference-as-fact with no hedge word. | Zero (pure Node, no API call). |
| 3 | `speculation-judge.js` | OPT-IN (off by default) | Semantic Stop hook: calls an LLM judge via the Anthropic API to assess whether the last message asserts an unverified fact with no hedge word and no acknowledgment. Catches the gap Tier 2 misses. | ~$0.0001-0.001 per turn + ~1-3 s latency. Requires `ANTHROPIC_API_KEY`. |

### speculation-judge (Tier 3, OPT-IN)

`speculation-judge.js` is registered in `hooks.json` but **exits 0 immediately** unless
`ANTIHALL_SEMANTIC_JUDGE=1` is set. When unset (the default), it has zero cost, zero
latency, and zero network activity — it is as if it were not registered at all.

**To enable:**

```bash
# Add to ~/.zshrc / ~/.bashrc / ~/.profile, then restart Claude Code:
export ANTIHALL_SEMANTIC_JUDGE=1
export ANTHROPIC_API_KEY=sk-ant-...    # required; judge is fail-open if absent
```

Or set both variables in the `env` block of your `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTIHALL_SEMANTIC_JUDGE": "1",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

**To disable:** unset `ANTIHALL_SEMANTIC_JUDGE` (or set it to any value other than `"1"`).

**What it catches:** confidently-stated inference-as-fact with no hedge word — e.g.,
"The cause is the old build artifact." with no tool verification and no uncertainty
acknowledgment. The judge prompt instructs the model to ALLOW honest hedging, quoted
text, hypotheticals, plans, and general software knowledge; it only blocks definitive
unverified factual claims.

**Fail-open:** any error (absent `ANTHROPIC_API_KEY`, API unavailable, timeout, bad
JSON response) exits 0 without blocking. A failure here never wedges a session.

**Loop-safe:** hashes the last message text (with a `":judge"` suffix to keep the
namespace separate from `speculation-guard`'s hashes). If the same message hash was
already blocked, skips — the model was nudged once and had a chance to respond.

**Misfire caveat:** LLM judges are not perfect. The conservative judge prompt reduces
false positives, but some misfires will occur — particularly on messages that describe
what code does based on reading it (which IS verified by inspection). If misfires are
frequent in your workflow, disable `ANTIHALL_SEMANTIC_JUDGE` and rely on Tiers 1 + 2.

**Cost and latency detail:** one `claude-haiku-4-5` call per Stop event when enabled
(env-overridable via `ANTIHALL_JUDGE_MODEL`; the one hardcoded model id in this codebase,
since it's a direct Anthropic API call with no alias-resolution support).
At current Haiku pricing this is roughly $0.0001-0.001 per turn; latency is roughly
1-3 s added to each Stop. For projects where confident inference-as-fact is the primary
failure mode and the cost/latency is acceptable, Tier 3 closes the gap Tier 2 leaves open.

### Jev classifier (opt-in, backs Tier 2)

`speculation-guard.js` can optionally ask **Jev** (TypeSafe's "System One" model — a
typed yes/no classifier, not a reasoning model) first. **Default OFF.** Enable with
`~/.anti-hall/jev.json`:

```json
{ "enabled": true, "transport": "vercel", "confidenceThreshold": 0.85 }
```

or `ANTIHALL_JEV=1` (env). `ANTIHALL_JEV=0` always force-disables. Only a confident
"speculative" answer blocks on Jev's word alone; a "grounded" answer, low confidence, or
any Jev failure (no key, timeout, HTTP error, bad response) falls back to the regex check
unchanged. Disabled (the default), the guard behaves exactly as the regex-only hook.
Details: **[docs/KB-jev-classifier.md](./KB-jev-classifier.md)**.

Two more integrations share the same opt-in switch via `hooks/lib/jev-assist.js`, each
with its own on/shadow/off mode and trust rule: `speculation-judge.js` skips its paid
Haiku call when `speculation` is fully trusted (`"on"`, not `"shadow"`), and
`model-routing-guard.js` (default mode **shadow**) can let a confident non-mechanical
classification downgrade a mechanical-flagship block to an advisory. Run
`node plugins/anti-hall/scripts/jev-report.js` for a per-integration KEEP/REVIEW/REMOVE
read on whether any of this is worth trusting. Details: **[docs/KB-jev-classifier.md §10](./KB-jev-classifier.md)**.

## Skills reference (detailed)

Moved from plugins/anti-hall/README.md "Skills" (v0.107.0 doc sweep).

**Always-on vs conditional.** The **root-cause** and **orchestration** disciplines are
**enforced always-on via the hook layer** — their core fires every session/turn through
`verify-first-full.js` + `verify-first-orch.js` (SessionStart) and `verify-first.js`
(per-turn nudge), so they apply without being invoked. The full step-by-step playbooks below are still available as
slash commands for when you want the deep version. **deadly-loop** and **ship-it**
are **conditional skills invoked on match** — they are not forced every turn. The
always-on orchestration injection enforces a **bias toward delegation** — default to a
subagent for any work that touches files/tools/commands/search/build/test or could
balloon (to avoid the eager "I'll just do it inline" trap that pollutes the main thread),
handling inline only genuinely atomic things (a direct answer, a single known-line read,
the coordinator's own synthesis/decisions), and delegating immediately if a quick inline
task balloons; parallel agents when independent; commands via Haiku off-thread. It now
also **defaults delegated heavy/parallel work to the background** — the coordinator passes
`run_in_background` itself so the user needn't background it manually, while still
verifying each on completion (never fire-and-forget). It also
enforces **verify delegated work** — a subagent's "done/passing" is an unverified claim
re-checked against ground truth (re-run the authoritative check, or use a separate
verifier, reconciling multiple workers against ground truth) before marking complete —
**capture-every-request** task discipline (priority-sorted),
**anti-sycophancy** (challenge a wrong premise with evidence; user agreement is not
correctness), and **scope & fidelity** (solve the actual problem with the simplest
sufficient solution; intent over letter; confirm before expanding scope; match rigor to
blast radius; finish what was asked and drop nothing).

Invoke via slash command:

- **`/anti-hall:root-cause`** — evidence-driven debugging: reproduce, collect
  evidence, instrument when missing, trace the sequence to the original + root cause
  (not the surface symptom), prove the hypothesis, fix at the root, verify.
- **`/anti-hall:orchestration`** — swarm with a non-blocking main thread: delegate
  heavy/long work to background + parallel subagents, partition to avoid conflicts,
  distribute load across Claude **and** Codex when available, run commands via Haiku
  so raw output never pollutes the coordinator's context.
- **`/anti-hall:ship-it`** — one lean workflow for shipping any change, scaled S/M/L
  to blast radius: brainstorm + plan in plan mode (ExitPlanMode is the approval gate;
  blends superpowers planning ideas — standalone, no external dependency), enumerate edge cases, harden
  the plan with the deadly-loop BEFORE any code, fan large work out as a Workflow swarm,
  and verify each phase with fresh evidence + a vacuous-test guard, running the
  deadly-loop after each phase until zero NEW P0/P1s. **L tier** adds a resumable
  `.anti-hall/ship-it/<slug>/STATE.json` (plan hash + per-phase status + an escalation
  counter capped at 2 build→re-plan loops), logs accepted P2 findings to
  `decisions.md`, routes build seats Codex-primary with Sonnet failover (a
  cross-model guard skips the Sonnet Reviewer when a phase's build fell back to
  Sonnet, to avoid same-model self-review), and closes out with a session-history
  entry + `SUMMARY.md`. **v0.67.0:** the per-phase
  gate previously ignored dead review seats entirely, so fewer live seats produced
  fewer findings and a silently PASSING `converged: true` — missing review coverage
  is no longer indistinguishable from a clean pass. The gate result now carries
  `totalSeats`/`liveSeats`/`deadSeats`/`degraded`/`seatReports`, and `converged`
  requires `deadSeats === 0` — a phase that loses a seat now correctly fails to
  converge where it previously passed silently. Also honors `args.codexAvailable`
  (mirroring deadly-loop, including the Opus adversarial-persona fallback).
- **`/anti-hall:deadly-loop`** — iterative parallel Reviewer + Critic debate +
  fix-waves until convergence (zero NEW P0/P1s). The debate engine behind
  ship-it's gates. On convergence, writes an ADVISORY
  `~/.anti-hall/approvals/<repo>@<HEAD-sha>.json` record (`"proof": false` —
  not authorization; a real gate must still enforce its own check).
- **`/anti-hall:deadly-loop-multi`** — scaled-up deadly-loop: N Reviewer + N Critic
  pairs with diversified lenses, then dedup + synthesize (double / triple / quadruple).
- **`/anti-hall:install-statusline`** — writes the statusLine setting (global by
  default, per-project on request) and reminds you to restart. `--consolidate` merges
  with an existing statusline (e.g., OMC HUD) instead of replacing it; base persisted
  to `~/.anti-hall/consolidated-base.json`. Env: `ANTIHALL_STATUSLINE_BASE` pins the
  base expression explicitly.
- **`/anti-hall:doctor`** — health-check: confirms Node is found, every hook is
  present + syntax-valid, and the guards actually fire (live behavioral self-tests on
  e.g. git-guard / command-guard / swarm-guard / speculation-guard / tasklist-guard).
  Also **env-aware**: detects and tests each optional integration only when it's
  actually present — OMC (plugin-enabled + live-loop check), Codex/OMX (config/skills
  detection), and the DevSwarm liveness supervisor (supervisor-companion-installed
  state plus a per-workspace liveness self-test; `nudged` reads as WARN, not FAIL) —
  silent and skipped for any integration that isn't in play. **v0.61.0:** repair mode
  also auto-safe-folds every prior DevSwarm mesh-store shape (phantom/dual/subdir-split/
  stale) onto one canonical worktree via `foldMeshDuplicates`; the dry-run detect pass
  doubles as a read-only mesh-shape check under `--check`. **v0.65.0:** the heartbeat now
  carries the monitor outcome, so an ingest daemon that is alive but failing every cycle
  (e.g. a permanent ENOENT/EACCES/ENOTDIR config fault) is reported as a FAILURE rather
  than healthy, with a one-line in-session banner; a heartbeat missing these fields
  (pre-upgrade daemon) reads as unknown, never a fault. New explicit, opt-in
  `--reclaim-ingest-lock` sweeps orphaned locks and reclaims a contended one (positive OS
  confirmation required before any removal), then reinstalls — never runs automatically.
  Install-time also detects a memory-guard/reaper script that would kill the
  service-managed daemon and reports the exact allowlist entry to add. **v0.104.0:**
  `--check`/repair mode also runs a read-only `identity-rekey-candidates` report,
  listing stores written under a pre-0.104.0 wrong project key with their message
  counts; nothing is moved automatically.
- **`/anti-hall:update`** — updates anti-hall in place: `git pull --ff-only` the
  marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof),
  prints the changelog delta between installed and latest, then instructs
  `/reload-plugins` for in-session reload. Hooks and statusline pick up from disk
  immediately; `/reload-plugins` refreshes the skill list and version label. `--check`
  mode answers "is anti-hall up to date?" without pulling or writing. After a pull, also
  runs `scripts/migrate-state.js` once per repo (idempotent) to fold legacy root
  `.anti-hall-progress.md` / `.anti-hall-history.md` into `.anti-hall/history/legacy/`,
  runs the same `foldMeshDuplicates` DevSwarm mesh-store migration doctor's repair uses
  (v0.61.0), then a **dynamic capability scan** (`scripts/capability-scan.js`, read-only)
  reports each opt-in capability shipped in this build (companions discovered from
  `companion/install-*.js`, statusline, pending state migrations) as available-vs-active
  on this machine, with the exact command to enable any gap — never auto-installs.
- **`/anti-hall:devswarm`** — explains anti-hall's optional DevSwarm integration: the
  `hivecontrol` reference KB, the designed-but-unbuilt workspace-tier orchestration, the
  shipped **layered recovery model** (child self-report → supervisor poke → escalate —
  the automatic path never kills), and the **on-demand `devswarm-recover` CLI** (the
  only path that ever kills), including the full activation checklist and tunable env
  vars. **v0.61.0:** also covers the mesh **self-heal** set — drain-aware routing +
  phantom-only rescue, the `orphans[]`/`staleRegistryPartitions[]` health projection,
  the `diagnose`/`healthcheck` read-only verbs, and `foldMeshDuplicates` migration.
- **`/anti-hall:handover`** — writes a comprehensive, organized, minimal-but-lossless
  session handover under `.anti-hall/handovers/`: a global index plus a per-session
  `HANDOVER.md` (front-loaded, fixed SBAR-derived schema, ≤200 lines) and detail files
  (`state.md`/`decisions.md`/`trials.md`/`knowledge.md`), sequence-chained to prior
  handovers, so a fresh session can resume without re-deriving or guessing anything.
  Paired with the `handover-resume.js` SessionStart hook, which surfaces the latest
  handover automatically after `/clear` or compaction. Codex mirror:
  `codex/skills/anti-hall-handover`.
- **`/anti-hall:defects`** — **new in 0.80.0.** File, list, show, and read rulings on
  anti-hall's own defect reports via the durable, home-scoped, two-way channel that
  shipped in v0.78.0 (`hooks/lib/defect-store.js`) but had no discoverable entry point
  until now — the `defect-nudge` hook's runtime pointer led to a skill that did not
  exist, on both ports, and the channel was documented only in files an agent doesn't
  load. Five verbs (`report`/`list`/`show`/`rule`/`archive`); `report` accepts
  `--sym-file`/`--repro-file` so a body with backticks, `$(...)`, or embedded newlines
  never needs shell escaping; a report matching a defect already ruled `fixed` derives
  `regressed` (build at or past `--fixed-in`) or `staleBuild` (older build) from the
  reporter's own installed version — no new storage. `list --mine` identity now
  prefers an explicit `--proj` flag, then `ANTIHALL_DEFECT_PROJ`, then the project's
  git repo key (was cwd basename only, which silently broke `--mine` for reports filed
  from a scratch directory). The `devswarm` skill now points here too, since that's
  the skill a DevSwarm session actually loads. Codex mirror:
  `codex/skills/anti-hall-defects`.

`MODEL-POLICY.md` is the shared TRIO roster (Reviewer = Sonnet `model:"sonnet"` effort `xhigh`;
Auditor = latest Opus `model:"opus"` divergent regression/coupling lens effort `high`;
Critic = Codex latest `xhigh` reasoning when available, else a divergent Opus adversarial persona). It is
**duplicated** — see [Contributing](#contributing).

## DevSwarm (current state)

**Optional and dormant** unless a DevSwarm session is active (`DEVSWARM_REPO_ID`) or one of
its opt-in companions (ingest daemon, liveness supervisor) is installed; nothing else in
anti-hall depends on it.

- **Mesh only.** The Primary and its children talk through anti-hall's per-project store
  via `scripts/devswarm.js` (`send`, `inbox`, `roster`, `mesh read`, `heartbeat`); native
  `hivecontrol` messaging and `SendMessage` to a workspace are blocked. A child sends as
  its workspace id; only the Primary checkout sends as `primary-<hash>`.
- **Primary seat.** One Primary per project; a new session adopts the seat when the holder
  closed, a live conflict is refused until `devswarm.js primary takeover` (checked on every
  cursor write, under the id lock).
- **Per-turn visibility.** The parent-inbox table (app titles, sidebar order, finish/PR
  state, unread, `stale anti-hall <v>`) and nags (120 s grace for fresh unread, none for
  the workspace on screen); Stop gates on unread/unanswered questions for Primary and child.
- **Recovery never auto-kills.** Child self-report → supervisor poke → escalate to the
  Primary; only `devswarm-recover.js <id>` kills.
- **The app database is ground truth** (read-only, capability-gated): archived/deleted
  markers, titles, pins, PRs, session map; screenshot sync (`sync-ui`) only as a fallback.
- **Lifecycle.** Auto-archive of proven-done workspaces (default on, DevSwarm ≥ 2.5.3,
  always by explicit id). "Done" means every finish gate is set, or the child sent its
  structured done-report at its current HEAD and its merge is proven: HEAD contained in the
  remote default branch (`gitMergeProof`, the same check `gate --set merged` records), else,
  only when git can't decide, a `merged` gate verified at the current HEAD or the app's
  merged PR row; a squash merge needs a manual archive; chat text never counts. A child reports done by running `devswarm.js done [--summary "..."]` once
  its work is merged (its SessionStart directive tells it to): that sets its `done` gate and
  sends the Primary one `[[ANTIHALL_DONE]]` message, and the roster shows it
  `done`/`archive-pending`, so nobody archives finished workspaces by hand. The Primary is
  recognised by the app DB's `builderType`, never by a `primary-<hash>` descriptor id.
  Deleting archived ones only via owner-approved `prune-archived`.
- **Store hygiene.** Message retention (archive then prune old bodies), housekeeping sweeps,
  supervisor log rotation; every setting is in the `devswarm` section of `/anti-hall:settings`.
- **Capability gate.** Every `hivecontrol` verb / app-DB column is gated by version +
  detection, default-deny for unregistered invocations; doctor names what is dormant.

Reference: [`KB-devswarm-hivecontrol.md`](./KB-devswarm-hivecontrol.md),
[`KB-devswarm-app-db.md`](./KB-devswarm-app-db.md), the `devswarm` skill. How it got here
(v0.54–v0.107, dated): [`archive/devswarm-layered-recovery-history.md`](./archive/devswarm-layered-recovery-history.md).

## Contributing / testing (plugin)

Moved from plugins/anti-hall/README.md "Contributing" (v0.107.0 doc sweep).

## Contributing

- **Keep the 2 MODEL-POLICY.md copies in sync.** The TRIO roster file is duplicated
  (`skills/MODEL-POLICY.md` plus a copy under `skills/deadly-loop/references/`) because
  skill bundling requires the skill to carry its own `references/` copy and symlinks are
  stripped on install. Update **both** together — they must stay byte-identical.
- **Bump the version on any behavioral change.** `plugin.json` `version` is the sole
  authority (the marketplace entry carries no `version`); without a bump, installed
  users do not receive the update. Add a `CHANGELOG.md` entry.
- **Keep hooks pure Node (built-ins only)** and fail-open, so they run unchanged on
  macOS and Linux (CI-tested) and never wedge a turn. Windows is untested and not
  officially supported (v0.69.0 dropped it from the CI matrix); avoid POSIX-only calls
  regardless, since pure-Node code may still work there.

### Recommended optional: oh-my-claudecode (OMC)

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) is a **recommended
optional** dependency. anti-hall installs and runs fully standalone without it. Two
features gain automatic behavior when OMC is installed:

- **`limit-conserve` auto mode** — `limit-conserve-inject.js` reads the OMC usage
  cache (`~/.anti-hall/omc-usage-cache.json`) to detect the live context percentage.
  Without OMC, the hook operates in manual `on`/`off` mode only. **Account-aware:** if
  the logged-in Claude account changes and the usage cache hasn't refreshed under the
  new account yet, conservation mode deactivates rather than apply a stale reading
  across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`.
- **Consolidated statusline** — `install-statusline --consolidate` merges the anti-hall
  bar with the OMC HUD. The version chip in consolidated mode reads OMC session state.

Without OMC, both features fall back gracefully (limit-conserve manual only; consolidated
mode still works but requires `ANTIHALL_STATUSLINE_BASE` to specify the base). No errors,
no breaking change.

### Opt-in companion: mcp-reaper (macOS + Linux)

`companion/mcp-reaper.js` is an **opt-in interval companion** (not a hook) that kills
**orphaned** MCP-server processes — ones leaked when their spawner (a Claude / codex /
npm / node session) exited without cleaning them up. Install with
`node companion/install-reaper.js` (macOS → 60 s LaunchAgent; Linux → `systemd --user`
timer, cron fallback); remove with `--uninstall`. **Safety invariant:** a process is
reaped only if its command matches a generic MCP signature **and** its parent is a
reaper/init (launchd / init / `systemd --user`) — because Unix reparents a dead process's
children, a *live* MCP always has a live spawner as parent, so killing an in-use server is
impossible by construction. Recognizes Python MCPs too (`uvx`/`uv` + underscore
`mcp_server_*` forms). **Limitation:** an MCP run as a LaunchAgent / `systemd --user`
unit / OS service shares init as a parent (like a leaked orphan) and can be reaped —
exclude it via `ANTIHALL_REAPER_EXCLUDE='name|name'`. Env knobs: `MCP_REAP_DRYRUN=1`,
`MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`.
**Windows is a documented no-op** — it has no parent-death
reparenting and recycles PIDs, so external orphan detection is unsafe there; the correct
fix is Job Objects set by the spawner. See [`plugins/anti-hall/companion/README.md`](../plugins/anti-hall/companion/README.md).

### Opt-in companion: DevSwarm layered recovery (macOS + Linux full, Windows detection-only)

`companion/devswarm-supervisor.js` is a second **opt-in interval companion** (not a
hook) — a workaround for claude-code#39755, where a `claude` session can silently wedge
(process alive, listener dead) with no upstream headless recovery. It is **OPTIONAL**,
exactly like the OMC/OMX integration: dormant with zero effect unless DevSwarm is
actually in use, gated by `hooks/lib/devswarm-detect.js` (modeled on `omc-detect.js`)
and the presence of published workspace descriptors under
`~/.anti-hall/devswarm/workspaces/*.json`.

**The seam:** anti-hall ships only the generic supervisor. A DevSwarm-aware consumer
publishes the workspace descriptor (`id`, `worktreePath`, `sessionId`, `inboxPath`,
`cursorPath`, optional `nudgeCommand`/`escalateCommand`); anti-hall never assumes
DevSwarm's internals beyond that JSON shape.

**Three escalating layers, and the automatic path never kills:**
1. **Child self-report** — `hooks/devswarm-child-role.js` (SessionStart, child-workspace
   only) reminds an idle child to proactively message its parent via `hivecontrol
   workspace message-parent`.
2. **Supervisor poke** — each sweep computes liveness from **outbound** activity only
   (the session's own transcript mtime + git/worktree commit activity — both must be
   idle, plus a pending unread backlog, before a workspace is nominated `stale`); on
   `stale`, it fires the descriptor's optional `nudgeCommand` and persists verdict
   `nudged`.
3. **Escalate-to-parent** — once the poke budget (`ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS`)
   is exhausted, it persists a terminal `escalated` verdict and fires the optional
   `escalateCommand`. Nothing above ever resolves a pid or sends a signal.

Install with `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove,
`--dry-run` to preview). macOS → LaunchAgent; Linux → `systemd --user` timer (cron
fallback); default sweep interval 90 s (`ANTIHALL_DEVSWARM_INTERVAL`, clamped 60-120).
Env knobs: `ANTIHALL_DEVSWARM_SUPERVISOR` (`off`/`on`/`auto`, default `auto`),
`DISABLE_ANTIHALL_DEVSWARM=1` (hard kill-switch). Sweep thresholds are also env-tunable
(all seconds; invalid/absent falls back to the default, clamped):
`ANTIHALL_DEVSWARM_IDLE_SEC` (default `900`, min 60), `ANTIHALL_DEVSWARM_COOLDOWN_SEC`
(default `600`, min 0), `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` (default `2`, clamped
1–20), `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` (default `180`, min 1),
`ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` (default `120`, min 0). `doctor.js` runs a
matching per-workspace check that stays silent unless DevSwarm is active; a `nudged`
verdict reads as WARN (no more stuck-timer/FAIL check — the automatic path never kills,
so there's no kill-then-resume window to watch for being "stuck"). **v0.66.0:** doctor no
longer reaps a unit as "confirmed running and healthy" from a weaker second health check
that omitted the pid guard and the monitor-fault check — there is now one `daemonHealth`
definition, used by every consumer including this reaper.

**Message retention (v0.108.0).** Each supervisor sweep also runs message retention on
one store, so the DevSwarm stores stop growing without limit. Retention archives old
message bodies to `~/.anti-hall/devswarm/archive/<store>/<yyyy-mm>.ndjson.gz` and then
clears them. Rows, read positions and hashes stay, so no unread count changes.

- Only bodies that every reader has already read are pruned.
- The newest 200 rows of each partition, open questions, and each workspace's latest
  heartbeat are never pruned.
- A store over 100 MB is pruned oldest first until it is under the limit. If the rest is
  unread, `doctor` WARNs instead.
- On a new machine, the first run is a dry-run report (`retention-dry-run.json`).
- Settings: `devswarm.retention.days` (30, 0 = off), `maxStoreMB` (100),
  `keepPerPartition` (200), `archive` (true) and `archiveMaxMB` (0 = never evict; `doctor`
  warns past 500 MB). Pruning is automatic after the first-run dry-run report. Set them in
  `~/.anti-hall/settings.json` or with the `ANTIHALL_DEVSWARM_RETENTION_*` env vars.
- Commands: `devswarm.js retention status | run [--dry-run] [--store X] | restore --store X
  --month yyyy-mm`.

Full rules: [KB §8.7, Message retention](KB-devswarm-hivecontrol.md#message-retention--bounded-store-growth-v01080).

**On-demand kill: `companion/devswarm-recover.js <workspace-id>`** — the ONLY path in
DevSwarm that ever kills a process, invoked explicitly per workspace (e.g. on an
`escalated` verdict). Precise targeted kill: identity-bound (worktree + session uuid),
abstains on any ambiguity (0 or >1 candidates), re-confirms identity on fresh data
immediately before each signal (a pid recycled mid-grace is never SIGKILLed), signals
the process **group** (not just the pid) so orphaned MCP children are cleaned up too,
and — unlike the automatic path — targets an **interactive** `claude` session too, not
just headless (naming the id on the command line is the deliberate override). Capped at
`ANTIHALL_DEVSWARM_MAX_RECOVERIES` (default `3`, clamped 1–20) auto-recoveries before
escalating instead of restart-looping; `ANTIHALL_DEVSWARM_GRACE_SEC` (default `5`,
clamped 1–60) is the SIGTERM→SIGKILL grace window. **Windows is a documented no-op for
recovery** — a running process's cwd is not obtainable in pure Node on Windows, so the
cwd confirm-gate that makes the kill safe cannot run; detection-only use from a session
is still possible.

### Codex / cross-tool

`AGENTS.md` is a prose mirror of the verify-first Iron Law + commit hygiene + task
discipline, so Codex agents inherit the same discipline (Codex `PreToolUse` cannot
inject context the way Claude's hooks do). It lives at the **marketplace repo root**,
NOT inside `plugins/anti-hall/`, so it ships only to people who clone this repo — a
`/plugin install` does not bundle it. Installed users who also run Codex must copy it
into their own repo root manually.

## Hook reference — plugin "Features" table (detailed, per-hook)

Moved from plugins/anti-hall/README.md "Features" (v0.107.0 doc sweep).

## Features

| Component | Event | Purpose |
|---|---|---|
| `verify-first-full.js` | SessionStart | The verify-first FOUNDATION: full Iron-Law + rationalization-table protocol, the always-on **scope & fidelity** discipline (simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked / drop nothing), and the always-vs-conditional skill/disciplines index; survives compaction. |
| `verify-first-orch.js` | SessionStart | The companion to `verify-first-full.js` carrying the always-on **orchestration discipline** ruleset (rules A–N + the DevSwarm-Primary workspace-tier rule W). SPLIT from `verify-first-full.js` in 0.60.0 because the combined ~15.3k-char payload exceeded the ~10k per-hook injection cap — over which Claude Code spills the overflow to a file instead of delivering it inline, so only ~2k chars landed and rules A–N + rule W reached no session inline. Each half is now under the cap; zero content dropped. Survives compaction. |
| `verify-first-subagent.js` | SubagentStart | Re-injects the Iron Law + rationalization table + positive rules + scope-fidelity into each spawned subagent. Deliberately omits the orchestration/delegate block (subagents are workers; re-injecting it would recreate deep nesting). Shared core extracted to `verify-first-core.js`. |
| `verify-first-core.js` | Shared module (not a hook) | Single source of truth for the Iron Law content shared by `verify-first-full.js` and `verify-first-subagent.js` — prevents drift between the two hooks. |
| `verify-first.js` | UserPromptSubmit | Short, varying one-line nudge each turn (anti-habituation). |
| `git-guard.js` | PreToolUse (Bash) | Blocks AI self-credit attribution — in `git commit` trailers AND in `gh pr/issue/release create\|edit\|comment` `--body`/`--title` (the 🤖 footer, Co-Authored-By, claude.com/claude-code link) — plus `git push --force`. Inline values only (`--body-file` is fail-open). |
| `api-guard.js` | PreToolUse (Write/Edit/MultiEdit) | Blocks code that references a **non-existent** stdlib/builtin API — resolves `module.attr` in the code-to-be-written against the installed `python3`/`node` and refuses the write when the attribute is fabricated. The mechanical answer to API hallucination. Default = stdlib/builtins (import-safe); opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also checks installed 3rd-party packages (off by default — verifying a package imports it, running its code at edit time). 0 FP + full in-scope catch on `eval/api-guard-bench.js`; never probes local/relative modules; fail-open; skip-hatch. |
| `command-guard.js` | PreToolUse (Bash) | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload, per-segment (quote-aware). **v0.76.0:** all four DevSwarm destructive-verb blocks now also match the `devswarm` alias, not just `hivecontrol` — `hivecontrol` is a thin shim that execs `devswarm` (the primary command name, equally on PATH), so running `devswarm workspace monitor`/`read-messages`/`message-child`/`message-parent` directly used to bypass every block; fixed with a shared verb set and a `(?:hivecontrol|devswarm)` alternation (latent since the blocks were added, not a new regression; shared file, so both ports are covered). Under a DevSwarm-active session it also redirects destructive native inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` blocks unconditionally, `read-messages` blocks only with durable-inbox evidence (`ANTIHALL_DEVSWARM_INBOX_CMD` or a workspace descriptor `inboxPath`); quoted DATA mentions are not false-positives. |
| `output-verify-guard.js` | PostToolUse (Bash, advisory) | **v0.69.0, Harness Phase-1.** Scans a completed Bash call's own stdout/stderr for common test/build-runner signatures (jest/vitest/pytest/go test/npm run build/tsc) and flags when BOTH a passing signal ("8 passed", "PASS", "ok") and a failing signal ("2 failed", "FAIL", a confirmed non-zero exit) appear in the SAME run — the shape of a partial-pass summary easy to mis-report as a clean "tests pass". Fail-open on any shape surprise (the exact PostToolUse Bash `tool_response` field shape is undocumented); never blocks. |
| `failure-root-cause-nudge.js` | PostToolUseFailure (Bash, advisory) | **v0.69.0, Harness Phase-1.** Fires when a Bash tool call fails (non-zero exit/tool-level error); injects one short reminder pointing at `/anti-hall:root-cause` — deliberately terse since OMC already injects its own root-cause reminders in this harness. Fail-open always; off-switch `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off`; skip-guard hatch `failure-root-cause-nudge`. |
| `edit-guard.js` | PreToolUse (Write/Edit/MultiEdit/NotebookEdit) | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording when the liveness supervisor is active, topology-aware: "primary/main orchestrator" vs "sub-orchestrator"). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`plan.md`/`STATE.json`/`CONTINUE-HERE.md`, `*.continue-here.md`, the out-of-cwd `.claude/projects/**/memory/**` store), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard` (not in the destructive set). Fail-open. **v0.64.0:** also exempts PLAN MODE for non-source targets, narrowed by an `isLikelySource` classifier so undelegated source-file writes stay blocked even in plan mode. |
| `coordinator-detect.js` | Shared module (not a hook) | The single coordinator-vs-subagent discriminator, extracted from `command-guard.js` so `edit-guard.js` reuses the exact same detection logic instead of duplicating it. |
| `model-routing-guard.js` | PreToolUse (Agent/Task) | Anti-waste routing — classifies spawn descriptions (mechanical vs complex) and blocks/advises toward the cheapest fitting model. Strict by default (v0.35.0+): unconditional block on omitted-model mechanical spawns. Set `ANTIHALL_MODEL_ROUTING=advisory` (**project-scoped env**) to opt out and revert to advisory-only. Debate role-words in spawn description downgrade row-1 block to advisory. Fail-open; unknown model tokens always allowed. |
| `omc-detect.js` | Shared helper (not a hook) | Detects whether an oh-my-claudecode autonomous loop is active + fresh. Consumed by `task-guard` / `tasklist-guard` to suppress Stop-blocks to advisory when an OMC loop is running, preventing deadlock. Fail-open = NOT deferring. Kill-switches: `DISABLE_OMC=1` or `OMC_SKIP_HOOKS` including `persistent-mode`. |
| `hooks/lib/devswarm-detect.js` | Shared helper (not a hook) | **OPTIONAL, feature-gated** — mirrors `omc-detect.js` for the opt-in DevSwarm liveness supervisor: reports whether it should be considered active for this session/environment. Dormant (zero effect, byte-for-byte identical to today) unless `DEVSWARM_REPO_ID` is set (auto mode) or `ANTIHALL_DEVSWARM_SUPERVISOR=on`. Consumed by `doctor.js`'s per-workspace DevSwarm check. Fail-open = NOT active. Kill-switch: `DISABLE_ANTIHALL_DEVSWARM=1`. |
| `hooks/lib/devswarm-role.js` | Shared helper (not a hook) | **OPTIONAL** — topology gate distinct from `devswarm-detect.js`: answers only "is THIS session a DevSwarm CHILD workspace?" via `DEVSWARM_SOURCE_BRANCH` (non-empty = child, empty/unset = Primary). Fail-open = Primary. Consumed by `devswarm-child-role.js`. |
| `hooks/devswarm-child-role.js` | SessionStart | **OPTIONAL, feature-gated** — Layer 1 of the DevSwarm layered recovery model: for a DevSwarm CHILD workspace only (both `devswarm-detect.js` active AND `devswarm-role.js` child), injects a reminder to proactively self-report idleness (`hivecontrol workspace message-parent`) rather than sit unnoticed. Silent no-op for Primary/non-DevSwarm sessions. **v0.65.0:** also injects the blocking-question escalation protocol into every workspace — a child forwards a blocked decision to its parent (`send --to-primary`) with the options, its recommendation, and the default it will take if unanswered by its deadline, keeps working every other unblocked item, and proceeds on that default while flagging the assumption loudly; only an unauthorized destructive/irreversible action is a hard stop. Ladder is child → parent → human, never child → human; the parent side gets the matching reply-and-escalate directive. |
| `devswarm-parent-inbox.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — mechanical trigger for the "Primary neglects child workspaces" failure (claude-code#39755). For a Primary DevSwarm session only: each turn surfaces the real unread/idle state of active workspaces, and recommends archiving any workspace the store derived as complete (`archive_ready`). Reads the durable-inbox files + the supervisor's verdicts + `summary.json`; never runs git/`computeLiveness` on the hot path. **(0.54.1)** Also injects a compact live table EVERY turn — one row per active workspace: status (`escalated`>`stale`>`archive-ready`>`idle`>`active`>`dormant`, attention first) / finish-rate (required gates met/total + optional heartbeat %) / unread / last-activity; capped at 12 rows with a logged `+N more`. **(0.60.0)** A row idle beyond `ANTIHALL_DEVSWARM_IDLE_MS` (default 6h, ms) is relabeled `active`→`idle` — a view-only demotion (no delete, no gate change, no archive) so a long-verified-done workspace stops reading as "active" forever; never overrides `escalated`/`stale`/`archive-ready`. **(0.67.0)** Each row now renders `name (shortid)` instead of a bare UUID, reading the `devswarm-names.js` fs cache only — never spawns `hivecontrol` on this hot path — falling back to the raw id when no name is cached. **(v0.70.0)** The normal-tier unread segment's wording was softened from a per-turn "STOP ... before continuing" imperative to advisory phrasing (`tierOf` already routes urgent/high workspaces to the separate loud segment, which is unchanged). **(v0.70.1)** New `dormant` tier (rank 5, sorts last, below even `active`): a DevSwarm mesh/registry row outlives its workspace — closing a workspace in the DevSwarm app deletes nothing (registry row, worktree, descriptor, and `hivecontrol workspace list` entry all survive) — so a row whose newest known activity signal is at least `ANTIHALL_DEVSWARM_DORMANT_MS` old (default 30 min, ms) is labeled `dormant` instead of `active`/`idle`, since only heartbeat/verdict AGE reliably separates a live workspace from one closed with no teardown signal. It demotes, it never hides — a dormant row still renders with its unread count, only ranked last, so a genuinely-live-but-quiet workspace can never go invisible; it never overrides `escalated`/`stale`/`archive-ready`, and the threshold is a heuristic, not proof a workspace is closed. **(v0.74.0)** Report-only git ground-truth risk markers are appended to a row's workspace-title cell (never a new column): `⚠ no upstream` or `⚠ N unpushed` (from the child's heartbeat-carried `gitPushState` probe, `companion/lib/devswarm-git-truth.js`), and `merged (unverified)` on an `archive-ready` row whose `merged` gate was self-declared but never proven by git ancestry (`merged_verified !== true`). Never blocks or implies anything beyond "look before archiving". Silent no-op otherwise. **(v0.100.0)** Archived rows (label EXACTLY `archived`; a real backlog on an archived row escapes via `not-draining`, rank 1.5, so it is never hidden by this filter) are now dropped from the roster table BEFORE the sort/cap, not after — previously an archived row could compete for a table slot on equal footing with a live one and push it into overflow. Default ON via `ANTIHALL_ROSTER_HIDE_ARCHIVED` (`0` restores the old behavior); the count of hidden archived rows is always named as a `+N archived` note, never silently dropped. The cap itself is now configurable via `ANTIHALL_ROSTER_MAX_ROWS` (default 12, was hardcoded). Separately, the advisory `recent[]` broadcast feed — previously rendered the FULL message body verbatim every turn, with no memory of what was already shown — now truncates each body to 200 chars with an ellipsis, drops a broadcast older than `ANTIHALL_BROADCAST_MAX_AGE_MS` (default 24h), and per-session-dedupes against `~/.anti-hall/devswarm/parent-inbox-broadcast-seen/<session>.json` (bounded to 200 keys) so a broadcast no longer re-injects verbatim for the rest of the session. Fails open to showing (never hiding) on any dedup-state read/write failure. **(v0.106.0)** An archive-ready workspace from a PREVIOUS session whose entire unread backlog is the Primary's OWN `archive-request` send (`archive_request_only_unread`, `companion/lib/devswarm-store.js`) and whose session is no longer running is excluded from the urgent/attention nag — it never clears on its own (nobody is left to drain it); the row still gets the existing cooldown'd archive-ready nudge and still shows in the table, just as `archive-ready` rather than `not-draining` forever. A new user-editable ignore list, `~/.anti-hall/devswarm/ignore.json` (`{"ids": ["<id>", ...]}`, `companion/lib/devswarm-ignore.js`), additionally suppresses the same nag for any explicitly-listed id while leaving it fully visible in the roster table — it only ever changes whether a turn nags, never what is tracked. |
| `devswarm-parent-gate.js` | Stop | **OPTIONAL, feature-gated** — Primary-only, capped/loop-safe (Phase 5 shared Stop policy `hooks/lib/stop-policy.js`: honors `stop_hook_active`; cap keyed by stable block kind, not unread counts). Blocks the Primary from ending its turn while a child still has unread backlog past its cursor OR the supervisor already judged a child stale/escalated OR **(0.56.0)** the Primary's OWN summary-projected unread is nonzero (read from `summary.json`, no DB open) — surfaced with the same imperative "STOP and read them FIRST via `devswarm.js inbox read-primary <id>`" wording (Phase 5: then run the returned `ackCommand`, `inbox ack-primary <id> --receipt <rid>`) the child gate uses, so a Primary can no longer end its turn while sitting on its own unread inbound. **(0.61.1)** "Unread backlog" now counts only REAL unread — system-generated poke/mirror noise (`companion/lib/devswarm-noise.js` `isNoiseText`) is excluded, closing a ghost-workspace feedback loop where a backlog consisting solely of the Primary's own mirrored poke nagged on every Stop; an unparseable row/unreadable inbox still counts as real (fail-open). Registration also now precreates an empty durable inbox so a freshly-registered child reads as known/empty, not absent. **(0.62.0)** A `stale`/`escalated` verdict is now suppressed (never gates on the liveness axis) when the workspace has a FRESH heartbeat — definitive proof-of-life, since a heartbeat is emitted only by the workspace's own live session — while the real-unread coordination axis is untouched (a live, heartbeating workspace with genuine unread backlog still gates). Reads only files (fs cursor + the supervisor's verdict file + the summary projection + the heartbeat file) — no git, no live liveness on the ~30 s Stop path. Fail-open. **(v0.69.0)** The gate can no longer be satisfied by merely READING a child's blocking `--question` — it now requires an OBSERVED reply, checked against a durable per-project reply-state file (`companion/lib/devswarm-reply-state.js`) that `devswarm-parent-reply-tracker.js` writes on every successful `send --to <id> --question`. The forced-ack cap can no longer silence an unanswered question forever — once exhausted it escalates once with distinct wording instead of going silently quiet; every Primary turn also re-asserts the obligation. **(v0.71.0)** `devswarm-reply-state.js`'s storage is now an append-only JSONL log instead of a lockfile read-modify-write: `recordReply` is one `O_APPEND` write (no lock), `readReplyState` folds the log with a fail-closed newline separator, a 480-byte record cap, and a `__proto__`-safe fold accumulator — structurally eliminating the disclosed steal-branch TOCTOU. A loss-safe migration (`migrateReplyState`) is wired into `update.js`/`doctor-repair.js`. **(v0.80.0)** A stated intent (the gate invites the Primary to say a block is intentional) is now recorded against the exact condition signature it was stated about and suppresses ESCALATION ONLY while that signature is unchanged — the first block on any condition still always fires, the reason text is stored but never echoed back (closed-vocabulary boolean only, since reasons reaching the model as text are an injection surface), and any change to the signature (unread arrives, a workspace's status changes) drops the suppression and resumes normal escalation. The absolute escalation cap remains as a backstop. Ships with a forward migration for the new persisted `intents` map, wired into both the updater and the doctor, fail-open on a pre-upgrade state file with no `intents` key. **(v0.84.0)** The gate no longer hides genuinely drainable mail: a permanently-stale persisted `repoKey` and an `ownerKey`-only descriptor both used to make real unread invisible here. Partition resolution now goes through the SAME shared helper the CLI uses (`companion/lib/devswarm-repokey.js` `registeredRepoKey`), so the gate and the `inbox read-primary` command it prescribes can no longer disagree about which workspaces a session owns. **v0.85.0 dead descriptor vs. neglect:** the old rule — `known:false` on the unread read ALWAYS blocks, unconditionally, INCLUDING an absent inbox file — was itself the defect: a descriptor that outlived its sibling's archive can never produce an inbox, so the gate blocked every Primary turn permanently with nothing available to clear it. An `inbox-missing` (ENOENT only) on a descriptor whose `worktreePath` is ALSO provably gone no longer raises the unknown axis. Nothing is hidden — store-side unread still blocks on `unionUnread`, a stale/escalated verdict still blocks, and every other unreadable reason (`inbox-unreadable`, `cursor-*`, `no-inbox-path`, `read-threw`) still blocks regardless of the worktree. Fail-closed-to-block: "gone" is a definitive ENOENT `lstat` on an ABSOLUTE path only; a relative/missing path, a dangling symlink, or any other stat failure is NOT provably gone. **v0.93.0:** app-side archived-but-still-live senders keep blocking — a question is informational only when its sender matches no registry row of any kind (active OR archived) and no descriptor; the gate folds `archivedRegistryRows` into its known-registry set and fails open to blocking on a legacy summary that lacks the field. Sender attribution (shared with `devswarm-parent-inbox.js`) now excludes the recipient's own identity family first, so a reply from the recipient or a twin never wrongly clears a question from the true sender. **v0.94.0:** when a worktree's meshId maps to more than one sibling registry row, sender attribution is now picked by `companion/lib/devswarm-attribution.js`'s `pickAttributionRow` — a pure function of row values (real-sessionId row wins, then the branch-slug row, then ascending lexical id) — replacing the old liveness-based picker whose present-tense signals could flip the reported sender for the same stored message across passes (defect f3b8f326bfc3). **v0.106.0:** the same `~/.anti-hall/devswarm/ignore.json` ignore list `devswarm-parent-inbox.js` now honors (see that row's v0.106.0 note) also drops a listed id from this gate's neglect computation entirely — never a reason a Primary's turn blocks — while leaving it fully visible everywhere else. |
| `devswarm-parent-reply-tracker.js` | PostToolUse (Bash) | **NEW in v0.69.0, OPTIONAL/feature-gated, Primary only, observe-only** — watches every Bash call for a successful `devswarm.js send --to <id> --question ...` and records it via `devswarm-reply-state.js`'s `recordReply()`, keyed by a durable per-project `repoKey` (not a Claude `session_id`) so `devswarm-parent-gate.js` can tell "read" apart from "decided and replied". Anti-spoof guarded (the response shape alone is not trusted without the input command also plausibly being a real `send` call); never blocks, writes nothing to stdout; fail-open on every error. |
| `devswarm-child-turn.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — child-only. Writes a turn-authored heartbeat (`heartbeats/<DEVSWARM_BUILDER_ID>.json`, unique per child — falls back to a sanitized/hashed `<branch>` key only when `DEVSWARM_BUILDER_ID` is absent; never a background ticker) and reminds the child to report to its parent. **(0.54.1)** Also surfaces a non-destructive unread-count check against the child's OWN durable descriptor inbox — PARTIAL: this only makes an already-populated durable inbox visible to the child; nothing shipped yet drains the child's native parent→child queue into it (v0.54.2 follow-up). **(0.56.0)** The unread surfacing is now IMPERATIVE PRIORITY wording ("STOP and address... FIRST"), scans unread lines for a `[[ANTIHALL_ARCHIVE_REQUEST]]` marker and surfaces a distinct confirm-then-archive segment when found, and mechanically writes/refreshes the child's own descriptor every turn (MERGE-preserving) so the parent can always discover it. Silent no-op otherwise. **(v0.69.0)** Self-continue directive: tells the child to keep issuing tool calls across rounds of a multi-round autonomous task within the same turn, reserving `Stop` for a genuine block, final completion, or an unrecoverable error — cutting the wake-cycle (supervisor cron) latency a per-round idle-out previously cost. Shared verbatim with the Codex port. **(v0.74.0)** `writeHeartbeat` also attaches one report-only `gitPushState` probe per turn (`companion/lib/devswarm-git-truth.js`) — `noUpstream`/`unpushed`, resolved from the worktree at `cwd`, omitted entirely (never fabricated) when the worktree or probe doesn't resolve — surfaced to the parent as a risk marker by `devswarm-parent-inbox.js`. **v0.85.0:** now participates in the SAME per-id advisory lock the archive/retire paths use (`companion/lib/recovery.js`'s `acquireLock`, bounded ~1s sync retry, fail-open to an unlocked write) around its own descriptor rename — an atomic replace installs a NEW INODE at `workspaces/<id>.json`, and an unlocked interleave with a verify-then-unlink-by-pathname retirement could silently de-register a LIVE child. One lock, over mkdir+write+rename, no nested acquisition, no subprocess. |
| `devswarm-child-gate.js` | Stop | **OPTIONAL, feature-gated** — child-only, capped/loop-safe. Forces the child to self-report to its parent before going idle, so a child that finishes a turn pings the parent instead of dropping off its radar. **(0.54.1)** Heartbeat-freshness silencing REVERTED: the brief v0.54.0 "fresh heartbeat satisfies the gate" logic false-silenced a child that worked <5 min then stopped without reporting, so the gate always demands at least one real report per unchanged blocking state, bounded by the per-window cap `MAX_BLOCKS = 2` plus a never-resetting `MAX_BLOCKS_PER_SESSION = 6` lifetime cap (v0.98.1, defect a55d6b71a76f). A benignly-dropped `heartbeat --summary` still counts as an attempted report via a session/nonce-authenticated local attempt record — appended per writer id under `summary-attempts/<repoKey>/<writerId>.ndjson` (the reader also still honors a legacy flat `summary-attempts/<repoKey>.ndjson` file if present) — not a re-prescribed loop. **(0.56.0)** STRICT mode (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON) backs the durable-inbox check with one bounded non-destructive `hivecontrol workspace message-count` probe (5 s timeout) when the durable check shows nothing, to catch a native backlog the child never `inbox pull`ed. Fail-open. **(v0.73.0)** Reads the shared union unread primitive (`companion/lib/devswarm-unread.js`, NDJSON ∪ store-only mesh-direct backlog, hash-deduped) instead of NDJSON alone, and splits its messaging into "CHILD NOT DRAINING" vs "YOUR INBOX" segments naming the workspace by title. |
| `devswarm-child-drain.js` | PostToolUse (Bash) | **NEW in v0.73.0, OPTIONAL/feature-gated, child-only, throttled.** Closes the SkyCrew field gap where a DevSwarm child has no mid-turn re-entry: `devswarm-child-turn.js` fires once per `UserPromptSubmit`, never during a long autonomous task, so a mesh-direct `send --to` (store-only, invisible to an NDJSON-only reader) could sit unnoticed while the child kept working. Mirrors the Primary-only `devswarm-parent-reply-tracker.js` (same PostToolUse/Bash registration shape) but child-only: on every Bash call, reads the shared union unread primitive against the child's own descriptor and, when unread > 0, injects a drain reminder — throttled to re-inject only when the unread count changes or a 10-minute window elapses, so a busy child isn't nagged on every tool call. Fail-open throughout. |
| `swarm-guard.js` | PreToolUse (Agent/Task) | Anti-fork-bomb — spawn-rate cap + real reclaimable-memory check (`vm_stat` / `MemAvailable`, not `os.freemem()`). A blocked spawn also logs one line to `~/.anti-hall/swarm-trips.log` (observation only — doesn't feed the rate window). |
| `phase-tracker.js` | PreToolUse (Agent/Task) | Records every subagent spawn so the statusline shows live swarm activity. It also writes a rolling `~/.anti-hall/agents/recent-spawn.json` heartbeat that `agentsRunning()` consumes, so the Stop guards know when parallel work is live. Never blocks. |
| `agent-watchdog.js` | CLI helper (not a hook) | Heartbeat enforcer — scans `~/.anti-hall/agents/*.json` and reports stale/hung subagents; run manually by the orchestration skill. |
| `task-tracker.js` | UserPromptSubmit | Injects task-list discipline (capture, prioritize, work in order) + a one-line freshness note when open/stale tasks exist. **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see below). |
| `hooks/lib/state-prune.js` | Shared module (not a hook) | **New in v0.76.0.** Bounds per-session state files under `~/.anti-hall` so they can't grow without limit. Every per-session state file (task-tracker, speculation-guard, tasklist-guard, codex-nudge) was kept forever and never read back once its session ended — on a heavy multi-session machine this reached 47,000+ files across 71 days, worsened by `doctor.js`'s own self-tests orphaning one file per hook per run. `pruneStale()` is wired into each of those four hooks' existing write paths (no new hook, no new event): removes same-prefix files past a 7-day TTL, throttled to once per 6 hours via a stamp file, never removes the current session's own file, fails open on any fs error. |
| `limit-conserve-inject.js` | UserPromptSubmit | **Limit-conservation mode.** Injects a token-conservation nudge when context usage reaches `ANTIHALL_LIMIT_THRESHOLD` (default 85%). `ANTIHALL_LIMIT_CONSERVE`: `auto` (default) reads the OMC usage cache; `on` forces the nudge; `off` disables. Auto mode requires OMC; without it, manual on/off only. Skip-guard hatch: `limit-conserve`. |
| `limit-conserve.js` | Shared helper (not a hook) | Reads the OMC usage cache and applies threshold logic; consumed by `limit-conserve-inject.js`. **Account-aware:** tracks the logged-in Claude account's `userID` (`~/.claude.json`) alongside the usage cache's mtime; if the account changed since last seen and the cache hasn't been refreshed under the new account yet, the stale reading is deactivated rather than mis-applied across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`. |
| `auto-handover.js` | UserPromptSubmit | **New in v0.108.0, ON by default.** When the main agent's context first crosses `autoHandover.pct` (default 85% of this session's ACTUAL context window — see `hooks/lib/context-pct.js`) or the opt-in absolute `autoHandover.maxTokens` ceiling (default 0 = off; env `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS`), whichever comes first, tells it — without asking the user first — to self-write an anti-hall handover (never delegated), tell the user and list the saved paths, and urge `/compact`/`/clear` with an exact `/compact focus: <handover path>` line to paste. Context % comes from `hooks/lib/context-pct.js`: the statusline's real `context_window` figure (persisted by `statusline/phase-bar.js`), else a Codex rollout's `model_context_window`, else a transcript estimate (window from `ANTIHALL_CONTEXT_WINDOW_TOKENS`, the session's last-seen statusline window, or "inferred 1M" once usage passes 200k). With a genuinely unknown window it sends one soft advisory instead of the mandatory directive. Fires once per arm; milestone reminders every `nagStepPct` (5) further points; re-arms when usage drops back below. `ANTIHALL_AUTO_HANDOVER_PCT` overrides the threshold (`0` = off). Shared with the Codex port. |
| `auto-handover-pause-nag.js` | Stop | The auto-handover trigger's companion. If the fire directive has not gone out this arm and the agent is over threshold at a Stop (a long autonomous turn that never reaches a new prompt), it delivers the directive once (shared latch, never while `stop_hook_active`). Otherwise, once it has fired this session and usage is still over threshold, sends one short reminder at a genuinely quiet point — no open TodoWrite work, no subagent spawned in the last 2 minutes — at most once per `nagQuietMin` minutes (default 15). Uses the shared `stop-policy.js` `stop_hook_active` check so its own block-with-reason (the only non-blocking-adjacent way a Stop hook can surface text in this harness) is never re-triggered by its own answer. Silent when `autoHandover.nag` is false or the feature is disabled. Shared verbatim with the Codex port. |
| `precompact-snapshot.js` | PreCompact (manual + auto) | **New in v0.108.0.** Safety net for the self-written handover: right before every compaction writes a MECHANICAL `.anti-hall/handovers/<date>/<session>/PRECOMPACT-<n>.md` — pwd, git branch/HEAD/dirty files, the task list parsed from the transcript, the last 10 user messages verbatim, and a pointer to the newest `HANDOVER*.md`. Always exits 0 and prints nothing, so it can never block compaction. `handover-resume.js` names it on the next SessionStart. Shared with the Codex port (Codex `PreCompact`). |
| `repair-on-reload.js` | SessionStart + UserPromptSubmit | **New in v0.108.0.** Repairs run on a plain `/reload-plugins` or a new session on a new version, not only via `update.js` / `doctor --repair`. When any default migration in `companion/lib/migrations.js` is not stamped at the running version or newer (one small read of `~/.anti-hall/update-sweep-state.json`), it takes `~/.anti-hall/repair-on-reload.lock` and spawns one detached `doctor.js --repair --migrations-only --quiet` (the newest cached version's doctor, never one older than the running version). It runs only the stamped data migrations and store repairs; statusline, Codex hook install, supervisor and anything else that writes user config stay behind a user-typed `doctor --repair`. Two migrations touch the project in the session's cwd: legacy state and GSD `.planning/` files are copied into `.anti-hall/history/legacy/`, and each GSD source file is deleted once its copy is verified (directories are kept), logging to `~/.anti-hall/logs/repair-on-reload-*.log` (newest 5 kept). At most one run per hour per running version, counted only from a spawn that started (`~/.anti-hall/repair-on-reload.last.json`); the child runs at nice 19. Nothing pending → silent no-op. Subagent payloads skipped. Off: `ANTIHALL_REPAIR_ON_RELOAD=off`. Shared with the Codex port. |
| `hooks/lib/settings.js` (+ `settings-schema.js`) | Shared module (not a hook) | **New in v0.108.0.** The one settings store, `~/.anti-hall/settings.json`: a declarative schema (sections, types, bounds, env names, `/config` option names, legacy sources) and `get`/`getWithEnv`/`set`/`reset`/`source`. Precedence env > settings.json > `/config` > legacy file > default (legacy outranks `/config` until the one-time migration is stamped). Dotted keys are read flat or nested. Used by every guard, Jev, auto-handover, the version alerts, the statusline, and DevSwarm (incl. auto-archive and retention). Front ends: `/anti-hall:settings`, `scripts/settings.js`. See [Settings](#settings-anti-hallsettings). |
| `task-guard.js` | Stop | Blocks once if the session ends with open tasks. |
| `tasklist-guard.js` | Stop | Blocks when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh per-session progress file (`.anti-hall/progress/<date>/<session-id>.md`); coexists with `task-guard` with its own independent block cap; capped + fail-open. **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see above `task-tracker.js` entry). |
| `skip-guard.js` | Escape hatch (shared primitive) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive git-guard (must be named explicitly). |
| `version-alert.js` | SessionStart (non-blocking) | Tells the agent to inform the user when anti-hall is behind. Two cases: the plugin-cache mirror (`~/.claude/plugins/cache/anti-hall/anti-hall/<v>/`) already holds a newer version than the running one → "reload" only (with that version's changelog headline); the remote is newer (cache `~/.anti-hall/version-check.json`, 2 h TTL — was 24 h, which missed multi-release days) → "update, then reload". Once per session per case. A stale/absent cache spawns a detached `git ls-remote --tags` refresh and stays silent — never blocks on network. `installed_plugins.json` is never trusted (it can lag). Off: `versionAlerts.antiHall=false` / `ANTIHALL_VERSION_ALERT=off`; skip-guard hatch. |
| `devswarm-version.js` (+ `devswarm-version-refresh.js`) | SessionStart (non-blocking) | **New in v0.76.0, OPTIONAL/feature-gated.** Probes the installed DevSwarm version and flags drift from the baseline anti-hall was verified against — `command-guard.js` matches DevSwarm subcommands by literal string, so a renamed verb in a future DevSwarm release would make a block silently stop matching with nothing to signal it. Mirrors `version-alert.js`'s shape: a fresh cache short-circuits, a stale/absent one spawns a detached, unref'd background probe (`devswarm-version-refresh.js`) and returns immediately so session start is never blocked. Drift classification is semver-aware — major/minor advises, patch-only stays silent, a downgrade is worded accordingly; the advisory dedupes on (installed, baseline) so it never nags twice for the same drift. Absent DevSwarm or unparseable output fails open and silent. Baseline lives in the shared `hooks/lib/devswarm-baseline.js` module, also consumed by the doctor check. Registered once, shared by both the Claude plugin and the Codex port. |
| `claude-cli-version.js` (+ `claude-cli-version-refresh.js`) | SessionStart (non-blocking) | **New in v0.79.0.** Probe 2 of anti-hall's drift-probe family. Detects the installed Claude Code CLI version and flags major/minor drift from the version anti-hall's harness-feature KB ([`docs/KB-claude-code-harness-features.md`](./KB-claude-code-harness-features.md)) was last audited against. Mirrors `devswarm-version.js`'s shape: a fresh cache short-circuits, a stale/absent one spawns a detached, unref'd background probe (`claude-cli-version-refresh.js`) so session start is never blocked. Patch-only drift stays silent; deduped on the (installed, baseline) pair. CLI absent or unparseable fails open and silent. |
| `repo-self-drift.js` | SessionStart (non-blocking) | **New in v0.79.0.** Probe 3 of anti-hall's drift-probe family — deterministic, no network. Two checks: (1) parses [`docs/KB.md`](./KB.md)'s own claimed hook/skill counts and compares against the actual count on disk, advising on either mismatch; (2) tracks the date the model KBs ([`docs/opus-4-8-features.md`](./opus-4-8-features.md) etc.) were last audited and advises past a 60-day threshold, since model facts aren't locally discoverable and a probe that can't verify would either invent an answer or fail constantly. Cached (<24h), deduped, fail-open and silent on any error. |
| `fable-availability.js` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache Claude Code's own `/model` selector renders from) once per session — no live API probe, fail-open, silent unless Fable is actually available. When available, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable → Sonnet → Opus. |
| `codex-availability.js` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` (`{available, checkedAt, source}`) once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness — a runtime spawn can still fail even when `available:true`. Registered on both the Claude plugin and the Codex port. Fail-open. |
| `handover-resume.js` | SessionStart | On a fresh session (including after `/clear` or compaction), surfaces the latest `.anti-hall/handovers/` entry (if any) and guides a structured resume from it — supersedes the lossy default compact summary. Fail-open (silent no-op if no handover exists). Registered on both the Claude plugin and the Codex port. |
| `defect-nudge.js` | SessionStart | **New in 0.78.0.** Once-per-day, non-blocking notice of open defects filed against anti-hall via the defect channel (below) — counts and ages only, never reporter-supplied text. Registered on both the Claude plugin and the Codex port. |
| `emit-dedupe-reset.js` | SessionStart | **New in 0.103.0.** Writes a per-session reset marker on every SessionStart source (startup/resume/`/clear`/compaction) so `hooks/lib/emit-dedupe.js`'s UserPromptSubmit suppression re-emits blocks the fresh context lost, instead of treating them as already-seen. State-only, no context injected, fail-open. Registered on both the Claude plugin and the Codex port. |
| `task-lifecycle-log.js` | TaskCreated + TaskCompleted | Log-only: appends one line per task-lifecycle event to `.anti-hall/history/<date>/<session-id>.md` and maintains `.anti-hall/history/INDEX.md`, reusing `session-history-index.js`'s idempotent append helper (the same one `tasklist-guard.js` calls). No matcher, no evidence gate, never blocks, no context injected, fail-open. Claude-only — Codex's hook runtime does not expose these events (see `codex/README.md`). |
| `speculation-guard.js` | Stop | Blocks once when the last assistant message contains hedge-word speculation without an evidence/uncertainty acknowledgment. Always-on (lexical, Tier 2). |
| `speculation-judge.js` | Stop | OPT-IN semantic judge: calls an LLM to catch confident inference-as-fact with no hedge word. Off by default; enabled by `ANTIHALL_SEMANTIC_JUDGE=1`. |
| `claim-ledger.js` | Stop | **new in 0.100.0.** LEDGER-ONLY deterministic cross-check: records checkable tokens in the last message (counts, SHAs, `task N of`, `N days ago`, no-tool "still running") that never appeared in the session's tool output / hook context, to `~/.anti-hall/claim-ledger/<session>.jsonl`. Never blocks; measures the false-positive rate before any blocking tier is enabled. |
| `codex-nudge.js` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off. |
| `ship-it-guard.js` | PreToolUse (Write/Edit/MultiEdit) | **OPT-IN, default OFF** — the only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root). Also does a conformance advisory (never blocks) for edits outside a PLAN.md's declared `files:` list. Enforces artifact existence only (not plan quality), conservative, fail-open. No effect when unset. |
| `merge-gate.js` | PreToolUse (Bash) | **OPT-IN, default OFF** — a backstop, not a guarantee. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "needs your eyes" / …) not followed by a resolution token. Keyword-heuristic, bypassable, fail-open, cannot hard-loop; no effect when unset. |
| `root-cause` / `orchestration` / `ship-it` / `deadly-loop` (+ `deadly-loop-multi`, `install-statusline`, `doctor`, `system-briefing`, `update`, `flutter-debug`, `activate`, `simplify`, `debt`, `devswarm`, `handover`, `defects`) | Skills | Slash commands (see [Skills](#skills)). |
| `statusline/` | Statusline | Rich line 1 for ANY repo (monorepo or simple); the monorepo/simple renderer is only a fallback if the rich renderer yields nothing. Line 2 is an always-on phase/context bar. |
| `companion/mcp-reaper.js` (+ `install-reaper.js`) | Interval companion (not a hook) | **OPT-IN**, macOS + Linux. Kills ONLY orphaned MCP-server processes (parent already died). Install via `node companion/install-reaper.js` (`--uninstall` to remove); Windows is a documented no-op. See [`plugins/anti-hall/companion/README.md`](../plugins/anti-hall/companion/README.md). |
| `companion/devswarm-supervisor.js` (+ `install-devswarm-supervisor.js`) | Interval companion (not a hook) | **OPT-IN and OPTIONAL** — dormant with zero effect unless DevSwarm is in use (feature-gated via `devswarm-detect.js`, same optionality model as the OMC/OMX integration). Detects a wedged/idle DevSwarm workspace agent from outbound activity (session transcript + git/worktree) and pokes it (an optional descriptor `nudgeCommand`) or escalates (log + optional `escalateCommand`) — **never kills**. Install via `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove); macOS + Linux full, Windows detection-only. Workaround for claude-code#39755. **v0.66.0:** a cooldown-gated reconcile sweep now also runs on this existing supervisor, so stranded mesh messages self-recover instead of sitting until an update or a manual repair happens to invoke `reconcile` — it uses the same single-consumer lock as the drains, so it cannot race a live one. **v0.93.0:** hivecontrol 2.5.1's `workspace list all` carries no archive field, so the sweep now caches the ACTIVE set (`hivecontrol-active.json`) on every successful list call; a registry row absent from that cache by both id and worktree path, older than the snapshot by a 10-minute grace, reads as app-archived while the cache stays fresh (within 2x the reconcile cooldown) — liveness axis only, a genuine unread question still gates regardless. |
| `companion/devswarm-recover.js` | On-demand CLI (not a hook) | **OPT-IN and OPTIONAL** — the ONLY path in DevSwarm that ever kills a process. `node companion/devswarm-recover.js <workspace-id>` resolves the one confirmed wedged `claude` target and kill+resumes it (`claude --resume`), headless or interactive (naming the id is the deliberate override). Same confirm-gate safety as the old always-on supervisor. Windows: escalate-only. |
| `companion/lib/devswarm-store.js` | Substrate lib (not a hook) | **OPTIONAL** — the persistent write/derive side of the DevSwarm substrate. ONE API, TWO backends chosen by feature-detecting `node:sqlite` (→ WAL sqlite, else an append-only NDJSON journal — dependency-free, green on Node 18/20 through 22/24). **Hooks never open the DB**: it derives a `summary.json` projection (atomic tmp+rename) that hooks read. Tracks messages/registry/cursors + per-workspace append-only completion `gates`, and derives `archive_ready` when all required gates (configurable, default `done,merged,tests_passed`) are met. anti-hall stays agnostic about what any consumer gate means. **(v0.70.0)** New read-side filter `archivedOnlyIds` excludes a genuinely archived workspace (`archived/<id>.json` present, `workspaces/<id>.json` absent) from the LIVE per-turn projection immediately, without waiting for a `doctor`/`update` migration run — an archived workspace with real unread still surfaces via the `orphans[]` pass (no lost signal); structurally cannot hide a live row (a live workspace has its own descriptor by definition), fails open to an empty set on any read error. **v0.84.0:** `computeSummary`'s orphan pass no longer reports partitions nothing can ever read — an ARCHIVED workspace with no live identity-family survivor is exactly the shape `healOrphanPartitions` classifies as `unhealable/archived-no-family` and deliberately never heals, so its unread could never drain and warned on every Primary turn forever. Those ids are now excluded via `companion/lib/devswarm-orphan-policy.js` (`makeArchivedStrandedTest`), which CALLS heal's own exported helpers rather than re-implementing the rule — `tests/companion/devswarm-orphan-policy-equivalence.test.js` fails CI if the two predicates ever drift. The count is preserved in a new quiet `archivedStranded[]`, not dropped, and the classifier fails open (an unclassifiable id stays in `orphans[]`). **v0.93.0:** `computeSummary` now also projects `archivedRegistryRows` (always an array, additive) so gate/inbox callers can fold app-archived-but-still-live senders into their known-registry set without a second read. **v0.94.0:** `resolveSenderRegistryId`'s final leg now delegates to `devswarm-attribution.js`'s `pickAttributionRow` (pure, liveness-free) instead of the freshest-live picker, so `pendingQuestions[].from` can no longer flip between passes for the same stored message. |
| `scripts/devswarm.js` | CLI (not a hook) | **OPTIONAL** — THE structured interface (CLI over MCP; stable JSON on stdout). Subcommands: `register`/`ensure`, `heartbeat`, `inbox count\|read\|ack` (the durable-inbox cursor primitive — `ack` is the parent-gate's non-skip clear path), `inbox pull` (child-side reception drain — auto-ensures the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate → at-most-one bounded `read-messages`, never `monitor` → atomic idempotent NDJSON append + store parity), `inbox messages`/`read-primary` + `ack-primary --receipt` (Phase 5: `read-primary` is read-only and returns an exact `ackCommand`; `drain-primary-legacy` keeps the one-call read-and-ack for one release) (Primary/store non-destructive read — bodies straight from the store, no descriptor needed; **ack-ownership guard, 0.56.0:** `--ack` refuses [`ok:false`] unless the caller's own identity, derived from cwd as ground truth, matches `<id>` — `DEVSWARM_BUILDER_ID` cannot override a *different* cwd-derived identity; pass `--ack-as-owner` for a legitimate cross-workspace ack), `workspaces list`, `gate --set/--clear`, `nudge`, `archive` (archive-by-absence on anti-hall's own registry — hivecontrol has no teardown command, so it SURFACES a manual "remove workspace in the DevSwarm app" step; never deletes; **v0.70.1:** `<id>` also resolves an unambiguous shortId/prefix, matching the id shown in the injection/roster table — an ambiguous prefix archives nothing and lists the candidates; `isSafeId` still gates), `archive-request` (**0.56.0**, PARENT-side send-only — posts a `[[ANTIHALL_ARCHIVE_REQUEST]]` message to the child via `hivecontrol workspace message-child`, asking it to archive; never verifies merged/tested/deployed itself, never archives on the child's behalf), `archive-ignore`/`archive-unignore`, `migrate` (`ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported legacy backlog as already-read). `command-guard` has a root-anchored LIGHT_EXCEPTION for it so the guard doesn't block its own wrapper. **v0.61.0 mesh self-heal:** drain-aware routing on `send` resolves to the partition a child is actually draining, plus a phantom-only rescue on the child's first mechanical self-register; new read-only `diagnose` (mesh-health detail: split/duplicate detection, orphans, stale partitions) and `healthcheck [--json]` (pass/fail, exit 0/2, for monitors/CI/the ingest daemon) verbs; register-time dedup filtered through a new `isForwardable` noise filter (forwards only real directs, never poke/hash-mirror junk); `roster`/`workspaces list`/`diagnose` are now pure reads (no `summary.json` write side-effect). **v0.62.0:** `unarchive <id>` (reverses `archive` — restores an archived descriptor + registry row); `migrate-owner-keys` (forward-migration backfilling/re-homing a descriptor's `ownerKey`, idempotent/fail-open/no-delete); `reap-stale [--yes|--confirm]` (dry-run-by-default reaper for descriptors verdicted stale/escalated, gated by fresh-heartbeat/recent-git-activity safety checks); `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes|--confirm]` (archives every current workspace NOT in an explicit active set, dry-run by default); `send --to` now ALSO accepts a row's own `id` (the registry primary key) as a fallback when the meshId match finds nothing, and `roster` now prints `meshId` alongside `id` on every row — closes an addressing footgun where a value copied straight from `roster` used to fail closed as `unregistered-recipient`; `reconcile` runs a mis-keyed/stray-registry-row self-heal pre-pass (`healRegistry`) before computing its drain targets, and `doctor --fix`/`update` ALSO sweep every per-project store for this directly (AUTO-SAFE, no DevSwarm-active gate needed), idempotent and no-delete. **v0.66.0:** `heartbeat` and `reconcile`'s aggregate `ok` no longer report success while a mesh broadcast failed or an individual drain target crashed/timed out — a genuinely absent hivecontrol is a benign skip, not a failure; `logs` now reads rotated history, not just the live file. **v0.67.0:** `spawn` sets a human-readable title after a successful `hivecontrol workspace create`, via a SEPARATE best-effort `hivecontrol workspace update-title -b <branch> "<title>"` call — the title is the caller's own `-t/--title` value when passed, else derived from the `-p` brief (first non-empty line, one leading markdown marker stripped, whitespace collapsed, full line kept — no length cap since v0.108.0); `spawn`'s pass-through of the original argv to `hivecontrol workspace create` is untouched. `reconcile` caches whatever label hivecontrol already has for a pre-existing workspace but never invents one for a workspace with no brief on record. **v0.106.0 fix:** an EARLIER cut of this treated "the caller already passed `-t`" as "titling is handled elsewhere" and skipped the `update-title` follow-up entirely for that case — `hivecontrol workspace create` does not itself apply a title, so `spawn <branch> -t "<title>"` came back `titled:false` and the roster fell back to the raw meshId for every explicitly-titled lane. `-t`/`--title` (both spacing and `=` forms) is now extracted and passed to the SAME `update-title` follow-up as any derived title, and the local name cache (`companion/lib/devswarm-names.js`) is written only once hivecontrol actually confirms it — never a hopeful guess. Any lane mistitled by the earlier bug self-heals on the next `reconcile` sweep (the supervisor already runs one periodically): its existing read-only name backfill reads hivecontrol's own `label` for any workspace still missing a cached name, so no new migration was needed. Fixed a raw NUL byte (a deliberate collision-proof sentinel key, offset 81252) that made `grep` treat the 245KB file as binary — replaced with the `\x00` escape, runtime string unchanged — and a `hasFlag` redeclaration collision where a new helper silently shadowed the pre-existing one and broke `--yes`/`--confirm` detection across `reconcile-active` and `reap-stale`. **v0.70.1:** `roster` now appends the same `dormant` hint (via `companion/lib/liveness.js`'s `isDormantActivity`) that `devswarm-parent-inbox.js`'s table uses, so the two can never disagree about which rows are still transacting. **v0.70.0 mesh/store hardening:** `foldArchivedRegistryRows` (new) folds ALL registry rows sharing an archived id's worktree (not just its own row) and picks the forward survivor by LIVENESS (`pickArchiveForwardSurvivor`), fixing a P0 where a real question could forward into a dead partition; ships as a dual-path migration wired into both `update.js` and `doctor --fix`'s `migrationFix('fold-archived-rows', ...)` — idempotent, fail-open-honestly, no-delete (message rows are never deleted, only registry rows are tombstoned after their unread forwards). `archive` also gained a descriptor-conflict self-heal (`archivedTombstoneIsOrphaned`, decided by inode not registry state, fail-closed on any incomplete scan) unblocking re-archive of an id whose `archived/<id>.json` was a stale leftover from a prior archive generation. **v0.71.0:** `register-primary`'s `--session` now defaults to `CLAUDE_CODE_SESSION_ID` (was the workspace hash), so a Primary registry row resolves its real transcript for liveness reads instead of a synthetic id nothing else recognizes. **v0.74.0:** `gate --set merged` now also runs a best-effort git-ancestry check (`companion/lib/devswarm-git-truth.js`'s `gitMergedInto`, HEAD vs. the resolved default branch) and persists the verdict as a separate `merged_verified` gate row alongside `merged` — REPORT-ONLY, the `merged` gate is set regardless of the verdict (a squash/rebase merge legitimately breaks ancestry even though the work IS merged); a resolved-false verdict prints a stderr warning and shows as `merged (unverified)` on the parent roster, an unresolvable check (no default branch / spawn failure) omits `merged_verified` entirely. **v0.75.0:** `inbox peek-primary` (new) — the non-acking counterpart to `read-primary`, same message-body read, `--ack` forced off, for checking status without advancing the ACK cursor. **v0.84.0 partition resolution follows the WORKSPACE, not the caller's cwd:** `inbox read-primary`/`inbox count` resolved the store partition from the caller's working directory, so a Primary could be told to drain mail it structurally could not see; resolution now comes from the workspace's registered project via the shared `registeredRepoKey` helper (precedence: fresh key → recorded `repoKey` → non-hash `ownerKey`). Also: `gate`/`ensure`/`archive` no longer re-home a foreign project's workspace (copying messages + registry rows, rewriting `ownerKey`, and in `archive`'s case removing the live descriptor) BEFORE their own ownership guard runs — a refused call now writes nothing; `inbox ack <foreign-id>` no longer advances the NDJSON cursor after the resolver already refused, which used to permanently skip that workspace's mail; and `inbox count`/`read` now report `known:false` plus the named `registeredRepoKey`/`callerRepoKey` instead of a silent zero indistinguishable from "no mail". **v0.85.0 archive retires the whole identity family:** `archive` tombstoned by `<id>` only, so a twin cross-linked by `sessionId` (one row's `sessionId` IS the other row's `id`) stayed live in `workspaces/` and kept the Stop gate nagging about an inbox that could never exist. `cmdArchive` now retires the whole family at archive time, plus a forward migration `foldArchivedFamilyDescriptors` (the descriptor-file counterpart of `foldArchivedRegistryRows`) wired into both `update` and doctor's AUTO-SAFE `fold-archived-family-descriptors` repair — idempotent, no-delete, fail-open-honestly, grouped by the id/`sessionId` cross-link ONLY (never bare worktree equality, so two live tabs on one worktree are never retired). Every retire requires PROVEN write authority: an inode+bytes generation fingerprint re-read inside the per-id lock and matched against the scan-time snapshot, plus a fail-closed `worktreeIsProvablyGone` gate on the migration path; a mismatch or unproven gone-ness refuses and is reported in `left[]` (surfaced by `update` and by a doctor `notice`) instead of reading as a clean no-op. `worktreePath` is now persisted absolute; legacy relative values fail closed. **v0.94.0 bounded reconcile + resume:** `reconcile` now applies a total wall-clock budget (`ANTIHALL_RECONCILE_BUDGET_MS`, default 60000ms, or `--budget-ms`; `0` = unlimited) across its per-row drains — a project with dozens of stale rows previously made `update.js`'s synchronous await hang for minutes (defect f3c1bc827d89). A row whose worktree no longer exists is skipped before it costs any budget; whatever is left when the budget runs out is deferred to a resume marker and prioritized first on the next sweep. **v0.95.0:** `diagnose` now resolves `sessionId` through the descriptor when the registry is stale, reporting a `descriptorSessionId` field on disagreement instead of surfacing the stale registry value as current; `unclaimed:` promotion derives the caller's real session id from `--session`, `CLAUDE_CODE_SESSION_ID`, or — only for a row still carrying the marker or lacking a sessionId — the harness's own session file found by walking the parent-pid chain (cwd-in-worktree check plus a pid-reuse/staleness liveness guard); descriptor/registry divergence is repaired in both directions, and a registry write failure during promotion is now reported as `promotion.registryWriteError` on `inbox pull`/`read-primary`/`inbox messages` output (plus a stderr line) instead of being swallowed — the next read repairs the registry from the descriptor. **v0.96.0:** `send`/fold target selection now uses a strict, heartbeat-aware liveness gate instead of a bare sessionId shape test (the fold/rehome paths are deliberately left on the older predicate); `callerOwnsRow`'s "sole row on this worktree" ownership proof now also requires that row be unclaimed. `send`/`heartbeat` results and every ownership refusal carry an additive `identity: {id, kind}`. `inbox ack` refuses the whole verb (instead of half-acking) on a resolvable ownership mismatch — an unresolvable-caller-identity or unregistered-caller shape still fails open. `diagnose` rows carry an additive `archivedInApp` field, forcing `live:false` even against a fresh heartbeat; the app-side archive-cache match now also requires `repositoryId` agreement when both sides carry one. `reconcile` skips a worktree whose git root cannot resolve (`skippedNotGitRoot`) and checks its own wall-clock budget before that git-root probe, not just before the resulting spawn. `update.js` applies one overall wall-clock budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default 90s) across every post-pull DevSwarm stage, deferring whole stages past the deadline. **v0.100.0 (P0 safety fix):** NO verb previously recognized `--help`/`-h` — `--help`/`-h` fell straight through to real dispatch, so `migrate -h` genuinely ran the migration and `merge --help`/`merge -h` genuinely forwarded to hivecontrol AND sent a live, unconditional mesh broadcast (a read-only-fenced diagnostic agent triggered this via a live defect report). `run()` now intercepts a help request (a `help`/`-h` positional anywhere, or `--help`) BEFORE the switch, covering every verb including the two raw-argv-tail pass-throughs (`spawn`/`merge`), with zero store opens, zero filesystem writes, zero child processes. The verb list backing top-level `help` output is derived from `run()`'s own switch statement (never hand-typed) so it cannot drift — a hand-typed list in the old default-branch error message had already drifted (`reconcile-registry`/`wake-directive` were real, dispatched verbs missing from it). Each verb's usage line names its concrete side effects when actually run. |
| `companion/lib/devswarm-names.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.67.0.** The shared fs-backed name cache behind human-readable workspace names: written by `devswarm.js` (`spawn`'s `update-title` call, `reconcile`'s pre-existing-workspace label cache) and read by `devswarm-parent-inbox.js`'s status table. Atomic tmp+rename write; a read failure fails open (falls back to the raw id). |
| `companion/lib/devswarm-git-truth.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.74.0.** Two independent, fail-open git ground-truth probes for a DevSwarm child worktree: `gitPushState` (unpushed-commit count + whether an upstream is even configured) and `gitMergeProof` / `gitMergedInto` (HEAD-vs-REMOTE-default-branch ancestry; the one merge proof shared by `gate --set merged` and auto-archive gate (b)). REPORT-ONLY throughout (auto-archive only withholds an archive on it) — `null` on any probe failure (never a fabricated fact), same argv-array `spawnSync` convention as `liveness.js`'s `defaultGitCommitTs`. Called from `devswarm-child-turn.js` (heartbeat push-state), `scripts/devswarm.js`'s `gate --set merged` (merged-gate verification) and `devswarm-lifecycle.js` gate (b). |
| `companion/lib/devswarm-identity-family.js` | Substrate lib (not a hook) | **OPTIONAL** — the ONE owner of identity grouping; pure (no fs/store/git), the caller performs every write. `familyKeyOf`/`collapseFamilies` group by resolved worktree for COUNTING. **v0.85.0** adds the mutating-side pair `crossLinkedIdentity`/`identityFamilyTwins` for archive, using a deliberately STRICTER predicate — one row's `sessionId` IS the other row's `id` — because worktree equality alone cannot justify a write (two legitimately-live tabs legitimately share one worktree). Kept in this module rather than at the archive call site so a second, parallel grouping rule cannot drift from the first. **v0.93.0** adds `recipientFamilyIds()` so sender attribution can exclude the recipient's own identity family before ranking candidate senders. |
| `hooks/lib/jev-assist.js` + `scripts/jev-report.js` | Shared module + CLI (not a hook) | **Jev metrics (v0.108.0).** Each Jev call logs its real cost (the gateway's reported cost, else tokens × the owner's `jev.prices` table, never invented) and cache hits cost $0. `jev-report.js` shows per-integration calls, precision from `tp`/`fp` labels (`jev-report.js label <hash> tp\|fp`), yield, cost efficiency, overhead and a headline; changed decisions are de-duplicated by content hash; the Vercel AI Gateway credit balance (15-min cache, report-time only). Opt-in budget watch (`jev.budget.mode=watch` + `usdPerDay`/`usdPerWeek`/`minCreditUsd`) only warns, never disables Jev. Opt-in audit snippets (`jev.audit.snippets`) store a redacted ~200-char snippet for decisions Jev changed; `jev-report.js prune-audit` trims them. |
| `scripts/defect.js` | CLI (not a hook) | **New in 0.78.0.** Durable, file-based two-way defect channel between agents running anti-hall in any repo and the anti-hall maintainer — deliberately NOT built on the mesh (bug reports about a messaging layer shouldn't travel through that layer). Subcommands: `report --class C --sev p0\|p1\|p2 --sym T [...]` (exits non-zero on every outcome but `recorded`/`occurrence-appended` — registry-full, occurrence-capped, defect-full, too-large, write-unverified, invalid-class, invalid-severity all fail loud), `list [--mine\|--open\|--unfinished]` (`--open` = `status === 'open'` only, untriaged;
`--unfinished` = every status except the closed set fixed/wontfix/notabug/dup, i.e. also
catches `ack`/`partial`/`regressed`), `show <fp>`, `rule <fp> --status ack\|fixed\|partial\|wontfix\|notabug\|dup` (maintainer-only, appends a ruling — `partial` carries `--fixed-in`/`--note` for a fix that shipped only in part and never derives as fully `fixed`; exits non-zero on anything but `ruled`), `archive` (rotation sweep: ruled-and-stale (30d) files move to `archive/<YYYY-MM>/`; open defects never move). Reports live in `~/.anti-hall/defects/`, one append-only NDJSON file per defect, filename-fingerprinted by defect class + normalized symptom (digit/hex runs stripped) so dedup falls out of the layout. An unknown flag on any subcommand is rejected (nothing written) rather than silently dropped; only `--sym-file`/`--repro-file` take file paths. **v0.84.0:** over-length fields are no longer silently truncated — the result JSON and stderr now name every cut field with its original length, and the caps for `note` (300 → 1200), `claimed`, and `observed` were raised. |
| `hooks/lib/defect-store.js` | Shared module (not a hook) | **New in 0.78.0.** Backing store for `scripts/defect.js` and `defect-nudge.js`. No index, no cached state — status, occurrence count, and first/last-seen are derived from a defect file's own lines on every read; status is the LAST ruling in append order (not by timestamp), so clock skew can't flip it. Every append is re-read and matched byte-exact before reporting success; an unconfirmed write reports `write-unverified` and exits non-zero. Nothing is ever deleted — ack/resolve append, rotation renames into an archive dir. Bounded: ≤200 open defects, ≤20 reports/defect, 64 KiB/file, 4 KiB/line, ≤1000 archived — every cap refuses with a distinct outcome. **v0.84.0:** the shared clamp used to cut a field at its cap and report plain success, with nothing in the result or the stored record to show text had been lost. It now returns a `truncated` map naming each cut field with its original length, and text fields carry a `[truncated from N chars]` marker inside the persisted value. `FIELD_CAPS` raised (`note` 300 → 1200, `claimed`/`observed` → 600, `repro` 1200) — bounded so a maximum-length field still cannot push a record past `MAX_LINE_BYTES` (4096). The write itself never fails. |
| `foldMeshDuplicates` (in `scripts/devswarm.js`) | Migration (not a hook) | **v0.61.0** — folds every prior mesh store shape (phantom rows, dual/legacy pairs, subdir-split registrations, stale entries) onto one canonical survivor per worktree, keyed by git-toplevel canonical identity (a child registered from a subdirectory now resolves to the same mesh identity as its toplevel). Idempotent, non-destructive (forward-before-tombstone; message rows are never deleted), fail-open. Wired into both `update.js` (runs post-update) and `doctor --repair`'s auto-safe repair (the dry-run detect pass doubles as a read-only mesh-shape check under `--check`, then applies). |
| `companion/lib/row-state.js` | Substrate lib (not a hook) | **OPTIONAL** — THE one read-side row-state derivation (mesh redesign Phase 4): `rowState()` answers `archived` / `app-archived` / `active` / `unknown` from anti-hall's archived marker, the app-side archived-set cache and the active descriptor, in that precedence; `isArchiveComplete`/`archiveCompleteIds` answer "the archive finished". Used by routing, the roster, `diagnose`, the parent Stop gate, the parent-inbox table and the store's registry filter so no two surfaces can disagree. Pure reads, fail-open. |
| `companion/lib/migrations.js` | Migration registry (not a hook) | **OPTIONAL** — the ONE registry of the all-store DevSwarm forward-migrations (fold-all-stores, heal-orphan-partitions, fold-archived-rows, fold-archived-family-descriptors) and their per-version completion marker (`~/.anti-hall/update-sweep-state.json`), shared by `doctor --repair`, `update` and the supervisor. A marked entry is skipped with one marker read; an unmarked one gets one live scan and is stamped only on a clean finish. Deletion-class repairs are `optIn` and never run from it. |
| `companion/devswarm-migrate.js` (+ `devswarm-ingest.js`) | Substrate lib / daemon (not a hook) | **OPTIONAL** — `migrate` dual-reads existing on-disk state (JSON registry + legacy NDJSON inboxes) into the store: **idempotent** (dedupe hash), **non-destructive** (reads sources only — legacy files stay byte-for-byte, rollback always possible), single-consumer-locked, and count-verified before it reports success. `devswarm-ingest.js` = the one supervised daemon wrapping the native `monitor` → store; refuses to start if another monitor consumer is running (lockfile), enforcing the single-native-consumer invariant. |
| `companion/install-devswarm-ingest.js` | Installer (not a hook) | **OPTIONAL — new in 0.54.1.** Installs/refreshes `devswarm-ingest.js` as a CONTINUOUS supervised daemon (unlike the periodic supervisor sweep): macOS LaunchAgent with `KeepAlive` (re-exec on exit), Linux `systemd --user` `.service` with `Restart=always` (cron fallback — every minute, restart-if-dead — when `systemctl` is absent; up to ~60 s revive gap on a cron-only Linux host after a crash). Distinct label (`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the supervisor. Idempotent; safe to install redundantly (the daemon's own single-consumer lock means only one instance ever runs). Windows: documented no-op (no pure-Node long-running user scheduler). **Autonomous refresh:** the `update` skill runs this installer's `how` command automatically (no offer, no ask) whenever an update happens inside an active DevSwarm session, same posture as the supervisor installer — closing the gap where the ingest daemon existed in code but nothing started it. **Cwd caveat:** the daemon drains the workspace of the git worktree it is INSTALLED FROM (`hivecontrol` resolves a workspace by cwd, not env) — the installer bakes that install-time worktree as the unit's `WorkingDirectory` and refuses to install if run from a non-git-worktree cwd. **v0.65.0:** root-caused an ENOENT storm — the daemon spawned `hivecontrol` by bare name while the service manager supplied only a minimal `PATH`, so every monitor cycle failed invisibly. The installer now discovers the binary once at install time and bakes it into the generated launchd/systemd/cron unit (never a hardcoded path); the daemon resolves it from an explicit option, `ANTIHALL_DEVSWARM_HIVECONTROL`, or `PATH`. Permanent faults (ENOENT/EACCES/ENOTDIR) now escalate through a capped backoff instead of storming the log, sliced so the heartbeat keeps writing. Orphaned ingest locks are swept on daemon start with positive-confirmation-only removal (a recycled pid or zombie holder no longer blocks restart forever; unknown holder states block by default). **v0.66.0:** a monitor batch that arrives but fails to parse is now logged and quarantined to disk instead of vanishing via the consume-on-read native queue (a well-formed empty result is still normal, not an error); the singleton supervisor unit now carries the same resolved `hivecontrol` path as the per-project units. **v0.86.0:** the v0.65.0/v0.66.0 fixes above were INCOMPLETE — baking the `hivecontrol` path fixed finding the CLI, but the emitted unit `PATH` never contained the directory of the ABSOLUTE node binary the unit bakes as its own interpreter, and `hivecontrol` is a SCRIPT whose shebang re-resolves `node` THROUGH `PATH`. The daemon started fine (absolute argv[0]) while every grandchild spawn died `env: node: No such file or directory`, exit 127 — 23,928 occurrences over 1,757 supervisor sweeps across three repoKeys, `healed:0` on all of them. `unitEnvFor` now prepends `dirname(execPath)` and requires `execPath`, so a unit's `PATH` cannot disagree with the interpreter baked into it; install refuses if that binary is not a real file. |

## Statusline, configuration/tuning, troubleshooting, and local testing (plugin)

Moved from plugins/anti-hall/README.md (v0.107.0 doc sweep).

## Statusline (opt-in, one command)

Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher whose **line 1 is the rich renderer for
ANY repo** (project name, git, model, context%, cost, duration, subagents). Line 1
also shows an **anti-hall version chip** (`AH: Vx.y.z`) between the
cost and email segments: `★` prefix in YELLOW for a new minor version, RED for a new
major version, plain dim when up-to-date (fail-open if no version-check cache exists).
Only if the rich renderer yields nothing does it fall back to a
monorepo-aware renderer (`.gitmodules`) or a **simple**
`model | branch | dir | context%` line. Line 2 is an always-on phase/context bar. No emojis.

**Consolidated mode (`--consolidate`):** pass `--consolidate` to merge with an existing
`statusLine` (e.g., the OMC HUD) instead of replacing it. The existing base is detected
from current settings or read from `ANTIHALL_STATUSLINE_BASE` (env), and is persisted to
`~/.anti-hall/consolidated-base.json` for subsequent sessions. Use this mode when you
already have another statusline and want anti-hall to extend it rather than overwrite it.

```bash
# Find the installed plugin dir and run the Node installer. Claude Code installs a
# plugin under the cache dir, versioned per marketplace/plugin
# (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ — for this plugin that is
# ~/.claude/plugins/cache/anti-hall/anti-hall/<version>/), but older layouts nest it
# under marketplaces/. We search all of them. A dir only counts if it contains the
# plugin manifest, so a parent dir is never mistaken for the plugin dir.
DIR=$(for d in \
  ~/.claude/plugins/cache/*/anti-hall/*/ \
  ~/.claude/plugins/cache/*/anti-hall/ \
  ~/.claude/plugins/cache/anti-hall/*/ \
  ~/.claude/plugins/cache/anti-hall/ \
  ~/.claude/plugins/marketplaces/*/plugins/anti-hall \
  ~/.claude/plugins/*/plugins/anti-hall \
  ~/.claude/plugins/*/anti-hall; do \
  [ -f "$d/.claude-plugin/plugin.json" ] && echo "$d"; done 2>/dev/null | head -1)
[ -n "$DIR" ] && node "$DIR/statusline/install-statusline.js" || echo "anti-hall not found under ~/.claude/plugins (cache or marketplaces) — install it first (/plugin install), then re-run, or locate the dir via /plugin."
```

**Cross-platform (Windows PowerShell / cmd / any OS with Node)** — the bash loop
above relies on glob expansion and `[ -f ... ]`, which a stock Windows shell lacks.
This pure-Node one-liner does the same search and runs the installer (identical on
any OS with Node; anti-hall itself is tested on macOS + Linux only — Windows is
untested and not officially supported, though this snippet has no POSIX-only calls):

```bash
node -e "const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(os.homedir(),'.claude','plugins');const isPlugin=d=>p.basename(d)==='anti-hall'&&fs.existsSync(p.join(d,'.claude-plugin','plugin.json'))&&fs.existsSync(p.join(d,'statusline','install-statusline.js'));const find=(d,n)=>{if(n<0||!fs.existsSync(d))return null;if(isPlugin(d))return d;let e=[];try{e=fs.readdirSync(d,{withFileTypes:true})}catch(_){return null}for(const x of e)if(x.isDirectory()){const r=find(p.join(d,x.name),n-1);if(r)return r}return null};const dir=find(root,6);if(!dir){console.error('anti-hall not found under '+root+' — install it first (/plugin install), or locate the dir via /plugin.');process.exit(1)}require('child_process').execFileSync(process.execPath,[p.join(dir,'statusline','install-statusline.js')],{stdio:'inherit'})"
```

To do it by hand, run `/plugin` to find the install path, then invoke the installer
directly: `node "<full-path>/anti-hall/statusline/install-statusline.js"`.

See `statusline/STATUSLINE.md` for details and how to revert.

## Settings (`/anti-hall:settings`)

Every user-facing anti-hall setting lives in ONE place: `~/.anti-hall/settings.json`,
organized into sections (`autoHandover`, `guards`, `jev`, `limitConserve`, `devswarm`,
`statusline`, `codexNudge`, `versionAlerts`, `updates`, `defects`). The declarative
registry of every setting (key, type, allowed values, default, env-var override, legacy
source, description) is `hooks/lib/settings-schema.js`; the read/write API is
`hooks/lib/settings.js`. Every `devswarm` knob's consumer takes an explicit `env`
parameter (for testability) rather than reading `process.env` directly; `settings.js`'s
`getWithEnv(section, key, dflt, env)` threads that SAME env through and derives `home`
from it (never `os.homedir()`), so a test's isolated HOME is always honored —
`tests/hygiene/settings-home-injection.test.js` proves this mechanically for every
wired resolver.

- **`/config` (arrow keys, no model involved)** — every non-advanced setting is a row in
  Claude Code's native `/config` panel (v2.1.269+). `userConfig` never declares `options`
  (a public plugin can't require v2.1.271+ just for its settings UI — declaring `options`
  on any field breaks plugin loading before v2.1.271, per the Claude Code plugin manifest
  docs), so enum settings render as a plain string field whose description lists the
  allowed values, not a picker; older Claude Code versions still work via the skill. There
  is no grouping field, so each row's title is prefixed with its section
  ("Auto Handover · Threshold %"). `plugin.json` `userConfig` is hand-kept and
  `tests/hooks/settings-schema.test.js` fails if it drifts from the schema's non-advanced
  set (key, type, default, min/max, title prefix) or if any field declares `options`.
  Advanced/tuning knobs stay off `/config`; use the CLI below.
- **Ask for it** — say "turn off the merge gate" or "set auto-handover to 80%" and the
  `settings` skill applies it with one `set` (no table dump); "show my anti-hall settings"
  prints the tables only when you ask.
- **CLI directly**:
  ```bash
  node plugins/anti-hall/scripts/settings.js show                      # every section, headline settings
  node plugins/anti-hall/scripts/settings.js show --section jev --all  # one section, including advanced/tuning knobs
  node plugins/anti-hall/scripts/settings.js get autoHandover.pct
  node plugins/anti-hall/scripts/settings.js set limitConserve.threshold 90
  node plugins/anti-hall/scripts/settings.js reset limitConserve.threshold
  ```
  Every subcommand takes `--json` for scripting.
- **Precedence** (highest to lowest): an `ANTIHALL_*` env var override → a value in
  `~/.anti-hall/settings.json` → a value set via Claude Code's native `/config` panel
  (every non-advanced setting, plus the DevSwarm auto-archive tuning pair, is declared in
  `plugin.json`'s `userConfig` so it shows up there; shown as Source `/config`) → a legacy per-feature config file
  (e.g. `~/.anti-hall/jev.json`) → the schema default. `show`'s Source column tells you
  which tier answered a given row.
- **Known limitation (`/config`):** a `/config` value that equals the manifest default
  (`plugin.json` `userConfig` default) is indistinguishable from "never set", so it counts as
  unset and a lower tier (a legacy file, the schema default) answers. To pin a value that
  equals the default, set it in `settings.json` (`/anti-hall:settings`) instead.
- **Legacy config is never deleted.** `~/.anti-hall/jev.json` (and any future
  per-feature config file the schema maps) keeps working as a fallback forever;
  `doctor --repair` and `/anti-hall:update` forward-migrate its values into
  `settings.json` once (idempotent, fail-open) via `companion/lib/migrations.js`, but
  the legacy file is left in place.
- **Codex parity**: the mirrored skill lives at
  `plugins/anti-hall/codex/skills/anti-hall-settings/SKILL.md` and drives the SAME CLI.
  Codex has no `AskUserQuestion` (the menu flow falls back to a numbered-choice prompt)
  and no plugin settings UI (no `userConfig` equivalent in the Codex manifest) —
  `~/.anti-hall/settings.json` via the skill/CLI is the only front door there, and it's the same file Claude Code's fallback path reads too.

### Every setting

Generated from `hooks/lib/settings-schema.js` (a hygiene test keeps this table and the schema in sync). "adv" = advanced (shown by `show --all`).

| Setting | Default | Env | Notes |
|---|---|---|---|
| `autoHandover.enabled` | `true` | — | Write an automatic handover before context runs out. |
| `autoHandover.pct` | `85` [1..99] | `ANTIHALL_AUTO_HANDOVER_PCT` | Context-usage percent that triggers an automatic handover. |
| `autoHandover.maxTokens` | `0` [0..] | `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS` | Opt-in absolute context-token ceiling that also triggers the handover, whichever of pct/maxTokens fires first; `0` (the default) = no ceiling — the real per-session window size (85% of it) is the only trigger unless a user explicitly sets this. |
| `autoHandover.nag` | `true` | — | Nag (remind) the user when a handover is due but not yet written. |
| `autoHandover.nagStepPct` | `5` [1..100] | — | Percent increments between successive handover nags. |
| `autoHandover.nagQuietMin` | `15` [1..] | — | Minutes to wait before repeating a handover nag. |
| `guards.mergeGate` | `false` | `ANTIHALL_MERGE_GATE` | Enable merge-readiness gate checks before merging. |
| `guards.shipitGate` | `false` | `ANTIHALL_SHIPIT_GATE` | Enable the ship-it workflow gate. |
| `guards.outputVerifyGuard` | `true` | `ANTIHALL_OUTPUT_VERIFY_GUARD` | Output-verification guard (blocks unverified completion claims). |
| `guards.failureRootCauseNudge` | `true` | `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE` | Nudge toward root-cause analysis after a failure. |
| `guards.repoSelfDrift` | `true` | `ANTIHALL_REPO_SELF_DRIFT` | anti-hall's own repo-drift self-check hook. |
| `guards.stashGuard` | `false` | `ANTIHALL_STASH_GUARD` | Arm stash-protection warnings in git-guard (also armed per-repo via .anti-hall/protected-stashes). |
| `guards.emitDedupe` | `true` | `ANTIHALL_EMIT_DEDUPE` | Deduplicate repeated hook-emit output. |
| `guards.editGuardAllow` adv | — | `ANTIHALL_EDIT_GUARD_ALLOW` | Extra allowed file globs for edit-guard (comma/colon separated). |
| `guards.allowSubagentMailbox` adv | `false` | `ANTIHALL_ALLOW_SUBAGENT_MAILBOX` | One-off allow for the subagent-mailbox command pattern. |
| `guards.reaperMatch` adv | — | `ANTIHALL_REAPER_MATCH` | Extra process-name pattern for the MCP session-end reaper. |
| `guards.reaperExclude` adv | — | `ANTIHALL_REAPER_EXCLUDE` | Excludes matching processes from the MCP reaper. |
| `guards.tasklistWorkThreshold` adv | `3` [1..] | `ANTIHALL_TASKLIST_WORK_THRESHOLD` | Minimum work items before tasklist-guard fires. |
| `guards.progressFreshMs` adv | `1800000` [0..] | `ANTIHALL_PROGRESS_FRESH_MS` | Freshness window (ms) for the progress file in tasklist-guard. |
| `guards.apiGuardThirdparty` adv | `false` | `ANTIHALL_API_GUARD_THIRDPARTY` | Also verify installed 3rd-party package APIs, not just stdlib/builtins. |
| `versionAlerts.antiHall` | `true` | `ANTIHALL_VERSION_ALERT` | Alert when a newer anti-hall version is available. |
| `versionAlerts.claudeCli` | `true` | `ANTIHALL_CLAUDE_CLI_VERSION_ALERT` | Alert when a newer Claude CLI version is available. |
| `versionAlerts.devswarm` | `true` | `ANTIHALL_DEVSWARM_VERSION_ALERT` | Alert when a newer DevSwarm/hivecontrol version is available. |
| `updates.quiet` | `false` | `ANTIHALL_UPDATE_QUIET` | Suppress update output (for scripted capture). |
| `updates.reconcileBudgetMs` adv | `60000` [0..] | `ANTIHALL_RECONCILE_BUDGET_MS` | Time budget (ms) for the reconcile step during update; 0 = unlimited. |
| `updates.postpullBudgetMs` adv | `90000` [0..] | `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS` | Time budget (ms) for the post-pull update sweep; 0 = unlimited. |
| `updates.sweepBudgetMs` adv | `20000` [0..] | `ANTIHALL_UPDATE_SWEEP_BUDGET_MS` | Overall time budget (ms) for the update sweep. |
| `limitConserve.mode` | `auto` (auto/on/off) | `ANTIHALL_LIMIT_CONSERVE` | Force conservation mode on/off, or auto-detect from the OMC usage cache. |
| `limitConserve.threshold` | `85` [1..99] | `ANTIHALL_LIMIT_THRESHOLD` | Usage percent that triggers conservation mode. |
| `limitConserve.accountCheck` adv | `true` | `ANTIHALL_LIMIT_ACCOUNT_CHECK` | Guard against stale usage-cache readings after an account switch. |
| `jev.enabled` | `false` | `ANTIHALL_JEV` | Enable Jev (ANTIHALL_JEV=0 always force-disables regardless of this). |
| `jev.transport` | `vercel` (vercel/typesafe) | — | Vercel AI Gateway passthrough (default) or a direct TypeSafe API call. |
| `jev.judgeModel` | `claude-haiku-4-5` | `ANTIHALL_JUDGE_MODEL` | Model used for speculation-judge / jev-triage LLM calls. |
| `jev.semanticJudge` | `false` | `ANTIHALL_SEMANTIC_JUDGE` | Enable the semantic speculation-judge hook (off = hook no-ops). |
| `jev.keyFile` adv | — | — | Credential key-file path (default depends on transport). |
| `jev.timeoutMs` adv | `1500` [1..3000] | — | Per-call timeout (ms), capped at 3000. |
| `jev.confidenceThreshold` adv | `0.85` [0..1] | — | Minimum confidence for a Jev answer to be trusted by callers. |
| `jev.triage` adv | `true` | — | Message-triage labeling once Jev is enabled. |
| `jev.triageUrgentThreshold` adv | `0.9` [0..1] | — | Confidence threshold for the urgent triage label. |
| `jev.budget.mode` | `unlimited` (unlimited/watch) | — | Jev spend: no limit, or warn when over budget (never auto-disables). |
| `jev.budget.usdPerDay` | — (>0) | — | optional: daily USD spend threshold, used only when budget.mode=watch. |
| `jev.budget.usdPerWeek` | — (>0) | — | optional: weekly USD spend threshold, used only when budget.mode=watch. |
| `jev.integrations.gitGuardSelfCredit` adv | `shadow` (on/shadow/off) | — | Jev check for paraphrased AI self-credit in commit/PR text (add-block only; never relaxes git-guard). |
| `jev.integrations.parentGateQuestion` adv | `shadow` (on/shadow/off) | — | Parent gate: treat an unread child message Jev already labelled a question as awaiting a reply (cache-only, no network). |
| `jev.integrations.tasklistTrivial` adv | `shadow` (on/shadow/off) | — | tasklist-guard: when on, a confident "small bounded chore" verdict (asked synchronously, 1.5 s cap, fail-open) skips the task-tracking nudge. |
| `jev.integrations.supervisorBlockerLabel` adv | `shadow` (on/shadow/off) | — | Supervisor report label: waiting-on-parent vs wedged, from cached triage labels (advisory, no network). |
| `jev.integrations.codexNudgeSubstantial` adv | `shadow` (on/shadow/off) | — | codex-nudge: when on, a confident "edits are trivial" verdict (asked synchronously, 1.5 s cap, fail-open) skips the Codex-review nudge. |
| `jev.weeklyNotice` | `true` | — | Once-a-week SessionStart scorecard notice naming one integration worth promoting or turning off (Jev enabled only). |
| `jev.audit.snippets` adv | `false` | `ANTIHALL_JEV_AUDIT_SNIPPETS` | Store a redacted ~200-char snippet for decisions Jev changed (off by default: privacy). |
| `jev.budget.minCreditUsd` | — (>0) | — | optional: warn (once a day, budget.mode=watch only) when the gateway credit balance drops below this USD amount. |
| `jev.prices` adv | — | — | computed: per-model USD price table {model: {inPerMTok, outPerMTok}} (or a "default" entry), used only when the gateway reports tokens but no cost. File-only (no env, no CLI set) — edit ~/.anti-hall/settings.json directly. |
| `devswarm.hivecontrol` | — | `ANTIHALL_DEVSWARM_HIVECONTROL` | Explicit path to the hivecontrol CLI binary (default: PATH lookup — no single default value; empty means "look it up"). |
| `devswarm.supervisorMode` | `auto` (auto/on/off) | `ANTIHALL_DEVSWARM_SUPERVISOR` | Force the DevSwarm supervisor context on/off, or auto-detect. |
| `devswarm.requiredGates` | `done,merged,tests_passed` | `ANTIHALL_DEVSWARM_REQUIRED_GATES` | Merge gates required for DevSwarm tasks. |
| `devswarm.inboxCmd` | — | `ANTIHALL_DEVSWARM_INBOX_CMD` | Consumer-configured command to read pending mesh messages (no built-in default). |
| `devswarm.childGateStrict` adv | `true` | `ANTIHALL_DEVSWARM_CHILD_GATE_STRICT` | Strict child-gate enforcement. |
| `devswarm.parentGateCap` adv | `3` [2..5] | `ANTIHALL_DEVSWARM_PARENT_GATE_CAP` | Caps the parent-gate wait/child count, clamped to [2,5]. |
| `devswarm.activeFloorPct` adv | `50` [0..100] | `ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT` | Min percent of active workspaces kept in the archived cache (0 disables the floor). |
| `devswarm.archivedCacheMaxAgeMs` adv | — [0..] | `ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS` | computed: no fixed default — 2x the reconcile sweep’s own resolved cooldown (itself env/default-derived), not a literal constant. |
| `devswarm.archivedGraceMs` adv | `600000` [0..] | `ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS` | Grace period (ms) before a workspace is considered archived. |
| `devswarm.cooldownSec` adv | `600` [0..] | `ANTIHALL_DEVSWARM_COOLDOWN_SEC` | Supervisor cooldown (sec) between recovery actions. |
| `devswarm.idleSec` adv | `900` [60..] | `ANTIHALL_DEVSWARM_IDLE_SEC` | Supervisor idle threshold (sec). |
| `devswarm.dormantMs` adv | `1800000` (>0) | `ANTIHALL_DEVSWARM_DORMANT_MS` | Dormant-workspace threshold (ms). |
| `devswarm.drainTtlMs` adv | `600000` [0..] | `ANTIHALL_DEVSWARM_DRAIN_TTL_MS` | TTL (ms) for the drain marker. |
| `devswarm.graceSec` adv | `5` [1..60] | `ANTIHALL_DEVSWARM_GRACE_SEC` | Grace window (sec) before recovery in devswarm-recover. |
| `devswarm.maxRecoveries` adv | `3` [1..20] | `ANTIHALL_DEVSWARM_MAX_RECOVERIES` | Max auto-recovery attempts. |
| `devswarm.intervalSec` adv | `90` [60..120] | `ANTIHALL_DEVSWARM_INTERVAL` | Sweep interval (sec) used at supervisor install time, clamped [60,120]. |
| `devswarm.migrateMarkRead` adv | `false` | `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ` | Mark migrated messages as read during state migration. |
| `devswarm.monitorTimeoutSec` adv | `30` [0..] | `ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC` | Bounded cadence (sec) for monitor timeout in devswarm-ingest. |
| `devswarm.nudgeCooldownSec` adv | `120` [0..] | `ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` | Cooldown (sec) between supervisor nudges. |
| `devswarm.nudgeMaxAttempts` adv | `2` [1..20] | `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` | Max nudge attempts before escalation. |
| `devswarm.nudgeWindowSec` adv | `180` [1..] | `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` | Window (sec) for counting nudge attempts. |
| `devswarm.postSpawnGraceSec` adv | `120` [0..1800] | `ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC` | Grace period (sec) right after spawning a child workspace, clamped [0,1800]. |
| `devswarm.reapedRetentionDays` adv | `30` (>0) | `ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS` | Retention window (days) for reaped-workspace logs. |
| `devswarm.receiptWindowMs` adv | `300000` [0..] | `ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS` | Window (ms) for parent-reply receipt tracking. |
| `devswarm.reconcileSweep` adv | `auto` (auto/off) | `ANTIHALL_DEVSWARM_RECONCILE_SWEEP` | Enable/disable the periodic reconcile sweep in the supervisor. |
| `devswarm.reconcileSweepSec` adv | `900` [300..] | `ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC` | Interval (sec) for the reconcile sweep, floor 300s. |
| `devswarm.rowStaleMs` adv | `86400000` [0..] | `ANTIHALL_DEVSWARM_ROW_STALE_MS` | Staleness threshold (ms) for workspace row selection. |
| `devswarm.sendReceiptRetentionDays` adv | `7` (>0) | `ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS` | Retention window (days) for send-receipt records. |
| `devswarm.summaryRetentionDays` adv | `30` [0..] | `ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS` | Retention window (days) for summary records. |
| `devswarm.wakeCron` adv | `*/30 * * * *` | `ANTIHALL_DEVSWARM_WAKE_CRON` | Wake-poll cron schedule override (treated as untrusted input). |
| `devswarm.wakeWatchPollMs` adv | `2000` [250..60000] | `ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS` | Poll interval (ms) for the wake-watch loop, clamped [250,60000]. |
| `devswarm.childGateRetentionDays` adv | `14` (>0) | `ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS` | Days a per-session child-gate state file is kept before the housekeeping/doctor sweep removes it. |
| `devswarm.housekeepingSweep` adv | `auto` (auto/off) | `ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP` | Supervisor disk-hygiene sweep (reaped logs, child-gate state); only "off" disables it. |
| `devswarm.housekeepingSweepSec` adv | `3600` [300..] | `ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC` | Seconds between housekeeping sweeps, floor 300. |
| `devswarm.supervisorLogRotateBytes` adv | `10485760` (>0) | `ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES` | Size at which the supervisor rotates its own log. |
| `devswarm.inboxGraceSec` adv | `120` [0..] | `ANTIHALL_DEVSWARM_INBOX_GRACE_SEC` | Grace window (sec) before a child's fresh unread is flagged, unless it heartbeats first; 0 = no grace. |
| `devswarm.supervisorSweepBudgetMs` adv | `20000` [0..] | `ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS` | Time budget (ms) for one supervisor sweep pass. |
| `devswarm.autoArchive.mode` | `on` (on/dry-run/off) | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE` | Auto-archive finished workspaces (needs DevSwarm ≥ 2.5.3). |
| `devswarm.autoArchive.idleMin` adv | `30` [5..] | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN` | Minutes idle before a finished workspace is eligible for auto-archive. |
| `devswarm.autoArchive.maxPerSweep` adv | `3` [1..20] | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MAX_PER_SWEEP` | Max workspaces auto-archived in one sweep. |
| `devswarm.retention.days` adv | `30` [0..] | `ANTIHALL_DEVSWARM_RETENTION_DAYS` | Days of message bodies kept before archive+prune; 0 = retention off. |
| `devswarm.retention.maxStoreMB` adv | `100` [0..] | `ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB` | Store size limit (MB): above it, oldest bodies are pruned regardless of age; 0 = no limit. |
| `devswarm.retention.keepPerPartition` adv | `200` [0..] | `ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION` | Newest messages per partition that are never pruned (age or size). |
| `devswarm.retention.archive` adv | `true` | `ANTIHALL_DEVSWARM_RETENTION_ARCHIVE` | Write pruned bodies to the gzip archive first (restorable via `devswarm.js retention restore`). |
| `devswarm.retention.archiveMaxMB` adv | `0` [0..] | `ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB` | Archive size cap (MB); 0 (default) = never evict; above a set cap the oldest archive months are dropped. doctor warns past 500 MB. |
| `statusline.base` | — | `ANTIHALL_STATUSLINE_BASE` | Shell command run as the line-1 base in consolidated statusline mode. |
| `statusline.noEmail` | `false` | `ANTIHALL_STATUSLINE_NO_EMAIL` | Suppress the email segment in the statusline. |
| `codexNudge.enabled` | `true` | `ANTIHALL_CODEX_NUDGE` | Enable the Codex hand-off nudge hook. |
| `codexNudge.min` adv | `3` [1..] | `ANTIHALL_CODEX_NUDGE_MIN` | Minimum substantial code-file edits before the nudge fires. |
| `defects.defaultProj` | — | `ANTIHALL_DEFECT_PROJ` | Default project tag used when filing an anti-hall defect (max 64 chars). |

## Configuration / tuning

- **Verify-first wording** — edit `hooks/verify-first-full.js` (the full SessionStart
  protocol) and the `NUDGES` array in `hooks/verify-first.js` (the per-turn one-liners).
- **Hard gates / force patterns** — `hooks/git-guard.js` holds the commit-trailer and
  force-push logic; `command-guard.js` and the other always-on guards cover deploy CLIs,
  payment commands, and bulk deletes at command dispatch. `ship-it` relies on these
  always-on guards for its hard safety boundaries rather than a bespoke per-project
  sentinel.
- **Task discipline** — edit the respective `hooks/*.js`. All hooks are
  fail-open: a bug in a hook must never wedge a turn.

## Troubleshooting / FAQ

- **Hooks not firing?** Restart Claude Code so a fresh session re-runs SessionStart,
  and ensure `node` is on `PATH` for the shell Claude Code launches hooks from
  (`node --version`). If `node` is missing, all hooks silently no-op.
- **Statusline didn't apply?** It is opt-in — run the installer above. If it reports
  "not found", run `/plugin install` first, then re-run, or locate the dir via `/plugin`.
- **git-guard let a force-push through?** Check the documented fail-open scope above
  (`xargs` / aliases / interactive-editor commits with no `-m`/`-F` are out of scope
  by design; `bash -c`/`sh -c`
  wrappers are unwrapped and inspected, not a bypass).
- **Using Codex too?** Copy `AGENTS.md` (repo root) into your own repo root — it is
  not bundled by `/plugin install`. Verify with
  `codex --ask-for-approval never "Summarize current instructions"`.

## Test locally

```bash
# Full zero-dependency E2E suite (node:test, run from the repo root):
node --test                                                                  # 2693 pass +2 skipped (2695 total); CI runs the same on push/PR (.github/workflows/test.yml)

# Quick smoke-checks of individual hooks:
echo '{"hook_event_name":"SessionStart"}' | node hooks/verify-first-full.js  # full Iron-Law protocol + skill primer
echo '{"prompt":"x"}' | node hooks/verify-first.js                           # short varying nudge (varies by full stdin envelope)
echo '{"prompt":"y"}' | node hooks/verify-first.js                           # different envelope -> different nudge
claude --plugin-dir /path/to/anti-hall                                       # load in a throwaway session
```

## Contributing
