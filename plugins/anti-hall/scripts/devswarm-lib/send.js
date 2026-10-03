'use strict';
// anti-hall :: devswarm CLI — SEND module (scripts/devswarm-lib/send.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  ALLOWED_URGENCY, CALLER_CWD, devswarmRoot, dispatcherExports, fs, hasFlag, identity,
  identityContext, inst, livenessSelect, logVerbOutcome, one, path, planLib, readDescriptorFile,
  readRetiredRedirect, repokey, store, withIdLock,
} = require('./core.js');
const {
  canonicalMeshId, isRoutingLiveRowStrict, projectCwdFor, rawPathMeshId, registrySnapshot,
  senderIdentityDetailed, SYNTHETIC_SESSION_PREFIX,
} = require('./identity.js');
const {
  readReadReceipt,
} = require('./cursors.js');
const {
  maybeRehomeToCwdProject,
} = require('./fold.js');
const {
  withSelfHeal,
} = require('./register.js');

// ---- Meeseeks supervision: plan tracking (P1) ------------------------------
// planRefFor(home, id, ctx) -> { id, worktreePath }. The plan file is keyed by
// the workspace's worktree (see companion/lib/devswarm-plan.js). The worktree
// comes from the workspace's descriptor, or — only when the caller IS that
// workspace (DEVSWARM_BUILDER_ID matches) — from the caller's own cwd. A
// Primary naming a child with no descriptor falls back to the bare id, never
// to the Primary's own worktree.
function planRefFor(home, id, ctx) {
  let worktreePath = null;
  try {
    const d = readDescriptorFile(home, id);
    if (d && d.worktreePath) worktreePath = d.worktreePath;
  } catch (_) { worktreePath = null; }
  if (!worktreePath && (ctx.env || process.env).DEVSWARM_BUILDER_ID === id) {
    try { worktreePath = identityContext(ctx.cwd || process.cwd(), CALLER_CWD).worktreeRoot || null; } catch (_) { worktreePath = null; }
  }
  return { id, worktreePath };
}

// resolveMeshTarget(storeHandle, meshId) -> the registry descriptor whose
// worktree-derived meshId matches `meshId`, or null (fail-closed, D12a).
//
// meshId is NEVER stored as a schema field (Blast-radius note, D19): it is
// recomputed on every lookup from each registry entry's `worktreePath` via the
// SAME hardened primitive `callerIdentity` uses for a resolved worktree
// (`inst.primaryWorkspaceId`) — so a sender and the address book derive a given
// worktree's meshId IDENTICALLY, and the address book can never be env-spoofed
// (it is derived from the REGISTERED worktree path, never from any caller's
// env). This is the D19 join: `--to <meshId>` resolves to the target's real
// read partition (`d.id`, the builder-id), NOT the meshId itself.
// meshCandidateRows(storeHandle, meshId) -> registry rows whose CANONICAL
// (git-toplevel-resolved) meshId matches `meshId`.
//
// TRACED P0 DEFECT B fix: this used to match on the RAW stored worktreePath
// hash (`inst.primaryWorkspaceId(d.worktreePath)`), while `diagnose` groups
// via `canonicalMeshId` (git-toplevel-resolved, `groupRegistryByMeshId`
// above). A subdir-registered row's raw-path hash differs from its
// toplevel's canonical meshId, so it was inside diagnose's group but NOT a
// send candidate for that same meshId — `send` and `diagnose` disagreed
// about group membership for the exact same row.
//
// Fix chosen: unify HERE, on canonicalMeshId, rather than mutating the
// registry via `rekeySubdirRegistryRows` on the send path. `meshId` values
// callers actually pass to `--to` come from `roster`/`diagnose` output,
// which are ALREADY canonical (both key off `groupRegistryByMeshId` /
// `canonicalMeshId`) — so comparing each row's canonical meshId against that
// argument is the correct, already-intended join, and it is a PURE
// per-call computation: no registry write, no lock, no risk of a lost-update
// race with a concurrent register/heartbeat/rehome (rekeySubdirRegistryRows
// explicitly documents that hazard for its own in-place write path). The
// data-repair alternative (running rekeySubdirRegistryRows here) was
// rejected: it would require taking a per-id lock and performing a registry
// write on every `send` for a case that is purely a read-side identity
// mismatch, and it already runs independently via foldMeshDuplicates (doctor
// repair / reconcile), which self-heals stored subdir rows over time — this
// fix does not depend on that repair having already run.
//
// B2 (decision 5): a row whose worktree no longer exists has no canonical meshId;
// it still answers to its OWN raw-path meshId (the address it registered under),
// exactly as before — an exact-address lookup, never a walk-up onto an enclosing
// repo, so mail to it still lands in its own partition instead of failing closed.
function meshCandidateRows(storeHandle, meshId) {
  const candidates = [];
  if (!meshId) return candidates;
  for (const d of storeHandle.listRegistry()) {
    if (!d || !d.worktreePath) continue;
    let canon = null;
    try { canon = canonicalMeshId(d.worktreePath); } catch (_) { canon = null; }
    if (!canon) canon = rawPathMeshId(d.worktreePath);
    if (canon !== String(meshId)) continue;
    candidates.push(d);
  }
  return candidates;
}

function resolveMeshTarget(storeHandle, meshId, home) {
  if (!meshId) return null;
  // A single worktreePath can carry MORE THAN ONE registry row that ALL resolve to
  // the same meshId. Concretely observed: the `spawn` phantom (keyed BY the meshId,
  // `sessionId:null`, no live session draining it) AND the child's own self-
  // registration (keyed by its builder-id, a real `sessionId`); and — the P0 case
  // this fix closes — TWO *live* builder-id rows for one worktree (a child that re-
  // registered under a NEW builder-id while an older builder-id row is still live,
  // OR a same-worktree duplicate the retire reconcile deliberately LEFT rather than
  // risk mis-tombstoning a distinct child, P1). listRegistry orders by id-sort, so a
  // bare "first live by id-ASC" is an id-ordering ACCIDENT: it can hand the send to a
  // STRANDED row that no live session drains -> silent message loss (verified repro,
  // both backends).
  //
  // ROUTE TO THE PARTITION THE CHILD ACTUALLY DRAINS, independent of retire timing/
  // success. Matching by worktree-derived meshId stays local (needs `inst`); the
  // actual freshest-LIVE selection is delegated to devswarm-liveness-select.js's
  // pickFreshestLive — the SAME evidence-based ranking (session-reference integrity,
  // drain activity, session-authored heartbeat, THEN updatedAt/cursor recency) also
  // used by pickSurvivor and devswarm-store.js's resolveSenderRegistryId (P0-A: a
  // plain recency window can NEVER exclude a dead row whose updatedAt is kept fresh
  // by an unrelated `heartbeat` caller — see that module's header for the field
  // evidence). `home` is optional (enables the heartbeat-credit signal only; every
  // other signal works without it).
  //
  // D11-A (f56dcc08f048): the LIVE-candidate gate pickFreshestLive applies is now
  // isRoutingLiveRowStrict (via opts.isLive), not the bare isLiveSessionId shape
  // test — see that function's header (the STRICT, no-descriptor-fallback
  // variant: a dead store-only row's lingering descriptor must never win a
  // `send` target). devswarm-store.js's resolveSenderRegistryId does NOT pass
  // opts.isLive, so it keeps pickFreshestLive's own default (bare
  // isLiveSessionId) unchanged — this migration is scoped to send/fold routing
  // only, per the header comment above SYNTHETIC_SESSION_PREFIX.
  const candidates = meshCandidateRows(storeHandle, meshId);
  return livenessSelect.pickFreshestLive(candidates, {
    storeHandle, home,
    isLive: (row) => isRoutingLiveRowStrict(row, home),
  });
}

