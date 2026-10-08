#!/bin/sh
# node-shadow.sh - the REVERSE shadow: the engine decides (live), Node runs beside it as a silent witness.
#
#   node-shadow.sh <Event>          the user-level hook (registered for every event): reads the payload, returns at once, empty,
#                                   exit 0 (it never decides). A detached low-priority worker then runs the same-version Node hook
#                                   commands for that event (live plugin's hooks/ah-fallback.list) in a scratch HOME and logs one line
#                                   per hook to ~/.anti-hall/ah-node-shadow/node-shadow.ndjson (event, hook id, exit, decision, ms).
#   node-shadow.sh --install [--root PLUGIN_ROOT]   copy this script to ~/.anti-hall/ah-node-shadow/ and add the hook entries to
#                                   settings.json (backup first). Root defaults to the installed anti-hall@anti-hall-engine-live.
#   node-shadow.sh --uninstall      remove only our settings.json entries (logs stay)
#   node-shadow.sh --rebaseline     restart the comparison window NOW (engine counters + Node log cut-off). go-live runs it the moment the engine
#                                   becomes the decider: Node rows from before that moment are not comparable (Node was the decider, the engine only counted)
#   node-shadow.sh --status         entries, log size, last call
#   node-shadow.sh --compare [--window 7d] [--json]
#                                   join the Node log with the engine's own per-check telemetry; disagreements, engine-weaker first
# Needs: sh, node.
# GUARANTEE (a witness has NO side effects): Node hooks run in a scratch HOME (never the real one) with every credential env var removed
# (*KEY*, *TOKEN*, *SECRET*, CLAUDE_PLUGIN_OPTION_*, ANTHROPIC/AI_GATEWAY/TYPESAFE) and Jev off, so nothing can spend money. Hooks that kill
# processes, spawn detached work, write the project tree, call the network with credentials or touch DevSwarm are listed in node-shadow.skip
# (installed beside this script) and are logged as dec:"skipped", never run. Only the remaining read-only hooks run, with cwd = the real project.
# If node-shadow.skip is missing, the worker runs NOTHING.
D="$HOME/.anti-hall/ah-node-shadow"
SHADOW2="$HOME/.anti-hall/ah-engine-shadow2"
case "${1:-}" in
  --install|--uninstall|--status|--compare|--rebaseline|--worker)
    command -v node >/dev/null 2>&1 || { echo "node-shadow: node not found on PATH" >&2; exit 1; }
    AH_NODE_SHADOW_SRC=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/$(basename "$0"); export AH_NODE_SHADOW_SRC
    sed -e '1,/^: <<.__JS__.$/d' -e '$d' "$0" | node - "$@"; exit $? ;;
  ""|-*) exit 0 ;;
esac
EV=$1
[ -f "$D/root" ] || exit 0
mkdir -p "$D/q" 2>/dev/null || exit 0
F="$D/q/$$.$(date +%s)"
( umask 077; cat > "$F" ) 2>/dev/null || exit 0
if command -v setsid >/dev/null 2>&1; then
  setsid nohup nice -n 19 sh "$D/node-shadow.sh" --worker "$EV" "$F" </dev/null >/dev/null 2>&1 &
else
  ( nohup nice -n 19 sh "$D/node-shadow.sh" --worker "$EV" "$F" </dev/null >/dev/null 2>&1 & )
fi
# telemetry sync (when the shadow installer's sync is present): no shadow trigger exists in live mode, so this hook starts it, at most every 5 min
if [ -f "$SHADOW2/sync.sh" ]; then
  NOW=$(date +%s); LAST=$(cat "$D/sync.stamp" 2>/dev/null); case "$LAST" in ''|*[!0-9]*) LAST=0;; esac
  if [ $((NOW-LAST)) -ge 300 ]; then
    printf '%s' "$NOW" > "$D/sync.stamp"
    if command -v setsid >/dev/null 2>&1; then
      AH_SHADOW_D="$SHADOW2" setsid nohup nice -n 19 sh "$SHADOW2/sync.sh" --auto </dev/null >/dev/null 2>&1 &
    else
      ( AH_SHADOW_D="$SHADOW2" nohup nice -n 19 sh "$SHADOW2/sync.sh" --auto </dev/null >/dev/null 2>&1 & )
    fi
  fi
