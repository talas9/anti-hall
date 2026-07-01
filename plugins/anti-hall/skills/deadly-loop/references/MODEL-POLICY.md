# MODEL-POLICY — Debate Roster (shared by deadly-loop and ship-it)

<!-- SYNC NOTE: this file is duplicated in skills/MODEL-POLICY.md and the
     deadly-loop skill's references/ (deadly-loop/references/MODEL-POLICY.md).
     The copies are intentional — skill bundling requires the skill to carry its
     own references/ copy, and symlinks are stripped on plugin install. Update
     BOTH copies together so they stay byte-identical. -->

## Everyday agent routing (main-agent policy)

This governs the MAIN agent's everyday model choices (distinct from the TRIO debate roster below, which deadly-loop/ship-it read). Route by task SHAPE, and set `model` EXPLICITLY on every spawn — an omitted model inherits the orchestrator (a flagship), and a fan-out of omitted/Opus seats silently becomes an all-flagship swarm that exhausts the usage limit.

| Task shape | Model | Effort | Why |
|---|---|---|---|
| Main coordinator | **Opus** | — | leads, judges, decides |
| Planning — large / top-level | **Opus** | `xhigh` | judgment/coherence; leads repo-scale SWE-bench Pro |
| Planning — medium / secondary | **Sonnet 5** (`sonnet`) | `xhigh` | faster + cheaper for scoped planning; escalate to Opus when ambiguous |
| Implementation from a ready plan, mechanical edits | **Codex primary → Sonnet 5 failover** | Sonnet 5 at `high` on failover | Codex conserves the Claude bucket; see governance rules below |
| Correctness / subtle-bug review, second opinion on substantial code | **Codex** (`codex:codex-rescue`) | — | off-by-one / races / low-level bugs are Codex's strength; does NOT consume the Claude usage limit |
| Root-cause / deep debug | **Opus** | `high` | deep causal trace needs full reasoning budget |
| Trivial leaf / file-navigation / cheap lookups | **Haiku** | — | cheapest; sufficient |

- **Codex second opinion is ALWAYS warranted on substantial code changes** (the `codex-nudge` Stop hook reminds the main agent; the deadly-loop/ship-it Critic seat already enforces it inside those skills). Keep the architecture/design lens on Opus — the two are complementary.
- **In a Workflow, distribute models across stages/lenses** — never default every `agent()` to Opus. The model-routing-guard hook does NOT police models inside a workflow review fan-out (it exempts review tasks, and workflow-spawn advisories are not surfaced to the orchestrator), so distribution is the SCRIPT AUTHOR's responsibility.
- **Route SMART, not blindly — weigh BOTH limits.** Codex has its OWN usage limit; don't treat "use Codex" as an unconditional rule. If Codex is unavailable or rate-limited, DEGRADE immediately to a cheap Claude (Sonnet) so work continues — never strand the main agent. Do NOT retry Codex every turn: re-attempt only after the reset/`retry-after` time Codex reports, or — if none is given — after a backoff (give it time), not on the next turn. (deadly-loop/ship-it already gate the Critic seat on a `codexUp` probe and degrade to an Opus persona.)
- See `docs/KB-codex-vs-opus-coding.md` for the evidence base; the "Codex=apply/Opus=think" split is a routing heuristic, not a capability wall.

**Four governance rules (always apply):**

1. **Cross-model, no self-review.** The code implementer and its correctness reviewer MUST always be different models. Codex-impl → reviewed by Sonnet 5 or Opus. Sonnet 5-impl → reviewed by Codex or Opus. An agent may never review its own implementation.
2. **Codex is the primary implementer** (conserves the Claude usage bucket). Fail over to Sonnet 5 at effort `high` when Codex is unavailable or rate-limited — never retry-loop. Back off: wait for the reset/`retry-after` time Codex reports, or a backoff window if none is given.
3. **NEVER run Sonnet 5 at effort `max` inside loops.** Sonnet 5 TTFT at `max` is ~163 s and is cost-prohibitive at loop scale. The ceiling inside any loop is `xhigh`.
4. **The `sonnet` tier token resolves to Sonnet 5** (`claude-sonnet-5`) at runtime. Everywhere this policy says `sonnet`, it means Sonnet 5.

---

