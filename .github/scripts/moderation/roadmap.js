'use strict';
// roadmap.yml: keeps the "anti-hall roadmap" board and labels consistent (labels and state win; every
// correction is logged to the job summary), fills the live "Last update" and "Progress" fields,
// labels stale in-progress work and, on other people's items, keeps one nudge comment (never closes), writes the weekly digest to the private
// board as a project status update (job summary fallback; never a public issue), and reports the
// weekly mistake rate of all the automation. Event runs touch only the item the event is about; the
// 6-hourly and manual runs reconcile every open issue and PR.
// Board writes need PROJECT_TOKEN (or ROADMAP_PROJECT_TOKEN); without it they are skipped with a
// notice and the label-based parts still run. Only closes issues delivered on dev by a merged PR (delivered.js); never deletes or archives.

const fs = require('node:fs');
const L = require('./lib.js');
const SEC = require('./security-alerts.js');
const DELIVERED = require('./delivered.js');
const B = require('./board.js');
const LOG = 'roadmap-log';
const DAY = 864e5;

const prio = (labels) => { const p = labels.find((l) => /^priority:P[0-3]$/.test(l)); return p ? Number(p.slice(-1)) : 4; };
const names = (x) => (x.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

async function openItems(github, repo) {
  const all = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'open', per_page: 100 });
  return all.map((i) => ({ number: i.number, node_id: i.node_id, title: i.title, pr: !!i.pull_request, labels: names(i), updated: i.updated_at, created: i.created_at, milestone: i.milestone && i.milestone.title, body: i.body || '', author: i.user && i.user.login }));
}

// Blockers: GitHub issue dependencies (blockedBy) when available, plus "blocked by #n" / "depends on #n" text.
async function blockers(github, repo, items) {
  const open = new Set(items.map((i) => i.number));
  const out = {};
  for (const i of items) {
    const refs = [...i.body.matchAll(/\b(?:blocked by|depends on)\s+#(\d+)/gi)].map((m) => Number(m[1]));
    out[i.number] = refs.filter((n) => open.has(n));
  }
  try {
    const q = `query($o:String!,$r:String!,$c:String){repository(owner:$o,name:$r){issues(states:OPEN,first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{number blockedBy(first:10){nodes{number state}}}}}}`;
    let c = null;
    for (let page = 0; page < 5; page++) {
      const r = (await github.graphql(q, { o: repo.owner, r: repo.repo, c })).repository.issues;
      for (const n of r.nodes) for (const b of n.blockedBy.nodes) if (b.state === 'OPEN') (out[n.number] = out[n.number] || []).push(b.number);
      if (!r.pageInfo.hasNextPage) break;
      c = r.pageInfo.endCursor;
    }
  } catch { /* dependencies API unavailable: text references only */ }
  return out;
}

// Next-up ranking: priority first, then age (capped at 90 days); items with an open blocker go last.
function rank(items, blocked, cfg) {
  const now = Date.now();
  return items
    .filter((i) => !i.pr && !i.labels.includes('status:in-progress') && !i.labels.includes('status:blocked') && i.labels.some((l) => l === 'status:accepted' || l === 'status:triage'))
    .map((i) => {
      const age = (now - new Date(i.created)) / DAY;
      const b = (blocked[i.number] || []).length;
      return { ...i, score: (4 - prio(i.labels)) * 100 + Math.min(age, 90) - (b ? 1000 : 0), blockedBy: blocked[i.number] || [] };
    })
    .sort((a, b) => b.score - a.score);
}

function suggestMilestone(i, cfg) {
  const text = `${i.title}\n${i.body}`.toLowerCase();
  const hit = Object.entries(cfg.triage.milestones).find(([, words]) => words.some((w) => text.includes(w)));
  return (hit && hit[0]) || cfg.triage.default_milestone;
}

async function plan({ github, context, core }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const sched = context.payload.schedule || '';
  const mode = context.eventName === 'workflow_dispatch' ? context.payload.inputs.mode : (sched.trim().endsWith('1') ? 'weekly' : 'sync');
  const items = await openItems(github, repo);
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const closed = mode === 'weekly' ? (await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'closed', since, per_page: 100 }))
    .filter((i) => i.closed_at >= since && (!i.pull_request || i.pull_request.merged_at)).map((i) => ({ number: i.number, title: i.title, pr: !!i.pull_request })) : [];
  const blocked = mode === 'weekly' ? await blockers(github, repo, items) : {};
  const next = mode === 'weekly' ? rank(items, blocked, cfg).slice(0, cfg.project.digest_next) : [];
  const moves = mode === 'weekly' ? items.filter((i) => !i.pr && !i.milestone).slice(0, 15).map((i) => ({ number: i.number, to: suggestMilestone(i, cfg) })) : [];
  const state = { mode, closed, next: next.map(({ body, ...x }) => x), moves };
  let want = false;
  if (mode === 'weekly') {
    const chain = L.chain(process.env.AI_PROVIDER, cfg);
    const cap = Number(process.env.AI_DAILY_CAP || cfg.model.default_daily_cap);
    const b = chain.length ? await L.budget(github, context, 'roadmap.yml', cap) : { ok: false };
    if (chain.length && b.ok) {
      want = true;
      const data = { done: closed.map((c) => c.title), in_progress: items.filter((i) => i.labels.includes('status:in-progress')).map((i) => i.title), next: next.map((n) => n.title) };
      core.setOutput('prompt', L.buildPrompt('digest', JSON.stringify(data), '', cfg));
      core.setOutput('schema', JSON.stringify(L.prompt('digest').schema));
      core.setOutput('claude_model', L.modelFor(cfg, 'digest').claude);
      core.setOutput('copilot_model', L.modelFor(cfg, 'digest').copilot);
      core.setOutput('chain', chain.join(','));
    } else state.model_skip = chain.length ? 'daily cap reached' : 'AI_PROVIDER=none';
  }
  core.setOutput('want_model', want ? 'true' : 'false');
  core.setOutput('state', JSON.stringify(state));
  core.info(`mode=${mode} open=${items.length} closed7d=${closed.length} model=${want}`);
}

