# KB — Claude Code's `Monitor` tool for event-driven orchestration

> Reference knowledge base for Claude Code's **`Monitor` built-in tool** — a background
> listener that emits an event per stdout line and lets an idle orchestrator wake on
> message arrival rather than polling. Introduced v2.1.98 (Week 15, Apr 6–10 2026).
> Project/user-agnostic, with specific application to anti-hall / DevSwarm orchestrators.
> Built from official Claude Code documentation + verified live tool schema.

---

## TL;DR

- **Monitor** = a background listener that watches a shell command or WebSocket and emits
  a transcript event **per line of stdout** (not per run — it stays alive until timeout or
  manual stop). Each event becomes a turn where the agent can react.
- **Key limitation:** Monitor is a session-scoped process — it does **not survive session
  restart**, full stop. Whether it (or a `CronCreate` fallback) survives in-session
  **compaction** or a `--resume` is genuinely **disputed between Anthropic's own sources**
  — see §6 for the conflict and why neither side should be load-bearing without a live
  test. Net effect either way: **cron is never less resume-durable than Monitor**, so it
  stays the fallback of choice.
- **Verified this session, not documented anywhere:** a Monitor event **does** start a new
  turn even in a **fully idle** session (turn ended, nothing pending) — see §4. Anthropic's
  docs are silent on this specific case, so treat it as tested behavior that could change
  without notice, not a guarantee.
- **Availability is not universal.** Monitor is missing entirely on Bedrock/Vertex/Foundry,
  when telemetry is disabled, and — critically for a shipped plugin — for project-scope
  (`@skills-dir`) plugin installs, which never load background monitors at all. See §9.
- **Right shape:** continuous polling with event-per-occurrence (mailbox watcher, health
  check, child workspace heartbeat). Wrong shape: one-shot waits (`tail -f log | grep -m1
  "DONE"`), high-frequency spammers — **measured this session, corrects the "auto-stopped"
  framing: the process is never killed** (see §3/§6/§11); a spammy watcher instead goes
  silently half-deaf as its notification stream gets suppressed.
- **Verified this session, not documented:** a Monitor's `timeout_ms` expiry delivers a
  distinctly-worded final event (`"[Monitor timed out — re-arm if needed.]"`) before ending
  the watch — turning timeout into a self-healing re-arm signal for non-persistent
  monitors, unlike a `persistent: true` monitor that just dies with no such signal. See §6.
- **vs. Bash `run_in_background`:** Bash fires ONE completion notification when the command
  exits; Monitor fires per **occurrence** while living. Trade-off: Monitor is cheaper
  (events only, no full-turn overhead per occurrence), but less useful for one-time
  "wait for build to finish" waits.
- **Application to anti-hall/DevSwarm (decided design):** DevSwarm's Primary orchestrator
  wakes via a 5-minute cron job today (blind polling, token-hungry, expires after 7 days).
  The decision is **layered, not replacement**: Monitor becomes the primary low-latency
  wake path wherever it's available; cron is **retained permanently** as the fallback for
  every case where Monitor provably does not exist (Bedrock/Vertex/Foundry, telemetry
  disabled, project-scope installs, non-interactive sessions). See §7.

---

## Measured vs. documented — read this before trusting either

Most claims in this KB come from official Claude Code docs or the live tool schema, each
tagged `[verified: tool schema]` or `[documented: ...]`. A separate batch of facts below
comes from **direct experiments run in a live Claude Code session this session**
(escalating stdout floods, exit-code probes, a timeout probe, an env-inheritance check,
batching/stderr checks, a line-buffering retest, and a mtime-watcher design test) and is
tagged `[verified: live test, this session]`. These are empirical observations, **not**
Anthropic documentation — several of them **correct or refine** claims stated elsewhere in
this KB, most notably the "automatically stopped" spam-protection claim (§3, §6, §11): a
noisy monitor's process is never killed, only its notification stream is throttled. Treat
every `[verified: live test, this session]` finding as tested, reproducible behavior at the
scale actually tested — not a guaranteed contract, and not exhaustive proof no larger-scale
behavior exists. Same caveat this KB already applies to the §4 idle-wake finding.

---

## 1. What Monitor is (vs other background tools)

**Core semantics** (from v2.1.98 release notes):

> *"The Monitor tool lets Claude watch something in the background and react when it
> changes, without pausing the conversation."*

A **Monitor** is an **active, event-driven listener**. You point it at a command or
WebSocket; it runs continuously; each stdout line becomes a new transcript message, and
the agent wakes up to read and react.

| Aspect | Monitor | Bash `run_in_background:true` | `CronCreate` | `ScheduleWakeup` |
|---|---|---|---|---|
| **Fires on** | Every stdout line (per-occurrence) | Command exit (one-shot) | Fixed schedule (e.g. `*/5 * * * *`) | Next iteration delay (self-paced) |
| **Cost** | One turn per event | One turn per run | One full turn per cron fire | Internal loop cost only |
| **Ideal for** | Continuous watching (mailbox, heartbeat, log tail) | "Tell me once when done" (build, server start) | Blind polling on a timer | Repeated polling under agent control |
| **Resume-safe** | ❌ No (dies on restart; compaction survival undocumented, §6) | ❌ No | ⚠️ Disputed — sources conflict, see §6 | ✅ Yes (in-session only) |
| **Latency** | Sub-second (native event) | None (post-exit) | Interval × 2 worst-case | Agent-paced (∼30s+) |

