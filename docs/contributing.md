---
title: Contributing
description: How to contribute to anti-hall, the branch and release flow, and how to build these docs.
---

# Contributing

Contributions are welcome: bug reports, false positives, docs fixes and code.

| Read | For |
|---|---|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Project layout, running the tests, the branch model, adding a guard. |
| [RELEASING.md](../RELEASING.md) | The release checklist and the `dev` to `main` flow. |
| [Repository pipelines](REPO-PIPELINES.md) | Every GitHub workflow, what triggers it and whether it gates a merge. |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability privately. |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Expected behaviour. |

## The short version

- **Open pull requests against `dev`.** `main` only changes through a pull request from
  `dev`, and that is what users install.
- Run the test suite before you push: `node --test` from the repository root. It uses
  only Node's built-in test runner; there is nothing to install.
- Commits follow conventional commit style (`fix(git-guard): ...`, `docs(site): ...`) and
  carry no AI co-author lines.

## Editing these docs

Every page has an **edit** button (the pencil at the top right) that opens the file on
GitHub. The site is built with [MkDocs](https://www.mkdocs.org/) and the open-source
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) theme from `docs/`.
Two pages are generated at build time and are not files in `docs/`:

- the **Settings reference**, from `plugins/anti-hall/hooks/lib/settings-schema.js`;
- the **Changelog**, from `CHANGELOG.md`.

To build the site locally:

```bash
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r docs-requirements.txt
python3 -I tools/site_gen.py
.venv/bin/mkdocs serve        # or: .venv/bin/mkdocs build --strict
```

The `pages` workflow builds the site on every pull request to `main` that touches the
docs, and publishes it to GitHub Pages when a release merges to `main`.
