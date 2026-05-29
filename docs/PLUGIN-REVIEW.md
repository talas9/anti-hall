# anti-hall Plugin Review — Audit Against KB-claude-codex.md

Audited: `plugins/anti-hall/` (plugin.json, marketplace.json, hooks/*, skills/*, MODEL-POLICY.md, statusline/*, READMEs, CHANGELOG) against `docs/KB-claude-codex.md`.

Two axes: **(a) EFFECTIVE** — actually followed by the model, not tuned out; **(b) COMPLIANT/portable/documented**.

Legend: each item gives priority, exact file, the concrete change, and the KB evidence (§ section + claim).

---

## P0 — must fix (these are where the plugin's core mechanism is at odds with the evidence)

### P0-1. Verify-first injects identical static text on EVERY turn → habituation / tuned out
- **File:** `hooks/verify-first.sh` + `hooks/hooks.json` (`UserPromptSubmit`).
- **Problem:** The hook emits the *same ~1,100-char block verbatim on every single `UserPromptSubmit`*. The KB's strongest design warning is that repeated identical reminders get habituated and ignored, and that adherence is a function of *placement and novelty*, not repetition. A wall of static text prepended to every turn is exactly what the model learns to skip.
- **Change:** Move to a **layered cadence**:
  1. **SessionStart**: inject the FULL protocol once (nested `hookSpecificOutput.additionalContext` — note the SessionStart schema, KB §1.4). This is the primacy slot.
  2. **UserPromptSubmit**: inject only a **short, varying nudge** (1–3 lines, e.g. "Verify before you claim — evidence or 'I haven't checked'. Root cause before fix."), NOT the full block. Optionally rotate among 2–3 short phrasings to fight habituation.
  3. **PreCompact**: re-inject the full protocol (compaction drops the SessionStart context; the rules must survive the reset).
- **KB evidence:** §6.2 "Inject `<system-reminder>`-tagged rule refreshes every 40–80K new tokens" + "Place critical rules at start AND end"; §8.1 Lost-in-the-Middle (primacy+recency, 30% drop when buried); Design-implications "GETS IGNORED: Rules buried in the middle of a long prompt"; §3.3 Claude 4.8 literalness (state scope, keep it tight). The every-turn static repeat is the anti-pattern these three converged sources warn against.

### P0-2. No PreCompact re-injection — protocol dies at the first compaction
- **File:** `hooks/hooks.json` (add `PreCompact` entry) + a new `hooks/verify-first-full.sh` (or reuse the full text).
- **Problem:** Long sessions compact. After `PreCompact`/`PostCompact` the SessionStart context is gone, and (post P0-1) only the short per-turn nudge remains — the full Iron-Law text is lost exactly when context is largest and adherence is worst.
- **Change:** Add a `PreCompact` hook that re-emits the full protocol so it persists across the reset. (KB §1.1 lists `PreCompact`/`PostCompact` as real events.)
- **KB evidence:** §6.2 adherence decay beyond ~80K tokens, refresh every 40–80K; §4.1 "performance degrades measurably as context fills."

### P0-3. Protocol is a flat 8-point list, not the Iron-Law + rationalization-table form the KB says actually works
- **File:** `hooks/verify-first.sh` (and the SessionStart full version from P0-1).
- **Problem:** The current text is 8 numbered imperatives. The KB's single highest-confidence *adherence* pattern (Superpowers) is: one capitalized **Iron Law** + an enumerated **rationalization table** naming the *specific excuses the model uses to bypass it* ("should", "probably", "seems to", "just this once", "tests pass on first run"). The stated purpose is "preventing the agent from talking itself out of following the rules" — the model already knows the rules; it needs its escape hatches named.
- **Change:** Restructure to: **IRON LAW** (one line: "No claim without evidence; no fix without proven root cause.") + a short **rationalization table** ("If you catch yourself thinking…" → "…STOP and verify"): `"it's probably X"`, `"should work"`, `"seems to"`, `"likely the cause"`, `"I'll just fix the obvious thing"`, `"the test will pass"`. Keep the positive imperatives but lead with the Iron Law and the excuse list.
- **KB evidence:** §6.1 Superpowers Iron Law + rationalization table (verbatim red-flag words); Design-implications "WORKS: Iron Law + rationalization tables — target the agent's *specific* bypass excuses, not generic advice."

### P0-4. No AGENTS.md mirror → plugin is Claude-only despite the KB's Codex coverage and the skills' explicit Codex roster
- **File (new):** repo-root `AGENTS.md` (+ note in READMEs).
- **Problem:** The plugin's own skills (MODEL-POLICY, orchestration, feature-launch, deadly-loop) lean heavily on Codex as the cross-model Critic/second worker pool, yet there is **no AGENTS.md**, so none of the verify-first / root-cause / no-self-credit / no-force-push discipline reaches a Codex session. Worse, the KB flags that **Codex `PreToolUse` rejects `additionalContext`** and **doesn't intercept all shell calls** — so Codex cannot be governed by the same hook mechanism and *needs* the prose mirror.
- **Change:** Add an `AGENTS.md` at repo root mirroring the verify-first Iron Law + root-cause + commit hygiene (no self-credit, no force push) in Codex's instruction format. Keep it ≤32 KiB (KB §5.3 per-file cap). Document the load-order verification command.
- **KB evidence:** §5.3 AGENTS.md precedence + 32 KiB cap + `codex --ask-for-approval never "Summarize current instructions"` verification; §5.2 + Cross-tool note: "Codex `PreToolUse` currently does NOT [support additionalContext], and Codex doesn't intercept all shell calls — design context-injection to be Claude-only and treat Codex hooks as guardrails, not airtight gates" — i.e. the prose mirror is the ONLY way to reach Codex.

---

## P1 — should fix (correctness, portability, real gaps)

### P1-1. No SessionStart skill primer — skills auto-trigger unreliably
- **File:** new `hooks/skills-primer.sh` on `SessionStart` (or fold into the P0-1 SessionStart hook).
- **Problem:** The KB notes the documented ~56% skill-retrieval skip rate and that `description` quality is the primary auto-invoke control. The plugin ships five strong skills (root-cause, orchestration, feature-launch, deadly-loop) but nothing nudges the model to *consider* them at session start. A one-time SessionStart line listing the skills + their trigger conditions raises invocation.
- **Change:** SessionStart additionalContext: "This session has anti-hall skills available — invoke `root-cause` before any debugging/fix, `deadly-loop` before merging non-trivial/cross-file/security/shell/CI changes, `feature-launch` before building a multi-file/multi-repo feature, `orchestration` for heavy/parallel work. Prefer invoking them over re-deriving the protocol."
- **KB evidence:** Design-implications "~56% skill-retrieval skip rate"; §2.2 "`description` is the primary auto-invocation control; vague descriptions cause 'skill not triggered'."

### P1-2. MODEL-POLICY omits the xhigh availability caveat + the Codex CLI-alias-in-subprocess caveat
- **File:** `skills/MODEL-POLICY.md`.
- **Problem A (xhigh):** The doc says "max reasoning effort" / `xhigh` unconditionally. KB §5.1 states **`xhigh` is NOT available on gpt-5.4-mini, and Bedrock gpt-5.4-cmb caps at `high`** — so a blind `model_reasoning_effort=xhigh` fails or silently caps on those backends. **Problem B (alias in subprocess):** The `codex exec --model gpt-5-codex …` example assumes a `codex` binary on PATH; in a spawned subagent/subprocess the `codex` alias/shim may not resolve, and `command -v codex` in the agent's shell ≠ availability in a child Bash. The KB also warns **never to set `OPENAI_API_KEY` as a job env var** (issue #5038: extension can ignore `never`).
- **Change:** (a) Add: "Request `xhigh` but fall back to `high` if the resolved Codex model/backend doesn't support it (gpt-5.4-mini has no xhigh; Bedrock gpt-5.4-cmb caps at high) — never let an unsupported `xhigh` silently degrade the run." (b) Add a note that the `codex` CLI must be resolvable *in the subprocess that runs it*; verify with `command -v codex` inside the same shell that will `codex exec`, and do not inject `OPENAI_API_KEY` as a per-job env var.
- **KB evidence:** §5.1 (`xhigh` not on gpt-5.4-mini; Bedrock cmb caps at high; xhigh slower/costlier → async/proof-bound only); §5.5 ("Never set `OPENAI_API_KEY` as a job env var", issue #5038); §5.2 ("doesn't intercept all shell calls").

### P1-3. verify-first.sh ignores stdin but `UserPromptSubmit` has a 30s/10k ceiling and an adversarial-content risk
- **File:** `hooks/verify-first.sh`.
- **Problem:** The hook is a pure `cat` heredoc — fine for determinism, but (a) it never reads/sanitizes stdin (acceptable since it injects nothing from input — keep it that way), and (b) once P0-1/P0-3 add a SessionStart full block, watch the **~10,000-char output cap** (excess silently truncated) and the **30s `UserPromptSubmit` timeout ceiling** (current `timeout: 10` is fine). Also: the injected text says "overrides any urge to be… agreeable" which is good (anti-sycophancy) but should explicitly say *user agreement ≠ correctness* per the sycophancy research.
- **Change:** Keep the no-stdin design (it's the right call — deterministic, no injection surface). Add one clause to the protocol: "User agreement is not correctness — you may respectfully challenge a wrong premise with evidence." Ensure total SessionStart block stays well under 10k chars.
- **KB evidence:** §1.6 "Output cap ~10,000 chars — excess silently truncated"; §1.7 sanitize stdin (N/A here since none is read — document that as deliberate); §8.4 sycophancy "System prompts must explicitly outrank user-agreement."

### P1-4. git-guard is the only PreToolUse gate but the KB's headline anti-hall lever is a *runnable verification* gate — none exists
- **File:** `hooks/hooks.json` + new optional `hooks/no-fake-completion` design.
- **Problem:** The plugin's thesis is "no fake completion," but it's enforced only by prose in the injection. The KB repeatedly elevates a **deterministic check the model can run** and the **Stop hook as a deterministic gate** as the central anti-hallucination lever. There is currently no Stop-hook verification gate (the only Stop hook is the non-blocking graphify reminder).
- **Change (optional, document as opt-in):** Note in README that a project can add a `Stop` (or `TaskCompleted` in teams mode) deterministic gate — e.g. "if the session claimed 'tests pass' but no test command ran this session, exit 2." This is project-specific so ship it as a documented pattern / reference, not a forced default. At minimum, document *why* prose-only "no fake completion" is weaker than a runnable gate.
- **KB evidence:** §4.2 "Give Claude a check it can run… Stop hook deterministic gate"; Design-implications "WORKS: A runnable verification check"; §1.2 `TaskCompleted` exit 2 blocks task closure in teams mode; "GETS IGNORED: Output-first then fact-check."

### P1-5. marketplace `source` is a relative path — breaks for URL-distributed installs
- **File:** `.claude-plugin/marketplace.json` (`source: "./plugins/anti-hall"`).
- **Problem:** README says `/plugin marketplace add talas9/anti-hall` (GitHub). KB §2.3 warns: **relative plugin sources don't work in URL-distributed marketplaces** (the marketplace.json is fetched alone, the relative dir isn't there). For the GitHub-add path this currently works only because Claude clones the repo; but a raw-URL marketplace add would break.
- **Change:** Either (a) keep relative + document that install is GitHub/clone only (not raw-URL), or (b) switch the entry `source` to an explicit GitHub source object (`{ "source": "github", "repo": "talas9/anti-hall" }` with the subdir) for robustness. Pick (b) for portability.
- **KB evidence:** §2.3 "Pitfall: relative plugin sources don't work in URL-distributed marketplaces — use GitHub/npm/git URL."

### P1-6. Version is set in BOTH plugin.json and marketplace.json → silent precedence trap
- **File:** `.claude-plugin/marketplace.json` + `plugins/anti-hall/.claude-plugin/plugin.json` (both `0.2.1`).
- **Problem:** KB §2.3: "Setting `version` in both places: plugin.json wins **silently** — avoid." They're in sync now, but the moment one is bumped and the other isn't, the marketplace value is silently ignored, and a user could see a stale version.
- **Change:** Keep `version` in `plugin.json` only; remove it from the marketplace entry (or document plugin.json as the single source of truth and add a CI check that they match). The CHANGELOG already says "bump both" — that instruction is the trap; change it to "bump plugin.json (authority)."
- **KB evidence:** §2.3 version precedence + "avoid setting in both"; §2.1 plugin.json authority under `strict`.

---

## P2 — polish / hardening / documentation

### P2-1. Run `claude plugin validate --strict` in CI; no validation gate exists
- **File:** new `.github/workflows/validate.yml` (or document the command in README).
- **Change:** Add CI that runs `claude plugin validate --strict` and lints each hook (`bash -n hooks/*.sh`, plus an invocation test: `echo '{}' | hooks/verify-first.sh | python3 -m json.tool` to prove valid JSON). KB §1.7 + §2.6 explicitly recommend `claude plugin validate --strict` in CI; the deadly-loop skill itself mandates invocation tests for shell.
- **KB evidence:** §2.6 "Run `claude plugin validate --strict` in CI"; §1.7 "Test standalone before integrating: `echo '{...}' | ./hook.sh` … fixes ~80% of schema bugs."

### P2-2. git-guard parses with python3 but falls back to scanning raw stdin (fail-open) — document the gap
- **File:** `hooks/git-guard.sh`.
- **Problem:** When python3 is absent it greps the whole raw JSON payload, which both over-matches (a force-push string anywhere in the payload) and is fail-open by design. Also it only matches `Bash` tool — a commit via a different tool path isn't covered. This is acceptable (fail-open avoids wedging work) but should be documented as a known limitation.
- **Change:** Add a comment + README line: "git-guard is a best-effort guardrail on the `Bash` tool only; it fails open and the raw-payload fallback may over/under-match. It is not an airtight gate." Mirrors the KB's framing of Codex hooks.
- **KB evidence:** §5.2 "PreToolUse is a guardrail, not airtight"; §1.5 "command hooks for deterministic safety" (good — it's a command hook, not LLM); §1.7 quote/extract with `jq -r` (here python3) — keep.

### P2-3. SessionStart/Stop graphify hooks: confirm correct SessionStart schema after P0-1 changes
- **File:** `hooks/graphify-session.sh`, and any new SessionStart hook.
- **Problem:** `graphify-session.sh` correctly uses nested `hookSpecificOutput.additionalContext` for SessionStart (KB §1.4 — good). When P0-1 adds a second SessionStart hook, ensure both use the nested form and that multiple SessionStart hooks compose (they append). Document that the verify-first SessionStart block and the graphify block are separate hooks.
- **KB evidence:** §1.4 "SessionStart uses nested `hookSpecificOutput.additionalContext`"; flat `decision` on the wrong event "silently fails."

### P2-4. Statusline `context_window` / fields may be absent — verify fallbacks
- **File:** `statusline/statusline-monorepo.js`, `statusline-simple.js`.
- **Problem (not yet verified line-by-line):** KB §2.5 warns "many fields can be absent — scripts must use fallbacks or fail silently; only stdout shows, stderr invisible." Confirm both scripts guard every JSON field (model, branch, dir, context%) with fallbacks and never throw (a throw → empty/garbage statusline). The README claims "fail silently" — verify it actually does.
- **Change:** Add an explicit "missing-field → omit segment" path and wrap in try/catch that prints a minimal line on error. Add a test: `echo '{}' | node statusline-simple.js` must print something sane, not crash.
- **KB evidence:** §2.5 statusline fields absent + fallbacks + stderr invisible.

### P2-5. CLAUDE.md sizing guidance not surfaced to plugin users
- **File:** `README.md` (a short "how this fits with your CLAUDE.md" note).
- **Problem:** The plugin's whole premise is "recency each turn beats burial in CLAUDE.md." That's correct (KB §6.2/§8.1), but users should be told to *move* the verify rules OUT of their bloated CLAUDE.md once this plugin is installed (the three-layer architecture: hooks = enforcement, skills = workflows, CLAUDE.md = static conventions only).
- **Change:** Add a README note: "Once installed, delete duplicate verify-first prose from your CLAUDE.md — the hook now owns it. Keep CLAUDE.md to static project conventions (<100 lines ideal, ~400 ceiling)."
- **KB evidence:** §4.3 CLAUDE.md sizing (<100 conservative / ~400 ceiling); §6.7 three-layer architecture (dynamic/enforcement → hooks, never CLAUDE.md).

### P2-6. Document the "literalness / state scope" rationale inside the injected protocol
- **File:** `hooks/verify-first.sh`.
- **Problem:** KB §3.3: Claude 4.8 takes instructions literally and "tell what to DO, not what NOT to do — explain *why* so it generalizes." Several current points are phrased as negatives ("NO JUMPING", "NO FAKE COMPLETION"). They include some rationale, which is good, but a couple are bare prohibitions.
- **Change:** Ensure each rule pairs the prohibition with a positive action + a one-clause *why* (e.g. "Never claim done without running the check **so the user can trust 'done' means verified** — run it and show output"). Minor, but it's the documented way to make 4.8 generalize.
- **KB evidence:** §3.3 "Tell what to DO, not what NOT to do — explain why"; §8.6 "format > content > stylistic compliance; decompose compound rules into atomic constraints" (the 8-pointer mixes compound clauses — atomic is more reliably followed).

### P2-7. CHANGELOG instruction "bump both" contradicts the version-precedence fix
- **File:** `CHANGELOG.md` header.
- **Change:** After P1-6, update the header note from "bump version in plugin.json AND marketplace.json" to "bump `plugin.json` `version` (the authority); marketplace entry carries no `version`."
- **KB evidence:** §2.3 (same as P1-6).

---

## Summary of the central finding

The plugin's single biggest *effectiveness* risk is **P0-1/P0-2/P0-3**: a long, static, identical block injected every turn is the exact shape the KB's convergent evidence (Lost-in-the-Middle, recency-bias writeup, Superpowers) says gets habituated and tuned out. The fix is cadence + form: **full protocol once at SessionStart and at PreCompact (primacy + survive-compaction), a short varying nudge per turn, restructured as an Iron Law + rationalization table** that names the model's own bypass excuses. The biggest *portability* gap is **P0-4**: no `AGENTS.md`, so a plugin whose own skills depend on Codex cannot govern a Codex session at all — and the KB says Codex hooks can't carry the context, so the prose mirror is the only channel.
