#!/usr/bin/env node
// statusline-monorepo.js — Claude Code statusline for monorepo projects
// (detected via .gitmodules; see statusline.js's isMonorepo()).
// GSD-state reading (.planning/STATE.md, .planning/config.json) removed
// 2026-07-03: GSD is discontinued, nothing creates those files anymore.
// No emojis. Plain ASCII separators only.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

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
        // Bold bright red (256-color) for the >=80% tier. Avoids SGR 5 (blink),
        // which is inconsistently supported across terminals and can render as
        // garbage or bleed attributes; consistent with the bold/256-color tiers above.
        ctx = ` \x1b[1;38;5;196m[${bar}] ${used}%\x1b[0m`;
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

    const dirname = path.basename(dir);
    const middle  = task ? `\x1b[1m${task}\x1b[0m` : null;

    process.stdout.write(composeStatusline({ model, ctx, middle, dirname }));
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
