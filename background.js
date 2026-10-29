// background.js —— 极简 service worker：只负责替页面打开新标签
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open' && typeof msg.url === 'string') {
    const self = chrome.runtime.getURL('');
    if (/^https?:/i.test(msg.url) || msg.url.startsWith(self)) {
      chrome.tabs.create({ url: msg.url });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  }
  return false;
});
