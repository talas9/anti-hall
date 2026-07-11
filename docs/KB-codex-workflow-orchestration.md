# KB — Codex workflow orchestration, subagents, and Workflow/swarm equivalents

> Codex equivalent for `KB-claude-workflow-orchestration.md` and the Claude/Opus swarm docs.
> Compiled 2026-06-30 from official Codex docs plus OMX package/repo metadata.

## TL;DR

Codex does have multi-agent and workflow equivalents, but the names and guarantees differ from Claude Dynamic Workflows:

- **Native Codex equivalent:** subagent workflows, agent threads, `/agent`, worktrees, cloud tasks, noninteractive mode, SDK, GitHub Action, automations, and app/CLI workflow recipes.
- **Codex extension equivalent:** plugins + skills + hooks can package workflow policy.
- **OMX equivalent:** oh-my-codex (`omx`) supplies higher-level workflow commands such as team/ralph/ultrawork/autopilot-style orchestration for Codex CLI.
- **Not equivalent:** Claude `*.workflow.js` files are not Codex-native workflow programs. Port them as Codex skills/OMX workflows or deterministic scripts, not by executing Claude Workflow JS.

## Current verified facts

| Need | Codex-native surface | Anti-hall implication |
| --- | --- | --- |
| Parallel review/research | Codex subagents; explicit prompt must ask for parallel/subagent work. | Deadly-loop can be a Codex skill that spawns Reviewer/Critic subagents; do not claim Codex auto-spawns them. |
| Keep main context clean | Official subagent docs name context pollution/context rot and recommend summaries from subagents. | Anti-hall context-conserve aligns with Codex subagent rationale. |
| Model distribution | Codex subagent docs (as of 2026-06-30 compile date) recommend choosing model/reasoning by task, with `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. **GPT-5.6 (Sol/Terra/Luna) went GA 2026-07-09** and current Codex docs list `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` alongside the older lineup as selectable (`KB-gpt-5.6.md` §4, PRIMARY-CONFIRMED) — GPT-5.6 did not remove the older models from the picker. | Anti-hall model policy migrates: `gpt-5.6-sol` for debate/review, `gpt-5.6-terra` implementation, `gpt-5.4-mini` (kept as cheap default) or `gpt-5.6-luna` for lookup/mechanical work, `gpt-5.3-codex-spark` where a distinct near-instant model is wanted. See `KB-gpt-5.6.md` and `KB-sonnet-5.md` §8. |
| Work isolation | Codex worktrees support isolated work on tasks/branches. | Multi-lane feature launch should use `.codex/worktrees/...`, not `.claude/worktrees/...`. |
| Long-running/offloaded work | Codex cloud tasks, GitHub Action, noninteractive mode, and SDK can run hosted/programmatic tasks. | Port Claude Workflow automation as Codex CLI/SDK/noninteractive scripts where deterministic automation is needed. |
| Repeatable workflows | Skills, custom prompts, automations, and plugins encode repeatable behavior. | Anti-hall ship-it/feature-launch/deadly-loop become skills; marketplace distribution is via plugin. |
| Higher-level swarm/team runtime | OMX is a third-party Codex orchestration layer installed locally as `oh-my-codex@0.18.16`. | Anti-hall can integrate with OMX, but OMX is a companion, not an OpenAI-native Codex feature. |

## Workflow/swarm equivalence decision

| Claude concept | Closest Codex equivalent | Porting rule |
| --- | --- | --- |
| Claude Dynamic Workflow JS | Codex skill + deterministic script; or OMX workflow if tmux/runtime needed | Do not run Claude Workflow JS in Codex. |
| Claude Agent/Task fan-out | Codex subagents / agent threads | Use explicit role prompts and compact summaries. |
| Claude OMC autonomous loops | OMX workflows (`omx`) | Integrate via `anti-hall-omx`; keep optional. |
| Claude feature-launch / GSD | Codex feature-launch skill + `.planning/` + graphify + debate gates | Do not depend on removed GSD. |
| Claude plan mode / ExitPlanMode | Codex Plan mode and prompt-level plan gates | Keep plan approval/gate semantics, but use Codex UI/CLI mechanisms. |
| Claude statusline-driven phase tracking | Codex hooks + AGENTS/OMX HUD if available | Do not assume Claude statusline support exists in Codex. |

## Source audit (10+ sources, 2+ official)

1. **Official OpenAI:** Codex manual, Best practices — https://developers.openai.com/codex/learn/best-practices
2. **Official OpenAI:** Codex manual, Workflows — https://developers.openai.com/codex/workflows
3. **Official OpenAI:** Codex manual, Subagents concepts — https://developers.openai.com/codex/concepts/subagents
4. **Official OpenAI:** Codex manual, Subagents setup — https://developers.openai.com/codex/subagents
5. **Official OpenAI:** Codex manual, Worktrees — https://developers.openai.com/codex/worktrees
6. **Official OpenAI:** Codex manual, Automations — https://developers.openai.com/codex/automations
7. **Official OpenAI:** Codex manual, Non-interactive mode — https://developers.openai.com/codex/non-interactive
8. **Official OpenAI:** Codex manual, Codex SDK — https://developers.openai.com/codex/sdk
9. **Official OpenAI:** Codex manual, Codex GitHub Action — https://developers.openai.com/codex/github-action
10. **Official OpenAI:** Codex manual, Codex app commands — https://developers.openai.com/codex/app/commands
11. **Official OpenAI:** Codex manual, CLI command reference — https://developers.openai.com/codex/cli/reference
12. OpenAI Codex npm metadata (`@openai/codex@0.142.4`, verified with `npm view`) — https://www.npmjs.com/package/@openai/codex
13. OpenAI Codex repository metadata — https://github.com/openai/codex
14. oh-my-codex npm metadata (`oh-my-codex@0.18.16`, verified with `npm view`) — https://www.npmjs.com/package/oh-my-codex
15. oh-my-codex repository metadata — https://github.com/Yeachan-Heo/oh-my-codex
16. oh-my-codex homepage metadata — https://yeachan-heo.github.io/oh-my-codex
17. Chroma context rot writeup, referenced by official Codex subagent docs — https://research.trychroma.com/context-rot

## Verification status

- Official Codex manual fetched locally on 2026-06-30 and used for current-event/workflow claims.
- OMX package metadata verified with `npm view oh-my-codex` on 2026-06-30.
- Anti-hall port should be checked against this KB before release: especially whether edit-time hooks now work in live Codex, because current official docs list `apply_patch`/`Edit`/`Write` matchers.
