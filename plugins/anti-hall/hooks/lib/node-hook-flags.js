'use strict';
// anti-hall :: node-hook-flags — the Node/V8 flags every hook command runs with.
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
// hooks/hooks.json and codex/hooks/hooks.json carry the same flags as literal
// text (JSON cannot import); tests/hygiene/node-hook-flags.test.js keeps all
// three in step and checks that the running Node accepts them.
const NODE_HOOK_FLAGS = ['--no-concurrent-recompilation', '--no-concurrent-sparkplug'];

module.exports = { NODE_HOOK_FLAGS };
