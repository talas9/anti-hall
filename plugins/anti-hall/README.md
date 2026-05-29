# anti-hall

A Claude Code plugin that enforces **verify-first** discipline and ships the
workflow skills that go with it. It fights four failure modes:

1. **Eagerness** — answering/acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Solution-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done/fixed/passing without running the check.

## Components

### Hooks (always-on)
- **`verify-first.sh`** (`UserPromptSubmit`) — injects the verify-first + root-cause
  protocol into *every* turn: no jumping to conclusions, evidence before claims,
  **no cause / no fix**, instrument-don't-guess when evidence is missing, no fake
  completion, label non-obvious claims. Recency each turn beats burial in `CLAUDE.md`.
- **`graphify-session.sh`** (`SessionStart`) — if the project has a graphify graph
  (`graphify-out/` or `.planning/graphs/`), primes the model to **query the graph
  first** for any issue/feature/function/code/doc lookup, and to keep it updated.
  Silent no-op when graphify isn't used.
- **`graphify-reminder.sh`** (`Stop`, non-blocking) — after a session with real edits
  and a graph present, reminds to run `/graphify --obsidian`. Never blocks.
- **`git-guard.sh`** (`PreToolUse` on Bash) — mechanically **blocks** commits that
  carry a `Co-Authored-By`/self-credit trailer and blocks `git push --force`. Commits
  take no AI credit; history rewrites are a deliberate human action.

### Skills
- **`root-cause`** — evidence-driven debugging: reproduce, collect evidence,
  instrument when missing, trace the sequence to the original + root cause (not the
  surface symptom), prove the hypothesis, fix at the root, verify.
- **`orchestration`** — swarm with a non-blocking main thread: delegate heavy/long
  work to background + parallel subagents, partition to avoid conflicts, distribute
  load across Claude **and** Codex when available, run commands via Haiku so raw
  output never pollutes the coordinator's context.
- **`feature-launch`** — plan-first protocol: author the plan in **plan mode**
  (blending superpowers planning + GSD, not GSD-dependent), enumerate edge cases and
  simulate every scenario, then **harden the plan with the deadly-loop BEFORE any
  code**, then build phase by phase running the **deadly-loop after each phase**.
- **`deadly-loop`** — iterative parallel Reviewer + Critic debate + fix-waves until
  convergence (zero NEW P0s). The debate engine used by feature-launch's gates.
- **`MODEL-POLICY.md`** — shared roster: Reviewer = Opus latest max thinking;
  Critic = Codex latest max reasoning when available, else a divergent 2nd Opus.

### Statusline (opt-in, one command)
Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher that shows a **rich** line in a monorepo
(`.gitmodules` / `.gsd/` / `.planning/`) and a **simple** `model | branch | dir |
context%` line otherwise — no emojis. Install:

```bash
bash "$(dirname "$(/bin/ls -d ~/.claude/plugins/*/anti-hall 2>/dev/null | head -1)")"/anti-hall/statusline/install-statusline.sh
```

See `statusline/STATUSLINE.md` for details and how to revert.

## Test locally
```bash
echo '{"prompt":"x"}' | ./hooks/verify-first.sh           # valid JSON + additionalContext
claude --plugin-dir /path/to/anti-hall                     # load in a throwaway session
```

## Install (any machine, any repo)
```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```
The hooks apply globally once enabled. The statusline needs the one-command installer
above. Tune the injected protocol by editing `hooks/verify-first.sh`.
