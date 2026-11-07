// content/content.js —— 抖音页面内注入：悬浮球 + 采集面板 + 滚动采集引擎（Shadow DOM 隔离样式）
//
// 数据写入：本脚本不直接访问 IndexedDB（content script 的 IndexedDB 属于 douyin.com 源），
// 采集结果经 chrome.runtime.sendMessage 交给 service worker 写入扩展自己的 IndexedDB。
// 结束判定（增量采集修复）：以"滚动进度"驱动——只要页面还在长高/还能滚动就继续，
// 到底且高度不再增长后才结束；不再按"是否采到新视频"判定（否则二次采集永远到不了底部）。
(() => {
  if (window.__dyClassifierInjected) return;
  window.__dyClassifierInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PAGE_URLS = {
    like: 'https://www.douyin.com/user/self?showTab=like_record',
    collect: 'https://www.douyin.com/user/self?showTab=favorite_collection',
  };
  const MAX_ROUNDS = 3000;          // 安全上限：最多滚动轮数
  const MAX_DURATION = 10 * 60 * 1000; // 安全上限：单次采集最长 10 分钟
  const SEND_BATCH = 50;            // 攒批阈值

  // ---------- 页面识别 ----------
  function currentPageType() {
    const u = location.href;
    if (/showTab=like_record/.test(u)) return 'like';
    if (/showTab=favorite_collection/.test(u)) return 'collect';
    if (/douyin\.com\/user\/self/.test(u)) {
      const tabs = document.querySelectorAll('[data-e2e="user-tab-list"] [data-e2e="tab-item"], [data-e2e="user-tab-list"] a');
      for (const t of tabs) {
        const cls = String(t.className || '');
        if (/active|selected/i.test(cls)) {
          const txt = (t.innerText || '').trim();
          if (/喜欢/.test(txt)) return 'like';
          if (/收藏/.test(txt)) return 'collect';
        }
      }
    }
    return null;
  }

  // ---------- DOM 提取（先按 id 剪枝，只为新视频提取详情） ----------
  function parseVideoId(href) {
    const m = (href || '').match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  function findCard(a) {
    const li = a.closest('li');
    if (li) return li;
    let el = a;
    for (let i = 0; i < 2 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function extractTitle(card, a) {
    const cand = card.querySelector('[data-e2e="video-desc"]');
    let t = cand && cand.innerText && cand.innerText.trim();
    if (!t) {
      const c2 = card.querySelector('[class*="video-desc"], [class*="video-info-detail"]');
      t = c2 && c2.innerText && c2.innerText.trim();
    }
    if (!t) t = (a.innerText || '').trim();
    if (!t) {
      t = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    }
    return t.replace(/\s+#\S+$/g, '').slice(0, 200);
  }

  function extractCover(card) {
    let best = null;
    for (const img of card.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      if (/avatar|user-|logo|emoji|\.svg/i.test(src)) continue;
      if (!best || src.length > best.length) best = src;
    }
    return best || '';
  }

  function extractAuthor(card) {
    const ua = card.querySelector('a[href*="/user/"]');
    const t = ua && ua.innerText && ua.innerText.trim();
    return t ? t.split('\n')[0].slice(0, 60) : '';
  }

  function extractPostDate(card) {
    const m = (card.innerText || '').match(/\d{4}-\d{1,2}-\d{1,2}/);
    return m ? m[0] : '';
  }

  function extractDetail(id, a) {
    const card = findCard(a);
    return {
      id,
      title: extractTitle(card, a),
      cover: extractCover(card),
      author: extractAuthor(card),
      postDate: extractPostDate(card),
      url: 'https://www.douyin.com/video/' + id,
    };
  }

  // 扫描页面上所有视频链接，只返回本轮尚未入库的（seen 由调用方维护）
  function extractNewVideos(seen) {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const id = parseVideoId(a.getAttribute('href'));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(extractDetail(id, a));
    }
    return out;
  }

  // 仅点击列表底部的加载按钮；收紧文本匹配，避免误点简介区的"展开/查看更多"
  function clickMore() {
    const btn = document.querySelector('[data-e2e="click-more-btn"]');
    if (btn) { btn.click(); return; }
    for (const el of document.querySelectorAll('div,button,span,p')) {
      if (el.childElementCount === 0) {
        const t = (el.innerText || '').trim();
        if (t && t.length <= 8 && t.indexOf('点击查看更多') !== -1) { el.click(); return; }
      }
    }
  }

  async function waitForVideos(timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (document.querySelector('a[href*="/video/"]')) return true;
      await sleep(500);
    }
    return false;
  }

  // ---------- 写库通道（content → SW → 扩展 IndexedDB） ----------
  let sendBuffer = [];
  let sending = null;

  function sendMessageP(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // SW 未就绪等情况由 res.ok 兜底
          resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function queueUpsert(items) {
    sendBuffer = sendBuffer.concat(items);
    if (sendBuffer.length >= SEND_BATCH) return flushUpserts();
    return Promise.resolve({ added: 0 });
  }

  async function flushUpserts() {
    if (sending) await sending.catch(() => {});
    if (!sendBuffer.length) return { added: 0 };
    const batch = sendBuffer;
    sendBuffer = [];
    sending = sendMessageP({ type: 'upsertVideos', items: batch }).then((res) => {
      sending = null;
      return res;
    });
    const res = await sending;
    if (res && res.ok && res.stats) {
      scan.added += res.stats.added || 0;
      scan.resurrected = (scan.resurrected || 0) + (res.stats.skippedTombstone || 0);
    }
    return res;
  }

  async function getCountsCached(force) {
    if (!scan.countsCache || force) {
      const res = await sendMessageP({ type: 'getCounts' });
      if (res && res.ok) scan.countsCache = res.counts;
      else if (!scan.countsCache) scan.countsCache = { total: 0, classified: 0, unclassified: 0 };
    }
    return scan.countsCache;
  }

  // ---------- 滚动采集 ----------
  const scan = {
    running: false, source: null, found: 0, added: 0, stopFlag: false, auto: false,
    countsCache: null, resurrected: 0,
  };

  async function runScan(source, opts = {}) {
    if (scan.running) return;
    Object.assign(scan, { running: true, source, found: 0, added: 0, stopFlag: false, auto: !!opts.auto, resurrected: 0 });
    render();
    await getCountsCached(true);

    const ready = await waitForVideos(20000);
    if (!ready) {
      scan.running = false;
      render();
      await DB.remove('pendingTask');
      toast('没有检测到视频列表：请确认已登录，并停留在「喜欢」或「收藏」标签页');
      return;
    }

    // 已在本来源入库的 id 视为重复（不重复提取详情，也不重复计数）
    const seen = new Set();
    const t0 = Date.now();
    let rounds = 0;
    let noProgressRounds = 0;
    let lastHeight = document.documentElement.scrollHeight;

    while (!scan.stopFlag && rounds < MAX_ROUNDS && Date.now() - t0 < MAX_DURATION) {
      rounds++;
      const list = extractNewVideos(seen);
      scan.found += list.length;
      if (list.length) {
        await queueUpsert(list.map((v) => ({ ...v, sources: [source] })));
      }
      render();

      // 滚动与"查看更多"点击
      clickMore();
      const beforeY = window.scrollY;
      const beforeH = document.documentElement.scrollHeight;
      window.scrollBy(0, 1000);
      await sleep(650);

      const afterH = document.documentElement.scrollHeight;
      const moved = window.scrollY > beforeY;
      const grew = afterH > beforeH;
      const doc = document.documentElement;
      const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 4;

      // 进度判定：页面变高 / 滚动前进 / 采到新内容，任一都视为有进展
      if (grew || moved || list.length) {
        noProgressRounds = 0;
      } else {
        noProgressRounds++;
      }
      // 到底且页面不再长高：连续若干轮即结束（增量采集也能滚到真正的底部）
      if (atBottom && !grew && !list.length) {
        noProgressRounds = Math.max(noProgressRounds, 4);
      }
      if (noProgressRounds >= 10) break;
    }

    // 收尾：确保缓冲区全部落库（跳转/关闭前不丢数据）
    await flushUpserts();
    scan.running = false;
    render();
    if (scan.stopFlag) { toast('已停止采集'); return; }

    // 一键模式：跳转下一个来源继续；全部完成后打开看板
    const { pendingTask } = await DB.get('pendingTask');
    if (pendingTask && pendingTask.sources && pendingTask.sources.length) {
      pendingTask.sources = pendingTask.sources.filter((s) => s !== source);
      if (pendingTask.sources.length) {
        await DB.set({ pendingTask });
        location.href = PAGE_URLS[pendingTask.sources[0]];
        return;
      }
      await DB.remove('pendingTask');
      toast('全部采集完成');
      if (pendingTask.openDashboard) openDashboard();
    } else {
      toast(`采集完成：发现 ${scan.found} 条，新增 ${scan.added} 条` +
        (scan.resurrected ? `，跳过已删除 ${scan.resurrected} 条` : ''));
    }
  }

  async function startAll() {
    const cur = currentPageType();
    await DB.set({ pendingTask: { sources: ['like', 'collect'], openDashboard: true } });
    if (cur) {
      runScan(cur, { auto: true });
    } else {
      location.href = PAGE_URLS.like;
      // 新页面注入后会自动检测 pendingTask 并继续
    }
  }

  function openDashboard() {
    chrome.runtime.sendMessage({ type: 'open', url: chrome.runtime.getURL('dashboard/dashboard.html') });
  }

  // ---------- UI（Shadow DOM）----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:24px;bottom:88px;all:initial;';
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .bubble {
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #fe2c55, #d6246e);
      color: #fff; font-size: 22px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none;
      box-shadow: 0 6px 20px rgba(254, 44, 85, .45);
      transition: transform .15s;
    }
    .bubble:hover { transform: scale(1.08); }
    .panel {
      position: absolute; bottom: 64px; right: 0;
      width: 320px; padding: 16px;
      background: rgba(22, 22, 30, .97);
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
      color: #eee; font-size: 13px; display: none;
    }
    .panel.open { display: block; }
    .panel h3 { margin: 0 0 10px; font-size: 15px; display: flex; align-items: center; gap: 8px; }
    .panel h3 .dot { width: 10px; height: 10px; border-radius: 50%; background: #fe2c55; }
    .panel h3 .close { margin-left: auto; cursor: pointer; color: #999; font-size: 18px; line-height: 1; }
    .status { background: rgba(255,255,255,.06); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.7; }
    .status .ok { color: #51cf66; } .status .warn { color: #fab005; }
    .status b { color: #fff; }
    button {
      width: 100%; padding: 10px 0; margin: 6px 0 0; border: 0; border-radius: 10px;
      font-size: 13.5px; cursor: pointer; font-weight: 600;
    }
    .primary { background: linear-gradient(135deg, #fe2c55, #d6246e); color: #fff; }
    .ghost { background: rgba(255,255,255,.09); color: #ddd; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .progress { margin-top: 12px; font-size: 12.5px; color: #bbb; display: none; }
    .progress .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.12); overflow: hidden; margin-top: 6px; }
    .progress .bar i { display: block; height: 100%; width: 0; background: #fe2c55; border-radius: 3px; transition: width .3s; }
    .toast {
      position: absolute; bottom: 8px; right: 0; width: 320px; padding: 10px 14px;
      background: rgba(0,0,0,.88); color: #fff; border-radius: 10px; font-size: 12.5px;
      opacity: 0; pointer-events: none; transition: opacity .3s; line-height: 1.5;
    }
    .toast.show { opacity: 1; }
    .mini { font-size: 11.5px; color: #888; margin-top: 10px; text-align: center; }
  </style>
  <div class="bubble" title="抖音收藏分类助手">分</div>
  <div class="panel">
    <h3><span class="dot"></span>抖音收藏分类助手<span class="close">×</span></h3>
    <div class="status"></div>
    <button class="primary js-scan">开始采集本页</button>
    <button class="ghost js-stop" style="display:none">停止采集</button>
    <button class="primary js-all">一键采集（喜欢 + 收藏）</button>
    <button class="ghost js-dash">打开分类看板</button>
    <div class="progress"></div>
    <div class="mini">数据仅保存在本机浏览器中</div>
  </div>
  <div class="toast"></div>`;

  const $ = (s) => root.querySelector(s);
  const bubble = $('.bubble');
  const panel = $('.panel');
  const statusEl = $('.status');
  const progressEl = $('.progress');
  const toastEl = $('.toast');
  const btnScan = $('.js-scan');
  const btnStop = $('.js-stop');
  const btnAll = $('.js-all');
  const btnDash = $('.js-dash');

  bubble.addEventListener('click', () => { panel.classList.toggle('open'); render(); });
  panel.querySelector('.close').addEventListener('click', () => panel.classList.remove('open'));
  btnScan.addEventListener('click', () => {
    const t = currentPageType();
    if (!t) { toast('请先打开个人主页的「喜欢」或「收藏」标签页'); return; }
    runScan(t);
  });
  btnStop.addEventListener('click', () => { scan.stopFlag = true; });
  btnAll.addEventListener('click', startAll);
  btnDash.addEventListener('click', openDashboard);

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  }

  async function render() {
    const t = currentPageType();
    const typeText = t === 'like' ? '<span class="ok">✓ 喜欢（点赞）页</span>'
      : t === 'collect' ? '<span class="ok">✓ 收藏页</span>'
      : '<span class="warn">未识别 —— 请打开「我的主页 → 喜欢 / 收藏」标签页</span>';
    const total = scan.countsCache ? scan.countsCache.total : 0;
    statusEl.innerHTML = `当前页面：${typeText}<br>已采集：<b>${total}</b> 条视频`;

    btnScan.style.display = scan.running ? 'none' : '';
    btnStop.style.display = scan.running ? '' : 'none';
    btnAll.disabled = scan.running;
    btnScan.disabled = scan.running;

    if (scan.running) {
      progressEl.style.display = 'block';
      const srcText = scan.source === 'like' ? '喜欢' : '收藏';
      progressEl.innerHTML = `正在采集「${srcText}」：本轮发现 <b>${scan.found}</b> 条（新增入库 ${scan.added}）…<div class="bar"><i style="width:100%"></i></div>`;
    } else {
      progressEl.style.display = 'none';
    }
  }

  // 定时刷新页面类型识别（SPA 路由变化不触发重载）。
  // 注意：这里不读取任何存储（已采总数走本地缓存），避免空闲时每 2s 全量反序列化视频库。
  setInterval(() => { if (!scan.running) render(); }, 2000);
  getCountsCached(true).then(render);
  render();

  // 注入后检查是否有未完成的"一键采集"任务
  (async () => {
    const { pendingTask } = await DB.get('pendingTask');
    if (pendingTask && pendingTask.sources && pendingTask.sources.length) {
      const cur = currentPageType();
      if (cur && pendingTask.sources.includes(cur)) {
        setTimeout(() => runScan(cur, { auto: true }), 3000);
      }
    }
  })();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'show-panel') {
      panel.classList.add('open');
      render();
      sendResponse({ ok: true });
    }
  });
})();
