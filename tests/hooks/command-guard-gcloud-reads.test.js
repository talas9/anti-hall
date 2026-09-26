'use strict';
// command-guard.js — narrow read-only gcloud (owner-approved 2026-09-26).
// MAIN THREAD ONLY: `gcloud auth print-access-token`, a gcloud describe/list/
// get-iam-policy/read with --format=json|yaml|value(...), and the
// `T=$(gcloud auth print-access-token); curl -s … <https URL>` GET pattern run
// inline. Every other gcloud verb, curl write/upload/output flag and chained
// segment stays blocked. Setting: guards.allowGcloudReads (default true).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function run(command, opts) {
  const o = opts || {};
  const h = makeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-reads-cwd-'));
  try {
    if (o.settings) {
      fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(o.settings));
    }
    const payload = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 't', cwd, ...(o.agentId ? { agent_id: o.agentId, agent_type: 'general-purpose' } : {}),
    };
    return testHook(HOOK, payload, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const TOKEN = 'T=$(gcloud auth print-access-token); ';
const AUTH = '-H "Authorization: Bearer $T"';

const ALLOW = [
  'gcloud auth print-access-token',
  'gcloud projects get-iam-policy my-proj --format=json',
  'gcloud projects get-iam-policy my-proj --format=json | jq -r .bindings',
  'gcloud run services describe api --region us-central1 --format=yaml',
  "gcloud run services describe api --format='value(status.url)'",
  'gcloud compute instances list --format=json | head -50',
  'gcloud logging read "severity>=ERROR" --limit 20 --format=json',
  'gcloud secrets list --format json | wc -l',
  TOKEN + 'curl -s ' + AUTH + ' https://run.googleapis.com/v2/projects/p/locations/l/services | jq .',
  TOKEN + 'curl -sS ' + AUTH + ' https://example.googleapis.com/v1/x | head -40',
  'T=$(gcloud auth print-access-token) && curl -s -X GET ' + AUTH + ' https://example.googleapis.com/v1/x | jq -c .',
  TOKEN + 'curl -s --max-filesize 100000 ' + AUTH + ' https://example.googleapis.com/v1/x',
  TOKEN + 'curl -s https://example.googleapis.com/v1/x | tail -5',
];

test('gcloud-reads: allowed shapes run inline in the main thread', () => {
  const wrong = ALLOW.filter((cmd) => run(cmd).status === 2);
  assert.deepStrictEqual(wrong, [], 'expected ALLOW');
});

const BLOCK = [
  // gcloud verbs outside the read set, and every refused verb
  'gcloud projects get-iam-policy my-proj',                 // no --format
  'gcloud projects get-iam-policy my-proj --format=csv',    // format not json/yaml/value
  'gcloud auth print-access-token | cat',
  'gcloud auth print-access-token > /tmp/tok',
  'gcloud auth login',
  'gcloud config set project p',
  'gcloud projects add-iam-policy-binding p --member=user:x --role=r --format=json',
  'gcloud projects remove-iam-policy-binding p --member=user:x --role=r --format=json',
  'gcloud run deploy api --image x --format=json',
  'gcloud run services update api --format=json',
  'gcloud run services delete api --format=json',
  'gcloud compute instances create vm --format=json',
  'gcloud compute instances start vm --format=json',
  'gcloud compute instances stop vm --format=json',
  'gcloud compute ssh vm --format=json',
  'gcloud compute scp a vm:b --format=json',
  'gcloud builds submit --format=json',
  'gcloud run jobs run job --format=json',
  'gcloud sql import sql inst gs://b/f --format=json',
  'gcloud sql export sql inst gs://b/f --format=json',
  'gcloud app versions rollback --format=json',
  'gcloud container clusters patch c --format=json',
  'gcloud deployment-manager deployments apply d --format=json',
  'gcloud projects get-iam-policy p --format=json --flags-file=f.yaml',
  'gcloud projects get-iam-policy p --format=json | sh',
  'gcloud projects get-iam-policy p --format=json > out.json',
  'gcloud projects get-iam-policy p --format=json; npm test',
  'gcloud projects get-iam-policy p --format=json && gcloud run deploy api',
  'FOO=1 gcloud projects get-iam-policy p --format=json',
  'gcloud projects get-iam-policy $P --format=json',
  // curl pattern: every refused flag and shape
  TOKEN + 'curl -s -X POST ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -XPOST ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s --request DELETE ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -d a=b ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s --data a=b ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s --data-raw a ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s --data-binary @f ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -F f=@x ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -T f ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s --upload-file f ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -o out ' + AUTH + ' https://x.googleapis.com/v1/y',
  TOKEN + 'curl -s -O ' + AUTH + ' https://x.googleapis.com/v1/y',
  TOKEN + 'curl -s --output out ' + AUTH + ' https://x.googleapis.com/v1/y',
  TOKEN + 'curl -s -H @headers.txt https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl -s -K cfg ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'curl ' + AUTH + ' https://x.googleapis.com/v1/y | jq .',               // not silent
  TOKEN + 'curl -s ' + AUTH + ' http://x.googleapis.com/v1/y | jq .',            // not https
  TOKEN + 'curl -s ' + AUTH + ' https://x.googleapis.com/v1/y',                  // unbounded, unpiped
  TOKEN + 'curl -s ' + AUTH + ' https://x.googleapis.com/v1/y > out.json',
  TOKEN + 'curl -s ' + AUTH + ' https://x.googleapis.com/v1/y | sh',
  TOKEN + 'curl -s ' + AUTH + ' https://x.googleapis.com/v1/y | jq . > out',
  TOKEN + 'curl -s ' + AUTH + ' https://x.googleapis.com/v1/y | jq . ; npm test',
  TOKEN + 'curl -s ' + AUTH + ' "https://x.googleapis.com/v1/y?t=$T" | jq .',
  TOKEN + 'curl -s -H "X: $(id)" https://x.googleapis.com/v1/y | jq .',
  TOKEN + 'npm test',
  'PATH=$(gcloud auth print-access-token); curl -s https://x.googleapis.com/v1/y | jq .',
  'T=$(gcloud auth print-access-token --impersonate-service-account=x); curl -s https://x.googleapis.com/v1/y | jq .',
];

test('gcloud-reads: every refused verb, flag and chain stays blocked', () => {
  const wrong = BLOCK.filter((cmd) => run(cmd).status !== 2);
  assert.deepStrictEqual(wrong, [], 'expected BLOCK');
});

test('gcloud-reads: guards.allowGcloudReads=false restores the block', () => {
  for (const cmd of ['gcloud auth print-access-token', 'gcloud projects get-iam-policy p --format=json']) {
    const res = run(cmd, { settings: { guards: { allowGcloudReads: false } } });
    assert.strictEqual(res.status, 2, 'expected BLOCK with setting off: ' + cmd);
  }
});

test('gcloud-reads: subagent context is unaffected (still passes through)', () => {
  const res = run('gcloud run deploy api --image x', { agentId: 'a1' });
  assert.notStrictEqual(res.status, 2);
});
