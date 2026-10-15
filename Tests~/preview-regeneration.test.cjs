const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Tools~/webapp/js/preview-regeneration.js'), 'utf8');

function setup(states, saved) {
  const messages = [], calls = [], events = [], listeners = {}, nodes = {};
  const button = { disabled: false, dataset: {} };
  const panel = {
    classList: { toggle() {} }, setAttribute() {},
    querySelector(selector) {
      return nodes[selector] ||= { set textContent(value) { messages.push(value); }, removeAttribute() {} };
    }
  };
  const storage = new Map(saved ? [['findfx-preview-regeneration', JSON.stringify(saved)]] : []);
  const context = {
    window: {}, URLSearchParams, location: { search: '' }, Date,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { createElement: () => panel, body: { append() {} }, querySelectorAll: () => [button],
      addEventListener: (name, fn) => { listeners[name] = fn; }, dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: fn => { fn(); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = url === '/api/regenerate-preview' ? { ok: true, jobId: 'job-1' }
        : url === '/local/manifest.json' ? { effects: [{ id: 'effect-1', files: { thumbnail: 'new.gif' } }] }
        : { logPath: '/jobs/job-1/extraction.log', ...states.shift() };
      return { ok: true, json: async () => body };
    }
  };
  vm.runInNewContext(source, context);
  return { context, messages, calls, events, button, storage, listeners };
}

test('tracks phases through completion and refreshes only after publishing', async () => {
  const s = setup([
    { state: 'running', phase: 'import', progress: 50, message: 'Importing' },
    { state: 'running', phase: 'encode', progress: 80, message: 'Encoding GIF' },
    { state: 'complete', phase: 'complete', progress: 100 }
  ]);
  await s.context.window.regenerateUnityPreview({ id: 'effect-1', name: 'Test' }, 'local');
  assert(s.messages.some(text => text.includes('Encoding GIF')));
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].detail.effect.files.thumbnail, 'new.gif');
  assert.equal(s.calls[0].url, '/api/regenerate-preview');
  assert(!s.calls.some(call => call.url === '/api/upload-package'));
  assert(s.calls.every(call => call.options.cache === 'no-store'));
  assert.equal(s.button.disabled, false);
  assert.equal(s.storage.size, 0);
});

test('keeps the failure message and does not refresh an unsuccessful capture', async () => {
  const s = setup([{ state: 'failed', message: 'Shader compilation failed' }]);
  await s.context.window.regenerateUnityPreview({ id: 'effect-1' }, 'local');
  assert(s.messages.includes('Shader compilation failed'));
  assert.equal(s.events.length, 0);
  assert(!s.calls.some(call => call.url === '/local/manifest.json'));
  assert.equal(s.button.disabled, false);
});

test('rejects a replaced job instead of claiming its preview completed', async () => {
  const s = setup([{ logPath: '/jobs/other/extraction.log', state: 'complete' }]);
  await s.context.window.regenerateUnityPreview({ id: 'effect-1' }, 'local');
  assert.equal(s.events.length, 0);
  assert(s.messages.some(text => text.includes('Another generation job')));
});

test('resumes monitoring after navigation without starting another Unity job', async () => {
  const s = setup([{ state: 'complete', progress: 100 }], {
    jobId: 'job-1', effectId: 'effect-1', name: 'Test', startedAt: Date.now()
  });
  s.listeners.DOMContentLoaded();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.events.length, 1);
  assert(!s.calls.some(call => call.url === '/api/regenerate-preview'));
});

test('embedded side viewers do not duplicate the job status panel', () => {
  const s = setup([], { jobId: 'job-1', startedAt: Date.now() });
  s.context.location.search = '?embed=1';
  s.listeners.DOMContentLoaded();
  assert.equal(s.calls.length, 0);
});

test('switching cards keeps regeneration disabled with an explanation until completion', async () => {
  const s = setup([{ state: 'complete', progress: 100 }]);
  s.button.dataset.effectId = 'effect-1';
  const pending = s.context.window.regenerateUnityPreview({ id: 'effect-1' }, 'local');
  assert.equal(s.button.disabled, true);
  assert.equal(s.button.textContent, 'Generating Unity Preview…');
  s.button.dataset.effectId = 'effect-2';
  s.context.window.refreshPreviewRegenerationButtons();
  assert.equal(s.button.disabled, true);
  assert.equal(s.button.textContent, 'Another effect is currently generating');
  assert.equal(s.button.title, 'Another effect is currently generating');
  await pending;
  assert.equal(s.button.disabled, false);
  assert.equal(s.button.textContent, 'Regenerate Unity Preview');
});
