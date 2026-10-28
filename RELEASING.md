# Releasing anti-hall

Every behavioral or shipped-content change bumps the version and follows this checklist. The agent (not CI) performs the tag manually.

## Components and versions

Four components, each with its own semver. Versions read from `origin/dev`.

| Component | What it is | Single file that sets the version | Current | Tag / release |
|---|---|---|---|---|
| plugin | The Claude plugin and its Codex port (hooks config, skills, docs, engine defaults) | `plugins/anti-hall/.claude-plugin/plugin.json`; the Codex manifest `plugins/anti-hall/.codex-plugin/plugin.json`, root `package.json` and both fields in `package-lock.json` track it | 0.301.1 (all four files) | `v<ver>` (latest pushed tag: `v0.300.2`; 0.301.1 not tagged yet) |
| engine (`ah-engine`) | The Rust daemon that decides every hook | `ah-engine/Cargo.toml` (the binary reads `CARGO_PKG_VERSION`) | 0.2.0 | `ah-engine-v<ver>` (latest: `ah-engine-v0.2.0`); pinned by `ah-engine.lock` |
| hook client (`ah-hook`) | The thin client every hook entry runs | `ah-launcher/Cargo.toml` | 0.2.0 | no tag of its own; ships inside the engine release archive |
| dashboard (`ah-web`) | The local web dashboard | `ah-web/Cargo.toml` | 0.2.0 | no tag of its own; ships inside the engine release archive |

Because the hook client and the dashboard ship inside the engine archive, a change to either needs an engine release (new `ah-engine-v<ver>`) to reach users.

## Version dependencies

Each component declares the lowest version it accepts of the others. A mismatch is reported (status, doctor, one log line) and never blocks a session. Values on `origin/dev`; row = the component that needs, column = the minimum it requires.

| Needs, below | plugin | engine | hook client | dashboard |
|---|---|---|---|---|
| plugin | - | 0.2.0 | 0.2.0 | 0.2.0 |
| engine | 0.301.1 | - | 0.2.0 | 0.2.0 |
| hook client | not declared | 0.2.0 | - | not declared |
| dashboard | not declared | 0.2.0 | not declared | - |

Where each is declared:

| Row | Declared in |
|---|---|
| plugin | `[compat.engine_min]`, `[compat.hook_min]`, `[compat.web_min]` in `plugins/anti-hall/engine/defaults/engine.toml` (and the same keys in `plugins/anti-hall/engine/defaults.pristine/engine.toml`). Data, read at run time: no rebuild. |
| engine | `PLUGIN_MIN`, `HOOK_MIN`, `WEB_MIN` in `ah-engine/src/compat.rs` (constants of the build). |
| hook client | `ENGINE_MIN` in `ah-launcher/src/compat.rs`; sent to the engine with each request (`env.hook_engine_min`). |
| dashboard | `ENGINE_MIN` in `ah-web/src/compat.rs`; shown on the Updates page. |

**Old numbering.** `launcher.legacy_scheme_floor` (`plugins/anti-hall/engine/defaults/engine.toml`, currently `0.300.0`) marks the first version of the old scheme, when engine, hook client and dashboard carried the plugin's number (0.300.x / 0.301.x). A component version at or above the floor counts as OLDER than any version below it, so `0.301.1` is older than `0.2.0` and the move to the new numbers needs no `--force`. Plugin versions never go through this floor.

**Rule.** Bump only the component whose source changed. Raise a minimum only when a real incompatibility is introduced (the newer side cannot work with the older one); a routine release leaves every minimum alone.

## Branch flow

- Day-to-day work is committed and pushed to `dev`. Pushes to `dev` run no CI, so `cargo check` and a release build of what changed before pushing.
- `main` changes only through a pull request from `dev`. A repository ruleset blocks direct pushes, force pushes and deletion of `main`.
- A pull request to `main` runs the engine workflow (`ah-engine.yml`: the full pack, jobs `rust`, `no-node`, `ah-hook`, `doc-check`, `supply-chain`) and `.github/workflows/pr-source.yml`. Required to merge: `dev-only` (from `pr-source.yml`), which fails unless the source branch is this repository's `dev`, `privacy-scan`, and `tests-passed`, the always-running aggregator job of `ah-engine.yml`, which fails unless every job of the full pack succeeded.
- `main` is what users and the plugin directory install from, so every merge to `main` is a release-quality event.

## Checklist (in order)

1. - [ ] Bump `plugins/anti-hall/.claude-plugin/plugin.json` `version` (AND `plugins/anti-hall/.codex-plugin/plugin.json`, root `package.json` `version` and BOTH `version` fields in root `package-lock.json` to match — all four track together; agents read the root package version as the installed one; semver: patch=fix/doc, minor=new capability).
2. - [ ] Add a `## <version>` section to `CHANGELOG.md` (top) describing the change. CHANGELOG is the authority; marketplace entry carries no version.
3. - [ ] Update docs for ANY new/changed hook, skill, or discipline:
   - [ ] `docs/GUIDE.md` — the hooks and skills tables, disciplines, settings reference.
   - [ ] `llms.txt` — hooks list, skills, disciplines, docs list.
   - [ ] `README.md` (root) and `plugins/anti-hall/README.md` — only if the change touches what they cover (overview, privacy/network table, escape hatch).
   - [ ] relevant other `docs/*.md` (and `docs/KB.md` topic map).
