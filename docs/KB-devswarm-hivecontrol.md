# KB — DevSwarm & the `hivecontrol` CLI (multi-workspace orchestration)

> Reference KB for **DevSwarm** (devswarm.ai) — the multi-workspace AI IDE that runs each
> task as an isolated git-worktree "workspace" with its own agent — and its bundled
> **`hivecontrol`** CLI, the terminal control surface anti-hall can drive to orchestrate
> across workspaces. Compiled 2026-07-04 from **20 sources (15 official)** plus **primary
> evidence gathered by executing `hivecontrol` v2.3.3 and extracting the DevSwarm.app
> Electron bundle on this machine**. **Re-verified 2026-07-14 against the installed v2.3.5
> binary** — this pass found the surface materially larger than previously documented: two
> entire top-level command groups (`jira`, `team`) and one hidden verb (`workspace search`)
> exist and work, but are **not listed in `hivecontrol --help`'s own top-level output** — see
> §4.3/§4.4 and §13.
>
> **Superseded-in-part:** §1–§13 are the v2.3.5-era record (still accurate for that build). For
> the installed v2.5.1 surface, the version timeline (including the public vendor changelog),
> the official-docs coverage review, and the delta analysis, see §14–§21 appended below
> (verified 2026-08-21).
>
> **Verify-first headline:** public web sources conclude DevSwarm "has no CLI." That is
> **false in the strong form** — `hivecontrol` v2.3.5 is real, ships inside `DevSwarm.app`,
> and is on every workspace's `PATH`. It is simply *undocumented publicly* — and, as of the
> 2026-07-14 pass, **partially undocumented by its own `--help` too** (`jira`/`team`/
> `workspace search` work but don't appear in the top-level command list). Everything in
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
  2 github.com/devswarm-ai; + 5 community/forum) + **6 primary local-evidence sources** (CLI
  `--help` v2.3.3 → re-verified v2.3.5, `app.asar` `electron/main.js`, live `DEVSWARM_*` env of
  this Primary Workspace **plus a live child-workspace probe**, a `hivecontrol repo validate`
  run, the injected agent system-prompt, **and — new in the 2026-07-14 pass — a `grep` sweep of
  the bundled `devswarm` CLI script itself for `.command("...")`/`new Command("...")`
  registrations and `DEVSWARM_*` env-var references**, which is how the hidden `jira`/`team`
  groups and `workspace search` verb were confirmed real rather than guessed). Clears the
  10-source / 2-official floor comfortably.
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
- **`hivecontrol` v2.3.5** (bundled at `/Applications/DevSwarm.app/Contents/Resources/cli/`,
  on `PATH`) advertises 4 top-level commands in its **own `--help` output** — `workspace`,
  `repo`, `health`, `open` — with 13 `workspace` and 7 `repo` subcommands. **It actually ships
  6**: two more groups, `jira` (14 subcommands, Jira issue/sprint/version/worklog CRUD via
  DevSwarm's stored OAuth) and `team` (5 subgroups: `metrics`, `members`, `workspace`,
  `session`, `conversation` — org analytics, Team-plan gated), work when invoked directly but
  are **omitted from the top-level `--help` command list** — genuinely hidden, not merely
  under-documented. `workspace` also has a 14th, similarly hidden verb: `search` (Team-plan
  gated). See §4.3/§4.4. **Most output JSON for agent parsing** (`configure`/`help`/`--help`
  print human text) [P1].
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
| **`hivecontrol`** (CLI) | The **bundled** DevSwarm CLI (`/Applications/DevSwarm.app/.../cli/hivecontrol`, v2.3.5). `hivecontrol` is a POSIX-sh wrapper that execs the real `devswarm` binary in the same dir (sets `DEVSWARM_INVOKED_AS=hivecontrol`) | ✅ **yes — the control surface** |
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
  (observed live: `~/.devswarm/repos/1/<hex8>/probe-devswarm-env-check`) [P2][P3].
- **Ports:** hard-coded range **2000–9999**, assigned **per-builder in memory** (not
  DB-persisted) [P2].
- **All user/agent docs are baked into JS string literals** — there are **no** standalone
  markdown/help files in the bundle; the agent system-prompt (the natural-language→CLI table +
  "monitoring is the default resting state" protocol) lives in `main.js` [P2][P5].

---

## 4. The `hivecontrol` CLI — command reference (v2.3.5, verified)

