---
name: anti-hall-devswarm
description: Explain anti-hall's optional DevSwarm integration from Codex — the hivecontrol reference KB, the (designed, unbuilt) workspace-tier orchestration, and the shipped layered recovery model (Claude-side companion: child self-report → supervisor poke → escalate-to-parent, automatic path NEVER kills, plus the on-demand devswarm-recover CLI — the only kill path). Use when the user asks about DevSwarm, hivecontrol, or the anti-hall liveness supervisor while working in Codex.
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
| **Workspace-tier orchestration** | **Designed, NOT built** | `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Nothing from this plan exists in the repo yet (no `devswarm-guard.js`/`devswarm-children.js`) — do not describe it as active in either OMC or OMX. |
| **Liveness supervisor (detect → poke → escalate, never kills)** | **Shipped — Claude-only** | `companion/devswarm-supervisor.js` + `install-devswarm-supervisor.js` + `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js` + `hooks/lib/devswarm-detect.js` + `hooks/lib/devswarm-role.js` + `hooks/devswarm-child-role.js`. The automatic background sweep. Recovers **wedged `claude` sessions specifically** (workaround for `claude-code#39755`) — it identity-binds to `claude -p --resume <uuid>` processes by argv, not Codex sessions. This section explains it for awareness; it is not a Codex-side capability. |
| **On-demand recovery CLI (the ONLY kill path)** | **Shipped — targets `claude` processes only** | `companion/devswarm-recover.js`, invoked explicitly per workspace id. Still Claude-only in what it targets (see below), but a Codex-side operator can run it. |

## The layered recovery model, for Codex users

Why it exists: a `claude` session inside a DevSwarm child workspace can go **wedged** —
process alive, listener dead, no crash for a restarter to catch, no timeout event to
generate a new turn (`anthropics/claude-code#39755`, related `#28482`/`#33949`). The
automatic path handles this in three escalating layers and **never kills anything**:

1. **Child self-report** — the child workspace's own Claude-side `SessionStart` hook
   (`hooks/devswarm-child-role.js`) reminds an idle child to proactively message its
   parent via `hivecontrol workspace message-parent`. Cooperative only — doesn't help a
   truly wedged child, which is what the next two layers are for. Codex has no
   equivalent hook; this only fires for a Claude session with `DEVSWARM_SOURCE_BRANCH` set.
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

**What does NOT carry over to Codex:** unlike the guard-block itself, the PROACTIVE
per-turn reminder that keeps the mesh top-of-mind for a Claude session (injected by
`devswarm-child-role.js`/`devswarm-child-turn.js`/`devswarm-parent-inbox.js`) is
Claude-only — none of those three hooks is registered in `codex/hooks/hooks.json` (see
"Always-listening reception" below, unchanged by v0.58). A Codex agent inside an active
DevSwarm workspace is therefore mechanically PREVENTED from sending a native message, but
only learns about the mesh CLI redirect REACTIVELY, at the moment it attempts (and gets
blocked on) a native send — never proactively. Full detail: `docs/KB-devswarm-hivecontrol.md`
§8.5's v0.58 bullet and §8.7's "v0.58 mesh-only messaging" note.

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

## Always-listening reception + archive flow (Claude-side hooks; CLI is agent-agnostic)

Two v0.56.0 additions, split by what's Claude-only vs. what any agent can invoke:

- **Always-listening reception (Claude-only hooks, for awareness).** `hooks/devswarm-child-turn.js`
  (child, `UserPromptSubmit`) and `hooks/devswarm-child-gate.js` (child, `Stop`) are **not**
  registered in `codex/hooks/hooks.json` — like the rest of the layered recovery model, this is
  Claude-side tooling only. On the Claude side it now (1) mechanically writes/refreshes the
  child's own descriptor every turn (fixes #31 — the parent previously couldn't discover a
  child that never itself ran the registration command), and (2) escalates unread-parent
  messages to IMPERATIVE priority wording, backed by a Stop-gate that force-blocks until the
  durable inbox shows no unread backlog — with an optional STRICT fallback probe
  (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON) that additionally checks a bounded,
  non-destructive `hivecontrol workspace message-count` when the durable check alone shows
  nothing. No Codex-side equivalent hook exists in this plugin.
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
  store-independent). (The CHILD side's automatic marker-detection/surfacing, above, is
  Claude-only; a Codex-side child would need its own equivalent check, e.g. `inbox read
  <id>` and a manual scan for the marker string.)

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

