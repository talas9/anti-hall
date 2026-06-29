---
name: simplify
description: Harvest and apply code simplifications on recently-changed (or named) code — dead code, reinvented stdlib/builtins, premature generality, verbose patterns, and AI-slop filler — each tagged by category, with a single MEASURED `net: -N lines` score (the real post-apply diff delta, never a projected estimate). Use when the user says "simplify this", "deslop", "anti-slop", "trim the fat", "this is over-engineered", or "shrink this". Behavior-preserving by contract — verify tests before and after.
---

# anti-hall:simplify

Find the smallest faithful version of code that already works. This is a **harvest-then-prove**
pass, not a rewrite: every simplification must preserve observable behavior, and the only score
that ships is the **actually-measured** line delta — never a guess about what you "would" save.

> **Behavior-preserving by contract.** Simplification removes *redundancy*, not *capability*.
> Deleting a feature, a branch that real callers hit, or an edge-case guard is NOT a
> simplification — it's a scope change. If you're unsure whether something is load-bearing,
> it stays. (Scope-fidelity is an Iron-Law corollary: do exactly the task, no less.)

## Scope

Default target = **the code changed in this session** (or the current diff / staged set). The user
can name a file, directory, or function instead. Never sweep the whole repo unprompted — that's a
different, much riskier job and invites incidental behavior changes.

## The tag taxonomy

Every finding gets exactly one tag — the dominant reason it can shrink:

| Tag | Means | Typical fix |
|-----|-------|-------------|
| `delete:` | Dead / unreachable code, unused vars/imports/params, commented-out blocks, branches no caller reaches | Remove it |
| `stdlib:` | Hand-rolled logic the **standard library** already provides | Call the stdlib function |
| `native:` | A language **builtin / idiom** reimplemented by hand (e.g. manual loop where a map/filter/spread fits) | Use the builtin |
| `yagni:` | Premature generality — config, flags, abstraction layers, or hooks with **no current caller** | Inline to the one real use; delete the speculative seams |
| `shrink:` | Correct but **verbose** — a shorter equivalent says the same thing as clearly | Tighten (but never at the cost of readability) |
| `slop:` | **AI-slop filler** — redundant comments restating the code, defensive checks for impossible states, ceremonial boilerplate, needless intermediate vars | Strip the noise |

Ambiguous between two tags → pick the one that explains the *most* removed lines. `shrink:` and
`slop:` are the "judgment" tags — only apply them when the result is genuinely clearer, never just
shorter. Clever-but-cryptic is a regression, not a simplification.

## Workflow

1. **Baseline must be green first.** Run the relevant tests/build and confirm they pass *before*
   touching anything. You cannot prove behavior was preserved against an already-broken baseline.
   Record the starting line count of the target (`wc -l`, or `git diff --stat` if working a diff).
2. **Harvest.** Read the target and list findings as `TAG file:line — what & why` plus the
   concrete before→after. Don't apply yet; assemble the full list so duplicates and interactions
   are visible (one change can subsume another).
3. **Apply the safe set.** Make the edits. Skip anything that trades clarity for brevity or that
   you can't prove is behavior-neutral — note those as *declined* with the reason.
4. **Prove it.** Re-run the SAME tests/build. They must still pass. If anything goes red, revert
   that finding — a simplification that breaks a test was a behavior change in disguise.
5. **Score — measured only.** Report `net: -N lines` where **N is the real delta from
   `git diff --shortstat`** (or before/after `wc -l`) *after* the edits are applied and tests are
   green. This is a fact, not a forecast.

## The score is a measurement, not a sales pitch

`net: -N lines` is legitimate **only** because it's the observed diff of work that actually landed
and still passes its tests. Never print a "you'll save ~X lines" number for un-applied changes, and
never inflate the figure with declined or speculative findings — that's exactly the kind of
unverifiable saved-X claim the verify-first protocol forbids (rule 10). If nothing safely shrank,
the honest score is `net: 0 lines` and that's a fine outcome.

## Output shape

```
simplify: <target>   (baseline: <L0> lines, tests: green)

delete:  path/x.js:42      removed unused `tmp` + dead else-branch        (-6)
stdlib:  path/y.js:13      replaced manual dedupe with [...new Set()]      (-4)
yagni:   path/z.js:88      inlined single-caller `makeOpts()` wrapper      (-9)
slop:    path/x.js:7       dropped comment restating the next line         (-1)

declined:
  shrink: path/y.js:60 — one-liner would hurt readability; kept

net: -20 lines   ·   tests: green (re-run, 0 fail)   ·   behavior: unchanged
```

## Honest boundaries

- **Not a reformatter / linter.** Whitespace and pure style churn belong to the formatter, not
  here. `slop:` is about *semantic* noise (redundant logic/comments), not trailing spaces.
- **Not a refactor.** Renaming for clarity, splitting modules, or changing public signatures is
  out of scope — those change interfaces and need their own review.
- **One-way door check.** If a finding deletes the *only* path that exercised some capability, it's
  a capability removal — surface it as a question, don't silently apply it.
