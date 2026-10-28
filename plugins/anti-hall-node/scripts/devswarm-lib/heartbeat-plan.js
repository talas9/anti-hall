'use strict';
// anti-hall :: devswarm CLI — HEARTBEAT-PLAN module (scripts/devswarm-lib/heartbeat-plan.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  ALLOWED_URGENCY, appendHeartbeatCallerLog, cliRun: run, csvList, devswarmRoot, dispatcherExports,
  fs, hasFlag, heartbeatPathFor, heartbeatsDir, many, nextHeartbeatTmp, one, os, path, planLib,
  readDescriptorFile, repokey, runningAntiHallVersion, store, supervisionMetrics, unionPendingFor,
  warnIdMismatch, writeVerdict,
} = require('./core.js');
const {
  BENIGN_MESH_BROADCAST_REASONS, broadcastFamilyOwns, callerIdentityDetailed,
  deriveAttemptRecordSessionId, ownerAppDbEnv, ownershipRefusalCause, projectCwdFor,
  realSessionIdFrom,
} = require('./identity.js');
const {
  refreshAnchorSession,
} = require('./register.js');
const {
  planRefFor, resolveMeshTarget,
} = require('./send.js');

// cmdPlan(sub, id, flags, ctx) — `plan set <id> --steps TEXT|--steps-file P
// [--scope glob,glob]` writes or replaces the numbered step list (an
// identical list is a no-op); `plan show <id>` prints it with the finish
// label. Explicit verbs: they work whatever devswarm.planTracking says.
function cmdPlan(sub, id, flags, ctx) {
  const home = ctx.home;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const ref = planRefFor(home, id, ctx);
  if (sub === 'show') {
    const found = planLib.findPlan(home, ref);
    if (!found) return { ok: false, action: 'plan', sub, id, reason: 'no-plan' };
    return { ok: true, action: 'plan', sub, id, key: found.key, label: planLib.finishLabel(found.plan, now), plan: found.plan };
  }
  if (sub !== 'set') return { ok: false, action: 'plan', error: 'usage: devswarm.js plan set <id> --steps "1. …\\n2. …"|--steps-file <path> [--scope glob,glob] | plan show <id>' };
  let text = one(flags, 'steps');
  const file = one(flags, 'steps-file');
  if (text === undefined && file !== undefined) {
    try { text = fs.readFileSync(String(file), 'utf8'); } catch (e) {
      return { ok: false, action: 'plan', sub, id, error: 'cannot read --steps-file: ' + String((e && e.message) || e) };
    }
  }
  const steps = planLib.parseSteps(text);
  if (!steps.length) {
    return { ok: false, action: 'plan', sub, id, error: 'no numbered step list found — pass at least two steps as "1. …" "2. …" lines via --steps or --steps-file' };
  }
  const scope = flags.scope ? planLib.splitGlobs(csvList(flags, 'scope').join(',')) : null;
  const found = planLib.findPlan(home, ref);
  const key = found ? found.key : (planLib.planKeyForWorktree(ref.worktreePath) || id);
  let created = false;
  let changed = false;
  const w = planLib.updatePlan(home, key, (cur) => {
    if (cur) { created = false; changed = planLib.replaceSteps(cur, steps, scope, now); return changed ? cur : null; }
    created = true; changed = true;
    return planLib.newPlan({ key, id, worktreePath: ref.worktreePath, steps, scope: scope || [], base: null, source: 'plan-set', now });
  });
  if (!w || !w.ok) return { ok: false, action: 'plan', sub, id, key, reason: 'lock-busy', error: 'the plan file is locked by another writer — retry' };
  if (created) supervisionMetrics.record(home, 'plan', { now, id, key, source: 'plan-set', steps: w.plan.steps.length });
  return { ok: true, action: 'plan', sub, id, key, created, changed, steps: w.plan.steps.length, scope: w.plan.scope_globs };
}

