#!/usr/bin/env node
'use strict';
// anti-hall :: install-devswarm-ingest — installs the DevSwarm ingest daemon as a
// supervised background job. The daemon (devswarm-ingest.js) is the ONE native
// consumer that wraps `hivecontrol workspace monitor` and folds drained messages
// into the store; nothing auto-starts it, so this helper schedules it to run
// continuously (and re-exec on exit).
//
//   node install-devswarm-ingest.js              install (continuous daemon)
//   node install-devswarm-ingest.js --uninstall  remove
//   node install-devswarm-ingest.js --dry-run    print what it would do
//
// CONTINUOUS DAEMON (not a periodic sweep): unlike the supervisor, the ingest
// process's main() runs unbounded until killed. So the scheduler must RE-EXEC it
// on exit rather than run it on an interval:
//   macOS  -> LaunchAgent with KeepAlive (relaunch on exit), label
//             com.anti-hall.devswarm-ingest.
//   Linux  -> systemd --user .service, Type=simple, Restart=always; cron fallback
//             (every minute, restart-if-dead) when systemctl is absent.
//   Windows-> no pure-Node user-level long-running scheduler in built-ins
//             (no launchd/systemd/cron), documented no-op, exit 0. The daemon can
//             still be launched manually. (Note: unlike the supervisor's Windows
//             no-op, the reason here is NOT kill-safety — the ingest daemon never
//             kills anything — it is simply the absence of a built-in scheduler.)
//
// SCOPE = per-machine (per-home): the daemon's single-consumer lock lives at
// ~/.anti-hall/devswarm/locks/ingest.lock, keyed on $HOME, exactly matching the
// supervisor's per-machine scope. ONE unit per machine. A redundant install is
// SAFE — the daemon takes an O_EXCL lock and only one instance ever wins; extra
// launches refuse-and-exit (KeepAlive/cron then throttle-retries harmlessly).
//
// Idempotent refresh: reinstalling rewrites the unit and relaunches so the running
// daemon picks up this build's code (launchctl unload+load on macOS / systemd
// daemon-reload + restart on Linux).
//
// Distinct label + log from the supervisor. Agnostic: no hardcoded paths/users
// (os.homedir(), process.execPath, __dirname). Fail-open: an install failure is
// reported (exit 1) but never corrupts state; callers treat it as non-fatal.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// D27 (PLAN-v0.57-mesh.md): guarded, NOT a bare require — this module is
// itself required TOP-LEVEL by hooks (devswarm-parent-inbox.js/devswarm-
// parent-gate.js), whose fail-open guarantee only wraps their own main()
// call, not their top-level requires. A THROWING require here (a corrupt/
// deleted devswarm-repokey.js) would therefore crash those hooks before
// fail-open ever engages — exactly the class of bug D27 exists to prevent.
// `repokey` is null on failure; every call site below already fails open
// (returns null) when it is.
let repokey = null;
try { repokey = require('./lib/devswarm-repokey.js'); } catch (_) { repokey = null; }
const { devswarmRoot } = require('./lib/liveness.js');

const LABEL = 'com.anti-hall.devswarm-ingest';
const UNIT = 'anti-hall-devswarm-ingest';
const EXEC = process.execPath;
const HOME = os.homedir();

