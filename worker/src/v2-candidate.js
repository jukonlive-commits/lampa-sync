// Experimental candidate: not deployable until end-to-end review and testing.
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const hex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
const random = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const hash = async s => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS' };
const reply = (v, status = 200) => new Response(JSON.stringify(v), { status, headers });
const token = req => (req.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
async function body(req, max) {
  const reader = req.body && req.body.getReader();
  if (!reader) return {};
  let size = 0, chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > max) { await reader.cancel(); throw new Error('size'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new Error('json'); }
}
async function limit(db, key, max) {
  const window = Math.floor(now() / 60);
  const row = await db.prepare('INSERT INTO ls_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count').bind(key, window).first();
  return row.count <= max;
}
async function auth(req, db) {
  const t = token(req); if (!t) return null;
  return db.prepare('SELECT user_id,token_hash FROM ls_devices WHERE token_hash=? AND revoked=0').bind(await hash(t)).first();
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = enc.encode(a), bb = enc.encode(b); if (aa.length !== bb.length) return false;
  let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i]; return diff === 0;
}
const settingLabels = {
  interface_size: 'Размер интерфейса',
  poster_size: 'Качество постеров',
  background_type: 'Тип фона'
};
async function notifyBackup(env, userId, fields, version) {
  if (!env.BOT_TOKEN) return;
  const user = await env.DB.prepare('SELECT telegram_id FROM ls_users WHERE id=?').bind(userId).first();
  if (!user) return;
  const list = fields.map(field => '• ' + settingLabels[field]).join('\n');
  const response = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: user.telegram_id, text: 'Lampa Sync: копия №' + version + ' сохранена.\n\nВ копии:\n' + list })
  });
  if (!response.ok) console.warn('Backup notification was rejected', response.status);
}
export default {
  async fetch(req, env, ctx) {
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      const path = new URL(req.url).pathname;
      if (path === '/health' && req.method === 'GET') return reply({ ok: true, version: '2-candidate' });
      if (!env.DB || !env.TELEGRAM_WEBHOOK_SECRET) return reply({ error: 'not configured' }, 503);
      const db = env.DB;
      // A missing Cloudflare IP must not collapse clients into an unrestricted bucket.
      const ip = req.headers.get('CF-Connecting-IP');
      if (!ip) return reply({ error: 'missing client address' }, 403);
      if (!await limit(db, 'ip:' + await hash(ip), 120)) return reply({ error: 'rate limited' }, 429);
      if (path === '/pair/start' && req.method === 'POST') {
        if (!await limit(db, 'start:' + await hash(ip), 6)) return reply({ error: 'rate limited' }, 429);
        const b = await body(req, 1024), name = typeof b.name === 'string' ? b.name.slice(0, 80) : 'Lampa';
        const code = random(12).toUpperCase(), t = random(32);
        await db.prepare('INSERT INTO ls_pairings(code_hash,token_hash,name,expires) VALUES(?,?,?,?)').bind(await hash(code), await hash(t), name, now() + 600).run();
        return reply({ code, device_token: t, expires_in: 600 });
      }
      if (path === '/telegram/webhook' && req.method === 'POST') {
        if (!equal(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) return reply({ error: 'unauthorized' }, 401);
        const update = await body(req, 16384), m = update.message;
        if (!m || m.chat?.type !== 'private' || !Number.isSafeInteger(m.from?.id) || m.chat.id !== m.from.id) return reply({ ok: true });
        const match = typeof m.text === 'string' && m.text.trim().match(/^\/start(?:\s+([A-F0-9]{24}))?$/i);
        if (!match) return reply({ ok: true });
        if (match[1]) {
          const telegramId = String(m.from.id), codeHash = await hash(match[1].toUpperCase());
          if (!await limit(db, 'tg:' + await hash(telegramId), 6)) return reply({ ok: true });
          await db.batch([
            db.prepare('INSERT INTO ls_users(telegram_id) VALUES(?) ON CONFLICT(telegram_id) DO NOTHING').bind(telegramId),
            db.prepare('UPDATE ls_pairings SET user_id=(SELECT id FROM ls_users WHERE telegram_id=?) WHERE code_hash=? AND user_id IS NULL AND expires>?').bind(telegramId, codeHash, now())
          ]);
        }
        // Telegram executes this response as a Bot API method. Keep the message
        // generic: a repeated update must not claim the code was newly accepted.
        return reply({ method: 'sendMessage', chat_id: m.chat.id, text: match[1] ? 'Запрос получен. Вернитесь в Lampa Sync и проверьте подключение.' : 'Откройте Lampa Sync на телевизоре и отправьте /start КОД, показанный плагином.' });
      }
      if (path === '/pair/complete' && req.method === 'POST') {
        const t = token(req); if (!t) return reply({ error: 'unauthorized' }, 401);
        const h = await hash(t), pair = await db.prepare('SELECT user_id,expires,completed FROM ls_pairings WHERE token_hash=?').bind(h).first();
        if (!pair || (pair.expires <= now() && !pair.completed)) return reply({ error: 'expired' }, 410);
        if (!pair.user_id) return reply({ paired: false });
        await db.batch([
          db.prepare('INSERT INTO ls_devices(token_hash,user_id,name,created) SELECT token_hash,user_id,name,? FROM ls_pairings WHERE token_hash=? AND user_id IS NOT NULL AND (expires>? OR completed=1) ON CONFLICT(token_hash) DO NOTHING').bind(now(), h, now()),
          db.prepare('UPDATE ls_pairings SET completed=1 WHERE token_hash=? AND EXISTS(SELECT 1 FROM ls_devices WHERE token_hash=?)').bind(h, h)
        ]);
        const device = await db.prepare('SELECT revoked FROM ls_devices WHERE token_hash=?').bind(h).first();
        return device && !device.revoked ? reply({ paired: true }) : reply({ error: 'expired or revoked' }, 410);
      }
      if (path === '/backup' && (req.method === 'GET' || req.method === 'PUT')) {
        const device = await auth(req, db); if (!device) return reply({ error: 'unauthorized' }, 401);
        if (req.method === 'GET') {
          const row = await db.prepare('SELECT version,envelope FROM ls_backups WHERE user_id=?').bind(device.user_id).first();
          return row ? reply({ version: row.version, envelope: JSON.parse(row.envelope) }) : reply({ error: 'not found' }, 404);
        }
        const b = await body(req, 160000), e = b.envelope;
        if (!Number.isSafeInteger(b.version) || b.version < 0 || !e || e.v !== 1 || !['salt','iv','data'].every(k => typeof e[k] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(e[k]))) return reply({ error: 'invalid backup' }, 400);
        const result = await db.prepare('INSERT INTO ls_backups(user_id,version,envelope,updated) SELECT ?,1,?,? WHERE ?=0 ON CONFLICT(user_id) DO UPDATE SET version=ls_backups.version+1,envelope=excluded.envelope,updated=excluded.updated WHERE ls_backups.version=? RETURNING version').bind(device.user_id, JSON.stringify(e), now(), b.version, b.version).first();
        // For existing backups the INSERT SELECT above needs a row even for nonzero versions.
        const saved = result || (b.version > 0 && await db.prepare('UPDATE ls_backups SET version=version+1,envelope=?,updated=? WHERE user_id=? AND version=? RETURNING version').bind(JSON.stringify(e), now(), device.user_id, b.version).first());
        if (!saved) return reply({ error: 'conflict' }, 409);
        const fields = Array.isArray(b.fields) ? Object.keys(settingLabels).filter(field => b.fields.includes(field)) : [];
        if (fields.length && ctx) ctx.waitUntil(notifyBackup(env, device.user_id, fields, saved.version).catch(() => console.warn('Backup notification failed')));
        return reply({ version: saved.version });
      }
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      if (e.message === 'size') return reply({ error: 'too large' }, 413);
      if (e.message === 'json') return reply({ error: 'invalid json' }, 400);
      console.error('candidate request failed', e.name); return reply({ error: 'internal error' }, 500);
    }
  }
};
