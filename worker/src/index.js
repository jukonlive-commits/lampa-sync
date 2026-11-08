// Lampa Sync v2 server prototype. Deploy only after configuring DB, BACKUPS,
// BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET. Do not reuse the v1 shared API key.
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*","access-control-allow-headers":"authorization,content-type","access-control-allow-methods":"GET,POST,PUT,OPTIONS"}});
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const random=(n=32)=>hex(crypto.getRandomValues(new Uint8Array(n)));
const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))));
const telegram=async(env,chat_id,text)=>fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id,text})});
async function authorized(request,env){
 const token=(request.headers.get("authorization")||"").match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
 if(!token)return null;
 const hash=await digest(token);
 const device=await env.DB.prepare("SELECT id,user_id FROM devices WHERE id=?").bind(hash).first();
 return device||null;
}
export default {
 async fetch(request,env){
  try{
   if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"authorization,content-type","access-control-allow-methods":"GET,POST,PUT,OPTIONS"}});
   if(!env.DB||!env.BACKUPS||!env.BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET)return json({error:"Server not configured"},503);
   const path=new URL(request.url).pathname;
   if(path==="/health"&&request.method==="GET")return json({ok:true,version:2});
   if(path==="/admin/register-webhook"&&request.method==="POST"){
    // Administrative action: never expose the bot token or webhook secret to clients.
    if(!env.ADMIN_SETUP_KEY)return json({error:"Admin setup not configured"},503);
    const provided=(request.headers.get("authorization")||"").replace(/^Bearer /,"");
    const enc=new TextEncoder();
    const a=enc.encode(provided),b=enc.encode(env.ADMIN_SETUP_KEY);
    if(a.length!==b.length)return json({error:"Unauthorized"},401);
    let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
    if(diff!==0)return json({error:"Unauthorized"},401);
    const webhookUrl=new URL("/telegram/webhook",request.url).toString();
    const result=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/setWebhook",{
     method:"POST",headers:{"content-type":"application/json"},
     body:JSON.stringify({url:webhookUrl,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message"],drop_pending_updates:false})
    });
    const answer=await result.json();
    return json({ok:result.ok&&answer.ok===true,description:answer.description||null},result.ok&&answer.ok?200:502);
   }

   if(path==="/telegram/webhook"&&request.method==="POST"){
    if(request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.TELEGRAM_WEBHOOK_SECRET)return json({error:"Unauthorized"},401);
    const update=await request.json();
    const msg=update.message;
    if(!msg||msg.chat?.type!=="private"||!Number.isSafeInteger(msg.from?.id))return json({ok:true});
    const text=String(msg.text||"").trim();
    const match=text.match(/^\/start(?:\s+([A-F0-9]{16}))?$/i);
    if(!match)return json({ok:true});
    if(!match[1]){await telegram(env,msg.chat.id,"Откройте Lampa Sync на телевизоре, получите код подключения и отправьте /start КОД");return json({ok:true});}
    const code=match[1].toUpperCase();
    const codeHash=await digest(code);
    const pair=await env.DB.prepare("SELECT code_hash,expires_at,used_at FROM pairing_codes WHERE code_hash=?").bind(codeHash).first();
    if(!pair||pair.used_at!==null||pair.expires_at<=Math.floor(Date.now()/1000)){
     await telegram(env,msg.chat.id,"Код недействителен или истёк. Создайте новый код в Lampa Sync.");return json({ok:true});
    }
    const tgId=String(msg.from.id);
    await env.DB.prepare("INSERT INTO users(telegram_id) VALUES (?) ON CONFLICT(telegram_id) DO NOTHING").bind(tgId).run();
    const user=await env.DB.prepare("SELECT id FROM users WHERE telegram_id=?").bind(tgId).first();
    const changed=await env.DB.prepare("UPDATE pairing_codes SET user_id=?,used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?").bind(user.id,Math.floor(Date.now()/1000),codeHash,Math.floor(Date.now()/1000)).run();
    if(changed.meta.changes===1)await telegram(env,msg.chat.id,"Telegram подтверждён. Вернитесь в Lampa Sync на телевизоре.");
    return json({ok:true});
   }
   if(path==="/pair/start"&&request.method==="POST"){
    // A 64-bit one-time code reduces guessing risk; enforce platform rate limits before launch.
    const raw=await request.text();if(raw.length>1024)return json({error:"Too large"},413);
    const body=JSON.parse(raw||"{}");
    const deviceName=String(body.name||"Lampa device").slice(0,80);
    const deviceToken=random(32);
    const code=random(8).toUpperCase();
    const codeHash=await digest(code),tokenHash=await digest(deviceToken);
    const expires=Math.floor(Date.now()/1000)+600;
    await env.DB.prepare("INSERT INTO pairing_codes(code_hash,expires_at) VALUES (?,?)").bind(codeHash,expires).run();
    // Pending credential is never returned to Telegram, and expires with the code.
    await env.BACKUPS.put("pending:"+tokenHash,JSON.stringify({codeHash,deviceName}),{expirationTtl:600});
    return json({code,device_token:deviceToken,expires_in:600});
   }
   if(path==="/pair/complete"&&request.method==="POST"){
    const token=(request.headers.get("authorization")||"").match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if(!token)return json({error:"Unauthorized"},401);
    const tokenHash=await digest(token);
    const pending=await env.BACKUPS.get("pending:"+tokenHash,"json");
    if(!pending)return json({error:"Pairing expired"},410);
    const pair=await env.DB.prepare("SELECT user_id,used_at,expires_at FROM pairing_codes WHERE code_hash=?").bind(pending.codeHash).first();
    if(!pair||pair.expires_at<=Math.floor(Date.now()/1000))return json({error:"Pairing expired"},410);
    if(pair.used_at===null||pair.user_id===null)return json({paired:false});
    await env.DB.prepare("INSERT OR IGNORE INTO devices(id,user_id,name) VALUES (?,?,?)").bind(tokenHash,pair.user_id,pending.deviceName).run();
    await env.BACKUPS.delete("pending:"+tokenHash);
    return json({paired:true});
   }
   if(path==="/backup"&&(request.method==="GET"||request.method==="PUT")){
    const device=await authorized(request,env);
    if(!device)return json({error:"Unauthorized"},401);
    const key="user:"+device.user_id+":latest";
    if(request.method==="GET"){
     const value=await env.BACKUPS.get(key);
     return value?new Response(value,{headers:{"content-type":"application/json","cache-control":"no-store"}}):json({error:"No backup"},404);
    }
    const raw=await request.text();
    if(raw.length>150000)return json({error:"Too large"},413);
    let envelope;try{envelope=JSON.parse(raw)}catch{return json({error:"Invalid JSON"},400)}
    if(envelope?.v!==1||!["salt","iv","data"].every(k=>typeof envelope[k]==="string"))return json({error:"Invalid encrypted backup"},400);
    await env.BACKUPS.put(key,raw);
    return json({ok:true});
   }
   return json({error:"Not found"},404);
  }catch(e){console.error("Request failed",e?.name||"Error");return json({error:"Internal error"},500)}
 }
};
