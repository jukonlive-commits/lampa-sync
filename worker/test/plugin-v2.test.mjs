import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('encrypted settings move between devices and can be saved again without restoring', async () => {
  const code = (await readFile(new URL('../../plugin-v2-candidate.js', import.meta.url), 'utf8'))
    .replace("var base = ''", "var base = 'https://test.example'");
  let remote = null;
  const fetch = async (_url, options) => {
    if (options.method === 'GET') return remote ? Response.json(remote) : Response.json({}, { status: 404 });
    const data = JSON.parse(options.body);
    assert.equal(data.version, remote?.version ?? 0);
    assert.deepEqual(data.fields, ['interface_size', 'plugins', 'parsers', 'interface']);
    assert.equal(JSON.stringify(data).includes('bigger'), false);
    assert.equal(JSON.stringify(data).includes('private-parser-key'), false);
    assert.equal(JSON.stringify(data).includes('extensions.example'), false);
    remote = { version: data.version + 1, envelope: data.envelope };
    return Response.json({ version: remote.version });
  };
  function device(settings) {
    const actions = {}, local = new Map([['lampa_sync_v2_token', 'test']]);
    let report;
    function element() {
      const data = {}, children = [];
      const item = {
        0: {}, children, label: '',
        css() { return item; },
        text(value) { item.label = value; return item; },
        append(...values) { children.push(...values); return item; },
        data(key, value) { if (arguments.length === 1) return data[key]; data[key] = value; return item; }
      };
      return item;
    }
    const context = {
      crypto, fetch, TextEncoder, TextDecoder, atob, btoa, isSecureContext: true,
      $: element,
      localStorage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v) },
      Lampa: {
        Modal: {
          open(options) {
            if (options.title === 'Пароль резервной копии') {
              const [display, grid, controls] = options.html.children;
              for (const character of 'testpass') {
                options.onSelect(grid.children.find(item => item.label === character));
              }
              assert.match(display.label, /^(•{8})/);
              assert.equal(display.label.includes('testpass'), false);
              options.onSelect(controls.children.find(item => item.label === 'Готово'));
            } else {
              options.onSelect(options.html.children[0]);
            }
          },
          close() {}
        },
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
  const extensions = [{ url: 'https://extensions.example/tv.js', name: 'TV', status: 1 }];
  const localExtension = { url: 'https://example.test/local.js', status: 0 };
  const first = device({ interface_size: 'bigger', animation: false, jackett_key: 'private-parser-key', plugins: extensions, token: 'private' });
  const secondSettings = { interface_size: 'small', plugins: [localExtension], token: 'other' };
  const second = device(secondSettings);
  assert.equal(await first('backup'), 'Копия сохранена');
  assert.match(await second('restore'), /Настройки применены/);
  assert.equal(secondSettings.interface_size, 'bigger');
  assert.equal(secondSettings.animation, false);
  assert.equal(secondSettings.jackett_key, 'private-parser-key');
  assert.equal(secondSettings.token, 'other');
  assert.deepEqual(JSON.parse(JSON.stringify(secondSettings.plugins)), [...extensions, localExtension]);
  assert.equal(await second('backup'), 'Копия сохранена');
  assert.equal(await first('backup'), 'Копия сохранена');
  assert.equal(remote.version, 3);
});