// cmdScope(sub, id, flags, ctx) — Meeseeks P2: `scope add <id> --glob G
// [--glob G2] --note TEXT`. The CHILD tags extra work the user asked for, so
// the supervisor's off-scope signal treats those paths as sanctioned and the
// Primary sees the note (roster `plan.extras`, table) and can challenge it.
// Idempotent (same glob + note = no change). A child without a plan gets a
// plan with no steps, which only carries the extras.
function cmdScope(sub, id, flags, ctx) {
  if (sub !== 'add') return { ok: false, action: 'scope', error: 'usage: devswarm.js scope add <id> --glob <glob> [--glob …] --note "<what the user asked for>"' };
  const home = ctx.home;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const globs = planLib.splitGlobs(csvList(flags, 'glob').join(','));
  const note = one(flags, 'note');
  if (!globs.length) return { ok: false, action: 'scope', sub, id, error: '--glob is required' };
  if (note === undefined || !String(note).trim()) return { ok: false, action: 'scope', sub, id, error: '--note is required: say what the user asked for, so the Primary can check it' };
  const ref = planRefFor(home, id, ctx);
  const found = planLib.findPlan(home, ref);
  const key = found ? found.key : (planLib.planKeyForWorktree(ref.worktreePath) || id);
  let changed = false;
  const w = planLib.updatePlan(home, key, (cur) => {
    const created = !cur;
    const plan = cur || planLib.newPlan({ key, id, worktreePath: ref.worktreePath, steps: [], scope: [], base: null, source: 'scope-add', now });
    changed = false;
    for (const g of globs) if (planLib.addExtra(plan, g, note, now)) changed = true;
    return changed || created ? plan : null;
  });
  if (!w || !w.ok) return { ok: false, action: 'scope', sub, id, key, reason: 'lock-busy', error: 'the plan file is locked by another writer — retry' };
  if (changed) supervisionMetrics.record(home, 'extra', { now, id, key, globs: globs.length });
  return { ok: true, action: 'scope', sub, id, key, changed, extras: w.plan.extras };
}

// cmdCorrect(id, flags, ctx) — Meeseeks P2: the Primary's correction for a
// straying child. Builds "step N '<text>': <reasons>. Return to step N or
// reply BLOCKED <why>" from the plan and the supervisor's straying state,
// sends it as a mesh direct (`send --to <id> --message-file`), and records
// `warned_at` on the plan (the stall clock restarts from it). `--dry-run`
// prints the text and changes nothing. Never automatic: only this verb sends.
function cmdCorrect(id, flags, ctx) {
  const home = ctx.home;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const found = planLib.findPlan(home, planRefFor(home, id, ctx));
  if (!found || !found.plan.steps.length) return { ok: false, action: 'correct', id, reason: 'no-plan', error: 'no step plan for ' + id + ' — a correction needs a step to return to' };
  const sup = require('../../companion/lib/devswarm-supervision.js');
  const stray = planLib.readStray(home, found.key);
  const message = sup.correctionText(id, found.plan, stray, now);
  if (hasFlag(flags, 'dry-run')) return { ok: true, action: 'correct', id, dryRun: true, message };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-correct-'));
  const msgFile = path.join(tmpDir, 'message.txt');
  let sent;
  try {
    fs.writeFileSync(msgFile, message);
    const argv = ['send', '--to', id, '--message-file', msgFile];
    sent = (ctx.io && typeof ctx.io.send === 'function') ? ctx.io.send(argv) : run(argv, ctx);
  } finally {
    try { fs.unlinkSync(msgFile); } catch (_) {}
    try { fs.rmdirSync(tmpDir); } catch (_) {}
  }
  const sendOk = !!(sent && sent.code === 0);
  if (!sendOk) return { ok: false, action: 'correct', id, message, sent: sent && sent.result, error: 'send failed — warned_at not recorded' };
  const w = planLib.updatePlan(home, found.key, (plan) => {
    if (!plan) return null;
    const cur = planLib.currentStep(plan);
    plan.warned_at = now;
    plan.warned_step = cur ? cur.n : null;
    plan.warned_signals = stray && Array.isArray(stray.active) ? Array.from(new Set(stray.active.map((a) => a.signal))) : [];
    // Jev recommendations the Primary saw when it decided to correct (follow /
    // override measure in supervision-report).
    plan.warned_jev = [];
    for (const a of (stray && Array.isArray(stray.active) ? stray.active : [])) {
      for (const n of (Array.isArray(a.jev) ? a.jev : [])) plan.warned_jev.push({ integration: n.integration, supports: n.supports === true });
    }
    return plan;
  });
  if (!w || !w.ok || !w.changed) return { ok: false, action: 'correct', id, message, sent: sent.result, error: 'the correction was sent, but warned_at could not be recorded (plan file locked or gone) — retry' };
  found.plan = w.plan;
  supervisionMetrics.record(home, 'correction', { now, id, key: found.key, step: found.plan.warned_step,
    signals: stray && Array.isArray(stray.active) ? stray.active.map((a) => a.signal) : [], jev: found.plan.warned_jev });
  return { ok: true, action: 'correct', id, message, warned_at: now, step: found.plan.warned_step, sent: sent.result };
}

