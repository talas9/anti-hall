#!/usr/bin/env python3
"""stages.py <stages.ndjson> [skip_first] : p50/p95/p99/max per stage, top checks, and what the slowest 1% of requests spent their time on."""
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
skip=int(sys.argv[2]) if len(sys.argv)>2 else 0
rows=rows[skip:]
def pc(v,p):
    v=sorted(v); return v[min(len(v)-1,int(len(v)*p/100))] if v else 0
st=['wait','read','parse','pre','select','entries','observe','js','proc','git','spawn','wait_x','collect','encode','write','total']
print(f"n={len(rows)} (skipped first {skip}); microseconds")
print(f"{'stage':10}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>10}{'mean':>9}")
for s in ['wait','read','parse','pre','select','entries','observe','js','proc','git','spawn','wait','collect','encode','write','total']:
    key=s
    v=[r['wait'] if s=='wait' else r[s] for r in rows] if s!='wait' else [r['wait'] for r in rows]
    print(f"{s:10}{pc(v,50):9}{pc(v,95):9}{pc(v,99):9}{max(v) if v else 0:10}{(sum(v)/len(v) if v else 0):9.0f}")

# ---- per check
from collections import defaultdict
bych=defaultdict(list)
for r in rows:
    for k,v in r['checks'].items(): bych[k].append(v)
print("\nper check (us), sorted by p99:")
print(f"{'check':34}{'n':>7}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>10}{'sum_s':>8}")
for k,v in sorted(bych.items(), key=lambda kv:-pc(kv[1],99))[:14]:
    print(f"{k:34}{len(v):7}{pc(v,50):9}{pc(v,95):9}{pc(v,99):9}{max(v):10}{sum(v)/1e6:8.2f}")
print("\ntotal time by check (top 8):", sorted(((round(sum(v)/1e6,2),k) for k,v in bych.items()),reverse=True)[:8])
# ---- the slowest 1% of requests
tot=sorted(rows,key=lambda r:-r['total']); top=tot[:max(1,len(rows)//100)]
print(f"\nslowest 1% ({len(top)} requests, total >= {top[-1]['total']} us): mean per stage")
for s in ['queue','read','parse','pre','select','entries','observe','js','proc','git','spawn','wait','collect','encode','write','total','cpu']:
    if s in top[0]: print(f"  {s:8}{sum(r[s] for r in top)/len(top):10.0f}")
print("  by event:", sorted(((sum(1 for r in top if r['ev']==e),e) for e in {r['ev'] for r in top}),reverse=True)[:6])
cc=defaultdict(int)
for r in top:
    if r['checks']: cc[max(r['checks'],key=r['checks'].get)]+=1
print("  slowest check inside those requests:", sorted(((n,k) for k,n in cc.items()),reverse=True)[:6])
