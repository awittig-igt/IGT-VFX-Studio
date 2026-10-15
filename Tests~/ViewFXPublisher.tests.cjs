// Browser-controller tests: no live ViewFX account, package storage, or Unity required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function harness({ config = {} } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', disabled: false, hidden: false, listeners: {},
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { return !this.validationMessage; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      async fire(name, event = {}) { return this.listeners[name]?.({ preventDefault() {}, ...event }); },
      showModal() { this.open = true; },
      close() { this.open = false; this.fire('close'); },
    });
    return elements.get(id);
  }
  element('publish-viewfx-form').elements = { namedItem: name => element(`field-${name}`) };
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  };
  const localStorage = storage(), sessionStorage = storage();
  const document = { listeners: {}, getElementById: element, addEventListener(name, callback) { this.listeners[name] = callback; } };
  const calls = [], uploads = [];
  let uploadStatus = 201, uploadResult = { id: 42 }, pollStatus = 'connected';
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === '/api/config') return Response.json(config);
    if (String(url).includes('/api/publisher/')) assert.equal(options.credentials, 'omit');
    if (String(url).endsWith('/requests')) return Response.json({ id: 'test-request', pollToken: 'poll-secret', approvalUrl: 'http://localhost:5173/publisher/connect?request=test-request', expiresAt: new Date(Date.now() + 10000).toISOString() });
    if (String(url).endsWith('/poll')) return Response.json({ status: pollStatus, token: 'publisher-secret', user: { name: 'Test Publisher' } });
    if (String(url).includes('/local/')) return new Response('asset', { headers: { 'Content-Type': String(url).endsWith('.png') ? 'image/png' : 'application/octet-stream' } });
    return Response.json({ user: { name: 'Test Publisher' } });
  };
  class XHR {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(data) {
      uploads.push({ url: this.url, headers: this.headers, data });
      this.upload.onprogress({ lengthComputable: true, loaded: 10, total: 10 });
      this.upload.onload();
      this.status = uploadStatus; this.responseText = JSON.stringify(uploadResult); this.onload();
    }
  }
  const context = { document, localStorage, sessionStorage, fetch, URL, FormData, TextEncoder, crypto: webcrypto,
    AbortSignal, XMLHttpRequest: XHR, setTimeout: callback => setTimeout(callback, 0),
    window: { open: () => ({ location: { href: 'about:blank' } }) }, location: { href: 'http://localhost:8080/viewer.html?id=fire' },
    getConfig: () => ({ repo: 'example/effects' }),
    getEffectDownloadItems: effect => [
      ...(effect.files.package ? [{ kind: 'package', url: '/local/fire.unitypackage', filename: 'fire.unitypackage' }] : []),
      ...(effect.files.thumbnail ? [{ kind: 'preview', url: '/local/fire.png', filename: 'fire.png' }] : []),
    ],
  };
  vm.runInNewContext(readFileSync(require('node:path').join(__dirname, '../Tools~/webapp/js/viewfx-publisher.js'), 'utf8'), context);
  const ready = (overrides = {}, source = 'local') => document.listeners['effect-ready']({ detail: { source, effect: {
    id: 'fire', name: 'Fire', game: 'MyGame', type: 'particle', tags: ['Magic'], files: { package: 'fire.unitypackage', thumbnail: 'fire.png' }, ...overrides,
  } } });
  return { element, ready, calls, uploads, sessionStorage,
    setUpload(status, result) { uploadStatus = status; uploadResult = result; },
    setPoll(status) { pollStatus = status; } };
}

async function connected(h) {
  h.ready();
  await h.element('btn-publish-viewfx').fire('click');
  await h.element('publish-connect').fire('click');
  h.element('field-unityVersion').value = '2022.3.62f1';
  h.element('field-renderingPipeline').value = 'urp';
}

test('detail button requires a supported effect, package and preview', () => {
  const h = harness();
  h.ready(); assert.equal(h.element('btn-publish-viewfx').disabled, false);
  h.ready({ files: { package: 'fire.unitypackage' } }); assert.equal(h.element('btn-publish-viewfx').disabled, true);
  h.ready({ files: { thumbnail: 'fire.png' } }); assert.equal(h.element('btn-publish-viewfx').disabled, true);
  h.ready({ type: 'material' }); assert.equal(h.element('btn-publish-viewfx').disabled, true);
});

test('connect, review, upload, safe retry and disconnect', async () => {
  const h = harness();
  await connected(h);
  assert.match(h.element('publish-account').textContent, /Test Publisher/);
  assert.equal(h.element('publish-submit').disabled, false);
  await h.element('publish-viewfx-form').fire('submit');
  assert.equal(h.uploads.length, 1);
  const first = h.uploads[0];
  assert.equal(first.url, 'http://localhost:5173/api/publisher/cards');
  assert.equal(first.headers.Authorization, 'Bearer publisher-secret');
  assert.equal(first.headers['X-Source-Id'].length, 64);
  assert.equal(first.data.get('name'), 'Fire');
  assert.equal(first.data.get('tags'), '["MyGame"]');
  assert.equal(first.data.get('unityVersion'), '2022.3.62f1');
  assert.equal(first.data.get('package').name, 'fire.unitypackage');
  assert.equal(first.data.get('media').type, 'image/png');
  assert.match(h.element('publish-status').textContent, /Published to ViewFX/);
  assert.equal(h.element('publish-result').href, 'http://localhost:5173/?effect=42');
  h.setUpload(200, { id: 42, alreadyPublished: true });
  await h.element('publish-viewfx-form').fire('submit');
  assert.equal(h.uploads[1].headers['X-Source-Id'], first.headers['X-Source-Id']);
  assert.match(h.element('publish-status').textContent, /already published/);
  await h.element('publish-disconnect').fire('click');
  assert.equal(h.sessionStorage.getItem('viewfx-publisher'), null);
  assert.equal(h.element('publish-submit').disabled, true);
  assert.ok(h.calls.some(call => call.url.endsWith('/connection') && call.options.method === 'DELETE'));
});

