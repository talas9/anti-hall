'use strict';
// Shared helpers for community.yml, pr-check.yml, privacy-scan.yml and roadmap.yml.
// Pure Node built-ins only. Tunables live in .github/moderation/config.json, comment texts in
// .github/moderation/templates/, model prompts and JSON schemas in .github/prompts/.
// Rules make every decision; model output is used only as schema-validated enum values and as
// sanitized, length-capped text.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GH = path.resolve(__dirname, '..', '..');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(GH, 'moderation', 'config.json'), 'utf8'));
}

function template(name) {
  return fs.readFileSync(path.join(GH, 'moderation', 'templates', name + '.md'), 'utf8');
}

function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const re = (s) => new RegExp(s, 'i');
const anyMatch = (patterns, text) => patterns.find((p) => re(p).test(text)) || null;

// A GitHub login is [A-Za-z0-9-] (bots add "[bot]"); anything else is not echoed.
function safeLogin(login) {
  return /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(login || '') ? login : 'there';
}

// Returns a skip reason ('' = do not skip).
function skipReason(user, repoOwner, cfg) {
  if (!user) return 'no-author';
  if (user.type === 'Bot' || /\[bot\]$/.test(user.login || '')) return 'bot';
  if (cfg.skip_logins.includes(user.login)) return 'bot';
  if (repoOwner && user.login && user.login.toLowerCase() === String(repoOwner).toLowerCase()) return 'owner';
  return '';
}

