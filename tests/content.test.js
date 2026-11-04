'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { installThreadFixture } = require('./helpers/thread-fixture');

function loadContent(target = 'chrome', { includeTheme = true } = {}) {
  const event = { addListener(fn) { this.listener = fn; } };
  const selectors = {
    frameName: 'single_full_screen',
    scrollContainers: [],
    fallbackScrollable: 'div',
    absoluteTimestampAttr: '[data-absolute-timestamp]',
    attrs: { absoluteTimestamp: 'data-absolute-timestamp' }
  };
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const window = { name: '', addEventListener() {}, dispatchEvent() {} };
  const chrome = {
    storage: { local: { async get() { return {}; } } },
    runtime: {
      getURL(value) { return value; },
      onMessage: event,
      async sendMessage() { return {}; },
      lastError: null
    }
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const context = vm.createContext({
    AbortController,
    URL,
    TextEncoder,
    crypto: require('node:crypto').webcrypto,
    chrome,
    clearTimeout,
    console,
    document,
    fetch: async () => ({ json: async () => selectors }),
    FileReader: class {},
    getComputedStyle: () => ({ overflowY: 'auto' }),
    Map,
    MutationObserver,
    Promise,
    Set,
    setInterval() {},
    setTimeout,
    window
  });
  const filename = path.join(__dirname, '..', target, 'content.js');
  if (includeTheme) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'theme.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

function installProgressDom(context) {
  const hosts = [];
  class Element {
    constructor() { this.style = {}; this.children = []; this.attributes = {}; this.slots = new Map(); }
    appendChild(element) { this.children.push(element); return element; }
    addEventListener() {}
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelector(selector) {
      if (!this.slots.has(selector)) this.slots.set(selector, new Element());
      return this.slots.get(selector);
    }
    remove() { this.removed = true; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  context.document.createElement = () => new Element();
  context.document.documentElement = { appendChild(element) { hosts.push(element); return element; } };
  return hosts;
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: content ping reports missing helpers to the background`, () => {
    const c = loadContent(target, { includeTheme: false });
    c.mountExportResult = () => {};
    let response;
    c.chrome.runtime.onMessage.listener({ action: 'ping' }, { frameId: 5 }, value => { response = value; });

    assert.equal(response.alive, true);
    assert.equal(response.themeReady, false);
    assert.equal(response.resultHostReady, true);
    assert.equal(response.frameId, 5);
  });
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: export succeeds and displays its result if the theme script is missing`, async () => {
    const c = loadContent(target, { includeTheme: false });
    const hosts = installProgressDom(c);
    c.isInChatFrame = () => true;
    c.getConversationName = () => 'Fixture';
    c.extractMessages = () => [{ sender: 'Alice', text: 'hello', media: [] }];
    c.mountExportResult = () => () => {};
    const packageCalls = [];
    c.chrome.runtime.sendMessage = async message => {
      if (message.action === 'packageAndDownload') {
        packageCalls.push(message);
        return { success: true, filename: 'fixture.md', downloadId: 42 };
      }
      return {};
    };

    assert.equal(await c.runExport({ format: 'md', loadAll: false }), 'done');
    assert.equal(packageCalls.length, 1);
    assert.equal(hosts.length, 2, 'shows progress and then the saved result');
    assert.ok(hosts.every(host => host.getAttribute('data-gce-theme') === 'light'));
  });
}

test('restoreScrollPosition preserves distance from the bottom', () => {
  const context = loadContent();
  const container = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
  context.restoreScrollPosition(container, 25);
  assert.equal(container.scrollTop, 775);
});

test('abortable sleep stops promptly with AbortError', async () => {
  const context = loadContent();
  const controller = new AbortController();
  const pending = context.sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError', message: 'Export cancelled' });
});

test('already-aborted work fails before it starts', () => {
  const context = loadContent();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => context.throwIfAborted(controller.signal), { name: 'AbortError' });
});

test('virtualized history visits overlapping windows, deduplicates, and completes at idle', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  c.extractMessages = () => Array.from({ length: 4 }, (_, i) => {
    const id = Math.floor(container.scrollTop / 100) + i;
    return { _dedupKey: String(id), text: String(id), absoluteTimestamp: id + 1 };
  });
  c.getOldestTimestamp = () => Math.floor(container.scrollTop / 100) + 1;
  const waits = [];
  c.waitForHistoryMutation = async (_el, _height, _oldest, timeout) => { waits.push(timeout); };
  c.sleep = async () => {};
  const result = await c.scrollToLoadAll();
  assert.deepEqual(Array.from(result.messages, m => m.text), Array.from({ length: 12 }, (_, i) => String(i)));
  assert.equal(result.reason, 'idle');
  assert.equal(result.warning, '');
  assert.deepEqual(waits.slice(-3), [600, 1200, 1800], 'final idle checks total 3.6 seconds');
  assert.equal(container.scrollTop, 800);
});

test('cancel during history restores position and disconnects its observer', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let disconnected = false;
  c.MutationObserver = class { observe() {} disconnect() { disconnected = true; } };
  const container = { scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  c.findScrollContainer = () => container;
  c.extractMessages = () => [];
  c.getOldestTimestamp = () => 1;
  const controller = new AbortController();
  const pending = c.scrollToLoadAll(null, 0, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(container.scrollTop, 800);
  assert.ok(disconnected);
});

test('anchor restoration handles prepended content and changed layout', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const container = { scrollTop: 100, scrollHeight: 3000, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll: () => [{ getAttribute: () => 'message-1', getBoundingClientRect: () => ({ top: 170 }) }] };
  c.restoreScrollPosition(container, 0, { id: 'message-1', offset: 30 });
  assert.equal(container.scrollTop, 220, 'uses anchor offset instead of jumping to bottom');
});

test('FileReader conversion is aborted and rejects with AbortError', async () => {
  const c = loadContent();
  let reader;
  c.FileReader = class { constructor() { reader = this; } readAsDataURL() {} abort() { this.aborted = true; } };
  const controller = new AbortController();
  const pending = c.blobToBase64({ headers: { get: () => 'image/png' }, blob: async () => ({}) }, controller.signal);
  for (let i = 0; i < 10 && !reader; i++) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(reader.aborted);
});

test('full export waits for cancelled background workers, blocks duplicates, and restarts', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.getConversationName = () => 'Fixture';
  c.extractMessages = () => [{ text: 'hello', media: Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}`, name: `${i}.png` })) }];
  c.sleep = async (_ms, signal) => c.throwIfAborted(signal);
  c.setTimeout = () => 0; // terminal HUD dismissal is irrelevant to lifecycle
  c.fetch = async () => ({ ok: false });
  const pending = new Map();
  const cancelled = [];
  const packaged = [];
  const progress = [];
  c.showProgress = text => progress.push(text);
  c.chrome.runtime.sendMessage = async msg => {
    if (msg.action === 'downloadMediaBg') return new Promise(resolve => pending.set(msg.requestId, resolve));
    if (msg.action === 'cancelMediaBg') { cancelled.push(msg.requestId); return {}; }
    if (msg.action === 'packageAndDownload') { packaged.push(msg); return { success: true, filename: 'fixture.txt' }; }
  };
  const run = c.runExport({ format: 'html', loadAll: false });
  for (let i = 0; i < 30 && pending.size < 4; i++) await Promise.resolve();
  assert.equal(pending.size, 4);
  vm.runInContext('exportController.abort()', c);
  assert.equal(cancelled.length, 4);
  await c.runExport({ loadAll: false });
  assert.equal(packaged.length, 0, 'restart blocked while workers drain');
  for (const resolve of pending.values()) resolve({ success: false });
  await run;
  assert.equal(packaged.length, 0, 'cancelled export never packages');
  assert.equal(progress.at(-1), 'Export cancelled.');
  assert.equal(vm.runInContext('exportInProgress', c), false);
  await c.runExport({ format: 'txt', loadAll: false });
  assert.equal(packaged.length, 1);
  assert.equal(packaged[0].payload.history.reason, 'visible-only');
});

test('full export propagates history warning into the saved payload', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.showProgress = () => {};
  c.getConversationName = () => 'Fixture';
  c.sleep = async () => {};
  c.scrollToLoadAll = async () => ({ messages: [{ text: 'hello' }], reason: 'limit', warning: 'May be incomplete' });
  let payload;
  c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.txt' }; };
  await c.runExport({});
  assert.equal(payload.history.warning, 'May be incomplete');
  assert.equal(vm.runInContext('exportInProgress', c), false);
});

test('history observer accepts delayed history and ignores unrelated mutations', async () => {
  const c = loadContent();
  let mutation;
  let disconnected = false;
  c.MutationObserver = class { constructor(fn) { mutation = fn; } observe() {} disconnect() { disconnected = true; } };
  c.getOldestTimestamp = () => 10;
  const container = { scrollHeight: 500 };
  let finished = false;
  const pending = c.waitForHistoryMutation(container, 500, 10, 1000).then(() => { finished = true; });
  mutation();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(finished, false);
  container.scrollHeight = 800;
  mutation();
  await pending;
  assert.ok(disconnected);
});

test('loaded viewport proceeds after two frames; boundary still waits for history', async () => {
  const c = loadContent();
  const frames = [];
  c.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  c.cancelAnimationFrame = () => {};
  c.getOldestTimestamp = () => 10;
  const container = { scrollHeight: 1000 };
  const controller = new AbortController();
  const fast = c.waitForHistoryMutation(container, 1000, 10, 10000, controller.signal, true);
  assert.equal(frames.length, 1);
  frames.shift()();
  frames.shift()();
  await fast;
  const slow = c.waitForHistoryMutation(container, 1000, 10, 10000, controller.signal, false);
  assert.equal(frames.length, 0, 'no frame shortcut at history boundary');
  controller.abort();
  await assert.rejects(slow, { name: 'AbortError' });
});

test('extraction cache reuses unchanged groups and reparses edited or recycled content', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let records = [];
  let disconnected = false;
  c.MutationObserver = class {
    observe() {}
    takeRecords() { const batch = records; records = []; return batch; }
    disconnect() { disconnected = true; }
  };
  const cache = c.createExtractionCache({});
  const group = { nodeType: 1, closest() { return this; } };
  let parses = 0;
  let text = 'original';
  const parse = () => { parses++; return [{ text }]; };
  for (let i = 0; i < 100; i++) assert.equal(cache.read(group, 'Today', parse)[0].text, 'original');
  assert.equal(parses, 1, '100 overlapping collections parse once');
  text = 'edited';
  records = [{ target: group }];
  assert.equal(cache.read(group, 'Today', parse)[0].text, 'edited');
  assert.equal(parses, 2);
  cache.read(group, 'Yesterday', parse);
  assert.equal(parses, 3, 'date reassociation invalidates cached extraction');
  records = [{ target: { nodeType: 1, closest: () => null } }];
  cache.read(group, 'Yesterday', parse);
  assert.equal(parses, 3, 'adding another group does not reparse unchanged groups');
  cache.disconnect();
  assert.ok(disconnected);
});

test('checkpoint scope separates conversations, accounts and export modes', () => {
  const c = loadContent();
  const url = 'https://chat.google.com/u/0/app/chat/ABC123';
  const txt = c.checkpointScope(url, 'txt', true);
  assert.ok(txt);
  assert.notEqual(txt, c.checkpointScope(url.replace('ABC123', 'XYZ'), 'txt', true));
  assert.notEqual(txt, c.checkpointScope(url.replace('/u/0/', '/u/1/'), 'txt', true));
  assert.notEqual(txt, c.checkpointScope(url, 'html', false));
  assert.notEqual(c.checkpointScope(url, 'html', true), c.checkpointScope(url, 'html', false));
  assert.ok(c.checkpointScope('https://mail.google.com/mail/u/0/#chat/space/AAA123', 'txt', false));
  assert.ok(c.checkpointScope('https://chat.google.com/u/0/room/AAA123', 'txt', false));
  assert.ok(c.checkpointScope('https://chat.google.com/u/0/dm/AAA123', 'txt', false));
  assert.equal(c.checkpointScope('https://chat.google.com/u/0/', 'txt', false), '');
});

test('web-app checkpoint scope uses the selected conversation link', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/' };
  c.document.querySelectorAll = selector => selector.includes('aria-current') ? [{
    href: 'https://chat.google.com/u/0/room/PWA123',
    getAttribute() { return this.href; }
  }] : [];
  const scope = c.checkpointScopeFromPage('txt', false, 'https://chat.google.com/u/0/');
  assert.equal(scope, 'chat.google.com|0|room|PWA123|txt');
});

test('web-app checkpoint scope inspects the outer application document', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/frame' };
  const selected = {
    href: 'https://chat.google.com/u/0/app/chat/OUTER123',
    getAttribute() { return this.href; }
  };
  const outerDocument = { querySelectorAll: selector => selector.includes('aria-current') ? [selected] : [] };
  const outer = { location: { href: 'https://chat.google.com/u/0/' }, document: outerDocument };
  outer.parent = outer;
  c.window.parent = outer;
  assert.equal(c.checkpointScopeFromPage('html', true, 'https://chat.google.com/u/0/'),
    'chat.google.com|0|chat|OUTER123|html-media');
});

test('web-app title fallback requires exactly one matching conversation link', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/0/' };
  c.getConversationName = () => 'Project Room';
  const link = id => ({
    href: `https://chat.google.com/u/0/room/${id}`,
    textContent: 'Project Room',
    getAttribute(name) { return name === 'aria-label' ? '' : this.href; }
  });
  c.document.querySelectorAll = selector => selector === 'a[href]' ? [link('ONE')] : [];
  assert.equal(c.checkpointScopeFromPage('txt', false), 'chat.google.com|0|room|ONE|txt');
  c.document.querySelectorAll = selector => selector === 'a[href]' ? [link('ONE'), link('TWO')] : [];
  assert.equal(c.checkpointScopeFromPage('txt', false), '', 'ambiguous titles fail closed');
});

