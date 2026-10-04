'use strict';
// git-guard: heredoc bodies whose consumer is not a shell are data
// (guards.gitGuardHeredocData), and `xargs` runs get the checks a direct run
// gets. Every case goes through the real hook entry (a PreToolUse Bash
// payload piped to git-guard.js) with an isolated HOME and a temp cwd.
// Dangerous command strings are assembled from pieces.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const home = makeHome();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gg-hdata-'));
fs.mkdirSync(path.join(work, 'sub'));
fs.mkdirSync(path.join(work, '.git', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
fs.symlinkSync(path.join(work, '.git', 'hooks', 'pre-push'), path.join(work, 'link.md'));
after(() => { fs.rmSync(work, { recursive: true, force: true }); home.cleanup(); });

const PUSH = 'git pu' + 'sh';
const FP = PUSH + ' --force origin main';
const BT = '`';
const CRED = 'Co-Authored' + '-By: Claude <noreply@anthropic.com>';
// Note text that mentions guarded commands at line start (what the shell
// scan misread as commands).
const NOTE = `Notes:\n${FP}\n${PUSH} ${BT}x${BT}\n`;

function run(cmd, opts) {
  const payload = bashPayload(cmd);
  payload.cwd = work;
  if (opts && opts.settings) home.writeState('settings.json', opts.settings);
  try {
    return testHook('git-guard.js', payload, { home: home.home, env: (opts && opts.env) || {} });
  } finally {
    if (opts && opts.settings) fs.rmSync(path.join(home.home, '.anti-hall', 'settings.json'), { force: true });
  }
}
const block = (label, cmd) => test('BLOCK ' + label, () => {
  const r = run(cmd);
  assert.strictEqual(r.status, 2, `expected block for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
});
const allow = (label, cmd) => test('ALLOW ' + label, () => {
  const r = run(cmd);
  assert.strictEqual(r.status, 0, `expected allow for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
});

// ---- 1. data heredocs are not scanned as commands -------------------------
allow('cat <<EOF > notes.md (unquoted delimiter, no expansion)', `cat <<EOF > notes.md\nNotes:\n${FP}\nthen ${PUSH} origin main\nEOF`);
allow("cat > notes.md <<'EOF'", `cat > notes.md <<'EOF'\n${NOTE}EOF`);
allow('cat >> notes.txt <<"EOF"', `cat >> notes.txt <<"EOF"\n${NOTE}EOF`);
allow('<<- with tab-indented body', `cat > notes.md <<-'EOF'\n\t${FP}\n\tEOF`);
allow('tee file <<EOF', `tee notes.txt <<'EOF'\n${NOTE}EOF`);
allow('tee -a file >/dev/null', `tee -a notes.log >/dev/null <<'EOF'\n${NOTE}EOF`);
allow('git commit -F - <<EOF', `git commit -F - <<'EOF'\nfix: doc\n\n${NOTE}EOF`);
allow('git add && git commit -F -', `git add notes.md && git commit -F - <<'EOF'\nfix: doc\n\n${NOTE}EOF`);
allow('git commit -m "$(cat <<EOF)"', `git commit -m "$(cat <<'EOF'\nfix: doc\n\n${NOTE}EOF\n)"`);
allow('gh pr create --body-file - <<EOF', `gh pr create --title "feat(x): don't" --body-file - <<'EOF'\n${NOTE}EOF`);
allow('cd && mkdir && cat, read-only follow-up', `cd sub && mkdir -p d && cat > d/notes.md <<'EOF'\n${NOTE}EOF\nwc -l d/notes.md`);
allow('write a message file, then git commit -F it', `cat > msg.txt <<'EOF'\nfix: doc\n\n${NOTE}EOF\ngit commit -F msg.txt`);
allow('two heredocs on two lines', `cat > a.md <<'A'\n${NOTE}A\ncat > b.md <<'B'\n${NOTE}B`);
allow('handover file under .anti-hall/handovers', `cat > .anti-hall/handovers/s1/HANDOVER.md <<'EOF'\nRun ${BT}${PUSH}${BT} to publish.\nEOF`);
allow('launcher path mentioned in prose', `cat > notes.md <<'EOF'\ncp a ~/.anti-hall/bin/x\nEOF`);

// ---- 2. the body is still scanned when a shell can run it -----------------
block('bash <<EOF', `bash <<'EOF'\n${FP}\nEOF`);
block('sh -s <<EOF', `sh -s <<'EOF'\n${FP}\nEOF`);
block('python3 - <<EOF', `python3 - <<'EOF'\nimport os; os.system("${FP}")\nEOF`);
block('source /dev/stdin <<EOF', `source /dev/stdin <<'EOF'\n${FP}\nEOF`);
block('. /dev/stdin <<EOF', `. /dev/stdin <<'EOF'\n${FP}\nEOF`);
block('xargs sh -c <<EOF', `xargs -0 sh -c <<'EOF'\n${FP}\nEOF`);
block('eval "$(cat <<EOF)"', `eval "$(cat <<'EOF'\n${FP}\nEOF\n)"`);
block('bash -c "$(cat <<EOF)"', `bash -c "$(cat <<'EOF'\n${FP}\nEOF\n)"`);
block('cat <<EOF | bash', `cat <<'EOF' | bash\n${FP}\nEOF`);
block('cat | tee | sh', `cat <<'EOF' | tee x.md | sh\n${FP}\nEOF`);
block('tee x.md <<EOF | bash', `tee x.md <<'EOF' | bash\n${FP}\nEOF`);
block('pipe continued after the body', `cat <<'EOF' |\n${FP}\nEOF\nbash`);
block('tee >(bash)', `tee >(bash) <<'EOF'\n${FP}\nEOF`);
block('cat > >(bash)', `cat > >(bash) <<'EOF'\n${FP}\nEOF`);
block('written then bash', `cat > x.md <<'EOF'\n${FP}\nEOF\nbash x.md`);
block('written then sh <', `cat > x.md <<'EOF'\n${FP}\nEOF\nsh < x.md`);
block('written then source', `cat > x.md <<'EOF'\n${FP}\nEOF\nsource x.md`);
block('written then .', `cat > x.md <<'EOF'\n${FP}\nEOF\n. ./x.md`);
block('written then ./x.md', `cat > x.md <<'EOF'\n${FP}\nEOF\n./x.md`);
block('written, && sh on the opener line', `cat > x.md <<'EOF' && sh x.md\n${FP}\nEOF`);
block('written then run via git -c core.pager', `cat > notes.md <<'EOF'\n${FP}\nEOF\ngit -c core.pager='sh notes.md' log`);
block('written then run via GIT_PAGER', `cat > notes.md <<'EOF'\n${FP}\nEOF\nGIT_PAGER='sh notes.md' git log`);
block('unquoted body with $( )', `cat > x.md <<EOF\n$(${FP})\nEOF`);
block('unquoted body with backticks', `cat > x.md <<EOF\n${BT}${FP}${BT}\nEOF`);
block('script target (may be run later)', `cat > x.sh <<'EOF'\n${FP}\nEOF`);
block('extensionless target', `cat > f <<'EOF'\n${FP}\nEOF`);
block('cat to stdout', `cat <<'EOF'\n${FP}\nEOF`);
block('git hook target', `cat > .git/hooks/pre-push <<'EOF'\n${FP}\nEOF`);
block('hook name in cwd', `cat > pre-commit <<'EOF'\n${FP}\nEOF`);
block('cd into .git/hooks', `cd .git/hooks && cat > notes.md <<'EOF'\n${FP}\nEOF`);
block('dotfile target', `cat > .envrc <<'EOF'\n${FP}\nEOF`);
block('existing symlink target', `cat > link.md <<'EOF'\n${FP}\nEOF`);
block('variable target', `cat > $F.md <<'EOF'\n${FP}\nEOF`);
block('substitution target', `cat > "$(echo x).md" <<'EOF'\n${FP}\nEOF`);
block('launcher-dir target', `cat > ~/.anti-hall/bin/devswarm.md <<'EOF'\nx\nEOF`);
block('force push after the terminator', `cat > n.md <<'EOF'\nx\nEOF\n${FP}`);
block('padded delimiter line inside the body', `cat > n.md <<'EOF'\nx\n EOF\n${FP}\nEOF`);
block('"EOF)" line inside a $( ) body', `echo "$(cat <<'EOF'\nhi\nEOF)"\n${FP}\nEOF`);
block('opener line continued with a backslash', `cat <<'EOF' \\\n> notes.md\n${FP}\nEOF`);
block('opener inside a quoted string', `echo "\ncat > n.md <<EOF\n"\n${FP}\nEOF`);
block('opener inside a comment', `# cat > n.md <<EOF\n${FP}\nEOF`);
block('two heredocs on one line', `cat <<'A' > a.md; cat <<'B' > b.md\nx\nA\n${FP}\nB`);
block('unterminated', `cat > n.md <<'EOF'\n${FP}`);
block('CRLF', `cat > n.md <<'EOF'\r\n${FP}\r\nEOF\r\n`);
block('title that pipes into sh', `gh pr create --title "a; sh x" --body-file - <<'EOF'\n${FP}\nEOF`);
block('git apply <<EOF', `git apply <<'EOF'\n${FP}\nEOF`);
block('config alias line in a data body (raw scan)', `cat > notes.md <<'EOF'\n[alias]\nx = !${FP}\nEOF`);

// ---- 3. commit / PR credit trailers are checked whatever the consumer -----
block('credit: git commit -F -', `git commit -F - <<'EOF'\nfix: x\n\n${CRED}\nEOF`);
block('credit: git commit -m "$(cat <<EOF)"', `git commit -m "$(cat <<'EOF'\nfix: x\n\n${CRED}\nEOF\n)"`);
block('credit: written then git commit -F file', `cat > m.txt <<'EOF'\nfix\n\n${CRED}\nEOF\ngit commit -F m.txt`);
block('credit: gh pr create --body-file -', `gh pr create --title t --body-file - <<'EOF'\nx\n\n${CRED}\nEOF`);

// ---- 4. the setting turns the data rule off --------------------------------
test('SETTING: guards.gitGuardHeredocData=false scans every body again (settings.json and env)', () => {
  const cmd = `cat > notes.md <<'EOF'\n${NOTE}EOF`;
  assert.strictEqual(run(cmd).status, 0, 'default on');
  assert.strictEqual(run(cmd, { settings: { guards: { gitGuardHeredocData: false } } }).status, 2);
  assert.strictEqual(run(cmd, { env: { ANTIHALL_GIT_GUARD_HEREDOC_DATA: '0' } }).status, 2);
});

// ---- 5. xargs runs get the checks a direct run gets -----------------------
block('xargs git push', `echo b | xargs ${PUSH} origin`);
block('xargs -i git push (GNU -i takes no separate value)', `echo b | xargs -i ${PUSH} origin {}`);
block('xargs -l git push', `echo b | xargs -l ${PUSH} origin`);
block('xargs -e git push', `echo b | xargs -e ${PUSH} origin`);
block('xargs --replace git push', `echo b | xargs --replace ${PUSH} origin {}`);
block('xargs --eof git push', `echo b | xargs --eof ${PUSH} origin`);
block('xargs --max-lines git push', `echo b | xargs --max-lines ${PUSH} origin`);
block('xargs -I{} git push', `echo b | xargs -I{} ${PUSH} origin {}`);
block('xargs -I {} git push', `echo b | xargs -I {} ${PUSH} origin {}`);
block("xargs -d '\\n' git push (quoted option value)", `echo b | xargs -d '\\n' ${PUSH} origin`);
block('xargs -0n1 git push (clustered value)', `echo b | xargs -0n1 ${PUSH} origin`);
block('xargs -n 1 -P 4 git push', `echo b | xargs -n 1 -P 4 ${PUSH} origin`);
block('xargs --max-a 1 git push (abbreviated long option)', `echo b | xargs --max-a 1 ${PUSH} origin`);
block('BSD xargs -J % git push', `echo b | xargs -J % ${PUSH} origin %`);
block('BSD xargs -R 1 -I % git push', `echo b | xargs -R 1 -I % ${PUSH} origin %`);
block('xargs sh -c force push', `echo b | xargs sh -c '${FP}'`);
block('xargs -i sh -c force push', `echo b | xargs -i sh -c '${FP}'`);
block('xargs -I{} sh -c force push', `echo b | xargs -I{} sh -c '${FP}'`);
block('xargs xargs git push', `echo b | xargs xargs ${PUSH} origin`);
block('xargs -i git commit with a credit trailer', `echo b | xargs -i git commit -m 'x\n\n${CRED}'`);
block('xargs -l git config alias with a force push', `echo b | xargs -l git config alias.x '!${FP}'`);
allow('xargs -i echo', 'echo a | xargs -i echo {}');
allow('xargs -I{} git -C {} status', 'echo . | xargs -I{} git -C {} status');
allow('xargs -l git log', 'echo a | xargs -l git log --oneline');
allow('xargs -n1 git add', 'echo a | xargs -n1 git add');
allow('find -exec ... {} literal', 'find . -name "*.md" -exec wc -l {} +');
block('a real { ...; } group still splits', `{ ${FP}; }`);
block('adjacent {} then a force push', `echo {} ; ${FP}`);
