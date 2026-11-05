// History collection owns an inactive authenticated Chat tab, never its DOM.
'use strict';

const BackgroundCollector = (() => {
  // This function is injected into Chat's MAIN world. Credentials stay there;
  // only read-only responses cross back to the extension's worker.
  async function pageRead({ operation, group, body, url, mimeType }) {
    if (location.origin !== group.origin || !/^(chat)\.google\.com(?:\.mcas\.ms)?$/.test(location.hostname)) {
      return { error: 'The background Chat tab changed location. Please retry.' };
    }
    const account = location.pathname.match(/\/u\/(\d+)/)?.[1] || new URL(location.href).searchParams.get('authuser') || '0';
    if (account !== group.account) return { error: 'The background Chat tab opened a different account. Please retry.' };
    const token = globalThis.WIZ_global_data?.SMqcke;
    if (operation === 'ready') return { ready: typeof token === 'string' && !!token };
    if (operation !== 'media' && !['list_topics', 'list_messages'].includes(operation)) return { error: 'Unsupported Chat read request.' };
    if (!token) return { error: 'Chat sign-in expired. Sign in and retry the export.' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      let target, options;
      if (operation === 'media') {
        target = new URL(url);
        const localAttachment = target.origin === group.origin && target.pathname === '/api/get_attachment_url';
        const imageHost = /^(?:[a-z0-9-]+\.)*googleusercontent\.com(?:\.mcas\.ms)?$/.test(target.hostname) || /^(?:c|media)\.tenor\.com$/.test(target.hostname);
        if (target.protocol !== 'https:' || (!localAttachment && !imageHost)) return { error: 'This attachment must be opened through its original link.' };
        options = { credentials: 'include', signal: controller.signal };
      } else {
        target = new URL(`/u/${group.account}/api/${operation}`, location.origin);
        options = { method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-framework-xsrf-token': token }, body: JSON.stringify(body) };
      }
      const response = await fetch(target.href, options);
      if (!response.ok) return { status: response.status, error: `Chat read request failed (HTTP ${response.status}). Please retry.` };
      if (operation === 'media') {
        const type = response.headers.get('content-type') || 'application/octet-stream';
        if (type.includes('text/html') && mimeType !== 'text/html') return { error: 'Chat returned a sign-in or policy page instead of an attachment.' };
        if (/^(image|audio|video)\//.test(mimeType || '') && !/^(image|audio|video)\//.test(type) && !type.includes('application/octet-stream')) {
          return { error: 'Chat returned an unexpected attachment type.' };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) return { error: 'Empty attachment response.' };
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { success: true, base64: btoa(binary), mimeType: type };
      }
      const text = await response.text();
      try { return { data: JSON.parse(text.replace(/^\)\]\}'\s*/, '')) }; }
      catch { return { error: 'Chat returned a sign-in or policy page instead of history. No export was saved.' }; }
    } catch (error) {
      return { error: error.name === 'AbortError' ? 'Chat read request timed out. Please retry.' : 'Could not read Chat history. Check your connection and retry.' };
    } finally { clearTimeout(timeout); }
  }

  async function read(tabId, group, signal, operation, body = null, media = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let timer;
      let result;
      try {
        const results = await Promise.race([
          chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: pageRead,
            args: [{ operation, group, body, url: media?.url, mimeType: media?.mimeType }] }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The background Chat tab stopped responding. Please retry.')), 35000); })
        ]);
        result = results?.[0]?.result;
      } catch (error) {
        signal.throwIfAborted();
        throw Object.assign(new Error('Export interrupted: its background Chat tab stopped responding. Please retry.'), { name: 'ChatContextLost' });
      } finally { clearTimeout(timer); }
      signal.throwIfAborted();
      if ([429, 502, 503, 504].includes(result?.status) && attempt < 2) {
        await delay(1000 * 2 ** attempt, signal);
        continue;
      }
      if (!result) throw Object.assign(new Error('Export interrupted: its background Chat tab was reloaded or closed. Please retry.'), { name: 'ChatContextLost' });
      if (result.error) throw new Error(result.error);
      return result;
    }
  }

  function delay(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  const fingerprint = row => hash(JSON.stringify([row.messageId, row.text, row.media.map(file => [file.type, file.name])]));

  async function select(messages, previous, dateFrom) {
    const since = previous?.timestamp || (dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : 0);
    if (dateFrom && !Number.isFinite(since)) throw new Error('Choose a valid start date.');
    const boundary = new Set(previous?.fingerprints || []), selected = [];
    for (const row of messages) {
      if (row.absoluteTimestamp < since) continue;
      if (previous && row.absoluteTimestamp === since && boundary.has(await fingerprint(row))) continue;
      selected.push(row);
    }
    const ids = new Set(selected.map(row => row.messageId));
    const parents = new Set(selected.map(row => row.parentMessageId).filter(id => id && !ids.has(id)));
    return [...messages.filter(row => parents.has(row.messageId)).map(row => ({ ...row, contextOnly: true })), ...selected];
  }

  async function checkpoint(messages, previous) {
    const timestamp = messages.reduce((max, row) => row.contextOnly ? max : Math.max(max, row.absoluteTimestamp), previous?.timestamp || 0);
    if (!timestamp) return null;
    const fingerprints = [...new Set([...(previous?.timestamp === timestamp ? previous.fingerprints : []),
      ...await Promise.all(messages.filter(row => !row.contextOnly && row.absoluteTimestamp === timestamp).map(fingerprint))])];
    return fingerprints.length <= 5000 ? { timestamp, fingerprints, undatedFingerprints: [] } : null;
  }

  async function start(sourceTabId, frame, format, settings, jobId, packagePayload) {
    const group = ChatAPI.address(frame.conversationUrl || settings.sourceUrl);
    if (!group?.supported) throw new Error('This conversation does not support background history collection.');
    const existing = await ExportJobs.getJob(jobId);
    if (existing) {
      if (existing.sourceTabId === sourceTabId && ['working', 'paused'].includes(existing.state)) return { received: true, jobId };
      throw new Error('This export request was already used. Start a new export.');
    }
    const source = await chrome.tabs.get(sourceTabId);
    const controller = new AbortController();
    await ExportJobs.createBackground(jobId, { sourceTabId, sourceFrameId: frame.frameId,
      sourceWindowId: source.windowId, conversationName: frame.name }, () => controller.abort());
    // The popup receives acceptance immediately; progress and lifetime belong
    // to the worker, so closing the popup/source cannot cancel collection.
    run(source, frame, group, format, settings, jobId, controller.signal, packagePayload)
      .catch(error => console.error('[GCE] Could not retain export outcome:', error));
    return { received: true, jobId };
  }

  async function run(source, frame, group, format, settings, jobId, signal, packagePayload) {
    let unregisteredTab;
    const keepAlive = setInterval(() => { chrome.storage.local.get('gceExportJobs').catch(() => {}); }, 20000);
    try {
      signal.throwIfAborted();
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: source.windowId,
        ...(source.cookieStoreId ? { cookieStoreId: source.cookieStoreId } : {}) });
      unregisteredTab = tab.id;
      await ExportJobs.attachBackgroundTab(jobId, tab);
      unregisteredTab = undefined;
      signal.throwIfAborted();
      await chrome.tabs.update(tab.id, { url: group.url, autoDiscardable: false });
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const current = await chrome.tabs.get(tab.id);
        if (current.status === 'complete') {
          const result = await read(tab.id, group, signal, 'ready');
          if (result.ready) { ready = true; break; }
        }
        await delay(250, signal);
      }
      if (!ready) throw new Error('Chat did not load in the background tab. Check your sign-in and retry.');
      await ExportJobs.backgroundProgress(jobId, { phase: 'history', text: 'Loading messages…', percent: 2 });
      const includeMedia = format === 'html' && settings.includeMedia !== false;
      // API timestamps/identities establish a fresh baseline independent of
      // the older DOM fingerprints and its heuristic history completion.
      const key = `gceCheckpoint:${await hash(`api-v1|${group.origin}|${group.account}|${group.groupId}|${format}|${includeMedia}`)}`;
      const previous = settings.incremental ? (await chrome.storage.local.get(key))[key] : null;
      const history = await ChatAPI.collect(group, async (operation, body) => (await read(tab.id, group, signal, operation, body)).data,
        async counts => {
          await ExportJobs.backgroundProgress(jobId, { phase: 'history',
            text: `Loaded ${counts.messages.toLocaleString()} messages · ${counts.topics.toLocaleString()} topics`,
            percent: Math.min(65, 5 + counts.pages) });
        }, signal);
      signal.throwIfAborted();
      const messages = await select(history.messages, previous, settings.incremental ? '' : settings.dateFrom);
      if (!messages.length) { await ExportJobs.backgroundEmpty(jobId); return; }
      if (previous) history.since = previous.timestamp;
      const mediaFiles = [];
      let mediaFailed = false;
      if (includeMedia) {
        const media = messages.flatMap(row => row.media);
        let next = 0, completed = 0;
        const worker = async () => {
          while (next < media.length) {
            signal.throwIfAborted();
            const index = next++, file = media[index];
            try {
              let result;
              try { result = await read(tab.id, group, signal, 'media', null, file); }
              catch (error) {
                signal.throwIfAborted();
                if (error.name === 'ChatContextLost') throw error;
                if (!file.fallbackUrl) throw error;
                result = await read(tab.id, group, signal, 'media', null, { ...file, url: file.fallbackUrl });
              }
              const name = (file.name || `media_${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
              file._localPath = `media/${index + 1}_${name}`;
              mediaFiles.push({ path: file._localPath, base64: result.base64, mimeType: result.mimeType });
            } catch (error) {
              signal.throwIfAborted();
              if (error.name === 'ChatContextLost') throw error;
              mediaFailed = true;
            }
            completed++;
            await ExportJobs.backgroundProgress(jobId, { phase: 'media', text: `Downloading attachments ${completed}/${media.length}`, percent: 65 + Math.round(20 * completed / media.length) });
          }
        };
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, media.length) }, worker));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
      if (mediaFailed) history.warning = `${history.warning} Some attachments failed; the checkpoint will not advance.`.trim();
      const candidate = !mediaFailed && !history.warning ? await checkpoint(messages, previous) : null;
      signal.throwIfAborted();
      await ExportJobs.beginBackgroundPackaging(jobId);
      const result = await packagePayload(format, { conversationName: frame.name || 'Google Chat', messages, mediaFiles,
        exportDate: new Date().toISOString(), history: { ...history, messages: undefined },
        checkpoint: candidate ? { key, value: candidate } : null });
      await ExportJobs.backgroundDownloaded(jobId, { ...result, warning: [history.warning, result.checkpointWarning].filter(Boolean).join(' ') });
    } catch (error) {
      await ExportJobs.backgroundFailed(jobId, error);
    } finally {
      clearInterval(keepAlive);
      if (unregisteredTab !== undefined) await chrome.tabs.remove(unregisteredTab).catch(() => {});
    }
  }

  return { start, pageRead };
})();
