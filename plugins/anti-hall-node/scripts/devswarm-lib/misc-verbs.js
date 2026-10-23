'use strict';
// anti-hall :: devswarm CLI — MISC-VERBS module (scripts/devswarm-lib/misc-verbs.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, appendIntoPartition, CALLER_CWD, CLI_PATH, csvList, descriptorRegisteredRepoKey,
  dispatcherExports, fs, gitTruth, identityContext, inst, isChildWorkspace, isSafeId,
  livenessPathFor, migrate, one, path, planLib, PLUGIN_ROOT, pokeOrEscalate,
  projectContextMismatch, readDescriptorFile, repokey, repoKeyForCwd, resolveStableCliPath,
  resolveStableLauncherPath, spawnSync, store, supervisionMetrics, wakeLib,
} = require('./core.js');
const {
  agentNameSafe, childLabelRefusal, isPrimaryCheckout, registrySnapshot, resolveCallerWorktree,
  senderIdentityDetailed,
} = require('./identity.js');
const {
  maybeRehomeToCwdProject,
} = require('./fold.js');
const {
  resolveMeshTarget, resolveSendTarget,
} = require('./send.js');
const {
  rehomeStrandedProjectDescriptors,
} = require('./repair.js');
const {
  skipFilePath,
} = require('./archive.js');

