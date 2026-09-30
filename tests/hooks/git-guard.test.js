'use strict';
// git-guard (PreToolUse Bash). Block => exit code 2; allow => exit 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';

// Each git-guard invocation gets a fresh fake HOME with no skip.json so the
// escape hatch is inert and the guard is fully active.
function run(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home });
  } finally {
    h.cleanup();
  }
}

// Each BLOCK case asserts BOTH the exit code AND the block REASON (matched
// against stderr). Asserting the reason stops a regression that blocks for the
// WRONG class from staying green — e.g. a force test that silently starts
// blocking via the command-substitution rule instead of force detection.
//
// Reason regexes match the EXACT messages emitted by git-guard.js scanCommand():
//   FORCE    -> 'Force push detected'                 (Rule 2, force flag/+refspec)
//   CMDSUBST -> 'command substitution / backtick'     (Rule 2, $( )/backtick arg)
//   COMMIT   -> 'AI/assistant self-credit trailer'    (Rule 1, inline -m/--trailer)
//   REMAP    -> '-c trailer.*.key=`'                  (Rule 1, trailer-key remap)
const REASON = {
  FORCE: /Force push detected/,
  CMDSUBST: /command substitution \/ backtick/,
  COMMIT: /AI\/assistant self-credit trailer/,
  REMAP: /trailer\.\*\.key=/,
  FILE: /Commit message \(via `-F`\/`--file`/,
};

// --- No exact-shape mailbox exemption: a heredoc message file + anti-hall
// launcher send is scanned exactly like any other heredoc body (round-2
// review R2-1/R2A1-1: the removed exemption's temp-path/target checks were
// literal-string-only, with no symlink resolution, so a planted symlink into
// ~/.anti-hall/bin defeated it). Each of these carries a real force-push
// mention in its body and must BLOCK, with the mailbox hint attached.
const PEER_FILE = '/private/tmp/peer/scratchpad/landed.md';
const HINT_RE = /write the file with the Write tool or the Edit tool/;
const LAUNCHER_MSG_BLOCK_HINTED = [
  {
    cmd: `cat > ${PEER_FILE} <<'ENDOFMSG'\nLANDED ON MAIN. Plain fast-forward, no force - I did not run \`git push --force\` or \`git push -f\`.\nENDOFMSG\nnode ~/.anti-hall/bin/devswarm.js send --to primary --message-file ${PEER_FILE}`,
    reason: REASON.FORCE,
  },
  {
    cmd: "cd /tmp/peer && cat > m.md <<'EOF'\nPlease hold; `git push origin +main` waits for `ci` green.\nEOF\nnode ~/.anti-hall/bin/devswarm.js send --to x --message-file m.md",
    reason: REASON.FORCE,
  },
  {
    cmd: "cd /tmp/peer\ncat > /tmp/m.md <<'MSG'\ngit push `backtick text`\nnever git push --force-with-lease here; && git push -f is banned too\nMSG\nnode ~/.anti-hall/bin/devswarm.js send --to x --urgency high --quiet --message-file /tmp/m.md",
    reason: REASON.CMDSUBST,
  },
  {
    cmd: "cat > /tmp/m.txt <<'EOF'\nstep 3: $(git push --force origin main) is what NOT to do\nEOF\nnode ~/.anti-hall/bin/devswarm.js send --to peer --message 'see file' --message-file /tmp/m.txt",
    reason: REASON.FORCE,
  },
];

// Near misses of that shape: each must fall back to scanning the body (which
// carries a force push) and BLOCK.
const FPB = 'git push --force origin main';
const MSG_SEND = 'node ~/.anti-hall/bin/devswarm.js send --to x --message-file /tmp/m.md';
const HD_MSG = (opener, file) => `${opener || `cat > ${file || '/tmp/m.md'} <<'EOF'`}\n${FPB}\nEOF\n`;
const SEND_TO = (file) => `node ~/.anti-hall/bin/devswarm.js send --to x --message-file ${file}`;
const LAUNCHER_MSG_BLOCK = [
  // env assignments anywhere
  HD_MSG() + 'FOO=1 ' + MSG_SEND,
  HD_MSG() + 'NODE_OPTIONS=--require=/tmp/m.md ' + MSG_SEND,
  HD_MSG() + 'PATH=. ' + MSG_SEND,
  HD_MSG("X=1 cat > /tmp/m.md <<'EOF'") + MSG_SEND,
  HD_MSG() + MSG_SEND + ' GIT_PAGER=sh',
  HD_MSG() + 'env ' + MSG_SEND,
  // forbidden targets
  HD_MSG(null, '.git/config') + SEND_TO('.git/config'),
  HD_MSG(null, '.GIT/config') + SEND_TO('.GIT/config'),
  HD_MSG(null, 'repo/.git/info/m.md') + SEND_TO('repo/.git/info/m.md'),
  "cd .git && cat > config <<'EOF'\n" + FPB + '\nEOF\n' + SEND_TO('config'),
  "cd .git\ncat > config <<'EOF'\n" + FPB + '\nEOF\n' + SEND_TO('config'),
  HD_MSG(null, '.gitconfig') + SEND_TO('.gitconfig'),
  HD_MSG(null, '.gitmodules') + SEND_TO('.gitmodules'),
  HD_MSG(null, '.gitattributes') + SEND_TO('.gitattributes'),
  HD_MSG(null, 'hooks/pre-commit') + SEND_TO('hooks/pre-commit'),
  HD_MSG(null, '/home/u/.anti-hall/bin/devswarm.js') + SEND_TO('/home/u/.anti-hall/bin/devswarm.js'),
  HD_MSG(null, '/tmp/a/../.git/config') + SEND_TO('/tmp/a/../.git/config'),
  HD_MSG(null, '$HOME/m.md') + SEND_TO('$HOME/m.md'),
  HD_MSG(null, '/tmp/`id`.md') + SEND_TO('/tmp/`id`.md'),
  HD_MSG(null, '~root/m.md') + SEND_TO('~root/m.md'),
  HD_MSG(null, '/tmp/*.md') + SEND_TO('/tmp/*.md'),
  // send args: substitutions, redirects, unknown flags, file mismatch
  HD_MSG() + MSG_SEND + ' --message "$(sh /tmp/m.md)"',
  HD_MSG() + MSG_SEND + ' --message "`sh /tmp/m.md`"',
  HD_MSG() + MSG_SEND + ' --message $(sh /tmp/m.md)',
  HD_MSG() + MSG_SEND + ' <(sh /tmp/m.md)',
  HD_MSG() + MSG_SEND + ' >(sh)',
  HD_MSG() + MSG_SEND + ' > /tmp/out',
  HD_MSG() + MSG_SEND + ' 2>/tmp/err',
  HD_MSG() + MSG_SEND + ' --exec /tmp/m.md',
  HD_MSG() + MSG_SEND + ' --message-file /tmp/m.md',
  HD_MSG() + SEND_TO('/tmp/other.md'),
  HD_MSG() + 'node ~/.anti-hall/bin/devswarm.js send --to x',
  // wrong launcher / subcommand
  HD_MSG() + 'node ~/.anti-hall/bin/devswarm.js roster --message-file /tmp/m.md',
  HD_MSG() + 'node ~/.anti-hall/bin/wake-watch.js send --to x --message-file /tmp/m.md',
  HD_MSG() + 'node ./devswarm.js send --to x --message-file /tmp/m.md',
  HD_MSG() + 'sh ~/.anti-hall/bin/devswarm.js send --to x --message-file /tmp/m.md',
  HD_MSG() + 'node /tmp/m.md send --to x --message-file /tmp/m.md',
  // any extra segment, pipe, && / ; / || chaining, or background &
  HD_MSG() + MSG_SEND + '; sh /tmp/m.md',
  HD_MSG() + MSG_SEND + ' && sh /tmp/m.md',
  HD_MSG() + MSG_SEND + ' || true',
  HD_MSG() + MSG_SEND + ' | sh',
  HD_MSG() + MSG_SEND + ' &',
  HD_MSG() + MSG_SEND + '\nsh /tmp/m.md',
  HD_MSG() + MSG_SEND + '\ngit status',
  HD_MSG() + 'git status\n' + MSG_SEND,
  'true\n' + HD_MSG() + MSG_SEND,
  'true && ' + HD_MSG() + MSG_SEND,
  'cd /tmp && true && ' + HD_MSG() + MSG_SEND,
  'cd /tmp\ncd /tmp\n' + HD_MSG() + MSG_SEND,
  'cd $(sh /tmp/m.md)\n' + HD_MSG() + MSG_SEND,
  HD_MSG("cat > /tmp/m.md <<'EOF' | sh") + MSG_SEND,
  HD_MSG("cat > /tmp/m.md <<'EOF' && sh /tmp/m.md") + MSG_SEND,
  HD_MSG("cat > /tmp/m.md <<'EOF' &") + MSG_SEND,
  HD_MSG("cat > /tmp/m.md > /tmp/n.md <<'EOF'") + MSG_SEND,
  HD_MSG("cat >> /tmp/m.md <<'EOF'") + MSG_SEND,
  HD_MSG("tee /tmp/m.md <<'EOF'") + MSG_SEND,
  HD_MSG("cat <<'EOF' > /tmp/m.md") + MSG_SEND,
  // delimiter forms other than a single-quoted <<'DELIM'
  HD_MSG('cat > /tmp/m.md <<EOF') + MSG_SEND,
  HD_MSG('cat > /tmp/m.md <<"EOF"') + MSG_SEND,
  HD_MSG("cat > /tmp/m.md <<-'EOF'") + MSG_SEND,
  HD_MSG("cat > /tmp/m.md <<'EOF'\r") + MSG_SEND,
  // delimiter smuggled mid-body, then a real command before the send
  "cat > /tmp/m.md <<'EOF'\nprose\nEOF\n" + FPB + '\nEOF\n' + MSG_SEND,
  // unterminated
  "cat > /tmp/m.md <<'EOF'\n" + FPB + '\n' + MSG_SEND,
  // F1 (P0): the exemption used a DENYLIST of forbidden targets, so a target
  // outside the denylist but outside any temp/scratch dir too (the user's
  // real git config dir) was wrongly exempted and its `[alias]`/`[trailer]`
  // body written verbatim to git's real global config. Now allowlisted to
  // temp dirs only, so this must fall back to a normal scan and block on the
  // force-push alias body.
  "cd ~/.config/git && cat > config <<'MSGEOF'\n[alias]\nx = !git push --force origin main\n[trailer \"ai\"]\nkey = Co-Authored-By\nMSGEOF\nnode ~/.anti-hall/bin/devswarm.js send --message-file config --to x",
  // Same shape, no `[alias]`/`[trailer]` body — still not exempt (real home
  // config dir, not temp), so the prose falls back to a normal scan; assert
  // it still doesn't block for the WRONG (non-exemption) path by using a body
  // containing a real force push instead of only prose.
  "cd ~/.config/git && cat > config <<'MSGEOF'\n" + FPB + "\nMSGEOF\nnode ~/.anti-hall/bin/devswarm.js send --message-file config --to x",
  // A1-1: a `.`/doubled-slash/`../` trick in the message-file TARGET must not
  // dodge the forbidden-segment checks (.git/.anti-hall+bin) once resolved.
  "cat > /tmp/a/./.git/config <<'EOF'\n" + FPB + "\nEOF\n" + SEND_TO('/tmp/a/./.git/config'),
  "cat > /tmp//.git/config <<'EOF'\n" + FPB + "\nEOF\n" + SEND_TO('/tmp//.git/config'),
  "cat > ~/.anti-hall/./bin/x <<'EOF'\n" + FPB + "\nEOF\n" + SEND_TO('~/.anti-hall/./bin/x'),
  // Defense in depth: even when the target IS a temp path, a message body
  // that itself looks like a config line (`[alias] x = !git push --force`)
  // must still be scanned, not blanked away by the exemption.
  "cat > /tmp/m.md <<'EOF'\n[alias]\nx = !git push --force origin main\nEOF\n" + SEND_TO('/tmp/m.md'),
];

// Every deadly-loop round-1/round-2 git-guard probe (probe scripts gg-probes,
// rv1-gg-more, aud1 c1-c3) that the pre-exemption guard blocks: the exemption
// must not open any of them.
const HDP = (file, body, op) => `cat <<'EOF' ${op || '>'} ${file}\n${body}\nEOF\n`;
const HDW = `cat > x.sh <<'EOF'\n${FPB}\nEOF\n`;
const DEADLY_LOOP_PROBES = [
  `cat <<'EOF' > Makefile\nrun:\n\t${FPB}\nEOF\nmake run`,
  HDP('x.sh', FPB) + 'PATH=. x.sh',
  HDP('x.sh', FPB) + 'find . -name x.sh -exec {} \\;',
  HDP('x.sh', FPB) + 'hash -p ./x.sh mycmd; mycmd',
  HDP('.git/hooks/pre-commit', FPB) + 'git commit -m x',
  HDP('x.sh', FPB) + "git -c alias.x='!sh x.sh' x",
  `cat <<-'EOF' > Makefile\nrun:\n\t${FPB}\nEOF\nmake run`,
  "git -c alias.x='!git push --force' x",
  "git -c alias.x='!sh -c \"git push --force\"' x",
  "git -c alias.x='!sh -c \"git push -f origin main\"' x",
  "git -c alias.x='!f() { git push --force; }; f' x",
  "git -c alias.x='!eval \"git push --force\"' x",
  "git -c alias.x=\"!sh -c 'git push --force'\" x",
  "git -c alias.x='!git push origin +main' x",
  "git -c alias.x='!git fetch; git push --force' x",
  "git -c alias.x='!(git push --force)' x",
  HDP('~/.anti-hall/bin/devswarm.js', FPB) + 'node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.js', FPB) + 'NODE_OPTIONS=--require=./x.js node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.sh', FPB) + HDP('.git/config', '[core]\n\tfsmonitor = sh x.sh', '>>') + 'git status',
  `cat <<'EOF' | tee x.sh\n${FPB}\nEOF\ncat <<'EOF' | tee -a .git/config\n[core]\n\tfsmonitor = sh x.sh\nEOF\ngit status`,
  HDP('x.sh', FPB) + 'echo $(sh x.sh)',
  HDP('x.sh', FPB) + 'echo `sh x.sh`',
  HDP('x.sh', FPB) + 'cat $(sh x.sh)',
  HDP('x.sh', FPB) + 'ls $(sh x.sh)',
  HDP('x.sh', FPB) + 'cd $(sh x.sh)',
  HDP('x.sh', FPB) + 'git log $(sh x.sh)',
  HDP('x.sh', FPB) + 'git -c diff.external="sh x.sh" diff',
  HDP('x.sh', FPB) + 'git --no-pager -c core.fsmonitor="sh x.sh" status',
  HDP('x.sh', FPB) + 'printf x > >(sh x.sh)',
  HDP('x.sh', FPB) + 'echo <(sh x.sh)',
  HDP('x.sh', FPB) + 'head <(sh x.sh)',
  HDP('x.sh', FPB) + 'true $(sh x.sh)',
  HDP('x.sh', FPB) + 'git status --ignored=$(sh x.sh)',
  `cat <<EOF > x\n$(${FPB})\nEOF`,
  HDP('x.sh', FPB) + 'cat ${X:-$(sh x.sh)}',
  HDP('node', `#!/bin/sh\n${FPB}`) + 'PATH=. node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.sh', FPB) + "GIT_PAGER='sh x.sh' git log",
  HDP('x.sh', FPB) + "GIT_EXTERNAL_DIFF='sh x.sh' git diff",
  HDP('x.sh', FPB) + "GIT_CONFIG_PARAMETERS=\"'core.fsmonitor=sh x.sh'\" git status",
  HDP('x.sh', FPB) + HDP('.git/config', '[core]\n\tpager = sh x.sh', '>>') + 'git log',
  HDP('x.sh', FPB) + HDP('~/.gitconfig', '[core]\n\tpager = sh x.sh') + 'git show',
  HDP('x.sh', FPB) + HDP('.git/config', '[diff]\n\texternal = sh x.sh', '>>') + 'git diff',
  HDP('x.sh', FPB) + 'NODE_OPTIONS=--require=./x.sh node ~/.anti-hall/bin/devswarm.js roster',
  HDP('node', `#!/bin/sh\n${FPB}`) + 'PATH=. node ~/.anti-hall/bin/wake-watch.js',
  HDW + 'sh x.sh',
  HDW + 'GIT_EXTERNAL_DIFF=./x.sh git diff',
  HDW + "PAGER='sh x.sh' git log",
  HDW + 'echo "$(sh x.sh)"',
  HDW + 'echo "`sh x.sh`"',
  HDW + 'cat <(sh x.sh)',
  HDW + 'ls "$(sh x.sh)"',
  HDW + 'node ~/.anti-hall/bin/devswarm.js send --to a "$(sh x.sh)"',
  HDW + 'cd "$(sh x.sh)"',
  HDW + 'git status "$(sh x.sh)"',
  `tee x.sh <<'EOF' >/dev/null\n${FPB}\nEOF\nsh x.sh`,
  HDW + 'true $(sh x.sh)',
  HDW + 'head -n "$(sh x.sh)" x.sh',
  `cat > x.sh <<'EOF'\ngit push --force origin HEAD:refs/heads/main\nEOF\necho "$(sh x.sh)"`,
  HDW + "GIT_SSH_COMMAND='sh x.sh' git status",
  `cat > x.txt <<'EOF'\n${FPB}\nEOF\ngit status`,
];

