'use strict';
// git-alias-scan.js — git-guard's alias and reused-message checks.
//
// Two gaps the command-line scan in git-guard.js could not see:
//
//   1. Aliases. `git pf` where `alias.pf = push --force` (set in any git config
//      file) reached git-guard as subcommand `pf`, so no rule matched. Here the
//      alias is resolved at hook time (`git config --get-regexp ^alias\.`, once
//      per repo per invocation), chains of aliases are followed (cycle-guarded),
//      and the expansion is handed back to git-guard to scan as a command: a
//      plain alias as `git <value> <args>`, a `!shell` alias as `<value> <args>`.
//      Git ignores an alias that shadows a builtin, so builtins never spawn git.
//      DEFINING an alias whose body is a guarded op is blocked too, however it is
//      spelled: `git config alias.x '<body>'`, `git -c alias.x=<body>`,
//      `GIT_CONFIG_VALUE_<n>=<body>`, or a shell `alias x='<body>'`. A shell
//      function body is already scanned as plain segments; a CALL to a shell
//      alias or function defined in the same command that wraps git
//      (`g(){ git "$@"; }; g push --force`) is scanned as what it forwards.
//
//   2. Reused commit messages. A `git commit` with no -m/-F takes its message
//      from somewhere the command line does not show: `-C/-c <rev>` and
//      `--reuse-message`/`--reedit-message` reuse a commit's message, `--amend`
//      reuses HEAD's, and `-t <file>` / `commit.template` seed it from a file.
//      Those messages are read here (git log -1 / the template file) and checked
//      for an AI self-credit trailer BEFORE the commit runs. When the message is
//      reused verbatim (-C, --no-edit) it blocks outright; when an editor would
//      open it blocks only if the command sets no editor of its own (GIT_EDITOR /
//      EDITOR / VISUAL / core.editor), since an editor override may be the very
//      cleanup. Whatever the editor or a commit-msg hook writes is caught after
//      the fact by git-guard's PostToolUse `--audit`, which now also follows
//      aliases.
//
// Settings: guards.gitAliasResolve, guards.gitReusedMessageCheck (both default
// on). Fail-open on every internal error: a git that cannot be run, a repo that
// cannot be read or a timeout resolves nothing and blocks nothing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Git builtins and bundled commands. An alias with one of these names is
// ignored by git, so these subcommands never need an alias lookup (no spawn).
const GIT_BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr ' +
  'check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone ' +
  'column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index ' +
  'diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref ' +
  'for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init ' +
  'instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base ' +
  'merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects ' +
  'pack-redundant pack-refs prune prune-packed pull push range-diff read-tree rebase receive-pack reflog ' +
  'remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email ' +
  'send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace ' +
  'submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info ' +
  'upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree')
  .split(' '));

const SPAWN_TIMEOUT_MS = 1500;
const MAX_CHAIN = 10;

function settingOn(key) {
  try { return require('./settings.js').enabled('guards', key); } catch (_) { return true; }
}
let aliasOn = null;
let reuseOn = null;
function aliasEnabled() { if (aliasOn === null) aliasOn = settingOn('gitAliasResolve'); return aliasOn; }
function reuseEnabled() { if (reuseOn === null) reuseOn = settingOn('gitReusedMessageCheck'); return reuseOn; }

// The git global options that pick WHICH repository (and so which config) a
// command runs against, as argv for a spawned `git` in the same place. `-c`
// is deliberately not forwarded: inline `-c alias.*` is handled by git-guard
// itself, and forwarding arbitrary config into a spawn is a needless risk.
function repoArgs(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if ((t === '-C' || t === '--git-dir' || t === '--work-tree') && k + 1 < args.length) {
      out.push(t, args[k + 1].text); k++; continue;
    }
    if (/^--(git-dir|work-tree)=/.test(t)) { out.push(t); continue; }
    if (t === '-c' || t === '--namespace' || t === '--exec-path' || t === '--config-env') { k++; continue; }
    if (t.startsWith('-')) continue;
    break; // the subcommand
  }
  return out;
}

function spawnCwd(dir) {
  try { if (dir && fs.statSync(dir).isDirectory()) return dir; } catch (_) { /* fall through */ }
  return undefined; // the hook's own cwd
}

