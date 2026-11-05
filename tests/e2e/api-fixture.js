'use strict';

function createAPI(png) {
  const state = { calls: [], delay: 0, mediaDelay: 0, mediaCalls: 0, failure: '', newMessage: false, media: false, mediaFail: false, throttled: false };
  const epoch = Date.UTC(2026, 0, 1);
  const message = (id, parent, time, text, deleted = false) => {
    const row = Array(34).fill(null);
    row[0] = [[null, null, null, [null, parent, [['ROOM']]]], id];
    row[1] = deleted ? null : [['user'], 'Alice'];
    row[2] = String(time * 1000); row[9] = deleted ? null : text;
    if (deleted) row[7] = String((time + 1) * 1000);
    return row;
  };
  const topics = () => {
    const result = Array.from({ length: state.newMessage ? 9 : 8 }, (_, i) => {
      const id = i === 8 ? 'new-message' : `parent-${i}`, time = epoch + (i === 8 ? 10 : i) * 86400000;
      const row = Array(15).fill(null); row[0] = [null, id, [['ROOM']]]; row[14] = String(time * 1000);
      const root = message(id, id, time, `Message ${i}: café 日本語 <script>literal</script>`);
      if (i === 7 && state.media) {
        const attachment = Array(10).fill(null); attachment[0] = 13;
        attachment[9] = ['synthetic-attachment', null, 'café.png', 'image/png']; root[10] = [attachment];
      }
      row[6] = [root];
      if (i === 0 || i === 6) row[6].push(message(`${id}-reply-1`, id, time + 1000, 'First reply'),
        message(`${id}-deleted`, id, time + 2000, '', true),
        message(`${id}-reply-2`, id, epoch + 9 * 86400000, 'A recent reply to an older parent'));
      row[1] = String(Math.max(...row[6].map(m => Number(m[2]))));
      row[10] = Array(13).fill(null); row[10][12] = [String(row[6].length - 1)];
      return row;
    });
    return result.sort((a, b) => Number(b[14]) - Number(a[14]));
  };
  const handler = async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/get_attachment_url') {
      state.mediaCalls++;
      if (state.mediaDelay) await new Promise(resolve => setTimeout(resolve, state.mediaDelay));
      return route.fulfill({ status: state.mediaFail ? 403 : 200, contentType: 'image/png', body: png });
    }
    const body = route.request().postDataJSON(), operation = url.pathname.split('/').at(-1);
    state.calls.push({ operation, body, account: url.pathname.split('/')[2] });
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.failure === 'policy') return route.fulfill({ contentType: 'text/html', body: 'Policy page' });
    if (state.failure === 'auth') return route.fulfill({ status: 401, body: 'Sign in' });
    if (state.failure === 'throttle' && !state.throttled) { state.throttled = true; return route.fulfill({ status: 429, body: 'Retry' }); }
    let data;
    if (operation === 'list_topics') {
      const all = topics(), before = body[3]?.[0];
      const eligible = before ? all.filter(t => Number(t[14]) < before) : all;
      const rows = eligible.slice(0, 4).map(t => structuredClone(t));
      for (const row of rows) if (row[6].length > 1) row[6] = [row[6][0]];
      data = ['dfe.t.lt', rows, ['1'], ['2'], eligible.length <= 4, !before, [false]];
      if (state.failure === 'schema') data[4] = null;
      if (state.failure === 'stall') data[4] = false;
    } else if (operation === 'list_messages') {
      const thread = body[0][3][1], before = body[3][2];
      const rows = topics().find(t => t[0][1] === thread)[6].filter(m => Number(m[2]) < before).sort((a, b) => Number(b[2]) - Number(a[2])).slice(0, 2);
      data = ['dfe.m.lm', state.failure === 'replies' ? [] : rows, ['1']];
    } else return route.fulfill({ status: 405 });
    return route.fulfill({ contentType: 'application/json', body: ")]}'\n" + JSON.stringify([data]) });
  };
  return { state, handler, expected: () => topics().flatMap(t => t[6].map(m => m[0][1])) };
}

module.exports = { createAPI };
