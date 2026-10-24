# Contributing to anti-hall

Thanks for helping. anti-hall is a Rust engine (`ah-engine`) behind a Rust thin client (`ah-hook`), with its rules as plugin JS run inside the engine and every value and text in plugin TOML; it runs on macOS and Linux. The original Node hooks are a backup outside the published plugin (`plugins/anti-hall-node`) and get bug fixes only: no new Node code. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Project layout

| Path | What lives there |
|---|---|
| `plugins/anti-hall/hooks/` | `hooks.json` (one thin trigger per event, generated from `engine/defaults/dispatch.toml`) (the plugin ships no shell file) |
| `plugins/anti-hall/engine/` | The engine's plugin files: `logic/*.js` (rule logic run by the engine's script host, not Node) and `defaults/*.toml` (every setting, table and text; `defaults.pristine/` is the byte-identical read-only copy) |
| `ah-engine/`, `ah-launcher/` | The Rust engine and the thin client `ah-hook` |
| `plugins/anti-hall-node/` | The Node backup (not published): the original hooks, `doctor.js`, `lib/` |
| `plugins/anti-hall/codex/` | The Codex port: `hooks/hooks.json`, `skills/`, `scripts/`, `install-codex.js` |
| `plugins/anti-hall/skills/`, `monitors/`, `statusline/` | Claude skills, monitors, statusline docs |
| `docs/` | `GUIDE.md` (extended guide, hook and settings tables) and the knowledge-base files |
| `README.md`, `llms.txt`, `AGENTS.md` | Public docs, the LLM-readable index, and the cross-tool agent protocol |

## Verify a change

Building the Rust engine and the porting workflow are in the [Development guide](docs/DEVELOPMENT.md). There is no Node test suite: a change is verified with `cargo check` on the touched crate, one release build, a deploy to a live root with `scripts/engine-deploy.sh` and a live check.

```bash
cargo check --manifest-path ah-engine/Cargo.toml     # the touched crate
ah-hook doctor --check                               # health check of a working copy
```

A green local build is not a green CI run: check the GitHub Actions result on your pull request before calling work done. Pushes to `dev` run no CI.

## Isolation

Anything you run by hand must never touch the real home directory or the real `~/.anti-hall`. Point `HOME` and `USERPROFILE` at a temp dir, and set `AH_ENGINE_PLUGIN_ROOT` to the plugin tree you mean to try.


## Adding or changing a guard

