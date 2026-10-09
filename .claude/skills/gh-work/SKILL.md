---
name: gh-work
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use when starting, picking, triaging, branching, opening a PR for, or closing any piece of anti-hall work - the issue -> branch -> PR -> merge lifecycle on GitHub and the "anti-hall roadmap" board, with exact gh commands and board field ids.
---

# gh-work: issue -> branch -> PR -> merge

All anti-hall work lives on GitHub: tasks, bugs, features, plans and the roadmap. The session
task list is built FROM the board, never the other way round. Repo `talas9/anti-hall`; board
**"anti-hall roadmap"** = user project **3**, owner `talas9`. Text on GitHub stays agnostic
(public repo): no private paths, names, emails or session ids.

## Autonomous operating loop

1. **Session start / resume: sync the board.**
   `gh project item-list 3 --owner talas9 --format json --limit 500` (the **Now** view first,
   then **Next** by priority; **Backlog**, **By milestone** and **Board** are the other views).
   Rebuild the session task list from it; every task subject starts with `#n`.
2. **Anything new** (owner request, idea, bug, plan, or something found while working): open the
   issue FIRST (step A below), triage it immediately (step B), then work. Plans go in the issue
   body or a linked comment; a local plan file carries a link to its issue.
3. **Pick the next work yourself:** the highest-priority **Now** item with no in-flight agent,
   else the top of **Next**. Move it to In progress, comment the approach, work it, comment the
   evidence, close it through a PR with `Closes #n`. Never wait for permission on accepted items.
   Stop only at owner-only gates (billing, secrets, destructive actions): comment on the issue,
   label it `status:blocked`, set board Status Blocked, take the next item.
4. **Every few hours:** re-sync the board, triage everything new (bot suggestions included), post
   a one-line progress comment on each `status:in-progress` issue.

## A. Find or open the issue

```sh
gh issue list -R talas9/anti-hall --state open --search "<keywords>" --json number,title,labels
```

Forms (`.github/ISSUE_TEMPLATE/`, blank issues are off): **Bug report** (`bug: ` title,
labels `bug,type:bug,status:triage`), **False positive** (`false-positive`), **Feature request**
(`feature: `, labels `enhancement,type:feature,status:triage`). The CLI cannot fill a form, so
write the body in the rendered form layout (`### <Field label>` + blank line + value); the
`triage.yml` workflow parses the **Priority**, **Estimate**, **Area** and **Estimate in hours**
headings:

```sh
gh issue create -R talas9/anti-hall --title "feature: <summary>" \
  --label enhancement,type:feature,status:triage --milestone "v0.300.0" --body "$(cat <<'EOF'
### Problem

<what is wrong or missing>

### Proposed behaviour

<what should happen>

### Which port

Both

### Area

engine

### Priority

P2 (normal)

### Estimate

M (up to 1 day)

### Estimate in hours

6

### Acceptance criteria

- [ ] <checkable outcome>
EOF
)"
```

Area values: engine, devswarm, hooks, statusline, codex, ci, docs, release. Priority values:
`P0 (critical, blocks users or a release)`, `P1 (high, next release)`, `P2 (normal)`,
`P3 (low, nice to have)`. Estimate values: `S (up to 2 hours)`, `M (up to 1 day)`,
`L (up to 3 days)`, `XL (more than 3 days)`.

## B. Triage (decide in the same session)

Labels: `type:feature|bug|docs|chore`, `priority:P0|P1|P2|P3`, `size:S|M|L|XL`, `area:*`,
`status:triage|accepted|in-progress|blocked`. Milestones: **v0.300.0** (engine decides hooks, Node
is the fallback), **v0.301 engine-only (Node removed)**, **v1.0** (no Node, everything through
the engine, contract frozen).

Accept:

```sh
gh issue edit <n> -R talas9/anti-hall --remove-label status:triage \
  --add-label status:accepted,type:feature,priority:P2,size:M,area:engine --milestone "v1.0"
U=https://github.com/talas9/anti-hall/issues/<n>
gh project item-add 3 --owner talas9 --url "$U"          # no-op if the board already has it
gh project item-edit 3 --owner talas9 --url "$U" --field Status   --value Accepted
gh project item-edit 3 --owner talas9 --url "$U" --field Priority --value P2
gh project item-edit 3 --owner talas9 --url "$U" --field Size     --value M
gh project item-edit 3 --owner talas9 --url "$U" --field Estimate --number 6
gh project item-edit 3 --owner talas9 --url "$U" --field Target   --text "v1.0"
```

Defer: do not accept it (it stays out of Now/Next); comment why and what would change the decision
(`gh issue comment <n> --body "Deferred: <reason>"`). Never close or delete an issue
automatically.

### Board field and option ids

From `gh project field-list 3 --owner talas9 --format json` (re-run it if an edit fails; ids
change only when a field is recreated). Use them with the id form, one field per call:

