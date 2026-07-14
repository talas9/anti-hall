#!/usr/bin/env node
// anti-hall :: edit-guard (PreToolUse Write|Edit|MultiEdit|NotebookEdit — coordinator only)
//
// WHAT IT DOES
//   Blocks direct file edits (Edit, Write, MultiEdit, NotebookEdit) when running in a
//   COORDINATOR context, requiring the model to delegate the edit to a subagent
//   instead. Silent pass-through in subagent context. Mirrors command-guard.js, but
//   for the Edit-family tools instead of Bash.
//
// COORDINATOR vs SUBAGENT DETECTION
//   Shared with command-guard.js — see hooks/coordinator-detect.js for the full
//   rationale (payload agent_id/agent_type is the reliable signal; entrypoint is a
//   fallback; fail-open on ambiguity).
//
// ALLOWLIST
//   Some paths are legitimately coordinator-owned (docs the coordinator itself is
//   expected to maintain, its own state/plan files). These are always allowed,
//   matched against a default glob list plus any globs supplied via
//   ANTIHALL_EDIT_GUARD_ALLOW (split on ':' and ','). Default patterns WITH '/'
//   (directory globs like '.claude/**') match by BOTH basename and cwd-relative
//   path, as before. Default BARE-filename patterns (no '/', e.g. 'CLAUDE.md',
//   'PLAN.md', 'STATE.json', 'CONTINUE-HERE.md') are root-anchored: they match
//   ONLY a root-level file
//   (no '/' in the cwd-relative path), never a same-named file nested anywhere
//   else in the tree. Env-supplied globs are unrestricted, as before.
//
//   SYMLINK HONESTY (security): an allowlist match is by NAME, so a path is only
//   honored once it is confirmed to BE what its name claims — see
//   allowlistIsHonest(). Without that check the allowlist is an arbitrary-write
//   primitive: `ln -s hooks/command-guard.js CONTINUE-HERE.md` turns an allowed
//   name into a write-through to any file on disk.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { file_path | notebook_path, ... } }
//   stdout : JSON { decision: "block", reason: "..." } | nothing
//   exit 2 : to block (decision field); exit 0: allow
//   Fail-open on ANY error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');

// Tools this guard applies to. Anything else passes through untouched.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Default allow-globs: paths the coordinator is documented/expected to touch
// directly (its own state/plan/docs), never delegated.
// CONTINUE-HERE.md is the coordinator's own session-handover artifact — no
// subagent has seen the coordinator's conversation, so delegating it produces
// a worse handover than the coordinator writing it directly (same rationale
// as PLAN.md/STATE.json below). Bare filename => root-anchored (see isAllowed).
const DEFAULT_ALLOW = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  '.claude/**', '.omc/**', '.anti-hall/**',
  'PLAN.md', 'STATE.json', 'CONTINUE-HERE.md',
];

// Cross-platform basename: handle both / and \ path separators (mirrors
// command-guard.js's basename()).
function basename(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/');
  return parts[parts.length - 1];
}

// Normalize a path to forward slashes and, if absolute + a cwd is known, make
// it cwd-relative so a glob like '.claude/**' can match regardless of how the
// tool_input path was expressed.
function toRelPath(filePath, cwd) {
  if (!filePath) return '';
  let p = String(filePath);
  if (cwd) {
    try {
      if (path.isAbsolute(p)) p = path.relative(cwd, p);
    } catch (_) {
      // keep p as-is
    }
  }
  return p.replace(/\\/g, '/');
}

// Small self-contained glob matcher: '**' matches any sequence of characters
// (including '/'), '*' matches any sequence EXCEPT '/'. No new deps.
function escapeRegExpChar(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}
function globToRegExp(glob) {
  let src = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      src += '.*';
      i += 2;
      continue;
    }
    if (c === '*') {
      src += '[^/]*';
      i += 1;
      continue;
    }
    src += escapeRegExpChar(c);
    i += 1;
  }
  return new RegExp('^' + src + '$');
}

