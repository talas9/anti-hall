# ULTRAPLAN — anti-hall Claude Code plugin (consolidated, dogfooded)

Single authoritative plan for reconciling the anti-hall plugin to its own
verify-first / feature-launch / deadly-loop discipline. This is a PLANNING
artifact only. No plugin code is changed by this document.

Status of the inputs (verified this session, not assumed):

- Deadly-loop FULL result (`/private/tmp/.../w9hfrlvw9.output`): R1 = 22 findings
  (1 P0, 9 P1), fix wave applied, R2 = 8 findings (1 NEW P0). **`converged: false`.**
  The loop did NOT reach zero NEW P0s — Round 2 surfaced a brand-new P0 (git-guard
  prefix bypass) plus a P0-class architectural finding (PreCompact re-injection is
  unverified). A Round 3 was never run.
- All R2 still-open findings were **reproduced empirically this session** against the
  current files (commands + outputs cited per defect below).
- Agnostic scan run this session (results in §5). Marketplace `version` and the two
  "missing references" the brief lists as still-open are in fact **already fixed** in
  the current tree — verified, not assumed; called out as brief-vs-tree discrepancies.

---

## 1. Mission + the four failure modes

**Mission.** Make Claude Code (and Codex, via the `AGENTS.md` mirror) *verify before
it claims and prove a root cause before it fixes* — enforced by deterministic hooks,
reinforced by skills, on any machine and any repo, on Windows / macOS / Linux alike.

**The four failure modes it fights** (from `plugins/anti-hall/README.md:4-9`):

1. **Eagerness** — answering/acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values)
   as truth.
3. **Solution-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming done/fixed/passing without running the check.

A fifth, cross-cutting failure mode this revision must add to the threat model:
**the plugin lying to itself** — a guard that *claims* to enforce a rule but is
bypassable (git-guard prefix bypass, -F-file commits), or a survival mechanism
(PreCompact) whose effect is asserted but unverified. An anti-hallucination plugin
that overclaims its own guarantees is the most embarrassing possible bug.

---

## 2. Design principles distilled from the KB (what WORKS vs what GETS IGNORED)

Every principle is tied to a KB section and is already (mostly) reflected in the
plugin; the plan must PRESERVE these while fixing the defects.

### WORKS (evidence-backed — keep / strengthen)

- **Deterministic command hooks with `exit 2` are the only mechanism that PREVENTS an
  action** rather than suggesting against it (KB §1.2, §1.5, Design-implications
  "WORKS"). git-guard and task-guard are correctly *command* hooks, not `prompt`/
  `agent` hooks (KB §1.5: LLM-evaluated hooks "can hallucinate compliance"). KEEP this
  choice; the defects are in the matching logic, not the hook type.
- **Primacy + recency placement.** Hard rules belong at 0–5% and 95–100% of the
  prompt; buried-in-the-middle rules suffer a **30%+ adherence drop** (KB §8.1 Lost in
  the Middle; §6.2 recency/U-shape; §3.2 "docs at top, query at end"; §9.1 element 5
  "restate critical rules at the end"). This is why the full protocol lives at
  SessionStart (primacy) and must be re-injected at the compaction boundary (recency
  after reset). **Three independent sources converge** here (official prompting,
  Lost-in-the-Middle paper, recency writeup).
- **Iron Law + rationalization table** beats a flat imperative list (KB §6.1
  Superpowers; Design-implications "WORKS"). The model already knows the rules; it
  needs its *specific bypass excuses named* ("probably", "should work", "seems to",
  "I'll just assume", "tests pass on first run"). `verify-first-full.sh` and `AGENTS.md`
  are correctly in this form — preserve it verbatim.
- **Novelty fights habituation.** Adherence is a function of placement AND novelty,
  not repetition; a byte-identical reminder every turn is "exactly what the model
  learns to skip" (KB §6.2; Design-implications "GETS IGNORED"). `verify-first` rotates
  5 one-liners deterministically — preserve the rotation; the rotation MECHANISM
  (cksum) is what changes (to JS crypto) for OS-agnosticism, not the behavior.
- **Permission to say "I don't know"** + **quote-before-summarize** are the two
  highest-leverage anti-hallucination techniques per Anthropic (KB §3.1 #1/#2, §9.5,
  §9.6). The protocol's rule 5 ("Say 'I don't know'…") encodes this — keep it.
- **Atomic, decomposed constraints** are followed more reliably than compound
  multi-clause rules (KB §8.6: ~85% compound vs ~60%/clause is the wrong direction —
  decompose). The positive-rules list is already atomic and numbered — keep.
