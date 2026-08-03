#!/usr/bin/env node
// anti-hall :: edit-guard (PreToolUse Write|Edit|MultiEdit|NotebookEdit — coordinator only)
//
// WHAT IT DOES
//   Blocks direct file edits (Edit, Write, MultiEdit, NotebookEdit) when running in a
//   COORDINATOR context, requiring the model to delegate the edit to a subagent
//   instead. Silent pass-through in subagent context. Mirrors command-guard.js, but
//   for the Edit-family tools instead of Bash.
//
//   THREE EXEMPTIONS keep it from firing on legitimate orchestrator work:
//     1) PLAN MODE (payload.permission_mode === 'plan') — a read-only planning
//        session drafting docs/scratch/plan artifacts. NARROWED: source files are
//        STILL blocked in plan mode (see isPlanMode / isLikelySource / main()),
//        because plan mode is gate-based, not a toolset removal, so edit-guard
//        keeps its source-file gate as defense-in-depth.
//     2) ORCHESTRATOR-ARTIFACT ALLOWLIST — plan/state/handover/memory files the
//        coordinator owns directly (see DEFAULT_ALLOW / isAllowed). Applies in any
//        mode.
//     3) HANDOVER / COMPACT-PREP DOC EXCLUSION — a broader, name-pattern-based
//        match (HANDOVER*/*-handover*/*handoff* variants, *compact*handover*/
//        *compact*handoff*/*compact*prep*) for the coordinator's own
//        session-handover synthesis, hard-gated to '.md' basenames only so it
//        can never become a route to write code (see isHandoverDoc / main()).
//        Deliberately does NOT re-match "continue-here" — that already has its
//        own dedicated root-anchored allowlist entries (exemption 2) with their
//        own lookalike/nesting tests; CONTINUE-HERE*/.continue-here* variants
//        stay covered by exemption 2, unchanged.
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
//
// ORCHESTRATOR ARTIFACTS (why each is coordinator-owned, never a source file):
//   - 'plan.md' (lowercase): the plan file is a planning artifact, not code —
//     ship-it-guard.js treats both 'PLAN.md' and 'plan.md' as the plan; the
//     allowlist only had the uppercase form, so a Primary drafting a lowercase
//     'plan.md' was wrongly blocked. Root-anchored bare filename.
//   - '*.continue-here.md': prefixed handover variants (e.g.
//     'session.continue-here.md') are the same class as root 'CONTINUE-HERE.md'
//     — a coordinator's own synthesis of its own conversation. '.md' only and
//     root-anchored (bare pattern), so no source file qualifies.
//   - '**/.claude/projects/**/memory/**': Claude Code's per-project memory
//     store (MEMORY.md + linked notes). It lives OUTSIDE the repo cwd (under
//     ~/.claude/...), so a cwd-relative '.claude/**' glob does NOT reach it —
//     this leading-'**' pattern matches the '../…/.claude/projects/<slug>/memory/…'
//     shape. Scoped to the memory subtree only (never general source).
const DEFAULT_ALLOW = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  '.claude/**', '.omc/**', '.anti-hall/**',
  'PLAN.md', 'plan.md', 'STATE.json', 'CONTINUE-HERE.md',
  '*.continue-here.md',
  '**/.claude/projects/**/memory/**',
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
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (e) {
        if (e && e.code === 'ENOENT') return true; // first write: nothing below exists
        return false; // unexpected fs error -> fail CLOSED
      }
      if (st.isSymbolicLink()) return false;
      // HARDLINK (final path component only): a regular file with nlink > 1 has
      // another name pointing at the SAME inode elsewhere on disk. Writing
      // through this path clobbers whatever that other name is — structurally
      // the same arbitrary-overwrite bypass as the symlink case above, just
      // without a symlink for lstat to flag (found in the bypass-safety review
      // of the handover-doc exclusion below, which widens the name space
      // reachable through this check far past the original narrow allowlist).
      // Checked ONLY on the final component and ONLY for regular files:
      // intermediate directories legitimately have nlink > 1 (POSIX counts '.'
      // plus one per subdirectory), so checking them would false-positive on
      // every ordinary directory in the chain.
      if (i === chain.length - 1 && st.isFile() && st.nlink > 1) return false;
    }

    // Cross-check: the real file must live in the real directory it claims to.
    // (Belt-and-braces against a reparse point lstat did not flag; the basename
    // is not compared, so win32 true-casing cannot false-positive here.)
    return samePath(path.dirname(realpathOf(abs)), realpathOf(path.dirname(abs)));
  } catch (_) {
    return false; // fail CLOSED
  }
}

