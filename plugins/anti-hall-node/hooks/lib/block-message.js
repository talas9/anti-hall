'use strict';
// block-message.js — the one human-and-model-readable shape for every guard
// block/deny reason and advisory line. Plain text, no markdown tables, short lines:
//
//   ⛔ anti-hall · <guard>: <what was blocked>
//   Why: <one short sentence>
//   Do instead: <the concrete allowed path>
//   Allowed here: <exemptions, if any>
//   Override (only if the user explicitly asked): <exact command>
//
// Shared emoji labels and plain names come from engine TOML. No ALL-CAPS
// banners. Pure text (no tool names added here), so the same string is valid for
// the Claude and Codex ports; callers keep their own exit-2 + stderr contract.

// Only shared display settings are read here. Their TOML values are JSON string literals
// or inline maps of string literals; no hook message or fallback label is embedded in JS.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.resolve(__dirname, '../../../anti-hall/engine/defaults/small_guards.toml'), 'utf8');
function shared(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = new RegExp('^\\[' + escaped + '\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))', 'm').exec(source);
  if (!section) throw new Error('Missing shared display setting: ' + key);
  const line = /^value = (.+)$/m.exec(section[1]);
  if (!line) throw new Error('Missing shared display value: ' + key);
  if (line[1].startsWith('"')) return JSON.parse(line[1]);
  const fields = {}, re = /("(?:\\.|[^"\\])*"|[\w-]+)\s*=\s*("(?:\\.|[^"\\])*")/g;
  for (const m of line[1].matchAll(re)) fields[m[1][0] === '"' ? JSON.parse(m[1]) : m[1]] = JSON.parse(m[2]);
  return fields;
}
const ICONS = shared('guardkit.icons');
const LABELS = shared('guardkit.msg_labels');
const NAMES = shared('guardkit.plain_names');
const HEAD = shared('guardkit.msg_head');
const OVERRIDE_LABEL = LABELS.override.trim().replace(/:$/, '');
function override(guard) { return shared('guardkit.override_human').replace('{guard}', guard); }

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// message({ kind='block', guard, what, why, instead, allowed, override, extra })
//   kind: block | warn | tip | ok | update | error (picks the leading emoji)
//   extra: optional array of additional plain lines appended last.
function message(o) {
  const opts = o || {};
  const icon = ICONS[opts.kind] || ICONS.block;
  const lines = [icon + HEAD + clean(NAMES[opts.guard] || opts.guard) + ': ' + clean(opts.what)];
  if (opts.why) lines.push(LABELS.why + clean(opts.why));
  if (opts.instead) lines.push(LABELS.instead + clean(opts.instead));
  if (opts.allowed) lines.push(LABELS.allowed + clean(opts.allowed));
  if (opts.override) lines.push(LABELS.override + override(opts.guard));
  if (Array.isArray(opts.extra)) for (const l of opts.extra) if (l) lines.push(clean(l));
  return lines.join('\n');
}

// frame({ kind, guard, headline, why, body, override }) -> the shared shape for the
// DevSwarm gates, whose "Do instead" is assembled from many conditional segments:
// the first paragraph rides the "Do instead:" line, later paragraphs follow as
// two-space-indented continuation lines.
function frame(o) {
  const icon = ICONS[o.kind] || ICONS.block;
  const lines = [icon + HEAD + clean(NAMES[o.guard] || o.guard) + ': ' + clean(o.headline)];
  if (o.why) lines.push(LABELS.why + clean(o.why));
  const paras = String(o.body == null ? '' : o.body).split(/\n{2,}/).map(clean).filter(Boolean);
  if (paras.length) {
    lines.push(LABELS.instead + paras[0]);
    for (const p of paras.slice(1)) lines.push('  ' + p);
  }
  if (o.override) lines.push(LABELS.override + override(o.guard));
  return lines.join('\n');
}

const blockMessage = (o) => message(Object.assign({}, o, { kind: 'block' }));

module.exports = { message, blockMessage, frame, ICONS, OVERRIDE_LABEL };
