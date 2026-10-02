'use strict';
// "Recommended: enable Jev" notice: appears only while Jev is off, is deduped,
// is silenced by jev.recommendNotice, contains no unsourced superlatives, and
// its one measured figure matches the shipped KB.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'anti-hall');
const HOOK = path.join(PLUGIN, 'hooks', 'jev-review-reminder.js');
const rec = require(path.join(PLUGIN, 'hooks', 'lib', 'jev-recommend.js'));
const schema = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rec-'));
}
function writeSettings(home, obj) {
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify(obj));
}
function runHook(home, extraEnv) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, extraEnv || {});
  delete env.ANTIHALL_JEV; delete env.ANTIHALL_JEV_RECOMMEND_NOTICE;
  Object.assign(env, extraEnv || {});
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart' }), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  if (!r.stdout.trim()) return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('shown on first run when Jev is off, bold, with costs and enable path', () => {
  const home = tmpHome();
  const ctx = runHook(home);
  assert.ok(ctx.length <= 600, 'session notice is ' + ctx.length + ' chars');
  assert.ok(ctx.split('\n').length <= 5, 'directive + at most 4 lines');
  assert.doesNotMatch(ctx, /65\/65|45%/); // measured figure lives in README/doctor only
  assert.match(ctx, /\*\*Recommended: enable Jev/);
  assert.match(ctx, /Tell the user now/);
  assert.match(ctx, /off by default/);
  assert.match(ctx, /your own API key/);
  assert.match(ctx, /uses credits/);
  assert.match(ctx, /PRIVACY\.md/);
  assert.match(ctx, /activate jev/);
});

test('absent when Jev is enabled', () => {
  const home = tmpHome();
  writeSettings(home, { jev: { enabled: true } });
  assert.strictEqual(runHook(home), '');
});

test('deduplicated across sessions; state file written', () => {
  const home = tmpHome();
  assert.ok(runHook(home));
  assert.strictEqual(runHook(home), '');
  assert.ok(fs.existsSync(rec.statePath(home)));
});

test('re-shown after 30 days, not before', () => {
  const home = tmpHome();
  const t0 = Date.now();
  assert.ok(rec.sessionNotice({ home, env: {}, now: t0 }));
  assert.strictEqual(rec.sessionNotice({ home, env: {}, now: t0 + rec.REMIND_EVERY_MS - 1000 }), null);
  assert.ok(rec.sessionNotice({ home, env: {}, now: t0 + rec.REMIND_EVERY_MS + 1000 }));
});

test('jev.recommendNotice=false (settings and env) turns it off', () => {
  const a = tmpHome();
  writeSettings(a, { jev: { recommendNotice: false } });
  assert.strictEqual(runHook(a), '');
  const b = tmpHome();
  assert.strictEqual(runHook(b, { ANTIHALL_JEV_RECOMMEND_NOTICE: 'false' }), '');
});

test('fails open on a corrupt state file and when the state dir is unwritable', () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(rec.statePath(home)), { recursive: true });
  fs.writeFileSync(rec.statePath(home), '{not json');
  assert.ok(rec.sessionNotice({ home, env: {} }));
  const blocked = tmpHome();
  fs.mkdirSync(path.join(blocked, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(blocked, '.anti-hall', 'state'), 'a file, not a dir');
  assert.strictEqual(rec.sessionNotice({ home: blocked, env: {} }), null); // never a notice every session
});

test('hook run is fast (under 100 ms of own work)', () => {
  const t = process.hrtime.bigint();
  const home = tmpHome();
  rec.sessionNotice({ home, env: {} });
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 100);
});

const BANNED = [/massive/i, /dramatic/i, /guarantee/i, /100%/];
function jevBlocks() {
  const out = [];
  for (const rel of ['README.md', 'plugins/anti-hall/README.md', 'plugins/anti-hall/codex/README.md']) {
    const s = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const m = s.match(/<!-- jev-recommend:start -->([\s\S]*?)<!-- jev-recommend:end -->/);
    assert.ok(m, rel + ' lacks the jev-recommend block');
    out.push([rel, m[1]]);
  }
  return out;
}

test('no banned superlatives in the notice, doctor line or README blocks', () => {
  const texts = [['notice', rec.noticeText()], ['short', rec.shortNotice()], ['doctor', rec.doctorLines().join('\n')], ...jevBlocks()];
  for (const [name, t] of texts) for (const re of BANNED) assert.ok(!re.test(t), name + ' contains ' + re);
});

test('"activate jev" maps to the jev skills and the README heading exists', () => {
  assert.match(fs.readFileSync(path.join(PLUGIN, 'skills', 'jev', 'SKILL.md'), 'utf8').split('\n')[2], /"activate jev"/);
  assert.match(fs.readFileSync(path.join(PLUGIN, 'codex', 'skills', 'anti-hall-jev', 'SKILL.md'), 'utf8').split('\n')[2], /activate/);
  for (const rel of ['README.md', 'plugins/anti-hall/README.md', 'plugins/anti-hall/codex/README.md']) {
    assert.match(fs.readFileSync(path.join(REPO, rel), 'utf8'), /^### Enable Jev$/m, rel);
  }
});

test('README blocks carry the same facts as the notice', () => {
  for (const [rel, b] of jevBlocks()) {
    assert.match(b, /Recommended: enable Jev/, rel);
    assert.match(b, /65\/65/, rel);
    assert.match(b, /45%/, rel);
    assert.match(b, /off by default/, rel);
    assert.match(b, /PRIVACY\.md/, rel);
    assert.match(b, /jev\.recommendNotice/, rel);
  }
});

test('measured figure matches its constant and the shipped KB', () => {
  const E = rec.FINDING_DEDUP_EVIDENCE;
  const kb = fs.readFileSync(path.join(REPO, 'docs', 'KB-jev-classifier.md'), 'utf8');
  assert.ok(kb.includes(`**${E.correct}/${E.total} correct at confidence\n≥${E.minConfidence}**`) ||
    new RegExp(`${E.correct}/${E.total} correct at confidence\\s*≥${E.minConfidence}`).test(kb), 'KB no longer states the figure');
  assert.ok(kb.includes(`**${E.heuristicPrecisionPct}% precise**`), 'KB no longer states the baseline');
  assert.match(rec.noticeText(), new RegExp(`${E.correct}/${E.total}`));
  assert.match(rec.noticeText(), new RegExp(`${E.heuristicPrecisionPct}%`));
});

test('"on by default" list equals the schema defaults', () => {
  const on = schema.findSection('jevIntegrations').settings.filter((s) => s.default === 'on').map((s) => s.key).sort();
  assert.deepStrictEqual([...rec.ON_BY_DEFAULT_IDS].sort(), on);
  assert.match(rec.noticeText(), new RegExp(`${on.length === 9 ? 'nine' : 'XX'} integrations`));
});

test('the setting exists with default true and a docs row', () => {
  const s = schema.findSetting('jev', 'recommendNotice');
  assert.ok(s && s.default === true && s.type === 'boolean');
});
