#!/usr/bin/env node
// statusline-rich.js — generic rich statusline (project name, git, model,
// context%, cost, duration, subagents, optional GSD phase). Pure Node,
// OS-agnostic, fail-open. No project/user specifics.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const os = require('os');

// Configuration
const CONFIG = {
  maxAgents: 15,
};

const CWD = process.cwd();

// Project root = git toplevel of the current working directory. Falls back
// to CWD when not inside a git repo. Computed once per render.
let _projectRoot;
function getProjectRoot() {
  if (_projectRoot !== undefined) return _projectRoot;
  let root = '';
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: CWD,
    }).trim();
  } catch { /* not a git repo */ }
  _projectRoot = root || CWD;
  return _projectRoot;
}

// ─── ANSI colors ────────────────────────────────────────────────
// Default ON because a statusline harness typically captures stdout
// through a pipe (not a TTY) and re-renders the ANSI codes itself — so an
// isTTY check would always disable colors here. We only honour NO_COLOR
// (no-color.org convention) as an explicit opt-out.
const COLOR_ENABLED = !process.env.NO_COLOR;
const _ = (code) => (COLOR_ENABLED ? code : '');
const c = {
  reset: _('\x1b[0m'),
  bold: _('\x1b[1m'),
  dim: _('\x1b[2m'),
  red: _('\x1b[0;31m'),
  green: _('\x1b[0;32m'),
  yellow: _('\x1b[0;33m'),
  blue: _('\x1b[0;34m'),
  purple: _('\x1b[0;35m'),
  cyan: _('\x1b[0;36m'),
  brightRed: _('\x1b[1;31m'),
  brightGreen: _('\x1b[1;32m'),
  brightYellow: _('\x1b[1;33m'),
  brightBlue: _('\x1b[1;34m'),
  brightPurple: _('\x1b[1;35m'),
  brightCyan: _('\x1b[1;36m'),
  brightWhite: _('\x1b[1;37m'),
};

// ─── Safe helpers ───────────────────────────────────────────────

// safeLabel — strip terminal-escape injection from dynamic text rendered into
// the statusline. A crafted branch name / project dir name (which we read from
// git / the filesystem) could carry ANSI/OSC/C0/C1 control sequences that move
// the cursor, recolor the whole line, set the window title (OSC), or smuggle
// hidden text. We emit our OWN ANSI codes, so any escape from DATA is injection.
// Drop ESC-introduced sequences (CSI/OSC/other), bare C0, DEL, and C1 bytes.
// Cheap (linear) + fail-open (returns '' on a non-string).
function safeLabel(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (title/hyperlink)
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]?/g, '')        // CSI + other ESC seqs
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')               // C0 + DEL + C1
    // Unicode bidi overrides (U+202A–U+202E) + isolates (U+2066–U+2069):
    // they survive the C0/C1 strip but visually reorder terminal output.
    .replace(/[‪-‮⁦-⁩]/g, '');
}

// Safe execSync with strict timeout (returns empty string on failure)
function safeExec(cmd, timeoutMs = 2000) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// Safe JSON file reader (returns null on failure)
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// Safe file stat (returns null on failure)
function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch { /* ignore */ }
  return null;
}

// Shared settings cache — read once, used by multiple functions
let _settingsCache = undefined;
function getSettings() {
  if (_settingsCache !== undefined) return _settingsCache;
  _settingsCache = readJSON(path.join(CWD, '.claude', 'settings.json'))
                || readJSON(path.join(CWD, '.claude', 'settings.local.json'))
                || null;
  return _settingsCache;
}

// ─── CWD / submodule detection (relative to git toplevel) ───────

// Compute CWD info relative to project root: which submodule (top-level
// dir) we're in, plus any deeper sub-path. Returns {submodule, subPath}.
function getCwdInfo() {
  try {
    const rel = path.relative(getProjectRoot(), CWD);
    if (!rel || rel === '.') return { submodule: null, subPath: '' };
    if (rel.startsWith('..')) return { submodule: null, subPath: rel };
    const parts = rel.split(path.sep);
    return {
      submodule: parts[0] || null,
      subPath: parts.slice(1).join('/') || '',
    };
  } catch {
    return { submodule: null, subPath: '' };
  }
}

