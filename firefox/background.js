// ============================================================
// Google Chat Exporter v2.0 — background.js (Service Worker)
// 100% private: no external requests, no telemetry, no tracking
// ============================================================

if (typeof importScripts === 'function' && typeof JSZip === 'undefined') {
  importScripts('lib/jszip.min.js');
}
if (typeof importScripts === 'function' && typeof ExportJobs === 'undefined') {
  importScripts('export-jobs.js');
}
const mediaRequests = new Map();
const CHAT_URL_PATTERNS = ['https://chat.google.com/*', 'https://mail.google.com/*',
  'https://chat.google.com.mcas.ms/*', 'https://mail.google.com.mcas.ms/*'];
const CONTENT_PROTOCOL = 2; // Shared by content health and popup startup replies.
const contentPreparations = new Map();
const collectionStarts = new Map();
// Persist pending download/checkpoint associations so worker suspension is safe.
let checkpointQueue = Promise.resolve();
function serializeCheckpoint(work) {
  const next = checkpointQueue.then(work);
  checkpointQueue = next.catch(() => {});
  return next;
}

async function reconcileCheckpoint(downloadId) {
  const pendingKey = `gcePending:${downloadId}`;
  const pending = (await chrome.storage.local.get(pendingKey))[pendingKey];
  if (!pending) return;
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (download?.state === 'in_progress') return;
  if (download?.state === 'complete') {
    const old = (await chrome.storage.local.get(pending.key))[pending.key];
    const undatedFingerprints = [...new Set([...(old?.undatedFingerprints || []), ...(pending.value.undatedFingerprints || [])])];
    if (!old || pending.value.timestamp > old.timestamp) {
      await chrome.storage.local.set({ [pending.key]: { ...pending.value, undatedFingerprints } });
    } else if (pending.value.timestamp === old.timestamp) {
      const fingerprints = [...new Set([...old.fingerprints, ...pending.value.fingerprints])];
      await chrome.storage.local.set({ [pending.key]: { ...old, fingerprints, undatedFingerprints } });
    } else if (undatedFingerprints.length !== (old.undatedFingerprints || []).length) {
      await chrome.storage.local.set({ [pending.key]: { ...old, undatedFingerprints } });
    }
  }
  await chrome.storage.local.remove(pendingKey);
}

function queueCheckpoint(downloadId, checkpoint) {
  if (!/^gceCheckpoint:[a-f0-9]{64}$/.test(checkpoint.key) ||
      !Number.isFinite(checkpoint.value?.timestamp) || checkpoint.value.timestamp <= 0 ||
      !Array.isArray(checkpoint.value.fingerprints) ||
      !checkpoint.value.fingerprints.every(id => /^[a-f0-9]{64}$/.test(id)) ||
      (checkpoint.value.undatedFingerprints !== undefined &&
        (!Array.isArray(checkpoint.value.undatedFingerprints) ||
         !checkpoint.value.undatedFingerprints.every(id => /^[a-f0-9]{64}$/.test(id))))) {
    throw new Error('Invalid checkpoint');
  }
  return serializeCheckpoint(async () => {
    await chrome.storage.local.set({ [`gcePending:${downloadId}`]: checkpoint });
    await reconcileCheckpoint(downloadId);
  });
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state) serializeCheckpoint(() => reconcileCheckpoint(delta.id)).catch(console.error);
});

// Reconcile any downloads that completed while this worker was inactive.
chrome.storage.local.get(null).then(data => {
  for (const key of Object.keys(data)) {
    if (/^gcePending:\d+$/.test(key)) serializeCheckpoint(() => reconcileCheckpoint(Number(key.split(':')[1]))).catch(console.error);
  }
}).catch(console.error);
function mediaRequestKey(sender, id) {
  return `${sender.tab?.id}:${sender.frameId}:${id}`;
}

// ── Context Menu Setup ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Remove any existing menus to prevent duplicates on update
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'export_txt',
      title: 'Export Chat as TXT',
      contexts: ['all'],
      documentUrlPatterns: CHAT_URL_PATTERNS
    });

    chrome.contextMenus.create({
      id: 'export_md',
      title: 'Export Chat as Markdown',
      contexts: ['all'],
      documentUrlPatterns: CHAT_URL_PATTERNS
    });

    chrome.contextMenus.create({
      id: 'export_html',
      title: 'Export Chat as HTML (with media)',
      contexts: ['all'],
      documentUrlPatterns: CHAT_URL_PATTERNS
    });
  });
});

// ── Context Menu Click Handler ──────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const format = { export_txt: 'txt', export_md: 'md', export_html: 'html' }[info.menuItemId];
  if (!format) return;
  try {
    await triggerExport(tab, format);
  } catch (err) {
    console.error('[GCE BG] Export error:', err);
  }
});

function isSameConversationUrl(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    if (urlA.origin !== urlB.origin) return false;
    const clean = u => (u.pathname + u.hash).split('?')[0].replace(/\/thread\/[^/?#]+/, '');
    return clean(urlA) === clean(urlB);
  } catch {
    return true;
  }
}

// ── Export Mode ─────────────────────────────────────────────
// Session storage clears on browser restart, so the mode never outlives it.

const EXPORT_MODE_KEY = 'gceExportMode';
const EXPORT_MODE_IDLE_MS = 10 * 60 * 1000;
const sessionStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;

async function getExportMode(now = Date.now()) {
  const state = (await sessionStore.get(EXPORT_MODE_KEY))[EXPORT_MODE_KEY];
  if (!state?.enabled) return { enabled: false, exported: [], lastActivity: 0 };
  if (now - state.lastActivity > EXPORT_MODE_IDLE_MS) return setExportMode(false);
  return state;
}

async function setExportMode(enabled) {
  const state = { enabled, exported: [], lastActivity: Date.now() };
  await sessionStore.set({ [EXPORT_MODE_KEY]: state });
  await ExportJobs.updateBadge();
  const tabs = await chrome.tabs.query({ url: CHAT_URL_PATTERNS });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action: 'exportModeChanged', enabled }).catch(() => {});
  }
  chrome.runtime.sendMessage({ action: 'exportModeChanged', enabled }).catch(() => {});
  return state;
}

