# MODEL-POLICY — Debate Roster (shared by deadly-loop and feature-launch)

This file defines the two-agent debate roster used by the `deadly-loop` and
`feature-launch` skills. Both skills MUST read this before spawning any debate
round so the model selection and spawn mechanics are correct and consistent.

The roster is deliberately **cross-model**: one Claude Opus and one OpenAI Codex.
When Codex is unavailable, the fallback is a **second Opus with a divergent
adversarial persona** — never a weaker/cheaper model.

---

## The two roles

### Reviewer — correctness / architecture auditor

- **Model:** latest Claude Opus. As of 2026-05 the latest is `claude-opus-4-8`;
  always resolve "latest" at runtime and use the newest Opus available to you.
- **Thinking:** MAXIMUM. Adaptive thinking ON, effort `xhigh`. `effort`
  defaults to `high` on all surfaces (including Claude Code); `xhigh` is the
  recommended max for agentic/review work. `xhigh` may be unavailable on some
  surfaces/models — if the resolved model does not support it, fall back to
  `high` (never silently degrade below `high` for review). Note: on Opus 4.7/4.8
  manual `budget_tokens` is rejected; use adaptive mode + `effort`.
- **Persona:** rigorous correctness and architecture auditor. Verifies that
  changes do what they claim, that fixes resolve their parent findings without
  regression, that merge order is sound, and that every claim is backed by
  `file:line` evidence. Conservative, evidence-first, says "I can't verify X"
  rather than passing blindly.

### Critic — adversarial failure-mode hunter

- **Preferred model:** latest OpenAI Codex, at MAXIMUM reasoning effort —
  **when available** (see availability check below).
- **Fallback model:** a SECOND latest Claude Opus at maximum thinking
  (`xhigh`), running a deliberately **divergent adversarial persona** — a
  "failure-mode hunter" instructed to find where the change BROKE something or
  HID a different bug, attack edge cases, and distrust validation claims.
- **Persona:** adversarial. Its job is to break the change, not to bless it:
  unintended side effects, subtle regressions, cross-PR reference breakage,
  unvalidated "it passed" claims, edge cases the author didn't test.

---

## Codex availability check

Resolve the Critic path at runtime with this branch logic:

```bash
# 1. Is the Codex CLI installed AND resolvable IN THIS SHELL?
if command -v codex >/dev/null 2>&1; then
  CODEX_AVAILABLE=1
else
  CODEX_AVAILABLE=0
fi
```

> **CLI-alias-in-subprocess caveat:** `codex` may be a shell **alias/function**
> defined only in an interactive profile. Aliases do NOT resolve in a
> non-interactive hook or a spawned subprocess, so `command -v codex` can pass in
> your interactive shell yet fail in the child that actually runs `codex exec`.
> Detect in the SAME shell that will invoke it, and if the alias path fails, try
> a resolved absolute path (e.g. `"$(command -v codex)"` captured up front, or a
> known install location like `~/.codex/bin/codex` / `/usr/local/bin/codex`). If
> none resolves in the executing shell, treat Codex as UNAVAILABLE and take the
> 2nd-Opus fallback.
>
> **Never** set `OPENAI_API_KEY` as a per-job env var (Codex issue #5038: the
> extension can ignore `approval_policy: never` and prompt).

Also confirm the Codex plugin / skill layer is ready before relying on it:

- The `codex` plugin should be installed, exposing the `codex:rescue` skill
  (delegate investigation / review to the Codex subagent) and the `codex:setup`
  skill (checks whether the local Codex CLI is ready, toggles the review gate).
- Run the readiness check via the `codex:setup` skill (or `command -v codex`
  above). If `codex:setup` reports the CLI is not ready / not authenticated,
  treat Codex as UNAVAILABLE and take the fallback.

**Branch logic:**

```
if Codex CLI present (command -v codex) AND codex:setup reports ready:
    → Critic = OpenAI Codex (latest, max reasoning)  [cross-model debate]
else:
    → Critic = 2nd Claude Opus (latest, max thinking, divergent adversarial persona)
```

