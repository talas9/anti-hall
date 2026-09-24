'use strict';
// Hygiene (mesh redesign Phase 5 ack split): `inbox read-primary` and
// `inbox messages --ack` are READ-ONLY. Every instruction surface that names
// one of them must, in the SAME template, name the ack step
// (`ack-primary` / `ackCommand`) — or the one-release `drain-primary-legacy`
// verb. Otherwise an agent reads, believes it drained, and the mail re-fires.
//
// Surfaces: every hook-injected text (hooks/**/*.js string lines), the CLI's
// own user-facing strings (scripts/devswarm.js), both ports' skills, and the
// READMEs + the Monitor/cron KB templates, and the CURRENT-GUIDANCE sections of
// docs/KB-devswarm-hivecontrol.md (see KB_GUIDANCE below).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const MENTION = /read-primary|messages[^`'"\n]{0,40}--ack\b/;
const ACK = /ack-primary|ackCommand|drain-primary-legacy|ACK_AFTER_READ/;
const WINDOW = 6; // lines either side = "the same template" for JS string concatenations

function tracked(prefix, suffix) {
  const r = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', prefix], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((f) => f.endsWith(suffix) && fs.existsSync(path.join(REPO, f)));
}

// JS: a non-comment line carrying a string literal that mentions read-primary
// must have an ack mention within WINDOW lines (the rest of that template).
function jsViolations(files) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (!MENTION.test(text) || !/['"`]/.test(text)) return;
      // Code identifiers / dispatch comparisons are not instruction text.
      if (/sub === '|=== 'read-primary'|\(\?:|action:|opts\.action|verb: 'read-primary'|'inbox-' \+ sub/.test(text)) return;
      const win = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
      if (!ACK.test(win)) out.push(f + ':' + (i + 1) + '  ' + text.trim().slice(0, 140));
    });
  }
  return out;
}

// Markdown: a paragraph / table row / list item mentioning read-primary or
// messages --ack must also name the ack step.
function mdViolations(files) {
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    let line = 1;
    for (const block of text.split(/\n\s*\n/)) {
      const units = block.split('\n').some((l) => /^\s*\|/.test(l)) ? block.split('\n') : [block];
      for (const u of units) {
        if (MENTION.test(u) && !ACK.test(u)) out.push(f + ':~' + line + '  ' + u.replace(/\s+/g, ' ').trim().slice(0, 140));
      }
      line += block.split('\n').length + 1;
    }
  }
  return out;
}

test('every hook / CLI instruction naming read-primary also names the ack step', () => {
  const files = tracked('plugins/anti-hall/hooks/', '.js').concat(['plugins/anti-hall/scripts/devswarm.js']);
  const v = jsViolations(files);
  assert.deepStrictEqual(v, [], 'read-primary without its ack step:\n' + v.join('\n'));
});

test('every skill / README / cron-Monitor template naming read-primary also names the ack step', () => {
  const files = tracked('plugins/anti-hall/skills/', 'SKILL.md')
    .concat(tracked('plugins/anti-hall/codex/skills/', 'SKILL.md'))
    .concat(['README.md', 'plugins/anti-hall/README.md', 'plugins/anti-hall/codex/README.md', 'docs/KB-claude-monitor-tool.md']);
  const v = mdViolations(files);
  assert.deepStrictEqual(v, [], 'read-primary without its ack step:\n' + v.join('\n'));
});

// docs/KB-devswarm-hivecontrol.md: §1-§11 (the reference + CLI table + worked
// examples) and §47 (Phase 5) are CURRENT GUIDANCE and are scanned. EXCLUDED on
// purpose: §12 Sources through §46 — dated changelog/defect narrative that
// records what shipped at the time (rewriting history there would falsify it).
const KB = 'docs/KB-devswarm-hivecontrol.md';
function kbGuidanceText() {
  const lines = fs.readFileSync(path.join(REPO, KB), 'utf8').split('\n');
  const end = lines.findIndex((l) => l.startsWith('## 12. Sources'));
  const s47 = lines.findIndex((l) => l.startsWith('## 47. '));
  assert.ok(end > 0 && s47 > end, 'KB section anchors moved — update the guidance ranges');
  return { current: lines.slice(0, end).join('\n'), s47: lines.slice(s47).join('\n') };
}
// In-call ack wording that the split made false.
const ONE_SHOT = /acks? (?:it |them )?in one (?:shot|call)|in the same call \(equivalent to `read-primary`\)|read-and-ack in one call/i;

test('KB current-guidance sections: every read-primary mention names the ack step, no in-call-ack wording', () => {
  const { current, s47 } = kbGuidanceText();
  const out = [];
  for (const [name, text] of [['§1-§11', current], ['§47', s47]]) {
    const tmp = path.join(require('node:os').tmpdir(), 'kb-scan-' + process.pid + '.md');
    fs.writeFileSync(tmp, text);
    try {
      for (const v of mdViolations([path.relative(REPO, tmp)])) out.push(name + ' ' + v);
    } finally { fs.rmSync(tmp, { force: true }); }
    text.split(/\n\s*\n/).forEach((b) => {
      if (ONE_SHOT.test(b) && !/drain-primary-legacy|legacy-ack-now|one-release|one release|Historical/.test(b)) {
        out.push(name + ' one-shot ack wording: ' + b.replace(/\s+/g, ' ').slice(0, 140));
      }
    });
  }
  assert.deepStrictEqual(out, [], 'KB guidance still describes an in-call ack:\n' + out.join('\n'));
});