// Activity of open items in one batched GraphQL call per 25 numbers: latest comments (for the
// "Progress" line), references/commits (for "Last update"). Read with the workflow token.
const ACT = `createdAt comments(last:10){nodes{createdAt body authorAssociation author{login}}}
  timelineItems(last:5,itemTypes:[REFERENCED_EVENT,CROSS_REFERENCED_EVENT]){nodes{... on ReferencedEvent{createdAt} ... on CrossReferencedEvent{createdAt}}}`;

async function activity(github, repo, numbers, cfg) {
  const out = {};
  for (let i = 0; i < numbers.length; i += 25) {
    const chunk = numbers.slice(i, i + 25);
    const q = `query($o:String!,$r:String!){repository(owner:$o,name:$r){${chunk.map((n) => `i${n}:issueOrPullRequest(number:${n}){... on Issue{${ACT}} ... on PullRequest{${ACT} commits(last:1){nodes{commit{committedDate}}}}}`).join(' ')}}}`;
    let repoData;
    try { repoData = (await github.graphql(q, { o: repo.owner, r: repo.repo })).repository; } catch { continue; }
    for (const n of chunk) {
      const x = repoData['i' + n];
      if (!x) continue;
      const comments = x.comments.nodes.map((c) => ({ createdAt: c.createdAt, body: c.body, association: c.authorAssociation, login: c.author && c.author.login }));
      const refs = x.timelineItems.nodes.map((t) => t.createdAt).filter(Boolean);
      const commitDate = x.commits && x.commits.nodes[0] ? x.commits.nodes[0].commit.committedDate : null;
      out[n] = {
        last: B.lastUpdate({ createdAt: x.createdAt, comments, refs, commitDate }),
        progress: B.progressFrom(comments, cfg),
      };
    }
  }
  return out;
}

const FIELD_Q = `query($l:String!,$n:Int!,$c:String){user(login:$l){projectV2(number:$n){id
    fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}
    items(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{id
      content{... on Issue{number state repository{nameWithOwner}} ... on PullRequest{number state merged repository{nameWithOwner}}}
      fieldValues(first:30){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}}}}}}}}`;