```sh
ITEM=$(gh project item-list 3 --owner talas9 --format json --limit 500 \
  --jq '.items[] | select(.content.number==<n>) | .id')
gh project item-edit --project-id PVT_kwHOABnoa84BmYbQ --id "$ITEM" \
  --field-id PVTSSF_lAHOABnoa84BmYbQzhlBtY0 --single-select-option-id dbf76781   # Status = In progress
```

| Field | Field id | Type | Options (name = id) |
|---|---|---|---|
| (project) | `PVT_kwHOABnoa84BmYbQ` | project node id | |
| Status | `PVTSSF_lAHOABnoa84BmYbQzhlBtY0` | single select | Triage = `81ce65fd`, Accepted = `49e0e02f`, In progress = `dbf76781`, Blocked = `6aabb99f`, Done = `6c3416e5` |
| Priority | `PVTSSF_lAHOABnoa84BmYbQzhlBtd0` | single select | P0 = `bcde1ac9`, P1 = `c806d2de`, P2 = `0dfd336f`, P3 = `fa6760c3` |
| Size | `PVTSSF_lAHOABnoa84BmYbQzhlBtew` | single select | S = `f7a60b7e`, M = `44ad0140`, L = `dae84bf6`, XL = `96a5febd` |
| Estimate | `PVTF_lAHOABnoa84BmYbQzhlBtfs` | number (hours) | `--number` |
| Target | `PVTF_lAHOABnoa84BmYbQzhlBtfw` | text | `--text` (milestone name) |
| Milestone | `PVTF_lAHOABnoa84BmYbQzhlBtZA` | built-in | set on the issue (`gh issue edit --milestone`) |

Status mirrors the `status:*` label: keep both in step whenever either changes.

## C. Start work

```sh
gh issue edit <n> --remove-label status:accepted --add-label status:in-progress
gh project item-edit 3 --owner talas9 --url "$U" --field Status --value "In progress"
gh issue comment <n> --body "Approach: <plan, lanes, risks>"
git fetch origin && git switch -c <type>/<n>-<slug> origin/dev
```

Branch `<type>/<n>-<slug>` (type = feat, fix, docs, chore, ci, refactor, perf, test) off `dev`.
Every commit message references `#n`: `fix(engine): <summary> (#n)`. Commit as the repo's git
config identity; no AI-credit trailers (git-guard blocks them). Never force push, never rewrite a
pushed branch.

## D. Pull request into dev

```sh
git push -u origin <type>/<n>-<slug>
gh pr create -R talas9/anti-hall --base dev --head <type>/<n>-<slug> \
  --title "fix(engine): <summary>" --body "$(printf 'Closes #%s\n\n<what changed, how it was verified>' <n>)"
gh pr checks <pr> --watch
gh pr merge <pr> --merge          # merge commit; never --squash for dev -> main
```

- Title: Conventional Commits `type(scope): summary` (`pr-title.yml` enforces it on PRs to
  `dev` and `main`; `release` is also an allowed type).
- Body: `Closes #n` so the merge closes the issue and the board moves it to Done.
- Comment on the issue at each milestone (approach chosen, commit shas, test or replay evidence,
  blockers): one comment per milestone, not per step.
- Blocked: `gh issue edit <n> --add-label status:blocked`, board Status Blocked, comment what
  blocks it.

## E. Release PRs (dev -> main)

`main` accepts PRs only from this repo's `dev` (`pr-source.yml` check `dev-only`), and needs
`tests-passed` (`test.yml`). Merge with a merge commit (or fast-forward), never squash, so `dev`
and `main` stay in step:

```sh
gh pr create -R talas9/anti-hall --base main --head dev --title "release: v<version>" --body "<CHANGELOG section>"
gh pr merge <pr> --merge
```

The full release sequence is the `release` skill.

## F. Bot outputs and what to do

| Signal | Source | Action |
|---|---|---|
| `status:triage` + `priority:*`/`size:*`/`area:*` | `triage.yml` (form fields) | Confirm or correct, then accept or defer (B). |
| `triaged` + one comment | `issue-triage.yml` (model first pass) | Read the comment as a suggestion; verify against code before labelling. |
| `area:*` on a PR | `triage.yml` + `.github/labeler.yml` (paths) | Nothing; fix `labeler.yml` if wrong. |
| triage suggestion comment | moderation/triage workflows | Apply what the evidence supports, reply on what you reject, then remove the suggestion state. |
| `moderation:review` | moderation workflow | A human-review flag (possible spam, abuse, duplicate). Read it; act only on clear evidence; never delete content, hide only spam/abuse with a comment why; remove the label once handled. |
| `needs-issue` | PR moderation (PR has no `Closes #n`; `dev` head is exempt) | Open or find the issue, add `Closes #n` to the PR body, remove the label. |
| `risk:workflow`, `risk:security` | PR moderation (touches workflows/scripts or guards/hooks/security files) | Extra review: read the full diff, run a deadly-loop on it, never auto-merge; note the review in the PR. |
| `stale` | `stale.yml` (60 days idle; never closes) | Comment whether it still matters; a human closes. |

Bots never close, lock or delete; neither does a session without the owner's OK.

Model routing for agents and lanes: see the "Model routing" section in `.claude/skills/README.md`.
