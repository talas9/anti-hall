'use strict';
// assertShape(text, guard, label[, opts]) — the shared guard/advisory message shape
// (plugins/anti-hall/hooks/lib/block-message.js): a leading icon from the fixed set,
// `anti-hall · <guard>: <what>`, then only labelled lines (Why / Do instead /
// Allowed here / Override ...); continuation lines (two-space indent) are allowed
// after a labelled line. opts.maxLines (default 12), opts.requireWhy (default false).
const assert = require('node:assert');
const bm = require('../../plugins/anti-hall/hooks/lib/block-message.js');

const ICONS = Object.values(bm.ICONS);
const LABELS = /^(Why|Do instead|Allowed here|Override \(only if the user explicitly asked\)): |^Override \(only if the user explicitly confirmed[^)]*\): /;

function assertShape(text, guard, label, opts) {
  const o = Object.assign({ maxLines: 12, requireWhy: false }, opts || {});
  const lines = String(text).split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= o.maxLines, label + ': 1-' + o.maxLines + ' lines, got ' + lines.length + '\n' + text);
  const m = /^(\S+) anti-hall · ([a-z0-9-]+): (.+)$/.exec(lines[0]);
  assert.ok(m, label + ': headline shape\n' + lines[0]);
  assert.ok(ICONS.includes(m[1]), label + ': icon from the fixed set, got ' + m[1]);
  if (guard) assert.strictEqual(m[2], guard, label + ': guard name');
  for (const l of lines.slice(1)) {
    assert.ok(LABELS.test(l) || /^ {2}\S/.test(l) || /^\S+ anti-hall · /.test(l),
      label + ': labelled line expected, got "' + l.slice(0, 60) + '"');
  }
  assert.doesNotMatch(lines[0], /\b[A-Z]{4,}(?: [A-Z]{2,})+\b/, label + ': no ALL-CAPS banner');
  if (o.requireWhy) assert.ok(lines.some((l) => l.startsWith('Why: ')), label + ': has Why');
  return lines;
}

module.exports = { assertShape };