fi
exit 0
: <<'__JS__'
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const HOME = process.env.HOME, D = path.join(HOME, '.anti-hall', 'ah-node-shadow');
const CC = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SETTINGS = path.join(CC, 'settings.json');
const MARK = 'ah-node-shadow/node-shadow.sh';
const LOGF = path.join(D, 'node-shadow.ndjson');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (n, d) => { const i = args.indexOf(n); return i > 0 && args[i + 1] ? args[i + 1] : d; };
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const NO_TRIGGER = ['WorktreeCreate', 'WorktreeRemove']; // their hook IS the operation; a silent witness would break worktrees
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const ours = g => g && Array.isArray(g.hooks) && g.hooks.some(h => String(h && h.command || '').includes(MARK));
const BASEF = path.join(D, 'engine-baseline.json');
// Checks whose Node decision depends on per-session state kept under $HOME (the witness runs in a scratch HOME that starts empty), so Node
// and engine can legitimately differ: never reported as "engine weaker". task-guard: loop state last-stop-taskset-<session> (dedupe hash +
// a 5-block cap) lives in $HOME/.anti-hall; the real hook was at its cap (quiet) while the empty scratch copy blocked again.
const ENV_DEPENDENT = new Set(['task-guard']);
// engine counters {check: {n, block, defer}} for the engine's whole retained window (engine telemetry is bucketed per UTC day, so it cannot be windowed finer)
const engCounts = tel => { const o = {}; for (const h of (tel && tel.by_hook) || []) if (h.k === 'check') o[h.h] = { n: h.n, block: (h.outcomes || {}).block || 0, defer: (h.outcomes || {}).defer || 0 }; return o; };
const engCall = (a, root) => { const bin = process.env.AH_ENGINE_BIN || path.join(HOME, '.anti-hall', 'ah-engine', 'bin', 'ah-engine'); const r = cp.spawnSync(bin, a, { encoding: 'utf8', input: '', timeout: 60000, killSignal: 'SIGKILL', env: Object.assign({}, process.env, { AH_ENGINE_DIR: path.join(HOME, '.anti-hall', 'ah-engine'), AH_ENGINE_PLUGIN_ROOT: root || '' }) }); try { return JSON.parse(r.stdout); } catch (e) { return null; } };
const saveBaseline = root => { const tel = engCall(['telemetry', 'summary', '--json', '--window', '7d'], root); if (!tel) return false; try { fs.writeFileSync(BASEF + '.new', JSON.stringify({ ts: Date.now(), counts: engCounts(tel) }) + '\n'); fs.renameSync(BASEF + '.new', BASEF); return true; } catch (e) { return false; } };