// applyHeartbeatPlan(id, flags, ctx, now) -> the heartbeat result's `plan`
// field, or undefined when neither --step nor a plan-relevant --summary was
// given (the heartbeat result then stays byte-identical to before).
function applyHeartbeatPlan(id, flags, ctx, now) {
  const stepRaw = one(flags, 'step');
  const summary = one(flags, 'summary');
  if (stepRaw === undefined && summary === undefined) return undefined;
  const home = ctx.home;
  const found = planLib.findPlan(home, planRefFor(home, id, ctx));
  if (!found) {
    if (stepRaw === undefined) return undefined;
    return { ok: false, reason: 'no-plan', hint: 'no step plan for ' + id + ' — run `devswarm.js plan set ' + id + ' --steps "1. …\\n2. …"` first; the heartbeat itself was recorded' };
  }
  const status = one(flags, 'status') !== undefined ? String(one(flags, 'status')) : 'doing';
  let out = null;
  const events = [];
  // Read-modify-write under the plan lock: the mutation runs on the FRESH
  // on-disk plan, so a concurrent sweep or verb write is never overwritten.
  const w = planLib.updatePlan(home, found.key, (plan) => {
    events.length = 0;
    if (!plan) { out = { ok: false, reason: 'no-plan', key: found.key }; return null; }
    out = { ok: true, key: found.key };
    let dirty = false;
    if (stepRaw !== undefined) {
      const r = planLib.applyStep(plan, stepRaw, status, now);
      if (r.error) { out = { ok: false, reason: 'bad-step', error: r.error, key: found.key }; return null; }
      out.step = Number(stepRaw); out.status = status; out.changed = r.changed;
      if (r.changed) {
        dirty = true;
        events.push(['step', { now, id, key: found.key, step: Number(stepRaw), status }]);
        // The correction-worked measure: step progress within stepStallMin
        // of the Primary's last correction, counted once per correction.
        const wa = plan.warned_at;
        if (Number.isFinite(wa) && now >= wa && plan.correction_followed_for !== wa
            && now - wa <= planLib.stepStallMs({ env: ctx.env, home })) {
          plan.correction_followed_for = wa;
          events.push(['correction-followed', { now, id, key: found.key, step: Number(stepRaw), latencyMs: now - wa,
            signals: Array.isArray(plan.warned_signals) ? plan.warned_signals : [],
            jev: Array.isArray(plan.warned_jev) ? plan.warned_jev : [] }]);
        }
        // Respawn measure (Meeseeks P3): time from the respawn to the first
        // step progress in the new workspace, counted once.
        if (plan.respawn && typeof plan.respawn === 'object' && !Number.isFinite(plan.respawn.first_step_at)) {
          plan.respawn.first_step_at = now;
          events.push(['respawn-progress', { now, id, key: found.key, from: plan.respawn.from || null,
            latencyMs: Number.isFinite(plan.respawn.at) ? now - plan.respawn.at : null }]);
        }
      }
    }
    if (summary !== undefined) { planLib.recordSummary(plan, summary, stepRaw !== undefined, now); dirty = true; }
    out.label = planLib.finishLabel(plan, now);
    return dirty ? plan : null;
  });
  if (!w || !w.ok) return { ok: false, reason: 'lock-busy', key: found.key, hint: 'the plan file is locked by another writer — the heartbeat itself was recorded; re-send the step' };
  for (const [type, fields] of events) supervisionMetrics.record(home, type, fields);
  return out;
}

