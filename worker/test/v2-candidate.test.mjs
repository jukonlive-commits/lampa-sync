import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/v2-candidate.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
function database() {
  const sqlite = new DatabaseSync(':memory:');
  return {
    sqlite,
    prepare(sql) { return { bind(...args) { return { first: async () => sqlite.prepare(sql).get(...args) || null, run: async () => sqlite.prepare(sql).run(...args) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { for (const stmt of statements) await stmt.run(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
  };
}
test('pairing replay, isolation, conditional updates and revocation', async () => {
  const db = database(); db.sqlite.exec(await readFile(new URL('../migrations/0001_v2_candidate.sql', import.meta.url), 'utf8'));
  const env = { DB: db, TELEGRAM_WEBHOOK_SECRET: 'test-secret' };
  async function call(path, method = 'GET', value, token, extra = {}) {
    const tasks = [];
    const response = await worker.fetch(new Request('https://example.test' + path, { method, headers: { 'CF-Connecting-IP': '192.0.2.1', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), env, { waitUntil: task => tasks.push(task) });
    await Promise.all(tasks);
    return { status: response.status, body: await response.json() };
  }
  async function pair(id) {
    const start = await call('/pair/start', 'POST', { name: 'TV' });
    assert.equal(start.status, 200);
    assert.equal((await call('/pair/complete', 'POST', undefined, start.body.device_token)).body.paired, false);
    const update = { update_id: id, message: { chat: { type: 'private', id }, from: { id }, text: '/start ' + start.body.code } };
    const headers = { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' };
    assert.equal((await call('/telegram/webhook', 'POST', update, null, headers)).status, 200);
    assert.equal((await call('/telegram/webhook', 'POST', update, null, headers)).status, 200);
    assert.equal((await call('/pair/complete', 'POST', undefined, start.body.device_token)).body.paired, true);
    return start.body.device_token;
  }
  assert.equal((await call('/telegram/webhook', 'POST', {}, null, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
  assert.equal((await call('/pair/start', 'POST', { name: 'x'.repeat(3000) })).status, 413);
  const a = await pair(1), b = await pair(2);
  const envelope = { v: 1, salt: 'YQ==', iv: 'Yg==', data: 'Yw==' };
  assert.equal((await call('/backup', 'PUT', { version: 0, envelope }, a)).body.version, 1);
  assert.equal((await call('/backup', 'GET', undefined, b)).status, 404);
  assert.equal((await call('/backup', 'PUT', { version: 0, envelope }, a)).status, 409);
  const originalFetch = globalThis.fetch;
  const notices = [];
  env.BOT_TOKEN = 'test-bot';
  globalThis.fetch = async (_url, options) => {
    notices.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  };
  try {
    assert.equal((await call('/backup', 'PUT', { version: 1, envelope, fields: ['interface_size', 'interface_size', 'unknown'] }, a)).body.version, 2);
    assert.equal((await call('/backup', 'PUT', { version: 1, envelope, fields: ['interface_size'] }, a)).status, 409);
    assert.deepEqual(notices, [{ chat_id: '1', text: 'Lampa Sync: копия №2 сохранена.\n\nВ копии:\n• Размер интерфейса' }]);
  } finally { globalThis.fetch = originalFetch; }
  db.sqlite.exec('UPDATE ls_devices SET revoked=1 WHERE user_id=1');
  assert.equal((await call('/backup', 'GET', undefined, a)).status, 401);
  assert.equal((await call('/pair/complete', 'POST', undefined, a)).status, 410);
});
