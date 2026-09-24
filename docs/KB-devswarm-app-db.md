# KB — the DevSwarm app database (v0.108.0)

anti-hall reads the DevSwarm desktop app's own SQLite database. It never writes to it. The database is the ground truth for workspace state: which workspaces are open or archived, their titles, sidebar order, the Claude session each one runs, and each workspace's pull request. Every anti-hall surface reads one shared snapshot of it (`companion/lib/devswarm-app-db.js`): the per-turn parent-inbox table, `roster`, identity checks, `doctor`, and the supervisor sync.

## Where it is

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/DevSwarm/devswarm.db` |
| Linux | `$XDG_CONFIG_HOME/DevSwarm/devswarm.db` (default `~/.config/…`) |

- `ANTIHALL_DEVSWARM_APP_DB=<path>` points anti-hall at a different file. `ANTIHALL_DEVSWARM_APP_DB=off` turns the whole integration off.
- `ANTIHALL_DEVSWARM_APP_DB_CACHE_MS` sets how long the in-process cache lasts (default 10 s).

## Contract

- **Read-only.** anti-hall opens the database with `node:sqlite` `readOnly: true`, runs a few `SELECT`s over named columns (never `SELECT *`), and closes it.
- **What it never reads:**
  - message bodies;
  - brief text (only whether a brief is present, and its length);
  - credential tables;
  - browser-profile stores.

  `tests/companion/devswarm-app-db-hygiene.test.js` fails the build if any code line names a credential table, a browser-profile store, or the app's internal HTTP/WebSocket/MCP endpoints.
- **Fail-open.** If the database, its `builders` table, or the `builders.id`/`isActive` columns are missing, the reader returns "no opinion" and every caller falls back to its pre-0.108 logic. Any other missing column or table reads as null and is listed in `snapshot.missing`. `doctor` then prints `DevSwarm app schema changed: <table.column>`.
- **Capability-gated.** Every table and column read first asks `companion/lib/devswarm-capabilities.js` `can('appdb.<table>[.<column>]')`, which checks the DevSwarm version and detects the schema at runtime. A gated read degrades the same way a missing column does and is listed in `snapshot.gated`. Every table, column and app file the reader touches is registered in the gate (`appdb.*`, `appfs.terminal-scrollback`, `appfs.sentry-session`, `appfs.scheduled-for-deletion`); a test pins `SCHEMA` ⊆ registry, and the gate checks the same DB file the reader opened. For `hivecontrol` calls the gate is default-deny: an invocation that maps to no registered capability is refused (only `--version`/`--help`/`workspace --help` are registered as ungated).
- **Schema pin.** `SCHEMA` in the module lists every column anti-hall reads. The test fixture (`tests/helpers/app-db-fixture.js`) must carry exactly those columns.

## Field semantics

Each field below was checked read-only against a live database, and against the app's source (2.5.2), before any decision was allowed to depend on it.

| Field | Status | Meaning, and the evidence for it | Used for |
|---|---|---|---|
| `builders.isActive` / `isHidden` | proven | Archive sets `isHidden=1, isActive=0`. Close sets only `isActive=0`, which is not the same as archived. Rows from before 2.3.0 carry `isActive=0` meaning "unknown", which is why archived requires `isHidden=1`. Delete removes the row. | Archived markers, parent-inbox nag suppression, `reconcile-active` gating |
| builder row gone | proven | The app deleted it; its terminals are deleted with it. | Tombstone marker `archivedBy: devswarm-app-deleted`. It applies only to a UUID descriptor with no active builder on its worktree. It is a marker, never a delete. |
| `builders.label` | proven | Equals hivecontrol's `label`, i.e. the UI title (16/16 matched). | Roster/table title, names-cache refresh |
| `builders.rank` | proven | Sidebar order within a repository; 0 is the top. It matched screenshot order. | Roster order; tiebreak in the per-turn table |
| `builders.lastSelectedAt` | proven | UI focus. It is stamped on every active-tab change. | Nags about the workspace the owner has on screen (selected within the last 2 min) are suppressed. |
| `builder_terminals.ai_session_config.sessionId` | proven, one-way | The live Claude session id. It is rewritten when the session forks (`/clear`, `/compact`). Where a transcript existed, its `cwd` equalled `worktreePath` in 129/130 cases. Only about 55% of mapped sessions still have a transcript. | Identity (anchor self-ack, `register-primary` takeover), but ONLY when Claude's own transcript `<projects>/<worktree>/<sid>.jsonl` exists and records that cwd. Otherwise it is informational. |
| current AI terminal | proven | Among open (`isActive=1`) AI terminals, the one created last. 9% of builders have more than one open AI terminal. | Session map |
| `initialPrompt` / `initialPromptDeliveredAt` / `initialPromptWithheldAt` | proven | Delivery clears the prompt and stamps `DeliveredAt` in the same write (78/78 since the app started recording delivery). `WithheldAt` plus a prompt means the brief was withheld and will be retried. Rows older than the first recorded delivery are never judged. | "brief not delivered / withheld" marker and doctor warning. The full brief text is **not** available after delivery, so it is never used for descriptions. |
| `pull_requests.state` / `checkStatus` | proven | `state` matched GitHub 6/6 and `Failed` matched failing checks 2/2. Values are Title Case. The app polls every 60 s. | Extra signal in the finish column (`PR #N merged, checks failed`). It is shown ONLY when `lastSyncedAt` is newer than the branch tip's loose-ref mtime; otherwise git ground truth stands. It never overrides the completion gates. |
| `builders.lastAccessed` | informational | A background heartbeat: all rows bump about every minute. It is not a focus signal. | Not used |
| `panelStatus`, `lastViewedAt`, `isPinned`, scrollback `.log` mtime/size | informational | Weak signals, or not proven as liveness. Only the scrollback file's mtime and size are read, never its content. | Shown in `app-state` and the `[pinned]` marker only |
| `transcriptByteOffset` / `LineCount`, `builder_terminal_transcripts` | unused | 0 on every live row. This is the app's cloud-analytics ingestion, and it lags the real file. | — |
| `builder_transcript_prompts`, `workspace_messages.message`, `workspace_messages.status` | unused | Bodies and payloads. `status` only changes on CLI reads. | — |
| `pull_requests.title` / `authorLogin` | unused | Not needed. | — |