async function updateExportMode(update) {
  const state = await getExportMode();
  if (!state.enabled) return state;
  const next = { ...state, ...update(state), lastActivity: Date.now() };
  await sessionStore.set({ [EXPORT_MODE_KEY]: next });
  return next;
}

function handleExportModeMessage(msg, sender) {
  switch (msg.action) {
    case 'getExportMode':
      return (async () => ({ enabled: !(await ExportJobs.isCollectionTab(sender.tab?.id)) && (await getExportMode()).enabled, idleMs: EXPORT_MODE_IDLE_MS }))();
    case 'setExportMode':
      return setExportMode(msg.enabled === true).then(state => ({ enabled: state.enabled }));
    case 'exportModeActivity':
      return updateExportMode(() => ({})).then(state => ({ enabled: state.enabled }));
    case 'autoExportCandidate':
      return serializeExportMode(async () => {
        if (await ExportJobs.isCollectionTab(sender.tab?.id)) return { run: false };
        const state = await getExportMode();
        if (!state.enabled) return { run: false };
        const settings = await getSettings();
        // Incremental exports are cheap to repeat; full ones run once per channel.
        if (!settings.incremental && state.exported.includes(msg.key)) {
          await updateExportMode(() => ({}));
          return { run: false };
        }
        await updateExportMode(() => ({}));
        return { run: true, settings };
      });
    case 'autoExportDone':
      return serializeExportMode(() => updateExportMode(state => ({
        exported: state.exported.includes(msg.key) ? state.exported : [...state.exported, msg.key]
      }))).then(() => ({ success: true }));
    default:
      return null;
  }
}

let exportModeQueue = Promise.resolve();
function serializeExportMode(work) {
  const next = exportModeQueue.then(work);
  exportModeQueue = next.catch(() => {});
  return next;
}

// ── Message Handler (from popup & content script) ───────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const jobReply = ExportJobs.handleMessage(msg, sender);
  if (jobReply) {
    jobReply.then(sendResponse, err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  const exportModeReply = handleExportModeMessage(msg, sender);
  if (exportModeReply) {
    exportModeReply.then(sendResponse, err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'getConversation') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!tab.url?.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) throw new Error('Open a conversation in Google Chat.');
        const frame = await ensureContentScript(tab.id);
        sendResponse({ success: true, protocol: CONTENT_PROTOCOL, name: frame.name });
      } catch (error) {
        sendResponse({ success: false, protocol: CONTENT_PROTOCOL, error: error.message });
      }
    })();
    return true;
  }

  if (msg.action === 'popupExport') {
    // Triggered from popup button
    (async () => {
      try {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab) { sendResponse({ success: false, error: 'No active tab found.' }); return; }
        const started = await triggerExport(tab, msg.format || 'txt', msg.settings, msg.jobId);
        if (!started) { sendResponse({ success: false, error: 'Could not prepare Google Chat for export. Refresh the tab and try again.' }); return; }
        sendResponse({ success: true, protocol: CONTENT_PROTOCOL, jobId: started.jobId });
      } catch (err) {
        sendResponse({ success: false, protocol: CONTENT_PROTOCOL, error: err.message });
      }
    })();
    return true; // keep channel open
  }

  if (msg.action === 'packageAndDownload') {
    // Content script sends extracted data here for packaging
    (async () => {
      // Extension API activity prevents MV3 idle suspension during a long ZIP.
      // Keep this heartbeat scoped to packaging, never the lifetime of the worker.
      const keepAlive = typeof setInterval === 'function' ? setInterval(() => {
        chrome.storage.local.get('gceExportJobs').catch(() => {});
      }, 20000) : null;
      try {
        if (msg.payload.sourceUrl && sender.tab?.id) {
          // The payload is already captured; closing its tab cannot cancel packaging.
          const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
          if (tab?.url && !isSameConversationUrl(msg.payload.sourceUrl, tab.url)) {
            throw new Error('Conversation changed during export. Please retry.');
          }
        }
        await ExportJobs.beginPackaging(msg.jobId, sender);
        const result = msg.format === 'html'
          ? await packageHtml(msg.payload)
          : msg.format === 'md'
            ? await packageMarkdown(msg.payload)
            : await packageTxt(msg.payload);
        let checkpointWarning = '';
        if (msg.payload.checkpoint) {
          try { await queueCheckpoint(result.downloadId, msg.payload.checkpoint); }
          catch { checkpointWarning = 'Export downloaded, but its checkpoint could not be saved. Next export may repeat messages.'; }
        }
        await ExportJobs.downloaded(msg.jobId, sender, result,
          [msg.payload.history?.warning, checkpointWarning].filter(Boolean).join(' '));
        sendResponse({ success: true, ...result, checkpointWarning });
      } catch (err) {
        console.error('[GCE BG] Package error:', err);
        await ExportJobs.failed(msg.jobId, sender, err.message).catch(console.error);
        sendResponse({ success: false, error: err.message });
      } finally {
        if (keepAlive !== null) clearInterval(keepAlive);
      }
    })();
    return true;
  }

  if (msg.action === 'cancelMediaBg') {
    mediaRequests.get(mediaRequestKey(sender, msg.requestId))?.abort();
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'downloadMediaBg') {
    // Content script asks background to fetch media (bypasses CORS)
    (async () => {
      const key = mediaRequestKey(sender, msg.requestId);
      const controller = new AbortController();
      mediaRequests.set(key, controller);
      try {
        const result = await fetchMediaAsBase64(msg.url, controller.signal);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      } finally {
        mediaRequests.delete(key);
      }
    })();
    return true;
  }

  if (msg.action === 'exportStateUpdate') {
    // Relay progress updates to popup
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }
});

// Recover status after a service-worker/browser restart, including native saves.
ExportJobs.recover().catch(console.error);

// ── Core Export Trigger (PWA-safe) ─────────────────────────

/**
 * Trigger export on a tab with PWA/app window support.
 * Uses multi-strategy injection to handle normal tabs AND PWA windows.
 */
