'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function events() {
  const listeners = new Set();
  return { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    emit(...values) { for (const fn of [...listeners]) fn(...values); } };
}

class Element {
  constructor() {
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.handlers = new Map();
    this.attributes = new Map();
    this.slots = new Map();
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) { if (!this.slots.has(selector)) this.slots.set(selector, new Element()); return this.slots.get(selector); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, value) { for (const fn of [...(this.handlers.get(type) || [])]) fn(value); }
  click() { if (!this.disabled) this.emit('click'); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  getBoundingClientRect() { return { height: 144 }; }
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function resultMessage(frame, action, extra = {}) {
  const params = new URLSearchParams(new URL(frame.src).hash.slice(1));
  return { action, downloadId: Number(params.get('id')), channel: params.get('channel'), ...extra };
}

function page(target, file, options = {}) {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    documentElement: new Element(),
    body: new Element(), head: new Element(),
    getElementById: element,
    createElement(tag) { const node = new Element(); if (tag === 'iframe') node.contentWindow = {}; return node; },
    addEventListener() {}
  };
  const window = new Element();
  const posted = [];
  window.parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const runtimeId = target === 'firefox' ? 'exporter@example.test' : 'test-extension';
  const origin = target === 'firefox' ? 'moz-extension://test-uuid' : 'chrome-extension://test-extension';
  const changed = events();
  const erased = events();
  const incoming = events();
  const opened = [];
  const timers = new Map();
  let timerId = 0;
  let item = { id: 42, filename: '/Downloads/Fixture_1.md', state: 'complete', exists: true, byExtensionId: runtimeId, ...options.item };
  if (options.missing) item = null;
  const searches = [];
  const chrome = {
    storage: { local: { async get() { return { gceTheme: options.theme }; }, async set() {} }, onChanged: events() },
    runtime: { id: runtimeId, getURL: value => `${origin}/${value}`, onMessage: incoming },
    downloads: {
      async search(query) { searches.push(query); return item ? [item] : []; },
      open(id) { opened.push(id); return Promise.resolve(); },
      onChanged: changed, onErased: erased
    }
  };
  const context = vm.createContext({ document, window, chrome, URLSearchParams, console, Promise, crypto: require('node:crypto').webcrypto,
    location: { hash: options.hash || '#id=42&filename=Fixture.md' },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { observe() {} disconnect() {} }
  });
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, name), 'utf8'), context, { filename: `${target}/${name}` });
  load('theme.js');
  if (file === 'popup.js') { element('export-result').hidden = true; load('result-host.js'); }
  load(file);
  return { context, load, document, window, chrome, element, elements, posted, opened, searches, timers, changed, erased, incoming, origin,
    setItem(value) { item = value; }, getItem() { return item; } };
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: the real progress notification follows the theme and unsubscribes when dismissed`, async () => {
    const p = page(target, 'result-host.js', { theme: 'dark' });
    p.document.querySelector = () => null;
    p.document.querySelectorAll = () => [];
    p.context.fetch = async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', target, 'selectors.json'), 'utf8')) });
    p.chrome.runtime.sendMessage = async () => ({});
    p.load('content.js');
    await settle();
    p.context.showProgress('Collecting fixture messages', 15);
    const root = p.document.documentElement;
    const notification = root.children[0];
    assert.equal(notification.getAttribute('data-gce-theme'), 'dark');
    assert.equal(root.getAttribute('data-gce-theme'), null, 'Chat itself must retain its own theme');
    p.chrome.storage.onChanged.emit({ gceTheme: { newValue: 'light' } }, 'local');
    assert.equal(notification.getAttribute('data-gce-theme'), 'light');
    p.context.hideProgress();
    p.chrome.storage.onChanged.emit({ gceTheme: { newValue: 'dark' } }, 'local');
    assert.equal(notification.getAttribute('data-gce-theme'), 'light', 'a dismissed notification must no longer receive updates');
    assert.equal(root.children.length, 0);
  });

  test(`${target}: the popup dark-mode toggle saves its choice without hiding export progress`, async () => {
    const p = page(target, 'popup.js', { theme: 'dark' });
    await settle();
    assert.equal(p.document.documentElement.getAttribute('data-gce-theme'), 'dark');
    assert.equal(p.element('dark-mode').checked, true);
    p.incoming.emit({ action: 'exportJobUpdate', job: { jobId: 'job-1', state: 'working', phase: 'media',
      text: 'Downloading media', percent: 50, startedAt: 10, revision: 1 } });
    let stored;
    p.chrome.storage.local.set = async value => { stored = value.gceTheme; };
    p.element('dark-mode').checked = false;
    await p.context.toggleDarkMode();
    assert.equal(stored, 'light');
    assert.equal(p.document.documentElement.getAttribute('data-gce-theme'), 'light');
    assert.equal(p.element('status-text').textContent, 'Downloading media');
    p.chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
    p.element('dark-mode').checked = true;
    await p.context.toggleDarkMode();
    assert.equal(p.element('dark-mode').checked, false);
    assert.equal(p.element('theme-error').hidden, false);
    assert.equal(p.element('export-btn').disabled, true);
  });

  test(`${target}: a visible saved-result card changes theme without opening or dismissing the file`, async () => {
    const p = page(target, 'export-result.js', { theme: 'dark', hash: '#id=42&warning=Fixture%20warning' });
    await settle();
    assert.equal(p.document.documentElement.getAttribute('data-gce-theme'), 'dark');
    assert.equal(p.element('heading').textContent, 'Export saved with warnings');
    p.chrome.storage.onChanged.emit({ gceTheme: { newValue: 'light' } }, 'local');
    assert.equal(p.document.documentElement.getAttribute('data-gce-theme'), 'light');
    assert.equal(p.element('open').disabled, false);
    assert.equal(p.element('warning').textContent, 'Fixture warning');
    assert.deepEqual(p.opened, []);
  });

  test(`${target}: reopening the popup restores a paused export and controls its original job`, async () => {
    const p = page(target, 'popup.js');
    const calls = [];
    let job = { jobId: 'job-1', state: 'paused', phase: 'history', text: 'Waiting for Chat', percent: 15,
      conversationName: 'Fixture space', startedAt: 10, revision: 1 };
    p.chrome.runtime.sendMessage = async msg => {
      calls.push(msg);
      if (msg.action === 'getExportJobs') return { jobs: [job] };
      return { success: true };
    };
    await p.context.loadExportJobs();
    assert.equal(p.element('status-text').textContent, 'Waiting for Chat');
    assert.equal(p.element('job-name').textContent, 'Fixture space');
    assert.equal(p.element('export-btn').disabled, true);
    assert.equal(p.element('return-to-chat').hidden, false);
    assert.equal(p.element('cancel-export').hidden, false);
    assert.equal(p.element('dismiss-status').hidden, true);
    assert.equal(p.element('status-spinner').style.display, 'none');
    assert.equal(p.timers.size, 0, 'a paused export never disappears on a timer');
    await p.context.controlExportJob('focusExportJob');
    assert.ok(calls.some(msg => msg.action === 'focusExportJob' && msg.jobId === 'job-1'));
    job = { ...job, state: 'error', phase: 'cancelled', text: 'Export cancelled.', revision: 2 };
    await p.context.controlExportJob('cancelExportJob');
    assert.ok(calls.some(msg => msg.action === 'cancelExportJob' && msg.jobId === 'job-1'));
    assert.equal(p.element('status-text').textContent, 'Export cancelled.');
    assert.equal(p.element('export-btn').disabled, false);
    assert.equal(p.element('dismiss-status').hidden, false);
    assert.equal(p.timers.size, 0, 'terminal failures remain readable until dismissed');
    p.context.dismissExportJob();
    assert.ok(calls.some(msg => msg.action === 'acknowledgeExportJob' && msg.jobId === 'job-1'));
    assert.equal(p.element('status-area').classList.contains('visible'), false);
  });

  test(`${target}: stale hydration and an older completion cannot replace a running export`, async () => {
    const p = page(target, 'popup.js');
    let reply;
    p.chrome.runtime.sendMessage = () => new Promise(resolve => { reply = resolve; });
    const loading = p.context.loadExportJobs();
    const running = { jobId: 'job-2', state: 'working', phase: 'media', text: 'Downloading media', percent: 50, startedAt: 20, revision: 3 };
    p.incoming.emit({ action: 'exportJobUpdate', job: running });
    reply({ jobs: [{ ...running, state: 'done', text: 'Stale snapshot', revision: 2 }] });
    await loading;
    p.incoming.emit({ action: 'exportJobUpdate', job: { jobId: 'job-1', state: 'done', phase: 'complete',
      text: 'Older export saved', downloadId: 41, filename: 'Older.md', startedAt: 10, revision: 5 } });
    assert.equal(p.element('status-text').textContent, 'Downloading media');
    assert.equal(p.element('export-btn').disabled, true);
    assert.equal(p.element('export-result').hidden, true);
    p.incoming.emit({ action: 'exportStateUpdate', jobId: 'job-2', state: 'done', filename: 'Premature.md', downloadId: 42 });
    assert.equal(p.element('export-btn').disabled, true, 'raw content relays cannot bypass the background download state');
    assert.equal(p.element('export-result').hidden, true);
  });

  test(`${target}: saving and saved results survive reopening, and dismissal does not lose an older file`, async () => {
    const p = page(target, 'popup.js');
    const calls = [];
    const first = { jobId: 'job-1', state: 'working', phase: 'download', text: 'Saving export', downloadId: 41,
      filename: 'First.md', percent: 95, startedAt: 10, revision: 1 };
    p.chrome.runtime.sendMessage = async msg => { calls.push(msg); return { jobs: [first] }; };
    await p.context.loadExportJobs();
    let host = p.element('export-result');
    assert.equal(host.hidden, false);
    assert.ok(host.children[0].src.includes('id=41'));
    assert.equal(p.element('export-btn').disabled, false, 'a native save does not block another export');
    const second = { jobId: 'job-2', state: 'working', phase: 'history', text: 'Loading next conversation', percent: 15, startedAt: 20, revision: 1 };
    p.incoming.emit({ action: 'exportJobUpdate', job: second });
    p.incoming.emit({ action: 'exportJobUpdate', job: { ...first, state: 'done', phase: 'complete', revision: 2 } });
    p.incoming.emit({ action: 'exportJobUpdate', job: { ...second, state: 'done', phase: 'complete', downloadId: 42, filename: 'Second.md', revision: 2 } });
    const frame = host.children[0];
    assert.ok(frame.src.includes('id=42'));
    p.window.emit('message', { source: frame.contentWindow, origin: p.origin, data: resultMessage(frame, 'gce:close-result') });
    assert.ok(calls.some(msg => msg.action === 'acknowledgeExportJob' && msg.jobId === 'job-2'));
    assert.equal(host.hidden, false);
    assert.ok(host.children[0].src.includes('id=41'), 'the earlier file remains available after dismissing the latest one');
    const reopened = page(target, 'popup.js');
    reopened.chrome.runtime.sendMessage = async () => ({ jobs: [{ ...first, acknowledged: true }, { ...second, acknowledged: true }] });
    await reopened.context.loadExportJobs();
    assert.equal(reopened.element('status-area').classList.contains('visible'), false);
    assert.equal(reopened.element('export-result').hidden, true, 'acknowledged results stay dismissed after reopening');
  });

  test(`${target}: Open is a direct user click on the exact completed export`, async () => {
    const p = page(target, 'export-result.js');
    await settle();
    assert.equal(p.element('heading').textContent, 'Export saved');
    assert.equal(p.element('filename').textContent, 'Fixture_1.md', 'uses the actual browser filename, including rename suffixes');
    assert.equal(p.element('open').disabled, false);
    assert.deepEqual(p.opened, [], 'a successful download never opens itself');
    p.element('open').click();
    assert.deepEqual(p.opened, [42], 'native API is invoked synchronously in the click handler');
    await settle();
    assert.equal(p.element('open').disabled, false);
    assert.equal(p.timers.size, 0, 'the result has no auto-dismiss timer');
  });

  test(`${target}: Open waits for download completion and stays disabled after interruption`, async () => {
    const p = page(target, 'export-result.js', { item: { state: 'in_progress' } });
    await settle();
    assert.equal(p.element('open').disabled, true);
    p.element('open').click();
    assert.deepEqual(p.opened, []);
    p.setItem({ ...p.getItem(), state: 'complete' });
    p.changed.emit({ id: 42, state: { current: 'complete' } });
    await settle();
    assert.equal(p.element('open').disabled, false);
    assert.deepEqual(p.opened, [], 'completion enables Open without launching a file');
    p.setItem({ ...p.getItem(), state: 'interrupted' });
    p.changed.emit({ id: 42, state: { current: 'interrupted' } });
    await settle();
    assert.equal(p.element('open').disabled, true);
    assert.match(p.element('error').textContent, /Download interrupted/);
  });

  test(`${target}: missing, erased, foreign, and invalid downloads cannot be opened`, async () => {
    for (const options of [{ missing: true }, { item: { exists: false } }, { item: { byExtensionId: 'another-extension' } }, { hash: '#id=invalid' }]) {
      const p = page(target, 'export-result.js', options);
      await settle();
      assert.equal(p.element('open').disabled, true);
      assert.equal(p.element('error').hidden, false);
      p.element('open').click();
      assert.deepEqual(p.opened, []);
    }
    const p = page(target, 'export-result.js');
    await settle();
    p.setItem(null);
    p.erased.emit(42);
    await settle();
    assert.equal(p.element('open').disabled, true);
  });

  test(`${target}: opening errors stay visible and × only dismisses the notification`, async () => {
    const p = page(target, 'export-result.js', { hash: '#id=42&warning=Some%20attachments%20failed&auto=1&channel=frame-test' });
    await settle();
    assert.equal(p.element('warning').textContent, 'Some attachments failed');
    assert.equal(p.element('warning').hidden, false);
    assert.equal(p.element('next').hidden, false);
    p.chrome.downloads.open = () => Promise.reject(new Error('File not found'));
    p.element('open').click();
    await settle();
    assert.match(p.element('error').textContent, /Could not open.*browser’s Downloads/);
    assert.equal(p.element('error').hidden, false);
    assert.equal(p.element('open').disabled, false, 'the user can retry');
    p.element('close').click();
    assert.ok(p.posted.some(entry => entry.message.action === 'gce:close-result' && entry.message.downloadId === 42 && entry.message.channel === 'frame-test'));
    p.window.emit('pagehide');
    assert.equal(p.changed.listeners.size, 0);
    assert.equal(p.erased.listeners.size, 0);
  });

  test(`${target}: stale download searches cannot overwrite a newer completed state`, async () => {
    const p = page(target, 'export-result.js');
    await settle();
    const pending = [];
    p.chrome.downloads.search = () => new Promise(resolve => pending.push(resolve));
    p.changed.emit({ id: 42 });
    p.changed.emit({ id: 42 });
    pending[1]([{ ...p.getItem(), state: 'complete' }]);
    await settle();
    pending[0]([{ ...p.getItem(), state: 'in_progress' }]);
    await settle();
    assert.equal(p.element('heading').textContent, 'Export saved');
    assert.equal(p.element('open').disabled, false);
  });

  test(`${target}: result frame close/resize messages require the right source, origin, and download`, () => {
    const p = page(target, 'result-host.js');
    const host = new Element();
    let closes = 0;
    const dispose = p.context.mountExportResult(host, { downloadId: 42, filename: '<Fixture>.md' }, () => closes++);
    const frame = host.children[0];
    assert.ok(frame.src.includes('filename=%3CFixture%3E.md'));
    const data = resultMessage(frame, 'gce:close-result');
    p.window.emit('message', { source: frame.contentWindow, origin: 'https://chat.google.com', data });
    p.window.emit('message', { source: {}, origin: p.origin, data });
    p.window.emit('message', { source: frame.contentWindow, origin: p.origin, data: { ...data, downloadId: 99 } });
    p.window.emit('message', { source: null, origin: p.origin, data: { ...data, channel: 'another-frame' } });
    assert.equal(closes, 0);
    p.window.emit('message', { source: frame.contentWindow, origin: p.origin, data: resultMessage(frame, 'gce:resize-result', { height: 220 }) });
    assert.equal(frame.style.height, '220px');
    p.window.emit('message', { source: null, origin: p.origin, data: resultMessage(frame, 'gce:resize-result', { height: 230 }) });
    assert.equal(frame.style.height, '230px', 'Firefox can omit the source window for extension messages');
    p.window.emit('message', { source: null, origin: p.origin, data });
    assert.equal(closes, 1);
    dispose();
    assert.equal(host.children.length, 0);
    assert.equal(p.window.handlers.get('message').size, 0);
  });

  test(`${target}: popup success persists, ignores duplicate relays, and dismisses with ×`, () => {
    const p = page(target, 'popup.js');
    const done = { action: 'exportStateUpdate', state: 'done', downloadId: 42, filename: 'Fixture.md' };
    p.incoming.emit(done);
    p.incoming.emit(done);
    const host = p.element('export-result');
    assert.equal(host.hidden, false);
    assert.equal(host.children.length, 1);
    assert.equal(p.timers.size, 0);
    const frame = host.children[0];
    p.window.emit('message', { source: frame.contentWindow, origin: p.origin, data: resultMessage(frame, 'gce:close-result') });
    assert.equal(host.hidden, true);
    assert.equal(host.children.length, 0);
    p.incoming.emit({ action: 'exportStateUpdate', state: 'working', text: 'Starting another export' });
    p.element('export-btn').disabled = true;
    p.incoming.emit(done);
    assert.equal(host.hidden, true, 'a delayed duplicate cannot reopen a dismissed result');
    assert.equal(p.element('export-btn').disabled, true, 'an old completion cannot unlock a new export');
    assert.equal(p.element('status-area').classList.contains('visible'), true);
    p.incoming.emit({ action: 'exportStateUpdate', state: 'done', text: 'No new messages' });
    assert.equal(host.hidden, true, 'an empty export never gets an Open control');
  });

  test(`${target}: the chat success card relays its download ID, cancels old timers, and closes cleanly`, async () => {
    const p = page(target, 'result-host.js');
    p.document.documentElement = new Element();
    p.document.querySelector = () => null;
    p.document.querySelectorAll = () => [];
    p.context.fetch = async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', target, 'selectors.json'), 'utf8')) });
    const relayed = [];
    p.chrome.runtime.sendMessage = async message => { relayed.push(message); return {}; };
    p.load('content.js');
    await settle();
    p.context.scheduleHideProgress(4000);
    assert.equal(p.timers.size, 1);
    p.context.showExportResult({ downloadId: 42, filename: 'Fixture.md' }, 'Some history is missing', true);
    const host = p.document.documentElement.children[0];
    const frame = host.children[0];
    assert.equal(p.timers.size, 0, 'an old progress timer cannot dismiss the new result');
    assert.equal(relayed[0].downloadId, 42);
    assert.equal(relayed[0].state, 'done');
    assert.equal(relayed[0].warning, 'Some history is missing');
    assert.ok(frame.src.includes('id=42'));
    assert.ok(frame.src.includes('auto=1'));
    p.window.emit('message', { source: frame.contentWindow, origin: p.origin, data: resultMessage(frame, 'gce:close-result') });
    assert.equal(p.document.documentElement.children.length, 0);
    assert.equal(p.window.handlers.get('message').size, 0);
  });
}
