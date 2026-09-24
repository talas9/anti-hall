# DevSwarm layered recovery — version history (archive)

Moved verbatim out of `docs/GUIDE.md` in v0.108.0 so the guide reads as current state.
This is dated changelog/defect narrative (v0.54–v0.107): what shipped and why, at the
time. It is frozen — never edited to match current code. Current behaviour:
[`docs/GUIDE.md`](../GUIDE.md#devswarm-current-state), [`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md),
[`docs/KB-devswarm-app-db.md`](../KB-devswarm-app-db.md), and per release [`CHANGELOG.md`](../../CHANGELOG.md).

## DevSwarm layered recovery — full history

Moved from README.md's "DevSwarm layered recovery" section (v0.107.0 doc sweep).
This is dated changelog/defect narrative — it records what shipped at the time;
current guidance lives in [docs/KB-devswarm-hivecontrol.md](../KB-devswarm-hivecontrol.md).

## 🐝 DevSwarm layered recovery (companion, opt-in and OPTIONAL)

**DevSwarm coordination is entirely optional.** anti-hall's core — the verify-first
protocol, the mechanical guards, the statusline, `doctor`, `update`, etc. — works fully
**without** DevSwarm. Everything below is dormant with zero behavioral change unless a
DevSwarm session is active (`DEVSWARM_REPO_ID` set) and/or one of its own opt-in
companions (the ingest daemon / the liveness supervisor) is installed; nothing else in the
plugin depends on it.

**All DevSwarm features, at a glance** (detail below; full reference:
[`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md) §8):

- **DevSwarm app database as ground truth (v0.108.0)** — one read-only, fail-open,
  capability-gated snapshot of the desktop app's own DB drives:
  - archived and deleted-in-app markers (never a delete);
  - full titles (no 60-char spawn cap; app renames propagate);
  - sidebar order and pins;
  - the PR finish signal;
  - "brief not delivered" warnings;
  - on-screen nag suppression;
  - transcript-corroborated session identity.

  The supervisor syncs it every tick, and a message-gap cross-check lands in `doctor`.
  `devswarm.js app-state` shows it all. A sidebar screenshot (`sync-ui`) is only the
  fallback for when the DB can't settle something. On DevSwarm 2.5.3 the app relaunches
  every resumable AI terminal after a restart as `claude --resume <sessionId>` (the same
  session id the app DB maps), so the session map stays valid across app restarts. Details:
  [`docs/KB-devswarm-app-db.md`](../KB-devswarm-app-db.md).
- **Layered recovery, never-auto-kill** — a wedged child self-reports idleness, a
  supervisor **pokes** it, then **escalates to the parent**; the only path that ever kills
  a process is the separate, on-demand `devswarm-recover.js` CLI. Delivery of that
  escalation still requires the Primary to have self-registered from the true main
  worktree — see the v0.67.1 bullet below for the known gap when it hasn't.
- **Human-readable workspace names (v0.67.0)** — `devswarm.js spawn` titles a new
  workspace from its `-p` brief via a separate best-effort `hivecontrol workspace
  update-title` call (a caller-supplied `-t/--title` is never overridden); the parent's
  per-turn status table now shows `name (shortid)` instead of a bare UUID, reading a
  shared fs cache (`companion/lib/devswarm-names.js`) that never spawns `hivecontrol` on
  that hot path.
- **Supervisor escalation actually delivers, plus a cross-repo hijack guard (v0.67.1)** —
  fixed four stacked defects that had kept the escalate-to-parent path above from ever
  delivering end-to-end (stale post-append projection, wrong-bucket store open, parentId
  derived from the child's own worktree instead of the resolved main worktree, and two
  fold/rehome paths skipping their projection refresh); hardened the roster's native fold
  with a cross-repo `repositoryId` check against a cwd-anchored ground truth (drops +
  logs mismatches, fails open unfiltered) — a new guard, not a repair of a prior break.
  **Known remaining gap:** an escalation that lands in `orphans[]` (no live registry row)
  is surfaced by the informational parent-inbox hook but not by the blocking parent-gate
  hook, so a Primary can `Stop` unblocked on an escalation the inbox hook is showing.
- **Parent decide+reply gate, no more silent nag-out (v0.69.0)** — the Stop-gate could
  previously be satisfied by a Primary merely *reading* a child's blocking `--question`; it
  now requires an OBSERVED reply. A new `devswarm-parent-reply-tracker` hook (PostToolUse,
  Bash) records a successful `send --to <id> --question` into a durable, per-project
  reply-state file (`companion/lib/devswarm-reply-state.js`, repoKey-keyed so it survives a
  read/ack and new Claude sessions); the forced-ack cap can no longer silence an unanswered
  question forever — once exhausted it escalates once instead of going quiet, and every
  Primary turn re-asserts the obligation. `recordReply`'s read-modify-write is now
  lock-protected after a reproduced race lost entries under concurrent writers. New
  persisted shape: a `needs_reply` column on mesh rows, backfilled via an additive/
  idempotent/fail-open `ALTER TABLE ADD COLUMN` that runs on every store open (both the
  `update` path and `doctor` self-tests exercise it). Hardened via a 6-round deadly-loop.
- **Child self-continue directive (v0.69.0)** — a child in a multi-round autonomous task
  (deadly-loop, iterative fix waves) now gets a per-turn nudge to keep issuing tool calls
  across rounds within the same turn instead of ending its turn to "check in", cutting the
  wake-cycle (supervisor cron) latency that cost every time it idled between rounds. Shared
  verbatim with the Codex port.
- **Mesh/store message-loss fix (v0.70.0)** — `archive` used to tombstone exactly one
  registry row per generation, so a re-archived-and-reregistered worktree could still hold
  LIVE sibling rows sharing it, and a real unanswered question could forward into one of
  those dead partitions. `foldArchivedRegistryRows` now folds ALL same-worktree rows for an
  archived id and picks the forward survivor by LIVENESS; it's a dual-path migration wired
  into both `update` and `doctor --fix` (idempotent, fail-open-honestly, no-delete — message
  rows are never deleted, only registry rows are tombstoned after their unread forwards).
- **Archived-row read filter + archive self-heal (v0.70.0)** — a new read-side filter
  excludes a genuinely archived workspace from the LIVE per-turn injection immediately,
  without needing a `doctor` run first; an archived workspace with real unread still
  surfaces as an orphan (no lost signal). `archive` also self-heals a stale
  `archived/<id>.json` leftover from a prior generation (decided by inode, fail-closed on
  any incomplete scan) instead of permanently wedging re-archive of that id. The per-turn
  parent-inbox STOP wording is now advisory for the normal tier (urgent/high tier
  unchanged).
- **DevSwarm `archive` shortId/prefix resolve (v0.70.1)** — `archive <id>` now also
  resolves an unambiguous shortId/prefix (the same short form shown in the roster/
  injection table), so the id displayed there is directly archivable; an ambiguous
  prefix archives nothing and lists the candidates instead. `isSafeId` still gates
  (no `/`); exact-id behavior is unchanged.
- **Append-only reply-state redesign (v0.71.0)** — DevSwarm parent decide-gate reply
  state moved from a lockfile read-modify-write to an append-only JSONL log
  (`recordReply` = one `O_APPEND` write, no lock; `readReplyState` folds the log,
  fail-closed newline separator, 480-byte record cap, `Object.create(null)` fold
  accumulator so a `__proto__`-named sender survives). Loss-safe forward migration
  wired into both `update.js` and `doctor --fix`. Structurally eliminates the
  disclosed steal-branch TOCTOU.
- **Emoji-as-signal rule propagated to subagents + Codex (v0.71.0)** — Rule K (status
  glyph as SIGNAL, never decoration) now also injected at `SubagentStart` and in the
  Codex orchestration skill, not just the orchestrator's `SessionStart`.
- **Test-store-leak hardening + read-only leak audit (v0.71.0)** — fixed 4 doctor
  tests' `HOME`-default landmine; added a READ-ONLY store audit/classifier
  (REAL/GARBAGE/UNKNOWN) and a leak-report CLI whose `--out` is guarded (realpath
  canonicalization, `O_EXCL`/`O_NOFOLLOW`, a distinctive marker) so it can never
  overwrite a production `devswarm.db`. Detection-only — never deletes.
- **`register-primary` records the real Claude `session_id` (v0.71.0)** — `--session`
  now defaults to `CLAUDE_CODE_SESSION_ID` (was the workspace hash), so Primary rows
  resolve their transcript for liveness reads.
- **Partition resolution follows the WORKSPACE, not the caller's cwd (v0.84.0)** —
  `inbox read-primary`/`inbox count` used to resolve the store partition from the
  directory the command ran in, so a Primary could be gate-blocked on mail it
  structurally could not see, and running the gate's own prescribed command from the
  wrong directory risked writing a cursor into another project's partition. Both the CLI
  and the Stop hook now resolve through ONE shared helper
  (`companion/lib/devswarm-repokey.js` `registeredRepoKey`; precedence fresh key →
  recorded `repoKey` → non-hash `ownerKey`), so they can no longer disagree about which
  workspaces a session owns. In the same change: `gate`/`ensure`/`archive` no longer
  re-home a foreign project's workspace BEFORE their ownership guard runs (a refused call
  now writes nothing — `archive` had been removing the live descriptor); `inbox ack` on a
  workspace the caller doesn't own no longer advances the cursor past unread mail; and
  `inbox count`/`read` report `known:false` with the named `registeredRepoKey`/
  `callerRepoKey` instead of a silent zero that reads like "no mail".
- **Archived-stranded orphan partitions no longer warn (v0.84.0)** — the orphan detector
  counted an archived child's own outbox copy as unread-with-no-reader, so the Primary saw
  a permanent, unactionable warning every turn. It now excludes exactly the set
  `healOrphanPartitions` classifies as `unhealable/archived-no-family`, by CALLING heal's
  own exported helpers (`companion/lib/devswarm-orphan-policy.js`) rather than
  re-implementing the rule — an equivalence test fails CI if the two predicates drift. The
  excluded ids move to a quiet `archivedStranded[]` on the summary rather than being
  dropped, and the classifier fails open (it can only quiet a warning it positively proved
  unactionable).
- **Defect fields are no longer silently truncated (v0.84.0)** — the shared clamp cut
  over-length values at their cap and returned plain success with nothing in the result or
  the record to show text was lost. Truncation is now named in `scripts/defect.js`'s JSON
  result and on stderr and marked inside the stored value (`[truncated from N chars]`),
  and the caps for `note` (300 → 1200), `claimed`, and `observed` were raised — bounded so
  a maximum-length field still cannot push a record past `MAX_LINE_BYTES`. The write never
  fails.
- **Archive retires the whole identity family (v0.85.0)** — `archive` tombstoned by
  `<id>` only, but a descriptor's identity family can be cross-linked by `sessionId`
  instead (one row's `sessionId` IS the other row's `id`), so the twin stayed live in
  `workspaces/` after its sibling was archived and the Stop gate nagged every turn about
  an inbox that, by design, could never exist — un-clearable without editing state by
  hand. `cmdArchive` now retires the whole family at archive time, and
  `foldArchivedFamilyDescriptors` folds sets already split by the bug (a forward
  migration wired into BOTH `update` and doctor's AUTO-SAFE
  `fold-archived-family-descriptors` repair) — the descriptor-file counterpart of
  v0.70.0's registry-row `foldArchivedRegistryRows`.
- **The parent gate tells a dead descriptor from neglect (v0.85.0)** — the old rule was
  that `known:false` on the unread read ALWAYS blocked, unconditionally, including an
  absent inbox file; that absolute was the defect. An `inbox-missing` (ENOENT, and only
  ENOENT) on a descriptor whose `worktreePath` is ALSO provably gone no longer raises the
  unknown axis, because no action the Primary can take would ever clear it. Nothing is
  hidden: store-side unread still blocks on `unionUnread`, a stale/escalated verdict
  still blocks, and every other unreadable reason (`inbox-unreadable`, `cursor-*`,
  `no-inbox-path`, `read-threw`) still blocks regardless of the worktree. "Gone" requires
  a definitive ENOENT `lstat` on an ABSOLUTE path — a relative/missing path, a dangling
  symlink, or a stat that failed for any other reason is NOT provably gone and still
  blocks.
- **A descriptor is retired only against PROVEN write authority (v0.85.0)** — every
  descriptor writer publishes by atomic rename, which installs a NEW INODE at the same
  pathname, so a retire that classified a twin at scan time and unlinked it by pathname
  could destroy a freshly-registered LIVE descriptor. Retirement now re-reads a coherent
  inode+bytes generation fingerprint INSIDE the per-id lock and compares it against the
  scan-time snapshot; `devswarm-child-turn.js` takes that same per-id lock around its own
  descriptor rename (bounded ~1s, fail-open, no nested acquisition); and the migration
  path is additionally gated on `worktreeIsProvablyGone`. A mismatch or unproven
  gone-ness REFUSES the retire rather than guessing, and a one-way historical identity
  link is never by itself sufficient authority. Grouping uses the id/`sessionId`
  cross-link only, never bare worktree equality, so two legitimately-live tabs on one
  worktree are never retired. Safety refusals surface through `update`'s summary and a
  doctor `notice` instead of reading as a clean no-op.
- **Daemon units now ship a PATH that can resolve their own interpreter (v0.86.0)** — the
  ingest/supervisor installers bake an ABSOLUTE node path as the unit's interpreter
  (`process.execPath`, commonly a version-manager dir on no scheduler's default `PATH`)
  but built the unit's `PATH` from the `hivecontrol` dir plus a minimal fallback only. The
  daemon itself always started and looked healthy (absolute `argv[0]`), while
  `hivecontrol` — a SCRIPT whose shebang re-resolves `node` THROUGH `PATH` — died on every
  grandchild spawn with `env: node: No such file or directory`, exit 127: 23,928
  occurrences over 1,757 supervisor sweeps across three repoKeys, `healed:0` on every one,
  i.e. reconciliation had never once succeeded. Fixed at the single chokepoint all six
  plist/service/cron emitters derive from — `unitEnvFor` prepends `dirname(execPath)` and
  takes `execPath` as a REQUIRED argument, so a unit's `PATH` structurally cannot disagree
  with the interpreter baked into it. Install refuses if that node binary is not a real
  file, and a unit whose `hivecontrol` could not be resolved now still gets a
  node-resolving `PATH` instead of no environment at all.
- **Auto-heal can now fire when it is actually needed (v0.86.0)** — `update.js` only
  attempted `healIngestDaemon` on a run that had synced new bytes into the version cache.
  But a daemon's baked script path goes stale with NO version bump (the plugin manager
  relocates the version-pinned cache dir it was built from) — exactly the case the heal
  exists for — and in that steady state `syncCache` no-ops and the classifier that would
  spot the dangling path never ran. The heal now also fires when the installed unit fails
  to classify `ok`, through the same lookup the heal action itself uses so the decision and
  the action cannot disagree. Read-only and fail-open on a no-sync run; `absent` is
  deliberately excluded, so a no-op update never first-installs an opt-in daemon.
- **The store leak report is now genuinely read-only (v0.86.0)** —
  `devswarm-store-leak-report.js` promises in its own banner that it modifies nothing, then
  defaulted `--out` to a timestamped path and wrote a JSON file on every invocation. The
  file is now opt-in: no `--out`, no write. All `--out` safety (realpath containment,
  `.json` requirement, `O_EXCL`/`O_NOFOLLOW`, report-marker check) is unchanged, and the
  analysis logic is untouched.
- **A stale/escalated verdict alone can no longer hard-block the Primary indefinitely
  (v0.87.0)** — `escalated` is STICKY (`liveness.js`'s terminal short-circuit returns it
  unchanged until a fresh heartbeat a finished session will never emit again), so a
  verdict of `{"status":"escalated","pending":false,"notDraining":false}` — the verdict
  itself saying nothing was outstanding — force-blocked the Primary on ~20 consecutive
  turns, because the gate read only the bare `status` string and discarded the verdict's
  own `pending`/`notDraining` flags. A bare `stale`/`escalated` status now needs
  corroboration from at least one of four independent axes (the verdict's own `pending`
  flag, a real union-unread backlog, an unreadable unread axis — fail-open toward
  blocking — or an unanswered question from that family) before it can drive a hard
  block; an uncorroborated status degrades to a one-time stderr advisory instead. A bare
  verdict label is not evidence — see [`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md) for the
  generalized invariant.
- **Liveness's own union-unread signal no longer double-counts a caller's own outbound
  message as evidence a target is neglecting inbound work (v0.87.0)** — `resolveSelfId()`
  resolves the caller's real Primary id (mirroring the addressee-hash fix `recovery.js`
  already carries) and excludes store-only rows sent by that id from the staleness gate.
- **DevSwarm wake is count-first (v0.87.0)** — the wake instruction used to tell an agent
  to run the full mailbox drain+read sequence every turn, which the agent's own cron
  prompt routinely delegated to a subagent even on an empty mailbox. It now runs the
  cheap, inline `inbox count` first and only pays for a drain/read when `unreadTotal > 0`.
- **The durable-inbox ack cursor is monotonic by default (v0.87.0)** — `ackTo()` was
  callable unlocked from multiple sites, so two overlapping drains could race a cursor
  backward and cause re-delivery. There is no rewind path: the one former exception
  (a MIN-only cross-namespace reconciliation, `allowRewind`) was deleted in the
  mesh-redesign Phase 3 read-position model below.
- **One table of read positions (mesh redesign Phase 3)** — every read position lives in
  ONE `reader_cursors(partition, ns, reader, value, retired_line, updated_at)` table per
  store (sqlite table, or `reader_cursors.ndjson` under a lock file on the journal
  backend). A reader is the nearest harness ancestor (`h:<pid>:<startMs>`); a headless
  caller (Codex, CI) reads the stored floor only. Writes are max-only, an ack and the floor
  update share one transaction, and a reader leaves the floor's MIN only when a process
  snapshot proves it ended (the session file is never evidence). Every unread count goes
  through one `countFor`; a read error is UNKNOWN (gates block with the reason), never 0.
  Legacy cursor files are imported once (`update`, `doctor --repair`, or lazily on first
  ack), never deleted, and kept dual-written upward for one release.
- **A fold pass now advances a folded-away candidate's own cursor (v0.87.0)** once its
  unread rows have fully forwarded to the survivor, so an already-forwarded backlog on a
  `left` candidate stops rendering as permanently "not draining"; a partial/failed
  forward still leaves the cursor untouched for a safe idempotent re-forward.
- **The orphan-entry classifier now checks drained state, not just forwarded state
  (v0.87.0)** — a forwarded entry that was later drained is not an orphan.
- **Per-project mesh store** — one shared store per project keyed by a stable `repoKey`,
  so any worktree can message any other directly; **#36-STRUCTURAL scoping** closes a
  spoofable cross-project bleed.
- **Mesh messaging CLI** (`scripts/devswarm.js`) — `send --to <meshId>|--to-primary|
  --broadcast [--urgency low|normal|high|urgent] [--question]`, `roster` (also folds in
  unregistered native `hivecontrol` children), `mesh read`, `heartbeat --summary`, `inbox
  pull/read/read-primary/ack-primary/peek-primary` (`read-primary` is read-only and returns
  a `readReceiptId` + `ackCommand`; `ack-primary --receipt <rid>` is the ack, run after the
  mail is handled — drain = read, consume, ack; `drain-primary-legacy` keeps the old one-call
  read-and-ack for one release; `peek-primary` is the plain non-acking unread view).
  Every message row carries `{from, to, type, message, timestamp,
  urgency}`. `--question` marks a direct send as a blocking decision-request — rejected on
  `--broadcast`. The blocking/reply-tracking guarantee (Stop-gate + `recordReply`) is
  enforced when the recipient is the Primary; a peer child→child `--question` is
  delivered and flagged (`needs_reply`) but is not gate-enforced on the recipient side.
- **Mesh self-heal (v0.61.0).** Drain-aware routing delivers to the partition a child
  actually drains, plus a phantom-only rescue on a child's first registration; a pure
  `computeSummary` projection derives `orphans[]` (unread partition, no live workspace)
  and `staleRegistryPartitions[]` (registry row whose worktree is gone); new read-only
  `diagnose` and `healthcheck [--json]` (pass/fail, exit 0/2, for monitors/CI) verbs;
  register-time dedup with an `isForwardable` noise filter (forwards only real directs,
  never poke/hash-mirror junk); `foldMeshDuplicates` migrates every prior store shape
  (phantom/dual/subdir-split/stale) onto one canonical git-toplevel identity, wired into
  both `update` (post-update) and `doctor`'s auto-safe repair (dry-run doubles as a
  read-only mesh-shape check); `roster`/`workspaces list`/`diagnose` are now pure reads
  (no `summary.json` write side-effect); orphans/stale partitions surface to the Primary
  via `devswarm-parent-inbox` (capped, read-only).
