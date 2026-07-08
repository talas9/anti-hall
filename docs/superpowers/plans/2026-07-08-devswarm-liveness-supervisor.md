# DevSwarm Liveness Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code block below is complete and runnable — there are no placeholders or `TODO`s to fill in.

**Goal:** Give anti-hall an OPTIONAL, pure-Node, cross-platform, fail-open **liveness supervisor** that detects a DevSwarm workspace whose `claude` session has silently wedged (alive process, dead listener — the `claude-code#39755` failure class) and recovers it end-to-end (derive the ONE session id + pid → confirm-gate → precise kill → headless `--resume` from the same worktree cwd → replay the unread backlog), with **zero** behavior change anywhere outside DevSwarm.

**Architecture:** A session-side **feature-detect helper** (`hooks/lib/devswarm-detect.js`, modeled on `hooks/omc-detect.js`) reports whether the supervisor is in play. Three **pure companion libs** carry the logic: `target-session.js` (the SPIKE-VERIFIED worktree→pid→uuid recipe with the exactly-one-or-abstain confirm-gate), `liveness.js` (outbound-staleness detector + atomic verdict writer), and `recovery.js` (confirm-gated precise kill + single-writer resume + N-cap escalation). A **sweep companion** (`devswarm-supervisor.js`) reads the consumer's published workspace descriptors and ties detect→recover; an **installer** (`install-devswarm-supervisor.js`, modeled EXACTLY on `install-reaper.js`) runs it as an opt-in background job (macOS LaunchAgent / Linux systemd timer + cron fallback / Windows no-op). A small **doctor check** (`companion/lib/doctor-devswarm.js`, wired into `hooks/doctor.js` exactly like the flutter-debug preflight) reports PASS/WARN/FAIL per active workspace.

**Tech Stack:** Pure Node.js built-ins only (`fs`, `path`, `os`, `child_process`) — no dependencies. Tests use `node:test` + `node:assert` (zero-dep), spawn hooks via `tests/helpers/spawn-hook.js`, and build fake HOMEs via `tests/helpers/fixtures.js` `makeHome()`. All process/kill/spawn/fs access in the companion libs is behind **injectable runners** so unit tests touch NO real process. Installer manifests are launchd plist / systemd unit / cron text.

---

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the approved design (`docs/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md`), the launching task brief, and the repo's `CLAUDE.md`:

- **Pure Node built-ins only** in hooks/companion — no `python3`/`jq`/`sed`/`grep`, no npm deps. Process enumeration uses `ps`; cwd confirmation uses `lsof` (macOS) / `/proc` (Linux); git activity uses `git` — all via `spawnSync` behind injectable runners.
- **OS-agnostic** — macOS/Linux get full detection + recovery; **Windows = detection-only graceful no-op** (a running process's cwd is not obtainable in pure Node on Windows, so the cwd confirm-gate that makes the kill safe cannot run; recovery is escalate-only there, unconditionally). No POSIX-only constructs elsewhere; use `path`, `fs.renameSync` for atomic writes.
- **Every component fail-open** — any supervisor error is logged and the sweep continues. NEVER kill a healthy child; NEVER broad `pkill`; NEVER kill on an ambiguous target. A detection/read error fails toward NOT-stale and NOT-kill.
- **Feature-detected via `DEVSWARM_REPO_ID`** — zero effect when absent, exactly like OMC/OMX. `devswarm-detect.js` is dormant unless `DEVSWARM_REPO_ID` is set (auto mode); the supervisor daemon and installer are **opt-in** (a component that can kill a process never self-installs — the user runs the installer explicitly).
- **Public-repo-agnostic** — NO private names in shipped files: no consumer/product/submodule names, no emails, no machine paths. The only allowed identity is the author credit (`Mohammed Talas / talas9`). anti-hall reads only the generic descriptor (§3 of the design) and its own env config; everything consumer-specific stays on the consumer's side of the seam.
- **Label every component a workaround for `claude-code#39755`** in code comments and docs — re-evaluate and remove when upstream ships a real fix.
- **No self-credit in commits** — commit messages carry NO `Co-Authored-By` trailer and NO "Generated with <AI>" line (git-guard blocks these; the human is the author).
- **`node --test` from repo root** is the authoritative check (CI matrix = ubuntu/macos/windows × node 18/20/22/24). Local green ≠ CI green: after the final task, CI must be checked (`gh run list`/`view`) before calling the work done.
- **Dual-platform parity** — the DevSwarm-supervisor integration is documented as OPTIONAL in BOTH the Claude surfaces and the Codex mirror (README root + plugin, llms.txt, docs/KB.md, plugin.json + `.codex-plugin` manifest). The companion libs are runtime-shared (invoked by the installed job, not by a hook), so no `hooks.json` / `install-codex.js` manifest change is required — call that out explicitly rather than adding an empty parity edit.

---

## Interface (the seam) — what the consumer publishes vs. what anti-hall derives

This is the deliverable's core and it is intentionally small. anti-hall assumes nothing about consumer internals beyond this contract.

**Consumer publishes** (a small addition on the consumer side — specified here, NOT built by anti-hall) — one descriptor per active workspace:

```
~/.anti-hall/devswarm/workspaces/<id>.json = {
  "id":          "<workspace id>",
  "worktreePath":"<absolute path to the workspace's git worktree>",
  "inboxPath":   "<path to the durable inbound-message NDJSON log>",
  "cursorPath":  "<path to the consumer's read-cursor over that log>",
  "sessionId":   "<the exact session uuid the consumer spawned the child with>"
}
```

- `inboxPath` is an **NDJSON append-only log**, one message per line.
- `cursorPath` is a small file whose content is either a **bare integer** or JSON `{"line": <int>}` = the count of lines the consumer has already consumed. anti-hall reads unread = `lines[cursor..]`. If the cursor is absent/unparseable, anti-hall treats the backlog as **unknown → not pending** (fail-safe: never nominate a workspace it cannot read for a kill).
- `sessionId` is a **REQUIRED consumer-side addition** (a new field the consumer must publish — specified here, NOT derived by anti-hall). It is the exact uuid the consumer passed to `claude --session-id`/`--resume <uuid>` when it spawned this workspace's child. anti-hall **binds every kill to this exact uuid** — it never targets merely "some `claude` running in this cwd". Without it, or if the running process's argv uuid does not equal it, anti-hall ABSTAINS. This is the primary defense against killing a **human takeover**: a person who runs `claude --resume <uuid>` by hand to rescue a wedged worktree runs an INTERACTIVE session, which anti-hall also refuses to target (see below).

**anti-hall derives** (from `worktreePath` + the published `sessionId`):

- **Encoding rule:** `encode(worktreePath)` = replace every `/` AND every `.` with `-`. LOSSY, FORWARD-ONLY — never decode back; always derive fresh from the known `worktreePath`. Maps to `~/.claude/projects/<encoded>/`.
- **Session id + pid:** read the uuid off the target process's own argv (`--session-id` / `--resume <uuid>`), and require it to **equal `descriptor.sessionId`** (identity-binding — not just "a claude in this cwd"). Cross-check `~/.claude/projects/<encoded>/<sessionId>.jsonl` exists, and confirm each candidate's cwd == `worktreePath` (`lsof -p <pid> -a -d cwd` on macOS, `/proc/<pid>/cwd` on Linux).
- **Headless-only:** a candidate is only ever eligible if its argv is **headless** — it contains `-p` or `--print` (orchestrated children run `claude -p`). If the single surviving candidate is INTERACTIVE (no `-p`/`--print`), anti-hall ABSTAINS — a human takeover is interactive, and a kill there would evict a person mid-rescue.
- **Self-exclusion:** the supervisor never targets its own pid, nor any pid in its own process tree.
- **Confirm-gate:** exactly ONE surviving headless, identity-bound candidate or ABSTAIN.

**anti-hall writes** (per workspace):

```
~/.anti-hall/devswarm/liveness/<id>.json = {
  "status":         "alive" | "stale" | "recovering" | "ambiguous" | "escalated",
  "lastOutboundTs": <ms | null>,
  "staleSince":     <ms | null>,
  "recoveries":     <int>,
  "recoveredAt":    <ms | null>
}
```

- `recoveredAt` is the ms timestamp of the last successful resume. It arms a **post-recovery cooldown**: for `cooldownMs` after a resume the workspace is held `recovering` and CANNOT re-go-stale (the freshly-resumed headless session needs time to reattach and the consumer cursor is not advanced by the resume itself), so a wedged-then-recovered workspace cannot burn its whole N-recovery budget in minutes.
- `escalated` is a **terminal** status: once written, a sweep short-circuits to it without re-running detection or targeting (no endless ps/lsof + logging on a workspace a human must now handle).

plus an append-only `~/.anti-hall/devswarm/recovery.log` (one JSON line per attempt / abstain / escalation, each with a `reason`).

---

## File Structure

**New files (each has one responsibility):**

- `plugins/anti-hall/hooks/lib/devswarm-detect.js` — session-side feature gate (mirror of `omc-detect.js`): `isDevswarmActive(env)` / `detect(env)`. Distinct from the existing `hooks/lib/devswarm-role.js` (topology: primary vs child); this one answers only "is the liveness supervisor in play here?".
- `plugins/anti-hall/companion/lib/target-session.js` — the SPIKE-VERIFIED worktree+sessionId→pid→uuid recipe + identity-bound, headless-only, self-excluding, exactly-one-or-abstain confirm-gate, plus `verifyTarget` (fresh re-derivation for the recovery TOCTOU re-confirm). Injectable `ps`/`cwdOf`/`transcriptExists` runners (each bounded by a probe timeout).
- `plugins/anti-hall/companion/lib/liveness.js` — uuid-scoped outbound-staleness detector, unread-backlog reader, `isSafeId`, atomic verdict writer, post-recovery cooldown + terminal-`escalated` short-circuits.
- `plugins/anti-hall/companion/lib/recovery.js` — confirm-gated precise kill + TOCTOU re-confirm before each signal + process-group kill + single-writer stale-steal lock + DETACHED resume + N-cap escalation. Injectable `kill`/`killGroup`/`reconfirm`/`spawnResume`/`lock`/`isAlive`/`fs`/`platform`.
- `plugins/anti-hall/companion/devswarm-supervisor.js` — one sweep over published descriptors: detect → verdict → recover. Fail-open per workspace.
- `plugins/anti-hall/companion/install-devswarm-supervisor.js` — opt-in installer (macOS LaunchAgent / Linux systemd timer + cron fallback / Windows no-op), `--uninstall` / `--dry-run`. Modeled EXACTLY on `install-reaper.js`.
- `plugins/anti-hall/companion/lib/doctor-devswarm.js` — the doctor check as an exported pure function (mirrors the flutter-debug `preflight.js` → `doctor.js` pattern).
- `tests/hooks/devswarm-detect.test.js` — truth-table unit tests for the feature gate.
- `tests/companion/target-session.test.js` — encoding, argv parse, headless detection, cwd/transcript confirm, exactly-one/abstain (2-candidate wrapper, interactive human-takeover, wrong-sessionId, missing-sessionId, self/self-tree exclusion, no-data/timeout, zero-candidate), and `verifyTarget` re-derivation.
- `tests/companion/liveness.test.js` — both-idle-and-pending staleness, uuid-scoped decoy-sibling-does-not-mask, git-signal-unknown-is-not-stale (no dir-mtime fallback), one-signal-missing = not stale, unread-backlog parsing, `isSafeId`/path-escape, terminal-`escalated`, cooldown, verdict round-trip.
- `tests/companion/recovery.test.js` — abstain-never-kills, precise-single-pid + group kill, TOCTOU re-confirm before SIGTERM and before SIGKILL (pid-recycle → no SIGKILL), stale-steal lock (dead stolen / live respected), DETACHED resume never-killed / never-falsely-alive, "No conversation found" handling, escalate-after-N, Windows never-kills, fail-open.
- `tests/companion/devswarm-supervisor.test.js` — descriptor discovery (drops no-sessionId / unsafe-id), per-workspace fail-open, identity-bound detect→recover wiring (mocked deps), single-flight sweep lock.
- `tests/companion/install-devswarm-supervisor.test.js` — pure builder tests (plist / service / timer / cron) with a nasty path + interval clamp.
- `tests/companion/doctor-devswarm.test.js` — the check function's PASS/WARN/FAIL mapping (incl. stuck-recovering → FAIL) + dormant-when-inactive.

**Modified files (one responsibility each):**

- `plugins/anti-hall/hooks/doctor.js` — add a feature-gated DevSwarm section that `require()`s `companion/lib/doctor-devswarm.js` and renders its results (silent when inactive and no descriptors), exactly like the flutter-debug section (6b).
- `README.md` (root) — add a short "DevSwarm liveness supervisor (optional)" section, same tone as the OMC/OMX optional-integration notes.
- `plugins/anti-hall/README.md` — same optional section for the plugin readme.
- `llms.txt` — one entry, same pattern as the OMC/OMX entries.
- `docs/KB.md` — a short optional-integration note.
- `plugins/anti-hall/.claude-plugin/plugin.json` — `version` bump + describe the new opt-in companion (same sentence pattern as `install-reaper.js`).
- `plugins/anti-hall/codex/README.md` and the `.codex-plugin` manifest description (if it enumerates companions) — mirror the optional note + version.
- `CHANGELOG.md` — a new version section.

**Runtime state (created at runtime, under the already-gitignored `~/.anti-hall/`):**

- `~/.anti-hall/devswarm/workspaces/<id>.json` — descriptors (written by the CONSUMER, read by anti-hall).
- `~/.anti-hall/devswarm/liveness/<id>.json` — verdicts (written by anti-hall).
- `~/.anti-hall/devswarm/locks/<id>.lock` — single-writer recovery lock.
- `~/.anti-hall/devswarm/recovery.log` — append-only recovery ledger.
- `~/.anti-hall/devswarm-supervisor.log` — the installed job's stdout/stderr.

---

### Task 1: Feature-detect helper (`devswarm-detect.js`)

**Files:**
- Create: `plugins/anti-hall/hooks/lib/devswarm-detect.js`
- Test: `tests/hooks/devswarm-detect.test.js`

**Interfaces:**
- Consumes: only its `env` argument (defaults to `process.env`).
- Produces: `isDevswarmActive(env) -> boolean` and `detect(env) -> { active, repoId }`. Rules (auto mode): hard kill-switch `DISABLE_ANTIHALL_DEVSWARM === '1'` → false; `ANTIHALL_DEVSWARM_SUPERVISOR` = `off` → false, `on` → true, `auto`/unset → follow feature-detect (`DEVSWARM_REPO_ID` present & non-empty). Never throws (fail-open = dormant = false). `module.exports = { detect, isDevswarmActive }`.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/devswarm-detect.test.js`:

```js
'use strict';
// devswarm-detect: session-side liveness-supervisor feature gate. Pure truth
// table over env — reads only its argument, so no spawn/fs. Mirrors omc-detect's
// dormant-unless-feature-present contract. Workaround for claude-code#39755.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { detect, isDevswarmActive } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-detect.js',
));

test('dormant: DEVSWARM_REPO_ID unset (auto) -> false', () => {
  assert.strictEqual(isDevswarmActive({}), false);
  assert.strictEqual(detect({}).active, false);
});

test('auto: DEVSWARM_REPO_ID set -> true', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'repo-1' }), true);
  assert.strictEqual(detect({ DEVSWARM_REPO_ID: 'repo-1' }).repoId, 'repo-1');
});

test('auto: DEVSWARM_REPO_ID empty/whitespace -> false', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: '' }), false);
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: '   ' }), false);
});

test('hard kill-switch: DISABLE_ANTIHALL_DEVSWARM=1 overrides everything', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
});

test('mode off: forces false even with DEVSWARM_REPO_ID', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false);
});

test('mode on: forces true even without DEVSWARM_REPO_ID', () => {
  assert.strictEqual(isDevswarmActive({ ANTIHALL_DEVSWARM_SUPERVISOR: 'on' }), true);
});

test('mode is case-insensitive and trimmed', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: '  OFF ' }), false);
  assert.strictEqual(isDevswarmActive({ ANTIHALL_DEVSWARM_SUPERVISOR: 'On' }), true);
});