// resolveMeshPartitionIds(storeHandle, id, worktreePath) ->
//   { meshPartitionIds, meshUnionActive, meshGroupUnresolved, meshGroupError }
//
// THE single authority for "which store partitions belong to this workspace
// id" — the question underlying defect 27cd80902435 (two registry rows share
// one meshId; 372 real messages sat unread in the row nothing read). Wraps
// canonicalMeshId + meshCandidateRows verbatim — the SAME grouping primitive
// `send --to-primary` (resolveMeshTarget, above) and `diagnose` (meshTargets)
// already use, so send/diagnose/every inbox read verb agree on ONE group,
// never a second, drifting definition.
//
// Extracted from cmdInboxMessages's own inline mesh-widening block (the
// v0.82.0/14c73f9 fix for read-primary/peek-primary/--ack) so
// `count`/`read`/`ack`/plain `messages` (this defect's remaining gap) can
// reuse the identical resolution instead of a parallel implementation.
//
// Fail-open by construction: `worktreePath` falsy, no meshId, a single-row
// group, or `id` itself missing from its own resolved group all leave
// meshPartitionIds at just [String(id)] (meshUnionActive:false) — the
// pre-fix single-partition behavior. A THROWN resolution (corrupt registry
// row, canonicalMeshId throw, etc — P1b) narrows the SAME way but is
// reported via meshGroupUnresolved/meshGroupError so a caller can tell
// "resolved cleanly, no siblings exist" apart from "enumeration itself
// failed, this read may be partial" — never silently indistinguishable.
function resolveMeshPartitionIds(storeHandle, id, worktreePath) {
  let meshPartitionIds = [String(id)];
  let meshUnionActive = false;
  let meshGroupUnresolved = false;
  let meshGroupError = null;
  try {
    const meshId = worktreePath ? canonicalMeshId(worktreePath) : null;
    if (meshId) {
      const candidates = meshCandidateRows(storeHandle, meshId);
      const ids = Array.from(new Set((candidates || []).map((r) => String(r.id))));
      if (ids.length > 1 && ids.indexOf(String(id)) !== -1) {
        meshPartitionIds = ids;
        meshUnionActive = true;
      }
    }
  } catch (e) {
    meshPartitionIds = [String(id)];
    meshUnionActive = false;
    meshGroupUnresolved = true;
    meshGroupError = String((e && e.message) || e);
  }
  return { meshPartitionIds, meshUnionActive, meshGroupUnresolved, meshGroupError };
}

// canonicalReceiptId(storeHandle, id, worktreePath) -> string. THE identity/
// alias-family resolution read receipts (writeReadReceipt/readReadReceipt,
// far above) use to pick a directory that any alias in the family can find —
// reuses resolveMeshPartitionIds verbatim (the SAME grouping `meshPartitionIds`
// already applies to reads/sends/diagnose) rather than a second, drifting
// definition. Deterministic: the lowest sorted id in the resolved family
// wins, independent of which alias asked (both aliases resolve the SAME
// worktree -> the SAME candidate set -> the SAME sorted-first winner).
// Falls back to the bare `id` whenever the family can't be resolved
// (single-row group, no worktree, resolution error) — byte-identical to
// pre-fix behavior for a non-aliased id.
function canonicalReceiptId(storeHandle, id, worktreePath) {
  try {
    const resolved = resolveMeshPartitionIds(storeHandle, id, worktreePath);
    if (resolved.meshUnionActive && Array.isArray(resolved.meshPartitionIds) && resolved.meshPartitionIds.length > 1) {
      return resolved.meshPartitionIds.slice().sort()[0];
    }
  } catch (_) { /* fail open to the literal id below */ }
  return String(id);
}

// staleTwinSuccessor(storeHandle, row, home) -> { row, reason } | null. #6
// session-coherence routing. `row` is STALE when it is not strictly live, or
// when the Phase 2 identity predicate proves its sessionId belongs to a live
// session running in a DIFFERENT worktree (identity.sessionWorktreeCoherent
// === false — the twin shape: a row carrying another live row's session). A
// successor is another registry row with the SAME real sessionId that is
// strictly live and not itself incoherent; pickFreshestLive breaks ties.
// null (deliver to `row` as addressed) whenever that proof is missing —
// unknown coherence, no successor, synthetic/absent sessionId, any throw.
function staleTwinSuccessor(storeHandle, row, home) {
  try {
    const sid = row && row.sessionId != null ? String(row.sessionId) : '';
    if (!sid || sid.startsWith(SYNTHETIC_SESSION_PREFIX) || sid === String(row.id)) return null;
    const coherence = (r) => {
      try { return identity.sessionWorktreeCoherent(sid, r.worktreePath, { home }).coherent; } catch (_) { return null; }
    };
    const rowLive = isRoutingLiveRowStrict(row, home);
    const rowCoherent = row.worktreePath ? coherence(row) : null;
    if (rowLive && rowCoherent !== false) return null;
    const others = storeHandle.listRegistry().filter((d) => d && d.id != null
      && String(d.id) !== String(row.id)
      && d.sessionId != null && String(d.sessionId) === sid
      && isRoutingLiveRowStrict(d, home)
      && !!d.worktreePath && coherence(d) === true); // positive proof only (review P1)
    if (!others.length) return null;
    const pick = others.length === 1 ? others[0] : livenessSelect.pickFreshestLive(others, {
      storeHandle, home, isLive: (r) => isRoutingLiveRowStrict(r, home),
    });
    if (!pick) return null;
    return { row: pick, reason: rowLive ? 'session-worktree-incoherent' : 'addressed-row-not-live' };
  } catch (_) { return null; }
}