This file defines the three-agent ("TRIO") debate roster used by the
`deadly-loop` and `ship-it` skills. Both skills MUST read this before spawning
any debate round so the model selection and spawn mechanics are correct and
consistent.

The roster is deliberately **cross-model**: a Sonnet 5 Reviewer, a Claude Opus
Auditor, and an OpenAI Codex Critic. Three independent vantage points (Sonnet 5
correctness, divergent-Opus regression/coupling, non-Claude adversarial) catch
non-overlapping bugs that a single pair would miss. The floor for fallback seats
is Opus — never a weaker/cheaper model.

---

## The three roles (the TRIO)

| Role | Model | Effort | Persona |
|---|---|---|---|
| **Reviewer** | Sonnet 5 (`model: "sonnet"`) | `xhigh` (→ `high`; never `max` in loops) | correctness / architecture auditor |
| **Auditor** | latest Claude Opus (`model: "opus"`) | `high` | divergent: regression & coupling hunter |
| **Critic** | Codex primary (`codex:codex-rescue`) — unless Codex implemented the diff, then Opus/Sonnet 5 | max reasoning (`xhigh` → `high`) | adversarial failure-mode hunter |

*If Fable returns to general availability, reconsider the Reviewer seat for the flagship tier.*

All three are dispatched **in the SAME message** so they run truly in parallel.

### Reviewer — correctness / architecture auditor

- **Model:** Sonnet 5 — pass `model: "sonnet"` to the Agent tool (the `sonnet`
  tier token resolves to Sonnet 5 / `claude-sonnet-5` at runtime; always resolve
  "latest", never hardcode a version). *If Fable returns to general availability,
  reconsider this seat for the flagship tier.*
- **Effort:** `xhigh`. `effort` defaults to `high`; `xhigh` is the recommended
  max for agentic/review work. **NEVER use effort `max` for this seat inside
  loops** — Sonnet 5 TTFT at `max` is ~163 s and is cost-prohibitive at loop
  scale. If the resolved model does not support `xhigh`, fall back to `high`
  (never silently degrade below `high` for review).
- **Persona:** rigorous correctness and architecture auditor. Verifies that
  changes do what they claim, that fixes resolve their parent findings without
  regression, that merge order is sound, and that every claim is backed by
  `file:line` evidence. Conservative, evidence-first, says "I can't verify X"
  rather than passing blindly.

### Auditor — divergent regression & coupling hunter

- **Model:** the latest Claude Opus — pass `model: "opus"`. Deliberately a
  DIFFERENT Claude generation from the Reviewer so the two Claude seats do not
  share the same flagship blind spots; the divergence is the point.
- **Thinking:** MAXIMUM. Adaptive thinking ON, effort `high`. On recent Opus
  generations manual `budget_tokens` is rejected; use adaptive mode + `effort`.
- **Persona:** divergent regression & coupling hunter. Its lens is orthogonal to
  the Reviewer's: hunt where the change broke something ELSEWHERE (regressions in
  unchanged code that depends on the change), where coupling between modules /
  PRs / contracts is now wrong, where a fix to one finding silently undid an
  earlier fix, and where merge order introduces a cross-reference break. Trace
  the blast radius outward from the diff, not just the diff itself.

### Critic — adversarial failure-mode hunter

- **Preferred model:** latest OpenAI Codex, at MAXIMUM reasoning effort —
  **when available** (see availability check below). Spawn it via the canonical
  Codex form below (Agent tool `agentType: "codex:codex-rescue"`).
- **Fallback model:** a latest Claude Opus at maximum thinking (`xhigh`),
  running a deliberately **divergent adversarial persona** — a "failure-mode
  hunter" instructed to find where the change BROKE something or HID a different
  bug, attack edge cases, and distrust validation claims.
- **Persona:** adversarial. Its job is to break the change, not to bless it:
  unintended side effects, subtle regressions, cross-PR reference breakage,
  unvalidated "it passed" claims, edge cases the author didn't test.

---

## Availability fallback matrix

The roster degrades gracefully by which model families are reachable. The
**floor for every seat is Opus** — never a mid-tier or cheaper model. If a
flagship seat is rate-limited, **wait and retry** rather than degrading depth.