**The decision:** Monitor **when** a **continuous watch** with **sub-second latency** is
worth the **restart-unsafe** trade-off (paired with a fallback). Bash background for
one-shot waits. Cron for timer-driven blind polling — it's documented in one place as
surviving restart and in another as session-only in-memory (§6), so treat "survives
restart" as the more likely reading but not a settled guarantee.

---

## 2. How Monitor works — parameters & mechanics

**Invocation** (from Claude Code Bash tool):

```bash
Monitor(
  command:   "<shell command>" | ws: {url, protocols?}   # mutually exclusive
  description: "<human-readable label>"                   # required
  timeout_ms: 300000                                       # optional, default 5 min; max 1 hour
  persistent: false                                        # optional; true = session lifetime, stop via TaskStop
)
```

**Parameters breakdown** [verified: tool schema]:

| Parameter | Type | Meaning | Gotchas |
|---|---|---|---|
| `command` | string | Shell command to run (e.g. `tail -f /path/to/log \| grep --line-buffered 'WARN\|ERROR'`) | Bash permission rules apply; runs under the session's allowed commands. One of `command` or `ws` required. |
| `ws` | object `{url, protocols?}` | WebSocket source (e.g. `{url: 'wss://example.com/stream'}`) | No pattern filtering on the ws side; each frame becomes an event. v2.1.195+. Denies private/link-local/cloud-metadata IPs; respects sandbox rules. Frames >1MiB end the watch. |
| `description` | string | Label shown in notifications (e.g. `"Watching build log for errors"`) | Required. Appears in the terminal panel and transcript. |
| `timeout_ms` | number | Milliseconds before auto-stop. Default 300000 (5 min), max 3600000 (1 hour). | `persistent: true` ignores this; use `TaskStop` to halt. Silence ≠ success — a stalled watch is still alive (see coverage rule below). **Measured this session** [verified: live test, this session]: an unbounded emitting monitor was killed cleanly at its `timeout_ms` deadline (no partial/garbled line), delivering a distinct final event, `"[Monitor timed out — re-arm if needed.]"`, with terminal status `killed` — see §6 for why this makes timeout a self-healing re-arm signal, not just a limit. |
| `persistent` | boolean | If `true`, run for the entire session (not subject to timeout). Stop via `TaskStop` tool. | Default `false`. Session-lifetime watches need explicit cleanup. Whether a plugin-declared `when: "always"` monitor gets re-armed for you across a resume/compaction is *not documented* either way — see §5 and §6 before relying on it. |

**NO pattern/condition/regex parameter.** Filtering is **your job**, done **inside the
script** (via `grep --line-buffered`, `awk`, etc.), not via a Monitor argument. Every
stdout line becomes an event regardless.

**Key mechanic — line buffering is mandatory** [verified: tool docs]:

A Monitor fires per stdout line. If your watched command buffers output, lines pile up
and the monitor stalls. Every pipe stage must flush per line:

- ✅ `tail -f log | grep --line-buffered 'pattern'` (grep flushes per match)
- ✅ `awk '{ print; fflush() }' log` (awk flushes after each print)
- ❌ `tail -f log | grep 'pattern'` (grep may buffer 4KB before flushing)
- ❌ `head -N file` (never flushes; waits for N lines, then exits — monitor stays silent)

**Event batching** [verified: tool docs]: stdout lines arriving within 200ms are batched
into a single notification. A flurry of log lines may fire as one `[3 lines received]`
event, not three. **Confirmed concretely this session** [verified: live test, this
session]: three lines emitted via a single `printf` (effectively simultaneous) arrived as
**one** notification containing all three; three lines separated by ~1.5s each arrived as
**three** separate notifications.

**Stdout only** [verified: tool docs]: only **stdout** drives events. Stderr goes to a
readable output file but **does not wake** the agent. If you need stderr, merge it:
`command 2>&1 | grep ...`. **Confirmed this session** [verified: live test, this session]:
a command writing to both streams produced notification events only for stdout lines; all
four lines (stdout + stderr) were present in the output file, with stderr lines tagged
`[stderr]`. One display quirk observed: the tag appeared on the first stderr line but not
on an immediately-following consecutive stderr line — read this as a display quirk, not
data loss (the output file had both lines intact).

**Exit codes and terminal status — measured, not documented anywhere** [verified: live
test, this session]: a command that emits a line then exits non-zero (tested: exit 7)
produced the line's event, then a terminal notification with status `failed` naming the
exit code (`"script failed (exit 7)"`). A command that exits `0` with **no output at all**
produced **no event notification** and terminal status `completed` — a clean, silent,
zero-output exit ends without any event ever firing. Implication: a watcher that crashes
announces itself; a watcher that exits cleanly with nothing to say vanishes without a
trace — "no notification yet" is not proof "still running."

**Environment and cwd inheritance — measured, scope-limited** [verified: live test, this
session]: an **agent-armed** Monitor command echoing `$PWD` / `$HOME` showed it inherits
the session's actual working directory and normal environment; an unset variable correctly
reported as unset (no unexpected env injection). This was verified only for an
**agent-armed** monitor — whether a **plugin-declared** monitor (§5, started by the runtime
at session start) inherits the same environment is **unverified** and should not be
assumed; a plugin monitor that depends on env vars for its identity could silently fail to
resolve them (a related but distinct gap from §5's existing note that plugin monitors don't
receive `CLAUDE_PLUGIN_OPTION_<KEY>`).

