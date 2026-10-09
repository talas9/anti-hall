# Dev skills

Dev-only skills for working on anti-hall itself; not part of the shipped plugin. They live in
the repo's `.claude/skills/`, outside `plugins/anti-hall/`, so no marketplace install ever
copies them (like devDependencies). Claude Code loads them in sessions opened in this repo.

- `dogfood`: judge every anti-hall signal in a dev session, log misfires, track work on GitHub.
- `gh-work`: issue -> branch -> PR -> merge lifecycle, board fields and bot labels.
- `release`: drive `RELEASING.md` plus the GitHub-side release steps.
- `engine-lane`: run an ah-engine lane (isolation, build queue, gates, goldens, cleanup).
- `repo-hygiene`: branch/worktree sweep, stale index lock, agnostic scrub, hygiene tests.

## Autonomous mode

All work lives on GitHub (issues + the "anti-hall roadmap" board). A session builds its task
list from the board (Now, then Next by priority), opens and triages an issue before any new
work, picks the next accepted item itself, moves it to In progress, comments approach and
evidence, and closes it through a PR with `Closes #n`. It stops only at owner-only gates
(billing, secrets, destructive actions), commenting on the issue and labelling it
`status:blocked`. Every few hours it re-syncs the board, triages new items and posts a progress
line on each in-progress issue. Details: `gh-work`.