// One process handles one hook call, and git-guard runs gitVerdict from two
// passes (quote-aware + backstop): memoize so each query spawns git once.
const gitCache = new Map();
function git(argv, dir) {
  const key = JSON.stringify([argv, spawnCwd(dir) || '']);
  if (!gitCache.has(key)) gitCache.set(key, gitUncached(argv, dir));
  return gitCache.get(key);
}
function gitUncached(argv, dir) {
  try {
    return execFileSync('git', argv, {
      cwd: spawnCwd(dir), encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
    });
  } catch (_) {
    return null; // not a repo, no match (exit 1), timeout, git missing: resolve nothing
  }
}

// name (lower-case) -> alias value, for the repo `args`/`dir` select. Cached
// per (repo args, dir) for the life of the one hook process.
const aliasCache = new Map();
function aliasesFor(args, dir) {
  const ra = repoArgs(args);
  const key = JSON.stringify([ra, spawnCwd(dir) || '']);
  if (aliasCache.has(key)) return aliasCache.get(key);
  const map = new Map();
  const out = git(ra.concat(['config', '-z', '--get-regexp', '^alias\\.']), dir);
  if (out) {
    for (const rec of out.split('\0')) {
      const nl = rec.indexOf('\n');
      if (nl <= 0) continue;
      const name = rec.slice(0, nl).replace(/^alias\./i, '').toLowerCase();
      if (name && !map.has(name)) map.set(name, rec.slice(nl + 1));
    }
  }
  aliasCache.set(key, map);
  return map;
}

// Re-quote tokenizer tokens as shell words. A token that came from a command
// substitution keeps one, so git-guard's push-arg `$(…)` rule still sees it.
const CMDSUBST_SENTINEL = '\x00CMDSUBST\x00';
function shellWords(tokens) {
  return tokens.map((t) => {
    if (t.text.indexOf(CMDSUBST_SENTINEL) !== -1) return '"$(:)"';
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t.text)) return t.text;
    return "'" + t.text.replace(/'/g, "'\\''") + "'";
  }).join(' ');
}

function firstWord(v) {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))([\s\S]*)$/.exec(v);
  if (!m) return { word: '', tail: '' };
  return { word: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3], tail: m[4] };
}

function aliasable(sub) {
  return typeof sub === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(sub) && !GIT_BUILTINS.has(sub);
}

// Resolve `git <sub> <rest>` through the configured aliases. Returns
// { chain, verb, command } where `command` is the text git would run (a git
// command line, or the shell text of a `!` alias), or null when `sub` is not
// an alias (or the chain loops — git refuses to run a looping alias).
function expandAlias(args, sub, rest, dir) {
  if (!aliasEnabled() || !aliasable(sub)) return null;
  const map = aliasesFor(args, dir);
  if (!map.size) return null;
  let name = sub.toLowerCase();
  if (!map.has(name)) return null;
  const chain = [];
  const seen = new Set();
  let suffix = shellWords(rest); // arguments git appends after the alias body
  while (chain.length < MAX_CHAIN) {
    if (seen.has(name)) return null; // alias loop: git errors out, nothing runs
    seen.add(name);
    const v = map.get(name);
    chain.push(name);
    if (/^\s*!/.test(v)) {
      return { chain, verb: '!', command: v.replace(/^\s*!/, '') + (suffix ? ' ' + suffix : '') };
    }
    const { word, tail } = firstWord(v);
    if (aliasable(word) && map.has(word.toLowerCase())) {
      suffix = tail.trim() + (suffix ? ' ' + suffix : '');
      name = word.toLowerCase();
      continue;
    }
    const prefix = shellWords(repoArgs(args).map((w) => ({ text: w })));
    return { chain, verb: word, command: 'git ' + (prefix ? prefix + ' ' : '') + v.trim() + (suffix ? ' ' + suffix : '') };
  }
  return null;
}

// Prefix a git-guard block message's headline with where the command came from.
function annotate(msg, note) {
  return String(msg).replace(/^(\S+ anti-hall · git-guard: )/, '$1' + note + ' ');
}

// A git alias body as the command it would run.
function aliasBodyCommand(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return s.startsWith('!') ? s.slice(1) : 'git ' + s;
}