**Line-buffering trap — attempted this session, inconclusive** [verified: live test, this
session — INCONCLUSIVE]: piping a slow producer (5 lines at 1s intervals) through `grep`
*without* `--line-buffered` versus *with* it produced **identical** per-line delivery
timing in both cases (~1.0s apart, by timestamp). This does **not** refute the documented
trap — the test was small, run on macOS (likely BSD `grep`, not GNU `grep`), and didn't
exercise the conditions known to trigger it (GNU grep, larger/faster input). Keep
`--line-buffered` as the safe default regardless; treat the trap as
documented-but-not-reproduced-here, not disproven.

---

## 3. The coverage rule — silence is NOT success

**Most critical gotcha** (from Claude Code docs, emphasis added):

> *"Silence is not success. A filter matching only the happy path stays silent through a
> crash/hang — and silence looks identical to 'still running'. Widen the grep alternation
> to include failure signatures."*

**Example:** a monitor watching for "deployment succeeded" will stay silent if:
1. The deployment is actually happening (good, no event yet).
2. The deployment crashed (bad, but no "succeeded" line, so silent anyway).
3. The monitoring command itself died (worse, and silent too).

**Fix:** widen the filter to include error cases:

```bash
# ❌ Matches success only — silent on failure / silent on crash
tail -f deploy.log | grep --line-buffered 'Deployment succeeded'

# ✅ Widen to failures too
tail -f deploy.log | grep --line-buffered -E 'Deployment succeeded|Deployment failed|ERROR|timeout'

# ✅ Also emit on monitor-health errors
tail -f deploy.log | grep --line-buffered -E '...' || echo "ERROR: deploy log died"
```

**Principle:** a dead monitor looks like a stalled one. Always pair a positive filter
(happy path) with **one or more negative filters** (errors, timeouts, crashes) so the
agent can distinguish "still waiting" from "something broke."

**Measured design lesson — trigger on semantic delta, never on mtime** [verified: live
test, this session]: a monitor watching the **mtime** of a shared state directory emitted
8 events in ~70 seconds while only one meaningful thing was actually happening — because
the directory's mtime changes on **every** write (heartbeats, cursor advances, projection
re-derives), not only on actionable new messages. At that rate it reaches the ~19-20 event
suppression ceiling (corrected understanding of "auto-stop," see §6/§11 below) in under
three minutes, and the wake channel degrades into notification-suppression while still
*looking* healthy — process alive, no error, just going quiet.

**Rule:** the **emit** decision must come from **parsed state** (a monotonic counter
advancing, a new message ID), never from a file/directory mtime or a generic "something
changed" signal. mtime is fine as a cheap *gate* to skip re-parsing unchanged bytes, but it
must never be the trigger itself. Corroborating live evidence: an idle workspace in a real
mesh was observed broadcasting the same status message 50+ times at ~285-second intervals
(a 5-minute polling cadence) — heartbeat traffic alone, with zero new information, is more
than enough to exhaust the event budget. (The `devswarm-mailbox-watcher.sh` sketch in §7
already follows this rule — it emits on `seq > last_seq`, not on mtime — this finding
corroborates that design choice rather than correcting it.)

---

## 4. Waking a fully idle session — verified finding (undocumented)

**The gap:** Anthropic's docs explicitly state that `CronCreate` "fires between your
turns" and wakes an idle REPL [documented: scheduled-tasks docs]. They are **silent** on
the equivalent question for Monitor — specifically, whether a Monitor event can start a
new turn in a session that is **fully idle**: turn already ended, no pending question, no
other background work outstanding, just waiting on user input.

**We tested it directly, twice, in a live Claude Code session** [verified: direct
behavioral test, this session]:

| Test | Setup | Result |
|---|---|---|
| 1 | Monitor armed, agent turn ended, event fired ~75s later | Started a fresh turn — but **confounded**: background subagents were still pending, which may itself be what kept the session wakeable. |
| 2 (clean) | All background agents finished first, Monitor was the *only* pending work, agent went fully idle, event fired ~70s later | Started a fresh turn with **zero** other pending work. |

**Conclusion** [verified: direct behavioral test, this session]: a Monitor event **does**
start a new turn in a fully idle session. This is empirically confirmed but **not
documented by Anthropic anywhere** — treat it as tested current behavior, not a
guaranteed contract. It could change in a future release without a changelog entry, since
no doc commits to it.

---

## 5. Plugin-declared monitors (auto-managed)

**Location** [verified: tool/plugin schema]: a plugin declares monitors either in a
`monitors/monitors.json` file at the plugin root, or inline via `experimental.monitors` in
`plugin.json` (an inline array, or a relative path string pointing at a JSON file).

**Schema** [verified: tool/plugin schema]:

| Field | Required | Meaning |
|---|---|---|
| `name` | ✅ | Unique within the plugin. |
| `command` | ✅ | Runs as a persistent background process in the session's working directory. |
| `description` | ✅ | Human-readable label. |
| `when` | optional | `"always"` (default) — starts at session start and on plugin reload. `"on-skill-invoke:<skill-name>"` — starts when that skill runs. No other values are documented. |

