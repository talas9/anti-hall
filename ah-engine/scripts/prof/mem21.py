#!/usr/bin/env python3
"""mem21.py: memory-growth driver (#21). Starts a scratch daemon (scratch HOME, scratch socket, RSS cap lifted), replays recorded hook
payloads with transcript_path remapped to given transcript files, records RSS every --every calls.
Usage: mem21.py --bin B --plugin P --sbsrc DIR --corpus sample.ndjson --n N [--events Stop,PreToolUse] [--tx FILE ...] [--conc K]
       [--keep-tx] [--every 50] [--session-churn] [--out csv]"""
import argparse, json, os, random, socket, subprocess, sys, tempfile, shutil, threading, time
ap = argparse.ArgumentParser()
ap.add_argument('--bin', required=True); ap.add_argument('--plugin', required=True); ap.add_argument('--sbsrc', required=True)
ap.add_argument('--corpus', required=True); ap.add_argument('--n', type=int, required=True)
ap.add_argument('--events', default=''); ap.add_argument('--tx', action='append', default=[])
ap.add_argument('--conc', type=int, default=1); ap.add_argument('--every', type=int, default=50)
ap.add_argument('--keep-tx', action='store_true', help='keep the corpus transcript paths (frozen files)')
ap.add_argument('--session-churn', action='store_true'); ap.add_argument('--out'); ap.add_argument('--env', action='append', default=[])
ap.add_argument('--seed', type=int, default=1); ap.add_argument('--keep', action='store_true'); ap.add_argument('--real-state', action='store_true', help='copy the owner state (read-only source) into the scratch HOME and engine dir'); ap.add_argument('--no-dry', action='store_true')
a = ap.parse_args()
rows = [json.loads(l) for l in open(a.corpus)]
if a.events: rows = [r for r in rows if r['ev'] in a.events.split(',')]
H = tempfile.mkdtemp(prefix='ahm.', dir=os.path.expanduser('~/.anti-hall/work/mem21'))
os.makedirs(f'{H}/home/.claude'); os.makedirs(f'{H}/home/.anti-hall'); os.makedirs(f'{H}/sb')
shutil.copytree(a.plugin, f'{H}/plugin', symlinks=True)
if a.real_state:
    A = os.path.expanduser('~/.anti-hall')
    ex = ['--exclude=/work', '--exclude=/scratch', '--exclude=/ah-engine*', '--exclude=/wip-snapshots', '--exclude=/ah-node-shadow*', '--exclude=/tmp']
    subprocess.run(['rsync', '-a'] + ex + [A + '/', f'{H}/home/.anti-hall/'], check=True)
    os.makedirs(f'{H}/st', exist_ok=True)
    subprocess.run(['rsync', '-a', '--exclude=*.sock*', '--exclude=*.lock', '--exclude=daemon.run', '--exclude=/bin', '--exclude=/defaults.cache', '--exclude=/defaults.lkg', '--exclude=/defaults.error', '--exclude=/shadow', A + '/ah-engine/', f'{H}/st/'], check=True)
    for f in ('settings.json', 'settings.local.json'):
        if os.path.exists(os.path.expanduser('~/.claude/' + f)): shutil.copyfile(os.path.expanduser('~/.claude/' + f), f'{H}/home/.claude/{f}')
nsb = 6
for i in range(nsb): shutil.copytree(f'{a.sbsrc}', f'{H}/sb/sb{i}', symlinks=True)
txs = []
for i, t in enumerate(a.tx):
    d = f'{H}/tx{i}.jsonl'; shutil.copyfile(t, d); txs.append(d)
cwds = sorted({(r['payload'].get('cwd') or '') for r in rows}); cwdmap = {c: f'{H}/sb/sb{i % nsb}' for i, c in enumerate(cwds)}
conf = 'narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0'
env = {'HOME': f'{H}/home', 'PATH': os.environ['PATH'], 'LANG': 'en_US.UTF-8', 'AH_ENGINE_DIR': f'{H}/st', 'AH_ENGINE_PLUGIN_ROOT': f'{H}/plugin',
       'CLAUDE_PLUGIN_ROOT': f'{H}/plugin', 'AH_ENGINE_VERSION': 'prof', 'AH_ENGINE_RSS_CAP_KB': '0',
       '_RJEM_MALLOC_CONF': conf, 'MALLOC_CONF': conf}
if not a.no_dry: env['ANTIHALL_INGEST_DRY_RUN'] = '1'
for e in a.env: k, v = e.split('=', 1); env[k] = v
proc = subprocess.Popen([a.bin, 'serve'], env=env, cwd=H, stdout=open(f'{H}/serve.log', 'w'), stderr=subprocess.STDOUT)
sock = None
for _ in range(200):
    time.sleep(0.1)
    if os.path.isdir(f'{H}/st'):
        s = [f for f in os.listdir(f'{H}/st') if 'sock' in f]
        if s: sock = f'{H}/st/{s[0]}'; break
if not sock: print('no socket', H); proc.kill(); sys.exit(1)
payenv = {'HOME': f'{H}/home', 'PATH': os.environ['PATH'], 'CLAUDE_PLUGIN_ROOT': f'{H}/plugin', 'AH_ENGINE_PLUGIN_ROOT': f'{H}/plugin', 'ANTIHALL_INGEST_DRY_RUN': '1', 'LANG': 'en_US.UTF-8'}
rng = random.Random(a.seed)
def req(i):
    r = rows[i % len(rows)]; p = json.loads(json.dumps(r['payload']))
    if p.get('cwd') in cwdmap: p['cwd'] = cwdmap[p['cwd']]
    if txs and p.get('transcript_path') and not a.keep_tx:
        # one distinct real transcript per original session, spread over the supplied copies
        p['transcript_path'] = txs[hash(p.get('session_id')) % len(txs)]
    if a.session_churn and i >= len(rows) and p.get('session_id'): p['session_id'] += f'-c{i // len(rows)}'
    meta = {'host': 'claude', 'event': r['ev'], 'tool': p.get('tool_name'), 'root': f'{H}/plugin', 'env': payenv, 'only': None, 'plan': [], 'cfg': '', 'deadline_ms': 60000}
    return f"D prof\n{json.dumps(meta)}\n{json.dumps(p)}".encode()
def call(i):
    s = socket.socket(socket.AF_UNIX); s.settimeout(120); s.connect(sock); s.sendall(req(i)); s.shutdown(socket.SHUT_WR)
    buf = b''
    while True:
        c = s.recv(65536)
        if not c: break
        buf += c
    s.close(); return buf
def rss(): return int(subprocess.run(['ps', '-o', 'rss=', '-p', str(proc.pid)], capture_output=True, text=True).stdout.strip() or 0)
out = open(a.out, 'w') if a.out else sys.stdout
print('calls,rss_kb', file=out); print(f'0,{rss()}', file=out)
done = 0; lock = threading.Lock(); nxt = [0]
try:
    while done < a.n:
        batch = min(a.every, a.n - done)
        th = []
        def w():
            while True:
                with lock:
                    if nxt[0] >= done + batch: return
                    i = nxt[0]; nxt[0] += 1
                call(i)
        for _ in range(a.conc): t = threading.Thread(target=w); t.start(); th.append(t)
        for t in th: t.join()
        done += batch; print(f'{done},{rss()}', file=out); out.flush()
finally:
    print('H', H, 'pid', proc.pid, file=sys.stderr)
    if a.keep: sys.exit(0)
    subprocess.run([a.bin, 'stop'], env=env, capture_output=True, timeout=60)
    time.sleep(1)
    if proc.poll() is None: proc.kill()
