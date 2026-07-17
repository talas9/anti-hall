---
name: anti-hall-devswarm
description: Explain anti-hall's optional DevSwarm integration from Codex — the hivecontrol reference KB, the workspace-tier orchestration doctrine (a Primary's top fan-out tier is a child workspace, not a subagent — doctrine + guard redirect shipped for both agents, no mechanical classifier), and the shipped layered recovery model (child self-report registered for both agents → Claude-only supervisor poke → Claude-only escalate-to-parent, automatic path NEVER kills, plus the on-demand devswarm-recover CLI — the only kill path). Use when the user asks about DevSwarm, hivecontrol, or the anti-hall liveness supervisor while working in Codex.
---

# anti-hall DevSwarm integration (Codex view)

anti-hall's DevSwarm support is **optional and feature-detected**, same model as the
OMC/OMX integration: dormant, zero effect, unless DevSwarm is actually in use. anti-hall
ships only generic pieces; any DevSwarm-consumer glue (inbox daemon, done-report
contract, `hivecontrol` wiring) is the downstream project's, not this plugin's.

DevSwarm itself is **agent-agnostic** — `DEVSWARM_AI_AGENT` names the active in-workspace
agent (`claude`, `codex`, …), so a Codex session can be running inside a DevSwarm
workspace too. What follows is what a Codex user needs to know about the four addons.

## The four addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the parent/child async message-passing model. Includes a parallel OMC/OMX table for the workspace tier (§8.4 of the KB): the workspace-create/merge surface is CLI-identical either way; only the in-workspace fan-out engine differs (Workflow tool + subagents for Claude, `omx team`/workers for Codex). Repo-clone-only — does not ship with a plugin install. |
| **Workspace-tier orchestration** | **Partially shipped: the DOCTRINE is live (both agents); mechanical enforcement is NOT built** | SHIPPED — a DevSwarm **Primary** is now proactively told that a **child workspace** is its top fan-out tier (above subagents) plus the choice rule, and the guard redirect names `node scripts/devswarm.js spawn <branch> -p "<brief>"` instead of "spawn a subagent". This reaches **Codex too**: the injecting hooks (`verify-first-orch.js` rule W, `verify-first.js`, `task-tracker.js`) and `command-guard.js` are the SAME files registered in `codex/hooks/hooks.json`. (`edit-guard.js` carries the same redirect but is Claude-only — it is not registered for Codex.) Gated on `isDevswarmActive() && !isChildWorkspace()`, so a CHILD workspace and any non-DevSwarm session are byte-identical to before. NOT BUILT — **no mechanical classifier** blocks a "workspace-scale" subagent spawn (deliberate: false positives would break legitimate subagent use), and the fuller design in `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md` (`devswarm-guard.js`/`devswarm-children.js`) still does not exist. |
| **Liveness supervisor (detect → poke → escalate, never kills)** | **Shipped — Claude-only** | `companion/devswarm-supervisor.js` + `install-devswarm-supervisor.js` + `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js`. The automatic background sweep. Recovers **wedged `claude` sessions specifically** (workaround for `claude-code#39755`) — it identity-binds to `claude -p --resume <uuid>` processes by argv, not Codex sessions. This section explains it for awareness; it is not a Codex-side capability. (`hooks/lib/devswarm-detect.js`/`hooks/lib/devswarm-role.js` are shared env-detection helpers, not supervisor-only — `hooks/devswarm-child-role.js`, the SessionStart child self-report hook, is now registered for **both** agents; see below.) |
| **On-demand recovery CLI (the ONLY kill path)** | **Shipped — targets `claude` processes only** | `companion/devswarm-recover.js`, invoked explicitly per workspace id. Still Claude-only in what it targets (see below), but a Codex-side operator can run it. |

## The layered recovery model, for Codex users

Why it exists: a `claude` session inside a DevSwarm child workspace can go **wedged** —
process alive, listener dead, no crash for a restarter to catch, no timeout event to
generate a new turn (`anthropics/claude-code#39755`, related `#28482`/`#33949`). The
automatic path handles this in three escalating layers and **never kills anything**:

1. **Child self-report** — the child workspace's `SessionStart` hook
   (`hooks/devswarm-child-role.js`) reminds an idle child to proactively report to its
   parent via the mesh CLI. Cooperative only — doesn't help a truly wedged child, which
   is what the next two layers are for. As of this port it is registered in
   `codex/hooks/hooks.json` too (same file, unmodified — its gate is
   `DEVSWARM_SOURCE_BRANCH` non-empty, which hivecontrol sets identically for a Codex
   workspace); it fires for **either** agent whenever it is a DevSwarm child session.
2. **Supervisor poke** — the background sweep detects a `stale` workspace (both outbound
   signals idle past threshold, plus a pending unread backlog) and fires an optional
   descriptor-supplied `nudgeCommand`, persisting verdict `nudged`.
