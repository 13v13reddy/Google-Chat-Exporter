'use strict';
const { test, expect } = require('./fixture');
const fs = require('node:fs/promises');
const JSZip = require('../../chrome/lib/jszip.min.js');
const ids = text => [...text.matchAll(/^- Message ID: (.+)$/gm)].map(match => match[1]);

test('network export finishes with exact IDs while every Chat tab is hidden and the source closes', async ({ app }) => {
  app.api.state.delay = 300;
  await app.openSource('', true);
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  const requested = await app.start(popup);
  const current = (await app.jobs()).find(job => job.jobId === requested);
  expect(current.collector).toBe('network');
  const away = await app.context.newPage(); await away.goto('about:blank'); await away.bringToFront();
  await popup.close();
  await app.source.close();
  const result = await app.finished(requested);
  expect(result.state, result.text).toBe('done');
  expect(result.collectionWindowId).toBeUndefined();
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(ids(text)).toHaveLength(app.api.expected().length);
  expect(new Set(ids(text))).toEqual(new Set(app.api.expected()));
  expect(text).toContain('[Message deleted]');
  expect(text).toContain('café 日本語');
  expect(text).not.toContain('Warning:');
  expect(app.api.state.calls.filter(call => call.operation === 'list_messages').length).toBeGreaterThanOrEqual(4);
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.backgroundTabId)).toBe(false);
  const saved = await app.control.evaluate(() => chrome.storage.local.get(null));
  expect(JSON.stringify(saved)).not.toContain('café');
  expect(JSON.stringify(saved)).not.toContain('synthetic-xsrf');
});

for (const format of ['txt', 'html']) test(`network ${format} preserves content${format === 'html' ? ' and attachment bytes' : ''}`, async ({ app }) => {
  app.api.state.media = format === 'html';
  await app.openSource('', true);
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption(format);
  const result = await app.finished(await app.start(popup));
  expect(result.state, result.text).toBe('done');
  const bytes = await fs.readFile((await app.download(result)).filename);
  if (format === 'html') {
    const zip = await JSZip.loadAsync(bytes);
    const html = await zip.file('index.html').async('string');
    expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');
    const images = zip.file(/\.png$/); expect(images).toHaveLength(1);
    expect(await images[0].async('nodebuffer')).toEqual(app.png);
  } else {
    expect(bytes.toString('utf8')).toContain('café 日本語');
    expect(bytes.toString('utf8')).toContain('[Message deleted]');
  }
});

for (const failure of ['schema', 'policy', 'auth', 'replies', 'stall']) test(`network ${failure} failure keeps the checkpoint and never saves partial history`, async ({ app }) => {
  app.api.state.failure = failure;
  await app.openSource('', true);
  const popup = await app.popup();
  await popup.locator('#range-select').selectOption('new');
  const result = await app.finished(await app.start(popup));
  expect(result.state).toBe('error');
  expect(result.phase).toBe('failed');
  expect(result.downloadId).toBeUndefined();
  const storage = await app.control.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(storage).filter(key => key.startsWith('gceCheckpoint:') || key.startsWith('gcePending:'))).toEqual([]);
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.backgroundTabId)).toBe(false);
});

test('network cancellation during a slow response closes only its helper and stays cancelled', async ({ app }) => {
  app.api.state.delay = 3000;
  await app.openSource('', true);
  const popup = await app.popup();
  const requested = await app.start(popup);
  await expect.poll(() => app.api.state.calls.length).toBeGreaterThan(0);
  await app.message({ action: 'cancelExportJob', jobId: requested });
  const result = await app.finished(requested);
  expect(result.phase).toBe('cancelled');
  expect(result.downloadId).toBeUndefined();
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.backgroundTabId)).toBe(false);
  expect(app.source.isClosed()).toBe(false);
  expect((await app.jobs()).find(job => job.jobId === requested).phase).toBe('cancelled');
});

test('network incremental baseline, empty result, date context, throttling and attachment failure retain safe checkpoints', async ({ app }) => {
  app.api.state.failure = 'throttle';
  await app.openSource('', true);
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('new');
  const first = await app.finished(await app.start(popup));
  expect(first.state, first.text).toBe('done');
  expect(app.api.state.throttled).toBe(true);
  const empty = await app.finished(await app.start(popup));
  expect(empty.phase).toBe('empty'); expect(empty.downloadId).toBeUndefined();
  await popup.locator('#range-select').selectOption('since');
  await popup.locator('#date-from').fill('2026-01-09');
  const filtered = await app.finished(await app.start(popup));
  expect(filtered.state, filtered.text).toBe('done');
  const text = await fs.readFile((await app.download(filtered)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(['parent-0', 'parent-6', 'parent-0-reply-2', 'parent-6-reply-2']));
  expect(text.match(/Parent context from earlier history/g)).toHaveLength(2);
  app.api.state.newMessage = true;
  await popup.locator('#range-select').selectOption('new');
  const added = await app.finished(await app.start(popup));
  const addedText = await fs.readFile((await app.download(added)).filename, 'utf8');
  expect(ids(addedText)).toEqual(['new-message']);
  app.api.state.media = true; app.api.state.mediaFail = true;
  await popup.locator('#format-select').selectOption('html');
  await popup.locator('#range-select').selectOption('new');
  const failedMedia = await app.finished(await app.start(popup));
  expect(failedMedia.state).toBe('done'); expect(failedMedia.warning).toMatch(/attachments failed/);
  const checkpoints = await app.control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('gceCheckpoint:')));
  expect(checkpoints).toHaveLength(1);
});

for (const operation of ['reload', 'close', 'restart']) test(`network collector ${operation} leaves an interruption without a partial download`, async ({ app }) => {
  app.api.state.delay = 3000;
  await app.openSource('', true);
  const popup = await app.popup();
  const requested = await app.start(popup);
  await expect.poll(() => app.api.state.calls.length).toBeGreaterThan(0);
  const current = (await app.jobs()).find(job => job.jobId === requested);
  if (operation === 'restart') {
    const devtools = await app.context.newCDPSession(app.control);
    const versions = [];
    devtools.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
    await devtools.send('ServiceWorker.enable');
    await expect.poll(() => versions.find(version => version.scriptURL === `chrome-extension://${app.extensionId}/background.js` && version.runningStatus === 'running')).toBeTruthy();
    const version = versions.find(version => version.scriptURL === `chrome-extension://${app.extensionId}/background.js` && version.runningStatus === 'running');
    await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await devtools.detach();
  } else await app.control.evaluate(({ id, operation }) => operation === 'reload' ? chrome.tabs.reload(id) : chrome.tabs.remove(id), { id: current.backgroundTabId, operation });
  const result = await app.finished(requested);
  expect(result.phase, result.text).toBe('interrupted');
  expect(result.downloadId).toBeUndefined();
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.backgroundTabId)).toBe(false);
});

test('losing the network helper during media cannot race into saving an incomplete archive', async ({ app }) => {
  app.api.state.media = true; app.api.state.mediaDelay = 3000;
  await app.openSource('', true);
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('html');
  const requested = await app.start(popup);
  await expect.poll(() => app.api.state.mediaCalls).toBeGreaterThan(0);
  const current = (await app.jobs()).find(job => job.jobId === requested);
  await app.control.evaluate(id => chrome.tabs.remove(id), current.backgroundTabId);
  const result = await app.finished(requested);
  expect(result.phase, result.text).toBe('interrupted');
  expect(result.downloadId).toBeUndefined();
});