if (mode === '--install') {
  let root = opt('--root', '');
  if (!root) {
    const r = cp.spawnSync(process.env.AH_LIVE_CLAUDE || 'claude', ['plugin', 'list', '--json'], { encoding: 'utf8', input: '', timeout: 45000, killSignal: 'SIGKILL' });
    let p = []; try { p = JSON.parse(r.stdout); } catch (e) { }
    const e = p.find(x => x.id === 'anti-hall@anti-hall-engine-live' && x.installPath);
    if (!e) { console.error('node-shadow: no --root given and anti-hall@anti-hall-engine-live is not installed'); process.exit(1); }
    root = e.installPath;
  }
  const hj = readJson(path.join(root, 'hooks', 'hooks.json'), null);
  if (!hj || !hj.hooks || !fs.existsSync(path.join(root, 'hooks', 'ah-fallback.list'))) { console.error('node-shadow: ' + root + ' is not an anti-hall plugin root (hooks.json / ah-fallback.list)'); process.exit(1); }
  const events = Object.keys(hj.hooks).filter(e => !NO_TRIGGER.includes(e));
  fs.mkdirSync(D, { recursive: true });
  const self = process.env.AH_NODE_SHADOW_SRC;
  if (self && path.resolve(self) !== path.join(D, 'node-shadow.sh')) { fs.copyFileSync(self, path.join(D, 'node-shadow.sh.new')); fs.chmodSync(path.join(D, 'node-shadow.sh.new'), 0o755); fs.renameSync(path.join(D, 'node-shadow.sh.new'), path.join(D, 'node-shadow.sh')); }
  const skipSrc = path.join(path.dirname(self || ''), 'node-shadow.skip');
  if (self && fs.existsSync(skipSrc) && path.resolve(skipSrc) !== path.join(D, 'node-shadow.skip')) fs.copyFileSync(skipSrc, path.join(D, 'node-shadow.skip'));
  fs.writeFileSync(path.join(D, 'root.new'), root + '\n'); fs.renameSync(path.join(D, 'root.new'), path.join(D, 'root'));
  if (!fs.existsSync(BASEF)) saveBaseline(root); // engine counters at witness start: --compare counts only what the engine saw since then
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  let s = {};
  if (fs.existsSync(SETTINGS)) {
    s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    fs.copyFileSync(SETTINGS, path.join(D, 'settings.json.bak.' + Date.now()));
  }
  s.hooks = s.hooks || {}; let added = 0;
  for (const ev of events) {
    const l = s.hooks[ev] = s.hooks[ev] || [];
    if (l.some(ours)) continue;
    l.push({ hooks: [{ type: 'command', command: '"$HOME/.anti-hall/ah-node-shadow/node-shadow.sh" ' + ev, timeout: 5 }] }); added++;
  }
  fs.writeFileSync(SETTINGS + '.ah-tmp', JSON.stringify(s, null, 2) + '\n'); fs.renameSync(SETTINGS + '.ah-tmp', SETTINGS);
  console.log('node-shadow: ' + added + ' hook entries added to ' + SETTINGS + ' (' + events.length + ' events), plugin root ' + root);
} else if (mode === '--uninstall') {
  const s = readJson(SETTINGS, null); let n = 0;
  if (s && s.hooks) {
    for (const ev of Object.keys(s.hooks)) { const k = s.hooks[ev].filter(g => !ours(g)); n += s.hooks[ev].length - k.length; if (k.length) s.hooks[ev] = k; else delete s.hooks[ev]; }
    if (!Object.keys(s.hooks).length) delete s.hooks;
    fs.writeFileSync(SETTINGS + '.ah-tmp', JSON.stringify(s, null, 2) + '\n'); fs.renameSync(SETTINGS + '.ah-tmp', SETTINGS);
  }
  try { fs.unlinkSync(path.join(D, 'root')); } catch (e) { }
  console.log('node-shadow: removed ' + n + ' entries from ' + SETTINGS + ' (log kept in ' + D + ')');
} else if (mode === '--status') {
  const s = readJson(SETTINGS, {}); let n = 0;
  for (const g of Object.values(s.hooks || {})) for (const x of g) if (ours(x)) n++;
  let lines = 0, last = '';
  try { const t = fs.readFileSync(LOGF, 'utf8').trim().split('\n'); lines = t.length; last = new Date(JSON.parse(t[t.length - 1]).ts).toISOString(); } catch (e) { }
  console.log('node-shadow: ' + n + ' settings entries; root ' + (fs.existsSync(path.join(D, 'root')) ? fs.readFileSync(path.join(D, 'root'), 'utf8').trim() : '(none)') + '; log ' + lines + ' lines' + (last ? ', last ' + last : ''));
} else if (mode === '--worker') {
  const ev = args[1], pf = args[2];
  try {
    const root = fs.readFileSync(path.join(D, 'root'), 'utf8').trim();
    const payload = fs.readFileSync(pf, 'utf8');
    let p = {}; try { p = JSON.parse(payload); } catch (e) { }
    const tool = p.tool_name || '', sid = String(p.session_id || '');
    // scratch HOME: Node hooks write their state here, never into the real home; small config files are copied once
    const sh = path.join(D, 'scratch-home');
    if (!fs.existsSync(path.join(sh, '.seeded'))) {
      fs.mkdirSync(path.join(sh, '.claude'), { recursive: true }); fs.mkdirSync(path.join(sh, '.anti-hall'), { recursive: true });
      try { for (const f of fs.readdirSync(path.join(HOME, '.anti-hall'))) { const sp = path.join(HOME, '.anti-hall', f); const st = fs.statSync(sp); if (st.isFile() && st.size < 1e6 && /\.(json|toml)$/.test(f)) fs.copyFileSync(sp, path.join(sh, '.anti-hall', f)); } } catch (e) { }
      fs.writeFileSync(path.join(sh, '.seeded'), '1');
    }
    const map = readJson(path.join(root, 'hooks', 'ah-fallback.map.json'), {});
    const idOf = {}; for (const [id, cmd] of Object.entries(map[ev] || {})) idOf[cmd] = id;
    const rows = []; let on = false;
    for (const line of fs.readFileSync(path.join(root, 'hooks', 'ah-fallback.list'), 'utf8').split('\n')) {
      if (!line || line[0] === '#') continue;
      if (line[0] === '@') { on = line.slice(1).split('\t')[0] === ev; continue; }
      if (!on) continue;
      const f = line.split('\t'); if (f.length < 2) continue;
      const matcher = f[0]; let tmo, cmd;
      if (f.length >= 3) { tmo = +f[1]; cmd = f.slice(2).join('\t'); } else { tmo = 10; cmd = f[1]; }
      if (TOOL_EVENTS.includes(ev) && matcher && matcher !== '*') { let ok = false; try { ok = new RegExp('^(?:' + matcher + ')$').test(tool); } catch (e) { } if (!ok) continue; }
      rows.push({ cmd, tmo: Math.min(tmo > 0 ? tmo : 10, 30) });
    }
    // deny-list: a missing file means run nothing. Entries are hook ids or script basenames.
    const skip = new Set(fs.readFileSync(path.join(D, 'node-shadow.skip'), 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim().split(/\s+/)[0]).filter(Boolean));
    const env = Object.assign({}, process.env, { HOME: sh, CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: path.join(sh, '.claude'), AH_ENGINE_DIR: path.join(sh, 'engine'), CLAUDE_PROJECT_DIR: p.cwd || '' });
    delete env.AH_ENGINE_PLUGIN_ROOT; delete env.AH_ENGINE_FALLBACK;
    for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^CLAUDE_PLUGIN_OPTION_|^(ANTHROPIC|AI_GATEWAY|TYPESAFE|OPENAI)/i.test(k)) delete env[k];
    env.ANTIHALL_JEV = '0';
    const cwd = p.cwd && fs.existsSync(p.cwd) ? p.cwd : sh;
    for (const r of rows) {
      const t0 = Date.now();
      const sid0 = idOf[r.cmd] || (r.cmd.match(/([\w.-]+\.js)/) || [, r.cmd.slice(0, 40)])[1];
      const base = (r.cmd.match(/([\w.-]+\.js)/) || [])[1];
      if (skip.has(sid0) || (base && skip.has(base))) { fs.appendFileSync(LOGF, JSON.stringify({ ts: t0, ev, sid, tool, id: sid0, rc: null, dec: 'skipped', ms: 0, out_bytes: 0 }) + '\n'); continue; }
      const x = cp.spawnSync('/bin/sh', ['-c', r.cmd], { input: payload, env, cwd, encoding: 'utf8', timeout: r.tmo * 1000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 });
      const ms = Date.now() - t0, out = x.stdout || '';
      let dec = 'allow';
      if (x.error || x.signal) dec = 'timeout';
      else if (x.status === 2 || /"decision"\s*:\s*"block"|"permissionDecision"\s*:\s*"deny"/.test(out)) dec = 'block';
      else if (out.trim()) dec = 'advise';
      const id = idOf[r.cmd] || (r.cmd.match(/([\w.-]+\.js)/) || [, r.cmd.slice(0, 40)])[1];
      fs.appendFileSync(LOGF, JSON.stringify({ ts: t0, ev, sid, tool, id, rc: x.status === null ? 'sig' : x.status, dec, ms, out_bytes: out.length }) + '\n');
    }
  } catch (e) { try { fs.appendFileSync(path.join(D, 'worker-errors.log'), new Date().toISOString() + ' ' + ev + ' ' + e.message + '\n'); } catch (e2) { } }
  try { fs.unlinkSync(pf); } catch (e) { }
} else if (mode === '--rebaseline') {
  // The comparison window starts when the engine became the decider for the checks. Earlier Node rows (Node decided, the engine only counted a few calls)
  // would show up as "engine weaker"; --compare drops Node rows older than the baseline and subtracts the engine counters recorded in it.
  const root = fs.existsSync(path.join(D, 'root')) ? fs.readFileSync(path.join(D, 'root'), 'utf8').trim() : '';
  if (!root) { console.error('node-shadow --rebaseline: no shadow install (' + D + '/root)'); process.exit(1); }
  if (!saveBaseline(root)) { console.error('node-shadow --rebaseline: the engine did not answer telemetry; baseline unchanged'); process.exit(1); }
  console.log('node-shadow: comparison window restarted at ' + new Date(readJson(BASEF, {}).ts).toISOString());
} else if (mode === '--compare') {
  const win = opt('--window', '7d'), asJson = args.includes('--json');
  const days = parseInt(win, 10) || 7, since = Date.now() - days * 864e5;
  const root = fs.existsSync(path.join(D, 'root')) ? fs.readFileSync(path.join(D, 'root'), 'utf8').trim() : '';
  const bin = process.env.AH_ENGINE_BIN || path.join(HOME, '.anti-hall', 'ah-engine', 'bin', 'ah-engine');
  const eng = a => engCall(a, root);
  if (!root || !fs.existsSync(bin)) { console.error('node-shadow --compare: needs the live engine (' + bin + ') and the shadow install (' + D + '/root)'); process.exit(1); }
  const cfg = eng(['config', '--json']), tel = eng(['telemetry', 'summary', '--json', '--window', days + 'd']);
  // Same window on both sides: engine counts are cumulative per UTC day, so subtract the counters recorded when the witness started.
  // Without a baseline (witness installed before this existed) the engine side is the whole retained window, which includes traffic from
  // before the witness ran: it is flagged "unaligned" and never reported as weaker; the baseline is captured now for the next run.
  let base = readJson(BASEF, null), aligned = !!(base && base.counts);
  const cur = engCounts(tel);
  if (!aligned) saveBaseline(root);
  const baseTs = aligned ? base.ts : null;
  if (!cfg || !tel) { console.error('node-shadow --compare: the engine did not answer config/telemetry'); process.exit(1); }
  // hook id -> engine check name, per event (the engine's own dispatch table)
  const checkOf = {};
  for (const [k, v] of Object.entries(cfg.settings)) { const m = k.match(/^dispatch\.hooks_claude_(\w+)$/); if (m) for (const e of v.value) checkOf[m[1] + '/' + e.id] = e.check || ''; }
  const node = {};
  const nowMs = Date.now();
  let log = []; try { log = fs.readFileSync(LOGF, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && x.dec !== 'skipped' && x.ts >= since && (!baseTs || x.ts >= baseTs)); } catch (e) { }
  const first = log.length ? Math.min(...log.map(x => x.ts)) : null;
  for (const r of log) {
    const chk = checkOf[r.ev + '/' + r.id] || '';
    const key = chk || ('node-only:' + r.id);
    const o = node[key] = node[key] || { check: chk, ids: new Set(), n: 0, block: 0, advise: 0, timeout: 0, ms: [] };
    o.ids.add(r.ev + '/' + r.id); o.n++; if (r.dec === 'block') o.block++; else if (r.dec === 'advise') o.advise++; else if (r.dec === 'timeout') o.timeout++; o.ms.push(r.ms);
  }
  // entries the operator forced back to Node ([entries."Event/id"] mode = "off" in config.toml): Node decides them by design, the engine is not weaker there
  const nodeOwned = new Set(); try { const t = fs.readFileSync(path.join(HOME, '.anti-hall', 'ah-engine', 'config.toml'), 'utf8'); for (const m of t.matchAll(/\[entries\."([^"]+)"\]\s*\n\s*mode\s*=\s*"off"/g)) nodeOwned.add(m[1]); } catch (e) { }
  const engBy = {};
  for (const [c, v] of Object.entries(cur)) { const b = (aligned && base.counts[c]) || { n: 0, block: 0, defer: 0 }; engBy[c] = { n: Math.max(0, v.n - b.n), outcomes: { block: Math.max(0, v.block - b.block), defer: Math.max(0, v.defer - b.defer) } }; }
  const rows = [];
  for (const [key, o] of Object.entries(node)) {
    const e = o.check ? (engBy[o.check] || { n: 0, outcomes: {} }) : null;
    const eb = e ? (e.outcomes.block || 0) : null, ed = e ? (e.outcomes.defer || 0) : null;
    o.ms.sort((a, b) => a - b);
    // Node is the reference. A defer means Node ran and decided, so only blocks the engine neither made nor deferred are missing.
    const owned = [...o.ids].every(i => nodeOwned.has(i.replace(/#\d+$/, '')) || nodeOwned.has(i));
    const envDep = ENV_DEPENDENT.has(o.check);
    // The engine saw nothing at all while Node ran: the engine is not active for those sessions (started before the plugin was live /
    // hooks not loaded), which says nothing about its decisions. Not "weaker".
    const inactive = !!e && aligned && e.n === 0 && o.n > 0;
    const gap = e && !owned && !envDep && !inactive && aligned ? Math.max(0, o.block - eb - ed) : 0;
    rows.push({ check: o.check || key, node_owned: owned, node_ids: [...o.ids].join(' '), node_n: o.n, node_block: o.block, node_advise: o.advise, node_timeout: o.timeout, node_p50_ms: o.ms[o.ms.length >> 1] || 0,
      engine_n: e ? e.n : null, engine_block: eb, engine_defer: ed, engine_allow: e ? (e.outcomes.allow || 0) : null, engine_weaker_by: gap, engine_inactive: inactive, witness_env_dependent: envDep, aligned, count_diff: e ? o.n - e.n : null });
  }
  rows.sort((a, b) => b.engine_weaker_by - a.engine_weaker_by || Math.abs(b.count_diff || 0) - Math.abs(a.count_diff || 0) || b.node_block - a.node_block);
  if (asJson) { console.log(JSON.stringify({ window_days: days, aligned, baseline_ts: baseTs, node_log_lines: log.length, node_log_first: first, rows }, null, 2)); process.exit(0); }
  console.log('Node-shadow vs engine, window ' + days + 'd, ' + log.length + ' Node hook runs' + (first ? ' since ' + new Date(first).toISOString() : '') + '. Engine counters are per check, counted from the witness start' + (aligned ? ' (' + new Date(baseTs).toISOString() + ', baseline delta)' : ' - NO BASELINE: engine counts include earlier traffic, weaker is not computed; baseline captured now, re-run later') + '. Units: one Node hook run vs one engine check call.');
  console.log('weaker = Node blocks the engine neither blocked nor deferred. count_diff = Node runs - engine runs (non-zero: a call one side missed, or the windows differ).\n');
  const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
  console.log([pad('check', 28), pad('weaker', 7), pad('nodeN', 7), pad('nodeBlk', 8), pad('engN', 7), pad('engBlk', 7), pad('engDef', 7), pad('cntDiff', 8), pad('nodeP50ms', 10), 'note'].join(' '));
  for (const r of rows) console.log([pad(r.check.slice(0, 27), 28), pad(r.engine_weaker_by, 7), pad(r.node_n, 7), pad(r.node_block, 8), pad(r.engine_n, 7), pad(r.engine_block, 7), pad(r.engine_defer, 7), pad(r.count_diff, 8), pad(r.node_p50_ms, 10), r.node_owned ? 'node decides (config off)' : (r.engine_n === null ? 'node-only hook' : (r.witness_env_dependent ? 'not comparable: witness scratch HOME lacks per-session state' : (r.engine_inactive ? 'ENGINE NOT ACTIVE: 0 calls (restart sessions so plugin hooks load)' : (!aligned ? 'unaligned window (no baseline yet)' : ''))))].join(' '));
  const weak = rows.filter(r => r.engine_weaker_by > 0).length;
  console.log('\n' + (weak ? weak + ' check(s) where the engine is weaker than Node (top rows).' : 'no check where the engine blocked less than Node.') + (log.length ? '' : ' (the Node log is empty: no calls yet)'));
} else { console.error('node-shadow: unknown mode ' + mode); process.exit(2); }
__JS__
