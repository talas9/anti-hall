// rules = "gh-rt": the GitHub realtime rules (feature #20, D88). Engine code that is not a hook asks this script for a rule through
// `script::call_fn("rules/gh-rt", <function>, <args>)` (JSON in, JSON out): how a GitHub answer reads as a small summary, what a
// repo's status is, which edges separate two statuses, how an edge reads aloud, what the statusline shows and how often a repo is
// polled again. The poller keeps the plumbing (the `gh api` calls, ETags, the rate budget and back-off, the state file); every
// word, list and threshold it hands in comes from github_rt.toml (and the owner's overrides of it), read by the poller, so this
// file holds only the logic. Editable like every other script of the plugin.
'use strict';

function ghStr(v, k) { var x = v !== null && typeof v === 'object' ? v[k] : undefined; return typeof x === 'string' ? x : ''; }
function ghCount(v, k) { var x = v !== null && typeof v === 'object' ? v[k] : undefined; return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0; }
function ghNames(v, k) { var x = v !== null && typeof v === 'object' ? v[k] : undefined; return Array.isArray(x) ? x.filter(function (s) { return typeof s === 'string'; }) : []; }
function ghUpper(s) { return s.replace(/[a-z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 32); }); }

// The pull request of a branch from the pulls list (newest first): an open one wins, else the newest; null when none.
function ghPulls(a) {
  var list = a.body;
  if (!Array.isArray(list)) return null;
  var at = -1, i;
  for (i = 0; i < list.length && at < 0; i++) if (ghStr(list[i], 'state') === 'open') at = i;
  if (at < 0 && list.length) at = 0;
  if (at < 0) return null;
  var pick = list[at], obj = pick !== null && typeof pick === 'object';
  var state = ghStr(pick, 'merged_at') !== '' ? 'merged' : (ghStr(pick, 'state') === 'open' ? 'open' : 'closed');
  return { number: ghCount(pick, 'number'), state: state, base: obj && pick.base !== null && typeof pick.base === 'object' ? ghStr(pick.base, 'ref') : '', title: ghStr(pick, 'title'), draft: obj && pick.draft === true, url: ghStr(pick, 'html_url') };
}

// One pull request: the mergeability.
function ghPull(a) {
  var b = a.body;
  return { mergeable_state: ghStr(b, 'mergeable_state'), mergeable: b !== null && typeof b === 'object' && b.mergeable !== undefined ? b.mergeable : null };
}

// The review decision from a pull request's reviews, oldest first: each reviewer's last approving or changes-requesting review counts,
// a dismissal removes it, a plain comment changes nothing.
function ghReviews(a) {
  var st = a.statuses, changes = ghStr(st, 'review_changes'), approved = ghStr(st, 'review_approved'), dismissed = ghStr(st, 'review_dismissed');
  var last = new Map(), list = Array.isArray(a.body) ? a.body : [];
  list.forEach(function (r) {
    var who = r !== null && typeof r === 'object' && r.user !== null && typeof r.user === 'object' ? ghStr(r.user, 'login') : '', s = ghUpper(ghStr(r, 'state'));
    if (s === changes || s === approved) last.set(who, s);
    else if (s === dismissed) last.delete(who);
  });
  var vals = Array.from(last.values());
  return vals.indexOf(changes) !== -1 ? 'changes_requested' : (vals.indexOf(approved) !== -1 ? 'approved' : 'none');
}

// The check runs (key check_runs) or workflow runs (workflow_runs) of a commit: counts and the names of the failing, running and all.
function ghRuns(a) {
  var st = a.statuses, running = ghNames(st, 'running'), failing = ghNames(st, 'failing'), skipped = ghNames(st, 'skipped');
  var names = [], fail = [], run = 0, total = 0, passed = 0;
  var rs = a.body !== null && typeof a.body === 'object' && Array.isArray(a.body[a.key]) ? a.body[a.key] : [];
  rs.forEach(function (r) {
    var status = ghStr(r, 'status'), concl = ghStr(r, 'conclusion'), name = ghStr(r, 'name');
    if (skipped.indexOf(concl) !== -1) return;
    total++;
    names.push(name);
    if (running.indexOf(status) !== -1 || (status !== 'completed' && concl === '')) run++;
    else if (failing.indexOf(concl) !== -1) fail.push(name);
    else passed++;
  });
  return { sha: a.sha, total: total, running: run, passed: passed, failing: fail, names: names };
}

// The required status check contexts of the branch rules (the required_status_checks rules).
function ghRules(a) {
  var req = [];
  (Array.isArray(a.body) ? a.body : []).filter(function (r) { return ghStr(r, 'type') === 'required_status_checks'; }).forEach(function (r) {
    var p = r.parameters !== null && typeof r.parameters === 'object' ? r.parameters.required_status_checks : null;
    (Array.isArray(p) ? p : []).forEach(function (c) {
      var ctx = ghStr(c, 'context');
      if (ctx !== '' && req.indexOf(ctx) === -1) req.push(ctx);
    });
  });
  return req;
}