// Reconcile the board with the repo. Labels and state win over the board. `only` = Set of numbers
// (event runs touch just those items) or null (the scheduled/manual run reconciles everything).
async function boardSync({ getOctokit, core, cfg, items, repo, act, only, acts, corrections }) {
  const token = process.env.PROJECT_TOKEN;
  if (!token) { core.notice('Board sync skipped: PROJECT_TOKEN empty/missing (ROADMAP_PROJECT_TOKEN also accepted).'); return { skipped: 'PROJECT_TOKEN empty/missing' }; }
  const gql = getOctokit(token).graphql;
  let proj = null, c = null;
  const boardItems = [];
  for (let page = 0; page < 10; page++) {
    const p = (await gql(FIELD_Q, { l: cfg.project.owner, n: cfg.project.number, c })).user.projectV2;
    proj = proj || p;
    boardItems.push(...p.items.nodes);
    if (!p.items.pageInfo.hasNextPage) break;
    c = p.items.pageInfo.endCursor;
  }
  const P = cfg.project;
  const fields = proj.fields.nodes.filter((f) => f && f.name);
  const field = (name) => fields.find((f) => f.name === name);
  // The two live-progress fields are created once when missing.
  for (const [name, dataType] of [[P.fields.last_update, 'DATE'], [P.fields.progress, 'TEXT']]) {
    if (field(name)) continue;
    const made = await act({ type: 'field-create', name, dataType }, () => gql('mutation($p:ID!,$n:String!,$t:ProjectV2CustomFieldType!){createProjectV2Field(input:{projectId:$p,name:$n,dataType:$t}){projectV2Field{... on ProjectV2Field{id name dataType}}}}', { p: proj.id, n: name, t: dataType }));
    if (made && made.createProjectV2Field.projectV2Field) fields.push(made.createProjectV2Field.projectV2Field);
  }
  const subIssues = !!field('Sub-issues progress');
  let writes = 0, missingOption = 0;
  const set = async (it, name, value, number, from) => {
    const f = field(name);
    if (!f || value === undefined || value === null || value === '' || String(from ?? '') === String(value) || writes >= P.max_field_writes_per_run) return;
    let v;
    if (f.options) { const o = f.options.find((x) => x.name === value); if (!o) { missingOption++; return; } v = { singleSelectOptionId: o.id }; }
    else if (f.dataType === 'DATE') v = { date: value };
    else if (f.dataType === 'TEXT') v = { text: value };
    else v = { number: Number(value) };
    writes++;
    corrections.push({ number, field: name, from: from ?? null, to: value });
    await act({ type: 'field', item: it.id, number, field: name, value }, () => gql('mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){projectV2Item{id}}}', { p: proj.id, i: it.id, f: f.id, v }));
  };
  const byNum = new Map(items.map((i) => [i.number, i]));
  const full = `${repo.owner}/${repo.repo}`;
  const onBoard = new Set();
  let missingEstimate = 0;
  const reconcile = async (it, number, open, ct, have) => {
    const labels = open ? open.labels : [];
    const closedState = open ? 'OPEN' : (ct && (ct.merged ? 'MERGED' : ct.state));
    const { status } = B.deriveStatus({ labels, state: closedState, merged: ct && ct.merged, pr: open ? open.pr : !!(ct && 'merged' in ct) }, cfg);
    if (status) await set(it, 'Status', status, number, have.Status);
    const pr = labels.find((l) => /^priority:P[0-3]$/.test(l));
    const sz = labels.find((l) => /^size:(S|M|L|XL)$/.test(l));
    if (pr) await set(it, 'Priority', pr.slice(9), number, have.Priority);
    if (sz) await set(it, 'Size', sz.slice(5), number, have.Size);
    if ((have.Estimate === undefined || have.Estimate === null) && sz) await set(it, 'Estimate', cfg.triage.size_hours[sz], number, null);
    if (open && (have.Estimate === undefined || have.Estimate === null) && !sz) missingEstimate++;
    const a = acts[number];
    if (open && a) {
      await set(it, P.fields.last_update, B.day(a.last), number, have[P.fields.last_update]);
      if (a.progress) await set(it, P.fields.progress, a.progress.text, number, have[P.fields.progress]);
    }
  };
  for (const it of boardItems) {
    const ct = it.content;
    if (!ct || !ct.repository || ct.repository.nameWithOwner !== full) continue;
    onBoard.add(ct.number);
    if (only && !only.has(ct.number)) continue;
    const have = Object.fromEntries(it.fieldValues.nodes.filter((v) => v && v.field).map((v) => [v.field.name, v.name ?? v.number ?? v.date ?? v.text]));
    await reconcile(it, ct.number, byNum.get(ct.number) || null, ct, have);
  }
  let adds = 0;
  for (const i of items) {
    if (onBoard.has(i.number) || (only && !only.has(i.number)) || adds >= P.max_adds_per_run) continue;
    adds++;
    corrections.push({ number: i.number, field: 'board', from: null, to: 'added' });
    const added = await act({ type: 'board-add', number: i.number }, () => gql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}', { p: proj.id, c: i.node_id }));
    if (added) await reconcile({ id: added.addProjectV2ItemById.item.id }, i.number, i, null, {});
  }
  const openOnBoard = items.filter((i) => onBoard.has(i.number)).length;
  return { writes, adds, missingEstimate, missingOption, boardItems: boardItems.length, projectId: proj.id, openTotal: items.length, openOnBoard, subIssuesField: subIssues };
}

