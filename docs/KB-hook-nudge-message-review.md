# Hook and nudge message review

Scores the most-fired advisory, nudge and block messages against `docs/KB-hook-nudge-effectiveness.md`. Read-only review: no message text was changed by this document.

## Method and limits

- Fire counts: the engine's 7-day telemetry summary (2026-10-31), taken as advise plus block outcomes per hook. Counts are per hook, not per message key; where one hook owns several keys the count is shared and marked "shared". Defer counts are listed where large.
- Texts: the TOML message tables in `plugins/anti-hall/engine/defaults/`, read as shipped (lengths are template lengths before placeholders).
- Channel: the engine's telemetry does not record the delivery channel per message. Channel below is inferred from the hook's event and is marked "inferred" unless observed. Treat inferred rows as UNVERIFIED.
- Not scored, text not read: the role note, the task tracker lines, the parent-inbox and realtime advisories. They rank high by fires or bytes and should be scored next.
- Verdict vocabulary: keep, reword, merge (overlapping messages, or a state-change rate limit), drop, escalate (advisory to gate or block).
- Tone and emphasis follow KB sections 4 and 6: caps and intensifiers are graded OFFICIAL as unhelpful; emoji effect is NOT FOUND, so emoji is noted but not penalised. The shared style guide (`messages.style_guide`) asks for one leading emoji and two lines.

## Scored table (ranked by 7-day fires)

| # | Message key | Fires (7d) | Channel | Length | Tone | Emphasis | Reason or consequence | Verdict | Proposed rewording (plain, factual) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `ctxbudget.ah_what_pct` / `ah_what_tokens` | 6742 | context hook, inferred | 51 / 101 | imperative ("write a handover now") | none | no reason, no consequence | reword; add a state-change rate limit | "Context is at about {pct}%. No handover is saved; a compaction now would lose work not yet written down." |
| 2 | `ctxbudget.lc_what` / `lc_why` / `lc_instead` | 5986 (766 deferred) | context hook, inferred | 40 / 27 / 59 | factual then imperative | none | reason present, no consequence | merge into one line; send on state change only | "Usage is near a plan limit ({reason}). Routine execution goes to Codex or cheaper Claude helpers until it resets." |
| 3 | `verify_first.compact_subagent` + `worker` | 2899 | SubagentStart additionalContext (observed as a start-of-turn reminder) | 1816 + 560 | imperative and absolute | heavy caps ("IRON LAW", "NO SPECULATION"), quoted rationalisation table | rules plus rationale, no consequence | reword: trim and drop caps; it is a rule set, so it competes with the task (KB 6, instruction count) | "Claims in this task need evidence from a tool call. If a fact was not checked, say it is unverified. Done means the check ran this turn and its output is shown. Full protocol: PROTOCOL.md." |
| 4 | `verify_first.compact_session` | 368 | SessionStart additionalContext, inferred | 3071 | imperative and absolute | caps, table | as row 3 | reword: same trim; well under the 10,000 cap, so no spill risk | as row 3, plus one clause that it is re-sent after compaction |
| 5 | `procwatch.msg_orphans_what` / `why` / `instead` | 649 shared (786 deferred) | advisory, inferred | 41 / 80 / 45 | factual then imperative | none | reason present, consequence implicit | keep | keep as is |
| 6 | `procwatch.msg_stuck_what` / `why` / `instead` | shared with row 5 | advisory, inferred | 77 / 123 / 37 | factual then imperative | none | reason present | keep; the "may be stuck" hedge is accurate because silence is not proof | keep |
| 7 | `failure_nudge.msg_what` / `msg_instead` | 589 (186 deferred) | PostToolUseFailure additionalContext, observed | 25 / 46 | factual then imperative | none | no reason | reword; it fires on every failure, so apply the per-step frequency caution (KB 6) | "This command failed and the cause is not known yet. Reading the error output before retrying avoids repeating the same failure." |
| 8 | `swarm_guard.msg_rate_*` and `msg_shared_*` | 548 (35 block) | PreToolUse, inferred | 48 / 41 / 55 and 54 / 70 / 36 | factual then imperative | none | reason present | keep | keep |
| 9 | `model_routing.msg_row1_*` | 444 (16 block) | PreToolUse, inferred | 51 / 89 / 60 | factual then imperative | none | reason refers to the hook's own limit, not the user's goal | reword | "A flagship model was assigned to routine execution, which costs more than a cheaper model needs to. Use model 'haiku', or 'sonnet' if it writes code." |
| 10 | `tasklist_hygiene.msg_done` / `msg_open` / `msg_subject` | 385 (285 deferred) | advisory, inferred | 61 / 30 / 38 | mixed | none | no reason | merge the three into one line per event | "Task {id} is done and has no ledger entry yet; a delegated Cause/Fix/Verified entry records it." |
| 11 | `claim_evidence.msg_claim_what` / `instead` | 287 (285 block) | block, event not verified | 56 / 62 | factual then imperative with an honest exit | none | fact plus exit; closest match to KB 3 | keep (reference example) | keep |
| 12 | `task_guard.prune_block_text` | 216 block | block, event not verified | 124 | imperative | emoji | no reason | reword | "{n} completed tasks (limit {limit}) are still listed. Logging them in the history ledger and then deleting them from the list keeps the list readable." |
| 13 | `tasklist_guard.advisory_text` / `stale_text` | 333 block (shared) | appended to a Stop block, inferred | about 90 each | factual then imperative | emoji | fact present, consequence implicit | reword | "No handover is saved and much work happened since the last one. A handover written before compaction preserves it." |
| 14 | `tasklist_guard.resume_text` | counter not separate | Stop block, inferred | 267 | long imperative | none | no reason | reword and shorten | "A handover was resumed ({file}) but not verified. After running git status, pwd and a smoke command, record `resume-verified: <timestamp> -- <summary>` in it." |
| 15 | `tasklist_guard.plan_mode_text` | 360 flagged, 18 injected | informational | 181 | factual | caps label ("PLAN MODE") | consequence stated | keep; lowercase the label | "Plan mode is active, so progress-file writes are not possible and Stop is not blocked. Update the progress file after leaving plan mode." |

## Findings from the table

1. Two advisory keys account for about 12.7k of the roughly 30k advise outcomes (rows 1 and 2). Neither states a consequence, and nothing here shows they change behaviour. Per KB 6 and 10, per-step repetition risks being read as injection; a state-change trigger is the supported lever.
2. The two heaviest injected-byte producers are doctrine texts (rows 3 and 4; the subagent variant alone injected about 7.6 MB of the 15.1 MB injected in 7 days). They use caps and absolute framing, which the official sources list as unhelpful. Trimming them also lowers the competing-instruction load.
3. The strongest messages (rows 5, 6, 8, 11) share a shape: a fact, a short reason, one action. Rows 7, 9, 10 and 12 to 14 lack the reason or the exit.
4. No scored message states what the system does if the nudge is ignored. KB 6 found no source for consequence wording, so adding one needs the A/B test in KB 9 first.
5. Large defer counts on rows 2, 5, 7 and 10 (about 2,000 in total) were not checked: whether a deferred message is later delivered or dropped is NOT VERIFIED.
