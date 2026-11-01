---
name: engine-github
description: "Use when committing, pushing, merging or releasing and a git or merge guard applies."
---

# Git and GitHub

Git, merge and release guards.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine gh` | `<status\|segment\|poll> [--cwd <dir>] [--force]` GitHub realtime (feature #20, independent of DevSwarm): `status` prints, from the state file... | main, codex, workspace, subagent (owner args: poll) |
| `ah-engine gh_poll` | `` The scheduled GitHub realtime tick (the `gh_poll` job): notices pushes, polls the followed repos... | main, codex |

## Guards

- `git`: Port of the git-guard hook: blocks force pushes, remote ref deletion, AI self-credit in commits,...
- `merge-side-pick`: Advisory: a push after a conflict was resolved by taking one side wholesale, with no test run since
- `git-audit`: Block after a Bash call: a commit git wrote in the last 15 minutes (reflog) carries an AI...
- `merge-gate`: Opt-in false-done backstop: answers every Bash call natively, including the block of an...
- `gh-rt-advisory`: Advisory (UserPromptSubmit, engine-only): tells a session about GitHub edges in its repo, once...

## Switches

- `guards.gitAliasResolve` = true: Switch for git alias and shell definition resolution
- `guards.gitCommitAudit` = true: Switch for the authoritative post-call commit check (PR #469): off lets a commit with an AI...
- `guards.gitCommitExpansionCheck` = true: Switch for the unresolved-shell-expansion check on inline commit messages (GH #457): off lets a...
- `safety.gitGuard` = true: Master switch of the check: settings.json section and key, environment variable and...
- `guards.gitGuardHeredocData` = true: Switch for data-heredoc masking
- `guards.gitPushCreditCheck` = true: Switch for the pre-push credit backstop (GH #457): off lets a push through although an unpushed...
- `guards.gitPushCreditScope` = false: Switch for narrowing the pre-push credit check to the commits a push sends (GH #506): off (the...
- `guards.gitReusedMessageCheck` = true: Switch for the reused-commit-message check
- `guards.mergeGate` = false: Where the opt-in switch is read from (guards.mergeGate, default off)
- `guards.mergeSidePickAdvisory` = true: Where the on/off switch is read from (guards.mergeSidePickAdvisory, default on)
- `guards.shipitGate` = false: Where the opt-in switch is read from (guards.shipitGate, default off)
- `guards.gitignoreHint` = true: Switch: the weekly reminder to git-ignore .anti-hall/ (guards.gitignoreHint)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
