---
name: anti-hall-defects
description: File, list, show, and rule on anti-hall's own defect reports via the durable, home-scoped, two-way defect channel from a Codex session. Use when the user says "file an anti-hall bug", "did they fix my report", "anti-hall defects", or "check my defect reports" while running under Codex.
---

# anti-hall defects for Codex

A durable, file-based, two-way channel for reporting bugs found in anti-hall itself back
to the maintainer, and reading the maintainer's rulings back. It lives at
`~/.anti-hall/defects/`, home-scoped (works from any repo), and is the SAME script and
store as the Claude side (`hooks/lib/defect-store.js`, `scripts/defect.js`) — there is no
separate Codex implementation to drift from.

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — only plugin-
bundled hook commands get that substitution (see
`docs/KB-codex-platform-hooks-plugins.md`). Codex shows this skill's own file path when
it selects it; resolve the plugin root from that path:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

## Coverage note: no monitor on Codex

The Claude port surfaces open/regressed defect counts to the MAINTAINER via a live
supervisor/monitor path in some contexts. **The Codex port has none of that** — its ONLY
coverage is the shared `SessionStart` nudge (`hooks/defect-nudge.js`, wired identically
in `codex/hooks/hooks.json`), which fires once per 24h at session start, same as Claude.
There is no additional low-latency wake path on Codex; do not imply one. If you need a
fresher read than the once-per-24h nudge, run `list` directly (below) rather than waiting.

## The five verbs

```bash
node "$ANTI_HALL_ROOT/scripts/defect.js" report \
  --class hook-crash --sev p1 \
  --sym "command-guard throws on empty argv" \
  --repro "run command-guard.js with stdin ''" \
  --claimed "should exit 0" --observed "TypeError: Cannot read...stack"

node "$ANTI_HALL_ROOT/scripts/defect.js" list --mine --json
node "$ANTI_HALL_ROOT/scripts/defect.js" list --open --json         # status === 'open' only (untriaged)
node "$ANTI_HALL_ROOT/scripts/defect.js" list --unfinished --json   # open + ack + partial + regressed (closed set excluded)
node "$ANTI_HALL_ROOT/scripts/defect.js" show <fp> --json
# rule is MAINTAINER-ONLY:
node "$ANTI_HALL_ROOT/scripts/defect.js" rule <fp> --status fixed --fixed-in 0.79.0 --commit <sha>
```

`--status` (exactly 6, closed vocabulary): `ack`, `fixed`, `partial`, `wontfix`,
`notabug`, `dup`. Use `partial` (with `--fixed-in` for the part that shipped and
`--note` for what's still open) for a fix that landed only in part — it never derives
as fully `fixed` and never feeds regression detection.

Unknown flags are REJECTED, not silently dropped — nothing is written on an
unrecognized flag. Only `--sym-file`/`--repro-file` (on `report`) take file paths;
there is no `--note-file` or `--observed-file`.

`class` (exactly 8, closed vocabulary): `guard-false-positive`, `guard-miss`,
`hook-crash`, `state-leak`, `messaging`, `doc`, `install`, `other`.
`sev` (exactly 3): `p0`, `p1`, `p2`. Any other value is rejected, not coerced.

## Safe input — never build a shell string for the body

Report bodies can legitimately contain backticks, `$(...)`, newlines, or quotes
describing exactly what broke — do not interpolate them into a shell command line. Two
safe paths:

- Call the CLI with each field as its own argv element (an array, if you're driving it
  programmatically via `execFileSync`/`spawnSync` rather than a shell) — never a
  concatenated shell string.
- For long or tricky bodies, write the text to a file and pass `--sym-file <path>` /
  `--repro-file <path>` instead of `--sym`/`--repro`. The CLI reads the file's raw bytes
  directly, so backticks/`$(`/embedded newlines round-trip byte-exact with zero shell
  interpretation. `--sym`/`--repro`, if also given, win over the `-file` variant.

## Regression: just re-report the same symptom

No separate "reopen" verb — file a normal `report` with the same class/symptom text.
`defect.js` derives `regressed` vs `staleBuild` automatically by comparing your report's
`v` (defaults to the locally installed plugin version) against the ruling's `--fixed-in`:
at/past the fix → `regressed`; predates the fix → status stays `fixed`,
`staleBuild: true`. Both are printed back on a successful `report` — check them.

## When to file — and when not to

File a reproducible anti-hall behavior — a guard false-positive/miss, a hook crash,
leaked/desynced state, a broken doc pointer, an install/update problem — **one symptom
per report**. Do NOT file bugs in your own project, speculation, or duplicates — dedup is
automatic (same class + normalized symptom text hashes to the same fingerprint and
appends an occurrence instead of a new file); just report normally.

## Outcome handling

`report`/`rule` exit 0 **only** on `recorded`/`occurrence-appended`/`ruled`. Any other
outcome (`registry-full`, `occurrence-capped`, `defect-full`, `too-large`,
`write-unverified`, `invalid-class`, `invalid-severity`) means the write did **NOT**
happen — report that plainly, don't retry blindly against a real, meaningful cap.

### Truncation is a SUCCESS that lost text — check `truncated`

Field length caps still apply (`sym` 200, `repro` 1200, `claimed`/`observed` 600, `note`
1200 chars). Over-cap content is cut, but never silently: the write still succeeds and
exits 0, AND the printed result carries a `truncated` map naming each cut field with its
`originalLength` and the `cap` it hit (the CLI also warns on stderr). Narrative fields
(`repro`, `claimed`, `observed`, `note`) additionally carry a `[truncated from N chars]`
marker inside the persisted value. If you see `truncated`, say so and re-file the missing
detail as a follow-up — do NOT report the record as complete.

## Reading rulings back

`list --mine` matches a union of identities so already-filed reports keep matching:
`--proj` flag → `ANTIHALL_DEFECT_PROJ` env → a derived git-repo key → the cwd basename
(back-compat) → `no-repo` outside git.