// resolveStableScript(env, home) -> absolute path | null. Prefers the git
// marketplace clone's OWN copy of devswarm-ingest.js — the exact path
// skills/update/scripts/update.js `git pull --ff-only`s IN PLACE (verified:
// update.js:396 gitPullFfOnly runs against paths.marketplaceDir), so it NEVER
// moves across an update. That is NOT true of a version-pinned cache dir (a NEW
// directory per release) or of this installer's OWN __dirname (wherever the
// plugin manager happened to resolve THIS install run's copy from — not
// guaranteed stable). A daemon baked from either of those goes stale the moment
// the plugin manager relocates/.bak's that directory out from under the
// already-running daemon's launchd/systemd/cron unit — the confirmed root cause
// of the ingest daemon crash-looping after a plugin update. ANTIHALL_MARKETPLACE_DIR
// is the SAME test-only override update.js honors, so both stable-path
// resolutions agree under test. Returns null (never throws) when the marketplace
// clone isn't present on this machine (e.g. running straight off a git checkout
// of the repo, not a marketplace install) — the caller then falls back to
// __dirname, preserving today's dev-mode behavior.
function resolveStableScript(env, home) {
  const e = env || {};
  let marketplaceDir = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall');
  const override = e.ANTIHALL_MARKETPLACE_DIR;
  if (override) {
    try { if (path.isAbsolute(override) && fs.statSync(override).isDirectory()) marketplaceDir = override; } catch (_) {}
  }
  const candidate = path.join(marketplaceDir, 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');
  try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  return null;
}

const SCRIPT = resolveStableScript(process.env, HOME) || path.join(__dirname, 'devswarm-ingest.js');
const LOG = path.join(HOME, '.anti-hall', 'devswarm-ingest.log');
const RESTART_SEC = 5; // gap before systemd relaunches the daemon after it exits

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const DRYRUN = args.includes('--dry-run');

function say(msg) { process.stdout.write(msg + '\n'); }

let _tmpCounter = 0;
// Atomic unit write: NEVER truncate a live plist/service in place. Write the new
// content to a unique same-directory temp file, then rename(2) over the target —
// atomic on POSIX, so an ENOSPC/interruption can never leave a partial/corrupt
// unit. On any error the temp file is unlinked and the original is left intact.
function planWrite(file, contents) {
  if (DRYRUN) { say(`[dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${_tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  say(`wrote ${file}`);
}
function planRm(file) {
  if (DRYRUN) { say(`[dry-run] would remove ${file}`); return; }
  try { fs.unlinkSync(file); say(`removed ${file}`); } catch (_e) { say(`(not present) ${file}`); }
}
function planRun(cmd, argv, opts) {
  if (DRYRUN) { say(`[dry-run] would run: ${cmd} ${argv.join(' ')}`); return { status: 0, dry: true }; }
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...(opts || {}) });
  if (r.error) say(`(warn) ${cmd} failed: ${r.error.message}`);
  else say(`ran: ${cmd} ${argv.join(' ')} (exit ${r.status})`);
  return r;
}

// XML-escape for plist <string> bodies. Order matters: & first, then < > " '.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// POSIX shell single-quote (for the cron/shell line): wrap in '...' and rewrite
// each embedded ' as '\'' — everything else inside single quotes is literal, so a
// path with spaces/&/</>/;/#/$/backticks/quotes can NEVER break out of the token.
function shSingleQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// systemd Exec quoting (for ExecStart): systemd does NOT run a shell for Exec, but
// it DOES do its own tokenizing plus $VAR / ${VAR} expansion. Double-quote and
// escape \  "  and $ per systemd.service(5) ($$ = a literal $), so a path with
// quotes/backslashes/dollars cannot break the token or trigger variable expansion.
function sdQuote(s) {
  return `"` + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$') + `"`;
}

// Belt-and-suspenders on top of per-target escaping: refuse to emit a unit for a
// resolved node/script path that carries control characters or quote characters.
// Returns false for such a path so the installer can fail-open (log + skip).
function pathIsEmittable(p) {
  return !/[\u0000-\u001f\u007f"']/.test(String(p));
}

// Resolve the git worktree the daemon must be launched FROM. `hivecontrol
// workspace <cmd>` resolves its workspace by walking up from the process's cwd to
// an enclosing git worktree (NOT from DEVSWARM_* env). launchd/systemd/cron default
// a unit's cwd to $HOME, which is not a git repo — so a daemon with no baked cwd can
// never resolve a workspace and drains nothing. We resolve the install-time worktree
// here and bake it into the unit's working directory. Returns the absolute toplevel
// path, or null when `cwd` is not inside a git worktree (installer then fails open).
function resolveWorktree(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    const top = String(r.stdout || '').trim();
    return top || null;
  } catch (_) {
    return null;
  }
}

// ----- per-worktree identity (multi-repo, additive installs) -----
// worktreeHash(wt) — an 8-hex fingerprint of the worktree's REAL (symlink-resolved)
// path. The daemon (devswarm-ingest.js) MUST compute the identical hash from its
// resolved worktree so their per-worktree lock/label/unit paths agree, so both sides
// canonicalize via realpathSync first. Fail-open: if realpath can't stat the path
// (e.g. it doesn't exist yet), fall back to path.resolve so a hash is still produced.
function worktreeHash(wt) {
  let p = String(wt || '');
  try { p = fs.realpathSync(p); } catch (_) { p = path.resolve(p); }
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 8);
}
// PER-WORKTREE unit identity. Base LABEL/UNIT are kept as the shared PREFIX so a
// second repo's install creates a NEW unit (different hash), never overwriting the
// first repo's. The base (hash-less) name is the LEGACY single-unit form still read
// back for backward compat.
function labelForWorktree(wt) { return `${LABEL}.${worktreeHash(wt)}`; }
function unitForWorktree(wt) { return `${UNIT}-${worktreeHash(wt)}`; }
function cronMarkerForWorktree(wt) { return `# ${unitForWorktree(wt)}`; }
// primaryWorkspaceId(wt) — the store partition key for a worktree's Primary/parent
// reception queue. Derived per-worktree (never the old hardcoded 'primary', which
// collided rows across repos, #15). Always isSafeId-valid ([a-z0-9-]).
function primaryWorkspaceId(wt) { return `primary-${worktreeHash(wt)}`; }

// ----- PER-PROJECT identity (v0.57 mesh, PLAN-v0.57-mesh.md D1/D9/Phase5) -----
// labelForProject/unitForProject/cronMarkerForProject — the ONE-per-project
// scheduler identity, keyed by `repoKey` (companion/lib/devswarm-repokey.js),
// NOT the per-worktree hash. `labelForWorktree`/`unitForWorktree`/
// `cronMarkerForWorktree` (above) are KEPT — they remain the read-side identity
// used to enumerate + reap this repo's LEGACY per-worktree units (D9
// reap-before-drain); they are never removed. A repoKey always contains an
// internal `-` (name + 6-hex suffix); a legacy 8-hex hash never does — the two
// shapes are disjoint by construction (D28), so parsing back never confuses one
// for the other (see listInstalledIngestUnits below).
function labelForProject(repoKey) { return `${LABEL}.${repoKey}`; }
function unitForProject(repoKey) { return `${UNIT}-${repoKey}`; }
function cronMarkerForProject(repoKey) { return `# ${unitForProject(repoKey)}`; }

// resolveMainWorktree(cwd, io) -> the absolute path of the repo's MAIN worktree
// (dirname of `--git-common-dir`), or null (fail-open — non-git cwd, no git
// binary, unresolvable path). The per-project daemon ALWAYS bakes THIS as its
// WorkingDirectory — NEVER a linked/child worktree (a child worktree can be
// removed mid-project; baking it would kill the whole project's ingest the
// moment its cwd vanishes). `io.run`/`io.fs` are injectable so this is testable
// without spawning a real `git` (mirrors devswarm-repokey.js's own posture).
function resolveMainWorktree(cwd, io) {
  if (!repokey) return null; // D27 fail-open: corrupt/missing repokey module
  const cd = repokey.gitCommonDir(cwd, { io });
  if (!cd) return null;
  return path.dirname(cd);
}

// defaultGitRun(spec) -> { ok, raw }. ONE injectable `git` spawn for worktree
// enumeration (mirrors devswarm-repokey.js's own defaultRun / devswarm-pull.js's
// defaultRun pattern) so tests can simulate `git worktree list --porcelain`
// output without spawning a real binary.
function defaultGitRun(spec) {
  const o = spec || {};
  try {
    const r = spawnSync('git', Array.isArray(o.args) ? o.args : [], { encoding: 'utf8', cwd: o.cwd });
    if (r.error || r.status !== 0) return { ok: false, raw: '' };
    return { ok: true, raw: String(r.stdout || '') };
  } catch (_) {
    return { ok: false, raw: '' };
  }
}

// parseWorktreeListPorcelain(raw) -> string[] absolute worktree paths. Parses
// `git worktree list --porcelain` output (one or more blocks, each starting with
// a `worktree <path>` line) — the ONLY correct way to enumerate a project's
// linked worktrees; `worktreeHash` is a ONE-WAY sha256 and cannot be inverted, so
// there is no way to recover "which worktrees belong to this repo" from a hash
// alone (Gap-2, D9/Phase5 step 1).
function parseWorktreeListPorcelain(raw) {
  const out = [];
  const lines = String(raw || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^worktree (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// listRepoWorktrees(mainWorktree, {io}) -> string[] absolute worktree paths — the
// MAIN worktree plus every LINKED worktree of this repo, via `git worktree list
// --porcelain` run FROM the main worktree. Fail-open [] on any spawn failure (the
// reap step then simply has nothing to enumerate — never throws).
function listRepoWorktrees(mainWorktree, opts) {
  const o = opts || {};
  const run = (o.io && o.io.run) || defaultGitRun;
  if (!mainWorktree) return [];
  const r = run({ args: ['-C', mainWorktree, 'worktree', 'list', '--porcelain'], cwd: mainWorktree });
  if (!r || !r.ok) return [];
  return parseWorktreeListPorcelain(r.raw);
}

// reapPlanForRepo(mainWorktree, opts) -> [{worktree, hash, label, unit, marker}].
// PURE (no side effects) — the list of THIS repo's legacy per-worktree units,
// derived by enumerating `git worktree list --porcelain` (NEVER by inverting the
// one-way worktreeHash — impossible). Safe to call from tests without touching
// any real scheduler.
function reapPlanForRepo(mainWorktree, opts) {
  return listRepoWorktrees(mainWorktree, opts).map((wt) => ({
    worktree: wt,
    hash: worktreeHash(wt),
    label: labelForWorktree(wt),
    unit: unitForWorktree(wt),
    marker: cronMarkerForWorktree(wt),
  }));
}

// defaultSchedRunViaPlan(spec) -> { status, stdout, error }. The PRODUCTION
// default scheduler spawn ({cmd, args, input}) for reapLegacyUnitsForRepo —
// routes through the module's OWN planRun (which already checks the
// module-load-time DRYRUN flag) so `main() --dry-run` NEVER issues a real
// launchctl/systemctl/crontab mutation, exactly like every other install/
// uninstall path in this file. Tests NEVER hit this — they always inject
// opts.io.schedRun, so this default is only ever exercised by a real `main()`.
function defaultSchedRunViaPlan(spec) {
  const o = spec || {};
  const r = planRun(o.cmd, o.args || [], o.input !== undefined ? { input: o.input, encoding: 'utf8' } : undefined);
  return { status: (r && r.status != null) ? r.status : null, stdout: (r && r.stdout) || '', error: (r && r.error) || null };
}
// defaultSchedRm(p) — the PRODUCTION default unit-file removal for
// reapLegacyUnitsForRepo, routed through the module's OWN planRm (DRYRUN-aware,
// logs "[dry-run] would remove ..." instead of unlinking under --dry-run).
function defaultSchedRm(p) { planRm(p); }

// SAFETY (folds the build note "never run the real reap on this machine"):
// git-worktree ENUMERATION (opts.io.run, consumed by listRepoWorktrees/
// reapPlanForRepo above) is a distinct, non-destructive concern from the
// STOPPING side below (opts.io.schedRun / opts.io.schedFs — deliberately a
// DIFFERENT key so a test mocking one can never accidentally leak into the
// other). Tests ALWAYS pass their own opts.io.schedRun/schedFs (pure mocks,
// zero real spawns/unlinks). Production (main(), never under test) omits
// opts.io.schedRun/schedFs and gets defaultSchedRunViaPlan/defaultSchedRm,
// which route through this module's OWN DRYRUN-checking planRun/planRm — so
// even a real invocation only ACTUALLY unloads/removes a unit when NOT run
// with --dry-run, exactly like every other install/uninstall path here.
//
// Also unlinks the entry's LEGACY per-worktree ingest LOCK file (locks/ingest-
// <hash>.lock) — without this, a reaped-but-not-yet-restarted legacy daemon's
// now-dead pid is left on disk indefinitely, and devswarm-ingest.js's
// probeLegacyHolders would misread it as a live holder for as long as that dead
// pid happens to be reused by any later process (an unbounded, if low-
// probability, wedge on this project's ingest). Removing it here — right where
// the legacy unit is actually stopped — closes that gap for the normal
// reap-before-drain path; it is the SAME best-effort file-removal `rm` already
// used for the unit's plist/service file, so it participates in the identical
// DRYRUN-aware / fully-mocked-under-test semantics.
//
// stopLegacyUnitEntry(entry, opts) -> void. Platform-specific STOP (scheduler-based,
// NEVER kill(2)) for ONE legacy per-worktree ingest unit entry
// {label, unit, hash, marker?, worktree?}. Extracted so BOTH reap paths reap a
// unit IDENTICALLY: reapLegacyUnitsForRepo below (the LIVE handoff, git-worktree
// enumeration, D9) and doctor-repair.js's belt-and-suspenders orphan sweep
// (Phase 6, readback enumeration via listInstalledIngestUnits — it has no
// `mainWorktree` to enumerate FROM, only the already-discovered unit itself).
// `entry.marker` is used when present (reapPlanForRepo always sets it); otherwise
// it is derived from `entry.unit` (`# ${entry.unit}`, matching
// cronMarkerForWorktree's own `# ${unitForWorktree(wt)}` shape) — the shape
// listInstalledIngestUnits' readback always produces for a Linux-sourced entry.
// Fail-open per call: the caller wraps this in try/catch (one bad entry must
// never block reaping the rest).
function stopLegacyUnitEntry(entry, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const run = (o.io && o.io.schedRun) || defaultSchedRunViaPlan;
  const rm = (o.io && o.io.schedFs) || defaultSchedRm;
  const marker = entry.marker || (entry.unit ? `# ${entry.unit}` : null);
  if (platform === 'darwin') {
    const plist = macPlistPath(entry.label);
    run({ cmd: 'launchctl', args: ['unload', plist] }); // ignore err — best-effort
    rm(plist);
  } else if (platform === 'linux') {
    // Attempt BOTH mechanisms — each is a harmless no-op when not applicable
    // (systemctl absent -> failed spawn, ignored; no matching cron marker ->
    // removeCronEntry reports changed:false). This self-heals reaping without
    // needing to first detect which scheduler installed the legacy unit.
    if (entry.unit) {
      run({ cmd: 'systemctl', args: ['--user', 'disable', '--now', `${entry.unit}.service`] });
      rm(path.join(unitDir(), `${entry.unit}.service`));
    }
    if (marker) {
      const crRead = run({ cmd: 'crontab', args: ['-l'] });
      const curCron = (crRead && !crRead.error) ? crRead.stdout : '';
      const { next, changed } = removeCronEntry(curCron, marker);
      if (changed) run({ cmd: 'crontab', args: ['-'], input: next });
    }
  }
  if (entry.hash) rm(path.join(devswarmRoot(o.home), 'locks', 'ingest-' + entry.hash + '.lock'));
}

// reapLegacyUnitsForRepo(mainWorktree, opts) -> { plan, stopped } — D9
// REAP-BEFORE-DRAIN: stops+unloads EVERY legacy per-worktree unit belonging to
// this repo (reapPlanForRepo) via stopLegacyUnitEntry (scheduler-based, never
// kill(2)). Fail-open per-worktree: one unit that errors while stopping never
// blocks reaping the rest (matches macInstall's existing "// ignore err" posture
// on `launchctl unload`).
function reapLegacyUnitsForRepo(mainWorktree, opts) {
  const o = opts || {};
  const plan = reapPlanForRepo(mainWorktree, o);
  const stopped = [];
  for (const entry of plan) {
    try {
      stopLegacyUnitEntry(entry, o);
      stopped.push(entry);
    } catch (_) { /* fail-open: one bad worktree must never block reaping the rest */ }
  }
  return { plan, stopped };
}

// macInstallProject(mainWorktree, repoKey) — install the PER-PROJECT LaunchAgent,
// keyed by repoKey (not worktreeHash), baking `mainWorktree` as
// WorkingDirectory. Mirrors macInstall's write/unload/load sequence exactly.
function macInstallProject(mainWorktree, repoKey) {
  const label = labelForProject(repoKey);
  const plist = macPlistPath(label);
  planWrite(plist, buildPlist({ label, workdir: mainWorktree }));
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${label} (continuous, KeepAlive; project ${repoKey}, worktree ${mainWorktree}). Logs: ${LOG}`);
}
function macUninstallProject(repoKey) {
  const label = labelForProject(repoKey);
  const plist = macPlistPath(label);
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${label}`);
}

// linuxInstallProject(mainWorktree, repoKey) — install the PER-PROJECT systemd
// --user service (or cron fallback), keyed by repoKey, baking `mainWorktree` as
// WorkingDirectory. Mirrors linuxInstall's sequence exactly.
function linuxInstallProject(mainWorktree, repoKey) {
  const dir = unitDir();
  const unit = unitForProject(repoKey);
  const marker = cronMarkerForProject(repoKey);
  planWrite(path.join(dir, `${unit}.service`), buildService({ workdir: mainWorktree }));
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${unit}.service && systemctl --user restart ${unit}.service`);
    say(`[dry-run] if systemctl absent, would install this managed cron fallback (marker ${marker}; every minute, restart-if-dead):`);
    say(`  ${marker}`);
    say(`  ${buildCronLine({ workdir: mainWorktree })}`);
    return;
  }
  if (!hasSystemctl()) {
    say('systemctl not available; installing a managed cron fallback (every minute, restart-if-dead).');
    installCron(mainWorktree, marker);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${unit}.service`]);
  planRun('systemctl', ['--user', 'restart', `${unit}.service`]);
  say(`installed systemd --user service ${unit}.service (continuous, Restart=always; project ${repoKey}, worktree ${mainWorktree}). Logs: ${LOG}`);
}
function linuxUninstallProject(repoKey) {
  const dir = unitDir();
  const unit = unitForProject(repoKey);
  const marker = cronMarkerForProject(repoKey);
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user disable --now ${unit}.service (if present) and remove any managed cron fallback (marker ${marker})`);
  } else {
    // Always attempt BOTH removal paths (each a self-healing no-op when not
    // applicable), instead of gating cron-removal behind hasSystemctl() as the
    // old `if (!hasSystemctl()) uninstallCron() else systemctl-disable` did. A
    // project installed while systemctl was ABSENT falls back to a managed cron
    // entry (linuxInstallProject); if systemctl later becomes available (e.g.
    // installed on this host after the fact), the old either/or would only ever
    // run the systemctl branch on uninstall and never touch that leftover cron
    // entry — leaving it silently restarting the daemon every minute forever.
    // `systemctl disable --now` on a unit that was never enabled is a harmless
    // no-op error (ignored, matching this file's existing posture elsewhere);
    // uninstallCron() itself no-ops when its marker isn't present.
    uninstallCron(null, marker);
    if (hasSystemctl()) planRun('systemctl', ['--user', 'disable', '--now', `${unit}.service`]);
  }
  planRm(path.join(dir, `${unit}.service`));
  if (!DRYRUN && hasSystemctl()) planRun('systemctl', ['--user', 'daemon-reload']);
  say(`uninstalled ${unit}`);
}

// ----- macOS -----
// macPlistPath(label) — the LaunchAgent path for a given label (default = the base
// LABEL, i.e. the legacy single-unit path). Per-worktree installs pass
// labelForWorktree(workdir).
function macPlistPath(label) { return path.join(HOME, 'Library', 'LaunchAgents', `${label || LABEL}.plist`); }

// KeepAlive (not StartInterval): the ingest daemon runs continuously, so launchd
// must relaunch it whenever it exits — the "re-exec on exit" contract the daemon
// expects. RunAtLoad starts it at load/login.
function buildPlist({ label = LABEL, exec = EXEC, script = SCRIPT, log = LOG, workdir } = {}) {
  // WorkingDirectory: launchd otherwise defaults the daemon's cwd to $HOME (not a
  // git repo) and `hivecontrol workspace monitor` fails "Not in a git repository",
  // draining nothing. Baking the install-time worktree lets the daemon resolve it.
  const workdirKey = workdir
    ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(workdir)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exec)}</string>
    <string>${xmlEscape(script)}</string>
  </array>
${workdirKey}  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function macInstall(workdir) {
  const label = labelForWorktree(workdir); // ADDITIVE: this repo's own unit, never overwrites another repo's
  const plist = macPlistPath(label);
  planWrite(plist, buildPlist({ label, workdir }));
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${label} (continuous, KeepAlive; worktree ${workdir}). Logs: ${LOG}`);
}
function macUninstall(workdir) {
  // Uninstall targets THIS worktree's unit when cwd resolves to one; otherwise the
  // legacy base-LABEL unit (so a pre-per-worktree install can still be torn down).
  const label = workdir ? labelForWorktree(workdir) : LABEL;
  const plist = macPlistPath(label);
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${label}`);
}

// ----- Linux -----
function unitDir() { return path.join(HOME, '.config', 'systemd', 'user'); }

// Type=simple + Restart=always: a long-running daemon that systemd relaunches on
// exit (the daemon's re-exec-on-exit contract). No .timer — this is a continuous
// service, not a periodic sweep.
function buildService({ exec = EXEC, script = SCRIPT, restartSec = RESTART_SEC, workdir, log = LOG } = {}) {
  // WorkingDirectory: systemd otherwise defaults the daemon's cwd to $HOME (not a
  // git repo), so `hivecontrol workspace monitor` can never resolve a workspace.
  // systemd-escaped like ExecStart (systemd tokenizes + does $VAR expansion).
  const workdirLine = workdir ? `WorkingDirectory=${sdQuote(workdir)}\n` : '';
  // StandardOutput/StandardError: without these, a startup failure (bad
  // WorkingDirectory, missing script) exits silently — nothing is captured
  // anywhere. Append (not truncate) into the SAME stable log the macOS plist's
  // StandardOutPath/StandardErrorPath already use, so both platforms are
  // diagnosable from one file.
  return `[Unit]
Description=anti-hall DevSwarm ingest daemon (native monitor -> store)

[Service]
Type=simple
${workdirLine}ExecStart=${sdQuote(exec)} ${sdQuote(script)}
Restart=always
RestartSec=${restartSec}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}
function hasSystemctl() {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
// cron fallback: every minute, restart-if-dead. A live daemon holds the ingest
// lock, so a duplicate launch refuses-and-exits immediately (single-consumer);
// when the daemon is dead, the next tick takes over. Each path is POSIX
// single-quoted so no path can inject shell (P0-2).
function buildCronLine({ exec = EXEC, script = SCRIPT, workdir, log = LOG } = {}) {
  // cd into the install-time worktree first: cron runs from $HOME (not a git repo),
  // so without this the daemon can never resolve a workspace. The worktree path is
  // POSIX single-quoted like exec/script (no injection hole reintroduced).
  const cd = workdir ? `cd ${shSingleQuote(workdir)} && ` : '';
  // Append (not discard) into the SAME stable log the plist/service use — a
  // startup failure on the cron fallback path used to vanish into /dev/null.
  return `* * * * * ${cd}${shSingleQuote(exec)} ${shSingleQuote(script)} >> ${shSingleQuote(log)} 2>&1`;
}

// The managed cron marker comment. It is BOTH the idempotence key (a second install
// finds it and leaves the crontab untouched) AND the real "scheduled" signal that
// capability-scan reads on Linux — a bare .service file is NOT proof of scheduling
// (P1-2). Equal to `# <UNIT>` so capability-scan can derive it from the installer.
const CRON_MARKER = `# ${UNIT}`;

// buildCronEntry -> the managed 2-line block written to the crontab: the marker
// comment followed by the (escaped) restart-if-dead line. `marker` defaults to the
// base CRON_MARKER (legacy single-unit); a per-worktree install passes
// cronMarkerForWorktree(workdir) so each repo gets its own managed entry.
function buildCronEntry({ exec = EXEC, script = SCRIPT, workdir, marker = CRON_MARKER } = {}) {
  return `${marker}\n${buildCronLine({ exec, script, workdir })}`;
}

// mergeCrontab(current, entry, marker) -> { next, changed }. Idempotent: if the
// managed marker line is already present, the crontab is returned unchanged;
// otherwise the managed entry is appended, preserving all existing entries.
function mergeCrontab(current, entry, marker) {
  const cur = typeof current === 'string' ? current : '';
  if (cur.split('\n').some((l) => l.trim() === marker)) return { next: cur, changed: false };
  const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
  return { next: cur + sep + entry + '\n', changed: true };
}

// removeCronEntry(current, marker) -> { next, changed }. Strips the managed marker
// line AND the command line immediately after it (the pair this installer wrote).
function removeCronEntry(current, marker) {
  const cur = typeof current === 'string' ? current : '';
  const lines = cur.split('\n');
  const out = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) {
      changed = true;
      if (i + 1 < lines.length) i++; // also drop the command line following the marker
      continue;
    }
    out.push(lines[i]);
  }
  return { next: out.join('\n'), changed };
}

