---
name: release
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use when cutting an anti-hall plugin release (v*) or an engine release (ah-engine-v*) - drives RELEASING.md step by step and adds the GitHub-side steps (milestone, release-drafter draft, immutable tags, Pages, CodeQL).
---

# release: drive RELEASING.md

`RELEASING.md` (repo root, read it from `dev`) is the authority; this skill does not repeat it.
Engine binaries have their own procedure in `ah-engine/RELEASING.md` (on branches that carry
the engine) and the `ah-engine-release.yml` workflow. Open (or reuse) a release issue first and
track it with the `gh-work` skill; tick its checklist as each step lands.

```sh
git fetch origin && git show origin/dev:RELEASING.md     # read it fresh every release
```

## Step map

| Step | RELEASING.md | Notes added here |
|---|---|---|
| 0 | - | Pick the milestone being shipped (v0.300.0, v0.301 engine-only, v1.0). `gh issue list --milestone "<m>" --state open`: every open item ships, moves to the next milestone with a comment, or blocks the release. |
| 1 | Checklist 1 (version bump, all four manifests) | `node --test tests/hygiene/manifest-drift.test.js` proves they agree. |
| 2 | Checklist 2 (CHANGELOG) | Compare with the release-drafter draft (G1) so no merged PR is missing. |
| 3 | Checklist 3 + "Doc-currency rule" | Sweep every doc, both ports (Claude + Codex). |
| 4 | Checklist 4 (verify) | Full `node --test` + doctor, this change, this session. |
| 5 | Checklist 5 (commit + push `dev`) | Repo git identity; no AI-credit lines. |
| 6 | Checklist 6 (optional `rc-v*` full matrix) | Needed when the change touches CI, hooks across OSes, or the engine bootstrap. |
| 7 | Checklist 7 (PR `dev` -> `main`) | Merge commit only (G2). Merging IS the release. |
| 8 | Checklist 8 (tag + GitHub Release) | Tags are immutable (G3); publish the drafter draft (G1). |
| 9 | Checklist 9 (marketplace propagate) | Never overwrite version-pinned cache snapshots. |
| 10 | Checklist 10 + "Publish venues" | Notable releases only. |
| 11 | - | Post-merge GitHub checks (G4, G5) and milestone close (G6). |

## GitHub-side steps

**G1. Release-drafter draft.** `release-drafter.yml` keeps one DRAFT release up to date from PRs
merged into `main`, grouped by `type:*` labels; it never publishes or tags. Before tagging:

```sh
gh release list -R talas9/anti-hall --limit 5          # the draft shows as "Draft"
gh release view <draft-tag> -R talas9/anti-hall        # check PR list, categories, resolved version
```

Its resolved version must equal the bumped version; if not, the semver bump or a PR's `type:*`
label is wrong: fix the label, not the draft. Replace the draft body with the CHANGELOG section
(CHANGELOG is the authority), then publish it on the new tag:

```sh
gh release edit <draft-tag> -R talas9/anti-hall --tag v<version> --title v<version> \
  --notes-file <changelog-section.md> --draft=false --latest
```

(or `gh release create v<version> --notes-file ...` when no draft exists).

**G2. Release PR.** `gh pr create --base main --head dev`; required checks `dev-only` and
`tests-passed`; `gh pr merge <pr> --merge`. Never squash, never merge red.

**G3. Tags are immutable.** The "release tags are immutable" ruleset covers `refs/tags/v*` and
`refs/tags/ah-engine-v*`: no update, no delete, no force. A wrong tag cannot be fixed; ship the
next patch version instead. So tag only after the `main` merge is green and pulled:

```sh
git fetch origin && git switch --detach origin/main && git log -1 --oneline   # the merge commit
git tag v<version> && git push origin v<version>
```

Engine: `ah-engine-v<X.Y.Z>` is pushed only after the lock PR from the `prepare` run is merged
(the tag triggers `publish`, which fails without a matching prepare). `rc-v*` tags are not covered
by the ruleset and are left in place (owner prunes).

**G4. Docs site (Pages).** `pages.yml` builds `tools/build-site.js` and deploys on every push to
`main`, so the release merge updates the site. Check it:

```sh
gh run list -R talas9/anti-hall --workflow pages.yml --branch main --limit 1
gh api repos/talas9/anti-hall/pages --jq .html_url     # 404 = Pages not enabled yet: see RELEASING.md step 7
```

**G5. CodeQL.** The repo uses CodeQL **default setup** (Settings -> Code security); the
`codeql.yml` advanced workflow is manual-only and must stay so while default setup is on (both
cannot run). After the merge:

```sh
gh api repos/talas9/anti-hall/code-scanning/default-setup --jq '{state,languages}'
gh api 'repos/talas9/anti-hall/code-scanning/alerts?state=open&ref=refs/heads/main' --jq length
```

New open alerts on `main` get an issue (`type:bug`, `area:ci` or the code's area) before the
release is called done.

**G6. Close the milestone.** When every issue in it is closed or moved on:

```sh
gh api 'repos/talas9/anti-hall/milestones?state=open' --jq '.[]|"\(.number) \(.title) \(.open_issues)"'
gh api -X PATCH repos/talas9/anti-hall/milestones/<number> -f state=closed
```

Then comment the release link and the verification evidence on the release issue and close it
through its PR or `gh issue close <n> --comment "<evidence>"`.

## Done means

`main` merge green (`tests-passed`, `dev-only`), tag pushed, GitHub Release published from the
CHANGELOG section, Pages run green, CodeQL clean or ticketed, milestone closed, marketplace dir
propagated. Anything missing stays an open checklist item on the release issue.
