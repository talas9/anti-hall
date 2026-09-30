#!/usr/bin/env node
// anti-hall :: git guard (PreToolUse on Bash)
//
// Mechanically enforces two commit/push rules that prose instructions never
// reliably hold:
//   1. NO self-credit in commits. Blocks `git commit` whose message contains a
//      canonical AI co-author / "Generated with <AI>" self-credit trailer,
//      whether the message arrives INLINE (-m / --message / --trailer), or via
//      `-F -` / `--file=-` / `-F /dev/stdin` fed by a heredoc on the same
//      command line, or via `-F <path>` naming a real, readable file. Commits
//      are the human's; the assistant takes no credit.
//      DESIGN NOTE: the `-F`/`--file`/heredoc scan (extractHeredocBodies /
//      fileCommitMessages below) is a strictly ADDITIVE side-channel on top of
//      the original INLINE -m/--trailer scan and the untouched splitSegments
//      force-push/verb-detection path - it can only ADD a block, never widen
//      what a legitimate command is parsed as, so it carries none of
//      splitSegments' bypass-hardening risk. It scans every heredoc body found
//      ANYWHERE in the raw command (not tied to a specific `-F -` call site -
//      simplest correct-by-construction approach, no segment/heredoc
//      correlation to get subtly wrong) whenever ANY `git commit` segment uses
//      the stdin spelling.
//      A commit-creating verb also triggers a WHOLE-command trailer scan
//      (COMMIT_CREATING / hasSelfCredit), and `--audit` (PostToolUse) flags
//      recent HEAD commits whose trailer came from off the command line (repo
//      hook, template, editor, cherry-pick) - advisory, it cannot un-commit.
//      A relative `-F <path>` is resolved against a leading
//      `cd <dir> &&`/`cd <dir> ;` segment if one precedes the commit segment in
//      the SAME command (tracked in read order across `splitSegments`' own
//      segments - not a full shell cwd emulation), else against the hook's own
//      cwd; an unresolved-or-unreadable path fails OPEN rather than guess.
//   2. NO force push. Blocks `git push --force` / `-f` / `--force-with-lease` /
//      a `+refspec`. Rewriting published history is a deliberate human action,
//      never automatic.
//
// Contract (Claude Code PreToolUse hook, matcher "Bash"):
//   stdin  : JSON { tool_input: { command: "<the bash command>" }, ... }
//   exit 0 : allow
//   exit 2 : BLOCK the command; stderr is shown to the model as the reason
//
// Everything is parsed in pure Node (no python3/jq/sed/grep - OS-agnostic,
// F-13). Only blocks on a positive match; anything it cannot parse is allowed
// (fail-open) so it never wedges unrelated work.

'use strict';

const fs = require('fs');
const path = require('path');
const { HEREDOC_RE, basename, parseHeredocAt, SHELL_VERBS } = require('./lib/shell-scan.js');

// currentSessionId — set once by main() from the PreToolUse payload's
// session_id (if present), read by consultGitGuardSelfCreditJev so its
// jev-assist.ndjson row can be grouped/filtered via `jev report --by
// session`. Safe as a module-level value: one process handles exactly one
// PreToolUse call, never concurrent invocations within a process.
let currentSessionId = null;
// currentRawCommand — the WHOLE top-level Bash command (set once by main()).
// The whole-command self-credit scan below reads it even from a nested
// eval / `bash -c` level, so `M="...trailer..."; bash -c 'git commit -m "$M"'`
// is still seen.
let currentRawCommand = '';
// launcherFsWalkBudget — a per-invocation cap (R4A1-3) on the number of
// EXPENSIVE fs-walking targetResolvesIntoLauncherDir() calls (realpathSync/
// lstatSync chains) writesLauncherDir() will spend on any one command. A
// pathological command with thousands of write-target-shaped tokens (each
// perfectly legal on its own) would otherwise perform thousands of syscalls
// in a single hook invocation. Past the cap, writesLauncherDir() still runs
// the cheap TEXTUAL checks (LAUNCHER_DIR_RE / hasAntiHallBinSegment /
// isLauncherDirRoot - pure string work, no syscalls) on every remaining
// target, it just stops resolving symlinks for them. One process handles
// exactly one PreToolUse call, so a module-level counter is safe.
let launcherFsWalkBudget = 64;

function fail_open() {
  process.exit(0);
}

function block(msg) {
  try {
    process.stderr.write(msg + '\n');
  } catch (_) { /* ignore */ }
  process.exit(2);
}

// True when a blocked command LOOKS LIKE a heredoc/echo/printf writing FILE
// CONTENT (a devswarm mailbox message, a handover/progress/history file, a
// commit-message file, or any other "cat > f <<EOF ... EOF" / "tee f <<EOF"
// / "echo ... > f" / "printf ... >> f" shape) - purely to attach a more
// useful hint to the block reason. This is NOT an exemption: the command was
// already blocked by the ordinary scan above the call site; every heredoc
// body is always scanned in full (no data exemption), so this only changes
// the wording of an already-decided block. Generalizes the narrower
// devswarm-mailbox-only check this replaced (every mailbox shape below is
// also a heredoc-into-a-file shape, so one hint now covers both).
function looksLikeFileWriteShape(cmd) {
  const hasHeredoc = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd);
  // A `>`/`>>` redirect whose target is a filename, not a fd (`2>`, `>&2`)
  // and not a comparison operator context - a plain `>`/`>>` token followed
  // by a non-empty word.
  const redirectsToFile = /(?:^|[\s;&|(])>{1,2}\s*[^\s&;|<>()0-9][^\s&;|<>()]*/.test(cmd);
  const teesToFile = /\btee\b\s+(?:-a\s+)?[^\s&;|<>()-][^\s&;|<>()]*/.test(cmd);
  if (hasHeredoc) return redirectsToFile || teesToFile;
  // No heredoc: `echo`/`printf` output explicitly redirected into a file.
  return /\b(?:echo|printf)\b/.test(cmd) && redirectsToFile;
}

// ---------------------------------------------------------------------------
// Shell-ish tokenizer. Splits a command segment into argv-style tokens,
// honoring single and double quotes (so a flag inside a quoted string is NOT a
// real flag), and dropping a trailing `# ...` comment (F-21). Returns an array
// of { text, quoted } so callers can distinguish a literal `--force` from a
// `"--force"` that lived inside a quoted commit message.
function tokenize(segment) {
  const tokens = [];
  let cur = '';
  let curHasUnquoted = false; // did any char of this token come from outside quotes?
  let started = false;
  let tokStart = -1; // index of the token's first raw char (quotes intact)
  let i = 0;
  const n = segment.length;

  function pushToken() {
    if (started) {
      tokens.push({ text: cur, quotedOnly: !curHasUnquoted, raw: segment.slice(tokStart, i) });
    }
    cur = '';
    curHasUnquoted = false;
    started = false;
    tokStart = -1;
  }

  while (i < n) {
    const c = segment[i];

    // Unquoted whitespace separates tokens.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      pushToken();
      i++;
      continue;
    }

    // Unquoted '#' starts a comment IF it is at the start of a token (i.e. it
    // begins a new word). A '#' in the middle of a word (e.g. `foo#bar`) is a
    // literal char. This matches POSIX-ish comment behavior closely enough for
    // the force-push test and avoids the F-21 `# +1 reviewer` false-block.
    if (c === '#' && !started) {
      break; // rest of the segment is a comment
    }
    if (tokStart < 0) tokStart = i;

    // A1-5 (0.117.2 follow-up): ANSI-C quoting `$'...'`. Bash decodes backslash
    // escapes INSIDE it (unlike a plain `'...'`), so `bash -c $'git push
    // --force origin main'` must yield the same payload text as `bash -c
    // "git push --force origin main"`. Left unhandled, the `$` tokenized as an
    // ordinary character glued onto the following single-quoted body
    // (`$git push --force origin main` as one token), so the recursed
    // payload's verb resolved to `$git`, never `git` - a total bypass.
    if (c === '$' && segment[i + 1] === "'") {
      started = true;
      i += 2;
      while (i < n && segment[i] !== "'") {
        if (segment[i] === '\\' && i + 1 < n) {
          const nx = segment[i + 1];
          const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          cur += Object.prototype.hasOwnProperty.call(ESC, nx) ? ESC[nx] : nx;
          i += 2;
        } else {
          cur += segment[i];
          i++;
        }
      }
      i++; // consume closing quote (or EOF)
      continue;
    }

    if (c === "'") {
      // Single quote: literal run until next single quote.
      started = true;
      i++;
      while (i < n && segment[i] !== "'") {
        cur += segment[i];
        i++;
      }
      i++; // consume closing quote (or EOF)
      continue;
    }

    if (c === '"') {
      // Double quote: run until next unescaped double quote.
      started = true;
      i++;
      while (i < n && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < n) {
          const nx = segment[i + 1];
          // Inside double quotes, bash only treats a backslash as an escape for
          // $ ` " \ and newline; before any other char (including n/r/t) the
          // backslash is LITERAL. So `"...\n..."` yields a literal `\n`, NOT a
          // newline. Preserve that literal backslash so the downstream self-credit
          // normalization (\n -> real newline) can re-expand the escaped inline
          // trailer form `git commit -m "feat: x\n\nCo-authored-by: Claude..."`.
          if (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n') {
            cur += nx;
          } else {
            cur += '\\' + nx;
          }
          i += 2;
        } else {
          cur += segment[i];
          i++;
        }
      }
      i++; // consume closing quote (or EOF)
      continue;
    }

    if (c === '\\' && i + 1 < n) {
      // Backslash escape outside quotes: take the next char literally, count as
      // unquoted content.
      started = true;
      curHasUnquoted = true;
      cur += segment[i + 1];
      i += 2;
      continue;
    }

    // Ordinary unquoted character.
    started = true;
    curHasUnquoted = true;
    cur += c;
    i++;
  }
  pushToken();

  return tokens;
}

// Split a full command line into logical segments on the shell operators
// ; & && | || , and strip subshell/grouping wrappers ( ) { }. We split on the
// raw string but only on operators that appear OUTSIDE quotes, so a `;` or `|`
// inside a quoted commit message does not create a spurious segment.
function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;

  // Sentinel injected into a segment when a command-substitution / backtick
  // boundary is dropped from inside it. The shell expands the substitution's
  // stdout into THIS segment's argv (e.g. `git push origin main $(printf %s
  // --force)` expands to `git push origin main --force`), but splitSegments
  // scans the substitution body as its own segment and would otherwise leave
  // the outer `git push` segment with no force token. The sentinel lets the
  // push handler conservatively detect "an argument is produced by an
  // un-inspectable expansion" and block, instead of fail-opening on a force
  // flag smuggled through `$( )`/backticks. Uses control chars so it can never
  // collide with real argv text.
  const CMDSUBST_SENTINEL = '\x00CMDSUBST\x00';

  function flush() {
    if (cur.trim().length) segments.push(cur);
    cur = '';
  }

  // Append the sentinel to the current (outer) segment, then flush it so the
  // substitution body is still scanned as its own segment afterwards.
  function flushWithSubst() {
    cur += ' ' + CMDSUBST_SENTINEL + ' ';
    flush();
  }

  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';

    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      // Inside double quotes bash STILL expands command substitution and
      // backticks (only single quotes suppress them). So `git push origin
      // "$(echo --force)"` and the backtick form expand to `--force` and rewrite
      // published history. The unquoted path below injects CMDSUBST_SENTINEL at a
      // `$(`/backtick boundary so the push handler conservatively blocks; we must
      // do the same here or the double-quoted form is a force-push guard bypass.
      // The escape rule comes first: a backslash-escaped `$`/backtick (`\$(`,
      // \`) is LITERAL in bash, not a substitution, so it must not trip the
      // sentinel. We append the sentinel to the current segment (it is tolerated
      // even inside a quoted token by hasCmdSubstArg, since the control-char
      // sentinel can only be parser-injected, never user data).
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      if ((c === '$' && c2 === '(') || c === '`') {
        cur += ' ' + CMDSUBST_SENTINEL + ' ';
        i += (c === '$') ? 2 : 1;
        continue;
      }
      cur += c;
      if (c === '"') inDouble = false;
      i++;
      continue;
    }

    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }

    // Backslash-newline line continuation (outside quotes): the shell removes
    // the backslash + newline and joins the two physical lines into one logical
    // command. We must NOT treat the newline as a segment break, or
    //   git push origin main \
    //     --force
    // would split into `git push origin main \` (no force) + `--force` (no verb)
    // and the force flag would never be inspected. Collapse to a single space so
    // the force/self-credit scan sees the whole logical command.
    if (c === '\\' && (c2 === '\n' || (c2 === '\r' && cmd[i + 2] === '\n'))) {
      cur += ' ';
      i += (c2 === '\r') ? 3 : 2;
      continue;
    }

    // General unquoted backslash-escape: outside quotes, a backslash makes
    // the NEXT character literal in the shell - it is never an operator
    // boundary, whatever that character is. Append both chars as-is and
    // move on. This must run before every operator check below, or an
    // escaped operator (most importantly `\>` immediately before `|`) gets
    // treated as the real thing and a segment gets split where the shell
    // would never split it (R4A1-1: `echo \>| git push --force …` kept the
    // real pipe glued into one segment via the `>|` clobber-redirect rule
    // below, orphaning `git push --force`/the trailer into a
    // non-git-looking segment that the force/self-credit scan never saw).
    if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }

    // Operators (outside quotes).
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    // `>|` / `2>|` is the clobber-redirect operator (force a write even under
    // `set -o noclobber`), NOT a pipe. A bare `|` immediately after an
    // UNESCAPED `>` is part of THIS redirect, not a control-op separator -
    // splitting here would orphan a trailing `--force`/trailer into a bogus
    // non-git segment (same P1 class as the `&>`/`2>&1` handling above). An
    // ESCAPED `\>` (odd number of backslashes immediately preceding it in
    // `cur`, per the general escape rule above) is a LITERAL `>` character,
    // not a redirect - the following `|` is then a real, unescaped pipe and
    // must still split (R4A1-1).
    if (c === '|') {
      const prev = cur.length ? cur[cur.length - 1] : '';
      let precedingBackslashes = 0;
      if (prev === '>') {
        for (let k = cur.length - 2; k >= 0 && cur[k] === '\\'; k--) precedingBackslashes++;
      }
      if (prev === '>' && precedingBackslashes % 2 === 0) { cur += c; i++; continue; }
      flush(); i++; continue;
    }
    if (c === ';') { flush(); i++; continue; }
    // `&>` / `&>>` is a redirect-BOTH operator (stdout+stderr to a file), NOT a
    // control-op separator. Keep the `&` in the current segment so the following
    // `>`/filename stays part of THIS command; splitting here would orphan a
    // trailing flag like `--force` into a bogus non-git segment (P1).
    if (c === '&' && c2 === '>') { cur += c; i++; continue; }
    // A single `&` is a background / separator control-op ONLY when it is not
    // part of a redirection. In `2>&1` / `>&2` the `&` duplicates a file
    // descriptor and is preceded by `>` (or `<`); splitting there would orphan a
    // trailing `--force` into a non-git segment and bypass the force guard (P1).
    if (c === '&') {
      const prev = cur.length ? cur[cur.length - 1] : '';
      let precedingBackslashes = 0;
      if (prev === '>' || prev === '<') {
        for (let k = cur.length - 2; k >= 0 && cur[k] === '\\'; k--) precedingBackslashes++;
      }
      // An ODD number of backslashes immediately before the `>`/`<` means THAT
      // char is escaped (a literal `>`/`<`, not a redirect) - the `&` here is
      // then a real background/separator control-op and must still split
      // (mirrors the `|` branch's parity check above; R5A1-2).
      if ((prev === '>' || prev === '<') && precedingBackslashes % 2 === 0) { cur += c; i++; continue; }
      flush(); i++; continue;
    }
    if (c === '\n') { flush(); i++; continue; }
    // Subshell / grouping / command-substitution boundaries: treat as splits so
    // `(git push --force)` and `$(...)` / `{ ...; }` bodies are scanned as their
    // own segments. We drop the bracket char itself.
    if (c === ')' || c === '{' || c === '}') { flush(); i++; continue; }
    // `(` opens a plain subshell (its own command), while `$(` and backtick open
    // a command substitution whose stdout is spliced into the SURROUNDING
    // segment's argv. For substitutions, mark the outer segment so a force flag
    // (or any arg) produced by the expansion is detected (P1: command-subst force
    // bypass). A plain `(` is a grouping boundary with no value injection.
    if (c === '(') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flushWithSubst(); i += 2; continue; }
    if (c === '`') { flushWithSubst(); i++; continue; }

    cur += c;
    i++;
  }
  flush();
  return segments;
}