// What a repo looks like now, derived from its summaries; edges are the differences between two of these.
function ghStatus(a) {
  var repo = a.repo, now = a.now, sha = ghStr(repo, 'sha');
  var own = function (k) { var c = repo[k]; return c !== null && typeof c === 'object' && ghStr(c, 'sha') === sha && sha !== '' ? c : null; };
  var checks = own('checks'), wf = own('runs');
  var failing = ghNames(checks, 'failing');
  if (failing.length === 0) failing = ghNames(wf, 'failing');
  var running = ghCount(checks, 'running') + ghCount(wf, 'running'), total = ghCount(checks, 'total') + ghCount(wf, 'total');
  var state = ghNames(checks, 'failing').length || ghNames(wf, 'failing').length ? 'red' : (running > 0 ? 'running' : (total > 0 ? 'green' : 'none'));
  var pushed = ghCount(repo, 'pushed_ms');
  if (state === 'none' && pushed > 0 && Math.max(0, now - pushed) < a.pushWatchMs) state = 'running';
  var pr = repo.pr !== undefined ? repo.pr : null, prState = pr === null ? 'none' : ghStr(pr, 'state');
  var required = ghNames(repo, 'required'), present = ghNames(checks, 'names');
  var missing = required.filter(function (r) { return present.indexOf(r) === -1; });
  var conflict = prState === 'open' && a.conflictStates.indexOf(ghStr(repo.detail, 'mergeable_state')) !== -1;
  return {
    checks: state, pr: prState, number: pr !== null && pr.number !== undefined ? pr.number : null, review: prState === 'open' ? ghStr(repo, 'review') : 'none',
    conflict: conflict, sha: sha, jobs: failing, required: required, required_missing: missing, total: total, running: running,
  };
}

// The edges between two statuses of the same repo and branch: [{kind, subject}]; none before the first full poll.
function ghEdges(a) {
  var prev = a.prev, nw = a.next;
  if (prev === null || prev === undefined) return [];
  var pc = ghStr(prev, 'checks'), nc = ghStr(nw, 'checks'), shaChanged = ghStr(prev, 'sha') !== ghStr(nw, 'sha'), out = [], sha = ghStr(nw, 'sha');
  if (nc === 'red' && (pc !== 'red' || shaChanged)) out.push({ kind: 'ci_red', subject: sha });
  if (nc === 'green' && (pc !== 'green' || shaChanged)) out.push({ kind: 'ci_green', subject: sha });
  var number = ghCount(nw, 'number'), samePr = JSON.stringify(prev.number === undefined ? null : prev.number) === JSON.stringify(nw.number === undefined ? null : nw.number), subject = String(number);
  if (samePr && ghStr(prev, 'pr') === 'open') {
    if (ghStr(nw, 'pr') === 'merged') out.push({ kind: 'pr_merged', subject: subject });
    if (ghStr(nw, 'pr') === 'closed') out.push({ kind: 'pr_closed', subject: subject });
  }
  if (ghStr(nw, 'pr') === 'open') {
    if (ghStr(nw, 'review') === 'changes_requested' && (ghStr(prev, 'review') !== 'changes_requested' || !samePr)) out.push({ kind: 'changes_requested', subject: subject });
    if (ghStr(nw, 'review') === 'approved' && (ghStr(prev, 'review') !== 'approved' || !samePr)) out.push({ kind: 'approved', subject: subject });
    if (nw.conflict === true && (prev.conflict !== true || !samePr)) out.push({ kind: 'conflict', subject: subject });
  }
  return out;
}

function ghWord(words, name, args) {
  var s = ghStr(words, name);
  Object.keys(args).forEach(function (k) { s = s.split('{' + k + '}').join(args[k]); });
  return s;
}

// How an edge reads: {text, jobs}.
function ghEdgeText(a) {
  var jobs = ghNames(a.status, 'jobs'), list = jobs.length === 0 ? ghWord(a.words, 'no_jobs', {}) : jobs.slice(0, a.jobsShown).join(ghStr(a.words, 'job_sep'));
  var sha = a.sha, short = sha.length >= 7 ? sha.slice(0, 7) : sha;
  return { text: ghWord(a.words, a.kind, { slug: a.slug, branch: a.branch, number: String(ghCount(a.status, 'number')), sha: short, jobs: list }), jobs: jobs };
}

// The statusline pieces for a repo's status, in the order of `kinds`.
function ghSegment(a) {
  var s = a.status, number = String(ghCount(s, 'number')), pr = ghStr(s, 'pr'), parts = [];
  var w = function (name) { return ghWord(a.words, name, { number: number }); };
  a.kinds.forEach(function (kind) {
    if (kind === 'checks') {
      var c = ghStr(s, 'checks');
      if (c === 'running') parts.push(w('segment_checks_running'));
      else if (c === 'red') parts.push(w('segment_checks_red'));
      else if (c === 'green') parts.push(w('segment_checks_green'));
    } else if (kind === 'pr') {
      if (pr === 'open') parts.push(w('segment_pr'));
      else if (pr === 'merged') parts.push(w('segment_merged'));
      else if (pr === 'closed') parts.push(w('segment_closed'));
    } else if (kind === 'review' && pr === 'open') {
      var r = ghStr(s, 'review');
      if (r === 'changes_requested') parts.push(w('segment_changes'));
      else if (r === 'approved') parts.push(w('segment_approved'));
      if (s.conflict === true) parts.push(w('segment_conflict'));
    }
  });
  return parts.join(ghStr(a.words, 'segment_sep'));
}

// Which polling interval a repo's status calls for: the name of its github_rt setting (poll_running_ms, poll_idle_ms, poll_nopr_ms
// or poll_done_ms).
function ghCadence(a) {
  var s = a.status, running = ghCount(s, 'running') > 0, c = ghStr(s, 'checks'), pr = ghStr(s, 'pr');
  if (c === 'running' || running) return 'poll_running_ms';
  if (pr === 'open') return 'poll_idle_ms';
  if (pr === 'none') return 'poll_nopr_ms';
  return 'poll_done_ms';
}