- **Anti-sycophancy must be explicit.** RLHF optimizes agreement over accuracy; system
  prompts must explicitly outrank user agreement (KB §8.4). Rule 9 ("User agreement is
  not correctness") and MODEL-POLICY's anti-sycophancy clause encode this — keep.
- **A runnable verification check** turns "looks done" into pass/fail (KB §4.2,
  Design-implications). Currently prose-only; documented as an opt-in Stop/TaskCompleted
  gate (PLUGIN-REVIEW P1-4) — keep as documented opt-in, do not force a default.
- **Cross-model two-reviewer debate** catches uncorrelated bugs: 90.2% vs 83.5%
  single-model (KB §7.2, §6.5); detection correlation <0.25 means combined > any
  individual. This is the MODEL-POLICY roster (Opus Reviewer + Codex Critic, 2-Opus
  divergent fallback) — preserve exactly.
- **`${CLAUDE_PLUGIN_ROOT}` placeholder, quoted in shell-form** (KB §1.6). hooks.json
  already quotes it; the statusline INSTALLER is the one place that interpolates an
  unquoted path (defect F-09).

### GETS IGNORED / FAILS (avoid)

- Rules buried mid-prompt or in a bloated CLAUDE.md (KB §8.1, §4.3).
- **Exit code 1 used for blocking** — it is non-blocking; only exit 2 enforces (KB
  §1.3, "the single most common mistake"). All current hooks correctly use exit 2 for
  blocks and exit 0 for fail-open. PRESERVE.
- **Flat `decision` on PreToolUse** instead of nested `permissionDecision` (silent
  enforcement failure, KB §1.4). git-guard uses exit-2, which KB §1.2/§1.3 confirm is
  valid for PreToolUse; preserve.
- Negative-only instructions and vague skill descriptions (KB §3.3, §2.2).
- Prompt/agent hooks for deterministic facts (KB §1.5).
- Output-first then fact-check (KB §3.1, Design-implications "GETS IGNORED").
- Extended thinking as a verification guarantee (KB §3.3, §10.1 "thinking ≠
  verification").
- Disabling/timeout-ing a failing check to fix a symptom (KB §6.6, §4.2).

### NEW principle this revision adds (P0): OS-agnostic, Node-only

Every executable the plugin ships MUST run unchanged on **Windows, macOS, and
Linux**. Claude Code bundles a Node runtime on every OS; it does NOT bundle bash,
grep, sed, cksum, or python3 (native Windows has none of these by default). Therefore:

- **All hook scripts and statusline scripts + the installer are authored in Node.js**
  using only Node built-ins (`fs`, `path`, `os`, `crypto`, `child_process`). Zero
  external deps, identical behavior across OSes.
- **No `.sh`, no bash, no cksum/grep/sed/python3, no POSIX-only constructs, no shelling
  out to unix utilities.** The single allowed subprocess is `git` itself (genuinely
  cross-platform), spawned via `child_process` and parsed in JS — never piped through
  grep/sed.
- Handle Windows path separators (`path.join`, never hardcoded `/`) and line endings
  (`split(/\r?\n/)`).
- This is grounded in KB §1.5 (command hooks are correct) + §2.5 (statusline is a
  command that reads stdin JSON and writes stdout — language-agnostic) + the empirical
  cross-platform findings the deadly-loop already raised (statusline node-127 crash,
  `/dev/stdin` Windows failure). The KB never says hooks must be bash; bash was an
  incidental implementation choice that is itself an OS-portability DEFECT (see §4
  F-13).

> Caveat to honor: the KB notes Claude Code resolves command hooks through a shell.
> A `.js` file with a `#!/usr/bin/env node` shebang is NOT reliably executable on
> native Windows (no shebang support). Therefore hooks.json MUST invoke each script as
> `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"` (explicit `node` prefix), NOT rely on
> the shebang. The shebang stays for direct-invocation convenience on Unix but is not
> the activation path. This is the single most important mechanical detail of the
> rewrite.

---

## 3. Target architecture — file-by-file (post-reconciliation spec)

This is the spec the code must match AFTER the rewrite. Every shipped executable is
`.js` (Node-only). hooks.json invokes each as `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"`.

### Hooks (`plugins/anti-hall/hooks/`)

| File (target) | Event | Single purpose | Contract / invariants |
|---|---|---|---|
| `verify-first.js` | `UserPromptSubmit` | Inject ONE short, varying Iron-Law nudge per turn (1 of 5 facets). | stdin JSON read only to derive a deterministic index via `crypto` hash of the prompt bytes (NOT cksum); never echoes stdin (no injection surface); always exit 0; emits `{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext}}` built with `JSON.stringify` (no hand-emitted JSON). Output well under KB §1.6 10k cap. |
| `verify-first-full.js` | `SessionStart` (incl. matcher `compact`/`resume`) **and** `PreCompact` | Inject the FULL Iron-Law + rationalization-table protocol + skill primer at primacy and across the compaction boundary. | Reads `hook_event_name`/`source` from stdin via `JSON.parse` (NOT substring case-match) to set the echoed `hookEventName`; defaults to SessionStart on parse failure; always exit 0; JSON via `JSON.stringify`. **Must survive compaction via a SessionStart `compact`-matcher entry** (see F-11), not by trusting PreCompact additionalContext. |
| `task-tracker.js` | `UserPromptSubmit` | Inject task-list discipline (capture every request, P0/P1/P2, work top-down, statuses current, non-blocking, report). | Static `additionalContext` via `JSON.stringify`; always exit 0. (Content is static by design — it is the discipline directive, distinct from the varying nudge.) |
| `task-guard.js` | `Stop` (loop-safe) | Block ONCE when the session stops with open tasks; loop-safe by hashing the open-task set; fail-open. | stdin via `fs.readFileSync(0,'utf8')` (fd 0, cross-platform — already fixed); parse transcript JSONL tail; `crypto.sha1` of sorted open-task ids; state file under a PER-USER/SESSION temp location (NOT the project tree — F-07); block via `{decision:"block",reason}`; top-level try/catch → exit 0. **Rename `.sh`→`.js`** (F-05) + update hooks.json. |
| `git-guard.js` | `PreToolUse` (matcher `Bash`) | Block self-credit commit trailers + force push; never false-block. | Parse `tool_input.command` from stdin entirely in JS (no python3/jq/sed/grep — F-13). Self-credit: match canonical AI signatures only. Force-push: tokenize each command segment, strip leading `VAR=value` assignments and `command`/`builtin`/`exec` wrappers and leading `(`/`{`, require effective verb `git` + subcommand `push`, then test that segment for `--force`/`--force-with-lease`/standalone `-f`/positional `+refspec` (excluding `#`-comments and quoted args). Exit 2 to block, exit 0 (fail-open) otherwise. |
| `graphify-session.js` | `SessionStart` | If a graphify graph exists (`graphify-out/` or `.planning/graphs/`), prime "query the graph first"; safe no-op otherwise. | Detect via `fs.existsSync` at cwd and git toplevel; build JSON via `JSON.stringify` so `GRAPH_DIR` is auto-escaped (fixes F-10 invalid-JSON-on-quote-path); always exit 0. |
| `graphify-reminder.js` | `Stop` (non-blocking) | After a session with ≥2 edits AND a graph present, log a one-line "/graphify --obsidian" reminder. | Parse `transcript_path` via `JSON.parse` (no grep/sed — F-13); count Edit/Write/MultiEdit/NotebookEdit tool_uses in transcript; append to log file; always exit 0; never blocks. |
| `hooks.json` | — | Wire every hook to its event; every `command` is `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"`. | Add a SessionStart entry with matcher `compact` (or `resume`) for `verify-first-full.js` (F-11). Keep PreCompact entry only if/when docs confirm post-compaction injection; otherwise it is belt-and-suspenders, not the survival mechanism. Timeouts ≤ event ceiling (UserPromptSubmit caps at 30s; current 10s fine). Consider 30s for `task-guard.js`/`graphify-reminder.js` (R1 P2, optional). |

### Statusline (`plugins/anti-hall/statusline/`)

| File (target) | Purpose | Invariants |
|---|---|---|
| `statusline.js` | Dispatcher: monorepo vs simple, replacing `statusline.sh`. | Pure Node. Detect git toplevel by spawning `git rev-parse --show-toplevel` via `child_process` (fallback cwd); monorepo if `.gitmodules` file OR `.gsd/` dir OR `.planning/` dir exists (`fs`); require/dispatch to the right renderer in-process (no bash, no `node` subprocess pipe). If git/node concerns: it IS node, so the "node missing" class disappears. |
| `statusline-monorepo.js` | Rich line for monorepo/GSD projects. | Already Node + already crash-safe (silent fail). Fixes: guard context meter with `typeof remaining==='number' && Number.isFinite(remaining)` (F-12 NaN); REMOVE the orphan context-bridge write (F-06) unless a PostToolUse consumer ships. `.gsd`/`.planning` are OPTIONAL — degrade to model|dir|ctx when absent (already does). |
| `statusline-simple.js` | Minimal `model \| branch \| dir \| ctx%`. | Already Node. Apply the same numeric guard for `remaining`. Branch via `execFileSync('git',...)` (cross-platform) — keep. |
| `install-statusline.js` | Cross-platform installer replacing `install-statusline.sh`. | Pure Node. Resolve `~/.claude/settings.json` via `os.homedir()` + `path.join` (all OSes); back up; JSON round-trip via `fs`+`JSON`; set `statusLine.command` to `node "<abs path>/statusline.js"` with the path QUOTED (fixes F-08/F-09 space-in-path); print before/after + revert. |
| `STATUSLINE.md` | Doc. | Remove the context-bridge paragraph (F-06). Update commands to Node invocations. |

### Skills (`plugins/anti-hall/skills/`) — content correct; only doc/portability touch-ups

| File | Status |
|---|---|
| `MODEL-POLICY.md` | Correct and complete (Opus Reviewer + Codex Critic, xhigh→high fallback, alias-in-subprocess caveat, anti-sycophancy). No change required by the rewrite. |
| `root-cause/SKILL.md` | Correct. References the always-on hook by name — update the "verify-first hook" prose if filenames change to `.js` (cosmetic). |
| `orchestration/SKILL.md` | Correct. Mentions `task-tracker.sh`/`task-guard.sh` at lines ~170-176 — update to `.js` after rename (F-05). |
| `feature-launch/SKILL.md` | Correct. Validation-matrix prose ("bash files: `bash -n`") is GENERIC guidance for arbitrary target projects, not the plugin's own files — but add a note that the plugin's OWN scripts validate via `node --check` (F-14). All 8 references now exist (verified §4 F-04). |
| `feature-launch/references/*` | All 8 present (verified). `PRE-TOOL-USE-HOOK.md` ships a BASH sentinel template; since it is a per-PROJECT template the user installs into THEIR repo (not a shipped always-on hook), bash is acceptable there — but for consistency and the OS mandate, ship a Node variant alongside or note the OS caveat (F-15, P2). |
| `deadly-loop/SKILL.md` | Correct. The file-type validation matrix (lines 264-267) routes `*.sh`→`bash -n`; after the rewrite the plugin has no `.sh`, so its own files validate via `node --check` cleanly — the matrix stays as generic guidance for target projects (F-14 note). |

### Top-level

| File | Status / change |
|---|---|
| `plugins/anti-hall/.claude-plugin/plugin.json` | `version: 0.3.0` (single source of truth — correct). Bump to `0.4.0` on this reconciliation (pre-1.0 minor bump). `hooks: "./hooks/hooks.json"` unchanged. |
| `.claude-plugin/marketplace.json` | `source` is a correct GitHub source object; NO `version` key (already removed — verified §5). KEEP `repo: talas9/anti-hall` (required for install) + `owner`/`author` (optional identity, acceptable). |
| `AGENTS.md` | Correct prose mirror, <32 KiB. No change. |
| `README.md` (both) | Fix the fragile statusline install one-liner (F-08); update install command to point at `install-statusline.js`; correct any `.sh` filenames after rename. |
| `CHANGELOG.md` | Add `0.4.0` entry documenting the Node rewrite + R2/R3 fixes. Header note already corrected to "bump plugin.json only". |

---

## 4. Complete defect-fix list (R1 + R2 + traceability, verified against current tree)

Severity, file, fix, and CURRENT STATUS (already-fixed-by-wave / STILL OPEN), each
verified this session. The fix wave changed `git-guard.sh`, `task-guard.sh`,
`verify-first.sh`, `graphify-reminder.sh`, `statusline.sh`, `marketplace.json`, and
created the 2 reference files.

### Already FIXED by the R1 fix wave (verified present in current tree)

| ID | Sev | File | Fix applied | Verified |
|---|---|---|---|---|
| F-01 | P0 | git-guard.sh | Force-push false-block on compound cmds (`git push && rm -f`) — replaced 3 whole-string greps with per-segment tokenized scoping. | FIXED. Re-tested: `git push origin main && rm -f tmp` and a commit message mentioning "push --force" no longer block. |
| F-02 | P1 | git-guard.sh | Self-credit regex false-blocked human "Assistant"/"GPT-3" co-authors — tightened to canonical AI signatures (anthropic.com/@openai.com/`gpt-[45]`/`codex <`/`cursor <`). | FIXED. |
| F-03 | P1 | git-guard.sh | no-python3 fallback scanned the whole JSON envelope (false-block on any doc mentioning git/push/--force) — now extracts only the `command` field, fail-open if unparseable. | FIXED (but see F-13 — this is still bash+python3+jq+sed, an OS-portability defect). |
| F-04 | P1 | feature-launch SKILL.md | Broken refs to `SKILLS_PROTOCOL-template.md` + `code-graph-ignore-template` — both files CREATED. | FIXED. `ls references/` shows both present (verified §3 check). **Brief lists this as still-open; it is NOT.** |
| F-04b | P1 | marketplace.json | Stale top-level `version: 0.2.1` — REMOVED. | FIXED. `grep '"version"' marketplace.json` → no match (verified §5). **Brief lists this as still-open; it is NOT.** |
| F-16 | P1 | task-guard.sh | `/dev/stdin` Windows failure — changed to `fs.readFileSync(0,...)` (fd 0). | FIXED. |
| F-17 | P1 | verify-first.sh | `eval` foot-gun — replaced with `case` statement. | FIXED (but the whole file becomes `.js` under the rewrite — F-13). |
| F-18 | P1 | graphify-reminder.sh | Fragile grep+sed JSON extraction — now python3/jq with hardened sed fallback. | FIXED (but still unix-only — F-13). |
| F-19 | P1 | statusline.sh | node-missing exit-127 crash — added `command -v node || exit 0`. | FIXED (but the dispatcher being bash is itself F-13). |

### STILL OPEN — from R2 (loop did NOT converge; all reproduced this session)

| ID | Sev | File | Defect (with this-session evidence) | Fix |
|---|---|---|---|---|
| F-01b | **P0** | git-guard.sh:68-103 | **Force-push detection BYPASSED when the push segment's first token isn't literally `git`.** Reproduced: `FOO=bar git push origin +main`→exit 0; `command git push --force`→exit 0; `(git push --force origin main)`→exit 0. The loop requires `$1==git`. | In `git-guard.js`, after tokenizing a segment skip leading `VAR=value` assignments + `command`/`builtin`/`exec` wrappers + leading `(`/`{`, THEN require effective verb `git` + subcommand `push`. |
| F-11 | **P0 (architectural)** | hooks.json + verify-first-full.sh | **The "survive compaction" claim (P0-2) is built on an UNVERIFIED mechanism.** KB §1.4 documents `additionalContext` injection for SessionStart/UserPromptSubmit/PreToolUse only — NOT PreCompact. PreCompact fires BEFORE compaction, so its output is part of what the compactor summarizes/discards, not fresh post-reset context. The documented idiom is a **SessionStart hook with matcher `compact`** (re-fires after compaction with `source=compact`). The plugin's SessionStart entry has NO matcher. If PreCompact additionalContext doesn't re-inject, the Iron Law is lost at the first compaction — the exact failure P0-2 claims to fix. | (a) Verify against the official hooks reference whether PreCompact re-injects. (b) Add a SessionStart entry with `matcher: "compact"` invoking `verify-first-full.js`; have the script detect `source`. (c) Correct README/CHANGELOG "survives compaction" wording until the mechanism is verified. |
| F-10 | P1 | graphify-session.sh:47-49 | **Emits INVALID JSON when the project path contains `"` or `\`.** Reproduced: a graph dir under `/tmp/gs test"x/graphify-out` produced unparseable JSON (`json.load` failed at col 162). Hand-emitted JSON interpolates `GRAPH_DIR` raw. | In `graphify-session.js`, build the payload with `JSON.stringify` — auto-escapes. (The Node rewrite fixes this class entirely.) |
| F-05 | P2 | task-guard.sh | **`.sh` extension on a `#!/usr/bin/env node` file** breaks extension-keyed tooling and the plugin's OWN deadly-loop validation matrix (`*.sh`→`bash -n` errors; `*.js`→`node --check` errors on `.sh`). Verified: still `task-guard.sh`, hooks.json line 68 references `.sh`. | Rename → `task-guard.js`; update hooks.json command path. (Folded into the Node rewrite.) |
| F-06 | P2 | statusline-monorepo.js:242-255 + STATUSLINE.md:40 | **Orphan context-bridge write:** every render writes `$TMPDIR/claude-ctx-<session>.json` "for the context-monitor PostToolUse hook", but NO such hook ships. Verified: lines 242/246 present; hooks.json has no PostToolUse/context-monitor. Dead code + doc overstating surface. | Remove the bridge write + the STATUSLINE.md note (OR ship the consumer — recommend remove; out of scope to add a new hook). |
| F-07 | P2 | task-guard.sh:54-56,108-110 | **Loop-state written into the user's project tree** (`<projectDir>/.anti-hall/last-stop-taskset`) — pollutes a stranger's repo, shows as dirty git status, per-cwd dedupe resets on `cd`. | In `task-guard.js`, write state under `os.tmpdir()/anti-hall-<session_id>` keyed by session_id. |
| F-08 | P2 | README.md:70 | **Fragile statusline install one-liner.** Verified present. Empty glob → `dirname ""`→`.`→silently runs `./anti-hall/...` against cwd. | Replace with: point users to run `install-statusline.js` from the installed plugin dir (find via `/plugin`), with a clear empty-glob error path. |
| F-09 | P2 | install-statusline.sh:38-42 | **Unquoted dispatcher path** in the emitted `statusLine.command` → word-splits on space-containing install paths. | In `install-statusline.js`, emit `node "<quoted abs path>/statusline.js"`. |
| F-12 | P2 | statusline-monorepo.js:238-267 | **Renders `[] NaN%`** when `remaining_percentage` is a non-numeric string. Reproduced: output ended `[] NaN%`. simple.js's `remaining != null` is also too loose. | Guard with `typeof remaining==='number' && Number.isFinite(remaining)` in BOTH renderers. |
| F-20 | P2 | verify-first-full.sh:33-38 | **PreCompact event detection brittle to JSON whitespace** (only matches two exact-spacing substrings). Reproduced: `{ "hook_event_name" : "PreCompact" }`→echoed `SessionStart`. | In `verify-first-full.js`, parse `hook_event_name` with `JSON.parse`. (Node rewrite fixes; also tied to F-11.) |
| F-21 | P2 | git-guard.sh:97 | **False-block on a `+token` in a trailing shell comment.** Reproduced: `git push origin main # +1 reviewer`→exit 2. | In `git-guard.js`, strip `#...` comments and apply the `+refspec` test only to positional args after `push`. |
| F-22 | P2 | git-guard.sh self-credit | **`-F`/`--file`/editor commits bypass the self-credit guard** (only the inline `-m` string is scanned). Reproduced: `git commit -F /tmp/msg.txt`→exit 0. Inherent fail-open limit, but the header oversells "mechanically enforces". | Either best-effort read the referenced message file, OR (recommended) downgrade the header/README/CHANGELOG wording to "blocks inline `-m` self-credit trailers; `-F`/editor commits are not scanned (fail-open)". Honesty matters for an anti-hall plugin. |

### NEW — OS-portability + traceability defects this plan adds

| ID | Sev | File(s) | Defect | Fix |
|---|---|---|---|---|
| F-13 | **P0** | ALL `.sh` hooks + `statusline.sh` + `install-statusline.sh` | **Not OS-agnostic.** Every hook except task-guard is bash/POSIX using bash, cksum, grep -E, sed, python3, jq — none of which exist on native Windows. The plugin claims "any machine, any repo" but is Unix-only. | Rewrite ALL of them in Node.js (built-ins only). hooks.json invokes `node "<...>.js"`. See §3 + §8. |
| F-14 | P2 | deadly-loop + feature-launch validation matrices | The plugin's own files should validate via `node --check`, not `bash -n`, after the rewrite. The matrices are generic guidance for arbitrary target projects (keep them), but add a one-line note that the plugin's OWN scripts are all `.js`/validated by `node --check`. | Add the note; do not narrow the generic matrix. |
| F-15 | P2 | feature-launch/references/PRE-TOOL-USE-HOOK.md | Ships a bash-only sentinel template. As a per-project template the user installs into THEIR repo it is acceptable, but it contradicts the OS mandate for the plugin itself. | Ship a Node variant of the sentinel alongside, OR add a clear OS caveat that the template assumes a POSIX shell and a Node version is recommended for Windows. (P2 — does not block the rewrite.) |

**Convergence accounting for the brief's question:** the deadly-loop reported
`converged: false`. Already-fixed: **9** R1 findings (F-01..F-03, F-04, F-04b,
F-16..F-19). Still-open: **13** (F-01b, F-05..F-12, F-20..F-22, F-11) + **3** new
(F-13..F-15). A Round 3 is REQUIRED after the Node rewrite to reach zero NEW P0s.

---

## 5. AGNOSTIC MANDATE (P0 — this is a public repo)

**Forbidden in SHIPPED files** (anything under `plugins/`, plus `AGENTS.md`,
`.claude-plugin/marketplace.json`, top READMEs/CHANGELOG): project codenames
(`skycrew`, `toolfox`/`toolfox3`, `talas-ai`, `paperclip`, `sky-crew`), repo names
(`skyflutter`, `skyfb`, `skyinform`, `skydart`, `skylog`), product nouns tied to one
project (`revenuecat`, `airalo`, `codemagic`), personal names beyond the unavoidable
identity coordinate, any GSD-internal assumption baked as REQUIRED, and any absolute
`/Users/...` or `/home/<name>/...` path.

### Scan run THIS session — results

Command:
```
grep -rniE 'skycrew|toolfox|talas-ai|paperclip|sky-crew|\.gsd\b|skyflutter|skyfb|skyinform|revenuecat|airalo' \
  plugins/ AGENTS.md .claude-plugin/marketplace.json
grep -rniE '/Users/|/home/[a-z]' plugins/ AGENTS.md .claude-plugin/marketplace.json
grep -rniE 'talas9|mohammed talas|marius'  plugins/ AGENTS.md .claude-plugin/marketplace.json
```

Hits found (all acceptable / not violations — analyzed):

- **`.gsd` references (5):** `README.md:66`, `STATUSLINE.md:64`,
  `statusline-monorepo.js:4`, `statusline.sh:6` + `:32`. These are GENERIC monorepo/
  GSD-project DETECTION (treat a repo as a monorepo if `.gsd/` exists), NOT a SkyCrew
  coupling. **Acceptable** — but the plan MUST keep `.gsd`/`.planning` strictly
  OPTIONAL: detection by `.gitmodules` is the generic primary signal; `.gsd`/`.planning`
  are bonus signals that must degrade gracefully (statusline already omits the GSD
  segment when `.planning/STATE.md` is absent — verified in `formatGsdState`/
  `readGsdState`). No code change needed for agnosticism; keep the graceful-absence
  behavior in the Node rewrite.
- **Identity coordinates:** `README.md:91` `/plugin marketplace add talas9/anti-hall`;
  `plugin.json` `author.name`/`url`/`homepage`/`repository`; `marketplace.json`
  `owner.name`/`repo: talas9/anti-hall`/`author.name`. **Policy decision: KEEP the repo
  coordinate** (`talas9/anti-hall` and the GitHub URLs) — it is REQUIRED for
  `/plugin marketplace add` and `/plugin install` to resolve (KB §2.3 GitHub source).
  Removing it breaks installation. **`author`/`owner` name is OPTIONAL** metadata; it
  may stay (it is the genuine author) or be reduced to the GitHub handle — recommend
  keeping as-is; it leaks no project secret.
- **No `skycrew`/`toolfox`/`paperclip`/etc. project-name hits. No absolute
  `/Users/` paths in shipped files. No `marius`.** (`/Users/...` appeared only in the
  deadly-loop RESULT file, which is not shipped.)

**Verdict: the current shipped tree PASSES the agnostic mandate.** No scrub work is
required beyond keeping the OS rewrite from introducing absolute paths (the installer
must use `os.homedir()`, never a literal `/Users/...`). The verification command to
re-run after the rewrite (CI gate, F-23 below):
```
grep -rniE 'skycrew|toolfox3?|talas-ai|paperclip|sky-crew|skyflutter|skyfb|skyinform|skydart|skylog|revenuecat|airalo|codemagic' \
  plugins/ AGENTS.md .claude-plugin/marketplace.json \
  && echo "AGNOSTIC FAIL" || echo "AGNOSTIC PASS"
grep -rnE '/Users/|/home/[a-z]' plugins/ AGENTS.md .claude-plugin/marketplace.json \
  && echo "ABSPATH FAIL" || echo "ABSPATH PASS"
```
(`grep` is fine in a CI runner — CI runs on Linux. The OS mandate is about the
SHIPPED hook RUNTIME, not the developer's test harness.)

**`statusline-monorepo.js` GSD coupling check:** the only GSD-specific logic is
`readGsdState`/`formatGsdState`/`readGsdConfig` parsing `.planning/STATE.md` +
`.planning/config.json`. All are wrapped so a missing `.planning/` yields an empty
state object and the segment is omitted (`gsdStateStr` empty → `middle=null`). This is
already generic-by-degradation; preserve that behavior in the rewrite. The monorepo
DETECTION (`.gitmodules` || `.gsd` || `.planning`) is generic.

---

## 6. Edge cases & scenarios to simulate per component

Each row is a scenario the Round-3 deadly-loop and the acceptance matrix must cover.

| Component | Scenarios to simulate |
|---|---|
| `verify-first.js` | empty prompt; huge (>1MB) prompt; non-UTF8/binary prompt bytes; prompt that is itself JSON (no injection); same prompt twice → same nudge (deterministic); 5 distinct prompts → spread across the 5 nudges; missing stdin (closed fd). |
| `verify-first-full.js` | SessionStart `source=startup`; SessionStart `source=compact`; SessionStart `source=resume`; PreCompact payload (compact + spaced JSON — F-20); unparseable stdin → defaults SessionStart; output length < 10k chars (KB §1.6). |
| `task-tracker.js` | always emits valid static JSON regardless of stdin. |
| `task-guard.js` | no open tasks → silent exit 0; open tasks first block → block decision; identical open set second Stop → silent (loop-safe); changed open set → blocks again; huge transcript (>400KB, early TodoWrite) → must NOT silently miss (stream JSONL, F-ref R1-P2); unwritable state dir → fail-open + (optional) stderr warn; missing/empty transcript path → exit 0; Windows (fd 0 read, tmpdir path separators). |
| `git-guard.js` | ALLOW: `git push origin main`, `git commit -m "fix push --force docs"`, `git push && rm -f tmp`, `grep -f patterns.txt && git push`, human `Co-authored-by: Pat Assistant`, `git push origin main # +1 reviewer`. BLOCK: `git push --force`, `git push origin +main`, `-c x=y push --force`, `FOO=bar git push +main` (F-01b), `command git push --force` (F-01b), `(git push --force ...)` (F-01b), AI `Co-Authored-By: Claude <noreply@anthropic.com>`. Note `-F`-file commit limitation (F-22). Unparseable stdin → fail-open exit 0. Windows line endings in command. |
| `graphify-session.js` | no graph → silent exit 0; `graphify-out/` present; `.planning/graphs/` present; graph dir path containing `"`/`\`/space → VALID JSON (F-10); not in a git repo (cwd only). |
| `graphify-reminder.js` | <2 edits → silent; ≥2 edits + graph → log line; no graph → silent; transcript path with escaped chars; missing transcript; unwritable log dir → silent. |
| `statusline.js` + renderers | `{}` empty stdin → sane minimal line, no crash; missing `context_window` → omit meter; non-numeric `remaining_percentage` → omit (F-12); not a git repo → omit branch; monorepo with no `.planning/` → omit GSD segment; node present (always, since it IS node); Windows path basename. |
| `install-statusline.js` | settings.json missing → clear error; existing statusLine → printed + replaced; install path containing spaces → quoted command works (F-09); Windows `~/.claude` resolution via `os.homedir()`; idempotent re-run. |
| Install lifecycle | `/plugin marketplace add talas9/anti-hall` resolves via GitHub source; install before plugin cached (README one-liner must not silent-misfire — F-08); plugin under a space-containing cache path. |

---

## 7. Acceptance criteria + validation matrix

A change is DONE only when every row passes (paste actual output — KB §4.2,
verify-before-completion). NOTE the OS mandate: validation runs under **`node --check`
for every script**; do NOT use `bash -n` (cannot assume bash exists on the target).

| Check | Command | Pass condition |
|---|---|---|
| JS syntax (every hook + statusline + installer) | `node --check <file>.js` (loop over all) | exit 0 for all |
| hooks.json valid + every command is `node ...` | `node -e "const h=require('./hooks/hooks.json'); /* assert all commands start with node */"` | parses; all commands invoke `node` |
| plugin.json / marketplace.json valid | `node -e "require('./.claude-plugin/...')"` | parse clean; plugin.json has `version`; marketplace has NO `version` |
| Hook JSON output validity (smoke) | `echo '{...}' \| node hooks/verify-first.js \| node -e "JSON.parse(require('fs').readFileSync(0))"` | valid JSON, additionalContext present |
| verify-first variation | feed 5 distinct prompts | ≥2 distinct nudges; same prompt twice → identical |
| verify-first-full event echo | feed SessionStart/`compact`/PreCompact (incl. spaced JSON) | echoed hookEventName matches firing event (F-20) |
| git-guard block/allow grid | the 13 cases in §6 | all ALLOW exit 0, all BLOCK exit 2, incl. F-01b/F-21 |
| graphify-session JSON on hostile path | run from a dir with `"` in name | valid JSON (F-10) |
| task-guard loop-safety + big transcript | identical set → silent; 500KB early-TodoWrite transcript | no double-block; no silent miss |
| statusline empty + NaN | `echo '{}' \| node statusline.js`; non-numeric remaining | sane line; meter omitted (F-12) |
| installer space-path | install under a space-containing path | emitted command quoted, statusline loads (F-09) |
| Emoji scan | `node -e "/* scan all shipped files for emoji codepoints */"` or `grep -P '[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}]' -r plugins/` | zero hits (no emojis anywhere) |
| Agnostic scan (F-23) | the two greps in §5 | AGNOSTIC PASS + ABSPATH PASS |
| Install dry-run | `/plugin marketplace add talas9/anti-hall` then `/plugin install` in a throwaway session | loads without error; hooks fire |
| Plugin validate | `claude plugin validate --strict` (KB §2.6) | passes |
| Round-3 deadly-loop | re-run the loop on the Node tree | **zero NEW P0s → converged: true** |

---

## 8. Execution phases (for the follow-up implementing agent)

Order chosen so each phase is independently verifiable and the highest-risk, highest-
value items land first. After EACH phase, run that phase's validation rows from §7
(this dogfoods feature-launch's per-phase deadly-loop discipline). Do NOT mark a phase
done without pasted command output.

**Phase 0 — Branch + baseline.** Branch off (never commit straight to a public main
without authorization). Snapshot current SHAs. Re-run the §5 agnostic scan to confirm
the starting state (PASS). Record in a handoff doc.

**Phase 1 — git-guard.js (P0 F-01b, F-21; carries F-01/02/03 logic forward).**
Rewrite `git-guard.sh`→`git-guard.js` in pure Node: parse `tool_input.command` via
`JSON.parse`; reimplement self-credit (canonical signatures) + force-push (segment
tokenize, strip `VAR=`/`command`/`builtin`/`exec`/`(`/`{`, require effective `git
push`, test `--force`/`-f`/`--force-with-lease`/positional `+refspec` excluding
comments). Verify the full §6 git-guard grid (13 cases). Update hooks.json command +
matcher. *Highest-risk: this is the hard gate; F-01b is an open P0.*

**Phase 2 — verify-first.js + verify-first-full.js + task-tracker.js + hooks.json
compaction fix (P0 F-11, F-20, F-13).** Rewrite the three injectors in Node
(`crypto` hash replaces cksum; `JSON.stringify` replaces hand-emit; `JSON.parse` for
event detection). Add the SessionStart `matcher: "compact"` entry for
`verify-first-full.js`; verify against the official hooks docs whether PreCompact
re-injects and correct the README/CHANGELOG wording accordingly. Verify event echo +
variation + <10k output.

**Phase 3 — task-guard.js + graphify-session.js + graphify-reminder.js (F-05, F-07,
F-10, F-13, R1 big-transcript).** Rename task-guard `.sh`→`.js`; move loop-state to
`os.tmpdir()/anti-hall-<session_id>`; stream JSONL (no 400KB window miss).
graphify-session/reminder → Node with `JSON.stringify`/`JSON.parse`. Update hooks.json
paths. Verify loop-safety, hostile-path JSON, big transcript.

**Phase 4 — statusline.js dispatcher + renderers + install-statusline.js (F-06, F-08,
F-09, F-12, F-13).** Replace `statusline.sh`→`statusline.js` (in-process dispatch, git
via child_process); remove the orphan context-bridge write; add numeric guards to both
renderers; rewrite installer in Node with quoted `node "<path>"` command + `os.homedir()`.
Fix the README install one-liner. Update STATUSLINE.md. Verify empty/NaN/space-path.

**Phase 5 — docs + version + traceability (F-04 confirm, F-14, F-15, F-22 wording).**
Update both READMEs to Node filenames + the corrected install path; add the §3 skill
prose `.js` filename touch-ups (orchestration, root-cause); add the F-14 note to the
validation matrices; downgrade the git-guard "mechanically enforces" wording for the
`-F` gap (F-22); decide F-15 (ship Node sentinel variant or add OS caveat). Bump
`plugin.json` `version`→`0.4.0`; add the CHANGELOG `0.4.0` entry. Confirm
marketplace.json still has no `version`.

**Phase 6 — full validation + Round-3 deadly-loop.** Run the ENTIRE §7 matrix
(`node --check` on every file, emoji scan, agnostic scan, install dry-run,
`claude plugin validate --strict`). Then re-run the deadly-loop (Reviewer Opus + Critic
Codex/2nd-Opus per MODEL-POLICY) on the Node tree and iterate fix-waves until
**zero NEW P0s (converged: true)** — the gate the original loop never reached. Only
then is the reconciliation done.

**Hard boundaries (never autonomy-bypass):** no force-push; no commit/push without
explicit authorization; do not touch any `firestore.rules` (N/A here but the habit
stands); the public repo means the agnostic scan is a release gate, not a nicety.

---

## Appendix — brief-vs-tree discrepancies the implementer must know

The task brief listed several items as "known still-open" that are in fact ALREADY
FIXED in the current tree (verified this session). Do not redo them; just confirm:

- **"stale root `version` in marketplace.json"** — ALREADY removed (no `version` key).
- **"missing feature-launch references (SKILLS_PROTOCOL-template.md,
  code-graph-ignore-template)"** — BOTH already created by the fix wave; all 8
  references present.

Genuinely still-open from the brief's list (all confirmed reproduced): fragile
statusline install one-liner (F-08), orphan context-bridge write (F-06),
task-guard `.sh`→`.js` rename + hooks.json + validation note (F-05/F-14). Plus the two
P0s the loop left open (F-01b, F-11) and the new OS-agnostic mandate (F-13).
