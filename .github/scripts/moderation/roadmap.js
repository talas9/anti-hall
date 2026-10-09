'use strict';
// roadmap.yml: keeps the "anti-hall roadmap" board and labels consistent, flags stale work,
// posts the weekly digest, and reports the weekly mistake rate of all the automation.
// Board writes need PROJECT_TOKEN (or ROADMAP_PROJECT_TOKEN); without it they are skipped with a
// notice and the label-based parts still run. Never closes, deletes or archives anything.

const fs = require('node:fs');
const L = require('./lib.js');
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
      core.setOutput('claude_model', cfg.model.claude_models.digest);
      core.setOutput('chain', chain.join(','));
    } else state.model_skip = chain.length ? 'daily cap reached' : 'AI_PROVIDER=none';
  }
  core.setOutput('want_model', want ? 'true' : 'false');
  core.setOutput('state', JSON.stringify(state));
  core.info(`mode=${mode} open=${items.length} closed7d=${closed.length} model=${want}`);
}

async function boardSync({ getOctokit, core, cfg, items, repo, act, item }) {
  const token = process.env.PROJECT_TOKEN;
  if (!token) { core.notice('Board sync skipped: PROJECT_TOKEN empty/missing (ROADMAP_PROJECT_TOKEN also accepted).'); return { skipped: 'PROJECT_TOKEN empty/missing' }; }
  const gql = getOctokit(token).graphql;
  const q = `query($l:String!,$n:Int!,$c:String){user(login:$l){projectV2(number:$n){id
    fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}
    items(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{id
      content{... on Issue{number state repository{nameWithOwner} labels(first:30){nodes{name}}} ... on PullRequest{number state merged repository{nameWithOwner} labels(first:30){nodes{name}}}}
      fieldValues(first:20){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}}}`;
  let proj = null, c = null;
  const boardItems = [];
  for (let page = 0; page < 10; page++) {
    const p = (await gql(q, { l: cfg.project.owner, n: cfg.project.number, c })).user.projectV2;
    proj = proj || p;
    boardItems.push(...p.items.nodes);
    if (!p.items.pageInfo.hasNextPage) break;
    c = p.items.pageInfo.endCursor;
  }
  const field = (name) => proj.fields.nodes.find((f) => f && f.name === name);
  let writes = 0;
  const set = async (it, name, value, number) => {
    const f = field(name);
    if (!f || value === undefined || value === null || writes >= cfg.project.max_field_writes_per_run) return;
    const v = f.options ? (() => { const o = f.options.find((o) => o.name === value); return o && { singleSelectOptionId: o.id }; })() : { number: Number(value) };
    if (!v) return;
    writes++;
    await act({ type: 'field', item: it.id, number, field: name, value }, () => gql('mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){projectV2Item{id}}}', { p: proj.id, i: it.id, f: f.id, v }));
  };
  const full = `${repo.owner}/${repo.repo}`;
  const onBoard = new Set();
  let missingEstimate = 0;
  for (const it of boardItems) {
    const ct = it.content;
    if (!ct || !ct.repository || ct.repository.nameWithOwner !== full) continue;
    onBoard.add(ct.number);
    if (item && ct.number !== item) continue;
    const have = Object.fromEntries(it.fieldValues.nodes.filter((v) => v && v.field).map((v) => [v.field.name, v.name ?? v.number]));
    const labels = ct.labels.nodes.map((l) => l.name);
    let status = null;
    if (ct.state === 'CLOSED' && !('merged' in ct)) status = cfg.project.done_status;
    else if (ct.state === 'MERGED' || ct.merged) status = cfg.project.done_status;
    else for (const [l, s] of Object.entries(cfg.project.status_from_label)) if (labels.includes(l)) { status = s; break; }
    const pr = labels.find((l) => /^priority:P[0-3]$/.test(l));
    const sz = labels.find((l) => /^size:(S|M|L|XL)$/.test(l));
    if (status && have.Status !== status) await set(it, 'Status', status, ct.number);
    if (pr && have.Priority !== pr.slice(9)) await set(it, 'Priority', pr.slice(9), ct.number);
    if (sz && have.Size !== sz.slice(5)) await set(it, 'Size', sz.slice(5), ct.number);
    if ((have.Estimate === undefined || have.Estimate === null) && sz) await set(it, 'Estimate', cfg.triage.size_hours[sz], ct.number);
    if ((have.Estimate === undefined || have.Estimate === null) && !sz && ct.state === 'OPEN') missingEstimate++;
  }
  let adds = 0;
  for (const i of items) {
    if (onBoard.has(i.number) || (item && i.number !== item) || adds >= cfg.project.max_adds_per_run) continue;
    adds++;
    await act({ type: 'board-add', number: i.number }, () => gql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}', { p: proj.id, c: i.node_id }));
  }
  return { writes, adds, missingEstimate, boardItems: boardItems.length };
}

