<!-- APPROVED 2026-07-06 (user) after a 5-round deadly-loop: R5 = GO(Sonnet Reviewer)+GO(Opus Auditor); Codex seat's concurrency concern independently reproduced+resolved by both flagships, residual routed to plan-phase §8. -->
# Design — DevSwarm-aware workspace-tier orchestration for anti-hall

**Status:** ✅ **APPROVED** 2026-07-06 (user), after a 5-round deadly-loop (both flagship seats GO;
Codex's concurrency concern independently reproduced + resolved by both flagships, the one residual —
concurrent WP-coordinators per repo — routed to the §8 plan-phase items). Ready for the implementation
plan. History of R1-R4 fixes below. R3 fixes: corrected the inverted skip-guard
`DESTRUCTIVE` instruction (must ADD devswarm-guard, not omit); key merge selection on `fromBranch`
(anti-spoof); reframed §7 merge safety on git atomicity (stale check-merge → surfaced conflict, not
corruption) + atomic `children.json` write; added a total workspace cap + error-handling→needs-attention;
documented the static-guard alias-evasion limit; lazy-require + cross-manifest parity test. **Task:** #5. **Brief:**
[`docs/KB-devswarm-hivecontrol.md`](../../KB-devswarm-hivecontrol.md) §8 (DevSwarm facts verified —
CLI v2.3.3 executed live; role detection probed on a real Primary + child).

> **Round 1 fixes folded in (3/3 HOLD → this revision):** corrected the false "guards gate the
> merge" claim (§8); added an explicit concurrency & safety model (§7); renamed the tiers to avoid
> the L1/L2 collision with the skill's in-process hierarchy (§4); fixed the Codex registration target
> to `install-codex.js` and acknowledged the Codex skill is a stub needing real authoring (§5.2/§5.3/§6);
> guard now reuses `git-guard.js`'s tokenizer, fails **closed** in a confirmed child, and drops the
> permanent env escape-hatch for the TTL'd `skip-guard.js` pattern (§5.3); added `worktreePath` +
> cwd-scoping (§5.5/§5.2), app-down fallback + orphan bounding (§5.2/§7), graphify `SessionStart`
> defensive role-gate (§5.4), corrected `hooks/hooks.json` path (§6).

## 1. Problem & goal

anti-hall's `orchestration` skill fans work out only *in-process* (Workflow tool + subagents in one
session). When anti-hall runs **inside DevSwarm** (each workspace = an isolated git worktree + its
own agent), the top-level agent should additionally fan out across **sibling child workspaces** —
real process/branch/app isolation — and coordinate them.

**Goal:** make `orchestration` **workspace-topology-aware** — pick the fan-out primitive by *where it
runs*, add nothing when not in DevSwarm, work identically for a Claude (OMC) or Codex (OMX) agent.

## 2. Verified facts this design rests on (from the KB)

- **Inside DevSwarm?** `DEVSWARM_REPO_ID` is set. (`hivecontrol health` exit 0 = app reachable only —
  necessary, not sufficient — NOT a role signal.)
- **Primary vs child?** `DEVSWARM_SOURCE_BRANCH` **empty ⇒ Primary**, **non-empty ⇒ child** (verified
  live). `DEVSWARM_SPAWNED` is `1` on both — NOT a role signal.
- **Engine:** `DEVSWARM_AI_AGENT` (`claude`→OMC; `codex`→OMX).
- **Coordination = async message-passing**, JSON out: `create / message-child / message-parent /
  read-messages / message-count / monitor / check-merge / merge-into-source`. `monitor` **blocks**.
  `read-messages`/`message-count` act on the **current** workspace (cwd); `check-merge` /
  `merge-into-source` are **cwd-scoped git ops — run from the child's worktree dir**; `info [branch]`
  returns that dir as `worktreePath`.
- **`check-merge` is a dry-run** (`git merge-base`+`merge-tree`); `merge-into-source` is a real
  `git merge` **run inside the `hivecontrol` binary subprocess** (⇒ invisible to anti-hall Bash hooks).
