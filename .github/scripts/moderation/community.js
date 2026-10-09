'use strict';
// community.yml: one pass per issue / comment / discussion event.
//   gate  - rules: privacy scrub, moderation verdict, triage proposal, similar issues; decides the
//           ONE model call for this event (research brief, Q&A answer, or moderation check).
//   apply - acts on the rules result plus the schema-validated model reply; records telemetry.
// Never closes, deletes, bans or blocks. Hides only with minimizeComment; locks only spam bodies.

const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

const MARK = { brief: '<!-- triage-brief -->', qa: '<!-- qa-answer -->', mod: '<!-- moderation -->', privacy: '<!-- privacy-scrub -->' };
const LOG = 'community-log';

async function discussionByNumber(github, repo, number) {
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){discussion(number:$n){
    id number title body url authorAssociation author{login __typename} category{slug}
    labels(first:30){nodes{name}}}}}`;
  const d = (await github.graphql(q, { o: repo.owner, r: repo.repo, n: number })).repository.discussion;
  return d && { ...d, user: d.author && { login: d.author.login, type: d.author.__typename === 'Bot' ? 'Bot' : 'User' } };
}

// Normalise the event (or a workflow_dispatch input) into one item.
async function loadItem({ github, context }) {
  const p = context.payload;
  const repo = context.repo;
  const ev = context.eventName;
  if (ev === 'workflow_dispatch') {
    const n = Number(p.inputs['item-number']);
    if (p.inputs['item-kind'] === 'discussion') {
      const d = await discussionByNumber(github, repo, n);
      return { kind: 'discussion', number: n, node_id: d.id, title: d.title, body: d.body, user: d.user, association: d.authorAssociation, category: d.category && d.category.slug, labels: d.labels.nodes.map((l) => l.name), opened: true, dispatch: true };
    }
    const i = (await github.rest.issues.get({ ...repo, issue_number: n })).data;
    if (i.pull_request) throw new Error(`#${n} is a pull request; pr-check.yml handles those`);
    return { kind: 'issue', number: n, node_id: i.node_id, title: i.title, body: i.body, user: i.user, association: i.author_association, labels: i.labels.map((l) => l.name), opened: true, dispatch: true, state: i.state };
  }
  if (ev === 'issues') {
    const i = p.issue;
    return { kind: 'issue', number: i.number, node_id: i.node_id, title: i.title, body: i.body, user: i.user, association: i.author_association, labels: (i.labels || []).map((l) => l.name), opened: p.action === 'opened', state: i.state };
  }
  if (ev === 'discussion') {
    const d = p.discussion;
    return { kind: 'discussion', number: d.number, node_id: d.node_id, title: d.title, body: d.body, user: d.user, association: d.author_association, category: d.category && d.category.slug, labels: (d.labels || []).map((l) => l.name), opened: p.action === 'created' };
  }
  const parent = ev === 'issue_comment' ? p.issue : p.discussion;
  if (ev === 'issue_comment' && parent.pull_request) return { skip: 'pull request comment (moderated, not triaged)', ...commentItem(p, parent, 'pr') };
  return commentItem(p, parent, ev === 'issue_comment' ? 'issue' : 'discussion');
}

function commentItem(p, parent, kind) {
  const c = p.comment;
  return {
    kind, number: parent.number, node_id: parent.node_id, title: parent.title, body: parent.body,
    parentUser: parent.user, labels: (parent.labels || []).map((l) => l.name), category: parent.category && parent.category.slug,
    state: parent.state,
    comment: { id: c.id, node_id: c.node_id, body: c.body, user: c.user, association: c.author_association, created: p.action === 'created' },
    user: c.user, association: c.author_association,
  };
}