// isLikelySource(filePath) — best-effort "this is real code, not a doc/scratch/
// plan artifact" classifier. Used ONLY to NARROW the plan-mode exemption so a
// plan-mode session can draft docs/scratch/plan files but is STILL blocked from an
// undelegated write to a source file (defense-in-depth: plan mode does not hard-
// remove Write from the toolset — docs/KB-model-modes.md — so edit-guard keeps its
// source-file gate even there). Matches (1) a known code DIRECTORY anywhere in the
// path, or (2) a source-code file EXTENSION. Docs (.md/.mdx/.txt/.rst/…) are
// intentionally NOT source. Allowlisted artifacts have already exited before this
// is reached, so it only ever classifies non-allowlisted paths.
const SOURCE_DIRS = /(^|[\\/])(plugins|scripts|hooks|companion|statusline|tests)[\\/]/i;
const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|sh|go|rs|c|h|cpp|java|rb)$/i;
function isLikelySource(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  return SOURCE_DIRS.test(norm) || SOURCE_EXT.test(norm);
}

// COORDINATOR HANDOVER / COMPACT-PREP DOC EXCLUSION
// A handover/compact-prep doc is the coordinator SYNTHESIZING its OWN session
// state ahead of compaction — no subagent has seen this conversation, so
// "delegate the handover" is nonsensical (identical rationale to the existing
// CONTINUE-HERE.md / *.continue-here.md allowlist entries above, which this
// exclusion intentionally does NOT duplicate — those already have dedicated
// root-anchored handling with their own lookalike/nesting regression tests;
// re-matching "continue-here" loosely here would relax that anchoring). This
// widens the SAME idea to the common handover/handoff/compact-prep naming
// variants the exact-name allowlist entries miss (e.g.
// 'HANDOVER-2026-08-03.md', 'x-handoff.md', 'session-compact-handover.md').
//
// BYPASS-SAFETY (the entire point of this exclusion, read before touching it):
//   1) Matched by BASENAME ONLY, never a path substring — a file living under
//      a directory that happens to contain "handover" in its name (e.g.
//      'src/handover-notes/evil.js') is judged on its own filename, not the
//      path it sits in.
//   2) HARD-GATED on a literal '.md' extension. This is the anti-bypass
//      constraint: 'handover.js' / 'handoff.py' / any non-markdown file NEVER
//      qualifies, no matter how its basename reads, so this exclusion can
//      never be used to write code or config.
//   3) Still subject to the SAME symlink/hardlink-honesty check as the
//      allowlist (allowlistIsHonest, called at the use site below) — a
//      'HANDOVER.md' that is actually a symlink OR a hardlink to a real
//      source file is judged dishonest and falls through to the normal block,
//      exactly like an allowlist entry would.
//   4) CWD-CONTAINED (isWithinCwd, called at the use site below). Unlike
//      isAllowed's bare-filename patterns (which are root-anchored — no '/' in
//      the cwd-relative path), this exclusion matches by basename at ANY
//      depth, so without an explicit containment check a coordinator could
//      write 'HANDOVER.md' to an arbitrary location OUTSIDE the project
//      entirely (e.g. '../../other-project/HANDOVER.md', or an absolute path
//      under the user's home directory) — a real containment escape even
//      though the written content stays markdown. isWithinCwd rejects any
//      path that resolves outside `cwd` (found in the bypass-safety review of
//      this exclusion; see git history for the exact review that flagged it).
const HANDOVER_DOC_RE = /(handover|handoff|compact.*(?:handover|handoff|prep))/i;
function isHandoverDoc(filePath) {
  if (!filePath) return false;
  const base = basename(filePath);
  if (!/\.md$/i.test(base)) return false; // constraint (2): markdown docs ONLY
  return HANDOVER_DOC_RE.test(base);
}