- **`graphify-out/` and `.anti-hall/` are gitignored** (`.gitignore:13`, `:6`) → a child worktree has
  no graph dir; child graph deltas can't merge.
- **No CLI teardown:** delete/archive a workspace is GUI-only (verified live — archive keeps the
  worktree + branch + on-disk dir; only delete removes files).

## 3. Decisions (user — fixed, not up for redebate)

- **Rollout = FULL AUTONOMOUS.** The Primary creates, briefs, monitors, and merges children with no
  happy-path confirmation gates. Conflicts, timeouts, and teardown are **surfaced**, never silently
  resolved.
- **Coordination loop = ScheduleWakeup backoff poll** (2→10 min) off a gitignored state file — NOT the
  blocking `monitor` on the main thread.

## 4. The two workspace tiers (named to avoid the L1/L2 collision)

> `orchestration/SKILL.md` already uses **L1/L2/L3** for the *in-process* subagent hierarchy. This
> feature adds an ORTHOGONAL **workspace** tier — named **Workspace-Primary (WP)** / **Workspace-Child
> (WC)** so an implementer never conflates workspace-nesting rules with subagent-nesting rules.

| Tier | Role (detect via §2) | Fan-out | Creates child workspaces? |
|---|---|---|---|
| **WP** | **Primary** (`SOURCE_BRANCH` empty) | child workspaces via `hivecontrol` **and** the in-process L1/L2/L3 tiers | ✅ yes |
| **WC** | **Child** (`SOURCE_BRANCH` set) | in-process L1/L2/L3 only — a full sub-orchestrator, identical to WP behavior | ❌ **no** (deferred future: 1 nested level, disabled by default) |

**WC = a full sub-orchestrator** (creates workflows, keeps a sub-task-list, delegates, never works
directly) — identical to WP **except** it (a) does not update graphify and (b) does not create child
workspaces. **Only WP** creates hive workspaces. The **no-child-of-child** rule is the workspace-level
twin of the skill's existing anti-deep-nesting rule.

## 5. Components

### 5.1 Role-detection helper — `hooks/lib/devswarm-role.js` (new)
Pure Node, no deps, fail-open. `detect(env = process.env)` →
`{ inside, role: 'primary'|'child'|null, agent, sourceBranch }`. Rules: `inside = !!env.DEVSWARM_REPO_ID`;
`role = inside ? (env.DEVSWARM_SOURCE_BRANCH ? 'child' : 'primary') : null`. **Verified correct** by
Round 1 (empty-string and unset `DEVSWARM_SOURCE_BRANCH` are both falsy ⇒ Primary). **Pathological
guard:** if `inside` but `DEVSWARM_SOURCE_BRANCH` is a non-string / control-char garbage, treat role
as `null` (unknown) ⇒ callers take the safe path (§5.2 falls back to in-process; §5.3 fails **closed**).