// ─── Effort / output_style ──────────────────────────────────────

// Read the active output_style / effort hint from stdin. Returns null when
// style is missing or 'default' (don't render a chip for the default style).
function getEffort() {
  const data = getStdinData();
  if (!data) return null;
  // The statusline JSON exposes output_style.name. Some versions also
  // surface model.effort. Both can sometimes be strings, sometimes objects
  // ({name: "...", level: "..."}). Coerce safely so a misshapen value
  // doesn't print "[object Object]".
  function asLabel(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return String(v.name || v.level || v.value || '');
    return '';
  }
  const eff = asLabel(data.effort)
            || asLabel(data.model && data.model.effort)
            || asLabel(data.output_style);
  if (!eff || eff === 'default' || eff === 'Default') return null;
  return eff;
}

// ─── Subagent count ─────────────────────────────────────────────

// Count active subagent tasks by scanning per-session task-output files in
// the OS temp dir. A task whose .output file was modified in the last 60 s
// is treated as "active". Best-effort: if the layout changes upstream this
// silently returns 0. Uses os.tmpdir() so it works on Windows / Mac / Linux.
function getSubagentCount() {
  try {
    const base = os.tmpdir();
    const claudeDirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('claude-'))
      .map((d) => path.join(base, d.name));
    if (claudeDirs.length === 0) return 0;

    const now = Date.now();
    const ACTIVE_MS = 60_000;
    let active = 0;

    for (const cdir of claudeDirs) {
      // Walk one level down to find <session>/tasks/*.output
      let projectDirs = [];
      try {
        projectDirs = fs.readdirSync(cdir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(cdir, d.name));
      } catch { continue; }
      for (const pdir of projectDirs) {
        let sessionDirs = [];
        try {
          sessionDirs = fs.readdirSync(pdir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(pdir, d.name));
        } catch { continue; }
        for (const sdir of sessionDirs) {
          const tasksDir = path.join(sdir, 'tasks');
          let outputs = [];
          try {
            outputs = fs.readdirSync(tasksDir).filter((n) => n.endsWith('.output'));
          } catch { continue; }
          for (const f of outputs) {
            try {
              const st = fs.statSync(path.join(tasksDir, f));
              if (now - st.mtimeMs <= ACTIVE_MS) active++;
            } catch { /* ignore */ }
          }
        }
      }
    }
    return active;
  } catch {
    return 0;
  }
}

// ─── GSD phase chip ─────────────────────────────────────────────

