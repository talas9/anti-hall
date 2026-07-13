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
- **`command-guard`'s DevSwarm destructive-read redirect (shipped v0.53.0; hardened to an
  UNCONDITIONAL block on `read-messages` too in a later, undated follow-up — verified
  directly against the current `command-guard.js` source, since neither CHANGELOG.md nor
  this doc had caught up).** Under a DevSwarm-active session, `command-guard.js`
  intercepts the two CONSUMING native `hivecontrol` inbox reads from §4.1/§7 before its
  own coordinator-only gate, in ALL contexts (a delegated subagent read drains the queue
  identically): **both** `hivecontrol workspace monitor` (a no-timeout long-poll that
  hangs the shell and consumes the queue) **and** `hivecontrol workspace read-messages`
  (marks-read / drains the queue) now block UNCONDITIONALLY whenever DevSwarm is active.
  `read-messages` no longer requires durable-inbox evidence first — the original v0.53.0
  design (`hasDurableInboxEvidence()`, gated on `ANTIHALL_DEVSWARM_INBOX_CMD` or a
  descriptor's `inboxPath`) has been **removed from the code**: a raw native
  `read-messages` desyncs the durable cursor regardless of whether a durable inbox
  happens to exist, so it is now treated exactly like `monitor`. **CORRECTION:** any
  earlier text (in this doc, the `devswarm` skill, or its Codex mirror) describing
  `read-messages` as "evidence-gated" / "allowed when no durable inbox exists" is stale —
  do not repeat it. Non-destructive `message-count` / `message-parent` / `message-child`
  are still never touched. Own `devswarm-read-guard` skip name (in skip-guard's
  `DESTRUCTIVE` set — a blanket `all` skip does not silence it). Fires on both platforms:
  `command-guard.js` is a single file shared by the Claude and Codex ports (§8.4), so this
  redirect needs no separate Codex adapter. **Redirect target:**
  `scripts/devswarm.js inbox pull <id>` / `inbox read <id>` / `inbox messages <id>` — see
  §8.8 for the full CLI.
- **Raw-file-read guard (companion to the above, closes the shell/Read-tool bypass).**
  Blocking the native `hivecontrol` commands does not stop an agent from reading the
  DURABLE inbox/store files directly — `cat`/`head`/`grep`/… or the `Read` tool. That
  does **not** drain anything (the inbox is append-only NDJSON), but it (1) **desyncs the
  durable cursor** — bypassing it means messages get re-processed or skipped — and (2)
  violates the store's write/derive layering (`devswarm-store.js`: "hooks never open the
  DB"). Two guards close this, sharing one classifier
  (`hooks/lib/devswarm-inbox-paths.js`'s `classifyDevswarmPath(path, home, cwd)`):
  - **Bash-side** — `command-guard.js`'s `detectProtectedFileRead()` matches
    `cat`/`head`/`tail`/`less`/`more`/`od`/`xxd`/`strings`/`nl`/`grep`/`sed`/`awk` at
    command-verb position (the same quote-neutralization + `bash -c`/`eval`/`$()`/backtick
    recursion as the native-read detector above) and classifies each unquoted path
    argument.
  - **Read-tool-side** — a dedicated PreToolUse hook, `hooks/inbox-read-guard.js`
    (**Claude-only** — not registered in `codex/hooks/hooks.json`, since it guards
    Claude's own `Read` tool specifically; the Bash-side guard above still fires
    identically on Codex because `command-guard.js` is shared), classifies
    `tool_input.file_path` the same way.
  - **Taxonomy** (verified against `liveness.js`'s `devswarmRoot()` + the store's own
    paths): `inbox/**` → `deny-inbox`, UNCONDITIONALLY (the `devswarm.js inbox pull`/
    `read` wrapper already exists, so there is no legitimate reason to read it raw).
    `store/<hash>/devswarm.db` (+ `-wal`/`-shm`/`-journal` sidecars) and
    `store/<hash>/journal/*.ndjson` → `deny-store` (the store is now PHYSICALLY
    PER-PROJECT, one `store/<worktreeHash>/` per worktree; the legacy flat
    `store/devswarm.db` / `store/journal/*.ndjson` layout is still matched for a
    pre-migration on-disk store), but only when a Primary read path that can
    serve the same data through the wrapper is actually present (probed via
    `devswarm-store.js` exposing `listMessages` — now shipped, so this gate is armed).
    Everything else under the DevSwarm root (`summaries/<hash>.json`, `cursors/**`,
    `workspaces/**`, `liveness/**`, `heartbeats/**`, `locks/**`, `archive-*`) is
    `allow`, as is any path outside the root or any resolution error (fail-open by
    design — a hook bug must never block a turn). Redirect target: `inbox pull`/`read`
    for a child's own inbox, `inbox messages`/`read-primary` for the Primary/store path
    (§8.8).
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

> **Update (shipped):** questions 2–4 are now answered by the anti-hall DevSwarm substrate
> in §8.7 — the async monitor loop lives in the supervised `devswarm-ingest.js` daemon
> (not a hook); child-never-reports is covered by the liveness supervisor's stale/escalated
> verdict feeding the parent-gate; and the GUI-only-teardown gap is handled by the CLI's
> `archive` subcommand, which archives-by-absence on anti-hall's own registry and SURFACES
> the manual "remove workspace X in the DevSwarm app" step (it never runs a delete — none
> exists). The questions are kept above as the pre-build record.

### 8.7 The anti-hall DevSwarm substrate (SHIPPED — generic, project-agnostic)

Beyond the command-guard redirect (§8.5), anti-hall ships a generic coordination
**substrate** that turns the "Primary silently neglects child workspaces" failure
(claude-code#39755) into a **mechanical** one. It is entirely **optional + feature-gated**
(dormant, byte-for-byte identical to today, unless `DEVSWARM_REPO_ID` is set or
`ANTIHALL_DEVSWARM_SUPERVISOR=on`) and **project-agnostic** — the consumer keeps its own
done-contract / deploy glue and calls anti-hall's generic CLI. anti-hall owns ALL generic
coordination substrate; project-specifics stay in the consumer repo.

**Mechanical triggers (4 hooks + the SessionStart role hook).** These are the actual fix —
prose reminders get ignored; only a mechanical trigger works.
- `hooks/devswarm-parent-inbox.js` (UserPromptSubmit, **Primary only**) — each turn,
  surfaces the REAL unread/idle state of active workspaces so the Primary engages them, and
  recommends archiving any workspace the store derived as complete (`archive_ready`). Reads
  the durable-inbox files + the supervisor's already-written verdicts + `summary.json`;
  never runs `computeLiveness`/git on the hot path.
- `hooks/devswarm-parent-gate.js` (Stop, **Primary only**, capped/loop-safe) — blocks the
  Primary from ending its turn while a child still has unread backlog past its cursor **OR**
  the supervisor already judged a child stale/escalated **OR (v0.56.0) the Primary's OWN
  summary-projected unread is nonzero** — read from `summary.json`, no DB open, surfaced
  with the SAME imperative "STOP and read them FIRST via `devswarm.js inbox read-primary
  <id>`" wording the child gate uses below, so the Primary can no longer sit on its own
  unread inbound (fixes the confirmed gap where a parent could not see messages sent to
  it). Reads only files (the fs cursor + the supervisor's verdict file + the summary
  projection) — no git, no live liveness on the ~30 s Stop path.
- `hooks/devswarm-child-turn.js` (UserPromptSubmit, **child only**) — writes a
  turn-authored heartbeat, KEYED BY `DEVSWARM_BUILDER_ID` (`heartbeats/<DEVSWARM_BUILDER_ID>.json`,
  unique per child; falls back to a sanitized/hashed `<branch>` key only when `DEVSWARM_BUILDER_ID`
  is absent — keying by the shared parent branch alone would collide every sibling forked
  from that parent onto one heartbeat file, the pre-0.56.0 bug) and reminds the child to
  report to its parent.
- `hooks/devswarm-child-gate.js` (Stop, **child only**, capped) — forces the child to
  self-report to its parent before going idle.
- `hooks/devswarm-child-role.js` (SessionStart, **child only**) — Layer-1 self-report
  reminder (the recovery model; see the `devswarm` skill).

**Heartbeat-authorship rule:** heartbeats are ALWAYS written by the working session's own
turn/hook, NEVER by a background ticker — a daemon-written heartbeat would read "fresh" even
while the session is wedged, defeating the whole point of the detector.

**The store (`companion/lib/devswarm-store.js`).** ONE API, TWO interchangeable backends
chosen by **feature-detect** (`try { require('node:sqlite') }` → WAL sqlite; else an
append-only NDJSON journal) — dependency-free and green on Node 18/20 (no `node:sqlite`)
through 22/24. The store is **PHYSICALLY PER-PROJECT**: each worktree gets its OWN
`store/<hash>/devswarm.db` (+ journal), where `<hash>` derives from the workspaceId the
caller operates on (`primary-<worktreeHash>` unwraps to that worktree hash; any other id
buckets by `sha256(id)`). A 0.54.x GLOBAL store is split into per-project stores
non-destructively on upgrade (`devswarm-migrate.js migrateGlobalStoreToPerProject`; the
global file is kept as a backup). **Hooks NEVER open the DB**: the store is the
write/derive side and derives a PER-PROJECT `summaries/<hash>.json` projection (written
atomically via tmp+rename, placed OUTSIDE `store/` so the read-guard ALLOWs it) that hooks
read. Data model —
`messages` (timestamped, append-only, idempotent by dedupe hash), `registry` (workspace
descriptors), `cursors` (per-workspace consumed count), `gates` (per-workspace named boolean
**completion gates**, timestamped + append-only). It derives `archive_ready: true` when ALL
required gates are satisfied for a still-present workspace; the required set is configurable
(default `done,merged,tests_passed`, override via `ANTIHALL_DEVSWARM_REQUIRED_GATES`).
anti-hall stays **agnostic** about what any consumer gate (e.g. `deployed`) MEANS — the
consumer sets them; the store only tracks and derives.

**The CLI (`scripts/devswarm.js`) — THE structured interface (CLI over MCP, owner
preference).** Stable JSON on stdout, pure Node built-ins. Subcommands: `register`/`ensure`
(write a workspace descriptor + populate `sessionId`, closing the registry null-gap),
`heartbeat` (turn-authored), `inbox count|read|ack` (the durable-inbox cursor primitive —
`ack` advances the cursor and is the parent-gate's non-skip **clear path**), `inbox pull`
(child-side reception drain — auto-ensures the descriptor, then ONE bounded guard-safe pull:
non-destructive `message-count` gate → at-most-one bounded `read-messages` (never `monitor`)
→ atomic idempotent NDJSON append + store parity; see the v0.54.2 note below), `workspaces
list` (derive + emit the `summary.json` projection), `gate --set/--clear` (mark/unmark
completion gates), `nudge` (poke-or-escalate, reusing `recovery.pokeOrEscalate`), `archive`
(archive-by-absence on anti-hall's OWN registry — because hivecontrol has **no** teardown
command (§4/§10), it SURFACES a manual "remove workspace in the DevSwarm app" step and never
runs a delete), `archive-ignore`/`archive-unignore` (per-workspace mute of the archive-ready
reminder), and `migrate`. `command-guard` carries a root-anchored `LIGHT_EXCEPTION` for
`scripts/devswarm.js` so the guard doesn't block its own wrapper.

> **Destructive-vs-non-destructive (reinforces §4.1):** the substrate never consumes the
> native queue. `message-count` (**non-destructive**) is the count source; the durable inbox
> (fed by the ingest daemon) is what `inbox read/ack` advances. `read-messages` (**marks
> read**) and `monitor` (**consumes / blocking long-poll**) remain the two destructive
> native reads the §8.5 redirect steers agents away from.

**v0.54.1 follow-up (shipped).** Four refinements on top of the Phase-1 substrate above:
- **Ingest daemon auto-install (`companion/install-devswarm-ingest.js`).** Until this
  release nothing auto-started `devswarm-ingest.js` — it existed in code but required a
  manual install. It now installs/refreshes on `/anti-hall:update` inside an active
  DevSwarm session, mirroring the supervisor's no-offer/no-ask autonomous-refresh
  posture (same `isDevswarmActive` gate). Unlike the supervisor (a periodic sweep), the
  ingest daemon runs continuously, so the installer schedules re-exec-on-exit: macOS
  LaunchAgent `KeepAlive`, Linux `systemd --user` `Restart=always` `.service` (cron
  fallback ticks every minute when `systemctl` is absent, so a cron-only Linux host has
  up to ~60 s of revive gap after a crash before the next tick relaunches it). Distinct
  label (`com.anti-hall.devswarm-ingest`) and log
  (`~/.anti-hall/devswarm-ingest.log`) from the supervisor. Idempotent — safe to
  install unprompted; the daemon's own single-consumer lock means a redundant install
  never runs two ingest processes. `capability-scan.js`'s Linux detection now checks
  for BOTH a `.timer` (periodic supervisor) and a `.service` (continuous daemon) unit
  file under the same installer-discovery mechanism, so either shape reports correctly.
  **Cwd caveat:** the daemon drains the workspace of the git worktree it is INSTALLED
  FROM — `hivecontrol` resolves a workspace by walking up from the process's own cwd,
  NOT from any `DEVSWARM_*` env — so the installer resolves that worktree at install
  time (`git rev-parse --show-toplevel` against the install-time cwd) and bakes it in
  as the unit's working directory (macOS plist `WorkingDirectory`, Linux systemd
  `WorkingDirectory=`, a `cd` prefix on the cron fallback line); it refuses to install
  (fail-open, no-op, exit 0) when run from a cwd that isn't inside a git worktree.
- **PER-PROJECT identity — ONE ingest daemon per repo/git-worktree, not per machine
  (CORRECTION — this scope was not spelled out before and must not be assumed).**
  `install-devswarm-ingest.js` derives an **additive, per-worktree** unit identity so a
  second repo's install creates a NEW unit rather than overwriting the first repo's:
  `worktreeHash(wt)` — an 8-hex SHA-256 fingerprint of the worktree's realpath — feeds
  `labelForWorktree`/`unitForWorktree` (macOS label `com.anti-hall.devswarm-ingest.<hash>`,
  Linux unit `anti-hall-devswarm-ingest-<hash>.service`/cron marker
  `# anti-hall-devswarm-ingest-<hash>`) and `primaryWorkspaceId(wt)` = `primary-<hash>`
  (the store partition key for THAT worktree's own reception queue — replacing an early
  hardcoded `'primary'` that collided rows across repos). `devswarm-ingest.js` computes
  the identical hash from its own resolved worktree (`resolveDaemonWorktree` →
  `installIngest.resolveWorktree`/`worktreeHash`, so lock path (`locks/ingest-<hash>.lock`)
  and workspace id agree byte-for-byte with what the installer baked into the unit.
  **Multi-repo coverage means installing this installer from EACH repo/worktree
  separately** (`node plugins/anti-hall/companion/install-devswarm-ingest.js` run from
  inside repo A, then again from inside repo B) — there is no single daemon that covers
  more than the one worktree it was launched from, and there is no way to point an
  existing daemon at a different repo after the fact (its `WorkingDirectory` is baked in
  at install time). `listInstalledIngestUnits()` enumerates every installed unit
  (legacy hash-less AND per-worktree) for readback (`doctor`/`doctor-repair` use this,
  not a re-derivation). **Do not describe an installed ingest daemon as "verified
  functioning" for the whole machine or for other repos** — a live daemon proves only
  that IT'S worktree drains; a sibling repo with no install of its own has no ingest
  coverage at all, silently.
- **The store is PHYSICALLY PER-PROJECT (per worktree), like the daemon.** Each worktree
  gets its OWN `~/.anti-hall/devswarm/store/<worktreeHash>/devswarm.db` (+ journal) and its
  own `~/.anti-hall/devswarm/summaries/<worktreeHash>.json`; the store dir is derived from
  the workspaceId the caller operates on (`primary-<worktreeHash>` → that worktree hash; any
  other id → `sha256(id)`). This replaces the former single global
  `~/.anti-hall/devswarm/store` shared by every worktree. The `workspace_id` column is
  retained (harmless) but each physical store now holds one project's data. Daemon coverage
  still determines which ids actually receive new native messages, and each daemon writes
  into ITS worktree's own store. A pre-existing 0.54.x global store is split into per-project
  stores automatically + non-destructively on upgrade (the global file is left as a backup).
- **Daemon liveness heartbeat (forward-compatible, not yet consumed).** Every ingest
  loop iteration — even a quiet one with zero inserts — writes
  `heartbeats/ingest-<hash>.json` (`{ts, workspaceId, workingDir, pid}`) via
  `writeIngestHeartbeat()`, independent of `summary.json`'s `generatedAt` (which only
  advances when `inserted > 0`, so a live-but-quiet daemon would otherwise read as
  stale). As of this writing `doctor`/`doctor-repair` do NOT yet read this heartbeat —
  their daemon-health check classifies the INSTALLED UNIT's config
  (`ok`/`wrong-path`/`stale-script`/`absent`), not runtime freshness. Wiring the
  freshness banner to this heartbeat is an explicit open follow-up; do not claim it is
  live-liveness-checked until that lands.
- **Design rule — hook (event) vs daemon (interval), stated explicitly.** The four
  mechanical trigger hooks above fire ONLY on a turn boundary (`UserPromptSubmit`/`Stop`/
  `SessionStart`) and structurally cannot self-fire between turns. Anything genuinely
  TIME-based or IDLE-based — the liveness supervisor's idle-child staleness sweep
  (`devswarm-supervisor.js`'s `sweepOnce`, run on a `launchd StartInterval`/`systemd
  .timer`/cron tick, independent of any session being open) and the ingest daemon's
  continuous native-queue consumption (`devswarm-ingest.js`'s `runIngestLoop`, a
  long-running process re-exec'd on exit) — therefore lives in the **companion/**
  daemons, never in a hook. A hook that tried to implement "has this workspace been idle
  15 minutes?" would only ever re-check on the NEXT turn, which may never come for a
  genuinely wedged session — the whole reason this substrate exists. Keep new
  time/idle-based logic in a companion daemon; keep new turn-boundary logic in a hook.
- **`devswarm-child-gate` heartbeat-freshness check — REVERTED (v0.54.1).** v0.54.0 briefly
  silenced the Stop-gate when the child's own turn-authored heartbeat
  (`heartbeats/<DEVSWARM_BUILDER_ID>.json` as of v0.56.0 — see the heartbeat-key fix above;
  written every turn by `devswarm-child-turn`) was fresher than 5 minutes. That FALSE-SILENCED
  a child that worked <5 min then stopped WITHOUT calling `message-parent` — a turn-START
  heartbeat proves only that a turn began, not that the child reported its stop-state.
  v0.54.1 reverted the freshness check: the gate now ALWAYS demands at least one real report
  per unchanged blocking state, bounded ONLY by the per-episode cap `MAX_BLOCKS = 2`
  (`devswarm-child-gate.js` lines 219–221, 87). There is no heartbeat-silencing path.
- **Child inbox reception — SHIPPED (v0.54.2). `devswarm.js inbox pull <id>` is the drain.**
  `devswarm-child-turn` runs a non-destructive unread check against the child's OWN durable
  descriptor inbox (`workspaces/<DEVSWARM_BUILDER_ID>.json` → `inboxPath`/`cursorPath`, via
  the inbox-cursor primitive — pure fs, no native-queue drain) and, when unread > 0, surfaces
  the count plus the safe `inbox read` path. What was missing in v0.54.1 — a mechanism to
  DRAIN the child's NATIVE parent→child queue into that durable inbox — now ships as the
  bounded CLI pull `node scripts/devswarm.js inbox pull <DEVSWARM_BUILDER_ID>`
  (`companion/lib/devswarm-pull.js`, `pullOnce`). Each drain: (1) takes a PER-ID `O_EXCL`
  lock (a child never drains its own queue twice concurrently — the same single-consumer
  invariant the ingest lock enforces); (2) runs the **non-destructive `message-count`** gate
  FIRST — count `0` returns without ever calling `read-messages`; (3) on count `>0`, ONE
  **bounded** `read-messages` with a finite 10 s timeout — **never `monitor`**; (4) appends
  the batch to the durable inbox NDJSON in ONE atomic `appendFileSync`, idempotent by embedded
  content hash (reused verbatim from the ingest daemon, so both paths dedupe identically), and
  feeds the store parity projection with the same hash. The per-turn child hook now statically
  nudges the child to run this pull (no spawn on the hot path) — the pull is what POPULATES the
  durable inbox the unread-surfacing segment reads. **Residual limitations (honest):**
  1. **Destructive-read crash-window.** `read-messages` marks the native messages read BEFORE
     `pullOnce` durably persists them; a crash in the window between the native mark-read and
     the `appendFileSync` loses those messages from the native side without landing them in the
     durable inbox. The count-gate MINIMIZES the window (no `read-messages` when count `0`) but
     cannot close it — hivecontrol exposes no non-destructive full read. A thrown append
     surfaces `ok:false` (never a false success) and writes no partial NDJSON, but the native
     messages are already gone.
  2. **Pull, not push — latency = turn cadence.** Reception happens only when the child runs
     the pull (nudged each turn), so a parent→child message is seen at most one child turn late,
     not instantly. There is no background child drainer (a child cannot host the blocking
     `monitor` daemon on its turn thread, and `monitor` is guard-blocked).
- **Live active-workspace table (`devswarm-parent-inbox`).** Every Primary turn now
  gets a compact markdown table of active workspaces (not just the unread/stale
  subset): columns workspace / status (`escalated` > `stale`/`nudged` > `archive-ready`
  > `active`, attention-needing rows sorted first, ties by unread desc then id) /
  finishing rate (required completion gates met/total from `summary.json`'s
  `requiredGates`, with an optional heartbeat `progress_pct` appended when present) /
  unread count / last-activity (relative age, from the newer of the liveness verdict's
  `lastOutboundTs` and the heartbeat's `ts`). Capped at 12 rows with a logged (never
  silent) `+N more`; empty output when there are no active workspaces; read-only,
  fail-open, and — like the rest of the parent hooks — makes zero git calls or
  `computeLiveness()` invocations on the hot UserPromptSubmit path.

**v0.56.0 follow-up (shipped).** Three refinements closing the reception/teardown loop:
- **Archive flow — both roles, `archive-request` verb.** `devswarm-parent-inbox.js`'s
  archive-ready segment (above) already URGES the Primary to check merged/tested/deployed
  per its OWN repo policy; it now names the concrete follow-up command:
  `scripts/devswarm.js archive-request <childId|childBranch> [--reason TEXT]
  [--child-branch B]` (`cmdArchiveRequest`, `plugins/anti-hall/scripts/devswarm.js:563`).
  SEND-ONLY: resolves the child's branch (explicit `--child-branch` → the descriptor's own
  `branch` field, if one is ever set → a `hivecontrol workspace list children` lookup by
  branch/id/worktree → the positional id itself as a last resort — `resolveChildBranch`,
  `devswarm.js:530`) and posts a `[[ANTIHALL_ARCHIVE_REQUEST]]`-prefixed message via
  `hivecontrol workspace message-child <branch> <msg>`. It never verifies merged/tested/
  deployed itself (`ARCHIVE_REQUEST_MARKER`, `devswarm.js:504`; fail-open on a spawn error).
  On the CHILD side, `hooks/devswarm-child-turn.js` scans its own already-fetched unread
  lines for that literal marker (`ARCHIVE_REQUEST_MARKER`, `hooks/devswarm-child-turn.js:182`)
  and, when found, injects a DISTINCT segment (`buildArchiveRequestSegment`,
  `devswarm-child-turn.js:187`) telling the child to confirm with ITS OWN user, then run
  `devswarm.js archive <id>` — never auto-archive. anti-hall never archives mechanically on
  either side of this handshake.
- **Always-listening reception — mechanical descriptor registration (#31 fix) +
  IMPERATIVE unread priority.** `hooks/devswarm-child-turn.js` now writes/refreshes the
  child's OWN descriptor (`workspaces/<DEVSWARM_BUILDER_ID>.json`) every turn
  (`registerChildDescriptor`, `devswarm-child-turn.js:245`) — fixing #31, where the parent
  previously could not see all its children because nothing mechanically wrote that
  descriptor for the child side (only a prose nudge told the child to run a CLI command it
  never reliably ran). MERGE-preserving: an existing `inboxPath`/`cursorPath` (e.g. set by a
  prior `inbox pull`) is never clobbered. Separately, the unread-parent-message segment
  escalated from advisory to **imperative priority** wording (`buildUnreadSegment`,
  `devswarm-child-turn.js:167`): "STOP and address these parent message(s) FIRST before
  continuing." The Stop-side gate (`hooks/devswarm-child-gate.js`) backs this with a
  **STRICT** mode (`strictEnabled`, `devswarm-child-gate.js:135`, env
  `ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON i.e. `'1'`; set `'0'` to disable): when
  the pure-fs durable-inbox check (`readDurableUnread`, `devswarm-child-gate.js:146`) shows
  nothing, STRICT mode additionally runs ONE bounded, non-destructive `hivecontrol workspace
  message-count` probe (5 s timeout, `probeNativeMessageCount`, `devswarm-child-gate.js:165`)
  to catch a native backlog the child never `inbox pull`ed yet — fail-open, any probe
  error/timeout counts as no-unread, never blocks on an unknown state.
- **Migration `--mark-read`.** `scripts/migrate-state.js`'s DevSwarm-store fold (part of its
  normal legacy-state migration, `migrateDevswarmStore`, `migrate-state.js:88`) now accepts
  `--mark-read` on the CLI (`migrate-state.js:339`) or env `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ`
  (`resolveMarkRead`, `companion/devswarm-migrate.js:65`; explicit boolean wins, then `'1'`/`'true'`
  parsed from the env var). OPT-IN, default OFF: a legacy source with no consumed-cursor of
  its own (e.g. a pre-0.54 shell-loop NDJSON) otherwise imports its whole backlog at cursor
  `0`, surfacing as a big "unread" wall that can trip the parent neglect-gate on a machine
  simply catching up on old history. When set, the JUST-imported backlog's cursor is advanced
  to its post-import message count (`companion/devswarm-migrate.js:281`) so it reads as
  already-seen; a message arriving AFTER the migration call returns is unaffected. Default
  behavior (flag/env absent) is byte-for-byte unchanged — the legacy cursor is preserved
  exactly as before this option existed.

**Auto-safe migration (`companion/devswarm-migrate.js` + `companion/devswarm-ingest.js`).**
`migrate` (also wired into the updater path, and exposed as `scripts/devswarm.js migrate`)
dual-reads the existing on-disk state — the JSON registry descriptors + each descriptor's
legacy NDJSON inbox/cursor — into the store. **Safety contract, each test-asserted:**
IDEMPOTENT (dedupe hash from id + line-index + content; a re-run imports only genuinely new
appended lines), **NON-DESTRUCTIVE** (reads sources only — never deletes/moves/truncates, so
the legacy files stay byte-for-byte and rollback is always possible), SINGLE-CONSUMER-LOCKED
(O_EXCL lock), and COUNT-VERIFIED (the store's message count must equal the distinct legacy
lines before it reports `verified:true`). `devswarm-ingest.js` is the ONE supervised daemon
that wraps the native `monitor` → store (dedupe-idempotent) and **refuses to start if
another monitor consumer is already running** (lockfile), mechanically enforcing the
single-native-consumer invariant — two concurrent `monitor` consumers split the destructive
queue and silently lose messages.

**v0.57 mesh follow-up (SHIPPED — Claude-side only; Codex/OMX mesh support DEFERRED to
v0.57.1, owner decision O-D3 — do not describe the Codex port as mesh-capable).** As of this
writing, `plugin.json` is still `0.56.0` (this work has landed on `main`, unreleased/untagged
— see `docs/KB.md`'s version row). Everything below replaces the pre-0.57 **per-worktree**
identity/store/daemon model with a **per-project** one: every linked worktree of one repo now
shares ONE store, ONE registry, and ONE ingest daemon, and can message every other worktree
of the same project directly (all-to-all "mesh"), not just its own parent/child pair.

- **`repoKey` — the shared per-project store key primitive
  (`companion/lib/devswarm-repokey.js`, `repoKeyForWorktree`).** `repoKeyForWorktree(worktree)`
  = `sanitizeRepoName(basename(dirname(gitCommonDir)))` + `'-'` + first 6 hex chars of
  `sha256(gitCommonDir)`, where `gitCommonDir` is `git -C <worktree> rev-parse
  --git-common-dir`, resolved against `worktree` then realpath'd (`gitCommonDir`, L125–156).
  **Why `--git-common-dir`, not `--show-toplevel`:** `--show-toplevel` is PER-WORKTREE (a
  linked worktree's toplevel differs from the Primary's — that's what the legacy
  `worktreeHash()`/`primaryWorkspaceId()` key on, by design, for per-worktree units);
  `--git-common-dir` resolves to the SAME main worktree's `.git` for EVERY worktree of a
  project, which is exactly the project-stable identity a SHARED mesh store needs. **Windows
  hardening (a45563b):** GitHub Actions' `windows-latest` runners expose `%TEMP%` in 8.3
  short-name form while git-for-Windows' MSYS path layer resolves an absolute
  `--git-common-dir` through its own long-name-expanding logic, so the default JS
  `fs.realpathSync()` (which preserves whatever casing/short-name form it's given) can hash
  the Primary's own worktree and a linked worktree's reported common-dir to two DIFFERENT
  strings for the identical directory. On win32 the module instead calls
  `fs.realpathSync.native()` (queries the OS for the true canonical form via
  `GetFinalPathNameByHandleW`, expanding short names) and then `winCanonicalizeCommonDir()`
  (strips the `\\?\`/`\\?\UNC\` extended-length prefix, normalizes separators to `/`, drops a
  trailing separator, lowercases — NTFS is case-insensitive). POSIX is untouched. **Fail-open
  throughout:** any resolution failure (non-git cwd, missing git binary, unreadable path)
  returns `null`, never throws — every caller below treats `null` as "mesh dormant" (O-D5),
  not an error.
- **The store is now PHYSICALLY PER-PROJECT, not per-worktree.** Every mesh-aware caller
  (`store.openStore({..., hash: repoKey})`) opens the SAME `store/<repoKey>/devswarm.db` (+
  journal) regardless of which of the project's worktrees it runs from — replacing the
  0.54.x–0.56.x per-worktree-hash store. The legacy per-worktree `store/<hash>/` layout (and
  its `summaries/<hash>.json`) is left in place; see the migration note below.
- **The mesh CLI — `send` / `roster` / `mesh read` (`scripts/devswarm.js`), Phase 4 (D8).**
  New, daemon-independent subcommands that write/read this project's shared store DIRECTLY —
  zero `hivecontrol` calls, so they work even with the ingest daemon stopped:
  - `send --to <meshId>|--broadcast --message TEXT [--from <id>] [--urgency low|normal|high|urgent]`
    (`cmdSend`, L969–1049). `repoKey` is resolved from cwd FIRST and a null repoKey returns
    `{ok:false, reason:'no-project'}` **before any identity is derived** (D28) — a spoofed
    `DEVSWARM_BUILDER_ID` on a non-git cwd can never even reach `callerIdentity`. `from` is
    always the hardened, cwd-derived `callerIdentity(env, cwd)` (D18/D19, same primitive the
    ack-ownership guard uses); an explicit `--from` is accepted only as a redundant
    declaration that must MATCH, else the send is rejected as spoofing. `--to <meshId>` is
    **fail-closed** against the shared registry (`resolveMeshTarget`, L952–959, D12a) — a
    meshId not present in the registry is rejected (`reason:'unregistered-recipient'`), never
    silently black-holed; a matched target's row is stored under the target's REAL builder-id
    partition (`target.id`), NOT the meshId itself (D19 — this is the join a recipient's/a
    child's mesh-direct read below actually reads). `urgency` defaults `normal`, validated
    against `ALLOWED_URGENCY = ['low','normal','high','urgent']` (L932). Default `type` is
    `direct` unless `--broadcast`/`--type broadcast`; a broadcast row lands in the shared
    `BROADCAST_PARTITION_ID = '*mesh-broadcast*'` partition (`companion/lib/devswarm-store.js`
    L169). Dedupe hash = `meshMessageHash(fields)` (`'mesh:' + sha256(...)`, store.js L198),
    a namespace disjoint from every other migration/legacy hash prefix.
  - `roster [--ack]` (`cmdRoster`, L1055–1069) — an ALLOW-listed projection read of THIS
    project's shared registry: `{repoKey, count, workspaces:[{id, working_on, directUnread,
    broadcastUnread, urgencyMax}], recent:[...]}`, derived fresh (never a stale cache) each
    call, keyed purely off cwd (no id argument — project-scoped like `send`).
  - `mesh read` (a.k.a. `roster --ack`, D23; `cmdMeshRead`, L1077–1098) — lists the CALLER's
    unseen NON-heartbeat broadcasts (rows with `storeSeq` past the caller's own
    `broadcast_cursors` position) and then advances that cursor to the shared broadcast
    partition's current head. This is the ONLY surface that clears `broadcastUnread` for the
    caller.
  - `heartbeat --summary TEXT [--urgency ...]` (Phase 4 step 4, D11/D22) now ALSO broadcasts a
    mesh heartbeat row into the caller's project store — `mtype:'broadcast'`, `is_heartbeat:1`
    — so `roster`'s `working_on` field for that workspace picks it up (`working_on` matches the
    LATEST broadcast row where `sender === d.id`, `deriveSummary` L968–971). Default urgency
    `low` (distinct from `send`'s `normal` default — a routine status ping should not read as
    equally loud as a deliberate message). A non-git cwd (`repoKey` null) is NOT an error: the
    base (non-mesh) heartbeat write still succeeds; `meshBroadcast:{ok:false,
    reason:'no-project'}` in the response explains why the mesh side was skipped.
  - Message record schema, uniform across `send` and the `heartbeat --summary` broadcast:
    `{from, to, type:'direct'|'broadcast', message, timestamp, urgency}` (plus the derived
    `hash`/`isHeartbeat` the store appends internally).
- **`deriveSummary` mesh-additive fields (`companion/lib/devswarm-store.js` L909–1000, old
  readers ignore unknown keys).** Per workspace: `directUnread` (alias of the pre-existing
  `unread`, the wire-schema name), `broadcastUnread` (non-heartbeat broadcast rows past THIS
  workspace's own broadcast cursor — heartbeats are deliberately EXCLUDED, D22, else it would
  grow monotonically since every peer heartbeats every turn), `urgencyMax` (the highest
  urgency among the workspace's PENDING direct rows only). Top-level: `recent[]` = the last
  `recentCap` (default 50, `DEFAULT_RECENT_CAP`, O-D8 UNRESOLVED-cap, overridable) broadcast
  rows INCLUDING heartbeats, each as `{from, summary, ts, urgency}` — the roster/FYI feed.
- **`devswarm-parent-inbox.js` restructured to a per-project summary + urgency tiering + child
  mesh-direct surfacing (Phase 8).** `summaryPath` is now keyed by `repoKey`
  (`summaries/<repoKey>.json`), not per-descriptor `hashFromWorkspaceId(d.id)` — the hook reads
  ONE file per project and iterates every workspace that project's store knows about.
  Attention items are tiered by `urgencyMax` (`tierOf`, L393–407): `urgent`/`high` gets the
  LOUDEST, distinct `buildUrgentUnreadSegment` ("STOP and read... FIRST"); `low` is
  table-row-only (already visible in the live table, deliberately excluded from every textual
  segment so it doesn't compete for attention); everything else (null/`normal`/unrecognized,
  including a stuck-only entry with no urgency at all) keeps the pre-existing
  `buildUnreadSegment` wording byte-for-byte. The Primary's own-unread segment
  (`buildOwnUnreadSegment`) gets an urgency-aware "URGENT PRIORITY" prefix but — per D4's
  type-vs-urgency separation — urgency NEVER changes whether a direct message surfaces/gates,
  only how loud it reads. `recent[]` renders via `buildBroadcastSegment` as an ADVISORY-ONLY
  feed (`[URGENT]` tag only, never a Stop-gate trigger, "react only if you judge it
  relevant"). On the child side, `hooks/devswarm-child-turn.js` gained mesh-direct surfacing
  (D26, `buildMeshDirectSegment`, L192–213): a mesh DIRECT addressed to a child's OWN meshId
  lands in the child's OWN builder-id partition inside the shared store via the D19 addressing
  join — but NOT in the child's durable NDJSON inbox (a separate reception path, `inbox
  pull`'s target) — so the child's turn hook additionally reads its own entry out of the SAME
  `summaries/<repoKey>.json` projection the Primary reads and surfaces a distinct "DEVSWARM
  MESH DIRECT" / "DEVSWARM MESH DIRECT — URGENT" segment for it.
- **ONE ingest daemon per PROJECT, not per worktree (Phase 5, D1/D9).** The installer now
  resolves the PROJECT identity — `resolveMainWorktree(cwd)` = `dirname(gitCommonDir)`
  (`companion/install-devswarm-ingest.js` L218–230) — and bakes it as the daemon's
  `WorkingDirectory`, **never a linked/child worktree** (a child worktree can be removed
  mid-project; baking it in would kill the whole project's ingest the moment its cwd
  vanishes). The unit identity (`labelForProject`/`unitForProject`/`cronMarkerForProject`,
  L214–216) is keyed by `repoKey`, disjointly shaped from a legacy 8-hex per-worktree hash (a
  repoKey always contains an internal `-`, a legacy hash never does — D28 — so unit-name
  parsing can never confuse one shape for the other, `listInstalledIngestUnits`). **Reap-
  before-drain (D9):** before installing/reloading the new per-project unit, the installer
  enumerates the repo's worktrees via `git worktree list --porcelain` from the main worktree
  (`listRepoWorktrees`/`reapPlanForRepo`, L263–289 — `worktreeHash` is a one-way sha256 and
  CANNOT be inverted, so this enumeration is the only correct way to find "which legacy units
  belong to this repo") and stops+unloads every legacy per-worktree unit it finds
  (`reapLegacyUnitsForRepo`, L373–390) BEFORE the new per-project daemon goes live. A brief
  buffered ingest PAUSE during this handoff is EXPECTED — latency, not loss; the ingest
  daemon's own reap-before-drain probe additionally backs off its first `monitor` call while
  any legacy holder still looks alive. `doctor`/`update.js` uninstall targets BOTH the current
  worktree's legacy unit AND the repo's per-project unit (best-effort, an absent one is a
  harmless no-op).
- **Health check — TWO independent signals, not freshness-only (D25,
  `companion/lib/ingest-health.js`, `daemonHealth`, L110–140).** A fresh heartbeat file alone
  is not proof the daemon is alive (a crash right after its last write leaves a fresh-looking
  file); a live process can also have a never-yet-written heartbeat. `daemonHealth(home,
  repoKey)` therefore checks BOTH, pure-fs, no spawn: (1) heartbeat freshness —
  `heartbeats/ingest-<repoKey>.json`, `now - ts <= 3 min`; (2) a live-pid lock holder —
  `locks/ingest-project-<repoKey>.lock` (`devswarm-ingest.js`'s per-project lock shape). BOTH
  must hold for `'healthy'`; either failing (including a missing/unparsable file) is
  `'stale'`, never silently "assumed healthy." **Windows carve-out (D28):** since the ingest
  installer is a documented no-op on win32, `daemonHealth` short-circuits to
  `status:'unsupported'` there — no stale-banner spam, no futile per-turn/per-send installer
  spawn attempted on a platform that structurally cannot run the daemon. Consumed by BOTH the
  per-turn stale-data banners (`devswarm-parent-inbox.js`, `devswarm-child-turn.js`) and the
  CLI's send-time self-heal below, so every consumer agrees on one definition of "alive."
- **Send-time self-heal (Phase 7, `scripts/devswarm.js` `withSelfHeal`, L418–…).** Every mesh
  `send`, `inbox pull`'s native drain, and `archive-request` first resolves `repoKey`, checks
  `daemonHealth`, and — only when the daemon looks stale AND a per-repoKey cooldown file
  (`self-heal/ingest-<repoKey>.json`, `selfHealCooldownElapsed`/`markSelfHealAttempt`,
  L318–347) has elapsed — best-effort spawns the (idempotent) per-project installer to
  (re)install/refresh the daemon. Fail-open: a self-heal failure never blocks the send itself.
- **Doctor orphan-sweep for legacy per-worktree units (Phase 6, D9/D25/D28,
  `hooks/lib/doctor-repair.js` `reapOrphanedLegacyUnits`, L358–…, GATED behind the same
  DevSwarm-active + resolvable-worktree posture every other daemon fix in doctor uses).**
  Belt-and-suspenders (NOT a replacement for the installer's own reap-before-drain above) —
  reaps a legacy per-worktree ingest unit ONLY when it is ALREADY orphaned or redundant: (a)
  its baked worktree no longer resolves at all (genuinely orphaned), OR (b) its worktree's
  `repoKey` resolves AND that repoKey's per-project daemon is CONFIRMED running+healthy
  (`projectDaemonHealthy`, L78–…, the SAME two-signal D25 check as `daemonHealth` above) — i.e.
  the per-project daemon has already taken over, so the legacy unit is pure redundancy. Never
  touches a repoKey-shaped per-project unit (D28's disjoint regex guarantees `hash===null,
  repoKey set` is never mistaken for a legacy one) and never the legacy base (un-suffixed)
  unit, which the existing gated ingest-install section already owns.
- **Rollback — v0.57 mesh → legacy per-worktree units (`skills/update/scripts/update.js`
  `rollbackToLegacyUnits`, L617–…, a documented procedure, not automatic).** Uninstalls the
  current worktree's per-project (repoKey) unit and reinstalls the legacy per-worktree units,
  confirming each is installed AND has a fresh heartbeat before reporting `viable:true` —
  otherwise it reports "not viable... safe to re-check shortly," never a false success.
  Windows: documented no-op (D28, same as the rest of the daemon machinery there).
  `healIngestDaemon` (same file) now also prefers reading back a PER-PROJECT (repoKey) unit
  over a legacy one when both could apply, so its own-config classification (`ok`/`wrong-
  path`/`stale-script`/`absent`) checks the unit actually in charge.
- **Non-destructive hash → repoKey store migration (Phase 3, D13,
  `companion/devswarm-migrate.js` `migrateHashStoresToRepoName`/`...Locked`, L580–753).** Reads
  ONLY legacy 8-hex `store/<hash>/` dirs (`store.listStoreHashes(..., {shape:'legacy'})` —
  NEVER iterates the repoKey stores this same function creates, so a re-run cannot treat its
  own output as a source, D13/Fable P2). For each workspace_id found in a legacy store, the
  repoKey is resolved PER WORKSPACE_ID — never once for the whole legacy store, since one old
  `DEFAULT_HASH` bucket can hold workspaces belonging to genuinely DIFFERENT repos
  (D13/Opus-auditor P2) — from THAT workspace's own registry descriptor's `worktreePath`. A
  workspace with no registry descriptor, no `worktreePath`, or an unresolvable git worktree
  (e.g. deleted) is SKIPPED and reported with an explicit reason — never guessed at. For every
  workspace it DOES resolve, it copies: messages (idempotent by hash; a hash-less legacy row
  gets a stable synthesized hash, `synthRepoKeyMigrateHash`, L580–584, in its OWN disjoint
  `repokey-migrate:` namespace so it can never collide with `legacy:`/`native:`/
  `global-migrate:`/`mesh:`), the registry entry, the cursor AND `broadcast_cursors` value
  (MAX-MERGED, never regressed — safe for a fold where two legacy hashes both route into the
  SAME repoKey), and the gates — then re-derives `summaries/<repoKey>.json`. **NON-
  DESTRUCTIVE:** `store/<hash>/` and `summaries/<hash>.json` are left byte-for-byte intact as
  a backup; this fold runs automatically INSIDE the existing `migrate`/`migrateToStore` call
  (same migrate lock, no separate step required) but is also callable standalone. Count-
  verified per workspace before it is marked `verified:true`.
- **#36-STRUCTURAL cross-project scoping, D29 (REPLACES the spoofable v0.56 env filter
  `d.repoId !== currentRepoId`, which was in the SAME trust class as the #39 ack-guard
  env-spoof).** `hooks/devswarm-parent-gate.js` and `hooks/devswarm-parent-inbox.js` both
  compare each candidate descriptor's `repoKeyForWorktree(d.worktreePath)` against the
  session's own `selfKey = repoKeyForWorktree(cwd)` (resolved ONCE per hook invocation and
  memoized per worktreePath, so N siblings sharing one worktree never re-spawn git more than
  once each) and EXCLUDE the descriptor only when BOTH sides resolve AND differ — fail-open
  when either is unresolvable, so nothing that surfaced pre-#36 can vanish. `devswarm-parent-
  gate.js` needs this filter as an EXPLICIT, separate check because it builds its blocking set
  from the raw, machine-global `readDescriptors()` + per-descriptor `readUnread()` (NOT the
  per-project summary) — re-scoping the summary alone, as `devswarm-parent-inbox.js` does via
  its `summaries/<repoKey>.json` keying, does NOT by itself close this gate-path bleed;
  `devswarm-parent-inbox.js` applies the SAME filter a second time (defense-in-depth) to
  entries it reads out of the live registry even though its summary file is already
  project-scoped. Net effect: a project only ever sees its OWN workspaces in the gate/inbox
  hot paths, closing the confirmed cross-project bleed (#36; ToolFox3 gated on SkyCrew) the
  earlier `DEVSWARM_REPO_ID` env filter never actually closed.
- **Codex/OMX mesh support — DEFERRED, not shipped (v0.57.1, owner decision O-D3).** Every
  item above (`repoKey`, the per-project store, the mesh CLI, the per-project ingest daemon,
  the doctor orphan-sweep, the migration, and the #36 structural filter) exists ONLY on the
  Claude-side plugin (`plugins/anti-hall/hooks/`, `plugins/anti-hall/companion/`,
  `plugins/anti-hall/scripts/devswarm.js`). The Codex port
  (`plugins/anti-hall/codex/skills/anti-hall-devswarm/SKILL.md`) does not yet describe or
  ship any mesh capability — do not claim otherwise until v0.57.1 lands.

### 8.7.1 Single-consumer importance (why the read-guard exists)

Stated once, explicitly, because it is the load-bearing invariant behind §8.5's read-guard
AND every lock in this substrate: **exactly one process may ever be the native consumer of
a given `hivecontrol` message queue at a time.** `read-messages` and `monitor` both
DESTRUCTIVELY drain/mark-read the native queue — there is no non-destructive full read.
If two consumers ever call either concurrently against the SAME queue, each drains
whatever the other did not already see; the split is silent (no error, no signal that a
message went to the "wrong" reader) and unrecoverable (a marked-read native message cannot
be un-marked). This is why:
- The ingest daemon (`devswarm-ingest.js`) takes an O_EXCL lock and refuses to start a
  second instance against the same worktree's queue (§8.7's per-worktree identity note).
- The child-side pull (`devswarm-pull.js`'s `pullOnce`) takes a PER-ID O_EXCL lock so a
  child never drains its own queue twice concurrently.
- **Every other consumer — hooks, agents, the Primary, a delegated subagent — must NEVER
  call `read-messages`/`monitor` directly at all**, not even once, not even "just to
  check": there is no way to tell, from outside, whether the ingest daemon or a child's
  pull is ALSO about to poll the same queue, so any ad-hoc call is a potential silent
  split. This is why §8.5's guard blocks it UNCONDITIONALLY rather than trying to detect
  contention — contention is exactly the thing that cannot be detected from a single call
  site. Read pending messages via the wrapper instead (§8.8): it reads the DURABLE inbox
  (already-drained, safe to read any number of times) or the STORE (same), never the
  native queue directly.

### 8.7.2 Second consumer — how to fix (#32)

The locks in §8.7.1 (the ingest daemon's O_EXCL lock, the child pull's PER-ID O_EXCL lock) only
prevent **anti-hall's own tooling** from calling `monitor`/`read-messages` twice against the same
queue. They cannot see, and cannot block, an **EXTERNAL, non-tool-call consumer** — a process
outside anti-hall's control that independently calls `hivecontrol workspace monitor` or
`read-messages` against the same queue. That's a structural limit, not a bug: anti-hall's guards
only intercept commands routed through Claude's/Codex's own tool-call path (`command-guard.js`);
a bare shell loop, a cron job, a `launchd`/`systemd`/`pm2` unit, or a `package.json` start script
invoking `hivecontrol` directly never goes through that path at all.

**Symptoms:** parent↔child messages seem to vanish or arrive out of order; the durable inbox
count and what the child/parent actually said disagree; `devswarm-ingest.js` or `devswarm-pull.js`
report unexpectedly low/zero inserts despite known outstanding traffic.

**anti-hall CANNOT mechanically block or kill an EXTERNAL non-tool-call consumer — detection plus
your own action are the only levers.** There is no code path in this plugin that can see a
process outside its own tool-call surface, let alone terminate one. The fix is manual, and it is
a PARENT-role action (the parent orchestrator/operator is the one positioned to audit and clean up
the machine/CI environment a workspace runs in):

1. **Identify.** Look for any process besides the installed ingest daemon (or a child's own
   bounded `inbox pull`) invoking a consuming native command:
   ```bash
   ps aux | grep 'hivecontrol.*monitor'
   ps aux | grep 'hivecontrol.*read-messages'
   ```
   Cross-check against the ONE process that's supposed to be running: the installed ingest
   daemon's own PID (`devswarm-ingest.js`, discoverable via `listInstalledIngestUnits()` /
   `node hooks/doctor.js`'s DevSwarm section) or a child's transient `inbox pull` invocation
   (short-lived, bounded by its 10 s `read-messages` timeout — anything long-lived matching
   `monitor` that ISN'T the ingest daemon is the second consumer).
2. **Stop it — kill the process AND remove whatever respawns it,** or it comes back on the next
   tick:
   ```bash
   kill <PID>
   ```
   Then remove its respawn source — whichever applies:
   - a `cron` entry (`crontab -l` / `crontab -e`, delete the matching line),
   - a `launchd` job (`launchctl list | grep -i devswarm`, `launchctl unload <plist>`, remove the
     plist),
   - a `systemd --user` unit (`systemctl --user list-units | grep -i devswarm`, `systemctl --user
     disable --now <unit>`),
   - a repo shell loop (a `while true; do hivecontrol workspace monitor; done`-shaped script —
     stop whatever supervises it, e.g. `pm2 delete`/`tmux kill-session`/a CI job definition),
   - a `package.json` `start`/`dev`/`watch` script that shells out to `hivecontrol monitor` —
     remove or gate that call.
3. **Verify.** Re-run `node plugins/anti-hall/hooks/doctor.js` (silent unless DevSwarm is active;
   otherwise runs a live behavioral self-test plus a PASS/WARN/FAIL readout per workspace) and
   confirm reception behaves correctly again — e.g. a fresh `inbox pull`/`inbox messages --unread`
   count now matches what was actually sent, with no further silent gaps.

This is a detection-and-cleanup problem, not something a future anti-hall release can close by
itself: **anything that reaches `hivecontrol` outside a Claude/Codex tool call is invisible to
every guard in this plugin by construction.**

---

## 8.8 Full CLI reference — `scripts/devswarm.js`

THE structured interface (CLI over MCP — owner preference; every subcommand below is a
**thin wrapper reusing already-built primitives**, per the file's own header comment — it
invents no parallel schema). Every command emits one JSON line on stdout and a matching
process exit code (`0` = `ok:true`, `2` = `ok:false`/unknown command/unsafe id); every
positional `<id>` is `isSafeId`-gated (`^[A-Za-z0-9._-]+$`, never `.`/`..`, never a bare
`..` anywhere in the string) before it is ever `path.join`'d — an unsafe or missing id
fails closed with `{ok:false, error:...}` for every subcommand, never a throw. Verified
line-for-line against the current `plugins/anti-hall/scripts/devswarm.js`.

| Command | Purpose | Source |
|---|---|---|
| `register <id> --worktree P --session S [--inbox NDJSON] [--cursor P] [--nudge ARGV]...` | Write/update a workspace descriptor (`workspaces/<id>.json`) + upsert the store registry. `--worktree`/`--session` are REQUIRED for a fresh registration — a descriptor missing either is invisible to the supervisor's `readDescriptors` (which filters on both), so `register` validates the MERGED result and fails closed rather than silently writing a phantom registration. Initializes the durable cursor to `0` if one doesn't already exist (non-destructive — never clobbers an existing cursor). | `cmdRegister` L254–294, dispatch L690–695 |
| `ensure <id> [--worktree P] [--session S] ...` | Idempotent `register`: if a descriptor already exists it is LEFT UNTOUCHED (only the store registry is re-upserted, refreshing the `summary.json` projection); only a genuinely-absent descriptor goes through full `register` validation. `inbox pull` calls this internally to auto-create a child's descriptor before draining. | `cmdRegister(..., {requireNew:true})` L254–294, dispatch L696–701 |
| `register-primary [--worktree P] [--session S] [--inbox NDJSON] [--cursor P]` | Register the CURRENT worktree's Primary/parent descriptor under its PER-WORKTREE id `primary-<worktreeHash>` (§8.7's per-project identity — never the old collision-prone hardcoded `'primary'`). `--worktree` defaults to `git rev-parse --show-toplevel` of cwd; `--session` defaults to `DEVSWARM_BUILDER_ID` env or the derived id; `--cursor` defaults to `cursors/<id>.json` (the durable ACK cursor `inbox messages --ack`/`read-primary` advance — a SEPARATE cursor namespace from a child's own descriptor `cursorPath`); `--inbox` optionally points `migrate` at a legacy NDJSON source to fold into this partition. | `cmdRegisterPrimary` L476–493, dispatch L752–755 |
| `heartbeat <id> [--progress N] [--phase X] [--wip T]... [--blockers T]... [--session S]` | Write a turn-authored heartbeat (`heartbeats/<id>.json`). Only asserts fields the caller actually supplied — NEVER fabricates `progress`/`phase`/`wip`/`blockers` (absent input = `null`/`[]` on write, not a guess). Consumer/session-invoked ONLY — the heartbeat-authorship rule (§8.7) forbids a background ticker ever writing one. | `cmdHeartbeat` L296–325, dispatch L702–706 |
| `inbox pull <id> [--session S]` | CHILD-side reception drain. Auto-`ensure`s the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate FIRST (count `0` → returns without ever calling `read-messages`); on count `>0`, exactly ONE bounded `read-messages` (10 s finite timeout, never the blocking `monitor`); appends the batch to the durable inbox NDJSON in one atomic write, idempotent by content hash; feeds the store-parity projection with the same hash. | `cmdInboxPull` L335–362 → `companion/lib/devswarm-pull.js` `pullOnce` L177–290 |
| `inbox read <id>` | CHILD-side cursor read: the unread slice of the durable inbox NDJSON past the descriptor's own `cursorPath`. Requires an existing descriptor with `inboxPath` (`register`/`ensure`/`inbox pull` all create one). | `cmdInbox` 'read' branch L450–453 |
| `inbox count <id>` | CHILD-side non-destructive unread COUNT only (no message bodies) against the descriptor's inbox. | `cmdInbox` 'count' branch L446–449 |
| `inbox ack <id> [--to N]` | Advance the descriptor's durable cursor. No `--to` = ack-all (cursor := current total); `--to N` sets an absolute count, clamped to `[0, total]` so an over-ack can never swallow messages that arrive later. This is the parent-gate's non-skip CLEAR path. CHILD-side only (operates on the descriptor's own `cursorPath`) — no `callerIdentity` check here, since a descriptor-scoped cursor has no cross-workspace hazard; that hazard lives in `inbox messages --ack`/`read-primary` below, which is store-scoped and keyed by an arbitrary `<id>`. | `cmdInbox` 'ack' branch L454–466 |
| `inbox messages <id> [--unread] [--ack] [--ack-as-owner] [--json]` | **Primary/store non-destructive READ path.** Reads message BODIES directly from the store (`store.listMessages`) — never touches the native queue, needs NO descriptor (rows are keyed by workspace id regardless of registration, so it works even for an id nothing ever `register`ed). `--unread` returns only messages past the durable ACK cursor at `cursors/<id>.json` (note: this is a DIFFERENT cursor file/namespace than a child descriptor's own `cursorPath` used by `inbox read`/`ack`). `--ack` additionally advances that cursor to the current total in the same call (equivalent to `read-primary`) — **ack-ownership guard (v0.56.0, P0-hardened):** before ANY `--ack`, `cmdInboxMessages` calls `callerIdentity(env, cwd)` and refuses (`ok:false`, cursor left untouched) unless the caller's own identity equals `<id>`, UNLESS `--ack-as-owner` is passed explicitly to override for a legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog on its behalf). `callerIdentity` treats **cwd as ground truth**: when cwd resolves to a real git worktree, identity is derived from that worktree and a `DEVSWARM_BUILDER_ID` env var naming a *different* workspace is IGNORED — never trusted to override — closing the env-spoof path where a workspace could set `DEVSWARM_BUILDER_ID=<other-id>` to impersonate another workspace and ack its cursor. `DEVSWARM_BUILDER_ID` is honored as a declared identity only when it can't contradict cwd (cwd already agrees, or cwd resolves to no worktree at all). `--json` is accepted for CLI-invocation parity and is otherwise a no-op — output is always JSON regardless. | `cmdInboxMessages` L393–433, `callerIdentity` L124–139, dispatch via `cmdInbox` L438 |
| `inbox read-primary <id> [--ack-as-owner]` | Sugar for `inbox messages <id> --unread --ack` under one name — "read what's unread, then advance the ACK cursor," the Primary's one-shot ergonomic. Subject to the SAME ack-ownership guard as `inbox messages --ack` above (it sets `{ack:true}` internally, so `callerIdentity` is checked identically; `--ack-as-owner` overrides identically). | `cmdInboxMessages(..., {ack:true})` L393–433, dispatch L439 |
| `workspaces list` | Derive + emit the `summary.json` projection: `{requiredGates, count, workspaces: {...}}`, one entry per registered workspace with `total`/`cursor`/`unread`/`gates`/`archive_ready`. | `cmdWorkspacesList` L495–514, dispatch L714–718 |
| `gate <id> --set CSV --clear CSV [--by NAME]` | Mark/unmark named completion gates (append-only in the store — a set/clear appends a new timestamped row; current value = latest row per name). anti-hall is agnostic about what any gate MEANS — the consumer defines and sets them (default required set for `archive_ready`: `done,merged,tests_passed`, override via `ANTIHALL_DEVSWARM_REQUIRED_GATES`). `--by` names the setter (default `devswarm-cli`). | `cmdGate` L516–538, dispatch L719–724 |
| `nudge <id>` | Poke-or-escalate one workspace ON DEMAND, honoring the same persisted attempt-count/cooldown state the automatic supervisor sweep would (reuses `recovery.pokeOrEscalate` — the identical primitive, not a re-implementation). | `cmdNudge` L540–550, dispatch L725–730 |
| `archive <id>` | Archive-by-absence on anti-hall's OWN registry ONLY: moves the descriptor into `archived/` (renames — never unlinks) and tombstones the store registry entry. hivecontrol itself has NO teardown/delete/archive command at any level (§4/§10), so this SURFACES a manual "remove workspace X in the DevSwarm app" step in its response — it never runs an actual delete. | `cmdArchive` L552–575, dispatch L731–735 |
| `archive-ignore <id>` / `archive-unignore <id>` | Write / remove a per-workspace `archive-ignore/<id>.json` mute of the `devswarm-parent-inbox` archive-ready reminder. | `cmdArchiveIgnore` L577–592, dispatch L736–745 |
| `archive-request <childId\|childBranch> [--reason TEXT] [--child-branch B]` | **PARENT-side, SEND-ONLY (v0.56.0).** Posts a `[[ANTIHALL_ARCHIVE_REQUEST]]`-prefixed message to the child via `hivecontrol workspace message-child <branch> <msg>`, asking it to archive. Resolves the child branch: explicit `--child-branch` → the descriptor's own `branch` field (if ever set) → a `hivecontrol workspace list children` lookup matching branch/id/worktree → the positional id itself. NEVER verifies merged/tested/deployed itself (that's the parent repo's own policy to enforce first) and NEVER runs `archive` on the child's behalf. Fail-open on a `message-child` spawn error (`ok:false`, never a throw). | `cmdArchiveRequest` L655–674, `resolveChildBranch` L622–647, `ARCHIVE_REQUEST_MARKER`/`buildArchiveRequestMessage` L596–605, dispatch L746–751 |
| `migrate` | Auto-migrate on-disk state (the JSON descriptor registry + each descriptor's legacy NDJSON inbox/cursor) into the store. Idempotent (dedupe hash from id + line-index + content), NON-DESTRUCTIVE (reads sources only, never deletes/moves/truncates), single-consumer-locked (O_EXCL), and COUNT-VERIFIED (store count must equal distinct legacy lines) before it reports `verified:true`. As of v0.57 this ALSO folds in the non-destructive hash→repoKey mesh migration (§8.7's v0.57 note) inside the SAME migrate lock. Picks up `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ` from `ctx.env` (no dedicated `--mark-read` CLI flag on THIS subcommand — that flag lives on the separate `scripts/migrate-state.js` script, §8.7's v0.56.0 note). | `cmdMigrate` L921–968 → `companion/devswarm-migrate.js`, dispatch L1182–1184 |
| `send --to <meshId>\|--broadcast --message TEXT [--from <id>] [--urgency low\|normal\|high\|urgent]` | **v0.57 MESH (SHIPPED — Claude-side only).** Writes THIS project's shared `store/<repoKey>/` DIRECTLY — daemon-independent, zero `hivecontrol` calls (wrapped in send-time self-heal, `withSelfHeal`). `repoKey` is resolved from cwd FIRST; a non-git cwd returns `{ok:false, reason:'no-project'}` before any identity is derived (D28). `--from` is always re-derived from cwd (`callerIdentity`, spoof-resistant); an explicit `--from` must match or the send is rejected. `--to <meshId>` is fail-closed against the shared registry (D12a) — an unregistered meshId is rejected, never silently black-holed; the row lands in the target's REAL builder-id partition (D19), not the meshId itself. Default `urgency` `normal`. | `cmdSend` L969–1049, `resolveMeshTarget` L952–959, dispatch L1185–1189 |
| `roster [--ack]` | **v0.57 MESH.** ALLOW-listed projection read of this project's shared registry + `working_on` + `recent[]` broadcast digest, derived fresh (never cached). `--ack` is an alias of `mesh read` below — the ONLY surface that clears `broadcastUnread`. | `cmdRoster` L1055–1069, dispatch L1190–1195 |
| `mesh read` | **v0.57 MESH.** Same as `roster --ack` (D23) — lists the caller's unseen NON-heartbeat broadcasts past its own broadcast cursor, then advances that cursor to head. | `cmdMeshRead` L1077–1098, dispatch L1196–1203 |
| `heartbeat <id> --summary TEXT [--urgency ...]` | **v0.57 MESH addition to the existing `heartbeat` verb.** `--summary` ALSO broadcasts a mesh heartbeat row (`mtype:'broadcast'`, `is_heartbeat:1`) into this project's shared store — feeds `roster`'s `working_on` field (matched by `sender === d.id`). Default urgency `low`. A non-git cwd does not fail the base heartbeat write; it reports `meshBroadcast:{ok:false, reason:'no-project'}`. | `cmdHeartbeat` L473–543, dispatch L1122–1126 |

**Worked example — a full Primary/child lifecycle end to end:**
```bash
# Primary, from its own worktree — register once (per-worktree id, idempotent):
node scripts/devswarm.js register-primary --session "$CLAUDE_SESSION_ID"
#  -> { ok:true, action:"register-primary"|"registered"|"updated", id:"primary-<hash>", ... }

# A child workspace registers itself (worktreePath/sessionId REQUIRED):
node scripts/devswarm.js register child-1 --worktree /path/to/child/worktree --session "$CHILD_SESSION_ID"

# Child drains its native parent->child queue into its own durable inbox, then reads it:
node scripts/devswarm.js inbox pull child-1
node scripts/devswarm.js inbox read child-1
node scripts/devswarm.js inbox ack child-1          # ack-all once processed

# Primary reads what its OWN reception queue collected (no native call, no descriptor
# needed — the store is keyed by id) and acks it in one shot:
node scripts/devswarm.js inbox read-primary primary-<hash>

# Consumer marks completion gates; anti-hall derives archive_ready once all are set:
node scripts/devswarm.js gate child-1 --set done,merged,tests_passed
node scripts/devswarm.js workspaces list             # archive_ready:true once satisfied

# PARENT: after verifying merged+tested+deployed per ITS OWN repo policy (anti-hall does
# not check this), ask the child to archive — SEND-ONLY, never archives itself:
node scripts/devswarm.js archive-request child-1 --reason "shipped in v1.2.0"

# CHILD: sees the [[ANTIHALL_ARCHIVE_REQUEST]] marker via its per-turn unread surfacing,
# confirms with ITS OWN user, then (and only then) archives:
node scripts/devswarm.js archive child-1              # archive-by-absence + manual-step note
```

**v0.57 mesh — all-to-all, run from ANY worktree of the same project (Claude-side only):**
```bash
# Every worktree of THIS project shares one repoKey store — no register/register-primary
# needed first; send is daemon-independent and writes the shared store directly.
node scripts/devswarm.js send --to sibling-worktree --message "picking up the API layer" --urgency normal
node scripts/devswarm.js send --broadcast --message "starting DB migration, hold off on schema edits" --urgency high

# Any worktree of the SAME project can read the shared roster + unseen broadcasts:
node scripts/devswarm.js roster                 # {repoKey, workspaces:[...], recent:[...]}
node scripts/devswarm.js mesh read               # unseen non-heartbeat broadcasts, then acks them

# A routine status ping (also updates roster's working_on for this workspace):
node scripts/devswarm.js heartbeat sibling-worktree --summary "60% through the API layer"
```

Every subcommand above was verified to exist at the cited line by reading the current
`scripts/devswarm.js` directly — none is inferred from a skill/doc description. No other
`devswarm.js` subcommand exists; `hivecontrol workspace <cmd>` (§4.1) is a SEPARATE,
native binary this CLI never shells out to except via the two guard-redirected code paths
already covered in §8.5/§8.7 (the ingest daemon's `monitor` wrap and the child pull's
bounded `message-count`/`read-messages` pair).

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
