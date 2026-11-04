// ============================================================
// Google Chat Exporter v2.1 — popup.js
// ============================================================

'use strict';

const $ = id => document.getElementById(id);
const UPDATE_REQUIRED = 'Reload the extension, then refresh the Chat tab.';
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

// The UI has one range control; stored flags stay compatible with context-menu
// and automatic exports, including loaded messages filtered by date.
let settingsRevision = 0;
let settingsQueue = Promise.resolve();
let conversationReady = false;
const datedRange = range => range === 'since' || range === 'visible-since';

function readSettings() {
  const range = $('range-select').value;
  return {
    format: $('format-select').value,
    loadAll: range !== 'visible' && range !== 'visible-since',
    includeMedia: $('include-media').checked,
    dateFrom: datedRange(range) ? $('date-from').value : '',
    incremental: range === 'new'
  };
}

async function loadSettings() {
  const revision = settingsRevision;
  try {
    const { gceSettings: settings = {} } = await chrome.storage.local.get('gceSettings');
    if (revision !== settingsRevision) return;
    if (['txt', 'md', 'html'].includes(settings.format)) $('format-select').value = settings.format;
    $('include-media').checked = settings.includeMedia !== false;
    $('date-from').value = settings.dateFrom || '';
    $('range-select').value = settings.incremental ? 'new' : settings.loadAll === false
      ? (settings.dateFrom ? 'visible-since' : 'visible') : (settings.dateFrom ? 'since' : 'all');
    updateRangeControls();
    updateMediaRowVisibility();
  } catch {
    $('settings-error').textContent = 'Could not load saved settings.';
    $('settings-error').hidden = false;
  }
}

function saveSettings() {
  const settings = readSettings();
  settingsRevision++;
  const saved = settingsQueue.then(() => chrome.storage.local.set({ gceSettings: settings }));
  settingsQueue = saved.catch(() => {});
  return saved.then(() => { $('settings-error').hidden = true; return true; }, () => {
    $('settings-error').textContent = 'Could not save settings. Try again.';
    $('settings-error').hidden = false;
    return false;
  });
}

function updateMediaRowVisibility() {
  const available = $('format-select').value === 'html';
  $('media-row').hidden = !available;
  $('include-media').disabled = !available;
}

function updateRangeControls() {
  const dated = datedRange($('range-select').value);
  $('date-row').hidden = !dated;
  $('date-from').disabled = !dated;
  $('date-from').required = dated;
}

async function detectConversation() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) throw new Error('Open a conversation in Google Chat.');
    const response = await chrome.runtime.sendMessage({ action: 'getConversation', tabId: tab.id });
    if (response?.protocol !== 2) throw new Error(UPDATE_REQUIRED);
    if (!response?.success) throw new Error(response?.error || 'Could not connect to Chat. Refresh the Chat tab and retry.');
    setConvStatus(true, response.name || 'Google Chat');
  } catch (error) {
    setConvStatus(false, 'Google Chat');
    $('connection-error').textContent = error.message;
    $('connection-error').hidden = false;
  }
}

function setConvStatus(ready, name) {
  conversationReady = ready;
  $('conv-name').textContent = name;
  $('connection-error').hidden = ready;
  if (!isExporting) resetBtn();
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
    if (enabled && !await saveSettings()) {
      $('export-mode').checked = false;
      return;
    }
    const resp = await chrome.runtime.sendMessage({ action: 'setExportMode', enabled });
    $('export-mode').checked = resp?.enabled === true;
  } catch {
    $('export-mode').checked = !enabled;
    $('settings-error').textContent = 'Could not change auto-export. Try again.';
    $('settings-error').hidden = false;
  }
}

// ── Export ───────────────────────────────────────────────────

let isExporting = false;

let pendingJobId = null;
let pendingStartTimer = null;

function clearPendingStart() {
  pendingJobId = null;
  clearTimeout(pendingStartTimer);
  pendingStartTimer = null;
}

