'use strict';
// anti-hall :: shell-writes — the files a Bash command writes, and the text it
// writes where that text is visible in the command.
//
// The Edit-family guards judge structured edits (Claude Write/Edit/MultiEdit,
// Codex apply_patch). The same write can go through the shell instead, so
// api-guard and ship-it-guard also run on Bash (both hosts send the shell tool as
// tool_name "Bash" with tool_input.command) and get their targets from here.
// command-guard's Bash edit parity (edit-guard's verdict on Bash writes) walks the
// same parsers: bashWriteTargets, inlineWriteLiterals and resolveWriteTarget all
// live in command-guard.js, so one parser serves all three guards.
//
// Forms recognised (top level, and inside `sh -c`, eval, `$(…)`, `>(…)`, and a
// heredoc fed to a shell such as `bash <<EOF`):
//   targets  `>`, `>>`, `>|`, `&>` redirects (incl. bare `> f` truncation),
//            tee [-a], sed -i, perl -i/-pi, cp/mv destinations (mv also its
//            sources), literal open(…,'w')/writeFile(…) paths in python -c /
//            node|perl|ruby -e code.
//   content  heredoc body fed to cat/tee, echo/printf arguments, and the same
//            producers piped into tee. Everything else has content null.
// Anything else (a target with `$`, a glob, `~`, a relative path after a
// non-literal cd, dd/install/rsync/xargs, python reading a heredoc on stdin, a
// script file that writes when run, ...)
// is not reported: unknown forms FAIL OPEN.
//
// Pure apart from realpath/stat lookups; never throws (returns [] on error).

const { basename, segmentHeredocBodies } = require('./shell-scan.js');

// Cheap pre-filter: no redirect, tee, in-place editor, cp/mv or inline-code
// write means no target can come back, so a hook skips loading the parser.
const MAYBE_WRITE_RE = /[>]|\btee\b|\bsed\b|\bperl\b|\bcp\b|\bmv\b|\bopen\s*\(|File(?:Sync)?\s*\(|\.write\(/;
function mayWrite(command) {
  return typeof command === 'string' && MAYBE_WRITE_RE.test(command);
}

const ECHO_FLAG_RE = /^-[neE]+$/;
function decodeEscapes(s) {
  return s.replace(/\\(n|t|\\)/g, (m, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : '\\'));
}

// producerText(segment, bodies, cg) -> the text an echo/printf/cat-heredoc
// segment writes to stdout, or null when not visible.
function producerText(segment, bodies, cg) {
  const verb = cg.effectiveVerb(segment);
  if (verb === 'cat' || verb === 'tee') return bodies.length ? bodies[bodies.length - 1] + '\n' : null;
  if (verb !== 'echo' && verb !== 'printf') return null;
  const toks = cg.argvWithoutRedirects(segment);
  const vi = toks.findIndex((t) => basename(t).toLowerCase() === verb);
  if (vi === -1) return null;
  let args = toks.slice(vi + 1);
  if (verb === 'echo') {
    let escapes = false;
    while (args.length && ECHO_FLAG_RE.test(args[0])) { if (args[0].includes('e')) escapes = true; args = args.slice(1); }
    const text = args.join(' ');
    return (escapes || /\\n/.test(text) ? decodeEscapes(text) : text) + '\n';
  }
  if (!args.length) return null;
  // printf FORMAT [ARGS...]: the format with escapes decoded, then each argument
  // on its own line (an approximation of %s expansion; enough to see the code).
  return [decodeEscapes(args[0])].concat(args.slice(1)).join('\n') + '\n';
}

// shellWrites(command, payload) -> [{ abs, base, toplevel, inBase, scratch, content }]
// one entry per resolved target (deduped by path; content kept when any
// occurrence has it). abs/base/scratch come from command-guard's
// resolveWriteTarget, so "scratch" means exactly what Bash edit parity skips.
function shellWrites(command, payload) {
  try {
    if (!mayWrite(command)) return [];
    const cg = require('../command-guard.js');
    const rootOf = cg.projectRootResolver(payload || {});
    const byPath = new Map();
    let level = null; // per-command-level heredoc bookkeeping
    cg.forEachShellSegment(command, payload || {}, (seg, ctxs, segments, delims, i, text) => {
      if (!level || level.segments !== segments) level = { segments, per: segmentHeredocBodies(segments, text) };
      const bodies = level.per[i] || [];
      let content = null;
      const verb = cg.effectiveVerb(seg);
      if (verb === 'tee' && !bodies.length && i > 0 && delims[i - 1] === '|') {
        content = producerText(segments[i - 1], level.per[i - 1] || [], cg);
      } else {
        content = producerText(seg, bodies, cg);
      }
      for (const ctx of ctxs) {
        const targets = cg.bashWriteTargets(seg, ctx.cwd).map((t) => [t, content])
          .concat(cg.inlineWriteLiterals(seg).map((t) => [t, null]));
        for (const [t, text2] of targets) {
          const w = cg.resolveWriteTarget(t, ctx, payload || {}, rootOf);
          if (!w) continue;
          const prev = byPath.get(w.abs);
          if (!prev) byPath.set(w.abs, Object.assign(w, { content: text2 }));
          else if (prev.content === null && text2 !== null) prev.content = text2;
        }
      }
    });
    return [...byPath.values()];
  } catch (_) {
    return []; // fail open
  }
}

module.exports = { shellWrites, mayWrite };
