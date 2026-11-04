'use strict';

const selectors = require('../../chrome/selectors.json');

// Synthetic DOM model matching the observed main list, thread panel, and
// collapsed-message control. No live chat content is used in this fixture.
function installThreadFixture(context, options = {}) {
  const actions = [];
  const state = { active: options.previousThread ? 'old-parent' : '', expanded: false };
  const parentData = { id: 'old-parent', topic: 'old-parent', time: 10, text: 'Original question', sender: 'Alice' };
  const replyData = options.replies || [
    { id: 'old-reply', topic: 'old-parent', time: 20, text: 'Earlier reply', sender: 'Bob' },
    { id: 'deleted-reply', topic: 'old-parent', time: 0, text: 'Message deleted by its author', deleted: true },
    { id: 'new-reply', topic: 'old-parent', time: 300, text: 'New answer', sender: 'Carol' }
  ];
  const recentData = { id: 'recent', topic: 'recent', time: 200, text: 'Unrelated recent message', sender: 'Dana' };
  let mainTop = 400;
  let panelTop = 100;

  const topicNode = id => ({ getAttribute: name => name === 'data-topic-id' ? id : null });
  const textNode = text => ({ textContent: text, cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }) });
  const makeMessage = (data, position) => {
    const timestamp = { textContent: `time ${data.time}`, getAttribute: name => name === 'data-absolute-timestamp' ? String(data.time) : null };
    const message = {
      nodeType: 1, isConnected: true, textContent: data.text,
      getAttribute: name => name === 'data-id' ? data.id : null,
      getBoundingClientRect: () => ({ top: position - mainTop, bottom: position + 80 - mainTop }),
      matches: selector => !!data.deleted && selector === selectors.deletedMessage,
      closest: selector => selector === selectors.topicContainer ? topicNode(data.topic) : message,
      querySelector(selector) {
        if (selector === selectors.senderNameAttr) return { getAttribute: () => data.sender || 'Unknown' };
        if (selector === selectors.senderNameText) return textNode(data.sender || 'Unknown');
        if (selector === selectors.timestamp) return data.time ? timestamp : null;
        if (selector === selectors.threadOpen && data.id === 'old-parent') return open;
        return null;
      },
      querySelectorAll: selector => selector === selectors.messageText && !data.deleted ? [textNode(data.text)] : []
    };
    return message;
  };
  const open = {
    get textContent() { return options.replyLabel || `${replyData.length} replies`; },
    click() { actions.push('open-thread'); state.active = 'old-parent'; options.onOpen?.(); }
  };
  const expand = {
    getAttribute: name => name === 'data-collapsed-count' ? String(Math.max(0, replyData.length - 1)) : null,
    click() { actions.push('expand-replies'); if (!options.stuckExpansion) state.expanded = true; }
  };
  const close = { click() { actions.push('close-thread'); state.active = ''; } };
  const parent = makeMessage(parentData, 0);
  const recent = makeMessage(recentData, 500);
  const replies = replyData.map((data, index) => makeMessage(data, (index + 1) * 100));
  const panelMessages = () => [parent, ...(state.expanded ? replies : replies.slice(-1))];
  const mainMessages = () => options.virtualized && mainTop > 0 ? [recent] : [parent, recent];
  const queryMessages = (nodes, selector) => {
    if (selector === selectors.absoluteTimestampAttr) return nodes.map(node => node.querySelector(selectors.timestamp)).filter(Boolean);
    if (selector === selectors.messageGroups) return nodes.filter(node => !node.matches(selectors.deletedMessage));
    if (selector === `${selectors.messageGroups}, ${selectors.deletedMessage}`) return nodes;
    return [];
  };
  const main = {
    get scrollHeight() { return options.narrow && state.active ? 0 : 800; },
    get clientHeight() { return options.narrow && state.active ? 0 : 400; },
    get scrollTop() { return mainTop; }, set scrollTop(value) { mainTop = Math.max(0, Math.min(400, value)); },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: selector => queryMessages(mainMessages(), selector)
  };
  const panel = {
    clientHeight: 300,
    get scrollHeight() { return state.expanded ? 900 : 400; },
    get scrollTop() { return panelTop; }, set scrollTop(value) { panelTop = Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, value)); },
    get isConnected() { return !!state.active; },
    closest(selector) {
      if (selector === selectors.topicContainer) return topicNode(state.active);
      if (selector === selectors.threadPanel) return { querySelector: selector => selector === selectors.threadClose ? close : null };
      return null;
    },
    querySelector: selector => selector === selectors.collapsedMessages && !state.expanded && replyData.length > 1 ? expand : null,
    querySelectorAll(selector) {
      if (selector === selectors.collapsedMessages) return !state.expanded && replyData.length > 1 ? [expand] : [];
      return queryMessages(panelMessages(), selector);
    }
  };
  context.threadSelectors = selectors;
  require('node:vm').runInContext('SEL = this.threadSelectors', context);
  context.document.querySelector = selector => selector === selectors.mainMessages ? main : null;
  context.document.querySelectorAll = selector => selector === selectors.mainMessages ? [main] :
    selector === selectors.threadScroll && state.active ? [panel] : queryMessages(mainMessages(), selector);
  context.sleep = async (_ms, signal) => context.throwIfAborted(signal);
  context.waitForHistoryMutation = async () => false;
  context.waitForThreadCondition = async (read, signal) => { context.throwIfAborted(signal); return read(); };
  context.showProgress = () => {};
  context.getConversationName = () => 'Synthetic space';
  context.setTimeout = () => 0;
  return { main, panel, parentData, replyData, state, actions,
    addReply(data) { replyData.push(data); replies.push(makeMessage(data, replyData.length * 100)); }
  };
}

module.exports = { installThreadFixture };
