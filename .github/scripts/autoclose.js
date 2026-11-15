'use strict';
// autoclose.yml: close issues named by closing keywords in a PR merged into a non-default branch.
// All tunables (keywords, comment text, base branch) come from the workflow env; nothing is
// hardcoded here. Pure Node built-ins.

// Remove text GitHub does not treat as a closing reference: fenced code, inline code, HTML comments.
function stripIgnored(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/(`+)[^`\n]*?\1/g, ' ');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Issue numbers referenced after any of `words` in `text`. Matches `#N`, `owner/repo#N` and
// github.com issue URLs; a reference to another repo is ignored.
function refsAfter(text, words, repo) {
  const alt = words.map((w) => escapeRe(w).replace(/\s+/g, '\\s+')).join('|');
  if (!alt) return new Set();
  const re = new RegExp(`(?<![\\w-])(?:${alt})(?![\\w-])[ \\t]*:?[ \\t]*(?:(?:https?://github\\.com/)?([\\w.-]+/[\\w.-]+)(?:#|/issues/)|#)(\\d+)(?!\\w)`, 'gi');
  const out = new Set();
  const want = String(repo).toLowerCase();
  for (const m of stripIgnored(text).matchAll(re)) {
    if (m[1] && m[1].toLowerCase() !== want) continue;
    out.add(Number(m[2]));
  }
  return out;
}

// Closing issue numbers for the given title/body, minus any also marked as a plain reference.
function parseClosing({ title, body, keywords, refKeywords = [], repo }) {
  const text = `${title || ''}\n${body || ''}`;
  const closing = refsAfter(text, keywords, repo);
  for (const n of refsAfter(text, refKeywords, repo)) closing.delete(n);
  return [...closing].sort((a, b) => a - b);
}

const list = (s) => String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

async function run({ github, context, core }) {
  const env = process.env;
  const pr = context.payload.pull_request;
  if (!pr || !pr.merged || pr.base.ref !== env.AUTOCLOSE_BASE) {
    core.info('not a merged PR into the configured base; nothing to do');
    return;
  }
  const { owner, repo } = context.repo;
  const nums = parseClosing({
    title: pr.title, body: pr.body,
    keywords: list(env.AUTOCLOSE_KEYWORDS), refKeywords: list(env.AUTOCLOSE_REF_KEYWORDS),
    repo: `${owner}/${repo}`,
  });
  const sha = String(pr.merge_commit_sha || '').slice(0, 7);
  const comment = String(env.AUTOCLOSE_COMMENT).replace('{pr}', pr.number).replace('{sha}', sha).replace('{base}', pr.base.ref);
  for (const n of nums) {
    if (n === pr.number) continue;
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: n }).catch((e) => {
      core.warning(`#${n}: ${e.message}`);
      return { data: null };
    });
    if (!issue || issue.pull_request || issue.state !== 'open') { core.info(`#${n}: skipped (missing, a PR, or not open)`); continue; }
    await github.rest.issues.createComment({ owner, repo, issue_number: n, body: comment });
    await github.rest.issues.update({ owner, repo, issue_number: n, state: 'closed', state_reason: 'completed' });
    core.info(`#${n}: closed`);
  }
}

module.exports = { parseClosing, refsAfter, stripIgnored, run };