**Substitution** [verified: tool/plugin schema]: `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `${ENV_VAR}` are all substituted in
`command`. `${user_config.*}` is **rejected with an error** as of v2.1.207 — before that
version it was silently substituted instead. Monitor processes do **not** receive
`CLAUDE_PLUGIN_OPTION_<KEY>` env vars the way some other plugin hooks do; if a monitor
needs user-configured options, have its script read a config file the plugin owns rather
than relying on env injection. (Related but distinct gap, measured this session: §2
confirms normal cwd/env inheritance for **agent-armed** Monitor calls specifically —
whether a plugin-declared monitor gets the same inheritance is unverified; don't assume
parity between the two.)

**Other properties** [verified: tool/plugin schema]:
- Disabling a plugin mid-session does **NOT** stop already-running monitors.
- Plugin update mid-session does **not** change a running monitor's command path (needs a
  restart to pick up the new one).
- Project-scope installs never load background monitors at all — see §9, this is a hard
  gap, not a timing nuance.

**Resume behavior — do not overclaim:** it is tempting to assume a plugin-declared
`when: "always"` monitor "auto-restarts" across a resume, the way `SessionStart` hooks do.
**This is not documented.** The blanket doc statement "Background Bash and monitor tasks
are never restored on resume" carves out no exception for plugin-declared monitors. The
defensible reading is that they are **not** restored either [inference] — but this is
inference, not a verified fact, and a live behavioral test (arm a `when: "always"` monitor,
`--resume` the session, check if it's still running) is required before any design depends
on it either way.

**Experimental — expect schema drift:** monitors are an **experimental** plugin component;
Anthropic's own framing is that "schema may change between releases while they stabilize."
Anyone shipping a plugin that depends on this should treat the schema above as current, not
locked.

---

## 6. Resume and compaction — sources conflict, read this before relying on either

**What's solid — monitors themselves** [documented: scheduled-tasks docs]:

> *"Background Bash and monitor tasks are never restored on resume."*

This half is not in dispute: a Monitor is a session-scoped OS process. When the session
ends (restart) the process is gone, full stop, no error, no cleanup.

**What's NOT solid — whether CronCreate is the durable fallback it's assumed to be.**
Two Anthropic-authored sources disagree:

- **The live `CronCreate` tool schema** (authoritative for the current tool as installed)
  says [verified: tool schema]: *"Jobs live only in this Claude session — nothing is
  written to disk, and the job is gone when Claude exits."* Its `durable` parameter is
  documented as: *"Has no effect — durable persistence is not available. All jobs are
  session-only (in-memory, gone when this Claude session ends)."* Recurring cron jobs also
  auto-expire after 7 days regardless.
- **The scheduled-tasks docs page**, by contrast, describes `CronCreate` tasks as
  restoring on `--resume` if unexpired — in the same breath that it excludes monitors by
  name ("Background Bash and monitor tasks are never restored on resume," quoted above)
  [documented: scheduled-tasks docs]. The exclusion of monitors only makes sense as a
  contrast if cron tasks *are* being restored on the other side of that sentence.

**These two sources contradict each other.** This KB will not pick a side. A plausible
reconciliation [inference]: `--resume` reconstructs session state from a saved
transcript/state file — which could include re-hydrating unexpired cron tasks — whereas a
cold restart (no `--resume`) does not, matching the "session-only, gone when Claude exits"
language in the tool schema. Monitors, being live OS processes rather than serializable
state, cannot be reconstructed either way. **Label this reconciliation `[inference]` only**
— it is a story that fits both quotes, not a verified mechanism. Neither the tool-schema
claim nor the docs-page claim should be load-bearing for a design until someone runs the
actual test: arm a cron job, `--resume` the session, and check if it fired.

**Net guidance that survives the conflict either way:** cron is **at least as
resume-durable as Monitor, never less** — in the worst case (tool schema is right) both
are equally session-only; in the best case (docs page is right) cron survives and Monitor
still doesn't. There is no reading under which Monitor out-survives cron. That asymmetry,
not a confirmed durability guarantee, is why cron remains the fallback (§7).

**Compaction is a separate, equally undocumented question.** In-session auto-compaction
does not create a new session the way `--resume` does, so the resume conflict above
doesn't directly answer whether a Monitor (or a plugin `when: "always"` monitor) survives
it. Do not assume survival either way without a live test.

**Available re-arm triggers** [documented: Claude Code docs]:
- `SessionStart` hook fires "when a session begins or resumes."
- `PreCompact` / `PostCompact` hook events exist around the compaction boundary.

These are the mechanical hooks available to re-arm a watch; see §7 for how anti-hall/
DevSwarm uses them.

**What ends a monitor, definitively** [verified: tool schema / docs] — independent of the
resume/compaction question above:
- Its `timeout_ms` deadline, unless `persistent: true`.
- An explicit `TaskStop`.
- Session end.
- The watched script/command exiting.
- ~~Auto-stop when it produces too many events (spam protection)~~ — **this does NOT end
  the monitor.** Measured and corrected this session — see the callout immediately below.
- For `ws` monitors specifically: a frame larger than 1 MiB, or the socket closing.

**CORRECTION — "automatically stopped" is not a process kill** [verified: live test, this
session]: the docs and the tool's own description text say monitors producing too many
events are "automatically stopped." Measured across four escalating trials — a steady 1
line/sec for 30s, ~20 lines/sec, an instant 500-line dump, and an instant 5000-line dump —
**the monitored process was never killed in any trial**. Every trial ran to natural
completion with terminal status `completed`, and the **output file** contained the
complete output every time (5000/5000 lines exact, verified with `wc -l`).

What actually happens is **notification suppression**, not termination: after roughly
19-20 notification events, the stream begins dropping events and substituting a marker
line of the form `"[N events suppressed — output rate too high...]"`. The drop rate scales
up with volume — observed `[1 events suppressed]` alternating at 1/sec, growing to `[4]`,
`[6]`, `[8]`-event blocks at ~20/sec. Instant bulk dumps arrive as **one** batched
notification whose displayed content is **truncated** (cut off partway with a truncation
marker), while the output file stays complete.

**Practical implication:** a noisy watcher will not die — it goes **silently half-deaf**
while still appearing alive (process running, notifications still trickling in). The
monitor's **output file** (path given in every notification, readable with `Read`) is the
only authoritative record once suppression kicks in; never treat the notification stream
alone as a complete log for a monitor this noisy.

**Not exhaustively tested:** sustained multi-minute floods were not run, so a harder
cutoff at much higher cumulative volume remains untested — this finding covers the tested
range (light-to-heavy bursts over ~30s), not a claim that no cutoff exists at any scale.

**Timeout as a measured re-arm signal** [verified: live test, this session]: a monitor
with `timeout_ms: 15000` on an unbounded emitting loop was killed cleanly at the deadline
— no partial/garbled line — and delivered a distinctly-worded final event,
`"[Monitor timed out — re-arm if needed.]"`. Terminal status is `killed`, confirmed
because a subsequent `TaskStop` on that task returned an error, `"Task ... is not running
(status: killed)"` — itself a reliable way to check a monitor's final state after the
fact. **Design implication:** because the timeout message is itself an event delivered to
the agent, a **non-persistent** monitor with a bounded `timeout_ms` gives a self-healing
re-arm loop for free — the expiry wakes the agent and tells it to re-arm — whereas a
`persistent: true` monitor that dies (session end, crash) leaves **no such signal**. This
is a concrete point in favor of bounded-timeout-plus-re-arm-on-expiry over
`persistent: true` for exactly the kind of long-lived watch §7 describes, weighed against
the double-arming risk already called out there.

