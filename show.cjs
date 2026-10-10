const fs=require('fs');
const f='C:/Users/SAD/Desktop/POS/src/components/admin/screens/AdminPOSWorkspace.tsx';
const lines=fs.readFileSync(f,'utf8').split('\n');
// print lines 412..430 truncated
for(let i=412;i<430;i++){ const l=lines[i]; console.log((i+1)+': '+(l.length>160?l.slice(0,160)+' ...[TRUNC]':l)); }
