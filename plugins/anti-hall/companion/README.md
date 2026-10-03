# anti-hall mcp-reaper (companion)

OPT-IN background job (macOS + Linux) that kills **orphaned** MCP-server processes
that leaked when their spawner (a Claude / codex / npm / node session) exited
without cleaning them up. On macOS there is no `PR_SET_PDEATHSIG`, so abandoned MCP
children reparent to init/launchd and run forever, piling up over a workday.

## Safety invariant

A process is reaped only if **both** hold: (a) its command matches a generic MCP
signature, **and** (b) its parent is a reaper/init process (launchd / init /
`systemd --user` / WSL `Relay()`). Because Unix always reparents a dead process's
children, a *live* MCP's parent is always a live spawner — never a reaper — so
"parent is a reaper" means the ordinary spawner has died, which means the MCP is a
true orphan. For that target case (a session-leaked orphan), killing an in-use MCP
is prevented by construction.

## Codex app-server-broker class (REPORT-ONLY — never killed)

Additionally **detects and lists** (never kills) abandoned-looking
`app-server-broker.mjs` helper processes from the openai-codex Claude Code
plugin — a JSON-RPC broker, not an MCP-protocol server, so it is matched and
gated *separately* from the generic MCP signature above and never loosens it.

**This class stays detect-and-report-only by design (2026-09-25 safety
review).** Automatically killing it was found unsafe to ship: unquoted `--cwd`
paths containing spaces could be truncated and misread as gone; comparing raw
path strings without `realpath` could miss e.g. `--cwd /tmp/proj` vs an
owner's OS-reported `/private/tmp/proj` (the same directory); and the
broker's own `codex app-server` child process (which shares its cwd) always
looked like a live "owner", so the class could barely ever fire even when it
was right. The detection below has since been hardened, but per that review
it stays **report-only regardless of confidence** — a candidate is written to
the log (dry-run and real runs alike) as `abandoned codex broker
(report-only): pid=... age=...s cwd=... reason=...` and is **never** passed
to `process.kill` anywhere in this tool.

**PPID is NOT evidence for this class.** Per the plugin's own source
(`scripts/lib/broker-lifecycle.mjs`), the broker is spawned `detached: true` +
`child.unref()` **on purpose**, so it outlives its spawning tool call and gets
reused across a session (`ensureBrokerSession` re-adopts a live one via a
`broker.json` state file before ever spawning a new one). PPID 1 is the
**normal, expected state for a live, in-use broker**. `broker.json` also
carries no owning-session-id/pid to check for liveness, only the broker's own
pid/endpoint — so this class instead proves abandonment two other ways, held
to a much longer age floor since PPID gives no signal here:

A broker is **listed** (never reaped) only if its script/path signature
matches, it is older than `guards.reaperCodexBrokerMinAgeS` (default
**1800s / 30min**), **and** at least one of:
- (a) its `--cwd` directory no longer exists (the worktree was
  removed/archived); or
- (b) no live `claude`/`codex` process — **excluding the broker's own
  descendants** (its `codex app-server` child inherits the broker's cwd and
  would otherwise always look like an owner) — has a **realpath'd** cwd
  **equal to, an ancestor of, or a descendant of** the broker's own
  **realpath'd** `--cwd` (checked via `/proc/<pid>/cwd` on Linux, `lsof -a -d
  cwd -p <pid>` on macOS/BSD). The ancestor direction matters: a Claude
  session commonly runs at a workspace **root** while a broker it owns runs
  `--cwd` inside a **git submodule** under that root (the real field case).
  Path comparison is segment-boundary-safe (`/a/bc` is never mistaken for
  being related to `/a/b`). An owner whose cwd is `/` or `$HOME` then blocks
  every listing under it — an accepted safe-side failure mode.

`--cwd` is parsed up to the next ` --<flag>` token (or end of string), not
split on the first space, so a path containing whitespace is captured whole.
Anything unresolvable (the `--cwd` can't be parsed, `realpath` fails on
either side, an owner-process cwd lookup fails) is **skipped, never
listed**. Toggle: `guards.reaperCodexBroker` ("report abandoned codex
brokers", default on, since this script only runs at all once the reaper is
opted in via `install-reaper.js`) / env `ANTIHALL_REAPER_CODEX_BROKER=0` to
disable.

## Limitations

This holds for **session-leaked** orphans only. If you run an MCP server as a macOS
**LaunchAgent**, a **`systemd --user`** unit, or any other OS/init-managed service, it
is parented to init/launchd/systemd-user **while alive** — which is indistinguishable
from a dead orphan by parent alone, so it **could be reaped**. Exclude such servers
with `ANTIHALL_REAPER_EXCLUDE` (a regex of command substrings that are never reaped),
e.g. `ANTIHALL_REAPER_EXCLUDE='your-service-name|another'`.

## Install / uninstall

```bash
# install (auto-detects OS)
node install-reaper.js
# remove
node install-reaper.js --uninstall
# preview only, change nothing
node install-reaper.js --dry-run
```

- **macOS** — installs a LaunchAgent `com.anti-hall.mcp-reaper` (runs every 60s).
- **Linux** — installs a `systemd --user` service + 60s timer. If `systemctl` is
  absent, it prints a cron line to add instead.
- **Windows** — unsupported (prints why), no scheduler installed. Windows has no
  parent-death reparenting and recycles PIDs, so external orphan detection is
  unsafe; the correct fix there is Job Objects set by the spawner, which a
  companion cannot do.

## Env knobs

| Var | Default | Effect |
|-----|---------|--------|
| `MCP_REAP_DRYRUN=1` | off | log what would be reaped, kill nothing |
| `MCP_REAP_GRACE` | `3` | seconds to wait after SIGTERM before SIGKILL |
| `ANTIHALL_REAPER_MATCH` | — | extra regex (case-insensitive) appended to the MCP signature |
| `ANTIHALL_REAPER_EXCLUDE` | — | regex (case-insensitive) of cmd substrings to NEVER reap (opt-out for service-managed MCPs — see Limitations) |

## Log location

`~/.anti-hall/mcp-reaper.log`
