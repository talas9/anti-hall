#!/usr/bin/env python3
"""Codex payload corpus and engine-only replay (v1.0 lane L16, issue #75).

  codex_replay.py build   record the corpus (corpus.ndjson) from real Codex rollouts (~/.codex/sessions, read only) and from the
                          frozen Claude replay sample, mapped to the Codex payload shape (tool names, apply_patch patch text in
                          tool_input.command, turn_id/model, rollout transcripts copied to a frozen directory)
  codex_replay.py run <node|engine>
                          replay the corpus; `node` runs every Codex hook row of hooks/ah-fallback.codex.list the way the host
                          does, `engine` runs `ah-engine hook --host codex` with the Node fallback DISABLED (every fallback row
                          only records its id, so a row the engine does not answer shows as a defer)
  codex_replay.py compare classify every call: identical / text-only / stricter / advisory-dropped / WEAKER / deferred, and split
                          the WEAKER ones into those explained by a recorded engine defer row and the unexplained ones (must be 0)

Everything lives under a work directory (default ~/.anti-hall/work/replay-codex, --work); each side gets its own HOME and its own copy
of one pristine sandbox, so no side sees state the other wrote and the real HOME / ~/.codex are never written. Python standard
library only; this is measurement tooling, not part of the shipped plugin.
"""
import argparse, collections, json, os, random, re, shutil, subprocess, sys, time

HOME = os.path.expanduser('~')
CODEX_EVENTS = {'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop'}
PATCH_FILE = re.compile(r'^\*\*\* (Add|Update|Delete) File: (.+)$', re.M)
PATCH_MOVE = re.compile(r'^\*\*\* Move to: (.+)$', re.M)


