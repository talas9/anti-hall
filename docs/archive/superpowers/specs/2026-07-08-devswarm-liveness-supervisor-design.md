# Design — DevSwarm liveness supervisor for anti-hall

**Status:** draft spec, not yet planned/built. Both spikes (§10) came back **GREEN** — the full
kill+resume recovery path is specified below as the primary path, hardened with safety
refinements the spikes surfaced (§5). Corrects an initial brief that assumed anti-hall-side
transport pieces (inbox daemon, done-report gating, an inbound-keyed heartbeat file) which are
not part of this repo — see §1.

## 1. Premise correction

The initial ask described a "supervisor on top of an existing anti-hall inbox daemon and
heartbeat bridge." That transport does not live in anti-hall: **anti-hall is a public, project-
agnostic plugin** (Claude Code + Codex), and the inbox daemon, the done-report contract, and the
inbound-keyed heartbeat (`{"ts": <ms>}`, keyed to received messages) are built and owned by the
downstream project running DevSwarm — call it the **consumer**. Naming that consumer or its
internals is out of scope here; this doc only defines what anti-hall reads and writes.

**What's actually unbuilt, on both sides:** the liveness *detector* and the *recovery* action.
Neither side has them today. This spec defines anti-hall's half: a generic, pure-Node,
cross-platform, fail-open **liveness supervisor** — a thin client that consumes a small descriptor
the consumer publishes (§3) and never assumes anything about the consumer's internals beyond that
descriptor.

**Root cause this works around:** the process that goes stale doesn't crash — it stays alive with
a dead listener, so crash-restarters (pm2/systemd) never fire, and no background-task-timeout
event generates a new turn to notice. This is a documented, unresolved bug class in Claude Code's
core session loop, not a DevSwarm defect: `anthropics/claude-code#28482` (agent hangs indefinitely,
no headless recovery), `#33949` (SSE stream dies silently, no client heartbeat), `#39755` (an
internal stream watchdog exists behind `CLAUDE_ENABLE_STREAM_WATCHDOG` but a control-flow bug makes
its fallback dead code). **Label every piece of this supervisor, in code comments and docs, as a
workaround for `claude-code#39755`** — re-evaluate and remove when upstream ships a real fix.

## 2. Architecture

Two components, both modeled on existing anti-hall patterns so the implementation has direct
precedent to follow:

- **Feature-detect helper — `hooks/lib/devswarm-detect.js` (new).** Pure Node, no deps, fail-open,
  modeled on `hooks/omc-detect.js` (four-gate detection: kill-switch → enabled → state-root →
  active-and-fresh). Dormant unless `DEVSWARM_REPO_ID` is set, gated further by its own kill-switch
  env var and an optional settings toggle. When the env var is absent: zero effect, byte-for-byte
  identical to today — exactly how `omc-detect.js` behaves for non-OMC sessions.
- **Companion — `companion/install-devswarm-supervisor.js` (new).** Pure Node background job,
  modeled EXACTLY on `companion/install-reaper.js`: macOS LaunchAgent (`StartInterval`), Linux
  systemd `--user` timer with a cron fallback when `systemctl` is absent, Windows graceful
  degrade (§9). **Opt-in install** — a component that can kill a process must never self-install;
  the user runs the installer explicitly. Agnostic paths via `os.homedir()`, `process.execPath`,
  `__dirname`. Supports `--uninstall` and `--dry-run`, same flags as the reaper installer.
  Default sweep interval **90 s**, clamped to **60–120 s** (configurable, §8).
- **Health — extend `hooks/doctor.js`.** Add a per-active-workspace check reporting
  PASS/WARN/FAIL for "has a live listener" + "liveness verdict is not stale," following doctor's
  existing live-behavioral-self-test convention (each check runs the real logic against a
  constructed fixture, not a mock).

## 3. The seam

The consumer publishes; anti-hall consumes. Nothing here assumes consumer internals beyond this
contract — this is the deliverable's core, and it's intentionally small.

