# End-to-end testing of the anti-hall hooks

This suite exercises every anti-hall hook as a real child process — the same way
Claude Code runs them — and asserts on the exit code and stdout/stderr contract.
It uses **only Node's built-in [`node:test`](https://nodejs.org/api/test.html)**
runner and `node:assert`, so it stays **zero-dependency**, matching the
deps-free plugin it tests.

> Hooks reference: the official Claude Code hooks contract is documented at
> <https://code.claude.com/docs/en/hooks>.

## Approach

- **Black-box, process-level.** Each test spawns the hook with `spawnSync`,
  pipes a JSON payload to stdin, and inspects what comes back. No internals are
  imported except the one pure module that is genuinely unit-testable
  (`skip-guard.js`'s `isSkipped`).
- **Zero deps.** `node --test` discovers and runs `**/*.test.js`; assertions use
  `node:assert`. Nothing is installed.
- **Deterministic env isolation** (see the gotcha below) so coordinator-vs-
  subagent detection is reproducible regardless of where the suite runs.

## Hook I/O contract (per event)

The hooks implement three distinct Claude Code event contracts. The tests assert
against exactly these:

| Event              | Block signal                                  | Allow signal            | Context injection |
|--------------------|-----------------------------------------------|-------------------------|-------------------|
| `PreToolUse`       | **exit code 2** (reason on stderr or in a `{decision:"block"}` stdout object) | exit 0 | — |
| `Stop`             | stdout JSON `{"decision":"block","reason":…}` **and exit 0** | exit 0, no `decision` | — |
| `UserPromptSubmit` | — (never blocks)                              | exit 0                  | stdout JSON `hookSpecificOutput.additionalContext` |
| `SessionStart`     | — (never blocks)                              | exit 0                  | stdout JSON `hookSpecificOutput.additionalContext` |

Mapping to hooks:

| Hook                   | Event              | What the test asserts |
|------------------------|--------------------|-----------------------|
| `git-guard`            | PreToolUse (Bash)  | force-push / AI-credit-trailer forms exit 2; safe forms exit 0 |
| `command-guard`        | PreToolUse (Bash)  | heavy commands exit 2 **in coordinator**; allowed in subagent / for light commands |
| `skip-guard`           | (module)           | `isSkipped` TTL + granularity (`all` ≠ destructive `git-guard`); plus an e2e bypass through `command-guard` |
| `speculation-guard`    | Stop               | hedge-without-acknowledgment blocks; acknowledgment / no-hedge allows; `MAX_BLOCKS` cap; skip hatch |
| `speculation-judge`    | Stop               | opt-in: without `ANTIHALL_SEMANTIC_JUDGE=1` it exits 0 regardless of transcript (live API path untested) |
| `task-guard`           | Stop               | open tasks block; all-complete / none allows; skip hatch |
| `task-tracker`         | UserPromptSubmit   | first turn FULL directive, then SHORT; future/garbage timestamp self-heals to FULL |
| `verify-first`         | UserPromptSubmit   | `additionalContext` starts `VERIFY-FIRST:`; deterministic for a given envelope |
| `verify-first-full`    | SessionStart       | full protocol contains the IRON LAW, the scannability rule, and USER OVERRIDE |
| `swarm-guard`          | PreToolUse (Task)  | a normal spawn is allowed; fail-open on bad stdin |

Every hook additionally has **fail-open** tests: empty stdin (`''`) and malformed
JSON (`'{bad'`) must never block — PreToolUse hooks exit 0, Stop hooks emit no
`decision:block`.

## The spawn-and-assert pattern

`tests/helpers/spawn-hook.js` exports:

- `testHook(hookFile, payloadObj, opts)` — spawns the hook, pipes
  `JSON.stringify(payloadObj)` to stdin, returns `{ status, stdout, stderr, json }`
  (`json` is `JSON.parse(stdout)` or `null`).
- `testHookRaw(hookFile, rawString, opts)` — same, but pipes a raw string (for the
  empty-stdin and malformed-JSON fail-open tests).
- `bashPayload(command, { agentId })` — builds a `PreToolUse`/`Bash` payload;
  when `agentId` is given it lands **in the payload** (the subagent discriminator).

Hook paths resolve absolutely from the test file via `path.join(__dirname, …,
'plugins/anti-hall/hooks', …)`, so the suite is location-independent.

## Env-isolation gotcha (read this)

The test process may itself be running inside an agent harness, so `process.env`
can already contain `CLAUDE_CODE_ENTRYPOINT` or agent markers. If a hook inherited
that environment, **coordinator-vs-subagent detection would be non-deterministic**.

The spawn helper therefore passes a **controlled** environment, never a blind
inherit:

```
env = { PATH: process.env.PATH, HOME: <fakeHome>, ...(opts.env || {}) }
```

So a test sets up the exact context it means to test:

- **Coordinator** tests set `CLAUDE_CODE_ENTRYPOINT='cli'` and put **no** `agent_id`
  in the payload.
- **Subagent** tests put `"agent_id":"x"` **in the payload** — this is the primary,
  cmux-reliable signal the hooks read first (the process-env entrypoint is only a
  fallback). Control the payload first.

## Fixtures

`tests/helpers/fixtures.js` exports `makeHome()`, which creates a disposable temp
`HOME` (`mkdtempSync`) with a `~/.anti-hall` state dir, and returns helpers:

- `writeSkip(obj)` — write `~/.anti-hall/skip.json` (the escape-hatch marker).
- `writeTranscript(messages)` — write a JSONL transcript (one JSON object per
  line) and return its path; this is what the Stop hooks parse.
- `writeState(filename, obj)` — pre-seed a hook's state file under `~/.anti-hall`.
- `cleanup()` — `rmSync` the temp home (`recursive`, `force`).

Each test gets its own `HOME`, so hook state (skip markers, loop-state, throttle
timestamps) never leaks between tests or touches the real machine.

## How to run

From the repository root:

```bash
node --test        # auto-discovers tests/**/*.test.js from the working dir
# or
npm test
```

Bare `node --test` is preferred for portability: it discovers test files itself,
so no shell glob is expanded and it behaves identically across bash, zsh, and
PowerShell. (`node --test 'tests/**/*.test.js'` relies on the shell — PowerShell
will not expand it; and `node --test tests/` is treated as a module path on newer
Node, not a discovery root.)

## CI matrix

`.github/workflows/test.yml` runs the suite on every push and pull request across
the full matrix:

- **OS:** `ubuntu-latest`, `macos-latest`, `windows-latest`
- **Node:** `18.x`, `20.x`, `22.x`, `24.x`

with `fail-fast: false` so one cell's failure does not mask the others. Each cell
checks out, sets up Node, and runs `node --test`.