## The runner: supervisor sync

On every supervisor tick (60–120 s), `companion/devswarm-supervisor.js` runs `appDbSyncIfDue`, which calls `scripts/devswarm.js` `syncAppState`. It takes one fresh snapshot, then:

1. `markAppArchivedDescriptors` writes an archived marker for app-archived and app-deleted workspaces. It never clobbers an existing marker and never deletes anything.
2. `refreshNamesFromApp` updates the names cache whenever the app's title differs from it. Renames used to never propagate.
3. It writes `~/.anti-hall/devswarm/app-state.json` (atomic tmp+rename) with:
   - app version, schema `missing`/`gated`, counts;
   - the open workspaces in sidebar order, with PR, brief and focus;
   - the session map for open AI terminals, each flagged `corroborated`;
   - builders open in the app that anti-hall has no descriptor for;
   - builders open in the app that anti-hall has archived (a conflict, reported only, never auto-unarchived);
   - entries in the app's `~/.devswarm/scheduled-for-deletion/` (names only).
4. **Message cross-check**, at most every 15 min. Each app `workspace_messages` row is matched to the store's native-ingested rows by timestamp; the ingest daemon stores the app's `createdAt` as `ts`, and this was verified exact. Unmatched rows are split three ways:
   - to an archived target: excluded, because nobody will read them;
   - before ingest began: history;
   - **gap**: a live target after ingest started. Gaps are broken down per branch and by age.

   Only counts and timestamps are involved. The result is a report; nothing acts on it.

Measured on a live app DB (214 builders, 82k messages): the snapshot takes about 7 ms, and a full sync including the gap scan about 105 ms warm (220 ms cold). That is well inside the 20 s per-pass budget.

`ANTIHALL_DEVSWARM_APP_SYNC=0` turns the sync off.

**There is no `fs.watch`.** The app's `-wal` file changes about every 13 s from its own background writes: heartbeat bumps, 60 s PR polling, and 500 ms transcript polling. A watcher would fire on that noise, and the supervisor is a one-shot tick with no long-lived process to host one.

