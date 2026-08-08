---
name: handover
description: Use when the user says "prepare a handover", "handover", "write a handoff", "save session state", "hand this off", before /compact or /clear, at session end, or before ending work on a long task — writes a comprehensive, organized, minimal-but-lossless session handover so a fresh session can resume without re-deriving or guessing anything.
---

# Handover

Prepares a session handover: perishable job state (goal, current position, next
executable step, decisions, dead ends, verification status) written to disk so a
fresh session — with no memory of this one — can resume correctly and completely.
Built from anti-hall's `docs/KB-session-handover.md` (repo-clone-only; not
bundled with `/plugin install`, like all `docs/` — when citing it in handover
files, name it as the anti-hall repo's doc: the target project won't have that
path).

**Handover ≠ memory.** Durable rules, conventions, and architecture facts belong in
`CLAUDE.md`/`AGENTS.md` and project memory — they persist because they're always
true. A handover is job state for THIS session — it's true today and stale next
week. Never write durable knowledge into a handover file (it'll rot there,
unread); never write perishable job state into `CLAUDE.md` (it'll bloat the
always-loaded context). If you learn something durable while writing a handover,
route it to `CLAUDE.md`/project memory separately — don't smuggle it into
`decisions.md`.

## Self-write mandate (read first)

The handover is written **by the agent holding the session context** —
**never delegate the writing to a subagent**: a subagent never lived this
session, so its reconstruction loses decision/trial fidelity (a field
failure: a session delegated handover-writing to a subagent even after
loading this skill). This is the documented exception to the
delegation-first/orchestrate-only doctrine — `edit-guard.js` lets the
coordinator Write/Edit handover files directly under
`.anti-hall/handovers/**` (and redirects NEW handover-named `.md` writes
elsewhere back to that path), so self-write never needs a subagent detour.

## Artifact layout

```
.anti-hall/handovers/
  INDEX.md                              # global index — one row per handover, appended, never rewritten
  <YYYY-MM-DD>/<session-id>/
    HANDOVER.md                         # seq 1, the main file (<=200 lines, front-loaded)
    HANDOVER-2.md, HANDOVER-3.md, ...   # later handovers in the SAME session; each names its predecessor
    state.md                            # repo/git/env state
    decisions.md                        # every decision, in sequence, with rejected alternatives
    trials.md                           # everything attempted, chronological, incl. abandoned approaches
    knowledge.md                        # KB/docs/research consulted, learned facts, gotchas, source-of-truth pointers
```

This mirrors `.anti-hall/progress/` and `.anti-hall/history/` — same navigation
model: read `INDEX.md` first, open only what it says is relevant.

## Session id and date

- Prefer the harness's own session id (e.g. the value in a hook's `session_id`
  field) if you know it.
- Otherwise fall back to the SAME style tasklist-guard uses: a sha1 hash of the
  transcript path, first 16 hex characters. If neither is available, use a short,
  stable human slug (lowercase, hyphenated, e.g. `auth-refactor-session`) — stable
  meaning: reuse the SAME slug across handovers written in the same session, don't
  regenerate it each call.
- Date = today, `YYYY-MM-DD`.

## Sequencing

Count existing `HANDOVER*.md` files in `<date>/<session-id>/`. Seq = count + 1.
- Seq 1 → `HANDOVER.md`.
- Seq N>1 → `HANDOVER-N.md`, and its "Predecessor" slot names the immediately
  prior file (`HANDOVER.md` for seq 2, `HANDOVER-2.md` for seq 3, etc).
If re-invoked for a seq that already exists in this same session (rare — e.g. the
agent explicitly asks to refresh the just-written handover), UPDATE that file in
place rather than incrementing again.

## HANDOVER.md contract

**≤200 lines. Front-loaded**: the first ~15 lines are Situation (2-3 lines) plus a
single concrete NEXT ACTION — one thing the next session can execute immediately,
no interpretation required. Skill/context re-injection truncates by keeping the
file's START (docs/KB-session-handover.md, principle O4) — everything load-bearing
goes early; sources and full chronology go last, where losing them costs least.

Fixed section order, every time (SBAR-derived, docs/KB-session-handover.md's
consolidated schema):

1. **Situation** — 2-3 lines: what this session was doing.
2. **Goal + definition of done** — one sentence each.
3. **Done + Verified** — with evidence: `file:line`, the command run, and its
   actual output/result. Never "tests pass" without the command and a real output
   summary.
