// Read-only Chat web protocol. Keep positional fields here, outside job/UI code.
'use strict';

const ChatAPI = (() => {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
  const invalid = detail => { throw new Error(`Chat history response changed (${detail}). No export was saved. Please retry or use loaded messages.`); };
  const micros = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

  function address(href) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || !/^(chat|mail)\.google\.com(?:\.mcas\.ms)?$/.test(url.hostname)) return null;
      const match = `${url.pathname}${url.hash}`.match(/(?:#chat\/|\/app\/|\/)(dm|space|room|chat)\/([A-Za-z0-9_-]+)/);
      if (!match) return null;
      const account = url.pathname.match(/\/u\/(\d+)/)?.[1] || url.searchParams.get('authuser') || '0';
      if (!/^\d+$/.test(account)) return null;
      const origin = url.origin.replace('://mail.', '://chat.');
      return { origin, account, kind: match[1], groupId: match[2],
        // Keep explicit DM routes on the tested DOM path until their history
        // response shape has also been verified against the web protocol.
        supported: match[1] !== 'dm',
        url: `${origin}/u/${account}/${match[1] === 'dm' ? 'dm' : 'room'}/${match[2]}` };
    } catch { return null; }
  }

  function request() {
    const body = Array(100).fill(null);
    // Client capability 5 includes tombstones. Without it Chat omits deleted
    // replies while still counting them in the topic's advertised reply total.
    body[99] = [0, 3, 1, 'en', [null, null, null, null, null, 2]];
    return body;
  }

  function topicsRequest(group, before = '') {
    const body = request();
    body[1] = 100;
    body[3] = before ? [micros(before) || invalid('history cursor')] : null;
    body[4] = [3, 1, 4];
    body[5] = 1000;
    body[6] = 100;
    body[7] = [[group.groupId]];
    body[10] = 2;
    return body;
  }

  function messagesRequest(group, threadId, before) {
    if (!id(threadId)) invalid('thread ID');
    const body = request();
    body[0] = [null, null, null, [null, threadId, [[group.groupId]]]];
    body[1] = 100;
    body[3] = [null, null, micros(before) || invalid('reply cursor')];
    body[5] = [1];
    body[7] = 0;
    return body;
  }

  function groupMatches(value, group) {
    return Array.isArray(value) && value[0]?.[0] === group.groupId;
  }

  function mediaFromAnnotations(annotations, group) {
    const media = [];
    for (const annotation of annotations || []) {
      const image = annotation[0] === 1 && annotation[6];
      if (image && /^image\//.test(image[11] || '') && /^https:\/\//.test(image[2] || '')) {
        media.push({ type: image[11] === 'image/gif' ? 'gif' : 'image', name: image[7] || 'image',
          url: image[2], fallbackUrl: image[6]?.[2] || '', mimeType: image[11] });
      }
      if (annotation[0] === 2) {
        const drive = annotation[3], link = annotation[29]?.[0]?.[2];
        if (!Array.isArray(drive) || !/^https:\/\/drive\.google\.com\//.test(link || '')) invalid('Drive attachment metadata');
        media.push({ type: 'file', name: drive[1] || 'Drive attachment', url: link, mimeType: drive[3] || 'application/octet-stream' });
      }
      if (annotation[0] !== 13) continue;
      const file = annotation[9];
      if (!Array.isArray(file) || typeof file[0] !== 'string' || !file[0] || typeof file[3] !== 'string') invalid('attachment metadata');
      const mime = file[3];
      const url = new URL('/api/get_attachment_url', group.origin);
      url.search = new URLSearchParams({ url_type: mime.startsWith('image/') ? 'FIFE_URL' : 'DOWNLOAD_URL', content_type: mime,
        attachment_token: file[0], allow_caching: 'true', authuser: group.account }).toString();
      media.push({ type: mime === 'image/gif' ? 'gif' : mime.startsWith('image/') ? 'image' :
        mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file',
        name: file[2] || 'attachment', url: url.href, mimeType: mime });
    }
    return media;
  }

  function cardText(cards) {
    const lines = [];
    const plain = html => html.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
      .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&(?:#(\d+)|#x([a-f\d]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (match, decimal, hex, named) => {
        if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[named.toLowerCase()];
        const code = parseInt(decimal || hex, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }).trim();
    const visit = value => {
      if (!Array.isArray(value)) return;
      // Rich text is [HTML, styled spans]. Read the HTML once, rather than
      // repeating every styled fragment beneath it.
      if (typeof value[0] === 'string' && Array.isArray(value[1])) {
        const text = plain(value[0]);
        if (text) lines.push(text);
      } else for (const child of value) visit(child);
    };
    visit(cards);
    return lines.join('\n\n');
  }

  function message(row, group, threadId) {
    if (!Array.isArray(row) || !id(row[0]?.[1])) invalid('message ID');
    const topic = row[0]?.[0]?.[3];
    if (!groupMatches(topic?.[2], group)) invalid('message conversation');
    if (topic[1] !== threadId) invalid('message thread');
    const time = micros(row[2]);
    if (!time) invalid('message timestamp');
    if (row[9] != null && typeof row[9] !== 'string') invalid('message text');
    if (row[10] != null && !Array.isArray(row[10])) invalid('annotations');
    const deleted = !row[1] && !row[9] && !row[10] && !!micros(row[7]);
    const media = mediaFromAnnotations(row[10], group);
    let text = deleted ? '[Message deleted]' : row[9] || '';
    if (row[14]) {
      const card = cardText(row[14]);
      if (!card) invalid('unsupported rich card');
      text += `${text ? '\n\n' : ''}${card}`;
    }
    // Meeting cards can contain a link without a plain-text body.
    for (const annotation of row[10] || []) {
      const meeting = annotation[0] === 11 && annotation[11]?.[0];
      if (meeting && typeof meeting[2] === 'string' && !text.includes(meeting[2])) text += `${text ? '\n' : ''}${meeting[2]}`;
      if (annotation[0] === 14 && !text) {
        const users = annotation[13]?.[3]?.map(member => member?.[0]?.[0]).filter(value => typeof value === 'string') || [];
        text = `[Membership update${users.length ? `: ${users.join(', ')}` : ''}]`;
      }
    }
    // Keep unfamiliar bot/system payloads losslessly. Do not silently drop
    // their IDs or pretend their attachments were understood.
    const rawContent = !text && !media.length;
    if (rawContent) text = `[Structured Chat content]\n${JSON.stringify(row)}`;
    const absoluteTimestamp = Math.floor(time / 1000);
    const date = new Date(absoluteTimestamp).toISOString();
    return { messageId: row[0][1], threadId, ...(row[0][1] !== threadId ? { parentMessageId: threadId } : {}),
      sender: row[1]?.[1] || 'Unknown', avatar: row[1]?.[2] || '', text, media, deleted, rawContent,
      absoluteTimestamp, timestamp: date, date: date.slice(0, 10), _micros: String(time), _dedupKey: `${row[0][1]}/0` };
  }

  function response(data, tag) {
    const row = data?.[0];
    if (!Array.isArray(row) || row[0] !== tag || !Array.isArray(row[1])) invalid('schema');
    return row;
  }

  function topicsPage(data, group) {
    const row = response(data, 'dfe.t.lt');
    if (typeof row[4] !== 'boolean' || typeof row[5] !== 'boolean') invalid('history completion schema');
    if (!row[1].length && !row[4]) invalid('empty history page without completion');
    const topics = row[1].map(topic => {
      if (!Array.isArray(topic) || !id(topic[0]?.[1]) || !groupMatches(topic[0]?.[2], group)) invalid('topic conversation');
      const count = topic[10]?.[12]?.[0];
      if (!/^\d+$/.test(String(count)) || !Number.isSafeInteger(Number(count))) invalid('reply count');
      if (!micros(topic[14]) || !Array.isArray(topic[6])) invalid('topic history cursor');
      return { id: topic[0][1], created: String(topic[14]), latest: String(Math.max(micros(topic[1]), ...topic[6].map(row => micros(row[2]))) + 1), expectedReplies: Number(count),
        messages: topic[6].map(value => message(value, group, topic[0][1])) };
    });
    return { topics, atStart: row[4], cursor: topics.length ? String(Math.min(...topics.map(topic => Number(topic.created)))) : '' };
  }

  function messagesPage(data, group, threadId) {
    return response(data, 'dfe.m.lm')[1].map(row => message(row, group, threadId));
  }

  async function collect(group, call, progress, signal) {
    const messages = new Map(), topics = new Set();
    let before = '', complete = false, threadsScanned = 0;
    for (let pageNumber = 0; pageNumber < 2000; pageNumber++) {
      signal.throwIfAborted();
      const page = topicsPage(await call('list_topics', topicsRequest(group, before)), group);
      if (!page.atStart && before && Number(page.cursor) >= Number(before)) invalid('history pagination stalled');
      let added = 0;
      for (const topic of page.topics) {
        if (topics.has(topic.id)) continue;
        added++;
        const rows = new Map(topic.messages.map(row => [row.messageId, row]));
        if (rows.size < topic.expectedReplies + 1) {
          let cursor = topic.latest;
          for (let replyPage = 0; replyPage < 2000 && rows.size < topic.expectedReplies + 1; replyPage++) {
            signal.throwIfAborted();
            const replies = messagesPage(await call('list_messages', messagesRequest(group, topic.id, cursor)), group, topic.id);
            if (!replies.length) invalid('thread ended before its advertised reply count');
            const next = Math.min(...replies.map(row => Number(row._micros)));
            if (next >= Number(cursor)) invalid('reply pagination stalled');
            for (const row of replies) rows.set(row.messageId, row);
            cursor = String(next);
          }
        }
        if (!rows.has(topic.id) || rows.size !== topic.expectedReplies + 1) invalid('thread reply count changed or could not be verified');
        for (const row of rows.values()) {
          if (messages.has(row.messageId)) invalid('message belongs to multiple topics');
          messages.set(row.messageId, row);
        }
        topics.add(topic.id);
        if (topic.expectedReplies) threadsScanned++;
      }
      await progress({ pages: pageNumber + 1, topics: topics.size, messages: messages.size, threadsScanned });
      if (page.atStart) { complete = true; break; }
      if (!added || !page.cursor) invalid('history pagination stalled');
      before = page.cursor;
    }
    if (!complete) invalid('history traversal limit');
    const rawCount = [...messages.values()].filter(row => row.rawContent).length;
    return { messages: [...messages.values()].sort((a, b) => a.absoluteTimestamp - b.absoluteTimestamp || a.messageId.localeCompare(b.messageId)),
      reason: 'api-complete', threadsComplete: true, threadsScanned, threadFailures: [],
      warning: rawCount ? `${rawCount} message(s) contain unfamiliar Chat content, preserved as structured data. The checkpoint will not advance.` : '' };
  }

  return { address, topicsRequest, messagesRequest, topicsPage, messagesPage, collect };
})();
