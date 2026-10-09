// Usage: node field-rate-command.js <ah-engine> <field cmds.jsonl> [every-Kth-row]
// defer rate of the engine command check on the field corpus: every K-th recorded call, oneshot, subagent flag from the row
const fs=require('fs'),cp=require('child_process'),rl=require('readline');
const ENGINE=process.argv[2], FILE=process.argv[3], K=+process.argv[4]||7;
(async()=>{
  const rows=[];let i=0;
  for await(const l of rl.createInterface({input:fs.createReadStream(FILE)})){ if(i++%K)continue; try{const o=JSON.parse(l); if(typeof o.cmd==='string')rows.push(o);}catch{} }
  const st={all:{n:0,d:0},sub:{n:0,d:0},main:{n:0,d:0}, nonascii:0};
  const run=(o)=>new Promise(res=>{
    const p={session_id:'f',cwd:o.cwd||'/tmp',hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:o.cmd}}; if(o.sub) p.agent_id=o.agentId||'a';
    const c=cp.spawn(ENGINE,['check','command'],{env:{PATH:process.env.PATH,HOME:'/nonexistent-ah'}}); let out=''; c.stdout.on('data',d=>out+=d); c.on('close',()=>res(out.trim()==='AHFALLBACK'));
    c.stdin.on('error',()=>{}); c.stdin.end(JSON.stringify(p));
  });
  let k=0; await Promise.all(Array.from({length:8},async()=>{while(k<rows.length){const o=rows[k++]; const d=await run(o); const b=o.sub?'sub':'main'; for(const x of ['all',b]){st[x].n++; if(d)st[x].d++;} if(/[^\x00-\x7f]/.test(o.cmd)) st.nonascii++;}}));
  const f=x=>`${x.d}/${x.n} = ${(100*x.d/x.n).toFixed(1)}% deferred`;
  console.log('rows',rows.length,'| all:',f(st.all),'| subagent:',f(st.sub),'| main thread:',f(st.main),'| non-ascii rows',st.nonascii);
})();
