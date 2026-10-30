// check = "git-audit" (PostToolUse on Bash): the authoritative commit layer of the git guard. The PreToolUse scan only reads
// the command text, which a shell form can hide a credit from; this pass reads what git stored. After any Bash call it reads
// HEAD's reflog for commits written in the last git_audit.window_s seconds (commit, amend, merge, cherry-pick, rebase) and
// blocks with "reword before pushing" when one HEAD still reaches and no remote has carries a self-credit, and once (state file
// git_audit.published_file) when one a remote already has does: committed and pushed in one call. It never writes to git.
// Off switch: guards.gitCommitAudit. Built on git.js (script.includes): the credit patterns and git runner are the guard's.
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

// The authoritative commit check (Codex re-review of PR #469): which commits a Bash call created is read from git, not from
// the command text. HEAD's reflog names every commit an amend, merge, cherry-pick or rebase step wrote, and when; the ones
// written in the last git_audit.window_s seconds that HEAD still reaches and no remote has are read with `git log` and their
// stored messages scanned. A credit therefore is found whatever shell form wrote it (here-strings, positional parameters,
// abbreviated options, a message file, ANSI-C escapes, a commit-msg hook or a template). An amended-away commit is no longer
// reachable from HEAD, so it is never reported again.
function auditCreatedShas(dir, nowS) {
  const rs = ah.cfg('git_audit.record_sep'), us = ah.cfg('git_audit.field_sep');
  const argv = ah.cfg('git_audit.argv_reflog').map((a) => a.split('{dir}').join(dir).split('{n}').join(String(ah.cfg('git_audit.commits'))));
  const out = gitRun(argv, null, null, ah.cfg('git_audit.timeout_ms'));
  if (!out || out.length > ah.cfg('git_audit.max_buffer')) return [];
  const verbs = ah.cfg('git_audit.reflog_creating'), window = ah.cfg('git_audit.window_s');
  const shas = [];
  for (const rec of out.split(rs)) {
    const f = rec.replace(/^\n/, '').split(us);
    const sha = (f[0] || '').trim(), at = /\{(\d+)\}/.exec(f[1] || ''), what = (f[2] || '').toLowerCase();
    if (!sha || !at) continue;
    if (Number(at[1]) < nowS - window) break; // the reflog is newest first
    if (verbs.some((v) => what.startsWith(v)) && shas.indexOf(sha) < 0) shas.push(sha);
  }
  return shas;
}

// Codex P1 of PR #469 at 375cf8fe: `git commit ... && git push` in one call leaves the new commit on a remote before this
// audit runs, so the unpushed log above no longer lists it. A commit written in the window that a remote already has is read
// here and reported as published, once per hash (the agent cannot clear it without rewriting published history).
function auditPublished(dir, created, listed, label, out) {
  const rest = created.filter((x) => listed.indexOf(x) < 0);
  if (!rest.length) return;
  const rs = ah.cfg('git_audit.record_sep'), us = ah.cfg('git_audit.field_sep');
  const argv = [];
  for (const a of ah.cfg('git_audit.argv_published')) { if (a === '{shas}') argv.push(...rest); else argv.push(a.split('{dir}').join(dir)); }
  const log = gitRun(argv, null, null, ah.cfg('git_audit.timeout_ms'));
  if (!log || log.length > ah.cfg('git_audit.max_buffer')) return;
  for (const rec of log.split(rs)) {
    const f = rec.replace(/^\n/, '').split(us);
    const sha = (f[0] || '').trim();
    if (!sha || !f[1] || !hasSelfCredit(f[1]) || out.seen.indexOf(sha) >= 0) continue;
    const ref = (gitRun(ah.cfg('git_audit.argv_remote_has').map((a) => a.split('{dir}').join(dir).split('{sha}').join(sha)), null, null, ah.cfg('git_audit.timeout_ms')) || '').trim();
    if (!ref) continue; // amended away and never pushed: nothing published
    out.shas.push(sha);
    out.hits.push(sha.slice(0, TB.commitHashShort) + label);
    if (out.remotes.indexOf(ref) < 0) out.remotes.push(ref);
  }
}

function publishedRel() { return ah.cfg('replykit.state_dir') + '/' + ah.cfg('git_audit.published_file'); }

