'use strict';

// Keep the Open click in an extension page: Firefox does not treat a click
// relayed from a content script as a user gesture for downloads.open().
function mountExportResult(host, result, onClose) {
  const frame = document.createElement('iframe');
  const channel = crypto.randomUUID();
  const params = new URLSearchParams({
    id: String(result.downloadId),
    channel,
    filename: result.filename || 'Export',
    warning: result.warning || '',
    auto: result.auto ? '1' : ''
  });
  frame.src = `${chrome.runtime.getURL('export-result.html')}#${params}`;
  frame.title = 'Export result';
  frame.style.cssText = 'display:block;width:100%;height:160px;border:0;background:transparent;color-scheme:light dark;';
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const listener = event => {
    // Firefox can hide the source window of extension-origin messages.
    if ((event.source !== null && event.source !== frame.contentWindow) || event.origin !== extensionOrigin ||
        event.data?.channel !== channel || event.data?.downloadId !== result.downloadId) return;
    if (event.data.action === 'gce:close-result') onClose();
    if (event.data.action === 'gce:resize-result' && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.max(80, Math.min(600, event.data.height))}px`;
    }
  };
  window.addEventListener('message', listener);
  host.appendChild(frame);
  return () => { window.removeEventListener('message', listener); frame.remove(); };
}