test('fail-open: a throwing env-like object -> false (never throws out)', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.strictEqual(isDevswarmActive(hostile), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/devswarm-detect.test.js`
Expected: FAIL — `Cannot find module '.../hooks/lib/devswarm-detect.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/hooks/lib/devswarm-detect.js`:

```js
'use strict';
// anti-hall :: devswarm-detect — DevSwarm liveness-supervisor feature gate.
//
// Workaround for claude-code#39755 (a `claude` session silently wedges — alive
// process, dead listener; no upstream headless recovery). Remove when upstream
// ships a real fix.
//
// Mirrors hooks/omc-detect.js: a pure, fail-open, dependency-free helper telling
// session-side consumers (doctor.js, any future hook) whether the DevSwarm
// liveness supervisor should be considered ACTIVE for THIS session/environment.
// Dormant unless DEVSWARM_REPO_ID is set (auto mode) — zero effect otherwise,
// byte-for-byte identical to today, exactly like omc-detect for a non-OMC session.
//
// Distinct from hooks/lib/devswarm-role.js (topology: primary vs child). This
// helper answers only "is the liveness supervisor in play here?".
//
// Gates:
//   1. Hard kill-switch: DISABLE_ANTIHALL_DEVSWARM === '1' -> false.
//   2. Mode ANTIHALL_DEVSWARM_SUPERVISOR: off -> false; on -> true; auto/unset ->
//      follow feature-detect (DEVSWARM_REPO_ID present & non-empty).
//
// Pure Node built-ins. Never throws to the caller (fail-open = false = dormant).

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// isDevswarmActive(env) -> boolean. env defaults to process.env.
function isDevswarmActive(env) {
  try {
    const e = env || process.env;
    if (e.DISABLE_ANTIHALL_DEVSWARM === '1') return false;
    const mode = String(e.ANTIHALL_DEVSWARM_SUPERVISOR || 'auto').trim().toLowerCase();
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    return nonEmpty(e.DEVSWARM_REPO_ID); // auto: follow feature-detect
  } catch (_) {
    return false; // fail-open = dormant
  }
}

function detect(env) {
  const e = env || process.env;
  let repoId = null;
  try { repoId = nonEmpty(e.DEVSWARM_REPO_ID) ? e.DEVSWARM_REPO_ID : null; } catch (_) {}
  return { active: isDevswarmActive(e), repoId };
}

module.exports = { detect, isDevswarmActive };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/devswarm-detect.test.js`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/lib/devswarm-detect.js tests/hooks/devswarm-detect.test.js
git commit -m "feat(devswarm): add liveness-supervisor feature-detect helper (claude-code#39755 workaround)"
```

---

### Task 2: Targeting lib (`target-session.js`) — the confirm-gate

**Files:**
- Create: `plugins/anti-hall/companion/lib/target-session.js`
- Test: `tests/companion/target-session.test.js`

**Interfaces:**
- Consumes: `{ worktreePath, sessionId, home, runners, selfPid }` where injectable `runners = { ps() -> string, cwdOf(pid) -> string|null, transcriptExists(dir, uuid) -> bool }` (defaults use real `ps`/`lsof`//proc/`fs`, each behind a bounded timeout). `sessionId` is REQUIRED (the identity binding). `selfPid` defaults to `process.pid`.
- Produces: `encodeWorktreePath(p)`, `projectDirFor(worktreePath, home)`, `parseSessionArg(cmd) -> uuid|null`, `isHeadless(cmd) -> bool`, `parsePs(stdout) -> [{pid,ppid,cmd}]`, `candidatesFromPs(procs) -> [{pid,ppid,cmd,uuid,headless}]`, `descendantsOf(procs, rootPid) -> Set<pid>`, `verifyTarget({worktreePath, sessionId, home, runners, selfPid, pid, uuid}) -> bool` (fresh re-derivation for a specific pid — used by the recovery TOCTOU re-confirm), and `findTarget({worktreePath, sessionId, home, runners, selfPid}) -> { pid, uuid, worktreePath }` (exactly one confirmed) **or** `{ ambiguous: true, reason, candidates }` (0 or >1, or interactive-only, or no `sessionId` — ABSTAIN). Never throws (any error → abstain).

> **The confirm-gate is the single most important safety property**, and it is now **four** independent conditions ANDed together — a candidate survives only if it (1) runs in the confirmed cwd, (2) carries `uuid === descriptor.sessionId` (identity binding), (3) is HEADLESS (`-p`/`--print`), and (4) is not the supervisor or one of its descendants — AND then exactly ONE survivor must remain, else ABSTAIN. The candidate FILTER stays deliberately inclusive (it still matches shell wrappers like `sh -c 'claude -p --resume <uuid>'` that share cwd + the uuid string) so the one-candidate gate does the discriminating. Two load-bearing counter-examples MUST abstain: the 2-candidate wrapper case, and a lone INTERACTIVE `claude --resume <uuid>` (a human takeover — no `-p`).

- [ ] **Step 1: Write the failing test**

Create `tests/companion/target-session.test.js`:

```js
'use strict';
// target-session: worktree + published sessionId -> ONE live HEADLESS claude pid,
// or ABSTAIN. All process/fs access is injected, so these are pure unit tests.
// The load-bearing cases are the confirm-gate counter-examples: (1) a stale
// bootstrap wrapper sharing cwd + the session-id STRING forces >1 candidate ->
// abstain; (2) a lone INTERACTIVE `claude --resume <uuid>` (a human takeover, no
// -p) -> abstain; (3) a candidate whose argv uuid != descriptor.sessionId ->
// abstain; (4) the supervisor's own pid / a descendant -> excluded.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'target-session.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_UUID = 'ffffffff-1111-2222-3333-444444444444';
const WT = '/Users/dev/work/wt-1';
const SELF = 999999; // a fake supervisor pid the tests can never collide with

// Build a runners object from a proc list + a cwd map + a transcript-exists set.
function mkRunners({ psLines, cwdByPid, transcripts }) {
  return {
    ps: () => psLines.join('\n') + '\n',
    cwdOf: (pid) => (pid in cwdByPid ? cwdByPid[pid] : null),
    transcriptExists: (dir, uuid) => transcripts.has(dir + '::' + uuid),
  };
}
// Every findTarget call binds an explicit sessionId + selfPid so the tests are
// hermetic (never depend on the real process.pid).
function find(runners, over) {
  return M.findTarget(Object.assign({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners }, over || {}));
}

test('encodeWorktreePath: every / and . -> - (lossy, forward-only)', () => {
  assert.strictEqual(M.encodeWorktreePath('/Users/dev/work/app.v2'), '-Users-dev-work-app-v2');
  assert.strictEqual(M.encodeWorktreePath('/a.b/c'), '-a-b-c');
});

test('projectDirFor: joins encoded path under ~/.claude/projects', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  assert.strictEqual(dir, path.join('/home/x', '.claude', 'projects', '-Users-dev-work-wt-1'));
});

test('parseSessionArg: extracts uuid from --session-id and --resume', () => {
  assert.strictEqual(M.parseSessionArg('claude -p --session-id ' + UUID), UUID);
  assert.strictEqual(M.parseSessionArg('claude --resume ' + UUID + ' --dangerously-skip-permissions'), UUID);
  assert.strictEqual(M.parseSessionArg('claude -p'), null);
  assert.strictEqual(M.parseSessionArg('vim ' + UUID + '.jsonl'), null); // uuid without a session flag
});

test('isHeadless: -p / --print => true; interactive resume => false', () => {
  assert.strictEqual(M.isHeadless('claude -p --resume ' + UUID), true);
  assert.strictEqual(M.isHeadless('claude --print --resume ' + UUID), true);
  assert.strictEqual(M.isHeadless('claude --resume ' + UUID), false);       // interactive takeover
  assert.strictEqual(M.isHeadless('claude --session-id ' + UUID), false);
});

test('parsePs: parses pid/ppid/command triples', () => {
  const rows = M.parsePs('  100 1 claude --resume ' + UUID + '\n 200 100 node mcp\n');
  assert.deepStrictEqual(rows, [
    { pid: 100, ppid: 1, cmd: 'claude --resume ' + UUID },
    { pid: 200, ppid: 100, cmd: 'node mcp' },
  ]);
});

test('candidatesFromPs: only claude+session-flag; tags headless', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: 'claude -p --resume ' + UUID },
    { pid: 2, ppid: 0, cmd: 'node /x/mcp-server.js --resume ' + UUID }, // not claude
    { pid: 3, ppid: 0, cmd: 'claude -p' },                              // no session flag
    { pid: 4, ppid: 0, cmd: 'claude --resume ' + UUID },               // interactive (no -p)
  ];
  const c = M.candidatesFromPs(procs);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c.map((x) => x.pid), [1, 4]);
  assert.strictEqual(c.find((x) => x.pid === 1).headless, true);
  assert.strictEqual(c.find((x) => x.pid === 4).headless, false);
});

test('descendantsOf: collects the whole subtree of a root pid', () => {
  const procs = [
    { pid: 10, ppid: 1, cmd: 'a' },
    { pid: 11, ppid: 10, cmd: 'b' },
    { pid: 12, ppid: 11, cmd: 'c' },
    { pid: 20, ppid: 1, cmd: 'd' },
  ];
  const set = M.descendantsOf(procs, 10);
  assert.ok(set.has(11) && set.has(12));
  assert.ok(!set.has(20));
});

test('findTarget: exactly one confirmed headless candidate -> target', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID + ' --dangerously-skip-permissions'],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, undefined);
  assert.strictEqual(r.pid, 100);
  assert.strictEqual(r.uuid, UUID);
});

test('CONFIRM-GATE: wrapper sharing cwd + uuid string -> 2 candidates -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [
      '100 1  claude -p --resume ' + UUID + ' --dangerously-skip-permissions',
      '90 1   sh -c claude -p --resume ' + UUID, // stale bootstrap wrapper, same cwd + uuid, also headless
    ],
    cwdByPid: { 100: WT, 90: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'multiple-candidates');
  assert.strictEqual(r.candidates.length, 2);
});

test('IDENTITY-BINDING: a human takeover — interactive `claude --resume <uuid>` in the cwd -> ABSTAIN, never a kill', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude --resume ' + UUID], // NO -p: a person rescuing the worktree by hand
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'interactive-candidate');
});

test('IDENTITY-BINDING: argv uuid != descriptor.sessionId -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + OTHER_UUID], // different session entirely
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + OTHER_UUID, dir + '::' + UUID]),
  });
  const r = find(runners); // sessionId defaults to UUID
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: missing sessionId -> ABSTAIN (cannot identity-bind)', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners, { sessionId: '' });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-session-id');
});

test('SELF-EXCLUSION: a candidate that IS the supervisor pid is excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [SELF + ' 1 claude -p --resume ' + UUID],
    cwdByPid: { [SELF]: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('SELF-EXCLUSION: a candidate in the supervisor process tree is excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [
      SELF + ' 1 node supervisor',
      '100 ' + SELF + ' claude -p --resume ' + UUID, // direct child of the supervisor
    ],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: zero candidates -> ABSTAIN (no-candidate)', () => {
  const runners = mkRunners({ psLines: ['1 0 launchd'], cwdByPid: {}, transcripts: new Set() });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: candidate cwd mismatch -> excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: '/some/other/dir' }, // wrong cwd
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: transcript file missing -> excluded -> ABSTAIN', () => {
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set(), // no <dir>/<sessionId>.jsonl
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
});

test('findTarget: no worktreePath -> abstain (never throws)', () => {
  const r = find(mkRunners({ psLines: [], cwdByPid: {}, transcripts: new Set() }), { worktreePath: '' });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-worktree-path');
});

test('findTarget: a throwing ps runner -> abstain (fail-open)', () => {
  const r = find({ ps: () => { throw new Error('boom'); }, cwdOf: () => null, transcriptExists: () => false });
  assert.strictEqual(r.ambiguous, true);
});

