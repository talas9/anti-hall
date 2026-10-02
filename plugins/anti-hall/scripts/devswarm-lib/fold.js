'use strict';
// anti-hall :: devswarm CLI — FOLD module (scripts/devswarm-lib/fold.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, appendIntoPartition, checkedArchivedDir, descriptorFileGeneration, descriptorFreshRepoKey,
  descriptorPath, descriptorPhysicalOwnerKey, descriptorRegisteredRepoKey, fs,
  hasArchivedCounterpart, hasFreshHeartbeat, heartbeatPathFor, identityContext, inboxCursor, inst,
  isForwardableRow, isIdLockHeld, isSafeId, isSessionAliveRow, isSiblingPartitionLive,
  livenessSelect, path, primaryCursorPath, readDescriptorFile, readDescriptorPathState,
  readerCursors, registryRowPresent, repoKeyForCwd, sameDescriptorGeneration, store, withIdLock,
  workspacesDir, worktreeIsProvablyGone, writeDescriptorAtomic, writeRetiredRedirect,
} = require('./core.js');
const {
  canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, isLiveSessionId,
  liveSessionElsewhere, pickSurvivor, rawPathMeshId,
} = require('./identity.js');
const {
  floorCursor, logCursorWrite, readSiblingSeenCursor, siblingBaseCursor,
} = require('./cursors.js');

// ---------------------------------------------------------------------------
// MESH ROW COPY — the ONE definition of which fields a copied message row
// carries. There are exactly TWO sites in this file that copy an existing mesh
// row into another partition/store: rehomeAcrossStores (a VERBATIM move into
// another store, via the low-level `store.appendMeshRow`) and
// foldGroupIntoSurvivor (a FORWARD into the survivor partition, via the
// wire-contract `store.appendMeshMessage`). Those two APIs name the SAME data
// DIFFERENTLY (`sender`/`from`, `body`/`message`, `ts`/`timestamp`,
// `mtype`/`type`), so each site used to spell its own object literal out by
// hand — which is precisely how the historical `needsReply`-drop bug class
// recurred: a new message field added to the wire contract was carried at one
// site and silently forgotten at the other, and a dropped flag is invisible
// (the row still copies, it just loses its meaning). One table now defines the
// canonical field set; a new field is added HERE, once, and both shapes get it.
//
// `msg: null` means "this field is deliberately NOT part of the forward shape":
//   - hash        — a FORWARD re-addresses the row (new recipient), so its hash
//                   MUST be recomputed from the new fields (that recomputation
//                   is what makes a re-run OR-IGNORE instead of duplicating).
//                   A verbatim re-home keeps the original hash for exactly the
//                   same dedup reason.
//   - isHeartbeat — a heartbeat can never reach the forward site at all:
//                   isForwardable/isForwardableRow requires mtype==='direct',
//                   which structurally excludes every heartbeat/broadcast row.
//                   Carrying the flag there would imply forwards can be
//                   heartbeats; they cannot. The verbatim re-home DOES carry it
//                   (it moves rows untouched, heartbeat or not).
const MESH_ROW_COPY_FIELDS = [
  // { row: key on a stored row / appendMeshRow, msg: key on appendMeshMessage }
  { row: 'sender', msg: 'from' },
  { row: 'recipient', msg: 'to' },
  { row: 'body', msg: 'message' },
  { row: 'ts', msg: 'timestamp' },
  { row: 'mtype', msg: 'type' },
  { row: 'urgency', msg: 'urgency' },
  { row: 'needsReply', msg: 'needsReply' },
  // origHash (defect 64861a623503) — carried on BOTH shapes. A verbatim re-home
  // must preserve it like every other stored field; a FORWARD of an already-
  // forwarded row must keep pointing at the ROOT original (never at the
  // intermediate copy), which is exactly what copying the source row's own
  // origHash through achieves. A forward of a NON-forwarded row has nothing to
  // copy here (null) and the forward site supplies `origHash: m.hash` via
  // `overrides`, which is applied last.
  { row: 'origHash', msg: 'origHash' },
  // instanceNonce (fl-wave3 fix, item 5): carried on BOTH shapes, same
  // reasoning as origHash directly above — a verbatim re-home must preserve
  // it like every other stored field (both backends persist it: sqlite's
  // `instance_nonce` column, journal's `instanceNonce` field), and a FORWARD
  // of an already-stamped row must keep its provenance rather than silently
  // dropping it. Pre-fix this key was simply ABSENT from this table, so
  // every meshRowCopy call (fold's verbatim move AND its forward) produced a
  // copy with instanceNonce always null/undefined — the instanceNonce
  // CONSUMERS (`inbox read-primary`/`messages`'s `instanceNonceShort`
  // display field, `roster`'s instanceNonceCounts) then saw a folded/
  // forwarded row's provenance vanish even though the ORIGINAL row (still on
  // disk elsewhere, pre-fold) genuinely carried one.
  { row: 'instanceNonce', msg: 'instanceNonce' },
  { row: 'hash', msg: null },
  { row: 'isHeartbeat', msg: null },
];

// meshRowCopy(m, shape, overrides) -> a copy payload for `shape`:
//   'row'     -> appendMeshRow field names (verbatim move; caller supplies workspaceId)
//   'message' -> appendMeshMessage field names (forward; caller supplies the new
//                recipient/type and recomputes the hash)
// `overrides` is applied LAST so a caller can re-address the copy (the forward
// site) without reaching around this helper. Pure — never throws, never reads
// or writes a store.
function meshRowCopy(m, shape, overrides) {
  const src = m || {};
  const out = {};
  for (const f of MESH_ROW_COPY_FIELDS) {
    const key = shape === 'message' ? f.msg : f.row;
    if (!key) continue; // deliberately absent from this shape (see the table's comment)
    // fl-wave4 fix (item 4, Suite failure devswarm-archive-group.test.js:728):
    // this used to unconditionally set `out[key] = src[f.row]` even when
    // `src[f.row]` is `undefined` (a source row with no `instanceNonce`, the
    // common/legacy case) — that EXPLICITLY creates an own property
    // `instanceNonce: undefined` on the copy, which is NOT the same shape as
    // a row that never had the key at all (Object.keys()/JSON.stringify's
    // key-presence differ from an absent key even though both READ back as
    // `undefined`). A verbatim/forward copy of an old, nonce-less row must
    // stay byte-identical to the source's own key set — so a source value of
    // `undefined` is simply never assigned here, matching what the source
    // row itself looks like.
    if (src[f.row] === undefined) continue;
    out[key] = src[f.row];
  }
  return Object.assign(out, overrides || {});
}

// ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT / archiveForwardMaxAgeMs(env) — the age cap
// on forwarding an ARCHIVED orphan's unread into a live family survivor (see
// forwardArchivedOrphanUnread below / healOrphanPartitions' archived branch).
// Resurfacing a month-old, possibly-stale instruction into a live sibling out of
// context is real harm, not tidiness — a message that sat unread since the
// workspace was archived is not "fresh traffic". Overridable per the same
// ANTIHALL_<FEATURE>_<PARAM> env-tunable convention this repo's hooks use
// (e.g. ANTIHALL_API_GUARD_SPAWN_TIMEOUT_MS, ANTIHALL_CODEX_NUDGE_MIN).
const ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT = 30;
function archiveForwardMaxAgeMs(env) {
  const e = env || process.env;
  const raw = e ? e.ANTIHALL_DEVSWARM_ARCHIVE_FORWARD_MAX_AGE_DAYS : undefined;
  const days = parseInt(raw, 10);
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT;
  return effectiveDays * 24 * 60 * 60 * 1000;
}
// archivedForwardProvenancePrefix(id) — the marker prepended to a forwarded
// archived-orphan body so the survivor (and anyone reading its inbox) can tell a
// resurfaced message from fresh traffic, per the same forward envelope
// (MESH_ROW_COPY_FIELDS/meshRowCopy) every other forward site in this file uses —
// no parallel format invented.
function archivedForwardProvenancePrefix(id) { return '[forwarded from archived ' + id + '] '; }
// The READ half of archivedForwardProvenancePrefix — the ONE regex that
// recognises (and can strip) that envelope, so the prefix format is written in
// exactly one place and parsed in exactly one place.
const ARCHIVED_FORWARD_PREFIX_RE = /^\[forwarded from archived ([^\]]+)\] /;

// stripArchivedForwardPrefix(body) -> { archivedId, body }. `archivedId` is null
// (and `body` returned verbatim) for a row that is not an archived forward.
function stripArchivedForwardPrefix(body) {
  if (typeof body !== 'string') return { archivedId: null, body: '' };
  const m = ARCHIVED_FORWARD_PREFIX_RE.exec(body);
  if (!m) return { archivedId: null, body };
  return { archivedId: m[1], body: body.slice(m[0].length) };
}

// forwardedOrigHashOf(row) -> the ORIGINAL row's hash for a forwarded copy, or
// null (defect 64861a623503).
//
// Two tiers, in order:
//   1. `row.origHash` — stamped at forward time by forwardArchivedOrphanUnread
//      from this build on. Authoritative; no reconstruction needed.
//   2. RECONSTRUCTION for a row forwarded by an OLDER build (no origHash
//      column value): every field the original's hash was computed over is
//      still recoverable from the forwarded row itself, because the forward
//      envelope changes exactly two of them and both are invertible —
//      `to` (the new survivor) is replaced by the archived id the provenance
//      prefix names, and `message` gains that prefix, which is stripped back
//      off. `from`/`timestamp`/`urgency`/`needsReply` are carried VERBATIM by
//      MESH_ROW_COPY_FIELDS, and `type` is always 'direct' (isForwardable
//      admits nothing else). So meshMessageHash over those recovered fields
//      reproduces the original's hash byte-for-byte — no store lookup, no
//      persisted backfill, and therefore no migration needed for the ~438
//      archived forwards already sitting in a field Primary's partitions.
//
// Fail-soft: any unexpected shape returns null (no dedup signal), never throws.
function forwardedOrigHashOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.origHash != null && String(row.origHash) !== '') return String(row.origHash);
  const parsed = stripArchivedForwardPrefix(row.body);
  if (!parsed.archivedId) return null;
  try {
    return store.meshMessageHash({
      from: row.sender,
      to: parsed.archivedId,
      type: 'direct',
      urgency: row.urgency,
      message: parsed.body,
      timestamp: row.ts,
      needsReply: row.needsReply,
    });
  } catch (_) { return null; }
}

// logicalDeliveryKey(row) -> a SECONDARY, weaker identity: (from, ts,
// prefix-stripped body). The exact-hash tier above is the primary and only
// cursor-affecting one; this key exists solely to suppress the OTHER shape the
// field report measured — 75 EXACT RESENDS that are not archived forwards at
// all and therefore share neither `hash` nor `origHash` with the copy the
// reader already handled.
//
// DELIVERY-TIME SUPPRESSION ONLY. This key is deliberately weaker than a hash
// (two genuinely distinct messages sent by the same sender at the same
// millisecond with identical text would collide), so a match must NEVER advance
// a cursor past the row — see foldSiblingGapRows, where a logically-suppressed
// row is withheld exactly like a gap row: not delivered, and NOT consumed, so
// the row stays permanently reachable by reading its partition directly.
function logicalDeliveryKey(row) {
  if (!row || typeof row !== 'object') return null;
  const from = row.sender != null ? String(row.sender) : '';
  const ts = row.ts != null ? String(row.ts) : '';
  const body = stripArchivedForwardPrefix(row.body).body;
  if (from === '' && ts === '' && body === '') return null;
  return from + ' ' + ts + ' ' + body;
}

// CONSUMED_HASH_SEED_CAP — how many of the caller's OWN already-consumed rows
// (the newest ones, immediately below its cursor) are scanned to seed the dedup
// sets. Bounded because a long-lived Primary's partition is append-only and
// never pruned: seeding from the FULL history would make every read O(history).
// 2000 is far past any plausible in-flight forward wave (the field incident's
// was 608 rows) while staying a trivially cheap slice of an already-materialised
// listMessages array.
const CONSUMED_HASH_SEED_CAP = 2000;

// consumedDedupSeed(s, id, cursor, cap) -> { hashes:Set, logical:Set }.
//
// ROOT CAUSE this closes (defect 64861a623503): `seenHashes` used to be seeded
// ONLY from the caller's CURRENT UNREAD rows, so a forwarded copy could only
// ever be matched against a message still sitting unread. The field case is the
// opposite one — the Primary had ALREADY CONSUMED all 438 originals, so there
// was nothing left in `unread` to match against and every forward was delivered
// as new. Seeding from CONSUMED history (rows below the cursor) is what makes
// "I have already handled this" expressible at all.
//
// Cheapest available consumed-hash source: the caller's OWN partition rows below
// its own cursor, from the SAME `listMessages` read path everything else uses,
// bounded to the newest `cap` of them. No new index, no new persisted state.
// Fail-soft: an unreadable store yields empty sets (dedup simply does not fire).
function consumedDedupSeed(s, id, cursor, cap) {
  const out = { hashes: new Set(), logical: new Set() };
  const c = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  if (c <= 0) return out;
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : CONSUMED_HASH_SEED_CAP;
  let rows = [];
  try { rows = s.listMessages(id) || []; } catch (_) { return out; }
  const end = Math.min(c, rows.length);
  for (let i = Math.max(0, end - limit); i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.hash) out.hashes.add(String(row.hash));
    const oh = forwardedOrigHashOf(row);
    if (oh) out.hashes.add(oh);
    const lk = logicalDeliveryKey(row);
    if (lk) out.logical.add(lk);
  }
  return out;
}

// forwardArchivedOrphanUnread(s, id, survivorId, opts) — forward-only (NEVER
// adopts/upserts a registry row for `id`) copy of an archived orphan's unread
// DIRECTS into `survivorId`, using the SAME meshRowCopy/MESH_ROW_COPY_FIELDS
// envelope + isForwardable filter + recomputed-hash dedup every other forward site
// in this file uses (foldGroupIntoSurvivor's foldOne). Two additions specific to
// an ARCHIVED source, both from FIX B's decided policy:
//   - each forwarded body is prefixed with archivedForwardProvenancePrefix so the
//     resurfaced message is never mistaken for fresh traffic.
//   - any unread row older than opts.maxAgeMs is skipped entirely (counted in
//     `stale`, never forwarded, never dedup-hashed) — resurfacing month-old
//     instructions into a live sibling out of context is real harm.
// Pure per-id op: never touches the registry, never tombstones, never advances a
// cursor (cursor reconciliation is the caller's separate MIN-only step). Returns
// { forwarded, stale }.
function forwardArchivedOrphanUnread(s, id, survivorId, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAgeMs = Number.isFinite(o.maxAgeMs) && o.maxAgeMs > 0 ? o.maxAgeMs : archiveForwardMaxAgeMs();
  let forwarded = 0;
  let stale = 0;
  let since = 0;
  since = floorCursor(s, id, o.home);
  let rows = [];
  try { rows = s.listMessages(id, { sinceCursor: since }); } catch (_) { rows = []; }
  const batch = [];
  for (const m of rows) {
    if (!isForwardable(m)) continue;
    const ts = Number(m.ts);
    if (Number.isFinite(ts) && (now - ts) > maxAgeMs) { stale++; continue; }
    const fields = meshRowCopy(m, 'message', {
      to: survivorId, type: 'direct', urgency: m.urgency || 'normal',
      message: archivedForwardProvenancePrefix(id) + (m.body != null ? m.body : ''),
      // EXACT CROSS-PARTITION DEDUP (defect 64861a623503). The forward
      // RE-ADDRESSES the row, so its own hash necessarily differs from the
      // original's and no reader could ever match the copy against a message it
      // already consumed — the field failure that re-delivered 438 archived
      // forwards to a Primary that had handled every one of them. Stamp the
      // ORIGINAL's identity onto the copy so `foldSiblingGapRows` can suppress
      // it. `m.origHash || m.hash`: a chain of forwards keeps pointing at the
      // ROOT original, never at the intermediate copy.
      origHash: (m.origHash != null ? m.origHash : m.hash) || null,
    });
    batch.push(Object.assign({}, fields, { hash: store.meshMessageHash(fields) }));
  }
  // Cross-partition: through the one locked+rechecked door. busy/gone -> nothing
  // forwarded; `status` tells the caller to leave the source row and report PENDING.
  let status = 'ok';
  if (batch.length) {
    const res = appendIntoPartition(s, o.home, survivorId, batch, { allowArchivedDest: !!o.allowArchivedDest });
    status = res.status;
    forwarded = res.inserted || 0;
  }
  return { forwarded, stale, status };
}