function cmdWorkspacesList(flags, ctx) {
  const home = ctx.home;
  // PER-PROJECT: which project's store to derive. Explicit targeting wins so a
  // caller can inspect any project's summary: --workspace <id> (a store partition
  // key directly) or --worktree <path> (its primary-<hash>). Otherwise derive the
  // CURRENT worktree's own store (primary-<worktreeHash>) from cwd. Outside a
  // worktree with no flag, fall back to the default bucket (an empty/legacy view).
  let workspaceId = one(flags, 'workspace');
  const worktreeFlag = one(flags, 'worktree');
  const worktree = worktreeFlag || resolveCallerWorktree(ctx.cwd || process.cwd());
  if (workspaceId === undefined) {
    workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
  }
  // v0.57 mesh (D24 store-caller re-key — this call was missed by the original
  // sweep): target the SAME shared per-project store `register`/`roster`/`gate`/
  // `archive` all write into (repoKey, when resolvable) — else `workspaces list`
  // opens the legacy per-id hash bucket while every writer lands in store/<repoKey>/,
  // so a freshly-registered peer never shows up here (count:0 against a real
  // roster). Derived from the SAME `worktree` used to derive `workspaceId` above
  // (an explicit --worktree flag, when given, must win over ctx.cwd for BOTH —
  // repoKeyForCwd(ctx) alone would ignore the flag and resolve the wrong
  // project's repoKey whenever the caller's cwd differs from --worktree, e.g. a
  // subprocess invocation that targets another worktree by flag). Omitting
  // `workspaceId` from deriveSummary lets it fall back to the opened handle's
  // own `.hash` (the repoKey) instead of recomputing hashFromWorkspaceId(workspaceId)
  // and re-targeting the legacy bucket.
  const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
  // GH1: re-home any hash-bucket-stranded child of THIS project BEFORE the summary
  // read, so a stranded workspace is not silently undercounted. Scope the sweep to
  // the SAME project the store below opens (an explicit --worktree wins over cwd).
  try { rehomeStrandedProjectDescriptors(home, worktree ? Object.assign({}, ctx, { cwd: worktree }) : ctx); }
  catch (_) { /* fail-open: the list read proceeds regardless */ }
  const s = store.openStore({ home, workspaceId, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
  let sum;
  // #62: a READ verb must not mutate — use the PURE computeSummary (zero summary.json
  // write) instead of deriveSummary (which surprised users by writing on a read).
  try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const workspaces = Object.values(sum.workspaces || {});
  return { ok: true, action: 'workspaces', workspaceId: workspaceId || null, requiredGates: sum.requiredGates, count: workspaces.length, workspaces };
}

function cmdGate(id, flags, ctx) {
  const home = ctx.home;
  const setNames = csvList(flags, 'set');
  const clearNames = csvList(flags, 'clear');
  if (!setNames.length && !clearNames.length) {
    return { ok: false, error: 'gate needs --set <csv> and/or --clear <csv>' };
  }
  const setBy = one(flags, 'by') !== undefined ? one(flags, 'by') : 'devswarm-cli';
  // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
  // The refusal runs BEFORE the re-home, and resolves the id's project from
  // descriptorRegisteredRepoKey (fresh worktree key, else the PERSISTED
  // repoKey/ownerKey) rather than descriptorFreshRepoKey alone. Both halves
  // were load-bearing and both were wrong here:
  //   1. ORDER — maybeRehomeToCwdProject re-homes to `repoKeyForCwd(ctx)`.
  //      Running it first meant `gate <foreign-id>` from project A physically
  //      moved a hash-stranded project-B workspace's registry row into A and
  //      rewrote its descriptor ownerKey to A's key, and THEN returned
  //      ok:false. A command that refuses must not have already moved another
  //      project's data. (Reproduced live; see
  //      tests/scripts/devswarm-cross-repo-partition.test.js.)
  //   2. AUTHORITY — descriptorFreshRepoKey returns null the moment the
  //      descriptor's worktreePath stops resolving, silently disengaging the
  //      guard and making the caller's cwd the de-facto authority for a
  //      FOREIGN workspace.
  // (maybeRehomeToCwdProject now carries its own equivalent guard too, so the
  // data movement is closed at the source for every caller; this refusal is
  // the caller-visible half.)
  const callerRepoKeyForGate = repoKeyForCwd(ctx);
  const descForGate = readDescriptorFile(home, id);
  const registeredRepoKeyForGate = descForGate ? descriptorRegisteredRepoKey(descForGate, id) : null;
  if (registeredRepoKeyForGate && registeredRepoKeyForGate !== callerRepoKeyForGate) {
    return projectContextMismatch(id, registeredRepoKeyForGate, callerRepoKeyForGate,
      'run this from within that project\'s worktree to gate it');
  }
  // GH1: re-home a hash-bucket-stranded workspace into store/<repoKey>/ BEFORE
  // opening the store — otherwise the gate lands in / reads from the wrong store,
  // the workspace shows tracked:false, and the gate silently no-ops. Best-effort
  // + under the per-id lock (held internally); a no-op when not stranded.
  try { maybeRehomeToCwdProject(home, id, ctx); } catch (_) { /* fail-open: gate proceeds */ }
  // v0.57 mesh (D24): gates land in the SAME shared per-project store the
  // registry/roster/archive_ready read (repoKey, when resolvable).
  const s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForGate || undefined, backend: ctx.backend, env: ctx.env });
  let summary;
  try {
    for (const name of setNames) s.setGate({ workspaceId: id, name, value: true, setBy });
    for (const name of clearNames) s.setGate({ workspaceId: id, name, value: false, setBy });

    // MERGED-GATE GROUND-TRUTH VERIFICATION (report-only, mechanical — never
    // blocks). When a child sets `merged`, best-effort verify HEAD is an
    // ancestor of the resolved default branch. The gate is set REGARDLESS of
    // the verdict either way — a squash/rebase merge legitimately breaks
    // ancestry even though the work IS merged, so a false/null verdict must
    // never block archive_ready; `merged_verified` is persisted ALONGSIDE
    // `merged` purely so the parent can see whether the claim was proven or
    // is self-declared. See devswarm-git-truth.js for the field incident
    // (unpushed/unmerged work self-declared done) this exists to catch.
    if (setNames.includes('merged')) {
      // Reuse descForGate (already read above for the project-context-mismatch
      // guard) rather than a second descriptor read for the same id.
      const worktreePath = descForGate && descForGate.worktreePath ? descForGate.worktreePath : null;
      if (worktreePath) {
        // gitMergeProof is the SAME proof auto-archive gate (b) runs
        // (devswarm-lifecycle.js mergedFact); the row's set_by binds the
        // verdict to the HEAD it was computed at (mergedVerifiedHead).
        let proof = null;
        try { proof = gitTruth.gitMergeProof(worktreePath); } catch (_) { proof = null; }
        const verified = proof ? proof.merged : null;
        const verifiedBy = proof && proof.head ? store.MERGED_VERIFIED_SETBY_PREFIX + proof.head : setBy;
        if (verified === true) {
          s.setGate({ workspaceId: id, name: 'merged_verified', value: true, setBy: verifiedBy });
        } else if (verified === false) {
          s.setGate({ workspaceId: id, name: 'merged_verified', value: false, setBy: verifiedBy });
          try {
            process.stderr.write('[devswarm] gate: `merged` set, but HEAD does not appear to be an ancestor of '
              + 'the default branch (git ground-truth check) — this can be normal for a squash/rebase merge; the '
              + 'gate is still set (report-only, never blocked). See the parent roster for the "(unverified)" mark.\n');
          } catch (_) {}
        }
        // verified === null (unresolvable default branch / spawn failure) -> omit entirely, never fabricate.
      }
    }

    summary = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now });
  } finally { s.close(); }
  const ws = (summary.workspaces || {})[id];
  // A5(c): an untracked id (no registry row in this project's summary — e.g. a
  // stray/typo'd/never-registered id) must NOT report ok:true — the set/clear
  // calls above landed in the store's gate table regardless, but with no
  // registry row for `id` nothing ever surfaces them (deriveSummary only
  // projects gates for rows it enumerates), so the caller's gate silently
  // no-ops. `tracked` already carried this signal; `ok` now agrees with it.
  return {
    ok: !!ws, action: 'gate', id, set: setNames, cleared: clearNames,
    gates: ws ? ws.gates : undefined,
    archive_ready: ws ? ws.archive_ready : undefined,
    tracked: !!ws,
  };
}

