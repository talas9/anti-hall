# DevSwarm 2.5.7 compatibility — read-only evidence

Scope: shared native engine integration for Claude/OMC and Codex/OMX. No app mutation, message consumption, acknowledgement, tests, or builds performed by this lane. Obsidian tools were unavailable. Results below distinguish installed source/schema from actual runtime output, which was not sampled.

| Dependency | Status on installed 2.5.7 | Evidence |
|---|---|---|
| CLI/app version | Both identify 2.5.7 | `hivecontrol --version` exit 0: `2.5.7` / `DevSwarm app 2.5.7 (matches hivecontrol)` |
| list / children / legacy list all / list children | Help available, exit 0; legacy commands remain valid | Captured subcommand help below; absence from parent help did not prove removal |
| info | Help available; `worktreePath`, `startup`, nullable `terminalId` source-confirmed | Installed CLI JS13581–13625; info action18075–18100 prints parsed workspace |
| create `-s/--source`, `-a/--agent`, `-p/--prompt`, `-t/--title`; `-r/--remote` | Help/source available; mutation/output unexecuted | Captured create help; installed CLI18102 onward; engine spawnverb.rs809–825 accepts top/nested path/worktreePath |
| Caller argument forwarding | Create forwards arbitrary owner argv except stripped anti-hall `--from-local`; merge forwards arbitrary owner argv. Therefore arbitrary owner options remain unverified by design | defaults devswarm_act.create_strip/argv_create/argv_merge; dsbverbs.rs132–146 |
| archive / delete | Help available, exit 0; mutations unexecuted | Captured help below |
| update-title `-b/--branch` | Help available, exit 0; mutation unexecuted | Captured help below |
| check-merge / merge-into-source | Help available; merge response schema source-confirmed, mutations unexecuted | Installed CLI13520–13540 schema; engine dsbverbs.rs132–155 forwards/checks result |
| message-count | Help available; `{count}` source-confirmed | Installed CLI19056–19067; engine pull.rs195–212 accepts numeric and fallback count keys |
| read-messages | **Semantic conflict**: nonconsuming history; `{messages:[...]}` shape source-confirmed | Installed CLI18891–18917 +14945–14962; old engine pull documents destructive queue assumptions |
| monitor `-i/--interval`, `-t/--timeout` | Help available; **semantic conflict** with destructive-drain assumption | Installed CLI19069–19074;15579–15594 returns no initial plain-shell pending records;19126–19142 creates per-call baseline and uses paneScoped. Engine monitor.rs80–83 scrubs DEVSWARM_ variables. Runtime backlog effects not measured; no cursor/disposition redesign in this task |
| read/monitor message fields | Source-confirmed: fromBranch,toBranch,message,status,createdAt; current envelope supported | Installed CLI WorkspaceMessageSchema13452 onward +19151–19168; engine ingest/import.rs31–51,104–117,143–157 uses those fields and content hash |
| builders required columns, including isActive/isHidden | **Schema present**; row semantics unverified | Read-only sqlite_master output below; engine sources.rs201–236, appdb.rs177–221; both columns INTEGER NOT NULL with defaults1/0 |
| builder_terminals required columns | **Schema present**; row semantics unverified | Read-only sqlite_master output below; defaults mesh_write.app_cols_builder_terminals and devswarm_rt.col_term_* |
| pull_requests / repositories required columns | **Schema present**; row semantics unverified | Read-only sqlite_master output below; defaults mesh_write.app_cols_pull_requests/app_cols_repositories |
| DEVSWARM_AI_AGENT, BUILDER_ID, BUILDER_NAME, DEFAULT_BRANCH, REPO_ID, SOURCE_BRANCH | Engine dependency source-confirmed; complete runtime producer semantics unverified | Dependency manifest refresh.toml; default keys engine.env_allow, devswarm_role, devswarm_cli; CLI top help observed repo/default branch/agent only |
| DEVSWARM_BUILDER_TERMINAL_ID, BUILDER_TERMINAL_GENERATION, REPO_KEY | Engine dependency source-confirmed; producer compatibility unverified | Rust source inventory below; installed CLI17114 reads terminal ID; no live identity mutation/probe |
| macOS app DB path | Existing, schema read successfully | `~/Library/Application Support/DevSwarm/devswarm.db`, sqlite3 -readonly |
| Linux/XDG path; ANTIHALL_DEVSWARM_APP_DB override | Engine path contract inspected; Linux runtime unverified | ident.rs701–714; defaults mesh_write.app_db_linux/env_app_db |
| hivecontrol executable, alias, path cache | Installed alias source-confirmed; cache not read | Installed cli/hivecontrol1–6 execs sibling devswarm; ingest/monitor.rs25–39 reads configured override/cache `hivecontrol` field |
| Workspace descriptors and fields | Consumer contract source-confirmed; producer/current records unverified | dswire/facts.rs21–58; manifest inventory lists fields; no live descriptors touched |
| Version-change detection / once-only warning | Implemented full-version patch advisory + persisted warning key | logic/devswarm-version.js exact:true; lib/72-session.js patch handling; refresh/mod.rs preserves lastAdvised instead of replacing cache |
| Dependency probe/reporting | Implemented advisory cached probe; authorized release build passed | refresh/devswarm_compat.rs; status +doctor read cached results only; manifest in refresh.toml and defaults.pristine |

