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

// --- Exact-shape exemption: heredoc message file + anti-hall launcher send ---
// The peer's original command (absolute scratchpad path, ENDOFMSG delimiter)
// and prose variants. All of these BLOCK on the pre-0.117 guard.
const PEER_FILE = '/private/tmp/peer/scratchpad/landed.md';
const LAUNCHER_MSG_ALLOW = [
  `cat > ${PEER_FILE} <<'ENDOFMSG'\nLANDED ON MAIN. Plain fast-forward, no force - I did not run \`git push --force\` or \`git push -f\`.\nENDOFMSG\nnode ~/.anti-hall/bin/devswarm.js send --to primary --message-file ${PEER_FILE}`,
  "cd /tmp/peer && cat > m.md <<'EOF'\nPlease hold; `git push origin +main` waits for `ci` green.\nEOF\nnode ~/.anti-hall/bin/devswarm.js send --to x --message-file m.md",
  "cd /tmp/peer\ncat > /tmp/m.md <<'MSG'\ngit push `backtick text`\nnever git push --force-with-lease here; && git push -f is banned too\nMSG\nnode ~/.anti-hall/bin/devswarm.js send --to x --urgency high --quiet --message-file /tmp/m.md",
  "cat > /tmp/m.txt <<'EOF'\nstep 3: $(git push --force origin main) is what NOT to do\nEOF\nnode ~/.anti-hall/bin/devswarm.js send --to peer --message 'see file' --message-file /tmp/m.txt",
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
  // Exact-shape exemption: a quoted-heredoc message file sent via the anti-hall
  // launcher. The prose body mentions `git push` and is not scanned.
  ...LAUNCHER_MSG_ALLOW,
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
  `cat > ~/.anti-hall/bin/devswarm.js <<'EOF'\nrequire('child_process').execSync('${FPB}')\nEOF\nnode ~/.anti-hall/bin/devswarm.js send`,
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
];
const LAUNCHER_WRITE_ALLOW = [
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

test('JEV disabled entirely (no jev.json): a paraphrase is never consulted, byte-identical to pre-Jev behavior', () => {
  const r = run('git commit -m "written with help from Claude"');
  assert.strictEqual(r.status, 0);
});
