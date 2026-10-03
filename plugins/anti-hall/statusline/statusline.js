#!/usr/bin/env node
// statusline.js — Two-line statusline dispatcher.
//
// LINE 1: if ~/.anti-hall/base-statusline.json exists and has a "command"
//   string, runs THAT command (passing the same stdin bytes) and uses its
//   stdout as line 1.  ANSI / colors / emoji in the base command's output
//   are preserved byte-for-byte.  Trailing newlines are trimmed to one.
//   Fail-open: if the base command errors, falls through to own dispatch.
//
//   Own dispatch (when no base config, or base command fails):
//     Monorepo detection (checked at git toplevel, then cwd):
//       .gitmodules exists    => monorepo (git submodules)
//     Otherwise => simple statusline.
//     (.gsd/ / .planning/ dropped as monorepo triggers 2026-07-03 — GSD is
//     discontinued, nothing creates those directories anymore.)
//
// LINE 2: phase bar (only printed when ~/.anti-hall/phase-state.json
//   exists and is valid). Omitted entirely when state file is absent/invalid.
//
// Fail-open: if line 1 errors, still attempt line 2. If line 2 errors, omit it.
// Never crashes Claude Code. No emojis. Pure Node. OS-agnostic.
//
// LIFECYCLE GOTCHAS (learned empirically — see KB §14.4):
//   1. Claude Code reads the `statusLine` setting ONLY at session startup; it does
//      NOT hot-reload. So a per-project install (writing .claude/settings.json mid-
//      session) shows NOTHING until Claude Code is RESTARTED in that repo. An already-
//      running session keeps whatever statusLine it loaded at startup — which is why a
//      freshly-installed project shows no bar while another, already-open project does.
//   2. The line-1 base command (~/.anti-hall/base-statusline.json) is GLOBAL — shared
//      by EVERY project whose statusLine points at this dispatcher (e.g. one that set it
//      via settings.local.json). A RELATIVE base command resolves against the per-project
//      cwd, so it renders that project's own helper where present and falls through to
//      own-dispatch elsewhere. Overwriting this file changes line 1 for all such
//      projects at once — never assume it is project-local.
//   3. The line-2 phase state lives at os.homedir()/.anti-hall/phase-state.json, NOT
//      os.tmpdir() (see phase-bar.js): homedir is identical for every process, but each
//      process can see a different TMPDIR, so a tmpdir-written state file is invisible
//      to the live statusline runner.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const identity = require('../companion/lib/identity.js');

// ---------------------------------------------------------------------------
// Timeout budget (coherence)
// ---------------------------------------------------------------------------
// A statusline must stay fast — OUTER_WATCHDOG_MS is the hard ceiling on the
// whole dispatcher (stdin collection in main()) and stays at 3000ms; it is
// NOT raised to accommodate slow inner work. Instead, everything the
// dispatcher can spawn is bounded BELOW it: INNER_SPAWN_TIMEOUT_MS caps
// runBaseCommand()'s spawnSync (a user-configured, possibly-foreign base
// command) and phaseBarLine()'s fallback spawn; the git calls statusline-
// rich.js issues when run in-process (getProjectRoot/getGitInfo) are
// separately capped at ~1500ms each for the same reason. Keep
// INNER_SPAWN_TIMEOUT_MS < OUTER_WATCHDOG_MS <= 3000; see the asserting
// tests in tests/statusline/statusline.test.js.
const INNER_SPAWN_TIMEOUT_MS = 2500;
const OUTER_WATCHDOG_MS = 3000;

// ---------------------------------------------------------------------------
// Base-statusline config
// ---------------------------------------------------------------------------

function readBaseCommand() {
  try {
    const configPath = path.join(os.homedir(), '.anti-hall', 'base-statusline.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.command === 'string' && obj.command.trim()) {
      return obj.command.trim();
    }
  } catch (e) { /* absent or malformed — fall through */ }
  return null;
}