3. **Escalate-to-parent** — once the poke budget is exhausted, the sweep persists verdict
   `escalated` (terminal — never re-targeted) and fires an optional `escalateCommand`.

If your DevSwarm setup mixes Claude and Codex workspaces (`DEVSWARM_AI_AGENT` differs per
workspace), all of the above only ever touches the `claude` ones — it identity-binds to a
`claude` process's argv session id and cwd. A Codex workspace is simply outside its
target surface; nothing here signals or resumes a Codex process.

## command-guard's destructive-read redirect (shipped v0.53.0, later hardened — applies to Codex too)

Unlike the recovery model above, this one is **not** Claude-only: `command-guard.js` is
a single file registered in both `codex/hooks/hooks.json` and the Claude hooks.json, so
its DevSwarm branch fires identically for a Codex workspace. Under a DevSwarm-active
session it redirects the two CONSUMING native `hivecontrol` inbox reads, in ALL contexts
(a delegated read drains the queue identically): **both** `hivecontrol workspace
monitor` (a no-timeout long-poll that hangs the shell and consumes the queue) **and**
`hivecontrol workspace read-messages` (marks-read/drains the queue) now block
UNCONDITIONALLY whenever DevSwarm is active — the original evidence-gated carve-out for
`read-messages` (`ANTIHALL_DEVSWARM_INBOX_CMD` / a descriptor's `inboxPath`) has been
removed: a raw native `read-messages` desyncs the durable cursor regardless of whether a
durable inbox exists, so it is now treated exactly like `monitor`. Non-destructive
`message-count` is untouched — but as of v0.58, `message-parent`/`message-child` are
**not** untouched anymore, see the next section. Own `devswarm-read-guard` skip name (in
skip-guard's `DESTRUCTIVE` set — a blanket `all` skip does not cover it). Full detail:
`docs/KB-devswarm-hivecontrol.md` §8.5.

A second guard closes the RAW-file-read hole (`cat`/`head`/`grep`/… of the durable
inbox/store — doesn't drain the native queue, but desyncs the durable cursor and
violates the store's write/derive layering). The shell-verb form is caught by
`command-guard.js` itself — **shared, so this fires on Codex too.** The dedicated
`Read`-tool guard (`hooks/inbox-read-guard.js`) is **Claude-only** (not registered in
`codex/hooks/hooks.json` — it guards Claude's own `Read` tool specifically). Full
taxonomy: `docs/KB-devswarm-hivecontrol.md` §8.5.

## command-guard's native-SEND block — v0.58 "mesh-only messaging" (applies to Codex too)

A SEPARATE, newer guard branch from the destructive-read redirect above, but with the
**same shared-file mechanics**: `hivecontrol workspace message-child` and `hivecontrol
workspace message-parent` — the two native SEND subcommands — are now guard-blocked
UNCONDITIONALLY whenever DevSwarm is active, in ALL contexts. `command-guard.js` is the
single file registered on both platforms and the DevSwarm-active gate it depends on
(`hooks/lib/devswarm-detect.js`) keys off `DEVSWARM_REPO_ID`, which hivecontrol sets
per-workspace regardless of which agent runs there — **so this block fires identically
for a Codex session's Bash tool calls**, exactly like the destructive-read redirect
above. This is a **REPLACE**, not a parallel option: anti-hall's shared mesh store is now
the SOLE agent-initiated messaging transport for DevSwarm coordination on the Claude
side — native per-worktree messaging is superseded. Own skip name `devswarm-send-guard`
(independent of `devswarm-read-guard`), honors `DISABLE_ANTIHALL_DEVSWARM=1`. The block's
reason redirects to the mesh CLI: `node scripts/devswarm.js send --to-primary --message
"<text>"` (or `--to <meshId>`) / `node scripts/devswarm.js heartbeat <id> --summary
"<text>"`.

**Now carries over to Codex too (corrected):** the PROACTIVE per-turn reminder that keeps
the mesh top-of-mind (injected by `devswarm-child-role.js`/`devswarm-child-turn.js`/
`devswarm-parent-inbox.js`) was previously undocumented for Codex on the premise that these
hooks' gating `DEVSWARM_*` env vars were Claude-only. That premise was wrong —
`docs/KB-devswarm-hivecontrol.md` §6/§8.7 (live-verified env fingerprint) states
`DEVSWARM_REPO_ID`/`DEVSWARM_SOURCE_BRANCH`/`DEVSWARM_BUILDER_ID` are set by hivecontrol
per-workspace regardless of agent — `DEVSWARM_AI_AGENT` is the separate var naming
claude vs codex — the same fact §8.5/§8.7 already established for `command-guard.js`'s own
DevSwarm gate above. All three hooks (plus the SessionStart `devswarm-child-role.js` and
the Stop-side `devswarm-parent-gate.js`/`devswarm-child-gate.js`) are now registered in
`codex/hooks/hooks.json`, unmodified, alongside the guard-block. A Codex agent inside an
active DevSwarm workspace is therefore mechanically PREVENTED from sending a native message
AND gets the same proactive mesh reminder every turn that a Claude session gets — see
"Always-listening reception" below. Full detail: `docs/KB-devswarm-hivecontrol.md` §8.5's
v0.58 bullet and §8.7's "v0.58 mesh-only messaging" note.

## Child-side reception — `devswarm.js inbox pull` (shipped, v0.54.2)

Since the native reads are guard-redirected, the safe way a child RECEIVES parent messages
is `node scripts/devswarm.js inbox pull <DEVSWARM_BUILDER_ID>` — a bounded, guard-safe
one-shot drain (`command-guard`'s root-anchored `LIGHT_EXCEPTION` for `scripts/devswarm.js`
allows it inline; the CLI wrapper is invokable from either agent). It auto-ensures the
descriptor, then runs ONE pull: a **non-destructive `message-count` gate first** (count `0`
→ never calls `read-messages`), and only on count `>0` a single **bounded** `read-messages`
(finite 10 s timeout, **never `monitor`**), appended to the durable inbox NDJSON in one
atomic, hash-idempotent write plus a store-parity feed. **Residual limitations (honest):**
(1) `read-messages` marks-read BEFORE the durable append, so a crash in that window loses
the native messages — the count-gate minimizes but cannot close it (hivecontrol has no
non-destructive full read); a failed append surfaces `ok:false`, no partial NDJSON. (2)
Pull-not-push: reception latency = one turn (no background child drainer). The drain module
(`companion/lib/devswarm-pull.js`) and the durable inbox are Claude-side companion state, but
the CLI itself runs identically either way. Full detail: `docs/KB-devswarm-hivecontrol.md`
(v0.54.2 note).

## Always-listening reception + archive flow (registered for both agents; CLI is agent-agnostic)

Two v0.56.0 additions:

- **Always-listening reception (now registered on both platforms).** `hooks/devswarm-child-turn.js`
  (child, `UserPromptSubmit`) and `hooks/devswarm-child-gate.js` (child, `Stop`) were previously
  undocumented for Codex on the disproven "Claude-only env var" premise (see the correction
  above) — they are now registered in `codex/hooks/hooks.json`, the same unmodified files. For
  either agent it now (1) mechanically writes/refreshes the child's own descriptor every turn
  (fixes #31 — the parent previously couldn't discover a child that never itself ran the
  registration command), and (2) escalates unread-parent messages to IMPERATIVE priority
  wording, backed by a Stop-gate that force-blocks until the durable inbox shows no unread
  backlog — with an optional STRICT fallback probe (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`,
  default ON) that additionally checks a bounded, non-destructive `hivecontrol workspace
  message-count` when the durable check alone shows nothing.
- **Archive flow — REVISED v0.58: now a direct store write, not a hivecontrol call.**
  anti-hall never archives mechanically. PARENT role: after verifying
  merged+tested+deployed **per your own repo's policy** (anti-hall does not check this),
  run `node scripts/devswarm.js archive-request <childId> [--reason TEXT]`. Pre-v0.58 this
  resolved a child branch and posted via `hivecontrol workspace message-child` — as of
  v0.58 it instead appends the `[[ANTIHALL_ARCHIVE_REQUEST]]`-marked message DIRECTLY into
  `<childId>`'s own mesh store partition (zero `hivecontrol` calls; `--child-branch` is
  gone). **Caveat — this now depends on the same repoKey mesh store the v0.57 mesh note
  below still describes as not yet officially Codex-documented:** the script itself has no
  agent affinity (plain Node, no Claude-specific API) and nothing stops a Codex session
  from invoking it directly, but treat it with the same "not yet promoted for Codex"
  posture as `send`/`roster`/`mesh read` below until that status changes. CHILD role: on
  seeing that marker in an unread message, confirm with YOUR user, then run
  `node scripts/devswarm.js archive <id>` (unaffected by v0.58, still agent-agnostic and
  store-independent). (The CHILD side's automatic marker-detection/surfacing, above, runs via
  `devswarm-child-turn.js`, now registered for both agents — no manual scan needed on Codex
  either.)

## #32 — retiring a competing native-queue consumer (applies to both agents)

If parent↔child messages seem to vanish or the durable inbox disagrees with what was actually
sent, the likely cause is a **second process** — outside anti-hall entirely — also calling
`hivecontrol workspace monitor`/`read-messages` against the same queue (a leftover cron job,
`launchd`/`systemd`/`pm2` unit, shell loop, or `package.json` script). This is agent-agnostic:
neither the Claude nor the Codex side of `command-guard.js` can see or block a process outside
its own tool-call surface. **anti-hall CANNOT mechanically detect or kill an external
non-tool-call consumer — identification + your own cleanup are the only levers.** Full
identify → stop → verify recipe: `docs/KB-devswarm-hivecontrol.md` §8.7.2 (`ps aux | grep
'hivecontrol.*monitor'` → kill the PID + remove its respawn config → re-run
`node hooks/doctor.js`).

## Codex mesh support: v0.57.1 (not yet shipped) — v0.58 adds a mechanical exception

The Claude-side plugin shipped a **v0.57 mesh** substrate, folded into the **v0.58.0**
release (no separate `v0.57` tag was ever cut): a shared per-project `repoKey` store
(instead of per-worktree), new daemon-independent CLI verbs (`send`/`roster`/`mesh read`/
`heartbeat --summary`), a ONE-per-project ingest daemon, and a #36-STRUCTURAL cross-project
scoping fix. **None of this is officially documented/promoted for the Codex/OMX port
yet** — this SKILL.md's CLI reference below still omits `send`/`roster`/`mesh read` and the
per-project daemon is not described as covering a Codex-run workspace. Codex mesh support
as a DOCUMENTED, promoted capability is planned for **v0.57.1** (owner decision O-D3,
deliberately deferred out of v0.57 to ship the Claude-side work first).

**v0.58 "mesh-only messaging" adds new verbs on the SAME mesh store** (`send --to-primary`,
`reconcile`, `spawn`, `merge`, and a REVISED `archive-request` that now writes the store
directly instead of calling hivecontrol) — same documentation-status caveat as the v0.57
verbs above: technically callable by a Codex session (the script has no agent affinity),
but not yet promoted here. **The one exception — mechanical, not a documentation
choice:** v0.58's `command-guard.js` native-SEND block (`message-child`/`message-parent`
guard-blocked) is NOT gated by this Codex-mesh-support status at all — it fires for a
Codex session today, unconditionally, because `command-guard.js` is the single shared hook
file both platforms register (see the section above). A Codex agent in an active DevSwarm
workspace is mechanically blocked from a native send RIGHT NOW, independent of whether the
mesh CLI itself is "officially" Codex-supported yet — it just isn't told to use the mesh
CLI proactively (that reminder is a Claude-only hook, per the section above). Until
v0.57.1 formally ships, do not tell a Codex user `send`/`roster`/`mesh read`/`reconcile`/
`spawn`/`merge` are RECOMMENDED for their workflow, and do not claim the per-project daemon
covers a Codex-run workspace — but do NOT claim the native messaging path still works for
them either; it does not. Full detail: `docs/KB-devswarm-hivecontrol.md` §8.7's "v0.57 mesh
follow-up" and "v0.58 mesh-only messaging" notes.

## Operating the mesh: daemon + CLI reference

The structured interface (CLI over MCP) is agent-agnostic — invokable identically from a
Codex or Claude session (`node "$ANTI_HALL_ROOT/scripts/devswarm.js" <cmd> ...`, with
`$ANTI_HALL_ROOT` resolved as shown below). This is the complete operational reference so
nothing here is ever improvised against raw sqlite/NDJSON. Every verb emits one JSON line
on stdout, exit `0`=`ok:true`/`2`=`ok:false`; every `<id>` is `isSafeId`-gated
(`^[A-Za-z0-9._-]+$`). Full narrative + source-line citations + a worked lifecycle example:
`docs/KB-devswarm-hivecontrol.md` §8.8 (or the identical fuller reference in
`plugins/anti-hall/skills/devswarm/SKILL.md`, the Claude mirror of this skill).

### The daemons

| Daemon | Purpose | Health signal | Install |
|---|---|---|---|
| **Ingest daemon** (`companion/devswarm-ingest.js`) | The ONE native consumer — wraps `hivecontrol workspace monitor` under an O_EXCL single-consumer lock and folds every drained message into the shared per-project store. Agent-agnostic (it just wraps hivecontrol; nothing about it cares which agent runs in a workspace). Never run manually. | Two-signal health (`companion/lib/ingest-health.js`'s `daemonHealth`): `healthy` requires BOTH a fresh heartbeat AND a live-pid lock holder; otherwise `stale`; `unsupported` on win32. | `node companion/install-devswarm-ingest.js` (`--uninstall`/`--dry-run`). macOS LaunchAgent / Linux systemd `--user` service (`Restart=always`, cron fallback) / Windows no-op. Log: `~/.anti-hall/devswarm-ingest.log`. **PER-PROJECT** — install once per repo. |
| **Liveness supervisor** (`companion/devswarm-supervisor.js`) | Opt-in periodic sweep (default 90s): computes liveness per published descriptor, pokes then escalates a stale workspace — **never kills**. **Claude-only in what it targets** — it identity-binds to `claude --resume` processes by argv, so a Codex workspace is outside its recovery surface even though the sweep itself runs the same way. | Verdict file `~/.anti-hall/devswarm/liveness/<id>.json`. | `node companion/install-devswarm-supervisor.js` (`--uninstall`/`--dry-run`). Claude-side setup; see "Activation" below. |

Both installers are re-run automatically by the `update` skill whenever it detects an
active DevSwarm session. The **on-demand `devswarm-recover.js` CLI** (the only path that
ever kills a process) is a third, explicitly-invoked script — Claude-side tooling (it
resumes a `claude` process), but a Codex-side operator can still invoke it directly
against a `claude` workspace's id (see "On-demand recovery" below).

### Every CLI verb — `scripts/devswarm.js`

Agent-agnostic (plain Node, no Claude-specific API) unless noted. **Promotion-status
caveat:** the v0.57/v0.58 mesh verbs (`send`, `roster`, `mesh read`, `heartbeat
--summary`, `diagnose`, `healthcheck`, `reconcile`, `spawn`, `merge`, and the REVISED
`archive-request`) are technically callable identically from a Codex session — nothing
in the script itself is Claude-specific — but are **not yet officially promoted/
recommended for a Codex workflow** (see "Codex mesh support" above); the table below is
the operational truth regardless of promotion status.

| Verb | Exact args | What it does | When an agent uses it | Read-only / Writes |
|---|---|---|---|---|
| `register <id> --worktree P --session S [--inbox P] [--cursor P] [--nudge T]...` | `--worktree`/`--session` **required** | Write a workspace descriptor + upsert the store registry; retires same-worktree duplicate rows. | Explicit first registration of a workspace. | **Writes.** |
| `ensure <id> [--worktree P] [--session S] [--inbox P] [--cursor P]` | none required | Idempotent register-if-absent; re-upserts + retires duplicates every call. | Steady-state self-heal (what `inbox pull` auto-runs every turn). | **Writes.** |
| `register-primary [--worktree P] [--session S] [--inbox P] [--cursor P]` | none required | Register the CURRENT worktree's Primary descriptor under `primary-<hash>`. | Primary one-time setup, or ahead of `migrate`. | **Writes.** |
| `heartbeat <id> [--progress N] [--phase X] [--wip T]... [--blockers T]... [--session S] [--summary TEXT [--urgency ...]]` | none required; `--summary` opts into a mesh broadcast | Turn-authored heartbeat file; `--summary` also broadcasts a mesh status ping (ownership-checked). | Every turn, self-reported status. | **Writes.** |
| `inbox pull <id> [--session S]` | none required | CHILD-side: auto-ensures the descriptor, ONE bounded guard-safe native-queue drain (count-gate → at-most-one `read-messages`, never `monitor`) into the durable inbox + store. Runs send-time daemon self-heal first. | Every child turn — the sanctioned way to receive. | **Writes.** |
| `inbox read <id>` | none | Durable-inbox cursor read, no ack. | Check what's pending without consuming it. | Read-only. |
| `inbox count <id>` | none | Durable-inbox unread count only. | Cheap pre-check before `inbox read`. | Read-only. |
| `inbox ack <id> [--to N]` | `--to` = ack to absolute count; omitted = ack-all | Advance the durable-inbox cursor. | After processing durable-inbox messages. | **Writes.** |
| `inbox messages <id> [--unread] [--ack] [--ack-as-owner]` | none | Primary/store non-destructive read — no descriptor needed, never touches the native queue. **Ack-ownership guard (v0.56.0):** `--ack` refuses unless the caller's own cwd-derived identity provably owns `<id>` (`DEVSWARM_BUILDER_ID` cannot override a different cwd-derived identity). `--ack-as-owner` overrides for a legitimate cross-workspace ack. | Primary/observer reading a workspace's store-backed inbox. | Read-only unless `--ack` (then **writes**). |
| `inbox read-primary <id> [--ack-as-owner]` | none | `inbox messages <id> --unread --ack` under one name. | Primary consuming+acking in one call. | **Writes.** |
| `workspaces list [--workspace <id>] [--worktree P]` | none | Emit the `summary.json` projection. Pure `computeSummary` read (#62 fix — no longer writes on a plain read). | Full projection dump including gates/`archive_ready`. | **Read-only.** |
| `gate <id> --set CSV --clear CSV` | at least one required | Mark/unmark named completion gates; drives `archive_ready`. | Consumer marking `done`/`merged`/`tests_passed` etc. | **Writes.** |
| `nudge <id>` | none | Poke-or-escalate one workspace on demand. | Manual on-demand nudge outside the automatic sweep. | **Writes.** |
| `archive <id>` | none | Archive-by-absence: descriptor to `archived/`, tombstone the registry row; surfaces a manual DevSwarm-app removal step. | Workspace lifecycle complete (CHILD role, after confirming with your user). | **Writes.** |
| `unarchive <id>` | none | Reverses `archive`: restores the descriptor from `archived/` back to active (crash-safe hardlink-then-unlink) and revives the store registry row. Rejects if the archived descriptor's ownerKey doesn't match the current project, or if a conflicting active descriptor already exists. | Un-archiving a workspace archived by mistake, or resuming one still needed. | **Writes.** |
| `archive-ignore <id>` / `archive-unignore <id>` | none | Mute/unmute the archive-ready reminder. | Suppress a nag already triaged. | **Writes.** |
| `archive-request <childId> [--reason TEXT]` | none required | Direct STORE WRITE (v0.58, zero `hivecontrol` calls): posts `[[ANTIHALL_ARCHIVE_REQUEST]]` straight into `childId`'s own partition. Never verifies merged/tested/deployed itself. | PARENT asking a child to archive, after verifying per your own policy. | **Writes.** |
| `migrate` | none | Idempotent, non-destructive, count-verified fold of legacy on-disk state into the store. `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks imported backlog as already-read. | Upgrading from a pre-store install, or recovering a stranded legacy inbox. | **Writes.** |
| `migrate-owner-keys` | none | **Forward-migration (v0.62.0), idempotent/fail-open/no-delete.** Scans every active + archived descriptor: backfills a missing `ownerKey`, and re-homes an ACTIVE descriptor still stranded under a stale hash-keyed store bucket into its fresh `repoKey`-keyed bucket. Wired into both `update.js` (post-update) and `doctor`'s auto-safe repair. | Manually forcing the ownerKey backfill/re-home, or auditing a store's ownerKey health. | **Writes.** |
| `send --to <meshId>\|--to-primary\|--broadcast --message TEXT [--from <id>] [--urgency low\|normal\|high\|urgent]` | exactly one of `--to`/`--to-primary`/`--broadcast`; `--message` required | Daemon-independent direct write into the shared store — the mesh's SOLE agent-initiated messaging transport. Fail-closed on an unregistered target; `--from` must match derived identity if given. | Any agent-to-agent or agent-to-Primary message. | **Writes.** |
| `roster [--ack]` | none | This project's registry + `working_on` + a `recent[]` broadcast digest, folded with a read-only native-children view. Pure `computeSummary` read. | Get the current mesh state / who's doing what. | **Read-only** (plain); **writes** the broadcast cursor with `--ack`. |
| `mesh read` | none | Alias of `roster --ack`. | Same as `roster --ack`, named for discovery. | **Writes.** |
| `diagnose` | none | **Read-only mesh-health projection.** Per-row live/unread state, `send`-routing resolution, orphan partitions, stale registry rows, split worktrees. Pure read, zero writes. | Debugging "why didn't my message arrive", or pre-fold inspection. | **Read-only.** |
| `healthcheck [--json]` | none | **Scriptable PASS/FAIL gate over the same data `diagnose` computes.** `{ok, status:'ok'\|'degraded', counts:{orphans,stale,splits,phantoms,unreadTotal}}`. Degraded iff `orphans>0 \|\| stale>0 \|\| splits>0` (phantoms/unreadTotal never gate). No `--json` prints one compact human line. | Monitors/CI wanting a pass/fail exit code, or a quick status line. | **Read-only.** |
| `reconcile` | none | Drains every registered worktree's inbox once (per-id subprocess, cwd'd into that worktree). Does NOT dedup/fold registry rows. Auto-run by `update`/`doctor --fix`, both DevSwarm-session-gated (see the auto-heal note below). | Sweeping stranded per-worktree native queues into the shared store on demand. | **Writes.** |
| `reap-stale [--yes\|--confirm]` | project-scoped (git cwd required) | **PARENT-driven reaper (v0.62.0).** Scopes to this project's descriptors verdicted `stale`/`escalated`, gated by two safety checks (a fresh heartbeat or recent worktree git activity both mean never-reap). Dry-run by default (`{candidates, skipped}`); `--yes`/`--confirm` archives survivors via `cmdArchive`'s own pre-archive revalidation. | A parent clearing genuinely-abandoned child workspaces without hand-checking each one. | **Read-only in dry-run; writes with `--yes`/`--confirm`.** |
| `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes\|--confirm]` | `--active` required unless `--allow-empty` | **Parent-driven reconciliation against an explicit active set (v0.62.0)** — archives every current workspace of this project NOT named in `--active`/`--stdin` (matches sparing, never archiving, on prefix/substring); refuses an empty set unless `--allow-empty`. Dry-run by default; `--yes`/`--confirm` applies. | Reconciling the mesh against a known-good "what's actually still running" list. | **Read-only in dry-run; writes with `--yes`/`--confirm`.** |
| `spawn <branch> [hivecontrol create flags...]` | pass-through | Thin wrap of `hivecontrol workspace create`, then best-effort auto-registers the new worktree in the shared registry. | Primary creating a new child workspace. | **Writes.** |
| `merge [hivecontrol merge-into-source flags...]` | pass-through | Thin wrap of `hivecontrol workspace check-merge` + `merge-into-source`, then broadcasts the outcome. | Child finishing / shipping upstream. | **Writes.** |

`roster`, `diagnose`, and `healthcheck` are the three pure-read, no-id, project-scoped
verbs — reach for these together for mesh state without touching anything.

**`reconcile`/fold auto-heal — a separate, ALREADY-shared code path, not a mesh
promotion.** `doctor.js` and `update.js` are the SAME scripts on both platforms (see
`anti-hall-doctor`/`anti-hall-update`), so their `reconcile` + `foldMeshDuplicates`
auto-heal wiring runs identically for a Codex session — subject to the SAME "DevSwarm
gate is effectively always closed for gpt-5.x Codex/OMX sessions" caveat as every other
daemon-touching GATED repair (the `DEVSWARM_*` env vars are set only for `claude` child
sessions hivecontrol spawns), so in practice it stays a no-op there today, same as the
ingest/supervisor fixes.

### How to READ mesh health — never hand-read the store

Use `diagnose` (full detail) or `healthcheck` (pass/fail + exit code) — **never** open
the sqlite/NDJSON store files directly (`cat`/`grep`/a raw file read against
`~/.anti-hall/devswarm/store/**` or `inbox/**`). The store is backend-selectable
(NDJSON journal or sqlite via `ANTIHALL_DEVSWARM_STORE_BACKEND`), a raw read bypasses the
cursor/derive layering the CLI's own read verbs keep consistent, and the store may
literally be the append-only journal backend that only `companion/lib/devswarm-store.js`
knows how to interpret correctly. Mechanically enforced on both platforms:
`command-guard.js` blocks raw shell reads of these paths (shared hook, fires identically
for a Codex Bash call); the Claude-only `hooks/inbox-read-guard.js` additionally blocks
Claude's own `Read` tool. This is a real-incident lesson, not a hypothetical: a real
DevSwarm Primary fell back to querying raw sqlite because the CLI hadn't yet surfaced
`roster`/`diagnose`/`healthcheck` clearly enough — don't repeat that.

### Self-heal behavior — don't hand-fix the registry

The mesh self-heals continuously; never manually "fix" a duplicate registration, a stuck
daemon, or a stale row:

- **Register-time dedup** (`retireWorktreeDuplicates`, inside every `register`/`ensure`
  call — including the auto-`ensure` every `inbox pull` performs): folds a duplicate/
  phantom/subdir-split row for the SAME worktree into the caller's own live partition,
  forwarding unread backlog first, never touching a row with its own on-disk descriptor.
- **Orphans/stale rows surface, never auto-fix** — `diagnose`/`healthcheck`'s
  `orphans[]`/`staleRegistryPartitions[]` are deliberately never auto-forwarded or
  auto-deleted, only surfaced for a human/parent to see.
- **Send-time daemon self-heal.** `send`/`inbox pull`/`archive-request` each check this
  project's ingest-daemon health first; if stale/missing and DevSwarm is active, they
  best-effort re-spawn the installer (60s cooldown) — never blocking the caller's own
  action.
- **Updater/doctor fold sweep** (`update` and `doctor --repair`): runs `reconcile` then
  `foldMeshDuplicates` — the same dedup generalized over the whole registry — as an
  AUTO-SAFE pure store operation (no DevSwarm-active gate needed for the fold itself).

An agent's job is to call the CLI normally — register/`ensure`/`inbox pull` self-heal on
every call, `update`/`doctor` sweep the rest — never to open the store and patch a row by
hand.

### Messaging rule

The mesh is the **ONLY** agent-initiated messaging channel on either platform. Native
`hivecontrol workspace message-child`/`message-parent` are guard-blocked unconditionally
whenever DevSwarm is active (`command-guard.js`, shared — fires identically for Codex).
Report via `heartbeat <id> --summary TEXT`; direct-message via `send --to-primary`/`send
--to <meshId>`; broadcast via `send --broadcast`; check mesh state via
`roster`/`diagnose`/`healthcheck`/`inbox read-primary <id>` — subject to the promotion-
status caveat above for a Codex session today.

**Ack-ownership guard (v0.56.0).** `inbox messages --ack` / `inbox read-primary` refuse
(`ok:false`, cursor untouched) unless the caller's own identity matches `<id>` — identity
is derived from **cwd as ground truth**: a git worktree resolves to its own workspace id,
and a `DEVSWARM_BUILDER_ID` env value naming a *different* workspace is IGNORED (never
trusted to override), closing an env-spoof path where a workspace could impersonate
another workspace's identity to ack its cursor. Pass `--ack-as-owner` to override for a
legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog on
its behalf).

## On-demand recovery — devswarm-recover CLI

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
node "$ANTI_HALL_ROOT/companion/devswarm-recover.js" <workspace-id>
```

This is **the only place in DevSwarm that ever kills a process** — the automatic sweep
above never does. It's Claude-side tooling (it identity-binds to and resumes a `claude`
process), but **a Codex-side operator in a mixed OMC/OMX DevSwarm setup can run it
directly** against a `claude` workspace's id — there's nothing Claude-only about invoking
the script itself, only about what it targets. Naming the id on the command line is a
deliberate override: unlike the automatic sweep, this CLI will also target an
**interactive** `claude` session (not just headless), under the same confirm-gate safety
(exactly-one-or-abstain, identity + cwd re-confirmed immediately before every signal,
single-writer lock, a recovery cap before it escalates instead). Windows: escalate-only,
never kills. Full detail (safety invariants, resume guardrail, env) lives in
`plugins/anti-hall/skills/devswarm/SKILL.md` (the Claude mirror of this skill).

## Activation (Claude-side; for awareness)

If you're the one wiring up a mixed OMC/OMX DevSwarm setup and need the automatic
supervisor active for the Claude side, the install command and full activation contract
(per-workspace descriptor at `~/.anti-hall/devswarm/workspaces/<id>.json` — `id`,
`worktreePath`, `sessionId` required; `inboxPath`/`cursorPath` load-bearing; optional
`nudgeCommand`/`escalateCommand` argv arrays for Layers 2–3; env gates
`DISABLE_ANTIHALL_DEVSWARM=1` / `ANTIHALL_DEVSWARM_SUPERVISOR`; the
`ANTIHALL_DEVSWARM_NUDGE_*` tuning vars) live in `plugins/anti-hall/skills/devswarm/SKILL.md`.
The `update` skill on the Claude side autonomously installs/refreshes this supervisor
whenever it detects it's running inside an active DevSwarm session — no separate step
needed once that side is set up. As of 0.54.1, the same autonomous-refresh posture also
covers `companion/install-devswarm-ingest.js` — the one supervised daemon wrapping
`hivecontrol workspace monitor` into the substrate store (`companion/devswarm-ingest.js`,
shipped 0.54.0). It runs continuously (macOS LaunchAgent `KeepAlive` / Linux `systemd
--user` `Restart=always` `.service`, cron fallback with a ~60s worst-case revive gap on a
cron-only Linux host), distinct label/log from the supervisor, and is Claude-side
tooling like the rest of this section — for awareness on a mixed OMC/OMX setup, not a
Codex-side capability. **Scope note (applies regardless of which agent is running in
which workspace):** the daemon is PER-PROJECT, not per-machine — its identity (label/
unit/lock/own reception workspace id) is derived from the worktree it was installed
FROM, since `hivecontrol` itself resolves a workspace by walking up from the process's
cwd, not by id. A mixed setup with multiple DevSwarm repos on one machine needs this
installer run once per repo; a repo with no install of its own has zero ingest coverage,
whether its workspaces run Claude or Codex agents. Full detail:
`docs/KB-devswarm-hivecontrol.md` §8.7.

Outputs to watch either way: `~/.anti-hall/devswarm/liveness/<id>.json` (per-workspace
verdict — `alive`/`stale`/`nudged`/`ambiguous`/`escalated`), `~/.anti-hall/devswarm/recovery.log`
(append-only attempt/poke/escalate log), and `node hooks/doctor.js` (silent unless
DevSwarm is active; `nudged` reports as WARN, not a failure).

## Anti-hall + OMX workflow mapping

- Workspace tier (doctrine shipped, no mechanical classifier): a Primary's top fan-out
  tier is a CHILD WORKSPACE — `node scripts/devswarm.js spawn <branch> -p "<brief>"` (thin
  wrap of `hivecontrol workspace create`) — not a subagent; subagents/`omx team` workers are
  for lookups, single commands, scoped investigations and review passes. CLI-identical
  between agents (`… -a codex` vs `… -a claude`); only the in-workspace fan-out differs
  (`omx team`/workers vs Workflow tool + subagents). The injected doctrine + the
  `command-guard.js` redirect that name this fire for a Codex Primary too (shared hook
  files); see `anti-hall-orchestration` for the choice rule.
- Mechanical per-turn override/reassert hooks (`devswarm-child-role.js`,
  `devswarm-child-turn.js`, `devswarm-parent-inbox.js`, `devswarm-parent-gate.js`,
  `devswarm-child-gate.js`): registered for **both** agents (corrected — see "The layered
  recovery model, for Codex users" above).
- Liveness supervisor + on-demand recovery CLI: still Claude-only in what they target — the
  supervisor identity-binds to `claude --resume` processes specifically. No Codex-side
  equivalent exists in this plugin, though the recovery CLI script itself is invokable from
  either side (see the on-demand recovery section above).

Anti-hall does not replace OMX. Anti-hall supplies verify-first policy, the reference KB,
and (for both agents) the mechanical per-turn recovery hooks; the liveness supervisor stays
Claude-side. OMX supplies Codex-native orchestration/workflow runtime.