async function triggerExport() {
  if (isExporting) return;
  const jobId = `job-${crypto.randomUUID()}`;
  pendingJobId = jobId;
  visibleJobId = null;
  $('job-controls').hidden = true;
  setExporting();
  showStatus('Starting export…', 0);
  pendingStartTimer = setTimeout(() => {
    if (pendingJobId !== jobId) return;
    clearPendingStart();
    showStatus('No progress received. Return to Chat and retry.', 0, 'error');
    resetBtn();
  }, 8000);
  try {
    const settings = readSettings();
    if (datedRange($('range-select').value) && !settings.dateFrom) throw new Error('Choose a start date.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.match(/^https:\/\/(chat|mail)\.google\.com(?:\.mcas\.ms)?(?:\/|$)/)) throw new Error('Open a conversation in Google Chat.');
    const response = await chrome.runtime.sendMessage({ action: 'popupExport', jobId, tabId: tab.id, format: settings.format, settings });
    if (!response?.success) throw new Error(response?.error || 'Could not start export. Try again.');
    if (response.protocol !== 2 || response.jobId !== jobId) throw new Error(UPDATE_REQUIRED);
    if (pendingJobId !== jobId && !exportJobs.has(jobId)) return;
    renderExportJobs();
  } catch (error) {
    if (pendingJobId !== jobId) {
      if (exportJobs.has(jobId)) renderExportJobs();
      return;
    }
    clearPendingStart();
    if (exportJobs.has(jobId) || [...exportJobs.values()].some(jobActive)) { renderExportJobs(); return; }
    showStatus(error.message, 0, 'error');
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
  btn.disabled = !conversationReady;
  btn.textContent = 'Export';
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
  $('status-area').setAttribute('data-state', state);
  $('progress-track').setAttribute('aria-valuenow', String(Math.round(safePercent)));
  $('progress-track').setAttribute('aria-valuetext', text);
  const bar = $('progress-bar');
  bar.style.width = safePercent + '%';
  bar.className = 'progress-bar' + (state === 'done' ? ' done' : state === 'error' ? ' error' : '');
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
  if (pendingJobId) {
    if (!exportJobs.has(pendingJobId)) return;
    clearPendingStart();
  }
  const all = [...exportJobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  const activeJob = all.find(job => jobActive(job) && job.phase !== 'download');
  if (activeJob) setExporting(activeJob.phase === 'packaging' ? 'Preparing file' : 'Exporting');
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
  $('job-name').hidden = !job.conversationName || job.conversationName === $('conv-name').textContent;
  $('job-controls').hidden = jobActive(job) && job.phase === 'packaging';
  $('return-to-chat').hidden = !jobActive(job) || job.phase === 'packaging';
  $('return-to-chat').textContent = job.collectionWindowId === undefined ? 'Return to Chat' : 'Show export';
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
    if (msg.jobId || pendingJobId || [...exportJobs.values()].some(jobActive)) return;
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

document.addEventListener('DOMContentLoaded', () => {
  $('export-btn').addEventListener('click', triggerExport);
  $('format-select').addEventListener('change', () => { updateMediaRowVisibility(); saveSettings(); });
  $('range-select').addEventListener('change', () => { updateRangeControls(); saveSettings(); });
  $('include-media').addEventListener('change', saveSettings);
  $('date-from').addEventListener('change', saveSettings);
  $('export-mode').addEventListener('change', toggleExportMode);
  $('dark-mode').addEventListener('change', toggleDarkMode);
  $('return-to-chat').addEventListener('click', () => controlExportJob('focusExportJob'));
  $('cancel-export').addEventListener('click', () => controlExportJob('cancelExportJob'));
  $('dismiss-status').addEventListener('click', () => dismissExportJob());
  loadSettings();
  detectConversation();
  loadExportMode();
  loadExportJobs();
});