function cmdNudge(id, flags, ctx) {
  const home = ctx.home;
  let desc = readDescriptorFile(home, id);
  if (!desc) {
    // `id` may be a meshId (e.g. a child's `primary-<hash>` label) rather than
    // its own registry/descriptor id — those have no descriptor file under
    // their own name, so the direct lookup above misses. Resolve it EXACTLY
    // as `send` does (resolveSendTarget: meshId match, then exact registry-id
    // fallback) instead of failing closed here while `send --to` reaches the
    // same target fine.
    try {
      const cwd = ctx.cwd || process.cwd();
      const repoKey = repokey.repoKeyForWorktree(cwd);
      if (repoKey) {
        const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
        try {
          const resolved = resolveSendTarget(s, id, home, { rerouteStaleTwin: true });
          if (resolved.target && resolved.target.id != null) desc = readDescriptorFile(home, resolved.target.id);
        } finally { s.close(); }
      }
    } catch (_) { /* fail-open: falls through to the not-found error below */ }
  }
  if (!desc) return { ok: false, error: 'no descriptor for workspace ' + JSON.stringify(id) };
  // Pass the persisted verdict (if any) so pokeOrEscalate honors attempt count +
  // cooldown across CLI invocations, exactly as the supervisor sweep does.
  let verdict = {};
  try { verdict = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8')) || {}; } catch (_) { verdict = {}; }
  const res = pokeOrEscalate(desc, verdict, { home, now: ctx.now });
  return { ok: true, action: 'nudge', id, result: res };
}

// cmdSkip(guard, flags, ctx) — the documented escape hatch for anti-hall's own
// guards (see hooks/skip-guard.js): writes/merges { [guard]: expiryUnixMs }
// into skip.json so every guard's own isSkipped(name) check fail-opens while
// unexpired. This is the CLI-side half of edit-guard's own block-message hint
// ("run 'node scripts/devswarm.js skip edit-guard'") — previously the message
// pointed agents at a mechanism with no CLI entry point.
function cmdSkip(guard, flags, ctx) {
  const home = ctx.home;
  // A bare `--ttl` (no following value, e.g. end-of-argv or immediately
  // followed by another `--flag`) parses to boolean `true` in parseArgs(),
  // which one() maps to `undefined` — indistinguishable from "--ttl not
  // passed at all". Check the raw flags bucket first so a bare `--ttl`
  // errors instead of silently falling through to the 15-minute default.
  const ttlFlagPassed = Array.isArray(flags.ttl) && flags.ttl.length > 0;
  const rawTtl = one(flags, 'ttl');
  let ttlMinutes = 15;
  if (ttlFlagPassed && rawTtl === undefined) {
    return { ok: false, error: 'invalid --ttl (missing value; expected a positive number of minutes)' };
  }
  if (rawTtl !== undefined) {
    const n = Number(rawTtl);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'invalid --ttl (must be a positive number of minutes)' };
    }
    ttlMinutes = n;
  }
  const dir = path.join(home, '.anti-hall');
  const file = skipFilePath(home);
  let data = {};
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      // Require a plain non-array object: JSON.stringify on an array only
      // serializes index/length properties, so `data[guard] = expiresAt`
      // on an array would be silently dropped on write (reported ok:true
      // with nothing actually persisted). Reset to {} instead of accepting
      // array-shaped skip.json.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    }
  } catch (_) {
    data = {}; // missing / unreadable / bad JSON -> start fresh, never blocks the write
  }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const expiresAt = now + ttlMinutes * 60000;
  // Guard BEFORE writing anything: an astronomically large but finite --ttl
  // can overflow `now + ttlMinutes*60000` to Infinity. JSON.stringify(Infinity)
  // serializes as `null`, which the guard's `data[name] > now` check reads as
  // false -- reporting success while silently never actually skipping. Worse,
  // computing expiresAtIso via `new Date(Infinity).toISOString()` throws
  // AFTER the file would already be written, corrupting skip.json with a
  // `null` entry under an ok:false response. Reject up front instead.
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, error: 'invalid --ttl (resulting expiry is not a finite value)' };
  }
  data[guard] = expiresAt;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return {
    ok: true, action: 'skip', guard, ttlMinutes,
    expiresAt, expiresAtIso: new Date(expiresAt).toISOString(), path: file,
  };
}