test('findTarget: empty ps output (a timed-out probe = NO DATA) -> abstain, never kill', () => {
  // P1-8: a hung/timed-out ps returns '' in the default runner. No data must map
  // to abstain (no-candidate) — never a kill on an incomplete enumeration.
  const r = find(mkRunners({ psLines: [], cwdByPid: {}, transcripts: new Set() }));
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('verifyTarget: fresh re-derivation confirms the same pid/uuid, else false (TOCTOU seam)', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const good = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  assert.strictEqual(M.verifyTarget({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners: good, pid: 100, uuid: UUID }), true);
  // pid recycled to a process in a different cwd -> no longer confirmable.
  const recycled = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: '/some/other/dir' },
    transcripts: new Set([dir + '::' + UUID]),
  });
  assert.strictEqual(M.verifyTarget({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners: recycled, pid: 100, uuid: UUID }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/target-session.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/lib/target-session.js`:

```js
'use strict';
// anti-hall :: target-session — map a DevSwarm worktree + its published sessionId
// to the ONE live HEADLESS `claude` pid, or ABSTAIN. Workaround for
// claude-code#39755.
//
// SAFETY: the confirm-gate is the single most important property here. A survivor
// must satisfy ALL of: (1) cwd == worktreePath, (2) argv uuid == descriptor
// sessionId (identity-binding), (3) argv is HEADLESS (-p/--print — orchestrated
// children are headless; a human takeover is interactive and must NOT be killed),
// (4) not the supervisor's own pid nor any descendant of it. THEN exactly one
// survivor must remain, else ABSTAIN. Live counter-examples that MUST abstain: a
// stale bootstrap wrapper `sh -c 'claude -p --resume <uuid>'` sharing cwd + uuid
// (>1 candidate), and a lone INTERACTIVE `claude --resume <uuid>` (a person
// rescuing the worktree). The candidate FILTER stays inclusive; correctness comes
// from the gate, not a clever filter.
//
// Pure Node built-ins. All process/fs access goes through INJECTABLE runners so
// unit tests never touch real processes. Never throws (any error -> abstain).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Bounded timeout for every external probe (ps/lsof): a hung probe must never
// block the whole synchronous sweep. A timed-out probe yields NO data => abstain.
const PROBE_TIMEOUT_MS = 4000;

// UUID v4-ish (Claude session ids), case-insensitive.
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_ARG_RE = new RegExp('(?:--session-id|--resume)\\s+(' + UUID + ')');
const CLAUDE_RE = /(^|[\s/])claude(\s|$)/i;
// Headless flag: `-p` or `--print` as a standalone token anywhere in the argv.
const HEADLESS_RE = /(^|\s)(-p|--print)(\s|=|$)/;

// encodeWorktreePath(p) -> Claude projects dir segment. LOSSY, FORWARD-ONLY:
// replace every '/' AND every '.' with '-'. Never decode back.
function encodeWorktreePath(worktreePath) {
  return String(worktreePath).replace(/[/.]/g, '-');
}

// projectDirFor(worktreePath, home) -> ~/.claude/projects/<encoded>.
function projectDirFor(worktreePath, home) {
  return path.join(home || os.homedir(), '.claude', 'projects', encodeWorktreePath(worktreePath));
}

// parseSessionArg(cmd) -> uuid | null (from --session-id/--resume <uuid> ONLY).
function parseSessionArg(cmd) {
  if (!cmd) return null;
  const m = String(cmd).match(SESSION_ARG_RE);
  return m ? m[1] : null;
}

// isHeadless(cmd) -> bool. True iff the argv carries -p/--print. An orchestrated
// child is headless; an interactive human takeover is NOT (and is never targeted).
function isHeadless(cmd) {
  return HEADLESS_RE.test(String(cmd || ''));
}

// parsePs(stdout) -> [{pid, ppid, cmd}] from `ps -axo pid=,ppid=,command=`.
function parsePs(stdout) {
  const out = [];
  if (!stdout) return out;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

// candidatesFromPs(procs) -> [{pid, ppid, cmd, uuid, headless}] — a `claude`
// invocation carrying a --session-id/--resume <uuid>. INTENTIONALLY inclusive
// (matches shell wrappers too): correctness comes from the confirm-gate.
function candidatesFromPs(procs) {
  const out = [];
  for (const p of procs || []) {
    if (!CLAUDE_RE.test(p.cmd)) continue;
    const uuid = parseSessionArg(p.cmd);
    if (!uuid) continue;
    out.push({ pid: p.pid, ppid: p.ppid, cmd: p.cmd, uuid, headless: isHeadless(p.cmd) });
  }
  return out;
}

// descendantsOf(procs, rootPid) -> Set<pid> of every process transitively parented
// by rootPid (used for supervisor self-tree exclusion). rootPid itself is NOT
// included (the caller excludes it separately).
function descendantsOf(procs, rootPid) {
  const childrenByPpid = new Map();
  for (const p of procs || []) {
    if (!childrenByPpid.has(p.ppid)) childrenByPpid.set(p.ppid, []);
    childrenByPpid.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const stack = (childrenByPpid.get(rootPid) || []).slice();
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const c of childrenByPpid.get(pid) || []) stack.push(c);
  }
  return out;
}

// survivorsFor(...) — the shared confirm-gate filter. Returns { survivors,
// interactiveMatched } where a survivor passed ALL four conditions and
// interactiveMatched flags an identity+cwd+transcript match that was rejected
// ONLY for being interactive (so findTarget can abstain with a precise reason).
function survivorsFor(procs, worktreePath, projectDir, sessionId, runners, selfPid) {
  const raw = candidatesFromPs(procs);
  const excluded = descendantsOf(procs, selfPid);
  excluded.add(selfPid);
  const survivors = [];
  let interactiveMatched = false;
  for (const c of raw) {
    if (excluded.has(c.pid)) continue;                                       // self / self-tree
    if (c.uuid !== sessionId) continue;                                      // identity-binding
    const cwd = runners.cwdOf(c.pid);
    if (!cwd || path.resolve(cwd) !== path.resolve(worktreePath)) continue;  // cwd confirm-gate
    if (!runners.transcriptExists(projectDir, c.uuid)) continue;             // transcript cross-check
    if (!c.headless) { interactiveMatched = true; continue; }                // human takeover -> never kill
    survivors.push(c);
  }
  return { survivors, interactiveMatched };
}

// findTarget({worktreePath, sessionId, home, runners, selfPid}) ->
//   { pid, uuid, worktreePath }             (exactly one confirmed)
//   { ambiguous: true, reason, candidates } (0 / >1 / interactive-only / no
//                                            sessionId -> ABSTAIN)
function findTarget(opts) {
  try {
    const worktreePath = opts && opts.worktreePath;
    const sessionId = opts && opts.sessionId;
    const home = (opts && opts.home) || os.homedir();
    const runners = (opts && opts.runners) || defaultRunners();
    const selfPid = (opts && Number.isFinite(opts.selfPid)) ? opts.selfPid : process.pid;
    if (!worktreePath) return { ambiguous: true, reason: 'no-worktree-path', candidates: [] };
    if (!sessionId) return { ambiguous: true, reason: 'no-session-id', candidates: [] };

    const projectDir = projectDirFor(worktreePath, home);
    const procs = parsePs(runners.ps());
    const { survivors, interactiveMatched } = survivorsFor(procs, worktreePath, projectDir, sessionId, runners, selfPid);

    if (survivors.length !== 1) {
      let reason;
      if (survivors.length > 1) reason = 'multiple-candidates';
      else if (interactiveMatched) reason = 'interactive-candidate';
      else reason = 'no-candidate';
      return { ambiguous: true, reason, candidates: survivors };
    }
    const s = survivors[0];
    return { pid: s.pid, uuid: s.uuid, worktreePath };
  } catch (_) {
    return { ambiguous: true, reason: 'error', candidates: [] };
  }
}

// verifyTarget({worktreePath, sessionId, home, runners, selfPid, pid, uuid}) ->
// bool. Re-derives on FRESH data and returns true iff findTarget still confirms
// the SAME pid + uuid. The recovery engine calls this immediately before EACH
// signal (SIGTERM, SIGKILL) so a pid recycled during the grace window is never
// killed (mirrors mcp-reaper's re-enumerate-before-SIGKILL invariant).
function verifyTarget(opts) {
  try {
    const r = findTarget(opts);
    return !r.ambiguous && r.pid === opts.pid && r.uuid === opts.uuid;
  } catch (_) {
    return false;
  }
}

// defaultRunners() — real ps / lsof //proc / fs, each behind PROBE_TIMEOUT_MS.
// macOS uses `lsof -Fn`, Linux reads /proc/<pid>/cwd. A failed OR timed-out
// enumeration returns '' / null (=> no candidates => abstain), never a partial or
// truncated list that could mislead the gate.
function defaultRunners() {
  return {
    ps() {
      const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS });
      if (r.error || r.status !== 0 || r.signal) return ''; // r.signal set when killed on timeout
      return r.stdout || '';
    },
    cwdOf(pid) {
      if (process.platform === 'linux') {
        try { return fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (_) { return null; }
      }
      const r = spawnSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      if (r.error || r.status !== 0 || r.signal) return null; // r.signal set when killed on timeout
      const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    },
    transcriptExists(dir, uuid) {
      try { return fs.existsSync(path.join(dir, uuid + '.jsonl')); } catch (_) { return false; }
    },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  encodeWorktreePath, projectDirFor, parseSessionArg, isHeadless, parsePs,
  candidatesFromPs, descendantsOf, findTarget, verifyTarget, defaultRunners,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion/target-session.test.js`
Expected: PASS (all subtests, including the 2-candidate abstain).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/companion/lib/target-session.js tests/companion/target-session.test.js
git commit -m "feat(devswarm): worktree->pid->session targeting with exactly-one-or-abstain confirm-gate"
```

---

### Task 3: Liveness detector + verdict writer (`liveness.js`)

**Files:**
- Create: `plugins/anti-hall/companion/lib/liveness.js`
- Test: `tests/companion/liveness.test.js`

**Interfaces:**
- Consumes: a descriptor `{id, worktreePath, inboxPath, cursorPath, sessionId}`, `now`, `idleThresholdMs`, `cooldownMs`, `home`, injectable `runners = { fs, gitCommitTs(worktreePath) }`.
- Produces: `computeLiveness(opts) -> { status, lastOutboundTs, staleSince, recoveries, recoveredAt, pending }`, plus helpers `transcriptMtime(projectDir, sessionId, fsi)` (uuid-SCOPED — see below), `worktreeActivityMtime`, `unreadBacklog(inboxPath, cursorPath, fsi) -> { lines, known }`, `isSafeId(id)`, `writeVerdict(id, verdict, home, fsi)` (atomic tmp+rename), and path helpers `devswarmRoot`, `livenessPathFor`.
- **uuid-SCOPED liveness (P1-6):** `transcriptMtime` stats ONLY the target session's own `<sessionId>.jsonl`, never the newest of all `*.jsonl` in the shared encoded dir — a busy colliding sibling session in the same encoded project dir must not mask a wedged workspace's staleness.
- STALE only when **BOTH** the session-transcript-mtime signal AND the git-activity signal are present and each idle past the threshold, **AND** the workspace has pending unread backlog past its cursor. A missing signal → NOT stale (fail-safe). **The git-activity signal is git-commit-time ONLY, with NO worktree-directory-mtime fallback (P1-15)** — a dir mtime does not bump on edits to nested files, so it is a near-permanently-idle reading that would collapse the two-signal safeguard to transcript-only; when there are no commits yet (fresh task) or git is unavailable, that signal is UNKNOWN (`null`) → the workspace is NOT declared stale. (`owedReport` was a dead half-signal — never wired from the sweep — and is REMOVED: pending is decided solely by data anti-hall can itself verify, the unread NDJSON backlog, not an unverifiable consumer claim.)
- **Terminal short-circuit (P2-13):** if the persisted verdict is `escalated`, `computeLiveness` returns it unchanged without recomputing (no re-stat, and the sweep therefore never re-targets an escalated workspace).
- **Post-recovery cooldown (P2-10):** if the persisted verdict carries `recoveredAt` and `now - recoveredAt < cooldownMs`, the workspace is held `recovering` and is NOT eligible to re-go-stale (the fresh headless resume needs time; the consumer cursor is not advanced by the resume itself).
- **id sanitization (P1-7):** `isSafeId` rejects empty, `.`/`..`, path separators, control chars, and any `..` substring, so a hostile descriptor id can never `path.join`-escape into locks/liveness/recovery paths. `livenessPathFor` throws on an unsafe id (callers already fail-open in try/catch); the sweep and doctor readers drop unsafe descriptors up front.

- [ ] **Step 1: Write the failing test**

Create `tests/companion/liveness.test.js`:

```js
'use strict';
// liveness: outbound-staleness detector + verdict writer. Uses a real temp HOME
// with fake timestamps; git activity is injected so the test doesn't need a repo.
// STALE requires BOTH signals idle AND a pending unread backlog. Liveness is
// uuid-SCOPED (only the target's own <sessionId>.jsonl). Workaround for #39755.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

const IDLE = 15 * 60 * 1000;
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-liveness-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// Seed a workspace: a session transcript (<sessionId>.jsonl) with a chosen mtime,
// an inbox, a cursor. Returns a full descriptor (incl. sessionId) + projectDir.
function seed(home, { id, transcriptAgeMs, inboxLines, cursor, sessionId = UUID }) {
  const worktreePath = path.join(home, 'wt', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const projectDir = M.projectDirFor(worktreePath, home);
  fs.mkdirSync(projectDir, { recursive: true });
  const tp = path.join(projectDir, sessionId + '.jsonl');
  fs.writeFileSync(tp, '{}\n');
  if (typeof transcriptAgeMs === 'number') {
    const t = (Date.now() - transcriptAgeMs) / 1000;
    fs.utimesSync(tp, t, t);
  }
  const inboxPath = path.join(worktreePath, 'inbox.ndjson');
  const cursorPath = path.join(worktreePath, 'cursor');
  if (inboxLines) fs.writeFileSync(inboxPath, inboxLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (typeof cursor === 'number') fs.writeFileSync(cursorPath, String(cursor));
  return { id, worktreePath, inboxPath, cursorPath, sessionId, projectDir };
}

test('isSafeId: rejects traversal / separators / control chars / empty', () => {
  assert.strictEqual(M.isSafeId('w1'), true);
  assert.strictEqual(M.isSafeId('work-space_2.a'), true);
  assert.strictEqual(M.isSafeId(''), false);
  assert.strictEqual(M.isSafeId('..'), false);
  assert.strictEqual(M.isSafeId('../../x'), false);
  assert.strictEqual(M.isSafeId('a/b'), false);
  assert.strictEqual(M.isSafeId('a\\b'), false);
  assert.strictEqual(M.isSafeId('a b'), false);
});

test('livenessPathFor throws on an unsafe id (no path escape)', () => {
  assert.throws(() => M.livenessPathFor('../../etc/x', '/home/x'));
});

test('unreadBacklog: integer cursor -> lines after it', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); const cur = path.join(home, 'c');
    fs.writeFileSync(inbox, 'a\nb\nc\n'); fs.writeFileSync(cur, '1');
    const r = M.unreadBacklog(inbox, cur);
    assert.deepStrictEqual(r, { lines: ['b', 'c'], known: true });
  } finally { cleanup(); }
});

test('unreadBacklog: {"line":N} cursor form', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); const cur = path.join(home, 'c');
    fs.writeFileSync(inbox, 'a\nb\nc\n'); fs.writeFileSync(cur, JSON.stringify({ line: 2 }));
    assert.deepStrictEqual(M.unreadBacklog(inbox, cur).lines, ['c']);
  } finally { cleanup(); }
});

test('unreadBacklog: missing/unparseable cursor -> known:false (fail-safe)', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i');
    fs.writeFileSync(inbox, 'a\nb\n');
    assert.deepStrictEqual(M.unreadBacklog(inbox, path.join(home, 'nope')), { lines: [], known: false });
  } finally { cleanup(); }
});

test('STALE: both signals idle AND pending backlog', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w1', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const v = M.computeLiveness({
      descriptor: d, home, idleThresholdMs: IDLE,
      runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 }, // worktree also idle 40m
    });
    assert.strictEqual(v.status, 'stale');
    assert.strictEqual(v.pending, true);
    assert.ok(v.staleSince > 0);
  } finally { cleanup(); }
});

test('uuid-SCOPED: a FRESH sibling jsonl in the same encoded dir does NOT hide staleness', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w1s', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    // A busy colliding sibling session writes a fresh transcript in the SAME dir.
    const sibling = path.join(d.projectDir, 'ffffffff-1111-2222-3333-444444444444.jsonl');
    fs.writeFileSync(sibling, '{}\n'); // mtime = now
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'stale'); // scoped to <sessionId>.jsonl, so still idle
  } finally { cleanup(); }
});

test('P1-15: no git commits yet + a fresh NESTED file edit -> NOT stale (no dir-mtime false-idle)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w10', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    // Edit a file NESTED under the worktree. This does NOT bump the worktree DIR
    // mtime, so the old dir-mtime fallback would read 'idle' and (with the idle
    // transcript) FALSELY mark stale.
    const nested = path.join(d.worktreePath, 'src', 'a.txt');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'edited just now');
    // No commits yet -> gitCommitTs returns null (UNKNOWN activity signal).
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
    assert.strictEqual(v.status, 'alive'); // git signal UNKNOWN -> not conclusively stale (fail-safe)

    // Contrast (proves the not-stale above is due to the UNKNOWN git signal, not
    // some unrelated reason): WITH a real, idle git reading the SAME fixture IS stale.
    const v2 = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v2.status, 'stale');
  } finally { cleanup(); }
});

test('NOT stale: idle but no pending work (nothing to do)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w2', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 1 }); // fully read
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('NOT stale: pending work but recently active (transcript fresh)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w3', transcriptAgeMs: 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 }); // 1m old
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('NOT stale: worktree signal fresh even though transcript is idle', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w4', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 60 * 1000 } }); // worktree active 1m ago
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('TERMINAL short-circuit: a persisted `escalated` verdict is returned unchanged, un-recomputed', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w7', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    M.writeVerdict('w7', { status: 'escalated', lastOutboundTs: 5, staleSince: 5, recoveries: 3 }, home);
    let statted = false;
    const v = M.computeLiveness({
      descriptor: d, home, idleThresholdMs: IDLE,
      runners: { gitCommitTs: () => { statted = true; return Date.now() - 40 * 60 * 1000; } },
    });
    assert.strictEqual(v.status, 'escalated');   // sticky, not re-flapped to stale
    assert.strictEqual(statted, false);          // did NOT recompute liveness signals
  } finally { cleanup(); }
});

test('COOLDOWN: within cooldownMs of a recovery a workspace is held `recovering`, not re-stale', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w8', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const now = Date.now();
    M.writeVerdict('w8', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 60 * 1000 }, home);
    const v = M.computeLiveness({ descriptor: d, home, now, idleThresholdMs: IDLE, cooldownMs: 10 * 60 * 1000, runners: { gitCommitTs: () => now - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'recovering'); // cooldown holds it; would otherwise be stale
    assert.strictEqual(v.recoveries, 1);
  } finally { cleanup(); }
});

test('COOLDOWN expired: past the window the workspace can go stale again', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w9', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const now = Date.now();
    M.writeVerdict('w9', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 30 * 60 * 1000 }, home);
    const v = M.computeLiveness({ descriptor: d, home, now, idleThresholdMs: IDLE, cooldownMs: 10 * 60 * 1000, runners: { gitCommitTs: () => now - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'stale');
  } finally { cleanup(); }
});

test('writeVerdict round-trips atomically and recoveries persists into computeLiveness', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w6', transcriptAgeMs: 60 * 1000, inboxLines: [], cursor: 0 });
    M.writeVerdict('w6', { status: 'alive', lastOutboundTs: 1, staleSince: null, recoveries: 2 }, home);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.recoveries, 2); // carried forward from the persisted verdict
    const onDisk = JSON.parse(fs.readFileSync(M.livenessPathFor('w6', home), 'utf8'));
    assert.strictEqual(onDisk.recoveries, 2);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/liveness.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/lib/liveness.js`:

```js
'use strict';
// anti-hall :: liveness — outbound-staleness detector + atomic verdict writer.
// Workaround for claude-code#39755.
//
// STALE only when BOTH outbound signals (the target session's OWN transcript
// mtime AND git/worktree activity) are PRESENT and each idle past the threshold,
// AND the workspace has a pending unread backlog past its cursor. A workspace idle
// because it has nothing to do is NOT stale. Fail direction = NOT stale (never
// nominate a healthy workspace for a kill). The inbound heartbeat is deliberately
// NOT used — it is blind to this failure mode (the wedged child stopped consuming
// inbound too). Liveness is uuid-SCOPED: only <sessionId>.jsonl is stat'd, so a
// busy colliding sibling session in the shared encoded dir cannot mask staleness.
// `escalated` is terminal (short-circuited); a fresh recovery arms a cooldown so a
// just-resumed workspace cannot immediately re-go-stale and burn its budget.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectDirFor } = require('./target-session.js');

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 4000;

// isSafeId(id) -> bool. A descriptor id must be a single safe path segment before
// it is ever path.join'd into locks/liveness/recovery paths (P1-7): no separators,
// no traversal, no control chars/whitespace, not empty, not '.'/'..'.
function isSafeId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function devswarmRoot(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm');
}
function livenessPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'liveness', String(id) + '.json');
}

// transcriptMtime(projectDir, sessionId, fsi) -> ms | null. uuid-SCOPED: stats
// ONLY the target session's own <sessionId>.jsonl (P1-6). A colliding sibling's
// fresh transcript in the same dir must NOT mask this session's staleness.
function transcriptMtime(projectDir, sessionId, fsi) {
  const F = fsi || fs;
  if (!sessionId) return null;
  try {
    return F.statSync(path.join(projectDir, sessionId + '.jsonl')).mtimeMs;
  } catch (_) {
    return null;
  }
}

// worktreeActivityMtime(worktreePath, runners) -> ms | null. The git-commit time
// (git log -1 --format=%ct, seconds->ms), or null (UNKNOWN) when there is no
// reliable git signal — no commits yet (plausible right when a task starts) or git
// unavailable / detached .git. It NEVER falls back to a worktree DIRECTORY mtime
// (P1-15): editing a file NESTED under the worktree does NOT bump the dir mtime, so
// a dir-mtime reading is near-permanently 'idle' and would collapse the two-signal
// anti-false-positive safeguard to transcript-only. A null activity signal makes
// computeLiveness treat the workspace as NOT conclusively stale (fail-safe toward
// alive), which is the correct direction — better to miss a wedge than to
// manufacture a false idle reading and wrong-kill.
function worktreeActivityMtime(worktreePath, runners) {
  const R = runners || {};
  try {
    const ct = R.gitCommitTs ? R.gitCommitTs(worktreePath) : defaultGitCommitTs(worktreePath);
    if (Number.isFinite(ct) && ct > 0) return ct;
  } catch (_) {}
  return null; // no reliable git activity signal -> UNKNOWN (never a dir-mtime fallback)
}

function defaultGitCommitTs(worktreePath) {
  const r = spawnSync('git', ['-C', worktreePath, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0 || r.signal) return null; // r.signal set when killed on timeout
  const secs = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// unreadBacklog(inboxPath, cursorPath, fsi) -> { lines: string[], known: boolean }.
// inboxPath = NDJSON append-only (one message/line). cursorPath = a bare integer
// OR JSON {line:<int>} = count of consumed lines. Unparseable/absent cursor =>
// known:false (treated as NOT pending — fail-safe: never nominate an unreadable
// workspace for a kill).
function unreadBacklog(inboxPath, cursorPath, fsi) {
  const F = fsi || fs;
  let all;
  try {
    all = String(F.readFileSync(inboxPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (_) {
    return { lines: [], known: false };
  }
  let cursor;
  try {
    const raw = String(F.readFileSync(cursorPath, 'utf8')).trim();
    if (/^\d+$/.test(raw)) cursor = parseInt(raw, 10);
    else cursor = Number(JSON.parse(raw).line);
  } catch (_) {
    return { lines: [], known: false };
  }
  if (!Number.isFinite(cursor) || cursor < 0) return { lines: [], known: false };
  return { lines: all.slice(cursor), known: true };
}

// computeLiveness(opts) ->
//   { status, lastOutboundTs, staleSince, recoveries, recoveredAt, pending }.
function computeLiveness(opts) {
  const descriptor = opts.descriptor;
  const now = opts.now || Date.now();
  const idle = Number.isFinite(opts.idleThresholdMs) ? opts.idleThresholdMs : DEFAULT_IDLE_MS;
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
  const home = opts.home || os.homedir();
  const runners = opts.runners || {};
  const fsi = runners.fs || fs;

  // Prior verdict (persisted across sweeps) — read FIRST so the terminal + cooldown
  // short-circuits can skip all recomputation.
  let prev = null;
  try { prev = JSON.parse(fsi.readFileSync(livenessPathFor(descriptor.id, home), 'utf8')); } catch (_) {}
  const recoveries = (prev && Number.isFinite(prev.recoveries)) ? prev.recoveries : 0;
  const priorStaleSince = (prev && Number.isFinite(prev.staleSince)) ? prev.staleSince : null;
  const recoveredAt = (prev && Number.isFinite(prev.recoveredAt)) ? prev.recoveredAt : null;
  const priorOutbound = (prev && Number.isFinite(prev.lastOutboundTs)) ? prev.lastOutboundTs : null;

  // P2-13 TERMINAL short-circuit: `escalated` is sticky — return it unchanged,
  // never re-stat, so the sweep stops re-targeting a workspace a human must handle.
  if (prev && prev.status === 'escalated') {
    return { status: 'escalated', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, recoveries, recoveredAt, pending: false };
  }

  // P2-10 post-recovery COOLDOWN: within cooldownMs of a resume, hold `recovering`
  // — the fresh headless session needs time and the cursor is not advanced by the
  // resume, so it must not be eligible to re-go-stale (and burn the N budget).
  if (recoveredAt !== null && (now - recoveredAt) < cooldownMs) {
    return { status: 'recovering', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, recoveries, recoveredAt, pending: false };
  }

  const projectDir = projectDirFor(descriptor.worktreePath, home);
  const tMtime = transcriptMtime(projectDir, descriptor.sessionId, fsi);
  const wMtime = worktreeActivityMtime(descriptor.worktreePath, runners);
  const lastOutboundTs = Math.max(tMtime || 0, wMtime || 0) || null;

  const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
  const pending = backlog.known && backlog.lines.length > 0;

  // BOTH signals must be present AND idle. A missing signal -> not conclusively
  // stale (fail-safe). max() being idle is equivalent to "both idle".
  const haveBoth = tMtime !== null && wMtime !== null;
  const bothIdle = haveBoth && (now - tMtime) > idle && (now - wMtime) > idle;
  const stale = bothIdle && pending;

  return {
    status: stale ? 'stale' : 'alive',
    lastOutboundTs,
    staleSince: stale ? (priorStaleSince || now) : null,
    recoveries,
    recoveredAt,
    pending,
  };
}

// writeVerdict(id, verdict, home, fsi) — atomic tmp+rename write.
function writeVerdict(id, verdict, home, fsi) {
  const F = fsi || fs;
  const p = livenessPathFor(id, home); // throws on an unsafe id (caller fails open)
  F.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  F.writeFileSync(tmp, JSON.stringify(verdict));
  F.renameSync(tmp, p);
  return p;
}

module.exports = {
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, isSafeId, devswarmRoot, livenessPathFor, projectDirFor,
  transcriptMtime, worktreeActivityMtime, unreadBacklog, computeLiveness, writeVerdict,
};
```

> Note: `projectDirFor` is re-exported here so tests and the doctor check can derive the transcript dir without also importing `target-session.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion/liveness.test.js`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/companion/lib/liveness.js tests/companion/liveness.test.js
git commit -m "feat(devswarm): outbound-staleness liveness detector + atomic verdict writer"
```

---

### Task 4: Recovery engine (`recovery.js`)

**Files:**
- Create: `plugins/anti-hall/companion/lib/recovery.js`
- Test: `tests/companion/recovery.test.js`

**Interfaces:**
- Consumes: `{ descriptor, target, home, now, maxRecoveries, graceMs, io }` where `descriptor` carries `sessionId` + `worktreePath` (needed for the fresh re-confirm), `target` is a `findTarget` result, and `io` (all injectable) = `{ kill(pid,signal)->bool, killGroup(pid,signal)->bool, reconfirm(target)->bool, spawnResume({uuid,cwd,prompt})->{output?,stdout?,stderr?,status?,timedOut?}, lock(id,home)->release|null, isAlive(pid)->bool, sleep(ms), selfPid, fs, platform }`.
- Produces: `recover(opts) -> { action, reason?, recoveries?, pid?, uuid? }` where `action ∈ 'abstain'|'escalate'|'skip'|'resumed'|'error'`. Plus `acquireLock(id, home, io)`, `lockPathFor`, `recoveryLogPath`.
- Invariants (each asserted by a test):
  - NEVER kill on an ambiguous target; Windows → escalate-only; cap at N → escalate; any internal error → `error` (fail-open, never throws, never kills); `"No conversation found"` → expected `escalate`.
  - **TOCTOU re-confirm (P0-2):** immediately before SIGTERM **and** again before SIGKILL, RE-DERIVE identity on fresh data (`reconfirm(target)` = `verifyTarget` on a fresh `ps`/cwd/argv/headless read). If it no longer maps to the same pid+uuid+worktree+sessionId, ABSTAIN — never SIGKILL a pid that was recycled during the grace window (mirrors `mcp-reaper.js:282-294`).
  - **GROUP kill (P0-5):** signal the process GROUP (`killGroup` = POSIX negative-pid) alongside the single confirmed pid, so the wedged child's MCP grandchildren are cleaned up instead of reparenting to PID 1 (the repo's documented orphan class). The confirm-gate still selects WHICH single group.
  - **Stale-lock steal (P0-3):** `acquireLock` records holder `{pid, ts}`; on `EEXIST` it STEALS iff the holder pid is dead (`isAlive` probe) OR the lock is older than `LOCK_STALE_MS` — so a supervisor crash mid-recovery cannot permanently disable recovery (mirrors `swarm-guard.js:150-215`). A live, fresh holder is respected → concurrent attempt returns `skip`. Release unlinks ONLY its own token.
  - **DETACHED resume (P0-4):** the resume is a DETACHED, `unref`'d spawn with NO 120 s SIGTERM timeout (never SIGTERM real agentic work). An optional bounded readiness check may observe an immediate `"No conversation found"` but MUST NOT kill the child on timeout, and a timed-out/unconfirmed resume is recorded as `recovering` (with `recoveredAt`), **never** `alive` — the next post-cooldown sweep re-derives real liveness.

- [ ] **Step 1: Write the failing test**

Create `tests/companion/recovery.test.js`:

```js
'use strict';
// recovery: confirm-gated precise kill + TOCTOU re-confirm + group-kill +
// single-writer stale-steal lock + DETACHED resume + N-cap escalate. ALL
// kill/spawn/lock/fs/reconfirm is injected — NO real process is ever touched. The
// load-bearing assertions: never broad-kill, abstain on ambiguity, re-confirm
// before EACH signal (pid-recycle defense), group-signal children, escalate after
// N, single-writer with dead-holder steal, Windows never kills, a timed-out resume
// is never falsely marked alive. Workaround for #39755.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
));
const { livenessPathFor } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptor(home) {
  const worktreePath = path.join(home, 'wt');
  fs.mkdirSync(worktreePath, { recursive: true });
  const inboxPath = path.join(worktreePath, 'inbox.ndjson');
  const cursorPath = path.join(worktreePath, 'cursor');
  fs.writeFileSync(inboxPath, JSON.stringify({ m: 'do the thing' }) + '\n');
  fs.writeFileSync(cursorPath, '0');
  return { id: 'w1', worktreePath, inboxPath, cursorPath, sessionId: UUID };
}
// A spy io: records single-pid kills, GROUP kills, and spawn calls. kill(pid,0)
// reports alive until told otherwise. reconfirm defaults TRUE (identity holds).
function spyIo(overrides) {
  const killed = [];   // single-pid signals: [pid, signal]
  const groups = [];   // process-group signals: [pid, signal]
  const spawns = [];
  const io = Object.assign({
    platform: 'darwin',
    selfPid: 999999,
    sleep: () => {},
    reconfirm: () => true,
    kill: (pid, signal) => { killed.push([pid, signal]); return signal === 0 ? false : true; }, // dead after SIGTERM
    killGroup: (pid, signal) => { groups.push([pid, signal]); return true; },
    spawnResume: (a) => { spawns.push(a); return { output: 'ok', status: 0 }; },
  }, overrides || {});
  return { io, killed, groups, spawns };
}

test('ABSTAIN target -> never kills; writes ambiguous verdict + logs', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo();
    const r = M.recover({ descriptor: d, target: { ambiguous: true, reason: 'multiple-candidates' }, home, io });
    assert.strictEqual(r.action, 'abstain');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
    assert.ok(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'recovery.log'), 'utf8').includes('abstain'));
  } finally { cleanup(); }
});