test('incremental selection preserves equal-time new messages and unknown timestamps', async () => {
  const c = loadContent();
  const old = { _dedupKey: 'a', absoluteTimestamp: 100, text: 'old' };
  const checkpoint = await c.buildCheckpoint([old]);
  const equalTime = { _dedupKey: 'b', absoluteTimestamp: 100, text: 'new at same time' };
  const unknown = { text: 'unknown' };
  const selected = await c.selectNewMessages([{ absoluteTimestamp: 99 }, old, equalTime, unknown], checkpoint);
  assert.deepEqual(Array.from(selected), [equalTime, unknown]);
  assert.equal(await c.buildCheckpoint([unknown]), null);
  assert.equal(JSON.stringify(checkpoint).includes('old'), false, 'checkpoint stores hashes rather than text');
});

test('content-derived checkpoint scope is stable and separates conversations and modes', async () => {
  const c = loadContent();
  const history = [
    { _dedupKey: 'first', sender: 'A', absoluteTimestamp: 10, text: 'one', media: [] },
    { _dedupKey: 'second', sender: 'B', absoluteTimestamp: 20, text: 'two', media: [] }
  ];
  const scope = await c.contentCheckpointScope(history, 'Room', 'txt', false, 'https://chat.google.com/u/2/');
  assert.equal(scope, await c.contentCheckpointScope(history, 'Room', 'txt', false, 'https://chat.google.com/u/2/'));
  assert.notEqual(scope, await c.contentCheckpointScope([{ ...history[0], text: 'different' }], 'Room', 'txt', false, 'https://chat.google.com/u/2/'));
  assert.notEqual(scope, await c.contentCheckpointScope(history, 'Room', 'html', true, 'https://chat.google.com/u/2/'));
  assert.match(scope, /^chat\.google\.com\|2\|content\|/);
  assert.equal(scope.includes('Room'), false, 'scope hashes the title');
});