### 5.2 `orchestration/SKILL.md` (Claude) + an OMX-native section in the Codex skill — "DevSwarm workspace tier"
- **WP (autonomous), only when `role==='primary'` AND `hivecontrol health` exits 0** (app up); else →
  in-process fallback (no workspace tier). For each large, independent, app-running chunk:
  `hivecontrol workspace create <branch> -a $DEVSWARM_AI_AGENT -p "<brief>" -t "<title>"`, then
  **capture `worktreePath`** from the create JSON (fallback `workspace info <branch>`). Record
  `{branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt}` in
  `.anti-hall/devswarm/children.json`. The brief tells the child: you are a WC sub-orchestrator, keep a
  sub-task-list, delegate, **do not run graphify**, **do not create child workspaces**, `message-parent`
  at milestones and, when done, a **structured ready signal** whose first line is the parseable marker
  `ANTIHALL-READY <branch>` (not freeform prose) so WP detects completion deterministically.
  - **Caps (two).** `maxActive` (default 4; configurable field, e.g. `.anti-hall/devswarm/config.json`):
    a `needs-attention` child (conflict/timeout) is surfaced immediately and **excluded from the ACTIVE
    count** so it can't wedge fan-out — WP keeps progressing other work. AND `maxTotal` (active +
    needs-attention, default 12): on hit, WP **halts new creation** and surfaces "resolve/delete stuck
    workspaces in the app before continuing." (The active-cap exclusion alone does NOT bound total disk
    growth — teardown is GUI-only, §6 — so the total cap is the real orphan bound.)
  - **Poll (ScheduleWakeup, 2→10 min backoff):** from the **Primary's own cwd** run `message-count`
    (cheap peek) → `read-messages` (reads WP's inbox — children message the parent, so no `cd`). For
    each `read-messages` entry whose **`fromBranch`** matches a recorded child AND whose body's first line
    is `ANTIHALL-READY`: select the child by **`fromBranch`** (the CLI-authoritative field — NOT by parsing
    the free-text marker token; a marker-token vs `fromBranch` mismatch is `needs-attention`, never silently
    reconciled; a READY entry whose `fromBranch` matches NO recorded child → surface as `needs-attention`,
    never silently ignored), run the merge ops with a **scoped** `cd "<worktreePath>" && hivecontrol …`
    (never a persistent session `cd` — `message-count`/`read-messages` always run from WP's own cwd):
    `check-merge` **immediately** → only if
    `isMergeable && !hasConflicts && targetDirectoryClean` → `merge-into-source`. **Merge one child at a time
    (serialized);** after each merge, the next child's `check-merge` is re-run fresh against the new `main`.
    On conflict / `WORKING_DIRECTORY_NOT_CLEAN` / poll-timeout — **or any `hivecontrol` call that errors**
    (non-zero / error JSON / app died mid-op; the health check is a pre-filter, not a guarantee) — **surface
    to the user**, mark the child `needs-attention`, do not auto-resolve, never crash the loop.
  - After **all** children merged → run graphify once (WP only). **Teardown:** list every workspace WP
    created and **surface** "delete these in the DevSwarm app" (no CLI teardown).
- **WC:** identical to today's in-process orchestration, minus graphify update, minus workspace creation.
- **Fallback:** `!inside || role !== 'primary' || health!=0 || role===null` → byte-for-byte today's
  behavior. No hard dependency on DevSwarm.
- **Codex/OMX:** the Codex orchestration skill (`codex/skills/anti-hall-orchestration/SKILL.md`) is
  currently a 26-line stub with none of the tier/heartbeat/poll scaffold. This is **not a paste** — the
  plan must author an **OMX-native** version of this section (workspace tier + WC=`omx team`), sharing
  only the platform-identical `hivecontrol` calls. Flag as its own plan phase.

### 5.3 No-child-child guard — `hooks/devswarm-guard.js` (new, PreToolUse / matcher Bash)
- **First executable line:** `if (!process.env.DEVSWARM_REPO_ID) process.exit(0);` — before any stdin
  read — so it is a true no-op (zero parse cost) for the 99% non-DevSwarm case.
- **VENDOR a focused command-parser** into devswarm-guard.js (tokenizer / verb-resolution /
  segment-split / wrapper+quote+`eval`+cmd-subst unwrapping) — NOT a naive regex, and **NOT** a
  `require` of `git-guard.js` (verified: it has **no `module.exports`**; the established repo pattern is
  each guard vendors its own copy — command-guard/git-guard/graphify-guard/merge-gate/model-routing-guard
  all do). **Do NOT modify git-guard.js.** Detect a `hivecontrol|devswarm` invocation whose subcommand is
  `workspace create` (must NOT false-positive on `message-child`, echo/heredoc/quoted payload text, or the
  create token inside a message argument). (Optional future DRY, out of scope: extract a shared
  `hooks/lib/cmd-parse.js` that the guards then require.)
- **Fire only when `detect().role === 'child'`.** Then: block `workspace create`. **Fail CLOSED** — if
  role is `child` (or `null`/unknown while `inside`) and the command is create-ish but unparseable,
  **block** (a child must never silently spawn a grandchild). Emit the standard anti-hall block JSON.
  **Stated limit:** like every static Bash guard here (git-guard included), it cannot defeat arbitrary
  `alias`/shell-function indirection (`alias hc='hivecontrol workspace create'; hc x`) — post-expansion
  tokens aren't visible to a static parser. The guard is a strong default, not a sandbox; the real
  containment is the WC brief (a child does not create workspaces) + nesting disabled by default.
- **No permanent env escape-hatch.** Nesting stays fully disabled in this version. If a future nested
  level needs a one-off override, use the existing TTL'd `skip-guard.js` (`~/.anti-hall/skip.json`)
  mechanism `git-guard.js`/`merge-gate.js` already share — auto-expiring, per-guard consent — never a
  never-expiring env var. (Rationale: enabling create-in-child today spawns an **unmonitored** orphan,
  since only WP runs the poll loop.) The no-child-child rule is STRUCTURAL safety, so `devswarm-guard`
  must be **ADDED to skip-guard's `DESTRUCTIVE` set** → `DESTRUCTIVE = new Set(['git-guard', 'devswarm-guard'])`
  (verified `skip-guard.js:34,50-53`: a guard resists the blanket `all` skip **only if it IS in `DESTRUCTIVE`**;
  git-guard gets its guard-specific-only skip resistance the same way). This makes a routine blanket `all`
  skip UNABLE to silently disable devswarm-guard (only a guard-specific `devswarm-guard` token can skip it).
  **`skip-guard.js` is therefore a touched file** (§6). For the membership to take effect, devswarm-guard
  MUST call `isSkipped('devswarm-guard')` at startup (the `git-guard.js:763-764` pattern) — the `DESTRUCTIVE`
  add alone is inert without the call site.
- **Registration — 3 LIVE manifest surfaces (ALL required):** (1) `plugins/anti-hall/hooks/hooks.json`
  (Claude); (2) `plugins/anti-hall/codex/install-codex.js`'s `ANTI_HALL_HOOKS.PreToolUse` (add `group('Bash', ['devswarm-guard.js'], …)`)
  — the script-install path that writes `.codex/hooks.json`; (3) `plugins/anti-hall/codex/hooks/hooks.json`
  — the **live** marketplace-plugin manifest (`.codex-plugin/plugin.json` `"hooks": "./codex/hooks/hooks.json"`;
  hand-maintained, nothing regenerates it, no sync test). **Skipping (3) silently ships zero guard to Codex
  plugin-install users — a dual-platform-parity violation.** Add a test asserting all three carry devswarm-guard.
- Pure Node, OS-agnostic.

### 5.4 graphify suppression
- Early-exit **both** graphify hooks when `detect().role === 'child'`: `graphify-reminder.js` (the Stop
  "run graphify update" nudge) **and** `graphify-session.js` (defensive — the KB-verified default is
  that a child worktree lacks the gitignored `graphify-out/` so it already no-ops, but a future
  `worktreeInclude` entry or a fork committing `graphify-out/` would silently re-enable the primer;
  the role-gate makes suppression robust regardless).
- Skill guidance additionally instructs WC agents not to run graphify.
- **Fail-open require:** both graphify hooks must **lazy-require `./lib/devswarm-role.js` INSIDE their
  `main()`** (already wrapped in try/catch — e.g. `graphify-session.js:127-131`), NOT at top-level (its
  top-level requires at `:19-21` sit OUTSIDE the try, so a missing helper on a partial rollout would crash
  SessionStart for EVERY project). With the lazy-require, non-DevSwarm regression = none.

### 5.5 State file — `.anti-hall/devswarm/children.json` (gitignored)
`[{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }]`. Under the
already-gitignored `.anti-hall/` (no collision — `progress-prune.js` scopes only to `progress/`+
`history/`). **Single writer = the coordinator** (see §7). Each mutation re-reads `children.json`, applies
its delta, then **atomic-writes** (temp file + `fs.renameSync`, same dir/FS) — a fresh read + a torn-file-proof
write. **The actual guarantee against a lost-update race is single-threadedness** (§7): the coordinator loop
never runs two mutations at once, so there is no concurrent read-modify-write to lose. (Honest note: lockless
RMW by itself does NOT defeat a lost-update race *under true concurrency* — the single-threaded runtime does;
if the coordination substrate ever becomes concurrent (a background-subagent poll instead of ScheduleWakeup),
add an advisory lockfile via atomic `fs.openSync(path, 'wx')`.) `worktreePath` is mandatory — the merge ops need it to `cd`.

### 5.6 Tests — `tests/hooks/` (`node:test`, zero-dep)
- `devswarm-role`: truth table incl. empty-string & unset `DEVSWARM_SOURCE_BRANCH` ⇒ Primary; garbage ⇒ null.
- `devswarm-guard`: **first-line no-op when `DEVSWARM_REPO_ID` unset**; blocks `workspace create` in a
  child; allows in Primary; **fails closed** on unparseable create-ish in a child; does NOT false-positive
  on the non-create `hivecontrol` subcommands a WC child actually runs — especially **`message-parent`**
  (its ready signal) plus `message-child`/`read-messages`/`check-merge` — nor on `echo "… workspace create …"`,
  heredoc/quoted payloads, `devswarm` alias, multi-command (`x && hivecontrol workspace create y`),
  env-prefixed, `eval`-wrapped. (Fail-closed ⇒ the real hazard is **over-blocking** a child's legit command.)
- **Cross-manifest parity invariant:** assert the `PreToolUse` guard set **filtered to `matcher==="Bash"`**
  is IDENTICAL across all 3 live manifests (`hooks/hooks.json`, the `install-codex.js` `ANTI_HALL_HOOKS`
  output, `codex/hooks/hooks.json`). Scope to Bash ONLY — the *full* PreToolUse sets legitimately diverge
  (Codex manifests lack the Claude Write/Edit/Grep/Glob/Agent/Task guards); a naive all-PreToolUse compare
  would false-fail. A GENERAL invariant (not devswarm-guard-specific) so any future 1-of-3 drift is caught.
  Extend the existing manifest readers in `tests/codex/install-codex.test.js` / `tests/hooks/model-routing-guard.test.js`.
- `graphify-reminder` + `graphify-session` gates: skip in child (`DEVSWARM_SOURCE_BRANCH` set); unchanged in Primary.
- `skip-guard`: `devswarm-guard` in `DESTRUCTIVE` ⇒ a blanket `all` skip does NOT disable it (only a
  guard-specific token does).

## 6. Blast radius & non-goals

**Additive; zero behavior change outside DevSwarm** (verified: every path gated on `DEVSWARM_REPO_ID`;
non-DevSwarm graphify path is a true no-op; agnostic mandate not breached; no `.anti-hall/` collision).
**Touches:** `orchestration/SKILL.md`; the Codex orch skill (real OMX authoring, not a paste); 1 new
helper (`hooks/lib/devswarm-role.js`); 1 new hook (`devswarm-guard.js` — vendors its own parser, does
**not** modify git-guard.js); 3 edited hooks (`graphify-reminder.js` + `graphify-session.js` — both
lazy-requiring the helper — and `skip-guard.js` — add `devswarm-guard` to `DESTRUCTIVE`); **3 live
hook-manifest surfaces** — `plugins/anti-hall/hooks/hooks.json`, `install-codex.js` (`ANTI_HALL_HOOKS`),
and `plugins/anti-hall/codex/hooks/hooks.json`; tests. **Non-goals:** nested child-of-child (future,
skip-guard-gated); automated teardown (GUI-only); changing DevSwarm.

## 7. Concurrency & safety model (resolves the Round-1 P0s)

- **`children.json` — single-writer, single-threaded, atomically written.** The **primary guarantee** is
  single-threadedness: ScheduleWakeup does not spawn a parallel thread — it re-enters the SAME coordinator
  loop as a later turn, so two `children.json` mutations never run concurrently ⇒ no lost-update race. On
  top of that, each mutation re-reads then atomic-renames (§5.5) — fresh state + no torn file. **Honest
  caveat:** lockless read-modify-write does NOT by itself defeat a lost-update race under true concurrency;
  the single-threaded runtime is what does. If that substrate ever changes (a concurrent background poller),
  an advisory lockfile is required (§5.5). Child workspaces never write `children.json` (coordinator-owned).
- **Merge safety rests on git, not a lock.** `merge-into-source` runs a real `git merge`, which is
  **atomic and conflict-detecting — it cannot corrupt `main`**; the worst case is a merge conflict, which
  is surfaced. `check-merge` is a *pre-filter optimization* (skip known-bad merges), NOT a correctness
  guarantee: if a child commits after `ANTIHALL-READY`, or a sibling advanced `main` in between, a stale
  `check-merge` at worst yields a conflict caught by the real merge and surfaced (→ `needs-attention`). To
  shrink the window: merges are serialized (one at a time), `check-merge` is re-run immediately before each
  `merge-into-source`, selection is keyed on `fromBranch`, and the child is briefed to stop committing at
  `ANTIHALL-READY`. That barrier is **advisory** (we can't freeze a child's worktree) — but because git
  merge is safe, an ill-behaved child causes a surfaced conflict, never corruption.
- **Autonomous merge to `main` — honest backstop.** anti-hall Bash guards **cannot** gate
  `merge-into-source` (its `git merge` runs inside the hivecontrol subprocess; `merge-gate.js` matches
  only `gh`/`git` verbs and is default-off). The real, sufficient backstop is `check-merge`'s
  `isMergeable && !hasConflicts && targetDirectoryClean` precondition, enforced by the loop, plus
  surfacing every conflict. **Optional hardening (plan may include):** extend `merge-gate.js` to
  recognize `hivecontrol … merge-into-source` and enable it for DevSwarm, for a visible audit line.
- **Orphan safety.** The N-concurrent cap bounds growth; teardown is surfaced (GUI-only). The poll
  reconciles `children.json` against `hivecontrol workspace list children` each cycle; a child that has
  vanished (GUI delete/archive — documented) or otherwise can't be matched is marked `needs-attention`
  and surfaced, never silently retried. (GUI branch-*rename* is undocumented/unverified in DevSwarm —
  treat any unexpected list mismatch as needs-attention.)

## 8. Risks & open items (for the plan)

- **Autonomous merge is irreversible-ish** — mitigated by git-merge atomicity + check-merge pre-filter +
  serialization + surfacing (§7); no hook-level backstop exists (stated honestly). A `merge-into-source`
  that fails for a non-conflict reason (hivecontrol subprocess crash mid-merge) is treated like any errored
  call: child → `needs-attention`, surfaced; the coordinator re-checks state next poll, never assumes success.
- **OMX/`-a codex` child path is unproven live** — the plan's first phase must validate a real Codex
  child end-to-end before relying on it (acceptance criterion, not an assumption).
- **Merge-safety axiom unproven live** — §7's "git merge is atomic, cannot corrupt `main`" rests on
  `merge-into-source` behaving as a plain `git merge`, verified only from `--help`, never exercised under a
  real conflict (it wraps a closed compiled binary). Since this axiom is load-bearing for FULL AUTONOMOUS
  (§3), the plan's phase 1 MUST include an acceptance test: deliberately induce a conflicting
  `merge-into-source` and confirm `main` is left unmodified/uncorrupted (alongside the two proof items above).
- **Single-coordinator assumption + concurrent WP** — the `children.json` no-lost-update guarantee rests on
  exactly ONE active WP coordinator per repo (single-threaded loop). Two simultaneous WP-role sessions on
  the same repo (both detecting `role==='primary'`) are an **assumed-away non-goal for v1** — nothing here
  prevents it, and it would reintroduce a true cross-process lost-update race on `children.json` (bounded:
  gitignored coordination metadata, not git state; the per-cycle reconcile against `workspace list children`
  self-heals drift). The plan must EITHER document this as an explicit non-goal OR add a single-coordinator
  lock (PID/lockfile via atomic `fs.openSync(path,'wx')` + stale reclaim) as a phase-1 item. (Raised by both
  flagship seats in Round 5; routed to the plan, not a design-round blocker.)
- **Codex orch skill is a stub** — authoring the OMX-native workspace-tier section is real work, its own
  phase; do not treat as a mirror-paste.
- **Poll latency** (2→10 min) is acceptable for workspace-scale (minutes-to-hours) work.