test('Windows: escalate-only, never kills regardless of target', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo({ platform: 'win32' });
    const r = M.recover({ descriptor: d, target: { pid: 123, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'win32-no-kill');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('happy path: SIGTERM the ONE pid + its GROUP, resume, increment recoveries', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups, spawns } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 555, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');
    assert.strictEqual(r.recoveries, 1);
    // exactly one pid targeted; SIGTERM then alive-check (signal 0). No SIGKILL (died on TERM).
    assert.deepStrictEqual(killed.map((k) => k[0]), [555, 555]);
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0]);
    // P0-5: the process GROUP is signaled alongside the parent (children not orphaned).
    assert.deepStrictEqual(groups, [[555, 'SIGTERM']]);
    // A timed-out/unconfirmed resume is never marked 'alive' — status stays 'recovering'.
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'recovering');
    assert.ok(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).recoveredAt > 0);
    // resume from the worktree cwd, backlog fed as prompt.
    assert.strictEqual(spawns.length, 1);
    assert.strictEqual(spawns[0].cwd, d.worktreePath);
    assert.strictEqual(spawns[0].uuid, UUID);
    assert.ok(spawns[0].prompt.includes('do the thing'));
  } finally { cleanup(); }
});

test('SIGKILL + group-SIGKILL only when the pid survives the grace window', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // kill(pid,0) reports alive -> forces the SIGKILL branch.
    const { io, killed, groups } = spyIo({ kill: (pid, signal) => { killed.push([pid, signal]); return true; } });
    M.recover({ descriptor: d, target: { pid: 42, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0, 'SIGKILL']);
    assert.ok(killed.every((k) => k[0] === 42)); // NEVER any pid but the target
    assert.deepStrictEqual(groups, [[42, 'SIGTERM'], [42, 'SIGKILL']]);
  } finally { cleanup(); }
});

test('TOCTOU pre-SIGTERM: identity gone on fresh data -> ABSTAIN, no signal at all', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo({ reconfirm: () => false }); // re-derive fails immediately
    const r = M.recover({ descriptor: d, target: { pid: 77, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'abstain');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
  } finally { cleanup(); }
});

test('TOCTOU pre-SIGKILL: pid recycled during the grace window -> NO SIGKILL (abstain)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    let calls = 0;
    const { io, killed, groups } = spyIo({
      kill: (pid, signal) => { killed.push([pid, signal]); return true; }, // always "alive" -> reaches pre-kill re-confirm
      reconfirm: () => { calls += 1; return calls === 1; },               // ok before SIGTERM, GONE before SIGKILL
    });
    const r = M.recover({ descriptor: d, target: { pid: 88, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'abstain');
    // SIGTERM (and its group) happened; the alive-check happened; but NO SIGKILL.
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0]);
    assert.ok(!killed.some((k) => k[1] === 'SIGKILL'), 'must not SIGKILL a recycled pid');
    assert.deepStrictEqual(groups, [[88, 'SIGTERM']]);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
  } finally { cleanup(); }
});

test('DETACHED resume that outlives the readiness window is NOT killed and NOT marked alive', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // spawnResume reports the child is still running (timedOut) with no early output.
    const { io, killed } = spyIo({ spawnResume: (a) => ({ pid: 4242, timedOut: true, output: '' }) });
    const r = M.recover({ descriptor: d, target: { pid: 5, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');
    assert.strictEqual(r.recoveries, 1);
    // the long-running resumed child (pid 4242) is NEVER signaled by recovery.
    assert.ok(!killed.some((k) => k[0] === 4242), 'resumed child must not be killed');
    // unconfirmed resume -> status 'recovering' (+recoveredAt), never a false 'alive'.
    const v = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(v.status, 'recovering');
    assert.ok(v.recoveredAt > 0);
  } finally { cleanup(); }
});

test('"No conversation found" -> expected escalate, not thrown', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io } = spyIo({ spawnResume: () => ({ output: 'No conversation found', status: 1 }) });
    const r = M.recover({ descriptor: d, target: { pid: 7, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'no-conversation-found');
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('escalate after N recoveries (cap)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'liveness'), { recursive: true });
    fs.writeFileSync(livenessPathFor('w1', home), JSON.stringify({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 3 }));
    const { io, killed } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 9, uuid: UUID, worktreePath: d.worktreePath }, home, io, maxRecoveries: 3 });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'max-recoveries');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('single-writer: a live-holder lock -> second attempt skips (no kill)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // Hold the lock by calling acquireLock directly; do not release. The holder pid
    // is THIS live process, so recovery must respect it (no dead-holder steal).
    const held = M.acquireLock('w1', home, { fs });
    assert.ok(held, 'first lock must succeed');
    const { io, killed } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 3, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'locked');
    assert.strictEqual(killed.length, 0);
    held(); // release
  } finally { cleanup(); }
});

test('acquireLock: a DEAD-holder lock is stolen; a LIVE-holder lock is respected', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.lockPathFor('w1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Pre-write a lock owned by a (pretend) DEAD holder, fresh timestamp.
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts: Date.now() }));
    const stolen = M.acquireLock('w1', home, { fs, isAlive: () => false });
    assert.ok(stolen, 'dead-holder lock must be stealable (crash must not disable recovery)');
    stolen();
    // Pre-write a lock owned by a LIVE holder, fresh timestamp -> must NOT steal.
    fs.writeFileSync(p, JSON.stringify({ pid: 4243, ts: Date.now() }));
    const blocked = M.acquireLock('w1', home, { fs, isAlive: () => true });
    assert.strictEqual(blocked, null, 'a live, fresh holder must be respected');
  } finally { cleanup(); }
});

test('fail-open: a throwing spawnResume -> error result, never throws out', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io } = spyIo({ spawnResume: () => { throw new Error('boom'); } });
    const r = M.recover({ descriptor: d, target: { pid: 1, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'error');
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/recovery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/lib/recovery.js`:

```js
'use strict';
// anti-hall :: recovery — kill the ONE confirmed wedged `claude` pid (and its
// process group) and resume it headless from the same worktree cwd, feeding the
// unread backlog as the fresh prompt. Workaround for claude-code#39755.
//
// SAFETY INVARIANTS (each proven by a test):
//   - NEVER kill on an ambiguous target (0 or >1 candidates) — escalate instead.
//   - TOCTOU re-confirm: re-derive identity on FRESH data immediately before
//     SIGTERM AND again before SIGKILL; if the pid no longer maps to the same
//     uuid+worktree+sessionId, ABSTAIN (a pid recycled in the grace window is
//     never SIGKILLed — mirrors mcp-reaper.js:282-294).
//   - Precise kill of the single confirmed pid, PLUS its process GROUP (POSIX
//     negative-pid) so the wedged child's MCP grandchildren are cleaned up rather
//     than reparented to PID 1. No broad pkill, no pattern.
//   - Single-writer per workspace (atomic O_EXCL lockfile) — never resume one
//     session id from two processes concurrently. A DEAD holder (or a lock past
//     LOCK_STALE_MS) is stolen so a supervisor crash cannot permanently disable
//     recovery (mirrors swarm-guard.js:150-215); a live, fresh holder is respected.
//   - Windows: escalate-only, never kill (cwd confirm-gate is unavailable there).
//   - Cap at N recoveries -> escalate, no restart loops.
//   - DETACHED resume: unref'd, no 120s SIGTERM timeout (never kills real agentic
//     work). A timed-out/unconfirmed resume is recorded 'recovering' (+recoveredAt),
//     NEVER falsely 'alive'.
//   - "No conversation found" is an EXPECTED, handled failure (log + escalate).
//   - Any internal error -> logged + { action:'error' }, never throws, never kills.
//
// All kill/spawn/lock/fs/reconfirm access is injectable so tests touch NO real
// process.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { devswarmRoot, livenessPathFor, writeVerdict, unreadBacklog, isSafeId } = require('./liveness.js');
const { verifyTarget } = require('./target-session.js');

const DEFAULT_MAX_RECOVERIES = 3;
const DEFAULT_GRACE_MS = 5000;
const LOCK_STALE_MS = 15 * 60 * 1000; // TTL backstop; the dead-holder probe is the primary steal signal
const RESUME_READINESS_MS = 4000;     // how long to watch a fresh resume for an immediate error — NEVER a kill deadline

function lockPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'locks', String(id) + '.lock');
}
function recoveryLogPath(home) {
  return path.join(devswarmRoot(home), 'recovery.log');
}

