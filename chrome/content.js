// ============================================================
// Google Chat Exporter v2.1 — content.js
// Runs in Google Chat tabs (normal, Gmail-embedded, PWA/app window)
// 100% private: all extraction is local, zero external requests
// ============================================================

'use strict';

// ── Selector Configuration ──────────────────────────────────
// Loaded from selectors.json; populated on init
let SEL = null;
const CHAT_HOSTS = ['chat.google.com', 'mail.google.com', 'chat.google.com.mcas.ms', 'mail.google.com.mcas.ms'];

async function loadSelectors() {
  if (SEL) return SEL;
  try {
    const url = chrome.runtime.getURL('selectors.json');
    const resp = await fetch(url);
    SEL = await resp.json();
  } catch (err) {
    console.error('[GCE] Failed to load selectors.json, using inline fallback:', err);
    // Inline fallback so the extension still works even if resource load fails
    SEL = {
      frameName: 'single_full_screen',
      scrollContainers: ['.Bl2pUd','[role="main"]','div[data-is-scroll-wrapper="true"]','[data-conversation-container]'],
      messageGroups: 'div.nF6pT',
      deletedMessage: 'div.Ao1xUb[role="group"][data-id]',
      mainMessages: '.Bl2pUd',
      threadOpen: 'div.CYx15d[role="button"]',
      threadScroll: '.lFJYcb[jsname="sGWpWe"]',
      threadPanel: '.hSo9Ub',
      threadClose: '.DaIyce[jsname="TvD9Pc"] button',
      collapsedMessages: '[data-collapsed-count][role="button"]',
      topicContainer: '[data-topic-id]',
      messageText: 'div.DTp27d[jsname="bgckF"], div.DTp27d.Zc1Emd, div.GDhqjd, div.vdlEi',
      senderNameText: 'span.njhDLd, span.zX8Xib',
      senderNameAttr: 'span.ZTmjQb[data-name]',
      timestamp: 'span.FvYVyf, span.ud0FPb, [data-absolute-timestamp]',
      absoluteTimestampAttr: '[data-absolute-timestamp]',
      dateSeparator: 'div.Ao1xUb[role="heading"]',
      imageChip: 'div.avsS6d',
      imageImg: 'img.HQLhSc',
      imageButton: '.SMTuwf[data-action="7"]',
      gifChip: 'div.T0oWF',
      audioPlayer: '[data-media-type="audio"]',
      videoPlayer: '[data-media-type="video"]',
      fileChip: 'div.lRPruf',
      fileName: 'span.RhNmFb',
      fileButton: '[data-action="7"][title]',
      fileThumb: 'img.INRavc',
      videoLabel: '[aria-label^="Video,"]',
      avatarImg: 'img.hy2WD',
      avatarContainer: '.HTZBof',
      chipParentItem: 'li',
      chipWrapperFallback: '.V5MAMb',
      downloadAnchorGeneric: 'a[href*="DOWNLOAD_URL"]',
      chipDownloadAnchor: '.zeIMme a[href*="DOWNLOAD_URL"]',
      noiseSelectors: ['[aria-hidden="true"]','[role="tooltip"]','.R7SUqc','.UgwGlb'],
      conversationTitle: ['header.QHAzdb[aria-label]','[role="main"][aria-label]','span.mUIrbf-vQzf8d','div.nfJ0Zd','h1'],
      fallbackScrollable: 'div',
      attrs: {
        absoluteTimestamp: 'data-absolute-timestamp',
        groupId: 'data-id',
        topicId: 'data-topic-id',
        senderName: 'data-name',
        mediaUrl: 'data-media-url',
        mediaDuration: 'data-media-duration-ms',
        mediaSourceType: 'data-media-source-type',
        ariaLabel: 'aria-label',
        title: 'title',
        href: 'href'
      }
    };
  }
  return SEL;
}

// ── Frame Detection ─────────────────────────────────────────

function isInChatFrame() {
  if (!SEL) return false;
  if (window.name === SEL.frameName) return true;
  // Generic scroll containers such as [role="main"] also match Gmail inboxes.
  return [SEL.mainMessages, SEL.messageGroups, SEL.deletedMessage]
    .some(selector => selector && document.querySelector(selector));
}

function getExportHealth() {
  const inChatFrame = isInChatFrame();
  return {
    protocol: 2, alive: true, inChatFrame,
    name: inChatFrame ? getConversationName() : '',
    conversationUrl: inChatFrame ? conversationHrefFromPage() : '',
    conversationScope: inChatFrame ? checkpointScopeFromPage('txt', false) : '',
    display: typeof screen === 'object' ? { left: screen.availLeft || 0, top: screen.availTop || 0,
      width: screen.availWidth, height: screen.availHeight } : null,
    themeReady: typeof GCETheme !== 'undefined' && typeof GCETheme.bind === 'function',
    resultHostReady: typeof mountExportResult === 'function'
  };
}

// ── Progress Overlay ────────────────────────────────────────

let progressEl = null;
let exportInProgress = false;
let exportController = null;
let progressCleanup = null;
let progressThemeCleanup = null;
let progressIsResult = false;
let progressHideTimer = null;
let progressJobId = null;
let exportJobId = null;
let exportPhase = 'idle';
let exportName = '';
let exportInWindow = false;
let mirroredExportJob = null;
let lastExportProgress = { text: '', percent: 0, state: 'working' };
let lastExportReport = null;

function bindProgressTheme(element) {
  if (typeof GCETheme === 'undefined' || typeof GCETheme.bind !== 'function') {
    element.setAttribute('data-gce-theme', 'light');
    return () => {};
  }
  return GCETheme.bind(element);
}

function showProgress(text, percent, state = 'working') {
  lastExportProgress = { text, percent, state };
  if (exportJobId) lastExportReport = { jobId: exportJobId, phase: exportPhase, ...lastExportProgress };
  progressJobId = exportJobId;
  try {
    renderProgress(text, percent, state);
  } catch (error) {
    console.warn('[GCE] Progress notification unavailable:', error);
    try { hideProgress(); } catch { progressEl = null; }
  }
  // Status delivery must not depend on the Chat page accepting our overlay.
  try {
    chrome.runtime.sendMessage({ action: 'exportStateUpdate', text, percent, state,
      jobId: exportJobId, phase: exportPhase, conversationName: exportName }).catch(() => {});
  } catch { /* The extension may have been reloaded. */ }
}

