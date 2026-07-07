# DevSwarm-aware Workspace-Tier Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make anti-hall's `orchestration` skill workspace-topology-aware so a top-level agent running *inside DevSwarm* fans work out across sibling child workspaces (real process/branch/app isolation) and coordinates them autonomously — while adding **zero** behavior change anywhere outside DevSwarm.

**Architecture:** A pure-Node role-detection helper reads DevSwarm's env vars to classify the current workspace as Workspace-Primary (WP) or Workspace-Child (WC). A new fail-CLOSED `devswarm-guard` PreToolUse hook (vendoring git-guard's command parser) stops a child from spawning grandchildren; the two graphify hooks role-gate themselves off in a child; and the two orchestration skills (Claude + Codex) gain a "DevSwarm workspace tier" section describing the autonomous create → poll → serialized-merge → surface loop. Coordination state lives in a single-writer, atomically-written gitignored `.anti-hall/devswarm/children.json`.

**Tech Stack:** Pure Node.js built-ins only (`fs`, `path`, `os`, `child_process`) — no dependencies. Tests use `node:test` + `node:assert` (zero-dep). Markdown skills. Hook manifests are JSON. Coordination substrate is the `hivecontrol` CLI (invoked from skill guidance, never from a hook).

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the approved design (`docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md`) and the repo's `CLAUDE.md`:

- **Pure Node built-ins only** in hooks/helpers — no `python3`/`jq`/`sed`/`grep`, no npm deps.
- **OS-agnostic / cross-platform** — no POSIX-only constructs; use `path`, cross-platform `basename`, `fs.renameSync` for atomicity.
- **Hooks fail OPEN** on any envelope read/parse error (never wedge unrelated work) — with ONE scoped exception: `devswarm-guard` fails **CLOSED** only when it has a parsed command string that is create-ish-but-unparseable AND the role is `child`/`null`-while-inside (a child must never silently spawn a grandchild). Envelope-level errors (unreadable stdin, malformed JSON) still fail OPEN.
- **`node:test` zero-dep** — tests spawn hooks via `tests/helpers/spawn-hook.js` or require modules directly; fake HOME via `tests/helpers/fixtures.js` `makeHome()`.
- **Feature-detect `DEVSWARM_REPO_ID`** — nothing changes outside DevSwarm. `devswarm-guard`'s FIRST executable line is `if (!process.env.DEVSWARM_REPO_ID) process.exit(0);` (before any stdin read). The graphify role-gates lazy-require the helper INSIDE `main()` so a partial rollout never crashes a non-DevSwarm session.
- **No self-credit in commits** — commit messages carry NO `Co-Authored-By` trailer and NO "Generated with <AI>" line (git-guard blocks these; the human is the author).
- **Public-repo-agnostic** — no private names/paths/emails in shipped files (author credit `Mohammed Talas / talas9` is the only allowed identity).
- **`node --test` from repo root** is the authoritative check (CI matrix = ubuntu/macos/windows × node 18/20/22/24). Local green ≠ CI green: after the final task, CI must be checked before calling the work done.
- **Dual-platform parity** — every hook-manifest change lands in all 3 live surfaces (Claude `hooks.json`, `install-codex.js` generator, Codex live `hooks/hooks.json`); every skill change covers Claude AND the Codex/OMX mirror.

---

## File Structure

**New files (each has one responsibility):**

- `plugins/anti-hall/hooks/lib/devswarm-role.js` — pure role-detection: `detect(env)` → `{ inside, role, agent, sourceBranch }`. The single source of truth every other component reads.
- `plugins/anti-hall/hooks/devswarm-guard.js` — PreToolUse/Bash hook: block `hivecontrol workspace create` when the current workspace is a child. Vendors its own command parser (does NOT modify or require git-guard.js).
- `plugins/anti-hall/hooks/lib/devswarm-children.js` — atomic single-writer read/modify/write helper for `.anti-hall/devswarm/children.json` (the WP coordinator's state).
- `tests/hooks/devswarm-role.test.js` — truth-table unit tests for the role helper.
- `tests/hooks/devswarm-guard.test.js` — behavioral spawn tests for the guard (first-line no-op, child block, primary allow, fail-closed, no-false-positive matrix, skip hatch, fail-open).
- `tests/hooks/skip-guard.test.js` — asserts `devswarm-guard` ∈ `DESTRUCTIVE` and that a blanket `all` skip does NOT disable it.
- `tests/hooks/manifest-parity.test.js` — cross-manifest invariant: the `matcher==="Bash"` PreToolUse guard set is identical across all 3 live manifests, and all 3 carry `devswarm-guard.js`.
- `tests/hooks/devswarm-children.test.js` — unit tests for the children.json RMW helper (round-trip, append, atomicity, corrupt-file recovery).
- `tests/skills/devswarm-skill.test.js` — structural assertions that both orchestration skills contain the DevSwarm workspace-tier section with its load-bearing markers.

**Modified files (one responsibility each):**

- `plugins/anti-hall/hooks/skip-guard.js:34` — add `devswarm-guard` to the `DESTRUCTIVE` set.
- `plugins/anti-hall/hooks/graphify-reminder.js` (inside `main()`, after `cwd` is computed ~:160) — child role-gate: early-exit when `detect().role === 'child'`.
- `plugins/anti-hall/hooks/graphify-session.js` (inside `main()`, after payload parse ~:83) — child role-gate: early-exit when `detect().role === 'child'`.
- `plugins/anti-hall/hooks/hooks.json` (PreToolUse) — register `devswarm-guard.js` (matcher Bash).
- `plugins/anti-hall/codex/install-codex.js:49-54` (`ANTI_HALL_HOOKS.PreToolUse`) — add `group('Bash', ['devswarm-guard.js'], 10)`.
- `plugins/anti-hall/codex/hooks/hooks.json` (PreToolUse) — register `devswarm-guard.js` (matcher Bash).
- `plugins/anti-hall/skills/orchestration/SKILL.md` — append the "DevSwarm workspace tier (WP / WC)" section.
- `plugins/anti-hall/codex/skills/anti-hall-orchestration/SKILL.md` — append an OMX-native "DevSwarm workspace tier" section (authored, not pasted).
- `tests/hooks/graphify-reminder.test.js` / `tests/hooks/graphify-session.test.js` — append role-gate tests.
- `plugins/anti-hall/hooks/verify-first-full.js` (inside `main()`, before `const out = {...}`) — PREPEND a ≤15-line DevSwarm role block (PRIMARY/SUB-ORCHESTRATOR) to `additionalContext`.
- `tests/hooks/verify-first-full.test.js` — append DevSwarm role-block tests.

**Runtime state (created at runtime by skill guidance, NOT by code; under the already-gitignored `.anti-hall/`):**

- `.anti-hall/devswarm/children.json` — `[{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }]`.
- `.anti-hall/devswarm/config.json` — optional `{ maxActive, maxTotal }` overrides (defaults 4 / 12).

---

### Task 1: Role-detection helper (`devswarm-role.js`)

**Files:**
- Create: `plugins/anti-hall/hooks/lib/devswarm-role.js`
- Test: `tests/hooks/devswarm-role.test.js`

**Interfaces:**
- Consumes: nothing (leaf module; reads only its `env` argument, defaulting to `process.env`).
- Produces: `detect(env = process.env) -> { inside: boolean, role: 'primary'|'child'|null, agent: string|null, sourceBranch: string|null }`. Rules: `inside = !!env.DEVSWARM_REPO_ID`; when not inside → `role: null`; when inside and `DEVSWARM_SOURCE_BRANCH` unset/`''` → `role: 'primary'`, `sourceBranch: ''`; when inside and it is a clean non-empty string → `role: 'child'`, `sourceBranch: <that string>`; when inside and it is a non-string OR carries control chars → `role: null`, `sourceBranch: null` (pathological → callers take the safe path). `agent = typeof env.DEVSWARM_AI_AGENT === 'string' ? env.DEVSWARM_AI_AGENT : null`. `module.exports = { detect }`.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/devswarm-role.test.js`:

```js
'use strict';
// devswarm-role: pure role detection from DevSwarm env vars. Truth table incl.
// empty-string & unset DEVSWARM_SOURCE_BRANCH => Primary; control-char/non-string
// garbage => null (unknown). detect() reads only its arg, so these are pure unit
// tests — no spawn, no process.env dependence.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { detect } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-role.js',
));

test('NOT inside DevSwarm: DEVSWARM_REPO_ID unset -> inside=false, role=null', () => {
  const r = detect({});
  assert.strictEqual(r.inside, false);
  assert.strictEqual(r.role, null);
  assert.strictEqual(r.sourceBranch, null);
});

test('Primary: REPO_ID set, SOURCE_BRANCH UNSET -> role=primary', () => {
  const r = detect({ DEVSWARM_REPO_ID: 'repo-1' });
  assert.strictEqual(r.inside, true);
  assert.strictEqual(r.role, 'primary');
  assert.strictEqual(r.sourceBranch, '');
});

