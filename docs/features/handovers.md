---
title: Handovers and context
description: Automatic and manual session handovers, resuming after /clear or a compaction, and how anti-hall keeps context use down.
---

# Handovers and context

A long session fills its context window. When that happens, Claude Code compacts the
conversation into a summary, and details get lost: what was tried, what failed, the exact
next step. anti-hall writes those details to a **handover** file first, so a fresh
context can pick up where the old one stopped.

## Automatic handover at 85%

When the main agent's context use reaches **85%** (`autoHandover.pct`), anti-hall tells
it to write a handover right away, without asking you first. Once the handover is saved,
the assistant ends its reply with one clear line telling you what to run next, for
example:

```text
🟢 GOOD POINT TO /compact NOW: handover saved at <path>. /compact keeps working on the
same task; /clear if the next task is different.
```

After that:

- if the handover goes stale because work continued, the assistant is told to refresh
  it;
- you get short reminders as context keeps growing (`autoHandover.nag`);
- a large new request is checked against the space left. The assistant offers to park
  it in the task list and the handover, to start after `/compact` or `/clear`, or to go
  ahead if you insist (`autoHandover.gateNewWork`).

On Codex the same messages name Codex's commands (`/new` instead of `/clear`).

## Writing one yourself

Say **"handover"** or **"save session state"**, or run `/anti-hall:handover`. It is a good
idea before `/compact`, `/clear`, or the end of a work session.

The skill writes under `.anti-hall/handovers/` in your project:

- a short `HANDOVER.md` with a fixed layout: goal, where things stand, the next step,
  decisions, dead ends and what has been verified;
- detail files next to it (state, decisions, trials, knowledge);
- an index that links each handover to the one before it.

Handovers are local session state. They are never committed: `git-guard` blocks a commit
that includes one (`guards.handoverCommitGuard`).

## Resuming

After `/clear`, a compaction, or a new session in the same project, the `handover-resume`
hook finds the newest handover and points the assistant at it with a short resume
procedure. It adds git facts measured at that moment (current commit, commits since the
handover, changed files), so the assistant can tell whether the handover is still
current. It only passes the path; the assistant reads the file itself.

## Keeping context small

Other parts of anti-hall slow down how fast the context fills:

- [`command-guard` and `edit-guard`](guards.md#why-the-main-session-hands-work-off) send
  long output and edits to helper agents, which return a summary;
- the per-turn text anti-hall adds is short, and the session-start rules use a compact
  version by default (`context.protocolLevel`);
- **limit conservation** (`limitConserve.mode`, default `auto`): when your plan's usage
  passes `limitConserve.threshold` (default 85%), each turn tells the assistant to route
  expensive work to cheaper models or to Codex. In `auto` mode it reads usage from the
  oh-my-claudecode (OMC) usage cache, so it needs OMC; `on` forces it.

Background on why handovers are built this way:
[Session handover research](../KB-session-handover.md).