function links(text) {
  return (String(text || '').match(/https?:\/\/[^\s)\]>"']+/gi) || []);
}

// A URL is allowed only when it is one of the prefixes exactly or continues with / # or ?.
function allowedUrl(u, prefixes) {
  const l = String(u).toLowerCase();
  return prefixes.some((p) => {
    const q = p.toLowerCase();
    return l === q || (l.startsWith(q) && '/#?'.includes(l.charAt(q.length)));
  });
}

function foreignLinks(text, cfg) {
  const allowed = cfg.model.allowed_link_prefixes.concat(['https://github.com/', 'https://docs.github.com/', 'https://code.claude.com/', 'https://docs.anthropic.com/']);
  return links(text).filter((u) => !allowed.some((p) => u.toLowerCase().startsWith(p.toLowerCase())));
}

function sanitizeLinks(s, cfg) {
  return s.replace(/https?:\/\/[^\s)\]>"']+/gi, (u) => (allowedUrl(u, cfg.model.allowed_link_prefixes) ? u : '[link removed]'));
}

// Rules-only moderation verdict. kind: 'comment' | 'body'.
function classify(text, { kind, association }, cfg) {
  const m = cfg.moderation;
  const t = String(text || '');
  const abusive = anyMatch(m.abusive_patterns, t);
  if (abusive) return { verdict: 'abusive', reason: 'matched an abuse pattern' };
  const spam = anyMatch(m.spam_patterns, t);
  if (spam) return { verdict: 'spam', reason: 'matched a spam pattern' };
  const untrusted = m.untrusted_associations.includes(association || 'NONE');
  if (untrusted && foreignLinks(t, cfg).length >= m.spam_max_foreign_links_untrusted) {
    return { verdict: 'spam', reason: 'several outside links from a new account' };
  }
  const off = anyMatch(m.off_topic_patterns, t);
  if (off) return { verdict: 'off-topic', reason: 'matched an off-topic pattern' };
  if (kind === 'comment') {
    if (anyMatch(m.low_quality_comment_patterns, t)) return { verdict: 'low-quality', reason: 'comment adds no information' };
  } else {
    const stripped = stripHtmlComments(t.replace(/^###.*$/gm, '').replace(/_No response_/g, '')).trim();
    if (stripped.length < m.low_quality_min_body_chars) return { verdict: 'low-quality', reason: 'description is nearly empty' };
  }
  return { verdict: 'ok', reason: '' };
}

// Remove HTML comments with a scan (no regex), repeating until nothing changes so nested forms
// such as "<!<!---->--" cannot leave a comment opener behind. An unterminated opener drops the rest.
function stripHtmlComments(text) {
  let s = String(text);
  for (;;) {
    const a = s.indexOf('<!--');
    if (a < 0) return s;
    const b = s.indexOf('-->', a + 4);
    s = b < 0 ? s.slice(0, a) : s.slice(0, a) + s.slice(b + 3);
  }
}

// One escaper for every character that can open markup or an attribute.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/^\w+(\([^)]*\))?:\s*/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// "### Heading\n\nvalue" blocks rendered by issue and discussion forms.
function formField(body, heading) {
  const m = String(body || '').match(new RegExp('^###\\s+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n+([^\\n]+)', 'mi'));
  const v = m ? m[1].trim() : '';
  return v === '_No response_' ? '' : v;
}

function bestKeyword(map, text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  let best = null, score = 0;
  for (const [label, words] of Object.entries(map)) {
    const s = words.filter((w) => t.includes(w.toLowerCase())).length;
    if (s > score) { best = label; score = s; }
  }
  return best;
}

// Rules-only triage proposal. Fields the issue form or existing labels already set are kept and
// marked as preset, so they are never overwritten.
function triageRules({ title, body, labels }, cfg) {
  const c = cfg.triage;
  const have = new Set(labels || []);
  const pick = (list) => list.find((l) => have.has(l)) || null;
  const text = (title || '') + '\n' + (body || '');
  const preset = {};
  const out = {};
  const reasons = [];

  const presetType = pick(c.types);
  // Issue-form titles start with "bug:" / "feature:"; a conventional prefix beats keywords.
  const prefix = (String(title || '').toLowerCase().match(/^(bug|fix|feature|feat|docs|chore)\b/) || [])[1];
  const byPrefix = prefix && { bug: 'type:bug', fix: 'type:bug', feature: 'type:feature', feat: 'type:feature', docs: 'type:docs', chore: 'type:chore' }[prefix];
  out.type = presetType || byPrefix || bestKeyword(c.type_keywords, text) || 'type:feature';
  preset.type = !!presetType;
  if (!presetType) reasons.push(`type from ${byPrefix ? 'the title prefix' : 'keywords'} (${out.type.slice(5)})`);

  const formArea = formField(body, 'Area').toLowerCase();
  const presetArea = pick(c.areas) || (c.areas.includes('area:' + formArea) ? 'area:' + formArea : null);
  out.area = presetArea || bestKeyword(c.area_keywords, text) || 'none';
  preset.area = !!presetArea;
  if (!presetArea) reasons.push(out.area === 'none' ? 'no area keyword found' : `area from keywords (${out.area.slice(5)})`);

  const formPr = (formField(body, 'Priority').match(/^P([0-3])\b/) || [])[1];
  const presetPr = pick(c.priorities) || (formPr ? 'priority:P' + formPr : null);
  out.priority = presetPr || bestKeyword(c.priority_keywords, text) || c.default_priority[out.type] || 'priority:P3';
  preset.priority = !!presetPr;
  if (!presetPr) reasons.push(`priority ${out.priority.slice(9)} from ${bestKeyword(c.priority_keywords, text) ? 'keywords' : 'the type default'}`);

  const formSize = (formField(body, 'Estimate').match(/^(S|M|L|XL)\b/) || [])[1];
  const presetSize = pick(c.sizes) || (formSize ? 'size:' + formSize : null);
  out.size = presetSize || c.default_size[out.type] || 'size:M';
  preset.size = !!presetSize;
  if (!presetSize) reasons.push(`size ${out.size.slice(5)} from the type default`);

  const formHours = Number((formField(body, 'Estimate in hours').match(/^\d+(\.\d+)?/) || [])[0]);
  out.estimate_hours = Number.isFinite(formHours) && formHours > 0 ? formHours : c.size_hours[out.size];
  preset.estimate_hours = Number.isFinite(formHours) && formHours > 0;

  return { ...out, preset, rationale: reasons.join('; ') + '.' };
}

function sizeFromLines(n, cfg) {
  for (const [label, max] of cfg.pr.size_thresholds) if (n < max) return label;
  return cfg.pr.size_max;
}

// Rules-only PR check. files: [{filename, additions, deletions}].
function prRules({ title, body, files, headRef, sameRepo, baseRef }, cfg) {
  const p = cfg.pr;
  const names = files.map((f) => f.filename);
  const lines = files.reduce((s, f) => s + (f.additions || 0) + (f.deletions || 0), 0);
  const tm = String(title || '').match(re(p.title_regex));
  const prefix = (String(title || '').match(/^(\w+)/) || [])[1];
  const risks = {};
  for (const [flag, pats] of Object.entries(p.risk_paths)) {
    const hit = names.filter((n) => pats.some((x) => re(x).test(n)));
    if (hit.length) risks[flag] = hit.slice(0, 5);
  }
  const areas = [];
  for (const [label, words] of Object.entries(cfg.triage.area_keywords)) {
    if (names.some((n) => words.some((w) => n.toLowerCase().includes(w.trim().toLowerCase())))) areas.push(label);
  }
  const has = (pats) => names.some((n) => pats.some((x) => re(x).test(n)));
  const codeChanged = has(p.code_paths);
  const releaseMerge = sameRepo && p.needs_issue_exempt_heads.includes(headRef) && baseRef === 'main';
  return {
    type: tm ? (p.title_type[prefix] || null) : null,
    title_ok: !!tm,
    size: sizeFromLines(lines, cfg),
    lines,
    files: names.length,
    risks,
    risk_labels: Object.keys(risks).map((k) => p.risk_labels[k]).filter(Boolean),
    linked_issue: re(p.linked_issue_regex).test(String(body || '')),
    needs_issue_exempt: releaseMerge,
    areas: areas.slice(0, 5),
    missing_tests: codeChanged && !has(p.test_paths),
    missing_docs: codeChanged && !has(p.doc_paths),
    // PR to the release branch: user-facing code changed with no CHANGELOG, docs/, README, skill or Codex-docs change.
    docs_drift: baseRef === p.docs_drift_base && has(p.user_facing_paths) && !has(p.docs_drift_paths),
  };
}

// Dependabot title "bump X from 1.2.3 to 2.0.0" -> semver jump.
function bumpRisk(title) {
  const m = String(title || '').match(/from v?(\d+)\.(\d+)?\S* to v?(\d+)\.(\d+)?/i);
  if (!m) return 'unknown';
  if (m[1] !== m[3]) return 'major';
  if ((m[2] || '0') !== (m[4] || '0')) return 'minor';
  return 'patch';
}

// Model text is posted only after this: HTML escaped, @mentions neutralised, links limited to the
// allowed prefixes, images dropped, length capped.
function sanitize(text, cfg, max) {
  const cap = max || cfg.model.max_summary_chars;
  let s = String(text || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  s = escapeHtml(s);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = sanitizeLinks(s, cfg);
  s = s.replace(/\]\(([^)]*)\)/g, (m, u) => (allowedUrl(u.trim(), cfg.model.allowed_link_prefixes) ? m : ']'));
  s = s.replace(/@(?=[A-Za-z0-9_-])/g, '@​');
  s = s.trim();
  if (s.length > cap) s = s.slice(0, cap - 1).trimEnd() + '…';
  return s;
}

// Parse a model reply: a JSON string, or text that contains one JSON object.
function parseModelJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Minimal JSON-schema check for the shapes in .github/prompts/*.schema.json. Unknown keys are
// dropped; a value with a wrong type or outside its enum is dropped (ignored), never coerced.
function check(v, spec, root = false) {
  if (v === undefined || v === null) return undefined;
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string' || (spec.enum && !spec.enum.includes(v))) return undefined;
      return spec.maxLength ? v.slice(0, spec.maxLength) : v;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v) || (spec.type === 'integer' && !Number.isInteger(v))) return undefined;
      if ((spec.minimum !== undefined && v < spec.minimum) || (spec.maximum !== undefined && v > spec.maximum)) return undefined;
      return v;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'array': {
      if (!Array.isArray(v)) return undefined;
      const items = v.map((x) => check(x, spec.items)).filter((x) => x !== undefined);
      const uniq = items.filter((x, i) => typeof x !== 'string' || items.indexOf(x) === i);
      return uniq.slice(0, spec.maxItems || uniq.length);
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return undefined;
      const out = {};
      for (const [k, sub] of Object.entries(spec.properties || {})) {
        const c = check(v[k], sub);
        if (c !== undefined) out[k] = c;
      }
      if (!root && (spec.required || []).some((k) => out[k] === undefined)) return undefined;
      return out;
    }
    default:
      return undefined;
  }
}

function validate(obj, schema) {
  const out = check(obj, schema, true);
  return out && Object.keys(out).length ? out : null;
}

// Privacy scrub. Returns hits [{rule, line}] - never the matched value. denylist: names from the
// PRIVATE_DENYLIST secret (newline-separated); empty = that rule is skipped.
function privacyScan(text, cfg, denylist) {
  const p = cfg.privacy;
  const hits = [];
  const deny = String(denylist || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length >= 3);
  const denyRes = deny.map((d) => new RegExp('(^|[^A-Za-z0-9])' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9])', 'i'));
  String(text || '').split(/\r?\n/).forEach((ln, i) => {
    for (const [rule, src] of Object.entries(p.rules)) {
      const r = new RegExp(src, 'g');
      for (const m of ln.matchAll(r)) {
        if (rule === 'email' && p.email_allow.some((a) => re(a).test(m[0]))) continue;
        hits.push({ rule, line: i + 1 });
        break;
      }
    }
    if (denyRes.some((r) => r.test(ln))) hits.push({ rule: 'private-name', line: i + 1 });
  });
  return hits;
}

function prompt(name) {
  const dir = path.join(GH, 'prompts');
  return {
    system: fs.readFileSync(path.join(dir, '_shared-rules.md'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, name + '.md'), 'utf8'),
    schema: JSON.parse(fs.readFileSync(path.join(dir, name + '.schema.json'), 'utf8')),
  };
}

// One prompt string for either provider: system text, schema, trusted context, then the untrusted
// text inside random-nonce markers (the marker text is stripped from the input first).
function buildPrompt(name, untrusted, context, cfg) {
  const { system, schema } = prompt(name);
  const nonce = crypto.randomBytes(8).toString('hex');
  const body = String(untrusted || '').replace(/(BEGIN|END)-UNTRUSTED[-\w]*/gi, '[marker removed]').slice(0, cfg.model.max_input_chars);
  return [
    system.trim(),
    'JSON SCHEMA for your answer:\n' + JSON.stringify(schema),
    context ? 'TRUSTED CONTEXT (from the repository rules, not from the user):\n' + context : '',
    `BEGIN-UNTRUSTED-${nonce}\n${body}\nEND-UNTRUSTED-${nonce}`,
    'Reply with the JSON object only.',
  ].filter(Boolean).join('\n\n');
}