// ---------------------------------------------------------------------------
// STORE RE-HOME (P1-1 / P1-2). A descriptor registered while repoKey was
// transiently null lands its registry row + any messages in the LEGACY hash
// bucket store/<hashFromWorkspaceId(id)>/ — a bucket the Primary's real read
// verbs (`inbox messages`/`read-primary`, keyed off repoKey) never open, so a
// "healed" send into it is a SILENT BLACK HOLE, and once ownerKey=hash is
// persisted the ensure path REJECTS ("does not belong to the current project")
// and locks the workspace out of its own inbox. rehomeCore MIGRATES the registry
// row + pending messages + read cursor from the hash bucket into the resolved
// store/<repoKey>/ and rewrites ownerKey=repoKey. ATOMIC + FAIL-OPEN +
// NO-DELETE-until-copy-verified: it copies/upserts into the repoKey store,
// VERIFIES every source hash + the registry row landed, and ONLY THEN tombstones
// the hash-bucket registry row (the message rows are append-only and never
// deleted — OR-IGNORE dedup makes a re-run idempotent). MUST be called with the
// per-id lock held (call sites wrap it). Never throws.
//
// Broadcasts/heartbeats live in the SHARED BROADCAST_PARTITION_ID (not per-id)
// and are deliberately NOT re-homed here — only the per-id direct backlog +
// registry row (the addressed traffic the black hole affected) moves.
// rehomeAcrossStores(home, id, fromKey, toKey, ctx) — the GENERALIZED move
// primitive rehomeCore (below) and the Claim 3 self-heal helpers both share:
// migrate id's registry row + pending direct backlog + read cursor from
// store/<fromKey>/ into store/<toKey>/. Same contract as the original
// rehomeCore body: ATOMIC-per-step, FAIL-OPEN, NO-DELETE-until-copy-verified
// (a message row is NEVER deleted — append-only, OR-IGNORE dedup makes a
// re-run idempotent; the SOURCE's registry row is tombstoned ONLY after the
// destination copy is verified present, and only when it actually came FROM
// the source store rather than being seeded from a descriptor-only
// fallback). MUST be called with the per-id lock held (call sites wrap it).
// Never throws.
function rehomeAcrossStores(home, id, fromKey, toKey, ctx) {
  const out = { rehomed: false, movedMessages: 0, movedRegistry: false };
  if (!fromKey || !toKey || fromKey === toKey) return out; // already colocated / nothing to move
  // The WHOLE snapshot -> copy -> verify -> tombstone runs under withIdLock(id)
  // (every writer into id's partition takes the same lock: appendIntoPartition,
  // send, register). Held by the caller (verified) -> in place; else taken here.
  if (!isIdLockHeld(id, home)) {
    const r = withIdLock(String(id), home, () => rehomeAcrossStores(home, id, fromKey, toKey, ctx));
    return (r && r.lockBusy) ? Object.assign(out, { reason: 'lock-busy' }) : r;
  }
  let fromStore = null;
  let toStore = null;
  try {
    // The source bucket may not exist (descriptor-only split-brain) — openStore
    // materializes it, but only when we have already decided a re-home is
    // warranted, so this is not a spurious create. Guard the whole body
    // fail-open regardless.
    fromStore = store.openStore({ home, workspaceId: id, hash: fromKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    toStore = store.openStore({ home, workspaceId: id, hash: toKey, backend: ctx && ctx.backend, env: ctx && ctx.env });

    // 1) Registry row: prefer the source-store row; fall back to the on-disk
    //    descriptor when the store row is absent (descriptor-only split-brain).
    let regRow = null;
    try { regRow = (fromStore.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null; } catch (_) { regRow = null; }
    let regFromSource = !!regRow;
    if (!regRow) {
      const d = readDescriptorFile(home, id);
      if (d && String(d.id) === String(id)) regRow = d;
    }
    // Nothing stranded in the source store AND no descriptor to seed a row
    // from: this is NOT a split-brain — do NOT upsert a stub into the
    // destination store (that would CLOBBER a legitimately-registered row). No-op.
    if (!regRow) return out;
    // The copy base (step 2) is read STRICTLY, before anything is written: an
    // unreadable reader_cursors table makes the floor UNKNOWN, and any guessed
    // base could copy too little and then tombstone the source (loss). Abort —
    // nothing moved, the source stays authoritative, a later attempt retries.
    let fromCursor;
    try { fromCursor = readerCursors.floorOf(fromStore, id, 'store', { home }); }
    catch (_) { out.reason = 'reader-cursors-unreadable'; return out; }
    // The source tail is read COMPLETELY before any destination write, for the
    // same reason: a read error (the journal reads it as []) or a torn row would
    // make the verify below pass on an incomplete copy and then tombstone the
    // source. A torn line cannot be attributed to a partition, so any torn line
    // in the source messages file aborts (the source stays authoritative).
    let msgs;
    try { msgs = fromStore.listMessages(id, { sinceCursor: fromCursor }) || []; }
    catch (_) { out.reason = 'source-messages-unreadable'; return out; }
    try {
      const errs = typeof fromStore.getReadErrors === 'function' ? fromStore.getReadErrors() : [];
      if ((errs || []).some((e) => e && /messages\.ndjson$/.test(String(e.path || '')))) { out.reason = 'source-messages-unreadable'; return out; }
      if (typeof fromStore.tornLineCount === 'function' && fromStore.tornLineCount('messages') > 0) { out.reason = 'source-messages-torn'; return out; }
    } catch (_) { out.reason = 'source-messages-unreadable'; return out; }
    const rehomedReg = Object.assign({}, regRow);
    rehomedReg.id = id;
    rehomedReg.ownerKey = toKey;
    if (descriptorFreshRepoKey(rehomedReg) === toKey) rehomedReg.repoKey = toKey;
    toStore.upsertRegistry(rehomedReg);

    // 2) Pending direct backlog for THIS partition (id) — ONLY the source's
    //    UNREAD tail (sinceCursor: fromCursor), never its already-read history.
    //    appendMeshRow OR-IGNOREs on hash, so a re-run never duplicates.
    //
    //    MESSAGE-LOSS FIX (P0): a read cursor is a POSITIONAL index into ONE
    //    specific ordered list — it is meaningless once copied onto a
    //    DIFFERENT list. Concrete repro this closes: destination already has
    //    an unread [X] at cursor 0; source has [A,B] at cursor 1 (A read, B
    //    unread). Copying source's FULL history (both A and B) after X
    //    produces [X,A,B], and merging cursors via max(0,1)=1 marks position 1
    //    (X) as already-read — X was NEVER delivered to the reader. There is
    //    no cursor value over the merged list that can correctly mark "A read,
    //    X and B unread" when X sorts before A. The only safe fix: copy just
    //    the source's UNREAD tail (so every appended row is genuinely unread)
    //    and leave the destination's OWN cursor completely untouched — its
    //    pre-existing rows keep exactly the read/unread status they already
    //    had, and the newly-appended rows are correctly unread too.
    // VERBATIM move: every field comes from the ONE shared MESH_ROW_COPY_FIELDS
    // table (see meshRowCopy) so this site can never again drift from the
    // forward site in foldGroupIntoSurvivor. Only the destination partition is
    // an override — the row keeps its original hash (dedup) and its heartbeat flag.
    // Through the one door (lock already held here; recheck: id was just upserted).
    if (msgs.length) {
      const put = appendIntoPartition(toStore, home, id, msgs.map((m) => meshRowCopy(m, 'row', { workspaceId: id })), { via: 'row' });
      if (put.status !== 'ok') { out.reason = 'destination-' + put.status; return out; }
    }

    // 3) VERIFY the copy landed BEFORE removing anything (no-delete-until-verified).
    const destHashes = new Set((toStore.listMessages(id, { sinceCursor: 0 }) || []).map((r) => r.hash).filter((h) => h != null));
    const allMsgsPresent = msgs.every((m) => m.hash == null || destHashes.has(m.hash));
    // F-D (v0.61.2): a row for `id` reading present is NOT proof the upsert above
    // actually applied — the F2 id-collision guard (upsertRegistry) silently skips
    // when a DIFFERENT non-null worktree_path already occupies this id, and a stale/
    // conflicting row still satisfies a bare `.some(id===id)` check. Compare the
    // fields the upsert was supposed to write, not just id presence, so a guard-
    // skipped write is caught here BEFORE the source is tombstoned as verified.
    const destRow = (toStore.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
    const regPresent = !!destRow
      && (destRow.worktreePath || null) === (rehomedReg.worktreePath || null)
      && (destRow.sessionId || null) === (rehomedReg.sessionId || null);
    if (!allMsgsPresent || !regPresent) {
      // Verification failed — LEAVE the source store intact (fail-open, zero loss);
      // a later attempt retries. Reader falls back to current resolution meanwhile.
      // F-D: distinguish a genuine CONFLICT (a destination row exists but does not
      // match — the F2 guard skipped the upsert) from a plain not-yet-verified
      // state (no destination row at all) — surface it on `out` + stderr instead
      // of a silent no-op, so the conflict is observable rather than swallowed.
      if (destRow && !regPresent) {
        out.regConflict = true;
        try {
          process.stderr.write('[devswarm] rehomeAcrossStores: id ' + JSON.stringify(String(id))
            + ' — destination already has a CONFLICTING registry row (worktreePath/sessionId'
            + ' mismatch, likely the F2 id-collision guard skipping the upsert); source NOT'
            + ' tombstoned, conflict surfaced.\n');
        } catch (_) {}
      }
      // Rows were already appended to toStore (:684-689) and the registry upserted
      // (:660) BEFORE this verification ran, so returning here without a derive leaves
      // toStore's projection stale — delivered-but-invisible messages, the very failure
      // the verified path guards against at :728-729. fromStore is deliberately NOT
      // derived: nothing has mutated it (its registry row is only tombstoned AFTER
      // verification succeeds). Best-effort + fail-open, mirroring the verified path.
      try { store.deriveSummary(toStore, { home, env: ctx && ctx.env }); } catch (_) {}
      return out;
    }

    // 4) Copy verified — tombstone ONLY the source-store registry row (message
    //    rows stay; append-only, dedup-safe), and only when the row actually came
    //    FROM the source store (a descriptor-only re-home has nothing to tombstone).
    //    Refresh both projections.
    if (regFromSource) { try { fromStore.removeRegistry(id); } catch (_) { /* tombstone best-effort; verified copy already durable */ } }
    try { store.deriveSummary(fromStore, { home, env: ctx && ctx.env }); } catch (_) {}
    try { store.deriveSummary(toStore, { home, env: ctx && ctx.env }); } catch (_) {}

    // 5) Rewrite the descriptor's persisted ownership so ensure stops rejecting.
    const desc = readDescriptorFile(home, id);
    if (desc && String(desc.id) === String(id)) {
      desc.ownerKey = toKey;
      if (descriptorFreshRepoKey(desc) === toKey) desc.repoKey = toKey;
      try { writeDescriptorAtomic(home, id, desc); } catch (_) { /* descriptor rewrite best-effort; store already re-homed */ }
    }
    out.rehomed = true;
    out.movedMessages = msgs.length;
    out.movedRegistry = regFromSource;
    return out;
  } catch (_) {
    return out; // fail-open: a re-home hiccup must never break the caller's verb
  } finally {
    if (fromStore) { try { fromStore.close(); } catch (_) {} }
    if (toStore) { try { toStore.close(); } catch (_) {} }
  }
}

// rehomeCore(home, id, repoKey, ctx) — the pre-existing legacy-hash-bucket ->
// repoKey re-home (P1-1/P1-2). Now a thin wrapper over the generalized
// rehomeAcrossStores: identical external behavior/signature (every existing
// caller/test is unaffected), source is always the legacy per-id hash bucket.
function rehomeCore(home, id, repoKey, ctx) {
  if (!repoKey) return { rehomed: false, movedMessages: 0, movedRegistry: false };
  return rehomeAcrossStores(home, id, store.hashFromWorkspaceId(id), repoKey, ctx);
}

// rehomeMiskeyedRow(home, id, storeRepoKey, ctx) — Claim 3 SELF-HEALING fix.
// The decision for ONE registry row currently living in store/<storeRepoKey>/:
// read its descriptor and compute a FRESH structural repoKey from the
// descriptor's OWN real worktreePath via descriptorFreshRepoKey — deliberately
// NOT descriptorStructuralRepoKey, which prefers a PERSISTED `desc.repoKey`
// field that can go stale relative to the worktree's actual, current git
// identity (e.g. a submodule split: the same worktreePath's git-common-dir
// changes without the descriptor's persisted ownerKey/repoKey being updated
// to match) — descriptorFreshRepoKey always re-derives from the live path, so
// this is the ONE independently-verifiable fact about "which project does
// this id's real worktree belong to today", ORTHOGONAL to whatever a stale
// registry worktree_path snapshot (what a reconcile-spawned subprocess's cwd
// is set from, defaultSpawnReconcile) or a stale persisted field might claim.
//
//   - freshRepoKey === storeRepoKey: the row IS correctly homed in the store
//     it is already sitting in — a prior false-negative here was purely a
//     stale-metadata artifact. Heal any stale persisted ownerKey/repoKey field
//     on the descriptor IN PLACE (no store move) so a later `ensure`
//     ownership check (cmdRegister) never mismatches on this id again.
//   - freshRepoKey resolves to a DIFFERENT, valid repoKey: the row is
//     genuinely mis-keyed — physically living in the WRONG store. REHOME it
//     via rehomeAcrossStores (message-preserving, merge-safe, no delete).
//   - freshRepoKey does not resolve at all (non-git cwd / vanished
//     worktree): leave the row exactly as-is — there is no independently
//     verifiable ground truth to correct it against.
//
// Runs under the per-id lock (serializes against a concurrent register/
// heartbeat/rehome for the same id) and is FAIL-OPEN throughout: any error
// leaves the row untouched; this function never throws, so a heal attempt
// can never break the caller (reconcile/doctor/update) it runs inside of.
// Idempotent: re-running against an already-healed/already-correct row is a
// no-op both times.
function rehomeMiskeyedRow(home, id, storeRepoKey, ctx) {
  const fallback = { id, rehomed: false, healedDescriptor: false, reason: null };
  if (!storeRepoKey || !id || !isSafeId(String(id))) return Object.assign({}, fallback, { reason: 'unsafe-or-missing-key' });
  try {
    return withIdLock(String(id), home, () => {
      const out = { id, rehomed: false, healedDescriptor: false, reason: null };
      const desc = readDescriptorFile(home, id);
      if (!desc || String(desc.id) !== String(id) || !desc.worktreePath) {
        out.reason = 'no-descriptor';
        return out;
      }
      // IDENTITY GUARD (P0 fix): the descriptor file is keyed by `id` ALONE and
      // can have been overwritten by a LATER, unrelated registration that reused
      // the same id (id collision / a stale row never cleaned up) — its
      // worktreePath/sessionId then belong to a DIFFERENT live session than the
      // row physically sitting in storeRepoKey today. Trusting that descriptor
      // as ground truth would rehome the OLD row's real content (its own
      // sessionId, its own messages) into the NEW session's store under the
      // shared id — a foreign-descriptor takeover of a legitimate row. Positively
      // confirm the row currently in storeRepoKey is still the SAME entity the
      // descriptor describes before acting on it: proceed ONLY when both sides
      // carry a live (non-null, non-empty) sessionId AND they positively agree
      // — the one case independently verifiable as "same entity, stale
      // metadata". A null/empty sessionId on EITHER side is never a wildcard
      // match (P1 fix): e.g. curRow {sessionId:null} vs a foreign desc
      // {sessionId:'foreign-session'} must never fall through as "unconfirmed,
      // proceed" — that would silently accept a genuinely foreign descriptor
      // and steal/misroute the row's real content. Anything short of a
      // confirmed positive match — either side null/empty, or a straight
      // mismatch — refuses (fail-open, no-op) rather than move/overwrite.
      //
      // D11-A SCOPE NOTE: isLiveSessionId here is DELIBERATELY the bare shape
      // test, NOT migrated to isRoutingLiveRow/isSiblingPartitionLive like
      // resolveMeshTarget/pickSurvivor/groupRegistryByMeshId's liveRows (see
      // the header above SYNTHETIC_SESSION_PREFIX). Two independent reasons:
      // (1) this is an IDENTITY-MATCH question (is curRow the SAME entity
      // desc describes), not a drain/routing decision — a session that is
      // real but has since gone dormant is still the SAME entity, and gating
      // this comparison on current liveness would refuse a legitimate heal
      // for a merely-idle (not dead) workspace. (2) the descriptor-existence
      // fallback isRoutingLiveRow needs for a just-registered row is
      // structurally meaningless here: `desc` was ITSELF obtained via
      // readDescriptorFile a few lines above, so that fallback would read
      // true unconditionally and silently defeat the whole confirmedMatch
      // gate — exactly the foreign-descriptor-takeover this guard exists to
      // refuse.
      let curRow = null;
      try {
        const cs = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
        try { curRow = (cs.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null; }
        finally { try { cs.close(); } catch (_) {} }
      } catch (_) { curRow = null; }
      if (curRow) {
        const curSid = isLiveSessionId(curRow.sessionId) ? String(curRow.sessionId) : null;
        const descSid = isLiveSessionId(desc.sessionId) ? String(desc.sessionId) : null;
        const confirmedMatch = curSid !== null && descSid !== null && curSid === descSid;
        if (!confirmedMatch) {
          out.reason = 'descriptor-identity-mismatch';
          return out;
        }
      }
      const freshRepoKey = descriptorFreshRepoKey(desc);
      if (!freshRepoKey) { out.reason = 'unresolvable'; return out; }
      if (freshRepoKey === storeRepoKey) {
        const storedOwnerKey = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
        const storedRepoKey = typeof desc.repoKey === 'string' && desc.repoKey ? desc.repoKey : null;
        if (storedOwnerKey !== storeRepoKey || storedRepoKey !== storeRepoKey) {
          const healedDesc = Object.assign({}, desc, { ownerKey: storeRepoKey, repoKey: storeRepoKey });
          try { writeDescriptorAtomic(home, id, healedDesc); out.healedDescriptor = true; }
          catch (_) { out.reason = 'descriptor-write-failed'; }
        }
        // ALSO heal a stale REGISTRY worktree_path: the row physically sitting
        // in THIS store must reflect the descriptor's real, current
        // worktreePath — otherwise a reconcile-spawned subprocess's cwd (set
        // from the registry row, defaultSpawnReconcile) keeps using the stale
        // path forever, re-triggering the exact false-negative this heal
        // exists to prevent, on every single reconcile run. We have already
        // independently verified (via the descriptor, the per-id authoritative
        // record) that `id` genuinely belongs here — the SAME "known,
        // intentional same-id path change, not a hash collision" posture
        // rekeySubdirRegistryRows already uses `allowPathChange:true` for.
        let s = null;
        try {
          s = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
          const row = (s.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
          if (row && row.worktreePath !== desc.worktreePath) {
            const fixedRow = Object.assign({}, row, { worktreePath: desc.worktreePath });
            const written = s.upsertRegistry(fixedRow, { allowPathChange: true });
            if (written) {
              out.healedRegistryPath = true;
              try { store.deriveSummary(s, { home, env: ctx && ctx.env }); } catch (_) {}
            }
          }
        } catch (_) { /* best-effort: descriptor healing above already landed */ }
        finally { if (s) { try { s.close(); } catch (_) {} } }
        return out;
      }
      // Genuinely mis-keyed: physically living in storeRepoKey's store, but the
      // descriptor's own real worktreePath structurally belongs to
      // freshRepoKey instead.
      //
      // FIRST-PASS DETERMINISM (P0 self-heal reliability). The row physically in
      // storeRepoKey may carry a STALE worktree_path SNAPSHOT — an older path the
      // registry captured before the worktree moved / was re-derived — while the
      // descriptor (the per-id authoritative record we JUST identity-confirmed
      // via the sessionId positive match above) carries the real, CURRENT
      // worktreePath. rehomeAcrossStores rebuilds the destination row FROM the
      // source registry row, so it would carry that stale path forward. When a
      // CANONICAL copy already sits in freshRepoKey's store holding the current
      // path, the destination's F2 id-collision guard then refuses the upsert
      // (stale != current, non-null) and the whole re-home fails its regPresent
      // verification — surfaced as regConflict today, and as the literal
      // reason:'rehome-not-applied' in the pre-F-D code (the shape observed live:
      // a legacy bare-hash stray with the canonical copy already in the named
      // store, rehoming only AFTER an unrelated metadata upsert happened to
      // rewrite the stale path). The redundant stray is otherwise LEFT stranded
      // on EVERY heal pass, converging only by external side-effect — not the
      // deterministic single automatic pass self-heal promises.
      //
      // Normalize the source row's worktree_path to the descriptor's verified
      // current path FIRST (allowPathChange:true — the SAME "known, intentional
      // same-id path change, not a hash collision" opt-in the freshRepoKey ===
      // storeRepoKey branch above already uses, justified identically: the
      // descriptor has independently confirmed this id's entity belongs here),
      // so rehomeAcrossStores builds the destination row with the current path,
      // matches the canonical copy, and converges in THIS single pass. No-delete
      // (only an in-place path refresh on a row about to be tombstoned anyway),
      // idempotent (a row already carrying the current path is untouched), and
      // fail-open (any error just falls through to the pre-fix behavior).
      try {
        const ns = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
        try {
          const srow = (ns.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
          if (srow && srow.worktreePath !== desc.worktreePath) {
            ns.upsertRegistry(Object.assign({}, srow, { worktreePath: desc.worktreePath }), { allowPathChange: true });
          }
        } finally { try { ns.close(); } catch (_) {} }
      } catch (_) { /* best-effort: rehomeAcrossStores still runs; a stale path only risks the pre-fix regConflict */ }
      const r = rehomeAcrossStores(home, id, storeRepoKey, freshRepoKey, ctx);
      out.rehomed = !!r.rehomed;
      out.movedMessages = r.movedMessages || 0;
      out.movedRegistry = !!r.movedRegistry;
      if (r.regConflict) out.regConflict = true;
      if (!r.rehomed && !r.regConflict) out.reason = 'rehome-not-applied';
      return out;
    });
  } catch (_) {
    return Object.assign({}, fallback, { reason: 'heal-error' }); // fail-open: a heal hiccup must never break the caller
  }
}

// healRegistry(home, repoKey, ctx) — Claim 3 (d): the ONE exported sweep
// `doctor`, `update.js`'s repair pass, and `cmdReconcile`'s own self-heal
// pre-pass all share: runs rehomeMiskeyedRow over EVERY row currently in
// store/<repoKey>/'s registry. FAIL-OPEN per row (one row's error never
// aborts the sweep) and idempotent (a second run over an already-healed
// registry heals/rehomes nothing further — every row that needed correcting
// on the first pass already agrees with a fresh recompute on the second).
function healRegistry(home, repoKey, ctx) {
  const out = { repoKey, checked: 0, healed: 0, rehomed: 0, skipped: 0, rows: [] };
  if (!repoKey) return out;
  let rows = [];
  try {
    const s = store.openStore({ home, hash: repoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    try { rows = s.listRegistry() || []; } finally { s.close(); }
  } catch (_) { rows = []; }
  for (const row of rows) {
    if (!row || row.id == null || !isSafeId(String(row.id))) { out.skipped++; continue; }
    // Defect-2(b) fix: same detect-and-skip as rehomeStrandedProjectDescriptors
    // above — a registry row whose worktree is gone on disk AND already has an
    // archived/ counterpart for its id is not a live target for the heal pass.
    // Detect-only, never deletes/unlinks the row or the archived counterpart.
    if (row.worktreePath) {
      let worktreeExists = true;
      try { worktreeExists = fs.existsSync(row.worktreePath); } catch (_) { worktreeExists = true; }
      // deliberate: under-detect only (skip a report, never a removal decision) — bare marker check is fine here.
      if (!worktreeExists && hasArchivedCounterpart(home, String(row.id))) { out.skipped++; continue; }
    }
    out.checked++;
    let r;
    try { r = rehomeMiskeyedRow(home, String(row.id), repoKey, ctx); }
    catch (_) { r = { id: row.id, rehomed: false, healedDescriptor: false, reason: 'heal-error' }; }
    if (r.rehomed) out.rehomed++;
    else if (r.healedDescriptor || r.healedRegistryPath) out.healed++;
    else out.skipped++;
    out.rows.push(r);
  }
  return out;
}

// maybeRehomeToCwdProject(home, id, ctx) — the descriptor-signalled trigger: if
// the CURRENT cwd resolves a repoKey AND the on-disk descriptor's persisted
// ownerKey equals the legacy hash bucket key (the split-brain marker), re-home
// under the per-id lock. Returns the rehomeCore result, or null when no re-home
// applies. Shared by the ensure/read paths.
function maybeRehomeToCwdProject(home, id, ctx) {
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) return null;
  const hashKey = store.hashFromWorkspaceId(id);
  if (!hashKey || hashKey === repoKey) return null;
  const desc = readDescriptorFile(home, id);
  const storedOwnerKey = desc && typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
  if (storedOwnerKey !== hashKey) return null; // not stranded in the hash bucket
  // FOREIGN-STRAND GUARD (defect e586afdaa968, P0). "Stranded in the hash
  // bucket" says WHERE the rows physically live; it says NOTHING about WHICH
  // project the workspace belongs to. A workspace whose worktree genuinely
  // lives in project B, registered from a non-git cwd (so ownerKey === the
  // hash bucket), was re-homed into whatever project the CALLER happened to be
  // standing in — physically copying B's registry row + messages into A and
  // rewriting the descriptor's ownerKey to A. Every caller of this function
  // (read, gate, and — via their own inline rehomeCore blocks — ensure and
  // archive) then had another project's data moved under it, INCLUDING the
  // calls that went on to refuse with ok:false. The heal is only ever correct
  // toward the workspace's OWN registered project, so: when the id's registered
  // key positively resolves and disagrees with this cwd, do nothing.
  // Fail-open unchanged: a workspace that names no project at all (the legacy
  // no-project mode — registeredRepoKey returns null for exactly the hash
  // bucket it is stranded in) still heals here, as before.
  const registeredKey = descriptorRegisteredRepoKey(desc, id);
  if (registeredKey && registeredKey !== repoKey) return null;
  const r = withIdLock(id, home, () => rehomeCore(home, id, repoKey, ctx));
  // withIdLock now fails closed (G1): a lock-busy return is NOT a re-home result
  // — normalize to null so callers' `rh && rh.rehomed` guard reads it as "no
  // re-home this call" (the read/send/gate path fail-opens and retries later).
  return (r && r.lockBusy) ? null : r;
}

// isForwardable(msg) — retire-forward NOISE FILTER (#67). retireWorktreeDuplicates
// re-appends a duplicate partition's unread backlog into the survivor as fresh
// directs; forward ONLY a REAL actionable direct. Native ingest
// (devswarm-ingest.js / devswarm-pull.js) writes body+hash ONLY, so a stale
// `[Primary poke]` mirror or a `{_h:"native:..."}` hash-mirror row reads back as
// mtype:null / sender:null — forwarding those resurrects dead pokes into the live
// partition (proven harmful on a real store). A forwardable row must be a real
// mesh direct: mtype==='direct' (one check that excludes broadcast, heartbeat, AND
// every null-mtype native/poke/hash-mirror row) with a non-empty sender AND
// recipient. A legitimately-forwarded direct (appendMeshMessage sets all three)
// still passes, so real traffic is never over-filtered. This structural rule
// now lives in companion/lib/devswarm-noise.js (isForwardableRow) purely so
// it can be extracted and re-tested in one place — it is otherwise VERBATIM
// unchanged from the original #67 check and is deliberately NOT body-text
// filtered (see that module's own comment). devswarm-parent-gate.js's
// realUnread count applies the SEPARATE POKE_PREFIX text check (isNoiseText)
// to a DIFFERENT row shape (descriptor durable-inbox NDJSON, no
// mtype/sender/recipient at all, so it has no structural signal to use
// instead) — the two checks share only the POKE_PREFIX constant, not this
// structural rule.
function isForwardable(msg) {
  return isForwardableRow(msg);
}

// foldSiblingGapRows(rows, seenHashes) — Fix Wave 2 F1/F3 (P0 message-loss fix
// + surface-parity fix): shared gap-withholding fold used by BOTH mesh-sibling
// read paths (cmdInboxMessages's read-primary/peek-primary/--ack, and `inbox
// count/read/ack`'s own sibling loop) so they can no longer silently diverge
// (that divergence was F3/F2's root cause).
//
// ROOT CAUSE this replaces (F1, defect confirmed live): the prior fold set
// `gapSeen` on a non-forwardable/null row but still PUSHED that row into
// `deliveredRows`, so withholding was NON-SUFFIX — a withheld forwardable row
// could sit BETWEEN two delivered rows (e.g. [native N0, direct F1, native
// N2] delivered [N0, N2], withholding only F1). The sibling ack target is
// POSITIONAL (`part.cursor + deliveredCount`), which is only valid over a
// CONTIGUOUS PREFIX of the partition's natural (cursor) order. `ack` on that
// window advanced the cursor by 2 (past N0 AND the withheld F1), destroying
// F1 permanently — proven live, absent at HEAD.
//
// FIX (option (b), chosen over capping ackTarget at the first-gap index):
// restore the documented invariant VERBATIM — once a gap is seen, EVERY
// subsequent row is withheld, including non-forwardable ones. This makes
// `deliveredRows` a genuine index-based PREFIX of `rows` (the row that
// TRIGGERS the gap is itself still delivered — "never excluded" — but
// nothing after it is), so `deliveredCount` is always safe to add to
// `part.cursor` for the ack target. A partition with no non-forwardable row
// in its window has no gap at all, so nothing is withheld (P0 case
// unaffected, re-asserted as a guard test).
//
// F5 fix folded in here too: a null row (store corruption) is skipped
// entirely (never pushed as a literal `null`) but still poisons the window
// like any other non-forwardable row, since its safety cannot be determined.
// Fix Wave 3 G1/G2 (P0/P1): `deliveredCount` (== `deliveredRows.length`) used
// to ALSO be the number the ack loops (~line 4064/4209, ~line 4580/4803) add
// to `part.cursor` for the ack target. That conflated two DIFFERENT things:
// (1) how many rows the CALLER actually got back (the payload), and (2) how
// many PHYSICAL rows of `rows` were resolved and can safely be skipped past
// on the next read. They agree only when every resolved row is also a
// delivered row (the common case) — they diverge whenever a row is resolved
// WITHOUT being delivered:
//   G1 (P0, corrupted/null row): `if (!row)` skips a hole entirely — never
//   pushed, so it never counted toward `deliveredCount`. The ack target
//   `part.cursor + deliveredCount` then NEVER advances past that row, so
//   EVERY future read starts the window at the same hole again — permanent,
//   operator-unrecoverable wedge (no read/ack sequence can ever progress),
//   with `count` silently reporting `unreadTotal: 0` on top of it (nothing
//   in the window counted as delivered either).
//   G2 (P1, exact-hash duplicate): `if (row.hash && seenHashes.has(...))`
//   skips a dedup match — also never pushed. `deliveredRows` then stops
//   being a genuine PHYSICAL index-prefix of `rows` (it can be shorter than
//   the number of physical rows actually consumed to produce it), so an ack
//   loop that advances a sibling's cursor by `deliveredCount` UNDER-covers
//   the physical rows behind it and can redeliver a row already returned.
//
// FIX: track `consumedCount`/`consumedThrough` SEPARATELY from
// `deliveredRows`/`deliveredCount`. `consumedCount` is the number of
// PHYSICAL rows from the front of `rows` that have been resolved one way or
// another (delivered, exact-hash-deduped, OR corrupted/null) while still
// inside the ackable prefix (i.e. before `gapSeen` was true at the START of
// processing that row) — this is what an ack target must add to
// `part.cursor`, never `deliveredCount`. `consumedThrough[i]` records
// `consumedCount` at the moment `deliveredRows[i]` was pushed, so a caller
// that only delivers/keeps the first K of `deliveredRows` (the P2-D read cap)
// can still derive the CORRECT physical ack target for that partial delivery
// (`consumedThrough[K - 1]`, or 0 when K is 0) rather than assuming K
// physical rows were consumed to produce K delivered rows.
//
// A corrupted/null row is therefore consumed (the ack cursor moves past it —
// there both was never a real message there, and it is unrecoverable either
// way) but still poisons the REST of THIS read's window exactly as before
// (nothing after it in this call is delivered or consumed) — the wedge is
// broken because the poisoned row itself is gone from the NEXT read's
// window, so whatever follows it becomes the new (clean) window head and
// gets a normal chance to deliver. `deliveredRows`/`deliveredCount`/
// `gapWithheldCount` are computed IDENTICALLY to before this fix — this is a
// strictly additive change, byte-compatible with every existing caller that
// only reads those three fields.
// EXACT CROSS-PARTITION DEDUP (defect 64861a623503, additive to everything
// above). Two changes, and a THIRD parameter that is optional so every existing
// caller and test keeps byte-identical behaviour:
//
//   (a) `seenHashes` is now matched against a row's `origHash` as well as its
//       own `hash` — a forwarded copy carries the ORIGINAL's hash there (or has
//       it reconstructed, see forwardedOrigHashOf), so a copy of an original the
//       caller ALREADY CONSUMED is recognised as the exact same logical message.
//       It is treated exactly like the pre-existing exact-hash duplicate: not
//       delivered, but CONSUMED (the cursor may pass it), because a hash match
//       is proof of identity.
//
//   (b) `seenLogical` (optional Set) adds the WEAKER (from, ts, stripped-body)
//       key for the exact-resend shape that shares no hash at all.
//
//       ROUND 13 R1 RULING — a weak-key match now CONSUMES (it did not).
//       The original form suppressed WITHOUT consuming: the row was neither
//       delivered nor counted toward `consumedCount`, AND it set `gapSeen`.
//       That POISONS THE WINDOW permanently — the ack target derived from
//       `consumedCount` stops BEFORE the row, so the very next read starts on
//       the same suppressed row again, sets `gapSeen` again, and withholds
//       everything behind it forever. The "reachable by reading its partition
//       directly" escape hatch does not save the window: the partition's own
//       cursor can never move past it either. That is the same operator-
//       unrecoverable wedge G1 fixed for corrupted rows, reintroduced for
//       weak-key matches.
//
//       A weak-key match is now treated like the exact-hash duplicate above:
//       NOT delivered (the caller already has a logically identical row from
//       this same fold) but CONSUMED, so the cursor passes it and the window
//       makes progress. `gapSeen` is NOT set — a consumed row ends nothing.
//       The residual risk this accepts is the mirror of the old one: a
//       genuinely-new row that collides on the weak key is skipped rather than
//       withheld. `logicalDeliveryKey` is (from, ts-to-the-millisecond,
//       stripped body) — a collision means the same sender emitted a
//       byte-identical body in the same millisecond, which is a resend, not a
//       distinct message. Each suppression emits ONE NDJSON diagnostic line
//       ({reason:'logical-dup', from, ts}) so the trade is observable in the
//       field rather than silent. `logicalSuppressedCount` is unchanged in
//       meaning and still reported.
function foldSiblingGapRows(rows, seenHashes, seenLogical) {
  const deliveredRows = [];
  const consumedThrough = [];
  let gapSeen = false;
  let gapWithheldCount = 0;
  let consumedCount = 0;
  let logicalSuppressedCount = 0;
  for (const row of rows) {
    const wasGapSeen = gapSeen; // gapSeen state at the START of this row, before any mutation below
    if (!row) { // F5: corrupted row skipped, still poisons subsequent rows
      gapSeen = true;
      if (!wasGapSeen) consumedCount++; // G1: unrecoverable either way — consume it so the ack cursor can pass it forever
      continue;
    }
    const origHash = forwardedOrigHashOf(row);
    // exact-hash duplicate (own hash OR the original's, for a forwarded copy) —
    // never counted as withheld
    if ((row.hash && seenHashes.has(row.hash)) || (origHash && seenHashes.has(origHash))) {
      if (!wasGapSeen) consumedCount++; // G2: a physical row was resolved here even though nothing was delivered
      continue;
    }
    if (wasGapSeen) { gapWithheldCount++; continue; } // ambiguous suffix — withheld (never lost, cursor never touches it)
    // (b) WEAK logical suppression — see this function's header (ROUND 13 R1).
    // CONSUMED, exactly like the exact-hash duplicate above: not delivered, but
    // the cursor may pass it, and `gapSeen` is NOT set. The old
    // suppress-without-consume form wedged the window on the same row forever.
    let logicalKey = null;
    if (seenLogical) {
      logicalKey = logicalDeliveryKey(row);
      if (logicalKey && seenLogical.has(logicalKey)) {
        consumedCount++;
        logicalSuppressedCount++;
        try {
          if (alog && typeof alog.logEvent === 'function') {
            alog.logEvent('devswarm-cli', 'sibling-fold-logical-dup', 'info',
              'suppressed a logically-duplicate sibling row (weak key match)',
              { reason: 'logical-dup', from: row.from != null ? String(row.from) : null, ts: Number.isFinite(row.ts) ? row.ts : null });
          }
        } catch (_) { /* diagnostics never affect the fold */ }
        continue;
      }
    }
    if (!isForwardable(row)) gapSeen = true; // non-forwardable: delivered now, ends this window's deliverable prefix
    if (row.hash) seenHashes.add(row.hash);
    // Register the ORIGINAL's identity too, so a later row in THIS same fold
    // that IS that original (or another copy of it) is suppressed symmetrically.
    if (origHash) seenHashes.add(origHash);
    if (seenLogical && logicalKey) seenLogical.add(logicalKey);
    consumedCount++;
    deliveredRows.push(row);
    consumedThrough.push(consumedCount);
  }
  return {
    deliveredRows, deliveredCount: deliveredRows.length, gapWithheldCount,
    consumedCount, consumedThrough, logicalSuppressedCount,
  };
}

// retireWorktreeDuplicates(home, keepDesc, ctx) — DELIVERY-CONVERGENCE reconcile
// (v0.55.x P0 message-loss fix). A DevSwarm child registers under its builder-id
// (the per-project substrate scheme — a free-form id that is NOT the worktree's own
// meshId). An OLDER duplicate row for the SAME worktree can still be LIVE in the
// shared registry: a legacy hivecontrol-native `<label>-<repoId8>` registration, or
// a pre-register `primary-<hash>` spawn phantom. Both hash (via their worktreePath)
// to the SAME meshId as the child's own row, so `resolveMeshTarget` has TWO rows
// resolving to this worktree and can route a `send` into the duplicate's partition —
// which no live session ever drains (the child reads its OWN builder-id partition)
// -> silent message loss.
//
// On self-register this RETIREs every OTHER same-worktree row so exactly ONE row
// (the caller's own builder-id — the partition the child actually reads) survives,
// making send-target and child-drain CONVERGE on ONE partition. Retire = the
// sanctioned registry tombstone (store.removeRegistry — a `remove` op in the
// append-only journal, a registry-row delete in sqlite); the `messages` rows are a
// DIFFERENT table and are NEVER deleted. Before tombstoning, every UNREAD direct
// message already sitting in the retired partition is FORWARDED into the surviving
// partition (re-appended with the survivor as recipient, hash recomputed from the
// new fields so a re-run OR-IGNOREs) so the cutover — and the entire backlog a child
// silently lost while both rows were live — orphans NOTHING. If forwarding a row's
// backlog throws, that duplicate is LEFT in place (never tombstoned) so no unread is
// stranded; a later self-register retries it.
//
// GATED to builder-id self-registrations (keepDesc.id !== the worktree's meshId): a
// meshId-keyed register (the Primary's `register-primary`, or the spawn phantom) must
// NEVER retire the child's live builder-id row, so those paths are a deliberate
// no-op. Idempotent (a tombstoned row is gone from listRegistry, so a re-run finds
// nothing) and FAIL-OPEN (any error is swallowed — a reconcile failure must never
// crash the child's register / SessionStart or block its turn).
function retireWorktreeDuplicates(home, keepDesc, ctx) {
  try {
    if (!keepDesc || !keepDesc.worktreePath || !keepDesc.id) return null;
    const keepMesh = inst.primaryWorkspaceId(keepDesc.worktreePath);
    if (!keepMesh) return null;
    // A meshId-keyed row (Primary / spawn phantom) must not retire a child's live
    // builder-id row — only a builder-id self-register (id !== the worktree meshId)
    // is the NEW scheme this reconcile is for.
    if (String(keepDesc.id) === String(keepMesh)) return null;
    // P1 (mis-retire hardening): match same-worktree candidates by the CANONICAL
    // real-path (worktreeRealPath — the collision-free pre-image of the hash), NOT
    // the 8-hex worktreeHash/meshId. A sha256-slice hash can (astronomically, but on
    // a money path "can" is disqualifying) collide two DISTINCT worktrees onto one
    // meshId; matching the resolved real path instead makes a mis-identification
    // impossible. The SHARED canonicalWorktreeRealPath (also used by
    // foldMeshDuplicates) is the collision-free pre-image of canonicalMeshId's hash,
    // so the two paths cannot diverge. Fail-open null (unresolvable) -> no-op.
    const keepReal = canonicalWorktreeRealPath(keepDesc.worktreePath);
    if (!keepReal) return null;
    const repoKey = repoKeyForCwd(ctx);
    const s = store.openStore({
      home, workspaceId: keepDesc.id, hash: repoKey || undefined,
      backend: ctx && ctx.backend, env: ctx && ctx.env,
    });
    let result;
    try {
      // Candidate set = every OTHER registry row for the SAME physical worktree
      // (matched by the SHARED canonicalWorktreeRealPath — the collision-free
      // pre-image of the hash, NOT the 8-hex meshId, so a sha256-slice hash can
      // never mis-identify two DISTINCT worktrees onto one meshId; fail-open null
      // -> this row is skipped). The forward-then-tombstone body is the SHARED
      // foldGroupIntoSurvivor primitive (also used by foldMeshDuplicates).
      const candidates = [];
      for (const d of s.listRegistry()) {
        if (!d || d.id == null || String(d.id) === String(keepDesc.id)) continue;
        if (!d.worktreePath) continue;
        if (canonicalWorktreeRealPath(d.worktreePath) !== keepReal) continue; // SAME physical worktree only (no hash-collision class)
        candidates.push(d);
      }
      result = foldGroupIntoSurvivor(s, home, keepDesc.id, candidates);
      // Gate on forwarded TOO, not retired alone: foldGroupIntoSurvivor forwards unread
      // rows into the survivor partition (devswarm.js:1124) BEFORE the descriptor check
      // (:1136) that classifies a candidate as `left`. When every candidate is
      // descriptor-backed, forwarded>0 with retired EMPTY — real messages delivered with
      // NO projection refresh, so they are invisible to every summary.json reader.
      if (result.retired.length || result.forwarded) store.deriveSummary(s, { home, env: ctx && ctx.env });
    } finally { s.close(); }
    const { retired, left, forwardFailed, forwarded } = result;
    const skipped = result.skipped || [];
    if (!retired.length && !left.length && !forwarded && !forwardFailed.length && !skipped.length) return null;
    const out = { retired, forwarded };
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    if (skipped.length) out.pending = skipped; // not done this pass — never reported as clean
    return out;
  } catch (_) { return null; } // fail-open: reconcile must never crash the caller
}

// foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) — the SHARED
// forward-then-tombstone primitive used by BOTH retireWorktreeDuplicates (one
// caller's worktree) and foldMeshDuplicates (the whole registry). For each
// candidate row (already filtered to belong with `survivorId`):
//   1. FORWARD its UNREAD direct backlog into the survivor (re-appended with the
//      survivor as recipient, hash recomputed so a re-run OR-IGNOREs), so the
//      cutover orphans NOTHING. Best-effort per row: on ANY forward error, DO NOT
//      tombstone — the row is LEFT (recorded in forwardFailed + a stderr warning,
//      never silently swallowed) so no unread is stranded (a later pass retries).
//   2. TOMBSTONE only a row we can prove is NOT a distinct live child — a
//      store-only row (spawn phantom / ingested legacy hivecontrol-native
//      registration) with NO on-disk per-project descriptor. A candidate that HAS
//      a descriptor could be a distinct live child draining its OWN partition, so
//      it is LEFT (recorded in `left`), never tombstoned — losing a message by
//      mis-retiring is far worse than leaving a duplicate row (P1 hardening).
// `opts.dryRun` classifies (which rows WOULD retire/left) without forwarding or
// tombstoning — used by the doctor `fold-mesh-duplicates` detect() so it shares
// this ONE classification instead of a second reimplementation. NEVER throws on a
// row (each is try/wrapped by the caller's own fold body / fail-open).
//
// `opts.lockCandidates` (OPT-IN — the ARCHIVE paths only; see
// retireArchivedWorktreeGroup's header for the full why) runs each candidate's
// forward + descriptor-check + conditional tombstone under withIdLock(candidateId)
// and re-derives the CAS snapshot from a FRESH in-lock re-read of that row. The
// conditional tombstone alone closes every interleaving where a candidate's
// re-register lands BEFORE the tombstone (the CAS then mismatches and refuses);
// it CANNOT close the one where the re-register's registry write lands AFTER it —
// cmdRegister writes the descriptor and upserts the row as two separate steps, so
// a fold that samples the row, sees no descriptor yet, and CASes before either
// write tombstones a row that a live child is in the middle of re-establishing.
// Holding that candidate's OWN lock makes our check+tombstone atomic with respect
// to cmdRegister, which wraps both of its writes in withIdLock(id) — the window
// closes completely. A lock-busy candidate is SKIPPED (never forwarded, never
// tombstoned), reported in `lockBusy`, and retried by a later pass (every step
// here is idempotent). Existing non-archive callers do not pass this and keep
// today's exact behaviour.
function foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) {
  const dryRun = !!(opts && opts.dryRun);
  // allowArchivedDest: the survivor may be an ARCHIVED partition — only for a
  // caller moving archived-origin rows (see appendIntoPartition).
  const allowArchivedDest = !!(opts && opts.allowArchivedDest);
  const lockCandidates = !!(opts && opts.lockCandidates) && !dryRun;
  // childLabel (v0.108.0, repairChildSenderLabels only): every candidate is a
  // CHILD worktree's own `primary-<hash>` label and the survivor is that same
  // child's registry row on the same worktree — one identity, not a distinct
  // child. Only LIVENESS protects such a row; its descriptor (written by the
  // old register-primary) and a stale read frontier do not, because its unread
  // is forwarded to the child's own partition before any cursor moves.
  const childLabel = !!(opts && opts.childLabel);
  // P0-B fix, CORRECTED (see below): an EARLIER version of this fix bypassed the
  // descriptor gate outright on the theory that every caller already proves
  // canonicalWorktreeRealPath equality, so "could be a distinct live child" was
  // structurally unreachable. That theory is FALSE — disproven by an existing,
  // intentional test (devswarm-retire-duplicate.test.js "P1: a distinct live
  // child (own descriptor) sharing a worktree is forwarded + LEFT, never
  // tombstoned"): two genuinely live sessions (e.g. two terminal tabs) CAN both
  // register from the exact same worktree path under different builder-ids, and
  // both must survive — same-realpath does NOT imply "not distinct". Blanket-
  // bypassing broke that legitimate case.
  //
  // The REAL bug (ground-truth a downstream project inspection): a descriptor can linger on
  // disk for a row whose session has ALREADY DIED — descriptor files are never
  // cleaned up on session exit — so "has a descriptor" alone is not proof of a
  // live distinct child either; cmdRegister writes one for every id, making the
  // bare-descriptor gate always-true and duplicates immortal REGARDLESS of
  // liveness. The evidence that DOES distinguish a genuinely dead/stranded
  // duplicate from a real distinct live child is the SAME session-reference-
  // integrity signal (a) devswarm-liveness-select.js uses for addressing: the
  // field-observed dead row's sessionId held its LIVE SIBLING's own registry
  // id — a stale cross-reference, not a real session. A descriptor-backed
  // candidate whose sessionId aliases another id already in this SAME group
  // (any other candidate, or the survivor) is therefore NOT protected by the
  // descriptor gate; every other descriptor-backed candidate (a self-consistent
  // sessionId, exactly the P1 test's shape) keeps the original protection
  // unconditionally, for every caller, with no opt-in flag needed. CAS
  // (removeRegistryIf below) remains the final safety net regardless: a
  // candidate genuinely re-touched by a live session between the snapshot and
  // the tombstone still fails the conditional delete and is LEFT, never lost.
  const groupIds = new Set();
  for (const d0 of candidates) { if (d0 && d0.id != null) groupIds.add(String(d0.id)); }
  if (survivorId != null) groupIds.add(String(survivorId));
  function isStaleCrossReference(row) {
    if (!row) return false;
    const sid = row.sessionId != null ? String(row.sessionId) : '';
    return sid !== '' && sid !== String(row.id) && groupIds.has(sid);
  }
  const retired = [];
  const left = [];
  const forwardFailed = [];
  // `skipped` — candidates we deliberately did NOT act on this pass (lockCandidates
  // only): [{id, reason}] with reason 'lock-busy' | 'row-unreadable'. Always present
  // and EMPTY for the unlocked callers, whose behaviour is unchanged.
  const skipped = [];
  // `leftRows` — id -> the row this pass ACTUALLY judged when it decided 'left'
  // (the fresh in-lock re-read when lockCandidates is on, the pre-lock row
  // otherwise). Callers that report WHY a row was left (archiveLeftReason) must
  // key off this, not their own pre-lock snapshot, or the reported reason can
  // contradict what the pass acted on for a row whose liveness changed inside
  // the lock window. `left` itself stays a plain id array — existing callers
  // (foldMeshDuplicates) read it that way and are unaffected.
  const leftRows = new Map();
  // `anchorLeft` — the subset of `left` that survived specifically because the
  // mesh-anchor guard below refused to fold an ATTENDED canonical anchor. Kept
  // as its own Set (not a flag mutated onto the caller's row object, which is a
  // shared listRegistry() snapshot) so archiveLeftReason can report the TRUTH
  // ('mesh-anchor-attended') instead of the generic 'raced-re-register' an
  // anchor with no descriptor file would otherwise be labelled with. Every
  // non-anchor row's reason is unchanged.
  const anchorLeft = new Set();
  // canonicalMeshId spawns `git rev-parse --show-toplevel` (resolveCallerWorktree)
  // and was called once per CANDIDATE by the anchor guard below — a fold over a
  // 40-row same-worktree group paid 40 identical git spawns for one answer.
  // Memoized per worktreePath for the LIFETIME OF THIS ONE PASS only (never
  // module-scoped): a fold is a single synchronous sweep, so the resolution
  // cannot change underneath it, and a later pass still re-resolves from
  // scratch. Behaviour-preserving, including the fail-open: a THROW is cached
  // as the same `null` the catch below already treats as "cannot prove anchor".
  const meshIdCache = new Map();
  const meshIdFor = (wt) => {
    const key = String(wt);
    if (meshIdCache.has(key)) return meshIdCache.get(key);
    let v = null;
    try { v = canonicalMeshId(wt); } catch (_) { v = null; }
    // B2: a deleted worktree has no canonical meshId (decision 5). For this
    // PROTECTIVE test only, keep the legacy raw-path hash (the id a row
    // registered from that path carries), so an attended anchor row whose
    // worktree vanished stays protected exactly as before — never folded.
    if (!v) v = rawPathMeshId(wt);
    meshIdCache.set(key, v);
    return v;
  };
  let forwarded = 0;
  for (const d of candidates) {
    if (!d || d.id == null || String(d.id) === String(survivorId)) continue;
    // MESH-IDENTITY-ANCHOR GUARD (Item 1 P0 fix — downstream-Primary mail
    // loss, field evidence: `primary-<hash>` cursor advancing on wake-watch
    // turns with NO `read-primary` in between, while the swept rows PROVABLY
    // still exist in that exact row's own set). A candidate whose id IS the
    // canonical meshId for its own worktree (canonicalMeshId(d.worktreePath)
    // === d.id) is the STABLE, well-known addressing anchor every
    // read-primary/inbox-count/resolveMeshTarget/send caller resolves to —
    // never whichever id happened to win survivorship in THIS one fold pass.
    // retireWorktreeDuplicates already refuses to fold FROM a meshId-keyed
    // self-register (`if (String(keepDesc.id) === String(keepMesh)) return
    // null;`, above in this file) — but that guard only protects the meshId
    // row when it is the CALLER (the survivor). It left the mirror case wide
    // open: a co-located BUILDER-ID self-register (a distinct caller sharing
    // the SAME worktree, or foldMeshDuplicates' own pickSurvivor picking a
    // builder-id row over the meshId one) walks the meshId row in here as an
    // ORDINARY candidate, and foldOne's unconditional cursor-advance (the
    // contiguous-forwarded-prefix write below, `B1(b)`) sweeps its read
    // frontier past messages that get re-addressed to a survivor id nothing
    // standard ever reads under — real, undelivered mail silently marked
    // "read" on the only partition anyone queries.
    //
    // FIX: never even attempt to fold a meshId-canonical candidate that is
    // still ATTENDED — skip both the forward loop and the cursor advance
    // entirely (loss-free direction per this fix's own mandate: when in
    // doubt, do not fold, do not advance), reporting it exactly like any
    // other protected LEFT row.
    //
    // ATTENDED, not merely meshId-shaped (NARROWING — the first cut of this
    // guard keyed on identity ALONE and was too broad). The loss it prevents
    // is "a reader is still draining this exact partition and its frontier
    // gets swept out from under it". That reader only exists when the anchor
    // row is LIVE — a live registry sessionId (isLiveSessionId: non-empty and
    // not the synthetic prefix), or an on-disk descriptor for the id (a
    // session whose registry sessionId is blank/synthetic but which still
    // addresses itself under the anchor). An UNATTENDED anchor row — the
    // store-only `primary-<hash>` spawn phantom with sessionId null and no
    // descriptor — has no reader at all, and collapsing it is precisely what
    // the EXPLICIT retire paths exist to do: cmdArchive /
    // retireArchivedWorktreeGroup, healOrphanPartitions' phantom rescue,
    // foldArchivedRegistryRows, and the foldMeshDuplicates sweep. Their
    // forward-then-tombstone is loss-free (the unread is re-addressed to the
    // survivor first, and the original rows are never deleted), so blanket-
    // blocking them stranded phantom rows projecting active forever. This
    // narrowing is also CONSISTENT with the archive contract those paths
    // already honour independently (a row with its own LIVE descriptor is
    // never tombstoned, only surfaced) — it extends that same "leave the
    // live one alone" rule to the anchor's CURSOR, which the descriptor gate
    // by itself does not cover (it runs after foldOne has already forwarded
    // and advanced).
    //
    // Fail-open: any error resolving canonicalMeshId (git spawn failure,
    // unresolvable/vanished worktree path) means "cannot prove this is the
    // canonical anchor" -> falls through to the pre-existing behaviour
    // unaffected (never a false protection from a fail-open path). The
    // liveness half fails the OTHER way on error — an unreadable descriptor
    // area is not proof of absence, but isLiveSessionId is a pure string
    // test and readDescriptorFile is already fail-soft (returns null), so a
    // null there simply means "no positive evidence of a reader".
    //
    // READER EVIDENCE (Wave 10 — the FIELD shape the two signals above miss).
    // In the real incident store the live Primary's own anchor row carries
    // sessionId `unclaimed:primary-<hash>`, which isLiveSessionId REJECTS by
    // design (SYNTHETIC_SESSION_PREFIX, :245-250 — the auto-ensure/self-register
    // mint is deliberately not "live"). So in the field the guard held on the
    // DESCRIPTOR half ALONE — and descriptor-only protection is fragile,
    // because archive paths legitimately delete a live descriptor
    // (workspaces/<id>.json) while the session behind it keeps reading. A
    // third, INDEPENDENT positive signal closes that: proof that something has
    // ACTUALLY DRAINED this partition — a store cursor > 0 (s.cursorValue),
    // or an on-disk read-path ack file at primaryCursorPath(home,id)
    // (cursors/<id>.json, the file the primary ack path — `ack-primary` — acks through). Either one
    // means a reader exists (or existed and holds a frontier), and sweeping
    // that frontier forward is exactly the loss this guard exists to prevent.
    //
    // Deliberately NOT blanket: cursor 0 with no cursor file is the
    // UNATTENDED spawn-phantom shape the explicit retire paths (cmdArchive /
    // retireArchivedWorktreeGroup / foldArchivedRegistryRows / phantom
    // rescue) must still collapse — those rows never read anything, so they
    // produce no reader evidence and keep retiring unchanged.
    //
    // Fail-soft on BOTH halves: a store handle without cursorValue (the unit
    // fixtures' fake stores), a throwing cursorValue, or an unreadable cursors/
    // directory yields NO evidence — never a throw, never a false protection.
    const hasReaderEvidence = (id) => {
      try {
        if (s && typeof s.cursorValue === 'function') {
          const v = Math.max(s.cursorValue(id), floorCursor(s, id, home));
          if (Number.isFinite(v) && v > 0) return true;
        }
      } catch (_) { /* no evidence from the store */ }
      try { if (inboxCursor.readCursor(primaryCursorPath(home, id)) > 0) return true; } catch (_) { /* no evidence on disk */ }
      return false;
    };
    //
    // LIVENESS HALF — `isSiblingPartitionLive`, NOT `isLiveSessionId` (carry-out
    // (a)). `isLiveSessionId` is a pure SHAPE test: non-empty and not
    // 'unclaimed:'. It says nothing about whether that session still exists, so
    // a PHANTOM anchor carrying a stale non-null sessionId (a session that
    // ended hours ago, its id never cleared from the registry row) read
    // ATTENDED forever and could never be retired by any sweep — the anchor
    // became immortal, and the phantom kept projecting ACTIVE in the roster.
    // `isSiblingPartitionLive` (companion/lib/liveness.js:459) is the SAME
    // composed predicate `siblingAckGate` (:314 in this file) already uses for
    // exactly this "is there really a reader behind this partition" question,
    // so the two cursor-safety surfaces cannot drift: fresh heartbeat -> live;
    // empty/'unclaimed:' sessionId -> not live; otherwise live unless the row
    // is provably dormant. It fails OPEN (undetermined -> live -> protected),
    // which is the loss-free direction this guard already commits to.
    // The descriptor and reader-evidence halves are UNCHANGED — they are what
    // hold the FIELD case (an 'unclaimed:' anchor whose liveness half is false
    // by design), and the FIELD CASE tests pin them independently.
    //
    // CROSS-REFERENCE NARROWING (carry-out (b)). This branch used to `continue`
    // BEFORE the `isStaleCrossReference` check below ever ran, so an anchor
    // whose sessionId is ANOTHER GROUP MEMBER'S REGISTRY ID — the proven-stale
    // shape isStaleCrossReference exists to catch, and the exact evidence
    // devswarm-liveness-select.js uses to tell a dead duplicate from a real
    // live child — was immortal too, and worse: that bogus sessionId is
    // precisely what made the liveness half true. The two protections that a
    // stale cross-reference can FORGE are therefore withdrawn for it:
    //   * liveness — the cross-referenced sessionId IS the forged signal;
    //   * descriptor — :1914/:2002 already treat a descriptor as insufficient
    //     for a stale cross-reference, so honouring it here would contradict
    //     the fold's own rule two branches down.
    // READER EVIDENCE is NOT withdrawn, and that asymmetry is the whole point:
    // it is the FIELD P0 shape (a real reader draining this exact partition),
    // it cannot be forged by a sessionId — a cursor only moves because
    // something actually read — and sweeping a live frontier is the precise
    // loss this guard exists to prevent. So a cross-referenced anchor WITH a
    // read frontier stays fully protected; one with NO reader evidence falls
    // through to the ordinary path, where isStaleCrossReference governs it
    // exactly as it governs every other row (CAS-guarded tombstone, forward
    // first — loss-free).
    let isMeshAnchor = false;
    try {
      const anchorShaped = !!(d.worktreePath && String(d.id) === String(meshIdFor(d.worktreePath)));
      if (anchorShaped) {
        const readerEvidence = hasReaderEvidence(d.id);
        if (isStaleCrossReference(d)) {
          // R11-A5 — LIVENESS RESTORED HERE AS ITS HEARTBEAT TERM ONLY;
          // DESCRIPTOR STILL WITHDRAWN.
          //
          // Carry-out (b) withdrew liveness from a stale cross-reference on
          // the reasoning "the forged sessionId is what makes liveness true".
          // That reasoning holds for `isLiveSessionId` (a pure SHAPE test on
          // the sessionId string, which a cross-reference trivially satisfies)
          // and it is right to keep that withdrawn. But it swept away a term
          // that is NOT forgeable: `hasFreshHeartbeat(d.id, ...)` is keyed on
          // the ROW'S OWN id and read off that partition's own heartbeat file,
          // so nothing sitting in the sessionId field can produce it. A
          // cross-referenced anchor that is heartbeating RIGHT NOW has a real
          // session behind it, and retiring it is the same live-frontier sweep
          // the reader-evidence half exists to prevent.
          //
          // WHY NOT THE WHOLE `isSiblingPartitionLive` COMPOSITION (verified,
          // not assumed): after its heartbeat term, that function falls back to
          // `!isDormantRow(...)`, and isDormantRow is FAIL-OPEN on absence of
          // evidence (companion/lib/liveness.js:433-438 — "no signal at all ->
          // not dormant"). A cross-referenced anchor with no heartbeat and no
          // transcript therefore reads LIVE, which would protect essentially
          // EVERY cross-referenced anchor and re-create the immortal row
          // carry-out (b) exists to kill (proven: it turns the WAVE 11 (b) test
          // above red). Its dormancy term is also the one leg a borrowed uuid
          // CAN influence. So exactly the unforgeable half is restored here,
          // and the fail-open half is not.
          //
          // The DESCRIPTOR half stays withdrawn: :1976/:2064 already treat a
          // descriptor as insufficient for a stale cross-reference, and
          // honouring it here would contradict the fold's own rule.
          let beating = false;
          try {
            beating = hasFreshHeartbeat(d.id, home, { now: opts && opts.now });
          } catch (_) { beating = false; } // unreadable heartbeat is NOT positive proof of a live reader
          isMeshAnchor = readerEvidence || beating;
          if (childLabel) isMeshAnchor = isSessionAliveRow(d, home) && !liveSessionElsewhere(d, home); // one identity: only a running session ON this worktree protects
        } else {
          let live = false;
          try {
            live = isSiblingPartitionLive(
              { id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId },
              home, { now: opts && opts.now }
            );
          } catch (_) { live = true; } // undetermined -> fail toward attended (loss-free), matching isSiblingPartitionLive's own posture
          isMeshAnchor = live || !!readDescriptorFile(home, d.id) || readerEvidence;
          // One identity: only a positively RUNNING session protects a child
          // label. A heartbeat file is not proof — anyone can write one (field
          // repro: the Primary heartbeated a child's label from its own cwd).
          if (childLabel) isMeshAnchor = isSessionAliveRow(d, home) && !liveSessionElsewhere(d, home);
        }
      }
    } catch (_) { isMeshAnchor = false; }
    if (isMeshAnchor) { left.push(d.id); leftRows.set(String(d.id), d); anchorLeft.add(String(d.id)); continue; }
    if (dryRun) {
      // read-only classification: a store-only row WOULD be tombstoned; a
      // descriptor-backed one WOULD be left (never collapsed) — UNLESS its
      // sessionId is a proven stale cross-reference (see isStaleCrossReference
      // above), in which case it WOULD be tombstoned too (subject to the same
      // CAS the apply path uses).
      if (!childLabel && !isStaleCrossReference(d) && readDescriptorFile(home, d.id)) { left.push(d.id); leftRows.set(String(d.id), d); continue; }
      retired.push(d.id);
      continue;
    }
    // foldOne(row) — the per-candidate forward-then-tombstone body, factored so it
    // can run either UNLOCKED (the pre-existing callers' byte-identical behaviour)
    // or inside withIdLock(row.id) when lockCandidates is on. `row` is the snapshot
    // the conditional tombstone is keyed on: the pre-lock listRegistry() row when
    // unlocked, or a FRESH in-lock re-read when locked (acting on a pre-lock
    // snapshot under a lock would re-introduce the very lost-update the lock is
    // taken to prevent — rekeySubdirRegistryRows' rule).
    const foldOne = (row) => {
      let forwardOk = true;
      let since = 0;
      // advanceTo/sawGap (0a668d81c0c6 fix) — the cursor is a per-workspace
      // CONSUMED-COUNT into listMessages' insertion-ordered sequence
      // (devswarm-store.js:716); setting it to N asserts "rows 1..N since
      // `since` are fully handled, in order, no gaps". A non-forwardable row
      // (native-ingested mail: devswarm-ingest.js inserts it with mtype/
      // sender/recipient all NULL, so isForwardable is false) is NOT a copy
      // that safely exists elsewhere — it is real mail the row still needs —
      // so the advance may only cover the CONTIGUOUS run of forwarded-or-
      // dedup-confirmed rows starting at `since`. The first non-forwardable
      // row flips `sawGap` and permanently stops `advanceTo` from moving any
      // further, even though forwarding itself keeps running past it for any
      // later forwardable rows (forwarding is idempotent and independent of
      // the cursor). Was previously `s.messageCount(row.id)` — a raw COUNT(*)
      // over the whole partition that counts non-forwardable rows too, so it
      // swept the cursor past unforwarded native mail and silently lost it
      // (defect 0a668d81c0c6).
      let advanceTo = 0;
      let sawGap = false;
      // ---------------------------------------------------------------------
      // R13 item 11 (P0-adjacent, UNATTENDED) — DO NOT RE-FORWARD ROWS THE
      // SURVIVOR'S READER HAS ALREADY CONSUMED THROUGH THE SIBLING UNION.
      //
      // ROOT CAUSE (reproduced, not inferred): `since` below is the candidate's
      // OWN STORE CURSOR only. A LIVE twin's ack gate is closed by design
      // (siblingAckGate), so `read-primary` delivers that twin's rows to the
      // survivor's reader while deliberately leaving the twin's own cursors at
      // 0 — progress is recorded ONLY in the caller-scoped watermark (item 10).
      // The fold cannot see that watermark, so it restarts at 0 and forwards
      // the entire already-consumed backlog into the survivor as FRESH copies,
      // which the survivor's very next read then delivers a second time.
      // Measured on the repro shape (both rows live, survivor anchor-shaped):
      // watermark 20, fold forwarded 20, survivor total 1 -> 21, next
      // read-primary delivered 20 duplicates. This runs UNATTENDED — the
      // supervisor's periodic sweep (companion/devswarm-supervisor.js:658) and
      // `/anti-hall:update` (skills/update/scripts/update.js:1026) both call
      // THIS SAME `foldMeshDuplicates`, so neither needs (or has) its own path.
      //
      // FIX: forward only rows ABOVE `forwardFrom` = max of the three places
      // "this row has been consumed" can be recorded — the candidate's own two
      // cursor namespaces (item 7's MAX) and the SURVIVOR's watermark for this
      // candidate (item 10). Every row at or below it is already in the
      // survivor's reader's hands; copying it there is pure duplication.
      //
      // AND THE SKIP MUST NOT ADVANCE THE CANDIDATE'S OWN CURSOR (`sawGap`).
      // The B1(b) advance below is only sound because a forwarded row "safely
      // exists elsewhere" — in the survivor's partition. A SKIPPED row does
      // NOT: it was delivered to the survivor's READER but never copied into
      // the survivor's partition. Advancing the candidate's cursor past it
      // would hide it from the candidate's OWN reader, which is real mail loss.
      // Skipped rows sit at the FRONT of the window, so this simply means the
      // cursor does not move on a pass that only skipped — exactly right.
      let forwardFrom = 0;
      try {
        forwardFrom = Math.max(
          siblingBaseCursor(s, home, row.id),            // max(store cursor, cursors/<id>.json)
          readSiblingSeenCursor(home, survivorId, row.id) // the survivor's own watermark for this candidate
        );
      } catch (_) { forwardFrom = 0; } // fail-open: forward everything, the pre-fix behaviour
      const batch = [];
      try {
        since = floorCursor(s, row.id, home);
        advanceTo = since;
        let pos = since;
        for (const m of s.listMessages(row.id, { sinceCursor: since })) {
          pos += 1;
          // ALREADY DELIVERED to the survivor's reader (see forwardFrom above):
          // never copy it again, and never let the cursor advance past it.
          if (pos <= forwardFrom) { sawGap = true; continue; }
          if (!isForwardable(m)) { sawGap = true; continue; } // #67: forward only a real actionable direct — skips broadcast/heartbeat AND stale native poke/hash-mirror rows (mtype/sender null); also stops the cursor advance below, since this row's mail has no other home
          // FORWARD: same ONE shared MESH_ROW_COPY_FIELDS table as the verbatim
          // re-home site (see meshRowCopy). The overrides re-address the copy to the
          // survivor partition; `type:'direct'` is pinned (not m.mtype) because only
          // a direct can reach here at all — isForwardable already filtered the rest —
          // and urgency keeps its pre-existing empty-string->'normal' normalization.
          // `hash` is absent by design (recomputed below from the NEW fields) and so
          // is `isHeartbeat` (a heartbeat is never forwardable).
          const fields = meshRowCopy(m, 'message', {
            to: survivorId, type: 'direct', urgency: m.urgency || 'normal',
            // R13 item 11 (second half) — STAMP origHash, exactly as the
            // archived-forward site already does (forwardArchivedOrphanUnread,
            // ~:1370). The forward RE-ADDRESSES the row, so the copy's own hash
            // necessarily differs from the original's and no reader can match
            // it against a message it already consumed. C2's exact
            // cross-partition dedup (`foldSiblingGapRows`, via
            // `forwardedOrigHashOf`) is keyed on origHash — measured on the
            // repro, fold forwards carried it on 0 of 20 rows, so that dedup
            // could not fire for them at all. `m.origHash || m.hash`: a chain
            // of forwards keeps pointing at the ROOT original, never at the
            // intermediate copy. This is the belt to forwardFrom's braces —
            // forwardFrom stops the copy being made, origHash stops any copy
            // that IS made (an older build's, a different survivor's) from
            // being delivered twice.
            origHash: (m.origHash != null ? m.origHash : m.hash) || null,
          });
          batch.push(Object.assign({}, fields, { hash: store.meshMessageHash(fields) }));
          if (!sawGap) advanceTo = pos; // still a contiguous forwarded prefix — safe to advance through this row
        }
        // Cross-partition: ONE locked+rechecked append (appendIntoPartition). busy/
        // gone -> nothing forwarded, no cursor raise, no tombstone: PENDING.
        if (batch.length) {
          const res = appendIntoPartition(s, home, survivorId, batch, { allowArchivedDest });
          if (res.status !== 'ok') return { outcome: 'pending', reason: 'survivor-' + res.status };
          forwarded += res.inserted || 0;
        }
      } catch (_) { forwardOk = false; }
      if (!forwardOk) return { outcome: 'forward-failed' };
      // B1(b) fix — advance the CANDIDATE's OWN cursor now that the try block
      // above completed with NO exception (every appendMeshMessage call
      // either inserted the row into the survivor or hit the hash-dedupe
      // OR-IGNORE path because it was already forwarded by a prior pass —
      // both are "safely delivered", never "lost"). This closes the second,
      // independent defect: a candidate this pass classifies `left` (a live
      // descriptor it correctly never tombstones) previously kept its
      // pre-fold cursor forever, so its already-forwarded backlog rendered as
      // "N unread / not draining" indefinitely even though every message had
      // already reached the survivor. Advancing a LIVE child's cursor on its
      // behalf, from a sweep it never requested, IS a sound primitive here —
      // but ONLY up to `advanceTo`: every row up to that point is either
      // forwarded (verbatim, in the survivor's partition — reachable there)
      // or dedup-confirmed already forwarded by a prior pass, so marking it
      // read on the losing partition does not lose access to it. Gated on
      // COMPLETE success only — the `!forwardOk` branch above already
      // returned before reaching here, so a partial/failed forward (an
      // exception mid-loop, e.g. a store write that throws after some but
      // not all rows were appended) NEVER runs this: the cursor stays
      // exactly where it was, so the next fold pass re-attempts the whole
      // unread range and the already-forwarded rows are re-forwarded
      // idempotently (hash dedupe) rather than silently dropped off the read
      // frontier. `since`/`advanceTo` are computed from the SAME listMessages
      // read used for forwarding, so a message that arrives concurrently
      // mid-fold is simply left unread for the next pass, never swallowed.
      //
      // P0 LOCKSTEP (v0.90.1): advance the READ-PATH ack file
      // (`cursors/<id>.json`) to the SAME value. These are two namespaces for
      // one fact ("how far this partition is consumed"), and advancing only the
      // store side is exactly what let `inbox count` (store-sized) report 0
      // while `read-primary` (json-sized) re-delivered the whole already-
      // forwarded backlog on every read. `ackTo` is monotonic, so this can only
      // ever raise the file toward the store value, never rewind it.
      try {
        if (advanceTo > since) {
          // LOSS-FREE RAISE (Phase 3): every row behind `advanceTo` was forwarded
          // into the survivor partition before we got here, so EVERY reader row
          // and the floor move past it in one txn (retired rows stay retired).
          // raiseAllLossFree also dual-writes the legacy shared pair upward.
          const n = readerCursors.raiseAllLossFree(s, { partition: row.id, ns: 'store', value: advanceTo, home });
          if (n) logCursorWrite(home, { id: row.id, partition: row.id, ns: 'reader_cursors:store', from: since, to: advanceTo, delivered: null, gate: 'lockstep', verb: 'fold', cwd: (opts && opts.cwd) || null, repoKey: (opts && opts.repoKey) || store.hashFromWorkspaceId(row.id) });
          try { logCursorWrite(home, { id: row.id, partition: row.id, ns: 'store', from: since, to: advanceTo, delivered: null, gate: 'lockstep', verb: 'fold', cwd: (opts && opts.cwd) || null, repoKey: (opts && opts.repoKey) || store.hashFromWorkspaceId(row.id) }); } catch (_) {}
        }
      } catch (_) { /* best-effort bookkeeping; never blocks the fold itself */ }
      // `row` here is whatever foldOne was called with — the in-lock re-read `cur`
      // when locked, the pre-lock candidate `d` when not — so a caller keying its
      // reported reason off this row (leftRows, below) reports what THIS pass
      // actually judged, not a possibly-stale pre-lock snapshot.
      if (!childLabel && !isStaleCrossReference(row) && readDescriptorFile(home, row.id)) return { outcome: 'left', row };
      // P1a/P2/P3 race close: ATOMIC conditional tombstone. removeRegistryIf deletes
      // ONLY if the row is STILL EXACTLY the one we classified — its session_id AND
      // updatedAt AND writeSeq all still equal our snapshot (NULL-safe, so a null
      // snapshot updatedAt/writeSeq that gained a real value, or a NEW session_id,
      // counts as a re-register). sqlite: one atomic DELETE ... WHERE; journal: an
      // under-lock re-read + a conditional (`ifUpdatedAt`/`ifSessionId`/`ifWriteSeq`)
      // remove op reduceRegistry ignores if a re-register raced it. A child that
      // re-registered in the window (child-turn writes its descriptor THEN its store
      // row) is now re-written -> NOT deleted -> LEFT (a later fold re-evaluates);
      // forward-before-tombstone already ran and is idempotent, so nothing is
      // orphaned. (Descriptor-backed rows were already LEFT above — this pins the
      // store-only phantom, which may itself carry a stale session_id.)
      // P3 (v0.61.0 money-path residual): writeSeq is a per-row monotonic counter
      // bumped on EVERY upsert regardless of wall-clock ms — closes the LAST gap
      // where a live child re-registers the SAME id/sessionId within the SAME
      // millisecond as the snapshot (updatedAt alone can't distinguish that from a
      // stable phantom; writeSeq still advances).
      const removed = s.removeRegistryIf(row.id, { sessionId: row.sessionId, updatedAt: row.updatedAt, writeSeq: row.writeSeq });
      if (!removed) return { outcome: 'left' };
      // 73303d4c098b fix: the row is gone from the registry now (see the
      // header comment on writeRetiredRedirect above for why this cannot live
      // on the row itself) — record the redirect BEFORE reporting 'retired' so
      // a send/read-primary against this id, even one that races in right
      // after this fold returns, finds the hint. Best-effort/fail-open: a
      // failed write here never un-does the tombstone (the fold already
      // succeeded, forwarding already happened) — it only means a later
      // addressing attempt against the old id fails closed exactly as it did
      // before this fix, never worse.
      writeRetiredRedirect(home, row.id, survivorId);
      return { outcome: 'retired' };
    };

    let res;
    if (lockCandidates) {
      // NEVER the survivor's own lock — only CANDIDATE ids, which the loop guard
      // above proves are != survivorId. The archive callers already hold the
      // survivor's lock, so re-acquiring it here would self-deadlock.
      const r = withIdLock(d.id, home, () => {
        let cur = null;
        try { cur = (s.listRegistry() || []).find((x) => x && x.id != null && String(x.id) === String(d.id)) || null; }
        catch (_) { return { outcome: 'unreadable' }; }
        if (!cur) return { outcome: 'gone' }; // row already retired by another op -> nothing to do
        return foldOne(cur);
      });
      if (r && r.lockBusy) {
        // SKIPPED, not forwarded and not tombstoned: another operation (typically
        // the candidate's own cmdRegister) holds its lock. Surfaced, never silently
        // dropped — every step here is idempotent, so a later pass retires it.
        skipped.push({ id: String(d.id), reason: 'lock-busy' });
        try {
          process.stderr.write('[devswarm] foldGroupIntoSurvivor: candidate ' + JSON.stringify(String(d.id))
            + ' is locked by another operation in progress — skipped this pass (retried on the next run)\n');
        } catch (_) {}
        continue;
      }
      res = r;
    } else {
      res = foldOne(d);
    }
    if (!res || res.outcome === 'gone') continue;
    if (res.outcome === 'unreadable') {
      // Could not re-read the row under its lock -> cannot classify it; leave it
      // exactly as it is (idempotent retry next pass) rather than acting blind.
      skipped.push({ id: String(d.id), reason: 'row-unreadable' });
      continue;
    }
    if (res.outcome === 'pending') {
      skipped.push({ id: String(d.id), reason: res.reason });
      continue;
    }
    if (res.outcome === 'forward-failed') {
      forwardFailed.push(String(d.id));
      try {
        process.stderr.write('[devswarm] foldGroupIntoSurvivor: forward FAILED for '
          + String(d.id) + ' — row LEFT in place (not tombstoned); fold incomplete\n');
      } catch (_) {}
      continue;
    }
    if (res.outcome === 'left') {
      left.push(d.id);
      leftRows.set(String(d.id), res.row || d);
      continue;
    }
    retired.push(d.id);
  }
  // pending: candidates NOT done this pass (lock busy, survivor busy/gone,
  // unreadable) — a caller must never record the pass clean while it is > 0.
  return { retired, left, forwardFailed, forwarded, skipped, pending: skipped.length, leftRows, anchorLeft };
}

// pickArchiveForwardSurvivor(s, home, archivedId, rows) — WHERE the archive folds
// forward the unread backlog. This is a SEPARATE question from WHAT gets retired,
// and getting it wrong is message LOSS, not merely untidy bookkeeping.
//
// The archive paths originally hardcoded the ARCHIVED id as the forward survivor.
// That is right only when the whole worktree is going away. It is WRONG whenever a
// DIFFERENT live workspace still holds this worktree, because of the exact ordering
// the archive performs: forward into <survivor>, then tombstone. When the survivor
// IS the id being archived, its own registry row is tombstoned moments later
// (cmdArchive's removeRegistry, or this migration's ownRow CAS) — so a real unread
// direct, forwarded a few lines earlier, lands in a partition that computeSummary
// no longer projects and that NO live session drains. It is not deleted (message
// rows never are), but it is unreachable and invisible: the v0.55.x P0 message-loss
// class, re-created by the fold that was supposed to prevent it. A phantom row's
// unanswered question belongs with whoever is still ALIVE on that worktree.
//
// RULE: forward to a same-worktree row that has BOTH its OWN live descriptor
// (workspaces/<id>.json) AND a LIVE registry sessionId (isLiveSessionId). Among
// several such rows, defer to the EXISTING pickSurvivor (freshest-live registry
// updatedAt, cursor tiebreak) — the same selection resolveMeshTarget and
// foldMeshDuplicates already use, so a `send` to this worktree and this forward
// converge on ONE partition rather than a second, divergent survivor policy. With NO
// such row the archived id is the survivor: legitimate, because the whole worktree is
// retiring and the resulting partition is SURFACED as an orphan (never deleted),
// which is the no-delete posture, not loss.
//
// CONSERVATIVE vs STRICT — the conceptual error the first version of this helper
// made, spelled out because it reads like a consistency win and is not:
// that version deliberately reused the TOMBSTONE safety gate's test (descriptor
// presence, and nothing else) for the forward destination, on the reasoning that "the
// row we refuse to retire" and "the row we trust to drain" must never disagree. They
// are DIFFERENT QUESTIONS and they SHOULD disagree:
//   - TOMBSTONING must be CONSERVATIVE: never retire a row that MIGHT still be alive.
//     A descriptor file is the right (permissive) test there — over-keeping a row is
//     untidy, mis-retiring one loses a workspace. That gate is UNCHANGED.
//   - The FORWARD DESTINATION must be STRICT: only forward where something will
//     ACTUALLY drain. A descriptor file proves only that a workspace once existed —
//     NOTHING purges a stale workspaces/<id>.json after a crash, so a crashed sibling
//     keeps its descriptor while its registry sessionId is empty/synthetic (dead).
// Forwarding into such a row buries a real unanswered direct in a partition no live
// session drains: the SAME message-loss class this helper exists to close, merely
// relocated from the archived id to a different dead id — and WORSE, because the
// destination was then reported as 'live-descriptor', so the operator had no signal
// anything was wrong. Session liveness is the only test that answers "will this
// drain?".
//
// pickSurvivor's firstMatch fallback is why the filter must be a PRE-filter, not a
// post-hoc trust: pickSurvivor assigns firstMatch UNCONDITIONALLY before its own
// liveness check and ends `return bestLive || firstMatch`, so handing it a set with
// no live row returns a DEAD row rather than null. Every row we pass in is therefore
// already proven live-session, which makes both branches of that fallback live; the
// belt-and-braces post-check below re-verifies the pick and falls back to the
// archived id if it is ever not. pickSurvivor itself is left alone on purpose — its
// other callers (retireWorktreeDuplicates / foldMeshDuplicates / the fold) rely on
// the firstMatch fallback, and changing shared behaviour here would be a far wider
// blast radius than this bug.
//
// Fail-open: any error -> the archived id (the pre-existing behaviour).
function pickArchiveForwardSurvivor(s, home, archivedId, rows) {
  try {
    const drainableRows = [];
    for (const d of rows || []) {
      if (!d || d.id == null || String(d.id) === String(archivedId)) continue;
      if (!readDescriptorFile(home, d.id)) continue;   // store-only phantom: cannot drain anything
      if (!isLiveSessionId(d.sessionId)) continue;     // descriptor-backed but SESSION-DEAD (crashed sibling): nothing drains it
      drainableRows.push(d);
    }
    if (!drainableRows.length) return String(archivedId);
    const pick = pickSurvivor(s, { rows: drainableRows }, home);
    // Post-check (defence in depth against pickSurvivor's firstMatch fallback ever
    // returning a row the pre-filter would have rejected): a destination we cannot
    // PROVE drainable is never used.
    if (!pick || pick.id == null || !isLiveSessionId(pick.sessionId) || !readDescriptorFile(home, pick.id)) {
      return String(archivedId);
    }
    return String(pick.id);
  } catch (_) { return String(archivedId); }
}

// archiveLeftReason(home, id, row) — the REPORTED reason a same-worktree row survived
// the fold. Must be a FACT, not a reassuring label: the tombstone gate keeps every
// descriptor-backed row (correctly conservative — see above), so a row left behind may
// be a genuinely live child OR a crashed one whose stale descriptor outlived it. Those
// are operationally different (the first drains its partition, the second does not), so
// they get DIFFERENT reasons — 'live-descriptor' keeps its existing, accurate meaning
// (descriptor AND live session; other tests assert on it) and the dead case is named
// explicitly instead of borrowing the word "live". `row` is the registry snapshot, may
// be missing -> then only the descriptor is knowable.
// `isAnchor` (Wave 10) — true when foldGroupIntoSurvivor's mesh-anchor guard is
// what kept this row (r.anchorLeft). That row was never even OFFERED to the
// tombstone, so 'raced-re-register' (which asserts a conditional delete was
// refused) is a FALSE report for it — and it is the reason an anchor protected
// only by reader evidence (no descriptor file) would otherwise get. Checked
// FIRST because it is the most specific fact available; every other row's
// reason is computed exactly as before.
function archiveLeftReason(home, id, row, isAnchor) {
  if (isAnchor) return 'mesh-anchor-attended';
  if (!readDescriptorFile(home, id)) return 'raced-re-register';
  if (row && isLiveSessionId(row.sessionId)) return 'live-descriptor';
  if (!row) return 'live-descriptor'; // no snapshot to judge liveness with; descriptor is all we know
  return 'descriptor-no-live-session';
}

// retireArchivedWorktreeGroup(s, home, archivedId, worktreePath) — the ARCHIVE
// counterpart of retireWorktreeDuplicates, and the fix for "an archived
// workspace keeps projecting ACTIVE on the roster".
//
// MECHANISM (why one tombstone is not enough): a registry row is keyed on the
// id of whoever REGISTERED it (cmdRegister), while a worktree's mesh ADDRESS is
// derived separately from its worktreePath. Two id-spaces, one worktree — by
// design (a child MUST own the partition it drains, the v0.55.x P0 message-loss
// fix). The consequence is that up to four DIFFERENT ids can hold a live
// registry row for ONE physical worktree at the same time: the child's
// hivecontrol builder UUID, a `primary-<8hex>` spawn phantom / register-primary
// row, a legacy ingested `<label>-<repoId8>` row, and a `primary-<8hex>`
// derived from a SUBDIR pre-image. cmdArchive tombstoned exactly ONE of them —
// the id it was asked to archive — and computeSummary treats "has a registry
// row" as "this workspace is active", so EVERY surviving sibling row kept the
// just-archived workspace projecting as live. Archiving is a WORKTREE-level
// retirement, so the whole same-worktree group must retire with it.
//
// Candidates are matched on the collision-free canonicalWorktreeRealPath (the
// resolved real path STRING, never the 8-hex hash — a hash bucket can collide
// two distinct worktrees; see that helper's own comment), and folded with the
// SHARED foldGroupIntoSurvivor primitive, so every retired row's unread direct
// backlog is FORWARDED into ONE partition before anything is tombstoned. Message
// rows are NEVER deleted.
//
// The forward survivor is chosen by LIVENESS (pickArchiveForwardSurvivor), NOT by
// "whoever is being archived". Hardcoding the archived id forwards a phantom's
// unanswered question into a partition this very function's caller tombstones a few
// lines later — undeleted but undrainable and unprojected, i.e. the message-loss
// class the fold exists to prevent. See that helper for the full why. The survivor
// is never a candidate (so it is never locked, forwarded from, or tombstoned) and,
// when it is not the archived id, it is still SURFACED in `left` with its
// 'live-descriptor' reason — it survived the fold, and every surviving
// same-worktree row is reported.
//
// SAFETY GATE (the sharpest edge): foldGroupIntoSurvivor deliberately LEAVES any
// row that has its own LIVE descriptor (workspaces/<id>.json) — such a row could
// be a DISTINCT live child draining its own partition, and tombstoning it would
// silently archive a workspace the user never asked to archive. That is exactly
// the rule archive needs, so it is reused verbatim rather than relaxed: a row is
// tombstoned only when it has no live descriptor of its own. Every row left
// behind is SURFACED with a reason (never silently dropped), so the caller can
// report it instead of the user discovering a still-active ghost later.
//
// LOCKING (this used to read "lock-free BY CONTRACT" — that was WRONG for this
// path, and the reason is worth spelling out):
//   - The ARCHIVED id is NEVER locked here. cmdArchive already holds
//     withIdLock(archivedId) around this whole call, and the per-id lock is NOT
//     re-entrant, so re-acquiring it would self-deadlock (it would spin out its
//     budget and then fail closed, silently turning archive into a no-op fold).
//     Every candidate is != archivedId by the loop's own guard, so nothing below
//     can ever take that lock.
//   - The CANDIDATES *are* locked (`lockCandidates: true`), because the atomic
//     conditional tombstone is not sufficient on its own. removeRegistryIf refuses
//     when a candidate's re-register lands BEFORE it (the snapshot mismatches), but
//     cmdRegister performs TWO writes — descriptor first, registry upsert second —
//     both under withIdLock(id). A fold that samples a candidate's row, reads no
//     descriptor (not written yet), and CASes (row not yet re-upserted, so the
//     snapshot still matches) tombstones the row of a child that is at that instant
//     coming back to life; the child's upsert then re-creates the row, leaving the
//     unread backlog we just forwarded sitting as undrainable duplicates in the
//     ARCHIVED partition (whose own registry row cmdArchive tombstones moments
//     later) and, in the window between, a live child that `send` and the roster
//     both read as unregistered. Taking the candidate's OWN lock makes our
//     descriptor-check + tombstone atomic against exactly those two writes, which
//     is what closes the window. The in-lock re-read (never the pre-lock snapshot)
//     is what makes the CAS key honest.
//   - NO CYCLE: withIdLock is a BOUNDED wait (acquireIdLock's 2s budget) that then
//     FAILS CLOSED with {lockBusy:true} rather than blocking forever, and a
//     lock-busy candidate is SKIPPED — not forwarded, not tombstoned, just
//     surfaced in `left` with reason 'lock-busy'. So two concurrent archives on one
//     worktree that each hold the other's id (an X->Y / Y->X cycle) cannot wedge:
//     both time out, both skip, and because every step is idempotent a later pass
//     retires whatever was skipped.
// FAIL-OPEN: never throws.
function retireArchivedWorktreeGroup(s, home, archivedId, worktreePath) {
  const out = { retired: [], forwarded: 0, left: [], forwardedTo: String(archivedId) };
  try {
    if (!worktreePath || archivedId == null) return out;
    const keepReal = canonicalWorktreeRealPath(worktreePath);
    if (!keepReal) return out; // unresolvable path -> cannot PROVE same worktree; never fold
    const candidates = [];
    for (const d of s.listRegistry()) {
      if (!d || d.id == null || String(d.id) === String(archivedId)) continue;
      if (!d.worktreePath) continue;
      if (canonicalWorktreeRealPath(d.worktreePath) !== keepReal) continue; // SAME physical worktree only
      candidates.push(d);
    }
    if (!candidates.length) return out;
    // LIVENESS survivor: a same-worktree row that still has its own descriptor
    // outlives this archive, so it — not the id being tombstoned — is the partition
    // the phantoms' unread must land in.
    const survivorId = pickArchiveForwardSurvivor(s, home, archivedId, candidates);
    out.forwardedTo = survivorId;
    // The survivor is excluded from the fold entirely: never forwarded FROM, never
    // locked, never tombstoned. (foldGroupIntoSurvivor's own loop guard would skip
    // it anyway; filtering here makes the exclusion explicit and keeps it out of the
    // primitive's retired/left bookkeeping so we can report it ourselves.)
    const foldCandidates = candidates.filter((d) => d && String(d.id) !== survivorId);
    // cmdArchive holds withIdLock(archivedId): take the survivor's lock only when
    // the survivor is a DIFFERENT id.
    const r = foldGroupIntoSurvivor(s, home, survivorId, foldCandidates, { lockCandidates: true });
    out.retired = r.retired.map((x) => String(x));
    out.forwarded = r.forwarded;
    // The forward survivor, when it is not the archived id, is a same-worktree row
    // that SURVIVED this archive — surfaced with the SAME 'live-descriptor' reason
    // the safety gate gives every other kept row, so the caller's report still
    // accounts for every row it did not retire.
    // The survivor, when it is not the archived id, is by construction descriptor-
    // backed AND live-session (pickArchiveForwardSurvivor's strict filter), so
    // 'live-descriptor' is a FACT here, not a hopeful label.
    const rowOf = new Map(candidates.map((d) => [String(d.id), d]));
    if (survivorId !== String(archivedId)) out.left.push({ id: survivorId, reason: 'live-descriptor' });
    for (const x of r.left) {
      // Distinguish the ways a row survives the fold, so the reason is a FACT rather
      // than a guess: a descriptor-backed row with a LIVE session (a distinct live
      // child — the safety gate), a descriptor-backed row whose session is DEAD (a
      // crashed sibling whose stale descriptor kept the conservative gate from
      // retiring it — it is NOT draining anything), or a row whose atomic conditional
      // tombstone was refused because it changed under us (a re-register raced the
      // fold). See archiveLeftReason. Key off the row the pass ITSELF acted on
      // (r.leftRows — the in-lock re-read foldOne classified), not the pre-lock
      // `rowOf` snapshot: a row whose liveness changed inside the lock window
      // must not get a reason derived from stale pre-lock state. Fail open to
      // the pre-lock snapshot only if leftRows has nothing for this id.
      out.left.push({ id: String(x), reason: archiveLeftReason(home, x, (r.leftRows && r.leftRows.get(String(x))) || rowOf.get(String(x)), !!(r.anchorLeft && r.anchorLeft.has(String(x)))) });
    }
    for (const x of r.forwardFailed) out.left.push({ id: String(x), reason: 'forward-failed' });
    // Candidates we deliberately skipped (their own lock was held, or the in-lock
    // re-read failed): NOT retired, NOT forwarded, surfaced with the real reason.
    for (const x of r.skipped) out.left.push({ id: String(x.id), reason: x.reason });
    return out;
  } catch (_) { return out; } // fail-open: a group retire must never break archive itself
}

// rekeySubdirRegistryRows(s, dryRun) — P1b: reconcile the two identity views so a
// subdir-registered row is addressable by its TOPLEVEL meshId. resolveMeshTarget
// (send) matches a row by inst.primaryWorkspaceId(d.worktreePath) — the RAW stored
// path — while the fold groups by canonicalMeshId (git TOPLEVEL). An OLD store's row
// registered from a git SUBDIR stored a raw-subdir path whose meshId != its toplevel
// meshId, so `send --to <toplevel meshId>` failed closed as unregistered-recipient,
// and a LONE such row is skipped by the >=2 fold. Re-key it IN PLACE: rewrite the
// stored worktreePath to its canonical git toplevel, so the raw-path meshId
// resolveMeshTarget hashes BECOMES the toplevel meshId. This is a registry UPDATE
// (same id) — the partition (d.id, where the row's messages live) is UNCHANGED, so NO
// message move is needed; and it makes send + fold agree on ONE identity. A submodule
// resolves to its OWN toplevel and keeps a DISTINCT meshId (never merged into the
// parent). Non-git / unresolvable paths are left as-is (raw path IS their own meshId).
// Returns the count of re-keyed ids. dryRun classifies without writing (doctor detect).
//
// P1c (v0.62.0 lock hardening): the APPLY path is a per-id read-modify-write —
// it carries d.sessionId/inboxPath/cursorPath/nudgeCommand forward so the rekey
// only rewrites worktreePath. That snapshot is read from listRegistry() OUTSIDE
// any lock, so a concurrent register/ensure/heartbeat/re-home for the SAME id
// (each of which runs under withIdLock and can update those very fields) could
// land BETWEEN this snapshot and the upsert — and the upsert would then clobber
// the concurrent update back to the STALE snapshot values (a classic lost
// update: e.g. a child that just registered its real durable inboxPath gets it
// nulled out). foldMeshDuplicates is invoked from doctor's repair (apply) with
// NO id lock held, so this race is genuinely reachable against a live child.
// Fix: run each row's write under withIdLock(id) AND re-derive from a FRESH
// in-lock re-read of the row (the lock only serializes the write window; writing
// the pre-lock snapshot would still lose the update). A lock-busy row (another
// op mid-mutation) is SKIPPED and surfaced, never written unlocked — the rekey
// is idempotent, so the next doctor run re-detects and re-keys it. dryRun takes
// no lock (pure classification, no write). NB no deadlock: foldMeshDuplicates
// holds no per-id lock when it calls this, so the per-id acquire here is never
// re-entrant.
function rekeySubdirRegistryRows(s, home, dryRun) {
  let rekeyed = 0;
  // needsRekey(row) -> canonical toplevel path to write, or null if the row is
  // already canonical / non-git / unresolvable. The SAME classification is used
  // for the outer snapshot pass and the in-lock re-read so both agree.
  const needsRekey = (row) => {
    if (!row || !row.worktreePath || row.id == null) return null;
    const top = identityContext(String(row.worktreePath)).worktreeRoot; // a ROW path: deleted -> null, never an enclosing repo
    if (!top) return null; // non-git / unresolvable -> raw path is already its own meshId
    const canonMesh = inst.primaryWorkspaceId(top);
    if (!canonMesh || inst.primaryWorkspaceId(row.worktreePath) === canonMesh) return null; // already canonical
    return top;
  };
  for (const d of s.listRegistry()) {
    if (!needsRekey(d)) continue;
    if (dryRun) { rekeyed++; continue; }
    const r = withIdLock(d.id, home, () => {
      // Re-read the CURRENT row under the lock — a concurrent mutator may have
      // changed worktreePath/sessionId/inboxPath/... (or removed the row) since
      // the snapshot above. Never write stale snapshot fields.
      const cur = s.listRegistry().find((x) => x && String(x.id) === String(d.id));
      const curTop = needsRekey(cur);
      if (!curTop) return { rekeyed: false }; // row vanished, or already canonical now
      s.upsertRegistry({
        id: cur.id,
        worktreePath: curTop, // rewritten to the canonical git toplevel (send+fold now agree)
        sessionId: cur.sessionId,
        inboxPath: cur.inboxPath,
        cursorPath: cur.cursorPath,
        nudgeCommand: cur.nudgeCommand,
      }, { allowPathChange: true }); // F2 guard bypass: intentional same-id subdir->toplevel rewrite, not a hash collision
      return { rekeyed: true };
    });
    if (r && r.lockBusy) {
      // Surfaced, NOT silently dropped: idempotent, so the next fold/doctor run re-keys it.
      try {
        process.stderr.write('[devswarm] rekeySubdirRegistryRows: id ' + JSON.stringify(d.id)
          + ' is locked by another operation in progress — skipped this pass (re-keyed on the next run)\n');
      } catch (_) {}
      continue;
    }
    if (r && r.rekeyed) rekeyed++;
  }
  return rekeyed;
}

// foldMeshDuplicates(home, ctx) — MIGRATION generalization of
// retireWorktreeDuplicates over the WHOLE registry (not one live caller's
// worktree). Groups every registry row by canonical (git-toplevel) mesh identity
// and, for each group with 2+ rows, forwards every non-survivor's real direct
// backlog into the survivor and tombstones the store-only duplicates (leaving
// descriptor-backed ones), via the SHARED foldGroupIntoSurvivor primitive. This
// folds the prior mesh forms an OLD store accumulated — phantom rows, dual/legacy
// pairs, SUBDIR-SPLIT pairs — that the drain-only `reconcile` never dedups.
//   - Idempotent (hash-dedup forward + tombstone-of-absent -> a re-run finds no
//     store-only duplicate left, so retired:[]), fail-open (never throws),
//     non-destructive (forward-before-tombstone; message rows are NEVER deleted).
//   - Orphan partitions / stale-registry rows are DELIBERATELY untouched — they are
//     surface-only by explicit design (computeSummary's no-delete posture); this
//     only collapses same-worktree DUPLICATE registrations.
//   - `ctx.dryRun` classifies without writing (doctor detect()).
// Returns { ok, retired[], forwarded, folded, [left[]], [forwardFailed[]] }.
// GHOST-ROW AGEING (defect 76891c157288, P2).
//
// A "ghost" is a registry row that has NEVER been attended and has not been
// touched in a long time. Every leg is a POSITIVE absence-of-attendance proof
// read off disk, and ALL of them must hold — this is deliberately much stricter
// than foldGroupIntoSurvivor's own unattended test, because unlike that test
// this one runs on a group where NO row looks live and so has no live sibling
// to cross-check against:
//   1. sessionId is null/empty. NOT `unclaimed:<id>` — that is the live
//      Primary's own self-register mint (the FIELD shape this must never touch).
//   2. no workspaces/<id>.json descriptor.
//   3. no heartbeats/<id>.json — nothing has ever reported as this id.
//   4. store cursor 0 AND no cursors/<id>.json read-path ack file: nothing has
//      ever DRAINED this partition (the unforgeable reader-evidence signal
//      foldGroupIntoSurvivor's anchor guard already relies on).
//   5. `updatedAt` older than the age bar. Legs 1-4 can all be true of a row
//      registered SECONDS ago by a spawn that has not launched yet, so the age
//      bar is what separates "never attended" from "not attended YET".
//
// A row whose updatedAt is missing/non-finite is NOT aged out (unknown age is
// not old age). Every read is fail-soft, and every failure resolves to "not a
// ghost" — this function can only ever REFUSE to nominate a row.
const GHOST_ROW_MAX_AGE_H_DEFAULT = 72;
function ghostRowMaxAgeMs(env) {
  const raw = env && env.ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H;
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const hours = Number.isFinite(n) && n > 0 ? n : GHOST_ROW_MAX_AGE_H_DEFAULT;
  return hours * 60 * 60 * 1000;
}
function ghostRegistryRows(s, home, rows, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const maxAgeMs = ghostRowMaxAgeMs(c.env || process.env);
  const out = [];
  for (const d of rows || []) {
    try {
      if (!d || d.id == null) continue;
      const rid = String(d.id);
      if (!isSafeId(rid)) continue;
      // (1) sessionId genuinely absent — never an `unclaimed:` mint
      const sid = d.sessionId != null ? String(d.sessionId) : '';
      if (sid !== '') continue;
      // (2) no descriptor
      if (readDescriptorFile(home, rid)) continue;
      // (3) no heartbeat ever
      let beat = false;
      try { beat = fs.existsSync(heartbeatPathFor(rid, home)); } catch (_) { beat = true; } // unreadable -> assume attended
      if (beat) continue;
      // (4) no reader evidence in EITHER cursor namespace
      let drained = true;
      try { drained = siblingBaseCursor(s, home, rid) > 0; } catch (_) { drained = true; }
      if (drained) continue;
      try { if (fs.existsSync(primaryCursorPath(home, rid))) continue; } catch (_) { continue; }
      // (5) aged past the bar; unknown age is never old age
      const upd = Number(d.updatedAt);
      if (!Number.isFinite(upd) || upd <= 0) continue;
      if ((now - upd) < maxAgeMs) continue;
      out.push(d);
    } catch (_) { /* fail-soft: not a ghost */ }
  }
  return out;
}

function foldMeshDuplicates(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  try {
    // ctx.repoKey (spec item 5c: update-time self-heal across EVERY store, not
    // only the one the caller's cwd happens to resolve to right now) — an
    // explicit override for foldMeshDuplicatesAllStores below to fold a named
    // store directly, bypassing cwd/git resolution entirely. Absent (the
    // default, every pre-existing call site) falls back to the original
    // cwd-derived behavior, byte-identical.
    const repoKey = typeof c.repoKey === 'string' && c.repoKey ? c.repoKey : repoKeyForCwd(c);
    // NEVER open/create the shared store just to look for duplicates. A missing
    // repoKey (non-git cwd) or an absent per-project store dir means there is no
    // registry to fold — return a clean no-op WITHOUT calling openStore (which
    // would create the dir; doctor's repair/--check store-untouched invariant).
    if (!repoKey) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    let storeExists = false;
    try { storeExists = fs.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
    if (!storeExists) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    const s = store.openStore({ home, hash: repoKey, backend: c.backend, env: c.env });
    const retired = [];
    const left = [];
    const forwardFailed = [];
    const pending = [];
    const needsAttention = []; // HAZARD 1 fix: zero-live groups refused (never folded by id-sort)
    let forwarded = 0;
    let folded = 0; // canonical groups that had ≥1 duplicate acted on
    let meshIdCollisions = 0; // meshId buckets spanning ≥2 DISTINCT canonical worktrees
    let rekeyed = 0; // P1b: subdir rows re-keyed to their canonical toplevel worktreePath
    let budgetExhausted = false; // D11-C: ctx.deadline cut this pass off before every group ran
    let skippedGroups = 0; // count of mesh-id groups deferred to the next pass by the deadline
    try {
      // P1b FIRST: re-key any subdir-registered row to its toplevel worktreePath so
      // resolveMeshTarget (send) and the fold agree on ONE identity — including a LONE
      // subdir row the >=2 fold below never touches. Re-key is an in-place registry
      // update (same id/partition), so the fresh listRegistry the fold reads next just
      // sees canonical paths (grouping is by canonicalMeshId either way — unaffected).
      rekeyed = rekeySubdirRegistryRows(s, home, dryRun);
      const byMesh = groupRegistryByMeshId(s.listRegistry(), home);
      const meshGroups = Array.from(byMesh.values());
      for (let gi = 0; gi < meshGroups.length; gi++) {
        const g = meshGroups[gi];
        // BUDGET (D11-C, field-measured: this loop previously ran to full
        // completion regardless of an optional ctx.deadline — set by
        // update.js's throttled sweep; unset for direct/CLI calls, so those
        // see NO behavior change here — unlike healOrphanPartitions'
        // no-descriptor bucket a few functions down, which already honored
        // one). Stop BEFORE starting the NEXT mesh-id group once the deadline
        // has passed — the SAME "stop before an item, never mid-item"
        // contract update.js's own runThrottledSweep enforces. The FIRST
        // group always runs regardless of budget (forward-progress
        // guarantee), matching runThrottledSweep's `i > 0` guard. Groups
        // deferred this way are NOT lost — the next call re-derives the
        // registry fresh from disk and re-groups everything, so a deferred
        // group is simply re-evaluated (and, if still needed, folded) next
        // pass; no tombstone, no persisted skip-list.
        if (gi > 0 && Number.isFinite(c.deadline) && Date.now() >= c.deadline) {
          budgetExhausted = true;
          skippedGroups = meshGroups.length - gi;
          break;
        }
        if (g.rows.length < 2) continue; // fast skip: a lone row cannot have a duplicate
        // COLLISION GUARD (P0): a canonicalMeshId bucket is keyed by an 8-hex sha256
        // slice, which can (astronomically) collide two DISTINCT worktrees onto ONE
        // meshId. Fold ONLY within a real-path-identical sub-group — NEVER
        // merge/forward/tombstone across two distinct worktrees that merely share the
        // 8-hex. Sub-partition by the collision-free canonicalWorktreeRealPath (the
        // SAME comparison retireWorktreeDuplicates uses); an unresolvable path gets its
        // OWN singleton key so it is never merged with anything.
        const bySamePath = new Map(); // canonicalRealPath -> rows[]
        for (const d of g.rows) {
          const real = canonicalWorktreeRealPath(d.worktreePath);
          const key = real || ('\x00unresolved:' + String(d.id));
          let sub = bySamePath.get(key);
          if (!sub) { sub = []; bySamePath.set(key, sub); }
          sub.push(d);
        }
        if (bySamePath.size > 1) {
          meshIdCollisions++;
          try {
            process.stderr.write('[devswarm] foldMeshDuplicates: meshId ' + String(g.meshId)
              + ' bucket spans ' + bySamePath.size + ' DISTINCT canonical worktrees (8-hex hash collision)'
              + ' — folding each in isolation, NEVER across\n');
          } catch (_) {}
        }
        for (const rows of bySamePath.values()) {
          if (rows.length < 2) continue; // no duplicate within this real worktree
          // HAZARD 1 (live data-loss): a ZERO-LIVE group has no live session
          // draining ANY row, so pickFreshestLive's own fallback ("first
          // candidate") degrades to id-sort order — an accident of
          // listRegistry()'s enumeration, not a signal of which row is
          // actually being drained. Forwarding backlog INTO an id-sort
          // "survivor" can move mail OUT of a row a Primary is mid-drain on
          // (its sessionId already went stale/dead between drains) and INTO
          // a row nobody reads — the opposite of this fold's intent, and it
          // makes stranded mail WORSE, not better. Refuse to fold this group
          // at all (no forward, no tombstone) and surface it for operator
          // attention instead — never silently pick by registry order.
          if (!livenessSelect.hasLiveCandidate(rows)) {
            // DEFECT 76891c157288 (P2) — GHOST-ROW AGEING. This refusal is the
            // ROOT CAUSE of the field shape: a `sessionId: null` row sharing the
            // live Primary's worktreePath sits in a group whose ONLY other
            // member is the Primary's own anchor row, and that anchor carries
            // `unclaimed:primary-<hash>`, which isLiveSessionId rejects BY
            // DESIGN (SYNTHETIC_SESSION_PREFIX). So the group has zero "live"
            // rows, this branch refuses it wholesale, and the ghost is immortal
            // — projecting active in every roster and diagnose forever.
            //
            // The refusal itself is right for its own hazard (id-sort survivor
            // selection moving mail into a row nobody reads). It is only wrong
            // for a group where survivorship is NOT a judgement call, so that is
            // the ONLY case carved out here:
            //   * every ghost is provably unattended AND AGED (ghostRegistryRows
            //     — sessionId null/empty, no descriptor, no heartbeat, cursor 0
            //     in BOTH namespaces, no read-path ack file, and untouched for
            //     longer than ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H, default
            //     72 h), and
            //   * exactly ONE non-ghost row remains, so the survivor is forced
            //     by the group's own shape and no ranking is involved.
            // The retirement itself runs through the EXISTING fold path
            // (foldGroupIntoSurvivor's unattended branch): forward-then-tombstone,
            // CAS-guarded, no new deletion primitive and no message ever dropped.
            // Attended anchors are untouched — the FIELD shape (`unclaimed:` +
            // cursor > 0 + descriptor) fails ghostRegistryRows on three separate
            // legs, and foldGroupIntoSurvivor's own anchor guard refuses it again.
            const ghosts = ghostRegistryRows(s, home, rows, c);
            const nonGhosts = rows.filter((d) => !ghosts.some((x) => String(x.id) === String(d.id)));
            if (ghosts.length > 0 && nonGhosts.length === 1) {
              const r = foldGroupIntoSurvivor(s, home, nonGhosts[0].id, ghosts, { dryRun });
              forwarded += r.forwarded;
              for (const x of r.retired) retired.push(x);
              for (const x of r.left) left.push(x);
              for (const x of r.forwardFailed) forwardFailed.push(x);
              for (const x of r.skipped || []) pending.push(x);
              if (r.retired.length || r.left.length || r.forwardFailed.length) folded++;
              continue;
            }
            needsAttention.push({ meshId: g.meshId, ids: rows.map((d) => d.id) });
            continue;
          }
          const survivor = pickSurvivor(s, { rows }, home);
          if (!survivor || survivor.id == null) continue; // nothing live/first to keep -> skip
          const candidates = rows.filter((d) => d && String(d.id) !== String(survivor.id));
          const r = foldGroupIntoSurvivor(s, home, survivor.id, candidates, { dryRun });
          forwarded += r.forwarded;
          for (const x of r.retired) retired.push(x);
          for (const x of r.left) left.push(x);
          for (const x of r.forwardFailed) forwardFailed.push(x);
          for (const x of r.skipped || []) pending.push(x);
          if (r.retired.length || r.left.length || r.forwardFailed.length) folded++;
        }
      }
      // Same forwarded-without-retired gap as retireWorktreeDuplicates above: a fold
      // whose candidates are all descriptor-backed still FORWARDS unread rows, which
      // must be reflected in the projection. (dryRun forwards nothing, so it stays out.)
      if (!dryRun && (retired.length || forwarded)) store.deriveSummary(s, { home, env: c.env });
    } finally { s.close(); }
    // pending (count) + pendingIds: candidates this pass could NOT act on (lock
    // busy, survivor busy/gone). A caller never records the pass clean while > 0.
    const out = { ok: true, retired, forwarded, folded, pending: pending.length };
    if (pending.length) out.pendingIds = pending;
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    if (meshIdCollisions) out.meshIdCollisions = meshIdCollisions;
    if (rekeyed) out.rekeyed = rekeyed;
    if (needsAttention.length) out.needsAttention = needsAttention;
    if (budgetExhausted) { out.budgetExhausted = true; out.skipped = skippedGroups; }
    return out;
  } catch (e) {
    // A5(b): fail-open means "never THROW into update/doctor" — it does NOT
    // mean "report success for a run that raised". A caught exception here
    // previously reported ok:true with an empty retired/forwarded/folded set,
    // indistinguishable from "nothing needed folding". Report the failure;
    // control flow is unchanged (still returns normally, never throws).
    return { ok: false, error: String(e && e.message || e), retired: [], forwarded: 0, folded: 0, pending: 0 };
  }
}

// cmdArchive(id, ctx, opts) — archive a workspace descriptor + tombstone its
// registry row. The WHOLE descriptor+registry mutation runs under the per-id lock
// (P1-4) so a concurrent register/reap for the same id can never interleave.
// opts.revalidate(desc) (P1-5): an optional predicate run INSIDE the critical
// section, immediately before any mutation — return a truthy reason to SKIP the
// archive (used by the reaper to bail out on a workspace that went live between
// candidate collection and the archive call). All-or-nothing (P1-3): the active
// descriptor hardlink is RETAINED until the registry tombstone is durable, then
// the active descriptor is unlinked LAST; any mid-sequence failure ROLLS BACK.
// retireIdentityFamilyDescriptors(home, archivedId, desc) — the DESCRIPTOR-FILE
// half of "archive retires the whole identity family".
//
// ROOT CAUSE this closes (live incident): cmdArchive keys its tombstone as
// `archived/<id>.json` and retires exactly ONE descriptor file. When the SAME
// workspace is registered under TWO descriptor ids — the builder-id UUID row and
// the slug row named in companion/lib/devswarm-identity-family.js's header —
// archiving one of them could never retire the other. The survivor stayed in
// `workspaces/`, `readDescriptors` (companion/devswarm-supervisor.js) kept
// enumerating it (it cross-checks no tombstone), and hooks/devswarm-parent-gate.js
// kept nagging the Primary about a workspace the user had already archived.
//
// SCOPE — DESCRIPTORS ONLY, deliberately. The REGISTRY half already has an owner:
// retireArchivedWorktreeGroup (above), which folds same-worktree registry rows in
// THIS project's store. A twin can legitimately carry a DIFFERENT repoKey (the
// live incident's pair did: `projA-a7a7a5` vs `modules-ba76c8`, a nested module
// worktree), and cmdArchive's own ID-DERIVED AUTHORITY GATE exists precisely to
// refuse cross-project store mutation. So this pass never touches another
// project's store — it retires the descriptor FILE, which is the artifact the
// gate/supervisor actually read, and SURFACES every twin it did not retire.
//
// GROUPING RULE: NOT re-derived here. `identityFamilyTwins`
// (companion/lib/devswarm-identity-family.js) owns it — the same module that owns
// the read-time collapse — so there is exactly ONE identity-grouping rule in the
// tree. It uses the STRONGEST link only (one row's sessionId IS the other row's
// id), never bare worktree equality, so two legitimately-live tabs on one
// worktree are never retired. See that module for the full argument.
//
// NEVER DELETES: a twin's bytes are hardlinked into `archived/` and only THEN is
// the active path unlinked, and the unlink runs ONLY after a fresh lstat of BOTH
// paths proves they are the same inode. If the archived path already holds
// DIFFERENT bytes, nothing is unlinked — the twin is left live and surfaced.
// IDEMPOTENT: a re-run finds no active twin descriptor and does nothing.
// FAIL-OPEN: never throws; a failure here must never break archive itself.
// LOCKING: each twin is taken under its OWN withIdLock. `archivedId` is never
// locked here (cmdArchive already holds it, and the lock is not re-entrant) —
// every twin is != archivedId by identityFamilyTwins' own guard. A lock-busy
// twin is SKIPPED and surfaced, never blocked on.
// `opts.dryRun` classifies WITHOUT writing (doctor's detect()): twins that WOULD
// be retired land in `retired`, nothing is linked, unlinked, or locked.
// `opts.requireWorktreeGone` (P0-3): demand POSITIVE liveness evidence before
// retiring. Used by the MIGRATION path only — see foldArchivedFamilyDescriptors.
function retireIdentityFamilyDescriptors(home, archivedId, desc, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const requireWorktreeGone = !!(opts && opts.requireWorktreeGone);
  const out = { retired: [], left: [] };
  try {
    if (!desc || archivedId == null) return out;
    const idFam = require('../../companion/lib/devswarm-identity-family.js');
    const archiveDirState = checkedArchivedDir(home, { create: true });
    if (!archiveDirState.ok) return out;
    let names = [];
    try { names = fs.readdirSync(workspacesDir(home)); } catch (_) { return out; }
    const candidates = [];
    // SCAN-TIME GENERATION, per candidate id. The classification below is made
    // against THESE bytes/inode; the write below re-proves them INSIDE the lock.
    const scanFp = new Map();
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const cid = n.slice(0, -5);
      if (String(cid) === String(archivedId)) continue;
      if (!isSafeId(cid)) continue;
      let fp;
      try { fp = descriptorFileGeneration(path.join(workspacesDir(home), n)); } catch (_) { continue; }
      if (!fp || !fp.descriptor) continue;
      const d = fp.descriptor;
      // The filename IS the id of record; a descriptor whose body disagrees is
      // malformed and must never be acted on (same identity check cmdArchive
      // applies to its own target).
      if (!isSafeId(d.id) || String(d.id) !== String(cid)) continue;
      candidates.push(d);
      scanFp.set(String(d.id), fp);
    }
    for (const twin of idFam.identityFamilyTwins(desc, candidates)) {
      const tid = String(twin.id);
      // P0-3 SAFETY REFUSAL (migration path only). A one-way historical link read
      // out of a STALE tombstone is NOT write authority: descriptor ids get
      // reused, so `archived/A.json`.sessionId === 'B' may name a B that is today
      // an unrelated, genuinely LIVE workspace. Retire only with positive
      // evidence that this twin is not live — its worktree provably absent.
      // Anything we cannot prove leaves it ACTIVE and SURFACED.
      if (requireWorktreeGone && !worktreeIsProvablyGone(twin.worktreePath)) {
        out.left.push({ id: tid, reason: 'live-or-unprovable-worktree' });
        continue;
      }
      if (dryRun) { out.retired.push(tid); continue; }
      const activePath = descriptorPath(home, tid);
      const archivedPath = path.join(archiveDirState.path, tid + '.json');
      const before = scanFp.get(tid);
      const r = withIdLock(tid, home, () => {
        try {
          // P0-1 RE-PROVE INSIDE THE LOCK. Between the scan above and this lock a
          // concurrent `register`/`ensure`/child-turn may have atomically replaced
          // this pathname with a NEW, LIVE descriptor (rename => new inode). The
          // classification was made against `before`; if what is on disk NOW is a
          // different generation, our authority to retire it does not exist.
          // SAFETY REFUSAL: leave it active, surface it, let a later run decide.
          const now = descriptorFileGeneration(activePath);
          if (!now) return { ok: false, reason: 'descriptor-unreadable-at-retire' };
          if (!sameDescriptorGeneration(before, now)) {
            return { ok: false, reason: 'descriptor-changed-since-scan' };
          }
          try { fs.linkSync(activePath, archivedPath); }
          catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
          const a = fs.lstatSync(activePath);
          const b = fs.lstatSync(archivedPath);
          if (a.dev !== b.dev || a.ino !== b.ino) {
            // A pre-existing tombstone holding DIFFERENT bytes — or the SAME bytes
            // at a DIFFERENT inode, which is equally not ours to clobber. Never
            // overwrite and never unlink — leave the twin live and say so.
            return { ok: false, reason: 'archived-tombstone-differs' };
          }
          // Final re-proof: the inode we are about to unlink must STILL be the
          // generation we classified. (Belt-and-braces under the lock; the lock
          // itself is what makes this authoritative — see devswarm-child-turn.js.)
          if (a.dev !== before.dev || a.ino !== before.ino) {
            return { ok: false, reason: 'descriptor-changed-since-scan' };
          }
          fs.unlinkSync(activePath);
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: 'retire-failed: ' + String((e && e.message) || e) };
        }
      });
      if (r && r.ok) out.retired.push(tid);
      else if (r && r.lockBusy) out.left.push({ id: tid, reason: 'lock-busy' });
      else out.left.push({ id: tid, reason: (r && r.reason) || 'retire-failed' });
    }
    return out;
  } catch (_) { return out; }
}

// restoreArchivedDescriptor(home, id, ctx, opts) -> { ok, error?, restoredLink? }
// THE restore step, shared by cmdUnarchive and retireStaleArchivedMarkers (the
// supervisor's "trust the app" path), so the two can never drift. The caller
// holds withIdLock(id) (the lock is not re-entrant). Steps, all-or-nothing:
//   1. put the descriptor back in workspaces/: hardlink archived/<id>.json there
//      (linkSync fails closed on EEXIST instead of renameSync's silent
//      overwrite) when it is missing;
//   2. persist the physical ownerKey (and drop marker-only archivedBy /
//      archivedAt fields) with an atomic tmp+rename — a new inode, so the
//      archived bytes are never rewritten;
//   3. revive the registry row: a fresh upsertRegistry after a prior
//      removeRegistry wins as the newest op (latest-op-wins, the same mechanics
//      cmdArchive relies on).
// opts.requireOwnerKey (cmdUnarchive): the descriptor's physical ownerKey must
//   equal it (the caller's project) or nothing happens.
// opts.keepMarker (retire): archived/<id>.json is left in place — the caller
//   moves it to archived-retired/ only after this returns ok. An existing
//   workspaces/<id>.json (a separate inode: an app-sourced marker is a copy) is
//   the live truth and is kept. A registry row that is already live is left
//   as is. Success = the row is verifiably live; on failure a link this call
//   created is dropped, so the marker is the only state and nothing is orphaned.
// Default (cmdUnarchive): archived/<id>.json is unlinked once the workspaces/
// link is verified (same inode) — a move, never a delete of the bytes.
const ARCHIVE_MARKER_ONLY_FIELDS = ['archivedBy', 'archivedAt'];
function restoreArchivedDescriptor(home, id, ctx, opts) {
  const o = opts || {};
  const fail = (error) => ({ ok: false, error });
  const archiveDirState = checkedArchivedDir(home);
  if (!archiveDirState.ok) return fail('unsafe archived directory: ' + archiveDirState.error);
  const archivedPath = path.join(archiveDirState.path, id + '.json');
  const activePath = descriptorPath(home, id);
  const archivedState = readDescriptorPathState(archivedPath);
  if (archivedState.error) return fail('failed to read archived descriptor: ' + archivedState.error);
  const activeState = (archivedState.exists && !o.keepMarker) ? null : readDescriptorPathState(activePath);
  if (activeState && activeState.error) return fail('failed to read restored descriptor: ' + activeState.error);
  if (!archivedState.exists && (!activeState || !activeState.exists)) {
    return fail('no archived descriptor for workspace ' + JSON.stringify(id));
  }
  if (o.keepMarker && !archivedState.exists) return fail('no archived marker for workspace ' + JSON.stringify(id));
  const activeLive = !!(activeState && activeState.exists);
  const desc = (o.keepMarker && activeLive) ? activeState.descriptor
    : (archivedState.exists ? archivedState.descriptor : activeState.descriptor);
  if (!isSafeId(desc.id) || String(desc.id) !== String(id) || !desc.worktreePath) {
    return fail('archived descriptor identity does not match workspace ' + JSON.stringify(id));
  }
  const ownerKey = descriptorPhysicalOwnerKey(desc);
  if (!ownerKey || (o.requireOwnerKey !== undefined && ownerKey !== o.requireOwnerKey)) {
    return fail(o.requireOwnerKey !== undefined ? 'archived descriptor does not belong to the current project'
      : 'archived descriptor has no ownerKey and no derivable repo key');
  }
  let createdLink = false;
  const dropCreatedLink = () => { if (createdLink) { try { fs.unlinkSync(activePath); } catch (_) {} } };
  if (archivedState.exists && !(o.keepMarker && activeLive)) {
    try {
      fs.mkdirSync(workspacesDir(home), { recursive: true });
      try { fs.linkSync(archivedPath, activePath); createdLink = true; }
      catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      const archivedStat = fs.lstatSync(archivedPath);
      const activeStat = fs.lstatSync(activePath);
      if (archivedStat.dev !== activeStat.dev || archivedStat.ino !== activeStat.ino) {
        return fail('active descriptor already exists and is not the archived recovery anchor');
      }
      if (!o.keepMarker) {
        try { fs.unlinkSync(archivedPath); }
        catch (e) {
          try { fs.unlinkSync(activePath); } catch (_) {}
          return fail('failed to move descriptor out of archived/: ' + String(e && e.message || e));
        }
      }
    } catch (e) {
      dropCreatedLink();
      return fail('failed to prepare descriptor restore: ' + String(e && e.message || e));
    }
  }
  const markerOnly = ARCHIVE_MARKER_ONLY_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(desc, k));
  if (desc.ownerKey !== ownerKey || (markerOnly.length && !(o.keepMarker && activeLive))) {
    desc.ownerKey = ownerKey;
    for (const k of markerOnly) delete desc[k];
    try { writeDescriptorAtomic(home, id, desc); }
    catch (e) {
      dropCreatedLink();
      return fail('failed to persist descriptor store ownership: ' + String(e && e.message || e));
    }
  }
  if (o.keepMarker && registryRowPresent(home, id, ownerKey, ctx)) return { ok: true, restoredLink: createdLink };
  let reviveError = null;
  try {
    const s = store.openStore({ home, workspaceId: desc.id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
    try {
      s.upsertRegistry(desc);
      store.deriveSummary(s, { home, env: ctx.env });
    } finally { s.close(); }
  }
  catch (e) { reviveError = e; }
  if (!o.keepMarker) {
    if (reviveError) return fail('failed to revive registry: ' + String(reviveError && reviveError.message || reviveError));
    return { ok: true, restoredLink: createdLink };
  }
  // keepMarker: the proof is a live row (a summary write that failed after the
  // upsert landed is re-derived on the next write).
  if (!registryRowPresent(home, id, ownerKey, ctx)) {
    dropCreatedLink();
    return fail('failed to revive registry: ' + (reviveError ? String(reviveError.message || reviveError) : 'row not live after upsert'));
  }
  return { ok: true, restoredLink: createdLink };
}

module.exports = {
  MESH_ROW_COPY_FIELDS, meshRowCopy, ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT, archiveForwardMaxAgeMs,
  archivedForwardProvenancePrefix, ARCHIVED_FORWARD_PREFIX_RE, stripArchivedForwardPrefix,
  forwardedOrigHashOf, logicalDeliveryKey, CONSUMED_HASH_SEED_CAP, consumedDedupSeed,
  forwardArchivedOrphanUnread, rehomeAcrossStores, rehomeCore, rehomeMiskeyedRow, healRegistry,
  maybeRehomeToCwdProject, isForwardable, foldSiblingGapRows, retireWorktreeDuplicates,
  foldGroupIntoSurvivor, pickArchiveForwardSurvivor, archiveLeftReason,
  retireArchivedWorktreeGroup, rekeySubdirRegistryRows, GHOST_ROW_MAX_AGE_H_DEFAULT,
  ghostRowMaxAgeMs, ghostRegistryRows, foldMeshDuplicates, retireIdentityFamilyDescriptors,
  ARCHIVE_MARKER_ONLY_FIELDS, restoreArchivedDescriptor,
};
