---
name: repo-hygiene
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use before pushing, at release boundaries, or when git misbehaves - sweep merged branches and worktrees, clear a stale .git/index.lock safely, scrub private data from the public repo, run the docs-link hygiene tests.
---

# repo-hygiene

The repo is public and many sessions share one machine. Keep it clean, never lose work.
Deletion of anything not provably merged needs the owner's OK.

## 1. Branches and worktrees

```sh
git fetch --prune origin
git worktree list
git branch -vv                       # local branches and their upstreams
git branch -r --merged origin/dev    # remote branches already in dev
```

- Remove a worktree only when its branch is merged (or its commits are on `dev`) and
  `git -C <dir> status --short` is empty: `git worktree remove <dir>`, then `git worktree prune`.
- `--merged` misses cherry-picked work. Before deleting a branch, prove `dev` holds a content
  superset: `git cherry -v origin/dev <branch>` prints no `+` lines (or every `+` commit's change
  is on `dev`). Then `git branch -d <branch>` (lower-case `-d`; never `-D` without the owner).
- Remote branches: delete only merged work branches you created; never `dev`, `main` or the
  long-lived engine branches (the "work branches" ruleset blocks it anyway). Never force push.
- Scratch clones under `~/.anti-hall/work/`: delete `target/` dirs once their patch is handed
  over; keep an eye on free disk.

## 2. Stale `.git/index.lock`

`fatal: Unable to create '.git/index.lock': File exists` usually means another git process is
running. Remove the lock only after proving nobody holds it:

```sh
L=$(git rev-parse --git-path index.lock)       # correct for worktrees and submodules
ls -l "$L"
lsof "$L"                                      # any output = a live holder: wait, do not remove
pgrep -fl '(^|/)git( |$)'                      # running git commands
```

No holder, no git process for this repo, and the lock is older than a minute: `rm "$L"` once,
then retry. A lock that keeps coming back is a bug signal (log it per the `dogfood` skill).

## 3. Public-repo agnostic scrub (before every push)

Shipped and tracked files carry no private data: no home paths, emails other than the author
credit, machine names, session ids, or other projects' names. Scan what is about to leave:

```sh
git diff origin/dev...HEAD -U0 | grep '^+' | grep -nE '/Users/|/home/[a-z]|C:\\\\Users|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|session_[0-9A-Za-z]{8,}'
```

Every hit must be either the author credit, a documented example (`user@example.com`), a
generic path (`~/.anti-hall`, `$HOME`), or removed. Also grep the diff for the names of the
private projects you work on in other repos (keep that list local, never in the repo). Local
notes (`CLAUDE.md` at the root, `.anti-hall/`, handovers) are gitignored and stay out of commits:
`git status --short --ignored` before staging, and never `git add -f` them.

## 4. Docs-link and hygiene tests

```sh
node --test tests/hygiene/*.test.js
```

Covers docs links (`docs-links`, `readme-doc-links`, `docs-coverage`), manifest drift, plugin
frontmatter, tracked handovers, real-HOME leaks and more. A new `docs/*.md` must be linked the
way existing docs are (from both `docs/README.md` and `docs/KB.md`); fix the link, never the test. Run
the full `node --test` before pushing `dev` (pushes to `dev` run no CI).