function appendLog(home, obj, fsi) {
  const F = fsi || fs;
  try {
    const p = recoveryLogPath(home);
    F.mkdirSync(path.dirname(p), { recursive: true });
    F.appendFileSync(p, JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + '\n');
  } catch (_) {}
}

// defaultIsAlive(pid) -> bool. process.kill(pid,0) throws ESRCH when the pid is
// gone; EPERM means it exists but we may not signal it (still "alive").
function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireLock(id, home, io) -> release() | null. Atomic O_EXCL create carrying the
// holder {pid, ts, token}. On EEXIST it STEALS iff the holder pid is dead OR the
// lock is older than LOCK_STALE_MS (mirrors swarm-guard's stale-steal); otherwise
// a live, fresh holder is respected -> null (caller aborts rather than double-
// resume). Release unlinks ONLY when the on-disk token is still ours.
function acquireLock(id, home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || defaultIsAlive;
  const now = (io && io.now) || Date.now;
  const p = lockPathFor(id, home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try {
          const cur = JSON.parse(F.readFileSync(p, 'utf8'));
          if (cur && cur.token === token) F.unlinkSync(p);
        } catch (_) { /* not ours / unreadable -> leave it; a later stale-steal reclaims it */ }
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null; // any other error -> fail-open (no lock)
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      const holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      const dead = holderPid !== null && !isAlive(holderPid);
      const stale = holderTs === null || (now() - holderTs) > LOCK_STALE_MS;
      if (dead || stale) {
        try { F.unlinkSync(p); } catch (_) {}
        continue; // retry the O_EXCL create
      }
      return null; // live, fresh holder -> respected
    }
  }
  return null;
}

function readRecoveries(id, home, F) {
  try { return JSON.parse(F.readFileSync(livenessPathFor(id, home), 'utf8')).recoveries || 0; } catch (_) { return 0; }
}

// persist a verdict, carrying forward lastOutboundTs/staleSince/recoveredAt from
// any prior one (unless overridden via extra).
function persistVerdict(descriptor, home, F, status, extra) {
  let recoveries = 0, staleSince = null, lastOutboundTs = null, recoveredAt = null;
  try {
    const prev = JSON.parse(F.readFileSync(livenessPathFor(descriptor.id, home), 'utf8'));
    if (prev) {
      recoveries = prev.recoveries || 0;
      staleSince = prev.staleSince != null ? prev.staleSince : null;
      lastOutboundTs = prev.lastOutboundTs != null ? prev.lastOutboundTs : null;
      recoveredAt = Number.isFinite(prev.recoveredAt) ? prev.recoveredAt : null;
    }
  } catch (_) {}
  const v = Object.assign({ status, lastOutboundTs, staleSince, recoveries, recoveredAt }, extra || {});
  try { writeVerdict(descriptor.id, v, home, F); } catch (_) {}
  return v;
}

function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}
function defaultKill(pid, signal) {
  try { process.kill(pid, signal); return true; } catch (_) { return false; }
}
// defaultKillGroup — signal the whole POSIX process group (negative pid) so the
// target's children (MCP servers) are cleaned up with it. Best-effort; a missing
// group just means no extra recipients. Never reached on win32 (escalate-only).
function defaultKillGroup(pid, signal) {
  try { process.kill(-Math.abs(pid), signal); return true; } catch (_) { return false; }
}

// defaultReconfirm(target, descriptor, selfPid) -> bool. Fresh re-derivation via
// verifyTarget using the real ps/lsof runners (a hung probe is bounded inside the
// runner). Returns true iff the SAME pid+uuid is still the sole confirmed target.
function defaultReconfirm(target, descriptor, selfPid) {
  return verifyTarget({
    worktreePath: descriptor.worktreePath,
    sessionId: descriptor.sessionId,
    pid: target.pid,
    uuid: target.uuid,
    selfPid,
  });
}

// defaultSpawnResume(a) -> { pid, earlyExit, timedOut, output }. DETACHED + unref'd
// so the resumed session runs independently. NO kill-on-timeout: the bounded
// readiness poll only watches for an immediate early exit (which surfaces
// "No conversation found"); if the child is still running when the window elapses
// that is SUCCESS-in-progress, NOT a reason to kill it.
function defaultSpawnResume(a) {
  const readinessMs = Number.isFinite(a.readinessMs) ? a.readinessMs : RESUME_READINESS_MS;
  let outFile = null, fd = 'ignore';
  try {
    outFile = path.join(os.tmpdir(), 'antihall-resume-' + process.pid + '-' + Date.now() + '.log');
    fd = fs.openSync(outFile, 'a');
  } catch (_) { fd = 'ignore'; outFile = null; }
  const child = spawn('claude', ['-p', '--resume', a.uuid, '--dangerously-skip-permissions'], {
    cwd: a.cwd, detached: true, stdio: ['pipe', fd, fd],
  });
  try { child.stdin.write(a.prompt || ''); child.stdin.end(); } catch (_) {}
  const pid = child.pid;
  child.unref();

  const deadline = Date.now() + readinessMs;
  let earlyExit = false;
  while (Date.now() < deadline) {
    if (!defaultIsAlive(pid)) { earlyExit = true; break; }
    sleepSync(100);
  }
  let output = '';
  if (outFile) { try { output = fs.readFileSync(outFile, 'utf8'); } catch (_) {} }
  // Only clean up the temp file once the child is gone; while it is alive it may
  // still be writing to fd (leave it — the short-lived sweep process will exit and
  // the OS reclaims the descriptor).
  if (earlyExit) {
    try { if (typeof fd === 'number') fs.closeSync(fd); } catch (_) {}
    if (outFile) { try { fs.unlinkSync(outFile); } catch (_) {} }
  }
  return { pid, earlyExit, timedOut: !earlyExit, output };
}

// recover(opts) -> { action, ... }. See header for invariants.
function recover(opts) {
  const descriptor = opts.descriptor;
  const home = opts.home || os.homedir();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const io = opts.io || {};
  const F = io.fs || fs;
  const platform = io.platform || process.platform;
  const selfPid = Number.isFinite(io.selfPid) ? io.selfPid : process.pid;
  const maxRec = Number.isFinite(opts.maxRecoveries) ? opts.maxRecoveries : DEFAULT_MAX_RECOVERIES;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : DEFAULT_GRACE_MS;
  const target = opts.target;
  const reconfirm = io.reconfirm || ((t) => defaultReconfirm(t, descriptor, selfPid));

  try {
    // Confirm-gate: never kill on an ambiguous target.
    if (!target || target.ambiguous || !target.pid) {
      appendLog(home, { id: descriptor.id, action: 'abstain', reason: (target && target.reason) || 'no-target' }, F);
      persistVerdict(descriptor, home, F, 'ambiguous');
      return { action: 'abstain', reason: (target && target.reason) || 'no-target' };
    }

    // Windows: escalate-only, never kill.
    if (platform === 'win32') {
      appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'win32-no-kill' }, F);
      persistVerdict(descriptor, home, F, 'escalated');
      return { action: 'escalate', reason: 'win32-no-kill' };
    }

    // Cap: stop auto-recovering after N.
    const recoveries = readRecoveries(descriptor.id, home, F);
    if (recoveries >= maxRec) {
      appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'max-recoveries', recoveries }, F);
      persistVerdict(descriptor, home, F, 'escalated');
      return { action: 'escalate', reason: 'max-recoveries', recoveries };
    }

    // Single-writer lock (never resume the same id from two processes at once).
    const lock = io.lock ? io.lock(descriptor.id, home) : acquireLock(descriptor.id, home, { fs: F, isAlive: io.isAlive });
    if (!lock) {
      appendLog(home, { id: descriptor.id, action: 'skip', reason: 'locked' }, F);
      return { action: 'skip', reason: 'locked' };
    }

    try {
      persistVerdict(descriptor, home, F, 'recovering');
      const kill = io.kill || defaultKill;
      const killGroup = io.killGroup || defaultKillGroup;

      // TOCTOU re-confirm #1 — immediately before SIGTERM, on FRESH data.
      if (!reconfirm(target)) {
        appendLog(home, { id: descriptor.id, action: 'abstain', reason: 'identity-changed-pre-term', pid: target.pid }, F);
        persistVerdict(descriptor, home, F, 'ambiguous');
        return { action: 'abstain', reason: 'identity-changed' };
      }

      // Precise kill: SIGTERM the ONE pid + its group, then SIGKILL only if it
      // survives grace AND still re-confirms as the same target.
      kill(target.pid, 'SIGTERM');
      killGroup(target.pid, 'SIGTERM');
      appendLog(home, { id: descriptor.id, action: 'sigterm', pid: target.pid, uuid: target.uuid }, F);
      (io.sleep || sleepSync)(graceMs);
      if (kill(target.pid, 0)) {
        // TOCTOU re-confirm #2 — before SIGKILL. A pid recycled during the grace
        // window must NOT be SIGKILLed.
        if (!reconfirm(target)) {
          appendLog(home, { id: descriptor.id, action: 'abstain', reason: 'identity-changed-pre-kill', pid: target.pid }, F);
          persistVerdict(descriptor, home, F, 'ambiguous');
          return { action: 'abstain', reason: 'identity-changed' };
        }
        kill(target.pid, 'SIGKILL');
        killGroup(target.pid, 'SIGKILL');
        appendLog(home, { id: descriptor.id, action: 'sigkill', pid: target.pid }, F);
      }

      // Resume headless (DETACHED) from the same cwd; feed the unread backlog.
      const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, F);
      const prompt = backlog.lines.join('\n');
      const res = (io.spawnResume || defaultSpawnResume)({ uuid: target.uuid, cwd: descriptor.worktreePath, prompt });
      const combined = String((res && res.output) || '') + String((res && res.stdout) || '') + String((res && res.stderr) || '');

      if (/No conversation found/i.test(combined)) {
        appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'no-conversation-found', uuid: target.uuid }, F);
        persistVerdict(descriptor, home, F, 'escalated');
        return { action: 'escalate', reason: 'no-conversation-found' };
      }

      // Resume launched. It runs INDEPENDENTLY — its true liveness is unknown until
      // the next post-cooldown sweep, so record 'recovering' (+recoveredAt) and
      // increment the counter. NEVER a false 'alive' from an unconfirmed resume.
      const v = persistVerdict(descriptor, home, F, 'recovering', { recoveries: recoveries + 1, recoveredAt: now });
      appendLog(home, { id: descriptor.id, action: 'resumed', pid: target.pid, uuid: target.uuid, recoveries: v.recoveries }, F);
      return { action: 'resumed', recoveries: v.recoveries, uuid: target.uuid, pid: target.pid };
    } finally {
      lock();
    }
  } catch (e) {
    appendLog(home, { id: descriptor && descriptor.id, action: 'error', reason: String(e && e.message) }, F);
    return { action: 'error', reason: String(e && e.message) };
  }
}

