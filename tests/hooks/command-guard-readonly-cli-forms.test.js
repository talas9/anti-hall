'use strict';
// command-guard.js — residual read-only false blocks (fp-triage 2026-10 row 5):
//   (a) `firebase --version` (a version query of a HEAVY_VERB CLI),
//   (b) gcloud describe/list/read with SEPARATED values for a closed list of
//       read flags (`--project foo`, `--limit 5`),
//   (c) a plain push chain followed by read-only verification
//       (`git ls-remote <remote> [ref]`, `git rev-parse <ref>`), including a
//       `| tail -N` filter on the push in the middle of the chain.
// Everything state-changing must stay exactly as blocked as before.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ro-repo-'));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  cp.spawnSync('git', ['-C', dir, 'add', 'f.txt']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  cp.spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);
  return dir;
}

const REPO = makeGitRepo();
process.on('exit', () => { try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

function run(command) {
  const h = makeHome();
  try {
    return testHook('command-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 't', cwd: REPO,
    }, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally { h.cleanup(); }
}

const ALLOW = [
  'firebase --version',
  'firebase -V',
  'firebase --version 2>/dev/null',
  'firebase --version | tail -1',
  'firebase --version | tail -n +1',
  'firebase --version | wc -l',
  'gcloud functions list --project foo | grep -c fn',
  'gcloud functions list --project foo | grep -m 3 fn',
  'gcloud functions describe fn --project foo --format=json | head -20',
  'gcloud functions describe fnA --project foo --region us-central1',
  'gcloud run services describe svc --region us-central1 --project foo --format="value(status.url)"',
  'gcloud run services list --project foo --limit 5 --format=json',
  'gcloud logging read \'severity>=ERROR\' --project foo --limit 10 --freshness 1h',
  'gcloud functions list --project foo 2>&1 | tail -2',
  'git push origin main; git ls-remote origin main',
  'git push origin main && git rev-parse HEAD',
  'git push origin main 2>&1 | tail -3; git rev-parse HEAD; git ls-remote origin refs/heads/main',
  'git push -q origin main && git ls-remote --heads origin main',
  'git push origin main | tail -2 && git status',
  // (d) a gcloud read INSIDE a chain keeps its space-separated read flags (field: friendship verify, 2026-10-07)
  "git fetch -q origin main && git rev-parse origin/main && gcloud run services describe friendship --project sky-crew-uc --region us-central1 --format='value(status.latestReadyRevisionName,status.traffic)' 2>&1 | head -2",
  'git rev-parse HEAD && gcloud functions describe fn --project foo --region us-central1',
  'gcloud functions list --project foo | head -3; git rev-parse HEAD',
];

const BLOCK = [
  // (a) only a bare version query is exempt
  'firebase deploy --project foo',
  'firebase --version && firebase deploy --only functions',
  'firebase --version --project foo',
  'firebase help deploy',
  // whole-command validation: a read form never approves what rides along
  'firebase --version $(rm -f /tmp/x)',
  'firebase --version $(id)',
  'firebase --version `id`',
  'firebase --version | sh',
  'firebase --version 2>&1 | sh',
  'firebase --version 2>&1 | tail -1; rm -rf x',
  'firebase --version && rm -rf x',
  'firebase --version || rm -rf x',
  'firebase --version > /tmp/x',
  'which firebase; firebase --version 2>&1',
  'gcloud functions describe fn --project foo --format=json | sh',
  'gcloud functions describe fn --project foo 2>&1 | tail -2 | sh',
  'gcloud functions describe fn --project foo\nrm -rf x',
  'gcloud functions describe fn --project foo | xargs rm',
  'gcloud functions describe fn --project foo | jq .',
  'gcloud functions describe fn --project foo $(id)',
  'gcloud functions describe fn --project foo & rm -rf x',
  // closed sink grammar: no file operands, no unknown flags
  'firebase --version | head /etc/passwd',
  'firebase --version | tail /etc/passwd',
  'firebase --version | wc /etc/passwd',
  'firebase --version | grep -m 1 X /etc/passwd',
  'firebase --version | grep -c X /etc/passwd',
  'gcloud functions describe fn --project foo | head /etc/passwd',
  'gcloud functions describe fn --project foo | grep -c X /etc/passwd',
  'gcloud functions describe fn --project foo | tail -n +1 --pid=123',
  'gcloud functions describe fn --project foo | wc --files0-from=/etc/passwd',
  'gcloud functions describe fn --project foo | grep -c -f /etc/passwd',
  // (b) mutating verbs / unlisted separated flags / separated verb-lookalikes
  'gcloud functions deploy x --project foo',
  'gcloud functions delete x --project foo',
  'gcloud functions describe x --project foo; gcloud functions delete x',
  'gcloud compute instances reset vm --zone list',
  'gcloud functions describe x --impersonate-service-account sa@p.iam.gserviceaccount.com',
  'gcloud functions describe x --project',
  'gcloud functions describe x --project --region r',
  'gcloud functions describe x --project foo > out.txt',
  'gcloud secrets versions access latest --secret s --project foo',
  // (c) pushes that are not plain stay blocked, as do foreign/URL remotes and
  // read-only members BEFORE the push
  'git push --force origin main; git ls-remote origin main',
  'git push origin other-branch; git ls-remote origin other-branch',
  'git push origin main; git ls-remote https://example.invalid/evil.git',
  'git push origin main; git ls-remote --upload-pack=evil origin',
  'git push origin main; git rev-parse --exec-path',
  'git ls-remote origin main && git push origin main',
  'git push origin main; git ls-remote origin main; npm run deploy',
  'git push origin main; git ls-remote origin main > /tmp/x',
  'git pull --ff-only; git ls-remote origin main',
  // (d) the chained form never widens the read grammar
  'git rev-parse HEAD && gcloud functions deploy x --project foo --region r',
  'git rev-parse HEAD && gcloud functions describe x --impersonate-service-account sa@p.iam.gserviceaccount.com',
  'git rev-parse HEAD && gcloud functions describe x --project',
  'git rev-parse HEAD && gcloud functions describe x --project foo > out.txt',
  'git rev-parse HEAD && gcloud functions describe x --project foo $(id)',
  'git rev-parse HEAD && gcloud compute instances reset vm --zone list',
];

for (const c of ALLOW) {
  test('allows: ' + c, () => {
    const r = run(c);
    assert.strictEqual(r.status, 0, 'expected allow, got ' + r.status + ' ' + String(r.stdout || r.stderr).slice(0, 160));
  });
}
for (const c of BLOCK) {
  test('still blocks: ' + c, () => {
    const r = run(c);
    assert.notStrictEqual(r.status, 0, 'expected block, got allow');
  });
}