// resolveSendTarget(storeHandle, arg) -> { target, ambiguous, candidates }.
//
// `send --to <arg>` addressing footgun (P0 fix): resolveMeshTarget ONLY matches
// `arg` against each row's WORKTREE-DERIVED meshId — but `roster` (below)
// surfaced each row's own `id` (its REAL read partition, the value cmdSend
// actually delivers into) and never its meshId (only `diagnose` showed that).
// A human/agent that copies a roster `id` into `--to` therefore failed closed
// as `unregistered-recipient` even though the workspace IS registered.
//
// Fix: when the EXISTING meshId pass finds nothing, fall back to an EXACT
// match against each row's own `id` — the row IS the partition (`target.id`
// is exactly what cmdSend delivers into today), so an id match resolves
// directly to it with zero ambiguity about WHICH partition receives the
// message. `id` is the registry's PRIMARY KEY (devswarm-store.js: `id TEXT
// PRIMARY KEY`) — one row per id, enforced by the store itself — so this can
// never actually be ambiguous within a single store's listRegistry(); the
// ambiguity guard below is defense-in-depth only (a corrupted/duplicated
// registry read must fail loud with a clear reason, never silently pick one
// candidate over another).
//
// The pre-existing meshId path is computed FIRST and a caller already
// addressing by meshId with no distinct exact-id row sees identical behavior
// to before this fix. SHADOW GUARD (P0): an exact-id match is no longer
// returned unconditionally without checking the meshId pass — if BOTH resolve
// and they name DIFFERENT rows, that is a genuine collision (row A's real id
// equals row B's derived meshId) and must fail loud as ambiguous rather than
// silently preferring the meshId match and shadowing the exact-id row.
function resolveSendTarget(storeHandle, arg, home, opts) {
  const byMesh = resolveMeshTarget(storeHandle, arg, home);
  if (!arg) return byMesh ? { target: byMesh, ambiguous: false, candidates: null } : { target: null, ambiguous: false, candidates: null };
  const idMatches = [];
  for (const d of storeHandle.listRegistry()) {
    if (d && d.id != null && String(d.id) === String(arg)) idMatches.push(d);
  }
  // EXACT-ID-vs-MESH-ID SHADOW GUARD (P0 fix): an unambiguous exact `id` match
  // must never be silently shadowed by a DIFFERENT row's derived meshId — e.g.
  // row A has id:"foo" and row B's worktreePath derives meshId:"foo". Only
  // short-circuit on byMesh when it is not itself already an idMatches
  // candidate under a different identity than a genuine exact-id match.
  if (idMatches.length === 1) {
    // Compare by `id` (the registry primary key), not object reference —
    // resolveMeshTarget and this loop both re-read storeHandle.listRegistry()
    // independently, so the SAME underlying row can come back as two distinct
    // object instances.
    const sameRow = byMesh && String(byMesh.id) === String(idMatches[0].id);
    // A phantom/live PAIR for the SAME worktree (byMesh preferring the live
    // row over a phantom whose id happens to equal the queried meshId) is
    // NOT a collision — resolveMeshTarget already deliberately picks the live
    // row for exactly this case, and idMatches[0] (the phantom) is itself one
    // of the candidates that pass belonged to that same worktree group. Only
    // treat this as a genuine collision when idMatches[0] belongs to a
    // DIFFERENT worktree than the one `arg` (as a meshId) actually derives
    // to — i.e. its own worktree's derived meshId does not even match `arg`.
    let ownMeshId = null;
    // canonicalMeshId (not the raw-path inst.primaryWorkspaceId) — kept consistent
    // with resolveMeshTarget/meshCandidateRows' matching so this shadow-guard
    // check agrees with the same identity byMesh was just derived from.
    try { ownMeshId = idMatches[0].worktreePath ? canonicalMeshId(idMatches[0].worktreePath) : null; } catch (_) { ownMeshId = null; }
    const sameWorktreeGroup = ownMeshId != null && String(ownMeshId) === String(arg);
    if (byMesh && !sameRow && !sameWorktreeGroup) {
      return { target: null, ambiguous: true, candidates: [idMatches[0].id, byMesh.id] };
    }
    if (byMesh && sameWorktreeGroup && !sameRow) return { target: byMesh, ambiguous: false, candidates: null };
    // #6 (Phase 5 routing): the exact-id branch had no liveness/coherence
    // check, so `send --to <staleTwinId>` landed in a partition nobody drains.
    // Reroute ONLY to a provable same-session successor; otherwise deliver to
    // the exact id as before (never drop).
    // Send-only (opts.rerouteStaleTwin): a READ of a twin id must still read
    // that twin's own partition.
    const successor = (opts && opts.rerouteStaleTwin) ? staleTwinSuccessor(storeHandle, idMatches[0], home) : null;
    if (successor) {
      return {
        target: successor.row, ambiguous: false, candidates: null,
        rerouted: true, reroutedFrom: String(idMatches[0].id), rerouteReason: successor.reason,
      };
    }
    return { target: idMatches[0], ambiguous: false, candidates: null };
  }
  if (idMatches.length > 1) {
    return { target: null, ambiguous: true, candidates: idMatches.map((d) => d.id) };
  }
  if (byMesh) return { target: byMesh, ambiguous: false, candidates: null };
  // 73303d4c098b fix: `arg` matched no live mesh id and no live registry row —
  // before failing closed as unregistered-recipient, follow ONE hop through a
  // fold-time retired-redirect (see writeRetiredRedirect's header comment). A
  // single hop only (no loop): a survivor that was ITSELF later retired is not
  // chased further here — that would need this same one-hop check re-run on
  // the survivor id, and a caller getting `unregistered-recipient` on a
  // twice-folded id can simply retry with the fresh id `roster` reports. The
  // resolved survivor is looked up directly against the registry (not by
  // recursing into resolveSendTarget), so this can never loop even on a
  // corrupt/cyclic redirect file.
  if (arg) {
    const redirectedTo = readRetiredRedirect(home, arg);
    if (redirectedTo) {
      for (const d of storeHandle.listRegistry()) {
        if (d && d.id != null && String(d.id) === String(redirectedTo)) {
          return { target: d, ambiguous: false, candidates: null, redirected: true, redirectedFrom: String(arg) };
        }
      }
    }
  }
  return { target: null, ambiguous: false, candidates: null };
}

