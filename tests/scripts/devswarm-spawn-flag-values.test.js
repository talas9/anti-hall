'use strict';
// 0.112: `devswarm.js spawn` refuses a value-taking create option whose value is
// really the next option. `spawn b -s main -t -p "brief"` used to make "-p" the
// title and drop the brief silently. The refusal happens before any fetch or
// `hivecontrol workspace create` call.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-spawn-flags-')));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const calls = [];
  const run = (opts) => { calls.push(opts.args); return { ok: true, raw: '{}' }; };
  return { base, home, cwd, calls, run, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function spawn(f, argv, env) {
  return cli.run(['spawn'].concat(argv), { home: f.home, backend: 'journal', env: env || {}, cwd: f.cwd, io: { run: f.run } }).result;
}

const REFUSED = [
  [['b', '-s', 'main', '-t', '-p', 'brief'], /-t\/--title got "-p"/],
  [['b', '--title', '--prompt', 'brief'], /-t\/--title got "--prompt"/],
  [['b', '--title=-p', '-p', 'brief'], /-t\/--title got "-p"/],
  [['b', '-s', '-t', 'T'], /-s\/--source got "-t"/],
  [['b', '-a', '--remote'], /-a\/--agent got "--remote"/],
  [['b', '-p', '-t', 'T'], /-p\/--prompt got "-t"/],
  [['b', '-p', 'brief', '-t'], /-t\/--title needs a value/],
];

for (const [argv, re] of REFUSED) {
  test('spawn refuses an option-shaped or missing flag value: ' + argv.join(' '), () => {
    const f = fixture();
    try {
      const r = spawn(f, argv);
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(r.created, false);
      assert.match(r.error, re);
      assert.strictEqual(f.calls.length, 0, 'no hivecontrol call may run: ' + JSON.stringify(f.calls));
    } finally { f.cleanup(); }
  });
}

test('spawn accepts well-formed values, including a brief that starts with a markdown bullet', () => {
  const f = fixture();
  try {
    const r = spawn(f, ['b', '-s', 'main', '-t', 'My title', '-p', '- fix the thing\n- and this']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(f.calls[0], ['workspace', 'create', 'b', '-s', 'main', '-t', 'My title', '-p', '- fix the thing\n- and this']);
  } finally { f.cleanup(); }
});

test('devswarm.spawnStrictFlagValues=false turns the check off (old pass-through)', () => {
  const f = fixture();
  try {
    const r = spawn(f, ['b', '-t', '-p', 'brief'], { ANTIHALL_DEVSWARM_SPAWN_STRICT_FLAG_VALUES: 'false' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(f.calls[0], ['workspace', 'create', 'b', '-t', '-p', 'brief']);
  } finally { f.cleanup(); }
});
