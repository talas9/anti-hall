'use strict';
// anti-hall :: devswarm-sender-alias — display/routing alias for historical
// sender labels (v0.108.0 identity fix).
//
// WHY: before v0.108.0 every caller's `from` was `primary-<sha256(worktree)[0:8]>`,
// children included, so a child's sends and broadcasts read as coming from "a
// Primary". A resumed Primary saw such a label and stood down. Sends now carry
// the child's registered builder id; rows already written keep their original
// `from` (history is never rewritten). This file maps an old child label to the
// child's real id so the projection (summary recent[]) and the gate show the
// child, not a phantom Primary.
//
// FILE: <home>/.anti-hall/devswarm/sender-aliases.json
//   { "version": 1, "aliases": { "<primary-hash>": { "to": "<childId>", "worktree": "<path>", "at": <ms> } } }
// Written by `send` (a child records its own label once) and by the
// sender-alias-v1 migration. Additive only; readers treat absence as "no alias".
// Never throws. Pure Node built-ins.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
function isSafe(id) { return typeof id === 'string' && id !== '' && !id.includes('..') && SAFE_ID.test(id); }

function aliasPath(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm', 'sender-aliases.json');
}

// readAliases(home) -> { [label]: { to, worktree, at } } (empty on any error).
function readAliases(home) {
  try {
    const j = JSON.parse(fs.readFileSync(aliasPath(home), 'utf8'));
    const a = j && j.aliases && typeof j.aliases === 'object' ? j.aliases : {};
    const out = {};
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (isSafe(k) && v && isSafe(String(v.to)) && String(v.to) !== k) out[k] = { to: String(v.to), worktree: v.worktree || null, at: v.at || null };
    }
    return out;
  } catch (_) { return {}; }
}

// resolveAlias(home, label, aliases?) -> the aliased id, or `label` unchanged.
// One hop only (no chains), so a corrupt/cyclic file can never loop.
function resolveAlias(home, label, aliases) {
  if (label == null) return label;
  const a = aliases || readAliases(home);
  const hit = a[String(label)];
  return hit ? hit.to : label;
}

// writeAlias(home, label, to, worktree) -> true when the file changed.
// Idempotent: an identical existing entry is left untouched (no rewrite).
function writeAlias(home, label, to, worktree) {
  try {
    if (!isSafe(String(label)) || !isSafe(String(to)) || String(label) === String(to)) return false;
    const file = aliasPath(home);
    let j = { version: 1, aliases: {} };
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && prev.aliases && typeof prev.aliases === 'object') j = { version: 1, aliases: prev.aliases };
    } catch (_) { /* absent or corrupt: start fresh (corrupt content is replaced, never merged) */ }
    const cur = j.aliases[String(label)];
    if (cur && String(cur.to) === String(to)) return false;
    j.aliases[String(label)] = { to: String(to), worktree: worktree || null, at: Date.now() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

module.exports = { aliasPath, readAliases, resolveAlias, writeAlias };
