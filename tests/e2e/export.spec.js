'use strict';
const { test, expect } = require('./fixture');
const fs = require('node:fs/promises');
const JSZip = require('../../chrome/lib/jszip.min.js');
const ids = text => [...text.matchAll(/^- Message ID: (.+)$/gm)].map(match => match[1]);

test('toolbar Markdown completes with older history, collapsed replies, and a saved result', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await expect(popup.locator('#export-btn')).toBeEnabled();
  await popup.locator('#format-select').selectOption('md');
  const requested = await app.start(popup);
  const job = await app.finished(requested);
  expect(job.state).toBe('done');
  const [item] = await app.control.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
  expect(item.state).toBe('complete');
  const text = await fs.readFile(item.filename, 'utf8');
  const expected = await app.source.evaluate(() => fixture.expected);
  expect(new Set(ids(text))).toEqual(new Set(expected));
  expect(text).toContain('café 日本語');
  const result = popup.frameLocator('#export-result iframe');
  await expect(result.locator('#heading')).toHaveText('Export saved');
  await expect(result.locator('#open')).toBeEnabled();
  await result.locator('#close').click();
  await expect(popup.locator('#export-result')).toBeHidden();
  expect(app.errors).toEqual([]);
});

for (const media of [false, true]) test(`HTML archive preserves offline content${media ? ' and attachment bytes' : ''}`, async ({ app }) => {
  await app.openSource(media ? '?media=1' : '');
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('html');
  await popup.locator('#include-media').setChecked(media);
  const result = await app.finished(await app.start(popup));
  expect(result.state).toBe('done');
  const archive = await JSZip.loadAsync(await fs.readFile((await app.download(result)).filename));
  const html = await archive.file(/\.html$/)[0].async('string');
  expect(html).toContain('café 日本語');
  expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');
  expect(html.match(/data-thread-id=/g)).toHaveLength(2);
  const images = archive.file(/\.png$/);
  expect(images).toHaveLength(media ? 1 : 0);
  if (media) expect(await images[0].async('nodebuffer')).toEqual(app.png);
  expect(app.errors).toEqual([]);
});

test('plain text export is UTF-8 and includes replies and deletion placeholders', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  const result = await app.finished(await app.start(popup));
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(text).toContain('café 日本語');
  expect(text).toContain('First reply');
  expect(text).toContain('Message deleted by its author');
  expect(text).toContain('Thread parent-0');
});

test('loaded-only export leaves threads closed and captures only rendered parents', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('visible');
  const result = await app.finished(await app.start(popup));
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(['parent-4', 'parent-5', 'parent-6', 'parent-7']));
  expect(result.collectionWindowId).toBeUndefined();
  expect(await app.source.evaluate(() => fixture.stats.opened)).toBe(0);
});

test('loaded-only export includes already-open replies without expanding collapsed content', async ({ app }) => {
  await app.openSource();
  await app.source.locator('.CYx15d').click();
  await expect(app.source.locator('.hSo9Ub')).toBeVisible();
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('visible');
  const result = await app.finished(await app.start(popup));
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(['parent-4', 'parent-5', 'parent-6', 'parent-7', 'parent-6-reply-2']));
  expect(await app.source.evaluate(() => fixture.stats)).toMatchObject({ opened: 1, expanded: 0, loaded: 0 });
  expect(result.collectionWindowId).toBeUndefined();
});

test('source navigation and popup closure do not stop its separate collector', async ({ app }) => {
  await app.openSource('?delay=500');
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  const requested = await app.start(popup);
  await popup.close();
  await app.source.goto('https://chat.google.com/app/chat/OTHER');
  const away = await app.context.newPage(); await away.goto('about:blank'); await away.bringToFront();
  const result = await app.finished(requested);
  expect(result.state).toBe('done');
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(await app.source.evaluate(() => fixture.expected)));
  expect(result.conversationName).toBe('Fixture space');
  const reopened = await app.popup(false);
  await expect(reopened.frameLocator('#export-result iframe').locator('#heading')).toHaveText('Export saved');
});

test('cancellation from a reopened popup closes the collector without a partial download', async ({ app }) => {
  await app.openSource('?delay=2000');
  const popup = await app.popup();
  const requested = await app.start(popup);
  await popup.close();
  const away = await app.context.newPage(); await away.goto('about:blank'); await away.bringToFront();
  const reopened = await app.popup(false);
  await expect(reopened.locator('#cancel-export')).toBeVisible();
  await reopened.locator('#cancel-export').click();
  const result = await app.finished(requested);
  expect(result.phase).toBe('cancelled');
  expect(result.downloadId).toBeUndefined();
  await expect(reopened.locator('#status-text')).toHaveText('Export cancelled.');
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.tabId)).toBe(false);
});

