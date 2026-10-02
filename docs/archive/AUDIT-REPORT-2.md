# Audit Report 2 — Double Deadly Loop (final gate), anti-hall v0.11.1 → v0.11.2

Four auditors (Opus×2 + Codex×2) reviewed the whole plugin. Synthesizer reconciled,
re-verified every accepted finding against live code/behavior, applied only confirmed
low-risk fixes (fail-open + subagent-allow preserved), and shipped.

Auditors:
- opus-code — JS correctness / regressions
- opus-docs — docs-vs-code accuracy
- codex-code — adversarial JS review (12 findings)
- codex-docs — docs review (sandbox blocked its report file; only its lead finding
  was recoverable from the job log — it corroborates opus-docs on the skill count)

---

## Confirmed issues (re-verified live)

### CONFIRMED — fixed
1. **[P1/HIGH] `sudo` flag form bypasses git-guard force-push + command-guard heavy block.**
   Corroboration: opus-code (P1). `sudo` was in WRAPPERS but, unlike env/timeout/nice,
   had no flag/operand-skip branch, so `sudo -u deploy git push --force` resolved its
   effective verb to `-u` and ALLOWED the force push (verified exit 0); `sudo -u deploy
   npm install` likewise passed command-guard (exit 0). Bare `sudo git push --force`
   still blocked. Fixed in git-guard.js + command-guard.js (skip leading sudo `-flags`
   and the value for `-u/-g/-p/-C/-r/-t/-U/-h` etc., honor `--`).

2. **[HIGH] git-guard inline alias drops a force form baked into the alias BODY.**
   Corroboration: codex-code (HIGH). Verified live: `git -c alias.p="push --force origin
   main" p` → exit 0 (BYPASS). The alias resolver kept only the body's first word
   (`push`) and force-checked only call-site tokens. Fixed: capture the alias body's
   remaining tokens and prepend them to `rest` so the existing `isForcePush` sees a force
   form inside the alias definition. (Call-site force, already blocked, still blocks.)

3. **[P2/LOW] graphify-guard segmentVerb did not skip wrapper words.**
   Corroboration: opus-code (P2). `sudo rg secret` / `time grep x` were not detected as
   code-nav, so the (advisory, non-blocking, once-per-session) graph-first nudge was
   evaded. Low severity. Fixed: segmentVerb now skips wrapper words (mirrors the other
   guards) before reading the verb.

4. **[P1] llms.txt:6 "five workflow skills" — repo ships 7.**
   Corroboration: opus-docs (P1) + codex-docs (lead finding). Verified: 7 skill dirs
   (root-cause, orchestration, deadly-loop, deadly-loop-multi, feature-launch,
   install-statusline, doctor). Fixed → "seven workflow skills".

5. **[P1] plugins/anti-hall/README.md:68 "skill primer listing each of the 7 skills" —
   primer lists only 4.** Corroboration: opus-docs (P1). verify-first-full.js lists
   root-cause / orchestration / deadly-loop / feature-launch (4). Fixed → "the core 4
   skills" to match the code.

6. **[P2] plugins/anti-hall/README.md:57 Features table undercounts skills (lists 4).**
   Corroboration: opus-docs (P2). Same file's Skills section documents all 7. Fixed:
   noted the other 3 alongside the row.

### CONFIRMED — needs-review (real but NOT low-risk; deferred, not applied)
- **[HIGH] command-guard / graphify-guard miss command substitution inside DOUBLE
  quotes** (codex-code). `echo "$(rg secret)"` executes rg, but double-quoted content is
  treated as inert. Unquoted `$()`/backticks ARE caught (auditor-verified). Fixing needs
  a recursive/substitution-aware parser — too invasive for a final-gate patch.
- **[MEDIUM] command-guard / graphify-guard do not recurse into `bash -c "..."` /
  `sh -c` / `zsh -c` payloads** (codex-code). Real gap; requires recursive payload
  scanning. Deferred.
- **[HIGH] swarm-guard cap check is not atomic across concurrent hook invocations**
  (codex-code). read→prune→check→append→write has no lock; concurrent spawns can share a
  stale pre-cap set. Real but needs a lockfile and careful fail-open handling. Deferred.
- **[MEDIUM] doctor statusline self-test passes with one rendered line** (codex-code).
  Accepts line-1-only; does not assert the 2-line hybrid contract or syntax-check
  phase-bar.js. Cosmetic for a health check; deferred.
- **[MEDIUM] uninstall-statusline deletes shared BASE_CFG** (codex-code). Could affect
  other installs still using the dispatcher. Behavioral change to a destructive path —
  deferred for deliberate review (no data-deletion changes made under final gate).
- **[MEDIUM] speculation-guard `should be` over-blocks ordinary advice; acknowledgments
  suppress message-wide** (codex-code). Tradeoff already noted by opus-code as acceptable
  by design (loop-safe, once-per-hash). Tuning, not a correctness bug. Deferred.
- **[LOW] task-tracker accepts future `lastFull` timestamps (clock skew)** (codex-code).
  Minor throttle edge; deferred (fail-open already covers corrupt state).

---

## False-positives / no-action (rejected or downgraded after verification)
1. **demo-wrapper.sh absolute home-path leak** (opus-docs P2, self-downgraded).
   Re-verified: untracked AND git-ignored (`git ls-files` empty, `git check-ignore`
   matches) → never ships via /plugin install or clone. No action.
2. **"graphify exemption allows chained non-graphify search"** (codex-code HIGH) —
   REJECTED. codex-code's OWN "Verified Clean" list contradicts it: `echo /graphify &&
   rg secret` is NOT treated as exempt; isGraphifyBashCommand is per-segment effective-
   verb, not substring. No bypass.
3. **git-guard "inline aliases drop force flags" interpreted as call-site** — the
   call-site case was already correct (opus-code verified). Only the alias-BODY case was
   a real bug (see Confirmed #2). Partial accept.

---

## Fixes applied (files changed)
- plugins/anti-hall/hooks/git-guard.js — sudo flag/operand skip; alias-body force check.
- plugins/anti-hall/hooks/command-guard.js — sudo flag/operand skip.
- plugins/anti-hall/hooks/graphify-guard.js — segmentVerb wrapper-skip.
- llms.txt — "five" → "seven workflow skills".
- plugins/anti-hall/README.md — primer "7 skills" → "core 4 skills"; Features-table row noted.

## Verification
- `node --check` clean on all 3 changed hooks.
- Behavioral: sudo+force, sudo+heavy, alias-body force now BLOCK (exit 2); sudo+status,
  alias status, plain push, subagent payloads still ALLOW; fail-open intact.
- `node plugins/anti-hall/hooks/doctor.js` → "anti-hall ACTIVE — 36 checks passed,
  2 warning(s)", exit 0.
