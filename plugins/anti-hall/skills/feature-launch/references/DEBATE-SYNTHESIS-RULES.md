# Debate Synthesis Rules

Canonical synthesis ruleset for every cross-model debate gate (B3 post-PLAN,
B6 post-EXECUTION, B6.5 post-UI). All gates apply these rules identically.
Referenced from `SKILL.md` (B3 / B6 / B6.5) and the "Autonomous mode" termination
logic.

This is the SINGLE SOURCE OF TRUTH. If you find these rules quoted elsewhere in the
skill, that's a duplication bug — update this file and the pointer.

Roster context: Reviewer = Claude Opus latest (max thinking); Critic = OpenAI Codex
latest (max reasoning) when available, else a second divergent Opus latest. See
[`MODEL-POLICY.md`](MODEL-POLICY.md) and [`DEBATE-PROMPTS.md`](DEBATE-PROMPTS.md).

---

## Synthesis (autonomous unless hard-gate trips)

See [`HARD-GATES-CHECKLIST.md`](HARD-GATES-CHECKLIST.md) for the per-stack hard-gate
inventory. See [`PRE-TOOL-USE-HOOK.md`](PRE-TOOL-USE-HOOK.md) for the enforcement
layer (regex match -> exit code 2 -> block).

- **Anti-speculation** enforced via dispatch prompt (Phase A.5.4 of the skill):
  every claim cites `file:line`. Uncited claims auto-demote to P2. Verified-against
  footer required; findings outside its file set are dropped before triage.
- **Convergence criterion:** terminate the gate when 2 consecutive rounds produce
  no NEW P0s. "NEW P0" = canonical hash (file + symbol + category) not seen in prior
  rounds this gate. (Published KS-stability proxy — empirically converges in 2-7
  rounds.)
- **Hard outer cap:** 7 rounds. Beyond that -> STOP, surface to owner.
- **Within a round:** any P0 from EITHER agent -> autonomous fix loop, max 5 retries.
- Same canonical P0 cited across 3 rounds -> STOP, surface (likely structural
  defect — fix the plan, not the code).
- **Hard-gate enforcement:** PreToolUse hook in `.claude/settings.json` (regex match
  -> exit code 2 -> block). Drop-in script + settings entry + pattern list:
  [`PRE-TOOL-USE-HOOK.md`](PRE-TOOL-USE-HOOK.md). Never auto-resolved.
- **Self-throttling:** keep each debater's input under ~150k tokens — chunk if
  larger (models suffer context rot well before the nominal window limit). If the
  platform exposes a per-task token budget, set it generously.
- **Sampling:** DO NOT set `temperature` / `top_p` / `top_k` for the Opus roles —
  recent Opus models reject non-default sampling params. Use `effort: xhigh` for
  code-review tasks. Codex runs at its highest reasoning effort.
- **Wall-clock cap:** 4h per phase. Network errors (rate-limit / timeout):
  exponential backoff up to 30min, do NOT count toward retry caps.
- **Cost cap (optional, project-config):** `.planning/config.json` ->
  `feature_launch.gate_cost_cap_usd`. Hit -> STOP, surface (no silent degrade —
  weaker-judge degradation is measured). Note that Codex spend is on the OpenAI side.
- **Triage:** P1 -> follow-up requirement in the plan; P2 -> backlog (auto-demoted
  uncited / hedged claims land here).
- **Non-blocking:** gate runs as a background subagent (`run_in_background: true`).
  Main agent stays free for owner input. Status appends to
  `.planning/AUTONOMY-STATUS.md` per round (single file, append-only). Subagent
  notifies main on each tick. Owner can interject any time; gate doesn't WAIT for
  input. Silence = continue.
- **Forensics:** round log -> `<phase>/DEBATE-LEDGER.md` with `round#`, P0 hashes
  (NEW vs RECURRING), retry counter, token spend, context size.

---

## Termination — when does the loop stop?

The autonomous loop terminates ONLY when one of these fires:

1. **Convergence** — 2 consecutive rounds with no NEW P0s.
2. **Outer cap** — 7 rounds reached.
3. **Within-round cap** — 5 fix-loop retries on a single P0 exhausted.
4. **Wall-clock cap** — 4h per phase exceeded.
5. **Structural-defect signal** — same canonical P0 recurs across 3 rounds (fix the
   plan, not the code).
6. **Hard-gate hit** — PreToolUse hook escalates (see [`HARD-GATES-CHECKLIST.md`](HARD-GATES-CHECKLIST.md)).
7. **Cost cap hit** — if `feature_launch.gate_cost_cap_usd` is configured.

Network errors do NOT count toward retry caps; exponential backoff up to 30min then
terminal.

---

## Why these specific knobs (research grounding)

- **5-retry within-round + 7-round outer cap:** NeurIPS 2025
  ([arXiv 2510.12697](https://arxiv.org/html/2510.12697v1)) — multi-agent debates
  empirically converge in 2-7 rounds; "ensemble size of 7 provides optimal balance";
  hard cap 10.
- **NEW-P0 convergence (vs "no P0"):** "Talk Isn't Always Cheap"
  ([arXiv 2509.05396](https://arxiv.org/pdf/2509.05396)) — sycophancy can converge
  agents on confident-but-wrong views. Tracking NEW canonical findings avoids
  false-stability. This is also why cross-model (Opus vs Codex) is preferred over
  same-model, and why the fallback uses a deliberately divergent persona.
- **Anti-speculation footer + uncited drop:** Chain-of-Verification
  ([arXiv 2309.11495](https://arxiv.org/abs/2309.11495)) — 4.3x hallucination
  reduction. Citation-grounded code review
  ([arXiv 2512.12117](https://arxiv.org/html/2512.12117v1)) — 92% accuracy / zero
  hallucinations.
- **No silent degrade on cost cap:** weaker-judge degradation is measured
  ([NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/899511e37a8e01e1bd6f6f1d377cc250-Paper-Conference.pdf))
  — surface to owner instead.
- **PreToolUse hook for hard gates:** the official command-safety pattern
  ([Claude Code Hooks](https://code.claude.com/docs/en/hooks)) — exit code 2 blocks
  the command before it runs.

---

Hook ID: `feature-launch-debate-synthesis@v1`. Bump when knobs change.
