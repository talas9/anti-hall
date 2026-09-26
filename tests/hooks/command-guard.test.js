'use strict';
// command-guard (PreToolUse Bash). Coordinator => may block (exit 2 + decision);
// subagent => always allow (exit 0).
//
// COORDINATOR env: CLAUDE_CODE_ENTRYPOINT='cli' AND no agent_id in the payload.
// SUBAGENT: agent_id in the PAYLOAD (the cmux-reliable signal).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

// Coordinator run with a fresh fake HOME (no skip.json -> guard active).
function runCoord(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home, env: COORD });
  } finally {
    h.cleanup();
  }
}

const BLOCK = [
  'npm run build',
  'npm test',
  'git status && npm run build',
  'cd app && npm test',
  'echo "$(npm run build)"',
  'bash -c "npm run build"',
  'eval "npm test"',
  'go env -w GOFLAGS=-mod=mod',
  // Arbitrary node scripts stay blocked — the helper exception must be narrow.
  'node evil.js',
  'node build.js',
  'node scripts/deploy.mjs',
  // Wrong filename inside the same helper dir is NOT exempted.
  'node /abs/plugins/anti-hall/statusline/other.js',
  // Spoof attempt: a look-alike dir prefix must not satisfy the anchored exception.
  'node evilstatusline/phase.js',
  'node fakehooks/agent-watchdog.js',
  // Look-alike prefix must NOT satisfy the anchored devswarm.js carve-out.
  'node evilscripts/devswarm.js',
  'node scripts/other.js',
  // A heavy verb at command position must still block, including through
  // transparent wrappers (taskpolicy, xargs-as-runner) and with the verb
  // itself present only as prose text alongside a real invocation elsewhere.
  'pytest -q',
  'cd x && pytest',
  'nice -n 19 firebase deploy --only functions',
  'FOO=1 npm test',
  'a | xargs pytest',
  'taskpolicy -c utility nice -n 19 firebase deploy --only functions',
  // (c) command SUBSTITUTION still executes even from inside double quotes —
  // must stay flagged (not the same as inert quoted prose DATA).
  'echo "$(pytest)"',
  // Negative control for the heredoc-substitution fix: an UNQUOTED heredoc
  // delimiter (`<<EOF`, no quotes) DOES expand $(...)/backticks in a real
  // shell, so a substitution inside that body must still be flagged.
  "cat > f <<EOF\n`pytest`\nEOF",
  "cat > f <<EOF\n$(pytest)\nEOF",
  // f0958b13-adjacent: state-changing variants of the newly-allowed read-only
  // commands must stay blocked — the allowlist is read-only-scoped, not a
  // blanket exemption of the whole script/verb.
  // NOTE: `git push origin main` moved to ALLOW below (owner-approved
  // 2026-09-26, "allow plain push" — see command-guard-allow-plain-push.test.js
  // for the full matrix; this file's runCoord() runs with cwd=process.cwd(),
  // this repo, checked out on `main`, so the ref-matches-current-branch rule
  // is satisfied).
  'git pull origin main',
  'node plugins/anti-hall/scripts/settings.js set devswarm.enabled true --confirmed',
  'sqlite3 /tmp/x.db "delete from t"',
  'sqlite3 -readwrite /tmp/x.db "delete from t"',
  'npm test',
  'node plugins/anti-hall/hooks/doctor.js --repair',
  'node plugins/anti-hall/hooks/doctor.js --fix',
  'node plugins/anti-hall/scripts/jev-report.js label abc123 tp',
  'node plugins/anti-hall/scripts/jev-report.js prune-audit --days 30',
  'gcloud compute instances delete foo',
  'kubectl delete pod foo',
  // P1 fp (rc-v0.108.4.2 review): a mutating verb earlier on the line must not
  // be shadowed by a LATER compound word that merely CONTAINS a read-only
  // verb as a substring — `list-users`/`get-worker-1` are single argv tokens,
  // not the literal `list`/`get` verb.
  'gcloud functions deploy list-users',
  'kubectl delete pod get-worker-1',
  // P1 fp: git fetch with a refspec/prune/force can rewrite or delete local
  // remote-tracking refs — must stay gated like push/pull.
  'git fetch --prune origin',
  'git fetch -p origin',
  'git fetch --prune-tags origin',
  'git fetch --force origin main',
  'git fetch -f origin main',
  'git fetch origin +refs/heads/*:refs/remotes/origin/*',
  'git fetch origin main:main',
  // P2 fp: -readonly must be an actual argv token BEFORE the db path, and
  // dangerous sqlite3 dot-commands/ATTACH must stay gated even on a
  // `-readonly` connection (.shell/.system/.output/.once/.import/.save can
  // still write files or run shell commands; ATTACH opens a second,
  // non-readonly db).
  'sqlite3 "-readonly db" /tmp/x.db "select 1"',
  'sqlite3 -readonly /tmp/x.db ".shell rm -rf /"',
  'sqlite3 -readonly /tmp/x.db ".system rm -rf /"',
  'sqlite3 -readonly /tmp/x.db ".output /tmp/pwn"',
  'sqlite3 -readonly /tmp/x.db ".once /tmp/pwn"',
  'sqlite3 -readonly /tmp/x.db ".import /etc/passwd t"',
  'sqlite3 -readonly /tmp/x.db ".save /tmp/copy.db"',
  'sqlite3 -readonly /tmp/x.db "ATTACH DATABASE \'/tmp/x.db\' AS y"',
  // P2 fp: the doctor.js exemption must exclude --reclaim-ingest-lock too
  // (forces a stale-lock takeover — a mutating action, not diagnostics).
  'node plugins/anti-hall/hooks/doctor.js --reclaim-ingest-lock',
  // rc-v0.108.4.3 adversarial review — confirmed bypasses:
  // (1) P1: a sqlite3 `-readonly` invocation with a heredoc BODY still runs
  // arbitrary dot-commands (`.shell rm -rf /`) — the body is inert DATA to
  // splitSegments, so it never reaches SQLITE_DANGEROUS_RE; the only fix is
  // to deny ANY stdin input on the invoking segment outright.
  "sqlite3 -readonly db.sqlite <<'EOF'\n.shell rm -rf /\nEOF",
  // Herestring / input-file redirect / piped stdin must all deny the same way.
  'sqlite3 -readonly db.sqlite <<< ".shell rm -rf /"',
  'sqlite3 -readonly db.sqlite < payload.sql',
  "echo '.shell rm -rf /' | sqlite3 -readonly db.sqlite",
  // (2) P1: git GLOBAL options between `git` and the subcommand hid the real
  // subcommand from every prior check (naive `\bgit\s+push\b` substring
  // match, and isSafeGitFetch's fixed-position `tokens[gitIdx+1]` read).
  'git -c core.hooksPath=/tmp/x push --force origin main',
  'git -C dir fetch +main:main',
  // (3) P2: bracket member access (`obj['method']`) hides the method name
  // from the name-based NODE_EVAL_UNSAFE_RE deny-list.
  "node -e \"require('fs')['writeFileSync']('x','y')\"",
  // Additional node -e bypass shapes the new checks must also catch.
  'node -e "require(\'child_process\').execSync(\'rm -rf /\')"',
  'node -e "import(\'fs\').then(m=>m.writeFileSync(\'x\',\'y\'))"',
  'node -e "eval(\'1+1\')"',
  'node -e "new Function(\'return 1\')()"',
  'node -e "require(\'fs/promises\').writeFile(\'x\',\'y\')"',
  'node -e "process.binding(\'fs\').writeFile(\'x\')"',
  'node -e "require(\'fs\').cpSync(\'a\',\'b\')"',
  // (4) P2: gh mutating subcommands were never classified heavy at all.
  'gh pr merge 123',
  'gh pr merge 12',
  'gh pr close 123',
  'gh pr edit 123 --title x',
  'gh pr create --title x --body y',
  'gh pr review 123 --approve',
  'gh issue create --title x',
  'gh issue close 5',
  'gh issue delete 5',
  'gh issue edit 5 --title x',
  'gh release create v1.0.0',
  'gh release delete v1.0.0',
  'gh release edit v1.0.0 --title x',
  'gh release upload v1.0.0 f.tar.gz',
  'gh repo delete owner/repo',
  'gh repo edit owner/repo --description x',
  'gh secret set FOO --body bar',
  'gh secret delete FOO',
  'gh workflow run build.yml',
  'gh api repos/o/r/issues -X POST -f title=x',
  'gh api repos/o/r/issues --method DELETE',
  'gh api repos/o/r/issues -f title=x',
  'gh api graphql -F query=x',
  // defect.js: only report/list/show/recurring/similar are exempt (append-only
  // or read). `backfill` writes history records and stays gated. `rule`
  // (maintainer ruling) and `archive` (rotation sweep — moves files) mutate
  // more than an append and must stay gated.
  'node plugins/anti-hall/scripts/defect.js rule abc123 --status fixed',
  'node plugins/anti-hall/scripts/defect.js archive',
  'node plugins/anti-hall/scripts/defect.js backfill --repo .',
  'npm run build -- node scripts/defect.js similar foo',
  // review P2: the defect.js exemption is anchored to the START of a
  // segment — a heavy command merely carrying it as trailing args must
  // not be exempted.
  'npm run build -- node scripts/defect.js list',
  'make all node scripts/defect.js show abc123',
  // Same segment-start-anchoring bypass, but for EVERY OTHER anti-hall CLI
  // allowlist entry (jev-setup.js, settings.js, jev-report.js, doctor.js,
  // phase.js, agent-watchdog.js, devswarm.js) — only defect.js was anchored
  // by bcd0d69; a heavy command merely carrying one of these scripts as
  // trailing args after `--` must not be exempted either.
  'npm run build -- node plugins/anti-hall/scripts/jev-setup.js status',
  'npm run build -- node plugins/anti-hall/scripts/settings.js show',
  'npm run build -- node plugins/anti-hall/scripts/jev-report.js',
  'npm run build -- node plugins/anti-hall/hooks/doctor.js',
  'npm run build -- node statusline/phase.js clear',
  'npm run build -- node hooks/agent-watchdog.js',
  'npm run build -- node scripts/devswarm.js roster',
  // ---------------------------------------------------------------------
  // "Narrow allow" bounded-verification carve-out — BYPASS ATTEMPTS that
  // must stay blocked (owner-approved 2026-09-26). Each mirrors a real
  // allowed shape closely enough that a sloppy implementation would let it
  // through; every one below must fail at least one of the four required
  // conditions (single qualifying segment / piped bounded sink / no
  // disallowed write redirect / no other unaccounted-for segment).
  // ---------------------------------------------------------------------
  // Chaining a real heavy command after a narrow single-file pytest form —
  // the second segment does not itself qualify or count as trivially safe.
  'python3 -m pytest -q x.py; npm test',
  'pytest -q x.py; npm test',
  // A glob/dir target disqualifies the node --test / python3 pytest forms
  // outright — AND (independently) these bare forms were never classified
  // heavy in the first place, so no override is even reachable; they stay
  // allowed for the SAME reason as always, not because of this feature.
  // The ksh -c shell-wrapper bypass: this exception never unwraps `-c`
  // payloads, so a heavy command hidden behind a shell invocation stays
  // blocked exactly as before.
  'ksh -c "npm test" | tail',
  'bash -c "npm test" | tail -5',
  // A --check flag riding along on a genuinely heavy verb invocation (npm
  // IS a HEAVY_VERB) must not be waved through just because --check is
  // present as a token — the generic flag rule explicitly excludes any
  // segment whose own verb is a HEAVY_VERB.
  'npm run build --check | tail',
  'npm test --check | tail -20',
  // A --check flag hidden inside quoted DATA (not a real flag token) must
  // not satisfy the generic-flag rule via mere substring match; the second,
  // unrelated segment is a genuinely heavy `firebase deploy` and must also
  // never be shadowed by the first segment's carve-out check.
  'git commit -m "run deploy --check" && firebase deploy --only functions',
  // The bounded sink must be reached by an actual PIPE on the qualifying
  // segment's own segment boundary — a semicolon (sequential, not piped)
  // does not bound anything, even against an otherwise-qualifying, otherwise
  // already-heavy (HEAVY_PATTERNS git-clone) primary segment.
  'git clone --depth 1 https://example.com/repo.git /tmp/x; tail -5',
  // A write redirect outside the scratchpad/tmp on the SINK segment itself
  // disqualifies the whole line even though the primary segment and the
  // pipe shape both otherwise qualify.
  'git clone --depth 1 https://example.com/repo.git /tmp/x | tail > /Users/talas9/Projects/anti-hall/out.log',
  // `tee` is not one of the allowed bounded sinks (tail/head/grep -c/grep -m
  // N/wc only) — piping an otherwise-qualifying git clone into `tee` (even
  // to a tmp destination) does not satisfy the "bounded output" condition.
  'git clone --depth 1 https://example.com/repo.git /tmp/x | tee /tmp/out.log',
  // git clone --depth 1 to a destination OUTSIDE the scratchpad/tmp must
  // stay blocked (git clone is HEAVY_PATTERNS-matched).
  'git clone --depth 1 https://example.com/repo.git /Users/talas9/Projects/anti-hall/x | tail -1',
  // Only `git clone --depth 1 https://… <tmp dest>` qualifies — a clone
  // without --depth 1 (or from a local path) never does.
  'git clone https://example.com/repo.git /tmp/x | tail -1',
];