function scanBody(body, rescan, note) {
  if (!body) return null;
  const hit = rescan(body);
  return hit ? annotate(hit, note) : null;
}

// Definitions written through git: `git config [opts] alias.<n> <body>` and
// `git -c alias.<n>=<body> …`.
function gitDefinitionVerdict(args, sub, rest, rescan) {
  for (let k = 0; k + 1 < args.length; k++) {
    if (args[k].text !== '-c') continue;
    const m = /^alias\.([^=]+)=([\s\S]*)$/i.exec(args[k + 1].text);
    if (!m) continue;
    const hit = scanBody(aliasBodyCommand(m[2]), rescan, 'defining git alias `' + m[1] + '` to run a blocked command:');
    if (hit) return hit;
  }
  if (sub !== 'config') return null;
  for (let k = 0; k + 1 < rest.length; k++) {
    const m = /^alias\.(\S+)$/i.exec(rest[k].text);
    if (!m) continue;
    const hit = scanBody(aliasBodyCommand(rest[k + 1].text), rescan, 'defining git alias `' + m[1] + '` to run a blocked command:');
    if (hit) return hit;
  }
  return null;
}

// --- reused commit messages ------------------------------------------------

// Parse the message-source options of a `git commit` arg list (before `--`).
// git accepts any unambiguous prefix of a long option (`--amen`, `--reuse`).
const COMMIT_LONG = ('ahead-behind all allow-empty allow-empty-message amend author branch cleanup date dry-run ' +
  'edit file fixup gpg-sign include inter-hunk-context interactive long message no-post-rewrite no-verify null ' +
  'only patch pathspec-file-nul pathspec-from-file porcelain post-rewrite quiet reedit-message reset-author ' +
  'reuse-message short signoff squash status template trailer unified untracked-files verbose verify ' +
  'no-edit no-status no-signoff no-gpg-sign no-allow-empty no-amend').split(' ');
const COMMIT_LONG_VALUE = new Set(['author', 'date', 'message', 'file', 'reuse-message', 'reedit-message', 'fixup',
  'squash', 'trailer', 'cleanup', 'template', 'pathspec-from-file', 'unified', 'inter-hunk-context']);
function commitLong(n) {
  if (COMMIT_LONG.includes(n)) return n;
  const c = COMMIT_LONG.filter((k) => k.startsWith(n));
  return c.length === 1 ? c[0] : null;
}
const COMMIT_SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
function commitSources(rest) {
  const o = { message: false, reuse: null, reedit: false, amend: false, noEdit: false, edit: false, template: null };
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].text;
    if (t === '--') break;
    const next = () => (k + 1 < rest.length ? rest[++k].text : '');
    const long = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(t);
    if (long) {
      const n = commitLong(long[1]);
      const val = long[2] !== undefined ? long[2] : (COMMIT_LONG_VALUE.has(n) ? next() : undefined);
      if (n === 'message' || n === 'file' || n === 'fixup' || n === 'squash') o.message = true;
      else if (n === 'reuse-message') o.reuse = val;
      else if (n === 'reedit-message') { o.reuse = val; o.reedit = true; }
      else if (n === 'template') o.template = val;
      else if (n === 'amend') o.amend = true;
      else if (n === 'no-edit') o.noEdit = true;
      else if (n === 'edit') o.edit = true;
      continue;
    }
    if (!/^-[A-Za-z]/.test(t)) continue;
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (ch === 'e') { o.edit = true; continue; }
      if (ch === 'S' || ch === 'u') break; // optional value attached: the rest of the cluster is it
      if (!COMMIT_SHORT_VALUE.has(ch)) continue;
      const val = j + 1 < t.length ? t.slice(j + 1) : next();
      if (ch === 'm' || ch === 'F') o.message = true;
      else if (ch === 'C') o.reuse = val;
      else if (ch === 'c') { o.reuse = val; o.reedit = true; }
      else if (ch === 't') o.template = val;
      break;
    }
  }
  return o;
}