async function existingComment(github, repo, item, marker) {
  if (item.kind === 'discussion') {
    const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){discussion(number:$n){comments(first:100){nodes{id body updatedAt author{login}}}}}}`;
    const nodes = (await github.graphql(q, { o: repo.owner, r: repo.repo, n: item.number })).repository.discussion.comments.nodes;
    const c = nodes.find((x) => x.author && x.author.login === 'github-actions' && x.body.includes(marker));
    return c ? { id: c.id, body: c.body, updated_at: c.updatedAt } : null;
  }
  const all = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: item.number, per_page: 100 });
  const c = all.find((x) => x.user && x.user.login === 'github-actions[bot]' && (x.body || '').includes(marker));
  return c ? { id: c.id, body: c.body, updated_at: c.updated_at } : null;
}

async function similarIssues(github, repo, item, cfg) {
  const words = [...new Set(String(item.title || '').toLowerCase().replace(/^\w+(\([^)]*\))?:\s*/, '').split(/[^a-z0-9-]+/).filter((w) => w.length > 3))].slice(0, 5);
  if (!words.length) return [];
  try {
    const r = await github.rest.search.issuesAndPullRequests({ q: `repo:${repo.owner}/${repo.repo} is:issue ${words.join(' ')}`, per_page: cfg.triage.research.similar_limit + 1 });
    return r.data.items.filter((i) => i.number !== item.number).slice(0, cfg.triage.research.similar_limit).map((i) => ({
      number: i.number, title: i.title, state: i.state,
      labels: i.labels.map((l) => l.name).filter((l) => /^(size|type|area|priority):/.test(l)),
      hours_open: i.closed_at ? Math.round((new Date(i.closed_at) - new Date(i.created_at)) / 36e5) : null,
      similarity: Number(L.similarity(item.title, i.title).toFixed(2)),
    }));
  } catch (e) {
    return [];
  }
}

function formComplete(body) {
  const fields = ['Priority', 'Estimate', 'Area'];
  return fields.every((f) => L.formField(body, f));
}

async function gate({ github, context, core }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const item = await loadItem({ github, context });
  const owner = context.payload.repository.owner.login;
  const dispatch = !!item.dispatch;
  const skip = L.skipReason(item.user, dispatch ? '' : owner, cfg);
  const isOwner = !dispatch && skip === 'owner';
  const text = item.comment ? item.comment.body : `${item.title || ''}\n${item.body || ''}`;
  const state = { item: { kind: item.kind, number: item.number, node_id: item.node_id, comment: item.comment ? { id: item.comment.id, node_id: item.comment.node_id } : null, author: L.safeLogin(item.user && item.user.login), category: item.category || null, labels: item.labels || [], opened: !!item.opened, title: item.title, body: String(item.body || '').slice(0, 4000) }, skip, event: `${context.eventName}.${context.payload.action || ''}` };

  if (skip === 'bot' || skip === 'no-author') return finish(core, state, null);

  state.privacy = L.privacyScan(text, cfg, process.env.PRIVATE_DENYLIST).slice(0, cfg.privacy.max_hits_reported);
  state.verdict = isOwner ? { verdict: 'ok', reason: 'owner' } : L.classify(text, { kind: item.comment ? 'comment' : 'body', association: item.association }, cfg);
  if (item.skip) return finish(core, state, null);

  const flagged = state.privacy.length || state.verdict.verdict !== 'ok' || item.labels.includes(cfg.labels.review);
  const chain = L.chain(process.env.AI_PROVIDER, cfg);
  let call = null;

  // New issues and research-category discussions: rules triage + (maybe) one research call.
  const newItem = item.opened && (item.kind === 'issue' || cfg.triage.research.categories.includes(item.category));
  let rerun = false;
  if (!newItem && item.comment && item.comment.created && item.kind === 'issue' && item.state === 'open' && item.parentUser && item.comment.user && item.comment.user.login === item.parentUser.login && !isOwner) {
    const prev = await existingComment(github, repo, item, MARK.brief);
    const age = prev ? (Date.now() - new Date(prev.updated_at)) / 36e5 : 0;
    rerun = !!prev && /\*\*Open questions/.test(prev.body) && age >= cfg.triage.research.rerun_min_hours;
    state.rerun = rerun;
  }
  if ((newItem || rerun) && !flagged) {
    const issue = rerun ? (await github.rest.issues.get({ ...repo, issue_number: item.number })).data : null;
    const body = rerun ? `${issue.body || ''}\n\nFOLLOW-UP FROM THE REPORTER:\n${item.comment.body}` : item.body;
    state.triage = item.kind === 'issue' ? L.triageRules({ title: item.title, body, labels: item.labels }, cfg) : null;
    state.similar = item.category === cfg.triage.qa_category ? [] : await similarIssues(github, repo, item, cfg);
    const dup = state.similar.find((s) => s.similarity >= cfg.moderation.duplicate_title_similarity);
    if (dup) state.duplicate = dup.number;
    const r = cfg.triage.research;
    const bodyLen = String(body || '').length;
    const tiny = bodyLen < r.min_body_chars;
    const complete = item.kind === 'issue' && formComplete(body) && bodyLen < r.complete_form_max_body_chars;
    if (!isOwner && !dup && !tiny && !complete) {
      const isQa = item.category === cfg.triage.qa_category;
      const purpose = isQa ? 'qa-answer' : 'brief';
      const isFeature = (state.triage && state.triage.type === 'type:feature') || item.category === 'ideas';
      const ctx = isQa ? '' : `RULES: ${JSON.stringify(state.triage || { type: 'type:feature' })}\nSIMILAR ISSUES (untrusted titles): ${JSON.stringify(state.similar)}`;
      call = { purpose, tools: isQa ? 'read' : (isFeature && r.web_search_types.includes('type:feature') ? 'read-web' : 'read'), max_turns: r.max_turns, untrusted: `TITLE: ${item.title}\n\n${body || ''}`, context: ctx };
    } else {
      state.no_research = isOwner ? 'owner item' : dup ? `likely duplicate of #${dup.number}` : tiny ? 'too short' : 'form complete and short';
    }
  }
  // Otherwise: a cheap moderation check on text the rules passed, from outside contributors only.
  if (!call && !flagged && !isOwner && cfg.moderation.untrusted_associations.concat(['CONTRIBUTOR']).includes(item.association || 'NONE')) {
    call = { purpose: 'moderate', tools: 'none', max_turns: 2, untrusted: text, context: '' };
  }

  if (call) state.purpose = call.purpose;
  if (call && chain.length) {
    const cap = Number(process.env.AI_DAILY_CAP || cfg.model.default_daily_cap);
    const b = await L.budget(github, context, 'community.yml', cap);
    state.budget = b;
    if (!b.ok) { state.model_skip = `daily cap reached (${b.used}/${cap})`; call = null; }
  } else if (call) {
    state.model_skip = 'AI_PROVIDER=none';
    call = null;
  }
  return finish(core, state, call, chain, cfg);
}

