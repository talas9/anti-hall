#!/usr/bin/env node
// Differential-fuzz corpus generator for run-git.js: mutates seed commands (the parity corpora) with shell-syntax
// edits and wrapper templates. node fuzz-git.js --seeds a.jsonl,b.jsonl [--n 20000] [--seed 1] [--maxlen 700] > fuzz.jsonl
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 20000), MAXLEN = +arg('--maxlen', 700);
let st = (+arg('--seed', 1)) >>> 0;
const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = n => Math.floor(rnd() * n);
const seeds = [];
for (const f of arg('--seeds', '').split(',').filter(Boolean)) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { const o = JSON.parse(l); if (o.command && o.command.length < 500) seeds.push(o); } catch {} }
const P = 'pu' + 'sh', F = '--for' + 'ce', CO = 'Co-Authored' + '-By', GEN = 'Generated' + ' with';
const FRAG = [`git ${P} ${F} origin main`, `git ${P} -f`, `git ${P} origin +main`, `git ${P} origin :b`, `git ${P} --delete origin b`, `git commit -m "x\n\n${CO}: Claude <noreply@anthropic.com>"`, `git commit -F - <<'EOF'\n${GEN} Claude Code\nEOF`, 'git status', 'git log -1', 'echo hi', 'ls -la', 'cat f.md', `git -c alias.p=${P} p ${F}`, `git config alias.x '!git ${P} ${F}'`, 'git commit --amend --no-edit', 'git add -A', `git ${P}`, 'git commit -m ok'];
const SPECIAL = ['\'', '"', '`', '$', '(', ')', '{', '}', '[', ']', '<', '>', '|', '&', ';', '\n', '\\', '#', '!', '*', '?', ' ', '-', '+', ':', '=', '$(', '<<', '<<<', '&&', '||', '\\\n', '$\'', '\t', '\r', 'é', '\u{1F916}', '\0', '\u0085', '\ufeff', '\u180e', '\u2028', '\u2029', '\u00a0'];
const WRAP = [
  s => `bash -c ${JSON.stringify(s)}`, s => `sh -c '${s.replace(/'/g, "'\\''")}'`, s => `eval ${JSON.stringify(s)}`, s => `$(${s})`, s => `{ ${s}; }`, s => `( ${s} )`,
  s => `sudo ${s}`, s => `env A=1 ${s}`, s => `command ${s}`, s => `time ${s}`, s => `nohup ${s}`, s => `timeout 5 ${s}`, s => `nice -n 5 ${s}`, s => `FOO=bar ${s}`,
  s => `echo ${JSON.stringify(s)} | sh`, s => `printf '%s' ${JSON.stringify(s)} | bash`, s => `xargs ${s}`, s => `echo a | xargs -I{} ${s}`, s => `find . -exec ${s} \\;`, s => `parallel ${s} ::: a`,
  s => `cat > n.md <<'EOF'\n${s}\nEOF`, s => `cat <<'EOF' | bash\n${s}\nEOF`, s => `cat > n.md <<EOF\n${s}\nEOF\n${pick(FRAG)}`, s => `${s} # comment`, s => `# c\n${s}`, s => `echo x && ${s}`, s => `echo x; ${s}`, s => `${s} &`, s => `if true; then ${s}; fi`, s => `for i in 1; do ${s}; done`,
  s => `cd /tmp && ${s}`, s => `exec ${s}`, s => `flock f ${s}`, s => `stdbuf -o0 ${s}`, s => `git -C . ${s.replace(/^git /, '')}`, s => `function f { ${s}; }; f`, s => `alias g='${s.replace(/'/g, '')}'; g`, s => `x=$(${s})`, s => `"${s}"`, s => `'${s.replace(/'/g, '')}'`,
];
const mut = s => {
  const k = ri(9);
  const a = ri(s.length + 1);
  if (k === 0) return s.slice(0, a) + pick(SPECIAL) + s.slice(a);
  if (k === 1 && s.length) return s.slice(0, a) + s.slice(a + 1 + ri(3));
  if (k === 2) return pick(WRAP)(s);
  if (k === 3) return s + pick([' ; ', ' && ', ' | ', '\n', ' || ']) + pick(FRAG);
  if (k === 4) return pick(FRAG) + pick([' ; ', ' && ', ' | ', '\n']) + s;
  if (k === 5) { const w = s.split(' '); if (w.length > 2) { const i = ri(w.length - 1); [w[i], w[i + 1]] = [w[i + 1], w[i]]; } return w.join(' '); }
  if (k === 6) return s.replace(pick([/ /, /'/, /"/, /\n/]), pick(SPECIAL));
  if (k === 7) { const i = ri(s.length + 1); return s.slice(0, i) + '\\' + s.slice(i); }
  return s.slice(0, a) + s.slice(a, a + ri(20)) + s.slice(a);
};
// --gen: compose from a grammar instead of mutating seeds (random wrappers, quoting, flags, heredoc consumers).
const quoteTok = t => { const k = ri(8); return k === 0 ? `"${t}"` : k === 1 ? `'${t}'` : k === 2 ? `$'${t}'` : k === 3 ? t.split('').join('""') : t; };
const PUSHFLAGS = ['-f', F, '--force-with-lease', '+main', 'origin', 'main', ':b', '--delete', '-d', '--no-verify', '-u', '--tags', '--mirror', '--prune', '--', '-fv', '--force-if-includes', '--for', '--del', 'HEAD:refs/heads/x', '+HEAD:x', '--repo=r'];
const gitCmd = () => {
  const k = ri(6);
  const pre = pick(['', '', 'sudo ', 'env A=1 ', 'command ', 'nice -n 3 ', 'timeout 9 ', 'time ', 'exec ', 'flock /tmp/l ', 'FOO=1 ', '/usr/bin/', '\\']);
  const glob = pick(['', '', '-C . ', '-c core.x=1 ', '--no-pager ', '-c alias.p=push ', '--git-dir=.git ']);
  if (k <= 2) { const n = 1 + ri(4); const fl = Array.from({ length: n }, () => quoteTok(pick(PUSHFLAGS))); return `${pre}git ${glob}${quoteTok(pick([P, P, P, 'p']))} ${fl.join(' ')}`; }
  if (k === 3) return `${pre}git ${glob}commit ${pick(['-m', '-am', '--message=', '-F -', '--trailer', '-C HEAD', '--amend --no-edit', '-t f'])} ${quoteTok(pick(['x', `y\\n\\n${CO}: Claude <n@a.com>`, `${GEN} Claude Code`, 'ok']))}`;
  if (k === 4) return `${pre}git ${glob}${pick(['status', 'log -1', 'config alias.x ' + quoteTok('!git ' + P + ' ' + F), 'tag -a v1 -m ' + quoteTok(CO + ': Claude <a@b.c>'), 'add -A', 'stash', 'fetch', 'config --global alias.q ' + quoteTok(P + ' -f')])}`;
  return pick(['echo hi', 'ls', 'cat x', 'true', 'cd /tmp', 'export X=1', `echo ${quoteTok(`git ${P} ${F}`)}`, 'node -e "1"', `python3 -c ${quoteTok('print(1)')}`]);
};
const genCmd = () => {
  let c = gitCmd();
  for (let i = 0, n = ri(3); i < n; i++) c = pick(WRAP)(c);
  const parts = [c];
  for (let i = 0, n = ri(3); i < n; i++) parts.push(pick(WRAP)(gitCmd()));
  const sep = [' ; ', ' && ', ' | ', '\n', ' || ', ' & '];
  return parts.map((p, i) => (i ? pick(sep) : '') + p).join('');
};
const out = new Set();
let guard = 0;
if (process.argv.includes('--gen')) {
  while (out.size < N && guard++ < N * 5) { const c = genCmd(); if (c.length <= MAXLEN && c.trim()) out.add(c); }
  for (const c of out) console.log(JSON.stringify({ command: c, cwd: '/tmp', source: 'gen' }));
  process.exit(0);
}
while (out.size < N && guard++ < N * 5) {
  const base = rnd() < 0.7 && seeds.length ? pick(seeds).command : pick(FRAG);
  let c = base;
  for (let i = 0, n = 1 + ri(3); i < n; i++) c = mut(c);
  if (c.length > MAXLEN || !c.trim()) continue;
  out.add(c);
}
for (const c of out) console.log(JSON.stringify({ command: c, cwd: '/tmp', source: 'fuzz' }));
