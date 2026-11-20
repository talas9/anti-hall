#!/usr/bin/env python3
"""Replay Bash commands through the shipped command-guard script and count transcript-protection blocks (GH #802).

The corpus is a JSON list of Bash command strings (for example the real commands of past sessions that name a transcript folder;
`--scan` collects them from this machine's own transcripts). It is never committed: it holds private paths. Each command becomes a
probe case of the command golden corpus (the "802 subagent printf >> transcript" case's home, files and payload), the golden replay
test runs once with every probe, and the test's mismatch report gives each probe's verdict. tests/golden/command.jsonl is swapped
for the probes during the run and always restored.

  python3 scripts/tp-corpus-replay.py --scan corpus.json             # collect a corpus (reads ~/.claude/projects, ~/.codex/sessions)
  python3 scripts/tp-corpus-replay.py corpus.json [--out res.json]   # replay: counts + the list of blocked commands
  python3 scripts/tp-corpus-replay.py --cases probes.jsonl           # replay prepared golden-format probe cases (named by "n")

The probes run in the golden harness, which fills `{HOME}`, `{HOMEREAL}` and similar tokens in a command: a command whose own text holds
such a token (`$ENV{HOME}`, a probe generator's `'{HOMEREAL}'`) is judged on the filled text, not as it ran.

Run it from ah-engine/ (cargo builds the test binary; set CARGO_BUILD_JOBS to bound it).
"""
import glob, json, os, re, shutil, subprocess, sys

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(ENGINE, 'tests', 'golden', 'command.jsonl')
TEMPLATE = '802 subagent printf >> transcript'
INTERP = re.compile(r'(?:^|[\s;&|(/])(?:python[\d.]*|node|perl[\d.]*|ruby|deno|bun)(?:\s|$)', re.I)
BLOCK_TEXT = 'session transcript'


def scan(out):
    home = os.path.expanduser('~')
    seen, cmds = set(), []
    files = glob.glob(home + '/.claude/projects/*/*.jsonl') + glob.glob(home + '/.claude/projects/*/*/subagents/*.jsonl')
    for f in files:
        try:
            for line in open(f, errors='replace'):
                if '"Bash"' not in line or ('.claude' not in line and '.codex' not in line):
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                content = (d.get('message') or {}).get('content')
                for c in content if isinstance(content, list) else []:
                    if not (isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'Bash'):
                        continue
                    cmd = (c.get('input') or {}).get('command', '')
                    if not isinstance(cmd, str) or len(cmd) > 20000 or cmd in seen:
                        continue
                    low = cmd.lower()
                    if ('.claude/projects' in low or '.codex/sessions' in low) and INTERP.search(cmd):
                        seen.add(cmd)
                        cmds.append(cmd)
        except OSError:
            pass
    json.dump(cmds, open(out, 'w'))
    print('%d transcript files, %d commands -> %s' % (len(files), len(cmds), out))


def template(original):
    for line in original.splitlines():
        if line.strip() and json.loads(line).get('n') == TEMPLATE:
            t = json.loads(line)
            t['files']['.claude/projects/-proj/memory/a.md'] = 'x\n'
            t['files']['.claude/projects/-proj/s2.jsonl'] = '{}\n'
            t['files']['lnkc'] = {'link': '{HOMEREAL}/.claude/projects'}
            t['expect'] = {'v': 'probe'}
            return t
    sys.exit('template case %r not found in %s' % (TEMPLATE, GOLDEN))


def probes_from_corpus(path, original):
    home = os.path.expanduser('~')
    t, out = template(original), []
    for i, cmd in enumerate(json.load(open(path))):
        c = json.loads(json.dumps(t))
        c['n'] = 'PROBE %d' % i
        c['payload']['tool_input']['command'] = cmd.replace(home + '/', '{HOMEREAL}/')
        out.append(c)
    return out


def run(cases, log=None):
    original = open(GOLDEN).read()
    backup = GOLDEN + '.replay-bak'
    shutil.copyfile(GOLDEN, backup)
    try:
        with open(GOLDEN, 'w') as f:
            f.write(''.join(json.dumps(c) + '\n' for c in cases))
        env = dict(os.environ, AH_GOLDEN_ALL='1')
        r = subprocess.run(['cargo', 'test', '--lib', 'command_script_matches_the_compiled_port', '--', '--nocapture'],
                           cwd=ENGINE, env=env, capture_output=True, text=True)
    finally:
        shutil.copyfile(backup, GOLDEN)
        os.remove(backup)
    assert open(GOLDEN).read() == original
    text = r.stdout + r.stderr
    if log:
        open(log, 'w').write(text)
    got = {}
    for m in re.finditer(r'MISMATCH command n="([^"]*)"\n(?:.*\n)*?  got   =(.*)\n', text):
        g = json.loads(m.group(2))
        if g.get('v') == 'exact' and BLOCK_TEXT in g.get('err', ''):
            got[m.group(1)] = 'block'
        elif g.get('v') == 'exact' and g.get('code') == 2:
            got[m.group(1)] = 'other-block'
        else:
            got[m.group(1)] = g.get('v')
    missing = [c['n'] for c in cases if c['n'] not in got]
    if missing:
        sys.stderr.write(text[-4000:])
        sys.exit('%d probes have no verdict (first: %s)' % (len(missing), missing[0]))
    return got


def main(argv):
    if argv[:1] == ['--scan']:
        return scan(argv[1])
    out = argv[argv.index('--out') + 1] if '--out' in argv else None
    original = open(GOLDEN).read()
    if argv[:1] == ['--cases']:
        cases = [json.loads(l) for l in open(argv[1]) if l.strip()]
        for c in cases:
            c['expect'] = {'v': 'probe'}
    else:
        cases = probes_from_corpus(argv[0], original)
    got = run(cases, out + '.log' if out else None)
    counts = {}
    for v in got.values():
        counts[v] = counts.get(v, 0) + 1
    print('verdicts:', json.dumps(counts, sort_keys=True), 'of', len(cases))
    for c in cases:
        if got[c['n']] != 'allow':
            cmd = c['payload']['tool_input']['command']
            print('%-11s %s  %s' % (got[c['n']], c['n'], cmd[:160].replace('\n', ' | ')))
    if out:
        json.dump(got, open(out, 'w'), indent=0, sort_keys=True)


if __name__ == '__main__':
    main(sys.argv[1:])
