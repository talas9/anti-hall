# Changelog

All notable changes to the anti-hall plugin are documented here. The plugin pins an
explicit `version` in `plugin.json` only (the authority); the marketplace entry carries
no `version` to avoid the silent-precedence trap where `plugin.json` wins silently. Every
behavioral change MUST bump `plugin.json` `version` or installed users will not receive
the update.

## 0.26.0

**Structured-return discipline (rule G) made concrete + measured.**

Rule G (SYNTHESIZE, NEVER RELAY) already required subagents to return tight summaries
under an OUTPUT BUDGET. This release makes the SUBSTANTIAL-return case concrete and grounds
it in measurement, with no mechanical or behavioral change to any guard.

- **Schema now specified.** For a SUBSTANTIAL return (a review/audit/research dump, many
  claims), rule G now names the exact compact shape to require:
  `{claim, evidence:"file:line", verdict, blockers/uncertainty, next}`.
- **Measured, not asserted.** A deadly-loop-hardened study (S4) measured these structured
  subagent returns at **~5× smaller than verbose prose with zero decision-relevant loss**,
  judged on a claim/evidence/uncertainty/blockers/next rubric (N=8, directional). Rule G
  cites the figure inline.
- **Reconciles the earlier ~1.4× number.** The prior pilot's ~1.43× density figure measured
  *small, already-summarized* content (where a schema is a minor lever, and JSON overhead can
  make tiny outputs LARGER). The ~5× figure is for *verbose* returns. Both hold; they measure
  different inputs. The **prose-for-tiny caveat is kept** — a single prose line still wins for
  a SMALL result; do not impose JSON there.
- **Enforce, don't just request.** Rule G notes that passing a **schema to the Agent/Task
  tool** validates the structured return rather than merely asking for it. The biggest levers
  remain the output budget + no-raw-relay rule; the schema is the multiplier on large returns.
- The per-turn SYNTHESIZE nudge (#57) was updated in place to carry the schema + the ~5×
  figure. Nudge count unchanged (**17**).

No guard mechanics or hook behavior changed — this is prompt discipline (rule G text + one
nudge) only. `node --test` green: 316 passing (+2 platform-skipped), 318 total.

## 0.25.2

**CI green on all platforms — root-cause fixes for the macOS stdout race and Windows base-command env.**

0.25.1's test-gating fixes were incomplete; CI stayed red on macOS node 18/20 and all
Windows legs. Root-caused properly (from real CI logs) and fixed at the source:

- **macOS (hook source fix):** `verify-first-full.js` and `graphify-session.js` emit a
  ~10 KB JSON payload, then `process.exit(0)`. On a pipe, `process.stdout.write` is async
  once the payload exceeds the OS pipe buffer, so `exit(0)` could race the flush and the
  reader saw empty/partial stdout (intermittent on macOS node 18/20). Switched both to a
  blocking `fs.writeSync(1, …)` so every byte is handed to the pipe before exit. The
  test-side `expectJson` retry is kept as defense-in-depth and corrected to re-spawn on
  any parse failure (empty OR partial), not just empty.
- **Windows (test harness fix):** the statusline base-command test starved `cmd.exe` with
  a stripped env (a hand-picked `SystemRoot/ComSpec/PATHEXT` allowlist was insufficient),
  so the base command failed and the dispatcher fell back. The statusline test harness now
  inherits the full parent env and overrides only the HOME-pointing vars (statusline
  scripts read no Claude Code markers, so only HOME needs isolating).

No user-facing behavior change beyond more reliable hook stdout. `node --test` green on
Ubuntu, macOS, and Windows × Node 18/20/22/24.

## 0.25.1

**CI fix — cross-platform test gating. No plugin behavior change from 0.25.0.**

The 0.25.0 test suite passed locally but failed on CI macOS + Windows: all failures were
test-side environment assumptions, not plugin bugs (source behavior is correct on every
platform). Fixed test-side only:

- **macOS:** a graphify reflected-path test asserted a substring (`graphify-out`) that the
  hook's 80-char `sanitizePath` cap truncates under CI's long `/var/folders/.../T/` tmpdir
  (passed locally only because the dev tmpdir is short) — now asserts the always-in-cap
  base-dir name. Added an opt-in single retry for a macOS `spawnSync` empty-stdout pipe
  flake on the large-JSON SessionStart hook (node 18/20).
- **Windows:** install-reaper `--dry-run` tests now assert the `win32` no-op message
  (the installer correctly short-circuits before reading flags); tests that `mkdir` a
  directory whose name contains characters illegal in Windows filenames (`"`, control,
  bidi) are `win32`-skipped; statusline base-command tests invoke `node "<abspath>"`
  (survives both `sh -c` and `cmd /c`) instead of a nested-quote `node -e`.

Net: `node --test` green on Ubuntu, macOS, and Windows × Node 18/20/22/24.

## 0.25.0

**Always-on SCOPE & FIDELITY discipline + an opt-in mcp-reaper companion (macOS + Linux).**

**A — SCOPE & FIDELITY discipline (prompt layer).** A new always-on discipline injected by
the SessionStart protocol (`verify-first-full.js`) and reinforced by 2 new per-turn nudges
(`verify-first.js`, NUDGES 12 → 14; later 14 → 15 with the verify-delegated-work nudge in
section C). It enforces: solve the ACTUAL problem with the
**simplest sufficient solution** (over-engineering is confabulating work the user never asked
for); **intent over letter** (serve what the user means; do the small reading and say what you
skipped rather than guess-big); **confirm before expanding scope** (new platform / file /
dependency / phase / abstraction); **match rigor to blast radius** (heavy process is for risky
or large work, not a reflex on small asks); and **finish what was asked / drop nothing
silently**. It is now named in the "ALWAYS APPLY" disciplines list alongside
root-cause / orchestration / anti-sycophancy, and mirrored in `AGENTS.md` for Codex.

**B — mcp-reaper companion (OPT-IN, macOS + Linux).** A new pure-Node background **companion**
(NOT a hook — an interval job via a macOS LaunchAgent / Linux `systemd --user` timer, cron
fallback) that kills **orphaned** MCP-server processes — ones leaked when their spawner (a
Claude / codex / npm / node session) exits without cleaning them up (on macOS these reparent
to launchd and pile up over a workday). Files: `companion/mcp-reaper.js`,
`companion/install-reaper.js`, `companion/README.md`. Install with
`node plugins/anti-hall/companion/install-reaper.js` (`--uninstall` to remove). Env knobs:
`MCP_REAP_DRYRUN=1`, `MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`
(regex of cmd substrings to NEVER reap). Also recognizes **Python MCPs** (`uvx`/`uv` +
underscore `mcp_server_*` forms), not just Node.

- **Safety invariant:** a process is reaped only if its command matches a generic MCP
  signature **and** its parent is a reaper/init (pid1 / launchd / `systemd --user` / WSL
  `Relay()`). Because Unix always reparents a dead process's children, a *live* MCP's parent
  is always a live spawner — never a reaper — so "parent is a reaper" means the spawner died,
  i.e. the MCP is a true orphan. Killing an in-use server is impossible by construction.
- **Limitation — service-managed MCPs:** an MCP run as a macOS LaunchAgent / `systemd --user`
  unit / other OS service shares init (ppid 1) as a parent **while alive** — indistinguishable
  from a leaked orphan — so it could be reaped. Exclude it via
  `ANTIHALL_REAPER_EXCLUDE='your-service-name|another'` (case-insensitive regex of cmd
  substrings that are never reaped).
- **Windows is a documented no-op (rescope rationale):** Windows has no parent-death
  reparenting **and** recycles PIDs, so external orphan detection is unsafe there — a matched
  signature on a recycled PID with an `init`-ish parent could kill an unrelated live process.
  The correct fix on Windows is **Job Objects set by the spawner**, which a companion cannot
  do. So the installer prints why and installs no scheduler.

**C — VERIFY DELEGATED WORK discipline (prompt layer).** Orchestration now requires the
coordinator to **independently verify delegated work** — a subagent's "done / fixed / tests
pass / N passing" is an UNVERIFIED CLAIM, never a fact. Before marking any delegated task
complete, the coordinator RE-RUNS the authoritative check (or dispatches a separate verifier)
and reconciles multiple workers against GROUND TRUTH, not against each other. Added as rule L
in `verify-first-full.js`, folded into the "ALWAYS APPLY" orchestration summary, mirrored in
`AGENTS.md`, and reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 14 → **15**).

**D — Background-default orchestration (prompt layer).** Orchestration now defaults delegated
heavy/parallel/long work to the **background** (the coordinator passes `run_in_background`
itself) so the user needn't background it manually, while still verifying each on completion —
never fire-and-forget. Extended into rule F in `verify-first-full.js`, mirrored in `AGENTS.md`,
and reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 15 → **16**).

**E — Fix-history ledger discipline (prompt layer).** The `tasklist-guard` Stop reminder now
also prompts appending each **completed task** to `.anti-hall-history.md` — an append-only fix
ledger (one entry per task: **Cause / Fix / Verified**) so the fix history persists for the
knowledge layer. Same reminder, enriched (no new hard Stop-block condition), fully fail-open.
Mirrored as full-protocol text in rule B of `verify-first-full.js` and documented in
`docs/TASKLIST-GUARD.md` / `docs/KB.md`. The hook never creates the file — it is gitignored,
local session state.