function renderProgress(text, percent, state) {
  if (progressIsResult) hideProgress();
  clearTimeout(progressHideTimer);
  progressHideTimer = null;
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.id = 'gce-progress';

    const style = document.createElement('style');
    style.textContent = `
      #gce-progress {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        font-family: 'Google Sans', Roboto, sans-serif;
        pointer-events: auto;
        color: var(--gce-text);
        --gce-surface:#fff; --gce-text:#3c4043; --gce-line:#e0e0e0;
        --gce-muted:#80868b; --gce-hover:#f1f3f4; --gce-accent:#1a73e8;
        --gce-success:#34a853; --gce-error:#ea4335;
        width:320px; max-width:calc(100vw - 48px);
      }
      #gce-progress .gce-card {
        background: var(--gce-surface);
        border-radius: 14px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.08);
        width: 100%;
        overflow: hidden;
        animation: gce-slide-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      @keyframes gce-slide-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      #gce-progress .gce-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 10px;
      }
      #gce-progress .gce-spinner {
        width: 18px;
        height: 18px;
        border: 2.5px solid #e0e0e0;
        border-top-color: #1a73e8;
        border-radius: 50%;
        animation: gce-spin 0.7s linear infinite;
        flex-shrink: 0;
        transition: border-color 0.3s;
      }
      #gce-progress .gce-spinner.done { border-color: #34a853; border-top-color: #34a853; animation: none; }
      #gce-progress .gce-spinner.error { border-color: #ea4335; border-top-color: #ea4335; animation: none; }
      @keyframes gce-spin { to { transform: rotate(360deg); } }
      #gce-progress .gce-label {
        font-size: 13px;
        color: var(--gce-text);
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 500;
      }
      #gce-progress .gce-close {
        background: none;
        border: none;
        font-size: 18px;
        color: var(--gce-muted);
        cursor: pointer;
        padding: 0 2px;
        line-height: 1;
        border-radius: 4px;
        flex-shrink: 0;
      }
      #gce-progress .gce-close:hover { color: var(--gce-text); background: var(--gce-hover); }
      #gce-progress .gce-bar-wrap { height: 4px; background: #e8eaed; }
      #gce-progress .gce-bar {
        height: 100%;
        background: var(--gce-accent);
        width: 0%;
        transition: width 0.4s ease, background 0.3s ease;
        border-radius: 0 2px 2px 0;
      }
      #gce-progress .gce-bar.done { background: var(--gce-success); }
      #gce-progress .gce-bar.error { background: var(--gce-error); }

      #gce-progress[data-gce-theme="dark"] {
        color-scheme:dark; --gce-surface:#202124; --gce-text:#f1f3f5;
        --gce-line:#41464e; --gce-muted:#a0a6af; --gce-hover:#30343a;
        --gce-accent:#8ab4f8; --gce-success:#8ed5a7; --gce-error:#ffaaa0;
      }
      #gce-progress .gce-spinner { border-color:var(--gce-line); border-top-color:var(--gce-accent); }
      #gce-progress .gce-bar-wrap { background:var(--gce-hover); }
      #gce-progress[data-state="done"] .gce-spinner { animation:none; border-color:var(--gce-success); }
      #gce-progress[data-state="error"] .gce-spinner { animation:none; border-color:var(--gce-error); }
      #gce-progress[data-state="paused"] .gce-spinner { animation:none; border-color:var(--gce-muted); }
      #gce-progress .gce-close:focus-visible { outline:2px solid var(--gce-accent); outline-offset:3px; }
      @media (prefers-reduced-motion:reduce) { #gce-progress * { animation:none !important; transition:none !important; } }
`;

    progressEl.innerHTML = `
      <section class="gce-card" aria-label="Chat export">
        <div class="gce-header">
          <div class="gce-logo" style="width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;">
            <svg width="22" height="22" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style="border-radius:4px;">
              <rect width="512" height="512" rx="40" fill="#f8f9fa"/>
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
            </svg>
          </div>
          <div class="gce-spinner"></div>
          <span class="gce-label" role="status" aria-live="polite">Initializing...</span>
          <button class="gce-close" type="button" aria-label="Cancel export" title="Cancel export">&times;</button>
        </div>
        <div class="gce-bar-wrap" role="progressbar" aria-label="Export progress" aria-valuemin="0" aria-valuemax="100"><div class="gce-bar"></div></div>
      </section>`;

    progressEl.appendChild(style);
    progressThemeCleanup = bindProgressTheme(progressEl);
    progressEl.querySelector('.gce-close').addEventListener('click', () => {
      if (exportInProgress && exportController) {
        showProgress('Cancelling export...', 0);
        exportController.abort();
      } else if (mirroredExportJob && ['working', 'paused'].includes(mirroredExportJob.state) && !['packaging', 'download'].includes(mirroredExportJob.phase)) {
        chrome.runtime.sendMessage({ action: 'cancelExportJob', jobId: mirroredExportJob.jobId }).catch(() => {});
      } else {
        if (progressJobId && !exportInProgress) {
          chrome.runtime.sendMessage({ action: 'acknowledgeExportJob', jobId: progressJobId }).catch(() => {});
        }
        hideProgress();
      }
    });
  }

  if (!progressEl.isConnected) document.documentElement.appendChild(progressEl);

  const label = progressEl.querySelector('.gce-label');
  const progressTrack = progressEl.querySelector('.gce-bar-wrap');
  const bar = progressEl.querySelector('.gce-bar');
  const closeButton = progressEl.querySelector('.gce-close');
  const safePercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : 0;
  const roundedPercent = Math.round(safePercent);
  progressEl.setAttribute('data-state', state);

  if (label) { label.textContent = text; label.title = text; }
  if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(roundedPercent));
  if (bar) {
    bar.style.width = safePercent + '%';
    bar.className = 'gce-bar' + (state === 'done' ? ' done' : state === 'error' ? ' error' : '');
  }
  if (closeButton) {
    const canCancel = (exportInProgress && exportController) ||
      (mirroredExportJob && ['working', 'paused'].includes(mirroredExportJob.state) && !['packaging', 'download'].includes(mirroredExportJob.phase));
    const closeLabel = canCancel ? 'Cancel export' : 'Dismiss export notification';
    closeButton.hidden = mirroredExportJob?.phase === 'packaging' && mirroredExportJob.state === 'working';
    closeButton.title = closeLabel;
    closeButton.setAttribute('aria-label', closeLabel);
    closeButton.textContent = '×';
  }

}

function hideProgress() {
  clearTimeout(progressHideTimer);
  progressHideTimer = null;
  progressCleanup?.();
  progressThemeCleanup?.();
  progressThemeCleanup = null;
  progressCleanup = null;
  progressIsResult = false;
  if (progressEl) {
    progressEl.remove();
    progressEl = null;
  }
}

function scheduleHideProgress(delay) {
  if (exportJobId) return; // Keep a tracked terminal outcome until dismissed.
  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(hideProgress, delay);
}

function renderExportResult(result, warning = '', auto = false, jobId = exportJobId) {
  const text = `Saved as ${result.filename}. ${warning}`.trim();
  if (!Number.isSafeInteger(result.downloadId) || result.downloadId < 0) {
    renderProgress(text, 100, 'done');
    return;
  }
  try {
    hideProgress();
    progressEl = document.createElement('div');
    progressEl.id = 'gce-progress';
    progressEl.style.cssText = 'position:fixed;bottom:24px;right:24px;width:min(320px,calc(100vw - 48px));z-index:2147483647;';
    progressIsResult = true;
    progressThemeCleanup = bindProgressTheme(progressEl);
    progressCleanup = mountExportResult(progressEl, { ...result, warning, auto }, () => {
      if (jobId) chrome.runtime.sendMessage({ action: 'acknowledgeExportJob', jobId }).catch(() => {});
      hideProgress();
    });
    document.documentElement.appendChild(progressEl);
  } catch (error) {
    console.warn('[GCE] Saved-file notification unavailable:', error);
    try { hideProgress(); } catch { progressEl = null; }
    renderProgress(text, 100, 'done');
  }
}

function showExportResult(result, warning = '', auto = false) {
  const text = `Saved as ${result.filename}. ${warning}`.trim();
  if (!Number.isSafeInteger(result.downloadId) || result.downloadId < 0) {
    showProgress(text, 100, 'done');
    return;
  }
  try { renderExportResult(result, warning, auto); }
  catch (error) { console.warn('[GCE] Saved-file notification unavailable:', error); }
  try {
    chrome.runtime.sendMessage({ action: 'exportStateUpdate', text, percent: 100, state: 'done',
      jobId: exportJobId, phase: 'download', conversationName: exportName,
      downloadId: result.downloadId, filename: result.filename, warning, auto }).catch(() => {});
  } catch { /* A saved file stays successful if its extension context closes. */ }
}

function mirrorExportJob(job) {
  if (exportInProgress || !job?.jobId) return;
  if (mirroredExportJob && (job.jobId === mirroredExportJob.jobId
    ? job.revision <= mirroredExportJob.revision : job.startedAt < mirroredExportJob.startedAt)) return;
  mirroredExportJob = job;
  progressJobId = job.jobId;
  if (job.acknowledged) { hideProgress(); return; }
  try {
    if (Number.isSafeInteger(job.downloadId)) renderExportResult(job, job.warning, job.auto, job.jobId);
    else renderProgress(job.text, job.percent, job.state);
  } catch (error) { console.warn('[GCE] Export notification unavailable:', error); }
}

function waitForDocumentVisible(signal = null) {
  throwIfAborted(signal);
  if (!document.hidden) return Promise.resolve(false);
  const job = exportJobId;
  const previous = lastExportProgress;
  if (job) showProgress(exportInWindow ? 'Paused. Restore the export window to resume.' : 'Paused. Return to Chat to resume.', previous.percent, 'paused');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visible);
      signal?.removeEventListener('abort', cancel);
    };
    const visible = () => {
      if (document.hidden) return;
      cleanup();
      if (job && exportJobId === job) showProgress(previous.text || 'Resuming export...', previous.percent, 'working');
      resolve(true);
    };
    const cancel = () => { cleanup(); reject(createAbortError()); };
    document.addEventListener('visibilitychange', visible);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else visible();
  });
}

async function waitForDocumentPaint(signal = null) {
  const wasHidden = await waitForDocumentVisible(signal);
  throwIfAborted(signal);
  if (typeof requestAnimationFrame !== 'function') return wasHidden;
  const job = exportJobId;
  const previous = lastExportProgress;
  return new Promise((resolve, reject) => {
    let frame, paused = false;
    const cleanup = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => { cleanup(); reject(createAbortError()); };
    const painted = () => {
      cleanup();
      if (paused && job && exportJobId === job) showProgress(previous.text || 'Resuming export…', previous.percent, 'working');
      resolve(wasHidden || paused);
    };
    // Visible documents can also stop painting when their window is covered
    // or the computer locks. An idle timer alone cannot prove history is done.
    const timer = setTimeout(() => {
      paused = true;
      if (job && exportJobId === job) showProgress(exportInWindow
        ? 'Paused. Show the export window to resume.' : 'Paused. Return to Chat to resume.', previous.percent, 'paused');
    }, 750);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(painted); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

// ── Scroll to Load All Messages ─────────────────────────────

function findScrollContainer() {
  const main = SEL.mainMessages && [...document.querySelectorAll(SEL.mainMessages)].find(el => el.clientHeight > 0);
  if (main) return main;
  for (const sel of SEL.scrollContainers) {
    const el = [...document.querySelectorAll(sel)].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight);
    if (el) return el;
  }
  // Dynamic fallback: find the tallest scrollable div
  let best = null, bestH = 0;
  for (const el of document.querySelectorAll(SEL.fallbackScrollable)) {
    if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 100 && el.scrollHeight > bestH) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        best = el;
        bestH = el.scrollHeight;
      }
    }
  }
  return best;
}

