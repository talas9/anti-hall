'use strict';
// anti-hall :: node-hook-flags — the Node/V8 flags the transcript-heavy hooks run with.
//
// WHY: Node 24+ (Maglev on by default) can deadlock inside process.exit().
// A V8 background thread compiling code (Maglev via concurrent recompilation,
// or Sparkplug via concurrent sparkplug) runs out of heap and waits for the
// main thread to collect garbage (CollectionBarrier::AwaitCollectionBackground).
// The main thread is already in process.exit -> NodePlatform::Shutdown ->
// uv_thread_join, waiting for that same thread. Neither side moves; the hook
// sits there until the harness kills it at its timeout. Upstream:
// nodejs/node#54918 and #64274 (both open). Replaying a real 14.8 MB Stop
// transcript through silent-agent-nudge hung in about 1% of runs on Node 24
// and 26 (0 on Node 22, where Maglev is off by default).
//
// FIX: with both concurrent compilers off, no background thread allocates on
// the JS heap, so nothing can be in flight at exit. Measured cost: about 1 ms
// on a small hook, none measurable on a heavy one. Setting these flags from JS
// (v8.setFlagsFromString) does NOT work: the compile dispatchers are fixed when
// the isolate starts, so they must be on the command line.
//
// SCOPE: only hooks that may parse 1.5 MB or more of the session transcript
// before exiting get the flags: the 1.5 MB transcript-tail.js window (directly
// or via agent-scan, context-pct, dispatch-demand, inline-work-nudge), the
// emit-dedupe shouldEmit scan (256 KB, widened to a 4 MB tail on a miss), or a
// wider window.
// Hooks that read at most 512 KB (speculation-guard, speculation-judge), 128 KB
// (merge-gate) or the 64 KB Jev turn reference keep the plain `node` command.
// The rate is unmeasured below the 1.5 MB window.
const NODE_HOOK_FLAGS = ['--no-concurrent-recompilation', '--no-concurrent-sparkplug'];

// Hook scripts whose commands carry NODE_HOOK_FLAGS, with the transcript read that exposes each.
const EXPOSED_HOOKS = {
  'ask-guard.js': 'agent-scan runningAgentsOrNull, 1.5 MB tail',
  'auto-handover.js': 'context-pct, 1.5 MB tail',
  'auto-handover-pause-nag.js': 'readTail, 1.5 MB',
  'claim-ledger.js': '2 MB evidence window',
  'codex-nudge.js': 'agent-scan scanTranscript, 1.5 MB tail',
  'compact-advice-guard.js': 'readTail + context-pct, 1.5 MB',
  'compact-declaration-guard.js': 'readTail, 1.5 MB',
  'devswarm-child-turn.js': 'emit-dedupe shouldEmit, up to a 4 MB tail',
  'devswarm-parent-inbox.js': 'emit-dedupe shouldEmit, up to a 4 MB tail',
  'dispatch-tier.js': 'readTail, 1.5 MB',
  'limit-conserve-inject.js': 'emit-dedupe shouldEmit, up to a 4 MB tail',
  'edit-guard.js': 'inline-work-nudge readTail, 1.5 MB (DevSwarm Primary past its edit threshold)',
  'precompact-snapshot.js': 'readTail, 1.5 MB',
  'silent-agent-nudge.js': 'agent-scan over a 64 MB window',
  'stale-agent-stop-note.js': 'agent-scan over a 64 MB window',
  'task-guard.js': '1.5 MB tail + dispatch-demand + agent-scan',
  'task-tracker.js': 'readTail, 1.5 MB, several passes; emit-dedupe up to 4 MB',
  'tasklist-guard.js': '512 KB tail with a 16 MB fallback + agent-scan',
  'verify-first.js': 'emit-dedupe shouldEmit, up to a 4 MB tail (every prompt)',
};

// hooks/hooks.json and codex/hooks/hooks.json carry the flags as literal text
// (JSON cannot import); tests/hygiene/node-hook-flags.test.js checks that exactly
// these entries carry them and that the running Node accepts them.
module.exports = { NODE_HOOK_FLAGS, EXPOSED_HOOKS };