> **Re-verified 2026-07-12 against `hivecontrol` v2.3.4 (bumped from 2.3.3 — patch-level
> only).** Ran `--version` and every `--help` one level deep (`workspace`, `repo`, `health`,
> `open`, plus all 13 `workspace` and all 7 `repo` subcommand `--help`s, including
> `list children`/`list all`/`port-vars add`/`worktree-include add`/`scripts set`). **Zero
> surface changes**: identical top-level groups, identical subcommand counts, identical flags
> (including `-t/--title` on `create`, `--tree` on both `list` subcommands, `-w/-y/-s` on
> `update-base`, `-i/-t` on `monitor`). No `--json` flag exists anywhere (JSON is the
> unconditional default output, confirmed by the top-level help's "All commands return JSON
> for easy parsing by AI agents" line — not an opt-in flag). No `archive`/`delete`/`status`
> subcommand exists at any level (still true at 2.3.5 too) — the "GUI-only teardown" gap in
> §10/§8.6 is still real.
>
> **Re-verified 2026-07-14 against `hivecontrol` v2.3.5 (bumped from 2.3.4) — surface materially
> larger than the 2.3.3/2.3.4 passes found.** The earlier passes ran `--help` one level deep
> from the top-level `--help` command LIST and concluded the surface was exhaustive. It wasn't:
> `hivecontrol --help`'s own "Commands:" section lists only `repo`, `workspace`, `health`,
> `open`, `help` — but `hivecontrol jira --help` and `hivecontrol team --help` both return real,
> fully-documented command trees (exit 0), and `hivecontrol workspace search --help` returns a
> real, fully-documented leaf command not listed in `hivecontrol workspace --help`'s own command
> list either. Confirmed these aren't a fluke three ways: (1) each returns full `--help` text
> with its own options/description, not a "command not found" error; (2) `hivecontrol workspace
> search <query>` (no `--help`) returns a **structured JSON error** (`TEAM_SUBSCRIPTION_REQUIRED`)
> rather than a CLI usage error, meaning it reached real command-handling code; (3) `grep`ing the
> bundled `devswarm` script for `new Command("...")` registrations turned up exactly these groups
> (`jira`, `team`, `search`, plus `workspace`/`repo`'s own known subgroups) and no others — see
> §4.3/§4.4 for the full `jira`/`team` reference and §4.1 for `workspace search`. Also grepped for
> `.command("...")` leaf registrations to catch anything `--help` might still be hiding; the two
> stray `lint`/`serve`/`watch` hits that surfaced were verified to be **example code inside a JS
> comment**, not registered commands — see the false-lead note in §13. Everything else (§4.1's 13
> listed `workspace` subcommands, §4.2's 7 `repo` subcommands, all flags) is **byte-for-byte
> unchanged** from the 2.3.4 pass — same flags, same `-t/--title` on `create`, same `--tree`,
> same `-w/-y/-s` on `update-base`, same `-i/-t` on `monitor`, no `--json` flag, no
> `archive`/`delete`/`status` verb at any level.

Bundled at `/Applications/DevSwarm.app/Contents/Resources/cli/{hivecontrol,devswarm}`; on the
`PATH` of every workspace shell. **Most commands return JSON** for agent parsing (`configure`
and `help`/`--help` print human-readable text) [P1]. Invoke `hivecontrol --help`.

**Top-level, per `hivecontrol --help`'s own command list:** `workspace` · `repo` · `health`
(exit 0 healthy / 1 unhealthy) · `open [path]`. **Actually 6 — `jira` and `team` also exist and
work but are absent from this list** (§4.3/§4.4).

### 4.1 `hivecontrol workspace` (13 documented subcommands + 1 hidden)

| Command | Purpose |
|---|---|
| `list children [--tree]` | Your direct children (JSON); `--tree` = your subtree as ASCII |
| `list all [--tree]` | Every workspace in the repo (flat JSON); `--tree` = full ASCII hierarchy |
| `info [idOrBranch]` | Workspace details (branch, path, agent, terminal, **`sourceBranch`**, children[]); defaults to current |
| `create <branch>` | Create a workspace. Flags: `-s/--source <branch>`, `-a/--agent <agent>` (default `claude`), `-p/--prompt <text>`, `-t/--title <title>`, `-r/--remote` (use existing remote branch). **Default value of `-s/--source` is internally inconsistent in the CLI's own text** — see the callout below the table |
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
| `search [query] [options]` **(hidden — v2.3.5 finding)** | **Not listed in `hivecontrol workspace --help`'s own command table**, but `hivecontrol workspace search --help` returns full, real help. "Search unified knowledge across your team's workspaces and prompts (Team plan)." Options: `--user <userId>`, `--since <range>` (e.g. `7d`, `30d`), `--status <state>` (`active`\|`archived`\|`any`), `--limit <n>` (default 20), `--explain` (per-result scoring breakdown), `--org <id>`. **Gated**: running it without a Team subscription returns a structured JSON error, `{"success": false, "error": "...requires a Team subscription...", "code": "TEAM_SUBSCRIPTION_REQUIRED", "hint": "..."}`, exit 1 — verified live on this (non-Team) install; the search behavior itself past that gate is **UNVERIFIED** (present in the CLI surface; behavior not verified). Confirmed genuinely part of the product, not a fluke: the bundled `devswarm` script's own baked-in AI-agent system-prompt text (`WORKSPACE_SEARCH_REFERENCE_LINE`/`WORKSPACE_SEARCH_MAPPING_ROW`) references this exact command and is conditionally appended only `if (entitlements.team)`. |

> **`-s/--source` default — the CLI's own text disagrees with itself, both readings verified
> verbatim, neither edited.** `hivecontrol --help`'s top-level prose says: *"When you create a
> workspace, it uses YOUR CURRENT BRANCH as source by default."* But `hivecontrol workspace
> create --help` prints the flag itself as `-s, --source <branch>  Source branch to branch from
> (default: main)`. Both were captured directly from the v2.3.5 binary in the same session — this
> is not a KB transcription error, the CLI genuinely says two different things in two different
> help surfaces. Unverified which one the code actually does when `-s` is omitted; treat as
> UNVERIFIED and pass `-s/--source` explicitly to avoid relying on either claimed default.

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

### 4.3 `hivecontrol jira` (14 subcommands) — **hidden group, v2.3.5 finding**

**Not listed in `hivecontrol --help`'s top-level command table**, but `hivecontrol jira --help`
returns full, real help: *"Read & write Jira issues from the CLI using DevSwarm's stored OAuth
tokens. All output is JSON."* Confirmed genuinely part of the product (not a fluke or a stub):
the bundled `devswarm` script's own baked-in AI-agent guidance text (`JIRA_GUIDANCE_SECTION`,
conditionally appended `if (entitlements.jira)`) tells the in-workspace AI agent to *"prefer
`hivecontrol jira` over any Atlassian/Jira MCP server."* All subcommands infer the issue key
from the current branch (e.g. `SWARM-123/...`) when `[key]` is omitted.

| Command | Purpose / flags |
|---|---|
| `auth [--start] [--reauth]` | Show auth status. `--start` kicks off OAuth if not signed in; `--reauth` forces disconnect+restart (useful after DevSwarm bumps OAuth scopes) |
| `disconnect` | Clear stored Jira OAuth tokens |
| `me` | Show the current authenticated Jira user |
| `projects` | List Jira projects available to the authenticated user |
| `get [key]` | Fetch a single issue by key |
| `search [options]` | Run a JQL search. `--jql <jql>`, `--limit <n>` (default 50), `--next-page-token <token>`, `--fields <list>` (default `summary,status,assignee,priority,issuetype,created,updated,labels,parent`), `--no-scope` (query is auto-scoped to the repo's linked Jira project by default) |
| `transitions [key]` | List valid status transitions for an issue (names + IDs vary per project workflow) |
| `create [options]` | Create an issue; returns `{ id, key, self }`. **`--type <type>` and `--summary <text>` are REQUIRED** (verified in source: `.requiredOption(...)`, not just `--help` prose). Also: `--project <key>` (defaults to the repo's linked project), `--description <text>` (markdown-lite: blank-line paragraphs, `## `/`### ` headings, `- ` bullets, `1. ` numbered lists), `--parent <key>`, `--assignee <id>` (or `me`), `--labels <list>` (comma-separated), `--sprint <id>` (numeric), `--fix-version <value...>` (repeatable), `--field <kv...>` (repeatable; JSON-parses values starting with `[`/`{`) |
| `update [options] [key]` | Partial update — only passed fields are touched. Same field flags as `create` minus `--type`/`--project`/`--parent`/`--assignee` (no `--assignee` here; use `assign` below) |
| `transition [options] [key]` | `--to <name>` — apply a transition by name (e.g. `"In Review"`); an invalid name's error lists valid transitions |
| `comment [options] <text>` | `--key <key>` for explicit issue (else branch-inferred) |
| `assign [options] [key]` | `--me`, `--user <accountId>`, or `--unassign` |
| `versions {list,create,update}` | `list [projectKey]`; `create` (`--project`, `--name` **required**, `--description`, `--start-date`, `--release-date`, `--released`); `update <id>` (`--name`/`--description`/`--start-date`/`--release-date`, at least one required — release-state changes are deliberately not exposed) |
| `sprints {boards,list}` | `boards [projectKey]`; `list <boardId>` (`--state active\|closed\|future`) |
| `worklog {list,add}` | `list [key]`; `add [key]` (`--time <duration>` e.g. `"1h 30m"`, or `--seconds <n>`, `--comment <text>`, `--started <iso>`, defaults to now) |

**Verified env var (new, not previously documented):** `DEVSWARM_NO_AUTO_AUTH` — when a `jira`
command hits an auth error, the CLI auto-launches the OAuth flow by default; setting
`DEVSWARM_NO_AUTO_AUTH=1` (or any truthy value other than `"false"`/`"0"`/empty) disables that
auto-launch (verified in source: `shouldAutoAuth()` reads `process.env.DEVSWARM_NO_AUTO_AUTH`).

> **Documentation bug found in the CLI itself, not this KB — verified in source, not guessed.**
> The bundled `devswarm` script's own agent-facing guidance text (`JIRA_GUIDANCE_SECTION`, shown
> to the AI agent inside a DevSwarm workspace) gives the example `hivecontrol jira create -s
> "<summary>" -d "<description>"`. **`-s`/`-d` are not real flags on `jira create`** — the actual
> registered options (confirmed via both `--help` and a source grep for `.requiredOption`/
> `.option` on the `create` command) are the long-form `--summary <text>` and `--description
> <text>` only; `--type` is also required and isn't mentioned in that example at all. An agent
> that copies the in-app example verbatim will get a CLI usage error. Use the flags in the table
> above, not the in-app example.

### 4.4 `hivecontrol team` (5 subgroups) — **hidden group, v2.3.5 finding, Team-plan gated**

**Not listed in `hivecontrol --help`'s top-level command table**, but `hivecontrol team --help`
returns full, real help: *"Team search, metrics, and analytics. Output is structured JSON
intended for an AI agent to consume."* Every leaf command below returned real, detailed
`--help` text on this (non-Team) install; **actually invoking any of them without a Team
subscription is expected to fail with the same `TEAM_SUBSCRIPTION_REQUIRED` JSON error shape
observed for `workspace search`** (§4.1) — not independently re-verified per-subcommand here
(would require running a mutating-adjacent probe against every leaf; the `workspace search`
probe already established the gate's error shape once, which is sufficient — repeating it 13
more times adds no new information). Treat every field/response-shape claim below as **present
in the CLI surface; response payload not verified** (only the `--help` text and the gating
error class were observed).

| Command | Purpose / flags |
|---|---|
| `metrics token-leaderboard [options]` | Token consumption leaderboard per member. Returns `{ entries, nextCursor, totalCount }` (per `--help`; payload unverified). `--since <range>` (default `30d`), `--sort <total_tokens\|cost\|percent_change>` (default `total_tokens`), `--org <id>`, `--project <id\|slug>` |
| `metrics adoption [options]` | DAU/WAU/MAU, activation rate, engagement tiers, trend. `--since`, `--org`, `--project` (same shape as above) |
| `metrics kpis [options]` | Avg/peak parallelism, PRs merged/dev/week, KPI cards with sparklines. `--since`, `--org`, `--project` |
| `metrics summary [options]` | One-call aggregate of the three `metrics` commands above, run in parallel. `--focus <tokens\|adoption\|kpis>` restricts to one area (default: all). `--since`, `--org`, `--project`. Per `--help`: *"returns raw data only"* — no LLM synthesis happens server-side |
| `members [options]` | List org members. `--search <name>`, `--org <id>` |
| `workspace info <id> [--org <id>]` | Workspace detail: metadata + recent sessions + founding prompt |
| `workspace owners <id> [--org <id>]` | Per-workspace user session counts |
| `session info <id> [--org <id>]` | Session detail with workspace summary + author |
| `session messages <id> [options]` | Session messages with pagination: `--around <promptId>`, `--before <n>`, `--after <n>`, `--cursor <token>`, `--org <id>` |
| `conversation list [options]` | Chronological conversation listing. `--workspace <id>`, `--session <id>`, `--user <userId>`, `--since <range>`, `--until <iso>`, `--order asc\|desc` (default `desc`), `--cursor <token>`, `--org <id>` |

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
| `DEVSWARM_REPO_ID` | `a1b2c3d4-…` | Present ⇒ **inside DevSwarm** (the "am I in a workspace?" flag) |
| `DEVSWARM_SOURCE_BRANCH` | **`` (empty)** | **Parent's branch. Empty ⇒ root/Primary; non-empty ⇒ child.** The role signal |
| `DEVSWARM_DEFAULT_BRANCH` | `main` | Repo default branch |
| `DEVSWARM_AI_AGENT` | `claude` | Active agent (`claude`/`codex`/`gemini`/…) — selects the OMC vs OMX path |
| `DEVSWARM_BUILDER_ID` | `e5f6a7b8-…` | This workspace's DB row id |
| `DEVSWARM_BUILDER_NAME` | `main-a1b2c3d4` | Derived from branch+repo; use to isolate paths/volumes/db names across workspaces [11] |
| `DEVSWARM_NAME` | `Term:main-a1b2c3d4` | Terminal/workspace display name |
| `DEVSWARM_CLI_PORT` / `DEVSWARM_HTTP_PORT` | `<port>` | Local HTTP API port the CLI talks to |
| `DEVSWARM_SPAWNED` | `1` | **Process-tree bookkeeping — `1` even for Primary. NOT a hierarchy signal** (name is misleading) [P2] |
| `DEVSWARM_PARENT_PID` | `<pid>` | Electron parent **PID** (not a parent workspace) [P2] |
| `DEVSWARM_BUN_PATH`, `DEVSWARM_SHELL_READY_MARKER` | … | Runtime plumbing (bun binary, `🤖 Ready for AI` prompt marker) |
| `DEVSWARM_NO_AUTO_AUTH` | *(unset)* | **New in the v2.3.5 pass — read by the CLI script itself, not the Electron app**, so it's not part of the live shell fingerprint above (not observed in this Primary's env). Set it (any value other than `"false"`/`"0"`/empty) to stop `hivecontrol jira` from auto-launching an OAuth flow on an auth error. See §4.3 |

> **Not a real env var — ruled out during the v2.3.5 pass.** A `grep` for `DEVSWARM_[A-Z_]+`
> across the bundled `devswarm` script also matched `DEVSWARM_CLI_REFERENCE`, but that's a local
> JS `const` identifier (`var DEVSWARM_CLI_REFERENCE = \`hivecontrol workspace create ...\``,
> baked-in agent-guidance text), never read via `process.env` — checked directly in source. Not
> an environment variable; listed here only to record that it was checked and excluded.

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

> **Optional, feature-gated.** Everything in this section is dormant — zero behavioral
> change from anti-hall's non-DevSwarm baseline — unless `DEVSWARM_REPO_ID` is set (an
> active DevSwarm session) and/or one of the opt-in companions (the ingest daemon, the
> liveness supervisor) is installed. anti-hall's core (the verify-first protocol, the
> mechanical guards, the statusline, `doctor`, `update`, etc.) works fully without
> DevSwarm. See `README.md`'s "🐝 DevSwarm layered recovery" section for the enumerated
> feature list at a glance.

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
  do not repeat it. Non-destructive `message-count` is still never touched — **but as of
  v0.58, `message-parent`/`message-child` are NO LONGER untouched by this same
  redirect-family of guards; a separate, newer guard branch now blocks them too, see the
  new bullet below.** Own `devswarm-read-guard` skip name (in skip-guard's
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
- **`command-guard`'s native-SEND block, v0.58 "mesh-only messaging" (SHIPPED — REPLACE, not
  just redirect).** Where the destructive-read redirect above steers agents away from
  `monitor`/`read-messages` toward a durable-inbox READ path, this is the SEND-side
  counterpart: `hivecontrol workspace message-child` and `hivecontrol workspace
  message-parent` — the two native SEND subcommands — are now UNCONDITIONALLY blocked
  whenever DevSwarm is active, in ALL contexts (coordinator AND subagent — a delegated
  send writes the native queue identically). `detectHivectlMessageSend()`
  (`command-guard.js:232`) mirrors the destructive-read detector's own matching discipline
  byte-for-byte: quote-neutralized per-segment matching (so `grep 'hivecontrol workspace
  message-parent' docs/KB.md` never false-positives), command-position anchoring via
  `effectiveVerb==='hivecontrol'`, and `bash -c`/`eval`/`$()`/backtick unwrap+recursion (a
  smuggled `$(hivecontrol workspace message-child ...)` still matches). Matched via two
  dedicated regexes, `HIVECTL_MESSAGE_CHILD`/`HIVECTL_MESSAGE_PARENT` (`command-guard.js:148,150`),
  modeled exactly on `HIVECTL_MONITOR`/`HIVECTL_READ_MESSAGES` above. Deliberately does
  **not** match `message-count` (read-only counter) or any lifecycle verb
  (`create`/`list`/`check-merge`/`merge`) — those are unmatched by construction (disjoint
  literal text), so `devswarm.js spawn`/`merge` (thin wraps of those, see the v0.58 note in
  §8.7) keep working. Own skip name `devswarm-send-guard` (independent of both
  `devswarm-read-guard` and `command-guard`'s own skip — none of the three silences another),
  honors `DISABLE_ANTIHALL_DEVSWARM=1`. The block reason is a CLOSED-VOCABULARY string
  (`buildDevswarmSendReason()`, `command-guard.js:267` — never reflects the blocked command
  or stdin text, injection hygiene) that redirects to the mesh CLI: `node scripts/devswarm.js
  send --to-primary --message "<text>"` (or `--to <meshId>`) to direct-message, `node
  scripts/devswarm.js heartbeat <id> --summary "<text>"` to report status. **This is a
  REPLACE, not a parallel option:** anti-hall's shared mesh store (§8.7's v0.57 mesh, now
  extended by §8.7's v0.58 note below) becomes the SOLE agent-initiated messaging transport
  for DevSwarm coordination — native per-worktree messaging (no `from`/`to`/broadcast, no
  cross-worktree addressing) is superseded, not merely discouraged. Lifecycle verbs
  (`create`/`list`/`check-merge`/`merge`) are explicitly OUT of scope for this block — see
  §8.7's v0.58 note for what stays a thin pass-through wrap. Fires on both platforms:
  `command-guard.js` is the single shared file (§8.4), so a Codex Bash tool call hits the
  identical block (the DevSwarm-active gate, `hooks/lib/devswarm-detect.js`, keys off
  `DEVSWARM_REPO_ID`/`ANTIHALL_DEVSWARM_SUPERVISOR`, not the invoking agent) — **and, as of
  this port, the per-turn proactive reminder that keeps the mesh top-of-mind now fires
  identically too**: the hooks that inject it are registered, unmodified, in
  `codex/hooks/hooks.json` (corrected — see the v0.58 note's own Codex-parity section below,
  which previously claimed these hooks were Claude-only).
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
  it). **These three clauses are not exhaustive of "the parent has something waiting":**
  an escalation that landed in `orphans[]` (unread with no live registry row, e.g. because
  the Primary never self-registered from the true main worktree — see the v0.67.1 note
  above) matches NONE of them, so this gate does not block on it. Only the informational
  `devswarm-parent-inbox.js` surfaces `orphans[]`; a Primary can `Stop` unblocked here while
  that hook is displaying the very escalation this gate is meant to catch.
  **v0.61.1 real-unread fix:** the "unread backlog" clause above now counts only
  REAL unread — system-generated poke/mirror noise is excluded via the shared
  `companion/lib/devswarm-noise.js` `isNoiseText` classifier — closing a ghost-workspace
  feedback loop where a backlog consisting solely of the Primary's own `[Primary poke]`
  mirrored back nagged on every Stop. An unparseable row or unreadable inbox still counts
  as real (fail-open). Registration also now precreates an empty durable inbox (both the
  per-turn hook path and the CLI `register`/`ensure` path) so a freshly-registered child
  reads as known/empty rather than absent, closing a false-silence hole. Reads only files
  (the fs cursor + the supervisor's verdict file + the summary
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
descriptors), `cursors` (per-workspace consumed count — see **Per-instance cursors** below;
since v0.99.0 this shared value is a projection of the MIN across instances, not any one
reader's position), `gates` (per-workspace named boolean
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
  per unchanged blocking state, bounded by the per-window cap `MAX_BLOCKS = 2`
  (`devswarm-child-gate.js` lines 219–221, 87) AND (v0.97.0, defect a55d6b71a76f root cause B)
  a SEPARATE, never-resetting lifetime cap `MAX_BLOCKS_PER_SESSION = 6` — the per-window cap
  re-arms unconditionally every `RESET_MS`, so without the lifetime cap a child stuck in the
  SAME failing state could be blocked without limit over a long session; once the lifetime
  cap is reached the gate stops blocking for the rest of the session even after the window
  re-arms. There IS one controlled satisfaction path — the nonce/session-authenticated
  drop-attempt record described next — but it is bounded by the SAME never-resetting
  `MAX_BLOCKS_PER_SESSION=6` lifetime cap above, not a separate/unlimited silencing
  mechanism: an authenticated record only lets the gate treat THIS episode as reported, it
  never disables the gate. As of v0.97.0/v0.97.1 (Wave 3, v0.98.1, hardened further), a
  benignly-DROPPED `heartbeat --summary` (caller-identity/registration/ownership refusal)
  still counts as an attempted report instead of re-prescribing the same failing command:
  `cmdHeartbeat` appends a row to a PER-ID, per-repoKey bounded attempt file
  (`devswarmRoot/summary-attempts/<repoKey>/<writerId>.ndjson` — a separate file per writer
  id, not one shared file, so concurrent sibling writers can no longer race-drop each
  other's rows; append-only via `fs.appendFileSync`, trimmed via atomic tmp+rename only once
  a file exceeds 100 lines, down to the last 50) stamped with the writing process's own
  `instanceNonce` and a `sessionId` derived from the cwd-verified process-tree walk,
  with `CLAUDE_CODE_SESSION_ID` accepted only when the walk corroborates it (omitted
  otherwise) — NEVER the caller-supplied `--session` flag value, which is
  attacker-chosen and proves nothing about the writing process (a prior shape trusted the
  flag and was provably forgeable: `heartbeat <victim-id> --summary x --session
  <victim-sessionId>`). `findRecentDropAttempt()` in `devswarm-child-gate.js` scans every
  writer id's file under the repoKey's attempt directory and accepts a row ONLY when it
  authenticates as this workspace's own process/session family — `instanceNonce` matching
  this gate's own per-process nonce, OR `sessionId` matching a session id in this workspace's
  own identity family (its own registered descriptor, or — when that descriptor is absent —
  another descriptor provably the same identity via a uuid-prefix id relationship or a
  matching `canonicalMeshId` for the SAME physical worktree) — checked REGARDLESS of the
  row's own `id` field, which is what lets a legitimately twin-registered child (heartbeating
  under its meshId while its env id is a separately-unregistered UUID) satisfy the gate. An
  unauthenticated row (e.g. an unrelated sibling workspace's own, non-matching rows) does NOT
  satisfy. When a row exists for this exact id but authenticates against neither check (e.g. a
  genuine record from a PRIOR OS process — `deriveInstanceNonce`'s documented `self:<ppid>:0`
  fallback changes on every process restart), or when the gate's own nonce cannot be derived
  at all, the gate logs ONE stderr diagnostic per session (deduped via `state.mismatchLogged` /
  `state.nonceFailClosedLogged`) rather than silently re-blocking with no trail. The block text
  names the drop reason from a fixed whitelist (`DROP_REASON_LABEL`/`DROP_REMEDY`) only; an
  unrecognized or attacker-supplied reason string is never echoed raw.
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
  `computeLiveness()` invocations on the hot UserPromptSubmit path. **v0.70.1:** the
  ladder gained a `dormant` tier that sorts last, below even `active` — a mesh/registry
  row outlives its workspace (closing one in the DevSwarm app deletes nothing), and only
  heartbeat/verdict age reliably separated a live workspace from a closed one across
  measured cases, so a row whose newest known activity signal is at least
  `ANTIHALL_DEVSWARM_DORMANT_MS` old (default 30 min, ms) is labeled `dormant` instead.
  Demotes, never hides (a dormant row still renders with its unread count); never
  overrides `escalated`/`stale`/`archive-ready`; a heuristic threshold, not proof of
  closure. `roster` (`scripts/devswarm.js`) carries the identical hint.

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

**v0.57 mesh follow-up (SHIPPED in v0.58.0 — Claude-side only; Codex/OMX mesh support
DEFERRED to v0.57.1, owner decision O-D3 — do not describe the Codex port as
mesh-capable).** This work landed without its own `v0.57` git tag — it shipped folded
into the `v0.58.0` release (see `docs/KB.md`'s version row for the current `plugin.json`
version). Everything below replaces the pre-0.57 **per-worktree**
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

**v0.58 "mesh-only messaging" (SHIPPED in v0.58.0; see `docs/KB.md`'s version row for the
current `plugin.json` version).** Where v0.57 above ADDED the
mesh as a parallel, daemon-independent transport, v0.58 makes it the ONLY agent-initiated
transport for DevSwarm coordination — a **REPLACE**, not an additional option.

- **The REPLACE decision.** Native `hivecontrol workspace message-child`/`message-parent` —
  the two SEND subcommands — are now guard-blocked in ALL contexts (§8.5's new bullet
  above), redirecting every send to `scripts/devswarm.js`. Every OTHER hivecontrol feature
  this integration relies on — `create`/`list`/`check-merge`/`merge` (the lifecycle verbs)
  — is KEPT, unblocked, and now additionally available as a THIN wrap through the CLI (see
  `spawn`/`merge` below) rather than re-implemented. The rationale (PLAN.md's "Locked
  design," this session's build record): native per-worktree messaging has no `from`/`to`
  fields and no broadcast — it cannot address a specific sibling, only a parent/child pair
  — while the mesh store already had all of that from v0.57. Rather than maintain two
  competing send paths indefinitely, v0.58 collapses to one.
- **New/changed CLI verbs (`scripts/devswarm.js`, agent-agnostic — see the Codex-parity
  note below for what does and doesn't apply to a Codex session).**
  - `send --to-primary --message TEXT [--urgency ...]` — a third target mode alongside the
    existing `--to <meshId>`/`--broadcast` (mutually exclusive; `cmdSend`, `devswarm.js:1025`).
    Resolves the registry entry whose `worktreePath` exactly matches THIS project's main
    worktree (`resolvePrimaryTarget`, `devswarm.js:1009`, using
    `install-devswarm-ingest.js`'s `resolveMainWorktree`) — fail-closed
    (`reason:'primary-unregistered'`) when no Primary is registered yet, never a silent
    black-hole, same posture as `--to`'s own fail-closed `unregistered-recipient`.
  - `reconcile` (`cmdReconcile`, `devswarm.js:1299`) — for every registry descriptor of
    THIS project that carries a `worktreePath`, spawns `node scripts/devswarm.js inbox pull
    <id>` as a SEPARATE SUBPROCESS with `cwd` set to that worktree
    (`defaultSpawnReconcile`, `devswarm.js:1276`) — never in-process, since `inbox pull`'s
    own native spawn resolves its target workspace from the CALLING process's cwd, so an
    in-process call from the reconciler's own cwd would drain the wrong (the reconciler's
    own) queue for every descriptor instead of each worktree's own. The existing per-id
    `O_EXCL` pull lock (`devswarm-pull.js`) serializes a sweep against a live child
    concurrently pulling its own inbox — surfaced as `locked:true` on that descriptor's
    result, never silently dropped from the count. One-shot drain of every stranded
    worktree queue, not a daemon.
  - `spawn <branch> [hivecontrol create flags...]` (`cmdSpawn`, `devswarm.js:1362`) — a
    THIN pass-through wrap of `hivecontrol workspace create <branch> ...`: the raw argv
    tail forwards byte-for-byte (this file's own `--long`-flag parser is deliberately
    bypassed for this verb, so a short flag like `-p` or a future hivecontrol flag is never
    swallowed or re-parsed), then best-effort auto-registers the new worktree in the
    project's shared store registry (store-only — no descriptor file, no `sessionId` yet;
    the child's own first `inbox pull`/`heartbeat`/`register` fills that in itself, same as
    every other child). A create failure returns as-is; a registration failure AFTER an
    already-successful create never rolls back or fails the verb.
  - `merge [hivecontrol merge-into-source flags...]` (`cmdMergeVerb`, `devswarm.js:1415`) —
    a THIN wrap of `hivecontrol workspace check-merge` (informational, always run first) +
    `hivecontrol workspace merge-into-source ...` (pass-through — never re-parses or gates
    on check-merge's own verdict), then `send --broadcast`s the outcome to the mesh so
    every peer sees a merge land without polling (best-effort — a broadcast failure never
    masks the merge's own result). The OTHER merge direction, `merge-from-source`, is
    untouched — still a raw hivecontrol call.
  - `roster` fold (`cmdRoster`, `devswarm.js:1187`, `fetchNativeChildren`,
    `devswarm.js:1165`) — plain `roster` (never `--ack`) now additionally unions a
    READ-ONLY, bounded (5 s timeout) `hivecontrol workspace list children` view into the
    projection, so a child hivecontrol spawned but that has never yet self-registered with
    the store (no `inbox pull`/`heartbeat`/`register` call yet) still shows up
    (`source:'native'` on that entry) instead of being invisible. Never written back to the
    store — the store registry stays the single write-owned source of truth; fail-open
    empty array on any spawn/parse error.
  - `archive-request <childId> [--reason TEXT]` (`cmdArchiveRequest`, `devswarm.js:937`) —
    **REVISED from a send-only hivecontrol call to a direct STORE WRITE.** Pre-v0.58 this
    resolved a child BRANCH (via `--child-branch`, a descriptor field, or a `hivecontrol
    workspace list children` lookup) and posted through `message-child <branch> <msg>` —
    the one native-messaging leak the command-guard's verb-anchored matching could never
    catch (a spawned `message-child` call is invisible to a guard classifying only the
    Bash tool-call text). v0.58 deletes that lookup + spawn entirely: `id` is already the
    target's real read partition (the SAME semantics `heartbeat <id>`/`inbox read <id>`
    already use), so the marker (`[[ANTIHALL_ARCHIVE_REQUEST]]`, now the canonical
    `store.ARCHIVE_REQUEST_MARKER`, `devswarm-store.js:183`) is appended straight into
    `id`'s own partition with `urgency:'high'` — zero `hivecontrol` calls, verified by a
    dedicated e2e test that injects a runner throwing on ANY hivecontrol call
    (`tests/e2e/devswarm-archive.e2e.test.js`). `--child-branch` is gone (no longer
    needed — there is no branch resolution left to do).
  - Uniform message record schema across `send`/`archive-request`/the `merge` broadcast/the
    `heartbeat --summary` broadcast: `{from, to, type:'direct'|'broadcast', message,
    timestamp, urgency}` (plus the store's own derived `hash`/`isHeartbeat`).
- **Per-turn override + wake Tier 0 (mesh-poll resting posture).** DevSwarm's own child
  spawn uses `--system-prompt-file`, which REPLACES the system prompt — the only lever
  against that erasure is re-injecting a directive on every subsequent turn, not just at
  spawn. `hooks/devswarm-child-role.js` (SessionStart, BOTH roles as of v0.58 — previously
  child-only) injects the full `OVERRIDE_CORE` directive (`devswarm-child-role.js:35`):
  anti-hall's mesh is the workspace's ONLY messaging channel, native `message-*` sends are
  blocked, report via `heartbeat <id> --summary`, direct-message via `send --to-primary`/
  `--to <meshId>`, check in via `roster`/`mesh read`/`inbox read-primary <id>`, and RESTING
  state = keep polling the mesh rather than idling silently (this IS the Tier-0 wake
  posture — it replaces the native `monitor` resting state the guard now blocks). A child
  additionally gets `CHILD_IDLE_LINE` (`devswarm-child-role.js:48`), the self-report nudge
  this hook already carried, now phrased via `heartbeat --summary` instead of the blocked
  native call. Every subsequent turn, a terse (≤160-char) `OVERRIDE_REASSERT` re-injects
  the same core directive: `hooks/devswarm-child-turn.js:101` (child, UserPromptSubmit,
  unconditional, prepended ahead of the existing `REMINDER`/`RECEIVE_NUDGE` segments) and
  `hooks/devswarm-parent-inbox.js:113` (Primary, UserPromptSubmit — this is the ONE
  deliberate departure from that hook's prior "empty stdout when nothing to report"
  zero-cost contract, a small fixed per-turn cost traded for resistance to model
  habituation/drift back toward native messaging across many quiet turns). All four
  strings deliberately avoid the literal substrings `message-child`/`message-parent` (using
  a `message-*` wildcard form instead) so the hook text itself never re-introduces the
  blocked native verbs into emitted output — a dedicated fixture asserts no emitted hook
  text contains either literal.
- **Honest wake-mechanism caveat (do not overclaim).** The "RESTING state = keep polling
  the mesh" posture above is the entire Tier-0 wake mechanism this release ships — it
  relies on the session actually taking another turn. This build's own design record
  (`PLAN.md`) states plainly, citing GitHub `anthropics/claude-code#44380`, that **no
  external mechanism wakes a genuinely idle Claude Code session** — there is no push, no
  MCP notification, nothing that can interrupt a session sitting between turns with no new
  prompt. A Tier-2 fallback (wrapping the session's own runner process + injecting into its
  stdin to force a new turn) is explicitly named in the design record as a DEFERRED,
  NOT-BUILT fallback for if this resting-poll latency proves insufficient in practice — do
  not describe it as shipped. What v0.58 actually ships is: the mesh directive keeps a
  session that IS taking turns checking in every turn, and the supervisor's escalate-on-
  urgent path below is the mechanism for a session that has gone genuinely stale.
- **v0.59.0 UPDATE — the Tier-2-shaped gap above is now partially closed, by a different
  mechanism than the deferred runner-wrap.** `CronCreate` (a Claude Code tool whose jobs
  fire while the REPL is IDLE) lets a Claude workspace schedule its own recurring
  mailbox-drain — see `hooks/lib/devswarm-wake.js` and §11. This is still not the
  runner-wrap/stdin-injection fallback named DEFERRED above (that remains unbuilt), and it
  is still Claude-only (Codex has no `CronCreate` tool, so it still relies purely on the
  resting-poll posture); but for a Claude workspace it directly answers "nothing wakes a
  genuinely idle session" — a scheduled cron tick now does. Treat the caveat above as
  historically accurate for what v0.58 shipped, not as anti-hall's current state.
- **Supervisor escalate-on-urgent (Tier 0, additive — `companion/devswarm-supervisor.js`,
  NEVER kills).** `readMeshUrgency()` (`devswarm-supervisor.js:116`) resolves a stale
  descriptor's project `repoKey` and reads that project's `summaries/<repoKey>.json` (the
  same projection the hooks read) for THIS descriptor's own `urgencyMax`/`directUnread`/
  `broadcastUnread` row; `isUrgentMesh()` (`devswarm-supervisor.js:138`) qualifies only
  `high`/`urgent` (via `URGENT_TIERS`, `devswarm-supervisor.js:102` — `low`/`normal`/absent
  do not force anything, relying instead on the agent's own next turn). When a sweep tick
  finds a stale descriptor with an urgent/high unread, it fires `notifyParentEscalation`
  (the SAME channel `pokeOrEscalate` itself uses, same store-level hash dedupe) IMMEDIATELY
  — independent of, and even when, the base `pokeOrEscalate` call on that same tick only
  nudged (poke budget not yet exhausted). Fail-open throughout (unresolvable repoKey,
  missing/malformed summary, descriptor absent from the summary all return `null` = "no
  urgent signal," never throwing out of a sweep tick). This is purely additive to the
  existing poke/escalate cadence (§8.7's Layer 2/3) — it NEVER resolves a pid and NEVER
  kills; the on-demand `devswarm-recover.js` CLI remains the only path in this system that
  ever does.
- **v0.67.1 — this path never delivered end-to-end until now.** Four stacked defects, any
  one of which alone silently swallowed the escalation: a missing `deriveSummary` call
  after the append left the parent-facing projection stale; `openStore` was called without
  a hash and wrote to a legacy bucket instead of the repoKey store; `parentId` was derived
  from the CHILD's own worktree path (rather than resolved via `resolveMainWorktree` before
  `primaryWorkspaceId`), so escalations landed in the child's own bucket; and two
  fold/rehome paths skipped their projection refresh entirely on specific branches. All four
  are now fixed. **Remaining precondition, NOT fixed by this release:** delivery still
  requires the Primary to have self-registered from the true main worktree — otherwise the
  escalation lands in `orphans[]` (see `computeSummary`'s A2 orphan detection in
  `companion/lib/devswarm-store.js`), not the workspace's own row, and `devswarm-parent-gate.js`
  does not check `orphans[]` (only `devswarm-parent-inbox.js` does) — see the parent-gate
  note below.
- **Daemon — unchanged.** `devswarm-ingest.js` (the one supervised native-`monitor`
  consumer) and its per-project install/health-check machinery from v0.57 are untouched by
  v0.58 — the daemon still exists purely to drain the Primary's OWN reception queue
  (parent-directed native messages arriving from outside anti-hall's own send path); it was
  never a messaging-fanout mechanism the mesh-only decision needed to touch.
- **NO MCP — the CLI-over-MCP rationale, restated for this decision specifically.** v0.58
  considered and explicitly rejected building an MCP server / a daemon-held push mechanism
  for delivery, per PLAN.md's own "DO NOT BUILD" list. This is the SAME owner-preference
  rationale already on record for the rest of this CLI (§8.7: "THE structured interface —
  CLI over MCP, owner preference"): a stable-JSON stdout CLI is invokable identically by
  either agent (Claude tool-call Bash, or Codex), needs no separate server process, no
  protocol negotiation, and no additional attack surface — while an MCP server would add
  exactly those without solving the actual gap (the wake problem above is a Claude Code
  runtime limitation, not something an MCP tool surface changes; per the honest caveat
  above, nothing — MCP included — currently wakes a truly idle session).
- **Codex parity — corrected: the five mechanical hooks ARE now shared, not Claude-only.**
  `command-guard.js` is the single shared hook file (§8.4) registered in BOTH
  `hooks.json`/`codex/hooks/hooks.json` — so the native-SEND guard-block above (§8.5's new
  bullet) fires identically for a Codex session's Bash tool calls; the DevSwarm-active gate
  it depends on (`hooks/lib/devswarm-detect.js`) keys off `DEVSWARM_REPO_ID`, which
  hivecontrol sets per-workspace regardless of which agent runs there, not a Claude-specific
  signal. The block's own reason string (`buildDevswarmSendReason`) already redirects to
  the mesh CLI verbs, so a Codex agent that attempts a native send is redirected reactively,
  at the moment of the attempt.
  **CORRECTION (this port):** an earlier version of this section claimed the five mechanical
  override/reassert hooks (`devswarm-child-role.js` SessionStart, `devswarm-child-turn.js`/
  `devswarm-parent-inbox.js` UserPromptSubmit, `devswarm-parent-gate.js`/
  `devswarm-child-gate.js` Stop, incl. the `alreadyReportedThisEpisode` addition) were
  **Claude-only**, reasoning that their gating `DEVSWARM_*` env vars were set only for
  `claude` child sessions. That reasoning directly contradicted this SAME section's own
  preceding paragraph (`DEVSWARM_REPO_ID` is agent-agnostic, not a Claude-specific signal) —
  it was an unverified, propagated assumption, not a re-derived fact. All five hooks are
  registered, unmodified, in `codex/hooks/hooks.json` as of this writing: `SessionStart` now
  also carries `devswarm-child-role.js`; `UserPromptSubmit` now also carries
  `devswarm-parent-inbox.js`/`devswarm-child-turn.js`; `Stop` now also carries
  `devswarm-parent-gate.js`/`devswarm-child-gate.js` — alongside the pre-existing
  `verify-first-full`/`graphify-session`/`version-alert`/`codex-availability`/`verify-first`/
  `task-tracker`/`limit-conserve-inject`/`git-guard`/`command-guard`/`graphify-guard`/
  `merge-gate`/`task-guard`/`tasklist-guard`/`graphify-reminder`/`speculation-guard`/
  `speculation-judge`. Net effect: a Codex session in an active DevSwarm workspace is
  mechanically prevented from sending a native message (guard-blocked, reactive redirect on
  attempt) AND now gets the SAME proactive per-turn "use the mesh" reminder a Claude session
  gets. What remains genuinely Claude-only: the liveness supervisor and its mesh-urgency
  escalation (it identity-binds to `claude --resume` processes specifically — a structural
  fact about the supervisor's own target-matching, unrelated to env-var availability) and
  the on-demand `devswarm-recover.js` CLI's target (a Codex operator can still run the
  script, but only against a `claude` workspace). The CLI verbs themselves (`send`/`roster`/
  `mesh read`/`reconcile`/`spawn`/`merge`/`archive-request`) remain plain Node scripts with
  no agent affinity — a Codex agent CAN invoke them directly via Bash, same as the pre-v0.58
  CLI (`inbox pull`, `archive-request`'s old form) already was documented as agent-agnostic.
- **Child-gate "already-reported" satisfaction (builds the v0.54.2 TODO this KB's §8.7
  noted as "not yet built").** `hooks/devswarm-child-gate.js`'s `alreadyReportedThisEpisode()`
  (`devswarm-child-gate.js:120`) reads the SAME `summaries/<repoKey>.json` projection
  (no store DB open — hooks never open the DB) for a `recent[]` row this child itself SENT
  (`from === DEVSWARM_BUILDER_ID`, timestamped at or after the current stop episode's start)
  — a REAL mesh `heartbeat --summary`/`send --broadcast` call, never the mechanical
  turn-start heartbeat FILE (which the v0.54.1 correction in §8.7 already ruled out as a
  false-silence signal, since it never touches the store). When satisfied AND no KNOWN
  durable unread backlog is pending (the inbound half of this gate, #29, is unaffected —
  this satisfaction path only silences the OUTBOUND forcing), the Stop block is skipped
  entirely for that stop episode. Fail-open: any error (unresolvable repoKey, missing/
  corrupt summary, unsafe id) returns `false`, never silently skipping a required report.
- **`deriveSummary` `archive_requested` (additive, `devswarm-store.js:982`).** `true` when
  an unread DIRECT row addressed to a workspace carries the archive-request marker,
  scanned over the already-fetched unread rows (zero extra store reads), restricted to
  `mtype==='direct'` so a native-drained row (`inbox pull`, `mtype` null) can never
  false-positive even if its body happens to contain the literal marker text.
  `hooks/devswarm-child-turn.js` reads this flag defensively (undefined on an older
  store/summary shape is falsy — pure no-op until this field exists) and surfaces the SAME
  archive-request segment the pre-existing NDJSON-marker scan already produced, deduped so
  a turn with both signals present never double-pushes the segment.

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

### 8.7.3 Blocking questions — CHILD/PARENT protocol (documentation convention, NOT mechanically
enforced)

**Status, stated plainly (unlike most of §8.7, nothing below is code-enforced or hook-injected
— it is a written skill convention only).** The shipped mesh (§8.7's v0.57/v0.58 substrate)
gives a child a channel to reach its parent; it never said what a child should DO the moment it
hits a decision it cannot make alone. Left unaddressed that produces exactly the failure mode
async delegation exists to avoid: a spawned child asks a blocking question and stops working
entirely, and if several children do this at once, all progress serializes through a human —
defeating the point of the workspace tier (§8.1). This is a real owner-reported gap, not a
hypothetical.

The protocol lives in full, per-role, in both skill files (kept in parity):
`plugins/anti-hall/skills/devswarm/SKILL.md`'s "Blocking questions — CHILD asks, PARENT
answers" section and its Codex mirror,
`plugins/anti-hall/codex/skills/anti-hall-devswarm/SKILL.md`. Summary:

- **CHILD:** never ask the human directly and never halt all work — a question parks ONE
  sub-task, not the workspace. Send it via `send --to-primary --urgency high --message "<...>"`
  with five required parts (what's blocked / options considered / recommendation / the default
  to take if unanswered / the deadline), keep working every other unblocked item, and
  **DEFAULT-AND-PROCEED** if no reply lands by the stated deadline — taking the named default,
  proceeding, and flagging it LOUDLY as an explicit assumption in the final report. The one
  exception: a destructive/irreversible action the child isn't authorized to take (delete data,
  force-push, kill a process, a production write) is parked and reported (`--urgency urgent`)
  but never defaulted — it waits for an explicit answer.
- **PARENT:** keep a mailbox-wake running (`inbox read-primary <id>` on a schedule, reinforced
  by the existing per-turn mesh reminder — §8.7's v0.58 note) so a child question doesn't sit
  unseen; an unanswered child question is a PARENT failure, not a child stall. Answer decisively
  from the plan/intent context already held. Escalate to the human ONLY for a genuine human call
  (destructive/irreversible action, product/scope decision, or an assumption unsafe to make).
  **The escalation ladder is child → parent → human, never child → human.** Reply on the mesh
  directly to the asking child (`send --to <meshId>`), not a broadcast.

This reuses only already-shipped, already-documented CLI verbs (`send --to-primary`, `send
--to <meshId>`, `inbox read-primary` — all in the CLI table at §8.8) — no new subcommand, no
new guard, no new hook. It is a **behavioral convention an agent is told to follow**, the same
category as the KB's own "How to READ mesh health" guidance elsewhere in this document —
distinct from the mechanically-enforced guard branches (command-guard's native-SEND block,
the Stop-side child gate, etc.) documented throughout the rest of §8.7. Nothing currently
mechanically verifies a child actually included all five required parts of a blocking-question
message, or that a parent actually replied before a child's stated deadline — that enforcement
gap is honest and open, not silently assumed closed.

---


### Per-instance cursors, the baseline, and the cursor write journal (v0.99.0, defect 8b211241bbe9)

**The defect.** `cursors/<id>.json` and the store's cursor row are keyed by row id ALONE, so
every process reading under that id shared ONE read position. Whichever instance acked first
consumed the mail for all of them: a second instance's `read-primary` returned 0 while the
cursor had already advanced past rows it was never shown. Twin rows (a meshId row and its uuid
twin) make this routine rather than exotic.

**The model.** Each INSTANCE — one OS process identity, `deriveInstanceNonce`, stable across
every CLI invocation from one harness session, so a main-thread turn, a cron turn and a Monitor
turn are all the SAME instance — keeps its own cursor:

| File | Written by | Meaning |
|---|---|---|
| `cursors/<id>#inst-<short6>.json` | that instance's own read/ack | how far THIS instance has consumed |
| `cursors/<id>#base.json` | fold, reap-orphans, and a one-time seed | the LOSS-FREE watermark: rows reachable elsewhere |
| `cursors/<id>.json` + the store cursor row | raised on every ack | a running MAX of the min across instances (monotonic: `ackTo` never rewinds it) |
| `cursors/<id>#nd-<short6>.json` | that instance's own `inbox read/ack` | how far THIS instance has consumed the descriptor's NDJSON inbox |

A reader's window is `max(baseline, own instance cursor)`. Deliberately NOT floored by other
instances' positions — a peer's ack must never move this reader forward, which is the defect.
The shared pair is raised only as far as the MIN allows, so every legacy consumer of that value
(the unread projection, `workspaces list`, the gate) stays loss-free without being rewritten onto
a new base. It is a running MAX of that min, not a live projection of it: `ackTo` is monotonic, so
the shared value never rewinds when a new, further-behind instance appears.

**The NDJSON side is per-instance too.** The descriptor's own cursor (`cursorPath`, what
`inbox read/ack/count` consume) is ONE file per workspace, so two instances shared it and
instance A's `inbox ack` hid mail from instance B — the design's claim that `inbox ack` is
"descriptor-scoped, no cross-instance hazard" was FALSE, proven by repro. Each instance now
keeps `cursors/<id>#nd-<short6>.json`, and the descriptor's cursor becomes the same min-projection
so `unreadBacklog`, the parent gate's clear path and doctor's listener check all keep reading a
conservative value.

**No liveness oracle is used, and none is available.** `inbox tick` refreshes only the heartbeat
FILE, so a reader that ticks without broadcasting ages out of any outbound-row liveness test.
Every rule here is decided from file state alone.

**Why the baseline is a separate file.** The min across readers and the loss-free watermark are
two different facts. An instance that has never read must start from the watermark, not from a
peer's position — starting from the min is the original defect wearing a different hat.

**Worktree-scoped SELF.** `siblingAckGate`'s SELF short-circuit compares only ids and sessionIds
(`crossLinkedIdentity`), with no location component, so a caller standing in the parent's
worktree while holding a child's meshId acked the child's twin partition. SELF now also requires
the caller's cwd to resolve to the partition row's own worktree, failing OPEN when the row
carries no worktree path. `--ack-as-owner` remains exempt.

**The journal.** `cursor-log/<repoKey>.ndjson`, append-only, capped at 2000 records with
tail-preserving rotation into `.1`. Each record carries `ts, id, partition, callerId, ns, from,
to, delivered, pid, nonce, gate, verb, cwd, ok`. Two signatures name a cursor eater on sight:
`callerId !== partition`, and an advance with `delivered:0`. Broadcast cursors, the migrate-time
cursor merge, and `.seen-` watermark writes are deliberately NOT journaled — their absence is by
design, not a gap. Read it with `readCursorLog(home, repoKey, n)`; `diagnose` surfaces the newest records per id as `cursorWrites` (bounded), and doctor reports the hygiene pass.

**UPGRADING A LIVE FLEET (0.98.x -> 0.99.0).** Upgrade every session promptly. During a mixed
window an OLD-version ack still writes the shared pair to its OWN position, with no
min-projection. That is safe for a DECLARED 0.99 instance: it reads from its own cursor and the
baseline never re-adopts the shared value, so it loses nothing (verified against the real shipped
0.98.3 build — the old build received all 3 messages and a declared 0.99 instance then received
all 3 too). The one exposed case is an UNDECLARED newcomer: an instance that first appears after
the old build consumed mail starts at the floor and will not see those rows. Since `ensure` runs
every turn via `inbox pull`, a session declares itself on its first turn — so keep the window
short and let each session take a turn. For the same reason the migrate-time cursor merge raises
the baseline only as far as the DECLARED floor: migrate copies rows between backends and makes
nothing reachable for a 0.99 instance, so an unbounded raise there would consume a live
instance's mail. Only fold and reap-orphans may raise past the floor, because they forward or
archive the rows first.

**Hygiene.** A stale instance file (mtime past `DEFAULT_INSTANCE_CURSOR_STALE_MS`, 7 days) is
removed when doing so does not advance the floor past another instance, and EVICTED with a journaled
`gc-evict` record when it does. In the SOLE-file case deletion drops that id back to its baseline,
so the next read replays everything since the baseline — redelivery, never loss, and journaled. A FRESH file is never a candidate: it is a live reader's position. Without the
eviction a dead instance would pin the shared cursor forever; with it, the bounded cost is a
session resumed after 7 days missing what its peers consumed, and that cost is always
attributable from the journal. The separator is `#`, which `isSafeId` forbids, so no workspace id can ever produce one of these
filenames; the parser additionally requires a six-hex nonce. Both namespaces are swept. Shipped in BOTH `update.js` (one-time per
version) and doctor (report-only unless repairing).

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
| `register-primary [--worktree P] [--session S] [--inbox NDJSON] [--cursor P] [--force]` | Register the CURRENT worktree's Primary/parent descriptor under its PER-WORKTREE id `primary-<worktreeHash>` (§8.7's per-project identity — never the old collision-prone hardcoded `'primary'`). `--worktree` defaults to `git rev-parse --show-toplevel` of cwd; `--session` defaults to `CLAUDE_CODE_SESSION_ID` env (the real Claude Code session id, when set — Task #10, closes the "Primary rows never resolve a transcript" gap), then `DEVSWARM_BUILDER_ID` env, then the derived id; `--cursor` defaults to `cursors/<id>.json` (the durable ACK cursor `inbox messages --ack`/`read-primary` advance — a SEPARATE cursor namespace from a child's own descriptor `cursorPath`); `--inbox` optionally points `migrate` at a legacy NDJSON source to fold into this partition. **LIVE SIBLING PRIMARY GUARD (defect 7d0a948031cd):** ONE Primary per project — a second `register-primary` for this same worktree from a DIFFERENT, currently-live session is refused (`ok:false, reason:'live-primary-conflict'`, exit code 2) rather than silently overwriting the existing row's `sessionId`; pass `--force` to register anyway. Never refused for a same-session restart (re-registering with the same `sessionId` is always a plain upsert), and never refused when the existing row's session is not provably live (`isRoutingLiveRowStrict` finds nothing live, or any probe error — fail-open toward the pre-fix upsert). | `cmdRegisterPrimary` L476–493, dispatch L752–755 |
| `heartbeat <id> [--progress N] [--phase X] [--wip T]... [--blockers T]... [--session S]` | Write a turn-authored heartbeat (`heartbeats/<id>.json`). Only asserts fields the caller actually supplied — NEVER fabricates `progress`/`phase`/`wip`/`blockers` (absent input = `null`/`[]` on write, not a guess). Consumer/session-invoked ONLY — the heartbeat-authorship rule (§8.7) forbids a background ticker ever writing one. | `cmdHeartbeat` L296–325, dispatch L702–706 |
| `inbox pull <id> [--session S]` | CHILD-side reception drain. Auto-`ensure`s the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate FIRST (count `0` → returns without ever calling `read-messages`); on count `>0`, exactly ONE bounded `read-messages` (10 s finite timeout, never the blocking `monitor`); appends the batch to the durable inbox NDJSON in one atomic write, idempotent by content hash; feeds the store-parity projection with the same hash. | `cmdInboxPull` L335–362 → `companion/lib/devswarm-pull.js` `pullOnce` L177–290 |
| `inbox read <id>` | CHILD-side cursor read: the unread slice of the durable inbox NDJSON past the descriptor's own `cursorPath`. Requires an existing descriptor with `inboxPath` (`register`/`ensure`/`inbox pull` all create one). | `cmdInbox` 'read' branch L450–453 |
| `inbox count <id>` | CHILD-side non-destructive unread COUNT only (no message bodies) against the descriptor's inbox. | `cmdInbox` 'count' branch L446–449 |
| `inbox ack <id> [--to N]` | Advance the descriptor's durable cursor. No `--to` = ack-all (cursor := current total); `--to N` sets an absolute count, clamped to `[0, total]` so an over-ack can never swallow messages that arrive later. This is the parent-gate's non-skip CLEAR path. CHILD-side only (operates on the descriptor's own `cursorPath`) — no `callerIdentity` check here, since a descriptor-scoped cursor has no cross-workspace hazard; that hazard lives in `inbox messages --ack`/`read-primary` below, which is store-scoped and keyed by an arbitrary `<id>`. | `cmdInbox` 'ack' branch L454–466 |
| `inbox messages <id> [--unread] [--ack] [--ack-as-owner] [--json]` | **Primary/store non-destructive READ path.** Reads message BODIES directly from the store (`store.listMessages`) — never touches the native queue, needs NO descriptor (rows are keyed by workspace id regardless of registration, so it works even for an id nothing ever `register`ed). `--unread` returns only messages past the durable ACK cursor at `cursors/<id>.json` (note: this is a DIFFERENT cursor file/namespace than a child descriptor's own `cursorPath` used by `inbox read`/`ack`). `--ack` additionally advances that cursor to the current total in the same call (equivalent to `read-primary`) — **ack-ownership guard (v0.56.0, P0-hardened):** before ANY `--ack`, `cmdInboxMessages` calls `callerIdentity(env, cwd)` and refuses (`ok:false`, cursor left untouched) unless the caller's own identity equals `<id>`, UNLESS `--ack-as-owner` is passed explicitly to override for a legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's backlog on its behalf). `callerIdentity` treats **cwd as ground truth**: when cwd resolves to a real git worktree, identity is derived from that worktree and a `DEVSWARM_BUILDER_ID` env var naming a *different* workspace is IGNORED — never trusted to override — closing the env-spoof path where a workspace could set `DEVSWARM_BUILDER_ID=<other-id>` to impersonate another workspace and ack its cursor. `DEVSWARM_BUILDER_ID` is honored as a declared identity only when it can't contradict cwd (cwd already agrees, or cwd resolves to no worktree at all). `--json` is accepted for CLI-invocation parity and is otherwise a no-op — output is always JSON regardless. | `cmdInboxMessages` L393–433, `callerIdentity` L124–139, dispatch via `cmdInbox` L438 |
| `inbox read-primary <id> [--ack-as-owner]` | Sugar for `inbox messages <id> --unread --ack` under one name — "read what's unread, then advance the ACK cursor," the Primary's one-shot ergonomic. Subject to the SAME ack-ownership guard as `inbox messages --ack` above (it sets `{ack:true}` internally, so `callerIdentity` is checked identically; `--ack-as-owner` overrides identically). | `cmdInboxMessages(..., {ack:true})` L393–433, dispatch L439 |
| `wake-directive <id>` | On-demand REPRINT of the full SessionStart idle-wake directive (`lib/devswarm-wake.js`'s `wakeDirective`) for `<id>`, with the generic `<DEVSWARM_BUILDER_ID>` placeholder substituted for the concrete id — copy-runnable as-is. This is the command the trimmed Stop-gate `MAILBOX WAKE CHECK` re-verify text (`wakeReassert`, fixed text ≤ 360 chars plus one embedded CLI path) points at when it names something as missing; the Stop gate no longer re-issues `CronCreate` itself, it sends the agent back here for the full CronList/CronCreate + Monitor-arm prompt. Returns `{ok, id, isChild, agent, directive}` — `directive` is `''` (never an error) for an unknown/absent `DEVSWARM_AI_AGENT`, matching `wakeDirective`'s own fail-open contract. | `cmdWakeDirective` L11211–11225, dispatch L13477 |
| `workspaces list` | Derive + emit the `summary.json` projection: `{requiredGates, count, workspaces: {...}}`, one entry per registered workspace with `total`/`cursor`/`unread`/`gates`/`archive_ready`. | `cmdWorkspacesList` L495–514, dispatch L714–718 |
| `gate <id> --set CSV --clear CSV [--by NAME]` | Mark/unmark named completion gates (append-only in the store — a set/clear appends a new timestamped row; current value = latest row per name). anti-hall is agnostic about what any gate MEANS — the consumer defines and sets them (default required set for `archive_ready`: `done,merged,tests_passed`, override via `ANTIHALL_DEVSWARM_REQUIRED_GATES`). `--by` names the setter (default `devswarm-cli`). | `cmdGate` L516–538, dispatch L719–724 |
| `nudge <id>` | Poke-or-escalate one workspace ON DEMAND, honoring the same persisted attempt-count/cooldown state the automatic supervisor sweep would (reuses `recovery.pokeOrEscalate` — the identical primitive, not a re-implementation). | `cmdNudge` L540–550, dispatch L725–730 |
| `archive <id>` | Archive-by-absence on anti-hall's OWN registry ONLY: moves the descriptor into `archived/` (renames — never unlinks) and tombstones the store registry entry. hivecontrol itself has NO teardown/delete/archive command at any level (§4/§10), so this SURFACES a manual "remove workspace X in the DevSwarm app" step in its response — it never runs an actual delete. | `cmdArchive` L552–575, dispatch L731–735 |
| `archive-ignore <id>` / `archive-unignore <id>` | Write / remove a per-workspace `archive-ignore/<id>.json` mute of the `devswarm-parent-inbox` archive-ready reminder. | `cmdArchiveIgnore` L577–592, dispatch L736–745 |
| `archive-request <childId> [--reason TEXT]` | **PARENT-side (REVISED v0.58: STORE WRITE, not a hivecontrol call).** Posts a `[[ANTIHALL_ARCHIVE_REQUEST]]`-prefixed message directly into `<childId>`'s OWN store partition (mesh-direct, `urgency:'high'`) — `childId` is already the target's real read partition, so no branch resolution or registry lookup happens (the old `--child-branch` flag and the `hivecontrol workspace list children` lookup are GONE). ZERO `hivecontrol` calls — closes the one native-messaging leak the command-guard's Bash-text matcher could never see. NEVER verifies merged/tested/deployed itself (that's the parent repo's own policy). | `cmdArchiveRequest` `devswarm.js:937`, `ARCHIVE_REQUEST_MARKER`/`buildArchiveRequestMessage` `devswarm-store.js:183`/`devswarm.js`, dispatch `devswarm.js:1531` |
| `migrate` | Auto-migrate on-disk state (the JSON descriptor registry + each descriptor's legacy NDJSON inbox/cursor) into the store. Idempotent (dedupe hash from id + line-index + content), NON-DESTRUCTIVE (reads sources only, never deletes/moves/truncates), single-consumer-locked (O_EXCL), and COUNT-VERIFIED (store count must equal distinct legacy lines) before it reports `verified:true`. As of v0.57 this ALSO folds in the non-destructive hash→repoKey mesh migration (§8.7's v0.57 note) inside the SAME migrate lock. Picks up `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ` from `ctx.env` (no dedicated `--mark-read` CLI flag on THIS subcommand — that flag lives on the separate `scripts/migrate-state.js` script, §8.7's v0.56.0 note). | `cmdMigrate` L921–968 → `companion/devswarm-migrate.js`, dispatch L1182–1184 |
| `send --to <meshId-or-id>\|--to-primary\|--broadcast --message TEXT [--from <id>] [--urgency low\|normal\|high\|urgent] [--question] [--answers]` | **v0.57 MESH, `--to-primary` added v0.58 (SHIPPED — Claude-side; see the v0.58 note's Codex-parity caveat for what a Codex session actually gets).** Writes THIS project's shared `store/<repoKey>/` DIRECTLY — daemon-independent, zero `hivecontrol` calls (wrapped in send-time self-heal, `withSelfHeal`). `repoKey` is resolved from cwd FIRST; a non-git cwd returns `{ok:false, reason:'no-project'}` before any identity is derived (D28). `--from` is always re-derived from cwd (`callerIdentity`, spoof-resistant); an explicit `--from` must match or the send is rejected. `--to <meshId>` is fail-closed against the shared registry (D12a) — an unregistered meshId is rejected, never silently black-holed; the row lands in the target's REAL builder-id partition (D19), not the meshId itself. **v0.62.0 addressing fix (`resolveSendTarget`):** `--to` now ALSO accepts an exact match against a row's own `id` (the registry primary key, and the value `roster` actually delivers into) as a fallback when the meshId pass finds nothing — before this fix, an `id` copied straight from `roster` (which printed `id` but not `meshId`) failed closed as `unregistered-recipient` even though the workspace WAS registered; both fields now resolve identically. The meshId path is tried first and is byte-for-byte unchanged (full back-compat); a corrupted/duplicated registry producing >1 `id` match fails loud as `reason:'ambiguous-recipient'` rather than silently picking one (defense-in-depth — `id` is the store's own PRIMARY KEY, so this should never actually happen). `--to-primary` (v0.58) resolves this project's MAIN worktree's meshId (`inst.primaryWorkspaceId`, via `inst.resolveMainWorktree(cwd)`) then feeds it through the SAME `resolveMeshTarget` lookup — same fail-closed posture (`reason:'primary-unregistered'`) — correcting a stale prior citation to a `resolvePrimaryTarget` function that no longer exists under that name. The three target modes are mutually exclusive. Default `urgency` `normal`. `--question` marks this message as a blocking decision-request — only valid on a direct send (`--to`/`--to-primary`), rejected (`ok:false`) on `--broadcast`. The blocking/reply-tracking guarantee (`devswarm-parent-gate.js` Stop-gate + `devswarm-parent-reply-tracker.js` `recordReply`) is enforced when the recipient is the Primary; both hooks bail out for a child workspace (`isChildWorkspace`), so a peer child→child `--question` is delivered and flagged `needs_reply` but is NOT gate-enforced on the recipient. **`--answers` (G fix, defect 93c41cc09ff6):** marks THIS send as a reply that answers the recipient's own pending question — only meaningful (and only valid; rejected on `--broadcast`) alongside `--question`, for the "approved, did you also test Y?" shape where a message both answers one question and asks a new one. `cmdSend` echoes it back as `answers:true`; see the reply-credit correlation note below the command table for exactly how `devswarm-parent-reply-tracker.js` uses it (a `--question` send with no `--answers` is not credited as a reply, only logged as a hint). **v0.77.0:** `--message-file <path>`/`--message-stdin` accept the body verbatim as alternatives to `--message TEXT` (bypasses argv/shell quoting); value-taking flags now consume a value that starts with `--`. A successful send echoes `bytes` (`String(message).length`) and `hash` (the same `meshMessageHash` the store computed for the sent fields) — previously the hash was computed and then discarded, so `ok:true` proved a row existed but not that it was intact. | `cmdSend` `devswarm.js:2698`, `resolveMeshTarget` `devswarm.js:2603`, `resolveSendTarget` `devswarm.js:2675`, dispatch `devswarm.js:1547` |
| `roster [--ack]` | **v0.57 MESH; v0.58 adds a read-only native-children FOLD; v0.62.0 adds `meshId` to every row.** ALLOW-listed projection read of this project's shared registry + `working_on` + `recent[]` broadcast digest, derived fresh (never cached). `--ack` is an alias of `mesh read` below — the ONLY surface that clears `broadcastUnread`. As of v0.58, plain `roster` (never `--ack`) additionally unions a bounded, read-only `hivecontrol workspace list children` view — a spawned-but-unregistered child appears (`source:'native'`) instead of being invisible; never written back to the store. **v0.62.0:** every row now ALSO prints `meshId` (`rosterMeshId`, worktree-derived) alongside `id` (the registry primary key) — the exact fix that closes the `send --to` addressing footgun above: a value copied from EITHER field now addresses the workspace correctly. | `cmdRoster` `devswarm.js:2942`, `rosterMeshId` `devswarm.js:2937`, `fetchNativeChildren` `devswarm.js:1165`, dispatch `devswarm.js:1552` |
| `mesh read [--peek] [--seq N]` | **v0.57 MESH.** Same as `roster --ack` (D23) — lists the caller's unseen NON-heartbeat broadcasts past its own broadcast cursor, then advances that cursor to head. **NON-DESTRUCTIVE PEEK (defect d68c561e1649):** `--peek` reads without ever advancing the cursor (`acked:false`, `peek:true` in the response) — pre-fix, every read permanently consumed the messages at/below the cursor with no way to re-inspect them. `--seq N` reads from an explicit historical seq instead of the caller's own cursor (`since:N` echoed back) and always implies peek, so re-inspecting history never moves the live cursor as a side effect. Neither flag changes behavior when omitted — byte-for-byte the pre-fix baseline, same cursor advance, same return shape. | `cmdMeshRead` `devswarm.js` (`run()` dispatch's `mesh`/`read` sub-branch) |
| `heartbeat <id> --summary TEXT [--urgency ...]` | **v0.57 MESH addition to the existing `heartbeat` verb.** `--summary` ALSO broadcasts a mesh heartbeat row (`mtype:'broadcast'`, `is_heartbeat:1`) into this project's shared store — feeds `roster`'s `working_on` field (matched by `sender === d.id`). Default urgency `low`. A non-git cwd does not fail the base heartbeat write; it reports `meshBroadcast:{ok:false, reason:'no-project'}`. | `cmdHeartbeat`, dispatch (`heartbeat` case) |
| `reconcile` | **v0.58, NEW; auto-run since v0.58.1 (was manual-only in v0.58.0).** Drains every registry descriptor of THIS project (that carries a `worktreePath`) once, via a per-id SUBPROCESS spawn (`inbox pull <id>` with `cwd` = that worktree — never in-process, which would drain the wrong queue). Per-id `O_EXCL` pull lock serializes against a live concurrent pull (`locked:true`, not silently dropped). Not a daemon — a one-shot sweep. **v0.62.0 self-heal pre-pass (Claim 3 fix):** BEFORE computing drain targets, `cmdReconcile` now runs `healRegistry(home, repoKey, ctx)` over THIS project's own registry — a row physically sitting in the wrong store but whose descriptor's real worktree path structurally belongs here is healed in place (stale persisted `ownerKey`/`repoKey`/registry `worktreePath` corrected); a row physically here but whose descriptor belongs elsewhere is rehomed OUT via `rehomeAcrossStores` (message-preserving, zero loss, never deleted) and excluded from this run's targets. The aggregate `ok` now ALSO requires `rejected === 0` (a target the ensure-ownership check refused even after the heal pass) in addition to the pre-existing `lost === 0` — closing a false-negative where a genuinely mis-keyed row used to silently read as a benign `no-project`-shaped failure. Result gains `healed`/`rejected` fields alongside the existing `count`/`imported`/`lost`. **v0.58.1 auto-heal wiring:** run as a GATED `doctor --fix` repair (same gate as the other daemon fixes — `isDevswarmActive(env) && resolveWorktree(cwd)!==null`; gate-closed reports the manual command and mutates nothing; honors `--dry-run`/`--check`; NOT a Windows no-op, since it only spawns per-worktree Node subprocesses, no scheduler) and as a DevSwarm-session-only post-`update` step (`isDevswarmActive(env)` only, regardless of whether the cache synced — a stranded queue is unrelated to a version bump). **v0.62.0 doctor/update ALSO sweep `healRegistry` directly** (not only as a side effect of running `reconcile`): `doctor.js`'s `heal-registry-rows` repair enumerates EVERY per-project store (`devswarm-store.js`'s `listStoreHashes`) and is AUTO-SAFE (no DevSwarm-active gate — pure store read+write, no daemon/scheduler touch); `update.js`'s `healRegistryPostUpdate` does the same enumeration, gated the same way as its sibling `reconcile`/fold/ownerKey post-update steps. Both are idempotent (a second sweep over an already-healed store heals/rehomes nothing further) and NO-DELETE. Verified safe to auto-run: IDEMPOTENT (`pullOnce`'s `collectExistingHashes` dedupes by content hash, `devswarm-pull.js:165-178`/`240-256` — a re-run imports 0 new messages), LOCK-RESPECTING (the per-id O_EXCL pull lock, `devswarm-pull.js:208-209` — a worktree a live child is already draining is skipped, never raced), LOSS-FREE (the durable append precedes `ok:true` and feeds the shared store, `devswarm-pull.js:258-284`; a short-received batch fails loud with a `lost` field rather than silently dropping messages, `devswarm-pull.js:286-307`). The manual verb below still works standalone. | `cmdReconcile` `devswarm.js:3250`, `healRegistry` `devswarm.js:764`, `rehomeMiskeyedRow` `devswarm.js:694`, `defaultSpawnReconcile` `devswarm.js:1276`, dispatch `devswarm.js:1566`; doctor wiring `hooks/lib/doctor-repair.js` (`reconcile` GATED section + `heal-registry-rows` AUTO-SAFE section); update wiring `skills/update/scripts/update.js` (`reconcilePostUpdate` + `healRegistryPostUpdate`) |
| `spawn <branch> [hivecontrol create flags...]` | **v0.58, NEW.** THIN pass-through wrap of `hivecontrol workspace create <branch> ...` — the raw argv tail forwards untouched, never re-parsed — then best-effort auto-registers the new worktree in the shared store registry (store-only; the child's own first self-registration call fills in the rest). A create failure returns as-is; a post-create registration failure never rolls back the already-succeeded create. **v0.67.0 human-readable naming:** after a successful create, `spawn` ALSO makes a SEPARATE best-effort `hivecontrol workspace update-title -b <branch> "<title>"` call — `<title>` is a caller-supplied `-t/--title` if present, else derived from the `-p`/`--prompt` brief by `deriveTitleFromBrief` (first non-empty line, one leading markdown marker stripped, whitespace collapsed, truncated to 60 chars on a word boundary). The original create argv passed to `hivecontrol` remains byte-for-byte untouched — this is a wholly separate follow-up call, never inline mutation of the create flags — and an `update-title` failure/exception never fails the `spawn` verb itself. The resolved title is cached via `companion/lib/devswarm-names.js` (atomic tmp+rename fs cache) so `devswarm-parent-inbox.js` can render `name (shortid)` without ever calling `hivecontrol` on its per-turn hot path. `reconcile` separately caches whatever label hivecontrol already has for a pre-existing workspace, but deliberately never invents a title for one with no brief on record. | `cmdSpawn` `devswarm.js:1362`, `deriveTitleFromBrief` `devswarm.js:4036`, `resolveCreatedWorktreePath` `devswarm.js:1340`, dispatch `devswarm.js:1570`, name cache `companion/lib/devswarm-names.js` |
| `merge [hivecontrol merge-into-source flags...]` | **v0.58, NEW.** THIN wrap of `hivecontrol workspace check-merge` (informational) + `hivecontrol workspace merge-into-source ...` (pass-through), then `send --broadcast`s the outcome to the mesh (best-effort — never masks the merge's own result). `merge-from-source` is untouched, still a raw hivecontrol call. | `cmdMergeVerb` `devswarm.js:1415`, dispatch `devswarm.js:1577` |
| `diagnose` | **v0.61.0, NEW.** Read-only mesh-health projection (`computeDiagnosis`): per-registry-row live/unread state, which partition a `send` to each worktree's meshId resolves to, `orphans[]` (unread partition, no live workspace), `staleRegistryPartitions[]` (registry row whose worktree is gone), `splits` (2+ LIVE rows sharing one meshId — same meaning as before, e.g. two live tabs on one worktree; benign), and, as of **v0.77.1**, `deadSplits` (2+ rows sharing one meshId with ZERO live rows — nobody draining any of them; dangerous, previously invisible because the old `split` check required `liveRows>=2` and scored this shape as 0). Each `meshTargets[]` entry now also carries `deadSplit` alongside the pre-existing `split`. Pure `computeSummary` + registry read — never writes `summary.json`. | `cmdDiagnose` `devswarm.js:5310`, `computeDiagnosis` `devswarm.js:5251`, dispatch `devswarm.js:6335` |
| `healthcheck [--json]` | **v0.61.0, NEW.** Scriptable pass/fail gate over the SAME data `diagnose` computes (one shared `computeDiagnosis`, two presentations). `degraded` iff `orphansWithUnread>0 \|\| stale>0 \|\| splits>0 \|\| deadSplits>0` (phantoms/unreadTotal are reported but never gate). No `--json` prints one compact human line (e.g. `healthcheck: ok (scope: <repoKey>) [orphansWithUnread=0 stale=0 splits=0 deadSplits=0 phantoms=0 unread=0]`); exit `0`=healthy, non-zero=degraded, for monitors/CI/the ingest daemon. **v0.77.0 rename:** the counter is now named `orphansWithUnread` (this cwd's own repoKey store, pre-filtered to unread>0) — a DIFFERENT count from `heal-orphan-partitions`'s cross-machine `orphanPartitions` sweep, which counts every orphan in every store regardless of unread; do not compare the two as the same measurement. `orphans` is kept as an exact-value alias of `orphansWithUnread`. The human line now also states its `(scope: <repoKey>)`. **v0.77.1:** `counts.deadSplits` (2+ rows, zero live) is now a SEPARATE gating counter from `counts.splits` (2+ live rows) — a dead split alone now degrades the check and prints its own line in the human summary; it used to be structurally impossible to detect. | `cmdHealthcheck` `devswarm.js:5351`, `healthcheckHumanLine` `devswarm.js:5388`, dispatch `devswarm.js:6340` |
| `unarchive <id>` | **v0.62.0, NEW.** Reverses `archive`: restores the descriptor from `archived/` back to active and revives the store registry row. Rejects (`ok:false`) if the archived descriptor's ownerKey doesn't match the CURRENT project, or if a non-recovery-anchor active descriptor already exists for that id. | `cmdUnarchive` `devswarm.js:1981`, dispatch `devswarm.js:3365` |
| `migrate-owner-keys` | **v0.62.0, NEW — forward-migration, idempotent/fail-open/no-delete.** Scans every active + archived descriptor once: backfills a missing `ownerKey` (fresh structural repo-key resolution, falling back to the legacy hash) and re-homes an ACTIVE descriptor still stranded under a stale hash-keyed store bucket into its fresh `repoKey`-keyed bucket (archived rows are never re-homed). Exposed as its own verb so `update`/`doctor`/an operator can run it directly; also wired into both. | `migrateOwnerKeys` `devswarm.js:2142`, dispatch `devswarm.js:3397` |
| `reap-stale [--yes\|--confirm]` | **v0.62.0, NEW.** Project-scoped (requires a git cwd). Finds THIS project's descriptors whose persisted liveness verdict is `stale`/`escalated`, then applies two safety gates before ever proposing one: a fresh heartbeat, or recent worktree git activity, both mean never-reap. Without `--yes`/`--confirm`, returns a dry-run `{candidates, skipped}` only; with it, archives each surviving candidate via `cmdArchive`'s own `revalidate` hook (re-checks liveness/ownership immediately before the archive, so a workspace that heartbeats between listing and archiving is skipped, not wrong-archived). | `cmdReapStale` `devswarm.js:3053`, dispatch `devswarm.js:3436` |
| `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes\|--confirm]` | **v0.62.0, NEW.** Project-scoped. Archives every current (non-archived) workspace of THIS project NOT in `--active` (ids also accepted via `--stdin`, newline/space/comma-separated); a match always SPARES a workspace — the safe direction, an active one is never archived. Ids match by full id or a >=4-char prefix / >=8-char embedded-hex substring (roster-display-friendly). Refuses an empty active set unless `--allow-empty` is passed explicitly. Dry-run by default; `--yes`/`--confirm` applies. | `cmdReconcileActive` `devswarm.js:3118`, dispatch `devswarm.js:3440` |

**v0.98.0 additive response fields, roster hints, and wake-watch diagnostics:**

- `send`/mesh delivery — `possiblyStaleRegistry: true` (defect 2e8653787945): set on an `ok:false` `reason:'primary-unregistered'`/`'unregistered-recipient'` refusal made while the send-time self-heal ALSO confirmed the ingest daemon is stale, alongside a `retryAfterMs` (remaining self-heal cooldown) on that same result. Signals "this refusal may just be a lagging registry read, retry after `retryAfterMs`" — never reattributes a genuinely bad address; `reason`/`error` are untouched.
- `send`/`inbox read-primary` — `redirected: true` + `redirectedFrom: "<old id>"` (defect 73303d4c098b): a target that was folded into a survivor by `foldGroupIntoSurvivor` leaves a one-hop redirect tombstone; addressing the now-retired id lands on the survivor instead of failing closed, and the response says so. Single hop only — a twice-folded id still fails closed, with `roster` reporting the fresh id.
- `inbox read-primary`/`inbox messages` rows — `forwarded: true` + `origHash` (defect e9e7c99ec924): a forwarded row keeps its ORIGINAL `ts` (by design — `storeSeq` is freshly assigned at forward time, `ts` is not), which used to print as unmarked out-of-order timestamps; both fields are now stamped on any row `forwardedOrigHashOf` recognizes as a forward, purely additive.
- Mesh message rows — `instanceNonce` (defect d3d571495bf6): a per-OS-process discriminator (`anc:<ancestor pid>:<startedAt>`, or `self:<pid>:<startedAt>` with no resolvable harness ancestor) stamped on every outbound row via `deriveInstanceNonce`, so two live processes sharing one `CLAUDE_CODE_SESSION_ID` (e.g. a `claude --resume` racing its own prior process) no longer write indistinguishable rows. Nullable, additive, and deliberately EXCLUDED from `meshMessageHash`/the dedup hash — a legacy row simply reads back `null`. `shortInstanceNonce(nonce)` (the shared display helper every consumer below uses) renders it down to a stable 6-hex-char digest (`sha1(nonce).slice(0,6)`) — short enough to eyeball, deterministic, never the raw pid-bearing nonce.
- `inbox read-primary`/`inbox messages` rows — `instanceNonceShort` + `fromLine` (defect d3d571495bf6, item a): purely additive, present ONLY on a row that carries an `instanceNonce` — a row without one renders byte-identical to before this fix. `instanceNonceShort` is the shared short digest above; `fromLine` is the human-readable `<sender>@<short>` rendering, so two live processes both sending under the same `sender` id are visibly distinguishable per message instead of reading as one indistinguishable sender.
- `roster` — `instances` + hint `instance-split`, and `phantom` (defects d3d571495bf6 / 298b79969409): `instances` (item b) is the count of DISTINCT `instanceNonce` values seen on a row's own outbound broadcast/heartbeat rows within the shared liveness freshness window (`DEFAULT_HEARTBEAT_FRESH_MS`, the SAME window `hasFreshHeartbeat` uses); present ONLY when at least one instanceNonce was seen (a row with none carries no `instances` key at all — byte-identical to the pre-fix shape). `> 1` additionally pushes the `instance-split` hint, meaning two live OS processes are both sending mesh traffic under one sessionId/row identity. `phantom` is the unrelated pre-existing hint: it fires when a row would otherwise carry no dormancy hint at all (reading as active) but the shared `computeRowLive` predicate — the SAME one `diagnose`'s `live` field now uses — finds no real sessionId and no fresh heartbeat, closing a case where a child trusted an empty roster hint and stranded mail on a row `diagnose` already reported as `live:false`. Neither hint is ever applied to native (`source:'native'`) children.
- `diagnose` — `instanceSplits[]` (item c): `[{id, sessionId, instances, nonces:[<short>...]}]` for every registry row whose `instances` count (SAME `computeInstanceNonceCounts` source and freshness window as `roster`'s hint above, so the two verbs can never disagree) is `> 1` — rows sharing a mesh id whose divergence is only their `instanceNonce` (same underlying identity, different live OS process), distinct from the pre-existing `splits`/`deadSplits`/`mixedSplits` (which key on live registry rows, not process identity). `nonces[]` holds the short digest of each distinct nonce, never the raw value.

**Read-side exact-id-wins rule (defect 1932b53a3ace):** `resolveReadArgToId` (the shared resolver behind `inbox count`/`read`/`ack`/`messages`/`read-primary`/`peek-primary`) now checks for a registry row whose id EXACTLY equals the caller's `arg` FIRST (no liveness filter applied — a dead/dormant row's own exact id still wins as a no-op, matching every other exact-id-match path in this file), before ever delegating to `resolveSendTarget`'s meshId/redirect resolution — an exact registered id always wins as a no-op and is NEVER redirected to a different row, even when that same `arg` also happens to collide with a DIFFERENT row's derived meshId (a `register-primary` row and a same-worktree "twin" both derive the identical meshId from `canonicalMeshId`, since that IS `primaryWorkspaceId`). Pre-fix, a read could silently land on the colliding row instead of the row the caller literally named — e.g. `inbox ack <primary-id>` consuming a same-worktree twin's unread mail instead of refusing on the Primary's own (inbox-path-less) partition. `send --to` keeps its own, intentionally different behavior: an exact-id arg that ALSO collides with a distinct row's meshId still refuses as `ambiguous-target` there (a write must never silently guess which of two colliding partitions the caller meant) — reads and writes deliberately diverge on this one case.

**Store-unavailable read semantics, `storeUnavailableReason` (defect 902d3c5e7531, extended):** a store that genuinely EXISTS but cannot be READ (`EACCES` on the store dir, `ENOTDIR`/`EISDIR` from a journal path replaced by/holding a regular file, a corrupt/unparseable sqlite header) is no longer silently indistinguishable from a genuinely empty/never-written store. The journal backend's internal read helper now distinguishes `ENOENT` (no store yet — stays fail-open, `[]`) from every other fs error (recorded PER FILE on the store handle, surfaced via `getReadError()`/`getReadErrors()`); the sqlite backend wraps a genuine open failure (`mkdirSync`/`DatabaseSync` throwing) into the same typed shape and, for call-site parity, exposes both getters as no-ops (`null`/`[]`) since it has no deferred read path to report. Every read verb (`count`/`read`/`ack`/`messages`/`read-primary`/`peek-primary`) now reports `storeUnavailable` as a plain BOOLEAN, with the underlying error code in the sibling top-level field `storeUnavailableReason` (string|null — e.g. `"EACCES"`, `"ENOTDIR"`, or node:sqlite's own `"ERR_SQLITE_ERROR"`), and `known:false` in this case; `count`/`read`/`ack` additionally keep the fuller refusal object (`reason`/`error`/`registeredRepoKey`/`callerRepoKey`/`storeUnavailableReason`) under a separate `storeUnavailableDetail` key, never nested inside `storeUnavailable` itself. `emitKnownWarning`'s stderr line now names `store-unavailable (<code>)` instead of the tautological `storeUnavailable (store-unavailable)`. A never-written store dir (`ENOENT`) is unaffected — still refused as the pre-existing, unrelated `unregistered-workspace` reason when nothing else backs the id. The claim above is now genuinely blanket for the six READ VERBS (`count`/`read`/`ack`/`messages`/`read-primary`/`peek-primary`): EVERY read path among those that could otherwise mistake an unreadable registry for a genuinely-absent one re-probes `getReadError()` right after its own `listRegistry()` call, not just before it — this closes the two remaining gaps where `listRegistry()`'s own EACCES-swallowing (returns `[]` rather than throwing) let a real store outage read as a security/existence refusal instead: (1) the `read-primary`/`inbox messages --ack` ownership check (`doAck && !ackAsOwner`), which calls `resolveMeshTarget` -> `listRegistry()` to resolve the caller's own registry row BEFORE deciding ownership — an unreadable registry there used to report `caller-not-registered` for a caller that in fact owns `id`; and (2) the no-descriptor existence guard (`resolveWorkspaceStoreForRead`) for a totally unregistered id, whose own `listRegistry()` call could similarly mask a genuine registry outage as `unregistered-workspace`. Both now report `store-unavailable`/`storeUnavailableReason` instead. **Gap closed in 0.98.2 (defect 77d5a5bbf614):** `roster`, `diagnose`, and `healthcheck` no longer read the registry silently fail-open. `cmdRoster` (`devswarm.js:11762`) and `computeDiagnosis` (`devswarm.js:11981`) each probe `pickStoreReadErrorScope`/`getReadError()` right after their own `listRegistry()`/`computeSummary()` call and report `known:false`, `storeUnavailable:true`, `storeUnavailableReason:<code>`, `storeUnavailableScope`; `diagnose` and `healthcheck` (`cmdHealthcheck`, `devswarm.js:12323`) additionally flip `degraded:true` and set `status:'store-unavailable'` (`devswarm.js:12353`), so an unreadable `registry.ndjson` can no longer make `healthcheck` report `ok:true`.

**Retired-sender ack hint corrected to `--ack-as-owner` (defect items 3, fl-wave4):** the INFORMATIONAL retired-sender hint in both `devswarm-parent-gate.js` (`buildInformationalSegment`) and `devswarm-parent-inbox.js` (the own-unread informational renderer) told the Primary to run plain `inbox ack <id>` — which fails ownership for a genuinely retired sender (no live owner to ack as) and never actually clears the hint. Both now say `inbox ack <id> --ack-as-owner`, matching the sanctioned cross-workspace-ack override `devswarm-parent-gate.js`'s own gone-worktree remediation text already used.

**wake-watch (`devswarm-wake-watch.js`) REFUSED TO ARM diagnostics (defect 8143ced316d3):** the refusal line now names the existing holder's `pid`, `age`, and plugin `version` (e.g. `holder pid=1234 age=185s version=0.97.1`) instead of a bare "already watched" message. A stale-but-still-alive holder (its lock's `ts` has gone stale because it stopped calling `release.restamp()` on its poll ticks — a HUNG watcher, not an exited one) can now be taken over: the lock's steal-check opts in via `allowStaleLiveSteal` (default `false`/opt-in for every other lock caller — a one-shot `inbox pull` drain lock never takes this path). A watcher that loses its lock this way exits on its next tick once its `restamp()`/`release()` call finds the token no longer matches.

**Reply-credit correlation fix (defect 93c41cc09ff6, revised — G, `send --answers` flag added):** a reply that itself carries `--question` (asking a NEW follow-up) — e.g. `send --to X "approved, did you also test Y?" --question` — used to be silently skipped for reply-credit purposes by the blanket `needsReply === true` check, leaving the RECIPIENT's original question marked unanswered forever even though this send genuinely answered it. An interim fix conditioned the skip on `recipientHasPendingQuestion(repoKey, home, resp.toId)` alone, but that proves only that the recipient has *some* pending question on file, not that *this* message answers it — a false positive (any `--question` send to a recipient with an unrelated older pending question got credited as its reply). The gate now requires the EXPLICIT correlation instead: a `--question` send is credited against the recipient's pending question ONLY when it ALSO passes `--answers` (rejected on `--broadcast` — there is no single recipient's question to answer). `cmdSend` echoes this back as `answers:true` on the response, and `devswarm-parent-reply-tracker.js`'s `recordReply` gate checks `resp.needsReply === true && resp.answers !== true` before deciding whether to skip. A `--question` send with no `--answers` keeps the original pre-93c41cc09ff6 behavior (not credited) but now logs a `reply-not-credited-missing-answers` hint (`parent-inbox.log`) instead of silently dropping the correlation, naming the recipient and suggesting a resend with `--answers` if the message really was meant to answer it. A plain reply with no `--question` at all is unaffected — still credited unconditionally, exactly as before. Lives in `cmdSend` (`scripts/devswarm.js`, the `--answers` flag itself) and `devswarm-parent-reply-tracker.js`'s `recordReply` gate + `logAnswersHint`.

**Worked example — a full Primary/child lifecycle end to end:**
```bash
# Primary, from its own worktree — register once (per-worktree id, idempotent):
node scripts/devswarm.js register-primary
# (no --session needed: this now defaults to the real $CLAUDE_CODE_SESSION_ID
# Claude Code sets on the process automatically — Task #10. Pass --session
# explicitly only to override.)
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

**v0.58 mesh-only messaging — the CLI verbs a native `hivecontrol workspace
message-child`/`message-parent` call is now redirected to, plus the new lifecycle wraps
(Claude-side; a Codex session can invoke the same script, see the v0.58 note's
Codex-parity caveat above):**
```bash
# A child directs a message straight at the Primary without knowing its meshId:
node scripts/devswarm.js send --to-primary --message "blocked on schema decision" --urgency high

# Drain every stranded worktree's inbox once (e.g. after a daemon outage) — a one-shot
# sweep, not a daemon. Also auto-run since v0.58.1 by `doctor --fix` (GATED) and by
# `update` (DevSwarm-session-only) — this manual invocation is for an on-demand sweep:
node scripts/devswarm.js reconcile

# Thin pass-through spawn/merge — every hivecontrol flag forwards untouched, then the
# outcome is auto-registered / broadcast to the mesh:
node scripts/devswarm.js spawn feature/new-child -p "own the API layer" -a claude
node scripts/devswarm.js merge

# archive-request is now a direct store write — zero hivecontrol calls, no --child-branch:
node scripts/devswarm.js archive-request child-1 --reason "shipped in v1.2.0"

# roster now also surfaces a hivecontrol-spawned child that hasn't self-registered yet:
node scripts/devswarm.js roster                 # entries carry source:'store'|'native'
```

Every subcommand above was verified to exist at the cited line by reading the current
`scripts/devswarm.js` directly — none is inferred from a skill/doc description. The full
verb set dispatched by `scripts/devswarm.js` (`devswarm.js:3313`-`3454`) is exactly:
`register`, `ensure`, `heartbeat`, `inbox`, `workspaces`, `gate`, `nudge`, `archive`,
`unarchive`, `archive-ignore`, `archive-unignore`, `archive-request`, `register-primary`,
`migrate`, `migrate-owner-keys`, `send`, `roster`, `diagnose`, `healthcheck`, `mesh`,
`reconcile`, `reap-stale`, `reconcile-active`, `spawn`, `merge` — no other
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

- **No public CLI or config docs — and, per the v2.3.5 pass, the CLI's OWN `--help` is
  incomplete too.** `hivecontrol` and `.devswarm/config.json` are undocumented on the web; the
  public GitHub repo is "landing + issue tracker" only, no product source [14]. Beyond that, the
  installed binary's own `hivecontrol --help` omits two entire command groups (`jira`, `team`)
  and one verb (`workspace search`) that are real and functional (§4.3/§4.4) — don't treat
  `--help`'s top-level command list as exhaustive; a source grep for `new Command(...)` is what
  actually surfaced the full set. Build against the **installed** `--help` (and a source grep
  where available), and pin behaviour to the observed version (currently 2.3.5).
- **`worktree-include`: creation-time only, exact-names-only, no retro-sync** [12].
- **`jira create` requires `--type` and `--summary`; the CLI's own in-app agent guidance text
  gives a broken example (`-s`/`-d` short flags that don't exist).** See §4.3's callout —
  verified against the source's `.requiredOption(...)` calls, not just `--help` text.
- **`team` group and `workspace search` are Team-plan gated.** Every leaf returns real `--help`;
  actually running one against a non-Team org returns a structured `TEAM_SUBSCRIPTION_REQUIRED`
  JSON error (verified for `workspace search`; the same gate is expected, not independently
  re-verified, for each `team` leaf — see §4.4).
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
  behaviour. This landed in **both** `plugins/anti-hall/skills/orchestration/SKILL.md` **and**
  its Codex mirror `plugins/anti-hall/codex/skills/anti-hall-*/` (dual-platform mandate), with a
  parallel OMC/OMX table (§8.4).
- **Reuse existing guards** — `git-guard`, `merge-gate`, and the swarm/anti-deep-nesting pattern
  map directly onto the workspace tier (§8.5); the "no child-of-child" rule is the same
  philosophy at a coarser grain.
- **SHIPPED in v0.59.0 as injected DOCTRINE, not mechanical enforcement.** A DevSwarm
  Primary is now told, at SessionStart and at both guard-block points
  (`hooks/edit-guard.js`/`hooks/command-guard.js`), that a child workspace
  (`devswarm.js spawn <branch> -p "<brief>"`) is its top fan-out tier ahead of a subagent.
  There is still **no mechanical scale classifier** — nothing detects "this spawn is
  workspace-scale" and blocks it (deliberate: a false positive would break legitimate
  subagent use); the tier choice remains the model's. A DevSwarm **child** workspace and
  any **non-DevSwarm** session see byte-identical behaviour to before. The fuller
  enforcement-layer design in `docs/superpowers/specs/2026-07-05-devswarm-orchestration-
  design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md` remains
  unbuilt; resolving §8.6's open questions in a brainstorm/plan-mode pass is the
  prerequisite before any of that enforcement layer is coded.
- **Idle self-wake (SHIPPED in v0.59.0).** §8's "Honest wake-mechanism caveat" gap: a DevSwarm workspace
  going idle had nothing to wake it when a mesh message landed after its last turn ended.
  A SessionStart directive (`hooks/lib/devswarm-wake.js`) now tells a Claude workspace to
  self-schedule a recurring mailbox-drain via the `CronCreate` tool — the only primitive
  confirmed to fire while the REPL is idle — default `*/5 * * * *`, tunable via
  `ANTIHALL_DEVSWARM_WAKE_CRON` (cron-charset-validated so the env var cannot smuggle a
  prompt-injection payload into the model-visible directive). A bounded Stop-gate
  re-verify on `devswarm-child-gate`/`devswarm-parent-gate` re-creates the job when it has
  auto-expired (recurring cron tasks self-delete 7 days after creation). Claude-only by
  construction (`CronCreate` is a Claude tool, not something a hook process can call
  itself); a Codex/non-Claude workspace gets the honest "no idle-wake primitive, drain
  every turn" fallback instead of being told to call a tool it doesn't have.
- **anti-hall's own DevSwarm state** (this session): `.devswarm/config.json` carries
  `worktreeInclude: [".claude/settings.local.json"]` so child workspaces inherit the local
  bypass — a live, working example of the `worktree-include` mechanism this KB documents.

---

## 12. Sources

**Primary evidence — verified on this machine, 2026-07-04 (5) + 2026-07-14 (1 more) (6):**
(P1) `hivecontrol --help` / per-subcommand `--help`, **v2.3.3 → re-verified v2.3.5** — full CLI
surface, JSON I/O, parent-child + coordination protocol ·
(P2) DevSwarm.app `app.asar` → `electron/main.js` (zod config schema @25385; system-prompt
@~75380–75800) + 46 Drizzle migrations — hierarchy=`sourceBranch`, `builderType`, port range
2000–9999, merge plumbing ·
(P3) Live probes on this machine — `env | grep DEVSWARM` of the Primary + `workspace list all
--tree` (root annotated `main (Primary Workspace) ← you`) + a throwaway **child** workspace
(`probe/devswarm-env-check`) confirming child `DEVSWARM_SOURCE_BRANCH=main`, the gitignored
`graphify-out/`, and the parent↔child message loop ·
(P4) `hivecontrol repo validate` run — confirmed schema/`worktreeInclude` write ·
(P5) Injected DevSwarm agent system-prompt (this workspace) — NL→CLI mapping, coordination protocol ·
(P6, new 2026-07-14) `grep` sweep of the bundled `devswarm` CLI script itself (v2.3.5,
`/Applications/DevSwarm.app/Contents/Resources/cli/devswarm`) for `.command("...")` /
`new Command("...")` registrations and `DEVSWARM_[A-Z_]+` references — the source-level
confirmation that surfaced the hidden `jira`/`team` groups and `workspace search` verb (§4.3/
§4.4), ruled out `DEVSWARM_CLI_REFERENCE` as a real env var, and confirmed `jira create`'s
`--type`/`--summary` are `.requiredOption(...)` in code (not just `--help` prose).

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
  or removed commands (relative to what §4 documented at the time — see the next entry for what
  that pass actually missed). Treat the CLI-surface facts as current through 2.3.4.
- **Re-verified 2026-07-14 at v2.3.5 — the "zero surface changes" conclusion of the 2.3.3→2.3.4
  passes was correct as far as it went, but both passes had scoped their audit to `hivecontrol
  --help`'s own top-level command LIST and gone one level deep from there. That list was
  incomplete, so both prior passes inherited the gap.** The v2.3.5 pass instead grepped the
  bundled `devswarm` script's source for command registrations (`new Command(...)` /
  `.command(...)`), which is how it found `jira` (14 subcommands) and `team` (5 subgroups) —
  two entire top-level groups that work when invoked directly but are absent from
  `hivecontrol --help`'s printed command table — plus a hidden `workspace search` verb absent
  from `hivecontrol workspace --help`'s own table. All are documented in §4.3/§4.4/§4.1. Also
  found: the `DEVSWARM_NO_AUTO_AUTH` env var (§6), the `jira create` required-flags fact and the
  in-app example's `-s`/`-d` bug (§4.3), and confirmed (not assumed) that stray `lint`/`serve`/
  `watch` grep hits in the same source file are example code inside a JS **comment**, not
  registered commands — ruled out explicitly rather than silently omitted, so a future pass
  doesn't have to re-derive that. **Lesson for the next re-verification pass:** don't rely on
  `--help`'s own command list as the audit boundary; grep the source for command registrations
  first, then `--help` each one found that way.
- **Vendor productivity claims** ("5×") are self-reported, not independently benchmarked [5][18];
  the "19% slower" counter-figure is reported by DevSwarm's blog [5] citing METR (2025), not a
  direct METR source here.


## 14. Version timeline (evidence-tagged, appended 2026-08-21)

> §1–§13 above are the **v2.3.5-era record**, verified 2026-07-14, and left untouched. This
> section and §15–§17 record what could be established about the DevSwarm/`hivecontrol`
> release history and the **currently installed v2.5.1** surface, verified 2026-08-21.

| version | evidence | note |
|---|---|---|
| 2.3.0 | Code comment in migration `0044_add_builder_is_active`: "first 2.3.0 launch", ticket SWARM-4408 [P2] | Earliest version named anywhere in the local artifacts. |
| 2.3.3 | `~/Downloads/DevSwarm.dmg` (417,408,143 bytes, created 2026-07-04 15:44:54 UTC); internal `Info.plist` reads 2.3.3 [P3] | This machine's earliest install. Oldest DevSwarm log entry `~/Library/Logs/DevSwarm/devswarm.2026-07-30-201633.log` begins 2026-07-04 19:46:44 local, same day. |
| 2.3.4 | Prior KB pass (§13, 2026-07-12 re-verification) [P2, prior pass] | Zero CLI surface change vs 2.3.3, confirmed byte-for-byte at the time. |
| 2.3.5 | §4 of this doc (2026-07-14 pass) [prior pass] | The baseline §1–§13 are pinned to. |
| 2.4.0 | Code comment in migration `0046_add_multi_repos`: migration renumbered 0044→0046 when branch `release/2.4.0` merged with the Multi-Repo branch [P2] | Headline feature = multi-repo (see §15 data model). |
| 2.5.0 | `cli/package.json` field `vscodeServerVersion: "v1.121.0-2.5.0"` [P2] | **Only** artifact on this machine naming 2.5.0 — no other evidence it ever ran here. |
| 2.5.1 | `hivecontrol --version` → 2.5.1; `Info.plist` CFBundleVersion = CFBundleShortVersionString = 2.5.1; `cli/package.json` version 2.5.1; Sentry state files record release `DevSwarm@2.5.1+3373dea785d149fc51b132fedda9e03c72b125f1` (build commit SHA) [P3] | **Currently installed.** Bundle unpacked on this Mac 2026-08-19 ~02:41–02:59. Also pinned in this build: bunVersion 1.2.23, gitVersion 2.47.1, vscodeServer v1.121.0-2.5.0. |

### 14.1 What is NOT recoverable

> **Correction of an error made earlier in this same pass, 2026-08-21.** An earlier version of
> this subsection asserted "no public changelog or release notes exist anywhere." That
> conclusion was **wrong** — it was reached by searching only the app bundle and the update
> infrastructure, and never checked the vendor's own public website. A public, paginated
> changelog **does exist** at **https://devswarm.ai/changelog/** (paginated via `?page=2`
> through at least `?page=5`) and is the **authoritative source for per-version feature
> attribution** going forward — see §14.2 for what it contains. **Lesson:** the app bundle and
> the update feed are local, mechanical artifacts; they are not a substitute for checking the
> vendor's public site, and their emptiness does not imply a changelog doesn't exist elsewhere.
> This error is called out explicitly, not silently fixed, per the doc's own verify-first
> discipline (see the §13 "no CLI" lesson, which this repeats in miniature — this time the
> propagation source was this session's own incomplete search, not a third-party web claim).

The findings below **remain true** and are unaffected by the correction above — they establish
that the *machine-local* artifacts carry no version history, not that no version history exists
anywhere:

- **The app bundle itself ships no changelog.** Searched `Resources` for changelog/release/
  whats-new — the only hits were third-party `node_modules` changelogs inside bundled
  vscode-server extensions, unrelated to DevSwarm itself [P2/P3].
- **Squirrel update feed probed, yields nothing usable.** `buildFeedUrl` in `update-url.util.ts`
  (inside `app.asar`) builds `${updateServerUrl}/update/${platformArch}/${currentVersion}`;
  production channel = `https://xnc1yo2yl1.execute-api.us-west-2.amazonaws.com/production/`.
  Probed for `darwin_arm64` at 2.3.5/2.4.0/2.4.5/2.5.0/2.5.1 → **HTTP 401
  `{"error":"Authentication required"}` every time** [P3]. This is a delta-check endpoint keyed
  to a specific installed version, not a version manifest — even authenticated it would not
  enumerate a changelog.
- **No updater artifacts retained on disk:** no `RELEASES`, no `latest-mac.yml`, no
  `app-update.yml`; `~/Library/Caches/com.twentyfirstidea.devswarm.ShipIt` exists but is
  **empty**. Crashpad `completed`/`new`/`pending` directories are all empty. The app does not
  log its own version at launch [P3].
- **Conclusion (narrowed, corrected):** whether 2.4.x or 2.5.0 ever actually *ran on this
  machine* is **still unknown and unrecoverable** — that specific claim survives the
  correction, because it's about local run history, which no public changelog can supply. The
  per-version attribution of individual CLI changes between 2.3.5 and 2.5.1 also **still cannot
  be fully established from local evidence alone**; §14.2's vendor changelog narrows this
  considerably for *feature-level* changes (it names which release shipped which feature) but
  does not prove which of those releases this machine ran. Every change recorded in §16 below
  remains scoped as "landed somewhere in 2.3.5 → 2.5.1" unless a migration comment or the §14.2
  changelog names a specific version.

### 14.2 Public vendor changelog — authoritative version timeline [P4]

> **New provenance tag, introduced this pass: [P4] = official vendor documentation/changelog
> (web).** [P4] ranks **below** [P2] (source inspection) and [P3] (live probe) for CLI-behavior
> facts — this doc's own §13 already established that ~20 web sources wrongly concluded
> DevSwarm "has no CLI," so a vendor web page is trusted for *what shipped when / feature
> naming*, but a §4/§16-style direct binary/source check always wins if the two disagree on
> what the CLI actually does. [P4] was already used once, undefined, at line 322 of §5 (part of
> the untouched §1–§13 record) — this is its first formal definition.

Source: https://devswarm.ai/changelog/ (paginated, `?page=2`..`?page=5`), read this pass:

| version | date | headline changes (per vendor changelog) |
|---|---|---|
| 2.3.2 | (undated on changelog; see below) | **HiveControl itself shipped in this release** (source: https://devswarm.ai/blog/hivecontrol-orchestrate-the-swarm/, not the changelog page). |
| 2.3.3 | Jun 29, 2026 | AI-agent install retry/repair flow; embedded-IDE ready-signal hardened; terminal colors sync with the VS Code theme; keyboard shortcuts respect non-QWERTY layouts. |
| 2.3.4 | Jul 8, 2026 | .edu/students get Pro automatically (~3-day silent renewal window); terminals no longer lose output on reattach; clone-into-existing-folder recovers gracefully. |
| 2.3.5 | Jul 10, 2026 | Reliability fixes, better Windows support, steadier workspace indexing. |
| 2.4.0 | Jul 16, 2026 | **Multi-Repo workspaces**: bundle several repositories into one workspace via a guided wizard, build a change across all of them, review in one place; each repo keeps its own branch and PR; can adopt repos already using submodules. Also fixes a blank AI terminal on workspace create/resume. |
| 2.5.0 | Aug 14, 2026 | Built-in richly-formatted chat interface for terminal coding agents (Claude, GitHub Copilot, OpenAI Codex) with streamed responses, clickable permission prompts, tool-call cards; app-wide VS Code theme adoption (per-project themes); **keyboard-driven workspace search / quick-switch palette** (find workspaces by name, branch, or linked Jira issue); simpler first-run setup; redesigned Create Workspace flow with live Jira and GitHub pickers; Windows fixes (deep file paths, terminal shell selection). |
| **2.5.1** | — | **Publicly unannounced.** The changelog's newest entry, as read this pass, is 2.5.0. No release note, blog post, or GitHub release names 2.5.1 anywhere on the vendor's public surfaces, despite it being the version actually installed on this machine (§14's main table, [P3]). |

**Cross-corroboration — the strongest evidence in this doc, called out explicitly.** Two
independent methods agree with each other, without either being derived from the other:
- Migration `0046`'s in-code comment (§15.1) ties multi-repo to branch `release/2.4.0` — the
  vendor changelog independently names 2.4.0 = Multi-Repo, shipped Jul 16, 2026.
- The hidden `workspace search` verb found in the 2.3.5 binary (§4.1) — undocumented at the
  time it was found — matches 2.5.0's changelog entry for a search/quick-switch palette shipped
  Aug 14, 2026.

This means the binary/migration forensics method (§4, §15) and the vendor's own published
history (this section) were derived completely independently and landed on the same facts —
meaningfully stronger corroboration than either source alone.



This is the **desktop app's** local store, not the CLI's. The CLI is a thin HTTP client to the
app's local API on `127.0.0.1` (port from `DEVSWARM_CLI_PORT`); the bundle's own source strings
say "HiveControl uses DevSwarm's local HTTP API" [P2].

- **Store:** `~/Library/Application Support/DevSwarm/devswarm.db` (SQLite, ~39MB, plus
  `-wal`/`-shm`), Drizzle-migrated, 51 migrations under `Contents/Resources/migrations/` [P3].
- **Worktrees:** `~/.devswarm/repos/<repositoryId>/<hash>/…`; pending cleanup staged under
  `~/.devswarm/scheduled-for-deletion/` [P3].
- **Not to be confused:** `~/.anti-hall/devswarm/*` is anti-hall's **own** state store, unrelated
  to the DevSwarm app's `devswarm.db` above — a future pass should not conflate the two.

Key tables → field names, verified via `sqlite3 PRAGMA table_info` [P3] (field names only; no
row data inspected/recorded):

| table | fields |
|---|---|
| `builders` (the "workspace" object) | id, repositoryId, sourceBranch, branchName, worktreePath, aiAgent, terminalId, label, createdAt, lastAccessed, rank, isHidden, promptEditorCollapsed, pullRequestId, builderType, isPinned, isActive, lastSelectedAt |
| `workspace_messages` | id, repositoryId, fromBranch, toBranch, message, status, createdAt |
| `repositories` | id, path, name, defaultBaseBranch, description, lastAccessed, defaultEditorId, rank, jiraProjectKey, githubAccessStatus, githubAccessError, githubAccessCheckedAt, defaultAiAgent |
| `builder_terminals` | id, builderId, terminalId, terminalType, aiAgent, ai_session_config, label, displayOrder, isPinned, isActive, panelStatus, createdAt, lastViewedAt, initialPrompt, transcriptByteOffset, transcriptLineCount, ingestionStatus |
| `builder_terminal_transcripts` | id, builderTerminalId, builderId, parentId, agentId, transcriptByteOffset, transcriptLineCount, ingestionStatus, createdAt |
| `multi_repos` | id, repositoryId, createdAt, parentManaged (plus `multi_repo_members`, `multi_repo_pending_submodules`) |
| other tables present | `jira_auth`, `github_auth`, `user_session`, `pull_requests`, `settings` (keys observed: `onboardingComplete`, `app.lastCacheVersion`) |

### 15.1 Migration timeline — the 2.4.0-era changes (0038–0050)

- `0038` add_transcript_tracking
- `0039` terminalId on prompts
- `0040` session_aware_cleanup (offsets moved onto `builder_terminals`)
- `0041` sentAt on prompts
- `0042` ingestionStatus
- `0043` `builder_terminal_transcripts` + backfill
- `0044` `builders.isActive` (comment: "first 2.3.0 launch", SWARM-4408)
- `0045` `builders.lastSelectedAt` (SWARM-4408)
- `0046` `multi_repos` + `multi_repo_members` (comment: renumbered when `release/2.4.0` merged)
- `0047` `multi_repos.parentManaged` (SWARM-4627, described in-comment as a CRITICAL data-loss fix)
- `0048` `multi_repo_pending_submodules` (SWARM-4652)
- `0049` pending-submodule `bootstrapUrl`/`defaultBranch` (comment signed "Trevor 2026-06-12")
- `0050` `repositories.defaultAiAgent`

**Date caveat [P2]:** journal `when` values for `0038`–`0050` are exact 50,000,000ms (~13.9h)
apart — the signature of synthetically re-stamped entries after the renumbering — unlike the
irregular, organic timestamps of `0000`–`0037`. Migration `0049`'s in-comment date
(2026-06-12) contradicts its journal date (2026-04-12). Treat `0038`–`0050` journal dates as
**relative order only**, not authoritative dates. The local `__drizzle_migrations` table copies
the journal's baked-in timestamps rather than real apply-time, so it cannot date this install's
upgrades either [P3].

**Key conclusion:** `0050` is the **last** migration present. Nothing is dated/ordered after it,
so **2.4.x → 2.5.1 introduced no database schema changes** — that era's work was CLI/client/UI
only, and is invisible to the migration-table artifact.

## 16. v2.5.1 CLI surface — delta vs the §4 (v2.3.5) record

§4 remains the authoritative v2.3.5 record. This section records the **v2.5.1 observed
surface** and the delta between them.

**Unchanged and still present** [P1/P3] — every verb anti-hall depends on still exists with the
same shape: `workspace list children|all [--tree]`, `workspace info`, `create <branch>
[-s -a -p -r -t]`, `update-title <title> [-b]`, `check-merge`, `merge-from-source`,
`merge-into-source`, `update-base [-w -y -s]`, `message-child`, `message-parent`,
`read-messages`, `message-count`, `monitor [-i -t]`; `repo configure|validate|refresh|find|
port-vars|worktree-include|scripts`; `health`; `open [path]`. JSON remains the unconditional
default; **still no `--json` flag anywhere**.

**Additions / changes observed in 2.5.1** (cannot be attributed to a specific intermediate
version — see §14):

| item | 2.3.5 record (§4) | 2.5.1 observed | provenance |
|---|---|---|---|
| `jira transitions [key]` | absent from §4.3's 14-leaf list | present | [P1] — flag as new-or-previously-missed, not confirmed new |
| `repo port-vars add` | `add <NAME>` | `add <name> <template>` (second arg) | [P1] |
| `repo scripts` | `set setup <cmd>` / `unset setup` (§4) | generic `get <key>` / `set <key> <value>` / `unset <key>`, key still constrained to `"setup"` in practice | [P1] |
| `repo worktree-include add` | `add <pattern>` | `add <pattern> "desc"` (description arg) | [P1] |

Other observations:
- **New env var `DEVSWARM_INVOKED_AS`**, set to `hivecontrol` by the shim [P2]. `hivecontrol`
  is a POSIX-sh shim doing `exec devswarm "$@"`; both `hivecontrol` and `devswarm` are the same
  16,629-line Commander.js JS bundle at `Contents/Resources/cli/devswarm`. Windows `.cmd`
  wrappers prefer `%DEVSWARM_BUN_PATH%` (bundled bun) over system node.
- **Hidden-command gating mechanism now identified** [P2]: `team` and `jira` (and `workspace
  search`) are registered via `program2.addCommand(x, {hidden:true})` and shown in `--help`
  only when `apiClient.getSubscriptionFeatures()` reports the matching feature (`features.team`
  / `features.jira`). They remain **fully parseable and runnable while hidden** — visibility ≠
  availability.
- **New CLI quirk, integration-relevant** [P3]: leaf-level `--help` **misfires and prints the
  root help** instead of the subcommand's own help. Reproduced for `repo
  configure|validate|refresh|find` and `workspace info|update-title|check-merge|
  merge-from-source|merge-into-source|update-base|message-child|message-parent|
  read-messages|message-count|monitor`. Group-level help (`repo --help`, `workspace --help`,
  `workspace list --help`) works correctly. **Consequence: `--help` is not a usable audit
  boundary for leaves** — flags must be recovered by grepping `.command(...)` registrations in
  the bundle. This compounds the §13 lesson about the audit boundary.

**Explicitly NOT changes — false-positive guards** (recorded so a future pass doesn't log a
phantom regression):
- The 2.5.1 CLI bundle references only 8 `DEVSWARM_*` vars (`AI_AGENT`, `BUILDER_ID`,
  `CLI_PORT`, `DEFAULT_BRANCH`, `INVOKED_AS`, `NO_AUTO_AUTH`, `REPO_ID`, `SOURCE_BRANCH`). The
  other vars §6 documents (`BUILDER_NAME`, `NAME`, `HTTP_PORT`, `SPAWNED`, `PARENT_PID`,
  `BUN_PATH`, `SHELL_READY_MARKER`) are set by the **Electron app into the shell env** and were
  never read by the CLI bundle itself — their absence from a CLI-bundle grep is **not evidence
  of removal**. Status: unverified either way; re-probe from inside a live workspace shell to
  confirm.
- `jira search` flags were **not** re-enumerated exhaustively in this pass; do not read a
  shorter 2.5.1 listing as a removal of `--jql`/`--fields`/`--next-page-token`. Unverified.
- `workspace_messages` schema (`fromBranch`, `toBranch`, `message`, `status`, `createdAt`)
  **matches** the message shape §8 documents anti-hall parsing against — that contract is
  intact.

## 17. Capabilities present but unused by anti-hall (for a future integration review)

Flagged as "not currently referenced in anti-hall doctrine" — no claim here about whether they
*should* be used, only that they exist and aren't wired in today:

- Multi-repo tables/feature (2.4.0 era; §15).
- `builders.isActive` / `lastSelectedAt` / `isPinned` / `builderType` / `pullRequestId` as
  native liveness+state signals.
- `builder_terminals` transcript-ingestion fields (`transcriptByteOffset`/`LineCount`/
  `ingestionStatus`).
- `repositories.defaultAiAgent`.
- `workspace update-base` as a CLI-native way to fix stale parent tracking.
- Team-gated `team metrics|members|workspace|session|conversation` observability.
- Team-gated `workspace search --explain`.
- The whole `jira` group.

Team/`jira` features are subscription-gated; **this install's entitlement status is
unverified.**

## 18. Official documentation coverage + positioning [P4]

- **Docs site https://docs.devswarm.ai/ is an Angular SPA**: every route returns the same
  1534-byte shell, so it is **not fetchable page-by-page**. All 30 pages' content is inlined in
  `https://docs.devswarm.ai/main.f735601b49d8ebae.js` (~1.1MB) as `{id, title, content}`
  search-index records. No `llms.txt`, no `sitemap.xml` (404), no public docs repo. **Record
  this as the method for any future doc pull**: fetch the hashed main JS bundle and parse the
  inlined search index, not the SPA routes.
- **The docs document only 3 of ~25 CLI commands (~12% coverage)**: `hivecontrol workspace
  create --agent <name>`, `devswarm repo port-vars add <NAME>`, `devswarm repo worktree-include
  add <PATH>`. Verified **zero** occurrences in the docs bundle of: the messaging verbs
  (`message-child`/`message-parent`/`read-messages`/`message-count`/`monitor`), `check-merge`,
  `merge-from-source`, `merge-into-source`, `update-base`, `health`, `open`, `workspace
  search`, `repo scripts`, the `team` group, the `jira` group.
- **Vendor positioning, quoted verbatim** (https://docs.devswarm.ai/hivecontrol/hivecontrol):
  *"HiveControl is the interface your AI assistant uses to orchestrate DevSwarm. … HiveControl
  is AI-facing. You do not operate it by hand."* And: *"Inside a workspace this is the
  `hivecontrol` command the assistant calls; you rarely run it yourself."* This **validates**
  anti-hall's own doctrine of driving the CLI from agents rather than by hand, and explains why
  no CLI reference page exists in the docs (only the 3 commands above appear, each inline in a
  feature walkthrough, not a reference table).
- **Three named orchestration patterns have dedicated docs pages**: **Plan-Do**, **Review
  Stack**, **Release Stack**. Flagged as worth reviewing against anti-hall's own orchestration
  doctrine (§8) — **not yet compared this pass**.
- **`--json` appears zero times in the entire docs bundle** — consistent with the verified
  binary behavior (§4, §16): JSON is the unconditional default, no flag exists. Any source
  (web or otherwise) claiming a `--json` flag is wrong.
- **Multi-Repo is documented as GUI-wizard-only**: Compose → Name → Confirm; right-click "Adopt
  as Multi-Repo" for an existing submodule parent. Each member is a worktree on its own branch;
  name collisions get a `-1` suffix; review fans the verdict out to each member repo's own PR.
  **No CLI surface for multi-repo is documented, and none is registered in the 2.5.1 binary**
  (see §19.2 below for the specific `delete-multi-repo` non-finding).
- **Pricing** (https://devswarm.ai/pricing/): Free / Pro $8 / Team $18 / Enterprise.
  Jira-to-workspace is listed under **Team**, consistent with the on-disk `features.jira`
  subscription gate (§4.4, §16).

## 19. Divergence log addendum (new findings this pass — §13 itself is untouched)

Continues §13's spirit of logging web-vs-local disagreements; recorded as a **new, separate**
section rather than an edit to §13, per this doc's own preserve-history rule.

1. **Jira: GUI read-only vs CLI read-write.** Docs state verbatim: *"The Jira integration
   provides read-only access. Update issues and add comments using your AI assistant or
   manually directly in Jira."* (https://docs.devswarm.ai/features-and-integrations/
   jira-integration). Yet the 2.5.1 CLI registers full write verbs: `jira create`, `update`,
   `transition`, `comment`, `assign`, `worklog add`, `versions create|update` (§4.3). **Verdict:**
   the read-only statement describes the GUI panel only, not the CLI — the CLI is
   write-capable. **Consequence:** an agent CAN mutate Jira through the CLI even though the
   docs describe the product as read-only; treat this as a real, doc-contradicted capability
   and a caution when reasoning about what an agent can/cannot do to a linked Jira project.
2. **`delete-multi-repo` is NOT a CLI verb — RESOLVED, not a gap.** It exists only as a
   Playwright/E2E `data-testid` selector string (`menu-item-delete-multi-repo`) inside a UI
   selector-constants block, alongside siblings like `remove-multi-repo-member` and
   `adopt-multi-repo`. There is **no** Commander registration, **no** `multi-repo` command
   group at all in the CLI, and **no** backing `apiClient` method. No guard pattern is needed
   for it and there is no CLI-reachable automated-deletion path here [P2].
3. **`.command(` grep false positives reaffirmed.** An exhaustive registration grep on the
   2.5.1 binary still surfaces `clone, start, stop, serve, watch, lint` as raw string matches;
   §13 already established these come from example code inside a JS **comment**, not real
   registrations. Re-confirmed this pass on the current binary — do not record them as verbs.
4. **"DevSwarm has no CLI" is now refuted by the vendor's *own docs*, not merely by running the
   binary.** §13 refuted the "no CLI" claim by execution; this pass found the vendor's own docs
   site shows `hivecontrol workspace create --agent` and `devswarm repo port-vars add`
   verbatim (§18), closing the loop — the vendor's own public site contradicts the "no CLI"
   claims made about it elsewhere on the web. Likely propagation source for the original wrong
   claim: https://devswarm.ai/features/ does not mention a CLI at all.
5. **Official GitHub org is a stub, and several look-alikes pollute search.**
   `github.com/devswarm-ai/devswarm` exists but its newest release is **v0.12.0 (Free Beta)** —
   not a usable changelog for the 2.x desktop app. `justrach/devswarm`,
   `The-Swarm-Corporation/DevSwarm`, `kyegomez/dev-swarm`, and `harsha-gouru/devswarm` are
   **unrelated** projects (consistent with §2's disambiguation table) that surface in generic
   searches. Recorded so a future pass doesn't mistake any of them for upstream release notes.

## 20. Falsified hypothesis — do not re-propose

**FALSIFIED:** adopting `builders.isActive` / `lastSelectedAt` / `lastAccessed` from the app's
own SQLite store (§15) as a native agent-liveness signal for anti-hall's supervisor. Evidence
[P3], from a read-only query of `~/Library/Application Support/DevSwarm/devswarm.db`:

- `isActive` is schema `integer DEFAULT 1 NOT NULL` and is **perfectly anti-correlated** with
  `isHidden`: 82 rows `isActive=0`/`isHidden=1` (i.e. archived), 5 rows `isActive=1`/
  `isHidden=0`. It means **"not archived"** and carries **zero** information about whether an
  agent session is actually running.
- 4 of the 5 `isActive=1` rows are repo-root `main`/`dev` **parent** rows, not live child
  sessions — the signal doesn't even cluster on the workspaces you'd expect.
- `lastSelectedAt` is UI click-focus, not activity: one row is stale by ~48 days while
  `isActive=1` on that same row.
- `lastAccessed` is useless as an activity signal: **all 87 rows** are stamped within ~1 second
  of each other, consistent with an app-startup sweep touching every row, not per-workspace use.

**Conclusion:** anti-hall's own heartbeat model (§8's supervisor doctrine, referenced in the
`anti-hall:devswarm` skill) measures a strictly different and better axis than any of these
three columns. **Do not adopt any of `isActive`/`lastSelectedAt`/`lastAccessed` as a liveness
signal. Do not re-propose this without new evidence that specifically addresses the three
anti-correlation/staleness/coarse-sweep findings above.**

## 21. anti-hall integration outcome of this pass

- **Defect found this pass (fix carried out by a parallel, separate task — not in this doc):**
  anti-hall's `command-guard.js` anchored its four DevSwarm destructive/messaging blocks (§8.5)
  on the literal verb `hivecontrol` only. Because `hivecontrol` is a 6-line `sh` shim that
  `exec`s the sibling `devswarm` binary (§16) — and `devswarm` is the **primary** binary name,
  equally present on `PATH` — the byte-identical `devswarm workspace
  monitor|read-messages|message-child|message-parent` forms were **not** blocked. Verified
  behaviorally: all four blocked under `hivecontrol`, all four allowed under `devswarm`, with
  DevSwarm active. Fix: make both invocation names equivalent via a shared verb set/alternation
  in the guard's matcher. This was a **latent pre-existing defect**, not a 2.5.1 regression —
  it existed as long as the guard anchored on one literal verb name while the binary always
  shipped two. The Codex port shares the same guard file (`codex/hooks/hooks.json` invokes the
  Claude-side `hooks/command-guard.js`), so the fix, once landed, covers both ports without a
  separate Codex change.
- **Standing gap, recorded so it isn't silently re-lost:** anti-hall still performs **no**
  `hivecontrol`/`devswarm` version probe anywhere in its own code. Every fact in this KB is
  therefore version-blind at runtime and must be **manually** re-verified after each DevSwarm
  update — nothing currently detects drift automatically.

---

All facts in §14–§21 were verified 2026-08-21 against the installed v2.5.1 build **plus the
vendor's public changelog (https://devswarm.ai/changelog/) and docs site
(https://docs.devswarm.ai/)** as of that date. Per the §13 convention, treat them as
**version-fragile** — re-verify against the then-current `hivecontrol --version`, a fresh
source grep, and the current state of the vendor's public changelog/docs before trusting them
past the next DevSwarm update.

## 22. v2.5.0 in-app chat — what it is, and why it is NOT an anti-hall-integrable surface

Vendor changelog (https://devswarm.ai/changelog/), v2.5.0, released 2026-08-14, quoted
verbatim: *"A real, richly formatted chat interface for the coding agents you already use,
built into every workspace's editor, with support for Claude, GitHub Copilot, and OpenAI
Codex"* — streamed responses, clickable permission prompts, tool-call cards.

**Two distinct surfaces share the "chat" name — do not conflate them:**

1. `GET`/`PUT /api/settings/rich-chat` on the local `hivecontrol` HTTP server — a **boolean
   UI-preference toggle** backed by `RichChatPreferenceService` (`main.js:61072-61103`),
   persisted through the app's generic settings store. No dedicated table, no message content.
2. The actual chat feature — `WorkspaceChatService` (`main.js:73873`/`73879`),
   `CloudSyncService.sendChatMessage` (`main.js:24202`), IPC handlers in
   `workspace-chat.handlers.ts` (`main.js:15422`).

**The real chat is cloud-relayed, not local** [verified: static bundle inspection]:
- History is fetched over REST: `${apiUrl}/workspaces/${builderCloudId}/chat/messages?
  before=...` (`main.js:73888`), authenticated via `AuthService.getSession()`.
- Sends go over a multiplexed WebSocket channel named `workspace-chat:<builderCloudId>`
  (`main.js:24202-24212`).
- Neither path touches `localhost`/the local `hivecontrol` API port (§6's
  `DEVSWARM_CLI_PORT`) — chat traffic never crosses the boundary anti-hall's guards or the
  ingest daemon can see.

**Zero local persistence, zero CLI surface:**
- The local app DB has 23 tables (per §15's migration-journal enumeration through `0050`);
  none are chat-related, and 2.4.x→2.5.1 shipped **no schema changes** (§15) — consistent with
  chat having no local table.
- None of the 67 registered `.command(` verbs (§4, §16) touch chat in any form.

**Chat and `workspace_messages` are parallel, unrelated systems** — do not describe chat as
having replaced or subsuming anti-hall's mesh, or the app's own parent/child messaging:
- `CloudSyncService`'s own source comment (`main.js:24031`): *"Replaces WorkspaceChatService +
  PromptSyncService with a single WebSocket connection... channels: `workspace-chat:<id>` for
  chat, `prompt-sync:<id>` for prompt sync."* — chat and prompt-sync are named as **distinct**
  channels.
- Chat does **not** flow into `builder_transcript_prompts`; that table is fed only by the
  separate `CLOUD_SYNC.SUBMIT_PROMPTS` handler (`main.js:10831`) and holds 0 rows on the
  install sampled this session.
- IPC namespaces are distinct: `IpcEvents.WORKSPACE_CHAT` (`GET_HISTORY` only) vs
  `IpcEvents.WORKSPACE_MESSAGE` (`SENT`), registered near `main.js:83908`. No code path
  connects them.

**Adversarial refutation attempted on two angles — both failed to find hidden local state:**
- (A) No chat strings anywhere in Electron `Local Storage/leveldb`, `Session Storage`, or
  `IndexedDB` (`grep -riE 'chat.?message|workspace-chat|chatHistory'` → zero hits); no second
  `.db`/`.sqlite` file; DevSwarm's own log, `grep -ic chat` → 0.
- (B) Confirmed chat does not reach `builder_transcript_prompts` (0 rows, as above).

**Not checked — recorded honestly as a gap, not silently folded into "verified":**
- Contents of `sentry/queue/queue-v2.json` were not inspected.
- Whether a **live** chat send transiently touches `Session Storage`/`blob_storage` before
  garbage collection was not tested — only a static-file grep of the on-disk leveldb was
  performed, not a live-send + immediate-snapshot experiment.

**Nothing destructive:** the chat IPC surface exposes only `GET_HISTORY`; no delete/clear/purge
verb exists for chat in the CLI, IPC, or the local HTTP surface (`/api/settings/rich-chat` is a
boolean toggle, not a data-mutating endpoint). **No new command-guard coverage is required for
chat.**

**Security-relevant observation to state plainly:** because chat carries clickable permission
prompts and tool-call cards, it is a **full agent-driving surface** — a human or another
process can approve tool calls and steer an agent through it — that operates entirely outside
any channel anti-hall's guards, the ingest daemon, or the mesh store can observe or gate. This
is a genuine blind spot, not a hypothetical one: it is cloud-relayed (not localhost), so even a
future local-port-based guard could not see it.

**Conclusion:** the 2.5.0 chat feature is **not integrable** with anti-hall's current
architecture (local CLI/file/HTTP-port observation) because it has no local persistence, no CLI
verb, and no local network path — it exists solely as a cloud WebSocket/REST relay between the
Electron renderer and the vendor's backend.

## 23. Chat is undocumented by the vendor

The public docs site (docs.devswarm.ai) — extracted per the method in §18/§25 — contains
**exactly one** case-insensitive `chat` hit across the entire bundle
(main.\<hash\>.js, ~1,116,532 bytes), and it is a Zod schema **field name** (`chatMessages`)
inside a session-transcript type, not documentation prose describing the chat feature.

- All 29 documented routes were enumerated from the bundle's search index (§18's method);
  **none** is chat-related.
- Phrase probes for `"tool-call card"`, `"streamed response"`, and `"richly-formatted"` each
  returned **0 hits**.
- The vendor also documents **no `--version` guidance for its own CLI**: `"hivecontrol --"` and
  `"devswarm --"` both return 0 hits in the docs bundle; the only `--version` mention anywhere
  is `git --version`, in the Troubleshooting page. **Consequence for anti-hall:** any future
  version-parsing anti-hall implements (the §21 "standing gap") would rely on an output shape
  the vendor has never documented or promised to keep stable.

## 24. `transcriptByteOffset` — a real agent-liveness signal (resolves the long-standing open question)

§17 flagged `builder_terminals.transcriptByteOffset`/`transcriptLineCount` as an unused,
unverified capability; §20 separately falsified the *app's own* `isActive`/`lastSelectedAt`/
`lastAccessed` columns as liveness signals. This section resolves `transcriptByteOffset`
specifically, from code, without needing a live experiment.

- `updateTranscriptProgress()` (~`main.js:25580`) is called from the polling loop
  `pollTick()` (`main.js:73216`).
- It `stat()`s the size of the **local Claude CLI JSONL transcript file** — either
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` or the subagent form
  `.../subagents/agent-<id>.jsonl` — compares `fileSize <= transcript.transcriptByteOffset`,
  and only fires ready-events / advances the stored offset when the **on-disk file grew**.
- **Therefore it is a genuine local agent-liveness signal**, driven purely by agent output,
  resolved from code [verified: `main.js:25580`, `main.js:73216`].

**Caveat — proven from code, not observed in data this session:** in the install sampled, all
179 `builder_terminals` rows and all 98 `builder_terminal_transcripts` rows had
`transcriptByteOffset`/`transcriptLineCount` = 0, so no advancement was **observed** in that
data snapshot. State both facts distinctly: the mechanism is **proven from code**; a live
**observed** delta remains **unverified**.

**Bearing on the previously-open T4 experiment:** T4 no longer requires spinning a throwaway
workspace to answer the code-level question ("is `transcriptByteOffset` driven by real agent
activity?" — yes, per the code above). Observing a live delta in the stored rows — i.e.
confirming the mechanism actually *fires* in practice, not just that it *would* — remains
unverified and would still require a live workspace to close.

## 25. Correction, recorded so it does not happen a third time: the vendor DOES have a full docs site

The vendor has a complete docs site at docs.devswarm.ai. It is an **Angular SPA** — every route
returns the same small shell HTML (404-equivalent for content purposes when fetched directly),
which has twice now caused a wrong "no docs exist" conclusion in earlier passes over this
project. §18 already recorded the correct extraction method for that pass; this section
restates it explicitly as the standing procedure so a future session doesn't repeat the
mistake a third time:

1. **Do not fetch SPA routes directly** (e.g. `https://docs.devswarm.ai/hivecontrol/hivecontrol`)
   — they return the app shell, not content, and will look like "no docs."
2. **Fetch the hashed main JS bundle instead** — `https://docs.devswarm.ai/main.<hash>.js`
   (~1.1 MB as of this session, hash rotates per deploy; discover it from the shell HTML's
   `<script>` tag).
3. **Parse the inlined search-index records** — the bundle embeds `{id, title, content}`
   objects for every doc page; grep/parse those objects rather than treating the bundle as
   opaque minified JS.
4. There is no `llms.txt` and no `sitemap.xml` (404) to shortcut this — the bundle-parse is the
   only path to the real content.

---

Section §22–§25 facts were verified 2026-08-21, same session as §14–§21, against the installed
v2.5.1 build, the vendor's public changelog (https://devswarm.ai/changelog/), and the docs
bundle (https://docs.devswarm.ai/) as of that date. Per the §13 convention, treat them as
**version-fragile** — re-verify against the then-current build and a fresh docs-bundle pull
before trusting them past the next DevSwarm update.

## 26. Two deliberately different meanings of "live" for a registry row — a trap for future folding work

anti-hall now carries **two distinct "live" predicates** over the same registry row shape, on
purpose, with different consumers. Anyone touching either path must know this split exists
before "unifying" them, because unifying is a destructive-capability change, not a cleanup.

- **`isLiveSessionId(sessionId)`** (`plugins/anti-hall/scripts/devswarm.js:231-236`) — true iff
  the sessionId is non-null, non-empty, and not prefixed `unclaimed:` (the
  `SYNTHETIC_SESSION_PREFIX` sentinel, `devswarm.js:230`). This remains the **single source of
  truth for routing and fold decisions**: `resolveMeshTarget`, `pickSurvivor`,
  `groupRegistryByMeshId` (which derives `liveRows`/`kind`/`split`/`deadSplit`/`mixedSplit`),
  `rehomeMiskeyedRow`, `retireWorktreeDuplicates`, `foldGroupIntoSurvivor` all still gate on
  this predicate alone. Unchanged by this work.

- **`computeDiagnosis`'s `rows[].live`** (`devswarm.js:5489`, row construction at
  `devswarm.js:5580-5595`, `phantoms` count at `devswarm.js:5597`) — a **heartbeat-aware,
  display-only** derivation as of v0.81.0: `live` is `true` immediately on a fresh heartbeat
  (`hasFreshHeartbeat`, `devswarm.js:5583`); otherwise, only when `isLiveSessionId(sid)` also
  holds, it defers to `!isDormantRow(...)` (`devswarm.js:5586`, both from
  `plugins/anti-hall/companion/lib/liveness.js`); on any exception it falls back to
  `isLiveSessionId(sid)` alone (`devswarm.js:5587`). This feeds only `diagnose`/`healthcheck`
  output and the `phantoms` count (`rows.filter((r) => !r.live).length`,
  `devswarm.js:5597`) — it does **not** feed any fold path, and the `degraded` gate does not
  read `phantoms` (`devswarm.js:5635` doc comment states this explicitly).

**Why they differ, by design:** a bare non-empty sessionId is not proof of life — closing a
workspace never deletes its registry row, so a once-real sessionId is trusted forever under
`isLiveSessionId` alone. Making the *fold* path heartbeat-aware would newly classify some rows
as dead, which can newly **permit** a fold/tombstone that previously would not have happened.
The repo's fail-closed convention means only the *display* path was made heartbeat-aware; the
fold path was deliberately left on the older, more conservative predicate.

**Consequence to warn about:** `diagnose`/`healthcheck` can now correctly report a row as dead
(fresh heartbeat absent, dormant) while the fold path still treats that same row as alive and
routable. This mismatch is intended and current behavior, not a bug. A future change that makes
the fold path consume `rows[].live` (or `hasFreshHeartbeat`/`isDormantRow` directly) must be
treated as a new destructive-capability surface requiring its own hardening pass — never folded
in as an incidental cleanup alongside a display fix.

**Field symptoms this display fix resolved** (shapes only, not this machine's concrete data):
a closed workspace's row reporting live forever under the old sessionId-only display check; a
running workspace whose row had a null/empty sessionId reporting dead despite an active
heartbeat; and an `unclaimed:`-prefixed placeholder row with a fresh heartbeat reporting dead
under the old check, when the workspace behind it was in fact live.

**Two smaller, adjacent facts recorded here rather than a new section:**

- `lastCompletedHash` in `~/.anti-hall/update-sweep-state.json` is written at three call sites
  in the sweep-state updater (`plugins/anti-hall/skills/update/scripts/update.js:660`,
  `:665`, `:669`) and is **read nowhere** — it is observability-only by design (documented
  in the doc comment at `update.js:639-647`). `pendingHashes`, read back at
  `update.js:621-622`, is the sole authoritative resume list. `lastCompletedHash` looks like a
  resume cursor and is not one — do not wire new resume logic off it without first checking
  whether it is still unread.
- The update sweep's store enumeration is ordered smallest-disk-size-first as of v0.81.0
  (`orderStoreHashesBySize`, `plugins/anti-hall/skills/update/scripts/update.js`, doc comment
  above the function). Previously it walked stores in raw `fs.readdirSync` order, which has no
  relationship to per-store processing cost — one large store could consume the entire
  wall-clock sweep budget every run, starving smaller stores that sat later in that same stable
  readdir order. Sizing is a cheap (stat-only, single-digit ms for hundreds of stores),
  fail-open proxy: a size-read error scores 0 and never throws or reorders on partial failure.

**v0.96.0 (D11) additions, recorded here rather than as new sections:**

- Routing splits further under this same isLiveSessionId/rows[].live divide (defect
  f56dcc08f048): `resolveMeshTarget`/`pickSurvivor`'s target-selection gate is now
  `isRoutingLiveRowStrict` (`devswarm.js` ~:299-324) — a bare, no-descriptor-fallback
  `isSiblingPartitionLive` call, the SAME heartbeat-freshness + harness-session-dormancy
  predicate `siblingAckGate` and the fold's own mesh-anchor check already use — replacing the
  bare `isLiveSessionId` shape test those two call sites used before, so a real-but-dormant
  sessionId can no longer outrank a genuinely live sibling for a `send`/fold target.
  `groupRegistryByMeshId`'s REPORTING-only `liveRows` counter (~:326-353) uses the
  fallback-inclusive `isRoutingLiveRow` instead — `isSiblingPartitionLive` OR a matching
  descriptor file exists, so a just-registered row with no heartbeat yet is not miscounted as
  dead. `rehomeMiskeyedRow`, `retireWorktreeDuplicates`, and `foldGroupIntoSurvivor` are
  DELIBERATELY untouched and still gate on bare `isLiveSessionId` alone — see
  `rehomeMiskeyedRow`'s own D11-A scope-note doc comment (`devswarm.js` ~:1870) for why: an
  IDENTITY-match question (is this row the same entity a descriptor describes), not a
  drain/routing decision, so gating it on current liveness would refuse a legitimate heal for a
  merely-idle workspace.
- `callerOwnsRow`'s clause 3 ("sole registered row on the caller's own resolved worktree",
  `devswarm.js` ~:5158-5206) now additionally requires that sole row be UNCLAIMED (empty or
  `unclaimed:`-prefixed sessionId) before granting ownership. Previously ANY lone same-worktree
  row satisfied clause 3, including a genuinely different CLAIMED session sharing the caller's
  worktree — letting an unrelated caller stamp its own sessionId over a foreign, already-owned
  row.
- The sibling-watermark write (`writeSiblingSeenCursor`, the read-primary not-ackable branch)
  and its read-then-conditional-unlink (`readSiblingSeenCursor`/`removeSiblingSeenCursor`) now
  serialize under one per-`(callerId,siblingId)` lock (`withWatermarkLock`, `devswarm.js`
  ~:892-919, reusing `withIdLock`) — closing a TOCTOU window where a concurrent write for the
  SAME pair landing in the read→unlink gap was silently discarded when the unlink fired.
  Fail-open on contention/unsafe ids: runs unlocked rather than dropping the operation, matching
  `withIdLock`'s own posture.
- `send` and `heartbeat` results, plus every ownership-refusal shape (`inbox ack`, read-primary,
  heartbeat broadcast), now carry an additive `identity: {id, kind}` alongside the existing bare
  identity string (`callerIdentityDetailed`, `devswarm.js` ~:516-533) — `kind` is `resolved`
  (cwd matched a real git worktree, independently-verifiable ground truth), `declared` (no
  worktree ground truth, but a `DEVSWARM_BUILDER_ID` env value was trusted), or `unresolvable`
  (raw-cwd-hash fallback — no verifiable ground truth at all).
- `diagnose` rows carry an additive `archivedInApp` field (D11-C, `devswarm.js` ~:10260-10293)
  and force `live:false` whenever it is true, even against a fresh heartbeat — the app-side
  absence signal (§37) now overrides the display-only liveness computation for this one case.
- `reconcile`'s pre-spawn skip gained a fifth benign-skip reason, `skippedNotGitRoot` (D11-C,
  defect 6ef55fd42cc9): a worktree that exists on disk but fails
  `git rev-parse --show-toplevel` is skipped before ever reaching the spawned child, same
  zero-budget-cost posture as the pre-existing missing-worktree skip. As of v0.96.0 (D11-C2),
  the git-root probe itself is now bounded by `reconcile`'s own wall-clock budget — checked
  BEFORE the probe runs, not only before the resulting spawn — so N broken worktrees can no
  longer each burn a full probe timeout unaccounted-for before the first row is deferred.
- `update.js` now applies ONE overall wall-clock budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`,
  default 90000ms; 0 = unlimited) across every post-pull DevSwarm stage combined (reconcile
  through heal-registry-rows), checked before each stage starts (`postPullBudgetMs`,
  `update.js` ~:469-494). A stage that would start past the deadline is deferred WHOLE and
  reported as `deferred:true`, picked up on the next `update`/`doctor` call rather than lost —
  every deferred stage is independently idempotent/resumable (fold/heal/fold-archived-rows
  persist their own resume markers; one-time-per-version stages simply re-attempt). As of
  v0.96.1, the periodic supervisor sweep (`companion/devswarm-supervisor.js`) closes this gap:
  alongside its own `reconcile`/single-project-fold cooldown, `deferredSweepIfDue` peeks each
  stage's own persisted marker (`hasDeferredWork`) and, when one shows real pending work, runs
  ONE of `fold-all-stores` / `heal-orphan-partitions` / `fold-archived-rows` per supervisor pass
  — rotating forward across a persisted cursor (`<home>/.anti-hall/devswarm/deferred-sweep-
  state.json`) regardless of outcome, so a no-op tick still advances to the next stage. Each
  run is capped by `ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS` (default 20000ms), threaded into the
  same `ANTIHALL_UPDATE_SWEEP_BUDGET_MS` knob `update.js`'s own sweeps read. The supervisor's
  JSON line now carries an additive `deferredSweep: {stage, ran, ...}` field reporting which
  stage was checked/run each pass.
- `inbox ack` now refuses the whole verb on a POSITIVE, resolvable ownership mismatch (the
  caller's own cwd/env resolves to a REAL, different registered row) rather than the previous
  half-ack (NDJSON drained, store cursor silently skipped, `ok:true`) — `--ack-as-owner` still
  overrides. Deliberately NOT extended to an unresolvable-caller-identity or a caller with no
  registered row of its own: those callers still fail open (ack proceeds) exactly as before,
  since neither shape is a cross-workspace hazard, only the ordinary "ran `inbox ack` from a
  bare shell with no matching worktree" case.

---

Section §26 facts were verified 2026-08-23 from source at the versions on disk in this repo
checkout (not a live DevSwarm capture). Per the §13 convention, the `isLiveSessionId` /
`rows[].live` split and the update-sweep facts are anti-hall's own code, not the vendor's, so
they do not carry the same version-fragility caveat as vendor-behavior sections — but line
numbers will drift with future edits to `devswarm.js` and `update.js`; re-grep the cited
function/symbol names rather than trusting the line numbers verbatim after either file changes.

## 27. Asymmetric partition resolution — the shape that caused a message-delivery P0

One logical mesh id can legitimately have TWO registry rows for the same worktree: the host
tool's own workspace UUID (`DEVSWARM_BUILDER_ID`) and anti-hall's own derived
`primary-<8hex>` id (sha256 of the canonical worktree real path,
`primaryWorkspaceId(wt)` at `plugins/anti-hall/companion/install-devswarm-ingest.js:550`).
Both are valid rows for the same logical Primary; §26's own citation of
`devswarm-identity-family.js` documents that two descriptors may legitimately share one
`worktreePath` (`plugins/anti-hall/companion/lib/devswarm-identity-family.js:7`).

**The asymmetry that broke delivery.** `send` resolved the target group DYNAMICALLY —
`resolveMeshTarget` (`plugins/anti-hall/scripts/devswarm.js:5060`) delegates to
`pickFreshestLive`, so a message could land on whichever of the two rows was currently
freshest/live. The Primary's OWN read, by contrast, resolved STATICALLY: `readOwnUnread`
computes `id = installIngest.primaryWorkspaceId(top)` (`plugins/anti-hall/hooks/devswarm-parent-gate.js:318`)
and that fixed derived id feeds every downstream lookup for that read — never re-resolved
through `resolveMeshTarget`/`pickFreshestLive` the way sending was. A message delivered to
the sibling row (the builder-id row) was therefore structurally invisible to a Primary that
only ever read its own derived-id row.

**The fix did not need new knowledge — it needed to USE knowledge that already existed.**
`canonicalMeshId`/`groupRegistryByMeshId` (`plugins/anti-hall/scripts/devswarm.js:202`
region) already treat both rows as one target — a diagnose pass reports one `meshTargets`
entry covering both ids. That grouping was already correct; the read path simply never
consulted it. The reconciler that would MERGE the two rows into one survivor
(`foldMeshDuplicates`) only ever runs at update/doctor time, not on every read — so between
reconciliation passes, the split is normal, expected, and must be tolerated by any reader.

Fixed in v0.82.0 by widening the READ to cover every partition in the mesh group, not by
folding the rows. Read-side only: no fold, no survivor selection, no row retired — the same
conservative posture §26 already established for the `isLiveSessionId` split (making a read
path smarter must never itself become a destructive-capability change).

**Duplicates across partitions are schema-impossible, not merely rare.** `meshMessageHash`
includes the RECIPIENT in its hash input, and the `messages` table carries a store-wide
`UNIQUE(hash)` constraint — single-column, not composite with `workspace_id`
(`plugins/anti-hall/companion/lib/devswarm-store.js:414`). Consequence: the same logical
message routed to two different partitions produces two DIFFERENT hashes, and two rows
sharing one hash cannot coexist in the table at all. Cross-partition duplicate content is
therefore impossible by construction, and no content-level suppression/dedupe is needed when
merging reads across partitions. Recorded because a forensic pass this session wasted effort
searching for a source-partition message's hash inside a destination partition and wrongly
concluded messages had been lost — the hash was never expected to match across partitions in
the first place.

**Design rule adopted: at-least-once beats at-most-once.** Wherever two rows cannot be
PROVEN to be the same message, deliver both rather than risk suppressing one. A visible
duplicate is recoverable; a silently dropped message is neither detectable nor recoverable.
Correspondingly, a read cursor may never advance past a message that was not actually
delivered to the caller — enforced structurally by deriving the cursor from
`cursor + deliveredCount` (what was actually returned), never from a partition-wide total.

**A global counter is not evidence of loss.** `seq` is a single GLOBAL, table-wide counter
(`SELECT COALESCE(MAX(seq),0)+1 FROM messages`, no `WHERE` clause) shared across every
recipient, every broadcast, and every heartbeat row in the store. A `seq` gap observed
between two sends to ONE recipient is therefore NOT evidence that a message addressed to
that recipient was lost — other traffic in the shared counter fills the gap. Recorded
because a field report this session drew exactly that wrong inference from a `seq` gap.

**A review lens worth reusing, surfaced repeatedly this session:** *"does this operation
report success while dropping part of the job?"* Six independent instances of that exact
shape turned up in one review pass: a reconcile step masking a real error as `unknown`; an
`ok:true` result returned with no verification that the message actually arrived; a cursor
write failure that was silently swallowed instead of surfacing; a registry-enumeration
failure that silently narrowed a group instead of failing loud; an unknown CLI flag accepted
silently while writing an empty field instead of rejecting it; and a count that unioned two
channels while the corresponding read still consulted only one. None of the six were fixed
by pattern-matching a rule — each required tracing what the operation's REPORTED outcome
implied versus what it actually did.

---

Section §27 facts were verified 2026-08-23 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — no version-fragility caveat applies,
but re-grep the cited function/symbol names rather than trusting line numbers verbatim after
either file changes further).

## 28. "Success while dropping part of the job" — a recurring defect shape, and the review lens for it

Seven independent instances of the same defect shape turned up in a single review session,
all verified from source. None were found by the (green) test suite; every one was caught by
adversarial review reading the code, not by running it.

1. A reconcile step masking a real per-target error as `unknown error`.
2. An `ok:true` result returned from a send with no verification that the message actually
   arrived — a prior "fix" for this had added echo fields to the response without adding
   arrival verification, so the shape persisted under a response that looked more complete.
3. A swallowed store-side cursor-write failure inside `cmdInboxMessages`.
4. A registry-enumeration failure silently narrowing a mesh group while still reporting
   totals as if the group were complete.
5. The defect CLI (`plugins/anti-hall/scripts/defect.js`) accepting an unknown `--x-file`-shaped
   flag, dropping its value, and exiting 0. Fixed: `checkFlags` now rejects any unrecognized
   flag for a subcommand outright (`defect.js:115-148`) — nothing is written when an unknown
   flag is present, matching the CLI's stated contract in `plugins/anti-hall/README.md`.
6. `inbox count` unioning two channels (durable NDJSON inbox + store partition, via
   `unionUnread` in `plugins/anti-hall/companion/lib/devswarm-unread.js:129` region) while
   `peek-primary`/`read-primary` read only one channel — unread count and visible mailbox
   could disagree. (This is the same shape as, but a distinct instance from, §27's asymmetric
   partition read — that one was two REGISTRY ROWS for one Primary; this one is two CHANNELS
   for one row.)
7. The plain `inbox ack` verb (`cmdInboxMessages`'s ack path, `plugins/anti-hall/scripts/devswarm.js`
   near line 4103) swallowing a store-side cursor-write failure behind a bare `ok:true`. Fixed
   under defect `c35a7ca3056b`: the NDJSON ack still succeeds and is NOT rolled back (fail-open
   on delivery — re-serving an already-acked message as unread again is the safe direction),
   but the store-cursor failure is now captured and surfaced as `cursorWriteFailures`
   (`{partitionId, channel:'store-cursor', error}`) + `cursorPersisted:false` on the ack
   response, reusing the exact field shape `cmdInboxMessages`'s read path already used —
   one convention for "this read/ack was partial," not two.

**The review lens to reuse:** *does this operation report success while dropping part of the
job?* Apply it specifically to any code path that (a) has a fail-open `catch`, (b) merges or
unions two sources (two channels, two registry rows, two partitions), or (c) returns a bare
`{ok:true}` with no field distinguishing "fully done" from "partially done."

**Two index spaces, one subtraction — the v0.83.0 P0.** The NDJSON∪store union above
(`devswarm-unread.js:129` region) filters store rows down to what the CALLER receives; a
separate read cap then counted rows WITHHELD BY THAT CAP in the same filtered space; the ack
path subtracted that withheld count from the RAW, unfiltered `storeHandle.messageCount(id)`.
Because the subtraction was performed against the wrong (raw) space, the resulting cursor
could advance past a message that was never actually delivered to the caller — a permanent,
undetectable message loss for that recipient. Fix: derive the ack target strictly from the
`.index` of a row the caller actually received — `Math.max(cursor, ownDeliveredMaxIndex)` —
never by subtracting a filtered-space count from a raw-space total. This generalizes §27's
"design rule adopted" (cursor derived from `cursor + deliveredCount`, never a partition-wide
total): the same rule, restated for a THIRD instance of two mismatched counting spaces.

**A green suite is not evidence for delivery/cursor code.** 3472 tests passed over that
permanent message-loss bug before it was found. Of the defects introduced by the FIXES made
in that same session, three were caught, and all three were caught by adversarial review on a
frozen tree — none by the test suite. For any code path that advances a cursor or decides
message delivery, treat "tests are green" as necessary but explicitly insufficient; budget a
dedicated review pass on a tree that is not still moving underneath it.

**Heredoc bodies are not commands.** A shell-command guard that classifies risk by splitting
input on newlines will misclassify heredoc BODY lines as standalone commands. A commit
message whose body happened to contain the literal text `graphify update ...` (quoting a KB
fact, not invoking anything) was blocked as if it were itself a live invocation of a
throttle-required command. The correct behavior: keep the heredoc's OPENER line in the
command segment it belongs to, and skip everything between opener and closing delimiter when
splitting for command classification.

**`DEVSWARM_SOURCE_BRANCH` is the only child-workspace signal**, consumed by both
`command-guard.js` and (as of this session) `graphify-guard.js`. It is a plain environment
variable, which means it can in principle leak into (be inherited by) a Primary's own
process — a pre-existing, accepted risk that is now shared by two independent hard blocks
instead of one.

**The parent gate and the drain verb disagreed about store scope** (filed as defect
`e586afdaa968`; **RESOLVED in v0.84.0** — see §29). The parent gate's neglect check reads
ACROSS stores (multi-store aware); the prescribed remediation, `inbox read-primary`, used to
resolve its target repo key from the CURRENT WORKING DIRECTORY (single-store, CWD-scoped).
Consequence, before the fix: a Primary could be escalated at — and, unresolved, eventually
escalated to a human about — a workspace it structurally could not drain by running the
gate's own prescribed command from its own directory, and running that command from the
wrong directory risked writing a cursor into the wrong store partition entirely. Both sides
now resolve through the SAME shared helper (§29).

---

Section §28 facts were verified 2026-08-23 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — no version-fragility caveat applies,
but re-grep the cited function/symbol names rather than trusting line numbers verbatim after
either file changes further).

## 29. Partition resolution is the WORKSPACE's property, not the caller's (v0.84.0)

**The rule.** Which store partition a workspace's mail lives in is a property of THAT
WORKSPACE's registration, never of the directory a command happened to be typed in. Both
the CLI (`scripts/devswarm.js`) and the Stop hook (`hooks/devswarm-parent-gate.js`) now
answer that question through one shared helper — `registeredRepoKey(descriptor, id, opts)`
in `plugins/anti-hall/companion/lib/devswarm-repokey.js` — with a fixed precedence:

1. the freshly-resolvable `repoKey` for the descriptor's worktree, then
2. the descriptor's recorded `repoKey`, then
3. a non-hash `ownerKey` (a legacy 8-hex bucket key is NOT accepted as a project key).

Because there is exactly one implementation, the gate and the verb it prescribes can no
longer disagree about which workspaces a session owns — the class of bug §28's tail recorded
as open.

**Guard-before-mutate is the load-bearing ordering.** `gate`, `ensure`, and `archive` each
performed a re-home of the target workspace (copying messages and registry rows into the
caller's partition and rewriting `ownerKey`) BEFORE running their own ownership guard. The
mutation therefore happened even on invocations that went on to return `ok:false`, and
`archive` had additionally removed the live descriptor by then. A refused cross-project call
must write NOTHING; the ownership decision now precedes every write. Generalized lesson: an
ownership guard placed after a self-heal is not a guard — the self-heal IS the damage.

**A refused read may not advance a cursor.** `inbox ack <foreign-id>` advanced the NDJSON
cursor after the resolver had already refused, permanently stepping over mail nobody had
read. This is the same invariant §27 states from the delivery side ("a read cursor may never
advance past a message that was not actually delivered to the caller"), reached from the
authorization side: a call that did not read may not acknowledge.

**Honest failure over a silent zero.** `inbox count`/`inbox read` used to return `0` when
the caller's project did not match the workspace's — indistinguishable from "no mail". They
now return `known:false` alongside the NAMED `registeredRepoKey` and `callerRepoKey`, so the
reader can tell "I cannot see this from here" from "there is nothing here". Same lens as
§28: a result shape that cannot express the failure is how a dropped job reports success.

**Archived partitions nothing can ever read must not warn.** `computeSummary`'s A2 pass
surfaced `orphans[]` (real unread, no live registry row) and the parent-inbox hook rendered
it every turn. For a workspace deliberately ARCHIVED with no live identity-family survivor,
that warning is unactionable BY CONSTRUCTION: `healOrphanPartitions` classifies exactly that
shape as `unhealable / archived-no-family` and deliberately writes nothing — there is no
survivor to forward into and re-adopting an archived id would recreate the very row
`foldArchivedRegistryRows` exists to tombstone. The unread can never drain, so the id could
never leave the warning set (12 partitions, in one real store, warning on every turn).

`companion/lib/devswarm-orphan-policy.js` (`makeArchivedStrandedTest`) excludes exactly that
set. Three properties make it safe to trust:

- **It does not re-implement the rule.** It CALLS heal's own exported helpers
  (`hasArchivedCounterpart`, `readDescriptorFile`, `archivedDir`, `canonicalMeshId`,
  `groupRegistryByMeshId`) in the same order heal's archived branch does.
- **Drift is a CI failure.** `tests/companion/devswarm-orphan-policy-equivalence.test.js`
  drives this module and `healOrphanPartitions({dryRun:true})` over the same fixtures and
  asserts the id sets are IDENTICAL.
- **It fails open and never drops the count.** Any failure yields "not archived-stranded",
  i.e. the id stays in `orphans[]` (pre-fix behavior); and the excluded ids are moved into a
  quiet `archivedStranded[]` on the summary, not discarded.

The `require` back into `scripts/devswarm.js` is LAZY (inside the classifier, on first
candidate) because `devswarm-store.js` is required BY `devswarm.js` — a top-level require
would close a cycle, and the lazy one is paid only when a store actually has an unread
orphan candidate.

---

Section §29 facts were verified 2026-08-23 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — re-grep the cited function/symbol
names rather than trusting line numbers verbatim after either file changes further).

---

## 30. A historical identity link is not write authority (v0.85.0)

**The defect this section generalizes.** `cmdArchive` retired exactly one descriptor per
archive, keyed by `<id>`. A DevSwarm workspace can be registered under two ids whose
identity family is cross-linked by `sessionId` rather than by `id` — one row's `sessionId`
IS the other row's `id` (the builder-UUID row / slug row pair). Archiving one left the
twin live in `workspaces/`, and `hooks/devswarm-parent-gate.js` then blocked every Primary
turn on the missing inbox file of a workspace that by construction could never produce one.
Verified against a real install: `archived/fb-…-a55f20ef.json` (`sessionId` `8f3d585d-…`)
sitting beside a LIVE `workspaces/8f3d585d-….json`.

**The rule.** *A one-way historical identity link is NOT, by itself, authority to retire a
descriptor.* Knowing that row A once named the same identity as row B tells you about the
past. Retiring B is a write against B's CURRENT state, and that write needs authority
proven at the moment it happens, inside the same lock that serializes it. Three concrete
ways the first pass violated it, each of which could have deleted a LIVE descriptor:

1. **Stale pre-lock classification.** A twin classified during the scan can be replaced by
   a fresh atomic rename before the retire actually runs.
2. **A race with a non-locking writer.** `hooks/devswarm-child-turn.js` publishes a
   descriptor by `rename` and took no lock, so it could install a brand-new live descriptor
   at that pathname between classification and `unlink`.
3. **A reused id.** An old `archived/<id>.json` tombstone was accepted as authority over a
   completely unrelated, newly-registered live descriptor that happened to take the id.

**Why pathname identity is not enough.** Every descriptor writer in this tree publishes via
`writeFileSync(tmp) + renameSync(tmp, path)` — an ATOMIC REPLACE, which allocates a NEW
INODE at the SAME pathname. Node has no unlink-by-inode, so an inode check followed by an
`unlink(path)` is only atomic if BOTH writers hold the same lock. Fingerprinting on the
retirement side alone cannot close it.

**What proving authority looks like here.**

- `descriptorFileGeneration(p)` reads inode identity AND exact bytes as ONE coherent
  `lstat`+read, and `sameDescriptorGeneration(a, b)` fails closed when either side is
  absent. The generation is re-read INSIDE `withIdLock(<id>)` and compared against the
  scan-time snapshot; a rename changes `ino` even for byte-identical content, so a
  same-content re-registration is caught too.
- `devswarm-child-turn.js` now takes that same per-id advisory lock around its rename —
  bounded (~1s non-blocking retry), fail-open, exactly one lock over mkdir+write+rename,
  no nested acquisition, no subprocess.
- `worktreeIsProvablyGone(worktreePath)` is TRUE only for an ABSOLUTE path whose `lstat`
  returns ENOENT. A relative path (unresolvable without the cwd it was persisted under), a
  missing/empty value, a dangling symlink (a real entry), and any other errno are all
  FALSE. "I could not prove it is gone" must never be read as "it is gone" by a consumer
  whose next act is to retire a descriptor. `scripts/devswarm.js` now persists ABSOLUTE
  worktree paths; the fail-closed read covers values written before that.
- The grouping predicate for a WRITE is stricter than the one for a READ.
  `companion/lib/devswarm-identity-family.js` keeps both in one module on purpose:
  `familyKeyOf` groups by resolved worktree (correct for counting), while
  `crossLinkedIdentity`/`identityFamilyTwins` use only the id/`sessionId` cross-link,
  because two legitimately-live tabs share one worktree and must never be collapsed by a
  mutating path.

**The same rule applied to the READ side.** The gate's spec said `known:false` ALWAYS
blocks, unconditionally, including an absent inbox. That absolute conflated "anomaly worth
blocking on" with "workspace physically gone". An `inbox-missing` (ENOENT, and only ENOENT)
on a descriptor whose worktree is ALSO provably gone is a dead descriptor, and the axis is
UN-CLEARABLE by construction — no inbox to read, no child to poke, no acknowledgement that
would ever retire it. That single conjunction no longer raises the unknown axis, and
nothing else changes: store-side unread still blocks on `unionUnread`, a stale/escalated
verdict still blocks, and every other unreadable reason still blocks regardless of the
worktree. Note the deliberate ASYMMETRY with the write side — the same "provably gone"
predicate fails closed toward BLOCKING on the read path and toward REFUSING on the write
path, because those are the safe directions for their respective consumers.

**Refusals must be reported.** `foldArchivedFamilyDescriptors` can decline to retire a twin
(tombstone bytes differ, lock busy, descriptor changed since the scan, worktree still
present or unprovable). Those land in `left[]` with a reason and surface through `update`'s
summary line and a doctor `notice` rendered on BOTH the pending and the not-pending path;
a run that raised reports `ok:false`. Reporting only the retire count made every safety
refusal indistinguishable from "nothing to migrate" — the same success-while-dropping-part-
of-the-job shape §28 names as the worst failure mode. Refusals do NOT set `pending`, since
apply cannot clear them and claiming otherwise would report "still pending after migrate"
forever.

---

Section §30 facts were verified 2026-08-25 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — re-grep the cited function/symbol
names rather than trusting line numbers verbatim after either file changes further).

---

## 31. A unit's PATH must contain the directory of the interpreter it bakes (v0.86.0)

**The defect this section generalizes.** `install-devswarm-ingest.js` and
`install-devswarm-supervisor.js` bake an ABSOLUTE node path as the generated
launchd/systemd/cron unit's interpreter — `process.execPath` captured at install time,
which on a developer machine is commonly a version-manager directory
(`~/.nvm/versions/node/vX.Y.Z/bin/node`) that appears on no scheduler's default `PATH`.
The same emitters built the unit's `PATH` from the resolved `hivecontrol` directory plus
`MINIMAL_UNIT_PATH`. The node bin dir was in neither.

**Why every health signal said "fine".** The daemon starts by absolute `argv[0]`, so it
launched, held its lock, wrote heartbeats, and passed every check that asks "is the daemon
running?". The failure lived exactly ONE process lower: `hivecontrol` is a SCRIPT whose
shebang re-resolves `node` THROUGH `PATH`, so every grandchild the daemon spawned died
`env: node: No such file or directory`, exit 127. Measured on a live install before the
fix: **23,928 occurrences across 1,757 supervisor sweeps spanning three repoKeys, with
`healed:0` on every single sweep** — reconciliation had never succeeded for any scope, for
as long as the units had existed.

**The rule.** *Baking an absolute interpreter into a unit is only half the contract. The
environment that unit hands to its children must be able to resolve that same interpreter
by name.* An absolute `ExecStart` guarantees the process you launch; it guarantees nothing
about the scripts that process launches, and a shebang is a by-name lookup. Any time a
generated unit pins an interpreter path, `dirname` of that path belongs on the unit's
`PATH`.

**Why this is a chokepoint fix, not a per-emitter patch.** Six emitters across the two
installers write a unit environment (plist / systemd service / cron line, times two
installers), and `install-devswarm-supervisor.js` imports `unitEnvFor` from the ingest
installer. Patching the PATH at each emitter would leave the fix one refactor away from
being missed on one of them. Instead `unitEnvFor(hivecontrolPath, execPath)` now takes
`execPath` as a REQUIRED argument and prepends `dirname(execPath)`, and every emitter
passes the very `exec` it is writing into that unit — so the PATH and the baked
interpreter are derived from one value and *structurally cannot* disagree. The function
stays pure and deterministic, which is what keeps a regenerated unit byte-identical across
the repeated reconcile/regenerate cycles that silently reverted every hand-patched plist.

**Two smaller invariants that fell out of the same pass.**

- The environment block used to be suppressed ENTIRELY when `hivecontrol` could not be
  resolved (`pathIsEmittable(hivecontrol) ? unitEnvFor(...) : null`). That coupled two
  independent facts: a `PATH` that can resolve `node` is worth emitting even when the CLI
  path could not be pinned. `unitEnvFor` now returns null only when NEITHER input is
  usable, and pins `ANTIHALL_DEVSWARM_HIVECONTROL` only when the binary itself is
  emittable.
- Install now fails loudly if the node binary at `EXEC` is not a real file, exactly as it
  already did for the daemon script. `process.execPath` is self-evidently present at
  install time, so this is a cheap invariant assertion rather than a likely branch — but
  the unit bakes that path PERMANENTLY, and a unit that can never start surfaces only as a
  line in a scheduler log nobody reads.

**The review lens.** When a generated unit, container spec, cron line, or CI step pins an
absolute interpreter, ask separately: (1) will the process start? and (2) can everything it
spawns resolve that interpreter by name? A green answer to (1) is routinely mistaken for a
green answer to (2), and the gap is invisible from every "is it running" health check.

---

## 32. A bare verdict label is not evidence — a status needs corroboration before it hard-blocks (v0.87.0)

**The proof.** A persisted per-workspace verdict of
`{"status":"escalated","pending":false,"notDraining":false}` — the verdict's OWN payload
saying nothing is outstanding — force-blocked the Primary on ~20 consecutive turns.
`devswarm-parent-gate.js`'s `readVerdictStatus(id, home)` read only the bare `status`
string out of the verdict file and discarded `pending`/`notDraining` entirely, so
`main()` had no way to ask "does this status actually mean something is unread right
now?" It could only ask "what's the label?" — and the label was permanently wrong.

**Why the label goes stale and stays stale.** `escalated` is a TERMINAL state in
`liveness.js`'s own state machine: once written, `computeLiveness` short-circuits and
returns it unchanged on every subsequent call, forever, until a FRESH heartbeat clears
it — and a heartbeat is emitted only by that workspace's own live session. A workspace
that finishes its work and exits will never emit another heartbeat. So `escalated` is not
"this is currently a problem," it is "this was once a problem, and nothing will ever
un-flag it automatically." Reading that label as current truth is the bug.

**The fix — corroboration, not suppression.** The label is real signal (it means SOMETHING
happened) so it cannot simply be ignored; the owner's governing constraint was explicit:
fix the misclassification, never mute the alarm. `readVerdict()` now returns the full
`{status, pending, notDraining}` shape, and a bare `stale`/`escalated` status can drive a
hard block ONLY when corroborated by at least one of four independent, OR'd axes:

1. the verdict's own `pending` flag (the verdict itself says something is outstanding),
2. a real `unionUnread` backlog for the family (computed independently of the verdict),
3. `unreadUnknown` — a member's unread axis could not be read at all (fail-open TOWARD
   blocking, never toward silence — an unreadable mailbox is never treated as an empty
   one), or
4. an unanswered question addressed FROM one of this family's own member ids.

This set is intentionally an OR, and intentionally NOT narrowed to axis 2 alone — a
genuinely wedged child holding an unanswered question with an otherwise-drained mailbox
must still corroborate via axis 4. An uncorroborated stale/escalated status degrades to a
ONE-TIME advisory line on stderr (never the stdout decision channel) instead of a hard
block; the family still blocks normally on any OTHER real axis it separately carries
(`unionUnread`/`unreadUnknown` outside the `staleOrEscalated` branch).

**The general review lens — apply this anywhere a system persists a computed verdict and
a LATER consumer reads only the label.** A verdict computed at time T and consumed at
time T+N is not automatically still true at T+N, especially when the state machine that
produced it has any STICKY/terminal state. Ask two separate questions before trusting a
persisted status string to gate an action: (1) *can this label go stale relative to the
condition it names* — is there a terminal/sticky state, or any path where the label
survives past the event that made it true? and (2) *does the payload carry its own
supporting evidence*, and is the consumer actually reading that evidence, or just the
label on top of it? A verdict with corroborating fields sitting unread right next to the
label it should have widened is exactly this bug's shape, and it is invisible from the
verdict-computation side — `computeLiveness` was already correct; the defect was 100%
in what the CONSUMER chose to look at.

---

Section §31 facts were verified 2026-08-28 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — re-grep the cited function/symbol
names rather than trusting line numbers verbatim after either file changes further).

Section §32 facts were verified 2026-08-29 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — re-grep the cited function/symbol
names rather than trusting line numbers verbatim after either file changes further).

---

## §33 — `reap-orphans`: retiring stranded mesh partitions safely

An **orphaned mesh partition** is a partition that still holds unread mail but has no
registry row, so nothing is ever going to read it. `computeSummary`'s A2 pass publishes
them as `summary.orphans[]`, and `hooks/devswarm-parent-inbox.js` renders that array as the
per-turn `⚠ DEVSWARM ORPHANED MESH: N partition(s) with unread but no live workspace to read
them` warning. Before this verb existed there was no CLI targeting that shape at all — the
warning re-fired every turn with nothing a human could do about it, and one field attempt to
clear 88 of them with the general-purpose tooling died at 20 (defect `b712da3bf077`).

`reap-orphans` reuses `computeSummary` directly rather than re-deriving the set, so the verb
and the warning can never disagree about what qualifies.

### What "reap" actually does — read this before using it

It is **not** a row deletion, and the difference is deliberate:

1. every unread row of the partition is written to `<devswarmRoot>/reaped/<partitionId>.ndjson`
   and **read back and verified** line-for-line;
2. **only then** is the partition retired by advancing its cursor to its own message count,
   which is what drops it out of `orphans[]` (that set requires `unread > 0`).

The message rows stay in the store. Two reasons: the store exposes no partition-delete
primitive (there is `removeRegistry`, but an orphan by definition has no registry row), and
this data's whole surrounding posture is *surface only — never auto-forwarded or deleted*.
Retiring rather than destroying clears the nagging in bulk while leaving the mail recoverable
from both the store and the archive file.

### Usage

| Command | Effect |
|---|---|
| `devswarm reap-orphans` | **Dry run (the default).** Lists candidates as `{partitionId, unread, lastMessageTs, reason}`. Changes nothing. |
| `devswarm reap-orphans --apply --max N` | Retires at most `N` candidates. Both flags required. |
| `… --i-am-a-human` | Additionally required when stdin is not a TTY. |

### Refusals (all hard, none overridable by config)

| Condition | Reason code |
|---|---|
| `--apply` without `--max` | `max-required` |
| `--max` not a positive integer | `bad-max` |
| `ANTIHALL_DEVSWARM_AUTOMATION=1` | `automation-refused` |
| stdin not a TTY, without `--i-am-a-human` | `non-interactive-refused` |
| archive write/read-back mismatch, per partition | `archive-verify-failed` (that partition is skipped; its cursor is **not** touched) |

The automation and TTY refusals are belt-and-braces against the same thing: retiring a
partition is a human decision, and a cron job, supervisor sweep, or subagent shell has no
business making it. A capped pass reports `capped:true` and `remaining:N` so it can never be
mistaken for a complete one.

## §34 — `reconcile-registry`: seeing mesh-vs-hivecontrol drift

Drift between the mesh registry and hivecontrol runs in **both** directions (defect
`d9a823ff1ca0`): a workspace archived in the registry but still open in the app, and a
workspace the registry lists as worktree-gone that the app reports active. Neither side is
unconditionally authoritative, so this verb **only reports** — there is no `--apply`, by
design. Reconciling one system from the other automatically is how a live workspace gets
retired out from under its owner.

`devswarm reconcile-registry` runs one `hivecontrol workspace list all` and returns
`registryWithoutWorkspace[]`, `workspaceWithoutRegistry[]`, `worktreePathMismatch[]`, plus a
`driftCount`. Worktree paths are compared **resolved**, so a symlink or trailing-slash
difference is not reported as drift.

**Shape pinning.** hivecontrol's `list all` JSON is not pinned in this KB, and the roster's
`parseChildrenList` is deliberately tolerant (every missing field normalises to `null`). That
tolerance is right for a best-effort roster fold and wrong here: a drift report built from
all-null records would confidently claim every workspace is missing or mismatched. So the raw
records are checked for the fields the comparison depends on (`id`, and `path`/`worktreePath`),
and an unrecognised shape returns `ok:false, reason:'hivecontrol-shape-unrecognized'` together
with the keys actually seen — fail soft, never guess. An **empty** list is a valid answer (no
workspaces), not a shape failure.

## §35 — `--force-cross-project`: the one authority-gate escape hatch

The v0.85.0 id-derived authority gate closed a real cross-project re-home/theft P0, but left
no legitimate route to archive a workspace whose worktree lives under another project
(defect `c2a7813aa7d3`). `devswarm archive <id> --force-cross-project <id>` opens it, and only
it:

- **opt-in per call** — never an env var, never config, never sticky;
- **must name the target exactly** — the flag value has to equal the id being archived, so a
  bare boolean or a copy-pasted flag carrying a different id is refused. The operator has to
  restate which workspace they mean and the two must agree;
- **audited** — one NDJSON line per accepted override in
  `~/.anti-hall/logs/devswarm-authority-override.log` as `{ts, verb, id, cwdProject, targetProject}`;
- **archive only.** The same gate guards `ensure`, `inbox ack` and `gate`; those deliberately
  do **not** get the hatch. Archive refuses before it copies or removes anything, so
  overriding it moves no data — whereas overriding the others would re-open exactly the
  cross-project row-copying and foreign-cursor-advancing the gate exists to prevent.

Under an override the descriptor's `ownerKey` is **not** re-stamped to the caller's project, so
the registry tombstone still lands in the owning project's store. The override authorises
archiving a foreign workspace, never adopting one. The bulk sweeps that also call `cmdArchive`
pass no flags and therefore can never take this hatch.

---

Sections §33-§35 were verified 2026-09-05 from source at the versions on disk in this repo
checkout (anti-hall's own code, not vendor behavior — re-grep the cited function/symbol names
rather than trusting line numbers verbatim after either file changes further).

## §36 — Re-testing `0a668d81c0c6` in the field (cursor vs total, slug row and UUID row)

The fold-cursor defect is about a read cursor being advanced past mail nobody consumed, so the
field re-test is simply: read the cursor and the total before and after a read, on **both** id
shapes (a slug row and a UUID row), and see whether the cursor ever lands past what was
actually handed over.

Run this per row id, from inside the project's worktree, on **0.92.0**:

```sh
devswarm inbox messages <rowId>      # BEFORE: note `cursor`, `total`, `unreadCount`
devswarm inbox count    <rowId>      # BEFORE: note `cursorStore`, `cursorNdjson`, `total`
devswarm inbox read     <rowId>      # hand over the unread rows
devswarm inbox messages <rowId>      # AFTER: `cursor` vs `total`
devswarm inbox count    <rowId>      # AFTER: `cursorStore` vs `total`
```

Two corrections to the shape this re-test is usually written in, both verified against the
code and by running the verbs on a scratch home (never a live one):

- **There is no `--to` on these verbs.** `--to` belongs to `send --to <id>` (an addressee) and
  to `inbox ack --to <N>` (an explicit cursor value). `inbox messages`/`read`/`count` take the
  row id as a bare positional. `--json` is accepted but pointless: every verb except
  `healthcheck`/`diagnose` already prints raw JSON.
- **`inbox read` does not advance any cursor** — it is a non-mutating hand-over. `inbox ack`
  is the verb that moves the store cursor. Observed on a scratch home with 2 store rows:
  after `read`, `cursorStore` stayed `0` and `unreadStore` stayed `2`; after `ack`,
  `cursorStore` became `2` and `unreadStore` `0`. So a re-test that reads and then expects the
  cursor to have moved will always look "broken" for the wrong reason — insert the `ack`, or
  compare across it.

Field names to record (they differ per verb): `inbox messages` reports `cursor`, `total`,
`unreadCount`; `inbox count` reports `cursorNdjson` + `cursorStore` separately, plus
`unreadNdjson`/`unreadStore`/`unreadTotal` and `total` (`unread`/`storeCursor`/`storeUnread`
are compat aliases — do not report those). **The defect signature is `cursorStore` > the
number of rows actually forwarded/handed over**, i.e. the cursor sitting past a
non-forwardable row rather than at the end of a contiguous forwarded prefix.

Do both a slug row (e.g. `fix-the-thing-a1b2c3d4`) and a UUID row: they resolve through
different id paths, and the fold pairs them, so a result on one is not a result on the other.

**Ownership, as of 0.96.0 (D11-C):** `inbox ack <id>` must be run from the worktree that
OWNS `id` (or with `--ack-as-owner`) — a caller whose own cwd/env resolves to a REAL,
DIFFERENT registered row now refuses the whole verb (neither the NDJSON nor the store
cursor moves), where it previously half-acked (NDJSON drained, store side silently
skipped, `ok:true`). `read-primary` DRAINS `id`'s cursor exactly like `inbox ack` and is
refused the same way on a genuine mismatch; `peek-primary` is the non-mutating view of
the same rows and is never refused on ownership grounds.

## §37 — App-side archive detection: the active-cache, and `archivedRegistryRows`

hivecontrol 2.5.1's `workspace list all` (measured on the maintainer machine) returns
`{id, branch, sourceBranch, repositoryId, label, aiAgent, worktreePath, createdAt}` per row —
**no archive field at all**. Closing a workspace in the DevSwarm app writes nothing anti-hall
can see directly, so archive status can only be inferred by a row's **absence** from that list,
never read off it.

The supervisor sweep writes `hivecontrol-active.json` (under the DevSwarm repos root) whenever
a `list all` call succeeds, capturing every id and worktree path currently reported live. A
registry row is treated as app-archived only when **all** of: it is absent from that cache by
both id AND worktree path (path-normalized — resolved + realpath fail-soft, trailing
separators stripped, so a differently-printed live path is never misread as archived); it is
older than the cache snapshot by a 10-minute grace (avoids a race against a just-created
workspace hivecontrol hasn't listed yet); and the cache itself is still fresh — within 2x the
reconcile cooldown of when it was written, else stale/malformed and the rule suppresses
nothing. `writeActiveCache` additionally refuses to persist a snapshot below 50% of the
previous count for a repo (`ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT`, 0 disables) — a truncated or
partial `list all` response can't silently mass-archive a repo's live rows; the previous
snapshot is kept and the refusal logged once.

**v0.96.0 (D11-B):** the id/worktreePath match above is keyed by repoKey, but the underlying
`list all` answer that fills a bucket is GLOBAL — it takes no repo filter — so one bucket can
legitimately hold records spanning multiple physical repos, and a bare id (or worktreePath, in a
moved/rehomed setup) can collide across two UNRELATED repos sharing it. The match now ALSO
requires `repositoryId` agreement when both the cached record and the caller supply one; a
same-id record belonging to a DIFFERENT repositoryId no longer counts as proof the row is live.
Fails toward never-suppress when either side lacks a repositoryId — the pre-existing
id/worktreePath match alone still holds unchanged in that case.

**v0.96.2 (D12b):** two facts confirmed the D11-B repositoryId guard above had never actually
fired in the field. First, `fetchActiveWorkspaceRecords` (`scripts/devswarm.js`) parsed the SAME
`list all` output `parseChildrenList` already knew carried `repositoryId`, but dropped the field
on its own separate pass — every cached record's `repositoryId` was `null`, so the guard's "both
sides carry one" precondition could never hold. Now threaded through (plus `label`/`branch`, for
provenance). Second, since `list all` is GLOBAL (confirmed: the identical full record set from
every repo's cwd), the pre-fix sweep (`reconcileSweepIfDue`) wrote that raw global answer verbatim
into EVERY probed repo's bucket — repo X's cache held repo Y's records too, and the 50% partial-
list floor compared against an inflated, cross-repo count. The sweep now resolves each record's
OWN repoKey from its OWN worktreePath (the same resolver `distinctRepoKeys` uses, memoized per
tick) and keeps, per target repoKey, only the records that resolve to it; a record whose
worktreePath is unattributable is dropped from every bucket rather than defaulted into one. The
floor and the repositoryId guard now both operate on a genuinely per-repo subset. Separately,
`activeProbeFailure` (and `fetchActiveWorkspaceRecords`'s own failure return) now carries
`error`, `status`, `signal`, and the first 200 chars of `stderr` (stdout excluded) instead of a
bare reason string, so a fast non-zero-exit field failure is diagnosable after the fact.

**v0.96.2 (D12c, R29 P2):** the D12b unattributable-worktreePath drop was itself too blunt —
past the archive grace period it let a genuinely-live sibling row (deleted/rehomed worktree
path, same repo) read as app-archived; the sweep now folds such a record into its target
repoKey's bucket when it shares a `repositoryId` with an already-directly-attributed sibling
under the devswarm repos root (never across a foreign repositoryId, never reassigning a record
already attributed elsewhere), logs every record still genuinely dropped once per tick
(`active-scope-drop`, capped 20), and surfaces tick-wide `activeScope:{kept,dropped}` on
`reconcileSweepIfDue`'s return.

This is a **liveness-axis signal only**. It answers "does hivecontrol still know about this
workspace", nothing about whether it has real work pending — an app-archived-but-still-live
sender (still emitting heartbeats, still holding real unread) must keep gating, which is what
`archivedRegistryRows` is for: `computeSummary` (`companion/lib/devswarm-store.js`) projects it
as an always-present array (additive field) alongside the existing `registryRows`, and
`partitionUnanswered` takes an `opts.archivedKnown` flag — omitted or `false` (a legacy summary
predating this field) **fails open to blocking**, never silently permissive. A question is
informational-only (never counted as blocking, never auto-cleared) exactly when its sender
matches neither an active nor an archived registry row and carries no descriptor; an
archived-but-live sender still has a registry row, so it still blocks.

## Question attribution contract (defect f3b8f326bfc3)

A question row's `sender` is the sender's worktree-derived meshId, so every row on one
worktree (an anchor row, its uuid twin, a sub-agent on the same path) shares one value.
Attribution therefore resolves within the SENDER's identity family only, and the recipient's
own row plus everything cross-linked to it (`recipientFamilyIds`) is excluded on BOTH sides:
it can never be the rendered `from`, and its reply records can never clear the question. If
that exclusion leaves nothing live, the stored sender id is kept verbatim — the question stays
listed under its raw origin rather than being re-attributed to its own recipient. A sender
matching no registry row at all is still dropped (the permanent-deadlock rule, unchanged).

## §38 — Leaked test-fixture stores (defect f3c1bc827d89)

A test suite that spawns a real subprocess with `env: { ...process.env }` and no `HOME`/
`USERPROFILE` override leaks that subprocess's filesystem writes into the developer's REAL
`~/.anti-hall` instead of the test's own isolated tmp fixture home. Confirmed on the maintainer
machine as 88 fixture `store/<repoKey>/` directories under the real home, each holding exactly
one registry row whose `worktreePath` pointed at a since-deleted tmp dir. `tests/hygiene/
no-real-home-spawn.test.js` now lints every `tests/**/*.test.js` file for this exact pattern
(a `spawn`/`spawnSync`/`execFile(Sync)`/`fork` env spreading `process.env` with no HOME
override) so new instances fail CI instead of silently leaking.

`doctor --check` additionally runs `checkLeakedTestFixtureStores` (`hooks/lib/doctor-repair.js`)
as a report-only pass: it enumerates every per-project store under the home, and flags one
whose registry holds **exactly one row** (a real project accumulates many; a fixture seeds
exactly the one it needed) with a `worktreePath` textually under a known tmp-dir prefix
(`os.tmpdir()`, `/private/var/folders/`, `/var/folders/`, or `/tmp/`) that **no longer exists on
disk** (the leaking test's own cleanup already removed it — a live tmp-rooted project is never
flagged). The warning line reports a count and up to 5 examples.

**No deletion path exists for this anywhere** — not in `doctor --check`, not in `doctor --fix`,
per this project's hard no-automated-deletion rule. If `doctor` reports leaked fixture stores,
the OWNER decides whether to clean them up, after inspecting the listed examples: back up first
if unsure, then remove only the specific flagged `store/<repoKey>/` directories, e.g.
`rm -rf ~/.anti-hall/devswarm/store/<repoKey>` for each hash `doctor` printed — never a blanket
sweep of the whole `store/` directory, which would also remove real, live projects' data.

**Scope note (defect ec33954162ef, v0.98.3):** `no-real-home-spawn.test.js`'s lint only
catches a TEST FILE directly spawning a subprocess with a `process.env`-spread `env` and no
HOME override. It does NOT catch — and structurally cannot catch — a test that calls into
PRODUCTION code (`selfHeal`/`withSelfHeal` in `scripts/devswarm.js`) with an incomplete
`ctx.io` (missing `spawnInstaller`), which then spawns the real installer itself with a
correctly-isolated `HOME` override. That HOME isolation protects file writes, but a
launchd/systemd REGISTRATION isn't scoped by `$HOME` at all — it lands in the real user
session regardless. See §44 for that distinct leak class and its fix.

**Fix-wave R2 (same defect, v0.98.3): this closes the CLASS of leak, not just the one
fixed instance.** The instance fix (an `io.spawnInstaller` mock on the one leaking test)
only prevents THAT test from ever leaking again — it does nothing for a FUTURE test that
makes the identical mistake. `install-devswarm-ingest.js` now also forces its own
`DRYRUN` seam on whenever `process.env.NODE_TEST_CONTEXT` is present (Node sets this in
every `node --test` worker process, and a `spawnSync`'d child inherits it by ordinary env
inheritance — verified live on this machine with a probe test before relying on it: both
the direct worker AND a spawned grandchild read it back non-empty). This is a genuine
STRUCTURAL guard, not a test-authoring convention someone can forget: it fires regardless
of which test forgot the explicit `ANTIHALL_INGEST_DRY_RUN=1`/`ctx.io.spawnInstaller`
mock, anywhere in the `node --test` process tree, with no opt-out. It prints one stderr
line naming the defect, but only at the moment `planWrite`/`planRm`/`planRun` actually
intercepts a real write/rm/spawn call (not at module load) — so requiring this module
under `node --test` (61+ test files do) stays silent, and the notice appears only when a
real mutation was genuinely prevented. Proven with a test that
spawns the REAL installer `main()` (the only way it ever runs — it is not exported)
under an isolated HOME with NEITHER `--dry-run` NOR `ANTIHALL_INGEST_DRY_RUN` set,
relying entirely on inherited `NODE_TEST_CONTEXT`, and asserts zero plist/service files
written and an empty `listInstalledIngestUnits()` readback.

**Critic R2 (same defect, v0.98.3): two installer paths still bypassed this guard.**
`install-devswarm-ingest.js`'s `installCron`/`uninstallCron` called
`spawnSync('crontab', ['-'], {input})` directly instead of through `planRun` — so on
Linux (systemctl absent), neither `--dry-run` nor the `NODE_TEST_CONTEXT` guard actually
protected the crontab; only the plist/service writes were covered. `install-reaper.js`
had no `NODE_TEST_CONTEXT` guard at all (`DRYRUN` was `args.includes('--dry-run')` only).
Both are now fixed: the crontab write is routed through `planRun`, and
`install-reaper.js` carries the identical `EXPLICIT_DRYRUN || NODE_TEST_CONTEXT` guard
and once-per-process stderr notice. The structural fix now spans every installer path
that can register a real launchd/systemd/cron job: `install-devswarm-ingest.js`
(plist/service writes AND the crontab fallback) and `install-reaper.js` (plist/service
writes).

## §39 — Sender attribution

`pendingQuestions[].from` is resolved by `devswarm-store.js`'s `resolveSenderRegistryId`.
Its final leg (leg C, when a worktree's meshId maps to more than one sibling registry
row — e.g. a branch-slug row and a sub-agent row on the same worktree) used to delegate to
`devswarm-liveness-select.js`'s `pickFreshestLive`. That picker ranks on PRESENT-TENSE
signals (`updatedAt`, cursor drain, heartbeat freshness) — signals that flip across
successive `computeSummary` passes as the sibling rows heartbeat/drain independently, so the
SAME stored message could report a different `from` on consecutive reads (defect
f3b8f326bfc3: a phantom "unanswered question" traced to exactly this flip, not to a stale
`needs_reply` row).

`companion/lib/devswarm-attribution.js`'s `pickAttributionRow(rows)` replaces that leg with a
picker that is a pure function of row VALUES, never of "which row is live right now":

1. **A real `sessionId` wins.** A row whose `sessionId` is a non-empty, non-`unclaimed:`
   string (`isLiveSessionId`'s field-shape check, reused from the liveness module — no
   fs/liveness read) beats one that is not.
2. **C2 — the branch-slug row wins the remaining tie.** A row whose `id` starts with
   `basename(worktreePath) + '-'` beats a sub-agent row on the same worktree. Trailing path
   separators (`/` or `\`) on `worktreePath` are stripped before `basename()`, so
   `/wt/x/` and `/wt/x` rank identically. This is a pure string-prefix rule on the row `id`
   with NO row-provenance check — it does not verify the row actually originated from that
   worktree — which is acceptable because every candidate row is already a valid `send --to`
   target for the same meshId, and attribution clears the whole family, not one row.
3. **D — ascending lexical `id`** is the final, always-available tiebreak (same convention
   `pickDeterministicFallback` uses elsewhere).

Liveness is deliberately excluded from all three legs: shuffling the candidate rows can never
change the winner, and the SAME stored message always attributes to the SAME sender across
passes. Routing/fold call sites — `resolveMeshTarget`, `pickSurvivor`, the orphan policy in
`scripts/devswarm.js` — are untouched and keep using `pickFreshestLive`; attribution and
routing are different questions (who sent this vs. which partition is currently live) and
must not share a picker.

**Field case that motivated this:** two sibling rows registered on one worktree — one from
`register-primary` (branch-slug `id`), one from a sub-agent's `ensure` — with `updatedAt`
flipping which was "freshest" across two consecutive summary computations, so the same
pending question rendered `from` as first one sibling, then the other, on unchanged stored
data. `pickAttributionRow` resolves both passes to the same row (the branch-slug row, via C2)
regardless of which sibling most recently heartbeat.

## §40 — `unclaimed:` promotion sources and `diagnose` fields (v0.95.0)

`realSessionIdFrom(flags, ctx, id)` sources a caller's real session id from, in order:

1. `--session` (the flag).
2. `CLAUDE_CODE_SESSION_ID` (the env var — set in a DevSwarm-launched session's own Bash
   shell, absent in a plain non-DevSwarm session's shell; see the measured fact recorded in
   `docs/KB-claude-code-hooks.md`).
3. Only when NEITHER above resolves anything AND the target row is a MARKER row (its
   descriptor or registry `sessionId` still reads `unclaimed:<id>`, or is missing
   entirely) — the harness's own `<home>/.claude/sessions/<pid>.json` session file, found
   by walking the caller's parent-pid chain (`deriveCallerSessionIdFromProcessTree`).

**The safety gate (`rowStillNeedsSessionDerivation`):** leg 3's process-tree walk spawns a
real `ps` per hop via `defaultPpidOf`. Gating it to marker rows only means an
already-promoted row (real `sessionId` on BOTH the descriptor and the registry) never pays
that cost on a read/pull — its result could only ever be discarded anyway. The gate fails
OPEN on a read error (missing descriptor, unreadable registry): the pre-existing behavior
always ran the walk, so a gate error just costs one extra `ps` call, never a blocked
promotion.

**Why fail-closed everywhere else:** the walk itself still requires the found session
file's `cwd` to resolve inside the caller's own worktree (unrelated ancestor processes are
never trusted), and now additionally requires the pid it names to pass the SAME pid-reuse /
start-time staleness guard `companion/lib/liveness.js`'s `sessionPidAlive` already applies
elsewhere (`pidIsAlive` with the file's own mtime as `sinceMs`) — a session file naming a
pid that has since been reused by an unrelated process, or is simply dead, is not trusted.
A missed promotion is a retryable no-op on the next call; a wrong one would stamp a
stranger's session id onto this row.

`promoteUnclaimedSession`'s classic promotion path (both descriptor and registry still
carrying the marker) now surfaces a registry-write failure as an additive
`registryWriteError` string field on its OWN return value (plus one stderr line), instead of
swallowing it silently — the descriptor promotion and `promoted:true` are unaffected,
since the descriptor write already succeeded by the time the registry write is attempted.
Every production caller that reads this — `cmdInboxPull` (`inbox pull`), `cmdInboxMessagesInner`
(`inbox messages`/`read-primary`/`peek-primary`), and the forward-migration sweep
(`promoteUnclaimedRegistrySessions`) — propagates it onward: `inbox pull`/`read-primary`/
`inbox messages` attach an additive `promotion: { promoted, registryWriteError? }` object to
their JSON output (present only when a promotion happened or the registry write actually
failed this call), and the sweep's per-row `promoted[]` entry gets a `registryWriteError`
field under the same condition. A registry write failure never blocks the call or the
descriptor promotion; the next read/pull retries the registry write via the
divergence-repair branches above.

**`descriptorSessionId` (diagnose):** `computeDiagnosis` resolves a row's reported
`sessionId` through the descriptor when the registry copy is stale, and on disagreement
between the two also reports the descriptor's own value under `descriptorSessionId` —
so a caller can tell "the registry hasn't caught up yet" apart from "these two sources
genuinely disagree" without opening the store directly.

## §41 — Child-gate re-fire despite a satisfied heartbeat (defect a55d6b71a76f, v0.98.1)

`hooks/devswarm-child-gate.js`'s Stop hook could re-block a child EVERY turn even
though the child ran the exact heartbeat command the gate's own reason text
prescribed. Three compounding causes, all fixed together:

1. **Dropped broadcasts never satisfied the episode.** `alreadyReportedThisEpisode()`
   reads only `summaries/<repoKey>.json`'s `recent[]` — populated exclusively by a
   broadcast that actually made it into the shared store. `cmdHeartbeat`'s ownership
   check can benignly REFUSE (and thus drop) that same broadcast for
   `unresolvable-caller-identity`/`caller-not-registered`/`ownership-mismatch`
   (`BENIGN_MESH_BROADCAST_REASONS`, `scripts/devswarm.js`), which is a working
   security control, not a caller mistake — but the drop left NO trace `recent[]`
   could ever surface, so the gate saw "never reported" forever. Fix: `cmdHeartbeat`
   now appends `{ts, id, reason, summary, instanceNonce, sessionId, pid}` (record
   shape as hardened below) to a bounded local attempt file on every such drop. The
   gate's new `findRecentDropAttempt()` reads it back and treats a fresh,
   authenticated attempt record the same way as a real report for
   episode-satisfaction purposes. If a block still fires anyway (a KNOWN durable
   unread-inbox backlog independently forces one — the INBOUND half of the gate,
   unaffected by this fix), the block reason names the actual drop reason and its
   remedy (`DROP_REMEDY`) instead of re-prescribing the identical command that just
   failed for the identical reason.
   **Hardened further (Wave 3 addendum, same v0.98.1 release):** the record moved
   from one shared `summary-attempts/<repoKey>.ndjson` file to a PER-WRITER-ID file
   under `summary-attempts/<repoKey>/<writerId>.ndjson` (append-only, trimmed to the
   last 50 lines only once a file passes 100), closing a read-modify-write-rename
   race where two concurrent sibling writers could silently drop each other's row;
   the record's `sessionId` is now derived from the cwd-verified process-tree walk,
   with `CLAUDE_CODE_SESSION_ID` accepted only when the walk corroborates it
   (omitted otherwise), never the caller-supplied `--session` flag (which
   was provably forgeable — a caller could stamp a victim's own registered
   sessionId onto a row for a completely different writer); the twin-case
   authentication match (nonce OR session, regardless of the row's own `id` field)
   is scoped to the SAME physical worktree via `canonicalMeshId`/a uuid-prefix id
   relationship, never "any same-worktree descriptor"; `warnIdMismatch` (the
   separate id-mismatch stderr warning on `heartbeat`/`inbox tick`) now gates on
   `isChildWorkspaceCorroborated`, not the bare env-only `isChildWorkspace`, so a
   Primary with a leaked `DEVSWARM_SOURCE_BRANCH` is never told to switch ids; and
   the gate logs one stderr diagnostic per session (never spammed) both when its own
   nonce cannot be derived and when a same-id attempt record exists but
   authenticates against neither check — see `hooks/devswarm-child-gate.js`'s
   `findRecentDropAttempt`/`describeDropAttempt` header comments for the full
   rationale of each.
2. **The per-window cap fully re-armed forever.** `MAX_BLOCKS=2` resets every
   `RESET_MS` (5 min) by design (a genuinely new stop episode should re-arm), but
   that means a session stuck in one persistently failing state could be blocked
   without any session-wide ceiling. Fix: a new, NEVER-reset
   `MAX_BLOCKS_PER_SESSION=6` (tracked as `state.totalBlocks`, distinct from the
   per-window `state.blocks`) stops all further blocking for the rest of the
   session once reached, logged once to stderr (this hook has no dedicated log
   file of its own).
3. **The role check trusted only an env var.** `isChildWorkspace()`
   (`hooks/lib/devswarm-role.js`) is `DEVSWARM_SOURCE_BRANCH non-empty`, with no
   on-disk corroboration — a Primary that inherits a leaked/stale copy of that var
   (from a parent process, a misconfigured launcher) would be gated as a child by
   every hook that calls it directly. Fix: a new `isChildWorkspaceCorroborated(env,
   home, cwd)` additionally requires ON-DISK evidence — a registered
   `devswarmRoot(home)/workspaces/<DEVSWARM_BUILDER_ID>.json` descriptor, OR cwd
   under the real DevSwarm worktree layout (`~/.devswarm/repos/<seq>/<hex8>/
   <branch>`, §4) — before treating the session as gate-eligible. No corroboration
   → silent no-op, matching `isChildWorkspace`'s own fail-open-to-Primary contract.
   `isChildWorkspace()` itself is UNCHANGED (still env-only) for its many
   non-gating callers (role-routing in `devswarm-child-role.js`,
   `devswarm-parent-inbox.js`, `verify-first*.js`, `task-tracker.js`, etc.) — only
   `devswarm-child-gate.js`'s Stop-block path was in scope for this defect.

Codex parity: `devswarm-child-gate.js` and `devswarm-role.js` are SHARED files
registered unmodified in `codex/hooks/hooks.json` (§ "CORRECTION (this port)"
above) — no separate Codex code path exists for this fix to mirror.

**Persisted-shape carry-over (v0.98.1 follow-up, defect f0958b13fe2b work):**
`findRecentDropAttempt`'s reader now ALSO reads the OLDER, pre-Wave-3-addendum-7
flat file (`summary-attempts/<repoKey>.ndjson`, no per-writer-id directory) if
present, alongside the per-writer-id directory scan above — additive only, no
delete, no migration required. A record written by a process still on that
older code path (or never touched since) is not silently orphaned.

## §42 — Subagents never own the DevSwarm mailbox (defect f0958b13fe2b, v0.98.1)

Field-measured by SkyCrew (2026-09-08): inside a DevSwarm child workspace, the
child's OWN Task-tool subagents ran `node .../scripts/devswarm.js inbox pull
<id> && ... inbox ack <id>` directly — 155 executions across 120 subagent
transcripts in one workspace. Every `inbox pull`/`ack`/`read`/`read-primary`
advances the SHARED durable cursor, so the workspace's own MAIN THREAD
silently missed the mail its subagents had just drained. Brief-level
prohibitions ("don't touch the mailbox") were proven NON-MITIGATING in the
field — only a mechanical guard closes it, since the model has no other signal
that a Bash command it is about to run will desync state it cannot see.

**Rule:** only the workspace MAIN THREAD may pull/ack/read/tick the inbox or
heartbeat. A subagent that needs mailbox contents must ask its parent (the
main thread) to read and relay them, never touch the CLI itself.

**Mechanism — two independent layers, hardened over three review rounds (Wave
R3 additions called out below):**

1. `hooks/command-guard.js`'s `devswarm-subagent-mailbox-guard` block. Fires
   whenever the PreToolUse payload shows SUBAGENT context — via
   `isSubagentByPayload(payload)` (see "Payload-only signal" below, NOT the
   general-purpose `isSubagent()`) — and the Bash command invokes the
   devswarm.js CLI (any path — dev clone, marketplace cache, absolute) with a
   cursor-advancing verb:
   - `inbox pull`, `inbox ack`, `inbox read`, `inbox read-primary`,
     `inbox tick`
   - top-level `heartbeat`
   - top-level `reap-orphans` (writes cursors on reap, `scripts/devswarm.js`
     ~13396) — Wave R3 addition
   - `inbox messages ... --ack` / `--ack-as-owner` — Wave R3 P0 fix: this is
     the DOCUMENTED, cursor-advancing expansion of `read-primary`
     (`skills/devswarm/SKILL.md`), via `cmdInboxMessagesInner`'s doAck path
     (`scripts/devswarm.js` ~7521-7522) — NOT the same as the safe, non-acking
     `inbox messages` this guard otherwise allows. Detected as a two-part
     check (base verb match + a flag scan across the whole shell segment),
     since the `--ack`/`--ack-as-owner` flag can legally appear before or
     after the target id / other flags.
   - `mesh read` WITHOUT `--peek`/`--seq` (`scripts/devswarm.js` ~12332
     advances the broadcast cursor by default) — Wave R3 addition; `mesh read
     --peek` and `mesh read --seq N` are the documented non-mutating forms
     and stay allowed.
   - `roster --ack` — an ALIAS of `mesh read` (D23; `scripts/devswarm.js`'s
     own `case 'roster'` dispatches to `cmdMeshRead` when `--ack` is present)
     — Wave R3 addition; plain `roster` (no `--ack`) is a pure read-only
     projection and stays allowed.
   - top-level `register` / `archive` — Wave R3 item 12 (R4 Critic): both
     advance cursors through `foldGroupIntoSurvivor` (`scripts/devswarm.js`
     ~2654, invoked from `retireWorktreeDuplicates` ~2562 and
     `retireArchivedWorktreeGroup` ~3350) — a subagent never legitimately
     registers or archives a workspace, that is a main-thread/coordinator
     lifecycle action. The SEPARATE lifecycle verbs `register-primary` and
     `archive-request`/`archive-ignore`/`archive-unignore`/`unarchive` are
     deliberately unaffected (excluded via a negative lookahead so `register`/
     `archive` match only as a WHOLE verb, never as a prefix of the longer
     ones).
   Read-only verbs that stay allowed throughout: `inbox count`, `inbox
   messages` (incl. `--tail`, without an ack flag), `inbox peek-primary`
   (non-mutating by design — `cmdInbox`'s own opts `{ack: false}`), `mesh read
   --peek`/`--seq N`, plain `roster`, `send`, `register-primary`, and
   `archive-request`/`archive-ignore`/`archive-unignore`/`unarchive`.
   **Flag-skip fix (Wave R3 P2, Reviewer 1):** detection runs per shell
   segment against a flag-skip pattern that consumes an optional VALUE after
   each flag (`(?:-\S+(?:\s+[^-\s]\S*)?\s+)*`) — the prior pattern
   (`(?:-\S+\s+)*`) skipped only BARE flags, so a valued flag placed BEFORE
   the verb (`--session X inbox ack Y`) broke the match at the value token
   "X" and silently bypassed the guard entirely; `--flag=value` (single-token
   form) was always safe since `-\S+` alone consumes it.
   Fires REGARDLESS of DevSwarm-active/child-workspace status (an accidental
   subagent mailbox-touch is wrong anywhere) and independent of
   command-guard's normal coordinator-only gate. Two overrides:
   `~/.anti-hall/skip.json` under skip name
   `devswarm-subagent-mailbox-guard`, or env
   `ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1`.
2. `hooks/verify-first-subagent.js` appends one line to its SubagentStart
   injection when `isChildWorkspace(env)` (`DEVSWARM_SOURCE_BRANCH`
   non-empty, inherited by every subagent the child spawns) is true, naming
   the same forbidden verbs and telling the subagent to report findings to
   its parent instead — the brief-level prohibition, now backed by the
   mechanical guard above rather than relied on alone.

**Payload-only signal (Wave R3 P2, Reviewer 4 + Critic):** both blocking
gates above — this guard AND `devswarm-child-drain.js`'s subagent gate below
— use a new `isSubagentByPayload(payload)` (`hooks/coordinator-detect.js`):
`agent_id`/`agent_type` in the hook payload ONLY, with NO
`CLAUDE_CODE_ENTRYPOINT=agent_tool` env fallback. The pre-existing,
general-purpose `isSubagent()` (still used unchanged by command-guard's
normal coordinator-only gate, where an env-based false positive merely
ALLOWS a heavy command through — low cost) legitimately uses that env
fallback. For a gate that BLOCKS on a subagent match, the cost of a false
positive is high: a DevSwarm child workspace's env is inherited by its
ENTIRE process tree, so a leaked `agent_tool` value (from how the child
session itself was originally spawned) could otherwise permanently
misclassify that workspace's own main-thread cron tick / Monitor wake as a
subagent, blocking it from its own mailbox forever. Payload markers carry no
such leak — Claude Code injects them fresh, per Task-tool call, only onto
that subagent's own payload.

**Codex parity, precisely stated (Wave R3 P2, Reviewer 2 + Critic C3):** both
`command-guard.js` and `devswarm-child-drain.js` are SHARED files, registered
unmodified in `codex/hooks/hooks.json` — no separate Codex code path exists.
Their DENY behavior, however, depends on the harness actually supplying
`agent_id`/`agent_type` in the hook payload; this has been **verified on
Claude Code only**. A grep of `plugins/anti-hall/codex` for `agent_id`/
`agent_type` returns 0 hits (`codex/README.md:48` confirms no such
payload-marker mapping exists there), so whether Codex's harness populates
these fields the same way is UNVERIFIED — the guards are registered either
way (fail-open if the markers are simply absent, same as any other unmatched
context), but blocking a Codex subagent specifically has not been
demonstrated. No claim of Codex-verified blocking is made anywhere in this
section or the CHANGELOG entry for this defect.

**Known, harmless, deferred (Wave R3, Reviewer 3):** echo noise around this
guard's deny path was flagged in review; triaged as known and harmless and
deliberately NOT addressed in this round.

**Root cause of the field incident, closed directly (same release):**
`hooks/devswarm-child-drain.js` (PostToolUse, matcher Bash, CHILD-ONLY — the
mid-turn re-entry fix, §"Always-listening reception" area above) was the hook
that TOLD subagents to drain the mailbox. It gates only on
`isDevswarmActive(env) && isChildWorkspace(env)` — both env-based, and env is
inherited by every subagent a child spawns — so a subagent's own Bash calls
satisfied the gate identically to the main thread, and the injected text
literally read `` Drain NOW via `inbox pull ... && inbox ack ...` ``. This is
the exact command the three field-measured subagent runs executed
(18:49:24Z/04:43:00Z/05:46:28Z). Fixed: the hook now reads
`isSubagentByPayload(payload)` (PAYLOAD markers only — see "Payload-only
signal" above; PostToolUse carries the same `agent_id`/`agent_type` markers
PreToolUse does) and silently no-ops for a subagent — not even a redirect
line, since `verify-first-subagent.js`
already delivers the rule once at spawn and repeating it on every Bash call
would be exactly the per-call noise this hook's own THROTTLE design exists to
avoid.

**Sweep (same defect, same pass):** every other DevSwarm hook registered on a
subagent-reachable event (`PreToolUse`/`PostToolUse`) and gated on child env
alone was checked for the same hole. `devswarm-child-turn.js`
(`UserPromptSubmit`) and `devswarm-child-gate.js` (`Stop`) are **not**
subagent-reachable at all — neither event fires for a Task-tool subagent;
`SubagentStop` is a distinct event and this plugin does not register it (see
`docs/KB-claude-code-hooks.md` row 28). The two Primary-side hooks
(`devswarm-parent-gate.js`, `devswarm-parent-reply-tracker.js`) return early
for a child workspace and are unaffected either way. `devswarm-child-drain.js`
was the only live hole.

Codex parity for `devswarm-child-drain.js`: see the consolidated "Codex
parity, precisely stated" note above — registration is shared and unmodified,
but its deny/no-op behavior for a Codex subagent specifically is unverified.

## §43 — git-stash-guard: a mutating `git stash` is blocked once armed (defect b08b26566b92, v0.98.2)

**Field incident:** two Sonnet workers ran `git stash push` over protected WIP
stashes on `main` despite an explicit no-git-stash brief — nothing mechanical
stopped them; only a `.git/index.lock` race between the two concurrent runs
happened to prevent worse damage. This is not DevSwarm-specific — it applies
to any worker/subagent touching any repo — but it ships in the same shared
`hooks/command-guard.js` file, so it is documented here alongside the other
command-guard branches.

**Detection (`detectMutatingGitStash`/`mutatingGitStashInSegment`):** a
segment is only considered when `effectiveVerb(segment)` resolves to `git`
(so a `grep "git stash drop" docs/` or a `git commit -m "...git stash
pop..."` — where the literal text merely appears inside a quoted grep
pattern or commit message — is never misclassified; a naive text-adjacency
regex both these shapes bypass toward false-positive). The segment is then
tokenized quote-aware (`tokenizeQuoted`, which keeps a quoted phrase as ONE
token instead of flattening it back into bare words) and walked like real
git argv: past git's own global options (`-C <path>`, `--git-dir[=path]`,
`-c <key>=<val>`, flag-only globals), to the subcommand, and — when it is
`stash` — past `stash`'s own leading flags (`-u`/`--include-untracked`,
`-k`/`--keep-index`, `-m X`/`--message=X`, `-p`, `-q`, `-a`) to either a
named subcommand or, if none, git's own `push` shorthand. `list`/`show`/
`branch` are read-only/non-destructive-enough and are never matched.

**Policy — armed, not unconditional:** the guard only fires once **ARMED**:
a `.anti-hall/protected-stashes` marker file exists at the repo's git
toplevel (existence-only check; create it locally — `.anti-hall/` is
gitignored, never commit it), OR the operator set
`ANTIHALL_STASH_GUARD=1`. This is a deliberate correction from an earlier
version that blocked SUBAGENT context unconditionally — wrong for a public
plugin most repos have never heard of and never opted into. Once armed, the
block applies in **both** subagent and coordinator context (a coordinator
can stash over its own protected WIP just as easily as a delegated worker
can). Own skip name `git-stash-guard`, added to `skip-guard.js`'s
`DESTRUCTIVE` set — a blanket `"all"` skip cannot silence it once armed,
matching `git-guard`'s own protection level.

**Codex parity:** `command-guard.js` is the single shared hook file (see the
Codex README's "Parity Notes"), so this branch auto-applies to Codex
sessions with no separate adapter — it is not gated on any DevSwarm env var
at all.

## §44 — Orphaned launchd/systemd ingest registrations (defect ec33954162ef, v0.98.3)

**Root cause of the leak, named honestly:** a test file
(`tests/scripts/devswarm-fleet-2e8653787945.test.js`) built a `selfHeal` ctx
with no `ctx.io.spawnInstaller` mock. `selfHeal`'s stale-daemon branch then
fell through to the REAL `defaultSpawnInstaller` (`scripts/devswarm.js`),
which really spawned `install-devswarm-ingest.js` as a subprocess under a
throwaway temp `HOME`. That subprocess registered a genuine `KeepAlive`
LaunchAgent whose `WorkingDirectory`/log paths point into the temp HOME —
teardown deletes the HOME, but nothing ever unloads the launchd
registration, so it retries forever (`LastExitStatus` 78<<8, "program
gone"). Confirmed live on the maintainer machine: 50+ loaded
`com.anti-hall.devswarm-ingest.*` labels against 6 real on-disk plists. The
test is fixed (an `io.spawnInstaller` mock, same pattern
`tests/companion/ingest-health.test.js` already used); the belt-and-braces
production side is `install-devswarm-ingest.js`'s own pre-existing
`ANTIHALL_INGEST_DRY_RUN=1` env seam (see its top-of-file comment) — any
caller that threads that env through a spawned installer subprocess gets a
no-op write/run instead of a real registration, and `defaultSpawnInstaller`
forwards a caller's env unchanged so it already propagates automatically.

**Why `git worktree list`-driven reap (§33, D9) cannot catch this:** that
path enumerates units to reap by walking the CURRENT repo's live worktrees
outward. A label whose worktree — and its whole temp HOME — no longer
exists anywhere has nothing left to enumerate FROM. The fix instead
enumerates from the SCHEDULER'S OWN registration list
(`launchctl list` on macOS, `systemctl --user list-units` on Linux) and
cross-references it against what's actually on disk — the same direction
`doctor`'s existing installed-unit readback (`listInstalledIngestUnits`)
already reads FROM disk, just inverted.

**New functions, `companion/install-devswarm-ingest.js`:**
`listLoadedIngestLabels(opts)` (loaded-set enumeration; `opts.io.listLoaded`
test seam), `classifyLoadedLabel(entry)` (pure per-entry classifier),
`orphanReapPlan(opts)` (the full plan: enumerate + cross-reference +
classify + apply the never-unload guards), `bootoutLoadedLabel(label, opts)`
/ `stopLoadedUnit(unit, opts)` (the actual unload calls, `opts.io.schedRun`
test seam — same injection discipline `stopLegacyUnitEntry` already uses).

**Classes** (one loaded label -> exactly one class): `healthy` (plist
present, path exists, a live heartbeat/lock proves it) · `orphan-no-plist`
(loaded in the scheduler but NO matching plist/service file on disk at all —
the confirmed dominant real-world case, 39/45 sampled) · `orphan-path-gone`
(plist present, but its `WorkingDirectory`/repo path no longer exists) ·
`duplicate-label-same-project` (2+ loaded legacy per-worktree-hash labels
whose `WorkingDirectory` resolves to the SAME `repoKey` — only possible for
the legacy hash form, since a per-project label already IS 1:1 with repoKey
by construction) · `unknown` (plist present, path exists, but liveness is
unprovable — e.g. no heartbeat/lock has been written yet; never assumed
safe, never auto-unloaded).

**Eligibility is exactly ONE class (fix-wave R2 correction — an earlier draft
of this section wrongly suggested `orphan-path-gone` could also be
eligible; caught in review before merge, see the P0 note below):**
`orphan-no-plist` AND no live heartbeat/lock for that repoKey/hash. That is
the ONLY combination this new bootout/stop path ever touches.
`orphan-path-gone` and `duplicate-label-same-project` are ALWAYS
report-only — `eligible` is `false` for both, unconditionally, regardless of
liveness — because a plist/service file DOES exist on disk for both, and
unloading a label with an on-disk unit file is the EXISTING reap machinery's
job (`reapLegacyUnitsForRepo` / `stopLegacyUnitEntry`), never this one.
`eligible` is assigned in exactly ONE place in `orphanReapPlan` (never
reassigned by the duplicate-detection pass, which only ever touches
`class`), and a final invariant check before the function returns fails
CLOSED (empty plan, logged) if it ever finds an eligible entry with a plist
present or a resolvable path — belt-and-braces against a future
classification bug reaching the apply loop.

**P0 caught in fix-wave R2 (never shipped to a release):** the first
implementation's duplicate-detection cross-check unconditionally set
`eligible` for BOTH members of a `duplicate-label-same-project` group based
only on that group's OWN liveness check — but entries only ever enter that
pass when a plist/service file already exists (workingDir is read FROM the
plist), so it could mark a plist-present, worktree-present, genuinely-quiet
legacy project's TWO redundant registrations both eligible. `doctor-repair.js`'s
apply loop filters on `eligible` alone, so `--apply` would have booted out
two real, on-disk-registered units. Caught by review against a live-fixture
regression test (two quiet hash-labeled plists sharing one real git
worktree) before any release shipped it.

**`doctor` — DETECT (always-on, no flag):** every plain `doctor` run prints
an "Orphaned launchd/systemd ingest registrations" table (label, pid, script
path, plist present y/n, path exists y/n, class) for every loaded label not
classified `healthy`. Silent (no section at all) when everything classifies
`healthy` — matches the existing `reaperWarningLines` convention.

**`doctor` — REPAIR (explicit, opt-in):** `doctor --repair-ingest-orphans`
prints the exact unload plan and writes/unloads nothing (dry-run by
default, mirroring `--reclaim-ingest-lock`'s own posture exactly).
`doctor --repair-ingest-orphans --apply` executes it: macOS —
`launchctl bootout gui/$(id -u)/<label>` (the modern 10.11+ form; an
orphan-no-plist label has no plist path to `unload` with, so this is a NEW
capability, not a reuse of the existing plist-based unload); Linux —
`systemctl --user stop <unit>.service`. Never `kill -9` a PID directly
(scheduler-mediated stop only, matching every existing stop path in this
file) and never deletes any file (there is nothing to delete for
`orphan-no-plist` by definition; `orphan-path-gone` file cleanup remains
`reapLegacyUnitsForRepo`'s job). Idempotent by construction — a second run's
`listLoadedIngestLabels` no longer reports an already-booted-out label, so
the plan is naturally empty; no state-file bookkeeping needed.

**Scoping fix (fix-wave R2, usability):** `--repair-ingest-orphans` used to
ALSO trigger `doctor`'s full default auto-repair pass (`DO_REPAIR` was only
gated on `--check`), so a plain `doctor --repair-ingest-orphans` ran every
OTHER unrelated auto-repair too — slow and surprising for a flag meant to be
narrow and explicit. `DO_REPAIR` is now also gated off when
`--repair-ingest-orphans` is present, so the flag runs ONLY its own
detect+plan/apply section, matching `--reclaim-ingest-lock`'s own scoped
posture.

**Codex parity:** `doctor.js` and `install-devswarm-ingest.js` are shared,
unforked files — this feature applies to Codex sessions identically; the
`--repair-ingest-orphans [--apply]` flag is documented in both
`plugins/anti-hall/skills/devswarm/SKILL.md` and
`plugins/anti-hall/codex/skills/anti-hall-devswarm/SKILL.md`.
