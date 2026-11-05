'use strict';
const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createAPI } = require('./api-fixture');
const root = path.join(__dirname, '..', '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');

const test = base.extend({
  app: async ({}, use, info) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: process.env.GCE_HEADED !== '1', acceptDownloads: true, viewport: null,
      downloadsPath: info.outputPath('downloads'),
      args: [`--disable-extensions-except=${path.join(root, 'chrome')}`, `--load-extension=${path.join(root, 'chrome')}`],
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
    });
    const errors = [];
    const api = createAPI(png);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https:\/\/(chat|mail)\.google\.com\//, async route => {
      const url = new URL(route.request().url());
      if (/\/api\/(list_topics|list_messages|get_attachment_url)$/.test(url.pathname)) return api.handler(route);
      if (url.pathname === '/gce-fixture.js') return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, 'chat.js')) });
      if (url.hostname === 'mail.google.com') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main role="main">Gmail fixture</main><iframe name="single_full_screen" style="width:95vw;height:90vh" src="https://chat.google.com/u/1/dm/ROOM${url.search}"></iframe>` });
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8').replace('<head>', '<head><script>window.WIZ_global_data={SMqcke:"synthetic-xsrf"}</script>') });
    });
    await context.route('https://fixtures.googleusercontent.com/**', route => route.fulfill({ status: route.request().url().includes('missing') ? 404 : 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }));
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    // Chrome does not route runtime.sendMessage back to the sending worker.
    // Use a real extension page as the test controller for browser API calls.
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    const message = value => control.evaluate(value => chrome.runtime.sendMessage(value), value);
    const source = await context.newPage();
    const openSource = async (query = '', network = false) => {
      await source.goto(`https://chat.google.com/app/${network ? 'chat' : 'dm'}/ROOM${query}`);
      await source.waitForFunction(() => window.fixture?.ready);
      return source;
    };
    const popup = async (focusSource = true) => {
      if (focusSource) await source.bringToFront();
      await control.evaluate(url => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/popup.html`);
      const find = () => context.pages().find(page => page.url().startsWith(`chrome-extension://${extensionId}/popup.html`) && page !== control);
      await expect.poll(find).not.toBeUndefined();
      const page = find();
      await page.waitForLoadState('domcontentloaded');
      return page;
    };
    const jobs = async () => (await message({ action: 'getExportJobs' })).jobs;
    const start = async page => {
      const previous = new Set((await jobs()).map(job => job.jobId));
      await page.locator('#export-btn').click();
      await expect.poll(async () => (await jobs()).find(job => !previous.has(job.jobId))).toBeTruthy();
      return (await jobs()).find(job => !previous.has(job.jobId)).jobId;
    };
    const finished = async id => {
      const find = async () => (await jobs()).find(job => (!id || job.jobId === id) && !['working', 'paused'].includes(job.state));
      await expect.poll(find, { timeout: 45000 }).toBeTruthy();
      return find();
    };
    const download = async job => (await control.evaluate(id => chrome.downloads.search({ id }), job.downloadId))[0];
    try {
      await use({ context, worker, extensionId, control, source, openSource, popup, message, jobs, start, finished, download, errors, png, api });
      expect(errors, 'extension and Chat pages must not throw uncaught errors').toEqual([]);
    }
    finally {
      await info.attach('browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
      await info.attach('export-jobs', { body: JSON.stringify(await jobs()), contentType: 'application/json' });
      await info.attach('page-states', { body: JSON.stringify(await Promise.all(context.pages().map(async page => ({ url: page.url(), state: await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), width: innerWidth })).catch(() => null) })))), contentType: 'application/json' });
      await context.close();
    }
  }
});
module.exports = { test, expect };