// Given the tokens of one segment, find the effective command verb + its args,
// skipping leading `VAR=value` assignment prefixes and wrapper words
// (command/builtin/exec/sudo/env/nice/nohup/time/timeout). Returns { verb, args }
// where args are the tokens AFTER the verb, or null if no verb. Some wrappers are
// special: `env` may carry `VAR=value` operands and `-flags`; `timeout` requires
// a duration operand (and may take leading `-flags`/`-flag value`); `nice` may
// take `-n N` or `-N`. We skip those operands too, otherwise the operand (e.g.
// the `5` in `timeout 5`) would be mistaken for the verb and the wrapped
// `git push --force` would slip through. This catches the F-01b bypasses:
//   FOO=bar git push --force        (env-prefix)
//   command git push --force        (wrapper)
//   timeout 5 git push --force      (timeout duration operand)
//   nice -n 10 git push --force     (nice -n operand)
//   (git push --force ...)           (handled by splitSegments dropping the paren)
// A1-2 (0.117.2 follow-up): `if`/`while`/`until`/`elif` are reserved words in
// command position exactly like `then`/`do`/`else` above, so `if git push -f
// origin main; then …; fi` never resolved past the `if` verb and the git
// verdict never ran - a total bypass needing no quote desync. Reserved words
// carry no argument-position ambiguity, so adding them here cannot introduce
// a false block.
// A1-5 (0.117.2 follow-up): `coproc` runs its argument list as a command,
// exactly like `exec`/`command` - `coproc git push --force origin main` never
// resolved past the `coproc` word. Also reserved-word-shaped (no argument-
// position ambiguity), so adding it carries no false-block risk.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout', 'then', 'do', 'else', 'if', 'while', 'until', 'elif', 'coproc']);

function effectiveVerb(tokens) {
  let idx = 0;
  // Skip leading VAR=value assignments (only when the token came from unquoted
  // text - a quoted "FOO=bar" inside a message is not an assignment).
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      idx++;
      continue;
    }
    break;
  }
  // Skip wrapper words; for `env`, also skip its VAR=value operands and -flags.
  while (idx < tokens.length) {
    const t = tokens[idx];
    const word = t.text;
    if (!t.quotedOnly && WRAPPERS.has(word)) {
      idx++;
      if (word === 'sudo') {
        // sudo [-flags [value]] command...   Skip leading option flags so
        // `sudo -u deploy git push --force` resolves to `git`, not `-u`.
        // Value-taking sudo flags: -u/-g/-p/-C/-r/-t/-U/-h(host)/--user/--group/...
        const SUDO_VAL = new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-U', '-h',
          '--user', '--group', '--prompt', '--close-from', '--role', '--type',
          '--other-user', '--host']);
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          // `--` ends sudo option parsing; the next token is the command.
          if (f === '--') break;
          if (SUDO_VAL.has(f) && idx < tokens.length && !tokens[idx].quotedOnly &&
              !tokens[idx].text.startsWith('-')) {
            idx++;
          }
        }
      } else if (word === 'env') {
        // env: skip VAR=value operands and -flags.
        while (idx < tokens.length) {
          const e = tokens[idx];
          if (!e.quotedOnly && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(e.text) || e.text.startsWith('-'))) {
            idx++;
            continue;
          }
          break;
        }
      } else if (word === 'timeout') {
        // timeout [-flags [value]] DURATION command...
        // Skip leading -flags (and a value for -s/-k which take one), then skip
        // the mandatory DURATION operand (e.g. 5, 5s, 1m).
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          // -s SIGNAL / -k DURATION take a separate value when not bundled `-sX`.
          if ((f === '-s' || f === '--signal' || f === '-k' || f === '--kill-after') &&
              idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) {
            idx++;
          }
        }
        // Skip the DURATION operand if present.
        if (idx < tokens.length && !tokens[idx].quotedOnly) idx++;
      } else if (word === 'time' || word === 'command') {
        // A1-5 (0.117.2 follow-up): POSIX `time -p` / `command -p` take a
        // leading `-p` flag before the real command word. Without skipping
        // it, `-p` itself resolved as the verb (`time -p git push -f origin
        // main` -> verb '-p'), and the whole command fell through unjudged.
        if (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text === '-p') idx++;
      } else if (word === 'nice') {
        // nice [-n N | -N | --adjustment=N] command...
        while (idx < tokens.length && !tokens[idx].quotedOnly && tokens[idx].text.startsWith('-')) {
          const f = tokens[idx].text;
          idx++;
          if ((f === '-n' || f === '--adjustment') &&
              idx < tokens.length && !tokens[idx].quotedOnly && !tokens[idx].text.startsWith('-')) {
            idx++;
          }
        }
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;
  const verbTok = tokens[idx];
  // The verb must be an UNQUOTED word; a fully-quoted token is data, not a verb.
  if (verbTok.quotedOnly) return null;
  return { verb: basename(verbTok.text), args: tokens.slice(idx + 1) };
}

// basename() is imported from ./lib/shell-scan.js (shared with
// command-guard.js): cross-platform, handles both / and \ path separators and
// leading-path or `\git` forms so `/usr/bin/git` and `\git` resolve to `git`
// (F-01b).

// Within a `git ... <subcmd> ...` arg list, find the git subcommand, skipping
// git's global options (some of which take a separate value token).
const GIT_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