test('incremental web-app export falls back to a content-derived checkpoint', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.findScrollContainer = () => null;
  c.getConversationName = () => 'PWA Fixture';
  c.checkpointScopeFromPage = () => '';
  c.sleep = async () => {};
  c.setTimeout = () => 0;
  c.showProgress = () => {};
  const messages = [{ _dedupKey: 'oldest', sender: 'A', absoluteTimestamp: 100, text: 'first', media: [] }];
  const cutoffs = [];
  c.scrollToLoadAll = async (_progress, cutoff) => { cutoffs.push(cutoff); return { messages, reason: 'idle', warning: '' }; };
  const stored = {};
  c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
  let downloads = 0;
  c.chrome.runtime.sendMessage = async msg => {
    downloads++;
    stored[msg.payload.checkpoint.key] = msg.payload.checkpoint.value;
    return { success: true, filename: 'pwa.txt' };
  };
  const options = { format: 'txt', incremental: true, sourceUrl: 'https://chat.google.com/u/0/' };
  await c.runExport(options);
  await c.runExport(options);
  assert.equal(downloads, 1, 'the second identical export finds its content-derived checkpoint');
  assert.deepEqual(cutoffs, [0, 0], 'route-less PWA mode safely scans full history before identifying the conversation');
});

test('incremental export establishes baseline, exports new files, then reports no new messages', async () => {
  const c = loadContent();
  await c.loadSelectors();
  c.isInChatFrame = () => true;
  c.findScrollContainer = () => null;
  c.getConversationName = () => 'Fixture';
  c.sleep = async () => {};
  c.setTimeout = () => 0;
  const progress = [];
  c.showProgress = text => progress.push(text);
  let messages = [{ _dedupKey: 'a', absoluteTimestamp: 100, text: 'first', media: [] }];
  const cutoffs = [];
  c.scrollToLoadAll = async (_progress, cutoff) => { cutoffs.push(cutoff); return { messages, reason: cutoff ? 'date-boundary' : 'idle', warning: '' }; };
  const stored = {};
  c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
  const packages = [];
  c.chrome.runtime.sendMessage = async msg => {
    packages.push(msg.payload);
    if (msg.payload.checkpoint) stored[msg.payload.checkpoint.key] = msg.payload.checkpoint.value;
    return { success: true, filename: 'fixture.zip' };
  };
  c.downloadMedia = async () => ({ success: true, base64: 'eA==', mimeType: 'text/plain' });
  const options = { format: 'html', includeMedia: true, incremental: true, sourceUrl: 'https://chat.google.com/u/0/app/chat/ABC' };
  await c.runExport(options);
  messages = [...messages, { _dedupKey: 'b', absoluteTimestamp: 200, text: 'second', media: [{ url: 'https://example.com/a.txt', name: 'a.txt', type: 'file' }] }];
  await c.runExport(options);
  assert.equal(packages[1].messages.length, 1);
  assert.equal(packages[1].messages[0].text, 'second');
  assert.equal(packages[1].mediaFiles.length, 1);
  await c.runExport(options);
  assert.equal(packages.length, 2, 'nothing new produces no empty archive');
  assert.match(progress.at(-1), /No new messages/);
  assert.deepEqual(cutoffs, [0, 100, 200]);
  // Failed attachments must remain eligible on the next attempt.
  messages = [...messages, { _dedupKey: 'c', absoluteTimestamp: 300, text: 'third', media: [{ url: 'https://example.com/b.txt' }] }];
  c.downloadMedia = async () => ({ success: false });
  await c.runExport(options);
  assert.equal(packages[2].checkpoint, null);
  assert.match(packages[2].history.warning, /attachments failed/);
  assert.equal(Object.values(stored)[0].timestamp, 200);
  await c.runExport({ ...options, format: 'txt' });
  assert.equal(packages[3].messages.length, 3, 'TXT starts its own baseline rather than inheriting the media checkpoint');
  assert.equal(Object.keys(stored).length, 2);
});