// REASON_MAX_LEN — a stated-intent reason is stored verbatim (never echoed
// back into any injected hook output — see devswarm-parent-gate.js's
// buildReason) but is still bounded so a runaway/pasted-in caller can never
// grow the tiny per-session state file unreasonably.
const REASON_MAX_LEN = 2000;

// cmdGateIntent(flags, ctx) — `gate-intent --reason "<text>" [--session <id>]`
// (PLAN.md CLI VERB CONTRACT precedent, same shape as cmdSkip above): the
// EXPLICIT, deliberate signal devswarm-parent-gate.js's Stop-hook gate
// consumes to distinguish "the Primary stated a reason for this exact
// neglect condition" from "the Primary is simply ignoring the gate" — see
// that hook's `intents`/`intentAcks` handling. A CLI verb (rather than
// scanning the transcript tail for a hedge phrase the way merge-gate.js
// does) was chosen because the signal here needs to be UNAMBIGUOUS and
// per-condition-scoped: merge-gate.js's keyword heuristic works for its
// narrow backstop role (bypassable, honestly documented, default-off) but a
// keyword match against free-form assistant text has no reliable way to
// bind itself to ONE specific blocking signature — it would either fire on
// every Stop once any hedge-like phrase appeared anywhere in the tail
// (falsely covering an unrelated future block) or need its own second
// scanner/state machine duplicating this file's existing sig-keyed
// bookkeeping. A CLI call the Primary explicitly issues IN RESPONSE to a
// block is unambiguous, requires no wording heuristic, and reuses the
// gate's own already-persisted `sig` as the binding key for free.
//
// Session resolution mirrors cmdRegisterPrimary's own precedent (see its
// comment above): `--session` explicit override, else the real
// CLAUDE_CODE_SESSION_ID Claude Code sets on every spawned process, else the
// legacy DEVSWARM_BUILDER_ID fallback. Unlike register-primary this verb has
// NO further fallback to a derived id — an intent with no resolvable session
// has nothing to key its per-session state file by, so it fails visibly
// (`ok:false`) rather than silently guessing wrong.
//
// The intent can only ever be attached to a signature the gate has ALREADY
// persisted (i.e., the Primary has already been blocked at least once this
// session) — reading `sig` from the SAME state file
// devswarm-parent-gate.js's Stop hook already writes, never re-deriving the
// blocking-set signature itself (that computation needs descriptors/
// liveness/store reads this thin CLI verb has no reason to duplicate). No
// active block yet -> `ok:false`, nothing written — this is exactly what
// keeps the gate's OWN "never suppress the first block" guarantee intact:
// an intent can never predate the block it is meant to acknowledge.
function cmdGateIntent(flags, ctx) {
  const home = ctx.home;
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID);
  if (!session) {
    return { ok: false, error: 'gate-intent needs a resolvable session id (CLAUDE_CODE_SESSION_ID not set in this environment; pass --session <id> explicitly)' };
  }
  const rawReason = one(flags, 'reason');
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (!reason) {
    return { ok: false, error: 'gate-intent needs --reason "<text>" (a non-empty stated reason)' };
  }
  const gateState = require('../../companion/lib/devswarm-gate-state.js');
  const stateFile = gateState.stateFileFor(session, home);

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    existing = null; // no state file yet, or unreadable/corrupt -> no active block to attach to
  }
  const sig = existing && typeof existing === 'object' && typeof existing.sig === 'string' ? existing.sig : '';
  if (!sig) {
    return {
      ok: false,
      error: 'no active devswarm-parent-gate block is recorded for session ' + JSON.stringify(session) +
        ' — an intent can only be attached to a condition the gate has already surfaced at least once',
    };
  }

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const truncatedReason = reason.length > REASON_MAX_LEN ? reason.slice(0, REASON_MAX_LEN) : reason;
  const nextIntents = {};
  nextIntents[sig] = { ts: now, reason: truncatedReason };
  // Everything else in the existing state file is preserved verbatim — this
  // verb only ever ADDS/replaces the `intents` entry for the CURRENT sig; it
  // never touches blocks/escalated/qSig/etc (those stay the gate hook's own
  // bookkeeping) and never deletes the file.
  const next = Object.assign({}, existing, { intents: nextIntents });

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    return { ok: false, error: 'failed to persist gate-intent: ' + (e && e.message ? e.message : String(e)) };
  }

  return { ok: true, action: 'gate-intent', session, sig, ts: now };
}