// cmdRelay(seqOrReceipt, flags, ctx) — relay <seq|receipt> --to <id> [--note-file f]
// Forwards a message THIS caller already received (in its OWN inbox
// partition, i.e. addressed to its own registered id) to `--to`, VERBATIM,
// prefixed with a provenance header ("relayed from X, seq N, M bytes"). Peer
// request (downstream-project Primaries): a Primary receiving mail meant to be
// forwarded to a sibling/child had no verb for it — copy/pasting a body by
// hand into a fresh `send` risks a silent partial-paste, which is exactly
// what this verb's own byte-length verification below guards against.
//
// `<seq>` is the message's own `storeSeq` (the `seq` field `inbox messages`/
// `read-primary` prints per row) inside the CALLER's own partition — never a
// cross-workspace seq, since a caller can only relay mail it was actually
// the addressee of. `<receipt>` is a `read-primary` readReceiptId (`r...`);
// it resolves ONLY when it covers EXACTLY ONE message (a receipt can span
// several) — otherwise this refuses ambiguous rather than guessing which one
// to relay, and points the caller at the exact `<seq>` instead.
//
// SAFETY: refuses (ok:false) on an empty source body, and after sending,
// recomputes the expected byte length (header + body + optional note) and
// compares it against the underlying `send`'s own echoed `bytes` — any
// mismatch fails loud rather than silently forwarding a truncated body.
function cmdRelay(seqOrReceipt, flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, action: 'relay', reason: 'no-project', error: 'relay requires running inside a registered devswarm project' };
  const toFlag = one(flags, 'to');
  if (!toFlag) return { ok: false, action: 'relay', error: 'relay requires --to <id>' };
  if (!seqOrReceipt) return { ok: false, action: 'relay', error: 'relay requires a <seq> or <receipt> identifying the message to forward' };
  const noteFileFlag = one(flags, 'note-file');
  let note;
  if (noteFileFlag !== undefined) {
    try { note = fs.readFileSync(noteFileFlag, 'utf8'); }
    catch (e) { return { ok: false, action: 'relay', error: 'relay --note-file ' + JSON.stringify(noteFileFlag) + ' could not be read: ' + String(e && e.message || e) }; }
  }
  const fromDetailed = senderIdentityDetailed(ctx.env, cwd, registrySnapshot(ctx, repoKey), home);
  const callerId = fromDetailed.identity;

  const isReceipt = /^r[a-z0-9]+$/i.test(String(seqOrReceipt));
  let seq = null;
  let sourceHash = null;
  if (isReceipt) {
    const found = readReadReceipt(home, callerId, String(seqOrReceipt));
    if (!found) {
      return { ok: false, action: 'relay', reason: 'unknown-receipt', error: 'no read receipt ' + JSON.stringify(seqOrReceipt) + ' for ' + JSON.stringify(callerId) + ' — re-run `inbox read-primary ' + callerId + '`' };
    }
    const hashes = (Array.isArray(found.rec.hashes) ? found.rec.hashes : []).filter(Boolean);
    if (hashes.length !== 1) {
      return {
        ok: false, action: 'relay', reason: 'ambiguous-receipt',
        error: 'receipt ' + JSON.stringify(seqOrReceipt) + ' covers ' + hashes.length + ' message(s) — relay needs '
          + 'exactly one; pass the exact <seq> instead (see `inbox messages ' + callerId + '`)',
        count: hashes.length,
      };
    }
    sourceHash = hashes[0];
  } else {
    const n = Number(seqOrReceipt);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, action: 'relay', error: 'relay requires a non-negative integer <seq> or a read receipt id (r...), got ' + JSON.stringify(String(seqOrReceipt)) };
    }
    seq = Math.floor(n);
  }

  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let row;
  try {
    const rows = (typeof s.listMessages === 'function' ? s.listMessages(callerId) : []) || [];
    row = sourceHash ? rows.find((r) => r && r.hash === sourceHash) : rows.find((r) => r && Number(r.storeSeq) === seq);
  } finally { s.close(); }
  if (!row) {
    return {
      ok: false, action: 'relay', reason: 'message-not-found',
      error: 'no message ' + (sourceHash ? 'for receipt ' + JSON.stringify(seqOrReceipt) : 'at seq ' + seq)
        + ' in ' + JSON.stringify(callerId) + "'s own inbox",
    };
  }
  const body = row.body != null ? String(row.body) : '';
  const sourceBytes = Buffer.byteLength(body, 'utf8');
  if (!body || sourceBytes === 0) {
    return { ok: false, action: 'relay', reason: 'empty-body', error: 'source message (seq ' + row.storeSeq + ') has an empty body — refusing to relay nothing' };
  }
  const header = 'relayed from ' + row.sender + ', seq ' + row.storeSeq + ', ' + sourceBytes + ' bytes\n\n';
  const noteSuffix = note ? ('\n\n---\n' + note) : '';
  const relayedMessage = header + body + noteSuffix;
  const expectedBytes = Buffer.byteLength(header, 'utf8') + sourceBytes + Buffer.byteLength(noteSuffix, 'utf8');

  const sendFlags = { to: [toFlag], message: [relayedMessage] };
  const sendRes = cmdSend(sendFlags, ctx);
  const out = {
    ok: !!(sendRes && sendRes.ok), action: 'relay', from: callerId, to: toFlag,
    seq: row.storeSeq, sourceBytes, relayedBytes: (sendRes && sendRes.bytes), expectedBytes,
    receiptId: isReceipt ? String(seqOrReceipt) : undefined,
    send: sendRes,
  };
  if (!sendRes || !sendRes.ok) {
    out.ok = false;
    out.reason = out.reason || (sendRes && sendRes.reason) || 'relay-send-failed';
    out.error = 'relay send failed: ' + String((sendRes && sendRes.error) || 'unknown send failure');
    return out;
  }
  if (sendRes.bytes !== expectedBytes) {
    return Object.assign(out, {
      ok: false, reason: 'byte-length-mismatch',
      error: 'relayed byte length (' + sendRes.bytes + ') does not match the expected length (' + expectedBytes
        + ' = header + ' + sourceBytes + ' source bytes + note) — refusing to report a silent partial relay',
    });
  }
  return out;
}

// cmdSend(flags, ctx) — send --from <id> --to <meshId>|--broadcast --message
// TEXT [--urgency low|normal|high|urgent]. Opens store/<repoKey>/ directly.
//
// ORDERING PIN (D28/Fable P2): repoKey is resolved from cwd FIRST — a null
// repoKey (non-git cwd) returns {ok:false,reason:'no-project'} BEFORE any
// identity derivation, so a spoofed DEVSWARM_BUILDER_ID on a non-git cwd can
// NEVER emit an env-derived `from` (callerIdentity is never even reached on
// that path — `no-project` is returned first, unconditionally).
// cmdSendMulti(recipients, flags, ctx) (0.112) — `send --to <id1>,<id2>[,…]`
// (or a repeated --to). Sends the SAME body to each deduped recipient through
// the ordinary single-recipient cmdSend (so addressing, spoof checks, readback
// verification and self-heal are identical), NEVER stopping on a partial
// failure: every recipient is attempted and reported. ok is true only when
// EVERY recipient succeeded (the verb exits non-zero otherwise). The body is
// resolved ONCE up front — a --message-stdin pipe can only be read once, and a
// --message-file is read once so every recipient gets identical bytes.
// --broadcast / --to-primary / --cc-primary do not combine with a recipient
// list (refused before anything is sent).
function cmdSendMulti(recipients, flags, ctx) {
  if (hasFlag(flags, 'broadcast') || one(flags, 'type') === 'broadcast' || hasFlag(flags, 'to-primary')) {
    return { ok: false, action: 'send', error: 'send with several --to recipients cannot be combined with --broadcast or --to-primary' };
  }
  if (hasFlag(flags, 'cc-primary')) {
    return { ok: false, action: 'send', error: 'send with several --to recipients does not support --cc-primary (it would copy the Primary once per recipient); add the Primary to the --to list instead' };
  }
  let sendCtx = ctx;
  let perFlags = flags;
  const fileFlag = one(flags, 'message-file');
  const sourceCount = (one(flags, 'message') !== undefined ? 1 : 0) + (fileFlag !== undefined ? 1 : 0) + (hasFlag(flags, 'message-stdin') ? 1 : 0);
  if (sourceCount === 1 && (fileFlag !== undefined || hasFlag(flags, 'message-stdin')) && !(ctx.io && typeof ctx.io.stdin === 'string')) {
    let body;
    try { body = fileFlag !== undefined ? fs.readFileSync(fileFlag, 'utf8') : fs.readFileSync(0, 'utf8'); }
    catch (e) {
      return { ok: false, action: 'send', error: 'send ' + (fileFlag !== undefined ? '--message-file ' + JSON.stringify(fileFlag) : '--message-stdin') + ' could not be read: ' + String((e && e.message) || e) };
    }
    sendCtx = Object.assign({}, ctx, { io: Object.assign({}, ctx.io, { stdin: body }) });
    perFlags = Object.assign({}, flags, { 'message-stdin': [true] });
    delete perFlags['message-file'];
  }
  const results = [];
  for (const to of recipients) {
    let r;
    try {
      r = withSelfHeal(() => cmdSend(Object.assign({}, perFlags, { to: [to] }), sendCtx), sendCtx);
    } catch (e) {
      r = { ok: false, error: 'send threw: ' + String((e && e.message) || e) };
    }
    try { logVerbOutcome('send', to, r, sendCtx); } catch (_) { /* logging never breaks the verb */ }
    const row = { to, ok: !!(r && r.ok), seq: r && r.seq, bytes: r && r.bytes };
    if (r && r.toId !== undefined) row.toId = r.toId;
    if (!row.ok) { row.error = (r && (r.error || r.reason)) || 'send failed'; if (r && r.reason) row.reason = r.reason; }
    results.push(row);
  }
  const failed = results.filter((x) => !x.ok).length;
  return {
    ok: failed === 0, action: 'send', type: 'multi',
    recipients: results, sent: results.length - failed, failed,
    error: failed ? failed + ' of ' + results.length + ' recipient(s) failed' : undefined,
  };
}

