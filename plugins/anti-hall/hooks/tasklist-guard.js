#!/usr/bin/env node
// anti-hall :: tasklist-guard (Stop hook, loop-safe)
//
// Fires on Stop. Enforces that NON-TRIVIAL work performed this session was
// actually TRACKED as tasks AND has a fresh progress file. This COEXISTS with
// task-guard (which checks that DECLARED tasks were drained / not left open):
//   - task-guard      : "you declared tasks — don't stop with them still open."
//   - tasklist-guard  : "you did real work — was it tracked, and is progress fresh?"
// Both can fire on the same Stop; each keeps its OWN independent block cap, so
// the two never compound into a runaway loop.
//
// BLOCK iff (and the guard is not skipped):
//   WORK_COUNT >= threshold  AND  ( no task activity seen
//                                   OR a task left in_progress (stale)
//                                   OR no fresh per-session progress file ).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id, transcript_path, cwd, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : ALWAYS — fail-open on any error so a hook bug never hard-loops Claude.
//            Plugin caveat (KB §): plugin-packaged Stop hooks do NOT reliably
//            continue on exit 2, so we block via the JSON decision form + exit 0,
//            never exit 2.
//
// Cold-start caveat (KB §): transcript_path can be absent / unflushed on the very
// first turn → we exit 0 (fail-open) rather than guess.
//
// State (loop-safety) lives under ~/.anti-hall/ keyed by session_id (never the
// project tree). Stores { hash, blocks }; same signal twice → no re-block; a hard
// MAX_BLOCKS cap stops churn-driven loops.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { appendIndexLineIfAbsent } = require('./session-history-index.js');
// repoRoot(cwd) -- the canonical resolver (companion/lib/identity.js via
// hooks/lib/handover-find.js): every .anti-hall/progress|history|handovers
// path below is joined onto the RESOLVED repo root, never the raw session
// cwd -- a cwd already inside .anti-hall/handovers/... must not double onto
// itself (2026-09-25 PreCompact doubled-path bug; same root cause here).
const { repoRoot } = require('./lib/handover-find.js');

// DEFERRED (accepted): (a) cumulative work counters vs the 512 KB tail clip — work
// before the window is unseen, which can only SUPPRESS a block (fail-open, the safe
// direction); (b) sync-I/O stall on a network-mounted cwd — the harness 30 s hook
// timeout makes a non-block (fail-open) the outcome. Neither is fixed here by design.
const MAX_BLOCKS = 3;
const DEFAULT_WORK_THRESHOLD = 3;
const DEFAULT_PROGRESS_FRESH_MS = 30 * 60 * 1000; // 1,800,000 ms
const UNKNOWN_SESSION = 'unknown-session';

// Work detection (what counts as a file-changing action) lives in ONE shared
// helper, hooks/lib/work-detect.js, so the auto-handover freshness check
// (hooks/lib/handover-freshness.js) judges "work after the handover" with
// exactly the same rules as this guard.
const {
  MUTATING_TOOLS,
  BASH_WORK_RE,
  isCountedWork,
  neutralizeQuotedContents,
  collectToolUses,
} = require('./lib/work-detect.js');

