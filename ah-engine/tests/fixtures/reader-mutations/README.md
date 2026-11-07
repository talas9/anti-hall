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