const ALLOW = [
  'git status',
  'echo "npm run build"',
  "printf 'go test ./...'",
  'eval "echo hi"',
  'git push --dry-run origin main',
  // "Allow plain push" (owner-approved 2026-09-26): a plain `git push` to the
  // CURRENT branch is now allowed inline in the coordinator — this repo is
  // checked out on `main`. See command-guard-allow-plain-push.test.js for the
  // full allow/block matrix (force/mirror/delete/tags/foreign-branch stay
  // blocked exactly as before).
  'git push origin main',
  'go env GOPATH',
  'echo "hello world"',
  // Coordinator-owned phase-state helpers (orchestration/SKILL.md:305, ship-it/SKILL.md:280).
  // Documented relative form (path relative to plugin root) ...
  'node statusline/phase.js set PLAN "Planning feature X" 0 3',
  'node statusline/phase.js advance',
  'node hooks/agent-watchdog.js 1200000',
  // ... and the documented absolute form (path.join(pluginRoot, ...)).
  'node /Users/x/plugins/anti-hall/statusline/phase.js clear',
  'node /Users/x/plugins/anti-hall/hooks/agent-watchdog.js',
  // Windows-separator form must resolve identically (OS-agnostic).
  'node C:\\proj\\plugins\\anti-hall\\statusline\\phase.js agents 4',
  // DevSwarm CLI wrapper (scripts/devswarm.js) — the catch-22 carve-out (PLAN.md
  // Phase 2). Relative, absolute, and Windows-separator forms all resolve.
  'node scripts/devswarm.js workspaces list',
  'node scripts/devswarm.js gate w --set done',
  'node /Users/x/plugins/anti-hall/scripts/devswarm.js migrate',
  'node C:\\proj\\plugins\\anti-hall\\scripts\\devswarm.js register w',
  // Child-side reception drain (v0.54.2) — bounded, guard-safe pull. It IS the
  // devswarm.js wrapper, so the same anchored LIGHT_EXCEPTION allows it inline in
  // coordinator context (its internal spawn is the non-destructive count-gate +
  // one bounded read-messages, never a blocking monitor).
  'node scripts/devswarm.js inbox pull x',
  // Field report (seen twice): a heavy verb appearing only inside DATA (a
  // heredoc message body, or a quoted printf/echo argument) must not be
  // mistaken for a command at command position.
  "cat > f <<'EOF'\nrun firebase deploy then pytest\nEOF",
  "printf '%s\\n' 'firebase deploy' > f",
  'echo "pytest later" > note.md',
  'git commit -m "fix pytest flake"',
  // (a) heavy words solely inside a quoted printf DATA argument.
  "printf '%s' 'please run firebase deploy and pytest' > f",
  // (b) heavy words solely inside a heredoc BODY (HEAVY_PATTERN text, not just
  // a HEAVY_VERB) — proves the heavy-PATTERN check (npm run build, not just
  // the verb check) also respects the heredoc-body skip, not only effectiveVerb.
  "cat > f <<'EOF'\nnpm run build && pytest\nEOF",
  // A real newline INSIDE a quoted string must not start a new segment — the
  // quote tracker must stay in-quote across the line break, same as any other
  // quoted char (verified: splitSegments handles '\n' inside inSingle/inDouble
  // before the bare '\n' segment-split case is ever reached).
  "printf 'Status update\nfirebase deploy is scheduled\n'",
  'echo "notes:\npytest flaked twice" > f',
  'git commit -m "fix\npytest isolation"',
  // Heredoc delimiter forms other than the quoted/plain-word cases already
  // covered above: UNQUOTED delimiter, and a quoted delimiter with a space
  // before it (`<< "EOF"`) — both must still skip the body as DATA.
  'cat > f <<EOF\nfirebase deploy --only functions\nEOF',
  'cat > f << "EOF"\nfirebase deploy --only functions\nEOF',
  // Field report (exact command, verbatim from a real transcript): a
  // backtick-quoted span of ordinary prose (`` `pytest tests -k <codebase>` ``)
  // inside a QUOTED-delimiter (`<<'EOF'`) devswarm.js message body was
  // extracted by extractSubstitutions as a real command substitution and
  // recursed into isHeavyCommand — misclassified as an EXECUTED `pytest`
  // command (verb: pytest) even though a real shell never expands a
  // backtick/$() inside a `<<'EOF'` body. Root cause: extractSubstitutions
  // had no heredoc awareness at all, unlike splitSegments/isHeavySegment.
  "cd /Users/talas9/Projects/skycrew && S=/private/tmp/claude-501/-Users-talas9-Projects-skycrew/901870ae-e9d0-42cd-b328-fad620732d19/scratchpad\ncat > $S/m_alert23.txt <<'EOF'\nCORRECTIONS to your filed item (i), measured by the test-isolation lane — please update FOLLOWUPS-2026-09-23.md:\n1. The failing import is python/skyinformApi/_esim_admin_router.py:79 (NOT esimOps). There are TWO _esim_admin_router.py files; skyinformApi's is the one that dies. Traceback: tests/test_esim_intent_get_mirror_projection.py:27 -> skyinformApi/_esim_admin_router.py:79.\n2. The wrapper's \"codebase-scoped\" test step (bin/deploy-skyfb.sh:452-467) is a `pytest tests -k <codebase>` NAME FILTER over the root tests/ directory, not a directory scope — which is why a skyinformApi file fails the \"esimOps\" step.\n3. The test-isolation branch does NOT fix it (identical EXIT=2 on its head and main).\nThe error I relayed to that lane said esimOps; that was my relay error.\nEOF\nnode ~/.claude/plugins/cache/anti-hall/anti-hall/0.103.0/scripts/devswarm.js send --to a7aa9263-6a85-4582-a7ff-9aed4ad18e55 --message-file $S/m_alert23.txt | head -c 20",
  // Minimal isolate of the same root cause: a backtick command substitution
  // inside a QUOTED heredoc delimiter's body is inert DATA (no expansion in
  // a real shell) and must not be extracted/recursed.
  "cat > f <<'EOF'\n`pytest`\nEOF",
  "cat > f <<'EOF'\n$(pytest)\nEOF",
  'cat > f << "EOF"\n`pytest`\nEOF',
  // f0958b13-adjacent: read-only allowlist additions (0.108.4). Every
  // verbatim example from the field report must ALLOW in coordinator context.
  'node <plugin>/scripts/jev-setup.js status | head -30'.replace('<plugin>', 'plugins/anti-hall'),
  'node plugins/anti-hall/scripts/settings.js show',
  'node plugins/anti-hall/scripts/settings.js get devswarm.enabled',
  'node plugins/anti-hall/scripts/devswarm.js inbox tick',
  'node plugins/anti-hall/scripts/devswarm.js roster',
  'node plugins/anti-hall/scripts/devswarm.js inbox peek-primary',
  'sqlite3 -readonly /tmp/x.db "select count(*) from t"',
  'gcloud run services describe foo --project p --region r --format=value(status.url)',
  'git ls-remote origin main; git fetch -q origin main; git merge-base --is-ancestor abc def; git diff --name-only abc def',
  'git rev-parse HEAD',
  'git log --oneline -5',
  'git status --short',
  'git show --stat HEAD',
  'git ls-tree HEAD',
  'git fetch origin main',
  'git branch --list',
  'git reflog show',
  'gh pr list',
  'kubectl get pods',
  'gcloud logging read "severity>=ERROR" --limit 5',
  'node plugins/anti-hall/hooks/doctor.js',
  'node plugins/anti-hall/scripts/jev-report.js --weekly',
  'node plugins/anti-hall/scripts/jev-report.js --days 7 --json',
  // rc-v0.108.4.3 adversarial review fixes must not over-block legitimate
  // read-only usage of the same tools.
  'git -C dir fetch origin main',
  'git -c core.hooksPath=/tmp/x status',
  'node -e "console.log(1)"',
  'node -e "require(\'fs\').readFileSync(\'x\')"',
  'node -e "require(\'fs\').existsSync(\'x\')"',
  'gh run watch 123',
  'gh run view 123',
  'gh pr view 1',
  'gh pr diff 1',
  'gh pr checks 1',
  'gh api repos/o/r/issues',
  'gh workflow list',
  // defect.js report/list/show: append-only (report) or read-only (list/show)
  // anti-hall CLI subcommands — same narrow, anchored carve-out discipline as
  // the jev-setup.js/settings.js/jev-report.js exemptions above.
  'node plugins/anti-hall/scripts/defect.js report --class x --sev p2 --sym test',
  'node plugins/anti-hall/scripts/defect.js list --open',
  'node plugins/anti-hall/scripts/defect.js list --json',
  'node plugins/anti-hall/scripts/defect.js show abc123',
  'node plugins/anti-hall/scripts/defect.js show abc123 --json',
  'node plugins/anti-hall/scripts/defect.js recurring --top 10 --json',
  'node plugins/anti-hall/scripts/defect.js similar gate blocks archived --component hooks/devswarm-parent-gate',
  'cd /repo && node scripts/defect.js list --open',
  'FOO=1 node scripts/defect.js list',
  // ---------------------------------------------------------------------
  // "Narrow allow" bounded-verification carve-out (owner-approved
  // 2026-09-26) — cases that PROVE the override, i.e. the base command was
  // ALREADY classified heavy (git clone matches HEAVY_PATTERNS) and only
  // allows through the narrow shape.
  // ---------------------------------------------------------------------
  'git clone --depth 1 https://example.com/repo.git /tmp/verify-clone-x | tail -1',
  'git clone --depth 1 https://example.com/repo.git /tmp/verify-clone-y | head -3',
  'git clone --depth 1 https://example.com/repo.git /tmp/verify-clone-z | wc -l',
  // A generic --check flag on a NON-heavy-verb command, bounded via a pipe.
  './scripts/verify.sh --check | tail',
  './scripts/verify.sh --dry-run | head -20',
  './scripts/verify.sh --list | wc -l',
  // ---------------------------------------------------------------------
  // The remaining documented "single-target check" shapes (syntax-only
  // compile check, a single python3 -m pytest -q file, one/two explicit
  // node --test files, ctest -R <name>) were NEVER classified heavy by
  // command-guard's existing verb/pattern rules in the first place (none of
  // c++/cc/gcc/clang/python3/node/ctest are HEAVY_VERBS, and none of these
  // exact shapes match a HEAVY_PATTERN) — so these ALLOW whether or not the
  // narrow-allow carve-out fires at all. Kept here as regression coverage
  // for the shape-matching helpers themselves (isSyntaxOnlyCompileCheck /
  // isSinglePytestFileCheck / isBoundedNodeTestCheck / isCtestNameCheck),
  // not as proof of the override (git clone above is the proof).
  'c++ -fsyntax-only foo.cpp | tail',
  'gcc -fsyntax-only foo.c | grep -c error',
  'python3 -m pytest -q tests/x.py | tail -5',
  'node --test tests/a.test.js tests/b.test.js | tail',
  'ctest -R mytest | wc -l',
  // node --test with a command-substitution target: unaffected by this
  // feature either way (was already allowed before it existed, since bare
  // `node --test ...` never matched a HEAVY_VERB/HEAVY_PATTERN) — kept as a
  // negative control proving the carve-out did not need to (and does not)
  // intervene here.
  'node --test $(ls tests) | tail',
];

