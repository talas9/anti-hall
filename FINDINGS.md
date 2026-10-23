# eng-drop findings (WIP)

## Chain: where a request's native answers are dropped (file:line, v301/sweep 4d11b0a2)
- daemon `native::evaluate` (ah-engine/src/dispatch/native.rs:~120-170) runs the request's checks sequentially on one thread; an entry gets
  `Answer::Defer` (no answer) when: (a) `over_cpu()` trips (daemon.rs:882, hard daemon.eval_budget_us = 1 s thread CPU) and then EVERY later
  entry too (`tripped`), (b) `budget::shedding()` (process-wide, >hard 10% CPU; ALL non-guard events' checks), (c) `deadline::client_gone()`
  (client closed the socket), (d) past the HARD request deadline (daemon.request_hard_ms 2000) for cut_at_deadline checks.
- A SOFT deadline overrun (client.deadline_ms) only logs `deadline_soft`; nothing is cut (native.rs:170). The client keeps waiting for a late
  reply up to client.slow_fallback_max_ms - slow_wait_margin_ms (client.rs:69, exchange read loop :130-150) -> logs `client_late` (EAGAIN = the
  read timeout, not a failure).
- Client side (dispatch/mod.rs:~690-760): every entry without a Decided answer -> if its Node command is not runnable (engine-only rows carry
  none; `${CLAUDE_PLUGIN_ROOT}` unset / non-node command) the guard fails closed, a non-guard is logged `dispatch_defer ... skipped: no runnable Node
  command` (mod.rs:715-ish, NOT counted abandoned, no reason); otherwise `resolve_unanswered` (mod.rs:505) counts Abandoned at
  `dispatch:hook:<id>` and applies the check's failure policy (script.failure_mode_by_check).
- "abandoned at dispatch:hook:X" = the daemon gave X no answer; the failure policy decided in its place.