async function scrollToLoadAll(onProgress, dateFromTs = 0, signal = null, isCurrent = null) {
  const container = findScrollContainer();
  if (!container) {
    onProgress && onProgress('No scroll container found — exporting visible messages only');
    return { messages: extractMessages(), reason: 'visible-only', warning: 'No history container found; only rendered messages were captured.' };
  }

  const distanceFromBottom = Math.max(
    0,
    container.scrollHeight - container.clientHeight - container.scrollTop
  );
  const anchor = captureScrollAnchor(container);
  const extractionCache = createExtractionCache(container);
  const threads = createThreadCollector(container, onProgress, signal, isCurrent);
  let reason = 'limit';

  const dedupMap = new Map();
  const collectCurrent = async () => {
    await waitForDocumentPaint(signal);
    ensureCurrentConversation(isCurrent);
    for (const msg of [...extractMessages(extractionCache, container), ...await threads.collect()]) {
      const key = msg._dedupKey || `${msg.sender}|${msg.absoluteTimestamp}|${(msg.text || '').slice(0, 80)}`;
      dedupMap.set(key, msg);
    }
  };

  try {
    await collectCurrent();
    let prevHeight = container.scrollHeight;
    let prevOldest = getOldestTimestamp(container);
    let stableBatches = 0;
    let batches = 0;
    const MAX_BATCHES = 3000;
    const STABLE_BATCH_LIMIT = 3;

    onProgress && onProgress('Scrolling up to load full history...');

    while (batches < MAX_BATCHES) {
      throwIfAborted(signal);
      await waitForDocumentPaint(signal);
      ensureCurrentConversation(isCurrent);
      batches++;

      // Old parent messages can have new replies. Scan every parent and apply
      // the requested date/checkpoint only after all its threads are collected.

      // Overlap viewports so virtualized messages are collected before eviction.
      const beforeCount = dedupMap.size;
      const previousTop = container.scrollTop;
      const targetTop = Math.max(0, previousTop - Math.max(1, container.clientHeight * 0.75));
      const wait = waitForHistoryMutation(container, prevHeight, prevOldest,
        targetTop > 1 ? 250 : 600 * (stableBatches + 1), signal, targetTop > 1);
      container.scrollTop = targetTop;
      await wait;
      await collectCurrent();

      const oldest = getOldestTimestamp(container);
      const curHeight = container.scrollHeight;
      const advanced = dedupMap.size > beforeCount || curHeight !== prevHeight || (oldest && oldest !== prevOldest);

      if (advanced) {
        stableBatches = 0;
        prevHeight = curHeight;
        prevOldest = oldest;
      } else if (container.scrollTop <= 1 && previousTop <= 1) {
        stableBatches++;
        if (stableBatches >= STABLE_BATCH_LIMIT) { reason = 'idle'; break; }
      }

      if (batches % 2 === 0) {
        onProgress && onProgress(`Loading history... ${dedupMap.size} messages collected`);
      }
    }

    await collectCurrent();
    const warning = [
      reason === 'limit' ? 'History scan reached its safety limit; export may be incomplete.' : '',
      threads.failed ? `${threads.failed} thread(s) could not be completely loaded; export may be incomplete and its checkpoint will not advance. See thread loading issues in the export.` : ''
    ].filter(Boolean).join(' ');
    onProgress && onProgress(warning ? `${dedupMap.size} messages collected. ${warning}` : `${dedupMap.size} messages collected.`);

    return { reason, warning, threadFailures: threads.failures, threadsComplete: !threads.failed, threadsScanned: threads.scanned, messages: [...dedupMap.values()].sort(
      (a, b) => (a.absoluteTimestamp || 0) - (b.absoluteTimestamp || 0)
    ) };
  } finally {
    extractionCache.disconnect();
    if (!isCurrent || isCurrent()) {
      await threads.restore();
      restoreScrollPosition(container, distanceFromBottom, anchor);
    }
  }
}

function messageNodes(root) {
  const selector = SEL.deletedMessage ? `${SEL.messageGroups}, ${SEL.deletedMessage}` : SEL.messageGroups;
  return [...root.querySelectorAll(selector)];
}

function ensureCurrentConversation(isCurrent) {
  if (isCurrent && !isCurrent()) {
    const error = new Error('Conversation changed during export. Please retry.');
    error.name = 'ConversationChangedError';
    throw error;
  }
}

function threadTopic(container) {
  return container?.closest(SEL.topicContainer)?.getAttribute(SEL.attrs.topicId) || '';
}

function findThreadView(topic = '') {
  if (!SEL.threadScroll) return null;
  return [...document.querySelectorAll(SEL.threadScroll)].find(view =>
    view.clientHeight > 0 && (!topic || threadTopic(view) === topic)
  ) || null;
}

async function waitForThreadCondition(read, signal = null, timeoutMs = 5000, requireVisible = true) {
  let deadline = Date.now() + timeoutMs;
  let wasHidden = document.hidden;
  const visibilityChanged = () => { if (document.hidden) wasHidden = true; };
  if (requireVisible) document.addEventListener?.('visibilitychange', visibilityChanged);
  try {
    while (true) {
      if (requireVisible && (wasHidden || document.hidden)) {
        if (document.hidden) await waitForDocumentVisible(signal);
        wasHidden = false;
        deadline = Date.now() + timeoutMs;
      }
      throwIfAborted(signal);
      if (requireVisible && await waitForDocumentPaint(signal)) deadline = Date.now() + timeoutMs;
      const value = read();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(100, signal);
    }
  } finally {
    if (requireVisible) document.removeEventListener?.('visibilitychange', visibilityChanged);
  }
}

function threadSignature(view) {
  return `${view.scrollHeight}|${messageNodes(view).map(node => node.getAttribute(SEL.attrs.groupId)).join(',')}|${
    [...view.querySelectorAll(SEL.collapsedMessages)].map(node => node.getAttribute('data-collapsed-count')).join(',')}`;
}

async function readThreadMessages(view, topic, expectedReplies, signal, isCurrent = null) {
  const cache = createExtractionCache(view);
  const messages = new Map();
  const collect = () => {
    ensureCurrentConversation(isCurrent);
    for (const msg of extractMessages(cache, view)) {
      if (msg.threadId === topic) messages.set(msg._dedupKey, msg);
    }
  };
  const accountedFor = () => {
    const ids = new Set([...messages.values()].map(msg => msg.messageId));
    return expectedReplies !== null && ids.has(topic) && ids.size - 1 >= expectedReplies;
  };
  const finish = (complete, reason = '') => {
    const ids = new Set([...messages.values()].map(msg => msg.messageId).filter(Boolean));
    return { messages: [...messages.values()], complete, expectedReplies,
      capturedReplies: [...ids].filter(id => id !== topic).length,
      reason: complete ? '' : reason || (expectedReplies === null ? 'reply-count-unreadable' :
        ids.has(topic) ? 'reply-count-mismatch' : 'parent-not-loaded') };
  };

  try {
    // Expand explicit collapsed-message controls as well as traversing the
    // viewport. Google Chat can hide dozens of replies without a scroll fetch.
    for (const direction of [-1, 1]) {
      let idle = 0;
      for (let step = 0; step < 1000; step++) {
        throwIfAborted(signal);
        if (document.hidden) await waitForDocumentVisible(signal);
        if (!view.isConnected || threadTopic(view) !== topic) throw new Error('Thread changed during export');
        collect();
        const before = threadSignature(view);
        const collapsed = view.querySelector(SEL.collapsedMessages);
        if (collapsed) {
          collapsed.click();
          const changed = await waitForThreadCondition(() => threadSignature(view) !== before, signal);
          if (!changed) return finish(false, 'collapsed-replies-stalled');
          await sleep(150, signal);
          idle = 0;
          continue;
        }
        if (accountedFor()) return finish(true);

        const oldTop = view.scrollTop;
        const maxTop = Math.max(0, view.scrollHeight - view.clientHeight);
        const nextTop = Math.max(0, Math.min(maxTop, oldTop + direction * Math.max(1, view.clientHeight * 0.75)));
        const boundary = direction < 0 ? nextTop <= 1 : nextTop >= maxTop - 1;
        view.scrollTop = nextTop;
        await waitForThreadCondition(() => threadSignature(view) !== before, signal, boundary ? 600 * (idle + 1) : 150);
        collect();
        if (threadSignature(view) !== before) idle = 0;
        else if (boundary && Math.abs(view.scrollTop - oldTop) <= 1) idle++;
        if (idle >= 3) break;
        if (step === 999) return finish(false, 'traversal-limit');
      }
    }
    collect();
    return finish(accountedFor());
  } finally {
    cache.disconnect();
  }
}

