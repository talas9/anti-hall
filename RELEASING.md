# Releasing anti-hall

Every behavioral or shipped-content change bumps the version and follows this checklist. The agent (not CI) performs the tag manually.

## Branch flow

- Day-to-day work is committed and pushed to `dev`. Pushes to `dev` run no CI, so run the full local suite (`node --test` from the repo root) before pushing.
- `main` changes only through a pull request from `dev`. A repository ruleset blocks direct pushes, force pushes and deletion of `main`.
- A pull request to `main` runs the full test workflow (`test.yml`, `pull_request` trigger) and `.github/workflows/pr-source.yml`. Two checks are required to merge: `dev-only` (from `pr-source.yml`), which fails unless the source branch is this repository's `dev`, and `tests-passed` (the last job of `test.yml`), which fails unless every test shard passed.
- `main` is what users and the plugin directory install from, so every merge to `main` is a release-quality event.

## Checklist (in order)

1. - [ ] Bump `plugins/anti-hall/.claude-plugin/plugin.json` `version` (AND `plugins/anti-hall/.codex-plugin/plugin.json` to match — the two manifests track together; semver: patch=fix/doc, minor=new capability).
2. - [ ] Add a `## <version>` section to `CHANGELOG.md` (top) describing the change. CHANGELOG is the authority; marketplace entry carries no version.
3. - [ ] Update docs for ANY new/changed hook, skill, or discipline:
   - [ ] `docs/GUIDE.md` — the hooks and skills tables, disciplines, settings reference.
   - [ ] `llms.txt` — hooks list, skills, disciplines, docs list.
   - [ ] `README.md` (root) and `plugins/anti-hall/README.md` — only if the change touches what they cover (overview, privacy/network table, escape hatch).
   - [ ] relevant other `docs/*.md` (and `docs/KB.md` topic map).
4. - [ ] Verify: `node --test` (all pass) and `node plugins/anti-hall/hooks/doctor.js --check` (anti-hall ACTIVE). Never claim done without these THIS change.
5. - [ ] Commit on `dev` (NO AI-credit / Co-Authored-By trailer — git-guard blocks them) and push `dev`. Pushes to `dev` run no CI.
6. - [ ] **Optional full-matrix gate on `dev`.** Pull-request CI runs a reduced matrix (ubuntu × Node 22/24 plus macOS × Node 24). For a release that needs the full matrix, push a candidate tag at the `dev` commit — `test.yml` runs on `rc-v*` tags (ubuntu + macOS × Node 22/24, each cell sharded; `v*` tags do not trigger it):
   - `git tag rc-v<version>` then `git push origin rc-v<version>`
   - `gh run list --commit <sha>` → wait for the run at that sha to finish; `gh run view <id> --json jobs` → every job of the run (the `plan matrix` job plus all 10 `node:test` shard jobs) `success`.
   - Red → fix on `dev`, push, tag the new commit `rc-v<version>.2`, and repeat.
   - Tag retention: `rc-v*` tags are left in place after the release; the owner prunes old ones. Do not delete them as part of a release. The update check needs at least one `vX.Y.Z` tag, and release notes live in `CHANGELOG.md`, not in old tags.
7. - [ ] **Pull request `dev` → `main`.** Open it with `gh pr create --base main --head dev`. The required `tests-passed` and `dev-only` checks must be green. Merging IS the release: the marketplace clone fetches only `refs/heads/main` and fast-forwards it, and the updater copies a version into the plugin cache only when that version's directory is absent — so a red commit on `main` gets installed and cannot be replaced under the same version number (0.102.2 shipped red this way). Never merge on a red run. Merge with a merge commit or fast-forward, never squash: `dev` and `main` must stay in step.
   - The docs site (`tools/build-site.js`, `.github/workflows/pages.yml`) deploys automatically when a release merges to `main`. One-time repo setting: Settings → Pages → Source: GitHub Actions (or `gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow`).
8. - [ ] After the merge: pull `main`, then TAG (manual, by agent): `git tag v<version>` then `git push origin v<version>`. Create a GitHub Release from the tag with that version's CHANGELOG section.
9. - [ ] Propagate to the live marketplace dir only (`~/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/`); do NOT overwrite version-pinned `cache/.../<ver>/` snapshots.
10. - [ ] Consider publish venues (see below) for notable releases.

## Doc-currency rule

A version bump that adds/changes a hook/skill/discipline is NOT done until README (root+plugin) + llms.txt + relevant docs reflect it.

## Publish venues (for notable releases)

- Official Community Marketplace (Anthropic plugin-directory submission form) → surfaces on claude.com/plugins.
- Auto-crawl directories (e.g. claudemarketplaces.com) — automatic for public repos with valid `.claude-plugin/marketplace.json`.
- Community awesome-lists (PR): awesome-claude-plugins (ComposioHQ), awesome-claude-code-plugins (ccplugins), awesome-claude-code (jqueryscript).
- Promotion: dev.to/blog post, Show HN (strict no-hype), r/ClaudeAI, X/#ClaudeCode. Needs a demo GIF.