// GSD phase chip — only renders when the project has a GSD
// `.planning/STATE.md` file. Pure file read, no subprocess.
function getGsdPhase() {
  try {
    const statePath = path.join(getProjectRoot(), '.planning', 'STATE.md');
    const txt = fs.readFileSync(statePath, 'utf-8');
    // GSD STATE.md frontmatter uses `milestone`, `status` (free-form
    // sentence beginning with "Phase N..."), and a nested `progress.percent`.
    // Extract a compact label for the chip.
    const milestone = (txt.match(/^milestone:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1];
    const status = (txt.match(/^status:\s*(.+?)\s*$/m) || [])[1] || '';
    const phaseMatch = status.match(/Phase\s+(\d+(?:\.\d+)?)/i);
    const pct = (txt.match(/^\s*percent:\s*(\d+)\s*$/m) || [])[1];
    if (!milestone && !phaseMatch && !pct) return null;
    return {
      milestone: milestone ? milestone.trim() : null,
      phaseNum: phaseMatch ? phaseMatch[1] : null,
      pct: pct ? parseInt(pct, 10) : null,
    };
  } catch {
    return null;
  }
}

// Claude account email — read the signed-in account email from ~/.claude.json
// (oauthAccount.emailAddress). Returns null when unavailable. The chip shows it
// only when available, and can be suppressed via ANTIHALL_STATUSLINE_NO_EMAIL.
function getClaudeEmail() {
  try {
    const cfg = readJSON(path.join(os.homedir(), '.claude.json'));
    const email = cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress;
    return (typeof email === 'string' && email.trim()) ? email.trim() : null;
  } catch {
    return null;
  }
}

// ─── Git info ───────────────────────────────────────────────────

// Get all git info via shell-free execFileSync calls.
// Cross-platform: works on Windows cmd/PowerShell, Mac, Linux.
// Efficiency: 2 git calls — one combined `status --porcelain=v2 --branch`
// returns branch + upstream tracking + ahead/behind + status at once; one
// `stash list` for the stash count.
function getGitInfo() {
  const result = {
    name: 'user', gitBranch: '', modified: 0, untracked: 0,
    staged: 0, ahead: 0, behind: 0,
    isWorktree: false, worktreeName: '', stashCount: 0,
  };

  function git(args) {
    try {
      return execFileSync('git', args, {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
        cwd: CWD,
      }).trim();
    } catch {
      return '';
    }
  }

  result.name = git(['config', 'user.name']) || 'user';

  // Combined porcelain v2 + branch. Output format:
  //   # branch.head <name>
  //   # branch.ab +<ahead> -<behind>        (only if tracking)
  //   1 ...                                  (changed entry, one per line)
  //   ? <path>                               (untracked)
  const v2 = git(['status', '--porcelain=v2', '--branch']);
  if (v2) {
    let count = 0;
    for (const line of v2.split('\n')) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        result.gitBranch = line.slice('# branch.head '.length).trim();
        if (result.gitBranch === '(detached)') result.gitBranch = '';
      } else if (line.startsWith('# branch.ab ')) {
        // # branch.ab +N -M  (sign-prefixed counts)
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          result.ahead = parseInt(m[1], 10) || 0;
          result.behind = parseInt(m[2], 10) || 0;
        }
      } else if (line.startsWith('# ')) {
        // other branch.* headers — ignore
      } else if (line[0] === '?') {
        result.untracked++;
      } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') {
        // 1 = ordinary changed, 2 = renamed/copied, u = unmerged.
        // Field 2 of the v2 record is XY where X = staged, Y = unstaged.
        const xy = line.slice(2, 4);
        const x = xy[0], y = xy[1];
        if (x !== '.' && x !== ' ') result.staged++;
        if (y !== '.' && y !== ' ') result.modified++;
      }
      // Cap parsing at 500 entries so a giant porcelain doesn't stall us.
      if (++count > 500) break;
    }
  }

  // Stash count (only render when > 0). Cheap single call.
  const stash = git(['stash', 'list']);
  if (stash) {
    result.stashCount = stash.split('\n').filter(Boolean).length;
  }

  // Worktree detection. In a linked worktree, --absolute-git-dir resolves
  // to <main-repo>/.git/worktrees/<name>; the main checkout ends in /.git.
  // Regex matches both / and \ to handle Windows path output.
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  if (gitDir && /[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir)) {
    result.isWorktree = true;
    result.worktreeName = path.basename(gitDir);
  }

  return result;
}

// ─── Model name (file fallback) ─────────────────────────────────

// Detect model name from Claude config (pure file reads, no exec). Used only
// as a fallback when stdin doesn't carry model.display_name.
function getModelName() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig && claudeConfig.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id] && usage[id].lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus';
              if (modelId.includes('sonnet')) return 'Sonnet';
              if (modelId.includes('haiku')) return 'Haiku';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: settings.json model field
  const settings = getSettings();
  if (settings && settings.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
  }
  return 'Claude Code';
}

// ─── Session stats (file fallback) ──────────────────────────────

// Session duration from a local session.json (pure file reads). Fallback for
// when stdin doesn't carry cost.total_duration_ms.
function getSessionStats() {
  const data = readJSON(path.join(CWD, '.claude', 'session.json'));
  if (data && data.startTime) {
    const diffMs = Date.now() - new Date(data.startTime).getTime();
    const mins = Math.floor(diffMs / 60000);
    const duration = mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
    return { duration: duration };
  }
  return { duration: '' };
}