No read-only help/version/schema probe failed. No renamed required key was proven broken. Full runtime compatibility is **not certified**, because the installed source proves messaging semantic differences and operational calls were intentionally not executed.

The probe is native background refresh requested by SessionStart (lib/72-session.js requestRefresh), not a foreground hook subprocess. An explicit refresh CLI call is foreground. Each help command uses a TOML3s timeout and remaining TOML20s total budget; unexecuted dependencies remain unverified. Same full version+manifest skips repeat probes; missing/unparseable version caches make prior results unverified. Probe diagnostics never block runtime gates. Warning state survives refresh.

All dependency lists, help markers, semantic conflict markers, budgets and cache paths are plugin TOML values mirrored byte-for-byte to defaults.pristine at edit time. Native engine/JS runtime is shared by both platform variations; no separate Claude/Codex implementation was added.

Independent verifier ran the authorized foreground `lockf ~/.anti-hall/work/cargo-heavy.lock nice -n 10 cargo build -j4 --release -p ah-engine` from the ah-engine directory: exit0, release target finished in3m36s. Only warning: pre-existing unused `with_store` in src/meshw/orphan.rs123. No test suites or built runtime probes were run.

## Captured raw inventory and probes

# DevSwarm2.5.7 compatibility evidence

Generated dependency inventory (source defaults + Rust; runtime assertions separately below).