function publishedSeen() {
  try { const v = JSON.parse(ah.state.readText(publishedRel()) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

function auditRecentCommits(cmd, cwd, pub) {
  const dirs = [cwd];
  try { auditCommitRepoDirs(cmd, cwd, 0, dirs); } catch (e) { if (gitFatal(e)) throw e; } // extra repositories named by the command
  const nowS = Math.floor(Date.now() / 1000);
  const rs = ah.cfg('git_audit.record_sep'), us = ah.cfg('git_audit.field_sep');
  const hits = [];
  for (const dir of dirs) {
    const created = auditCreatedShas(dir, nowS);
    if (!created.length) continue;
    const argv = ah.cfg('git_audit.argv_log').map((a) => a.split('{dir}').join(dir).split('{n}').join(String(ah.cfg('git_audit.commits'))));
    const out = gitRun(argv, null, null, ah.cfg('git_audit.timeout_ms'));
    if (out === null || out.length > ah.cfg('git_audit.max_buffer')) continue;
    const label = dirs.length > 1 ? ' (' + dir + ')' : '';
    const listed = [];
    for (const rec of out.split(rs)) {
      const f = rec.replace(/^\n/, '').split(us);
      const sha = (f[0] || '').trim(), body = f[1];
      if (!sha) continue;
      listed.push(sha);
      if (!body || created.indexOf(sha) < 0) continue;
      const short = sha.slice(0, TB.commitHashShort) + label;
      if (hasSelfCredit(body) && hits.indexOf(short) < 0) hits.push(short);
    }
    auditPublished(dir, created, listed, label, pub);
  }
  return hits;
}

function decide(p, opts, event) {
  if (!p || p.tool_name !== 'Bash') return null;
  const ti = p.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.command !== 'string') return null;
  TB = gitTables();
  if (!gitSettingOn('git.setting_git_guard') || !gitSettingOn('git.setting_commit_audit') || ah.settings.skipped(ah.cfg('git.guard_name')) || ti.command === '') return 'allow';
  // Node falls back to its own process directory without a cwd (or resolves a relative one against it): lib/78-hook-proc.js
  // a relative payload cwd resolves against the stand-in for the hook process's directory (counted)
  if (typeof p.cwd === 'string' && p.cwd !== '' && p.cwd.charAt(0) !== '/') ah.unable('git-audit:relative_cwd'); // resolved against the stand-in directory (hookProc.cwd)
  const cwd = hookProc.cwd(p);
  let home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  S = gitFreshState(ti.command, cwd, null);
  S.home = home || '';
  S.abs = (q) => (q.charAt(0) === '/' ? q : posix.resolveIn(cwd, [q]));
  S.pluginRoot = '';
  shellScan.reset();
  const pub = { seen: publishedSeen(), shas: [], hits: [], remotes: [] };
  const hits = auditRecentCommits(ti.command, cwd, pub);
  if (pub.hits.length) {
    // remembered before the block is returned, so the next call is not blocked again for the same published commit
    const keep = pub.seen.concat(pub.shas).slice(-ah.cfg('git_audit.published_memory'));
    try { ah.state.writeAtomic(publishedRel(), JSON.stringify(keep)); } catch (e) { /* a lost write only repeats the report */ }
    try { ah.metric('git_audit_blocked', []); ah.metric('git_blocked', ['reason', ah.cfg('git_audit.block_reason_published')]); } catch (e) { /* counting never fails a hook */ }
    const mp = ah.cfg('git_audit.msg_published'), pa = { hits: pub.hits.join(', '), remotes: pub.remotes.join(', ') };
    const rp = (x) => (x === undefined ? '' : text.render(x, pa));
    return { block: gm({ what: rp(mp.what), why: rp(mp.why), instead: rp(mp.instead), override: rp(mp.override) }) };
  }
  if (!hits.length) return 'allow';
  try { ah.metric('git_audit_blocked', []); ah.metric('git_blocked', ['reason', ah.cfg('git_audit.block_reason')]); } catch (e) { /* counting never fails a hook */ }
  const m = ah.cfg('git_audit.msg'), args = { hits: hits.join(', '), first: hits[hits.length - 1].split(' ')[0] };
  const r = (x) => (x === undefined ? '' : text.render(x, args));
  return { block: gm({ what: r(m.what), why: r(m.why), instead: r(m.instead), override: r(m.override) }) };
}
