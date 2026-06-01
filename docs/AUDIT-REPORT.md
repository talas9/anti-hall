# anti-hall Audit Report

Consolidated findings from a 4-auditor review (2 Opus + 2 Codex instances).
Guard code fixes are being applied by a separate agent; this report records
findings and their status for traceability.

---

## Confirmed Issues

### P1 — Security / Bypass

**1. command-guard first-verb/segment bypass**
- Severity: P1 (live-verified)
- Auditors: Opus-1, Codex-1
- File: `plugins/anti-hall/hooks/command-guard.js`
- Issue: The guard extracts the first verb by splitting on whitespace. A command
  whose first token is a shell built-in or path prefix (e.g. `PATH=... npx`) can
  advance the effective verb to a second segment, bypassing the block. Verified by
  both auditors against the actual tokenizer.
- Fix: Normalize the argv array before extracting the first verb; skip leading
  `KEY=VALUE` environment assignments and bare path prefixes before matching.

**2. swarm-guard: persists blocked spawns before cap check**
- Severity: P1
- Auditors: Codex-1
- File: `plugins/anti-hall/hooks/swarm-guard.js`, line ~128
- Issue: The spawn is written to the state log before the rate-cap check runs.
  A spawn that is subsequently blocked is still recorded, inflating the count and
  causing legitimate spawns to be refused on the next call.
- Fix: Move the state-persistence write to after the cap check passes; only
  record spawns that are actually allowed.

**3. git-guard inline-alias force-push bypass**
- Severity: P1
- Auditors: Codex-1
- File: `plugins/anti-hall/hooks/git-guard.js`
- Issue: The guard inspects the raw command string for `--force` / `-f` but does
  not resolve shell aliases or user-defined git aliases (e.g. `git pf` aliased to
  `push --force`). A user with such an alias can force-push without triggering the
  block. This is consistent with the documented fail-open scope (interpreter
  wrappers/aliases are out of scope), but should be explicitly noted.
- Fix (doc-only): Already documented as a known fail-open boundary in
  `plugins/anti-hall/README.md`. No code change required; confirm the alias case
  is explicitly called out alongside the existing `-F <file>` caveat.

### P2 — Logic Gaps

**4. speculation-guard "should be fine" regex miss**
- Severity: P2
- Auditors: Opus-1, Codex-1
- File: `plugins/anti-hall/hooks/speculation-guard.js`
- Issue: The marker list catches `should be` but the negative lookahead `(?!I)`
  was intended to exclude `should I`. The phrase "should be fine" (a common
  confident dismissal that carries no evidence) passes through unblocked if no
  other marker fires. Minor gap; Tier 1 protocol injection covers it behaviourally.
- Fix: Add `should be fine` as an explicit marker, or broaden the `should be`
  pattern to require a following noun/adjective rather than excluding only `I`.

**5. graphify-guard /graphify substring over-exemption**
- Severity: P2
- Auditors: Opus-2
- File: `plugins/anti-hall/hooks/graphify-guard.js`
- Issue: The exemption check uses a substring match on `/graphify`, so any prompt
  containing that string (e.g. "don't run /graphify yet") bypasses the guard even
  when the user is explicitly deferring a graph query.
- Fix: Match the exemption only when `/graphify` appears as a standalone token
  (word-boundary or command prefix), not as a substring anywhere in the prompt.

**6. tmpdir-vs-homedir guard state**
- Severity: P2
- Auditors: Codex-2
- File: `plugins/anti-hall/hooks/graphify-reminder.js` (and similar state files)
- Issue: `graphify-reminder.js` writes its session state to `os.tmpdir()` rather
  than `~/.anti-hall/`. On macOS, `os.tmpdir()` is a per-boot path; state does not
  persist across machine restarts within a Claude session that spans a reboot,
  potentially causing a double-nudge. Other hooks that write state consistently use
  `os.homedir()/.anti-hall/`.
- Fix: Align graphify-reminder to write state to `~/.anti-hall/` like the other
  hooks, for consistency and persistence.

---

## Reconciled False-Positives

**demo-wrapper.sh flagged by Opus-2 and Codex-2**

Both auditors flagged `demo-wrapper.sh` as a potential path-injection risk (the
script accepted a user-supplied argument and passed it to `node` without
validation). After verification:

- `demo-wrapper.sh` is listed in `.gitignore` and is **not tracked by git**.
  `git status` confirms it as an untracked file (`?? cc.sh` is the only untracked
  file in the working tree; `demo-wrapper.sh` does not appear in any commit).
- It is **not bundled by `/plugin install`** and is not part of the shipped plugin.
- It exists only as a local developer convenience script and is never executed in
  any hook or skill.

**Finding: rejected.** The file is not shipped, not tracked, and poses no risk to
plugin users. The auditors' concern was valid in isolation but does not apply to the
shipped artifact. No fix required.

---

## Easy Wins

**7. command-guard Windows path separator**
- Severity: easy win (cosmetic / correctness)
- Auditors: Codex-1
- File: `plugins/anti-hall/hooks/command-guard.js`
- Issue: One path-construction expression uses string concatenation (`dir + '/' +
  file`) rather than `path.join()`. On Windows, this produces a path with a forward
  slash that Node resolves correctly but is inconsistent with the rest of the file
  (which uses `path.join`).
- Fix: Replace the concatenation with `path.join(dir, file)`.

**8. Doc issues fixed in this session**
The following documentation inaccuracies were identified across all four auditors
and have been corrected in this session (see individual file commits):

| File | Issue | Fix applied |
|---|---|---|
| `llms.txt` | Pinned version `0.7.0` drifts from `plugin.json` | Replaced with "see plugin.json" |
| `llms.txt` + `README.md` | `autoUpdate` claimed as marketplace default; `marketplace.json` has no such field | Reworded to "if autoUpdate is enabled" |
| `README.md` skills table | Only 5 skills listed; `doctor` and `deadly-loop-multi` missing | Added both with descriptions |
| `plugins/anti-hall/README.md` skills list | Same 2 skills missing; `install-statusline` also absent from slash-command list | Added all three |
| `llms.txt` skills section | Same 2 skills missing | Added both |
| `plugins/anti-hall/statusline/STATUSLINE.md` | Line 2 documented as phase-bar only; 3-tier behavior undocumented; `statusline-rich.js` missing from scripts table | Updated both |
| `docs/gsd-distilled.md` + `docs/KB-claude-codex.md` | Pinned "Codex GPT-5.5" version | Replaced with "the latest OpenAI Codex" |
| `plugins/anti-hall/skills/feature-launch/references/DEBATE-PROMPTS.md` | Broken link `../MODEL-POLICY.md` | Fixed to `MODEL-POLICY.md` |
| `plugins/anti-hall/skills/feature-launch/references/DEBATE-SYNTHESIS-RULES.md` | Same broken link | Fixed to `MODEL-POLICY.md` |
| `plugins/anti-hall/hooks/verify-first.js` | Comments said "0-4 / 5 facets / mod 5"; code does `% NUDGES.length` (12 entries) | Fixed comments to match code |
| `plugins/anti-hall/README.md` ~line 68 | "primer lists each skill" (ambiguous count) | Updated to "each of the 7 skills" |
| `llms.txt` speculation-guard description | "flags inference-stated-as-fact" misattributes Tier 3 behavior to Tier 2 | Fixed to reflect lexical hedge-word scope |