test('publishing failures are visible and leave retry available', async () => {
  const h = harness(); await connected(h);
  h.setUpload(422, { error: 'Package validation failed.' });
  await h.element('publish-viewfx-form').fire('submit');
  assert.equal(h.element('publish-status').textContent, 'Package validation failed.');
  assert.equal(h.element('publish-submit').disabled, false);
  assert.equal(h.element('publish-result').hidden, true);
});

test('insecure remote URLs and denied approvals do not produce upload access', async () => {
  const h = harness(); h.ready(); await h.element('btn-publish-viewfx').fire('click');
  h.element('field-site').value = 'http://example.com';
  await h.element('publish-connect').fire('click');
  assert.equal(h.calls.filter(call => call.url !== '/api/config').length, 0);
  assert.match(h.element('publish-status').textContent, /HTTPS/);
  h.element('field-site').value = 'http://localhost:5173'; h.setPoll('denied');
  await h.element('publish-connect').fire('click');
  assert.match(h.element('publish-status').textContent, /denied/);
  assert.equal(h.element('publish-submit').disabled, true);
  assert.equal(h.sessionStorage.getItem('viewfx-publisher'), null);
});

test('Unity version is prefilled from the selected effect and stays editable', async () => {
  const h = harness();
  h.ready({ unityVersion: '6000.3.15f1', metadata: { unityVersion: '2022.3.62f1' } });
  await h.element('btn-publish-viewfx').fire('click');
  assert.equal(h.element('field-unityVersion').value, '6000.3.15f1');
  assert.equal(h.calls.length, 0);
  h.ready({ name: 'Second effect', metadata: { unityVersion: '2022.3.62f1' } });
  await h.element('btn-publish-viewfx').fire('click');
  assert.equal(h.element('field-name').value, 'Second effect');
  assert.equal(h.element('field-unityVersion').value, '2022.3.62f1');
  h.element('field-unityVersion').value = '2022.3.63f1';
  await h.element('publish-connect').fire('click');
  const request = h.calls.find(call => call.url.endsWith('/requests'));
  assert.equal(JSON.parse(request.options.body).unityVersion, '2022.3.63f1');
});

test('legacy local effects use only the matching source project version', async () => {
  const config = { sourceProjectPath: 'C:\\Games\\MyGame', sourceProjectValidation: { editorVersion: '2022.3.62f1' },
    previewProjectValidation: { editorVersion: '6000.3.15f1' } };
  for (const [effect, source, expected] of [
    [{ sourceProjectPath: 'c:/games/mygame/' }, 'local', '2022.3.62f1'],
    [{ game: 'MyGame', importSource: 'project-scan' }, 'local', '2022.3.62f1'],
    [{ sourceProjectPath: 'C:/Games/Other', game: 'MyGame', importSource: 'project-scan' }, 'local', ''],
    [{ game: 'Other', importSource: 'project-scan' }, 'local', ''],
    [{ game: 'MyGame', importSource: 'manual-upload' }, 'local', ''],
    [{ game: 'MyGame', importSource: 'project-scan' }, 'github', ''],
  ]) {
    const h = harness({ config }); h.ready(effect, source);
    await h.element('btn-publish-viewfx').fire('click');
    assert.equal(h.element('field-unityVersion').value, expected);
  }
});

test('invalid tags block uploads and correcting them clears validation', async () => {
  const h = harness(); await connected(h);
  for (const value of ['Fire,,Magic', ',Fire', 'Fire, ', 'x'.repeat(101), 'Fire\nMagic', 'Fire\u007f']) {
    h.element('field-tags').value = value;
    await h.element('field-tags').fire('input');
    assert.match(h.element('field-tags').validationMessage, /Separate tags with commas/);
    await h.element('publish-viewfx-form').fire('submit');
    assert.equal(h.uploads.length, 0);
  }
  h.element('field-tags').value = ' My Game, Dragon’s Gold™, ゲーム ';
  await h.element('field-tags').fire('input');
  assert.equal(h.element('field-tags').validationMessage, '');
  await h.element('publish-viewfx-form').fire('submit');
  assert.equal(h.uploads[0].data.get('tags'), '["My Game","Dragon’s Gold™","ゲーム"]');
  h.element('field-tags').value = '';
  await h.element('publish-viewfx-form').fire('submit');
  assert.equal(h.uploads[1].data.get('tags'), '[]');
});