// readCrontab() -> current crontab text ('' if none/unreadable). Fail-open.
function readCrontab() {
  try {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (!r.error && typeof r.stdout === 'string') return r.stdout;
  } catch (_) { /* no crontab / not installed -> empty */ }
  return '';
}

// installCron(): idempotently add the managed cron fallback entry to the user's
// crontab so the ingest daemon is ACTUALLY scheduled when systemctl is absent
// (previously the installer only PRINTED the line and installed no scheduler —
// yet capability-scan reported active; P1-2). `markerOverride` (v0.57 mesh) lets
// the PER-PROJECT install path (linuxInstallProject) pass its own repoKey-keyed
// marker instead of the per-worktree default.
function installCron(workdir, markerOverride) {
  const marker = markerOverride || cronMarkerForWorktree(workdir);
  const { next, changed } = mergeCrontab(readCrontab(), buildCronEntry({ workdir, marker }), marker);
  if (!changed) { say(`cron entry already present (marker ${marker}); crontab left as-is`); return; }
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    say('(warn) could not install cron entry via `crontab -`; add it manually (crontab -e):');
    say(`  ${marker}`);
    say(`  ${buildCronLine({ workdir })}`);
    return;
  }
  say(`installed cron fallback (managed marker ${marker}, every minute restart-if-dead). Logs: ${LOG}`);
}

