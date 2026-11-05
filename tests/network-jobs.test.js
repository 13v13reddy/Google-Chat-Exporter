'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fixture(target, initial = {}) {
  const stored = structuredClone(initial);
  const session = {};
  const pageMessages = [], notifications = [], requests = [], removed = [];
  const downloads = new Map();
  const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); },
    emit(...args) { for (const listener of this.listeners) listener(...args); } });
  const chrome = {
    storage: { local: {
      async get(key) { return structuredClone(key ? { [key]: stored[key] } : stored); },
      async set(values) { Object.assign(stored, structuredClone(values)); }
    }, session: { async get(key) { return { [key]: session[key] }; }, async set(values) { Object.assign(session, structuredClone(values)); } } },
    runtime: { async sendMessage(message) { notifications.push(structuredClone(message)); } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    power: { requestKeepAwake(level) { requests.push(level); }, releaseKeepAwake() { requests.push('release'); } },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      async get() { throw new Error('The source tab is unavailable'); },
      async remove(id) { removed.push(id); },
      async sendMessage(tabId, message, options) {
        pageMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        if (message.action !== 'exportJobUpdate') throw new Error('A network job must not ask the source page for ownership');
        return { received: true };
      }
    },
    downloads: { onChanged: event(), async search({ id }) {
      const state = downloads.get(id);
      return state ? [{ id, state }] : [];
    } }
  };
  const context = vm.createContext({ chrome, console: { warn() {}, error() {} }, setTimeout, clearTimeout,
    setInterval, clearInterval, AbortController, URL, URLSearchParams, TextEncoder, crypto: require('node:crypto').webcrypto });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'export-jobs.js'), 'utf8'), context);
  const jobs = vm.runInContext('ExportJobs', context);
  const details = { sourceTabId: 7, sourceFrameId: 3, sourceWindowId: 9, conversationName: 'Fixture space' };
  const read = id => structuredClone(stored.gceExportJobs?.[id]);
  const recover = () => jobs.handleMessage({ action: 'getExportJobs' }, {});
  const cancel = id => jobs.handleMessage({ action: 'cancelExportJob', jobId: id }, {});
  return { context, chrome, jobs, details, stored, read, recover, cancel, pageMessages, notifications, requests, removed, downloads };
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: a background-owned export survives source navigation and closure without display wakefulness`, async () => {
    const f = fixture(target);
    let aborted = false;
    await f.jobs.createBackground('job-network', f.details, () => { aborted = true; });
    await f.jobs.backgroundProgress('job-network', { phase: 'history', text: 'Loaded 100 messages', percent: 25 });
    f.chrome.tabs.onUpdated.emit(7, { status: 'loading', discarded: true });
    f.chrome.tabs.onRemoved.emit(7);
    await f.recover();
    const job = f.read('job-network');
    assert.equal(job.collector, 'network');
    assert.equal(job.tabId, 7);
    assert.equal(job.frameId, 3);
    assert.equal(job.sourceTabId, 7);
    assert.equal(job.sourceFrameId, 3);
    assert.equal(job.conversationName, 'Fixture space');
    assert.equal(job.state, 'working');
    assert.equal(job.text, 'Loaded 100 messages');
    assert.equal(job.percent, 25);
    assert.equal(aborted, false);
    assert.equal(f.requests.includes('display'), false);
    assert.deepEqual(f.removed, []);
    assert.equal(f.pageMessages.some(call => call.message.action === 'getExportJob'), false);
    assert.ok(f.pageMessages.some(call => call.message.action === 'exportJobUpdate' && call.tabId === 7 && call.options.frameId === 3));
    assert.ok(f.notifications.some(message => message.job.jobId === 'job-network' && message.job.text === job.text));
    assert.equal(JSON.stringify(f.stored).includes('abortCallback'), false, 'callbacks must not be persisted');
  });

  test(`${target}: cancellation wins queued background progress and packaging without resurrecting the job`, async () => {
    const f = fixture(target);
    let aborts = 0;
    await f.jobs.createBackground('job-network', f.details, () => { aborts++; });
    const cancelled = f.cancel('job-network');
    const lateProgress = f.jobs.backgroundProgress('job-network', { phase: 'media', text: 'Too late', percent: 85 });
    const latePackaging = assert.rejects(f.jobs.beginBackgroundPackaging('job-network'), /no longer active/);
    assert.equal((await cancelled).success, true);
    assert.equal((await lateProgress).success, false);
    await latePackaging;
    assert.equal((await f.jobs.backgroundFailed('job-network', new Error('AbortError'))).success, false);
    await assert.rejects(f.jobs.backgroundDownloaded('job-network', { downloadId: 42, filename: 'Fixture.md' }), /no longer active/);
    assert.equal((await f.cancel('job-network')).success, false);
    await f.recover();
    const job = f.read('job-network');
    assert.equal(aborts, 1);
    assert.equal(job.state, 'error');
    assert.equal(job.phase, 'cancelled');
    assert.equal(job.text, 'Export cancelled.');
    assert.equal(job.downloadId, undefined);
    assert.equal(job.percent, 0);
  });

  test(`${target}: packaging wins a late cancellation and native downloads retain their actual outcome`, async () => {
    const f = fixture(target);
    let aborts = 0;
    await f.jobs.createBackground('job-network', f.details, () => { aborts++; });
    const packaging = f.jobs.beginBackgroundPackaging('job-network');
    const cancel = f.cancel('job-network');
    await packaging;
    assert.equal((await cancel).success, false);
    assert.equal((await f.jobs.backgroundProgress('job-network', { phase: 'history', text: 'Stale', percent: 20 })).success, false);
    f.chrome.tabs.onRemoved.emit(7);
    await f.recover();
    assert.equal(f.read('job-network').phase, 'packaging');
    assert.equal(aborts, 0);
    f.downloads.set(0, 'in_progress');
    await f.jobs.backgroundDownloaded('job-network', { downloadId: 0, filename: 'Fixture.md', warning: 'A fixture warning' });
    let job = f.read('job-network');
    assert.equal(job.state, 'working');
    assert.equal(job.phase, 'download');
    assert.equal(job.downloadId, 0);
    assert.equal(job.warning, 'A fixture warning');
    assert.equal((await f.jobs.backgroundFailed('job-network', new Error('Too late'))).success, false);
    f.downloads.set(0, 'interrupted');
    f.chrome.downloads.onChanged.emit({ id: 0, state: { current: 'interrupted' } });
    await f.recover();
    assert.equal(f.read('job-network').state, 'error');
    assert.equal(f.read('job-network').phase, 'interrupted');
    f.downloads.set(0, 'complete');
    f.chrome.downloads.onChanged.emit({ id: 0, state: { current: 'complete' } });
    await f.recover();
    job = f.read('job-network');
    assert.equal(job.state, 'done');
    assert.equal(job.phase, 'complete');
    assert.equal(f.requests.includes('display'), false);
  });

  test(`${target}: worker restart interrupts orphaned network collection and packaging without polling source pages`, async () => {
    const persisted = {};
    for (const phase of ['history', 'media', 'packaging', 'download']) {
      const id = `job-${phase}`;
      persisted[id] = { jobId: id, collector: 'network', tabId: 7, frameId: 3, sourceTabId: 7,
        sourceFrameId: 3, state: 'working', phase, text: 'Working', revision: 2,
        startedAt: 1, updatedAt: 1, ...(phase === 'download' ? { downloadId: 42, filename: 'Fixture.md' } : {}) };
    }
    const f = fixture(target, { gceExportJobs: persisted });
    f.downloads.set(42, 'complete');
    await f.recover();
    for (const phase of ['history', 'media', 'packaging']) {
      const job = f.read(`job-${phase}`);
      assert.equal(job.state, 'error');
      assert.equal(job.phase, 'interrupted');
      assert.match(job.text, /background export ended/);
      assert.equal(job.downloadId, undefined);
    }
    assert.equal(f.read('job-download').state, 'done');
    assert.equal(f.read('job-download').phase, 'complete');
    assert.equal(f.pageMessages.some(call => call.message.action !== 'exportJobUpdate'), false);
    assert.equal(Object.keys(f.stored).some(key => key.startsWith('gceCheckpoint:') || key.startsWith('gcePending:')), false);
    assert.equal(f.requests.includes('display'), false);
  });

  test(`${target}: only the owning worker can update a network job and failures stay terminal`, async () => {
    const f = fixture(target);
    let aborts = 0;
    await f.jobs.createBackground('job-network', f.details, () => { aborts++; });
    const sender = { tab: { id: 7 }, frameId: 3 };
    const result = await f.jobs.handleMessage({ action: 'exportStateUpdate', jobId: 'job-network', state: 'done', phase: 'complete', text: 'Forged' }, sender);
    assert.equal(result.success, false);
    await assert.rejects(f.jobs.beginPackaging('job-network', sender), /no longer active/);
    await f.jobs.failed('job-network', sender, 'Forged failure');
    await f.jobs.downloaded('job-network', sender, { downloadId: 99, filename: 'Forged.md' });
    await f.recover();
    assert.equal(f.read('job-network').state, 'working');
    assert.equal(f.read('job-network').phase, 'history');
    assert.equal((await f.jobs.backgroundFailed('job-network', new Error('History request failed'))).success, true);
    assert.equal((await f.jobs.backgroundProgress('job-network', { phase: 'history', text: 'Late', percent: 50 })).success, false);
    await f.recover();
    assert.equal(f.read('job-network').phase, 'failed');
    assert.equal(f.read('job-network').text, 'Export failed: History request failed');
    assert.equal(aborts, 0);
    await assert.rejects(f.jobs.createBackground('job-network', f.details, () => {}), /already started/);
  });

  test(`${target}: full-history jobs share the source-window concurrency limit and network work does not hold a DOM wake lock`, async () => {
    const f = fixture(target);
    await f.jobs.createBackground('job-network', f.details, () => {});
    await assert.rejects(f.jobs.createBackground('job-other', { ...f.details, sourceTabId: 8 }, () => {}), /already running/);
    await assert.rejects(f.jobs.createCollection('job-helper', { tabId: 99, collectionWindowId: 100, sourceTabId: 8,
      sourceFrameId: 0, sourceWindowId: 9, conversationName: 'Other space' }), /already running/);
    const sender = { tab: { id: 12 }, frameId: 0 };
    await f.jobs.handleMessage({ action: 'exportStateUpdate', jobId: 'job-dom', state: 'working', phase: 'history', text: 'Loading' }, sender);
    assert.equal(f.requests.at(-1), 'display', 'a concurrent DOM collection still needs its display lock');
    await f.jobs.backgroundProgress('job-network', { phase: 'history', text: 'Network work', percent: 15 });
    assert.equal(f.requests.at(-1), 'display');
    await f.jobs.handleMessage({ action: 'exportStateUpdate', jobId: 'job-dom', state: 'paused', phase: 'history', text: 'Paused' }, sender);
    assert.equal(f.requests.at(-1), 'release', 'the remaining network job does not need display wakefulness');
    assert.equal(f.read('job-network').state, 'working');
  });

  test(`${target}: network helpers close on cancellation, failure and worker restart without touching the source`, async () => {
    for (const outcome of ['cancel', 'failure', 'restart', 'packaging']) {
      const f = fixture(target);
      const session = {};
      f.chrome.storage.session = { async get(key) { return { [key]: session[key] }; }, async set(values) { Object.assign(session, structuredClone(values)); } };
      f.chrome.tabs.get = async id => ({ id, windowId: 9 });
      await f.jobs.createBackground('job-helper', f.details, () => {});
      await f.jobs.attachBackgroundTab('job-helper', { id: 99, windowId: 9 });
      assert.equal(await f.jobs.isCollectionTab(99), true);
      if (outcome === 'cancel') await f.cancel('job-helper');
      if (outcome === 'failure') await f.jobs.backgroundFailed('job-helper', new Error('Fixture failure'));
      if (outcome === 'packaging') await f.jobs.beginBackgroundPackaging('job-helper');
      if (outcome === 'restart') {
        const next = fixture(target, f.stored);
        next.chrome.storage.session = f.chrome.storage.session;
        next.chrome.tabs.get = f.chrome.tabs.get;
        await next.recover();
        assert.deepEqual(next.removed, [99]);
        assert.equal(await next.jobs.isCollectionTab(99), false);
        continue;
      }
      assert.deepEqual(f.removed, [99]);
      assert.equal(await f.jobs.isCollectionTab(99), false);
      assert.equal(f.removed.includes(7), false);
    }
  });

  test(`${target}: background collector runs real protocol parsing, selection and packaging without polling DOM or persisting bodies`, async () => {
    const f = fixture(target);
    for (const name of ['chat-api.js', 'background-collector.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, name), 'utf8'), f.context);
    const collector = vm.runInContext('BackgroundCollector', f.context);
    const topicId = 'root', groupId = 'SPACE';
    const message = id => {
      const row = Array(20).fill(null); row[0] = [[null, null, null, [null, topicId, [[groupId]]]], id];
      row[1] = [['123'], 'Person']; row[2] = id === 'root' ? '1700000000000000' : '1700000001000000';
      row[9] = 'Private synthetic body 日本語'; return row;
    };
    const topic = Array(15).fill(null); topic[0] = [null, topicId, [[groupId]]];
    topic[6] = [message('root'), message('reply')]; topic[10] = Array(13).fill(null); topic[10][12] = ['1']; topic[14] = '1700000000000000';
    const calls = [], packages = [];
    f.chrome.tabs.get = async id => ({ id, windowId: 9, status: 'complete' });
    f.chrome.tabs.create = async options => { assert.equal(options.active, false); assert.equal(options.url, 'about:blank'); return { id: 99, windowId: 9 }; };
    f.chrome.tabs.update = async (id, options) => { assert.equal(id, 99); assert.equal(options.autoDiscardable, false); };
    f.chrome.scripting = { async executeScript(details) {
      assert.equal(details.world, 'MAIN');
      assert.equal(details.target.tabId, 99);
      const { operation } = details.args[0]; calls.push(operation);
      return [{ result: operation === 'ready' ? { ready: true } : { data: [['dfe.t.lt', [topic], null, null, true, true]] } }];
    } };
    await collector.start(7, { frameId: 3, name: 'Fixture space', conversationUrl: 'https://chat.google.com/u/2/room/SPACE' }, 'md', { includeMedia: false }, 'job-collector', async (format, payload) => {
      packages.push({ format, payload: structuredClone(payload) }); f.downloads.set(42, 'complete'); return { downloadId: 42, filename: 'Fixture.md' };
    });
    for (let i = 0; i < 50 && f.read('job-collector').state === 'working'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    const job = f.read('job-collector');
    assert.equal(job.state, 'done'); assert.equal(job.phase, 'complete');
    assert.deepEqual(calls, ['ready', 'list_topics']);
    assert.deepEqual(f.removed, [99]);
    assert.equal(packages.length, 1); assert.equal(packages[0].format, 'md');
    assert.deepEqual(packages[0].payload.messages.map(row => row.messageId), ['root', 'reply']);
    assert.equal(packages[0].payload.checkpoint.value.timestamp, 1700000001000);
    assert.equal(packages[0].payload.history.reason, 'api-complete');
    assert.equal(JSON.stringify(f.stored).includes('Private synthetic body'), false);
    assert.equal(JSON.stringify(f.stored).includes('xsrf'), false);
    assert.equal(f.pageMessages.some(call => call.message.action !== 'exportJobUpdate'), false);
  });

  test(`${target}: page-context requests are read-only, bounded, and never return the session token`, async () => {
    const f = fixture(target);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'background-collector.js'), 'utf8'), f.context);
    const collector = vm.runInContext('BackgroundCollector', f.context), calls = [];
    const location = new URL('https://chat.google.com.mcas.ms/u/2/room/SPACE');
    const page = vm.createContext({ location, URL, AbortController, setTimeout, clearTimeout,
      WIZ_global_data: { SMqcke: 'private-xsrf-fixture' },
      async fetch(url, options) { calls.push({ url, options }); return { ok: true, async text() { return ")]}'\n[[\"dfe.t.lt\",[],null,null,true,true]]"; } }; }
    });
    const call = async operation => {
      page.args = { operation, group: { origin: location.origin, account: '2' }, body: ['fixture'] };
      return vm.runInContext(`(${collector.pageRead.toString()})(args)`, page);
    };
    assert.equal((await call('ready')).ready, true);
    const response = await call('list_topics');
    assert.equal(response.data[0][0], 'dfe.t.lt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chat.google.com.mcas.ms/u/2/api/list_topics');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['x-framework-xsrf-token'], 'private-xsrf-fixture');
    assert.equal(JSON.stringify(response).includes('private-xsrf-fixture'), false);
    assert.match((await call('create_message')).error, /Unsupported/);
    assert.equal(calls.length, 1);
    location.pathname = '/u/3/room/SPACE';
    assert.match((await call('list_topics')).error, /account/);
    assert.equal(calls.length, 1);
  });
}