function cmdHeartbeat(id, flags, ctx) {
  const home = ctx.home;
  // defect 735b179362e8 (B): warn (never refuse) when a child heartbeats an
  // id other than its own real DEVSWARM_BUILDER_ID — see warnIdMismatch's
  // own header comment.
  const idMismatch = warnIdMismatch(id, ctx);
  refreshAnchorSession(ctx); // v0.108.0: anchor follows the running Primary session (fail-open)
  const dir = heartbeatsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  // R15 P2 (broadcastFamilyOwns leg a3, "placeholder row" test): captured
  // BEFORE this call's own base-heartbeat write below stamps `id`'s
  // heartbeats/<id>.json — that write always happens (the base heartbeat
  // "always succeeds" contract), so reading existence AFTER it would always
  // read true for the very id this call is about, poisoning the placeholder
  // check for exactly the only id it is ever asked about.
  const hadPriorHeartbeat = fs.existsSync(heartbeatPathFor(id, home));
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const progressRaw = one(flags, 'progress');
  let progress = null;
  if (progressRaw !== undefined) {
    const n = Number(progressRaw);
    if (Number.isFinite(n)) progress = Math.max(0, Math.min(100, n));
  }
  // Only assert what the caller actually supplied (heartbeat authorship rule:
  // never fabricate progress/phase/wip/blockers — absent = unknown = null/[]).
  const beat = {
    id,
    ts: now,
    state_ts: now,
    source: 'cli-heartbeat',
    progress_pct: progress,
    phase: one(flags, 'phase') !== undefined ? one(flags, 'phase') : null,
    wip: many(flags, 'wip'),
    blockers: many(flags, 'blockers'),
    sessionId: one(flags, 'session') !== undefined ? one(flags, 'session') : null,
    // item 4a: the CALLING process's own running anti-hall version — see
    // runningAntiHallVersion's header. Not caller-authored (unlike
    // progress/phase/wip/blockers/sessionId above) — this is a fact about the
    // process, always stamped, never left null just because a flag omitted it.
    version: runningAntiHallVersion(),
  };
  // A1-INSTRUMENT (spec item 1b): attribute the field-observed unidentified
  // dead-row refresher — any --session-less caller gets one capped NDJSON line.
  if (one(flags, 'session') === undefined) appendHeartbeatCallerLog(home, id, now);
  const p = path.join(dir, id + '.json');
  // P2-10: a UNIQUE staged temp per write (pid + hrtime + an in-process counter)
  // — a shared `<id>.json.tmp` let two concurrent heartbeats race, one rename
  // consuming the other's temp -> ENOENT. Uniqueness is derived from
  // process.pid + process.hrtime.bigint() (monotonic, per-process) + a counter,
  // deliberately NOT Math.random()/Date.now() (constrained/collision-prone here).
  const tmp = p + '.' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.' + nextHeartbeatTmp() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(beat));
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {} // never leak a staged temp on failure
    throw e;
  }

  // P2-11 (+ later union fix): compute `pending`/`notDraining`/`oldestUnreadAgeMs`
  // the SAME way computeLiveness does on its fresh-heartbeat short-circuit
  // (liveness.js's unionPendingFor — NDJSON ∪ store, not NDJSON-only) so the two
  // verdict-write paths AGREE — a disagreement here (this path stamping
  // `pending:false` over a store-only backlog the supervisor sweep reports as
  // `pending:true`) flaps the parent-gate signal exactly like the original P2-11
  // bug this comment used to describe. unionPendingFor is already fail-open
  // (falls back to NDJSON-only, never throws) so no extra try/catch semantics
  // are needed beyond what it already provides.
  let pending = false;
  let notDraining = false;
  let oldestUnreadAgeMs = null;
  // APP-DB ARCHIVE GUARD (0.109.1, field defect — see cmdRegister's matching
  // guard for the full story). A heartbeat from a still-running session in a
  // workspace the DevSwarm app reports archived must never be read as proof
  // of life: it must not clear the liveness verdict back to `alive`, and its
  // `--summary` must not broadcast into the mesh (the field incident's "idle
  // — awaiting task brief" came from exactly that broadcast reaching a
  // supposedly-archived row's `working_on`). The base heartbeat FILE write
  // above still always happens — this only gates the two ACTIVATING side
  // effects below, so `doctor`'s leak check (part (b)) still has a fresh
  // heartbeat file to detect the live session by. Fail-open: an
  // unreadable/absent app DB (appArchivedVerdict null) keeps today's
  // behavior exactly.
  let appArchived = null;
  try {
    const descForPending = readDescriptorFile(home, id);
    if (descForPending) {
      const union = unionPendingFor(descForPending, home, { now });
      pending = !!union.pending;
      notDraining = !!union.notDraining;
      oldestUnreadAgeMs = Number.isFinite(union.oldestUnreadAgeMs) ? union.oldestUnreadAgeMs : null;
      try {
        appArchived = require('../../companion/lib/devswarm-app-db.js').appArchivedVerdict({
          home, env: ctx.env, id, worktreePath: descForPending.worktreePath || null, now, xcache: true,
        }) === true;
      } catch (_) { appArchived = false; }
    }
  } catch (_) {
    pending = false; notDraining = false; oldestUnreadAgeMs = null; // fail-open
  }

  // v0.62 heartbeat-alive decouple (owner-approved — see liveness.js header): a
  // heartbeat is emitted only by this workspace's OWN live session, so receiving
  // one is definitive proof the env is ALIVE. Immediately CLEAR the persisted
  // liveness verdict to `alive` (resetting any stale/nudged/escalated flag +
  // nudge attempts) so the parent-gate and roster reflect liveness at once,
  // without waiting for the next supervisor sweep. The verdict's own
  // fresh-heartbeat short-circuit keeps it alive on subsequent recomputes.
  // Fail-open: an unsafe id (writeVerdict throws) or any fs error is swallowed —
  // the base heartbeat above already succeeded and must remain non-fatal.
  // Skipped entirely when appArchived (see above) — an app-archived row must
  // stay archived regardless of a new heartbeat.
  if (!appArchived) {
    try {
      writeVerdict(id, {
        status: 'alive', lastOutboundTs: now, staleSince: null,
        nudgeAttempts: 0, nudgedAt: null, pending, notDraining, oldestUnreadAgeMs,
        heartbeatTs: now,
      }, home);
    } catch (_) { /* fail-open: verdict refresh is best-effort, never breaks a heartbeat */ }
  }

  // v0.57 mesh (PLAN-v0.57-mesh.md D11/D22, Phase 4 step 4): `--summary TEXT`
  // ALSO broadcasts a mesh heartbeat row into THIS project's SHARED
  // store/<repoKey>/ — `mtype='broadcast'` + `is_heartbeat=1` (D22; never a
  // third mtype value), so it tiers as a broadcast and NEVER Stop-gates, and is
  // EXCLUDED from `broadcastUnread` (else every peer's per-turn heartbeat would
  // grow that counter forever). `sender` is set to `id` — the BUILDER-ID this
  // heartbeat is FOR (matching `deriveSummary`'s `working_on` match on
  // `sender===d.id`) — deliberately NOT `callerIdentity()`/meshId, a DIFFERENT
  // addressing handle (D19). The summary text is caller-supplied ONLY, never
  // defaulted/fabricated (D11 heartbeat authorship rule); omitting --summary is
  // a legacy no-op (back-compat, no mesh write at all). A non-git cwd (repoKey
  // null, O-D5 "mesh dormant") is NOT an error — the base heartbeat above still
  // succeeds; `meshBroadcast` reports why the mesh write was skipped.
  let meshBroadcast = null;
  const summaryText = one(flags, 'summary');
  if (summaryText !== undefined && appArchived) {
    // APP-DB ARCHIVE GUARD (0.109.1): never let an archived row's mesh
    // `working_on` be refreshed by a still-running session — see above.
    meshBroadcast = {
      ok: false, reason: 'app-archived', dropped: true, dropReason: 'app-archived',
      error: 'heartbeat --summary refused: workspace ' + id + ' is archived in the DevSwarm app; '
        + 'the summary was DROPPED (not broadcast) — the base heartbeat still succeeded',
    };
  } else if (summaryText !== undefined) {
    const cwd = projectCwdFor(ctx);
    const repoKey = repokey.repoKeyForWorktree(cwd);
    if (!repoKey) {
      meshBroadcast = { ok: false, reason: 'no-project' };
    } else {
      const urgencyRaw = one(flags, 'urgency');
      const urgency = urgencyRaw !== undefined ? urgencyRaw : 'low';
      if (!ALLOWED_URGENCY.includes(urgency)) {
        meshBroadcast = {
          ok: false,
          error: 'heartbeat --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
          allowed: ALLOWED_URGENCY.slice(),
        };
      } else {
        const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
        try {
          // P0 fix: `sender: id` above feeds recent[]/alreadyReportedThisEpisode()
          // (hooks/devswarm-child-gate.js's Stop-gate satisfaction check) — an
          // unvalidated `id` let ANY workspace forge another's "already reported"
          // row (`node devswarm.js heartbeat <victim-id> --summary ...`), spoofing
          // the victim's Stop-gate closed without it ever reporting. Same
          // provable-ownership check cmdSend (D18) and cmdInboxMessages' ack path
          // (D26) already use: literal self, or the caller's OWN registry entry
          // (joined by worktree-derived meshId via resolveMeshTarget) carries `id`
          // as its registered id.
          const callerInfo = callerIdentityDetailed(ctx.env, cwd);
          const caller = callerInfo.identity;
          const ownEntry = resolveMeshTarget(s, caller, home);
          // DEFECT ecd7ad60e4cc (P1) — IDENTITY-FAMILY MEMBERSHIP, NOT RAW-ID
          // EQUALITY. `resolveMeshTarget` returns exactly ONE row: whichever of
          // the caller's same-worktree rows pickFreshestLive ranks highest. A
          // child registered TWICE for one worktree (the builder-id UUID row +
          // the slug row — the documented pair in companion/lib/
          // devswarm-identity-family.js's header) therefore fails this check
          // whenever the winner is not the id being heartbeated: the field
          // report is `callerIdentity <builder-id> does not own <slug>`, with
          // DIRECT sends from the same child working fine (cmdSend resolves the
          // whole mesh group, not one row). The consequence is silent: the
          // refusal is BENIGN, so exit code 0 and ok:true, and the child's
          // working_on summary never reaches the mesh — the parent then reads
          // the child as going stale while it is heartbeating every turn.
          // realSessionIdFrom (Round 13 P0's established "caller's real session
          // id" helper — already trusted by callerOwnsRow/maybePromoteUnclaimed
          // for exactly this question) rather than the raw `beat.sessionId`
          // flag value: it filters out a self-referential id and a synthetic
          // `unclaimed:`-prefixed value, neither of which is a real session.
          const callerSessionId = realSessionIdFrom(flags, ctx, id);
          const owns = caller === id
            || (ownEntry && ownEntry.id === id)
            || broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId, hadPriorHeartbeat, callerInfo.kind, ownerAppDbEnv(ctx));
          if (!owns) {
            // A7: name WHICH leg failed instead of one generic message for
            // an unresolvable identity, an unregistered caller, AND a genuine
            // mismatch alike.
            const cause = ownershipRefusalCause(callerInfo.kind, ownEntry);
            meshBroadcast = {
              ok: false,
              reason: cause,
              // CARRY-OUT (g): the refusal stays BENIGN — `ok:true` at the top
              // level, exit code 0 — because it is a working security control
              // doing its job, and the BASE heartbeat genuinely succeeded (see
              // BENIGN_MESH_BROADCAST_REASONS). But "benign" was being read by
              // callers as "applied": nothing in the response said the SUMMARY
              // itself was thrown away, so a caller that set --summary and got
              // ok:true had no way to learn its working_on text never reached
              // the mesh. `dropped`/`dropReason` say so explicitly, WITHOUT
              // changing the ok:true contract this reason deliberately keeps.
              // Scoped to this refusal only — no other benign reason's shape
              // changes (the no-project dormancy case is untouched).
              dropped: true,
              dropReason: cause,
              error: 'heartbeat --summary refused (' + cause + '): caller ' + JSON.stringify(caller)
                + ' does not own workspace ' + JSON.stringify(id)
                + ' — the summary was DROPPED (not broadcast); the base heartbeat still succeeded',
              callerIdentity: caller,
              // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
              // `kind` (resolved/declared/unresolvable) alongside the existing
              // `callerIdentity` string, never replacing it.
              identity: { id: caller, kind: callerInfo.kind },
            };
            // defect a55d6b71a76f fix (root cause A): a benignly-DROPPED
            // broadcast never reaches store recent[], so
            // hooks/devswarm-child-gate.js's alreadyReportedThisEpisode()
            // (which reads ONLY recent[]) can never see that this child DID
            // attempt to report — the Stop gate then re-fires the SAME
            // heartbeat command forever, even though the child followed the
            // gate's own instruction every turn. Write a local, bounded
            // attempt record the gate can read directly (no mesh write, no
            // store dependency) so a dropped-but-attempted report still
            // counts. Fail-open: never let telemetry break the heartbeat.
            try {
              // Wave 3 addendum item 7 (P2 race fix): PER-ID file, never a
              // single shared per-repoKey file — the old shape was a plain
              // read-modify-write-rename of ONE file, so two concurrent
              // sibling writers (different ids, same repoKey) raced the
              // rename and silently dropped whichever wrote second's row
              // (proof: scratchpad/dl-gate/r2-critic/race.js). Splitting by
              // writer id removes the cross-id race entirely; the reader
              // (hooks/devswarm-child-gate.js's findRecentDropAttempt) scans
              // every id's file under the repoKey directory, so this is a
              // pure storage-layout change with no read-side behavior loss.
              const attemptDir = path.join(devswarmRoot(home), 'summary-attempts', repoKey);
              fs.mkdirSync(attemptDir, { recursive: true });
              const attemptFile = path.join(attemptDir, id + '.ndjson');
              // P0-1 fix (gate-fix Wave 2 round-1 review): the record was
              // keyed by the TARGET id + project-wide repoKey with NO
              // writer authentication — any sibling in the same worktree
              // could satisfy another child's Stop gate by heartbeating
              // `<victim-id> --summary ...` itself (the drop is benign/
              // ok:true precisely because it's an ownership refusal, so a
              // forger pays no cost). Stamp `instanceNonce` (this OS
              // process's own per-process discriminator, same value the
              // real broadcast path already stamps outbound rows with —
              // see deriveInstanceNonce above) so the gate can require the
              // record came from ITS OWN process/session family, not merely
              // that SOME process in the worktree wrote a row naming the
              // victim id.
              //
              // Wave 3 addendum item 11 (P1 forgery fix): `sessionId` is
              // NEVER `callerSessionId` here (that prefers the caller-
              // supplied `--session` FLAG value — attacker-chosen, proves
              // nothing about the writing process) — see
              // deriveAttemptRecordSessionId's own header for the proven
              // forgery this closes. Omitted (null) when no trustworthy
              // source resolves, which leaves the record nonce-only
              // authenticated (still a valid acceptance path above).
              const row = {
                ts: now,
                id,
                reason: cause,
                summary: String(summaryText).slice(0, 120),
                instanceNonce: dispatcherExports().deriveReaderNonce(ctx),
                sessionId: deriveAttemptRecordSessionId(ctx, id),
                // pid: diagnostic-only (never an authentication input — the
                // gate's mismatch diagnostic, item 6, cites nonce/session
                // prefixes, not this) — lets an operator correlate a
                // recorded mismatch back to the exact writing process.
                pid: process.pid,
              };
              // Item 7: append-only (fs.appendFileSync, O_APPEND) — no read-
              // modify-write-rename of the whole file on THIS hot path, so
              // two concurrent writers for the SAME id no longer clobber
              // each other's row via THE APPEND ITSELF (each append lands
              // independently; POSIX O_APPEND is atomic for a write this
              // small). Trimming to the last 50 lines is decoupled from the
              // append and only runs (tmp+rename) once the file has grown
              // past 100 lines, so the common case pays exactly one syscall.
              //
              // KNOWN, BOUNDED RACE (Wave R3 Auditor P2 — corrects the
              // over-broad claim above, which read as "no clobbering,
              // period"): the trim block below IS its own read-modify-write
              // — it reads a snapshot, then later renames a NEW file built
              // from that snapshot over the original. A concurrent SAME-id
              // append landing strictly BETWEEN the read and the rename is
              // not part of the snapshot and is silently overwritten by the
              // rename — genuinely dropped, not merely delayed. No locking
              // is used to close this: same-id concurrent writers are rare
              // (this file is per-writer-id already; only a highly unusual
              // shape — e.g. two processes racing to write drop-attempts for
              // the identical id at the identical moment the file happens to
              // cross the 100-line trim threshold — hits the window), and
              // the worst-case cost of a lost row is bounded and cheap: the
              // gate simply does not see that ONE attempt as satisfying the
              // episode and forces one extra (capped) Stop block, not a
              // correctness or security failure.
              fs.appendFileSync(attemptFile, JSON.stringify(row) + '\n');
              try {
                const lines = fs.readFileSync(attemptFile, 'utf8').split('\n').filter(Boolean);
                if (lines.length > 100) {
                  const trimmed = lines.slice(lines.length - 50).join('\n') + '\n';
                  // P2 fix: atomic tmp+rename (same pattern as the per-id
                  // heartbeat file above) — a reader must never observe a
                  // half-written ndjson file. This closes PARTIAL-READ
                  // corruption only; it does NOT close the read-then-rename
                  // race described above (a concurrent same-id append in
                  // that window is still lost, not merely torn).
                  const attemptTmp = attemptFile + '.' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.' + nextHeartbeatTmp() + '.tmp';
                  try {
                    fs.writeFileSync(attemptTmp, trimmed);
                    fs.renameSync(attemptTmp, attemptFile);
                  } catch (e) {
                    try { fs.unlinkSync(attemptTmp); } catch (_) {}
                    throw e;
                  }
                }
              } catch (_) { /* fail-open: trim is best-effort — the append above already succeeded */ }
            } catch (_) { /* fail-open: attempt record is best-effort */ }
          } else {
            const fields = { from: id, to: null, type: 'broadcast', message: String(summaryText), timestamp: now, urgency };
            const hash = store.meshMessageHash(fields);
            const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash, isHeartbeat: true, instanceNonce: dispatcherExports().deriveReaderNonce(ctx) }));
            store.deriveSummary(s, { home, env: ctx.env, now });
            meshBroadcast = { ok: true, sent: !!res.inserted, seq: res.seq, repoKey };
          }
        } finally { s.close(); }
      }
    }
  }
  // P1 fix: cmdHeartbeat's top-level `ok` (and therefore the CLI exit code —
  // see the 'heartbeat' dispatcher case's `code: r.ok ? 0 : 2`) used to be
  // hardcoded `true` regardless of `meshBroadcast`'s outcome, so a genuinely
  // BAD invocation (e.g. `--urgency bogus`) still reported success end-to-end
  // — invisible to any standard exit-code check. Fold in a HARD meshBroadcast
  // failure (any `ok:false` whose `reason` is not in the deliberately-benign
  // BENIGN_MESH_BROADCAST_REASONS set above) so a real caller mistake is no
  // longer silently masked, while the two documented/tested benign shapes
  // (no-project dormancy, ownership-refusal-as-security-control) keep the
  // base heartbeat reporting `ok:true`, unchanged.
  const hardMeshFailure = !!(meshBroadcast && meshBroadcast.ok === false
    && !BENIGN_MESH_BROADCAST_REASONS.has(meshBroadcast.reason));
  // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's `kind`
  // (resolved/declared/unresolvable) on the SUCCESS result too, not only the
  // ownership-refusal path above (which already carries it). Computed fresh
  // here (callerIdentityDetailed is a pure cwd/env resolution, no fs writes)
  // rather than threading the summary-branch's own `callerInfo` out of its
  // narrower scope — this never fires when --summary is absent, so a
  // second, cheap call keeps this additive without restructuring that path.
  let identity = null;
  try {
    const d = callerIdentityDetailed(ctx.env, ctx.cwd || process.cwd());
    identity = { id: d.identity, kind: d.kind };
  } catch (_) { identity = null; }
  const out = { ok: !hardMeshFailure, action: 'heartbeat', id, heartbeat: beat, meshBroadcast, identity, idMismatch };
  if (appArchived) out.appArchived = true;
  // 0.117.1 (item B): a DROPPED --summary is otherwise only visible by
  // noticing `meshBroadcast.dropped`/`dropReason` buried inside a nested
  // object (field report: an agent read the JSON and never noticed its
  // summary never reached the mesh). One plain, top-level line makes a drop
  // impossible to miss without changing the existing benign ok:true contract.
  if (meshBroadcast && meshBroadcast.dropped) {
    out.note = 'summary NOT recorded: ' + (meshBroadcast.dropReason || meshBroadcast.reason || 'unknown');
  }
  // Plan tracking (Meeseeks P1): `--step N [--status doing|done|blocked]`
  // records step progress in the workspace's plan. Additive: absent unless
  // --step is passed or a plan exists for a --summary. A malformed --step on
  // an existing plan is a caller mistake (ok:false, exit 2), like a bad
  // --urgency; a missing plan is benign (the base heartbeat still counts).
  let planOut;
  try { planOut = applyHeartbeatPlan(id, flags, ctx, now); } catch (e) { planOut = { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
  if (planOut !== undefined) {
    out.plan = planOut;
    if (planOut.reason === 'bad-step') out.ok = false;
  }
  return out;
}

module.exports = {
  cmdPlan, cmdScope, cmdCorrect, applyHeartbeatPlan, cmdHeartbeat,
};