function gitSubcommand(args) {
  let i = 0;
  // Collect inline alias definitions from `-c alias.<name>=<value>` (and the
  // `--config-env`-less `-c` form). The value's FIRST word is the real git
  // subcommand the alias expands to, so `-c alias.p=push` maps p -> push. This
  // lets the push handler see through an inline-alias force push
  // (`git -c alias.p=push p ... --force`), which only literal `push` would miss.
  const aliasMap = new Map(); // alias name -> expanded subcommand (first word)
  const aliasBodyTokens = new Map(); // alias name -> remaining body tokens (after first word)
  // Alias-smuggling via `--config-env`: `git --config-env alias.<name>=<ENVVAR>`
  // (or `--config-env=alias.<name>=<ENVVAR>`) defines a git alias whose VALUE is
  // pulled from an environment variable at runtime. The `-c alias=` resolver above
  // cannot see that value (it lives in the env, not the command line), so the alias
  // could expand to `push --force` invisibly. Rather than try to read the env var,
  // we treat ANY `--config-env` that names an `alias.*` key as a disallowed
  // smuggling form and force a destructive verdict (synthetic `--force` push).
  // Non-alias `--config-env` keys remain allowed.
  for (let j = 0; j < args.length; j++) {
    const a = args[j].text;
    let cfgVal = null;
    if (a === '--config-env') {
      cfgVal = j + 1 < args.length ? args[j + 1].text : '';
    } else if (a.startsWith('--config-env=')) {
      cfgVal = a.slice('--config-env='.length);
    }
    if (cfgVal !== null && /^alias\./i.test(cfgVal)) {
      return { sub: 'push', rest: [{ text: '--force', quotedOnly: false }] };
    }
  }
  for (let j = 0; j + 1 < args.length; j++) {
    if (args[j].text === '-c') {
      const cfg = args[j + 1] ? args[j + 1].text : '';
      const m = /^alias\.([^=]+)=(.*)$/s.exec(cfg);
      if (m) {
        const name = m[1];
        let val = m[2].trim();
        // A `!shell` alias is arbitrary shell, not a git subcommand; leave it as
        // a sentinel so the resolver below treats the alias as non-static (and the
        // push handler conservatively force-checks it).
        const firstWord = val.startsWith('!') ? '!' : (val.split(/\s+/)[0] || '');
        if (name) {
          aliasMap.set(name, firstWord);
          // Capture the rest of the alias body so a force form baked INTO the body
          // (`-c alias.p='push --force origin main' p`) is force-checked, not just
          // flags at the call site. Tokens are shaped like the tokenizer output so
          // isForcePush can consume them.
          // Normalize before splitting: quotes, parens, braces and shell
          // separators (`;`, `&&`, `||`, `|`, `&`) are token boundaries, so a
          // flag written as `--force"`, `--force;` or `--force)` inside
          // `!sh -c "…"`, `!f() { …; }; f`, `!eval "…"` or `!(…)` reaches
          // isForcePush as a clean `--force`. For a `!shell` body a `--` is a
          // per-command option terminator of some inner command, not of the
          // push, so it is dropped rather than disarming the flag checks.
          let parts = val.split(/[\s;&|()"'{}`]+/).slice(1).filter(Boolean);
          if (firstWord === '!') parts = parts.filter(p => p !== '--');
          aliasBodyTokens.set(name, parts.map(p => ({ text: p, quotedOnly: false })));
        }
      }
    }
  }
  while (i < args.length) {
    const t = args[i];
    const w = t.text;
    // A quoted subcommand is still the subcommand: the POSIX shell strips the
    // quotes before git runs, so `git "push" ...` is byte-for-byte equivalent to
    // `git push ...`. Resolve from t.text regardless of quoting (do NOT bail to
    // sub=null, which would leave the whole command uninspected — F bypass).
    if (GIT_OPTS_WITH_VALUE.has(w)) { i += 2; continue; }
    if (w.startsWith('-')) { i += 1; continue; }
    const rest = args.slice(i + 1);
    // Resolve through an inline alias if the subcommand IS a defined alias name.
    // If it expands to `push`, report `push` so the force check runs. If it
    // expands to a `!shell` alias (sentinel '!'), report 'push' too — we cannot
    // statically know what the shell does, so conservatively force-check rather
    // than fail-open on a possible push bypass. Otherwise report the literal verb.
    if (aliasMap.has(w)) {
      const expanded = aliasMap.get(w);
      if (expanded === 'push' || expanded === '!') {
        // Prepend the alias body's remaining tokens (e.g. the `--force` in
        // `alias.p='push --force ...'`) so isForcePush sees force forms baked into
        // the alias definition, not only flags supplied at the call site.
        const body = aliasBodyTokens.get(w) || [];
        return { sub: 'push', rest: body.concat(rest) };
      }
      return { sub: expanded || w, rest };
    }
    return { sub: w, rest };
  }
  return { sub: null, rest: [] };
}

// Does this `git push` arg list carry a force flag or a force-via-+refspec?
function isForcePush(rest) {
  let endOfOptions = false; // set once a literal `--` separator is seen
  for (const t of rest) {
    const w = t.text;
    // Match flags / refspecs regardless of quoting: the POSIX shell strips quotes
    // before git runs, so `git push "--force"`, `'--force'`, `"-f"`, and
    // `origin '+main'` are byte-for-byte equivalent to their unquoted forms and
    // DO rewrite published history. Quoting only changes meaning for commit-message
    // CONTENT (a `+1`/`--force` inside an `-m` value), which is handled separately
    // in inlineCommitMessages — never in a push arg list. (F quoted-flag bypass.)
    // A bare `--` ends OPTION parsing only: a later `--force` is then a literal
    // operand, not a flag, so we stop checking force FLAGS after `--`. But the
    // `--` does NOT disarm refspec grammar: a `+<src>:<dst>` (or `+main`) operand
    // STILL force-updates the ref even after `--` (the `+` is part of the refspec
    // syntax, not an option). So after `--` we keep inspecting positional operands
    // for a leading `+` force-refspec, and only skip the force-FLAG checks below.
    if (!endOfOptions && w === '--') { endOfOptions = true; continue; }
    if (endOfOptions) {
      // Force-via-refspec still applies to operands after `--`.
      if (w.startsWith('+') && w.length > 1) return true;
      continue;
    }
    if (w === '--force' || w === '--force-with-lease') return true;
    if (w.startsWith('--force-with-lease=')) return true;
    // A1-5 (0.117.2 follow-up): `--mirror` force-updates AND DELETES every
    // remote ref to match the local mirror clone - strictly more destructive
    // than a plain `--force`, and unconditional (no refspec/flag needed).
    if (w === '--mirror') return true;
    // `--force-if-includes` / `--no-force-if-includes` is a SAFETY MODIFIER, not a
    // force flag: per git it only has effect alongside `--force-with-lease` and is
    // a no-op on its own. Treating it as force would false-block a legitimate
    // non-force push. The real force flags above already cover the cases where it
    // would matter, so it is intentionally NOT a trigger here.
    // Short flags: a standalone `-f` or a bundled short cluster containing `f`
    // (e.g. `-fv`). Exclude long flags (already handled) and value-bearing ones.
    if (/^-[a-zA-Z0-9]+$/.test(w) && w.indexOf('f') !== -1) return true;
    // Force-via-refspec: a positional arg beginning with `+` (e.g. `+main`,
    // `+refs/heads/x`) BEFORE any `--`. Comments were already stripped by the
    // tokenizer. A quoted `'+main'` still reaches git as `+main`, so it counts.
    if (w.startsWith('+') && w.length > 1) return true;
  }
  return false;
}

// Does this push arg list delete a remote ref (branch/tag)? `--delete` /
// `-d` (incl. a bundled short cluster), an empty-source refspec `:<dst>`, or
// `--prune` (deletes remote refs with no local counterpart). Owner rule: no
// data deletion, branches included, without explicit confirmation.
function isDeleteRefPush(rest) {
  let endOfOptions = false;
  for (const t of rest) {
    const w = t.text;
    if (!endOfOptions && w === '--') { endOfOptions = true; continue; }
    if (!endOfOptions) {
      if (w === '--delete' || w === '--prune') return true;
      if (/^-[a-zA-Z0-9]+$/.test(w) && w.indexOf('d') !== -1) return true;
    }
    if (w.length > 1 && w.startsWith(':')) return true;
  }
  return false;
}

// Sentinel string splitSegments injects into a segment when a command
// substitution / backtick expansion feeds argv into it. Must match the literal
// used in splitSegments.flushWithSubst().
const CMDSUBST_SENTINEL = '\x00CMDSUBST\x00';

// Does this `git push` arg list contain an argument produced by a command
// substitution / backtick expansion? Such expansions can inject `--force` (or a
// `+refspec`) that the static tokenizer can never see, so for `git push` we
// conservatively treat their presence as a potential force-flag bypass.
function hasCmdSubstArg(rest) {
  for (const t of rest) {
    // The sentinel is a control-char marker our own parser injects at a `$(` /
    // backtick boundary; it can never appear in genuine user data. Detect it
    // regardless of t.quotedOnly: bash expands command substitution inside
    // DOUBLE quotes too, so the sentinel can legitimately land in a quoted token
    // (e.g. `git push origin "$(echo --force)"`). Only single-quoted `$(...)` is
    // literal, and splitSegments never injects the sentinel for that case.
    if (t.text.indexOf(CMDSUBST_SENTINEL) !== -1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Self-credit detection on the INLINE commit message only.
//
// Canonical AI signatures (kept narrow to avoid false-blocking a human
// co-author named "Assistant" or a doc that mentions "GPT-3"):
// Anchored to the start of a line: a real `Co-authored-by:` trailer, not a
// mid-sentence mention of the phrase in prose. (A1-4 considered widening this
// anchor to "after a quote/=/\n" so it also matches a trailer sitting in its
// own quoted shell argument - e.g. `printf '...%s' "Co-Authored-By: ..." |
// git commit -F -`. That widened anchor false-blocked an UNRELATED quoted
// mention anywhere in a commit-creating command line, e.g. `git log --grep
// "Co-Authored-By: Claude" | wc -l && git commit -m "..."`. Instead, the
// stdin-source extraction below (fileCommitMessages' `-F -` path) explicitly
// pulls out the QUOTED LITERALS of the command that actually feeds that
// stdin and tests each one on its own - which the line-start anchor already
// matches correctly since each extracted literal starts its own string - so
// this regex stays exactly as originally scoped.)
// Accept BOTH the `:` and `=` separators: git's `--trailer` honors a
// `key=value` form as well as `key: value`, so `Co-Authored-By=Claude <...>`
// is a real self-credit trailer that must block exactly like the `:` form.
const SELF_CREDIT_COAUTHOR = /^[ \t]*co-authored-by[ \t]*[:=][^\n]*(claude|anthropic\.com|@openai\.com|chatgpt|gpt-[45][^a-z0-9]|gpt-[45]$|codex <|cursor <|github copilot)/im;
// Anchored to the START of a line (a real trailer/signature line), not free
// prose, so a sentence that merely MENTIONS the phrase (e.g. a changelog entry
// "docs: explain output generated with claude code") is not false-blocked. Only
// a line that begins with "Generated with <AI>" (optionally indented) is a
// self-credit signature. We also tolerate a short leading glyph prefix
// (emoji/icon + space), because Claude Code's canonical footer line is
// "<emoji> Generated with [Claude Code](...)" - the emoji is one or two
// non-space, non-letter chars before the word, so a tight allowance for them
// keeps the match anchored to a signature line without false-blocking prose.
const SELF_CREDIT_GENERATED = /^[ \t]*[^A-Za-z0-9 \t]{0,2}[ \t]*generated with \[?(claude code|claude|chatgpt|codex|copilot)\b/im;
// A bare AI-tool attribution LINK / handle in a PR or issue body (the canonical
// "🤖 Generated with [Claude Code](https://claude.com/claude-code)" footer ends
// in this link even when the "Generated with" text is reworded). Not line-
// anchored — the URL/handle is itself the signature and is implausible in prose.
const SELF_CREDIT_GH_BODY = /claude\.com\/claude-code|chatgpt\.com\/codex|<noreply@anthropic\.com>/i;

// git subcommands that WRITE a commit message. For these the WHOLE raw command
// text is scanned for a line-anchored self-credit trailer (hasSelfCredit): the
// message can reach git by routes a per-flag parser never sees - a pipe into
// `-F -`, a file written earlier in the SAME command, a shell variable, a
// `rebase -x` payload, `merge -m`. A trailer line anywhere in a command that
// creates a commit is blocked. Line-anchored regexes only (never the bare-link
// GH_BODY marker), so a mid-line mention in prose/grep stays allowed.
const COMMIT_CREATING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'commit-tree', 'tag']);

// Memoized per distinct raw-command string (R5A1-1): `hasSelfCredit` is
// called with `currentRawCommand` once per commit-creating segment (Rule 1
// below, and ghSelfCreditMessage above), and `currentRawCommand` is assigned
// exactly ONCE per process (main(), before any segment/recursion scanning
// starts) - it never changes again for the lifetime of this hook invocation,
// including across the bounded eval/`bash -c` recursion depth. Without this cache, a
// command with N commit-creating segments (e.g. `git tag a;` repeated tens
// of thousands of times) re-scans the WHOLE O(n)-length command text on
// EVERY segment, turning an O(n) command into O(n^2) work.
const selfCreditScanCache = new Map();
function hasSelfCredit(text) {
  if (!text) return false;
  const cached = selfCreditScanCache.get(text);
  if (cached !== undefined) return cached;
  const normalized = text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  let result = false;
  for (const t of [text, normalized]) {
    if (SELF_CREDIT_COAUTHOR.test(t) || SELF_CREDIT_GENERATED.test(t)) { result = true; break; }
  }
  selfCreditScanCache.set(text, result);
  return result;
}

// Self-credit signature tokens used to flag a `-c trailer.<name>.key=<value>`
// remap. `git -c trailer.ai.key=Co-Authored-By commit --trailer "ai: Claude
// <...>"` makes a custom `ai:` token EMIT a `Co-Authored-By` trailer, so the
// value scan (which only sees `ai: Claude`) never matches the canonical
// signature. We mirror the conservative `--config-env alias.*` block: if any
// `-c trailer.*.key=<value>` (or `-c trailer.*.key <value>`) names a self-credit
// signature as its emitted key, BLOCK. Non-self-credit trailer keys stay allowed.
const SELF_CREDIT_TRAILER_KEY = /^(co-authored-by|generated-with|generated with)$/i;

// Detect a `-c trailer.<name>.key=<value>` (or space-separated `-c
// trailer.<name>.key <value>`) global-config option whose <value> is a
// self-credit signature key. `args` is the full git arg list (ev.args), where
// `-c` global options precede the subcommand.
function hasSelfCreditTrailerKeyRemap(args) {
  for (let j = 0; j < args.length; j++) {
    if (args[j].text !== '-c') continue;
    const cfg = j + 1 < args.length ? args[j + 1].text : '';
    // Form A: `-c trailer.<name>.key=<value>`
    const mEq = /^trailer\.[^=]*\.key=(.*)$/is.exec(cfg);
    if (mEq) {
      if (SELF_CREDIT_TRAILER_KEY.test(mEq[1].trim())) return true;
      continue;
    }
    // Form B: `-c trailer.<name>.key <value>` (key and value in separate tokens).
    if (/^trailer\.[^=]*\.key$/i.test(cfg)) {
      const val = j + 2 < args.length ? args[j + 2].text : '';
      if (SELF_CREDIT_TRAILER_KEY.test(val.trim())) return true;
    }
  }
  return false;
}

// Extract inline commit message text from a `git commit` arg list: the values of
// -m / --message (separate token or `=value` form), repeated. We only inspect
// inline messages (F-22 limitation noted above).
function inlineCommitMessages(rest) {
  const msgs = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].text;
    if (w === '--message') {
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--message=')) {
      msgs.push(w.slice('--message='.length));
    } else if (/^-[A-Za-z]*m$/.test(w)) {
      // Short-flag CLUSTER whose final char is `m` (e.g. `-m`, `-am`, `-sm`,
      // `-asm`): the message is the NEXT token. Mirrors isForcePush's bundled
      // short-cluster handling so `git commit -am "<trailer>"` is not bypassed.
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (/^-[A-Za-z]*m./.test(w)) {
      // Inline-value cluster `-amMSG` / `-mMSG`: other short flags precede the
      // final `m`, and everything AFTER that `m` is the inline message value.
      msgs.push(w.slice(w.indexOf('m', 1) + 1));
    } else if (w === '--trailer') {
      // `git commit --trailer "Co-Authored-By: Claude <...>"` appends a trailer
      // to the message body. The value lives on the command line (unlike -F /
      // editor), so it MUST be scanned through the same SELF_CREDIT checks — an
      // AI co-author trailer slipped in this way is exactly the case rule 1 blocks.
      if (i + 1 < rest.length) { msgs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--trailer=')) {
      msgs.push(w.slice('--trailer='.length));
    }
  }
  return msgs;
}

// gh pr/issue/release create|edit|comment bodies & titles carry author-facing
// text. Block AI self-credit there exactly like a commit trailer — the repo
// mandate is that PRs and issues carry no AI attribution. Reuses the commit
// markers (which already match the "🤖 Generated with [Claude Code](...)" footer
// and Co-Authored-By trailers) plus the bare-link marker. INLINE values only:
// `--body-file` / `-F <path>` and heredoc/command-substitution bodies put the
// literal text off the command line and are a documented fail-open limitation.
const GH_BODY_FLAGS = new Set(['--body', '-b', '--title', '-t', '--notes', '-n', '--subject']);
const GH_BODY_FILE_FLAGS = new Set(['--body-file', '-F', '--notes-file']);
function ghSelfCreditMessage(args) {
  const words = args.map((a) => a.text);
  const guardedSub = words.includes('pr') || words.includes('issue') || words.includes('release');
  // `merge`: `gh pr merge --body/--subject` sets the merge/squash COMMIT message.
  const guardedAct = words.includes('create') || words.includes('edit') || words.includes('comment') || words.includes('merge');
  if (!guardedSub || !guardedAct) return null;
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (GH_BODY_FLAGS.has(w)) { if (i + 1 < args.length) { vals.push(args[i + 1].text); i++; } continue; }
    const mEq = /^(?:--body|--title|--notes|--subject)=([\s\S]*)$/.exec(w);
    if (mEq) { vals.push(mEq[1]); continue; }
    // --body-file / -F / --notes-file <path>: read a real, readable file
    // (fail-open when unreadable; `-` stdin is covered by the whole-command scan).
    let fileSpec = null;
    if (GH_BODY_FILE_FLAGS.has(w)) { if (i + 1 < args.length) { fileSpec = args[i + 1].text; i++; } }
    else { const mF = /^(?:--body-file|--notes-file)=(.*)$/.exec(w); if (mF) fileSpec = mF[1]; }
    if (fileSpec && fileSpec !== '-') {
      try { vals.push(fs.readFileSync(fileSpec, 'utf8')); } catch (_) { /* fail-open */ }
    }
  }
  if (hasSelfCredit(currentRawCommand)) vals.push(currentRawCommand);
  for (const v of vals) {
    const normalized = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    for (const text of [v, normalized]) {
      if (SELF_CREDIT_COAUTHOR.test(text) || SELF_CREDIT_GENERATED.test(text) || SELF_CREDIT_GH_BODY.test(text)) {
        return (
          'anti-hall git-guard: BLOCKED. A gh pr/issue/release body or title carries ' +
          'AI/assistant self-credit ("Generated with Claude Code" / the 🤖 footer / ' +
          'Co-Authored-By / a claude.com/claude-code link). Remove it — PRs and issues ' +
          'carry no AI attribution.'
        );
      }
    }
  }
  // JEV ADD-BLOCK (gitGuardSelfCredit, default mode "shadow" — see jev-assist.js):
  // the regexes above catch canonical trailers/footers/links but miss a
  // PARAPHRASED self-credit ("written with help from Claude", "AI-assisted
  // commit"). Consulted ONLY when a body/title value was actually present AND
  // the regex scan above found nothing (baseline=false — trust 'add-block'
  // means this can only ADD a block, never relax the regex verdict, which
  // already returned above when it fired). Any Jev failure/timeout/low
  // confidence -> baseline (unblocked), matching every other jev-assist caller.
  for (const v of vals) {
    if (v && consultGitGuardSelfCreditJev(v)) {
      return (
        'anti-hall git-guard: BLOCKED. A gh pr/issue/release body or title appears to ' +
        'credit an AI assistant (paraphrased self-credit, flagged by the Jev ' +
        'classifier — not a literal trailer/footer match). Remove it — PRs and issues ' +
        'carry no AI attribution.'
      );
    }
  }
  return null;
}

// consultGitGuardSelfCreditJevMemo / JEV_CONSULT_CAP (R6REV-P1-1): jev-assist's
// own cache is keyed by content hash and lives on DISK, so within a single
// hook invocation a repeated identical text still spawned a fresh
// jev-assist-worker.js subprocess for every commit-creating segment (a
// timeout/no-key miss is never written to the disk cache - see
// jev-assist.js's `ask()`/`askSync()` doc comment - so a command with N
// distinct-looking but identically-empty-key segments re-asked N times). A
// command with 500 commit-creating segments each carrying a Jev consult took
// ~12s (over PreToolUse's ~10s hook timeout). Two guards, mirroring
// `selfCreditScanCache` above:
//  1. an in-process memo keyed by the EXACT consulted text, so this hook
//     process only ever asks Jev once per distinct text;
//  2. a hard cap on the number of DISTINCT texts this invocation will ever
//     spawn a subprocess for — past the cap, fail OPEN to the regex/baseline
//     verdict (`false`), same as every other Jev-absent degrade path. This
//     never blocks on Jev's absence beyond what the regex scan already
//     decided.
const JEV_CONSULT_CAP = 8;
const consultGitGuardSelfCreditJevMemo = new Map();

// jevSpentMs / JEV_TOTAL_BUDGET_MS (R7A1-1): JEV_CONSULT_CAP bounds the
// NUMBER of distinct-text consults, but not their TOTAL wall time. Each
// consult's own budgetMs (1500) plus askSync's hard backstop (+500) means a
// single hanging consult can take up to 2s; with a key configured and a
// hanging gateway, 8 distinct texts can run ~12s — over PreToolUse's 10s hook
// timeout (hooks.json), so the hook itself gets killed and this guard's
// force-push block never fires. jevSpentMs is a module-level running total of
// measured consult time for THIS process; before spawning another consult, if
// the already-spent time plus this consult's worst case (budgetMs + 500)
// would exceed JEV_TOTAL_BUDGET_MS, skip the consult entirely and fall back
// to `false` (baseline regex verdict) — same fail-open contract as every
// other Jev-absent path, and it never relaxes a regex block that already
// fired above.
let jevSpentMs = 0;
const JEV_TOTAL_BUDGET_MS = 4000;

// consultGitGuardSelfCreditJev(text) -> true when Jev, running "on", confidently
// judges `text` to contain paraphrased AI self-credit. Trust 'add-block' /
// baseline `false`: this function's result can only ever ADD a block on top of
// a regex miss, never relax one (git-guard's own non-negotiable rule — see
// CLAUDE.md "NEVER relax" for this guard). askSync spawns the actual network
// call in a subprocess with its own hard timeout so this hook's fully
// synchronous main() never blocks past its own PreToolUse budget; jev-assist's
// own content-hash cache means a repeated identical message is never re-asked
// ACROSS processes, and the memo/cap above bound repeats WITHIN this one.
function consultGitGuardSelfCreditJev(text) {
  const key = String(text);
  if (consultGitGuardSelfCreditJevMemo.has(key)) return consultGitGuardSelfCreditJevMemo.get(key);
  if (consultGitGuardSelfCreditJevMemo.size >= JEV_CONSULT_CAP) return false;
  const CONSULT_BUDGET_MS = 1500;
  // Total-time guard (R7A1-1): a hanging gateway can push each consult to its
  // full budgetMs+500 backstop; bail before spawning if the running total
  // would blow past JEV_TOTAL_BUDGET_MS, well under PreToolUse's 10s timeout.
  if (jevSpentMs + CONSULT_BUDGET_MS + 500 > JEV_TOTAL_BUDGET_MS) return false;
  const consultStart = Date.now();
  try {
    const { askSync } = require('./lib/jev-assist.js');
    const result = askSync({
      id: 'gitGuardSelfCredit',
      question: {
        type: 'noul',
        instructions: 'Does this commit message, or PR/issue/release body or title, ' +
          'credit an AI assistant as an author, co-author, or contributor — even ' +
          'paraphrased or indirect (e.g. "written with help from Claude", ' +
          '"AI-assisted commit", "co-written by an assistant") — NOT a canonical ' +
          'trailer/footer/link (those are already caught by regex and never reach ' +
          'this question)?',
        criteria: {
          true: 'credits an AI assistant as author/co-author/contributor, in any phrasing',
          false: 'no AI self-credit of any kind',
        },
      },
      state: String(text).slice(0, 4000),
      trust: 'add-block',
      baseline: false,
      budgetMs: CONSULT_BUDGET_MS,
      sessionId: currentSessionId || undefined,
    });
    const verdict = result.final === true;
    consultGitGuardSelfCreditJevMemo.set(key, verdict);
    return verdict;
  } catch (_) {
    consultGitGuardSelfCreditJevMemo.set(key, false);
    return false;
  } finally {
    jevSpentMs += Date.now() - consultStart;
  }
}

// Extract the payload of an `eval <payload>` segment as a COMMAND string to be
// re-parsed for git force/trailer detection. `eval` runs its argument(s) as a
// shell command, so `eval "git push -f"` would otherwise bypass the guard (eval
// is not a recognized wrapper). We collect every token AFTER the `eval` verb,
// honoring quotes so a quoted payload stays whole, strip the quote delimiters so
// the payload is the raw command text, and join with spaces. Returns '' if the
// segment's effective verb is not `eval` or there is no payload.
function extractEvalPayload(segment) {
  const tokens = tokenize(segment);
  const ev = effectiveVerb(tokens);
  if (!ev || ev.verb !== 'eval') return '';
  // ev.args are the tokens AFTER the eval verb. Re-join their (quote-stripped)
  // text into a single command string for re-parsing.
  const parts = ev.args.map(t => t.text).filter(s => s.length);
  return parts.join(' ');
}

// SHELL_VERBS is imported from ./lib/shell-scan.js (shared with
// command-guard.js): shell interpreters whose `-c "<payload>"` argument is
// itself a shell command. A `bash -c "git push --force"` wrapper's effective
// verb is `bash`, not `git`, so without recursing the payload the git
// force/self-credit rules never run and the wrapper is a TOTAL guard bypass
// (P0-1).

// If a segment is `bash -c '<payload>'` (or sh/zsh/dash/ksh/ash -c "...",
// including bundled forms like `bash -lc "..."` and `--command`), return the
// payload command string to be re-parsed, else ''. Reuses the tokenizer +
// effectiveVerb so wrappers (`sudo bash -c ...`) resolve correctly. Mirrors the
// proven extractShellCPayload in command-guard.js.
function extractShellCPayload(segment) {
  const tokens = tokenize(segment);
  const ev = effectiveVerb(tokens);
  if (!ev || !SHELL_VERBS.has(ev.verb.toLowerCase())) return '';
  const args = ev.args;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    // The `-c` flag (or `--command`, or a bundled short cluster ending in `c`
    // such as `-lc` / `-xc`) carries the payload in the NEXT token.
    if (t === '-c' || t === '--command' || /^-[a-z]*c$/.test(t)) {
      return i + 1 < args.length ? args[i + 1].text : '';
    }
    // A1-5 (0.117.2 follow-up): a here-string (`bash <<< "payload"`) feeds
    // payload to the shell's stdin as its script - the SAME total bypass
    // shape as `-c "payload"` (bash reads and runs it as a command list; a
    // literal here-string is tokenized as its own `<<<` token followed by the
    // string, since splitSegments does not treat `<<<` as a cut point).
    if (t === '<<<') {
      return i + 1 < args.length ? args[i + 1].text : '';
    }
  }
  return '';
}

// A1-5 (0.117.2 follow-up): `env -S STRING` (or `--split-string[=STRING]`)
// tells env to word-split STRING and run the result as a NEW command -
// effectively a `sh -c` in disguise. Left unhandled, effectiveVerb's `env`
// branch skips ANY `-`-prefixed token (including `-S`) as an env flag, then
// treats the quoted STRING itself as the next "command word" - which is
// fully quoted, so effectiveVerb returns null and the whole command goes
// unjudged (a total bypass, not just a wrong verb). Returns the STRING
// payload, or '' if this segment is not an `env -S`/`--split-string` form.
function extractEnvSPayload(segment) {
  const tokens = tokenize(segment);
  let idx = 0;
  while (idx < tokens.length && !tokens[idx].quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx].text)) idx++;
  if (idx >= tokens.length || tokens[idx].quotedOnly || tokens[idx].text !== 'env') return '';
  idx++;
  while (idx < tokens.length) {
    const t = tokens[idx];
    const w = t.quotedOnly ? '' : t.text;
    if (w === '-S' || w === '--split-string') {
      return idx + 1 < tokens.length ? tokens[idx + 1].text : '';
    }
    if (w.startsWith('--split-string=')) return w.slice('--split-string='.length);
    if (w && (w.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) { idx++; continue; }
    break; // env's real command word (not an -S form) - nothing to unwrap here
  }
  return '';
}

// A1-5 (0.117.2 follow-up): `xargs`' own leading flags, mapped to whether they
// consume a separate value token. Anything else starting with `-` (e.g. `-0`,
// `-r`, `-t`, `-x`, `-p`, `-o`) is value-less.
const XARGS_VAL_FLAGS = new Set([
  '-I', '-i', '-L', '-l', '-n', '-P', '-s', '-a', '-d', '-E',
  '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars',
  '--arg-file', '--delimiter', '--eof',
]);

// Skip xargs' OWN leading flags (and their values) and return the token list
// for the COMMAND xargs will run (e.g. `git push origin main` in `xargs -0
// git push origin main`).
function xargsCommandTokens(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (t.quotedOnly) break;
    const w = t.text;
    if (w === '--') { i++; break; }
    if (!w.startsWith('-')) break;
    i++;
    if (XARGS_VAL_FLAGS.has(w) && i < args.length && !args[i].quotedOnly && !args[i].text.startsWith('-')) i++;
  }
  return args.slice(i);
}