// commandWritesToPath(cmd, targetPath) -> bool. Used ONLY to attribute a
// progress-file WRITE (never a read) to lastProgressWriteTs (Codex review
// fix): a plain `cat <progressAbsPath> >> /elsewhere` reads the progress file
// and writes somewhere else — the old check (`cmd.indexOf(progressAbsPath)`)
// treated any appearance of the path anywhere on the line as a write. This
// only counts a redirect (`>`/`>>`) whose TARGET is exactly targetPath, or a
// `tee`/`cp`/`mv` invocation whose LAST path-looking argument is targetPath —
// the actual write-destination positions for the verbs BASH_WORK_RE detects.
function commandWritesToPath(cmd, targetPath) {
  if (!targetPath) return false;
  const redirectTarget = cmd.match(/(?<![0-9&])>{1,2}(?!&)\s*("[^"]*"|'[^']*'|\S+)/);
  if (redirectTarget) {
    const raw = redirectTarget[1].replace(/^["']|["']$/g, '');
    if (raw === targetPath) return true;
  }
  const teeOrCopy = cmd.match(/\b(?:tee|cp|mv)\b[^;&|\n]*/);
  if (teeOrCopy) {
    const parts = teeOrCopy[0].split(/\s+/).filter((t) => t && !t.startsWith('-'));
    const last = parts[parts.length - 1];
    if (last === targetPath) return true;
  }
  return false;
}

function main() {
  // Settings switch guards.tasklistGuard (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('guards', 'tasklistGuard')) return; } catch (_) { /* run */ }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('tasklist-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  // PLAN MODE (permission_mode === 'plan'): reported false positive — a
  // session stuck in Claude Code PLAN MODE got blocked on Stop, repeatedly,
  // demanding a write to .anti-hall/progress/<date>/<session>.md. Plan mode is
  // a read-only planning session where only the harness's own plan file can
  // be written (docs/KB-model-modes.md) — the progress-file write this guard
  // demands is structurally impossible there, so the block just loops until
  // the user manually leaves plan mode. `permission_mode` is the SAME
  // harness-set, top-level field edit-guard.js already trusts for its own
  // plan-mode exemption (isPlanMode() in edit-guard.js) — same trust class as
  // tool_name/session_id, not model/tool-settable. Case-insensitive for
  // safety; any non-string is not plan mode. Never blocks in plan mode — at
  // most a non-blocking advisory note so the agent still gets the reminder
  // once it leaves plan mode.
  if (typeof (payload && payload.permission_mode) === 'string' &&
      payload.permission_mode.toLowerCase() === 'plan') {
    try {
      fs.writeSync(1,
        '[tasklist-guard] PLAN MODE — Stop not blocked (progress-file writes are not ' +
        'possible in plan mode). Track this work as tasks and refresh the progress file ' +
        'once you leave plan mode.\n'
      );
    } catch (_) { /* best-effort advisory only */ }
    process.exit(0);
  }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    process.exit(0); // cold-start fail-open
  }

  // Session/progress-path identity computed BEFORE the scan so the single-pass
  // scanner can ALSO watch for a Write/Edit/MultiEdit/Bash tool call that targets
  // this exact progress file (see FIX 6 below) — independent of the file's mtime.
  const rawSessionId = payload && payload.session_id != null ? String(payload.session_id) : '';
  const sessionIdForPath = sanitizeSessionId(rawSessionId);
  const progressDate = new Date().toISOString().slice(0, 10);
  const progressHeader = '<!-- session: ' + (rawSessionId || UNKNOWN_SESSION) +
    ' | started: ' + new Date().toISOString() + ' -->';
  const progressRelPath = path.join('.anti-hall', 'progress', progressDate, sessionIdForPath + '.md');
  const historyRelPath = path.join('.anti-hall', 'history', progressDate, sessionIdForPath + '.md');
  const cwd = payload && payload.cwd;
  const root = (cwd && typeof cwd === 'string') ? repoRoot(cwd) : cwd;
  const progressAbsPath = (root && typeof root === 'string') ? path.join(root, progressRelPath) : null;
  // historyAbsPath (P1 fix, coordinator safety-review 2026-09-25): the block
  // message must name the path the guard itself reads/writes (root-joined),
  // never the bare relative path -- with cwd = repo/packages/foo, root is the
  // repo toplevel, and a message naming the RELATIVE path led the agent to
  // write packages/foo/.anti-hall/... where this guard never looks, blocking
  // every Stop until the loop cap.
  const historyAbsPath = (root && typeof root === 'string') ? path.join(root, historyRelPath) : null;

  // Single-pass scan: WORK_COUNT, sawTaskActivity, reconstructed task state, and
  // (FIX 6) the newest transcript-observed write to the progress file itself.
  let scan;
  try {
    scan = scanTranscript(transcriptPath, { progressAbsPath });
  } catch (_) {
    process.exit(0);
  }

  const threshold = readThreshold();
  const workCount = scan.workCount;
  const sawTaskActivity = scan.sawTaskActivity;
  const hasStaleInProgress = scan.hasStaleInProgress;
  const inProgressCount = scan.inProgressCount;
  const openTaskIds = scan.openTaskIds;

  // Progress-file freshness — relative to the session's cwd.
  //
  // Fail-open layering (FIX 5): we stat the cwd DIRECTORY first. If cwd is absent
  // from the payload, not a string, or unreadable (stat throws → e.g. cwd no
  // longer exists), we treat progress as fresh and never block on an environment
  // we cannot inspect. We only set progressFresh = false when the cwd EXISTS but
  // the progress file is absent or stale — that is the case we actually want to nudge.
  //
  // FIX 4: use lstatSync (not statSync) and require a real regular file. A
  // directory named like the progress file would always look "fresh" (a dir mtime
  // bumps on any child change); a SYMLINK could spoof freshness by pointing at an
  // always-touched file. lstat does not follow the link, and st.isFile() rejects
  // both a directory and a symlink — only a real regular file counts as progress.
  let progressFresh = true;
  if (cwd && typeof cwd === 'string') {
    let cwdExists = false;
    try {
      cwdExists = fs.statSync(cwd).isDirectory();
    } catch (_) {
      cwdExists = false; // cwd missing/unreadable → fail-open below
    }
    if (!cwdExists) {
      progressFresh = true; // FIX 5: cwd unreadable → fail-open, do not block
    } else {
      const progressDir = path.join(root, '.anti-hall', 'progress', progressDate);
      let progressDirReady = true;
      try {
        fs.mkdirSync(progressDir, { recursive: true });
      } catch (_) {
        progressDirReady = false;
      }
      if (!progressDirReady) {
        progressFresh = true; // cannot prepare progress dir → fail-open
      } else {
        try {
          const pPath = path.join(root, progressRelPath);
          const st = fs.lstatSync(pPath); // FIX 4: lstat — do NOT follow symlinks
          if (!st.isFile()) {
            progressFresh = false; // a dir or symlink named like the file ≠ real progress
          } else {
            maintainSessionIndex(root, progressDate, sessionIdForPath, 'progress');
            const age = Date.now() - st.mtimeMs;
            progressFresh = age <= readFreshMs();
          }
        } catch (_) {
          // cwd EXISTS but the progress file is absent (ENOENT) → not fresh → nudge.
          progressFresh = false;
        }
      }
    }
  } else {
    progressFresh = true; // no cwd → can't locate the file → fail-open
  }

  // FIX 6 (defense-in-depth, NOT the confirmed root cause of #17 — see FIX 7
  // below for that; kept because it is a real, cheap-to-close gap even though
  // it wasn't what actually fired in the transcripts we checked): mtime is
  // not the ONLY trustworthy freshness signal. A just-written progress file
  // could in principle still read as missing/stale here if the write and this
  // read raced across process/mount boundaries (e.g. a background-agent
  // sandbox writing through a different mount than the one this Stop hook
  // stats). The transcript itself is ground truth for "did THIS session's own
  // tool calls write to THIS exact progress path" — scanTranscript (above)
  // already looked for a Write/Edit/MultiEdit targeting progressAbsPath, or a
  // Bash command that both matches the mutating-command heuristic AND names
  // progressAbsPath, and returned the newest such write's transcript
  // timestamp. OR that signal into progressFresh: EITHER a fresh mtime OR a
  // recent transcript-observed write to the file resets the "go update
  // progress" requirement. This can only flip progressFresh from false to
  // true (never true to false), so it stays fail-open/no-loop-risk exactly
  // like every other signal in this file.
  if (!progressFresh && scan && Number.isFinite(scan.lastProgressWriteTs) && scan.lastProgressWriteTs > 0) {
    const progressWriteAge = Date.now() - scan.lastProgressWriteTs;
    if (progressWriteAge <= readFreshMs()) {
      progressFresh = true;
    }
  }

  // History-index maintenance — purely a side effect, NEVER affects blocking.
  // Unlike progress, history has no "freshness" concept (it's an append-only
  // per-task ledger, not a per-turn current-state file), so the trigger here
  // is EXISTENCE, not mtime/age: if this session has written anything to its
  // own per-session history file, ensure exactly one index line exists for it.
  // Wrapped so any error here can never affect progressFresh/shouldBlock above.
  try {
    if (root && typeof root === 'string') {
      const hSt = fs.lstatSync(historyAbsPath); // lstat — do NOT follow symlinks (mirrors progress's guard)
      if (hSt.isFile()) {
        maintainSessionIndex(root, progressDate, sessionIdForPath, 'history');
      }
    }
  } catch (_) {
    // History file absent, cwd unreadable, or any other error — no-op, fail-open.
  }

  // RESUME-VERIFICATION ENFORCEMENT (v0.75.0, tasklist-guard-family Stop
  // check). handover-resume.js (SessionStart) writes a small per-session
  // marker under ~/.anti-hall/ whenever it injects the guided-resume
  // protocol, naming the HANDOVER file it pointed at. If THIS session went on
  // to make file-changing actions without ever recording a `resume-verified:`
  // line in that HANDOVER file, nudge ONCE (capped, own state key — never
  // re-derived from the dedup/MAX_BLOCKS machinery below, which is tuned for
  // a churn-tolerant counter, not this single boolean). Runs BEFORE the
  // trivial-session early-return below so it can fire independently of the
  // normal shouldBlock signal — a session can legitimately track tasks and
  // keep progress fresh yet still have skipped verifying a resumed handover
  // before acting on it. Fail-open throughout: any error skips the nudge,
  // never blocks/throws, and never touches shouldBlock/finalReason below.
  try {
    const resumeReason = checkResumeVerification({
      homeDir: os.homedir(),
      sessionId: sessionIdForPath,
      workCount,
      threshold,
    });
    if (resumeReason) {
      fs.writeSync(1, JSON.stringify({ decision: 'block', reason: sanitizeReason(resumeReason) }) + '\n');
      process.exit(0);
    }
  } catch (_) { /* fail-open: skip the resume nudge entirely */ }

  // Below the work threshold → trivial session → never block.
  if (workCount < threshold) {
    process.exit(0);
  }

  const shouldBlock = !sawTaskActivity || hasStaleInProgress || !progressFresh;
  if (!shouldBlock) {
    process.exit(0);
  }

  // JEV (tasklistTrivial, default "shadow" — hooks/lib/jev-assist.js consultRelax): a
  // raw count treats every edit the same, so a small bounded chore can trip
  // this nudge. In shadow/off the consult is fire-and-forget (logged for
  // `jev report`, zero latency). In "on" it is asked SYNCHRONOUSLY with a
  // 1.5 s cap: a confident "trivial" verdict (final === false under
  // relax-block trust) skips the nudge; a timeout or failure keeps today's
  // verdict (fail-open to nudging).
  let jevRelax = null;
  try {
    jevRelax = require('./lib/jev-assist.js').consultRelax({
      id: 'tasklistTrivial',
      question: {
        type: 'noul',
        instructions: 'This session is about to be nudged to track its work as tasks / ' +
          'refresh its progress file. Judge the session summary below: does this look like ' +
          'a genuinely non-trivial, multi-part effort that benefits from task tracking, as ' +
          'opposed to a small, bounded, single-purpose chore?',
        criteria: {
          true: 'genuinely non-trivial — multi-part, benefits from task tracking',
          false: 'a small bounded chore — task tracking would be overhead, not help',
        },
      },
      state: 'workCount=' + workCount + ' threshold=' + threshold +
        ' sawTaskActivity=' + sawTaskActivity + ' hasStaleInProgress=' + hasStaleInProgress +
        ' progressFresh=' + progressFresh + ' openTaskCount=' + openTaskIds.length,
      trust: 'relax-block',
      baseline: true,
      sessionId: rawSessionId || undefined,
      turnRef: require('./lib/jev-assist.js').turnRefFromTranscript(transcriptPath),
    });
  } catch (_) { /* best-effort — never affects the nudge below */ }
  if (jevRelax && jevRelax.final === false) process.exit(0); // on + confident "trivial" -> no nudge

  // --- loop-safety state -----------------------------------------------------
  const sessionId =
    rawSessionId ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'tasklist-guard-state-' + safeSession + '.json');

  // Dedup signal = bucketed work + the three sub-causes + a hash of open task ids.
  const workBucket = Math.min(Math.floor(workCount / threshold), 8);
  const openHash = crypto
    .createHash('sha1')
    .update(openTaskIds.slice().sort().join('\x00'))
    .digest('hex')
    .slice(0, 16);
  const signal = [
    workBucket,
    sawTaskActivity ? 1 : 0,
    hasStaleInProgress ? 1 : 0,
    progressFresh ? 1 : 0,
    openHash,
  ].join('|');
  const hash = crypto.createHash('sha1').update(signal).digest('hex');

  let lastHash = '';
  let blocks = 0;
  try {
    const rawState = fs.readFileSync(stateFile, 'utf8').trim();
    if (rawState) {
      const parsed = JSON.parse(rawState);
      if (parsed && typeof parsed === 'object') {
        lastHash = typeof parsed.hash === 'string' ? parsed.hash : '';
        blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
      }
    }
  } catch (_) {
    // first time / cleared
  }

  if (hash === lastHash) {
    process.exit(0); // already nudged for this exact signal
  }
  if (blocks >= MAX_BLOCKS) {
    process.exit(0); // hard cap — never loop on churn
  }

  // STALE-BUILD DOWNGRADE (peer complaint #2): installed_plugins.json already
  // registered a newer anti-hall version than this running hook process — the
  // fix, if any, may already be on disk waiting on a restart. Downgrade this
  // block to advisory (skip it) until then.
  try {
    if (require('./lib/stop-version-gate.js').isStale(path.join(__dirname, '..'), { env: process.env, home: os.homedir() })) {
      process.exit(0);
    }
  } catch (_) { /* fail-open: block normally on any error */ }

  // SIGNATURE-ACK (peer complaint #1): once the user has explicitly confirmed
  // this exact signal is a false positive and the agent has acked it (see
  // stop-ack.js), stay silent for it for the rest of the session — a changed
  // `hash` (real signal change) is a new signature and blocks normally.
  const stopAck = require('./lib/stop-ack.js');
  const ackSignature = stopAck.signatureFor(hash);
  if (sessionId && stopAck.isAcked(os.homedir(), sessionId, 'tasklist-guard', ackSignature)) {
    process.exit(0);
  }

  // Pick the MOST-SPECIFIC sub-cause for the lead sentence.
  let lead;
  if (!sawTaskActivity) {
    lead =
      'You made ' + workCount + ' file-changing actions this session but tracked ' +
      'NO tasks.';
    // THREAD (v0.75.0): a NO-TASKS session may simply be a fresh resume that
    // never rebuilt its task list from a PRIOR session's handover snapshot —
    // point at it (if one exists) rather than let the agent invent a list from
    // scratch. Capped implicitly by hash-dedup above (same lead text -> same
    // signal each Stop until sawTaskActivity flips true). Fail-open: any error
    // here just omits the pointer, never blocks/throws.
    try {
      const priorState = findPriorSessionStateFile(root, progressDate, sessionIdForPath);
      if (priorState) {
        lead += ' A prior session\'s handover snapshot exists at ' + priorState +
          ' — recreate your task list from ' + priorState + ' first.';
      }
    } catch (_) { /* fail-open: omit the pointer */ }
  } else if (hasStaleInProgress) {
    lead =
      inProgressCount + ' tasks are in_progress but NO background agent is live — they are ' +
      'STALLED, not being worked in parallel. DISPATCH a background agent for EACH now so they ' +
      'progress concurrently (do NOT serialize down to one), or set the idle ones back to ' +
      'pending. Priority ≠ stop the rest: spin the HIGHEST-priority task\'s agent FIRST and ' +
      'check it more often, but keep the others running in parallel — never pause them.';
  } else {
    lead =
      'You made ' + workCount + ' file-changing actions but ' +
      (progressAbsPath || progressRelPath) + ' is missing or stale.';
  }

  const reason = sanitizeReason(
    lead +
      ' Capture this work as priority-sorted tasks via TaskCreate/TaskUpdate ' +
      '(check TaskList FIRST to dedup/relate — do not duplicate an existing task; ' +
      'link related ones with addBlockedBy/addBlocks), set statuses ' +
      '(in_progress/completed), and update ' + (progressAbsPath || progressRelPath) + ' ' +
      '(done/in-progress/next); if creating it, put this header at the very top: ' +
      progressHeader + '. Gitignore it so it never ships. ' +
      'Also append each COMPLETED task to ' + (historyAbsPath || historyRelPath) + ' (append-only ' +
      'ledger, one entry per task: Cause / Fix / Verified) so the fix history ' +
      'persists across sessions — gitignore it too.'
  );

  // OMC-awareness: if an autonomous OMC loop (ralph, ultrawork, autopilot, etc.)
  // is active, SUPPRESS the Stop block — emit a one-line advisory and exit 0.
  // Not counted against the block budget (no state write). Detection errors fall
  // through to the normal block path (fail-open = guard stays active).
  try {
    const { isOmcLoopActive } = require('./omc-detect.js');
    const sid = (payload && payload.session_id && String(payload.session_id)) || undefined;
    if (isOmcLoopActive({ cwd: cwd || undefined, sessionId: sid })) {
      // fs.writeSync(1): process.stdout.write races the async pipe flush with
      // exit() on macOS node 18/20 (repo-wide rule for hook output).
      fs.writeSync(1,
        '[tasklist-guard] OMC autonomous loop active — deferring Stop block to avoid deadlock.\n'
      );
      process.exit(0);
    }
  } catch (_) {
    // detection error → fall through to normal block
  }

  // THREAD 5 (owner amendment 2026-08-07): boundary-surfacing advisory. When
  // this Stop is ALREADY about to block (shouldBlock, reached this point) AND
  // no session-handover dir exists yet, append ONE capped advisory line onto
  // the existing reason reminding the agent to write one before ending. This
  // NEVER creates a new block on its own -- it only rides an already-decided
  // block -- and is capped once per session via its own state key so it never
  // repeats nagging on subsequent Stops.
  let finalReason = reason;
  try {
    if (root && typeof root === 'string') {
      const handoverDir = path.join(root, '.anti-hall', 'handovers', progressDate, sessionIdForPath);
      let handoverDirExists = false;
      try {
        handoverDirExists = fs.statSync(handoverDir).isDirectory();
      } catch (_) {
        handoverDirExists = false;
      }
      if (!handoverDirExists) {
        const advStateFile = path.join(stateDir, 'tasklist-guard-handover-advisory-' + safeSession + '.json');
        let alreadyAdvised = false;
        try {
          alreadyAdvised = fs.existsSync(advStateFile);
        } catch (_) {
          alreadyAdvised = false;
        }
        if (!alreadyAdvised) {
          finalReason = sanitizeReason(
            finalReason + ' Also: significant work this session and no handover exists — ' +
            'consider /anti-hall:handover before ending.'
          );
          try {
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(advStateFile, JSON.stringify({ advised: true }), 'utf8');
          } catch (_) {
            // best-effort cap; the advisory line above already went into finalReason
            // this once regardless, which is fine -- worst case it repeats once more.
          }
        }
      } else {
        // THREAD 7b (owner amendment 2026-08-07): staleness rail. A handover
        // dir exists for this session -- if a counted file-changing action's
        // own entry timestamp (scan.lastWorkTs; NOT the transcript file mtime,
        // which advances on every turn including pure chat and would cry STALE
        // by construction) is AFTER the newest HANDOVER*.md's mtime, the
        // written handover no longer reflects the session. lastWorkTs === 0
        // (no timestamps in the transcript) stays silent -- never claim
        // unprovable recency. Same "never a new block on its own" +
        // once-per-session cap discipline as thread 5.
        let newestHandoverMtime = 0;
        let entries = [];
        try {
          entries = fs.readdirSync(handoverDir);
        } catch (_) {
          entries = [];
        }
        for (const fname of entries) {
          if (!/^HANDOVER(?:-\d+)?\.md$/.test(fname)) continue;
          try {
            const st = fs.statSync(path.join(handoverDir, fname));
            if (st.mtimeMs > newestHandoverMtime) newestHandoverMtime = st.mtimeMs;
          } catch (_) {
            // skip unreadable entry
          }
        }
        if (newestHandoverMtime > 0) {
          const lastWorkTs = Number.isFinite(scan.lastWorkTs) ? scan.lastWorkTs : 0;
          // MTIME_GRACE_MS: some filesystems (observed on Linux CI runners)
          // round mtime to whole-second granularity, while lastWorkTs is
          // parsed from the transcript's ISO timestamp at full millisecond
          // precision. A handover written a few ms after the last counted
          // action can therefore report a TRUNCATED mtime numerically before
          // lastWorkTs, even though it was genuinely written later -- a
          // false-positive "stale" verdict caused by mtime resolution, not
          // real staleness. A 1s grace band absorbs that rounding artifact
          // while still catching real staleness (work resuming meaningfully
          // after the handover was written).
          const MTIME_GRACE_MS = 1000;
          if (lastWorkTs > 0 && lastWorkTs > newestHandoverMtime + MTIME_GRACE_MS) {
            const staleStateFile = path.join(stateDir, 'tasklist-guard-handover-stale-' + safeSession + '.json');
            let alreadyWarned = false;
            try {
              alreadyWarned = fs.existsSync(staleStateFile);
            } catch (_) {
              alreadyWarned = false;
            }
            if (!alreadyWarned) {
              finalReason = sanitizeReason(
                finalReason + ' Also: handover is STALE (work happened after it was ' +
                'written) — refresh it before the user compacts.'
              );
              try {
                fs.mkdirSync(stateDir, { recursive: true });
                fs.writeFileSync(staleStateFile, JSON.stringify({ warned: true }), 'utf8');
              } catch (_) {
                // best-effort cap
              }
            }
          }
        }
      }
    }
  } catch (_) {
    // fail-open: keep the original (un-augmented) reason on any error.
    finalReason = reason;
  }

  // RECONCILED: persist state FIRST, emit the block only if the write SUCCEEDED.
  // The earlier ordering emitted the block before persisting, reasoning that a
  // missed write costs "one extra nudge". That is WRONG when the state dir is
  // unwritable: every Stop re-derives the same (block-causing) signal, the
  // blocks-counter never accumulates (each write fails), so MAX_BLOCKS never
  // caps and the block recurs forever — an infinite Stop loop with no escape.
  // Without a working cap, blocking is unsafe, so we fail-OPEN: if the persist
  // throws/fails, exit 0 WITHOUT emitting a block. We only block when the cap
  // state was durably written (so the dedup + MAX_BLOCKS cap can actually fire).
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist the cap -> fail-open, do not block (no loop)
  }
  // Opportunistic bounded self-prune of OTHER stale tasklist-guard-state-* files
  // (one per session, never cleaned otherwise — see lib/state-prune.js).
  try {
    require('./lib/state-prune.js').pruneStale({
      stateDir, prefix: 'tasklist-guard-state', keepFile: stateFile,
    });
  } catch (_) {
  }

  if (sessionId) {
    try { finalReason = sanitizeReason(finalReason + ' ' + stopAck.ackHint('tasklist-guard', ackSignature, os.homedir(), sessionId)); }
    catch (_) { /* best-effort — the block still fires without the hint */ }
  }

  // fs.writeSync(1): stdout.write races the async pipe flush with exit() on
  // macOS node 18/20 (repo-wide hook-output rule; R2-N1).
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason: finalReason }) + '\n'); } catch (_) {}
  process.exit(0);
}