---

## 7. Anti-hall / DevSwarm orchestration — waking the Primary

### Current state (v0.66+)

DevSwarm's Primary orchestrator currently wakes via a **CronCreate mailbox-read job**:

```javascript
// Every 5 minutes, read the mailbox
CronCreate({
  expression: '*/5 * * * *',
  prompt: 'node scripts/devswarm.js inbox read-primary <id>'
})
```

**Costs:**
- ❌ Blind polling: fires every 5 minutes **regardless of whether a message exists** (token waste).
- ❌ Expires after 7 days (recurring jobs auto-expire; must be re-armed).
- ❌ Latency: worst-case 5 minutes for a child to wake the Primary (children send a message, but if it arrives between cron fires, the Primary sleeps for up to 5 more minutes).

### Decided design: layered, not a replacement

**Monitor becomes the primary wake path; cron is retained permanently as the fallback** —
not a transitional step to be removed once Monitor is proven. This is a deliberate,
owner-decided design, for one reason: **a public plugin cannot ship a wake path that
silently does not exist for a slice of its users.** Section 9 lists concrete cases where
Monitor is simply absent — Bedrock, Vertex AI Agent Platform, Microsoft Foundry,
`DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, project-scope plugin
installs, and non-interactive sessions. A DevSwarm Primary running in any of those
contexts that only had Monitor would be a **silently deaf orchestrator** — worse than the
blind 5-minute poll it would replace, because a poll at least eventually fires.

So: Monitor for low-latency wake wherever it's available, cron always present underneath
it as the path that provably still works when Monitor doesn't.

**Monitor** replaces the polling for **live-session latency**. Each time a child sends a
message, a watcher script detects it and fires an event — the Primary wakes immediately,
no delay.

```bash
# Sketch (illustrative — see below for real pattern)
while true; do
  # Poll devswarm.js inbox for new messages, emit one line per new message
  node scripts/devswarm.js inbox read-primary <primary-id> --since <last-seen> \
    | jq -r '.[] | @json' || echo "ERROR: inbox read failed"
  sleep 1  # Poll every 1 second (tighter than 5 min)
done | \
  # Only emit lines that are NEW messages (filter out duplicates / errors)
  grep --line-buffered -E '^\{' # Emit JSON message objects; skip error lines
```

Each time the watcher sees a new message, a line passes through the filter → event fires
→ agent wakes and processes the message.

**Re-arm pessimistically.** Given §6's conflict, the safe assumption is that Monitor does
**not** survive compaction and cron's own resume-durability is unconfirmed. So: re-arm
proactively rather than hoping either survives.

- **`PostCompact` hook** → re-arm after in-session compaction.
- **`SessionStart` hook** → re-arm on resume/session begin.
- **Cron mailbox job stays live the whole time**, unconditionally, as the fallback that
  keeps working even if a re-arm is missed or Monitor is unavailable in this environment
  (§9).

**A hook cannot call the Monitor tool directly** — hooks are shell scripts, not agent tool
calls. What a `PostCompact`/`SessionStart` hook actually does is inject context (a
system-reminder) telling the *agent* to re-arm the watch on its next turn. That makes this
path **instruction-driven, not mechanical** — the agent has to act on the injected
instruction; nothing forces it to. The one **truly mechanical** re-arm is a plugin-declared
`when: "always"` monitor (§5), which the runtime itself restarts at session start — with
the caveat from §5 that its behavior across resume/compaction is *also* undocumented and
needs its own live test.

```bash
# PostCompact / SessionStart hook (shell script) — illustrative
# Cannot call Monitor() itself. Injects an instruction for the agent to act on.
echo '{"systemMessage": "Re-arm the Primary mailbox monitor: check if it is already running (see dedup note below) before starting a new one."}'
```

```javascript
// Agent-side, on the next turn, acting on the injected instruction:
Monitor({
  command: 'scripts/devswarm-mailbox-watcher.sh <primary-id>',
  description: 'Primary workspace mailbox watcher',
  persistent: true
})
```

**Double-arming warning.** If Monitor *does* turn out to survive compaction in some case
(unconfirmed either way, §6) **and** a re-arm instruction also fires, you end up with two
watchers running against the same mailbox — duplicate events, duplicate wakes, and a
Primary processing the same message twice. Any re-arm path **must** include an
idempotency/dedup check (e.g. a marker file or a mailbox-cursor lock keyed to a single
active watcher) before starting a new Monitor, not just a "start on every hook fire"
approach.

**Semantics:**
- **Monitor** fires per message (latency: ~1s when live) — the primary path, where
  available.
- **Cron mailbox job** keeps running unconditionally as the fallback (§9 lists where it's
  the *only* path).
- **Re-arm hooks** (`PostCompact`, `SessionStart`) inject instructions to restart the
  monitor, guarded by a dedup check.

### Example monitor script (generic, for mesh mailbox)

This sketch shows the pattern. Replace `scripts/devswarm.js inbox read-primary` with
whatever your mesh/mailbox read command is [illustrative]:

```bash
#!/bin/bash
# scripts/devswarm-mailbox-watcher.sh <primary-workspace-id>
# Watches for new messages in a primary workspace's mailbox.
# Emits one line per NEW message; handles seq tracking to avoid re-emitting.