| sonnet5 | codex | Roster |
|---|---|---|
| ✓ | ✓ | **Sonnet 5 Reviewer + Opus Auditor + Codex Critic** (the canonical TRIO) |
| ✗ | ✓ | Opus Reviewer + Opus Auditor (divergent) + Codex Critic |
| ✓ | ✗ | Sonnet 5 Reviewer + Opus Auditor + Opus Critic (adversarial persona) |
| ✗ | ✗ | 3× Opus, three divergent personas (verify / regression-hunt / break) |

When Sonnet 5 is unavailable or rate-limited, the Reviewer seat falls back to
Opus (never silently downgrade below Opus). When Codex is unavailable, the Critic
seat becomes a 3rd Opus with the adversarial persona. In the all-Opus floor, the
three seats keep their three DISTINCT personas (verify / regression-hunt / break)
so objective diversity is preserved even without model diversity.

---

## Round governance

The debate is a bounded set of ROUNDS, each round dispatching the full TRIO in
parallel. These rules keep rounds honest and bounded:

- **Flaky seat — one retry per seat per round.** If a seat dies / times out /
  returns malformed output, retry that ONE seat once. RETRY ARITHMETIC: a retry
  fires inside the same 60-second window as the round dispatch. At multiplier ≥
  triple (deadly-loop-multi), retries are **SEQUENTIAL after the wave settles**
  to stay under the swarm-guard spawn cap, or accept the documented +1-entry
  blocked-retry cost (see deadly-loop-multi). At the base 1×-trio there is
  ample headroom (3 + up-to-3 retries) — retries may fire in-window.
- **DEGRADED round** (a seat still dead after its retry): the round may proceed
  with 2 verdicts for ITERATION purposes (so a fix wave can be dispatched), but
  a **DEGRADED round can NEVER grant a final GO**. The missing seat must sit in a
  full, non-degraded follow-up round before GO is valid.
- **GO requires zero un-adjudicated HOLD blockers** AND a non-degraded round.
  **≥2-of-3 agreement on a finding = confirmed-real** (highest priority). A
  finding only one seat raises is either a deeper bug the other two missed OR a
  false positive — adjudicate it against the actual code.
- **Dissent adjudication.** A **single-seat re-run** is allowed ONLY for
  evidence-adjudication with **NO code/plan change in between** (re-run the one
  dissenting seat to confirm/refute its finding against the current state).
  **ANY fix wave ⇒ the FULL TRIO re-runs next round** — never a single-seat
  re-audit after code changed. Evidence-refuted dissent may be overridden, with
  the override documented in the handoff. (This preserves the deadly-loop
  anti-pattern: never send fewer than the full roster after a fix wave.)

---

## Codex availability check

Resolve the Critic path at runtime with this branch logic:

Prefer this pure-Node probe — it is OS-agnostic (Windows, macOS, Linux), uses no
`command -v` / `/dev/null` / POSIX-only paths, and walks `PATH` honoring Windows
`PATHEXT` (`.cmd`/`.exe`) so it resolves a real on-`PATH` `codex` binary, not a shell
alias. Exit 0 = available, 1 = unavailable:

```js
// codex-available.js — exit 0 if a real `codex` executable is on PATH, else 1.
'use strict';
const fs = require('fs');
const path = require('path');
const isWin = process.platform === 'win32';
const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const found = dirs.some(d => exts.some(e => {
  try { fs.accessSync(path.join(d, 'codex' + e.toLowerCase()), fs.constants.X_OK); return true; }
  catch (_) { try { fs.accessSync(path.join(d, 'codex' + e), fs.constants.F_OK); return true; } catch (_) { return false; } }
}));
process.exit(found ? 0 : 1);
```

OS-specific one-liners, if a Node probe is inconvenient:
- POSIX (Linux/macOS): `command -v codex >/dev/null 2>&1 && echo yes || echo no`
- Windows PowerShell: `if (Get-Command codex -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`
- Windows cmd: `where codex >NUL 2>&1 && echo yes || echo no`