function createThreadCollector(main, onProgress, signal, isCurrent = null) {
  const visited = new Set();
  const previous = findThreadView();
  const previousTopic = previous ? threadTopic(previous) : '';
  const previousTop = previous?.scrollTop || 0;
  const initialUrl = typeof location !== 'undefined' ? location.href : '';
  let lastOpened = '';
  let closedForMain = false;
  const failures = [];

  async function revealMain() {
    if (document.hidden) await waitForDocumentVisible(signal);
    if (main.clientHeight > 0) return;
    ensureCurrentConversation(isCurrent);
    const view = lastOpened && findThreadView(lastOpened);
    const close = view?.closest(SEL.threadPanel)?.querySelector(SEL.threadClose);
    if (!close) throw new Error('The conversation timeline is hidden. Restore the export window and retry.');
    close.click();
    closedForMain = true;
    if (!await waitForThreadCondition(() => main.clientHeight > 0, signal)) {
      throw new Error('Could not return from the thread to the conversation timeline. Please retry.');
    }
  }

  return {
    get failed() { return failures.length; },
    get failures() { return [...failures]; },
    get scanned() { return visited.size; },
    async collect() {
      if (!SEL.threadOpen) return [];
      if (document.hidden) await waitForDocumentVisible(signal);
      const messages = [];
      const anchor = captureScrollAnchor(main);
      const distance = Math.max(0, main.scrollHeight - main.clientHeight - main.scrollTop);
      try {
        for (const group of messageNodes(main)) {
          const topic = group.getAttribute(SEL.attrs.groupId);
          const open = group.querySelector(SEL.threadOpen);
          if (!topic || !open || visited.has(topic) || !group.isConnected) continue;
          throwIfAborted(signal);
          if (document.hidden) await waitForDocumentVisible(signal);
          ensureCurrentConversation(isCurrent);
          visited.add(topic);
          // Do not mistake a localized/abbreviated count (e.g. 1.234 or 1K)
          // for one reply and incorrectly certify the thread as complete.
          const count = open.textContent.match(/^\s*(\d+|[1-9]\d{0,2}(?:,\d{3})+)\s+repl(?:y|ies)\b/i);
          const expected = count ? Number(count[1].replace(/,/g, '')) : null;
          onProgress?.(`Loading thread ${visited.size}...`);
          try {
            lastOpened = topic;
            closedForMain = false;
            open.click();
            const view = await waitForThreadCondition(() => findThreadView(topic), signal);
            if (!view) {
              failures.push({ threadId: topic, reason: 'thread-open-timeout', expectedReplies: expected, capturedReplies: 0 });
              continue;
            }
            const result = await readThreadMessages(view, topic, expected, signal, isCurrent);
            messages.push(...result.messages);
            if (!result.complete) failures.push({ threadId: topic, reason: result.reason,
              expectedReplies: result.expectedReplies, capturedReplies: result.capturedReplies });
          } catch (error) {
            if (['AbortError', 'ConversationChangedError'].includes(error.name)) throw error;
            failures.push({ threadId: topic, reason: 'read-error', expectedReplies: expected,
              capturedReplies: null, error: String(error.message || error.name).slice(0, 240) });
          }
        }
      } finally {
        if (!isCurrent || isCurrent()) {
          if (!signal?.aborted) await revealMain();
          restoreScrollPosition(main, distance, anchor);
        }
      }
      return messages;
    },
    async restore() {
      if (!lastOpened || (isCurrent && !isCurrent()) || (initialUrl && !isSameConversationUrl(initialUrl, location.href))) return;
      // Leave a thread the user opened during the scan alone.
      const view = await waitForThreadCondition(() => findThreadView(), null, 500, false);
      if ((!view && !closedForMain) || (view && threadTopic(view) !== lastOpened)) return;
      if (previousTopic) {
        if (!view || threadTopic(view) !== previousTopic) {
          const parent = messageNodes(main).find(node => node.getAttribute(SEL.attrs.groupId) === previousTopic);
          const open = parent?.querySelector(SEL.threadOpen);
          if (!open) return;
          open.click();
        }
        const restored = await waitForThreadCondition(() => findThreadView(previousTopic), null, 1000, false);
        if (restored) restored.scrollTop = previousTop;
      } else if (view) {
        view.closest(SEL.threadPanel)?.querySelector(SEL.threadClose)?.click();
      }
    }
  };
}

function captureScrollAnchor(container) {
  const top = container.getBoundingClientRect().top;
  const node = [...container.querySelectorAll(SEL.messageGroups)].find(el => el.getBoundingClientRect().bottom > top);
  const id = node?.getAttribute(SEL.attrs.groupId);
  return id ? { id, offset: node.getBoundingClientRect().top - top } : null;
}

function restoreScrollPosition(container, distanceFromBottom, anchor = null) {
  const findAnchor = () => anchor && [...container.querySelectorAll(SEL.messageGroups)]
    .find(el => el.getAttribute(SEL.attrs.groupId) === anchor.id);
  const align = node => { container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset; };
  const node = findAnchor();
  if (node) { align(node); return; }
  container.scrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight - distanceFromBottom
  );
  // Allow a virtualized list to render the anchor after the fallback jump.
  if (anchor) {
    const observer = new MutationObserver(() => {
      const restored = findAnchor();
      if (restored) { observer.disconnect(); clearTimeout(timer); align(restored); }
    });
    observer.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), 1000);
  }
}

async function waitForHistoryMutation(container, initialHeight, initialOldest, timeoutMs, signal = null, renderedStep = false) {
  if (document.hidden) await waitForDocumentVisible(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let settleTimer = 0;
    let timeoutTimer = 0;
    let frame = null;

    const cleanup = () => {
      observer.disconnect();
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', cancel);
      document.removeEventListener?.('visibilitychange', visibilityChanged);
      if (frame !== null) cancelAnimationFrame(frame);
    };

    const finish = (painted = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (painted && !document.hidden) {
        resolve(container.scrollHeight !== initialHeight || getOldestTimestamp(container) !== initialOldest);
        return;
      }
      waitForDocumentPaint(signal).then(resumed => {
        if (resumed) {
          if (typeof Event === 'function') container.dispatchEvent?.(new Event('scroll'));
          return waitForHistoryMutation(container, initialHeight, initialOldest, timeoutMs, signal, renderedStep);
        }
        return container.scrollHeight !== initialHeight || getOldestTimestamp(container) !== initialOldest;
      }).then(resolve, reject);
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };

    const observer = new MutationObserver(() => {
      const historyAdvanced = container.scrollHeight !== initialHeight ||
        getOldestTimestamp(container) !== initialOldest;
      if (!historyAdvanced) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, 120);
    });
    const visibilityChanged = () => { if (document.hidden) finish(); };
    observer.observe(container, { childList: true, subtree: true });
    document.addEventListener?.('visibilitychange', visibilityChanged);
    timeoutTimer = setTimeout(finish, timeoutMs);
    // Two paints let scroll handlers render an already-loaded viewport.
    // Hidden waits restart on return; a timer never certifies hidden history.
    if (renderedStep && typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!settleTimer) finish(true);
        });
      });
    }
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

function getOldestTimestamp(root = document) {
  let oldest = 0;
  root.querySelectorAll(SEL.absoluteTimestampAttr).forEach(ts => {
    const value = parseInt(ts.getAttribute(SEL.attrs.absoluteTimestamp), 10) || 0;
    if (value && (!oldest || value < oldest)) oldest = value;
  });
  return oldest;
}

// ── Message Extraction ──────────────────────────────────────

function getConversationName() {
  for (const sel of SEL.conversationTitle) {
    const el = document.querySelector(sel);
    if (el) {
      const label = el.getAttribute('aria-label');
      const text = cleanText(label || el.textContent);
      if (text) return text;
    }
  }
  return '';
}

function createExtractionCache(container) {
  let entries = new WeakMap();
  const invalidate = records => {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const group = element?.closest(SEL.messageGroups);
      if (group) entries.delete(group);
      // List insertions do not change existing groups. Their date association
      // is checked by read(); recycled groups invalidate through their own edits.
    }
  };
  const observer = new MutationObserver(invalidate);
  observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true });
  return {
    read(group, date, parse) {
      invalidate(observer.takeRecords());
      const groupId = group.getAttribute?.(SEL?.attrs?.groupId) || '';
      const cached = entries.get(group);
      if (cached && cached.date === date && cached.groupId === groupId) return cached.messages;
      const messages = parse();
      entries.set(group, { date, groupId, messages });
      return messages;
    },
    disconnect() { observer.disconnect(); entries = new WeakMap(); }
  };
}

function extractMessages(cache = null, root = document) {
  const results = [];
  const seen = new Set();

  // Build date separator positions for date association
  const dateSeps = [];
  root.querySelectorAll(SEL.dateSeparator).forEach(el => {
    const text = cleanText(el.textContent);
    if (text) dateSeps.push({ text, top: el.getBoundingClientRect().top });
  });

  const groups = messageNodes(root);
  for (const [groupIndex, group] of groups.entries()) {
    const top = group.getBoundingClientRect().top;
    const date = [...dateSeps].reverse().find(sep => sep.top <= top)?.text || dateSeps[0]?.text || '';
    const deleted = SEL.deletedMessage && group.matches?.(SEL.deletedMessage);
    const parse = () => deleted ? [{ sender: 'Unknown', timestamp: '', absoluteTimestamp: 0, date,
      text: `[${cleanText(group.textContent) || 'Message deleted'}]`, media: [], deleted: true }] : extractFromGroup(group, dateSeps);
    const msgs = cache ? cache.read(group, date, parse) : parse();
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const hasMedia = msg.media && msg.media.length > 0;
      if (!msg.text && !hasMedia) continue;

      const groupId = group.getAttribute(SEL.attrs.groupId) || '';
      const topic = SEL.topicContainer ? group.closest?.(SEL.topicContainer)?.getAttribute(SEL.attrs.topicId) || '' : '';
      msg.messageId = groupId;
      if (topic) {
        msg.threadId = topic;
        if (groupId !== topic) {
          msg.parentMessageId = topic;
          if (!msg.absoluteTimestamp) {
            // Deleted replies have no timestamp. Keep their actual neighbors
            // so rendering can preserve their position without inventing one.
            [msg.previousMessageId, msg.nextMessageId] = [groups[groupIndex - 1], groups[groupIndex + 1]].map(node =>
              node?.closest?.(SEL.topicContainer)?.getAttribute(SEL.attrs.topicId) === topic
                ? node.getAttribute(SEL.attrs.groupId) || '' : ''
            );
          }
        }
      }
      const key = groupId ? `${groupId}/${i}` : `${msg.sender}|${msg.absoluteTimestamp}|${(msg.text || '').slice(0, 80)}`;
      msg._dedupKey = key;

      if (!seen.has(key)) {
        seen.add(key);
        results.push(msg);
      }
    }
  }

  // Fallback: try individual message text elements
  if (results.length === 0) {
    root.querySelectorAll(SEL.messageText).forEach(el => {
      const text = getCleanText(el);
      if (!text || text.length < 1) return;
      const key = '_|' + text;
      if (seen.has(key)) return;
      seen.add(key);
      const { sender, timestamp } = findSenderAndTime(el);
      results.push({ sender, timestamp, absoluteTimestamp: 0, text, date: '', media: [], _dedupKey: key });
    });
  }

  return results;
}