```json
{
  "commands": {
    "devswarm_recon.probe_args": [
      "workspace",
      "info"
    ],
    "devswarm_recon.list_all_args": [
      "workspace",
      "list",
      "all"
    ],
    "devswarm_recon.cp_help_args": [
      "workspace",
      "--help"
    ],
    "devswarm_recon.cp_verb_help_args": [
      "workspace",
      "{verb}",
      "--help"
    ],
    "devswarm_gates.cg_probe_args": [
      "workspace",
      "message-count"
    ],
    "task_tracker.tier_names": [
      "workspace",
      "workflow",
      "subagent"
    ],
    "mesh_write.roster_children_args": [
      "workspace",
      "list",
      "children"
    ],
    "mesh_write.hc_message_count": [
      "workspace",
      "message-count"
    ],
    "mesh_write.hc_read_messages": [
      "workspace",
      "read-messages"
    ],
    "devswarm_act.argv_archive": [
      "workspace",
      "archive",
      "{id}"
    ],
    "devswarm_act.argv_delete": [
      "workspace",
      "delete",
      "{id}"
    ],
    "devswarm_act.argv_create": [
      "workspace",
      "create"
    ],
    "devswarm_act.argv_title": [
      "workspace",
      "update-title",
      "-b",
      "{branch}",
      "{title}"
    ],
    "devswarm_act.argv_check_merge": [
      "workspace",
      "check-merge"
    ],
    "devswarm_act.argv_merge": [
      "workspace",
      "merge-into-source"
    ],
    "devswarm_cli.rr_trusted_args": [
      "workspace",
      "list",
      "all"
    ],
    "devswarm_cli.hc_archive_args": [
      "workspace",
      "archive"
    ],
    "devswarm_cli.rr_list_args": [
      "workspace",
      "list",
      "all"
    ],
    "devswarm_cli.sp_hc_update_title": [
      "workspace",
      "update-title",
      "-b"
    ],
    "devswarm_cli.sp_result_paths": [
      "workspace",
      "path",
      "worktreePath"
    ],
    "devswarm_ingest.monitor_args": [
      "workspace",
      "monitor"
    ]
  },
  "environment": [
    "DEVSWARM_AI_AGENT",
    "DEVSWARM_BUILDER_ID",
    "DEVSWARM_BUILDER_NAME",
    "DEVSWARM_BUILDER_TERMINAL_GENERATION",
    "DEVSWARM_BUILDER_TERMINAL_ID",
    "DEVSWARM_CHILD_DRAIN",
    "DEVSWARM_CHILD_GATE",
    "DEVSWARM_CHILD_ROLE",
    "DEVSWARM_CHILD_TURN",
    "DEVSWARM_COMMS_GUARD",
    "DEVSWARM_DEFAULT_BRANCH",
    "DEVSWARM_PARENT_GATE",
    "DEVSWARM_PARENT_INBOX",
    "DEVSWARM_PARENT_REPLY_TRACKER",
    "DEVSWARM_REPO_ID",
    "DEVSWARM_REPO_KEY",
    "DEVSWARM_SOURCE_BRANCH",
    "DEVSWARM_VERSION"
  ],
  "schema_keys": {
    "mesh_write.app_col_worktree": "worktreePath",
    "mesh_write.app_col_builder_type": "builderType",
    "mesh_write.app_col_id": "id",
    "mesh_write.app_col_active": "isActive",
    "mesh_write.app_col_hidden": "isHidden",
    "mesh_write.app_table_builders": "builders",
    "mesh_write.app_table_terminals": "builder_terminals",
    "mesh_write.app_table_pull_requests": "pull_requests",
    "mesh_write.app_table_repositories": "repositories",
    "mesh_write.app_col_label": "label",
    "mesh_write.app_col_branch": "branchName",
    "devswarm_cli.app_table_head": "| rank | workspace | type | finish | brief | session |",
    "devswarm_cli.app_table_rule": "|---|---|---|---|---|---|",
    "devswarm_rt.col_branch": "branchName",
    "devswarm_rt.col_repo": "repositoryId",
    "devswarm_rt.col_label": "label",
    "devswarm_rt.col_pr": "pullRequestId",
    "devswarm_rt.col_term_builder": "builderId",
    "devswarm_rt.col_term_panel": "panelStatus",
    "devswarm_rt.col_term_active": "isActive",
    "devswarm_rt.col_pr_id": "id",
    "devswarm_rt.col_pr_number": "number",
    "devswarm_rt.col_pr_state": "state",
    "devswarm_rt.col_pr_checks": "checkStatus",
    "devswarm_rt.col_pr_synced": "lastSyncedAt"
  },
  "paths": {
    "mesh_write.dir_workspaces": "workspaces",
    "mesh_write.env_app_db": "ANTIHALL_DEVSWARM_APP_DB",
    "mesh_write.app_db_macos": "Library/Application Support/DevSwarm/devswarm.db",
    "mesh_write.app_db_linux": "DevSwarm/devswarm.db"
  }
}
```

## workspace list --help (exit 0)
```text
Usage: hivecontrol workspace list [options] [command]

List every workspace in the current repository as a flat JSON array. Each row
carries archived state (isArchived, archivedAt), agent (whether its AI agent is
alive now) and terminals; rows have no terminalId, which is deprecated. Pass
--tree for an ASCII hierarchy, or use 'workspace children' to scope to the
current workspace.

Options:
  --tree            Render as an ASCII hierarchy instead of JSON, nested by git
                    source branch, naming a workspace's messaging parent beside
                    it where the two differ. Human affordance — prefer the
                    default JSON when parsing.
  --tag <name>      Only list workspaces carrying this tag (exact,
                    case-insensitive). Repeatable — repeats OR, matching the
                    sidebar's `tag:` operator. (default: [])
  --status <state>  Only list workspaces in this archived state (any = no
                    filter). Applied together with --tag. Ignored with --tree,
                    which marks archived rows instead. (choices: "active",
                    "archived", "any", default: "any")
  -h, --help        display help for command
```

