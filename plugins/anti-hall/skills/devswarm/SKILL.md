---
name: devswarm
description: Explain and activate anti-hall's optional DevSwarm integration — the hivecontrol reference KB, the workspace-tier orchestration doctrine (a Primary's top fan-out tier is a child workspace, not a subagent — doctrine + guard redirects shipped, no mechanical classifier), and the shipped layered recovery model (child self-report → supervisor poke → escalate-to-parent, automatic path NEVER kills) plus the on-demand devswarm-recover CLI (the only path that ever kills). Use when the user asks "explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor", "recover a stuck DevSwarm workspace", or anything about hivecontrol / DevSwarm workspaces from an anti-hall angle.
---

# DevSwarm integration

anti-hall's DevSwarm support is **entirely optional and feature-detected** — the same
model as its OMC/OMX integration. Nothing here changes behavior unless DevSwarm is
actually in use (`DEVSWARM_REPO_ID` set, or a published workspace descriptor exists).
anti-hall ships only generic, project-agnostic pieces; any DevSwarm-consumer-side glue
(an inbox daemon, a done-report contract, `hivecontrol` wiring) belongs to whatever
project is running DevSwarm, not to this plugin.

## The four addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the async message-passing coordination model. Repo-clone-only (like all `docs/`, it does not ship with `/plugin install`). |
| **Workspace-tier orchestration** | **Partially shipped: the DOCTRINE is live; mechanical enforcement is NOT built** | SHIPPED — a DevSwarm **Primary** is now told, proactively and at every dispatch point, that a **child workspace** is its top fan-out tier (above subagent/Explore/Workflow) and given the choice rule: `hooks/verify-first-orch.js` (rule W, SessionStart), `hooks/verify-first.js` + `hooks/task-tracker.js` (per turn), and the two guard redirects — `hooks/edit-guard.js` / `hooks/command-guard.js` now name `node scripts/devswarm.js spawn <branch> -p "<brief>"` as the Primary's exit instead of "spawn a subagent". Gated on `isDevswarmActive() && !isChildWorkspace()`, so a CHILD workspace and any non-DevSwarm session see byte-identical output to before. NOT BUILT — there is **no mechanical classifier**: nothing detects "this Agent spawn is workspace-scale" and blocks it (deliberate: false positives would break legitimate subagent use), and the fuller design in `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md` (a `devswarm-guard.js` / `devswarm-children.js` enforcement layer) does not exist. Enforcement today = the existing guard BLOCK + a corrected redirect; the tier choice itself is the model's. |
| **Liveness supervisor (detect → poke → escalate, never kills)** | **Shipped** | `companion/devswarm-supervisor.js`, `companion/install-devswarm-supervisor.js`, `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js`, `hooks/lib/devswarm-detect.js`, `hooks/lib/devswarm-role.js`, `hooks/devswarm-child-role.js`. The automatic background sweep. See "The layered recovery model" below. |
| **On-demand recovery CLI (the ONLY kill path)** | **Shipped** | `companion/devswarm-recover.js`. Invoked explicitly, per workspace id, by an operator (or a parent orchestrator acting on an escalation). See "On-demand recovery" below. |

## command-guard's destructive-read redirect (shipped v0.53.0, later hardened to an unconditional block)

Separate from the four addons above — this lives in the always-on `command-guard.js`
hook, not in the DevSwarm companion. Under a DevSwarm-active session, `command-guard`
redirects the two CONSUMING native `hivecontrol` inbox reads, in ALL contexts (a
delegated subagent read drains the queue identically): **both** `hivecontrol workspace
monitor` (a no-timeout long-poll that hangs the shell and consumes the queue) **and**
`hivecontrol workspace read-messages` (marks-read/drains the queue) now block
UNCONDITIONALLY whenever DevSwarm is active — `read-messages` no longer has a
durable-inbox-evidence carve-out (a raw native read desyncs the durable cursor
regardless of whether a durable inbox exists, so it is treated exactly like `monitor`
now). Non-destructive `message-count` is untouched — but **`message-parent`/`message-child`
are NO LONGER untouched as of v0.58**, see the next section; they are now blocked too,
just by a separate guard branch.
It has its own `devswarm-read-guard` skip name (in skip-guard's `DESTRUCTIVE` set, so a
blanket `all` skip does not cover it) and is fail-open. Use `devswarm.js inbox pull` /
`inbox read` / `inbox messages` instead (see the CLI reference below).

## command-guard's native-SEND block — mesh-only messaging (v0.58, REPLACE not redirect)