// Run the base statusline command, feeding stdinBytes to it.
// Returns stdout string (trailing newlines trimmed to at most one), or null on error.
function runBaseCommand(baseCmd, stdinBytes) {
  try {
    // Use the system shell so the command can contain pipes, env vars, etc.
    // On Windows: cmd /c; elsewhere: sh -c.
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd' : 'sh';
    const shellFlag = isWin ? '/c' : '-c';

    const result = spawnSync(shell, [shellFlag, baseCmd], {
      input: stdinBytes,
      encoding: 'buffer',     // preserve raw bytes (ANSI / arbitrary encoding)
      // CI runner contention has delayed trivial base commands; hangs still fail open to ownLine1.
      timeout: INNER_SPAWN_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });

    // A base command that never reads stdin (e.g. `echo foo`) can exit before
    // Node finishes writing stdinBytes to its stdin pipe. That auxiliary stdin
    // write can then fail even though the child itself ran to completion with
    // a clean exit and correct stdout — spawnSync still surfaces the write
    // failure on `result.error` regardless. The errno differs by platform:
    // POSIX reports `EPIPE`. Windows does not — libuv's win/pipe.c write-
    // completion path routes a broken-pipe write through the *generic* error
    // translator (win/error.c: `ERROR_BROKEN_PIPE -> UV_EOF`, not the write-
    // specific EPIPE override used elsewhere), and Node's spawn_sync.cc
    // captures the child's real exit status independently of that pipe error
    // (both land on the result object together) — so on Windows this same
    // benign race surfaces as `result.error.code === 'EOF'` with
    // `result.status === 0`, not `EPIPE`. Rather than chase every platform's
    // errno, judge success by the outcome: the base command exited 0 AND
    // produced stdout. A benign auxiliary stdin-write error on an otherwise-
    // successful run is accepted regardless of its errno/platform; a genuine
    // failure (non-zero/absent exit status, or a successful exit with no
    // output at all, e.g. a spawn error like ENOENT) still fails open to
    // own-dispatch.
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) return null;

    let out = result.stdout.toString('utf8');
    // Trim trailing newlines to exactly one (we will append line 2 after a single \n).
    out = out.replace(/[\r\n]+$/, '');
    return out;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process renderer execution
// ---------------------------------------------------------------------------
// Every renderer this dispatcher owns (statusline-rich.js, statusline-
// monorepo.js, statusline-simple.js, phase-bar.js) exports runWithInput(input)
// for exactly this purpose: run it via require() in THIS process instead of
// forking `node <script>` as a child. A fork here costs a shell + a second
// node startup (plus whatever subprocesses the renderer itself spawns, e.g.
// git) — measured as the dominant contributor to statusline latency under
// load (p50 264ms / max 448ms vs ~160ms for other hooks). Returns the
// captured stdout (trailing newline trimmed), or null if the module has no
// runWithInput or throws — callers fall back to a real spawn in that case.
function runInProcess(scriptPath, input) {
  let mod;
  try {
    mod = require(scriptPath);
  } catch (e) {
    return null;
  }
  if (!mod || typeof mod.runWithInput !== 'function') return null;
  const saved  = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    mod.runWithInput(input);
  } catch (e) {
    return null;
  } finally {
    process.stdout.write = saved;
  }
  return chunks.join('').replace(/[\r\n]+$/, '');
}

