# KB — DevSwarm & the `hivecontrol` CLI (multi-workspace orchestration)

> Reference KB for **DevSwarm** (devswarm.ai) — the multi-workspace AI IDE that runs each
> task as an isolated git-worktree "workspace" with its own agent — and its bundled
> **`hivecontrol`** CLI, the terminal control surface anti-hall can drive to orchestrate
> across workspaces. Compiled 2026-07-04 from **20 sources (15 official)** plus **primary
> evidence gathered by executing `hivecontrol` v2.3.3 and extracting the DevSwarm.app
> Electron bundle on this machine**.
>
> **Verify-first headline:** public web sources conclude DevSwarm "has no CLI." That is
> **false in the strong form** — `hivecontrol` v2.3.3 is real, ships inside `DevSwarm.app`,
> and is on every workspace's `PATH`. It is simply *undocumented publicly*. Everything in
> §4–§7 is **verified by direct local execution / source inspection**, not scraped. Where
> the two evidence streams diverge, the CLI wins and the divergence is logged in §13.
>
> **Dual-platform note:** DevSwarm is agent-agnostic (19 agents incl. Claude Code **and**
> Codex; `DEVSWARM_AI_AGENT` names the active one). The anti-hall integration in §8 is
> therefore specified for **both** OMC (Claude → Workflow tool + subagents) and OMX
> (Codex → `omx team`). **Read the disambiguation in §2 first** — many unrelated projects
> share the "devswarm"/"hivecontrol" strings.

## Coverage note (verification integrity)

- **20 web/product sources** (15 official: 7 devswarm.ai pages, 6 docs.devswarm.ai pages,
  2 github.com/devswarm-ai; + 5 community/forum) + **5 primary local-evidence sources** (CLI
  `--help` v2.3.3, `app.asar` `electron/main.js`, live `DEVSWARM_*` env of this Primary
  Workspace **plus a live child-workspace probe**, a `hivecontrol repo validate` run, the
  injected agent system-prompt). Clears the 10-source / 2-official floor comfortably.
- **Tiering of confidence** (stated, not hidden):
  - **Verified-by-execution** — the entire `hivecontrol` surface (§4), the `.devswarm/config.json`
    schema (§5), the Primary env fingerprint (§6). I ran these.
  - **Verified-by-source-inspection** — role-detection logic, port range, merge plumbing (§6–§7),
    from the extracted `main.js` + Drizzle migrations.
  - **Inferred / UNVERIFIED** — the packaged SQLite path and `update-base`'s cycle-detection.
    (The child-side env, initially unverified, was **confirmed live** via a probe workspace —
    see §6/§13.) Flagged inline and in §13.
- **Honesty flag:** `docs.devswarm.ai` is a JS SPA that `WebFetch` renders only partially;
  official-docs takeaways below are from the fragments that *did* render + the CLI's own
  authoritative help text, not full-page reads.

---

## 1. TL;DR

- **DevSwarm** = a desktop (Electron + VS Code-core) "multi-tasking IDE" where every
  **workspace** (a.k.a. **"Builder"**) is an isolated **git worktree** on its own branch,
  with its own AI agent, terminal, ports, and running app. You parallelise features across
  workspaces instead of waiting on one agent [1][8][14].
- **"HiveControl"** (the marketed feature) = lead-agent **delegation**: an agent in one
  workspace spins up **child workspaces**, assigns scoped tasks, exchanges messages, and
  merges results back [2][3]. It is **powered by the `hivecontrol` CLI** — same name, and the
  CLI is what the in-workspace agent actually calls [P1].
- **`hivecontrol` v2.3.3** (bundled at `/Applications/DevSwarm.app/Contents/Resources/cli/`,
  on `PATH`) exposes 4 top-level commands — `workspace`, `repo`, `health`, `open` — with 13
  `workspace` and 7 `repo` subcommands; **most output JSON for agent parsing** (`configure`/
  `help`/`--help` print human text) [P1].
- **Hierarchy is derived from one text field:** a workspace's `sourceBranch` = its parent's
  branch. **Root/Primary ⇒ `sourceBranch === ""`.** There is no `parentId`/`depth`/`role`
  column [P2]. The live env exposes this as **`DEVSWARM_SOURCE_BRANCH`** (empty = primary).
- **Config** lives in `.devswarm/config.json` (zod schema: `portVars`, `worktreeInclude`,
  `scripts.setup`, `jiraProjectKey`) — the file *is* the source of truth [P1][P2][12].
