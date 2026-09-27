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
//      LIMITATION (documented honestly): an interactive EDITOR commit (no -m,
//      no -F) is NOT scanned - the message is typed live and never appears on
//      the command line. A relative `-F <path>` is resolved against a leading
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

function fail_open() {
  process.exit(0);
}

function block(msg) {
  try {
    process.stderr.write(msg + '\n');
  } catch (_) { /* ignore */ }
  process.exit(2);
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
  let i = 0;
  const n = segment.length;

  function pushToken() {
    if (started) {
      tokens.push({ text: cur, quotedOnly: !curHasUnquoted });
    }
    cur = '';
    curHasUnquoted = false;
    started = false;
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

    // Operators (outside quotes).
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') { flush(); i++; continue; }
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
      if (prev === '>' || prev === '<') { cur += c; i++; continue; }
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
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'sudo', 'env', 'nice', 'nohup', 'time', 'timeout', 'then', 'do', 'else']);

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
          const parts = val.split(/\s+/).slice(1).filter(Boolean);
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
// mid-sentence mention of the phrase in prose.
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
const GH_BODY_FLAGS = new Set(['--body', '-b', '--title', '-t', '--notes', '-n']);
function ghSelfCreditMessage(args) {
  const words = args.map((a) => a.text);
  const guardedSub = words.includes('pr') || words.includes('issue') || words.includes('release');
  const guardedAct = words.includes('create') || words.includes('edit') || words.includes('comment');
  if (!guardedSub || !guardedAct) return null;
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i].text;
    if (GH_BODY_FLAGS.has(w)) { if (i + 1 < args.length) { vals.push(args[i + 1].text); i++; } continue; }
    const mEq = /^(?:--body|--title|--notes)=([\s\S]*)$/.exec(w);
    if (mEq) vals.push(mEq[1]);
  }
  for (const v of vals) {
    const normalized = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    for (const text of [v, normalized]) {
      if (SELF_CREDIT_COAUTHOR.test(text) || SELF_CREDIT_GENERATED.test(text) || SELF_CREDIT_GH_BODY.test(text)) {
        return (
          'anti-hall git-guard: BLOCKED. A gh pr/issue/release body or title carries ' +
          'AI/assistant self-credit ("Generated with Claude Code" / the 🤖 footer / ' +
          'Co-Authored-By / a claude.com/claude-code link). Remove it — PRs and issues ' +
          'carry no AI attribution. (Note: --body-file content is not inspected.)'
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

// consultGitGuardSelfCreditJev(text) -> true when Jev, running "on", confidently
// judges `text` to contain paraphrased AI self-credit. Trust 'add-block' /
// baseline `false`: this function's result can only ever ADD a block on top of
// a regex miss, never relax one (git-guard's own non-negotiable rule — see
// CLAUDE.md "NEVER relax" for this guard). askSync spawns the actual network
// call in a subprocess with its own hard timeout so this hook's fully
// synchronous main() never blocks past its own PreToolUse budget; jev-assist's
// own content-hash cache means a repeated identical message is never re-asked.
function consultGitGuardSelfCreditJev(text) {
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
      budgetMs: 1500,
      sessionId: currentSessionId || undefined,
    });
    return result.final === true;
  } catch (_) {
    return false;
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
  }
  return '';
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

// Run the git force/trailer detection on every segment of a command string.
// Returns a block message string if a violation is found, else null. Recurses
// into `eval <payload>` segments (depth-bounded) so force/trailer forms hidden
// behind eval are still caught. Mirrors the wrapper-unwrapping already done for
// command/sudo/env/timeout in effectiveVerb.
function scanCommand(cmd, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  const segments = splitSegments(cmd);

  // Additive side-channel data for the `-F`/`--file` commit-message scan
  // (see fileCommitMessages/extractHeredocBodies above): every heredoc body
  // anywhere in THIS level's raw command text, and the most recent literal
  // `cd <dir>` segment seen so far (read order), used to resolve a relative
  // `-F <path>`. Neither affects segmentation, verb resolution, force-push
  // detection, or inline -m/--trailer scanning below.
  const heredocBodies = extractHeredocBodies(cmd);
  let lastCdDir = null;

  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;

    const ev = effectiveVerb(tokens);
    if (!ev) continue;

    // Track a literal `cd <dir>` segment (read order) so a later relative
    // `-F <path>` in this same command can be resolved against it. Does not
    // affect any existing verb/force/trailer detection.
    if (ev.verb === 'cd') {
      const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
      if (dirTok) lastCdDir = dirTok.text;
      continue;
    }

    // Unwrap `eval <payload>`: re-parse its argument as a command string.
    if (ev.verb === 'eval') {
      if (d < 3) {
        const payload = extractEvalPayload(seg);
        if (payload) {
          const nested = scanCommand(payload, d + 1);
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
          const nested = scanCommand(payload, d + 1);
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

    if (ev.verb !== 'git') continue;

    const { sub, rest } = gitSubcommand(ev.args);
    if (sub === null) continue;

    // --- Rule 2: force push ---
    if (sub === 'push') {
      if (isForcePush(rest)) {
        return (
          'anti-hall git-guard: BLOCKED. Force push detected. Rewriting published ' +
          'history is a deliberate human action - do it manually with explicit ' +
          'owner confirmation, never from an automated push.'
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
    if (sub === 'commit') {
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
        if (m && consultGitGuardSelfCreditJev(m)) {
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
        if (spec === '-' || spec === '/dev/stdin') {
          if (heredocBodies.length) text = heredocBodies.map((h) => h.body).join('\n');
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
        if (SELF_CREDIT_COAUTHOR.test(text) || SELF_CREDIT_GENERATED.test(text)) {
          return (
            'anti-hall git-guard: BLOCKED. Commit message (via `-F`/`--file`, ' +
            'read from a heredoc body or file) contains an AI/assistant self-credit ' +
            'trailer (Co-Authored-By / "Generated with <AI>"). Remove it - commits ' +
            'carry no AI co-author credit. Re-run the commit without that trailer.'
          );
        }
        // JEV ADD-BLOCK (gitGuardSelfCredit) — same twin call as the inline
        // -m/--trailer path above, for a `-F`/`--file`-sourced message.
        if (consultGitGuardSelfCreditJev(text)) {
          return (
            'anti-hall git-guard: BLOCKED. Commit message (via `-F`/`--file`) appears ' +
            'to credit an AI assistant (paraphrased self-credit, flagged by the Jev ' +
            'classifier — not a literal trailer match). Remove it - commits carry no ' +
            'AI co-author credit.'
          );
        }
      }
    }
  }
  return null;
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
  try {
    const payload = JSON.parse(raw);
    const ti = payload && payload.tool_input;
    if (ti && typeof ti.command === 'string') {
      cmd = ti.command;
    }
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

  const msg = scanCommand(cmd, 0);
  if (msg) return block(msg);

  process.exit(0);
}

try {
  main();
} catch (_) {
  fail_open();
}