def args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['build', 'run', 'compare'])
    ap.add_argument('side', nargs='?', choices=['node', 'engine'])
    ap.add_argument('--work', default=HOME + '/.anti-hall/work/replay-codex')
    ap.add_argument('--plugin', default=os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../plugins/anti-hall')))
    ap.add_argument('--bin', default=HOME + '/.anti-hall/work/live11-bin/ah-engine', help='engine binary (engine side)')
    ap.add_argument('--claude-sample', default=HOME + '/.anti-hall/work/replay/sample-frozen.ndjson')
    ap.add_argument('--sessions', default=HOME + '/.codex/sessions')
    ap.add_argument('--tag', default='')
    ap.add_argument('--bash', type=int, default=500)
    ap.add_argument('--patches', type=int, default=300)
    ap.add_argument('--seed', type=int, default=16)
    return ap.parse_args()


# ---- build ---------------------------------------------------------------------------------------------------------------

def rollouts(root):
    out = []
    for dp, _, fs in os.walk(root):
        out += [os.path.join(dp, f) for f in fs if f.endswith('.jsonl')]
    return sorted(out)


def scan_rollouts(root, rng, want_bash, want_patch, want_spawn):
    """Real Codex tool calls: shell commands (exec_command), apply_patch inputs and spawn_agent calls, reservoir-sampled."""
    res = {'bash': [], 'patch': [], 'spawn': []}
    seen = collections.Counter()
    want = {'bash': want_bash, 'patch': want_patch, 'spawn': want_spawn}
    files = rollouts(root)
    rng.shuffle(files)
    for f in files[:3000]:
        try:
            lines = open(f, errors='replace').read().splitlines()
        except OSError:
            continue
        for l in lines:
            if '"function_call"' not in l and '"custom_tool_call"' not in l:
                continue
            try:
                p = json.loads(l).get('payload', {})
            except ValueError:
                continue
            kind = item = None
            if p.get('name') == 'exec_command':
                try:
                    a = json.loads(p.get('arguments') or '{}')
                except ValueError:
                    continue
                if isinstance(a.get('cmd'), str) and a['cmd'].strip():
                    kind, item = 'bash', {'command': a['cmd']}
            elif p.get('name') == 'apply_patch' and isinstance(p.get('input'), str):
                kind, item = 'patch', {'command': p['input']}
            elif p.get('name') == 'spawn_agent':
                try:
                    a = json.loads(p.get('arguments') or '{}')
                except ValueError:
                    continue
                kind, item = 'spawn', a
            if kind is None:
                continue
            seen[kind] += 1
            if len(res[kind]) < want[kind]:
                res[kind].append(item)
            else:
                j = rng.randrange(seen[kind])
                if j < want[kind]:
                    res[kind][j] = item
    return res


def sandbox_path(path, sb):
    """A real project path becomes a path in the sandbox (the replay never reads the owner's projects)."""
    if path.startswith('/'):
        m = re.match(r'/Users/[^/]+/Projects/[^/]+/(.*)$', path) or re.match(r'/private/tmp/[^/]+/[^/]+/[^/]+/scratchpad/(.*)$', path)
        return sb + '/' + (m.group(1) if m else path.lstrip('/').replace('/', '_'))
    return path


def localize_patch(patch, sb):
    def rep(m):
        return '*** %s File: %s' % (m.group(1), sandbox_path(m.group(2).strip(), sb))
    patch = PATCH_FILE.sub(rep, patch)
    return PATCH_MOVE.sub(lambda m: '*** Move to: ' + sandbox_path(m.group(1).strip(), sb), patch)


def claude_edit_to_patch(ti, sb):
    """The apply_patch text Codex sends for a Claude Write/Edit tool_input."""
    fp = sandbox_path(ti.get('file_path') or 'file.txt', sb)
    if 'content' in ti:
        body = ''.join('+' + l + '\n' for l in str(ti['content']).split('\n'))
        return '*** Begin Patch\n*** Add File: %s\n%s*** End Patch\n' % (fp, body)
    old = ''.join('-' + l + '\n' for l in str(ti.get('old_string', '')).split('\n'))
    new = ''.join('+' + l + '\n' for l in str(ti.get('new_string', '')).split('\n'))
    return '*** Begin Patch\n*** Update File: %s\n@@\n%s%s*** End Patch\n' % (fp, old, new)


def build(a):
    rng = random.Random(a.seed)
    work = a.work
    sb = work + '/sandbox-pristine'
    frozen = work + '/frozen'
    shutil.rmtree(frozen, ignore_errors=True)
    os.makedirs(frozen)
    shutil.rmtree(sb, ignore_errors=True)
    os.makedirs(sb)
    subprocess.run(['git', 'init', '-q', sb], check=True)
    for name, text in (('README', 'x\n'), ('app.py', 'import os\nprint(os.getcwd())\n'), ('notes.md', '# notes\n')):
        open(sb + '/' + name, 'w').write(text)
    calls = []

    def add(ev, payload):
        calls.append({'idx': len(calls), 'ev': ev, 'payload': payload})

    base = {'session_id': '00000000-0000-4000-8000-0000000000c0', 'cwd': sb, 'model': 'gpt-5', 'turn_id': 'turn-1', 'transcript_path': None}
    # rollout transcripts the Stop / prompt hooks read: a handful of real, small ones, frozen once
    rl = [f for f in rollouts(a.sessions) if 20000 < os.path.getsize(f) < 1500000]
    rng.shuffle(rl)
    tps = []
    for i, f in enumerate(rl[:40]):
        dst = '%s/rollout%d.jsonl' % (frozen, i)
        shutil.copy2(f, dst)
        tps.append(dst)
    tp = lambda: rng.choice(tps) if tps else None

    def mk(ev, extra=None):
        p = dict(base)
        p['hook_event_name'] = ev
        p['transcript_path'] = tp()
        p['session_id'] = '%08x-0000-4000-8000-%012x' % (rng.getrandbits(32), rng.getrandbits(48))
        p.update(extra or {})
        return p

    real = scan_rollouts(a.sessions, rng, a.bash, a.patches, 40)
    for it in real['bash']:
        add('PreToolUse', mk('PreToolUse', {'tool_name': 'Bash', 'tool_input': {'command': it['command']}, 'tool_use_id': 'call_%d' % len(calls)}))
    for it in real['patch']:
        add('PreToolUse', mk('PreToolUse', {'tool_name': 'apply_patch', 'tool_input': {'command': localize_patch(it['command'], sb)}, 'tool_use_id': 'call_%d' % len(calls)}))
    for it in real['spawn']:
        add('PreToolUse', mk('PreToolUse', {'tool_name': 'spawn_agent', 'tool_input': it, 'tool_use_id': 'call_%d' % len(calls)}))
    # the Claude replay sample, mapped to the Codex shape (the events and tools Codex has)
    for l in open(a.claude_sample):
        o = json.loads(l)
        ev, p = o['ev'], o['payload']
        tool = p.get('tool_name')
        if ev not in CODEX_EVENTS and ev != 'PostToolUseFailure':
            continue
        q = mk('PostToolUse' if ev == 'PostToolUseFailure' else ev)
        for k in ('prompt', 'source', 'trigger', 'stop_hook_active', 'last_assistant_message', 'agent_id', 'agent_type', 'permission_mode'):
            if k in p:
                q[k] = p[k]
        if ev in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
            ti = p.get('tool_input') or {}
            if tool == 'Bash':
                q['tool_name'], q['tool_input'] = 'Bash', {'command': ti.get('command', '')}
            elif tool in ('Write', 'Edit'):
                q['tool_name'], q['tool_input'] = 'apply_patch', {'command': claude_edit_to_patch(ti, sb)}
            elif tool == 'Agent':
                q['tool_name'], q['tool_input'] = 'spawn_agent', {'message': ti.get('prompt', ''), 'agent_type': ti.get('subagent_type', 'default')}
            else:
                continue
            q['tool_use_id'] = 'call_%d' % len(calls)
            if ev != 'PreToolUse':
                q['tool_response'] = p.get('tool_response', '')
        elif tool:
            continue
        # PreToolUse Bash is already covered by the real commands: keep the Claude ones only for a minority
        if ev == 'PreToolUse' and tool == 'Bash' and rng.random() > 0.35:
            continue
        add('PostToolUse' if ev == 'PostToolUseFailure' else ev, q)
    for ev in ('PreCompact', 'PostCompact', 'PermissionRequest'):
        for _ in range(8):
            q = mk(ev)
            if ev == 'PermissionRequest':
                q.update(tool_name='Bash', tool_input={'command': rng.choice(['ls', 'git status', 'rm -rf build', 'git push --force'])})
            else:
                q['trigger'] = rng.choice(['manual', 'auto'])
            add(ev, q)
    with open(work + '/corpus.ndjson', 'w') as f:
        for c in calls:
            f.write(json.dumps(c) + '\n')
    c = collections.Counter((x['ev'], x['payload'].get('tool_name') or '') for x in calls)
    print('corpus: %d calls' % len(calls))
    for k, v in sorted(c.items()):
        print('  %-18s %-12s %d' % (k[0], k[1], v))


# ---- run -----------------------------------------------------------------------------------------------------------------

def matcher_ok(m, tool):
    """Codex reads every matcher as an unanchored regex; an empty or `*` matcher matches all."""
    if not m or m == '*':
        return True
    try:
        return re.search(m, tool or '') is not None
    except re.error:
        return False


def rows(plugin):
    d, ev = {}, None
    for l in open(plugin + '/hooks/ah-fallback.codex.list'):
        l = l.rstrip('\n')
        if not l or l.startswith('#'):
            continue
        if l.startswith('@'):
            ev = l[1:].split('\t')[0]
            d.setdefault(ev, [])
            continue
        m, t, c = l.split('\t', 2)
        d[ev].append((m, int(t), c))
    return d


def run(a):
    side = a.side
    work, plugin = a.work, a.plugin
    sb = '%s/sandbox%s-%s' % (work, a.tag, side)
    home = '%s/home%s-%s' % (work, a.tag, side)
    shutil.rmtree(sb, ignore_errors=True)
    shutil.copytree(work + '/sandbox-pristine', sb, symlinks=True)
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home + '/.anti-hall')
    os.makedirs(home + '/.claude')
    os.makedirs(home + '/.codex')  # a scratch .codex: the real ~/.codex is never touched
    env = dict(os.environ)
    env.update(HOME=home, ANTIHALL_INGEST_DRY_RUN='1', NODE_NO_WARNINGS='1', PLUGIN_ROOT=plugin, CLAUDE_PLUGIN_ROOT=plugin)
    for k in ('CLAUDE_CONFIG_DIR', 'AH_ENGINE_FALLBACK', 'OMC_STATE_DIR', 'CODEX_HOME'):
        env.pop(k, None)
    table = rows(plugin)
    if side == 'engine':
        st = '%s/state%s-engine' % (work, a.tag)
        shutil.rmtree(st, ignore_errors=True)
        os.makedirs(st, mode=0o700)
        env.update(AH_ENGINE_DIR=st, AH_ENGINE_PLUGIN_ROOT=plugin)
        fm = json.load(open(plugin + '/hooks/ah-fallback.codex.map.json'))
        for ev in fm:
            for i in fm[ev]:
                # engine-only: the fallback row records that the engine deferred it and runs NO Node
                fm[ev][i] = 'printf \'%%s\\n\' \'%s\' >> "$AH_REPLAY_MARK"' % i
        mp = '%s/instrumented-map%s.json' % (work, a.tag)
        json.dump(fm, open(mp, 'w'))
    out = open('%s/res%s-%s.ndjson' % (work, a.tag, side), 'w')
    t00 = time.time()
    n = 0
    for line in open(work + '/corpus.ndjson'):
        o = json.loads(line)
        ev, p = o['ev'], o['payload']
        tool = p.get('tool_name') or ''
        if isinstance(p.get('cwd'), str):
            p['cwd'] = sb
        data = json.dumps(p)
        rec = {'idx': o['idx'], 'ev': ev, 'tool': tool}
        if side == 'engine':
            mark = '%s/mark%s.txt' % (work, a.tag)
            open(mark, 'w').close()
            env['AH_REPLAY_MARK'] = mark
            cmd = [a.bin, 'hook', '--event', ev, '--host', 'codex'] + (['--tool', tool] if tool else []) + ['--fallback-map', mp]
            t0 = time.time()
            try:
                r = subprocess.run(cmd, input=data, capture_output=True, text=True, env=env, cwd=sb, timeout=30)
                rc, so, se = r.returncode, r.stdout, r.stderr
            except subprocess.TimeoutExpired:
                rc, so, se = -9, '', 'TIMEOUT'
            ran = [x for x in open(mark).read().split('\n') if x]
            sel = [r for r in table.get(ev, []) if matcher_ok(r[0], tool)]
            rec.update(rc=rc, out=so, err=se[:2000], wall_ms=round((time.time() - t0) * 1000, 1), rows_total=len(sel), fb_ids=ran)
        else:
            rc, outs, errs, t0 = 0, [], [], time.time()
            sel = [r for r in table.get(ev, []) if matcher_ok(r[0], tool)]
            for (m, t, c) in sel:
                c = c.replace('${PLUGIN_ROOT}', plugin)
                try:
                    r = subprocess.run(['sh', '-c', c], input=data, capture_output=True, text=True, env=env, cwd=sb, timeout=t)
                    hrc, so, se = r.returncode, r.stdout, r.stderr
                except subprocess.TimeoutExpired:
                    hrc, so, se = -9, '', 'TIMEOUT'
                outs.append(so)
                errs.append(se)
                if hrc == 2:
                    rc = 2
            rec.update(rc=rc, out='\n'.join(outs), err='\n'.join(e for e in errs if e)[:2000], wall_ms=round((time.time() - t0) * 1000, 1), rows_total=len(sel))
        out.write(json.dumps(rec) + '\n')
        n += 1
        if n % 100 == 0:
            print(side, n, round(time.time() - t00), flush=True)
    print(side, 'done', n, round(time.time() - t00), flush=True)