set -e
primary_id="$1"
cursor_file="$HOME/.anti-hall/mailbox-cursor-${primary_id}.txt"
mkdir -p "$HOME/.anti-hall"

# Initialize cursor (last-seen message seq)
last_seq=0
[ -f "$cursor_file" ] && last_seq=$(cat "$cursor_file")

# Poll loop — runs until monitor timeout or TaskStop
while true; do
  # Read new messages, filter by seq > last_seq [illustrative — adapt to your mesh]
  response=$(node scripts/devswarm.js inbox read-primary "$primary_id" \
    --json 2>&1 || echo '{"error":"read failed"}')

  # Handle read errors — COVERAGE RULE: emit failure signature
  if echo "$response" | jq -e '.error' >/dev/null 2>&1; then
    echo "ERROR: inbox read failed — $response"
  else
    # Extract new messages (seq > last_seq) and emit one line per message
    echo "$response" | jq -r ".messages[] | select(.seq > $last_seq) | @json" | \
      while read -r line; do
        echo "$line"  # One line per new message → one Monitor event
        # Update cursor to this message's seq [illustrative]
        seq=$(echo "$line" | jq .seq)
        echo "$seq" > "$cursor_file"
        last_seq="$seq"
      done
  fi

  # Sleep before next poll — tighter interval than cron (1s vs 5 min)
  sleep 1 || break  # break if sleep is interrupted (TaskStop signal)
done
```

**Key details:**

- **Line buffering:** `jq -r` flushes per line, and each `-e` check emits immediately.
- **Tracking state:** cursor file stores the last-seen message seq; only emit new messages
  (avoid re-firing old ones).
- **Coverage rule:** if `inbox read` fails, emit an ERROR line so the monitor stays alive
  and the agent sees something broke (not just silence).
- **One line per message:** each new message = one line through stdout → one Monitor event.
- **Graceful poll failure:** `|| echo "error"` ensures the loop doesn't die on a transient
  read failure (survives the failure, logs it, moves on).

---

## 8. Dual-platform note — Codex parity

**Monitor is a Claude Code built-in** — a feature of the Claude Code CLI runtime, not a
generic Claude AI capability. **No verified Codex equivalent exists** [verified: Claude
Code v2.1.98 release notes + official docs are Claude-only; Codex has no `Monitor` MCP
or equivalent tool in `omx` CLI].

**For anti-hall's dual-platform mandate** (Claude + Codex ports both ship):
- **Claude:** use Monitor + Cron fallback as described (§7).
- **Codex:** fall back to CronCreate polling only, or implement a thin wrapper around the
  same mesh-read command if lower latency is needed (but there is no Monitor equivalent, so
  you're back to polling).

A future Codex release may add an equivalent; update this KB if verified.

---

## 9. Limits and permissions — where Monitor simply does not exist

These gaps are why §7 keeps cron as a permanent fallback rather than a transitional one —
each is a case where Monitor is not degraded, it is **absent**.

**Availability** [verified: official docs]:
- ❌ **NOT available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft
  Foundry** (Claude Code feature only — these platforms have no Monitor tool at all).
- ❌ **NOT available if `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  env var is set** (telemetry required).

**Plugin monitors specifically** [verified: tool/plugin schema]:
- Run **only in interactive CLI sessions** — there is no background-monitor support outside
  an interactive session.
- Run **unsandboxed, at the same trust level as hooks** — a plugin monitor's `command` is
  not subject to any additional sandboxing beyond what hooks already get.
- Are **skipped entirely** in any context where the Monitor tool itself is unavailable
  (the platforms and env vars listed above).
- **CRITICAL: project-scope (`@skills-dir`) plugin installs do NOT load background
  monitors at all.** Only personal-scope plugin installs get plugin-declared monitors.
  A plugin relying on a `monitors/monitors.json` watcher has **zero** wake path from that
  mechanism for every user who installed it at project scope — this is not a timing or
  latency nuance, it is a hard capability gap.

**WebSocket limits** (v2.1.195+) [verified: official docs]:
- Denies private/link-local/cloud-metadata IP addresses.
- Respects sandbox denied-domains and `allowManagedDomainsOnly` policy.
- Frames >1 MiB end the watch (large frames crash the stream).
- Binary frames become a placeholder line (not parsed as events).
- Socket close (server-side or network) ends the watch with the close code logged.

**Permissions** [verified: Claude Code docs]:
- **`command` mode:** checked against the same **Bash permission rules** (the Bash tool's
  allow/deny patterns apply to the Monitor command too).
- **`ws` mode:** has its own **approval prompt** with no "always allow host" option
  (unlike Bash hostlist); user must approve once per session.

