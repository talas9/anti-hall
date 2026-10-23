// Demo boot: picks the tier bundle, loads config + sample data, and supplies the caller side of the action menu.
const q = new URLSearchParams(location.search);
const tier = q.get('tier') === 'lite' ? 'lite' : 'full';
const mod = await import(`./${tier}/ah_web_graph.js`);
await mod.default();
const cfgText = await (await fetch('config.json')).text();
const sets = { agents: 'force', topology: 'force', hooks: 'layered' };
const kindActions = {
  primary: ['Send message', 'Nudge', ['Stop agent', 1]], subagent: ['Send message', 'Nudge', ['Stop agent', 1]],
  workspace: ['Open', ['Archive workspace', 1]], codex: ['Send message', ['Stop agent', 1]], idle: ['Resume', ['Forget session', 1]],
  client: ['Show sessions', ['Disconnect', 1]], engine: ['Show health', ['Restart engine', 1]], store: ['Inspect', ['Compact', 1]],
  service: ['Ping'], event: ['Show recent fires'], rule: ['Open rule', 'Disable rule', ['Delete rule', 1]],
  check: ['Open check', 'Dry run'], effect: ['Open effect', 'Test fire'], jev: ['Open judge', 'Show report'],
};
const handles = {}, data = {};
async function mountOne(name) {
  if (handles[name]) return;
  const text = await (await fetch(`${name}.json`)).text();
  data[name] = JSON.parse(text);
  const byId = Object.fromEntries(data[name].nodes.map((n) => [n.id, n]));
  const hooks = {
    actions: (id) => JSON.stringify((kindActions[byId[id]?.kind] || []).map((a, i) => {
      const [label, destructive] = Array.isArray(a) ? a : [a, 0];
      return { id: label.toLowerCase().replace(/\W+/g, '-'), label, destructive: !!destructive, enabled: !(label === 'Resume' && byId[id].status === 'running') && !(label === 'Disable rule' && byId[id].status === 'off'), note: destructive ? '' : (label === 'Resume' ? 'Only for idle sessions' : '') };
    })),
    onAction: (node, action, done) => { console.log('action', name, node, action); setTimeout(() => done(Math.random() > 0.2), 900); },
    panel: (id) => { const n = byId[id]; return n ? `${n.label}\nkind: ${n.kind}\nstatus: ${n.status}\n${n.sub}\n\nin: ${data[name].edges.filter((e) => e.to === id).length}  out: ${data[name].edges.filter((e) => e.from === id).length}` : ''; },
  };
  handles[name] = mod.mount_graph(document.getElementById(`g-${name}`), cfgText, text, tier, sets[name], hooks);
}
const tabs = [...document.querySelectorAll('[data-tab]')];
function show(name) {
  tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tab === name)));
  document.querySelectorAll('section.graph').forEach((s) => (s.hidden = s.id !== `s-${name}`));
  mountOne(name);
}
tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
let trace = null;
document.getElementById('trace').addEventListener('click', async () => {
  await mountOne('hooks');
  if (trace) { clearInterval(trace); trace = null; handles.hooks.setHighlight('[]'); return; }
  const paths = [['ev1', 'ru0', 'ck0', 'ef0'], ['ev1', 'ru4', 'ck4', 'ef4'], ['ev3', 'ru8', 'ck8', 'ef2'], ['ev0', 'ru10', 'ck10', 'ef6']];
  let i = 0;
  const step = () => handles.hooks.setHighlight(JSON.stringify(paths[i++ % paths.length]));
  step(); trace = setInterval(step, 1500);
});
document.getElementById('tier').textContent = tier;
show(q.get('view') || 'agents');

// Screenshot/QA hook: ?demo=menu:<nodeId> opens that node's context menu; ?demo=confirm:<nodeId> then picks its destructive action.
const demo = q.get('demo');
if (demo) {
  const [what, id] = demo.split(':');
  setTimeout(() => {
    const card = document.querySelector(`.ahg-node[data-id="${id}"]`);
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right, clientY: r.top }));
    if (what === 'confirm') setTimeout(() => document.querySelector('.ahg-menu button.destructive')?.click(), 300);
  }, 1500);
}
