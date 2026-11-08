export default {
 async fetch(request,env){
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,PUT,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Cache-Control':'no-store','Content-Type':'application/json'};
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(!env.API_KEY||!env.BOT_TOKEN||!env.CHAT_ID||!env.BACKUPS)return reply({error:'Missing configuration'},503);
  if(request.headers.get('Authorization')!=='Bearer '+env.API_KEY)return reply({error:'Unauthorized'},401);
  const m=new URL(request.url).pathname.match(/^\/backup\/([a-zA-Z0-9_-]{4,64})$/);
  if(!m)return reply({error:'Not found'},404);
  const k='backup:'+m[1];
  if(request.method==='GET'){const backup=await env.BACKUPS.get(k,'json');return backup?reply({backup}):reply({error:'No backup'},404)}
  if(request.method!=='PUT')return reply({error:'Method not allowed'},405);
  const raw=await request.text();
  if(raw.length>150000)return reply({error:'Too large'},413);
  let obj;try{obj=JSON.parse(raw)}catch{return reply({error:'Invalid JSON'},400)}
  if(obj.v!==1||!['salt','iv','data'].every(k=>typeof obj[k]==='string'))return reply({error:'Invalid encrypted envelope'},400);
  const form=new FormData();form.set('chat_id',env.CHAT_ID);form.set('caption','Lampa Sync encrypted backup: '+m[1]);form.set('document',new Blob([raw],{type:'application/json'}),'lampa-sync.json');
  const r=await fetch('https://api.telegram.org/bot'+env.BOT_TOKEN+'/sendDocument',{method:'POST',body:form});
  if(!r.ok)return reply({error:'Telegram failed'},502);
  const tg=await r.json();if(!tg.ok)return reply({error:'Telegram rejected'},502);
  await env.BACKUPS.put(k,raw);return reply({ok:true});
 }
};