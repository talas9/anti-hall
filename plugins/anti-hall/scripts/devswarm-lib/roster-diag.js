'use strict';
// anti-hall :: devswarm CLI — ROSTER-DIAG module (scripts/devswarm-lib/roster-diag.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, archivedCacheLib, checkedArchivedDir, cliRowLog, csvList, DEFAULT_HEARTBEAT_FRESH_MS,
  descriptorPhysicalOwnerKey, descriptorRegisteredRepoKey, devswarmIdle, fs, gitTruth, hasFlag,
  hasFreshHeartbeat, hcRun, inst, isArchivedOnlyWorkspace, isSafeId, livenessPathFor, names, one,
  path, planLib, readDescriptorFile, readDescriptorPathState, repokey, repoKeyForCwd,
  rowEligibilityLib, rowLivenessState, spawnSync, store,
} = require('./core.js');
const {
  callerIdentity, computeRowLive, groupRegistryByMeshId, projectCwdFor, rosterMeshId,
  shortInstanceNonce, SYNTHETIC_SESSION_PREFIX,
} = require('./identity.js');
const {
  assertSeatAllowsCursorWrite, CURSOR_LOG_DIAGNOSE_SCAN, CURSOR_WRITES_PER_ID, readCursorLog,
} = require('./cursors.js');
const {
  resolveMeshTarget,
} = require('./send.js');
const {
  localArchivedAppLive,
} = require('./archive.js');
const {
  parseSinceDuration,
} = require('./misc-verbs.js');

// LIST_CHILDREN_TIMEOUT_MS — bounded timeout for roster's read-only native
// fold spawn (`hivecontrol workspace list children`). Mirrors the finite-
// timeout posture every other hivecontrol spawn in this codebase uses
// (devswarm-pull.js's message-count/read-messages, child-gate.js's
// probeNativeMessageCount) — a hung/slow native CLI must never wedge `roster`.
const LIST_CHILDREN_TIMEOUT_MS = 5000;

// parseChildrenList(raw) -> [{branch,id,path,repositoryId}]. TOLERANT parse of
// `hivecontrol workspace list children`/`list all` output — the JSON shape is
// not pinned in the KB, so accept a bare array or a {children:[...]} wrapper
// (same tolerance the old, now-deleted resolveChildBranch used for the same
// command). Shared by fetchNativeChildren (`list children`) AND
// fetchTrustedRepositoryId (`list all`) below — both commands return the same
// per-record shape (live-verified).
function parseChildrenList(raw) {
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : []);
  } catch (_) { list = []; }
  return list.filter((e) => e && typeof e === 'object').map((e) => ({
    branch: e.branch || e.id || null,
    id: e.id || null,
    path: e.path || e.worktreePath || null,
    // label (task #6): hivecontrol's free-text human title — live-verified
    // present on `list children`/`list all` output, DEFAULTS to the branch
    // name when `-t` was not passed at create. Previously dropped by this
    // parse; now threaded through fetchNativeChildren/cmdRoster so a native
    // child's human name is visible instead of just its branch/id.
    label: (typeof e.label === 'string' && e.label) ? e.label : null,
    // repositoryId (cross-repo hijack guard, see fetchNativeChildren below):
    // hivecontrol's own internal repo identity for this record — live-verified
    // present on both `list children` and `list all` output.
    repositoryId: (typeof e.repositoryId === 'string' && e.repositoryId) ? e.repositoryId : null,
  }));
}

// fetchTrustedRepositoryId(ctx, run) -> string|null. ONE bounded, CWD-ANCHORED
// `hivecontrol workspace list all` spawn with DEVSWARM_REPO_ID stripped from
// the env it's given, so hivecontrol is forced onto its cwd-based resolution
// fallback (live-verified correct: unsetting all DEVSWARM_* vars makes
// `list all` resolve the repo from the real worktree cwd, not an ambient env
// var). Used ONLY as ground truth for fetchNativeChildren's cross-check below.
// Fail-open null: hivecontrol not installed / spawn error / unparseable /
// empty output all read as "no trusted id available".
function fetchTrustedRepositoryId(ctx, run) {
  try {
    let env = ctx.env;
    if (env && Object.prototype.hasOwnProperty.call(env, 'DEVSWARM_REPO_ID')) {
      env = Object.assign({}, env);
      delete env.DEVSWARM_REPO_ID;
    }
    const res = run({ args: ['workspace', 'list', 'all'], env, timeout: LIST_CHILDREN_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    const found = parseChildrenList(res.raw).find((e) => e.repositoryId);
    return found ? found.repositoryId : null;
  } catch (_) {
    return null;
  }
}

// fetchNativeChildren(ctx) -> [{branch,id,path}]. ONE bounded, NON-DESTRUCTIVE
// `hivecontrol workspace list children` spawn (never `monitor`/`read-messages`),
// using the SAME injectable io.run posture as every other native spawn in this
// file (pull.defaultRun). Fail-open []: hivecontrol not installed / spawn error
// / unparseable output all read as "nothing to fold" — roster's own store-only
// view is NEVER blocked or degraded by this best-effort addition.
//
// CROSS-REPO HIJACK GUARD (defense-in-depth): `list children` resolves its
// "current workspace" scope ENTIRELY from env (DEVSWARM_REPO_ID +
// DEVSWARM_BUILDER_ID), never from cwd — live-verified: a Node process that
// inherited a FOREIGN repo's DEVSWARM_REPO_ID (+ a matching foreign
// DEVSWARM_BUILDER_ID) gets that OTHER repo's real children back, exit 0,
// valid JSON, with this process's cwd sitting in a completely unrelated repo
// the whole time. (`list children` also REQUIRES DEVSWARM_REPO_ID to run at
// all — it errors "Not inside a DevSwarm workspace" without it — so stripping
// the env here, as an earlier version of this fix did, breaks the call
// entirely instead of hardening it; that approach was live-verified wrong and
// reverted.) Each returned record's `repositoryId` is cross-checked against a
// SEPARATE, cwd-anchored lookup (fetchTrustedRepositoryId, env-stripped
// `list all`) and any mismatch is dropped + logged rather than silently
// folded into this repo's roster. If no trusted id can be established, or no
// record carries a repositoryId at all (older hivecontrol), the fold degrades
// to its pre-existing unfiltered behavior — never a crash, never a hard
// failure.
function fetchNativeChildren(ctx) {
  try {
    const run = (ctx.io && ctx.io.run) || hcRun;
    const res = run({ args: ['workspace', 'list', 'children'], env: ctx.env, timeout: LIST_CHILDREN_TIMEOUT_MS });
    if (!res || !res.ok) return [];
    const children = parseChildrenList(res.raw);
    const withRepoId = children.filter((c) => c.repositoryId);
    if (withRepoId.length === 0) return children; // nothing to cross-check against
    const trusted = fetchTrustedRepositoryId(ctx, run);
    if (!trusted) return children; // no ground truth available -> fail open, unfiltered
    const mismatched = withRepoId.filter((c) => c.repositoryId !== trusted);
    if (mismatched.length) {
      try {
        alog.logEvent('devswarm-cli', 'roster-native-fold', 'warn',
          'dropped ' + mismatched.length + ' native child(ren) whose repositoryId did not match this repo (cross-repo env hijack guard)',
          { expected: trusted, got: Array.from(new Set(mismatched.map((c) => c.repositoryId))) });
      } catch (_) {}
    }
    return children.filter((c) => !c.repositoryId || c.repositoryId === trusted);
  } catch (_) {
    return [];
  }
}

// fetchActiveWorkspaceRecords(ctx) ->
//   { ok:true, records:[{id, worktreePath, repositoryId, label, branch}], count }
//   | { ok:false, reason, rawKeys?, error?, status?, signal?, stderr? }
// ONE bounded, read-only `hivecontrol workspace list all` spawn (the same verb,
// timeout and injectable io.run posture as fetchTrustedRepositoryId /
// cmdReconcileRegistry). Never throws. Called ONLY from the supervisor's
// cooldown-gated reconcile sweep — never from a hook or any every-turn path.
//
// AN EMPTY LIST IS NOT `ok`. Under the field-flag design an empty array was a
// legitimate "nothing archived" answer. Under absence semantics it would assert
// "this project has NO live workspaces", i.e. that every registry row is
// archived — the exact over-suppression this feature must never produce, and
// indistinguishable here from an error the CLI reported as an empty body. So a
// zero-record list reports `hivecontrol-empty-list` and the caller writes
// nothing, which suppresses nothing.
//
// repositoryId (D12b item 1): this call parses the SAME `workspace list all`
// output parseChildrenList already knows carries a `repositoryId` field (see
// that function's own header) — it was simply never threaded through THIS
// parser, so every cached record downstream had repositoryId:null and the
// archive-cache's conjunct-3 repositoryId guard (companion/lib/
// devswarm-archived-cache.js isAppArchived) could never fire. Now passed
// through verbatim (null when the field is absent/non-string — older
// hivecontrol, fail-open unchanged). `label`/`branch` are threaded through too
// (cheap: same record, parseChildrenList already extracts both) for provenance
// only; no current reader depends on them.
//
// FAILURE DIAGNOSTICS (D12b item 3): a failed probe now carries `error`
// (message/code), `status`, `signal`, and the first 200 chars of `stderr` (NOT
// stdout — `raw`/stdout can be large and is not the diagnostic signal here)
// whenever the underlying `run()` result (companion/lib/devswarm-pull.js's
// defaultRun shape) supplies them, so a real field failure (a fast non-zero
// exit, not just a timeout) is distinguishable after the fact instead of
// collapsing to a bare 'hivecontrol-unavailable' reason with no detail.
function fetchActiveWorkspaceRecords(ctx) {
  const c = ctx || {};
  const run = (c.io && c.io.run) || hcRun;
  let res;
  try {
    res = run({ args: ['workspace', 'list', 'all'], env: c.env, cwd: c.cwd || process.cwd(), timeout: LIST_CHILDREN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: 'hivecontrol-unavailable', error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    return {
      ok: false, reason: 'hivecontrol-unavailable',
      error: String((res && res.error) || 'no output'),
      status: (res && Number.isFinite(res.status)) ? res.status : null,
      signal: (res && res.signal) ? String(res.signal) : null,
      stderr: (res && typeof res.stderr === 'string') ? res.stderr.slice(0, 200) : null,
    };
  }
  let parsed;
  try { parsed = JSON.parse(res.raw); } catch (_) { return { ok: false, reason: 'hivecontrol-shape-unrecognized', rawKeys: [] }; }
  // The measured shape is a FLAT ARRAY. `{children:[...]}` is accepted too, the
  // same tolerance cmdReconcileRegistry already applies to this CLI's output.
  const rawList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : null);
  if (!rawList) {
    return { ok: false, reason: 'hivecontrol-shape-unrecognized',
      rawKeys: (parsed && typeof parsed === 'object') ? Object.keys(parsed) : [] };
  }
  const records = [];
  for (const e of rawList) {
    if (!e || typeof e !== 'object' || e.id == null || String(e.id) === '') continue;
    records.push({
      id: String(e.id),
      worktreePath: typeof e.worktreePath === 'string' && e.worktreePath ? e.worktreePath : null,
      repositoryId: (typeof e.repositoryId === 'string' && e.repositoryId) ? e.repositoryId : null,
      label: (typeof e.label === 'string' && e.label) ? e.label : null,
      branch: (typeof e.branch === 'string' && e.branch) ? e.branch : null,
    });
  }
  if (!records.length) return { ok: false, reason: 'hivecontrol-empty-list', records: 0 };
  return { ok: true, records, count: records.length };
}

// cmdRoster(flags, ctx) — ALLOW-listed projection read of THIS project's
// shared registry + `working_on` (D3 roster surface). Derives a FRESH summary
// (never a stale cache) from store/<repoKey>/, keyed purely off cwd — no id
// argument, project-scoped like `send`/`mesh read`.
//
// v0.58 roster fold: additionally unions a READ-ONLY `hivecontrol workspace
// list children` view into the projection (never written back to the store —
// the store registry stays the single write-owned source of truth). A native
// child not yet matched by worktreePath against the store set (i.e. one that
// has never registered itself via inbox pull/heartbeat/register) is appended
// as a minimal entry so it is still VISIBLE on the roster instead of invisible.
// rosterIdleDays(home, id, now) — READ-ONLY reuse of the persisted liveness
// verdict (the SAME `livenessPathFor`/JSON shape `computeLiveness` itself
// reads, liveness.js:129) to surface "days since last activity" on the
// roster, without any new heavy computation. Returns null (never fabricated)
// when no verdict exists yet or it carries no usable timestamp.
// rosterLastOutboundTs(home, id) -> ms | null. The persisted liveness verdict's
// raw lastOutboundTs (the same file rosterIdleDays reads, before the day
// conversion). null when absent / unreadable / missing the field — never a
// fabricated value.
function rosterLastOutboundTs(home, id) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (v && Number.isFinite(v.lastOutboundTs)) return v.lastOutboundTs;
  } catch (_) { /* no verdict yet / unreadable — fail-open */ }
  return null;
}

function rosterIdleDays(home, id, now) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (v && Number.isFinite(v.lastOutboundTs)) {
      const days = Math.floor(((Number.isFinite(now) ? now : Date.now()) - v.lastOutboundTs) / 86400000);
      if (days >= 0) return days;
    }
  } catch (_) { /* no verdict yet / unreadable — fail-open, no fabricated value */ }
  return null;
}

