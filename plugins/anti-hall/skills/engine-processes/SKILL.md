---
name: engine-processes
description: "Use when a warning names an orphaned process, a stuck agent, heavy CPU or memory use or low disk space, or you need to tune or switch off the process, resource or disk watch."
---

# Process, resource and disk watch

Leftover processes, runaway CPU or memory and low disk space.

## Guards

- `procwatch-advisory`: SessionStart, UserPromptSubmit and PreToolUse advisory: leftover processes of ended Claude sessions, agents silent past a threshold,...

## Switches

- `procwatch.buildDaemonMode` = "report": Mode of the build_daemon class (build tool daemons): off | report | kill
- `procwatch.devServerMode` = "report": Mode of the dev_server class (dev servers and watchers an agent started): off | report | kill
- `procwatch.mcpServerMode` = "report": Mode of the mcp_server class (MCP servers of ended sessions): off | report | kill
- `procwatch.otherMode` = "report": Mode of the catch-all class (any other process a Claude session started and left behind, oldest first): off | report | kill
- `procwatch.shellTaskMode` = "report": Mode of the shell_task class (background shell commands of ended sessions): off | report | kill
- `procwatch.testRunnerMode` = "report": Mode of the test_runner class (test runners and their children): off | report | kill
- `procwatch.stuckMinutes` = 20: Minutes without output after which a background agent of this session is reported as stuck (procwatch.stuckMinutes)
- `procwatch.enabled` = true: Where the master switch of the process watch is read from (procwatch.enabled, default on): the scheduled sweep and the advisory
- `resourceWatch.cooldownSeconds` = 900: Least time before the same process (or the same system warning) is named again (resourceWatch.cooldownSeconds)
- `resourceWatch.cpuPercent` = 90: Warn when a process of a live session averages at least this much CPU (per-core percent, 100 = one core) over the whole window...
- `resourceWatch.cpuWindowSeconds` = 120: The window a CPU reading must hold for, in seconds (resourceWatch.cpuWindowSeconds); the sampling interval is schedule.procwatch_ms
- `resourceWatch.macPressureLevel` = 2: Warn when the macOS memory pressure level is at least this (2 warn, 4 critical; resourceWatch.macPressureLevel; 0 turns it off)
- `resourceWatch.memoryMb` = 4096: Warn when a process of a live session holds at least this much memory, in MB (resourceWatch.memoryMb)
- `resourceWatch.pressurePercent` = 25: Warn when Linux memory pressure (PSI some avg10) is at least this percent (resourceWatch.pressurePercent; 0 turns it off)
- `resourceWatch.renice` = false: Opt-in (default off): lower the priority of a process the watch warned about, once (resourceWatch.renice)
- `resourceWatch.enabled` = true: Where the resource watch's on/off switch is read from (resourceWatch.enabled, default on)
- `resourceWatch.swapMb` = 8192: Warn when the system has this much swap in use, in MB (resourceWatch.swapMb; 0 turns the swap warning off)
- `diskWatch.blockAtCritical` = false: Opt-in (default off): at the critical level, block heavy commands instead of only warning (diskWatch.blockAtCritical)
- `diskWatch.cooldownSeconds` = 1800: Least time before the same volume is warned about again at the same level (diskWatch.cooldownSeconds); a worse level is never held back
- `diskWatch.criticalGb` = 5: Critical when a watched volume has less than this free, in GB (diskWatch.criticalGb; 0 = not used)
- `diskWatch.criticalPercent` = 3: Critical when a watched volume has less than this percent free (diskWatch.criticalPercent; 0 = not used)
- `diskWatch.enabled` = true: Where the disk watch's on/off switch is read from (diskWatch.enabled, default on)
- `diskWatch.warnGb` = 20: Warn when a watched volume has less than this free, in GB (diskWatch.warnGb; 0 = not used)
- `diskWatch.warnPercent` = 10: Warn when a watched volume has less than this percent free (diskWatch.warnPercent; 0 = not used)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