function cmdSend(flags, ctx) {
  const home = ctx.home;
  const cwd = projectCwdFor(ctx);
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) {
    return {
      ok: false, action: 'send', reason: 'no-project',
      error: 'send must run from inside a git worktree of a DevSwarm project (the mesh store is per-project) — cd into the repo first',
    };
  }

  // `from` is ALWAYS the hardened, cwd-derived identity (D18/D19) — never raw
  // env. An explicit --from flag is accepted ONLY as a redundant declaration
  // that must MATCH the derived identity; a mismatching one is spoofing and is
  // rejected outright (D18 guard).
  // D11-A (d35d2d4b241e): callerIdentityDetailed gives the SAME resolution as
  // callerIdentity (identical resolveCallerWorktree -> DEVSWARM_BUILDER_ID ->
  // raw-cwd-hash fallback order) plus the `kind` this send's success/refusal
  // JSON now surfaces additively — computed once here instead of calling
  // callerIdentity separately.
  // v0.108.0: a CHILD worktree's label is its registered child id, never the
  // `primary-<hash>` worktree meshId (senderIdentityDetailed). --from may name
  // either derived value (both are ground-truth, neither is a spoof).
  const fromDetailed = senderIdentityDetailed(ctx.env, cwd, registrySnapshot(ctx, repoKey), home);
  const from = fromDetailed.identity;
  const fromFlag = one(flags, 'from');
  if (fromFlag !== undefined && fromFlag !== from && fromFlag !== fromDetailed.meshId) {
    return {
      ok: false,
      error: 'send --from ' + JSON.stringify(fromFlag) + ' does not match the '
        + 'caller\'s derived identity ' + JSON.stringify(from) + ' — spoofing rejected',
    };
  }

  const toFlag = one(flags, 'to');
  const broadcastFlag = hasFlag(flags, 'broadcast') || one(flags, 'type') === 'broadcast';
  // --to-primary (v0.58, PLAN.md CLI VERB CONTRACT): a third mutually-exclusive
  // target mode alongside the existing --to <meshId> / --broadcast.
  const toPrimaryFlag = hasFlag(flags, 'to-primary');
  const targetModeCount = (toFlag !== undefined ? 1 : 0) + (broadcastFlag ? 1 : 0) + (toPrimaryFlag ? 1 : 0);
  if (targetModeCount > 1) {
    return { ok: false, error: 'send accepts --to <meshId> OR --to-primary OR --broadcast, not more than one' };
  }
  if (targetModeCount === 0) {
    return { ok: false, error: 'send requires --to <meshId>, --to-primary, or --broadcast' };
  }
  const type = broadcastFlag ? 'broadcast' : 'direct';

  // JEV outcome tracking (best-effort, fail-open, direct sends only — a
  // broadcast has no single recipient's pending question to answer): `from`
  // is about to send `toFlag` a message; if `toFlag` previously sent `from`
  // a labeled (urgent/kind) message with no answer recorded yet (see
  // hooks/lib/jev-triage.js noteLabeledInbound, called from
  // cmdInboxMessagesInner), this logs the time-to-answer. NEVER affects the
  // send itself — a tracking failure here must never block/delay a message.
  if (type === 'direct' && toFlag !== undefined) {
    try { require('../../hooks/lib/jev-triage.js').recordAnswered({ home, from, to: toFlag }); } catch (_) {}
  }

  // --question (D-devswarm-parent-decide-gate §4.1): marks this send as a
  // blocking question needing a reply (needs_reply); never valid on a broadcast.
  const questionFlag = hasFlag(flags, 'question');
  if (questionFlag && type === 'broadcast') {
    return { ok: false, error: 'send --question is only valid for a direct message (--to/--to-primary), not --broadcast' };
  }
  // --answers (G fix, defect 93c41cc09ff6 correlation): a bare boolean flag
  // marking THIS send as a reply that answers a pending question from the
  // recipient — the explicit correlation hooks/devswarm-parent-reply-
  // tracker.js's recipientHasPendingQuestion lacked. Without it, that
  // tracker credited ANY --question send as an answer whenever the
  // recipient happened to have SOME pending question recorded (not
  // necessarily THIS one, and not necessarily answered by THIS message at
  // all) — a false-positive that could clear an unrelated question. Never
  // valid on a broadcast (there is no single recipient's question to answer).
  const answersFlag = hasFlag(flags, 'answers');
  if (answersFlag && type === 'broadcast') {
    return { ok: false, error: 'send --answers is only valid for a direct message (--to/--to-primary), not --broadcast' };
  }

  // FIX 4a (TRACED): argv is the ONLY way to pass a message body, forcing callers
  // to correctly quote shell metacharacters (backticks/`$` expand in the CALLER's
  // shell — not an anti-hall vulnerability, but a real usability gap). Add
  // --message-file <path> and --message-stdin as byte-exact alternatives, reusing
  // the existing fd-0 read idiom (`--stdin` on reconcile-active). Mutually
  // exclusive with --message and with each other.
  const messageFlag = one(flags, 'message');
  const messageFileFlag = one(flags, 'message-file');
  const messageStdinFlag = hasFlag(flags, 'message-stdin');
  const messageSourceCount = (messageFlag !== undefined ? 1 : 0)
    + (messageFileFlag !== undefined ? 1 : 0) + (messageStdinFlag ? 1 : 0);
  if (messageSourceCount > 1) {
    return { ok: false, error: 'send accepts exactly one of --message, --message-file, or --message-stdin' };
  }
  if (messageSourceCount === 0) {
    return { ok: false, error: 'send requires exactly one of --message TEXT, --message-file <path>, or --message-stdin' };
  }
  let message;
  if (messageFileFlag !== undefined) {
    try { message = fs.readFileSync(messageFileFlag, 'utf8'); }
    catch (e) { return { ok: false, error: 'send --message-file ' + JSON.stringify(messageFileFlag) + ' could not be read: ' + String(e && e.message || e) }; }
  } else if (messageStdinFlag) {
    if (ctx.io && typeof ctx.io.stdin === 'string') message = ctx.io.stdin;
    else { try { message = fs.readFileSync(0, 'utf8'); } catch (e) { return { ok: false, error: 'send --message-stdin could not read fd 0: ' + String(e && e.message || e) }; } }
  } else {
    message = messageFlag;
  }
  if (!message) return { ok: false, error: 'send requires --message TEXT (or --message-file/--message-stdin) with a non-empty body' };

  const urgencyRaw = one(flags, 'urgency');
  const urgency = urgencyRaw !== undefined ? urgencyRaw : 'normal';
  if (!ALLOWED_URGENCY.includes(urgency)) {
    return {
      ok: false,
      error: 'send --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
      allowed: ALLOWED_URGENCY.slice(),
    };
  }

  // --to-primary resolution (cheap, no store open needed): the installer helper
  // resolveMainWorktree(cwd) resolves THIS project's main worktree; its meshId
  // is what the fail-closed registry lookup (below, inside the store) and the
  // self-address check (here, mirroring --to's own ordering) both key off.
  let mainWorktree = null;
  let primaryMeshId = null;
  if (toPrimaryFlag) {
    mainWorktree = inst.resolveMainWorktree(cwd);
    if (!mainWorktree) {
      return { ok: false, reason: 'no-primary-worktree', error: 'send --to-primary: cwd is not inside a resolvable git worktree' };
    }
    primaryMeshId = inst.primaryWorkspaceId(mainWorktree);
  }

  if (type === 'direct') {
    const selfTarget = toPrimaryFlag ? primaryMeshId : toFlag;
    if (selfTarget === from || (fromDetailed.meshId && selfTarget === fromDetailed.meshId)) {
      return { ok: false, error: 'send --to' + (toPrimaryFlag ? '-primary' : '') + ' cannot address the sender itself' };
    }
  }

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  // P1-1/P1-2 RE-HOME (send path): if the Primary is stranded in the legacy hash
  // bucket, MIGRATE it into store/<repoKey>/ BEFORE resolving/delivering, so the
  // message lands in the SAME store the Primary's own read verbs open — the old
  // "Fix 1" band-aid delivered into the hash bucket instead, a silent black hole
  // the Primary's repoKey-keyed reads never drained. GATED exactly like the read
  // path (maybeRehomeToCwdProject): a healthy, already-colocated Primary is a
  // no-op here — no descriptor rewrite, no registry re-upsert, no false
  // `rehomedFromHashBucket:true` on the hot path. Best-effort + under the
  // per-id lock (held internally by maybeRehomeToCwdProject); only a genuinely
  // hash-bucket-stranded Primary re-homes.
  let rehomedSend = false;
  // 73303d4c098b fix: set when resolveSendTarget followed a fold-time
  // retired-redirect one hop to reach the actual target — surfaced on the
  // send result below so a caller sees its `--to` was redirected rather than
  // silently landing on a different id than the one it typed.
  let sendRedirect = null;
  let sendReroute = null; // #6: exact-id stale twin -> live same-session successor
  if (toPrimaryFlag) {
    try {
      const rh = maybeRehomeToCwdProject(home, primaryMeshId, ctx);
      rehomedSend = !!(rh && rh.rehomed);
    } catch (_) { /* fail-open: send proceeds and fail-closes below if still unresolved */ }
  }
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    let targetPartition = null;
    // TRACED P0 DEFECT B fix (step 1): `send` used to resolve+deliver to exactly
    // one row with ZERO visibility into whether the candidate set it picked from
    // had more than one row (a partition). REPORT, never block — a partition is
    // exactly the shape where refusing to send would be worse than delivering to
    // the freshest-live candidate. `candidateMeshRow` is whichever row resolution
    // actually picked (toPrimaryFlag's `target` or the toFlag path's
    // `resolved.target`); candidate count is recomputed from ITS OWN canonical
    // meshId group (meshCandidateRows) so this is correct whether the row was
    // found via the meshId match or the exact-id fallback in resolveSendTarget.
    let candidateMeshRow = null;
    if (type === 'direct') {
      // Fail-closed addressing (D12a): a --to naming neither a registered meshId
      // NOR a registered row id is rejected outright — never a silent
      // black-hole. Same posture for --to-primary: an unregistered Primary is a
      // fail-closed error, never a silent black-hole either. After a re-home
      // (above) the Primary's row is now in THIS repoKey store, so this resolve
      // finds it.
      if (toPrimaryFlag) {
        const target = resolveMeshTarget(s, primaryMeshId, home);
        if (!target) {
          return {
            ok: false, reason: 'primary-unregistered',
            error: 'send --to-primary: no registered Primary workspace for this project (run `register-primary` first)',
          };
        }
        targetPartition = target.id;
        candidateMeshRow = target;
      } else {
        // resolveSendTarget (P0 addressing fix): tries the meshId match FIRST
        // (unchanged), then falls back to an exact match against a row's own
        // `id` — the value `roster` now prints alongside meshId, so a copied
        // roster id addresses correctly instead of failing closed.
        const resolved = resolveSendTarget(s, toFlag, home, { rerouteStaleTwin: true });
        if (resolved.ambiguous) {
          return {
            ok: false, reason: 'ambiguous-recipient',
            error: 'send --to ' + JSON.stringify(toFlag) + ' matches more than one registered workspace row ('
              + resolved.candidates.join(', ') + ') — this should never happen (id is the registry primary key); '
              + 'address a specific meshId instead',
          };
        }
        if (!resolved.target) {
          return {
            ok: false, reason: 'unregistered-recipient',
            error: 'send --to ' + JSON.stringify(toFlag) + ' is not a registered mesh workspace',
          };
        }
        // The row's workspace_id is the target's REAL read partition — its
        // builder-id (target.id), NOT the meshId (D19 child-delivery join): this
        // is what lands a mesh direct in the exact partition the recipient (or a
        // child's builder-id read surface, D26) actually reads.
        targetPartition = resolved.target.id;
        candidateMeshRow = resolved.target;
        if (resolved.redirected) sendRedirect = { from: resolved.redirectedFrom, to: String(resolved.target.id) };
        if (resolved.rerouted) sendReroute = { from: resolved.reroutedFrom, to: String(resolved.target.id), reason: resolved.rerouteReason };
      }
    }
    // Candidate-set size for the resolved row's OWN canonical meshId group —
    // >1 means the meshId this send addressed had more than one registry row
    // (a partition); pickFreshestLive already chose `targetPartition` from
    // among them. undefined (not 0) for a broadcast/no-target send, so the
    // field is only present when it means something.
    let candidateCount;
    if (type === 'direct' && candidateMeshRow) {
      try {
        const meshForCount = canonicalMeshId(candidateMeshRow.worktreePath) || rawPathMeshId(candidateMeshRow.worktreePath);
        candidateCount = meshCandidateRows(s, meshForCount).length;
      } catch (_) { candidateCount = undefined; }
    }
    const doAppend = () => {
      const fields = {
        from, to: type === 'direct' ? targetPartition : null,
        type, message: String(message), timestamp: now, urgency,
        needsReply: questionFlag,
      };
      const hash = store.meshMessageHash(fields);
      const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash, instanceNonce: dispatcherExports().deriveReaderNonce(ctx) }));
      store.deriveSummary(s, { home, env: ctx.env, now });
      // READBACK VERIFICATION (defect 84c0b4385f68, REOPENED): better-sqlite3's
      // INSERT is synchronous, so the row physically exists on disk the instant
      // appendMeshMessage() returns — but that was never proof a READER can see
      // it (the v0.77.0 `bytes`/`hash` echo below was flagged by its own comment
      // as "purely additive", i.e. it never actually re-read anything). Re-select
      // the exact partition this send targeted (workspace_id) and confirm the row
      // is present by its unique `hash` (table-wide UNIQUE(hash) constraint,
      // devswarm-store.js:414) — through s.listMessages(), the SAME read path
      // read-primary/peek-primary/inbox messages use, so this proves readability
      // through the real read surface, not a special-cased check. Cheap in the
      // common case: a fresh append is virtually always the LAST row (id ASC),
      // so that's checked first; the full-scan fallback only runs if that misses
      // (e.g. a concurrent writer landed a row after this one).
      const verifyPartition = type === 'direct' ? targetPartition : store.BROADCAST_PARTITION_ID;
      let verified = false;
      let verifyError = null;
      try {
        const rows = s.listMessages(verifyPartition) || [];
        const last = rows.length ? rows[rows.length - 1] : null;
        verified = !!(last && last.hash === hash) || rows.some((r) => r && r.hash === hash);
      } catch (e) {
        // Fail-open on the VERIFICATION step itself only (its own read threw) —
        // report unverified, never claim absence, never claim failure.
        verifyError = String((e && e.message) || e);
      }
      const out = {
        // ok stays true unless the readback POSITIVELY shows the row absent
        // (verifyError is null and verified is false) — a verification error
        // never flips ok:false (fail-open on the check itself, per spec).
        ok: verified || verifyError !== null,
        action: 'send', from,
        // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
        // `kind` (resolved/declared/unresolvable) alongside `from`.
        identity: { id: from, kind: fromDetailed.kind },
        to: type === 'direct' ? (toPrimaryFlag ? primaryMeshId : toFlag) : null, type, urgency,
        sent: !!res.inserted, seq: res.seq,
      };
      // 73303d4c098b fix: additive-only fields, set ONLY when a redirect
      // actually happened — every other send response is byte-identical.
      if (sendRedirect) { out.redirected = true; out.redirectedFrom = sendRedirect.from; }
      if (sendReroute) { out.rerouted = true; out.reroutedFrom = sendReroute.from; out.rerouteReason = sendReroute.reason; }
      Object.assign(out, {
        // FIX 3 (TRACED, purely additive): echo the integrity data already computed
        // above so `ok:true` is verifiable without a read-back-and-tail-compare.
        // defect 0960924d28be: this was `String(message).length` — UTF-16 CODE
        // UNITS, not bytes. Every multi-byte codepoint (an em dash U+2014 is 3
        // UTF-8 bytes but 1 UTF-16 unit) under-reported by exactly (utf8Bytes -
        // utf16Units), which the field report reconciled to the codepoint on two
        // independent sends (5807->5805 with 1 em dash, 3760->3756 with 2). The
        // field reading of that gap was "the body was TRUNCATED in transit" — a
        // false data-loss alarm from a purely cosmetic measurement bug. A field
        // named `bytes` must report BYTES. This is the ONLY size measurement in
        // this file (verified: no other `bytes:`/byteLength site exists here);
        // companion/devswarm-ingest.js:816/1483 already used Buffer.byteLength
        // for its quarantine cap, so no cap/limit anywhere shared the wrong
        // measure and nothing else needed changing.
        bytes: Buffer.byteLength(String(message), 'utf8'),
        hash,
        rehomedFromHashBucket: rehomedSend || undefined,
        needsReply: questionFlag,
        // G fix: echo the explicit reply-correlation flag so
        // devswarm-parent-reply-tracker.js can require it instead of
        // inferring "this answers something" from the recipient merely
        // having SOME pending question on file.
        answers: answersFlag,
        toId: type === 'direct' ? targetPartition : null,
        // TRACED P0 DEFECT B (step 1): visibility into the candidate set this
        // send resolved from — >1 means the target meshId's group is
        // partitioned (never blocks; report-only).
        candidates: type === 'direct' ? candidateCount : undefined,
        // ADDITIVE (defect 84c0b4385f68): the readback verification result.
        // `verified:true` means the row was actually confirmed readable in its
        // target partition. `verified:false` with `verifyError` set means the
        // check itself errored (unknown, not a failure). `verified:false` with
        // `verifyError:null` means the readback POSITIVELY found the row
        // absent — a real delivery failure, surfaced via `ok:false` + `reason`
        // above/below rather than a silent `ok:true`.
        verified,
      });
      // SEND RECEIPT (v0.90.0). An on-disk record that this send happened,
      // written by the SENDER at the moment of the append.
      //
      // WHY: devswarm-parent-reply-tracker.js (PostToolUse/Bash) can only learn
      // that the Primary replied by PARSING the send's stdout — which means a
      // send whose stdout it cannot parse (a compound command's interleaved
      // output, a redirect, a wrapper that swallows stdout, a send issued from
      // anywhere other than a Bash tool call) silently never counts as a reply,
      // and the sender's question stays "unanswered" forever. A receipt is
      // written by the send ITSELF, so the tracker no longer depends on the
      // shape of the surrounding shell command.
      //
      // FAIL-SOFT AND OUT OF BAND: wrapped whole, and its result is never read
      // — `out` is returned unchanged whether the receipt landed or not. A
      // receipt is a diagnostic, never part of delivery.
      //
      // P1 (Round 13): the receipt carries its PROJECT. Without it the reader
      // (devswarm-parent-reply-tracker.js) credited EVERY receipt in the home
      // directory to whatever repoKey the CURRENT payload resolved to — a send
      // in project A silently cleared a pending question in project B, because
      // receipts are home-scoped while reply-state is per-project. `cwd` is
      // recorded alongside it purely as a human-readable provenance field.
      writeSendReceipt(home, {
        ts: now, from, to: out.to, toId: out.toId, type, urgency,
        hash, bytes: out.bytes, ok: out.ok, sent: out.sent,
        needsReply: questionFlag, verified,
        repoKey: repoKey != null ? String(repoKey) : null,
        cwd: cwd != null ? String(cwd) : null,
      });
      // A sent message is child activity: refresh the sender's plan progress
      // clock (fresh text only — see planLib.noteActivity). Fail-soft, only
      // when the sender has a plan; never changes the send result.
      if (out.sent) {
        try {
          const ref = planRefFor(home, from, ctx);
          const pf = planLib.findPlan(home, ref);
          if (pf) planLib.updatePlan(home, pf.key, (plan) => (plan && planLib.noteActivity(plan, message, now) ? plan : null));
        } catch (_) { /* best-effort */ }
      }
      if (verifyError !== null) out.verifyError = verifyError;
      if (!verified && verifyError === null) {
        out.reason = 'send-not-verified';
        out.error = 'send appended a row (hash ' + hash + ') but the readback against partition '
          + JSON.stringify(verifyPartition) + ' did not find it — the message is NOT confirmed delivered';
      }
      return out;
    };
    if (type === 'direct') {
      // MESSAGE-LOSS FIX (P1): rehomeAcrossStores always runs under
      // withIdLock(id) (rehomeMiskeyedRow/rehomeCore) while it snapshots this
      // store's messages for `targetPartition` and then tombstones its
      // registry row — but this send was previously entirely unlocked, so it
      // could append a message into `s` AFTER rehome's snapshot but BEFORE its
      // tombstone; message rows are append-only (never deleted), so that
      // append survives here while the registry row that would have made it
      // reachable is gone — permanently orphaned in the old store. Serializing
      // on the SAME per-id lock forces this append to wait out any in-flight
      // rehome of this exact id. Re-check the row is still HERE once the lock
      // is ours: a rehome that completed while we waited has already moved it
      // to another store, and appending here regardless would just re-create
      // the same orphan one step later.
      // D5 fix: `send --to` used to take the per-id lock exactly ONCE
      // (acquireIdLock's own 2s internal budget) and fail closed with
      // `{ok:false, lockBusy:true}` the instant a contender (every `inbox
      // pull`'s cmdRegister/ensure, or the child-turn hook) held it a moment
      // longer than that — a correct client's only recourse was "retry
      // shortly", which nothing here did FOR it. Add a bounded OUTER retry
      // (3 attempts total, jittered exponential backoff between them, well
      // under a single turn) around the whole locked critical section.
      // SAFETY: `doAppend()` reuses `now`/`fields`/`hash` computed OUTSIDE
      // this retry loop (unchanged from before this fix) — `now` is captured
      // once, well above, so every attempt that actually RUNS `doAppend()`
      // hashes the SAME timestamp and produces the SAME `meshMessageHash`,
      // making a retry idempotent against `appendMeshRow`'s
      // `INSERT OR IGNORE` on that unique hash. This loop only ever retries
      // the LOCK ACQUISITION itself (`withIdLock` did not run `fn` at all on
      // a `lockBusy` result), so `doAppend()` still executes at most once —
      // recomputing `now` per attempt would have been the actual duplication
      // risk, and this fix does not do that.
      const SEND_LOCK_RETRY_ATTEMPTS = 3;
      const SEND_LOCK_RETRY_BASE_MS = 150;
      let lockBusyResult = null;
      for (let attempt = 0; attempt < SEND_LOCK_RETRY_ATTEMPTS; attempt++) {
        const r = withIdLock(String(targetPartition), home, () => {
          const stillHere = (s.listRegistry() || []).some((row) => row && String(row.id) === String(targetPartition));
          if (!stillHere) {
            return {
              ok: false, reason: 'unregistered-recipient',
              error: 'send target ' + JSON.stringify(targetPartition) + ' is no longer registered in this '
                + 'project store (likely re-homed to another project store mid-send) — retry',
            };
          }
          return doAppend();
        });
        if (!(r && r.lockBusy)) return r;
        lockBusyResult = r;
        if (attempt < SEND_LOCK_RETRY_ATTEMPTS - 1) {
          const backoffMs = SEND_LOCK_RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * SEND_LOCK_RETRY_BASE_MS);
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs); } catch (_) { /* best-effort sleep */ }
        }
      }
      // Every attempt was lockBusy: surface it as-is (`ok:false, lockBusy:true`)
      // so the CLI's exit code (`r.ok ? 0 : 2`, run()'s 'send' case) is
      // non-zero — a caller doing `send ... && echo ok` never sees a dropped
      // send silently treated as success.
      lockBusyResult.retriedAttempts = SEND_LOCK_RETRY_ATTEMPTS;
      return lockBusyResult;
    }
    return doAppend();
  } finally { s.close(); }
}

