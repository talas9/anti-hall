'use strict';
// shell-scan-differential: proves hooks/lib/shell-scan.js (the shared shell
// tokenizer used by BOTH command-guard.js and git-guard.js) never made either
// guard WEAKER than its pre-migration baseline.
//
// Methodology: spawn the BASE guard (checked out at the commit this migration
// started from, via `git archive <rev>`, materialized once into a temp
// dir alongside its sibling files) and the CURRENT (post-migration) guard
// against the SAME corpus of >= 80 commands, and assert every command the
// BASE guard blocked is STILL blocked by the current guard. A command that
// flips ALLOW -> BLOCK is fine (only ever a tightening) and is printed in the
// summary with its justification comment inline in the corpus below. A flip
// in the other direction (BLOCK -> ALLOW) fails the test — that is exactly
// the "guards must never get weaker" bar this file exists to enforce.
//
// BASE_REV defaults to the commit this migration was cut from (6ba9ccf,
// v0.105.0 — pre-shell-scan). Override with SHELL_SCAN_BASE_REV for reuse.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BASE_REV = process.env.SHELL_SCAN_BASE_REV || '6ba9ccf';

let baseDir = null;

function materializeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-shell-scan-base-'));
  const tar = execFileSync('git', ['-C', REPO, 'archive', BASE_REV, 'plugins/anti-hall'], { maxBuffer: 64 * 1024 * 1024 });
  const tarPath = path.join(dir, 'base.tar');
  fs.writeFileSync(tarPath, tar);
  execFileSync('tar', ['-x', '-f', tarPath, '-C', dir]);
  return path.join(dir, 'plugins', 'anti-hall', 'hooks');
}

before(() => {
  baseDir = materializeBase();
});