// ─── Rendering helpers ──────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '●'.repeat(filled) + '○'.repeat(width - filled) + ']';
}

// ─── Stdin extractors ───────────────────────────────────────────
// The statusline harness pipes session JSON via stdin (model, context,
// cost, etc.). When invoked via runWithInput() the raw string is supplied
// directly; when run as a standalone process we read fd 0 synchronously.
let _stdinData = undefined;

// Inject a pre-read stdin string (used by runWithInput()).
function setStdinData(raw) {
  try {
    const s = (raw || '').trim();
    _stdinData = (s && s.startsWith('{')) ? JSON.parse(s) : null;
  } catch {
    _stdinData = null;
  }
}

function getStdinData() {
  if (_stdinData !== undefined) return _stdinData;
  try {
    // Check if stdin is a TTY (manual run) — skip reading
    if (process.stdin.isTTY) { _stdinData = null; return null; }
    // Read stdin synchronously via fd 0
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let bytesRead;
    try {
      while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(Buffer.from(buf.slice(0, bytesRead)));
      }
    } catch { /* EOF or read error */ }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    _stdinData = (raw && raw.startsWith('{')) ? JSON.parse(raw) : null;
  } catch {
    _stdinData = null;
  }
  return _stdinData;
}

// Prefer model display name from stdin.
function getModelFromStdin() {
  const data = getStdinData();
  if (data && data.model && data.model.display_name) return data.model.display_name;
  return null;
}

// Context window info from the session.
function getContextFromStdin() {
  const data = getStdinData();
  if (data && data.context_window) {
    return {
      usedPct: Math.floor(data.context_window.used_percentage || 0),
      remainingPct: Math.floor(data.context_window.remaining_percentage || 100),
    };
  }
  return null;
}

// Cost + duration info from the session.
function getCostFromStdin() {
  const data = getStdinData();
  if (data && data.cost) {
    const durationMs = data.cost.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    return {
      costUsd: data.cost.total_cost_usd || 0,
      duration: mins > 0 ? mins + 'm' + secs + 's' : secs + 's',
      linesAdded: data.cost.total_lines_added || 0,
      linesRemoved: data.cost.total_lines_removed || 0,
    };
  }
  return null;
}

// ─── Statusline builder ─────────────────────────────────────────

