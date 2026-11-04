'use strict';
GCETheme.bind(document.documentElement);

const params = new URLSearchParams(location.hash.slice(1));
const rawId = params.get('id') || '';
const downloadId = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
const channel = params.get('channel') || '';
const openButton = document.getElementById('open');
const heading = document.getElementById('heading');
const errorLabel = document.getElementById('error');
let ready = false;
let opening = false;
let generation = 0;

function notifyParent(action, extra = {}) {
  window.parent.postMessage({ action, downloadId, channel, ...extra }, '*');
}

function resizeResult() {
  notifyParent('gce:resize-result', { height: Math.ceil(document.body.getBoundingClientRect().height) });
}

function showError(message) {
  errorLabel.textContent = message;
  errorLabel.hidden = !message;
  resizeResult();
}

async function refreshDownload() {
  const current = ++generation;
  try {
    if (!Number.isSafeInteger(downloadId)) throw new Error('Export unavailable. Open it from your browser’s Downloads.');
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (current !== generation) return;
    // The frame URL is visible to its host page. Never let it select a file
    // downloaded by another extension or an ordinary web page.
    if (!item || item.byExtensionId !== chrome.runtime.id) throw new Error('Export unavailable. Open it from your browser’s Downloads.');
    document.getElementById('filename').textContent = item.filename.split(/[\\/]/).pop() || params.get('filename') || 'Export';
    ready = item.state === 'complete' && item.exists !== false;
    openButton.disabled = !ready || opening;
    heading.textContent = ready ? (params.get('warning') ? 'Export saved with warnings' : 'Export saved') : item.state === 'in_progress' ? 'Saving export…' : 'Export unavailable';
    if (item.state === 'interrupted') showError('Download interrupted. Check your browser’s Downloads.');
    else if (item.exists === false) showError('The exported file is no longer available. Check your browser’s Downloads.');
    else showError('');
  } catch (error) {
    if (current !== generation) return;
    ready = false;
    openButton.disabled = true;
    heading.textContent = 'Export unavailable';
    showError(error?.message || 'Could not read the export. Open it from your browser’s Downloads.');
  }
  resizeResult();
}

openButton.addEventListener('click', () => {
  if (!ready || opening) return;
  opening = true;
  openButton.disabled = true;
  showError('');
  // Invoke the API directly in this click handler, before any await/message,
  // so the native Open action retains the browser's required user gesture.
  let request;
  try { request = chrome.downloads.open(downloadId); }
  catch (error) { request = Promise.reject(error); }
  Promise.resolve(request).catch(() => {
    showError('Could not open the export. Open it from your browser’s Downloads.');
  }).finally(() => { opening = false; openButton.disabled = !ready; });
});

document.getElementById('close').addEventListener('click', () => notifyParent('gce:close-result'));
document.getElementById('filename').textContent = params.get('filename') || 'Export';
const warning = document.getElementById('warning');
warning.textContent = params.get('warning') || '';
warning.hidden = !warning.textContent;
document.getElementById('next').hidden = params.get('auto') !== '1';

const changed = delta => { if (delta.id === downloadId) refreshDownload(); };
const erased = id => { if (id === downloadId) refreshDownload(); };
chrome.downloads.onChanged.addListener(changed);
chrome.downloads.onErased.addListener(erased);
const observer = new ResizeObserver(resizeResult);
observer.observe(document.body);
window.addEventListener('pagehide', () => {
  observer.disconnect();
  chrome.downloads.onChanged.removeListener(changed);
  chrome.downloads.onErased.removeListener(erased);
});
refreshDownload();
