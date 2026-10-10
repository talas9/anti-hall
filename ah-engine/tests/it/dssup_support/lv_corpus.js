'use strict';
// Golden corpus of the liveness sweep: builds a SCRATCH home of N workspaces, every one a random combination of the states the
// verdict depends on, with Node's OWN store code (devswarm-store.js, reader-cursors.js) writing the stores.
//   usage: node lv_corpus.js <home> <scratchRoot> <seed> <count> <nowMs> <livePid> [big]
// Prints a manifest {ids, selfIds, kinds} as JSON. Deterministic for one seed.
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const identity = require(path.join(plugin, 'companion', 'lib', 'identity.js'));
const rc = require(path.join(plugin, 'companion', 'lib', 'reader-cursors.js'));
const inst = require(path.join(plugin, 'companion', 'install-devswarm-ingest.js'));
const [home, root, seedArg, countArg, nowArg, livePidArg, bigArg] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const NOW = Number(nowArg);
const COUNT = Number(countArg);
const BIG = bigArg === 'big';
const LIVE_PID = Number(livePidArg);
let s = Number(seedArg) >>> 0;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const MIN = 60 * 1000;
const H = 60 * MIN;
const ds = path.join(home, '.anti-hall', 'devswarm');
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const put = (p, text, mtimeMs) => {
  mk(path.dirname(p));
  fs.writeFileSync(p, text);
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};
const env0 = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (args, cwd, date) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd, env: Object.assign({}, env0, date ? { GIT_AUTHOR_DATE: `${Math.floor(date / 1000)} +0000`, GIT_COMMITTER_DATE: `${Math.floor(date / 1000)} +0000` } : {}), stdio: 'pipe' });

// two projects, each a main checkout with an old base commit
mk(root);
const repos = [];
for (const name of ['alpha', 'beta']) {
  const main = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(root), name + '-')));
  git(['init', '-q'], main);
  git(['commit', '-q', '--allow-empty', '-m', 'base'], main, NOW - 10 * H);
  const ctx = identity.resolveContext(main, { memo: false });
  repos.push({ name, main, repoKey: ctx.repoKey, selfId: inst.primaryWorkspaceId(main), store: null, next: 0 });
}
for (const r of repos) r.store = store.openStore({ home, hash: r.repoKey });

