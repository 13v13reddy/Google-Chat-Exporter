'use strict';
const { test, expect } = require('./fixture');
const fs = require('node:fs');
const path = require('node:path');

test('restored popup matches main’s original visual tokens and control geometry', async ({ app }, info) => {
  await app.openSource();
  const popup = await app.popup();
  await expect(popup.locator('#conv-name')).toHaveText('Fixture space');
  await popup.getByLabel('Dark mode').uncheck();
  await expect(popup.locator('html')).toHaveAttribute('data-gce-theme', 'light');
  const icon = fs.readFileSync(path.join(__dirname, '../../chrome/icons/icon48.png')).toString('base64');
  const original = fs.readFileSync(path.join(__dirname, 'references/main-popup.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('src="icons/icon48.png"', `src="data:image/png;base64,${icon}"`);
  const reference = await app.context.newPage();
  await reference.setContent(original);
  await reference.evaluate(() => {
    document.getElementById('conv-dot').className = 'conv-dot';
    const name = document.getElementById('conv-name'); name.className = 'conv-name'; name.textContent = 'Fixture space';
    document.getElementById('media-row').style.opacity = '.45';
  });
  const sample = page => page.evaluate(() => {
    const selectors = ['.header', '.header-inner', '.logo-wrap', '.header-text h1', '.header-text p', '.version-badge', '.conv-bar', '.conv-dot', '.conv-name', '.body', '.option-group', '.option-row', '.option-label', '.option-sub', '.format-select', '.date-input', '.toggle', '.toggle-track', '.toggle-thumb', '.export-btn', '.tip', '.footer'];
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'backgroundImage', 'backgroundColor', 'color', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'borderRadius', 'borderTopWidth', 'borderTopColor', 'boxShadow'];
    return Object.fromEntries(selectors.map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return [selector, Object.fromEntries(properties.map(property => [property, style[property]]))];
    }));
  });
  const expected = await sample(reference);
  // The real popup transitions from its disabled startup button into idle.
  await expect.poll(() => sample(popup)).toEqual(expected);
  await popup.locator('body').screenshot({ path: info.outputPath('restored-main-light.png') });
  await reference.locator('body').screenshot({ path: info.outputPath('main-reference.png') });
  await reference.close();
});

test('popup retains its intrinsic width when the toolbar host starts at a tiny viewport', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  // Vivaldi starts the toolbar guest at 28px and sizes it from its content.
  // Viewport-relative width caps create a feedback loop at that initial size.
  await popup.setViewportSize({ width: 28, height: 102 });
  await expect.poll(async () => (await popup.locator('body').boundingBox()).width).toBe(360);
  expect(await popup.locator('#format-select').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100);
});

test('original popup layout keeps named settings, dark mode, and saved results usable', async ({ app }, info) => {
  await app.openSource();
  const longName = 'A long conversation name with café 日本語 and a verylongunbrokensuffix'.repeat(2);
  await app.source.locator('header').evaluate((element, name) => {
    element.textContent = name; element.setAttribute('aria-label', name);
  }, longName);
  const popup = await app.popup();
  await expect(popup.locator('#conv-name')).toHaveText(longName);
  await expect(popup.getByLabel('Dark mode')).toBeVisible();
  await expect(popup.getByLabel('Auto-export on open')).toBeVisible();
  await expect(popup.locator('.logo-wrap img')).toBeVisible();
  await expect(popup.locator('.export-btn .download-icon')).toBeVisible();
  for (const dark of [false, true]) {
    await popup.getByLabel('Dark mode').setChecked(dark);
    await expect(popup.locator('html')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    expect(await popup.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await popup.getByLabel('Export Format', { exact: true }).focus();
    await popup.locator('body').screenshot({ path: info.outputPath(`popup-${dark ? 'dark' : 'light'}.png`) });
  }
  await popup.getByLabel('Export Format', { exact: true }).selectOption('md');
  await app.setRange(popup, 'visible');
  await popup.close();
  const reopened = await app.popup();
  await expect(reopened.getByLabel('Dark mode')).toBeChecked();
  await expect(reopened.getByLabel('Export Format', { exact: true })).toHaveValue('md');
  await expect(reopened.getByLabel('Load Full History', { exact: true })).not.toBeChecked();
  const job = await app.finished(await app.start(reopened));
  const card = reopened.frameLocator('#export-result iframe');
  await expect(card.locator('#heading')).toHaveText('Export saved with warnings');
  await expect(reopened.locator('#export-result')).toBeInViewport({ ratio: 1 });
  await expect(card.locator('#warning')).toBeVisible();
  await expect(card.locator('svg, img')).toHaveCount(0);
  for (const dark of [false, true]) {
    await reopened.getByLabel('Dark mode').setChecked(dark);
    await expect(card.locator('html')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    await reopened.locator('#export-result').screenshot({ path: info.outputPath(`result-${dark ? 'dark' : 'light'}.png`) });
  }
  await card.getByRole('button', { name: 'Dismiss export notification' }).click();
  await expect(reopened.locator('#export-result')).toBeHidden();
  expect((await app.download(job)).exists).toBe(true);
  expect(app.errors).toEqual([]);
});

test('original date and incremental controls preserve the settings contract and unavailable Chat stays explained', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.locator('#date-from').fill('2026-01-09');
  await popup.locator('#load-all').uncheck();
  await popup.locator('#incremental').check();
  await expect(popup.locator('#date-from')).toBeDisabled();
  await expect(popup.locator('#load-all')).toBeDisabled();
  expect(await popup.evaluate(() => readSettings())).toMatchObject({ loadAll: true, incremental: true, dateFrom: '' });
  await popup.locator('#incremental').uncheck();
  await expect(popup.locator('#date-from')).toHaveValue('2026-01-09');
  await expect(popup.locator('#date-from')).toBeEnabled();
  await popup.locator('#date-from').fill('');
  expect(await popup.evaluate(() => readSettings())).toMatchObject({ loadAll: false, incremental: false, dateFrom: '' });
  expect(await app.jobs()).toEqual([]);
  await popup.close();
  await app.source.goto('about:blank');
  const unavailable = await app.popup();
  await expect(unavailable.locator('#connection-error')).toContainText('Open a conversation in Google Chat');
  await expect(unavailable.locator('#export-btn')).toBeDisabled();
  expect(await app.jobs()).toEqual([]);
});

test('theme changes reach the active progress notification without interrupting collection', async ({ app }, info) => {
  await app.openSource('?delay=1200');
  const popup = await app.popup();
  const id = await app.start(popup);
  await expect(app.source.locator('#gce-progress')).toBeVisible();
  for (const dark of [true, false]) {
    await popup.getByLabel('Dark mode').setChecked(dark);
    await expect(app.source.locator('#gce-progress')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    await expect(app.source.locator('#gce-progress .gce-logo svg')).toBeVisible();
    await expect(app.source.getByRole('button', { name: 'Cancel export', exact: true })).toHaveText('×');
    await app.source.locator('#gce-progress').screenshot({ path: info.outputPath(`notification-${dark ? 'dark' : 'light'}.png`) });
  }
  expect((await app.finished(id)).state).toBe('done');
  expect(app.errors).toEqual([]);
});
