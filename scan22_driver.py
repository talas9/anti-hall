#!/usr/bin/env python3
import argparse, json, os, random, shutil, socket, subprocess, sys, tempfile, threading, time, pathlib
ap=argparse.ArgumentParser()
ap.add_argument('--bin',required=True); ap.add_argument('--plugin',required=True); ap.add_argument('--sbsrc',required=True); ap.add_argument('--corpus',required=True); ap.add_argument('--tx',required=True); ap.add_argument('--n',type=int,default=30); ap.add_argument('--outdir',required=True); ap.add_argument('--sample',type=int,default=0)
a=ap.parse_args()
rows=[json.loads(l) for l in open(a.corpus) if l.strip()]
rows=[r for r in rows if r.get('ev')=='Stop']
if not rows: raise SystemExit('no Stop rows')
out=pathlib.Path(a.outdir); out.mkdir(parents=True, exist_ok=True)
H=tempfile.mkdtemp(prefix='scan22.', dir=os.path.expanduser('~/.anti-hall/work/mem21'))
(pathlib.Path(H)/'home/.claude').mkdir(parents=True); (pathlib.Path(H)/'home/.anti-hall').mkdir(parents=True); (pathlib.Path(H)/'sb').mkdir()
shutil.copytree(a.plugin, f'{H}/plugin', symlinks=True)
for i in range(3): shutil.copytree(a.sbsrc, f'{H}/sb/sb{i}', symlinks=True)
cwds=sorted({(r['payload'].get('cwd') or '') for r in rows}); cwdmap={c:f'{H}/sb/sb{i%3}' for i,c in enumerate(cwds)}
conf='narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0'
env={'HOME':f'{H}/home','PATH':os.environ['PATH'],'LANG':'en_US.UTF-8','AH_ENGINE_DIR':f'{H}/st','AH_ENGINE_PLUGIN_ROOT':f'{H}/plugin','CLAUDE_PLUGIN_ROOT':f'{H}/plugin','AH_ENGINE_VERSION':'prof','AH_ENGINE_RSS_CAP_KB':'0','_RJEM_MALLOC_CONF':conf,'MALLOC_CONF':conf,'ANTIHALL_INGEST_DRY_RUN':'1'}
proc=subprocess.Popen([a.bin,'serve'], env=env, cwd=H, stdout=open(f'{H}/serve.log','w'), stderr=subprocess.STDOUT)
sock=None
for _ in range(200):
    time.sleep(0.1)
    sd=pathlib.Path(H)/'st'
    if sd.is_dir():
        ss=[p for p in sd.iterdir() if 'sock' in p.name]
        if ss: sock=str(ss[0]); break
if not sock:
    proc.kill(); raise SystemExit(f'no socket {H}')
payenv={'HOME':f'{H}/home','PATH':os.environ['PATH'],'CLAUDE_PLUGIN_ROOT':f'{H}/plugin','AH_ENGINE_PLUGIN_ROOT':f'{H}/plugin','ANTIHALL_INGEST_DRY_RUN':'1','LANG':'en_US.UTF-8'}
def req(i):
    r=rows[i%len(rows)]; p=json.loads(json.dumps(r['payload']))
    if p.get('cwd') in cwdmap: p['cwd']=cwdmap[p['cwd']]
    p['transcript_path']=a.tx
    meta={'host':'claude','event':r['ev'],'tool':p.get('tool_name'),'root':f'{H}/plugin','env':payenv,'only':None,'plan':[],'cfg':'','deadline_ms':60000}
    return f"D prof\n{json.dumps(meta)}\n{json.dumps(p)}".encode(), p

def call(i):
    s=socket.socket(socket.AF_UNIX); s.settimeout(120); s.connect(sock); b,p=req(i); s.sendall(b); s.shutdown(socket.SHUT_WR)
    buf=b''
    while True:
        c=s.recv(65536)
        if not c: break
        buf+=c
    s.close(); return buf,p

def frame_body(buf):
    if not buf.startswith(b'AHR2 '): return {'kind':'bad','body':''}
    head,rest=buf.split(b'\n',1); parts=head.decode().split(' '); ln=int(parts[2]); body=rest[:ln].decode('utf-8','replace')
    return {'kind':parts[1], 'body':body}

sample_proc=None
if a.sample:
    sample_proc=subprocess.Popen(['/usr/bin/sample', str(proc.pid), str(a.sample), '1', '-mayDie', '-file', str(out/'cpu.sample.txt')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
replies=[]
t0=time.time()
for i in range(a.n):
    buf,p=call(i); fr=frame_body(buf); replies.append({'i':i,'session_id':p.get('session_id'),'kind':fr['kind'],'body':fr['body']})
elapsed=time.time()-t0
if sample_proc:
    try: sample_out=sample_proc.communicate(timeout=max(5,a.sample+5))[0]
    except subprocess.TimeoutExpired:
        sample_proc.kill(); sample_out=sample_proc.communicate()[0]
    (out/'sample.stdout').write_text(sample_out)
(out/'replies.jsonl').write_text('\n'.join(json.dumps(r) for r in replies)+'\n')
for name,args in [('metrics',['metrics','--json']),('status',['status','--json'])]:
    cp=subprocess.run([a.bin]+args, env=env, cwd=H, text=True, capture_output=True, timeout=30)
    (out/f'{name}.json').write_text(cp.stdout)
    (out/f'{name}.err').write_text(cp.stderr)
(pathlib.Path(out)/'driver.json').write_text(json.dumps({'H':H,'pid':proc.pid,'n':a.n,'elapsed_s':elapsed,'tx':a.tx}, indent=2))
subprocess.run([a.bin,'stop'], env=env, cwd=H, capture_output=True, timeout=30)
time.sleep(.5)
if proc.poll() is None: proc.terminate(); time.sleep(.5)
if proc.poll() is None: proc.kill()
print(json.dumps({'H':H,'pid':proc.pid,'n':a.n,'elapsed_s':elapsed,'outdir':str(out)}))