function finish(core, state, call, chain, cfg) {
  core.setOutput('state', JSON.stringify(state));
  core.setOutput('want_model', call ? 'true' : 'false');
  if (call) {
    const { schema } = L.prompt(call.purpose);
    state.purpose = call.purpose;
    core.setOutput('state', JSON.stringify(state));
    core.setOutput('purpose', call.purpose);
    core.setOutput('prompt', L.buildPrompt(call.purpose, call.untrusted, call.context, cfg));
    core.setOutput('schema', JSON.stringify(schema));
    core.setOutput('claude_model', L.modelFor(cfg, call.purpose).claude);
    core.setOutput('copilot_model', L.modelFor(cfg, call.purpose).copilot);
    core.setOutput('tools', call.tools);
    core.setOutput('max_turns', String(call.max_turns));
    core.setOutput('chain', chain.join(','));
  }
  core.info(`gate: skip=${state.skip || 'no'} verdict=${state.verdict && state.verdict.verdict} privacy=${(state.privacy || []).length} model=${call ? call.purpose : 'none'}`);
  return state;
}

// ---------- apply ----------

async function labelIds(github, repo, names) {
  const q = `query($o:String!,$r:String!){repository(owner:$o,name:$r){labels(first:100){nodes{id name}}}}`;
  const nodes = (await github.graphql(q, { o: repo.owner, r: repo.repo })).repository.labels.nodes;
  const ids = [];
  for (const n of names) {
    let l = nodes.find((x) => x.name === n);
    if (!l) {
      const created = await github.rest.issues.createLabel({ ...repo, name: n, color: 'ededed' }).catch(() => null);
      if (created) l = { id: created.data.node_id };
    }
    if (l) ids.push(l.id);
  }
  return ids;
}

