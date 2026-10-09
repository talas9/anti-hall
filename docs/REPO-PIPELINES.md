# Repository pipelines and policies

How this GitHub repository is checked, released and protected. Pushes to `dev` run no CI by design: `main` changes only through a pull request from `dev`, and that pull request is the gate (see [`RELEASING.md`](../RELEASING.md)). Every third-party action is pinned to a full commit SHA; Dependabot proposes updates.

## Workflows (`.github/workflows/`)

| Workflow | Trigger | Purpose | Gates a merge to `main`? |
|---|---|---|---|
| `test.yml` (tests) | PRs, pushes to `main`, `rc-v*` tags | `node --test`, sharded over ubuntu/macOS × Node 22/24 (full matrix on `rc-v*`) | **Yes**: `tests-passed` is a required check |
| `pr-source.yml` | PRs to `main` | Rejects a PR to `main` whose source is not this repo's `dev` | **Yes**: `dev-only` is a required check |
| `codeql.yml` | Manual only (`workflow_dispatch`); disabled while CodeQL default setup is on | CodeQL scanning of JavaScript/TypeScript, workflows (`actions`) and Rust (once Rust sources are present) | No (alerts in Security → Code scanning) |
| `dependency-review.yml` | PRs to `main` and `dev` | Fails when a PR adds a dependency with a high or critical advisory | No (not a required check) |
| `pr-title.yml` | PRs to `main` and `dev` | PR title must follow Conventional Commits (`type(scope): summary`) | No |
| `scorecard.yml` | Pushes to `main`, weekly, branch-protection changes | OpenSSF Scorecard; publishes results and uploads SARIF | No |
| `release-drafter.yml` | Pushes to `main` | Updates a **draft** release grouped by `type:*` labels. Never publishes or tags | No |
| `pages.yml` | Pushes to `main`, manual | Builds and deploys the docs site to GitHub Pages | No |
| `ah-engine-release.yml` | Manual (prepare), `ah-engine-v*` tags (publish) | Builds, checksums and attests engine binaries; opens the lock PR; creates the engine release | No (release pipeline) |
| `issue-triage.yml` | Manual only (retired; superseded by `community.yml`) | Former one-comment triage; kept for manual use and disabled in Actions | No |
| `triage.yml` | Issue opened/edited, PR opened/updated | Maps issue-form answers to `priority:`/`size:`/`area:` labels; path-based `area:*` PR labels (`.github/labeler.yml`). Triage comments come from `community.yml` | No |
| `stale.yml` | Daily, manual | Labels issues/PRs inactive for 60 days and comments once. **Never closes or deletes**; `priority:P0`/`P1` exempt | No |
| `community.yml` | Issue/comment/discussion events, manual | Privacy scrub, moderation (hide/label/lock spam), rules-first triage brief and Q&A answer; optional model via `ai-model.yml`. Never closes or deletes | No |
| `pr-check.yml` | PR opened/updated (`pull_request_target`, no checkout), manual | Size/type/risk/needs-issue labels and one sticky checklist comment | No |
| `privacy-scan.yml` | PRs, pushes to `dev`/`main` | gitleaks + privacy rules on new commits; job `privacy-scan` fails on a hit | Yes (required on `main`) |
| `roadmap.yml` | Every 6 h, weekly, manual | Board sync, stale flag, weekly digest and automation mistake-rate report | No |
| `ai-model.yml` | Called by the above | Claude, then Copilot, then rules-only model step (`AI_PROVIDER`, `AI_DAILY_CAP`) | No |

Pull-request workflows cancel a superseded run of the same PR; every job has a `timeout-minutes`.

## Policy files

| File | Purpose |
|---|---|
| [`SECURITY.md`](../SECURITY.md) | Supported versions; report vulnerabilities through GitHub private vulnerability reporting |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Expected behaviour and how to report a problem |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Layout, tests, adding a guard |
| [`SUPPORT.md`](../SUPPORT.md) | Where to ask questions and report bugs |
| `.github/CODEOWNERS` | `* @talas9` |
| `.github/dependabot.yml` | Dependabot version updates (GitHub Actions, weekly, against `dev`) |
| `.github/release-drafter.yml` | Release-draft categories (`type:feature`, `type:bug`, `type:docs`, `type:ci`, `type:chore`) |

## Security settings (all free on public repositories)

| Setting | State |
|---|---|
| Secret scanning | On |
| Secret scanning push protection | On |
| Dependabot alerts | On |
| Dependabot security updates | On |
| Private vulnerability reporting | On |
| Code scanning | Default setup (Settings → Code security); `codeql.yml` is manual-only because advanced and default setup cannot run together |
| `main` ruleset | Blocks direct pushes, force pushes and deletion; requires `dev-only`, `tests-passed` and `privacy-scan` |
