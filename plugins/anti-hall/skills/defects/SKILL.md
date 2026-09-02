---
name: defects
description: File, list, show, and rule on anti-hall's own defect reports via the durable, home-scoped, two-way defect channel. Use when the user says "file an anti-hall bug", "did they fix my report", "anti-hall defects", "report this to the maintainer", or "check my defect reports".
---

# anti-hall:defects

A durable, file-based, two-way channel for reporting bugs found in anti-hall itself —
the guards, hooks, skills, statusline, or DevSwarm integration — back to the maintainer,
and for reading the maintainer's rulings back. It lives at `~/.anti-hall/defects/`,
**home-scoped** (works the same from any repo), and is deliberately NOT built on
anti-hall's own DevSwarm messaging layer (see `hooks/lib/defect-store.js`'s header for
why: a channel for reporting bugs in the messaging layer must not itself depend on that
layer).

## The five verbs

All invocations are `node plugins/anti-hall/scripts/defect.js <verb> ...` run from an
anti-hall checkout, or `node <plugin-root>/scripts/defect.js <verb> ...` when resolving
the plugin root generically (mirrors the `doctor`/`debt` skills' invocation style).

1. **report** — file a new defect (or add an occurrence to an existing one via dedup).
   ```
   node plugins/anti-hall/scripts/defect.js report \
     --class hook-crash --sev p1 \
     --sym "command-guard throws on empty argv" \
     --repro "run command-guard.js with stdin ''" \
     --claimed "should exit 0" --observed "TypeError: Cannot read...stack"
   ```
2. **list** — see defects (unfiltered = everything, every status). `--mine` filters to
   defects YOU reported (identity is derived automatically — see below); `--open`
   filters to `status === 'open'` only — untriaged, nobody has ruled on it yet (`ack`,
   `partial`, and `regressed` are all EXCLUDED, same as `regressed` always was — omit
   `--open` to see everything). `--unfinished` is the wider, "still needs attention"
   filter: every status EXCEPT the closed set (`fixed`/`wontfix`/`notabug`/`dup`) — i.e.
   `open` + `ack` + `partial` + `regressed`. Prefer `--unfinished` when the goal is an
   accurate "how many defects are outstanding" count — `--open` alone under-reports:
   a defect ruled `partial` or `ack` is genuinely unfinished but is not `status ===
   'open'`, so `--open` silently drops it (this under-report is exactly what caused
   defect 001e6bb600c5's `partial` status to make `list --open` report 0 while real
   P0/P1 defects sat unresolved). `--json` for machine output.
   ```
   node plugins/anti-hall/scripts/defect.js list --mine --json
   node plugins/anti-hall/scripts/defect.js list --unfinished --json
   ```
3. **show `<fp>`** — every line of one defect (its fingerprint), open or archived.
4. **rule `<fp>` --status ack|fixed|partial|wontfix|notabug|dup** — MAINTAINER-ONLY.
   Appends a ruling. `--fixed-in V` and `--commit SHA` are the fields that make
   regression detection possible later — always set `--fixed-in` when ruling `fixed`.
   Use `partial` (with `--fixed-in` for the part that shipped and `--note` for what's
   still open) for a fix that landed only in part — it never derives as fully `fixed`
   and never feeds regression detection, unlike `ack` + prose.
5. **archive** — rotation sweep; maintainer/CI housekeeping, not something a reporting
   agent needs to run.

Unknown flags are REJECTED, not silently dropped — an unrecognized flag exits non-zero
and nothing is written. Only `--sym-file`/`--repro-file` (on `report`) take file paths;
there is no `--note-file` or `--observed-file`.

## `class` and `sev` (closed vocabularies — copied verbatim from `hooks/lib/defect-store.js`)

- `class` (`CLASS_ENUM`, exactly these 8): `guard-false-positive`, `guard-miss`,
  `hook-crash`, `state-leak`, `messaging`, `doc`, `install`, `other`.
- `sev` (`SEVERITY_ENUM`, exactly these 3): `p0`, `p1`, `p2`.

Any other value is rejected (`invalid-class` / `invalid-severity`), not coerced.

## Safe input — NEVER build a shell string

Report bodies (symptom/repro text) can legitimately contain backticks, `$(...)`,
newlines, or quotes describing exactly what broke. Passing them through a shell string
risks command injection or corruption. Two safe paths:

- **Programmatic (preferred for anything non-trivial):** call `defect.js` via
  `execFileSync` with an **argument ARRAY**, never a concatenated shell string:
  ```js
  const { execFileSync } = require('child_process');
  execFileSync('node', [
    'plugins/anti-hall/scripts/defect.js', 'report',
    '--class', 'hook-crash', '--sev', 'p1',
    '--sym', symptomText,       // raw string, no shell escaping needed — argv, not a shell line
    '--repro', reproText,
  ], { encoding: 'utf8' });
  ```
- **File-backed for long/tricky bodies:** write the body to a file and pass
  `--sym-file <path>` / `--repro-file <path>` instead of `--sym`/`--repro`. The CLI reads
  the file's raw bytes directly — this is what makes backticks, `$(`, and embedded
  newlines round-trip byte-exact, with zero shell interpretation. `--sym`/`--repro`, if
  also given, win over the `-file` variant.

## Regression: just re-report the same symptom

There is no separate "reopen" verb. If a defect the maintainer ruled `fixed` shows up
again, **file a normal `report` with the same class/symptom** (whatever made the original
fingerprint match) — the CLI derives `regressed` vs `staleBuild` automatically by
comparing your report's installed version (`--v`, defaults to the local plugin version)
against the ruling's `--fixed-in`:

- Your `v` is at or past `fixedIn` → the defect is derived `regressed` (a genuine
  reappearance in a build that should have the fix).
- Your `v` predates `fixedIn` → status stays `fixed`, but the report is marked
  `staleBuild: true` (you're just running an old build — update anti-hall first).

Both `status` and `staleBuild` are printed back on `report`'s own result — check them,
don't assume `recorded`/`occurrence-appended` alone means "still open as before".

## When to file — and when NOT to

File when: you hit a reproducible anti-hall behavior — a guard false-positive or miss, a
hook crash, state that leaked or desynced, a broken doc pointer, an install/update
problem. **One symptom per report.**

Do NOT file: bugs in your OWN repo/project (this channel is for anti-hall itself, not
your codebase); speculation ("this might be a problem if..."); or a duplicate of
something already reported — dedup is automatic (same `class` + normalized symptom text
hashes to the same fingerprint and appends an occurrence instead of a new file), so just
report normally and let the CLI merge it.

## Outcome handling — a non-zero exit means NOT filed

`report`/`rule` exit 0 **only** on `recorded`/`occurrence-appended`/`ruled`. Every other
outcome — `registry-full`, `occurrence-capped`, `defect-full`, `too-large`,
`write-unverified`, `invalid-class`, `invalid-severity` — exits non-zero and means the
report/ruling was **NOT** recorded. Read the printed `outcome` field and say so plainly;
do not retry blindly (a retry against `registry-full`/`occurrence-capped`/`defect-full`
will fail identically — those are real, meaningful caps, not transient errors).

### Truncation is a SUCCESS that lost text — check `truncated`

Field length caps still apply (`sym` 200, `repro` 1200, `claimed`/`observed` 600, `note`
1200 chars). Over-cap content is cut, but never silently: the write still succeeds and
exits 0, AND the printed result carries a `truncated` map naming each cut field with its
`originalLength` and the `cap` it hit (the CLI also warns on stderr). Narrative fields
(`repro`, `claimed`, `observed`, `note`) additionally carry a `[truncated from N chars]`
marker inside the persisted value. If you see `truncated`, say so and re-file the missing
detail as a follow-up — do NOT report the record as complete.

## Reading rulings back

`list --mine` shows every defect matched by your identity (derived automatically —
`--proj`, then `ANTIHALL_DEFECT_PROJ`, then a git-repo key, then `no-repo`, with a
back-compat union so reports filed before this existed still match by their old cwd-
basename identity). Each entry's `status` reflects the maintainer's last ruling, or
`regressed`/`open` as derived above.
