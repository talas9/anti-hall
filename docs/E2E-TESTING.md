# Verifying the anti-hall hooks

The Node test suite is retired. Hooks are answered by the Rust engine behind the `ah-hook` thin client, and a change is verified
in four steps:

1. `cargo check` on the touched crate (`ah-engine`, `ah-launcher`).
2. One release build of `ah-engine` and, when the client changed, of `ah-launcher`.
3. Deploy to a live root with `scripts/engine-deploy.sh` (a thin call to `ah-engine update --from-local`, the one install routine: pre-check, rollback copy, install, validation, automatic rollback, install record; `--rollback` restores the last saved copy).
4. A live check: use the hook for real and read the result with `ah-hook doctor --check`, `ah-hook status` and
   `ah-hook diag hooks`.

The engine's own Rust tests run in `.github/workflows/ah-engine.yml` (job `rust`). The `tests-passed` job in `test.yml` only
keeps the check name that the repository rulesets require.

> Hooks reference: the official Claude Code hooks contract is documented at
> <https://code.claude.com/docs/en/hooks>.

## Hook I/O contract (per event)

The hooks implement three distinct Claude Code event contracts:

| Event              | Block signal                                  | Allow signal            | Context injection |
|--------------------|-----------------------------------------------|-------------------------|-------------------|
| `PreToolUse`       | **exit code 2** (reason on stderr or in a `{decision:"block"}` stdout object) | exit 0 | — |
| `Stop`             | stdout JSON `{"decision":"block","reason":…}` **and exit 0** | exit 0, no `decision` | — |
| `UserPromptSubmit` | — (never blocks)                              | exit 0                  | stdout JSON `hookSpecificOutput.additionalContext` |
| `SessionStart`     | — (never blocks)                              | exit 0                  | stdout JSON `hookSpecificOutput.additionalContext` |

Every hook is **fail-open**: empty stdin or malformed JSON must never block (PreToolUse exits 0, Stop emits no
`decision:block`).

## Coordinator versus subagent

A subagent is told apart from the coordinator by the payload first: `agent_id` / `agent_type` in the payload is the primary
signal, and the process environment (`CLAUDE_CODE_ENTRYPOINT`) is only a fallback. When you try a hook by hand, control the
payload first, and run it with a throwaway `HOME` so your real `~/.anti-hall` state is not touched.
