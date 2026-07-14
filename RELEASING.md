# Releasing anti-hall

Every behavioral or shipped-content change bumps the version and follows this checklist. The agent (not CI) performs the tag manually.

## Checklist (in order)

1. - [ ] Bump `plugins/anti-hall/.claude-plugin/plugin.json` `version` (AND `plugins/anti-hall/.codex-plugin/plugin.json` to match — the two manifests track together; semver: patch=fix/doc, minor=new capability).
2. - [ ] Add a `## <version>` section to `CHANGELOG.md` (top) describing the change. CHANGELOG is the authority; marketplace entry carries no version.
3. - [ ] Update docs for ANY new/changed hook, skill, or discipline:
   - [ ] `README.md` (root) — hooks/skills tables, disciplines.
   - [ ] `plugins/anti-hall/README.md` — features table, Stop-hook count, escape hatch, etc.
   - [ ] `llms.txt` — hooks list, skills, disciplines, docs list.
   - [ ] relevant `docs/*.md` (and `docs/KB.md` topic map).
4. - [ ] Verify: `node --test` (all pass) and `node plugins/anti-hall/hooks/doctor.js` (anti-hall ACTIVE). Never claim done without these THIS change.
5. - [ ] Commit (NO AI-credit / Co-Authored-By trailer — git-guard blocks them).
6. - [ ] `git push origin main`.
7. - [ ] TAG (manual, by agent): `git tag v<version>` then `git push origin v<version>`. Optionally create a GitHub Release from the tag with that version's CHANGELOG section.
8. - [ ] Propagate to the live marketplace dir only (`~/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/`); do NOT overwrite version-pinned `cache/.../<ver>/` snapshots.
9. - [ ] Consider publish venues (see below) for notable releases.

## Doc-currency rule

A version bump that adds/changes a hook/skill/discipline is NOT done until README (root+plugin) + llms.txt + relevant docs reflect it.

## Publish venues (for notable releases)

- Official Community Marketplace (Anthropic plugin-directory submission form) → surfaces on claude.com/plugins.
- Auto-crawl directories (e.g. claudemarketplaces.com) — automatic for public repos with valid `.claude-plugin/marketplace.json`.
- Community awesome-lists (PR): awesome-claude-plugins (ComposioHQ), awesome-claude-code-plugins (ccplugins), awesome-claude-code (jqueryscript).
- Promotion: dev.to/blog post, Show HN (strict no-hype), r/ClaudeAI, X/#ClaudeCode. Needs a demo GIF.

Add a one-line pointer to RELEASING.md from AGENTS.md (in the commit/push hygiene area) if a natural spot exists.