A SEPARATE guard branch from the destructive-read redirect above: `hivecontrol workspace
message-child` and `hivecontrol workspace message-parent` — the two native SEND
subcommands — are now guard-blocked UNCONDITIONALLY whenever DevSwarm is active, in ALL
contexts (coordinator and subagent alike — a delegated send writes the native queue
identically). This is a **REPLACE**, not a parallel option: anti-hall's shared mesh store
(below) is now the SOLE agent-initiated messaging transport for DevSwarm coordination —
native per-worktree messaging has no `from`/`to`/broadcast fields and cannot address a
specific sibling, only a parent/child pair, so rather than keep two competing send paths
this collapses to one. Lifecycle verbs (`create`/`list`/`check-merge`/`merge`) and the
read-only `message-count` counter are explicitly OUT of scope and stay default-allow —
breaking those would break DevSwarm spawn/merge. Own skip name `devswarm-send-guard`
(independent of `devswarm-read-guard` and command-guard's own skip), honors
`DISABLE_ANTIHALL_DEVSWARM=1`. The block's reason redirects to the mesh CLI: `node
scripts/devswarm.js send --to-primary --message "<text>"` (or `--to <meshId>`) to
direct-message, `node scripts/devswarm.js heartbeat <id> --summary "<text>"` to report
status. Fires on both platforms — `command-guard.js` is the single shared hook file, so a
Codex Bash tool call is blocked identically — but the PROACTIVE per-turn reminder that
keeps the mesh top-of-mind (below) is Claude-only; a Codex session only learns this
reactively, at the moment it attempts a native send. Full detail:
`docs/KB-devswarm-hivecontrol.md` §8.5's v0.58 bullet.

A companion guard closes the same hole for RAW file reads of the durable inbox/store
(`cat`/`head`/`grep`/… via Bash, or the `Read` tool) — those don't drain the native
queue, but bypass the durable cursor (cursor desync) and violate the store's
write/derive layering. `command-guard.js` itself catches the shell-verb form (both
platforms); a Claude-only PreToolUse hook, `hooks/inbox-read-guard.js`, catches a
direct `Read` tool call (not mirrored to Codex — it guards Claude's own `Read` tool).
`inbox/**` is always denied; the store's db/journal files are denied once a Primary
read path exists to serve the same data (`inbox messages`, below — already shipped).
Everything else under `~/.anti-hall/devswarm/` (`summary.json`, `cursors/**`,
`workspaces/**`, `liveness/**`, `heartbeats/**`, `locks/**`) is unaffected. Full
detail (including the exact taxonomy and why raw reads are blocked at all — the
single-native-consumer invariant): `docs/KB-devswarm-hivecontrol.md` §8.5/§8.7.1.

## Child-side reception — `devswarm.js inbox pull` (shipped, v0.54.2)

Because the native reads (`monitor`/`read-messages`) are guard-redirected, a child needs a
**safe** way to actually RECEIVE parent messages. That is `node scripts/devswarm.js inbox
pull <DEVSWARM_BUILDER_ID>` — a bounded, guard-safe one-shot drain (`command-guard`'s
root-anchored `LIGHT_EXCEPTION` for `scripts/devswarm.js` allows it inline). It auto-ensures
the child's descriptor, then runs ONE pull: a **non-destructive `message-count` gate first**
(count `0` → it never calls `read-messages`), and only on count `>0` a single **bounded**
`read-messages` (finite 10 s timeout, **never `monitor`**), appended to the durable inbox
NDJSON in one atomic, hash-idempotent write plus a store-parity feed. The per-turn child hook
statically nudges the child to run this pull, then read the drained messages the non-draining
way (`inbox read`). **Residual limitations (honest):** (1) `read-messages` marks-read BEFORE
the durable append, so a crash in that window loses the native messages — the count-gate
minimizes but cannot close it (hivecontrol has no non-destructive full read); a failed append
surfaces `ok:false` and writes no partial NDJSON. (2) It is pull-not-push: reception latency =
one child turn (no background child drainer — a child cannot host the blocking `monitor`
daemon). Full detail: `docs/KB-devswarm-hivecontrol.md` (v0.54.2 note).

## Always-listening reception (child, per turn)

The child-side reception loop above is **continuous, not one-shot**: `hooks/devswarm-child-turn.js`
fires on every child `UserPromptSubmit` and (1) mechanically writes/refreshes the child's own
descriptor (`workspaces/<DEVSWARM_BUILDER_ID>.json`) every turn — fixing #31, where the parent
previously couldn't see all its children because nothing wrote that descriptor for the child
side — and (2) checks the child's OWN durable inbox for unread parent messages, injecting an
**IMPERATIVE PRIORITY** segment (not advisory) when `count > 0`: "STOP and address these parent
message(s) FIRST before continuing." Registration is MERGE-preserving (an existing
`inboxPath`/`cursorPath` set by a prior `inbox pull` is never clobbered) and fail-open (a
descriptor-write failure never blocks or crashes the turn).

The **Stop-side gate** (`hooks/devswarm-child-gate.js`) backs this up so a child cannot simply
ignore the per-turn nudge and go idle: it force-blocks Stop (capped, self-resetting) until the
child's own durable inbox shows no unread backlog. By default it also runs a bounded **STRICT**
fallback probe — a single non-destructive `hivecontrol workspace message-count` call (5 s
timeout) — to catch a native backlog the child never `inbox pull`ed yet; `ANTIHALL_DEVSWARM_CHILD_GATE_STRICT=0`
disables that fallback probe and leaves only the pure-fs durable-inbox check. Both checks are
fail-open (any probe error → not blocked).

## Archive flow — both roles

anti-hall never archives a workspace mechanically. Teardown is always a two-sided, human-confirmed
handoff:

- **PARENT role.** Before asking a child to tear down, the Primary must VERIFY the workspace is
  merged, tested, and deployed **per the parent repo's OWN policy, using its own tooling** —
  anti-hall does not and cannot check this (it stays pure fs, no git/test/gh spawn). Once
  satisfied, run:
  ```bash
  node scripts/devswarm.js archive-request <childId> [--reason "TEXT"]
  ```
  **As of v0.58 this is a direct STORE WRITE, not a `hivecontrol` call.** Pre-v0.58 this
  resolved the child's branch and posted through `hivecontrol workspace message-child
  <branch> <msg>` — the one native-messaging leak the command-guard's Bash-text matcher
  could never catch (a spawned `message-child` call is invisible to a guard classifying
  only the Bash tool-call text). Now `childId` is directly the target's own store
  partition (the same semantics `heartbeat <id>`/`inbox read <id>` already use), so the
  `[[ANTIHALL_ARCHIVE_REQUEST]]`-prefixed message is appended straight into that
  partition (`urgency:'high'`) — zero `hivecontrol` calls, no branch resolution, no
  `--child-branch` flag (removed — there is no branch lookup left to override). It never
  verifies merged/tested/deployed itself and never runs `archive` on the child's behalf.
  The Primary is
  independently nudged toward this flow every turn once the store derives a workspace
  `archive_ready` (all required completion gates met) — see `devswarm-parent-inbox.js`'s
  archive-ready segment. **If competing native-queue consumers make reception unreliable, see
  §8.7.2 in the KB before relying on this flow** — the "second consumer" retirement recipe.
- **CHILD role.** A child always receives parent messages via the wrapper (`inbox pull`, above)
  — unread parent messages are surfaced as **PRIORITY** and may interrupt whatever the child is
  currently doing. On seeing the `[[ANTIHALL_ARCHIVE_REQUEST]]` marker in an unread message
  (detected by both `devswarm-child-turn.js`'s per-turn scan and the Stop-gate's own check), the
  child must **confirm with its own user first**, then run:
  ```bash
  node scripts/devswarm.js archive <id>
  ```
  **NEVER auto-archive.** anti-hall never archives mechanically on either side of this
  handshake — the CLI only ever archives-by-absence on anti-hall's own registry (moves the
  descriptor to `archived/`, tombstones the store entry) and surfaces a manual "remove
  workspace in the DevSwarm app" step, because hivecontrol itself has no teardown command.

## Operating the mesh: daemon + CLI reference

This is the complete operational reference for a workspace agent: the two background
daemons and every `scripts/devswarm.js` verb, so nothing here is ever improvised against
raw sqlite/NDJSON. Every verb emits one JSON line on stdout, exit `0`=`ok:true`/
`2`=`ok:false`; every `<id>` is `isSafeId`-gated (`^[A-Za-z0-9._-]+$`). Full narrative +
source-line citations + a worked lifecycle example: `docs/KB-devswarm-hivecontrol.md` §8.8.

### The daemons

| Daemon | Purpose | Health signal | Install |
|---|---|---|---|
| **Ingest daemon** (`companion/devswarm-ingest.js`) | The ONE native consumer — wraps `hivecontrol workspace monitor` under an O_EXCL single-consumer lock and folds every drained message into the shared per-project store (content-hash deduped, replay-safe). Never run manually; it's a supervised background job. | Two-signal health (`companion/lib/ingest-health.js`'s `daemonHealth`): `healthy` requires BOTH a fresh heartbeat AND a live-pid lock holder; otherwise `stale`; `unsupported` on win32 (no daemon possible there — mesh store + CLI still work fine). | `node companion/install-devswarm-ingest.js` (`--uninstall` / `--dry-run`). macOS LaunchAgent (`KeepAlive` relaunch, label `com.anti-hall.devswarm-ingest`); Linux `systemd --user` service (`Restart=always`, cron fallback if no systemd, ~60s worst-case revive gap); Windows documented no-op. Log: `~/.anti-hall/devswarm-ingest.log`. **PER-PROJECT** — install once per repo you want covered, not once per machine. |
| **Liveness supervisor** (`companion/devswarm-supervisor.js`) | Opt-in periodic sweep (default 90s, 60–120s tunable): computes liveness per published workspace descriptor, pokes a stale workspace (Layer 2) then escalates (Layer 3) — **never kills**. Workaround for `claude-code#39755`. Never run manually. | Verdict file `~/.anti-hall/devswarm/liveness/<id>.json` (`alive`/`stale`/`nudged`/`ambiguous`/`escalated`); `node hooks/doctor.js` runs a live self-test (fresh workspace → `alive`, a wedged fixture → `stale`). | `node companion/install-devswarm-supervisor.js` (`--uninstall` / `--dry-run`, `ANTIHALL_DEVSWARM_INTERVAL=<sec>` tunes cadence). macOS LaunchAgent, Linux systemd timer + cron fallback, Windows detection-only no-op. Log: `~/.anti-hall/devswarm-supervisor.log`. |

Both installers are re-run automatically by the `update` skill whenever it detects an
active DevSwarm session (idempotent refresh, not just first-install) — an agent normally
never has to think about installing these by hand after first activation. The **on-demand
`devswarm-recover.js` CLI** (the only path that ever kills a process — see "On-demand
recovery" below) is a third, explicitly-invoked script, not a daemon.

### Every CLI verb — `scripts/devswarm.js`

| Verb | Exact args | What it does | When an agent uses it | Read-only / Writes |
|---|---|---|---|---|
| `register <id> --worktree P --session S [--inbox P] [--cursor P] [--nudge T]...` | `--worktree`/`--session` **required** | Write a workspace descriptor + upsert the store registry; retires same-worktree duplicate rows. | Explicit first registration of a workspace. | **Writes.** |
| `ensure <id> [--worktree P] [--session S] [--inbox P] [--cursor P]` | none required | Idempotent register-if-absent — leaves an existing descriptor untouched, still re-upserts the registry + retires duplicates every call. | Steady-state self-heal (what `inbox pull` auto-runs every turn). | **Writes.** |
| `register-primary [--worktree P] [--session S] [--inbox P] [--cursor P]` | none required | Register the CURRENT worktree's Primary descriptor under its per-worktree id `primary-<hash>` (never a shared `'primary'`). | Primary/parent one-time setup, or ahead of `migrate` to fold a legacy Primary inbox. | **Writes.** |
| `heartbeat <id> [--progress N] [--phase X] [--wip T]... [--blockers T]... [--session S] [--summary TEXT [--urgency low\|normal\|high\|urgent]]` | none required; `--summary` opts into a mesh broadcast | Turn-authored heartbeat file — never fabricates an unsupplied field. `--summary` ALSO broadcasts a mesh status ping (ownership-checked: refuses if the caller doesn't provably own `<id>`). | Every turn, self-reported status. | **Writes.** |
| `inbox pull <id> [--session S]` | none required | CHILD-side: auto-ensures the descriptor, then ONE bounded guard-safe native-queue drain (non-destructive `message-count` gate → at-most-one `read-messages`, never `monitor`) into the durable inbox + store. Runs send-time daemon self-heal first. | Every child turn — the sanctioned way to receive. | **Writes.** |
| `inbox read <id>` | none | Durable-inbox cursor read (unread lines), no ack. | Check what's pending without consuming it. | Read-only. |
| `inbox count <id>` | none | Durable-inbox unread count only. | Cheap pre-check before `inbox read`. | Read-only. |
| `inbox ack <id> [--to N]` | `--to` = ack to absolute count; omitted = ack-all | Advance the durable-inbox cursor. | After processing durable-inbox messages. | **Writes** (cursor file). |
| `inbox messages <id> [--unread] [--ack] [--ack-as-owner]` | none | Primary/store non-destructive read — bodies straight from the store, no descriptor needed, never touches the native queue. **Ack-ownership guard (v0.56.0):** `--ack` refuses (`ok:false`) unless the caller's own cwd-derived identity provably owns `<id>` (`DEVSWARM_BUILDER_ID` cannot override a *different* cwd-derived identity). Pass `--ack-as-owner` for a legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog). | Primary/observer reading a workspace's store-backed inbox. | Read-only unless `--ack` (then **writes** the store cursor + refreshes `summary.json`). |
| `inbox read-primary <id> [--ack-as-owner]` | none | `inbox messages <id> --unread --ack` under one name — same ack-ownership guard. | Primary consuming+acking in one call. | **Writes.** |
| `workspaces list [--workspace <id>] [--worktree P]` | none | Emit the `summary.json` projection for a project (defaults to the current worktree's own store). Pure `computeSummary` read (fixed under #62 — no longer writes `summary.json` on a plain read, unlike some older docs/specs claim). | Full projection dump including gates/`archive_ready`. | **Read-only.** |
| `gate <id> --set CSV --clear CSV` | at least one of `--set`/`--clear` required | Mark/unmark named append-only completion gates; drives `archive_ready`. | Consumer marking `done`/`merged`/`tests_passed` etc. | **Writes.** |
| `nudge <id>` | none | Poke-or-escalate one workspace on demand (reuses the supervisor's own `pokeOrEscalate`, honoring persisted attempt count/cooldown). | Manual on-demand nudge outside the automatic sweep. | **Writes** (poke/escalation state). |
| `archive <id>` | none | Archive-by-absence: move the descriptor to `archived/`, tombstone the store registry row. Surfaces a manual "remove in the DevSwarm app" step (no native teardown command exists). | Workspace lifecycle complete (CHILD role, after confirming with your user). | **Writes.** |
| `unarchive <id>` | none | Reverses `archive`: restores the descriptor from `archived/` back to active (hardlink-then-unlink, crash-safe) and revives the store registry row. Rejects (`ok:false`) if the archived descriptor's ownerKey doesn't match the CURRENT project (cross-project reject) or if a non-recovery-anchor active descriptor already exists for that id. | Un-archiving a workspace that was archived by mistake, or resuming one still needed. | **Writes.** |
| `archive-ignore <id>` / `archive-unignore <id>` | none | Mute/unmute the archive-ready reminder for one workspace. | Suppress a nag already triaged. | **Writes.** |
| `archive-request <childId> [--reason TEXT]` | none required | Direct STORE WRITE (v0.58, zero `hivecontrol` calls): posts a `[[ANTIHALL_ARCHIVE_REQUEST]]` mesh-direct message straight into `childId`'s own partition. Never verifies merged/tested/deployed itself — that stays the parent's own repo policy. | PARENT asking a child to archive, after verifying merged+tested+deployed per your own policy. | **Writes.** |
| `migrate` | none | Idempotent, non-destructive, count-verified fold of legacy on-disk JSON registry + NDJSON inbox into the store (single-consumer-locked). `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported backlog as already-read. | Upgrading from a pre-store install, or recovering a stranded legacy inbox. | **Writes.** |
| `migrate-owner-keys` | none | **Forward-migration (v0.62.0), idempotent/fail-open/no-delete.** Scans every active + archived descriptor once: backfills a missing `ownerKey` (from a fresh structural repo-key resolution, falling back to the legacy hash) and re-homes an ACTIVE descriptor still stranded under a stale hash-keyed store bucket into its fresh `repoKey`-keyed bucket (never touches archived rows for re-home — only active ones can silently black-hole reads). Wired into both `update.js` (post-update) and `doctor`'s auto-safe repair, so most stores self-heal without ever calling this by hand. | Manually forcing the ownerKey backfill/re-home outside an `update`/`doctor` run, or auditing a store's ownerKey health. | **Writes** (descriptor + registry). |
| `send --to <meshId>\|--to-primary\|--broadcast --message TEXT [--from <id>] [--urgency low\|normal\|high\|urgent]` | exactly one of `--to`/`--to-primary`/`--broadcast`; `--message` required | Daemon-independent direct write into the shared store — the mesh's SOLE agent-initiated messaging transport (native `message-child`/`message-parent` are guard-blocked). Fail-closed on an unregistered `--to`/`--to-primary` target; `--from` must match the derived identity if given (spoofing rejected). | Any agent-to-agent or agent-to-Primary message. | **Writes.** |
| `roster [--ack]` | none | ALLOW-listed projection: this project's registry + `working_on` + a `recent[]` broadcast digest, folded with a read-only native-children view (a spawned-but-unregistered child still appears, `source:'native'`). Pure `computeSummary` read. | Get the current mesh state / who's doing what. | **Read-only** (plain); **writes** the caller's own broadcast cursor with `--ack`. |
| `mesh read` | none | Alias of `roster --ack` — same read, plus clears the caller's own `broadcastUnread`. | Same as `roster --ack`, named for discovery. | **Writes** (broadcast cursor). |
| `diagnose` | none | **Read-only mesh-health projection.** Per-registry-row live/unread state, which partition a `send` to each worktree's meshId resolves to, orphan partitions, stale registry rows, and split worktrees (2+ live rows sharing one meshId). Pure `computeSummary` + registry read — zero writes. "Purity is the point": an agent can SEE mesh state without the read itself mutating anything. | Debugging "why didn't my message arrive", or pre-fold inspection. | **Read-only.** |
| `healthcheck [--json]` | none | **Scriptable PASS/FAIL gate over the SAME data `diagnose` computes** (one shared `computeDiagnosis`, two presentations). `{ok, status:'ok'\|'degraded', counts:{orphans,stale,splits,phantoms,unreadTotal}, detail:{...}}`. `degraded` iff `orphans>0 \|\| stale>0 \|\| splits>0` (structural drift only — `phantoms`/`unreadTotal` are reported but never gate, so a freshly-`spawn`ed worktree never trips a false degraded). No `--json` prints one compact human line, e.g. `healthcheck: ok [orphans=0 stale=0 splits=0 phantoms=0 unread=0]`. | Monitors/CI/daemons wanting a pass/fail exit code, or a quick human status line without parsing `diagnose`'s full detail. | **Read-only.** |
| `reconcile` | none | Drains every registered worktree's inbox once (per-id subprocess, cwd'd into that worktree — never in-process, so it drains the RIGHT queue). Does **not** dedup/fold registry rows (that's `foldMeshDuplicates`, self-heal only, below). Auto-run by `update` and by `doctor --fix`, both DevSwarm-session-gated. | Sweeping stranded per-worktree native queues into the shared store on demand. | **Writes** (drains messages into the store). |
| `reap-stale [--yes\|--confirm]` | project-scoped (requires a git cwd); confirm flag gates the actual archive | **PARENT-driven reaper (v0.62.0).** Scopes to THIS project's descriptors whose persisted liveness verdict is `stale`/`escalated`, then applies two hard safety gates before ever proposing one: SAFETY 1 — a fresh heartbeat means definitely-alive, never reap; SAFETY 2 — recent git activity in the worktree means not abandoned, never reap. Without `--yes`/`--confirm`, returns a dry-run `{candidates, skipped}` list only. With it, archives each surviving candidate via `cmdArchive`'s own `revalidate` hook, which re-checks liveness/ownership immediately before the archive (so a workspace that heartbeats between listing and archiving is skipped, not wrong-archived). | A Primary/parent clearing genuinely-abandoned child workspaces without babysitting each one by hand. | **Read-only in dry-run; writes (archives) with `--yes`/`--confirm`.** |
| `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes\|--confirm]` | `--active` required unless `--allow-empty`; ids match by full id or a >=4-char prefix/>=8-char embedded-hex substring (roster-display-friendly) | **Parent-driven reconciliation against an explicit "still active" set (v0.62.0)** — e.g. from a roster screenshot. Archives every current (non-archived) workspace of THIS project NOT in `--active` (or piped via `--stdin`); a match always SPARES a workspace (the safe direction — an active one is never archived). Refuses an empty active set unless `--allow-empty` is passed explicitly (guards against accidentally archiving everything). Dry-run by default; `--yes`/`--confirm` applies. | Reconciling the mesh against a known-good "what's actually still running" list. | **Read-only in dry-run; writes (archives) with `--yes`/`--confirm`.** |
| `spawn <branch> [hivecontrol create flags...]` | pass-through — hivecontrol's own flags, unparsed | Thin wrap of `hivecontrol workspace create` (every flag forwards byte-for-byte), then best-effort auto-registers the new worktree in the shared registry (a phantom row, `sessionId:null`, filled in by the child's own first self-register). | Primary creating a new child workspace — this is the workspace-tier spawn command. | **Writes** (hivecontrol side-effects + a registry phantom row). |
| `merge [hivecontrol merge-into-source flags...]` | pass-through | Thin wrap of `hivecontrol workspace check-merge` + `merge-into-source` (pass-through, never re-parsed), then `send --broadcast`s the outcome to the mesh. | Child finishing / shipping upstream. | **Writes.** |

`roster`, `diagnose`, and `healthcheck` are the three pure-read, no-id, project-scoped
verbs (the "read-only trio") — worth reaching for together when an agent just wants to
know the current mesh state without touching anything. `workspaces list` and `inbox
messages`/`read-primary` are id- or scope-specific reads; `mesh read` and `roster --ack`
are the only surfaces that clear `broadcastUnread`.

### How to READ mesh health — never hand-read the store

Use `diagnose` (full detail) or `healthcheck` (pass/fail + exit code) — **never** open
the sqlite/NDJSON store files directly (`cat`/`grep`/the `Read` tool against
`~/.anti-hall/devswarm/store/**` or `inbox/**`). Reasons this is a hard rule, not a style
preference:

- **Backend-specific.** The store is selectable between an NDJSON journal and a sqlite
  backend (`ANTIHALL_DEVSWARM_STORE_BACKEND`); a raw read that assumes one shape breaks
  silently on the other.
- **Bypasses the cursor/derive layering.** A raw read never advances or respects the
  durable ACK cursor, the broadcast cursor, or `deriveSummary`'s projection — it desyncs
  state the CLI's own read verbs keep consistent.
- **The store may literally be the append-only journal backend** that only the store
  code layer (`companion/lib/devswarm-store.js`) knows how to interpret correctly —
  hand-parsing it is exactly the kind of improvisation this document exists to prevent.

This is also mechanically enforced: `hooks/inbox-read-guard.js` blocks Claude's own
`Read` tool on `inbox/**`, and `command-guard.js` blocks raw shell reads (`cat`/`head`/
`grep`/…) of the same paths on both platforms. The lesson is a real incident, not a
hypothetical: a real DevSwarm Primary fell back to querying raw sqlite because the CLI
hadn't yet surfaced `roster`/`diagnose`/`healthcheck` clearly enough — don't repeat that.
Always go through the CLI's read verbs.

### Self-heal behavior — don't hand-fix the registry

The mesh self-heals continuously; an agent should never manually "fix" a duplicate
registration, a stuck daemon, or a stale row:

- **Register-time dedup** (`retireWorktreeDuplicates`, runs inside `cmdRegister` on
  every `register`/`ensure` call — which includes the auto-`ensure` every `inbox pull`
  performs on a child's own turn): folds a duplicate/phantom/subdir-split row for the
  SAME worktree into the caller's own live partition, forwarding any unread backlog
  first, and never touches a row that has its own on-disk descriptor (never mis-retires
  a genuinely distinct live child).
- **Orphans/stale rows surface, never auto-fix.** `diagnose`/`healthcheck`'s `orphans[]`
  (real unread with no live registry row) and `staleRegistryPartitions[]` (registry rows
  whose worktree path no longer exists) are deliberately never auto-forwarded or
  auto-deleted by the read path — they're surfaced for a human/parent to see, by design.
- **Send-time daemon self-heal.** Every send-like verb (`send`, `inbox pull`,
  `archive-request`) checks this project's per-project ingest-daemon health first
  (`ingestHealth.daemonHealth` — the same running+healthy two-signal check above); if
  it's stale/missing and DevSwarm is active, it best-effort re-spawns the installer
  (60s cooldown between attempts) — this never blocks the caller's own action.
- **Updater/doctor fold sweep.** `update` and `doctor --repair` both run `reconcile`
  (drain sweep) and then `foldMeshDuplicates` — the SAME dedup logic generalized over
  the WHOLE registry, not just one caller's own worktree — automatically. The fold is a
  pure store read+write (AUTO-SAFE, no daemon/scheduler touch, no DevSwarm-active gate
  needed); daemon install/relaunch repairs stay GATED to an active DevSwarm session.

So: register/`ensure`/`inbox pull` self-heal on every call, and `update`/`doctor` sweep
the rest on their own cadence. An agent's job is to call the CLI normally — never to
open the store and patch a row by hand.

### Messaging rule

The mesh is the **ONLY** agent-initiated messaging channel. Native `hivecontrol workspace
message-child`/`message-parent` are guard-blocked unconditionally whenever DevSwarm is
active (see "command-guard's native-SEND block" above) — there is no alternate native
path. Report status via `heartbeat <id> --summary TEXT`; direct-message via `send
--to-primary`/`send --to <meshId>`; broadcast via `send --broadcast`; check mesh state via
`roster`/`diagnose`/`healthcheck`/`inbox read-primary <id>`.

## v0.57 mesh — shared per-project store + all-to-all messaging (SHIPPED in v0.58.0 — Claude-side only)

**Status check first:** this mesh substrate shipped in `v0.58.0` (folded in without its own
`v0.57` git tag or GitHub Release), and the Codex/OMX port has **no** mesh support at all
(deferred to v0.57.1, owner decision O-D3). Do not describe the Codex port as mesh-capable.

**What changed.** Before v0.57, the store, the ingest daemon, and the Primary/child registry
were all keyed **per worktree** — a project with 3 linked worktrees had 3 separate stores that
could not talk to each other, and each worktree needed its own ingest daemon installed
separately. v0.57 rekeys everything to a **per-project** identity instead: a `repoKey`
(`companion/lib/devswarm-repokey.js`, `repoKeyForWorktree`) = a sanitized repo-name basename
plus a 6-hex suffix, derived from `git rev-parse --git-common-dir` (the SAME main worktree's
`.git` for every linked worktree of one repo — unlike `--show-toplevel`, which the legacy
per-worktree identity uses). Every worktree of a project now shares ONE store
(`store/<repoKey>/`), ONE registry, and ONE ingest daemon — and any worktree can message any
other directly, not just its own parent/child pair.

**New CLI verbs (daemon-independent — write the shared store directly, no `hivecontrol` call):**
- `node scripts/devswarm.js send --to <meshId>|--broadcast --message "TEXT" [--urgency low|normal|high|urgent]`
  — a non-git cwd fails closed (`{ok:false, reason:'no-project'}`) BEFORE any identity is
  derived; `--from` is always the hardened cwd-derived identity (spoofing a mismatched
  `--from` is rejected); `--to` is fail-closed against the shared registry (an unregistered
  meshId is rejected, never silently dropped).
- `node scripts/devswarm.js roster [--ack]` — this project's shared registry + `working_on` +
  a `recent[]` broadcast digest. `--ack` clears your own `broadcastUnread` (alias of `mesh read`).
- `node scripts/devswarm.js mesh read` — same as `roster --ack`.
- `node scripts/devswarm.js heartbeat <id> --summary "TEXT" [--urgency ...]` — the existing
  heartbeat verb now ALSO broadcasts a mesh status ping (default urgency `low`) that feeds
  `roster`'s `working_on` field.

**Surfacing.** `devswarm-parent-inbox.js` now reads ONE per-project summary
(`summaries/<repoKey>.json`) instead of one per descriptor, and tiers unread-direct segments
by `urgencyMax`: `urgent`/`high` gets a distinct LOUDEST segment, `low` is table-row-only, and
the `recent[]` broadcast/roster feed renders advisory-only (never gates a turn). A mesh direct
addressed to a child's own meshId also surfaces on the child side
(`devswarm-child-turn.js`, D26) even though it never touches the child's durable NDJSON inbox —
it lands in the child's own builder-id partition inside the shared store, and the child hook
reads that same per-project summary for its own entry.

**Daemon.** The ingest daemon is now installed ONE PER PROJECT (`resolveMainWorktree` — the
project's main worktree, never a linked/child one — `WorkingDirectory`, keyed by `repoKey`).
Installing/refreshing it first REAPS every legacy per-worktree unit belonging to the repo
(enumerated via `git worktree list --porcelain`, stopped+unloaded) — a brief buffered ingest
pause during that handoff is expected (latency, not loss). A two-signal health check
(`companion/lib/ingest-health.js`, D25 — fresh heartbeat AND a live-pid lock holder, BOTH
required) backs both the stale-data banner and a cooldown-bounded send-time self-heal that
every `send`/`inbox pull`/`archive-request` call runs first. `doctor` additionally
belt-and-suspenders sweeps any legacy per-worktree unit that is already orphaned (worktree
gone) or redundant (its project's new per-project daemon is confirmed healthy). Windows: the
ingest daemon itself remains a documented no-op there (mesh store + CLI work fine on Windows).

**Migration.** Old per-worktree `store/<hash>/` data is folded into the new
`store/<repoKey>/` non-destructively — the legacy store is left byte-for-byte intact as a
backup — automatically as part of the existing `devswarm.js migrate` (and the updater path).

**Cross-project scoping (#36-STRUCTURAL, D29).** `devswarm-parent-gate.js` and
`devswarm-parent-inbox.js` both now filter candidate workspaces by comparing
`repoKeyForWorktree(worktreePath)` against the session's own `repoKey`, replacing the earlier
spoofable `DEVSWARM_REPO_ID` env-var filter — a project only ever sees its own workspaces.

Full reference, source-line citations, and the exact schema:
`docs/KB-devswarm-hivecontrol.md` §8.7's "v0.57 mesh follow-up" note and §8.8's CLI table.

## v0.58 mesh-only messaging (SHIPPED in v0.58.0 — Claude-side, see the
Codex-parity note below)

v0.57 above ADDED the mesh as a parallel transport; v0.58 makes it the ONLY
agent-initiated one. **The REPLACE decision:** native `hivecontrol workspace
message-child`/`message-parent` are guard-blocked (see the two sections above); every
OTHER hivecontrol feature — the lifecycle verbs `create`/`list`/`check-merge`/`merge` — is
KEPT, unblocked, and now also available as a thin CLI wrap (`spawn`/`merge`, CLI reference
above) rather than re-implemented.

**Message record schema** — uniform across `send`, `archive-request`, the `merge`
broadcast, and the `heartbeat --summary` broadcast:
```json
{"from": "<meshId>", "to": "<meshId-or-null-for-broadcast>", "type": "direct|broadcast", "message": "<text>", "timestamp": 0, "urgency": "low|normal|high|urgent"}
```

**Per-turn override + wake Tier 0 (mesh-poll resting posture).** DevSwarm's own child
spawn uses `--system-prompt-file`, which REPLACES the system prompt — the only lever
against that erasure is re-asserting a directive every subsequent turn, not just at spawn.
`hooks/devswarm-child-role.js` (SessionStart) now fires for **both roles** (Primary AND
child — previously child-only) and injects the full COMMUNICATION OVERRIDE: anti-hall's
mesh is the workspace's ONLY messaging channel, native sends are blocked, report via
`heartbeat <id> --summary`, direct-message via `send --to-primary`/`--to <meshId>`, check
in via `roster`/`mesh read`/`inbox read-primary <id>`, and RESTING state = keep polling the
mesh rather than idling silently (this IS the Tier-0 wake posture — it replaces the native
`monitor` resting state the guard now blocks). Every subsequent turn, a terse (≤160-char)
re-assertion re-injects the same core directive (`devswarm-child-turn.js` for the child,
`devswarm-parent-inbox.js` for the Primary — the one deliberate departure from that hook's
prior "empty when nothing to report" contract, a small fixed per-turn cost traded against
model habituation/drift back toward native messaging over many quiet turns).

**Honest wake-mechanism caveat.** "Keep polling the mesh" is the entire Tier-0 wake
mechanism this release ships — it depends on the session actually taking another turn.
This design's own record (`PLAN.md`) states plainly, citing GitHub
`anthropics/claude-code#44380`, that **no external mechanism wakes a genuinely idle Claude
Code session** — nothing here interrupts a session sitting between turns with no new
prompt. A Tier-2 fallback (wrapping the session's own runner process to force a new turn
via stdin injection) is named in the design record as an explicitly DEFERRED, NOT-BUILT
fallback for if this resting-poll latency proves insufficient — do not describe it as
shipped.

**Supervisor escalate-on-urgent (additive, never kills).** The liveness supervisor now
also reads the project's mesh-store summary for a stale descriptor's `urgencyMax`; when it
is `high`/`urgent`, the sweep fires a parent-store escalation notice immediately —
independent of, and even when, the base poke/escalate cadence above (Layers 2–3) only
nudged. `low`/`normal`/no-signal never forces anything (relies on the agent's own next
turn). This is purely additive — it NEVER resolves a pid and NEVER kills; the on-demand
`devswarm-recover.js` CLI (below) remains the only path that ever does.

**Daemon — unchanged.** `devswarm-ingest.js` and its per-project install/health-check
machinery are untouched by v0.58; the daemon only ever drained the Primary's own reception
queue, not a fanout mechanism the mesh-only decision needed to touch.

**No MCP.** v0.58 explicitly considered and rejected an MCP server / daemon-held push
mechanism for delivery. Same owner-preference rationale as the rest of this CLI ("CLI over
MCP" — a stable-JSON stdout CLI needs no server process, no protocol negotiation, and adds
no attack surface beyond what already exists) — and per the honest caveat above, nothing,
MCP included, currently wakes a truly idle session, so an MCP server would not have solved
the actual gap.

**Codex parity — precise, not aspirational (corrected).** `command-guard.js`'s native-SEND
block is shared and fires identically for Codex (see above). A prior version of this note
claimed the five override/reassert hooks (`devswarm-child-role.js`, `devswarm-child-turn.js`,
`devswarm-parent-inbox.js`, `devswarm-parent-gate.js`, `devswarm-child-gate.js`) were
Claude-only because their gating `DEVSWARM_*` env vars were assumed Claude-specific — that
premise was disproven: `docs/KB-devswarm-hivecontrol.md` §6/§8.7's live-verified env
fingerprint states `DEVSWARM_REPO_ID`/`DEVSWARM_SOURCE_BRANCH`/`DEVSWARM_BUILDER_ID` are set
by hivecontrol per-workspace regardless of agent (`DEVSWARM_AI_AGENT` is the separate var
naming claude vs codex) — the exact same fact this doc already relies on for
`command-guard.js`'s own DevSwarm gate above. All five hooks are now registered, unmodified,
in `codex/hooks/hooks.json`. A Codex agent in an active DevSwarm workspace is therefore
mechanically prevented from sending a native message AND gets the proactive per-turn "use
the mesh" reminder, same as a Claude session. What remains genuinely Claude-only: the
liveness supervisor and its mesh-urgency escalation (it identity-binds to `claude --resume`
processes specifically) and the on-demand `devswarm-recover.js` CLI's own target (a Codex
operator can still invoke the script, but only against a `claude` workspace). The CLI verbs
themselves are plain Node scripts a Codex session can invoke directly via Bash — nothing
agent-specific about the script.

**Child-gate "already-reported" satisfaction.** `hooks/devswarm-child-gate.js` now skips
its Stop-block entirely, for the current stop episode, when the child's own mesh summary
shows a `recent[]` row it itself SENT (a real `heartbeat --summary`/`send --broadcast`
call — never the mechanical turn-start heartbeat FILE, which was already ruled out as a
false-silence signal) since that episode began — provided no known durable unread backlog
is still pending (the inbound half of this gate is unaffected). Fail-open: any read error
never silently skips a required report.

Full reference, source-line citations, and the exact worked example:
`docs/KB-devswarm-hivecontrol.md` §8.7's "v0.58 mesh-only messaging" note and §8.8's CLI
table/worked example.

## Migrating historical backlog without a false unread wall — `migrate-state.js --mark-read`

`scripts/migrate-state.js` (a separate script from `devswarm.js`, run once per repo checkout)
also auto-migrates the DevSwarm store as part of its normal legacy-state fold. By default an
imported legacy source with no consumed-cursor of its own (e.g. a pre-0.54 shell-loop NDJSON)
lands at cursor `0` — its ENTIRE backlog reads as unread, which can trip the parent neglect-gate
on a machine that's simply catching up on old history, not a genuinely neglected child. Pass
`--mark-read` (or set env `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1`) to advance the JUST-imported
backlog's cursor to its post-import message count, so historical migration reads as already-seen:

```bash
node plugins/anti-hall/scripts/migrate-state.js --mark-read [dir]
```

Only affects the migration's own DevSwarm-store fold (not the legacy `.anti-hall-progress.md`/
`.anti-hall-history.md`/`.planning/` copies, which are unconditional and unrelated to read state).
Any message that arrives AFTER this migration call returns is unaffected and still surfaces as
unread normally. Default behavior (flag/env absent) is unchanged — the legacy cursor is preserved
exactly as it was before this option existed.

## #32 — retiring a competing native-queue consumer (PARENT role — read this before archive-request)

If parent↔child reception feels unreliable (messages seem to vanish, or the durable inbox and the
native queue disagree), the most likely cause is a **second process also draining
`hivecontrol workspace monitor`/`read-messages` against the same queue** — a leftover cron job, a
respawning shell loop, a second `pm2`/`launchd`/`systemd` unit, or a `package.json` start script
someone left running from before this substrate was installed. Per §8.7.1 of the KB, exactly one
process may ever be the native consumer of a given queue — two concurrent consumers silently SPLIT
the queue (each drains what the other doesn't see) with no error and no way to recover the split.
**anti-hall cannot mechanically detect or kill an EXTERNAL, non-tool-call consumer** — that's
outside any hook's reach. Detection + retirement is a manual, PARENT-role action:
`docs/KB-devswarm-hivecontrol.md` §8.7.2 has the full identify → stop → verify recipe
(`ps aux | grep 'hivecontrol.*monitor'` → kill the PID + remove its respawn config → re-run
`node hooks/doctor.js`). Do this BEFORE relying on `archive-request` or any reception flow above
if you suspect a second consumer — the guard-redirect and the ingest daemon only protect against
anti-hall's OWN tooling calling `monitor`/`read-messages` twice; they cannot see a process outside
anti-hall's control.

## What this is for

A workaround for a documented, unresolved Claude Code core-loop bug class
(`anthropics/claude-code#39755`, related: `#28482`, `#33949`): a `claude` session can go
**wedged** — process alive, listener dead — with no crash for pm2/systemd to restart and
no background-task-timeout event to generate a new turn. DevSwarm child workspaces run
headless and unattended, so a wedge there just sits forever.

## The layered recovery model

Three layers, escalating in scope. **The automatic path stops at Layer 3 — it never
kills a process.** Only the separate on-demand CLI (below) ever does that.

**Layer 1 — child self-report.** A child workspace's own `SessionStart` hook
(`hooks/devswarm-child-role.js`) injects a reminder: if the session has been idle with no
active task, proactively run `node scripts/devswarm.js heartbeat <id> --summary "idle —
reassign me or archive me"` (as of v0.58 — the mesh CLI; the native `hivecontrol workspace
message-parent` this used to name is now guard-blocked, see "command-guard's native-SEND
block" above), so the parent's task list stays honest instead of the child sitting
unnoticed. This is **cooperative** — it only works if the child is still capable of
executing a turn at all. A truly wedged child (the failure mode this whole feature exists
for) cannot self-report; that's what Layers 2–3 are for. **As of v0.58**, this SAME
`SessionStart` hook also fires for the **Primary** role (previously child-only) to inject
the broader mesh-only COMMUNICATION OVERRIDE directive (see "v0.58 mesh-only messaging"
above) — the idle-self-report line above is still child-only, but the hook itself is no
longer a silent no-op for a Primary session.

**Layer 2 — supervisor poke.** The background sweep (`devswarm-supervisor.js`) computes
liveness per published workspace descriptor (`companion/lib/liveness.js`'s
`computeLiveness`). On a `stale` verdict (both outbound signals — transcript mtime AND
git activity — idle past threshold, AND a pending unread inbox backlog), it calls
`pokeOrEscalate()` (`companion/lib/recovery.js`). If the descriptor carries an optional
`nudgeCommand` (an argv array) and the attempt budget/cooldown allow it, the sweep fires
that command (detached, best-effort, no output captured) and persists verdict `nudged`.
The next sweep checks whether the outbound signal advanced past `nudgedAt` — if so, the
poke worked and the verdict clears to `alive`.

**Layer 3 — escalate-to-parent.** Once the nudge budget is exhausted (or there's no
`nudgeCommand` at all, or the workspace is still cooling down out of budget),
`pokeOrEscalate()` persists verdict `escalated` and fires the descriptor's optional
`escalateCommand` once. `escalated` is a **terminal** verdict — `computeLiveness`
short-circuits it (returns unchanged, never re-stats) so the sweep stops re-targeting a
workspace a human/parent must now handle. Reset it by deleting
`~/.anti-hall/devswarm/liveness/<id>.json` after someone has looked.

**Automatic path stops here.** Nothing above ever resolves a pid or sends a signal.

## Role scoping

The **liveness supervisor / poke-escalate sweep** (Layers 2–3) only ever targets a
published workspace descriptor — never the Primary, and never a subagent (subagents are
handled by anti-hall's own `verify-first-subagent`, unrelated to this feature). Layer 1
(child idle-self-report) is child-only; as of v0.58 the SAME `SessionStart` hook
additionally injects the mesh COMMUNICATION OVERRIDE for a Primary session too (a
DIFFERENT directive, not the idle-self-report line) — see the table below.

| Role | `DEVSWARM_SOURCE_BRANCH` | Idle self-report (Layer 1)? | Mesh COMMUNICATION OVERRIDE (v0.58)? |
|---|---|---|---|
| Primary (root workspace) | empty/unset | No | Yes (as of v0.58) |
| Child workspace | set (non-empty) | Yes | Yes |
| Subagent (any workspace) | n/a | No — out of scope for this hook | No — out of scope for this hook |

Gated by `hooks/lib/devswarm-detect.js`'s `isDevswarmActive(env)` (feature gate: is
DevSwarm active at all?) alone for the v0.58 override (both roles); the idle self-report
line additionally requires `hooks/lib/devswarm-role.js`'s `isChildWorkspace(env)`
(topology: is this session a child?). Neither active -> the `SessionStart` hook
(`hooks/devswarm-child-role.js`) is a silent no-op, byte-identical to a non-DevSwarm
session.

## On-demand recovery — devswarm-recover CLI

```bash
node plugins/anti-hall/companion/devswarm-recover.js <workspace-id>
```

This is **the only place in DevSwarm that ever kills a process.** It reads the named
workspace's published descriptor, resolves the target `claude` process, and — if exactly
one candidate confirms — kills it (SIGTERM, then SIGKILL after a grace window if it
survives and still re-confirms) plus its process group, then resumes it headless
(`claude -p --resume <uuid>`) from the same worktree cwd, feeding the unread inbox
backlog as the fresh prompt.

**When to use it:** on an `escalated` workspace (Layer 3 was reached and nothing
resolved it), or any time an operator/parent orchestrator wants to force-recover one
named workspace right now.

It applies the **same confirm-gate safety** the old always-on supervisor used to apply
automatically, with one deliberate relaxation:
- Exactly-one-or-abstain: 0 or >1 candidate matches both abstain (never guesses).
- Identity-bound: argv session id must equal the descriptor's `sessionId`, cwd must equal
  `worktreePath`.
- TOCTOU re-confirm: identity is re-derived on fresh data immediately before SIGTERM AND
  again before SIGKILL — a pid recycled during the grace window is never wrongly killed.
- Single-writer lock per workspace (atomic lockfile) — never resumes the same session id
  from two processes concurrently; a dead/stale holder is stolen so a crashed prior run
  can't permanently block recovery.
- Cap at `ANTIHALL_DEVSWARM_MAX_RECOVERIES` (default 3) — escalates instead of looping.
- **The relaxation:** this CLI targets **INTERACTIVE sessions too**, not just headless
  ones (`allowInteractive: true`, set only here) — naming the workspace id on the command
  line IS the deliberate human override that makes touching an interactive session safe.
  The automatic sweep never has this permission.
- Windows: escalate-only, never kills (the cwd confirm-gate is unavailable there).

**Resume guardrail:** every resumed prompt is prepended with a fixed instruction
(`RESUME_GUARDRAIL` in `companion/lib/recovery.js`) telling the resumed model to verify
via a read-only check (git status/log, file mtime, log tail) whether an interrupted
mutating command already completed, before blindly re-running it — a real mid-turn-kill
test showed the resumed model otherwise double-executed a command it couldn't confirm had
already succeeded.

Exit code 0 on any handled outcome (`resumed` / `escalate` / `abstain` / `skip`) — these
are all legitimate, non-error results read from stdout. Non-zero only on an internal
error (bad/unsafe argv, unreadable descriptor, an internal throw past the fail-open
guards).

## Activation checklist (for a consumer/orchestrator)

This is the part a DevSwarm-consuming project needs, in order:

**1. Install the automatic supervisor (opt-in — never self-installs):**

```bash
node plugins/anti-hall/companion/install-devswarm-supervisor.js
node plugins/anti-hall/companion/install-devswarm-supervisor.js --dry-run   # preview
node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall
```

- **macOS** → LaunchAgent (`launchd`, `StartInterval`).
- **Linux** → `systemd --user` timer; cron fallback (coalesced by the supervisor's own
  single-flight sweep lock) if `systemctl` is absent.
- **Windows** → detection-only, documented no-op for recovery. A running process's cwd
  is not obtainable in pure Node on Windows, so the cwd confirm-gate cannot run there.
- **Autonomous refresh:** the `update` skill runs this installer's `how` command
  automatically (no offer, no ask) whenever an update happens inside an active DevSwarm
  session (`isDevswarmActive(process.env)`), so a fresh install always carries the
  current build's poke/escalate logic. It's idempotent (`launchctl unload && load` /
  systemd reload), so it both first-installs and refreshes.

**1b. Install the ingest daemon (new in 0.54.1 — same autonomous-refresh posture):**

```bash
node plugins/anti-hall/companion/install-devswarm-ingest.js
node plugins/anti-hall/companion/install-devswarm-ingest.js --dry-run   # preview
node plugins/anti-hall/companion/install-devswarm-ingest.js --uninstall
```

`devswarm-ingest.js` is the one supervised daemon wrapping `hivecontrol workspace
monitor` into the substrate store (see `docs/KB-devswarm-hivecontrol.md` §8.7) — it
shipped in 0.54.0 but nothing auto-started it until this installer landed in 0.54.1.
Unlike the supervisor (a periodic sweep on `StartInterval`/`.timer`), the ingest daemon
runs **continuously**, so this installer schedules re-exec-on-exit instead: macOS
LaunchAgent with `KeepAlive`; Linux `systemd --user` `.service` with `Restart=always`
(cron fallback — every minute, restart-if-dead — when `systemctl` is absent, giving a
cron-only Linux host up to ~60s of revive gap after a crash). Distinct label
(`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the
supervisor. Windows: documented no-op (no pure-Node long-running user-level scheduler;
run the daemon manually if needed). Same **autonomous refresh** as the supervisor
installer: the `update` skill runs its `how` command automatically (no offer, no ask)
inside an active DevSwarm session, so a fresh update always carries a running,
current-build ingest daemon.

**PER-PROJECT, not per-machine — install it from EVERY repo you want covered.** The
daemon's identity (macOS label / Linux unit / cron marker / lock file / its own
reception workspace id `primary-<hash>`) is derived from the worktree it was installed
FROM (an 8-hex hash of that worktree's realpath), so a second repo's install ADDS a new
unit rather than overwriting the first — and safe-to-install-redundantly means "a
second install for the SAME repo is a no-op," not "one daemon covers every repo."
`hivecontrol` itself resolves which workspace a command targets by walking up from the
process's OWN cwd — there is no way to point it at a different repo's queue by id — so
each daemon can only ever drain the ONE worktree baked into its `WorkingDirectory` at
install time. **If you use DevSwarm across multiple repos on one machine, run this
installer once per repo** (`cd <repo A> && node .../install-devswarm-ingest.js`, then
the same from repo B, …); a repo with no install of its own has zero ingest coverage,
silently. Do not describe "the ingest daemon is running" as proof that ingest is
covered machine-wide or for other repos — it proves only that its OWN worktree drains.

**2. Publish a per-workspace descriptor** at
`~/.anti-hall/devswarm/workspaces/<id>.json`:

```json
{
  "id": "<safe id, [A-Za-z0-9._-]+>",
  "worktreePath": "<absolute path to the workspace's git worktree>",
  "sessionId": "<the claude session's current uuid>",
  "inboxPath": "<path to the durable inbound-message log>",
  "cursorPath": "<path to the consumer's read-cursor over that log>",
  "nudgeCommand": ["<optional argv[0]>", "<optional argv[1]>", "..."],
  "escalateCommand": ["<optional argv[0]>", "<optional argv[1]>", "..."]
}
```

- `id`, `worktreePath`, `sessionId` are **required** — a descriptor missing any of these,
  or carrying an unsafe `id` (must match `^[A-Za-z0-9._-]+$`, never `.`/`..`), is skipped
  entirely (fail-open: one bad descriptor never stops the sweep, it just never recovers).
- `inboxPath`/`cursorPath` are **load-bearing, not optional in practice**: without a
  readable inbox+cursor, the supervisor can never establish a pending unread backlog, so
  `pending` is always `false` and the workspace can never be nominated `stale` — Layer 2
  never fires no matter how wedged it is.
- `nudgeCommand`/`escalateCommand` are **optional argv arrays** the supervisor fires
  detached/best-effort (no output captured) at Layer 2/Layer 3 respectively — e.g. a
  script that pages an operator, or one that pings the parent orchestrator directly.
  Without `nudgeCommand`, a `stale` verdict escalates immediately (no poke attempt is
  possible); without `escalateCommand`, escalation still happens (verdict + recovery.log
  entry) — it just has no external side effect.

**3. Env gate.** `DISABLE_ANTIHALL_DEVSWARM=1` is the hard kill-switch. Note the
supervisor daemon's own gate (`devswarm-supervisor.js`) checks only that switch plus
`ANTIHALL_DEVSWARM_SUPERVISOR=off` — it does **not** require `DEVSWARM_REPO_ID`, because
that variable is per-session and is absent from a `launchd`/`systemd` background job. The
real activation signal for the daemon is simply the presence of descriptor files under
`~/.anti-hall/devswarm/workspaces/`. `DEVSWARM_REPO_ID` (and `ANTIHALL_DEVSWARM_SUPERVISOR=on`)
is what session-side consumers (`hooks/lib/devswarm-detect.js`, `doctor.js`,
`hooks/devswarm-child-role.js`) check instead.

**4. Keep the descriptor fresh:**
- `sessionId` must always be the workspace's **current** session uuid — if the consumer
  resumes into a new session id and doesn't update the descriptor, the confirm-gate finds
  zero candidates and abstains (never recovers, never false-positives either).
- **Delete the descriptor when the workspace closes** — there is no GC. A stale
  descriptor for a closed workspace just sits there abstaining forever (harmless, but
  noisy in `doctor.js`).
- `escalated` is a **terminal** verdict (the sweep stops re-targeting it once written) —
  reset it by deleting `~/.anti-hall/devswarm/liveness/<id>.json` once resolved (either by
  running `devswarm-recover.js <id>`, or after a human has otherwise handled it).

## Config / tuning env

**Automatic sweep** (resolved by `resolveThresholdsFromEnv()` in
`companion/devswarm-supervisor.js` — seconds in, ms out; invalid/absent values fall back
to the defaults below; both the live sweep and `doctor.js`'s DevSwarm section read
through it):

| Var | Default | Effect |
|---|---|---|
| `ANTIHALL_DEVSWARM_INTERVAL` | `90` (clamped 60–120) | Sweep interval in seconds, set at install time. |
| `ANTIHALL_DEVSWARM_SUPERVISOR` | `auto` | `off` disables the daemon gate; `on`/`auto` otherwise don't change daemon behavior (see gate note above) but do drive `devswarm-detect.js`'s session-side `active` signal. |
| `DISABLE_ANTIHALL_DEVSWARM` | unset | `1` = hard kill-switch, overrides everything. |
| `ANTIHALL_DEVSWARM_IDLE_SEC` | `900` (min 60) | Idle threshold (seconds) before a workspace is a stale candidate. |
| `ANTIHALL_DEVSWARM_COOLDOWN_SEC` | `600` (min 0) | Cooldown before a re-stale workspace is re-evaluated. |
| `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` | `2` (clamped 1–20) | Poke attempts allowed before Layer 3 escalation. |
| `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` | `180` (min 1) | How long a poke stays "in effect" (held at `nudged`) before falling through to a fresh recompute. |
| `ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` | `120` (min 0) | Minimum gap between successive pokes. |

**On-demand CLI** (`devswarm-recover.js` resolves these itself, decoupled from the
sweep's env — the automatic path no longer carries them at all since it never kills):

| Var | Default | Effect |
|---|---|---|
| `ANTIHALL_DEVSWARM_MAX_RECOVERIES` | `3` (clamped 1–20) | Recoveries allowed before the CLI escalates instead. |
| `ANTIHALL_DEVSWARM_GRACE_SEC` | `5` (clamped 1–60) | SIGTERM→SIGKILL grace window. |

## Safety model

**Automatic path (never kills, no pid targeting):**
- Never resolves a pid, never sends a signal — its only tools are a soft nudge
  (an optional descriptor `nudgeCommand`) and an escalate signal (recovery.log line +
  optional `escalateCommand`).
- Fail-open end to end: any error is logged and the sweep continues; it never blocks on
  one bad descriptor.
- Single-flight: a process-wide sweep lock prevents overlapping sweeps from stacking
  (a cron fallback doesn't coalesce ticks the way launchd/systemd do).

**On-demand CLI (all the precise-kill safety, headless-OR-interactive):**
- Precise single-target kill or abstain — never a broad `pkill`. A survivor must be the
  confirmed `claude` process (identity-bound: argv session id == descriptor `sessionId`),
  cwd-confirmed to `worktreePath`.
- Confirm-gate: exactly one surviving candidate or abstain (0 or >1 candidates both
  abstain — never guess between them).
- Re-confirmed immediately before every signal (SIGTERM and again before SIGKILL), so a
  pid recycled mid-grace-window is never wrongly killed.
- Group-kill (POSIX negative pid) so orphaned MCP-server children go with it, not
  reparented to PID 1.
- Single-writer lock per workspace (atomic `wx` lockfile) — never resumes the same
  session id from two processes concurrently.
- Detached resume, no kill-on-timeout — a resumed session that's still starting is
  recorded `recovering`, never falsely `alive`.
- Targets headless **or** interactive sessions (see the relaxation above) — the only
  place in this feature where an interactive human takeover can be touched, and only
  because the operator named the id explicitly.
- **Windows**: escalate-only, never kills. (Detection-only for recovery generally.)

## Outputs to watch

- `~/.anti-hall/devswarm/liveness/<id>.json` — per-workspace verdict
  (`alive` / `stale` / `nudged` / `ambiguous` / `escalated`), nudge/recovery counts,
  timestamps.
- `~/.anti-hall/devswarm/recovery.log` — append-only NDJSON, one line per poke, escalate,
  recovery attempt, or abstain, with a reason.
- `node hooks/doctor.js` — silent unless DevSwarm is active; otherwise runs a live
  behavioral self-test (fresh workspace → `alive`, a constructed wedged fixture →
  `stale`) plus a PASS/WARN/FAIL readout per real workspace descriptor. `nudged` maps to
  WARN (a poke is outstanding, not yet a failure); there is no `recovering`/stuck-timer
  check any more — the automatic path never kills, so there's no kill-then-resume window
  to watch for being "stuck".

## When to use this skill

"Explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm
supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor",
"recover a stuck DevSwarm workspace", "is my DevSwarm workspace descriptor set up right".

## Relationship to other skills in this plugin

- **orchestration** — now DevSwarm-aware: for a Primary it names the child workspace as the
  tier ABOVE subagent/Explore/Workflow and carries the choice rule. Outside DevSwarm (and in
  a child workspace) its Workflow-tool + subagent fan-out is unchanged.
- **doctor** — surfaces the liveness supervisor's per-workspace health as one more
  section, silent when DevSwarm isn't in play.
- **update** — autonomously installs/refreshes the automatic supervisor AND (as of
  0.54.1) the ingest daemon when running inside an active DevSwarm session (see the
  activation checklist above).