4. **NOT verified / verification gaps** — mandatory, explicit. If nothing is
   unverified, say so explicitly; don't just omit the section.
5. **Open items** — numbered, prioritized; the pending/in-progress subset of
   state.md's Task list snapshot, one line each — point at state.md for the
   full snapshot.
6. **Decisions summary** — one line each, pointing into `decisions.md` for the
   reasoning.
7. **Do-not-repeat summary** — pointing into `trials.md`.
8. **Detail-file pointer table** — one row per detail file: `file · what's inside
   · "read this when ..."` — so the next session loads selectively instead of
   reading everything.
9. **Predecessor link** — the previous `HANDOVER*.md` in this session, or `none`.
10. **Resume-verification checklist** — concrete steps to run BEFORE trusting
    this document: `git status`, `pwd`, re-read `CLAUDE.md`, and a smoke/test
    command specific to this repo. Directly counters two documented post-compact
    failures: behavioral rules silently dropped (F1 — hence the `CLAUDE.md`
    re-read) and stale repo/directory state (F2) — docs/KB-session-handover.md.
    After running it, **append** a `resume-verified: <ISO timestamp> --
    <one-line git-status/pwd/smoke summary>` line to this file — this is what
    proves the checklist actually ran, not just that it was written down.
    `tasklist-guard.js` backs this up mechanically (v0.75.0): when
    `handover-resume.js` injected a resume pointer this session and this
    session then makes file-changing actions with no `resume-verified:` line
    ever landing in the referenced file, one capped Stop-hook nudge fires.

