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
//       .gsd/ dir exists      => monorepo (GSD project)
//       .planning/ dir exists => monorepo (planning state present)
//     Otherwise => simple statusline.
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
const { execFileSync, spawnSync } = require('child_process');

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
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });

    if (result.error || result.status !== 0) return null;

    let out = result.stdout.toString('utf8');
    // Trim trailing newlines to exactly one (we will append line 2 after a single \n).
    out = out.replace(/[\r\n]+$/, '');
    return out;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Monorepo detection
// ---------------------------------------------------------------------------

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
  } catch (e) {
    return cwd;
  }
}

function isMonorepo(dir) {
  if (fs.existsSync(path.join(dir, '.gitmodules'))) return true;
  if (fs.existsSync(path.join(dir, '.gsd')))        return true;
  if (fs.existsSync(path.join(dir, '.planning')))   return true;
  return false;
}

// ---------------------------------------------------------------------------
// Phase bar (line 2)  —  delegates to phase-bar.js for full rendering
// ---------------------------------------------------------------------------

function phaseBarLine(stdinBytes) {
  try {
    const phaseBarScript = path.join(__dirname, 'phase-bar.js');
    const result = spawnSync(process.execPath, [phaseBarScript], {
      input: stdinBytes,            // pass the session JSON so the context bar has data
      encoding: 'utf8',
      timeout: 2000,
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
    // model, context%, cost, duration, subagents, optional GSD phase) — it works
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
  const timeout = setTimeout(() => process.exit(0), 3000);

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
        const baseOut = runBaseCommand(baseCmd, stdinBytes);
        if (baseOut !== null) {
          line1 = baseOut;
        } else {
          // Base command failed — fall through to own dispatch
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

// Suppress EPIPE so a closed pipe on stdout never propagates as an unhandled error.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

main();