// cmdRoster's per-row hints (archive-candidate surfacing, read-only): does
// NOT gate/skip anything and writes nothing — purely annotates the SAME
// projection so a human can decide whether to run the already-shipped
// `archive <id>` verb. `worktree-gone` = the descriptor's worktreePath no
// longer exists on disk (existsSync, same check style as elsewhere in this
// file). `idle Nd` = days since last liveness activity, when known.
// `opts` (optional): { repoKey, env, cache } for the APP-SIDE archive check —
// the DevSwarm app's own archived list, cached by the supervisor. Omitted (or
// without a repoKey) the check is simply skipped, which is the pre-existing
// behavior — this can only ever ADD an `archived` hint, never remove one.
// INSTANCE_SPLIT_CONCURRENT_GAP_MS — two DISTINCT instanceNonce values only
// count as a genuine split (two OS processes alive AT THE SAME TIME) when
// their activity is within this gap of each other. Root cause (field report
// 2026-09-25): deriveInstanceNonce is `<prefix>:<pid>:<startedAt>` and
// LEGITIMATELY changes on every process restart (devswarm-child-gate.js's
// TWIN-CASE FIX comment documents this exact behavior). The pre-fix test here
// was only "does each nonce individually have a row within the last
// DEFAULT_HEARTBEAT_FRESH_MS (15min) of NOW" — so an ordinary restart, where
// the dying process's last heartbeat is still <15min old when the fresh
// process's first heartbeat lands, always read as 2 concurrent instances even
// though the two processes never coexisted. Real ~/.anti-hall data confirmed
// the shape: every observed nonce transition was strictly sequential
// (non-overlapping) with a multi-minute gap (the smallest observed was ~4.7
// minutes) — nothing like true concurrency, which fires both nonces within
// the same second (see the d3d571495bf6 fixture above). 60s sits comfortably
// between the two: far above genuine simultaneous heartbeats, far below the
// smallest observed restart gap.
const INSTANCE_SPLIT_CONCURRENT_GAP_MS = 60 * 1000;

// computeInstanceNonceCounts(rows, now, freshMs) -> Map<senderId, {instances, nonces}>.
// instanceNonce CONSUMER (defect d3d571495bf6, item b), shared by `roster`
// (instance-split hint) and `diagnose` (instanceSplits[]) so the two verbs can
// never disagree about which rows are split. `rows` is the shared broadcast
// partition's message list (heartbeats + broadcasts, `s.listMessages(store.
// BROADCAST_PARTITION_ID)` — the SAME source computeSummary's own `working_on`
// derivation scans by sender), never a second store open. Scoped to `now -
// freshMs` (the SAME window `hasFreshHeartbeat` uses) so a long-dead second
// instance from weeks ago does not keep flagging a row forever. Fail-open per
// row: a row with a missing/non-finite `ts` or a null/empty `instanceNonce`
// is silently skipped, never thrown on.
//
// `instances` is NOT simply the count of distinct nonces seen in the window —
// that alone cannot tell a restart (sequential) apart from a real split
// (concurrent). Each nonce's [min,max] activity span is computed, then spans
// are padded by INSTANCE_SPLIT_CONCURRENT_GAP_MS and swept for the largest
// set of nonces overlapping at any single point in time — that peak
// concurrency count (and only the nonces in that peak set) is what gets
// reported, so a dead nonce whose last activity ended minutes before the
// live one's first activity is correctly never counted as concurrent with it.
function computeInstanceNonceCounts(rows, now, freshMs) {
  const windowMs = Number.isFinite(freshMs) ? freshMs : DEFAULT_HEARTBEAT_FRESH_MS;
  const bySender = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || r.sender == null || r.instanceNonce == null || r.instanceNonce === '') continue;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || (now - ts) > windowMs) continue;
    const key = String(r.sender);
    let spans = bySender.get(key);
    if (!spans) { spans = new Map(); bySender.set(key, spans); }
    const nonce = String(r.instanceNonce);
    const span = spans.get(nonce);
    if (!span) spans.set(nonce, { min: ts, max: ts });
    else { if (ts < span.min) span.min = ts; if (ts > span.max) span.max = ts; }
  }
  const out = new Map();
  for (const [id, spans] of bySender.entries()) {
    const entries = Array.from(spans.entries()); // [nonce, {min,max}]
    if (entries.length <= 1) {
      out.set(id, { instances: entries.length, nonces: entries.map(([n]) => n) });
      continue;
    }
    // Sweep line over spans padded by the concurrency gap on the END side
    // only — a nonce's window of "still might be the same live process" ends
    // INSTANCE_SPLIT_CONCURRENT_GAP_MS after its last observed activity, but
    // starts exactly when its first activity was actually seen (padding the
    // start too would let a LATER nonce's early padding reach back and
    // wrongly link it to an EARLIER, already-dead one).
    const events = [];
    for (const [nonce, span] of entries) {
      events.push([span.min, 1, nonce]);
      events.push([span.max + INSTANCE_SPLIT_CONCURRENT_GAP_MS, -1, nonce]);
    }
    // Ties: process starts (+1) before ends (-1) so a start landing exactly
    // on another's padded end still reads as overlapping (fail toward
    // detecting a split at the boundary, not away from it).
    events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const active = new Set();
    let bestSet = [];
    for (const [, delta, nonce] of events) {
      if (delta === 1) {
        active.add(nonce);
        if (active.size > bestSet.length) bestSet = Array.from(active);
      } else {
        active.delete(nonce);
      }
    }
    out.set(id, { instances: bestSet.length, nonces: bestSet });
  }
  return out;
}

function rosterHints(home, id, worktreePath, now, sessionId, opts) {
  const hints = [];
  if (worktreePath && !fs.existsSync(worktreePath)) hints.push('worktree-gone');
  const idleDays = rosterIdleDays(home, id, now);
  if (idleDays !== null) hints.push('idle ' + idleDays + 'd');
  // FIELD (archived rows still alerting): an ARCHIVED workspace is done and put
  // away — it is still listed, but it is labelled `archived` and never carries
  // the dormant/idle-alive liveness annotation (see companion/lib/
  // devswarm-archived.js for why archived/<id>.json alone is not the test).
  // One derivation (row-state.js): anti-hall's own archived marker first, then
  // the app-side archived-set cache when the row's repoKey is known.
  // opts.elig: the caller's shared eligibility context (cmdRoster builds ONE
  // per invocation); otherwise a one-off context with the same inputs.
  let archived = false;
  try {
    const elig = (opts && opts.elig)
      || rowEligibilityLib.createContext({ home, env: opts && opts.env, cache: opts && opts.cache, now, log: cliRowLog });
    archived = elig.of({ id, worktreePath, repoKey: (opts && opts.repoKey) || null }).archived;
  } catch (_) { archived = false; }
  if (archived) {
    hints.push('archived');
    // LEAK FLAG (0.109.1, field defect): archived precedence above is final —
    // a fresh heartbeat can NEVER pull this row back to 'active' (see
    // row-state.js's PRECEDENCE and cmdRegister/cmdHeartbeat's app-db archive
    // guards) — but a fresh heartbeat file existing at all on an archived row
    // means a `claude` process is still running against it (the field
    // incident's killed-then-relaunched terminal tab). Surface that
    // distinctly so a human sees it instead of a silently-suppressed retry
    // loop. Additive only, never changes the archived verdict itself.
    try {
      if (hasFreshHeartbeat(id, home, { now })) hints.push('live session in archived workspace');
    } catch (_) {}
    return hints;
  }
  // `dormant` / `idle (alive)` — rowLivenessState (companion/lib/liveness.js),
  // THE ONE read-side dormancy rule, shared with devswarm-parent-inbox.js's
  // per-turn injection so the roster and the UserPromptSubmit table can never
  // disagree about which rows are still transacting. It picks the tight dormant
  // window when this row's transcript term resolves, or the wide idle window
  // when it doesn't (the common case) — see isDormantRow's own doc for why —
  // and then applies the SESSION-SOURCED axis (defect 699a236129c5): a row whose
  // sessionId maps to a RUNNING harness process is `idle (alive)`, surfaced
  // distinctly instead of being mislabelled dormant. Annotation ONLY: the row is
  // still listed in full. Fail-open — no signal at all means UNKNOWN, which is
  // never dormant.
  try {
    const state = rowLivenessState(
      { id, worktreePath, sessionId: sessionId || null },
      home,
      { now, lastOutboundTs: rosterLastOutboundTs(home, id) }
    );
    if (state === 'dormant') hints.push('dormant');
    else if (state === 'idle-alive') hints.push('idle (alive)');
    // E fix: gate `phantom` on the row actually having a REGISTRY entry
    // (opts.registryBacked). A raw `sessionId != null` check does NOT
    // distinguish the two cases it needs to — VERIFIED: a genuine registry
    // row with no session claim yet (this file's own devswarm-fleet-
    // 298b79969409.test.js twin-row case) ALSO carries `sessionId: null` at
    // this point (confirmed via computeSummary), the exact same shape native
    // hivecontrol children pass. Native children (cmdRoster's fold at
    // ~:10700) have no mesh descriptor/registry row AT ALL — for them "no
    // real sessionId" is their permanent, structural shape, never evidence of
    // deadness, so `phantom` must never fire for them; but a REAL registry
    // row that never got claimed (the twin-row shape) is exactly the case
    // this hint exists to catch, and it too has a null sessionId. The caller
    // therefore states which case it is via `opts.registryBacked` instead of
    // this function trying (and failing) to infer it from sessionId alone.
    else if (opts && opts.registryBacked
      && !computeRowLive({ id, worktreePath, sessionId: sessionId || null }, home, { now })) {
      // PHANTOM GAP (defect 298b79969409): rowLivenessState found no dormancy
      // signal at all (this row would otherwise carry NO hint, reading as
      // active) — but the SAME predicate cmdDiagnose's `live` field uses says
      // this row is not actually live (no real sessionId and no fresh
      // heartbeat). Surface it so roster and diagnose can never silently
      // disagree about the same row the way the field report showed.
      hints.push('phantom');
    }
  } catch (_) {}
  // waiting-on-human (peer B): reuse the SAME childBusyState detector the
  // parent gate's hard-block "waiting on a human answer" line already uses
  // (companion/lib/devswarm-idle.js) — never a second detector. Additive
  // only: a row with no sessionId/worktreePath (native/phantom rows) or an
  // unreadable transcript reads unknown and gets no hint, same fail-open
  // posture as the rest of this function. Truncated question text (~120
  // chars, same truncation childBusyState's `question` already carries)
  // rides in the hint string itself so `roster` needs no second field.
  try {
    if (sessionId && worktreePath) {
      const bs = devswarmIdle.childBusyState({ id, sessionId, worktreePath }, home, { now });
      if (bs && bs.waiting) {
        hints.push(bs.question ? 'waiting-on-human: ' + bs.question : 'waiting-on-human');
      }
    }
  } catch (_) {}
  return hints;
}

