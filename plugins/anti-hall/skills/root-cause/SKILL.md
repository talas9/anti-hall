---
name: root-cause
description: Evidence-driven debugging discipline. Use when investigating ANY bug, failure, crash, alert, flaky test, or unexpected behavior, before proposing or applying a fix. Enforces no-cause-no-fix - collect evidence, trace the full sequence, instrument when evidence is missing, prove the original and root cause (not the surface symptom), then fix and verify. Trigger on "why is X failing", "debug Y", "this error", "it crashes", "investigate Z", or any symptom that does not yet have a proven mechanism.
---

# Root Cause

A symptom is not a cause. An alert, a stack-trace line, an error email, a failing
build, a red test — each is *where the problem surfaced*, not *why it happened*.
This skill is the discipline that gets you from symptom to proven mechanism before
a single line of fix is written.

## The one rule everything serves

**NO CAUSE, NO FIX.** You are not allowed to propose, apply, or commit a fix until
you can explain the mechanism with evidence — 100%, no guessing. If you cannot yet
say *why* it happens, you are still investigating. Suppressing or silencing the
symptom is not a fix.

## The loop

Work these steps in order. Do not skip ahead — skipping is how surface fixes get
shipped and the real bug returns.

### 1. Reproduce / observe
- Establish the exact conditions under which the symptom appears. Inputs, state,
  environment, timing, which user/data/route.
- If you cannot reproduce, that is itself a finding — note what you tried and what
  would make it reproducible. Do not start guessing fixes for a bug you cannot see.

### 2. Collect evidence FIRST
- Read the actual code on the failing path. Read the actual logs. Query the actual
  data/state. Check official docs for the actual API behavior.
- Every claim about what the code or system does must come from something you read
  or ran this session — not memory, not assumption. Cite it (`file:line`, log line,
  query result, doc URL).
- Resist the first plausible story. The first explanation that "sounds right" is a
  hypothesis to test, not a conclusion.

### 3. Trace the sequence
- Follow the path from the ORIGINAL trigger forward to where the symptom surfaced.
  The failure point is usually downstream of the cause.
- Identify two distinct things:
  - **Original cause** — the first thing that went wrong (bad input, missing
    precondition, wrong config, an earlier write).
  - **Root cause** — the underlying reason that original cause was possible (the
    missing validation, the wrong default, the broken contract, the race).
- A fix at the surface (where it crashed) without addressing the root cause is a
  band-aid. Fix the root; verify the surface symptom disappears as a consequence.

### 4. Insufficient evidence -> INSTRUMENT, don't guess
When the evidence to date does not prove the mechanism:
- State explicitly what is missing ("I can't see the value of X at the point of
  failure", "I don't know which branch is taken").
- Then choose, in this order:
  1. **Ask** for the specific debug info, logs, or reproduction if the user/system
     can provide it.
  2. **Instrument** — add targeted debug loggers/markers at the RIGHT points in the
     code path (entry/exit of the suspect function, the branch condition, the value
     just before the failing operation). Place them to discriminate between
     competing hypotheses, not everywhere.
  3. Re-run, gather the data, read it.
- Never fill the evidence gap with speculation. Instrument and measure instead.
- Track temporary instrumentation so it is removed once the cause is proven (note it
  in your summary; if it must stay, say why).

### 5. Form and TEST the hypothesis
- State the hypothesis as a falsifiable claim: "If the cause is C, then changing/
  observing M will show R."
- Test it against the evidence. Try to REFUTE it, not just confirm it. If it
  survives, you have the cause. If not, return to step 2 with what you learned.
- Beware confirmation bias: one matching log line is not proof if another hypothesis
  predicts the same line.

### 6. Fix at the root, then verify
- Apply the minimal fix that addresses the proven root cause.
- Re-run the reproduction from step 1. Show the actual output proving the symptom is
  gone. "Should work now" is not verification — running it is.
- Add or update a test that would have caught this, so it cannot silently return.
- Remove temporary instrumentation (unless deliberately kept).

## Anti-patterns (stop if you catch yourself here)

- Proposing a fix in the same breath as first seeing the error.
- "It's probably X" followed by editing code, with no evidence for X.
- Catching/swallowing the exception, raising a timeout, adding a retry, or hiding the
  alert — to make the symptom go away without explaining it.
- Listing five possible causes instead of checking which one is real.
- Declaring it fixed without re-running the failing case.

## When the bug is large or spans resets

For multi-session or complex investigations, keep a running evidence log: the
symptom, what you have ruled OUT (with evidence), the current leading hypothesis, and
the next experiment. This survives context resets and stops you re-investigating the
same dead ends. (If `superpowers:systematic-debugging` is available, it pairs well
here; this skill is the evidence-and-cause spine, usable with or without it.)

## Relationship to the always-on hook

The plugin's `verify-first` hook injects a short version of this discipline into
every turn (no jumping to conclusions, no cause-no-fix, instrument-don't-guess).
This skill is the full protocol you invoke when you are actively hunting a specific
bug.
