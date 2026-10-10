# Release notes template

The GitHub Release body for a plugin release (`v<version>` tag). [RELEASING.md](../RELEASING.md) is the authority: the release is created from the tag after the `dev` → `main` merge, and its body is that version's section of [CHANGELOG.md](../CHANGELOG.md). The Release Drafter draft (`.github/release-drafter.yml`, never published) is only a list of merged pull requests to start from.

How to use it:

1. Write the `## <version> (<YYYY-MM-DD>)` section at the top of `CHANGELOG.md` on `dev`, using the headings below. Leave out headings that have nothing under them.
2. After the merge and the tag, create the release with that section as the body, for example `gh release create v<version> --title v<version> --notes-file <file>` where the file holds the CHANGELOG section.
3. Engine releases (`ah-engine-v*` tags) follow the engine's own release notes, not this template.

Where a Release Drafter category fits under each heading:

| CHANGELOG heading | Release Drafter category (label) |
|---|---|
| Added | Features (`type:feature`) |
| Changed | Features (`type:feature`) or Maintenance (`type:chore`) |
| Fixed | Bug fixes (`type:bug`) |
| Security | Bug fixes (`type:bug`), plus `security` |
| Docs | Documentation (`type:docs`) |
| CI | CI (`type:ci`) |

Semver: patch for fixes and docs, minor for a new capability (RELEASING.md, step 1).

---

Copy from here:

```markdown
## <version> (<YYYY-MM-DD>)

### Highlights

- **<Short headline>.** <One sentence on what a user notices.>

### Added

- <area>: <new capability, and the setting that controls it>.

### Changed

- <area>: <behaviour that changed, and what it was before>.

### Fixed

- <area>: <what was wrong, the cause, and what it does now>. (#<issue>)

### Security

- <what was exposed, to whom, and how the change closes it>.

### Docs

- <doc>: <what changed>.

### CI

- <workflow>: <what changed>.

### Upgrade notes

- <anything a user must do after `/anti-hall:update`, or "None.">
```