test('Primary: REPO_ID set, SOURCE_BRANCH EMPTY string -> role=primary', () => {
  const r = detect({ DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' });
  assert.strictEqual(r.role, 'primary');
  assert.strictEqual(r.sourceBranch, '');
});

test('Child: REPO_ID set, SOURCE_BRANCH non-empty -> role=child, sourceBranch passed through', () => {
  const r = detect({ DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feature/x' });
  assert.strictEqual(r.role, 'child');
  assert.strictEqual(r.sourceBranch, 'feature/x');
});

test('agent: DEVSWARM_AI_AGENT is surfaced; codex vs claude', () => {
  assert.strictEqual(detect({ DEVSWARM_REPO_ID: 'r', DEVSWARM_AI_AGENT: 'codex' }).agent, 'codex');
  assert.strictEqual(detect({ DEVSWARM_REPO_ID: 'r', DEVSWARM_AI_AGENT: 'claude' }).agent, 'claude');
  assert.strictEqual(detect({ DEVSWARM_REPO_ID: 'r' }).agent, null);
});

test('Pathological: SOURCE_BRANCH with a control char -> role=null (unknown, safe path)', () => {
  const r = detect({ DEVSWARM_REPO_ID: 'r', DEVSWARM_SOURCE_BRANCH: 'bad\x00branch' });
  assert.strictEqual(r.inside, true);
  assert.strictEqual(r.role, null);
  assert.strictEqual(r.sourceBranch, null);
});

test('Pathological: SOURCE_BRANCH non-string -> role=null', () => {
  const r = detect({ DEVSWARM_REPO_ID: 'r', DEVSWARM_SOURCE_BRANCH: 12345 });
  assert.strictEqual(r.role, null);
  assert.strictEqual(r.sourceBranch, null);
});

test('DEVSWARM_SPAWNED is NOT a role signal (present on both Primary and child)', () => {
  // Primary with SPAWNED=1 is still Primary (SOURCE_BRANCH is the only role signal).
  const r = detect({ DEVSWARM_REPO_ID: 'r', DEVSWARM_SPAWNED: '1' });
  assert.strictEqual(r.role, 'primary');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/devswarm-role.test.js`
Expected: FAIL — `Cannot find module '.../hooks/lib/devswarm-role.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/hooks/lib/devswarm-role.js`:

```js
'use strict';
// anti-hall :: DevSwarm role detection (pure, no deps, fail-open).
//
// Classifies the CURRENT workspace from DevSwarm's env vars (verified live in
// docs/KB-devswarm-hivecontrol.md §8):
//   - inside DevSwarm?  DEVSWARM_REPO_ID is set.
//   - Primary vs child? DEVSWARM_SOURCE_BRANCH EMPTY/unset => Primary,
//                       non-empty => child. (DEVSWARM_SPAWNED is 1 on BOTH — not
//                       a role signal.)
//   - engine:           DEVSWARM_AI_AGENT ('claude' => OMC, 'codex' => OMX).
//
// PATHOLOGICAL GUARD: if inside but DEVSWARM_SOURCE_BRANCH is a non-string or a
// string carrying control chars, role is null (unknown) so callers take the safe
// path (guard fails closed; skill falls back to in-process). Empty string and
// unset are BOTH falsy => Primary.

// Control chars (C0 + DEL) that must never appear in a real git branch name.
const CONTROL_RE = /[\x00-\x1F\x7F]/;

function detect(env = process.env) {
  const e = env || {};
  const inside = !!e.DEVSWARM_REPO_ID;
  const agent = typeof e.DEVSWARM_AI_AGENT === 'string' ? e.DEVSWARM_AI_AGENT : null;

  if (!inside) {
    return { inside: false, role: null, agent, sourceBranch: null };
  }

  const sb = e.DEVSWARM_SOURCE_BRANCH;

  // Unset or empty string => Primary (both falsy).
  if (sb === undefined || sb === null || sb === '') {
    return { inside: true, role: 'primary', agent, sourceBranch: '' };
  }

  // Non-string, or a string with control-char garbage => unknown (safe path).
  if (typeof sb !== 'string' || CONTROL_RE.test(sb)) {
    return { inside: true, role: null, agent, sourceBranch: null };
  }

  // Clean non-empty branch name => child.
  return { inside: true, role: 'child', agent, sourceBranch: sb };
}

module.exports = { detect };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/devswarm-role.test.js`
Expected: PASS (8 subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/lib/devswarm-role.js tests/hooks/devswarm-role.test.js
git commit -m "feat(devswarm): add pure role-detection helper (WP/WC classification)"
```

---

### Task 2: Add `devswarm-guard` to skip-guard's `DESTRUCTIVE` set

**Files:**
- Modify: `plugins/anti-hall/hooks/skip-guard.js:34`
- Test: `tests/hooks/skip-guard.test.js`

**Interfaces:**
- Consumes: `skip-guard.js` exports `{ isSkipped, SKIP_FILE, DESTRUCTIVE }` (unchanged shape).
- Produces: `DESTRUCTIVE` now contains `'git-guard'` AND `'devswarm-guard'`. Semantics unchanged: a guard resists the blanket `all` skip **only if it is in `DESTRUCTIVE`**; a guard-specific token (`data['devswarm-guard'] > now`) still skips it. This membership is INERT until `devswarm-guard.js` (Task 3) calls `isSkipped('devswarm-guard')`.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/skip-guard.test.js`:

```js
'use strict';
// skip-guard: devswarm-guard must be a DESTRUCTIVE guard, so a routine blanket
// `all` skip does NOT silently disable it — only a guard-specific `devswarm-guard`
// token can. Behavioral checks run isSkipped in a child process with a fake HOME
// (SKIP_FILE is computed from os.homedir() at require time; os.homedir() honors
// $HOME on POSIX / USERPROFILE on win32, which spawn isolation controls).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const GUARD = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'skip-guard.js',
);

// Evaluate isSkipped(name) in a child whose HOME (and win32 profile vars) point
// at `home`, so the child reads home/.anti-hall/skip.json, not the real machine.
function isSkippedIn(home, name) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.platform === 'win32') {
    const root = path.parse(home).root;
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
  }
  const code =
    'const {isSkipped}=require(' + JSON.stringify(GUARD) + ');' +
    'process.stdout.write(isSkipped(' + JSON.stringify(name) + ')?"1":"0");';
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  return r.stdout.trim() === '1';
}

test('MEMBERSHIP: devswarm-guard (and git-guard) are in DESTRUCTIVE', () => {
  const { DESTRUCTIVE } = require(GUARD);
  assert.ok(DESTRUCTIVE.has('git-guard'), 'git-guard must stay destructive');
  assert.ok(DESTRUCTIVE.has('devswarm-guard'), 'devswarm-guard must be destructive');
});

test('blanket `all` skip does NOT disable devswarm-guard (destructive)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ all: Date.now() + 600000 });
    assert.strictEqual(isSkippedIn(h.home, 'devswarm-guard'), false,
      'all-skip must not cover a destructive guard');
    // Control: a NON-destructive guard IS covered by the blanket `all`.
    assert.strictEqual(isSkippedIn(h.home, 'command-guard'), true,
      'all-skip should still cover non-destructive guards');
  } finally { h.cleanup(); }
});

test('guard-specific token DOES skip devswarm-guard', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-guard': Date.now() + 600000 });
    assert.strictEqual(isSkippedIn(h.home, 'devswarm-guard'), true);
  } finally { h.cleanup(); }
});

test('expired guard-specific token does NOT skip (TTL respected)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-guard': Date.now() - 1000 });
    assert.strictEqual(isSkippedIn(h.home, 'devswarm-guard'), false);
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/skip-guard.test.js`
Expected: FAIL — `MEMBERSHIP` subtest fails (`devswarm-guard` not yet in `DESTRUCTIVE`); `blanket all` subtest fails (`isSkippedIn(..., 'devswarm-guard')` returns `true` because it is still covered by `all`).

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/hooks/skip-guard.js` line 34:

```js
// Guards NOT covered by a broad "all" skip — they must be named explicitly.
const DESTRUCTIVE = new Set(['git-guard', 'devswarm-guard']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/skip-guard.test.js`
Expected: PASS (4 subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/skip-guard.js tests/hooks/skip-guard.test.js
git commit -m "feat(devswarm): make devswarm-guard a DESTRUCTIVE (all-skip-resistant) guard"
```

---

### Task 3: No-child-child guard (`devswarm-guard.js`)

**Files:**
- Create: `plugins/anti-hall/hooks/devswarm-guard.js`
- Test: `tests/hooks/devswarm-guard.test.js`

**Interfaces:**
- Consumes: `detect()` from `./lib/devswarm-role.js` (Task 1); `isSkipped()` from `./skip-guard.js` (Task 2, with `devswarm-guard` ∈ `DESTRUCTIVE`).
- Produces: a standalone PreToolUse/Bash hook. Contract: reads `{ tool_input: { command } }` on stdin; exit 0 = allow; a BLOCK writes `{"decision":"block","reason":"..."}` to stdout and exits 2. FIRST executable line `if (!process.env.DEVSWARM_REPO_ID) process.exit(0);`. Vendors its own `tokenize`/`splitSegments`/`effectiveVerb`/`extractEvalPayload` parser (does NOT require git-guard.js). Blocks `hivecontrol|devswarm workspace create` when `detect().role !== 'primary'` (i.e. `child` or `null`-while-inside); fails CLOSED on a create-ish-but-unparseable segment in that same role set. No exports (a hook, run as a script).

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/devswarm-guard.test.js`:

```js
'use strict';
// devswarm-guard (PreToolUse Bash): a DevSwarm CHILD workspace must not create
// grandchild workspaces. First line is a true no-op when DEVSWARM_REPO_ID is
// unset (99% case). In a child it blocks `hivecontrol workspace create` and
// fails CLOSED on a create-ish-but-unparseable segment; in the Primary it allows
// (the WP must create). Must NOT false-positive on the non-create hivecontrol
// subcommands a WC actually runs, nor on quoted/echo payloads. Role comes from
// process.env, so DEVSWARM_* is passed via opts.env (merged onto the isolated base).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-guard.js';

const CHILD = { DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_SPAWNED: '1', DEVSWARM_AI_AGENT: 'claude' };
const PRIMARY = { DEVSWARM_REPO_ID: 'r1', DEVSWARM_SPAWNED: '1', DEVSWARM_AI_AGENT: 'claude' };

function pay(command) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: process.cwd() };
}
function assertBlock(r) {
  assert.strictEqual(r.status, 2, `expected block exit 2; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', `expected decision block; json: ${JSON.stringify(r.json)}`);
}
function assertAllow(r) {
  assert.strictEqual(r.status, 0, `expected allow exit 0; stdout: ${r.stdout}`);
  assert.ok(!(r.json && r.json.decision === 'block'), `expected NO block; json: ${JSON.stringify(r.json)}`);
}

// ---- First-line no-op (not in DevSwarm) ----

test('NO-OP: DEVSWARM_REPO_ID unset -> allow even for a real create command', () => {
  const h = makeHome();
  try {
    // No DEVSWARM_* env at all -> first line exits 0 before reading stdin.
    const r = testHook(HOOK, pay('hivecontrol workspace create feat -a claude -p "x" -t "y"'), { home: h.home });
    assertAllow(r);
  } finally { h.cleanup(); }
});

// ---- Child blocks create ----

test('CHILD: hivecontrol workspace create -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('hivecontrol workspace create feat -a claude -p "brief" -t "Title"'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: devswarm alias verb, workspace create -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('devswarm workspace create feat'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: multi-command with a real create in segment 2 -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('git status && hivecontrol workspace create feat'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: env-prefixed create -> BLOCK', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('FOO=1 hivecontrol workspace create feat'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: eval-wrapped create -> BLOCK (eval payload unwrapped)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('eval "hivecontrol workspace create feat"'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: $(...) command substitution INSIDE double quotes -> BLOCK (still executes)', () => {
  const h = makeHome();
  try {
    // Command substitution expands even inside double quotes (only single quotes
    // suppress it) -- `echo "$(hivecontrol workspace create nested)"` really runs
    // the create in a subshell. A quoted-string-is-DATA over-generalization would
    // wrongly ALLOW this.
    const r = testHook(HOOK, pay('echo "$(hivecontrol workspace create nested)"'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: backtick command substitution INSIDE double quotes -> BLOCK (still executes)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('echo "`hivecontrol workspace create nested`"'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

test('CHILD: a genuinely DATA double-quoted string mentioning create -> ALLOW (no $()/backtick)', () => {
  const h = makeHome();
  try {
    // Control: without an actual substitution boundary, the quoted text stays DATA
    // (matches the existing "echo of a create string" test) -- the new $()/backtick
    // handling must not over-fire on ordinary quoted content.
    const r = testHook(HOOK, pay('echo "note: hivecontrol workspace create is a WP-only command"'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

test('CHILD FAIL-CLOSED: create-ish-but-unparseable (reversed order) -> BLOCK', () => {
  const h = makeHome();
  try {
    // Both 'workspace' and 'create' appear unquoted but not as a clean
    // `workspace create` pair -> ambiguous create-ish -> fail closed in a child.
    const r = testHook(HOOK, pay('hivecontrol create workspace feat'), { home: h.home, env: CHILD });
    assertBlock(r);
  } finally { h.cleanup(); }
});

// ---- Child allows non-create hivecontrol traffic (no over-block on legit WC cmds) ----

test('CHILD: message-parent (the ANTIHALL-READY signal) -> ALLOW', () => {
  const h = makeHome();
  try {
    // message-parent takes only <msg> (no branch arg) per KB §4.1 -- the branch is
    // implicit (this workspace); it is embedded in the ready-signal marker text instead.
    const r = testHook(HOOK, pay('hivecontrol workspace message-parent "ANTIHALL-READY feature/x"'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

test('CHILD: message-child / read-messages / check-merge / message-count -> ALLOW', () => {
  const h = makeHome();
  try {
    for (const cmd of [
      'hivecontrol workspace message-child feature/y "run workspace create later"',
      'hivecontrol workspace read-messages',
      'hivecontrol workspace check-merge',
      'hivecontrol workspace message-count',
      'hivecontrol workspace info feature/x',
      'hivecontrol workspace list children',
    ]) {
      assertAllow(testHook(HOOK, pay(cmd), { home: h.home, env: CHILD }));
    }
  } finally { h.cleanup(); }
});

test('CHILD: echo of a create string (create is DATA, not a verb) -> ALLOW', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('echo "hivecontrol workspace create feat"'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

test('CHILD: heredoc payload mentioning create -> ALLOW', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('cat <<EOF\nhivecontrol workspace create feat\nEOF'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

test('CHILD: workspace list --filter=create (create is a flag value) -> ALLOW', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('hivecontrol workspace list --filter=create'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

// ---- Primary allows create ----

test('PRIMARY: hivecontrol workspace create -> ALLOW (WP must create)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, pay('hivecontrol workspace create feat -a claude -p "brief" -t "Title"'), { home: h.home, env: PRIMARY });
    assertAllow(r);
  } finally { h.cleanup(); }
});

// ---- Skip hatch ----

test('SKIP-HATCH: {devswarm-guard: future} -> allow even in a child creating', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-guard': Date.now() + 600000 });
    const r = testHook(HOOK, pay('hivecontrol workspace create feat'), { home: h.home, env: CHILD });
    assertAllow(r);
  } finally { h.cleanup(); }
});

// ---- Fail-open on envelope errors ----

test('FAIL-OPEN: empty stdin (in a child) -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: CHILD });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON (in a child) -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: CHILD });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/devswarm-guard.test.js`
Expected: FAIL — `Cannot find module '.../hooks/devswarm-guard.js'` (spawn yields non-zero / no JSON for every subtest).

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/hooks/devswarm-guard.js`:

```js
#!/usr/bin/env node
// anti-hall :: devswarm-guard (PreToolUse on Bash)
//
// A DevSwarm CHILD workspace must NOT create grandchild workspaces. Nested
// workspaces would run UNMONITORED — only the Primary (WP) coordinator runs the
// poll/merge loop — so a child spawning a child produces an orphan. This guard
// blocks `hivecontrol|devswarm workspace create` when the current workspace is a
// child (or an unknown/pathological role while inside DevSwarm).
//
// FIRST LINE is a true no-op when DEVSWARM_REPO_ID is unset (the 99% non-DevSwarm
// case): exit 0 before any stdin read, zero parse cost.
//
// The command parser is VENDORED here (a focused copy of git-guard.js's
// tokenizer / verb-resolution / segment-split / eval-unwrap). We do NOT require
// git-guard.js — it exports nothing, and each guard vendoring its own parser is
// the established repo pattern (command-guard/git-guard/graphify-guard/merge-gate
// all do). This guard is a strong DEFAULT, not a sandbox: like every static Bash
// guard here it cannot defeat arbitrary alias/shell-function indirection
// (`alias hc='hivecontrol workspace create'; hc x`) — post-expansion tokens are
// invisible to a static parser. Real containment is the WC brief (a child does not
// create workspaces) + nesting disabled by default.
//
// FAIL DIRECTION: envelope errors (unreadable stdin / malformed JSON) fail OPEN
// (never wedge unrelated Bash in a child). But a PARSED command that is
// create-ish-but-unparseable in a child fails CLOSED (block) — a child must never
// silently spawn a grandchild.
//
// Contract (Claude Code PreToolUse hook, matcher "Bash"):
//   stdin  : JSON { tool_input: { command: "<the bash command>" }, ... }
//   allow  : exit 0
//   block  : stdout JSON {"decision":"block","reason":"..."} + exit 2

'use strict';

// === FIRST EXECUTABLE LINE: no-op outside DevSwarm, before any stdin read. ===
if (!process.env.DEVSWARM_REPO_ID) process.exit(0);

const fs = require('fs');

// --- vendored parser (focused copy of git-guard.js) ---------------------------

// Tokenize one segment into argv-style tokens, honoring single/double quotes and
// dropping a trailing `# ...` comment. Returns [{ text, quotedOnly }] so a fully
// quoted token (data, e.g. a message payload) is distinguishable from a bare word.
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let curHasUnquoted = false;
  let started = false;
  let i = 0;
  const n = segment.length;

  function pushToken() {
    if (started) tokens.push({ text: cur, quotedOnly: !curHasUnquoted });
    cur = '';
    curHasUnquoted = false;
    started = false;
  }

  while (i < n) {
    const c = segment[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { pushToken(); i++; continue; }
    if (c === '#' && !started) break; // rest of the segment is a comment
    if (c === "'") {
      started = true; i++;
      while (i < n && segment[i] !== "'") { cur += segment[i]; i++; }
      i++; continue;
    }
    if (c === '"') {
      started = true; i++;
      while (i < n && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < n) {
          const nx = segment[i + 1];
          if (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n') cur += nx;
          else cur += '\\' + nx;
          i += 2;
        } else { cur += segment[i]; i++; }
      }
      i++; continue;
    }
    if (c === '\\' && i + 1 < n) { started = true; curHasUnquoted = true; cur += segment[i + 1]; i += 2; continue; }
    started = true; curHasUnquoted = true; cur += c; i++;
  }
  pushToken();
  return tokens;
}

// Split a command line into logical segments on ; && || | and newlines, and on
// subshell / grouping / command-substitution boundaries ( ) { } $( ` — honoring
// quotes so an operator inside a quoted string does not create a spurious segment.
// (A `$(hivecontrol workspace create ...)` body thus becomes its own segment and
// is scanned.) Command substitution and backticks ALSO expand inside double quotes
// (only single quotes suppress them — bash still runs `echo "$(hivecontrol
// workspace create x)"` as a real create in a subshell), so a `$(`/backtick hit
// while `inDouble` flushes the accumulated quoted text, extracts the substitution
// body (depth-matched parens / matching backtick — a simple depth count, NOT
// quote-aware inside the body itself; same approximation as the top-level case
// below), recursively re-splits+scans that body as its own segment set, then
// resumes double-quote tracking for whatever follows. Residual limitation: a
// nested unescaped `(`/`)` or quote INSIDE the substitution body that isn't part
// of a balanced pair can still mis-split (documented, not a full shell parser).
function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;

  function flush() { if (cur.trim().length) segments.push(cur); cur = ''; }

  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';
    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      if ((c === '$' && c2 === '(') || c === '`') {
        flush();
        let body = '';
        if (c === '$') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (cmd[i] === '(') depth++;
            else if (cmd[i] === ')') { depth--; if (depth === 0) { i++; break; } }
            body += cmd[i];
            i++;
          }
        } else {
          i++; // opening backtick
          while (i < n && cmd[i] !== '`') { body += cmd[i]; i++; }
          i++; // closing backtick
        }
        segments.push(...splitSegments(body));
        continue; // inDouble unchanged -- resume scanning the rest of the quoted string
      }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) { cur += ' '; i += (c2 === '\r') ? 3 : 2; continue; }
    // Heredoc: <<[-]DELIM (optionally quoted). The delimiter word stays part of
    // THIS segment (so `cat <<EOF` still resolves verb `cat`), but the BODY lines
    // up to and including the line that is exactly the delimiter are skipped
    // entirely -- heredoc content is DATA, never scanned for a create, matching
    // real shell semantics (`<<-` strips the delimiter-line's leading tabs before
    // comparing). This is what makes the Step-1 heredoc test's "Expected: ALLOW"
    // true: `cat <<EOF` / `hivecontrol workspace create feat` (body) / `EOF` never
    // reaches scanForCreate.
    if (c === '<' && c2 === '<') {
      let j = i + 2;
      let dash = false;
      if (cmd[j] === '-') { dash = true; j++; }
      while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++;
      let delim = '';
      if (cmd[j] === '"' || cmd[j] === "'") {
        const q = cmd[j]; j++;
        while (j < n && cmd[j] !== q) { delim += cmd[j]; j++; }
        if (j < n) j++;
      } else {
        while (j < n && !/[\s;&|()<>]/.test(cmd[j])) { delim += cmd[j]; j++; }
      }
      if (delim) {
        cur += cmd.slice(i, j);
        i = j;
        while (i < n && cmd[i] !== '\n') { cur += cmd[i]; i++; }
        if (i < n) { cur += '\n'; i++; }
        flush(); // the heredoc-introducing line is its own segment; the body is NOT
        while (i < n) {
          const lineStart = i;
          while (i < n && cmd[i] !== '\n') i++;
          const line = cmd.slice(lineStart, i);
          if (i < n) i++;
          const check = dash ? line.replace(/^\t+/, '') : line;
          if (check === delim) break;
        }
        continue;
      }
    }
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') { flush(); i++; continue; }
    if (c === ';') { flush(); i++; continue; }
    if (c === '&') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }
    if (c === ')' || c === '(' || c === '{' || c === '}') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flush(); i += 2; continue; }
    if (c === '`') { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return segments;
}

// Cross-platform basename: /usr/bin/hivecontrol and \hivecontrol -> hivecontrol.
function basename(p) {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

// Wrapper words to skip when resolving a segment's effective verb.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout', 'then', 'do', 'else']);

// Resolve the effective command verb + its args from a token list, skipping
// leading VAR=value assignments and wrapper words (with wrapper-operand handling
// for sudo/env/timeout/nice). Returns { verb, args } or null.
function effectiveVerb(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) { idx++; continue; }
    break;
  }
  while (idx < tokens.length) {
    const t = tokens[idx];
    const word = t.text;
    if (!t.quotedOnly && WRAPPERS.has(word)) {
      idx++;
      if (word === 'sudo') {
        const SUDO_VAL = new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '-h',
          '--user', '--group', '--prompt', '--close-from', '--role', '--type', '--other-user', '--host']);
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text; idx++;
          if (f === '--') break;
          if (SUDO_VAL.has(f) && idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
      } else if (word === 'env') {
        while (idx < tokens.length) {
          const e = tokens[idx];
          if (!e.quotedOnly && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e.text) || e.text.startsWith('-'))) { idx++; continue; }
          break;
        }
      } else if (word === 'timeout') {
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text; idx++;
          if ((f === '-s' || f === '--signal' || f === '-k' || f === '--kill-after') &&
              idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
        if (idx < tokens.length && !tokens[idx].quotedOnly) idx++;
      } else if (word === 'nice') {
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text; idx++;
          if ((f === '-n' || f === '--adjustment') &&
              idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) idx++;
        }
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;
  const verbTok = tokens[idx];
  if (verbTok.quotedOnly) return null; // a fully-quoted token is data, not a verb
  return { verb: basename(verbTok.text), args: tokens.slice(idx + 1) };
}

// Extract the payload of an `eval <payload>` segment as a command string to be
// re-parsed (eval runs its argument as a shell command).
function extractEvalPayload(segment) {
  const tokens = tokenize(segment);
  const ev = effectiveVerb(tokens);
  if (!ev || ev.verb !== 'eval') return '';
  return ev.args.map((t) => t.text).filter((s) => s.length).join(' ');
}

// --- create detection ---------------------------------------------------------

// Classify a hivecontrol/devswarm arg list: 'create' (clean `workspace create`),
// 'create-ish' (both `workspace` and `create` present unquoted but not a clean
// pair -> ambiguous), or null (not a create). Quoted tokens are DATA (a quoted
// "create" is a message payload), so they are excluded from structural analysis.
function classifyCreate(args) {
  const positionals = []; // unquoted, non-flag words in order
  const unquotedWords = []; // all unquoted words (incl. flags)
  for (const t of args) {
    if (t.quotedOnly) continue;
    unquotedWords.push(t.text);
    if (!t.text.startsWith('-')) positionals.push(t.text);
  }
  if (positionals[0] === 'workspace' && positionals[1] === 'create') return 'create';
  if (unquotedWords.indexOf('workspace') !== -1 && unquotedWords.indexOf('create') !== -1) return 'create-ish';
  return null;
}

// Scan a command for a hivecontrol/devswarm `workspace create`. Returns 'create',
// 'create-ish', or null. Recurses (depth-bounded) into eval payloads.
function scanForCreate(cmd, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  let verdict = null;
  for (const seg of splitSegments(cmd)) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const ev = effectiveVerb(tokens);
    if (!ev) continue;
    if (ev.verb === 'eval') {
      if (d < 3) {
        const payload = extractEvalPayload(seg);
        if (payload) {
          const nested = scanForCreate(payload, d + 1);
          if (nested === 'create') return 'create';
          if (nested === 'create-ish') verdict = 'create-ish';
        }
      }
      continue;
    }
    if (ev.verb !== 'hivecontrol' && ev.verb !== 'devswarm') continue;
    const c = classifyCreate(ev.args);
    if (c === 'create') return 'create';
    if (c === 'create-ish') verdict = 'create-ish';
  }
  return verdict;
}

// --- block emission -----------------------------------------------------------

function block() {
  const reason =
    'anti-hall devswarm-guard: BLOCKED. A DevSwarm CHILD workspace must not create ' +
    'further child workspaces (`hivecontrol workspace create`). Nested workspaces run ' +
    'UNMONITORED — only the Primary coordinator polls and merges them — so this would ' +
    'leak an orphan. Do the work in THIS workspace and `message-parent` an ' +
    '`ANTIHALL-READY` signal when done. (If a nested level is truly required, the human ' +
    'enables it via the TTL skip in ~/.anti-hall/skip.json for `devswarm-guard`.)';
  // Small JSON: fs.writeSync(1, …) is synchronous, so exit(2) can never tear down
  // an async pipe flush (the macOS node 18/20 truncation race).
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) { /* ignore */ }
  process.exit(2);
}