test('incremental checkpoints advance after a native save and skip previously exported deletions', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('new');
  const baseline = await app.finished(await app.start(popup));
  expect(baseline.state).toBe('done');
  const checkpoint = await app.control.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('gceCheckpoint:')));
  expect(checkpoint).toHaveLength(1);
  const empty = await app.finished(await app.start(popup));
  expect(empty.phase).toBe('empty');
  expect(empty.downloadId).toBeUndefined();
  await app.openSource('?new=1');
  const added = await app.finished(await app.start(popup));
  const text = await fs.readFile((await app.download(added)).filename, 'utf8');
  expect(ids(text)).toEqual(['new-message']);
});

test('incomplete replies warn in the file and leave the incremental checkpoint unchanged', async ({ app }) => {
  await app.openSource('?stuck=1');
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('new');
  const result = await app.finished(await app.start(popup));
  expect(result.warning).toContain('could not be completely loaded');
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(text).toContain('Thread loading issues');
  expect(text).toMatch(/collapsed replies/i);
  expect(await app.control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('gceCheckpoint:')))).toEqual([]);
});

test('a failed attachment is reported without advancing the checkpoint', async ({ app }) => {
  await app.openSource('?media=1&mediaFail=1');
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('html');
  await popup.locator('#range-select').selectOption('new');
  const result = await app.finished(await app.start(popup));
  expect(result.warning).toMatch(/media|attachment/i);
  expect(await app.control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('gceCheckpoint:')))).toEqual([]);
});

test('date filtering retains the older parent context for recent replies', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  await popup.locator('#range-select').selectOption('since');
  await popup.locator('#date-from').fill('2026-01-09');
  const result = await app.finished(await app.start(popup));
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(['parent-0', 'parent-6', 'parent-0-deleted', 'parent-6-deleted', 'parent-0-reply-2', 'parent-6-reply-2']));
  expect(text.match(/Parent context from earlier history/g)).toHaveLength(2);
});

test('Gmail exports target its Chat frame and retain its account in the collector', async ({ app }) => {
  await app.source.goto('https://mail.google.com/mail/u/1/#chat/space/ROOM');
  await app.source.frameLocator('iframe').locator('.nF6pT').first().waitFor();
  const popup = await app.popup();
  await expect(popup.locator('#conv-name')).toHaveText('Fixture space');
  await popup.locator('#format-select').selectOption('md');
  const result = await app.finished(await app.start(popup));
  expect(result.sourceFrameId).toBeGreaterThan(0);
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  const expected = await app.source.frames()[1].evaluate(() => fixture.expected);
  expect(new Set(ids(text))).toEqual(new Set(expected));
});

test('reloading the collector produces a persistent interruption and no partial file', async ({ app }) => {
  await app.openSource('?delay=2000');
  const popup = await app.popup();
  const requested = await app.start(popup);
  await expect.poll(async () => (await app.jobs()).find(job => job.jobId === requested)?.phase).toBe('history');
  const current = (await app.jobs()).find(job => job.jobId === requested);
  await app.control.evaluate(id => chrome.tabs.reload(id), current.tabId);
  const result = await app.finished(requested);
  expect(result.state).toBe('error');
  expect(result.phase).toBe('interrupted');
  expect(result.downloadId).toBeUndefined();
  await expect(popup.locator('#status-text')).toContainText('interrupted');
});

test('closing the collector interrupts the job without a download or checkpoint', async ({ app }) => {
  await app.openSource('?delay=2000');
  const popup = await app.popup();
  await popup.locator('#range-select').selectOption('new');
  const requested = await app.start(popup);
  await expect.poll(async () => (await app.jobs()).find(job => job.jobId === requested)?.phase).toBe('history');
  const current = (await app.jobs()).find(job => job.jobId === requested);
  await app.control.evaluate(id => chrome.windows.remove(id), current.collectionWindowId);
  const result = await app.finished(requested);
  expect(result.phase).toBe('interrupted');
  expect(result.downloadId).toBeUndefined();
  expect(await app.control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('gceCheckpoint:')))).toEqual([]);
  await expect(popup.locator('#status-text')).toContainText('closed');
});

