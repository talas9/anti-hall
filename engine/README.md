# anti-hall engine (phase 1)

One binary, two roles: `engine serve` (resident daemon, one per socket) and `engine hook` (the hook client:
hook JSON on stdin, hook output JSON on stdout). `engine ctl ping|reload|stop` and `engine version` for ops.
Crates: serde, serde_json, regex. Unix only (macOS, Linux).

## Layout
- `src/hookio.rs` parse the hook payload (Claude Code and Codex share field names) and build per-event output
- `src/rules.rs` rules format v1 (JSON) + matcher; `rules.json` ships 3 example rules ported from git-guard / command-guard
- `src/daemon.rs` singleton daemon, reload, version handoff; `src/client.rs` fail-open client; `src/paths.rs` socket/lock paths
- `tests/e2e.rs` real daemon end-to-end (isolated HOME + engine dir); `wall.zsh`, `base.js` measurements

## Hook I/O
| event | deny | warn / context |
|---|---|---|
| PreToolUse | `hookSpecificOutput.permissionDecision:"deny"` + reason | `hookSpecificOutput.additionalContext` |
| PostToolUse, UserPromptSubmit | `{"decision":"block","reason"}` | `hookSpecificOutput.additionalContext` |
| Stop | `{"decision":"block","reason"}`; never when `stop_hook_active` | `{"systemMessage"}` |
| SessionStart, SubagentStart | n/a (treated as context) | `hookSpecificOutput.additionalContext` |

Anything else, malformed input, or no match: print nothing, exit 0.

## Rules v1 (`~/.anti-hall/engine/rules.json`, or `$ANTIHALL_ENGINE_RULES`)
Fields per rule: `events`, `tools` (omit or `"*"` = any), `field` (dot path into `tool_input`, or `prompt`; default = command /
file_path / path / pattern / url, or the prompt on UserPromptSubmit), `pattern` (regex crate syntax, unanchored), `action`
(`deny|warn|context`), `message`, `paths` (apply only when payload `cwd` is at/under one of them). Rules apply in file order;
all matches contribute, any `deny` wins. Reload: SIGHUP, `engine ctl reload`, or file change (checked every ~200 ms). A rules file
that fails to parse keeps the previous rules.

## Daemon lifecycle
- Socket `~/.anti-hall/engine/e.sock` (override dir with `ANTIHALL_ENGINE_DIR`); if the path exceeds 100 bytes: `$TMPDIR/ah-<uid>.sock`, then `/tmp/ah-<uid>.sock`.
- `e.sock.lock` is flock'd for the daemon's lifetime: concurrent cold starts cannot double-spawn (losers exit). Holding the lock proves any existing socket file is stale, so it is removed and rebound. The kernel drops the lock if the daemon crashes.
- Version handoff: every request carries the client's version (`ANTIHALL_ENGINE_VERSION`, default = crate version). A newer client makes the daemon answer that request, unlink the socket, drain queued connections and exit; the next client cold-starts the new build (the starting daemon waits up to 1.5 s for the old one to release the lock).
- Client never fails the host: error, panic, timeout, daemon can't start (40 ms cold-start budget) all print nothing and exit 0.

## Measurements
macOS, brew rust 1.99, release build (opt-level z, lto), measured while the machine was running many other agents (so absolute
numbers are pessimistic; run `zsh wall.zsh` to reproduce):

| | Rust client | node baseline |
|---|---|---|
| peak RSS per call (median of 10) | 1.9 MB | 44.2 MB |
| wall per call, daemon warm (median of 30, incl. `echo \|` + fork) | 12.5 ms (min 6.6) | 38.2 ms (min 33.7) |
| fail-open: no daemon, spawn off (median) | 8.4 ms (max 12.4) | n/a |
| fail-open: daemon cannot start (median) | 12.8 ms (max 31.6) | n/a |

Binary 1.0 MB (was 372 KB std-only; regex + serde). Daemon RSS 3.1 MB idle and after 1000 requests. The earlier
prototype README's 2.8 ms warm figure was taken on a quieter machine and a std-only client; not re-run side by side.