Everywhere: concrete over vague ("2-space indentation", not "format properly").
Pointers over payloads — reference files/commits/artifacts by path, never inline
large content. Dedup ruthlessly; no narrative padding; no transcript replay (the
single worst format per the KB's own tool survey).

### HANDOVER.md skeleton

```markdown
# Handover — <session-id> · seq <N> · <YYYY-MM-DD>

## Situation
<2-3 lines>

## Next action
<one imperative, executable step>

## Goal + definition of done
<1-2 lines>

## Done + Verified
- <claim> — evidence: `path:line`, command `<cmd>` → `<real output summary>`

## NOT verified / gaps
- <explicit list, or "none — everything claimed above was verified this session">

## Open items
1. <prioritized>

## Decisions summary
- <one line> → decisions.md

## Do-not-repeat summary
- <one line> → trials.md

## Detail files
| file | contents | read this when |
|---|---|---|
| state.md | ... | ... |
| decisions.md | ... | ... |
| trials.md | ... | ... |
| knowledge.md | ... | ... |

## Predecessor
<path to prior HANDOVER*.md, or "none">

## Resume-verification checklist
- [ ] `git status` — expect: <what>
- [ ] `pwd` — expect: <path>
- [ ] re-read `CLAUDE.md` — rules may have been dropped by compaction
- [ ] `<smoke/test command>` — expect: <result>

resume-verified: <ISO timestamp> -- <one-line git-status/pwd/smoke summary>
```

## Detail-file templates (each also front-loaded, fixed schema)

**state.md** — repo/git/env state:
```markdown
# State — <session-id> seq <N>

Branch: <name> | Clean/dirty: <status> | Last commit: <sha short + subject>
Unpushed: <yes/no, what>
Uncommitted files: <list>
Running processes: <list, or "none">

## Task list snapshot
| id | subject | status | priority | blocked-by |
|---|---|---|---|---|
| ... | ... | pending/in_progress/completed | P0/P1/P2/... | ... |

## Commands run this session (with actual results)
- `<command>` → `<real output, trimmed>`
```

**decisions.md** — append-only, every decision in sequence:
```markdown
## <YYYY-MM-DD HH:MM or seq marker> — <decision title>
What: <the decision>
Why: <reasoning>
Rejected alternatives: <alternative> — <why rejected>
```

**trials.md** — append-only, chronological, includes abandoned attempts:
```markdown
## <what was attempted>
Outcome: <succeeded/failed/abandoned>
Why abandoned (if applicable): <reason>
Do not repeat: <what NOT to try again, and why>
```

**knowledge.md** — KB/docs/research consulted:
```markdown
## <doc/URL path>
What was taken from it: <summary>
Learned facts / gotchas: <list>
Source-of-truth pointer: <yes/no — is this the authoritative source for X>
```

## INDEX.md row format

One row per handover, appended (never rewritten), newest last — same convention
as `.anti-hall/progress/INDEX.md`:

```
- YYYY-MM-DD · <session-id> · seq N · <one-line outcome> · [subsystems] · [main](<date>/<session-id>/HANDOVER.md)
```

## Behavior on invoke

1. Determine session id (harness id, or sha1-of-transcript-path fallback, or a
   stable slug) and today's date.
2. Compute seq = (existing `HANDOVER*.md` count in this session's dir) + 1.
3. Write/update the 5 files: `HANDOVER.md` (or `HANDOVER-N.md`), `state.md`,
   `decisions.md`, `trials.md`, `knowledge.md`. Detail files are append-only
   across a session's multiple handovers (seq 2 appends to seq 1's `state.md`
   etc., doesn't overwrite); `HANDOVER*.md` itself is a fresh file per seq.
4. Append the `INDEX.md` row (create `INDEX.md` if it doesn't exist yet).
5. Report to the user EVERY path written this call — the handover directory,
   each of the 5 files (`HANDOVER*.md`, `state.md`, `decisions.md`, `trials.md`,
   `knowledge.md`), and the exact `INDEX.md` row appended — plus a one-line
   summary of what was captured. Don't summarize the paths away; list them.

## Automatic resume

A companion SessionStart hook, `handover-resume.js`, closes the loop so a
written handover is actually picked up next time: on `clear`, `compact`, or a
fresh `startup`/`resume`, it scans `.anti-hall/handovers/` for the newest
`HANDOVER*.md` (preferring one from the SAME session over a merely newer one
from a different session) and, if it's 7 days old or newer, injects a pointer
to its path plus the numbered Guided Resume Path from "Next-session usage"
above — never the file's content. That injection explicitly states the
handover SUPERSEDES the auto-compact summary and any legacy
`CONTINUE-HERE`-style file for continuation state. This means writing a
handover is not just documentation — it is what the next context actually
resumes from.

**Write proactively** — at task boundaries or when compaction risk is rising, not
only when explicitly asked and not at the context ceiling (`/compact` itself can
fail once the ceiling is hit — docs/KB-session-handover.md, F4). If you notice a
natural task boundary during a long session, it's reasonable to say so and offer
to write a handover rather than waiting to be asked.

## Before ending: quiesce, declare, stay honest

**Quiesce gate.** Before declaring safe to compact/clear, reach a safe point:
finish/park the current micro-task, enumerate every running background item
(task list, background agents, workflows, monitors), and for each: await it,
stop it, or record it in `HANDOVER.md`'s Open items as STILL RUNNING with its
id and re-attach instructions. While unmet, say WAIT, not done: `⏳ **NOT SAFE
to compact yet** — waiting on: <named items>. I'll tell you the moment it's
safe.` Once met, the final message is: `✅ **HANDOVER COMPLETE — SAFE TO
COMPACT OR CLEAR NOW**` + `<saved paths list>` + `<numbered instructions:
/compact or /clear; the resume hook guides the fresh session automatically>`.

**Terminal declaration.** The ✅ SAFE line is the LAST act of the turn — work
after it makes the handover STALE; refresh it (same seq, or seq+1) and
re-declare before claiming safe again. `tasklist-guard.js` backs this up
mechanically: file-changing work after the newest `HANDOVER*.md`'s mtime gets
a capped "handover is STALE" advisory on its Stop output.

## Next-session usage

1. Read `.anti-hall/handovers/INDEX.md` → find the newest relevant row.
2. Open that row's `HANDOVER.md` (or the highest `HANDOVER-N.md` in that
   session's directory, if later seqs exist — check its Predecessor chain if
   unsure which is newest).
3. Run the Resume-verification checklist BEFORE trusting anything else in the
   file, THEN append the `resume-verified:` line to it — `tasklist-guard.js`
   nags (once, capped) if file-changing work happens this session without one.
4. Page in detail files only as needed, per the Detail-file pointer table's "read
   this when" column — progressive disclosure, not a full read of everything.
5. Recreate/reconcile your task list (TaskCreate/TaskUpdate or TodoWrite) from
   state.md's Task list snapshot BEFORE starting any work — the snapshot is
   the source of truth for what's pending/in-progress/blocked.