// A1-5 (0.117.2 follow-up): xargs appends words it reads from STDIN as
// trailing arguments to the command it runs (unless `-I`/`-i` places them
// elsewhere) - a hidden `-f`/`--force` can ride in on stdin that the static
// tokenizer can never see. So ANY `xargs`-run `git push` is treated
// conservatively as a force push, regardless of whether the visible argv
// already carries one; other xargs-run git subcommands still get the normal
// gitVerdict rules (self-credit, command-substitution args, etc).
function xargsGitVerdict(ev, d, cmd, heredocBodies, cwd, useJev) {
  const cmdTokens = xargsCommandTokens(ev.args);
  if (!cmdTokens.length) return null;
  const innerEv = effectiveVerb(cmdTokens);
  if (!innerEv || innerEv.verb !== 'git') return null;
  const { sub } = gitSubcommand(innerEv.args);
  if (sub === 'push') {
    return (
      'anti-hall git-guard: BLOCKED. Force push detected via `xargs git push` - ' +
      'xargs appends words it reads from stdin to the command it runs, so the ' +
      'full argv (and any hidden --force/-f) cannot be verified statically. Run ' +
      '`git push` directly, with explicit arguments, instead of through xargs.'
    );
  }
  return gitVerdict(innerEv, d, cmd, heredocBodies, cwd, useJev);
}

// A1-5 (0.117.2 follow-up): a literal `echo "TEXT" | bash` (or printf; bash/
// sh/zsh/dash/ksh/ash) pipes TEXT straight into a shell interpreter's stdin as
// its script - the same total bypass shape as `bash -c "TEXT"`. Matches only
// the narrow, unambiguous shape: a single QUOTED echo/printf argument, a real
// `|`, then a BARE shell verb with nothing else after it (a shell verb
// followed by more - `-c ...`, a script path - already reads its command from
// there instead of stdin, and is unrelated). No nested/ambiguous quantifiers
// (the `(?!\1)` backreference gate is O(1) per character), so this cannot
// blow up on adversarial input.
const PIPED_ECHO_SHELL_RE =
  /(?:^|[;&\n]|\()\s*(?:echo|printf)\s+(['"])((?:(?!\1)[\s\S])*)\1\s*\|\s*(?:bash|sh|zsh|dash|ksh|ash)\s*(?=$|[;&\n)])/g;

function pipedEchoShellPayloads(cmd) {
  const out = [];
  let m;
  PIPED_ECHO_SHELL_RE.lastIndex = 0;
  while ((m = PIPED_ECHO_SHELL_RE.exec(cmd))) out.push(m[2]);
  return out;
}

// Extract `-F <spec>` / `--file[=<spec>]` specs from a `git commit` arg list
// (repeated). `spec` is the raw value as given: '-' / '/dev/stdin' means "read
// the message from stdin" (resolved by the caller against extractHeredocBodies
// output); anything else is a file path (resolved by the caller). Purely
// additive: a NEW extraction, does not alter inlineCommitMessages or how any
// existing -m/--trailer form is scanned.
function fileCommitMessages(rest) {
  const specs = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].text;
    if (w === '--file') {
      if (i + 1 < rest.length) { specs.push(rest[i + 1].text); i++; }
    } else if (w.startsWith('--file=')) {
      specs.push(w.slice('--file='.length));
    } else if (/^-[A-Za-z]*F$/.test(w)) {
      // Short-flag cluster whose final char is `F` (e.g. `-F`, `-qF`): the
      // spec is the NEXT token. Mirrors inlineCommitMessages' `-m` handling.
      if (i + 1 < rest.length) { specs.push(rest[i + 1].text); i++; }
    } else if (/^-[A-Za-z]*F./.test(w)) {
      // Inline-value cluster `-qFspec`: everything after the final `F` is the
      // spec value.
      specs.push(w.slice(w.indexOf('F', 1) + 1));
    }
  }
  return specs;
}

// Heredoc opener regex (mirrors command-guard.js's HEREDOC_RE): <<[-]WORD,
// <<'WORD', <<"WORD", <<WORD. Captures the dash (tab-stripping mode) and the
// terminator word (quoted or bare). HEREDOC_RE/parseHeredocAt are imported
// from ./lib/shell-scan.js (shared with command-guard.js) — this file's own
// use of parseHeredocAt below is the low-level heredoc-construct parser ONLY;
// the SIDE-CHANNEL SCAN STRATEGY around it (see next comment) is unchanged
// and NOT shared, per the P0 lesson below.

// Extract every heredoc BODY appearing anywhere in the raw command string, as
// a standalone SIDE-CHANNEL scan over the raw text. This is intentionally
// SEPARATE from splitSegments and does not change segmentation, force-push
// detection, or inline -m/--trailer scanning in any way (P0 regression fix:
// an earlier version folded heredoc-consumption INTO splitSegments itself and
// that changed how the opener line's trailing `&&`/`;`/`|`/`|&` control
// operators were parsed, silently swallowing a chained `git push --force`
// into the heredoc-opener's own segment - a guard bypass. splitSegments here
// is byte-identical to the base/original implementation).
// Quote-tracks the raw string so a `<<` inside a quoted string is not
// mistaken for a real heredoc opener. Per real shell behavior, an
// UNTERMINATED heredoc's body is the REST of the command (bash keeps reading
// looking for the terminator until EOF), so we do the same rather than guess
// a boundary - this only makes the additive commit-message scan see MORE
// text, never less.
function extractHeredocBodies(cmd) {
  const bodies = [];
  const n = cmd.length;
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';

    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && c2) { i += 2; continue; }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }

    if (c === '<' && c2 === '<') {
      const parsed = parseHeredocAt(cmd, i);
      if (parsed) {
        bodies.push({ word: parsed.word, quoted: parsed.quoted, body: parsed.body });
        i = parsed.end;
        if (!parsed.terminated) break; // consumed the rest of the command as body
        continue;
      }
    }

    i++;
  }
  return bodies;
}

// A1-4: every single/double-QUOTED string literal appearing anywhere in the
// raw command, as its own standalone candidate. Used ONLY as an additional
// stdin-body source for `-F -`/`--file=-`/`-F /dev/stdin` below (see that
// call site) — a producer piped into that stdin can carry the message as a
// SEPARATE quoted argument with no heredoc and no real/`\n`-escaped newline
// directly before it (`printf '...%s' "Co-Authored-By: Claude <...>" | git
// commit -F -`). Each returned literal is its own string, so testing it with
// the existing line-start-anchored SELF_CREDIT_* regexes already matches
// correctly (its content starts a fresh string) without widening those
// regexes' anchor globally — which would false-block an unrelated quoted
// mention elsewhere on the same command line (e.g. `git log --grep
// "Co-Authored-By: Claude"`). Deliberately naive (no escape handling): it can
// only ADD more scanned text, never remove or reinterpret an existing scan.
function extractQuotedLiterals(cmd) {
  const out = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, i + 1);
      if (j < 0) break;
      out.push(cmd.slice(i + 1, j));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

// A1-6 (0.117.2 follow-up, perf): gitVerdict's `-F -`/`--file=-` branch below
// calls extractQuotedLiterals(cmd) with the SAME, unchanged `cmd` (the full
// raw command string) on EVERY `git commit -F -` segment it is invoked for.
// extractQuotedLiterals is itself only O(cmd.length), but a command built of
// N such segments concatenated is O(N) segments over an O(N)-length cmd, so
// calling it unmemoized per segment made the whole scan O(N^2) - 20000
// segments took ~13s, over the hook's 10s timeout (fail-open on a trailing
// force push it never reached). A single-slot cache keyed on referential/
// value equality of `cmd` computes it once per distinct command string; a
// different `cmd` (nested eval/bash -c/xargs/etc. payload, or the next hook
// invocation) simply recomputes and overwrites the slot.
let quotedLiteralsCache = null; // { cmd, result } | null
function extractQuotedLiteralsCached(cmd) {
  if (quotedLiteralsCache && quotedLiteralsCache.cmd === cmd) return quotedLiteralsCache.result;
  const result = extractQuotedLiterals(cmd);
  quotedLiteralsCache = { cmd, result };
  return result;
}