async function triggerExport(contextMenuTab, format, overrides = {}, requestedJobId = '') {
  // Find the best target tab (handles PWA windows)
  const targetTabId = await resolveTargetTab(contextMenuTab);
  if (!targetTabId) {
    console.error('[GCE BG] Could not find a Google Chat tab to export.');
    return false;
  }

  const frame = await ensureContentScript(targetTabId);
  if (!['txt', 'md', 'html'].includes(format)) throw new Error('Choose a supported export format.');

  // Send export command
  const settings = { ...await getSettings(), ...overrides };
  settings.sourceUrl = (await chrome.tabs.get(targetTabId)).url;
  const jobId = /^job-[a-zA-Z0-9-]{1,96}$/.test(requestedJobId) ? requestedJobId : `job-${crypto.randomUUID()}`;
  if ((settings.loadAll !== false || settings.incremental) && typeof chrome.windows?.create === 'function') {
    if (collectionStarts.has(jobId)) return collectionStarts.get(jobId);
    const pending = startCollectionWindow(targetTabId, frame, format, settings, jobId);
    collectionStarts.set(jobId, pending);
    try { return await pending; }
    finally { collectionStarts.delete(jobId); }
  }
  return sendExportCommand(targetTabId, frame.frameId, format, settings, jobId);
}

async function startCollectionWindow(sourceTabId, sourceFrame, format, settings, jobId) {
  const existing = await ExportJobs.getJob(jobId);
  if (existing) {
    if (existing.sourceTabId === sourceTabId && ['working', 'paused'].includes(existing.state)) return { received: true, jobId };
    throw new Error('This export request was already used. Start a new export.');
  }
  const href = sourceFrame.conversationUrl || settings.sourceUrl;
  if (!/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/.test(href || '')) throw new Error('Open this conversation in a browser tab and retry.');
  const url = conversationWindowUrl(href);
  const source = await chrome.tabs.get(sourceTabId);
  const sourceWindow = sourceFrame.display && chrome.windows.get ? await chrome.windows.get(source.windowId) : null;
  const placement = sourceWindow ? collectionWindowLayout(sourceWindow, sourceFrame.display) : null;
  // Register the blank helper before loading Chat so automatic export cannot
  // start recursively in the new window, even on a fast cached load.
  const options = { url: 'about:blank', type: 'popup', focused: false,
    width: 720, height: 760, ...placement?.helper, incognito: !!source.incognito };
  if (source.cookieStoreId) options.cookieStoreId = source.cookieStoreId;
  const window = await chrome.windows.create(options);
  const tabId = window.tabs?.[0]?.id;
  if (!Number.isInteger(tabId)) throw new Error('Could not create the export window.');
  try {
    await ExportJobs.createCollection(jobId, { tabId, collectionWindowId: window.id,
      sourceTabId, sourceFrameId: sourceFrame.frameId, sourceWindowId: source.windowId,
      conversationName: sourceFrame.name || 'Google Chat' }, placement);
    await ExportJobs.arrangeCollection(jobId);
    await chrome.tabs.update(tabId, { url, autoDiscardable: false });
    const deadline = Date.now() + 30000;
    let frame;
    while (Date.now() < deadline) {
      if (!await ExportJobs.collectionPending(jobId)) throw new Error('Export cancelled.');
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        try { frame = await ensureContentScript(tabId); } catch { /* Chat can finish rendering after navigation. */ }
        if (frame?.name) {
          if (frame.name !== sourceFrame.name || (sourceFrame.conversationScope && frame.conversationScope !== sourceFrame.conversationScope)) {
            throw new Error('The export window opened a different conversation. Open the conversation in a browser tab and retry.');
          }
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!frame?.name) throw new Error('Chat did not load in the export window. Check your sign-in and retry.');
    if (placement) await chrome.windows.update(window.id, { ...placement.helper, focused: false });
    if (sourceWindow?.focused && (await chrome.windows.get(window.id)).focused) {
      await chrome.windows.update(source.windowId, { focused: true });
    }
    await ExportJobs.prepareCollection(jobId, frame.frameId);
    const response = await sendExportCommand(tabId, frame.frameId, format,
      { ...settings, sourceUrl: url, collectionWindow: true }, jobId);
    ExportJobs.collectionStarted(jobId);
    return response;
  } catch (error) {
    await ExportJobs.failCollection(jobId, error.message);
    // Also cover a storage failure before the helper could be registered.
    if (!await ExportJobs.getJob(jobId)) await chrome.tabs.remove(tabId).catch(() => {});
    throw error;
  }
}

function collectionWindowLayout(window, display) {
  if (![window.left, window.top, window.width, window.height, display.width, display.height].every(Number.isFinite) || display.width < 1000) return null;
  if (window.state === 'fullscreen') throw new Error('Exit full screen and retry so the export window can stay visible.');
  const width = 500;
  const helper = { width, height: Math.min(window.height, display.height),
    top: Math.max(display.top, Math.min(window.top, display.top + display.height - Math.min(window.height, display.height))) };
  if (display.left + display.width - window.left - window.width >= width) helper.left = window.left + window.width;
  else if (window.left - display.left >= width) helper.left = window.left - width;
  else {
    const arranged = { left: display.left, top: helper.top,
      width: Math.min(window.width, display.width - width), height: helper.height };
    helper.left = arranged.left + arranged.width;
    const { id: windowId, left, top, width: originalWidth, height, state } = window;
    return { helper, layout: { windowId, original: { left, top, width: originalWidth, height, state }, arranged } };
  }
  return { helper };
}

function conversationWindowUrl(href) {
  const url = new URL(href);
  // A deep link can open only the selected thread on a narrow Chat window.
  // Keep the account and proxy parameters, but start at the conversation root.
  url.pathname = url.pathname.replace(/((?:\/app\/|\/)(?:dm|space|room|chat)\/[A-Za-z0-9_-]+)\/.*$/, '$1');
  url.hash = url.hash.replace(/^(#chat\/(?:dm|space|room|chat)\/[A-Za-z0-9_-]+)\/.*$/, '$1');
  return url.href;
}

async function sendExportCommand(targetTabId, frameId, format, settings, jobId) {
  const command = {
    action: 'startExport',
    jobId,
    format,
    loadAll: settings.loadAll !== false,  // default true
    includeMedia: settings.includeMedia !== false,  // default true for html
    dateFrom: settings.dateFrom || '',
    incremental: settings.incremental === true,
    sourceUrl: settings.sourceUrl,
    collectionWindow: settings.collectionWindow === true
  };
  let response;
  try {
    response = await chrome.tabs.sendMessage(targetTabId, command, { frameId });
  } catch {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId, frameIds: [frameId] },
      func: injectableExportTrigger,
      args: [command]
    });
    response = results[0]?.result;
  }
  if (!response?.received) throw new Error(response?.error || 'Export did not start. Refresh the Chat tab and retry.');
  return response;
}

