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

## Verdict on the premise
- A SLOW check alone does not drop other answers: soft overrun only logs (deadline_soft); the client keeps waiting (slow window 2.6 s) and
  the launcher extends its watchdog while the wait file exists. Scratch repro with one 450 ms check: all answers delivered.
- What really drops answers (all proven in code): (1) cumulative per-REQUEST CPU hard budget (1 s): the check that crosses it loses its answer and
  EVERY later check is deferred; (2) CPU hard-limit shedding (diagnostics.budget_cpu_hard_pct 10%) defers ALL checks of non-guard events
  process-wide -- this matches the live "abandoned on every PostToolUse" and the ERROR "daemon CPU hard limit" at the same minute;
  (3) client_gone; (4) hard request deadline.
- Repro (scratch HOME, 3 checks of 450 ms CPU each, PostToolUse):
  BEFORE: budget devswarm-child-drain "cpu budget crossed ... 450420 us"; budget coordinator-work-guard "deferred, cpu budget already spent";
          budget agent-reminders "deferred, cpu budget already spent"; budget "rule evaluation exceeded its cpu budget"
  AFTER:  only client_late / deadline_soft / budget_soft; no budget skip lines; status answers_dropped all 0.

## Fix
- native::evaluate: CPU budget is per check (the check that alone crossed loses only its own answer); no cascade.
- diagnostics.shed_checks (TOML, shipped 0): shedding no longer drops checks of non-guard events; duties + Jev still shed.
- Every dropped answer: budget::note_dropped (reason: shed, client_gone, hard_deadline, cpu_budget, check_deferred), event log kind
  answer_dropped / guard_answer_dropped (rate limited), metric answers_dropped (lifetime), status.answers_dropped.this_daemon vs lifetime.
- Client: an unanswered non-guard entry is no longer logged "skipped: no runnable Node command"; it is counted abandoned with a reason.
  Guards unchanged: unanswered guard with no hook -> fail closed; check failure policy (script.failure_mode_by_check) unchanged.

## Worker syscall CPU (no root: no dtrace/fs_usage; sample + code)
1. script::resolve per check call: read_dir of logic/lib + stat of every lib file (29) + script stats = ~40 file ops per check, ~15 checks per tool call.
   Fixed: shared fingerprint cache, script.fingerprint_ttl_ms = 1000.
2. health::log_event: stat + lock-file open + flock + log open + write per line; 45 of 46 busy worker samples under load were in this flock.
   Self-amplifying: overrun -> deadline_soft line -> serialised lock -> longer. Not changed (needs a buffered logger).
3. per-request state writes (crash breadcrumb, memdiag; task #184) -- not measured here.
- The supervisor duties are NOT the 74%: verdicts 81 ms/call on a 60 s tick = 0.14% of a core.

## Follow-up (shed list, log thread, session cache) -- measured in scratch, same load (4 clients x 120 Pre+Post, soft deadline 1 ms to force log lines, 8 s `sample`)
- Worker threads in flock: base 9 / 9 -> new 0 / 0 (log lines written in the window 221/247 -> 406/316: workers no longer wait on the lock).
- script::resolve cache: new binary with script.fingerprint_ttl_ms=0 (old behaviour) stat 15 + getdirentries 3 vs ttl 1000: stat 3-4, getdirentries 0.
- Next hotspot now: worker __rename 10-15 + __open 17-23 samples = per-request atomic writes (crash breadcrumb, task #184).
- Forced hard CPU limit (budget_cpu_hard_pct=1, windows=1), 400 UPS calls: recorders (agent-reminders, auto-handover, devswarm-child-turn,
  devswarm-parent-inbox, repair-on-reload, task-tracker) decided 400/400; pure advice (verify-first, limit-conserve-inject, idle-agent-sweep,
  devswarm-rt-advisory, gh-rt-advisory, procwatch-advisory) decided 54, shed 346 each; answers_dropped.this_daemon = {optional:shed: 2078}.
- sessions_for cache NOT measured: it runs only from the parent-inbox UPS path (devswarm-parent-inbox.js:1317 piDriftNotice -> host piDrift ->
  host_parentinbox.rs drift_of), which needs a DevSwarm parent roster to reach; not reproducible in a scratch HOME in the time.
- Another drop site seen: a Reply::Busy (per-session/project rate limit, daemon.rs dispatch) answers NOTHING for every entry; not recorded in answers_dropped.
