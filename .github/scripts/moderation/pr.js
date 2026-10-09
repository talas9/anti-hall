'use strict';
// pr-check.yml (pull_request_target). Reads the PR title, body and diff through the API only; PR
// code is never checked out or run. Rules: size, type, conventional title, linked issue, risk
// flags, missing tests/docs, privacy hits, moderation of the description. One optional model call
// (PR summary). Labels plus ONE sticky comment. Never approves, requests changes, merges or closes.

const L = require('./lib.js');
const LOG = 'pr-check-log';

async function load({ github, context }) {
  const repo = context.repo;
  const n = context.eventName === 'workflow_dispatch' ? Number(context.payload.inputs['pr-number']) : context.payload.pull_request.number;
  const pr = context.eventName === 'workflow_dispatch' ? (await github.rest.pulls.get({ ...repo, pull_number: n })).data : context.payload.pull_request;
  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: n, per_page: 100 });
  return { pr, files: files.slice(0, 3000) };
}

// Added lines per file with their new-file line numbers (from the unified-diff patch).
function addedLines(patch) {
  const out = [];
  let ln = 0;
  for (const row of String(patch || '').split('\n')) {
    const h = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { ln = Number(h[1]); continue; }
    if (row.startsWith('+')) { out.push({ line: ln, text: row.slice(1) }); ln++; } else if (!row.startsWith('-')) ln++;
  }
  return out;
}

function privacyOfFiles(files, cfg, deny) {
  const hits = [];
  for (const f of files) {
    if (cfg.privacy.skip_paths.some((p) => new RegExp(p).test(f.filename))) continue;
    for (const a of addedLines(f.patch)) {
      for (const h of L.privacyScan(a.text, cfg, deny)) hits.push({ rule: h.rule, file: f.filename, line: a.line });
    }
  }
  return hits;
}

async function gate({ github, context, core }) {
  const cfg = L.loadConfig();
  const { pr, files } = await load({ github, context });
  const owner = context.payload.repository.owner.login;
  const dependabot = pr.user.login === 'dependabot[bot]';
  const skip = dependabot ? 'dependabot' : L.skipReason(pr.user, owner, cfg);
  const rules = L.prRules({ title: pr.title, body: pr.body, files, headRef: pr.head.ref, sameRepo: pr.head.repo && pr.head.repo.full_name === pr.base.repo.full_name, baseRef: pr.base.ref }, cfg);
  const deny = process.env.PRIVATE_DENYLIST;
  const privacy = L.privacyScan(`${pr.title}\n${pr.body || ''}`, cfg, deny).map((h) => ({ rule: h.rule, file: '(description)', line: h.line }))
    .concat(privacyOfFiles(files, cfg, deny)).slice(0, cfg.privacy.max_hits_reported);
  const verdict = skip ? { verdict: 'ok', reason: skip } : L.classify(`${pr.title}\n${pr.body || ''}`, { kind: 'body', association: pr.author_association }, cfg);
  const state = {
    event: `${context.eventName}.${context.payload.action || ''}`,
    pr: { number: pr.number, title: pr.title, author: L.safeLogin(pr.user.login), labels: (pr.labels || []).map((l) => l.name), dependabot, draft: !!pr.draft },
    rules, privacy, verdict, skip, bump: dependabot ? L.bumpRisk(pr.title) : null,
  };
  let call = null;
  if (!skip && !pr.draft && verdict.verdict === 'ok' && !privacy.length) {
    let diff = '';
    for (const f of files) {
      if (diff.length >= cfg.pr.diff_max_chars) break;
      diff += `\n--- ${f.filename} (+${f.additions} -${f.deletions})\n${String(f.patch || '(binary or too large)').slice(0, 4000)}`;
    }
    call = { purpose: 'pr-summary', untrusted: `TITLE: ${pr.title}\n\nDESCRIPTION:\n${pr.body || ''}\n\nDIFF:${diff.slice(0, cfg.pr.diff_max_chars)}`, context: `RULES: ${JSON.stringify(rules)}` };
    state.purpose = call.purpose;
    const chain = L.chain(process.env.AI_PROVIDER, cfg);
    if (!chain.length) { state.model_skip = 'AI_PROVIDER=none'; call = null; }
    else {
      const cap = Number(process.env.AI_DAILY_CAP || cfg.model.default_daily_cap);
      const b = await L.budget(github, context, 'pr-check.yml', cap);
      if (!b.ok) { state.model_skip = `daily cap reached (${b.used}/${cap})`; call = null; }
    }
    if (call) {
      core.setOutput('prompt', L.buildPrompt(call.purpose, call.untrusted, call.context, cfg));
      core.setOutput('schema', JSON.stringify(L.prompt(call.purpose).schema));
      core.setOutput('claude_model', cfg.model.claude_models[call.purpose]);
      core.setOutput('chain', chain.join(','));
    }
  } else {
    state.model_skip = skip ? `${skip} PR` : pr.draft ? 'draft' : 'flagged by rules';
  }
  core.setOutput('want_model', call ? 'true' : 'false');
  core.setOutput('state', JSON.stringify(state));
  core.info(`gate: size=${rules.size} risks=${Object.keys(rules.risks).join(',') || 'none'} privacy=${privacy.length} model=${call ? 'yes' : state.model_skip}`);
}

