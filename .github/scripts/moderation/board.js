'use strict';
// Pure helpers for the roadmap board reconcile (no network): the Status derived from labels and
// state, the "Progress" text taken from Done:/Left: comment lines, and the "Last update" date.

// Closed or merged -> Done. Open -> the first status label in config.project.status_precedence
// (blocked beats in-progress beats accepted beats triage). An open issue with no status label is
// Triage (and gets the status:triage label); an open PR with none is left alone (null).
function deriveStatus({ labels, state, merged, pr }, cfg) {
  const P = cfg.project;
  if (merged || String(state).toUpperCase() === 'CLOSED' || String(state).toUpperCase() === 'MERGED') return { status: P.done_status, labelMissing: false };
  const hit = P.status_precedence.find((l) => labels.includes(l));
  if (hit) return { status: P.status_from_label[hit], labelMissing: false };
  if (pr) return { status: null, labelMissing: false };
  return { status: P.status_from_label[cfg.labels.triage], labelMissing: true };
}

// Plain one-line text: markdown links reduced to their text, emphasis/code marks and mentions dropped.
function plain(s) {
  return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~>]/g, '').replace(/@/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

// comments: [{body, association, login, createdAt}] in any order. Newest trusted comment that has a
// Done:/Left:/Milestone:/Progress: line wins; its Done and Left lines are joined, capped to max chars.
function progressFrom(comments, cfg) {
  const P = cfg.project;
  const re = new RegExp(P.progress_regex, 'i');
  const trusted = (c) => P.trusted_associations.includes(c.association) || c.login === 'github-actions';
  const sorted = [...comments].filter(trusted).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const c of sorted) {
    const parts = [];
    for (const line of String(c.body || '').split(/\r?\n/)) {
      const m = line.match(re);
      if (m && parts.length < 2) parts.push(`${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}: ${plain(m[2])}`);
    }
    if (parts.length) {
      const t = parts.join(' | ');
      return { text: t.length > P.progress_max_chars ? t.slice(0, P.progress_max_chars - 1) + '…' : t, at: c.createdAt };
    }
  }
  return null;
}

// Latest of: the item's creation, any comment, a commit/PR referencing it, a PR's last commit.
function lastUpdate({ createdAt, comments, refs, commitDate }) {
  const all = [createdAt, commitDate].concat((comments || []).map((c) => c.createdAt), refs || []).filter(Boolean);
  return all.reduce((a, b) => (String(b) > String(a) ? b : a), all[0] || null);
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

// Hours since an ISO timestamp.
const hoursSince = (iso, now = Date.now()) => (iso ? (now - new Date(iso).getTime()) / 36e5 : Infinity);

module.exports = { deriveStatus, progressFrom, lastUpdate, plain, day, hoursSince };
