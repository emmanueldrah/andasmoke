const fs=require('fs');
const f='C:/Users/SAD/Desktop/POS/src/components/admin/screens/AdminPOSWorkspace.tsx';
const lines=fs.readFileSync(f,'utf8').split('\n');
console.log(lines[418]);
