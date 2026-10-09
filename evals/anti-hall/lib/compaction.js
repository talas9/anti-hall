'use strict';
// B3 forced compaction (docs/BENCHMARK-METHOD.md Amendment 3 §B3, probe P5).
// A real Claude Code compaction is the treatment boundary; a hand-written or
// model-prompted summary never substitutes for it. Methods are tried in the order the
// draft names; the first whose resulting transcript contains a `compact_boundary`
// record wins. If none works, B3 is not run (we throw, never fake it).
//
//  1. print-mode slash command: claude -p --resume <id> "/compact"
//  2. auto-compact window override: claude -p --resume <id> --autocompact <tokens> "<prompt>"
//     (`--autocompact <auto|100k-1M>` is listed in `claude --help`; that it forces a
//      compaction on a ~100k-token seed is [unverified -> P5])
//  3. tmux-driven interactive /compact, transcript copied afterwards
//
// All process work goes through the injected `runner(cmd, args, opts) -> {status, stdout, stderr}`
// so tests use a fake and no network or paid run happens.
const fs = require('fs');

const BOUNDARY_RE = /"subtype"\s*:\s*"compact_boundary"|"type"\s*:\s*"compact_boundary"/;

function hasCompactBoundary(file) {
  try { return BOUNDARY_RE.test(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
}

function forceCompaction({ runner, sessionId, cwd, transcriptPath, model = 'claude-sonnet-5', autocompactTokens = 100000, continuePrompt = 'Continue.', tmuxPoll = { tries: 30, sleepSec: 5 }, methods = ['slash', 'autocompact', 'tmux'], env, sleep }) {
  const tried = [];
  const base = ['-p', '--resume', sessionId, '--model', model];
  const attempt = {
    slash: () => runner('claude', [...base, '/compact'], { cwd, env }),
    autocompact: () => runner('claude', [...base, '--autocompact', String(autocompactTokens), continuePrompt], { cwd, env }),
    tmux: () => {
      const name = `ah-compact-${sessionId.slice(0, 8)}`;
      const t = (...a) => runner('tmux', a, { cwd, env });
      t('new-session', '-d', '-s', name, '-c', cwd, `claude --resume ${sessionId} --model ${model}`);
      (sleep || ((s) => runner('sleep', [String(s)], {})))(8);
      t('send-keys', '-t', name, '/compact', 'Enter');
      let r = { status: 1 };
      for (let i = 0; i < tmuxPoll.tries; i++) {
        (sleep || ((s) => runner('sleep', [String(s)], {})))(tmuxPoll.sleepSec);
        if (hasCompactBoundary(transcriptPath)) { r = { status: 0 }; break; }
      }
      t('kill-session', '-t', name);
      return r;
    },
  };
  for (const method of methods) {
    if (!attempt[method]) throw new Error(`unknown compaction method ${method}`);
    let r;
    try { r = attempt[method](); } catch (e) { tried.push({ method, ok: false, reason: e.message }); continue; }
    const ok = hasCompactBoundary(transcriptPath);
    tried.push({ method, ok, status: r && r.status, reason: ok ? null : 'no compact_boundary in transcript' });
    if (ok) return { method, tried, transcriptPath };
  }
  const err = new Error(`P5 failed: no compaction method produced a compact_boundary (${tried.map((x) => x.method).join(', ')}); B3 is not run`);
  err.tried = tried;
  throw err;
}

module.exports = { forceCompaction, hasCompactBoundary };