// Event runs touch only the item(s) the event is about; the schedule and manual runs do everything.
function touched(context) {
  const p = context.payload;
  if (context.eventName === 'workflow_dispatch') return Number(p.inputs['item-number']) ? new Set([Number(p.inputs['item-number'])]) : null;
  if (context.eventName === 'schedule') return null;
  if (context.eventName === 'push') {
    const refs = new Set();
    for (const c of p.commits || []) for (const m of String(c.message || '').matchAll(/#(\d{1,6})\b/g)) refs.add(Number(m[1]));
    return new Set([...refs].slice(0, 10));
  }
  const n = (p.issue && p.issue.number) || (p.pull_request && p.pull_request.number);
  return n ? new Set([n]) : new Set();
}

// Weekly digest -> the private project board only (status update). The job summary always gets it.
async function postDigest({ getOctokit, core, cfg, body, atRisk, projectId, act }) {
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) fs.appendFileSync(sum, '\n' + body + '\n');
  const token = process.env.PROJECT_TOKEN;
  if (!token || !projectId) return { posted: 'job-summary', why: token ? 'no project id' : 'PROJECT_TOKEN empty/missing' };
  const status = atRisk ? cfg.project.status_update_status.risk : cfg.project.status_update_status.ok;
  const ok = await act({ type: 'board-status-update', status }, () => getOctokit(token).graphql('mutation($p:ID!,$b:String!,$s:ProjectV2StatusUpdateStatus){createProjectV2StatusUpdate(input:{projectId:$p,body:$b,status:$s}){statusUpdate{id}}}', { p: projectId, b: body.slice(0, 60000), s: status }));
  return ok || process.env.DRY ? { posted: 'board-status-update', status } : { posted: 'job-summary', why: 'status update mutation failed or unavailable' };
}

async function apply({ github, context, core, getOctokit }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const P = cfg.project;
  const state = JSON.parse(process.env.STATE || '{}');
  const dry = context.eventName === 'workflow_dispatch' && String(context.payload.inputs['dry-run']) === 'true';
  if (dry) process.env.DRY = '1';
  const actions = [], errors = [], corrections = [];
  const act = async (desc, fn) => {
    actions.push(desc);
    if (dry) return null;
    try { return await fn(); } catch (e) { errors.push(`${desc.type}: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`); return null; }
  };
  let items = await openItems(github, repo);
  let only = touched(context);

  // 0. Issues closed by PRs merged into dev (GitHub only auto-closes for the default branch).
  let delivered = [];
  try { delivered = await DELIVERED.run({ github, repo, act }); } catch (e) { errors.push(`delivered: ${e.message}`); }
  if (delivered.length) only = null; // sweep everything when some were just closed

  // 1. Open issues with no status label are untriaged: label them, so labels and board agree.
  const scope = (i) => !only || only.has(i.number);
  const unlabeled = items.filter((i) => !i.pr && scope(i) && !i.labels.some((l) => l.startsWith('status:'))).slice(0, 20);
  for (const i of unlabeled) {
    await act({ type: 'label', name: cfg.labels.triage, target: { kind: 'issue', number: i.number } }, () => github.rest.issues.addLabels({ ...repo, issue_number: i.number, labels: [cfg.labels.triage] }));
    i.labels.push(cfg.labels.triage);
    corrections.push({ number: i.number, field: 'label', from: null, to: cfg.labels.triage });
  }

  // 2. Activity (Last update, Progress, stale check) for the items in scope.
  const numbers = items.filter(scope).map((i) => i.number);
  const acts = numbers.length ? await activity(github, repo, numbers, cfg) : {};

  // 3. Board reconcile.
  let board = {};
  try { board = await boardSync({ getOctokit, core, cfg, items, repo, act, only, acts, corrections }); } catch (e) { errors.push(`board: ${e.message}`); }

  // 4. Stale in-progress work: label + ONE nudge comment, never a close. Cleared when work resumes.
  const stale = [], resumed = [];
  for (const i of items.filter((x) => scope(x) && x.labels.includes('status:in-progress'))) {
    const a = acts[i.number];
    if (!a) continue;
    const idle = B.hoursSince(a.last) > P.stale_hours;
    const labeled = i.labels.includes(P.stale_label);
    if (idle && !labeled) stale.push(i.number);
    else if (!idle && labeled) resumed.push(i.number);
  }
  for (const n of stale.slice(0, 20)) {
    await act({ type: 'label', name: P.stale_label, target: { kind: 'issue', number: n } }, () => github.rest.issues.addLabels({ ...repo, issue_number: n, labels: [P.stale_label] }));
    // ONE nudge sticky per item, edited in place; none on the owner's own items (the label is the signal).
    const item = items.find((x) => x.number === n);
    if (item && String(item.author || '').toLowerCase() !== String(repo.owner).toLowerCase()) {
      await L.upsertSticky({ io: L.restSticky(github, repo, n), purpose: 'stale-nudge', body: L.render(L.template('stale-check'), { hours: P.stale_hours }), act })
        .catch((e) => errors.push(`stale-nudge: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`));
    }
  }
  for (const n of resumed.slice(0, 20)) await act({ type: 'unlabel', name: P.stale_label, target: { kind: 'issue', number: n } }, () => github.rest.issues.removeLabel({ ...repo, issue_number: n, name: P.stale_label }));

  // 5. Security alerts -> one issue each (scheduled and manual runs only; event runs stay light).
  let security = null;
  if (context.eventName === 'schedule' || context.eventName === 'workflow_dispatch') {
    try { security = await SEC.sync({ github, wide: process.env.PROJECT_TOKEN ? getOctokit(process.env.PROJECT_TOKEN) : null, repo, act, errors }); } catch (e) { errors.push(`security: ${e.message}`); }
  }

  // 6. Missing data flags (summary and weekly digest, not posted on items).
  const noMilestone = items.filter((i) => !i.pr && !i.milestone).map((i) => i.number);
  const noSize = items.filter((i) => !i.pr && !i.labels.some((l) => l.startsWith('size:'))).map((i) => i.number);

  // 7. Job summary: every correction made to the board and labels.
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) {
    const rows = corrections.slice(0, 150).map((c) => `| #${c.number} | ${c.field} | ${c.from ?? ''} | ${c.to} |`);
    fs.appendFileSync(sum, `\n### Board reconcile${dry ? ' (dry run: nothing written)' : ''}\n\nScope: ${only ? [...only].map((n) => '#' + n).join(', ') || 'no items' : 'all open items'}. Open on board: ${board.openOnBoard ?? 'n/a'}/${board.openTotal ?? items.length}. Corrections: ${corrections.length}. Stale nudges: ${stale.length}.${board.subIssuesField === false ? ' The board has no "Sub-issues progress" field: add it to the views in the board settings.' : ''}${board.missingOption ? ` ${board.missingOption} Status value(s) have no matching board option.` : ''}\n\n${rows.length ? '| item | field | was | now |\n|---|---|---|---|\n' + rows.join('\n') : 'Nothing to correct.'}\n`);
  }

  // 8. Weekly digest: the private board only (project status update); never a public issue or discussion.
  let model = { provider: 'none', reason: state.model_skip || 'not needed', data: null };
  let digest = null;
  if (state.mode === 'weekly') {
    if (process.env.MODEL_PROVIDER) model = L.modelResult(process.env, 'digest');
    const list = (arr, f) => (arr.length ? arr.map(f).join('\n') : '- (none)');
    const ln = (n) => `#${n}`;
    const inProg = items.filter((i) => i.labels.includes('status:in-progress'));
    const risk = items.filter((i) => i.labels.includes('status:blocked') || i.labels.includes(P.stale_label) || (prio(i.labels) <= 1 && !i.labels.includes('status:in-progress')));
    const nums = (arr) => arr.slice(0, 15).map(ln).join(' ');
    const body = L.render(L.template('roadmap-digest'), {
      marker: P.digest_marker, date: new Date().toISOString().slice(0, 10),
      done_count: state.closed.length, done: list(state.closed, (c) => `- ${ln(c.number)} ${c.pr ? '(PR) ' : ''}`),
      progress_count: inProg.length, progress: list(inProg, (i) => `- ${ln(i.number)}${acts[i.number] && acts[i.number].progress ? ' ' + acts[i.number].progress.text : ''}`),
      risk_count: risk.length, risk: list(risk.slice(0, 15), (i) => `- ${ln(i.number)} (${i.labels.filter((l) => /^(status:blocked|status:stale-check|priority:P[01])$/.test(l)).join(', ')})`),
      next_n: P.digest_next, next: list(state.next, (n) => `- ${ln(n.number)} P${prio(n.labels) === 4 ? '?' : prio(n.labels)}${n.blockedBy.length ? ', blocked by ' + n.blockedBy.map(ln).join(' ') : ''}`) +
        (state.moves.length ? `\n\n**Milestone suggestions** (not applied): ${state.moves.map((m) => `${ln(m.number)} → ${m.to}`).join(', ')}` : ''),
      missing: `${noMilestone.length} open issues without a milestone (${nums(noMilestone) || 'none'}), ${noSize.length} without a size label (${nums(noSize) || 'none'})${board.missingEstimate ? `, ${board.missingEstimate} board items without an estimate` : ''}.`,
      summary: model.data && model.data.summary ? `**Overview** (automated, ${model.provider}): ${L.sanitize(model.data.summary, cfg, 800)}` : '',
    });
    digest = await postDigest({ getOctokit, core, cfg, body, atRisk: risk.length > 0, projectId: board.projectId, act });
  }

  L.record(LOG, {
    workflow: 'roadmap', event: `${context.eventName}.${state.mode}`, item: only ? [...only].map((n) => '#' + n).join(',') || 'none' : 'all', verdict: state.mode,
    board, corrections: corrections.length, digest, security, delivered, stale, resumed, no_milestone: noMilestone.length, no_size: noSize.length,
    provider: model.provider, fallback_reason: model.reason, latency_ms: process.env.MODEL_LATENCY_MS || null, tokens: process.env.MODEL_TOKENS || null,
    actions, errors, dry_run: dry,
  });
  if (errors.length) core.warning(`fail-open: ${errors.join('; ')}`);
}

