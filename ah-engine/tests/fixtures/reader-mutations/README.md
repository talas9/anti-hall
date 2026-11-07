# Mutation proof for the task-reader open-set gate

`ah-engine/tests/task_reader_open_set.rs` (with the golden `../task-reader-open-sets.json`) must FAIL when the reader drops a task the
base reader keeps. This directory is the re-runnable proof: four small production-code patches, each of which makes the reader worse
in one known way. They apply to the base the golden was captured on (`c2ebe24d`) and are documentation, not a CI test.

| patch | mutation | file |
|---|---|---|
| M1 | an unreadable/junk store record and an unreadable store directory read as the whole store deleted (`storeTasks` returns `[]`) | `plugins/anti-hall/engine/logic/lib/69-tasks.js` |
| M2 | whenever the session has a store directory (even empty/unreadable), every task no TaskCreate made (TodoWrite) is dropped | `69-tasks.js` (`tasksOf`) |
| M3 | a snapshot entry with a `toolu_`-shaped id is dropped without proof | `plugins/anti-hall/engine/logic/lib/65-d.js` (`taskSnap.overlay`) |
| M4 | a row whose type is unknown, empty or missing is dropped | `ah-engine/src/checks/taskstate/mod.rs` (`is_conversation_row`) |

## Run one

```sh
git worktree add --detach /path/to/scratch c2ebe24d      # a scratch copy, never the gate branch
cd /path/to/scratch
git apply <gate-checkout>/ah-engine/tests/fixtures/reader-mutations/M1.patch
cp <gate-checkout>/ah-engine/tests/task_reader_open_set.rs ah-engine/tests/
mkdir -p ah-engine/tests/fixtures && cp <gate-checkout>/ah-engine/tests/fixtures/task-reader-open-sets.json ah-engine/tests/fixtures/
(cd ah-engine && cargo test --test task_reader_open_set -- --test-threads=1 --nocapture)   # expect: FAILED, N violation(s)
git checkout -- . && git worktree remove --force /path/to/scratch   # when done
```

Do not edit the gate file or the golden. Without a patch the same run passes 560/560.

## Result on c2ebe24d (560 cells)

| patch | `the_reader_keeps_every_open_task...` | violations | cells equal to golden | caught by (axes) |
|---|---|---|---|---|
| none | pass | 0 | 560 | - |
| M1 | FAIL | 504 | 308 | store = OneJunkRecord, OneUnreadableRecord, OnlyJunk, UnreadableDir; missing ids 1, 2, x, 6, 7, 8, toolu_*; Stop allows where the base blocked |
| M2 | FAIL | 231 | 425 | store = Empty, OnlyJunk, UnreadableDir; missing TodoWrite ids 1, 2, x, 6; snapshot ids 7, 8, toolu_snapghost; Stop allows |
| M3 | FAIL | 16 | 548 | snap = ToolUseId with store = Absent, Empty, OnlyJunk, UnreadableDir; missing `toolu_snapghost`; Stop allows |
| M4 | FAIL | 96 | 488 | rows = UnknownType, EmptyType, NoType (store Absent, Empty, OnlyJunk, UnreadableDir); missing `6`, `toolu_empty`; ladder and Stop |

The other two tests (`a_ghost_is_proven...`, `the_matrix_names...`) test the gate's own helpers and pass under every mutation.
No gap: every mutation is caught by at least one cell.

# Consumers axis (#448)

The open-set gate above only runs task-guard. The consumers gate (`the_consumers_of_the_task_reader_never_decide_less_than_the_base`, same
file, golden `../task-reader-consumer-decisions.json`, captured on `c2ebe24d`) records the DECISION of every other consumer of the reader per
case and holds the reader under test to: decision at least as blocking (block >= nudge >= allow), the ids a block names a superset of the
golden's, the stated task count not lower; proven ghosts (see the gate file) are excused. A relaxed decision is a violation.
The fixtures are the 560 gate cells (`build` / `probe` / `plant_snapshot`, reused, not regenerated) + the two store shapes of the #445
round-2 review (`DupIdWithJunk`, `CompletedWithJunk`) + 9 pair-guard cells (two live named agents with one owner of an open store task;
an owner next to a junk / unreadable / numeric-status sibling record; a TodoWrite with status `123` against four store shapes) + 4 cells
with 2-3 tasks in progress (the stalled branch). 575 cases, 7944 decisions.

Consumers driven (entry point = the real check script run through the script host, as the dispatcher runs it):

| consumer | entry | decision recorded |
|---|---|---|
| `ladder` | `store::session_has_open` | open / none |
| `pair_stop` | `task-pair-guard` Stop, one live named agent launched in the transcript (tracker state planted) | block (agent owns no task) / allow |
| `pair_post` | `task-pair-guard` PostToolUse, a named Agent spawn | nudge (no open task names it) / allow |
| `pair_pre:<id>` | `task-pair-guard` PreToolUse, unnamed spawn `#<id> ...` (the by-id proof), ids 1 2 3 6 7 8 9 | allow (positive proof) / block (+ the task id of an owner it names) |
| `tasklist_stop` | `tasklist-guard` Stop, 4 counted edits, no progress file | block / allow, the open ids its dedupe signal was computed over (recovered from the stored hash), the in-progress count |
| `tracker_prompt` | `task-tracker` UserPromptSubmit | the `open tasks: N` count and the ids of the dispatch line |
| `hygiene_post` | `tasklist-hygiene` PostToolUse TaskCreate, budget lowered to 1 by the home's settings.json | nudge with `N open tasks` / allow |
| `compact_advice` | `compact-advice-guard` Stop, last message `Safe to compact.` | block (task list over budget) / allow |

