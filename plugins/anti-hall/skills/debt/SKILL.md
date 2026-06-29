---
name: debt
description: Register and audit DELIBERATE technical debt via `// anti-hall: <ceiling>,<when>` markers — a budgeted, harvestable alternative to vague TODOs. Greps the tree for markers, parses each ceiling + payback trigger, and flags rot-risk (markers with no trigger, or in code untouched past a staleness threshold). Use when the user says "track this debt", "audit our debt", "what shortcuts did we take", "show the anti-hall markers", or "is this debt rotting". NOT a license to leave work undone — see boundaries.
---

# anti-hall:debt

A TODO says *something is unfinished* and rots silently. An **`anti-hall:` marker** says
*this shortcut was deliberate, here's the budget I accepted, and here's exactly when it must be
paid down* — so it can be harvested, audited, and flagged when it starts to rot. This skill is the
register and the auditor for those markers.

## The marker

Place an inline comment at the shortcut, in whatever comment syntax the file uses:

```
// anti-hall: <ceiling>, <when>
#  anti-hall: <ceiling>, <when>
/* anti-hall: <ceiling>, <when> */
```

- **`<ceiling>`** — the budget you *consciously accepted*: the limit past which this shortcut is no
  longer OK. Make it checkable. Good: `30 lines`, `O(n^2)`, `2 retries`, `single tenant`. Bad:
  `some`, `a bit`.
- **`<when>`** — the **payback trigger**: the concrete condition that makes this debt due. Good:
  `when >3 callers`, `when n>1000`, `when we drop node 18`, `when this hits prod`. This is the part
  that keeps debt from rotting — it names the signal to watch for.

Everything up to the **first comma** is the ceiling; everything after is the trigger.

```js
// anti-hall: 30 lines, when a 3rd backend needs it
function fakeRouter(x) { /* hard-coded 2-way switch, fine for now */ }
```

## What `/anti-hall:debt` does

It runs `plugins/anti-hall/scripts/harvest-debt.js` (pure Node, cross-platform, no deps), which:

1. **Greps** the target tree (default cwd; `--dir <path>`) for `anti-hall:` markers across all
   comment styles, skipping `.git`, `node_modules`, dot-dirs, and binaries.
2. **Parses** each into `{file, line, ceiling, when}`.
3. **Flags rot-risk** (`no-trigger`) when either:
   - **No trigger** — `<when>` is missing/empty. A deliberate skip with no payback condition has
     nothing to watch for, so it silently becomes permanent. This is the headline rot signal.
   - **Stale** — the file's last git commit touching it is older than the staleness threshold
     (default 90 days; `--stale-days N`). Budgeted debt nobody has revisited in a quarter is debt
     that's drifting out of mind. (Skipped automatically when git isn't available — fail-open.)

Invoke:

```
node plugins/anti-hall/scripts/harvest-debt.js              # human table
node plugins/anti-hall/scripts/harvest-debt.js --json       # machine-readable
node plugins/anti-hall/scripts/harvest-debt.js --dir src --stale-days 60
```

## Reading the report

```
anti-hall debt register   (3 markers · 1 rot-risk)

  src/router.js:12    ceiling: 30 lines   when: a 3rd backend needs it      ok
  src/cache.js:88     ceiling: O(n^2)     when: n>1000                      ok
  src/legacy.js:5     ceiling: 2 deps     when: —                  ⚠ rot: no trigger
```

- **ok** — budgeted debt with a live trigger; nothing to do until the trigger fires.
- **⚠ rot: no trigger** — add a `<when>`, or pay it down now. Don't leave it.
- **⚠ rot: stale (Nd)** — re-confirm the budget still holds; the world may have moved past it.

Use it as a **gate before a release or refactor**: harvest, and make sure no rot-risk marker is
hiding a shortcut the upcoming change would expose.

## Boundaries (read this)

- **A marker is not permission to skip real work.** anti-hall treats lazy `TODO`/placeholder/stub
  patterns as *blockers*, and that doesn't change. The marker is the **narrow, honest exception**:
  a debt you can defend out loud — with a budget and a trigger — and that you've registered so it
  can't hide. If you can't name a real ceiling and a real trigger, it's not deliberate debt; it's
  unfinished work. Finish it.
- **The ceiling is a contract.** If the code already exceeds its own stated ceiling, the marker is
  past due — treat it like a failing check, not a note.
- **Don't mass-annotate to silence a guard.** Sprinkling markers to make a backlog "look managed"
  is slop. One marker per genuinely-deliberate shortcut.