The Claude-side plugin shipped a **v0.57 mesh** substrate on `main` (unreleased,
`plugin.json` still `0.56.0`, no `v0.57` tag yet): a shared per-project `repoKey` store
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

## CLI reference — `scripts/devswarm.js`

The structured interface (CLI over MCP) is agent-agnostic — invokable identically from
a Codex or Claude session (`node "$ANTI_HALL_ROOT/scripts/devswarm.js" <cmd> ...`, with
`$ANTI_HALL_ROOT` resolved as shown below).
Subcommands: `register`/`ensure` (write a workspace descriptor), `register-primary`
(register the CURRENT worktree's Primary under its per-worktree id `primary-<hash>`),
`heartbeat`, `inbox pull`/`read`/`count`/`ack` (child-side durable-inbox cursor
primitives), `inbox messages`/`read-primary` (Primary/store non-destructive read — no
descriptor needed), `workspaces list`, `gate --set/--clear`, `nudge`, `archive`,
`archive-request` (PARENT-side, REVISED v0.58 to a direct store write — see above),
`archive-ignore`/`archive-unignore`, `migrate` (fold legacy on-disk state into the store;
env `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported backlog as already-read —
see `scripts/migrate-state.js --mark-read`, the separate migration script, for the
CLI-flag form).

**v0.58 mesh verbs — same "not yet promoted for Codex" status as `send`/`roster`/`mesh
read` above (see "Codex mesh support" section).** `send --to-primary --message TEXT`,
`reconcile` (one-shot drain of every registered worktree's inbox), `spawn <branch> [...]`
(thin wrap of `hivecontrol workspace create`), `merge [...]` (thin wrap of `check-merge` +
`merge-into-source`, then broadcasts). All plain Node, invokable identically from either
agent — but not yet documented as a recommended Codex workflow.

**`reconcile` auto-heal (v0.58.1) — a separate, ALREADY-shared code path, not a mesh
promotion.** `doctor.js` and `update.js` are the SAME scripts on both platforms (see
`anti-hall-doctor`/`anti-hall-update`), so their `reconcile` auto-heal wiring runs
identically for a Codex session — subject to the SAME "DevSwarm gate is effectively always
closed for gpt-5.x Codex/OMX sessions" caveat as every other daemon-touching GATED repair
(the `DEVSWARM_*` env vars are set only for `claude` child sessions hivecontrol spawns), so
in practice it stays a no-op there today, same as the ingest/supervisor fixes.

**Ack-ownership guard (v0.56.0).** `inbox messages --ack` / `inbox read-primary` refuse
(`ok:false`, cursor untouched) unless the caller's own identity matches `<id>` — identity
is derived from **cwd as ground truth**: a git worktree resolves to its own workspace id,
and a `DEVSWARM_BUILDER_ID` env value naming a *different* workspace is IGNORED (never
trusted to override), closing an env-spoof path where a workspace could impersonate
another workspace's identity to ack its cursor. Pass `--ack-as-owner` to override for a
legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog on
its behalf).

Full table with source-line citations and a worked example:
`docs/KB-devswarm-hivecontrol.md` §8.8 (or the fuller quick
reference in `plugins/anti-hall/skills/devswarm/SKILL.md`).

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

- Workspace tier (unbuilt): would be CLI-identical between agents — `hivecontrol
  workspace create … -a codex` vs `… -a claude` — only the in-workspace fan-out differs
  (`omx team`/workers vs Workflow tool + subagents).
- Layered recovery model + on-demand CLI: Claude-only in what they target, as above. No
  Codex-side equivalent exists in this plugin, though the CLI is invokable from either side.

Anti-hall does not replace OMX. Anti-hall supplies verify-first policy, the reference KB,
and (for the Claude side) the layered recovery model; OMX supplies Codex-native
orchestration/workflow runtime.