// normPriority — normalize a raw priority value to a trimmed string or null.
function normPriority(p) {
  if (p == null) return null;
  const s = String(p).trim();
  return s || null;
}

// isActionablePriority — true for P0/P1 and missing/unknown (fail-open).
// Only explicit P2/low/deferred is treated as non-nagging backlog.
function isActionablePriority(p) {
  if (p == null || p === '') return true;
  const s = String(p).trim().toLowerCase();
  return s !== 'p2' && s !== 'low' && s !== 'deferred';
}

function readThreshold() {
  try { return require('./lib/settings.js').get('guards', 'tasklistWorkThreshold', DEFAULT_WORK_THRESHOLD); }
  catch (_) { /* fall through */ }
  const v = parseInt(process.env.ANTIHALL_TASKLIST_WORK_THRESHOLD || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WORK_THRESHOLD;
}

function readFreshMs() {
  try { return require('./lib/settings.js').get('guards', 'progressFreshMs', DEFAULT_PROGRESS_FRESH_MS); }
  catch (_) { /* fall through */ }
  const v = parseInt(process.env.ANTIHALL_PROGRESS_FRESH_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PROGRESS_FRESH_MS;
}

function sanitizeSessionId(raw) {
  const safe = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || UNKNOWN_SESSION;
}

function maintainSessionIndex(cwd, date, sessionId, kind) {
  if (kind !== 'progress' && kind !== 'history') return;
  const indexPath = path.join(cwd, '.anti-hall', kind, 'INDEX.md');
  const line = '- ' + date + ' · ' + sessionId + ' · [' + kind + '](../' + date + '/' + sessionId + '.md)';
  appendIndexLineIfAbsent(indexPath, sessionId, line);
}

// sanitizeReason — single line, no control chars, bounded length so a task
// subject or path can't reshape the Stop reason or inject instruction-like lines.
// Cap raised 900 -> 2000 (P1 fix, coordinator safety-review of 1a88abc,
// 2026-09-25): the reason now names ABSOLUTE (root-joined) progress/history
// paths instead of short repo-relative ones, and the base message alone
// (two progress-path mentions + one history-path mention + the header) can
// approach 900 chars on its own with a realistically-nested repo path,
// leaving no room for the THREAD 5 / THREAD 7b advisory suffixes appended
// afterward -- they were silently sliced off. 2000 keeps a hard bound (still
// no unbounded growth from a task subject/path) while leaving real headroom.
function sanitizeReason(s) {
  if (typeof s !== 'string') return '';
  let out = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > 2000) out = out.slice(0, 2000).trimEnd() + '…';
  return out;
}

// Bounded tail read (mirrors task-guard): only the last windowBytes of a
// possibly multi-GB transcript, so the hook can never OOM/stall. Any error → null.
function readTranscriptTail(transcriptPath, windowBytes) {
  const WINDOW = windowBytes || 512 * 1024;
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= WINDOW) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const start = size - WINDOW;
    const buf = Buffer.alloc(WINDOW);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, WINDOW, start);
    return { data: buf.toString('utf8', 0, bytesRead), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// Single pass over the transcript tail. Computes:
//   - workCount         : file-mutating tool_uses (Edit/Write/MultiEdit/
//                         NotebookEdit + git-commit/write-verb Bash)
//   - sawTaskActivity   : any TaskCreate/TaskUpdate/TodoWrite tool_use present
//   - task state map    : reconstructed (mode-agnostic) to detect in_progress
// Mirrors task-guard's TaskCreate(result-id)/TaskUpdate(taskId)/TodoWrite logic.
//
// opts.progressAbsPath (FIX 6, root cause of #17): when given, also tracks
// lastProgressWriteTs — the newest transcript timestamp of an Edit/Write/
// MultiEdit/NotebookEdit whose file_path resolves to this exact path, OR a
// Bash command that both matches BASH_WORK_RE and names this exact path. This
// is a SECOND, independent freshness signal the caller ORs against the
// file's mtime, so a genuine same-session progress-file update is never
// missed by a stat-vs-write race or mtime-reading edge case.
function scanTranscript(filePath, opts) {
  const progressAbsPath = opts && typeof opts.progressAbsPath === 'string' ? opts.progressAbsPath : null;
  const tail = readTranscriptTail(filePath);
  if (!tail) {
    return { workCount: 0, sawTaskActivity: false, hasStaleInProgress: false, openTaskIds: [], lastWorkTs: 0, lastProgressWriteTs: 0 };
  }
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length > 0) lines.shift();

  let workCount = 0;
  let lastWorkTs = 0; // ms epoch of the NEWEST counted file-changing action (0 = unknown)
  let lastProgressWriteTs = 0; // ms epoch of the NEWEST write targeting progressAbsPath (0 = none seen)
  let sawTaskActivity = false;

  const provisionalMap = new Map(); // tool_use_id -> { content, status }
  const taskMap = new Map();        // id -> { id, content, status }
  const resultIdMap = new Map();    // tool_use_id -> "N"

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    // TaskCreate results carry the harness-assigned numeric id.
    if (entry.type === 'user') {
      const msg = entry.message;
      const content = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const resultText = typeof item.content === 'string' ? item.content : '';
          const m = resultText.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
          if (m) resultIdMap.set(item.tool_use_id, m[1]);
        }
      }
    }

    // Real transcript entries carry an ISO `timestamp`; parse once per entry so
    // counted work can be time-attributed (thread 7b staleness rail). Missing or
    // malformed timestamps leave lastWorkTs untouched (0 = unknown → the
    // staleness advisory stays silent rather than claim unprovable recency).
    const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;

    const toolUses = collectToolUses(entry);
    for (const tu of toolUses) {
      const name = tu.name || '';

      if (MUTATING_TOOLS.has(name)) {
        const fp = tu.input && typeof tu.input.file_path === 'string' ? tu.input.file_path : '';
        // isCountedWork (hooks/lib/work-detect.js) excludes the session's own
        // scratchpad (FIX 7) — the same rule handover-freshness.js applies.
        if (isCountedWork(tu)) {
          workCount++;
          if (Number.isFinite(entryTs) && entryTs > lastWorkTs) lastWorkTs = entryTs;
        }
        if (
          progressAbsPath && fp === progressAbsPath &&
          Number.isFinite(entryTs) && entryTs > lastProgressWriteTs
        ) {
          lastProgressWriteTs = entryTs;
        }
        continue;
      }

      if (name === 'Bash') {
        const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
        // FIX 7 scratchpad-only traffic is excluded inside isCountedWork.
        if (isCountedWork(tu)) {
          workCount++;
          if (Number.isFinite(entryTs) && entryTs > lastWorkTs) lastWorkTs = entryTs;
        }
        if (
          cmd && progressAbsPath && BASH_WORK_RE.test(neutralizeQuotedContents(cmd)) &&
          commandWritesToPath(cmd, progressAbsPath) &&
          Number.isFinite(entryTs) && entryTs > lastProgressWriteTs
        ) {
          lastProgressWriteTs = entryTs;
        }
        continue;
      }

      if (name === 'TodoWrite') {
        sawTaskActivity = true;
        const todos = tu.input && tu.input.todos;
        if (Array.isArray(todos)) {
          taskMap.clear();
          provisionalMap.clear();
          for (const todo of todos) {
            const id = todo.id || todo.content || String(taskMap.size);
            taskMap.set(String(id), {
              id: String(id),
              content: todo.content || todo.activeForm || String(id),
              status: todo.status || 'pending',
            });
          }
        }
        continue;
      }

      if (name === 'TaskCreate') {
        sawTaskActivity = true;
        const inp = tu.input || {};
        const toolUseId = tu.id || '';
        const content = inp.subject || inp.title || inp.content || inp.description || toolUseId;
        const status = inp.status || 'pending';
        const priority = normPriority(
          (inp.metadata != null && inp.metadata.priority != null)
            ? inp.metadata.priority : inp.priority
        );
        if (toolUseId) provisionalMap.set(toolUseId, { content, status, priority });
        continue;
      }

      if (name === 'TaskUpdate') {
        sawTaskActivity = true;
        const inp = tu.input || {};
        const id =
          inp.taskId != null ? String(inp.taskId)
          : inp.id != null ? String(inp.id)
          : inp.task_id != null ? String(inp.task_id)
          : null;
        if (id != null) {
          const existing = taskMap.get(id) || { id, content: id };
          const hasPriorityUpdate = inp.priority !== undefined ||
            (inp.metadata != null && inp.metadata.priority !== undefined);
          const updatedPriority = hasPriorityUpdate
            ? normPriority(
                (inp.metadata != null && inp.metadata.priority != null)
                  ? inp.metadata.priority : inp.priority
              )
            : (existing.priority || null);
          taskMap.set(id, {
            id: existing.id,
            content: existing.content,
            status: inp.status || existing.status || 'pending',
            priority: updatedPriority,
          });
        }
        continue;
      }
    }
  }

  // Flush provisional TaskCreate entries into the task map.
  for (const [toolUseId, rec] of provisionalMap) {
    const key = String(resultIdMap.get(toolUseId) || toolUseId);
    const existing = taskMap.get(key);
    if (!existing) {
      taskMap.set(key, { id: key, content: rec.content, status: rec.status, priority: rec.priority || null });
    } else if (!existing.content || existing.content === key) {
      taskMap.set(key, { id: key, content: rec.content, status: existing.status, priority: existing.priority || rec.priority || null });
    }
  }

  // FIX 2: a SINGLE in_progress task is the HEALTHY "one-in-progress" invariant
  // and must NOT trigger a block. Only MORE THAN ONE in_progress at once is a
  // smell (work fragmented / tasks left dangling). So count in_progress and set
  // the sub-cause only when the count exceeds one.
  //
  // PRIORITY FILTER: only P0/P1 (or missing) in_progress tasks count toward the
  // stale-multi check. A pile of P2/deferred in_progress tasks while a P0 is
  // actively worked is fine — don't nag about low-priority backlog being in_progress.
  let inProgressCount = 0; // only P0/P1 in_progress for stale-multi check
  const openTaskIds = [];
  for (const task of taskMap.values()) {
    const s = (task.status || '').toLowerCase();
    if (s === 'in_progress' || s === 'in-progress') {
      // All in_progress go into openTaskIds (for dedup hash), but only P0/P1
      // count toward the stale-multi threshold that triggers a block.
      openTaskIds.push(String(task.id));
      if (isActionablePriority(task.priority)) {
        inProgressCount++;
      }
    } else if (s === 'pending') {
      openTaskIds.push(String(task.id));
    }
  }
  // FIX 3 (parallel-orchestration false-positive): multiple in_progress tasks are
  // LEGITIMATE when background agents are running — anti-hall itself promotes parallel
  // fan-out (N live agents => N in_progress is correct, not a smell). Flagging it then
  // cripples the very parallelism the plugin encourages. So only treat >1 in_progress as
  // "stale" when NO live agent is running (mirror task-guard/task-tracker's agentsRunning
  // heartbeat check). When agents stop, a later Stop with no live agent still catches any
  // genuinely-dangling in_progress, so nothing is permanently masked.
  const hasStaleInProgress = inProgressCount > 1 && !agentsRunning();

  return { workCount, sawTaskActivity, hasStaleInProgress, inProgressCount, openTaskIds, lastWorkTs, lastProgressWriteTs };
}

