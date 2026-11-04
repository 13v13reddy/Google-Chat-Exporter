'use strict';

// Shared by extension pages and content scripts; never themes the Chat page.
const GCETheme = (() => {
  const KEY = 'gceTheme';
  const system = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const listeners = new Set();
  let preference = null;
  let current = system?.matches ? 'dark' : 'light';
  let revision = 0;

  function apply(value) {
    preference = value === 'dark' || value === 'light' ? value : null;
    current = preference || (system?.matches ? 'dark' : 'light');
    for (const listener of listeners) listener(current);
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, KEY)) return;
    revision++;
    apply(changes[KEY].newValue);
  });
  system?.addEventListener('change', () => { if (!preference) apply(null); });
  const initialRevision = revision;
  const ready = chrome.storage.local.get(KEY).then(data => {
    if (revision === initialRevision) apply(data[KEY]);
    return current;
  }).catch(() => current);

  return {
    ready,
    get current() { return current; },
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    bind(element) { return this.subscribe(theme => element.setAttribute('data-gce-theme', theme)); },
    async set(theme) {
      if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme');
      const previous = preference;
      const update = ++revision;
      apply(theme);
      try { await chrome.storage.local.set({ [KEY]: theme }); }
      catch (error) { if (revision === update) apply(previous); throw error; }
    }
  };
})();
