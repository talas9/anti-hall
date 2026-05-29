#!/usr/bin/env node
// statusline-simple.js — Minimal Claude Code statusline
// Shows: model | branch | dir-basename | context%
// No emojis. No project-specific fields. Never crashes on missing data.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

function gitBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: dir,
    }).trim();
  } catch (e) {
    return '';
  }
}

function runStatusline() {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);
      const model     = data.model?.display_name || 'Claude';
      const dir       = data.workspace?.current_dir || data.cwd || process.cwd();
      const remaining = data.context_window?.remaining_percentage;

      // Context %
      let ctxSeg = '';
      if (remaining != null) {
        const used = Math.max(0, Math.min(100, Math.round(100 - remaining)));
        if (used < 50) {
          ctxSeg = `\x1b[32m${used}%\x1b[0m`;
        } else if (used < 75) {
          ctxSeg = `\x1b[33m${used}%\x1b[0m`;
        } else {
          ctxSeg = `\x1b[31m${used}%\x1b[0m`;
        }
      }

      const branch  = gitBranch(dir);
      const dirname = path.basename(dir);

      const segments = [
        `\x1b[2m${model}\x1b[0m`,
        branch  ? `\x1b[34m${branch}\x1b[0m`   : null,
        dirname ? `\x1b[2m${dirname}\x1b[0m`   : null,
        ctxSeg  || null,
      ].filter(Boolean);

      process.stdout.write(segments.join(' | '));
    } catch (e) {
      // Silent fail — never break Claude Code's statusline
    }
  });
}

if (require.main === module) runStatusline();