function cmdRoster(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) {
    // repoKey is ALWAYS git-derived (repoKeyForWorktree hashes the resolved
    // common-dir — see devswarm-repokey.js) — there is no repoId->repoKey
    // registry to fall back through (DEVSWARM_REPO_ID is a caller-declared
    // label, not a store key, and trusting it here would let a stale/foreign
    // env value silently read the WRONG project's roster). The correct,
    // fail-closed fix is telling the caller how to get a real repoKey: cd
    // into a git worktree of the project first.
    return {
      ok: false, reason: 'no-project',
      error: 'roster must run from inside a git worktree of a DevSwarm project (the mesh store is per-project) — cd into the repo first',
    };
  }
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let sum;
  let broadcastAllForInstances = [];
  let storeUnavailable = false;
  let storeUnavailableReason = null;
  let storeUnavailableScope = null;
  // #62: a READ verb must not mutate — PURE computeSummary (no summary.json write).
  try {
    sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now });
    // defect 77d5a5bbf614: computeSummary calls s.listRegistry() internally
    // (devswarm-store.js), which swallows a genuine registry.ndjson read
    // error (EACCES/ENOTDIR/...) to an empty registry — pre-fix, roster read
    // that as "0 workspaces" with no signal the registry was unreadable at
    // all. Probe right after computeSummary, same idiom as computeDiagnosis's
    // own probe (defect 77d5a5bbf614) and the count/read/ack read verbs
    // elsewhere in this file. pickStoreReadErrorScope (R2 Critic P2-9)
    // attributes the error to the registry specifically only when it is
    // actually registry.ndjson — computeSummary reads messages.ndjson (the
    // broadcast partition) BEFORE listRegistry(), so a naive "first error
    // wins" probe could misattribute an unrelated messages.ndjson outage as
    // "registry unreadable". Fail-open: a throw here must never block the
    // roster read.
    try {
      const picked = pickStoreReadErrorScope(s);
      if (picked) { storeUnavailable = true; storeUnavailableReason = picked.code; storeUnavailableScope = picked.scope; }
    } catch (_) { storeUnavailable = false; storeUnavailableReason = null; storeUnavailableScope = null; }
    // instanceNonce CONSUMER (defect d3d571495bf6, item b): read the shared
    // broadcast partition (heartbeats + broadcasts — the SAME rows
    // computeSummary's own `working_on` derivation above already scans by
    // sender) ONCE, while `s` is still open, so instance-split detection
    // below never needs a second store open.
    try { broadcastAllForInstances = typeof s.listMessages === 'function' ? s.listMessages(store.BROADCAST_PARTITION_ID) : []; }
    catch (_) { broadcastAllForInstances = []; }
  } finally { s.close(); }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  // instanceNonceCounts: id -> {instances, nonces:[...]} — DISTINCT
  // instanceNonce values stamped by that id's own outbound broadcast/heartbeat
  // rows within the shared liveness freshness window (DEFAULT_HEARTBEAT_FRESH_MS,
  // the SAME window `hasFreshHeartbeat` uses). >1 means two live OS processes
  // are both sending mesh traffic under the SAME sessionId/row identity — the
  // `claude --resume`-races-its-prior-process shape d3d571495bf6 fixed the
  // provenance for; this is the roster-visible SYMPTOM detector for it.
  const instanceNonceCounts = computeInstanceNonceCounts(broadcastAllForInstances, now, DEFAULT_HEARTBEAT_FRESH_MS);
  // ONE read of the app-side ACTIVE-set cache for the whole roster (freshness is
  // applied inside readActiveCache — stale/missing/malformed yields nothing).
  let appArchivedCache = null;
  try { appArchivedCache = archivedCacheLib.readActiveCache({ home, env: ctx.env, now }); } catch (_) { appArchivedCache = null; }
  // ONE eligibility context for every roster row (memoized per row).
  const rosterElig = rowEligibilityLib.createContext({ home, env: ctx.env, cache: appArchivedCache, now, log: cliRowLog });
  const workspaces = Object.values(sum.workspaces || {}).map((w) => {
    // DEMOTE (archived-still-active fix): a store-sourced row whose workspace is
    // genuinely archived is labeled source:'archived' + hinted, instead of being
    // reported as a live 'store' row. The row is still SHOWN (nothing is hidden
    // or deleted — same no-delete posture as the archived/ scan below); only its
    // label changes, so an archived workspace can no longer read as active.
    const archivedOnly = isArchivedOnlyWorkspace(home, w.id);
    const hints = rosterHints(home, w.id, w.worktreePath, now, w.sessionId, { repoKey, env: ctx.env, cache: appArchivedCache, elig: rosterElig, registryBacked: true });
    if (archivedOnly) hints.unshift('archived');
    // instance-split (defect d3d571495bf6, item b): additive ONLY when this
    // row's own outbound rows carried at least one instanceNonce within the
    // freshness window — a row with none reads BYTE-IDENTICAL to the pre-fix
    // baseline (no `instances` key at all), never a fabricated `instances:0`.
    const instInfo = instanceNonceCounts.get(String(w.id));
    if (instInfo && instInfo.instances > 1) hints.push('instance-split');
    // 0.108.3: the child's structured done-report (`done` verb / `done` gate)
    // — auto-archive retires it once the merge is proven and gates c-g pass.
    if (!archivedOnly && w.gates && w.gates.done === true) hints.push('done', 'archive-pending');
    const row = {
      id: w.id, working_on: w.working_on, directUnread: w.directUnread,
      broadcastUnread: w.broadcastUnread, urgencyMax: w.urgencyMax,
      worktreePath: w.worktreePath || null, source: archivedOnly ? 'archived' : 'store',
      meshId: rosterMeshId(w.worktreePath),
      hints,
      // wsName (task #6): cached human display name, read-only fs projection
      // (never a hivecontrol spawn on this read verb) — null when not yet
      // cached (backfilled by cmdReconcile, or set at spawn time).
      wsName: names.readName(home, w.id),
    };
    if (instInfo) row.instances = instInfo.instances;
    // Unknown read position: show the direct count as unknown (null, like a
    // native row), never the summary's conservative total as a measured count.
    if (w.unreadUnknown) { row.directUnread = null; row.unreadUnknown = true; }
    return row;
  });
  // Dedup by CANONICAL identity (inst.primaryWorkspaceId, which realpath-
  // normalizes before hashing), not raw string equality — the same fix class
  // as resolvePrimaryTarget: a raw `--show-toplevel` spelling and a
  // canonicalized one for the SAME real directory must collapse to one row.
  const knownIds = new Set(workspaces.map((w) => w.worktreePath).filter(Boolean).map((p) => inst.primaryWorkspaceId(p)));
  const nativeChildren = fetchNativeChildren(ctx);
  // A native row's id is the BRANCH NAME, but anti-hall's archive marker is
  // archived/<uuid>.json — every id-keyed archive predicate misses it (and
  // isSafeId rejects a `/` branch outright), so an archived workspace whose
  // worktree is still listed natively read as live next to its own archived
  // row. Join by canonical worktree identity instead (same primaryWorkspaceId
  // dedup key as above), restricted to THIS project's archived descriptors.
  const archivedByWt = new Map();
  try {
    const ads = checkedArchivedDir(home);
    if (ads.ok && ads.exists) {
      for (const n of fs.readdirSync(ads.path)) {
        if (!/\.json$/.test(n)) continue;
        const aid = n.slice(0, -'.json'.length);
        try {
          if (!isSafeId(aid)) continue;
          const d = readDescriptorPathState(path.join(ads.path, n)).descriptor;
          if (!d || String(d.id) !== aid || !d.worktreePath) continue;
          if (descriptorPhysicalOwnerKey(d) !== repoKey) continue;
          const k = rosterMeshId(d.worktreePath);
          if (k && !archivedByWt.has(k)) archivedByWt.set(k, aid);
        } catch (_) { /* skip this descriptor */ }
      }
    }
  } catch (_) { /* fail-open: no fold, native rows project as before */ }
  for (const child of nativeChildren) {
    if (child.path && knownIds.has(inst.primaryWorkspaceId(child.path))) continue; // already represented via the store
    const archivedId = child.path ? archivedByWt.get(rosterMeshId(child.path)) : null;
    // The app's own DB saying this worktree is ACTIVE outranks a stale marker
    // (a path reused by a newer live workspace must never read archived).
    let appActive = false;
    if (archivedId) {
      try { appActive = rosterElig.of({ id: '', worktreePath: child.path, repoKey }).appActive === true; } catch (_) { appActive = false; }
    }
    if (archivedId && !appActive) {
      const prior = workspaces.find((w) => w.id === archivedId);
      if (prior) { prior.foldedNative = (prior.foldedNative || []).concat(String(child.branch || child.id)); continue; }
      const hints = rosterHints(home, archivedId, child.path, now, null, { repoKey, env: ctx.env, cache: appArchivedCache, elig: rosterElig, registryBacked: false });
      if (!hints.includes('archived')) hints.unshift('archived');
      workspaces.push({
        id: archivedId, working_on: null, directUnread: null, broadcastUnread: null, urgencyMax: null,
        worktreePath: child.path, source: 'archived', meshId: rosterMeshId(child.path),
        hints, wsName: child.label || null, foldedNative: [String(child.branch || child.id)],
      });
      continue;
    }
    const id = child.branch || child.id || null;
    workspaces.push({
      id, working_on: null,
      directUnread: null, broadcastUnread: null, urgencyMax: null,
      worktreePath: child.path || null, source: 'native',
      meshId: rosterMeshId(child.path || null),
      hints: rosterHints(home, id, child.path || null, now, null, { repoKey, env: ctx.env, cache: appArchivedCache, elig: rosterElig, registryBacked: false }), // native hivecontrol child has no mesh descriptor / sessionId — never eligible for `phantom` (E fix)
      // wsName: hivecontrol's own `label`, straight from this native fold —
      // no fs cache lookup needed here, we already have the live value.
      wsName: child.label || null,
    });
  }
  // Fix 1 (split-brain heal, READ-ONLY): a Primary registered into the LEGACY
  // hash bucket store/<hashFromWorkspaceId(primary-<hash>)>/ (when repoKey was
  // transiently null at register time) is invisible to the repoKey-keyed
  // computeSummary above — the roster would read "no primary". If this project's
  // Primary is NOT already represented, fold in its hash-bucket entry so it is
  // surfaced (labeled source:'store-fallback'). Pure read: never writes into
  // either store. Fail-open: any error leaves the base roster untouched.
  //
  // P2-9: read the hash bucket's ALREADY-DERIVED summary.json via
  // store.readSummaryForHash — NOT openStore()+computeSummary, which MATERIALIZES
  // the bucket (dir/DB/WAL/schema) as a side effect of a pure read verb. A bucket
  // that does not exist reads as null (no fold), creating nothing.
  try {
    const main = inst.resolveMainWorktree(cwd);
    if (main) {
      const primaryMeshId = inst.primaryWorkspaceId(main);
      const fallbackHash = store.hashFromWorkspaceId(primaryMeshId);
      const alreadyKnown = knownIds.has(primaryMeshId) || workspaces.some((w) => w.id === primaryMeshId);
      if (fallbackHash && fallbackHash !== repoKey && !alreadyKnown) {
        const sum2 = store.readSummaryForHash(home, fallbackHash);
        const pw = sum2 && sum2.workspaces && sum2.workspaces[primaryMeshId];
        if (pw) {
          workspaces.push({
            id: pw.id, working_on: pw.working_on, directUnread: pw.directUnread,
            broadcastUnread: pw.broadcastUnread, urgencyMax: pw.urgencyMax,
            worktreePath: pw.worktreePath || null, source: 'store-fallback',
            meshId: rosterMeshId(pw.worktreePath),
            hints: rosterHints(home, pw.id, pw.worktreePath, now, pw.sessionId, { repoKey: fallbackHash, env: ctx.env, cache: appArchivedCache, elig: rosterElig, registryBacked: true }),
            wsName: names.readName(home, pw.id),
          });
        }
      }
    }
  } catch (_) { /* fail-open: the split-brain fallback fold never breaks the base roster */ }
  // Read-only, fail-open scan of archived/ so an already-archived id stays
  // VISIBLE on the roster (labeled, never re-written — archived/ remains a
  // pure move target; this never folds back into the store registry).
  const knownRosterIds = new Set(workspaces.map((w) => w.id).filter(Boolean));
  let archivedNames = [];
  const archiveDirState = checkedArchivedDir(home);
  if (archiveDirState.ok && archiveDirState.exists) {
    try { archivedNames = fs.readdirSync(archiveDirState.path); } catch (_) { archivedNames = []; }
  }
  for (const n of archivedNames) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -'.json'.length);
    if (knownRosterIds.has(id)) continue;
    try {
      if (!isSafeId(id)) continue;
      const state = readDescriptorPathState(path.join(archiveDirState.path, n));
      const d = state.descriptor;
      if (!d || String(d.id) !== id || !d.worktreePath) continue;
      const archivedOwnerKey = descriptorPhysicalOwnerKey(d);
      if (!archivedOwnerKey || archivedOwnerKey !== repoKey) continue;
    } catch (_) { continue; }
    workspaces.push({
      id, working_on: null, directUnread: null, broadcastUnread: null, urgencyMax: null,
      worktreePath: null, source: 'archived', meshId: null, hints: ['archived'],
    });
  }
  for (const w of workspaces) w.appArchived = null; // null = unknown (no app DB / no matching builder)
  // anti-hall archived it, the app still shows it live: surfaced (never hidden) with the exact fix.
  let appStillLive = null;
  try {
    const found = localArchivedAppLive(home, { env: ctx.env, now, repoKey });
    if (found.rows.length) {
      appStillLive = {
        count: found.rows.length,
        rows: found.rows.map((r) => ({ id: r.id, appId: r.appId, branch: r.branch, label: r.label, cmd: r.cmd })),
        message: 'app still shows ' + found.rows.length + ' workspace(s) you archived — run: ' + found.rows.map((r) => r.cmd).join(' ; '),
      };
      for (const r of found.rows) {
        const row = workspaces.find((x) => String(x.id) === r.id);
        if (row && Array.isArray(row.hints) && !row.hints.includes('app-live')) row.hints.push('app-live');
      }
    }
  } catch (_) { appStillLive = null; }
  // v0.108.0: the DevSwarm app DB (read-only, fail-open) — the app's title wins
  // over the names cache, each matched row gains `app` { rank, pinned, focused,
  // finish, brief, builderType }, and rows are ordered by sidebar rank (stable:
  // rows the app does not know keep their relative order, after the ranked ones).
  try {
    const appDb = require('../../companion/lib/devswarm-app-db.js');
    const snap = appDb.snapshot({ home, env: ctx.env, now });
    if (snap) {
      const focused = appDb.focusedWorkspaceId(snap, now);
      for (const w of workspaces) {
        const ws = appDb.workspaceFor(snap, { id: w.id, worktreePath: w.worktreePath });
        if (!ws) continue;
        // appArchived: the app DB's verdict for this row (true archived / false live); null stays = unknown.
        w.appArchived = ws.archived === true ? true : (ws.active === true ? false : null);
        if (ws.label) w.wsName = ws.label;
        const brief = appDb.briefDelivery(snap, ws, now);
        w.app = { rank: ws.rank, pinned: ws.isPinned, focused: ws.id === focused, finish: appDb.finishSignal(ws), brief: brief ? brief.status : null, builderType: ws.builderType };
      }
      const rk = (w) => (w.app && Number.isFinite(w.app.rank) ? w.app.rank : Infinity);
      workspaces.forEach((w, i) => { w.__i = i; });
      workspaces.sort((a, b) => (rk(a) - rk(b)) || (a.__i - b.__i));
      workspaces.forEach((w) => { delete w.__i; });
    }
  } catch (_) { /* fail-open: the roster without app-DB enrichment */ }
  // 0.108.4 ghost row: a child's `primary-<hash>` label (aliased, retired, or on
  // a worktree the app gives to another builder) folds into its canonical row
  // — one row per workspace. Its direct unread is carried over, never dropped.
  try {
    const aliasLib = require('../../companion/lib/devswarm-sender-alias.js');
    const aliases = aliasLib.readAliases(home);
    let appDb = null; let snap = null;
    try { appDb = require('../../companion/lib/devswarm-app-db.js'); snap = appDb.snapshot({ home, env: ctx.env, now }); } catch (_) { snap = null; }
    const present = new Set(workspaces.map((w) => (w.id != null ? String(w.id) : null)).filter(Boolean));
    const byId = new Map(workspaces.map((w) => [String(w.id), w]));
    const kept = [];
    for (const w of workspaces) {
      let appBuilderId = null;
      if (snap && w.worktreePath) {
        try {
          const ws = appDb.workspaceFor(snap, { worktreePath: w.worktreePath });
          if (ws && ws.builderType !== 'primary') appBuilderId = ws.id;
        } catch (_) { appBuilderId = null; }
      }
      const to = w.id != null ? aliasLib.rosterFoldTarget(home, String(w.id), present, { aliases, appBuilderId }) : null;
      const target = to ? byId.get(to) : null;
      if (!target || target === w) { kept.push(w); continue; }
      // A canonical row with directUnread null (e.g. an archived-scan row)
      // still receives the ghost's unread — never dropped — and its hints.
      if (Number.isFinite(w.directUnread) && w.directUnread > 0) {
        target.directUnread = (Number.isFinite(target.directUnread) ? target.directUnread : 0) + w.directUnread;
      }
      if (Array.isArray(w.hints) && w.hints.length) {
        const merged = Array.isArray(target.hints) ? target.hints.slice() : [];
        for (const h of w.hints) if (!merged.includes(h)) merged.push(h);
        target.hints = merged;
      }
      target.foldedAliases = (target.foldedAliases || []).concat(String(w.id));
    }
    workspaces.length = 0;
    for (const w of kept) workspaces.push(w);
  } catch (_) { /* fail-open: the unfolded roster */ }
  // Plan tracking (Meeseeks P1): a row whose workspace has a step plan gains a
  // `plan` field; a row without one is left exactly as it was.
  try {
    if (planLib.planTrackingEnabled({ env: ctx.env, home })) {
      for (const w of workspaces) {
        if (!w || w.source === 'archived') continue;
        const found = planLib.findPlan(home, { id: w.id, worktreePath: w.worktreePath });
        if (!found) continue;
        const cur = planLib.currentStep(found.plan);
        w.plan = {
          label: planLib.finishLabel(found.plan, now),
          step: cur ? cur.n : null, of: found.plan.steps.length, done: planLib.stepsDone(found.plan),
          stepText: cur ? cur.text : null,
          extras: (found.plan.extras || []).map((e) => ({ glob: e.glob, note: e.note })),
        };
        // Token burn (Meeseeks P2): only once the supervisor has read the
        // child's transcript; otherwise the P1 shape is unchanged.
        const tu = require('../../companion/lib/devswarm-token-usage.js');
        const tok = tu.readState(home, found.key);
        if (tok && Number.isFinite(tok.total) && tok.total > 0) {
          w.plan.tokens = { total: Math.round(tok.total), sinceStep: Math.round(tok.sinceStep || 0) };
          if (w.plan.label) w.plan.label += ' · ' + tu.fmt(tok.total) + ' tok';
        }
        // Straying warnings with any Jev recommendation (the Primary decides).
        const stray = planLib.readStray(home, found.key);
        if (stray && Array.isArray(stray.active) && stray.active.length) {
          w.plan.straying = stray.active.map((a) => ({ signal: a.signal, step: a.step, reason: a.reason,
            jev: Array.isArray(a.jev) ? a.jev.map((n) => ({ integration: n.integration, verdict: n.verdict, confidence: n.confidence })) : [] }));
        }
      }
    }
  } catch (_) { /* fail-open: the roster without plan fields */ }
  return {
    ok: true, action: 'roster', repoKey,
    known: !storeUnavailable, storeUnavailable, storeUnavailableReason, storeUnavailableScope,
    count: workspaces.length, workspaces, recent: sum.recent || [],
    ...(appStillLive ? { appStillLive } : {}),
    // live vs archived split of `count` — a row is archived when it is labelled
    // source:'archived' or carries the `archived` hint (app-archived rows too).
    liveCount: workspaces.filter((w) => !(w.source === 'archived' || (w.hints || []).includes('archived'))).length,
    archivedCount: workspaces.filter((w) => w.source === 'archived' || (w.hints || []).includes('archived')).length,
  };
}