- **Mesh self-heal follow-ups (v0.62.0).** `unarchive <id>` reverses `archive`; a new
  `migrate-owner-keys` forward-migration backfills/re-homes a descriptor's `ownerKey`
  (idempotent, fail-open, no-delete; wired into `update`/`doctor`); `reap-stale
  [--yes|--confirm]` dry-run-reaps descriptors verdicted stale/escalated, gated by a
  fresh-heartbeat/recent-git-activity safety check; `reconcile-active [--active id,...]
  [--allow-empty] [--stdin] [--yes|--confirm]` archives a current workspace of a
  project that is NOT in an explicit "still active" set, but since v0.107.1 only when the
  DevSwarm app's database confirms it is archived.
- **Mesh usability + self-heal (v0.63.0).** `send --to` now accepts the roster `id` (not
  only the internal meshId), falling back from a meshId match to an exact registry-`id`
  match with an `ambiguous-recipient` fail-closed guard; `roster` surfaces each row's
  `meshId`. `reconcile` gained a `healRegistry` pre-pass that corrects a mis-keyed
  registry row in place or rehomes one physically in the wrong store (no-delete,
  message-preserving, idempotent) instead of silently rejecting it; the aggregate `ok`
  now requires `rejected===0`. A wedged-but-alive ingest daemon whose own heartbeat is
  confirmed stale is SIGKILLed and its lock reclaimed (never a fresh-heartbeat daemon).
  New structured JSONL logger (`companion/lib/anti-hall-log.js`, fail-open,
  size-bounded/rotating) wired into ingest/lock/parent-inbox error paths.