function extractFromGroup(group, dateSeps) {
  const results = [];

  // Sender
  let sender = 'Unknown';
  const senderAttrEl = group.querySelector(SEL.senderNameAttr);
  if (senderAttrEl) {
    const nameAttr = senderAttrEl.getAttribute(SEL.attrs.senderName);
    const nameText = group.querySelector(SEL.senderNameText);
    sender = (nameText ? cleanText(nameText.textContent) : '') || nameAttr || 'Unknown';
  } else {
    const nameText = group.querySelector(SEL.senderNameText);
    if (nameText) sender = cleanText(nameText.textContent) || 'Unknown';
  }

  // Avatar
  let avatarUrl = '';
  const avatarContainer = group.querySelector(SEL.avatarContainer);
  const avatarImg = avatarContainer ? avatarContainer.querySelector(SEL.avatarImg) : null;
  if (avatarImg && avatarImg.src) {
    // Normalize to a reasonable size
    avatarUrl = avatarImg.src.replace(/=s\d+-w\d+-h\d+/, '=s64-w64-h64');
  }

  // Timestamp
  let timestamp = '';
  let absoluteTimestamp = 0;
  const tsEl = group.querySelector(SEL.timestamp);
  if (tsEl) {
    timestamp = cleanText(tsEl.textContent);
    const tsAttr = tsEl.getAttribute(SEL.attrs.absoluteTimestamp);
    if (tsAttr) absoluteTimestamp = parseInt(tsAttr, 10) || 0;
  }

  // Date association
  let date = '';
  if (dateSeps.length > 0) {
    const groupTop = group.getBoundingClientRect().top;
    for (let i = dateSeps.length - 1; i >= 0; i--) {
      if (dateSeps[i].top <= groupTop) { date = dateSeps[i].text; break; }
    }
    if (!date) date = dateSeps[0].text;
  }

  // Message text elements
  const textEls = group.querySelectorAll(SEL.messageText);
  for (const el of textEls) {
    const text = getCleanText(el);
    if (text) results.push({ sender, timestamp, absoluteTimestamp, date, avatarUrl, text, media: [] });
  }

  // ── Bot / Card messages (e.g. Login AlertX, Geo-PulseX) ──
  // These use div.bBOrFb > ... > span.nr7tub instead of div.DTp27d
  if (results.length === 0) {
    const cardBody = group.querySelector('div.bBOrFb');
    if (cardBody) {
      const cardLines = [];
      cardBody.querySelectorAll('span.nr7tub').forEach(span => {
        const t = cleanText(span.textContent);
        if (t) cardLines.push(t);
      });
      if (cardLines.length > 0) {
        results.push({ sender, timestamp, absoluteTimestamp, date, avatarUrl, text: cardLines.join('\n'), media: [] });
      }
    }
  }

  // ── Meet / video call chips ──
  // Rendered as a.Pj9rof[href*="meet.google.com"] — NO DTp27d element exists
  if (results.length === 0) {
    const meetLinks = group.querySelectorAll('a[href*="meet.google.com"]');
    for (const a of meetLinks) {
      const href = a.href || a.getAttribute('href') || '';
      if (!href) continue;
      const label = a.getAttribute('title') || a.getAttribute('aria-label')?.split(',')[0] || 'Join video meeting';
      results.push({ sender, timestamp, absoluteTimestamp, date, avatarUrl, text: `${label}: ${href}`, media: [] });
    }
  }

  // ── Generic link chip fallback ──
  // For any remaining empty message groups that have a link (e.g. other chips)
  if (results.length === 0) {
    const seenUrls = new Set();
    group.querySelectorAll('a[href^="http"]').forEach(a => {
      const href = a.href || '';
      if (!href || seenUrls.has(href)) return;
      // Skip chrome-extension internal links
      if (href.startsWith('chrome-extension://')) return;
      seenUrls.add(href);
      const label = cleanText(a.getAttribute('title') || a.textContent) || href;
      results.push({ sender, timestamp, absoluteTimestamp, date, avatarUrl, text: label !== href ? `${label}: ${href}` : href, media: [] });
    });
  }

  // Media
  const media = extractMedia(group);
  if (media.length > 0) {
    if (results.length > 0) {
      results[results.length - 1].media = media;
    } else {
      results.push({ sender, timestamp, absoluteTimestamp, date, avatarUrl, text: '', media });
    }
  }

  return results;
}