## Verbs

| Verb | What it does |
|---|---|
| `devswarm.js app-state [--json]` | Read-only. Shows a fresh snapshot summary (open workspaces by sidebar rank, finish/brief/session/focus, drift, conflicts, pending app deletions, message gaps). Never writes. |
| `devswarm.js app-sync [--dry-run]` | Runs the supervisor's sync step now. |
| `devswarm.js sync-ui --titles-json <file>\|--stdin [--yes] [--no-repair] [--accept-conflicts]` | Screenshot sync (below). |

## Screenshot sync (fallback and cross-check)

The app DB is the primary source. A screenshot of the DevSwarm sidebar is only needed when the DB can't settle a question: it is unreadable, or it conflicts with anti-hall. In that case the parent-inbox hook asks for one, **once per session per set of workspaces**.

`sync-ui` plans the transcribed titles against the app DB (`companion/lib/devswarm-ui-sync.js`):

- **Normalizing.** Titles are NFKC-normalized, whitespace is collapsed, a trailing "…" is stripped from both sides, and case is folded. A title matches when one side is a prefix of the other with at least 12 characters in common.
- **Scope.** Matching is limited to the repository and excludes Primary workspaces.
- **Duplicate matches.** When a title matches more than one workspace:
  1. prefer workspaces the sidebar can show;
  2. then prefer the one whose sidebar position equals the title's position in the screenshot;
  3. if still tied, report it as ambiguous and ask the owner.
- **Safety rules:**
  - it archives only what the app DB says is archived and the screenshot doesn't show;
  - an app-active workspace missing from the screenshot is kept;
  - if the DB is unreadable, it archives nothing;
  - both conflict kinds refuse `--yes` until `--accept-conflicts` is passed;
  - title updates write the app's full label, never the screenshot text;
  - nothing is ever deleted.

Titles are no longer truncated at spawn (`deriveTitleFromBrief` keeps the full first line). A stored label that still ends in "…" was cut by an older version, and `sync-ui` reports it as `truncatedAtSpawn`.

Not verified: whether a pasted image shows up as `[Image #N]` in a `UserPromptSubmit` prompt. So no hook reacts to images. The skill is triggered by what the owner writes.

## Never used

- The app's local HTTP API on `127.0.0.1:47836`, including `/api/*`, the `/ws` WebSocket, and `POST /mcp`. On 2.5.2 it was unauthenticated and some routes are destructive (`DELETE /api/workspace/:id` has no guard); on 2.5.3 `/api` answers 401 (auth required). Either way anti-hall never calls it, and the hygiene test enforces this.
- `hivecontrol workspace check-merge`. It can create a worktree as a side effect.
- `hivecontrol workspace search`. It is a cloud knowledge search, not local state.

## DevSwarm 2.5.3 notes (verified on a live 2.5.3 install)

- **Schema:** 55 app migrations (53 on 2.5.2). The `builders`, `builder_terminals`, `workspace_messages` and `pull_requests` columns are unchanged, and archive semantics (`isActive=0, isHidden=1`) are unchanged. Four new tables track terminal process ownership: `builder_process_owners`, `claude_session_mutation_cleanup`, `terminal_process_claims`, `terminal_process_owners`. anti-hall does not read them. Nothing in anti-hall pins a migration count.
- **Auto-resume:** after an app restart, DevSwarm relaunches every AI terminal whose `builder_terminals` row is active and `panelStatus='resumable'` as `claude --resume <sessionId>`, where `<sessionId>` is that row's `ai_session_config.sessionId`, with the builder's `worktreePath` as cwd. So after a restart the session map still points at the live sessions.
- **`hivecontrol workspace archive|delete [idOrBranch]`:** the argument is optional and defaults to the CURRENT workspace; there is no `--yes`, no prompt and no cwd requirement. anti-hall always passes the explicit workspace UUID and makes no call when it has none (`companion/lib/devswarm-lifecycle.js` `verbArgv`). Both verbs are gated at `minVersion` 2.5.3.
- **`workspace list`** is now documented next to a new `workspace children` command; `workspace list all` still works.