// A1-4 (0.118.0 follow-up, perf): the `-F -`/`--file=-` branch below rebuilds
// AND joins the full heredoc-body + quoted-literal candidate text from
// scratch on EVERY such segment in a command. extractQuotedLiteralsCached
// above memoizes only the literal ARRAY, not this join - so a command built
// of N `-F -` segments (e.g. `git commit -F - <<<'m'; ` repeated 20000x) still
// paid an O(cmd.length) array build + join N times (O(N^2) overall), the same
// class of timeout this file's other per-cmd caches (quotedLiteralsCache,
// hasSelfCredit memoization) already exist to prevent. A single-slot cache,
// keyed the same way, computes the JOINED text once per distinct `cmd`.
let stdinCandidateTextCache = null; // { cmd, heredocBodies, text, hasSelfCredit } | null
function stdinCandidateTextCached(cmd, heredocBodies) {
  if (stdinCandidateTextCache && stdinCandidateTextCache.cmd === cmd &&
    stdinCandidateTextCache.heredocBodies === heredocBodies) {
    return stdinCandidateTextCache;
  }
  const candidates = [];
  if (heredocBodies.length) candidates.push(...heredocBodies.map((h) => h.body));
  candidates.push(...extractQuotedLiteralsCached(cmd));
  const text = candidates.length ? candidates.join('\n') : null;
  // The literal-trailer regex test is itself O(text.length); with `text`
  // memoized identical across every `-F -`/`--file=-` segment of the SAME
  // cmd, re-running the two SELF_CREDIT_* regexes on every segment would
  // still be the O(N^2) this cache exists to close (20000 segments x an
  // O(N)-length joined text). Cache the boolean verdict alongside the text.
  const hasSelfCredit = text !== null && (SELF_CREDIT_COAUTHOR.test(text) || SELF_CREDIT_GENERATED.test(text));
  stdinCandidateTextCache = { cmd, heredocBodies, text, hasSelfCredit };
  return stdinCandidateTextCache;
}

// A devswarm mailbox message written via a Bash heredoc gets NO exemption:
// every heredoc body is always scanned in full, exactly like any other
// command text (an earlier "exact-shape" allowlist for this one legitimate
// shape - writing a message file, then sending it with the anti-hall
// launcher - was removed after review found its temp-path/target checks were
// literal-string-only and bypassable via a planted symlink; see
// looksLikeFileWriteShape() near block() for the resulting block-reason
// hint). The correct way to send a message is to write the file with the
// Write tool (not a Bash heredoc), then run `devswarm.js send --message-file
// <path>` as its own, unrelated-body command.
function safeHomedir() {
  try {
    // resolveHome() (companion/lib/test-home-guard.js) is the canonical home-
    // directory fallback every shared helper uses - byte-identical in
    // production, but refuses under `node --test` if it would resolve to the
    // REAL developer home instead of an isolated fixture.
    return require('../companion/lib/test-home-guard.js').resolveHome() || '';
  } catch (_) {
    return '';
  }
}

function expandTildePath(p, home) {
  if (p === '~') return home || p;
  if (p.startsWith('~/')) return home ? home.replace(/[\\/]+$/, '') + '/' + p.slice(2) : p;
  return p;
}

// Command-valued config/env. Git runs some config and env VALUES as commands:
// core.pager / GIT_PAGER, core.fsmonitor, diff.external / GIT_EXTERNAL_DIFF,
// core.sshCommand / GIT_SSH_COMMAND, a `!` alias. A force push written as such
// a value never sits at a command position, so the segment scan cannot see
// it. scanCommandValue re-scans a value as a command, and as a git alias body
// (`git <value>`), with any leading `!` stripped. A value shaped `key=value`
// (GIT_CONFIG_PARAMETERS) is also scanned by its inner value. Only values that
// mention `push` are re-scanned, so ordinary values cost nothing.
function scanCommandValue(v, d) {
  if (d >= 3 || !/push/.test(v)) return null;
  const s = v.trim();
  const cands = [s];
  const kv = /^'?[A-Za-z_][\w.-]*=([\s\S]*?)'?$/.exec(s);
  if (kv) cands.push(kv[1].trim());
  for (const c of cands) {
    const cmd = c.replace(/^!/, '');
    const hit = scanCommand(cmd, d + 1) || scanCommand('git ' + cmd, d + 1);
    if (hit) return hit;
  }
  return null;
}

// `key = value` lines in text written to a file (heredoc body, echo/printf
// args). Any target counts: a config file can be .git/config, ~/.gitconfig,
// $GIT_CONFIG or an includeIf target, so the value is checked, not the path.
// An optional leading `[section]` covers the one-line `[core] pager = …` form.
const CONFIG_LINE_RE = /^[ \t]*(?:\[[^\]\n]*\][ \t]*)?[A-Za-z][\w.-]*[ \t]*=[ \t]*(.+)$/gm;

function scanConfigLines(text, d) {
  for (const m of text.matchAll(CONFIG_LINE_RE)) {
    const hit = scanCommandValue(m[1], d);
    if (hit) return hit;
  }
  return null;
}

// ~/.anti-hall/bin/ holds the stable launchers anti-hall installs itself
// (update / doctor --repair write them from Node, never via a Bash command). A
// Bash command that writes there could replace a trusted launcher with code
// that force-pushes, so any write into that directory is blocked outright.
// Write targets: a `>`/`>>` redirect, tee operands, the destination of
// cp/mv/install/ln/rsync, dd `of=`, and sed/perl `-i` operands. A relative
// target is joined to the last literal `cd <dir>` of the same command.
const LAUNCHER_DIR_RE = /\.anti-hall[\\/]+bin(?:[\\/]|$)/i;
const COPY_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'ditto']);

// Normalize `raw` (tilde-expanded, joined to `cdDir` when relative) WITHOUT
// requiring the result to be absolute, so it stays usable for a bare
// relative target with no cd context. Still collapses
// `.`/`..` via path.posix.normalize, so `.anti-hall/./bin/x`,
// `.anti-hall//bin`, and `foo/../.anti-hall/bin/x` all normalize to the same
// segments a plain `.anti-hall/bin/x` would (A1-1).
function normalizeGuardPath(raw, cdDir) {
  if (typeof raw !== 'string' || !raw) return '';
  const home = safeHomedir();
  let base = expandTildePath(raw.replace(/\\/g, '/'), home);
  if (!base.startsWith('/') && cdDir) {
    const dir = expandTildePath(String(cdDir).replace(/\\/g, '/'), home);
    base = dir.replace(/\/+$/, '') + '/' + base;
  }
  return path.posix.normalize(base);
}

// True when the normalized (already-absolute-or-not) path has a
// `.anti-hall/bin` segment pair anywhere in it (case-insensitive).
//
// R4A1-2/R4C1-1: this used to ALSO treat a path whose LAST segment is plain
// `.anti-hall` (no `bin`) as a launcher-dir hit, unanchored to $HOME. That
// caught `mv ~/.anti-hall ~/.x`, but it also caught any ORDINARY project- or
// home-relative use of a `.anti-hall` directory that has nothing to do with
// the launcher - `cp notes.md .anti-hall/`, `mv f .anti-hall/`, `mv
// .anti-hall .anti-hall.bak`, `rsync -a src/ .anti-hall/` in a project, and
// `cp /tmp/skip.json ~/.anti-hall/` were all false-blocked (0.116 allowed
// them). The unanchored last-segment clause is dropped; the narrower,
// anchored-to-$HOME "IS the launcher container itself" check now lives in
// isLauncherDirRoot() below and is only consulted for the specific write
// shapes that relocate/replace that container wholesale (an mv SOURCE, an rm
// target, or a copy/move DESTINATION joined with the source's basename).
function pathHasLauncherSegment(normalized) {
  if (!normalized) return false;
  const segs = normalized.split('/').filter(Boolean).map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.anti-hall' && segs[i + 1] === 'bin') return true;
  }
  return false;
}

// True when `normalized` resolves EXACTLY to <home>/.anti-hall - the
// launcher dir's CONTAINER itself, anchored to the real home (safeHomedir/
// resolveHome, the same source of truth edit-guard's
// resolvesIntoLauncherBinDir uses) so a project-local `.anti-hall/` (or a
// non-home `.anti-hall` anywhere else) is never mistaken for it. Used ONLY
// as an mv/rename SOURCE, an rm target, or paired with a source's basename
// for a copy/move DESTINATION - never as a blanket "any path under here"
// check, which is what caused R4A1-2/R4C1-1.
function isLauncherDirRoot(normalized) {
  if (!normalized) return false;
  const home = safeHomedir();
  if (!home) return false;
  const want = path.posix.normalize(home.replace(/\\/g, '/').replace(/\/+$/, '') + '/.anti-hall');
  // path.posix.normalize() preserves a trailing slash (e.g. `~/.anti-hall/`
  // normalizes to `.../.anti-hall/`, not `.../.anti-hall`), so strip any
  // trailing slash from BOTH sides before comparing - otherwise
  // `rm -rf ~/.anti-hall/` / `mv ~/.anti-hall/ ~/.x` (trailing slash) never
  // equal `want` and silently bypass this check (R5A1-3).
  const norm = normalized.replace(/\/+$/, '');
  const wantNorm = want.replace(/\/+$/, '');
  return norm.toLowerCase() === wantNorm.toLowerCase();
}

// True when the normalized path has a `.anti-hall/bin` segment pair anywhere
// in it (case-insensitive) - the actual check writesLauncherDir enforces;
// LAUNCHER_DIR_RE below stays only as a cheap first-pass filter.
function hasAntiHallBinSegment(p, cdDir) {
  if (!p) return false;
  return pathHasLauncherSegment(normalizeGuardPath(p, cdDir));
}

// Best-effort symlink resolution (R2-1): the textual checks above (
// LAUNCHER_DIR_RE / hasAntiHallBinSegment) catch a write whose LITERAL path
// names `.anti-hall/bin`, but not a write through a symlink planted
// elsewhere (e.g. `ln -sf ~/.anti-hall/bin/devswarm.js /tmp/pwn.js` then
// `echo PWNED > /tmp/pwn.js`) that resolves into it. Two passes:
//  1. If the FULL target already exists (the common planted-symlink shape -
//     the symlink itself is the write target), fs.realpathSync resolves the
//     whole chain in one call; re-check the resolved form. A leaf that
//     exists as a symlink but cannot be fully resolved (broken target) fails
//     CLOSED (treated as pointing into the launcher dir).
//  2. Otherwise (the common case: writing a brand-new file) walk the
//     normalized path's EXISTING components up to and including the parent
//     directory; if any of them is a symlink, or the deepest existing
//     prefix's realpath differs from its literal form, re-check the resolved
//     form. An unresolvable symlink component also fails CLOSED.
// Reads a symlink's LITERAL target text (bounded chain, loop-guarded) for a
// leaf that fs.realpathSync could not resolve (dangling target, or an ELOOP
// cycle). Returns the resolved-as-far-as-possible target path, or null when
// the chain itself is unreadable/looping (permission error, too many hops) -
// the only case that should still fail closed.
function resolveDanglingLinkTarget(p, hops) {
  const n = typeof hops === 'number' ? hops : 0;
  if (n > 10) return null; // loop guard
  let linkText;
  try {
    linkText = fs.readlinkSync(p);
  } catch (_) {
    return null;
  }
  let target = linkText.replace(/\\/g, '/');
  target = target.startsWith('/') ? path.posix.normalize(target) :
    path.posix.normalize(path.posix.dirname(p) + '/' + target);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return resolveDanglingLinkTarget(target, n + 1);
  } catch (_) { /* target doesn't exist - this IS the dangling leaf's literal text */ }
  return target;
}

function targetResolvesIntoLauncherDir(rawPath, cdDir, opts) {
  const normalized = normalizeGuardPath(rawPath, cdDir);
  if (!normalized || !normalized.startsWith('/')) return false;
  // Perf guard (R4A1-3): each call below does 1+ realpathSync/lstatSync
  // syscalls. Past launcherFsWalkBudget calls in this one invocation, stop
  // spending them - the textual checks (pathHasLauncherSegment /
  // isLauncherDirRoot) in writesLauncherDir() still run on every target
  // regardless, so a LITERAL `.anti-hall/bin` (or exact-root) path is still
  // caught; only best-effort symlink resolution beyond the budget is
  // skipped.
  if (launcherFsWalkBudget <= 0) return false;
  launcherFsWalkBudget--;
  // `rm` DELETES the operand itself rather than writing THROUGH it, so a
  // looping/self-referential symlink (`ln -s selfloop selfloop; rm -f
  // selfloop`) must never be followed or fail-closed the way a write target
  // is (R5A1-4). A pure leaf symlink (the operand itself IS the symlink)
  // only gets a one-hop readlink check, never chased or fail-closed.
  //
  // R6A1-1 (regression in 0d90bf1): the ONLY case handled above used to be
  // "operand itself is a symlink" - it lstat()ed just the leaf and, for
  // anything else (a real file/dir reached through a symlinked PARENT
  // component, e.g. `rm -f linkdir/devswarm.js` where `linkdir` ->
  // ~/.anti-hall/bin), fell straight through to `return false` (allowed) -
  // never walking the parent chain the way the non-deleteOnly branch below
  // (and 51775f4 before this regression) does. `rm -f linkdir/devswarm.js`,
  // `rm -rf linkdir/`, and `rm -rf linkroot/bin` (linkroot -> ~/.anti-hall)
  // all bypassed the guard this way.
  if (opts && opts.deleteOnly) {
    // A trailing-slash operand (`rm -rf linkdir/`): rm follows the operand's
    // OWN symlink-ness the same way a write target does, so resolve the
    // FULL path (parent AND leaf) via realpathSync, same as the non-delete
    // branch below.
    if (normalized.endsWith('/')) {
      try { return pathHasLauncherSegment(fs.realpathSync(normalized)); }
      catch (_) { return false; /* doesn't exist - nothing to delete */ }
    }
    try {
      if (fs.lstatSync(normalized).isSymbolicLink()) {
        let linkText;
        try { linkText = fs.readlinkSync(normalized); } catch (_) { return false; }
        let target = linkText.replace(/\\/g, '/');
        target = target.startsWith('/') ? path.posix.normalize(target) :
          path.posix.normalize(path.posix.dirname(normalized) + '/' + target);
        return pathHasLauncherSegment(target);
      }
      // A real (non-symlink) leaf that EXISTS: resolve the full path. This
      // follows any symlink PARENT component (the fix) without following
      // the leaf itself - there is nothing to follow, it isn't a symlink.
      return pathHasLauncherSegment(fs.realpathSync(normalized));
    } catch (_) {
      // Leaf doesn't exist (or the lstat/realpath above hit an unrelated
      // error, e.g. ELOOP in a parent component): still resolve the PARENT
      // directory's realpath and rejoin the leaf's own basename, so a
      // not-yet-created target under a symlinked parent (`rm -f
      // linkdir/not-yet-created.js`) is judged the same as an existing one.
      // Fails OPEN (allow) only when the parent itself cannot be resolved -
      // nothing exists there to delete either way.
      const parent = path.posix.dirname(normalized);
      const base = path.posix.basename(normalized);
      try {
        const realParent = fs.realpathSync(parent);
        return pathHasLauncherSegment(realParent.replace(/\/+$/, '') + '/' + base);
      } catch (_) { return false; }
    }
  }
  try {
    return pathHasLauncherSegment(fs.realpathSync(normalized));
  } catch (_) {
    try {
      if (fs.lstatSync(normalized).isSymbolicLink()) {
        // Dangling target or an ELOOP cycle: realpathSync above could not
        // resolve it. Read the link's LITERAL target text and test THAT
        // against the launcher dir instead of failing closed on every
        // dangling symlink anywhere on disk (R3A1-3/R3C1-2/R3A1-4) - an
        // ordinary not-yet-created log/pidfile symlink is a common,
        // unrelated shape. Only an unreadable/looping chain still fails
        // closed.
        const target = resolveDanglingLinkTarget(normalized, 0);
        return target === null ? true : pathHasLauncherSegment(target);
      }
    } catch (_) { /* leaf doesn't exist at all - the ordinary "new file" case */ }
  }
  const segs = normalized.split('/').filter(Boolean);
  let existing = '';
  let cur = '';
  for (let i = 0; i < segs.length - 1; i++) {
    cur += '/' + segs[i];
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (_) {
      break; // component doesn't exist (yet) - nothing further to resolve
    }
    existing = cur;
    if (st.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(cur);
        if (pathHasLauncherSegment(real)) return true;
      } catch (_) {
        return true; // unresolvable symlink in the chain - fail closed
      }
    }
  }
  if (!existing) return false;
  let resolvedExisting;
  try {
    resolvedExisting = fs.realpathSync(existing);
  } catch (_) {
    return false;
  }
  if (resolvedExisting === existing) return false;
  const rejoined = path.posix.normalize(resolvedExisting + normalized.slice(existing.length));
  return pathHasLauncherSegment(rejoined);
}