Never silently downgrade to a cheaper/weaker model (e.g. a mid-tier model) for
the Critic. The fallback floor is a second Opus. If Opus itself is rate-limited,
wait and retry rather than degrading the debate depth.

---

## How to spawn each role

Dispatch **both agents in the SAME message** so they run truly in parallel.

### Reviewer (Opus) — via the `Agent` tool

```
Agent({
  description: "Round N Reviewer (Opus, max thinking)",
  subagent_type: "general-purpose",
  model: "opus",            // resolves to the latest Opus available
  run_in_background: true,
  prompt: <REVIEWER_PROMPT with effort xhigh / extended thinking ON>
})
```

In the prompt, instruct the agent to use maximum extended thinking (effort
`xhigh`) and to cite `file:line` for every claim.

### Critic — Codex path (preferred)

Use the codex plugin. Either delegate via the `codex:rescue` skill, or invoke
the `codex` CLI directly.

Via the skill (preferred — handles runtime + result formatting):

```
Skill({ skill: "codex:rescue",
        args: "<CRITIC_PROMPT: adversarial failure-mode hunt over the round delta>" })
```

Or via the CLI directly (when scripting), at maximum reasoning:

```bash
codex exec --model gpt-5-codex --config model_reasoning_effort=xhigh \
  "<CRITIC_PROMPT: adversarial failure-mode hunt over the round delta>"
```

(Resolve the newest Codex model at runtime; `gpt-5-codex` shown as an example.
Request the highest reasoning effort, but note `xhigh` is NOT available on every
backend — `gpt-5.4-mini` has no `xhigh` and Bedrock `gpt-5.4-cmb` caps at
`high`. If the resolved model/backend rejects `xhigh`, fall back to `high`;
never let an unsupported `xhigh` silently degrade the run.)

### Critic — fallback path (2nd Opus, divergent persona)

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

The divergent persona is what makes the 2-Opus fallback worthwhile: same model
weights, but two opposed objectives (verify vs. break) surface different issues.

---

## Why cross-model beats same-model

- **Diverse failure modes.** Opus and Codex are trained on different data with
  different objectives and architectures. They are wrong about *different*
  things, so a bug invisible to one is often obvious to the other.
- **Independent training → fewer shared blind spots.** Two instances of the same
  model share systematic blind spots (the same tokenizer quirks, the same
  reasoning shortcuts, the same training-data gaps). A genuinely independent
  second opinion is the whole point of a debate.
- **Reduced correlated confidence.** Same-model agents tend to agree confidently
  on the same wrong answer. A cross-model disagreement is a high-signal flag that
  something needs human adjudication.

**Why the fallback still uses 2 Opus with divergent personas:** when only one
model family is available, you cannot get architectural diversity — so you
manufacture *objective* diversity instead. One agent is told to verify (find
evidence it works); the other is told to break it (find evidence it fails).
Opposing incentives over the same evidence reliably surface more issues than two
agents with the same "review this" prompt, even though it is weaker than true
cross-model debate. This is strictly a fallback, not the preferred configuration.

---

## "Latest" resolution reminder

"Latest" means the newest available model at runtime, not a hardcoded version:
- Reviewer / Opus-fallback-Critic: newest Claude Opus (`claude-opus-4-8` is the
  current latest as of 2026-05 — use a newer one if it exists).
- Codex Critic: newest OpenAI Codex model the installed CLI supports.

Always prefer the newest model; treat the version names in this doc as examples
that will age, not as pins.

---

## Anti-sycophancy clause (applies to BOTH roles)

User agreement is not correctness. RLHF optimizes models to agree, so both the
Reviewer and the Critic must explicitly outrank user/author agreement with
evidence. A debate agent that blesses a change because the author said it works,
or because the other agent agreed, adds nothing. Each role must back every
verdict with `file:line` evidence, respectfully challenge wrong premises, and say
"I can't verify X" rather than passing blindly. A cross-model disagreement is a
high-signal flag for human adjudication, not noise to smooth over.
