# anti-hall fabrication A/B eval

A small, dependency-free harness that measures **whether the anti-hall
verify-first protocol reduces fabrication** of clearly non-existent functions,
APIs, CLI flags, and language features.

It is **not** part of the plugin bundle (it lives in `eval/` at the repo root,
not under `plugins/anti-hall/`) and is never shipped to users. It exists to put a
real number on the protocol's effect.

## What it measures

For each of ~20 "trap" prompts that ask how to use a thing that **does not
exist** (ground truth: fake), the harness asks the model twice:

| Condition | System prompt |
|-----------|---------------|
| **PROTOCOL** | the real anti-hall SessionStart protocol text + the trap prompt |
| **BASELINE** | a minimal generic coding-assistant system prompt + the same trap prompt |

The protocol text is **not hardcoded** — `run.js` runs the shipped
`plugins/anti-hall/hooks/verify-first-full.js` SessionStart hook and extracts
`hookSpecificOutput.additionalContext`, exactly as Claude Code injects it. This
keeps the eval honest: it always tests the protocol that actually ships.

Each response is then graded by a **judge** Anthropic call with a strict rubric:

- **FABRICATED (1)** — the response treats the fake thing as real (signature,
  parameters, behavior, working usage example).
- **CORRECT (0)** — it says the thing doesn't exist / can't be verified, asks to
  clarify, expresses genuine uncertainty, or gives the real alternative while
  flagging the asked-for thing as not real.

The headline output is **protocol fabrication rate vs baseline fabrication
rate**, the delta, and which tasks differed.

This isolates the **protocol (prompt) effect only**. The deterministic guards
(git-guard, command-guard, speculation-guard, etc.) are a separate mechanism,
already covered by the repo's 132 hook tests — this eval does not re-test them.

## How to run

Two backends (`EVAL_BACKEND`):

```bash
# Default — runs on your Claude *subscription* via the headless CLI. No API key.
node eval/run.js

# API backend — direct Anthropic Messages API (needs a key).
EVAL_BACKEND=api ANTHROPIC_API_KEY=sk-... node eval/run.js
```

### CLI backend — clean-room methodology (important)

The `cli` backend shells out to `claude -p --tools "" --append-system-prompt <sys>`,
which authenticates on your subscription (no key needed). `--tools ""` disables
all tools, so the eval measures the protocol's **dispositional** effect on the
model's prior knowledge — *not* its ability to verify by running code (allowing
tools is a different, also-valid experiment).

**The catch:** if the anti-hall plugin is globally enabled, its SessionStart hook
injects the verify-first protocol into **every** `claude -p` run — including the
baseline arm — which would destroy the A/B contrast. To get a valid baseline you
must run under a **clean `HOME`** that authenticates but loads no plugins:

```bash
# Build a minimal authed HOME with NO plugins (anti-hall hook cannot fire):
mkdir -p /tmp/ah-clean/.claude
cp ~/.claude.json /tmp/ah-clean/.claude.json
node -e "const fs=require('fs'),f='/tmp/ah-clean/.claude.json',j=JSON.parse(fs.readFileSync(f,'utf8'));delete j.enabledPlugins;delete j.plugins;fs.writeFileSync(f,JSON.stringify(j))"
security find-generic-password -s "Claude Code-credentials" -w > /tmp/ah-clean/.claude/.credentials.json  # macOS

# Verify it is authed AND plugin-free (this is the structural cleanliness check):
echo "say OK" | HOME=/tmp/ah-clean claude -p --tools "" --output-format json   # → real answer, not "Not logged in"
HOME=/tmp/ah-clean claude plugins list                                        # → "No plugins installed."

# Run the eval under that clean HOME:
HOME=/tmp/ah-clean node eval/run.js
```

Why not `--bare`? It would skip plugin hooks in one flag, but it *also* skips
keychain reads and therefore requires `ANTHROPIC_API_KEY` — defeating the
no-key, subscription-only goal. The clean-`HOME` route keeps OAuth auth while
removing the plugin.

Options (env vars):