const BLOCK = [
  // --- Force push (Rule 2): literal force flags / +refspec ---
  { cmd: 'git push --force', reason: REASON.FORCE },
  { cmd: 'git push -f', reason: REASON.FORCE },
  { cmd: 'git push --force-with-lease', reason: REASON.FORCE },
  { cmd: 'git push origin +main', reason: REASON.FORCE },
  { cmd: 'git push origin -- +main:main', reason: REASON.FORCE },
  // Synthetic-force via inline alias and --config-env alias smuggling. These
  // exercise the force-detection path (gitSubcommand ~lines 394/438 -> synthetic
  // `--force`), NOT the command-substitution rule — so they genuinely test force
  // logic. Verified the block message is the FORCE message, not cmd-subst.
  { cmd: 'git -c alias.p=push p origin main --force', reason: REASON.FORCE },
  { cmd: 'git --config-env alias.p=push p origin main --force', reason: REASON.FORCE },
  // Force baked INTO the alias body (no --force at the call site): the body's
  // `--force` must reach isForcePush. Blocker is FORCE, not cmd-subst.
  { cmd: "git -c alias.p='push --force origin main' p", reason: REASON.FORCE },
  // --config-env alias smuggling with NO call-site --force: the alias key alone
  // forces a synthetic force verdict. Confirms FORCE path, not cmd-subst.
  { cmd: 'git --config-env alias.p=push p origin main', reason: REASON.FORCE },
  // `!shell` alias bodies whose force flag is glued to a closing quote, `;`,
  // or `)` (R2-RV1-4): the body tokens are normalized before isForcePush.
  { cmd: "git -c alias.x='!sh -c \"git push --force\"' x", reason: REASON.FORCE },
  { cmd: "git -c alias.x='!f() { git push --force; }; f' x", reason: REASON.FORCE },
  { cmd: "git -c alias.x='!eval \"git push --force\"' x", reason: REASON.FORCE },
  { cmd: "git -c alias.x=\"!sh -c 'git push --force'\" x", reason: REASON.FORCE },
  { cmd: "git -c alias.x='!(git push --force)' x", reason: REASON.FORCE },
  // An inner `--` of another command in the shell body does not disarm it.
  { cmd: "git -c alias.x='!git log -- x; git push --force' x", reason: REASON.FORCE },
  { cmd: 'sudo git push --force', reason: REASON.FORCE },
  { cmd: 'true && git push -f', reason: REASON.FORCE },
  { cmd: 'eval "git push -f"', reason: REASON.FORCE },
  // --- Command substitution (Rule 2): NOT a force test ---
  // This blocks via the command-substitution rule (an arg produced by $( ) that
  // could smuggle --force), NOT force detection. Proven: `git push origin
  // "$(echo main)"` (no --force) also blocks with this SAME cmd-subst message, so
  // asserting CMDSUBST here is what this case actually verifies. Genuine force
  // detection is covered by the alias/--config-env cases above.
  { cmd: 'git push origin "$(echo --force)"', reason: REASON.CMDSUBST },
  // Companion proof: no --force present, still blocks for the same cmd-subst
  // reason — confirms the rule is about the un-inspectable expansion, not force.
  { cmd: 'git push origin "$(echo main)"', reason: REASON.CMDSUBST },
  // --- Self-credit in inline commit message (Rule 1) ---
  { cmd: 'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX 1: --trailer carries the AI co-author trailer on the command line.
  { cmd: 'git commit -m x --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  { cmd: 'git commit -m x --trailer="Co-Authored-By: Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX A.1: git accepts the `key=value` trailer separator too.
  { cmd: 'git commit -m x --trailer "Co-Authored-By=Claude <noreply@anthropic.com>"', reason: REASON.COMMIT },
  // FIX A.2: `-c trailer.<name>.key=<self-credit>` remaps a benign token to emit
  // a Co-Authored-By trailer, dodging the value scan. Blocker is the REMAP rule.
  { cmd: 'git -c trailer.ai.key=Co-Authored-By commit -m x --trailer "ai: Claude <noreply@anthropic.com>"', reason: REASON.REMAP },
  // --- P0-1: `bash -c "..."` / `sh -c "..."` shell-wrapper recursion ---
  // A shell wrapper's verb is not `git`, so without recursing the -c payload
  // these force/self-credit forms would fail-open (total guard bypass). Mirror
  // the eval unwrap: recurse the payload and block on the inner git violation.
  { cmd: 'bash -c "git push --force"', reason: REASON.FORCE },
  { cmd: 'sh -c "git push --force origin main"', reason: REASON.FORCE },
  { cmd: 'zsh -c "git push -f"', reason: REASON.FORCE },
  { cmd: 'sudo bash -c "git push --force"', reason: REASON.FORCE },
  { cmd: `bash -c "git commit -m x --trailer 'Co-Authored-By: Claude <noreply@anthropic.com>'"`, reason: REASON.COMMIT },
  // --- P1: `&` inside a redirection (2>&1 / >&2 / &>) is NOT a control-op ---
  // Splitting on that `&` orphaned a trailing `--force` into a non-git segment
  // so the force flag was never inspected. The push must still block.
  { cmd: 'git push origin main 2>&1 --force', reason: REASON.FORCE },
  { cmd: 'git push origin main >&2 --force', reason: REASON.FORCE },
  { cmd: 'git push origin main &>out.log --force', reason: REASON.FORCE },
  // --- R3A1-1 (round 3): `>|`/`2>|` is the clobber-redirect operator, NOT a
  // pipe. splitSegments treated the `|` after `>` as a control-op pipe,
  // orphaning a trailing --force/trailer into a bogus non-git fake segment
  // (bypass predates this round; fixed alongside it).
  { cmd: 'git push origin main >|/tmp/out --force', reason: REASON.FORCE },
  { cmd: 'git push origin main 2>|/tmp/e --force', reason: REASON.FORCE },
  { cmd: 'git push >|/tmp/o --force-with-lease origin main', reason: REASON.FORCE },
  {
    cmd: `git commit -m x >|/tmp/o --trailer 'Co-Authored-By: Claude <noreply@anthropic.com>'`,
    reason: REASON.COMMIT,
  },
  // --- `-F -` / `--file=-` fed by a heredoc (Rule 1, the F-22 fix) ---
  // A `git commit -F -`/`--file=-` reads its message from stdin; when that
  // stdin is a heredoc ON THE SAME command line, the guard must scan the body
  // exactly like an inline -m message. Prior to the fix, the heredoc body's
  // own newlines fragmented it into unrelated segments and the trailer never
  // reached a `git`-verb segment (confirmed bypass, defect report).
  {
    cmd: 'git commit -q -F - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // Unquoted delimiter (<<EOF, not <<'EOF') must ALSO be recognized.
  {
    cmd: 'git commit -F - <<EOF\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `--file=-` long-flag form.
  {
    cmd: 'git commit --file=- <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `--file -` separate-token form.
  {
    cmd: 'git commit --file - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // `-F /dev/stdin` explicit-path spelling of stdin.
  {
    cmd: 'git commit -F /dev/stdin <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
    reason: REASON.FILE,
  },
  // A1-4: `-F -` fed by a PIPE (no heredoc at all) from a producer whose
  // trailer sits in its own quoted argument, with no heredoc and no real/
  // `\n`-escaped newline directly in front of it in the raw command text —
  // `heredocBodies` alone missed this (empty), and the whole-command scan
  // requires a line-start anchor the printf format-string placeholder breaks.
  {
    cmd: "printf 'subject\\n\\n%s' \"Co-Authored-By: Claude <noreply@anthropic.com>\" | git commit -F -",
    reason: REASON.FILE,
  },
  // Same shape via `--file=-`.
  {
    cmd: "printf '%s' \"Generated with [Claude Code](https://claude.com/claude-code)\" | git commit --file=-",
    reason: REASON.FILE,
  },
  // --- P0 REGRESSION REPROS (security review, reworked patch) ---
  // A heredoc opener line's TRAILING control operator (&&, ;, |, |&) chains a
  // SEPARATE command that runs after the heredoc body is consumed. A prior
  // version of this fix folded heredoc-body consumption INTO splitSegments
  // itself and appended "the rest of the opener line" (including the chained
  // `&& git push --force ...`) into the SAME segment as the heredoc-opening
  // command verbatim, without re-splitting on the operator — so the chained
  // command's own verb/flags were never inspected as their own segment
  // (confirmed base=BLOCKED / that patched=ALLOWED bypass). splitSegments is
  // now byte-identical to base, so these must block exactly like base does
  // (each simply splits on the operator; the heredoc body's line-by-line
  // fragmentation is incidental to base's plain `\n`-splits, not a heredoc
  // feature of this fix).
  { cmd: 'cat <<EOF && git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF ; git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF | git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<EOF |& git push --force origin main\nbody\nEOF', reason: REASON.FORCE },
  { cmd: 'cat <<-EOF && git push --force origin main\n\tbody\n\tEOF', reason: REASON.FORCE },
  // Unterminated heredoc: base has no heredoc awareness at all, so the
  // `git push --force origin main` line is just its own `\n`-split segment
  // regardless of any (missing) terminator — must still block.
  { cmd: 'cat <<EOF\ngit push --force origin main', reason: REASON.FORCE },
  // --- Heredoc bodies are ALWAYS scanned (no data exemption). A 0.116
  // candidate blanked quoted heredoc bodies written by data consumers; it
  // failed two security review rounds (write-then-run executors, config-driven
  // read-only git verbs, env-prefixed launchers, "$(...)" arguments) and was
  // reverted. Every shape below must keep blocking. ---
  // A body piped to / read by a shell.
  { cmd: "cat <<'EOF' | bash\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "bash <<'EOF'\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' | sudo sh -s\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' | xargs -I{} sh -c {}\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' | python3 -c 'import os,sys; os.system(sys.stdin.read())'\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' |\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  // Written to a file, then run in the same command.
  { cmd: "cat > /tmp/x.sh <<'EOF'\ngit push --force origin main\nEOF\nbash /tmp/x.sh", reason: REASON.FORCE },
  { cmd: "cat > /tmp/x.sh <<'EOF'\ngit push --force origin main\nEOF\nsource /tmp/x.sh", reason: REASON.FORCE },
  { cmd: "cat > /tmp/x.sh <<'EOF'\ngit push --force origin main\nEOF\n/tmp/x.sh", reason: REASON.FORCE },
  { cmd: "node run.js <<'EOF'\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "(cat <<'EOF') | cat\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: 'cat > f <<EOF\ngit push $(echo --force)\nEOF', reason: REASON.CMDSUBST },
  { cmd: "cat > f <<'EOF' && git push --force origin main\nprose\nEOF", reason: REASON.FORCE },
  { cmd: "cat > f <<'EOF'\nprose\nEOF\ngit push --force origin main", reason: REASON.FORCE },
  { cmd: "cat > f <<'EOF'\ngit push --force origin main", reason: REASON.FORCE },
  // Write-then-run executors (deadly-loop round 1).
  { cmd: "cat > Makefile <<'EOF'\nall:\n\tgit push --force origin main\nEOF\nmake", reason: REASON.FORCE },
  { cmd: "cat > Makefile <<-'EOF'\n\tgit push --force origin main\nEOF\nmake", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\nPATH=. x.sh", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\nenv PATH=. x.sh", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\nfind . -name x.sh -exec {} \\;", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\nhash -p ./x.sh x; x", reason: REASON.FORCE },
  { cmd: "cat > .git/hooks/pre-commit <<'EOF'\ngit push --force origin main\nEOF\nchmod +x .git/hooks/pre-commit\ngit commit -m x", reason: REASON.FORCE },
  { cmd: "cat > .git/hooks/pre-push <<'EOF'\ngit push --force origin main\nEOF\nchmod +x .git/hooks/pre-push\ngit push origin main", reason: REASON.FORCE },
  { cmd: "git -c alias.x='!sh' x <<'EOF'\ngit push --force origin main\nEOF", reason: REASON.FORCE },
  { cmd: "cat <<-'EOF' > /tmp/m.md\n\tgit push --force\n\tEOF\ngit push origin main", reason: REASON.FORCE },
  // Read-only git verbs that run programs from env or config (round 2,
  // R2-RV1-1 / R2A1-GG-1): pager, external diff, fsmonitor.
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\nGIT_PAGER='sh x.sh' git log", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\nGIT_EXTERNAL_DIFF='sh x.sh' git diff", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\nGIT_CONFIG_PARAMETERS=\"'core.fsmonitor=sh x.sh'\" git status", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\ncat <<'EOF' >> .git/config\n[core]\n\tpager = sh x.sh\nEOF\ngit log", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\ncat <<'EOF' > ~/.gitconfig\n[core]\n\tpager = sh x.sh\nEOF\ngit show", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\ncat <<'EOF' >> .git/config\n[diff]\n\texternal = sh x.sh\nEOF\ngit diff", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\ncat <<'EOF' >> .git/config\n[core]\n\tfsmonitor = sh x.sh\nEOF\ngit status", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' | tee x.sh\ngit push --force origin main\nEOF\ncat <<'EOF' | tee -a .git/config\n[core]\n\tfsmonitor = sh x.sh\nEOF\ngit status", reason: REASON.FORCE },
  // Env-prefixed stable launcher (R2-RV1-3).
  { cmd: "cat <<'EOF' > x.sh\ngit push --force origin main\nEOF\nNODE_OPTIONS=--require=./x.sh node ~/.anti-hall/bin/devswarm.js roster", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > node\n#!/bin/sh\ngit push --force origin main\nEOF\nPATH=. node ~/.anti-hall/bin/wake-watch.js", reason: REASON.FORCE },
  { cmd: "cat <<'EOF' > node\n#!/bin/sh\ngit push --force origin main\nEOF\nPATH=. node ~/.anti-hall/bin/devswarm.js roster", reason: REASON.FORCE },
  // A double-quoted "$(...)" argument runs the written script (R2-RV1-2).
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\necho \"$(sh x.sh)\"", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\nprintf \"%s\" \"$(sh x.sh)\"", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\ncd \"$(sh x.sh)\"", reason: REASON.FORCE },
  { cmd: "cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\ngit log \"$(sh x.sh)\"", reason: REASON.FORCE },
  // Prose heredocs outside the exact launcher-send shape: still scanned.
  { cmd: 'cat > /tmp/m.md <<"EOF"\nstep: && git push --force `x`\nEOF', reason: REASON.FORCE },
];

const ALLOW = [
  'git push origin main',
  'git push origin -- main',
  'git status',
  'git commit -m "feat: x"',
  'eval "git status"',
  // FIX 1: a benign trailer (human reviewer) must NOT be blocked.
  'git commit -m x --trailer "Reviewed-by: Alice"',
  // FIX A.1: a benign `=`-form trailer must still ALLOW.
  'git commit -m x --trailer "Reviewed-by=Alice"',
  // FIX A.2: a non-self-credit `-c trailer.*.key=` remap stays allowed.
  'git -c trailer.sob.key=Signed-off-by commit -m x --trailer "sob: Alice"',
  // P0-1: a benign shell-wrapped command must NOT be over-blocked.
  'bash -c "git status"',
  'sh -c "npm test"',
  'bash -c "git push origin main"',
  // P1: a legitimate push with a redirection (no force) must still ALLOW —
  // the redirection `&` must not be misread as force, nor over-block.
  'git push origin main 2>&1',
  'git push origin main &>out.log',
  // `-F -` fed by a heredoc with NO self-credit trailer must still ALLOW —
  // proves the new heredoc-body scan doesn't over-block ordinary messages.
  'git commit -q -F - <<\'EOF\'\nsubject\n\nordinary body, no trailer\nEOF',
  'git commit -F - <<EOF\nsubject\n\nordinary body, no trailer\nEOF',
  // A mailbox-shaped heredoc with NO force/self-credit/cmdsubst mention in its
  // body must still ALLOW - there is no exemption anymore, but the body is
  // just ordinary scanned text, and ordinary text is not blocked.
  "cat > /tmp/m.md <<'EOF'\nLanded cleanly, no issues.\nEOF\nnode ~/.anti-hall/bin/devswarm.js send --to x --message-file /tmp/m.md",
];

// gh self-credit BLOCK cases. All block via ghSelfCreditMessage(), whose message
// names the body/title self-credit. Assert that exact reason class so a
// regression blocking for some other reason can't pass.
const GH_REASON = /gh pr\/issue\/release body or title carries/;
const GH_BLOCK = [
  'gh pr create --title x --body "Done.\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
  'gh issue create --body "Co-Authored-By: Claude <noreply@anthropic.com>"',
  'gh pr edit 5 --body "see claude.com/claude-code"',
  'gh pr create --body="🤖 Generated with Claude Code"',
];

// gh self-credit ALLOW cases
const GH_ALLOW = [
  'gh pr create --title x --body "Fixes the parser bug"',
  'gh pr create --body-file /tmp/body.md',
  'gh release view',
  'gh pr list',
];

for (const { cmd, reason } of BLOCK) {
  test(`BLOCK: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      reason,
      `blocked for the WRONG reason: ${cmd}\nexpected ${reason}\ngot: ${r.stderr}`,
    );
  });
}

for (const cmd of [...LAUNCHER_MSG_BLOCK, ...DEADLY_LOOP_PROBES]) {
  test(`BLOCK (launcher-message exemption does not apply): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// R2-1/R2A1-1: the mailbox heredoc exemption was removed entirely. Every one
// of the peer's original "should be exempt" shapes now blocks on its real
// content (no more exemption to bypass), and the block reason carries a
// one-line hint pointing at the Write-tool + send --message-file workflow.
for (const { cmd, reason } of LAUNCHER_MSG_BLOCK_HINTED) {
  test(`BLOCK (no mailbox exemption, hinted): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, reason, `blocked for the WRONG reason: ${cmd}\ngot: ${r.stderr}`);
    assert.match(r.stderr, HINT_RE, `expected mailbox hint in block reason: ${cmd}\ngot: ${r.stderr}`);
  });
}

// Peer report (hooks 0.115.2): a NON-mailbox heredoc-into-a-file write (e.g.
// a handover file, no devswarm.js/--message-file in sight) whose prose merely
// MENTIONS `git push` next to backticks gets blocked on the command-subst
// rule and must carry the SAME generalized hint (looksLikeFileWriteShape),
// not just the old devswarm-mailbox-only shape.
const FILE_WRITE_BLOCK_HINTED = [
  {
    // cat > f <<'EOF' ... EOF - the exact peer repro shape.
    cmd: "cat > .anti-hall/handovers/2026-09-28/sess1/HANDOVER.md <<'EOF'\n## Next steps\nRun `git push` to publish.\nEOF\n",
    reason: REASON.CMDSUBST,
  },
  {
    // tee f <<EOF ... EOF (no `>`/cat at all) - the heredoc body carries a
    // real force-push mention, so it blocks on Rule 2 directly.
    cmd: "tee /tmp/notes.md <<'EOF'\ndo not run `git push --force` here\nEOF\n",
    reason: REASON.FORCE,
  },
  {
    // echo redirected into a file (no heredoc) - a command-valued config
    // line (Rule "command-valued config/env") is the real block shape for a
    // bare echo/printf-into-file (an echoed literal string alone is inert;
    // see CONFIG_VALUE_BLOCK below for the general form of this rule).
    cmd: 'echo "[core] pager = git push --force origin main" > /tmp/gitconfig-notes.md',
    reason: REASON.FORCE,
  },
  {
    // printf appended into a file (no heredoc), same config-value shape.
    cmd: 'printf "%s\\n" "[core] pager = git push --force origin main" >> /tmp/gitconfig-notes.md',
    reason: REASON.FORCE,
  },
];
for (const { cmd, reason } of FILE_WRITE_BLOCK_HINTED) {
  test(`BLOCK (heredoc/echo/printf-into-file, hinted): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, reason, `blocked for the WRONG reason: ${cmd}\ngot: ${r.stderr}`);
    assert.match(r.stderr, HINT_RE, `expected file-write hint in block reason: ${cmd}\ngot: ${r.stderr}`);
  });
}

// A plain blocked command with no heredoc/echo/printf-into-file shape (just a
// `git push` whose argument is a command substitution) must NOT get the hint
// - it isn't writing any file content, so the hint would be a non-sequitur.
const PLAIN_BLOCK_NO_HINT = [
  'git push $(echo origin) main',
  'git push origin `echo main`',
];
for (const cmd of PLAIN_BLOCK_NO_HINT) {
  test(`BLOCK (no file-write shape, no hint): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.CMDSUBST, `blocked for the WRONG reason: ${cmd}\ngot: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, HINT_RE, `unexpected file-write hint in block reason: ${cmd}\ngot: ${r.stderr}`);
  });
}

// Command-valued config/env: git runs these values as commands (pager,
// fsmonitor, diff.external, sshCommand, `!` aliases). A force push written as
// the VALUE must block, whether set by env, `-c`, `git config`, or a config
// line written by a heredoc/echo/printf to any file.
const CONFIG_VALUE_BLOCK = [
  `cat > .git/config <<'EOF'\n[core]\n\tpager = ${FPB}\nEOF\ngit log`,
  `cat >> .git/config <<'EOF'\n[core]\n\tpager = sh -c '${FPB}'\nEOF\ngit log`,
  `cat >> .git/config <<'EOF'\n[core]\n\tfsmonitor = ${FPB}\nEOF\ngit status`,
  `cat >> .git/config <<'EOF'\n[diff]\n\texternal = ${FPB}\nEOF\ngit diff`,
  `cat >> ~/.config/git/work.inc <<'EOF'\n[alias]\n\tx = !${FPB}\nEOF\ngit x`,
  `cat >> .git/config <<'EOF'\n[alias]\n\tx = push --force\nEOF\ngit x`,
  `GIT_PAGER='${FPB}' git log`,
  `GIT_EXTERNAL_DIFF='${FPB}' git diff`,
  `GIT_SSH_COMMAND='${FPB}' git fetch`,
  `export GIT_PAGER='${FPB}'; git log`,
  `env GIT_PAGER='${FPB}' git log`,
  `GIT_CONFIG_PARAMETERS="'core.pager=${FPB}'" git log`,
  `git -c core.pager='${FPB}' log`,
  `git -c core.sshCommand='${FPB}' fetch`,
  `git config core.pager '${FPB}'; git log`,
  `git config --file .git/config alias.x '!${FPB}'; git x`,
  "git config alias.x 'push --force'; git x",
  `echo '[core] pager = ${FPB}' >> .git/config; git log`,
  `echo -e '[core]\\n\\tfsmonitor = ${FPB}' >> ~/.gitconfig; git status`,
  `printf '[alias]\\n\\tx = !${FPB}\\n' >> "$GIT_CONFIG"; git x`,
];
const CONFIG_VALUE_ALLOW = [
  'git config user.name "Jane Doe"',
  "git config core.pager 'less -R'; git log",
  'git -c core.pager=cat log',
  'GIT_PAGER=less git log',
  "echo '[user] name = x' >> ~/.gitconfig",
  "cat >> .git/config <<'EOF'\n[alias]\n\tst = status\n\tlg = !git log --oneline\nEOF\ngit st",
  `git commit -m "fix(git-guard): block the pager = ${FPB} config form"`,
  `cat <<'EOF' > /tmp/msg\nnever run ${FPB}, pager = less\nEOF\ngit status`,
  'git push origin main',
];
for (const cmd of CONFIG_VALUE_BLOCK) {
  test(`BLOCK (command-valued config/env): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  });
}
for (const cmd of CONFIG_VALUE_ALLOW) {
  test(`ALLOW (command-valued config/env): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// Writes into ~/.anti-hall/bin/ (the stable launchers) are blocked outright:
// an overwritten launcher runs arbitrary code under a trusted name.
const LAUNCHER_WRITE_BLOCK = [
  "cat > ~/.anti-hall/bin/devswarm.js <<'EOF'\nrequire('child_process').execSync(process.env.X)\nEOF\nnode ~/.anti-hall/bin/devswarm.js send",
  "echo 'x' > \"$HOME/.anti-hall/bin/wake-watch.js\"",
  'echo x >>~/.anti-hall/bin/devswarm.js',
  'echo hi | tee ~/.anti-hall/bin/devswarm.js',
  'cp /tmp/evil.js ~/.anti-hall/bin/devswarm.js && node ~/.anti-hall/bin/devswarm.js roster',
  'mv /tmp/evil.js /Users/u/.anti-hall/bin/',
  'install -m 755 /tmp/evil.js ~/.anti-hall/bin/devswarm.js',
  'ln -sf /tmp/evil.js ~/.anti-hall/bin/devswarm.js',
  "sed -i '' 's/a/b/' ~/.anti-hall/bin/devswarm.js",
  'dd if=/tmp/evil.js of=$HOME/.anti-hall/bin/devswarm.js',
  'cd ~/.anti-hall/bin && cat > devswarm.js <<\'EOF\'\nx\nEOF',
  // A1-1: textual comparison was bypassable with a `.` segment or doubled
  // slash that LAUNCHER_DIR_RE's regex did not normalize away. Both must
  // still resolve to a `.anti-hall/bin` segment pair and block.
  "cat > ~/.anti-hall/./bin/devswarm.js <<'EOF'\nx\nEOF",
  "cat > ~/.anti-hall//bin/devswarm.js <<'EOF'\nx\nEOF",
  "cat > foo/../.anti-hall/bin/devswarm.js <<'EOF'\nx\nEOF",
  // R3A1-1: `>|` clobber-redirect must resolve to the same target check as
  // a plain `>`.
  "echo x >| ~/.anti-hall/bin/devswarm.js",
  // A quoted redirect target may span newlines: `"$HOME/<NL>/../.anti-hall/bin/x"`
  // collapses to the launcher dir. Every redirect operator form must block.
  'mkdir -p "$HOME/\n"; cat /tmp/evil.js >"$HOME/\n/../.anti-hall/bin/devswarm.js"',
  'echo x >>"$HOME/\n/../.anti-hall/bin/y"',
  'echo x 1>"$HOME/\n/../.anti-hall/bin/y"',
  'echo x &>"$HOME/\n/../.anti-hall/bin/y"',
  'echo x>"$HOME/\n/../.anti-hall/bin/y"',
  'echo x > "$HOME/\n/../.anti-hall/bin/y"',
  "echo x >'/tmp/\n/../..'$HOME/.anti-hall/bin/y",
];
const LAUNCHER_WRITE_ALLOW = [
  'echo x > "/tmp/a\nb/../c.txt"',
  'node ~/.anti-hall/bin/devswarm.js roster',
  'cat ~/.anti-hall/bin/devswarm.js | head',
  'cp ~/.anti-hall/bin/devswarm.js /tmp/x.js',
  'ls -la ~/.anti-hall/bin/',
  'node ~/.anti-hall/bin/devswarm.js roster > /tmp/out.txt 2>&1',
  "sed -n '1,5p' ~/.anti-hall/bin/devswarm.js",
];
for (const cmd of LAUNCHER_WRITE_BLOCK) {
  test(`BLOCK (launcher dir write): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
}
for (const cmd of LAUNCHER_WRITE_ALLOW) {
  test(`ALLOW (launcher dir read): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// Field report (4 workspaces): a prose heredoc body with an ODD apostrophe
// desyncs the quote-aware tokenizer, gluing the body and the later executed
// `node ~/.anti-hall/bin/devswarm.js send ...` line into one token; a `>`/`->`
// in the prose then made the EXECUTED launcher path look like a redirect
// target. Redirect targets are now attributed per line (up to the next
// newline), and EVERY `>` in the glued token is checked so a real write on a
// later line still blocks.
const GLUE_SEND = 'node ~/.anti-hall/bin/devswarm.js send --to x --message-file /abs/m.txt';
const GLUE_HD = (body, tail) => `cat > /abs/m.txt <<'EOF'\n${body}\nEOF\n${tail}`;
const GLUE_ALLOW = [
  GLUE_HD("don't do x -> y", GLUE_SEND),
  GLUE_HD("don't: a => b; it's > 3 (see `x`) 2>&1 force push bump $(c)", GLUE_SEND),
  GLUE_HD("don't\nx >\ny", GLUE_SEND),
  GLUE_HD("isn't it a -> b\nand > c", GLUE_SEND),
  GLUE_HD("don't x >> y", GLUE_SEND),
  GLUE_HD('plain -> arrow, bump and force', GLUE_SEND),
];
const GLUE_BLOCK = [
  GLUE_HD("don't do x -> y", 'echo x > ~/.anti-hall/bin/y'),
  GLUE_HD("don't a -> b\nmore > c", 'echo x > ~/.anti-hall/bin/y'),
  GLUE_HD("don't", 'echo x > ~/.anti-hall/bin/y'),
  GLUE_HD("don't x >", 'echo x >~/.anti-hall/bin/y'),
  GLUE_HD("don't\n->", 'echo x >~/.anti-hall/bin/y'),
  GLUE_HD('fine', 'echo x > ~/.anti-hall/bin/x'),
  GLUE_HD('fine', 'cp a ~/.anti-hall/bin/x'),
  GLUE_HD('fine', 'tee ~/.anti-hall/bin/x'),
  GLUE_HD('fine', 'sed -i s/a/b/ ~/.anti-hall/bin/x'),
  GLUE_HD('fine', 'mv a ~/.anti-hall/bin/x'),
  GLUE_HD('fine', 'echo x > $HOME/.anti-hall/bin/x'),
  GLUE_HD('fine', 'echo x > /Users/u/.anti-hall/bin/x'),
  GLUE_HD('fine', 'cd ~/.anti-hall/bin && echo x > y'),
  // Residual (0.119.0): an odd-quote body glues later lines, hiding non-redirect
  // verbs from the quote-aware pass; the quote-blind launcherBackstop catches them.
  GLUE_HD("don't", 'cp a ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'tee ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'mv a ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'sed -i s/a/b/ ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'install -m 755 a ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'ln -sf a ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'cd ~/.anti-hall/bin && echo x > y'),
  GLUE_HD("don't a -> b", 'cd ~/.anti-hall/bin\necho x > y'),
  GLUE_HD("don't", 'cd ~/.anti-hall/bin\ncp /tmp/a y'),
  GLUE_HD("it's", 'cd $HOME/.anti-hall/bin; sed -i s/a/b/ y'),
  'rsync a ~/.anti-hall/bin/x',
  'rsync -av a b ~/.anti-hall/bin/',
  'ditto a ~/.anti-hall/bin/',
  GLUE_HD("don't", 'rsync a ~/.anti-hall/bin/x'),
  GLUE_HD("don't", 'ditto a ~/.anti-hall/bin/x'),
  'echo x > ~/.anti-hall/bin/x',
  'cp a ~/.anti-hall/bin/x',
  'tee ~/.anti-hall/bin/x',
  'sed -i s/a/b/ ~/.anti-hall/bin/x',
  'mv a ~/.anti-hall/bin/x',
  "cat > ~/.anti-hall/bin/x <<'EOF'\nx\nEOF",
  'echo x > $HOME/.anti-hall/bin/x',
  'echo x > /Users/u/.anti-hall/bin/x',
  'cd ~/.anti-hall/bin && echo x > y',
];
for (const cmd of GLUE_ALLOW) {
  test(`ALLOW (odd-quote prose body, executed launcher is not a target): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstderr: ${r.stderr}`);
  });
}
for (const cmd of GLUE_BLOCK) {
  test(`BLOCK (real launcher write, incl. after odd-quote body): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
}

// R2-1: the launcher-dir write block hardened with best-effort symlink
// resolution, plus flagging `ln`'s SOURCE operand. These need a REAL symlink
// on disk (the textual LAUNCHER_DIR_RE/hasAntiHallBinSegment checks alone
// cannot see through one), so they build their own fixture instead of using
// the plain `run()` helper.
test('BLOCK (launcher dir write): through a planted symlink (echo > target)', () => {
  const h = makeHome();
  try {
    const binDir = path.join(h.home, '.anti-hall', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const launcher = path.join(binDir, 'devswarm.js');
    fs.writeFileSync(launcher, 'real launcher\n', 'utf8');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-symlink-'));
    try {
      const link = path.join(scratch, 'pwn.js');
      fs.symlinkSync(launcher, link);
      const r = testHook(HOOK, bashPayload(`echo PWNED > ${link}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});
test('BLOCK (launcher dir write): planting the symlink itself (ln source resolves into bin)', () => {
  const h = makeHome();
  try {
    const binDir = path.join(h.home, '.anti-hall', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const launcher = path.join(binDir, 'devswarm.js');
    fs.writeFileSync(launcher, 'real launcher\n', 'utf8');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-symlink-'));
    try {
      const link = path.join(scratch, 'pwn2.js');
      const r = testHook(HOOK, bashPayload(`ln -sf ${launcher} ${link}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});
// `ln`'s source operand is flagged textually too - no real filesystem needed.
test('BLOCK (launcher dir write): ln -s SOURCE (~/.anti-hall/bin/...) DEST, no pre-existing link', () => {
  const r = run('ln -sf ~/.anti-hall/bin/devswarm.js /tmp/pwn3.js');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /stable launcher directory/);
});
test('ALLOW (launcher dir write): a symlink to an ordinary file is not mistaken for a launcher write', () => {
  const h = makeHome();
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-symlink-'));
    try {
      const real = path.join(scratch, 'ordinary.txt');
      fs.writeFileSync(real, 'hi\n', 'utf8');
      const link = path.join(scratch, 'alias.txt');
      fs.symlinkSync(real, link);
      const r = testHook(HOOK, bashPayload(`echo hi >> ${link}`), { home: h.home });
      assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

// Round-3 deadly-loop hardening (R3-1/R3A1-2/R3C1-1/R3A1-1/R3A1-3/R3A1-4):
// closes the remaining launcher-dir write-block gaps the R2-1 symlink
// hardening did not cover (hardlink-mode cp, mv of the dir/file itself,
// tree-copy into the ~/.anti-hall parent, relative targets/cd-chains, and a
// symlink planted to an ANCESTOR of bin in the same command), plus the
// dangling-symlink false-block fix.
function withLauncher(fn) {
  const h = makeHome();
  try {
    const binDir = path.join(h.home, '.anti-hall', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const launcher = path.join(binDir, 'devswarm.js');
    fs.writeFileSync(launcher, 'ORIGINAL LAUNCHER\n', 'utf8');
    fn(h, binDir, launcher);
  } finally {
    h.cleanup();
  }
}

test('BLOCK (R3-1): cp -l (hardlink-mode copy) SOURCE resolves into bin - the source operand must be flagged, not just the destination', () => {
  withLauncher((h, binDir, launcher) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-hardlink-'));
    try {
      const dest = path.join(scratch, 'cplink.js');
      const r = testHook(HOOK, bashPayload(`cp -l ${launcher} ${dest}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
test('BLOCK (R3-1): cp --link (long form) SOURCE resolves into bin', () => {
  withLauncher((h, binDir, launcher) => {
    const r = testHook(HOOK, bashPayload(`cp --link ${launcher} /tmp/anti-hall-test-cplink2.js`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});
test('ALLOW (R3-1 negative control): a plain cp -l between two ORDINARY files is not blocked', () => {
  const h = makeHome();
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-hardlink-ok-'));
    try {
      const src = path.join(scratch, 'ordinary.txt');
      fs.writeFileSync(src, 'hi\n', 'utf8');
      const r = testHook(HOOK, bashPayload(`cp -l ${src} ${path.join(scratch, 'copy.txt')}`), { home: h.home });
      assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});
test('BLOCK (R3-1): mv of the launcher FILE itself (SOURCE operand)', () => {
  withLauncher((h, binDir, launcher) => {
    const r = testHook(HOOK, bashPayload(`mv ${launcher} /tmp/anti-hall-test-mvd.js`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});
test('BLOCK (R3-1/R3C1-1): mv of the whole ~/.anti-hall DIRECTORY (ancestor of bin)', () => {
  withLauncher((h) => {
    const target = path.join(h.home, '.anti-hall');
    const r = testHook(HOOK, bashPayload(`mv ${target} ${path.join(h.home, '.ahold')}`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});
test('BLOCK (R3C1-1): cp -r of a directory ONTO ~/.anti-hall (ancestor destination, no `bin` in the operand)', () => {
  withLauncher((h) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-cpr-'));
    try {
      fs.mkdirSync(path.join(scratch, 'evil', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'evil', 'bin', 'devswarm.js'), 'PWNED\n', 'utf8');
      const r = testHook(HOOK, bashPayload(`cp -r ${path.join(scratch, 'evil', 'bin')} ${path.join(h.home, '.anti-hall')}/`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
test('BLOCK (R3A1-2): a symlink planted to an ANCESTOR of bin (~/.anti-hall itself), written through in the SAME command', () => {
  withLauncher((h) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-ancestor-link-'));
    try {
      const link = path.join(scratch, 'ah9');
      const r = testHook(HOOK, bashPayload(`ln -s ${path.join(h.home, '.anti-hall')} ${link} && echo PWNED > ${link}/bin/devswarm.js`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
test('BLOCK (R3A1-2/R3C1-1): relative write target resolved against the hook payload cwd (no cd in the command at all)', () => {
  withLauncher((h, binDir) => {
    const r = testHook(HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo PWNED > devswarm.js' }, session_id: 't', cwd: binDir }, { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});
test('BLOCK (R3A1-2/R3A1-4): chained relative `cd`s compose onto the previous cdDir instead of only the LAST literal cd token', () => {
  withLauncher((h) => {
    const cmd = `cd ${h.home}; cd .anti-hall; cd bin; echo PWNED > devswarm.js`;
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});
test('ALLOW (R3A1-3/R3C1-2/R3A1-4): an ORDINARY dangling symlink (target not yet created, nothing to do with the launcher dir) is no longer a false block', () => {
  const h = makeHome();
  try {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-dangling-'));
    try {
      const dangling = path.join(scratch, 'current.log');
      fs.symlinkSync(path.join(scratch, 'not-yet-created.log'), dangling);
      const r = testHook(HOOK, bashPayload(`echo start > ${dangling}`), { home: h.home });
      assert.strictEqual(r.status, 0, `expected allow (exit 0), got a launcher-dir false block\nstderr: ${r.stderr}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});
test('BLOCK (R3A1-3/R3C1-2): a dangling symlink whose LITERAL target text DOES point into the launcher dir still blocks', () => {
  withLauncher((h, binDir) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-dangling-launcher-'));
    try {
      const link = path.join(scratch, 'dangle-to-launcher.js');
      // Points at a NOT-YET-CREATED sibling inside bin/ - the launcher dir
      // itself exists, but this exact leaf doesn't, so realpathSync still
      // fails and the readlink-text path is exercised.
      fs.symlinkSync(path.join(binDir, 'not-yet-created-launcher.js'), link);
      const r = testHook(HOOK, bashPayload(`echo PWNED > ${link}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// R3A1-1 (ReDoS -> fail-open via hook timeout): the block-reason HINT regex
// must stay linear-time so a padded, already-blocked command still exits
// (BLOCKED) in well under a second, not tens of seconds.
test('PERF (R3A1-1): a padded, blocked, heredoc-shaped command still exits 2 in well under 1s', () => {
  const h = makeHome();
  try {
    const padding = 'devswarm.js send '.repeat(3000); // ~54 KB
    const cmd = `git push --force origin main\n: <<'EOF'\n${padding}\nEOF`;
    const t0 = Date.now();
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.ok(elapsedMs < 1000, `expected linear-time hint scan (<1000ms), took ${elapsedMs}ms`);
  } finally {
    h.cleanup();
  }
});

// Code strings that call git: a quoted literal passed to a call
// (`execSync('git push --force')`, `os.system("…")`, a list-form argv) in an
// interpreter -e/-c payload or in a script body written by a heredoc.
const JSX = (q) => `require(${q}child_process${q}).execSync(${q}${FPB}${q})`;
const CODE_STRING_BLOCK = [
  HDP('x.js', JSX("'")) + 'NODE_OPTIONS=--require=./x.js node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.js', JSX('"')) + 'NODE_OPTIONS=--require=./x.js node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.js', JSX("'")) + 'NODE_OPTIONS=-r./x.js node ~/.anti-hall/bin/devswarm.js roster',
  HDP('x.js', JSX("'")),
  `node -e "${JSX("'")}"`,
  `node -e "require('child_process').execFileSync('git', ['push', '--force'])"`,
  `python3 -c 'import os; os.system("${FPB}")'`,
  `python3 -c 'import subprocess; subprocess.run(["git","push","-f","origin","main"])'`,
  `perl -e 'system("git push -f origin main")'`,
  `perl -e 'system "git push -f origin main"'`,
  `node -e "require(\\"child_process\\").execSync(\\"${FPB}\\")"`,
];
const CODE_STRING_ALLOW = [
  `node -e "require('child_process').execSync('git push origin main')"`,
  `node -e "console.log('push')"`,
  'git commit -m "docs: note (see git docs) about git push"',
  `git commit -m "fix(git-guard): block ${FPB} in code strings"`,
  `python3 -c 'print("hello")'`,
];
for (const cmd of CODE_STRING_BLOCK) {
  test(`BLOCK (code-string literal): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  });
}
for (const cmd of CODE_STRING_ALLOW) {
  test(`ALLOW (code-string literal): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

for (const cmd of ALLOW) {
  test(`ALLOW: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

for (const cmd of GH_BLOCK) {
  test(`BLOCK gh: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      GH_REASON,
      `blocked for the WRONG reason: ${cmd}\nexpected ${GH_REASON}\ngot: ${r.stderr}`,
    );
  });
}

for (const cmd of GH_ALLOW) {
  test(`ALLOW gh: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

// `-F <real path>`: the guard reads the named file directly (no heredoc
// involved). Uses its own disposable temp file per test, separate from the
// fake HOME `run()` uses for the guard's own state.
function writeTempMessageFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-file-msg-'));
  const p = path.join(dir, 'msg.txt');
  fs.writeFileSync(p, body, 'utf8');
  return { path: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('BLOCK: git commit -F <file> with a self-credit trailer', () => {
  const f = writeTempMessageFile('subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  try {
    const r = run(`git commit -F ${f.path}`);
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FILE, `blocked for the WRONG reason\ngot: ${r.stderr}`);
  } finally {
    f.cleanup();
  }
});

test('ALLOW: git commit -F <file> with an ordinary message', () => {
  const f = writeTempMessageFile('subject\n\nordinary body, no trailer\n');
  try {
    const r = run(`git commit -F ${f.path}`);
    assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
  } finally {
    f.cleanup();
  }
});

test('ALLOW: git commit -F <nonexistent file> -> fail-open (unreadable file, no guess)', () => {
  const r = run('git commit -F /nonexistent/path/does-not-exist-git-guard-test.txt');
  assert.strictEqual(r.status, 0, `expected allow/fail-open (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK: git commit -F <relative path> resolved against a leading `cd <dir> &&`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-cd-msg-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'msg.txt'),
      'subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'utf8',
    );
    const r = run(`cd ${dir} && git commit -F msg.txt`);
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FILE, `blocked for the WRONG reason\ngot: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// JEV ADD-BLOCK (gitGuardSelfCredit) — paraphrased self-credit the regexes
// above miss. Default mode "shadow" (never in LEGACY_ON_DEFAULT, see
// hooks/lib/jev-assist.js's getMode).
//
// MOCK SERVER RUNS AS ITS OWN PROCESS (tests/helpers/jev-mock-server.js), NOT
// an in-process http server like tests/hooks/jev-assist.test.js uses. Reason
// (confirmed by reproduction while building this integration): testHook()
// spawns the hook via spawnSync, which BLOCKS this test process's event loop
// for the hook's whole lifetime. The hook's own askSync() then spawns a
// SECOND subprocess (jev-assist-worker.js) that would need to fetch an
// in-process mock server living in THIS (now-blocked) test process — a real
// deadlock; the request handler never fires and every call times out at
// exactly its budget. A mock server in its own process keeps its own event
// loop regardless of what this test process's spawnSync chain is doing.
// ---------------------------------------------------------------------------
const { spawn } = require('node:child_process');

const MOCK_SERVER = path.join(__dirname, '..', 'helpers', 'jev-mock-server.js');

// startMockJevServer(noul) -> Promise<{endpoint, stop()}>. `noul` is the raw
// noul value jev-client.js's math reads as answer=(noul>=0.5): pass a high
// value (e.g. 0.95) for a confident "true", a low value (e.g. 0.05) for a
// confident "false".
function startMockJevServer(noul) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER], {
      env: { PATH: process.env.PATH, ANTIHALL_MOCK_NOUL: String(noul) },
    });
    let buf = '';
    let settled = false;
    const onData = (c) => {
      buf += c;
      const m = buf.match(/PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({
          endpoint: `http://127.0.0.1:${m[1]}/mock`,
          stop: () => { try { child.kill(); } catch (_) { /* ignore */ } },
        });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error('mock server exited early, code ' + code)); }
    });
  });
}

async function withMockJevServer(answer, confidence, fn) {
  const noul = answer ? confidence : 1 - confidence;
  const server = await startMockJevServer(noul);
  try {
    return await fn(server.endpoint);
  } finally {
    server.stop();
  }
}

function runWithJev(command, jevCfg, endpoint) {
  const h = makeHome();
  try {
    h.writeState('jev.json', jevCfg);
    const r = testHook(HOOK, bashPayload(command), {
      home: h.home,
      env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint },
    });
    return r;
  } finally {
    h.cleanup();
  }
}

test('JEV shadow: paraphrased self-credit is logged but NEVER blocks (commit message)', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "wip: written with help from Claude, no big deal"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'shadow' } },
      endpoint,
    );
    assert.strictEqual(r.status, 0, `shadow must never block\nstderr: ${r.stderr}`);
  });
});

test('JEV on: confident paraphrased self-credit BLOCKS the commit', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "wip: written with help from Claude, no big deal"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `expected block\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /flagged by the Jev classifier/);
  });
});

test('JEV on: confident paraphrased self-credit BLOCKS a gh pr body', async () => {
  await withMockJevServer(true, 0.95, (endpoint) => {
    const r = runWithJev(
      'gh pr create --title x --body "this PR was put together with AI assistance"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `expected block\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /flagged by the Jev classifier/);
  });
});

test('JEV on: an ordinary message with no self-credit is NOT blocked (low-confidence/false answer)', async () => {
  await withMockJevServer(false, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "fix the parser bug"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 0, `expected allow\nstderr: ${r.stderr}`);
  });
});

test('JEV on: NEVER relaxes an existing regex block — canonical trailer still blocks even if Jev would say false', async () => {
  await withMockJevServer(false, 0.95, (endpoint) => {
    const r = runWithJev(
      'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      { enabled: true, timeoutMs: 3000, integrations: { gitGuardSelfCredit: 'on' } },
      endpoint,
    );
    assert.strictEqual(r.status, 2, `regex block must never be relaxed\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.COMMIT, 'must block via the ORIGINAL regex reason, never reaching the Jev path');
  });
});

test('JEV unavailable (mode on, endpoint unreachable): fails open to baseline (allow)', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 300, integrations: { gitGuardSelfCredit: 'on' } });
    const r = testHook(HOOK, bashPayload('git commit -m "written with help from an assistant"'), {
      home: h.home,
      env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: 'http://127.0.0.1:1/unreachable' },
    });
    assert.strictEqual(r.status, 0, `jev unavailable must fail open to today's behavior\nstderr: ${r.stderr}`);
  } finally {
    h.cleanup();
  }
});

// Round-4 deadly-loop hardening (R4A1-1/R4A1-2/R4A1-3/R4C1-1).

// R4A1-2/R4C1-1: pathHasLauncherSegment's unanchored "last segment is
// `.anti-hall`" clause false-blocked ordinary, unrelated uses of a
// `.anti-hall` directory (0.116 allowed all of these). The anchored fix
// (isLauncherDirRoot, consulted only for an mv/rename SOURCE, an rm target,
// or a copy/move destination joined with the source's basename) must allow
// every one of these again.
const R4_LAUNCHER_ROOT_NEGATIVE = [
  'cp notes.md .anti-hall/',
  'mv f .anti-hall/',
  'mv .anti-hall .anti-hall.bak',
  'rsync -a src/ .anti-hall/',
  'cp /tmp/skip.json ~/.anti-hall/',
];
for (const cmd of R4_LAUNCHER_ROOT_NEGATIVE) {
  test(`ALLOW (R4A1-2/R4C1-1): ordinary .anti-hall use, not the launcher container: ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
  });
}

test('BLOCK (R4A1-2/R4C1-1 regression guard): mv of the whole ~/.anti-hall DIRECTORY (SOURCE) still blocks', () => {
  withLauncher((h) => {
    const target = path.join(h.home, '.anti-hall');
    const r = testHook(HOOK, bashPayload(`mv ${target} ${path.join(h.home, '.x')}`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});

test('BLOCK (R4A1-2/R4C1-1 regression guard): cp -r x ~/.anti-hall/bin (explicit bin destination) still blocks', () => {
  withLauncher((h, binDir) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-r4-'));
    try {
      fs.mkdirSync(path.join(scratch, 'x'));
      const r = testHook(HOOK, bashPayload(`cp -r ${path.join(scratch, 'x')} ${binDir}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('BLOCK (R4A1-2/R4C1-1 regression guard): cp -r bin ~/.anti-hall (dest+basename(source) join) still blocks', () => {
  withLauncher((h) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-r4-'));
    try {
      fs.mkdirSync(path.join(scratch, 'bin'));
      const r = testHook(HOOK, bashPayload(`cp -r ${path.join(scratch, 'bin')} ${path.join(h.home, '.anti-hall')}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('BLOCK (R4A1-2/R4C1-1 addition): rm -rf ~/.anti-hall (rm target of the whole container)', () => {
  withLauncher((h) => {
    const r = testHook(HOOK, bashPayload(`rm -rf ${path.join(h.home, '.anti-hall')}`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});

test('ALLOW (R4A1-2/R4C1-1 negative control): rm of an ordinary .anti-hall subpath (not the launcher bin)', () => {
  const r = run('rm .anti-hall/handovers/2026-09-28/sess1/HANDOVER.md');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

// R4A1-1: an ESCAPED `\>` right before `|` must NOT arm the `>|`
// clobber-redirect rule - it is a literal `>` character, and the following
// `|` is a real, unescaped pipe that still needs to split into its own
// segment (0.116 blocked both of these; the round-3 `>|` handling
// regressed them to a false allow).
test('BLOCK (R4A1-1): escaped `\\>` before `|` does not swallow a trailing force push into one segment', () => {
  const r = run('echo \\>| git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (R4A1-1): escaped `\\>` before `|` does not swallow a trailing self-credit trailer into one segment', () => {
  const r = run('echo \\>| git commit -m x --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.COMMIT);
});

test('ALLOW (R4A1-1 regression guard): a normal, UNESCAPED `>|` clobber-redirect still keeps the segment together', () => {
  const r = run('echo hi >| /tmp/anti-hall-test-clobber.txt');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (R4A1-1 regression guard): a normal, UNESCAPED `>|` still keeps a trailing --force in the SAME segment (round-3 intent preserved)', () => {
  const r = run('git push origin main >|/tmp/anti-hall-test-clobber2 --force');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// R4A1-3: chained relative `cd`s must not grow lastCdDir unbounded
// (O(n^2) string work) to the point of blowing the hook's timeout, while
// still catching a real trailing force push in the same command.
test('PERF (R4A1-3): a 13400x-repeated relative cd-chain (~160KB) still blocks in well under 3s', () => {
  const cmd = 'cd a;echo>f;'.repeat(13400) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 3000, `expected linear-ish cd-chain handling (<3000ms), took ${elapsedMs}ms`);
});

test('PERF (R4A1-3): a ~40KB relative cd-chain still blocks in well under 1s', () => {
  const cmd = 'cd a;echo>f;'.repeat(3340) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.ok(elapsedMs < 1000, `expected linear-ish cd-chain handling (<1000ms), took ${elapsedMs}ms`);
});

test('JEV disabled entirely (no jev.json): a paraphrase is never consulted, byte-identical to pre-Jev behavior', () => {
  const r = run('git commit -m "written with help from Claude"');
  assert.strictEqual(r.status, 0);
});

// --- Round 5 fixes (R5A1-1/R5A1-2/R5A1-3/R5A1-4) ---

// R5A1-1: hasSelfCredit(currentRawCommand) ran UNMEMOIZED per commit-creating
// segment (Rule 1 / ghSelfCreditMessage), turning an O(n)-segment command
// into O(n^2) whole-command regex work. A command with tens of thousands of
// commit-creating segments used to take >10s (past the hook timeout, a
// fail-OPEN by timeout on the trailing force push). Memoizing the scan per
// distinct raw-command string must keep this well under the hook's budget.
test('PERF (R5A1-1): 30000x-repeated `git tag a;` + trailing force push blocks in well under 3s', () => {
  const cmd = 'git tag a;'.repeat(30000) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 3000, `expected memoized O(n) hasSelfCredit scan (<3000ms), took ${elapsedMs}ms`);
});

test('PERF (R5A1-1): 20000x-repeated `git commit -m x;` + trailing force push blocks in well under 3s', () => {
  const cmd = 'git commit -m x;'.repeat(20000) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 3000, `expected memoized O(n) hasSelfCredit scan (<3000ms), took ${elapsedMs}ms`);
});

// R5A1-2: the single-`&` branch treated `&` right after `>`/`<` as an fd-dup
// (`2>&1`) unconditionally, with no backslash-escape-parity check - unlike
// the sibling `|` branch (R4A1-1). An ESCAPED `\>`/`\<` right before `&` is a
// LITERAL `>`/`<` char, so the following `&` is a real background/separator
// control-op and must still split into its own segment.
test('BLOCK (R5A1-2): escaped `\\>` before `&` does not swallow a trailing force push into one segment', () => {
  const r = run('echo \\>& git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (R5A1-2): escaped `\\<` before `&` does not swallow a trailing force push into one segment', () => {
  const r = run('echo \\<& git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (R5A1-2 regression guard): a normal, UNESCAPED `2>&1` fd-dup redirect still keeps the segment together', () => {
  const r = run('git status 2>&1');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

// R5A1-3: isLauncherDirRoot compared the normalized path to `<home>/.anti-hall`
// with a strict `===`, but path.posix.normalize() PRESERVES a trailing slash
// (`~/.anti-hall/` normalizes to `.../.anti-hall/`, not `.../.anti-hall`), so
// any operand with a trailing slash silently bypassed the whole-container
// mv/rm check.
test('BLOCK (R5A1-3): rm -rf of the whole launcher container WITH a trailing slash still blocks', () => {
  withLauncher((h) => {
    const r = testHook(HOOK, bashPayload(`rm -rf ${path.join(h.home, '.anti-hall')}/`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});

test('BLOCK (R5A1-3): mv of the whole launcher container SOURCE WITH a trailing slash still blocks', () => {
  withLauncher((h) => {
    const target = path.join(h.home, '.anti-hall') + '/';
    const r = testHook(HOOK, bashPayload(`mv ${target} ${path.join(h.home, '.x')}`), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
});

// R5A1-4: `rm` DELETES its operand rather than writing THROUGH it. A
// self-referential/looping symlink (`ln -s selfloop selfloop`) made
// targetResolvesIntoLauncherDir's symlink-chain resolver hit its loop guard
// and fail CLOSED (treated as "is the launcher dir"), false-blocking an
// ordinary `rm -f <looping symlink>` that has nothing to do with
// ~/.anti-hall/bin.
test('ALLOW (R5A1-4): rm of a self-referential/looping symlink is not false-blocked', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-selfloop-'));
  try {
    const link = path.join(scratch, 'selfloop');
    fs.symlinkSync('selfloop', link);
    const r = run(`rm -f ${link}`);
    assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('BLOCK (R5A1-4 regression guard): rm of a symlink that DOES resolve into the launcher bin dir still blocks', () => {
  withLauncher((h, binDir, launcher) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-selfloop-'));
    try {
      const link = path.join(scratch, 'pwn.js');
      fs.symlinkSync(launcher, link);
      const r = testHook(HOOK, bashPayload(`rm -f ${link}`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// --- Round 6 fix (R6A1-1, regression introduced in 0d90bf1) ---
//
// The R5A1-4 deleteOnly branch above only lstat()ed the LEAF of the rm
// operand. When the leaf itself was a real file/dir reached through a
// SYMLINKED PARENT component (e.g. `linkdir -> ~/.anti-hall/bin`), it fell
// straight through to `return false` (allowed) without ever walking the
// parent chain — unlike the non-deleteOnly branch (and 51775f4 before this
// regression), which does. `rm -f linkdir/devswarm.js`, `rm -rf linkdir/`,
// and `rm -rf linkroot/bin` (linkroot -> ~/.anti-hall) all bypassed the
// guard this way.
test('BLOCK (R6A1-1): rm -f through a symlinked PARENT dir that resolves into the launcher bin dir', () => {
  withLauncher((h, binDir, launcher) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-linkdir-'));
    try {
      const linkdir = path.join(scratch, 'linkdir');
      fs.symlinkSync(binDir, linkdir);
      const r = testHook(HOOK, bashPayload(`rm -f ${linkdir}/devswarm.js`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('BLOCK (R6A1-1): rm -rf of a TRAILING-SLASH symlinked dir that resolves into the launcher bin dir', () => {
  withLauncher((h, binDir, launcher) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-linkdir2-'));
    try {
      const linkdir = path.join(scratch, 'linkdir');
      fs.symlinkSync(binDir, linkdir);
      const r = testHook(HOOK, bashPayload(`rm -rf ${linkdir}/`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('BLOCK (R6A1-1): rm -rf <symlinked-root>/bin resolves the PARENT into ~/.anti-hall root, blocked as the launcher bin dir', () => {
  withLauncher((h, binDir, launcher) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-linkroot-'));
    try {
      const linkroot = path.join(scratch, 'linkroot');
      fs.symlinkSync(path.join(h.home, '.anti-hall'), linkroot);
      const r = testHook(HOOK, bashPayload(`rm -rf ${linkroot}/bin`), { home: h.home });
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /stable launcher directory/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('ALLOW (R6A1-1 regression guard): a plain rm -f leaf symlink (only unlinks it) is still allowed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-plainleaf-'));
  try {
    const target = path.join(scratch, 'target.txt');
    fs.writeFileSync(target, 'x', 'utf8');
    const leaf = path.join(scratch, 'leaf');
    fs.symlinkSync(target, leaf);
    const r = run(`rm -f ${leaf}`);
    assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Round 6 fix (R6REV-P1-1): Jev-enabled commit-creating segments must not
// re-spawn a jev-assist-worker.js subprocess PER segment. Each of these tests
// runs with Jev enabled and NO api key configured, so every consult is a
// guaranteed miss (never written to the disk cache — see jev-assist.js) and
// would previously re-spawn a fresh subprocess for every single
// commit-creating segment. The in-process memo (keyed by exact consulted
// text, mirroring selfCreditScanCache) plus the JEV_CONSULT_CAP fail-open
// bound this to a small, constant number of subprocess spawns regardless of
// segment count. The trailing force-push block (baseline verdict, untouched
// by Jev) must still fire, proving Jev's absence never changed the outcome.
test('PERF (R6REV-P1-1): 500 commit-creating segments, Jev enabled + no key, complete well under 3s', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    const cmd = 'git tag a -m "msg";'.repeat(500) + 'git push --force origin main';
    const t0 = Date.now();
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
    assert.ok(elapsedMs < 3000, `expected memoized/capped Jev consults (<3000ms), took ${elapsedMs}ms`);
  } finally {
    h.cleanup();
  }
});

test('PERF (R6REV-P1-1): 3000 commit-creating segments, Jev enabled + no key, complete well under 3s', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    const cmd = 'git tag a -m "msg";'.repeat(3000) + 'git push --force origin main';
    const t0 = Date.now();
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
    assert.ok(elapsedMs < 3000, `expected memoized/capped Jev consults (<3000ms), took ${elapsedMs}ms`);
  } finally {
    h.cleanup();
  }
});

// Row-flood guard: before the memo/cap a single invocation with N commit-creating
// segments wrote N jev-assist.ndjson rows (75,000 rows reached a real home log
// when such a command ran against it). The row count must stay bounded, and
// everything must land in the test's own HOME.
test('ROW VOLUME: 3000 commit-creating segments write a bounded number of jev-assist rows', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    const cmd = 'git tag a -m "msg";'.repeat(3000) + 'git push --force origin main';
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    const log = path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson');
    const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    assert.ok(rows <= 20, `expected a bounded jev row count (<=20), got ${rows}`);
  } finally {
    h.cleanup();
  }
});

test('PERF (R6REV-P1-1): 500 DISTINCT-message commit-creating segments, Jev enabled + no key, still complete well under 3s (JEV_CONSULT_CAP bounds distinct-text spawns)', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    let cmd = '';
    for (let i = 0; i < 500; i++) cmd += `git tag a -m "msg${i}";`;
    cmd += 'git push --force origin main';
    const t0 = Date.now();
    const r = testHook(HOOK, bashPayload(cmd), { home: h.home });
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
    assert.ok(elapsedMs < 3000, `expected JEV_CONSULT_CAP to bound distinct-text spawns (<3000ms), took ${elapsedMs}ms`);
  } finally {
    h.cleanup();
  }
});

// PERF (R7A1-1): JEV_CONSULT_CAP (8) bounds the NUMBER of distinct-text
// consults but not their TOTAL wall time. Each consult's own budgetMs (1500)
// plus askSync's hard backstop (+500) means a single hanging consult can take
// up to ~2s; 8 distinct texts against a gateway that accepts and never
// replies would run ~12s+ over PreToolUse's 10s hook timeout (hooks.json),
// killing the hook before its trailing force-push block ever fires. The
// jevSpentMs/JEV_TOTAL_BUDGET_MS guard must bail out of further consults once
// the running total would blow the budget, so the whole invocation (all 8
// force-push-triggering commits plus the force push itself) still completes
// and blocks well under the hook timeout.
const HANG_SERVER = path.join(__dirname, '..', 'helpers', 'jev-hang-server.js');

function startHangJevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HANG_SERVER], {
      env: { PATH: process.env.PATH },
    });
    let buf = '';
    let settled = false;
    const onData = (c) => {
      buf += c;
      const m = buf.match(/PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        child.stdout.off('data', onData);
        resolve({
          endpoint: `http://127.0.0.1:${m[1]}/hang`,
          stop: () => { try { child.kill(); } catch (_) { /* ignore */ } },
        });
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error('hang server exited early, code ' + code)); }
    });
  });
}

test('PERF (R7A1-1): 8 distinct-text force-push repro against a hanging Jev endpoint blocks in < 7s (total Jev time budget)', async () => {
  const server = await startHangJevServer();
  try {
    const h = makeHome();
    try {
      h.writeState('jev.json', { enabled: true, integrations: { gitGuardSelfCredit: 'on' } });
      let cmd = '';
      for (let i = 0; i < 8; i++) cmd += `git commit -m "fix typo ${i}";`;
      cmd += 'git push --force origin main';
      const t0 = Date.now();
      const r = testHook(HOOK, bashPayload(cmd), {
        home: h.home,
        env: { AI_GATEWAY_API_KEY: 'fake', ANTIHALL_JEV_TEST_ENDPOINT: server.endpoint },
      });
      const elapsedMs = Date.now() - t0;
      assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
      assert.match(r.stderr, REASON.FORCE);
      assert.ok(elapsedMs < 7000, `expected the total Jev time budget to bound wall time well under the 10s hook timeout (<7000ms), took ${elapsedMs}ms`);
    } finally {
      h.cleanup();
    }
  } finally {
    server.stop();
  }
});

// 0.117.2 quote-blind backstop (git-guard.js gitBackstop). splitSegments
// quote-tracks heredoc bodies, comments and substitutions, so an apostrophe
// (or other unbalanced quote char) in any of them desyncs its quote state and
// swallows every later line - hiding a real `git push --force`. The backstop
// cuts the raw command at every separator IGNORING quotes and runs the git
// verdicts on each piece, so no quote desync can hide a git command. Every
// repro below (collected over four review rounds of tokenizer patching) must
// BLOCK through either pass; the ALLOW cases guard against new false blocks.

test('BLOCK (R5C1-1): unbalanced quote inside a heredoc body no longer hides a trailing force push', () => {
  const r = run("cat <<'EOF'\nIt's a test\nEOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (R5C1-1): heredoc prose with apostrophes followed by an innocent command is not false-blocked', () => {
  const r = run("cat <<'EOF'\nDon't worry, it's fine\nEOF\necho hello world");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (R5C1-1): multiple heredocs sharing one opener line still isolate a trailing force push', () => {
  const r = run("cat <<A <<B\nbody A's text\nA\nbody B's text\nB\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (R5C1-1): multiple heredocs sharing one opener line, no force, is not false-blocked', () => {
  const r = run("cat <<A <<B\nbody A's text\nA\nbody B's text\nB\necho done");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (R5C1-1): an UNTERMINATED heredoc still lets an EARLIER force push on the opener line block', () => {
  // The opener line itself is a chained command list, parsed normally before
  // the (unterminated, rest-of-command) body is skipped opaquely.
  const r = run("git push --force origin main; cat <<'EOF'\nIt's never closed");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (R5C1-1): an UNTERMINATED heredoc with no other command is not false-blocked', () => {
  const r = run("cat <<'EOF'\nIt's never closed\nno terminator here, apostrophe's everywhere");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (R5C1-1): a chained `&&` on the heredoc OPENER line still splits normally (no P0-class swallow)', () => {
  const r = run("cat <<EOF && echo hi\nbody\nEOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (R5C1-1): `<<-` dash-strip heredoc with a tab-indented apostrophe body still isolates a trailing force push', () => {
  const r = run("cat <<-'EOF'\n\tIt's tabbed\nEOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('PERF (R5C1-1): a 160KB heredoc body full of apostrophes still decides in under 2s', () => {
  const body = "line with an apostrophe's text\n".repeat(Math.ceil((160 * 1024) / 32));
  const cmd = "cat <<'EOF'\n" + body + "EOF\ngit push --force origin main";
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 2000, `expected < 2000ms, took ${elapsedMs}ms`);
});

// R5C1-2/deadly-loop wf_0eb4694d-ae4 round 1 follow-up findings on the
// R5C1-1 fix itself (P0 multi-heredoc-undershoot-bypass, P1 A1-1/A1-2, P2
// A1-3), plus C1-1 (delimiter-parser gap). Each BLOCK case is confirmed
// against real bash semantics (a `git(){ echo GIT-RAN: "$@"; }` stub) before
// being asserted here - see the deadly-loop review journal for the sem.sh
// harness output.

test('BLOCK (P0 multi-heredoc-undershoot-bypass): a later heredoc terminator word colliding with an earlier heredoc\'s own BODY line no longer undershoots the combined end', () => {
  // Real bash: heredoc A's body is the single line "B" (terminated by "A" on
  // line 3); heredoc B's body is "It's a test" (terminated by "B" on line
  // 5); line 6 is a real, standalone `git push --force`. Any heredoc
  // end-resolution mistake lets the apostrophe in B's body open a bogus
  // quoted span over the trailing force push.
  const r = run("cat <<A <<B\nB\nA\nIt's a test\nB\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (P0 multi-heredoc-undershoot-bypass): the same colliding-terminator shape with no force push is not false-blocked', () => {
  const r = run("cat <<A <<B\nB\nA\nIt's a test\nB\necho done");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (P0): a three-heredoc chain on one opener line still isolates a trailing force push', () => {
  const r = run("cat <<A <<B <<C\na's\nA\nb's\nB\nc's\nC\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1-1): a real quoted `;` in a push arg on the heredoc OPENER LINE still blocks (opener-line quotes are real shell syntax, not heredoc data)', () => {
  const r = run('cat <<\'EOF\' >/dev/null && git push -o "ci;skip" --force origin main\nbody\nEOF');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1-1): a quoted `;` refspec on the heredoc opener line still blocks', () => {
  const r = run('cat <<\'EOF\' >/dev/null && git push origin "HEAD:refs/heads/a;b" --force\nbody\nEOF');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1-1): a quoted `|` push-option on the heredoc opener line still blocks', () => {
  const r = run('cat <<\'EOF\' >/dev/null && git push -o "a|b" -f origin main\nbody\nEOF');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-1): a real quoted `|` inside an unrelated pipe argument on the heredoc opener line is not false-blocked', () => {
  const r = run('cat <<\'EOF\' | grep -E "a|git push --force"\nbody\nEOF');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (A1-2): a heredoc inside a double-quoted `$( )` command substitution no longer lets body quotes hide a trailing force push (&&)', () => {
  const r = run('git commit -m "$(cat <<\'EOF\'\nSay "hi\nEOF\n)" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1-2): same shape with the trailing push on its own line', () => {
  const r = run('git commit -m "$(cat <<\'EOF\'\nSay "hi\nEOF\n)"\ngit push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-2): a heredoc inside a double-quoted `$( )` substitution with no force/self-credit is not false-blocked', () => {
  const r = run('echo "$(cat <<\'EOF\'\nSay "hi\nEOF\n)"');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (A1-3): `<<` inside an unquoted `#` comment no longer arms an unterminated quote-neutral span over the rest of the command', () => {
  const r = run('echo x # <<EOF\ngit push -o "a;b" --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-3): an ordinary comment (no `<<`) followed by an innocent command is not false-blocked', () => {
  const r = run("echo x # it's a note\necho done");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (C1-1): a backslash-escaped heredoc delimiter (`<<\\EOF`, a common expansion-suppression idiom) is still recognized as a real heredoc opener', () => {
  const r = run("cat <<\\EOF\nIt's a test\nEOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (C1-1): a `$`-prefixed heredoc delimiter is still recognized as a real heredoc opener', () => {
  const r = run("cat <<$X\nIt's a test\nX\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (C1-1): a digit-led heredoc delimiter is still recognized as a real heredoc opener', () => {
  const r = run("cat <<1EOF\nIt's a test\n1EOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW ($((1<<2)) arithmetic left-shift is still not mistaken for an unrecognized heredoc opener (C1-1 fail-closed fallback must not fire here)', () => {
  const r = run('echo "$((1<<2))"');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('ALLOW (here-string `<<<` is still not mistaken for an unrecognized heredoc opener)', () => {
  const r = run('grep x <<< "it\'s fine" && echo done');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (here-string `<<<` with an apostrophe still isolates a chained force push)', () => {
  const r = run('grep x <<< "it\'s fine" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK: a heredoc-with-apostrophe body inside `bash -c` still isolates a chained force push', () => {
  const r = run('bash -c "cat <<\'EOF\'\nIt\'s a test\nEOF\ngit push --force origin main"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK: a heredoc-with-apostrophe body inside `eval` still isolates a chained force push', () => {
  const r = run('eval "cat <<\'EOF\'\nIt\'s a test\nEOF\ngit push --force origin main"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// --- Round-3 deadly-loop hardening (A1R2-1/R2C1-1 P0, A1R2-2 P1, A1R2-3 P1,
// R2REV1-1 P1 decided/no-fix) ---
//
// A1R2-1/R2C1-1 (P0 in the discarded tokenizer patch): a `<<WORD` written as
// plain double-quoted TEXT (prose that mentions heredoc syntax, or a shift
// like `a<<b`) must never be read as a heredoc that swallows a chained force
// push / self-credit trailer as inert "body" text.

test('BLOCK (A1R2-1): a literal `<<EOF` inside plain double-quoted text (no `$(`) no longer hides a chained `&&` force push', () => {
  const r = run('echo "use <<EOF here" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-1): same shape, commit message form, force push on its own line', () => {
  const r = run('git commit -m "doc: cat <<EOF usage" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-1): a double-quoted `a<<b` shift-looking phrase no longer hides a chained force push', () => {
  const r = run('git commit -am "handle a<<b shift"\ngit push -f origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-1): a double-quoted `<<EOF` mention no longer hides a self-credit trailer in a later -m', () => {
  const r = run('echo "a <<EOF" && git commit -m fix -m "Co-Authored-By: Claude <noreply@anthropic.com>"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.COMMIT);
});

test('ALLOW (A1R2-1 regression guard): ordinary prose mentioning `<<EOF` usage with no dangerous trailer is not false-blocked', () => {
  const r = run('git commit -m "docs: explain <<EOF usage"');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (A1-2 regression guard): a heredoc REOPENED by a real `$( )` command substitution inside double quotes still isolates a chained force push', () => {
  const r = run('git commit -m "$(cat <<\'EOF\'\nSay "hi\nEOF\n)" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// A1R2-3 (P1, pre-existing): a force push written directly inside a
// double-quoted command substitution was never split into its own segment by
// splitSegments (it stays inside the quoted span). The backstop cuts at `$(`
// regardless of quotes, so the substitution body is judged as its own command.

test('BLOCK (A1R2-3): a force push inside a double-quoted `$( )` assigned to a variable is no longer a bypass', () => {
  const r = run('out="$(git push --force origin main 2>&1)"; echo "$out"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-3): a force push inside a double-quoted `$( )` passed straight to echo is no longer a bypass', () => {
  const r = run('echo "$(git push --force origin main)"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// A1R2-2 (P1): an apostrophe/quote inside an unquoted `#` comment must not
// toggle inSingle/inDouble - comment text is not shell syntax, and doing so
// swallowed the next line's command (e.g. a force push) into a bogus quoted
// span that was never segmented or scanned.

test('BLOCK (A1R2-2): an apostrophe inside an unquoted `#` comment no longer hides the next line\'s force push', () => {
  const r = run("echo hi # it's fine\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-2): a comment apostrophe followed by an unrelated command then a real force push still blocks', () => {
  const r = run("git status # don't worry\ngit fetch && git push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1R2-2): a double quote inside an unquoted `#` comment no longer hides the next line\'s force push', () => {
  const r = run('echo hi # say "hi\ngit push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1R2-2 regression guard): an ordinary apostrophe comment with no dangerous trailer is not false-blocked', () => {
  const r = run("echo hi # it's fine\necho done");
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

// R2REV1-1 (P1, DECIDED - deliberate fail-closed, no logic change): a
// heredoc terminator line with trailing whitespace does not match the
// delimiter word exactly, so real bash never terminates the heredoc there
// either - the "force push" text that follows is heredoc body data in real
// bash, never executed. git-guard still scans and BLOCKs on it (heredoc
// bodies are scanned as shell, and the backstop cuts at every newline), a
// conservative fail-closed choice kept intentionally rather than loosened.

test('BLOCK (R2REV1-1, deliberate fail-closed): a heredoc terminator line with trailing whitespace never actually terminates in bash, so the "force push" text after it is unread body data - git-guard still BLOCKs on it by design', () => {
  const r = run("cat <<'EOF'\nIt's a test\nEOF   \ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// --- Review round 3 repros against the discarded tokenizer patch: each one
// desyncs splitSegments' quote state a different way. The quote-blind
// backstop must BLOCK all of them. ---

test('BLOCK (backstop R3-1): `$(true)#` quote opener spanning a newline no longer hides a force push', () => {
  const r = run("echo $(true)#'\n'; git push --force origin main; echo '\n'");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (backstop R3-2): arithmetic + heredoc inside a double-quoted `$( )` commit message no longer hides a chained force push', () => {
  const r = run('git commit -m "$(n=$((1+1)); cat <<\'EOF\'\nsubject\n\nsay "hi\nEOF\n)" && git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (backstop R3-3): a quoted `((` before an apostrophe heredoc no longer hides a trailing force push', () => {
  const r = run("echo \"((\" ; cat <<'EOF'\nit's\nEOF\ngit push --force origin main");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (backstop): a quote desync also cannot hide a self-credit trailer on a later commit', () => {
  const r = run("echo hi # it's fine\ngit commit -m fix -m \"Co-Authored-By: Claude <noreply@anthropic.com>\"");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.COMMIT);
});

test('BLOCK (backstop): a quote desync also cannot hide a `+refspec` force push or a `-f` short flag', () => {
  for (const push of ['git push origin +main', 'git push -f origin main', 'git push --force-with-lease origin main']) {
    const r = run("cat <<'EOF'\nit's\nEOF\n" + push);
    assert.strictEqual(r.status, 2, `expected block for ${push}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('BLOCK (backstop): a quote desync cannot hide a force push behind eval / bash -c', () => {
  for (const wrapped of ["eval 'git push --force origin main'", "bash -c 'git push --force origin main'"]) {
    const r = run("echo hi # it's fine\n" + wrapped);
    assert.strictEqual(r.status, 2, `expected block for ${wrapped}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

// DELIBERATE FAIL-CLOSED (accepted false block): the backstop cannot tell a
// quoted separator from a real one, so quoted text holding a separator
// followed by a literal git force push blocks.
test('BLOCK (backstop, deliberate fail-closed): quoted text with a separator before a literal force push', () => {
  const r = run('git commit -m "don\'t; git push --force"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// ...but a plain mention with no separator in front of `git` stays allowed:
// that piece's git verb is `commit`, not `push`.
test('ALLOW (backstop): a commit message that mentions a force push with no separator before it', () => {
  for (const cmd of [
    'git commit -m "never git push --force"',
    'git commit -m "docs: explain why git push --force is blocked"',
    "git commit -m \"fix: don't force push; keep history\"",
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow for ${cmd}\nstderr: ${r.stderr}`);
  }
});

test('ALLOW (backstop): ordinary heredocs, pipelines, arithmetic and here-strings are not false-blocked', () => {
  for (const cmd of [
    "cat <<'EOF'\nDon't worry, it's fine\nEOF\necho hello world",
    "cat <<'EOF' > notes.md\nIt's done; we don't push (yet) | ok\nEOF\ngit status",
    "cat <<'EOF' | grep -E \"a|git push --force\"\nbody\nEOF",
    'echo "$((1<<2))"',
    'x=$((3 + 4)); echo $x; (( x > 2 )) && echo big',
    "grep x <<< \"it's fine\" && echo done",
    'git push origin main 2>&1 | tail -5',
    'git log --oneline | head -5; git status',
    'git push -u origin feature/x && gh pr create --fill',
    "git commit -m \"$(cat <<'EOF'\nfeat: add retry\n\nIt's safe; no force push here.\nEOF\n)\"",
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

// 0.117.2 follow-up (deadly-loop wf_95183fe2-760, A1-1/A1-2/A1-3/A1-4).
//
// A1-1/A1-3: after a quote desync on an EARLIER physical line, backstopPieces
// used to cut INSIDE a later git command's own quoted argument (`-C
// "$(pwd)"`, or a `-m`/`--trailer` value containing `( ; & |` or a backtick -
// e.g. this repo's own `feat(x): y` conventional-commit style), splitting the
// piece holding the git verb from the piece holding `--force`/the trailer so
// neither resolved to verb `git`. gitBackstop now also re-runs the
// quote-aware splitSegments on each individual PHYSICAL line and applies
// gitVerdict to any segment whose verb is `git` - a line is almost always
// quote-balanced on its own even when the whole command is not.
test('BLOCK (A1-1/A1-3): a quote desync cannot hide a `-C "$(...)"` git command behind its own command-substitution argument', () => {
  for (const cmd of [
    "git commit -F - <<'EOF'\nfix: handle user's input\nEOF\ngit -C \"$(pwd)\" push --force-with-lease origin main",
    "cat <<'EOF'\nit's\nEOF\ngit -C \"$(git rev-parse --show-toplevel)\" push -f origin main",
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('BLOCK (A1-1/A1-3): a quote desync cannot hide a force push whose OWN argument holds a backstop cut character', () => {
  const DESYNC = "echo hi # it's fine\n";
  for (const cmd of [
    DESYNC + 'A="x;y" git push --force origin main',
    DESYNC + 'git -c "http.extraHeader=a;b" push --force origin main',
    DESYNC + 'git push -o "ci;skip" --force origin main',
    DESYNC + 'git push origin "HEAD:refs/heads/a;b" --force',
    DESYNC + 'git -C "a (copy)" push --force origin main',
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('BLOCK (A1-3): a quote desync cannot hide a self-credit trailer behind a `-C "$(...)"` git command', () => {
  const r = run("git -C \"$(pwd)\" commit -m fix -m \"Co-Authored-By: Claude <noreply@anthropic.com>\"");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.COMMIT);
});

test('BLOCK (A1-3): a quote desync cannot hide a self-credit trailer behind a conventional-commit `feat(x):` subject', () => {
  const DESYNC = "cat > notes.md <<'EOF'\nIt's done\nEOF\n";
  for (const [cmd, reason] of [
    [DESYNC + 'git commit -m "feat(x): y" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', REASON.COMMIT],
    [DESYNC + 'git commit -m "feat(x): y" --trailer "Co-authored-by: Claude <noreply@anthropic.com>"', REASON.COMMIT],
    [DESYNC + 'git commit -m "feat(x): y" -m "Generated with Claude Code"', REASON.COMMIT],
    [DESYNC + 'git tag -a v1.0 -m "feat(x): y" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', REASON.COMMIT],
    [DESYNC + 'git merge -m "feat(x): y" -m "Co-Authored-By: Claude <noreply@anthropic.com>" other', REASON.COMMIT],
    [DESYNC + 'git commit-tree -m "feat(x): y" -m "Co-Authored-By: Claude <noreply@anthropic.com>" HEAD^{tree}', REASON.COMMIT],
    ["echo add -A # it's ready\ngit commit -m \"feat(x): y\" -m \"Co-Authored-By: Claude <noreply@anthropic.com>\"", REASON.COMMIT],
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, reason);
  }
  // Control: the same commit with no desync must also still block (unaffected baseline).
  const ctrl = run('git commit -m "feat(x): y" -m "Co-Authored-By: Claude <noreply@anthropic.com>"');
  assert.strictEqual(ctrl.status, 2, `expected block (exit 2)\nstderr: ${ctrl.stderr}`);
  assert.match(ctrl.stderr, REASON.COMMIT);
});

// A1-2: `if`/`while`/`until`/`elif` are reserved words in command position
// exactly like `then`/`do`/`else`, so a force push in the CONDITION of a
// compound command never resolved past the wrapper word and the git verdict
// never ran at all - no quote desync needed.
test('BLOCK (A1-2): a force push in the condition of an if/while/until/elif compound command is no longer skipped', () => {
  for (const cmd of [
    'if git push -f origin main; then echo ok; fi',
    'while git push -f origin main; do break; done',
    'until git push -f origin main; do break; done',
    'if false; then :; elif git push -f origin main; then :; fi',
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

// A1-4: the tight-pipe/regex-alternation exception only checked the SINGLE
// piece right after the `|` for an unbalanced quote. A grouped alternation
// (`"(a|git push -f)"`) also cuts quote-blind at the `(`/`)`, splitting the
// still-open quoted span across MORE than one following piece before its
// closing quote is reached, so the exception missed it and `git push -f`
// resolved as its own, falsely-blocked piece. backstopPieces now tracks
// quote parity cumulatively across pieces on the same physical line.
test('ALLOW (A1-4): a grouped regex alternation mentioning a force-push-shaped pattern is not false-blocked', () => {
  const r = run('grep -E "(a|git push -f)" x');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('ALLOW (A1-4 regression guard): the ungrouped alternation shape stays allowed', () => {
  const r = run('grep -E "a|git push -f" x');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

test('BLOCK (A1-4 regression guard): a real tight pipe into a force push still blocks', () => {
  const r = run('x|git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// PERF: the backstop is one linear split and inArithmeticAt resumes its scan
// (shell-scan.js _scanState). The arithmetic case took ~9s at 0.117.1
// (quadratic rescans); the others start with a quote desync so the NORMAL
// pass sees nothing and the backstop must walk the whole input.
const PERF_DESYNC = "echo hi # it's fine\n";
const PERF_CASES = [
  ['96 KB adversarial arithmetic', 'echo $((1' + '<<y'.repeat(32000) + '))\ngit push --force origin main'],
  ['160 KB heredoc', PERF_DESYNC + "cat <<'EOF'\n" + "line with an apostrophe's text\n".repeat(5120) + 'EOF\ngit push --force origin main'],
  ['30000 segments', PERF_DESYNC + 'git tag a;'.repeat(30000) + 'git push --force origin main'],
  ['160 KB cd-chain', PERF_DESYNC + 'cd a;echo>f;'.repeat(13400) + 'git push --force origin main'],
];
for (const [label, cmd] of PERF_CASES) {
  test(`PERF (backstop): ${label} ending in a force push blocks in under 2s`, () => {
    const t0 = Date.now();
    const r = run(cmd);
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
    assert.ok(elapsedMs < 2000, `expected < 2000ms, took ${elapsedMs}ms`);
  });
}

// A1-5/A1-6 (0.117.2 follow-up, deadly-loop wf_95183fe2-760). Pre-existing
// gaps, open in both 0.117.1 and 0.117.2, none needing a quote desync.

// 1) `git push --mirror` force-updates AND DELETES every remote ref.
test('BLOCK (A1-5): `git push --mirror` is a force push', () => {
  const r = run('git push --mirror origin');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-5 regression guard): an ordinary push with no mirror/force flag stays allowed', () => {
  const r = run('git push origin main');
  assert.strictEqual(r.status, 0, `expected allow (exit 0)\nstderr: ${r.stderr}`);
});

// 2) `time -p` / `command -p` resolve the effective verb to `-p` instead of
// skipping it, so the wrapped force push never resolved to `git`.
test('BLOCK (A1-5): `time -p`/`command -p` no longer swallow the wrapped force push', () => {
  for (const cmd of ['time -p git push -f origin main', 'command -p git push -f origin main']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('ALLOW (A1-5 regression guard): `time`/`command` with no `-p` and no force push stay allowed', () => {
  for (const cmd of ['time ls', 'command git status']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

// 3) `coproc` is a wrapper word like `exec`; `xargs`-run `git push` is
// conservatively treated as a force push because xargs appends unknown
// stdin-read words to the argv it runs.
test('BLOCK (A1-5): `coproc git push --force` is no longer skipped', () => {
  const r = run('coproc git push --force origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('BLOCK (A1-5): an xargs-run `git push` is treated as a force push - explicit flag or stdin-fed', () => {
  for (const cmd of ['xargs git push origin main', 'echo -f | xargs git push origin main']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('ALLOW (A1-5 regression guard): xargs running a non-git command stays allowed', () => {
  for (const cmd of ['xargs grep pattern file', 'echo origin | xargs grep pattern', 'find . -name x | xargs cat']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

// A1-2 (0.118.0 follow-up): xargsGitVerdict used to also run from the
// quote-blind backstopPieces split (cuts at ANY `|`/`;`, inside or outside a
// quoted string), so `xargs git push` merely MENTIONED inside a quoted
// commit message or a redirect target - never executed as a real command -
// wrongly resolved to verb `xargs` and blocked. It must only fire from the
// quote-aware scanCommand segment pass and gitBackstopLines' quote-aware
// per-line re-split.
test('ALLOW (A1-2): "xargs git push" mentioned inside a quoted commit message or redirect target stays allowed', () => {
  const cmds = [
    "git commit -m 'docs: explain why ls | xargs git push is blocked'",
    "echo '... | xargs git push origin' > notes.txt",
  ];
  for (const cmd of cmds) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

test('BLOCK (A1-2 regression guard): a real `echo -f | xargs git push origin main` still blocks', () => {
  const r = run('echo -f | xargs git push origin main');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// Heredoc BODY text is scanned as shell (R2REV1-1, deliberate fail-closed:
// git-guard cannot tell heredoc data from a real script), so a heredoc line
// that itself looks like a live `xargs git push` invocation still blocks -
// this is unrelated to the backstopPieces quote-blind bug above and must not
// regress when xargsGitVerdict moves to gitBackstopLines' per-line pass.
test('BLOCK (A1-2 regression guard): an xargs-run git push inside a heredoc BODY line still blocks (deliberate fail-closed)', () => {
  const r = run("cat <<'EOF'\nsee ls | xargs git push origin main for context\nEOF");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// 4) `env -S 'STRING'` word-splits STRING and runs it as a new command; a
// `bash -c $'...'` ANSI-C-quoted payload must decode before recursion, not
// carry a literal leading `$` into the re-parsed verb.
test('BLOCK (A1-5): `env -S` runs its STRING as a command, force push included', () => {
  const r = run("env -S 'git push -f origin main'");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-5 regression guard): ordinary `env VAR=1 cmd` (no -S) stays allowed', () => {
  for (const cmd of ['env FOO=1 git status', 'env git status']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

test('BLOCK (A1-5): `bash -c $\'...\'` ANSI-C quoting is decoded before the payload is re-parsed', () => {
  const r = run("bash -c $'git push --force origin main'");
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

// 5) A literal string piped/here-strung straight into a bare shell reads its
// script from there, exactly like `bash -c`.
test('BLOCK (A1-5): a literal `echo "..." | bash`/`| sh` pipes its script into the shell\'s stdin', () => {
  for (const cmd of [
    'echo "git push --force origin main" | bash',
    'echo "git push --force origin main" | sh',
  ]) {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, REASON.FORCE);
  }
});

test('BLOCK (A1-5): a here-string into bash/sh reads its script from there too', () => {
  const r = run('bash <<< "git push --force origin main"');
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
});

test('ALLOW (A1-5 regression guard): `echo hi | bash -c \'cat\'` and an ordinary here-string stay allowed', () => {
  for (const cmd of ["echo hi | bash -c 'cat'", 'bash <<< "echo hello world"']) {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
  }
});

// 6) PERF: extractQuotedLiterals(cmd) used to run unmemoized on every `git
// commit -F -` segment (O(N) calls over an O(N)-length cmd = O(N^2)). 20000
// segments took ~13s at 0.117.2, over the hook's 10s timeout.
test('PERF (A1-6): 20000x-repeated `git commit -F -;` + trailing force push blocks in well under 2s', () => {
  const cmd = 'git commit -F -;'.repeat(20000) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 2000, `expected < 2000ms, took ${elapsedMs}ms`);
});

// A1-4 (0.118.0 follow-up, perf): the A1-6 test above has no quoted text, so
// extractQuotedLiteralsCached's memoized ARRAY was always empty and never
// exercised the unmemoized JOIN of that array + heredoc bodies that the
// `-F -`/`--file=-` branch used to rebuild from scratch on EVERY segment. A
// quoted here-string (`<<<'m'`) on each of the 20000 segments makes
// extractQuotedLiteralsCached return a large (O(N)) array, so the join alone
// - not the array build - reproduces the O(N^2) blowup unless it is also
// memoized per `cmd`.
test('PERF (A1-4): 20000x-repeated `git commit -F - <<<\'m\';` + trailing force push blocks in well under 2s', () => {
  const cmd = "git commit -F - <<<'m'; ".repeat(20000) + 'git push --force origin main';
  const t0 = Date.now();
  const r = run(cmd);
  const elapsedMs = Date.now() - t0;
  assert.strictEqual(r.status, 2, `expected block (exit 2)\nstderr: ${r.stderr}`);
  assert.match(r.stderr, REASON.FORCE);
  assert.ok(elapsedMs < 2000, `expected < 2000ms, took ${elapsedMs}ms`);
});

// Launcher-dir writes quoted inside a heredoc body stay BLOCKED (fail-closed).
// A narrower "prose in a quoted cat/tee heredoc" exemption was tried and
// reverted after review found real bypasses through the shapes below.
const LAUNCHER_HEREDOC_BLOCK = [
  "cat <<'EOF'\nx\nEOF\ncp a ~/.anti-hall/bin/x\nEOF",
  "cat <<-'EOF'\n\tx\n\tEOF\ncp a ~/.anti-hall/bin/x\n\tEOF",
  "eval $(cat <<'EOF'\ncp a ~/.anti-hall/bin/x\nEOF\n)",
  "$(cat <<'EOF'\ncp a ~/.anti-hall/bin/x\nEOF\n)",
  "sh <(cat <<'EOF'\ncp a ~/.anti-hall/bin/x\nEOF\n)",
  "cat <<'EOF' >x.sh\ncp a ~/.anti-hall/bin/x\nEOF\nsource x.sh",
];
for (const cmd of LAUNCHER_HEREDOC_BLOCK) {
  test(`BLOCK (launcher dir write in heredoc body): ${JSON.stringify(cmd)}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /stable launcher directory/);
  });
}