> **CLI-alias-in-subprocess caveat:** `codex` may be a shell **alias/function**
> defined only in an interactive profile. Aliases do NOT resolve in a
> non-interactive hook or a spawned subprocess, so a bare `command -v codex` can
> pass in your interactive shell yet fail in the child that actually runs
> `codex exec`. The Node probe above only matches a real on-`PATH` executable
> (never an alias), so it is the most reliable check. If you fall back to a shell
> check, detect in the SAME shell that will invoke it, and if the alias path
> fails, try a resolved absolute path (e.g. a known install location like
> `~/.codex/bin/codex` / `/usr/local/bin/codex`, or on Windows
> `%USERPROFILE%\.codex\bin\codex.exe`). If none resolves in the executing shell,
> treat Codex as UNAVAILABLE and take the Opus-adversarial Critic fallback.
>
> **Never** set `OPENAI_API_KEY` as a per-job env var (Codex issue #5038: the
> extension can ignore `approval_policy: never` and prompt).

Also confirm the Codex plugin / skill layer is ready before relying on it:

- The `codex` plugin should be installed, exposing the `codex:rescue` skill
  (delegate investigation / review to the Codex subagent) and the `codex:setup`
  skill (checks whether the local Codex CLI is ready, toggles the review gate).
- Run the readiness check via the `codex:setup` skill (or the Node probe
  above). If `codex:setup` reports the CLI is not ready / not authenticated,
  treat Codex as UNAVAILABLE and take the fallback.

**Branch logic:**

```
if Codex CLI present (codex-available.js exits 0) AND codex:setup reports ready:
    → Critic = OpenAI Codex (latest, max reasoning)  [cross-model debate]
else:
    → Critic = Opus (latest, max thinking, divergent adversarial persona)
```

Never silently downgrade to a cheaper/weaker model (e.g. a mid-tier model) for
any seat. The fallback floor is Opus. If a flagship seat is rate-limited, wait
and retry rather than degrading the debate depth.

---

## Canonical Codex spawn form (stated ONCE here, referenced everywhere)

The Critic seat (and any Codex auditor in deadly-loop-multi / the deadly swarm
workflow) is spawned ONE canonical way. Other skills reference THIS section
rather than restating it:

**Primary — Agent tool / Workflow `agent()` with `agentType`:**

```
Agent({
  description: "Round N Critic (Codex, adversarial failure-mode hunter)",
  subagent_type: "codex:codex-rescue",
  run_in_background: true,
  prompt: "--background --fresh <CRITIC_PROMPT: adversarial failure-mode hunt over the round delta>",
})
```

- `subagent_type` (Agent tool) / `agentType` (Workflow `agent()`) is
  `"codex:codex-rescue"` — this is what preserves the cross-model Codex critic;
  spawning a plain Claude agent here silently collapses the TRIO to the
  all-Claude fallback.
- The brief is **prefixed `--background --fresh`** — `--fresh` avoids a Codex
  resume prompt (resume-avoidance per deadly-loop-multi); `--background` keeps
  the main thread non-blocking.
- Do NOT add `model: ...` to a `codex:codex-rescue` spawn — the Codex agent
  picks its own backend model.

**Inline alternative — the `codex:rescue` Skill** (handles runtime + result
formatting; use when not fanning out via the Agent tool / Workflow):

```
Skill({ skill: "codex:rescue",
        args: "<CRITIC_PROMPT: adversarial failure-mode hunt over the round delta>" })
```

**Scripted CLI alternative** (when neither plugin path is available), at maximum
reasoning:

```bash
codex exec --model <latest-openai-codex> --config model_reasoning_effort=xhigh \
  "<CRITIC_PROMPT: adversarial failure-mode hunt over the round delta>"
```

(Resolve the newest OpenAI Codex model at runtime; `<latest-openai-codex>` is a
placeholder — use whatever the installed CLI reports as current.
Request the highest reasoning effort, but note `xhigh` is NOT available on every
backend — some compact Codex variants have no `xhigh` and some Bedrock
deployments cap at `high`. If the resolved model/backend rejects `xhigh`, fall
back to `high`; never let an unsupported `xhigh` silently degrade the run.)

---

## How to spawn each role

Dispatch **all three seats in the SAME message** so they run truly in parallel.
Every shipped spawn carries an explicit `model` (Reviewer/Auditor) or
`subagent_type` (Critic) AND an explicit role-word `description` — never rely on
model inheritance (an omitted `model` inherits the orchestrator's model; on a
flagship orchestrator that produces an all-flagship swarm).

