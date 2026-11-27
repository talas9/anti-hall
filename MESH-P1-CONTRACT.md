# GH #845 mesh phase 1: the contract between lanes

Status: binding for mesh-p1 (Rust), mesh-node (Node parity), mesh-sim (replay/race harness) and mesh-style.
It replaces the phase-1 parts of `mesh-queue-design.md` after the Codex review (`mesh-design-codex-review.md`).
If a lane needs a change, it messages mesh-p1. This file is edited only by mesh-p1, in the same commit as the code.

Owner call 2026-11-28: all three switches ship ON (no Node writer runs live; replay gate passed in mesh-sim).

## 1. Store: new `messages` columns

Both columns are added with `ALTER TABLE` at open, through `mesh_write.messages_added_columns`. Both are NULL on legacy rows.

| Column | Type | Written by | Values |
|---|---|---|---|
| `wake_audience` | TEXT | the sender, in the INSERT's transaction (Rust: `BEGIN IMMEDIATE`, INSERT, UPDATE, COMMIT) | `all` · `none` · a JSON array of registry ids, sorted and deduped, e.g. `["87604f72-…","primary-63f9261d"]` |
| `chat_kind` | TEXT | the sender, same transaction | `ack` (only with the explicit `--ack-only` flag), else NULL |

- A legacy row has `wake_audience IS NULL`. Readers classify it at read time with the §3 fallback rule.
- A legacy row has `chat_kind IS NULL`. That is normal mail, always.
- Node writers never write either column. Node readers must tolerate both columns being present or absent: select by name and never use `SELECT *` positionally.

## 2. Send-time audience resolution (Rust send; Node send must match before it may write broadcasts with `--question`)

The input is one broadcast: sender id, body, urgency, `--question`, and the roster (registry ids), as `send` already reads them.

