# Saved replies

Common triage replies for anti-hall issues, pull requests and discussions. Copy one, replace the `<...>` parts, and paste it. To use them from the GitHub UI, add them once under your account: Settings → Saved replies (they are per user, not per repository).

Labels named here are the repository's own (`status:*`, `priority:*`, `size:*`, `area:*`, `type:*`, `needs-info`, `needs-repro`, `false-positive`, `duplicate`, `wontfix`). The label scheme and the triage flow are described in [CONTRIBUTING.md](../CONTRIBUTING.md#issues-first).

## Needs more information

> Thanks for the report. To look into it I need a bit more:
>
> - the anti-hall version (`/anti-hall:doctor` shows it)
> - whether you use the Claude Code plugin or the Codex port
> - your OS and `node --version`
> - the exact input and the exact anti-hall message text
>
> Please remove secrets, tokens and personal paths before pasting. I'll mark this `needs-info` until then.

## Needs a reproduction

> Thanks. I can't reproduce this yet. Could you share the smallest set of steps that triggers it on the latest version (`/anti-hall:update` first)? A command, a file and the message you saw is usually enough. Marking `needs-repro`.

## Update first

> This looks like something fixed in a later release. Please run `/anti-hall:update`, start a new session, and tell me whether it still happens. The [CHANGELOG](../CHANGELOG.md) lists what changed in each version.

## False positive confirmed

> Thanks, confirmed: the guard blocked a legitimate command. I've labelled this `false-positive` and `status:accepted`. Until the fix ships, you can turn the guard off with `/anti-hall:settings` (the guard's setting is listed in the [guide](../docs/GUIDE.md)).

## Working as intended

> Thanks for raising it. This block is intentional: <reason the guard exists>. If your case is legitimate and common, a narrower rule may help; please describe it in [Ideas](https://github.com/talas9/anti-hall/discussions/categories/ideas) so others can weigh in. You can also turn the guard off with `/anti-hall:settings`. Closing as `wontfix`.

## Duplicate

> Thanks. This is tracked in #<number>, so I'm closing this one as a duplicate. Please add any extra detail there.

## Question, moved to Discussions

> Thanks for asking. Questions get better answers in [Q&A](https://github.com/talas9/anti-hall/discussions/categories/q-a), where other users can see and answer them, so I'm converting this issue to a discussion.

## Feature idea, moved to Discussions

> Thanks for the idea. Proposals start in [Ideas](https://github.com/talas9/anti-hall/discussions/categories/ideas) so the design can be discussed first; once it is agreed I'll open an issue to track the work. I'm converting this to a discussion.

## Idea accepted (discussion to issue)

> Agreed, let's do it. I've opened #<number> to track the work, labelled `status:accepted`. Follow along there.

## Security report in public

> Thanks, but please don't post security problems publicly. I've hidden the details. Please report it privately as described in [SECURITY.md](../SECURITY.md).

## Pull request against the wrong branch

> Thanks for the pull request. `main` only accepts pull requests from `dev`, so this one can't merge as is. Please change the base branch to `dev` (Edit, next to the title). See the branch model in [CONTRIBUTING.md](../CONTRIBUTING.md#branch-model).

## Pull request missing parity or docs

> Thanks. Before this can merge it also needs:
>
> - the Codex twin under `plugins/anti-hall/codex/`, or a line in the description saying why Codex does not apply
> - the docs and settings rows listed in [CONTRIBUTING.md](../CONTRIBUTING.md#adding-or-changing-a-guard)
> - a regression test, including the dangerous forms that must stay blocked
>
> `node --test` names anything undocumented.

## Pull request contains AI credit lines

> Thanks. The repository does not accept AI credit lines (`Co-Authored-By` trailers for assistants, "Generated with" lines or assistant links) in commits or pull request text; see [CONTRIBUTING.md](../CONTRIBUTING.md#commits-and-pull-requests). Please reword the commits and update the description.

## Stale, closing

> Closing because there has been no reply for a while. If this still happens on the latest version, comment with the details and I'll reopen it.

## Fixed in a release

> Fixed in v<version>. Run `/anti-hall:update` and start a new session to get it. Thanks for the report.
