const BASE='http://127.0.0.1:4310';
(async()=>{
  const r=await fetch(`${BASE}/api/auth?action=admin`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@andac.local',pin:'2468'})});
  console.log('login status:', r.status, (await r.text()).slice(0,200));
})();