const kinds = [];
const ids = [];
let nStores = 0;
for (let i = 0; i < COUNT; i++) {
  const id = (i % 53 === 7 ? 'ws.dot-' : 'ws-') + i;
  const k = {
    where: pick(['git', 'git', 'git', 'git', 'plain', 'gone']),
    repo: pick(repos),
    commit: pick(['base', 'base', 'recent', 'mid']),
    transcript: pick(['none', 'recent', 'mid', 'old', 'old']),
    beat: pick(['none', 'none', 'fresh', 'old', 'old', 'future', 'torn-old', 'torn-fresh', 'str-ts']),
    prev: pick(['none', 'none', 'none', 'alive', 'stale', 'nudged-in', 'nudged-out', 'nudged-adv', 'esc-dead', 'esc-alive', 'corrupt', 'array', 'esc-bare']),
    inbox: pick(['none', 'missing', 'lines', 'lines', 'read']),
    cursor: pick(['num', 'json', 'badjson', 'none', 'neg']),
    mail: pick(['none', 'self', 'others', 'others', 'mixed', 'old-others', 'many']),
    floors: pick(['yes', 'yes', 'yes', 'yes', 'no']),
    sess: pick(['live', 'dead', 'none', 'reused']),
    weird: pick(['', '', '', '', '', '', 'wt-num', 'sess-num', 'inbox-num', 'unsafe', 'nosess', 'nowt']),
    jev: rnd() < 0.04,
    plan: rnd() < 0.04,
    reg: pick(['recent', 'old', 'old']),
  };
  const sid = `${i}0000000-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`;
  let wt;
  if (k.where === 'git') {
    wt = path.join(path.dirname(k.repo.main), `${path.basename(k.repo.main)}-wt-${i}`);
    git(['worktree', 'add', '-q', '-b', `b${i}`, wt], k.repo.main, null);
    wt = fs.realpathSync(wt);
    if (k.commit === 'recent') git(['commit', '-q', '--allow-empty', '-m', 'w'], wt, NOW - 2 * MIN);
    if (k.commit === 'mid') git(['commit', '-q', '--allow-empty', '-m', 'w'], wt, NOW - 30 * MIN);
  } else if (k.where === 'plain') {
    wt = path.join(fs.realpathSync(root), `plain-${i}${i % 3 === 0 ? ':x.y' : ''}`);
    mk(wt);
  } else {
    wt = path.join(fs.realpathSync(root), `gone-${i}`);
  }
  // transcript
  const enc = String(wt).replace(/[/\\:.]/g, '-');
  const tm = { recent: NOW - 20 * 1000, mid: NOW - 10 * MIN, old: NOW - 3 * H }[k.transcript];
  if (tm) put(path.join(home, '.claude', 'projects', enc, `${sid}.jsonl`), '{}\n', tm);
  // heartbeat
  const hbp = path.join(ds, 'heartbeats', `${id}.json`);
  if (k.beat === 'fresh') put(hbp, JSON.stringify({ id, ts: NOW - 1 * MIN }), NOW - 1 * MIN);
  if (k.beat === 'old') put(hbp, JSON.stringify({ id, ts: NOW - 2 * H }), NOW - 2 * H);
  if (k.beat === 'future') put(hbp, JSON.stringify({ id, ts: NOW + 5 * MIN }), NOW + 5 * MIN);
  if (k.beat === 'torn-old') put(hbp, '{"id":', NOW - 2 * H);
  if (k.beat === 'torn-fresh') put(hbp, '{"id":', NOW - 3 * MIN);
  if (k.beat === 'str-ts') put(hbp, JSON.stringify({ id, ts: 'now' }), NOW - 4 * MIN);
  // mailbox: NDJSON inbox + cursor file
  const inboxPath = path.join(ds, 'inbox', `${id}.ndjson`);
  const cursorPath = path.join(ds, 'cursors', `${id}.json`);
  const nLines = k.inbox === 'lines' || k.inbox === 'read' ? 1 + Math.floor(rnd() * 4) : 0;
  if (k.inbox !== 'none' && k.inbox !== 'missing') {
    const lines = [];
    for (let j = 0; j < nLines; j++) lines.push(JSON.stringify({ from: 'x', body: `m${j}`, ts: NOW - (j + 1) * 7 * MIN }));
    put(inboxPath, lines.length ? lines.join('\n') + '\n' : '');
  }
  const cur = k.inbox === 'read' ? nLines : Math.floor(rnd() * 2);
  if (k.cursor === 'num') put(cursorPath, String(cur));
  if (k.cursor === 'json') put(cursorPath, JSON.stringify({ line: cur }));
  if (k.cursor === 'badjson') put(cursorPath, '{not json');
  if (k.cursor === 'neg') put(cursorPath, '-3');
  // descriptor
  const desc = { id, worktreePath: wt, sessionId: sid, inboxPath: k.inbox === 'none' ? null : inboxPath, cursorPath: k.cursor === 'none' ? null : cursorPath, nudgeCommand: null };
  if (k.weird === 'wt-num') desc.worktreePath = 12345;
  if (k.weird === 'sess-num') desc.sessionId = 424242;
  if (k.weird === 'inbox-num') desc.inboxPath = 7;
  if (k.weird === 'nosess') delete desc.sessionId;
  if (k.weird === 'nowt') delete desc.worktreePath;
  if (k.weird === 'unsafe') desc.id = '../evil';
  put(path.join(ds, 'workspaces', `${id}.json`), JSON.stringify(desc), k.reg === 'recent' ? NOW - 5 * MIN : NOW - 8 * H);
  // store partition
  if (k.where === 'git') {
    const st = k.repo.store;
    const nMail = { none: 0, self: 2, others: 3, mixed: 4, 'old-others': 2, many: BIG ? 3000 : 40 }[k.mail];
    for (let j = 0; j < nMail; j++) {
      const from = k.mail === 'self' ? k.repo.selfId : (k.mail === 'mixed' && j % 2 ? k.repo.selfId : (j % 5 === 4 ? null : `peer-${j % 3}`));
      const ts = k.mail === 'old-others' ? NOW - 2 * H - j * 1000 : NOW - 3 * MIN - j * 1000;
      const m = { from, to: id, type: 'direct', message: `msg ${i}.${j}`, timestamp: ts, urgency: 'normal', needsReply: false };
      store.appendMeshMessage(st, Object.assign({}, m, { hash: store.meshMessageHash(m) }));
    }
    if (nMail > 0 || k.floors === 'yes') {
      st.upsertRegistry({ id, worktreePath: wt, sessionId: sid, inboxPath: desc.inboxPath, cursorPath: desc.cursorPath, nudgeCommand: null });
    }
    if (k.floors === 'yes') {
      try { rc.importLegacy(st, { partition: id, home, cursorPath: k.cursor === 'none' ? null : cursorPath, harnesses: [], now: NOW }); } catch (_) { /* leave without floors */ }
    }
    nStores++;
  }
  // previous verdict
  const vp = path.join(ds, 'liveness', `${id}.json`);
  const pv = {
    alive: { status: 'alive', lastOutboundTs: NOW - 4 * H, staleSince: null, nudgeAttempts: 0, nudgedAt: null, pending: false, notDraining: false, oldestUnreadAgeMs: null },
    stale: { status: 'stale', lastOutboundTs: NOW - 4 * H, staleSince: NOW - 3 * H, nudgeAttempts: 1, nudgedAt: NOW - 2 * H, pending: true, notDraining: true, oldestUnreadAgeMs: 99999.5 },
    'nudged-in': { status: 'nudged', lastOutboundTs: NOW - 4 * H, staleSince: NOW - 3 * H, nudgeAttempts: 2, nudgedAt: NOW - 30 * 1000, pending: true, notDraining: false, oldestUnreadAgeMs: 120000 },
    'nudged-out': { status: 'nudged', lastOutboundTs: NOW - 4 * H, staleSince: NOW - 3 * H, nudgeAttempts: 2, nudgedAt: NOW - 20 * MIN, pending: true, notDraining: true, oldestUnreadAgeMs: 1500000.25 },
    'nudged-adv': { status: 'nudged', lastOutboundTs: NOW - 4 * H, staleSince: NOW - 3 * H, nudgeAttempts: 1, nudgedAt: NOW - 8 * H, pending: true, notDraining: true, oldestUnreadAgeMs: 5 },
    'esc-dead': { status: 'escalated', lastOutboundTs: NOW - 5 * H, staleSince: NOW - 4 * H, nudgeAttempts: 2, nudgedAt: NOW - 3 * H, pending: true, notDraining: true, oldestUnreadAgeMs: 12345678.5, recoveries: 1, lastNudgeError: null },
    'esc-alive': { status: 'escalated', lastOutboundTs: NOW - 5 * H, staleSince: NOW - 4 * H, nudgeAttempts: 2, nudgedAt: NOW - 3 * H, pending: false, notDraining: false },
    'esc-bare': { status: 'escalated' },
  }[k.prev];
  if (pv) put(vp, JSON.stringify(pv));
  if (k.prev === 'corrupt') put(vp, '{"status":"escalated"');
  if (k.prev === 'array') put(vp, '[1,2,3]');
  // sessions: a record naming this session and a live (this process' parent) or dead pid
  if (k.sess !== 'none') {
    const pid = k.sess === 'dead' ? 2147480000 + (i % 1000) : LIVE_PID;
    // 'reused': the record is older than the process now holding the pid, so it is a recycled pid, not the session
    put(path.join(home, '.claude', 'sessions', `${pid}-${i}.json`), JSON.stringify({ pid, sessionId: sid, startedAt: NOW - H }), k.sess === 'reused' ? 1577836800000 : NOW + 60 * 1000);
  }
  if (k.jev) {
    const pf = path.join(home, '.anti-hall', 'state', 'jev-triage-pending.json');
    let cur2 = {}; try { cur2 = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) {}
    cur2[`primary\u0001${id}`] = { kind: 'blocker', ts: NOW - MIN };
    put(pf, JSON.stringify(cur2));
  }
  if (k.plan) put(path.join(ds, 'plans', `${id}.json`), JSON.stringify({ v: 1, key: id, id, worktreePath: wt, created_at: NOW - H, steps: [{ n: 1, text: 'a', status: 'doing', ts: NOW - 5 * MIN, started_at: NOW - 5 * MIN }] }));
  kinds.push(Object.assign({ id: desc.id }, k, { repo: k.repo.name }));
  ids.push(desc.id);
}
for (const r of repos) r.store.close();
process.stdout.write(JSON.stringify({ ids, kinds, selfIds: repos.map((r) => r.selfId), stores: nStores }));