// cmdDone(idArg, flags, ctx) — 0.108.3 child-facing structured done-report.
// A child runs `devswarm.js done [<id>] [--summary TEXT]` once its work is
// merged/finished. It (1) sets the `done` gate on the caller's OWN workspace id
// (the cmdGate path; never merged/tests_passed — auto-archive gate (b) proves
// the merge independently), then (2) sends ONE `[[ANTIHALL_DONE]]` direct
// message to the Primary. The gate row records the worktree HEAD
// (set_by 'devswarm-done@<sha>', P1-B): auto-archive honours the report only
// while that sha is still HEAD, so new commits after it need a new `done`. Idempotent: the message hash is keyed on id + the
// worktree HEAD, so a re-run on the same commit inserts nothing. Fail-open on
// the message leg: the gate row is the authority auto-archive reads.
function cmdDone(idArg, flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, action: 'done', reason: 'no-project' };
  const callerIc = identityContext(cwd, CALLER_CWD);
  if (isPrimaryCheckout(callerIc.worktreeRoot, callerIc.mainWorktree, home, ctx.env)) {
    return { ok: false, action: 'done', reason: 'primary-checkout', error: 'done is a child verb — the Primary checkout has no done-report' };
  }
  const who = senderIdentityDetailed(ctx.env, cwd, registrySnapshot(ctx, repoKey), home);
  const id = who.identity;
  if (idArg !== undefined && idArg !== id && idArg !== who.meshId) {
    return { ok: false, action: 'done', reason: 'not-own-workspace', id: idArg, identity: id,
      error: 'done ' + JSON.stringify(idArg) + ' is not the caller\'s own workspace (' + JSON.stringify(id) + ') — a child reports only itself' };
  }
  if (!isSafeId(id)) return { ok: false, action: 'done', reason: 'no-identity', error: 'could not resolve this workspace\'s id' };
  const labelRefusal = childLabelRefusal(id, flags, ctx);
  if (labelRefusal) return Object.assign({ action: 'done' }, labelRefusal);
  let head = null;
  try {
    const r = spawnSync('git', ['-C', callerIc.worktreeRoot || cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) head = String(r.stdout || '').trim() || null;
  } catch (_) { head = null; }
  // No resolvable HEAD -> a sha-less done: auto-archive then treats it like a
  // manual `gate --set done` (git-ancestry proof only, never the PR fallback).
  const g = cmdGate(id, { set: ['done'], by: [head ? store.DONE_GATE_SETBY_PREFIX + head : 'devswarm-done'] }, ctx);
  if (!g.ok) {
    return Object.assign({}, g, { ok: false, action: 'done', id, gateSet: false,
      error: g.error || ('workspace ' + JSON.stringify(id) + ' is not registered in this project\'s mesh — nothing surfaces its done gate') });
  }
  const summaryText = one(flags, 'summary');
  const message = store.DONE_REPORT_MARKER + ' ' + id + ' reports done'
    + (summaryText ? ': ' + String(summaryText) : '')
    + ' — auto-archive retires it once the merge is proven and it is clean, read and idle.';
  const out = { ok: true, action: 'done', id, gateSet: true, gates: g.gates, messaged: false, head };
  // Supervision metrics: time-to-done and steps done vs planned, for a
  // workspace that had a step plan (once per plan; best-effort).
  try {
    const found = planLib.findPlan(home, { id, worktreePath: callerIc.worktreeRoot || null });
    const doneNow = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    let firstDone = false;
    const w = found ? planLib.updatePlan(home, found.key, (plan) => {
      if (!plan || !plan.steps.length) return null;
      // done_reported_at refreshes on every done (holds supervision until a
      // new step); done_at + the metrics stay once per plan.
      plan.done_reported_at = doneNow;
      firstDone = !Number.isFinite(plan.done_at);
      if (firstDone) plan.done_at = doneNow;
      return plan;
    }) : null;
    if (w && w.ok && w.changed && firstDone) {
      const plan = w.plan;
      supervisionMetrics.record(home, 'done', { now: doneNow, id, key: found.key,
        durationMs: Number.isFinite(plan.created_at) ? doneNow - plan.created_at : null,
        stepsDone: planLib.stepsDone(plan), stepsPlanned: plan.steps.length,
        respawnOf: plan.respawn && plan.respawn.from ? plan.respawn.from : undefined,
        tokensTotal: (() => { const t = require('../../companion/lib/devswarm-token-usage.js').readState(home, found.key); return t && Number.isFinite(t.total) ? Math.round(t.total) : null; })() });
    }
  } catch (_) { /* metrics never affect done */ }
  try {
    // THE identity resolver: the Primary's mesh id is the main worktree's.
    const primaryMeshId = callerIc.primaryMeshId || null;
    if (!primaryMeshId) return Object.assign(out, { messageReason: 'no-primary-worktree' });
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
    try {
      const target = resolveMeshTarget(s, primaryMeshId, home);
      if (!target) return Object.assign(out, { messageReason: 'primary-unregistered' });
      const fields = { from: id, to: String(target.id), type: 'direct', message, timestamp: now, urgency: 'normal' };
      const hash = 'done:' + id + ':' + (head || 'nohead');
      const row = Object.assign({}, fields, { hash, instanceNonce: dispatcherExports().deriveReaderNonce(ctx) });
      const w = appendIntoPartition(s, home, String(target.id), [row], { via: 'mesh' });
      if (w.status !== 'ok') return Object.assign(out, { messageReason: 'primary-' + w.status });
      store.deriveSummary(s, { home, env: ctx.env, now });
      out.messaged = true;
      out.duplicate = w.inserted === 0;
      out.to = String(target.id);
      out.kind = 'done';
    } finally { s.close(); }
  } catch (e) {
    out.messageReason = 'error';
    out.messageError = String((e && e.message) || e);
  }
  return out;
}

