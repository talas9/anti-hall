---
name: anti-hall-engine-doctor
description: "Use when checking whether anti-hall works, repairing it, migrating its state, or scanning what it can do on this machine."
---

# Doctor and repair

Health check, repair, migrations and capability scans.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine briefing` | `[--root <plugin dir>]` A derived inventory of a plugin tree (D81, the port of scripts/briefing.js): every registered hook by event with the purpose from its... | main, codex, workspace, subagent |
| `ah-engine capability-scan` | `[--root <plugin dir>]` A read-only gap report (D81, the port of scripts/capability-scan.js): for each opt-in capability of a plugin tree, whether it is shipped... | main, codex, workspace, subagent |
| `ah-engine defect` | `<report\|list\|show\|rule\|archive\|backfill\|recurring\|similar> [flags] [--json]` File, list, show and rule anti-hall defect reports and query the bug history (L9a, the port of scripts/defect.js): `report`, `list... | main, codex, workspace, subagent (owner args: rule, archive) |
| `ah-engine doctor` | `[--check] [--repair\|--fix] [--dry-run] [--migrations-only] [--quiet] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` The health check and repair of anti-hall (D81), with the Node doctor's report layout and finding texts: the platform and versions, the... | main, codex, workspace, subagent (owner args: --repair, --fix) |
| `ah-engine harvest` | `[--dir <path>] [--stale-days <n>]` Scan a code tree for deliberate-debt markers, `anti-hall: <ceiling>, <when>` in any comment syntax (D81, the port of... | main, codex, workspace, subagent |
| `ah-engine install-codex` | `[--global] [--dry-run] [--root <plugin dir>]` Install the anti-hall hooks for Codex (D81, lane L9b, the port of codex/install-codex.js): merge the generated hook registration into... | main, codex |
| `ah-engine migrate` | `[--dry-run] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` The persisted-state migrations and sweeps of the Node doctor's repair pass (D81): the legacy progress and history copy, the reply-state,... | main, codex |
| `ah-engine shadow-compare` | `<scratch dir>` Internal: the detached half of a Node shadow (L9a) | main, codex, workspace, subagent |
| `ah-engine update` | `[--check] [--post-pull-only]` Update anti-hall (D81, lane L9b, the port of skills/update/scripts/update.js): `git pull --ff-only` of the marketplace clone (a dirty... | main, codex |

## Guards

- `failure-root-cause-nudge`: Advisory after a failed Bash call: trace the cause before patching; silent for expected exit-1 predicates, interrupts, harness refusals...
- `fable-availability`: SessionStart: records whether a Fable model is available (from the host's model cache) in ~/.anti-hall/fable-availability.json and tells...
- `version-alert`: SessionStart advisory: a newer anti-hall release is available or already mirrored locally (port of version-alert.js); a stale remote...
- `claude-cli-version`: SessionStart advisory: the Claude Code CLI drifted by major or minor from the audited version (port of claude-cli-version.js); a stale...
- `repo-self-drift`: SessionStart advisory: docs/KB.md's claimed hook and skill counts differ from disk, or the model KBs were audited too long ago (port of...
- `defect-nudge`: SessionStart advisory, at most daily: unfinished defect reports (in the anti-hall repository) or rulings on defects this project...
- `engine-role-guard`: PreToolUse on Bash: refuses an ah-engine command the caller's role may not run, per the roles.matrix (subagent from the payload,...
- `engine-role-note`: SessionStart and SubagentStart context: tells the session its role, the engine verbs it may use and where the full guide is (the...
- `repair-on-reload`: Stays silent when no repair can start (switch off, subagent turn, skipped, nothing pending at the running version, cooldown); otherwise...
- `codex-availability`: SessionStart: probes PATH for a real codex executable, records it, folds a Codex job-log usage-limit error into the quota record and...
- `codex-quota-detect`: Advisory: records a Codex quota or rate-limit exhaustion reported by a codex:codex-rescue Agent result, once, in the shared availability...
- `codex-nudge`: Stop: one soft nudge to get a Codex second opinion after several substantial code edits with no Codex review; defers when Jev is enabled...

## Switches

- `guards.updateInSession` = true: Where the update-in-session switch is read from (guards.updateInSession, default on)
- `versionAlerts.claudeCli` = true: Switch: alert when the Claude Code CLI drifted from the audited version (versionAlerts.claudeCli)
- `context.defectNudge` = true: Switch: the once-a-day note about the defect channel (context.defectNudge); it has no environment variable
- `versionAlerts.devswarm` = true: Switch: alert when the DevSwarm CLI drifted from the verified version (versionAlerts.devswarm)
- `guards.repoSelfDrift` = true: Switch: anti-hall's own repo-drift self-check (guards.repoSelfDrift)
- `versionAlerts.antiHall` = true: Switch: alert when a newer anti-hall release is available (versionAlerts.antiHall)
- `guards.stopHookVersionDowngrade` = true: Where the stale-build downgrade switch is read from (guards.stopHookVersionDowngrade, default on; hooks/lib/stop-version-gate.js)
- `maintenance.repairOnReload` = true: The switch maintenance.repairOnReload (on by default)
- `codexNudge.enabled` = true: Where the Codex nudge switch is read from (codexNudge.enabled, default on)
- `guards.codexQuotaDetect` = true: Where the Codex quota detection switch is read from (guards.codexQuotaDetect, default on)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