// Does the command set its own editor for this commit? Then an editor-path
// commit is left to the PostToolUse audit (the editor may be the cleanup) -
// unless every editor it sets is a no-op (`true`, `:`, `cat`), which leaves
// the message exactly as reused.
const EDITOR_SET_RE = /(?:^|[\s;&|(])(?:export\s+)?(?:GIT_EDITOR|EDITOR|VISUAL)=('[^']*'|"[^"]*"|\S*)|core\.editor[\s=]+('[^']*'|"[^"]*"|\S*)/gi;
const NOOP_EDITOR_RE = /^(?:\S*\/)?(?:true|:|cat)$/;
function setsRealEditor(rawCmd) {
  for (const m of String(rawCmd || '').matchAll(EDITOR_SET_RE)) {
    const v = (m[1] !== undefined ? m[1] : m[2] || '').replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (!NOOP_EDITOR_RE.test(v)) return true;
  }
  return false;
}

function readTemplate(args, dir, explicit) {
  let p = explicit;
  if (!p) {
    const out = git(repoArgs(args).concat(['config', '--path', '--get', 'commit.template']), dir);
    p = out ? out.trim() : '';
  }
  if (!p) return null;
  if (p === '~' || p.startsWith('~/')) p = path.join(require('os').homedir(), p.slice(1));
  // git resolves -t / commit.template relative to the cwd it runs in.
  const base = spawnCwd(dir) || process.cwd();
  try { return fs.readFileSync(path.resolve(base, p), 'utf8'); } catch (_) { return null; }
}

function reusedMessageVerdict(args, rest, dir, rawCmd, hasSelfCredit, gm) {
  if (!reuseEnabled()) return null;
  const o = commitSources(rest);
  if (o.message) return null; // -m / -F / --fixup / --squash: scanned (or authored) elsewhere
  let text = null;
  let origin = null;
  let verbatim = false;
  if (o.reuse && !o.reuse.startsWith('-')) { // never hand git log an option-shaped revision
    text = git(repoArgs(args).concat(['log', '-1', '--format=%B', o.reuse, '--']), dir);
    origin = 'commit `' + (/^[0-9a-f]{40,}$/i.test(o.reuse) ? o.reuse.slice(0, 12) : o.reuse) + '`';
    verbatim = !o.reedit && !o.edit;
    if (o.noEdit) verbatim = true;
  } else if (o.amend) {
    text = git(repoArgs(args).concat(['log', '-1', '--format=%B', 'HEAD', '--']), dir);
    origin = 'HEAD (`--amend` reuses it)';
    verbatim = o.noEdit;
  } else if (!o.noEdit) {
    text = readTemplate(args, dir, o.template);
    origin = 'the commit template';
  }
  if (!text || !hasSelfCredit(text)) return null;
  if (!verbatim && setsRealEditor(rawCmd)) return null; // the audit checks what the editor leaves
  return gm({
    what: 'a commit whose message is taken from ' + origin + ' and carries an AI/assistant self-credit trailer is blocked.',
    why: 'Commits carry no AI co-author credit, even when the message is reused rather than typed.',
    instead: 'commit with an explicit clean message (`-m "<msg>"` or `-F <file>`) instead of reusing that one.',
  });
}

// --- entry points (called from git-guard.js) ---------------------------------

// gitVerdict hook: alias definitions, alias use, reused commit messages.
//   rescan(cmdText, dir) -> block message | null  (git-guard's scanCommand)
function gitVerdict(o) {
  try {
    if (aliasEnabled()) {
      const def = gitDefinitionVerdict(o.args, o.sub, o.rest, (c) => o.rescan(c, o.dir));
      if (def) return def;
      if (o.depth < 3) {
        const ex = expandAlias(o.args, o.sub, o.rest, o.dir);
        if (ex) {
          const hit = o.rescan(ex.command, o.dir);
          if (hit) return annotate(hit, 'via git alias `' + ex.chain.join('` -> `') + '`:');
        }
      }
    }
    if (o.sub === 'commit') return reusedMessageVerdict(o.args, o.rest, o.dir, o.rawCmd, o.hasSelfCredit, o.gm);
  } catch (_) { /* fail open */ }
  return null;
}

// Shell aliases and functions DEFINED in this same command, name -> body, so
// a later call to the wrapper (`g(){ git "$@"; }; g push --force`, or
// `alias g=git` + `eval g …`) is scanned as the git command it forwards to.
// Additive and approximate (regex + brace matching, quotes ignored): it can
// only add a block, never remove one.
const shellDefsCache = new Map();
function unquote(v) {
  return v.replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
}
function matchingClose(text, open) {
  const want = text[open] === '{' ? '}' : ')';
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === text[open]) depth++;
    else if (text[k] === want && --depth === 0) return k;
  }
  return -1;
}
function shellDefs(rawCmd) {
  const raw = String(rawCmd || '');
  if (shellDefsCache.has(raw)) return shellDefsCache.get(raw);
  const defs = new Map();
  const aliasRe = /(?:^|[\s;&|(])alias[ \t]+([A-Za-z_][\w.-]*)=('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|]*)/g;
  for (const m of raw.matchAll(aliasRe)) defs.set(m[1], { kind: 'alias', body: unquote(m[2]) });
  const fnRe = /(?:^|[\s;&|('"`]|\bfunction[ \t]+)[ \t]*([A-Za-z_][\w.-]*)[ \t]*(?:\([ \t]*\))?[ \t\n]*([{(])/g;
  for (const m of raw.matchAll(fnRe)) {
    const open = m.index + m[0].length - 1;
    // `name {` without `()` is a function only after the `function` keyword.
    if (!/\(\s*\)\s*[{(]$/.test(m[0]) && !/\bfunction[ \t]/.test(m[0])) continue;
    const close = matchingClose(raw, open);
    if (close > open) defs.set(m[1], { kind: 'function', body: raw.slice(open + 1, close) });
  }
  shellDefsCache.set(raw, defs);
  return defs;
}

// The command a call to a same-command wrapper runs: an alias body + the call's
// arguments; a function body with "$@" / $* / $1..$9 replaced by them.
function wrapperExpansion(def, args) {
  const words = shellWords(args);
  if (def.kind === 'alias') return def.body + (words ? ' ' + words : '');
  return def.body
    .replace(/"\$[@*]"|\$[@*]|"\$\{[@*]\}"|\$\{[@*]\}/g, words)
    .replace(/"?\$\{?([1-9])\}?"?/g, (_, n) => shellWords(args.slice(Number(n) - 1, Number(n))));
}

// Segment hook: shell `alias name='<body>'`, GIT_CONFIG_VALUE_<n>=<body>, and
// calls to a wrapper alias/function defined earlier in the same command.
function shellDefinitionVerdict(tokens, ev, rescan, depth, rawCmd) {
  try {
    if (!aliasEnabled()) return null;
    if (ev.verb === 'alias') {
      for (const t of ev.args) {
        const m = /^([^=\s]+)=([\s\S]+)$/.exec(t.text);
        if (!m) continue;
        const hit = scanBody(m[2], rescan, 'defining shell alias `' + m[1] + '` to run a blocked command:');
        if (hit) return hit;
      }
    }
    for (const t of tokens) {
      if (t.quotedOnly) continue;
      const m = /^(GIT_CONFIG_VALUE_\d+)=([\s\S]+)$/.exec(t.text);
      if (!m) continue;
      const hit = scanBody(aliasBodyCommand(m[2]), rescan, 'defining a git alias via `' + m[1] + '` to run a blocked command:');
      if (hit) return hit;
    }
    if (depth < 3 && ev.args.length) {
      const def = shellDefs(rawCmd).get(ev.verb);
      if (def) { // any wrapper: it may forward to git through another one
        const hit = scanBody(wrapperExpansion(def, ev.args), rescan, 'via shell ' + def.kind + ' `' + ev.verb + '`:');
        if (hit) return hit;
      }
    }
  } catch (_) { /* fail open */ }
  return null;
}

// PostToolUse audit hook: does `git <sub>` resolve (through aliases) to a
// commit-creating verb, or to a `!shell` alias (which may commit)?
function aliasCreatesCommit(args, sub, rest, dir, commitVerbs) {
  try {
    const ex = expandAlias(args, sub, rest, dir);
    if (!ex) return false;
    return ex.verb === '!' || ex.verb.startsWith('-') || commitVerbs.has(ex.verb);
  } catch (_) { return false; }
}

module.exports = {
  gitVerdict, shellDefinitionVerdict, aliasCreatesCommit,
  // exported for tests
  expandAlias, commitSources, GIT_BUILTINS,
};