function cmdMigrate(ctx) {
  return migrate.migrateToStore({ home: ctx.home, backend: ctx.backend, env: ctx.env, now: ctx.now });
}

// cmdWakeDirective(id, ctx) -> reprints the SAME SessionStart MAILBOX WAKE
// directive text hooks/devswarm-child-role.js emits, on demand — the target
// of the Stop-gate's trimmed reassert pointer ("re-run the SessionStart wake
// directive"), which no longer carries the full instruction inline (C, hook
// trim). `id` (required, validated) is substituted for the generic
// `<DEVSWARM_BUILDER_ID>` placeholder wakeDirective() embeds in its drain
// command, so the printed text is directly copy-runnable rather than a
// template. Role (child vs Primary) comes from the SAME env signal
// hooks/lib/devswarm-role.js uses (DEVSWARM_SOURCE_BRANCH) — never
// re-derived from `id` itself, keeping this byte-parity with the actual
// SessionStart hook for the CURRENT process's real role. CLI/WATCHER paths
// prefer the stable launcher (resolveStableCliPath — same "when it exists"
// check the `ackCommand` fix above uses) over THIS file's own on-disk
// location (`__filename`/`__dirname`), matching devswarm-child-role.js's
// stable-launcher-first resolution: the SessionStart hook that emits this
// SAME directive text already prefers the stable launcher, so an on-demand
// reprint of it must not regress back to a version-pinned path (same defect
// class as the `ackCommand` fix above, a DevSwarm Primary field report,
// 2026-09-27).
function cmdWakeDirective(id, ctx) {
  if (!isSafeId(id)) return { ok: false, error: 'invalid or missing workspace id' };
  const isChild = isChildWorkspace(ctx.env);
  const cliPath = resolveStableCliPath(ctx.home, CLI_PATH);
  const rawWatcherPath = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-wake-watch.js');
  const watcherPath = resolveStableLauncherPath('wakeWatch', ctx.home, rawWatcherPath);
  let text = '';
  try {
    // Wave 3 P2 fix: the argv `id` this verb was CALLED WITH is the ground
    // truth for "which workspace is asking" — pass it as wakeDirective's
    // explicit-id override so it wins over ctx.env.DEVSWARM_BUILDER_ID.
    // Previously wakeDirective() resolved+embedded the ENV id internally
    // BEFORE this function got a chance to substitute anything, so the
    // trailing `.split('<DEVSWARM_BUILDER_ID>').join(id)` below was a no-op
    // whenever an env id was present — the printed directive silently named
    // the caller's OWN process env id instead of the id it explicitly asked
    // for (env id A vs argv id B). The trailing split/join is kept as a
    // fail-open backstop for the (should-be-unreachable) case a stale
    // wakeLib still returns the literal placeholder.
    text = wakeLib.wakeDirective(ctx.env, isChild, cliPath, watcherPath, String(id)) || '';
    text = text.split('<DEVSWARM_BUILDER_ID>').join(String(id));
  } catch (_) { text = ''; }
  return { ok: true, id: String(id), isChild, agent: agentNameSafe(ctx.env), directive: text.trim() };
}

// parseSinceDuration(raw) -> milliseconds | null. Accepts a bare number (ms) or
// a <number><unit> duration with unit ms/s/m/h/d (e.g. '30m', '2h', '1d'). null
// on an unparseable value — the caller then omits the `since` filter (fail-open).
function parseSinceDuration(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (str === '') return null;
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return n * mult;
}

