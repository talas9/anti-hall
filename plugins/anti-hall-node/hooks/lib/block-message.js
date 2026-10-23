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
// One emoji, at the very start, from a fixed set with one meaning each. No ALL-CAPS
// banners. Pure text (no tool names added here), so the same string is valid for
// the Claude and Codex ports; callers keep their own exit-2 + stderr contract.

const ICONS = {
  block: '⛔',        // blocked
  warn: '⚠️',   // warning / advisory
  tip: '💡',    // tip / nudge
  ok: '✅',           // ok / done
  update: '\u2B06\uFE0F',   // update available
  error: '❌',        // error
};

const OVERRIDE_LABEL = 'Override (only if the user explicitly asked)';

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// message({ kind='block', guard, what, why, instead, allowed, override, extra })
//   kind: block | warn | tip | ok | update | error (picks the leading emoji)
//   extra: optional array of additional plain lines appended last.
function message(o) {
  const opts = o || {};
  const icon = ICONS[opts.kind] || ICONS.block;
  const lines = [icon + ' anti-hall · ' + clean(opts.guard) + ': ' + clean(opts.what)];
  if (opts.why) lines.push('Why: ' + clean(opts.why));
  if (opts.instead) lines.push('Do instead: ' + clean(opts.instead));
  if (opts.allowed) lines.push('Allowed here: ' + clean(opts.allowed));
  if (opts.override) lines.push(OVERRIDE_LABEL + ': ' + clean(opts.override));
  if (Array.isArray(opts.extra)) for (const l of opts.extra) if (l) lines.push(clean(l));
  return lines.join('\n');
}

// frame({ kind, guard, headline, why, body, override }) -> the shared shape for the
// DevSwarm gates, whose "Do instead" is assembled from many conditional segments:
// the first paragraph rides the "Do instead:" line, later paragraphs follow as
// two-space-indented continuation lines.
function frame(o) {
  const icon = ICONS[o.kind] || ICONS.block;
  const lines = [icon + ' anti-hall \u00B7 ' + clean(o.guard) + ': ' + clean(o.headline)];
  if (o.why) lines.push('Why: ' + clean(o.why));
  const paras = String(o.body == null ? '' : o.body).split(/\n{2,}/).map(clean).filter(Boolean);
  if (paras.length) {
    lines.push('Do instead: ' + paras[0]);
    for (const p of paras.slice(1)) lines.push('  ' + p);
  }
  if (o.override) lines.push(OVERRIDE_LABEL + ': ' + clean(o.override));
  return lines.join('\n');
}

const blockMessage = (o) => message(Object.assign({}, o, { kind: 'block' }));

module.exports = { message, blockMessage, frame, ICONS, OVERRIDE_LABEL };