function chain(varValue, cfg) {
  const v = String(varValue || cfg.model.default_chain).toLowerCase().trim();
  if (v === 'none' || v === 'off' || v === '') return [];
  return v.split(',').map((x) => x.trim()).filter((x) => cfg.model.providers.includes(x));
}

// Daily model budget per workflow: counts today's runs of this workflow (conservative: runs that
// skipped the model count too). Fails closed for the model (= rules only) on an API error.
async function budget(github, context, workflowFile, cap) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const r = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id: workflowFile, created: '>=' + day, per_page: 1 });
    const used = r.data.total_count;
    return { ok: used <= cap, used, cap };
  } catch (e) {
    return { ok: false, used: -1, cap, error: String(e.status || e.message) };
  }
}

function isRateLimit(e) {
  const msg = String((e && e.message) || '');
  return !!e && (e.status === 429 || (e.status === 403 && /rate limit|abuse/i.test(msg)));
}

// True when a person (not a bot) removed this label before: their decision stands.
async function humanRemovedLabel(github, repo, number, label) {
  try {
    const events = await github.paginate(github.rest.issues.listEvents, { ...repo, issue_number: number, per_page: 100 });
    return events.some((e) => e.event === 'unlabeled' && e.label && e.label.name === label && e.actor && e.actor.type !== 'Bot');
  } catch {
    return false;
  }
}