// cmdLogs(flags, ctx) — read the central DevSwarm JSONL log via the shared
// logger's readRecent() and return a concise, filterable summary so a Primary
// can analyze a child project's recent errors/events FROM HERE (the logger is a
// single central stream across every project, so one call spans them all).
// Filters: --repo <repoKey>, --component <name>, --min-level
// debug|info|warn|error, --since <dur> (e.g. 30m / 2h / 1d, or bare ms),
// --limit N (default 50, newest-last). READ-ONLY: never writes, never throws.
function cmdLogs(flags, ctx) {
  const opts = {};
  const repo = one(flags, 'repo');
  if (repo !== undefined) opts.repoKey = repo;
  const component = one(flags, 'component');
  if (component !== undefined) opts.component = component;
  const minLevel = one(flags, 'min-level');
  if (minLevel !== undefined) opts.minLevel = minLevel;
  const sinceMs = parseSinceDuration(one(flags, 'since'));
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  if (sinceMs != null) opts.sinceMs = now - sinceMs;
  let limit = 50;
  const limitRaw = one(flags, 'limit');
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n >= 0) limit = Math.floor(n);
  }
  opts.limit = limit;
  let entries = [];
  try { entries = alog.readRecent(opts) || []; } catch (_) { entries = []; }
  // Concise rollups a Primary actually wants over the returned slice.
  const byComponent = {};
  const byLevel = {};
  for (const e of entries) {
    if (!e) continue;
    const c = e.component != null ? String(e.component) : '(none)';
    byComponent[c] = (byComponent[c] || 0) + 1;
    const lv = e.level != null ? String(e.level) : '(none)';
    byLevel[lv] = (byLevel[lv] || 0) + 1;
  }
  let logFile = null;
  try { logFile = alog.logFilePath(); } catch (_) { logFile = null; }
  return {
    ok: true, action: 'logs', logFile,
    filters: {
      repoKey: opts.repoKey != null ? opts.repoKey : null,
      component: opts.component != null ? opts.component : null,
      minLevel: opts.minLevel != null ? opts.minLevel : null,
      sinceMs: opts.sinceMs != null ? opts.sinceMs : null,
      limit,
    },
    count: entries.length,
    byComponent, byLevel,
    entries,
  };
}

