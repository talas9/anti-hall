'use strict';
// anti-hall :: doctor-descriptors — REPORT-ONLY integrity scan of the DevSwarm
// descriptor store (~/.anti-hall/devswarm/{workspaces,archived}/*.json).
//
// scanDescriptors({home, fsi}) -> { scanned, findings: [{kind, status, path, id, message}] }
//
// ============================ HARD SAFETY CONTRACT ============================
// This module NEVER writes, moves, renames, deletes, quarantines or "repairs"
// anything. It opens descriptor files read-only and returns strings. Every
// descriptor it flags is REAL DATA with its own inbox/cursor files, and removing
// one is an owner decision that has NOT been given. If you are here to add an
// auto-fix, a --repair flag, or an unlink() — don't. That is deliberately out of
// scope, and a "cleanup" that silently drops a descriptor destroys the message
// history hanging off it. Surface it; let a human decide.
// =============================================================================
//
// WHY THIS EXISTS: the roster renders one row per known workspace, deduping on
// exact id equality. A descriptor whose id is a TRUNCATED copy of a real
// workspace's id is therefore a different string, correctly fails to collide
// with it, and renders as a second "phantom" row for a workspace that only
// exists once. The dedup is right; the DATA is wrong. Nothing in the existing
// validation path catches it, because isSafeId() is a PATH-SAFETY gate (no
// separators/traversal), not an id-SHAPE gate — a 34-char truncated uuid is a
// perfectly safe path segment. This scan is the missing shape check.
//
// KNOWN ORIGIN (verified, not inferred): hooks/devswarm-child-turn.js:85-100
// documents the one proven producer — hivecontrol's DEVSWARM_BUILDER_ID env var
// arriving truncated by a couple of trailing hex chars (an env-plumbing bug
// OUTSIDE anti-hall), which registerChildDescriptor then trusted as a filename
// with zero shape validation and re-wrote every turn. v0.62.2 closed that with
// TRUNCATED_UUID_RE + retirePhantomWorktreeDuplicates, which forwards the
// phantom's unread messages to the real workspace and archives it.
//
// So this scan is DETECTIVE, not preventive, and the two do not overlap: the
// v0.62.2 defense stops NEW phantoms being written into workspaces/, but it
// deliberately never deletes — a retired phantom is hardlinked into archived/
// and kept forever. Nothing re-examines archived/ afterwards, so a descriptor
// retired before/by that fix stays on disk and the roster's archived fold still
// renders it. This scan is the only thing that looks.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { isSafeId, devswarmRoot } = require('./liveness.js');

const PASS = 'PASS';
const WARN = 'WARN';

// A canonical RFC-4122-shaped id: 8-4-4-4-12 hex groups.
const UUID_CANONICAL = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// "Looks like someone meant a uuid": five all-hex groups, any lengths. This is
// the discriminator that lets the shape check coexist with the human-readable
// workspace ids introduced in v0.67.0 (`fix-analytics-coverage-gaps-a55f20ef`,
// `primary-2e126d49`, `antihall-selftest`). Those are NOT all-hex — they contain
// letters outside [a-f] — so they never match UUID_SHAPED and are never flagged.
// Only an id that is hex-and-dashes in five groups but has non-canonical group
// lengths trips this, which is exactly the truncated-uuid signature.
const UUID_SHAPED = /^[0-9a-fA-F]+(-[0-9a-fA-F]+){4}$/;

// ---------------------------------------------------------------------------
// CHECKS DELIBERATELY *NOT* IMPLEMENTED (measured against the live store, 76
// descriptors, before this module was written — keeping the negative result so
// nobody "helpfully" re-adds a known noise source):
//
//   * inboxPath/cursorPath basename != "<id>.ndjson"/"<id>.cursor"
//     -> fires on 33 of 76 descriptors. A large share of the store legitimately
//        uses a per-worktree `inbox.ndjson` / `inbox.cursor` naming convention
//        rather than an id-derived one. This is a SECOND valid convention, not
//        corruption, so the check is ~97% false positive. Not a check.
//
//   * two active descriptors sharing one worktreePath ("duplicate worktree")
//     -> fires on 9 groups. That is the expected residue of the v0.67.0
//        uuid -> human-readable-id migration, which leaves both the old uuid
//        descriptor and the new named one pointing at the same worktree. Normal
//        state, not corruption. Not a check.
//
// The two checks that DID survive calibration (prefixShadow + uuid shape) each
// fired exactly ONCE on the live store, on the same known-bad descriptor, with
// zero other hits.
// ---------------------------------------------------------------------------

function dirFor(home, which) { return path.join(devswarmRoot(home), which); }

// readRaw(home, which, F) -> [{file, path, id, parsed, error}]. Deliberately
// does NOT filter out malformed entries the way doctor-devswarm's
// readDescriptors() does — the malformed ones are the whole point here.
function readRaw(home, which, F) {
  const dir = dirFor(home, which);
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const p = path.join(dir, n);
    let parsed = null; let error = null;
    try { parsed = JSON.parse(F.readFileSync(p, 'utf8')); } catch (e) { error = (e && e.message) || String(e); }
    out.push({ file: n, base: n.replace(/\.json$/, ''), path: p, parsed, error, id: parsed && typeof parsed.id === 'string' ? parsed.id : null });
  }
  return out;
}

