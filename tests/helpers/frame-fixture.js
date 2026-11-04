'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

// Separate isolated worlds, as in Gmail's outer document and Chat iframe.
function installFrames(background, target, descriptions) {
  const root = path.join(__dirname, '..', '..', target);
  const selectors = JSON.parse(fs.readFileSync(path.join(root, 'selectors.json'), 'utf8'));
  const starts = [], injections = [], messages = [];
  const frames = new Map();
  const fixture = { starts, injections, messages, frames, rejectStart: false, failMessages: false };

  function load(frame, files) {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), frame.context, { filename: file });
      if (file === 'content.js') {
        frame.context.runExport = async options => { starts.push({ frameId: frame.id, options }); return 'done'; };
        frame.context.getConversationName = () => frame.chat ? 'Fixture room' : '';
      }
    }
  }

  for (const description of descriptions) {
    const frame = { id: description.id, chat: description.chat, listeners: [] };
    const chrome = {
      storage: background.chrome.storage,
      runtime: {
        id: 'fixture-extension', getURL: value => value,
        onMessage: { addListener(listener) { frame.listeners.push(listener); } },
        async sendMessage() { return {}; }
      }
    };
    const document = {
      hidden: false,
      querySelector(selector) { return description.mail && selector === '[role="main"]' ? {} : null; },
      querySelectorAll() { return []; }
    };
    frame.context = vm.createContext({
      chrome, document, window: { name: description.chat ? selectors.frameName : '', addEventListener() {}, dispatchEvent() {} },
      location: { href: description.mail ? 'https://mail.google.com/mail/u/0/' : 'https://chat.google.com/app/chat/ROOM' },
      fetch: async () => ({ json: async () => selectors }), crypto, URL, TextEncoder, AbortController,
      setTimeout, clearTimeout, setInterval() {}, console: { log() {}, warn() {}, error() {} }
    });
    if (description.legacy) {
      vm.runInContext('function runExport() {} function isInChatFrame() { return true; }', frame.context);
    } else if (description.loaded !== false) {
      load(frame, description.theme === false ? ['result-host.js', 'content.js'] : ['theme.js', 'result-host.js', 'content.js']);
    }
    frames.set(frame.id, frame);
  }

  background.chrome.scripting.executeScript = async details => {
    const selected = details.target.allFrames ? [...frames.values()] : Array.from(details.target.frameIds, id => frames.get(id));
    if (details.files) injections.push({ frameIds: selected.map(frame => frame.id), files: Array.from(details.files) });
    return Promise.all(selected.map(async frame => {
      if (details.files) { load(frame, details.files); return { frameId: frame.id }; }
      frame.context.fixtureArgs = details.args || [];
      const result = await vm.runInContext(`(${details.func.toString()})(...fixtureArgs)`, frame.context);
      return { frameId: frame.id, result };
    }));
  };
  background.chrome.tabs.get = async id => ({ id, url: 'https://mail.google.com/mail/u/0/#chat/space/ROOM' });
  background.chrome.tabs.sendMessage = (tabId, message, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    messages.push({ tabId, action: message.action, options });
    const request = (async () => {
      if (fixture.failMessages) throw new Error('Message channel unavailable');
      if (fixture.rejectStart && message.action === 'startExport') return { received: false, error: 'An export is already running.' };
      const selected = options?.frameId === undefined ? [...frames.values()] : [frames.get(options.frameId)];
      const responses = await Promise.all(selected.flatMap(frame => frame.listeners.map(listener => new Promise(resolve => {
        // A background sender has no tab or frameId. Neither identifies the receiver.
        const keepOpen = listener(message, { id: 'fixture-extension' }, resolve);
        if (!keepOpen) resolve(undefined);
      }))));
      return responses.find(response => response !== undefined);
    })();
    if (!callback) return request;
    request.then(callback, error => {
      background.chrome.runtime.lastError = { message: error.message };
      callback(undefined);
      background.chrome.runtime.lastError = null;
    });
    return Promise.resolve();
  };
  return fixture;
}

module.exports = { installFrames };
