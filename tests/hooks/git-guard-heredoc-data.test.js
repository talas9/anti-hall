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
// `$HOME/` is the same target as `~/` (R4 P2).
allow('~/n.md target', `cat > ~/n.md <<'EOF'\n${NOTE}EOF`);
allow('$HOME/n.md target', `cat > $HOME/n.md <<'EOF'\n${NOTE}EOF`);
allow('"$HOME/n.md" target', `cat > "$HOME/n.md" <<'EOF'\n${NOTE}EOF`);
block('$HOME launcher-dir target', `cat > $HOME/.anti-hall/bin/devswarm.md <<'EOF'\nx\nEOF`);
block('$HOME/x.sh target', `cat > $HOME/x.sh <<'EOF'\n${NOTE}EOF`);
block('$HOME/.bashrc target', `cat > $HOME/.bashrc <<'EOF'\n${NOTE}EOF`);
block('$HOMEX/n.md is another variable', `cat > $HOMEX/n.md <<'EOF'\n${NOTE}EOF`);
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

// ---- 6. git / gh beside a data heredoc: listed subcommands + flags only ----
// A masked body can sit in a file the same line hands to a command-running
// option, so a git/gh with any flag outside the per-subcommand allowlist
// (abbreviations included) keeps every body scanned.
const ADOC = `cat <<'EOF' > a.md\n${FP}\nEOF\n`;
block('fetch --upload-pack after the terminator runs the body file', ADOC + "git fetch --upload-pack='sh a.md' .");
block('fetch --upload-p (abbreviation)', ADOC + "git fetch --upload-p='sh a.md' .");
block('fetch --up (abbreviation)', ADOC + "git fetch --up='sh a.md' .");
block('fetch -u', ADOC + "git fetch -u 'sh a.md' .");
block('fetch --upload-pack on the opener line', `cat <<'EOF' > a.md && git fetch --upload-pack='sh a.md' .\n${FP}\nEOF`);
block('git -C . fetch --upload-pack', ADOC + "git -C . fetch --upload-pack='sh a.md' .");
block('gh repo clone -- --upload-pack', ADOC + "gh repo clone o/r -- --upload-pack='sh a.md'");
block('gh pr create -- passthrough', `gh pr create --body-file - -- --upload-pack=x <<'EOF'\n${FP}\nEOF`);
block('git commit -F - --upload-pack (unknown flag)', `git commit -F - --upload-pack='sh a.md' <<'EOF'\n${FP}\nEOF`);
block('git commit abbreviated long flag', `git commit --temp=x -F - <<'EOF'\n${FP}\nEOF`);
block('push beside a data heredoc', ADOC + PUSH + " --receive-pack='sh a.md' origin");
block('plain push beside a data heredoc', ADOC + PUSH + ' origin main');
block('pull beside a data heredoc', ADOC + "git pull --upload-pack='sh a.md' .");
block('clone beside a data heredoc', ADOC + "git clone --upload-pack='sh a.md' . x");
block('submodule foreach beside a data heredoc', ADOC + "git submodule foreach 'sh a.md'");
block('git --git-dir beside a data heredoc', ADOC + 'git --git-dir=x commit -m y');
block('git merge -s beside a data heredoc', ADOC + 'git merge -s ours x');
block('git log --ext-diff beside a data heredoc', ADOC + 'git log --ext-diff');
block('git diff --output beside a data heredoc', ADOC + 'git diff --output=x.md');
block('git notes edit beside a data heredoc', ADOC + 'git notes edit');
block('gh pr view beside a data heredoc', ADOC + 'gh pr view --web');
block('gh api beside a data heredoc', ADOC + 'gh api repos/o/r');
block('gh pr merge --body-file -', `gh pr merge 5 --body-file - <<'EOF'\n${FP}\nEOF`);
allow('gh issue comment -F -', `gh issue comment 5 -F - <<'EOF'\n${NOTE}EOF`);
allow('gh pr edit --body-file -', `gh pr edit 5 --body-file - <<'EOF'\n${NOTE}EOF`);
allow('gh release create --notes-file -', `gh release create v1 --title t --notes-file - <<'EOF'\n${NOTE}EOF`);
allow('git -C sub commit -q -F -', `git -C sub commit -q -F - <<'EOF'\nfix: x\n\n${NOTE}EOF`);
allow('git tag -a -F - then log -1 --format', `git tag -a v1 -F - <<'EOF'\n${NOTE}EOF\ngit log -1 --format=%H`);
allow('git notes add -F - HEAD', `git notes add -F - HEAD <<'EOF'\n${NOTE}EOF`);
allow('cat, then status/diff/log read-only flags', `cat <<'EOF' > n.md\n${NOTE}EOF\ngit status --short && git diff --stat && git log --oneline -5`);
allow('cat, then add -A and commit --amend --no-edit', `cat > n.md <<'EOF'\n${NOTE}EOF\ngit add -A && git commit --amend --no-edit`);

// --format / --pretty / --unified / --abbrev and -U take only an attached
// value in git, so the word after them is a flag (an unlisted one keeps the
// bodies scanned); the value lists match git's own grammar.
const CDOC = `git commit -F - <<'EOF'\n${FP}\nEOF\n`;
block('log --abbrev --output=x', CDOC + 'git log -1 --abbrev --output=x');
block('log --pretty --output=x', CDOC + 'git log -1 --pretty --output=x');
block('show --format --output=x', CDOC + 'git show --format --output=x');
block('diff --abbrev --ext-diff', CDOC + 'git diff --abbrev --ext-diff');
block('diff --unified --ext-diff', CDOC + 'git diff --unified --ext-diff');
block('diff -U --ext-diff', CDOC + 'git diff -U --ext-diff');
block('show -U --output=x', CDOC + 'git show -U --output=x');
allow('log --abbrev=8 --pretty=format:%h -U3', CDOC + 'git log -1 --abbrev=8 --pretty=format:%h -U3');
allow('diff --stat -U5 --unified=3', CDOC + 'git diff --stat -U5 --unified=3');
allow('log --date iso -n 2 --author me --diff-filter M', CDOC + 'git log --date iso -n 2 --author me --diff-filter M');
allow('tag -l --sort --format (both take the next word)', CDOC + "git tag -l --sort -v:refname --format '%(refname)'");

// git's revision parser does not cluster short options: `-pn` / `-wn 3`
// fatal only after `--output=FILE` truncated FILE. Beside a data heredoc,
// log/diff/show accept only modelled short forms (R3 A5).
block('log -pn --output', CDOC + 'git log -pn --output=.git/config');
block('log -wn 3 --output', CDOC + 'git log -wn 3 --output=.git/config');
block('show -qpn x --output', CDOC + 'git show -qpn x --output=.git/config');
block('diff -sn x --output', CDOC + 'git diff -sn x --output=x');
block('diff -wb cluster', CDOC + 'git diff -wb');
block('log -n <non-number> --output', CDOC + 'git log -n x --output=.git/config');
allow('log -U3 -M50% -5 -p -n 2 -n3', CDOC + 'git log -U3 -M50% -5 -p -n 2 -n3 --oneline');
allow('diff -w -b -p', CDOC + 'git diff -w -b -p');