// Telemetry: one JSON line in $RUNNER_TEMP/<log>.jsonl (uploaded as an artifact) and one row in
// the job summary.
function record(logName, entry) {
  const row = { ts: new Date().toISOString(), ...entry };
  const dir = process.env.RUNNER_TEMP || '.';
  fs.appendFileSync(path.join(dir, logName + '.jsonl'), JSON.stringify(row) + '\n');
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) {
    const cell = (v) => String(v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
    if (!fs.existsSync(sum) || !fs.readFileSync(sum, 'utf8').includes('| event | item |')) {
      fs.appendFileSync(sum, '| event | item | verdict | action | provider | fallback | latency ms |\n|---|---|---|---|---|---|---|\n');
    }
    fs.appendFileSync(sum, `| ${cell(row.event)} | ${cell(row.item)} | ${cell(row.verdict)} | ${cell((row.actions || []).map((a) => a.type + (a.name ? ':' + a.name : '')).join(', ') || 'none')} | ${cell(row.provider)} | ${cell(row.fallback_reason)} | ${cell(row.latency_ms)} |\n`);
  }
  return row;
}

// Model per job and provider slot from config.models (falls back to the 'default' row).
function modelFor(cfg, purpose) {
  const m = cfg.model.models;
  return m[purpose] || m.default;
}