4. - [ ] Verify: `cargo check` and a release build, then `~/.anti-hall/ah-engine/bin/ah-hook doctor --check` (a check of the local install: anti-hall ACTIVE). Never claim done without these THIS change.
5. - [ ] Commit on `dev` (NO AI-credit / Co-Authored-By trailer — git-guard blocks them) and push `dev`. Pushes to `dev` run no CI.
6. - [ ] **Optional full gate on `dev`.** For a release that needs the engine workflow on a candidate, push a candidate tag at the `dev` commit:
   - `git tag rc-v<version>` then `git push origin rc-v<version>`
   - `gh run list --commit <sha>` → wait for the run at that sha to finish; `gh run view <id> --json jobs` → every job of the run (every engine job) `success`.
   - Red → fix on `dev`, push, tag the new commit `rc-v<version>.2`, and repeat.
   - Tag retention: `rc-v*` tags are left in place after the release; the owner prunes old ones. Do not delete them as part of a release. The update check needs at least one `vX.Y.Z` tag, and release notes live in `CHANGELOG.md`, not in old tags.
7. - [ ] **Pull request `dev` → `main`.** If this release ships a new or changed `ah-engine.lock`, the lock PR must already be merged into `dev` (see "Engine release" below). Open it with `gh pr create --base main --head dev`. The required `tests-passed` and `dev-only` checks must be green. Merging IS the release: the marketplace clone fetches only `refs/heads/main` and fast-forwards it, and the updater copies a version into the plugin cache only when that version's directory is absent — so a red commit on `main` gets installed and cannot be replaced under the same version number (0.102.2 shipped red this way). Never merge on a red run. Merge with a merge commit or fast-forward, never squash: `dev` and `main` must stay in step.
   - The docs site (built by `tools/site_gen.py`, run from `.github/workflows/pages.yml`) deploys automatically when a release merges to `main`. One-time repo setting: Settings → Pages → Source: GitHub Actions (or `gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow`).
8. - [ ] After the merge: pull `main`, then (if the release ships an engine lock) FIRST push the engine tag `ah-engine-v<engine version>` on the merge commit (see "Engine release"), then TAG (manual, by agent): `git tag v<version>` then `git push origin v<version>`. Create a GitHub Release from the tag with that version's CHANGELOG section.
9. - [ ] Propagate to the live marketplace dir only (`~/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/`); do NOT overwrite version-pinned `cache/.../<ver>/` snapshots.
10. - [ ] Consider publish venues (see below) for notable releases.

## Engine release

The plugin pins one exact engine build in `ah-engine.lock` (root) and its byte-identical copy `plugins/anti-hall/ah-engine.lock`; users download the binary from the `ah-engine-v<engine version>` GitHub Release on SessionStart and install it only if its sha256 equals the lock. Details and the workflow are in `ah-engine/RELEASING.md`. Order:

1. **Dispatch `ah-engine-release`** (Actions, `workflow_dispatch`) from a branch that will be merged into `dev` (the base defaults to `dev`; `main` is rejected). It builds and tests all six targets plus the source tarball, then opens a PR that adds the two lock files.
2. **Merge the lock PR into `dev`** (re-run checks by closing and reopening it: PRs opened with the default token start no workflows). The two locks must be byte-equal and list the six targets.
3. Continue the normal checklist through the `dev` → `main` pull request and its merge.
4. **Tag `ah-engine-v<engine version>` on the merge commit right after the merge and push it.** The publish job checks the tagged commit is on `main`, so it cannot run earlier; until the Release exists, users who updated get a 404, the bootstrap logs a failure, retries after 6 hours and the `ah-hook` client has no engine to talk to, so hooks pass through (harmless, so keep the window short).
5. Wait for the publish run to go green and the GitHub Release to list the archives, `SHA256SUMS` and the attestation. Only then push `v<version>` and create the plugin's GitHub Release.
6. Smoke test on a clean HOME: SessionStart installs `~/.anti-hall/ah-engine/bin/ah-engine` and `bootstrap.log` shows `ok:`; with the network off (no engine) every hook passes through with one notice per session.

Rules learned the hard way:

- Run the prepare workflow only AFTER the last engine-source change has merged into `dev`. Any engine-source merge after it makes the lock fingerprint stale, and verify then fails with "source fingerprint differs".
- Prepare refuses if the tag `ah-engine-v<ver>` already exists, so a pushed but failed tag means bumping the engine version.
- The release smoke check compares only the semver part of `version`, because the build adds `+branch.sha`.

The engine's `Cargo.toml` version changes only when engine source changes (the lock's fingerprint must match the source at the tag); a plugin-only release does not touch it.

## Doc-currency rule

A version bump that adds/changes a hook/skill/discipline is NOT done until README (root+plugin) + llms.txt + relevant docs reflect it.

## Publish venues (for notable releases)

- Official Community Marketplace (Anthropic plugin-directory submission form) → surfaces on claude.com/plugins.
- Auto-crawl directories (e.g. claudemarketplaces.com) — automatic for public repos with valid `.claude-plugin/marketplace.json`.
- Community awesome-lists (PR): awesome-claude-plugins (ComposioHQ), awesome-claude-code-plugins (ccplugins), awesome-claude-code (jqueryscript).
- Promotion: dev.to/blog post, Show HN (strict no-hype), r/ClaudeAI, X/#ClaudeCode. Needs a demo GIF.