---

## 10. Comparison table — when to reach for each tool

| Task | Tool | Why |
|---|---|---|
| "Wait for build to finish, then tell me" | Bash `run_in_background` + `until` loop | One-shot; fires at the end. Simple. |
| "Watch a log continuously and react to every error" | Monitor | Per-event firing; low latency; does not survive restart, compaction survival undocumented (§6) — needs a re-arm plan. |
| "Every 5 minutes, run a check / poll a mailbox" | CronCreate | Blind polling (fires regardless of result); resume-durability is disputed between sources (§6) but never worse than Monitor's. |
| "Poll once per turn until success" | Bash `run_in_background` with `until` loop (just exits when done) | Pairs with ad-hoc turns; simpler than a full Monitor setup. |
| "Check status and react if changed, repeat every 30s" | Monitor + per-line filter (emit only on change) | Latency-sensitive, but must pair with a cron fallback (§7) — Monitor's own resume-safety is not guaranteed. |
| "Run a daemon that restarts itself" | Plugin-declared monitor `when: "always"` | Restarts on session start / plugin reload by design (§5) — whether that extends across a resume/compaction is undocumented; still personal-scope-only (§9). |

---

## 11. Gotchas and tradeoffs

**Q: My monitor never fires. What's wrong?**

- Forgot line buffering in a pipe stage (output buffered, lines pile up).
- Used `head -N` or similar one-shot commands (never flushes; dies after N lines).
- Command exited early (a transient error, and the while loop died).
- Filter is too strict (matches nothing legitimately).

**Fix:** add `|| echo "ERROR: ..."` to every pipe stage and wrap in a while loop that
logs errors instead of dying. (Note: a small live test this session could not reproduce
the classic GNU-grep line-buffering trap on macOS/BSD `grep` — see §2. Keep
`--line-buffered` as the safe default regardless; not reproducing it here is not proof it
doesn't exist elsewhere.)

**Q: My monitor fires too much — does it get killed?**

**No — measured this session, corrects the naive reading of "automatically stopped"**
[verified: live test, this session; full writeup in §6]: the process is never killed.
What happens instead is **notification suppression** — after ~19-20 events the stream
starts dropping notifications and substituting `"[N events suppressed]"` markers, while
the process keeps running to completion and the **output file stays complete**. The real
cost isn't a dead monitor, it's a **degraded wake channel** that still looks healthy.
Tighten the filter anyway — not to dodge a kill that doesn't happen, but to keep the
notification stream itself sparse and useful instead of half-deaf:

```bash
# ❌ Emits every line of a noisy log — hits notification suppression fast
tail -f app.log | cat

# ✅ Emit only warnings and errors — keeps the event stream sparse and reliable
tail -f app.log | grep --line-buffered -E 'WARN|ERROR'
```

**Q: How do I know if the monitor died vs. is just waiting?**

**You don't, without the coverage rule** — and there's now a third state to rule out, not
just two. Silence can mean: still running OK, actually dead, **or** running fine but
notification-suppressed (§6) because it's too noisy. This is why the filter must include
error signatures **and** stay sparse enough to avoid the ~19-20 event suppression ceiling:
if you also emit on failure (errors, timeouts, crashes) and keep normal volume low, then
silence does mean "still running OK" instead of ambiguous.

**Q: Why does my monitor die after the session resumes?**

Monitors do not survive session restart — that part is solid. Whether they (or a
plugin-declared `when: "always"` monitor) survive in-session compaction is **not
documented either way** [inference only — see §6]. Don't assume a plugin monitor
"auto-restarts cleanly" across compaction/resume without testing it live. Plan for it by
re-arming pessimistically via `PostCompact`/`SessionStart` hooks and keeping a cron
fallback running unconditionally (§7).

**Q: What's the latency?**

- **Sub-second when live** (native stdout event, no polling).
- **Worst-case if Monitor is down and only cron is covering:** bounded by your cron
  interval (e.g. every 5 minutes for the DevSwarm mailbox job, §7).

---

## 12. Session-start / post-compact re-arm pattern (for resilience)

If you use Monitor for something that should keep working across compaction and resume
(like a Primary mailbox watch), do **not** assume either survives (§6). Re-arm
pessimistically, and guard against double-arming.

**What a hook can and cannot do:** `PostCompact` and `SessionStart` are shell-script hooks
— they cannot call the `Monitor` or `CronCreate` tools directly. What they *can* do is
inject an instruction (a system-reminder / context message) for the agent to act on next
turn. That makes this re-arm path **instruction-driven**, not a mechanical guarantee — the
agent must actually follow through.

```bash
#!/bin/bash
# PostCompact and SessionStart hook — illustrative, not production code.
# Injects context; does NOT call Monitor/CronCreate itself (hooks can't).
echo '{"systemMessage": "Session (re)started or compacted. Re-arm the Primary mailbox watch: 1) check .anti-hall/monitor-lock-<id> for an existing active watcher before starting a new one (avoid double-arming, see below); 2) if absent, start the mailbox Monitor and write the lock; 3) the cron mailbox job keeps running regardless — no action needed there."}'
```

```javascript
// Agent-side, acting on the injected instruction — illustrative:
// 1. Dedup check first — avoid double-arming (see warning below).
const lockPath = `.anti-hall/monitor-lock-${primaryId}`;
if (!fs.existsSync(lockPath)) {
  Monitor({
    command: 'scripts/devswarm-mailbox-watcher.sh ' + primaryId,
    description: 'Primary workspace mailbox watcher',
    persistent: true
  });
  fs.writeFileSync(lockPath, String(Date.now()));
}
// 2. Cron mailbox job (§7) is not touched here — it runs unconditionally,
//    independent of whether the Monitor re-arm above succeeds.
```

**Double-arming warning (repeated from §7 because this is where it bites):** if the prior
Monitor somehow survived the compaction/resume **and** this re-arm instruction also fires,
you get two watchers on the same mailbox and duplicate events. The dedup/lock check above
is not optional — without it, double-arming is the default outcome of "re-arm on every
hook fire," not an edge case.

On session start or post-compaction:
1. Hook fires → injects the re-arm instruction (does not act on its own).
2. Agent's next turn checks the lock, re-arms Monitor only if not already running.
3. Cron mailbox job (§7) keeps running the whole time regardless, unconditionally.

---

## Sources

**Official Claude Code Documentation**

1. Monitor tool reference — https://code.claude.com/docs/en/tools-reference#monitor-tool
2. Scheduled tasks & CronCreate — https://code.claude.com/docs/en/scheduled-tasks (source
   for both the "fires between your turns" idle-wake claim for cron, §4, and the
   "tasks restore on resume if unexpired" claim that conflicts with the live tool schema,
   §6)