/**
 * Resolves the best tab for export.
 * Strategy 1: Use the tab from the context menu event (works in normal tabs).
 * Strategy 2: Query ALL open tabs (including app windows) for chat.google.com.
 * Strategy 3: Query for mail.google.com as fallback.
 */
async function resolveTargetTab(contextMenuTab) {
  // Check if the context menu tab itself is a valid chat tab
  if (contextMenuTab && contextMenuTab.url &&
      contextMenuTab.url.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) {
    return contextMenuTab.id;
  }

  // Query ALL windows (type: 'app' covers PWA windows; type: 'normal' covers browser tabs)
  const allTabs = await chrome.tabs.query({});
  const chatTab = allTabs.find(t => t.url?.match(/^https:\/\/chat\.google\.com(?:\.mcas\.ms)?(?:\/|$)/));
  if (chatTab) return chatTab.id;

  const mailTab = allTabs.find(t => t.url?.match(/^https:\/\/mail\.google\.com(?:\.mcas\.ms)?(?:\/|$)/));
  if (mailTab) return mailTab.id;

  return null;
}

// Use scripting results for frame identity. MessageSender describes the sender,
// so a response to a background ping cannot tell us the receiver's frame ID.
async function inspectExportFrame() {
  if (!/^(chat|mail)\.google\.com(?:\.mcas\.ms)?$/.test(new URL(location.href).hostname)) return { supported: false };
  if (typeof loadSelectors === 'function') await loadSelectors();
  const health = typeof getExportHealth === 'function' ? getExportHealth() : {
    protocol: 0,
    inChatFrame: typeof isInChatFrame === 'function' && isInChatFrame()
  };
  return {
    ...health,
    supported: true,
    contentLoaded: typeof runExport === 'function',
    themeReady: typeof GCETheme !== 'undefined' && typeof GCETheme.bind === 'function',
    resultHostReady: typeof mountExportResult === 'function'
  };
}

async function prepareContentFrames(tabId) {
  const probe = () => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: inspectExportFrame });
  let frames = await probe();
  let injected = false;
  for (const { frameId, result } of frames) {
    if (!result?.supported || (result.contentLoaded && result.protocol !== CONTENT_PROTOCOL)) continue;
    const files = [];
    if (!result.themeReady) files.push('theme.js');
    if (!result.resultHostReady) files.push('result-host.js');
    if (!result.contentLoaded) files.push('content.js');
    if (!files.length) continue;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files });
    injected = true;
  }
  if (injected) frames = await probe();
  const ready = frames.find(({ result }) => result?.protocol === CONTENT_PROTOCOL && result.inChatFrame && result.themeReady && result.resultHostReady);
  if (ready) return { frameId: ready.frameId, ...ready.result };
  if (frames.some(({ result }) => result?.contentLoaded && result.protocol !== CONTENT_PROTOCOL && result.inChatFrame)) {
    throw new Error('Refresh the Chat tab to finish updating the extension.');
  }
  throw new Error('Open a conversation in Google Chat.');
}

async function ensureContentScript(tabId) {
  // A popup open and an export click may request preparation together.
  // Share the work so neither can redeclare scripts injected by the other.
  if (contentPreparations.has(tabId)) return contentPreparations.get(tabId);
  const pending = prepareContentFrames(tabId);
  contentPreparations.set(tabId, pending);
  try { return await pending; }
  finally { contentPreparations.delete(tabId); }
}

// PWA fallback stays in the extension's isolated world and uses the same
// acceptance/busy checks. A page-dispatched DOM event cannot start an export.
async function injectableExportTrigger(command) {
  if (typeof startExportRequest !== 'function') return { received: false };
  return startExportRequest(command);
}

// ── Settings ────────────────────────────────────────────────

async function getSettings() {
  try {
    const data = await chrome.storage.local.get('gceSettings');
    return data.gceSettings || { loadAll: true, includeMedia: true };
  } catch {
    return { loadAll: true, includeMedia: true };
  }
}

// ── TXT Packaging ───────────────────────────────────────────

function groupMessagesByThread(messages) {
  const groups = [];
  const threads = new Map();
  for (const msg of messages) {
    const id = msg.threadId || msg.parentMessageId;
    let group = id && threads.get(id);
    if (!group) {
      group = { id: id || '', messages: [], order: groups.length };
      groups.push(group);
      if (id) threads.set(id, group);
    }
    group.messages.push(msg);
  }
  for (const group of groups) {
    group.threaded = group.messages.some(msg => msg.parentMessageId);
    const undatedReplies = group.messages.filter(msg => msg.parentMessageId && !msg.absoluteTimestamp);
    group.messages = group.messages.filter(msg => !msg.parentMessageId || msg.absoluteTimestamp);
    group.messages.sort((a, b) => Number(!!a.parentMessageId) - Number(!!b.parentMessageId) ||
      (a.absoluteTimestamp && b.absoluteTimestamp ? a.absoluteTimestamp - b.absoluteTimestamp : 0));
    const parentCount = group.messages.filter(msg => !msg.parentMessageId).length;
    for (const msg of undatedReplies) {
      const next = msg.nextMessageId ? group.messages.findIndex(row => row.messageId === msg.nextMessageId) : -1;
      const previous = msg.previousMessageId ? group.messages.map(row => row.messageId).lastIndexOf(msg.previousMessageId) : -1;
      const position = next >= 0 ? next : previous >= 0 ? previous + 1 : group.messages.length;
      group.messages.splice(Math.max(parentCount, position), 0, msg);
    }
    group.timestamp = group.messages.find(msg => !msg.parentMessageId && msg.absoluteTimestamp)?.absoluteTimestamp ||
      group.messages.find(msg => msg.absoluteTimestamp)?.absoluteTimestamp || 0;
  }
  return groups.sort((a, b) => a.timestamp && b.timestamp ? a.timestamp - b.timestamp : a.order - b.order);
}

