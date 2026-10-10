// check = "git-audit" (PostToolUse on Bash): the audit pass of the git guard. The PreToolUse scan only sees the command line; a
// self-credit trailer can still land from outside it (a repository commit-msg hook, a commit template, a cherry-picked message,
// an editor). After a command that ran a commit-creating git verb, this reads the commits HEAD points at that were committed in
// the last git_audit.window_s seconds and advises the agent to reword any that carry a self-credit trailer before pushing. It
// never writes and never blocks. Built on git.js (script.includes): the tokenizer, the alias expansion and the credit patterns
// are the guard's. Mirrors hooks/git-guard.js `commitRepoDirs`, `auditRecentCommits` and the `--audit` branch of `main`.
'use strict';

function auditCommitRepoDirs(cmd, base, depth, out) {
  let cdDir = base;
  for (const seg of splitSegments(cmd)) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const ev = effectiveVerb(tokens);
    if (!ev) continue;
    if (ev.verb === ah.cfg('git_audit.cd_verb')) {
      const dirTok = ev.args.find((t) => !t.text.startsWith('-'));
      if (dirTok) cdDir = posix.resolveIn(S.procCwd, [cdDir, dirTok.text]);
      continue;
    }
    const isEval = ev.verb === ah.cfg('git_audit.eval_verb');
    if (depth < ah.cfg('git_audit.max_depth') && (isEval || TB.shellVerbs.has(ev.verb.toLowerCase()))) {
      const payload = isEval ? extractEvalPayload(seg) : extractShellCPayload(seg);
      if (payload) auditCommitRepoDirs(payload, cdDir, depth + 1, out);
      continue;
    }
    if (ev.verb !== ah.cfg('git_audit.git_verb')) continue;
    const { sub, rest } = gitSubcommand(ev.args);
    let creates = TB.commitCreating.has(sub);
    if (!creates) {
      const ex = expandAlias(ev.args, sub, rest, cdDir, undefined);
      creates = ex !== null && (ex.verb === '!' || ex.verb.startsWith('-') || TB.commitCreating.has(ex.verb));
    }
    if (!creates) continue;
    let dir = cdDir;
    const withValue = ah.cfg('git_audit.opts_with_value'), dirOpt = ah.cfg('git_audit.dir_opt');
    for (let k = 0; k < ev.args.length; k++) {
      const t = ev.args[k].text;
      if (t === dirOpt && k + 1 < ev.args.length) { dir = posix.resolveIn(S.procCwd, [dir, ev.args[k + 1].text]); k++; continue; }
      if (withValue.indexOf(t) >= 0) { k++; continue; }
      if (t.startsWith('-')) continue;
      break;
    }
    if (out.indexOf(dir) < 0) out.push(dir);
  }
  return out;
}

function auditRecentCommits(cmd, cwd) {
  const dirs = auditCommitRepoDirs(cmd, cwd, 0, []);
  const nowS = Math.floor(Date.now() / 1000), window = ah.cfg('git_audit.window_s');
  const rs = ah.cfg('git_audit.record_sep'), us = ah.cfg('git_audit.field_sep');
  const hits = [];
  for (const dir of dirs) {
    const argv = ah.cfg('git_audit.argv_log').map((a) => a.split('{dir}').join(dir).split('{n}').join(String(ah.cfg('git_audit.commits'))));
    const out = gitRun(argv, null, null, ah.cfg('git_audit.timeout_ms'));
    if (out === null || out === '' || out.length > ah.cfg('git_audit.max_buffer')) continue;
    for (const rec of out.split(rs)) {
      const f = rec.replace(/^\n/, '').split(us);
      const sha = f[0], ct = f[1], body = f[2];
      if (!sha || !body || Number(ct) < nowS - window) continue;
      if (hasSelfCredit(body)) hits.push(sha.trim() + (dirs.length > 1 ? ' (' + dir + ')' : ''));
    }
  }
  return hits;
}

function decide(p, opts, event) {
  if (!p || p.tool_name !== 'Bash') return null;
  const ti = p.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.command !== 'string') return null;
  TB = gitTables();
  if (!gitSettingOn('git.setting_git_guard') || ah.settings.skipped(ah.cfg('git.guard_name')) || ti.command === '') return 'allow';
  // Node falls back to its own process directory without a cwd (or resolves a relative one against it): lib/78-hook-proc.js
  // a relative payload cwd resolves against the hook process's own directory, which the daemon cannot know: Node decides
  if (typeof p.cwd === 'string' && p.cwd !== '' && p.cwd.charAt(0) !== '/') return 'defer';
  const cwd = hookProc.cwd(p);
  let home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  S = gitFreshState(ti.command, cwd, null);
  S.home = home || '';
  S.abs = (q) => (q.charAt(0) === '/' ? q : posix.resolveIn(cwd, [q]));
  S.pluginRoot = '';
  shellScan.reset();
  const hits = auditRecentCommits(ti.command, cwd);
  if (!hits.length) return 'allow';
  const t = text.render(ah.cfg('git_audit.msg'), { window_min: Math.floor(ah.cfg('git_audit.window_s') / 60), hits: hits.join(', ') });
  return { advisory: JSON.stringify({ hookSpecificOutput: { hookEventName: ah.cfg('git_audit.event'), additionalContext: t } }) };
}
