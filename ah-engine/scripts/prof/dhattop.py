#!/usr/bin/env python3
"""dhattop.py A.json [B.json]: top allocation sites by bytes live at exit (eb); with B, by growth B-A (same call stack)."""
import json,sys,re
def load(p):
    d=json.load(open(p)); f=d['ftbl']
    def clean(s):
        s=re.sub(r'^0x[0-9a-f]+: ','',s); s=re.sub(r'_R[A-Za-z0-9_]*?(\d+)([A-Za-z_][A-Za-z0-9_]*)',r'\2',s) if False else s
        return s[:120]
    out={}
    for p_ in d['pps']:
        fr=[clean(f[i]) for i in p_['fs']]
        fr=[x for x in fr if not re.search(r'dhat|alloc::alloc|__rust_alloc|alloc::raw_vec|RawVec|finish_grow|alloc::vec::Vec|alloc::string|Vec<T,A>|hashbrown::raw|reserve', x)] or fr
        key=tuple(fr[:4]); o=out.setdefault(key,[0,0,0]); o[0]+=p_['eb']; o[1]+=p_['ebk']; o[2]+=p_['tbk']
    return out
a=load(sys.argv[1]); b=load(sys.argv[2]) if len(sys.argv)>2 else None
rows=[(k,(b[k][0]-a.get(k,[0])[0]) if b else a[k][0], b[k] if b else a[k]) for k in (b or a)]
for k,v,o in sorted(rows,key=lambda r:-r[1])[:8]:
    print(f"{v:>10} B  live_blocks={o[1]} total_allocs={o[2]}\n      "+"\n      ".join(k))
