// Batch-6 additions to the `ah` API (D88): the task list, the agent scan, the Jev outcome and cache probes, the plugin versions
// and the CPU count. Shaped from the raw `ahHost` functions the engine installs; they carry no rule.
'use strict';
Object.assign(ah.transcript, {
  // The task list a transcript tail shows, rebuilt as the Node hooks rebuild it. variant: 'guard' (task-guard.js), 'state'
  // (lib/task-state.js) or 'scan' (the task part of tasklist-guard.js). window: bytes of tail (the shipped default when 0); wide: only
  // 'scan' reads it. Returns {unsure: true}, or for guard/state {tasks: [{id, content, description, status (null: unknown), owner,
  // blockedBy, blockedOn (absent: never set), priority, subjectUpdated, unknown, blockUnknown, sinceMs}], windowReset, firstCreated,
  // truncated} in task-list order ({tasks: [], unreadable: true} when the file cannot be read), or for scan {sawTaskActivity,
  // taskStoreReset, inProgressCount, openTaskIds} ({quiet: true}: the Node hook ends silently; {unreadable: true}).
  tasks: function (p, variant, window, wide) { return JSON.parse(ahHost.transcriptTasks(p, variant, window || 0, wide || 0)); },
  // Every agent the tail shows launched, in launch order, and the ids with terminal evidence: null (unreadable), {unsure: true}, or
  // {launched: [{id, adopted, outputFile, description, launchedAtMs, toolUseId, resumedAtMs, teammate, lastSeenMs, pendingMessage,
  // spawnInput}], terminal: [id]} (a time that is unknown is null).
  // {launched, terminal, pending} (see ahHost.agentScan); `ignoreStops` skips a TaskStop with no result yet
  agentScan: function (p, tailBytes, ignoreStops) { var r = ahHost.agentScan(p, tailBytes || 0, !!ignoreStops); return r === null || r === undefined ? null : JSON.parse(r); },
});
Object.assign(ah.jev, {
  // Report a later observed result against the decision with that hash (the decision log row `outcome`); projectFrom: a directory.
  recordOutcome: function (id, hash, outcome, source, projectFrom) { ahHost.jevRecordOutcome(id, hash, outcome, source || null, projectFrom || null); },
  // Whether the Jev master switch is on for this request (an integration can still be off: see jev.mode).
  enabled: function () { return ahHost.jevEnabled(); },
  // Whether the shared answer cache holds an answer under `hash`: true, false, or null when the file is one only JavaScript reads.
  cacheHas: function (hash) { return ahNull(ahHost.jevCacheHas(hash)); },
});
ah.plugin = {
  // {running, registered, unsure}: the version of the plugin at `root` (null when unreadable) and the one the host registered.
  versions: function (root) { return JSON.parse(ahHost.pluginVersions(root || '')); },
};
// The CPU count as Node's os.availableParallelism() reads it, or null when the engine cannot read it the same way.
ah.sys.cores = function () { return ahNull(ahHost.cores()); };
// The home directory state files may live under: {status: 'ok' | 'guarded' | 'unknown', home} (guarded: a test run against the real
// home, so a hook reads and writes no state; unknown: no usable HOME).
ah.homeGuard = function () { return JSON.parse(ahHost.homeGuard()); };
// The project root of an absolute working directory as the handover finder resolves it, or null when the engine cannot tell.
ah.project = { root: function (cwd) { return ahNull(ahHost.projectRoot(cwd)); } };