for (const cmd of BLOCK) {
  test(`COORD BLOCK: ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

for (const cmd of ALLOW) {
  test(`COORD ALLOW: ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

test('SUBAGENT allows heavy command (agent_id in payload, no cli entrypoint)', () => {
  const h = makeHome();
  try {
    // No CLAUDE_CODE_ENTRYPOINT; agent_id present in the payload.
    const r = testHook(HOOK, bashPayload('npm run build', { agentId: 'x' }), { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('INJECTION: block reason does not echo arbitrary command text', () => {
  const r = runCoord('npm run build && echo INJECTSECRET');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DevSwarm destructive-read REDIRECT branch. Fires when the DevSwarm liveness
// supervisor is active for THIS session (DEVSWARM_REPO_ID set -> isDevswarmActive
// auto-true), in ALL contexts (coordinator AND subagent), with its OWN skip name
// (`devswarm-read-guard`), BEFORE command-guard's own skip/coordinator gate.
//   - `monitor`      -> block UNCONDITIONALLY (no-timeout long-poll hangs the shell).
//   - `read-messages`-> block UNCONDITIONALLY too (Part B, v0.55): a raw native read
//                       desyncs the durable cursor regardless of evidence, so it blocks
//                       like `monitor` (the old durable-evidence gate is removed).
//   - raw file reads (cat/head/… of the inbox or store) -> block via the Bash-side
//                       companion to inbox-read-guard.js (the shared path classifier).
const fsx = require('node:fs');
const pathx = require('node:path');
const DEVSWARM_COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' };
const DURABLE_ENV = { ANTIHALL_DEVSWARM_INBOX_CMD: 'my-inbox-reader' };

// runDevswarm(command, extraEnv, opts) — DevSwarm-active coordinator, fresh HOME.
//   opts.agentId    -> lands in the payload (subagent discriminator).
//   opts.descriptor -> object written to ~/.anti-hall/devswarm/workspaces/ws.json
//                      BEFORE the run (durable-evidence-via-descriptor case).
//   opts.skip       -> object written to ~/.anti-hall/skip.json BEFORE the run.
function runDevswarm(command, extraEnv, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.descriptor) {
      const wdir = pathx.join(h.antiHall, 'devswarm', 'workspaces');
      fsx.mkdirSync(wdir, { recursive: true });
      fsx.writeFileSync(pathx.join(wdir, 'ws.json'), JSON.stringify(o.descriptor), 'utf8');
    }
    if (o.skip) h.writeSkip(o.skip);
    return testHook(HOOK, bashPayload(command, { agentId: o.agentId }), {
      home: h.home,
      env: Object.assign({}, DEVSWARM_COORD, extraEnv || {}),
    });
  } finally {
    h.cleanup();
  }
}

// --- NEGATIVE (the regression these changes fix): quoted DATA must NOT block ---
const HIVECTL_ALLOW_DATA = [
  // grep of a DATA string that mentions the subcommand — a false-positive before.
  "grep -n 'hivecontrol workspace read-messages' docs/KB.md",
  // echo of a DATA string that mentions monitor — a false-positive before.
  'echo "do not run hivecontrol workspace monitor inline"',
];
for (const cmd of HIVECTL_ALLOW_DATA) {
  test(`DEVSWARM ALLOW (quoted data): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for quoted data: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- POSITIVE: real destructive reads / smuggled forms must block ---
// Part B: BOTH monitor and read-messages block UNCONDITIONALLY (no evidence needed).
const HIVECTL_BLOCK = [
  { cmd: 'hivecontrol workspace read-messages', env: {} }, // unconditional (Part B)
  { cmd: 'hivecontrol workspace read-messages', env: DURABLE_ENV },
  { cmd: 'hivecontrol workspace monitor', env: {} }, // unconditional
  { cmd: 'bash -c "hivecontrol workspace read-messages"', env: {} },
  { cmd: '$(hivecontrol workspace monitor)', env: {} },
  // Chained after a benign command — caught on the destructive segment.
  { cmd: 'echo hi && hivecontrol workspace monitor', env: {} },
  // Flag insertion must not bypass the matcher.
  { cmd: 'hivecontrol --json workspace monitor', env: {} },
];
for (const { cmd, env } of HIVECTL_BLOCK) {
  test(`DEVSWARM BLOCK: ${cmd}`, () => {
    const r = runDevswarm(cmd, env);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// REGRESSION (P0, live-verified bypass): quoting a bareword does NOT change argv —
// the shell executes `hivecontrol workspace "monitor"` identically to the unquoted
// form. Previously the per-segment pattern test ran against
// neutralizeQuotedContents(seg), which BLANKS quoted content instead of dequoting
// it, so every quoted variant of monitor/read-messages sailed through (exit 0).
// This defeated the single-consumer invariant: the guard's own block reason echoes
// the exact blocked subcommand back, so a blocked model's natural retry is to quote
// it. Covers: double-quoted subcommand, single-quoted subcommand, a mid-token split
// quote, and a quoted VERB (which must also still anchor to `hivecontrol`).
const HIVECTL_QUOTE_BYPASS_BLOCK = [
  'hivecontrol workspace "monitor"',
  "hivecontrol workspace 'monitor'",
  'hivecontrol workspace mon"ito"r',
  '"hivecontrol" workspace monitor',
  'hivecontrol workspace "read-messages"',
  "hivecontrol workspace 'read-messages'",
  'hivecontrol workspace read"-mess"ages',
  '"hivecontrol" workspace read-messages',
];
for (const cmd of HIVECTL_QUOTE_BYPASS_BLOCK) {
  test(`DEVSWARM BLOCK (quote-bypass regression): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// --- SCOPING ---
// Part B inversion: read-messages with NO durable evidence now BLOCKS unconditionally
// (was ALLOW). A raw native read desyncs the durable cursor regardless of evidence.
test('DEVSWARM BLOCK read-messages with NO durable evidence (Part B: unconditional)', () => {
  const r = runDevswarm('hivecontrol workspace read-messages');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

// The block reason redirects to the wrapper (`inbox pull`) and names the kill-switch.
test('DEVSWARM read-messages reason names `inbox pull` + DISABLE_ANTIHALL_DEVSWARM kill-switch', () => {
  const r = runDevswarm('hivecontrol workspace read-messages');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /inbox pull/.test(r.json.reason),
    'reason should redirect to `devswarm.js inbox pull`');
  assert.ok(r.json && /DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason),
    'reason should name the DISABLE_ANTIHALL_DEVSWARM=1 kill-switch');
});

test('DEVSWARM SUBAGENT (agent_id) + monitor still blocks (all-contexts)', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, { agentId: 'x' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

const HIVECTL_ALLOW = [
  'hivecontrol workspace message-count',
];
for (const cmd of HIVECTL_ALLOW) {
  test(`DEVSWARM ALLOW (non-destructive): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- --help/-h: read-only usage invocations must not be treated as the
// destructive action they are naming. Fixes a false positive where
// `hivecontrol workspace read-messages --help` / `... monitor -h` were blocked
// identically to the real destructive call, even though neither touches the
// mailbox/mesh.
const HIVECTL_HELP_ALLOW = [
  'hivecontrol workspace read-messages --help',
  'hivecontrol workspace monitor -h',
  'hivecontrol workspace monitor --help',
  'hivecontrol workspace read-messages -h',
  'devswarm workspace monitor --help',
];
for (const cmd of HIVECTL_HELP_ALLOW) {
  test(`DEVSWARM ALLOW (--help/-h read-only): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// A --help token in one chained segment must NOT immunize a SEPARATE segment
// that carries no --help/-h of its own — splitSegments already isolates them,
// so the second (real, non-help) invocation still blocks.
test('DEVSWARM BLOCK: --help on one segment does not shield a chained real monitor call', () => {
  const r = runDevswarm('hivecontrol workspace monitor --help ; hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2, `expected block for chained real call\nstdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

// ---------------------------------------------------------------------------
// v0.58 "mesh-only messaging" branch: HIVECTL_MESSAGE_CHILD / HIVECTL_MESSAGE_PARENT.
// Native SEND subcommands are now guard-blocked; every LIFECYCLE verb
// (create/list/check-merge/merge) and the read-only message-count counter stay
// default-allow — breaking those would break DevSwarm spawn/merge.

// --- POSITIVE: real message-child/message-parent sends, smuggled forms too ---
const HIVECTL_MESSAGE_BLOCK = [
  'hivecontrol workspace message-parent "status update"',
  'hivecontrol workspace message-child "status update"',
  'bash -c "hivecontrol workspace message-parent hi"',
  '$(hivecontrol workspace message-child hi)',
  'echo hi && hivecontrol workspace message-parent hi',
  'hivecontrol --json workspace message-parent hi', // flag insertion must not bypass
];
for (const cmd of HIVECTL_MESSAGE_BLOCK) {
  test(`DEVSWARM MESSAGE-SEND BLOCK: ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
    assert.ok(/DEVSWARM MESH-ONLY MESSAGING/.test(r.json.reason), `reason must name the mesh-only-messaging rule; got=${r.json.reason}`);
  });
}

// REGRESSION (P0, live-verified bypass): quoting message-parent/message-child (or
// the hivecontrol verb) does NOT change argv, so it must block IDENTICALLY to the
// unquoted form. Previously ran against neutralizeQuotedContents(seg), which
// BLANKS quoted content, so every quoted variant sailed through (exit 0) — this
// defeated v0.58's headline invariant (mesh store is the SOLE agent-initiated
// transport), and was trivially reachable since the block reason echoes the exact
// blocked subcommand back, inviting a quoted retry.
const HIVECTL_MESSAGE_QUOTE_BYPASS_BLOCK = [
  'hivecontrol workspace "message-parent" hi',
  "hivecontrol workspace 'message-parent' hi",
  'hivecontrol workspace mes"sage-par"ent hi',
  '"hivecontrol" workspace message-parent hi',
  'hivecontrol workspace "message-child" hi',
  "hivecontrol workspace 'message-child' hi",
  'hivecontrol workspace mes"sage-chi"ld hi',
  '"hivecontrol" workspace message-child hi',
];
for (const cmd of HIVECTL_MESSAGE_QUOTE_BYPASS_BLOCK) {
  test(`DEVSWARM MESSAGE-SEND BLOCK (quote-bypass regression): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block for: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

test('DEVSWARM MESSAGE-SEND BLOCK: fires in SUBAGENT context too (all-contexts, like devswarm-read-guard)', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, { agentId: 'sub' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND reason redirects to the mesh CLI (send / heartbeat)', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi');
  assert.strictEqual(r.status, 2);
  assert.ok(/devswarm\.js send/.test(r.json.reason), `reason must redirect to devswarm.js send; got=${r.json.reason}`);
  assert.ok(/devswarm\.js heartbeat/.test(r.json.reason), `reason must redirect to devswarm.js heartbeat; got=${r.json.reason}`);
  assert.ok(/DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason), 'reason must name the kill-switch');
});

test('DEVSWARM MESSAGE-SEND INJECTION: block reason does not echo command text', () => {
  const r = runDevswarm('hivecontrol workspace message-parent "INJECTSECRET"');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

// --- NEGATIVE: lifecycle verbs, message-count, and DATA mentions must ALLOW ---
const HIVECTL_MESSAGE_ALLOW = [
  'hivecontrol workspace create feature-x',
  'hivecontrol workspace list',
  'hivecontrol workspace check-merge',
  'hivecontrol workspace merge',
  'hivecontrol workspace merge-into-source',
  'hivecontrol workspace message-count',
  // Quoted DATA / grep of a string mentioning the subcommand name — verb is
  // grep, not hivecontrol -> must never classify as a send.
  'grep message-parent docs/KB.md',
  'grep -n "hivecontrol workspace message-parent" docs/KB.md',
];
for (const cmd of HIVECTL_MESSAGE_ALLOW) {
  test(`DEVSWARM MESSAGE-SEND ALLOW (lifecycle/count/data): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --help/-h: a read-only usage invocation of message-child/message-parent
// never sends anything — must not be blocked identically to the real send.
const HIVECTL_MESSAGE_HELP_ALLOW = [
  'hivecontrol workspace message-child --help',
  'hivecontrol workspace message-parent -h',
  'devswarm workspace message-child --help',
];
for (const cmd of HIVECTL_MESSAGE_HELP_ALLOW) {
  test(`DEVSWARM MESSAGE-SEND ALLOW (--help/-h read-only): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// A --help on one chained segment must not shield a separate, real send.
test('DEVSWARM MESSAGE-SEND BLOCK: --help on one segment does not shield a chained real send', () => {
  const r = runDevswarm('hivecontrol workspace message-child --help ; hivecontrol workspace message-child x');
  assert.strictEqual(r.status, 2, `expected block for chained real send\nstdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

// --- SKIP (own name `devswarm-send-guard`, independent of devswarm-read-guard
// and command-guard's own skip) ---
test('DEVSWARM MESSAGE-SEND SKIP: devswarm-send-guard skipped -> message-parent allowed', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'devswarm-send-guard': FUTURE },
  });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND SKIP: devswarm-read-guard skip does NOT cover message-parent', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'devswarm-read-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND SKIP: command-guard skip does NOT cover message-parent', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', {}, {
    skip: { 'command-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND KILL-SWITCH: DISABLE_ANTIHALL_DEVSWARM=1 -> message-parent allowed', () => {
  const r = runDevswarm('hivecontrol workspace message-parent hi', { DISABLE_ANTIHALL_DEVSWARM: '1' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM MESSAGE-SEND gate off: non-DevSwarm coordinator allows message-parent', () => {
  const r = runCoord('hivecontrol workspace message-parent hi');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// --- EXEMPTION confirmation: the devswarm.js carve-out already covers every
// mesh coordination verb (generic, no subcommand restriction) ---
const DEVSWARM_JS_MESH_VERB_ALLOW = [
  'node scripts/devswarm.js send --to-primary --message "hi"',
  'node scripts/devswarm.js heartbeat w1 --summary "status"',
  'node scripts/devswarm.js roster',
  'node scripts/devswarm.js mesh read',
  'node scripts/devswarm.js inbox read-primary w1',
  'node scripts/devswarm.js archive-request w1',
  'node scripts/devswarm.js reconcile',
];
for (const cmd of DEVSWARM_JS_MESH_VERB_ALLOW) {
  test(`COORD ALLOW (mesh CLI verb, devswarm.js carve-out): ${cmd}`, () => {
    const r = runCoord(cmd);
    assert.strictEqual(r.status, 0, `expected allow for: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// --- SKIP (own name, independent of command-guard) ---
const FUTURE = Date.now() + 60 * 60 * 1000;
test('DEVSWARM SKIP: devswarm-read-guard skipped -> monitor allowed', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { 'devswarm-read-guard': FUTURE },
  });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('DEVSWARM SKIP: command-guard skipped but devswarm-read-guard NOT -> monitor still blocks', () => {
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { 'command-guard': FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('DEVSWARM SKIP: blanket {all} does NOT cover devswarm-read-guard -> monitor still blocks', () => {
  // devswarm-read-guard is in skip-guard's DESTRUCTIVE set (irreversible native-queue
  // drain), so a broad {all} skip must NOT silence it — only an explicit name does.
  const r = runDevswarm('hivecontrol workspace monitor', {}, {
    skip: { all: FUTURE },
  });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- GATE OFF: non-DevSwarm env ---
test('NON-DEVSWARM coordinator allows monitor (gate off)', () => {
  // No DEVSWARM_REPO_ID -> isDevswarmActive false -> branch dormant; hivecontrol is
  // not a HEAVY_VERB so the heavy gate does not fire either -> allow.
  const r = runCoord('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// --- REASON HYGIENE ---
test('DEVSWARM monitor reason does NOT claim a message-count 0 means empty', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && !/message-count/.test(r.json.reason),
    'monitor reason must not tell the user message-count reflects emptiness');
});

test('DEVSWARM read-messages reason: message-count caveat states NATIVE-queue-only', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', DURABLE_ENV);
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /message-count/.test(r.json.reason) && /NATIVE/i.test(r.json.reason),
    'read-messages reason must caveat message-count as native-queue-only');
});

test('DEVSWARM block reason names ANTIHALL_DEVSWARM_INBOX_CMD when it is set', () => {
  const r = runDevswarm('hivecontrol workspace read-messages', DURABLE_ENV);
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /ANTIHALL_DEVSWARM_INBOX_CMD/.test(r.json.reason),
    'reason should name the durable-inbox env var when configured');
});

test('DEVSWARM block reason omits the env var when it is unset', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && !/ANTIHALL_DEVSWARM_INBOX_CMD/.test(r.json.reason),
    'reason should NOT mention the env var when it is not configured');
});

test('DEVSWARM block reason includes the do-not-delegate line', () => {
  const r = runDevswarm('hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2);
  assert.ok(r.json && /do not delegate/i.test(r.json.reason),
    'reason must warn that delegating the read drains the queue identically');
});

test('DEVSWARM INJECTION: block reason does not echo command text', () => {
  const r = runDevswarm('hivecontrol workspace monitor # INJECTSECRET');
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect command text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect command text');
});

// --- FIX 3: command-position anchoring drops the unquoted-args false-positive ---
// Unquoted args that are literally these words in order but whose command VERB is
// grep/echo (not hivecontrol) must ALLOW — hivecontrol is not at command position.
const HIVECTL_ALLOW_UNQUOTED_ARGS = [
  'grep hivecontrol workspace monitor docs/KB.md',
  'echo hivecontrol workspace monitor',
];
for (const cmd of HIVECTL_ALLOW_UNQUOTED_ARGS) {
  test(`DEVSWARM ALLOW (unquoted args, verb not hivecontrol): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `expected allow: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// A path-/wrapper-prefixed hivecontrol IS still the verb -> must STILL block
// (guards that the anchoring did not weaken smuggling detection).
test('DEVSWARM BLOCK: /usr/bin/hivecontrol workspace monitor (path prefix, still verb)', () => {
  const r = runDevswarm('/usr/bin/hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});
test('DEVSWARM BLOCK: sudo hivecontrol workspace monitor (wrapper, still verb)', () => {
  const r = runDevswarm('sudo hivecontrol workspace monitor');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// --- FIX 4 (SUPERSEDED by the dequote fix): these two quote-split forms were
// previously documented as an ACCEPTED, out-of-scope limitation, because the old
// matcher ran against neutralizeQuotedContents (which BLANKS quoted content) —
// that made the split-quote obfuscation indistinguishable from a genuine bypass.
// dequoteSegment (the P0 fix below) recovers the literal argv text for ANY
// quote-delimited split, not just the specific message-parent/monitor examples,
// so these now correctly BLOCK too (a strict improvement, not a regression). Only
// TRUE shell-expansion forms (parameter/command substitution, which need a full
// shell-expansion simulation to resolve) remain out of scope — see
// HIVECTL_ACCEPTED_SHELL_EXPANSION below. ---
const HIVECTL_NOW_BLOCKED_QUOTE_SPLIT = [
  "hiv'ec'ontrol workspace monitor",   // verb dequotes to hivecontrol
  "hivecontrol workspace 'mon'itor",   // subcommand dequotes to monitor
];
for (const cmd of HIVECTL_NOW_BLOCKED_QUOTE_SPLIT) {
  test(`DEVSWARM BLOCK (quote-split, previously an accepted gap — now fixed): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 2, `expected block: ${cmd}\nstdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

// --- ACCEPTED LIMITATION (still out of scope): forms that only synthesize the
// verb/subcommand via shell PARAMETER or COMMAND expansion need a full
// shell-expansion simulation to resolve, which this drift-guard does not attempt
// (it defends against accidental and quote-obfuscated destructive reads, not a
// determined shell-expansion bypass). ---
const HIVECTL_ACCEPTED_SHELL_EXPANSION = [
  'mon=itor; hivecontrol workspace $mon',   // resolved only after variable expansion
];
for (const cmd of HIVECTL_ACCEPTED_SHELL_EXPANSION) {
  test(`DEVSWARM accepted-limitation (shell expansion NOT caught, allows): ${cmd}`, () => {
    const r = runDevswarm(cmd);
    assert.strictEqual(r.status, 0, `documented accepted bypass should allow: ${cmd}\nstdout: ${r.stdout}`);
  });
}

// ---------------------------------------------------------------------------
// Bash file-read branch (item 3): detectProtectedFileRead — closes the `cat`/`head`
// bypass that this Bash-verb-only guard could not otherwise see. Paths are built
// ABSOLUTE under the fresh fake HOME's ~/.anti-hall/devswarm root (the real inbox
// location), so classification resolves unambiguously. Store-CLI-present gating is
// exercised at the classifier UNIT level (inbox-read-guard.test.js); here the store
// probe finds NO listMessages yet, so a raw store read fails OPEN (ALLOW) — proving
// a pre-#13 Primary is never bricked.
// runDevswarmFileRead(mkCommand) — DevSwarm-active, fresh HOME; mkCommand(dsRoot)
// receives the absolute devswarm root and returns the command string to test.
function runDevswarmFileRead(mkCommand) {
  const h = makeHome();
  try {
    const dsRoot = pathx.join(h.antiHall, 'devswarm');
    return testHook(HOOK, bashPayload(mkCommand(dsRoot)), {
      home: h.home,
      env: DEVSWARM_COORD,
    });
  } finally {
    h.cleanup();
  }
}

// BLOCK: an unquoted `cat`/`head`/… of the raw inbox NDJSON (inbox deny is NOT gated).
test('DEVSWARM FILE-READ BLOCK: cat of the raw inbox ndjson', () => {
  const r = runDevswarmFileRead((root) => `cat ${pathx.join(root, 'inbox', 'x.ndjson')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
  assert.ok(/CURSOR DESYNC/.test(r.json.reason) && /does NOT drain the queue/.test(r.json.reason),
    'reason must use the accurate cursor-desync harm model (append-only, not a drain)');
});

// BLOCK: head/tail forms of the inbox also block.
test('DEVSWARM FILE-READ BLOCK: head of the raw inbox ndjson', () => {
  const r = runDevswarmFileRead((root) => `head -n 5 ${pathx.join(root, 'inbox', 'x.ndjson')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

// Store deny is self-healing: it arms once devswarm-store.js exposes the read-CLI
// (listMessages), which has landed -> a raw `head` of the store db BLOCKS. The
// fail-OPEN-when-absent direction is covered by the classifier UNIT test (CLI_OFF)
// in inbox-read-guard.test.js.
test('DEVSWARM FILE-READ BLOCK: head of store db (read-CLI present -> gate armed)', () => {
  const r = runDevswarmFileRead((root) => `head ${pathx.join(root, 'store', 'devswarm.db')}`);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && /STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
});

// REGRESSION (P1): a raw inbox/store path QUOTED with double or single quotes is a
// completely normal, everyday shell pattern — it must block IDENTICALLY to the
// unquoted form. Previously the segment was neutralized (quoted content blanked to
// spaces) BEFORE path classification, so the quoted path argument became invisible
// to detectProtectedFileRead and the read sailed through (exit 0). Verified fixed:
// unquoted / double-quoted / single-quoted all now classify the SAME path text.
const QUOTE_FORMS = [
  ['unquoted', (p) => p],
  ['double-quoted', (p) => `"${p}"`],
  ['single-quoted', (p) => `'${p}'`],
];
for (const verb of ['cat', 'head', 'tail']) {
  for (const [label, quote] of QUOTE_FORMS) {
    test(`DEVSWARM FILE-READ BLOCK (regression): ${verb} of ${label} raw inbox ndjson`, () => {
      const r = runDevswarmFileRead((root) => `${verb} ${quote(pathx.join(root, 'inbox', 'w1.ndjson'))}`);
      assert.strictEqual(r.status, 2, `expected block for ${label} ${verb}\nstdout: ${r.stdout}`);
      assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
    });
    test(`DEVSWARM FILE-READ BLOCK (regression): ${verb} of ${label} raw store db`, () => {
      const r = runDevswarmFileRead((root) => `${verb} ${quote(pathx.join(root, 'store', 'devswarm.db'))}`);
      assert.strictEqual(r.status, 2, `expected block for ${label} ${verb}\nstdout: ${r.stdout}`);
      assert.ok(r.json && /STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
    });
  }
}

// ALLOW: reads of the ALLOW-taxonomy surfaces (summary/cursors/workspaces), both
// unquoted and double-quoted (the quoted form must resolve identically, not merely
// "not block" — it must classify the SAME non-protected path).
const FILE_READ_ALLOW = [
  (root) => `cat ${pathx.join(root, 'summary.json')}`,
  (root) => `cat ${pathx.join(root, 'cursors', 'x.cursor')}`,
  (root) => `cat ${pathx.join(root, 'workspaces', 'x.json')}`,
  (root) => `cat "${pathx.join(root, 'summary.json')}"`,
  (root) => `cat "${pathx.join(root, 'cursors', 'x')}"`,
];
for (let i = 0; i < FILE_READ_ALLOW.length; i++) {
  test(`DEVSWARM FILE-READ ALLOW (non-protected surface #${i})`, () => {
    const r = runDevswarmFileRead(FILE_READ_ALLOW[i]);
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

// ALLOW: quoted DATA that mentions the inbox path must NOT block — `echo` is not a
// read verb, and grep/sed/awk's first non-flag operand is a PATTERN/script (never
// classified as a path), so only a TRAILING file operand can trip the classifier.
test('DEVSWARM FILE-READ ALLOW: echo of a quoted inbox path (echo is not a read verb)', () => {
  const r = runDevswarmFileRead((root) => `echo "${pathx.join(root, 'inbox', 'x.ndjson')}"`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
test('DEVSWARM FILE-READ ALLOW: grep with a quoted bare-word PATTERN over a non-protected file', () => {
  const r = runDevswarmFileRead(() => `grep 'inbox' docs/KB.md`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
test('DEVSWARM FILE-READ ALLOW: grep with the literal inbox path AS THE PATTERN (not a file operand)', () => {
  const r = runDevswarmFileRead((root) => `grep -n '${pathx.join(root, 'inbox', 'x')}' docs/KB.md`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// Subagent context (agent_id in payload): the file-read branch fires in ALL contexts.
test('DEVSWARM FILE-READ BLOCK: inbox cat in SUBAGENT context (all-contexts)', () => {
  const h = makeHome();
  try {
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`, { agentId: 'sub' }), {
      home: h.home, env: DEVSWARM_COORD,
    });
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// SKIP: an explicit devswarm-read-guard skip allows the raw file read.
test('DEVSWARM FILE-READ SKIP: devswarm-read-guard skipped -> inbox cat allowed', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-read-guard': Date.now() + 60 * 60 * 1000 });
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`), { home: h.home, env: DEVSWARM_COORD });
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// GATE OFF: without DevSwarm active, a raw inbox cat is NOT the guard's concern -> allow.
test('DEVSWARM FILE-READ gate off: inbox cat allowed when DevSwarm inactive', () => {
  const h = makeHome();
  try {
    const p = pathx.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
    const r = testHook(HOOK, bashPayload(`cat ${p}`), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WORKSPACE-TIER REDIRECT on the HEAVY-COMMAND block (P0: the block reason used to
// name "spawn a subagent" as the only exit even for a DevSwarm PRIMARY, at the exact
// decision point where a workspace-scale matter should have been spun as a child
// workspace). WHAT is blocked is unchanged (same isHeavyCommand decision, same exit 2);
// only the redirect TEXT changes, and only for a Primary.

// Heavy-command run under an explicit env (DevSwarm Primary / child / none).
function runHeavy(command, extraEnv) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), {
      home: h.home,
      env: Object.assign({}, COORD, extraEnv || {}),
    });
  } finally {
    h.cleanup();
  }
}

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-x' }; // no SOURCE_BRANCH -> Primary
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y' };

// The exact pre-fix baseline reason (npm run build -> verb npm).
const BASELINE_REASON =
  'COMMAND-DELEGATION RULE: heavy/long/state-changing commands must NEVER run ' +
  'inline in the main coordinator context — they fill the main thread with raw ' +
  'output and the most counterproductive thing a coordinator can do. ' +
  'DELEGATE to a subagent (cheap model: Haiku or similar): ' +
  'spawn a subagent, pass the command, let it run and return only a tight ' +
  'summary. The coordinator synthesizes the summary; raw output never reaches ' +
  'the main thread. Heavy command detected (verb: npm) — delegate to a subagent. ' +
  'Verifying delegated work with a bounded single-target check is allowed: pipe it to tail/head/grep -c.';

test('DEVSWARM PRIMARY heavy command: still BLOCKED, reason names `devswarm.js spawn` as the primary exit', () => {
  const r = runHeavy('npm run build', PRIMARY_ENV);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'block decision unchanged for a Primary');
  const reason = r.json.reason;
  assert.ok(/devswarm\.js spawn <branch> -p/.test(reason),
    `Primary reason must name devswarm.js spawn: ${reason}`);
  assert.ok(/workspace-scale/i.test(reason), `Primary reason must state the choice rule: ${reason}`);
  assert.ok(reason.indexOf('devswarm.js spawn') < reason.indexOf('subagent'),
    `workspace exit must precede the subagent alternative: ${reason}`);
  assert.ok(/Do NOT hand a workspace-scale matter to a subagent/.test(reason),
    `Primary reason must forbid subagent-for-workspace-scale: ${reason}`);
  // Classification detail is still carried through unchanged.
  assert.ok(/\(verb: npm\)/.test(reason), `heavy classification must survive: ${reason}`);
});

test('DEVSWARM CHILD heavy command: reason is byte-for-byte the baseline (no workspace redirect)', () => {
  const r = runHeavy('npm run build', CHILD_ENV);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.strictEqual(r.json.reason, BASELINE_REASON);
});

test('NON-DEVSWARM heavy command: reason is byte-for-byte the baseline (no DevSwarm text)', () => {
  const r = runHeavy('npm run build');
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.strictEqual(r.json.reason, BASELINE_REASON);
  assert.ok(!/devswarm/i.test(r.stdout), 'non-DevSwarm output must not mention DevSwarm');
});

// The redirect points at a command the Primary can actually RUN inline: command-guard's
// own LIGHT_EXCEPTION must exempt scripts/devswarm.js, or the fix would be a catch-22.
test('DEVSWARM PRIMARY: the redirect target (`node scripts/devswarm.js spawn ...`) is itself NOT blocked', () => {
  const r = runHeavy('node scripts/devswarm.js spawn feature/x -p "own the API layer"', PRIMARY_ENV);
  assert.strictEqual(r.status, 0, `redirect target must run inline; stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// BINARY-NAME PARITY (regression): `hivecontrol` is a 6-line sh shim that `exec`s
// its sibling `devswarm` binary — `devswarm` is the PRIMARY name, `hivecontrol`
// the alias, and both are on PATH as the SAME program. The guard previously
// anchored its destructive-read / message-send detection on the literal verb
// `hivecontrol` only, so the byte-identical `devswarm workspace monitor` /
// `read-messages` / `message-child` / `message-parent` forms sailed through
// (exit 0) while `hivecontrol ...` correctly blocked. Every assertion below runs
// for BOTH binary names to prove they are now equivalent everywhere the guard
// reasons about the DevSwarm CLI verb.
for (const bin of ['hivecontrol', 'devswarm']) {
  test(`DEVSWARM PARITY (${bin}) BLOCK: workspace monitor`, () => {
    const r = runDevswarm(`${bin} workspace monitor`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });

  test(`DEVSWARM PARITY (${bin}) BLOCK: workspace read-messages`, () => {
    const r = runDevswarm(`${bin} workspace read-messages`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });

  test(`DEVSWARM PARITY (${bin}) BLOCK: workspace message-child`, () => {
    const r = runDevswarm(`${bin} workspace message-child "hi"`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });

  test(`DEVSWARM PARITY (${bin}) BLOCK: workspace message-parent`, () => {
    const r = runDevswarm(`${bin} workspace message-parent "hi"`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });

  test(`DEVSWARM PARITY (${bin}) ALLOW: message-count (non-destructive)`, () => {
    const r = runDevswarm(`${bin} workspace message-count`);
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });

  test(`DEVSWARM PARITY (${bin}) ALLOW: lifecycle verb (workspace create)`, () => {
    const r = runDevswarm(`${bin} workspace create feature-x`);
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });

  test(`DEVSWARM PARITY (${bin}) BLOCK: absolute-path invocation basenames to ${bin}`, () => {
    const r = runDevswarm(`/Applications/DevSwarm.app/Contents/Resources/cli/${bin} workspace monitor`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });

  test(`DEVSWARM PARITY (${bin}) BLOCK: bash -c "..." nested form`, () => {
    const r = runDevswarm(`bash -c "${bin} workspace monitor"`);
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  });
}

// The anti-hall wrapper exemption (`node scripts/devswarm.js ...`) must keep
// working — its effectiveVerb is `node`, not `devswarm`/`hivecontrol`, so
// widening the verb set to include `devswarm` must NOT collide with the fact
// that `scripts/devswarm.js` literally contains the word "devswarm". Highest
// risk part of the fix: a false positive here would break anti-hall's own
// inbox/spawn/merge wrappers.
test('DEVSWARM PARITY: `node scripts/devswarm.js inbox pull x` still ALLOWED (no false positive)', () => {
  const r = runCoord('node scripts/devswarm.js inbox pull x');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
test('DEVSWARM PARITY: `node scripts/devswarm.js inbox pull x` ALLOWED under active DevSwarm too', () => {
  const r = runDevswarm('node scripts/devswarm.js inbox pull x');
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// P2 fp dd88d2a72562 / b183a9f1bbd5: DATA is not a COMMAND.
//
// dd88d2a72562: a `devswarm.js send` whose MESSAGE BODY (carried in a heredoc,
// the realistic shape for a multi-line mesh message: `... --message-file - <<
// 'EOF' ... EOF`) contains a heavy verb as ordinary prose ("make sure to...")
// was blocked, because command-guard's splitSegments had NO heredoc handling:
// each heredoc BODY LINE is an
// ordinary '\n'-delimited segment, and a body line that happens to START with
// a HEAVY_VERB word ("make") gets effectiveVerb === 'make' and is
// misclassified as an executed command instead of message text.
//
// b183a9f1bbd5: same family — a read-only `grep`/`sed`/`awk` invocation whose
// SEARCH PATTERN argument contains heavy-looking text (data describing what
// to search for) was scanned as if that text were command content.
//
// FIX: (1) command-guard's splitSegments now has its own HEREDOC_RE handling
// — the heredoc BODY is skipped entirely, never
// re-split into segments/commands (only the opener line, e.g. `<<'EOF'`,
// stays part of the invoking segment). (2) isHeavySegment now blanks the
// first non-flag operand of a PATTERN_FIRST_VERBS command (grep/sed/awk)
// before running HEAVY_PATTERNS against it, mirroring the existing
// skipNextOperand discipline in detectProtectedFileRead.
//
// MUTATION LIST (apply each, prove RED, then revert -> GREEN):
//   M1: revert the heredoc-skip in splitSegments (drop the `<<` handling
//       block, restoring the pre-fix function) -> HEREDOC_BLOCK below must
//       flip from allow (0) to block (2).
//   M2: revert blankPatternArgument (make it a no-op passthrough, or remove
//       its call in isHeavySegment) -> GREP_PATTERN_BLOCK below must flip
//       from allow (0) to block (2).
// Both mutations were applied by hand against the working tree, run, and
// confirmed RED (see PR/report evidence); the current tree is the fixed
// (GREEN) state.
// ---------------------------------------------------------------------------

test('P2 fp dd88d2a72562 FIX: devswarm.js send heredoc message BODY containing "make" is ALLOWED', () => {
  const command =
    "node scripts/devswarm.js send --to parent --message-file - <<'EOF'\n" +
    'make sure to update the docs before merging\n' +
    'EOF';
  const r = runCoord(command);
  assert.strictEqual(r.status, 0, `heredoc message body must not be parsed as a command; stdout: ${r.stdout}`);
});

test('P2 fp dd88d2a72562 NEGATIVE CONTROL: a REAL heavy command AFTER the heredoc terminator still BLOCKS', () => {
  // Proves the heredoc-skip only skips the BODY up to its terminator line —
  // it must not swallow subsequent real commands on later lines.
  const command = "cat <<'EOF'\nsome message\nEOF\nnpm run build";
  const r = runCoord(command);
  assert.strictEqual(r.status, 2, `command after heredoc terminator must still block; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('P2 fp dd88d2a72562 NEGATIVE CONTROL: heredoc whose OUTER/opener command is itself heavy stays BLOCKED', () => {
  // Proves the heredoc fix does not exempt a genuinely heavy invoking command
  // just because it happens to carry a heredoc tail.
  const command = "node build.js <<'EOF'\nunrelated body text\nEOF";
  const r = runCoord(command);
  assert.strictEqual(r.status, 2, `heavy opener command must still block despite heredoc tail; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('P2 fp b183a9f1bbd5 FIX: heavy-looking text inside a grep SEARCH PATTERN is ALLOWED', () => {
  // Realistic read-only inspection shape (`git show <ref>:<path> | grep ...`):
  // segment 2's PATTERN operand contains heavy-verb text ("npm run deploy")
  // that must be read as DATA, not command text.
  const command = 'git show HEAD:.github/workflows/ci.yml | grep npm run deploy';
  const r = runCoord(command);
  assert.strictEqual(r.status, 0, `grep pattern content must not be parsed as a command; stdout: ${r.stdout}`);
});

test('P2 fp b183a9f1bbd5 NEGATIVE CONTROL: a REAL heavy command chained after the grep still BLOCKS', () => {
  // Proves blanking the grep pattern operand does not blind the guard to a
  // genuinely heavy command elsewhere in the same command line.
  const command = "grep -r 'npm run build' src/ && npm run build";
  const r = runCoord(command);
  assert.strictEqual(r.status, 2, `chained real heavy command must still block; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});

test('P2 fp b183a9f1bbd5 NEGATIVE CONTROL: grep verb itself unaffected when a HEAVY_VERB leads its OWN segment', () => {
  // `make` as the actual command verb (not inside a search pattern) must
  // still block — proves the pattern-blanking fix is scoped to grep/sed/awk
  // pattern operands only, not a general HEAVY_VERBS softening.
  const command = 'make deploy';
  const r = runCoord(command);
  assert.strictEqual(r.status, 2, `a real 'make' invocation must still block; stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block');
});