**Consumer publishes** a per-active-workspace descriptor (a small addition on the consumer side,
specified here, not built by anti-hall):

```
~/.anti-hall/devswarm/workspaces/<id>.json = {
  "id": "<workspace id>",
  "worktreePath": "<absolute path to the workspace's git worktree>",
  "inboxPath": "<path to the durable inbound-message log>",
  "cursorPath": "<path to this consumer's read-cursor over that log>"
}
```

Keys are generic on purpose (no consumer-specific field names). The existing inbound-keyed
heartbeat (`{"ts": <ms>}`) keeps being written by the consumer for whatever it's used for today,
but it is **insufficient alone** — it only reflects inbound activity, and the failure mode is a
child that stopped consuming both inbound *and* outbound (§4).

**Encoding rule** (used everywhere below a `worktreePath` maps to a `~/.claude/projects/` dir):
take the absolute `worktreePath` and replace every `/` AND every `.` with `-`. This is **lossy and
forward-only** — never attempt to decode an encoded segment back to a path; always derive the
encoded form fresh from the known `worktreePath`.

**anti-hall derives**, from `worktreePath` alone — nothing else is required from the consumer —
using the method **verified live by the two spikes (§10)**, not a heuristic:

1. **Session id.** Do NOT use newest-mtime-of-`*.jsonl` (a heuristic, wrong when a workspace has
   multiple transcripts or a stale one sorts newest). Instead: read it off the **target process's
   own argv** — the running `claude` invocation's `--session-id` or `--resume <uuid>` flag — then
   **cross-check** that `~/.claude/projects/<encoded worktreePath>/<uuid>.jsonl` exists. Both must
   agree; a uuid with no matching transcript file is not a valid candidate.
2. **PID.** Run `ps -axo pid,ppid,command`, filter to commands matching the argv-uuid regex (a
   `claude` invocation carrying that session id). For each match, confirm cwd: `lsof -p <pid> -a -d
   cwd` on macOS, `/proc/<pid>/cwd` on Linux, must equal `worktreePath`. This excludes children
   (MCP servers, shell wrappers) that share the parent's cwd/argv fragment but lack the session
   flag themselves.
3. **Confirm-gate (hard requirement, not an optimization).** After steps 1–2, there must be
   **exactly one** surviving candidate pid. If the filter yields **zero or more than one** — e.g. a
   stale bootstrap wrapper that happens to share both cwd and the session-id string — **ABSTAIN**:
   do not kill, do not guess between candidates. Write a `"status": "ambiguous"` verdict and
   escalate exactly like any other escalation (§5). This is the single most important safety
   property in this spec: a live counter-example (a stale wrapper process matching cwd+uuid) is
   why "pick the first match" is not acceptable.

**anti-hall reads** the unread backlog via `inboxPath` + `cursorPath` to (a) decide whether a
workspace has pending work it should be servicing, and (b) build the resume prompt (§5).

**anti-hall writes**, per workspace:

```
~/.anti-hall/devswarm/liveness/<id>.json = {
  "status": "alive" | "stale" | "recovering" | "ambiguous" | "escalated",
  "lastOutboundTs": <ms>,
  "staleSince": <ms | null>,
  "recoveries": <int>
}
```

plus an append-only `~/.anti-hall/devswarm/recovery.log` (one line per recovery attempt, abstain,
or escalation, with a reason field).

## 4. Detection

Each sweep, per active workspace:

