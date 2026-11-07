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

  // 自动同步引擎参数
  const SYNC = {
    STOP_THRESHOLD: 30,              // 连续已入库数量达到即提前停止（正常倒序列表）
    MIN_LIBRARY: 30,                 // 已入库数量达到后才启用自动同步（避免新用户被自动全量滚屏）
    THROTTLE_MS: 5 * 60 * 1000,      // 同来源自动同步最小间隔
    HEARTBEAT_MS: 15 * 1000,         // 心跳间隔（SW 侧孤儿判定阈值为其 4 倍）
    PATTERN_WINDOW: 200,             // 新旧序列检测窗口
  };

  const sourceLabel = (s) => (s === 'like' ? '喜欢' : s === 'collect' ? '收藏' : s);

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

  // ---- 自动同步：SW 任务接口（content script 不直接访问 IndexedDB）----
  async function getSyncReport() {
    const r = await sendMessageP({ type: 'getSyncReport' });
    return r && r.ok ? r.report : null;
  }
  async function getKnownIds(source) {
    const r = await sendMessageP({ type: 'getKnownIds', source });
    return r && r.ok ? { ids: new Set(r.ids), tombs: new Set(r.tombstoneIds) } : null;
  }
  const startSyncJob = (source, trigger) => sendMessageP({ type: 'startSyncJob', source, trigger });
  const pauseJob = (source) => sendMessageP({ type: 'pauseSyncJob', source });
  const heartbeatJob = (source, patch) => sendMessageP({ type: 'syncHeartbeat', source, ...patch });
  const finishJob = (source, status, extra = {}) => sendMessageP({ type: 'finishSyncJob', source, status, ...extra });
  async function autoSyncEnabled() {
    const { settings = {} } = await DB.get('settings');
    return settings.autoSync !== false; // 默认开启，设置页可关闭
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

  // ---------- 自动同步引擎（第三阶段） ----------
  // 目标：用户停留在喜欢/收藏页时自动增量同步，无需点击悬浮球。
  // 策略：顶部起扫描（列表时间倒序），连续 STOP_THRESHOLD 条已入库即提前停止；
  // 检测到异常排序（已存在之后又出现新视频）转深扫到底；jobs 队列持久化任务，
  // SW 被杀/页面关闭后下次进入自动接管恢复（以已入库 id 集合为断点，幂等）。
  const syncEngine = {
    active: false, source: null, stopFlag: false,
    stats: { found: 0, added: 0, existing: 0, failed: 0, deepScan: false, resumed: false, resurrected: 0 },
    observer: null, wake: null, debounceT: null, note: null, reportCache: null,
  };

  function setAutoSyncNote(text) {
    // 仅记录状态文案，UI 由 render() 统一刷新（面板元素在下方定义）
    syncEngine.note = text;
  }

  // 任务期间监听列表动态变化：新内容出现（如"查看更多"注入卡片）时提前唤醒扫描循环。
  // debounce 700ms 防止 DOM 高频变化造成重复检查；任务结束/页面切换时断开释放。
  function observeListChanges() {
    if (typeof MutationObserver === 'undefined') return;
    stopObserving();
    const mo = new MutationObserver(() => {
      clearTimeout(syncEngine.debounceT);
      syncEngine.debounceT = setTimeout(() => { if (syncEngine.wake) syncEngine.wake(); }, 700);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    syncEngine.observer = mo;
  }
  function stopObserving() {
    if (syncEngine.observer) { syncEngine.observer.disconnect(); syncEngine.observer = null; }
    clearTimeout(syncEngine.debounceT);
  }

  function sleepInterruptible(ms) {
    return new Promise((resolve) => {
      const done = () => { syncEngine.wake = null; clearTimeout(t); resolve(); };
      syncEngine.wake = done;
      const t = setTimeout(done, ms);
    });
  }

  async function maybeAutoSync(reason) {
    void reason;
    if (scan.running || syncEngine.active) return; // 防重复启动（同页面）
    if (!(await autoSyncEnabled())) return;
    const t = currentPageType();
    if (!t) return;
    const report = await getSyncReport();
    syncEngine.reportCache = report;
    const last = report && report.lastSync ? report.lastSync[t] : null;
    if (last && last.status === 'done' && Date.now() - last.at < SYNC.THROTTLE_MS) {
      setAutoSyncNote(`上次同步 ${fmtTime(last.at)}（新增 ${last.added}）`);
      return;
    }
    const known = await getKnownIds(t);
    if (!known) { setAutoSyncNote('数据库暂不可用，稍后自动重试'); return; }
    const total = known.ids.size + known.tombs.size;
    if (total < SYNC.MIN_LIBRARY) {
      setAutoSyncNote(`完成首次完整采集后自动启用（${sourceLabel(t)}已入库 ${total} 条）`);
      return;
    }
    runIncrementalSync(t, 'auto');
  }

  async function runIncrementalSync(source, trigger) {
    if (syncEngine.active || scan.running) return;
    Object.assign(syncEngine, {
      active: true, source, stopFlag: false,
      stats: { found: 0, added: 0, existing: 0, failed: 0, deepScan: false, resumed: false, resurrected: 0 },
    });
    render();

    const acquire = await startSyncJob(source, trigger);
    if (!acquire || !acquire.ok) {
      syncEngine.active = false;
      render();
      if (acquire && acquire.reason === 'locked') setAutoSyncNote('其他标签页正在同步该来源，本页跳过');
      return;
    }
    if (acquire.resumed) syncEngine.stats.resumed = true;
    observeListChanges();

    const t0 = Date.now();
    try {
      const ready = await waitForVideos(20000);
      if (!ready) {
        await finishJob(source, 'error', { error: '页面未加载出视频列表（未登录或列表为空）' });
        setAutoSyncNote(`${sourceLabel(source)}页没有检测到视频列表，已记为失败，下次进入自动重试`);
        return;
      }

      const known = await getKnownIds(source);
      if (!known) throw new Error('读取已入库数据失败');
      const knownSet = known.ids;
      const tombSet = known.tombs;
      const seen = new Set();
      const pattern = [];
      let consecutiveExisting = 0;
      let noProgressRounds = 0;
      let rounds = 0;
      let deepScan = false;
      let earlyStop = false;
      let lastProcessedId = null;
      let lastBeat = 0;

      const beat = async (force) => {
        if (!force && Date.now() - lastBeat < SYNC.HEARTBEAT_MS) return;
        lastBeat = Date.now();
        await heartbeatJob(source, {
          collected: syncEngine.stats.found + syncEngine.stats.existing,
          added: syncEngine.stats.added,
          existing: syncEngine.stats.existing,
          failed: syncEngine.stats.failed,
          lastProcessedId,
          scanRounds: rounds,
          deepScan,
        });
      };

      while (!syncEngine.stopFlag && rounds < MAX_ROUNDS && Date.now() - t0 < MAX_DURATION) {
        rounds++;
        // 按页面顺序提取：已入库/墓碑 id 只计数（异常排序检测），新视频才提取详情
        const newOnes = [];
        for (const a of document.querySelectorAll('a[href*="/video/"]')) {
          const id = parseVideoId(a.getAttribute('href'));
          if (!id || seen.has(id)) continue;
          seen.add(id);
          lastProcessedId = id;
          if (knownSet.has(id) || tombSet.has(id)) {
            pattern.push('E'); consecutiveExisting++; syncEngine.stats.existing++;
            continue;
          }
          knownSet.add(id);
          pattern.push('N'); consecutiveExisting = 0;
          syncEngine.stats.found++;
          newOnes.push(extractDetail(id, a));
        }
        if (pattern.length > SYNC.PATTERN_WINDOW) pattern.splice(0, pattern.length - SYNC.PATTERN_WINDOW);
        // 异常排序：不能据此认定同步完成，转深扫到底
        if (!deepScan && patternHasInterleave(pattern)) {
          deepScan = true;
          syncEngine.stats.deepScan = true;
        }
        // 写库（失败重试一次，仍失败计入 failed，不中断任务）
        if (newOnes.length) {
          const payload = newOnes.map((v) => ({ ...v, sources: [source] }));
          let res = await queueUpsert(payload);
          if (res && res.ok === false) res = await queueUpsert(payload);
          if (res && res.ok && res.stats) {
            syncEngine.stats.added += res.stats.added || 0;
            syncEngine.stats.resurrected += res.stats.skippedTombstone || 0;
          } else {
            syncEngine.stats.failed += newOnes.length;
          }
        }
        render();

        if (shouldStopIncremental(consecutiveExisting, deepScan, SYNC.STOP_THRESHOLD)) { earlyStop = true; break; }

        // 滚动 + "查看更多"；MutationObserver 唤醒可提前进入下一轮
        clickMore();
        const beforeY = window.scrollY;
        const beforeH = document.documentElement.scrollHeight;
        await sleepInterruptible(650);
        window.scrollBy(0, 1000);
        const grew = document.documentElement.scrollHeight > beforeH;
        const moved = window.scrollY > beforeY;
        const doc = document.documentElement;
        const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 4;
        if (grew || moved || newOnes.length) noProgressRounds = 0; else noProgressRounds++;
        if (atBottom && !grew && !newOnes.length) noProgressRounds = Math.max(noProgressRounds, 5);
        if (noProgressRounds >= 10) break;
        await beat(false);
      }

      await flushUpserts();
      await beat(true);
      if (syncEngine.stopFlag) {
        await pauseJob(source); // 手动停止/页面切换：任务暂停，下次进入自动接管
        toast(`自动同步已暂停（${sourceLabel(source)}：新增 ${syncEngine.stats.added}）`);
      } else {
        await finishJob(source, 'done', { earlyStop });
        await getCountsCached(true);
        toast(`自动同步完成（${sourceLabel(source)}）：新增 ${syncEngine.stats.added}，已存在 ${syncEngine.stats.existing}` +
          (syncEngine.stats.failed ? `，失败 ${syncEngine.stats.failed}` : '') +
          (deepScan ? '，检测到异常排序已深扫' : ''));
      }
      void earlyStop;
    } catch (e) {
      await finishJob(source, 'error', { error: String((e && e.message) || e).slice(0, 300) });
      setAutoSyncNote(`同步出错：${String((e && e.message) || e).slice(0, 80)}，下次进入自动重试`);
    } finally {
      stopObserving();
      syncEngine.active = false;
      syncEngine.source = null;
      render();
      getSyncReport().then((r) => { syncEngine.reportCache = r; render(); });
    }
  }

  // ---- SPA 路由监听：history 补丁 + popstate/hashchange + 2s 轮询兜底 ----
  let lastRoute = null;
  function routeChanged() {
    const t = currentPageType();
    // 切换离开正在同步/采集的来源：暂停任务（下次进入自动接管），避免跨页跑任务
    if (syncEngine.active && syncEngine.source && syncEngine.source !== t) {
      syncEngine.stopFlag = true;
      pauseJob(syncEngine.source);
    }
    if (scan.running && scan.source && scan.source !== t) scan.stopFlag = true;
    if (t) maybeAutoSync('route');
  }
  function watchRoute() {
    const fire = () => {
      if (location.href !== lastRoute) { lastRoute = location.href; routeChanged(); }
    };
    for (const m of ['pushState', 'replaceState']) {
      try {
        const orig = history[m];
        if (orig) {
          history[m] = function (...args) {
            const r = orig.apply(this, args);
            setTimeout(fire, 0);
            return r;
          };
        }
      } catch (e) { void e; }
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  // ---------- UI（Shadow DOM）----------
  const host = document.createElement('div');
  // 注意：all:initial 必须写在最前，否则会重置后面的定位声明（此 bug 曾导致悬浮球不可见）
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:24px;bottom:88px;';
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
    <div class="autosync" style="background:rgba(255,255,255,.05);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#aaa;line-height:1.6"></div>
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
  const autoSyncEl = $('.autosync');
  const progressEl = $('.progress');
  const toastEl = $('.toast');
  const btnScan = $('.js-scan');
  const btnStop = $('.js-stop');
  const btnAll = $('.js-all');
  const btnDash = $('.js-dash');

  bubble.addEventListener('click', () => { panel.classList.toggle('open'); render(); });
  panel.querySelector('.close').addEventListener('click', () => panel.classList.remove('open'));
  btnScan.addEventListener('click', async () => {
    const t = currentPageType();
    if (!t) { toast('请先打开个人主页的「喜欢」或「收藏」标签页'); return; }
    // 手动全量采集优先：自动同步让位并暂停任务（下次进入自动接管）
    if (syncEngine.active) {
      syncEngine.stopFlag = true;
      pauseJob(syncEngine.source);
      await sleep(200);
    }
    runScan(t);
  });
  btnStop.addEventListener('click', () => { scan.stopFlag = true; syncEngine.stopFlag = true; });
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

    // 自动同步状态行（同步报告）
    const t2 = currentPageType();
    if (syncEngine.active) {
      const s = syncEngine.stats;
      autoSyncEl.innerHTML = `⟳ 自动同步中（${sourceLabel(syncEngine.source)}）：新增 <b>${s.added}</b> · 已存在 <b>${s.existing}</b>` +
        (s.failed ? ` · 失败 <b>${s.failed}</b>` : '') +
        (s.deepScan ? ' · 异常排序，深扫中' : '') +
        (s.resumed ? ' · 已恢复上次任务' : '');
    } else if (syncEngine.note) {
      autoSyncEl.textContent = '⟳ ' + syncEngine.note;
    } else {
      const report = syncEngine.reportCache;
      const last = report && report.lastSync && t2 ? report.lastSync[t2] : null;
      if (last && last.status === 'done') {
        autoSyncEl.textContent = `⟳ 上次同步 ${sourceLabel(t2)}：${fmtTime(last.at)}（新增 ${last.added}，已存在 ${last.existing}${last.failed ? '，失败 ' + last.failed : ''}）`;
      } else if (last && last.status === 'error') {
        autoSyncEl.textContent = `⟳ 上次同步失败（${last.error || '未知原因'}），下次进入自动重试`;
      } else {
        autoSyncEl.textContent = '⟳ 自动同步已就绪：进入喜欢/收藏页时自动检查新视频';
      }
    }
  }

  // 定时刷新页面类型识别（SPA 路由变化不触发重载）。
  // 注意：这里不读取任何存储（已采总数走本地缓存），避免空闲时每 2s 全量反序列化视频库。
  setInterval(() => {
    if (location.href !== lastRoute) { lastRoute = location.href; routeChanged(); }
    if (!scan.running && !syncEngine.active) render();
  }, 2000);
  getCountsCached(true).then(render);
  render();

  // 启动：路由监听 + 同步报告缓存 + 自动同步检查
  lastRoute = location.href;
  watchRoute();
  getSyncReport().then((r) => { syncEngine.reportCache = r; render(); });
  maybeAutoSync('inject');

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