function generateStatusline() {
  const git = getGitInfo();
  // Prefer model name from stdin, fallback to file-based detection.
  const modelName = getModelFromStdin() || getModelName();
  const ctxInfo = getContextFromStdin();
  const costInfo = getCostFromStdin();
  const session = getSessionStats();
  const lines = [];

  // Header — project name = basename of the git toplevel (or cwd).
  const cwdInfo = getCwdInfo();
  const projectName = safeLabel(path.basename(getProjectRoot())) || 'project';
  let header = c.bold + c.brightPurple + '▊ ' + projectName + c.reset;
  if (cwdInfo.submodule) {
    header += c.dim + '/' + c.reset + c.bold + c.brightPurple + safeLabel(cwdInfo.submodule) + c.reset;
  }
  header += ' ' + c.dim + '● ' + c.brightCyan + git.name + c.reset;
  if (cwdInfo.subPath) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.dim + '📂 ' + safeLabel(cwdInfo.subPath) + c.reset;
  }
  if (git.gitBranch) {
    // 🌳 worktree (linked checkout) · 🌿 plain branch in main checkout
    const refIcon = git.isWorktree ? '🌳' : '🌿';
    const refLabel = git.isWorktree && git.worktreeName
      ? safeLabel(git.worktreeName) + '@' + safeLabel(git.gitBranch)
      : safeLabel(git.gitBranch);
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightBlue + refIcon + ' ' + refLabel + c.reset;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += c.brightGreen + '+' + git.staged + c.reset;
      if (git.modified > 0) ind += c.brightYellow + '~' + git.modified + c.reset;
      if (git.untracked > 0) ind += c.dim + '?' + git.untracked + c.reset;
      header += ' ' + ind;
    }
    if (git.ahead > 0) header += ' ' + c.brightGreen + '↑' + git.ahead + c.reset;
    if (git.behind > 0) header += ' ' + c.brightRed + '↓' + git.behind + c.reset;
    // Stash badge — only when something is stashed.
    if (git.stashCount > 0) {
      header += ' ' + c.brightPurple + '📦 ' + git.stashCount + c.reset;
    }
  }
  header += '  ' + c.dim + '│' + c.reset + '  ' + c.purple + modelName + c.reset;
  // Effort / output_style indicator next to model — only renders for
  // non-default styles (high, low, thinking, etc.).
  const effort = getEffort();
  if (effort) {
    header += ' ' + c.dim + '(' + effort + ')' + c.reset;
  }
  // Active subagent count — only renders when > 0. Best-effort: scans the
  // OS temp dir for recently-modified task output files.
  const subagents = getSubagentCount();
  if (subagents > 0) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightCyan + '🤖 ' + subagents + c.reset;
  }
  // Session duration from stdin if available, else from local files.
  const duration = costInfo ? costInfo.duration : session.duration;
  if (duration) header += '  ' + c.dim + '│' + c.reset + '  ' + c.cyan + '⏱ ' + duration + c.reset;
  // Context usage from stdin if available.
  if (ctxInfo && ctxInfo.usedPct > 0) {
    const ctxColor = ctxInfo.usedPct >= 90 ? c.brightRed : ctxInfo.usedPct >= 70 ? c.brightYellow : c.brightGreen;
    header += '  ' + c.dim + '│' + c.reset + '  ' + ctxColor + '● ' + ctxInfo.usedPct + '% ctx' + c.reset;
  }
  // Cost from stdin if available. Uses brightWhite so it doesn't collide
  // with the yellow-tier of the ctx gradient or the GSD chip — money is FYI.
  if (costInfo && costInfo.costUsd > 0) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightWhite + '$' + costInfo.costUsd.toFixed(2) + c.reset;
  }
  // GSD phase chip — only renders when .planning/STATE.md exists. Uses
  // (non-bright) cyan so it sits visually between the subagents/cost chips.
  const gsd = getGsdPhase();
  if (gsd) {
    const parts = [];
    if (gsd.milestone) parts.push(gsd.milestone);
    if (gsd.phaseNum) parts.push('Phase ' + gsd.phaseNum);
    if (gsd.pct != null) parts.push(gsd.pct + '%');
    if (parts.length) {
      header += '  ' + c.dim + '│' + c.reset + '  ' + c.cyan + '▸ ' + parts.join(' · ') + c.reset;
    }
  }
  // Account email chip — shows the signed-in email WHEN AVAILABLE (read from
  // ~/.claude.json). Dim, last segment. Opt-out: set ANTIHALL_STATUSLINE_NO_EMAIL=1
  // (or any non-'0'/'false' value) to hide it, e.g. for screenshots/screen-shares.
  const noEmail = process.env.ANTIHALL_STATUSLINE_NO_EMAIL;
  if (!(noEmail && noEmail !== '0' && noEmail !== 'false')) {
    const email = getClaudeEmail();
    if (email) {
      header += '  ' + c.dim + '│' + c.reset + '  ' + c.dim + '✉ ' + email + c.reset;
    }
  }
  lines.push(header);

  return lines.join('\n');
}

// ─── Entry points ───────────────────────────────────────────────

// Render the statusline from a pre-read stdin JSON string and print one
// line to stdout. Used by the dispatcher: require(renderer).runWithInput(s).
function runWithInput(input) {
  try {
    setStdinData(input);
    process.stdout.write(generateStatusline());
  } catch { /* fail-open: never crash the statusline */ }
}

// Standalone run: read stdin (fd 0) then print one line.
function runStatusline() {
  try {
    process.stdout.write(generateStatusline());
  } catch { /* fail-open */ }
}

module.exports = { runWithInput, safeLabel };

if (require.main === module) runStatusline();
