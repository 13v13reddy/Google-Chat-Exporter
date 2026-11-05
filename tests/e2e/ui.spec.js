'use strict';
const { test, expect } = require('./fixture');

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
  await expect(popup.locator('svg, img')).toHaveCount(0);
  for (const dark of [false, true]) {
    await popup.getByLabel('Dark mode').setChecked(dark);
    await expect(popup.locator('html')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    expect(await popup.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await popup.getByLabel('Format', { exact: true }).focus();
    await popup.locator('body').screenshot({ path: info.outputPath(`popup-${dark ? 'dark' : 'light'}.png`) });
  }
  await popup.getByLabel('Format', { exact: true }).selectOption('md');
  await popup.getByLabel('Messages', { exact: true }).selectOption('visible');
  await popup.close();
  const reopened = await app.popup();
  await expect(reopened.getByLabel('Dark mode')).toBeChecked();
  await expect(reopened.getByLabel('Format', { exact: true })).toHaveValue('md');
  await expect(reopened.getByLabel('Messages', { exact: true })).toHaveValue('visible');
  const job = await app.finished(await app.start(reopened));
  const card = reopened.frameLocator('#export-result iframe');
  await expect(card.locator('#heading')).toHaveText('Export saved with warnings');
  await expect(card.locator('#warning')).toBeVisible();
  await expect(card.locator('svg, img')).toHaveCount(0);
  for (const dark of [false, true]) {
    await reopened.getByLabel('Dark mode').setChecked(dark);
    await expect(card.locator('html')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    await reopened.locator('body').screenshot({ path: info.outputPath(`result-${dark ? 'dark' : 'light'}.png`) });
  }
  await card.getByRole('button', { name: 'Dismiss export notification' }).click();
  await expect(reopened.locator('#export-result')).toBeHidden();
  expect((await app.download(job)).exists).toBe(true);
  expect(app.errors).toEqual([]);
});

test('date validation and unavailable Chat give a retryable explanation without starting a job', async ({ app }) => {
  await app.openSource();
  const popup = await app.popup();
  await popup.getByLabel('Messages', { exact: true }).selectOption('since');
  await popup.locator('#export-btn').click();
  await expect(popup.locator('#status-text')).toHaveText('Choose a start date.');
  expect(await app.jobs()).toEqual([]);
  await expect(popup.locator('#export-btn')).toBeEnabled();
  await popup.close();
  await app.source.goto('about:blank');
  const unavailable = await app.popup();
  await expect(unavailable.locator('#connection-error')).toContainText('Open a conversation in Google Chat');
  await expect(unavailable.locator('#export-btn')).toBeDisabled();
  expect(await app.jobs()).toEqual([]);
});

test('theme changes reach the active progress notification without interrupting collection', async ({ app }) => {
  await app.openSource('?delay=1200');
  const popup = await app.popup();
  const id = await app.start(popup);
  await expect(app.source.locator('#gce-progress')).toBeVisible();
  for (const dark of [true, false]) {
    await popup.getByLabel('Dark mode').setChecked(dark);
    await expect(app.source.locator('#gce-progress')).toHaveAttribute('data-gce-theme', dark ? 'dark' : 'light');
    await expect(app.source.locator('#gce-progress svg, #gce-progress img')).toHaveCount(0);
    await expect(app.source.locator('#gce-progress button')).toHaveText('Cancel');
  }
  expect((await app.finished(id)).state).toBe('done');
  expect(app.errors).toEqual([]);
});
