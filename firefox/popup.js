// ============================================================
// Google Chat Exporter v2.1 — popup.js
// ============================================================

'use strict';

const $ = id => document.getElementById(id);
GCETheme.bind(document.documentElement);
GCETheme.subscribe(theme => { $('dark-mode').checked = theme === 'dark'; });

async function toggleDarkMode() {
  $('theme-error').hidden = true;
  try { await GCETheme.set($('dark-mode').checked ? 'dark' : 'light'); }
  catch {
    $('theme-error').textContent = 'Could not save the theme. Try again.';
    $('theme-error').hidden = false;
  }
}

// ── Settings persistence ─────────────────────────────────────

async function loadSettings() {
  try {
    const { gceSettings } = await chrome.storage.local.get('gceSettings');
    const s = gceSettings || {};
    if (s.format) $('format-select').value = s.format;
    if (typeof s.loadAll !== 'undefined') $('load-all').checked = s.loadAll;
    if (typeof s.includeMedia !== 'undefined') $('include-media').checked = s.includeMedia;
    if (s.dateFrom) $('date-from').value = s.dateFrom;
    $('incremental').checked = s.incremental === true;
    updateIncrementalControls();
    updateMediaRowVisibility();
  } catch { /* storage not accessible */ }
}

function saveSettings() {
  const settings = {
    format: $('format-select').value,
    loadAll: $('load-all').checked,
    includeMedia: $('include-media').checked,
    dateFrom: $('date-from').value,
    incremental: $('incremental').checked
  };
  chrome.storage.local.set({ gceSettings: settings }).catch(() => {});
}

function updateMediaRowVisibility() {
  const isHtml = $('format-select').value === 'html';
  if (isHtml) $('media-row').classList.remove('is-disabled');
  else $('media-row').classList.add('is-disabled');
  $('include-media').disabled = !isHtml;
}

function updateIncrementalControls() {
  const enabled = $('incremental').checked;
  $('load-all').disabled = enabled;
  $('date-from').disabled = enabled;
  for (const id of ['history-row', 'date-row']) {
    if (enabled) $(id).classList.add('is-disabled');
    else $(id).classList.remove('is-disabled');
  }
}

// ── Conversation Status Bar ──────────────────────────────────

async function detectConversation() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || !tab.url?.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) {
      setConvStatus(false, 'Not on Google Chat');
      return;
    }

    // Try to get conversation name from content script
    chrome.tabs.sendMessage(tab.id, { action: 'getConversationName' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setConvStatus(true, 'Google Chat — open a conversation');
        return;
      }
      const name = resp.name;
      if (name) {
        setConvStatus(true, name);
      } else {
        setConvStatus(true, 'Google Chat — open a conversation');
      }
    });
  } catch {
    setConvStatus(false, 'Not on Google Chat');
  }
}

function setConvStatus(online, name) {
  const dot = $('conv-dot');
  const label = $('conv-name');
  dot.className = 'conv-dot' + (online ? '' : ' offline');
  label.textContent = name;
  label.className = 'conv-name' + (online ? '' : ' muted');
}

// ── Export Mode ──────────────────────────────────────────────

async function loadExportMode() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getExportMode' });
    $('export-mode').checked = resp?.enabled === true;
  } catch { /* service worker unavailable */ }
}

async function toggleExportMode() {
  const enabled = $('export-mode').checked;
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'setExportMode', enabled });
    $('export-mode').checked = resp?.enabled === true;
    if (resp?.enabled && !visibleJobId && !isExporting) showStatus('Auto-export is on. Open a channel to save it.', 100, 'done');
  } catch {
    $('export-mode').checked = !enabled;
  }
}

// ── Export ───────────────────────────────────────────────────

let isExporting = false;

async function triggerExport() {
  if (isExporting) return;
  visibleJobId = null;
  $('job-controls').hidden = true;
  setExporting();

  showStatus('Starting export...', 2);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab) {
      throw new Error('No active tab found.');
    }

    if (!tab.url?.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) {
      throw new Error('Please navigate to Google Chat first.');
    }

    const format = $('format-select').value;
    const loadAll = $('load-all').checked;
    const includeMedia = $('include-media').checked;
    const dateFrom = $('date-from').value;

    const incremental = $('incremental').checked;
    const settings = { loadAll, includeMedia, dateFrom, incremental };

    const response = await chrome.runtime.sendMessage({
      action: 'popupExport',
      format,
      tabId: tab.id,
      settings
    }).catch(err => ({ success: false, error: err?.message }));

    if (!response?.success) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'startExport',
        format,
        loadAll,
        includeMedia,
        dateFrom,
        incremental
      }, () => {
        if (chrome.runtime.lastError) {
          showStatus(response?.error || 'Could not start export', 0, 'error');
          resetBtn();
        }
      });
    }

  } catch (err) {
    showStatus(err.message, 0, 'error');
    resetBtn();
  }
}

