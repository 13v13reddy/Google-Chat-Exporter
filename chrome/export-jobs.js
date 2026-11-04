// Background-owned export status. Only metadata is retained, never chat bodies.
'use strict';

const ExportJobs = (() => {
  const KEY = 'gceExportJobs';
  const WINDOWS_KEY = 'gceCollectionWindows';
  let collectionWindows = {};
  const owned = new Set();
  let queue = Promise.resolve();
  const active = job => job.state === 'working' || job.state === 'paused';
  const needsPage = job => active(job) && !['packaging', 'download'].includes(job.phase);
  const validId = id => typeof id === 'string' && /^job-[a-zA-Z0-9-]{1,96}$/.test(id);
  const sameOwner = (job, sender) => job && job.tabId === sender.tab?.id && job.frameId === (sender.frameId || 0);

  function serial(work) {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }

  async function read() { return (await chrome.storage.local.get(KEY))[KEY] || {}; }

  async function readWindows() {
    return chrome.storage.session ? (await chrome.storage.session.get(WINDOWS_KEY))[WINDOWS_KEY] || {} : collectionWindows;
  }

  async function saveWindows(windows) {
    if (chrome.storage.session) await chrome.storage.session.set({ [WINDOWS_KEY]: windows });
    else collectionWindows = windows;
  }

  async function isCollectionTab(tabId) {
    if (!Number.isInteger(tabId)) return false;
    return Object.values(await readWindows()).some(window => window.tabId === tabId);
  }

  async function closeCollection(job) {
    const windows = await readWindows();
    const window = windows[job.jobId];
    // Session ownership prevents a retained job from closing a reused tab ID
    // after a browser restart. Close the helper tab, never an entire window.
    if (!window || window.tabId !== job.tabId || window.windowId !== job.collectionWindowId) return;
    const tab = await chrome.tabs.get(window.tabId).catch(() => null);
    if (tab?.windowId === window.windowId) await chrome.tabs.remove(window.tabId);
    if (window.layout) {
      const { windowId, original, arranged } = window.layout;
      const current = await chrome.windows.get(windowId).catch(() => null);
      // Restore only our own arrangement; preserve subsequent user resizing.
      if (current?.state === 'normal' && Object.keys(arranged).every(key => current[key] === arranged[key])) {
        await chrome.windows.update(windowId, original.state === 'maximized'
          ? { state: 'maximized' } : { ...original, state: 'normal' });
      }
    }
    delete windows[job.jobId];
    await saveWindows(windows);
  }

  async function updateBadge(jobs) {
    jobs ||= await read();
    const all = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
    const job = all.find(active) || all.find(item => !item.acknowledged);
    const store = chrome.storage.session || chrome.storage.local;
    const mode = (await store.get('gceExportMode')).gceExportMode;
    const auto = mode?.enabled && Date.now() - mode.lastActivity <= 10 * 60 * 1000;
    const text = job && active(job) ? (job.state === 'paused' ? 'WAIT' : job.phase === 'download' ? 'SAVE' : 'RUN')
      : job?.state === 'error' ? 'ERR' : auto ? 'AUTO' : job ? 'DONE' : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: text === 'ERR' ? '#b3261e' : text === 'DONE' ? '#188038' : '#1a73e8' });
    await chrome.action.setTitle?.({ title: job ? `Google Chat Exporter: ${job.text}` : 'Google Chat Exporter' });
  }

  async function save(jobs, changed) {
    // Bound retained results while keeping every in-flight export.
    const recent = Object.values(jobs).filter(job => !active(job)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    const keep = new Set(recent.map(job => job.jobId));
    for (const [id, job] of Object.entries(jobs)) if (!active(job) && !keep.has(id)) delete jobs[id];
    await chrome.storage.local.set({ [KEY]: jobs });
    await updateBadge(jobs);
    if (changed) {
      chrome.runtime.sendMessage({ action: 'exportJobUpdate', job: changed }).catch(() => {});
      if (Number.isInteger(changed.sourceTabId)) {
        chrome.tabs.sendMessage(changed.sourceTabId, { action: 'exportJobUpdate', job: changed },
          { frameId: changed.sourceFrameId }).catch(() => {});
      }
      if (changed.collectionWindowId !== undefined && (!active(changed) || ['packaging', 'download'].includes(changed.phase))) {
        await closeCollection(changed).catch(error => console.warn('[GCE] Could not close export window:', error));
      }
    }
  }

  function revise(job, update) {
    return { ...job, ...update, updatedAt: Date.now(), revision: (job.revision || 0) + 1 };
  }

  function createCollection(jobId, details, placement = null) {
    owned.add(jobId);
    return serial(async () => {
      const jobs = await read();
      if (jobs[jobId]) throw new Error('This export request was already started.');
      if (Object.values(jobs).some(job => active(job) && job.collectionWindowId !== undefined &&
        Number.isInteger(details.sourceWindowId) && job.sourceWindowId === details.sourceWindowId)) {
        throw new Error('An export is already running in this window. Finish or cancel it first.');
      }
      const windows = await readWindows();
      windows[jobId] = { tabId: details.tabId, windowId: details.collectionWindowId, ...placement };
      await saveWindows(windows);
      jobs[jobId] = revise({ jobId, ...details, frameId: 0, startedAt: Date.now() }, {
        state: 'working', phase: 'opening', text: 'Opening export window…', percent: 1
      });
      await save(jobs, jobs[jobId]);
    });
  }

  function arrangeCollection(jobId) {
    return serial(async () => {
      const windows = await readWindows();
      const window = windows[jobId];
      if (!window) throw new Error('Export cancelled.');
      if (window.layout) {
        const actual = await chrome.windows.update(window.layout.windowId, { ...window.layout.arranged, state: 'normal' });
        const { left, top, width, height } = actual;
        window.layout.arranged = { left, top, width, height };
        await saveWindows(windows);
      }
      if (window.helper) await chrome.windows.update(window.windowId, { ...window.helper, focused: false });
    });
  }

  function prepareCollection(jobId, frameId) {
    return serial(async () => {
      const jobs = await read();
      const job = jobs[jobId];
      if (!active(job || {}) || job.phase !== 'opening') throw new Error('Export cancelled.');
      jobs[jobId] = revise(job, { frameId });
      await save(jobs, jobs[jobId]);
    });
  }

  async function collectionPending(jobId) {
    const job = (await read())[jobId];
    return active(job || {}) && job.phase === 'opening';
  }

  function failCollection(jobId, error) {
    owned.delete(jobId);
    return serial(async () => {
      const jobs = await read();
      const job = jobs[jobId];
      if (!active(job || {})) return;
      jobs[jobId] = revise(job, { state: 'error', phase: 'failed', text: `Export failed: ${error}`, percent: 0 });
      await save(jobs, jobs[jobId]);
    });
  }

  function progress(msg, sender) {
    if (!validId(msg.jobId) || !Number.isInteger(sender.tab?.id)) return Promise.resolve({ success: false });
    return serial(async () => {
      const jobs = await read();
      const old = jobs[msg.jobId];
      const finalReport = old?.phase === 'interrupted' && !Number.isSafeInteger(old.downloadId) && ['done', 'error'].includes(msg.state);
      if (old && (!sameOwner(old, sender) || (!active(old) && !finalReport))) return { success: false };
      // Once handed to the background, only native download events decide success.
      if (old && ['packaging', 'download'].includes(old.phase)) return { success: true };
      const state = ['working', 'paused', 'done', 'error'].includes(msg.state) ? msg.state : 'working';
      const job = revise(old || { jobId: msg.jobId, tabId: sender.tab.id, frameId: sender.frameId || 0, startedAt: Date.now() }, {
        state, phase: String(msg.phase || 'history'), text: String(msg.text || ''),
        percent: Math.max(0, Math.min(100, Number(msg.percent) || 0)),
        conversationName: String(msg.conversationName || old?.conversationName || 'Google Chat')
      });
      jobs[job.jobId] = job;
      await save(jobs, job);
      return { success: true };
    });
  }

  function beginPackaging(jobId, sender) {
    if (!validId(jobId)) return Promise.resolve(); // Older content scripts remain compatible.
    owned.add(jobId);
    return serial(async () => {
      const jobs = await read();
      const job = jobs[jobId];
      if (!sameOwner(job, sender) || !active(job)) { owned.delete(jobId); throw new Error('Export is no longer active. Please retry.'); }
      jobs[jobId] = revise(job, { phase: 'packaging', state: 'working', text: 'Packaging export...', percent: 88 });
      await save(jobs, jobs[jobId]);
    });
  }

  async function reconcile(jobs, job) {
    const [download] = await chrome.downloads.search({ id: job.downloadId });
    const complete = download?.state === 'complete';
    const saving = download?.state === 'in_progress';
    const state = complete ? 'done' : saving ? 'working' : 'error';
    const phase = complete ? 'complete' : saving ? 'download' : 'interrupted';
    if (job.state === state && job.phase === phase) return job;
    jobs[job.jobId] = revise(job, { state, phase, percent: complete ? 100 : saving ? 95 : job.percent,
      text: complete ? `Export saved: ${job.filename}` : saving ? 'Saving export...' : 'Download interrupted. Please retry the export.' });
    await save(jobs, jobs[job.jobId]);
    return jobs[job.jobId];
  }

  function downloaded(jobId, sender, result, warning = '') {
    if (!validId(jobId)) return Promise.resolve();
    return serial(async () => {
      const jobs = await read();
      const job = jobs[jobId];
      if (!sameOwner(job, sender)) return;
      jobs[jobId] = revise(job, { state: 'working', phase: 'download', percent: 95,
        text: 'Saving export...', downloadId: result.downloadId, filename: result.filename, warning });
      await save(jobs, jobs[jobId]);
      await reconcile(jobs, jobs[jobId]); // Completion can beat downloads.onChanged.
      owned.delete(jobId);
    });
  }

  function failed(jobId, sender, error) {
    if (!validId(jobId)) return Promise.resolve();
    owned.delete(jobId);
    return serial(async () => {
      const jobs = await read();
      const job = jobs[jobId];
      if (!sameOwner(job, sender) || !active(job)) return;
      jobs[jobId] = revise(job, { state: 'error', phase: 'failed', text: `Export failed: ${error}`, percent: 0 });
      await save(jobs, jobs[jobId]);
    });
  }

  function interruptTab(tabId, loading = false) {
    return serial(async () => {
      const jobs = await read();
      for (const job of Object.values(jobs)) {
        if (job.tabId !== tabId || !needsPage(job) || (loading && job.phase === 'opening')) continue;
        jobs[job.jobId] = revise(job, { state: 'error', phase: 'interrupted',
          text: 'Export interrupted: the Chat tab was closed, reloaded, or discarded. Please retry.' });
        await save(jobs, jobs[job.jobId]);
      }
    });
  }

  async function messagePage(job, message) {
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(job.tabId, message, { frameId: job.frameId }),
        new Promise(resolve => { timer = setTimeout(() => resolve({ suspended: true }), 1500); })
      ]);
    } finally { clearTimeout(timer); }
  }

  function recover() {
    return serial(async () => {
      const jobs = await read();
      for (const original of Object.values(jobs)) {
        let job = original;
        if (Number.isSafeInteger(job.downloadId)) {
          await reconcile(jobs, job);
          continue;
        }
        if (!active(job) || owned.has(job.jobId)) continue;
        try {
          const tab = await chrome.tabs.get(job.tabId);
          if (!tab || tab.discarded || ['opening', 'packaging'].includes(job.phase)) throw new Error('Context lost');
          const reply = await messagePage(job, { action: 'getExportJob', jobId: job.jobId });
          if (reply?.suspended) {
            job = revise(job, { state: 'paused', text: job.collectionWindowId === undefined
              ? 'Waiting for Chat. Return to its tab to resume.' : 'Waiting for the export window. Choose Show export to resume.' });
          } else if (reply?.jobId !== job.jobId) throw new Error('Context lost');
          else if (['done', 'error'].includes(reply.state)) {
            job = revise(job, { state: reply.state, phase: reply.phase, text: reply.text, percent: reply.percent });
          }
          else if (['working', 'paused'].includes(reply.state) && reply.state !== job.state) {
            job = revise(job, { state: reply.state, text: reply.text || job.text, percent: reply.percent ?? job.percent });
          } else continue;
        } catch {
          job = revise(job, { state: 'error', phase: 'interrupted', text: 'Export interrupted: its Chat session ended. Please retry.' });
        }
        jobs[job.jobId] = job;
        await save(jobs, job);
      }
      await updateBadge(jobs);
      return { jobs: Object.values(jobs) };
    });
  }

  function handleMessage(msg, sender) {
    if (msg.action === 'exportStateUpdate' && msg.jobId) return progress(msg, sender);
    if (msg.action === 'getExportJobs') return recover();
    if (!['acknowledgeExportJob', 'focusExportJob', 'cancelExportJob'].includes(msg.action)) return null;
    return serial(async () => {
      const jobs = await read();
      const job = jobs[msg.jobId];
      if (!job) return { success: false };
      if (msg.action === 'acknowledgeExportJob') {
        if (active(job) && job.phase !== 'download') return { success: false };
        jobs[job.jobId] = revise(job, { acknowledged: true });
        await save(jobs, jobs[job.jobId]);
      } else if (msg.action === 'focusExportJob') {
        const tab = await chrome.tabs.update(job.tabId, { active: true });
        const update = { focused: true };
        if (job.collectionWindowId !== undefined) update.state = 'normal';
        if (tab.windowId !== undefined) await chrome.windows?.update(tab.windowId, update);
      } else {
        if (!needsPage(job)) return { success: false, error: 'This export has already been handed off for saving.' };
        if (job.phase === 'opening') {
          owned.delete(job.jobId);
          jobs[job.jobId] = revise(job, { state: 'error', phase: 'cancelled', text: 'Export cancelled.', percent: 0 });
          await save(jobs, jobs[job.jobId]);
          return { success: true };
        }
        const reply = await messagePage(job, { action: 'cancelExportJob', jobId: job.jobId });
        return { success: reply?.success === true };
      }
      return { success: true };
    });
  }

  chrome.downloads.onChanged.addListener(delta => {
    if (!delta.state) return;
    serial(async () => {
      const jobs = await read();
      for (const job of Object.values(jobs)) if (job.downloadId === delta.id) await reconcile(jobs, job);
    }).catch(console.error);
  });
  chrome.tabs.onRemoved?.addListener(tabId => interruptTab(tabId).catch(console.error));
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.status === 'loading' || change.discarded) interruptTab(tabId, !change.discarded).catch(console.error);
  });

  return { handleMessage, beginPackaging, downloaded, failed, recover, updateBadge,
    createCollection, arrangeCollection, prepareCollection, collectionPending, failCollection, isCollectionTab,
    async getJob(jobId) { return (await read())[jobId]; },
    collectionStarted(jobId) { owned.delete(jobId); } };
})();