## workspace children --help (exit 0)
```text
Usage: hivecontrol workspace children [options]

List direct children of the current workspace (the workspaces it created, plus
any with no resolvable messaging parent whose source branch is your current
branch) as a flat JSON array. Each row carries archived state (isArchived,
archivedAt), agent (whether its AI agent is alive now) and terminals; rows have
no terminalId, which is deprecated. With --tree, render the git subtree instead:
you plus everything branched off you, transitively. The two differ on purpose —
the flat list answers what you spawned, the tree shows where things sit. Errors
when not inside a DevSwarm workspace.

Options:
  --tree            Render as an ASCII tree rooted at your current branch,
                    showing all descendants (not just direct children)
  --tag <name>      Only list workspaces carrying this tag (exact,
                    case-insensitive). Repeatable — repeats OR, matching the
                    sidebar's `tag:` operator. (default: [])
  --status <state>  Only list workspaces in this archived state (any = no
                    filter). Applied together with --tag. Ignored with --tree,
                    which marks archived rows instead. (choices: "active",
                    "archived", "any", default: "any")
  -h, --help        display help for command
```

## workspace info --help (exit 0)
```text
Usage: hivecontrol workspace info [options] [idOrBranch]

Get workspace details. Defaults to the current workspace; pass a workspace ID or
branch name to look up a different one. Returns JSON with branch, path, aiAgent,
archived state (isArchived, archivedAt), startup (whether the workspace came up
this app session), agent (whether its AI agent is alive now) and terminals
(every terminal it holds). terminalId is deprecated and does not show whether
the agent is alive; read agent and terminals instead.

Arguments:
  idOrBranch  Workspace ID (UUID) or branch name. Defaults to the current
              workspace when run inside one.

Options:
  -h, --help  display help for command
```

## workspace create --help (exit 0)
```text
Usage: hivecontrol workspace create [options] <branch>

Create a new workspace. You become its messaging parent (message-parent /
message-child), whatever --source says; --source sets the git base and where it
sits in the sidebar.

Arguments:
  branch                   Name for the new branch (e.g., feature/task-name)

Options:
  -s, --source <branch>    Source branch to branch from: a local or remote
                           branch name, or remote:<remote>/<branch> when more
                           than one remote carries it (default: YOUR CURRENT
                           BRANCH). Sets the git base only — you stay the new
                           workspace's messaging parent.
  -a, --agent <agent>      AI agent to use (default: repository Default AI, then
                           claude)
  -p, --prompt <text>      Initial prompt for AI to start working on immediately
  -r, --remote             Use an existing remote branch (fetches from origin)
  -t, --title <title>      Display title for the workspace (defaults to branch
                           name)
  --tag <tag>              Tag to assign to the new workspace. Repeatable.
                           Creates the tag on first use. (default: [])
  --tag-scope <repo|user>  Scope for every `--tag` on this call: `repo` (this
                           repository) or `user` (shared across every local
                           repository). Defaults to the repository's own.
  -h, --help               display help for command

Exits 4 (code SIGN_IN_REQUIRED) without creating anything when the DevSwarm app is signed out, since it cannot start a workspace until someone signs in. Sign in to DevSwarm in the desktop app, then retry.
```

## workspace archive --help (exit 0)
```text
Usage: hivecontrol workspace archive [options] [idOrBranch]

Archive a Workspace without deleting its worktree. Defaults to the current
Workspace; accepts a Workspace ID or branch. Repeats are safe.

Arguments:
  idOrBranch  Workspace UUID or branch name

Options:
  -h, --help  display help for command
```