// isAllowed(filePath, cwd): true if filePath matches any default allow-glob or
// any glob from ANTIHALL_EDIT_GUARD_ALLOW (split on both ':' and ','). Empty
// filePath matches nothing (falls through to block).
//
// BARE-FILENAME ANCHORING: a DEFAULT_ALLOW pattern with no '/' (e.g.
// 'CLAUDE.md', 'PLAN.md', 'STATE.json') is a coordinator-owned ROOT file, not
// a filename anyone may drop anywhere in the tree. Such patterns are matched
// against the cwd-relative path AND required to have no '/' in it (i.e. the
// file must live at repo root) — matching only against the basename would
// silently allow-list e.g. 'src/deep/nested/CLAUDE.md', defeating the
// delegation gate for any nested file that happens to share a root filename.
// DEFAULT_ALLOW patterns WITH '/' (directory globs like '.claude/**') are
// unchanged: matched against both basename and cwd-relative path as before.
// Env-supplied globs (ANTIHALL_EDIT_GUARD_ALLOW) are also unchanged, so a user
// can opt back into nested matches (e.g. '**/CLAUDE.md') at any depth.
function isAllowed(filePath, cwd) {
  if (!filePath) return false;
  const base = basename(filePath);
  const rel = toRelPath(filePath, cwd);
  for (const pat of DEFAULT_ALLOW) {
    const re = globToRegExp(pat);
    if (pat.includes('/')) {
      if (re.test(base) || re.test(rel)) return true;
    } else {
      if (!rel.includes('/') && re.test(rel)) return true;
    }
  }
  const envAllow = String(process.env.ANTIHALL_EDIT_GUARD_ALLOW || '')
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pat of envAllow) {
    const re = globToRegExp(pat);
    if (re.test(base) || re.test(rel)) return true;
  }
  return false;
}

