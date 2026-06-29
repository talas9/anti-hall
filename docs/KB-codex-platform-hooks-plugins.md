# KB — Codex platform hooks, plugins, skills, and customization

> Codex equivalent for the Claude-platform parts of `KB-claude-codex.md`.
> Compiled 2026-06-30 from official Codex manual pages, local installed Codex/OMX manifests, and public package/repository metadata.

## TL;DR

Codex has first-class equivalents for the anti-hall distribution surfaces: `AGENTS.md`, skills, plugins, MCP, config, hooks, permissions, and marketplace lists. It is **not** a byte-for-byte Claude Code runtime: Codex plugin packaging uses `.codex-plugin/plugin.json`; Codex hooks use `hooks.json` or inline `[hooks]`; plugin-bundled hooks can be referenced from the manifest; and hook trust/review is part of the runtime.

## Current verified facts

| Area | Codex fact | Port implication |
| --- | --- | --- |
| Skills | Skills are directories with `SKILL.md` frontmatter containing `name` and `description`; Codex uses progressive disclosure and can invoke skills explicitly or implicitly. | Anti-hall Codex skills under `plugins/anti-hall/codex/skills/*/SKILL.md` are the right reusable-workflow surface. |
| Plugins | Plugins bundle skills, apps, MCP servers, and lifecycle hooks into installable workflows. Minimal manifest lives at `.codex-plugin/plugin.json`. | Anti-hall needs `.codex-plugin/plugin.json`, `skills`, and `hooks` entries. |
| Marketplace | Repo marketplace files live under `.agents/plugins/marketplace.json`; personal marketplace files under `~/.agents/plugins/marketplace.json`; entries point `source.path` at plugin folders. | A Codex marketplace entry must be added separately from `.claude-plugin/marketplace.json`; Claude marketplace format is not enough. |
| Hooks | Hooks are enabled by default unless `[features].hooks = false`; canonical key is `hooks`; Codex still accepts deprecated `codex_hooks`. | Installer should write `[features]
hooks = true` defensively, but docs should use `hooks` as canonical. |
| Hook locations | Codex discovers hooks next to active config layers (`hooks.json` or inline `[hooks]`) and from enabled plugins. | Project `.codex/hooks.json` and plugin-scoped `codex/hooks/hooks.json` are both valid patterns. |
| Hook events | Official current docs list `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, and `SessionStart`. | Earlier migration notes that only shell hard-hooks worked are stale for current docs; port alignment must be rechecked against current Codex behavior before claiming hard parity. |
| Hook handlers | Current docs say only `type: "command"` runs; `prompt` and `agent` handlers are parsed but skipped. | Anti-hall should use command hooks only. |
| Matchers | `PreToolUse` matchers include `Bash`, `apply_patch`/`Edit`/`Write`, and MCP tools; `UserPromptSubmit` and `Stop` ignore matchers. | The Codex port can attempt edit-time matchers in plugin hooks, but should test live behavior before claiming api-guard/ship-it hard parity. |
| Trust | Non-managed command hooks must be reviewed/trusted; changed hooks are skipped until trusted unless bypassed for that invocation. | Dogfood must include `/hooks` or trust-state verification, not just file existence. |
| `AGENTS.md` | Codex reads global and project `AGENTS.md`/`AGENTS.override.md`, with closer project files taking precedence. | The repo `AGENTS.md` is a durable Codex policy surface, not a Claude plugin install artifact. |
| Config | `~/.codex/config.toml` and project `.codex/config.toml` hold model, reasoning, sandbox, approval, MCP, hooks, and feature defaults. | Keep Codex config separate from Claude settings; do not write Claude hook JSON into active Codex config. |
| MCP | Codex MCP setup belongs in Codex config and plugins can bundle MCP config. | Anti-hall should not assume Claude MCP config applies to Codex. |

## Anti-hall port alignment checklist

- `.codex-plugin/plugin.json` exists and parses.
- Manifest has a `skills` path and a `hooks` path if plugin-scoped hooks are shipped.
- `codex/hooks/hooks.json` uses `${PLUGIN_ROOT}` for plugin-bundled hook commands.
- Project/global installer writes `.codex/hooks.json` and `.codex/config.toml` only, not Claude settings.
- Hook commands are `type: "command"`.
- No missing asset references in `interface.logo`, `composerIcon`, or screenshots.
- Marketplace entry uses Codex marketplace shape under `.agents/plugins/marketplace.json`, not Claude `.claude-plugin/marketplace.json`.
- Dogfood verifies hook trust and actual hook behavior, not just file creation.
- Edit-time anti-hall guards require a Codex payload adapter before hard-parity can be claimed: `api-guard.js` currently extracts Claude `tool_name` values `Write`, `Edit`, and `MultiEdit`, while Codex docs name `apply_patch`/`Edit`/`Write` matchers.

## Source audit (10+ sources, 2+ official)

1. **Official OpenAI:** Codex manual, Agent Skills — https://developers.openai.com/codex/skills
2. **Official OpenAI:** Codex manual, Custom instructions with AGENTS.md — https://developers.openai.com/codex/guides/agents-md
3. **Official OpenAI:** Codex manual, Hooks — https://developers.openai.com/codex/hooks
4. **Official OpenAI:** Codex manual, Plugins — https://developers.openai.com/codex/plugins
5. **Official OpenAI:** Codex manual, Build plugins — https://developers.openai.com/codex/plugins/build
6. **Official OpenAI:** Codex manual, Configuration Reference — https://developers.openai.com/codex/config-reference
7. **Official OpenAI:** Codex manual, Advanced Configuration — https://developers.openai.com/codex/config-advanced
8. **Official OpenAI:** Codex manual, Model Context Protocol — https://developers.openai.com/codex/mcp
9. **Official OpenAI:** Codex manual, Permissions — https://developers.openai.com/codex/permissions
10. **Official OpenAI:** Codex manual, Build plugins marketplace section — https://developers.openai.com/codex/plugins/build#build-your-own-curated-plugin-list
11. OpenAI Codex CLI npm metadata (`@openai/codex@0.142.4`, verified with `npm view`) — https://www.npmjs.com/package/@openai/codex
12. OpenAI Codex CLI repository metadata (`git+https://github.com/openai/codex.git`, verified with `npm view`) — https://github.com/openai/codex
13. Open agent skills specification — https://agentskills.io/specification
14. OpenAI skills examples — https://github.com/openai/skills

## Verification status

- Official Codex manual fetched locally on 2026-06-30: `/var/folders/6s/s5c6_sx91wl2rxby6l4gmkzh0000gn/T/openai-docs-cache/codex-manual.md`.
- Local installed examples checked: OpenAI bundled browser plugin and oh-my-codex manifests under `~/.codex/plugins/cache/.../.codex-plugin/plugin.json`.
- This KB should be rechecked before release if Codex docs or installed Codex version changes.
