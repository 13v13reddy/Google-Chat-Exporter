'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function message(id, topic = 'parent', text = 'Hello', extra = {}) {
  const row = Array(34).fill(null);
  row[0] = [[null, null, null, [null, topic, [['space']]]], id];
  row[1] = [['user'], 'A Person', 'https://lh3.googleusercontent.com/avatar'];
  row[2] = '1700000000000001';
  row[9] = text;
  for (const [index, value] of Object.entries(extra)) row[index] = value;
  return row;
}

function topic(id = 'parent', replies = 1) {
  const row = Array(15).fill(null);
  row[0] = [null, id, [['space']]];
  row[6] = [message(id, id), message('reply', id)];
  row[10] = Array(13).fill(null);
  row[10][12] = [String(replies), '0', null, null, '0'];
  row[14] = '1700000000000001';
  return row;
}

function fixture(target) {
  const context = vm.createContext({ URL, URLSearchParams, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', target, 'chat-api.js'), 'utf8'), context);
  return vm.runInContext('ChatAPI', context);
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: API requests preserve account/group boundaries and ask for deleted placeholders`, () => {
    const api = fixture(target);
    const address = api.address('https://chat.google.com.mcas.ms/u/2/room/space/thread/parent');
    assert.equal(address.account, '2');
    assert.equal(address.groupId, 'space');
    const req = api.topicsRequest(address, '1700000000000001');
    assert.equal(req[3][0], 1700000000000001);
    assert.equal(req[7][0][0], 'space');
    assert.equal(req[99][4][5], 2);
    assert.equal(api.address('https://evil.test/app/chat/space'), null);
    assert.equal(api.address('https://chat.google.com/app/'), null);
  });

  test(`${target}: topic parsing validates explicit oldest-history flags, reply counts, identity and timestamps`, () => {
    const api = fixture(target);
    const address = api.address('https://chat.google.com/app/chat/space');
    const parsed = api.topicsPage([['dfe.t.lt', [topic()], ['1'], ['2'], false, true, [false]]], address);
    assert.equal(parsed.atStart, false);
    assert.equal(parsed.cursor, '1700000000000001');
    assert.equal(parsed.topics[0].expectedReplies, 1);
    assert.equal(parsed.topics[0].messages[1].parentMessageId, 'parent');
    assert.equal(parsed.topics[0].messages[0].text, 'Hello');
    assert.throws(() => api.topicsPage([['dfe.t.lt', [], null, null]], address), /response|schema/i);
    assert.throws(() => api.topicsPage([['dfe.t.lt', [], null, null, false, true]], address), /empty|complete/i);
    const foreign = topic();
    foreign[0][2][0][0] = 'another-space';
    assert.throws(() => api.topicsPage([['dfe.t.lt', [foreign], null, null, true, true]], address), /conversation/i);
    const invalid = topic();
    invalid[10][12] = null;
    assert.throws(() => api.topicsPage([['dfe.t.lt', [invalid], null, null, true, true]], address), /reply count/i);
  });

  test(`${target}: API messages preserve deletion placeholders, sender, UTF-8, attachment metadata and parent IDs`, () => {
    const api = fixture(target);
    const address = api.address('https://chat.google.com/app/chat/space');
    const deleted = message('deleted', 'parent', null, { 1: null, 7: '1700000001000000' });
    const media = Array(10).fill(null);
    media[0] = 13;
    media[9] = ['opaque-token', null, 'résumé.png', 'image/png'];
    const row = message('reply', 'parent', '你好 👋\n```code```', { 10: [media] });
    const page = api.messagesPage([['dfe.m.lm', [message('parent'), row, deleted], ['1']]], address, 'parent');
    assert.equal(page[1].sender, 'A Person');
    assert.equal(page[1].text, '你好 👋\n```code```');
    assert.equal(page[1].media[0].name, 'résumé.png');
    assert.equal(page[1].media[0].type, 'image');
    assert.equal(new URL(page[1].media[0].url).searchParams.get('attachment_token'), 'opaque-token');
    assert.equal(new URL(page[1].media[0].url).searchParams.get('url_type'), 'FIFE_URL');
    assert.equal(page[2].deleted, true);
    assert.equal(page[2].text, '[Message deleted]');
    assert.equal(page[2].parentMessageId, 'parent');
    assert.equal(page[2].absoluteTimestamp, 1700000000000);
    assert.throws(() => api.messagesPage([['dfe.m.lm', [message('wrong', 'other')]]], address, 'parent'), /thread/i);
  });

  test(`${target}: API traversal pages old topics and missing replies before declaring completion`, async () => {
    const api = fixture(target), group = api.address('https://chat.google.com/app/chat/space');
    const recent = topic('recent', 0); recent[6] = [message('recent', 'recent')];
    recent[14] = '1700000001000000'; recent[6][0][2] = recent[14];
    const older = topic('parent', 2); older[6] = [message('parent')];
    const replies = [message('reply-1'), message('reply-2')];
    replies[0][2] = '1700000000000003'; replies[1][2] = '1700000000000002';
    older[1] = '1700000000000003';
    const calls = [], counts = [];
    const result = await api.collect(group, async (operation, body) => {
      calls.push({ operation, body });
      if (operation === 'list_messages') return [['dfe.m.lm', replies]];
      return [['dfe.t.lt', body[3] ? [older] : [recent], null, null, !!body[3], !body[3]]];
    }, async count => counts.push(count), new AbortController().signal);
    assert.equal(result.reason, 'api-complete');
    assert.equal(result.threadsComplete, true);
    assert.equal(result.threadsScanned, 1);
    assert.equal(result.messages.length, 4);
    assert.equal(calls[1].body[3][0], 1700000001000000);
    assert.equal(calls[2].operation, 'list_messages');
    assert.equal(calls[2].body[3][2], 1700000000000004);
    assert.equal(counts.at(-1).messages, 4);
  });

  test(`${target}: stalled history, missing parents, changed counts and cancellation cannot produce a complete result`, async () => {
    const api = fixture(target), group = api.address('https://chat.google.com/app/chat/space');
    const row = topic();
    await assert.rejects(api.collect(group, async () => [['dfe.t.lt', [row], null, null, false, false]], async () => {}, new AbortController().signal), /pagination stalled/);
    row[6] = [message('reply')]; row[10][12][0] = '0';
    await assert.rejects(api.collect(group, async () => [['dfe.t.lt', [row], null, null, true, true]], async () => {}, new AbortController().signal), /reply count/);
    row[10][12][0] = '2'; row[1] = '1700000000001000';
    await assert.rejects(api.collect(group, async operation => operation === 'list_topics' ? [['dfe.t.lt', [row], null, null, true, true]] : [['dfe.m.lm', []]], async () => {}, new AbortController().signal), /advertised reply count/);
    const controller = new AbortController(); controller.abort(); let requested = false;
    await assert.rejects(api.collect(group, async () => { requested = true; }, async () => {}, controller.signal), /abort/i);
    assert.equal(requested, false);
  });

  test(`${target}: bot rich cards preserve text and links once without executing HTML`, () => {
    const api = fixture(target), group = api.address('https://chat.google.com/app/chat/space');
    const row = message('parent', 'parent', '', { 14: [[[['<b>Build &amp; deploy</b>', [['Build & deploy']]], [['Status: <a href="https://example.test/job">passed</a><br>日本語', [['Status: passed'], ['日本語']]]]]]] });
    const [parsed] = api.messagesPage([['dfe.m.lm', [row]]], group, 'parent');
    assert.equal(parsed.text, 'Build & deploy\n\nStatus: passed (https://example.test/job)\n日本語');
  });

  test(`${target}: image-only posts and Drive attachments keep their names and links`, () => {
    const api = fixture(target), group = api.address('https://chat.google.com/app/chat/space');
    const image = [1]; image[6] = [null, null, 'https://lh6.googleusercontent.com/image', null, null, null, [null, null, 'https://media.tenor.com/animation.gif'], 'animation.gif', false, 200, 300, 'image/gif'];
    const drive = [2, 0, 0, ['drive-id', 'report.pdf', null, 'application/pdf']];
    drive[29] = [[null, null, 'https://drive.google.com/file/d/drive-id/view']];
    const rows = api.messagesPage([['dfe.m.lm', [message('parent', 'parent', '', { 10: [image, drive] })]]], group, 'parent');
    assert.equal(rows[0].rawContent, false); assert.equal(rows[0].media.length, 2);
    assert.equal(rows[0].media[0].type, 'gif'); assert.equal(rows[0].media[1].name, 'report.pdf');
  });

  test(`${target}: unfamiliar empty-body content preserves its original payload and warns against advancing a checkpoint`, async () => {
    const api = fixture(target), group = api.address('https://chat.google.com/app/chat/space');
    const row = topic('parent', 0); row[6] = [message('parent', 'parent', '', { 10: [[999, 'synthetic unknown payload']] })];
    const result = await api.collect(group, async () => [['dfe.t.lt', [row], null, null, true, true]], async () => {}, new AbortController().signal);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].rawContent, true);
    assert.ok(result.messages[0].text.includes(JSON.stringify(row[6][0])));
    assert.match(result.warning, /checkpoint will not advance/);
  });
}

module.exports = { message, topic };