function extractMedia(group) {
  const media = [];

  // Images
  for (const chip of group.querySelectorAll(SEL.imageChip)) {
    const img = chip.querySelector(SEL.imageImg);
    const btn = chip.querySelector(SEL.imageButton);
    if (img && img.src) {
      const name = (btn?.getAttribute(SEL.attrs.title) || 'image.png').trim() || 'image.png';
      const ext = name.split('.').pop()?.toLowerCase() || 'png';
      media.push({ type: 'image', url: img.src, name, mimeType: mimeFromExt(ext) });
    }
  }

  // GIFs / stickers
  for (const chip of group.querySelectorAll(SEL.gifChip)) {
    if (chip.closest(SEL.imageChip)) continue; // avoid double-counting
    const img = chip.querySelector(SEL.imageImg);
    if (img && img.src) {
      const parts = img.src.split('/');
      let name = parts[parts.length - 1] || 'sticker';
      if (!name.includes('.')) name += '.gif';
      media.push({ type: 'gif', url: img.src, name, mimeType: 'image/gif' });
    }
  }

  // Audio (voice messages)
  for (const player of group.querySelectorAll(SEL.audioPlayer)) {
    const url = decodeHtmlEntities(player.getAttribute(SEL.attrs.mediaUrl) || '');
    if (!url) continue;
    const durationMs = parseFloat(player.getAttribute(SEL.attrs.mediaDuration) || '0');
    const sourceType = player.getAttribute(SEL.attrs.mediaSourceType) || 'audio/mpeg';
    const ext = sourceType.includes('mp4') ? 'mp4' : 'mp3';
    media.push({ type: 'audio', url, name: `voice_message.${ext}`, mimeType: sourceType.startsWith('audio/') ? sourceType : 'audio/mpeg', durationMs });
  }

  // Videos
  const videoSeen = new Set();
  for (const player of group.querySelectorAll(SEL.videoPlayer)) {
    const rawUrl = player.getAttribute(SEL.attrs.mediaUrl) || '';
    if (!rawUrl) continue;
    const url = decodeHtmlEntities(rawUrl.replace('url_type=STREAMING_URL', 'url_type=DOWNLOAD_URL'));
    const fallbackUrl = rawUrl !== url ? decodeHtmlEntities(rawUrl) : '';
    const durationMs = parseFloat(player.getAttribute(SEL.attrs.mediaDuration) || '0');

    const labelEl = player.querySelector(SEL.videoLabel) || player.closest(SEL.videoLabel);
    let name = 'video.mp4';
    if (labelEl) {
      const m = (labelEl.getAttribute(SEL.attrs.ariaLabel) || '').match(/^Video,\s*(.+)\.\s+\d+\s+(?:second|minute|hour)/);
      if (m) {
        name = m[1].trim();
        if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += '.mp4';
      }
    }

    const ctMatch = (rawUrl || '').match(/content_type=([^&]+)/);
    const mimeType = ctMatch ? decodeURIComponent(ctMatch[1]) : 'video/mp4';

    const fileChipEl = player.closest(SEL.fileChip);
    if (fileChipEl) videoSeen.add(fileChipEl);

    media.push({ type: 'video', url, fallbackUrl, name, mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4', durationMs });
  }

  // File attachments
  for (const chip of group.querySelectorAll(SEL.fileChip)) {
    if (videoSeen.has(chip)) continue;
    const nameEl = chip.querySelector(SEL.fileName);
    const btnEl = chip.querySelector(SEL.fileButton);
    const thumbEl = chip.querySelector(SEL.fileThumb);
    const name = nameEl ? cleanText(nameEl.textContent) : (btnEl?.getAttribute(SEL.attrs.title) || 'file');
    const thumbUrl = thumbEl?.src || '';
    const type = detectChipType(btnEl?.getAttribute(SEL.attrs.ariaLabel) || '', thumbUrl, name);
    const downloadUrl = findChipDownloadUrl(chip, thumbUrl);
    const ctMatch = (thumbUrl || downloadUrl || '').match(/content_type=([^&]+)/);
    const mimeType = ctMatch ? decodeURIComponent(ctMatch[1]) : guessMimeFromName(name);

    media.push({ type, url: downloadUrl, fallbackUrl: type === 'video' ? '' : undefined, thumbUrl: type === 'file' ? thumbUrl : undefined, name, mimeType });
  }

  return media;
}

// ── DOM Helpers ─────────────────────────────────────────────

/**
 * Extracts clean text from an element, preserving meaningful line breaks.
 * Handles <br>, <div>, <p> block boundaries so multi-line messages stay multi-line.
 */
function getCleanText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  // Remove noise elements
  for (const noiseSel of SEL.noiseSelectors) {
    try { clone.querySelectorAll(noiseSel).forEach(n => n.remove()); } catch {}
  }
  // Replace <br> with newline markers
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  // Insert newlines after block-level elements so paragraphs are separated
  clone.querySelectorAll('p, div').forEach(el => {
    if (el.nextSibling) el.insertAdjacentText('afterend', '\n');
  });
  return cleanMessageText(clone.textContent);
}

/**
 * Cleans message body text — preserves internal line breaks, collapses excess whitespace per line.
 */
function cleanMessageText(str) {
  if (!str) return '';
  return str
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cleans single-line UI text (sender names, timestamps, date separators).
 * Collapses all whitespace to a single space.
 */
function cleanText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function findSenderAndTime(el) {
  let node = el;
  for (let i = 0; i < 8 && node?.parentElement; i++) {
    node = node.parentElement;
    if (node.matches && node.matches(SEL.messageGroups)) {
      const senderEl = node.querySelector(SEL.senderNameAttr) || node.querySelector(SEL.senderNameText);
      const tsEl = node.querySelector(SEL.timestamp);
      return {
        sender: senderEl ? cleanText(senderEl.textContent) : 'Unknown',
        timestamp: tsEl ? cleanText(tsEl.textContent) : ''
      };
    }
  }
  return { sender: 'Unknown', timestamp: '' };
}

function detectChipType(ariaLabel, thumbUrl, name) {
  if (/^Video,/i.test(ariaLabel)) return 'video';
  if (/^Audio,/i.test(ariaLabel)) return 'audio';
  if (/^Image,/i.test(ariaLabel)) return 'image';
  if (/content_type=video/i.test(thumbUrl)) return 'video';
  if (/content_type=audio/i.test(thumbUrl)) return 'audio';
  if (/content_type=image/i.test(thumbUrl)) return 'image';
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  if (['mp4','mov','avi','webm','mkv','flv','wmv','m4v','3gp'].includes(ext)) return 'video';
  if (['mp3','wav','ogg','m4a','flac','aac','wma'].includes(ext)) return 'audio';
  if (['png','jpg','jpeg','gif','webp','svg','bmp','ico','heic'].includes(ext)) return 'image';
  return 'file';
}

function findChipDownloadUrl(chip, thumbUrl) {
  let url = '';
  const parentItem = chip.closest(SEL.chipParentItem);
  if (parentItem) {
    const anchor = parentItem.querySelector(SEL.chipDownloadAnchor);
    if (anchor) url = decodeHtmlEntities(anchor.getAttribute(SEL.attrs.href) || '');
  }
  if (!url) {
    const wrapper = chip.closest(SEL.chipWrapperFallback) || chip.parentElement;
    const anchor = wrapper?.querySelector(SEL.downloadAnchorGeneric);
    if (anchor) url = decodeHtmlEntities(anchor.getAttribute(SEL.attrs.href) || '');
  }
  if (!url && thumbUrl && thumbUrl.includes('get_attachment_url')) {
    url = thumbUrl
      .replace(/url_type=[A-Z_]+/, 'url_type=DOWNLOAD_URL')
      .replace(/[&?]sz=[^&]*/g, '')
      .replace(/[&?]allow_caching=[^&]*/g, '');
  }
  return url;
}

function mimeFromExt(ext) {
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
  }[ext] || 'image/png';
}

function guessMimeFromName(name) {
  return {
    csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    webm: 'video/webm', zip: 'application/zip'
  }[(name || '').split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(str, 'text/html');
      return doc.body.textContent || '';
    } catch { /* fallback below */ }
  }
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function createAbortError() {
  const error = new Error('Export cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// ── Media Download (content-side fetch with bg fallback) ────

async function downloadMedia(url, signal = null) {
  throwIfAborted(signal);
  // Strategy 1: fetch with credentials (works for authenticated Google content)
  try {
    const resp = await fetch(url, { credentials: 'include', signal });
    if (resp.ok) return await blobToBase64(resp, signal);
  } catch { throwIfAborted(signal); }

  // Strategy 2: fetch without credentials
  try {
    const resp = await fetch(url, { credentials: 'omit', signal });
    if (resp.ok) return await blobToBase64(resp, signal);
  } catch { throwIfAborted(signal); }

  // Strategy 3: ask background service worker (can use cookies API)
  const requestId = crypto.randomUUID();
  const cancel = () => { chrome.runtime.sendMessage({ action: 'cancelMediaBg', requestId }).catch(() => {}); };
  try {
    throwIfAborted(signal);
    const pending = chrome.runtime.sendMessage({ action: 'downloadMediaBg', url, requestId });
    signal?.addEventListener('abort', cancel, { once: true });
    const result = await pending;
    throwIfAborted(signal);
    if (result?.success) return result;
  } catch { throwIfAborted(signal); }
  finally { signal?.removeEventListener('abort', cancel); }

  return { success: false, error: 'All download strategies failed' };
}

async function blobToBase64(resp, signal = null) {
  const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
  const blob = await resp.blob();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    const cancel = () => { reader.abort(); cleanup(); reject(createAbortError()); };
    reader.onload = () => { cleanup(); resolve({ success: true, base64: reader.result.split(',')[1], mimeType }); };
    reader.onerror = () => { cleanup(); reject(new Error('FileReader error')); };
    signal?.addEventListener('abort', cancel, { once: true });
    reader.readAsDataURL(blob);
  });
}

// ── Main Export Flow ─────────────────────────────────────────

function checkpointScope(href, format, includeMedia) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || !CHAT_HOSTS.includes(url.hostname)) return '';
    const route = `${url.pathname}${url.hash}`;
    // Chat uses both /app/space/ID and direct /u/0/room/ID routes. Installed
    // web apps commonly expose only the latter, while Gmail uses #chat/....
    const match = route.match(/(?:#chat\/|\/app\/|\/)(?:(dm|space|room|chat)\/)([A-Za-z0-9_-]+)/);
    if (!match) return '';
    const account = url.pathname.match(/\/u\/([^/]+)/)?.[1] || url.searchParams.get('authuser') || '0';
    const mode = format === 'md' ? 'md' : format === 'txt' ? 'txt' : includeMedia ? 'html-media' : 'html';
    return `${url.hostname}|${account}|${match[1]}|${match[2]}|${mode}`;
  } catch { return ''; }
}

function checkpointScopeFromPage(format, includeMedia, sourceUrl = '') {
  const href = conversationHrefFromPage(sourceUrl);
  return href ? checkpointScope(href, format, includeMedia) : '';
}

// Returns the first URL that identifies the open conversation, or ''.
function conversationHrefFromPage(sourceUrl = '') {
  const candidates = [];
  const documents = [];
  const add = href => { if (href && !candidates.includes(href)) candidates.push(href); };
  const addDocument = doc => { if (doc && !documents.includes(doc)) documents.push(doc); };
  if (typeof location !== 'undefined') add(location.href);
  add(sourceUrl);
  addDocument(document);

  // The conversation may live in a same-origin inner frame while an installed
  // Chat web app keeps its outer address at /u/N/. Inspect accessible ancestors,
  // including their documents: the active navigation link lives in the shell.
  try {
    let frame = window;
    while (frame.parent && frame.parent !== frame) {
      frame = frame.parent;
      add(frame.location.href);
      addDocument(frame.document);
    }
  } catch { /* a cross-origin ancestor is intentionally inaccessible */ }

  // In some PWA layouts the address remains fixed. Chat still marks the active
  // navigation item, whose link contains the stable conversation ID.
  const selected = [
    'a[aria-current="page"][href]',
    'a[aria-selected="true"][href]',
    '[aria-selected="true"] a[href]',
    '[role="treeitem"][aria-current="true"] a[href]'
  ];
  for (const doc of documents) {
    try {
      doc.querySelectorAll(selected.join(',')).forEach(link => {
        const href = link.href || link.getAttribute?.('href');
        try { add(new URL(href, sourceUrl || location.href).href); } catch { /* ignore malformed UI links */ }
      });
    } catch { /* synthetic/minimal documents may not implement this query */ }
  }

  for (const href of candidates) {
    if (checkpointScope(href, 'txt', false)) return href;
  }

  // Some Chat shells mark selection only with private CSS. Match the visible
  // header to navigation links, but accept it only when the result is unique.
  const title = cleanText(getConversationName()).toLocaleLowerCase();
  if (title) {
    const matches = new Map();
    for (const doc of documents) {
      try {
        doc.querySelectorAll('a[href]').forEach(link => {
          const label = cleanText(link.getAttribute?.('aria-label') || link.textContent).toLocaleLowerCase();
          if (label !== title) return;
          const href = link.href || link.getAttribute?.('href');
          let absolute = '';
          try { absolute = new URL(href, sourceUrl || location.href).href; } catch { return; }
          const scope = checkpointScope(absolute, 'txt', false);
          if (scope && ![...matches.values()].includes(scope)) matches.set(absolute, scope);
        });
      } catch { /* inaccessible or minimal document */ }
    }
    if (matches.size === 1) return [...matches.keys()][0];
  }
  return '';
}

