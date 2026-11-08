(function(){
'use strict';
if(window.LampaSyncV1)return;window.LampaSyncV1=true;
var PREFIX='lampa_sync_';
function note(s){if(window.Lampa&&Lampa.Noty)Lampa.Noty.show(s);else alert(s)}
function get(k){return localStorage.getItem(PREFIX+k)||''}
function set(k,v){localStorage.setItem(PREFIX+k,v)}
function b64(a){var s='';a.forEach(function(x){s+=String.fromCharCode(x)});return btoa(s)}
function un64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
async function key(p,s){var raw=await crypto.subtle.importKey('raw',new TextEncoder().encode(p),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt:s,iterations:250000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function seal(obj,p){var s=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));var bytes=new TextEncoder().encode(JSON.stringify(obj));var out=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await key(p,s),bytes);return {v:1,salt:b64(s),iv:b64(iv),data:b64(new Uint8Array(out))}}
async function open(blob,p){if(blob.v!==1)throw Error('Неверный формат');var out=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(blob.iv)},await key(p,un64(blob.salt)),un64(blob.data));return JSON.parse(new TextDecoder().decode(out))}
function config(){var url=get('url'),id=get('id'),token=get('token');if(!/^https:\/\//.test(url)||!id||!token)throw Error('Сначала укажите Worker, ID и ключ');return {url:url.replace(/\/$/,''),id:id,token:token}}
async function request(method,data){var c=config();var r=await fetch(c.url+'/backup/'+encodeURIComponent(c.id),{method:method,headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});if(!r.ok)throw Error('Ошибка сервера '+r.status);return r.json()}
function password(){var p=prompt('Пароль шифрования (не менее 12 символов)');if(!p||p.length<12)throw Error('Нужен пароль от 12 символов');return p}
function snapshot(){var items={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k.indexOf(PREFIX)===0||/token|password|secret|auth|session|cookie|credential/i.test(k))continue;items[k]=localStorage.getItem(k)}return {format:'lampa-sync-v1',created:new Date().toISOString(),items:items}}
async function backup(){var p=password(),s=snapshot();await request('PUT',await seal(s,p));note('Экспорт выполнен: '+Object.keys(s.items).length+' записей')}
async function restore(){var p=password(),r=await request('GET'),s=await open(r.backup,p);if(s.format!=='lampa-sync-v1'||!s.items||typeof s.items!=='object')throw Error('Неверная копия');var keys=Object.keys(s.items);if(!confirm('Заменить '+keys.length+' настроек?'))return;keys.forEach(function(k){if(k.indexOf(PREFIX)!==0&&!/token|password|secret|auth|session|cookie|credential/i.test(k)&&typeof s.items[k]==='string')localStorage.setItem(k,s.items[k])});note('Импорт выполнен. Перезапустите Lampa')}
function configure(){var url=prompt('HTTPS URL Cloudflare Worker',get('url'));if(url===null)return;var id=prompt('ID хранилища (4-64 латинских символов)',get('id'));if(id===null)return;var token=prompt('API_KEY сервера',get('token'));if(token===null)return;set('url',url.trim());set('id',id.trim());set('token',token.trim());note('Настройки сохранены')}
function run(fn){Promise.resolve().then(fn).catch(function(e){note('Lampa Sync: '+e.message)})}
function init(){if(!window.Lampa||!Lampa.SettingsApi||!Lampa.SettingsApi.addComponent||!Lampa.SettingsApi.addParam){setTimeout(init,1000);return}Lampa.SettingsApi.addComponent({component:'lampa_sync',name:'Lampa Sync',icon:'sync'});[['configure','Настроить подключение',configure],['export','Экспорт в Telegram',backup],['import','Импорт из Telegram',restore]].forEach(function(x){Lampa.SettingsApi.addParam({component:'lampa_sync',param:{name:'lampa_sync_'+x[0],type:'button'},field:{name:x[1]},onChange:function(){run(x[2])}})})}
init();
})();