// agentsRunning() — true if ~/.anti-hall/agents/ holds a FRESH heartbeat, meaning
// background subagents are live RIGHT NOW (so multiple in_progress tasks are legitimate
// parallel work, not a stall). Mirrors task-guard/task-tracker. Absent/unreadable dir or
// any error => false (fail-open toward "not running", which can only permit a nudge, never
// wrongly silence a genuinely-stalled session).
function agentsRunning(freshMs) {
  const FRESH = freshMs || 20 * 60 * 1000;
  const dir = path.join(os.homedir(), '.anti-hall', 'agents');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return false;
  }
  const now = Date.now();
  for (const f of files) {
    const full = path.join(dir, f);
    let ts = 0;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && typeof data.ts === 'number') ts = data.ts;
    } catch (_) { /* fall back to mtime */ }
    if (!ts) { try { ts = fs.statSync(full).mtimeMs; } catch (_) { ts = 0; } }
    if (ts && (now - ts) < FRESH) return true;
  }
  return false;
}

// checkResumeVerification({homeDir, sessionId, workCount, threshold}) ->
// reason string | null. See the call site's header comment for the full
// rationale. Never throws — every fs op is individually try/catch'd by the
// caller's wrapping try/catch, but this function additionally never lets a
// missing/unreadable marker or handover file read as "needs a nudge": only a
// CONCLUSIVELY read marker + CONCLUSIVELY read handover file lacking the
// marker text triggers the nudge.
function checkResumeVerification(opts) {
  const homeDir = opts && opts.homeDir;
  const sessionId = opts && opts.sessionId;
  const workCount = opts && opts.workCount;
  const threshold = opts && opts.threshold;
  if (!homeDir || !sessionId) return null;
  if (!(workCount >= threshold)) return null;

  const markerPath = path.join(homeDir, '.anti-hall', 'handover-resume-state-' + sessionId + '.json');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_) {
    return null; // no resume injection recorded this session -> nothing to check
  }
  const handoverFile = marker && typeof marker.handoverFile === 'string' ? marker.handoverFile : null;
  if (!handoverFile) return null;

  let content;
  try {
    content = fs.readFileSync(handoverFile, 'utf8');
  } catch (_) {
    return null; // can't confirm either way -> fail open
  }
  if (content.indexOf('resume-verified:') !== -1) return null; // already recorded

  // ONE capped nudge per session -- a single once-fired boolean marker, not
  // the churn-tolerant hash+counter used elsewhere in this file (there is
  // only one signal here: "did a resume-verified line ever get written").
  const firedPath = path.join(homeDir, '.anti-hall', 'resume-verify-nudged-' + sessionId + '.json');
  try {
    if (fs.existsSync(firedPath)) return null;
  } catch (_) {
    return null; // can't confirm cap state -> fail open
  }
  try {
    fs.mkdirSync(path.dirname(firedPath), { recursive: true });
    fs.writeFileSync(firedPath, JSON.stringify({ nudged: true, ts: Date.now() }), 'utf8');
  } catch (_) {
    return null; // can't persist the cap -> fail open (never block without a working cap)
  }

  return 'A session handover was resumed this session (' + handoverFile + ') but no `resume-verified:` ' +
    'marker was recorded in it. Run the resume-verification checklist (git status, pwd, smoke command) ' +
    'and append `resume-verified: <ISO timestamp> -- <summary>` to that file before continuing.';
}

// findPriorSessionStateFile(cwd, date, thisSessionId) -> relative path string
// (e.g. ".anti-hall/handovers/2026-08-08/<other-session>/state.md") of the
// NEWEST-by-mtime state.md written by a DIFFERENT session under today's
// handovers dir, or null if cwd is missing/unreadable, the handovers dir for
// today doesn't exist, or no OTHER session has a state.md. Never throws (any
// fs error propagates to the caller's try/catch, which fails open).
function findPriorSessionStateFile(cwd, date, thisSessionId) {
  if (!cwd || typeof cwd !== 'string') return null;
  const dayDir = path.join(cwd, '.anti-hall', 'handovers', date);
  let entries;
  try {
    entries = fs.readdirSync(dayDir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const ent of entries) {
    if (!ent.isDirectory || !ent.isDirectory()) continue;
    const otherSessionId = ent.name;
    if (otherSessionId === thisSessionId) continue;
    const statePath = path.join(dayDir, otherSessionId, 'state.md');
    let st;
    try {
      st = fs.lstatSync(statePath);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      best = path.join('.anti-hall', 'handovers', date, otherSessionId, 'state.md');
    }
  }
  return best;
}

try {
  main();
} catch (_) {
  process.exit(0);
}