// ===========================================================================
// SEND RECEIPTS (v0.90.0) — <devswarmRoot>/send-receipts/<YYYY-MM-DD>/<hash>.json
//
// One small JSON file per send, date-partitioned so a reader can scan just
// today's directory and a retention sweep can drop whole days (doctor-repair's
// sweepSendReceipts, 7-day default). The file NAME is the send's content hash,
// which makes the write idempotent: a retried identical send overwrites its own
// receipt rather than accumulating duplicates.
function sendReceiptsDir(home) { return path.join(devswarmRoot(home), 'send-receipts'); }

// receiptDayKey(ts) -> 'YYYY-MM-DD' in UTC. UTC, not local time, so a reader
// scanning "today" agrees with the writer regardless of the two processes'
// timezones (and so a DST shift can never make a day directory ambiguous).
function receiptDayKey(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return d.toISOString().slice(0, 10);
}

// receiptFileName(hash) — the hash with every character outside [A-Za-z0-9_-]
// replaced, so a hash namespace prefix (`mesh:`, `native:`, `legacy:`) can never
// produce a path separator or a reserved character.
function receiptFileName(hash) {
  return String(hash == null ? 'nohash' : hash).replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
}

// writeSendReceipt(home, entry) -> string|null (the path written, or null).
// NEVER THROWS: every step is inside one guard, and the return value is
// deliberately ignorable — the caller (cmdSend) must be unaffected either way.
// Atomic (tmp + rename) so a reader can never observe a half-written receipt.
function writeSendReceipt(home, entry) {
  try {
    const ts = Number.isFinite(entry && entry.ts) ? entry.ts : Date.now();
    const dir = path.join(sendReceiptsDir(home), receiptDayKey(ts));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, receiptFileName(entry && entry.hash));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, entry, { ts })) + '\n');
    fs.renameSync(tmp, file);
    return file;
  } catch (_) { return null; }
}

