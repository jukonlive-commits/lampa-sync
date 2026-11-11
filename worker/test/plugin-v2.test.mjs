import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('encrypted settings move between devices and stale writes are refused', async () => {
  const code = (await readFile(new URL('../../plugin-v2-candidate.js', import.meta.url), 'utf8'))
    .replace("var base = ''", "var base = 'https://test.example'");
  let remote = null;
  const fetch = async (_url, options) => {
    if (options.method === 'GET') return remote ? Response.json(remote) : Response.json({}, { status: 404 });
    const data = JSON.parse(options.body);
    assert.equal(data.version, remote?.version ?? 0);
    assert.deepEqual(data.fields, ['interface_size']);
    assert.equal(JSON.stringify(data).includes('bigger'), false);
    remote = { version: data.version + 1, envelope: data.envelope };
    return Response.json({ version: remote.version });
  };
  function device(settings) {
    const actions = {}, local = new Map([['lampa_sync_v2_token', 'test']]);
    let report;
    const context = {
      crypto, fetch, TextEncoder, TextDecoder, atob, btoa, isSecureContext: true,
      confirm: () => true,
      localStorage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) },
      Lampa: {
        Input: { edit(options, submit) {
          assert.equal(options.password, true);
          assert.equal(options.nosave, true);
          assert.equal(options.keyboard, 'lampa');
          submit('testpass');
        } },
        Noty: { show: value => report(value) },
        Storage: { get: k => settings[k], set: (k, v) => { settings[k] = v; } },
        SettingsApi: { addComponent() {}, addParam: x => { actions[x.param.name] = x.onChange; } }
      }
    };
    context.window = context;
    runInNewContext(code, context);
    return action => new Promise(resolve => {
      report = resolve;
      actions['lampa_sync_v2_' + action]();
    });
  }
  const first = device({ interface_size: 'bigger', token: 'private' });
  const secondSettings = { interface_size: 'small', token: 'other' };
  const second = device(secondSettings);
  assert.equal(await first('backup'), 'Копия сохранена');
  assert.match(await second('backup'), /Сначала восстановите/);
  assert.match(await second('restore'), /Настройки применены/);
  assert.deepEqual(secondSettings, { interface_size: 'bigger', token: 'other' });
  assert.equal(await second('backup'), 'Копия сохранена');
  assert.match(await first('backup'), /Сначала восстановите/);
});