// uninstallCron(): remove the managed cron fallback entry (marker + its line) for
// this worktree (or the legacy base marker when cwd doesn't resolve to a
// worktree). `markerOverride` (v0.57 mesh) lets the PER-PROJECT uninstall path
// pass its own repoKey-keyed marker instead of deriving one from `workdir`.
function uninstallCron(workdir, markerOverride) {
  const marker = markerOverride || (workdir ? cronMarkerForWorktree(workdir) : CRON_MARKER);
  const { next, changed } = removeCronEntry(readCrontab(), marker);
  if (!changed) return;
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (!r.error && r.status === 0) say(`removed cron fallback (managed marker ${marker})`);
}

function linuxInstall(workdir) {
  const dir = unitDir();
  const unit = unitForWorktree(workdir); // ADDITIVE: this repo's own unit
  const marker = cronMarkerForWorktree(workdir);
  planWrite(path.join(dir, `${unit}.service`), buildService({ workdir }));
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${unit}.service && systemctl --user restart ${unit}.service`);
    say(`[dry-run] if systemctl absent, would install this managed cron fallback (marker ${marker}; every minute, restart-if-dead; the daemon's single-consumer lock makes redundant launches a no-op):`);
    say(`  ${marker}`);
    say(`  ${buildCronLine({ workdir })}`);
    return;
  }
  if (!hasSystemctl()) {
    say('systemctl not available; installing a managed cron fallback (every minute, restart-if-dead).');
    installCron(workdir);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${unit}.service`]);
  planRun('systemctl', ['--user', 'restart', `${unit}.service`]); // refresh a running daemon to this build's code
  say(`installed systemd --user service ${unit}.service (continuous, Restart=always; worktree ${workdir}). Logs: ${LOG}`);
}
function linuxUninstall(workdir) {
  const dir = unitDir();
  const unit = workdir ? unitForWorktree(workdir) : UNIT;
  if (!DRYRUN && !hasSystemctl()) {
    say('systemctl not available; removing the managed cron fallback if present.');
    uninstallCron(workdir);
  } else {
    planRun('systemctl', ['--user', 'disable', '--now', `${unit}.service`]);
  }
  planRm(path.join(dir, `${unit}.service`));
  if (!DRYRUN && hasSystemctl()) planRun('systemctl', ['--user', 'daemon-reload']);
  say(`uninstalled ${unit}`);
}

// ----- readback: enumerate INSTALLED ingest units (multi-repo) -----
// These are the canonical reverse of the buildPlist/buildService/buildCronLine
// escaping — kept HERE (next to the builders) so a change to the emit side updates
// the read side in one place. doctor-repair.js's per-worktree healing delegates to
// listInstalledIngestUnits rather than re-deriving any of this.
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function unSdQuote(s) {
  let v = String(s).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.replace(/\$\$/g, '$').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
function firstShToken(s) {
  const m = String(s).match(/'((?:[^'\\]|\\.)*)'/);
  return m ? m[1].replace(/'\\''/g, "'") : null;
}
function parsePlistUnit(xml) {
  const out = { workingDir: null, scriptPath: null };
  const wd = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/);
  if (wd) out.workingDir = unescapeXml(wd[1]);
  const arr = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (arr) {
    const strs = arr[1].match(/<string>([\s\S]*?)<\/string>/g) || [];
    if (strs.length >= 2) {
      const m = strs[1].match(/<string>([\s\S]*?)<\/string>/);
      if (m) out.scriptPath = unescapeXml(m[1]);
    }
  }
  return out;
}
function parseServiceUnit(svc) {
  const out = { workingDir: null, scriptPath: null };
  const wd = svc.match(/^WorkingDirectory=(.*)$/m);
  if (wd) out.workingDir = unSdQuote(wd[1]);
  const ex = svc.match(/^ExecStart=(.*)$/m);
  if (ex) {
    const toks = ex[1].match(/"((?:[^"\\]|\\.)*)"/g) || [];
    if (toks.length >= 2) out.scriptPath = unSdQuote(toks[1]);
  }
  return out;
}
function parseCronCommand(cmd) {
  const out = { workingDir: null, scriptPath: null };
  const cd = cmd.match(/cd\s+('((?:[^'\\]|\\.)*)')\s*&&/);
  if (cd) out.workingDir = cd[2].replace(/'\\''/g, "'");
  const afterCd = cd ? cmd.slice(cmd.indexOf('&&') + 2) : cmd;
  const toks = afterCd.match(/'((?:[^'\\]|\\.)*)'/g) || [];
  if (toks.length >= 2) out.scriptPath = firstShToken(toks[1]);
  return out;
}

// DISJOINT unit-suffix shapes (D28): a legacy per-worktree hash is EXACTLY 8 hex
// chars with no internal dash; a repoKey ALWAYS carries an internal `-` (name +
// 6-hex suffix). The two regexes can therefore never both match the same suffix
// — a repoKey unit is never mis-parsed/mis-reaped as a legacy one, and vice versa.
const LEGACY_UNIT_HASH_RE = /^([0-9a-fA-F]{8})$/;
const PROJECT_UNIT_KEY_RE = /^([a-z0-9-]{1,40}-[0-9a-f]{6})$/;

// listInstalledIngestUnits({home, platform}) -> Array<{label, unit, hash, repoKey,
// workingDir, scriptPath, source}>. The multi-unit successor to doctor-repair's
// single-unit readback: scans EVERY installed ingest unit — legacy base-name,
// legacy PER-WORKTREE hash-suffixed, AND (v0.57 mesh) PER-PROJECT repoKey-suffixed
// — and reads back each unit's baked WorkingDirectory + script. `hash` is set for
// a legacy per-worktree unit (null otherwise); `repoKey` is set for a per-project
// unit (null otherwise) — the two are mutually exclusive by construction (the
// disjoint regexes above). Fail-open: any unreadable dir/crontab/unit yields the
// units it COULD read (never throws).
function listInstalledIngestUnits(opts) {
  const o = opts || {};
  const home = o.home || HOME;
  const platform = o.platform || process.platform;
  const units = [];
  try {
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { names = []; }
      for (const name of names) {
        if (!name.startsWith(LABEL) || !name.endsWith('.plist')) continue;
        const rest = name.slice(LABEL.length, name.length - '.plist'.length); // '' (legacy) | '.<hash>' | '.<repoKey>'
        let hash = null;
        let repoKeyOut = null;
        if (rest !== '') {
          const suffix = rest.slice(1); // drop the leading '.'
          if (LEGACY_UNIT_HASH_RE.test(suffix)) hash = suffix;
          else if (PROJECT_UNIT_KEY_RE.test(suffix)) repoKeyOut = suffix;
          else continue;
        }
        let xml;
        try { xml = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) { continue; }
        const parsed = parsePlistUnit(xml);
        units.push({
          label: name.slice(0, -('.plist'.length)), unit: null, hash, repoKey: repoKeyOut,
          workingDir: parsed.workingDir, scriptPath: parsed.scriptPath, source: 'launchd',
        });
      }
      return units;
    }
    if (platform === 'linux') {
      const dir = path.join(home, '.config', 'systemd', 'user');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { names = []; }
      for (const name of names) {
        if (!name.startsWith(UNIT) || !name.endsWith('.service')) continue;
        const rest = name.slice(UNIT.length, name.length - '.service'.length); // '' (legacy) | '-<hash>' | '-<repoKey>'
        let hash = null;
        let repoKeyOut = null;
        if (rest !== '') {
          const suffix = rest.slice(1); // drop the leading '-'
          if (LEGACY_UNIT_HASH_RE.test(suffix)) hash = suffix;
          else if (PROJECT_UNIT_KEY_RE.test(suffix)) repoKeyOut = suffix;
          else continue;
        }
        let svc;
        try { svc = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) { continue; }
        const parsed = parseServiceUnit(svc);
        units.push({
          label: null, unit: name.slice(0, -('.service'.length)), hash, repoKey: repoKeyOut,
          workingDir: parsed.workingDir, scriptPath: parsed.scriptPath, source: 'systemd',
        });
      }
      // cron fallback: scan the crontab for managed markers (legacy `# UNIT`,
      // legacy per-worktree `# UNIT-<hash>`, AND per-project `# UNIT-<repoKey>`),
      // parsing the command line following each.
      let crontab = '';
      try {
        const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
        if (!r.error && typeof r.stdout === 'string') crontab = r.stdout;
      } catch (_) { crontab = ''; }
      const clines = crontab.split('\n');
      for (let i = 0; i < clines.length; i++) {
        const t = clines[i].trim();
        if (!t.startsWith(`# ${UNIT}`)) continue;
        const rest = t.slice(`# ${UNIT}`.length); // '' (legacy) | '-<hash>' | '-<repoKey>'
        let hash = null;
        let repoKeyOut = null;
        if (rest !== '') {
          const suffix = rest.slice(1); // drop the leading '-'
          if (LEGACY_UNIT_HASH_RE.test(suffix)) hash = suffix;
          else if (PROJECT_UNIT_KEY_RE.test(suffix)) repoKeyOut = suffix;
          else continue;
        }
        const parsed = parseCronCommand(clines[i + 1] || '');
        units.push({
          label: null, unit: t.slice(2), hash, repoKey: repoKeyOut,
          workingDir: parsed.workingDir, scriptPath: parsed.scriptPath, source: 'cron',
        });
      }
      return units;
    }
  } catch (_) { return units; }
  return units; // win32 / unknown: no installed unit is readable
}