Already covered by the open-set gate: `task-guard` Stop (golden `../task-reader-open-sets.json`, unchanged).

Consumers of the reader NOT driven here:

- `edit-guard` nudge (`edit-guard.js` `egNudge`, `tk.tasks`): the note needs an active DevSwarm app database, a live-workspace probe and `process.cwd()`;
  none can be supplied from a test without a production hook.
- `dispatch-tier` (`dtTask`, `tk.tasksOf`): always answers allow; the reader only supplies the task text of a Jev question (an effect, no verdict).
- `agents/ctl.rs` (`scanview::scan_tasks`): a status report of one agent's own transcript; no allow/block decision.
- `task-guard` `tgEnforce` (prune / priority checks, `tk.tasks`): the same hook as the gated Stop; settings-gated and covered by the task-guard golden's verdicts.
- The Node twins (`plugins/anti-hall/hooks/*.js`) no longer exist at this base; `devswarm_rt/sources.rs` only parses timestamps.

Direction note: for `pair_pre` the base ALLOW is the positive proof. A reader that loses an open task turns it into a deny (more blocking, so
not a violation here; the open-set gate catches that loss). The consumers gate catches the opposite: an allow the base denied.

| patch | mutation | file |
|---|---|---|
| M5 | `tk.tasksOf` carries the transcript's uncertainty next to the store's list (the stage A shape), so task-pair-guard discards the whole set and allows | `69-tasks.js` |
| M6 | tasklist-guard does not carry the store's open ids into its scan (`openTaskIds = []`) | `plugins/anti-hall/engine/logic/tasklist-guard.js` |

Run as above, with the file `task_reader_open_set.rs` and both goldens copied in; add `-- the_consumers` to run only this gate (about 105 s).

## Result on c2ebe24d (575 cases, 7944 decisions, 8 consumers)

| patch | `the_consumers_...` | violations | decisions equal to golden | caught by |
|---|---|---|---|---|
| none | pass | 0 | 7944 | - |
| M5 | FAIL | 4 | 7940 | `pair|todowrite_status_123|store=nonempty` and `...|store=junk`: `pair_stop` block -> allow, `pair_post` nudge -> allow (the 560 matrix cells hold no uncertain transcript, so only these pair cells see it) |
| M6 | FAIL | 244 | 7700 | `tasklist_stop` in every cell whose store holds open tasks: the block no longer names ids 1, 3 (and 7, 8, ...) |

The open-set gate (`the_reader_keeps_every_open_task...`) stays green under M6 (the reader is untouched) and is the one M1-M4 target.

# Hand-written obligations (W1-1F)

The two goldens are CAPTURED on `c2ebe24d` and hold the base's defects as the expected answer, so they are only held to a direction. The
cells added by W1-1F in `task_reader_open_set.rs` are written by hand from the spec and assert the EXACT answer:

| group | test | prefix | what |
|---|---|---|---|
| open set | `the_reader_meets_the_hand_written_open_set_obligations` | `open|` | exact open set, task-guard Stop and Rust ladder (12 cells) |
| consumers | `the_consumers_meet_the_hand_written_obligations` | `oblig|` | exact kind, named task ids, count and message words of each of the 8 consumers (12 cells) |

Cell kinds: `*|allow|*` exact ALLOW (rule 14 (b)); `*|hard|*` obligations the base meets (rule 14 (c), they name the blocking task id and
the agent that owns no task); `*|d1|*`, `*|d2|*`, `*|d3|*`, `*|d4|*`, `*|g|*` obligations the base gets wrong, staged in
`../task-reader-expected-failures.toml` (XF-D1/D4 -> W1-4, XF-D2 -> W1-5, XF-D3 -> W1-3, XF-G -> W1-6). A failing cell that is not listed is a
NEW failure; a listed cell that passes is STALE (remove the entry, report `XF transferred`); a listed `case` that is no cell is refused.

One mutation per consumer kind (apply as above; the obligation tests alone catch each one, `-- obligations`):

| patch | consumer | mutation | first cell that fails |
|---|---|---|---|
| M7 | `ladder` | `session_has_open` answers `Some(false)` when the store answers | `oblig|hard|every_consumer_reads_the_store_list`, `open|hard|store_tasks_pending_and_in_progress` |
| M8 | `pair_stop` | the Stop never blocks | `oblig|hard|an_agent_with_no_task_blocks_the_stop` |
| M9 | `pair_post` | the spawn nudge never fires | `oblig|hard|an_agent_with_no_task_blocks_the_stop` |
| M10 | `pair_pre` | a task owned by another agent counts as paired | `oblig|allow|the_running_agent_owns_an_open_task` |
| M6 | `tasklist_stop` | (above) | `oblig|hard|every_consumer_reads_the_store_list` |
| M11 | `tracker_prompt` | the tracker ignores the store's tasks | `oblig|hard|every_consumer_reads_the_store_list` |
| M12 | `hygiene_post` | the hygiene check sees no open tasks | `oblig|hard|every_consumer_reads_the_store_list` |
| M13 | `compact_advice` | finished tasks are not counted | `oblig|hard|every_consumer_reads_the_store_list` |
| M5 | pair guard (stage A shape) | (above) | `oblig|hard|pairing_facts_survive_an_uncertain_transcript` |

Against `369edde3` (stage A) the same files fail: NEW failure `oblig|hard|pairing_facts_survive_an_uncertain_transcript` (`pair_stop` and
`pair_post` allow), and two STALE entries (`open|d1|*`: stage A does fix those open sets).