- **For anti-hall (§8):** make orchestration **workspace-topology-aware**. **L1 (Primary)**
  fans out to **child workspaces** via `hivecontrol`; **L2 (child)** uses today's **Workflow
  tool + subagents** and does **not** spawn child-of-child workspaces — the workspace-level
  twin of anti-hall's existing anti-deep-nesting rule. Detect role from
  `DEVSWARM_SOURCE_BRANCH`; feature-detect `DEVSWARM_REPO_ID` for graceful fallback.

---

## 2. Disambiguation — many things named "devswarm" / "hivecontrol"

| Name | What it actually is | Relevant here? |
|---|---|---|
| **devswarm.ai** (org `devswarm-ai`, bundle id `com.twentyfirstidea.devswarm`) | The commercial multi-workspace AI IDE this KB is about | ✅ **yes** |
| **`hivecontrol`** (CLI) | The **bundled** DevSwarm CLI (`/Applications/DevSwarm.app/.../cli/hivecontrol`, v2.3.3). `hivecontrol` is a POSIX-sh wrapper that execs the real `devswarm` binary in the same dir (sets `DEVSWARM_INVOKED_AS=hivecontrol`) | ✅ **yes — the control surface** |
| **"HiveControl"** (feature) | devswarm.ai's marketing name for the parent/child delegation system [2][3] — implemented *by* the `hivecontrol` CLI | ✅ same product |
| `@devswarm/cli` (npm, by `chad3814`) | Unrelated npm package [20] | ❌ no |
| `justrach/devswarm` | Unrelated Zig MCP tool (`.devswarm/config.toml`, telemetry) | ❌ no |
| `harsha-gouru/devswarm` | Unrelated Claude-Agent-SDK orchestrator | ❌ no |
| `The-Swarm-Corporation/DevSwarm`, `kyegomez/dev-swarm`, `markshao/DevSwarm` | Unrelated GitHub projects | ❌ no |
| `rcrum003/HiveControl` | Beekeeping / hive-monitoring software | ❌ no |

Sibling-category tool (composes conceptually, worth cross-reading): **cmux** — see
[`KB-cmux.md`](./KB-cmux.md). Both are worktree-based multi-agent workspace managers; cmux is
the *visual terminal* layer, DevSwarm is a *full IDE + delegation* layer.

---

## 3. What DevSwarm is & how it works (the model)

**Concept.** A **workspace** = "a git worktree paired with one or more AI terminal sessions"
[13]. On import DevSwarm auto-creates a **Primary Workspace** (anchored to the repo's original
checkout; **cannot be archived or deleted** [13]). Creating a workspace "creates a new branch
and worktree from the source branch, initializes the AI assistant's CLI in the worktree
directory, and opens it in Build Mode" [9]. Requires a clean, committed default branch as the
fork point [9].

**Under the hood** (from the extracted `app.asar` — `electron/main.js` + 46 Drizzle SQL
migrations) [P2]:

- **State store:** a single local **SQLite** DB via Drizzle ORM (migrations `0000`–`0045`).
  Exact packaged path *unconfirmed* (dev-mode uses `~/Library/Application Support/Electron/devswarm.db`;
  the shipped app likely uses its own `userData` dir) — **UNVERIFIED** [P2].
- **Hierarchy:** **no** `parentId`/`role`/`depth` column. A workspace's parent is whichever
  workspace owns the branch named in this workspace's **`sourceBranch`** text column. Root
  workspaces persist `sourceBranch === ""` (a self-referential `main→main` row is actively
  normalized to `""` at the single INSERT site — internal ticket "SWARM-4513") [P2].
- **`builderType`** column (`'primary'` | `'standard'`, default `'standard'`, added in
  migration `0028`): marks the one workspace-per-repo that was created first or whose
  `worktreePath === repo.path`. A UI/onboarding concept — **not** the parent/child graph [P2].
- **Worktree layout:** `git worktree add` into `~/.devswarm/repos/<seq>/<hex8>/<sanitizedBranch>`
  (observed live: `~/.devswarm/repos/1/1dd6a56e/probe-devswarm-env-check`) [P2][P3].
- **Ports:** hard-coded range **2000–9999**, assigned **per-builder in memory** (not
  DB-persisted) [P2].
- **All user/agent docs are baked into JS string literals** — there are **no** standalone
  markdown/help files in the bundle; the agent system-prompt (the natural-language→CLI table +
  "monitoring is the default resting state" protocol) lives in `main.js` [P2][P5].

---

## 4. The `hivecontrol` CLI — command reference (v2.3.3, verified)

