# anti-hall — extended guide

> Detail moved out of the READMEs during the v0.107.0 doc sweep so the top-level
> READMEs stay a scannable landing page. Nothing here is deleted — every fact that
> used to live in README.md / plugins/anti-hall/README.md is preserved below,
> verbatim where practical.

**New in 0.108.0** (full list: [CHANGELOG](../CHANGELOG.md)): automatic handover at
85% context (`auto-handover.js`, `auto-handover-pause-nag.js`); one settings store and the
`/anti-hall:settings` skill ([Settings](#settings-anti-hallsettings)); repairs on every
reload (`repair-on-reload.js`); update-vs-reload version alerts; Jev cost, precision,
budget watch and credit balance; and for DevSwarm the app database as ground truth
([KB-devswarm-app-db.md](KB-devswarm-app-db.md)), a capability gate, auto-archive,
owner-approved prune and message retention. Per-component detail is in the
[Features table](#hook-reference--plugin-features-table-detailed-per-hook).

## Contents
- [What it is, and why it exists](#what-it-is-and-why-it-exists)
- [What it blocks, and how to turn it off](#what-it-blocks-and-how-to-turn-it-off)
- [Limits and escape hatches](#limits-and-escape-hatches)
- [Network and data](#network-and-data)
- [Install, verify and uninstall](#install-verify-and-uninstall)
- [Requirements](#requirements)
- [Capabilities at a glance](#capabilities-at-a-glance)
- [What's inside and updating](#whats-inside-and-updating)
- [Hook reference (detailed)](#hook-reference-detailed) — how it works, per mechanism
- [Skills reference (detailed)](#skills-reference-detailed)
- [DevSwarm (current state)](#devswarm-current-state)
- [Contributing / testing (plugin)](#contributing--testing-plugin)
- [Features table — every hook and component](#hook-reference--plugin-features-table-detailed-per-hook)
- [Statusline](#statusline-opt-in-one-command)
- [Settings (`/anti-hall:settings`)](#settings-anti-hallsettings)
- [Configuration / tuning](#configuration--tuning)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Test locally](#test-locally)

## What it is, and why it exists

anti-hall is a Claude Code **marketplace + plugin**, plus a separate Codex-native port,
that keeps coding assistants from acting before they verify. It ships always-on Node
hooks (mechanical guards no prompt can talk around), a set of evidence-driven workflow
skills, and a live two-line statusline. A small Rust engine answers the hooks with Node.js 22+ as the fallback, no npm dependencies, **macOS · Linux**
(Node ≥ 22 on `PATH` is the only prerequisite; Windows is not supported).

It targets four predictable failure modes: **eagerness** (acting before investigating),
**hallucination** (stating unverified facts as truth), **fix-before-diagnosis** (patching
a symptom before proving the cause), and **fake completion** ("done" without running the
check). See [why it exists, and what's proven vs. not](#hook-reference-detailed) for the
eval behind that claim.

**Before and after.** An assistant, mid-task, runs a force-push to `main`. Without anti-hall, the published history is rewritten. With it, the command never runs and the assistant is told:

> anti-hall git-guard: BLOCKED. Force push detected. Rewriting published history is a deliberate human action - do it manually with explicit owner confirmation, never from an automated push.

The Claude plugin is the authoritative package; the Codex port
(`plugins/anti-hall/codex/`) is a separate, intentionally non-1:1 mirror (different
`hooks.json`, different skill set (`anti-hall-*`), same underlying guards where payload
contracts are verified for Codex) — see
[plugins/anti-hall/codex/README.md](../plugins/anti-hall/codex/README.md) for hook parity
and [Codex / cross-tool](#codex--cross-tool) for the Codex/OMX detail.

## What it blocks, and how to turn it off

The main guards. Every one can be switched off with its setting (`/anti-hall:settings` or `node plugins/anti-hall/scripts/settings.js set <key> false`); the `/config` panel only has the four `safety.*` switches among them. The four `safety.*` keys are locked: changing them needs `--confirmed`. Separately, you can tell the assistant to skip a guard for a short time; it records that in `~/.anti-hall/skip.json` (per guard name, expires after 15 minutes by default; `"all"` never covers `git-guard`, which must be named).

| Guard | What it stops | Why | Turn off |
|---|---|---|---|
| `git-guard` | Force-push and AI self-credit in commits and `gh` PR/issue/release text | Rewriting published history and AI co-author trailers are human decisions | `safety.gitGuard`; skip name `git-guard` |
| `command-guard` | The main session running heavy commands (build, test, deploy, push) itself | Keeps the main conversation free; helpers do the long work | `safety.commandGuard`; skip name `command-guard` |
| `edit-guard` | The main session editing files outside its own plan/state/handover files | Edits go through a helper that can be checked | `safety.editGuard`; skip name `edit-guard` |
| `swarm-guard` | Agent spawns past the spawn-rate cap or under critical memory pressure | Prevents a fork-bomb of agents overloading the machine | `safety.swarmGuard`; skip name `swarm-guard` |
| `api-guard` | Written code that calls a standard-library or built-in API that does not exist | Catches invented functions before they land | `guards.apiGuard`; skip name `api-guard` |
| `speculation-guard` | A turn that ends on unverified, hedged claims | Claims need evidence, not "probably" | `guards.speculationGuard`; skip name `speculation-guard` |
| `output-verify-guard` | Unverified completion claims | "Done" needs a check that was actually run | `guards.outputVerifyGuard` |
| `task-guard` / `tasklist-guard` | Stopping while tracked tasks are open; multi-step work with no task list or progress file | Stops half-finished work being reported as finished | `guards.taskGuard` / `guards.tasklistGuard`; skip names `task-guard` / `tasklist-guard` |

Everything else, with the exact behaviour of each hook: the
[Features table](#hook-reference--plugin-features-table-detailed-per-hook).

## Limits and escape hatches

Guards are pattern- and rule-based. They can block or nag when they should not, and they can miss things. This section lists the switches, the known gaps and the costs.

### Escape hatches

| To do this | Use |
|---|---|
| Skip one guard for a short time | Tell the assistant to skip it. It writes `~/.anti-hall/skip.json` (per guard name, 15 minutes by default). `"all"` covers the noisy guards but never `git-guard`; name `git-guard` to skip it. See [User-override escape hatch](#user-override-escape-hatch-skip-guard). |
| Turn a safety guard off | `safety.gitGuard`, `safety.commandGuard`, `safety.editGuard`, `safety.swarmGuard`. Changing them needs `--confirmed`. |
| Turn another guard off or down | `guards.*`, for example `guards.apiGuard`, `guards.speculationGuard`, `guards.modelRouting` = `advisory` or `off`. |
| Silence an advisory message | `guards.failureRootCauseNudge`, `guards.silentAgentNudge`, `guards.scanThrottle`, `codexNudge.enabled`, `autoHandover.nag`, `limitConserve.mode` = `off`. |
| Acknowledge a confirmed false positive | `guards.stopAck` lets a session ack it for `silent-agent-nudge` and `tasklist-guard`. |
| Get the full protocol text | `context.protocolLevel` = `full` (env `ANTIHALL_PROTOCOL_LEVEL=full`). |

The full key list is in [Settings](#settings-anti-hallsettings).

### Protocol text size

The injected protocol text is compact by default. The session-start core keeps every load-bearing clause and points at the generated `plugins/anti-hall/PROTOCOL.md` for the full wording. `context.protocolLevel` = `full` restores the previous text byte for byte. Sizes are in the [CHANGELOG](../CHANGELOG.md) (a synthetic size measure, not a per-run saving).

### Remaining limits

False positives that were fixed are listed in the [CHANGELOG](../CHANGELOG.md). What is still true:

- **Shell commands are parsed, not executed.** `git-guard` resolves git and shell aliases, but it reads the command text; it does not run it.
- **Heredocs and indirect runs in `git-guard`.** A heredoc written to a prose/data file (`.md`, `.txt`, ...) or used as a commit, tag or PR body is treated as data and not scanned as commands, provided every git/gh beside it uses only a short flag allowlist. Commands run through `xargs`, `parallel`, `find -exec`, `flock` and wrappers such as `stdbuf` or `setsid` get the same checks as a direct run. Still not covered: a subcommand that comes only from stdin (`cat f | xargs git`) cannot be seen, and `git reset --hard` has no rule. A script written by a heredoc is still scanned, even when it is never run.
- **Commit messages.** A message taken from an existing commit (`-C`, `--amend --no-edit`, a template) is checked before the commit. A message written in an editor, or changed by a `commit-msg` hook, does not exist yet at that point; it is audited after the commit, so the commit is not blocked.
- **Shell writes.** Writes made through the shell (`cat >`, `tee`, `sed -i` and similar) reach `edit-guard`, `api-guard` and `ship-it-guard`. Some forms still fail open: a variable or glob as the target, `dd`, `install` and `rsync`, and scripts that write when they run.
- **`speculation-guard` is lexical.** It catches hedge words. It does not catch a confident claim with no hedge word. Two opt-in checks target that gap; see the next subsection. Both are off by default.
- **Prompt text alone does not reduce fabrication.** The verify-first eval found no net fabrication reduction from the prompt alone in four runs ([tools/eval/README.md](../tools/eval/README.md)). The guards' blocking is covered by unit tests, not by that eval.
- **Advisory noise.** Replaying 5,828 real root-cause nudges from 30 days of transcripts, 3,438 still fire after the filter. `output-verify-guard` fires at most once per turn for the same signals. Both can still be wrong; use the switches above.
- **Codex.** `edit-guard`, `api-guard` and `ship-it-guard` cover `apply_patch` edits and shell writes on Codex 0.134 or later. The fail-open shell forms above apply there too. See the [Codex port notes](../plugins/anti-hall/codex/README.md).

### Opt-in checks for confident claims

| Check | Setting | Precision, synthetic corpus | Precision, real replies | Cost | Default |
|---|---|---|---|---|---|
| Inference check | `guards.inferenceCheck` | 1.00 (recall 0.95) | 0.45 or lower (estimate from a 40-flag sample) | none (no model call) | off |
| Judge, keyless backend | `jev.semanticJudge` on, `jev.judgeBackend` = `cli` | 0.78 to 0.81 (recall 1.0) | not measured | 5 to 6 s per turn end, measured | off |
| Judge, API backend | `jev.semanticJudge` on, `jev.judgeBackend` = `api` | not measured | not measured | about 1 to 3 s and $0.0001 to $0.001 per turn end, estimated | off |

The synthetic corpus is 84 labelled cases (`tools/eval/inference-bench.js`), written by the same author as the detector, so read it as a regression floor. Both checks stay off because of these numbers: the inference check was wrong more often than right on real replies, and the judge adds a visible delay to every turn end. Details: [speculation-judge](#speculation-judge-tier-3-opt-in).

### Hook latency

The numbers below are for the Node hooks. With the engine running most calls skip the Node start-up; its pre-release replay numbers are in [AH-ENGINE.md](AH-ENGINE.md#measured-results-pre-release) and are not part of these tables.

Hooks are small per call but not free. On a quiet machine a bare `node -e 0` costs about 16 to 18 ms of CPU and most hooks cost 22 to 35 ms. Claude Code runs a matcher's hooks in parallel, so a tool call costs about its slowest hook, while CPU adds up across hooks. The DevSwarm hooks exit before loading their libraries in a session that is not a DevSwarm Primary or child, which saves about 20 ms of CPU per Stop and about 25 ms per prompt. The measured tables, method and caveats are in [HOOK-LATENCY](HOOK-LATENCY.md).

### The engine

`ah-engine`, a small Rust program, is the core component: it answers the hook calls without starting Node per call. The plugin's hooks are one
thin trigger per event; the engine decides natively what it can prove identical to the Node hook and defers the rest to Node (never
weaker than Node). The Node hooks are a temporary fallback for a missing or failed binary and are removed in v1.0. The binary is downloaded once
from the GitHub Release by a shell bootstrap and installed only if its sha256 equals the one pinned in the plugin's `ah-engine.lock`
(the setting `engine.bootstrap` = false, or `AH_ENGINE_BOOTSTRAP=0`, skips it). All its rules, settings and texts are plain files in `plugins/anti-hall/engine/`, read at run
time with hot reload and fallbacks (edited, then last-known-good, then pristine, then Node), and `ah-engine config heal` restores a
missing key. Still on Node: the DevSwarm mesh writes and daemons, every call that consults Jev, the semantic judge's model call and the
statusline. macOS and Linux only; Windows is not supported yet.

Full description (install, go-live, rollback, failover, telemetry, what runs on Node, pre-release measurements): [AH-ENGINE.md](AH-ENGINE.md).

## Network and data

The short form is in the README; the full table is [PRIVACY.md](../PRIVACY.md). Nothing
here goes beyond it: no analytics and nothing reported to anyone; one default-on update check (a tag-list request to
`github.com/talas9/anti-hall`, no project data; off via `versionAlerts.antiHall` or
`ANTIHALL_VERSION_ALERT=off`); a one-time download of the `ah-engine` binary from the GitHub Release
(sha256-pinned in the plugin, nothing about you sent; off via the setting `engine.bootstrap` or `AH_ENGINE_BOOTSTRAP=0`); local-only engine usage counters
(identifiers and counts, never content; `telemetry.enabled`; read with `ah-engine telemetry summary`); the Jev classifier, the semantic judge
(`jev.semanticJudge` or `ANTIHALL_SEMANTIC_JUDGE=1`) and mesh message triage are off by default and send the
text they judge only to the provider you configure. API keys come from sensitive plugin
options; reading a key from the environment or a key file is opt-in
(`jev.allowLegacyKeyRead`, `guards.allowAnthropicEnvKey`), and the Jev endpoint override
is loopback-only. Everything else (logs, handovers, defect reports) stays in
`~/.anti-hall/` and `<repo>/.anti-hall/`. `gh`, `codex` and `hivecontrol` run under your
own accounts; the plugin does not spawn `gh` or `codex`.

## Install, verify and uninstall

Prerequisite: **Node.js >= 22** on `PATH` (check with `node --version`).

**Claude Code:**

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

To try it without installing: `claude --plugin-dir /path/to/anti-hall`. The hooks apply
globally once enabled; the statusline is a separate one-command install
([Statusline](#statusline-opt-in-one-command)).

**Codex** (from scratch; the installer lives in the repo, so clone it first):

```bash
git clone https://github.com/talas9/anti-hall.git
cd anti-hall
node plugins/anti-hall/codex/install-codex.js            # project-local: writes ./.codex/hooks.json
node plugins/anti-hall/codex/install-codex.js --global   # or user-wide: writes ~/.codex/hooks.json
```

Add `--dry-run` to preview. The installer merges into an existing `hooks.json`, backs up any file it changes (`.bak-<timestamp>`), and enables `[features] hooks = true` in the matching `config.toml`.

**Git-ignore the state directory:** anti-hall writes per-project session notes (progress, history, handovers, reports) under `.anti-hall/` in your repo, and never edits your tracked files. Add `.anti-hall/` to your project's `.gitignore` so a `git add .` can't commit them (or run `/anti-hall:doctor --repair`, which appends it to the untracked `.git/info/exclude`).

**Verify it worked:** in Claude Code, ask "is anti-hall working" (runs the `doctor` skill: live self-tests on every guard), or run `/anti-hall:settings` to see the active settings. From a clone you can also run `node plugins/anti-hall/hooks/doctor.js --check`.

### Uninstall

**Claude Code:**

```bash
claude plugin uninstall anti-hall@anti-hall
claude plugin marketplace remove anti-hall   # optional: also drop the marketplace
```

If you installed the statusline, remove it first with the `install-statusline` skill's uninstall, or run `node statusline/uninstall-statusline.js` from the plugin directory (it restores your previous `statusLine`).

**Codex:** the installer has no uninstall flag. Open `.codex/hooks.json` (project) or `~/.codex/hooks.json` (global) and delete the hook groups whose command path contains `/plugins/anti-hall/hooks/`; the installer's `.bak-<timestamp>` copies hold your prior file. The `[features] hooks = true` line it added to `config.toml` is left alone.

**Optional companions** (only if you installed them; run from `plugins/anti-hall/companion/` in a clone or the plugin directory):

```bash
node install-reaper.js --uninstall                # MCP orphan reaper (macOS LaunchAgent com.anti-hall.mcp-reaper / Linux systemd --user timer)
node install-devswarm-supervisor.js --uninstall   # DevSwarm liveness supervisor (com.anti-hall.devswarm-supervisor)
node install-devswarm-ingest.js --uninstall       # DevSwarm ingest daemon (com.anti-hall.devswarm-ingest)
```

`~/.anti-hall/` holds your settings, skip file and logs; it is not removed automatically. Delete it yourself only if you want that state gone.

## Requirements

**Node.js ≥ 22 on `PATH`.** Every hook and the statusline are pure Node (built-ins
only), launched as `node <hook>.js` (directly, or by `ah-engine` for the cases it hands back to Node). No `node` on the hook shell's `PATH` means Claude
Code silently skips every anti-hall hook — verify with `node --version`. No npm
install, no native deps, no other config. There is intentionally no shell-based
preflight. Install Node from <https://nodejs.org>.

**Supported systems:** macOS and Linux (both CI-tested), including WSL on Windows,
which runs the Linux build. Native Windows is not supported yet.

**The `/config` rows (14 options) need Claude Code ≥ 2.1.269; older versions still work via the skill.**
The plugin's `userConfig` never declares `options` (a public plugin can't require v2.1.271+
just for its settings UI — per the Claude Code plugin docs, an `options` picker would break
loading on older versions), so every version can load the plugin; enum settings just render
as a plain string field describing the allowed values instead of a picker.

## Capabilities at a glance

Terms used below: **DevSwarm** is a multi-workspace orchestration app with a `hivecontrol` CLI; anti-hall's integration is optional and dormant unless you use it. **Jev** is TypeSafe's "System One" decision model, used as an opt-in classifier. **deadly-loop** is a parallel Reviewer + Auditor + Critic debate with fix waves, run before merging risky changes.

| Area | What it does |
|---|---|
| **Guards** | Mechanical, always-on Node hooks — block AI self-credit/force-push (`git-guard`), fabricated stdlib/builtin APIs (`api-guard`), un-delegated heavy commands (`command-guard`), un-delegated direct edits (`edit-guard`), spawn-rate/memory fork-bombs (`swarm-guard`), stopping with open tasks (`task-guard`/`tasklist-guard`), cheapest-fitting-model routing (`model-routing-guard`), opt-in `merge-gate`/`ship-it-guard`, and more. |
| **Verify-first discipline** | Injects the full Iron-Law + rationalization-table protocol at session start (survives compaction) and a rotating one-line nudge every turn, plus the always-on scope-fidelity + anti-sycophancy rules; enforced, not just suggested. |
| **Orchestration** | Non-blocking coordinator discipline: delegate heavy/broad work to subagents, verify delegated "done" claims against ground truth, live phase progress on the statusline. |
| **Auto-handover** | On by default: at 85% context the agent writes a handover itself, tells you, and suggests `/compact` or `/clear`; short follow-up reminders after that. Configure via `/anti-hall:settings`. |
| **DevSwarm mesh** | Optional, dormant unless a DevSwarm session is active — layered wake/recovery (self-report → poke → escalate, never auto-kill), one mailbox per session, per-turn mesh status. The DevSwarm app's own database is the ground truth for workspace state; done workspaces are auto-archived (DevSwarm ≥ 2.5.3), old message bodies are archived then pruned. See [`KB-devswarm-hivecontrol.md`](KB-devswarm-hivecontrol.md) and [`KB-devswarm-app-db.md`](KB-devswarm-app-db.md). |
| **Jev classifier** | Optional LLM-backed speculation classifier ([`KB-jev-classifier.md`](KB-jev-classifier.md)) — per-integration on/shadow/off modes, metrics + `jev report` KEEP/REVIEW/REMOVE calls. |
| **Statusline** | Live two-line statusline: git/model/context/cost on line 1, live orchestration/context gauge on line 2. Installable globally or per-repo, consolidates with an existing statusline (e.g. OMC HUD). |
| **doctor / update** | `doctor` runs live behavioral self-tests on every guard and repairs safe drift; `update` pulls the latest release and shows the changelog delta. Repairs also run by themselves after a plugin reload or on a new version. |
| **Settings** | One place for every setting — `~/.anti-hall/settings.json`, grouped by category and reachable through `/anti-hall:settings` (Claude Code's `/config` panel has only the headline switches, the safety guards and the keys); or tell `/anti-hall:settings` "set X to Y". See [Settings](#settings-anti-hallsettings). |

## What's inside and updating

Repo layout, the `AGENTS.md` cross-tool mirror, the `node --test` suite, and the
`/anti-hall:update` flow are documented in this guide ([Codex / cross-tool](#codex--cross-tool),
[Test locally](#test-locally), the `update` skill under [Skills reference](#skills-reference-detailed)).
The full plugin component reference is [plugins/anti-hall/README.md](../plugins/anti-hall/README.md).
Release notes: [CHANGELOG.md](../CHANGELOG.md).

## Hook reference (detailed)

Moved from plugins/anti-hall/README.md "How it works" (v0.107.0 doc sweep).

## How it works

### Verify-first protocol (the core)

- **SessionStart protocol** — by default (`context.protocolLevel=compact`) `verify-first-full.js`
  injects a compact core that keeps every load-bearing clause inline and points at the generated
  `PROTOCOL.md`; `context.protocolLevel=full` injects the FULL
  verify-first + root-cause protocol described next, byte for byte, in the Superpowers **Iron Law +
  rationalization-table** form. It names the specific bypass excuses ("probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run") and includes a skill primer listing the core 4 skills (root-cause, orchestration,
  deadly-loop, ship-it) and when to reach for each. It also carries the always-on
  **output-presentation rule K** ("PRESENT FOR SCANNABILITY"): organize output with
  GitHub-flavored markdown — tables for comparisons/status, **bold** verdicts, `code` for
  flags/paths/commands, fenced blocks for output, emoji as a leading status glyph (signal,
  not decoration), and avoid renderer-dropped syntax. Styling organizes, never pads.
  SessionStart is the primacy slot. Its companion `verify-first-orch.js` (also
  SessionStart) carries the always-on orchestration ruleset (rules A–N + the
  DevSwarm-Primary workspace-tier rule W; by default inline at SessionStart, see `context.orchFullOn`) — split out in 0.60.0 so both halves
  clear the ~10k per-hook injection cap and land 100% inline instead of one
  spilling to a file (Claude Code leaves a 2,000-char preview inline and does not ask Claude to read the rest).
- **Surviving compaction** — SessionStart re-fires after a compaction with
  `source="compact"`. The no-matcher SessionStart registration therefore re-injects
  the protocol across the compaction boundary, exactly when context is largest and
  adherence is worst. This is the sole compaction-survival mechanism. The hook is
  deliberately **not** registered on `PreCompact`: per the official docs, only
  UserPromptSubmit / UserPromptExpansion / SessionStart can inject
  `additionalContext`, so a PreCompact hook would deliver nothing.
- **Per-turn nudge** — `verify-first.js` injects ONE short one-liner per turn
  (one of 17 facets of the Iron Law), so the per-turn slot stays high-salience
  instead of being habituated and tuned out. The facet is chosen deterministically
  by a SHA-1 hash of the **entire UserPromptSubmit stdin envelope** — which carries
  `session_id` / `transcript_path` / `cwd` alongside the prompt. So the nudge is
  reproducible for a given full envelope, and the same prompt text in a different
  session or cwd intentionally rotates to a different facet (extra novelty against
  habituation). Nothing from stdin is echoed back into the injected text.

### git-guard

`git-guard.js` (PreToolUse on Bash) mechanically **blocks** three things:

- Commits whose `-m` / `--message`, or whose `-F` / `--file` message (a `-F -` /
  `--file=-` / `-F /dev/stdin` heredoc, or `-F <path>` naming a real, readable
  file, relative to a preceding `cd`), carries a `Co-Authored-By` / self-credit
  trailer (including the canonical emoji-prefixed `Generated with [Claude Code]`
  footer). Commits take no AI credit. An unreadable `-F` file fails open (not
  scanned) rather than guessing at its contents.
- `git push --force` (and quoted/bundled variants). History rewrites are a
  deliberate human action.
- A push that deletes a remote branch or tag (`--delete`, `-d`, `origin :<ref>`,
  `--prune`, including abbreviated long options). Deleting published refs needs
  explicit owner confirmation; the block names the `skip.json` override.

It uses a **quote-aware tokenizer** that inspects argv positions, so quoted force
flags (`git push "--force"`), bundled `-f`, `+refspec` pushes, and a trailing
`--force` after a `2>&1` redirect are all caught. It also **unwraps** `bash -c` /
`sh -c` / `zsh -c` / `dash -c` / `ksh -c` / `ash -c` shell wrappers and re-inspects
the payload, so `bash -c "git push --force"` and `bash -c '...Co-Authored-By:
Claude...'` cannot smuggle either block past it that way.
**Heredoc bodies that are data** (`guards.gitGuardHeredocData`, default on): a
heredoc whose consumer is not a shell is not scanned as commands, so a note,
commit message or PR body that mentions `git push --force` is not blocked:
`cat <<EOF > notes.md`, `tee notes.txt <<EOF`, `git commit -F - <<EOF`,
`git commit -m "$(cat <<EOF ... EOF)"`, `gh pr create --body-file - <<EOF`. The
rule is all-or-nothing and fails closed: it applies only when every heredoc in
the command ends in a prose/data file (`.md`, `.txt`, `.rst`, `.log`, ...)
through cat/tee or in a git commit/tag/notes/merge or gh pr/issue/release
message; every other command in the line is on a short allowlist (cat, tee,
git, gh, echo, printf, cd, mkdir, wc, head, tail, ls, ...); a git there is
limited to commit/tag/notes/merge, status/log/diff/show/add and rev-parse, each
with its own flag allowlist (no fetch, push, pull, clone, remote, submodule or
config, no `-c`/`--git-dir`; any other flag, an abbreviation like
`--upload-p` included, keeps the bodies scanned), and a gh to pr/issue/release
create/edit/comment with listed flags and no `--` passthrough; no write target is a
script, an extensionless file, a dotfile, a git hook name or a `.git`,
`.husky`, `.githooks`, `hooks`, `.ssh`, `.config`, `.claude`, `.codex` or
`.anti-hall/bin` path; an unquoted-delimiter body has no `$(` or backtick; and
the parse has no open quote, line continuation or process substitution around
the opener. Everything else still scans every body as shell: a heredoc fed to
bash/sh/zsh/eval/source/`.`/xargs/python/node/..., piped into a shell, teed into
`>( )`, or written to a file that the same command line then runs (`bash
f.md`, `. f.md`, `git -c core.pager='sh f.md' log`). Commit and PR credit
trailers and `key = value` git-config lines in a body are checked whatever the
consumer. A script written by a heredoc (`cat > x.sh <<EOF`) is still scanned,
because it may be run later; write it with the Write tool.
`tests/hooks/git-guard-heredoc-bypass.test.js` pins the forms that must stay
blocked, `tests/hooks/git-guard-heredoc-data.test.js` the ones that are data.
It scans commit messages both INLINE (`-m` / `--message` / `--trailer`) and via
`-F -` / `--file=-` / `-F /dev/stdin` fed by a heredoc on the same command
line, or via `-F <path>` naming a real, readable file (a relative path
resolves against a preceding `cd` in the same command). For any git verb that
writes a commit (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`,
`pull`, `commit-tree`) it also scans the WHOLE command text for a self-credit
trailer line, so a pipe into `-F -`, a file written earlier in the same command,
a shell variable, or a `rebase -x` payload is caught; `gh pr merge --body /
--subject` and `gh ... --body-file` are scanned too. A PostToolUse audit
(`git-guard.js --audit`) then reads the commits HEAD gained in the last 15 min
after any commit-creating command and tells the agent to reword one that
carries a trailer added OFF the command line (a repo `commit-msg` /
`prepare-commit-msg` hook, a template, an editor, a cherry-pick). **Documented
fail-open scope:** the audit is advisory (PostToolUse cannot un-run a commit),
a commit made inside a script file is not seen by the command-text scan, and
a shell alias or function defined in your shell profile (not in the command)
is not seen through (see **Aliases** below). `xargs` is covered:
`... | xargs [options] git ...` gets the same git checks as a direct run (any
xargs-run `git push` is blocked, since stdin can append `--force`), with
xargs' GNU and BSD options parsed the way getopt does (`-I {}`, `-I{}`,
`-i`/`-l`/`-e` with attached values only, `-n1`, `-0n1`, `-d '\n'`, `-J %`,
`--max-args 1`), and an xargs-run `sh -c`/`eval`/nested `xargs` is re-scanned
(its `"$@"` is scanned with a `--force` standing in for the stdin words).
`find ... -exec|-execdir|-ok|-okdir CMD ... \;` (or `+`) gets the same checks
for CMD, and a `find -exec git push ... {}` is blocked (a file name can be a
`+ref` force refspec). Wrapper commands are unwrapped with their own option
grammars, directly and under xargs/find: env, command, exec, sudo, doas, nice,
nohup, time, timeout, stdbuf, caffeinate, ionice, flock (`-c`/`--command`
before or after FILE is scanned as `sh -c`), setsid, chrt and taskset. GNU
`parallel` is a runner like xargs: the command before `:::`/`::::` gets the
same checks with the `:::` words appended (a parallel-run `git push` is
blocked), and `parallel ::: 'cmd'` scans each input as a command. When a
replacement string (`xargs -I`/`-i`/`-J`, find's `{}`, parallel's `{}`/`-I`) is
the command word, the git subcommand or an argument before it, the command is
unknown and is blocked if a force or remote-delete flag is visible
(`xargs -I{} git {} --force`). Custom placeholders (`-I{x}`, parallel's
`{1}`/`{.}`/`{/}`/`{#}`) are ordinary words: `{` is a group brace only as
a standalone word (blanks on both sides, so `function f { ...; }` and
`coproc NAME { ...; }` bodies are scanned) and `}` only after `;`, `&` or
a newline. When
xargs or parallel runs `git` with no subcommand word, the subcommand comes
from stdin, so it is blocked if a force or remote-delete token appears
anywhere on the same command line, also after quote removal
(`echo 'push --force o m' | xargs git`, `echo push '-'f o m | xargs git`).
When the script comes from stdin (`xargs -I{} sh -c '{}'`, `| parallel`
with no command, `| sh`, `| bash -s`), the quoted strings and echo/printf
words on the line are scanned as commands. A `sh -c` / `bash -c` script
that forwards its positional args (`sh -c '$0 "$@"' git ...`, `bash -c '"$@"' _
git ...`) is scanned with those args spliced in. These are
documented boundaries, not silent gaps.

**Aliases** (`guards.gitAliasResolve`, safety, default on). `git <name>` where
`<name>` is not a git builtin is resolved through the git config of the repo the
command runs in (one `git config --get-regexp ^alias\.` per repo per call;
builtins never spawn git, since git ignores an alias that shadows one). Alias
chains are followed (a loop resolves to nothing, as git refuses to run it), and
the expansion is scanned as the command it really is: `git <body> <args>`, or the
shell text of a `!` alias. The PostToolUse audit follows aliases too. Defining
an alias whose body is a blocked git command is itself blocked:
`git config alias.x '<body>'`, `git -c alias.x=<body>`,
`GIT_CONFIG_VALUE_<n>=<body>`, and a shell `alias x='<body>'` (shell function
bodies are ordinary command segments and were already scanned). A call to a
shell alias or function defined in the same command is scanned as what it
forwards: `g(){ git "$@"; }; g push --force` expands `"$@"`/`$*`/`$1`… to the
call's arguments, wrappers calling wrappers included (depth-bounded). Not
covered: a shell alias or function defined in your shell profile rather than in
the command (the hook only sees the command text).

**Reused commit messages** (`guards.gitReusedMessageCheck`, safety, default
on). A `git commit` with no `-m`/`-F` takes its message from somewhere the
command line does not show. Before it runs, git-guard reads that message:
`git log -1 --format=%B <rev>` for `-C`/`-c`/`--reuse-message`/`--reedit-message`,
HEAD for `--amend`, the `-t` file or `commit.template`. If it carries an AI
self-credit trailer the commit is blocked when the message would be reused
verbatim (`-C`, `--no-edit`, or a no-op editor such as `GIT_EDITOR=true`), and
also on the editor path when the command sets no real editor of its own. A
command that sets a real editor (`GIT_EDITOR=…`, `core.editor`) is left to the
PostToolUse audit, since that editor may be the cleanup. Why both layers: the
PreToolUse check can only see a message that already exists (a commit, a file);
what an editor or a `commit-msg` hook writes exists only after the commit, so
the audit reads the new HEAD and tells the agent to amend.

### Task discipline

- `task-tracker.js` (UserPromptSubmit) injects the directive every turn: capture
  every request as a task before acting, assign priority (`P0/P1/P2`), keep the list
  sorted highest-priority-first and work in that order, keep statuses current,
  delegate heavy work to background subagents, and report progress. Nothing is
  silently dropped.
- `task-guard.js` (Stop, loop-safe) blocks **once** when the session is about to
  stop with open tasks (`pending` / `in_progress`) still in the list, prompting the
  model to continue, complete, or explicitly defer them. If the exact same open-task
  set was already blocked on (nothing changed), it skips to prevent infinite loops.
  Fail-open on any parse/read/state error.
- `tasklist-guard.js` (Stop) blocks when **non-trivial work** — ≥
  `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default 3) file-mutating actions — happened without
  task tracking (or with more than one task `in_progress`, or without a fresh
  **per-session** progress file at `<cwd>/.anti-hall/progress/<date>/<session-id>.md`
  (`<date>` = UTC `YYYY-MM-DD`, `<session-id>` = the sanitized Claude Code session id) —
  collision-free across concurrent sessions on the same project, replacing the old
  single shared `.anti-hall-progress.md`. Writes that land only under the session's own scratchpad (inter-agent message files, temp scripts that write nowhere else) do not count as work, and a write to the progress file seen in the transcript counts as fresh even before its mtime is visible (v0.107.0). It coexists with `task-guard` (which drains
  declared tasks) and keeps an **independent block cap** (`MAX_BLOCKS=3` cumulative/session)
  so the two never compound. The progress file lives under `.anti-hall/`, which is NOT git-ignored
  automatically in your project: add `.anti-hall/` to your `.gitignore` (or run `doctor --repair`,
  which appends it to the repo-local `.git/info/exclude`; `doctor` warns and a once-a-week
  SessionStart reminder fires while it is not ignored — `guards.gitignoreHint`). The hook never creates the file, and it
  must be updated this session (default 30 min freshness window) to count. A running
  `.anti-hall/progress/INDEX.md` (and the history-side equivalent) is maintained via
  atomic single-line appends only — never a read-modify-rewrite. Fully fail-open.
  See [`TASKLIST-GUARD.md`](./TASKLIST-GUARD.md).

### User-override escape hatch (skip-guard)

The user's explicit instruction outranks any guard. When the user **clearly and directly**
asks the agent to skip a guard, the agent records that consent via the shared `skip-guard.js`
primitive — a TTL'd JSON marker at `~/.anti-hall/skip.json`, e.g.
`{ "tasklist-guard": <unix-ms expiry>, "all": <unix-ms expiry> }`. Every guard checks it at
startup and fail-opens while it is in effect; the marker auto-expires (default 15 min) so a
safety guard is never left silently disabled.

- **Granular:** name a single guard (`"speculation-guard"`, `"tasklist-guard"`, `"limit-conserve"`, …) or use
  `"all"` to cover the noisy guards at once.
- **Safe default:** a broad `"all"` skip does **not** cover the destructive `git-guard`
  (force-push / AI-credit trailer) — to skip that, the agent must name `"git-guard"`
  explicitly.
- **Fail direction is inverted from the hooks:** a missing/corrupt skip file makes
  `isSkipped` return false, so the guard stays **active**. A broken skip file must never
  silently disable protection.

> **Several Stop hooks are registered** (`task-guard`, `speculation-guard`,
> `speculation-judge`, `tasklist-guard`, `codex-nudge`), all emitting the top-level `{"decision":"block","reason":...}`
> Stop schema. When several fire on the same Stop, all block and Claude Code gives the model each
> reason as its own message; the engine's dispatcher answers them as one block that carries every
> reason in registration order. `task-guard` is registered **first** because open-task discipline
> is higher-stakes, so its reason comes first.
> Each is capped (task-guard caps at `MAX_BLOCKS`;
> speculation-guard blocks once per distinct speculative message hash; speculation-judge
> blocks once per distinct message hash; `tasklist-guard` has its own independent block cap
> — `MAX_BLOCKS=3` cumulative per session — so it never compounds with `task-guard`), so the
> others surface on subsequent Stops.
> `speculation-judge` is a no-op unless `jev.semanticJudge` is true or `ANTIHALL_SEMANTIC_JUDGE=1` — it never blocks in
> the default configuration.

### speculation-guard

`speculation-guard.js` (Stop) provides **lexical enforcement** of the no-speculation
Iron Law at the output boundary — after the model has already produced a reply.

**How it works:**

1. Reads `transcript_path` from stdin, parses the JSONL, and extracts the **last
   assistant message** (all text content blocks concatenated).
2. Scans for **speculation markers** (case-insensitive, word-boundary):
   `very plausibly`, `plausibly`, `presumably`, `I suspect`, `my guess`, `I'd guess`,
   `I bet`, `likely`, `probably`, `must be`, `should be` (but not `should I`),
   `seems to be`, `appears to be`, `I think it's`, `my hunch`.
3. Suppresses the block if the **same message** also contains an evidence/uncertainty
   **acknowledgment**: `verified`, `I don't know`, `haven't checked`, `not verified`,
   `unverified`, `let me verify`, `I'll check`, `I will check`, `need to confirm`,
   `to confirm`, a `file.ext:line` citation, `running`, `per the data`, `the data shows`.
   This allows honest hedging ("I haven't checked, but it might be X — let me verify")
   while blocking silent inference-as-fact.
4. **Block-once / loop-safe:** hashes the last message text; stores the blocked hash
   in `~/.anti-hall/speculation-guard-state-<session>.json`. If the same message hash
   was already blocked (nothing changed between Stops), skips the block — the model
   was nudged once and had a chance to respond. Never wedges.
5. **Fail-open:** any parse/read/write error exits 0 without blocking or writing to
   stderr. A bug here never wedges a session.

**Unsupported confident inferences (opt-in).** The hedge-word scan cannot see a
confidently-stated inference that uses no hedge word ("The crash is caused by the cache
race."). Two opt-in components cover it, both off by default because neither reached 0.9
precision when measured:

- `guards.inferenceCheck` (deterministic, free, ~ms): finds causal or attributive sentences
  ("caused by", "the root cause is", "because", "is due to", "stems from", "this means",
  "the culprit is", "that's why", "comes down to", "Root cause: X", "X is what crashes Y",
  "the <symptom> is the ...") and blocks once when nothing in
  the transcript window mentions the stated cause. Evidence is tool results, the inputs of
  observation tools (a command, a path, a search pattern), fenced blocks the user pasted and
  task notifications, across the last 1 MB of the transcript (not only this turn). The
  assistant's own prose and anything it authored (Write/Edit/apply_patch input) never count.
  Skipped: questions, conditionals, modal hedges, first-person rationale ("I used X because
  Y"), plan/next-step lines, quoted or code text, and replies that say the claim is
  unverified. Works on Claude transcripts and Codex rollouts. Not covered: a claim with no
  causal wording ("The cache race crashes the worker."), "since" (too often temporal), and a
  tool call that merely echoes the claim's words (it counts as evidence).
- The semantic judge (Tier 3 below), which now also sees the user's request and the tool
  evidence, and can run on the local `claude` CLI without an API key.

Measured (`node tools/eval/inference-bench.js`, 84 synthetic labelled cases, 42 positive / 42
negative, written before the detector):

| Component | Precision | Recall | Notes |
|---|---|---|---|
| `guards.inferenceCheck` | 1.00 | 0.95 | Synthetic corpus, same for Claude and Codex transcript shapes and end to end through the hook (`--hook`). First untuned run: 0.975 / 0.929. |
| `guards.inferenceCheck`, real replies | ≤ 0.45 (estimate) | not measured | Replay over 3,276 real final replies from local sessions: 3.8% flagged (125). In a random sample of 40 of the 76 unique flagged sentences, at most 18 were causal claims about project state at all; the rest were design rationale ("X because Y"), scheduling notes, test-result reports, hedged lines or general knowledge. |
| Semantic judge, `cli`, Haiku | 0.78–0.81 | 1.00 | Two runs; different false positives each run. The judge demands proof of the causal link that the corpus labels accept. |
| Semantic judge, `cli`, Sonnet | 0.81 | 1.00 | One run; several of its "false positives" are defensible (the claim goes beyond the evidence). |

The corpus is synthetic and written by the same author as the detector, so treat the
synthetic numbers as a regression floor, not a field estimate.

### Three tiers of anti-speculation enforcement

| Tier | Component | On by default | Mechanism | Cost / latency |
|---|---|---|---|---|
| 1 | `verify-first-full.js` + `verify-first-orch.js` + `verify-first.js` | Always-on | Protocol injection (SessionStart + per-turn nudge): names every rationalization bypass including confident inference-as-fact and hedge-word speculation. | Zero (no API call; text injection only). |
| 2 | `speculation-guard.js` | On by default | Lexical Stop hook: scans for 15 hedge-word markers, suppresses when acknowledgment present. Catches hedged speculation. Cannot catch confident inference-as-fact with no hedge word. | Zero (pure Node, no API call). |
| 2b | `speculation-guard.js` with `guards.inferenceCheck` | OPT-IN (off by default) | Deterministic: a causal claim whose stated cause no tool evidence in the transcript window mentions. | Zero (pure Node, no API call). |
| 3 | `speculation-judge.js` | OPT-IN (off by default) | Semantic Stop hook: an LLM judge, given the reply, the user's request and the session's tool evidence, decides whether the reply asserts an unverified fact with no hedge word and no acknowledgment. Catches the gap Tier 2 misses. | `api` backend: ~$0.0001-0.001 per turn + ~1-3 s (estimate), needs `anthropic_api_key`. `cli` backend: no key, your Claude login's usage, ~5-6 s (measured). |

### speculation-judge (Tier 3, OPT-IN)

`speculation-judge.js` is registered in `hooks.json` but **exits 0 immediately** unless it is
enabled: off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1`
(the env var wins when set to an on/off value). When off, it has zero cost, zero latency, and
zero network activity — it is as if it were not registered at all.

**Quick switch:** `node scripts/settings.js judge on|off|status` (or ask `/anti-hall:settings`) sets `jev.semanticJudge`, reports whether a key is visible to that process (never the key), and prints the cost (api backend: about $0.0001–0.001 and 1–3 s per turn end, estimated; cli backend: no API bill, about 5–6 s, measured) and the measured precision (0.78–0.81, recall 1.0, on `tools/eval/inference-bench.js`). It also names the active backend: when `jev.enabled` is on and the `speculation` integration is `on`, speculation-guard already asks Jev (a remote classifier, not a local one) and this API judge exits early. `doctor` prints an info line with the backend, or this command while the judge is off.

**To enable:** either set `jev.semanticJudge` to `true` (`/anti-hall:settings`), or:

```bash
# Add to ~/.zshrc / ~/.bashrc / ~/.profile, then restart Claude Code:
export ANTIHALL_SEMANTIC_JUDGE=1
```

Then store the key in the plugin's options screen (anti-hall -> `anthropic_api_key`, kept in the OS
credential store; the judge is fail-open if it is absent), **or** use your own Claude login
instead of a key: `node scripts/settings.js set jev.judgeBackend cli` (`auto` = the key when one
is visible, else the CLI). The `cli` backend runs `claude -p` with no tools, no MCP servers, no
settings files and every hook disabled (`--settings '{"disableAllHooks":true}'`), so the judge call
cannot run anti-hall's hooks or recurse; it also sets `ANTIHALL_JUDGE_CHILD=1`, which makes the
judge exit at once if it ever runs inside that child. Measured about 5–6 s per turn end
(claude 2.1.288, Haiku). If `claude` is not on the hook's `PATH`, or is not logged in, the judge
does nothing. anti-hall no longer reads
`ANTHROPIC_API_KEY` from your environment unless you enable `guards.allowAnthropicEnvKey` in
`~/.anti-hall/settings.json` (the Codex port, which has no plugin options, needs that setting).

**To disable:** set `jev.semanticJudge` to `false` and unset `ANTIHALL_SEMANTIC_JUDGE` (an explicit `ANTIHALL_SEMANTIC_JUDGE=0` overrides a `true` setting).

**What it catches:** confidently-stated inference-as-fact with no hedge word — e.g.,
"The cause is the old build artifact." with no tool verification and no uncertainty
acknowledgment. The judge sees the latest user request and up to ~6 KB of the newest tool
evidence from the transcript (secret-scrubbed), so a claim the session's tool output shows is
allowed. The judge prompt instructs the model to ALLOW honest hedging, quoted
text, hypotheticals, plans, and general software knowledge; it only blocks definitive
unverified factual claims.

**Fail-open:** any error (absent `anthropic_api_key`, API unavailable, timeout, bad
JSON response) exits 0 without blocking. A failure here never wedges a session.

**Where a stored key is visible.** A key stored through the plugin options (`jev_vercel_api_key`,
`jev_typesafe_api_key`, legacy `jev_api_key`, `anthropic_api_key`) reaches **hook processes and the workers they spawn** only; Claude
Code does not hand it to the Bash tool, the statusline, monitors or the companion daemons.
So `jev-setup test`/`status`, `jev-report` (credit balance) and `finding-dedup` print a
one-line "no Jev key visible to this process" reason when run from a shell. To make a key
available to those background tools (and to Codex), save it with `jev-setup set-key` and
enable `jev.allowLegacyKeyRead` in `~/.anti-hall/settings.json` (a safety setting: it takes
`--confirmed`, and env or project settings cannot flip it).

**Loop-safe:** hashes the last message text (with a `":judge"` suffix to keep the
namespace separate from `speculation-guard`'s hashes). If the same message hash was
already blocked, skips — the model was nudged once and had a chance to respond.

**Misfire caveat:** LLM judges are not perfect. The conservative judge prompt reduces
false positives, but some misfires will occur — particularly on messages that describe
what code does based on reading it (which IS verified by inspection). If misfires are
frequent in your workflow, turn the semantic judge off (`jev.semanticJudge` false, `ANTIHALL_SEMANTIC_JUDGE` unset) and rely on Tiers 1 + 2.

**Cost and latency detail:** one model call per Stop event when enabled, to `jev.judgeModel`
(default the `haiku` alias, which resolves to the latest Haiku; env-overridable via `ANTIHALL_JUDGE_MODEL`).
With `jev.judgeBackend` `cli` the engine can make this call itself (`engine/defaults/judge.toml`) in a one-shot
`ah-engine check speculation-judge`, leaving a row (backend, model, latency, error) in
`~/.anti-hall/logs/judge-calls.ndjson`; the resident daemon cannot wait seconds for a model, so there it leaves the call to
the Node hook.
At current Haiku pricing this is roughly $0.0001-0.001 per turn; latency is roughly
1-3 s added to each Stop (an estimate: the API backend has not been timed or
evaluated). The keyless `cli` backend is measured: precision 0.78-0.81, recall 1.0 on
`tools/eval/inference-bench.js`, about 5-6 s per Stop. For projects where confident inference-as-fact is the primary
failure mode and the cost/latency is acceptable, Tier 3 closes the gap Tier 2 leaves open.

### Jev classifier (opt-in, backs Tier 2)

`speculation-guard.js` can optionally ask **Jev** (TypeSafe's "System One" model — a
typed yes/no classifier, not a reasoning model) first. **Default OFF.** Enable with
`~/.anti-hall/jev.json`:

```json
{ "enabled": true, "transport": "vercel", "confidenceThreshold": 0.85 }
```

Text sent to the gateway (prompt, last assistant message, commit/PR text, test output) is passed through a best-effort redactor first: text matching known token shapes (API keys, Bearer tokens, `password=` style assignments, PEM blocks, JWTs, URL credentials, emails, long token-like runs) is replaced with `[REDACTED...]` placeholders. Redaction is best-effort, not a guarantee.

or `ANTIHALL_JEV=1` (env). `ANTIHALL_JEV=0` always force-disables. Only a confident
"speculative" answer blocks on Jev's word alone; a "grounded" answer, low confidence, or
any Jev failure (no key, timeout, HTTP error, bad response) falls back to the regex check
unchanged. Disabled (the default), the guard behaves exactly as the regex-only hook.
Details: **[docs/KB-jev-classifier.md](./KB-jev-classifier.md)**.

Two more integrations share the same opt-in switch via `hooks/lib/jev-assist.js`, each
with its own on/shadow/off mode and trust rule: `speculation-judge.js` skips its paid
Haiku call when `speculation` is fully trusted (`"on"`, not `"shadow"`), and
`model-routing-guard.js` (default mode **shadow**) can let a confident non-mechanical
classification downgrade a mechanical-flagship block to an advisory. Run
`node plugins/anti-hall/scripts/jev-report.js` for a per-integration KEEP/REVIEW/REMOVE
read on whether any of this is worth trusting. Details: **[docs/KB-jev-classifier.md §10](./KB-jev-classifier.md)**.

## Skills reference (detailed)

Moved from plugins/anti-hall/README.md "Skills" (v0.107.0 doc sweep).

**Always-on vs conditional.** The **root-cause** and **orchestration** disciplines are
**enforced always-on via the hook layer** — their core fires every session/turn through
`verify-first-full.js` + `verify-first-orch.js` (SessionStart) and `verify-first.js`
(per-turn nudge), so they apply without being invoked. The full step-by-step playbooks below are still available as
slash commands for when you want the deep version. **deadly-loop** and **ship-it**
are **conditional skills invoked on match** — they are not forced every turn. The
always-on orchestration injection enforces a **bias toward delegation** — default to a
subagent for any work that touches files/tools/commands/search/build/test or could
balloon (to avoid the eager "I'll just do it inline" trap that pollutes the main thread),
handling inline only genuinely atomic things (a direct answer, a single known-line read,
the coordinator's own synthesis/decisions), and delegating immediately if a quick inline
task balloons; parallel agents when independent; commands via Haiku off-thread. It now
also **defaults delegated heavy/parallel work to the background** — the coordinator passes
`run_in_background` itself so the user needn't background it manually, while still
verifying each on completion (never fire-and-forget). It also
enforces **verify delegated work** — a subagent's "done/passing" is an unverified claim
re-checked against ground truth (re-run the authoritative check, or use a separate
verifier, reconciling multiple workers against ground truth) before marking complete —
**capture-every-request** task discipline (priority-sorted),
**anti-sycophancy** (challenge a wrong premise with evidence; user agreement is not
correctness), and **scope & fidelity** (solve the actual problem with the simplest
sufficient solution; intent over letter; confirm before expanding scope; match rigor to
blast radius; finish what was asked and drop nothing).

Invoke via slash command:

- **`/anti-hall:root-cause`** — evidence-driven debugging: reproduce, collect
  evidence, instrument when missing, trace the sequence to the original + root cause
  (not the surface symptom), prove the hypothesis, fix at the root, verify.
- **`/anti-hall:orchestration`** — swarm with a non-blocking main thread: delegate
  heavy/long work to background + parallel subagents, partition to avoid conflicts,
  distribute load across Claude **and** Codex when available, run commands via Haiku
  so raw output never pollutes the coordinator's context.
- **`/anti-hall:ship-it`** — one lean workflow for shipping any change, scaled S/M/L
  to blast radius: brainstorm + plan in plan mode (ExitPlanMode is the approval gate;
  blends superpowers planning ideas — standalone, no external dependency), enumerate edge cases, harden
  the plan with the deadly-loop BEFORE any code, fan large work out as a Workflow swarm,
  and verify each phase with fresh evidence + a vacuous-test guard, running the
  deadly-loop after each phase until zero NEW P0/P1s. **L tier** adds a resumable
  `.anti-hall/ship-it/<slug>/STATE.json` (plan hash + per-phase status + an escalation
  counter capped at 2 build→re-plan loops), logs accepted P2 findings to
  `decisions.md`, routes build seats Codex-primary with Sonnet failover (a
  cross-model guard skips the Sonnet Reviewer when a phase's build fell back to
  Sonnet, to avoid same-model self-review), and closes out with a session-history
  entry + `SUMMARY.md`. **v0.67.0:** the per-phase
  gate previously ignored dead review seats entirely, so fewer live seats produced
  fewer findings and a silently PASSING `converged: true` — missing review coverage
  is no longer indistinguishable from a clean pass. The gate result now carries
  `totalSeats`/`liveSeats`/`deadSeats`/`degraded`/`seatReports`, and `converged`
  requires `deadSeats === 0` — a phase that loses a seat now correctly fails to
  converge where it previously passed silently. Also honors `args.codexAvailable`
  (mirroring deadly-loop, including the Opus adversarial-persona fallback).
- **`/anti-hall:deadly-loop`** — iterative parallel Reviewer + Critic debate +
  fix-waves until convergence (zero NEW P0/P1s). The debate engine behind
  ship-it's gates. On convergence, writes an ADVISORY
  `~/.anti-hall/approvals/<repo>@<HEAD-sha>.json` record (`"proof": false` —
  not authorization; a real gate must still enforce its own check).
- **`/anti-hall:deadly-loop-multi`** — scaled-up deadly-loop: N Reviewer + N Critic
  pairs with diversified lenses, then dedup + synthesize (double / triple / quadruple).
- **`/anti-hall:install-statusline`** — writes the statusLine setting (global by
  default, per-project on request) and reminds you to restart. `--consolidate` merges
  with an existing statusline (e.g., OMC HUD) instead of replacing it; base persisted
  to `~/.anti-hall/consolidated-base.json`. Env: `ANTIHALL_STATUSLINE_BASE` pins the
  base expression explicitly.
- **`/anti-hall:doctor`** — health-check: confirms Node is found, every hook is
  present + syntax-valid, and the guards actually fire (live behavioral self-tests on
  e.g. git-guard / command-guard / swarm-guard / speculation-guard / tasklist-guard).
  Also **env-aware**: detects and tests each optional integration only when it's
  actually present — OMC (plugin-enabled + live-loop check), Codex/OMX (config/skills
  detection), and the DevSwarm liveness supervisor (supervisor-companion-installed
  state plus a per-workspace liveness self-test; `nudged` reads as WARN, not FAIL) —
  silent and skipped for any integration that isn't in play. **v0.61.0:** repair mode
  also auto-safe-folds every prior DevSwarm mesh-store shape (phantom/dual/subdir-split/
  stale) onto one canonical worktree via `foldMeshDuplicates`; the dry-run detect pass
  doubles as a read-only mesh-shape check under `--check`. **v0.65.0:** the heartbeat now
  carries the monitor outcome, so an ingest daemon that is alive but failing every cycle
  (e.g. a permanent ENOENT/EACCES/ENOTDIR config fault) is reported as a FAILURE rather
  than healthy, with a one-line in-session banner; a heartbeat missing these fields
  (pre-upgrade daemon) reads as unknown, never a fault. New explicit, opt-in
  `--reclaim-ingest-lock` sweeps orphaned locks and reclaims a contended one (positive OS
  confirmation required before any removal), then reinstalls — never runs automatically.
  Install-time also detects a memory-guard/reaper script that would kill the
  service-managed daemon and reports the exact allowlist entry to add. **v0.104.0:**
  `--check`/repair mode also runs a read-only `identity-rekey-candidates` report,
  listing stores written under a pre-0.104.0 wrong project key with their message
  counts; nothing is moved automatically.
- **`/anti-hall:update`** — updates anti-hall in place: `git pull --ff-only` the
  marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof),
  prints the changelog delta between installed and latest, then instructs
  `/reload-plugins` for in-session reload (field-verified 2026-10-01, also after a
  harness registry change; restart Claude Code only if a hook or skill path still
  shows the old version, or to re-run SessionStart-only injections). Hooks and statusline pick up from disk
  immediately; `/reload-plugins` refreshes the skill list and version label. `--check`
  mode answers "is anti-hall up to date?" without pulling or writing. After a pull, also
  runs `scripts/migrate-state.js` once per repo (idempotent) to fold legacy root
  `.anti-hall-progress.md` / `.anti-hall-history.md` into `.anti-hall/history/legacy/`,
  runs the same `foldMeshDuplicates` DevSwarm mesh-store migration doctor's repair uses
  (v0.61.0), then a **dynamic capability scan** (`scripts/capability-scan.js`, read-only)
  reports each opt-in capability shipped in this build (companions discovered from
  `companion/install-*.js`, statusline, pending state migrations) as available-vs-active
  on this machine, with the exact command to enable any gap — never auto-installs.
- **`/anti-hall:devswarm`** — explains anti-hall's optional DevSwarm integration: the
  `hivecontrol` reference KB, the designed-but-unbuilt workspace-tier orchestration, the
  shipped **layered recovery model** (child self-report → supervisor poke → escalate —
  the automatic path never kills), and the **on-demand `devswarm-recover` CLI** (the
  only path that ever kills), including the full activation checklist and tunable env
  vars. **v0.61.0:** also covers the mesh **self-heal** set — drain-aware routing +
  phantom-only rescue, the `orphans[]`/`staleRegistryPartitions[]` health projection,
  the `diagnose`/`healthcheck` read-only verbs, and `foldMeshDuplicates` migration.
- **`/anti-hall:handover`** — writes a comprehensive, organized, minimal-but-lossless
  session handover under `.anti-hall/handovers/`: a global index plus a per-session
  `HANDOVER.md` (front-loaded, fixed SBAR-derived schema, ≤200 lines) and detail files
  (`state.md`/`decisions.md`/`trials.md`/`knowledge.md`), sequence-chained to prior
  handovers, so a fresh session can resume without re-deriving or guessing anything.
  Paired with the `handover-resume.js` SessionStart hook, which surfaces the latest
  handover automatically after `/clear` or compaction. Codex mirror:
  `codex/skills/anti-hall-handover`.
- **`/anti-hall:defects`** — **new in 0.80.0.** File, list, show, and read rulings on
  anti-hall's own defect reports via the durable, home-scoped, two-way channel that
  shipped in v0.78.0 (`hooks/lib/defect-store.js`) but had no discoverable entry point
  until now — the `defect-nudge` hook's runtime pointer led to a skill that did not
  exist, on both ports, and the channel was documented only in files an agent doesn't
  load. Five verbs (`report`/`list`/`show`/`rule`/`archive`); `report` accepts
  `--sym-file`/`--repro-file` so a body with backticks, `$(...)`, or embedded newlines
  never needs shell escaping; a report matching a defect already ruled `fixed` derives
  `regressed` (build at or past `--fixed-in`) or `staleBuild` (older build) from the
  reporter's own installed version — no new storage. `list --mine` identity now
  prefers an explicit `--proj` flag, then `ANTIHALL_DEFECT_PROJ`, then the project's
  git repo key (was cwd basename only, which silently broke `--mine` for reports filed
  from a scratch directory). The `devswarm` skill now points here too, since that's
  the skill a DevSwarm session actually loads. Codex mirror:
  `codex/skills/anti-hall-defects`.
  **Bug history** (`hooks/lib/defect-history.js`): `defect.js backfill --repo <path>
  [--dry-run]` imports every `fix:` commit from git history once (keyed by sha, so a
  re-run adds nothing, stored in `defects/history/`, never in `list --open`).
  `defect.js recurring [--since <version|date>] [--top N]` groups reported and imported
  fixes by component and cause and flags hotspots (a component fixed 3+ times, or the
  same component and cause 2+ times) and likely regressions (the same component and cause
  fixed again within 5 releases, or an explicit `--regression-of`).
  `defect.js similar <text…> [--component X]` shows the 10 closest past fixes. The
  `root-cause` skill runs `similar` before an anti-hall fix. Reports and rulings also
  accept the optional `--component`, `--cause` and `--regression-of` fields.

`MODEL-POLICY.md` is the shared TRIO roster (Reviewer = Sonnet `model:"sonnet"` effort `xhigh`;
Auditor = latest Opus `model:"opus"` divergent regression/coupling lens effort `high`;
Critic = Codex latest `xhigh` reasoning when available, else a divergent Opus adversarial persona). It is
**duplicated** — see [Contributing](#contributing).

## DevSwarm (current state)

**Optional and dormant** unless a DevSwarm session is active (`DEVSWARM_REPO_ID`) or one of
its opt-in companions (ingest daemon, liveness supervisor) is installed; nothing else in
anti-hall depends on it.

- **Mesh only.** The Primary and its children talk through anti-hall's per-project store
  via `scripts/devswarm.js` (`send`, `inbox`, `roster`, `mesh read`, `heartbeat`); native
  `hivecontrol` messaging and `SendMessage` to a workspace are blocked. A child sends as
  its workspace id; only the Primary checkout sends as `primary-<hash>`.
- **Primary seat.** One Primary per project; a new session adopts the seat when the holder
  closed, a live conflict is refused until `devswarm.js primary takeover` (checked on every
  cursor write, under the id lock).
- **Per-turn visibility.** The parent-inbox table (app titles, sidebar order, finish/PR
  state, unread, `stale anti-hall <v>`) and nags (120 s grace for fresh unread, none for
  the workspace on screen); Stop gates on unread/unanswered questions for Primary and child.
- **Recovery never auto-kills.** Child self-report → supervisor poke → escalate to the
  Primary; only `devswarm-recover.js <id>` kills.
- **The app database is ground truth** (read-only, capability-gated): archived/deleted
  markers, titles, pins, PRs, session map; screenshot sync (`sync-ui`) only as a fallback.
- **Lifecycle.** Auto-archive of proven-done workspaces (default on, DevSwarm ≥ 2.5.3,
  always by explicit id). "Done" means every finish gate is set, or the child sent its
  structured done-report at its current HEAD and its merge is proven: HEAD contained in the
  remote default branch (`gitMergeProof`, the same check `gate --set merged` records), else,
  only when git can't decide, a `merged` gate verified at the current HEAD or the app's
  merged PR row (with no resolvable `origin/HEAD`, only the verified gate:
  `default-branch-unknown` blocks); a squash merge needs a manual archive; chat text never counts. A child reports done by running `devswarm.js done [--summary "..."]` once
  its work is merged (its SessionStart directive tells it to): that sets its `done` gate and
  sends the Primary one `[[ANTIHALL_DONE]]` message, and the roster shows it
  `done`/`archive-pending`, so nobody archives finished workspaces by hand. The Primary is
  recognised by the app DB's `builderType`, never by a `primary-<hash>` descriptor id.
  The undo is unarchiving it in the DevSwarm app, and it sticks: the sweep logs the HEAD it
  archived at and never auto-archives that workspace again at the same HEAD; only a new
  `done` at a new HEAD makes it eligible again.
  Deleting archived ones only via owner-approved `prune-archived`.
- **Store hygiene.** Message retention (archive then prune old bodies), housekeeping sweeps,
  supervisor log rotation; every setting is in the `devswarm` section of `/anti-hall:settings`.
- **Capability gate.** Every `hivecontrol` verb / app-DB column is gated by version +
  detection, default-deny for unregistered invocations; doctor names what is dormant.

Reference: [`KB-devswarm-hivecontrol.md`](./KB-devswarm-hivecontrol.md),
[`KB-devswarm-app-db.md`](./KB-devswarm-app-db.md), the `devswarm` skill. How it got here
(v0.54–v0.107, dated): [`archive/devswarm-layered-recovery-history.md`](./archive/devswarm-layered-recovery-history.md).

## Contributing / testing (plugin)

Moved from plugins/anti-hall/README.md "Contributing" (v0.107.0 doc sweep).

## Contributing

- **Keep the 2 MODEL-POLICY.md copies in sync.** The TRIO roster file is duplicated
  (`skills/MODEL-POLICY.md` plus a copy under `skills/deadly-loop/references/`) because
  skill bundling requires the skill to carry its own `references/` copy and symlinks are
  stripped on install. Update **both** together — they must stay byte-identical.
- **Bump the version on any behavioral change.** `plugin.json` `version` is the sole
  authority (the marketplace entry carries no `version`); without a bump, installed
  users do not receive the update. Add a `CHANGELOG.md` entry.
- **Keep hooks pure Node (built-ins only)** and fail-open, so they run unchanged on
  macOS and Linux (CI-tested) and never wedge a turn. Windows is not
  supported (v0.69.0 dropped it from the CI matrix); avoid POSIX-only calls
  regardless, since pure-Node code may still work there.

### Recommended optional: oh-my-claudecode (OMC)

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) is a **recommended
optional** dependency. anti-hall installs and runs fully standalone without it. Two
features gain automatic behavior when OMC is installed:

- **`limit-conserve` auto mode** — `limit-conserve-inject.js` reads the OMC usage
  cache (`~/.anti-hall/omc-usage-cache.json`) to detect the live context percentage.
  Without OMC, the hook operates in manual `on`/`off` mode only. **Account-aware:** if
  the logged-in Claude account changes and the usage cache hasn't refreshed under the
  new account yet, conservation mode deactivates rather than apply a stale reading
  across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`.
- **Consolidated statusline** — `install-statusline --consolidate` merges the anti-hall
  bar with the OMC HUD. The version chip in consolidated mode reads OMC session state.

Without OMC, both features fall back gracefully (limit-conserve manual only; consolidated
mode still works but requires `ANTIHALL_STATUSLINE_BASE` to specify the base). No errors,
no breaking change.

### Opt-in companion: mcp-reaper (macOS + Linux)

`companion/mcp-reaper.js` is an **opt-in interval companion** (not a hook) that kills
**orphaned** MCP-server processes — ones leaked when their spawner (a Claude / codex /
npm / node session) exited without cleaning them up. Install with
`node companion/install-reaper.js` (macOS → 60 s LaunchAgent; Linux → `systemd --user`
timer, cron fallback); remove with `--uninstall`. **Safety invariant:** a process is
reaped only if its command matches a generic MCP signature **and** its parent is a
reaper/init (launchd / init / `systemd --user`) — because Unix reparents a dead process's
children, a *live* MCP always has a live spawner as parent, so killing an in-use server is
impossible by construction. Recognizes Python MCPs too (`uvx`/`uv` + underscore
`mcp_server_*` forms). **Limitation:** an MCP run as a LaunchAgent / `systemd --user`
unit / OS service shares init as a parent (like a leaked orphan) and can be reaped —
exclude it via `ANTIHALL_REAPER_EXCLUDE='name|name'`. Env knobs: `MCP_REAP_DRYRUN=1`,
`MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`.
**Windows is not supported.** See [`plugins/anti-hall/companion/README.md`](../plugins/anti-hall/companion/README.md).

### Meeseeks supervision — step plans, straying warnings, token burn (v0.117.0)

A child workspace is supervised against the brief it was given, not only for liveness. Every piece is additive: a workspace with no plan renders and behaves exactly as before.

- **Step plan.** `spawn -p` turns a numbered list in the brief ("1. … 2. …") into `~/.anti-hall/devswarm/plans/<key>.json`; a `Scope: glob, glob` line becomes the plan's file scope. A brief without a list is never refused. `plan set <id> --steps "1. …\n2. …" [--scope glob,glob]` writes one later; `plan show <id>` prints it. The child reports progress with `heartbeat <id> --step N --status doing|done|blocked`. The workspace table and roster show `3/7 done · doing #4 · 42m · progress 18m ago · 1.8M tok`. The headline is the COUNT of done steps (several in flight show as `3 doing`; never a last-touched step index, which jumps for a parallel child); a re-opened step or replaced plan shows the true lower count with `(plan changed)`. Settings: `devswarm.planTracking` (on), `devswarm.planRequired` (off: ask children without a plan to write one).
- **Straying signals** (supervisor sweep, plan rows only, advisory, never a kill): `stall` — busy with no step progress for `devswarm.stepStallMin` (30) minutes; `off-scope` — `ready-check --allow <scope ∪ extras>` finds committed files outside the plan's scope; `idle` — the liveness verdict is stale/nudged/escalated; `burn` — more than `devswarm.burnTokensWarn` (2M) weighted tokens since the step last moved (input + output + cache writes + `devswarm.burnCacheReadPct`% of cache reads, 10% by default, read incrementally from the child's own session transcript). Each episode warns once; new episodes on the same step repeat up to `devswarm.strayWarnMax` (2; 0 = off).
- **What the Primary sees.** One capped advisory `DEVSWARM STRAYING: <title>: step N <reason> (Jev: <verdict> <confidence>)` line on its Stop (shown once per warning per session, stable alert kind `devswarm-straying`, never a block), `STRAYING: <signals>` and `+N extras` on the table's finish cell, and `plan.straying` / `plan.tokens` / `plan.extras` on the roster row.
- **Correction.** `correct <id> [--dry-run]` (Primary, seat-gated) sends "step N '<text>': <reasons>. Return to step N or reply BLOCKED <why>" as a mesh direct and records `warned_at` (the stall clock restarts from it) only after the send succeeds. Never automatic.
- **Respawn (Primary-run, never automatic).** `respawn <id> [--dry-run]` refuses unless the caller holds the Primary seat, the plan has `warned_at` (a `correct` was sent) and `devswarm.respawnGraceMin` (20) minutes have passed since it. Then: (a) it asks the child to commit and push its WIP and waits up to `devswarm.respawnWipWaitSec` (120 s); (b) anything still dirty or unpushed is committed through a private index onto a new `park/<branch>-<ts>` branch and pushed — the child's worktree, index and branch are untouched, nothing is stashed or discarded, and a failed park or push aborts the respawn; (c) it writes `plans/<id>.handover.md` (steps done, remaining steps, last summary, scope, extras, park branch); (d) it spawns `<branch>-r<N>` with `-s <default branch>` (never `-s <old branch>`, which would make the old branch the merge target), step 1 merging the old or park branch, then the remaining steps, carrying scope and extras; (e) it archives the old id and asks the owner to close its app tab. `--dry-run` prints the plan and changes nothing. Respawn never kills; `devswarm-recover.js` stays the only kill path. Plan-file writes (child verbs, `correct`, `respawn`, the sweep) are serialized under one lock, so no step update is lost.
- **Extra work the user asked for.** The child records it with `scope add <id> --glob '<paths>' --note '<what the user asked>'` (idempotent; the child-turn hook tells a planned child to do this). Tagged globs stop counting as off-scope; the Primary sees the note and can challenge it.
- **Jev recommendations** (`jevIntegrations.devswarmOnBrief`, `devswarmExtraSanctioned`, `devswarmWaitKind`, `devswarmLoop`, `devswarmStepMap`; default `on` = recommendation, `shadow` = logged only, `off`): asked detached from the sweep only when a deterministic precondition fires, answer read from the cache on the next sweep. The verdict and confidence ride on the warning as a recommendation; Jev never suppresses a warning, never blocks, never kills. The Primary makes the final call.
- **Effectiveness.** `~/.anti-hall/logs/devswarm-supervision.ndjson` (bounded, 1 MB × 5, daily rollups in `devswarm-supervision-daily/`): warnings by signal, repeats, corrections followed by step progress within `stepStallMin`, extras tagged, time-to-done and steps done vs planned, tokens per workspace and per step, burn warnings and their corrected rate, per Jev integration its agreement with the deterministic signal plus how often the Primary followed or overrode it, and respawns (WIP parked or not, aborted, time to first step progress in the new workspace, finished). `supervision-report [--days N] [--json]` prints it; `doctor` adds a one-line 7-day summary.

### Opt-in companion: DevSwarm layered recovery (macOS + Linux; Windows is not supported)

`companion/devswarm-supervisor.js` is a second **opt-in interval companion** (not a
hook) — a workaround for claude-code#39755, where a `claude` session can silently wedge
(process alive, listener dead) with no upstream headless recovery. It is **OPTIONAL**,
exactly like the OMC/OMX integration: dormant with zero effect unless DevSwarm is
actually in use, gated by `hooks/lib/devswarm-detect.js` (modeled on `omc-detect.js`)
and the presence of published workspace descriptors under
`~/.anti-hall/devswarm/workspaces/*.json`.

**The seam:** anti-hall ships only the generic supervisor. A DevSwarm-aware consumer
publishes the workspace descriptor (`id`, `worktreePath`, `sessionId`, `inboxPath`,
`cursorPath`, optional `nudgeCommand`/`escalateCommand`); anti-hall never assumes
DevSwarm's internals beyond that JSON shape.

**Three escalating layers, and the automatic path never kills:**
1. **Child self-report** — `hooks/devswarm-child-role.js` (SessionStart, child-workspace
   only) reminds an idle child to proactively message its parent via `hivecontrol
   workspace message-parent`.
2. **Supervisor poke** — each sweep computes liveness from **outbound** activity only
   (the session's own transcript mtime + git/worktree commit activity — both must be
   idle, plus a pending unread backlog, before a workspace is nominated `stale`); on
   `stale`, it fires the descriptor's optional `nudgeCommand` and persists verdict
   `nudged`.
3. **Escalate-to-parent** — once the poke budget (`ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS`)
   is exhausted, it persists a terminal `escalated` verdict and fires the optional
   `escalateCommand`. Nothing above ever resolves a pid or sends a signal.

Install with `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove,
`--dry-run` to preview). macOS → LaunchAgent; Linux → `systemd --user` timer (cron
fallback); default sweep interval 90 s (`ANTIHALL_DEVSWARM_INTERVAL`, clamped 60-120).
Env knobs: `ANTIHALL_DEVSWARM_SUPERVISOR` (`off`/`on`/`auto`, default `auto`),
`DISABLE_ANTIHALL_DEVSWARM=1` (hard kill-switch). Sweep thresholds are also env-tunable
(all seconds; invalid/absent falls back to the default, clamped):
`ANTIHALL_DEVSWARM_IDLE_SEC` (default `900`, min 60), `ANTIHALL_DEVSWARM_COOLDOWN_SEC`
(default `600`, min 0), `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` (default `2`, clamped
1–20), `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` (default `180`, min 1),
`ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` (default `120`, min 0). `doctor.js` runs a
matching per-workspace check that stays silent unless DevSwarm is active; a `nudged`
verdict reads as WARN (no more stuck-timer/FAIL check — the automatic path never kills,
so there's no kill-then-resume window to watch for being "stuck"). **v0.66.0:** doctor no
longer reaps a unit as "confirmed running and healthy" from a weaker second health check
that omitted the pid guard and the monitor-fault check — there is now one `daemonHealth`
definition, used by every consumer including this reaper.

**Message retention (v0.108.0).** Each supervisor sweep also runs message retention on
one store, so the DevSwarm stores stop growing without limit. Retention archives old
message bodies to `~/.anti-hall/devswarm/archive/<store>/<yyyy-mm>.ndjson.gz` and then
clears them. Rows, read positions and hashes stay, so no unread count changes.

- Only bodies that every reader has already read are pruned.
- The newest 200 rows of each partition, open questions, and each workspace's latest
  heartbeat are never pruned.
- A store over 100 MB is pruned oldest first until it is under the limit. If the rest is
  unread, `doctor` WARNs instead.
- On a new machine, the first run is a dry-run report (`retention-dry-run.json`).
- Settings: `devswarm.retention.days` (30, 0 = off), `maxStoreMB` (100),
  `keepPerPartition` (200), `archive` (true) and `archiveMaxMB` (0 = never evict; `doctor`
  warns past 500 MB). Pruning is automatic after the first-run dry-run report. Set them in
  `~/.anti-hall/settings.json` or with the `ANTIHALL_DEVSWARM_RETENTION_*` env vars.
- Commands: `devswarm.js retention status | run [--dry-run] [--store X] | restore --store X
  --month yyyy-mm`.

Full rules: [KB §8.7, Message retention](KB-devswarm-hivecontrol.md#message-retention--bounded-store-growth-v01080).

**On-demand kill: `companion/devswarm-recover.js <workspace-id>`** — the ONLY path in
DevSwarm that ever kills a process, invoked explicitly per workspace (e.g. on an
`escalated` verdict). Precise targeted kill: identity-bound (worktree + session uuid),
abstains on any ambiguity (0 or >1 candidates), re-confirms identity on fresh data
immediately before each signal (a pid recycled mid-grace is never SIGKILLed), signals
the process **group** (not just the pid) so orphaned MCP children are cleaned up too,
and — unlike the automatic path — targets an **interactive** `claude` session too, not
just headless (naming the id on the command line is the deliberate override). Capped at
`ANTIHALL_DEVSWARM_MAX_RECOVERIES` (default `3`, clamped 1–20) auto-recoveries before
escalating instead of restart-looping; `ANTIHALL_DEVSWARM_GRACE_SEC` (default `5`,
clamped 1–60) is the SIGTERM→SIGKILL grace window. **Windows is not supported.**

### Codex / cross-tool

`AGENTS.md` is a prose mirror of the verify-first Iron Law + commit hygiene + task
discipline, so Codex agents inherit the same discipline. It lives at the **marketplace repo root**,
NOT inside `plugins/anti-hall/`, so it ships only to people who clone this repo — a
`/plugin install` does not bundle it. Installed users who also run Codex must copy it
into their own repo root manually.

On Codex 0.134 or later, `edit-guard`, `api-guard` and `ship-it-guard`'s existence gate
run on `apply_patch` edits. Shell writes reach the same checks through `Bash` on both
hosts: command-guard applies edit-guard's verdict (`guards.bashEditParity`), and
api-guard and ship-it-guard run on `Bash` too (`guards.shellWriteChecks`); see the
[Codex parity notes](../plugins/anti-hall/codex/README.md). Main thread vs subagent
is detected from the Codex payload itself (`turn_id` + `model`, no `agent_id`), so
`command-guard`'s main-thread heavy-command gate also applies on the Codex main
thread. A Codex started from inside a Claude Code session inherits
`CLAUDE_CODE_ENTRYPOINT` and is treated as a worker.

## Hook reference — plugin "Features" table (detailed, per-hook)

Moved from plugins/anti-hall/README.md "Features" (v0.107.0 doc sweep).

## Features

| Component | Event | Purpose |
|---|---|---|
| `verify-first-full.js` | SessionStart | The verify-first FOUNDATION: full Iron-Law + rationalization-table protocol, the always-on **scope & fidelity** discipline (simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked / drop nothing), and the always-vs-conditional skill/disciplines index; survives compaction. |
| `verify-first-orch.js` | SessionStart | (Default: the full rules inline here. Experimental `context.orchFullOn=spawn` sends `ORCH_COMPACT` plus a per-session marker so `orch-on-spawn.js` delivers the full rules on the first spawn instead. The compact core of `verify-first-full.js` points at `PROTOCOL.md`, the generated full text.) The companion to `verify-first-full.js` carrying the always-on **orchestration discipline** ruleset (rules A–N + the DevSwarm-Primary workspace-tier rule W). SPLIT from `verify-first-full.js` in 0.60.0 because the combined ~15.3k-char payload exceeded the ~10k per-hook injection cap — over which Claude Code spills the overflow to a file instead of delivering it inline, so only ~2k chars landed and rules A–N + rule W reached no session inline. Each half is now under the cap; zero content dropped. Survives compaction. |
| `verify-first-subagent.js` | SubagentStart | Re-injects the compact core (Iron Law, rationalization table, rules, scope-fidelity) plus a short `WORKER` block into each spawned subagent; `context.protocolLevel=full` restores today's text (core + DISCIPLINES + teammate note). Deliberately omits the orchestration/delegate block (subagents are workers; re-injecting it would recreate deep nesting). Shared core extracted to `verify-first-core.js`. |
| `verify-first-core.js` | Shared module (not a hook) | Single source of truth for every protocol text: today's full text (`CORE_FULL`, `ORCH_FULL`, the subagent block), the compact forms (`CORE_COMPACT_BODY` / `coreCompactSession()`, `orchCompact()`, `WORKER`) and the generator input for `PROTOCOL.md`. Shared by `verify-first-full.js`, `verify-first-orch.js`, `verify-first-subagent.js`, `orch-on-spawn.js` and `tools/gen-protocol.js`. |
| `orch-on-spawn.js` | PreToolUse (Agent\|Task\|Workflow on Claude; `spawn_agent` on Codex) | **Experimental, opt-in (`context.orchFullOn=spawn`); silent by default.** Sends the full orchestration rules (A-N) once per context epoch on the coordinator's first spawn, when `verify-first-orch.js` sent only the compact lines and left a `pending` marker (`~/.anti-hall/orch-full/`). One sender per epoch (O_EXCL claim), a retry slot after a 2-minute lease if no delivered copy shows in the transcript; silent for subagents. Codex: opt-in via `context.codexOrchFullOn=spawn` (experimental, matcher `spawn_agent`, sends the Codex wording); otherwise Codex gets the full text at SessionStart. Unverified live (landing point, transcript shape, Workflow spawns). Obeys `context.verifyFirstOrchestration` and the `orch-on-spawn` skip name. |
| `verify-first.js` | UserPromptSubmit | Short, varying one-line nudge each turn (anti-habituation). |
| `git-guard.js` | PreToolUse (Bash) | Blocks AI self-credit attribution — in `git commit` trailers AND in `gh pr/issue/release create\|edit\|comment` `--body`/`--title` (the 🤖 footer, Co-Authored-By, claude.com/claude-code link) — plus `git push --force` and remote branch/tag deletion (`--delete`, `-d`, `:ref`, `--prune`). Inline values only (`--body-file` is fail-open). |
| `api-guard.js` | PreToolUse (Write/Edit/MultiEdit, and Bash) | Blocks code that references a **non-existent** stdlib/builtin API — resolves `module.attr` in the code-to-be-written against the installed `python3`/`node` and refuses the write when the attribute is fabricated. The mechanical answer to API hallucination. Default = stdlib/builtins (import-safe); opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also checks installed 3rd-party packages (off by default — verifying a package imports it, running its code at edit time). 0 FP + full in-scope catch on `tools/eval/api-guard-bench.js`; never probes local/relative modules; fail-open; skip-hatch. On Bash (`guards.shellWriteChecks`) it checks the text a shell write puts in a .py/.js/.ts file when the command shows it (heredoc into `cat`/`tee`, `echo`/`printf`); `cp`, `sed -i` or `python -c` writes carry no visible text and are not checked. A write to `/tmp` or the scratchpad is checked the same way as the Write tool: api-guard judges the code's text wherever it lands (only ship-it-guard's path gate excludes scratch targets), which is intended. Commands over 64 KB are scanned by their heredoc header and body rather than skipped. |
| `command-guard.js` | PreToolUse (Bash) | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload, per-segment (quote-aware). **v0.76.0:** all four DevSwarm destructive-verb blocks now also match the `devswarm` alias, not just `hivecontrol` — `hivecontrol` is a thin shim that execs `devswarm` (the primary command name, equally on PATH), so running `devswarm workspace monitor`/`read-messages`/`message-child`/`message-parent` directly used to bypass every block; fixed with a shared verb set and a `(?:hivecontrol|devswarm)` alternation (latent since the blocks were added, not a new regression; shared file, so both ports are covered). Under a DevSwarm-active session it also redirects destructive native inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` blocks unconditionally, `read-messages` blocks only with durable-inbox evidence (`ANTIHALL_DEVSWARM_INBOX_CMD` or a workspace descriptor `inboxPath`); quoted DATA mentions are not false-positives. **Per-project command allowlist (owner-approved 2026-09-26):** a repo declares its own sanctioned exact commands in `<repo-toplevel>/.anti-hall/command-allow.json` (`{"patterns":["^anchored regex$", ...]}`) — e.g. its own deploy script, which the project's rule says must never be delegated. Runs inline in the MAIN THREAD ONLY (subagents never reach this carve-out — already past the coordinator-only gate). The file applies only after the user TRUSTS its exact content — `node scripts/settings.js trust-command-allow [<repo>] --confirmed` records the sha256 of the file bytes in `~/.anti-hall/trusted-command-allow.json` (outside every repo, keyed by the repo's real path); any edit makes it untrusted until re-trusted, and a symlinked file or `.anti-hall` dir is refused — so a cloned repo cannot authorize itself. Every pattern must start with `^` followed by a literal command word and end with `$`, with no unbounded wildcard (`.*`, `.+`, `[^x]*`, `[\s\S]+`) and no top-level `|`; anything else is ignored (not just non-matching) and reported by doctor with its reason. The WHOLE command must be exactly one unbroken segment (no `;`/`&&`/`||`/`|`/`&`, no subshell/group, no backtick or `$( )` command substitution — reuses the guard's own `splitSegmentsDetailed`) and carry no unquoted `<`/`>` redirect and no `$`, backtick, backslash or `<(`/`>(` anywhere (quoted or not), or it never qualifies regardless of the pattern. A qualifying match writes ONE audit line to `~/.anti-hall/logs/command-allow.ndjson` (`{ts, cwd, repo, pattern, command}`). Default config is empty (no repo behavior change until it opts in). Kill-switch: `guards.projectCommandAllow` (default true). **Allow plain push (owner-approved 2026-09-26):** in the MAIN THREAD ONLY, `git add`/`git commit`/a plain `git push [-u|--set-upstream] [remote] [ref]` (`-u`/`--set-upstream` is the only added flag and needs BOTH an explicit remote and an explicit ref; remote omitted or a configured remote NAME from `git remote` — a path/URL destination never qualifies, fail-closed; ref omitted, `HEAD`, or the current branch only — resolved fresh via `git symbolic-ref --short HEAD`, fail-closed if unresolvable), plus `&&`/`;` chains made up only of those three, run inline instead of being delegated. `--force`/`-f`/`--force-with-lease`/`--force-if-includes`/`--mirror`/`--delete`/`-d`/`--all`/`--tags`/`+refspec`/`src:dst` to another branch, any other chained segment, and pipes/redirects/subshells stay exactly as blocked as before — except three shapes: a `HEAD:<current>` / `HEAD:refs/heads/<current>` refspec (same destination as the bare form), a trailing `2>&1`, and ONE final `| tail [-n] N` / `| head [-n] N` output filter. `git-guard.js`'s own independent force-push/AI-credit checks are untouched. Kill-switch: `guards.allowPlainPush` (default true). |
| `output-verify-guard.js` | PostToolUse (Bash, advisory) | **v0.69.0, Harness Phase-1.** Scans a completed Bash call's own stdout/stderr for common test/build-runner signatures (jest/vitest/pytest/go test/npm run build/tsc) and flags when BOTH a passing signal ("8 passed", "PASS", "ok") and a failing signal ("2 failed", "FAIL", a confirmed non-zero exit) appear in the SAME run — the shape of a partial-pass summary easy to mis-report as a clean "tests pass". Fail-open on any shape surprise (the exact PostToolUse Bash `tool_response` field shape is undocumented); never blocks. |
| `failure-root-cause-nudge.js` | PostToolUseFailure (Bash, advisory) | **v0.69.0, Harness Phase-1.** Fires when a Bash tool call fails (non-zero exit/tool-level error); injects one short reminder pointing at `/anti-hall:root-cause` — deliberately terse since OMC already injects its own root-cause reminders in this harness. Stays silent on expected exit-1 predicates (grep no-match, `test`, `diff`, `git diff --quiet`, `command -v`), on harness refusals, and after the first nudge in a turn (`guards.failureNudgeFilter`). Fail-open always; off-switch `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off`; skip-guard hatch `failure-root-cause-nudge`. |
| `coordinator-work-guard.js` | PreToolUse (Bash), PostToolUse (Bash) | **Main thread only, Claude host only.** Counts successful WORK Bash calls over `guards.coordinatorWorkWindowMinutes` (default 10). One advisory `COORDINATOR DRIFT` note when the count reaches `guards.coordinatorWorkNudgeAt` (4), and a block for the `guards.coordinatorWorkBlockAt`th call (7). The block is the enforcement; the PostToolUse note was live-observed delivering on Claude Code CLI 2.1.238 and is not doc-confirmed; re-verify after a CLI upgrade; blocks are the enforcement. Skip key `coordinator-work-guard`; also off when `safety.commandGuard` is off or command-guard is skipped. Fail-open. See "Coordinator work window" below. |
| `edit-guard.js` | PreToolUse (Write/Edit/MultiEdit/NotebookEdit) | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording when the liveness supervisor is active, topology-aware: "primary/main orchestrator" vs "sub-orchestrator"). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`plan.md`/`STATE.json`/`CONTINUE-HERE.md`, `*.continue-here.md`, the out-of-cwd `.claude/projects/**/memory/**` store), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard` (not in the destructive set). Fail-open. **v0.64.0:** also exempts PLAN MODE for non-source targets, narrowed by an `isLikelySource` classifier so undelegated source-file writes stay blocked even in plan mode. |
| `coordinator-detect.js` | Shared module (not a hook) | The single coordinator-vs-subagent discriminator, extracted from `command-guard.js` so `edit-guard.js` reuses the exact same detection logic instead of duplicating it. |
| `ask-guard.js` | PreToolUse (AskUserQuestion) | OPTIONAL, default off (`guards.noBlockingQuestions`). Enforces the "do not hold work on a question" rule: advise adds a reminder, block refuses the call unless the first question starts with `DESTRUCTIVE:` or `CREDENTIAL:`. Never infers what the user wants from the transcript; fail-open; Claude only (Codex has no ask tool). Also adds the agents-in-flight note (`guards.questionAgentsNote`, default on, independent of the mode). |
| `model-routing-guard.js` | PreToolUse (Agent/Task) | Anti-waste routing — classifies spawn descriptions (mechanical vs complex) and blocks/advises toward the cheapest fitting model. Strict by default (v0.35.0+): unconditional block on omitted-model mechanical spawns. Set `ANTIHALL_MODEL_ROUTING=advisory` (**project-scoped env**) to opt out and revert to advisory-only. Debate role-words in spawn description downgrade row-1 block to advisory. Fail-open; unknown model tokens always allowed. |
| `omc-detect.js` | Shared helper (not a hook) | Detects whether an oh-my-claudecode autonomous loop is active + fresh. Consumed by `task-guard` / `tasklist-guard` to suppress Stop-blocks to advisory when an OMC loop is running, preventing deadlock. Fail-open = NOT deferring. Kill-switches: `DISABLE_OMC=1` or `OMC_SKIP_HOOKS` including `persistent-mode`. |
| `hooks/lib/devswarm-detect.js` | Shared helper (not a hook) | **OPTIONAL, feature-gated** — mirrors `omc-detect.js` for the opt-in DevSwarm liveness supervisor: reports whether it should be considered active for this session/environment. Dormant (zero effect, byte-for-byte identical to today) unless `DEVSWARM_REPO_ID` is set (auto mode) or `ANTIHALL_DEVSWARM_SUPERVISOR=on`. Consumed by `doctor.js`'s per-workspace DevSwarm check. Fail-open = NOT active. Kill-switch: `DISABLE_ANTIHALL_DEVSWARM=1`. |
| `hooks/lib/devswarm-role.js` | Shared helper (not a hook) | **OPTIONAL** — topology gate distinct from `devswarm-detect.js`: answers only "is THIS session a DevSwarm CHILD workspace?" via `DEVSWARM_SOURCE_BRANCH` (non-empty = child, empty/unset = Primary). Fail-open = Primary. Consumed by `devswarm-child-role.js`. |
| `hooks/devswarm-child-role.js` | SessionStart | **OPTIONAL, feature-gated** — Layer 1 of the DevSwarm layered recovery model: for a DevSwarm CHILD workspace only (both `devswarm-detect.js` active AND `devswarm-role.js` child), injects a reminder to proactively self-report idleness (`hivecontrol workspace message-parent`) rather than sit unnoticed. Silent no-op for Primary/non-DevSwarm sessions. **v0.65.0:** also injects the blocking-question escalation protocol into every workspace — a child forwards a blocked decision to its parent (`send --to-primary`) with the options, its recommendation, and the default it will take if unanswered by its deadline, keeps working every other unblocked item, and proceeds on that default while flagging the assumption loudly; only an unauthorized destructive/irreversible action is a hard stop. Ladder is child → parent → human, never child → human; the parent side gets the matching reply-and-escalate directive. |
| `devswarm-parent-inbox.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — mechanical trigger for the "Primary neglects child workspaces" failure (claude-code#39755). For a Primary DevSwarm session only: each turn surfaces the real unread/idle state of active workspaces, and recommends archiving any workspace the store derived as complete (`archive_ready`). Reads the durable-inbox files + the supervisor's verdicts + `summary.json`; never runs git/`computeLiveness` on the hot path. **(0.54.1)** Also injects a compact live table EVERY turn — one row per active workspace: status (`escalated`>`stale`>`archive-ready`>`idle`>`active`>`dormant`, attention first) / finish-rate (required gates met/total + optional heartbeat %) / unread / last-activity; capped at 12 rows with a logged `+N more`. **(0.60.0)** A row idle beyond `ANTIHALL_DEVSWARM_IDLE_MS` (default 6h, ms) is relabeled `active`→`idle` — a view-only demotion (no delete, no gate change, no archive) so a long-verified-done workspace stops reading as "active" forever; never overrides `escalated`/`stale`/`archive-ready`. **(0.67.0)** Each row now renders `name (shortid)` instead of a bare UUID, reading the `devswarm-names.js` fs cache only — never spawns `hivecontrol` on this hot path — falling back to the raw id when no name is cached. **(v0.70.0)** The normal-tier unread segment's wording was softened from a per-turn "STOP ... before continuing" imperative to advisory phrasing (`tierOf` already routes urgent/high workspaces to the separate loud segment, which is unchanged). **(v0.70.1)** New `dormant` tier (rank 5, sorts last, below even `active`): a DevSwarm mesh/registry row outlives its workspace — closing a workspace in the DevSwarm app deletes nothing (registry row, worktree, descriptor, and `hivecontrol workspace list` entry all survive) — so a row whose newest known activity signal is at least `ANTIHALL_DEVSWARM_DORMANT_MS` old (default 30 min, ms) is labeled `dormant` instead of `active`/`idle`, since only heartbeat/verdict AGE reliably separates a live workspace from one closed with no teardown signal. It demotes, it never hides — a dormant row still renders with its unread count, only ranked last, so a genuinely-live-but-quiet workspace can never go invisible; it never overrides `escalated`/`stale`/`archive-ready`, and the threshold is a heuristic, not proof a workspace is closed. **(v0.74.0)** Report-only git ground-truth risk markers are appended to a row's workspace-title cell (never a new column): `local only (not pushed)` or `⚠ N unpushed` (from the child's heartbeat-carried `gitPushState` probe, `companion/lib/devswarm-git-truth.js`), and `merged (unverified)` on an `archive-ready` row whose `merged` gate was self-declared but never proven by git ancestry (`merged_verified !== true`). **(0.111.0 wording):** the no-upstream marker dropped its `⚠` warning glyph and reads `local only (not pushed)` — a child created by `spawn` with a branch that has never been pushed is the normal/expected state, not an error; the underlying `noUpstream` field and its priority over a bare unpushed count are unchanged. Never blocks or implies anything beyond "look before archiving". Silent no-op otherwise. **(v0.100.0)** Archived rows (label EXACTLY `archived`; a real backlog on an archived row escapes via `not-draining`, rank 1.5, so it is never hidden by this filter) are now dropped from the roster table BEFORE the sort/cap, not after — previously an archived row could compete for a table slot on equal footing with a live one and push it into overflow. Default ON via `ANTIHALL_ROSTER_HIDE_ARCHIVED` (`0` restores the old behavior); the count of hidden archived rows is always named as a `+N archived` note, never silently dropped. The cap itself is now configurable via `ANTIHALL_ROSTER_MAX_ROWS` (default 12, was hardcoded). Separately, the advisory `recent[]` broadcast feed — previously rendered the FULL message body verbatim every turn, with no memory of what was already shown — now truncates each body to 200 chars with an ellipsis, drops a broadcast older than `ANTIHALL_BROADCAST_MAX_AGE_MS` (default 24h), and per-session-dedupes against `~/.anti-hall/devswarm/parent-inbox-broadcast-seen/<session>.json` (bounded to 200 keys) so a broadcast no longer re-injects verbatim for the rest of the session. Fails open to showing (never hiding) on any dedup-state read/write failure. **(v0.106.0)** An archive-ready workspace from a PREVIOUS session whose entire unread backlog is the Primary's OWN `archive-request` send (`archive_request_only_unread`, `companion/lib/devswarm-store.js`) and whose session is no longer running is excluded from the urgent/attention nag — it never clears on its own (nobody is left to drain it); the row still gets the existing cooldown'd archive-ready nudge and still shows in the table, just as `archive-ready` rather than `not-draining` forever. A new user-editable ignore list, `~/.anti-hall/devswarm/ignore.json` (`{"ids": ["<id>", ...]}`, `companion/lib/devswarm-ignore.js`), additionally suppresses the same nag for any explicitly-listed id while leaving it fully visible in the roster table — it only ever changes whether a turn nags, never what is tracked. While child questions are unanswered, the Primary's own-inbox notice leads with `QUESTIONS AWAITING YOUR REPLY: N (oldest Xm) — <workspace title>: <first 80 chars>` (preview scrubbed of secrets and control characters; omitted when the stored summary has no question text). |
| `devswarm-parent-gate.js` | Stop | **OPTIONAL, feature-gated** — Primary-only, capped/loop-safe (Phase 5 shared Stop policy `hooks/lib/stop-policy.js`: honors `stop_hook_active`; cap keyed by stable block kind, not unread counts). Blocks the Primary from ending its turn while a child still has unread backlog past its cursor OR the supervisor already judged a child stale/escalated OR **(0.56.0)** the Primary's OWN summary-projected unread is nonzero (read from `summary.json`, no DB open) — surfaced with the same imperative "STOP and read them FIRST via `devswarm.js inbox read-primary <id>`" wording (Phase 5: then run the returned `ackCommand`, `inbox ack-primary <id> --receipt <rid>`) the child gate uses, so a Primary can no longer end its turn while sitting on its own unread inbound. **(0.61.1)** "Unread backlog" now counts only REAL unread — system-generated poke/mirror noise (`companion/lib/devswarm-noise.js` `isNoiseText`) is excluded, closing a ghost-workspace feedback loop where a backlog consisting solely of the Primary's own mirrored poke nagged on every Stop; an unparseable row/unreadable inbox still counts as real (fail-open). Registration also now precreates an empty durable inbox so a freshly-registered child reads as known/empty, not absent. **(0.62.0)** A `stale`/`escalated` verdict is now suppressed (never gates on the liveness axis) when the workspace has a FRESH heartbeat — definitive proof-of-life, since a heartbeat is emitted only by the workspace's own live session — while the real-unread coordination axis is untouched (a live, heartbeating workspace with genuine unread backlog still gates). Reads only files (fs cursor + the supervisor's verdict file + the summary projection + the heartbeat file) — no git, no live liveness on the ~30 s Stop path. Fail-open. **(v0.69.0)** The gate can no longer be satisfied by merely READING a child's blocking `--question` — it now requires an OBSERVED reply, checked against a durable per-project reply-state file (`companion/lib/devswarm-reply-state.js`) that `devswarm-parent-reply-tracker.js` writes on every successful `send --to <id> --question`. The forced-ack cap can no longer silence an unanswered question forever — once exhausted it escalates once with distinct wording instead of going silently quiet; every Primary turn also re-asserts the obligation. **(v0.71.0)** `devswarm-reply-state.js`'s storage is now an append-only JSONL log instead of a lockfile read-modify-write: `recordReply` is one `O_APPEND` write (no lock), `readReplyState` folds the log with a fail-closed newline separator, a 480-byte record cap, and a `__proto__`-safe fold accumulator — structurally eliminating the disclosed steal-branch TOCTOU. A loss-safe migration (`migrateReplyState`) is wired into `update.js`/`doctor-repair.js`. **(v0.80.0)** A stated intent (the gate invites the Primary to say a block is intentional) is now recorded against the exact condition signature it was stated about and suppresses ESCALATION ONLY while that signature is unchanged — the first block on any condition still always fires, the reason text is stored but never echoed back (closed-vocabulary boolean only, since reasons reaching the model as text are an injection surface), and any change to the signature (unread arrives, a workspace's status changes) drops the suppression and resumes normal escalation. The absolute escalation cap remains as a backstop. Ships with a forward migration for the new persisted `intents` map, wired into both the updater and the doctor, fail-open on a pre-upgrade state file with no `intents` key. **(v0.84.0)** The gate no longer hides genuinely drainable mail: a permanently-stale persisted `repoKey` and an `ownerKey`-only descriptor both used to make real unread invisible here. Partition resolution now goes through the SAME shared helper the CLI uses (`companion/lib/devswarm-repokey.js` `registeredRepoKey`), so the gate and the `inbox read-primary` command it prescribes can no longer disagree about which workspaces a session owns. **v0.85.0 dead descriptor vs. neglect:** the old rule — `known:false` on the unread read ALWAYS blocks, unconditionally, INCLUDING an absent inbox file — was itself the defect: a descriptor that outlived its sibling's archive can never produce an inbox, so the gate blocked every Primary turn permanently with nothing available to clear it. An `inbox-missing` (ENOENT only) on a descriptor whose `worktreePath` is ALSO provably gone no longer raises the unknown axis. Nothing is hidden — store-side unread still blocks on `unionUnread`, a stale/escalated verdict still blocks, and every other unreadable reason (`inbox-unreadable`, `cursor-*`, `no-inbox-path`, `read-threw`) still blocks regardless of the worktree. Fail-closed-to-block: "gone" is a definitive ENOENT `lstat` on an ABSOLUTE path only; a relative/missing path, a dangling symlink, or any other stat failure is NOT provably gone. **v0.93.0:** app-side archived-but-still-live senders keep blocking — a question is informational only when its sender matches no registry row of any kind (active OR archived) and no descriptor; the gate folds `archivedRegistryRows` into its known-registry set and fails open to blocking on a legacy summary that lacks the field. Sender attribution (shared with `devswarm-parent-inbox.js`) now excludes the recipient's own identity family first, so a reply from the recipient or a twin never wrongly clears a question from the true sender. **v0.94.0:** when a worktree's meshId maps to more than one sibling registry row, sender attribution is now picked by `companion/lib/devswarm-attribution.js`'s `pickAttributionRow` — a pure function of row values (real-sessionId row wins, then the branch-slug row, then ascending lexical id) — replacing the old liveness-based picker whose present-tense signals could flip the reported sender for the same stored message across passes (defect f3b8f326bfc3). **v0.106.0:** the same `~/.anti-hall/devswarm/ignore.json` ignore list `devswarm-parent-inbox.js` now honors (see that row's v0.106.0 note) also drops a listed id from this gate's neglect computation entirely — never a reason a Primary's turn blocks — while leaving it fully visible everywhere else. **New (Unreleased):** the plain NEGLECT nag (blocking-workspace backlog only — never the unanswered-question/truncation/escalation paths, which bypass the cap unconditionally by design) downgrades to advisory when a newer build is already registered (`installed_plugins.json`) but not yet loaded this session — see `hooks/lib/stop-version-gate.js`. The pre-existing per-signature `intents`/`intentAcks` forced-ack (`devswarm.js gate-intent --reason`) is unchanged; the new shared `hooks/lib/stop-ack.js` ack mechanism was deliberately NOT wired into this gate, to avoid destabilizing its escalation-ceiling logic — it covers `silent-agent-nudge.js`/`tasklist-guard.js`, which had no user-triggered ack at all. |
| `devswarm-parent-reply-tracker.js` | PostToolUse (Bash) | **NEW in v0.69.0, OPTIONAL/feature-gated, Primary only, observe-only** — watches every Bash call for a successful `devswarm.js send --to <id> --question ...` and records it via `devswarm-reply-state.js`'s `recordReply()`, keyed by a durable per-project `repoKey` (not a Claude `session_id`) so `devswarm-parent-gate.js` can tell "read" apart from "decided and replied". Anti-spoof guarded (the response shape alone is not trusted without the input command also plausibly being a real `send` call); never blocks, writes nothing to stdout; fail-open on every error. |
| `devswarm-child-turn.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — child-only. Writes a turn-authored heartbeat (`heartbeats/<DEVSWARM_BUILDER_ID>.json`, unique per child — falls back to a sanitized/hashed `<branch>` key only when `DEVSWARM_BUILDER_ID` is absent; never a background ticker) and reminds the child to report to its parent. **(0.54.1)** Also surfaces a non-destructive unread-count check against the child's OWN durable descriptor inbox — PARTIAL: this only makes an already-populated durable inbox visible to the child; nothing shipped yet drains the child's native parent→child queue into it (v0.54.2 follow-up). **(0.56.0)** The unread surfacing is now IMPERATIVE PRIORITY wording ("STOP and address... FIRST"), scans unread lines for a `[[ANTIHALL_ARCHIVE_REQUEST]]` marker and surfaces a distinct confirm-then-archive segment when found, and mechanically writes/refreshes the child's own descriptor every turn (MERGE-preserving) so the parent can always discover it. Silent no-op otherwise. **(v0.69.0)** Self-continue directive: tells the child to keep issuing tool calls across rounds of a multi-round autonomous task within the same turn, reserving `Stop` for a genuine block, final completion, or an unrecoverable error — cutting the wake-cycle (supervisor cron) latency a per-round idle-out previously cost. Shared verbatim with the Codex port. **(v0.74.0)** `writeHeartbeat` also attaches one report-only `gitPushState` probe per turn (`companion/lib/devswarm-git-truth.js`) — `noUpstream`/`unpushed`, resolved from the worktree at `cwd`, omitted entirely (never fabricated) when the worktree or probe doesn't resolve — surfaced to the parent as a risk marker by `devswarm-parent-inbox.js`. **v0.85.0:** now participates in the SAME per-id advisory lock the archive/retire paths use (`companion/lib/recovery.js`'s `acquireLock`, bounded ~1s sync retry, fail-open to an unlocked write) around its own descriptor rename — an atomic replace installs a NEW INODE at `workspaces/<id>.json`, and an unlocked interleave with a verify-then-unlink-by-pathname retirement could silently de-register a LIVE child. One lock, over mkdir+write+rename, no nested acquisition, no subprocess. |
| `devswarm-child-gate.js` | Stop | **OPTIONAL, feature-gated** — child-only, capped/loop-safe. Forces the child to self-report to its parent before going idle, so a child that finishes a turn pings the parent instead of dropping off its radar. **(0.54.1)** Heartbeat-freshness silencing REVERTED: the brief v0.54.0 "fresh heartbeat satisfies the gate" logic false-silenced a child that worked <5 min then stopped without reporting, so the gate always demands at least one real report per unchanged blocking state, bounded by the per-window cap `MAX_BLOCKS = 2` plus a never-resetting `MAX_BLOCKS_PER_SESSION = 6` lifetime cap (v0.98.1, defect a55d6b71a76f). A benignly-dropped `heartbeat --summary` still counts as an attempted report via a session/nonce-authenticated local attempt record — appended per writer id under `summary-attempts/<repoKey>/<writerId>.ndjson` (the reader also still honors a legacy flat `summary-attempts/<repoKey>.ndjson` file if present) — not a re-prescribed loop. **(0.56.0)** STRICT mode (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON) backs the durable-inbox check with one bounded non-destructive `hivecontrol workspace message-count` probe (5 s timeout) when the durable check shows nothing, to catch a native backlog the child never `inbox pull`ed. Fail-open. **(v0.73.0)** Reads the shared union unread primitive (`companion/lib/devswarm-unread.js`, NDJSON ∪ store-only mesh-direct backlog, hash-deduped) instead of NDJSON alone, and splits its messaging into "CHILD NOT DRAINING" vs "YOUR INBOX" segments naming the workspace by title. |
| `devswarm-child-drain.js` | PostToolUse (Bash) | **NEW in v0.73.0, OPTIONAL/feature-gated, child-only, throttled.** Closes the downstream project field gap where a DevSwarm child has no mid-turn re-entry: `devswarm-child-turn.js` fires once per `UserPromptSubmit`, never during a long autonomous task, so a mesh-direct `send --to` (store-only, invisible to an NDJSON-only reader) could sit unnoticed while the child kept working. Mirrors the Primary-only `devswarm-parent-reply-tracker.js` (same PostToolUse/Bash registration shape) but child-only: on every Bash call, reads the shared union unread primitive against the child's own descriptor and, when unread > 0, injects a drain reminder — throttled to re-inject only when the unread count changes or a 10-minute window elapses, so a busy child isn't nagged on every tool call. Fail-open throughout. |
| `monitors/monitors.json` + `companion/lib/devswarm-wake-watch.js` | Harness monitor (not a hook) | **OPTIONAL/feature-gated.** `monitors/monitors.json` declares one plugin monitor, `devswarm-wake-watch`, with `"when": "always"`: the harness starts `node "${CLAUDE_PLUGIN_ROOT}/companion/lib/devswarm-wake-watch.js" --auto` at every session start. The watcher is pure-read and poll-based (`devswarm.wakeWatchPollMs`): it watches this workspace's own direct mesh mail and emits one stdout line the moment new mail lands, waking an idle session faster than the cron fallback. **`--auto`** marks a harness start: because every stdout line is a transcript event, the expected refusals (`not-a-devswarm-session`, `disabled-by-settings`) stay silent on stdout, so a plain terminal session never burns a turn on them (0.119.0); a model-armed watcher without `--auto` still prints its one refusal line. Additive only: never replaces the CronCreate fallback; off via `devswarm.wakeWatch`. v1 watches directs only, not broadcasts. |
| `swarm-guard.js` | PreToolUse (Agent/Task) | Anti-fork-bomb — spawn-rate cap + real reclaimable-memory check (`vm_stat` / `MemAvailable`, not `os.freemem()`). A blocked spawn also logs one line to `~/.anti-hall/swarm-trips.log` (observation only — doesn't feed the rate window). |
| `phase-tracker.js` | PreToolUse (Agent/Task) | Records every subagent spawn so the statusline shows live swarm activity. It also writes a rolling `~/.anti-hall/agents/recent-spawn.json` heartbeat that `agentsRunning()` consumes, so the Stop guards know when parallel work is live. Never blocks. |
| `agent-watchdog.js` | CLI helper (not a hook) | Heartbeat enforcer — scans `~/.anti-hall/agents/*.json` and reports stale/hung subagents; run manually by the orchestration skill. |
| `task-tracker.js` | UserPromptSubmit | Injects task-list discipline (capture, prioritize, work in order) + a one-line freshness note when open/stale tasks exist. **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see below). |
| `hooks/lib/stop-ack.js` | Shared module (not a hook) | **New (Unreleased).** The one shared signature-ack mechanism for advisory nudge-class Stop hooks (peer complaint: "let me ack a condition I've already confirmed false for the session"). `signatureFor(subject)` hashes a caller-supplied, content-derived string; `isAcked`/`recordAck` read/write a per-session file `~/.anti-hall/stop-ack/<session>.json` mapping `"<hook>:<signature>"` -> ack timestamp — a documented skip-file entry the agent writes once the user has explicitly confirmed the condition is a false positive (same convention as `skip-guard.js`'s `~/.anti-hall/skip.json`, but per-signature/per-session rather than per-guard/TTL'd). Wired into `silent-agent-nudge.js` and `tasklist-guard.js`. Kill switch `guards.stopAck` (default on) / `ANTIHALL_STOP_ACK=off`. Fail-open: any error -> not acked -> blocks normally. |
| `hooks/lib/stop-version-gate.js` | Shared module (not a hook) | **New (Unreleased).** `isStale(pluginRoot, {env, home})` detects when `installed_plugins.json` (harness-owned) has already registered a newer anti-hall version than the one this hook process is running — reuses `skills/update/scripts/update.js`'s own `resolvePaths`/`versionFromInstalledJson`/`isSemver`/`compareVersions` exports (same comparison `doctor.js` already performs read-only), never reimplements the parsing. Wired into `silent-agent-nudge.js`, `tasklist-guard.js`, and `devswarm-parent-gate.js`'s plain NEGLECT nag only. Prospective only — a hook build that predates this file cannot self-check. Kill switch `guards.stopHookVersionDowngrade` (default on) / `ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE=off`. Fail-open: any error -> not stale -> blocks normally. |
| `hooks/lib/state-prune.js` | Shared module (not a hook) | **New in v0.76.0.** Bounds per-session state files under `~/.anti-hall` so they can't grow without limit. Every per-session state file (task-tracker, speculation-guard, tasklist-guard, codex-nudge) was kept forever and never read back once its session ended — on a heavy multi-session machine this reached 47,000+ files across 71 days, worsened by `doctor.js`'s own self-tests orphaning one file per hook per run. `pruneStale()` is wired into each of those four hooks' existing write paths (no new hook, no new event): removes same-prefix files past a 7-day TTL, throttled to once per 6 hours via a stamp file, never removes the current session's own file, fails open on any fs error. |
| `limit-conserve-inject.js` | UserPromptSubmit | **Limit-conservation mode.** Injects a token-conservation nudge when context usage reaches `ANTIHALL_LIMIT_THRESHOLD` (default 85%). `ANTIHALL_LIMIT_CONSERVE`: `auto` (default) reads the OMC usage cache; `on` forces the nudge; `off` disables. Auto mode requires OMC; without it, manual on/off only. Skip-guard hatch: `limit-conserve`. |
| `limit-conserve.js` | Shared helper (not a hook) | Reads the OMC usage cache and applies threshold logic; consumed by `limit-conserve-inject.js`. **Account-aware:** tracks the logged-in Claude account's `userID` (`~/.claude.json`) alongside the usage cache's mtime; if the account changed since last seen and the cache hasn't been refreshed under the new account yet, the stale reading is deactivated rather than mis-applied across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`. |
| `auto-handover.js` | UserPromptSubmit | **New in v0.108.0, ON by default.** When the main agent's context first crosses `autoHandover.pct` (default 85% of this session's ACTUAL context window — see `hooks/lib/context-pct.js`) or the opt-in absolute `autoHandover.maxTokens` ceiling (default 0 = off; env `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS`), whichever comes first, tells it — without asking the user first — to self-write an anti-hall handover (never delegated), tell the user and list the saved paths, and urge `/compact`/`/clear` with an exact `/compact focus: <handover path>` line to paste. Context % comes from `hooks/lib/context-pct.js`: the statusline's real `context_window` figure (persisted by `statusline/phase-bar.js`), else a Codex rollout's `model_context_window`, else a transcript estimate (window from `ANTIHALL_CONTEXT_WINDOW_TOKENS`, the session's last-seen statusline window, or "inferred 1M" once usage passes 200k). With a genuinely unknown window it sends one soft advisory instead of the mandatory directive. Fires once per arm; milestone reminders every `nagStepPct` (5) further points; re-arms when usage drops back below. `ANTIHALL_AUTO_HANDOVER_PCT` overrides the threshold (`0` = off). Shared with the Codex port. **v0.109.0 post-handover new-work gate** (`autoHandover.gateNewWork`, default on): once this session's handover file exists, each prompt carries a short directive — size the request BEFORE starting; above `autoHandover.gateBudgetPct` (default 5) points of the window, offer to park it in the task list + handover until after /compact or /clear, or proceed if the user insists (quick questions, the in-flight task and DevSwarm spawns pass through) — plus ONE measured backstop per handover once usage grows more than that budget past where the handover was saved. |
| `auto-handover-pause-nag.js` | Stop | The auto-handover trigger's companion. If the fire directive has not gone out this arm and the agent is over threshold at a Stop (a long autonomous turn that never reaches a new prompt), it delivers the directive once (shared latch, never while `stop_hook_active`). Otherwise, once it has fired this session and usage is still over threshold, sends one short reminder at a genuinely quiet point — no open TodoWrite work, no subagent spawned in the last 2 minutes — at most once per `nagQuietMin` minutes (default 15). Uses the shared `stop-policy.js` `stop_hook_active` check so its own block-with-reason (the only non-blocking-adjacent way a Stop hook can surface text in this harness) is never re-triggered by its own answer. Silent when `autoHandover.nag` is false or the feature is disabled. **v0.109.5 decisive prompt** (`autoHandover.decisivePrompt`, default on): once this session's `HANDOVER*.md` exists and is fresh (`hooks/lib/handover-freshness.js` mirrors `tasklist-guard.js`'s own staleness rail — a counted file-changing action timestamped after the handover's mtime), appends an instruction to END the reply with one glyph-led line: `🟢 **GOOD POINT TO /compact NOW**` (or `/clear`/`/new` when the handover's own Open items/Next action read as done), or `⚠️ **Refresh the handover first**, then /compact` when stale — never both. Shared verbatim with the Codex port (`/new` in place of `/clear`). |
| `precompact-snapshot.js` | PreCompact (manual + auto) | **New in v0.108.0.** Safety net for the self-written handover: right before every compaction writes a MECHANICAL `.anti-hall/handovers/<date>/<session>/PRECOMPACT-<n>.md` — pwd, git branch/HEAD/dirty files, the task list parsed from the transcript, the last 10 user messages verbatim, and a pointer to the newest `HANDOVER*.md`. Always exits 0 and prints nothing, so it can never block compaction. `handover-resume.js` names it on the next SessionStart. Shared with the Codex port (Codex `PreCompact`). |
| `repair-on-reload.js` | SessionStart + UserPromptSubmit | **New in v0.108.0.** Repairs run on a plain `/reload-plugins` or a new session on a new version, not only via `update.js` / `doctor --repair`. When any default migration in `companion/lib/migrations.js` is not stamped at the running version or newer (one small read of `~/.anti-hall/update-sweep-state.json`), it takes `~/.anti-hall/repair-on-reload.lock` and spawns one detached `doctor.js --repair --migrations-only --quiet` (the newest cached version's doctor, never one older than the running version). It runs only the stamped data migrations and store repairs; statusline, Codex hook install, supervisor and anything else that writes user config stay behind a user-typed `doctor --repair`. One migration touches the project in the session's cwd: legacy state files are copied (never moved) into `.anti-hall/history/legacy/`. Since 0.108.5 the GSD `.planning/` fold never runs here; it is the explicit, copy-only `migrate-state.js --planning`, and `doctor` reports worktrees where the pre-0.108.5 fold moved tracked `.planning/` files, with the restore command. It logs to `~/.anti-hall/logs/repair-on-reload-*.log` (newest 5 kept). At most one run per hour per running version, counted only from a spawn that started (`~/.anti-hall/repair-on-reload.last.json`); the child runs at nice 19. Nothing pending → silent no-op. Subagent payloads skipped. Off: `ANTIHALL_REPAIR_ON_RELOAD=off`. Shared with the Codex port. |
| `hooks/lib/settings.js` (+ `settings-schema.js`) | Shared module (not a hook) | **New in v0.108.0.** The one settings store, `~/.anti-hall/settings.json`: a declarative schema (sections, types, bounds, env names, `/config` option names, legacy sources) and `get`/`getWithEnv`/`set`/`reset`/`source`. Precedence env > settings.json > `/config` > legacy file > default (legacy outranks `/config` until the one-time migration is stamped). Dotted keys are read flat or nested. Used by every guard, Jev, auto-handover, the version alerts, the statusline, and DevSwarm (incl. auto-archive and retention). Front ends: `/anti-hall:settings`, `scripts/settings.js`. See [Settings](#settings-anti-hallsettings). |
| `task-guard.js` | Stop | Blocks once if the session ends with open tasks. |
| `tasklist-guard.js` | Stop | Blocks when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh per-session progress file (`.anti-hall/progress/<date>/<session-id>.md`); coexists with `task-guard` with its own independent block cap; capped + fail-open. **v0.76.0:** state writes now go through `hooks/lib/state-prune.js` (see above `task-tracker.js` entry). Already short-circuits on `hash === lastHash` before blocking again (never re-blocks an identical signal). **New (Unreleased):** honors a per-signature session ack and downgrades to advisory when a newer build is already registered but not yet loaded — see `hooks/lib/stop-ack.js` / `hooks/lib/stop-version-gate.js` below. |
| `skip-guard.js` | Escape hatch (shared primitive) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive git-guard (must be named explicitly). |
| `version-alert.js` | SessionStart (non-blocking) | Tells the agent to inform the user when anti-hall is behind. Two cases: the plugin-cache mirror (`~/.claude/plugins/cache/anti-hall/anti-hall/<v>/`) already holds a newer version than the running one → "reload" only (with that version's changelog headline); the remote is newer (cache `~/.anti-hall/version-check.json`, 2 h TTL — was 24 h, which missed multi-release days) → "update, then reload". Once per session per case. A stale/absent cache spawns a detached `git ls-remote --tags` refresh and stays silent — never blocks on network. `installed_plugins.json` is never trusted (it can lag). Off: `versionAlerts.antiHall=false` / `ANTIHALL_VERSION_ALERT=off`; skip-guard hatch. |
| `devswarm-version.js` (+ `devswarm-version-refresh.js`) | SessionStart (non-blocking) | **New in v0.76.0, OPTIONAL/feature-gated.** Probes the installed DevSwarm version and flags drift from the baseline anti-hall was verified against — `command-guard.js` matches DevSwarm subcommands by literal string, so a renamed verb in a future DevSwarm release would make a block silently stop matching with nothing to signal it. Mirrors `version-alert.js`'s shape: a fresh cache short-circuits, a stale/absent one spawns a detached, unref'd background probe (`devswarm-version-refresh.js`) and returns immediately so session start is never blocked. Drift classification is semver-aware — major/minor advises, patch-only stays silent, a downgrade is worded accordingly; the advisory dedupes on (installed, baseline) so it never nags twice for the same drift. Absent DevSwarm or unparseable output fails open and silent. Baseline lives in the shared `hooks/lib/devswarm-baseline.js` module, also consumed by the doctor check. Registered once, shared by both the Claude plugin and the Codex port. |
| `claude-cli-version.js` (+ `claude-cli-version-refresh.js`) | SessionStart (non-blocking) | **New in v0.79.0.** Probe 2 of anti-hall's drift-probe family. Detects the installed Claude Code CLI version and flags major/minor drift from the version anti-hall's harness-feature KB ([`docs/KB-claude-code-harness-features.md`](./KB-claude-code-harness-features.md)) was last audited against. Mirrors `devswarm-version.js`'s shape: a fresh cache short-circuits, a stale/absent one spawns a detached, unref'd background probe (`claude-cli-version-refresh.js`) so session start is never blocked. Patch-only drift stays silent; deduped on the (installed, baseline) pair. CLI absent or unparseable fails open and silent. |
| `repo-self-drift.js` | SessionStart (non-blocking) | **New in v0.79.0.** Probe 3 of anti-hall's drift-probe family — deterministic, no network. Two checks: (1) parses [`docs/KB.md`](./KB.md)'s own claimed hook/skill counts and compares against the actual count on disk, advising on either mismatch; (2) tracks the date the model KBs ([`docs/opus-4-8-features.md`](./opus-4-8-features.md) etc.) were last audited and advises past a 60-day threshold, since model facts aren't locally discoverable and a probe that can't verify would either invent an answer or fail constantly. Cached (<24h), deduped, fail-open and silent on any error. |
| `fable-availability.js` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache Claude Code's own `/model` selector renders from) once per session — no live API probe, fail-open, silent unless Fable is actually available. When available, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable → Sonnet → Opus. |
| `codex-availability.js` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` (`{available, checkedAt, source}`) once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness — a runtime spawn can still fail even when `available:true`. Registered on both the Claude plugin and the Codex port. Fail-open. |
| `handover-resume.js` | SessionStart | On a fresh session (including after `/clear` or compaction), surfaces the latest `.anti-hall/handovers/` entry (if any) and guides a structured resume from it — supersedes the lossy default compact summary. Fail-open (silent no-op if no handover exists). Registered on both the Claude plugin and the Codex port. |
| `defect-nudge.js` | SessionStart | **New in 0.78.0.** Once-per-day, non-blocking notice of open defects filed against anti-hall via the defect channel (below) — counts and ages only, never reporter-supplied text. Registered on both the Claude plugin and the Codex port. |
| `jev-review-reminder.js` | SessionStart | Durable "time to review the Jev shadow numbers" nudge. Most Jev integrations default to `shadow` (consulted + logged, never trusted) until an owner reviews `jev report` and promotes/demotes them; a per-session reminder would die with the session, so the check and its state (`~/.anti-hall/jev-review-state.json`) live in the plugin. Silent when Jev is off, `jev.reviewReminder` is false (default true), the payload is not the main session, or nothing is due. Also carries the "Recommended: enable Jev" notice (`hooks/lib/jev-recommend.js`): shown only while Jev is OFF and `jev.recommendNotice` is not false, once on first install then at most every 30 days (stamp `~/.anti-hall/state/jev-recommend-notice.json`), via the same `Tell the user now` additionalContext channel as `version-alert.js`; `doctor` prints the same recommendation while Jev is off. Fail-open, exit 0. |
| `jev-weekly-scorecard.js` | SessionStart | Once-a-week, advisory nudge pointing at `/anti-hall:jev` when the 7-day `jev report` shows an integration has earned a KEEP or REMOVE verdict but its `jev.json` mode has not been promoted/demoted to match. Never changes a mode itself (read-only). Silent when Jev is off, `weeklyNotice` is false (default true), the session is a DevSwarm child, or the weekly latch (`~/.anti-hall/state/jev-weekly-notice.json`) shows a check within 7 days. |
| `emit-dedupe-reset.js` | SessionStart | **New in 0.103.0.** Writes a per-session reset marker on every SessionStart source (startup/resume/`/clear`/compaction) so `hooks/lib/emit-dedupe.js`'s UserPromptSubmit suppression re-emits blocks the fresh context lost, instead of treating them as already-seen. State-only, no context injected, fail-open. Registered on both the Claude plugin and the Codex port. |
| `task-lifecycle-log.js` | TaskCreated + TaskCompleted | Log-only: appends one line per task-lifecycle event to `.anti-hall/history/<date>/<session-id>.md` and maintains `.anti-hall/history/INDEX.md`, reusing `session-history-index.js`'s idempotent append helper (the same one `tasklist-guard.js` calls). No matcher, no evidence gate, never blocks, no context injected, fail-open. Claude-only — Codex's hook runtime does not expose these events (see `codex/README.md`). |
| `speculation-guard.js` | Stop | Blocks once when the reply being stopped (payload `last_assistant_message`, transcript tail as fallback) contains hedge-word speculation without an evidence/uncertainty acknowledgment. Always-on (lexical, Tier 2). |
| `speculation-judge.js` | Stop | OPT-IN semantic judge (judges the reply being stopped: payload `last_assistant_message`, transcript tail as fallback): calls an LLM to catch confident inference-as-fact with no hedge word. Off by default; enabled by the `jev.semanticJudge` setting or `ANTIHALL_SEMANTIC_JUDGE=1`. |
| `claim-ledger.js` | Stop | **new in 0.100.0.** LEDGER-ONLY deterministic cross-check: records checkable tokens in the reply being stopped (payload `last_assistant_message`; when the transcript lags behind it, the transcript's last message counts as evidence; transcript tail as fallback) (counts, SHAs, `task N of`, `N days ago`, no-tool "still running") that never appeared in the session's tool output / hook context, to `~/.anti-hall/claim-ledger/<session>.jsonl`. Never blocks; measures the false-positive rate before any blocking tier is enabled. |
| `codex-nudge.js` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off. |
| `silent-agent-nudge.js` | Stop (advisory) | **New in 0.109.0.** Orchestration rule I already tells the coordinator to poll for a stuck background subagent and `TaskStop`+re-dispatch it after ~20 min of silence — nothing mechanically reminded it to. PRIMARY signal (the harness always produces it): scans a bounded tail of the main transcript (`hooks/lib/transcript-tail.js`, capped 1.5MB) for background-Agent launches (`"Async agent launched successfully"` tool_results carrying `agentId:`/`output_file:`) with no LATER terminal `<task-notification>` (`<status>completed\|failed\|stopped</status>`) — "silent" = that agent's `output_file` mtime (or its launch time, if the file is missing — missing counts as dead too) is older than `guards.silentAgentNudgeMin` (default 20 min). SECONDARY signal (additive, kept): the `~/.anti-hall/agents/<id>.json` self-reported heartbeat convention. Nudges once, naming the agent's launch description (or id) and how long it's been silent. Never kills/stops anything itself — advisory text only, capped one nudge per stale snapshot (output_file mtime, or heartbeat ts) — a later change or a new staleness period can nudge again. Off-switch `ANTIHALL_SILENT_AGENT_NUDGE=off`; skip-guard hatch `silent-agent-nudge`. **New (Unreleased):** honors a per-signature session ack (`hooks/lib/stop-ack.js`, see below) and downgrades to advisory when a newer build is already registered but not yet loaded (`hooks/lib/stop-version-gate.js`, see below). Shared verbatim with the Codex port. |
| `stale-agent-stop-note.js` | PreToolUse `TaskStop` (advisory) | Adds one line when the agent being stopped was sent a message (named teammate inbox) or resumed (background agent) after its last report and has not reported since: it may be working. A teammate's end-of-turn report is written to the coordinator's transcript only when the coordinator's turn yields, so the first report after a message can predate it. Never blocks. `guards.staleAgentStopNote`. The same state makes such a teammate count as running (`pendingMessage`) for task-guard / dispatch-demand until 20 min pass with no sign of life. |
| `idle-agent-sweep.js` | UserPromptSubmit (advisory) | Once per user prompt, lists agents that finished but were never stopped, with the exact call to end them. Claude: a named teammate whose newest event is an `idle_notification` with `idleReason` `available` or `failed`, with no later SendMessage to it and no TaskStop (an idle with no `idleReason` means it is waiting on its own work and is not listed; background agents are not listed, their `completed` notification already ended them). Codex: a `multi_agent_v1` agent whose `wait_agent` result is `completed`/`errored` and that was never closed (`close_agent`) or re-tasked (`send_input`/`resume_agent`); an open agent holds a thread slot. The newer Codex `collaboration` tool set has no close tool, so nothing is listed there. Fires when `guards.idleAgentSweepCount` (3) are idle or one has been idle `guards.idleAgentSweepMin` (15) minutes; up to 10 names, oldest first. A `<task-notification>` turn is skipped; a queued burst gets one copy. Never blocks, never stops anything. |
| `merge-side-pick.js` | PostToolUse + PreToolUse (Bash), advisory | Records a wholesale side-pick conflict resolution and test runs per session; on a push with a side-pick not followed by a test run, adds one advisory (`guards.mergeSidePickAdvisory`, default on). Claude and Codex. Never blocks. On Codex the advisory is shown only by Codex builds that support PreToolUse additionalContext (rust-v0.129.0 and later, docs/KB-claude-codex.md section 5.2); older builds ignore it and the recorder stays harmless. |
| `compact-advice-guard.js` | Stop (blocks once) | **New in 0.116.0.** Field defect: the model declared "✅ SAFE TO COMPACT NOW" and repeated a `/compact focus: …` line a few turns after a manual /compact, at low context, on the sole basis that no background agents were running. Blocks once per declaration when the turn's final message recommends compacting (`SAFE TO COMPACT`, `good point to /compact`, `/compact` offered as an instruction — quoted, negated and retracted text excluded) AND context % (statusline → Codex rollout → transcript estimate, `hooks/lib/context-pct.js`) is below `autoHandover.pct` − `guards.compactAdviceMarginPct`, OR a compact boundary (Claude `{"type":"system","subtype":"compact_boundary"}`; Codex `compacted` / `context_compacted`) is within `guards.compactAdviceRecentTurns` turns. Unknown context % → only the recent-compact rule. Allowed: the threshold-fired auto-handover path (latch fired, no compact since, context not low). Honors `stop_hook_active`. Shared with the Codex port. **0.117.0:** the shared matcher (`hooks/lib/compact-advice.js`) no longer fires on a single-quoted or backtick-quoted MENTION of the phrase, a question sentence, or a negated/conditional sentence (`far from`, `not yet`, `once … it will be … ; first …`); the bare `safe to compact/clear` wording now also requires a line/sentence start or the unambiguous ALL-CAPS form. |
| `compact-declaration-guard.js` | PreToolUse (Agent/Task/Write/Edit/MultiEdit/NotebookEdit/Bash) | **New in 0.116.0 (opt-in, default OFF); re-enabled by default in 0.117.0.** Once the current turn (since the last real user message; `<task-notification>`s do not reset it) holds a SAFE TO COMPACT declaration, blocks Agent/Task spawns, file edits and state-changing Bash (`hooks/lib/work-detect.js` + `git push`/`git tag`/`gh pr merge`). Read-only tools pass. Cleared by the next user message or an explicit `RETRACT SAFE TO COMPACT` line. Codex: registered for Bash only (the port registers PreToolUse for shell guards only). Shares the tightened matcher above (**0.117.0**). Toggle via `guards.compactDeclarationGuard`. |
| `ship-it-guard.js` | PreToolUse (Write/Edit/MultiEdit, and Bash) | **OPT-IN, default OFF** — the only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root). Also does a conformance advisory (never blocks) for edits outside a PLAN.md's declared `files:` list. Enforces artifact existence only (not plan quality), conservative, fail-open. No effect when unset. On Bash (`guards.shellWriteChecks`) the existence gate also covers shell-write targets (`>`/`>>`, heredocs, `tee`, `sed -i`, `perl -i`, `cp`/`mv`, `python -c` open-for-write), except writes into the session scratchpad or a tmp root outside a repo. |
| `merge-gate.js` | PreToolUse (Bash) | **OPT-IN, default OFF** — a backstop, not a guarantee. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "needs your eyes" / …) not signed off by the user (only a real typed user prompt after the hedge containing "owner approved"/"owner signed off"/"sign-off received"/"fidelity verified"/"verified against"/"resolved:" clears it — the assistant can never clear its own hedge, and peer/cross-session/hook-injected records do not count; hedges inside quotes/code are ignored). Keyword-heuristic, bypassable, fail-open, cannot hard-loop; no effect when unset. |
| `root-cause` / `orchestration` / `ship-it` / `deadly-loop` (+ `deadly-loop-multi`, `install-statusline`, `doctor`, `system-briefing`, `update`, `activate`, `simplify`, `debt`, `devswarm`, `handover`, `defects`) | Skills | Slash commands (see [Skills](#skills-reference-detailed)). |
| `statusline/` | Statusline | Rich line 1 for ANY repo (monorepo or simple); the monorepo/simple renderer is only a fallback if the rich renderer yields nothing. Line 2 is an always-on phase/context bar. |
| `companion/mcp-reaper.js` (+ `install-reaper.js`) | Interval companion (not a hook) | **OPT-IN**, macOS + Linux. Kills ONLY orphaned MCP-server processes (parent already died); also, separately (`guards.reaperCodexBroker`, default on), **detects and lists (REPORT-ONLY, never killed)** abandoned-looking openai-codex plugin `app-server-broker.mjs` helper processes in the log — spawned detached on purpose, so PPID 1 is normal for a LIVE one; listed only when its `--cwd` is gone or no live claude/codex process (excluding the broker's own descendants) has a realpath'd cwd equal to/an ancestor of/a descendant of its realpath'd `--cwd`, and it is past `guards.reaperCodexBrokerMinAgeS` (30min default). A 2026-09-25 safety review found automatic killing of this class unsafe (unquoted-space `--cwd` paths, `/tmp` vs `/private/tmp` symlink mismatches, the broker's own child always looking like an owner) — it stays report-only regardless of detection confidence. Install via `node companion/install-reaper.js` (`--uninstall` to remove); Windows is a documented no-op. See [`plugins/anti-hall/companion/README.md`](../plugins/anti-hall/companion/README.md). |
| `companion/devswarm-supervisor.js` (+ `install-devswarm-supervisor.js`) | Interval companion (not a hook) | **OPT-IN and OPTIONAL** — dormant with zero effect unless DevSwarm is in use (feature-gated via `devswarm-detect.js`, same optionality model as the OMC/OMX integration). Detects a wedged/idle DevSwarm workspace agent from outbound activity (session transcript + git/worktree) and pokes it (an optional descriptor `nudgeCommand`) or escalates (log + optional `escalateCommand`) — **never kills**. Install via `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove); macOS + Linux full, Windows detection-only. Workaround for claude-code#39755. **v0.66.0:** a cooldown-gated reconcile sweep now also runs on this existing supervisor, so stranded mesh messages self-recover instead of sitting until an update or a manual repair happens to invoke `reconcile` — it uses the same single-consumer lock as the drains, so it cannot race a live one. **v0.93.0:** hivecontrol 2.5.1's `workspace list all` carries no archive field, so the sweep now caches the ACTIVE set (`hivecontrol-active.json`) on every successful list call; a registry row absent from that cache by both id and worktree path, older than the snapshot by a 10-minute grace, reads as app-archived while the cache stays fresh (within 2x the reconcile cooldown) — liveness axis only, a genuine unread question still gates regardless. |
| `companion/devswarm-recover.js` | On-demand CLI (not a hook) | **OPT-IN and OPTIONAL** — the ONLY path in DevSwarm that ever kills a process. `node companion/devswarm-recover.js <workspace-id>` resolves the one confirmed wedged `claude` target and kill+resumes it (`claude --resume`), headless or interactive (naming the id is the deliberate override). Same confirm-gate safety as the old always-on supervisor. Windows: escalate-only. |
| `companion/lib/devswarm-store.js` | Substrate lib (not a hook) | **OPTIONAL** — the persistent write/derive side of the DevSwarm substrate. ONE API, TWO backends chosen by feature-detecting `node:sqlite` (→ WAL sqlite, else an append-only NDJSON journal — dependency-free, green on Node 18/20 through 22/24). **Hooks never open the DB**: it derives a `summary.json` projection (atomic tmp+rename) that hooks read. Tracks messages/registry/cursors + per-workspace append-only completion `gates`, and derives `archive_ready` when all required gates (configurable, default `done,merged,tests_passed`) are met. anti-hall stays agnostic about what any consumer gate means. **(v0.70.0)** New read-side filter `archivedOnlyIds` excludes a genuinely archived workspace (`archived/<id>.json` present, `workspaces/<id>.json` absent) from the LIVE per-turn projection immediately, without waiting for a `doctor`/`update` migration run — an archived workspace with real unread still surfaces via the `orphans[]` pass (no lost signal); structurally cannot hide a live row (a live workspace has its own descriptor by definition), fails open to an empty set on any read error. **v0.84.0:** `computeSummary`'s orphan pass no longer reports partitions nothing can ever read — an ARCHIVED workspace with no live identity-family survivor is exactly the shape `healOrphanPartitions` classifies as `unhealable/archived-no-family` and deliberately never heals, so its unread could never drain and warned on every Primary turn forever. Those ids are now excluded via `companion/lib/devswarm-orphan-policy.js` (`makeArchivedStrandedTest`), which CALLS heal's own exported helpers rather than re-implementing the rule — `tests/companion/devswarm-orphan-policy-equivalence.test.js` fails CI if the two predicates ever drift. The count is preserved in a new quiet `archivedStranded[]`, not dropped, and the classifier fails open (an unclassifiable id stays in `orphans[]`). **v0.93.0:** `computeSummary` now also projects `archivedRegistryRows` (always an array, additive) so gate/inbox callers can fold app-archived-but-still-live senders into their known-registry set without a second read. **v0.94.0:** `resolveSenderRegistryId`'s final leg now delegates to `devswarm-attribution.js`'s `pickAttributionRow` (pure, liveness-free) instead of the freshest-live picker, so `pendingQuestions[].from` can no longer flip between passes for the same stored message. |
| `scripts/devswarm.js` (dispatcher; verb implementations in `scripts/devswarm-lib/*.js`) | CLI (not a hook) | **OPTIONAL** — THE structured interface (CLI over MCP; stable JSON on stdout). Subcommands: `register`/`ensure`, `heartbeat`, `inbox count\|read\|ack` (the durable-inbox cursor primitive — `ack` is the parent-gate's non-skip clear path), `inbox pull` (child-side reception drain — auto-ensures the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate → at-most-one bounded `read-messages`, never `monitor` → atomic idempotent NDJSON append + store parity), `inbox messages`/`read-primary` + `ack-primary --receipt` (Phase 5: `read-primary` is read-only and returns an exact `ackCommand`; `drain-primary-legacy` keeps the one-call read-and-ack for one release) (Primary/store non-destructive read — bodies straight from the store, no descriptor needed; **ack-ownership guard, 0.56.0:** `--ack` refuses [`ok:false`] unless the caller's own identity, derived from cwd as ground truth, matches `<id>` — `DEVSWARM_BUILDER_ID` cannot override a *different* cwd-derived identity; pass `--ack-as-owner` for a legitimate cross-workspace ack), `workspaces list`, `gate --set/--clear`, `nudge`, `archive` (archives anti-hall's own registry state; **v0.108.4:** when the capability gate allows it (DevSwarm >= 2.5.3), ALSO archives the workspace in the DevSwarm app itself via `hivecontrol workspace archive <id>` — EXPLICIT id always, retried once on the known-flaky "Could not confirm terminal process boundary" error — returning `appArchive:{attempted,ok,...}`; dormant/failed falls back to an accurate manual-step instruction, never the old false "hivecontrol has no teardown command" claim; never deletes; **v0.70.1:** `<id>` also resolves an unambiguous shortId/prefix, matching the id shown in the injection/roster table — an ambiguous prefix archives nothing and lists the candidates; `isSafeId` still gates), `archive-request` (**0.56.0**, PARENT-side send-only — posts a `[[ANTIHALL_ARCHIVE_REQUEST]]` message to the child via `hivecontrol workspace message-child`, asking it to archive; never verifies merged/tested/deployed itself, never archives on the child's behalf), `archive-ignore`/`archive-unignore`, `migrate` (`ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported legacy backlog as already-read). `command-guard` has a root-anchored LIGHT_EXCEPTION for it so the guard doesn't block its own wrapper. **v0.61.0 mesh self-heal:** drain-aware routing on `send` resolves to the partition a child is actually draining, plus a phantom-only rescue on the child's first mechanical self-register; new read-only `diagnose` (mesh-health detail: split/duplicate detection, orphans, stale partitions) and `healthcheck [--json]` (pass/fail, exit 0/2, for monitors/CI/the ingest daemon) verbs; register-time dedup filtered through a new `isForwardable` noise filter (forwards only real directs, never poke/hash-mirror junk); `roster`/`workspaces list`/`diagnose` are now pure reads (no `summary.json` write side-effect). **v0.62.0:** `unarchive <id>` (reverses `archive` — restores an archived descriptor + registry row); `migrate-owner-keys` (forward-migration backfilling/re-homing a descriptor's `ownerKey`, idempotent/fail-open/no-delete); `reap-stale [--yes|--confirm]` (dry-run-by-default reaper for descriptors verdicted stale/escalated, gated by fresh-heartbeat/recent-git-activity safety checks); `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes|--confirm]` (archives every current workspace NOT in an explicit active set, dry-run by default); `send --to` now ALSO accepts a row's own `id` (the registry primary key) as a fallback when the meshId match finds nothing, and `roster` now prints `meshId` alongside `id` on every row — closes an addressing footgun where a value copied straight from `roster` used to fail closed as `unregistered-recipient`; `reconcile` runs a mis-keyed/stray-registry-row self-heal pre-pass (`healRegistry`) before computing its drain targets, and `doctor --fix`/`update` ALSO sweep every per-project store for this directly (AUTO-SAFE, no DevSwarm-active gate needed), idempotent and no-delete. **v0.66.0:** `heartbeat` and `reconcile`'s aggregate `ok` no longer report success while a mesh broadcast failed or an individual drain target crashed/timed out — a genuinely absent hivecontrol is a benign skip, not a failure; `logs` now reads rotated history, not just the live file. **v0.67.0:** `spawn` sets a human-readable title after a successful `hivecontrol workspace create`, via a SEPARATE best-effort `hivecontrol workspace update-title -b <branch> "<title>"` call — the title is the caller's own `-t/--title` value when passed, else derived from the `-p` brief (first non-empty line, one leading markdown marker stripped, whitespace collapsed, full line kept — no length cap since v0.108.0); `spawn`'s pass-through of the original argv to `hivecontrol workspace create` is untouched. `reconcile` caches whatever label hivecontrol already has for a pre-existing workspace but never invents one for a workspace with no brief on record. **v0.106.0 fix:** an EARLIER cut of this treated "the caller already passed `-t`" as "titling is handled elsewhere" and skipped the `update-title` follow-up entirely for that case — `hivecontrol workspace create` does not itself apply a title, so `spawn <branch> -t "<title>"` came back `titled:false` and the roster fell back to the raw meshId for every explicitly-titled lane. `-t`/`--title` (both spacing and `=` forms) is now extracted and passed to the SAME `update-title` follow-up as any derived title, and the local name cache (`companion/lib/devswarm-names.js`) is written only once hivecontrol actually confirms it — never a hopeful guess. Any lane mistitled by the earlier bug self-heals on the next `reconcile` sweep (the supervisor already runs one periodically): its existing read-only name backfill reads hivecontrol's own `label` for any workspace still missing a cached name, so no new migration was needed. Fixed a raw NUL byte (a deliberate collision-proof sentinel key, offset 81252) that made `grep` treat the 245KB file as binary — replaced with the `\x00` escape, runtime string unchanged — and a `hasFlag` redeclaration collision where a new helper silently shadowed the pre-existing one and broke `--yes`/`--confirm` detection across `reconcile-active` and `reap-stale`. **v0.70.1:** `roster` now appends the same `dormant` hint (via `companion/lib/liveness.js`'s `isDormantActivity`) that `devswarm-parent-inbox.js`'s table uses, so the two can never disagree about which rows are still transacting. **v0.70.0 mesh/store hardening:** `foldArchivedRegistryRows` (new) folds ALL registry rows sharing an archived id's worktree (not just its own row) and picks the forward survivor by LIVENESS (`pickArchiveForwardSurvivor`), fixing a P0 where a real question could forward into a dead partition; ships as a dual-path migration wired into both `update.js` and `doctor --fix`'s `migrationFix('fold-archived-rows', ...)` — idempotent, fail-open-honestly, no-delete (message rows are never deleted, only registry rows are tombstoned after their unread forwards). `archive` also gained a descriptor-conflict self-heal (`archivedTombstoneIsOrphaned`, decided by inode not registry state, fail-closed on any incomplete scan) unblocking re-archive of an id whose `archived/<id>.json` was a stale leftover from a prior archive generation. **v0.71.0:** `register-primary`'s `--session` now defaults to `CLAUDE_CODE_SESSION_ID` (was the workspace hash), so a Primary registry row resolves its real transcript for liveness reads instead of a synthetic id nothing else recognizes. **v0.74.0:** `gate --set merged` now also runs a best-effort git-ancestry check (`companion/lib/devswarm-git-truth.js`'s `gitMergedInto`, HEAD vs. the resolved default branch) and persists the verdict as a separate `merged_verified` gate row alongside `merged` — REPORT-ONLY, the `merged` gate is set regardless of the verdict (a squash/rebase merge legitimately breaks ancestry even though the work IS merged); a resolved-false verdict prints a stderr warning and shows as `merged (unverified)` on the parent roster, an unresolvable check (no default branch / spawn failure) omits `merged_verified` entirely. **v0.75.0:** `inbox peek-primary` (new) — the non-acking counterpart to `read-primary`, same message-body read, `--ack` forced off, for checking status without advancing the ACK cursor. **v0.84.0 partition resolution follows the WORKSPACE, not the caller's cwd:** `inbox read-primary`/`inbox count` resolved the store partition from the caller's working directory, so a Primary could be told to drain mail it structurally could not see; resolution now comes from the workspace's registered project via the shared `registeredRepoKey` helper (precedence: fresh key → recorded `repoKey` → non-hash `ownerKey`). Also: `gate`/`ensure`/`archive` no longer re-home a foreign project's workspace (copying messages + registry rows, rewriting `ownerKey`, and in `archive`'s case removing the live descriptor) BEFORE their own ownership guard runs — a refused call now writes nothing; `inbox ack <foreign-id>` no longer advances the NDJSON cursor after the resolver already refused, which used to permanently skip that workspace's mail; and `inbox count`/`read` now report `known:false` plus the named `registeredRepoKey`/`callerRepoKey` instead of a silent zero indistinguishable from "no mail". **v0.85.0 archive retires the whole identity family:** `archive` tombstoned by `<id>` only, so a twin cross-linked by `sessionId` (one row's `sessionId` IS the other row's `id`) stayed live in `workspaces/` and kept the Stop gate nagging about an inbox that could never exist. `cmdArchive` now retires the whole family at archive time, plus a forward migration `foldArchivedFamilyDescriptors` (the descriptor-file counterpart of `foldArchivedRegistryRows`) wired into both `update` and doctor's AUTO-SAFE `fold-archived-family-descriptors` repair — idempotent, no-delete, fail-open-honestly, grouped by the id/`sessionId` cross-link ONLY (never bare worktree equality, so two live tabs on one worktree are never retired). Every retire requires PROVEN write authority: an inode+bytes generation fingerprint re-read inside the per-id lock and matched against the scan-time snapshot, plus a fail-closed `worktreeIsProvablyGone` gate on the migration path; a mismatch or unproven gone-ness refuses and is reported in `left[]` (surfaced by `update` and by a doctor `notice`) instead of reading as a clean no-op. `worktreePath` is now persisted absolute; legacy relative values fail closed. **v0.94.0 bounded reconcile + resume:** `reconcile` now applies a total wall-clock budget (`ANTIHALL_RECONCILE_BUDGET_MS`, default 60000ms, or `--budget-ms`; `0` = unlimited) across its per-row drains — a project with dozens of stale rows previously made `update.js`'s synchronous await hang for minutes (defect f3c1bc827d89). A row whose worktree no longer exists is skipped before it costs any budget; whatever is left when the budget runs out is deferred to a resume marker and prioritized first on the next sweep. **v0.95.0:** `diagnose` now resolves `sessionId` through the descriptor when the registry is stale, reporting a `descriptorSessionId` field on disagreement instead of surfacing the stale registry value as current; `unclaimed:` promotion derives the caller's real session id from `--session`, `CLAUDE_CODE_SESSION_ID`, or — only for a row still carrying the marker or lacking a sessionId — the harness's own session file found by walking the parent-pid chain (cwd-in-worktree check plus a pid-reuse/staleness liveness guard); descriptor/registry divergence is repaired in both directions, and a registry write failure during promotion is now reported as `promotion.registryWriteError` on `inbox pull`/`read-primary`/`inbox messages` output (plus a stderr line) instead of being swallowed — the next read repairs the registry from the descriptor. **v0.96.0:** `send`/fold target selection now uses a strict, heartbeat-aware liveness gate instead of a bare sessionId shape test (the fold/rehome paths are deliberately left on the older predicate); `callerOwnsRow`'s "sole row on this worktree" ownership proof now also requires that row be unclaimed. `send`/`heartbeat` results and every ownership refusal carry an additive `identity: {id, kind}`. `inbox ack` refuses the whole verb (instead of half-acking) on a resolvable ownership mismatch — an unresolvable-caller-identity or unregistered-caller shape still fails open. `diagnose` rows carry an additive `archivedInApp` field, forcing `live:false` even against a fresh heartbeat; the app-side archive-cache match now also requires `repositoryId` agreement when both sides carry one. `reconcile` skips a worktree whose git root cannot resolve (`skippedNotGitRoot`) and checks its own wall-clock budget before that git-root probe, not just before the resulting spawn. `update.js` applies one overall wall-clock budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`, default 90s) across every post-pull DevSwarm stage, deferring whole stages past the deadline. **v0.100.0 (P0 safety fix):** NO verb previously recognized `--help`/`-h` — `--help`/`-h` fell straight through to real dispatch, so `migrate -h` genuinely ran the migration and `merge --help`/`merge -h` genuinely forwarded to hivecontrol AND sent a live, unconditional mesh broadcast (a read-only-fenced diagnostic agent triggered this via a live defect report). `run()` now intercepts a help request (a `help`/`-h` positional anywhere, or `--help`) BEFORE the switch, covering every verb including the two raw-argv-tail pass-throughs (`spawn`/`merge`), with zero store opens, zero filesystem writes, zero child processes. The verb list backing top-level `help` output is derived from `run()`'s own switch statement (never hand-typed) so it cannot drift — a hand-typed list in the old default-branch error message had already drifted (`reconcile-registry`/`wake-directive` were real, dispatched verbs missing from it). Each verb's usage line names its concrete side effects when actually run. |
| `companion/lib/devswarm-names.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.67.0.** The shared fs-backed name cache behind human-readable workspace names: written by `devswarm.js` (`spawn`'s `update-title` call, `reconcile`'s pre-existing-workspace label cache) and read by `devswarm-parent-inbox.js`'s status table. Atomic tmp+rename write; a read failure fails open (falls back to the raw id). |
| `companion/lib/devswarm-git-truth.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.74.0.** Two independent, fail-open git ground-truth probes for a DevSwarm child worktree: `gitPushState` (unpushed-commit count + whether an upstream is even configured) and `gitMergeProof` / `gitMergedInto` (HEAD-vs-REMOTE-default-branch ancestry; the one merge proof shared by `gate --set merged` and auto-archive gate (b)). REPORT-ONLY throughout (auto-archive only withholds an archive on it) — `null` on any probe failure (never a fabricated fact), same argv-array `spawnSync` convention as `liveness.js`'s `defaultGitCommitTs`. Called from `devswarm-child-turn.js` (heartbeat push-state), `scripts/devswarm.js`'s `gate --set merged` (merged-gate verification) and `devswarm-lifecycle.js` gate (b). |
| `companion/lib/devswarm-identity-family.js` | Substrate lib (not a hook) | **OPTIONAL** — the ONE owner of identity grouping; pure (no fs/store/git), the caller performs every write. `familyKeyOf`/`collapseFamilies` group by resolved worktree for COUNTING. **v0.85.0** adds the mutating-side pair `crossLinkedIdentity`/`identityFamilyTwins` for archive, using a deliberately STRICTER predicate — one row's `sessionId` IS the other row's `id` — because worktree equality alone cannot justify a write (two legitimately-live tabs legitimately share one worktree). Kept in this module rather than at the archive call site so a second, parallel grouping rule cannot drift from the first. **v0.93.0** adds `recipientFamilyIds()` so sender attribution can exclude the recipient's own identity family before ranking candidate senders. |
| `hooks/lib/jev-assist.js` + `scripts/jev-report.js` | Shared module + CLI (not a hook) | **Jev metrics (v0.108.0).** Each Jev call logs its real cost (the gateway's reported cost, else tokens × the owner's `jev.prices` table, else — **v0.108.4** — tokens × the built-in `jev.priceUsdPerMInput`/`jev.priceUsdPerMOutput` default rate, never invented) and cache hits cost $0. `jev-report.js` shows per-integration calls, precision from `tp`/`fp` labels (`jev-report.js label <hash> tp\|fp`), yield, cost efficiency, overhead and a headline; changed decisions are de-duplicated by content hash; `--by project\|session` sums real cost per project/session too; the Vercel AI Gateway credit balance (15-min cache, report-time only). Opt-in budget watch (`jev.budget.mode=watch` + `usdPerDay`/`usdPerWeek`/`minCreditUsd`) only warns, never disables Jev. Opt-in audit snippets (`jev.audit.snippets`) store a redacted ~200-char snippet for decisions Jev changed; `jev-report.js prune-audit` trims them. |
| `scripts/defect.js` | CLI (not a hook) | **New in 0.78.0.** Durable, file-based two-way defect channel between agents running anti-hall in any repo and the anti-hall maintainer — deliberately NOT built on the mesh (bug reports about a messaging layer shouldn't travel through that layer). Subcommands: `report --class C --sev p0\|p1\|p2 --sym T [...]` (exits non-zero on every outcome but `recorded`/`occurrence-appended` — registry-full, occurrence-capped, defect-full, too-large, write-unverified, invalid-class, invalid-severity all fail loud), `list [--mine\|--open\|--unfinished]` (`--open` = `status === 'open'` only, untriaged;
`--unfinished` = every status except the closed set fixed/wontfix/notabug/dup, i.e. also
catches `ack`/`partial`/`regressed`), `show <fp>`, `rule <fp> --status ack\|fixed\|partial\|wontfix\|notabug\|dup` (maintainer-only, appends a ruling — `partial` carries `--fixed-in`/`--note` for a fix that shipped only in part and never derives as fully `fixed`; exits non-zero on anything but `ruled`), `archive` (rotation sweep: ruled-and-stale (30d) files move to `archive/<YYYY-MM>/`; open defects never move). Reports live in `~/.anti-hall/defects/`, one append-only NDJSON file per defect, filename-fingerprinted by defect class + normalized symptom (digit/hex runs stripped) so dedup falls out of the layout. An unknown flag on any subcommand is rejected (nothing written) rather than silently dropped; only `--sym-file`/`--repro-file` take file paths. **v0.84.0:** over-length fields are no longer silently truncated — the result JSON and stderr now name every cut field with its original length, and the caps for `note` (300 → 1200), `claimed`, and `observed` were raised. |
| `hooks/lib/defect-store.js` | Shared module (not a hook) | **New in 0.78.0.** Backing store for `scripts/defect.js` and `defect-nudge.js`. No index, no cached state — status, occurrence count, and first/last-seen are derived from a defect file's own lines on every read; status is the LAST ruling in append order (not by timestamp), so clock skew can't flip it. Every append is re-read and matched byte-exact before reporting success; an unconfirmed write reports `write-unverified` and exits non-zero. Nothing is ever deleted — ack/resolve append, rotation renames into an archive dir. Bounded: ≤200 open defects, ≤20 reports/defect, 64 KiB/file, 4 KiB/line, ≤1000 archived — every cap refuses with a distinct outcome. **v0.84.0:** the shared clamp used to cut a field at its cap and report plain success, with nothing in the result or the stored record to show text had been lost. It now returns a `truncated` map naming each cut field with its original length, and text fields carry a `[truncated from N chars]` marker inside the persisted value. `FIELD_CAPS` raised (`note` 300 → 1200, `claimed`/`observed` → 600, `repro` 1200) — bounded so a maximum-length field still cannot push a record past `MAX_LINE_BYTES` (4096). The write itself never fails. |
| `foldMeshDuplicates` (in `scripts/devswarm-lib/fold.js`) | Migration (not a hook) | **v0.61.0** — folds every prior mesh store shape (phantom rows, dual/legacy pairs, subdir-split registrations, stale entries) onto one canonical survivor per worktree, keyed by git-toplevel canonical identity (a child registered from a subdirectory now resolves to the same mesh identity as its toplevel). Idempotent, non-destructive (forward-before-tombstone; message rows are never deleted), fail-open. Wired into both `update.js` (runs post-update) and `doctor --repair`'s auto-safe repair (the dry-run detect pass doubles as a read-only mesh-shape check under `--check`, then applies). |
| `companion/lib/row-state.js` | Substrate lib (not a hook) | **OPTIONAL** — THE one read-side row-state derivation (mesh redesign Phase 4): `rowState()` answers `archived` / `app-archived` / `active` / `unknown` from anti-hall's archived marker, the app-side archived-set cache and the active descriptor, in that precedence; `isArchiveComplete`/`archiveCompleteIds` answer "the archive finished". Used by routing, the roster, `diagnose`, the parent Stop gate, the parent-inbox table and the store's registry filter so no two surfaces can disagree. Pure reads, fail-open. |
| `companion/lib/migrations.js` | Migration registry (not a hook) | **OPTIONAL** — the ONE registry of the all-store DevSwarm forward-migrations (fold-all-stores, heal-orphan-partitions, fold-archived-rows, fold-archived-family-descriptors) and their per-version completion marker (`~/.anti-hall/update-sweep-state.json`), shared by `doctor --repair`, `update` and the supervisor. A marked entry is skipped with one marker read; an unmarked one gets one live scan and is stamped only on a clean finish. Deletion-class repairs are `optIn` and never run from it. |
| `companion/devswarm-migrate.js` (+ `devswarm-ingest.js`) | Substrate lib / daemon (not a hook) | **OPTIONAL** — `migrate` dual-reads existing on-disk state (JSON registry + legacy NDJSON inboxes) into the store: **idempotent** (dedupe hash), **non-destructive** (reads sources only — legacy files stay byte-for-byte, rollback always possible), single-consumer-locked, and count-verified before it reports success. `devswarm-ingest.js` = the one supervised daemon wrapping the native `monitor` → store; refuses to start if another monitor consumer is running (lockfile), enforcing the single-native-consumer invariant. |
| `companion/install-devswarm-ingest.js` | Installer (not a hook) | **OPTIONAL — new in 0.54.1.** Installs/refreshes `devswarm-ingest.js` as a CONTINUOUS supervised daemon (unlike the periodic supervisor sweep): macOS LaunchAgent with `KeepAlive` (re-exec on exit), Linux `systemd --user` `.service` with `Restart=always` (cron fallback — every minute, restart-if-dead — when `systemctl` is absent; up to ~60 s revive gap on a cron-only Linux host after a crash). Distinct label (`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the supervisor. Idempotent; safe to install redundantly (the daemon's own single-consumer lock means only one instance ever runs). Windows: documented no-op (no pure-Node long-running user scheduler). **Autonomous refresh:** the `update` skill runs this installer's `how` command automatically (no offer, no ask) whenever an update happens inside an active DevSwarm session, same posture as the supervisor installer — closing the gap where the ingest daemon existed in code but nothing started it. **Cwd caveat:** the daemon drains the workspace of the git worktree it is INSTALLED FROM (`hivecontrol` resolves a workspace by cwd, not env) — the installer bakes that install-time worktree as the unit's `WorkingDirectory` and refuses to install if run from a non-git-worktree cwd. **v0.65.0:** root-caused an ENOENT storm — the daemon spawned `hivecontrol` by bare name while the service manager supplied only a minimal `PATH`, so every monitor cycle failed invisibly. The installer now discovers the binary once at install time and bakes it into the generated launchd/systemd/cron unit (never a hardcoded path); the daemon resolves it from an explicit option, `ANTIHALL_DEVSWARM_HIVECONTROL`, or `PATH`. Permanent faults (ENOENT/EACCES/ENOTDIR) now escalate through a capped backoff instead of storming the log, sliced so the heartbeat keeps writing. Orphaned ingest locks are swept on daemon start with positive-confirmation-only removal (a recycled pid or zombie holder no longer blocks restart forever; unknown holder states block by default). **v0.66.0:** a monitor batch that arrives but fails to parse is now logged and quarantined to disk instead of vanishing via the consume-on-read native queue (a well-formed empty result is still normal, not an error); the singleton supervisor unit now carries the same resolved `hivecontrol` path as the per-project units. **v0.86.0:** the v0.65.0/v0.66.0 fixes above were INCOMPLETE — baking the `hivecontrol` path fixed finding the CLI, but the emitted unit `PATH` never contained the directory of the ABSOLUTE node binary the unit bakes as its own interpreter, and `hivecontrol` is a SCRIPT whose shebang re-resolves `node` THROUGH `PATH`. The daemon started fine (absolute argv[0]) while every grandchild spawn died `env: node: No such file or directory`, exit 127 — 23,928 occurrences over 1,757 supervisor sweeps across three repoKeys, `healed:0` on all of them. `unitEnvFor` now prepends `dirname(execPath)` and requires `execPath`, so a unit's `PATH` cannot disagree with the interpreter baked into it; install refuses if that binary is not a real file. |

### Coordinator work window

The main thread should delegate state-changing work. `coordinator-work-guard.js` counts it. A Bash call is WORK when any of its segments (including commands inside `sh -c`, `eval` and `$( )`) is one of these:

- **State-changing git:** commit, am, revert, merge, rebase, cherry-pick, reset, push, pull, restore, rm, mv, stash (except `list`/`show`), clean (except `-n`), apply (except `--check`/`--stat`/`--numstat`/`--summary`), `switch -c`, `checkout -b`/`--`, `branch -D`/`-f`, and tag create or delete.
- **A gh mutation.** A `gh api graphql` call counts unless it is proven to be a read.
- **A Bash write into a repo file that is not a notes file** (the same verdict edit-guard gives an Edit tool call).
- **A script-file run** (`bash x.sh`, `python3 x.py`, `./x.sh`). Steps run in this order and the first match wins:
  1. an unresolvable `$VAR` path counts;
  2. an anti-hall CLI, or a script inside an anti-hall plugin root, does not count;
  3. a direct-exec binary (ELF or Mach-O) does not count;
  4. the session scratchpad, a tmp dir that is not inside a git work tree, or `.anti-hall/**` counts;
  5. a package-manager or system location does not count, whatever its mtime. That covers `/bin`, `/sbin`, `/Applications`, `/usr` and `/opt` outside the repo, `node_modules/.bin`, `.venv/bin`, and the nvm, pyenv, rbenv, cargo, volta, asdf, go, dotnet and bun dirs;
  6. inside the repo, a tracked and clean script does not count. An untracked, modified or ignored one counts. An old script that the coordinator could not edit itself does not count;
  7. outside the repo, scripts in `~/.local/bin`, `~/Library` and `~/.claude/plugins` count only if they were written or changed since the session started. Any other outside script counts.
  
  In a non-git project the current directory acts as the root, and only a fresh or coordinator-writable script counts: an old `./configure` does not, a fresh `./x.sh` does.
- **Inline code:** `python -c`, `perl|ruby|node -e`. The body is read, never run. It counts when a literal git/gh command or file write is found next to an exec call. A precise match (a state-changing git/gh command, or a literal write into a repo file) is blockable. A loose match (a computed write target, or a quoted redirect) is counted only.

**Never blocked, still counted:** recovery commands (`git am|rebase|cherry-pick|revert --abort|--quit`, `git merge --abort`, `git stash pop|apply`) and loose inline code. Patch application is for integration agents; the coordinator has no `git am` exemption.

**Observe-only mode:** with the window above 0 and both `nudgeAt` and `blockAt` at 0, the guard only records state. Window 0 turns the guard off.

**Bash edit parity:** Bash writes are judged like the Edit tool: a repo file the Edit tool may not write (including gitignored outputs like build/ or .env) is blocked; write under .anti-hall/ or the scratchpad, or delegate.

**Known gaps:**

- Obfuscated or computed inline bodies are not detected, and loose inline matches are count-only.
- A binary compiled during the session (`go build -o /tmp/p`) is never counted.
- Running a tracked script that you modified this session counts. That is by design: the verify loop belongs to the subagent.
- Freshly generated, gitignored build launchers (`./build/install/app/bin/app` after a build) count.
- A fresh script inside a git submodule counts, because `git status` from the parent fails on that path.
- Deliberate mtime back-dating (`touch -t`, `touch -d`, `cp -p`) hides a fresh script.
- A fresh script dropped into a package-manager or system location is not counted. Neither is one in a fake managed directory made outside the repo, such as `~/x/node_modules/.bin/p.sh`.
- An untracked, old, non-coordinator-writable script inside a repo is not counted.
- Text scripts under `~/Library` or `~/.claude/plugins` count if they are updated mid-session (an SDK install, a plugin update).
- `just` and `task` runs, `git stash pop|apply` landing edits, and `cd "$X" && ...` with an unknown cwd are not counted. `npm`, `npx`, `pnpm`, `yarn`, `bun` and `make` are heavy commands and stay blocked.
- A trusted `./gen.sh > docs/api.md` stays blocked by Bash edit parity.
- Nudge delivery: PostToolUse `additionalContext` was live-observed delivering on Claude Code CLI 2.1.238 and is not doc-confirmed (`docs/KB-claude-codex.md` §1.4); re-verify after a CLI upgrade; blocks are the enforcement. Codex coordinator detection is unverified.
- Scripts fed on stdin are not counted: `python3 - <<EOF`, `node <<EOF`, `sh <<EOF`, `echo … | sh`, `bash -s <<<`.
- Wrapper forms hide the git/gh verb: `time -p git`, `env -C d git`, `gh -R o/r pr merge`, `gh api -XDELETE`.
- Writes via `>|`, a clustered `cp -rt` (the wrong target is read), `install`, `dd of=`, `truncate`, `ln -sf` and `rm` are not judged as repo writes.
- `git checkout .` and `git checkout <file>` are not counted.
- With a plugin path containing `'`, the printed skip command itself counts as WORK.

## Statusline, configuration/tuning, troubleshooting, and local testing (plugin)

Moved from plugins/anti-hall/README.md (v0.107.0 doc sweep).

## Statusline (opt-in, one command)

Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher whose **line 1 is the rich renderer for
ANY repo** (project name, git, model, context%, cost, duration, subagents). Line 1
also shows an **anti-hall version chip** (`AH: Vx.y.z`) between the
cost and email segments: `★` prefix in YELLOW for a new minor version, RED for a new
major version, plain dim when up-to-date (fail-open if no version-check cache exists).
Only if the rich renderer yields nothing does it fall back to a
monorepo-aware renderer (`.gitmodules`) or a **simple**
`model | branch | dir | context%` line. Line 2 is an always-on phase/context bar. No emojis.

**Consolidated mode (`--consolidate`):** pass `--consolidate` to merge with an existing
`statusLine` (e.g., the OMC HUD) instead of replacing it. The existing base is detected
from current settings or read from `ANTIHALL_STATUSLINE_BASE` (env), and is persisted to
`~/.anti-hall/consolidated-base.json` for subsequent sessions. Use this mode when you
already have another statusline and want anti-hall to extend it rather than overwrite it.

```bash
# Find the installed plugin dir and run the Node installer. Claude Code installs a
# plugin under the cache dir, versioned per marketplace/plugin
# (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ — for this plugin that is
# ~/.claude/plugins/cache/anti-hall/anti-hall/<version>/), but older layouts nest it
# under marketplaces/. We search all of them. A dir only counts if it contains the
# plugin manifest, so a parent dir is never mistaken for the plugin dir.
DIR=$(for d in \
  ~/.claude/plugins/cache/*/anti-hall/*/ \
  ~/.claude/plugins/cache/*/anti-hall/ \
  ~/.claude/plugins/cache/anti-hall/*/ \
  ~/.claude/plugins/cache/anti-hall/ \
  ~/.claude/plugins/marketplaces/*/plugins/anti-hall \
  ~/.claude/plugins/*/plugins/anti-hall \
  ~/.claude/plugins/*/anti-hall; do \
  [ -f "$d/.claude-plugin/plugin.json" ] && echo "$d"; done 2>/dev/null | head -1)
[ -n "$DIR" ] && node "$DIR/statusline/install-statusline.js" || echo "anti-hall not found under ~/.claude/plugins (cache or marketplaces) — install it first (/plugin install), then re-run, or locate the dir via /plugin."
```

**Windows is not supported** (untested, dropped from CI). Use macOS or Linux.

To do it by hand, run `/plugin` to find the install path, then invoke the installer
directly: `node "<full-path>/anti-hall/statusline/install-statusline.js"`.

See `statusline/STATUSLINE.md` for details and how to revert.

## Settings (`/anti-hall:settings`)

Every user-facing anti-hall setting lives in ONE place: `~/.anti-hall/settings.json`,
organized into sections (`autoHandover`, `guards`, `safety`, `context`, `maintenance`,
`jev`, `jevIntegrations`, `limitConserve`, `devswarm`, `statusline`, `codexNudge`,
`versionAlerts`, `updates`, `defects`). Since 0.108.4 every hook anti-hall registers (Claude and Codex)
has an on/off switch whose default is the old behaviour; the hook checks it first and
does nothing when it is off. The few parts with no switch on purpose (shared libraries,
bookkeeping hooks other features read) are listed with the reason at the end of
`settings.js show`. The declarative
registry of every setting (key, type, allowed values, default, env-var override, legacy
source, description) is `hooks/lib/settings-schema.js`; the read/write API is
`hooks/lib/settings.js`. Every `devswarm` knob's consumer takes an explicit `env`
parameter (for testability) rather than reading `process.env` directly; `settings.js`'s
`getWithEnv(section, key, dflt, env)` threads that SAME env through and derives `home`
from it (never `os.homedir()`), so a test's isolated HOME is always honored —
`tests/hygiene/settings-home-injection.test.js` proves this mechanically for every
wired resolver.

- **`/config` (arrow keys, no model involved)** — Claude Code's native `/config` panel
  (v2.1.269+) shows only the headline switches (auto-handover on and threshold, Jev on,
  DevSwarm supervisor mode, model routing, limit conservation), the four safety guards
  and the API keys: 14 `userConfig` options in `plugin.json`. Every other setting has a
  key in `~/.anti-hall/settings.json`, reachable through `/anti-hall:settings` and grouped by category.
  `userConfig` never declares `options` (a public plugin can't require v2.1.271+
  just for its settings UI — declaring `options` on any field breaks plugin loading before
  v2.1.271, per the Claude Code plugin manifest docs), so enum switches render as a plain
  string field whose description lists the allowed values; older Claude Code versions
  still work via the skill. `tests/hooks/settings-schema.test.js` pins the manifest to exactly the 10
  `headline: true` schema entries plus the 4 sensitive keys, and fails if any field declares `options`.
  Every other setting that used to have a row keeps its old option name as a read-only
  legacy source (`pluginOptionLegacy`), so a value already stored under Claude Code's
  `pluginConfigs` (or still exported as `CLAUDE_PLUGIN_OPTION_*`) still applies, and
  `migrateLegacyPluginOptions` (the update / `doctor --repair` run of the first release that runs it) copies each
  non-default one into `~/.anti-hall/settings.json` without touching or deleting the Claude Code file
  (only when that stored value is already the effective one; never for the 10 headline switches, the home-only keys and the credentials; the locked safety keys are copied as human-confirmed values, the same write as `settings.js set <key> <value> --confirmed`, because a stored option can only be the person's own `/config` choice). Both `pluginConfigs` key forms
  (`anti-hall@anti-hall`, `anti-hall`) are read. Downgrade is safe: the settings-file value outranks the stored option, so an older plugin version resolves the same effective values.
- **Ask for it** — say "turn off the merge gate" or "set auto-handover to 80%" and the
  `settings` skill applies it with one `set` (no table dump); "show my anti-hall settings"
  prints the tables only when you ask.
- **CLI directly**:
  ```bash
  node plugins/anti-hall/scripts/settings.js show                      # every category (one table each), non-advanced settings
  node plugins/anti-hall/scripts/settings.js show --section jev --all  # one section, including advanced/tuning knobs
  node plugins/anti-hall/scripts/settings.js get autoHandover.pct
  node plugins/anti-hall/scripts/settings.js set limitConserve.threshold 90
  node plugins/anti-hall/scripts/settings.js reset limitConserve.threshold
  ```
  Every subcommand takes `--json` for scripting.
- **Precedence** (highest to lowest): an `ANTIHALL_*` env var override → a value in
  `~/.anti-hall/settings.json` → a value set via Claude Code's native `/config` panel
  (only the 10 headline switches are declared in
  `plugin.json`'s `userConfig`; every other setting only reads a value stored there by an older version; shown as Source `plugin-option`) → a legacy per-feature config file
  (e.g. `~/.anti-hall/jev.json`) → the schema default. (Transitional exception, `settings.js` `resolveBelowFile`: until the one-time legacy forward-migration is stamped for the installed plugin version, a legacy `jev.json` value ranks ABOVE a `/config` value, so a pre-existing `jev.json` is not masked by `/config`'s own manifest default; after the stamp the order is as written.) `show`'s Source column tells you
  which tier answered a given row. Safety keys read through this SAME chain — there is
  no special-cased ignore rule for them (see below).
- **Known limitation (`/config`):** a `/config` value that equals the manifest default
  (`plugin.json` `userConfig` default for a headline row; the schema default for every other setting) is indistinguishable from "never set", so it counts as
  unset and a lower tier (a legacy file, the schema default) answers. To pin a value that
  equals the default, set it in `settings.json` (`/anti-hall:settings`) instead.
- **Safety guards need a confirmed change, not a hard refusal ("safety" in the table
  below).** `safety.gitGuard`, `safety.commandGuard`, `safety.editGuard`, `safety.swarmGuard`,
  and the knobs that weaken them (`guards.stashGuard`, `guards.editGuardAllow`,
  `guards.allowSubagentMailbox`) are owner decision (0.108.4, revised): no hard refusal —
  a human direct command, or a confirmation after a clear, plain warning, is enough.
  `settings.js set` to the risky value (a guard off, a bypass on, a new allow-list path)
  needs `--confirmed`, and so does a `reset` whose fallback value is the risky one (e.g.
  resetting an armed `guards.stashGuard`, whose default is off); re-arming a guard,
  narrowing a list, or a reset back to a safe default does not. Without it nothing
  changes and the call returns `{ok:false, needsConfirmation:true, warning}` — one short,
  factual, human-readable line built from the key's own `safetyNote` in the schema (calm
  facts, not alarming). A direct user ask to change the guard IS the confirmation; otherwise
  the skill shows the warning and asks (`AskUserQuestion` on Claude, a numbered yes/no on
  Codex) before applying it. Once confirmed, the value reads through the SAME precedence
  chain as any other setting (env > file > /config > legacy > default) — the confirmation
  is the protection, not an ignore rule. Turning `safety.commandGuard` or `safety.editGuard`
  off turns off the delegation check only; command-guard's data-safety sub-guards stay on.
  The per-guard `skip.json` escape hatch works as before, and `"all"` still never covers
  git-guard. On Codex there is no `/config`: use `--confirmed` or the env var.
  A value in `~/.anti-hall/settings.json` counts for these keys like any other; nothing
  mechanically stops an agent from writing that file directly — the owner chose consent
  over an extra guard, so the skills tell the agent never to hand-edit a safety key there
  to get around the confirmation.
- **Legacy config is never deleted.** `~/.anti-hall/jev.json` (and any future
  per-feature config file the schema maps) keeps working as a fallback forever;
  `doctor --repair` and `/anti-hall:update` forward-migrate its values into
  `settings.json` once (idempotent, fail-open) via `companion/lib/migrations.js`, but
  the legacy file is left in place.
- **Codex parity**: the mirrored skill lives at
  `plugins/anti-hall/codex/skills/anti-hall-settings/SKILL.md` and drives the SAME CLI.
  Codex has no `AskUserQuestion` (the menu flow falls back to a numbered-choice prompt)
  and no plugin settings UI (no `userConfig` equivalent in the Codex manifest) —
  `~/.anti-hall/settings.json` via the skill/CLI is the only front door there, and it's the same file Claude Code's fallback path reads too.

### Every setting

Generated from `hooks/lib/settings-schema.js` (a hygiene test keeps this table and the schema in sync). "adv" = advanced (shown by `show --all`); "safety" = a risky `set`/`reset` needs `--confirmed` (see above).

| Setting | Default | Env | Notes |
|---|---|---|---|
| `autoHandover.enabled` | `true` | — | Write an automatic handover before context runs out. |
| `autoHandover.pct` | `85` [1..99] | `ANTIHALL_AUTO_HANDOVER_PCT` | Context-usage percent that triggers an automatic handover. |
| `autoHandover.maxTokens` | `0` [0..] | `ANTIHALL_AUTO_HANDOVER_MAX_TOKENS` | Opt-in absolute context-token ceiling that also triggers the handover, whichever of pct/maxTokens fires first; `0` (the default) = no ceiling — the real per-session window size (85% of it) is the only trigger unless a user explicitly sets this. |
| `autoHandover.nag` | `true` | — | Nag (remind) the user when a handover is due but not yet written. |
| `autoHandover.nagStepPct` | `5` [1..100] | — | Percent increments between successive handover nags. |
| `autoHandover.nagQuietMin` | `15` [1..] | — | Minutes to wait before repeating a handover nag. |
| `autoHandover.gateNewWork` | `true` | — | Post-handover new-work gate: once context is past the threshold and this session's handover is written, the agent sizes each new request before starting it and, above `gateBudgetPct`, offers to park it in the task list + handover (start after /compact or /clear) or proceed if you insist. Quick questions, the in-flight task, and DevSwarm workspace spawns pass through. |
| `autoHandover.gateBudgetPct` | `5` [1..50] | — | Context-window points a new request may use after the handover before the gate applies; also the one-shot backstop: one reminder (refresh the handover, offer to park the rest) once usage grows this far past where the handover was saved. |
| `autoHandover.decisivePrompt` | `true` | — | At a turn-ending Stop point once this session's handover exists and is fresh, end the reply with one prominent line naming the exact `/compact`/`/clear`/`/new` command — or, if stale, refresh the handover first. |
| `autoHandover.gateHousekeepingMarkers` | `''` (csv) | — | Extra comma-separated markers (case-insensitive substrings) that identify a scheduled/cron housekeeping prompt (e.g. a mailbox-wake or DevSwarm peer-check tick), on top of the built-in defaults (`"inbox tick"`, `"peer check"`, `"BROADCAST bug sweep"`) — a matching prompt never gets the post-handover new-work gate nudge. |
| `guards.mergeGate` | `false` | `ANTIHALL_MERGE_GATE` | Enable merge-readiness gate checks before merging. |
| `guards.shipitGate` | `false` | `ANTIHALL_SHIPIT_GATE` | Enable the ship-it workflow gate. |
| `guards.outputVerifyGuard` | `true` | `ANTIHALL_OUTPUT_VERIFY_GUARD` | Output-verification guard (blocks unverified completion claims). |
| `guards.outputVerifyOncePerTurn` | `true` | `ANTIHALL_OUTPUT_VERIFY_ONCE_PER_TURN` | Show the output-verify advisory once per turn per distinct pass/fail signal set instead of after every identical test re-run. false = every mixed result. |
| `guards.failureRootCauseNudge` | `true` | `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE` | Nudge toward root-cause analysis after a failure. |
| `guards.failureNudgeFilter` | `true` | `ANTIHALL_FAILURE_NUDGE_FILTER` | Cut root-cause-nudge noise: stay silent on expected exit-1 predicates (grep no-match, test, diff, git diff --quiet), on harness refusals, and after the first nudge in a turn. false = nudge on every failure again. |
| `guards.repoSelfDrift` | `true` | `ANTIHALL_REPO_SELF_DRIFT` | anti-hall's own repo-drift self-check hook. |
| `guards.stashGuard` safety | `false` | `ANTIHALL_STASH_GUARD` | SAFETY (confirm to change — see settings.js set/reset). Arm the git-stash guard in command-guard: block mutating `git stash` (also armed per-repo via .anti-hall/protected-stashes). |
| `guards.handoverCommitGuard` | `true` | `ANTIHALL_HANDOVER_COMMIT_GUARD` | git-guard: block a `git commit` whose paths include a session handover (`.anti-hall/handovers/**` at any depth, or `HANDOVER*.md`, `CONTINUE-HERE.md`, `*.continue-here.md` at the repo root). Handovers are local session state and are never committed; `git add` is never blocked, but `git add ... && git commit` in one command is checked (an ignored `.anti-hall/` is not a hit); removing a tracked handover and concluding a merge/cherry-pick/rebase are allowed; fails open if git cannot be queried, and says so when a command has too many commits to check. |
| `guards.gitGuardHeredocData` adv | `true` | `ANTIHALL_GIT_GUARD_HEREDOC_DATA` | git-guard: a heredoc whose consumer is not a shell is data, so its body is not scanned as commands - `cat <<EOF > notes.md`, `tee notes.txt <<EOF`, `git commit -F - <<EOF`, `git commit -m "$(cat <<EOF ...)"`, `gh pr create --body-file - <<EOF`. Applies only when every heredoc ends in a prose/data file (`.md`, `.txt`, `.rst`, `.log`, ...) or a git/gh message, every other command in the line is on a short allowlist (cat, tee, git, gh, echo, printf, cd, mkdir, wc, ...), and no write target is a script, extensionless file, dotfile, git hook or `.git`/`.husky`/`.ssh`/`.config` path. A body fed to bash/sh/eval/source/xargs/python/..., piped into a shell, or written to a file the same line runs stays scanned. A git beside it may use only commit/tag/notes/merge, status/log/diff/show/add or rev-parse with listed flags (no fetch/push/pull/clone/remote/submodule/config), and a gh only pr/issue/release create/edit/comment with listed flags and no `--`; any other flag keeps the bodies scanned. Credit trailers are checked either way. `false` = scan every body as shell. |
| `guards.gitignoreHint` | `true` | `ANTIHALL_GITIGNORE_HINT` | One-time (per project, every 7 days) SessionStart reminder to git-ignore `.anti-hall/` when it exists in a git repo and is not ignored; doctor always reports it. |
| `guards.allowAnthropicEnvKey` adv safety | `false` | — | SAFETY, home-settings only (no env or project override). Opt-in: let the speculation judge and Jev triage read `ANTHROPIC_API_KEY` from the environment. Default off: only the `anthropic_api_key` plugin option is used. |
| `guards.emitDedupe` | `true` | `ANTIHALL_EMIT_DEDUPE` | Deduplicate repeated hook-emit output. |
| `guards.gitAliasResolve` adv safety | `true` | `ANTIHALL_GIT_ALIAS_RESOLVE` | SAFETY (confirm to change — see settings.js set/reset). git-guard: resolve `git <alias>` through the repo/global git config (alias chains and `!shell` aliases included; loops resolve to nothing, as in git) and scan the command it really runs; block defining a git alias (`git config alias.x`, `-c alias.x=`, `GIT_CONFIG_VALUE_<n>`) or a shell `alias x=` whose body is a blocked git command; scan a call to a shell alias or function defined in the same command as the git command it forwards to. Builtin subcommands never spawn git. |
| `guards.gitReusedMessageCheck` adv safety | `true` | `ANTIHALL_GIT_REUSED_MESSAGE_CHECK` | SAFETY (confirm to change — see settings.js set/reset). git-guard: for a `git commit` with no `-m`/`-F`, read the message it would reuse (`-C`/`-c`/`--reuse-message`/`--reedit-message <rev>`, HEAD for `--amend`, `-t`/`commit.template`) and block it when it carries an AI self-credit trailer. A message reused verbatim (`-C`, `--no-edit`, a no-op editor such as `true`) always blocks; an editor-path commit blocks only when the command sets no real editor of its own. What an editor or commit hook writes is caught afterwards by the PostToolUse `--audit`. |
| `guards.editGuardAllow` adv safety | — | `ANTIHALL_EDIT_GUARD_ALLOW` | SAFETY (confirm to change — see settings.js set/reset). Extra allowed file globs for edit-guard (comma/colon separated). |
| `guards.allowSubagentMailbox` adv safety | `false` | `ANTIHALL_ALLOW_SUBAGENT_MAILBOX` | SAFETY (confirm to change — see settings.js set/reset). One-off allow for the subagent-mailbox command pattern. |
| `guards.reaperMatch` adv | — | `ANTIHALL_REAPER_MATCH` | Extra process-name pattern for the MCP session-end reaper. |
| `guards.reaperExclude` adv | — | `ANTIHALL_REAPER_EXCLUDE` | Excludes matching processes from the MCP reaper. |
| `guards.reaperCodexBroker` adv | `true` | `ANTIHALL_REAPER_CODEX_BROKER` | companion/mcp-reaper.js: REPORT (never kill) abandoned openai-codex plugin `app-server-broker.mjs` helper processes — listed only via proof of abandonment (--cwd gone, or no live claude/codex process, excluding the broker's own descendants, has a realpath'd cwd equal to/an ancestor of/a descendant of it), never by PPID (spawned detached on purpose). |
| `guards.reaperCodexBrokerMinAgeS` adv | `1800` [0..] | `ANTIHALL_REAPER_CODEX_BROKER_MIN_AGE_S` | Minimum age (seconds) before an abandoned-looking `app-server-broker.mjs` is eligible to be listed by the report-only class above (30min default; conservative since PPID gives no signal). |
| `guards.tasklistWorkThreshold` adv | `3` [1..] | `ANTIHALL_TASKLIST_WORK_THRESHOLD` | Minimum work items before tasklist-guard fires. |
| `guards.pruneCompletedTasksAfter` adv | `10` [1..] | `ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER` | Token savings (0.117.0): once completed/cancelled tasks exceed this count, task-guard emits a one-line advisory (never a block) to prune them via TaskUpdate status=deleted after recording them in the history ledger. |
| `guards.progressFreshMs` adv | `1800000` [0..] | `ANTIHALL_PROGRESS_FRESH_MS` | Freshness window (ms) for the progress file in tasklist-guard. |
| `guards.apiGuardThirdparty` adv | `false` | `ANTIHALL_API_GUARD_THIRDPARTY` | Also verify installed 3rd-party package APIs, not just stdlib/builtins. |
| `guards.modelRouting` | `strict` (strict/advisory/off) | `ANTIHALL_MODEL_ROUTING` | model-routing-guard (PreToolUse Agent/Task): strict blocks a mis-tiered spawn, advisory only warns, off disables the hook. |
| `guards.updateInSession` | `true` | `ANTIHALL_UPDATE_IN_SESSION` | model-routing-guard blocks a subagent spawn that runs anti-hall's own update (`skills/update/scripts/update.js` or `run /anti-hall:update`): `update.js` runs migrations, so `/anti-hall:update` runs it in the main session and command-guard allows that exact invocation. off allows delegating it. |
| `guards.noBlockingQuestions` adv | `off` (off/advise/block) | `ANTIHALL_NO_BLOCKING_QUESTIONS` | ask-guard (PreToolUse AskUserQuestion, Claude only): `advise` allows the question and adds the standing rule "take the recommended option, say which, continue; list destructive items as a non-blocking 'needs your OK' line"; `block` refuses the call unless the FIRST question's `header` or `question` text starts with `DESTRUCTIVE:` or `CREDENTIAL:` (case-sensitive; each marked call is logged to `~/.anti-hall/logs/ask-guard.ndjson`). In a DevSwarm child workspace it also says to send the question to the parent. Skip name `ask-guard`. Skills that deliberately ask the user (`settings`, `deadly-loop`, `deadly-loop-multi`, `ship-it`, `devswarm`) are not rewritten: in block mode those flows must use the `DESTRUCTIVE:`/`CREDENTIAL:` marker, or turn the setting off for them. |
| `guards.questionAgentsNote` adv | `true` | `ANTIHALL_QUESTION_AGENTS_NOTE` | ask-guard (PreToolUse AskUserQuestion, Claude only): when a question is asked while one or more background agents are provably in flight (agent-scan reads the transcript), add one advisory line naming how many and their short descriptions, saying they may act on an option before the answer arrives (pause them or tell them to wait). Silent when no agent is running or the count cannot be proven (unreadable or too-long transcript). Never blocks; independent of `guards.noBlockingQuestions`, so it works with that set to `off`. Skip name `ask-guard`. |
| `guards.sharedTreeAgentNote` adv | `true` | `ANTIHALL_SHARED_TREE_AGENT_NOTE` | swarm-guard (PreToolUse Agent/Task): advisory when a write-capable spawn without `isolation:"worktree"` starts while another write-capable agent is still running in the same working tree (they can commit each other's uncommitted changes). Silent for read-only types, isolated spawns, unknown state. Never blocks. |
| `guards.mergeSidePickAdvisory` adv | `true` | `ANTIHALL_MERGE_SIDE_PICK_ADVISORY` | merge-side-pick (PostToolUse + PreToolUse Bash, Claude + Codex): advisory on a push when a conflict was resolved by taking one side wholesale (`--ours`/`--theirs`, `-X ours|theirs`, `-s ours`) and no test run (npm test, node --test, pytest, go/cargo test, ...) followed in this session. Never blocks. |
| `guards.modelRoutingDeployFloor` | `sonnet` (sonnet/opus/off) | `ANTIHALL_MODEL_ROUTING_DEPLOY_FLOOR` | model-routing-guard floor for deploy/migration/rollback/production/secret/credential-shaped spawns: at or above the floor the spawn is never blocked; below it (or with no explicit model) it gets an advisory to use at least the floor. off restores the plain routing table. |
| `guards.apiGuard` | `true` | — | api-guard (PreToolUse Write/Edit): block fabricated stdlib/builtin APIs in written code. |
| `guards.speculationGuard` | `true` | — | speculation-guard (Stop): block a turn that ends on unverified hedged claims. |
| `guards.inferenceCheck` adv | `false` | `ANTIHALL_INFERENCE_CHECK` | speculation-guard (Stop): also block, once per reply, a confident causal claim with no hedge word ("caused by", "the root cause is", "because", "is due to", "stems from", "this means", "the culprit is", "that's why") when no tool output, observation-tool input (a command, a path, a search pattern), pasted fenced block or task notification in the last 1 MB of the transcript mentions the stated cause. Default off: 100% precision / 95% recall on the 84-case synthetic corpus (`tools/eval/inference-bench.js`), but on 3,276 real final replies it flagged 3.8%, mostly design rationale ("X because Y"), so field precision is far below 0.9. See "Unsupported confident inferences" below. |
| `guards.claimLedger` | `true` | — | claim-ledger (Stop, never blocks): record claims in the last reply that nothing in the session backs. |
| `guards.taskGuard` | `true` | — | task-guard (Stop): block stopping while tracked tasks are still open. |
| `guards.tasklistGuard` | `true` | — | tasklist-guard (Stop): require a task list / progress file for multi-step work. |
| `guards.tasklistNoTaskTools` adv | `reduced` (`reduced`/`full`/`skip`) | `ANTIHALL_TASKLIST_NO_TASK_TOOLS` | tasklist-guard nag form for a session positively known to lack task tools (today: a Codex session with no task-tool evidence in its transcript). `reduced` = no TaskCreate demand, list the tasks in the reply, one block per session; `full` = today's demand; `skip` = no nag. A Claude session with no evidence keeps the full demand: under `claude -p` the task tools are listed but deferred, so the tool list proves nothing. Evidence is structural (a TaskCreate/TaskUpdate/TodoWrite tool_use, a `deferred_tools*` attachment naming TaskCreate, or a `task_reminder` attachment), never a substring. Unset + `context.protocolLevel=full` = `full`. |
| `guards.stopNagBudgetPerPrompt` adv | `0` | `ANTIHALL_STOP_NAG_BUDGET` | Per-prompt cap on Stop blocks from task-guard and tasklist-guard (each counted separately), inside their session caps (5 and 3). `0` = off = today's behaviour. Keyed by the Stop payload `prompt_id`, else the last user entry uuid; no key = not applied. |
| `guards.scanThrottle` | `true` | `ANTIHALL_SCAN_THROTTLE` (deprecated alias `ANTI_HALL_SCAN_THROTTLE`; canonical wins) | scan-throttle (PreToolUse Bash): advise running heavy repo-wide scans at background priority (nice/taskpolicy); never rewrites the command. |
| `guards.silentAgentNudge` | `true` | `ANTIHALL_SILENT_AGENT_NUDGE` | silent-agent-nudge (Stop): nudge once, advisory-only, when a background Agent launch has no terminal notification and a stale/missing output_file past `silentAgentNudgeMin`. Never kills anything. |
| `guards.silentAgentNudgeMin` adv | `20` | `ANTIHALL_SILENT_AGENT_NUDGE_MIN` | Minutes of silence before silent-agent-nudge fires. |
| `guards.staleAgentStopNote` adv | `true` | `ANTIHALL_STALE_AGENT_STOP_NOTE` | stale-agent-stop-note (PreToolUse TaskStop, never blocks): one advisory line when TaskStop names an agent that was sent a message, or resumed, after its last report and has not reported since. Settings file + env only. |
| `guards.idleAgentSweep` | `true` | `ANTIHALL_IDLE_AGENT_SWEEP` | idle-agent-sweep (UserPromptSubmit, Claude + Codex, never blocks): once per user prompt, lists agents that finished but were never stopped (Claude: named teammates whose last report is an idle_notification with idleReason available/failed and no later SendMessage or TaskStop; Codex: multi_agent_v1 agents whose wait_agent result is completed/errored and that were never closed) and gives the exact TaskStop / close_agent call. Fires when guards.idleAgentSweepCount are idle or one has been idle guards.idleAgentSweepMin minutes. |
| `guards.idleAgentSweepCount` adv | `3` | `ANTIHALL_IDLE_AGENT_SWEEP_COUNT` | idle-agent-sweep fires when at least this many finished agents are idle and not stopped. |
| `guards.idleAgentSweepMin` adv | `15` | `ANTIHALL_IDLE_AGENT_SWEEP_MIN` | idle-agent-sweep also fires when any one finished agent has been idle at least this many minutes. |
| `guards.compactAdviceGuard` | `true` | — | compact-advice-guard (Stop): block once when a reply recommends /compact at low context or within `compactAdviceRecentTurns` turns of a compact. |
| `guards.compactAdviceRecentTurns` | `10` | — | Turns after a compact boundary during which a /compact recommendation is blocked; 0 = off. |
| `guards.compactAdviceMarginPct` adv | `10` | — | Points below `autoHandover.pct` that count as low context for compact-advice-guard. |
| `guards.compactDeclarationGuard` | `true` | — | compact-declaration-guard (PreToolUse — opt-in/default off in 0.116.0, re-enabled by default in 0.117.0): no new work in the turn after declaring SAFE TO COMPACT (reset by the next user message or a `RETRACT SAFE TO COMPACT` line). |
| `guards.injectionRepeatEvery` adv | `10` [0..] | `ANTIHALL_INJECTION_REPEAT_EVERY` | Turns between full re-injections of a static UserPromptSubmit reminder block (VERIFY-FIRST, the DEVSWARM PRIMARY dispatch-tier/top-fan-out-tier suffixes) after its first-turn/post-compact copy; `0` restores every-turn injection. |
| `guards.codexQuotaDetect` | `true` | `ANTIHALL_CODEX_QUOTA_DETECT` | codex-quota-detect (PostToolUse Agent): record a Codex quota/rate-limit exhaustion seen in a `codex:codex-rescue` result to `~/.anti-hall/codex-availability.json` so other lanes and sessions reuse it; a reset given as an ordinal date ("try again at Oct 3rd, 2026 ...") is parsed, an unparseable limit message falls back to a 6 h cooldown, and codex-nudge stays quiet while a record is live. |
| `guards.allowReadOnlyVerify` | `true` | `ANTIHALL_ALLOW_READ_ONLY_VERIFY` | command-guard narrow allow: the coordinator may run ONLY these shapes inline, each piped to `tail`/`head`/`wc`/`grep -c`/`grep -m N`: `python3 -m pytest -q <one file>`, `node --test <1-2 files>`, `ctest -R <name>`, `<cc> -fsyntax-only`, `git clone --depth 1 <https-url> <scratchpad/tmp dir>`, or a non-heavy command with `--check`/`--dry-run`/`--list` (the interpreter-script form is `guards.allowReadOnlyVerifyScripts`). No other segment left unaccounted for, no write redirect outside the scratchpad/tmp; everything else goes to a subagent. |
| `guards.allowReadOnlyVerifyScripts` | `true` | `ANTIHALL_ALLOW_READ_ONLY_VERIFY_SCRIPTS` | command-guard read-only verify, script form: `<python*|node|ruby|perl|php> <existing script file> --check|--dry-run|--list` piped to a bounded sink runs inline in the main thread. Inline code (`-c`/`-e`/`-m`/`--eval`), a stdin/heredoc script, wrapper verbs, env-assignment prefixes and heavy remaining arguments never qualify. Requires `guards.allowReadOnlyVerify`. |
| `guards.stopHookVersionDowngrade` adv | `true` | `ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE` | Downgrade nudge-class Stop blocks (silent-agent-nudge, tasklist-guard, parent-gate plain NEGLECT) to advisory when `installed_plugins.json` registers a newer anti-hall than the running session. Never safety guards. |
| `guards.stopAck` adv | `true` | `ANTIHALL_STOP_ACK` | Honor a per-signature session ack in `~/.anti-hall/stop-ack/` for silent-agent-nudge and tasklist-guard after the user confirms a false positive. |
| `guards.projectCommandAllow` | `true` | `ANTIHALL_PROJECT_COMMAND_ALLOW` | command-guard per-project allowlist: a repo may declare its own sanctioned exact commands (e.g. a deploy script that must never be delegated) in `<repo-toplevel>/.anti-hall/command-allow.json`, run inline in the MAIN THREAD ONLY (never for a subagent). Default empty config means no behavior change; `false` disables the carve-out entirely. |
| `guards.projectEditAllow` | `true` | `ANTIHALL_PROJECT_EDIT_ALLOW` | edit-guard per-project doc-edit allowlist: `<repo-toplevel>/.anti-hall/edit-allow.json` (`{"paths":["docs/**","PLAN.md"]}`) lists repo-relative globs the MAIN THREAD may Edit/Write directly. Applies only after `settings.js trust-edit-allow <repo> --confirmed` records the sha256 of the file in `~/.anti-hall/trusted-edit-allow.json`; any edit revokes trust; a symlinked file is refused. Never matches outside the repo, `.git`, `.anti-hall`, `.claude`, `.codex`, hook config or `~/.claude`; absolute, `..` and match-everything globs are ignored. Doctor reports untrusted/changed files. |
| `guards.allowPlainPush` | `true` | `ANTIHALL_ALLOW_PLAIN_PUSH` | command-guard "allow plain push": in the MAIN THREAD ONLY, lets `git add`/`git commit`/a plain `git push [-u|--set-upstream] [remote] [ref]` (`-u`/`--set-upstream` is the only added flag and needs BOTH an explicit remote and an explicit ref; remote omitted or a configured remote NAME from `git remote` — a path/URL destination never qualifies, fail-closed; ref omitted, `HEAD`, or the current branch only — resolved fresh via `git symbolic-ref --short HEAD`, fail-closed if unresolvable), and `&&`/`;` chains made up only of those three, run inline instead of being delegated. `--force`/`-f`/`--force-with-lease`/`--force-if-includes`/`--mirror`/`--delete`/`-d`/`--all`/`--tags`/`+refspec`/`src:dst` to another branch, any other chained segment, and pipes/redirects/subshells stay exactly as blocked as before — except three shapes: a `HEAD:<current>` / `HEAD:refs/heads/<current>` refspec (same destination as the bare form), a trailing `2>&1`, and ONE final `| tail [-n] N` / `| head [-n] N` output filter. `git-guard.js` keeps its own independent force-push/AI-credit checks, untouched by this carve-out. |
| `guards.allowGcloudReads` | `true` | `ANTIHALL_ALLOW_GCLOUD_READS` | command-guard narrow read-only Google Cloud access: in the MAIN THREAD ONLY, lets the cloud CLI token-printing command, read-style verbs (describe, list, get-iam-policy, read) with JSON, YAML or value output into a bounded sink or jq, and a token-authorized silent HTTP GET with an optional Bearer header to an https URL on googleapis.com or a subdomain run inline. Mutating verbs, other HTTP methods, request bodies, uploads, output-to-file flags, redirects, proxies, IP literals, @file arguments and chained commands stay blocked. |
| `guards.allowBackgroundScratchScripts` | `true` | `ANTIHALL_ALLOW_BACKGROUND_SCRATCH_SCRIPTS` | command-guard background scratch scripts: in the MAIN THREAD ONLY, a Bash call with `run_in_background: true` may run ONE segment `<interpreter> <script file> [args…]` (python3, node, sh or bash) when the file is an existing regular file inside the session scratchpad or a tmp root (`os.tmpdir()`, `/tmp`, `/private/tmp`; realpath-checked, so a symlink out is refused). No interpreter option before the file (`-c`/`-e`/…), no env prefix or wrapper, no chaining/pipes, no `$`/backtick/backslash/process substitution, no stdin redirect, no write redirect outside the scratchpad/tmp. Foreground runs keep the normal rules; Monitor is unchanged. Each such run counts toward the main-thread work window (`guards.coordinatorWorkWindowMinutes`). |
| `guards.coordinatorWorkWindowMinutes` adv | `10` [0..] | `ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES` | Main thread only: successful state-changing Bash calls (WORK: state-changing git, gh mutations, Bash writes into non-notes repo files, scratch/tmp/.anti-hall script runs, other text-script runs except tracked-and-clean project scripts, package-manager/system tools and old `~/.local/bin`, `~/Library` or `~/.claude/plugins` tools, inline `-c`/`-e` code that writes files or runs state-changing git/gh) are counted over this many minutes. In a non-git project only coordinator-writable or fresh scripts count; an old script there is not WORK. Set nudgeAt and blockAt to 0 to record only. 0 = feature off. |
| `guards.coordinatorWorkNudgeAt` adv | `4` [0..] | `ANTIHALL_COORDINATOR_WORK_NUDGE_AT` | One advisory note each time the window's WORK count reaches this. 0 = no nudge. |
| `guards.coordinatorWorkBlockAt` adv | `7` [0..] | `ANTIHALL_COORDINATOR_WORK_BLOCK_AT` | The Nth WORK Bash call within the window is blocked. Recovery commands (git am/rebase/cherry-pick/revert `--abort`\|`--quit`, merge `--abort`, stash pop/apply) and loosely matched inline code are counted but never blocked. Skip key `coordinator-work-guard`. 0 = no block. |
| `guards.coordinatorWorkMaxEntries` adv | `50` [1..] | `ANTIHALL_COORDINATOR_WORK_MAX_ENTRIES` | Safety cap on stored window timestamps per session. |
| `guards.bashEditParity` adv | `true` | `ANTIHALL_BASH_EDIT_PARITY` | command-guard applies edit-guard's verdict to Bash writes (`sed -i`, `perl -i`, `tee`, `cp`, `mv`, `>`/`>>` redirects, literal `python -c`/`node -e` open-for-write paths) into repo files in the main thread. git verbs and trusted (redirect-free) project command-allow matches are never blocked by it. Also off when `safety.editGuard` is off or edit-guard is skipped. Both hosts (tested with Claude and Codex payload shapes). |
| `guards.shellWriteChecks` adv | `true` | `ANTIHALL_SHELL_WRITE_CHECKS` | api-guard and ship-it-guard also run on Bash (both hosts): shell-write targets go through ship-it-guard's existence gate (scratchpad/tmp-outside-a-repo writes excluded), and the visible text of a heredoc/`echo`/`printf` write into a .py/.js/.ts file through api-guard. Unparseable forms are allowed. `guards.apiGuard` / `guards.shipitGate` still switch each guard. |
| `guards.dispatchDemand` adv | `true` | `ANTIHALL_DISPATCH_DEMAND` | Per-turn `DISPATCH NOW in parallel: #id "subject", …` demand (task-tracker) and task-guard IDLE NEGLECT count in-flight agents PER TASK from this session's transcript (an agent whose description names `#id` covers it). `false` removes the per-turn line and restores task-guard's legacy blanket heartbeat rule. Metrics: `scripts/dispatch-report.js`. |
| `guards.taskGuardOwnerBlockedMarker` adv | `true` | `ANTIHALL_TASK_GUARD_OWNER_BLOCKED_MARKER` | task-guard IDLE NEGLECT: honor an explicit owner-blocked marker (`metadata.blockedOn`/`blockedOn` === `owner`\|`user`\|`human`\|`external`, or an "OWNER:"/"OWNER DECISION" subject prefix) as non-dispatchable, instead of requiring a fake `blockedBy` dependency to silence the nag. `false` reverts to pre-marker behavior (only a real `blockedBy` id suppresses idle-neglect). |
| `guards.idleNeglectMinPriority` adv | `p1` (p0/p1/p2/p3) | `ANTIHALL_IDLE_NEGLECT_MIN_PRIORITY` | task-guard IDLE NEGLECT urgency floor: a pending/unowned/unblocked task nags only when its priority is at or above (numerically ≤) this rank; anything below (e.g. P2/P3 when the floor is P1) is non-nagging backlog. Missing/unrecognized priority is always treated as P1. |
| `guards.maxParallelDispatch` adv | `0` [0..] | `ANTIHALL_MAX_PARALLEL_DISPATCH` | Hard cap on concurrently-running background agents the DISPATCH NOW line / task-guard IDLE NEGLECT will demand up to. `0` (default) = the existing dynamic cap (min(16, cores-2)). |
| `guards.idleNeglectProvenOnly` adv | `true` | `ANTIHALL_IDLE_NEGLECT_PROVEN_ONLY` | task-guard IDLE NEGLECT blocks only when a dispatchable task is uncovered under every placement of the running agents that name no task (dispatchable > unmapped agents). The per-turn DISPATCH NOW line is unchanged. false = also block on the in_progress-first estimate. |
| `guards.idleNeglectAgentMaxAgeMin` adv | `30` | `ANTIHALL_IDLE_NEGLECT_AGENT_MAX_AGE_MIN` | task-guard IDLE NEGLECT, proven count only: a running agent that names no task stops counting as cover once its newest sign of life (launch, SendMessage resume, pending teammate message, output-file write) is older than this many minutes, or when it was launched before the earliest uncovered task was created / last set pending or in_progress (it cannot be working on a task that did not exist). Unknown age or unknown task time = the agent still counts. 0 = never age out. |
| `safety.gitGuard` safety | `true` | `ANTIHALL_GIT_GUARD` | git-guard: block force-push and AI self-credit in commits and gh pr/issue/release bodies. |
| `safety.commandGuard` safety | `true` | `ANTIHALL_COMMAND_GUARD` | command-guard core: make the coordinator delegate heavy commands (build/test/deploy/push). Its data-safety sub-guards (DevSwarm read/send/mailbox, armed stash guard) stay on. |
| `safety.editGuard` safety | `true` | `ANTIHALL_EDIT_GUARD` | edit-guard core: make the coordinator delegate file edits outside its own plan/state/handover files. |
| `safety.swarmGuard` safety | `true` | `ANTIHALL_SWARM_GUARD` | swarm-guard: block agent spawns past the spawn-rate cap or under critical memory pressure. |
| `context.verifyFirstSession` | `true` | — | verify-first-full (SessionStart): inject the full verify-first protocol (also re-injected after compaction). |
| `context.verifyFirstOrchestration` | `true` | — | verify-first-orch (SessionStart): inject the orchestration discipline for the main thread. |
| `context.protocolLevel` | `compact` (`compact`/`full`) | `ANTIHALL_PROTOCOL_LEVEL` | Size of the injected verify-first and orchestration text. `compact` (default): a short core with every load-bearing clause inline, pointing at `PROTOCOL.md`; `full`: today's complete text on every channel, byte for byte (the one-key rollback). |
| `context.codexOrchFullOn` | `session` (`session`/`spawn`) | `ANTIHALL_CODEX_ORCH_FULL_ON` | **Experimental, Codex only (>= 0.129, hooks trusted).** `session` (default) = full orchestration rules at SessionStart, as today. `spawn` = SessionStart sends the compact core + compact orchestration lines and the full rules arrive once per context epoch on the first `spawn_agent` call (PreToolUse additionalContext, surfaced to the model by Codex 0.160). Needs positive Codex evidence, otherwise `session`; ignored under `protocolLevel=full`; a DevSwarm Primary always gets the full text at SessionStart. The spawn tool's PreToolUse `tool_name` is `collaborationspawn_agent` on Codex 0.160 (live probe, `.anti-hall/plans/codex-pretooluse-context-probe.md` "Spawn probe"); the hook fires and the context reaches the parent as a developer message. Settings/env only. |
| `context.orchFullOn` | `auto` (`auto`/`spawn`/`session`/`off`) | `ANTIHALL_ORCH_FULL_ON` | When the full orchestration rules A-N are sent under `compact`: `auto` (default) = `session` = inline at SessionStart next to the compact core; `spawn` = **experimental, opt-in**: compact lines at SessionStart and the full text once on the first Agent/Task/Workflow spawn of each context epoch, only with positive Claude evidence (`--host=claude` in the Claude hooks.json), otherwise coerced to `session`; spawn delivery is not yet verified live, so it is not the default; `off` = compact lines only. Ignored under `full`; a DevSwarm Primary always gets the full text at SessionStart. Settings/env only (no `/config` row). |
| `context.verifyFirstTurn` | `true` | — | verify-first (UserPromptSubmit): the short per-turn verify-first nudge. |
| `context.verifyFirstSubagent` | `true` | — | verify-first-subagent (SubagentStart): inject the protocol into every subagent. |
| `context.taskTracker` | `true` | — | task-tracker (UserPromptSubmit): the task-list discipline directive and per-turn reminder. |
| `context.handoverResume` | `true` | — | handover-resume (SessionStart): point a fresh or compacted session at the newest handover. |
| `context.defectNudge` | `true` | — | defect-nudge (SessionStart): the once-a-day note about the defect channel. |
| `context.dedupeWindowMin` adv | `20` [0..] | `ANTIHALL_DEDUPE_WINDOW_MIN` | Fallback per-session suppression window (minutes) for repeated UserPromptSubmit injection blocks (LIMIT CONSERVATION, TASK-LIST, DEVSWARM COMMS OVERRIDE, DEVSWARM WORKSPACES) when a burst of queued prompts is delivered in one turn and the transcript cannot confirm the earlier copy was already read; content that changed always re-emits. `0` disables emit-dedupe entirely (same as `guards.emitDedupe=false`). Suppression counts surface in `/anti-hall:doctor`. |
| `context.injectGate` | `true` | `ANTIHALL_INJECT_GATE` | Master switch of the engine's injection gate: the hooks that re-send the same context every turn (limit conservation, task-tracker, the DevSwarm comms-override line, swarm-guard's shared-tree advisory) are injected only when the model does not already hold it. Off: every hook's output passes through unchanged. Counters: `ah-engine metrics` (`inject_*`), per session `ah-engine ctl gate`. |
| `context.roleGuard` | `true` | `ANTIHALL_ROLE_GUARD` | Refuses an `ah-engine` verb the caller's role may not run (role matrix in `engine/defaults/roles.toml`: owner-level verbs main session only, a workspace child acts on itself only); applies to the PreToolUse Bash check and the command line. |
| `context.roleNote` | `true` | `ANTIHALL_ROLE_NOTE` | SessionStart / SubagentStart note telling the session its role and the engine verbs it may use, pointing at the `anti-hall:engine` skill. |
| `context.injectGateLimit` | `true` | `ANTIHALL_INJECT_GATE_LIMIT` | Cut 1: the limit-conservation directive on a usage-band or reset-window change, else a short keepalive. |
| `context.injectGateLimitEvery` adv | `10` [1..] | `ANTIHALL_INJECT_GATE_LIMIT_EVERY` | Turns between keepalives of an unchanged limit-conservation directive. |
| `context.injectGateTask` | `true` | `ANTIHALL_INJECT_GATE_TASK` | Cut 2: task-tracker's long form always passes; its short reminder and an unchanged freshness note pass every N turns. |
| `context.injectGateTaskEvery` adv | `10` [1..] | `ANTIHALL_INJECT_GATE_TASK_EVERY` | Turns between short task-tracker reminders and unchanged freshness notes. |
| `context.injectGateComms` | `true` | `ANTIHALL_INJECT_GATE_COMMS` | Cut 3: the DevSwarm comms-override line and the workspace-title instruction once per session, when changed, and as a keepalive. |
| `context.injectGateCommsEvery` adv | `30` [1..] | `ANTIHALL_INJECT_GATE_COMMS_EVERY` | Turns between keepalives of the unchanged comms-override line. |
| `context.injectGateSwarm` | `true` | `ANTIHALL_INJECT_GATE_SWARM` | Cut 4: swarm-guard's shared-tree advisory when new or changed, and again only after N turns. |
| `context.injectGateSwarmEvery` adv | `20` [1..] | `ANTIHALL_INJECT_GATE_SWARM_EVERY` | Turns between repeats of an unchanged shared-tree advisory. |
| `maintenance.repairOnReload` | `true` | `ANTIHALL_REPAIR_ON_RELOAD` | repair-on-reload (SessionStart/UserPromptSubmit): re-apply safe doctor repairs after a plugin update. |
| `maintenance.progressPrune` | `true` | — | progress-prune (SessionStart): archive stale per-session progress files into the history ledger. |
| `maintenance.precompactSnapshot` | `true` | — | precompact-snapshot (PreCompact): write a mechanical continuation snapshot before compaction. |
| `maintenance.taskLifecycleLog` | `true` | — | task-lifecycle-log (TaskCreated/TaskCompleted): append task events to the per-session history ledger. |
| `maintenance.sessionEndReaper` | `true` | `ANTIHALL_SESSION_END_REAPER` (deprecated alias `ANTI_HALL_SESSION_END_REAPER`; canonical wins) | session-end-mcp-reaper (SessionEnd): kill orphaned MCP-server processes this session left behind. |
| `agents.tracker` | `true` | `ANTIHALL_AGENT_TRACKER` | agent tracker (engine job `agent_tick`): follow every agent, raise hung / looping / token-waste / drift / stale-heartbeat / no-wake-path signals; off, a tick does nothing. |
| `agents.reminders` | `true` | `ANTIHALL_AGENT_REMINDERS` | agent-reminders (UserPromptSubmit, PostToolUse): deliver the tracker's queued reminders to the agent that owns them; off, signals are recorded but nothing is queued. |
| `agents.ownerNotify` | `false` | `ANTIHALL_AGENT_OWNER_NOTIFY` | agent tracker owner notices: also append hung / looping / token-waste advisories to the owner notices file. |
| `versionAlerts.antiHall` | `true` | `ANTIHALL_VERSION_ALERT` | Alert when a newer anti-hall version is available. |
| `versionAlerts.claudeCli` | `true` | `ANTIHALL_CLAUDE_CLI_VERSION_ALERT` | Alert when a newer Claude CLI version is available. |
| `versionAlerts.devswarm` | `true` | `ANTIHALL_DEVSWARM_VERSION_ALERT` | Alert when a newer DevSwarm/hivecontrol version is available. |
| `updates.quiet` | `false` | `ANTIHALL_UPDATE_QUIET` | Suppress update output (for scripted capture). |
| `updates.allowCachePrune` | `true` | `ANTIHALL_ALLOW_CACHE_PRUNE` | Enables the opt-in `doctor --prune-cache` verb. Never automatic (not run by update.js, the supervisor, a cron, SessionStart or any hook). Without `--confirmed` it only lists the old `~/.claude/plugins/cache/anti-hall/anti-hall/<semver>/` dirs it would remove and their total size; `--confirmed` removes them and logs each removal. Always keeps the newest 3, the `installPath` registered in `installed_plugins.json`, every version a live process runs from (process cwd or argv), the running version, and anything unparseable. Symlinks and paths outside that root are refused; if the live-process scan is unavailable nothing is removed. `false` disables the verb. |
| `updates.reconcileBudgetMs` adv | `60000` [0..] | `ANTIHALL_RECONCILE_BUDGET_MS` | Time budget (ms) for the reconcile step during update; 0 = unlimited. |
| `updates.postpullBudgetMs` adv | `90000` [0..] | `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS` | Time budget (ms) for the post-pull update sweep; 0 = unlimited. |
| `updates.sweepBudgetMs` adv | `20000` [0..] | `ANTIHALL_UPDATE_SWEEP_BUDGET_MS` | Overall time budget (ms) for the update sweep. |
| `limitConserve.mode` | `auto` (auto/on/off) | `ANTIHALL_LIMIT_CONSERVE` | Force conservation mode on/off, or auto-detect from the OMC usage cache. |
| `limitConserve.threshold` | `85` [1..99] | `ANTIHALL_LIMIT_THRESHOLD` | Usage percent that triggers conservation mode. |
| `limitConserve.accountCheck` adv | `true` | `ANTIHALL_LIMIT_ACCOUNT_CHECK` | Guard against stale usage-cache readings after an account switch. |
| `jev.enabled` | `false` | `ANTIHALL_JEV` | Enable Jev (ANTIHALL_JEV=0 always force-disables regardless of this). |
| `jev.transport` | `vercel` (vercel/typesafe) | — | Vercel AI Gateway passthrough (default) or a direct TypeSafe API call. |
| `jev.fallbackTransport` | `none` (none/vercel/typesafe) | — | Automatic backup vendor: when the primary transport times out, has a network error, returns 5xx (incl. 529), 402 or 429 (or a 400/403 naming insufficient balance), ONE retry goes to this transport inside the same time budget; 401/403 and other 4xx never fall back (a bad primary key must surface). Equal to `jev.transport` = off. Needs its OWN vendor-bound key (plugin option `jev_vercel_api_key` / `jev_typesafe_api_key`, or that vendor's key file with `jev.allowLegacyKeyRead`; keys are never sent to another vendor) and a per-vendor circuit breaker skips a vendor for 5 min after 3 consecutive eligible failures (both open = Jev skipped, no double timeouts). NOT full redundancy: both routes very likely reach the same TypeSafe model (inferred from the model ids and identical answers on a 40-item test, unconfirmed), so it covers the direct account's balance/quota or an endpoint outage, probably not a model outage; the guards then use their built-in rules as when Jev is off. With a fallback on, decision text can reach the second vendor. Decision rows record `transport` and `fellBack`. Set with `jev-setup.js enable --fallback <vercel\|typesafe\|none>` or `settings.js set jev.fallbackTransport <value>`. |
| `jev.judgeModel` | `haiku` | `ANTIHALL_JUDGE_MODEL` | Model alias used for speculation-judge / jev-triage LLM calls (an alias, never a pinned version: the CLI and API resolve it to the latest model). |
| `jev.judgeBackend` adv | `api` (api/cli/auto) | `ANTIHALL_JUDGE_BACKEND` | How speculation-judge reaches the model. `api` = Anthropic API with the `anthropic_api_key` plugin option; `cli` = the local `claude -p` CLI on your own Claude login, no API key (no tools, no MCP servers, no settings files, all hooks disabled; about 5–6 s per turn end, measured); `auto` = `api` when a key is visible, else `cli`. Fail-open in every mode. |
| `jev.speculationBackend` adv | `haiku` (haiku/jev/cascade) | `ANTIHALL_JEV_SPECULATION_BACKEND` | Which backend answers the semantic speculation question when `jev.semanticJudge` is on. `haiku` = the judge asks the model (`jev.judgeModel` through `jev.judgeBackend`), except while Jev's own `speculation` integration is `on`; `cascade` = as `jev`, with the Jev-first cascade switched on for `speculation`; `jev` = the judge never asks the model and speculation-guard's Jev path is the only semantic check. Answered by the engine; the Node fallback keeps `haiku`. |
| `jev.triageBackend` adv | `jev` (jev/haiku/cascade) | `ANTIHALL_JEV_TRIAGE_BACKEND` | Which backend labels mesh messages in `ah-engine jev triage`. `jev` = Jev first, the Anthropic API fills a missing label when a key is visible (the Node worker's behaviour); `cascade` = as `jev`, then a label Jev left open is re-judged by the model shown Jev's answer; `haiku` = the model alone through `jev.judgeBackend` (the local `claude -p` takes about 3–4 s per message, so the triage budget must allow it). |
| `jev.cascade` adv | `true` | `ANTIHALL_JEV_CASCADE` | Global kill switch of the Jev-first cascade: `false` means no Jev answer is ever re-judged by the model, whatever the per-integration `jevCascade.*` switches say. |
| `jev.cascadeShowJevAnswer` adv | `true` | `ANTIHALL_JEV_CASCADE_SHOW_JEV_ANSWER` | Whether the model that re-judges an unsure Jev answer is shown Jev's answer and confidence (`true`) or only the evidence (`false`), so anchoring can be A/B tested. |
| `jev.semanticJudge` | `false` | `ANTIHALL_SEMANTIC_JUDGE` | Enable the semantic speculation-judge hook (off = hook no-ops). |
| `jev.allowLegacyKeyRead` adv safety | `false` | — | SAFETY, home-settings only (`~/.anti-hall/settings.json`; no env or project override). Opt-in: read the Jev key from `AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY` env vars and the key file. Default off: only the `jev_api_key` plugin option is used. Needed for background tools and Codex (see "Where a stored key is visible"). |
| `jev.genericKeyVendor` adv safety | `vercel` (vercel/typesafe) | — | SAFETY, home-settings only (`~/.anti-hall/settings.json`; no env, `/config` or legacy-file route). The ONE vendor the legacy generic `jev_api_key` plugin option and `jev.keyFile` are bound to: they carry no vendor name, so they are never sent to any other vendor, whatever `jev.transport` / `jev.fallbackTransport` say (`jev.transport` does NOT decide this, because `enable --transport` rewrites it). Vendor-named keys (`jev_vercel_api_key`, `jev_typesafe_api_key`) need no binding. Change only with `jev-setup.js bind-generic-key --vendor <v>` (a deliberate human command). An existing install with a typesafe transport and a generic key is never auto-bound: it stays on `vercel`, so the generic key is refused for typesafe, and a one-time notice says how to bind or to enter a typesafe key. |
| `jev.keyFile` adv | — | — | Credential key-file path (default depends on transport). |
| `jev.timeoutMs` adv | `1500` [1..3000] | — | Per-call timeout (ms), capped at 3000. |
| `jev.confidenceThreshold` adv | `0.85` [0..1] | — | Minimum confidence for a Jev answer to be trusted by callers. |
| `jev.triage` adv | `true` | — | Message-triage labeling once Jev is enabled. |
| `jev.triageUrgentThreshold` adv | `0.9` [0..1] | — | Confidence threshold for the urgent triage label. |
| `jev.budget.mode` | `unlimited` (unlimited/watch) | — | Jev spend: no limit, or warn when over budget (never auto-disables). |
| `jev.budget.usdPerDay` | — (>0) | — | optional: daily USD spend threshold, used only when budget.mode=watch. |
| `jev.budget.usdPerWeek` | — (>0) | — | optional: weekly USD spend threshold, used only when budget.mode=watch. |
| `jev.weeklyNotice` | `true` | — | Once-a-week SessionStart scorecard notice naming one integration worth promoting or turning off (Jev enabled only). |
| `jev.audit.snippets` adv | `false` | `ANTIHALL_JEV_AUDIT_SNIPPETS` | Store a redacted ~200-char snippet for decisions Jev changed (off by default: privacy). |
| `jev.logRotatedFiles` adv | `10` | — | Rotated generations kept for `jev-assist.ndjson` (2MB each) and `jev-triage.ndjson` (1MB each); 10 ≈ 20 days of decision rows. |
| `jev.rollupRetentionDays` adv | `0` | — | Days of daily rollups (`~/.anti-hall/logs/jev-daily/<day>.json`) to keep; 0 keeps all, only an explicit N > 0 removes older ones. |
| `jev.budget.minCreditUsd` | — (>0) | — | optional: warn (once a day, budget.mode=watch only) when the gateway credit balance drops below this USD amount. |
| `jevIntegrations.speculation` | `on` (on/shadow/off) | — | Is this claim unsupported speculation (add-block trust). |
| `jevIntegrations.triage` | `on` (on/shadow/off) | — | Mesh message urgency/kind labeling (advisory trust). |
| `jevIntegrations.newRequest` | `shadow` (on/shadow/off) | — | Classify a prompt as new-request/follow-up/correction/question (advisory trust). |
| `jevIntegrations.claimLedger` | `shadow` (on/shadow/off) | — | Is a flagged claim genuinely unsupported by evidence (relax-block trust). |
| `jevIntegrations.outputVerifyGuard` | `shadow` (on/shadow/off) | — | Does this test-runner output actually indicate a pass (advisory trust). |
| `jevIntegrations.gitGuardSelfCredit` | `shadow` (on/shadow/off) | — | Does this commit/PR message contain paraphrased AI self-credit (add-block trust; never relaxes git-guard). |
| `jevIntegrations.modelRouting` | `shadow` (on/shadow/off) | — | Is this agent-spawn task actually mechanical (relax-block trust). |
| `jevIntegrations.tasklistTrivial` | `shadow` (on/shadow/off) | — | tasklist-guard: is this session a genuinely non-trivial, multi-part effort (relax-block trust; 1.5 s cap, fail-open). |
| `jevIntegrations.codexNudgeSubstantial` | `shadow` (on/shadow/off) | — | codex-nudge: are these file edits genuinely substantial, not just formatting (relax-block trust; 1.5 s cap, fail-open). |
| `jevIntegrations.mergeGateHedge` | `shadow` (on/shadow/off) | — | Does this text hedge on merge-readiness (relax-block trust; askDetached fire-and-forget in shadow). |
| `jevIntegrations.parentGateQuestion` | `shadow` (on/shadow/off) | — | Is this unread child message really a question awaiting a reply (add-block trust; cache-only, zero network). |
| `jevIntegrations.supervisorBlockerLabel` | `shadow` (on/shadow/off) | — | Is a stale child waiting-on-parent or genuinely wedged (advisory trust; cache-only, zero network). |
| `jevIntegrations.findingDedup` | `on` (on/shadow/off) | — | Do two deadly-loop TRIO findings describe the same underlying issue, for advisory duplicate-grouping (advisory trust); 65/65 correct at confidence ≥0.85 on a 30-day, 3-project offline benchmark. |
| `jevIntegrations.postHandoverGate` | `off` (on/shadow/off) | — | Does this new request fit in the remaining post-handover context budget (advisory trust; askDetached fire-and-forget). Default off: an offline benchmark (n=299) found park-recall 17.6% vs 28.8% for the agent's own size judgment plus the measured budget backstop, no gain over that baseline. |
| `jevIntegrations.speculationFramed` | `shadow` (on/shadow/off) | — | When a deterministic speculation-guard hedge hit sits under a FRAMED heading/line prefix (Expected/Plan/"Should be \<verb\>:"/Unverified/"not yet measured"), is it a stated expectation/plan or an unverified claim presented as fact (relax-block trust: Jev may only turn the framed hit's block into a non-block; an unframed hedge never consults Jev and always blocks). |
| `jevIntegrations.dispatchTier` | `on` (on/shadow/off) | — | Recommend `workspace` / `workflow` / `subagent` per task on the DISPATCH NOW line (advisory; never blocks; the Primary makes the final call). Asked askDetached when a task's text changes. Metrics: `scripts/dispatch-report.js`. |
| `jevIntegrations.devswarmOnBrief` | `on` (on/shadow/off) | — | DevSwarm supervision recommendation: is a child's off-scope work off its brief. Annotates the off-scope warning; never suppresses, blocks or kills. `shadow` = logged only. |
| `jevIntegrations.devswarmExtraSanctioned` | `on` (on/shadow/off) | — | Recommendation: did the user ask for this off-scope work (the child's recent prompts, secrets scrubbed; threshold 0.9). An explicit `scope add` always wins. |
| `jevIntegrations.devswarmWaitKind` | `on` (on/shadow/off) | — | Recommendation: is an idle/stalled child stuck, or waiting on CI, the owner or a peer. Annotates the idle/stall warning. |
| `jevIntegrations.devswarmLoop` | `on` (on/shadow/off) | — | Recommendation: is a busy child looping on its step (input includes the burn figure; threshold 0.9). Annotates a burn/stall warning, or adds an advisory `loop` warning. |
| `jevIntegrations.devswarmStepMap` | `on` (on/shadow/off) | — | Recommendation: which step a heartbeat summary without --step describes (threshold 0.8); shows as `~N` only while the child never reported a step. |
| `jevCascade.speculation` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_SPECULATION` | Re-judge a `speculation` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.triage` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_TRIAGE` | Re-judge a `triage` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.newRequest` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_NEW_REQUEST` | Re-judge a `newRequest` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.claimLedger` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_CLAIM_LEDGER` | Re-judge a `claimLedger` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.outputVerifyGuard` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_OUTPUT_VERIFY_GUARD` | Re-judge a `outputVerifyGuard` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.gitGuardSelfCredit` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_GIT_GUARD_SELF_CREDIT` | Re-judge a `gitGuardSelfCredit` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.modelRouting` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_MODEL_ROUTING` | Re-judge a `modelRouting` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.tasklistTrivial` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_TASKLIST_TRIVIAL` | Re-judge a `tasklistTrivial` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.codexNudgeSubstantial` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_CODEX_NUDGE_SUBSTANTIAL` | Re-judge a `codexNudgeSubstantial` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.mergeGateHedge` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_MERGE_GATE_HEDGE` | Re-judge a `mergeGateHedge` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.parentGateQuestion` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_PARENT_GATE_QUESTION` | Re-judge a `parentGateQuestion` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.supervisorBlockerLabel` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_SUPERVISOR_BLOCKER_LABEL` | Re-judge a `supervisorBlockerLabel` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.findingDedup` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_FINDING_DEDUP` | Re-judge a `findingDedup` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.postHandoverGate` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_POST_HANDOVER_GATE` | Re-judge a `postHandoverGate` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.speculationFramed` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_SPECULATION_FRAMED` | Re-judge a `speculationFramed` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.dispatchTier` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DISPATCH_TIER` | Re-judge a `dispatchTier` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.devswarmOnBrief` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DEVSWARM_ON_BRIEF` | Re-judge a `devswarmOnBrief` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.devswarmExtraSanctioned` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DEVSWARM_EXTRA_SANCTIONED` | Re-judge a `devswarmExtraSanctioned` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.devswarmWaitKind` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DEVSWARM_WAIT_KIND` | Re-judge a `devswarmWaitKind` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.devswarmLoop` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DEVSWARM_LOOP` | Re-judge a `devswarmLoop` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jevCascade.devswarmStepMap` adv | `off` (on/off) | `ANTIHALL_JEV_CASCADE_DEVSWARM_STEP_MAP` | Re-judge a `devswarmStepMap` Jev answer with the model when Jev's confidence is under the integration's escalation threshold (`engine/defaults/judge.toml`, default its act threshold). A hook-blocking decision never waits: Jev's answer applies now, the re-judged one from the next ask; a background caller waits. One telemetry row per escalation in `logs/judge-calls.ndjson`. |
| `jev.prices` adv | — | — | computed: per-model USD price table {model: {inPerMTok, outPerMTok}} (or a "default" entry), used only when the gateway reports tokens but no cost. File-only (no env, no CLI set) — edit ~/.anti-hall/settings.json directly. |
| `jev.priceUsdPerMInput` adv | `0.042` [0..] | `ANTIHALL_JEV_PRICE_USD_PER_M_INPUT` | USD per 1M input tokens for the Jev judge call, used to compute costUsd when the gateway reports tokens but no cost and `jev.prices` has no matching entry — Jev's own published rate by default. |
| `jev.priceUsdPerMOutput` adv | `0` [0..] | `ANTIHALL_JEV_PRICE_USD_PER_M_OUTPUT` | USD per 1M output tokens for the Jev judge call (default 0 — output is free on the verified rate). |
| `jev.dispatchTierNoWorkspaceRepos` adv | `''` | `ANTIHALL_JEV_DISPATCH_TIER_NO_WORKSPACE_REPOS` | Repos (basenames or absolute paths; `*` = all) where dispatchTier never recommends `workspace` (shown as `subagent`). |
| `jev.dispatchTierDetectNoWorkspaces` adv | `true` | `ANTIHALL_JEV_DISPATCH_TIER_DETECT_NO_WORKSPACES` | Also treat a repo as no-workspace when its CLAUDE.md/AGENTS.md says "no workspaces for real work". |
| `jev.reviewAfterDays` | `7` [1..365] | `ANTIHALL_JEV_REVIEW_AFTER_DAYS` | Minimum days an integration must have sat in shadow mode before its shadow numbers are due for owner review (also the re-review cadence once reviewed). |
| `jev.reviewMinDecisions` | `30` [0..] | `ANTIHALL_JEV_REVIEW_MIN_DECISIONS` | Minimum decisions logged for a shadow integration before its review is due — avoids nagging about a barely-used integration with too little data to judge. |
| `jev.recommendNoticeHeadless` adv | `false` | `ANTIHALL_JEV_NOTICE_HEADLESS` | Allow the "Recommended: enable Jev" notice in non-interactive runs (`claude -p`/SDK, detected by `CLAUDE_CODE_ENTRYPOINT=sdk-*`; `sdk-cli` verified live). Default `false`: a headless run neither shows it nor uses up its once-per-30-days slot. JEV REVIEW DUE is unaffected; Codex unchanged. Unset + `context.protocolLevel=full` = `true`. |
| `jev.recommendNotice` | `true` | `ANTIHALL_JEV_RECOMMEND_NOTICE` | Bold "Recommended: enable Jev" SessionStart/doctor notice, shown only while Jev is NOT enabled (once on first install, then at most every 30 days). Set false to silence it. |
| `jev.reviewReminder` | `true` | `ANTIHALL_JEV_REVIEW_REMINDER` | Durable "time to review the Jev shadow numbers" SessionStart/doctor nudge (on by default — owner opt-out only). |
| `devswarm.hivecontrol` | — | `ANTIHALL_DEVSWARM_HIVECONTROL` | Explicit path to the hivecontrol CLI binary (default: PATH lookup — no single default value; empty means "look it up"). |
| `devswarm.supervisorMode` | `auto` (auto/on/off) | `ANTIHALL_DEVSWARM_SUPERVISOR` | Force the DevSwarm supervisor context on/off, or auto-detect. |
| `devswarm.requiredGates` | `done,merged,tests_passed` | `ANTIHALL_DEVSWARM_REQUIRED_GATES` | Merge gates required for DevSwarm tasks. |
| `devswarm.inboxCmd` | — | `ANTIHALL_DEVSWARM_INBOX_CMD` | Consumer-configured command to read pending mesh messages (no built-in default). |
| `devswarm.heldPartitions` adv | — | `ANTIHALL_DEVSWARM_HELD_PARTITIONS` | Owner-held mesh partition ids (csv). Exempt from the per-turn "ORPHANED MESH" warning and from `reap-orphans`; still shown via `diagnose`/`healthcheck` as held by owner. |
| `devswarm.childGateStrict` adv | `true` | `ANTIHALL_DEVSWARM_CHILD_GATE_STRICT` | Strict child-gate enforcement. |
| `devswarm.stableLauncher` adv | `true` | `ANTIHALL_DEVSWARM_STABLE_LAUNCHER` | Point injected DevSwarm directive text (wake cron, Monitor re-arm, comms override, drain nudge) at the version-independent launcher under `~/.anti-hall/bin/`; `false` reverts to the version-pinned plugin-cache path. |
| `devswarm.parentGateCap` adv | `3` [2..5] | `ANTIHALL_DEVSWARM_PARENT_GATE_CAP` | Caps the parent-gate wait/child count, clamped to [2,5]. |
| `devswarm.parentGateNeglectMinUnread` adv | `0` [0..] | `ANTIHALL_DEVSWARM_PARENT_GATE_NEGLECT_MIN_UNREAD` | Minimum real-unread count a genuinely NOT-busy child needs before the parent Stop gate hard-blocks on it; 0 = any real unread blocks. A BUSY child (fresh real-work transcript) gets an advisory line instead, until its oldest unread passes `parentGateBusyMaxAgeMin`. A child waiting on its own question or plan approval always blocks. |
| `devswarm.parentGateBusyFreshMin` adv | `5` [1..] | `ANTIHALL_DEVSWARM_PARENT_GATE_BUSY_FRESH_MIN` | A child counts as busy only if its transcript was written within this many minutes and its latest turn is real work (not a mailbox ping, not waiting). A live process or a fresh heartbeat alone never counts. An unresolved tool call on a transcript quiet longer than this counts as waiting (permission prompt or hung tool). |
| `devswarm.parentGateBusyMaxAgeMin` adv | `60` [1..] | `ANTIHALL_DEVSWARM_PARENT_GATE_BUSY_MAX_AGE_MIN` | Even a busy child blocks once its oldest unread message is older than this many minutes ("busy but hasn't read mail in Xm"). An unknown message age never qualifies for the busy advisory. |
| `devswarm.parentGateNeglectGraceMin` adv | `1` [1..] | `ANTIHALL_DEVSWARM_PARENT_GATE_NEGLECT_GRACE_MIN` | Grace window (minutes) for a plain unread backlog on the parent Stop gate: an unread message younger than this never counts as neglect by itself, independent of whether the child is separately provably busy. Never applies to a store-only row, and never suppresses an unanswered child question or an escalation. |
| `devswarm.activeFloorPct` adv | `50` [0..100] | `ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT` | Min percent of active workspaces kept in the archived cache (0 disables the floor). |
| `devswarm.archivedCacheMaxAgeMs` adv | — [0..] | `ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS` | computed: no fixed default — 2x the reconcile sweep’s own resolved cooldown (itself env/default-derived), not a literal constant. |
| `devswarm.archivedGraceMs` adv | `600000` [0..] | `ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS` | Grace period (ms) before a workspace is considered archived. |
| `devswarm.cooldownSec` adv | `600` [0..] | `ANTIHALL_DEVSWARM_COOLDOWN_SEC` | Supervisor cooldown (sec) between recovery actions. |
| `devswarm.idleSec` adv | `900` [60..] | `ANTIHALL_DEVSWARM_IDLE_SEC` | Supervisor idle threshold (sec). |
| `devswarm.dormantMs` adv | `1800000` (>0) | `ANTIHALL_DEVSWARM_DORMANT_MS` | Dormant-workspace threshold (ms). |
| `devswarm.drainTtlMs` adv | `600000` [0..] | `ANTIHALL_DEVSWARM_DRAIN_TTL_MS` | TTL (ms) for the drain marker. |
| `devswarm.graceSec` adv | `5` [1..60] | `ANTIHALL_DEVSWARM_GRACE_SEC` | Grace window (sec) before recovery in devswarm-recover. |
| `devswarm.maxRecoveries` adv | `3` [1..20] | `ANTIHALL_DEVSWARM_MAX_RECOVERIES` | Max auto-recovery attempts. |
| `devswarm.intervalSec` adv | `90` [60..120] | `ANTIHALL_DEVSWARM_INTERVAL` | Sweep interval (sec) used at supervisor install time, clamped [60,120]. |
| `devswarm.migrateMarkRead` adv | `false` | `ANTIHALL_DEVSWARM_MIGRATE_MARK_READ` | Mark migrated messages as read during state migration. |
| `devswarm.monitorTimeoutSec` adv | `30` [0..] | `ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC` | Bounded cadence (sec) for monitor timeout in devswarm-ingest. |
| `devswarm.monitorNoOkFailMin` adv | `10` (>0) | `ANTIHALL_DEVSWARM_MONITOR_NO_OK_FAIL_MIN` | Minutes without a successful ingest monitor poll before health reads FAILING (a fresh daemon reads "starting up" inside it). |
| `devswarm.nudgeCooldownSec` adv | `120` [0..] | `ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` | Cooldown (sec) between supervisor nudges. |
| `devswarm.nudgeMaxAttempts` adv | `2` [1..20] | `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` | Max nudge attempts before escalation. |
| `devswarm.nudgeWindowSec` adv | `180` [1..] | `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` | Window (sec) for counting nudge attempts. |
| `devswarm.postSpawnGraceSec` adv | `120` [0..1800] | `ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC` | Grace period (sec) right after spawning a child workspace, clamped [0,1800]. |
| `devswarm.reapedRetentionDays` adv | `30` (>0) | `ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS` | Retention window (days) for reaped-workspace logs. |
| `devswarm.receiptWindowMs` adv | `300000` [0..] | `ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS` | Window (ms) for parent-reply receipt tracking. |
| `devswarm.archiveRequestRenagHours` adv | `24` [1..] | `ANTIHALL_DEVSWARM_ARCHIVE_REQUEST_RENAG_HOURS` | Hours a pending archive-request suppresses the CHILD NOT DRAINING nag and the ARCHIVE-READY re-nudge for that child before re-nagging anyway. |
| `devswarm.reconcileSweep` adv | `auto` (auto/off) | `ANTIHALL_DEVSWARM_RECONCILE_SWEEP` | Enable/disable the periodic reconcile sweep in the supervisor. |
| `devswarm.reconcileSweepSec` adv | `900` [300..] | `ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC` | Interval (sec) for the reconcile sweep, floor 300s. |
| `devswarm.sweepTailMode` adv | `node` (node/engine) | `ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE` | Who decides the DevSwarm sweep tail (archived registry rows, twin descriptors): node = the scheduled Node functions (default); engine = the engine decides each step only after Node's own function, run on a scratch mirror, agrees with it. |
| `devswarm.rowStaleMs` adv | `86400000` [0..] | `ANTIHALL_DEVSWARM_ROW_STALE_MS` | Staleness threshold (ms) for workspace row selection. |
| `devswarm.sendReceiptRetentionDays` adv | `7` (>0) | `ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS` | Retention window (days) for send-receipt records. |
| `devswarm.summaryRetentionDays` adv | `30` [0..] | `ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS` | Retention window (days) for summary records. |
| `devswarm.wakeCron` adv | `7,37 * * * *` | `ANTIHALL_DEVSWARM_WAKE_CRON` | Wake-poll cron schedule override (treated as untrusted input). |
| `devswarm.rearmOnTickOnly` adv | `true` | `ANTIHALL_DEVSWARM_REARM_ON_TICK_ONLY` | Token savings (0.117.0): re-arm a lapsed Monitor wake-watch only from the cron tick's `watcherArmed:false` check, never inline on the Monitor's own expiry event. Metric: `~/.anti-hall/devswarm/rearm-cues.jsonl`. |
| `devswarm.wakeWatchPollMs` adv | `2000` [250..60000] | `ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS` | Poll interval (ms) for the wake-watch loop, clamped [250,60000]. |
| `devswarm.wakeWatchIdleSkip` adv | `true` | `ANTIHALL_DEVSWARM_WAKE_WATCH_IDLE_SKIP` | Token savings (#39): a Primary with 0 live child workspaces (live = not archived, not held, not ignored) skips arming/re-arming the wake-watch Monitor — nothing will ever message it. `inbox tick` reports `watcherArmed idle-skip` (not `false`); `devswarm-wake-watch.js`, if started anyway, prints one line and exits 0. Cron fallback unaffected. Metric: `~/.anti-hall/devswarm/rearm-cues.jsonl` (trigger `idle-skip`), surfaced by doctor. Sibling behavior (no separate setting): while `limitConserve` is active, `inbox tick` reports `watcherArmed limit-skip` instead — re-arming a wake-watch is deferred non-urgent work, same as everything else LIMIT CONSERVATION routes away from the main agent. Metric: same ledger, trigger `limit-skip`, surfaced by doctor. |
| `devswarm.dispatchTierText` adv | `true` | `ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT` | The DevSwarm PRIMARY dispatch-tier text ("the workspace is your top fan-out tier") injected by `task-tracker.js`, `verify-first.js` and `verify-first-orch.js`, all through one gate (`hooks/lib/primary-tier.js`). Off removes it everywhere. It is also never injected when the repo's `CLAUDE.md`/`AGENTS.md` forbids workspaces for real work (the `noWorkspaceRepo` check: `jev.dispatchTierNoWorkspaceRepos`, `jev.dispatchTierDetectNoWorkspaces`). A child workspace never gets it. |
| `devswarm.inlineWorkNudge` adv | `true` | `ANTIHALL_DEVSWARM_INLINE_WORK_NUDGE` | Advisory, Primary only: once per session, when actionable tasks are pending, the Primary has PROVEN zero live child workspaces (`hasLiveChild() === false`; unknown liveness stays silent), and its main thread has made more than `inlineWorkNudgeThreshold` Edit/Write/MultiEdit/NotebookEdit calls, one note says workspace-scale work belongs in a child workspace. Rides the `edit-guard.js` PreToolUse hook (no extra hook entry), so it is inactive while `safety.editGuard` is off or `edit-guard` is skipped, and it is emitted only on an allowed call. Never blocks; suppressed in a no-workspace repo and in a child workspace. |
| `devswarm.inlineWorkNudgeThreshold` adv | `5` [>=1] | `ANTIHALL_DEVSWARM_INLINE_WORK_NUDGE_THRESHOLD` | Main-thread edit calls a Primary may make before the inline-work nudge fires (it fires on the next call). |
| `devswarm.tickRosterEvery` adv | `0` (off) [>=0] | `ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY` | Every Nth `inbox tick --quiet` of a Primary appends the compact roster table (the same renderer as plain `roster`, no new columns) AFTER the unchanged first line, only when unread is 0, the tick is `known`, and a live non-self child is proven (a live roster row and `hasLiveChild`, which fails open to "has a child" on doubt). `--quiet` is the cron-prompt one-line rendering, so the roster belongs to it alone: the JSON form (no `--quiet`, or `--json`) never changes and `--child` ticks never carry it. The tick count lives as `seq` in the wake-tick marker, written only while this is on. |
| `devswarm.childGateRetentionDays` adv | `14` (>0) | `ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS` | Days a per-session child-gate state file is kept before the housekeeping/doctor sweep removes it. |
| `devswarm.housekeepingSweep` adv | `auto` (auto/off) | `ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP` | Supervisor disk-hygiene sweep (reaped logs, child-gate state); only "off" disables it. |
| `devswarm.housekeepingSweepSec` adv | `3600` [300..] | `ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC` | Seconds between housekeeping sweeps, floor 300. |
| `devswarm.supervisorLogRotateBytes` adv | `10485760` (>0) | `ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES` | Size at which the supervisor rotates its own log. |
| `devswarm.inboxGraceSec` adv | `120` [0..] | `ANTIHALL_DEVSWARM_INBOX_GRACE_SEC` | Grace window (sec) before a child's fresh unread is flagged, unless it heartbeats first; 0 = no grace. |
| `devswarm.supervisorSweepBudgetMs` adv | `20000` [0..] | `ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS` | Time budget (ms) for one supervisor sweep pass. |
| `devswarm.supervisorBlockerLabelReaskSec` adv | `21600` [60..] | `ANTIHALL_DEVSWARM_SUPERVISOR_BLOCKER_LABEL_REASK_SEC` | Seconds a supervisorBlockerLabel ask/log is suppressed while its input (childId+kind+ts) is unchanged, before a periodic re-ask fires anyway. |
| `devswarm.autoArchive.mode` | `on` (on/dry-run/off) | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE` | Auto-archive finished workspaces (needs DevSwarm ≥ 2.5.3). |
| `devswarm.autoArchive.idleMin` adv | `30` [5..] | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN` | Minutes idle before a finished workspace is eligible for auto-archive. |
| `devswarm.autoArchive.maxPerSweep` adv | `3` [1..20] | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MAX_PER_SWEEP` | Max workspaces auto-archived in one sweep. |
| `devswarm.autoArchive.ignorePings` adv | `true` | `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IGNORE_PINGS` | Idle timer ignores a finished workspace's own mailbox-wake/heartbeat/status turns; real work (an AI turn, a tool call, a new message, a commit) still resets it. |
| `devswarm.retention.days` adv | `30` [0..] | `ANTIHALL_DEVSWARM_RETENTION_DAYS` | Days of message bodies kept before archive+prune; 0 = retention off. |
| `devswarm.retention.maxStoreMB` adv | `100` [0..] | `ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB` | Store size limit (MB): above it, oldest bodies are pruned regardless of age; 0 = no limit. |
| `devswarm.retention.keepPerPartition` adv | `200` [0..] | `ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION` | Newest messages per partition that are never pruned (age or size). |
| `devswarm.retention.archive` adv | `true` | `ANTIHALL_DEVSWARM_RETENTION_ARCHIVE` | Write pruned bodies to the gzip archive first (restorable via `devswarm.js retention restore`). |
| `devswarm.retention.archiveMaxMB` adv | `0` [0..] | `ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB` | Archive size cap (MB); 0 (default) = never evict; above a set cap the oldest archive months are dropped. doctor warns past 500 MB. |
| `devswarm.parentGate` | `true` | — | devswarm-parent-gate (Stop): make a Primary attend to a child with unread mail or a stale verdict before stopping. |
| `devswarm.childGate` | `true` | — | devswarm-child-gate (Stop): make a child workspace heartbeat/report to its parent before going idle. |
| `devswarm.parentInbox` | `true` | — | devswarm-parent-inbox (UserPromptSubmit): inject the workspace roster and unread child mail into a Primary. |
| `devswarm.childTurn` | `true` | — | devswarm-child-turn (UserPromptSubmit): inject a child workspace's pending mail each turn. |
| `devswarm.childRole` | `true` | — | devswarm-child-role (SessionStart): inject the mesh-only messaging directive into Primary and child sessions. |
| `devswarm.childDrain` | `true` | — | devswarm-child-drain (PostToolUse Bash): re-surface a child's unread mail mid-task (throttled). |
| `devswarm.parentReplyTracker` | `true` | — | devswarm-parent-reply-tracker (PostToolUse Bash): record the Primary's direct replies so the parent gate can tell read from answered. |
| `devswarm.commsGuard` | `true` | — | devswarm-comms-guard (PreToolUse SendMessage): block SendMessage to a DevSwarm workspace (mesh messaging only). |
| `devswarm.inboxReadGuard` | `true` | — | inbox-read-guard (PreToolUse Read): block raw Read-tool reads of the DevSwarm inbox/store (use the wrapper). |
| `devswarm.wakeWatch` | `true` | — | devswarm-wake-watch monitor: wake an idle session the moment new mesh mail lands (the cron fallback stays). |
| `devswarm.appSync` | `true` | `ANTIHALL_DEVSWARM_APP_SYNC` | Supervisor app-DB sync: apply the DevSwarm app database (archive state, names, drift) every tick. |
| `devswarm.screenshotSync` | `true` | — | `devswarm.js sync-ui`: reconcile a transcribed sidebar screenshot against the app DB. |
| `devswarm.spawnFromOrigin` | `true` | — | `devswarm.js spawn`: fetch origin first and fast-forward the local default branch so a child never starts from stale tooling; refuses when it is behind and cannot be updated (unless --from-local). |
| `devswarm.sendMultiRecipient` | `true` | `ANTIHALL_DEVSWARM_SEND_MULTI_RECIPIENT` | `devswarm.js send --to <id1>,<id2>` (or a repeated `--to`) sends one body to each deduped recipient, attempts every recipient even after a failure, reports per-recipient `ok`/`seq`/`bytes`, and exits non-zero if any failed. `false` restores the old parsing (last `--to` wins). |
| `devswarm.spawnStrictFlagValues` | `true` | `ANTIHALL_DEVSWARM_SPAWN_STRICT_FLAG_VALUES` | `devswarm.js spawn`: refuse when `-s/--source`, `-a/--agent`, `-t/--title` or `-p/--prompt` has no value or is given what looks like the next option (`spawn b -t -p "brief"` used to make `-p` the title), naming the flag. `-p` accepts a brief that starts with a markdown bullet. |
| `devswarm.spawnFetchTtlSec` adv | `300` | `ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC` | `devswarm.js spawn`: skip the origin fetch when the remote-tracking ref was already updated within this many seconds (0 = always fetch). |
| `devswarm.spawnCreateTimeoutMs` adv | `180000` | `ANTIHALL_DEVSWARM_SPAWN_CREATE_TIMEOUT_MS` | Timeout (ms) for the `hivecontrol workspace create` call spawn makes; on timeout only our own child process is killed. |
| `devswarm.planTracking` | `true` | `ANTIHALL_DEVSWARM_PLAN_TRACKING` | Step-plan tracking: `spawn` turns a numbered list in -p into the child's plan; the table and roster show "3/7 done · doing #4 · 42m · progress 18m ago". Off: no plan is written or shown. |
| `devswarm.planRequired` | `false` | `ANTIHALL_DEVSWARM_PLAN_REQUIRED` | Ask every child without a step plan to write one (`plan set`) each turn. Never refuses a spawn. |
| `devswarm.stepStallMin` adv | `30` [5..] | `ANTIHALL_DEVSWARM_STEP_STALL_MIN` | Minutes a busy planned child may go without step progress (or since its last correction) before one `stall` straying warning; also the "correction followed" window. |
| `devswarm.strayWarnMax` adv | `2` [0..10] | `ANTIHALL_DEVSWARM_STRAY_WARN_MAX` | Most straying warnings per signal per plan step. 0 turns straying warnings off. |
| `devswarm.burnTokensWarn` adv | `2000000` [0..] | `ANTIHALL_DEVSWARM_BURN_TOKENS_WARN` | Token-burn warning: weighted tokens a planned child may spend since its last step progress before one `burn` warning. 2M ≈ 100+ calls at a 150k cached context with the 10% cache-read weight. 0 = off. |
| `devswarm.burnCacheReadPct` adv | `10` [0..100] | `ANTIHALL_DEVSWARM_BURN_CACHE_READ_PCT` | Percent weight of cache-read tokens in the burn figure; 10 mirrors cache-read pricing (a tenth of the base input rate). |
| `devswarm.respawnGraceMin` adv | `20` [0..] | `ANTIHALL_DEVSWARM_RESPAWN_GRACE_MIN` | Minutes after a `correct` warning before the Primary may run `devswarm.js respawn <id>`. Respawn is never automatic and refuses without a warning. |
| `devswarm.respawnWipWaitSec` adv | `120` [0..] | `ANTIHALL_DEVSWARM_RESPAWN_WIP_WAIT_SEC` | Seconds `respawn` waits for the child to commit and push; anything left is parked on a new pushed `park/<branch>-<ts>` branch. |
| `devswarm.archivedChildStop` | `true` | `ANTIHALL_DEVSWARM_ARCHIVED_CHILD_STOP` | An archived child workspace can never re-register its descriptor and is told once to save a handover and stop, instead of being nagged to heartbeat forever. Its mailbox wake-watch also stays silent (no wake line, resumes if restored) and `inbox tick --child` reports `watcherArmed archived-skip` instead of `false` (no re-arm). A flat `.anti-hall/handovers/*.md` written at/after 24 h before the archive counts as the handover; the archived turn/Stop text also tells the child to delete its own `inbox tick` cron. `false` reverts to pre-fix behaviour. |
| `devswarm.cronMissingWarnMin` adv | `60` [>0] | `ANTIHALL_DEVSWARM_CRON_MISSING_WARN_MIN` | Minutes without a fresh inbox-tick marker (cron not running — e.g. after a DevSwarm crash/session restore/Claude restart) before the Stop gate warns once, capped, to `CronList`/`CronCreate` the wake cron again. |
| `devswarm.maintainerNotice.post` safety | `false` | `ANTIHALL_DEVSWARM_MAINTAINER_NOTICE_POST` | Allow `devswarm.js notice --post` from THIS checkout; also requires this checkout's own `plugin.json` to name "anti-hall" (a mistake guard, not authentication). Only the owner changes it (here or via env); agents cannot. |
| `devswarm.maintainerNotice.show` | `true` | — | Show unseen maintainer notices to a Primary. Off suppresses the surface only — posting/listing via the CLI is unaffected. |
| `devswarm.startupSampling` | `true` | `ANTIHALL_DEVSWARM_STARTUP_SAMPLING` | Supervisor reconcile sweep: opportunistically probe `hivecontrol workspace info <id>` (read-only, bounded, 3s timeout) for stale/not-draining rows and log a non-null startup field or a terminalId change — pure data capture toward designing paused-workspace detection. |
| `devswarm.pausedProbeMax` adv | `8` [1..20] | `ANTIHALL_DEVSWARM_PAUSED_PROBE_MAX` | Max `hivecontrol workspace info` probes per supervisor sweep tick for the startup-state sampler above. |
| `statusline.base` | — | `ANTIHALL_STATUSLINE_BASE` | Shell command run as the line-1 base in consolidated statusline mode. |
| `statusline.noEmail` | `false` | `ANTIHALL_STATUSLINE_NO_EMAIL` | Suppress the email segment in the statusline. |
| `codexNudge.enabled` | `true` | `ANTIHALL_CODEX_NUDGE` | Enable the Codex hand-off nudge hook. |
| `codexNudge.min` adv | `3` [1..] | `ANTIHALL_CODEX_NUDGE_MIN` | Minimum substantial code-file edits before the nudge fires. |
| `engine.bootstrap` | `true` | `AH_ENGINE_BOOTSTRAP` | Download and install the sha256-pinned ah-engine binary from the GitHub Release on SessionStart (once per pinned release). Off: nothing is downloaded and the Node hooks answer everything. AH_ENGINE_BOOTSTRAP=0/1 overrides this key. |
| `engine.autoUpdate` | `off` [off, stable, dev] | `AH_ENGINE_AUTO_UPDATE` | Update the engine binary on its own, at most once a day: off (default), stable (latest release) or dev (latest dev pre-release; also syncs the plugin files of a live kit). Runs `hooks/ah-update.sh --auto`; the previous binary is kept (`--rollback`). URLs and timeouts: `engine/ah-update.toml`. |
| `defects.defaultProj` | — | `ANTIHALL_DEFECT_PROJ` | Default project tag used when filing an anti-hall defect (max 64 chars). |
| `procwatch.enabled` | `true` | `ANTIHALL_PROCWATCH` | procwatch (scheduled sweep + SessionStart/UserPromptSubmit/PreToolUse advisory): look for processes a Claude session left behind (marked by the environment Claude Code sets, owner session gone, class pattern, minimum age) and for agents with no output. Never touches a live session, an unmarked process or a system process. |
| `procwatch.devServerMode` | `report` | `ANTIHALL_PROCWATCH_DEV_SERVER` | dev_server class of the process watch: dev servers and watchers an agent started. off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.testRunnerMode` | `report` | `ANTIHALL_PROCWATCH_TEST_RUNNER` | test_runner class of the process watch: test runners and their children. off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.buildDaemonMode` adv | `report` | `ANTIHALL_PROCWATCH_BUILD_DAEMON` | build_daemon class of the process watch: build tool daemons. off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.mcpServerMode` adv | `report` | `ANTIHALL_PROCWATCH_MCP_SERVER` | mcp_server class of the process watch: MCP servers of ended sessions (the SessionEnd reaper, maintenance.sessionEndReaper, is separate). off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.shellTaskMode` adv | `report` | `ANTIHALL_PROCWATCH_SHELL_TASK` | shell_task class of the process watch: background shell commands of ended sessions. off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.otherMode` adv | `report` | `ANTIHALL_PROCWATCH_OTHER` | other (catch-all) class of the process watch: any other process a Claude session started and left behind, oldest first. off \| report (list only, the default) \| kill (stop them one pid at a time after a grace period). |
| `procwatch.stuckMinutes` | `20` | `ANTIHALL_PROCWATCH_STUCK_MINUTES` | Minutes without output after which a background agent of this session is named in a stuck-agent advisory (UserPromptSubmit; warn only, once per cooldown). Reuses the silent-agent-nudge detection. |
| `resourceWatch.enabled` | `true` | `ANTIHALL_RESOURCE_WATCH` | resource-watch: sample the processes under live Claude sessions each sweep and warn the session (advisory only). |
| `resourceWatch.cpuPercent` | `90` | `ANTIHALL_RESOURCE_WATCH_CPU` | Per-core CPU percent (100 = one core busy; a multi-threaded process can exceed it) every sample of the window must reach. |
| `resourceWatch.cpuWindowSeconds` adv | `120` | `ANTIHALL_RESOURCE_WATCH_CPU_WINDOW` | Seconds the CPU reading must hold. |
| `resourceWatch.memoryMb` | `4096` | `ANTIHALL_RESOURCE_WATCH_MEM` | Memory in MB (resident set on Linux, physical footprint on macOS) at which a process of a live session is named. |
| `resourceWatch.swapMb` adv | `8192` | `ANTIHALL_RESOURCE_WATCH_SWAP` | System swap in use, MB, that triggers a warning; 0 = off. |
| `resourceWatch.pressurePercent` adv | `25` | `ANTIHALL_RESOURCE_WATCH_PSI` | Linux memory pressure (PSI some avg10, percent) that triggers a warning; 0 = off. |
| `resourceWatch.macPressureLevel` adv | `2` | `ANTIHALL_RESOURCE_WATCH_MAC_PRESSURE` | macOS memory pressure level (2 warn, 4 critical) that triggers a warning; 0 = off. |
| `resourceWatch.cooldownSeconds` adv | `900` | `ANTIHALL_RESOURCE_WATCH_COOLDOWN` | Least seconds before the same process (or system warning) is named again. |
| `resourceWatch.renice` | `false` | `ANTIHALL_RESOURCE_WATCH_RENICE` | Opt-in: lower the priority (nice 10) of a process the watch warned about, once. Off by default; the watch never kills. |
| `diskWatch.enabled` | `true` | `ANTIHALL_DISK_WATCH` | disk-watch: warn (SessionStart/UserPromptSubmit) when the project, HOME or temp volume is below the warn floor, and before heavy commands (PreToolUse) at the critical floor; names the biggest build/cache directories as a suggestion. |
| `diskWatch.warnGb` | `20` | `ANTIHALL_DISK_WATCH_WARN_GB` | Warn below this many GB free (0 = not used). |
| `diskWatch.warnPercent` adv | `10` | `ANTIHALL_DISK_WATCH_WARN_PCT` | Warn below this percent free (0 = not used). |
| `diskWatch.criticalGb` | `5` | `ANTIHALL_DISK_WATCH_CRITICAL_GB` | Critical below this many GB free (0 = not used). |
| `diskWatch.criticalPercent` adv | `3` | `ANTIHALL_DISK_WATCH_CRITICAL_PCT` | Critical below this percent free (0 = not used). |
| `diskWatch.cooldownSeconds` adv | `1800` | `ANTIHALL_DISK_WATCH_COOLDOWN` | Least seconds before the same level is warned about again (a worse level always is). |
| `diskWatch.blockAtCritical` | `false` | `ANTIHALL_DISK_WATCH_BLOCK` | Opt-in: at the critical level, block heavy commands (builds, clones, worktree add) instead of only warning. Off by default. |

## Configuration / tuning

- **Verify-first wording** — edit `hooks/verify-first-core.js` (the single source of every protocol text;
  then run `node tools/gen-protocol.js` to regenerate `PROTOCOL.md`, `protocol-md.test.js` fails on drift) and the `NUDGES` array in `hooks/verify-first.js` (the per-turn one-liners).
- **Hard gates / force patterns** — `hooks/git-guard.js` holds the commit-trailer and
  force-push logic; `command-guard.js` and the other always-on guards cover deploy CLIs,
  payment commands, and bulk deletes at command dispatch. `ship-it` relies on these
  always-on guards for its hard safety boundaries rather than a bespoke per-project
  sentinel.
- **Task discipline** — edit the respective `hooks/*.js`. All hooks are
  fail-open: a bug in a hook must never wedge a turn.

## Troubleshooting / FAQ

- **Hooks not firing?** Restart Claude Code so a fresh session re-runs SessionStart,
  and ensure `node` is on `PATH` for the shell Claude Code launches hooks from
  (`node --version`). If `node` is missing, all hooks silently no-op.
- **Statusline didn't apply?** It is opt-in — run the installer above. If it reports
  "not found", run `/plugin install` first, then re-run, or locate the dir via `/plugin`.
- **git-guard let a force-push through?** Check the documented fail-open scope above
  (aliases / interactive-editor commits with no `-m`/`-F` are out of scope
  by design; `bash -c`/`sh -c`
  wrappers are unwrapped and inspected, not a bypass).
- **Guard blocking something legitimate?** Most guards fail open and have a skip hatch
  (`~/.anti-hall/skip.json`, per-guard, TTL'd) — `git-guard` must be named explicitly.
- **Statusline not showing?** Restart Claude Code once after installing — `statusLine`
  is only read at startup.
- **Update didn't take effect?** Run `/reload-plugins` after `/anti-hall:update`. Restart
  Claude Code only if a hook or skill path still shows the old version afterwards (or to
  re-run SessionStart-only injections).
- **Upgrading from 0.107.x or earlier?** Run `claude plugin update anti-hall@anti-hall`
  once, then restart Claude Code — the old `update` cannot register 0.108.0 with the
  harness. Later updates do this themselves.
- **Anything else?** [KB.md](KB.md) is the doc index; file a defect with
  `/anti-hall:defects`.
- **Using Codex too?** Copy `AGENTS.md` (repo root) into your own repo root — it is
  not bundled by `/plugin install`. Verify with
  `codex --ask-for-approval never "Summarize current instructions"`.

## Test locally

```bash
# Full zero-dependency E2E suite (node:test, run from the repo root):
node --test                                                                  # 2693 pass +2 skipped (2695 total); CI runs the same on push/PR (.github/workflows/test.yml)

# Quick smoke-checks of individual hooks:
echo '{"hook_event_name":"SessionStart"}' | node hooks/verify-first-full.js  # full Iron-Law protocol + skill primer
echo '{"prompt":"x"}' | node hooks/verify-first.js                           # short varying nudge (varies by full stdin envelope)
echo '{"prompt":"y"}' | node hooks/verify-first.js                           # different envelope -> different nudge
claude --plugin-dir /path/to/anti-hall                                       # load in a throwaway session
```

## Contributing