// ----- Windows -----
function windowsNoop() {
  say(
    'anti-hall devswarm-ingest: Windows has no pure-Node user-level long-running\n' +
      'scheduler in built-ins (no launchd/systemd/cron), so no background unit is\n' +
      'installed (documented no-op). The ingest daemon does NOT kill anything, so\n' +
      'this is not the supervisor\'s kill-safety limitation — it is simply the\n' +
      'absence of a built-in scheduler. Run node companion/devswarm-ingest.js\n' +
      'manually if you need ingest on Windows. Exit 0.'
  );
  process.exit(0);
}

function main() {
  try {
    if (process.platform === 'win32') return windowsNoop();
    if (!fs.existsSync(SCRIPT)) { say(`error: ingest daemon script not found at ${SCRIPT}`); process.exit(1); return; }
    // Resolve the worktree the daemon must run FROM (see resolveWorktree). Only for
    // install — uninstall must still tear the unit down regardless of cwd. If cwd is
    // not inside a git worktree, do NOT install a non-draining daemon: fail open —
    // log + skip, exit 0 (non-fatal). Better no daemon than one that drains nothing.
    let workdir = null;
    if (!UNINSTALL) {
      workdir = resolveWorktree(process.cwd());
      if (!workdir) {
        say('ingest daemon not installed: no git worktree resolved from cwd; the daemon must run from a workspace worktree to drain its queue. Skipping install (no-op, exit 0).');
        process.exit(0);
        return;
      }
    } else {
      // Uninstall targets the CURRENT worktree's per-worktree unit when cwd resolves
      // to one (best-effort); when it doesn't, the *Uninstall helpers fall back to the
      // legacy base-LABEL/UNIT so a pre-per-worktree install can still be torn down.
      workdir = resolveWorktree(process.cwd());
    }
    // Belt-and-suspenders (defense in depth on top of per-target escaping): refuse
    // to emit a unit/plist/cron entry for a node/script/worktree path carrying
    // control chars or quote characters. Fail-open — log + skip install, exit 0
    // (non-fatal), so a hostile path never yields an unsafe unit and never aborts hard.
    if (!UNINSTALL && (!pathIsEmittable(EXEC) || !pathIsEmittable(SCRIPT) || !pathIsEmittable(workdir) || !pathIsEmittable(LOG))) {
      say('error: node/script/worktree path contains control or quote characters; refusing to emit an unsafe unit. Skipping install (no-op, exit 0).');
      process.exit(0);
      return;
    }
    // v0.57 mesh (D1/D9/Phase5): resolve the PROJECT identity — the MAIN worktree
    // (dirname of `--git-common-dir`, NEVER a linked/child worktree) + its repoKey.
    // `workdir` above (git `--show-toplevel`) is the PER-WORKTREE resolution and
    // stays the install-refusal / path-safety gate; `mainWorktree`/`repoKey` are
    // project-wide and are what the NEW per-project unit bakes.
    const mainWorktree = resolveMainWorktree(process.cwd());
    const repoKey = (mainWorktree && repokey) ? repokey.repoKeyForWorktree(mainWorktree) : null;
    if (mainWorktree && repoKey && pathIsEmittable(mainWorktree)) {
      if (UNINSTALL) {
        // Uninstall targets BOTH the current worktree's legacy per-worktree unit
        // (existing behavior, kept for back-compat / a pre-mesh install) AND this
        // repo's per-project unit (best-effort — an absent project unit is a
        // harmless no-op via the same ignore-err posture as macUninstall).
        if (process.platform === 'darwin') { macUninstall(workdir); macUninstallProject(repoKey); }
        else { linuxUninstall(workdir); linuxUninstallProject(repoKey); }
        process.exit(0);
        return;
      }
      // REAP-BEFORE-DRAIN (D9): stop+unload this repo's LEGACY per-worktree units
      // FIRST — enumerated via `git worktree list --porcelain` from the main
      // worktree (Gap-2: worktreeHash is one-way and cannot be inverted) — BEFORE
      // the new per-project daemon is installed/(re)loaded. A brief buffered
      // ingest pause during this handoff is EXPECTED (latency, not loss; the
      // daemon's own reap-before-drain PROBE, devswarm-ingest.js, additionally
      // backs off its first `monitor` while any legacy holder is still alive).
      reapLegacyUnitsForRepo(mainWorktree, { platform: process.platform });
      if (process.platform === 'darwin') macInstallProject(mainWorktree, repoKey);
      else linuxInstallProject(mainWorktree, repoKey);
      process.exit(0);
      return;
    }
    // Fail-open fallback: repoKey/mainWorktree did not resolve even though
    // `workdir` (a DIFFERENT git primitive, `--show-toplevel`) did, or the
    // resolved mainWorktree path is not safely emittable. Extremely unlikely
    // given both derive from the same real git repo, but rather than hard-exit,
    // fall back to the OLD per-worktree install/uninstall so this never regresses
    // to "no daemon at all".
    if (process.platform === 'darwin') { if (UNINSTALL) macUninstall(workdir); else macInstall(workdir); }
    else { if (UNINSTALL) linuxUninstall(workdir); else linuxInstall(workdir); }
    process.exit(0);
  } catch (e) {
    say(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  LABEL, UNIT, SCRIPT, LOG, RESTART_SEC, CRON_MARKER,
  resolveStableScript,
  xmlEscape, shSingleQuote, sdQuote, pathIsEmittable, resolveWorktree,
  buildPlist, buildService, buildCronLine, buildCronEntry, mergeCrontab, removeCronEntry,
  worktreeHash, labelForWorktree, unitForWorktree, cronMarkerForWorktree, primaryWorkspaceId,
  listInstalledIngestUnits,
  // v0.57 mesh (D1/D9/Phase5) — per-project identity + reap-before-drain:
  labelForProject, unitForProject, cronMarkerForProject,
  resolveMainWorktree, listRepoWorktrees, parseWorktreeListPorcelain,
  reapPlanForRepo, reapLegacyUnitsForRepo, stopLegacyUnitEntry,
  macInstallProject, macUninstallProject, linuxInstallProject, linuxUninstallProject,
  LEGACY_UNIT_HASH_RE, PROJECT_UNIT_KEY_RE,
};