const LAUNCHER_BLOCK_MSG = (
  'anti-hall git-guard: BLOCKED. This command writes into ~/.anti-hall/bin/, ' +
  'the stable launcher directory. anti-hall installs those files itself ' +
  '(update / doctor --repair); overwriting one would run arbitrary code (such ' +
  'as a force push) under a trusted launcher name. Leave that directory alone; ' +
  'if the path only appears as prose inside a heredoc/brief, write that text with the Write tool instead.'
);

// Redirect targets read from RAW text (quotes intact): after each `>`, `>>`,
// `>|`, `&>`, `N>` the shell word - quoted spans taken up to the MATCHING
// closing quote (spanning newlines, e.g. a quoted `$HOME/<NL>/../.anti-hall/bin/x`),
// unquoted text up to whitespace or a shell operator - with the quotes
// stripped. An unterminated quote ends the word (the per-line text scan in
// writesLauncherDir still covers that glued-heredoc shape).
function redirectWords(raw) {
  const out = [];
  const n = raw.length;
  for (let k = raw.indexOf('>'); k >= 0; k = raw.indexOf('>', k + 1)) {
    let i = k + 1;
    if (raw[i] === '>' || raw[i] === '|') i++;
    if (raw[i] === '&' || raw[i] === '(') continue; // fd dup / process subst
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    let w = '';
    while (i < n) {
      const c = raw[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && raw[j] !== c) j += (c === '"' && raw[j] === '\\') ? 2 : 1;
        if (j >= n) { i = n; break; } // unterminated
        w += raw.slice(i + 1, j);
        i = j + 1;
      } else if (/[\s;&|<>()]/.test(c)) {
        break;
      } else if (c === '\\' && i + 1 < n) {
        w += raw[i + 1];
        i += 2;
      } else {
        w += c;
        i++;
      }
    }
    if (w) out.push(w);
  }
  return out;
}

function launcherTargetHit(p, cdDir, opts) {
  return LAUNCHER_DIR_RE.test(p) || hasAntiHallBinSegment(p, cdDir) ||
    targetResolvesIntoLauncherDir(p, cdDir, opts);
}

function writesLauncherDir(tokens, ev, cdDir) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quotedOnly) continue;
    // EVERY `>` in the token is a candidate redirect, and each one's target is
    // only the text up to the next newline: a real redirect target is one
    // shell word, never a multi-line span. An odd quote in a heredoc body
    // (`don't ... -> x`) desyncs the quote-aware tokenizer so one glued token
    // swallows the body AND the later `node ~/.anti-hall/bin/...` line; taking
    // everything after the first `>` then read that EXECUTED launcher path as
    // a write target (prose `->` + apostrophe false block). Scanning every
    // `>` per line keeps a real `echo x > ~/.anti-hall/bin/y` on a later line
    // of the same glued token blocked (fail closed).
    for (let k = t.text.indexOf('>'); k >= 0; k = t.text.indexOf('>', k + 1)) {
      let rest = t.text.slice(k + 1);
      const nl = rest.indexOf('\n');
      if (nl >= 0) rest = rest.slice(0, nl);
      const after = rest.replace(/^>/, '').replace(/^\|/, '');
      if (after.startsWith('&') || after.startsWith('(')) continue; // fd dup / process subst
      if (after) targets.push(after);
      else if (nl < 0) targets.push(tokens[i + 1] ? tokens[i + 1].text : '');
    }
    // Quote-aware word per redirect, read from the raw token: a quoted target
    // may span newlines, which the per-line cut above would truncate.
    if (t.raw && t.raw.indexOf('>') >= 0) targets.push(...redirectWords(t.raw));
  }
  const ops = ev.args.map((a) => a.text);
  const operands = ops.filter((w) => !w.startsWith('-'));
  if (ev.verb === 'tee' || ev.verb === 'truncate') targets.push(...operands);
  if (COPY_VERBS.has(ev.verb)) {
    if (operands.length) targets.push(operands[operands.length - 1]);
    ops.forEach((w, j) => {
      if (w === '-t' || w === '--target-directory') targets.push(ops[j + 1] || '');
      else if (w.startsWith('--target-directory=')) targets.push(w.slice(19));
    });
  }
  // `ln`'s SOURCE operand(s) (everything but the final destination/directory
  // operand) also count as a write target: planting `ln [-s] <source into
  // .anti-hall/bin> /tmp/somewhere` is the first half of a symlink-through
  // attack even though the destination itself sits outside the launcher dir.
  if (ev.verb === 'ln' && operands.length >= 2) targets.push(...operands.slice(0, -1));
  // `mv`'s SOURCE operand(s) also count as a write target: `mv
  // ~/.anti-hall/bin/devswarm.js ~/.x` (or `mv ~/.anti-hall ~/.x`) tampers
  // with the launcher by relocating/renaming it away, even though the
  // destination itself sits outside the launcher dir (R3-1/R3C1-1).
  if (ev.verb === 'mv' && operands.length >= 2) targets.push(...operands.slice(0, -1));
  // `cp`/`install` with a hardlink-creating flag (-l / --link) makes the
  // destination share an INODE with the source - a later, unrelated write to
  // that untracked destination silently mutates the source's content too.
  // Flag the source operand(s) the same way `ln`'s already are (R3-1/
  // R3C1-1: `cp -l ~/.anti-hall/bin/devswarm.js /tmp/x.js` then `echo
  // PWNED > /tmp/x.js` bypassed the destination-only check).
  const hardlinkFlag = ev.verb === 'cp' && ops.some((w) =>
    w === '--link' || (/^-[a-zA-Z]+$/.test(w) && w.includes('l')));
  if (hardlinkFlag && operands.length >= 2) targets.push(...operands.slice(0, -1));
  if (ev.verb === 'dd') ops.forEach((w) => { if (w.startsWith('of=')) targets.push(w.slice(3)); });
  if ((ev.verb === 'sed' || ev.verb === 'perl') && ops.some((w) => /^-(?:[a-zA-Z]*i|-in-place)/.test(w))) {
    targets.push(...operands);
  }
  // `rm`'s operand(s) count as a write target too: `rm -rf ~/.anti-hall/bin`
  // (bin-segment check below) or `rm -rf ~/.anti-hall` (the whole-container
  // check, rootTargets below) both destroy the launcher.
  if (ev.verb === 'rm' && operands.length) targets.push(...operands);

  // R4A1-2/R4C1-1: rootTargets is checked ONLY against isLauncherDirRoot -
  // the anchored "IS <home>/.anti-hall itself" match - never against the
  // broad bin-segment/textual checks above. An mv SOURCE or an rm target
  // that relocates/deletes the launcher's CONTAINER wholesale (`mv
  // ~/.anti-hall ~/.x`, `rm -rf ~/.anti-hall`) is still caught, while an
  // ordinary `.anti-hall/` elsewhere (a project dir, or anything not
  // resolving to the real $HOME's `.anti-hall`) is not.
  // `ln`'s SOURCE operand(s) get the same whole-container check: `ln -s
  // ~/.anti-hall link` plants an alias whose later use (`echo PWNED >
  // link/bin/devswarm.js`) writes through it before the symlink even
  // exists on disk to resolve at scan time (R3A1-2) - the ln SOURCE itself
  // being exactly the launcher container is what must be caught here.
  const rootTargets = [];
  if (ev.verb === 'mv' && operands.length >= 2) rootTargets.push(...operands.slice(0, -1));
  if (ev.verb === 'ln' && operands.length >= 2) rootTargets.push(...operands.slice(0, -1));
  if (ev.verb === 'rm' && operands.length) rootTargets.push(...operands);

  // A copy/move into an EXISTING directory destination places the file at
  // dest/basename(source), not at dest itself - `cp -r bin ~/.anti-hall`
  // must still be caught even though the raw destination operand
  // (`~/.anti-hall`) has no `bin` segment of its own. Only probed for
  // COPY_VERBS with a source operand, and only when the destination already
  // exists as a directory on disk - an ordinary `cp x ~/.anti-hall/` (a
  // non-bin file landing directly under the allowed rest of `.anti-hall/`)
  // must NOT be blocked just because the destination directory happens to
  // exist (R4A1-2/R4C1-1).
  if (COPY_VERBS.has(ev.verb) && operands.length >= 2) {
    const destNorm = normalizeGuardPath(operands[operands.length - 1], cdDir);
    let destIsDir = false;
    if (destNorm && destNorm.startsWith('/')) {
      try { destIsDir = fs.statSync(destNorm).isDirectory(); } catch (_) { /* doesn't exist (yet) */ }
    }
    if (destIsDir) {
      const destBase = destNorm.replace(/\/+$/, '');
      for (const src of operands.slice(0, -1)) {
        const srcBase = path.posix.basename(String(src).replace(/\\/g, '/').replace(/\/+$/, ''));
        if (srcBase) targets.push(destBase + '/' + srcBase);
      }
    }
  }

  const targetOpts = ev.verb === 'rm' ? { deleteOnly: true } : undefined;
  return targets.some((p) => launcherTargetHit(p, cdDir, targetOpts)) ||
    rootTargets.some((p) => isLauncherDirRoot(normalizeGuardPath(p, cdDir)));
}