### Reviewer (Sonnet 5) — via the `Agent` tool

```
Agent({
  description: "Round N Reviewer (Sonnet 5, effort xhigh)",
  subagent_type: "general-purpose",
  model: "sonnet",          // resolves to Sonnet 5 (claude-sonnet-5) at runtime
  run_in_background: true,
  prompt: <REVIEWER_PROMPT with effort xhigh — NEVER max inside loops (TTFT ~163s)>
})
```

In the prompt, instruct the agent to use effort `xhigh` and to cite `file:line`
for every claim. Never pass effort `max` inside a loop context.

### Auditor (Opus) — via the `Agent` tool

```
Agent({
  description: "Round N Auditor (Opus, divergent regression/coupling hunter)",
  subagent_type: "general-purpose",
  model: "opus",            // resolves to the latest Opus available
  run_in_background: true,
  prompt: <AUDITOR_PROMPT — divergent lens: hunt regressions in unchanged code,
           wrong cross-module/cross-PR coupling, fixes that undid earlier fixes,
           merge-order cross-reference breaks. Trace blast radius outward.>
})
```

### Critic — Codex path (preferred)

Use the **canonical Codex spawn form** above (Agent tool
`subagent_type: "codex:codex-rescue"`, brief prefixed `--background --fresh`; or
the `codex:rescue` Skill as the inline alternative).

### Critic — fallback path (Opus, divergent adversarial persona)

When Codex is unavailable (per the availability check), the Critic seat becomes a
latest Opus with the adversarial persona:

```
Agent({
  description: "Round N Critic (Opus fallback, divergent failure-mode hunter)",
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  prompt: <CRITIC_PROMPT — explicitly framed as ADVERSARIAL: 'Your job is to
           BREAK this change, not bless it. Hunt regressions, side effects,
           unvalidated claims, edge cases. Distrust every "it passed" line.'>
})
```

The divergent persona is what makes the all-Opus fallback worthwhile: same model
weights, but opposed objectives (verify vs. regression-hunt vs. break) surface
different issues.

---

## Why cross-model beats same-model

- **Diverse failure modes.** Sonnet 5, Opus, and Codex are trained on different
  data with different objectives and architectures. They are wrong about *different*
  things, so a bug invisible to one is often obvious to another.
- **Independent training → fewer shared blind spots.** Two instances of the same
  model share systematic blind spots (the same tokenizer quirks, the same
  reasoning shortcuts, the same training-data gaps). The TRIO mixes two distinct
  Claude generations (Sonnet 5 + Opus) AND a non-Claude model (Codex) — a
  genuinely independent set of second opinions is the whole point of a debate.
- **Reduced correlated confidence.** Same-model agents tend to agree confidently
  on the same wrong answer. A cross-model disagreement is a high-signal flag that
  something needs human adjudication.

**Why the fallback still uses divergent personas:** when fewer model families are
available, you cannot get full architectural diversity — so you manufacture
*objective* diversity instead. One seat is told to verify (find evidence it
works); one to regression-hunt (find what broke elsewhere); one to break it (find
evidence it fails). Opposing incentives over the same evidence reliably surface
more issues than three agents with the same "review this" prompt, even though it
is weaker than true cross-model debate. The all-Opus configuration is strictly a
fallback, not the preferred TRIO.

---

## "Latest" resolution reminder

"Latest" means the newest available model at runtime, not a hardcoded version:
- Reviewer: Sonnet 5 (`model: "sonnet"`, resolves to `claude-sonnet-5` at runtime).
- Auditor / Opus-fallback seats: newest Claude Opus available at runtime.
- Codex Critic: newest OpenAI Codex model the installed CLI supports.

Always prefer the newest model; treat the version names in this doc as examples
that will age, not as pins.

---

## Anti-sycophancy clause (applies to ALL THREE roles)

User agreement is not correctness. RLHF optimizes models to agree, so the
Reviewer, the Auditor, and the Critic must each explicitly outrank user/author
agreement with evidence. A debate agent that blesses a change because the author
said it works, or because another agent agreed, adds nothing. Each role must back
every verdict with `file:line` evidence, respectfully challenge wrong premises,
and say "I can't verify X" rather than passing blindly. A cross-model
disagreement is a high-signal flag for human adjudication, not noise to smooth
over.