function verifiedPaths(list, root, prefixes) {
  return (list || []).map((p) => String(p).trim().replace(/^\.?\//, '')).filter((p) => {
    if (!p || p.includes('..') || path.isAbsolute(p) || /[\s`<>|]/.test(p)) return false;
    if (prefixes && !prefixes.some((x) => p.startsWith(x) || (x === '*.md' && /^[A-Za-z0-9._-]+\.md$/.test(p)))) return false;
    return fs.existsSync(path.join(root, p));
  });
}

async function apply({ github, context, core, getOctokit }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const state = JSON.parse(process.env.STATE || '{}');
  const item = state.item || {};
  const dry = context.eventName === 'workflow_dispatch' && String(context.payload.inputs['dry-run']) === 'true';
  const model = state.purpose && process.env.MODEL_PROVIDER ? L.modelResult(process.env, state.purpose) : { provider: 'none', reason: state.model_skip || 'not needed', latency: null, data: null };
  state.privacy = state.privacy || [];
  if (state.skip === 'bot' || state.skip === 'no-author') {
    return L.record(LOG, { workflow: 'community', event: state.event, item: `${item.kind}#${item.number}`, verdict: 'skipped', skip: state.skip, provider: 'none', fallback_reason: 'skipped', actions: [] });
  }
  const actions = [];
  const errors = [];
  const root = process.env.GITHUB_WORKSPACE;
  const act = async (desc, fn) => {
    actions.push(desc);
    if (dry) return null;
    try { return await fn(); } catch (e) {
      errors.push(`${desc.type}: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`);
      return null;
    }
  };
  const target = { kind: item.kind, number: item.number };
  const addLabels = async (names) => {
    names = names.filter((n) => n && !item.labels.includes(n));
    if (!names.length) return;
    for (const name of names) actions.push({ type: 'label', name, target });
    if (dry) return;
    try {
      if (item.kind === 'discussion') {
        const ids = await labelIds(github, repo, names);
        await github.graphql('mutation($i:ID!,$l:[ID!]!){addLabelsToLabelable(input:{labelableId:$i,labelIds:$l}){clientMutationId}}', { i: item.node_id, l: ids });
      } else {
        await github.rest.issues.addLabels({ ...repo, issue_number: item.number, labels: names });
      }
    } catch (e) { errors.push(`label: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`); }
  };
  const postSticky = async (marker, body) => {
    const prev = await existingComment(github, repo, item, marker).catch(() => null);
    const full = marker + '\n' + body.replace(marker, '').trim() + '\n';
    if (item.kind === 'discussion') {
      return act({ type: prev ? 'comment-update' : 'comment', marker }, () => (prev
        ? github.graphql('mutation($c:ID!,$b:String!){updateDiscussionComment(input:{commentId:$c,body:$b}){clientMutationId}}', { c: prev.id, b: full })
        : github.graphql('mutation($d:ID!,$b:String!){addDiscussionComment(input:{discussionId:$d,body:$b}){clientMutationId}}', { d: item.node_id, b: full })));
    }
    return act({ type: prev ? 'comment-update' : 'comment', marker }, () => (prev
      ? github.rest.issues.updateComment({ ...repo, comment_id: prev.id, body: full })
      : github.rest.issues.createComment({ ...repo, issue_number: item.number, body: full })));
  };
  const once = async (marker, body) => {
    const prev = await existingComment(github, repo, item, marker).catch(() => null);
    if (!prev) await postSticky(marker, body);
  };
  const minimize = (classifier) => act({ type: 'minimize', node: item.comment.node_id, classifier }, () =>
    github.graphql('mutation($s:ID!,$c:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$s,classifier:$c}){clientMutationId}}', { s: item.comment.node_id, c: classifier }));
  const reviewLabel = async () => {
    if (item.kind !== 'discussion' && await L.humanRemovedLabel(github, repo, item.number, cfg.labels.review)) {
      actions.push({ type: 'respect-human', name: cfg.labels.review });
      return false;
    }
    await addLabels([cfg.labels.review]);
    return true;
  };

  let verdict = state.verdict ? state.verdict.verdict : 'skipped';

  // 1. Privacy: hide the comment (RESOLVED) or label the body and ask for an edit. Values never echoed.
  if ((state.privacy || []).length) {
    const rules = [...new Set(state.privacy.map((h) => h.rule))].join(', ');
    if (item.comment) await minimize('RESOLVED');
    else {
      await addLabels([cfg.labels.private]);
      await once(MARK.privacy, L.render(L.template('privacy'), { marker: '', author: item.author, rules }));
    }
  }

  // 2. Moderation (rules decide; the model can only escalate to human review).
  const mv = model.data && state.purpose === 'moderate' ? model.data.verdict : null;
  if (verdict === 'spam' || verdict === 'abusive') {
    if (item.comment) await minimize(cfg.moderation.hide_classifier[verdict]);
    else if (await reviewLabel() && verdict === 'spam') {
      await act({ type: 'lock', target }, () => (item.kind === 'discussion'
        ? github.graphql('mutation($i:ID!){lockLockable(input:{lockableId:$i,lockReason:SPAM}){clientMutationId}}', { i: item.node_id })
        : github.rest.issues.lock({ ...repo, issue_number: item.number, lock_reason: 'spam' })));
    }
  } else if (verdict === 'off-topic' || verdict === 'low-quality') {
    if (!item.comment) {
      if (await reviewLabel()) await once(MARK.mod, L.render(L.template(verdict === 'off-topic' ? 'off-topic' : 'needs-info'), { author: item.author, reason: state.verdict.reason }));
    } else if (verdict === 'off-topic') {
      await reviewLabel();
    }
  } else if (verdict === 'ok' && mv && ['spam', 'abusive', 'off-topic', 'low-quality'].includes(mv)) {
    verdict = `ok (model: ${mv})`;
    await reviewLabel();
  }

  // 3. Triage: rules labels, model enums on top for fields the form did not set; brief comment.
  const t = state.triage;
  const brief = model.data && state.purpose === 'brief' ? model.data : null;
  let milestone = null;
  if (t) {
    const pick = (k) => (t.preset[k] ? t[k] : (brief && brief[k]) || t[k]);
    const final = { type: pick('type'), area: pick('area'), priority: pick('priority'), size: pick('size') };
    final.estimate_hours = t.preset.estimate_hours ? t.estimate_hours : (brief && brief.estimate_hours) || cfg.triage.size_hours[final.size];
    const want = ['type', 'area', 'priority', 'size'].filter((k) => !t.preset[k]).map((k) => final[k]).filter((v) => v && v !== 'none');
    if (!item.labels.some((l) => l.startsWith('status:'))) want.push(cfg.labels.triage);
    await addLabels(want);
    // Milestone: model enum, else keyword rules; only when the issue has none.
    const text = `${item.title}\n${item.body || ''}`.toLowerCase();
    const ruleMs = Object.entries(cfg.triage.milestones).find(([, words]) => words.some((w) => text.includes(w)));
    milestone = (brief && brief.milestone !== 'none' && brief.milestone) || (ruleMs && ruleMs[0]) || cfg.triage.default_milestone;
    if (item.kind === 'issue' && !state.rerun) {
      const issue = (await github.rest.issues.get({ ...repo, issue_number: item.number })).data;
      if (!issue.milestone) {
        const ms = (await github.rest.issues.listMilestones({ ...repo, state: 'open', per_page: 100 })).data.find((m) => m.title === milestone);
        if (ms) await act({ type: 'milestone', name: milestone, target }, () => github.rest.issues.update({ ...repo, issue_number: item.number, milestone: ms.number }));
      }
    }
    state.final = final;
    // Board: add + fill empty fields (PROJECT_TOKEN or ROADMAP_PROJECT_TOKEN).
    if (item.kind === 'issue' && !state.rerun) await board({ getOctokit, core, cfg, item, final, act, actions });
  }
  const isNew = !!(t || state.rerun || (item.opened && item.kind === 'discussion' && cfg.triage.research.categories.includes(item.category)));
  if (isNew && !state.privacy.length && verdict === 'ok' && state.purpose !== 'moderate') {
    if (state.purpose === 'qa-answer' || item.category === cfg.triage.qa_category) {
      await qaAnswer({ cfg, model, item, root, postSticky, title: item.title });
    } else if (state.purpose === 'brief' || state.duplicate) {
      const f = state.final || { type: 'type:feature', area: (brief && brief.area) || 'none', priority: (brief && brief.priority) || 'priority:P3', size: (brief && brief.size) || 'size:M', estimate_hours: (brief && brief.estimate_hours) || null };
      if (item.kind === 'discussion' && brief) await addLabels(['type:feature', brief.area].filter((x) => x && x !== 'none'));
      const similar = state.similar || [];
      const known = new Set(similar.map((s) => s.number));
      const rel = brief && brief.related ? brief.related.filter((r) => known.has(r.number)) : [];
      if (state.duplicate && !rel.some((r) => r.number === state.duplicate)) rel.unshift({ number: state.duplicate, relation: 'duplicate' });
      const ln = (n) => `https://github.com/${repo.owner}/${repo.repo}/issues/${n}`;
      const bullets = (arr) => (arr && arr.length ? arr.map((x) => '- ' + L.sanitize(x, cfg, 200)).join('\n') : '- (none)');
      const files = brief ? verifiedPaths(brief.files, root) : [];
      const docs = brief ? verifiedPaths(brief.docs, root, ['docs/', '*.md']) : [];
      const body = L.render(L.template('triage-brief'), {
        marker: '', type: f.type, area: f.area, priority: f.priority, size: f.size,
        estimate: f.estimate_hours ? `${f.estimate_hours} h` : 'n/a', milestone: milestone || 'n/a',
        applied: t ? `Labels applied where the form left them empty.` : '',
        related: rel.length ? rel.map((r) => `[#${r.number}](${ln(r.number)}) (${r.relation})`).join(', ') : 'none found',
        files: files.length ? files.map((p) => '`' + p + '`').join(', ') : 'not researched',
        docs: docs.length ? docs.map((p) => `[${p}](https://github.com/${repo.owner}/${repo.repo}/blob/main/${p})`).join(', ') : 'none found',
        approach: bullets(brief && brief.approach), risks: bullets(brief && brief.risks), questions: bullets(brief && brief.questions),
        author: item.author,
        rationale: brief ? L.sanitize(brief.rationale, cfg, 500) : L.sanitize((t && t.rationale) || (state.duplicate ? `Title closely matches #${state.duplicate}.` : ''), cfg, 500),
        provider: model.provider === 'none' ? `rules only (${model.reason})` : model.provider,
      });
      await postSticky(MARK.brief, body);
    }
  }

  const row = L.record(LOG, {
    workflow: 'community', event: state.event, item: `${item.kind}#${item.number}${item.comment ? '/c' : ''}`,
    verdict, privacy: (state.privacy || []).map((h) => h.rule), purpose: state.purpose || null,
    provider: model.provider, fallback_reason: model.reason, latency_ms: process.env.MODEL_LATENCY_MS || null,
    turns: process.env.MODEL_TURNS || null, tokens: process.env.MODEL_TOKENS || null,
    final: state.final || null, milestone, actions, errors, dry_run: dry, skip: state.skip || null, no_research: state.no_research || null,
  });
  if (errors.length) core.warning(`fail-open: ${errors.join('; ')}`);
  return row;
}

async function qaAnswer({ cfg, model, item, root, postSticky }) {
  const c = cfg.triage;
  const text = `${item.title}\n${item.body || ''}`.toLowerCase();
  const ruleLinks = Object.entries(c.qa_links).filter(([k]) => text.includes(k)).map(([, u]) => u).slice(0, c.qa_max_links);
  const data = model.data && model.data.answer ? model.data : null;
  const docLinks = data ? verifiedPaths(data.docs, root, ['docs/', '*.md']).map((p) => `https://github.com/talas9/anti-hall/blob/main/${p}`) : [];
  const links = [...new Set(docLinks.concat(ruleLinks))].slice(0, c.qa_max_links + 2);
  if (!data && !links.length) return;
  const answer = data ? L.sanitize(data.answer + (data.confident ? '' : '\n\n(Low confidence: please check the linked docs.)'), cfg) : 'These pages may help while a maintainer looks at your question:';
  await postSticky(MARK.qa, L.render(L.template('qa-answer'), { marker: '', answer, links: links.map((u) => '- ' + u).join('\n') }));
}

async function board({ getOctokit, core, cfg, item, final, act, actions }) {
  const token = process.env.PROJECT_TOKEN;
  if (!token) { core.notice('Roadmap board skipped: PROJECT_TOKEN empty/missing (ROADMAP_PROJECT_TOKEN also accepted).'); actions.push({ type: 'board-skip', reason: 'PROJECT_TOKEN empty/missing' }); return; }
  const gql = getOctokit(token).graphql;
  try {
    const q = `query($l:String!,$n:Int!){user(login:$l){projectV2(number:$n){id fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}}}}`;
    const proj = (await gql(q, { l: cfg.project.owner, n: cfg.project.number })).user.projectV2;
    const added = await act({ type: 'board-add', target: { kind: 'issue', number: item.number } }, () => gql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id fieldValues(first:30){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}', { p: proj.id, c: item.node_id }));
    if (!added) return;
    const it = added.addProjectV2ItemById.item;
    const have = Object.fromEntries(it.fieldValues.nodes.filter((v) => v && v.field).map((v) => [v.field.name, v.name ?? v.number]));
    const want = { Status: 'Triage', Priority: final.priority.slice(9), Size: final.size.slice(5), Estimate: final.estimate_hours };
    for (const [name, value] of Object.entries(want)) {
      if (have[name] !== undefined && have[name] !== null) continue;
      const f = proj.fields.nodes.find((x) => x && x.name === name);
      if (!f || value === undefined || value === null) continue;
      const v = f.options ? (() => { const o = f.options.find((o) => o.name === value); return o && { singleSelectOptionId: o.id }; })() : { number: Number(value) };
      if (!v) continue;
      await act({ type: 'field', item: it.id, field: name, value }, () => gql('mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){projectV2Item{id}}}', { p: proj.id, i: it.id, f: f.id, v }));
    }
  } catch (e) {
    core.warning(`board: ${e.message}`);
  }
}

module.exports = { gate, apply, loadItem, verifiedPaths };
