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
                     (no CI)   (required checks)  (docs deploy)  (immutable)
```

- Work lands on `dev`. Pushes to `dev` run no CI, so the local test suite is the gate.
- `main` changes only through a pull request from `dev`. Merging that pull request is the
  release, and the docs site deploys from it.
- Release tags (`vX.Y.Z`, `ah-engine-vX.Y.Z`) are immutable: they are never moved or
  deleted. A wrong release is fixed with a new version.

## CI layout

| When | What runs |
|---|---|
| Pull requests | Lean run: Node 24, Linux and macOS shards |
| Release candidate tags, tags, pushes to `main`, weekly | Full matrix: Linux and macOS, Node 22 and 24 |
| Nightly | Engine parity suites and timing benchmarks, kept out of the per-PR run |
| Pull requests touching docs | Strict docs build (broken links or pages fail it) |

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