async function apply({ github, context, core, getOctokit }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const state = JSON.parse(process.env.STATE || '{}');
  const dry = context.eventName === 'workflow_dispatch' && String(context.payload.inputs['dry-run']) === 'true';
  const actions = [], errors = [];
  const act = async (desc, fn) => {
    actions.push(desc);
    if (dry) return null;
    try { return await fn(); } catch (e) { errors.push(`${desc.type}: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`); return null; }
  };
  const items = await openItems(github, repo);
  const one = context.eventName === 'workflow_dispatch' && Number(context.payload.inputs['item-number']) || null;

  // 1. Board consistency.
  let board = {};
  try { board = await boardSync({ getOctokit, core, cfg, items, repo, act, item: one }); } catch (e) { errors.push(`board: ${e.message}`); }

  // 2. Stale in-progress work (labels only, so it runs without the board token).
  const staleMs = cfg.project.stale_days * DAY;
  const stale = items.filter((i) => i.labels.includes('status:in-progress') && !i.labels.includes(cfg.labels.stale_check) && Date.now() - new Date(i.updated) > staleMs && (!one || i.number === one)).slice(0, 20);
  for (const i of stale) {
    await act({ type: 'label', name: cfg.labels.stale_check, target: { kind: i.pr ? 'pr' : 'issue', number: i.number } }, () => github.rest.issues.addLabels({ ...repo, issue_number: i.number, labels: [cfg.labels.stale_check] }));
    await act({ type: 'comment', target: { number: i.number } }, () => github.rest.issues.createComment({ ...repo, issue_number: i.number, body: L.render(L.template('stale-check'), { marker: '<!-- stale-check -->', days: cfg.project.stale_days }) }));
  }

  // 3. Missing data flags (reported in the summary and the digest, not posted on items).
  const noMilestone = items.filter((i) => !i.pr && !i.milestone).map((i) => i.number);
  const noSize = items.filter((i) => !i.pr && !i.labels.some((l) => l.startsWith('size:'))).map((i) => i.number);

  // 4. Weekly digest.
  let model = { provider: 'none', reason: state.model_skip || 'not needed', data: null };
  if (state.mode === 'weekly') {
    if (process.env.MODEL_PROVIDER) model = L.modelResult(process.env, 'digest');
    const list = (arr, f) => (arr.length ? arr.map(f).join('\n') : '- (none)');
    const ln = (n) => `#${n}`;
    const inProg = items.filter((i) => i.labels.includes('status:in-progress'));
    const risk = items.filter((i) => i.labels.includes('status:blocked') || i.labels.includes(cfg.labels.stale_check) || (prio(i.labels) <= 1 && !i.labels.includes('status:in-progress')));
    const body = L.render(L.template('roadmap-digest'), {
      marker: cfg.project.digest_marker, date: new Date().toISOString().slice(0, 10),
      done_count: state.closed.length, done: list(state.closed, (c) => `- ${ln(c.number)} ${c.pr ? '(PR) ' : ''}`),
      progress_count: inProg.length, progress: list(inProg, (i) => `- ${ln(i.number)}`),
      risk_count: risk.length, risk: list(risk.slice(0, 15), (i) => `- ${ln(i.number)} (${i.labels.filter((l) => /^(status:blocked|status:stale-check|priority:P[01])$/.test(l)).join(', ')})`),
      next_n: cfg.project.digest_next, next: list(state.next, (n) => `- ${ln(n.number)} P${prio(n.labels) === 4 ? '?' : prio(n.labels)}${n.blockedBy.length ? ', blocked by ' + n.blockedBy.map(ln).join(' ') : ''}`) +
        (state.moves.length ? `\n\n**Milestone suggestions** (not applied): ${state.moves.map((m) => `${ln(m.number)} → ${m.to}`).join(', ')}` : ''),
      missing: `${noMilestone.length} open issues without a milestone, ${noSize.length} without a size label${board.missingEstimate ? `, ${board.missingEstimate} board items without an estimate` : ''}.`,
      summary: model.data && model.data.summary ? `**Overview** (automated, ${model.provider}): ${L.sanitize(model.data.summary, cfg, 800)}` : '',
    });
    const found = await github.rest.search.issuesAndPullRequests({ q: `repo:${repo.owner}/${repo.repo} is:issue in:title "${cfg.project.digest_title}" author:app/github-actions` }).catch(() => null);
    let issue = found && found.data.items.find((i) => i.title === cfg.project.digest_title);
    if (!issue && !dry) {
      issue = (await github.rest.issues.create({ ...repo, title: cfg.project.digest_title, body: L.render(L.template('roadmap-digest-issue'), { marker: cfg.project.digest_marker }) })).data;
      actions.push({ type: 'digest-issue-created', number: issue.number });
      await github.graphql('mutation($i:ID!){pinIssue(input:{issueId:$i}){clientMutationId}}', { i: issue.node_id }).catch((e) => errors.push(`pin: ${e.message}`));
    }
    if (issue) await act({ type: 'digest', number: issue.number }, () => github.rest.issues.createComment({ ...repo, issue_number: issue.number, body }));
  }

  L.record(LOG, {
    workflow: 'roadmap', event: `${context.eventName}.${state.mode}`, item: one ? `#${one}` : 'all', verdict: state.mode,
    board, stale: stale.map((i) => i.number), no_milestone: noMilestone.length, no_size: noSize.length,
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

module.exports = { plan, apply, mistakes, rank, suggestMilestone };