function setExporting(label = 'Exporting') {
  isExporting = true;

  const btn = $('export-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${label}</span>`;
}

function resetBtn() {
  isExporting = false;
  const btn = $('export-btn');
  btn.disabled = false;
  btn.textContent = 'Export conversation';
}

// ── Status / Progress ────────────────────────────────────────

let resultCleanup = null;
let resultDownloadId = null;
let statusHideTimer = null;
const dismissedResults = new Set();

function hideExportResult(dismiss = false) {
  if (dismiss && resultDownloadId !== null) dismissedResults.add(resultDownloadId);
  resultCleanup?.();
  resultCleanup = null;
  resultDownloadId = null;
  $('export-result').hidden = true;
}

function showExportResult(result) {
  if (dismissedResults.has(result.downloadId)) return;
  hideStatus();
  if (resultDownloadId === result.downloadId) return;
  hideExportResult();
  resultDownloadId = result.downloadId;
  $('export-result').hidden = false;
  resultCleanup = mountExportResult($('export-result'), result, () => {
    hideExportResult(true);
    if (result.jobId) dismissExportJob(result.jobId);
  });
}

function showStatus(text, percent, state = 'working') {
  clearTimeout(statusHideTimer);
  statusHideTimer = null;
  hideExportResult();
  $('status-area').classList.add('visible');
  $('job-name').hidden = true;
  $('status-text').textContent = text;
  const safePercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : 0;
  $('status-value').textContent = state === 'paused' ? 'Paused' : state === 'error' ? 'Failed' : `${Math.round(safePercent)}%`;
  const bar = $('progress-bar');
  bar.style.width = safePercent + '%';
  bar.className = 'progress-bar' + (state === 'done' ? ' done' : state === 'error' ? ' error' : '');

  const spinner = $('status-spinner');
  spinner.style.display = (state === 'done' || state === 'error' || state === 'paused') ? 'none' : 'block';
}

function hideStatus() {
  clearTimeout(statusHideTimer);
  statusHideTimer = null;
  $('status-area').classList.remove('visible');
  $('progress-bar').style.width = '0%';
  $('progress-bar').className = 'progress-bar';
  $('job-controls').hidden = true;
}

// Progress belongs to the background, so it survives closing this popup.
const exportJobs = new Map();
const dismissedJobs = new Set();
let visibleJobId = null;
const jobActive = job => job.state === 'working' || job.state === 'paused';

function mergeExportJob(job) {
  if (!job?.jobId || (exportJobs.get(job.jobId)?.revision || 0) >= job.revision) return;
  exportJobs.set(job.jobId, job);
}

function renderExportJobs() {
  const all = [...exportJobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  const activeJob = all.find(job => jobActive(job) && job.phase !== 'download');
  if (activeJob) setExporting(activeJob.phase === 'download' ? 'Saving export' : activeJob.phase === 'packaging' ? 'Preparing file' : 'Exporting');
  else resetBtn();
  const available = all.filter(job => !dismissedJobs.has(job.jobId) && !job.acknowledged);
  const job = available.find(jobActive) || available[0];
  const hadJob = visibleJobId !== null;
  visibleJobId = job?.jobId || null;
  if (!job) {
    if (hadJob) { hideStatus(); hideExportResult(); }
    return;
  }
  if (Number.isSafeInteger(job.downloadId)) {
    showExportResult(job);
    return;
  }
  showStatus(job.text, job.percent, job.state);
  $('job-name').textContent = job.conversationName;
  $('job-name').hidden = false;
  $('job-controls').hidden = jobActive(job) && job.phase === 'packaging';
  $('return-to-chat').hidden = !jobActive(job) || job.phase === 'packaging';
  $('cancel-export').hidden = !jobActive(job) || job.phase === 'packaging';
  $('dismiss-status').hidden = jobActive(job);
}

async function loadExportJobs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getExportJobs' });
    for (const job of response?.jobs || []) mergeExportJob(job);
    renderExportJobs();
  } catch { /* Older background scripts still relay live progress. */ }
}

function dismissExportJob(jobId = visibleJobId) {
  if (!jobId) return;
  dismissedJobs.add(jobId);
  chrome.runtime.sendMessage({ action: 'acknowledgeExportJob', jobId }).catch(() => {});
  renderExportJobs();
}

async function controlExportJob(action) {
  if (!visibleJobId) return;
  try {
    await chrome.runtime.sendMessage({ action, jobId: visibleJobId });
  } catch { /* Refresh below reports a lost Chat tab. */ }
  await loadExportJobs();
}

// ── Background message relay (progress updates from content) ─

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'exportJobUpdate') {
    mergeExportJob(msg.job);
    renderExportJobs();
    return;
  }
  if (msg.action === 'exportModeChanged') {
    $('export-mode').checked = msg.enabled === true;
    return;
  }
  if (msg.action === 'exportStateUpdate') {
    if (msg.jobId) return; // The background publishes the persisted, canonical status.
    if (msg.state === 'done' && Number.isSafeInteger(msg.downloadId) && msg.downloadId >= 0) {
      if (dismissedResults.has(msg.downloadId)) return;
      resetBtn();
      showExportResult(msg);
      return;
    }
    showStatus(msg.text || '', msg.percent || 0, msg.state || 'working');
    if (msg.state === 'done') {
      resetBtn();
      statusHideTimer = setTimeout(hideStatus, 3500);
    } else if (msg.state === 'error') {
      resetBtn();
      statusHideTimer = setTimeout(hideStatus, 5000);
    }
  }
});

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  detectConversation();
  loadExportMode();
  loadExportJobs();

  $('export-btn').addEventListener('click', triggerExport);
  $('format-select').addEventListener('change', () => {
    updateMediaRowVisibility();
    saveSettings();
  });
  $('load-all').addEventListener('change', saveSettings);
  $('include-media').addEventListener('change', saveSettings);
  $('date-from').addEventListener('change', saveSettings);
  $('incremental').addEventListener('change', () => { updateIncrementalControls(); saveSettings(); });
  $('export-mode').addEventListener('change', toggleExportMode);
  $('dark-mode').addEventListener('change', toggleDarkMode);
  $('return-to-chat').addEventListener('click', () => controlExportJob('focusExportJob'));
  $('cancel-export').addEventListener('click', () => controlExportJob('cancelExportJob'));
  $('dismiss-status').addEventListener('click', () => dismissExportJob());
});