## workspace delete --help (exit 0)
```text
Usage: hivecontrol workspace delete [options] [idOrBranch]

Permanently delete an archived Workspace. Refuses active Workspaces and any
uncommitted parent or Multi-Repo member worktree changes. Refuses with exit 5,
before sending anything, when the running DevSwarm app is too old to enforce
these checks.

Arguments:
  idOrBranch           Workspace UUID or branch name

Options:
  --reparent-children  Move this Workspace's child Workspaces onto its own
                       source branch instead of leaving them parented to a
                       branch with no Workspace (deleting a Workspace does not
                       delete its branch)
  -h, --help           display help for command
```

## workspace update-title --help (exit 0)
```text
Usage: hivecontrol workspace update-title [options] <title>

Update the display title for a workspace

Options:
  -b, --branch <branch>  Target branch (defaults to current branch)
  -h, --help             display help for command
```

## workspace check-merge --help (exit 0)
```text
Usage: hivecontrol workspace check-merge [options]

Check merge status and get paths to source/current directories. Returns JSON
with isMergeable, hasConflicts, targetDirectoryClean, sourceBranchCheckedOut,
and file paths (sourceBranchPath is null when the source branch is not checked
out anywhere). Run from your workspace - do not cd elsewhere.

Options:
  -h, --help  display help for command
```

## workspace merge-into-source --help (exit 0)
```text
Usage: hivecontrol workspace merge-into-source [options]

Merge current workspace INTO source branch. Needs the source branch checked out
in a worktree (e.g. the Primary workspace) and is refused otherwise. Run from
your workspace - do not cd elsewhere. If WORKING_DIRECTORY_NOT_CLEAN, explain to
user and ask before proceeding.

Options:
  -h, --help  display help for command
```

## workspace message-count --help (exit 0)
```text
Usage: hivecontrol workspace message-count [options]

Get the pending message count for this pane without consuming

Options:
  -h, --help  display help for command
```

## workspace read-messages --help (exit 0)
```text
Usage: hivecontrol workspace read-messages [options]

Inspect available messages and disposition history without consuming or hiding
anything.

Options:
  -h, --help  display help for command
```

## workspace monitor --help (exit 0)
```text
Usage: hivecontrol workspace monitor [options]

Monitor pending messages. From an AI pane, returns immediately while any message
still needs an explicit acknowledgement, acceptance, completion, or failure.
Without a pane ID (a plain shell), waits for messages that arrive after it
starts. Waits out DevSwarm restarts and outages, retrying with backoff; progress
goes to stderr.

Options:
  -i, --interval <seconds>  Poll interval in seconds (default: "3")
  -t, --timeout <seconds>   Max time to monitor (default: no limit)
  --max-errors <n>          Give up after n consecutive failed attempts
                            (default: keep retrying)
  --heartbeat-file <path>   Keep a JSON liveness record at <path>, refreshed at
                            least every 10s between attempts
  -h, --help                display help for command
```

## Source references: external environment
```json
{
  "DEVSWARM_SOURCE_BRANCH": [
    "ah-engine/src/daemonenv.rs:51",
    "ah-engine/src/roles.rs:5",
    "ah-engine/src/meshw/heartbeat.rs:1046",
    "ah-engine/src/wakew/who.rs:56"
  ],
  "DEVSWARM_BUILDER_ID": [
    "ah-engine/src/daemonenv.rs:52",
    "ah-engine/src/meshw/mod.rs:447",
    "ah-engine/src/meshw/heartbeat.rs:78",
    "ah-engine/src/meshw/heartbeat.rs:1047",
    "ah-engine/src/dssup/recon/pull.rs:298",
    "ah-engine/src/dssup/recon/pull.rs:302"
  ],
  "DEVSWARM_REPO_ID": [
    "ah-engine/src/hookcfg/when.rs:673",
    "ah-engine/src/hookcfg/when.rs:675",
    "ah-engine/src/hookcfg/when.rs:678",
    "ah-engine/src/hookcfg/when.rs:679",
    "ah-engine/src/hookcfg/when.rs:825",
    "ah-engine/src/wakew/who.rs:249",
    "ah-engine/src/wakew/who.rs:250"
  ],
  "DEVSWARM_REPO_KEY": [
    "ah-engine/src/meshw/clog.rs:89",
    "ah-engine/src/meshw/clog.rs:261"
  ],
  "DEVSWARM_BUILDER_TERMINAL_ID": [
    "ah-engine/src/dssup/recon/pull.rs:298",
    "ah-engine/src/dssup/recon/pull.rs:302"
  ],
  "DEVSWARM_BUILDER_TERMINAL_GENERATION": [
    "ah-engine/src/dssup/recon/pull.rs:298",
    "ah-engine/src/dssup/recon/pull.rs:302"
  ]
}
```