// cmdDiagnose(flags, ctx) — READ-ONLY mesh-health projection (#62). Uses the PURE
// store.computeSummary (ZERO summary.json write) plus the shared registry to show,
// per worktree: each registry row (id, worktreePath, sessionId, unread, live?),
// which partition a `send` to that worktree's meshId resolves to (resolveMeshTarget
// — the SAME freshest-live routing `send` uses), the orphan partitions +
// stale-registry rows computeSummary surfaces (Phase A), and any worktree carrying
// 2+ LIVE rows flagged as a "split" (the un-converged case a submodule / separate
// git root shows up as — surfaced here, NEVER auto-merged). Project-scoped like
// roster (no id arg, keyed off cwd's repoKey). Purity is the point: an orchestrator
// can SEE mesh state without the read itself mutating anything.
// pickStoreReadErrorScope(s) -> { code, scope: 'registry'|'store' } | null.
// R2 Critic P2-9 (defect 77d5a5bbf614): `s.getReadError()` (singular) returns
// the FIRST entry of the per-file error Map in INSERTION order — but
// computeSummary reads the shared broadcast partition (messages.ndjson)
// BEFORE calling listRegistry() (registry.ndjson). If messages.ndjson ALSO
// carries an unrelated read error (any genuine fs error, not just registry
// breakage), the singular probe returned THAT error first and every caller
// labeled it "registry unreadable" even when registry.ndjson itself was
// perfectly readable — a misattribution. Fixed by reading the FULL set via
// getReadErrors() and explicitly matching the registry.ndjson path: when
// found, scope is 'registry' (the specific, actionable claim); when the
// store carries some OTHER read error but not one for registry.ndjson, scope
// is the generic 'store' (still genuinely unavailable — just not provably a
// registry-specific outage). getReadErrors() is journal-backend-only
// (sqlite always returns null/[] — see that handle's own header); this
// degrades to the old singular probe when getReadErrors() is unavailable or
// empty, so a backend without the plural API loses only the finer
// attribution, never the underlying storeUnavailable signal.
function pickStoreReadErrorScope(s) {
  let errors = [];
  try { errors = (s.getReadErrors && s.getReadErrors()) || []; } catch (_) { errors = []; }
  if (!errors.length) {
    try {
      const single = s.getReadError && s.getReadError();
      if (single) errors = [single];
    } catch (_) { errors = []; }
  }
  if (!errors.length) return null;
  const registryErr = errors.find((e) => e && typeof e.path === 'string' && /registry\.ndjson$/.test(e.path));
  if (registryErr) return { code: registryErr.code || 'EUNKNOWN', scope: 'registry' };
  return { code: (errors[0] && errors[0].code) || 'EUNKNOWN', scope: 'store' };
}