function main() {
  // Escape hatch: honor an explicit, user-consented skip. devswarm-guard is in
  // skip-guard's DESTRUCTIVE set, so a blanket `all` skip does NOT cover it — only
  // a guard-specific `devswarm-guard` token does.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('devswarm-guard')) process.exit(0);

  // Only children (and unknown/pathological role while inside) are gated. The
  // Primary MUST be able to create workspaces.
  const { detect } = require('./lib/devswarm-role.js');
  const role = detect(process.env).role;
  if (role === 'primary') process.exit(0);

  // Envelope errors fail OPEN (never wedge unrelated Bash in a child).
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }
  let cmd = '';
  try {
    const payload = JSON.parse(raw);
    const ti = payload && payload.tool_input;
    if (ti && typeof ti.command === 'string') cmd = ti.command;
  } catch (_) { process.exit(0); }
  if (!cmd) process.exit(0);

  // role is 'child' or null (unknown-while-inside): block a create or an
  // ambiguous create-ish (fail CLOSED — a child must never spawn a grandchild).
  const verdict = scanForCreate(cmd, 0);
  if (verdict === 'create' || verdict === 'create-ish') return block();

  process.exit(0);
}

try {
  main();
} catch (_) {
  // Any unexpected error while INSIDE a child fails OPEN on envelope-level issues,
  // but must not silently allow a create it already flagged. main() only reaches
  // here on a parser bug (not a detected create), so exit 0 (fail open) — the
  // static guard is a default, not a sandbox.
  process.exit(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/devswarm-guard.test.js`
Expected: PASS (all subtests: no-op, child blocks, primary allows, fail-closed, no-false-positive matrix, skip hatch, fail-open).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/devswarm-guard.js tests/hooks/devswarm-guard.test.js
git commit -m "feat(devswarm): add no-child-child guard (blocks workspace create in a child)"
```

---

### Task 4: Register the guard in all 3 manifests + cross-manifest parity test

**Files:**
- Modify: `plugins/anti-hall/hooks/hooks.json` (PreToolUse array)
- Modify: `plugins/anti-hall/codex/install-codex.js:49-54` (`ANTI_HALL_HOOKS.PreToolUse`)
- Modify: `plugins/anti-hall/codex/hooks/hooks.json` (PreToolUse array)
- Test: `tests/hooks/manifest-parity.test.js`

**Interfaces:**
- Consumes: `devswarm-guard.js` (Task 3) must exist. The `install-codex.js` CLI writes `.codex/hooks.json` when run in a project cwd (verified by `tests/codex/install-codex.test.js`).
- Produces: all 3 live manifests register `devswarm-guard.js` on `PreToolUse` with `matcher: "Bash"`. New general invariant: the set of guard basenames on `PreToolUse` entries filtered to `matcher==="Bash"` is IDENTICAL across the Claude manifest, the Codex live manifest, and the `install-codex.js`-generated manifest. (Full-PreToolUse sets legitimately diverge — Codex manifests lack the Claude Write/Edit/Grep/Glob/Agent/Task guards — so the invariant is scoped to Bash.)

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/manifest-parity.test.js`:

```js
'use strict';
// Cross-manifest parity: the PreToolUse guard set filtered to matcher "Bash" must
// be IDENTICAL across all 3 LIVE manifests:
//   (1) plugins/anti-hall/hooks/hooks.json                 (Claude plugin)
//   (2) plugins/anti-hall/codex/hooks/hooks.json           (Codex marketplace plugin)
//   (3) the .codex/hooks.json that install-codex.js writes (Codex script install)
// Scoped to Bash ONLY — the full PreToolUse sets legitimately diverge (Codex lacks
// the Claude Write/Edit/Grep/Glob/Agent/Task guards). A GENERAL invariant, so any
// future 1-of-3 drift (e.g. shipping a guard to Claude but not Codex) is caught.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CLAUDE_MANIFEST = path.join(REPO, 'plugins', 'anti-hall', 'hooks', 'hooks.json');
const CODEX_LIVE_MANIFEST = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.json');
const INSTALLER = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'install-codex.js');

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Set of guard basenames (e.g. 'git-guard.js') on PreToolUse entries with matcher "Bash".
function bashGuardSet(manifest) {
  const pre = (manifest.hooks && manifest.hooks.PreToolUse) || [];
  const names = new Set();
  for (const entry of pre) {
    if (entry.matcher !== 'Bash') continue;
    for (const h of (entry.hooks || [])) {
      const m = /([A-Za-z0-9._-]+\.js)/.exec(h.command || '');
      if (m) names.add(m[1]);
    }
  }
  return names;
}
const sorted = (s) => [...s].sort();

// Run install-codex.js into a throwaway project dir and read the generated manifest.
function generatedCodexManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-parity-'));
  try {
    const r = spawnSync(process.execPath, [INSTALLER], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    return readJSON(path.join(dir, '.codex', 'hooks.json'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('PARITY: PreToolUse Bash guard set is identical across all 3 live manifests', () => {
  const claude = bashGuardSet(readJSON(CLAUDE_MANIFEST));
  const codexLive = bashGuardSet(readJSON(CODEX_LIVE_MANIFEST));
  const codexGen = bashGuardSet(generatedCodexManifest());
  assert.deepStrictEqual(sorted(codexLive), sorted(claude), 'codex live manifest Bash guards diverge from Claude');
  assert.deepStrictEqual(sorted(codexGen), sorted(claude), 'codex script-install Bash guards diverge from Claude');
});

test('PARITY: devswarm-guard.js is present in all 3 manifests', () => {
  const sets = [
    ['claude', bashGuardSet(readJSON(CLAUDE_MANIFEST))],
    ['codex-live', bashGuardSet(readJSON(CODEX_LIVE_MANIFEST))],
    ['codex-generated', bashGuardSet(generatedCodexManifest())],
  ];
  for (const [name, s] of sets) {
    assert.ok(s.has('devswarm-guard.js'), `${name} manifest missing devswarm-guard.js`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/manifest-parity.test.js`
Expected: FAIL — the `devswarm-guard.js is present` subtest fails on all 3 (guard not yet registered). The `identical` subtest PASSES now (all 3 currently carry the same 4 Bash guards) and must STAY passing after Step 3.

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/hooks/hooks.json` — inside `hooks.PreToolUse`, immediately after the `merge-gate.js` Bash group (which ends at the `}` before the `Write|Edit|MultiEdit` group), insert:

```json
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/devswarm-guard.js\"",
            "timeout": 10
          }
        ]
      },
```

Edit `plugins/anti-hall/codex/install-codex.js` — in `ANTI_HALL_HOOKS.PreToolUse`, add the `devswarm-guard` group after `merge-gate`:

```js
  PreToolUse: [
    group('Bash', ['git-guard.js'], 10),
    group('Bash', ['command-guard.js'], 10),
    group('Bash', ['graphify-guard.js'], 10),
    group('Bash', ['merge-gate.js'], 10),
    group('Bash', ['devswarm-guard.js'], 10),
  ],
```

Edit `plugins/anti-hall/codex/hooks/hooks.json` — inside `hooks.PreToolUse`, after the `merge-gate.js` group, insert:

```json
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/devswarm-guard.js\"", "timeout": 10 }
        ]
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/manifest-parity.test.js tests/codex/install-codex.test.js`
Expected: PASS — both parity subtests green (all 3 manifests now carry the same 5 Bash guards including `devswarm-guard.js`); the existing install-codex tests remain green.

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/hooks.json plugins/anti-hall/codex/install-codex.js plugins/anti-hall/codex/hooks/hooks.json tests/hooks/manifest-parity.test.js
git commit -m "feat(devswarm): register devswarm-guard in all 3 hook manifests + parity test"
```

---

### Task 5: Role-gate the two graphify hooks (lazy-require inside `main()`)

**Files:**
- Modify: `plugins/anti-hall/hooks/graphify-reminder.js` (inside `main()`, after `cwd` computed ~:160)
- Modify: `plugins/anti-hall/hooks/graphify-session.js` (inside `main()`, after payload parse ~:83)
- Test: append to `tests/hooks/graphify-reminder.test.js` and `tests/hooks/graphify-session.test.js`

**Interfaces:**
- Consumes: `detect()` from `./lib/devswarm-role.js` (Task 1).
- Produces: both hooks early-exit (`process.exit(0)`, no output) when `detect(process.env).role === 'child'`. The require is LAZY (inside `main()`) and wrapped in try/catch so a missing helper on a partial rollout never crashes — non-DevSwarm and Primary behavior is byte-for-byte unchanged. `graphify-session.js`'s top-level requires (`:19-21`) sit OUTSIDE its `main()` try/catch, so the require MUST be lazy or a missing helper would crash SessionStart for every project.

- [ ] **Step 1: Write the failing test**

Append to `tests/hooks/graphify-reminder.test.js` (before the final closing — after the existing tests):

```js
// ---- DevSwarm child role-gate (role comes from process.env, not the payload) ----

const CHILD_ENV = { DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'feature/x' };
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'r1' };

test('ROLE-GATE: child (DEVSWARM_SOURCE_BRANCH set) -> NO nudge even with graph + edits', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const tp = h.writeTranscript([editMessage('Edit'), editMessage('Write')]);
    const r = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-child'), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(!isBlock(r), `child must not be nudged; stdout: ${r.stdout}`);
  } finally { proj.cleanup(); h.cleanup(); }
});

test('ROLE-GATE: primary (no SOURCE_BRANCH) -> nudge unchanged (graph + edits)', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const tp = h.writeTranscript([editMessage('Edit'), editMessage('Write')]);
    const r = testHook(HOOK, stopPayload(tp, proj.dir, 'sess-primary'), { home: h.home, env: PRIMARY_ENV });
    assert.ok(isBlock(r), `primary should still nudge; stdout: ${r.stdout}`);
  } finally { proj.cleanup(); h.cleanup(); }
});
```

Append to `tests/hooks/graphify-session.test.js` (after the existing tests):

```js
// ---- DevSwarm child role-gate ----

const CHILD_ENV = { DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'feature/x' };
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'r1' };

test('ROLE-GATE: child -> NO injection even when a graph exists', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `child must inject nothing; got: ${r.stdout}`);
    assert.strictEqual(ctx(r), '', 'no additionalContext in a child');
  } finally { proj.cleanup(); h.cleanup(); }
});

