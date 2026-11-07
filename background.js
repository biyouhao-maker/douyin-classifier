// background.js —— service worker：消息路由 + 扩展 IndexedDB 的唯一采集写入通道
//
// 平台约束：content script 的 IndexedDB 属于宿主页面源（douyin.com），不能用来存扩展数据，
// 因此采集端通过 chrome.runtime.sendMessage 把数据交给本 SW 写入扩展自己的 IndexedDB。
// 采集期间 content script 每轮滚动都会发消息（间隔 < 30s），SW 的空闲计时器持续被重置，不会中途被杀。

importScripts('lib/db.js', 'lib/common.js');

// 允许打开的地址：扩展自身页面（dashboard 等）
function isOwnPage(url) {
  return url.startsWith(chrome.runtime.getURL(''));
}

let migrationPromise = null;
function ensureMigration() {
  if (!migrationPromise) {
    migrationPromise = VideoDB.runMigrationIfNeeded().catch((e) => {
      // 失败允许下次重试；旧 chrome.storage 数据未动，无数据丢失
      migrationPromise = null;
      throw e;
    });
  }
  return migrationPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'open': {
      if (typeof msg.url === 'string' && isOwnPage(msg.url)) {
        chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'url not allowed' });
      }
      return false;
    }

    case 'upsertVideos': {
      const items = Array.isArray(msg.items) ? msg.items.slice(0, 500) : [];
      ensureMigration()
        .then(() => VideoDB.putVideos(items))
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true; // 异步响应
    }

    case 'getCounts': {
      ensureMigration()
        .then(() => VideoDB.counts())
        .then((counts) => sendResponse({ ok: true, counts }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    default:
      return false;
  }
});