// describeShape(id) -> a human-readable group-length signature, e.g. "8-4-4-4-10".
function describeShape(id) { return id.split('-').map((g) => g.length).join('-'); }

// scanDescriptors({home, fsi}) -> {scanned, findings}. Pure + read-only.
// findings[].status is WARN for every anomaly: a corrupt descriptor means the
// USER'S DATA needs a human decision, not that anti-hall itself is broken, and
// this check cannot fix it by design — so it advises rather than hard-failing
// doctor. See the safety contract at the top.
function scanDescriptors(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;

  const active = readRaw(home, 'workspaces', F);
  const archived = readRaw(home, 'archived', F);
  const findings = [];

  const activeIds = new Set(active.map((e) => e.id).filter(Boolean));

  // Per-entry shape checks across BOTH directories.
  for (const [which, entries] of [['workspaces', active], ['archived', archived]]) {
    for (const e of entries) {
      const where = which + '/' + e.file;
      if (e.error) {
        findings.push({ kind: 'unreadable', status: WARN, path: e.path, id: null,
          message: 'descriptor ' + where + ': unreadable/torn JSON (' + e.error + ')' });
        continue;
      }
      if (!e.id) {
        findings.push({ kind: 'id-missing', status: WARN, path: e.path, id: null,
          message: 'descriptor ' + where + ': missing or non-string "id" field' });
        continue;
      }
      if (!isSafeId(e.id)) {
        findings.push({ kind: 'id-unsafe', status: WARN, path: e.path, id: e.id,
          message: 'descriptor ' + where + ': id ' + JSON.stringify(e.id) + ' is not a safe path segment' });
      }
      if (e.id !== e.base) {
        findings.push({ kind: 'filename-mismatch', status: WARN, path: e.path, id: e.id,
          message: 'descriptor ' + where + ': internal id ' + JSON.stringify(e.id) + ' does not match its filename ' + JSON.stringify(e.base) });
      }
      if (UUID_SHAPED.test(e.id) && !UUID_CANONICAL.test(e.id)) {
        const sess = e.parsed && typeof e.parsed.sessionId === 'string' ? e.parsed.sessionId : null;
        // The sessionId frequently still holds the UNtruncated value, which is
        // the single most useful clue for a human deciding what this row was.
        const clue = (sess && UUID_CANONICAL.test(sess) && sess.startsWith(e.id))
          ? ' — its own sessionId ' + JSON.stringify(sess) + ' holds the full-length value'
          : '';
        findings.push({ kind: 'uuid-malformed', status: WARN, path: e.path, id: e.id,
          message: 'descriptor ' + where + ': id ' + JSON.stringify(e.id) + ' is uuid-shaped but malformed'
            + ' (' + e.id.length + ' chars, groups ' + describeShape(e.id) + ', expected 36 / 8-4-4-4-12)' + clue });
      }
    }
  }

  // Cross-directory: an archived id that is a STRICT PREFIX of a live workspace
  // id. This is the phantom-roster-row signature. Archiving leaves the original
  // descriptor in workspaces/ (17 of 20 archived ids are also active on the live
  // store), so an archived id that is ALSO an active id is the normal case and
  // is skipped — only an archived id with no active twin, which nonetheless
  // prefixes a real one, is reported.
  for (const a of archived) {
    if (!a.id || activeIds.has(a.id)) continue;
    const shadowed = [];
    for (const b of activeIds) if (b !== a.id && b.startsWith(a.id)) shadowed.push(b);
    if (!shadowed.length) continue;
    findings.push({ kind: 'prefix-shadow', status: WARN, path: a.path, id: a.id,
      message: 'descriptor archived/' + a.file + ': id ' + JSON.stringify(a.id) + ' (' + a.id.length + ' chars)'
        + ' is a strict PREFIX of live workspace id(s) ' + shadowed.map((s) => JSON.stringify(s) + ' (' + s.length + ')').join(', ')
        + ' — the roster dedups on exact id, so this renders as an extra phantom row for a workspace that exists once.'
        + ' Known producer: a truncated DEVSWARM_BUILDER_ID (see hooks/devswarm-child-turn.js:85-100); v0.62.2 stops NEW ones but never deletes retired ones.'
        + ' REPORT ONLY: left untouched (it owns real inbox/cursor files); removing it needs explicit owner confirmation' });
  }

  return { scanned: active.length + archived.length, findings };
}

// checkResults({home, fsi}) -> [{status, message}] in doctor-devswarm's shape.
// Emits a single PASS line when clean so the check is visibly running rather
// than silently absent.
function checkResults(opts) {
  let scan;
  try {
    scan = scanDescriptors(opts);
  } catch (e) {
    return [{ status: WARN, message: 'descriptor integrity scan raised (fail-open): ' + (e && e.message) }];
  }
  if (!scan.scanned) return [];
  if (!scan.findings.length) {
    return [{ status: PASS, message: 'descriptor integrity: ' + scan.scanned + ' descriptor(s) scanned, no malformed or shadowing ids' }];
  }
  return scan.findings.map((f) => ({ status: f.status, message: f.message }));
}

module.exports = { PASS, WARN, UUID_CANONICAL, UUID_SHAPED, scanDescriptors, checkResults };