async function hashCheckpointValue(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function messageFingerprint(message) {
  return hashCheckpointValue(JSON.stringify([
    message._dedupKey || '', message.sender || '', message.absoluteTimestamp || 0,
    message.text || '', (message.media || []).map(m => [m.type, m.name, m.url])
  ]));
}

async function selectNewMessages(messages, checkpoint) {
  if (!checkpoint) return messages;
  const known = new Set(checkpoint.fingerprints);
  const undated = new Set(checkpoint.undatedFingerprints || []);
  const selected = [];
  for (const message of messages) {
    const time = message.absoluteTimestamp;
    // Missing timestamps must never silently discard a message.
    if ((!time && (!message.messageId || !undated.has(await messageFingerprint(message)))) || time > checkpoint.timestamp ||
        (time === checkpoint.timestamp && !known.has(await messageFingerprint(message)))) selected.push(message);
  }
  return selected;
}

async function buildCheckpoint(messages, previous = null) {
  messages = messages.filter(message => !message.contextOnly);
  const timestamp = messages.reduce((max, m) => Math.max(max, m.absoluteTimestamp || 0), previous?.timestamp || 0);
  if (!timestamp) return null;
  const boundary = messages.filter(m => m.absoluteTimestamp === timestamp);
  const fingerprints = [...new Set([
    ...(previous?.timestamp === timestamp ? previous.fingerprints : []),
    ...await Promise.all(boundary.map(messageFingerprint))
  ])];
  const undatedFingerprints = [...new Set([
    ...(previous?.undatedFingerprints || []),
    ...await Promise.all(messages.filter(m => !m.absoluteTimestamp && m.messageId).map(messageFingerprint))
  ])];
  if (fingerprints.length > 5000 || undatedFingerprints.length > 5000) return null;
  return { timestamp, fingerprints, undatedFingerprints };
}

function includeThreadParents(allMessages, selected) {
  const ids = new Set(selected.map(message => message.messageId).filter(Boolean));
  const needed = new Set(selected.map(message => message.parentMessageId).filter(id => id && !ids.has(id)));
  return [
    ...allMessages.filter(message => needed.has(message.messageId)).map(message => ({ ...message, contextOnly: true })),
    ...selected
  ];
}

async function contentCheckpointScope(messages, conversationName, format, includeMedia, href = '') {
  const timestamped = messages.filter(message => message.absoluteTimestamp).sort((a, b) =>
    a.absoluteTimestamp - b.absoluteTimestamp || String(a._dedupKey || '').localeCompare(String(b._dedupKey || ''))
  );
  if (!timestamped.length) return '';
  const anchors = (await Promise.all(timestamped.slice(0, 3).map(messageFingerprint))).sort();
  let host = 'chat.google.com';
  let account = '0';
  try {
    const url = new URL(href || location.href);
    if (CHAT_HOSTS.includes(url.hostname)) host = url.hostname;
    account = url.pathname.match(/\/u\/([^/]+)/)?.[1] || url.searchParams.get('authuser') || '0';
  } catch { /* retain conservative defaults */ }
  const mode = format === 'md' ? 'md' : format === 'txt' ? 'txt' : includeMedia ? 'html-media' : 'html';
  const titleHash = await hashCheckpointValue(cleanText(conversationName).toLocaleLowerCase());
  return `${host}|${account}|content|${titleHash}|${anchors.join('.')}|${mode}`;
}

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

// Resolves to 'done', 'empty', 'error', 'cancelled' or 'busy'.
async function runExport({ format = 'txt', loadAll = true, includeMedia = true, dateFrom = '', incremental = false, sourceUrl = '', auto = false, jobId = null, collectionWindow = false }) {
  if (exportInProgress) return 'busy';
  mirroredExportJob = null;
  exportInWindow = collectionWindow;
  exportInProgress = true;
  const controller = new AbortController();
  exportController = controller;
  exportJobId = jobId;
  const { signal } = controller;
  let originalPosition = null;
  let conversationMatches = () => true;

  try {
    await loadSelectors();

    if (!isInChatFrame()) {
      showProgress('Open a Google Chat conversation before exporting.', 0, 'error');
      scheduleHideProgress(5000);
      exportInProgress = false;
      exportController = null;
      return 'error';
    }

    const initialUrl = typeof location !== 'undefined' ? location.href : '';
    const initialPageScope = checkpointScopeFromPage(format, includeMedia);
    const initialName = getConversationName();
    exportJobId ||= `job-${crypto.randomUUID()}`;
    exportPhase = 'history';
    exportName = initialName || 'Google Chat';
    showProgress('Preparing export…', 2);
    conversationMatches = () => (!initialUrl || isSameConversationUrl(initialUrl, location.href)) &&
      (!initialPageScope || initialPageScope === checkpointScopeFromPage(format, includeMedia)) &&
      (!!initialPageScope || !initialName || initialName === getConversationName());
    if (document.hidden) await waitForDocumentVisible(signal);
    ensureCurrentConversation(conversationMatches);
    let scope = initialPageScope || checkpointScopeFromPage(format, includeMedia, sourceUrl);
    // Old checkpoints covered only the main timeline. Establish a fresh baseline
    // before claiming any previously hidden thread replies were exported.
    let checkpointKey = scope ? `gceCheckpoint:${await hashCheckpointValue(`${scope}|threads-v1`)}` : '';
    let previous = incremental && checkpointKey ? (await chrome.storage.local.get(checkpointKey))[checkpointKey] : null;
    if (incremental) { loadAll = true; dateFrom = ''; }
    if (loadAll) {
      const container = findScrollContainer();
      if (container) {
        originalPosition = { container, distance: Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop), anchor: captureScrollAnchor(container) };
        container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        await sleep(600, signal);
      }
    }
    if (incremental) {
      showProgress(previous ? 'Loading messages since the previous export...' :
        (checkpointKey ? 'First incremental export: collecting a baseline...' : 'Identifying this web-app conversation from its history...'), 5);
    }

    let messages;
    let history = { reason: 'visible-only', warning: 'Only currently rendered messages were requested.' };
    const dateFromTs = previous?.timestamp || (dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : 0);

    if (loadAll) {
      history = await scrollToLoadAll(
        (text) => showProgress(text, 15),
        dateFromTs,
        signal,
        conversationMatches
      );
      messages = history.messages;
      await sleep(200, signal);
    }

    showProgress('Collecting messages…', 30);
    await sleep(100, signal);
    if (document.hidden) await waitForDocumentVisible(signal);
    ensureCurrentConversation(conversationMatches);

    if (!messages) messages = extractMessages();
    const conversationName = getConversationName() || 'Google Chat';
    if (incremental && !checkpointKey) {
      scope = await contentCheckpointScope(messages, conversationName, format, includeMedia, sourceUrl || initialUrl);
      if (!scope) throw new Error('Cannot create a safe conversation identity because the loaded messages have no timestamps.');
      checkpointKey = `gceCheckpoint:${await hashCheckpointValue(`${scope}|threads-v1`)}`;
      previous = (await chrome.storage.local.get(checkpointKey))[checkpointKey] || null;
    }
    const effectiveDateFromTs = previous?.timestamp || dateFromTs;
    const allMessages = messages;
    if (effectiveDateFromTs) {
      messages = messages.filter(m => !m.absoluteTimestamp || m.absoluteTimestamp >= effectiveDateFromTs);
    }
    messages = await selectNewMessages(messages, previous);
    messages = includeThreadParents(allMessages, messages);
    if (previous) history.since = previous.timestamp;

    if (!messages || messages.length === 0) {
      if (loadAll && (history.threadsComplete === false || ['limit', 'visible-only'].includes(history.reason))) {
        exportPhase = 'failed';
        showProgress(`History scan was incomplete. No export was saved. ${history.warning || 'Please retry.'}`, 0, 'error');
        scheduleHideProgress(6000);
        return 'error';
      }
      exportPhase = 'empty';
      showProgress(previous ? `No new messages found since the previous export. ${history.warning || ''}` : 'No messages found. Try opening a conversation first.', 100, previous ? 'done' : 'error');
      scheduleHideProgress(5000);
      exportInProgress = false;
      exportController = null;
      return 'empty';
    }

    showProgress(`Found ${messages.length} messages`, 35);

    const exportDate = new Date().toISOString();
    let mediaFiles = [];
    let mediaFailed = false;
    exportPhase = 'media';

    if (format === 'html' && includeMedia) {
      // Download all media
      let totalMedia = 0;
      messages.forEach(m => { totalMedia += (m.media || []).filter(x => x.url).length; });
      const maxMedia = Math.max(totalMedia, 1);
      const jobs = [];
      messages.forEach(msg => (msg.media || []).forEach(m => {
        if (m.url) jobs.push({ m, number: jobs.length + 1 });
      }));
      if (jobs.length) showProgress(`Downloading media 0/${totalMedia}...`, 35);
      let nextJob = 0;
      let completed = 0;

      const worker = async () => {
        while (nextJob < jobs.length) {
          throwIfAborted(signal);
          const { m, number } = jobs[nextJob++];
          let result = await downloadMedia(m.url, signal);
          if (!result?.success && m.fallbackUrl) result = await downloadMedia(m.fallbackUrl, signal);
          throwIfAborted(signal);
          if (result?.success) {
            const safeName = (m.name || `media_${number}`).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
            const path = `media/${number}_${safeName}`;
            mediaFiles.push({ path, base64: result.base64, mimeType: result.mimeType });
            m._localPath = path;
          } else { mediaFailed = true; }
          completed++;
          const pct = 35 + Math.round((completed / maxMedia) * 50);
          showProgress(`Downloading media ${completed}/${totalMedia}...`, pct);
        }
      };

      const concurrency = Math.min(4, jobs.length);
      const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try { await worker(); } catch (error) { controller.abort(); throw error; }
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }

    showProgress('Preparing file…', 88);
    await sleep(200, signal);
    ensureCurrentConversation(conversationMatches);
    const candidate = checkpointKey && loadAll && !mediaFailed && history.reason !== 'limit' && history.reason !== 'visible-only' && history.threadsComplete !== false
      ? await buildCheckpoint(messages, previous) : null;
    if (mediaFailed) history.warning = `${history.warning || ''} Some attachments failed; the checkpoint will not advance.`.trim();
    if (incremental && !candidate && !mediaFailed && !history.warning) history.warning = 'No safe checkpoint was saved; the next export may repeat messages.';
    // Packaging runs in the service worker and cannot be interrupted safely.
    exportController = null;
    exportPhase = 'packaging';

    // Send to background for packaging & download
    const resp = await chrome.runtime.sendMessage({
      action: 'packageAndDownload',
      jobId: exportJobId,
      format,
      payload: { conversationName, messages, mediaFiles, exportDate, sourceUrl, history: { reason: history.reason, warning: history.warning, since: history.since, threadsScanned: history.threadsScanned, threadsComplete: history.threadsComplete, threadFailures: history.threadFailures }, checkpoint: candidate ? { key: checkpointKey, value: candidate } : null }
    });
      if (resp && resp.success) {
        exportPhase = 'download';
        showExportResult(resp, [history.warning, resp.checkpointWarning].filter(Boolean).join(' '), auto);
        return 'done';
      } else {
        exportPhase = 'failed';
        showProgress('Export failed: ' + (resp?.error || 'Unknown error'), 0, 'error');
        scheduleHideProgress(6000);
        return 'error';
      }

  } catch (err) {
    exportInProgress = false;
    exportController = null;
    if (err?.name === 'AbortError') {
      exportPhase = 'cancelled';
      showProgress('Export cancelled.', 0, 'error');
      scheduleHideProgress(2500);
      return 'cancelled';
    }
    console.error('[GCE] Export error:', err);
    exportPhase = 'failed';
    showProgress('Export failed: ' + err.message, 0, 'error');
    scheduleHideProgress(6000);
    return 'error';
  } finally {
    if (originalPosition && conversationMatches()) restoreScrollPosition(originalPosition.container, originalPosition.distance, originalPosition.anchor);
    exportInProgress = false;
    exportController = null;
    exportJobId = null;
    exportPhase = 'idle';
  }
}

