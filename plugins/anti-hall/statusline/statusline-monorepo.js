#!/usr/bin/env node
// statusline-monorepo.js — Claude Code statusline for monorepo / GSD projects.
// Ported from gsd-statusline.js; all project-specific assumptions removed.
// Missing .planning/ / .gsd/ => segments omitted gracefully; never crashes.
// No emojis. Plain ASCII separators only.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readGsdConfig(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'config.json');
    if (fs.existsSync(candidate)) {
      try { return JSON.parse(fs.readFileSync(candidate, 'utf8')) || {}; }
      catch (e) { return {}; }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return {};
}

function getConfigValue(cfg, keyPath) {
  if (!cfg || typeof cfg !== 'object') return undefined;
  if (keyPath in cfg) return cfg[keyPath];
  const parts = keyPath.split('.');
  let cur = cfg;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function readLastSlashCommand(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    const MAX  = 256 * 1024;
    const start = Math.max(0, stat.size - MAX);
    const fd = fs.openSync(transcriptPath, 'r');
    let content;
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const tagClose = '</command-name>';
    const idx = content.lastIndexOf(tagClose);
    if (idx < 0) return null;
    const openTag  = '<command-name>';
    const openIdx  = content.lastIndexOf(openTag, idx);
    if (openIdx < 0) return null;
    let name = content.slice(openIdx + openTag.length, idx).trim();
    if (name.startsWith('/')) name = name.slice(1);
    if (!name || /[\s\\"<>]/.test(name) || name.length > 80) return null;
    return name;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GSD / .planning state reader
// ---------------------------------------------------------------------------

function readGsdState(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'STATE.md');
    if (fs.existsSync(candidate)) {
      try { return parseStateMd(fs.readFileSync(candidate, 'utf8')); }
      catch (e) { return null; }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return null;
}

function parseStateMd(content) {
  const state = {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    for (const line of fm.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      const v = val.trim().replace(/^["']|["']$/g, '');
      if (key === 'status')         state.status        = v === 'null' ? null : v;
      if (key === 'milestone')      state.milestone     = v === 'null' ? null : v;
      if (key === 'milestone_name') state.milestoneName = v === 'null' ? null : v;
      if (key === 'active_phase')   state.activePhase   = (v === 'null' || v === '') ? null : v;
      if (key === 'next_action')    state.nextAction    = (v === 'null' || v === '') ? null : v;
    }
    // next_phases: flow array or block list
    const npFlow = fm.match(/^next_phases:\s*\[([^\]]*)\]/m);
    if (npFlow) {
      const items = npFlow[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      state.nextPhases = items.length > 0 ? items : null;
    } else {
      const npBlock = fm.match(/^next_phases:\s*\n((?:[ \t]*-[ \t]*[^\n]+\n?)*)/m);
      if (npBlock) {
        const items = npBlock[1].split('\n')
          .map(l => l.match(/^[ \t]*-[ \t]*(.+)$/))
          .filter(Boolean)
          .map(m => m[1].trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        state.nextPhases = items.length > 0 ? items : null;
      }
    }
    // progress nested block
    const prog = fm.match(/^progress:\s*\n((?:[ \t]+\w+:.+\n?)+)/m);
    if (prog) {
      const cp = prog[1].match(/^[ \t]+completed_phases:\s*(\d+)/m);
      const tp = prog[1].match(/^[ \t]+total_phases:\s*(\d+)/m);
      const pc = prog[1].match(/^[ \t]+percent:\s*(\d+)/m);
      if (cp) state.completedPhases = cp[1];
      if (tp) state.totalPhases     = tp[1];
      if (pc) state.percent         = pc[1];
    }
  }
  const phaseMatch = content.match(/^Phase:\s*(\d+)\s+of\s+(\d+)(?:\s+\(([^)]+)\))?/m);
  if (phaseMatch) {
    state.phaseNum   = phaseMatch[1];
    state.phaseTotal = phaseMatch[2];
    state.phaseName  = phaseMatch[3] || null;
  }
  if (!state.status) {
    const bodyStatus = content.match(/^Status:\s*(.+)/m);
    if (bodyStatus) {
      const raw = bodyStatus[1].trim().toLowerCase();
      if (raw.includes('ready to plan') || raw.includes('planning')) state.status = 'planning';
      else if (raw.includes('execut')) state.status = 'executing';
      else if (raw.includes('complet') || raw.includes('archived')) state.status = 'complete';
    }
  }
  return state;
}

function renderProgressBar(percent) {
  if (percent == null || isNaN(percent)) return '';
  const pct    = Math.max(0, Math.min(100, parseInt(percent, 10)));
  const filled = Math.floor(pct / 10);
  const bar    = '#'.repeat(filled) + '-'.repeat(10 - filled);
  return `[${bar}] ${pct}%`;
}

function formatGsdState(s) {
  const parts = [];
  if (s.milestone || s.milestoneName) {
    const ver   = s.milestone || '';
    const name  = (s.milestoneName && s.milestoneName !== 'milestone') ? s.milestoneName : '';
    const bar   = renderProgressBar(s.percent);
    const pieces = [ver, name, bar].filter(Boolean);
    if (pieces.length > 0) parts.push(pieces.join(' '));
  }
  const phasesStr = (s.nextPhases && s.nextPhases.length > 0) ? s.nextPhases.join('/') : null;
  if (s.activePhase) {
    const stage = s.status || '';
    parts.push(stage ? `Phase ${s.activePhase} ${stage}` : `Phase ${s.activePhase}`);
  } else if (s.nextAction && phasesStr) {
    parts.push(`next ${s.nextAction} ${phasesStr}`);
  } else if (
    Number(s.percent) === 100 ||
    (s.completedPhases && s.totalPhases && s.completedPhases === s.totalPhases)
  ) {
    parts.push('milestone complete');
  } else {
    if (s.status) parts.push(s.status);
    if (s.phaseNum && s.phaseTotal) {
      const phase = s.phaseName
        ? `${s.phaseName} (${s.phaseNum}/${s.phaseTotal})`
        : `ph ${s.phaseNum}/${s.phaseTotal}`;
      parts.push(phase);
    }
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Layout composer
// ---------------------------------------------------------------------------

function composeStatusline({ model, ctx = '', middle = null, dirname, lastCmdSuffix = '', position = 'end' } = {}) {
  const modelSeg = `\x1b[2m${model}\x1b[0m`;
  const dirSeg   = `\x1b[2m${dirname}\x1b[0m`;
  const pos = position === 'front' ? 'front' : 'end';
  if (pos === 'front') {
    if (middle) return `${modelSeg}${ctx} | ${middle} | ${dirSeg}${lastCmdSuffix}`;
    return `${modelSeg}${ctx} | ${dirSeg}${lastCmdSuffix}`;
  }
  if (middle) return `${modelSeg} | ${middle} | ${dirSeg}${ctx}${lastCmdSuffix}`;
  return `${modelSeg} | ${dirSeg}${ctx}${lastCmdSuffix}`;
}

// ---------------------------------------------------------------------------
// Core render (shared between direct-run and dispatcher-driven modes)
// ---------------------------------------------------------------------------

function render(input) {
  try {
    const data      = JSON.parse(input);
    const model     = data.model?.display_name || 'Claude';
    const dir       = data.workspace?.current_dir || data.cwd || process.cwd();
    const session   = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window meter — guard against non-numeric values (F-12)
    const totalCtx = data.context_window?.total_tokens || 1_000_000;
    const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
    const AUTO_COMPACT_BUFFER_PCT = acw > 0
      ? Math.min(100, (acw / totalCtx) * 100)
      : 16.5;
    let ctx = '';
    if (typeof remaining === 'number' && Number.isFinite(remaining)) {
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));
      const filled = Math.floor(used / 10);
      const bar = '#'.repeat(filled) + '-'.repeat(10 - filled);
      if (used < 50) {
        ctx = ` \x1b[32m[${bar}] ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m[${bar}] ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m[${bar}] ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m[${bar}] ${used}%\x1b[0m`;
      }
    }
    // (Context-bridge temp-file write removed — no PostToolUse consumer ships.)

    // Current task from todos
    let task = '';
    const homeDir   = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const todosDir  = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) task = inProgress.activeForm || '';
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }

    const gsdStateStr = task ? '' : formatGsdState(readGsdState(dir) || {});

    let lastCmdSuffix = '';
    let position = 'end';
    try {
      const cfg = readGsdConfig(dir);
      if (getConfigValue(cfg, 'statusline.show_last_command') === true) {
        const lastCmd = readLastSlashCommand(data.transcript_path);
        if (lastCmd) lastCmdSuffix = ` | \x1b[2mlast: /${lastCmd}\x1b[0m`;
      }
      const cfgPos = getConfigValue(cfg, 'statusline.context_position');
      if (cfgPos != null) position = cfgPos;
    } catch (e) { /* ignore */ }

    const dirname = path.basename(dir);
    const middle  = task
      ? `\x1b[1m${task}\x1b[0m`
      : gsdStateStr
        ? `\x1b[2m${gsdStateStr}\x1b[0m`
        : null;

    process.stdout.write(composeStatusline({ model, ctx, middle, dirname, lastCmdSuffix, position }));
  } catch (e) {
    // Silent fail — never break Claude Code's statusline
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function runWithInput(input) {
  render(input);
}

function runStatusline() {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    render(input);
  });
}

module.exports = { runWithInput };

if (require.main === module) runStatusline();