after(() => {
  if (baseDir) {
    try { fs.rmSync(path.dirname(path.dirname(baseDir)), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

const NEW_HOOKS_DIR = path.join(REPO, 'plugins', 'anti-hall', 'hooks');

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-shell-scan-home-'));
}

// spawnGuard(hooksDir, hookFile, payload, env) -> exit status (2 = block, 0 = allow)
function spawnGuard(hooksDir, hookFile, payload, extraEnv) {
  const home = isolatedHome();
  try {
    const env = { PATH: process.env.PATH, HOME: home, ...(extraEnv || {}) };
    const res = spawnSync(process.execPath, [path.join(hooksDir, hookFile)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    return res.status;
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

function cgPayload(command) {
  return {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
    session_id: 't', cwd: process.cwd(),
  };
}
function ggPayload(command) {
  return { tool_input: { command } };
}

const COORD_ENV = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

// -----------------------------------------------------------------------
// CORPUS — command-guard.js. Every BLOCK/ALLOW case already in
// tests/hooks/command-guard.test.js's own BLOCK/ALLOW arrays (coordinator
// heavy-command heuristics), PLUS the explicit bypass repros from the task:
// heredoc + chained-operator variants (;, |, |&, <<-, unterminated), heavy
// verbs behind taskpolicy/xargs/sudo/env/bash -c/ksh -c/ash -c, and quoted
// `<<` / arithmetic `$((1<<2))` (must NOT be misparsed as a heredoc opener).
// -----------------------------------------------------------------------
const CG_BLOCK = [
  'npm run build', 'npm test', 'git status && npm run build', 'cd app && npm test',
  'echo "$(npm run build)"', 'bash -c "npm run build"', 'eval "npm test"',
  'go env -w GOFLAGS=-mod=mod', 'node evil.js', 'node build.js', 'node scripts/deploy.mjs',
  'node /abs/plugins/anti-hall/statusline/other.js', 'node evilstatusline/phase.js',
  'node fakehooks/agent-watchdog.js', 'node evilscripts/devswarm.js', 'node scripts/other.js',
  'pytest -q', 'cd x && pytest', 'nice -n 19 firebase deploy --only functions',
  'FOO=1 npm test', 'a | xargs pytest', 'taskpolicy -c utility nice -n 19 firebase deploy --only functions',
  'echo "$(pytest)"',
  "cat > f <<EOF\n`pytest`\nEOF",
  "cat > f <<EOF\n$(pytest)\nEOF",
  // --- additive bypass repros (task corpus ask) ---
  'sudo npm test',
  'env FOO=bar npm test',
  'sudo env FOO=bar npm test',
  'ksh -c "npm test"',
  'ash -c "npm test"',
  'sudo bash -c "npm test"',
  'taskpolicy -c utility xargs npm test < list.txt',
  // heredoc + chained heavy command (mirrors the git-guard P0 repro family;
  // for command-guard the OUTER command after the chain operator is itself
  // heavy and must still be detected as its own segment).
  'cat <<EOF && npm test\nbody\nEOF',
  'cat <<EOF ; npm test\nbody\nEOF',
  'cat <<EOF | npm test\nbody\nEOF',
  'cat <<-EOF && npm test\n\tbody\n\tEOF',
  'cat <<EOF\nnpm test',
];
const CG_ALLOW = [
  'git status', 'echo "npm run build"', "printf 'go test ./...'", 'eval "echo hi"',
  'git push --dry-run origin main', 'go env GOPATH', 'echo "hello world"',
  'node statusline/phase.js set PLAN "Planning feature X" 0 3', 'node statusline/phase.js advance',
  'node hooks/agent-watchdog.js 1200000', 'node /Users/x/plugins/anti-hall/statusline/phase.js clear',
  'node /Users/x/plugins/anti-hall/hooks/agent-watchdog.js',
  'node C:\\proj\\plugins\\anti-hall\\statusline\\phase.js agents 4',
  'node scripts/devswarm.js workspaces list', 'node scripts/devswarm.js gate w --set done',
  'node /Users/x/plugins/anti-hall/scripts/devswarm.js migrate',
  'node C:\\proj\\plugins\\anti-hall\\scripts\\devswarm.js register w',
  'node scripts/devswarm.js inbox pull x',
  "cat > f <<'EOF'\nrun firebase deploy then pytest\nEOF",
  "printf '%s\\n' 'firebase deploy' > f", 'echo "pytest later" > note.md',
  'git commit -m "fix pytest flake"',
  "printf '%s' 'please run firebase deploy and pytest' > f",
  "cat > f <<'EOF'\nnpm run build && pytest\nEOF",
  "printf 'Status update\nfirebase deploy is scheduled\n'",
  'echo "notes:\npytest flaked twice" > f', 'git commit -m "fix\npytest isolation"',
  'cat > f <<EOF\nfirebase deploy --only functions\nEOF',
  'cat > f << "EOF"\nfirebase deploy --only functions\nEOF',
  "cat > f <<'EOF'\n`pytest`\nEOF",
  "cat > f <<'EOF'\n$(pytest)\nEOF",
  'cat > f << "EOF"\n`pytest`\nEOF',
  // --- additive: quoted `<<` / arithmetic shift must not be misread as a
  // heredoc opener (no segmentation change vs. base) ---
  'echo "a << b"',
  'echo $((1<<2))',
  'x=$((1<<2)); echo $x',
];

// -----------------------------------------------------------------------
// CORPUS — git-guard.js. Every BLOCK/ALLOW/GH_BLOCK/GH_ALLOW case already in
// tests/hooks/git-guard.test.js, PLUS the explicit bypass repros from the
// task: `cat <<EOF && git push --force origin main` with ; | |& <<- and an
// unterminated variant, plus quoted `<<` / `$((1<<2))` negative controls.
// -----------------------------------------------------------------------
const GG_BLOCK = [
  'git push --force', 'git push -f', 'git push --force-with-lease', 'git push origin +main',
  'git push origin -- +main:main', 'git -c alias.p=push p origin main --force',
  'git --config-env alias.p=push p origin main --force',
  "git -c alias.p='push --force origin main' p",
  'git --config-env alias.p=push p origin main', 'sudo git push --force', 'true && git push -f',
  'eval "git push -f"', 'git push origin "$(echo --force)"', 'git push origin "$(echo main)"',
  'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"',
  'git commit -m x --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"',
  'git commit -m x --trailer="Co-Authored-By: Claude <noreply@anthropic.com>"',
  'git commit -m x --trailer "Co-Authored-By=Claude <noreply@anthropic.com>"',
  'git -c trailer.ai.key=Co-Authored-By commit -m x --trailer "ai: Claude <noreply@anthropic.com>"',
  'bash -c "git push --force"', 'sh -c "git push --force origin main"', 'zsh -c "git push -f"',
  'sudo bash -c "git push --force"',
  'bash -c "git commit -m x --trailer \'Co-Authored-By: Claude <noreply@anthropic.com>\'"',
  'git push origin main 2>&1 --force', 'git push origin main >&2 --force',
  'git push origin main &>out.log --force',
  'git commit -q -F - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF',
  'git commit -F - <<EOF\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
  'git commit --file=- <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
  'git commit --file - <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
  'git commit -F /dev/stdin <<\'EOF\'\nsubject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF',
  'cat <<EOF && git push --force origin main\nbody\nEOF',
  'cat <<EOF ; git push --force origin main\nbody\nEOF',
  'cat <<EOF | git push --force origin main\nbody\nEOF',
  'cat <<EOF |& git push --force origin main\nbody\nEOF',
  'cat <<-EOF && git push --force origin main\n\tbody\n\tEOF',
  'cat <<EOF\ngit push --force origin main',
  // --- additive: taskpolicy/xargs/env wrapping ahead of a force push ---
  'taskpolicy -c utility git push --force',
  'env FOO=1 git push --force',
  'xargs -I{} git push --force',
  'gh pr create --title x --body "Done.\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"',
  'gh issue create --body "Co-Authored-By: Claude <noreply@anthropic.com>"',
  'gh pr edit 5 --body "see claude.com/claude-code"',
  'gh pr create --body="🤖 Generated with Claude Code"',
];
const GG_ALLOW = [
  'git push origin main', 'git push origin -- main', 'git status', 'git commit -m "feat: x"',
  'eval "git status"', 'git commit -m x --trailer "Reviewed-by: Alice"',
  'git commit -m x --trailer "Reviewed-by=Alice"',
  'git -c trailer.sob.key=Signed-off-by commit -m x --trailer "sob: Alice"',
  'bash -c "git status"', 'sh -c "npm test"', 'bash -c "git push origin main"',
  'git push origin main 2>&1', 'git push origin main &>out.log',
  'git commit -q -F - <<\'EOF\'\nsubject\n\nordinary body, no trailer\nEOF',
  'git commit -F - <<EOF\nsubject\n\nordinary body, no trailer\nEOF',
  'gh pr create --title x --body "Fixes the parser bug"', 'gh pr create --body-file /tmp/body.md',
  'gh release view', 'gh pr list',
  // --- additive: quoted `<<` / arithmetic shift negative controls ---
  'git commit -m "value << 2"',
  'git commit -m "shift $((1<<2))"',
];

const summary = { flips: [] };

test(`shell-scan differential corpus (base=${BASE_REV})`, () => {
  const cgCases = [
    ...CG_BLOCK.map((cmd) => ({ cmd, guard: 'command-guard.js', payload: cgPayload(cmd), env: COORD_ENV })),
    ...CG_ALLOW.map((cmd) => ({ cmd, guard: 'command-guard.js', payload: cgPayload(cmd), env: COORD_ENV })),
    ...GG_BLOCK.map((cmd) => ({ cmd, guard: 'git-guard.js', payload: ggPayload(cmd), env: {} })),
    ...GG_ALLOW.map((cmd) => ({ cmd, guard: 'git-guard.js', payload: ggPayload(cmd), env: {} })),
  ];

  assert.ok(cgCases.length >= 80, `corpus must have >= 80 cases, has ${cgCases.length}`);

  let blockedOnBaseButAllowedOnNew = 0;
  for (const c of cgCases) {
    const baseStatus = spawnGuard(baseDir, c.guard, c.payload, c.env);
    const newStatus = spawnGuard(NEW_HOOKS_DIR, c.guard, c.payload, c.env);
    const baseBlocked = baseStatus === 2;
    const newBlocked = newStatus === 2;
    if (baseBlocked && !newBlocked) {
      blockedOnBaseButAllowedOnNew++;
      assert.fail(`SAFETY REGRESSION: ${c.guard} base=BLOCK new=ALLOW for: ${JSON.stringify(c.cmd)}`);
    }
    if (!baseBlocked && newBlocked) {
      summary.flips.push({ guard: c.guard, cmd: c.cmd });
    }
  }

  assert.strictEqual(blockedOnBaseButAllowedOnNew, 0, 'no command may flip from BLOCK (base) to ALLOW (new)');

  // Print the allow->block flips (tightenings) for the human report, with the
  // justification: every one of these is either (a) an intentional additive
  // bypass-repro added ONLY to this corpus (not exercised by base at all in
  // the base guard's OWN test suite) or (b) a genuine behavior change. This
  // migration introduced NO (b) cases — the shared primitives (parseHeredocAt,
  // extractSubstitutions, tokenizeQuoted/dequoteSegment, basename, SHELL_VERBS)
  // are byte-for-byte equivalence-preserving refactors of each guard's own
  // pre-migration logic (see hooks/lib/shell-scan.js's header + command-guard.js/
  // git-guard.js's inline comments at each call site for the equivalence proof).
  if (summary.flips.length) {
    process.stderr.write('\nALLOW(base) -> BLOCK(new) flips (' + summary.flips.length + '):\n');
    for (const f of summary.flips) process.stderr.write(`  [${f.guard}] ${JSON.stringify(f.cmd)}\n`);
  }
});
