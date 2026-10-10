#!/usr/bin/env python3
"""memtab.py <out/mem-X> : table of RSS / footprint / counting heap / jemalloc / QuickJS / structure sizes per checkpoint."""
import json,sys,re,os
d=sys.argv[1]
cps=sorted(int(f[7:-5]) for f in os.listdir(d) if f.startswith('status-'))
mb=lambda b:round(b/1048576,1)
hdr=['calls','rss','footprint','heap_live','j.allocated','j.active','j.resident','j.mapped','j.retained','js.malloc','js.objs','js.funcs','allocs']
print(' | '.join(hdr))
for n in cps:
    try: s=json.load(open(f'{d}/status-{n}.json'))['memory']
    except Exception as e: print(n,'no status',e); continue
    fp=''
    try:
        t=open(f'{d}/footprint-{n}.txt').read(); m=re.search(r'Footprint:\s+([\d.]+) (\w+)',t) or re.search(r'phys_footprint[^\d]*([\d.]+) (\w+)',t)
        fp=(m.group(1)+m.group(2)) if m else ''
        if not fp:
            m=re.search(r'([\d,.]+ [KMG]B)\s+\d+\s+ah-engine|ah-engine \[\d+\]: .*?\n.*?([\d.]+ [KMG]B)',t); fp=m.group(1) if m else ''
    except Exception: pass
    j=s['jemalloc']; js=s['js']['sum']
    print(' | '.join(map(str,[n,round(s['rss_kb']/1024,1),fp,round(s['heap_live_kb']/1024,1),mb(j['allocated']),mb(j['active']),mb(j['resident']),mb(j['mapped']),mb(j['retained']),mb(js['malloc_size']),js['obj_count'],js['js_func_count'],s['allocs']])))
print('components @ last:', json.load(open(f'{d}/status-{cps[-1]}.json'))['memory']['components'])
