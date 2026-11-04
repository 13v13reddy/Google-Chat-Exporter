'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { installFrames } = require('./helpers/frame-fixture');

function loadBackground(target = 'chrome', withZip = false, initialStorage = {}) {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
    listener(...args) { for (const fn of this.listeners) fn(...args); } });
  const stored = structuredClone(initialStorage);
  const session = {};
  const chrome = {
    action: {
      badge: '',
      async setBadgeText({ text }) { this.badge = text; },
      async setBadgeBackgroundColor() {}
    },
    runtime: { onInstalled: event(), onMessage: { addListener(fn) { this.listener = fn; } }, async sendMessage() {}, lastError: null },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event() },
    tabs: { async query() { return []; }, async get(id) { return { id }; },
      async sendMessage() {}, onRemoved: event(), onUpdated: event() },
    scripting: { async executeScript() {} },
    storage: { local: {
      async get(key) { return key ? { [key]: stored[key] } : { ...stored }; },
      async set(values) { Object.assign(stored, values); },
      async remove(key) { delete stored[key]; }
    }, session: {
      async get(key) { return { [key]: session[key] }; },
      async set(values) { Object.assign(session, values); }
    } },
    downloads: { download(_options, callback) { callback(1); },
      async search() { return [{ state: 'complete' }]; },
      onChanged: event()
    }
  };
  const context = vm.createContext({
    chrome,
    crypto: require('node:crypto').webcrypto,
    AbortController,
    Blob,
    console,
    URL,
    Uint8Array,
    TextEncoder,
    atob: typeof atob !== 'undefined' ? atob : (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa,
    clearTimeout,
    encodeURIComponent,
    importScripts() {},
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    setTimeout,
    unescape
  });
  if (withZip) {
    vm.runInContext('self = globalThis', context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'lib', 'jszip.min.js'), 'utf8'), context);
  }
  const filename = path.join(__dirname, '..', target, 'background.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'export-jobs.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: conversation detection returns the Chat iframe’s name without starting an export`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, mail: true }, { id: 3, chat: true }]);
    const response = await new Promise(resolve => c.chrome.runtime.onMessage.listener({ action: 'getConversation', tabId: 7 }, {}, resolve));
    assert.equal(response.success, true);
    assert.equal(response.protocol, 1);
    assert.equal(response.name, 'Fixture room');
    assert.equal(fixture.starts.length, 0);
  });

  test(`${target}: toolbar export starts only in the Chat iframe and repairs only its missing helper`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, mail: true }, { id: 3, chat: true, theme: false }]);
    await c.triggerExport({ id: 7, url: 'https://mail.google.com/mail/u/0/' }, 'md');
    assert.deepEqual(fixture.starts.map(start => start.frameId), [3]);
    assert.deepEqual(fixture.injections, [{ frameIds: [3], files: ['theme.js'] }]);
    assert.equal(fixture.messages.find(message => message.action === 'startExport').options.frameId, 3);
  });

  test(`${target}: startup replies identify the worker protocol and the exact accepted job`, async () => {
    const c = loadBackground(target);
    installFrames(c, target, [{ id: 0, chat: true }]);
    const response = await new Promise(resolve => c.chrome.runtime.onMessage.listener({ action: 'popupExport', tabId: 7, format: 'md', jobId: 'job-protocol' }, {}, resolve));
    assert.equal(response.success, true);
    assert.equal(response.protocol, 1);
    assert.equal(response.jobId, 'job-protocol');
  });

  test(`${target}: cold-frame startup is shared so simultaneous requests cannot redeclare scripts`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, chat: true, loaded: false }]);
    const results = await Promise.all([c.ensureContentScript(7), c.ensureContentScript(7)]);
    assert.ok(results.every(frame => frame.frameId === 0));
    assert.equal(fixture.injections.filter(injection => injection.files.includes('content.js')).length, 1);
  });

  test(`${target}: a rejected export is reported as a failure instead of a successful start`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, chat: true }]);
    fixture.rejectStart = true;
    await assert.rejects(c.triggerExport({ id: 7, url: 'https://chat.google.com/app/chat/ROOM' }, 'md'), /already running/i);
    assert.equal(fixture.starts.length, 0);
  });

  test(`${target}: an unavailable message channel uses the same isolated-frame start handler`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, mail: true }, { id: 2, chat: true }]);
    fixture.failMessages = true;
    await c.triggerExport({ id: 7, url: 'https://mail.google.com/mail/u/0/' }, 'txt');
    assert.deepEqual(fixture.starts.map(start => start.frameId), [2]);
  });

  test(`${target}: stale content code produces a refresh error without reinjecting over its declarations`, async () => {
    const c = loadBackground(target);
    const fixture = installFrames(c, target, [{ id: 0, chat: true, legacy: true }]);
    await assert.rejects(c.ensureContentScript(7), /refresh.*Chat/i);
    assert.equal(fixture.injections.length, 0);
  });
}

test('safeResourceUrl permits HTTPS and safe packaged media paths', () => {
  const context = loadBackground();
  assert.equal(context.safeResourceUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(context.safeResourceUrl('media/4_photo.png'), 'media/4_photo.png');
});

test('safeResourceUrl rejects active, insecure, and traversing URLs', () => {
  const context = loadBackground();
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'http://example.com/file.png',
    'media/../index.html',
    '../media/file.png'
  ]) {
    assert.equal(context.safeResourceUrl(value), '', value);
  }
});

test('rendered media never emits a rejected URL', () => {
  const context = loadBackground();
  const html = context.renderMediaHtml({
    type: 'image',
    url: 'javascript:alert(1)',
    name: '<unsafe>.png'
  });
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /&lt;unsafe&gt;\.png/);
  assert.match(html, /\[unavailable\]/);
});

test('external media links isolate the opened page', () => {
  const context = loadBackground();
  const html = context.renderMediaHtml({
    type: 'image',
    url: 'https://example.com/photo.png',
    name: 'photo.png'
  });
  assert.match(html, /rel="noopener noreferrer"/);
});

test('background cancellation aborts the matching request and prevents retries', async () => {
  const c = loadBackground();
  let signal;
  let calls = 0;
  c.fetch = (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  const sender = { tab: { id: 10 }, frameId: 2 };
  const listener = c.chrome.runtime.onMessage.listener;
  const response = new Promise(resolve => listener({ action: 'downloadMediaBg', requestId: 'one', url: 'https://example.com/a' }, sender, resolve));
  listener({ action: 'cancelMediaBg', requestId: 'one' }, { tab: { id: 11 }, frameId: 2 }, () => {});
  assert.equal(signal.aborted, false, 'another tab cannot cancel this request');
  listener({ action: 'cancelMediaBg', requestId: 'one' }, sender, () => {});
  assert.equal((await response).success, false);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(vm.runInContext('mediaRequests.size', c), 0);
});

test('saved TXT and HTML carry incomplete-history warnings', async () => {
  const c = loadBackground();
  let download;
  c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
  const payload = { conversationName: 'Fixture', messages: [], exportDate: new Date().toISOString(), history: { reason: 'limit', warning: 'May be incomplete' } };
  await c.packageTxt(payload);
  assert.match(Buffer.from(download.url.split(',')[1], 'base64').toString(), /May be incomplete/);
  assert.match(c.generateHtml(payload), /May be incomplete/);
});

test('checkpoint advances only after completed download and survives pending state', async () => {
  const c = loadBackground();
  let state = 'in_progress';
  c.chrome.downloads.search = async () => [{ state }];
  const key = 'gceCheckpoint:' + 'a'.repeat(64);
  const checkpoint = { key, value: { timestamp: 100, fingerprints: ['b'.repeat(64)] } };
  await c.queueCheckpoint(123, checkpoint);
  assert.equal((await c.chrome.storage.local.get(key))[key], undefined);
  assert.ok((await c.chrome.storage.local.get('gcePending:123'))['gcePending:123']);
  state = 'complete';
  c.chrome.downloads.onChanged.listener({ id: 123, state: { current: state } });
  await vm.runInContext('checkpointQueue', c);
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  assert.equal((await c.chrome.storage.local.get('gcePending:123'))['gcePending:123'], undefined);
  state = 'interrupted';
  await c.queueCheckpoint(124, { key, value: { timestamp: 200, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  state = 'complete';
  await c.queueCheckpoint(125, { key, value: { timestamp: 50, fingerprints: [] } });
  assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100, 'late older download cannot rewind checkpoint');
});

test('export mode exports each channel once, then expires when idle', async () => {
  const c = loadBackground();
  const sent = [];
  c.chrome.tabs.query = async () => [{ id: 7 }];
  c.chrome.tabs.sendMessage = async (tabId, msg) => { sent.push([tabId, msg]); };
  const ask = msg => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, {}, resolve));

  assert.equal((await ask({ action: 'setExportMode', enabled: true })).enabled, true);
  assert.equal(c.chrome.action.badge, 'AUTO');
  assert.equal(JSON.stringify(sent), JSON.stringify([[7, { action: 'exportModeChanged', enabled: true }]]));

  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, true);
  await ask({ action: 'autoExportDone', key: 'space-a' });
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, false, 'full export runs once');
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-b' })).run, true);

  await c.chrome.storage.local.set({ gceSettings: { incremental: true } });
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-a' })).run, true, 'incremental repeats are cheap');

  const state = (await c.chrome.storage.session.get('gceExportMode')).gceExportMode;
  await c.chrome.storage.session.set({ gceExportMode: { ...state, lastActivity: Date.now() - 11 * 60 * 1000 } });
  assert.equal((await ask({ action: 'getExportMode' })).enabled, false);
  assert.equal(c.chrome.action.badge, '');
  assert.equal((await ask({ action: 'autoExportCandidate', key: 'space-c' })).run, false);
});

test('triggerDownload converts data URLs to blob URLs in Firefox', async () => {
  const c = loadBackground();
  c.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0' };
  let passedUrl = '';
  c.chrome.downloads.download = (options, cb) => {
    passedUrl = options.url;
    cb(42);
  };
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + c.btoa('hello world');
  const dlId = await c.triggerDownload(dataUrl, 'test.txt');
  assert.equal(dlId, 42);
  assert.ok(passedUrl.startsWith('blob:'), 'Firefox must receive a blob URL instead of data URL');
});

for (const target of ['chrome', 'firefox']) {
  test(`${target}: all formats identify incomplete threads and preserve reply counts safely`, async () => {
    const c = loadBackground(target);
    const payload = { conversationName: 'Fixture', messages: [], exportDate: '2026-11-04T00:00:00Z', history: {
      warning: 'Incomplete threads', threadFailures: [
        { threadId: '<unsafe>', reason: 'reply-count-mismatch', expectedReplies: 10, capturedReplies: 8 },
        { threadId: 'unknown-count', reason: 'reply-count-unreadable', expectedReplies: null, capturedReplies: 3 }
      ] } };
    const markdown = c.generateMarkdown(payload);
    const html = c.generateHtml(payload);
    for (const text of [markdown, html]) {
      assert.match(text, /Thread loading issues/);
      assert.match(text, /Replies captured: 8; expected: 10/);
      assert.match(text, /Replies captured: 3; expected: unknown/);
      assert.match(text, /&lt;unsafe&gt;/);
      assert.doesNotMatch(text, /<unsafe>/);
    }
    let download;
    c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
    await c.packageTxt(payload);
    const text = Buffer.from(download.url.split(',')[1], 'base64').toString();
    assert.match(text, /Thread <unsafe>/);
    assert.match(text, /Replies captured: 8; expected: 10/);
  });

  test(`${target}: export progress can be recovered after the toolbar popup closes`, async () => {
    const c = loadBackground(target);
    const sender = { tab: { id: 7, url: 'https://chat.google.com/app/chat/ROOM' }, frameId: 0 };
    c.chrome.runtime.onMessage.listener({ action: 'exportStateUpdate', jobId: 'job-1', state: 'working',
      text: 'Downloading media 2/4...', percent: 60 }, sender, () => {});
    await new Promise(resolve => setImmediate(resolve));
    const saved = (await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs;
    assert.ok(saved?.['job-1'], 'background state survives losing the popup message listener');
    assert.equal(saved['job-1'].state, 'working');
    assert.equal(saved['job-1'].tabId, 7);
    assert.equal(saved['job-1'].text, 'Downloading media 2/4...');
  });

  test(`${target}: persisted jobs resume status in a new worker and target their original tab and frame`, async () => {
    let c = loadBackground(target);
    const sender = { tab: { id: 7 }, frameId: 2 };
    const ask = (msg, source = {}) => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, source, resolve));
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'paused', phase: 'history',
      text: 'Waiting for Chat', percent: 15, conversationName: 'Fixture space' }, sender);
    const persisted = await c.chrome.storage.local.get('gceExportJobs');
    c = loadBackground(target, false, persisted);
    const calls = [];
    c.chrome.tabs.sendMessage = async (id, msg, options) => {
      calls.push({ id, msg, options });
      return msg.action === 'getExportJob' ? { jobId: 'job-1', state: 'paused', phase: 'history' } : { success: true };
    };
    c.chrome.tabs.update = async (id, update) => { calls.push({ id, update }); return { windowId: 3 }; };
    c.chrome.windows = { async update(id, update) { calls.push({ windowId: id, update }); } };
    const recovered = (await ask({ action: 'getExportJobs' })).jobs[0];
    assert.equal(recovered.state, 'paused');
    assert.equal(recovered.conversationName, 'Fixture space');
    assert.equal(c.chrome.action.badge, 'WAIT');
    assert.equal((await ask({ action: 'focusExportJob', jobId: 'job-1' })).success, true);
    assert.ok(calls.some(call => call.id === 7 && call.update?.active === true));
    assert.ok(calls.some(call => call.windowId === 3 && call.update?.focused === true));
    assert.equal((await ask({ action: 'cancelExportJob', jobId: 'job-1' })).success, true);
    const cancel = calls.find(call => call.msg?.action === 'cancelExportJob');
    assert.equal(cancel.id, 7);
    assert.equal(cancel.options.frameId, 2, 'Gmail iframe jobs cannot be cancelled in another frame');
    await ask({ action: 'setExportMode', enabled: true });
    assert.equal(c.chrome.action.badge, 'WAIT', 'AUTO cannot hide a paused export');
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'working', phase: 'media', text: 'Downloading media', percent: 50 }, sender);
    assert.equal(c.chrome.action.badge, 'RUN');
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'error', text: 'Forged', phase: 'failed' }, { tab: { id: 8 }, frameId: 2 });
    assert.equal((await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs['job-1'].state, 'working');
  });

  test(`${target}: closing or reloading the source reports interruption without treating tab activation as failure`, async () => {
    const c = loadBackground(target);
    const sender = { tab: { id: 7 }, frameId: 0 };
    const ask = (msg, source = {}) => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, source, resolve));
    const update = { action: 'exportStateUpdate', jobId: 'job-1', state: 'working', phase: 'history', text: 'Loading', percent: 15 };
    await ask(update, sender);
    c.chrome.tabs.onUpdated.listener(7, { status: 'complete', active: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs['job-1'].state, 'working');
    c.chrome.tabs.onUpdated.listener(7, { status: 'loading' });
    await new Promise(resolve => setImmediate(resolve));
    let job = (await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs['job-1'];
    assert.equal(job.phase, 'interrupted');
    assert.match(job.text, /closed, reloaded, or discarded/);
    assert.equal(c.chrome.action.badge, 'ERR');
    await ask(update, sender);
    assert.equal((await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs['job-1'].phase, 'interrupted', 'late renderer messages cannot resurrect a stopped job');
    await ask({ action: 'acknowledgeExportJob', jobId: 'job-1' });
    assert.equal(c.chrome.action.badge, '');
    job = (await ask({ action: 'getExportJobs' })).jobs[0];
    assert.equal(job.acknowledged, true);
    await ask({ ...update, jobId: 'job-2' }, sender);
    c.chrome.tabs.onRemoved.listener(7);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await c.chrome.storage.local.get('gceExportJobs')).gceExportJobs['job-2'].phase, 'interrupted');
  });

  test(`${target}: packaging and native downloads continue after Chat closes, and success waits for the file`, async () => {
    const c = loadBackground(target);
    const sender = { tab: { id: 7 }, frameId: 0 };
    const ask = (msg, source = {}) => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, source, resolve));
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'working', phase: 'media', text: 'Collected messages', percent: 85 }, sender);
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; });
    const packaged = new Promise(resolve => { finish = resolve; });
    c.packageMarkdown = async () => { enter(); return packaged; };
    let state = 'in_progress';
    c.chrome.downloads.search = async () => [{ state }];
    const response = ask({ action: 'packageAndDownload', jobId: 'job-1', format: 'md', payload: { history: { warning: 'Fixture warning' } } }, sender);
    await entered;
    c.chrome.tabs.onRemoved.listener(7);
    c.chrome.tabs.get = async () => { throw new Error('No tab'); };
    assert.equal((await ask({ action: 'getExportJobs' })).jobs[0].phase, 'packaging');
    finish({ downloadId: 42, filename: 'Fixture.md' });
    assert.equal((await response).success, true);
    let job = (await ask({ action: 'getExportJobs' })).jobs[0];
    assert.equal(job.phase, 'download');
    assert.equal(job.state, 'working', 'initiating a save is not completed success');
    assert.equal(job.warning, 'Fixture warning');
    assert.equal(c.chrome.action.badge, 'SAVE');
    assert.equal((await ask({ action: 'cancelExportJob', jobId: 'job-1' })).success, false);
    state = 'complete';
    c.chrome.downloads.onChanged.listener({ id: 42, state: { current: state } });
    job = (await ask({ action: 'getExportJobs' })).jobs[0];
    assert.equal(job.state, 'done');
    assert.equal(job.phase, 'complete');
    assert.equal(c.chrome.action.badge, 'DONE');
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'working', phase: 'media', text: 'Stale renderer' }, sender);
    assert.equal((await ask({ action: 'getExportJobs' })).jobs[0].state, 'done');
  });

  test(`${target}: packaging survives idle periods and releases worker activity after success or failure`, async () => {
    const c = loadBackground(target);
    const intervals = new Map();
    let now = 0, lastActivity = 0, nextId = 0;
    c.setInterval = (fn, period) => { const id = ++nextId; intervals.set(id, { fn, period, next: now + period }); return id; };
    c.clearInterval = id => intervals.delete(id);
    const get = c.chrome.storage.local.get;
    c.chrome.storage.local.get = async key => { lastActivity = now; return get(key); };
    const advance = async targetTime => {
      while (true) {
        const timer = [...intervals.values()].sort((a, b) => a.next - b.next)[0];
        if (!timer || timer.next > targetTime) break;
        now = timer.next;
        assert.ok(now - lastActivity < 30000, 'the worker must receive extension API activity before its idle deadline');
        timer.next += timer.period;
        timer.fn();
        await Promise.resolve();
      }
      now = targetTime;
      assert.ok(now - lastActivity < 30000, 'packaging must remain alive while its archive is still being generated');
    };
    const ask = msg => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, {}, resolve));
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    c.packageMarkdown = async () => { entered(); return pending; };
    const saving = ask({ action: 'packageAndDownload', format: 'md', payload: {} });
    await started;
    await advance(65000);
    finish({ downloadId: 42, filename: 'Fixture.md' });
    assert.equal((await saving).success, true);
    assert.equal(intervals.size, 0, 'completed exports must allow the worker to become idle');
    c.console = { ...console, error() {} };
    c.packageMarkdown = async () => { throw new Error('Fixture packaging failure'); };
    assert.equal((await ask({ action: 'packageAndDownload', format: 'md', payload: {} })).success, false);
    assert.equal(intervals.size, 0, 'failed exports must release their heartbeat too');
  });

  test(`${target}: a new worker recovers completed downloads and reports lost extraction or packaging`, async () => {
    const jobs = Object.fromEntries(['history', 'packaging', 'download'].map((phase, index) => {
      const jobId = `job-${index}`;
      return [jobId, { jobId, tabId: 7, frameId: 0, state: 'working', phase, text: 'Working',
        startedAt: index, updatedAt: index, revision: 1, ...(phase === 'download' ? { downloadId: 42, filename: 'Fixture.md' } : {}) }];
    }));
    const c = loadBackground(target, false, { gceExportJobs: jobs });
    const response = await new Promise(resolve => c.chrome.runtime.onMessage.listener({ action: 'getExportJobs' }, {}, resolve));
    assert.equal(response.jobs.find(job => job.phase === 'complete').downloadId, 42);
    assert.equal(response.jobs.filter(job => job.phase === 'interrupted').length, 2);
    assert.ok(response.jobs.every(job => job.state !== 'working'));
  });

  test(`${target}: interrupted saves remain failed without advancing the checkpoint or losing dismissal`, async () => {
    const c = loadBackground(target);
    const sender = { tab: { id: 7 }, frameId: 0 };
    const ask = (msg, source = {}) => new Promise(resolve => c.chrome.runtime.onMessage.listener(msg, source, resolve));
    await ask({ action: 'exportStateUpdate', jobId: 'job-1', state: 'working', phase: 'history' }, sender);
    let state = 'in_progress';
    c.chrome.downloads.search = async () => [{ state }];
    const key = 'gceCheckpoint:' + 'a'.repeat(64);
    const payload = { conversationName: 'Fixture', messages: [], exportDate: '2026-11-03T12:00:00Z',
      checkpoint: { key, value: { timestamp: 100, fingerprints: [] } } };
    await ask({ action: 'packageAndDownload', jobId: 'job-1', format: 'txt', payload }, sender);
    await ask({ action: 'acknowledgeExportJob', jobId: 'job-1' });
    state = 'interrupted';
    c.chrome.downloads.onChanged.listener({ id: 1, state: { current: state } });
    const job = (await ask({ action: 'getExportJobs' })).jobs[0];
    await vm.runInContext('checkpointQueue', c);
    assert.equal(job.state, 'error');
    assert.equal(job.phase, 'interrupted');
    assert.equal(job.acknowledged, true, 'closing a save card also dismisses its later download events');
    assert.equal((await c.chrome.storage.local.get(key))[key], undefined);
    assert.equal(c.chrome.action.badge, '');
    state = 'complete';
    c.chrome.downloads.onChanged.listener({ id: 1, state: { current: state } });
    const resumed = (await ask({ action: 'getExportJobs' })).jobs[0];
    assert.equal(resumed.state, 'done', 'resuming the native download must replace its interrupted status');
    assert.equal(resumed.acknowledged, true);
  });

  test(`${target}: all download formats preserve UTF-8 and HTML ZIPs contain real bundled attachments`, async () => {
    const c = loadBackground(target, true);
    if (target === 'firefox') c.navigator.userAgent = 'Mozilla/5.0 Firefox/140.0';
    const payload = { conversationName: 'Synthetic space', exportDate: '2026-11-03T12:00:00Z', messages: [
      { messageId: 'parent', threadId: 'parent', sender: 'Alice', absoluteTimestamp: 100, text: 'Question — café 👋', media: [] },
      { messageId: 'reply', threadId: 'parent', parentMessageId: 'parent', sender: 'Bob', absoluteTimestamp: 200, text: 'Answer — こんにちは', media: [
        { type: 'file', name: 'note.txt', url: 'https://example.com/note.txt', _localPath: 'media/1_note.txt', mimeType: 'text/plain' }
      ] }
    ], mediaFiles: [{ path: 'media/1_note.txt', base64: Buffer.from('Attachment — résumé').toString('base64') }] };
    for (const format of ['txt', 'md', 'html']) {
      let download;
      c.chrome.downloads.download = (options, callback) => { download = options; callback(42); };
      const response = await new Promise(resolve => c.chrome.runtime.onMessage.listener({ action: 'packageAndDownload', format, payload }, {}, resolve));
      assert.equal(response.success, true, response.error);
      let bytes;
      if (target === 'firefox') {
        assert.ok(download.url.startsWith('blob:'));
        const resource = await fetch(download.url);
        assert.equal(resource.status, 200);
        bytes = new Uint8Array(await resource.arrayBuffer());
        URL.revokeObjectURL(download.url);
      } else {
        assert.ok(download.url.startsWith('data:'));
        bytes = Buffer.from(download.url.split(',')[1], 'base64');
      }
      if (format === 'html') {
        const archive = await c.JSZip.loadAsync(bytes);
        const html = await archive.file('index.html').async('string');
        assert.match(html, /Question — café 👋/);
        assert.match(html, /Answer — こんにちは/);
        assert.match(html, /data-parent-message-id="parent"/);
        assert.match(html, /href="media\/1_note.txt"/);
        assert.ok((await archive.file('styles.css').async('string')).includes('.thread'));
        assert.equal(await archive.file('media/1_note.txt').async('string'), 'Attachment — résumé');
        assert.match(response.filename, /\.zip$/);
      } else {
        const text = Buffer.from(bytes).toString('utf8');
        assert.match(text, /Question — café 👋/);
        assert.match(text, /Answer — こんにちは/);
        assert.match(response.filename, format === 'md' ? /\.md$/ : /\.txt$/);
      }
    }
  });

  test(`${target}: exported thread text keeps an untimestamped deletion between its actual neighbors`, () => {
    const c = loadBackground(target);
    const payload = { conversationName: 'Synthetic space', exportDate: '2026-11-03T12:00:00Z', messages: [
      { messageId: 'deleted', threadId: 'parent', parentMessageId: 'parent', previousMessageId: 'earlier', nextMessageId: 'later', absoluteTimestamp: 0, text: '[Message deleted by its author]' },
      { messageId: 'parent', threadId: 'parent', absoluteTimestamp: 10, text: 'Original question' },
      { messageId: 'earlier', threadId: 'parent', parentMessageId: 'parent', absoluteTimestamp: 20, text: 'Earlier reply' },
      { messageId: 'later', threadId: 'parent', parentMessageId: 'parent', absoluteTimestamp: 30, text: 'Later reply' }
    ] };
    for (const text of [c.generateMarkdown(payload), c.generateHtml(payload)]) {
      assert.ok(text.indexOf('Earlier reply') < text.indexOf('[Message deleted by its author]'));
      assert.ok(text.indexOf('[Message deleted by its author]') < text.indexOf('Later reply'));
    }
  });

  test(`${target}: TXT, Markdown, and HTML group replies with their parent context`, async () => {
    const c = loadBackground(target);
    const payload = {
      conversationName: 'Synthetic space', exportDate: '2026-11-03T12:00:00Z',
      history: { threadsScanned: 1, since: 200 },
      messages: [
        { messageId: 'new-reply', threadId: 'parent', parentMessageId: 'parent', sender: 'Bob', absoluteTimestamp: 300, text: 'New answer', media: [] },
        { messageId: 'parent', threadId: 'parent', sender: 'Alice', absoluteTimestamp: 10, text: 'Original question', contextOnly: true, media: [] },
        { messageId: 'unrelated', threadId: 'unrelated', sender: 'Carol', absoluteTimestamp: 200, text: 'Another topic', media: [] },
        { messageId: 'deleted', threadId: 'parent', parentMessageId: 'parent', sender: 'Unknown', text: '[Message deleted by its author]', deleted: true, media: [] }
      ]
    };
    const markdown = c.generateMarkdown(payload);
    assert.equal((markdown.match(/^## Thread parent$/gm) || []).length, 1);
    assert.ok(markdown.indexOf('Original question') < markdown.indexOf('New answer'));
    assert.match(markdown, /- Reply to: parent/);
    assert.match(markdown, /- Message ID: new-reply/);
    assert.match(markdown, /- Parent context from earlier history/);
    assert.match(markdown, /- Threads scanned: 1/);
    assert.match(markdown, /## Messages\n/);
    assert.ok(markdown.indexOf('## Messages') > markdown.indexOf('New answer'), 'standalone messages do not become part of the preceding thread');
    assert.match(markdown, /Message deleted by its author/);
    const html = c.generateHtml(payload);
    assert.match(html, /<section class="thread" data-thread-id="parent">/);
    assert.match(html, /data-message-id="new-reply" data-parent-message-id="parent"/);
    assert.ok(html.indexOf('Original question') < html.indexOf('New answer'));
    assert.ok(html.indexOf('</section>') < html.indexOf('Another topic'));
    assert.match(html, /Parent context from earlier history/);
    let download;
    c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
    await c.packageTxt(payload);
    const txt = Buffer.from(download.url.split(',')[1], 'base64').toString();
    assert.match(txt, /Thread parent/);
    assert.match(txt, /\[Reply to parent\]/);
    assert.match(txt, /\[Parent context from earlier history\]/);
    assert.ok(txt.indexOf('Original question') < txt.indexOf('New answer'));
    assert.ok(txt.indexOf('End thread') < txt.indexOf('Another topic'));
  });

  test(`${target}: completed checkpoints retain known undated messages across concurrent downloads`, async () => {
    const c = loadBackground(target);
    const key = 'gceCheckpoint:' + 'e'.repeat(64);
    const fingerprint = 'f'.repeat(64);
    const checkpoint = (timestamp, undatedFingerprints) => ({ key, value: { timestamp, fingerprints: [], undatedFingerprints } });
    await c.queueCheckpoint(1, checkpoint(100, [fingerprint]));
    await c.queueCheckpoint(2, checkpoint(200, []));
    assert.equal((await c.chrome.storage.local.get(key))[key].undatedFingerprints[0], fingerprint);
    await c.queueCheckpoint(3, checkpoint(50, ['a'.repeat(64)]));
    const saved = (await c.chrome.storage.local.get(key))[key];
    assert.equal(saved.timestamp, 200);
    assert.equal(saved.undatedFingerprints.length, 2);
    assert.throws(() => c.queueCheckpoint(4, checkpoint(300, ['invalid hash'])), /Invalid checkpoint/);
  });

  test(`${target}: tab targeting accepts MCAS Chat but rejects lookalike domains`, async () => {
    const c = loadBackground(target);
    assert.equal(await c.resolveTargetTab({ id: 7, url: 'https://chat.google.com.mcas.ms/app/chat/ROOM' }), 7);
    assert.equal(await c.resolveTargetTab({ id: 8, url: 'https://chat.google.com.example.org/app/chat/ROOM' }), null);
    assert.equal(await c.resolveTargetTab({ id: 9, url: 'https://chat.google.com.mcas.ms.example.org/app/chat/ROOM' }), null);
  });

  test(`${target}: Markdown export preserves literal text, timestamps, and attachment links`, async () => {
    const c = loadBackground(target);
    const text = '# Not a transcript heading\n\n```js\nconst value = "<script> & café 👋";\n```\n````\n[last line]';
    const payload = {
      conversationName: 'Team [agents] <chat>',
      exportDate: '2026-11-03T12:30:00.000Z',
      messages: [
        {
          sender: 'Alice *admin*', date: 'November 3, 2026', timestamp: '6:00 AM',
          absoluteTimestamp: Date.parse('2026-11-03T12:00:00Z'), text,
          media: [
            { type: 'image', name: 'photo [1].png', url: 'https://example.com/photo (1).png' },
            { type: 'audio', name: 'voice.mp3', url: 'https://example.com/voice.mp3', durationMs: 65000 },
            { type: 'file', name: '<unsafe>.html', url: 'javascript:alert(1)' },
            { type: 'file', name: 'missing.pdf', url: '' }
          ]
        },
        { sender: 'Bob', date: 'November 3, 2026', timestamp: '6:01 AM', text: 'Second message', media: [] },
        { date: 'November 4, 2026', media: [{ type: 'file', name: 'report.pdf', url: 'https://example.com/report.pdf' }] }
      ],
      history: { warning: 'Only rendered messages <captured>.', since: Date.parse('2026-11-02T00:00:00Z') }
    };
    let download;
    c.chrome.downloads.download = (options, callback) => { download = options; callback(42); };
    const result = await c.packageMarkdown(payload);
    const markdown = Buffer.from(download.url.split(',')[1], 'base64').toString('utf8');

    assert.equal(result.downloadId, 42);
    assert.match(result.filename, /\.md$/);
    assert.equal(download.filename, result.filename);
    assert.match(download.url, /^data:text\/markdown;charset=utf-8;base64,/);
    assert.ok(markdown.startsWith('# Team \\[agents\\] &lt;chat&gt;\n'));
    assert.match(markdown, /- Messages: 3\n- Exported: 2026-11-03T12:30:00\.000Z/);
    assert.match(markdown, /- New since: 2026-11-02T00:00:00\.000Z/);
    assert.match(markdown, /> Warning: Only rendered messages &lt;captured&gt;\./);
    assert.ok(markdown.includes('### Alice \\*admin\\* — 2026-11-03T12:00:00.000Z'));
    assert.ok(markdown.includes('`````text\n' + text + '\n`````\n'), 'a longer fence preserves nested code and raw HTML as literal text');
    assert.equal((markdown.match(/^## November 3, 2026$/gm) || []).length, 1);
    assert.match(markdown, /## November 4, 2026/);
    assert.match(markdown, /### Bob — 6:01 AM/);
    assert.match(markdown, /### Unknown — Time unknown/);
    assert.ok(markdown.includes('- Image: [photo \\[1\\].png](<https://example.com/photo%20(1).png>)'));
    assert.ok(markdown.includes('- Audio: [voice.mp3](<https://example.com/voice.mp3>) (1:05)'));
    assert.ok(markdown.includes('- File: &lt;unsafe&gt;.html [unavailable]'));
    assert.ok(markdown.includes('- File: missing.pdf [unavailable]'));
    assert.ok(markdown.includes('- File: [report.pdf](<https://example.com/report.pdf>)'));
    assert.doesNotMatch(markdown, /javascript:/);
    assert.ok(markdown.endsWith('\n'));
  });

  test(`${target}: Markdown uses the download route and commits its checkpoint only on completion`, async () => {
    const c = loadBackground(target);
    const key = 'gceCheckpoint:' + 'c'.repeat(64);
    const checkpoint = { key, value: { timestamp: 100, fingerprints: ['d'.repeat(64)] } };
    let download;
    let state = 'in_progress';
    c.chrome.downloads.download = (options, callback) => { download = options; callback(7); };
    c.chrome.downloads.search = async () => [{ state }];
    const response = await new Promise(resolve => c.chrome.runtime.onMessage.listener({
      action: 'packageAndDownload', format: 'md',
      payload: { conversationName: 'Fixture', messages: [], exportDate: '2026-11-03T12:00:00Z', checkpoint }
    }, {}, resolve));

    assert.equal(response.success, true);
    assert.match(response.filename, /\.md$/);
    assert.match(download.url, /^data:text\/markdown;/);
    assert.equal((await c.chrome.storage.local.get(key))[key], undefined);
    state = 'complete';
    c.chrome.downloads.onChanged.listener({ id: 7, state: { current: state } });
    await vm.runInContext('checkpointQueue', c);
    assert.equal((await c.chrome.storage.local.get(key))[key].timestamp, 100);
  });

  test(`${target}: Markdown context menu starts a Markdown export`, async () => {
    const c = loadBackground(target);
    const menus = [];
    c.chrome.contextMenus.create = menu => menus.push(menu);
    c.chrome.runtime.onInstalled.listener();
    const menu = menus.find(item => item.id === 'export_md');
    assert.ok(menu);
    assert.ok(menu.documentUrlPatterns.includes('https://mail.google.com/*'));
    const calls = [];
    c.triggerExport = async (tab, format) => calls.push({ tab, format });
    const tab = { id: 7, url: 'https://chat.google.com/u/0/app/chat/ABC' };
    await c.chrome.contextMenus.onClicked.listener({ menuItemId: menu.id }, tab);
    assert.deepEqual(calls, [{ tab, format: 'md' }]);
  });
}

test('a 10,000-message Markdown download preserves every message and Unicode text', async () => {
  const c = loadBackground();
  const messages = Array.from({ length: 10000 }, (_, index) => {
    const parent = `message-${Math.floor(index / 10) * 10}`;
    return { messageId: `message-${index}`, threadId: parent, parentMessageId: index % 10 ? parent : '',
      sender: 'Synthetic sender', absoluteTimestamp: 1793700000000 + index,
      text: `Unique body ${index}: café こんにちは 👋\n` + 'Literal code and text. '.repeat(12), media: [] };
  });
  let download;
  c.chrome.downloads.download = (options, callback) => { download = options; callback(1); };
  await c.packageMarkdown({ conversationName: 'Synthetic large export', exportDate: '2026-11-03T12:00:00Z', messages });
  const text = Buffer.from(download.url.split(',')[1], 'base64').toString('utf8');
  assert.equal((text.match(/^- Message ID: /gm) || []).length, 10000);
  assert.equal((text.match(/^## Thread /gm) || []).length, 1000);
  assert.match(text, /Unique body 0: café こんにちは 👋/);
  assert.match(text, /Unique body 9999: café こんにちは 👋/);
});