1. Collect the mention tokens from the body with `mesh_wake.mention_re` (case-insensitive; group 1 is the token, lower-cased).
   - A token in `mesh_wake.mention_all` (`all`, `everyone`) or `mesh_wake.mention_admin` (`admin`: the owner relay `[@admin] …`)
     is `ALL` (honoured only from a role in `mesh_wake.mention_all_roles`; a child's `RE @admin` addresses no one).
   - Owner rule (2026-11-28): a plain Primary broadcast (no @all/@admin, question, high/urgent or mention) wakes no child; the
     Primary sends orders as `@all` or `--urgency high`.
   - A token in `mesh_wake.mention_primary` (`primary`) resolves to every registry id that starts with `mesh_write.primary_prefix`.
   - Any other token resolves to the registry ids it equals, or that it prefixes when it is at least `mesh_wake.mention_min_prefix` (6) characters long. Matching is case-insensitive.
   - A token that resolves to nothing (for example `admin`) is ignored.
   - A token that prefixes two or more ids is AMBIGUOUS.
2. The sender's role is `primary` when the sender id starts with `mesh_write.primary_prefix`; otherwise it is `child`.
3. The audience:
   - **Mentions narrow.** If any token resolved to ids, the audience is the union of those ids, minus the sender. This holds even with `--question` or an urgent urgency. `ALL` from a sender whose role is in `mesh_wake.mention_all_roles` widens to `all`.
   - Otherwise, if `--question`, or (urgency in `mesh_wake.broadcast_wake_urgency` AND role in `mesh_wake.broadcast_wake_roles`), or (`ALL` AND role in `mesh_wake.mention_all_roles`): the audience is `all`.
   - Otherwise it is `none`.
4. Refusals:
   - A `--question` broadcast with an AMBIGUOUS token is refused, with reason `mesh_wake.reason_ambiguous_mention`.
   - A `--question` broadcast while `mesh_wake.allow_broadcast_question` is 0 is refused, as today.
   - An unresolved token never refuses.
5. A heartbeat broadcast is always `none`, even when its body mentions someone.

## 3. Who a broadcast wakes (every reader: Rust summary, Node summary, the replay)

Broadcast row R wakes reader X when all of these hold:
- R is not a heartbeat;
- R's sender is not in X's identity family (the existing own-sender exclusion);
- R is not `chat_kind = 'ack'` while `mesh_chat.ack_suppression` is 1;
- and, depending on `mesh_wake.addressed_mode`:
  - `off` (the default, the rule before #845): any such R;
  - `on`:
    - with `wake_audience` = `all`: yes;
    - with `none`: no;
    - with a JSON array: X is in it;
    - with NULL (a legacy row): run the §2 audience rule on the row's own body, sender, urgency and `needs_reply` against the current roster, then apply the result as above.
- A Primary reader with `mesh_wake.primary_reader = "all"` (the default) is woken by any R that passes the first three conditions, whatever the mode.

## 4. Summary JSON (per workspace row in `summaries/<repoKey>.json`). EVERY writer, Rust and Node, writes it

| Key | Type | Meaning |
|---|---|---|
| `broadcastWakeSeq` | number or `null` | The highest `seq` among X's UNREAD broadcasts (seq > X's broadcast cursor) that wake X under §3; `null` when there are none. It is NOT a count, so it never needs to go down for a new arrival to be seen. |
| `broadcastWakePending` | number | How many such broadcasts. For display and the start-up reconcile only; never a wake edge. |
| `broadcastUnreadFromOthers` | number | Unchanged (legacy, display). |

- Config names: `mesh_wake.summary_field_seq` = `broadcastWakeSeq` and `mesh_wake.summary_field_pending` = `broadcastWakePending`.
- A writer that does not know these keys must not run once a watcher reads them. That is the order: mesh-node lands the Node writers (devswarm-store.js `deriveSummary` ~:3325, and its callers parent-inbox.js:1607, child-turn.js:874, ingest.js:1606/1750) before the watchers switch.

## 5. Wake-watch broadcast channel (Rust watcher; the Node watcher must match)

The persisted seen file gains `lastBroadcastWakeSeq` (number) and `seenVersion` (2). Both are added to `wake_watch.seen_owned_keys`.

Each tick, for the watched row, where `wake_watch.field_broadcast_seq` = `broadcastWakeSeq` and `wake_watch.field_broadcast_pending` = `broadcastWakePending`:
- **The row has the key `broadcastWakeSeq`** (a number or `null`). This is the capability gate.
  - `seq` is a number and `seq > lastBroadcastWakeSeq`: print one broadcast wake line, then set `lastBroadcastWakeSeq = seq`.
  - Otherwise: nothing. The watermark never goes down.
  - **Start-up or upgrade.** If there is no `lastBroadcastWakeSeq`, or the seen file's `seenVersion` is under 2:
    - if `broadcastWakePending > 0`, print ONE wake line (pending eligible mail is never seeded away) and set the watermark to `seq`;
    - else set the watermark to `seq` (or 0) silently.
- **The row lacks the key** (an old writer): fall back to today's legacy count channel (`wake_watch.field_broadcast` = `broadcastUnreadFromOthers`, rising edge, unchanged). A watcher that has the
  watermark field keeps `lastBroadcastUnread` in step silently, so switching between writers never fires a spurious line.
- `wake_watch.seen_version` = 2. `lastBroadcastWakeSeq` is written only once known (never a placeholder 0).
- **Every arm** (a fresh or restarted watcher, not only an upgrade): if `broadcastWakePending > 0`, print ONE wake line (review P1-2).
- **A line that fails to print** does not move the watermark: the old one is kept and marked unknown (not saved), so the next tick prints again (review P1-2).
- **Re-arm after an ack** (review P1-1): when `broadcastWakePending` drops but stays above 0 with `seq` not above the watermark (an ack left eligible rows unread), print one line. The previous pending count is kept in memory only.
- Ambiguous mention on a plain (non-question) broadcast: the audience is every id it prefixes (never fewer). A legacy-row question
  with an ambiguous mention is read the same way.
- `mesh_write.boolean_only_flags` gains `ack-only`. `inbox ack --broadcast-to` with a non-number is refused
  (`mesh_wake.msg_broadcast_to_not_number`).

The broadcast line text is unchanged (`wake_watch.line_wake`, label `wake_watch.label_broadcast`). Coalescing is unchanged.

## 6. Read receipt: the broadcast op (Rust AND Node receipt readers learn it FIRST, before any writer emits it)

A read-primary receipt (`v` stays `mesh_write.receipt_version` = 1; unknown ops are already skipped by both readers, so an old reader leaves the broadcasts unread, never acks them) may carry:

```json
{"k": "bc", "opv": 1, "reader": "<registry id>", "from": <cursor seq at read>, "target": <seq of the last broadcast delivered>, "delivered": <rows listed>}
```

- `k` is config `mesh_write.op_broadcast` = `bc`.
- **Apply:** set the reader's `broadcast_cursors.value` to `max(current, target)`. It never goes back. It is applied in the same ack as the `own` op.
- **The delivered boundary.**
  - The read lists the OLDEST `mesh_wake.inbox_broadcast_cap` unread non-heartbeat broadcasts of others, in seq order.
  - `target` = the seq of the last one listed. Heartbeats and own rows with seq ≤ target are passed over with them.
  - When nothing is listed, there is no op.
  - Rows past the cap stay unread; the result says `broadcastsMore: true`.
- A read never samples `MAX(seq)` to advance.

The child drain stays read-only:
- `inbox read <id>` lists the same rows under `broadcasts` and prints `broadcastAckTarget` (the delivered boundary).
- `inbox ack <id> --broadcast-to <seq>` (flag `mesh_write.flag_broadcast_to` = `broadcast-to`) moves the broadcast cursor to `min(seq, live head)`. It never moves past it, and never moves without the flag.

The drain result keys are:

| Config key | Value |
|---|---|
| `mesh_wake.key_broadcasts` | `broadcasts` |
| `mesh_wake.key_broadcast_ack_target` | `broadcastAckTarget` |
| `mesh_wake.key_broadcasts_more` | `broadcastsMore` |
| `mesh_wake.key_broadcast_cursor` | `broadcastCursor` (where an ack moved it) |

Each listed row: `{from, message, kind:"broadcast", timestamp, urgency, seq, needsReply, addressed}`. `addressed` is the §3 verdict with `addressed_mode = on`.

Direct mail (review, the direct-mail ack race): `inbox read` prints `ackThrough` (`mesh_wake.key_ack_through`), a token `nd:<pos>,store:<pos>[,<sibling id>:<pos>]` naming exactly what it delivered. `inbox ack <id> --through <token>` (`mesh_wake.flag_ack_through`) holds each cursor to that boundary (a cursor the token does not name stays put); without `--through` the ack takes everything unread at ack time, as before. The `ackHint` names the `--through` form.

The cap (review P1-1): a drain lists the oldest `mesh_wake.inbox_broadcast_cap` unread rows, then, past the cap, only the rows that wake the reader, up to `mesh_wake.inbox_broadcast_eligible_cap`. The ack target is the last row before the first one held back, so a row listed past a gap stays unread and is listed again. `mesh read` / `roster --ack` ack through the last row they listed, never the live head (review P1-3).

## 7. Explicit ack-only (LAST; switch off)

- `mesh send --to X --ack-only --message "here"`: flag `mesh_chat.flag_ack_only` = `ack-only`. It stores `chat_kind = 'ack'`. It is refused together with `--question` or `--answers`. There is no regex classification.
- With `mesh_chat.ack_suppression` = 1, every reader does all of these:
  - leaves `chat_kind='ack'` rows out of `directTotalFromOthers` (Rust `message_count_from_others_except`; Node, both `messageCountFromOthers` copies), out of `inbox tick`'s wake count, and out of the NDJSON wake path;
  - skips the native wake for a send that inserted an ack row.
- `inbox tick` (the Codex poll, review P1-4) adds `wakeDirect` (`mesh_wake.tick_field_wake_direct`: unread direct mail without unread ack rows, matched by store seq or, for an NDJSON line, by its `_h` hash), `broadcastWakePending`/`broadcastWakeSeq` (the same per-reader rule as the summary) and `wake` (`mesh_wake.tick_field_wake` = `wakeDirect` + `broadcastWakePending`). `unreadTotal` is unchanged. The `--quiet` line appends `mesh_wake.tick_line_wake` (`, wake N`) only when `wake` differs from `unreadTotal`. A poll loop acts on `wake`.
- At 0, an ack row is ordinary mail everywhere.

## 8. Switches and config keys (plugin `engine/defaults/mesh_wake.toml`, `mesh_chat.toml`; pristine twins byte-identical)

| Key | Default | Meaning |
|---|---|---|
| `mesh_wake.addressed_mode` | `"on"` | §3; `on` activates addressee-only broadcast wakes |
| `mesh_wake.allow_broadcast_question` | `1` | `--question` on `--broadcast` |
| `mesh_wake.primary_reader` | `"all"` | `all` or `addressed` |
| `mesh_wake.broadcast_wake_urgency` | `["high","urgent"]` | |
| `mesh_wake.broadcast_wake_roles` | `["primary"]` | |
| `mesh_wake.mention_re` | `(?:^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]*)` | JS regex source, `i` |
| `mesh_wake.mention_all` | `["all","everyone"]` | |
| `mesh_wake.mention_all_roles` | `["primary"]` | |
| `mesh_wake.mention_primary` | `["primary"]` | |
| `mesh_wake.mention_min_prefix` | `6` | |
| `mesh_wake.inbox_broadcast_cap` | `50` | |
| `mesh_wake.audience_all` / `audience_none` | `"all"` / `"none"` | the `wake_audience` words |
| `mesh_chat.kind_ack` | `"ack"` | |
| `mesh_chat.flag_ack_only` | `"ack-only"` | |
| `mesh_chat.ack_suppression` | `1` | |
| `mesh_write.op_broadcast` | `"bc"` | |
| `wake_watch.field_broadcast_seq` / `field_broadcast_pending` | `broadcastWakeSeq` / `broadcastWakePending` | |

The phase-1 regex ack classification (`mesh_chat.ack_re`) is withdrawn.

## 9. Gate (mesh-sim)

On the 24 h replay plus the race matrix (Codex review §P2), all three must be 0:
- 0 missed eligible messages;
- 0 non-addressee wakes (with `addressed_mode = on`);
- 0 unseen acks.

One coalesced line is fine if the reader's next drain delivers the whole batch.

The races:
- drain plus arrival between polls;
- start-up with pending mail;
- Rust/Node writer alternation;
- Codex tick;
- truncated reads (cap);
- failed print;
- receipt retry.

## 10. P0 telemetry (shipped in mesh-p1, unchanged)

- Cmd events `mesh-send-stage.<stage>`.
- The `stages` map on the mesh shadow log.
- Counters `mesh_wake_lines{channel,role}` and `mesh_wake_suppressed{reason}`.

## 11. Sender identities (owner 2026-11-28; `engine/defaults/mesh_identity.toml`)

- Declared senders (`mesh_identity.identities`): `admin` = `{display "admin", kind "human", rank 100}`; `ah-engine` = `{display "ah-engine", kind "human-proxy", on_behalf_of "admin", rank 90}`. A Primary ranks `rank_primary` = 50, a child `rank_child` = 10.
- Operator use only. A send declares one with `--as <id>` (`mesh_identity.flag_as`) or the variable `mesh_identity.sender_env` (`AH_MESH_SENDER`); the flag wins. Refused (`msg_agent_refused`) when the caller is an agent: any variable of `agent_env_markers` is set, or `agent_env_builder` (`DEVSWARM_BUILDER_ID`) is set to anything but the declared id. Only identities with `cli = true` are selectable (`admin`); `ah-engine` (`cli = false`) is for the engine's own call sites. Anything else is refused (`msg_unknown_sender`). The owner's room spawns its send with a clean environment and `AH_MESH_SENDER=admin`. The row's sender is the declared id, never the workspace the send runs in, and no alias is written. `--to-primary` from the Primary's own checkout is not a self-send for a declared sender.
- Every new row stores `sender_kind` (a new additive `messages` column, `mesh_write.messages_added_columns`): the declared kind, else `kind_agent` ("agent").
- Rank and kind come from the row's STORED `sender_kind` (the store read attaches it as `senderKind` for a declared kind), never from the sender's name; a legacy or Node row with sender `admin` but no stored kind ranks as a child.
- Wake privilege: a sender with rank >= `privileged_rank` (50) wakes every reader on `@all`, an unmentioned question or an urgent broadcast, exactly as the Primary (wakepolicy §2).
- Display and precedence: drain rows (direct and broadcast) from a declared sender carry `fromKind`, `fromRank`, `fromDisplay` (when it differs from the id) and `onBehalfOf`. When instructions conflict, the higher rank wins.
- Node parity (mesh-node): the same config keys; Node writers may leave `sender_kind` NULL (read as unknown, never an error).