// sendQuietLine(result) -> the one-line `send --quiet` rendering (peer
// request D): "sent seq N -> X, B bytes, ok" on success; a LOUD "ok:false
// ..." line (never silently swallowed) on failure — the caller still sees
// exactly why, and main()'s exit code stays non-zero exactly as the JSON
// path already does (r.ok ? 0 : 2), so a script checking `$?` alone still
// catches the failure even under --quiet.
function sendQuietLine(result) {
  // Multi-recipient send (0.112): one line per recipient, same shape.
  if (result && Array.isArray(result.recipients)) {
    return result.recipients.map((r) => (r.ok
      ? 'sent seq ' + r.seq + ' -> ' + r.to + ', ' + r.bytes + ' bytes, ok'
      : 'ok:false -> ' + r.to + ': ' + String(r.error || 'send failed'))).join('\n');
  }
  if (result && result.ok) {
    const to = result.type === 'broadcast' ? '(broadcast)' : (result.to != null ? String(result.to) : '(unknown)');
    return 'sent seq ' + result.seq + ' -> ' + to + ', ' + result.bytes + ' bytes, ok';
  }
  return 'ok:false ' + String((result && result.error) || (result && result.reason) || 'send failed');
}

module.exports = {
  planRefFor, meshCandidateRows, resolveMeshTarget, resolveMeshPartitionIds, canonicalReceiptId,
  staleTwinSuccessor, resolveSendTarget, cmdRelay, cmdSendMulti, cmdSend, sendReceiptsDir,
  receiptDayKey, receiptFileName, writeSendReceipt, sendQuietLine,
};