function threadFailureText(failure) {
  const reasons = {
    'thread-open-timeout': 'Thread did not open before the loading timeout',
    'reply-count-unreadable': 'Could not read the expected reply count',
    'collapsed-replies-stalled': 'Collapsed replies did not expand',
    'reply-count-mismatch': 'Fewer replies loaded than expected',
    'parent-not-loaded': 'The parent message was not captured in the thread',
    'traversal-limit': 'Thread traversal reached its safety limit',
    'read-error': 'Could not finish reading the thread'
  };
  return `Thread ${failure.threadId}: ${reasons[failure.reason] || 'Could not verify completeness'}. ` +
    `Replies captured: ${failure.capturedReplies ?? 'unknown'}; expected: ${failure.expectedReplies ?? 'unknown'}.` +
    (failure.error ? ` ${failure.error}` : '');
}

async function packageTxt({ conversationName, messages, exportDate, history }) {
  const name = conversationName || 'Google Chat';
  const line = '─'.repeat(60);
  const header = [
    '═'.repeat(60),
    '  GOOGLE CHAT EXPORT',
    '═'.repeat(60),
    '',
    `Chat:      ${name}`,
    `Messages:  ${messages.length}`,
    `Exported:  ${new Date(exportDate).toLocaleString()}`,
    ...(history?.threadsScanned ? [`Threads:   ${history.threadsScanned} scanned`] : []),
    ...(history?.warning ? [`Warning:   ${history.warning}`] : []),
    ...(history?.threadFailures || []).map(threadFailureText),
    ...(history?.since ? [`New since: ${new Date(history.since).toISOString()}`] : []),
    '',
    line,
    ''
  ].join('\n');

  let body = '';
  let lastDate = '';

  for (const group of groupMessagesByThread(messages)) {
    if (group.threaded) { body += `\n──────────── Thread ${group.id} ────────────\n`; lastDate = ''; }
    for (const msg of group.messages) {
      if (msg.date && msg.date !== lastDate) {
        body += `\n──────────── ${msg.date} ────────────\n\n`;
        lastDate = msg.date;
      }

      if (msg.contextOnly) body += '[Parent context from earlier history]\n';
      if (msg.parentMessageId) body += `[Reply to ${msg.parentMessageId}]\n`;
      body += `[${msg.timestamp || '—'}] ${msg.sender || 'Unknown'}: ${msg.text || ''}`;

      if (msg.media && msg.media.length > 0) {
        for (const m of msg.media) {
          const label = {
            image: `📷 Image: ${m.name || 'image'}`,
            gif:   `🎞️  GIF: ${m.name || 'sticker'}`,
            audio: `🎤 Voice message${m.durationMs ? ' (' + fmtDur(m.durationMs) + ')' : ''}`,
            video: `🎬 Video: ${m.name || 'video'}${m.durationMs ? ' (' + fmtDur(m.durationMs) + ')' : ''}`,
            file:  `📄 File: ${m.name || 'file'}`
          }[m.type] || `📎 Attachment: ${m.name || m.type}`;
          body += `\n  ${label}`;
        }
      }

      body += '\n';
    }
    if (group.threaded) { body += '\n──────────── End thread ────────────\n'; lastDate = ''; }
  }

  body += `\n${line}\nEnd of conversation — ${name}\n`;

  const fullText = header + body;
  const filename = `${sanitize(name)}_${dateStr()}.txt`;
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + b64EncodeUtf8(fullText);

  const downloadId = await triggerDownload(dataUrl, filename);
  return { filename, downloadId };
}

// ── Markdown Packaging ──────────────────────────────────────

async function packageMarkdown(payload) {
  const filename = `${sanitize(payload.conversationName)}_${dateStr()}.md`;
  const dataUrl = 'data:text/markdown;charset=utf-8;base64,' + b64EncodeUtf8(generateMarkdown(payload));
  const downloadId = await triggerDownload(dataUrl, filename);
  return { filename, downloadId };
}

