# Contributing to anti-hall

Thanks for helping. anti-hall is pure Node (built-ins only, no dependencies) and runs on macOS and Linux.

## Set up and run the tests

- Node.js **22 or newer** (CI runs ubuntu and macOS on Node 22 and 24).
- From the repo root, with no install step:

```bash
node --test                                # the whole suite
node --test tests/hygiene/docs-links.test.js   # or just the files you touched
```

- A green local run is not a green CI run. Check the GitHub Actions result for your push before calling work done.
- Tests must not touch your real home directory. Anything that spawns a hook or script must isolate `HOME`/`USERPROFILE` to a temp dir, as the existing tests do.
- Quick health check of a working copy: `node plugins/anti-hall/hooks/doctor.js --check`.

## Both ports, always (dual-platform parity)

anti-hall is a Claude Code plugin **and** a Codex port (`plugins/anti-hall/codex/`). A change to a hook, skill or model-routing doc lands on both sides, or the PR states why one side does not apply. Docs follow the same rule: update the main README and the Codex README, `llms.txt`, and the Codex skill mirrors together. Details: the "Dual-platform parity" section of [AGENTS.md](AGENTS.md).

## Commits and pull requests

- **No AI credit.** Do not add `Co-Authored-By` trailers, "Generated with" lines or assistant-attribution links to commits or to PR/issue/release text. Commits are the human author's. `git-guard` blocks them. See [AGENTS.md](AGENTS.md) and [RELEASING.md](RELEASING.md).
- Use plain conventional messages (`fix(area): ...`, `docs: ...`).
- Never force-push; do not delete branches or data without the maintainer's say-so.
- Keep shipped files project-agnostic and user-agnostic: no private names, paths or emails, other than the author credit.

## Releases

Maintainers follow [RELEASING.md](RELEASING.md): the version lives in `plugins/anti-hall/.claude-plugin/plugin.json` (the Codex manifest tracks it), and `CHANGELOG.md` is updated at release time. Contributors normally do not bump versions or edit the changelog.

## Reporting problems

- Bugs and false positives: use the issue templates.
- Security issues: see [SECURITY.md](SECURITY.md); do not open a public issue.