// computeDiagnosis(s, ctx) — the ONE mesh-health computation shared by cmdDiagnose,
// cmdHealthcheck (#71), and the doctor mesh-shape CHECK. Takes an OPEN store handle
// `s` (pure — computeSummary NEVER writes summary.json) and returns the fully
// derived pieces; callers add their own envelope + presentation. Groups via the
// shared groupRegistryByMeshId (canonical git-toplevel identity, so subdir-splits
// fold), so `send --to <meshId>` routing (resolveMeshTarget) and split detection
// agree with the fold. Adds two aggregate counts not surfaced by `diagnose`'s object
// today: `phantoms` (rows with no live sessionId) and `unreadTotal` (Σ directUnread).
function computeDiagnosis(s, ctx) {
  const c = ctx || {};
  const sum = store.computeSummary(s, { home: c.home, env: c.env, now: c.now });
  const registry = s.listRegistry();
  // defect 77d5a5bbf614: computeSummary/listRegistry above both swallow a
  // genuine registry.ndjson read error (EACCES/ENOTDIR/...) to an empty
  // array (readAll's documented fail-open contract — see devswarm-store.js).
  // Pre-fix, that made an unreadable registry indistinguishable from a
  // genuinely empty one: roster/diagnose/healthcheck all read "0 workspaces,
  // healthy" for a chmod-000 store. Probe HERE, right after the
  // listRegistry() call above (the SAME probe-right-after-read idiom used
  // throughout this file, e.g. cmdInboxRead/cmdInboxCount). pickStoreReadErrorScope
  // (R2 Critic P2-9) attributes the error to the registry specifically only
  // when it is actually registry.ndjson — the computeSummary call a few
  // lines up reads messages.ndjson (the broadcast partition) BEFORE its own
  // internal listRegistry(), so a naive "first error wins" probe could
  // misattribute an unrelated messages.ndjson outage as "registry
  // unreadable". Fail-open: a throw from the probe itself must never block
  // diagnosis.
  let storeUnavailable = false;
  let storeUnavailableReason = null;
  let storeUnavailableScope = null;
  try {
    const picked = pickStoreReadErrorScope(s);
    if (picked) { storeUnavailable = true; storeUnavailableReason = picked.code; storeUnavailableScope = picked.scope; }
  } catch (_) { storeUnavailable = false; storeUnavailableReason = null; storeUnavailableScope = null; }
  const byMesh = groupRegistryByMeshId(registry, c.home);
  const meshTargets = [];
  const splits = [];
  const deadSplits = [];
  const mixedSplits = [];
  // TRACED P0 fix: the predicate used to be two INDEPENDENT checks —
  // `liveSplit = liveRows>=2` and `deadSplit = rows.length>=2 && liveRows===0`
  // — which left EXACTLY ONE shape uncovered: `rows.length>=2 && liveRows===1`
  // (one live row, one+ dead rows sharing a meshId). Neither check matched it,
  // so it scored split:false/deadSplit:false/splits:[] — invisible, even
  // though `send` can resolve to either row and a stranded child never
  // receives mail routed to the dead one (field-reported: meshId
  // `primary-bf04dd47`, liveRows:1, splits:[] while sends had to be
  // redirected to a live partition UUID). Fixed by classifying from ONE
  // predicate: any group with `rows.length >= 2` IS partitioned, and its
  // KIND is derived from liveRows — `live` (2+ live, may be benign, e.g. two
  // live tabs), `mixed` (exactly 1 live — the previously-invisible dangerous
  // shape, mail CAN reach the live row but a second send picking the dead
  // row strands), `dead` (0 live — HAZARD 2, nobody draining either row).
  // `splits`/`deadSplits`/`split`/`deadSplit` keys are PRESERVED byte-
  // identical for existing consumers (docs/KB-devswarm-hivecontrol.md,
  // healthcheckHumanLine, cmdHealthcheck's `degraded` gate) — `kind` and
  // `mixedSplit`/`mixedSplits` are ADDED alongside, never replacing them.
  // try/catch keeps this fail-open — a throw here must never block
  // diagnose/healthcheck.
  for (const g of byMesh.values()) {
    let target = null;
    let liveSplit = false;
    let deadSplit = false;
    let mixedSplit = false;
    let kind = null; // 'live' | 'mixed' | 'dead' | null (not partitioned — <2 rows)
    try {
      target = resolveMeshTarget(s, g.meshId, c.home); // the partition `send --to <meshId>` lands in
      if (g.rows.length >= 2) {
        if (g.liveRows >= 2) { kind = 'live'; liveSplit = true; }
        else if (g.liveRows === 1) { kind = 'mixed'; mixedSplit = true; }
        else { kind = 'dead'; deadSplit = true; }
      }
    } catch (_) { target = null; liveSplit = false; deadSplit = false; mixedSplit = false; kind = null; }
    const split = liveSplit; // preserved meaning: unchanged for existing consumers
    if (liveSplit) splits.push(g.meshId);
    if (deadSplit) deadSplits.push(g.meshId);
    if (mixedSplit) mixedSplits.push(g.meshId);
    meshTargets.push({
      meshId: g.meshId, resolvesTo: target ? target.id : null, ids: g.ids,
      liveRows: g.liveRows, split, deadSplit, mixedSplit, kind,
    });
  }
  const workspaces = sum.workspaces || {};
  // `live` derivation (FIX: was a bare isLiveSessionId(sessionId) string test —
  // see the header comment at ~line 199 and companion/lib/liveness.js's own
  // header for the two symptoms this closes). Now heartbeat/staleness-aware,
  // wired to the EXISTING liveness module (hasFreshHeartbeat / isDormantRow)
  // rather than inventing a new mechanism:
  //   1. a FRESH heartbeat is definitive proof-of-life (liveness.js header:
  //      "emitted ONLY by the workspace's OWN live session") -> live, even if
  //      sessionId is null/absent OR `unclaimed:`-prefixed (closes the
  //      false-negative symptom: only hooks/devswarm-child-turn.js ever
  //      stamps a real sessionId; other paths write null or a synthetic
  //      `unclaimed:` marker, and a fresh heartbeat is a STRONGER, orthogonal
  //      signal than that marker — the marker exists to stop ROUTING into a
  //      partition nothing drains, not to assert the process is dead).
  //   2. `unclaimed:`-prefixed sessionId with NO fresh heartbeat -> ALWAYS
  //      not-live (the phantom-row case: a registry row with no process and
  //      no real sessionId ever stamped).
  //   3. else, a real (non-synthetic) sessionId with NO stale-past-threshold
  //      activity (isDormantRow — the SAME read-side dormancy rule rosterHints
  //      already uses) -> live. A real sessionId whose heartbeat/activity has
  //      gone stale past the dormancy window is NOT live (closes the
  //      false-positive symptom: closing a workspace leaves its registry row
  //      untouched, so a once-real sessionId used to be trusted forever).
  //   4. no real sessionId and no fresh heartbeat -> not live (unchanged from
  //      before for this shape).
  // NOTE: this heartbeat rescue is DISPLAY-ONLY (rows[].live). Routing/fold
  // signals (liveRows/kind/split/deadSplit in groupRegistryByMeshId, ~line
  // 1795) use isLiveSessionId(sessionId) directly and still treat
  // `unclaimed:` as unconditionally not-live — unaffected by this block.
  // isDormantRow is itself fail-open (no signal at all -> not dormant, per its
  // own doc), so a row with NO heartbeat/transcript signal at all (e.g. a
  // freshly-seeded row in a test, or a workspace never yet heartbeat-capable)
  // degrades to the SAME "live" verdict the old bare-sessionId test gave it —
  // an honest "unknown -> not newly downgraded" default, not a guess in
  // either direction. try/catch keeps this fail-open against any throw from a
  // malformed row, falling back to the OLD bare-sessionId signal so a bug in
  // the liveness read path can never make computeDiagnosis itself throw.
  // DESCRIPTOR/REGISTRY DIVERGENCE FIX (defect 2c4ae6576fab): promoteUnclaimedSession
  // writes the descriptor FIRST, then the registry (~:4529-4541) — the registry
  // write is wrapped in a swallowing try/catch ("descriptor already promoted;
  // registry retries next call"), so a registry write that fails (or is simply
  // never retried, e.g. no later read of that id) leaves the registry's
  // sessionId stuck at the `unclaimed:<id>` marker even after the descriptor has
  // genuinely been promoted to a real session id. `rows` used to read ONLY the
  // registry row (s.listRegistry()), so a row in exactly this state displayed the
  // STALE marker and `live:false` even though workspaces/<id>.json already held
  // the true identity — VERIFIED reproducible: seed a descriptor with a real
  // sessionId and a registry row for the SAME id still carrying the `unclaimed:`
  // marker; pre-fix diagnose printed the marker and live:false for it. Resolve
  // through the descriptor whenever the registry's own sessionId is absent or
  // still synthetic AND the descriptor holds a genuine (non-empty, non-
  // tautological, non-`unclaimed:`) id — the same definition of "real" used by
  // realSessionIdFrom (~:4508). The reverse shape (registry already ahead of the
  // descriptor) already read correctly, since the registry was read directly;
  // that path is unchanged — this only widens what `sid` can resolve to. When the
  // descriptor and registry disagree, `descriptorSessionId` carries the raw
  // descriptor value alongside the resolved `sessionId`, rather than silently
  // dropping the stale value on the floor.
  const isRealSid = (v, id) => (
    v != null && String(v).trim() !== ''
    && String(v) !== String(id)
    && !String(v).startsWith(SYNTHETIC_SESSION_PREFIX)
  );
  // App-side archived-set cache (D11-C, defect 07e01aee4f1f): read ONCE per
  // diagnose call — the SAME supervisor-written cache rosterHints reads via
  // `opts.cache` — rather than once per row, mirroring cmdRoster's own
  // single up-front read (~line 9761). Fail-open to null on any error; a null
  // cache just means `archivedCacheLib.isAppArchived` degrades to "not
  // app-archived" for every row (its own documented fail-open contract).
  let appArchivedCache = null;
  try { appArchivedCache = archivedCacheLib.readActiveCache({ home: c.home, env: c.env, now: c.now }); } catch (_) { appArchivedCache = null; }
  const diagElig = rowEligibilityLib.createContext({ home: c.home, env: c.env, cache: appArchivedCache, now: c.now, log: cliRowLog });
  const rows = registry.filter((d) => d && d.id != null).map((d) => {
    const w = workspaces[d.id] || {};
    const registrySid = d.sessionId || null;
    let desc = null;
    try { desc = readDescriptorFile(c.home, d.id); } catch (_) { desc = null; }
    const descriptorSid = desc && desc.sessionId != null ? String(desc.sessionId) : null;
    let sid = registrySid;
    if (!isRealSid(registrySid, d.id) && isRealSid(descriptorSid, d.id)) sid = descriptorSid;
    // ARCHIVED-STILL-LIVE FIX (D11-C, defect 07e01aee4f1f): an app-archived
    // workspace's registry row can still carry a fresh heartbeat/live
    // sessionId (foldArchivedRowsPostUpdate hasn't retired it yet, or a
    // safety gate left it in place), and diagnose reported `live:true` for a
    // row the operator had already put away. Mirror rosterHints' own archived
    // test EXACTLY (local anti-hall archive marker first, then the app-side
    // supervisor-cached archived-set check via a repoKey resolved from the
    // SAME descriptor already read above for this row — descriptorRegisteredRepoKey,
    // same primitive rosterHints' caller uses) so diagnose and the roster can
    // never disagree about which rows are archived. Additive `archivedInApp`
    // alongside the existing `live` field; deliberately NOT gated on
    // sessionPidAlive/hasFreshHeartbeat — a fresh heartbeat is orthogonal to
    // "was this put away", so it must never suppress the archived label.
    let archivedInApp = false;
    try {
      archivedInApp = diagElig.of({
        id: d.id, worktreePath: d.worktreePath,
        sessionId: isRealSid(sid, d.id) ? sid : null,
        repoKey: (() => { try { return descriptorRegisteredRepoKey(desc, d.id) || null; } catch (_) { return null; } })(),
      }).archived;
    } catch (_) { archivedInApp = false; }
    let live = false;
    if (!archivedInApp) {
      // computeRowLive (defect 298b79969409): the ONE display-liveness
      // predicate shared with rosterHints' phantom check, below.
      live = computeRowLive({ id: d.id, worktreePath: d.worktreePath, sessionId: sid }, c.home, { now: c.now });
    }
    const row = {
      id: d.id,
      worktreePath: d.worktreePath || null,
      sessionId: sid,
      live,
      unread: Number.isFinite(w.unread) ? w.unread : 0,
      archivedInApp,
    };
    if (descriptorSid != null && descriptorSid !== registrySid) row.descriptorSessionId = descriptorSid;
    return row;
  });
  const phantoms = rows.filter((r) => !r.live).length;
  let unreadTotal = 0;
  for (const id of Object.keys(workspaces)) {
    const w = workspaces[id];
    if (w && Number.isFinite(w.directUnread)) unreadTotal += w.directUnread;
  }
  // instanceSplits (defect d3d571495bf6, item c): rows sharing a mesh id whose
  // divergence is only their instanceNonce (same underlying registry identity,
  // 2+ live OS processes) — distinct from splits/deadSplits/mixedSplits above,
  // which key on live REGISTRY rows, not process identity. Same broadcast-scan
  // source and freshness window as `roster`'s instance-split hint
  // (computeInstanceNonceCounts), computed here from the SAME open store `s`
  // so no second store open is needed.
  let broadcastAllForInstances = [];
  try { broadcastAllForInstances = typeof s.listMessages === 'function' ? s.listMessages(store.BROADCAST_PARTITION_ID) : []; }
  catch (_) { broadcastAllForInstances = []; }
  const diagnosisNow = Number.isFinite(c.now) ? c.now : Date.now();
  const instanceNonceCounts = computeInstanceNonceCounts(broadcastAllForInstances, diagnosisNow, DEFAULT_HEARTBEAT_FRESH_MS);
  const instanceSplits = [];
  for (const r of rows) {
    const info = instanceNonceCounts.get(String(r.id));
    if (info && info.instances > 1) {
      instanceSplits.push({
        id: r.id, sessionId: r.sessionId,
        instances: info.instances,
        nonces: info.nonces.map((n) => shortInstanceNonce(n)),
      });
    }
  }
  // cursorWrites (defect 8b211241bbe9) — the last few cursor advances PER ID,
  // read from the append-only journal. This is the surfacing the design
  // promised: the field defect was diagnosed twice from symptoms alone because
  // no writer left a trace, so `diagnose` now shows who moved what. Bounded
  // (CURSOR_WRITES_PER_ID newest per id) so a long-lived log cannot bloat the
  // output, and fail-open — an unreadable journal simply yields {}.
  const cursorWrites = {};
  try {
    const rk = (c.repoKey) || repoKeyForCwd(c) || null;
    const recs = readCursorLog(c.home, rk, CURSOR_LOG_DIAGNOSE_SCAN);
    for (const rec of recs) {
      if (!rec || rec.id == null) continue;
      const k = String(rec.id);
      if (!cursorWrites[k]) cursorWrites[k] = [];
      cursorWrites[k].push(rec);
      if (cursorWrites[k].length > CURSOR_WRITES_PER_ID) cursorWrites[k].shift();
    }
  } catch (_) { /* fail-open: instrumentation, never a diagnose failure */ }
  return {
    sum, registry: rows, meshTargets, splits, deadSplits, mixedSplits,
    orphans: sum.orphans || [],
    // held by owner (devswarm.heldPartitions) — diverted out of `orphans`
    // by computeSummary; reported here (not silently dropped) so
    // `diagnose`/`doctor` still show them, distinctly, as owner-held.
    heldPartitions: sum.heldPartitions || [],
    staleRegistryPartitions: sum.staleRegistryPartitions || [],
    phantoms, unreadTotal, instanceSplits,
    cursorWrites,
    storeUnavailable, storeUnavailableReason, storeUnavailableScope,
  };
}

