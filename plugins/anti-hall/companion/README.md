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
