// Experimental manual-sync candidate. Do not publish or use with valuable data.
(function () {
  'use strict';
  if (window.LampaSyncV2Candidate) return;
  window.LampaSyncV2Candidate = true;
  var prefix = 'lampa_sync_v2_';
  // Set only for an isolated test Worker. Never point this candidate at production.
  var base = '';
  function note(text) { if (window.Lampa && Lampa.Noty) Lampa.Noty.show(text); else alert(text); }
  function get(k) { return localStorage.getItem(prefix + k) || ''; }
  function set(k, v) { localStorage.setItem(prefix + k, v); }
  function check() {
    if (!window.isSecureContext || !window.crypto || !crypto.subtle || !crypto.getRandomValues || !window.fetch || !window.TextEncoder || !window.TextDecoder) throw Error('Устройство не поддерживает необходимое безопасное шифрование.');
  }
  function b64(a) { var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function un64(s) { var x = atob(s), a = new Uint8Array(x.length); for (var i = 0; i < x.length; i++) a[i] = x.charCodeAt(i); return a; }
  async function key(password, salt) {
    var raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 250000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(value, password) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    var encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await key(password, salt), new TextEncoder().encode(JSON.stringify(value)));
    return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(encrypted)) };
  }
  async function open(envelope, password) {
    if (!envelope || envelope.v !== 1) throw Error('Неизвестный формат копии');
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(envelope.iv) }, await key(password, un64(envelope.salt)), un64(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  function password() { var p = prompt('Введите общий пароль шифрования (не менее 12 символов)'); if (!p || p.length < 12) throw Error('Нужен пароль от 12 символов'); return p; }
  async function request(path, method, data, auth) {
    if (!/^https:\/\//.test(base)) throw Error('Тестовый сервер не настроен');
    var headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = 'Bearer ' + auth;
    var r = await fetch(base + path, { method: method, headers: headers, body: data ? JSON.stringify(data) : undefined });
    if (path === '/backup' && method === 'GET' && r.status === 404) return null;
    if (!r.ok) { if (r.status === 409) throw Error('Копия изменилась на другом устройстве. Сначала восстановите актуальную копию.'); throw Error('Ошибка сервера: ' + r.status); }
    return r.json();
  }
  async function pair() {
    check(); var name = prompt('Название устройства', 'Телевизор'); if (name === null) return;
    var result = await request('/pair/start', 'POST', { name: name });
    set('pending', result.device_token);
    alert('Откройте @my_lampa_sync_bot в Telegram и отправьте:\n/start ' + result.code + '\nЗатем выберите «Проверить подключение». Код действует 10 минут.');
  }
  async function finish() {
    check(); var pending = get('pending'); if (!pending) throw Error('Сначала начните подключение');
    var result = await request('/pair/complete', 'POST', null, pending);
    if (!result.paired) { note('Ожидается подтверждение в Telegram'); return; }
    set('token', pending); localStorage.removeItem(prefix + 'pending'); localStorage.removeItem(prefix + 'version'); note('Устройство подключено');
  }
  function token() { var t = get('token'); if (!t) throw Error('Сначала подключите устройство'); return t; }
  var fields = {
    interface_size: ['small', 'normal', 'bigger'],
    poster_size: ['w200', 'w300', 'w500'],
    background_type: ['complex', 'simple', 'poster']
  };
  function storage() {
    var api = Lampa.Storage;
    if (!api || typeof api.get !== 'function' || typeof api.set !== 'function') throw Error('Эта сборка Lampa не предоставляет доступ к настройкам');
    return api;
  }
  function snapshot() {
    var api = storage(), settings = {};
    Object.keys(fields).forEach(function (name) {
      var value = api.get(name, null);
      if (fields[name].indexOf(value) !== -1) settings[name] = value;
    });
    if (!Object.keys(settings).length) throw Error('Измените хотя бы одну поддерживаемую настройку интерфейса в Lampa');
    return { format: 'lampa-interface-v1', settings: settings };
  }
  function validate(value) {
    if (!value || value.format !== 'lampa-interface-v1' || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw Error('Неизвестный формат настроек');
    var names = Object.keys(value.settings);
    if (!names.length || names.some(function (name) {
      return !Object.prototype.hasOwnProperty.call(fields, name) || fields[name].indexOf(value.settings[name]) === -1;
    })) throw Error('Копия содержит неподдерживаемые настройки');
    return names;
  }
  async function backup() {
    check(); var t = token(), value = snapshot();
    var remote = await request('/backup', 'GET', null, t);
    var version = remote ? remote.version : 0;
    if (remote && String(version) !== get('version')) throw Error('Сначала восстановите актуальную копию с сервера');
    var p = password();
    if (remote) validate(await open(remote.envelope, p));
    var result = await request('/backup', 'PUT', { version: Number(version), envelope: await seal(value, p) }, t);
    set('version', String(result.version)); note('Копия сохранена');
  }
  async function restore() {
    check(); var result = await request('/backup', 'GET', null, token());
    if (!result) { note('Сохранённых копий пока нет'); return; }
    var value = await open(result.envelope, password());
    var names = validate(value), api = storage();
    if (!confirm('Применить настройки интерфейса из копии (' + names.length + ')?')) return;
    names.forEach(function (name) { api.set(name, value.settings[name]); });
    set('version', String(result.version));
    note('Настройки применены. Если интерфейс не обновился, перезапустите Lampa.');
  }
  function run(fn) { Promise.resolve().then(fn).catch(function (e) { note('Lampa Sync: ' + e.message); }); }
  function init() {
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addComponent || !Lampa.SettingsApi.addParam) { setTimeout(init, 1000); return; }
    Lampa.SettingsApi.addComponent({ component: 'lampa_sync_v2', name: 'Lampa Sync (тест)', icon: 'sync' });
    [['pair', 'Подключить устройство', pair], ['finish', 'Проверить подключение', finish], ['backup', 'Сохранить копию', backup], ['restore', 'Восстановить копию', restore]].forEach(function (x) {
      Lampa.SettingsApi.addParam({ component: 'lampa_sync_v2', param: { name: prefix + x[0], type: 'button' }, field: { name: x[1] }, onChange: function () { run(x[2]); } });
    });
  }
  init();
})();