function cmdDiagnose(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  // SURFACING FIX (field defect c55896250399): computeDiagnosis already
  // classifies the exactly-1-live case correctly (`kind:'mixed'`,
  // `mixedSplits` populated — verified: mixedSplits[] carries the meshId for
  // a 2-row/1-live group exactly like deadSplits/splits do for their kinds).
  // The gap was never the classification, it was that `diagnose` — unlike
  // `healthcheck` — had NO explicit call-out: its JSON is a flat dump with no
  // `warning`/`degraded` field, so a caller who checks only the benign
  // `splits` array (which correctly stays [] for the mixed/dead kinds — that
  // field's meaning is "2+ LIVE rows", unchanged) sees nothing and concludes
  // "no split", even though `mixedSplits`/`deadSplits` already carried it.
  // Reporting-only: adds two NEW fields, touches no existing key, and drives
  // no fold/retire/adopt/tombstone decision.
  const dangerCount = d.deadSplits.length + d.mixedSplits.length;
  // defect 77d5a5bbf614: a genuinely unreadable registry (storeUnavailable)
  // outranks every split-shape warning below — the registry-derived counts
  // (splits/deadSplits/etc) all read as an honest-looking zero against an
  // empty fallback array, so `degraded`/`warning` must reflect the outage
  // FIRST, never let a clean-looking split tally paper over it.
  const degraded = d.storeUnavailable || dangerCount > 0 || d.splits.length > 0;
  let warning = null;
  if (d.storeUnavailable) {
    // R2 Critic P2-9: only claim "registry" specifically when the read error
    // was actually attributed to registry.ndjson (see pickStoreReadErrorScope);
    // an unrelated store file breaking gets the honest generic "store" label.
    const noun = d.storeUnavailableScope === 'registry' ? 'registry' : 'store';
    warning = noun + ' unreadable (' + (d.storeUnavailableReason || 'EUNKNOWN') + ') — counts below are unknown, not verified-zero';
  }
  if (d.deadSplits.length > 0) {
    const deadMsg = d.deadSplits.length + ' dead split(s) (2+ registry rows, no live session draining either — mail can strand)';
    warning = warning ? warning + '; ' + deadMsg : deadMsg;
  }
  if (d.mixedSplits.length > 0) {
    const mixedMsg = d.mixedSplits.length + ' mixed split(s) (2+ registry rows, exactly 1 live — a send can still resolve to the dead row)';
    warning = warning ? warning + '; ' + mixedMsg : mixedMsg;
  }
  return {
    ok: true, action: 'diagnose', repoKey,
    known: !d.storeUnavailable,
    storeUnavailable: d.storeUnavailable, storeUnavailableReason: d.storeUnavailableReason,
    storeUnavailableScope: d.storeUnavailableScope,
    count: d.registry.length, registry: d.registry,
    meshTargets: d.meshTargets, splits: d.splits, deadSplits: d.deadSplits, mixedSplits: d.mixedSplits,
    orphans: d.orphans,
    heldPartitions: d.heldPartitions, // owner-held (devswarm.heldPartitions) — held by owner, not an orphan
    staleRegistryPartitions: d.staleRegistryPartitions,
    degraded, warning,
  };
}

// diagnoseHumanLine(result) — the DEFAULT (non-`--json`) render of `diagnose`,
// giving it the same explicit-WARNING human summary `healthcheck` already has
// (healthcheckHumanLine above) instead of leaving callers to notice
// deadSplits/mixedSplits buried in a raw JSON dump.
function diagnoseHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'diagnose: no-project (cwd is not inside a DevSwarm project)';
  const parts = [
    'registry=' + (r.count || 0),
    'splits=' + (r.splits ? r.splits.length : 0),
    'deadSplits=' + (r.deadSplits ? r.deadSplits.length : 0),
    'mixedSplits=' + (r.mixedSplits ? r.mixedSplits.length : 0),
    'orphans=' + (r.orphans ? r.orphans.length : 0),
    'held=' + (r.heldPartitions ? r.heldPartitions.length : 0),
    'stale=' + (r.staleRegistryPartitions ? r.staleRegistryPartitions.length : 0),
  ];
  const scope = r.repoKey ? ' (scope: ' + r.repoKey + ')' : '';
  const status = r.degraded ? 'degraded' : 'ok';
  const warning = r.warning ? ' — WARNING: ' + r.warning : '';
  return 'diagnose: ' + status + scope + ' [' + parts.join(' ') + ']' + warning;
}