1. Implement the check in the engine: its logic in `plugins/anti-hall/engine/logic/<name>.js` (run by the engine's script host) or a Rust built-in under `ah-engine/src/checks/`, with every value and text in `plugins/anti-hall/engine/defaults/*.toml` (both defaults directories). Do not add a Node hook. Register it as a row of the dispatch table in `plugins/anti-hall/engine/defaults/dispatch.toml` (`dispatch.hooks_claude_<Event>`: id, matcher, command, timeout, check). `hooks.json` is one thin trigger per event, generated from that table: run `cargo run --manifest-path ah-engine/Cargo.toml --bin ah-gen-fallback-list -- --repo .` to regenerate it, the per-hook registry (`hooks/hooks.registry.json`, which the Node readers and tests read) and the fallback lists.
2. Add the Codex twin as a row of `dispatch.hooks_codex_<Event>` in the same table (and `plugins/anti-hall-node/codex/install-codex.js` where it lists hooks), or state in the PR why Codex does not apply.
3. Add the user-facing setting to `plugins/anti-hall/engine/defaults/settings_cli.toml`. Give it a `section`, a key and a default, nothing else: it is reachable through `/anti-hall:settings`, grouped by category. Do NOT add a `userConfig` row to `plugins/anti-hall/.claude-plugin/plugin.json`: it declares only the 10 headline switches (`headline: true` in the schema) and the 4 sensitive keys.
4. Document it: a row in the hook table and the settings table of `docs/GUIDE.md`, the hook in `llms.txt`, and the operator guide `plugins/anti-hall/skills/system-briefing/SKILL.md` (plus its Codex mirror).
6. Prove it live: for a guard that blocks, try the dangerous forms that must stay blocked, not only the allowed one, on a deployed build.

### Fail-open

Hooks fail open: a parse, read or state error exits 0 without blocking or wedging a turn ([AGENTS.md](AGENTS.md), `docs/GUIDE.md`). The docs define no separate fail-closed mode, so a guard should block only on a positive match of the dangerous form; if you think one needs different behaviour, discuss it in an issue first. Never widen a guard's allow path without tests showing the dangerous forms stay blocked.

### Settings

Settings live in `~/.anti-hall/settings.json` and change only through `/anti-hall:settings` or `ah-hook settings` (`show`, `get`, `set`, `reset`), never by hand ([AGENTS.md](AGENTS.md)). Resolution order: env, file, stored plugin option, legacy, default. Settings readers must honour an injected `HOME` and never fall back to `os.homedir()`; `tests/hygiene/settings-home-injection.test.js` enforces that.

## Both ports, always (dual-platform parity)

A change to a hook, skill or model-routing doc lands on the Claude side and the Codex mirror under `plugins/anti-hall/codex/`, or the PR states why one side does not apply. Docs follow the same rule. Details: the "Dual-platform parity" section of [AGENTS.md](AGENTS.md).

## Commits and pull requests

- Use conventional messages as in `git log`: `fix(area): ...`, `feat(area): ...`, `docs: ...`, `test(area): ...`, `chore(release): ...`.
- **No AI credit.** No `Co-Authored-By` trailers, "Generated with" lines or assistant-attribution links in commits or in PR, issue or release text. `git-guard` blocks them. See [AGENTS.md](AGENTS.md) and [RELEASING.md](RELEASING.md).
- Never force-push; do not delete branches or data without the maintainer's say-so.
- Keep shipped files project-agnostic and user-agnostic: no private names, paths or emails, other than the author credit.
- A pull request template lists the checklist.

## Branches, builds, releases, tags

### Issues first

Every piece of work has an issue. Feature requests and bugs go through the [issue forms](https://github.com/talas9/anti-hall/issues/new/choose), which ask for priority, area and an estimate (S up to 2 hours, M up to 1 day, L up to 3 days, XL more than 3 days). `.github/workflows/community.yml` turns those answers into `priority:*`, `size:*` and `area:*` labels and adds `status:triage`; a maintainer moves the issue to `status:accepted`, `status:in-progress` or `status:blocked`. Pull requests get `area:*` labels from the paths they change (`.github/labeler.yml`). The maintainer tracks the work on a GitHub Projects board, with one view each for work in progress, accepted work, triage and milestones.

### Branch model

- **`dev`** is the working branch. Day-to-day work is committed and pushed there; pushes to `dev` run no CI. A ruleset blocks force pushes and deletion of `dev`; direct pushes stay allowed.
- **`main`** is what users and the plugin directory install from. It changes only through a pull request from `dev`: the required `dev-only` check (`.github/workflows/pr-source.yml`) fails for any other source, and the `main protection` ruleset also requires `tests-passed`, blocks direct pushes, force pushes and deletion, and allows merge commits only (never squash or rebase, so `dev` and `main` stay in step). Every merge to `main` is a release-quality event.
- **Contributors: open your pull request against `dev`.** A pull request to `main` from a fork or from any other branch cannot merge.
- **Short-lived branches** (a contributor's change, a parallel lane) are named `<type>/<issue#>-<slug>`, for example `fix/42-statusline-deadline`. They branch from `dev`, merge back into `dev` and are deleted after the merge. Long-lived branches (`dev`, `main` and the engine integration branches) are never deleted, and a ruleset blocks force pushes to them.
- Dependabot opens its pull requests against `dev` (`.github/dependabot.yml`, `target-branch: dev`).

### Commits and pull requests reference the issue

- Conventional messages as in `git log`: `type(area): summary`, for example `fix(hooks): ...`, `feat(engine): ...`, `docs: ...`, `test(area): ...`, `ci(repo): ...`, `chore(release): ...`. Mention the issue (`#42`) in the message.
- A pull request body says `Closes #42` (one line per issue) so the issue closes when the change reaches the default branch.
- No AI credit lines, and never a force push (see "Commits and pull requests" above).

### Builds and CI

- **Local gate first.** Run `cargo check` and a release build of what you touched before you push. Pushes to `dev` and to short-lived branches run no CI.
- **CI gates pull requests to `main` and releases.** A pull request runs the engine workflow (`ah-engine.yml`); `ah-engine-v*` tags run the engine publish workflow. Check the Actions result before calling a release done: a green local run is not a green CI run.

### Releases

Maintainers follow [RELEASING.md](RELEASING.md); this section does not repeat its checklist. In short: bump the version and write the CHANGELOG section on `dev`, open the `dev` → `main` pull request, merge it with a merge commit once CI is green, then tag. Contributors normally do not bump versions.

### Tags

- `vX.Y.Z` marks a plugin release; `ah-engine-vX.Y.Z` marks an engine release (pushing it runs the engine publish workflow); `rc-vX.Y.Z[.N]` marks a release candidate for the full CI matrix.
- Never move or delete a `v*` or `ah-engine-v*` tag. A tag ruleset blocks deletion, updates and force updates of both; creating a new tag stays allowed. A wrong release is fixed with a new version, never by re-tagging.
- Release-candidate tags are not protected; the maintainer prunes old ones (RELEASING.md).

### Version authority

The version lives in `plugins/anti-hall/.claude-plugin/plugin.json`. The Codex manifest (`plugins/anti-hall/.codex-plugin/plugin.json`), root `package.json` and `package-lock.json` track it and must match. The marketplace entry carries no version. `CHANGELOG.md` gets a section per release.

## Before you open a pull request

1. `cargo check` and a release build of what you touched.
2. Run `ah-hook doctor --check`.
3. Fill in the pull request template honestly; "N/A, because ..." is a fine answer.

## Questions and problems

- Ask questions, report bugs and false positives, or propose features through the [issue chooser](https://github.com/talas9/anti-hall/issues/new/choose) for now.
- Security issues: [SECURITY.md](SECURITY.md); never a public issue.

## Issue triage bot

A new issue gets its form answers mapped to labels by `.github/workflows/triage.yml` (no model, no secret). It also gets one automated first-pass comment and labels from `.github/workflows/issue-triage.yml`. It only reads the issue, adds labels and posts that single comment; a maintainer always follows up. Maintainers enable it by setting the `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) repository secret; without one it does nothing.