// ── Export Mode (auto-export on channel switch) ─────────────
// The background owns the mode; this frame watches for conversation switches
// and exports each newly opened conversation once it has rendered.

const EXPORT_MODE_SYNC_MS = 15000;
const EXPORT_MODE_ACTIVITY_MS = 30000;
let exportModeEnabled = false;
let exportModeWatch = { key: '', stableTicks: 0, handled: false };
let exportModeLastSync = 0;
let exportModeLastActivity = 0;
let autoExportKey = '';

function currentConversation() {
  const href = conversationHrefFromPage();
  const scope = href ? checkpointScope(href, 'txt', false) : '';
  if (scope) return { key: scope.replace(/\|txt$/, '') };
  // Fall back to the header name when the address carries no conversation ID.
  const name = cleanText(getConversationName());
  return name ? { key: `name|${name.toLocaleLowerCase()}` } : null;
}

function topFrameUrl() {
  try { return window.top.location.href; } catch { return ''; }
}

function setExportModeEnabled(enabled) {
  exportModeEnabled = enabled === true;
  if (!exportModeEnabled) exportModeWatch = { key: '', stableTicks: 0, handled: false };
}

function reportExportModeActivity() {
  exportModeLastActivity = Date.now();
  chrome.runtime.sendMessage({ action: 'exportModeActivity' }).catch(() => {});
}

async function syncExportMode() {
  exportModeLastSync = Date.now();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getExportMode' });
    setExportModeEnabled(resp?.enabled);
  } catch { /* service worker restarting; retry next sync */ }
}

async function startAutoExport(key) {
  const resp = await chrome.runtime.sendMessage({ action: 'autoExportCandidate', key }).catch(() => null);
  // The user may have switched again while the background answered.
  if (!resp?.run || exportModeWatch.key !== key || exportInProgress) return;
  const settings = resp.settings || {};
  autoExportKey = key;
  const result = await runExport({
    format: ['txt', 'md', 'html'].includes(settings.format) ? settings.format : 'txt',
    loadAll: settings.loadAll !== false,
    includeMedia: settings.includeMedia !== false,
    dateFrom: settings.dateFrom || '',
    incremental: settings.incremental === true,
    sourceUrl: topFrameUrl(),
    auto: true
  });
  autoExportKey = '';
  reportExportModeActivity();
  if (result === 'done' || result === 'empty') {
    chrome.runtime.sendMessage({ action: 'autoExportDone', key }).catch(() => {});
  } else if (result === 'cancelled') {
    // If cancelled manually while remaining on this channel, suppress immediate auto-retry loops.
    // Switching channels and revisiting will reset handled state and allow retrying.
    if (exportModeWatch.key === key) {
      exportModeWatch.handled = true;
    }
  }
}

function exportModeTick() {
  if (!SEL || !isInChatFrame()) return;
  if (!exportModeEnabled) return;
  const now = Date.now();
  if (now - exportModeLastSync > EXPORT_MODE_SYNC_MS) syncExportMode();
  // Long exports count as activity so export mode does not time out mid-run.
  if (exportInProgress && now - exportModeLastActivity > EXPORT_MODE_ACTIVITY_MS) reportExportModeActivity();

  const current = currentConversation();
  if (!current) return;
  if (current.key !== exportModeWatch.key) {
    const switched = exportModeWatch.key !== '';
    exportModeWatch = { key: current.key, stableTicks: 0, handled: false };
    if (exportInProgress && exportController && autoExportKey && autoExportKey !== current.key) exportController.abort();
    if (switched) reportExportModeActivity();
    return;
  }
  if (exportModeWatch.handled || exportInProgress) return;
  // Wait for a stable key and rendered messages so we never export the
  // previous conversation's DOM or an empty list.
  if (++exportModeWatch.stableTicks < 2 || !document.querySelector(SEL.messageGroups)) return;
  exportModeWatch.handled = true;
  startAutoExport(current.key).catch(err => console.error('[GCE] Auto-export error:', err));
}

// ── Message Listener ─────────────────────────────────────────

async function startExportRequest(options) {
  await loadSelectors();
  if (!isInChatFrame()) return { received: false, error: 'Open a conversation in Google Chat.' };
  if (exportInProgress) {
    return options.jobId && options.jobId === exportJobId
      ? { received: true, jobId: exportJobId }
      : { received: false, error: 'An export is already running in this conversation.' };
  }
  const jobId = /^job-[a-zA-Z0-9-]{1,96}$/.test(options.jobId) ? options.jobId : `job-${crypto.randomUUID()}`;
  runExport({
    format: options.format || 'txt',
    loadAll: options.loadAll !== false,
    includeMedia: options.includeMedia !== false,
    dateFrom: options.dateFrom || '',
    incremental: options.incremental === true,
    sourceUrl: options.sourceUrl || '',
    collectionWindow: options.collectionWindow === true,
    jobId
  }).catch(error => console.error('[GCE] Export error:', error));
  return { received: true, jobId };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'exportJobUpdate' && !sender.tab) {
    mirrorExportJob(msg.job);
    sendResponse({ received: true });
    return false;
  }
  if (msg.action === 'getExportJob') {
    sendResponse(!exportInProgress && msg.jobId && lastExportReport?.jobId === msg.jobId
      ? lastExportReport : { jobId: exportInProgress ? exportJobId : null, phase: exportPhase, ...lastExportProgress });
    return false;
  }
  if (msg.action === 'cancelExportJob') {
    const canCancel = msg.jobId === exportJobId && !!exportController;
    if (canCancel) exportController.abort();
    sendResponse({ success: canCancel });
    return false;
  }
  if (msg.action === 'ping') {
    sendResponse(getExportHealth());
    return false;
  }

  if (msg.action === 'startExport') {
    startExportRequest(msg).then(sendResponse, error => sendResponse({ received: false, error: error.message }));
    return true;
  }

  if (msg.action === 'exportModeChanged') {
    setExportModeEnabled(msg.enabled);
    sendResponse({ received: true });
    return false;
  }

  if (msg.action === 'getConversationName') {
    loadSelectors().then(() => {
      sendResponse({ name: getConversationName() });
    });
    return true;
  }

  return false;
});

// ── Init ─────────────────────────────────────────────────────

(async () => {
  await loadSelectors();
  if (isInChatFrame()) {
    console.log('[Google Chat Exporter] Content script active in chat frame');
    syncExportMode();
  }
  if (typeof setInterval === 'function') {
    setInterval(exportModeTick, 1000);
  }
})();