// emitKnownWarning(argv, result) -> the WARNING string (or null if none
// applies), and — as a side effect — writes it to stderr. B1 (defect
// 902d3c5e7531): every read-side verb (`inbox count`/`read-primary`/
// `peek-primary`/`messages`/`read`/`ack`) now carries a `known` field; a
// caller running the plain CLI (not parsing JSON) had no visible signal that
// `known:false` meant the reported totals could not be trusted. One stderr
// line, naming the concrete reason (never a bare "known:false"), for every
// `inbox` invocation whose result reports `known === false`. Exported
// separately from main() so tests can assert the exact line without
// spawning a subprocess or intercepting process.exit.
// KNOWN_WARNING_VERBS — verbs whose `known:false` gets a stderr WARNING line.
// R2 Reviewer P2: `roster`/`diagnose` now carry `known` (defect 77d5a5bbf614)
// exactly like the `inbox` read verbs already did, but a plain-CLI (no
// --json) caller of `roster`/`diagnose` had no visible signal a
// storeUnavailable report was untrustworthy — only `inbox` was ever gated
// into this function. `healthcheck` is deliberately NOT added: it already
// has its own always-visible signal (`ok:false`/`status:'store-unavailable'`
// surfaces directly in its exit code and human-line render), so a SECOND
// stderr warning would be pure duplication.
const KNOWN_WARNING_VERBS = new Set(['inbox', 'roster', 'diagnose']);
function emitKnownWarning(argv, result) {
  if (!argv || !KNOWN_WARNING_VERBS.has(argv[0])) return null;
  if (!result || result.known !== false) return null;
  const reasons = [];
  // fl-wave6 fix (P1, item 1): the real reason must be named UNCONDITIONALLY
  // — not gated on the `storeUnavailable` BOOLEAN. `storeUnavailableOut`
  // (~line 8899) deliberately reports `storeUnavailable:false` for a
  // NON-genuine refusal (e.g. `project-context-mismatch` —
  // isGenuineStoreUnavailableReason is false for it) while still carrying
  // the real reason under `storeUnavailableDetail.reason` (count/read/ack)
  // or the top-level `result.reason` (read-primary/peek-primary/messages'
  // own refusal shape). Pre-fix, gating this whole block on the boolean
  // meant `count`/`read` on a project-context-mismatch (fail-open: `ok:true`,
  // `storeUnavailable:false`, no top-level `result.reason` — only
  // `storeUnavailableDetail.reason`) fell through every branch below and
  // printed the bare, useless "known:false (unknown)" — the caller had NO
  // idea a foreign-project cwd was the cause. `suKind`/`suReason` are now
  // computed once, unconditionally, and named whenever known, regardless of
  // whether `storeUnavailable` itself is true or false.
  const suReason = result.storeUnavailableReason || null;
  const suDetail = result.storeUnavailableDetail;
  const suKind = (suDetail && suDetail.reason) || result.reason || null;
  if (result.storeUnavailable) {
    // fl-wave5 fix (item 1): `storeUnavailable` is now a BOOLEAN and
    // `storeUnavailableReason` a top-level string|null on EVERY read verb
    // (count/read/ack/read-primary/peek-primary/messages) — the dual-shape
    // check this replaces (an OBJECT on some call sites, a bare boolean with
    // the reason living only on `result` on others) is gone; both fields
    // are always at the SAME place now. `storeUnavailableDetail` (count/
    // read/ack only) still carries its own `.reason` for the more specific
    // refusal kind (e.g. the literal 'store-unavailable' bucket vs. a
    // richer refusal); fall back to `result.reason` when no detail object
    // was reported for this call.
    if (suKind === 'store-unavailable' && suReason) {
      reasons.push('store-unavailable (' + suReason + ')');
    } else if (!suKind && suReason) {
      // fl-wave5 addendum fix (item 9, P2, R4 Reviewer): messages/
      // peek-primary/read-primary carry no `storeUnavailableDetail` (no
      // `.reason` to inspect) and — on a successful (`ok:true`) call — no
      // top-level `result.reason` either, so `suKind` lands null even though
      // a real fs error IS known. `storeUnavailable` is true here ONLY for a
      // genuine store-unavailable condition (storeUnavailableOut's
      // isGenuineStoreUnavailableReason gate), so a present
      // `storeUnavailableReason` with no other kind signal unambiguously
      // names THAT reason — print it instead of the bare, codeless
      // "storeUnavailable".
      reasons.push('store-unavailable (' + suReason + ')');
    } else {
      reasons.push('storeUnavailable' + (suKind ? (' (' + suKind + ')') : ''));
    }
  } else if (suKind) {
    // fl-wave6 fix (P1, item 1): `storeUnavailable` is false but a specific,
    // non-generic reason IS known (project-context-mismatch, unregistered-
    // workspace, …) — name it directly. Never fall through to the generic
    // 'unknown' bucket below just because this call's refusal happened not
    // to be a genuine store-unavailable condition.
    reasons.push(String(suKind));
  } else if (suReason) {
    reasons.push('store-unavailable (' + suReason + ')');
  }
  if (result.meshGroupUnresolved) reasons.push('meshGroupUnresolved' + (result.meshGroupError ? (': ' + result.meshGroupError) : ''));
  if (result.totalsPartial && !result.meshGroupUnresolved) reasons.push('totalsPartial');
  // fl-wave3 fix (item 2): a genuinely refusal-shaped `result.reason` (e.g.
  // 'project-context-mismatch', 'unregistered-workspace') is more specific
  // and more actionable than the generic bucket flags above — name it
  // whenever present, not merely as a last-resort fallback for when NONE of
  // the bucket flags fired. Pre-fix, a refusal that also carried
  // `totalsPartial:true` (every B3-merge refusal does) had its real reason
  // silently swallowed — the bucket flag fired first, so the `!reasons.length`
  // fallback below never ran, and the WARNING said only "totalsPartial" with
  // no hint of WHY.
  if (result.reason && !reasons.some((r) => r.indexOf(String(result.reason)) !== -1)) {
    reasons.push(String(result.reason));
  }
  if (!reasons.length) reasons.push('unknown');
  // `roster`/`diagnose` are project-scoped (no sub-verb, no per-id argument,
  // unlike every `inbox` sub-verb) — they get a bare `verb` label instead of
  // `inbox`'s `verb subverb "id"` shape.
  const label = argv[0] === 'inbox'
    ? 'inbox ' + String(argv[1] || result.action || '') + ' ' + JSON.stringify(String(result.id != null ? result.id : ''))
    : String(argv[0]);
  const line = '⚠️ anti-hall · devswarm: ' + label
    + ' reported known:false (' + reasons.join('; ') + ') — totals may be incomplete or stale';
  try { process.stderr.write(line + '\n'); } catch (_) {}
  return line;
}

module.exports = {
  cmdWorkspacesList, cmdGate, cmdNudge, cmdSkip, REASON_MAX_LEN, cmdGateIntent, cmdDone,
  cmdMigrate, cmdWakeDirective, parseSinceDuration, cmdLogs, KNOWN_WARNING_VERBS, emitKnownWarning,
};
