import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const base = { DB: {}, BACKUPS: {}, BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', ADMIN_SETUP_KEY: 'test-admin-key' };
const request = () => new Request('https://untrusted.example/admin/register-webhook', { method: 'POST', headers: { authorization: 'Bearer test-admin-key' } });

test('registration fails closed without an explicitly configured URL', async () => {
  const result = await worker.fetch(request(), base);
  assert.equal(result.status, 503);
});

test('registration rejects unsafe or malformed destinations', async () => {
  for (const url of ['http://example.com/telegram/webhook', 'https://example.com/other', 'https://user@example.com/telegram/webhook', 'https://example.com/telegram/webhook?x=1']) {
    const result = await worker.fetch(request(), { ...base, TELEGRAM_WEBHOOK_URL: url });
    assert.equal(result.status, 503, url);
  }
});

test('registration uses the configured URL, not the request host', async () => {
  const original = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await worker.fetch(request(), { ...base, TELEGRAM_WEBHOOK_URL: 'https://trusted.example/telegram/webhook' });
    assert.equal(result.status, 200);
    assert.equal(payload.url, 'https://trusted.example/telegram/webhook');
  } finally {
    globalThis.fetch = original;
  }
});