test('minimizing the collector preserves a complete export across browser rendering policies', async ({ app }) => {
  await app.openSource('?delay=2000');
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  const requested = await app.start(popup);
  await expect.poll(async () => (await app.jobs()).find(job => job.jobId === requested)?.phase).toBe('history');
  const current = (await app.jobs()).find(job => job.jobId === requested);
  const collector = app.context.pages().find(page => page.url().includes('chat.google.com') && page !== app.source);
  const devtools = await app.context.newCDPSession(collector);
  // Playwright enables focus emulation by default. Disable it so this check
  // exercises a real minimized page instead of an always-visible test page.
  await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await app.control.evaluate(id => chrome.windows.update(id, { state: 'minimized' }), current.collectionWindowId);
  await expect.poll(async () => (await app.jobs()).find(job => job.jobId === requested)?.state).toMatch(/^(paused|done)$/);
  const minimized = (await app.jobs()).find(job => job.jobId === requested);
  // Some automated browsers keep minimized pages rendering. Both policies
  // must preserve every message; a stopped renderer must retain a resumable job.
  if (minimized.state === 'paused') {
    expect(minimized.downloadId).toBeUndefined();
    await popup.getByRole('button', { name: 'Show export', exact: true }).click();
  }
  const result = await app.finished(requested);
  expect(result.state).toBe('done');
  expect(result.jobId).toBe(requested);
  expect((await app.download(result)).state).toBe('complete');
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(await app.source.evaluate(() => fixture.expected)));
  await devtools.detach().catch(() => {});
});

test('a thread deep link exports the conversation root and cleans up its helper', async ({ app }) => {
  await app.source.goto('https://chat.google.com/u/1/room/ROOM/thread/parent-6');
  await app.source.waitForFunction(() => window.fixture?.ready);
  const popup = await app.popup();
  await popup.locator('#format-select').selectOption('md');
  const result = await app.finished(await app.start(popup));
  expect(result.state).toBe('done');
  const text = await fs.readFile((await app.download(result)).filename, 'utf8');
  expect(new Set(ids(text))).toEqual(new Set(await app.source.evaluate(() => fixture.expected)));
  expect(await app.control.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), result.tabId)).toBe(false);
  expect(app.source.url()).toContain('/thread/parent-6');
});

test('a service-worker restart recovers collection and completes its native download', async ({ app }) => {
  await app.openSource('?delay=1000');
  const popup = await app.popup();
  const requested = await app.start(popup);
  await expect.poll(async () => (await app.jobs()).find(job => job.jobId === requested)?.phase).toBe('history');
  const devtools = await app.context.newCDPSession(app.control);
  const versions = [];
  devtools.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
  await devtools.send('ServiceWorker.enable');
  await expect.poll(() => versions.find(version => version.scriptURL === `chrome-extension://${app.extensionId}/background.js` && version.runningStatus === 'running')).toBeTruthy();
  const version = versions.find(version => version.scriptURL === `chrome-extension://${app.extensionId}/background.js` && version.runningStatus === 'running');
  await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  const result = await app.finished(requested);
  expect(result.state).toBe('done');
  expect((await app.download(result)).state).toBe('complete');
  await devtools.detach();
});

test('a blocked download leaves the checkpoint unchanged and permits a retry', async ({ app }, info) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#range-select').selectOption('new');
  const devtools = await app.context.browser().newBrowserCDPSession();
  await devtools.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const blocked = await app.finished(await app.start(popup));
  expect(blocked.state).toBe('error');
  expect(await app.control.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith('gceCheckpoint:')))).toEqual([]);
  await devtools.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: info.outputPath('retry-downloads') });
  const retried = await app.finished(await app.start(popup));
  expect(retried.state).toBe('done');
  expect((await app.download(retried)).exists).toBe(true);
  await devtools.detach();
});

test('a missing exported file disables Open and leaves useful error guidance', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#range-select').selectOption('visible');
  const result = await app.finished(await app.start(popup));
  const card = popup.frameLocator('#export-result iframe');
  await expect(card.locator('#open')).toBeEnabled();
  await app.control.evaluate(id => chrome.downloads.removeFile(id), result.downloadId);
  await expect.poll(async () => (await app.download(result)).exists).toBe(false);
  await popup.reload();
  await expect(popup.frameLocator('#export-result iframe').locator('#open')).toBeDisabled();
  await expect(popup.frameLocator('#export-result iframe').locator('#error')).toContainText('no longer available');
});

test('auto-export saves each opened conversation once and stops when disabled', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#export-mode').check();
  const first = await app.finished();
  expect(first.state).toBe('done');
  await app.source.goto('https://chat.google.com/app/chat/OTHER');
  await expect.poll(async () => (await app.jobs()).length).toBe(2);
  const second = (await app.jobs()).find(job => job.jobId !== first.jobId);
  expect((await app.finished(second.jobId)).conversationName).toBe('Other space');
  await app.openSource();
  await expect.poll(async () => (await app.message({ action: 'getExportMode' })).enabled).toBe(true);
  await popup.locator('#export-mode').uncheck();
  expect((await app.message({ action: 'getExportMode' })).enabled).toBe(false);
  expect(await app.jobs()).toHaveLength(2);
});