- **Self-heal reliability + observability (v0.64.0).** `rehomeMiskeyedRow` normalizes a
  mis-keyed row's stored `worktree_path` to the descriptor's verified current path before
  rehoming, so `healRegistry` no longer no-ops on a legacy bare-hash store on the first
  pass. `doctor --fix` now gates ingest-daemon health on the two-signal liveness check
  (fresh heartbeat + live-pid lock) instead of install-shape alone, taking the reinstall
  path with a distinct dead-daemon reason when install-ok-but-dead. The structured logger
  is now wired across ingest/lock/send/reconcile/inbox/register error paths (including a
  previously-swallowed top-level catch), with two read-only surfaces to query it:
  `devswarm.js logs` (filter by `--repo`/`--component`/`--min-level`/`--since`/`--limit`)
  and `doctor --logs`. `inbox messages --ack-as-owner` without `--ack` now warns it did
  NOT ack instead of silently staying read-only.
- **Daemon reliability + honest health (v0.65.0).** Root-caused an ingest daemon that was
  RUNNING but ingesting nothing: it spawned `hivecontrol` by bare name under the service
  manager's minimal `PATH` and failed every cycle with a swallowed ENOENT. The binary is
  now resolved at install time and baked into the generated launchd/systemd/cron unit
  (never a hardcoded path). ENOENT/EACCES/ENOTDIR now escalate through a capped backoff
  instead of storming the log, while the heartbeat keeps writing. Orphaned ingest locks
  self-heal on daemon start (positive OS confirmation required before any removal); the
  new `doctor --reclaim-ingest-lock` is an explicit, opt-in sweep-and-reinstall path,
  never automatic. The heartbeat now records the monitor outcome, so an alive-but-failing
  daemon is reported as a `doctor` FAILURE and surfaced by a one-line in-session banner
  instead of reading as healthy; a heartbeat missing these fields (pre-upgrade daemon) is
  treated as unknown, never a fault. Install now also detects a memory-guard/reaper
  script that would kill the service-managed daemon and reports the exact allowlist entry
  to add (detect-and-report only). Separately, a DevSwarm child now forwards a decision to
  its parent with its recommendation and default, keeps working every other item, and
  proceeds on that default if unanswered — never blocking the swarm on a question; only an
  unauthorized destructive action is a hard stop.
