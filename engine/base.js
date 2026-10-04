const fs=require('fs');const inp=fs.readFileSync(0,'utf8');
const j=JSON.parse(inp);const cmd=j.tool_input.command,tool=j.tool_name;
for(const l of fs.readFileSync(process.env.HOME+'/.anti-hall-proto/rules.txt','utf8').split('\n')){
 const p=l.split('\t');if(p.length<4)continue;
 if((p[0]===tool||p[0]==='*')&&cmd.includes(p[2])&&p[1]==='deny'){
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:p[3]}}));break;}}