// cmdHealthcheck(flags, ctx) — #71: a scriptable PASS/FAIL gate over the SAME data
// `diagnose` computes (computeDiagnosis — one source, two presentations). Unlike
// `diagnose` (always ok:true — a report), this turns mesh-shape drift into an exit
// signal: ok/exit 0 when healthy, ok:false/exit non-zero when degraded.
//   counts = { orphansWithUnread, stale, splits, phantoms, unreadTotal }, plus an
//   `orphans` alias (same value as orphansWithUnread — see rename note below).
//   degraded iff orphansWithUnread>0 || stale>0 || splits>0 (STRUCTURAL drift
//   only) — phantoms (a spawn-time placeholder, benign/transient) and
//   unreadTotal (normal mailbox backlog) are reported for visibility but NEVER
//   gate, so a freshly-spawned worktree does not trip a false "degraded". Pure
//   read (zero writes).
//
// FIX C rename: this count is d.orphans.length from computeDiagnosis/
// computeSummary's A2 detector, which is ALREADY filtered to unread>0 (real
// unread only — see computeSummary's orphans[] comment). It is scope-DIFFERENT
// from healOrphanPartitionsAllStores' `orphans`-shaped counters (heal sweeps
// EVERY store on the machine and counts every orphan regardless of unread;
// this opens only the cwd's ONE store and counts only unread>0 ones) — the two
// surfaces were measured printing 123 vs 0 for the SAME machine under the SAME
// label ("orphans"), which reads as a contradiction. Renaming to
// `orphansWithUnread` here names what this counter ACTUALLY measures; `orphans`
// is kept as an exact-value alias since it is part of this command's existing
// documented JSON contract (no known internal consumer greps `.counts.orphans`
// outside this file/its tests, but an external script might).
function cmdHealthcheck(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  const orphansWithUnread = d.orphans.length;
  const counts = {
    orphansWithUnread,
    orphans: orphansWithUnread, // alias — see rename note above
    stale: d.staleRegistryPartitions.length,
    splits: d.splits.length,
    deadSplits: d.deadSplits.length, // HAZARD 2 fix: 2+ rows, ZERO live — dangerous, gates degraded too
    // TRACED P0 fix: exactly 1 live row of 2+ — previously invisible (matched
    // neither `splits` nor `deadSplits`); gates degraded too, since a second
    // send can still resolve to the dead partition and strand.
    mixedSplits: d.mixedSplits.length,
    phantoms: d.phantoms,
    unreadTotal: d.unreadTotal,
  };
  // defect 77d5a5bbf614: an unreadable registry must gate `ok`/`status`
  // exactly like any other structural-drift signal — pre-fix, EACCES on
  // registry.ndjson silently read back as 0 rows through every count above,
  // so healthcheck reported `ok:true/status:'ok'` for an outage it never saw.
  const degraded = d.storeUnavailable || counts.orphansWithUnread > 0 || counts.stale > 0 || counts.splits > 0
    || counts.deadSplits > 0 || counts.mixedSplits > 0;
  return {
    ok: !degraded, action: 'healthcheck', repoKey,
    status: d.storeUnavailable ? 'store-unavailable' : (degraded ? 'degraded' : 'ok'),
    known: !d.storeUnavailable,
    storeUnavailable: d.storeUnavailable, storeUnavailableReason: d.storeUnavailableReason,
    storeUnavailableScope: d.storeUnavailableScope,
    counts,
    detail: {
      orphans: d.orphans,
      staleRegistryPartitions: d.staleRegistryPartitions,
      splits: d.splits,
      deadSplits: d.deadSplits,
      mixedSplits: d.mixedSplits,
    },
  };
}

// globToRegExp(glob) -> RegExp | null. Pure-Node, no dependency (repo
// convention). Small, deliberately NOT a full micromatch: `**` matches any
// number of path segments (including zero), `*` matches within one segment
// (never `/`), `?` matches one non-`/` char, everything else is escaped
// literally. Good enough for `--allow`'s use case (a short, human-typed
// allowlist of glob patterns), not a general gitignore engine. Returns null
// on a non-string/empty pattern rather than a regex that matches everything.
function globToRegExp(glob) {
  if (typeof glob !== 'string' || !glob) return null;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // swallow an immediately-following '/' so 'a/**/b' matches 'a/b' too
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  try { return new RegExp('^' + out + '$'); } catch (_) { return null; }
}

// cmdReadyCheck(sha, flags, ctx) -> generic, READ-ONLY readiness verdict for a
// child's "READY <sha>" claim (peer request A). Runs git read-only against
// THIS process's cwd (no fetch unless --fetch is passed) and reports:
//   ff                whether `base` is an ancestor of `sha` (merge-base
//                      --is-ancestor) — true/false/null (probe failed: git
//                      missing, timeout, sha/base unresolvable — NEVER read
//                      as a "not ff" fact, same doctrine as devswarm-git-
//                      truth.js's gitPushState)
//   files             { count, list } — the diff --stat file set between
//                      base and sha (base...sha, merge-base diff — the set of
//                      changes sha introduces since it diverged from base)
//   gitlinks          count of changed entries whose old OR new mode is
//                      160000 (a submodule pointer bump) — CLAUDE.md's own
//                      "never commit a submodule pointer bump you didn't
//                      intend" rule, surfaced mechanically here
//   deletions_under   count of DELETED files under any of --watch-deletions'
//                      dirs (comma/repeatable, e.g. '.planning,.omc') — empty
//                      list (the default) means this check is simply off, 0
//                      deletions reported, never a false positive
//   outside_allowed   files matching NONE of --allow's globs (comma/
//                      repeatable) — [] when --allow is omitted (no
//                      restriction configured, never treated as "everything
//                      is outside")
//   verdict           'ok' | 'review' | 'block' — block on a proven risk
//                      (not-ff, a gitlink change, a watched-dir deletion);
//                      review on an unproven probe (ff unknown) or an
//                      allowlist miss; ok otherwise
//   reasons[]         why, one entry per condition above that fired
// Never mutates anything, never fetches unless --fetch is explicitly passed.
function cmdReadyCheck(sha, flags, ctx) {
  const cwd = ctx.cwd || process.cwd();
  if (!sha || typeof sha !== 'string') return { ok: false, error: 'usage: devswarm.js ready-check <sha> [--base <ref>] [--allow glob,glob] [--watch-deletions dir,dir] [--fetch]' };
  const base = one(flags, 'base') || 'origin/main';
  const allowGlobs = csvList(flags, 'allow').map(globToRegExp).filter(Boolean);
  const watchDirs = csvList(flags, 'watch-deletions').map((d) => d.replace(/\/+$/, ''));
  const git = (args) => spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: gitTruth.GIT_TIMEOUT_MS });
  const reasons = [];
  if (hasFlag(flags, 'fetch')) {
    try { git(['fetch', '--quiet']); } catch (_) { /* best-effort; the checks below just work off whatever refs exist */ }
  }
  // ff: merge-base --is-ancestor exits 0 (true) / 1 (false, git resolved both
  // refs and definitively says base is NOT an ancestor) / other (unresolved
  // ref, spawn error, timeout — probe failed, null).
  let ff = null;
  {
    const r = git(['merge-base', '--is-ancestor', base, sha]);
    if (r && !r.error && r.signal == null) {
      if (r.status === 0) ff = true;
      else if (r.status === 1) ff = false;
    }
  }
  if (ff === false) reasons.push('not-ff');
  if (ff === null) reasons.push('ff-unknown');
  // Single `git diff --raw` call over base...sha (merge-base diff, the SAME
  // three-dot range `ff` above reasons about) serves files/gitlinks/deletions
  // together — one spawn, not three.
  const files = { count: 0, list: [] };
  let gitlinks = 0;
  const deletedPaths = [];
  const rawR = git(['diff', '--raw', '--no-renames', base + '...' + sha]);
  let diffKnown = false;
  if (rawR && !rawR.error && rawR.signal == null && rawR.status === 0) {
    diffKnown = true;
    for (const line of String(rawR.stdout || '').split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const meta = line.slice(1, tab).trim().split(/\s+/); // [oldMode, newMode, oldSha, newSha, status]
      const filePath = line.slice(tab + 1).trim();
      if (!filePath) continue;
      files.count++;
      files.list.push(filePath);
      const oldMode = meta[0], newMode = meta[1], status = (meta[4] || '')[0];
      if (oldMode === '160000' || newMode === '160000') gitlinks++;
      if (status === 'D') deletedPaths.push(filePath);
    }
  } else {
    reasons.push('diff-unknown');
  }
  if (gitlinks > 0) reasons.push('gitlinks-changed');
  let deletionsUnder = 0;
  if (diffKnown && watchDirs.length) {
    for (const p of deletedPaths) {
      if (watchDirs.some((d) => p === d || p.startsWith(d + '/'))) deletionsUnder++;
    }
    if (deletionsUnder > 0) reasons.push('deletions-under-watched-dirs');
  }
  let outsideAllowed = [];
  if (diffKnown && allowGlobs.length) {
    outsideAllowed = files.list.filter((p) => !allowGlobs.some((re) => re.test(p)));
    if (outsideAllowed.length) reasons.push('files-outside-allowed');
  }
  const blockReasons = new Set(['not-ff', 'gitlinks-changed', 'deletions-under-watched-dirs']);
  let verdict = 'ok';
  if (reasons.some((r) => blockReasons.has(r))) verdict = 'block';
  else if (reasons.length) verdict = 'review';
  return {
    ok: true, action: 'ready-check', sha, base, cwd,
    ff, files, gitlinks, deletions_under: deletionsUnder, outside_allowed: outsideAllowed,
    verdict, reasons,
  };
}

// healthcheckHumanLine(result) — the DEFAULT (non-`--json`) render of `healthcheck`:
// one compact line. `--json` prints the raw JSON object (main() decides which).
// Carries the `(scope: <repoKey>)` marker (FIX C) so `orphansWithUnread=0` never
// reads as a global all-clear it never was — this checks ONLY the cwd's own store,
// unlike healOrphanPartitionsAllStores' cross-machine sweep.
function healthcheckHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'healthcheck: no-project (cwd is not inside a DevSwarm project)';
  const c = r.counts || {};
  const orphansWithUnread = c.orphansWithUnread != null ? c.orphansWithUnread : c.orphans;
  const deadSplits = c.deadSplits || 0;
  const mixedSplits = c.mixedSplits || 0;
  const parts = [
    'orphansWithUnread=' + (orphansWithUnread || 0),
    'stale=' + (c.stale || 0),
    'splits=' + (c.splits || 0),
    'deadSplits=' + deadSplits,
    'mixedSplits=' + mixedSplits,
    'phantoms=' + (c.phantoms || 0),
    'unread=' + (c.unreadTotal || 0),
  ];
  const scope = r.repoKey ? ' (scope: ' + r.repoKey + ')' : '';
  // deadSplits (2+ registry rows, ZERO live) is the DANGEROUS kind (HAZARD 2:
  // stranded mail, nobody draining) — surfaced with its own explicit warning
  // suffix so it never blends into the same-looking benign `splits=` count.
  // mixedSplits (exactly 1 live of 2+ rows, TRACED P0) is ALSO dangerous — a
  // second send can still resolve to the dead partition — surfaced the same way.
  let warning = '';
  if (r.storeUnavailable) {
    // R2 Critic P2-9: "registry" only when actually attributed to
    // registry.ndjson (see pickStoreReadErrorScope) — the generic "store"
    // otherwise.
    const noun = r.storeUnavailableScope === 'registry' ? 'registry' : 'store';
    warning = ' — WARNING: ' + noun + ' unreadable (' + (r.storeUnavailableReason || 'EUNKNOWN') + ') — counts above are unknown, not verified-zero';
  }
  if (deadSplits > 0) {
    warning += ' — WARNING: ' + deadSplits + ' dead split(s) (2+ registry rows, no live session draining either — mail can strand)';
  }
  if (mixedSplits > 0) {
    warning += ' — WARNING: ' + mixedSplits + ' mixed split(s) (2+ registry rows, exactly 1 live — a send can still resolve to the dead row)';
  }
  return 'healthcheck: ' + (r.status || (r.ok ? 'ok' : 'degraded')) + scope + ' [' + parts.join(' ') + ']' + warning;
}