- **Loss accounting + one health definition + honest success shapes (v0.66.0).** A
  monitor batch that arrives but fails to parse (shape change, stderr contamination, a
  truncating timeout) is now logged and quarantined to disk instead of silently vanishing
  via the consume-on-read native queue; a well-formed empty result is still normal. Doctor
  no longer asserts health from a weaker second definition that omitted the pid guard and
  monitor-fault check — reaping now uses the one shared `daemonHealth` definition
  everywhere. Project identity now resolves via the git superproject from inside a
  submodule and refuses on an unresolvable context instead of quietly keying off the
  submodule or falling back to a legacy store. `heartbeat`, `reconcile`, and other paths
  no longer report `ok` while a mesh broadcast failed or individual targets crashed/timed
  out; a genuinely absent hivecontrol is a benign skip, not a failure. A cooldown-gated
  reconcile sweep now runs on its own on the existing supervisor (same single-consumer
  lock as the drains) instead of waiting for an update or manual repair. `devswarm logs`
  and `doctor --logs` now read rotated log history; the rotation lock records its owner
  instead of being stolen on age alone; the Primary's own unreadable inbox is surfaced
  instead of silently counting zero; the singleton supervisor unit now carries the same
  resolved `hivecontrol` path as the per-project units.
- **Guard-blocked native messaging** — `hivecontrol workspace message-child`/
  `message-parent` are unconditionally blocked and redirected to the mesh CLI, which is
  the sole agent-initiated messaging transport once DevSwarm is active.