# ---- compare -------------------------------------------------------------------------------------------------------------

def classify_out(out, rc):
    rank, txt = 0, []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if not line.startswith('{'):
            txt.append(line)
            continue
        try:
            j = json.loads(line)
        except ValueError:
            txt.append(line)
            continue
        hs = j.get('hookSpecificOutput') or {}
        if j.get('decision') == 'block' or hs.get('permissionDecision') == 'deny' or j.get('continue') is False:
            rank = max(rank, 3)
        if hs.get('permissionDecision') == 'ask':
            rank = max(rank, 2)
        if hs.get('additionalContext') or j.get('systemMessage'):
            rank = max(rank, 1)
        for v in (hs.get('additionalContext'), j.get('systemMessage'), j.get('reason'), hs.get('permissionDecisionReason'), j.get('stopReason')):
            if v:
                txt.append(str(v))
    if rc == 2:
        rank = 3
    return rank, txt


def norm(t):
    t = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', t)
    t = re.sub(r'\d{4,}', '<n>', t)
    t = re.sub(r'/[^ \n"]*replay-codex/[^ \n"]*', '<replaypath>', t)
    return re.sub(r'\s+', ' ', t).strip()


def compare(a):
    load = lambda s: {json.loads(l)['idx']: json.loads(l) for l in open('%s/res%s-%s.ndjson' % (a.work, a.tag, s))}
    node, eng = load('node'), load('engine')
    CL = ['identical', 'text-only', 'stricter', 'advisory-dropped', 'WEAKER', 'deferred']
    per = collections.defaultdict(collections.Counter)
    tot = collections.Counter()
    explained = collections.Counter()
    unexplained = []
    rows_total = rows_fb = calls_native = calls = 0
    fb_by_id = collections.Counter()
    for i, e in eng.items():
        b = node.get(i)
        if b is None:
            continue
        key = (e['ev'], e['tool'])
        deferred = e['rc'] == 75 or e.get('fb_ids')
        if e['rc'] != 75 and e['rows_total']:
            calls += 1
            rows_total += e['rows_total']
            rows_fb += min(len(e['fb_ids']), e['rows_total'])
            calls_native += (not e['fb_ids'])
        for x in e.get('fb_ids', []):
            fb_by_id[x] += 1
        if e['rc'] == 75:
            cls = 'deferred'
        else:
            rb, tb = classify_out(b['out'], b['rc'])
            re_, te = classify_out(e['out'], e['rc'])
            if b['err']:
                tb.append(b['err'])
            if e['err']:
                te.append(e['err'])
            if re_ < rb:
                cls = 'WEAKER' if rb >= 2 else 'advisory-dropped'
            elif re_ > rb:
                cls = 'stricter'
            else:
                cls = 'identical' if norm(' '.join(tb)) == norm(' '.join(te)) else 'text-only'
            if cls in ('WEAKER', 'advisory-dropped'):
                if e.get('fb_ids'):
                    explained[cls] += 1
                else:
                    unexplained.append((i, cls, key))
        per[key][cls] += 1
        tot[cls] += 1
    print('| event:tool | n | ' + ' | '.join(CL) + ' |')
    print('|---|---|' + '---|' * len(CL))
    for k in sorted(per):
        print('| %s%s | %d | %s |' % (k[0], ':' + k[1] if k[1] else '', sum(per[k].values()), ' | '.join(str(per[k][c]) for c in CL)))
    print('| **TOTAL** | %d | %s |' % (sum(tot.values()), ' | '.join('**%d**' % tot[c] for c in CL)))
    print()
    print('rows: %d total, %d answered by the engine (%.1f%%); calls with no Node fallback: %d of %d' % (rows_total, rows_total - rows_fb, 100.0 * (rows_total - rows_fb) / max(rows_total, 1), calls_native, calls))
    print('WEAKER/advisory-dropped explained by a recorded engine defer row (engine-only): %s' % dict(explained))
    print('WEAKER/advisory-dropped WITHOUT any defer row (engine bug, must be 0): %d %s' % (len(unexplained), unexplained[:10]))
    print('defer rows by check:', dict(fb_by_id.most_common()))
    json.dump({'classes': tot, 'unexplained': unexplained, 'explained': explained, 'defers': fb_by_id}, open('%s/summary%s.json' % (a.work, a.tag), 'w'))
    return 1 if unexplained else 0


if __name__ == '__main__':
    A = args()
    os.makedirs(A.work, exist_ok=True)
    if A.cmd == 'build':
        build(A)
    elif A.cmd == 'run':
        if not A.side:
            sys.exit('run needs a side: node or engine')
        run(A)
    else:
        sys.exit(compare(A))