async function apply({ github, context, core }) {
  const cfg = L.loadConfig();
  const repo = context.repo;
  const state = JSON.parse(process.env.STATE);
  const { pr, rules, privacy, verdict } = state;
  const dry = context.eventName === 'workflow_dispatch' && String(context.payload.inputs['dry-run']) === 'true';
  const model = state.purpose && process.env.MODEL_PROVIDER ? L.modelResult(process.env, state.purpose) : { provider: 'none', reason: state.model_skip || 'not needed', data: null };
  const actions = [];
  const errors = [];
  const target = { kind: 'pr', number: pr.number };
  const act = async (desc, fn) => {
    actions.push(desc);
    if (dry) return null;
    try { return await fn(); } catch (e) { errors.push(`${desc.type}: ${L.isRateLimit(e) ? 'rate-limited' : (e.status || e.message)}`); return null; }
  };

  // Labels: add what the rules say; replace a stale size:*; drop needs-issue once an issue is linked.
  const want = [rules.size];
  if (rules.type) want.push(rules.type);
  want.push(...rules.risk_labels);
  if (privacy.length) want.push(cfg.labels.private);
  const needsIssue = !rules.linked_issue && !rules.needs_issue_exempt && !pr.dependabot;
  if (needsIssue) want.push(cfg.labels.needs_issue);
  if (verdict.verdict === 'spam' || verdict.verdict === 'abusive') {
    if (!(await L.humanRemovedLabel(github, repo, pr.number, cfg.labels.review))) want.push(cfg.labels.review);
  }
  const add = [...new Set(want)].filter((l) => !pr.labels.includes(l));
  const remove = pr.labels.filter((l) => (l.startsWith('size:') && l !== rules.size) || (l === cfg.labels.needs_issue && !needsIssue));
  for (const name of remove) await act({ type: 'unlabel', name, target }, () => github.rest.issues.removeLabel({ ...repo, issue_number: pr.number, name }));
  if (add.length) {
    for (const name of add) actions.push({ type: 'label', name, target });
    if (!dry) await github.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: add }).catch((e) => errors.push(`label: ${e.status || e.message}`));
  }
  if (verdict.verdict === 'spam' && !pr.labels.includes(cfg.labels.review)) {
    await act({ type: 'lock', target }, () => github.rest.issues.lock({ ...repo, issue_number: pr.number, lock_reason: 'spam' }));
  }

  // Sticky comment.
  const yes = (b) => (b ? 'yes' : 'no');
  const box = (ok, text) => `- [${ok ? 'x' : ' '}] ${text}`;
  const checklist = [
    box(rules.title_ok, 'Conventional Commits title (`type(scope): summary`)'),
    box(rules.linked_issue || rules.needs_issue_exempt || pr.dependabot, 'Linked issue (`Closes #n`)'),
    box(!rules.missing_tests, 'Tests updated for code changes'),
    box(!rules.missing_docs, 'Docs or CHANGELOG updated for code changes'),
    box(!privacy.length, 'No private data (home paths, emails, session ids, private names)'),
    box(!rules.risks.workflow, 'No workflow changes (or reviewed: they run with repository permissions)'),
  ].join('\n');
  const riskText = Object.entries(rules.risks).map(([k, v]) => `${k} (${v.slice(0, 3).map((f) => '`' + f + '`').join(', ')})`).join('; ') || 'none';
  let summary = '';
  if (pr.dependabot) summary = `**Dependency update:** ${state.bump} version bump. ${state.bump === 'major' ? 'Read the release notes for breaking changes before merging.' : 'Low risk if CI passes.'}`;
  else if (privacy.length) summary = `**Private data found** (values not shown): ${privacy.map((h) => `${h.rule} at \`${h.file}:${h.line}\``).join(', ')}. Remove it and rewrite the commit; see the privacy-scan check.`;
  else if (model.data && model.data.summary) summary = `**Review summary** (automated, ${model.provider}):\n\n${L.sanitize(model.data.summary, cfg)}`;
  else summary = `<sub>No model summary (${model.reason}).</sub>`;
  const areas = [...new Set(rules.areas.concat((model.data && model.data.areas) || []))];
  const body = L.render(L.template('pr-summary'), {
    marker: cfg.pr.sticky_marker, type: rules.type || 'unknown (title not conventional)', areas: areas.join(', ') || 'none',
    size: rules.size, lines: rules.lines, files: rules.files, title_ok: yes(rules.title_ok),
    linked: rules.linked_issue ? 'yes' : (rules.needs_issue_exempt ? 'not needed (release PR)' : 'no'), risks: riskText, checklist, summary,
  });
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: pr.number, per_page: 100 });
  const prev = comments.find((c) => c.user && c.user.login === 'github-actions[bot]' && (c.body || '').includes(cfg.pr.sticky_marker));
  if (!prev || prev.body.trim() !== body.trim()) {
    await act({ type: prev ? 'comment-update' : 'comment' }, () => (prev
      ? github.rest.issues.updateComment({ ...repo, comment_id: prev.id, body })
      : github.rest.issues.createComment({ ...repo, issue_number: pr.number, body })));
  }

  L.record(LOG, {
    workflow: 'pr-check', event: state.event, item: `pr#${pr.number}`, verdict: verdict.verdict, size: rules.size,
    risks: Object.keys(rules.risks), privacy: privacy.map((h) => h.rule), purpose: state.purpose || null,
    provider: model.provider, fallback_reason: model.reason, latency_ms: process.env.MODEL_LATENCY_MS || null,
    turns: process.env.MODEL_TURNS || null, tokens: process.env.MODEL_TOKENS || null, actions, errors, dry_run: dry,
  });
  if (errors.length) core.warning(`fail-open: ${errors.join('; ')}`);
}

module.exports = { gate, apply, addedLines, privacyOfFiles };
