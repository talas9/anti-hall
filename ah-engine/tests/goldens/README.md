# tests/goldens — recorded Node answers for the parity lanes

Not to be confused with `tests/golden/` (singular): that is the D88 corpus of the scripted checks (`src/script/golden.rs`),
hand-curated cases with their expected engine output. This directory holds what the **real Node hooks** answered in the
Node-vs-engine parity lanes (`tests/it/node_parity/`), so an everyday run replays Node instead of spawning it thousands of
times. The engine side always runs live.

## Layout

`tests/goldens/<lane>/` (the lane's harness name, e.g. `api-guard`):

- `MANIFEST.json`: the fingerprint, the SHA-256 of every file in it, the tool versions (`node`, `git`, `python3` where used),
  the OS it was recorded on, the case count, the ids found volatile, and the command that re-records it.
- `cases.jsonl` (or `cases-<prefix>.jsonl` shards above ~2 MB): one line per case and step, sorted by id:
  `{id, in, code, out, err, state?}`. `in` is the first 16 hex digits of the SHA-256 of the normalized input (the inputs
  themselves are not stored). Run-specific text (scratch paths with pids) is stored as `{SCRATCH}`, `{HOME}`, `{PLUGIN}`
  (and `{X:real}` for the canonical `/private/tmp` form) and restored on replay.

## Modes

| Variable | Mode | What Node does |
|---|---|---|
| (none) | Replay | not run; answers come from the golden. A stale fingerprint fails the test and names the changed files. |
| `AH_RECORD_NODE=1` (with `--profile record`: no timeout) | Record | runs live, twice (scratch roots of different path lengths); writes the golden. Refused when `CI=true`. |
| `AH_LIVE_NODE=1` | Live | runs live; when a fresh golden exists the live answers must match it (catches a file the fingerprint missed). |

A golden recorded on another OS (`os` in the manifest) is not replayed: that run is Live. In CI (`CI=true`) a golden whose
files still match but whose tool versions differ (a runner's own Node, git, python3) also runs Live; on a dev machine a tool
change is stale like a file change and asks for a re-record.

## The fingerprint

The static require-closure of the lane's entry hook: `require('./…')`, `path.join(__dirname, …)` and every string literal
ending in `.js/.json/.sh` that resolves to a plugin file, followed transitively, plus `.claude-plugin/plugin.json`, plus the
`--version` text of the tools Node shells out to. Over-inclusion only costs a re-record; a miss is caught by the `soak`
profile, which runs the lanes with `AH_LIVE_NODE=1`.

## Volatile cases

Recording runs the lane twice. A case whose answer (or input hash) differs between the two passes depends on interleaving,
the clock or the path length: it is listed under `volatile` in the manifest, not stored, and always runs Node live.

## Re-recording

When a test fails with `stale Node golden <lane>: <file> changed`:

```sh
AH_RECORD_NODE=1 cargo nextest run --release --profile record -E 'test(<test>)'
git diff tests/goldens/<lane>   # review: usually only manifest hashes move
```

Commit the re-recorded golden with the Node change that staled it.
