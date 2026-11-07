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

    // ---- 自动同步任务（第三阶段）----
    case 'startSyncJob': {
      const source = msg.source === 'like' || msg.source === 'collect' ? msg.source : null;
      if (!source) { sendResponse({ ok: false, error: 'bad source' }); return false; }
      ensureMigration()
        .then(() => VideoDB.acquireSyncJob(source, { trigger: msg.trigger === 'manual' ? 'manual' : 'auto' }))
        .then((res) => sendResponse({ ok: res.acquired, ...res }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    case 'syncHeartbeat': {
      const source = msg.source === 'like' || msg.source === 'collect' ? msg.source : null;
      if (!source) { sendResponse({ ok: false, error: 'bad source' }); return false; }
      VideoDB.heartbeatSyncJob(source, {
        collected: Number(msg.collected) || 0,
        added: Number(msg.added) || 0,
        existing: Number(msg.existing) || 0,
        failed: Number(msg.failed) || 0,
        lastProcessedId: typeof msg.lastProcessedId === 'string' ? msg.lastProcessedId : null,
        scanRounds: Number(msg.scanRounds) || 0,
        deepScan: !!msg.deepScan,
      })
        .then((job) => sendResponse({ ok: !!job }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    case 'pauseSyncJob': {
      const source = msg.source === 'like' || msg.source === 'collect' ? msg.source : null;
      if (!source) { sendResponse({ ok: false, error: 'bad source' }); return false; }
      VideoDB.updateSyncJob(source, { status: 'paused' })
        .then((job) => sendResponse({ ok: !!job }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    case 'finishSyncJob': {
      const source = msg.source === 'like' || msg.source === 'collect' ? msg.source : null;
      if (!source) { sendResponse({ ok: false, error: 'bad source' }); return false; }
      const status = msg.status === 'error' ? 'error' : 'done';
      VideoDB.finishSyncJob(source, { status, error: msg.error || null, earlyStop: !!msg.earlyStop })
        .then((job) => sendResponse({ ok: !!job }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    case 'getSyncReport': {
      const sources = ['like', 'collect'];
      ensureMigration()
        .then(async () => ({
          jobs: {
            like: await VideoDB.getSyncJob('like'),
            collect: await VideoDB.getSyncJob('collect'),
          },
          lastSync: await VideoDB.getLastSync(null),
        }))
        .then((report) => sendResponse({ ok: true, report: { jobs: report.jobs, lastSync: report.lastSync, sources } }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    case 'getKnownIds': {
      const source = msg.source === 'like' || msg.source === 'collect' ? msg.source : null;
      if (!source) { sendResponse({ ok: false, error: 'bad source' }); return false; }
      ensureMigration()
        .then(() => VideoDB.getKnownIds(source))
        .then(({ ids, tombstoneIds }) => sendResponse({ ok: true, ids, tombstoneIds }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
      return true;
    }

    default:
      return false;
  }
});
