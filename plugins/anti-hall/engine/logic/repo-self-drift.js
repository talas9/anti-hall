// check = "repo-self-drift" (SessionStart). Probe 3 of the drift family, with no network and no background process: it compares the
// hook and skill counts that docs/KB.md claims in its own prose with what is on disk, and says when the model KBs were last audited
// more than the threshold ago. The scan is cached for a day; each advisory is said once per unchanged finding. Mirrors
// hooks/repo-self-drift.js. Keys and texts: session.toml (session.*).
'use strict';

function rsdScan(root, now) {
  var result = { checkedAt: now }, hooksDir = root + '/' + ah.cfg('session.hooks_dir');
  var kb = null, cands = [ah.path.join(root, ah.cfg('session.kb_installed')), ah.path.join(root, ah.cfg('session.kb_repo'))];
  for (var i = 0; i < cands.length; i++) { if (ah.fs.isFile(cands[i]) || ah.fs.isDir(cands[i])) { kb = cands[i]; break; } }
  var hooksList = ah.fs.readdir(hooksDir), actualHooks = hooksList === null ? null : hooksList.filter(function (f) { return f.endsWith(ah.cfg('session.js_ext')); }).length;
  var skillsDir = root + '/' + ah.cfg('session.skills_dir'), skillsList = ah.fs.readdir(skillsDir);
  var actualSkills = skillsList === null ? null : skillsList.filter(function (n) { return ah.fs.kind(skillsDir + '/' + n) === 'dir'; }).length;
  if (kb) {
    var kbText = ah.fs.readText(kb);
    if (kbText) {
      var hm = new RegExp(ah.cfg('session.hooks_claim_re')).exec(kbText), sm = new RegExp(ah.cfg('session.skills_claim_re')).exec(kbText);
      result.claimedHooks = hm ? parseInt(hm[1], 10) : null;
      result.actualHooks = actualHooks;
      result.claimedSkills = sm ? parseInt(sm[1], 10) : null;
      result.actualSkills = actualSkills;
    }
  }
  var today = new Date(now).toISOString().slice(0, 10), audit = ah.cfg('session.model_kb_audit_date');
  var a = new Date(audit + 'T00:00:00Z').getTime(), b = new Date(today + 'T00:00:00Z').getTime();
  result.modelKbAuditDate = audit;
  result.modelKbAgeDays = isFinite(a) && isFinite(b) ? Math.round((b - a) / ah.cfgNum('session.day_ms')) : null;
  return result;
}

function decide(p, opts) {
  if (sess.judgeChild()) return 'allow';
  var home = spawn.osHome(), root = sess.pluginRoot(opts);
  if (home === null || root === null) return 'defer';
  if (!ah.settings.bool('session.setting_repo_self_drift') || ah.settings.skipped(ah.cfg('session.repo_self_drift_guard'))) return 'allow';
  var now = ah.clock.now(), rel = ah.cfg('session.repo_self_drift_cache'), cache = sess.readCache(rel);
  if (!sess.isFresh(cache, now, ah.cfgNum('session.drift_cache_ttl_ms'))) {
    cache = rsdScan(root, now);
    // the scan and its write are one step in Node: a failure of either says nothing this session
    try { if (!ah.state.writeAtomic(rel, JSON.stringify(cache))) return 'allow'; } catch (e) { return 'allow'; }
  }
  var lines = [], lastAdvised = (cache && cache.lastAdvised) || {};
  var finite = function (v) { return typeof v === 'number' && isFinite(v); };
  var countsKey = null;
  if (finite(cache.claimedHooks) && finite(cache.actualHooks) && finite(cache.claimedSkills) && finite(cache.actualSkills)) {
    var hooksMismatch = cache.claimedHooks !== cache.actualHooks, skillsMismatch = cache.claimedSkills !== cache.actualSkills;
    if (hooksMismatch || skillsMismatch) {
      countsKey = { claimedHooks: cache.claimedHooks, actualHooks: cache.actualHooks, claimedSkills: cache.claimedSkills, actualSkills: cache.actualSkills };
      if (!sess.alreadyAdvised({ lastAdvised: lastAdvised.counts }, countsKey)) {
        var parts = [];
        if (hooksMismatch) parts.push(text.render(ah.cfg('session.drift_hooks_part'), { claimed: cache.claimedHooks, actual: cache.actualHooks }));
        if (skillsMismatch) parts.push(text.render(ah.cfg('session.drift_skills_part'), { claimed: cache.claimedSkills, actual: cache.actualSkills }));
        lines.push(text.render(ah.cfg('session.drift_counts_line'), { parts: parts.join(ah.cfg('session.parts_sep')) }));
      }
    }
  }
  var staleKey = null, threshold = ah.cfgNum('session.staleness_threshold_days');
  if (finite(cache.modelKbAgeDays) && cache.modelKbAgeDays > threshold) {
    staleKey = { modelKbAuditDate: cache.modelKbAuditDate };
    if (!sess.alreadyAdvised({ lastAdvised: lastAdvised.staleness }, staleKey)) {
      lines.push(text.render(ah.cfg('session.drift_stale_line'), { date: cache.modelKbAuditDate, age: cache.modelKbAgeDays, threshold: threshold }));
    }
  }
  if (lines.length === 0) return 'allow';
  var next = Object.assign({}, lastAdvised);
  if (countsKey) next.counts = countsKey;
  if (staleKey) next.staleness = staleKey;
  sess.persist(rel, cache, next);
  return sess.advisory(lines.join('\n'));
}
