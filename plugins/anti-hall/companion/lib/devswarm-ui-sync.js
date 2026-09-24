'use strict';
// anti-hall :: devswarm-ui-sync — reconcile a transcribed screenshot of the
// DevSwarm workspace sidebar against the app DB and anti-hall's records
// (v0.108.0). PURE: no fs, no spawn — the `sync-ui` verb (scripts/devswarm.js)
// gathers the inputs and applies the plan.
//
// The app DB (devswarm-app-db.js) is the PRIMARY source; a screenshot is the
// fallback / cross-check the owner can supply when the DB is unreadable or
// disagrees with anti-hall. SAFETY RULES (enforced here, not by callers):
//   - archive ONLY what the app DB itself says is archived (isActive 0 +
//     isHidden 1) and the screenshot does not show;
//   - app-active but absent from the screenshot -> KEEP (a partial screenshot
//     is normal);
//   - app DB unreadable -> archive NOTHING (report only);
//   - visible in the screenshot but app-archived -> conflict;
//   - anti-hall archived marker but app-active -> conflict (never auto-unarchived);
//   - title updates always write the app's FULL stored label, never the
//     screenshot text (the sidebar truncates by width);
//   - nothing is ever deleted.
//
// MATCHING: normalize both sides (NFKC, collapse whitespace, strip a trailing
// "…" / "...", casefold); a title matches a builder when one normalized string
// is a prefix of the other with >= 12 shared chars (or they are equal).
// Scoped to one repository, Primary workspaces excluded. Several candidates ->
// prefer the ones the sidebar can show (not hidden); still tied -> the candidate
// whose sidebar position (rank order) equals the title's position in the
// screenshot; still tied -> ambiguous (the caller asks the owner).

const MIN_PREFIX = 12;

function normTitle(s) {
  if (typeof s !== 'string') return '';
  let t = s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*(?:…|\.\.\.)$/u, '').trim();
  return t.toLowerCase();
}

function titleMatches(shot, label) {
  const a = normTitle(shot);
  const b = normTitle(label);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

// planUiSync({ titles, snapshot, repositoryId, descriptors, markers, names }) -> plan.
//   titles:      string[] transcribed top-to-bottom from the sidebar ([] = no screenshot)
//   snapshot:    devswarm-app-db snapshot | null (null = app DB unreadable)
//   repositoryId the app repository to scope to (null = every repository)
//   descriptors: [{ id, worktreePath }] anti-hall's ACTIVE workspace descriptors
//   markers:     Set/array of ids holding an anti-hall archived marker
//   names:       { [id]: cachedName }
function planUiSync(input) {
  const i = input || {};
  const titles = Array.isArray(i.titles) ? i.titles.filter((t) => typeof t === 'string' && t.trim()) : [];
  const snap = i.snapshot || null;
  const markers = new Set(Array.isArray(i.markers) ? i.markers : (i.markers instanceof Set ? [...i.markers] : []));
  const names = i.names || {};
  const descriptors = Array.isArray(i.descriptors) ? i.descriptors : [];
  const plan = { appDb: !!snap, matched: [], ambiguous: [], unmatched: [], toArchive: [], titleUpdates: [], conflicts: [], unknown: [] };

  if (!snap) {
    // No ground truth: nothing is archived; every active descriptor is unknown.
    plan.unknown = descriptors.map((d) => String(d.id));
    plan.unmatched = titles.slice();
    return plan;
  }
  const scoped = snap.workspaces.filter((w) => w.builderType !== 'primary' && (!i.repositoryId || w.repositoryId === i.repositoryId));
  // The sidebar lists the builders that are not hidden (open or closed).
  const visible = (w) => (w.isHidden == null ? !w.archived : !w.isHidden);
  const visibleByRank = scoped.filter(visible)
    .sort((a, b) => ((a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)));
  const shown = new Set();

  titles.forEach((title, pos) => {
    let cands = scoped.filter((w) => titleMatches(title, w.label));
    if (cands.length > 1) {
      const vis = cands.filter(visible);
      if (vis.length) cands = vis;
    }
    if (cands.length > 1) {
      const byPos = visibleByRank[pos];
      if (byPos && cands.some((c) => c.id === byPos.id)) cands = [byPos];
    }
    if (cands.length === 0) { plan.unmatched.push(title); return; }
    if (cands.length > 1) { plan.ambiguous.push({ title, candidates: cands.map((c) => ({ id: c.id, label: c.label, rank: c.rank })) }); return; }
    const w = cands[0];
    shown.add(w.id);
    plan.matched.push({ title, id: w.id, label: w.label, archivedInApp: !!w.archived });
    if (w.archived) plan.conflicts.push({ id: w.id, label: w.label, kind: 'visible-but-app-archived' });
    if (w.label && names[w.id] !== w.label) plan.titleUpdates.push({ id: w.id, from: names[w.id] || null, to: w.label, truncatedAtSpawn: /…$/.test(w.label) });
  });

  const byId = new Map(scoped.map((w) => [w.id, w]));
  for (const d of descriptors) {
    const id = String(d.id);
    const w = byId.get(id);
    if (!w) continue; // not an app builder of this repo (anchor rows, other repos)
    if (w.archived && !shown.has(id) && !markers.has(id)) plan.toArchive.push({ id, label: w.label });
  }
  for (const id of markers) {
    const w = byId.get(String(id));
    if (w && w.active) plan.conflicts.push({ id: w.id, label: w.label, kind: 'marker-but-app-active' });
  }
  return plan;
}

module.exports = { normTitle, titleMatches, planUiSync, MIN_PREFIX };
