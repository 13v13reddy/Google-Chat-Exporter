'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const { checkSources } = require('../scripts/check-sources');

test('shared browser sources cannot drift apart unnoticed', () => {
  checkSources(root);
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gce-sources-'));
  try {
    for (const browser of ['chrome', 'firefox']) {
      fs.mkdirSync(path.join(temporary, browser));
      fs.writeFileSync(path.join(temporary, browser, 'manifest.json'), browser);
      fs.writeFileSync(path.join(temporary, browser, 'content.js'), 'same');
    }
    checkSources(temporary);
    fs.writeFileSync(path.join(temporary, 'firefox', 'content.js'), 'different');
    assert.throws(() => checkSources(temporary), /Browser sources differ: content\.js/);
  } finally { fs.rmSync(temporary, { recursive: true }); }
});

test('popup and saved result use one local stylesheet and explicitly named controls', () => {
  for (const browser of ['chrome', 'firefox']) {
    const popup = fs.readFileSync(path.join(root, browser, 'popup.html'), 'utf8');
    const result = fs.readFileSync(path.join(root, browser, 'export-result.html'), 'utf8');
    for (const html of [popup, result]) assert.match(html, /href="ui\.css"/);
    for (const id of ['format-select', 'range-select', 'date-from']) assert.ok(popup.includes(`for="${id}"`));
    for (const [html, file, pattern] of [
      [popup, 'popup.js', /\$\('([^']+)'\)/g],
      [result, 'export-result.js', /getElementById\('([^']+)'\)/g]
    ]) {
      const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
      assert.equal(new Set(ids).size, ids.length, `${file} has no duplicate element IDs`);
      const script = fs.readFileSync(path.join(root, browser, file), 'utf8');
      for (const [, id] of script.matchAll(pattern)) assert.ok(ids.includes(id), `${browser}/${file} refers to missing #${id}`);
    }
  }
});

test('2.2 retains Gmail-integrated Chat support in Chrome extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '2.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, manifest.version);
  assert.ok(manifest.host_permissions.includes('https://mail.google.com/*'));
  assert.ok(manifest.content_scripts.some(script =>
    script.matches.includes('https://mail.google.com/*')
  ));
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('2.2 supports Firefox Add-on with Gecko settings and background scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'firefox', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '2.2.0');
  assert.equal(manifest.browser_specific_settings?.gecko?.id, 'google-chat-exporter@vishwas-r');
  assert.ok(manifest.browser_specific_settings?.gecko?.strict_min_version);
  assert.ok(manifest.browser_specific_settings?.gecko_android?.strict_min_version);
  assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, { required: ['none'] });
  assert.deepEqual(manifest.background.scripts, ['lib/jszip.min.js', 'export-jobs.js', 'background.js']);
  assert.ok(manifest.host_permissions.includes('https://mail.google.com/*'));
  assert.ok(manifest.content_scripts.some(script =>
    script.matches.includes('https://mail.google.com/*')
  ));
});

test('popup has no external font or stylesheet requests in chrome and firefox', () => {
  for (const target of ['chrome', 'firefox']) {
    const popup = fs.readFileSync(path.join(root, target, 'popup.html'), 'utf8');
    assert.doesNotMatch(popup, /fonts\.(?:googleapis|gstatic)\.com/i, `${target} popup should not request external fonts`);
    assert.doesNotMatch(popup, /<link[^>]+href=["']https?:/i, `${target} popup should not request external stylesheets`);
  }
});

test('both browser packages allow content scripts and resources on the exact MCAS Chat hosts', () => {
  for (const target of ['chrome', 'firefox']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, target, 'manifest.json'), 'utf8'));
    for (const pattern of ['https://chat.google.com.mcas.ms/*', 'https://mail.google.com.mcas.ms/*']) {
      assert.ok(manifest.host_permissions.includes(pattern));
      assert.ok(manifest.content_scripts.some(script => script.matches.includes(pattern)));
      assert.ok(manifest.web_accessible_resources.some(resource => resource.matches.includes(pattern)));
    }
    assert.ok(!manifest.host_permissions.includes('https://*.mcas.ms/*'), 'unrelated corporate-proxied sites are outside the requested permissions');
  }
});

test('both browser packages can load the privileged export result card from Chat and the popup', () => {
  for (const target of ['chrome', 'firefox']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, target, 'manifest.json'), 'utf8'));
    assert.ok(manifest.permissions.includes('downloads.open'));
    assert.ok(manifest.content_scripts.every(script => script.js.includes('result-host.js') && script.js.indexOf('result-host.js') < script.js.indexOf('content.js')));
    assert.ok(manifest.content_scripts.every(script => script.js.indexOf('theme.js') >= 0 && script.js.indexOf('theme.js') < script.js.indexOf('content.js')));
    assert.ok(manifest.web_accessible_resources.some(resource => resource.resources.includes('export-result.html')));
    const result = fs.readFileSync(path.join(root, target, 'export-result.html'), 'utf8');
    assert.match(result, /src="export-result\.js"/);
    assert.ok(result.indexOf('src="theme.js"') >= 0 && result.indexOf('src="theme.js"') < result.indexOf('src="export-result.js"'));
    assert.match(result, /aria-label="Dismiss export notification"/);
    const popup = fs.readFileSync(path.join(root, target, 'popup.html'), 'utf8');
    assert.ok(popup.includes('src="result-host.js"') && popup.indexOf('src="result-host.js"') < popup.indexOf('src="popup.js"'));
  }
});