// A user's ~/.anti-hall/base-statusline.json can end up pointing straight at
// anti-hall's OWN renderer (statusline-rich.js / phase-bar.js) — e.g. a base
// config captured from a prior/partial install. Recognize that specific,
// narrow shape (`node "<path>"` / `node <path>`, nothing else — no pipes,
// flags, redirection, or extra commands) and run it in-process via
// runInProcess() instead of forking a shell that forks node. Anything less
// exact keeps the spawn path: we can't safely reproduce arbitrary shell
// semantics (env vars, pipes, multiple commands) in-process, and a genuinely
// foreign user-configured base command must still go through the real shell.
function matchOwnRendererCommand(baseCmd) {
  const m = /^node\s+"?([^"|;&<>]+?\.js)"?\s*$/.exec(String(baseCmd).trim());
  if (!m) return null;
  const candidate = m[1].trim();
  if (!candidate) return null;
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch (e) {
    return null;
  }
  const ownRenderers = [
    path.join(__dirname, 'statusline-rich.js'),
    path.join(__dirname, 'phase-bar.js'),
  ];
  for (const own of ownRenderers) {
    try {
      if (fs.realpathSync(own) === resolved) return own;
    } catch (e) { /* skip — own renderer file missing, shouldn't happen */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Monorepo detection
// ---------------------------------------------------------------------------

// Filesystem-only resolution (companion/lib/identity.js) — no git subprocess
// spawn for the common case (a submodule superproject check is the only path
// that still spawns). Statusline runs on every prompt, so this must stay
// fast; identity.resolveContext falls back to non-git/'deleted' contexts
// (toplevel: null) the same way a failed `git rev-parse` used to, and we
// mirror the old catch-all fallback to `cwd` for both.
function gitToplevel(cwd) {
  try {
    // missingPath:'ancestor' (B3 P1 fix, mesh redesign): cwd can be a session
    // dir removed out from under the statusline (a cleaned-up worktree) — fall
    // back to the nearest EXISTING ancestor's toplevel (same walk-up the old
    // findGitToplevel always did) rather than degrading the label to the raw,
    // no-longer-existing cwd string.
    return identity.resolveContext(cwd, { missingPath: 'ancestor' }).toplevel || cwd;
  } catch (e) {
    return cwd;
  }
}

function isMonorepo(dir) {
  return fs.existsSync(path.join(dir, '.gitmodules'));
}

// ---------------------------------------------------------------------------
// Phase bar (line 2)  —  delegates to phase-bar.js for full rendering
// ---------------------------------------------------------------------------

function phaseBarLine(stdinBytes) {
  const phaseBarScript = path.join(__dirname, 'phase-bar.js');

  // phase-bar.js is always anti-hall's OWN script (never user-configured, no
  // shell string to interpret) — run it in-process via runInProcess() rather
  // than forking `node phase-bar.js` on every single render.
  try {
    const out = runInProcess(phaseBarScript, stdinBytes.toString('utf8'));
    if (out !== null) return out || null;
  } catch (e) { /* fall through to the spawn below */ }

  // Fallback spawn path — kept for robustness (e.g. a mangled install whose
  // phase-bar.js lacks runWithInput) so line 2 still degrades gracefully
  // instead of silently disappearing.
  try {
    const result = spawnSync(process.execPath, [phaseBarScript], {
      input: stdinBytes,            // pass the session JSON so the context bar has data
      encoding: 'utf8',
      // Match runBaseCommand's CI-contention-aware timeout above: under heavy
      // scheduler load (e.g. a large parallel test run) this spawnSync can miss
      // a too-tight deadline even though the child itself is fast, silently
      // dropping line 2 (fail-open) and leaving a misleading line-1-only
      // statusline. 2000ms measured flaky under real full-suite contention.
      timeout: INNER_SPAWN_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) return null;
    const out = (result.stdout || '').replace(/[\r\n]+$/, '');
    return out || null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Own-dispatch line 1 (fallback when no base config)
// ---------------------------------------------------------------------------

function ownLine1(input) {
  try {
    let cwd = process.cwd();
    try {
      const data = JSON.parse(input);
      cwd = data.workspace?.current_dir || data.cwd || cwd;
    } catch (e) { /* use process.cwd() */ }

    const toplevel = gitToplevel(cwd);
    const monorepo = isMonorepo(toplevel) || isMonorepo(cwd);

    const scriptDir = __dirname;
    // Primary own-dispatch renderer is the RICH statusline (project name, git,
    // model, context%, cost, duration, subagents) — it works
    // for both monorepo and plain repos. If it yields nothing (fail-open), fall
    // back to the monorepo/simple renderer.
    const renderers = [
      path.join(scriptDir, 'statusline-rich.js'),
      monorepo ? path.join(scriptDir, 'statusline-monorepo.js')
               : path.join(scriptDir, 'statusline-simple.js'),
    ];

    for (const renderer of renderers) {
      // Capture renderer output by temporarily overriding process.stdout.write.
      const saved  = process.stdout.write.bind(process.stdout);
      const chunks = [];
      process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
      try {
        const mod = require(renderer);
        if (typeof mod.runWithInput === 'function') mod.runWithInput(input);
      } catch (e) {
        /* try next renderer */
      } finally {
        process.stdout.write = saved;
      }
      const out = chunks.join('').replace(/[\r\n]+$/, '');
      if (out) return out;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const inputChunks = [];
  const timeout = setTimeout(() => process.exit(0), OUTER_WATCHDOG_MS);

  // Collect raw bytes from stdin so we can forward them intact to the base command.
  process.stdin.on('data', chunk => { inputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
  process.stdin.on('end', () => {
    clearTimeout(timeout);

    const stdinBytes  = Buffer.concat(inputChunks);
    const inputString = stdinBytes.toString('utf8');

    // --- LINE 1 ---
    let line1 = '';
    try {
      const baseCmd = readBaseCommand();
      if (baseCmd) {
        // Self-referential base command (points at anti-hall's own renderer,
        // e.g. from a prior/partial install) — run in-process, no shell/node fork.
        const ownScript = matchOwnRendererCommand(baseCmd);
        const baseOut = ownScript
          ? runInProcess(ownScript, inputString)
          : runBaseCommand(baseCmd, stdinBytes);
        if (baseOut !== null && baseOut !== '') {
          line1 = baseOut;
        } else {
          // Base command failed (or, for the in-process path, yielded nothing)
          // — fall through to own dispatch.
          line1 = ownLine1(inputString);
        }
      } else {
        line1 = ownLine1(inputString);
      }
    } catch (e) {
      // Line 1 failed entirely — proceed to line 2 attempt anyway
    }

    // --- LINE 2: always-on hybrid (phase bar during a run, else context bar) ---
    const line2 = phaseBarLine(stdinBytes);

    // --- Emit ---
    let out = line1;
    if (line2) out += (line1 ? '\n' : '') + line2;
    if (out) {
      try {
        process.stdout.write(out);
      } catch (e) {
        // EPIPE or other write error — ignore, never crash Claude Code
      }
    }
  });
}

// Suppress a broken-pipe stdout so a closed pipe never propagates as an unhandled
// error and crashes the statusline (contract: never crash Claude Code — see top
// of file). POSIX reports this as EPIPE. Windows does not: libuv's win/pipe.c
// write-completion path maps a broken pipe through the generic error translator
// (win/error.c: `ERROR_BROKEN_PIPE -> UV_EOF`, not the write-specific EPIPE
// override used elsewhere — the same errno-agnostic reasoning already applied to
// runBaseCommand's stdin-write race above), so the same benign condition surfaces
// as `e.code === 'EOF'` there. A statusline whose stdout is gone has nothing left
// to do but exit quietly, so swallow both rather than chase every platform's errno.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'EOF') throw e; });

main();