// cmdMeshRead(flags, ctx) — a.k.a. `roster --ack` (D23). Lists the CALLER's
// unseen NON-heartbeat broadcasts (its own broadcast_cursors join point up to
// the shared broadcast partition's current `seq` head), then advances the
// CALLER's OWN broadcast_cursors to head — the ONLY surface that clears
// `broadcastUnread`. `deriveSummary` re-scans only the bounded broadcast
// partition tail (recentCap), never an unbounded history.
function cmdMeshRead(flags, ctx) {
  const home = ctx.home;
  const cwd = projectCwdFor(ctx);
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const from = callerIdentity(ctx.env, cwd);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    // v0.57 mesh (P1 fix, same root cause as the ack-ownership P0): the broadcast
    // cursor must be keyed by the caller's OWN REGISTERED partition id (d.id) —
    // the SAME id deriveSummary reads back via store.broadcastCursorValue(d.id)
    // (devswarm-store.js) — never the raw worktree-derived meshId `from`. These
    // coincide only for a self-registered Primary; for a child (registered under
    // its DEVSWARM_BUILDER_ID) they diverge, so acking broadcasts via this ONLY
    // documented clearing path (D23) advanced a cursor deriveSummary never reads,
    // leaving broadcastUnread stuck forever despite `ok:true, acked:true`. Resolve
    // the caller's own registry entry the same way the ack-ownership guard does
    // (resolveMeshTarget keyed by the caller's meshId); fall back to `from` itself
    // when unregistered (no store entry at all) — the pre-existing, still-correct
    // behavior for that case.
    const ownEntry = resolveMeshTarget(s, from, home);
    const cursorKey = ownEntry ? ownEntry.id : from;
    const cursor = typeof s.broadcastCursorValue === 'function' ? s.broadcastCursorValue(cursorKey) : 0;
    // d68c561e1649 fix — NON-DESTRUCTIVE PEEK. Pre-fix, this verb ALWAYS
    // advanced the caller's broadcast cursor, so a seq at or below it could
    // never be retrieved again — there was no way to re-inspect an
    // already-consumed message. `--peek` reads without ever calling
    // advanceBroadcastCursor; `--seq <n>` additionally lets the read baseline
    // be an EXPLICIT historical seq instead of the caller's own cursor (a
    // caller re-inspecting "everything after message #12", say), and always
    // implies peek — re-inspecting history must never itself move the live
    // cursor as a side effect of asking a different question. Both are purely
    // additive: a call with NEITHER flag is byte-for-byte the pre-fix
    // behavior (same baseline, same cursor advance, same return shape).
    // H fix: `one()` maps a bare boolean flag value (`true`, parseArgs'
    // fallback for a flag with no trailing value token) to `undefined` —
    // which is INDISTINGUISHABLE, from this point on, from `--seq` never
    // having been passed at all. That means a bare `--seq` (a malformed call
    // — the caller plainly meant to scope the read but supplied no anchor)
    // silently fell through to the DEFAULT, MUTATING path: `usedExplicitSeq`
    // stayed false, `peek` stayed false, and the read ADVANCED the caller's
    // broadcast cursor exactly as an ordinary `mesh read` would — the
    // opposite of what a caller reaching for `--seq` was trying to do.
    // `hasSeqFlag` reads the RAW flags array (before one()'s erasure) so this
    // shape can be told apart from a genuine absence and refused explicitly.
    const hasSeqFlag = !!(flags && Array.isArray(flags.seq) && flags.seq.length > 0);
    const seqRaw = one(flags, 'seq');
    let sinceSeq = cursor;
    let usedExplicitSeq = false;
    if (hasSeqFlag && seqRaw === undefined) {
      return { ok: false, error: '--seq requires a value (got a bare flag, which would otherwise silently fall back to the default MUTATING read)', reason: 'bad-seq' };
    }
    if (seqRaw !== undefined) {
      const n = Number(seqRaw);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: '--seq must be a non-negative integer (got ' + JSON.stringify(String(seqRaw)) + ')', reason: 'bad-seq' };
      }
      sinceSeq = Math.floor(n);
      usedExplicitSeq = true;
    }
    const peek = !!(flags && flags.peek && flags.peek.length) || usedExplicitSeq;
    const all = typeof s.listMessages === 'function' ? s.listMessages(store.BROADCAST_PARTITION_ID) : [];
    // Filtered on the PHYSICAL mesh `seq` (storeSeq), matching broadcast_cursors'
    // own semantics (deriveSummary's broadcastUnread, D22/D23) — NOT the
    // per-workspace positional `sinceCursor` listMessages() otherwise supports.
    // v0.108.0: a pre-fix child sender label renders as the child's real id
    // (sender-aliases.json); `fromLabel` keeps the stored value.
    let aliases = {};
    try { aliases = require('../../companion/lib/devswarm-sender-alias.js').readAliases(home); } catch (_) { aliases = {}; }
    const hasLast = !!(flags && Array.isArray(flags.last) && flags.last.length > 0);
    const hasSince = !!(flags && Array.isArray(flags.since) && flags.since.length > 0);
    // --last N / --since <iso|duration>: PEEK-ONLY. A consuming read acks to
    // head, so a filter would silently consume rows it never showed — refused.
    // `filteredOut` is informational (rows hidden from this peek, none consumed).
    if ((hasLast || hasSince) && !peek) {
      return { ok: false, reason: 'filter-requires-peek', error: '--last/--since would consume unread broadcasts they do not show; use --peek, then a plain `mesh read` to consume', hint: 'use --peek, then a plain `mesh read` to consume' };
    }
    const lastRaw = one(flags, 'last');
    const hasLastFlag = hasLast;
    let lastN = null;
    if (hasLastFlag) {
      const n = Number(lastRaw);
      if (lastRaw === undefined || !Number.isFinite(n) || n < 1) {
        return { ok: false, error: '--last must be a positive integer (got ' + JSON.stringify(lastRaw === undefined ? '' : String(lastRaw)) + ')', reason: 'bad-last' };
      }
      lastN = Math.floor(n);
    }
    const hasSinceFlag = hasSince;
    const sinceFlagRaw = one(flags, 'since');
    let sinceTs = null;
    if (hasSinceFlag) {
      const dur = sinceFlagRaw === undefined ? null : parseSinceDuration(sinceFlagRaw);
      const iso = sinceFlagRaw !== undefined && dur === null ? Date.parse(String(sinceFlagRaw)) : NaN;
      if (dur !== null) sinceTs = now - dur;
      else if (Number.isFinite(iso)) sinceTs = iso;
      else {
        return { ok: false, error: '--since must be an ISO 8601 timestamp or a duration like 30m/2h/1d (got ' + JSON.stringify(sinceFlagRaw === undefined ? '' : String(sinceFlagRaw)) + ')', reason: 'bad-since' };
      }
    }
    let unseen = all.filter((r) => !r.isHeartbeat && Number.isFinite(r.storeSeq) && r.storeSeq > sinceSeq);
    const unseenCount = unseen.length;
    if (sinceTs !== null) unseen = unseen.filter((r) => Number.isFinite(r.ts) && r.ts >= sinceTs);
    if (lastN !== null) unseen = unseen.slice(-lastN);
    const broadcasts = unseen
      .map((r) => {
        const a = r.sender != null ? aliases[String(r.sender)] : null;
        const from = a ? a.to : r.sender;
        const b = { from, message: r.body, text: r.body, kind: 'broadcast', timestamp: r.ts, urgency: r.urgency, seq: r.storeSeq };
        if (a) b.fromLabel = r.sender;
        return b;
      });
    const newCursor = peek
      ? cursor
      : (typeof s.advanceBroadcastCursor === 'function' ? (assertSeatAllowsCursorWrite(), s.advanceBroadcastCursor(cursorKey)) : cursor);
    // deriveSummary is a pure projection refresh (re-scans the bounded
    // broadcast tail) — skipped on a peek so a non-mutating read has zero
    // side effects, matching `peek-primary`'s own contract on the direct-
    // message side.
    if (!peek) store.deriveSummary(s, { home, env: ctx.env, now });
    const out = { ok: true, action: 'mesh-read', from, acked: !peek, newCursor, count: broadcasts.length, broadcasts, messages: broadcasts };
    if (peek) out.peek = true;
    else out.hint = 'consumed broadcasts stay re-readable without moving any cursor: `mesh history [--last N]`, or `inbox messages <id> --with-broadcasts`';
    if (usedExplicitSeq) out.since = sinceSeq;
    if (lastN !== null) out.last = lastN;
    if (sinceTs !== null) out.sinceTs = sinceTs;
    if (broadcasts.length !== unseenCount) out.filteredOut = unseenCount - broadcasts.length;
    return out;
  } finally { s.close(); }
}

// rosterIsArchivedRow(w) -> bool. The SAME predicate cmdRoster's `archivedCount`
// uses: source 'archived' or the `archived` hint (app-archived rows too).
function rosterIsArchivedRow(w) {
  return !!w && (w.source === 'archived' || (Array.isArray(w.hints) && w.hints.includes('archived')));
}

function rosterRelative(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd';
}

// rosterHumanText(result, { all, home, now }) -> string. The compact default
// rendering of plain `roster` (the full JSON stays behind `--json`): the same
// columns as the per-turn parent-inbox table (workspace, status, finish, unread,
// last), one line per LIVE workspace, then one `+N archived` line. `all`
// includes archived rows. The hook's own formatter works on rows built by that
// hook's separate per-turn pipeline, so it is not shared; this one reads the
// roster result rows directly.
function rosterHumanText(result, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const rows = Array.isArray(result && result.workspaces) ? result.workspaces : [];
  const shown = o.all ? rows : rows.filter((w) => !rosterIsArchivedRow(w));
  const hidden = rows.length - shown.length;
  const lines = [];
  if (shown.length) {
    lines.push('| workspace | status | finish | unread | last |', '|---|---|---|---|---|');
    for (const w of shown) {
      const hints = Array.isArray(w.hints) ? w.hints : [];
      const status = hints.length ? hints.slice(0, 3).map((h) => String(h).split(':')[0]).join(', ') : 'active';
      const finish = (w.plan && w.plan.label) || (w.app && w.app.finish) || '—';
      const nums = [w.directUnread, w.broadcastUnread].filter((n) => Number.isFinite(n));
      const unread = nums.length ? nums.reduce((a, b) => a + b, 0) : '—';
      const last = o.home && w.id != null ? rosterLastOutboundTs(o.home, w.id) : null;
      const name = names.displayName(w.id, w.wsName).replace(/\|/g, '\\|');
      lines.push('| ' + name + ' | ' + status + ' | ' + finish + ' | ' + unread + ' | ' + rosterRelative(last, now) + ' |');
    }
  } else {
    lines.push('no live workspaces');
  }
  if (hidden > 0) lines.push('+' + hidden + ' archived (use --all to list them, --json for the full data)');
  return lines.join('\n');
}

module.exports = {
  rosterHumanText, rosterIsArchivedRow,
  LIST_CHILDREN_TIMEOUT_MS, parseChildrenList, fetchTrustedRepositoryId, fetchNativeChildren,
  fetchActiveWorkspaceRecords, rosterLastOutboundTs, rosterIdleDays,
  INSTANCE_SPLIT_CONCURRENT_GAP_MS, computeInstanceNonceCounts, rosterHints, cmdRoster,
  pickStoreReadErrorScope, computeDiagnosis, cmdDiagnose, diagnoseHumanLine, cmdHealthcheck,
  globToRegExp, cmdReadyCheck, healthcheckHumanLine, cmdMeshRead,
};