// isWithinCwd(filePath, cwd) -> true when filePath resolves to somewhere UNDER
// cwd (no '../' escape, not an absolute path outside cwd). See constraint (4)
// above for why this exists. Mirrors the `inside` check already used inside
// allowlistIsHonest, kept as a small standalone predicate so it can be
// evaluated independently of the symlink walk.
function isWithinCwd(filePath, cwd) {
  try {
    const base = cwd ? String(cwd) : process.cwd();
    const abs = path.resolve(base, String(filePath));
    const rel = path.relative(base, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (_) {
    return false; // fail CLOSED
  }
}

// isPlanMode(payload) — true when the session is in Claude Code PLAN MODE.
// The harness sets `permission_mode` on the PreToolUse payload (one of
// 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
// see docs/KB-model-modes.md §on permission modes). It is a top-level,
// harness-controlled field — NOT part of tool_input and not model/tool-settable,
// so it is the same trust class as tool_name / agent_id. Case-insensitive for
// safety; any non-string is not plan mode.
function isPlanMode(payload) {
  const m = payload && payload.permission_mode;
  return typeof m === 'string' && m.toLowerCase() === 'plan';
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

  // COORDINATOR HANDOVER / COMPACT-PREP DOC EXCLUSION — see isHandoverDoc()
  // above for the exclusion's rationale and its four anti-bypass constraints
  // (basename-only match, .md-only gate, symlink/hardlink honesty, cwd
  // containment). Applies in ANY coordinator context (DevSwarm or not), same
  // as the allowlist line above and for the same reason. Runs AFTER the
  // allowlist check; requires BOTH isWithinCwd (blocks writing the doc outside
  // the project entirely) AND allowlistIsHonest (blocks a symlinked/hardlinked
  // lookalike), so neither an escape nor a lookalike can slip a real write
  // through under a handover-shaped name.
  if (isHandoverDoc(filePath) && isWithinCwd(filePath, cwd) && allowlistIsHonest(filePath, cwd)) {
    process.exit(0);
  }

  // PLAN MODE (NARROWED): a plan-mode session is doing read-only planning, so
  // drafting a doc/scratch/plan artifact is legitimate orchestrator work and the
  // guard firing there is the reported false positive (a DevSwarm Primary in plan
  // mode blocked from Writing its own plan file). But plan mode does NOT hard-remove
  // Write from the toolset — it is enforced by a system-prompt instruction + the
  // standing permission-prompt gate (docs/KB-model-modes.md) — so edit-guard KEEPS
  // its source-file gate even in plan mode: the exemption applies ONLY when the
  // target is not likely source. This closes the abuse vector where a plan-mode
  // session could otherwise slip an undelegated source write past the delegation
  // gate. Runs AFTER the allowlist check, so a symlinked allowlisted lookalike
  // (isAllowed but dishonest) has already failed to exit and, being a NON-source
  // NAME, must ALSO pass the honesty check here before plan mode can allow it —
  // otherwise the plan-mode path would reopen the symlink bypass the allowlist line
  // guards against. permission_mode is harness-set (see isPlanMode), so it cannot
  // be spoofed via tool_input.
  if (isPlanMode(payload) && !isLikelySource(filePath) && allowlistIsHonest(filePath, cwd)) {
    process.exit(0);
  }

  // DevSwarm-aware wording switch (lazy-require, mirrors this file's pattern).
  let devswarmActive = false;
  try {
    devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
  } catch (_) {
    devswarmActive = false; // fail-open: treat as standalone/dormant
  }

  // SKIP-GUARD OVERRIDE HINT (papercut fix): the block message never told the
  // agent the sanctioned override exists, and the reason title's "DEVSWARM
  // EDIT-DELEGATION RULE" mismatched the real skip key ("edit-guard"), which
  // misled agents into writing a useless "devswarm-edit-delegation" key instead.
  // Appended verbatim to ALL THREE reason branches below — the skip key is
  // ALWAYS "edit-guard" regardless of DevSwarm role/activity.
  const SKIP_HINT = ' If the user EXPLICITLY instructed you to make THIS edit ' +
    "yourself, that is the documented override — run 'node scripts/devswarm.js " +
    "skip edit-guard' to record your consent (~/.anti-hall/skip.json, 15-min " +
    'TTL), then retry. Never skip on your own initiative.';

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
         'report a tight summary.' + SKIP_HINT + ' (tool: ' + toolName + ')')
      : ('DEVSWARM EDIT-DELEGATION RULE: the primary/main orchestrator does not touch ' +
         'files directly. CHOOSE THE TIER: if this edit belongs to a workspace-scale ' +
         'MATTER (a feature/fix/deploy — multi-step, own branch, own review), spin a ' +
         'CHILD WORKSPACE and let it own the work: `node scripts/devswarm.js spawn ' +
         '<branch> -p "<brief>"` (guard-exempt, run it inline). ALTERNATIVE, only for ' +
         'genuinely small/scoped work (a one-file tweak, a mechanical transform): spawn ' +
         'a subagent to make this edit and have it report a tight summary. Do NOT hand a ' +
         'workspace-scale matter to a subagent.' + SKIP_HINT + ' (tool: ' + toolName + ')');
  } else {
    reason =
      'EDIT-DELEGATION RULE: the coordinator does not touch files directly — spawn ' +
      'a subagent to make this edit and have it report a tight summary. The ' +
      'coordinator synthesizes the summary; raw edits never happen in the main ' +
      'thread.' + SKIP_HINT + ' (tool: ' + toolName + ')';
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