// Code strings passed to a call: `execSync('git push --force')`,
// `os.system("…")`, `system "…"`, or a list-form argv
// (`execFileSync('git', ['push', '--force'])`, `run(["git","push","-f"])`), in
// a node -e / python -c / perl -e payload or a script body written by a
// heredoc. The literal is data to the shell, so the segment scan never sees
// it. Every quoted string after a call opener, up to the first unquoted `)`,
// `;` or newline, is joined with spaces and returned as a command to scan.
// Only strings that mention `push` are returned. Prose like
// "(see 'git push')" still matches, so this is kept to call-shaped openers:
// `(` or `system`/`exec` directly followed by a quote or `[`.
const CALL_LITERAL_RE = /(?:\(|\b(?:system|exec)[ \t]+)[ \t]*[['"]/g;

function callLiteralCommands(cmd) {
  const src = cmd.replace(/\\(['"])/g, '$1');
  const out = [];
  for (const m of src.matchAll(CALL_LITERAL_RE)) {
    const parts = [];
    let i = m.index + m[0].length - 1;
    while (i < src.length && src[i] !== ')' && src[i] !== ';' && src[i] !== '\n') {
      const q = src[i];
      if (q === "'" || q === '"') {
        const j = src.indexOf(q, i + 1);
        if (j < 0) break;
        parts.push(src.slice(i + 1, j));
        i = j + 1;
      } else {
        i++;
      }
    }
    const joined = parts.join(' ');
    if (/push/.test(joined)) out.push(joined);
  }
  return out;
}

// Run the git force/trailer detection on every segment of a command string.
// Returns a block message string if a violation is found, else null. Recurses
// into `eval <payload>` segments (depth-bounded) so force/trailer forms hidden
// behind eval are still caught. Mirrors the wrapper-unwrapping already done for
// command/sudo/env/timeout in effectiveVerb.
function scanCommand(cmd, depth, baseCwd) {
  const d = typeof depth === 'number' ? depth : 0;
  const segments = splitSegments(cmd);

  // Additive side-channel data for the `-F`/`--file` commit-message scan
  // (see fileCommitMessages/extractHeredocBodies above): every heredoc body
  // anywhere in THIS level's raw command text, and the most recent literal
  // `cd <dir>` segment seen so far (read order), used to resolve a relative
  // `-F <path>`. Neither affects segmentation, verb resolution, force-push
  // detection, or inline -m/--trailer scanning below.
  const heredocBodies = extractHeredocBodies(cmd);
  // Seed with the hook payload's real shell cwd (when known) so a bare
  // relative write target with NO `cd` anywhere in this command still
  // resolves against where it actually lands on disk, not just against a
  // `cd` this same command string happens to contain (R3A1-2/R3C1-1).
  let lastCdDir = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;

  if (d < 3) {
    for (const lit of callLiteralCommands(cmd)) {
      const hit = scanCommand(lit, d + 1, baseCwd);
      if (hit) return hit;
    }
  }

  for (const h of heredocBodies) {
    const hit = scanConfigLines(h.body, d);
    if (hit) return hit;
  }

  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;

    // Shell assignments (`GIT_PAGER=…`, `export X=…`, `env X=…`): the value
    // may be run as a command by git.
    for (const t of tokens) {
      if (t.quotedOnly) continue;
      const a = /^[A-Za-z_][A-Za-z0-9_]*=([\s\S]+)$/.exec(t.text);
      if (a) {
        const hit = scanCommandValue(a[1], d);
        if (hit) return hit;
      }
    }

    const ev = effectiveVerb(tokens);
    if (!ev) continue;

    if (writesLauncherDir(tokens, ev, lastCdDir)) {
      return LAUNCHER_BLOCK_MSG;
    }

    if (ev.verb === 'echo' || ev.verb === 'printf') {
      const text = ev.args.map((t) => t.text).join(' ').replace(/\\[nt]/g, '\n');
      const hit = scanConfigLines(text, d);
      if (hit) return hit;
      continue;
    }

    // Track a literal `cd <dir>` / `pushd <dir>` segment (read order) so a
    // later relative `-F <path>` or write target in this same command can be
    // resolved against it. A RELATIVE dir chains onto the PREVIOUS cdDir
    // (normalizeGuardPath joins+normalizes) instead of replacing it outright
    // - `cd ~/.anti-hall; cd bin; echo x > devswarm.js` must resolve `bin`
    // against `~/.anti-hall`, not treat it as relative to the process cwd
    // (R3A1-2/R3A1-4/R3C1-1). Does not affect any existing verb/force/
    // trailer detection.
    if (ev.verb === 'cd' || ev.verb === 'pushd') {
      const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
      if (dirTok) {
        // Perf guard (R4A1-3): a long chain of relative `cd`s
        // (`cd a;cd a;cd a;...`, repeated tens of thousands of times) used
        // to keep concatenating onto lastCdDir via normalizeGuardPath every
        // single time - a growing string re-joined/re-normalized on EVERY
        // iteration, turning an O(n)-segment command into O(n^2) work and
        // blowing the hook's 10s timeout well before the trailing force
        // push at the end was ever reached (fail-OPEN by timeout, the
        // opposite of the intended block). Once the chained dir exceeds a
        // bounded length/depth, stop compounding it - treat further cd
        // context as unknown (null) so later relative write targets fall
        // back to textual-only resolution instead of a `null`-prefixed join
        // silently misresolving.
        if (lastCdDir && (lastCdDir.length > 4096 || lastCdDir.split('/').length > 64)) {
          lastCdDir = null;
        } else {
          lastCdDir = normalizeGuardPath(dirTok.text, lastCdDir) || dirTok.text;
        }
      }
      continue;
    }

    // Unwrap `eval <payload>`: re-parse its argument as a command string.
    if (ev.verb === 'eval') {
      if (d < 3) {
        const payload = extractEvalPayload(seg);
        if (payload) {
          const nested = scanCommand(payload, d + 1, lastCdDir);
          if (nested) return nested;
        }
      }
      continue;
    }

    // Unwrap `bash -c "<payload>"` (sh/zsh/dash/ksh/ash): a shell wrapper's verb
    // is not `git`, so `bash -c "git push --force"` would otherwise fall through
    // to the `ev.verb !== 'git'` skip below and fail-open — a total bypass of the
    // one guard the repo treats as non-skippable (P0-1). Recurse the -c payload
    // depth-bounded, exactly like the eval branch.
    if (SHELL_VERBS.has(ev.verb.toLowerCase())) {
      if (d < 3) {
        const payload = extractShellCPayload(seg);
        if (payload) {
          const nested = scanCommand(payload, d + 1, lastCdDir);
          if (nested) return nested;
        }
      }
      continue;
    }

    // --- Rule 1 (gh): self-credit in a PR/issue/release body or title ---
    if (ev.verb === 'gh') {
      const ghMsg = ghSelfCreditMessage(ev.args);
      if (ghMsg) return ghMsg;
      continue;
    }

    // A1-2 (0.118.0 follow-up): xargs-run `git` verdicts belong to the
    // quote-aware passes (this segment loop + gitBackstopLines) only, not the
    // quote-blind backstopPieces split - that split cuts at ANY unquoted-OR-
    // quoted `|`/`;`, so a `|`/`xargs` mentioned inside a literal string (a
    // commit message, `echo '...' > notes.txt`, heredoc text) was wrongly
    // resolving to verb `xargs` and blocking benign commands.
    if (ev.verb === 'xargs') {
      const xv = xargsGitVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
      if (xv) return xv;
      continue;
    }

    if (ev.verb !== 'git') continue;

    const gv = gitVerdict(ev, d, cmd, heredocBodies, lastCdDir, true);
    if (gv) return gv;
  }
  if (d === 0) {
    const lb = launcherBackstop(cmd, baseCwd);
    if (lb) return lb;
  }
  return gitBackstop(cmd, d, heredocBodies, baseCwd);
}

// Quote-blind launcher-dir write scan. The quote-aware pass above loses sync
// after an odd quote (a `don't` in a heredoc body) and glues later lines into
// one token, hiding the verb of a real `cp`/`tee`/`mv`/`sed -i`/`cd` write.
// This pass cuts the raw text quote-blind (backstopPieces: newline ; & | ( )
// $( backtick) and runs the same writesLauncherDir on each piece, tracking a
// literal `cd` so `cd ~/.anti-hall/bin` + a relative write still blocks.
// Executing a launcher (`node ~/.anti-hall/bin/x`) is not a write. Only ADDS
// blocks. DELIBERATE FAIL-CLOSED: prose in a heredoc that literally holds a
// launcher write blocks (owner-ratified trade-off, 0.119.0 revert).
function launcherBackstop(rawCmd, baseCwd) {
  // Bash deletes backslash-newline continuations BEFORE parsing, so a path
  // broken across a continuation mid-word really writes into the launcher dir.
  // Remove them (no space) for launcher analysis; the force/credit scans keep
  // their own handling of the raw text.
  const cmd = rawCmd.replace(/\\\r?\n/g, '');
  let cdDir = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;
  const baseDir = cdDir;
  for (const raw of backstopPieces(cmd)) {
    const trimmed = raw.replace(/^\s+/, '');
    const variants = [trimmed];
    if (/^["']/.test(trimmed)) variants.push(trimmed.replace(/^["']+/, ''));
    for (const v of variants) {
      const tokens = tokenize(v);
      if (!tokens.length) continue;
      const ev = backstopVerb(v);
      if (!ev) continue;
      if (ev.verb === 'cd' || ev.verb === 'pushd') {
        const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
        if (dirTok) {
          cdDir = (cdDir && (cdDir.length > 4096 || cdDir.split('/').length > 64))
            ? null : (normalizeGuardPath(dirTok.text, cdDir) || dirTok.text);
        }
        continue;
      }
      if (writesLauncherDir(tokens, ev, cdDir)) return LAUNCHER_BLOCK_MSG;
    }
  }
  // Whole-text redirect scan: backstopPieces cuts at every newline, so a quoted
  // target spanning a newline is split across pieces and never seen whole.
  for (const w of redirectWords(cmd)) {
    if (launcherTargetHit(w, baseDir) || (cdDir !== baseDir && launcherTargetHit(w, cdDir))) return LAUNCHER_BLOCK_MSG;
  }
  return null;
}

// The git-specific verdicts (force push, push-arg command substitution,
// command-valued `-c`/`git config` values, AI self-credit on commit-creating
// commands) for ONE resolved `git …` invocation. Shared by scanCommand's
// quote-aware segment pass and the quote-blind gitBackstop pass below, so both
// passes apply exactly the same rules and emit exactly the same reasons.
// `useJev` gates the (network, budgeted) Jev add-block consult: only the
// quote-aware pass consults it.
function gitVerdict(ev, d, cmd, heredocBodies, lastCdDir, useJev) {
  // `git -c key=value`: the value may be run as a command.
  for (let j = 0; j + 1 < ev.args.length; j++) {
    if (ev.args[j].text !== '-c') continue;
    const cv = /^[^=]+=([\s\S]*)$/.exec(ev.args[j + 1].text);
    const hit = cv ? scanCommandValue(cv[1], d) : null;
    if (hit) return hit;
  }

  const { sub, rest } = gitSubcommand(ev.args);
  if (sub === null) return null;

  // `git config [--file f] key value`: scan each operand as a possible value.
  if (sub === 'config') {
    for (const t of rest) {
      if (t.text.startsWith('-')) continue;
      const hit = scanCommandValue(t.text, d);
      if (hit) return hit;
    }
  }

  // --- Rule 2: force push ---
  if (sub === 'push') {
    if (isForcePush(rest)) {
      return (
        'anti-hall git-guard: BLOCKED. Force push detected. Rewriting published ' +
        'history is a deliberate human action - do it manually with explicit ' +
        'owner confirmation, never from an automated push.'
      );
    }
    if (isDeleteRefPush(rest)) {
      return (
        'anti-hall git-guard: BLOCKED. Remote ref deletion detected (push --delete / -d / ' +
        '--prune / an empty-source :<ref> refspec). Deleting published branches or tags ' +
        'needs explicit owner confirmation. If the owner has asked for this exact ' +
        'deletion, the override is the ~/.anti-hall/skip.json git-guard escape hatch ' +
        '(direct human instruction only); otherwise leave the ref.'
      );
    }
    if (hasCmdSubstArg(rest)) {
      return (
        'anti-hall git-guard: BLOCKED. `git push` has an argument produced by a ' +
        'command substitution / backtick expansion, which can smuggle a --force ' +
        'flag past static inspection. Run the push with literal arguments (no ' +
        '$( ) or backticks) so the force-push guard can verify it.'
      );
    }
  }

  // --- Rule 1: self-credit in an inline commit message ---
  // merge / commit-tree take the same -m / -F message flags; interpret-trailers
  // takes --trailer and is used to stamp a message file before `commit -F`;
  // tag takes the same -m / -F flags for an annotated tag's message, which is
  // just as much an AI self-credit vector (e.g. `git tag -a v1.0 -m "...
  // Co-Authored-By: Claude ..."`).
  if (sub === 'commit' || sub === 'merge' || sub === 'commit-tree' || sub === 'interpret-trailers' || sub === 'tag') {
    // Conservative block on a `-c trailer.<name>.key=<self-credit>` remap that
    // would emit a Co-Authored-By / Generated-with trailer from a benign-looking
    // custom token, dodging the value scan below.
    if (hasSelfCreditTrailerKeyRemap(ev.args)) {
      return (
        'anti-hall git-guard: BLOCKED. `-c trailer.*.key=` remaps a custom ' +
        'trailer token to an AI/assistant self-credit key (Co-Authored-By / ' +
        'Generated-with). Remove the trailer remap - commits carry no AI ' +
        'co-author credit.'
      );
    }
    const msgs = inlineCommitMessages(rest);
    for (const m of msgs) {
      const normalized = m
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
      if (
        SELF_CREDIT_COAUTHOR.test(m) || SELF_CREDIT_GENERATED.test(m) ||
        SELF_CREDIT_COAUTHOR.test(normalized) || SELF_CREDIT_GENERATED.test(normalized)
      ) {
        return (
          'anti-hall git-guard: BLOCKED. Commit message contains an AI/assistant ' +
          'self-credit trailer (Co-Authored-By / "Generated with <AI>"). Remove it - ' +
          'commits carry no AI co-author credit. Re-run the commit without that trailer.'
        );
      }
    }
    // JEV ADD-BLOCK (gitGuardSelfCredit, default mode "shadow" — see
    // jev-assist.js / ghSelfCreditMessage's twin call above for the full
    // rationale). Only reached when an inline -m/-F message was actually
    // present AND the regex scan above found nothing — can only ADD a
    // block, never relax the regex verdict.
    for (const m of msgs) {
      if (m && useJev && consultGitGuardSelfCreditJev(m)) {
        return (
          'anti-hall git-guard: BLOCKED. Commit message appears to credit an AI ' +
          'assistant (paraphrased self-credit, flagged by the Jev classifier — not ' +
          'a literal trailer match). Remove it - commits carry no AI co-author credit.'
        );
      }
    }

    // --- ADDITIVE: `-F <file>` / `--file[=<file>]` (never removes a block,
    // only adds one) ---
    //   - `-F -` / `--file=-` / `-F /dev/stdin`: the message is read from
    //     STDIN. Scanned against every heredoc body found anywhere in this
    //     command's raw text (extractHeredocBodies, a side-channel over the
    //     raw string - splitSegments/force-push/inline-message detection
    //     above are completely untouched by this).
    //   - `-F <real path>`: read the file directly (relative paths resolved
    //     against a preceding literal `cd <dir>` segment if any, else the
    //     hook's cwd). Fail-open (skip, do not block) if it cannot be read.
    const fileSpecs = fileCommitMessages(rest);
    for (const spec of fileSpecs) {
      let text = null;
      let hasSelfCreditVerdict = null; // pre-computed only for the memoized stdin branch
      if (spec === '-' || spec === '/dev/stdin') {
        const cached = stdinCandidateTextCached(cmd, heredocBodies);
        text = cached.text;
        hasSelfCreditVerdict = cached.hasSelfCredit;
      } else {
        let filePath = spec;
        if (!path.isAbsolute(filePath) && lastCdDir) {
          filePath = path.join(lastCdDir, filePath);
        }
        try {
          text = fs.readFileSync(filePath, 'utf8');
        } catch (_) {
          text = null; // unreadable/nonexistent -> fail-open, do not guess
        }
      }
      if (text === null) continue;
      if (hasSelfCreditVerdict === null
        ? (SELF_CREDIT_COAUTHOR.test(text) || SELF_CREDIT_GENERATED.test(text))
        : hasSelfCreditVerdict) {
        return (
          'anti-hall git-guard: BLOCKED. Commit message (via `-F`/`--file`, ' +
          'read from a heredoc body or file) contains an AI/assistant self-credit ' +
          'trailer (Co-Authored-By / "Generated with <AI>"). Remove it - commits ' +
          'carry no AI co-author credit. Re-run the commit without that trailer.'
        );
      }
      // JEV ADD-BLOCK (gitGuardSelfCredit) — same twin call as the inline
      // -m/--trailer path above, for a `-F`/`--file`-sourced message.
      if (useJev && consultGitGuardSelfCreditJev(text)) {
        return (
          'anti-hall git-guard: BLOCKED. Commit message (via `-F`/`--file`) appears ' +
          'to credit an AI assistant (paraphrased self-credit, flagged by the Jev ' +
          'classifier — not a literal trailer match). Remove it - commits carry no ' +
          'AI co-author credit.'
        );
      }
    }
  }

  // --- Rule 1 (whole command): any commit-creating git verb whose command
  // text carries a self-credit trailer line, however it reaches git ---
  if (COMMIT_CREATING.has(sub) && hasSelfCredit(currentRawCommand)) {
    return (
      'anti-hall git-guard: BLOCKED. This command creates a commit (git ' + sub + ') ' +
      'and its text contains an AI/assistant self-credit trailer line ' +
      '(Co-Authored-By / "Generated with <AI>") - via a pipe, variable, file ' +
      'written in the same command, or similar. Remove it - commits carry no AI ' +
      'co-author credit.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// QUOTE-BLIND BACKSTOP (0.117.2). splitSegments tracks quotes, and any
// quote-state desync (an apostrophe in a heredoc body, a quote inside a
// comment, a heredoc/arithmetic/command-substitution interaction it models
// imperfectly) makes it read the REST of the command as one quoted span and
// swallow a later, real `git push --force`. Four rounds of tokenizer patches
// each opened a new variant, so instead of modelling the shell harder this
// pass does not model quotes, heredocs or comments AT ALL and therefore cannot
// desync: it cuts the raw command at every newline, `;`, `&`, `|`, `(`, `)`
// (which covers `&&`, `||`, `|&`, `$(`) and backtick, and runs ONLY the git
// verdicts (gitVerdict: force push, push-arg command substitution,
// command-valued -c/config values, self-credit on commit-creating commands) on
// each piece, unwrapping eval / `bash -c` payloads the same way. scanCommand
// blocks when EITHER its quote-aware pass or this pass blocks; the reason text
// is identical. Non-git verdicts (launcher-dir writes, config-line scans, gh
// bodies) stay on the quote-aware pass only, so this adds no new false block
// there. One linear split: O(n).
//
// DELIBERATE FAIL-CLOSED (accepted false block): quoted text holding a
// separator followed by a literal git command - `git commit -m "don't; git
// push --force"`, or a multi-line message with a LINE that starts with `git
// push --force` - is blocked, because a quote-blind cut cannot tell it from a
// real command. A mention with no separator in front of `git` (`git commit -m
// "never git push --force"`) stays allowed: that piece's git verb is `commit`.
// One narrow exception keeps regex alternations working: a TIGHT single `|`
// (non-space on both sides, e.g. `grep -E "a|git push --force"`) is not a cut
// when the quoted span it sits inside closes later, on the SAME physical
// line - the `|` then sits inside a quoted pattern, not between two
// commands. A real tight pipe into git (`x|git push --force origin main`)
// carries no such quote and is still cut. (A1-4, 0.117.2 follow-up: a
// grouped alternation like `grep -E "(a|git push -f)" x` also cuts at the
// `(`/`)` quote-blind, splitting the still-open quoted span across MORE than
// one following piece before its closing quote is reached - the exception
// below tracks quote parity cumulatively across pieces on the same line,
// not just within the one piece immediately after the pipe, so it still
// finds that later close.)
function backstopPieces(cmd) {
  // Backslash-newline is a line continuation: join, never cut.
  const s = cmd.replace(/\\\r?\n/g, ' ');
  const n = s.length;
  const pieces = []; // { text, tightPipe, line }
  let start = 0;
  let tightPipe = false;
  let lineIndex = 0;
  function cut(end, next, subst, nextTight, newLine) {
    pieces.push({ text: s.slice(start, end) + (subst ? ' ' + CMDSUBST_SENTINEL + ' ' : ''), tightPipe, line: lineIndex });
    start = next;
    tightPipe = nextTight;
    if (newLine) lineIndex++;
  }
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '\n') { cut(i, i + 1, false, false, true); continue; }
    if (c === ';' || c === ')') { cut(i, i + 1, false, false); continue; }
    // `$(` / backtick: the piece before it gets argv from an expansion.
    if (c === '(') { cut(i, i + 1, i > 0 && s[i - 1] === '$', false); continue; }
    if (c === '`') { cut(i, i + 1, true, false); continue; }
    if (c === '|') {
      if (i > 0 && s[i - 1] === '>') continue; // `>|` clobber redirect
      if (s[i + 1] === '|' || s[i + 1] === '&') { cut(i, i + 2, false, false); i++; continue; }
      const tight = i > 0 && !/\s/.test(s[i - 1]) && i + 1 < n && !/\s/.test(s[i + 1]);
      cut(i, i + 1, false, tight);
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { cut(i, i + 2, false, false); i++; continue; }
      // `2>&1`, `>&2`, `<&3`, `&>file`: a redirect, not a separator.
      if ((i > 0 && (s[i - 1] === '>' || s[i - 1] === '<')) || s[i + 1] === '>') continue;
      cut(i, i + 1, false, false);
    }
  }
  cut(n, n, false, false);
  const out = [];
  // `pending` accumulates the pieces of a tight-pipe run whose entering quote
  // parity (dqParity/sqParity, tracked cumulatively over EVERY piece in
  // order - not just the one right after the pipe) is still odd, i.e. we are
  // still "inside" a quoted span opened by an earlier piece. It keeps
  // absorbing following pieces, regardless of their own tightPipe flag,
  // until the parity flips back even (the quote closes) or the physical
  // line ends - whichever comes first. If the line changes or input ends
  // first, the accumulated parts are flushed UNMERGED (the original,
  // conservative behavior), so an unresolved/never-closing quote still
  // leaves any real git command as its own scanned piece (fail-closed).
  let pending = null; // { parts, line }
  let dqParity = 0;
  let sqParity = 0;
  for (const p of pieces) {
    const dq = (p.text.split('"').length - 1) % 2;
    const sq = (p.text.split("'").length - 1) % 2;
    const enteringDQ = dqParity;
    const enteringSQ = sqParity;
    dqParity ^= dq;
    sqParity ^= sq;

    if (pending && p.line !== pending.line) {
      out.push(...pending.parts);
      pending = null;
    }

    if (pending) {
      pending.parts.push(p.text);
      if (!dqParity && !sqParity) {
        if (out.length) out[out.length - 1] += '|' + pending.parts.join('|');
        else out.push(pending.parts.join('|'));
        pending = null;
      }
      continue;
    }

    if (p.tightPipe && out.length && (enteringDQ || enteringSQ)) {
      pending = { parts: [p.text], line: p.line };
      if (!dqParity && !sqParity) {
        out[out.length - 1] += '|' + pending.parts.join('|');
        pending = null;
      }
      continue;
    }

    out.push(p.text);
  }
  if (pending) out.push(...pending.parts);
  return out;
}

// Resolve one backstop piece to its effective verb. A leading `{`/`!` word is
// dropped (braces are not cut points, so `${VAR}` stays whole), and a quoted
// verb word (`"git" push`) is still the verb - the shell strips the quotes.
function backstopVerb(text) {
  const tokens = tokenize(text.replace(/^(?:\s*[{}!](?=\s|$))+/, ''));
  let idx = 0;
  while (idx < tokens.length && !tokens[idx].quotedOnly && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx].text)) idx++;
  if (idx < tokens.length && tokens[idx].quotedOnly) {
    tokens[idx] = { text: tokens[idx].text, quotedOnly: false };
  }
  return effectiveVerb(tokens);
}

// LINE-LEVEL RECOVERY (A1-1/A1-3, 0.117.2 follow-up). backstopPieces cuts
// quote-blind at `( ; & | )` and a backtick EVERYWHERE, including inside a
// git command's OWN quoted argument - e.g. `-C "$(pwd)"`, or a `-m`/
// `--trailer` message that itself contains one of those characters (a
// conventional-commit subject like `feat(x): y` opens with `(`). That can
// cut the piece holding the git verb apart from the piece holding
// `--force`/the self-credit trailer, so neither resolves to verb `git` and
// the backstop misses a command the quote-aware pass would have caught had
// a QUOTE DESYNC on an earlier physical line not disabled it. A single
// physical line (split on a REAL newline only, same backslash-newline join
// backstopPieces uses) is, on its own, almost always quote-balanced even
// when the desync lives earlier in the command - so for every line that
// mentions `git` at all (cheap gate), re-run the normal quote-aware
// splitSegments on JUST that line and apply gitVerdict to any segment whose
// effective verb is `git`. This only ADDS blocks on top of backstopPieces:
// it can never suppress one.
function gitBackstopLines(cmd, d, heredocBodies, cwd) {
  const joined = cmd.replace(/\\\r?\n/g, ' ');
  for (const line of joined.split('\n')) {
    if (!/\bgit\b/.test(line)) continue;
    for (const seg of splitSegments(line)) {
      const tokens = tokenize(seg);
      if (!tokens.length) continue;
      const ev = effectiveVerb(tokens);
      if (!ev) continue;
      if (ev.verb === 'xargs') {
        const xv = xargsGitVerdict(ev, d, cmd, heredocBodies, cwd, false);
        if (xv) return xv;
        continue;
      }
      if (ev.verb !== 'git') continue;
      const hit = gitVerdict(ev, d, cmd, heredocBodies, cwd, false);
      if (hit) return hit;
    }
  }
  return null;
}

function gitBackstop(cmd, d, heredocBodies, baseCwd) {
  const cwd = (typeof baseCwd === 'string' && baseCwd) ? baseCwd : null;
  // A1-5 (0.117.2 follow-up): a literal `echo "..." | bash` piped-script form
  // never resolves to verb `git` in EITHER piece (echo/bash), so it must be
  // unwrapped up front from the raw text, not from a per-piece verb match.
  if (d < 3) {
    for (const payload of pipedEchoShellPayloads(cmd)) {
      const hit = gitBackstop(payload, d + 1, extractHeredocBodies(payload), cwd);
      if (hit) return hit;
    }
  }
  for (const raw of backstopPieces(cmd)) {
    const trimmed = raw.replace(/^\s+/, '');
    // Two readings: as-is, and with one leading layer of quote chars stripped
    // (a quote a desynced line left dangling in front of the command).
    const variants = [trimmed];
    if (/^["']/.test(trimmed)) variants.push(trimmed.replace(/^["']+/, ''));
    for (const v of variants) {
      // A1-5: `env -S`/`--split-string` never resolves to verb `env` (its
      // payload is a single fully-quoted token, so backstopVerb returns
      // null) - detect and unwrap it before falling through to that null.
      if (d < 3) {
        const envPayload = extractEnvSPayload(v);
        if (envPayload) {
          const hit = gitBackstop(envPayload, d + 1, extractHeredocBodies(envPayload), cwd);
          if (hit) return hit;
          continue;
        }
      }
      const ev = backstopVerb(v);
      if (!ev) continue;
      if (ev.verb === 'git') {
        const hit = gitVerdict(ev, d, cmd, heredocBodies, cwd, false);
        if (hit) return hit;
      } else if (d < 3 && (ev.verb === 'eval' || SHELL_VERBS.has(ev.verb.toLowerCase()))) {
        const payload = ev.verb === 'eval' ? extractEvalPayload(v) : extractShellCPayload(v);
        if (payload) {
          const hit = gitBackstop(payload, d + 1, extractHeredocBodies(payload), cwd);
          if (hit) return hit;
        }
      }
    }
  }
  const lineHit = gitBackstopLines(cmd, d, heredocBodies, cwd);
  if (lineHit) return lineHit;
  return null;
}

// ---------------------------------------------------------------------------
// PostToolUse audit (`git-guard.js --audit`). The PreToolUse scan only sees
// the command line; a trailer can still land from outside it - a repo
// commit-msg / prepare-commit-msg hook, a commit.template, a cherry-picked or
// rebased message, an editor. After any command that ran a commit-creating git
// verb, read the commits HEAD now points at that were COMMITTED in the last
// AUDIT_WINDOW_S seconds and, if one carries a self-credit trailer, tell the
// agent to reword it before pushing. Advisory (PostToolUse cannot un-run a
// commit); never writes, never blocks; fail-open on every error.
const AUDIT_WINDOW_S = 900;

// Collect the repo dirs of every commit-creating git segment in `cmd`
// (honoring a preceding literal `cd <dir>` and `git -C <dir>`), recursing into
// eval / `bash -c` payloads like scanCommand.
function commitRepoDirs(cmd, base, depth, out) {
  let cdDir = base;
  for (const seg of splitSegments(cmd)) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const ev = effectiveVerb(tokens);
    if (!ev) continue;
    if (ev.verb === 'cd') {
      const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
      if (dirTok) cdDir = path.resolve(cdDir, dirTok.text);
      continue;
    }
    if (depth < 3 && (ev.verb === 'eval' || SHELL_VERBS.has(ev.verb.toLowerCase()))) {
      const payload = ev.verb === 'eval' ? extractEvalPayload(seg) : extractShellCPayload(seg);
      if (payload) commitRepoDirs(payload, cdDir, depth + 1, out);
      continue;
    }
    if (ev.verb !== 'git') continue;
    const { sub } = gitSubcommand(ev.args);
    if (!COMMIT_CREATING.has(sub)) continue;
    let dir = cdDir;
    for (let k = 0; k < ev.args.length; k++) {
      const t = ev.args[k].text;
      if (t === '-C' && k + 1 < ev.args.length) { dir = path.resolve(dir, ev.args[k + 1].text); k++; continue; }
      if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--config-env') { k++; continue; }
      if (t.startsWith('-')) continue;
      break; // reached the subcommand
    }
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function auditRecentCommits(cmd, cwd) {
  const { spawnSync } = require('child_process');
  const dirs = commitRepoDirs(cmd, cwd, 0, []);
  const nowS = Math.floor(Date.now() / 1000);
  const hits = [];
  for (const dir of dirs) {
    const r = spawnSync('git', ['-C', dir, 'log', '-n', '20', '--format=%h%x1f%ct%x1f%B%x1e', 'HEAD'],
      { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0 || !r.stdout) continue;
    for (const rec of r.stdout.split('\x1e')) {
      const [sha, ct, body] = rec.replace(/^\n/, '').split('\x1f');
      if (!sha || !body || Number(ct) < nowS - AUDIT_WINDOW_S) continue;
      if (hasSelfCredit(body)) hits.push(sha.trim() + (dirs.length > 1 ? ' (' + dir + ')' : ''));
    }
  }
  return hits;
}

function main() {
  // Settings switch safety.gitGuard (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('safety', 'gitGuard')) return; } catch (_) { /* run */ }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return fail_open();
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('git-guard')) process.exit(0);

  let cmd = '';
  let cwd = '';
  try {
    const payload = JSON.parse(raw);
    const ti = payload && payload.tool_input;
    if (ti && typeof ti.command === 'string') {
      cmd = ti.command;
    }
    if (payload && typeof payload.cwd === 'string') cwd = payload.cwd;
    // currentSessionId (module-scoped, set once per process here): a single
    // git-guard invocation is one short-lived process handling ONE PreToolUse
    // call, so a module-level value is safe (no concurrency within it) and
    // avoids threading a param through scanCommand's recursive eval/`bash -c`
    // unwrapping just for jev-assist.ndjson's optional sessionId tag.
    if (payload && payload.session_id) currentSessionId = String(payload.session_id);
  } catch (_) {
    return fail_open(); // unparseable envelope -> allow (do not scan whole blob)
  }
  if (!cmd) return fail_open();
  currentRawCommand = cmd;

  if (process.argv.includes('--audit')) {
    let cwd = process.cwd();
    try { const p = JSON.parse(raw); if (p && typeof p.cwd === 'string' && p.cwd) cwd = p.cwd; } catch (_) { /* keep */ }
    const hits = auditRecentCommits(cmd, cwd);
    if (hits.length) {
      const reason =
        'anti-hall git-guard (audit): recent commit(s) on HEAD (committed in the last ' +
        (AUDIT_WINDOW_S / 60) + ' min) ' + hits.join(', ') + ' carry an AI/assistant self-credit trailer (Co-Authored-By / ' +
        '"Generated with <AI>") - added by a git hook, template, cherry-pick/rebase, ' +
        'or an editor. Commits carry no AI co-author credit: reword them now ' +
        '(`git commit --amend` for HEAD, `git rebase -i` for older ones) BEFORE pushing.';
      fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason } }) + '\n');
    }
    process.exit(0);
  }

  const msg = scanCommand(cmd, 0, cwd);
  if (msg) {
    if (looksLikeFileWriteShape(cmd)) {
      return block(msg + '\nHint: this file\'s content was scanned as shell - write ' +
        'the file with the Write tool or the Edit tool instead of a Bash heredoc ' +
        '(Write/Edit are not shell-scanned), then reference that file path in a ' +
        'plain follow-up command (e.g. `devswarm.js send --message-file <path>`).');
    }
    return block(msg);
  }

  process.exit(0);
}

try {
  main();
} catch (_) {
  fail_open();
}
