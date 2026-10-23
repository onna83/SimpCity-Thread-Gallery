'use strict';

// The unit tests slice pure functions out of the source; nothing exercised the
// module body itself, so an identifier used above its own `const` declaration
// would pass every test and then throw on the first line of a real page load,
// leaving no launcher and no error anyone would think to look for.
//
// This boots the whole userscript against a deliberately thin DOM. It does not
// try to be a browser: selectors resolve to inert stubs and nothing renders.
// What it proves is that the module body runs to completion and installs its
// launcher, which is exactly the failure the unit tests cannot see.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'SimpCity-Thread-Gallery-Timeline.user.js'), 'utf8');

function makeClassList() {
  const classes = new Set();
  return {
    add: (...names) => names.forEach(name => name && classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : Boolean(force);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
  };
}

function makeDom() {
  const byId = new Map();

  const register = node => {
    if (node && node.id) byId.set(node.id, node);
    return node;
  };

  const makeNode = (tag = 'div') => {
    const attributes = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      checked: false,
      indeterminate: false,
      children: [],
      dataset: {},
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      setAttribute: (key, value) => attributes.set(key, String(value)),
      getAttribute: key => (attributes.has(key) ? attributes.get(key) : null),
      hasAttribute: key => attributes.has(key),
      removeAttribute: key => attributes.delete(key),
      toggleAttribute(key, force) {
        const on = force === undefined ? !attributes.has(key) : Boolean(force);
        if (on) attributes.set(key, '');
        else attributes.delete(key);
        return on;
      },
      appendChild(child) {
        node.children.push(child);
        return register(child);
      },
      append(...nodes) {
        nodes.forEach(child => node.appendChild(child));
      },
      replaceChildren(...nodes) {
        node.children = nodes;
      },
      insertBefore(child) {
        return node.appendChild(child);
      },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      blur() {},
      click() {},
      contains: () => false,
      matches: () => false,
      closest: () => null,
      // Every selector resolves, so the wiring block can attach handlers. A
      // null here would only prove that this harness is thin.
      querySelector: selector => selector === '[data-group-by]'
        ? (node.groupControl ||= makeNode('select')) : makeNode(),
      querySelectorAll: selector => selector === '[data-filter="post"]'
        ? [node.postTab ||= makeNode('button')] : [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    };
    return node;
  };

  const document = {
    head: makeNode('head'),
    body: makeNode('body'),
    documentElement: makeNode('html'),
    activeElement: null,
    scripts: [],
    baseURI: 'https://simpcity.cr/threads/example.1/',
    createElement: tag => makeNode(tag),
    createTextNode: () => makeNode('#text'),
    createDocumentFragment: () => makeNode('#fragment'),
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    exitFullscreen: () => Promise.resolve(),
  };

  return { document, byId, makeNode };
}

function boot(savedSettings = {}) {
  const { document, byId } = makeDom();
  const store = new Map();
  store.set('sc-thread-gallery-timeline-settings-v1', JSON.stringify(savedSettings));
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };

  const windowListeners = [];
  const sandbox = {
    document,
    localStorage,
    // The module body registers an unload guard on the window itself.
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    location: new URL('https://simpcity.cr/threads/example.1/page-2'),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.reject(new Error('offline')),
    URL,
    Blob: class Blob {},
    TextEncoder,
    TextDecoder,
    DOMParser: class DOMParser { parseFromString() { return document; } },
    DOMException: globalThis.DOMException,
    AbortController: globalThis.AbortController,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    Image: class { decode() { return Promise.resolve(); } },
    console: { debug() {}, error() {}, warn() {}, log() {} },
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location.href = 'https://simpcity.cr/threads/example.1/page-2';

  vm.runInNewContext(source, sandbox, { filename: 'SimpCity-Thread-Gallery-Timeline.user.js' });
  return Object.assign(byId, { windowListeners });
}

test('the userscript module body runs to completion on a bare page', () => {
  let byId;
  assert.doesNotThrow(() => { byId = boot(); });

  // Nothing else in the script matters if this is missing: the launcher is the
  // only way in.
  assert.ok(byId.has('scg-tl-launch'), 'launcher button was never appended');
  assert.ok(byId.has('sc-thread-gallery-tl'), 'gallery shell was never appended');
  assert.ok(byId.has('scg-tl-toast'), 'toast host was never appended');
});

test('opening the gallery runs the render path end to end', () => {
  const byId = boot();
  const launcher = byId.get('scg-tl-launch');
  assert.equal(typeof launcher.onclick, 'function');
  // Everything the unit tests cover is a slice of a pure function. render() is
  // where those slices are actually wired together, and it has no other cover.
  assert.doesNotThrow(() => launcher.onclick());
});

test('the Posts tab is visible only while Group by reply is enabled', () => {
  const byId = boot();
  const app = byId.get('sc-thread-gallery-tl');
  const postTab = app.querySelectorAll('[data-filter="post"]')[0];
  assert.equal(postTab.hidden, true);
  byId.get('scg-tl-launch').onclick();
  const group = app.querySelector('[data-group-by]');
  group.onchange({ target: { value: 'reply' } });
  assert.equal(postTab.hidden, false);
  group.onchange({ target: { value: 'none' } });
  assert.equal(postTab.hidden, true);

  const restored = boot({ groupBy: 'reply', filter: 'post' });
  assert.equal(restored.get('sc-thread-gallery-tl').querySelectorAll('[data-filter="post"]')[0].hidden, false);
  assert.doesNotThrow(() => restored.get('scg-tl-launch').onclick());
});