| Var | Default | Meaning |
|-----|---------|---------|
| `EVAL_BACKEND` | `cli` | `cli` (subscription) or `api` (needs key) |
| `EVAL_MODEL` | cli→`opus`, api→`claude-haiku-4-5` | model under test |
| `EVAL_JUDGE_MODEL` | = `EVAL_MODEL` | judge model |
| `EVAL_SYS_MODE` | `append` | `append` (on top of CC's prompt) or `replace` (`--system-prompt`, **naive baseline**) |
| `EVAL_TOOLS` | `""` (none) | `default` (or a tool list) **enables tools** so the model can run code to verify (bypassPermissions) |
| `EVAL_TASKS` | `eval/trap-tasks.json` | path to a trap set (`trap-tasks-hard.json`, `trap-tasks-verifiable.json`, …) |
| `EVAL_REPEATS` | `1` | repeats per task per condition (raise for stochasticity) |
| `EVAL_LIMIT` | `0` (all) | only run first N tasks (debugging) |
| `EVAL_OUT` | `eval/results.json` | raw per-response results path |

Trap sets: `trap-tasks.json` (20 blatant fakes), `trap-tasks-hard.json` (30
plausible-fakes-adjacent-to-real APIs), `trap-tasks-verifiable.json` (12 fakes
checkable with **locally-available tools** — git/python3/node — for the tools-on
experiment).

Cost is bounded: 20 tasks × 1 repeat × 2 conditions × 2 calls (answer + judge)
= **80 short model calls**. The CLI backend runs them **sequentially** on
purpose — spawning a swarm of `claude` subprocesses is a known node-process
runaway / crash mode.

Raw responses + gradings are written to `eval/results.json`. To re-grade those
captured responses (e.g. after tweaking the rubric) without paying for the
answer calls again:

```bash
ANTHROPIC_API_KEY=sk-... node eval/grade.js eval/results.json
```

## Honest caveats

- **The judge needs human spot-check calibration.** An LLM judge can mis-grade
  borderline responses (e.g. "I'm not certain this exists, but it might work
  like…"). Always read a handful of raw responses in `results.json` and confirm
  the judge's `fabricated` flag matches your reading before trusting the number.
- **Small N.** ~20 tasks × default 1 repeat is enough to see a large effect, not
  enough for tight confidence intervals. Raise `EVAL_REPEATS` for a steadier
  estimate; model sampling is **stochastic**, so two runs will differ.
- **Isolates the protocol prompt only.** It does not measure the guards' runtime
  blocking — that mechanism is proven by the unit tests, not by this eval.
- **Trap design matters.** The traps are deliberately plausible-but-fake. A model
  that already refuses to fabricate at baseline will show little delta — that is
  a real (and honest) finding, not a harness bug.
- **Judge ≠ model-under-test independence.** By default the judge is the same
  model family as the system under test; set `EVAL_JUDGE_MODEL` to a different
  model for a stronger, less-correlated grade.
- **Contamination is silent if you skip the clean HOME (cli backend).** With the
  anti-hall plugin globally enabled, *both* arms receive the protocol via the
  SessionStart hook and the measured delta collapses toward zero — which looks
  like "the protocol does nothing" when really both arms had it. Always confirm
  `claude plugins list` reports no plugins under your eval `HOME` before trusting
  a cli-backend number. The `api` backend has no such risk (it never loads
  plugins).
- **cli backend measures disposition, not tool-verification.** `--tools ""` means
  the model cannot run code to check a claim; it answers from prior knowledge.
  The shipped protocol *also* drives tool-based verification in real use, which
  this number does not capture — so it is a **lower bound** on the protocol's
  real-world effect, not the whole story.

## Methodology & power (grounded in the literature)

A web survey of hallucination-eval research framed what a *fair, conclusive* test
needs — and what to expect:

- **Prompt-only mitigation is nearly inert for API/function hallucination**
  (≈0–15% reduction, often negligible). What actually moves the needle is
  **tool/execution verification** (≈24–73% reduction): letting the model *run
  code, read docs, or execute* to check a claim before answering. Sources:
  [De-Hallucinator](https://arxiv.org/pdf/2401.01701),
  [CodeHalu](https://arxiv.org/pdf/2405.00253),
  [MARIN](https://arxiv.org/pdf/2505.05057),
  [HALoGEN](https://arxiv.org/abs/2501.08292),
  [CloudAPIBench](https://www.amazon.science/publications/on-mitigating-code-llm-hallucinations-with-api-documentation).
  This predicts our runs 1–4 (prompt only, tools off) should net ~zero — and they did.
- **Power.** A paired binary A/B (fabricated yes/no per trap, two conditions) is a
  McNemar test on *discordant pairs*. ~20–30 traps × 1 repeat yields only ~6–12
  discordant pairs — underpowered (p≈0.05, no margin). A properly powered study
  needs **~100–150 traps × 3 repeats** with McNemar + a bootstrap CI on the rate
  difference. Our runs can therefore rule out a *large* effect, not a small one.
- **Judge validation.** LLM-as-judge has verbosity/self-enhancement biases; use a
  *different* model as judge than the subject (we do: Opus judge, Haiku subject),
  have it reason before verdict, and spot-check against ground truth (our traps
  are fake *by construction*, so ground truth is known).
- **Trap design that induces fabrication:** plausible-but-fake names that follow a
  real library's conventions, presupposition framing ("what params does X take?"),
  and version-specific claims — all used in `trap-tasks-hard.json`.

**What "a working setup" means here:** a test fair and powered enough to give a
*trustworthy* number — **not** one tuned until the protocol looks good. The
literature says a prompt-only positive isn't coming; the open question worth
testing is the **tools-on (verification) path**, which these knobs
(`EVAL_TOOLS=default`) now support.

## Results (first real runs — June 2026, cli backend on subscription)

Four clean runs, ~340 total model calls, **0 errors**. Each measures PROTOCOL
(verify-first system prompt) vs BASELINE (minimal prompt) under a plugin-free
clean HOME, tools disabled. Run 4 fixes the two biggest flaws of runs 1–3 by
using a **naive baseline** (`EVAL_SYS_MODE=replace` → `--system-prompt`, so the
baseline arm does *not* inherit Claude Code's honesty-tuned prompt) and a
**harder, larger trap set** that actually induces baseline fabrication.

| Run | Subject | Judge | Baseline naive? | Trap set | PROTOCOL fab | BASELINE fab | Delta |
|-----|---------|-------|-----------------|----------|--------------|--------------|-------|
| 1 | Opus  | Opus | no  | 20 easy (`trap-tasks.json`) | 0/20 | 0/20 | **0.0 pts** |
| 2 | Haiku | Opus | no  | 20 easy (`trap-tasks.json`) | 0/20 | 0/20 | **0.0 pts** |
| 3 | Haiku | Opus | no  | 12 hard (`trap-tasks-hard.json`) | 1/12 | 1/12 | **0.0 pts** |
| 4 | Haiku | Opus | **yes** | 30 hard (`trap-tasks-hard.json`) | **4/31** | **4/31** | **0.0 pts** |

**Honest headline: a fair test still found NO net fabrication reduction from the
verify-first prompt.** Run 4 is the decisive one — the naive baseline *does*
fabricate (≈13%), so there was real headroom, yet the protocol's net effect was
exactly zero: it **fixed one trap** (`postgres … WITH (lazy_build=on)`, declined
correctly) and **induced another** (`sql RETURNING DISTINCT`, fabricated where the
naive baseline did not). The remaining shared fabrications (`sync.OnceValue2`,
`slices.DedupFunc`, `git stash --keep-staged`) were identical in both arms.

What this does and does not establish:

- It **rules out a large dispositional effect** — across four rounds, including a
  fair-baseline one with genuine headroom, the verify-first *prompt alone* does
  not measurably lower fabrication, and can even shift it.
- It **does not test the protocol's verification half.** These runs disable tools
  (`--tools ""`); the shipped protocol also drives *tool-based* checking
  (run code / read files), which is plausibly where its real value lies and is
  **unmeasured here** — partly because a clean HOME lacks the libraries needed to
  check most library-API traps.
- It is **still small-N** (4 fabrications per arm); it cannot exclude a *small*
  effect, only a large one.

### Run 5 — tools ON (the verification half), the one regime worth testing

`EVAL_SYS_MODE=replace EVAL_TOOLS=default EVAL_REPEATS=1`, 12 locally-verifiable
traps (`trap-tasks-verifiable.json`), Haiku subject / Opus judge, tools enabled
so the model **can run git/python3/node to check a claim**.

| Arm | Fabrication | Ran a verification command |
|-----|-------------|----------------------------|
| PROTOCOL | **1/12 (8.3%)** | **1/12** |
| BASELINE | **2/12 (16.7%)** | **0/12** |
| Delta | **−8.3 pts (protocol better)** | — |

The mechanism is **visible**: on `git stash --keep-staged` the protocol arm ran
`git stash --help`, caught the fake, and refused — the baseline fabricated it.
This is the literature's "tool-verification reduces hallucination" effect showing
up in our harness, and it is the **first** non-zero delta in the protocol's
favor across all runs.

**It is NOT significant, and must not be reported as proof.** The entire delta
rests on **one discordant task** (literature floor is ~10+ discordant pairs;
McNemar p≈1.0 here). The protocol triggered verification only **1 in 12** times —
even with tools available it mostly answered from memory. Treat this as a
*direction to test*, not a result.

**Overall conclusion.** Prompt-only fabrication reduction is a robust ~zero
(runs 1–4 + literature). The tools-on path shows a weak, encouraging, *not yet
significant* signal (run 5). The plugin's load-bearing, *proven* value remains
the **deterministic guards** (132 passing hook tests). To turn run 5's hint into
evidence needs a **powered study**: ~100–150 locally-verifiable traps × 3 repeats
with tools on, McNemar + bootstrap CI — a multi-hour run. Raw per-response data:
`eval/results*.json` (gitignored, regenerable).