test('ROLE-GATE: primary -> injection unchanged when a graph exists', () => {
  const h = makeHome();
  const proj = makeProject({ graph: true });
  try {
    const r = testHook(HOOK, sessionPayload(proj.dir), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(ctx(r).includes('GRAPHIFY-FIRST PROTOCOL'), 'primary still gets the primer');
  } finally { proj.cleanup(); h.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/graphify-reminder.test.js tests/hooks/graphify-session.test.js`
Expected: FAIL — the child `ROLE-GATE` subtests fail (reminder still blocks / session still injects in a child, because the gate is not implemented). Primary subtests pass.

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/hooks/graphify-reminder.js` — inside `main()`, right after the `cwd` line (`const cwd = ...;`, ~:160) and BEFORE the graph check, insert:

```js
  // DevSwarm child role-gate: a WC child does not update graphify (its worktree
  // typically lacks the gitignored graphify-out/, and graphify is WP-only). Lazy-
  // require INSIDE main() so a missing helper on a partial rollout fails open
  // (proceed) rather than crashing at load.
  try {
    const { detect } = require('./lib/devswarm-role.js');
    if (detect(process.env).role === 'child') process.exit(0);
  } catch (_) { /* helper missing -> proceed as before (fail open) */ }
```

Edit `plugins/anti-hall/hooks/graphify-session.js` — inside `main()`, right after the payload-parse try/catch block (~:83, after the `catch (_) { // ignore ... }` that sets `cwd`) and BEFORE `const roots = [cwd];` (~:85), insert:

```js
  // DevSwarm child role-gate (defensive): a WC child's worktree normally lacks the
  // gitignored graphify-out/ so this already no-ops — but a future worktreeInclude
  // entry or a fork committing graphify-out/ would silently re-enable the primer.
  // Lazy-require INSIDE main() (the top-level requires at :19-21 sit OUTSIDE the
  // main() try, so a top-level require of a missing helper would crash SessionStart
  // for EVERY project). Fail open: proceed if the helper is missing.
  try {
    const { detect } = require('./lib/devswarm-role.js');
    if (detect(process.env).role === 'child') process.exit(0);
  } catch (_) { /* helper missing -> proceed as before (fail open) */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/graphify-reminder.test.js tests/hooks/graphify-session.test.js`
Expected: PASS (all subtests, including the pre-existing ones and the new role-gate ones).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/graphify-reminder.js plugins/anti-hall/hooks/graphify-session.js tests/hooks/graphify-reminder.test.js tests/hooks/graphify-session.test.js
git commit -m "feat(devswarm): role-gate graphify hooks off in a child workspace (lazy-require)"
```

---

### Task 6: Coordinator state helper (`devswarm-children.js`)

**Files:**
- Create: `plugins/anti-hall/hooks/lib/devswarm-children.js`
- Test: `tests/hooks/devswarm-children.test.js`

**Interfaces:**
- Consumes: nothing (leaf module; `fs`, `path`).
- Produces: an atomic single-writer read/modify/write helper for `<repoRoot>/.anti-hall/devswarm/children.json` (a JSON array of `{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }`). Exports:
  - `childrenPath(repoRoot) -> string` — the state file path.
  - `read(repoRoot) -> Array` — parsed array, or `[]` on missing/corrupt/non-array (fresh start).
  - `write(repoRoot, arr) -> arr` — atomic: writes a sibling temp file then `fs.renameSync` (same dir/FS → torn-file-proof), `mkdirSync({recursive})` first. Returns `arr`.
  - `update(repoRoot, mutator) -> Array` — read-modify-write: re-reads fresh, applies `mutator(current)` (whose return value, if truthy, is the new array; else `current` is kept), atomic-writes, returns the written array. The actual no-lost-update guarantee is the single-threaded ScheduleWakeup coordinator loop (§7) — this helper adds fresh-read + torn-file-proof-write on top.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/devswarm-children.test.js`:

```js
'use strict';
// devswarm-children: atomic single-writer RMW helper for
// .anti-hall/devswarm/children.json under a repo root. Pure fs; a throwaway repo
// dir per test. read() tolerates missing/corrupt files (=> []). write() is atomic
// (temp + rename, no leftover temp files). update() re-reads then atomic-writes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-children.js',
));

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-children-'));
  return { root, cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

function sampleChild() {
  return {
    branch: 'feature/x', id: 'ws-1', worktreePath: '/tmp/wt/x', title: 'Feature X',
    status: 'active', dispatchedAt: 1, lastPollAt: 0, lastMessageAt: 0,
  };
}

test('read: missing file -> [] (fresh start)', () => {
  const r = tmpRepo();
  try { assert.deepStrictEqual(lib.read(r.root), []); } finally { r.cleanup(); }
});

test('write then read: round-trips the array (and creates the dir)', () => {
  const r = tmpRepo();
  try {
    lib.write(r.root, [sampleChild()]);
    const got = lib.read(r.root);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].branch, 'feature/x');
    assert.strictEqual(got[0].worktreePath, '/tmp/wt/x');
    assert.ok(fs.existsSync(lib.childrenPath(r.root)), 'state file exists');
  } finally { r.cleanup(); }
});

test('update: appends a child on top of existing state', () => {
  const r = tmpRepo();
  try {
    lib.write(r.root, [sampleChild()]);
    lib.update(r.root, (cur) => cur.concat([{ ...sampleChild(), branch: 'feature/y', id: 'ws-2' }]));
    const got = lib.read(r.root);
    assert.strictEqual(got.length, 2);
    assert.deepStrictEqual(got.map((c) => c.branch), ['feature/x', 'feature/y']);
  } finally { r.cleanup(); }
});

test('update: mutator returning nothing keeps current (idempotent write)', () => {
  const r = tmpRepo();
  try {
    lib.write(r.root, [sampleChild()]);
    lib.update(r.root, () => {});
    assert.strictEqual(lib.read(r.root).length, 1);
  } finally { r.cleanup(); }
});

test('atomicity: no leftover temp files after a write', () => {
  const r = tmpRepo();
  try {
    lib.write(r.root, [sampleChild()]);
    const dir = path.dirname(lib.childrenPath(r.root));
    const stray = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepStrictEqual(stray, [], `no temp files should remain; found: ${stray}`);
  } finally { r.cleanup(); }
});

test('read: corrupt (non-JSON) file -> [] (recovers, never throws)', () => {
  const r = tmpRepo();
  try {
    const p = lib.childrenPath(r.root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json', 'utf8');
    assert.deepStrictEqual(lib.read(r.root), []);
  } finally { r.cleanup(); }
});

test('read: a JSON object (non-array) -> [] (shape guard)', () => {
  const r = tmpRepo();
  try {
    const p = lib.childrenPath(r.root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"branch":"x"}', 'utf8');
    assert.deepStrictEqual(lib.read(r.root), []);
  } finally { r.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/devswarm-children.test.js`
Expected: FAIL — `Cannot find module '.../hooks/lib/devswarm-children.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/anti-hall/hooks/lib/devswarm-children.js`:

```js
'use strict';
// anti-hall :: DevSwarm coordinator state (children.json) — atomic single-writer
// read/modify/write. Lives under the already-gitignored .anti-hall/ (no collision:
// progress-prune scopes only to progress/ + history/). SINGLE WRITER = the WP
// coordinator loop; the true no-lost-update guarantee is single-threadedness
// (ScheduleWakeup re-enters the SAME loop, never a parallel thread — design §7).
// This helper adds a fresh read + a torn-file-proof atomic write on top.
//
// Pure Node built-ins; OS-agnostic (fs.renameSync is atomic within one dir/FS on
// POSIX and Windows). Never throws on read — missing/corrupt/non-array => [].

const fs = require('fs');
const path = require('path');

function childrenPath(repoRoot) {
  return path.join(repoRoot, '.anti-hall', 'devswarm', 'children.json');
}

function read(repoRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(childrenPath(repoRoot), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return []; // missing / corrupt / non-array -> fresh start (never throw)
  }
}

function write(repoRoot, arr) {
  const finalPath = childrenPath(repoRoot);
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  // Temp file in the SAME dir so rename is a same-FS atomic swap (no torn read).
  const tmp = path.join(dir, 'children.json.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n');
  try {
    fs.renameSync(tmp, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort cleanup */ }
    throw e;
  }
  return arr;
}

// Read-modify-write: fresh read, apply mutator, atomic write. mutator may return
// the new array; a falsy return keeps the current array unchanged.
function update(repoRoot, mutator) {
  const current = read(repoRoot);
  const next = mutator(current);
  return write(repoRoot, Array.isArray(next) ? next : current);
}

module.exports = { childrenPath, read, write, update };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/devswarm-children.test.js`
Expected: PASS (7 subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/lib/devswarm-children.js tests/hooks/devswarm-children.test.js
git commit -m "feat(devswarm): add atomic single-writer children.json state helper"
```

---

### Task 7: Claude orchestration skill — "DevSwarm workspace tier (WP / WC)" section

**Files:**
- Modify: `plugins/anti-hall/skills/orchestration/SKILL.md` (append a new section before "## Relationship to other skills in this plugin")
- Test: `tests/skills/devswarm-skill.test.js`

**Interfaces:**
- Consumes: the runtime contracts from Tasks 1/3/6 — `detect()` roles, `devswarm-guard` behavior, `children.json` schema `{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }`, and the `ANTIHALL-READY <branch>` ready-signal marker.
- Produces: skill guidance an implementing agent follows. Structural test asserts the section and its load-bearing markers exist.

- [ ] **Step 1: Write the failing test**

Create `tests/skills/devswarm-skill.test.js`:

```js
'use strict';
// Structural assertions that the Claude orchestration skill carries the DevSwarm
// workspace-tier section with its load-bearing markers. (The Codex/OMX section is
// asserted by Task 8, which extends this file.)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const CLAUDE_SKILL = path.join(REPO, 'plugins', 'anti-hall', 'skills', 'orchestration', 'SKILL.md');

test('Claude orchestration skill has the DevSwarm workspace-tier section + markers', () => {
  const md = fs.readFileSync(CLAUDE_SKILL, 'utf8');
  for (const marker of [
    'DevSwarm workspace tier',
    'Workspace-Primary',
    'Workspace-Child',
    'DEVSWARM_REPO_ID',
    'DEVSWARM_SOURCE_BRANCH',
    'ANTIHALL-READY',
    'children.json',
    'ScheduleWakeup',
    'check-merge',
    'merge-into-source',
    'fromBranch',
    'needs-attention',
  ]) {
    assert.ok(md.includes(marker), `Claude skill missing DevSwarm marker: ${JSON.stringify(marker)}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skills/devswarm-skill.test.js`
Expected: FAIL — the markers are not present in the skill yet.

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/skills/orchestration/SKILL.md` — insert this section immediately BEFORE the final `## Relationship to other skills in this plugin` heading:

```markdown
## DevSwarm workspace tier (WP / WC)

When anti-hall runs **inside DevSwarm** (each workspace is an isolated git worktree
with its own agent), the coordinator gains an ORTHOGONAL fan-out tier on top of the
in-process L1/L2/L3 subagent hierarchy above. It is named **Workspace-Primary (WP)**
/ **Workspace-Child (WC)** so you never conflate workspace-nesting with subagent-
nesting. **Nothing here changes anything outside DevSwarm** — every rule is gated on
`DEVSWARM_REPO_ID`.

**Detect where you run** (verified env signals):
- **Inside DevSwarm?** `DEVSWARM_REPO_ID` is set. (`hivecontrol health` exit 0 means
  the app is reachable — necessary, not sufficient; it is NOT a role signal.)
- **Primary vs child?** `DEVSWARM_SOURCE_BRANCH` **empty/unset ⇒ Primary (WP)**,
  **non-empty ⇒ child (WC)**. `DEVSWARM_SPAWNED` is `1` on both — not a role signal.
- **Engine?** `DEVSWARM_AI_AGENT` (`claude`⇒OMC, `codex`⇒OMX).

| Tier | Role | Fan-out | Creates child workspaces? |
|---|---|---|---|
| **WP** | Primary (`SOURCE_BRANCH` empty) | child workspaces via `hivecontrol` **and** the in-process L1/L2/L3 tiers | ✅ yes |
| **WC** | Child (`SOURCE_BRANCH` set) | in-process L1/L2/L3 only — a full sub-orchestrator | ❌ no |

### WP (Workspace-Primary) — autonomous, ONLY when `role==='primary'` AND `hivecontrol health` exits 0

Otherwise fall back to plain in-process orchestration (no workspace tier). Rollout is
**full autonomous**: create, brief, monitor, and merge children with no happy-path
confirmation gate — but **surface** every conflict, timeout, and teardown; never
silently resolve.

For each large, independent, app-running chunk of work:
1. **Create:** `hivecontrol workspace create <branch> -a $DEVSWARM_AI_AGENT -p "<brief>" -t "<title>"`.
   Capture `worktreePath` from the create JSON (fallback: `hivecontrol workspace info <branch>`).
   Record `{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }`
   in `.anti-hall/devswarm/children.json` (gitignored; the coordinator is the SINGLE writer).
2. **Brief the child** that it is a WC sub-orchestrator: keep a sub-task-list, delegate,
   **do not run graphify**, **do not create child workspaces**, `message-parent` at
   milestones, and when done send a **structured ready signal whose FIRST LINE is the
   parseable marker `ANTIHALL-READY <branch>`** (not freeform prose) so WP detects
   completion deterministically. Include a bounded scope limit in every brief.
3. **Caps (two):**
   - `maxActive` (default 4; override in `.anti-hall/devswarm/config.json`). A
     `needs-attention` child (conflict/timeout) is surfaced immediately and **excluded
     from the ACTIVE count**, so it can't wedge fan-out — keep progressing other work.
   - `maxTotal` (active + needs-attention, default 12). On hit, **halt new creation**
     and surface "resolve/delete stuck workspaces in the app before continuing." This
     is the real orphan bound (teardown is GUI-only).
4. **Poll (ScheduleWakeup, 2→10 min backoff)** off `children.json` — NOT the blocking
   `monitor`. From the **Primary's own cwd** run `hivecontrol workspace message-count`
   (cheap peek) → `hivecontrol workspace read-messages` (WP's inbox; children message
   the parent, so no `cd`). For each entry whose **`fromBranch`** matches a recorded
   child AND whose body's first line is `ANTIHALL-READY`:
   - Select the child by **`fromBranch`** (the CLI-authoritative field — NOT by parsing
     the free-text marker token). A marker-token vs `fromBranch` mismatch, or a READY
     entry whose `fromBranch` matches NO recorded child, is `needs-attention` — surfaced,
     never silently reconciled or ignored.
   - Run the merge ops with a **scoped** `cd "<worktreePath>" && hivecontrol …` (never a
     persistent session `cd`; `message-count`/`read-messages` always run from WP's cwd):
     `hivecontrol workspace check-merge` **immediately** → only if `isMergeable &&
     !hasConflicts && targetDirectoryClean` → `hivecontrol workspace merge-into-source`.
   - **Merge one child at a time (serialized).** After each merge, re-run the next
     child's `check-merge` fresh against the new `main`.
   - On conflict / `WORKING_DIRECTORY_NOT_CLEAN` / poll-timeout — **or any `hivecontrol`
     call that errors** (non-zero / error JSON / app died mid-op) — **surface to the
     user**, mark the child `needs-attention`, do not auto-resolve, never crash the loop.
   - Each cycle, reconcile `children.json` against `hivecontrol workspace list children`;
     a child that has vanished (GUI delete/archive) or can't be matched is
     `needs-attention`, surfaced, never silently retried.
5. **After ALL children merged:** run graphify once (WP only). **Teardown:** list every
   workspace WP created and **surface** "delete these in the DevSwarm app" (no CLI teardown).

**Merge safety (why full-autonomous is acceptable):** `merge-into-source` runs a real
`git merge` inside the `hivecontrol` binary — atomic and conflict-detecting, so it
**cannot corrupt `main`**; the worst case is a surfaced conflict. `check-merge` is a
pre-filter optimization, not the correctness guarantee. anti-hall Bash guards cannot
gate `merge-into-source` (its `git merge` runs inside the subprocess); the sufficient
backstop is the `check-merge` precondition + serialization + surfacing every conflict.

### WC (Workspace-Child)

Identical to today's in-process orchestration, **minus** graphify updates and **minus**
workspace creation. WC is a full sub-orchestrator (creates workflows, keeps a sub-task-
list, delegates, never works directly). The no-child-of-child rule is STRUCTURAL: the
`devswarm-guard` PreToolUse hook blocks `hivecontrol workspace create` in a child (it is
a DESTRUCTIVE guard, so a blanket `all` skip cannot silently disable it — only an
explicit TTL'd `devswarm-guard` token can, for a deliberate one-off).

### Fallback & concurrency notes

- **Fallback:** `!inside || role !== 'primary' || health != 0 || role === null` ⇒
  byte-for-byte today's in-process behavior. No hard dependency on DevSwarm.
- **Single coordinator (v1 non-goal):** the `children.json` no-lost-update guarantee
  rests on exactly ONE active WP coordinator per repo (single-threaded ScheduleWakeup
  loop). Two simultaneous WP sessions on the same repo are an **explicit non-goal for
  v1** — nothing prevents it, but the per-cycle reconcile against `workspace list
  children` self-heals the (gitignored, non-git) metadata drift. If the coordination
  substrate ever becomes concurrent (a background-poller instead of ScheduleWakeup), add
  an advisory lockfile (`fs.openSync(path, 'wx')` + stale reclaim) BEFORE relying on it.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/skills/devswarm-skill.test.js`
Expected: PASS (Claude-skill subtest).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/skills/orchestration/SKILL.md tests/skills/devswarm-skill.test.js
git commit -m "docs(devswarm): add WP/WC workspace-tier section to the orchestration skill"
```

---

### Task 8: Codex orchestration skill — OMX-native DevSwarm workspace-tier section

**Files:**
- Modify: `plugins/anti-hall/codex/skills/anti-hall-orchestration/SKILL.md` (append a new section at the end)
- Test: extend `tests/skills/devswarm-skill.test.js`

**Interfaces:**
- Consumes: the same runtime contracts (Tasks 1/3/6) plus the Codex model table already in the stub. This is an **OMX-native authoring** task (NOT a paste of the Claude section): Codex has no Claude `ScheduleWakeup` or Workflow JS, so the poll is a durable-file + re-entrant-turn backoff and WC uses a flat Codex orchestration plan (`omx team` / dispatch), sharing only the platform-identical `hivecontrol` calls.
- Produces: Codex/OMX guidance + a structural test asserting the OMX section markers.

- [ ] **Step 1: Write the failing test**

Append to `tests/skills/devswarm-skill.test.js` (after the existing test):

```js
const CODEX_SKILL = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'skills', 'anti-hall-orchestration', 'SKILL.md');

test('Codex orchestration skill has an OMX-native DevSwarm workspace-tier section', () => {
  const md = fs.readFileSync(CODEX_SKILL, 'utf8');
  for (const marker of [
    'DevSwarm workspace tier',
    'Workspace-Primary',
    'Workspace-Child',
    'DEVSWARM_REPO_ID',
    'DEVSWARM_SOURCE_BRANCH',
    'DEVSWARM_AI_AGENT',
    'ANTIHALL-READY',
    'children.json',
    'check-merge',
    'merge-into-source',
    'fromBranch',
  ]) {
    assert.ok(md.includes(marker), `Codex skill missing DevSwarm marker: ${JSON.stringify(marker)}`);
  }
  // OMX-native, NOT a Claude paste: must NOT lean on Claude-only primitives.
  assert.ok(!/ScheduleWakeup/.test(md), 'Codex skill must not reference Claude ScheduleWakeup');
  assert.ok(/omx team|durable/i.test(md), 'Codex skill must describe the OMX-native poll/dispatch substrate');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/skills/devswarm-skill.test.js`
Expected: FAIL — the Codex-skill subtest fails (section absent).

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/codex/skills/anti-hall-orchestration/SKILL.md` — append at the end of the file:

```markdown
## DevSwarm workspace tier (WP / WC) — Codex / OMX

When this Codex agent runs **inside DevSwarm** (each workspace = an isolated git
worktree + its own agent), add an ORTHOGONAL workspace fan-out tier on top of the flat
Codex orchestration plan above. **Nothing here changes anything outside DevSwarm** —
every rule is gated on `DEVSWARM_REPO_ID`.

**Detect where you run** (platform-identical to the Claude port):
- **Inside DevSwarm?** `DEVSWARM_REPO_ID` set. (`hivecontrol health` exit 0 = app
  reachable only; not a role signal.)
- **Primary (WP) vs child (WC)?** `DEVSWARM_SOURCE_BRANCH` **empty/unset ⇒ WP**,
  **non-empty ⇒ WC**. `DEVSWARM_SPAWNED` is `1` on both.
- **Engine?** `DEVSWARM_AI_AGENT` (`codex` here ⇒ OMX). WP creates children with
  `-a $DEVSWARM_AI_AGENT`, so a Codex Primary spawns Codex children.

### WP (Workspace-Primary) — autonomous, ONLY when `role==='primary'` AND `hivecontrol health` exits 0

Full autonomous, same lifecycle as the Claude port but with **OMX-native mechanics**
(Codex has no Claude-side scheduled-wakeup primitive and no Claude Workflow JS):
1. **Create:** `hivecontrol workspace create <branch> -a $DEVSWARM_AI_AGENT -p "<brief>" -t "<title>"`;
   capture `worktreePath` (fallback `hivecontrol workspace info <branch>`); record
   `{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }`
   in `.anti-hall/devswarm/children.json` (gitignored; single-writer = this coordinator).
2. **Brief the child** as a WC sub-orchestrator: use a flat Codex orchestration plan
   (`omx team` / dispatch independent agents where available), keep a durable progress
   file, **do not run graphify**, **do not create child workspaces**, `message-parent` at
   milestones, and end with a ready signal whose FIRST LINE is `ANTIHALL-READY <branch>`.
3. **Caps:** `maxActive` (default 4) and `maxTotal` (active + needs-attention, default
   12; the real orphan bound — teardown is GUI-only). A `needs-attention` child is
   excluded from the active count and surfaced immediately.
4. **Poll — OMX-native backoff (2→10 min), no Claude-side scheduled-wakeup hook:**
   because Codex lacks that primitive, drive the loop off the **durable `children.json` state
   file across re-entrant turns** (record `lastPollAt`; the next turn resumes the loop) —
   never the blocking `hivecontrol workspace monitor` on the main thread. From WP's own
   cwd: `hivecontrol workspace message-count` → `hivecontrol workspace read-messages`.
   For each entry whose **`fromBranch`** matches a recorded child with an
   `ANTIHALL-READY` first line: select by **`fromBranch`** (authoritative — not the
   free-text token), then, scoped as `cd "<worktreePath>" && hivecontrol …`,
   `workspace check-merge` → only if `isMergeable && !hasConflicts &&
   targetDirectoryClean` → `workspace merge-into-source`. **Serialize merges**
   (one at a time; re-run `check-merge` fresh after each). Any conflict / error / timeout
   ⇒ mark `needs-attention`, surface, never auto-resolve, never crash the loop. Each cycle
   reconcile against `hivecontrol workspace list children`.
5. **After ALL children merged:** update the knowledge graph once (WP only). **Teardown:**
   list every workspace WP created and surface "delete these in the DevSwarm app."

### WC (Workspace-Child)

A full Codex sub-orchestrator: flat Codex orchestration plan (`omx team` / dispatch),
durable progress file, **minus** graphify and **minus** workspace creation. The
`devswarm-guard` PreToolUse hook (registered in the Codex manifest) blocks `hivecontrol
workspace create` in a child; it is a DESTRUCTIVE guard, so a blanket `all` skip cannot
silently disable it.

### Fallback & single-coordinator note

Fallback: `!inside || role !== 'primary' || health != 0` ⇒ byte-for-byte the flat Codex
orchestration above. Two simultaneous WP sessions per repo are an explicit v1 non-goal
(the per-cycle reconcile against `workspace list children` self-heals the gitignored
metadata; add an advisory lockfile only if the substrate becomes concurrent).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/skills/devswarm-skill.test.js`
Expected: PASS (both Claude and Codex subtests).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/codex/skills/anti-hall-orchestration/SKILL.md tests/skills/devswarm-skill.test.js
git commit -m "docs(devswarm): author OMX-native workspace-tier section in the Codex orch skill"
```

---

### Task 9: SessionStart role-aware injection — PREPEND a DevSwarm role block in `verify-first-full.js`

**Files:**
- Modify: `plugins/anti-hall/hooks/verify-first-full.js` (inside `main()`, right before `const out = {...}` is built)
- Test: append to `tests/hooks/verify-first-full.test.js`

**Interfaces:**
- Consumes: `detect()` from `./lib/devswarm-role.js` (Task 1).
- Produces: `main()` builds `additionalContext` as `devswarmRoleBlock() + FULL` (PREPEND, never append). `devswarmRoleBlock()`: lazy `require('./lib/devswarm-role.js')` **INSIDE `main()`** (wrapped in try/catch so a missing helper on a partial rollout fails open — emits the unmodified `FULL` protocol, never crashes SessionStart); when not inside DevSwarm or role is `null` (unknown/pathological), returns `''` (byte-for-byte unchanged outside DevSwarm — feature-detected, no hard dependency); when `role === 'primary'`, returns a ≤15-line block naming this workspace **PRIMARY (WP)** with its fan-out/graphify-ownership rules; when `role === 'child'`, returns a ≤15-line block naming it **SUB-ORCHESTRATOR (WC)** with its no-nested-workspaces / no-graphify / `ANTIHALL-READY` ready-signal rules. MUST prepend, not append — measured `additionalContext` is already ~15.3k chars, over the ~10k injection cap (KB-claude-codex.md §1.6; noted in this file's own header comment), so content appended after that point is silently truncated away; prepending guarantees the role block survives regardless of where the cap falls. This hook is registered on SessionStart with no matcher, so it already fires for every `source` (including `compact` — the survive-compaction path); this task changes nothing about that firing contract, only what `additionalContext` contains.

- [ ] **Step 1: Write the failing test**

Append to `tests/hooks/verify-first-full.test.js` (after the existing tests):

```js
// ---- DevSwarm role-aware injection (PREPENDED, never appended) ----

const CHILD_ENV = { DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'feature/x' };
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'r1' };

test('DEVSWARM: outside DevSwarm -> additionalContext byte-for-byte unchanged (no role block)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'SessionStart', session_id: 't', cwd: process.cwd() }, { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(c.startsWith('IRON LAW') || !/DEVSWARM WORKSPACE ROLE/.test(c.slice(0, 40)),
      'no DevSwarm env -> no role block prepended');
    assert.ok(!c.includes('DEVSWARM WORKSPACE ROLE'), 'no DevSwarm env -> no role block at all');
  } finally { h.cleanup(); }
});

test('DEVSWARM PRIMARY: additionalContext is PREPENDED with a PRIMARY (WP) role block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'SessionStart', session_id: 't', cwd: process.cwd() }, { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.startsWith('DEVSWARM WORKSPACE ROLE: PRIMARY'), `must be PREPENDED (start of string); got head: ${c.slice(0, 60)}`);
    assert.ok(c.includes('IRON LAW'), 'full protocol must still follow the prepended block');
    // Isolate JUST the prepended role block: it ends right where the unmodified
    // FULL protocol's fixed first line ('VERIFY-FIRST + ROOT-CAUSE PROTOCOL...',
    // verify-first-core.js CORE_LINES[0]) begins.
    const roleBlockLines = c.split('VERIFY-FIRST + ROOT-CAUSE PROTOCOL')[0].split('\n').filter((l) => l.length);
    assert.ok(roleBlockLines.length <= 15, `role block must be <=15 lines; got ${roleBlockLines.length}`);
  } finally { h.cleanup(); }
});

test('DEVSWARM CHILD: additionalContext is PREPENDED with a SUB-ORCHESTRATOR (WC) role block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'SessionStart', session_id: 't', cwd: process.cwd() }, { home: h.home, env: CHILD_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.startsWith('DEVSWARM WORKSPACE ROLE: SUB-ORCHESTRATOR'), `must be PREPENDED; got head: ${c.slice(0, 60)}`);
    assert.ok(c.includes('ANTIHALL-READY'), 'child block must name the ready-signal marker');
    assert.ok(c.includes('IRON LAW'), 'full protocol must still follow the prepended block');
  } finally { h.cleanup(); }
});

test('DEVSWARM: source="compact" inside a child still gets the prepended role block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'SessionStart', source: 'compact', session_id: 't', cwd: process.cwd() }, { home: h.home, env: CHILD_ENV, expectJson: true });
    assert.ok(ctx(r).startsWith('DEVSWARM WORKSPACE ROLE: SUB-ORCHESTRATOR'), 'compact re-injection must still prepend the role block');
  } finally { h.cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/verify-first-full.test.js`
Expected: FAIL — the 3 DevSwarm subtests that expect a role block fail (`additionalContext` has no `DEVSWARM WORKSPACE ROLE` prefix yet); the "outside DevSwarm unchanged" subtest already passes (nothing emits the marker today).

- [ ] **Step 3: Write minimal implementation**

Edit `plugins/anti-hall/hooks/verify-first-full.js` — add a helper function above `main()` (after the `FULL` const, before `function main()`):

```js
// DevSwarm workspace-role block (feature-detected; PREPENDED to additionalContext,
// never appended — see the "MUST prepend" note below). Lazy-required so a
// non-DevSwarm session pays zero cost and a partial rollout (helper missing)
// fails open silently. <=15 lines either branch.
function devswarmRoleBlock() {
  try {
    const { detect } = require('./lib/devswarm-role.js');
    const r = detect(process.env);
    if (r.role === 'primary') {
      return [
        'DEVSWARM WORKSPACE ROLE: PRIMARY (WP) -- this is the root workspace.',
        '- You may fan large, independent chunks out to CHILD workspaces via',
        '  `hivecontrol workspace create` (see the orchestration skill\'s',
        '  "DevSwarm workspace tier" section) in addition to the usual in-process',
        '  subagent tiers.',
        '- You own children.json, the poll/merge loop, and the ONLY graphify run',
        '  (post-merge, after ALL children land). Surface every conflict/timeout/',
        '  vanished child -- never silently resolve or retry.',
        '',
      ].join('\n');
    }
    if (r.role === 'child') {
      return [
        'DEVSWARM WORKSPACE ROLE: SUB-ORCHESTRATOR (WC) -- child of ' + r.sourceBranch + '.',
        '- You are a full sub-orchestrator for IN-PROCESS work only.',
        '- Do NOT create further child workspaces (devswarm-guard blocks it) and',
        '  do NOT run graphify (Primary-only, post-merge).',
        '- When done, `hivecontrol workspace message-parent` a ready signal whose',
        '  FIRST LINE is the literal marker `ANTIHALL-READY <your-branch>`.',
        '',
      ].join('\n');
    }
    return ''; // not inside DevSwarm, or role unknown/pathological -- say nothing
  } catch (_) {
    return ''; // helper missing on a partial rollout -- fail open, unmodified FULL
  }
}
```

Edit `main()` — change the `additionalContext` line inside the `out` object:

```js
  const out = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: devswarmRoleBlock() + FULL,
    },
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/verify-first-full.test.js`
Expected: PASS (all subtests, including every pre-existing one — the role block is additive-only-when-inside-DevSwarm, so a non-DevSwarm session's `additionalContext` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add plugins/anti-hall/hooks/verify-first-full.js tests/hooks/verify-first-full.test.js
git commit -m "feat(devswarm): prepend a DevSwarm workspace-role block to the SessionStart protocol"
```

---

### Task 10: Phase-1 live-acceptance verification + full-suite/CI gate

**Files:**
- No source files. Produces a verification record (report to the user + an entry in the session history ledger). This task is the design's §8 acceptance gate — it is a **verification pass**, not new code, and MUST NOT be marked done on unverified claims.

**Interfaces:**
- Consumes: everything from Tasks 1-9 (guard live, role-gates live, skills live, SessionStart role block live).
- Produces: three live proofs + one recorded decision + a green full test suite + green CI.

- [ ] **Step 1: Full local suite (authoritative pre-flight)**

Run: `node --test` (from repo root)
Expected: PASS — all suites, including every new test file (`devswarm-role`, `devswarm-guard`, `skip-guard`, `manifest-parity`, `devswarm-children`, `devswarm-skill`), the extended `verify-first-full` suite (Task 9's role-block tests), and the extended `graphify-*` / `install-codex` suites. Zero failures. Record the summary line.

- [ ] **Step 2: Live acceptance — merge-safety axiom (LOAD-BEARING for full-autonomous)**

The design's full-autonomous merge rests on "`merge-into-source` behaves as an atomic `git merge`, cannot corrupt `main`" — verified only from `--help`, never under a real conflict. In a real DevSwarm instance:
1. Create a WP + a WC child on a branch; in the child, edit a line that the Primary ALSO edits on `main` after the child branches (guarantee a real conflict).
2. From the child's `worktreePath`, run `hivecontrol workspace check-merge` — expect `hasConflicts: true` / not mergeable.
3. Force `hivecontrol workspace merge-into-source` anyway (bypassing the precondition, for the test only) and capture the result.
4. **Assert `main` is left unmodified/uncorrupted** (`git -C <primary> log --oneline` and `git status` show no partial/broken merge state; the conflict is surfaced, not silently applied).

Record the exact commands + outputs. If `main` is corrupted, this is a **blocker** — full-autonomous merge must be gated behind a manual confirmation until resolved; do NOT ship autonomous merge.

- [ ] **Step 3: Live acceptance — OMX (`-a codex`) child end-to-end**

The `-a codex` child path is unproven live. In a real DevSwarm instance:
1. From a Codex Primary, `hivecontrol workspace create <branch> -a codex -p "<brief>" -t "<title>"`.
2. Confirm the child starts, runs as a WC (does NOT create sub-children — `devswarm-guard` blocks it), does one bounded unit of work, and `message-parent`s a first line `ANTIHALL-READY <branch>`.
3. From the Primary, `read-messages` sees it (matched by `fromBranch`), `check-merge` passes, `merge-into-source` lands on `main`.

Record the transcript of commands + JSON outputs. If the Codex child cannot complete this loop, flag it as an OPEN item — do not fold it into "done."

- [ ] **Step 4: Live acceptance — devswarm-guard fires in a REAL child**

Unit tests fake the env; confirm it live: in the real Codex/Claude child from Step 3, attempt `hivecontrol workspace create nested-x`. Expect the PreToolUse `devswarm-guard` to BLOCK with the `devswarm-guard: BLOCKED` reason. Confirm the same command in the Primary is ALLOWED.

- [ ] **Step 5: Record the single-coordinator decision (design §8 requires an explicit choice)**

**DECISION (made in this plan):** concurrent WP-coordinators per repo is an **explicit v1 NON-GOAL** — NOT a lockfile in v1. Rationale: (a) the single-threaded ScheduleWakeup loop already gives the no-lost-update guarantee for one coordinator; (b) `children.json` is gitignored coordination metadata (not git state), and the per-cycle reconcile against `hivecontrol workspace list children` self-heals drift; (c) a lockfile adds stale-reclaim complexity for a scenario the workflow does not create (a user runs one Primary per repo). This non-goal is documented in BOTH skills (Tasks 7/8). **Follow-up trigger (documented, not built):** if the coordination substrate is ever changed to a concurrent background-poller (instead of re-entrant ScheduleWakeup turns), add an advisory lockfile (`fs.openSync(path, 'wx')` + stale reclaim) BEFORE that lands. Confirm both skills carry this note (already asserted structurally in Tasks 7/8).

- [ ] **Step 6: CI gate (local-green ≠ CI-green)**

Push the branch and check GitHub Actions: `gh run list --branch <branch> --limit 1` then `gh run view <id>`. Expected: all matrix legs (ubuntu/macos/windows × node 18/20/22/24) green. Only after CI is green is the feature "done." Report the run URL + status. If any leg is red, iterate — do not call the work complete.

- [ ] **Step 7: Commit the verification record (if any doc/ledger file changed)**

```bash
git add -A
git commit -m "chore(devswarm): record phase-1 live-acceptance results and single-coordinator non-goal"
```

(If no tracked file changed — the record went into the local gitignored history ledger — skip the commit and report the results in the final summary instead.)

---

## Self-Review

Run against the approved spec (`docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md`) with fresh eyes.

**1. Spec coverage.** Every §5 component maps to a task:
- §5.1 role helper → **T1**.
- §5.2 WP/WC skill section (Claude) → **T7**; Codex OMX-native section → **T8**; fallback/caps/poll/serialized-merge/teardown all captured in T7/T8 content.
- §5.3 devswarm-guard (first-line no-op, vendored parser not requiring git-guard, fire-only-in-child, fail-closed, block JSON, `isSkipped('devswarm-guard')`) → **T3**; DESTRUCTIVE add → **T2**; 3-manifest registration + parity test → **T4**.
- §5.4 graphify suppression (both hooks, lazy-require inside `main()`) → **T5**.
- §5.5 `children.json` atomic single-writer helper → **T6**.
- §5.6 tests: role truth-table (T1), guard matrix incl. message-parent/echo/heredoc/alias/multi-command/env-prefix/eval + fail-closed (T3), cross-manifest parity scoped to Bash (T4), graphify gates (T5), skip-guard DESTRUCTIVE (T2) — all present.
- §7 concurrency/merge-safety → documented in T7/T8 content + T6 helper; §8 open items (merge-safety axiom, OMX child, single-coordinator, guard-live) → **T10** live-acceptance gate.
- **T9 (SessionStart role-aware injection) is additive scope beyond this spec** — folded in post-review from a separate finding (a role-blind coordinator can misjudge PRIMARY vs SUB-ORCHESTRATOR fan-out authority at session start), not derived from the approved design's §5. It depends only on T1's `detect()` and does not change §5's component list; noted here so the spec-coverage claim above stays honest.
- **Gaps found & resolved:** §7's "optional hardening: extend `merge-gate.js` to recognize `hivecontrol … merge-into-source`" is explicitly a design OPTIONAL — deliberately **excluded** (simplest sufficient; the real backstop is the `check-merge` precondition, and merge-gate is default-off). Noted as an explicit choice below. `config.json` (maxActive/maxTotal overrides) is runtime-created state documented in the File Structure + T7 content, not a code task (no reader needs authoring — the skill guidance reads it). No spec requirement is left without a task or an explicit exclusion.

**2. Placeholder scan.** No "TODO"/"add error handling"/"similar to Task N"/"fill in" anywhere. Every code step contains complete, runnable code; every test step contains real `node:test` assertions; both doc tasks show the full section text plus a structural test. Commit messages are conventional with NO self-credit trailer.

**3. Type consistency.** `detect()` returns `{ inside, role, agent, sourceBranch }` in T1 and is consumed with that exact shape in T3 (`detect(process.env).role`), T5 (`detect(process.env).role === 'child'`). The `children.json` record shape `{ branch, id, worktreePath, title, status, dispatchedAt, lastPollAt, lastMessageAt }` is identical in §5.5, T6 (helper + tests), and T7/T8 skill content. `devswarm-children.js` exports `{ childrenPath, read, write, update }` in T6 and are consumed by those names in its test. The guard's block contract (`{"decision":"block","reason":...}` + exit 2) matches command-guard's exemplar and the T3 test's `assertBlock`. The ready-signal marker `ANTIHALL-READY <branch>` and the `fromBranch` selection key are spelled identically across T7/T8 content and asserted in the T7/T8 structural tests.

## Explicit choices made where the spec allowed latitude

- **Block emission form:** `devswarm-guard` uses the `{decision:'block',reason}`-on-stdout + exit 2 form (command-guard / model-routing-guard exemplar), written via `fs.writeSync(1, …)` to dodge the macOS node 18/20 async-flush truncation race — rather than git-guard's exit-2 + stderr form. The spec said "standard anti-hall block JSON," which is the JSON form.
- **Parser-robustness forms are POSITIVE blocks, not allows:** the spec's test-list sentence bundled "multi-command / env-prefixed / eval-wrapped" ambiguously. Interpreted as: a REAL create hidden behind a segment operator, an env prefix, or `eval` MUST still be caught in a child (security-correct, matches git-guard's unwrap philosophy); only genuine data forms (echo/heredoc/quoted payload, non-create subcommands, a `create` flag-value) are allowed. Flagged so a reviewer can veto if the intent was the opposite.
- **`merge-gate.js` extension excluded** (design §7 "optional"): kept out to honor scope-fidelity; the `check-merge` precondition is the sufficient backstop.
- **Single-coordinator = explicit non-goal, no lockfile in v1** (T10 Step 5): chosen over adding a lockfile, matching §7's "assumed-away non-goal for v1," with the exact follow-up trigger documented.
- **Doc tests live in a new `tests/skills/` dir** (`node --test` discovers `*.test.js` repo-wide) rather than being wedged into an unrelated hook test file.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session via superpowers:executing-plans, batch execution with checkpoints.

Which approach?
