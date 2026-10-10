'use strict';
// community.yml, release published. Two jobs, both rules-first:
//   1. Announcements: post the release notes to the Announcements category (template, no model).
//   2. Docs review: ONE model call (docs-inspector, read-only tools, capped inputs) opens or updates a
//      single "Docs review: vX.Y.Z" issue listing documentation that looks missing or stale. Without a
//      model result the rules still open the issue when user-facing files changed with no docs change.
// Never closes or deletes anything.

const L = require('./lib.js');

const matches = (pats, name) => pats.some((x) => new RegExp(x, 'i').test(name));

async function changedFiles(github, repo, tag, cfg) {
  const rels = (await github.rest.repos.listReleases({ ...repo, per_page: 10 })).data;
  const prev = rels.find((r) => r.tag_name !== tag && !r.draft && !r.prerelease);
  if (!prev) return { prev: null, files: [] };
  const cmp = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${prev.tag_name}...${tag}`, per_page: 100 });
  return { prev: prev.tag_name, files: (cmp.data.files || []).map((f) => f.filename) };
}

async function gate({ github, context, cfg }) {
  const rel = context.payload.release;
  const P = cfg.participation;
  const state = {
    item: { kind: 'release', tag: rel.tag_name, name: String(rel.name || rel.tag_name).slice(0, 200), url: rel.html_url, notes: String(rel.body || '').slice(0, P.release_notes_max_chars) },
    event: 'release.published', skip: null, privacy: [],
  };
  if (rel.prerelease || rel.draft) { state.skip = 'prerelease'; return { state, call: null }; }
  state.privacy = L.privacyScan(String(rel.body || ''), cfg, process.env.PRIVATE_DENYLIST).slice(0, cfg.privacy.max_hits_reported);
  let files = [];
  try {
    const r = await changedFiles(github, context.repo, rel.tag_name, cfg);
    files = r.files.slice(0, P.docs_inspector.max_files);
    state.prev = r.prev;
  } catch { state.files_error = true; }
  const user = files.filter((f) => matches(cfg.pr.user_facing_paths, f));
  const docs = files.filter((f) => matches(cfg.pr.docs_drift_paths, f));
  state.drift = { user: user.slice(0, 20), user_count: user.length, docs_count: docs.length, rule: user.length > 0 && docs.length === 0 };
  if (state.privacy.length || !files.length) return { state, call: null };
  const list = files.map((f) => `${matches(cfg.pr.user_facing_paths, f) ? 'U' : '-'}${matches(cfg.pr.docs_drift_paths, f) ? 'D' : '-'} ${f}`).join('\n');
  const call = {
    purpose: 'docs-inspector', tools: 'read', max_turns: 8,
    untrusted: `RELEASE ${rel.tag_name} NOTES:\n${String(rel.body || '').slice(0, P.docs_inspector.max_notes_chars)}\n\nFILES CHANGED SINCE ${state.prev} (U = user-facing, D = documentation):\n${list}`,
    context: '',
  };
  return { state, call };
}

async function announce({ github, repo, cfg, state, act }) {
  const it = state.item;
  if (state.privacy.length) return { announced: false, why: 'private data in the notes' };
  const q = `query($o:String!,$r:String!){repository(owner:$o,name:$r){id discussionCategories(first:25){nodes{id slug}}}}`;
  const repoInfo = (await github.graphql(q, { o: repo.owner, r: repo.repo })).repository;
  const cat = repoInfo.discussionCategories.nodes.find((c) => c.slug === cfg.participation.announce_category);
  if (!cat) return { announced: false, why: 'no Announcements category' };
  const title = `${repo.repo} ${it.tag}`;
  const existing = (await github.graphql(`query($o:String!,$r:String!,$c:ID!){repository(owner:$o,name:$r){discussions(first:20,categoryId:$c,orderBy:{field:CREATED_AT,direction:DESC}){nodes{title}}}}`, { o: repo.owner, r: repo.repo, c: cat.id })).repository.discussions.nodes;
  if (existing.some((d) => d.title === title)) return { announced: false, why: 'already announced' };
  const body = L.render(L.template('release-announcement'), { name: it.name, url: it.url, notes: L.sanitize(L.stripHtmlComments(it.notes), cfg, cfg.participation.release_notes_max_chars) || '(no release notes)' });
  await act({ type: 'announce', tag: it.tag }, () => github.graphql('mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{number}}}', { r: repoInfo.id, c: cat.id, t: title, b: body }));
  return { announced: true };
}

async function docsReview({ github, repo, cfg, state, model, act }) {
  const it = state.item;
  const items = model && model.data && Array.isArray(model.data.items) ? model.data.items : [];
  if (!items.length && !state.drift.rule) return { issue: null, why: model && model.data ? 'model found no gaps' : 'no gaps by the rules and no model result' };
  const title = `Docs review: ${it.tag}`;
  const lines = items.map((x) => `- [ ] **${L.sanitize(x.doc, cfg, 200)}**: ${L.sanitize(x.fix, cfg, 300)}`);
  if (state.drift.rule) lines.unshift(`- [ ] ${state.drift.user_count} user-facing file(s) changed since ${state.prev} with no CHANGELOG, docs/, README, skill or Codex-docs change (rules), e.g. ${state.drift.user.slice(0, 5).map((f) => '`' + f + '`').join(', ')}`);
  const body = [
    `<!-- docs-review:${it.tag} -->`,
    L.botMarker('docs-review'),
    `Documentation review for release ${it.url ? `[${it.tag}](${it.url})` : it.tag} (automated).`,
    '', lines.join('\n') || '- (none)', '',
    model && model.data && model.data.summary ? `**Overview** (${model.provider}): ${L.sanitize(model.data.summary, cfg, 600)}` : `<sub>No model review (${(model && model.reason) || 'not run'}); rules only.</sub>`,
  ].join('\n');
  const found = await github.rest.search.issuesAndPullRequests({ q: `repo:${repo.owner}/${repo.repo} is:issue in:title "${title}" author:app/github-actions` }).catch(() => null);
  const prev = found && found.data.items.find((i) => i.title === title);
  if (prev) {
    // Edited in place, and only when the content changed (the "Updated" footer is not content).
    const changed = prev.state === 'open' && L.stripFooter(prev.body) !== body.trim();
    if (changed) await act({ type: 'docs-review-update', number: prev.number }, () => github.rest.issues.update({ ...repo, issue_number: prev.number, body: L.withUpdatedFooter(body) }));
    return { issue: prev.number, updated: changed };
  }
  const ms = (await github.rest.issues.listMilestones({ ...repo, state: 'open', per_page: 100 }).catch(() => ({ data: [] }))).data.find((m) => m.title === cfg.triage.default_milestone);
  const created = await act({ type: 'docs-review-create', title }, () => github.rest.issues.create({ ...repo, title, body, labels: ['type:docs', cfg.participation.docs_inspector.issue_label, 'priority:P2', 'size:S', cfg.labels.triage], ...(ms ? { milestone: ms.number } : {}) }));
  return { issue: created ? created.data.number : null };
}

async function apply({ github, context, core, cfg, state, model, dry }) {
  const repo = context.repo;
  const actions = [], errors = [];
  const act = async (desc, fn) => {
    actions.push(desc);
    if (dry) return null;
    try { return await fn(); } catch (e) { errors.push(`${desc.type}: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`); return null; }
  };
  let ann = { announced: false, why: state.skip || 'n/a' };
  let docs = { issue: null, why: state.skip || 'n/a' };
  if (!state.skip) {
    try { ann = await announce({ github, repo, cfg, state, act }); } catch (e) { errors.push(`announce: ${e.message}`); }
    try { docs = await docsReview({ github, repo, cfg, state, model, act }); } catch (e) { errors.push(`docs-review: ${e.message}`); }
  }
  const row = L.record('community-log', {
    workflow: 'community', event: state.event, item: `release#${state.item.tag}`, verdict: state.skip ? 'skipped' : 'ok',
    privacy: state.privacy.map((h) => h.rule), purpose: state.purpose || null, provider: model.provider, fallback_reason: model.reason,
    latency_ms: process.env.MODEL_LATENCY_MS || null, turns: process.env.MODEL_TURNS || null, tokens: process.env.MODEL_TOKENS || null,
    announce: ann, docs_review: docs, actions, errors, dry_run: dry, skip: state.skip,
  });
  if (errors.length) core.warning(`fail-open: ${errors.join('; ')}`);
  return row;
}

module.exports = { gate, apply, announce, docsReview };