- **Per-turn communication override + mesh-poll resting posture** — every role gets a
  per-turn reminder to poll the mesh instead of idling.
- **Idle self-wake (v0.59, `CronCreate`)** — no external signal can wake a genuinely idle
  Claude Code session
  ([anthropics/claude-code#44380](https://github.com/anthropics/claude-code/issues/44380)),
  so a SessionStart directive now tells a Claude workspace to self-schedule its own
  recurring mailbox-drain via the `CronCreate` tool (the only primitive that fires while
  the REPL is idle) — default `*/5 * * * *`, tunable via `ANTIHALL_DEVSWARM_WAKE_CRON`
  (validated against a strict cron charset; not a mechanism anti-hall itself runs). A
  bounded Stop-gate re-verify on both `devswarm-child-gate` and `devswarm-parent-gate`
  re-creates the job if it has auto-expired (recurring cron tasks self-delete after 7
  days). Claude-only by construction (`CronCreate` is a Claude tool); a Codex/non-Claude
  workspace gets the honest fallback instruction instead (drain every turn) and is never
  told to call a tool it doesn't have.
- **Workspace-tier orchestration doctrine (v0.59)** — a DevSwarm **Primary** is now
  proactively directed, at SessionStart and at both guard-block points, that its top
  fan-out tier is a **child workspace** (`devswarm.js spawn <branch> -p "<brief>"`), not a
  subagent. Injected doctrine only — there is no mechanical scale classifier (a false
  positive would break legitimate subagent use); the choice is the model's. A DevSwarm
  **child** workspace and any **non-DevSwarm** session see byte-identical behavior to
  before.
- **Thin lifecycle wrappers** — `spawn`/`merge` wrap `hivecontrol workspace create` /
  `check-merge`+`merge-into-source`, then auto-register/broadcast the result to the mesh;
  `reconcile` one-shot-drains every registered worktree's inbox (e.g. after a daemon
  outage) — auto-run since v0.58.1 by `doctor --fix` (GATED) and by `update`
  (DevSwarm-session-only), with the manual verb still available.
- **`archive-request`** — a direct store write asking a child to archive itself;
  archiving stays a human-confirmed handoff on both sides, never mechanical.
- **Supervisor escalate-on-urgent + liveness** — the opt-in supervisor also escalates to
  the parent on a high/urgent mesh unread; it still never kills anything itself. As of
  v0.67.1 this path actually delivers end-to-end (four stacked defects fixed — see above);
  delivery still requires the Primary to have self-registered from the true main worktree,
  else the escalation lands in `orphans[]` and only the informational parent-inbox hook
  (not the blocking parent-gate hook) surfaces it.
- **Optional per-project ingest daemon** — the one native consumer wrapping `hivecontrol
  workspace monitor` into the shared store, installed per project via
  `companion/install-devswarm-ingest.js`.

A second **interval companion** (not a hook), dormant with zero effect unless
[DevSwarm](https://devswarm.ai) is actually in use — feature-gated exactly like the OMC
integration above. It works around a `claude` session silently wedging (process alive,
listener dead, claude-code#39755) with three escalating layers, **none of which ever
kill anything**: a child workspace's own idle self-report, a supervisor **poke** (an
optional descriptor-supplied command) on a detected-stale workspace, then an
**escalate-to-parent** signal once the poke budget is exhausted (as of v0.67.1 this
signal actually reaches the parent's projection end-to-end — see the at-a-glance bullets
above for the four fixes and the remaining self-registration precondition). Killing lives
separately, on-demand only:

```bash
node plugins/anti-hall/companion/install-devswarm-supervisor.js              # install the automatic poke/escalate sweep
node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall  # remove
node plugins/anti-hall/companion/devswarm-recover.js <workspace-id>          # on-demand: the ONLY path that ever kills
```

macOS + Linux run the full sweep; **Windows is detection-only** for the automatic path,
and the on-demand CLI is escalate-only there too (the cwd confirm-gate that makes the
kill safe isn't obtainable in pure Node on Windows). anti-hall ships only the generic
supervisor — a DevSwarm-aware consumer publishes the workspace descriptor it sweeps.
Sweep thresholds are env-tunable (seconds; clamped, invalid/absent falls back to the
default): `ANTIHALL_DEVSWARM_IDLE_SEC` (900), `ANTIHALL_DEVSWARM_COOLDOWN_SEC` (600),
`ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` (2), `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` (180),
`ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` (120); the on-demand CLI resolves its own
`ANTIHALL_DEVSWARM_MAX_RECOVERIES` (3) and `ANTIHALL_DEVSWARM_GRACE_SEC` (5). See
[`plugins/anti-hall/README.md`](../../plugins/anti-hall/README.md#opt-in-companion-devswarm-layered-recovery-macos--linux-full-windows-detection-only).
**v0.100.0** adds three more, all on the per-turn parent-inbox injection:
`ANTIHALL_ROSTER_HIDE_ARCHIVED` (default on; `0` shows archived rows in the roster table
again), `ANTIHALL_ROSTER_MAX_ROWS` (default 12, the roster table cap), and
`ANTIHALL_BROADCAST_MAX_AGE_MS` (default 24h, drops a `recent[]` broadcast older than
this from the injection).

Alongside the recovery companion, anti-hall ships a generic, project-agnostic **DevSwarm
coordination substrate** — also dormant unless DevSwarm is in use — that turns the
"Primary silently neglects its child workspaces" failure into a mechanical one. Four
feature-gated hooks are the trigger: `devswarm-parent-inbox` (surfaces each turn the real
unread/idle state of active workspaces + recommends archiving a completed one, plus a
live per-turn status table of every active workspace — status/finish-rate/unread/
last-activity, attention-needing rows first; capped at `ANTIHALL_ROSTER_MAX_ROWS`, default
12 — **v0.100.0:** an `archived` row is now dropped BEFORE that cap so it can never push a
live row into overflow, reported instead as a "+N archived" note,
`ANTIHALL_ROSTER_HIDE_ARCHIVED=0` restores the old behavior; the advisory `recent[]`
broadcast feed is now body-truncated to 200 chars, age-capped at
`ANTIHALL_BROADCAST_MAX_AGE_MS` (default 24h), and deduped per session so the same
broadcast no longer repeats verbatim every turn) and `devswarm-parent-gate` (blocks the
Primary from ending a turn while a child has REAL unread backlog — as of v0.61.1, noise
like a mirrored `[Primary poke]` is excluded via a shared classifier, closing a
ghost-workspace nag loop — or the supervisor judged it stale/escalated, except (v0.62.0)
a fresh heartbeat now overrides a stale/escalated verdict as definitive proof-of-life
**OR the Primary itself has unread parent/peer messages of its own**,
with the same imperative "STOP and read them FIRST" wording as the child gate — as of
v0.56.0 the Primary can no longer silently sit on its own inbound) on the Primary; `devswarm-child-turn` (turn-authored heartbeat +
reminder to report to the parent, plus a non-destructive surfacing of unread parent
messages from the child's own durable inbox — the drain that fills that inbox is the
CLI's `inbox pull`, a bounded guard-safe one-shot: non-destructive `message-count` gate
first, then at most one bounded `read-messages`, never `monitor` — surfaced as IMPERATIVE
PRIORITY wording, plus detection of a `[[ANTIHALL_ARCHIVE_REQUEST]]` marker in an unread
message, and mechanical per-turn descriptor registration so the parent can always discover
this child) and `devswarm-child-gate` (forced self-report before idling; v0.54.0's
heartbeat-freshness silencing was REVERTED in v0.54.1 — it false-silenced a child that
worked <5 min then stopped without reporting, so the gate always demands a report per
unchanged blocking state, bounded only by the per-episode cap `MAX_BLOCKS = 2`; STRICT mode
backs the durable-inbox check with a bounded native `message-count` probe) on a child. Two
roles hand off teardown, never mechanically: the Primary verifies merged/tested/deployed
per its own repo policy, then `devswarm.js archive-request <id>` asks the child to archive;
the child confirms with its own user, then runs `devswarm.js archive <id>`. They sit over a
dual-backend store
(`companion/lib/devswarm-store.js` — feature-detects `node:sqlite`, else an NDJSON
journal; hooks read only its `summary.json` projection, never the DB), a structured CLI
(`scripts/devswarm.js` — register/register-primary/heartbeat/inbox
[pull/read/count/ack/messages/read-primary/ack-primary/peek-primary/drain-primary-legacy]/workspaces/gate/nudge/archive/archive-request/migrate;
**v0.100.0:** every verb now recognizes `--help`/`-h` (and a bare `help [verb]`),
intercepted BEFORE dispatch so it can no longer fall through to real execution —
previously `migrate -h` ran the migration and `merge --help` sent a live mesh
broadcast;
see [`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md) §8.8 for the full reference), a PER-PROJECT ingest
daemon (`companion/devswarm-ingest.js`, the one native consumer wrapping `hivecontrol
workspace monitor` into the store — install ONE per repo/worktree you want covered, via
`companion/install-devswarm-ingest.js`; auto-installed/refreshed by `/anti-hall:update`
inside an active DevSwarm session, but only for the repo the update runs in), and
auto-safe migration (idempotent, non-destructive, count-verified). Every raw
shell/`Read`-tool access to the durable inbox/store files (bypassing the durable
cursor) is guard-blocked in favor of the CLI. anti-hall stays agnostic: the
consumer owns its done-contract and calls the generic CLI. Run
`/anti-hall:system-briefing` for a live, derived map of the whole system.

**v0.57 mesh (SHIPPED in v0.58.0; Claude-side only — Codex/OMX mesh support is
deferred to v0.57.1).** Every worktree of one project now shares a SINGLE store keyed by
a readable `repoKey` (`sanitize(repo-name)-<6hex>` of the git common-dir's realpath, stable
across every linked worktree, hardened for Windows short-name/casing quirks) instead of a
store per worktree, so any worktree of the project can message any other directly
(all-to-all), not just its own parent/child. New daemon-independent CLI verbs: `send --to
<meshId>|--broadcast --message TEXT [--urgency low|normal|high|urgent]` (spoof-resistant
`--from`, fail-closed `--to`), `roster [--ack]`, `mesh read`, and `heartbeat --summary TEXT`
(also broadcasts a mesh status ping). The ingest daemon is now ONE per project (not per
worktree), reaping legacy per-worktree units before taking over; a two-signal (heartbeat
freshness + live-pid lock) health check backs both a stale-data banner and send-time
self-heal; a non-destructive migration folds old per-worktree stores into the new
per-project one; and a #36-STRUCTURAL fix scopes `devswarm-parent-gate`/
`devswarm-parent-inbox` to the caller's OWN project via `repoKey` (replacing a spoofable
env-var filter). Full reference: [`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md) §8.7's "v0.57 mesh
follow-up" note.

**v0.58 mesh-only messaging (SHIPPED in v0.58.0).** The mesh above is now the **sole**
agent-initiated messaging transport for DevSwarm — a REPLACE, not an addition: native
`hivecontrol workspace message-child`/`message-parent` are guard-blocked in all contexts
(`command-guard.js`, shared file — fires for Codex too, though the proactive per-turn
reminder to use the mesh instead stays Claude-only), redirecting to the CLI. New/changed
verbs: `send --to-primary` (direct to the registered Primary, fail-closed if none),
`reconcile` (one-shot drain of every registered worktree's inbox), `spawn`/`merge` (thin
pass-through wraps of `hivecontrol workspace create`/`check-merge`+`merge-into-source`,
then auto-register/broadcast), a `roster` fold of unregistered native children, and
`archive-request` revised from a hivecontrol send to a direct store write (zero
`hivecontrol` calls, `--child-branch` removed). Every DevSwarm role gets a per-turn
COMMUNICATION OVERRIDE re-assertion (mesh-poll RESTING posture = the Tier-0 wake
mechanism) — with an honest caveat carried straight from the design record: no external
mechanism wakes a genuinely idle Claude Code session (`anthropics/claude-code#44380`), so
a Tier-2 runner-wrap fallback is explicitly named as DEFERRED, not built. The liveness
supervisor additionally escalates-to-parent on an urgent/high mesh unread (still never
kills). The ingest daemon is unchanged; no MCP server was built (CLI-over-MCP stays the
rationale). Full reference: [`docs/KB-devswarm-hivecontrol.md`](../KB-devswarm-hivecontrol.md) §8.7's "v0.58 mesh-only
messaging" note.

**v0.93.0 app-side archive detection + attribution fixes.** hivecontrol 2.5.1's
`workspace list all` carries no archive field, so the supervisor sweep now caches the
active set (`hivecontrol-active.json`) whenever a list call succeeds; a registry row
absent from that cache by both id and worktree path, and stale by a 10-minute grace,
reads as app-archived while the cache stays fresh — liveness axis only, a genuine
unread question still gates. `computeSummary` additionally projects
`archivedRegistryRows`, so archived-but-still-live senders keep blocking (a question is
informational only when its sender has no registry row of any kind, active or
archived, and no descriptor). Pending-question sender attribution now excludes the
recipient's own identity family before ranking candidates, closing a bug where a reply
from the recipient itself (or a cross-linked twin) could wrongly clear someone else's
question. **Contract change:** `pendingQuestions[].from` is now the true sender's
identity-family id instead of the freshest live row on the worktree.

**v0.94.0 deterministic attribution + bounded reconcile.** When a worktree's meshId maps to
more than one sibling registry row, `pendingQuestions[].from` is now picked by a new pure,
liveness-free function of row values (`devswarm-attribution.js`'s `pickAttributionRow`:
real-sessionId row wins, then the branch-slug row, then ascending lexical id) instead of the
freshest-live picker used elsewhere — closing a bug where the same stored message could
report a different sender across summary passes. `reconcile` now bounds itself to a total
wall-clock budget (60s default, `ANTIHALL_RECONCILE_BUDGET_MS`, `0` = unlimited), skips a
row whose worktree is already gone before spawning, and defers whatever is left when the
budget runs out to a resume marker drained first next run. `update.js` prints per-stage
progress on stderr (`ANTIHALL_UPDATE_QUIET=1` silences it); its `devswarm-repokey.js` git
spawn now times out at 10s instead of hanging (this was the actual root cause of a real
update hang traced to a stray test-fixture worktree). `doctor --check` reports (never
deletes) leaked test-fixture stores, and a new hygiene test lints for the leak pattern.

**v0.95.0 diagnose descriptor fallback + unclaimed: promotion sources.** `diagnose`
resolves `sessionId` through the descriptor when the registry is stale, and reports a
`descriptorSessionId` field on disagreement instead of surfacing the stale registry value
as if it were current. `unclaimed:` promotion derives the caller's real session id from
`--session`, the `CLAUDE_CODE_SESSION_ID` env var, or — only for a row still carrying the
marker or lacking a sessionId — the harness's own session file found by walking the
caller's parent-pid chain, gated by a cwd-in-worktree check and a pid-reuse/staleness
liveness guard. Descriptor/registry divergence is repaired in both directions, and a
registry write failure during promotion is now reported as `promotion.registryWriteError`
on `inbox pull`/`read-primary`/`inbox messages` JSON output (plus a stderr line) instead of
being swallowed silently — the next read repairs the registry from the descriptor. (Phase 5: `read-primary` / `messages --ack` are read-only — after handling the mail run the returned `ackCommand`, i.e. `inbox ack-primary <id> --receipt <rid>`.)

**v0.96.0 heartbeat-aware routing, ack ownership, post-pull budget.** `send`/fold target
selection (`resolveMeshTarget`/`pickSurvivor`) now uses a strict, heartbeat-aware liveness
gate instead of a bare sessionId shape test, so a real-but-dormant session no longer
outranks a genuinely live sibling; the fold/rehome paths are deliberately left on the older
predicate (an identity-match question, not a routing decision). `callerOwnsRow`'s
"sole row on this worktree" ownership proof now also requires that row be unclaimed, closing
a gap where a lone claimed foreign row could have its sessionId stamped over. `send` and
`heartbeat` results, and every ownership refusal, carry an additive `identity: {id, kind}`.
`inbox ack` refuses the whole verb (instead of half-acking) on a resolvable ownership
mismatch; an unresolvable-caller-identity or unregistered-caller shape still fails open.
`diagnose` rows carry an additive `archivedInApp` field, forcing `live:false` even against a
fresh heartbeat; the app-side archive-cache match now also requires `repositoryId` agreement
when both sides carry one, since its cache bucket can legitimately span more than one repo.
`reconcile` skips a worktree whose git root cannot resolve (`skippedNotGitRoot`) and now
checks its own wall-clock budget before that git-root probe, not just before the resulting
spawn. `update.js` applies one overall wall-clock budget
(`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default 90s) across every post-pull DevSwarm stage,
deferring whole stages (never partially run) past the deadline.

---
