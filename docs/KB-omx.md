# KB — oh-my-codex (OMX)

> Codex equivalent for `docs/KB-omc.md`. OMX is a third-party orchestration layer for OpenAI Codex CLI. Compiled 2026-06-30 from installed package metadata, installed skill manifests, and official Codex docs.

## TL;DR

OMX (`oh-my-codex`) is the Codex-side companion closest to OMC. It is not OpenAI-native Codex, but it installs as a Codex plugin plus CLI/runtime layer and adds workflow skills, role agents, HUD/status surfaces, MCP helpers, and tmux-oriented team orchestration.

Verified local package: `oh-my-codex@0.18.16` with CLI binary `omx`.

## Current verified facts

| Area | Verified state | Anti-hall implication |
| --- | --- | --- |
| Package | `npm view oh-my-codex` reports name `oh-my-codex`, version `0.18.16`, description “Multi-agent orchestration layer for OpenAI Codex CLI,” repository `github.com/Yeachan-Heo/oh-my-codex`, homepage `yeachan-heo.github.io/oh-my-codex`. | Treat OMX as third-party Codex orchestration companion, not as built-in Codex. |
| Installed CLI | `omx --version` reported `oh-my-codex v0.18.16`. | `cx.sh` can wrap `omx --madmax "$@"` for local dangerous-bypass launch. |
| Plugin manifest | Installed OMX `.codex-plugin/plugin.json` exposes `skills`, `mcpServers`, `apps`, `hooks`, and interface metadata. | Anti-hall Codex plugin should use the same broad manifest pattern where needed. |
| Hooks | Installed OMX hook bundle uses `${PLUGIN_ROOT}/hooks/codex-native-hook.mjs` across SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, PostCompact, Stop. | Anti-hall plugin-bundled hooks should use `${PLUGIN_ROOT}` too. |
| Setup/doctor | OMX package scripts include `setup` and `doctor`; installed skills include `omx-setup` and `doctor`. | Anti-hall should document “install/enable OMX” separately from anti-hall activation. |
| Workflows | Installed OMX skills include `plan`, `ralph`, `ultrawork`, `ultragoal`, `team`, `pipeline`, `ultraqa`, `visual-ralph`, `prometheus-strict`, `deep-interview`, and `code-review`. | Anti-hall feature-launch/ship-it can hand off to OMX workflows when task size justifies it. |
| Deprecated naming | Installed OMX `swarm` skill is a deprecated compatibility shim for team execution. | Do not market “swarm” as the preferred Codex workflow; prefer `team` or native subagents. |
| Model routing | OMX installed AGENTS/runtime table maps roles to Codex models and reasoning effort. | Anti-hall must keep debate gates on `gpt-5.5` and avoid all-frontier fan-out. |
| State | OMX uses repo `.omx/` and global `~/.codex` plugin/cache/state surfaces. | Keep `.omx/` local state out of git; this repo excludes it via `.git/info/exclude`. |

## OMC → OMX mapping for anti-hall

| OMC/Claude concept | OMX/Codex equivalent | Porting rule |
| --- | --- | --- |
| OMC plugin marketplace/workflow layer | OMX plugin + `omx setup --plugin --scope user --with-mcp --merge-agents` | Use OMX for Codex runtime workflows; do not install OMC for Codex. |
| `/team` / tmux team execution | `$team` / `omx team` | Use for durable multi-agent execution when overhead is justified. |
| `/ralph` persistent completion loop | `$ralph` | Use for single-owner completion/verification loops. |
| `/ultrawork` parallel execution | `$ultrawork` | Use for high-throughput independent task waves. |
| `/autopilot` | `$autopilot` if available, or manual `$deep-interview → $ralplan → $ultragoal/$team` | Keep anti-hall gates explicit. |
| OMC HUD/status | OMX HUD/statusline | Anti-hall Codex docs should refer to OMX HUD, not Claude statusline. |
| Claude Workflow JS | OMX skills/pipeline/native subagents | Do not execute Claude workflow JS in Codex. |

## Anti-hall alignment notes

- `anti-hall-omx` is the correct Codex-side integration skill.
- `anti-hall-feature-launch` should say Codex feature work can use OMX `$plan`, `$ralplan`, `$team`, `$ralph`, `$ultragoal`, or `$pipeline` after graphify/planning gates.
- `anti-hall-context-conserve` should route mechanical work to spark/mini and preserve main-thread context, matching both Codex subagent docs and OMX role routing.
- If docs say “swarm,” clarify whether it means legacy/deprecated naming, native Codex subagents, or OMX team mode.

## Source audit (10+ sources, 2+ official)

1. **Official OpenAI:** Codex manual, Plugins — https://developers.openai.com/codex/plugins
2. **Official OpenAI:** Codex manual, Build plugins — https://developers.openai.com/codex/plugins/build
3. **Official OpenAI:** Codex manual, Hooks — https://developers.openai.com/codex/hooks
4. **Official OpenAI:** Codex manual, Subagents concepts — https://developers.openai.com/codex/concepts/subagents
5. **Official OpenAI:** Codex manual, Workflows — https://developers.openai.com/codex/workflows
6. **Official OpenAI:** Codex manual, Configuration Reference — https://developers.openai.com/codex/config-reference
7. oh-my-codex npm metadata (`oh-my-codex@0.18.16`, verified with `npm view`) — https://www.npmjs.com/package/oh-my-codex
8. oh-my-codex GitHub repository metadata — https://github.com/Yeachan-Heo/oh-my-codex
9. oh-my-codex homepage metadata — https://yeachan-heo.github.io/oh-my-codex
10. Installed OMX package manifest — local path `~/.nvm/versions/node/v24.14.0/lib/node_modules/oh-my-codex/package.json`
11. Installed OMX Codex plugin manifest — local path `~/.codex/plugins/cache/oh-my-codex-local/oh-my-codex/0.18.16/.codex-plugin/plugin.json`
12. Installed OMX hook bundle — local path `~/.codex/plugins/cache/oh-my-codex-local/oh-my-codex/0.18.16/hooks/hooks.json`
13. Installed OMX skill manifests — local path `~/.nvm/versions/node/v24.14.0/lib/node_modules/oh-my-codex/skills/*/SKILL.md`
14. OpenAI Codex CLI npm metadata (`@openai/codex@0.142.4`, verified with `npm view`) — https://www.npmjs.com/package/@openai/codex

## Verification status

- `omx --version` returned `oh-my-codex v0.18.16` in this repo session.
- `npm view oh-my-codex ... --json` returned version `0.18.16`, repository, homepage, and description.
- Installed skill manifests were sampled from the local package. The `swarm` skill is marked deprecated in the installed copy.
