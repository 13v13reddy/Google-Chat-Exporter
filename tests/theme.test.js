'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function preferences(initial = {}) {
  const values = { ...initial };
  const listeners = new Set();
  return { values, onChanged: { addListener(fn) { listeners.add(fn); } }, local: {
    async get(key) { return { [key]: values[key] }; },
    async set(update) {
      const changes = Object.fromEntries(Object.entries(update).map(([key, newValue]) => [key, { oldValue: values[key], newValue }]));
      Object.assign(values, update);
      for (const listener of listeners) listener(changes, 'local');
    },
    async remove(key) {
      const oldValue = values[key];
      delete values[key];
      for (const listener of listeners) listener({ [key]: { oldValue } }, 'local');
    }
  } };
}

function loadTheme(target, storage, dark = false) {
  const changes = new Set();
  const media = { matches: dark, addEventListener(_type, fn) { changes.add(fn); } };
  const context = vm.createContext({ chrome: { storage }, window: { matchMedia: () => media } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'theme.js'), 'utf8'), context);
  const host = () => ({ attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
  return { theme: vm.runInContext('GCETheme', context), host,
    system(isDark) { media.matches = isDark; for (const fn of changes) fn(); } };
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: one saved theme updates the popup, notification, and result card without changing Chat`, async () => {
    const storage = preferences();
    const popup = loadTheme(target, storage);
    const chat = loadTheme(target, storage);
    const result = loadTheme(target, storage);
    await Promise.all([popup.theme.ready, chat.theme.ready, result.theme.ready]);
    const popupRoot = popup.host(), chatRoot = chat.host(), hud = chat.host(), card = result.host();
    popup.theme.bind(popupRoot);
    const detach = chat.theme.bind(hud);
    result.theme.bind(card);
    await popup.theme.set('dark');
    for (const element of [popupRoot, hud, card]) assert.equal(element.attributes['data-gce-theme'], 'dark');
    assert.deepEqual(chatRoot.attributes, {}, 'the content script themes only its own notification host');
    const reopened = loadTheme(target, storage);
    await reopened.theme.ready;
    assert.equal(reopened.theme.current, 'dark', 'closing and reopening an extension page preserves the choice');
    detach();
    await popup.theme.set('light');
    assert.equal(popupRoot.attributes['data-gce-theme'], 'light');
    assert.equal(card.attributes['data-gce-theme'], 'light');
    assert.equal(hud.attributes['data-gce-theme'], 'dark', 'dismissed notification subscriptions are removed');
  });

  test(`${target}: system appearance is the default and explicit choices survive system changes`, async () => {
    const storage = preferences();
    const p = loadTheme(target, storage, true);
    await p.theme.ready;
    assert.equal(p.theme.current, 'dark');
    p.system(false);
    assert.equal(p.theme.current, 'light');
    await p.theme.set('dark');
    p.system(false);
    assert.equal(p.theme.current, 'dark');
    await storage.local.remove('gceTheme');
    assert.equal(p.theme.current, 'light');
  });

  test(`${target}: a stale preference read cannot overwrite a newer theme change`, async () => {
    const storage = preferences();
    let resolve;
    storage.local.get = () => new Promise(done => { resolve = done; });
    const p = loadTheme(target, storage);
    await p.theme.set('dark');
    resolve({ gceTheme: 'light' });
    await p.theme.ready;
    assert.equal(p.theme.current, 'dark');
  });

  test(`${target}: an unsuccessful theme save restores the prior appearance`, async () => {
    const storage = preferences({ gceTheme: 'dark' });
    const p = loadTheme(target, storage);
    await p.theme.ready;
    storage.local.set = async () => { throw new Error('Storage unavailable'); };
    await assert.rejects(p.theme.set('light'), /Storage unavailable/);
    assert.equal(p.theme.current, 'dark');
    assert.equal(storage.values.gceTheme, 'dark');
  });
}