## Probe ['hivecontrol', '--version'] exit 0
```text
2.5.7
DevSwarm app 2.5.7 (matches hivecontrol)
```

## Probe ['hivecontrol', 'workspace', 'list', 'all', '--help'] exit 0
```text
Usage: hivecontrol workspace list all [options]

Options:
  -h, --help  display help for command
```

## Probe ['hivecontrol', 'workspace', 'list', 'children', '--help'] exit 0
```text
Usage: hivecontrol workspace list children [options]

Options:
  -h, --help  display help for command
```

## Probe ['sqlite3', '-readonly', '~/Library/Application Support/DevSwarm/devswarm.db', 'SELECT name, sql FROM sqlite_master WHERE type="table" AND name IN ("builders","builder_terminals","pull_requests","repositories");'] exit 0
```text
repositories|CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`defaultBaseBranch` text DEFAULT 'main' NOT NULL,
	`description` text DEFAULT '',
	`lastAccessed` text NOT NULL
, `defaultEditorId` text REFERENCES user_editors(editorId) ON DELETE SET NULL, `rank` integer, `jiraProjectKey` text, `githubAccessStatus` text DEFAULT 'unknown', `githubAccessError` text, `githubAccessCheckedAt` text, `defaultAiAgent` text)
builders|CREATE TABLE `builders` (
	`id` text PRIMARY KEY NOT NULL,
	`repositoryId` text NOT NULL,
	`sourceBranch` text NOT NULL,
	`branchName` text NOT NULL,
	`worktreePath` text NOT NULL,
	`aiAgent` text NOT NULL,
	`terminalId` text,
	`label` text,
	`createdAt` text NOT NULL,
	`lastAccessed` text NOT NULL, `rank` integer, `isHidden` integer DEFAULT 0 NOT NULL, `promptEditorCollapsed` integer DEFAULT 0 NOT NULL, `pullRequestId` text REFERENCES pull_requests(id), `builderType` text DEFAULT 'standard' NOT NULL, `isPinned` integer DEFAULT 0 NOT NULL, `isActive` integer DEFAULT 1 NOT NULL, `lastSelectedAt` text, `archivedAt` text, `parentBuilderId` text,
	FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
)
pull_requests|CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repositoryId` text NOT NULL,
	`branchName` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`isDraft` integer DEFAULT 0 NOT NULL,
	`url` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL, `targetBranch` text, `reviewStatus` text, `checkStatus` text, `hasComments` integer DEFAULT 0, `lastSyncedAt` text, `authorLogin` text,
	FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
)
builder_terminals|CREATE TABLE "builder_terminals" (
	`id` text PRIMARY KEY NOT NULL,
	`builderId` text NOT NULL,
	`terminalId` text,
	`terminalType` text NOT NULL,
	`aiAgent` text,
	`ai_session_config` text,
	`label` text NOT NULL,
	`displayOrder` integer NOT NULL,
	`isPinned` integer DEFAULT 0 NOT NULL,
	`isActive` integer DEFAULT 1 NOT NULL,
	`panelStatus` text DEFAULT 'new' NOT NULL,
	`createdAt` text NOT NULL,
	`lastViewedAt` text NOT NULL, `initialPrompt` text, `transcriptByteOffset` integer DEFAULT 0 NOT NULL, `transcriptLineCount` integer DEFAULT 0 NOT NULL, ingestionStatus TEXT NOT NULL DEFAULT 'idle', `initialPromptDeliveredAt` text, `initialPromptWithheldAt` text, `agentLastStartedAt` text, `agentLastExitedAt` text, `agentLastExitCode` integer, `agentLastExitReason` text, `agentLastSurface` text,
	FOREIGN KEY (`builderId`) REFERENCES `builders`(`id`) ON UPDATE no action ON DELETE cascade
)
```