1. Compute **outbound** liveness from two signals — NOT the inbound heartbeat, which is blind to
   this failure mode (the wedged child wasn't consuming inbound either):
   - newest session-transcript JSONL mtime under `~/.claude/projects/<encoded worktreePath>/`;
   - git/worktree activity — latest commit time, or working-tree mtime.
2. Mark **STALE** only when BOTH signals have been idle past a threshold (default **15 min**,
   configurable, §8) **AND** the workspace has pending work it should be servicing — an unread
   entry past `cursorPath` in the log at `inboxPath`, or an owed done-report. A workspace that's
   idle because it has nothing to do is not stale.
3. Persist the verdict to `~/.anti-hall/devswarm/liveness/<id>.json` (§3) — this half is
   self-contained and independently useful (an orchestrator or human can watch these files even
   with recovery disabled).

## 5. Recovery

Both spikes (§10) came back GREEN, so the primary path is the full kill+resume recovery below.
The escalate-only path (end of this section) is the fail-open **fallback** for the cases the
confirm-gate or the relaunch itself can't clear safely — not a separate contingent branch.

On STALE:

1. **Derive the session id + pid** using the §3 method — argv-uuid, cross-checked against the
   transcript file, cwd-confirmed via `lsof`/`/proc`. If the **confirm-gate abstains** (0 or >1
   candidates), skip straight to the escalate-only fallback below — never kill on an ambiguous
   match.
2. **Precise-kill only the single confirmed pid.** No broad `pkill`, no pattern match beyond the
   argv-uuid + cwd double-check already performed in step 1. This mirrors the MCP orphan reaper's
   precise-kill discipline (`companion/mcp-reaper.js`, PPID==1 + signature match) but is one level
   stricter here (argv-uuid + confirmed cwd + a hard one-candidate requirement, not just
   parentage) because this kill targets a process that may still be doing legitimate work.
3. **Single-writer recovery per workspace.** Before killing or relaunching, take a per-workspace
   lockfile (atomic `fs.openSync(path, 'wx')`, mirroring the `children.json` write pattern used
   elsewhere in this repo's DevSwarm work). **Never resume the same session id from two processes
   concurrently** — there is no OS-level lock on a Claude Code session, and a double-resume
   silently interleaves two processes writing the same transcript. The lockfile is what prevents
   that, not an assumption about timing.
4. **Relaunch from the same cwd.** Run `claude -p --resume <session-id> --dangerously-skip-permissions`
   with the working directory set to `worktreePath` — `--resume` is scoped to the project directory
   it's invoked from; running it from anywhere else fails with "No conversation found," not a
   crash. `--dangerously-skip-permissions` composes fine with `-p --resume` (already how these
   children run, per the initial brief). Feed the unread backlog (§3) as the fresh prompt.
5. **Treat "No conversation found" as an expected, handled failure** (invalid id, wrong cwd, or a
   race where the transcript rotated) — log it, mark `needs-attention`/escalate, never treat it as
   a crash the supervisor itself should propagate.
6. Increment the per-workspace `recoveries` counter. Cap at **N = 3** recoveries within a window
   (default, configurable, §8); on hitting the cap, **stop auto-recovering, write `status:
   "escalated"`, and log it** — no restart loops.

**Escalate-only fallback** (fires whenever the confirm-gate abstains, the relaunch fails, or the
recovery cap is hit): write the verdict (`ambiguous` or `escalated`), append a reason to
`recovery.log`, and stop — no auto-kill, no guessing. This is the fail-open default whenever any
step above can't clear its own safety bar, not a degraded mode reserved for spike failure.

## 6. Config & safety

- Env config, following existing anti-hall conventions (see OMC/OMX kill-switches):
  `ANTIHALL_DEVSWARM_SUPERVISOR` = `on` / `off` / `auto` (default `auto` = follow feature-detect),
  plus sweep interval, staleness threshold, and max-recoveries-before-escalate overrides, and a
  hard kill-switch env var independent of the above.
- **Fail-open, unconditionally:** any supervisor error is logged and the sweep continues — it
  never kills a healthy workspace and never blocks the consumer's own work. Verify this with an
  injected error in the test suite (§9 acceptance).
- **Agnostic:** no hardcoded consumer names, branch policies, or app paths. anti-hall reads only
  the generic descriptor (§3) and its own env config — everything consumer-specific stays on the
  consumer's side of the seam.

## 7. Documentation as optional (mandatory section)

DevSwarm-supervisor integration must be documented **exactly like OMC/OMX integration** — an
optional, dormant capability, not a default-on feature:

- README (repo root + `plugins/anti-hall/README.md`): a short "DevSwarm liveness supervisor
  (optional)" section, same tone as the existing OMC/OMX optional-integration notes.
- `llms.txt`: one entry, same pattern as the OMC/OMX entries.
- `plugins/anti-hall/.claude-plugin/plugin.json` (and the Codex mirror): list the new companion
  script if the manifest enumerates companions today, same as `install-reaper.js`.
- State plainly in each: dormant unless `DEVSWARM_REPO_ID` is set AND the companion has been
  explicitly installed (opt-in, §2) — never assume both.

## 8. Platforms

- **macOS / Linux:** full detection + recovery, via the LaunchAgent / systemd timer described in
  §2, using `lsof`/`/proc` respectively for the cwd confirm-gate (§3).
- **Windows: detection-only, never auto-kill.** A running process's cwd is not obtainable in pure
  Node on Windows (no `/proc`, and there's no built-in equivalent to `lsof -d cwd`), so step 2 of
  the §3 derivation — the cwd confirm-gate that makes the kill safe — cannot be performed at all.
  Same rationale as `install-reaper.js`'s Windows no-op: without that confirmation, external
  process targeting is unsafe (PID recycling means a dead PID can be silently reused by an
  unrelated process). On Windows, the supervisor still runs the sweep and writes liveness
  verdicts (§4), but recovery is escalate-only unconditionally. Document this platform split
  explicitly wherever the feature is described (§7).

## 9. Acceptance criteria

- A deliberately wedged workspace (listener killed, unread parent message pending) is detected
  within one sweep interval.
- The wedged workspace is auto-recovered end-to-end (derive session id + pid → confirm-gate →
  kill → resume from the correct cwd → backlog replayed) with **zero false-positive recoveries**
  on a healthy, actively-working workspace.
- **Confirm-gate proven, not assumed:** a test that constructs the documented live counter-example
  (a second process sharing cwd + the session-id string but lacking the session flag, e.g. a
  stale bootstrap wrapper) asserts the supervisor ABSTAINS (writes `ambiguous`, does not kill)
  rather than picking either candidate.
- **No broad kills** — every recovery test proves it targeted only the single confirmed pid
  (argv-uuid + transcript-file cross-check + cwd match all asserted, not inferred).
- **Single-writer lock proven:** a test simulates two concurrent recovery attempts on the same
  workspace and asserts only one proceeds to kill+resume.
- `"No conversation found"` is handled as an expected failure path (test asserts it's logged and
  escalated, not thrown as an unhandled error).
- Restart-loop guard: escalates after N recoveries instead of looping; verified with a test that
  forces N consecutive stale readings.
- `doctor.js` reports PASS/WARN/FAIL for listener + liveness state per active workspace.
- Fail-open verified: an injected supervisor error does not affect any workspace, healthy or
  stale.
- Windows: a test asserts the supervisor never attempts a kill on `process.platform === 'win32'`,
  regardless of liveness verdict.

## 10. Spike results (resolved)

Both spikes gated the recovery half of this design (§5) and have now returned **GREEN**,
confirmed live:

- **Spike A — GREEN.** Headless `claude -p --resume <session-id> --dangerously-skip-permissions`
  rehydrates the session and accepts a fresh prompt without re-executing the last turn, **provided
  it's invoked from the same worktree cwd** the session was created in — invoking it from elsewhere
  fails with "No conversation found" rather than silently resuming the wrong thing (baked into §5
  step 4).
- **Spike B — GREEN, with a hard caveat.** worktree → pid → session-id CAN be mapped precisely and
  safely cross-platform (macOS/Linux) using argv-uuid + `lsof`/`/proc` cwd confirmation (§3) — but
  only when paired with the **confirm-gate** (§3 step 3): a live counter-example exists (a stale
  bootstrap wrapper sharing both cwd and the session-id string) that a naive "match found → kill"
  implementation would have hit. The gate — require exactly one candidate, abstain otherwise — is
  what makes the mapping safe, not the matching alone.

Both results are baked into §3 and §5 above as hard requirements, not options.