> **Re-verified 2026-07-12 against `hivecontrol` v2.3.4 (bumped from 2.3.3 — patch-level
> only).** Ran `--version` and every `--help` one level deep (`workspace`, `repo`, `health`,
> `open`, plus all 13 `workspace` and all 7 `repo` subcommand `--help`s, including
> `list children`/`list all`/`port-vars add`/`worktree-include add`/`scripts set`). **Zero
> surface changes**: identical top-level groups, identical subcommand counts, identical flags
> (including `-t/--title` on `create`, `--tree` on both `list` subcommands, `-w/-y/-s` on
> `update-base`, `-i/-t` on `monitor`). No `--json` flag exists anywhere (JSON is the
> unconditional default output, confirmed by the top-level help's "All commands return JSON
> for easy parsing by AI agents" line — not an opt-in flag). No `archive`/`delete`/`status`
> subcommand exists at any level — the "GUI-only teardown" gap in §10/§8.6 is still real.
> Everything below this note remains accurate for 2.3.4; only the version pin is stale.

Bundled at `/Applications/DevSwarm.app/Contents/Resources/cli/{hivecontrol,devswarm}`; on the
`PATH` of every workspace shell. **Most commands return JSON** for agent parsing (`configure`
and `help`/`--help` print human-readable text) [P1]. Invoke `hivecontrol --help`.

**Top-level:** `workspace` · `repo` · `health` (exit 0 healthy / 1 unhealthy) · `open [path]`.

### 4.1 `hivecontrol workspace` (13 subcommands)

| Command | Purpose |
|---|---|
| `list children [--tree]` | Your direct children (JSON); `--tree` = your subtree as ASCII |
| `list all [--tree]` | Every workspace in the repo (flat JSON); `--tree` = full ASCII hierarchy |
| `info [idOrBranch]` | Workspace details (branch, path, agent, terminal, **`sourceBranch`**, children[]); defaults to current |
| `create <branch>` | Create a workspace. Flags: `-s/--source <branch>` (default: **your current branch**), `-a/--agent <agent>` (default `claude`), `-p/--prompt <text>`, `-t/--title <title>`, `-r/--remote` (use existing remote branch) |
| `update-title <title>` | Set display title (`-b/--branch` to target another) |
| `check-merge` | JSON: `isMergeable`, `hasConflicts`, `targetDirectoryClean` + source/current paths. Run **from your workspace dir** |
| `merge-from-source` | `git merge` source **INTO** current workspace |
| `merge-into-source` | `git merge` current workspace **INTO** source (i.e. "ship upstream") |
| `update-base` | Rewrite this workspace's recorded `sourceBranch`. No flag ⇒ read the single open PR's target; `-s/--source <branch>` writes directly (backend cycle-check authoritative); `-w/--workspace <idOrBranch>` targets another workspace; `-y/--yes` skips prompt |
| `message-child <branch> <msg>` | Send a message to a child workspace |
| `message-parent <msg>` | Send a message to the parent workspace |
| `read-messages` | Read unread messages (**marks them read**) |
| `message-count` | Unread count (does **not** mark read) |
| `monitor [-i secs] [-t secs]` | Poll for messages until they arrive, then exit with them. `-i/--interval` default **3s**, `-t/--timeout` default none |

**Key semantics baked into the help** [P1]: *"When you create a workspace, it uses YOUR
CURRENT BRANCH as source by default. This makes the new workspace a child of your current
workspace."* And: *"A workspace can be BOTH a parent (has children) AND a child (has a
parent)."* `<branch>` **is** the workspace identifier — there is no separate name field.

### 4.2 `hivecontrol repo` (7 subcommands)

| Command | Purpose |
|---|---|
| `configure` | Prints the canonical setup recipe (6 steps) + current config state |
| `validate` | Validate `.devswarm/config.json`. **Exit codes: 0 = valid, 1 = invalid, 2 = no file** |
| `refresh` | Apply config edits to the **current** workspace in place: re-assign ports, re-run source→worktree file copy, write a shell init script to `source`. (Does **not** re-run setup scripts.) Errors if not in a workspace |
| `find` | `{ id, name, path }` for the current git dir |
| `port-vars {list,add <NAME>,remove <NAME>}` | Per-workspace unique-port variables |
| `worktree-include {list,add <PATH>,remove <PATH>}` | Files copied source→workspace at creation (alias: `file-patterns`, deprecated) |
| `scripts {get,set setup <cmd>,unset setup}` | The setup script (runs in a terminal tab on workspace creation) |

---

## 5. `.devswarm/config.json` — schema & mechanics

Canonical config at repo root; **the file IS the source of truth** — DevSwarm reads it on
every save and every workspace creation; hand-editing is fine, the CLI writes the same file
[P1]. Zod schema (`main.js:25385`, `.passthrough()` so unknown keys survive) [P2]:

| Field | Type | Meaning |
|---|---|---|
| `portVars` | `string[]?` | Names of per-workspace port vars (DevSwarm assigns a unique 2000–9999 port each) |
| `worktreeInclude` | `string[]?` | **Exact** file/dir names copied source→new-workspace at creation via `cp -Rp` (Windows: `xcopy /E /I /H /Y` for dirs, `fs.copyFile` for files) [P2]. **Canonical**; `filePatterns` / `untrackedFilePatterns` are deprecated read-only aliases |
| `scripts.setup` | `string?` | Shell command run in a terminal tab on workspace creation |
| `jiraProjectKey` | `string?` | Jira integration key |

**Mechanics / gotchas** [P1][P2][11][12]:
- `worktreeInclude` is **exact-path only — no wildcards/globs**, and copies **only at creation
  time** (no retroactive sync to existing workspaces).
- Worktrees do **not** carry gitignored files — that's the whole point of `worktreeInclude`
  (for `.env`, credentials, etc.). Judge entries from `.gitignore` **by name**; never read a
  gitignored file's contents.
- Apply flow [P4]: edit → `hivecontrol repo validate` → `hivecontrol repo refresh` (in place) →
  optionally commit to share with the team. `.devswarm/config.json` is meant to be committed,
  but is **not** required to be — the local file/DB suffices for your own workspaces.

---

## 6. `DEVSWARM_*` environment variables — the detection surface

Live fingerprint of **this Primary Workspace** (observed) [P3], annotated with source-verified
meaning [P2]:

| Var | Observed (Primary) | Meaning / use |
|---|---|---|
| `DEVSWARM_REPO_ID` | `3f7313be-…` | Present ⇒ **inside DevSwarm** (the "am I in a workspace?" flag) |
| `DEVSWARM_SOURCE_BRANCH` | **`` (empty)** | **Parent's branch. Empty ⇒ root/Primary; non-empty ⇒ child.** The role signal |
| `DEVSWARM_DEFAULT_BRANCH` | `main` | Repo default branch |
| `DEVSWARM_AI_AGENT` | `claude` | Active agent (`claude`/`codex`/`gemini`/…) — selects the OMC vs OMX path |
| `DEVSWARM_BUILDER_ID` | `1a4a909a-…` | This workspace's DB row id |
| `DEVSWARM_BUILDER_NAME` | `main-3f7313be` | Derived from branch+repo; use to isolate paths/volumes/db names across workspaces [11] |
| `DEVSWARM_NAME` | `Term:main-3f7313be` | Terminal/workspace display name |
| `DEVSWARM_CLI_PORT` / `DEVSWARM_HTTP_PORT` | `47836` | Local HTTP API port the CLI talks to |
| `DEVSWARM_SPAWNED` | `1` | **Process-tree bookkeeping — `1` even for Primary. NOT a hierarchy signal** (name is misleading) [P2] |
| `DEVSWARM_PARENT_PID` | `9687` | Electron parent **PID** (not a parent workspace) [P2] |
| `DEVSWARM_BUN_PATH`, `DEVSWARM_SHELL_READY_MARKER` | … | Runtime plumbing (bun binary, `🤖 Ready for AI` prompt marker) |

**Role-detection recipe (for anti-hall):**
```
inside DevSwarm?  →  [ -n "$DEVSWARM_REPO_ID" ]         (authoritative in-workspace flag;
                     hivecontrol health exit 0 = app reachable only — necessary, NOT sufficient)
primary or child? →  [ -z "$DEVSWARM_SOURCE_BRANCH" ]   ⇒ PRIMARY ; else CHILD
                     corroborate: hivecontrol workspace info  (sourceBranch field)
                                  hivecontrol workspace list all --tree  ("Primary Workspace ← you")
which agent?      →  $DEVSWARM_AI_AGENT                  (claude|codex|…)
```
> ✅ **VERIFIED live (2026-07-04 probe):** a child workspace (`probe/devswarm-env-check`, source
> `main`) reported `DEVSWARM_SOURCE_BRANCH=main` (non-empty) vs this Primary's `""`; env and DB
> `sourceBranch` agree on both sides, and the parent↔child message loop worked end-to-end [P3].
> `DEVSWARM_SPAWNED=1` on **both** — do **not** use it for role.

---

## 7. Coordination model — async, message-passing (not in-process)

This is the crux for anti-hall: unlike the **Workflow tool** (which *awaits* subagents
in-process), DevSwarm children run **asynchronously in separate processes/IDEs**. Coordination
is **message-passing + polling + git merges** [P1]:

**Lifecycle a parent runs over a child:**
```
1. create   hivecontrol workspace create <branch> -s <src> -a <agent> -p "<brief>" -t "<title>"
2. brief    (the -p prompt seeds the child; or message-child <branch> "<instructions>")
3. wait     hivecontrol workspace monitor        # polls (3s) until the child messages back
4. read     hivecontrol workspace read-messages  # child reports "Completed X, ready for merge"
5. check    hivecontrol workspace check-merge     # isMergeable / hasConflicts / clean
6. merge    (from the CHILD dir) hivecontrol workspace merge-into-source
   or        (parent pulls a sibling's work) merge-from-source
7. propagate message-child <other> "Merged auth from sibling — pull latest"
```
**Merge plumbing** [P2]: `check-merge` = dry-run via `git merge-base` + `git merge-tree`;
`merge-from-source`/`merge-into-source` = real `git merge`. Run **from the workspace dir**; a
`WORKING_DIRECTORY_NOT_CLEAN` error must be surfaced to the user, not auto-resolved [P1].
**Messaging** persists in the app DB; `monitor` polls it; `read-messages` marks read (use
`message-count` for a non-destructive peek). The full loop was **verified live** this session:
`create -p` → child ran → `message-parent` → parent `read-messages` returned
`{ fromBranch, toBranch, message, status, createdAt }` [P3].

The CLI's baked-in protocol [P1]: *"monitoring is the default resting state"*; after sending
any message, run `monitor` and check messages at session start + periodically.

---

## 8. anti-hall × DevSwarm — the orchestration integration (the point)

**Goal:** make anti-hall orchestration **workspace-topology-aware**, so the *same* skill picks
its fan-out primitive by **where it runs**.

### 8.1 The two tiers

| Tier | DevSwarm role (detect via §6) | Fans out with | Spawns child workspaces? | Coordination |
|---|---|---|---|---|
| **L1** | **Primary** (`SOURCE_BRANCH` empty) | `hivecontrol workspace create` → N children (heavy: worktree + IDE + agent + app/ports + own token budget) | ✅ yes | async: `create → monitor → check-merge → merge-into-source` |
| **L2** | **Child** (`SOURCE_BRANCH` set) | the **Workflow tool + subagents** (cheap, in-process, synchronous) | ❌ **no** (no child-of-child) | in-process await |

The **"no child-of-child"** rule is the workspace-level twin of anti-hall's existing
orchestrator anti-deep-nesting rule (`KB-claude-workflow-orchestration`): deep workspace
nesting multiplies cost/drift with no quality gain. **Shallow + wide** at the workspace tier,
**shallow + wide** again at the subagent tier — never deep at either.

### 8.2 When to use which tier (heuristic)

- **Workspace tier (L1)** — chunks that are **large, truly independent, and benefit from
  running the app** (a whole feature, a repo area, an isolated Docker stack), where branch
  isolation + independent review + a separate token budget/session actually pay for the
  worktree+IDE overhead. Analogous to the L2 sub-orchestrators in the repo's own worktree
  hierarchy.
- **Subagent tier (L2)** — everything finer-grained: parallel reads, review passes,
  transforms, verification — the current default. **They compose, not compete**: L1 splits into
  workspace-sized chunks; each child then uses L2 internally.

### 8.3 Graceful fallback (mandatory)

anti-hall runs outside DevSwarm too. **Feature-detect** and no-op cleanly:
```
if [ -z "$DEVSWARM_REPO_ID" ] || ! command -v hivecontrol >/dev/null; then
   → behave EXACTLY as today (Workflow tool + subagents only). No hard dependency.
fi
```

### 8.4 Dual-platform parity (OMC ↔ OMX)

`DEVSWARM_AI_AGENT` selects the in-workspace fan-out engine; the **workspace tier is
platform-identical** (both call the same `hivecontrol`):

| | Claude workspace (`DEVSWARM_AI_AGENT=claude`) | Codex workspace (`DEVSWARM_AI_AGENT=codex`) |
|---|---|---|
| L1 → children | `hivecontrol workspace create … -a claude` | `hivecontrol workspace create … -a codex` |
| L2 in-child fan-out | **Workflow tool + subagents** (OMC) | **`omx team` / workers** (OMX) |
| Bypass launcher parity | `cc.sh` = `claude --dangerously-skip-permissions` | `cx.sh` = `omx --madmax` |

### 8.5 Guard interactions

- **`git-guard` / `merge-gate`** already gate merge/commit paths — reuse them around
  `merge-into-source`.
- **`command-guard`'s DevSwarm destructive-read redirect (shipped, v0.53.0).** Under a
  DevSwarm-active session, `command-guard.js` intercepts the two CONSUMING native
  `hivecontrol` inbox reads from §4.1/§7 before its own coordinator-only gate, in ALL
  contexts (a delegated subagent read drains the queue identically): `hivecontrol
  workspace monitor` blocks unconditionally (a no-timeout long-poll that hangs the shell
  and consumes the queue); `hivecontrol workspace read-messages` blocks only when
  durable-inbox evidence exists (`ANTIHALL_DEVSWARM_INBOX_CMD` set, or a
  `~/.anti-hall/devswarm/workspaces/*.json` descriptor with a truthy `inboxPath`) — a
  harmless single-consumer `read-messages` is allowed. Non-destructive `message-count` /
  `message-parent` / `message-child` are never touched. Own `devswarm-read-guard` skip
  name (in skip-guard's `DESTRUCTIVE` set — a blanket `all` skip does not silence it).
  Fires on both platforms: `command-guard.js` is a single file shared by the Claude and
  Codex ports (§8.4), so this redirect needs no separate Codex adapter.
- A **new no-child-child guard** should block `hivecontrol workspace create` when
  `DEVSWARM_SOURCE_BRANCH` is non-empty (child), mirroring the swarm-guard/anti-deep-nesting
  pattern.
- Persist the plan/handoff in `.anti-hall/` (already gitignored) so a child workspace can read
  its brief and report status back via `message-parent`.
- **graphify hygiene:** `graphify-out/` is gitignored [P3], so a child's graph deltas can't merge
  into main regardless. The feature still gates the graphify SessionStart/Stop hooks OFF in
  children (`DEVSWARM_SOURCE_BRANCH` non-empty) + adds skill guidance so **only the Primary runs
  graphify, post-merge** (avoids wasted child work). Plan-time check: confirm the Obsidian-docs
  output (`--obsidian`) also lands under gitignored `graphify-out/`, not a committed path.

### 8.6 Open design questions (resolve before build — task #5)

1. ~~Confirm the live child `DEVSWARM_SOURCE_BRANCH` value~~ — **DONE** (probe: child = `main`, Primary = `""`).
2. Where does the async `monitor` loop live — a background subagent in the Primary, a hook, or
   a `ship-it`-style state file? (`monitor` is long-running/polling.)
3. Failure/timeout semantics when a child never reports (use `monitor -t`).
4. Teardown is **GUI-only** — no `hivecontrol` delete/archive command exists [P1], so the L1 loop
   can create children but **cannot reap them**; it must surface "remove workspace X in the
   DevSwarm app" to the user (prefer archive; never delete without confirmation — repo rule).

---

## 9. Best practices, tips & tricks

- **Detect, don't assume role** — branch on `DEVSWARM_SOURCE_BRANCH` (empty=primary), never
  `DEVSWARM_SPAWNED` (always `1`) [P2][P3].
- **Keep the source branch clean/committed before creating workspaces** — DevSwarm forks the
  worktree from it and refuses a dirty tree [9].
- **`create` sources from your *current* branch by default** — to branch from `main` while on a
  feature branch, pass `-s main` explicitly [P1].
- **Seed the child with `-p "<brief>"`** so its agent starts immediately, and/or `-t "<title>"`
  for a readable tab [P1].
- **Register `worktree-include` (exact names, no globs) *before* creating** workspaces that need
  `.env`/secrets — existing workspaces don't retro-sync [11][12].
- **Port-var everything hardcoded** (`FRONTEND_PORT`, `API_PORT`, `DB_PORT`) + use
  `DEVSWARM_BUILDER_NAME` for volume/db-name isolation, so N app stacks run without collisions
  [11].
- **After any message, `monitor`** — it's the resting state; check `message-count` for a
  non-destructive peek, `read-messages` when ready to consume [P1].
- **Run merge commands from the workspace dir**; on `WORKING_DIRECTORY_NOT_CLEAN`, surface to
  the user — never auto-stash/commit their changes [P1].
- **`hivecontrol repo refresh` applies config in place** — never spawn a throwaway workspace
  just to test a config change [P1].
- **`.devswarm/config.json` need not be committed** for your own use; for a **public** repo,
  keeping it local (and gitignoring machine-specific `.claude/settings*.json` referenced by
  `worktree-include`) avoids shipping personal config to cloners.
- **`hivecontrol health` (exit 0/1)** is a clean precondition check before scripting the CLI.

---

## 10. Gotchas / limitations

- **No public CLI or config docs.** `hivecontrol` and `.devswarm/config.json` are undocumented
  on the web; the public GitHub repo is "landing + issue tracker" only, no product source [14].
  Build against the **installed** `--help`, and pin behaviour to the observed version (2.3.3).
- **`worktree-include`: creation-time only, exact-names-only, no retro-sync** [12].
- **No CLI teardown.** No `hivecontrol` command deletes/archives/removes a workspace — cleanup
  (worktree + branch) is **GUI-only** [P1] (archive keeps disk contents, delete removes worktree
  files; both keep git history). Scripted orchestration can create workspaces but not reap them.
- **Hierarchy is branch-name-derived**, not an id graph — renaming/retargeting branches can
  reshape parent/child; `update-base` exists to fix a recorded `sourceBranch` [P1][P2].
- **`DEVSWARM_SPAWNED` mis-naming** — not a child indicator (see §6).
- **Desktop-only, macOS + Windows, 16 GB RAM min; Linux "in the works"** [4][17]. Electron +
  VS Code core; many simultaneous workspaces are memory-heavy (per-OS minimum stated; a
  multi-workspace figure is **derived**, not documented).
- **Packaged SQLite DB path unconfirmed**, and `update-base` cycle-detection unread — both
  **UNVERIFIED** [P2].
- **Name collisions** are severe (see §2) — always disambiguate in searches.
- **Vendor "5×"/productivity claims** are self-reported and not independently benchmarked;
  DevSwarm's own blog [5] cites a METR (2025) study finding AI tools made devs **19% slower**.

---

## 11. anti-hall implications

- **New capability, not a rewrite.** The integration in §8 is additive: a **detection layer**
  (§6 recipe) + a **workspace-tier branch** in the orchestration skill that only activates when
  `DEVSWARM_REPO_ID` is set and role = Primary; otherwise the skill is byte-for-byte today's
  behaviour. This must land in **both** `plugins/anti-hall/skills/orchestration/SKILL.md` **and**
  its Codex mirror `plugins/anti-hall/codex/skills/anti-hall-*/` (dual-platform mandate), with a
  parallel OMC/OMX table (§8.4).
- **Reuse existing guards** — `git-guard`, `merge-gate`, and the swarm/anti-deep-nesting pattern
  map directly onto the workspace tier (§8.5); the "no child-of-child" rule is the same
  philosophy at a coarser grain.
- **Concrete follow-up = task #5** (Design DevSwarm-aware workspace-tier orchestration), blocked
  on this KB. Resolve §8.6's open questions in a brainstorm/plan-mode pass before any code.
- **anti-hall's own DevSwarm state** (this session): `.devswarm/config.json` carries
  `worktreeInclude: [".claude/settings.local.json"]` so child workspaces inherit the local
  bypass — a live, working example of the `worktree-include` mechanism this KB documents.

---

## 12. Sources

**Primary evidence — verified on this machine, 2026-07-04 (5):**
(P1) `hivecontrol --help` / per-subcommand `--help`, **v2.3.3** — full CLI surface, JSON I/O,
parent-child + coordination protocol ·
(P2) DevSwarm.app `app.asar` → `electron/main.js` (zod config schema @25385; system-prompt
@~75380–75800) + 46 Drizzle migrations — hierarchy=`sourceBranch`, `builderType`, port range
2000–9999, merge plumbing ·
(P3) Live probes on this machine — `env | grep DEVSWARM` of the Primary + `workspace list all
--tree` (root annotated `main (Primary Workspace) ← you`) + a throwaway **child** workspace
(`probe/devswarm-env-check`) confirming child `DEVSWARM_SOURCE_BRANCH=main`, the gitignored
`graphify-out/`, and the parent↔child message loop ·
(P4) `hivecontrol repo validate` run — confirmed schema/`worktreeInclude` write ·
(P5) Injected DevSwarm agent system-prompt (this workspace) — NL→CLI mapping, coordination protocol.

**Official — devswarm.ai (7):**
(1) [DevSwarm homepage](https://devswarm.ai/) ·
(2) [Features (names "HiveControl")](https://devswarm.ai/features) ·
(3) [FAQ](https://devswarm.ai/frequently-asked-questions) ·
(4) [Download (macOS/Windows, 16 GB, no Linux/CLI)](https://devswarm.ai/download) ·
(5) [Blog — vs multiple Claude Code windows](https://devswarm.ai/blog/why-use-devswarm-instead-of-multiple-claude-code-windows) ·
(6) [Blog — DevSwarm 2.0 (full IDE)](https://devswarm.ai/blog/devswarm-2-0-a-full-ide-for-parallel-ai-coding) ·
(7) [Blog — 5 features you're not using (merge toolbar)](https://devswarm.ai/blog/5-devswarm-features-youre-probably-not-using-but-should-be).

**Official — docs.devswarm.ai (6):**
(8) [Getting Started / About](https://docs.devswarm.ai/getting-started/about) ·
(9) [Using DevSwarm (workspace lifecycle, archive vs delete)](https://docs.devswarm.ai/getting-started/using-devswarm) ·
(10) [Installation (19 agents incl. Claude Code + Codex)](https://docs.devswarm.ai/getting-started/installation) ·
(11) [Port Variables (`DEVSWARM_BUILDER_NAME`)](https://docs.devswarm.ai/features-and-integrations/port-variables) ·
(12) [File Patterns / worktree-include (exact names, creation-time)](https://docs.devswarm.ai/features-and-integrations/file-patterns) ·
(13) [Workspaces (worktree + AI sessions; Primary can't be deleted)](https://docs.devswarm.ai/workspaces).

**Official — GitHub `devswarm-ai` (2):**
(14) [devswarm-ai/devswarm README (landing/issue-tracker only)](https://github.com/devswarm-ai/devswarm) ·
(15) [SECURITY.md (local-first, telemetry opt-out)](https://raw.githubusercontent.com/devswarm-ai/devswarm/main/SECURITY.md).

**Forum / community (5):**
(16) [Show HN — DevSwarm](https://news.ycombinator.com/item?id=45168846) ·
(17) [Show HN — DevSwarm 2.0 (cofounder mikebiglan; Linux "in the works")](https://news.ycombinator.com/item?id=47168068) ·
(18) [Twenty Ideas case study (Electron/React; "5x" self-reported)](https://twentyideas.com/our-work/devswarm-ai) ·
(19) [Aiventa.io tool listing](https://aiventa.io/tools/devswarm) ·
(20) [npm `@devswarm/cli` — UNRELATED (chad3814)](https://registry.npmjs.org/@devswarm/cli).

---

## 13. Discrepancies / caveats

- **"DevSwarm has no CLI" (web) vs `hivecontrol` v2.3.3 (local).** Public sources [1–20] never
  mention a CLI and one web-research pass concluded it "likely doesn't exist." **Refuted by
  direct execution** [P1]: the CLI is real but *bundled and undocumented*. The feature name
  "HiveControl" [2] and the CLI `hivecontrol` are the same subsystem. **Trust P1/P2 over the
  web for CLI facts.**
- **`.devswarm/config.json` (`.json`) vs a stray `.devswarm/config.toml` mention.** A web
  snippet referenced a `.toml` telemetry file; that trace belongs to the *unrelated*
  `justrach/devswarm` Zig project (§2), **not** devswarm.ai, whose config is JSON [P1][P2].
- **Child-side env — RESOLVED / verified live (2026-07-04).** A probe child
  (`probe/devswarm-env-check`) reported `DEVSWARM_SOURCE_BRANCH=main` (non-empty) vs Primary `""`;
  env and DB `sourceBranch` agree. The role signal is confirmed [P3].
- **Packaged SQLite path, `update-base` cycle-detection, rebase-via-CLI reachability —
  UNVERIFIED** [P2].
- **Version-pinned.** All CLI/schema facts are for **`hivecontrol` 2.3.3** / this app build;
  re-verify against `--help` after a DevSwarm update. **Re-verified 2026-07-12 at v2.3.4** —
  full `--help` surface (top-level + all `workspace`/`repo` subcommands) is byte-for-byte
  identical in structure to the 2.3.3 surface documented in §4; no new subcommands, flags,
  or removed commands. Treat the CLI-surface facts as current through 2.3.4.
- **Vendor productivity claims** ("5×") are self-reported, not independently benchmarked [5][18];
  the "19% slower" counter-figure is reported by DevSwarm's blog [5] citing METR (2025), not a
  direct METR source here.