test('conversation identity comes from the chat address', () => {
  const c = loadContent();
  c.location = { href: 'https://chat.google.com/u/1/app/space/AAA123' };
  assert.equal(c.currentConversation().key, 'chat.google.com|1|space|AAA123');
});

test('export mode waits for a settled conversation and cancels on switch', async () => {
  const c = loadContent();
  await c.loadSelectors();
  vm.runInContext('exportModeEnabled = true; exportModeLastSync = Date.now();', c);
  let key = 'a';
  const started = [];
  c.isInChatFrame = () => true;
  c.currentConversation = () => ({ key });
  c.startAutoExport = async value => { started.push(value); };
  let rendered = false;
  c.document.querySelector = () => (rendered ? {} : null);

  for (let i = 0; i < 4; i++) c.exportModeTick();
  assert.deepEqual(started, [], 'no export before messages render');
  rendered = true;
  c.exportModeTick();
  c.exportModeTick();
  assert.deepEqual(started, ['a']);

  const controller = new AbortController();
  c.exportController = controller;
  vm.runInContext('exportInProgress = true; autoExportKey = "a";', c);
  vm.runInContext('exportController = this.exportController;', c);
  key = 'b';
  c.exportModeTick();
  assert.equal(controller.signal.aborted, true);
});

test('auto-export marks a channel only after it saved', async () => {
  const c = loadContent();
  await c.loadSelectors();
  const sent = [];
  c.chrome.runtime.sendMessage = async msg => {
    sent.push(msg.action);
    return msg.action === 'autoExportCandidate' ? { run: true, settings: { format: 'html', incremental: true } } : {};
  };
  let options;
  let outcome = 'done';
  c.runExport = async value => { options = value; return outcome; };
  vm.runInContext('exportModeWatch = { key: "a", stableTicks: 2, handled: true };', c);

  await c.startAutoExport('a');
  assert.equal(options.format, 'html');
  assert.equal(options.incremental, true);
  assert.equal(options.auto, true);
  assert.ok(sent.includes('autoExportDone'));

  sent.length = 0;
  outcome = 'cancelled';
  await c.startAutoExport('a');
  assert.ok(!sent.includes('autoExportDone'));
  assert.equal(vm.runInContext('exportModeWatch.handled', c), true, 'manual cancel stays suppressed while on channel');

  // Revisiting the channel clears handled and allows retry
  vm.runInContext('exportModeWatch = { key: "b", stableTicks: 0, handled: false }; exportModeEnabled = true;', c);
  c.currentConversation = () => ({ key: 'a' });
  c.exportModeTick();
  assert.equal(vm.runInContext('exportModeWatch.handled', c), false, 'cancelled channel retries on revisit');

  vm.runInContext('exportModeWatch.handled = true;', c);
  outcome = 'error';
  await c.startAutoExport('a');
  assert.equal(vm.runInContext('exportModeWatch.handled', c), true, 'failures do not retry in a loop');
});

