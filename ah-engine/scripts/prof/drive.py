#!/usr/bin/env python3
"""Open-loop (or closed-loop) load generator speaking the daemon's D protocol with replayed hook payloads.
Open loop: call i is SCHEDULED at t0 + i/rate and sent then regardless of earlier replies; latency is measured from the
scheduled instant (no coordinated omission) and also from the actual send, so scheduling delay of the client is separable.
Usage: drive.py --sock S --root PLUGIN --home H --sb SBDIR --n N --rate R [--churn] [--out file.json] [--offset K]"""
import argparse, asyncio, json, os, sys, time, hashlib, random

ap = argparse.ArgumentParser()
ap.add_argument('--sock', required=True); ap.add_argument('--root', required=True); ap.add_argument('--home', required=True)
ap.add_argument('--sb', required=True, help='dir holding sb0..sbN scratch git repos')
ap.add_argument('--n', type=int, required=True); ap.add_argument('--rate', type=float, default=0, help='calls/s; 0 = closed loop, one at a time')
ap.add_argument('--churn', action='store_true'); ap.add_argument('--offset', type=int, default=0)
ap.add_argument('--ver', default='prof'); ap.add_argument('--out'); ap.add_argument('--sample', default=os.path.expanduser('~/.anti-hall/work/replay/sample-frozen.ndjson'))
ap.add_argument('--deadline-ms', type=int, default=2000)
a = ap.parse_args()

rows = [json.loads(l) for l in open(a.sample)]
cwds = sorted({(r['payload'].get('cwd') or '') for r in rows})
nsb = len(os.listdir(a.sb))
cwdmap = {c: f'{a.sb}/sb{i % nsb}' for i, c in enumerate(cwds)}
env = {'HOME': a.home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'CLAUDE_PLUGIN_ROOT': a.root, 'AH_ENGINE_PLUGIN_ROOT': a.root,
       'ANTIHALL_INGEST_DRY_RUN': '1', 'LANG': 'en_US.UTF-8'}

def request(i):
    r = rows[(a.offset + i) % len(rows)]
    cycle = (a.offset + i) // len(rows)
    p = json.loads(json.dumps(r['payload']))
    if p.get('cwd') in cwdmap: p['cwd'] = cwdmap[p['cwd']]
    if a.churn and cycle and p.get('session_id'): p['session_id'] = f"{p['session_id']}-c{cycle}"
    ev = r['ev']; tool = p.get('tool_name')
    meta = {'host': 'claude', 'event': ev, 'tool': tool, 'root': a.root, 'env': env, 'only': None, 'plan': [], 'cfg': '', 'deadline_ms': a.deadline_ms}
    return ev, tool, f"D {a.ver}\n{json.dumps(meta)}\n{json.dumps(p)}".encode()

async def one(i, sched, res, sem):
    ev, tool, req = request(i)
    sent = time.perf_counter()
    kind, nbytes = 'FAIL', 0
    try:
        rd, wr = await asyncio.wait_for(asyncio.open_unix_connection(a.sock), 10)
        wr.write(req); await wr.drain(); wr.write_eof()
        buf = await asyncio.wait_for(rd.read(), 30)
        kind = buf.split(b' ', 2)[1].decode() if buf.startswith(b'AHR2') else 'BAD'
        nbytes = len(buf); wr.close()
    except Exception as e:
        kind = 'EXC:' + type(e).__name__
    end = time.perf_counter()
    res.append((i, ev, tool or '', sched, sent, end, kind, nbytes))

async def main():
    res = []; sem = None; t0 = time.perf_counter() + 0.2
    tasks = []
    if a.rate > 0:
        for i in range(a.n):
            sched = t0 + i / a.rate
            d = sched - time.perf_counter()
            if d > 0: await asyncio.sleep(d)
            tasks.append(asyncio.create_task(one(i, sched, res, sem)))
        await asyncio.gather(*tasks)
    else:
        for i in range(a.n):
            s = time.perf_counter(); await one(i, s, res, sem)
    return t0, res
t0, res = asyncio.run(main())
lat = sorted((e - s) * 1000 for (_, _, _, s, _, e, _, _) in res)          # from scheduled instant
svc = sorted((e - sn) * 1000 for (_, _, _, _, sn, e, _, _) in res)        # from actual send
lag = sorted((sn - s) * 1000 for (_, _, _, s, sn, _, _, _) in res)        # client-side scheduling lag
def pc(v, p): return round(v[min(len(v) - 1, int(len(v) * p / 100))], 2) if v else None
kinds = {}
for r in res: kinds[r[6]] = kinds.get(r[6], 0) + 1
dur = max(r[5] for r in res) - t0
out = {'n': len(res), 'rate': a.rate, 'dur_s': round(dur, 2), 'kinds': kinds,
       'from_sched_ms': {p: pc(lat, p) for p in (50, 95, 99)}, 'from_send_ms': {p: pc(svc, p) for p in (50, 95, 99)},
       'client_lag_ms': {p: pc(lag, p) for p in (50, 95, 99)}, 'max_ms': round(lat[-1], 1)}
print(json.dumps(out))
if a.out:
    json.dump({'summary': out, 'calls': [[i, ev, t, round((sn - s) * 1000, 3), round((e - sn) * 1000, 3), k] for (i, ev, t, s, sn, e, k, nb) in sorted(res)]}, open(a.out, 'w'))
