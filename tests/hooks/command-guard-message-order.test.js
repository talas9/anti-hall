'use strict';
// command-guard.js — the heavy-command block message leads with the path that
// works (scratchpad script + run_in_background) in EVERY variant, and the DECISION
// is unchanged. ROWS is the pre-change exit-code table (captured at 0.122.0) for
// 49 commands x {none, DevSwarm child, Primary, Primary in a no-workspace repo} x
// {foreground, run_in_background}; the message rewrite must not move a single cell.
// The child gets TMPDIR=os.tmpdir() so the scratch fixtures sit inside the hook's tmp
// roots on EVERY platform (testHook's env is {PATH,HOME}, so a macOS child fell back to
// /tmp while the fixtures lived under /var/folders; Linux has /tmp for both). Hence the
// `@SP@` rows: a background scratch script is allowed ('2' foreground, '0' background).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ENVS = [
  {},
  { DEVSWARM_REPO_ID: 'r', DEVSWARM_SOURCE_BRANCH: 'f/y' },
  { DEVSWARM_REPO_ID: 'r' },
  { DEVSWARM_REPO_ID: 'r' },
];
const FIRST_LINE = 'Do instead: delegate to ';

// Each row: [command, statuses] ordered env0-fg, env0-bg, env1-fg, env1-bg, ...
const ROWS = [
  ["cd repo && git pull -q --ff-only && git log --oneline -1 && nice -n 10 python3 -m pytest tests/tools -q 2>&1 | tail -3", '22222222'],
  ["npm run build", '22222222'],
  ["npm test", '22222222'],
  ["npm install", '22222222'],
  ["yarn build", '22222222'],
  ["pnpm test", '22222222'],
  ["docker compose up", '22222222'],
  ["docker build .", '22222222'],
  ["cargo build", '22222222'],
  ["cargo test", '22222222'],
  ["make", '22222222'],
  ["make test", '22222222'],
  ["gradle build", '22222222'],
  ["mvn package", '22222222'],
  ["pytest", '22222222'],
  ["python3 -m pytest tests", '00000000'],
  ["python3 -m pytest tests/tools -q", '00000000'],
  ["pip install x", '22222222'],
  ["git pull origin main", '22222222'],
  ["git fetch --prune origin", '22222222'],
  ["git push origin main", '22222222'],
  ["terraform apply", '22222222'],
  ["kubectl apply -f x.yaml", '22222222'],
  ["flutter build apk", '22222222'],
  ["xcodebuild build", '00000000'],
  ["go test ./...", '22222222'],
  ["ls", '00000000'],
  ["git status", '00000000'],
  ["git log --oneline -5", '00000000'],
  ["echo hi", '00000000'],
  ["cat package.json", '00000000'],
  ["pwd", '00000000'],
  ["node -v", '00000000'],
  ["grep -rn foo src", '00000000'],
  ["git diff --stat", '00000000'],
  ["python3 -m pytest -q one.py | tail -3", '00000000'],
  ["node --test t.test.js | tail -5", '00000000'],
  ["node --test t.test.js", '22222222'],
  ["npx vitest run t.test.js | tail -3", '00000022'],
  ["ctest -R foo | tail -3", '00000000'],
  ["npm run build --dry-run", '22222222'],
  ["git clone --depth 1 https://example.com/x.git /tmp/x", '22222222'],
  ["python3 @SP@/a.py --check", '20202020'],
  ["python3 @SP@/a.py", '20202020'],
  ["node @SP@/a.js && npm test", '22222222'],
  ["cd repo; python3 -m pytest -q one.py | tail -2", '00000000'],
  ["cd repo && python3 -m pytest -q one.py | tail -2", '00000000'],
  ["gcc -fsyntax-only a.c", '00000000'],
  ["npm run lint -- --check", '22222222'],
];

const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cgmo-plain-'));
const noWs = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cgmo-nows-'));
fs.writeFileSync(path.join(noWs, 'CLAUDE.md'), '# Rules\n- **NO WORKSPACES FOR REAL WORK.** Use subagents.\n');
const sp = path.join(plain, 'scratch');
fs.mkdirSync(sp);
fs.writeFileSync(path.join(sp, 'a.py'), 'print(1)\n');
fs.writeFileSync(path.join(sp, 'a.js'), '1\n');
fs.writeFileSync(path.join(plain, 't.test.js'), '');
fs.writeFileSync(path.join(plain, 'one.py'), '');

function run(command, envIdx, bg) {
  const h = makeHome();
  try {
    const toolInput = { command: command.split('@SP@').join(sp) };
    if (bg) toolInput.run_in_background = true;
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, session_id: 't', cwd: envIdx === 3 ? noWs : plain };
    return testHook(HOOK, payload, { home: h.home, env: Object.assign({ TMPDIR: os.tmpdir() }, COORD, ENVS[envIdx]) });
  } finally { h.cleanup(); }
}

test('differential: exit code of every corpus cell is identical to the pre-change table', () => {
  assert.ok(ROWS.length >= 40, 'corpus size');
  const wrong = [];
  for (const [c, want] of ROWS) {
    for (let i = 0; i < 8; i++) {
      const r = run(c, i >> 1, i & 1);
      if (String(r.status) !== want[i]) wrong.push(`${c} [env ${i >> 1} bg ${i & 1}]: ${r.status} != ${want[i]}`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});

test('every blocked variant leads with the working path, before the rule text', () => {
  const REPORTED = ROWS[0][0];
  for (let env = 0; env < 4; env++) {
    for (const c of [REPORTED, 'npm run build']) {
      const r = run(c, env, false);
      assert.strictEqual(r.status, 2, `${c} env ${env}`);
      const lines = r.json.reason.split('\n');
      assert.ok(lines[2].startsWith(FIRST_LINE) || /^Do instead: .*delegate to /.test(lines[2]), `env ${env}: ${r.json.reason.slice(0, 300)}`);
      assert.match(lines[3], /^Allowed here: .*scratchpad script/, `env ${env}`);
      assert.match(r.json.reason, /piped to tail\/head\/wc\/grep -c/);
    }
  }
});

test('the reported verify chain keeps its block and the message stays short', () => {
  const r = run(ROWS[0][0], 0, false);
  assert.strictEqual(r.status, 2);
  assert.ok(r.json.reason.length <= 1200, String(r.json.reason.length));
});