3. Plugins & monitors/monitors.json — https://code.claude.com/docs/en/plugins-reference
4. Claude Code what's new — Week 15 (Apr 6–10 2026, v2.1.98 release) —
   https://code.claude.com/docs/en/whats-new/2026-w15
5. WebSocket monitoring (v2.1.195+) — https://code.claude.com/docs/en/tools-reference#monitor-tool

**Verified live tool schemas (not docs-site URLs — pulled directly from the installed
tool definitions)**

6. `Monitor` tool schema — source for the parameter table (§2) and the tool's own
   description text claiming monitors are "automatically stopped" on too many events.
   **This specific claim is corrected, not confirmed, by live measurement** — see item 9
   below and the §6/§11 correction: the tool's own docstring says "stopped," but four live
   trials this session showed only notification suppression, never a process kill.
7. `CronCreate` tool schema — source for the "jobs live only in this Claude session... gone
   when Claude exits" and `durable` parameter language quoted in §6.

**Directly tested behavior (this session, not sourced from any doc)**

8. Two live behavioral tests of Monitor waking a fully idle session — §4.
9. Four escalating-volume trials showing "auto-stop" is notification suppression, not a
   process kill (steady 1/sec, ~20/sec, instant 500-line dump, instant 5000-line dump) —
   §6, §11.
10. Batching, stderr tagging, exit-code/terminal-status behavior, the timeout re-arm
    signal, env/cwd inheritance (agent-armed only, unverified for plugin-declared), and an
    inconclusive line-buffering retest on macOS/BSD `grep` — §2.
11. A naive mtime-based watcher design failure (8 events/70s on near-zero signal) plus
    corroborating live-mesh heartbeat volume (50+ broadcasts at ~285s intervals) — §3.

Items 8-11 are empirically verified this session but **not backed by any Anthropic
documentation** and could change without notice.

**Related KB documents in this repo**

12. `KB-devswarm-hivecontrol.md` — DevSwarm orchestration & `hivecontrol` CLI
13. `KB-claude-workflow-orchestration.md` — multi-agent orchestration primitives
14. `KB-claude-codex.md` — Codex platform and parity with Claude Code (for dual-platform
    implications)

---

## Appendix — false leads and non-equivalents

**What Monitor is NOT** (common confusions):

- **Not a `tail -f` alias.** It's a background listener that emits events; you still manage
  the command (line buffering, filtering, restart on error).
- **Not available on Codex.** Monitor is Claude Code–only (at least as of v2.1.98). Codex
  users fall back to CronCreate or equivalent polling.
- **Not a pattern matcher.** Monitor doesn't have a `--regex` or condition field; filtering
  is your job (via `grep`, `awk`, etc. inside the command).
- **Not persistent across restart.** Monitors die on session restart, no dispute there.
  Whether a cron fallback or a plugin-declared monitor survives a `--resume` or in-session
  compaction is **contested/undocumented** (§6) — plan for it, but don't assert either
  survives without testing.

**Tools that SOUND similar but aren't:**

- **`tail -f log | grep "pattern" &`** — a local background shell command (doesn't integrate
  with Claude); no event waking; no agent loop.
- **`ScheduleWakeup` in a `loop`** — paces iterations of a self-written poll loop (inside
  the agent's control); not for watching external systems.
- **MCP servers with `tools_list` streaming** — different integration layer (MCP, not native
  Claude Code); different latency profile (RPC call vs. native event).

---

**Document status:** Compiled from official docs + verified live tool schemas (as of
Claude Code v2.1.207), plus a growing set of directly-tested, live-experiment findings that
no Anthropic doc confirms — the idle-wake test (§4), the four-trial "auto-stop is
notification suppression, not a kill" correction (§6, §11), and the batching/stderr/exit-
code/timeout/env-inheritance/line-buffering/mtime-watcher findings (§2, §3). Where sources
conflict (§6, resume-durability of `CronCreate`) or where a live test contradicts a
documented claim (the "auto-stop" wording), this KB states the discrepancy rather than
picking a side or quietly averaging them — treat those claims as needing further testing
before any design leans on them further than the tested range. Monitor remains in the
public API; no known breaking changes since v2.1.98. The DevSwarm application (§7) is
**illustrative** — the specific mesh-read wrapper (`scripts/devswarm-mailbox-watcher.sh`)
is a pattern sketch, not production code (adapt to your actual mailbox/mesh transport).