// Model result handed over by ai-model.yml (job outputs): validated, or null.
function modelResult(env, schemaName) {
  const provider = env.MODEL_PROVIDER || 'none'; // slot: primary | secondary | copilot | none
  const reason = env.MODEL_REASON || '';
  const latency = Number(env.MODEL_LATENCY_MS || 0) || null;
  if (provider === 'none') return { provider: 'none', reason: reason || 'not called', latency, data: null };
  const parsed = parseModelJson(env.MODEL_RESULT);
  const data = validate(parsed, prompt(schemaName).schema);
  if (!data || !Object.keys(data).length) {
    // Structure only (never the text): tells "not JSON" from "wrong keys" without echoing model output.
    const raw = String(env.MODEL_RESULT || '');
    const shape = !raw ? 'empty reply' : !parsed ? `not parseable as JSON (${raw.length} chars, starts with ${JSON.stringify(raw.trim().slice(0, 1))})` : `JSON keys: ${Object.keys(parsed).slice(0, 8).join(',') || 'none'}`;
    return { provider: 'none', reason: `${provider} output failed validation: ${shape}`, latency, data: null };
  }
  return { provider, reason, latency, data };
}

module.exports = {
  loadConfig, template, allowedUrl, render, safeLogin, skipReason, links, foreignLinks, classify, similarity, formField,
  triageRules, sizeFromLines, privacyScan, prRules, bumpRisk, sanitize, parseModelJson, validate, prompt, buildPrompt,
  chain, budget, isRateLimit, humanRemovedLabel, record, modelResult, modelFor, escapeHtml, stripHtmlComments,
};