test('export mode tick does not poll background when disabled', async () => {
  const c = loadContent();
  await c.loadSelectors();
  let polled = false;
  c.chrome.runtime.sendMessage = async () => { polled = true; return {}; };
  c.isInChatFrame = () => true;
  vm.runInContext('exportModeEnabled = false; exportModeLastSync = 0;', c);
  c.exportModeTick();
  assert.equal(polled, false, 'must not poll background when export mode is disabled');
});

for (const target of ['chrome', 'firefox']) {
  test(`${target}: incomplete threads report a reason and reply coverage in the packaged export`, async () => {
    for (const [options, reason, expected, captured] of [
      [{ replyLabel: 'Replies' }, 'reply-count-unreadable', null, 3],
      [{ stuckExpansion: true }, 'collapsed-replies-stalled', 3, 1]
    ]) {
      const c = loadContent(target);
      await c.loadSelectors();
      installThreadFixture(c, options);
      let payload;
      c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'Fixture.md' }; };
      assert.equal(await c.runExport({ format: 'md', incremental: true, sourceUrl: 'https://chat.google.com/app/chat/ROOM' }), 'done');
      assert.equal(payload.checkpoint, null);
      const [failure] = payload.history.threadFailures;
      assert.equal(failure.threadId, 'old-parent');
      assert.equal(failure.reason, reason);
      assert.equal(failure.expectedReplies, expected);
      assert.equal(failure.capturedReplies, captured);
    }
  });

  test(`${target}: returning before a throttled timer fires still resets the thread render deadline`, async () => {
    const c = loadContent(target);
    const listeners = new Set();
    c.document.addEventListener = (_type, fn) => listeners.add(fn);
    c.document.removeEventListener = (_type, fn) => listeners.delete(fn);
    const visibility = hidden => { c.document.hidden = hidden; for (const fn of [...listeners]) fn(); };
    let release, rendered = false;
    c.sleep = () => new Promise(resolve => { release = resolve; });
    const waiting = c.waitForThreadCondition(() => rendered, null, 1);
    visibility(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    visibility(false);
    rendered = true;
    release();
    assert.equal(await waiting, true, 'elapsed hidden time must not cause a false thread failure on return');
    assert.equal(listeners.size, 0);
  });

  test(`${target}: a hidden history wait stays pending and cancellation removes every visibility listener`, async () => {
    const c = loadContent(target);
    const listeners = new Set();
    c.document.addEventListener = (_type, fn) => listeners.add(fn);
    c.document.removeEventListener = (_type, fn) => listeners.delete(fn);
    const visibility = hidden => { c.document.hidden = hidden; for (const fn of [...listeners]) fn(); };
    const container = { scrollHeight: 500, querySelectorAll: () => [] };
    let settled = false;
    const wait = c.waitForHistoryMutation(container, 500, 0, 5).then(value => { settled = true; return value; });
    visibility(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'hidden time must not count as an idle history boundary');
    container.scrollHeight = 600;
    visibility(false);
    assert.equal(await wait, true);
    assert.equal(listeners.size, 0);
    const controller = new AbortController();
    visibility(true);
    const cancelled = c.waitForHistoryMutation(container, 600, 0, 5, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(listeners.size, 0);
  });

  test(`${target}: switching tabs during thread loading pauses, resumes all replies, and keeps one job through packaging`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const realThreadWait = c.waitForThreadCondition;
    const f = installThreadFixture(c, { onOpen() { c.document.hidden = true; } });
    const fastWait = c.waitForThreadCondition;
    c.waitForThreadCondition = (...args) => c.document.hidden ? realThreadWait(...args) : fastWait(...args);
    const listeners = new Set();
    c.document.addEventListener = (_type, fn) => listeners.add(fn);
    c.document.removeEventListener = (_type, fn) => listeners.delete(fn);
    const statuses = [];
    c.showProgress = (text, _percent, state) => statuses.push({ text, state });
    let payload, handedOffJob;
    c.chrome.runtime.sendMessage = async msg => {
      if (msg.action === 'packageAndDownload') { payload = msg.payload; handedOffJob = msg.jobId; return { success: true, filename: 'Fixture.md' }; }
      return {};
    };
    const result = c.runExport({ format: 'md' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.active, 'old-parent');
    assert.equal(payload, undefined);
    assert.ok(statuses.some(status => status.state === 'paused'));
    let activeJob;
    c.chrome.runtime.onMessage.listener({ action: 'getExportJob' }, {}, reply => { activeJob = reply.jobId; });
    assert.match(activeJob, /^job-/);
    c.document.hidden = false;
    for (const fn of [...listeners]) fn();
    assert.equal(await result, 'done');
    assert.equal(handedOffJob, activeJob);
    assert.equal(payload.messages.filter(message => message.parentMessageId === 'old-parent').length, 3);
    assert.equal(listeners.size, 0);
    assert.equal(f.state.active, '');
    c.chrome.runtime.onMessage.listener({ action: 'getExportJob' }, {}, reply => assert.equal(reply.jobId, null));
  });

  test(`${target}: a paused thread export can be cancelled from the popup without saving a partial file`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const realThreadWait = c.waitForThreadCondition;
    const f = installThreadFixture(c, { onOpen() { c.document.hidden = true; } });
    const fastWait = c.waitForThreadCondition;
    c.waitForThreadCondition = (...args) => c.document.hidden && args[3] !== false ? realThreadWait(...args) : fastWait(...args);
    const listeners = new Set();
    c.document.addEventListener = (_type, fn) => listeners.add(fn);
    c.document.removeEventListener = (_type, fn) => listeners.delete(fn);
    let packaged = false;
    c.chrome.runtime.sendMessage = async msg => { if (msg.action === 'packageAndDownload') packaged = true; return {}; };
    const result = c.runExport({ format: 'md' });
    await new Promise(resolve => setImmediate(resolve));
    let job;
    const ask = msg => c.chrome.runtime.onMessage.listener(msg, {}, reply => { job = reply; });
    ask({ action: 'getExportJob' });
    const jobId = job.jobId;
    ask({ action: 'cancelExportJob', jobId: 'job-unrelated' });
    assert.equal(job.success, false);
    ask({ action: 'cancelExportJob', jobId });
    assert.equal(job.success, true);
    assert.equal(await result, 'cancelled');
    assert.equal(packaged, false);
    assert.equal(listeners.size, 0);
    assert.equal(f.state.active, '');
  });

  test(`${target}: a hidden Chat tab does not turn a suspended thread render into a timeout`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const listeners = new Set();
    c.document.hidden = true;
    c.document.addEventListener = (type, fn) => { if (type === 'visibilitychange') listeners.add(fn); };
    c.document.removeEventListener = (_type, fn) => listeners.delete(fn);
    c.sleep = () => new Promise(resolve => setTimeout(resolve, 1));
    let rendered = false;
    let settled = false;
    const pending = c.waitForThreadCondition(() => rendered, null, 1).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'inactive-tab time cannot exhaust the render timeout');
    rendered = true;
    c.document.hidden = false;
    for (const listener of [...listeners]) listener();
    assert.equal(await pending, true);
    assert.equal(listeners.size, 0);
  });

  test(`${target}: the date filter includes a recent reply to an older parent with labeled context`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    installThreadFixture(c, { replies: [
      { id: 'old-reply', topic: 'old-parent', time: 20, text: 'Earlier reply', sender: 'Bob' },
      { id: 'dated-reply', topic: 'old-parent', time: Date.parse('2026-11-03T20:00:00Z'), text: 'Recent reply', sender: 'Carol' }
    ] });
    let payload;
    c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.md' }; };
    assert.equal(await c.runExport({ format: 'md', dateFrom: '2026-11-03' }), 'done');
    assert.deepEqual(Array.from(payload.messages, message => message.messageId), ['old-parent', 'dated-reply']);
    assert.equal(payload.messages[0].contextOnly, true);
    assert.equal(payload.history.threadsComplete, true);
  });

  test(`${target}: visible-only exports do not open or expand threads`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const fixture = installThreadFixture(c);
    let payload;
    c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.md' }; };
    assert.equal(await c.runExport({ format: 'md', loadAll: false }), 'done');
    assert.deepEqual(fixture.actions, []);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.history.reason, 'visible-only');
    assert.match(payload.history.warning, /currently rendered/);
    assert.equal(payload.checkpoint, null);
  });

  test(`${target}: hidden conversation containers cannot displace the visible main list`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const { main } = installThreadFixture(c);
    const hidden = { clientHeight: 0, scrollHeight: 800 };
    const query = c.document.querySelectorAll;
    c.document.querySelector = selector => selector === c.threadSelectors.mainMessages ? hidden : null;
    c.document.querySelectorAll = selector => selector === c.threadSelectors.mainMessages ? [hidden, main] : query(selector);
    assert.equal(c.findScrollContainer(), main);
  });

  test(`${target}: deleted replies retain ordering hints without inventing a timestamp`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    installThreadFixture(c);
    const history = await c.scrollToLoadAll();
    const deleted = history.messages.find(message => message.messageId === 'deleted-reply');
    assert.equal(deleted.absoluteTimestamp, 0);
    assert.equal(deleted.previousMessageId, 'old-reply');
    assert.equal(deleted.nextMessageId, 'new-reply');
  });

  test(`${target}: an unreadable reply count cannot be reported as a verified complete thread`, async () => {
    for (const label of ['Replies', '1.234 replies', '1 234 replies', '3 réponses']) {
      const c = loadContent(target);
      await c.loadSelectors();
      installThreadFixture(c, { replyLabel: label });
      const history = await c.scrollToLoadAll();
      assert.equal(history.messages.length, 5, 'available content is still captured');
      assert.equal(history.threadsComplete, false, label);
      assert.match(history.warning, /checkpoint will not advance/);
    }
  });

  test(`${target}: an incomplete scan cannot claim there are no new messages`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const options = {};
    const fixture = installThreadFixture(c, options);
    const stored = {};
    c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
    let files = 0;
    c.chrome.runtime.sendMessage = async msg => {
      files++;
      stored[msg.payload.checkpoint.key] = msg.payload.checkpoint.value;
      return { success: true, filename: 'fixture.md' };
    };
    const request = { format: 'md', incremental: true, sourceUrl: 'https://chat.google.com/app/chat/ROOM' };
    assert.equal(await c.runExport(request), 'done');
    options.stuckExpansion = true;
    fixture.state.expanded = false;
    const progress = [];
    c.showProgress = (text, _percent, state) => progress.push({ text, state });
    assert.equal(await c.runExport(request), 'error');
    assert.equal(files, 1, 'no additional file or checkpoint is saved');
    assert.equal(progress.at(-1).state, 'error');
    assert.doesNotMatch(progress.at(-1).text, /No new messages/);
  });

  test(`${target}: changing conversations behind a fixed PWA address prevents packaging`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    c.location = { href: 'https://chat.google.com/u/0/' };
    let scope = 'chat.google.com|0|chat|first|md';
    c.checkpointScopeFromPage = () => scope;
    const fixture = installThreadFixture(c, { onOpen: () => { scope = 'chat.google.com|0|chat|second|md'; } });
    const errors = [];
    c.console = { ...console, error: (...args) => errors.push(args) };
    let files = 0;
    c.chrome.runtime.sendMessage = async () => { files++; return { success: true, filename: 'fixture.md' }; };
    const progress = [];
    c.showProgress = text => progress.push(text);
    assert.equal(await c.runExport({ format: 'md' }), 'error');
    assert.equal(files, 0);
    assert.match(progress.at(-1), /Conversation changed/);
    assert.equal(errors[0][1].name, 'ConversationChangedError');
    assert.deepEqual(fixture.actions, ['open-thread'], 'cleanup cannot close or move a thread in the newly selected conversation');
  });

  test(`${target}: history scans older parents, expands replies, and retains deleted placeholders`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const fixture = installThreadFixture(c, { virtualized: true });
    const history = await c.scrollToLoadAll(null, 100);
    assert.equal(history.reason, 'idle', 'the main cutoff cannot skip an old parent with a new reply');
    assert.equal(history.threadsComplete, true);
    assert.equal(history.threadsScanned, 1);
    assert.equal(history.messages.length, 5, 'two main messages plus three replies, without a duplicate parent');
    const reply = history.messages.find(msg => msg.messageId === 'new-reply');
    assert.equal(reply.parentMessageId, 'old-parent');
    assert.equal(reply.threadId, 'old-parent');
    const deleted = history.messages.find(msg => msg.messageId === 'deleted-reply');
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.absoluteTimestamp, 0, 'a deleted reply does not get an invented timestamp');
    assert.equal(deleted.parentMessageId, 'old-parent');
    assert.deepEqual(fixture.actions, ['open-thread', 'expand-replies', 'close-thread']);
    assert.equal(fixture.main.scrollTop, 400);
  });

  test(`${target}: cancellation closes the thread opened by the exporter and restores the main viewport`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const controller = new AbortController();
    const fixture = installThreadFixture(c, { onOpen: () => controller.abort() });
    await assert.rejects(c.scrollToLoadAll(null, 0, controller.signal), { name: 'AbortError' });
    assert.deepEqual(fixture.actions, ['open-thread', 'close-thread']);
    assert.equal(fixture.main.scrollTop, 400);
  });

  test(`${target}: an already-open thread is restored after scanning`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const fixture = installThreadFixture(c, { previousThread: true });
    fixture.panel.scrollTop = 75;
    await c.scrollToLoadAll();
    assert.equal(fixture.state.active, 'old-parent');
    assert.equal(fixture.panel.scrollTop, 75);
    assert.ok(!fixture.actions.includes('close-thread'));
  });

  test(`${target}: an incomplete thread warns and prevents a checkpoint`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    installThreadFixture(c, { stuckExpansion: true });
    let payload;
    c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.md' }; };
    assert.equal(await c.runExport({ format: 'md', incremental: true, sourceUrl: 'https://chat.google.com/app/chat/ROOM' }), 'done');
    assert.equal(payload.history.threadsComplete, false);
    assert.match(payload.history.warning, /thread.*could not be completely loaded/i);
    assert.equal(payload.checkpoint, null);
  });

  test(`${target}: incremental thread exports include parent context and do not repeat known deleted replies`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    const fixture = installThreadFixture(c, { virtualized: true });
    const stored = {};
    c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
    const packages = [];
    c.chrome.runtime.sendMessage = async msg => {
      packages.push(msg.payload);
      stored[msg.payload.checkpoint.key] = msg.payload.checkpoint.value;
      return { success: true, filename: 'fixture.md' };
    };
    const options = { format: 'md', incremental: true, sourceUrl: 'https://chat.google.com/app/chat/ROOM' };
    assert.equal(await c.runExport(options), 'done');
    assert.equal(packages[0].messages.length, 5);
    assert.equal(packages[0].checkpoint.value.undatedFingerprints.length, 1);
    assert.equal(await c.runExport(options), 'empty', 'a known deletion placeholder does not force another file');
    fixture.addReply({ id: 'later', topic: 'old-parent', time: 400, text: 'A later answer', sender: 'Eve' });
    assert.equal(await c.runExport(options), 'done');
    const withContext = packages[1].messages;
    assert.equal(withContext.length, 2);
    assert.equal(withContext[0].messageId, 'old-parent');
    assert.equal(withContext[0].contextOnly, true);
    assert.equal(withContext[1].messageId, 'later');
    const checkpoint = packages[1].checkpoint.value;
    assert.equal(checkpoint.timestamp, 400);
    assert.equal(checkpoint.undatedFingerprints.length, 1, 'known untimestamped messages survive subsequent checkpoints');
    assert.equal(await c.runExport(options), 'empty');
    assert.equal(packages.length, 2);
  });

  test(`${target}: thread-aware exports establish a new baseline instead of trusting timeline-only checkpoints`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    installThreadFixture(c);
    const scope = c.checkpointScope('https://chat.google.com/app/chat/ROOM', 'md', true);
    const legacyKey = `gceCheckpoint:${await c.hashCheckpointValue(scope)}`;
    c.chrome.storage.local.get = async key => ({ [key]: key === legacyKey ? { timestamp: 1000, fingerprints: [] } : undefined });
    let payload;
    c.chrome.runtime.sendMessage = async msg => { payload = msg.payload; return { success: true, filename: 'fixture.md' }; };
    await c.runExport({ format: 'md', incremental: true, sourceUrl: 'https://chat.google.com/app/chat/ROOM' });
    assert.equal(payload.messages.length, 5);
    assert.notEqual(payload.checkpoint.key, legacyKey);
  });

  test(`${target}: MCAS conversation identities are accepted without accepting lookalike hosts`, () => {
    const c = loadContent(target);
    assert.equal(c.checkpointScope('https://chat.google.com.mcas.ms/app/chat/ROOM', 'md', false), 'chat.google.com.mcas.ms|0|chat|ROOM|md');
    assert.ok(c.checkpointScope('https://mail.google.com.mcas.ms/mail/u/1/#chat/space/ROOM', 'txt', false));
    assert.equal(c.checkpointScope('https://chat.google.com.mcas.ms.example.org/app/chat/ROOM', 'md', false), '');
    assert.equal(c.checkpointScope('http://chat.google.com.mcas.ms/app/chat/ROOM', 'md', false), '');
  });

  test(`${target}: Markdown checkpoints stay separate from TXT and both HTML modes`, async () => {
    const c = loadContent(target);
    const url = 'https://chat.google.com/u/0/app/chat/ABC';
    const markdown = c.checkpointScope(url, 'md', true);
    assert.ok(markdown.endsWith('|md'));
    assert.equal(markdown, c.checkpointScope(url, 'md', false), 'the HTML media toggle does not change Markdown checkpoints');
    for (const [format, media] of [['txt', false], ['html', false], ['html', true]]) {
      assert.notEqual(markdown, c.checkpointScope(url, format, media));
    }
    const messages = [{ sender: 'A', absoluteTimestamp: 100, text: 'anchor' }];
    const fallback = await c.contentCheckpointScope(messages, 'Room', 'md', true, url);
    assert.equal(fallback, await c.contentCheckpointScope(messages, 'Room', 'md', false, url));
    for (const [format, media] of [['txt', false], ['html', false], ['html', true]]) {
      assert.notEqual(fallback, await c.contentCheckpointScope(messages, 'Room', format, media, url));
    }
  });

  test(`${target}: Markdown exports only new messages and keeps attachments as links`, async () => {
    const c = loadContent(target);
    await c.loadSelectors();
    c.isInChatFrame = () => true;
    c.findScrollContainer = () => null;
    c.getConversationName = () => 'Fixture';
    c.sleep = async () => {};
    c.setTimeout = () => 0;
    c.showProgress = () => {};
    c.downloadMedia = async () => { assert.fail('Markdown should not fetch attachments'); };
    let messages = [{ _dedupKey: 'a', absoluteTimestamp: 100, text: 'first', media: [] }];
    c.scrollToLoadAll = async () => ({ messages, reason: 'idle', warning: '' });
    const stored = {};
    c.chrome.storage.local.get = async key => ({ [key]: stored[key] });
    const packages = [];
    c.chrome.runtime.sendMessage = async msg => {
      packages.push(msg);
      if (msg.payload.checkpoint) stored[msg.payload.checkpoint.key] = msg.payload.checkpoint.value;
      return { success: true, filename: 'fixture.md' };
    };
    const options = { format: 'md', includeMedia: true, incremental: true, sourceUrl: 'https://chat.google.com/u/0/app/chat/ABC' };
    assert.equal(await c.runExport(options), 'done');
    messages = [...messages, {
      _dedupKey: 'b', absoluteTimestamp: 200, text: 'second',
      media: [{ type: 'file', name: 'report.pdf', url: 'https://example.com/report.pdf' }]
    }];
    assert.equal(await c.runExport(options), 'done');
    assert.equal(packages[1].format, 'md');
    assert.equal(packages[1].payload.messages.length, 1);
    assert.equal(packages[1].payload.messages[0].text, 'second');
    assert.equal(packages[1].payload.messages[0].media[0].url, 'https://example.com/report.pdf');
    assert.equal(packages[1].payload.mediaFiles.length, 0);
    assert.ok(packages[1].payload.checkpoint);
    assert.equal(packages[1].payload.history.since, 100);
    assert.equal(await c.runExport(options), 'empty');
    assert.equal(packages.length, 2, 'no new messages creates no empty Markdown file');
    assert.equal(await c.runExport({ ...options, format: 'txt' }), 'done');
    assert.equal(packages[2].payload.messages.length, 2, 'TXT keeps its own baseline');
  });

  test(`${target}: auto-export preserves the saved Markdown format`, async () => {
    const c = loadContent(target);
    vm.runInContext("exportModeWatch = { key: 'room', stableTicks: 2, handled: true }", c);
    const calls = [];
    const sent = [];
    c.chrome.runtime.sendMessage = async msg => {
      sent.push(msg);
      return msg.action === 'autoExportCandidate' ? { run: true, settings: { format: 'md', incremental: true } } : {};
    };
    c.runExport = async options => { calls.push(options); return 'done'; };
    await c.startAutoExport('room');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].format, 'md');
    assert.equal(calls[0].incremental, true);
    assert.ok(sent.some(msg => msg.action === 'autoExportDone' && msg.key === 'room'));
  });
}

