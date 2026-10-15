const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(withObserver = true) {
  const observers = [];
  const media = [];
  const thumb = {
    querySelector: () => media[0],
    prepend(item) { media.unshift(item); item.parentNode = thumb; },
  };
  const card = { querySelector: selector => selector === '.card-thumb' ? thumb : media[0] };
  const gallery = { querySelectorAll: () => [card] };
  const context = {
    document: {
      addEventListener() {},
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          removeAttribute(name) { delete this[name]; },
          remove() { media.splice(media.indexOf(this), 1); this.parentNode = null; },
        };
      },
    },
    getThumbnailURL: value => '/local/' + value,
    gallery, effects: [{ id: 'one', name: 'Fire', files: { thumbnail: 'fire.gif' } }],
  };
  if (withObserver) context.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(__dirname, '../Tools~/webapp/js/gallery.js'), 'utf8'), context);
  return { run: code => vm.runInContext(code, context), observers, media, card };
}

test('previews load on entry, unload on exit, and reload on return', () => {
  const h = harness();
  h.run('observeGalleryPreviews(gallery, effects)');
  assert.equal(h.media.length, 0);
  const observer = h.observers[0];
  assert.equal(observer.options.rootMargin, '200px');
  const notify = visible => observer.callback([{ target: h.card, isIntersecting: visible }]);
  notify(true);
  const image = h.media[0];
  assert.equal(image.src, '/local/fire.gif');
  notify(true);
  assert.equal(h.media.length, 1);
  notify(false);
  assert.equal(h.media.length, 0);
  assert.equal(image.src, undefined);
  notify(true);
  assert.equal(h.media[0].src, '/local/fire.gif');
});

test('refresh releases previews and ignores stale visibility notifications', () => {
  const h = harness();
  h.run('observeGalleryPreviews(gallery, effects)');
  const observer = h.observers[0];
  observer.callback([{ target: h.card, isIntersecting: true }]);
  h.run('clearGalleryPreviews(gallery)');
  assert.equal(observer.disconnected, true);
  assert.equal(h.media.length, 0);
  observer.callback([{ target: h.card, isIntersecting: true }]);
  assert.equal(h.media.length, 0);
});

test('browsers without IntersectionObserver still load previews', () => {
  const h = harness(false);
  h.run('observeGalleryPreviews(gallery, effects)');
  assert.equal(h.media[0].src, '/local/fire.gif');
});