module.exports = {
  DEFAULT_MAX_RECOVERIES, DEFAULT_GRACE_MS, LOCK_STALE_MS,
  lockPathFor, recoveryLogPath, acquireLock, recover,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion/recovery.test.js`
Expected: PASS (all subtests, including never-broad-kill, abstain, escalate-after-N, single-writer, Windows).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/companion/lib/recovery.js tests/companion/recovery.test.js
git commit -m "feat(devswarm): confirm-gated precise-kill + single-writer resume recovery engine"
```

---

### Task 5: Sweep companion (`devswarm-supervisor.js`)

**Files:**
- Create: `plugins/anti-hall/companion/devswarm-supervisor.js`
- Test: `tests/companion/devswarm-supervisor.test.js`

**Interfaces:**
- Consumes: published descriptors under `~/.anti-hall/devswarm/workspaces/*.json`; the libs from Tasks 2–4; injectable `deps` for tests.
- Produces: `readDescriptors(home, fsi)` (requires `id` + `worktreePath` + `sessionId`, and **drops any descriptor whose `id` fails `isSafeId`** — P1-7), `supervisorEnabled(env)` (daemon gate — `off`/hard-kill only; DEVSWARM_REPO_ID is a per-SESSION var, absent in a launchd/systemd job, so it is NOT required here — descriptor presence is the activation signal), `sweepOnce(opts) -> [{id, verdict, recovery}]` (fail-open per workspace; passes `descriptor.sessionId` + `selfPid` into `findTarget` so targeting is identity-bound), `sweepLockPath(home)` + `acquireSweepLock(home, io)` (the **single-flight guard** — P2-11), and a `main()` that takes the sweep lock, runs one sweep, releases, and exits 0.
- **Single-flight (P2-11):** cron ticks (unlike launchd `StartInterval` / systemd `OnUnitActiveSec`) do NOT coalesce, so `main()` acquires a process-wide sweep lock (same dead-holder/stale-steal semantics as the per-workspace lock); if a previous sweep is still running under a LIVE holder, this tick exits immediately instead of stacking blocking `ps`/`lsof` work. There is no self-throttling in `sweepOnce` itself — the guard is explicit.

- [ ] **Step 1: Write the failing test**

Create `tests/companion/devswarm-supervisor.test.js`:

```js
'use strict';
// devswarm-supervisor: one sweep over published descriptors. Uses a real temp
// HOME for descriptor discovery; computeLiveness/findTarget/recover are injected
// so no real process is touched and per-workspace fail-open is provable. Also
// covers descriptor sanitization (unsafe id / missing sessionId dropped) and the
// single-flight sweep lock.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
// A complete, valid descriptor unless overridden.
function writeDescriptor(home, d, fileName) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, (fileName || d.id) + '.json'), JSON.stringify(full));
}

test('supervisorEnabled: off / hard-kill disable; otherwise enabled', () => {
  assert.strictEqual(M.supervisorEnabled({}), true);
  assert.strictEqual(M.supervisorEnabled({ ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false);
  assert.strictEqual(M.supervisorEnabled({ DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
});

test('readDescriptors: reads valid; skips malformed / no-worktree / no-sessionId / unsafe-id', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const dir = descriptorsDir(home);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'nofields.json'), JSON.stringify({ id: 'x', sessionId: UUID })); // no worktreePath
    fs.writeFileSync(path.join(dir, 'nosession.json'), JSON.stringify({ id: 'y', worktreePath: '/wt/y' })); // no sessionId
    fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ id: '../../x', worktreePath: '/wt/z', sessionId: UUID })); // P1-7
    const ds = M.readDescriptors(home);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].id, 'a');
  } finally { cleanup(); }
});

test('sweepOnce: alive workspace -> verdict written, no recovery attempted', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let recoverCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'alive', lastOutboundTs: 1, staleSince: null, recoveries: 0 }),
        writeVerdict: () => {},
        recover: () => { recoverCalls++; return { action: 'resumed' }; },
      },
    });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].verdict.status, 'alive');
    assert.strictEqual(recoverCalls, 0);
  } finally { cleanup(); }
});

test('sweepOnce: stale workspace -> findTarget (identity-bound) + recover invoked', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const seen = {};
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 0 }),
        writeVerdict: () => {},
        findTarget: (o) => { seen.wt = o.worktreePath; seen.sid = o.sessionId; return { pid: 1, uuid: o.sessionId, worktreePath: o.worktreePath }; },
        recover: (o) => { seen.recovered = o.target.pid; return { action: 'resumed' }; },
      },
    });
    assert.strictEqual(seen.wt, '/wt/a');
    assert.strictEqual(seen.sid, UUID); // sessionId threaded from the descriptor
    assert.strictEqual(seen.recovered, 1);
    assert.strictEqual(res[0].recovery.action, 'resumed');
  } finally { cleanup(); }
});

test('sweepOnce: fail-open — a throwing computeLiveness on one workspace does not stop the rest', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/b' });
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: (o) => { if (o.descriptor.id === 'a') throw new Error('boom'); return { status: 'alive', recoveries: 0 }; },
        writeVerdict: () => {},
        recover: () => ({ action: 'resumed' }),
      },
    });
    assert.strictEqual(res.length, 2);
    const a = res.find((r) => r.id === 'a'); const b = res.find((r) => r.id === 'b');
    assert.ok(a.error, 'workspace a recorded an error');
    assert.strictEqual(b.verdict.status, 'alive', 'workspace b still processed');
  } finally { cleanup(); }
});

test('sweepOnce: disabled -> empty (no work)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const res = M.sweepOnce({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'off' } });
    assert.deepStrictEqual(res, []);
  } finally { cleanup(); }
});

test('single-flight: a live-holder sweep lock blocks a second acquire; a dead holder is stolen', () => {
  const { home, cleanup } = makeHome();
  try {
    const held = M.acquireSweepLock(home, { fs });
    assert.ok(held, 'first sweep lock must succeed');
    assert.strictEqual(M.acquireSweepLock(home, { fs, isAlive: () => true }), null, 'a live holder blocks overlap');
    held();
    // Pre-write a dead-holder lock -> stealable so a crashed sweep cannot wedge cron forever.
    fs.writeFileSync(M.sweepLockPath(home), JSON.stringify({ pid: 4242, ts: Date.now() }));
    const stolen = M.acquireSweepLock(home, { fs, isAlive: () => false });
    assert.ok(stolen, 'dead-holder sweep lock must be stealable');
    stolen();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/devswarm-supervisor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/devswarm-supervisor.js`:

```js
'use strict';
// anti-hall :: devswarm-supervisor — one sweep over published workspace
// descriptors: compute liveness, write the verdict, recover the wedged ones.
// Workaround for claude-code#39755. OPT-IN (installed explicitly by the user via
// install-devswarm-supervisor.js), fail-open per workspace, pure Node.
//
// Activation signal = the presence of ~/.anti-hall/devswarm/workspaces/*.json
// descriptors (published by the consumer). DEVSWARM_REPO_ID is a per-SESSION var
// and is absent in a launchd/systemd background job, so it is intentionally NOT
// required here; the daemon gate is only the off / hard-kill switches.
//
// SINGLE-FLIGHT (P2-11): a cron fallback does NOT coalesce ticks the way launchd
// StartInterval / systemd OnUnitActiveSec do, so main() takes a process-wide sweep
// lock (dead-holder/stale steal) and exits immediately if a prior sweep is still
// running — overlapping sweeps must never stack blocking ps/lsof work.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { devswarmRoot, computeLiveness, writeVerdict, isSafeId } = require('./lib/liveness.js');
const { findTarget } = require('./lib/target-session.js');
const { recover } = require('./lib/recovery.js');

const SWEEP_LOCK_STALE_MS = 5 * 60 * 1000; // a sweep should never run this long; steal a lock older than this

function workspacesDir(home) {
  return path.join(devswarmRoot(home), 'workspaces');
}

// readDescriptors(home, fsi) -> [{id, worktreePath, inboxPath, cursorPath, sessionId}].
// Skips unreadable/malformed files (fail-open: one bad descriptor never stops the
// sweep). Requires id + worktreePath + sessionId, AND a path-safe id (P1-7) so a
// hostile id can never escape into locks/liveness/recovery paths.
function readDescriptors(home, fsi) {
  const F = fsi || fs;
  let names = [];
  try { names = F.readdirSync(workspacesDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const d = JSON.parse(F.readFileSync(path.join(workspacesDir(home), n), 'utf8'));
      if (d && d.worktreePath && d.sessionId && isSafeId(d.id)) out.push(d);
    } catch (_) {}
  }
  return out;
}

// supervisorEnabled(env) — daemon gate: off / hard-kill only.
function supervisorEnabled(env) {
  const e = env || process.env;
  if (e.DISABLE_ANTIHALL_DEVSWARM === '1') return false;
  if (String(e.ANTIHALL_DEVSWARM_SUPERVISOR || 'auto').trim().toLowerCase() === 'off') return false;
  return true;
}

// ----- single-flight sweep lock (P2-11) -----
function sweepLockPath(home) { return path.join(devswarmRoot(home), 'locks', 'sweep.lock'); }
function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// acquireSweepLock(home, io) -> release() | null. Same dead-holder/stale-steal
// semantics as the per-workspace lock, on a fixed process-wide path.
function acquireSweepLock(home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const p = sweepLockPath(home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try { const cur = JSON.parse(F.readFileSync(p, 'utf8')); if (cur && cur.token === token) F.unlinkSync(p); } catch (_) {}
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      const holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      const dead = holderPid !== null && !isAlive(holderPid);
      const stale = holderTs === null || (now() - holderTs) > SWEEP_LOCK_STALE_MS;
      if (dead || stale) { try { F.unlinkSync(p); } catch (_) {} continue; }
      return null; // live, fresh sweep in progress -> skip this tick
    }
  }
  return null;
}

// sweepOnce({home, now, env, idleThresholdMs, cooldownMs, maxRecoveries, selfPid, deps})
//   -> [{ id, verdict, recovery } | { id, error }]. deps injectable for tests.
function sweepOnce(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const deps = o.deps || {};
  const F = deps.fs || fs;
  if (!supervisorEnabled(env)) return [];

  const descriptors = (deps.readDescriptors || readDescriptors)(home, F);
  const results = [];
  for (const d of descriptors) {
    try {
      const verdict = (deps.computeLiveness || computeLiveness)({
        descriptor: d, now: o.now, home, runners: deps.runners,
        idleThresholdMs: o.idleThresholdMs, cooldownMs: o.cooldownMs,
      });
      (deps.writeVerdict || writeVerdict)(d.id, verdict, home, F);

      let recovery = null;
      if (verdict.status === 'stale') {
        const target = (deps.findTarget || findTarget)({
          worktreePath: d.worktreePath, sessionId: d.sessionId, home, runners: deps.targetRunners, selfPid: o.selfPid,
        });
        recovery = (deps.recover || recover)({
          descriptor: d, target, home, now: o.now, io: deps.io, maxRecoveries: o.maxRecoveries,
        });
      }
      results.push({ id: d.id, verdict, recovery });
    } catch (e) {
      results.push({ id: d && d.id, error: String(e && e.message) });
    }
  }
  return results;
}

function main() {
  let release = null;
  try {
    const home = os.homedir();
    release = acquireSweepLock(home, {});
    if (!release) { process.exit(0); return; } // a prior sweep is still running — do not stack
    const results = sweepOnce({ home });
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), sweep: results.length }) + '\n');
  } catch (_) {
    // absolute fail-safe: never throw out of the sweep
  } finally {
    try { if (release) release(); } catch (_) {}
    process.exit(0);
  }
}

if (require.main === module) main();

module.exports = { workspacesDir, readDescriptors, supervisorEnabled, sweepLockPath, acquireSweepLock, sweepOnce };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion/devswarm-supervisor.test.js`
Expected: PASS (all subtests, including per-workspace fail-open).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/companion/devswarm-supervisor.js tests/companion/devswarm-supervisor.test.js
git commit -m "feat(devswarm): sweep companion tying liveness detection to confirm-gated recovery"
```

---

### Task 6: Opt-in installer (`install-devswarm-supervisor.js`)

**Files:**
- Create: `plugins/anti-hall/companion/install-devswarm-supervisor.js`
- Test: `tests/companion/install-devswarm-supervisor.test.js`

**Interfaces:**
- Consumes: `process.argv` (`--uninstall`, `--dry-run`), `process.execPath`, `os.homedir()`, `__dirname`.
- Produces: an installed background job — macOS LaunchAgent (`StartInterval`, default 90s clamped to 60–120), Linux systemd `--user` timer with a cron fallback, Windows no-op (exit 0). Exports pure builders `buildPlist`, `buildService`, `buildTimer`, `buildCronLine`, `xmlEscape`, `clampInterval`, and constants `LABEL`, `UNIT` for direct testing. Modeled EXACTLY on `install-reaper.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/companion/install-devswarm-supervisor.test.js`:

```js
'use strict';
// install-devswarm-supervisor pure-builder tests. No real launchctl/systemctl/fs
// writes — only the text builders + the interval clamp, with a nasty path.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');
const m = require(MOD);

const NASTY = '/Users/a b & c/<x>/"q\'/node';
const NASTY_SCRIPT = '/Users/a b & c/devswarm-supervisor.js';

test('clampInterval: default 90, clamps to 60..120, rejects garbage', () => {
  assert.strictEqual(m.clampInterval(undefined), 90);
  assert.strictEqual(m.clampInterval('90'), 90);
  assert.strictEqual(m.clampInterval('30'), 60);   // below floor
  assert.strictEqual(m.clampInterval('999'), 120); // above ceiling
  assert.strictEqual(m.clampInterval('abc'), 90);  // garbage -> default
});

test('buildPlist XML-escapes exec/script/log, embeds the clamped interval, well-formed', () => {
  const xml = m.buildPlist({ exec: NASTY, script: NASTY_SCRIPT, log: '/log/a & b.log', interval: 90 });
  assert.ok(xml.includes('<string>/Users/a b &amp; c/&lt;x&gt;/&quot;q&apos;/node</string>'));
  assert.ok(xml.includes('<string>/Users/a b &amp; c/devswarm-supervisor.js</string>'));
  assert.ok(xml.includes('<integer>90</integer>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'no bare ampersands allowed');
  assert.strictEqual((xml.match(/<string>/g) || []).length, (xml.match(/<\/string>/g) || []).length);
  assert.ok(xml.includes(m.LABEL));
});

test('buildService double-quotes exec + script (space-safe)', () => {
  const unit = m.buildService({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(unit.includes(`ExecStart="${NASTY}" "${NASTY_SCRIPT}"`));
});

test('buildTimer carries the clamped interval on OnUnitActiveSec', () => {
  const t = m.buildTimer({ interval: 120 });
  assert.ok(/OnUnitActiveSec=120/.test(t));
  assert.ok(/WantedBy=timers.target/.test(t));
});

test('buildCronLine double-quotes exec + script and discards output', () => {
  const line = m.buildCronLine({ exec: NASTY, script: NASTY_SCRIPT });
  assert.ok(line.includes(`"${NASTY}" "${NASTY_SCRIPT}"`));
  assert.ok(line.endsWith('>/dev/null 2>&1'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/install-devswarm-supervisor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/install-devswarm-supervisor.js`:

```js
#!/usr/bin/env node
'use strict';
// anti-hall :: install-devswarm-supervisor — installs the OPT-IN DevSwarm liveness
// supervisor as a background job. Workaround for claude-code#39755.
//
//   node install-devswarm-supervisor.js              install (90s sweep)
//   node install-devswarm-supervisor.js --uninstall  remove
//   node install-devswarm-supervisor.js --dry-run    print what it would do
//
//   ANTIHALL_DEVSWARM_INTERVAL=<sec>  override sweep interval (clamped 60..120)
//
// macOS  -> LaunchAgent (launchd), label com.anti-hall.devswarm-supervisor.
// Linux  -> systemd --user .service + .timer; cron fallback if systemctl absent.
// Windows-> unsupported for RECOVERY (documented no-op), exit 0. (A running
//           process's cwd is not obtainable in pure Node on Windows, so the cwd
//           confirm-gate that makes the kill safe cannot run.)
//
// Opt-in: a component that can KILL a process must never self-install — the user
// runs this explicitly. Agnostic: no hardcoded paths/users (os.homedir(),
// process.execPath, __dirname).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.anti-hall.devswarm-supervisor';
const UNIT = 'anti-hall-devswarm-supervisor';
const SCRIPT = path.join(__dirname, 'devswarm-supervisor.js');
const EXEC = process.execPath;
const HOME = os.homedir();
const LOG = path.join(HOME, '.anti-hall', 'devswarm-supervisor.log');

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const DRYRUN = args.includes('--dry-run');

// clampInterval(v) -> seconds in [60, 120], default 90 for missing/garbage input.
function clampInterval(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.max(60, Math.min(120, n));
}
const INTERVAL = clampInterval(process.env.ANTIHALL_DEVSWARM_INTERVAL);

function say(msg) { process.stdout.write(msg + '\n'); }

function planWrite(file, contents) {
  if (DRYRUN) { say(`[dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  say(`wrote ${file}`);
}
function planRm(file) {
  if (DRYRUN) { say(`[dry-run] would remove ${file}`); return; }
  try { fs.unlinkSync(file); say(`removed ${file}`); } catch (_e) { say(`(not present) ${file}`); }
}
function planRun(cmd, argv, opts) {
  if (DRYRUN) { say(`[dry-run] would run: ${cmd} ${argv.join(' ')}`); return { status: 0, dry: true }; }
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...(opts || {}) });
  if (r.error) say(`(warn) ${cmd} failed: ${r.error.message}`);
  else say(`ran: ${cmd} ${argv.join(' ')} (exit ${r.status})`);
  return r;
}

// XML-escape for plist <string> bodies. Order matters: & first, then < > " '.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ----- macOS -----
function macPlistPath() { return path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`); }

function buildPlist({ label = LABEL, exec = EXEC, script = SCRIPT, log = LOG, interval = INTERVAL } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exec)}</string>
    <string>${xmlEscape(script)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${clampInterval(interval)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function macInstall() {
  const plist = macPlistPath();
  planWrite(plist, buildPlist());
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${LABEL} (${INTERVAL}s interval). Logs: ${LOG}`);
}
function macUninstall() {
  const plist = macPlistPath();
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${LABEL}`);
}

// ----- Linux -----
function unitDir() { return path.join(HOME, '.config', 'systemd', 'user'); }

function buildService({ exec = EXEC, script = SCRIPT } = {}) {
  return `[Unit]
Description=anti-hall DevSwarm liveness supervisor (oneshot) [claude-code#39755 workaround]

[Service]
Type=oneshot
ExecStart="${exec}" "${script}"
`;
}
function buildTimer({ interval = INTERVAL } = {}) {
  const s = clampInterval(interval);
  return `[Unit]
Description=anti-hall DevSwarm liveness supervisor timer (${s}s)

[Timer]
OnBootSec=${s}
OnUnitActiveSec=${s}
Persistent=true

[Install]
WantedBy=timers.target
`;
}
function hasSystemctl() {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
function buildCronLine({ exec = EXEC, script = SCRIPT } = {}) {
  return `* * * * * "${exec}" "${script}" >/dev/null 2>&1`;
}

function linuxInstall() {
  const dir = unitDir();
  planWrite(path.join(dir, `${UNIT}.service`), buildService());
  planWrite(path.join(dir, `${UNIT}.timer`), buildTimer());
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`);
    say(`[dry-run] if systemctl absent, cron fallback line (runs every minute; overlapping ticks are coalesced by the supervisor's single-flight sweep lock):`);
    say(`  ${buildCronLine()}`);
    return;
  }
  if (!hasSystemctl()) {
    say('systemctl not available. Add this cron line instead (crontab -e):');
    say(`  ${buildCronLine()}`);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
  say(`installed systemd --user timer ${UNIT}.timer (${INTERVAL}s). Logs: ${LOG}`);
}
function linuxUninstall() {
  const dir = unitDir();
  if (!DRYRUN && !hasSystemctl()) {
    say('systemctl not available. If you used the cron fallback, remove this line (crontab -e):');
    say(`  ${buildCronLine()}`);
  } else {
    planRun('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
  }
  planRm(path.join(dir, `${UNIT}.timer`));
  planRm(path.join(dir, `${UNIT}.service`));
  if (!DRYRUN && hasSystemctl()) planRun('systemctl', ['--user', 'daemon-reload']);
  say(`uninstalled ${UNIT}`);
}

// ----- Windows -----
function windowsNoop() {
  say(
    'anti-hall devswarm-supervisor: Windows recovery is unsupported (documented no-op).\n' +
      "Reason: a running process's cwd is not obtainable in pure Node on Windows (no\n" +
      '/proc, no lsof equivalent), so the cwd confirm-gate that makes the kill safe\n' +
      'cannot run. Combined with PID recycling, external process targeting is unsafe.\n' +
      'Detection-only use is still possible from a session; no scheduler installed. Exit 0.'
  );
  process.exit(0);
}

function main() {
  try {
    if (process.platform === 'win32') return windowsNoop();
    if (!fs.existsSync(SCRIPT)) { say(`error: supervisor script not found at ${SCRIPT}`); process.exit(1); return; }
    if (process.platform === 'darwin') { if (UNINSTALL) macUninstall(); else macInstall(); }
    else { if (UNINSTALL) linuxUninstall(); else linuxInstall(); }
    process.exit(0);
  } catch (e) {
    say(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  LABEL, UNIT, clampInterval, xmlEscape, buildPlist, buildService, buildTimer, buildCronLine,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion/install-devswarm-supervisor.test.js`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/companion/install-devswarm-supervisor.js tests/companion/install-devswarm-supervisor.test.js
git commit -m "feat(devswarm): opt-in supervisor installer (LaunchAgent / systemd+cron / Windows no-op)"
```

---

### Task 7: Doctor check (`doctor-devswarm.js` + wire into `doctor.js`)

**Files:**
- Create: `plugins/anti-hall/companion/lib/doctor-devswarm.js`
- Modify: `plugins/anti-hall/hooks/doctor.js`
- Test: `tests/companion/doctor-devswarm.test.js`

**Interfaces:**
- Consumes: `{ home, env, fsi, now, stuckMs }`; the liveness lib.
- Produces: `runChecks({ home, env, fsi, now, stuckMs }) -> { active, results: [{status, message}] }` where `status ∈ PASS|WARN|FAIL`. Exports `PASS`, `WARN`, `FAIL`. Behavioral self-test (constructed fixture per doctor convention) PLUS a per-real-workspace readout. `doctor.js` requires it and renders — silent when `!active` and no descriptors.
- Mapping: verdict `alive` → PASS; `stale` → WARN; `recovering` → WARN **unless** it has been recovering longer than `stuckMs` (past several sweeps: `now - recoveredAt > stuckMs`, or a `recovering` verdict with no `recoveredAt` at all), in which case → **FAIL** (P0-3: a workspace wedged in `recovering`/locked must escalate to the human, not sit as a soft WARN forever); `ambiguous`/`escalated` → FAIL. The constructed self-test asserts the live logic still classifies a fresh fixture `alive` (PASS) and a wedged fixture `stale` (WARN) — proving the check fires, matching `doctor.js`'s live-behavioral-self-test convention.
- **`doctor.js` also syntax-checks the new libs (P2-12):** because `hooks/lib/*` and `companion/lib/*` are NOT registered in `hooks.json`, the existing doctor syntax loop never sees them, and the `require()`-fail-open wrapper would make a syntax error in `doctor-devswarm.js` VANISH. `doctor.js` therefore adds an EXPLICIT `node --check` over every new supervisor file that FAILs (not vanishes) on a broken file — see Step 4.

- [ ] **Step 1: Write the failing test**

Create `tests/companion/doctor-devswarm.test.js`:

```js
'use strict';
// doctor-devswarm: the DevSwarm section of `doctor.js` as a pure, testable check
// function (mirrors the flutter-debug preflight -> doctor pattern). Real temp HOME
// with fake timestamps; no real process touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-devswarm.js',
));
const { projectDirFor, writeVerdict } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function writeDescriptor(home, d) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, d.id + '.json'), JSON.stringify(Object.assign({ sessionId: UUID }, d)));
}

test('dormant: not active + no descriptors -> active:false, no results', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: {} });
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.results.length, 0);
  } finally { cleanup(); }
});

test('active via env -> runs the behavioral self-test (alive fixture = PASS)', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: { DEVSWARM_REPO_ID: 'repo-x' } });
    assert.strictEqual(r.active, true);
    assert.ok(r.results.some((x) => x.status === D.PASS), 'self-test emits a PASS');
  } finally { cleanup(); }
});

test('per-workspace readout: escalated verdict -> FAIL', () => {
  const { home, cleanup } = makeHome();
  try {
    // A real workspace descriptor + a persisted verdict.
    const worktreePath = path.join(home, 'wt', 'a');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
    writeDescriptor(home, { id: 'a', worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
    writeVerdict('a', { status: 'escalated', lastOutboundTs: 1, staleSince: 1, recoveries: 3 }, home);

    const r = D.runChecks({ home, env: {} }); // active via descriptor presence
    assert.strictEqual(r.active, true);
    const workspaceLine = r.results.find((x) => /workspace a/.test(x.message));
    assert.ok(workspaceLine, 'a per-workspace line is present');
    assert.strictEqual(workspaceLine.status, D.FAIL, 'escalated -> FAIL');
  } finally { cleanup(); }
});

test('per-workspace readout: fresh `recovering` = WARN; STUCK `recovering` past stuckMs = FAIL', () => {
  const { home, cleanup } = makeHome();
  try {
    const now = Date.now();
    const mk = (id) => {
      const worktreePath = path.join(home, 'wt', id);
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
      writeDescriptor(home, { id, worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
    };
    mk('fresh'); mk('stuck');
    writeVerdict('fresh', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 60 * 1000 }, home);
    writeVerdict('stuck', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 60 * 60 * 1000 }, home);

    const r = D.runChecks({ home, env: {}, now, stuckMs: 30 * 60 * 1000 });
    const fresh = r.results.find((x) => /workspace fresh/.test(x.message));
    const stuck = r.results.find((x) => /workspace stuck/.test(x.message));
    assert.strictEqual(fresh.status, D.WARN, 'a just-recovered workspace is a soft WARN');
    assert.strictEqual(stuck.status, D.FAIL, 'a workspace wedged in recovering past stuckMs FAILs (needs a human)');
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion/doctor-devswarm.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/companion/lib/doctor-devswarm.js`:

```js
'use strict';
// anti-hall :: doctor-devswarm — the DevSwarm liveness section of doctor.js as a
// pure, testable check function (mirrors skills/flutter-debug/scripts/preflight.js
// -> doctor.js §6b). Workaround for claude-code#39755.
//
// runChecks({home, env, fsi}) -> { active, results: [{status, message}] }.
// Silent (active:false, no results) unless the supervisor is in play — either the
// session is DevSwarm-active OR the consumer has published workspace descriptors.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { isDevswarmActive } = require('../../hooks/lib/devswarm-detect.js');
const { computeLiveness, livenessPathFor, projectDirFor, devswarmRoot, isSafeId } = require('./liveness.js');

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const SELFTEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DEFAULT_STUCK_MS = 30 * 60 * 1000; // recovering longer than this = stuck -> FAIL (needs a human)

function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }

function readDescriptors(home, F) {
  let names = [];
  try { names = F.readdirSync(workspacesDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const d = JSON.parse(F.readFileSync(path.join(workspacesDir(home), n), 'utf8'));
      if (d && d.worktreePath && d.sessionId && isSafeId(d.id)) out.push(d);
    } catch (_) {}
  }
  return out;
}

// statusFor(verdictStatus) -> PASS | WARN | FAIL (base mapping, no stuck logic).
function statusFor(s) {
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'recovering') return WARN;
  return FAIL; // ambiguous | escalated | anything unexpected
}

// statusForVerdict(verdict, now, stuckMs) -> PASS | WARN | FAIL. Adds the P0-3
// stuck-recovering escalation: a `recovering` verdict that has not cleared within
// stuckMs (or has no recoveredAt at all) FAILs so a human is told, rather than
// sitting as a soft WARN forever.
function statusForVerdict(verdict, now, stuckMs) {
  const s = verdict && verdict.status;
  if (s === 'alive') return PASS;
  if (s === 'stale') return WARN;
  if (s === 'recovering') {
    const recoveredAt = verdict && Number.isFinite(verdict.recoveredAt) ? verdict.recoveredAt : null;
    if (recoveredAt === null) return FAIL;                 // recovering with no recovery ts = stuck
    return (now - recoveredAt) > stuckMs ? FAIL : WARN;    // stuck past the window -> FAIL
  }
  return FAIL; // ambiguous | escalated | unexpected
}

// selfTest(home, F) -> [{status, message}]. Constructed-fixture behavioral test
// (doctor convention): a FRESH transcript classifies alive; a WEDGED one (idle +
// pending) classifies stale. Proves the live logic still fires. Liveness is
// uuid-SCOPED, so the fixture's transcript is named <SELFTEST_UUID>.jsonl and the
// descriptor carries that sessionId.
function selfTest(home, F) {
  const out = [];
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-selftest-'));
    try {
      const wt = path.join(base, 'wt');
      F.mkdirSync(wt, { recursive: true });
      const projectDir = projectDirFor(wt, base);
      F.mkdirSync(projectDir, { recursive: true });
      const tp = path.join(projectDir, SELFTEST_UUID + '.jsonl');
      F.writeFileSync(tp, '{}\n');
      const inboxPath = path.join(wt, 'i'); const cursorPath = path.join(wt, 'c');
      F.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
      F.writeFileSync(cursorPath, '0');
      const descriptor = { id: 'selftest', worktreePath: wt, inboxPath, cursorPath, sessionId: SELFTEST_UUID };

      // Fresh: transcript mtime = now -> alive.
      const nowTs = Date.now();
      const alive = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => nowTs } });
      out.push({ status: alive.status === 'alive' ? PASS : FAIL, message: 'liveness self-test: fresh workspace classified ' + alive.status + ' (expected alive)' });

      // Wedged: both signals idle + pending -> stale.
      const old = nowTs - 30 * 60 * 1000;
      const t = old / 1000; F.utimesSync(tp, t, t);
      const wedged = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => old } });
      out.push({ status: wedged.status === 'stale' ? WARN : FAIL, message: 'liveness self-test: wedged workspace classified ' + wedged.status + ' (expected stale)' });
    } finally {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (e) {
    out.push({ status: WARN, message: 'liveness self-test raised (fail-open): ' + (e && e.message) });
  }
  return out;
}

function runChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const stuckMs = Number.isFinite(o.stuckMs) ? o.stuckMs : DEFAULT_STUCK_MS;

  const descriptors = readDescriptors(home, F);
  const active = isDevswarmActive(env) || descriptors.length > 0;
  if (!active) return { active: false, results: [] };

  const results = selfTest(home, F);

  // Per-real-workspace readout from persisted verdicts.
  for (const d of descriptors) {
    let verdict = null;
    try { verdict = JSON.parse(F.readFileSync(livenessPathFor(d.id, home), 'utf8')); } catch (_) {}
    if (!verdict) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ': no liveness verdict yet (sweep has not run)' });
      continue;
    }
    const status = statusForVerdict(verdict, now, stuckMs);
    const stuckNote = (status === FAIL && verdict.status === 'recovering') ? ' [STUCK — needs a human]' : '';
    results.push({
      status,
      message: 'workspace ' + d.id + ': ' + verdict.status + ' (recoveries=' + (verdict.recoveries || 0) + ')' + stuckNote,
    });
  }
  return { active: true, results };
}

module.exports = { PASS, WARN, FAIL, DEFAULT_STUCK_MS, statusFor, statusForVerdict, runChecks };
```

- [ ] **Step 4: Wire it into `doctor.js`**

Add this section to `plugins/anti-hall/hooks/doctor.js` immediately AFTER the flutter-debug section 6b IIFE (`})();` near line 412) and BEFORE `// --- 7. Summary ---`. It mirrors the flutter-debug pattern (require the check module, call it, render PASS/WARN/FAIL; stay silent when dormant) AND adds the P2-12 explicit syntax-check: because these libs are NOT in `hooks.json`, the section-2 loop never sees them and the `require()`-fail-open would make a syntax error VANISH — so a broken supervisor file must FAIL loudly here even when the section is otherwise dormant. (Uses `cp`, `HOOKS`, `ROOT`, `head/ok/warnl/bad` already defined at the top of `doctor.js`.)

```js
// --- 6c. DevSwarm liveness supervisor (CONDITIONAL: active session or descriptors) ---
// ONE implementation, two entry points: companion/lib/doctor-devswarm.js EXPORTS
// runChecks; doctor requires it and CALLS it IN-PROCESS. Silent unless a DevSwarm
// session is active OR the consumer has published workspace descriptors — EXCEPT a
// syntax error in any supervisor lib is always surfaced (P2-12). Workaround for
// claude-code#39755.
(function devswarmSection() {
  const libDir = path.join(ROOT, 'companion', 'lib');
  const supervisorFiles = [
    path.join(HOOKS, 'lib', 'devswarm-detect.js'),
    path.join(libDir, 'target-session.js'),
    path.join(libDir, 'liveness.js'),
    path.join(libDir, 'recovery.js'),
    path.join(libDir, 'doctor-devswarm.js'),
    path.join(ROOT, 'companion', 'devswarm-supervisor.js'),
    path.join(ROOT, 'companion', 'install-devswarm-supervisor.js'),
  ];
  // P2-12: node --check each PRESENT file so a broken file FAILS (loudly) instead
  // of vanishing behind the require()-fail-open below.
  const syntaxErrors = [];
  for (const f of supervisorFiles) {
    if (!fs.existsSync(f)) continue; // optional / older build
    const chk = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (chk.status !== 0) syntaxErrors.push({ f, err: (chk.stderr || '').split('\n')[0] });
  }

  const modPath = path.join(libDir, 'doctor-devswarm.js');
  let dsd = null, report = null;
  if (fs.existsSync(modPath)) {
    try { dsd = require(modPath); } catch (_) { dsd = null; } // fail-open: a broken check never breaks doctor
    if (dsd) { try { report = dsd.runChecks({ home: os.homedir(), env: process.env }); } catch (_) { report = null; } }
  }
  const active = !!(report && report.active);

  // Fully silent ONLY when dormant AND every lib parses; otherwise render.
  if (!active && syntaxErrors.length === 0) return;
  head('DevSwarm liveness supervisor (optional)');
  for (const se of syntaxErrors) bad('supervisor lib SYNTAX ERROR: ' + path.basename(se.f) + ' — ' + se.err);
  if (active && report && dsd) {
    for (const r of report.results) {
      if (r.status === dsd.FAIL) bad(r.message);
      else if (r.status === dsd.WARN) warnl(r.message);
      else ok(r.message);
    }
  }
})();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/companion/doctor-devswarm.test.js`
Expected: PASS.
Run: `node plugins/anti-hall/hooks/doctor.js` (in a non-DevSwarm shell)
Expected: the report renders and the "DevSwarm liveness supervisor" section is ABSENT (dormant — no descriptors, no `DEVSWARM_REPO_ID`), proving zero effect outside DevSwarm. Then re-run with `DEVSWARM_REPO_ID=demo node plugins/anti-hall/hooks/doctor.js` and confirm the section appears with the two self-test lines.

- [ ] **Step 6: Commit**

```bash
git add plugins/anti-hall/companion/lib/doctor-devswarm.js plugins/anti-hall/hooks/doctor.js tests/companion/doctor-devswarm.test.js
git commit -m "feat(devswarm): doctor PASS/WARN/FAIL per-workspace liveness check (feature-gated)"
```

---

### Task 8: Documentation as OPTIONAL + version bump (dual-platform)

**Files (edits only — text, no logic):**
- Modify: `README.md`, `plugins/anti-hall/README.md`, `llms.txt`, `docs/KB.md`, `plugins/anti-hall/.claude-plugin/plugin.json`, `plugins/anti-hall/codex/README.md`, `CHANGELOG.md`.

**Requirement (design §7):** document the supervisor **exactly like OMC/OMX** — an optional, dormant capability, never a default-on feature. State plainly in each surface: **dormant unless `DEVSWARM_REPO_ID` is set AND the companion has been explicitly installed** (opt-in). Windows = detection-only.

- [ ] **Step 1: README (root + plugin) — add an optional-integration section**

Find the existing `install-reaper` / OMC-OMX optional-integration section in each README (locate with `grep -n "install-reaper\|OMC\|OMX\|optional" README.md plugins/anti-hall/README.md`) and add, in the same tone, immediately after it:

```markdown
### DevSwarm liveness supervisor (optional, opt-in)

A pure-Node background job that detects a DevSwarm workspace whose `claude` session
has silently wedged (alive process, dead listener — the upstream `claude-code#39755`
failure class) and recovers it: it derives the ONE session id + pid for that worktree
and binds the kill to the workspace's published `sessionId` (argv uuid == sessionId +
cwd confirm-gate + headless-only, requiring exactly one candidate or it abstains — an
interactive human takeover is never targeted), precise-kills only that process group,
then resumes it headless (`claude -p --resume …`) from the same worktree and replays
the unread backlog. It re-confirms identity on fresh data before every signal, caps
recoveries with a cooldown, and escalates to a human rather than looping.

Dormant unless BOTH: `DEVSWARM_REPO_ID` is set AND you install it explicitly (it can
kill a process, so it never self-installs):

    node plugins/anti-hall/companion/install-devswarm-supervisor.js          # install
    node plugins/anti-hall/companion/install-devswarm-supervisor.js --dry-run
    node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall

macOS/Linux: full detection + recovery. Windows: detection-only (documented no-op) —
the cwd confirm-gate that makes the kill safe is not available in pure Node there.
Fail-open throughout: it never kills a healthy workspace and never broad-kills. Off
switches: `ANTIHALL_DEVSWARM_SUPERVISOR=off` or `DISABLE_ANTIHALL_DEVSWARM=1`.
```

- [ ] **Step 2: `llms.txt` — one entry**

Locate the OMC/OMX / reaper entries (`grep -n "reaper\|OMC\|OMX\|optional" llms.txt`) and add one parallel line, e.g.:

```
- DevSwarm liveness supervisor (optional, opt-in): pure-Node background job that detects a wedged DevSwarm `claude` session (claude-code#39755) and recovers it via confirm-gated precise-kill + headless `--resume`. Dormant unless DEVSWARM_REPO_ID is set AND installed via companion/install-devswarm-supervisor.js. macOS/Linux full; Windows detection-only.
```

- [ ] **Step 3: `docs/KB.md` — short optional note**

Locate the reaper/companion mention (`grep -n "install-reaper\|companion\|reaper" docs/KB.md`) and add a short paragraph in the same style pointing at the installer and the off-switches, noting the seam (consumer publishes `~/.anti-hall/devswarm/workspaces/<id>.json`).

- [ ] **Step 4: `plugin.json` — version bump + describe the companion**

In `plugins/anti-hall/.claude-plugin/plugin.json`: bump `version` (current `0.46.0` → `0.47.0`), and in the existing `description`, alongside the sentence that mentions the opt-in `mcp-reaper` companion, add a parallel sentence for the opt-in `devswarm-supervisor` companion (dormant unless `DEVSWARM_REPO_ID` is set AND explicitly installed; macOS/Linux full, Windows detection-only; claude-code#39755 workaround).

- [ ] **Step 5: Codex mirror — README + `.codex-plugin` (parity)**

In `plugins/anti-hall/codex/README.md`, add the same optional-integration note (authored in the Codex/OMX voice, not pasted). If `plugins/anti-hall/codex/.codex-plugin/*.json` enumerates a version or companions, bump/append to match `plugin.json`. Confirm with `grep -rn "reaper\|install-reaper\|version" plugins/anti-hall/codex/`.

> **Parity note (state it explicitly, do NOT add an empty edit):** the companion libs are invoked by the installed background job, NOT by any hook, so there is **no** `hooks.json` / `install-codex.js` / Codex `hooks/hooks.json` manifest change for this feature. The only Codex-side edits are the README + `.codex-plugin` description/version.

- [ ] **Step 6: `CHANGELOG.md` — new version section**

Add a `## 0.47.0` section above `## 0.46.0` summarizing: new opt-in DevSwarm liveness supervisor (detect + confirm-gated recovery for claude-code#39755), pure-Node, fail-open, macOS/Linux full + Windows detection-only, dormant unless `DEVSWARM_REPO_ID` set AND explicitly installed; list the new files; note the test count delta.

- [ ] **Step 7: Sanity + commit**

Run: `grep -rniE "skycrew|<any private consumer/product name>|@.*\\.(com|io|dev)" README.md plugins/anti-hall/README.md llms.txt docs/KB.md CHANGELOG.md plugins/anti-hall/.claude-plugin/plugin.json plugins/anti-hall/codex/README.md`
Expected: only the allowed author identity (`github.com/talas9`, `Mohammed Talas`) — NO private consumer names, emails, or machine paths.

```bash
git add README.md plugins/anti-hall/README.md llms.txt docs/KB.md CHANGELOG.md plugins/anti-hall/.claude-plugin/plugin.json plugins/anti-hall/codex/README.md
# plus any .codex-plugin manifest touched
git commit -m "docs(devswarm): document the optional liveness supervisor across all surfaces; bump to 0.47.0"
```

---

### Task 9: Full-suite + CI gate + live-acceptance verification

**Files:**
- No source files. Produces a verification record (report to the user + an entry in the session history ledger). This is the design's §9 acceptance gate — a **verification pass**, NOT new code. MUST NOT be marked done on unverified claims (`CLAUDE.md`: local-green ≠ CI-green; a subagent "passing" is an unverified claim).

- [ ] **Step 1: Full local suite (authoritative pre-flight)**

Run: `node --test` (from repo root)
Expected: PASS — all suites, including every new file (`devswarm-detect`, `target-session`, `liveness`, `recovery`, `devswarm-supervisor`, `install-devswarm-supervisor`, `doctor-devswarm`) and every pre-existing suite unchanged. Zero failures. Record the summary line (`# pass N / # fail 0`).

- [ ] **Step 2: Acceptance-criteria cross-check (design §9)**

For each design §9 criterion AND each hardening fix, name the test that proves it (do NOT hand-wave):
- wedged detected within one sweep → `liveness.test.js` STALE case + `devswarm-supervisor.test.js` stale-wiring.
- auto-recovered end-to-end, zero false positives on healthy → `recovery.test.js` happy-path + `liveness.test.js` NOT-stale cases.
- **confirm-gate proven (2-candidate wrapper abstains)** → `target-session.test.js` CONFIRM-GATE test.
- **identity-binding: human takeover (interactive `--resume`) not killed; argv uuid ≠ sessionId abstains; missing sessionId abstains** → `target-session.test.js` IDENTITY-BINDING tests.
- **self-exclusion (supervisor pid / its tree never targeted)** → `target-session.test.js` SELF-EXCLUSION tests.
- **TOCTOU re-confirm before EACH signal (pid recycled in grace window → no SIGKILL)** → `recovery.test.js` TOCTOU pre-SIGTERM + pre-SIGKILL tests + `target-session.test.js` `verifyTarget` test.
- no broad kills (single confirmed pid only) → `recovery.test.js` SIGKILL/SIGTERM pid assertions.
- **group-kill (children signaled with the parent, not orphaned)** → `recovery.test.js` happy-path + SIGKILL group assertions.
- single-writer lock + **stale-lock steal (dead holder stolen, live respected)** → `recovery.test.js` live-holder skip test + acquireLock steal test.
- **detached resume never SIGTERM'd on timeout; a timed-out resume never falsely 'alive'** → `recovery.test.js` DETACHED-resume test.
- "No conversation found" handled → `recovery.test.js` escalate test.
- restart-loop guard (escalate after N) → `recovery.test.js` cap test.
- **uuid-scoped liveness (decoy sibling jsonl does not mask staleness)** → `liveness.test.js` uuid-SCOPED test (seeds a fresh decoy sibling; superset of Reviewer finding A).
- **git-activity has NO dir-mtime fallback (no-commits + nested edit ≠ stale)** → `liveness.test.js` P1-15 test (with a contrast assertion proving non-vacuity).
- **id sanitization (traversal id rejected, no path escape)** → `liveness.test.js` isSafeId + livenessPathFor-throws tests + `devswarm-supervisor.test.js` readDescriptors unsafe-id test.
- **ps/lsof timeout → no-data → abstain** → `target-session.test.js` empty-ps (timed-out probe) test.
- **post-recovery cooldown; terminal `escalated` short-circuit** → `liveness.test.js` COOLDOWN + TERMINAL tests.
- **single-flight sweep (overlap coalesced)** → `devswarm-supervisor.test.js` single-flight test.
- **doctor syntax-checks the new libs (broken file FAILs, not vanishes)** → doctor.js §6c syntax loop (exercise by pointing a temp broken copy; verified in Step 3).
- **stuck-recovering escalates to doctor FAIL** → `doctor-devswarm.test.js` stuck-recovering test.
- doctor PASS/WARN/FAIL per workspace → `doctor-devswarm.test.js`.
- fail-open (injected error) → `devswarm-supervisor.test.js` fail-open test + `recovery.test.js` throwing-spawn test.
- Windows never kills → `recovery.test.js` win32 test.
Any criterion without a proving test is a BLOCKER — add the test before proceeding.

- [ ] **Step 3: Live acceptance (macOS or Linux) — end-to-end on a real wedged session**

In a real DevSwarm-style setup (or a constructed one): start a `claude -p --resume <uuid> --dangerously-skip-permissions` from a worktree, publish its descriptor **including the exact `sessionId: <uuid>`**, wedge it (kill the listener but keep the process, or just let it idle past the threshold with a pending inbox line), then run one sweep: `node plugins/anti-hall/companion/devswarm-supervisor.js`. Assert: the verdict goes `stale` → `recovering` (with `recoveredAt` set), exactly one pid was targeted (check `recovery.log`), and the process was resumed from the correct cwd; then after the cooldown window a follow-up sweep re-derives real liveness and the verdict returns to `alive` (a timed-out/unconfirmed resume must NEVER show `alive` before that re-derivation). Then prove the confirm-gate live, THREE ways, each of which MUST write a non-kill verdict and leave every process alive:
- **2-candidate wrapper** — add a `sh -c 'claude -p --resume <uuid>'` sharing the cwd (both headless) → sweep must abstain `multiple-candidates`, NO kill.
- **human takeover** — run an INTERACTIVE `claude --resume <uuid>` (no `-p`) in the cwd → sweep must abstain `interactive-candidate`, NO kill (a person mid-rescue is never evicted).
- **wrong session** — run a headless `claude -p --resume <other-uuid>` in the cwd → sweep must abstain (uuid ≠ published `sessionId`), NO kill.
Record the commands + `recovery.log` contents. If the confirm-gate does not abstain in ALL THREE, this is a BLOCKER — do not ship recovery.

- [ ] **Step 4: CI gate (local-green ≠ CI-green)**

Push the branch; check GitHub Actions: `gh run list --branch <branch> --limit 1` then `gh run view <id>`. Expected: all matrix legs (ubuntu/macos/windows × node 18/20/22/24) green — including the Windows legs, which must prove the supervisor never attempts a kill (the `recovery.test.js` win32 test runs there). Report the run URL + status. Any red leg → iterate; do NOT call the work complete.

- [ ] **Step 5: Record the verification result**

Write the results (suite summary, §9 cross-check, live-acceptance transcript, CI run URL) to the session history ledger (`.anti-hall/history/<date>/<session>.md`) and report them to the user. If any tracked file changed, commit:

```bash
git add -A
git commit -m "chore(devswarm): record liveness-supervisor acceptance + CI results"
```

(If only the gitignored ledger changed, skip the commit and report in the final summary instead.)

- [ ] **Step 6: Release (separate, gated on the above)**

Follow `RELEASING.md` (the launching brief scoped the release as a SEPARATE step): the version bump already landed in Task 8; now commit → push → tag → marketplace propagate → GitHub Release. Agent tags manually; never auto-merge. Do NOT start this until Steps 1–5 are green.

---

## Self-Review

Run against the approved design (`docs/superpowers/specs/2026-07-08-devswarm-liveness-supervisor-design.md`) with fresh eyes.

**1. Spec coverage.** Every design section maps to a task:
- §2 feature-detect helper → **T1**; companion installer → **T6**; doctor extension → **T7**.
- §3 the seam (encoding, argv-uuid, cwd confirm, **identity-binding to the published `sessionId`, headless-only, self-exclusion**, exactly-one confirm-gate, descriptor + verdict shapes) → **T2** (targeting) + restated in the **Interface** section above.
- §4 detection (both-signals-idle AND pending, verdict persist) → **T3**.
- §5 recovery (confirm-gate → precise kill → single-writer → resume-from-cwd → backlog replay → "No conversation found" handling → N-cap escalate → escalate-only fallback) → **T4**; sweep wiring → **T5**.
- §6 config & safety (env kill-switches, fail-open, agnostic) → **T1** (session gate) + **T5** (daemon gate) + fail-open asserted across T2–T5.
- §7 documentation-as-optional (README ×2, llms.txt, plugin.json + Codex mirror, dormant-unless-set-AND-installed) → **T8**.
- §8 platforms (macOS/Linux full, Windows detection-only escalate-only) → **T4** (win32 branch + test) + **T6** (installer no-op) + **T8** (documented).
- §9 acceptance criteria → each mapped to a proving test in **T9 Step 2**; live-acceptance in **T9 Step 3**.
- §10 spike results are baked in as hard requirements: Spike A ("resume from the same cwd") → T4 `spawnResume` cwd + T9 Step 3; Spike B (confirm-gate) → T2 + T9 Step 3.

**2. Placeholder scan.** No "TODO"/"add X here"/"similar to Task N"/"fill in" anywhere. Every implementation step contains complete, runnable code; every test step contains real `node:test` assertions; the doc task shows full section text plus concrete grep-anchored insertion points; commit messages are conventional with NO self-credit trailer.

**3. Type consistency (checked across tasks).**
- **Descriptor** `{ id, worktreePath, inboxPath, cursorPath, sessionId }` — identical in the Interface section, T3 (`computeLiveness` reads `descriptor.worktreePath/inboxPath/cursorPath/sessionId`), T4 (`recover` reads `worktreePath`/`inboxPath`/`cursorPath`/`sessionId` — the last for the fresh re-confirm), T5 + T7 (`readDescriptors` requires `worktreePath`+`sessionId`+`isSafeId(id)`). `sessionId` is the identity binding threaded T5 → T2 `findTarget` → T4 `verifyTarget`.
- **Verdict** `{ status, lastOutboundTs, staleSince, recoveries, recoveredAt }` with `status ∈ alive|stale|recovering|ambiguous|escalated` — produced by T3 `computeLiveness` + `writeVerdict`, re-persisted by T4 `persistVerdict` (same keys; carries prior `lastOutboundTs`/`staleSince`/`recoveredAt`), classified by T7 `statusForVerdict`. `recoveries` is the single persisted counter both T3 (reads prior) and T4 (increments on a resume, escalates at ≥ cap) agree on. `recoveredAt` is written by T4 on a successful resume and read by T3 (cooldown) + T7 (stuck-recovering FAIL). `escalated` is terminal (T3 short-circuit).
- **Target** `{ pid, uuid, worktreePath }` (confirmed) | `{ ambiguous, reason, candidates }` (abstain) — produced by T2 `findTarget`, consumed by T4 `recover` (`target.ambiguous`/`target.pid`/`target.uuid`) and T5 (passes `findTarget` result straight into `recover`). `verifyTarget` (T2) reuses the SAME confirm-gate for the T4 TOCTOU re-confirm, so a re-derivation cannot diverge from the original selection logic.
- **Recovery result** `{ action ∈ abstain|escalate|skip|resumed|error, ... }` — T4 return shape, asserted by T4 tests and surfaced by T5. (`abstain` now also covers a mid-recovery identity change.)
- **Encoding** `encode = replace(/[/.]/g, '-')` — defined once in T2 `encodeWorktreePath`, re-exported via T3 `projectDirFor`, used by T7 self-test. No decode path anywhere (forward-only, per §3).
- **id safety** — `isSafeId` defined once in T3 (`liveness.js`), imported by T4 (`lockPathFor`), T5 + T7 (`readDescriptors`); `livenessPathFor`/`lockPathFor` throw on an unsafe id as a belt-and-suspenders backstop to the readDescriptors drop.
- **Env gates** — session gate `isDevswarmActive` (T1: off/on/auto+DEVSWARM_REPO_ID) vs daemon gate `supervisorEnabled` (T5: off/hard-kill only). Deliberately different (documented in both), because DEVSWARM_REPO_ID is a per-session var absent in the daemon.
- **Lock shape** — per-workspace lock (T4 `acquireLock`) and the single-flight sweep lock (T5 `acquireSweepLock`) both store `{pid, ts, token}` and share the dead-holder/stale-steal + own-token-release semantics.

**4. Private-names re-grep.** The plan text uses only generic terms ("consumer", "DevSwarm", `DEVSWARM_REPO_ID`) and the allowed author identity. Code/docs carry no private consumer/product/submodule names, no emails, no machine paths (T8 Step 7 enforces this with a grep before commit). This plan file itself was grepped clean of private names before hand-off.

## Explicit choices made where the design allowed latitude

- **Two separate env gates** (`isDevswarmActive` for sessions, `supervisorEnabled` for the daemon) rather than one — because `DEVSWARM_REPO_ID` is a per-session var absent in a launchd/systemd job. The daemon activates on descriptor presence; the session gate follows `DEVSWARM_REPO_ID`. Flagged so a reviewer can veto if a single unified gate was intended (it would make the daemon a permanent no-op).
- **Cursor format** — the design says "unread entry past `cursorPath`" without pinning a format. Chosen: a bare integer OR `{"line":N}` = consumed-line count over an NDJSON inbox, with unparseable/absent → `known:false` → NOT pending (fail-safe: never nominate an unreadable workspace for a kill). Documented in the Interface section as part of the seam the consumer must honor; flagged for the reviewer since it constrains the consumer.
- **Both-signals-idle via `max()`** — `(now - max(tMtime, wMtime)) > idle` with a `haveBoth` guard is exactly "both signals present and each idle"; a missing signal → not stale. Faithful to §4 and fail-safe.
- **Git-activity signal is git-commit-time only, no dir-mtime fallback** (P1-15) — the second independent signal must be a REAL activity reading. A worktree directory mtime does not change when files nested under it are edited, so falling back to it would produce a permanently-idle second signal (collapsing the two-signal safeguard to transcript-only and enabling false positives). No commits yet / git unavailable → the signal is UNKNOWN (`null`) → `haveBoth` is false → NOT stale. This narrows detection for commit-less worktrees, deliberately, in the fail-safe direction.
- **`recoveries` increments on a resume launch** (not on abstain/escalate/skip) — so the N-cap counts real recovery attempts that ran to a resume, and repeated abstains never exhaust the budget. Escalate fires at `recoveries ≥ cap` on the next stale reading. The resulting verdict is `recovering` (+`recoveredAt`), NOT `alive`: a detached resume's true liveness is unknowable synchronously, so the next post-cooldown sweep re-derives it — never a false-positive `alive` (P0-4).
- **`sessionId` is a REQUIRED consumer-published field** (identity-binding, P0-1) rather than derived — the only robust defense against killing a human takeover or a colliding unrelated `claude`. It is a consumer-side addition, flagged for the reviewer since it constrains the seam; without it the supervisor abstains (never guesses).
- **Headless-only targeting** — a candidate must carry `-p`/`--print`; a lone interactive `--resume` (a person mid-rescue) is abstained, never killed (P0-1c). This trades away the ability to recover an interactive session (by design: those have a human present).
- **`owedReport` removed** (P1-9) — it was accepted by `computeLiveness` but never wired from the sweep (a dead half-signal). Pending is now decided solely by the unread NDJSON backlog past the cursor — data anti-hall can itself verify — not an unverifiable consumer claim. This narrows detection to backlog-driven staleness, which is the fail-safe direction.
- **Post-recovery cooldown + terminal `escalated`** (P2-10/P2-13) — a just-resumed workspace is held `recovering` for `cooldownMs` (default 10 m) so it cannot burn its whole N budget in minutes, and an `escalated` verdict is sticky (no endless re-targeting). Both are time/status short-circuits in `computeLiveness`, keeping the sweep cheap and loop-free.
- **Group-kill via POSIX negative-pid** (P0-5) — signals the wedged child's process group so its MCP grandchildren are cleaned up instead of reparenting to PID 1 (the repo's documented orphan class). The single-pid confirm-gate still selects WHICH group; only the cleanup is broadened, never the targeting.
- **Stale-lock steal + single-flight sweep lock** (P0-3/P2-11) — both locks steal a dead-holder or TTL-stale lock (mirroring `swarm-guard`) so a crash mid-recovery, or an overlapping cron tick, cannot permanently wedge recovery; a live fresh holder is always respected.
- **doctor check extracted into `companion/lib/doctor-devswarm.js`** and required by `doctor.js` (mirrors the flutter-debug `preflight.js` pattern already in doctor §6b) — makes the check unit-testable and keeps `doctor.js` a thin renderer. `doctor.js` also explicitly `node --check`s the new libs (P2-12) since they are not in `hooks.json` and would otherwise let a syntax error vanish.
- **No manifest/parity edit** — the companion libs run under the installed job, not a hook, so `hooks.json` / `install-codex.js` / Codex `hooks/hooks.json` are untouched. Called out explicitly in T8 so the dual-platform-parity mandate is satisfied by documentation parity, not an empty code edit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-devswarm-liveness-supervisor.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session via superpowers:executing-plans, with checkpoints.

Which approach?
