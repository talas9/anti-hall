#!/usr/bin/env node
// Test-only stand-in for Claude Code's hook runner: reads settings.json hooks + the installed plugin's hooks.json from $HOME,
// (enabled plugins via the claude CLI) runs every matching command the way the host does (sh -c, payload on stdin, CLAUDE_PLUGIN_ROOT set for plugin hooks).
// usage: mini-host.js <Event> <payload.json>   prints one JSON object: {blocked, hooks:[{src,cmd,rc,out,err}]}
const fs = require('fs'), cp = require('child_process'), path = require('path');
const HOME = process.env.HOME, [ev, pf] = process.argv.slice(2);
const payload = fs.readFileSync(pf, 'utf8'); const tool = JSON.parse(payload).tool_name || '';
const matches = (m) => !m || m === '*' || (/^[\w ,|-]+$/.test(m) ? m.split(/[|,]/).map(s => s.trim()).includes(tool) : new RegExp(m).test(tool));
const jobs = [];
const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'settings.json'), 'utf8'));
for (const g of (settings.hooks || {})[ev] || []) if (matches(g.matcher)) for (const h of g.hooks) jobs.push({ src: 'settings', cmd: h.command, timeout: h.timeout || 600 });
// enabled plugins come from the real CLI (`claude plugin list --json`), the same registry the host reads
const lp = cp.spawnSync(process.env.AH_LIVE_CLAUDE || 'claude', ['plugin', 'list', '--json'], { encoding: 'utf8', env: process.env });
for (const inst of JSON.parse(lp.stdout || '[]').filter(p => p.enabled && /^anti-hall@/.test(p.id))) {
  const hj = JSON.parse(fs.readFileSync(path.join(inst.installPath, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const g of hj[ev] || []) if (matches(g.matcher)) for (const h of g.hooks) jobs.push({ src: 'plugin', cmd: h.command, timeout: h.timeout || 600, root: inst.installPath });
}
const hooks = jobs.map(j => {
  const env = { ...process.env, HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || '' };
  if (j.root) env.CLAUDE_PLUGIN_ROOT = j.root;
  const r = cp.spawnSync('/bin/sh', ['-c', j.cmd], { input: payload, env, encoding: 'utf8', timeout: j.timeout * 1000 });
  return { src: j.src, cmd: j.cmd.replace(/^.*\/(hooks\/)?/, '').slice(0, 60), rc: r.status === null ? 'sig' : r.status, out: r.stdout, err: r.stderr };
});
const blocked = hooks.some(h => h.rc === 2 || /"decision"\s*:\s*"block"|"permissionDecision"\s*:\s*"deny"/.test(h.out || ''));
console.log(JSON.stringify({ blocked, hooks }));