// Weekly mistake report over the last 7 days of logs (downloaded by the workflow into one file).
// A "mistake" is an automated action a person reverted: a label a non-bot removed, a hidden comment
// that is no longer hidden, a lock that was lifted, a milestone or board field changed away from
// the value set (approximate: the current value differs).
async function mistakes({ github, context, core, getOctokit }) {
  const repo = context.repo;
  const file = process.env.LOGS;
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const since = Date.now() - 7 * DAY;
  const recent = rows.filter((r) => new Date(r.ts).getTime() >= since);
  const per = {}, providers = {}, fallbacks = {};
  const bump = (o, k, f, n = 1) => { o[k] = o[k] || {}; o[k][f] = (o[k][f] || 0) + n; };
  const eventsCache = {};
  const events = async (n) => (eventsCache[n] = eventsCache[n] || await github.paginate(github.rest.issues.listEvents, { ...repo, issue_number: n, per_page: 100 }).catch(() => []));
  const gqlBoard = process.env.PROJECT_TOKEN ? getOctokit(process.env.PROJECT_TOKEN).graphql : null;
  let checked = 0;
  for (const r of recent) {
    const wf = r.workflow || 'unknown';
    bump(per, wf, 'runs');
    if (r.provider) bump(providers, wf, r.provider);
    if (r.fallback_reason && r.provider !== 'none') bump(fallbacks, wf, r.fallback_reason);
    if (r.provider === 'none' && r.fallback_reason && /fail|limit|validation|missing/.test(r.fallback_reason)) bump(fallbacks, wf, r.fallback_reason);
    if (r.dry_run) continue;
    for (const a of r.actions || []) {
      if (!['label', 'minimize', 'lock', 'milestone', 'field'].includes(a.type) || checked > 400) continue;
      bump(per, wf, 'actions');
      checked++;
      let reverted = false;
      try {
        if (a.type === 'label' && a.target && a.target.kind !== 'discussion') {
          reverted = (await events(a.target.number)).some((e) => e.event === 'unlabeled' && e.label && e.label.name === a.name && e.actor && e.actor.type !== 'Bot' && e.created_at >= r.ts);
        } else if (a.type === 'minimize') {
          const n = await github.graphql('query($i:ID!){node(id:$i){... on Minimizable{isMinimized}}}', { i: a.node });
          reverted = n.node && n.node.isMinimized === false;
        } else if (a.type === 'lock' && a.target.kind !== 'discussion') {
          reverted = (await events(a.target.number)).some((e) => e.event === 'unlocked' && e.created_at >= r.ts);
        } else if (a.type === 'milestone') {
          const i = (await github.rest.issues.get({ ...repo, issue_number: a.target.number })).data;
          reverted = !i.milestone || i.milestone.title !== a.name;
        } else if (a.type === 'field' && gqlBoard) {
          const n = await gqlBoard('query($i:ID!){node(id:$i){... on ProjectV2Item{fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}', { i: a.item });
          const v = n.node && n.node.fieldValues.nodes.find((x) => x && x.field && x.field.name === a.field);
          reverted = !v || String(v.name ?? v.number) !== String(a.value);
        }
      } catch { /* item gone or not readable: not counted */ }
      if (reverted) bump(per, wf, 'reverted');
    }
  }
  const sum = process.env.GITHUB_STEP_SUMMARY;
  const lines = ['### Weekly automation report (last 7 days)', '', '| workflow | runs | checked actions | reverted by a person | mistake rate |', '|---|---|---|---|---|'];
  for (const [wf, c] of Object.entries(per)) lines.push(`| ${wf} | ${c.runs || 0} | ${c.actions || 0} | ${c.reverted || 0} | ${c.actions ? ((100 * (c.reverted || 0)) / c.actions).toFixed(1) + '%' : 'n/a'} |`);
  lines.push('', '| workflow | provider usage | fallback / skip reasons |', '|---|---|---|');
  for (const wf of Object.keys(per)) lines.push(`| ${wf} | ${JSON.stringify(providers[wf] || {})} | ${JSON.stringify(fallbacks[wf] || {}).replace(/\|/g, '/')} |`);
  if (sum) fs.appendFileSync(sum, lines.join('\n') + '\n');
  core.info(lines.join('\n'));
  L.record(LOG, { workflow: 'roadmap', event: 'weekly-report', item: 'all', verdict: 'report', per, providers, fallbacks, provider: 'none', actions: [] });
}

module.exports = { plan, apply, mistakes, rank, suggestMilestone, touched };