**F — Message-context bloat prevention (#45, prompt layer).** Orchestration rule G is rewritten
from "synthesize, don't paste raw output" into **SYNTHESIZE, NEVER RELAY**: the coordinator
reports findings in its own words and NEVER pastes a subagent's raw return into the user thread
(that verbatim relay is the **#1 cause of message-context bloat**), and subagents must return
TIGHT summaries under an explicit **OUTPUT BUDGET** (findings only; a compact
`{claim, evidence:"file:line", verdict}` schema only when >~5 claims or >~200 tokens, else one
prose line). Reinforced by 1 new per-turn nudge (`verify-first.js`, NUDGES 16 → **17**).
**Pilot finding:** a
compact JSON return schema is only **~1.43× denser than prose on average** (and *worse* for
tiny outputs), so schema enforcement is a MINOR lever — the real levers are the output budget +
the no-raw-relay rule, which is why this ships as prompt discipline, not a schema-enforcement
system. A `PostToolUse`-on-`Task` hook to flag oversized subagent returns was evaluated and is
**NOT feasible**: per the Claude Code hook contract (KB-claude-codex §1.4), `PostToolUse` stdout
/`additionalContext` never reaches the model and `PostToolUse` cannot block — so it cannot
inject a reminder back. No hook was faked; the discipline is the mechanism.

Suite 318 total, **316 passing** (+2 platform-skipped).

## 0.24.1

**Doc-currency pass — descriptions + test counts brought to current reality.**

No behavioral change. The `plugin.json` and `marketplace.json` descriptions predated
api-guard and the v0.24.0 gh-PR guard — both now name the two signature mechanical guards
(api-guard: fabricated-API blocking, opt-in 3rd-party; git-guard: AI self-credit in commits
**and** gh pr/issue/release bodies). Test-count references corrected to **173** across
README (root + plugin), `llms.txt`, and `docs/KB.md`; KB snapshot provenance refreshed to
post-0.24.0.

## 0.24.0

**git-guard now also blocks AI self-credit in `gh` PR / issue / release bodies.**

Previously git-guard blocked AI co-author trailers in `git commit` only; PRs created
with `gh pr create --body "… 🤖 Generated with Claude Code …"` slipped through. Now the
same self-credit markers (the `🤖 Generated with [Claude Code](…)` footer, `Co-Authored-By:
Claude`, `noreply@anthropic.com`, a bare `claude.com/claude-code` link) are blocked in the
inline `--body`/`--title`/`--notes` of `gh pr|issue|release create|edit|comment`. Reuses the
existing commit markers + a bare-link marker; quote/segment-aware via git-guard's tokenizer.
Inline values only — `--body-file`/`-F` and heredoc/command-substitution bodies put the text
off the command line and are a documented fail-open limitation. +8 gh tests; suite 173/173.

## 0.23.0

**api-guard v2 — opt-in 3rd-party API verification + security hardening.**

api-guard can now verify installed **3rd-party** packages (pandas, lodash, …) — the
highest-hallucination class (38–80% per the literature) — not just stdlib/builtins.
But a double deadly-loop (2 Opus + 2 Codex) **proved that verifying a 3rd-party
package = importing it = running its top-level code at edit time** (a confirmed RCE,
triggered even when the write is blocked; Codex bypassed the first fix via bare
`node_modules` packages and `.pth` files). You cannot check an installed package's
API without executing it. So 3rd-party checking is **opt-in, off by default**:

- **Default (unchanged):** stdlib/builtin modules + JS globals only — importing those
  to introspect is side-effect-free, so the probe never runs untrusted code. Safe.
- **Opt-in:** set `ANTIHALL_API_GUARD_THIRDPARTY=1` to also verify installed packages,
  accepting that referenced installed packages are imported at edit time.

**Security hardening (both modes):**
- Local/relative modules are NEVER probed: path-spec rejection (`./x`, `/abs`, `..`,
  `C:\`), Python probe runs with `cwd=<tmp>` + scrubs cwd/`''` from `sys.path`, so a
  bare `import localmod` can't resolve to a repo file.
- `SAFE_ENV` now also strips `PYTHONUSERBASE`/`PYTHONSAFEPATH`, and the Python probe
  runs with `-s` (no user site) — closes the `.pth` startup-exec vector.
- Batched **one import per module** (not per attribute); **30s wall-clock deadline**
  under the hook timeout (raised 30→45s); JS requires extracted from comment-stripped
  code; function/lambda-parameter and `with/except as` names excluded from checking
  (no false-block on `def f(pd): pd.x`).

165 tests (3rd-party gated + RCE-no-execute regression), bench 21/21 catch / 0 FP.
Known v2.1 gaps (fail-open, documented): dotted-submodule receivers (`os.path.x`) and
JS member chains (`fs.promises.x`) are not yet checked.

## 0.22.2

**Fix: api-guard CI flake on Windows/node (probe timeout too tight).**

After 0.22.1 the windows-latest leg still flaked intermittently (same commit green on
`main`, red on the tag run): a COLD `python`/`node` spawn on a loaded Windows runner
occasionally exceeded the `1500ms` probe timeout → the check timed out → fail-open →
the `asyncio.run_all` test expecting a block got an allow. Raised `SPAWN_TIMEOUT_MS` to
`5000ms` (a CEILING, not added latency — a normal spawn returns in <300ms; this just
stops us giving up too early on a cold start), lowered `MAX_CHECKS` 12→6 to keep the
worst case bounded, and bumped the hook's outer timeout 30→45s for headroom. Suite
159/159.

## 0.22.1

**Fix: api-guard now works on Windows (CI was red on the windows-latest matrix legs).**

The probe env was a PATH-only allowlist, which is secure but too minimal for Windows —
Python could not spawn without `APPDATA`/`LOCALAPPDATA`/`TEMP`/etc., so `pyBin()` returned
null and the hook fail-opened (Python fabrications silently allowed) on Windows. Changed
`SAFE_ENV` to a **denylist**: the full parent environment minus the interpreter-injection
vectors (`NODE_OPTIONS`, `NODE_PATH`, `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`,
`PYTHONINSPECT`, `PYTHONEXECUTABLE`). Keeps the security property (a poisoned env can't
influence the existence check) while letting Python spawn on every OS. Suite 159/159;
the exact failing case (`asyncio.run_all`) now blocks. Doc-only follow-up `547e184`
(corrected stale test counts to 159) also rolled up here.

## 0.22.0

**`api-guard` — a mechanical guard against API hallucination, built on eval evidence.**

A controlled A/B eval (see [`eval/`](eval/)) established that the verify-first *prompt*
does not reliably reduce API fabrication: across four rounds (incl. a powered 122-trap,
tools-on run with a naive baseline) the protocol netted **no statistically-significant
reduction** (McNemar p=0.26), and the model ran a verification tool only ~5% of the time —
*the same as baseline*. The model ignores "go verify." So this release does the verifying
mechanically:

- **`api-guard`** (new) — a `PreToolUse` hook on `Write`/`Edit`/`MultiEdit`. It extracts
  `module.attribute` references from the code about to be written and resolves them against
  the **installed** runtime (`python3` / `node`): Python stdlib `mod.attr` and `from mod
  import Name; Name.attr` (via `hasattr`), Node builtins `require('mod').attr`, and JS
  global builtins incl. `.prototype.attr` (via `typeof`). If a real module/object is missing
  the referenced attribute, the write is **blocked** — the symbol was fabricated.
  - **Substantiated: 100% in-scope catch, 0 false positives** on a committed, reproducible
    bench — `node eval/api-guard-bench.js` (labeled corpus + a sweep of every `plugins/**.js`).
    Contrast the prompt's unproven ~18%.
  - **Fail-open by construction:** blocks ONLY on a positively-verified missing attribute;
    any uncertainty (no interpreter, import error, 3rd-party package, receiver-typed instance
    method, version skew) → allow. From-import bindings resolve before module names so
    `datetime.fromisoformat` (class method) is not mistaken for a module attribute.
  - **Hardened by a double deadly-loop (2 Opus + 2 Codex) + empirical sweep.** Security review
    found injection/ReDoS/resource genuinely closed. Correctness review found and fixed a P0
    false-positive cluster: stdlib/global names used as **local variables** (`array = [1,2];
    array.append(3)`, `const Math = myLib; Math.x`), require-vars **reassigned** to a 3rd-party
    (`fs = require('fs-extra')`), and from-import names rebound — now all resolve correctly
    (require a real `import`; exclude locally-bound names). Added `Buffer` to JS globals;
    `python` (3.x) fallback for non-`python3` systems; probe env pinned to PATH-only.
  - Skip-hatch via `~/.anti-hall/skip.json` (`api-guard`); 27 tests (block/allow/fail-open/
    scope/skip/regression/shadowing/portability), `python3`-gated for Windows CI. Full suite **159/159**.
- **eval/** harness added: `claude -p` subscription backend (no API key), naive-baseline +
  tools-on knobs, 122 execution-verified traps, `analyze.js` (McNemar exact + bootstrap CI).
  Documents the honest finding that prompt-only fabrication reduction is unproven.

## 0.21.1

Refresh marketplace.json plugin description to current capability set (tasklist-guard, skip-guard, deadly-loop-multi, speculation guards, rule K, escape hatch) for the public listing; add assets/demo/ (VHS .tape + storyboard) to generate a demo GIF.

## 0.21.0

Pre-publish **triple-deadly-loop** hardening pass (3 Opus reviewers + 3 Codex critics, two re-converge passes) before the first public release. Closes a cluster of deliberate-evasion gaps in the always-on guards and the reflected-text sanitizers:

- **git-guard** — now blocks AI/assistant self-credit trailers slipped in via `git commit --trailer`, including the `key=value` separator form (`Co-Authored-By=Claude <…>`) alongside the `key: value` form, and a `-c trailer.<name>.key=<self-credit>` remap that would emit a `Co-Authored-By` / `Generated-with` trailer from a benign-looking custom token. Benign trailers (`Reviewed-by=Alice`, `-c trailer.sob.key=Signed-off-by`) still pass.
- **tasklist-guard** — fail-open when the state dir is unwritable instead of wedging.
- **swarm-guard** — steals a zero-byte / corrupt lock instead of deadlocking, and resolves `vm_stat` by absolute path.
- **graphify-reminder** — bounds the `git rev-parse` probe with a timeout.
- **sanitizers** — reflected-text + terminal-control + **Unicode bidi** hygiene across `graphify-guard`, `graphify-session`, `speculation-judge`, and both statuslines: bidi overrides (U+202A–U+202E) and isolates (U+2066–U+2069) are now stripped so a crafted path/claim can't visually reorder terminal/model output. Regexes stay linear (no ReDoS); legit UTF-8 and branch names are preserved.
- **docs** — accuracy fixes (`KB.md` → `0.21.0`, `TASK-WORK` >1/checks wording, README statusline + doctor list, E2E +24.x); README badges (tests / version / license / node / plugin).

Accepted residuals (deliberate evasion of a safety net, documented not closed): `base64 | sh`, pipe-to-shell, process-substitution, deeply-nested `eval`, `commit -F <file>` / editor commits, and Unicode-confusable token swaps. These require an adversary actively defeating their own guardrail and are out of scope for a fail-open static hook.

## 0.20.3

Add RELEASING.md — the ordered release + doc-currency checklist the agent follows on every ship (manual tagging by agent, no CD); pointer from AGENTS.md.

## 0.20.2

Doc currency sync — `llms.txt` + `plugins/anti-hall/README.md` were stale (predated tasklist-guard / skip-guard / rule K); added the missing hooks (`tasklist-guard`, `skip-guard`, `command-guard`, `swarm-guard`, `phase-tracker`, `agent-watchdog`), the user-override escape hatch, rule K output-presentation, the E2E test suite + CI, and the new docs (`CONTEXT-PRESERVATION-KB`, `TASK-WORK`, `TASKLIST-GUARD`, `KB`, `E2E-TESTING`). Fixed "four Stop hooks" → five. CHANGELOG + tests were already current.

## 0.20.1

- orchestration skill gains a concise "References & context guardrails" section —
  points to `docs/CONTEXT-PRESERVATION-KB.md` (the swarm-researched context-discipline
  KB) and the findings-discipline (externalize durable findings to memory, case
  findings to `.anti-hall-progress.md`; compact early once externalized; context-rot
  sweet spot is a cadence not a length). Outcome of a deadly-loop on 3 candidate
  context enhancements: the other two (an always-on findings protocol line, a
  statusline pressure cue) were DROPPED as footprint regression / redundant with the
  existing color gradient + native Auto Memory; only the skill-reference survived.

## 0.20.0

New `tasklist-guard.js` Stop hook + a per-turn freshness note (in `task-tracker.js`) that enforce live task-list + fresh `.anti-hall-progress.md` discipline for non-trivial work, so real work is tracked and never silently dropped or declared-done by a later agent. It **coexists with `task-guard`** (which drains declared tasks); each keeps an independent block cap so the two never compound.

- **When it blocks (Stop):** ≥ `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default 3) file-mutating actions (`Edit`/`Write`/`MultiEdit`/`NotebookEdit` + mutating `Bash`) AND (no task activity for it, OR more than one task `in_progress`, OR no fresh `.anti-hall-progress.md`). Blocks via `{decision:"block"}` (never exit 2 — plugin Stop hooks don't reliably continue on it), capped at `MAX_BLOCKS=3` cumulative per session, fully fail-open.
- **Progress file:** `<cwd>/.anti-hall-progress.md` (done/in-progress/next), must be updated this session to count fresh (window `ANTIHALL_PROGRESS_FRESH_MS`, default 30 min). Gitignored, never ships; the hook never creates it.
- **Per-turn freshness note:** when open/stale tasks exist, `task-tracker` injects a one-line reminder (open-task count + oldest `in_progress` subject).
- **Escape hatch:** `~/.anti-hall/skip.json` `{"tasklist-guard": <unix-ms expiry>}` (or `"all"`) via the shared skip-guard, or ask the agent to skip.
- **Hardened via 2 deadly-loop passes (Opus + Codex):** multi-`in_progress`-only staleness (a single `in_progress` — the healthy flow — never false-blocks), emit-before-persist (a state-write failure can't retract an emitted block), `lstat` + `isFile` progress check (rejects a dir/symlink named like the file), cwd-missing fail-open, command-position-aware + broadened `Bash` work regex (ReDoS-safe), task-subject injection neutralized via `JSON.stringify`.
- **Coverage:** 120-test E2E suite incl. 21 `Bash`-regex cases; `doctor` gains a tasklist-guard self-test (4 edits, no tasks, no progress file ⇒ block).
- **Accepted deferrals (fail-open by design):** cumulative work counters vs the 512 KB transcript tail-clip (work before the window is unseen, can only *suppress* a block — the safe direction); sync-I/O stall on a network-mounted cwd (the 30 s hook timeout makes a non-block the outcome).
- New doc [`docs/TASKLIST-GUARD.md`](docs/TASKLIST-GUARD.md) (usage); README + `docs/KB.md` pointers added.

## 0.19.0

Strengthened deadly-loop auditor instructions with explicit depth requirements to prevent surface-skimming and ensure genuine issue discovery. Both `deadly-loop` and `deadly-loop-multi` skills now mandate:

- **DIG DEEP.** Read full implementations end-to-end, trace control and data flow across files, follow every branch and error path. Never judge from names, signatures, or diff hunks. Cite file:line ranges actually read.
- **ENUMERATE & SIMULATE EDGE CASES.** Systematically exercise boundary conditions, empty/malformed/oversized/unicode/concurrent inputs, missing files, permission denials, clock skew, truncation, and injection-shaped data. Mentally execute or write throwaway harnesses; report predicted outcomes.
- **REAFFIRMED 3-TIER SEVERITY.** P0/P1/P2 categories (plus EASY-WIN) ranked by heat — correctness > reliability > ergonomics.
- **CARRY-FORWARD DISCIPLINE.** Verify each prior finding's fix resolved without regression before hunting genuinely NEW issues. Distinguish new discoveries from re-reported findings.

For `deadly-loop/SKILL.md`: added new "B0. Auditor depth requirements" section with B1/B2 forward pointers. For `deadly-loop-multi/SKILL.md`: expanded the mandatory brief-footer and step-6 reconverge to enforce carry-forward discipline across iterations. Auditor reviews now drill into implementation to surface root causes instead of polish-layer issues.

## 0.18.0

Performance: trimmed the always-on SessionStart protocol (`verify-first-full.js`) footprint by
condensing VERBOSE PROSE ONLY — every rule, every rationalization trigger phrase, all orchestration
labels A-K, the USER OVERRIDE mechanism, and the DISCIPLINES section are preserved verbatim. The
SessionStart injection dropped from 8074 B to 7474 B (~7.4 KB, ~160-180 tokens saved) with zero
efficacy loss. Hardened by a new 77-test zero-dep E2E net that asserts every marker is present (so a
dropped rule fails the build), plus TWO deadly-loop passes (Opus reviewer + Codex critic) that caught
8 semantic nuances the trim over-cut and restored them. Also fixed a stale "compact-matcher" comment
in `verify-first.js` to match the verified no-matcher SessionStart mechanism. Net: smaller one-time
injection, identical protocol.

## 0.17.1

Bug fix: task-tracker self-heals corrupted or future throttle state. A future or non-finite
`lastFull` timestamp (from clock skew, manual edit, or corruption) previously left the throttle
window permanently "within window", so the full task directive never re-showed. The throttle now
detects a future-beyond-tolerance (5 min) or non-finite value as window-expired and rewrites
the state to now, allowing the full task output to surface again on the next turn.

## 0.17.0

Tier-B guard hardening. Tightens the static command analysis so a quoted data literal is no
longer mistaken for a heavy command, and unwraps a single `eval` payload so a guard sees the
real command it would run — in both command-guard and git-guard.

- **command-guard is quote-aware.** Heavy-pattern matching now distinguishes a heavy command
  from a heavy-looking string literal: `echo "npm run build"` / `printf 'go test ./...'` pass a
  quoted data argument and are no longer false-blocked in the coordinator, while an unquoted
  heavy command (`npm run build`), a command-substitution payload (`echo "$(npm run build)"`),
  and a `bash -c "npm run build"` wrapper still block. The intent is to stop flagging strings
  that merely *contain* a heavy verb without losing any real execution path.
- **`eval` payload unwrapping in BOTH command-guard and git-guard.** A single `eval "…"` is now
  unwrapped and its inner command re-scanned, so `eval "npm test"` blocks in the coordinator and
  `eval "git push -f"` is caught by git-guard, instead of slipping past as an opaque `eval`
  argument. `eval "echo hi"` / `eval "git status"` still pass.
- **Known residual gaps (accepted, by design).** `base64 | sh`, process-substitution
  (`<(…)`), and `git commit -F <file>` trailer smuggling remain accepted defense-in-depth gaps:
  they cannot be closed by static inspection without over-blocking legitimate use. The guards are
  a safety net against the common slip, not a sandbox — a determined evasion is out of scope.

## 0.16.0

Round-2 Tier-A guard hardening, surfaced by the double deadly-loop on the round-1 changes.
Closes the fail-closed and OOM cases that could wedge or crash a guard, and seals two guard
evasion paths the round-1 hardening missed.

- **swarm-guard memory gate fails OPEN, not closed.** The free-memory parser previously fell
  back to `os.freemem()` on a parse failure, which on some platforms reports near-zero and
  could block every spawn (fail-closed safety guard left silently disabled is the opposite of
  what a coordinator wants). It now SKIPS the memory gate entirely when the platform memory
  read can't be parsed, so a spawn is never blocked on bad telemetry.
- **swarm-guard lock uses an owner token — no blind `unlink`.** The advisory spawn lock now
  writes an owner token and only releases a lock it actually owns, instead of blindly
  `unlink`-ing whatever lock file is present (which could stomp a concurrent holder).
- **Bounded transcript tail-reads (512 KB) — OOM guard.** `speculation-guard.js`,
  `speculation-judge.js`, `task-guard.js`, and `graphify-reminder.js` previously
  `readFileSync`'d the entire transcript; a long session could grow that to hundreds of MB and
  OOM the hook. They now tail-read only the last 512 KB, which is more than enough for the
  recent-turn inspection each performs.
- **task-guard subject sanitization.** The task subject is now sanitized before it is echoed
  into the block reason, closing a reflected-content path.
- **graphify rev-parse timeouts (2000 ms) + non-echoing block reason.** `graphify-session.js`
  and `graphify-guard.js` now bound their `git rev-parse` calls at 2000 ms so a wedged git
  can't hang the hook; `graphify-guard.js` no longer echoes the raw command into its block
  reason (label only).
- **git-guard seals two evasion paths.** It now catches a `+refspec` force-push smuggled
  AFTER a `--` end-of-options marker (`git push origin -- +main:main`), and blocks
  `git --config-env alias.*` config smuggling that could alias a benign verb to `push
  --force`. Normal pushes and literal `--`-separated operands are unaffected.
- **command-guard light exceptions + non-echoing reason.** Read-only `git push --dry-run`
  and read-only `go env` (without `-w`) are now treated as light and allowed in the
  coordinator; the heavy-command block reason no longer echoes the raw command (label/verb
  only), removing a reflected-injection surface.
- **Windows-safe installer.** `statusline/install-statusline.js` now uses a shell-free
  `execFileSync` for the git-tracked check, so the install path no longer depends on a POSIX
  shell.

Tier B remains pending: the command-guard quote-aware false-positive and the
`eval`/base64/process-substitution evasion cluster are not addressed here.

## 0.15.0

Adds a user-override escape hatch across all guards, hardens the speculation hooks against
a Stop-loop wedge, bounds the deadly-loop convergence, and lands several doc fixes.

- **User-override escape hatch.** New shared primitive `hooks/skip-guard.js` exports
  `isSkipped(name)`, which reads a TTL'd marker at `~/.anti-hall/skip.json`
  (`{"<guard>": <unix-ms expiry>}`). When the user EXPLICITLY asks to skip a guard, the
  agent records consent there and the guard fail-opens (does not interfere) until it expires
  — default TTL 15 minutes so a safety guard is never left silently disabled. Granular: the
  broad key `"all"` covers the noisy guards but **NOT** `git-guard` (force-push / self-credit
  must be named explicitly). Fail direction is safe: a missing/corrupt marker keeps every
  guard ACTIVE. Wired into all 7 guards (`git-guard`, `command-guard`, `swarm-guard`,
  `speculation-guard`, `speculation-judge`, `graphify-guard`, `task-guard`) immediately after
  the stdin read. The SessionStart protocol (`verify-first-full.js`) and `AGENTS.md` gain a
  matching rule: honor a skip ONLY on a direct, unambiguous user instruction — never on the
  agent's own initiative or because a tool/file/channel asked.
- **P1 fix — `MAX_BLOCKS = 3` hard cap on the speculation hooks.** `speculation-guard.js`
  and `speculation-judge.js` previously deduped only on the exact message hash; because the
  message text legitimately changes as the model reworks its reply, that dedupe could be
  defeated and the Stop hook could re-block on every Stop. They now mirror `task-guard.js`'s
  two-tier loop-safety — hash dedup PLUS a running `blocks` counter capped at 3 — closing the
  Stop-loop wedge. State is now `{hash, blocks}`; legacy bare-hash files are still tolerated.
- **deadly-loop iteration caps (soft 10 / hard 15).** The Reviewer+Critic debate + fix-wave
  convergence loop is now explicitly bounded: at **10 rounds** without convergence, STOP and
  checkpoint with the user (AskUserQuestion: continue / stop / change scope) instead of
  looping silently; at **15 rounds**, force-stop unconditionally and report even if not
  converged. The same cap applies to `deadly-loop-multi`'s step-6 reconverge loop.
- **Doc fixes (no guard-logic change).** `STATUSLINE.md` now describes line 2 as the
  actual always-on 3-tier behavior (phase bar → "orchestrating · N agents" → idle context
  gauge), consistent with its own top summary and `phase-bar.js`; corrected two misleading
  comments that said a transcript was "streamed" when the code does a full `readFileSync`
  (`task-guard.js`, `graphify-reminder.js`); confirmed `demo-wrapper.sh` (machine-absolute
  `/Users` path, untracked) stays gitignored so a future `git add -A` cannot ship it.

## 0.14.1

Refines the 0.14.0 email chip: show-when-available with an opt-OUT, instead of opt-in.

- **The `✉ <email>` chip now renders whenever the account email is available**
  (read from `~/.claude.json`), rather than requiring `ANTIHALL_STATUSLINE_EMAIL=1`.
  Since a signed-in user almost always has an email, the opt-in gate was effectively
  "never shows unless you know the flag." Inverted to a privacy opt-OUT:
  set **`ANTIHALL_STATUSLINE_NO_EMAIL=1`** (or any non-`0`/`false` value) to hide it —
  e.g. for screenshots or screen-shares. Fail-open: no chip when the email can't be read.

## 0.14.0

Adds an opt-in account-email chip to the rich statusline.

- **`statusline-rich.js` can now show a `✉ <email>` chip** as the last line-1 segment,
  reading the signed-in Claude account email from `~/.claude.json`
  (`oauthAccount.emailAddress`). **OFF by default** and gated behind the
  `ANTIHALL_STATUSLINE_EMAIL` env var (set to `1`/any non-`0`/`false` value to enable) —
  the plugin must never surface a user's email on their statusline without explicit
  consent. New `getClaudeEmail()` helper; pure file read, fail-open (no chip on any error).
  This brings the plugin's own renderer to parity with custom `.claude/helpers/`
  statuslines that already show the email, without making it a privacy-leaking default.

## 0.13.0

Adds an always-on output-presentation discipline so chat output is structured and
scannable without becoming noisy.

- **New SessionStart rule K — "PRESENT FOR SCANNABILITY (do not overdo it)".** Appended
  to the orchestration block in `verify-first-full.js` (and mirrored as a bullet in
  `AGENTS.md`). Encodes the conservative, renderer-verified subset of GitHub-flavored
  markdown that Claude Code's terminal actually renders: tables for comparisons/status,
  **bold** verdicts, *italic* caveats, `code` for flags/paths/commands, fenced blocks for
  output, at most a leading status glyph (emoji = signal, not decoration). Explicitly
  steers AWAY from syntax the terminal renderer drops or mangles — strikethrough,
  `[label](url)` link labels (paste the bare URL), nested blockquotes, task-list
  checkboxes — and notes that underline and per-word color do not exist in the renderer.
  Subset confirmed against Claude Code terminal-rendering issue reports + docs. Styling
  organizes, never pads: rule H (concise) still governs. Appended as rule K so existing
  letters A-J do not renumber. SessionStart footprint grows by ~0.5 KB.
- **Doc accuracy:** corrected the stale "5 nudges" comments in `verify-first.js` (the
  `NUDGES` array has 12 entries, not 5) and refreshed the root README SessionStart
  footprint figure to the doctor-measured value.

## 0.12.1

Fixes AUDIT-REPORT-2 item #7(a): the shared global statusline base was deleted on
every uninstall.

- **`uninstall-statusline` no longer deletes the shared global base by default.**
  `~/.anti-hall/base-statusline.json` is GLOBAL — every project whose statusLine points
  at the dispatcher wraps it as line 1. The uninstaller's Strategy A unconditionally
  `unlink`ed it after restoring the original command, so uninstalling in ONE project
  (even `--project` scope) silently stripped line 1 for EVERY other project still
  relying on it. A reference count is infeasible (no way to enumerate all projects'
  settings files), so the safe default is now: restore this scope's original command
  and LEAVE the shared base in place. An orphaned JSON is harmless; a deleted shared
  one is not. New opt-in `--purge-base` flag explicitly removes it for the
  "done with anti-hall on this whole machine" case (use only after uninstalling
  everywhere). Verified with a fake-HOME behavioral test: default keeps base + restores
  original command; `--purge-base` deletes it.

## 0.12.0

Closes three deferred AUDIT-REPORT-2 needs-review gaps (external reviewer + codex).

- **Recursive shell parsing (`command-guard` + `graphify-guard`).** The segment
  splitter previously treated `$(...)` / backticks as plain boundaries and never
  inspected their CONTENTS, and never unwrapped `bash -c '...'` / `sh -c` / `zsh -c`
  payloads — so `echo "$(npm run build)"` and `bash -c "npm run build"` bypassed the
  coordinator block (and the graph-first nudge). Both guards now extract nested
  commands from command substitution and from shell `-c` payloads and re-apply the
  full heuristic (HEAVY_VERBS/HEAVY_PATTERNS/LIGHT_EXCEPTIONS for command-guard, the
  code-nav check for graphify-guard) to the inner commands, depth-bounded to 3 to
  avoid pathological input. Benign substitutions stay allowed (`echo "$(date)"` —
  `date` is not heavy). Fail-open preserved.
- **Atomic swarm-guard spawn cap.** The prune→count→cap-check→append was a
  non-atomic read-modify-write, so concurrent spawns each read a stale pre-cap log
  and raced past the ceiling. It now runs inside a best-effort cross-process O_EXCL
  lock (`~/.anti-hall/swarm-spawns.lock`) with stale-lock steal (mtime > ~5s),
  bounded spin, re-read + cap-check INSIDE the lock, and release in `finally`.
  FAIL-OPEN if the lock can't be acquired — never deadlocks a spawn. The
  cap-before-append fix is retained.
- **Doctor 2-line assertion + new tests.** The statusline self-test now requires
  >= 2 lines for the sample payload (which carries `context_window`, so the live
  context gauge on line 2 MUST render) and reports a FAILURE if only line 1 renders.
  Added self-tests proving the recursive-parse fix: command-guard now BLOCKS (in
  coordinator) `echo "$(npm run build)"` and `bash -c "npm run build"`, and still
  ALLOWS the benign `echo "$(date)"`.

## 0.11.3

Precedence-aware install-statusline. Per-project install now writes `.claude/settings.local.json` (highest precedence + gitignored) instead of `settings.json`, so a committed project statusLine can no longer shadow it. The installer checks the statusLine across user/project/local scopes and reports shadowing or already-installed; resolves a STABLE marketplace dispatcher path (never the versioned cache path, which breaks on update); and auto-gitignores `.claude/settings.local.json`.

## 0.11.2

Double-deadly-loop (4-auditor) final-gate fixes. `git-guard` and `command-guard`: `sudo`
with option flags no longer leaks — `sudo -u deploy git push --force` and `sudo -u deploy
npm install` previously resolved their effective verb to `-u` and slipped past the guards;
both now block (flag/operand-skip mirrors the env/timeout/nice handling). `git-guard`:
a force form baked into an inline alias BODY (`git -c alias.p='push --force origin main' p`)
was dropped — now the alias body's tokens are force-checked. `graphify-guard`: `segmentVerb`
now skips wrapper words so `sudo rg secret` is still detected for the (non-blocking) graph-
first nudge. Docs: corrected the skill count (llms.txt "five" → "seven workflow skills";
plugins README primer "7 skills" → "core 4 skills" to match verify-first-full.js; Features
table notes deadly-loop-multi/install-statusline/doctor). See docs/AUDIT-REPORT-2.md for the
reconciled findings, rejected false-positives, and deferred needs-review items. Fail-open and
subagent-allow preserved; doctor green (36 checks).

## 0.11.1

Fix `deadly-loop-multi` SKILL.md YAML frontmatter: the `description` contained an unquoted
inner `Multiplier:` (colon-space), which YAML parses as a mapping value — the skill failed
to load ("mapping values are not allowed in this context"). Replaced the colon with a dash.

## 0.11.0

Cut the plugin's OWN context footprint (it was growing the conversation every turn — the
exact thing the plugin warns against). Root cause (researched): Claude Code injects
`UserPromptSubmit` additionalContext into the transcript EVERY turn and it accumulates
(see anthropics/claude-code#40216), so a long, repeated per-turn directive is a real token
drain.

- **`task-tracker.js` throttled:** injects the FULL task-discipline directive only on the
  first turn of a session (and once per ~6h window), then a SHORT one-line reminder after,
  via `~/.anti-hall/task-tracker-<session>.json` state. Fail-open to full on any state error.
  Steady-state per-turn injection dropped ~68% (≈693 B → ≈223 B).
- **`verify-first-full.js` (SessionStart) tightened** ~13% with no rule removed (Iron Law,
  full rationalization table, orchestration A–J, anti-speculation tiers, anti-sycophancy all
  intact). `verify-first.js` per-turn nudge was already one short line.
- **`doctor.js` adds a "Context footprint" section** reporting the SessionStart / per-turn /
  per-Stop injection sizes in bytes + estimated tokens, so the cost is measurable.

Future levers (noted, not yet done): move the static protocol to CLAUDE.md / SessionStart-only
and merge the four Stop hooks into one to further shrink per-turn overhead.

## 0.10.0

Audit-fix batch (from a 2-Opus + 2-Codex review) + context-protection discipline.

Guards:
- **command-guard** now evaluates PER SEGMENT (quote-aware split on `; && || |`, env-prefix
  + wrapper skip, cross-platform basename). Fixes real false-negatives where heavy commands
  bypassed: `cd app && npm test`, `git status && npm run build`, `FOO=1 docker build .`.
- **swarm-guard** checks the spawn-rate cap BEFORE appending/persisting the timestamp, so
  blocked retries no longer extend the block window; state moved to `~/.anti-hall/`.
- **speculation-guard** regex now catches "should be fine" (was excluded by a lookahead).
- **graphify-guard** `/graphify` exemption is now segment/verb-aware (a substring like
  `echo /graphify && rg secret` no longer exempts the search); state → `~/.anti-hall/`.
- **git-guard** resolves inline `-c alias.x=push` so aliased force-push is caught.
- **task-guard / graphify-reminder** state relocated to `~/.anti-hall/` for cross-runner
  consistency.

Doctor: added a Graphify health section + self-tests proving the command-guard per-segment
fix and the speculation-guard "should be fine" catch.

Discipline (protect the orchestrator's context — a bloated main thread degrades the model
and induces the very hallucination this plugin prevents):
- Delegate not just heavy commands but **broad reads / Grep / Glob / code-nav searches** to
  subagents; inline only a specific known-file read. Added to orchestration, AGENTS.md,
  verify-first-full.js.
- **Graphify-first:** ensure the graph is fresh then QUERY it before raw search and before
  feature-launch analysis.
- **AFK goal-anchor (drift watcher):** re-check work against the locked goal each cycle and
  course-correct on drift; only deviate when the user explicitly redirects.

Docs synced (version drift, autoUpdate wording, 7-skill count, STATUSLINE 3-tier line 2,
"latest OpenAI Codex" not a pinned version, broken MODEL-POLICY links) and a consolidated
`docs/AUDIT-REPORT.md` written (includes the reconciled demo-wrapper.sh false-positive).

## 0.9.0

New `deadly-loop-multi` skill — double / triple / quadruple deadly loop.

Scales the standard 1+1 deadly-loop to N parallel reviewers + N parallel critics with
diversified lenses, then reconciles + validates into ONE consolidated report.

- **double** = 2 Opus + 2 Codex, **triple** = 3+3, **quadruple** = 4+4. The tier is named
  by the user or auto-selected by job complexity × sensitivity (higher tier for
  security/schema/cross-repo/release work).
- **Always half-and-half cross-model:** half the auditors are the latest Codex (a
  different model finds different bugs); if Codex is unavailable, substitute the latest
  Opus with a divergent persona — never drop below the full 2N. Model versions are
  deliberately NOT pinned ("latest Opus / latest Codex") so the skill survives new releases.
- **Runs as a swarm** via the Opus Dynamic-Workflow primitives (KB §11 /
  docs/opus-4-8-swarm.md): a parallel fan-out of the 2N auditors feeding a reconcile +
  validate synthesis stage. The coordinator validates each finding against the code itself
  (agreement raises confidence, but evidence decides) and reconciles conflicts — so a
  single agent's false positive does not make it into the report.

## 0.8.1

Doctor: add a behavioral statusline check. Beyond confirming a statusLine is configured,
the doctor now spawns the dispatcher with a sample payload and asserts it actually
RENDERS (reports the line count — line 1 + live line 2), and validates that
`statusline-rich.js` (the line-1 renderer) is present and syntax-valid. So a broken or
missing renderer is caught, not just a missing setting.

## 0.8.0

Doctor (health check + live guard self-tests) + documentation refresh.

Addresses external-review feedback: a guardrail plugin needs a way to prove it is
actually running and that the guards actually fire — not just that files exist.

- **New `hooks/doctor.js` + `/anti-hall:doctor` skill.** Reports Node version (flags
  < 18, which makes the hooks silently no-op), plugin version, every registered hook's
  presence + syntax, and the statusline install status. Crucially it runs LIVE
  behavioral self-tests: it spawns the real guards with crafted payloads and asserts
  exit codes — git-guard blocks force-push + AI self-credit and allows `git status`;
  command-guard blocks heavy commands in the coordinator but ALLOWS them in a subagent
  (payload `agent_id`); swarm-guard allows a normal spawn. Exits non-zero on any
  critical failure (CI-friendly); `--quiet` prints just the verdict.
- **Docs synced to the current feature set.** README rewritten (modern, explained, with
  the two-layer model, the statusline, and AFK mode), `llms.txt` updated to list ALL
  hooks/skills (it and the README previously undercounted — e.g. omitted command-guard,
  swarm-guard, graphify-guard, phase-tracker), and AGENTS.md gained the AFK autonomy
  contract.

## 0.7.0

Automatic swarm-progress tracking + AFK-mode autonomous driver.

Problem: the phase bar only updated if the coordinator manually called `phase.js`, and
the autonomous-driver template never called it — so a running swarm/feature-launch
showed no progress (verified gap; `CONTINUE-HERE.md` listed it as a TODO).

- **New `phase-tracker.js` hook** (PreToolUse Agent/Task) — records every subagent
  spawn to a HOMEDIR log (`~/.anti-hall/agent-spawns.log`), never blocks, fail-open.
  Registered after swarm-guard so it logs only real spawns.
- **`phase-bar.js` now has 3 tiers** for line 2: (1) coordinator-set semantic phase ->
  rich phase bar; (2) recent spawns (auto) -> animated `orchestrating · N agents active`
  bar; (3) idle -> context-window gauge. So a swarm is visible with ZERO coordinator
  effort. (A registered hook needs a session restart to activate.)
- **AFK mode** (`AUTONOMOUS-DRIVER-PROMPT.md`): wired the `phase.js set/step/agents/
  advance/clear` calls into the per-phase loop, and added the AFK autonomy contract —
  the driver never returns to the owner or stops except for an ABSOLUTELY-DESTRUCTIVE
  hard gate; it collects data instead of pausing, and resolves confusion with a
  deadly-loop rather than asking the (away) owner.

## 0.6.0

Always-on line 2 (hybrid bar). The plugin's statusline now ships BOTH lines as a
complete two-line statusline, and line 2 is always present (never blank):
- During an active orchestration run -> the live phase progress bar (as before).
- When idle -> a context-window usage bar rendered from the session JSON:
  `[███████████◐────────] 56% context` (· `used/max tokens` when the harness
  provides counts), color-coded green/yellow/red at <=70/70-89/>=90.

`statusline.js` now passes the session stdin through to the line-2 renderer
(`phase-bar.js`) so the context bar has real data; `phase-bar.js` renders the phase
bar when a fresh phase-state exists and the context bar otherwise. Fail-open: if
neither source is available, line 2 is simply omitted.

## 0.5.1

Phase bar auto-hides stale state. The line-2 phase bar reads `~/.anti-hall/phase-state.json`;
an orchestration run that ended without calling `phase.js clear` left an ORPHAN state file,
so the bar showed a frozen, stale phase indefinitely (e.g. a "22h" phase that never moved).
`phase-bar.js` now treats a state file whose mtime is older than 30 minutes as absent —
active runs rewrite the file on every set/advance/step/agents call (well under the window),
so live runs always render, but orphaned leftovers no longer linger. Fail-open preserved.

## 0.5.0

Rich statusline + on-demand install skill.

- New `statusline/statusline-rich.js` — a generic, project-agnostic rich line-1
  renderer (project name from cwd, git branch/worktree/stash/staged-modified-untracked,
  ahead/behind, model, effort, subagent count, session duration, context-window %, cost,
  and the GSD `.planning` phase when present). Pure Node, fail-open, no project/user
  specifics. The dispatcher (`statusline.js`) now uses it as the primary own-dispatch
  line-1 renderer, falling back to the monorepo/simple renderers if it yields nothing.
- New `install-statusline` skill — installs the statusLine entry on demand (user scope by
  default for a global bar, `--project` for the current repo only), with a reminder that
  Claude Code reads `statusLine` only at startup so a restart is required.
- `install-statusline.js` no longer clobbers an existing GLOBAL `base-statusline.json`
  (overwriting it changed line 1 for OTHER projects that rely on it). Existing base is
  kept; repos without their own helper fall through to the rich renderer.

## 0.4.7

Fix swarm-guard false-positive memory-pressure block. The memory check used
`os.freemem() / os.totalmem() < 4%`, but on macOS and Linux `os.freemem()` reports
only truly-free pages and EXCLUDES reclaimable cache (inactive / speculative /
file-backed). On a healthy 64 GB Mac it read ~2 GB "free" (< 4%) while ~24 GB was
actually available and memory pressure was green with zero swap — so legitimate
agent spawns were blocked, defeating delegation just like the 0.4.6 command-guard
bug.

Fix: compute REAL available memory per-platform — macOS via `vm_stat`
(free + inactive + speculative pages, honoring the actual page size: 16384 on Apple
Silicon, not a hardcoded 4096), Linux via `/proc/meminfo` MemAvailable, and
`os.freemem()` as the fallback where it is accurate (Windows) or on any parse error.
Verified on a 64 GB Apple Silicon Mac: old calc 6.5% (would block), corrected 36.5%
(no block), matching Activity Monitor. Fail-open preserved.

## 0.4.6

Fix command-guard blocking SUBAGENTS (not just the coordinator) under cmux and other
launchers that wrap `claude` — which crippled the orchestration plugin's entire purpose:
if subagents are also blocked from running heavy commands, there is nothing left to
delegate TO, and the swarm deadlocks.

Root cause (verified empirically this session by capturing real PreToolUse payloads):
the old `isCoordinator()` relied solely on `CLAUDE_CODE_ENTRYPOINT === "agent_tool"` to
detect subagents. That env var is only set on the subagent PROCESS in a vanilla `claude`
CLI. Under cmux, subagents inherit the parent's exact environment (same
`CLAUDE_CODE_ENTRYPOINT=cli`, same `CLAUDE_CODE_SESSION_ID`, same PID), so every subagent
looked like the coordinator and got blocked.

Fix: detect subagents from the hook PAYLOAD instead of the process env. Claude Code
injects `agent_id` and `agent_type` into the PreToolUse payload for Task-tool subagents;
the top-level coordinator's payload has neither. `isCoordinator(payload)` now treats a
command as a subagent (allow) if the payload carries `agent_id`/`agent_type` OR the
entrypoint is `agent_tool` (vanilla-CLI fallback). `main()` parses the payload before the
context check. This works in BOTH environments (cmux and vanilla CLI). Fail-open
preserved on any ambiguity.

Verified: coordinator `node x.js` -> still blocked; the SAME command from a Task-tool
subagent -> runs (payload carried `agent_id`/`agent_type`, matching the spawned agent id).

## 0.4.5

Fix task-guard false-block: completed tasks were over-counted as pending, causing the
Stop hook to block on sessions with zero genuinely-open tasks.

Root cause (verified against real transcripts): two interacting key-mismatch bugs:

1. `TaskCreate` input in the real harness has no `id` or `task_id` field — the harness
   assigns a sequential numeric id (1, 2, 3...) but returns it only in the tool_result
   string `"Task #N created successfully: <subject>"`. The old code fell back to
   `Date.now() + random`, generating a different random key for each create.

2. `TaskUpdate` input uses the field `taskId` (camelCase) — the old code read
   `inp.id || inp.task_id`, both always `null`, so no update ever matched any create.
   All 34 task creates stayed at status `pending` forever.

Fix: parse tool_result strings to extract the harness-assigned numeric id, store
TaskCreate provisionally under the tool_use wire id, then remap to the numeric id when
the result is seen. Read `inp.taskId` first in TaskUpdate (fallback to `inp.id` and
`inp.task_id` for alternate harnesses). Fail-open on any parse error. A cleared or
all-completed task list yields zero open tasks and no block.

Verified by 5 functional tests: 3-create-all-complete -> no block; 1-pending -> block
with correct task name; TodoWrite all-completed -> no block; empty transcript -> no
block; 34-creates-all-completed (exact real-scenario replay) -> no block.

## 0.4.4

Fix plugin load error — removed redundant manifest `hooks` reference; hooks/hooks.json is auto-loaded by Claude Code, so referencing it explicitly caused a duplicate-hooks-file load error (per /doctor). Hooks unchanged and still active.

## 0.4.3

Real statusline installer (wraps existing user statusline + scope-aware + uninstall).
statusline.js now supports base-command wrap.

- **`install-statusline.js` (new):** Interactive installer (--user/--project scope,
  base-statusline.json config, backup + restore, dedup safety). Wraps the user's EXISTING
  statusline.json / statusline command (if present) as line 1, adds anti-hall phase bar
  as line 2. Scope-aware: --user writes to ~/.anti-hall/; --project writes to ./.anti-hall/.
  Preserves .ai-generated-index, .claude-plugin, and other dotfiles on uninstall.
- **`uninstall-statusline.js` (new):** Restores original statusline from backup, removes
  anti-hall phase state.
- **`statusline.js` (updated):** base-command wrap mode: reads ~/.anti-hall/base-statusline.json
  (schema: `{command: "..."}`) and dispatches it to shell, captures line 1, appends phase
  bar as line 2. Falls back to own dispatch (Claude | branch | repo) when config absent.
- **`STATUSLINE.md` (updated):** usage examples for install/uninstall; wrap behavior and
  base-statusline.json config schema.

## 0.4.2

Opt-in semantic speculation judge (LLM-evaluated Stop hook, off by default) covering
the confident-inference-as-fact gap that the lexical Tier 2 guard cannot catch.

- **`speculation-judge.js` (Stop hook, new, OPT-IN):** semantic judgment tier that
  calls `claude-haiku-4-5` via the Anthropic API to evaluate whether the last assistant
  message asserts an unverified factual claim with no hedge word and no acknowledgment.
  Covers the gap left by `speculation-guard.js` (Tier 2), which catches hedged
  speculation but cannot catch a confidently-stated inference-as-fact that uses no hedge
  word at all (e.g., "The cause is the old build artifact." with zero hedging).
  Enabled ONLY when `ANTIHALL_SEMANTIC_JUDGE=1` is set in the environment; exits 0
  immediately (zero cost, zero latency, zero network activity) when unset — the default.
  Also requires `ANTHROPIC_API_KEY`; fails-open (exits 0) when the key is absent or the
  API call fails for any reason. Judge prompt instructs conservative evaluation: allows
  honest hedging, quoted text, hypotheticals, plans, and general software knowledge;
  blocks only definitive unverified factual assertions. Loop-safe: hashes message text
  with a `":judge"` namespace suffix (separate from Tier 2's hash space); blocks at most
  once per distinct message, never wedges. Fail-open on any parse/read/write/API error.
  Cost/latency when enabled: ~$0.0001-0.001 per turn at Haiku rates + ~1-3 s per Stop.
  Misfire caveat: LLM judges can false-positive; the conservative prompt reduces this but
  does not eliminate it — disable `ANTIHALL_SEMANTIC_JUDGE` if misfires are disruptive.
- **`hooks.json`:** `speculation-judge.js` registered as the fourth Stop hook (timeout
  30 s). It is a behavioral no-op in the default configuration (env var unset = exits 0
  immediately). Stop hook order: `task-guard` (1st, highest-stakes), `graphify-reminder`
  (2nd), `speculation-guard` (3rd, Tier 2 lexical), `speculation-judge` (4th, Tier 3
  semantic opt-in).
- **`plugin.json`:** version bumped 0.4.1 -> 0.4.2.
- **`README.md`:** speculation-guard entry in features table updated to label it Tier 2;
  `speculation-judge` entry added (OPT-IN). "Three Stop hooks coexist" note updated to
  four. "Known limit" paragraph replaced with a three-tier enforcement table (Tier 1:
  protocol/always-on/zero-cost; Tier 2: lexical/on-by-default/zero-cost; Tier 3:
  semantic/opt-in/LLM-cost). New "speculation-judge (Tier 3, OPT-IN)" section documenting
  enable instructions (shell profile and settings.json env block), what it catches, the
  fail-open/loop-safe/misfire/cost-latency properties.
- **`AGENTS.md`:** "speculation-guard (Stop hook)" section replaced with an "Anti-
  speculation enforcement: three tiers" section covering all three tiers, then dedicated
  subsections for Tier 2 (lexical, always-on) and Tier 3 (semantic, OPT-IN) with the
  same enable/cost/misfire/fail-open/loop-safe notes as the README.

## 0.4.1

Strengthened no-speculation Iron Law with inference-as-fact ban + hedged-speculation
ban; added per-turn nudges; added `speculation-guard.js` Stop hook (lexical enforcement,
block-once, fail-open).

- **`verify-first-full.js` rationalization table (Iron Law hardening):** added two
  explicit entries that were absent from prior versions: (a) `"X is happening because Y"
  / a clean causal story assembled from a couple of real facts -> that is an INFERENCE
  presented as fact` — bans confident inference-as-fact even when no hedge word is used;
  (b) `"very plausibly" / "likely" / "presumably" / "I suspect" / "I think" / "my guess
  is" / "it must be" -> hedging does NOT make a guess safe; it just disguises it` —
  explicitly bans hedged speculation. Both entries already existed in the
  RATIONALIZATION TABLE in 0.4.0; this entry documents them as rationale for the
  speculation-guard hook boundary.
- **`verify-first.js` (per-turn nudge):** the nudge at index 2 now explicitly names the
  hedge-word ban: `'likely' / 'plausibly' / 'I suspect' / 'I think' / 'it must be' = a
  guess in disguise. Hedging doesn't make it safe. Pull the data, or say 'I don't know -
  here's what I'd check'.` This was already present in the NUDGES array; documented here
  as the per-turn enforcement layer that pairs with the new Stop hook.
- **`speculation-guard.js` (Stop hook, new):** lexical speculation guard. Extracts the
  last assistant message from `transcript_path` (JSONL), scans for 15 speculation
  markers (hedge words: `very plausibly`, `plausibly`, `presumably`, `I suspect`,
  `my guess`, `I'd guess`, `I bet`, `likely`, `probably`, `must be`, `should be` [not
  `should I`], `seems to be`, `appears to be`, `I think it's`, `my hunch`), suppresses
  the block if the same message contains an evidence/uncertainty acknowledgment
  (`verified`, `I don't know`, `haven't checked`, `not verified`, `unverified`, `let me
  verify`, `I'll check`, `I will check`, `need to confirm`, `to confirm`, `file.ext:line`
  citation, `running`, `per the data`, `the data shows`). Block-once: hashes the message
  text and stores the hash in `~/.anti-hall/speculation-guard-state-<session>.json`; if
  the same hash was already blocked, exits 0 (nudge fires once, never wedges). Fail-open:
  any parse/read/write error exits 0 silently. Block reason names the matched marker and
  instructs the model to verify or explicitly flag as unverified. Registered in
  `hooks.json` as the third Stop hook (after `task-guard` and `graphify-reminder`).
  **Known limit:** catches hedged speculation (hedge word present) but not confident
  inference-as-fact with no hedge word. A semantic LLM-judge tier is architecturally
  possible but not shipped by default (cost/latency tradeoff; documented in README +
  AGENTS.md as opt-in design path).
- **`hooks.json`:** `speculation-guard.js` registered under `Stop` as third entry
  (timeout 30 s). Stop now has 3 hooks: `task-guard` (highest-stakes, first), 
  `graphify-reminder` (second), `speculation-guard` (third).
- **`plugin.json`:** version bumped 0.4.0 -> 0.4.1.
- **`README.md` + `AGENTS.md`:** `speculation-guard` added to features table, new
  "speculation-guard" how-it-works section (markers list, acknowledgment suppression,
  loop-safe mechanism, known limit, opt-in semantic tier note); three-Stop-hook
  coexistence note updated from two to three hooks.

## 0.4.0

Rewritten feature-launch workflow + agent-watchdog + statusline phase.js wiring + KB merge.

- **`feature-launch` workflow rewritten:** plan-mode → deadly-loop-the-plan → loopback → self-heal;
  simpler phase loop; analyze-work fan-out; 4.8-fanout/synthesis/gate integration.
- **`agent-watchdog.js`:** new hook for heartbeat enforcement, babysit/backoff/kill logic. Polls
  `~/.anti-hall/agents/<id>.json` every 20 min; kills idle/hung agents; integrates with phase.js.
- **`orchestration/SKILL.md` + `AGENTS.md`:** updated with new agent-watchdog semantics,
  heartbeat convention (mtime update = alive signal), and agent supervisor responsibilities.
- **`statusline/phase.js` wiring:** orchestrator-main integration; calls phase.js (set/advance/step/agents/clear)
  from feature-launch as phases progress; terminal bar reflects real run state.
- **`docs/KB-claude-codex.md`:** merged knowledge base (67 sources): GSD methodology, superpowers,
  deadly-loop, 4.8-swarm patterns, orchestration discipline, graphify workflow. Consolidated
  from `.gsd/` and `superpowers/` skill refs.
- **Version bump 0.3.11 -> 0.4.0.**

## 0.3.11

Phase.js writer (real data source for the phase bar) + colored line-2 palette + full agent label.

- **`phase.js` (statusline writer):** new executable that writes phase-state.json as the
  orchestrator / feature-launch skill progresses. Commands: `set` (start phase), `advance`/`step`/`agents`
  (update in-flight), `clear` (hide bar). Writes to `~/.anti-hall/phase-state.json` (home dir,
  consistent across all processes). Fail-open: any error exits 0 without throwing.
- **`statusline/STATUSLINE.md`:** new "phase.js — Phase state writer" section documenting
  the data source, all 6 commands (set, advance, step, agents, update, clear), usage examples,
  and state-file schema (required + optional fields).
- **`phase-bar.js` (colored palette):** code (magenta/cyan), description (white),
  count (cyan), timer (yellow >20m, else dim), agents (blue "N agents"), step (dim).
  Renders as: `[bar] NN% | CODE - Desc done/total | timer agents step`.
- **Version bump 0.3.10 -> 0.3.11.**

## 0.3.10

Spinner repositioned inside the progress bar at the frontier. Phase-bar now uses box-drawing
glyphs (█ for filled, ─ for empty) and a rotating half-disc spinner (◐◓◑◒) positioned at
the progress frontier. Layout: `[████████◐────────────] 40% | P2 - Desc done/total | extras`.

- **`phase-bar.js` (statusline):** spinner (◐◓◑◒) now rendered at the progress frontier
  INSIDE the bar, not after. Filled segment uses █ (U+2588), empty segment uses ─ (U+2500).
  Spinner is a rotating half-disc (◐◓◑◒ U+25D0-D2) that advances every 125ms. Layout remains
  `[bar] NN% | CODE - Desc done/total | extras` with all styling preserved.

## 0.3.9

Phase-bar statusline enrichment: wider bar (20 chars), live percentage, longer description
(cap 32 chars), and optional extras (elapsed time in yellow when >20m, active agent count,
current step) rendered when present in phase-state.json.

- **`phase-bar.js` (statusline):** expanded bar width from 16 to 20 chars; added percentage
  render (e.g., "40%") in yellow after the bar; description cap increased from 16 to 32
  chars with ellipsis on overflow; optional extras appended in dim text when phase-state
  includes `elapsed`, `agents`, and `step` keys (e.g., "3m 3ag rendering bar"). Elapsed
  times >20m highlighted in yellow (e.g., "\[33m23m\[0m") to signal long-running phases.
  Backward-compatible: phase-state without these keys renders as before.

## 0.3.7

Consolidated enforcement wave: command-delegation as the top always-on rule, active
task-draining, swarm-guard, graphify-guard, concise-communication note, and
.graphifyignore.

- **`command-guard.js` (PreToolUse Bash, coordinator-only):** new hook that BLOCKS
  heavy/long/state-changing commands (build, test, deploy, push, pull, install,
  migrate, dumps, bulk scripts) when running in a coordinator context, requiring the
  model to delegate them to a subagent instead. Detection uses `CLAUDE_CODE_ENTRYPOINT`:
  `agent_tool` = subagent (pass-through); `cli`/`vscode`/`jetbrains`/etc. = coordinator
  (block). Fail-open on absent/unknown entrypoint. Registered in hooks.json.
  COORDINATOR-VS-SUBAGENT INVESTIGATION: `CLAUDE_CODE_ENTRYPOINT` is a documented
  Claude Code env var set to `agent_tool` when spawned via the Task tool, and inherited
  by hook child processes — this is a reliable signal. The hook is SHIPPED.
- **`swarm-guard.js` (PreToolUse Agent/Task):** new hook, OS-agnostic pure Node.
  Tracks spawn timestamps under `os.tmpdir()/anti-hall/swarm-spawns.log`; prunes
  entries older than 60s; blocks if spawns in last 60s >= 20 (CAP). Secondary check:
  blocks if `os.freemem()/os.totalmem() < 4%` (critical memory pressure). Both
  thresholds are conservative. Fail-open on any error. Registered for `Agent` and
  `Task` matchers in hooks.json.
- **`graphify-guard.js` (PreToolUse Grep/Glob/Bash):** new hook. If a graphify graph
  exists (`graphify-out/` or `.planning/graphs/` at cwd or git toplevel), blocks the
  FIRST code-navigation search of the session (Grep tool, Glob tool, or Bash with
  grep/rg/ag/find/git-grep as first verb) and redirects to `/graphify query`. Blocks
  ONCE per session per project (loop-safe via `os.tmpdir` marker); second call is
  always allowed. Graphify-query Bash commands (`/graphify`) are explicitly excluded.
  No-op when no graph is present. Fail-open. Registered for `Grep`, `Glob`, `Bash`.
- **`.graphifyignore` (repo root):** new file — excludes `graphify-out/`,
  `.planning/graphs/`, `node_modules/`, `dist/`, lock files, `.git/`, and common
  generated/build patterns from graphify indexing.
- **`verify-first-full.js` (SessionStart):** ORCHESTRATION DISCIPLINE block
  restructured. Command-delegation moved to item A as the TOP RULE with explicit
  wording: "NEVER run verbose/long/state-changing commands inline... ALWAYS delegate
  to a subagent... never fill the main context with raw command output — the most
  counterproductive thing a coordinator can do." Active task-draining added as item C:
  "pick up pending tasks and dispatch subagents to finalize them; run INDEPENDENT
  tasks in parallel (up to the concurrency cap, ~min(16, cores-2)); never spawn
  unbounded agents... a runaway swarm can make the OS unusable." Concise-communication
  added as item H: "Communicate concisely: enough to convey meaning, not pages; offer
  to expand if the user wants more detail." Always-apply disciplines summary updated
  to reflect command-delegation top rule, task-draining, concurrency cap, concise note.
- **`verify-first.js` (per-turn nudge):** added two new nudges to the rotation —
  explicit command-delegation top rule; concise-communication note. Concurrency-cap
  language added to the task-list nudge. Hash-mod rotation auto-scales.
- **`task-guard.js` (Stop):** block reason now includes active task-draining
  instruction: "pick up pending tasks... run independent tasks in parallel (up to
  the concurrency cap, ~min(16, cores-2)); do not let tasks sit neglected."
- **`AGENTS.md` + plugin `README.md`:** command-delegation top rule added to
  orchestration section; concurrency cap added; active task-draining added; concise-
  communication added; "Recommended companion: graphify" section added (soft note —
  hooks no-op without it, no hard dependency).
- **Version bump 0.3.6 -> 0.3.7.**

## 0.3.6

Promote TWO disciplines to always-on ENFORCED via the hook layer, while keeping TWO
skills conditional. Root-cause and orchestration now fire every session/turn; deadly-loop
and feature-launch remain invoked-on-match.

- **`verify-first-full.js` (SessionStart):** added an always-apply ORCHESTRATION
  DISCIPLINE block framed as a BIAS TOWARD DELEGATION — non-blocking main thread;
  priority-sorted task list capturing every request and interruption; default to
  delegating any work that touches files/tools/commands/search/build/test or could balloon
  (avoid the eager "I'll just do it inline" trap), handle inline only genuinely atomic
  things (a direct answer, a single known-line read, the coordinator's own
  synthesis/decisions), delegate immediately if a quick inline task balloons; parallel
  agents when independent; noisy commands via a cheap-model subagent (Haiku/Codex)
  off-thread; report/synthesize. Reframed the skill primer into "ALWAYS APPLY (enforced):
  root-cause + orchestration + anti-sycophancy disciplines" vs "INVOKE WHEN IT MATCHES:
  /anti-hall:deadly-loop, /anti-hall:feature-launch (plus the root-cause/orchestration full
  playbooks on demand)". Anti-sycophancy named explicitly. Iron Law + rationalization table
  kept intact.
- **`verify-first.js` (per-turn nudge):** added three orchestration/anti-sycophancy
  one-liners to the rotation (bias-toward-delegation default-to-subagent; noisy commands
  via Haiku off-thread; capture every request/interruption in a priority-sorted list +
  parallel independent agents). The hash-mod rotation auto-scales to the new count;
  fail-open unchanged.
- **READMEs + AGENTS.md:** note that root-cause + orchestration are enforced always-on via
  hooks while deadly-loop + feature-launch are conditional skills invoked on match;
  documented the bias-toward-delegation default, capture-every-request, and anti-sycophancy.
- **Version bump 0.3.5 -> 0.3.6.**

## 0.3.5

Production-doc finalization + doc-vs-code reconciliation: rewrite the READMEs, add
`llms.txt`, and remove the never-registered PreCompact claims.

- **Production README rewrite:** both the top-level `README.md` and the plugin
  `README.md` were rewritten for readability and structure — tagline, the four
  failure modes, quickstart, requirements (with the honest Node-on-PATH no-op
  caveat), a features table, plain-English how-it-works, the `/anti-hall:*` skills,
  statusline install, configuration/tuning, troubleshooting/FAQ, contributing (the
  3 MODEL-POLICY copies must stay in sync), and license. The top README is the
  short overview; depth lives in the plugin README. Accurate to the real code
  (7 Node hooks, 4 skills, Node statusline).
- **`llms.txt` added:** an LLM-oriented index at the repo root (llms.txt standard) —
  H1 title, blockquote summary, and linked sections for the README, plugin README,
  CHANGELOG, AGENTS.md, KB doc, each skill SKILL.md, and each hook.
- **Doc-accuracy fixes (4 × P2):**
  - Top README "What's inside" now states the FULL protocol injects at SessionStart
    (re-firing on compaction via `source=compact`) and a SHORT varying nudge per turn
    at UserPromptSubmit — not "the full protocol every turn".
  - `feature-launch/references/PRE-TOOL-USE-HOOK.md` no longer cites non-existent
    "Phase A.5.5" / "A.5.3"; it now points to "Phase A.5 (AFK readiness gate)" to
    match the prose (no sub-numbers) in `feature-launch/SKILL.md`.
  - `verify-first.js` comments + plugin README now state the per-turn nudge is hashed
    from the FULL stdin envelope (varies by session/cwd), not "reproducible for a
    given prompt". Runtime behavior unchanged.
  - `PRE-TOOL-USE-HOOK.md` example sentinel: added an explicit false-block/bypass
    tradeoff caveat and a pointer to the shipped quote-aware `git-guard.js`
    tokenizer; `--no-verify` / `--no-gpg-sign` patterns anchored to a flag boundary.
- **PreCompact placeholder claims removed (P1):** `hooks.json` registers
  `verify-first-full.js` ONLY on `SessionStart` — there is no `PreCompact`
  registration block and never was in the shipped manifest. Every doc that
  described an "inert PreCompact placeholder registration" was inaccurate. Removed
  those claims from `verify-first-full.js` (banner + header + the dead
  `name === 'PreCompact'` echo branch), the plugin `README.md`, and `AGENTS.md`.
  Compaction survival is unchanged: it relies solely on the no-matcher
  `SessionStart` re-fire with `source="compact"`, which IS registered. The earlier
  0.3.0/0.3.1 notes below describing a kept PreCompact placeholder are superseded
  by this entry.
- **AGENTS.md scope clarified (P2):** `AGENTS.md` lives at the marketplace repo
  root, not under `plugins/anti-hall/`, so it is NOT bundled by `/plugin install`
  (the plugin `source` is `./plugins/anti-hall`). `plugin.json` description and the
  plugin `README.md` now state it is a repo-root Codex mirror for clone-based use
  that installed users must copy manually.
- **0.3.0 marketplace-source note corrected (P2):** the 0.3.0 entry claimed the
  marketplace plugin `source` switched to a GitHub source object; the file actually
  uses the relative path `./plugins/anti-hall`. Corrected the 0.3.0 note to match
  the file (the relative path resolves because `marketplace add talas9/anti-hall`
  clones the whole repo).

## 0.3.4

Close the quoted-flag force-push bypass in git-guard.

- **git-guard: quoted force flags / refspecs / subcommand now BLOCK (P1):** the
  force-push guard previously skipped any token that came entirely from inside quotes
  (`quotedOnly`). For argument-level flag/refspec/subcommand detection that was wrong —
  the POSIX shell strips quotes before git runs, so `git push "--force"`,
  `git push '--force'`, `git push "-f"`, `git push origin '+main'`, and
  `git "push" --force origin main` are byte-for-byte equivalent to their unquoted forms
  and DO rewrite published history, yet all five were reported ALLOW. `isForcePush()`
  now matches `--force`/`--force-with-lease`/bundled `-f`/`+refspec` regardless of
  quoting, and `gitSubcommand()` resolves a quoted subcommand token (e.g. `"push"`)
  instead of bailing to `sub=null` and leaving the command uninspected. Quoting still
  only changes meaning for commit-message CONTENT (a `--force`/`+main` inside an `-m`
  value), which is inspected separately on the `commit` path — never in a push arg
  list — so `git commit -m "fix --force bug"` is not false-blocked. Verified against the
  block/allow matrix (5 bypass cases now block; all prior blocks and legitimate pushes
  unchanged).

## 0.3.3

Portability finalization pass — restore the all-pure-Node guarantee.

- **Removed `node-preflight.sh` (P1):** the POSIX-shell preflight added in 0.3.2 could
  not run on the platform it targeted. Claude Code executes a hook `command` via the
  system shell, which on a stock Windows box is cmd.exe/PowerShell — neither has `sh`
  on `PATH`. On the exact "fresh Windows box with no Node" case the preflight existed
  to warn about, `sh` is also absent, so `sh node-preflight.sh` failed to launch and
  the "anti-hall hooks are INACTIVE" warning never fired — the precise silent-off
  failure it was meant to prevent. The plugin's single non-Node component was also its
  least portable. Rather than ship a `.sh`/`.cmd`/`.ps1` matrix, the missing-Node case
  is now handled the same way as git-guard's other fail-open boundaries: documented as
  a hard, verify-before-relying prerequisite (README "Requirements" + install steps,
  "verify with `node --version`"). With the `.sh` gone, the manifest/README "all hooks
  pure Node, run unchanged on Windows/macOS/Linux given Node" claim is once again true.
- **Manifest/CHANGELOG vs README reconciled (P2):** plugin.json's "All hooks and the
  statusline are pure Node" description and the 0.3.0 "no `.sh`, no bash" note no longer
  contradict the shipped hooks — there is no shell hook to contradict them. README,
  manifest, and CHANGELOG now agree.

## 0.3.2

Deadly-loop finalization pass (round 1 + round 2 findings; 0 P0, converged).

- **git-guard `--force-if-includes` false-block (P1):** `--force-if-includes` /
  `--no-force-if-includes` is a safety modifier (a no-op on its own, only meaningful
  alongside `--force-with-lease`), not a force push. It is no longer a force trigger,
  so a bare `git push --force-if-includes origin main` is ALLOWED. `--force`, `-f`,
  `--force-with-lease`, and `+refspec` still BLOCK.
- **statusline installer cache-path discovery (P1):** the one-command installer glob
  now covers the real install layout `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`
  (verified against an actual install) plus the KB's shallower documented forms, keeping
  the existing marketplace globs and the `.claude-plugin/plugin.json` existence guard, so
  it no longer prints "not found" on a correctly installed plugin.
- **node-absent honest documentation (P1):** every hook launches as `node <hook>.js`;
  if `node` is absent from the hook shell's `PATH`, all hooks (including the git-guard
  safety) silently do not run. A POSIX-shell `node-preflight.sh` SessionStart hook now
  emits a loud one-time warning when `node` is missing (a node-based preflight cannot
  detect its own missing interpreter), and the README install steps state the Node >= 18
  requirement prominently and tell users to verify `node --version` before relying on
  the protections.
- **git-guard ANSI-C inline self-credit bypass (P2):** a `git commit -m $'fix\n\nCo-authored-by: ...'`
  kept its `\n` literal after tokenizing, slipping past the line-anchored trailer
  regexes. Self-credit detection now also tests an escape-normalized copy of each inline
  message (`\n`/`\r`/`\t` interpreted), so the ANSI-C inline form is blocked too.
- **marketplace.json capability claim (P2):** changed "PreCompact re-injection" to
  "SessionStart re-injection (fires with source=compact)" to match the code — PreCompact
  context injection is inert (forward-compat placeholder), SessionStart `source=compact`
  is the sole compaction-survival mechanism.
- **install-statusline.js ungrounded field (P2):** dropped the undocumented `padding: 0`
  field; the installer writes only the doc-grounded `{ type: "command", command }`.
- **MODEL-POLICY triplication sync note (P2):** the three byte-identical MODEL-POLICY.md
  copies (needed because skill bundling carries each skill's own `references/` copy and
  symlinks are stripped on install) now each carry a SYNC NOTE header, plus a README
  maintainer note, instructing that all three be updated together.
- **Stop-hook precedence (P2):** `task-guard` is now registered before `graphify-reminder`
  on `Stop` so the higher-stakes open-task discipline reason wins when both fire (Claude
  Code does not merge Stop reasons); README caveat updated.
- **statusline blink removed (P2):** the >=80% context tier in `statusline-monorepo.js`
  no longer uses SGR 5 (blink, inconsistently supported); it uses bold bright-red
  256-color, consistent with the other tiers.
- **per-turn nudge wording (P2):** README clarified that the verify-first nudge varies
  **by prompt** (deterministic SHA-1 of the prompt), not strictly per turn — an identical
  repeated prompt reproduces the same facet.

## 0.3.1

Deadly-loop finalization pass — applies the remaining open findings, all verified
against the official Claude Code hooks docs.

- **graphify-reminder now actually reaches the model (P1):** a Stop hook does NOT
  inject `additionalContext` (only UserPromptSubmit / UserPromptExpansion /
  SessionStart do, per the official docs), so the previous stdout-`additionalContext`
  emission was a silent no-op. The reminder is now surfaced via the only Stop
  channel that reaches the model — a **one-time soft block**
  (`{"decision":"block","reason":...}`), capped + deduped via `os.tmpdir` state so
  it nudges at most once per session and never loops. The "keep the graph updated"
  guidance also lives in the SessionStart primer, which IS a context-injection event.
- **git-guard emoji self-credit (P1):** the `Generated with <AI>` detector now
  catches the canonical footer even when prefixed by a leading glyph/emoji
  (e.g. the robot-emoji `Generated with [Claude Code]` footer) while still allowing
  prose ("we generated with care"). Verified against the full block/allow matrix.
- **Node prerequisite documented prominently (P1):** added a **Requirements**
  section to the top-level README and the plugin description, and aligned the plugin
  README to Node >= 18. Hooks invoke a bare `node`; without a global Node on `PATH`
  every hook (including the git-guard safety) silently fails to launch.
- **git-guard scope caveat (P2):** README now states the guard inspects only inline
  `-m`/`--message` trailers — `-F`/`--file`, editor commits, and interpreter
  wrappers (`sh -c`, `xargs`, aliases) are documented fail-open boundaries.
- **KB §1.4 corrected (P2):** UserPromptSubmit context injection uses **nested**
  `hookSpecificOutput.additionalContext` (not flat); added an explicit note that
  context injection is event-gated to UserPromptSubmit / UserPromptExpansion /
  SessionStart, so `Stop`/`PreCompact` `additionalContext` is inert.
- **PreCompact framing corrected (P2):** clarified that PreCompact never injects
  context (not "summarized away"); SessionStart `source="compact"` is the sole
  survive-compaction mechanism. (Superseded in 0.3.5: the PreCompact registration
  was never actually present in `hooks.json`, so all PreCompact-placeholder claims
  were removed rather than reworded.)
- **Two-Stop-hook coexistence noted (P2):** `graphify-reminder` + `task-guard` both
  emit the top-level Stop `decision`/`reason` schema; Claude Code does not merge
  reasons, but each is capped so neither is lost (they sequence across Stops).

## 0.3.0

KB-driven effectiveness + portability revision (see `docs/PLUGIN-REVIEW.md`),
plus a full OS-agnostic Node rewrite and the deadly-loop hardening pass.

- **OS-agnostic Node rewrite (portability):** every hook and the statusline +
  its installer are now pure Node.js using only built-ins (`fs`, `path`, `os`,
  `crypto`, `child_process`) — no `.sh`, no bash/grep/sed/cksum/jq/python3, no
  `/dev/stdin`. The only spawned subprocess is `git` itself. They run unchanged
  on Windows, macOS, and Linux **given Node.js on `PATH`** — Node is the one hard
  prerequisite (see README "Requirements"); without a global `node` the hooks
  cannot launch and the guards silently do not run. `hooks.json` invokes each as
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"` (explicit `node`, not a
  shebang, since Windows ignores shebangs).
- **verify-first restructured (P0-1, P0-3):** the FULL protocol moved to a
  SessionStart injection (`verify-first-full.js`), rewritten in the Superpowers
  "ONE Iron Law + rationalization/excuse table" form (names the specific bypass
  excuses: "probably", "should work", "seems to", "I'll just assume", "this looks
  done", "tests pass on first run"). The per-turn `UserPromptSubmit`
  (`verify-first.js`) is now a SHORT nudge that VARIES per turn (one of 5
  one-liners, chosen deterministically by a SHA-1 hash (Node `crypto`) of the
  prompt) to fight habituation. JSON emitted via `JSON.stringify`, no jq.
- **Survive compaction (P0-2):** the protocol persists across the compaction
  reset via the no-matcher `SessionStart` registration — Claude Code re-fires
  `SessionStart` after a compaction with `source="compact"`, and that injection
  is fresh post-reset context. (This note originally also described keeping a
  `PreCompact` registration as an inert placeholder; superseded in 0.3.5 — no
  PreCompact registration was ever present in `hooks.json`, and all such claims
  were removed. Per the official docs `additionalContext` is injected on exit 0
  for UserPromptSubmit / UserPromptExpansion / SessionStart only, so a PreCompact
  hook would deliver nothing.) A duplicate matcher-`"compact"` SessionStart entry
  was removed so the protocol is not double-injected after a compaction.
- **git-guard force-push hardening (deadly-loop):** force-push detection now
  resists prefix/wrapper/subshell bypasses and `+refspec` variants — env-prefix
  (`FOO=bar git push --force`), wrappers (`command`/`exec`/`sudo`/`env`/`time`/
  `nohup`/`nice -n N`/`timeout 5`), subshell grouping (`(git push --force)`),
  global git options (`-c x=y push --force`), positional `+refspec` (with `--`
  end-of-options handling), and backslash-newline line continuations. Self-credit
  trailer detection is anchored to start-of-line trailer form so a prose mention
  ("docs: explain output generated with claude code") no longer false-blocks,
  while real `Co-Authored-By:` / `Generated with <AI>` trailer lines still block.
  Verified against an 18-case block/allow matrix.
- **AGENTS.md mirror (P0-4):** new repo-root `AGENTS.md` (<32 KiB) mirroring the
  verify-first Iron Law + commit/push hygiene + task discipline, so Codex
  subagents inherit the discipline (Codex `PreToolUse` cannot inject context).
- **Skill primer (P1-1):** SessionStart now lists the plugin's skills
  (root-cause, deadly-loop, feature-launch, orchestration) + when to reach for
  each, folded into `verify-first-full.js`.
- **MODEL-POLICY (P1-2):** documented `effort` default `high` / recommended max
  `xhigh` with fallback-to-`high` when unsupported (gpt-5.4-mini, Bedrock cmb);
  added the `codex` CLI-alias-in-subprocess caveat (detect in the executing
  shell, try an absolute path); added an anti-sycophancy clause (user agreement
  != correctness).
- **marketplace.json (P1-5, P1-6):** plugin `source` is the relative path
  `"./plugins/anti-hall"`, which resolves because `/plugin marketplace add
  talas9/anti-hall` clones the whole repo (the relative path is taken from the
  marketplace root inside that clone); removed the per-plugin `version`
  duplication (version now lives only in `plugin.json`).
- **KB (`docs/KB-claude-codex.md`):** added §9 "Anthropic Prompting 101" and §10
  "Claude Opus 4.8 features relevant to this plugin", plus their source URLs.
- **CHANGELOG header:** corrected "bump both manifests" to "bump `plugin.json`
  only (the authority)".

## 0.2.1

- Fix `git-guard` self-credit regex: removed the bare `ai` alternation that
  false-blocked legitimate human trailers (e.g. `Co-authored-by: Ai ...`). Now matches
  specific AI/assistant signatures only.
- Add this CHANGELOG.

## 0.2.0

- Add skills: `root-cause` (evidence-driven debugging), `orchestration` (non-blocking
  swarm; Claude+Codex load split; commands via Haiku), `feature-launch` (plan-first,
  deadly-loop-hardened, edge-case/scenario simulated), `deadly-loop` (iterative
  Reviewer+Critic debate), and shared `MODEL-POLICY.md` (Opus + Codex roster).
- Add graphify hooks: `graphify-session` (SessionStart, query-graph-first) and
  `graphify-reminder` (Stop, keep-graph-updated).
- Add `git-guard` (PreToolUse/Bash): block self-credit commit trailers and force push.
- Add conditional statusline (rich for monorepos, simple otherwise) + installer.
- Strengthen `verify-first` injection: no-jumping-to-conclusions, no-cause-no-fix,
  instrument-don't-guess, no-fake-completion, label claims.

## 0.1.0

- Initial release: `verify-first` UserPromptSubmit hook + marketplace scaffold.
