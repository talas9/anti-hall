---
name: anti-hall-engine-github
description: "Use when committing, pushing, merging or releasing and a git or merge guard applies."
---

# Git and GitHub

Git, merge and release guards.

## Guards

- `git`: Port of the git-guard hook: blocks force pushes, remote ref deletion, AI self-credit in commits, handover commits, launcher-directory...
- `merge-side-pick`: Advisory: a push after a conflict was resolved by taking one side wholesale, with no test run since (port of merge-side-pick.js)
- `git-audit`: Advisory after a commit-creating git command: a commit made in the last 15 minutes carries an AI self-credit trailer (port of...
- `merge-gate`: Opt-in false-done backstop: answers every Bash call natively, including the block of an auto-merge after an unresolved self-hedge and...

## Switches

- `guards.gitAliasResolve` = true: Switch for git alias and shell definition resolution
- `safety.gitGuard` = true: Master switch of the check: settings.json section and key, environment variable and plugin-option name
- `guards.gitGuardHeredocData` = true: Switch for data-heredoc masking
- `guards.gitReusedMessageCheck` = true: Switch for the reused-commit-message check
- `guards.mergeGate` = false: Where the opt-in switch is read from (guards.mergeGate, default off)
- `guards.mergeSidePickAdvisory` = true: Where the on/off switch is read from (guards.mergeSidePickAdvisory, default on)
- `guards.shipitGate` = false: Where the opt-in switch is read from (guards.shipitGate, default off)
- `guards.gitignoreHint` = true: Switch: the weekly reminder to git-ignore .anti-hall/ (guards.gitignoreHint)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