function generateMarkdown({ conversationName, messages, exportDate, history }) {
  const lines = [
    `# ${escapeMarkdownLabel(conversationName || 'Google Chat')}`,
    '',
    `- Messages: ${messages.length}`,
    `- Exported: ${new Date(exportDate).toISOString()}`,
    ...(history?.threadsScanned ? [`- Threads scanned: ${history.threadsScanned}`] : []),
    ...(history?.since ? [`- New since: ${new Date(history.since).toISOString()}`] : []),
    ''
  ];
  if (history?.warning) lines.push(`> Warning: ${escapeMarkdownLabel(history.warning)}`, '');
  if (history?.threadFailures?.length) {
    lines.push('## Thread loading issues', '', ...history.threadFailures.map(failure => `- ${escapeMarkdownLabel(threadFailureText(failure))}`), '');
  }

  let lastDate = '';
  let previousThread = false;
  for (const group of groupMessagesByThread(messages)) {
    if (group.threaded) { lines.push(`## Thread ${escapeMarkdownLabel(group.id)}`, ''); lastDate = ''; }
    else if (previousThread && !group.messages[0]?.date) lines.push('## Messages', '');
    for (const msg of group.messages) {
      if (msg.date && msg.date !== lastDate) {
        lines.push(`${group.threaded ? '###' : '##'} ${escapeMarkdownLabel(msg.date)}`, '');
        lastDate = msg.date;
      }

      const absolute = new Date(msg.absoluteTimestamp);
      const timestamp = msg.absoluteTimestamp && Number.isFinite(absolute.getTime())
        ? absolute.toISOString() : msg.timestamp || 'Time unknown';
      lines.push(`${group.threaded ? '####' : '###'} ${escapeMarkdownLabel(msg.sender || 'Unknown')} — ${escapeMarkdownLabel(timestamp)}`, '');
      if (msg.messageId) lines.push(`- Message ID: ${escapeMarkdownLabel(msg.messageId)}`);
      if (msg.parentMessageId) lines.push(`- Reply to: ${escapeMarkdownLabel(msg.parentMessageId)}`);
      if (msg.contextOnly) lines.push('- Parent context from earlier history');
      if (msg.messageId || msg.parentMessageId || msg.contextOnly) lines.push('');

      if (msg.text) {
        // Preserve chat text literally, including HTML and nested code fences.
        const text = msg.text.replace(/\r\n?/g, '\n');
        const fenceLength = (text.match(/`+/g) || []).reduce((length, run) => Math.max(length, run.length + 1), 3);
        const fence = '`'.repeat(fenceLength);
        lines.push(`${fence}text`, text, fence, '');
      }

      for (const media of msg.media || []) {
        const type = { image: 'Image', gif: 'GIF', audio: 'Audio', video: 'Video', file: 'File' }[media.type] || 'Attachment';
        const name = escapeMarkdownLabel(media.name || media.type || 'attachment');
        const url = safeResourceUrl(media.url);
        const duration = media.durationMs ? ` (${fmtDur(media.durationMs)})` : '';
        lines.push(`- ${type}: ${url ? `[${name}](<${url}>)` : `${name} [unavailable]`}${duration}`);
      }
      if (msg.media?.length) lines.push('');
    }
    previousThread = group.threaded;
    if (group.threaded) lastDate = '';
  }

  return lines.join('\n');
}

function escapeMarkdownLabel(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]#!|~]/g, '\\$&');
}

// ── HTML + ZIP Packaging ────────────────────────────────────

async function packageHtml({ conversationName, messages, mediaFiles, exportDate, history }) {
  const name = conversationName || 'Google Chat';
  const zip = new JSZip();

  const htmlContent = generateHtml({ conversationName: name, messages, exportDate, history });
  const cssContent = generateCss();

  zip.file('index.html', htmlContent);
  zip.file('styles.css', cssContent);

  if (mediaFiles && mediaFiles.length > 0) {
    for (const file of mediaFiles) {
      zip.file(file.path, file.base64, { base64: true });
    }
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const filename = `${sanitize(name)}_${dateStr()}.zip`;
  const dataUrl = 'data:application/zip;base64,' + zipBase64;

  const downloadId = await triggerDownload(dataUrl, filename);
  return { filename, downloadId };
}

// ── HTML Generator ──────────────────────────────────────────

function generateHtml({ conversationName, messages, exportDate, history }) {
  let messagesHtml = '';
  let lastDate = '';
  let lastSender = '';

  for (const group of groupMessagesByThread(messages)) {
    if (group.threaded) {
      messagesHtml += `<section class="thread" data-thread-id="${esc(group.id)}"><h2 class="thread-title">Thread ${esc(group.id)}</h2>\n`;
      lastDate = '';
      lastSender = '';
    }
    for (const msg of group.messages) {
      if (msg.date && msg.date !== lastDate) {
        messagesHtml += `<div class="date-sep"><span>${esc(msg.date)}</span></div>\n`;
        lastDate = msg.date;
        lastSender = '';
      }

      const isSelf = msg.sender === 'You';
      const cls = isSelf ? 'msg msg-self' : 'msg msg-other';
      const showHeader = msg.sender !== lastSender;
      lastSender = msg.sender;

      let avatarHtml = '';
      if (showHeader) {
        const avatarUrl = safeResourceUrl(msg.avatarUrl);
        if (avatarUrl) {
          avatarHtml = `<img class="avatar" src="${esc(avatarUrl)}" alt="${esc(msg.sender)}" loading="lazy">`;
        } else {
          const initial = (msg.sender || '?').charAt(0).toUpperCase();
          avatarHtml = `<div class="avatar avatar-initial">${esc(initial)}</div>`;
        }
      } else {
        avatarHtml = `<div class="avatar-spacer"></div>`;
      }

      const senderHtml = showHeader ? `<div class="sender-name">${esc(msg.sender || 'Unknown')}</div>` : '';
      const timeHtml = msg.timestamp ? `<div class="time">${esc(msg.timestamp)}</div>` : '';

      let contentHtml = '';
      if (msg.text) {
        contentHtml += `<div class="bubble"><div class="text">${formatTextContent(msg.text)}</div>${timeHtml}</div>`;
      }

      if (msg.media && msg.media.length > 0) {
        for (const m of msg.media) {
          contentHtml += `<div class="media-card">${renderMediaHtml(m)}</div>`;
        }
      }

      if (!contentHtml) {
        contentHtml = `<div class="bubble"><div class="text empty">[Empty message]</div>${timeHtml}</div>`;
      }

      const context = msg.contextOnly ? '<div class="context-note">Parent context from earlier history</div>' : '';
      messagesHtml += `<div class="${cls}${msg.parentMessageId ? ' msg-reply' : ''}" data-message-id="${esc(msg.messageId || '')}" data-parent-message-id="${esc(msg.parentMessageId || '')}">${context}${senderHtml}<div class="msg-row">${avatarHtml}${contentHtml}</div></div>\n`;
    }
    if (group.threaded) { messagesHtml += '</section>\n'; lastDate = ''; lastSender = ''; }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(conversationName)} — Google Chat Export</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div class="chat">
  <header>
    <div class="header-icon">${getBrandLogoSvg(38)}</div>
    <div class="header-info">
      <h1>${esc(conversationName)}</h1>
      ${history?.since ? `<p>New since ${esc(new Date(history.since).toISOString())}</p>` : ''}
      ${history?.threadsScanned ? `<p>${history.threadsScanned} threads scanned</p>` : ''}
      ${history?.warning ? `<p>${esc(history.warning)}</p>` : ''}
      ${history?.threadFailures?.length ? `<details><summary>Thread loading issues</summary><ul>${history.threadFailures.map(failure => `<li>${esc(threadFailureText(failure))}</li>`).join('')}</ul></details>` : ''}
      <p>${messages.length} messages &middot; Exported ${new Date(exportDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
  </header>
  <div class="messages">${messagesHtml}</div>
</div>
</body>
</html>`;
}

function renderMediaHtml(m) {
  const localPath = safeResourceUrl(m._localPath);
  const url = safeResourceUrl(m.url);
  const src = esc(localPath || url);
  const name = esc(m.name || 'file');

  if (!src) {
    return `<div class="media-item media-file"><span class="file-chip"><span class="file-icon">${fileTypeIcon(m.name)}</span><span class="file-name">${name} [unavailable]</span></span></div>`;
  }

  switch (m.type) {
    case 'image':
    case 'gif':
      return `<div class="media-item media-image">
  <a href="${src}" target="_blank" rel="noopener noreferrer"><img src="${src}" alt="${name}" loading="lazy"></a>
</div>`;

    case 'audio': {
      const dur = m.durationMs ? fmtDur(m.durationMs) : '';
      return `<div class="media-item media-audio">
  <div class="audio-chip">
    <svg class="audio-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
    <span class="audio-label">Voice message${dur ? ' &middot; ' + dur : ''}</span>
    <a class="dl-link" href="${src}" download="${name}" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>
  </div>
  <audio controls preload="metadata"><source src="${src}" type="${esc(m.mimeType || 'audio/mpeg')}"></audio>
</div>`;
    }

    case 'video': {
      const dur = m.durationMs ? fmtDur(m.durationMs) : '';
      return `<div class="media-item media-video">
  <video controls preload="metadata" playsinline><source src="${src}" type="${esc(m.mimeType || 'video/mp4')}"></video>
  <div class="video-label">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>
    <span>${name}${dur ? ' &middot; ' + dur : ''}</span>
    <a class="dl-link" href="${src}" download="${name}" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>
  </div>
</div>`;
    }

    default:
      return `<div class="media-item media-file">
  <a class="file-chip" href="${src}" download="${name}">
    <span class="file-icon">${fileTypeIcon(m.name)}</span>
    <span class="file-name">${name}</span>
    <svg class="dl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
  </a>
</div>`;
  }
}

function fileTypeIcon(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  const icons = {
    pdf:  '📕', doc: '📘', docx: '📘',
    xls:  '📗', xlsx: '📗',
    ppt:  '📙', pptx: '📙',
    zip:  '🗜️', rar: '🗜️',
    txt:  '📄', csv: '📊',
    png:  '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🎞️', webp: '🖼️',
    mp3:  '🎵', wav: '🎵', m4a: '🎵',
    mp4:  '🎬', mov: '🎬', avi: '🎬'
  };
  return icons[ext] || '📎';
}

function getBrandLogoSvg(size = 36) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="512" height="512" rx="40" fill="#f8f9fa"/>
  <g transform="translate(56, 56) scale(1.25)">
    <path d="M76.37 0.51l0.01 76.47L0 76.96V20.77c0.567-3.973 1.743-7.31 3.53-10.01C7.937 4.08 14.343 0.717 22.75 0.67 40.523 0.577 58.397 0.523 76.37 0.51z" fill="#0066da"/>
    <path d="M76.37 0.51l157.42 0.02c0.332 0 0.653 0.101 0.92 0.29l0.37 0.27c-0.107 0.04-0.197 0.083-0.27 0.13a0.297 0.297 0 00-0.17 0.28l-0.02 75.51H76.41l-0.03-0.03L76.37 0.51z" fill="#fbbc04"/>
    <path d="M235.08 1.09l75.45 75.68-75.91 0.24 0.02-75.51c0-0.127 0.057-0.22 0.17-0.28 0.073-0.047 0.163-0.09 0.27-0.13z" fill="#ea4335"/>
    <path d="M0 76.96l76.38 0.02 0.03 0.03 0.02 105.68L0 182.67V76.96z" fill="#2684fc"/>
    <path d="M310.53 76.77l0.47 0.34v161.9c-1.773 9.687-6.793 15.943-15.06 18.77-2.947 1.013-7.29 1.513-13.03 1.5-37.26-0.06-74.9-0.117-112.92-0.17-5.52-0.007-11.12 0.033-16.8 0.12-0.313 0.007-0.58 0.12-0.8 0.34a15823.329 15823.329 0 00-56 56.02c-2.87 2.89-6.12 4.5-10.24 3.89-3.84-0.567-6.67-2.547-8.49-5.94-0.767-1.44-1.157-4.067-1.17-7.88-0.047-15.46-0.063-30.97-0.05-46.53l-0.01-38.28 37.78-37.78c0.332-0.333 0.786-0.52 1.26-0.52l118.3 0.04c0.455 0 0.83-0.375 0.83-0.83l-0.03-104.75h0.05l75.91-0.24z" fill="#00ac47"/>
    <path d="M76.43 182.69v38.16l0.01 38.28c-15.98 0.093-31.823 0.123-47.53 0.09-6.547-0.013-11.263-0.527-14.15-1.54-8.093-2.827-13.013-9.093-14.76-18.8v-56.21l76.43 0.02z" fill="#00832d"/>
  </g>
  <circle cx="380" cy="380" r="90" fill="#ffffff" />
  <circle cx="380" cy="380" r="85" fill="#ffffff" stroke="#e8eaed" stroke-width="5" />
  <g transform="translate(345, 325)">
    <path d="M35,0 L35,65" stroke="#1a73e8" stroke-width="18" stroke-linecap="round" />
    <path d="M5,40 L35,70 L65,40" stroke="#1a73e8" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" fill="none" />
    <rect x="5" y="85" width="60" height="12" rx="6" fill="#34a853" />
  </g>
</svg>`;
}

function generateCss() {
  return `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f9;color:#202124;line-height:1.5}
.chat{max-width:760px;margin:0 auto;background:#fff;min-height:100vh;border-left:1px solid #dadce0;border-right:1px solid #dadce0;box-shadow:0 1px 6px rgba(0,0,0,0.08)}
header{padding:20px 24px;border-bottom:1px solid #dadce0;position:sticky;top:0;background:#fff;z-index:10;display:flex;align-items:center;gap:14px}
.header-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0}
.header-icon svg{border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.1)}
header h1{font-size:17px;font-weight:600;color:#202124}
header p{font-size:12px;color:#5f6368;margin-top:2px}
.messages{padding:16px 24px;display:flex;flex-direction:column;gap:2px}
.thread{margin:12px 0;padding:12px;border:1px solid #dadce0;border-radius:12px}
.thread-title{font-size:12px;font-weight:500;color:#5f6368;overflow-wrap:anywhere}
.msg-reply{margin-left:12px;padding-left:12px;border-left:2px solid #d2e3fc}
.context-note{font-size:11px;color:#5f6368;margin-top:8px}
.date-sep{text-align:center;margin:20px 0 12px}
.date-sep span{background:#e8eaed;padding:4px 16px;font-size:11px;color:#5f6368;border-radius:16px;font-weight:500;letter-spacing:.3px}
.msg{display:flex;flex-direction:column;margin-bottom:2px}
.msg-self{align-items:flex-end}
.msg-other{align-items:flex-start}
.sender-name{font-size:11.5px;font-weight:600;margin-bottom:3px;margin-top:12px}
.msg-self .sender-name{text-align:right;padding-right:44px;color:#1967d2}
.msg-other .sender-name{text-align:left;padding-left:44px;color:#3c4043}
.msg-row{display:flex;align-items:flex-end;gap:8px;max-width:78%}
.msg-self .msg-row{flex-direction:row-reverse}
.avatar{width:30px;height:30px;border-radius:50%;flex-shrink:0;object-fit:cover;align-self:flex-end;border:1px solid #e8eaed}
.avatar-initial{width:30px;height:30px;border-radius:50%;flex-shrink:0;background:#5f6368;color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;align-self:flex-end}
.msg-self .avatar-initial{background:#1a73e8}
.avatar-spacer{width:30px;flex-shrink:0}
.bubble{padding:9px 14px;position:relative;word-wrap:break-word;flex:0 1 auto;min-width:0;border-radius:20px}
.msg-self .bubble{background:#d3e3fd;border-radius:20px 4px 4px 20px}
.msg-other .bubble{background:#f1f3f4;border-radius:4px 20px 20px 4px}
.text{font-size:14px;line-height:1.55;color:#202124;white-space:pre-wrap}
.text a{color:#1a73e8;text-decoration:none}.text a:hover{text-decoration:underline}
.text.empty{font-style:italic;color:#80868b;font-size:12px}
.time{font-size:10px;color:#80868b;margin-top:4px}
.msg-self .time{text-align:right}
.media-card{overflow:hidden;flex:0 1 auto;min-width:0;border-radius:12px;border:1px solid #e0e0e0;background:#fafafa}
.msg-self .media-card{border-radius:16px 4px 4px 16px}
.msg-other .media-card{border-radius:4px 16px 16px 4px}
.media-item{margin:0}
.media-image img{max-width:100%;max-height:300px;display:block;object-fit:cover;cursor:pointer;transition:opacity .2s}.media-image img:hover{opacity:.9}
.media-image a{display:block;text-decoration:none}
.media-audio{display:flex;flex-direction:column;gap:6px;padding:12px 14px}
.audio-chip{display:flex;align-items:center;gap:8px;color:#1a73e8;font-size:13px;font-weight:500}
.audio-icon{flex-shrink:0;color:#1a73e8}
audio{width:100%;height:34px;border-radius:17px;margin-top:4px}
.media-video video{width:100%;max-width:320px;display:block;background:#000}
.video-label{display:flex;align-items:center;gap:6px;padding:7px 12px;font-size:12px;color:#5f6368}
.video-label svg{flex-shrink:0}
.dl-link{display:inline-flex;align-items:center;color:#80868b;margin-left:auto;padding:4px;border-radius:4px;transition:color .15s}.dl-link:hover{color:#1a73e8}
.media-file{margin:0}
.file-chip{display:flex;align-items:center;gap:10px;padding:12px 14px;font-size:13px;color:#3c4043;text-decoration:none;transition:background .15s}
.file-chip:hover{background:#f8f9fa}
.file-icon{font-size:18px;flex-shrink:0}
.file-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.dl-icon{flex-shrink:0;color:#5f6368;margin-left:auto}
@media(max-width:600px){.chat{border:none;box-shadow:none}.msg-row{max-width:94%}}`;
}

// ── Media Fetch (background-side, bypasses CORS) ────────────

async function fetchMediaAsBase64(url, signal) {
  const strategies = [
    () => fetch(url, { credentials: 'include', signal }),
    () => fetch(url, { credentials: 'omit', signal }),
    () => fetch(url, { redirect: 'follow', credentials: 'include', signal })
  ];

  for (const strategy of strategies) {
    signal?.throwIfAborted();
    try {
      const resp = await strategy();
      if (resp.ok) {
        const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0) continue;
        return { success: true, base64: arrayBufToBase64(buf), mimeType };
      }
    } catch {
      signal?.throwIfAborted();
      // try next strategy
    }
  }
  return { success: false, error: 'All fetch strategies failed' };
}

function arrayBufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i += 32768) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}

// ── Utilities ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sanitize(str) {
  return (str || 'chat').replace(/[^a-z0-9\-_]/gi, '_').substring(0, 60);
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeResourceUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';

  if (/^media\/[a-zA-Z0-9._/-]+$/.test(candidate) &&
      !candidate.split('/').includes('..')) {
    return candidate;
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function formatTextContent(text) {
  let t = esc(text);
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
  const binary = atob(parts[1]);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function revokeLater(url) {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  const timer = setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch {}
  }, 60000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function triggerDownload(dataUrl, filename) {
  let downloadUrl = dataUrl;
  let objectUrlToRevoke = null;

  // Firefox rejects data: URLs in downloads.download with "Access denied for URL data:...".
  // Convert data: URL to a blob: URL when running in Firefox or when Blob/URL.createObjectURL is supported.
  const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
  if (isFirefox && typeof dataUrl === 'string' && dataUrl.startsWith('data:') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
    try {
      const blob = dataUrlToBlob(dataUrl);
      downloadUrl = URL.createObjectURL(blob);
      objectUrlToRevoke = downloadUrl;
    } catch (e) {
      console.warn('[GCE] Failed to create blob URL, falling back to data URL:', e);
    }
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: downloadUrl, filename, saveAs: false }, (dlId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // If data URL was rejected by the browser, attempt blob URL conversion and retry
        if (!objectUrlToRevoke && typeof dataUrl === 'string' && dataUrl.startsWith('data:') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
          try {
            const blob = dataUrlToBlob(dataUrl);
            const retryBlobUrl = URL.createObjectURL(blob);
            chrome.downloads.download({ url: retryBlobUrl, filename, saveAs: false }, (retryId) => {
              if (chrome.runtime.lastError) {
                try { URL.revokeObjectURL(retryBlobUrl); } catch {}
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                revokeLater(retryBlobUrl);
                resolve(retryId);
              }
            });
            return;
          } catch { /* proceed to original rejection */ }
        }
        if (objectUrlToRevoke) {
          try { URL.revokeObjectURL(objectUrlToRevoke); } catch {}
        }
        reject(new Error(err.message));
      } else {
        if (objectUrlToRevoke) {
          revokeLater(objectUrlToRevoke);
        }
        resolve(dlId);
      }
    });
  });
}
