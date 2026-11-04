'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBackground(target = 'chrome', withZip = false) {
  const event = () => ({ addListener(fn) { this.listener = fn; } });
  const stored = {};
  const session = {};
  const chrome = {
    action: {
      badge: '',
      async setBadgeText({ text }) { this.badge = text; },
      async setBadgeBackgroundColor() {}
    },
    runtime: { onInstalled: event(), onMessage: { addListener(fn) { this.listener = fn; } }, async sendMessage() {}, lastError: null },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event() },
    tabs: { async query() { return []; }, async sendMessage() {} },
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
      onChanged: { addListener(fn) { this.listener = fn; } }
    }
  };
  const context = vm.createContext({
    chrome,
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
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
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