// realpathOf(p) — canonical on-disk path. On win32 prefer fs.realpathSync.native()
// (the same idiom as companion/lib/devswarm-repokey.js): the default JS realpath
// neither expands 8.3 short names nor queries the OS for true casing, so only the
// native variant canonicalizes reparse points reliably there.
function realpathOf(p) {
  const useNative = process.platform === 'win32' &&
    fs.realpathSync && typeof fs.realpathSync.native === 'function';
  return useNative ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

// samePath(a, b) — path equality, case-insensitive on win32 (NTFS is).
function samePath(a, b) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

// allowlistIsHonest(filePath, cwd) -> true when an ALLOWLIST-MATCHED path really
// is the plain file its name claims to be. isAllowed() matches a NAME; the OS
// writes to a TARGET. A symlink splits the two, so the name-match alone is an
// arbitrary-write bypass of the whole guard (a coordinator Edit on a
// 'CONTINUE-HERE.md' that is a symlink to hooks/command-guard.js writes the hook).
// This closes it for EVERY allowlist entry, not just the newest one.
//
//   - SYMLINK (the target itself, or any directory under `cwd` that the path
//     traverses) -> NOT honest: fall through to the normal block. On win32,
//     lstat reports junctions/reparse points as symbolic links too (libuv maps
//     IO_REPARSE_TAG_SYMLINK/MOUNT_POINT to S_IFLNK), so they are covered.
//   - NON-EXISTENT -> HONEST. `Write` legitimately CREATES PLAN.md / STATE.json /
//     CONTINUE-HERE.md (and their parent dirs) on first use, so ENOENT is the
//     EXPECTED case, never an error: it stops the walk and allows.
//   - ANY OTHER fs error -> NOT honest (FAIL-CLOSED). This is a security boundary:
//     blocking a coordinator write just makes it delegate, while allowing an
//     unverified one is an arbitrary write.
//
// Components ABOVE `cwd` are not walked — they are the user's environment (a
// project legitimately living under a symlinked ~/Projects or macOS /tmp is not
// an attack), and the realpath cross-check below still pins the final file to the
// directory it claims to live in.
function allowlistIsHonest(filePath, cwd) {
  try {
    const base = cwd ? String(cwd) : process.cwd();
    const abs = path.resolve(base, String(filePath));

    // Walk cwd -> target, one component at a time. Anything outside cwd (only
    // reachable via an env-supplied glob) still gets the target itself checked.
    const rel = path.relative(base, abs);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const chain = [];
    if (inside) {
      let cur = base;
      for (const seg of rel.split(path.sep)) {
        cur = path.join(cur, seg);
        chain.push(cur);
      }
    } else {
      chain.push(abs);
    }
    for (const p of chain) {
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (e) {
        if (e && e.code === 'ENOENT') return true; // first write: nothing below exists
        return false; // unexpected fs error -> fail CLOSED
      }
      if (st.isSymbolicLink()) return false;
    }

    // Cross-check: the real file must live in the real directory it claims to.
    // (Belt-and-braces against a reparse point lstat did not flag; the basename
    // is not compared, so win32 true-casing cannot false-positive here.)
    return samePath(path.dirname(realpathOf(abs)), realpathOf(path.dirname(abs)));
  } catch (_) {
    return false; // fail CLOSED
  }
}

function main() {
  // Read stdin first (fail-open on any read error).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('edit-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  // Only block in coordinator context (subagents pass through).
  const { isCoordinator } = require('./coordinator-detect.js');
  if (!isCoordinator(payload)) process.exit(0);

  const toolName = payload && payload.tool_name;
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);

  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolName === 'NotebookEdit'
    ? (toolInput.notebook_path || '')
    : (toolInput.file_path || '');
  const cwd = (payload && payload.cwd) || '';

  // An allowlist match is honored ONLY when the path is honest (not a symlink /
  // reparse point, and not reached through one) — see allowlistIsHonest().
  if (isAllowed(filePath, cwd) && allowlistIsHonest(filePath, cwd)) process.exit(0);

  // DevSwarm-aware wording switch (lazy-require, mirrors this file's pattern).
  let devswarmActive = false;
  try {
    devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
  } catch (_) {
    devswarmActive = false; // fail-open: treat as standalone/dormant
  }

  let reason;
  if (devswarmActive) {
    // Topology-aware noun: a child workspace is a sub-orchestrator, but the root
    // session is the primary/main orchestrator — the old wording hardcoded
    // "sub-orchestrator" even for the Primary. Fail-open: if devswarm-role
    // require/throws, default to the current (sub-orchestrator) wording. This only
    // changes the noun; the block decision is identical for both roles.
    let childWorkspace = true; // default to current wording on any failure
    try {
      childWorkspace = require('./lib/devswarm-role.js').isChildWorkspace(process.env);
    } catch (_) {
      childWorkspace = true; // fall back to current generic (sub-orchestrator) wording
    }
    // PRIMARY redirect names the RIGHT primitive first. The Primary's top fan-out
    // tier is a CHILD WORKSPACE (docs/KB-devswarm-hivecontrol.md §8.1-8.2); naming
    // "spawn a subagent" as the only exit at the exact point the Primary is blocked
    // from working is what drove Primaries to decompose feature-scale work into
    // subagents instead of workspaces. No mechanical scale classifier is used (a
    // false positive would break legitimate subagent use) — the reason states the
    // CHOICE and lets the model classify. The CHILD wording is unchanged, and the
    // BLOCK DECISION is identical for both roles (only the redirect text differs).
    reason = childWorkspace
      ? ('DEVSWARM EDIT-DELEGATION RULE: the sub-orchestrator does not touch files ' +
         'directly in its workspace — spawn a subagent to make this edit and have it ' +
         'report a tight summary. (tool: ' + toolName + ')')
      : ('DEVSWARM EDIT-DELEGATION RULE: the primary/main orchestrator does not touch ' +
         'files directly. CHOOSE THE TIER: if this edit belongs to a workspace-scale ' +
         'MATTER (a feature/fix/deploy — multi-step, own branch, own review), spin a ' +
         'CHILD WORKSPACE and let it own the work: `node scripts/devswarm.js spawn ' +
         '<branch> -p "<brief>"` (guard-exempt, run it inline). ALTERNATIVE, only for ' +
         'genuinely small/scoped work (a one-file tweak, a mechanical transform): spawn ' +
         'a subagent to make this edit and have it report a tight summary. Do NOT hand a ' +
         'workspace-scale matter to a subagent. (tool: ' + toolName + ')');
  } else {
    reason =
      'EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
      'a subagent to make this edit and have it report a tight summary. The ' +
      'coordinator synthesizes the summary; raw edits never happen in the main ' +
      'thread. (tool: ' + toolName + ')';
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);
