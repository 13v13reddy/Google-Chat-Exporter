'use strict';
(() => {
  const query = new URLSearchParams(location.search);
  const main = document.querySelector('.Bl2pUd');
  const other = /OTHER/.test(location.pathname);
  const name = other ? 'Other space' : 'Fixture space';
  document.querySelector('header').textContent = name;
  document.querySelector('header').setAttribute('aria-label', name);
  const epoch = Date.UTC(2026, 0, 1);
  const messages = Array.from({ length: 8 }, (_, i) => ({ id: `parent-${i}`, topic: `parent-${i}`,
    time: epoch + i * 86400000, sender: i % 2 ? 'Bob' : 'Alice', text: `Message ${i}: café 日本語 <script>literal</script>`, replies: i === 0 || i === 6 }));
  if (query.has('new')) messages.push({ id: 'new-message', topic: 'new-message', time: epoch + 10 * 86400000, sender: 'Carol', text: 'A new message', replies: false });
  const fixture = window.fixture = { stats: { opened: 0, expanded: 0, loaded: 0 }, expected: messages.map(m => m.id), ready: false };
  const make = (data, panel = false) => {
    const node = document.createElement('div'); node.dataset.id = data.id; node.dataset.topicId = data.topic;
    if (data.deleted) { node.className = 'Ao1xUb'; node.setAttribute('role', 'group'); node.textContent = 'Message deleted by its author'; return node; }
    node.className = 'nF6pT';
    const sender = document.createElement('span'); sender.className = 'ZTmjQb'; sender.dataset.name = data.sender; sender.textContent = data.sender;
    const time = document.createElement('span'); time.className = 'FvYVyf'; time.dataset.absoluteTimestamp = data.time; time.textContent = new Date(data.time).toISOString();
    const text = document.createElement('div'); text.className = 'DTp27d'; text.setAttribute('jsname', 'bgckF'); text.textContent = data.text;
    node.append(sender, time, text);
    if (data.id === 'parent-7' && query.has('media')) {
      const chip = document.createElement('div'); chip.className = 'avsS6d';
      const img = document.createElement('img'); img.className = 'HQLhSc'; img.src = `https://fixtures.googleusercontent.com/${query.has('mediaFail') ? 'missing' : 'pixel'}.png`;
      const button = document.createElement('span'); button.className = 'SMTuwf'; button.dataset.action = '7'; button.title = 'café.png'; chip.append(img, button); node.append(chip);
    }
    if (data.replies && !panel) {
      const open = document.createElement('div'); open.className = 'CYx15d'; open.setAttribute('role', 'button'); open.textContent = '3 replies';
      open.onclick = () => openThread(data); node.append(open);
    }
    return node;
  };
  const replies = parent => [
    { id: `${parent.id}-reply-1`, topic: parent.id, sender: 'Bob', time: parent.time + 1000, text: 'First reply' },
    { id: `${parent.id}-deleted`, topic: parent.id, deleted: true },
    { id: `${parent.id}-reply-2`, topic: parent.id, sender: 'Carol', time: epoch + 9 * 86400000, text: 'A recent reply to an older parent' }
  ];
  for (const parent of messages.filter(m => m.replies)) fixture.expected.push(...replies(parent).map(m => m.id));
  function openThread(parent) {
    fixture.stats.opened++;
    document.querySelector('.hSo9Ub')?.remove(); document.body.classList.add('thread-open');
    const panel = document.createElement('section'); panel.className = 'hSo9Ub'; panel.dataset.topicId = parent.id;
    const controls = document.createElement('div'); controls.className = 'DaIyce'; controls.setAttribute('jsname', 'TvD9Pc');
    const close = document.createElement('button'); close.textContent = 'Close thread'; close.onclick = () => { panel.remove(); document.body.classList.remove('thread-open'); };
    controls.append(close);
    const view = document.createElement('div'); view.className = 'lFJYcb'; view.setAttribute('jsname', 'sGWpWe');
    const expand = document.createElement('div'); expand.dataset.collapsedCount = '2'; expand.setAttribute('role', 'button'); expand.textContent = '2 earlier replies';
    const render = expanded => view.replaceChildren(make(parent, true), ...(expanded ? replies(parent).map(m => make(m, true)) : [expand, make(replies(parent)[2], true)]));
    expand.onclick = () => { fixture.stats.expanded++; if (!query.has('stuck')) render(true); };
    if (!query.has('threadFail')) render(false);
    panel.append(controls, view); document.body.append(panel);
    view.scrollTop = view.scrollHeight;
  }
  let start = Math.max(0, messages.length - 4), loading = false;
  const renderMain = () => main.replaceChildren(...messages.slice(start).map(m => make(m)));
  main.addEventListener('scroll', () => {
    if (main.scrollTop > 30 || !start || loading) return;
    loading = true;
    setTimeout(() => {
      const oldHeight = main.scrollHeight, oldTop = main.scrollTop;
      start = Math.max(0, start - 2); renderMain(); fixture.stats.loaded++;
      main.scrollTop = oldTop + main.scrollHeight - oldHeight; loading = false;
    }, Number(query.get('delay')) || 150);
  });
  setTimeout(() => { renderMain(); main.scrollTop = main.scrollHeight; fixture.ready = true; }, Number(query.get('initial')) || 0);
})();
