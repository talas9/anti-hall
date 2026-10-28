---
title: Repository pipelines
description: How the anti-hall repository is tested, moderated and released, at a glance.
---

# Repository pipelines

A short tour of the automation around the repository. Step-by-step runbooks for
maintainers live in the
[project wiki](https://github.com/talas9/anti-hall/wiki/Repo-automation).

## Release flow

```text
short-lived branch ──► dev ──► pull request ──► main ──► tag vX.Y.Z ──► GitHub Release
                     (path CI) (required checks)  (docs deploy)  (immutable)
```

- Work lands on `dev`. Pushes to `dev` run only the path-filtered engine workflow and the privacy scan, so the local test suite is the gate.
- `main` changes only through a pull request from `dev`. Merging that pull request is the
  release, and the docs site deploys from it.
- Release tags (`vX.Y.Z`, `ah-engine-vX.Y.Z`) are immutable: they are never moved or
  deleted. A wrong release is fixed with a new version.

## CI layout

Required checks and the working rules are in [Development guide](DEVELOPMENT.md#merge-model).

| When | What runs |
|---|---|
| Pull request or push to `dev`, touching engine, launcher, plugin engine files | `ah-engine` workflow: `rust` (Linux gate with `./test.sh`, macOS build and smoke), `ah-hook` build on both, `doc-check` |
| Pull request touching `ah-engine/`, `ah-launcher/`, `plugins/anti-hall/` | `no-node` (Linux and macOS) |
| Every pull request | `tests-passed` (placeholder), `privacy-scan`, `pr-title`, PR check labels |
| Pull request to `main` | `dev-only` (source must be `dev`); strict docs build when docs change |
| Push to `main` | docs deploy (when docs change), `tests-passed`, `privacy-scan` |
| Nightly and weekly | Full engine suite on both OSes, hardening bar, weekly full `doc-check`; a failure opens or updates one issue |

Pushes to `dev` run the path-filtered engine workflow and the privacy scan only.

## Repo automation

Issues, pull requests and discussions are handled **rules first**: labels, duplicate
checks, spam and privacy checks and the roadmap board are plain rules. A model is only
asked to add research, wording or an escalation to a human, and never closes or deletes
anything.

| Part | What it does |
|---|---|
| Triage | Labels, milestone and a short brief on new issues |
| Moderation | Hides or labels spam and abuse; escalates to review |
| PR check | Size, type and risk labels plus one checklist comment |
| Privacy scan | Blocks private paths, emails and session ids in new text and diffs |
| Roadmap manager | Keeps the project board in sync, marks issues done when their PR merges, and posts a weekly digest |
| Dependency updates | Patch and minor bumps merge once every check is green; a major bump waits for a human |

!!! note "Model chain"
    When a model is used, the order is Claude (primary token), Claude (secondary token),
    then rules only. GitHub Copilot is off by default (`copilot_fallback` is `false` in
    `.github/moderation/config.json`); set it to `true` to add Copilot as the last slot. Each job picks its model from
    `.github/moderation/config.json`; no model version is pinned in a workflow.
