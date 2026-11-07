// lib/db.js —— IndexedDB 数据层（扩展页面与 service worker 使用）
//
// 重要平台约束：content script 的 IndexedDB 属于宿主页面源（douyin.com），
// 因此 content script 一律通过 chrome.runtime.sendMessage 交给 service worker 写库，
// 不得直接引用本文件（manifest 的 content_scripts 也不加载它）。
//
// 设计要点：
// - videos 主键 id（抖音纯数字视频 id，写入前校验）
// - sources 数组索引：点赞/收藏双来源合并与筛选
// - categoryHistory：保留人工/AI/规则修改记录
// - tombstones：删除墓碑，防止已删视频被再次采集"复活"
// - meta：schemaVersion / migration / lastSync / backup:v1
// - 所有"读旧→合并→写"都在同一事务内完成，杜绝并发丢更新
// - 迁移：chrome.storage 旧 videos 大对象 → IndexedDB，先备份、单事务写入、
//   失败整体回滚且旧数据永不删除，migration 标记保证不重复迁移
(() => {
  const DB_NAME = 'dy-classifier';
  const DB_VERSION = 1;
  const STORE_VIDEOS = 'videos';
  const STORE_TOMB = 'tombstones';
  const STORE_META = 'meta';
  const UNCLASSIFIED_KEY = '__unclassified__';
  const HISTORY_LIMIT = 50;
  const CHUNK = 200; // 批量写事务的每批记录数
  const ID_RE = /^\d{1,25}$/;

  // ---------- 基础工具 ----------
  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }
  function chunkArr(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  function computeCatKey(category) {
    return category ? String(category) : UNCLASSIFIED_KEY;
  }
  function now() { return Date.now(); }

  // chrome.storage.local 的最小 Promise 封装（仅迁移用，避免依赖 common.js）
  // hooks.legacyGet 可注入测试用旧数据，返回 { videos: {...} } 形态
  function csGet(key) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return Promise.resolve({});
    return chrome.storage.local.get(key);
  }
  function csSet(obj) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return Promise.resolve();
    return chrome.storage.local.set(obj);
  }

  function newRecord(raw) {
    return {
      id: String(raw.id),
      title: String(raw.title || ''),
      author: String(raw.author || ''),
      url: raw.url || ('https://www.douyin.com/video/' + raw.id),
      cover: String(raw.cover || ''),
      postDate: String(raw.postDate || ''),
      sources: Array.isArray(raw.sources) ? Array.from(new Set(raw.sources)) : [],
      firstSeen: Number(raw.firstSeen) || now(),
      lastUpdated: now(),
      category: raw.category || null,
      categoryBy: raw.categoryBy || null,
      categoryHistory: Array.isArray(raw.categoryHistory) ? raw.categoryHistory.slice(-HISTORY_LIMIT) : [],
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      catKey: computeCatKey(raw.category),
    };
  }

  // 已存在记录与新采集数据合并：只补空字段与来源，绝不覆盖分类等人工数据（修 B2：标题保留旧值更稳）
  function mergeExisting(oldRec, raw) {
    const r = { ...oldRec };
    r.sources = Array.from(new Set([...(oldRec.sources || []), ...(raw.sources || [])]));
    if (!r.cover && raw.cover) r.cover = raw.cover;
    if (!r.title && raw.title) r.title = raw.title;
    if (!r.author && raw.author) r.author = raw.author;
    if (!r.postDate && raw.postDate) r.postDate = raw.postDate;
    r.lastUpdated = now();
    return r;
  }

  function appendHistory(rec, category, by) {
    const h = (rec.categoryHistory || []).slice();
    h.push({ category: category || null, by, at: now() });
    rec.categoryHistory = h.slice(-HISTORY_LIMIT);
  }

  // ---------- IndexedDB 实现 ----------
  function createIdbBackend(hooks, opts = {}) {
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      const factory = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
      if (!factory) return Promise.reject(new Error('IndexedDB unavailable in this context'));
      const dbName = opts.dbName || DB_NAME;
      dbPromise = new Promise((resolve, reject) => {
        const req = factory.open(dbName, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = req.result;
          // 数据库结构版本迁移：future versions 在此 switch (e.oldVersion) 增量升级
          if (e.oldVersion < 1) {
            const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
            videos.createIndex('firstSeen', 'firstSeen');
            videos.createIndex('lastUpdated', 'lastUpdated');
            videos.createIndex('catKey', 'catKey');
            videos.createIndex('title', 'title');
            videos.createIndex('sources', 'sources', { multiEntry: true });
            db.createObjectStore(STORE_TOMB, { keyPath: 'id' });
            const meta = db.createObjectStore(STORE_META, { keyPath: 'key' });
            meta.put({ key: 'schemaVersion', value: 1 });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error || new Error('Failed to open IndexedDB')); };
        req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked by another open tab, please refresh')); };
      });
      return dbPromise;
    }

    async function get() { return open(); }

    async function putVideos(items) {
      const db = await get();
      const stats = { added: 0, updated: 0, skipped: 0, skippedTombstone: 0 };
      for (const chunk of chunkArr(items.filter(Boolean), CHUNK)) {
        const tx = db.transaction([STORE_VIDEOS, STORE_TOMB], 'readwrite');
        const vs = tx.objectStore(STORE_VIDEOS);
        const ts = tx.objectStore(STORE_TOMB);
        const work = (async () => {
          for (const raw of chunk) {
            if (hooks.consumeFail && hooks.consumeFail('put')) throw new Error('test-injected failure');
            if (!isValidId(String(raw && raw.id))) { stats.skipped++; continue; }
            const id = String(raw.id);
            if (await reqToPromise(ts.get(id))) { stats.skippedTombstone++; continue; }
            const old = await reqToPromise(vs.get(id));
            const rec = old ? mergeExisting(old, raw) : newRecord(raw);
            vs.put(rec);
            if (old) stats.updated++; else stats.added++;
          }
        })();
        await Promise.all([work, txDone(tx)]);
      }
      return stats;
    }

    // 迁移专用：单事务写入，任何一条失败整体回滚，保证无半截数据
    async function migrateInsert(items) {
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS], 'readwrite');
      const vs = tx.objectStore(STORE_VIDEOS);
      const work = (async () => {
        for (const raw of items) {
          if (hooks.consumeFail && hooks.consumeFail('migrate')) throw new Error('test-injected failure');
          vs.put(newRecord(raw));
        }
      })();
      await Promise.all([work, txDone(tx)]);
    }

    async function applyCategories(entries, by) {
      const db = await get();
      let changed = 0;
      for (const chunk of chunkArr(entries.filter((e) => e && isValidId(String(e.id))), CHUNK)) {
        const tx = db.transaction([STORE_VIDEOS], 'readwrite');
        const vs = tx.objectStore(STORE_VIDEOS);
        const work = (async () => {
          for (const entry of chunk) {
            const rec = await reqToPromise(vs.get(String(entry.id)));
            if (!rec) continue;
            const cat = entry.category || null;
            if ((rec.category || null) === cat && rec.categoryBy === by) continue;
            rec.category = cat;
            rec.categoryBy = by;
            rec.catKey = computeCatKey(cat);
            appendHistory(rec, cat, by);
            rec.lastUpdated = now();
            vs.put(rec);
            changed++;
          }
        })();
        await Promise.all([work, txDone(tx)]);
      }
      return { changed };
    }

    async function deleteVideo(id) {
      if (!isValidId(String(id))) return false;
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS, STORE_TOMB], 'readwrite');
      const vs = tx.objectStore(STORE_VIDEOS);
      const ts = tx.objectStore(STORE_TOMB);
      const work = (async () => {
        const rec = await reqToPromise(vs.get(String(id)));
        if (rec) vs.delete(String(id));
        ts.put({ id: String(id), deletedAt: now() });
      })();
      await Promise.all([work, txDone(tx)]);
      return true;
    }

    async function allVideos() {
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS], 'readonly');
      return reqToPromise(tx.objectStore(STORE_VIDEOS).getAll());
    }

    async function counts() {
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS], 'readonly');
      const store = tx.objectStore(STORE_VIDEOS);
      const total = await reqToPromise(store.count());
      const un = await reqToPromise(store.index('catKey').count(IDBKeyRange.only(UNCLASSIFIED_KEY)));
      return { total, unclassified: un, classified: total - un };
    }

    async function countByCategory() {
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS], 'readonly');
      const out = {};
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_VIDEOS).index('catKey').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          const key = cur.key;
          out[key] = (out[key] || 0) + 1;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out;
    }

    // 分页查询：支持分类/来源过滤与排序（title 排序仅在无过滤时走索引，其余内存排序）
    async function page(opts = {}) {
      const { catKey, source, sort = 'firstSeenDesc', offset = 0, limit = 50 } = opts;
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS], 'readonly');
      const store = tx.objectStore(STORE_VIDEOS);
      const useIdx = catKey ? store.index('catKey') : source ? store.index('sources') : null;
      const range = catKey ? IDBKeyRange.only(catKey) : source ? IDBKeyRange.only(source) : null;
      const wantTitle = sort === 'title';
      if (wantTitle && !useIdx) {
        const all = await allVideos();
        all.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
        return { items: all.slice(offset, offset + limit), total: all.length };
      }
      const dir = sort === 'firstSeenAsc' || wantTitle ? 'next' : 'prev';
      const items = [];
      let total = null;
      await new Promise((resolve, reject) => {
        const req = useIdx ? useIdx.openCursor(range, dir) : store.openCursor(null, dir);
        req.onsuccess = async () => {
          const cur = req.result;
          if (!cur) return resolve();
          if (total === null) {
            total = await reqToPromise(useIdx ? useIdx.count(range) : store.count());
          }
          if (items.length < offset + limit) {
            items.push(cur.value);
            cur.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
      return { items: items.slice(offset, offset + limit), total: total || items.length };
    }

    async function getMeta(key) {
      const db = await get();
      const tx = db.transaction([STORE_META], 'readonly');
      const rec = await reqToPromise(tx.objectStore(STORE_META).get(key));
      return rec ? rec.value : undefined;
    }
    async function setMeta(key, value) {
      const db = await get();
      const tx = db.transaction([STORE_META], 'readwrite');
      tx.objectStore(STORE_META).put({ key, value });
      await txDone(tx);
    }

    async function allTombstones() {
      const db = await get();
      const tx = db.transaction([STORE_TOMB], 'readonly');
      return reqToPromise(tx.objectStore(STORE_TOMB).getAll());
    }

    async function applyCategoriesForce(entries) {
      // 导入恢复分类用：按各条目自带的 categoryBy 强制覆盖
      const db = await get();
      let changed = 0;
      for (const chunk of chunkArr(entries.filter((e) => e && isValidId(String(e.id))), CHUNK)) {
        const tx = db.transaction([STORE_VIDEOS], 'readwrite');
        const vs = tx.objectStore(STORE_VIDEOS);
        const work = (async () => {
          for (const entry of chunk) {
            const rec = await reqToPromise(vs.get(String(entry.id)));
            if (!rec) continue;
            const cat = entry.category || null;
            const by = entry.categoryBy || 'import';
            if ((rec.category || null) === cat && rec.categoryBy === by) continue;
            rec.category = cat;
            rec.categoryBy = by;
            rec.catKey = computeCatKey(cat);
            appendHistory(rec, cat, by);
            rec.lastUpdated = now();
            vs.put(rec);
            changed++;
          }
        })();
        await Promise.all([work, txDone(tx)]);
      }
      return { changed };
    }

    async function putTombstones(items) {
      const db = await get();
      for (const chunk of chunkArr(items, CHUNK)) {
        const tx = db.transaction([STORE_TOMB], 'readwrite');
        for (const t of chunk) {
          tx.objectStore(STORE_TOMB).put({ id: String(t.id), deletedAt: Number(t.deletedAt) || now() });
        }
        await txDone(tx);
      }
    }

    async function clearData() {
      const db = await get();
      const tx = db.transaction([STORE_VIDEOS, STORE_TOMB, STORE_META], 'readwrite');
      tx.objectStore(STORE_VIDEOS).clear();
      tx.objectStore(STORE_TOMB).clear();
      tx.objectStore(STORE_META).clear();
      await txDone(tx);
    }

    return {
      kind: 'idb',
      putVideos, migrateInsert, applyCategories, applyCategoriesForce,
      putTombstones, clearData, deleteVideo,
      allVideos, counts, countByCategory, page,
      getMeta, setMeta, allTombstones,
    };
  }

  // ---------- 内存实现（演示模式 / 测试对照） ----------
  function createMemBackend() {
    const videos = new Map();
    const tombs = new Map();
    const meta = new Map();

    async function putVideos(items) {
      const stats = { added: 0, updated: 0, skipped: 0, skippedTombstone: 0 };
      for (const raw of items.filter(Boolean)) {
        if (!isValidId(String(raw && raw.id))) { stats.skipped++; continue; }
        const id = String(raw.id);
        if (tombs.has(id)) { stats.skippedTombstone++; continue; }
        const old = videos.get(id);
        const rec = old ? mergeExisting(old, raw) : newRecord(raw);
        videos.set(id, rec);
        if (old) stats.updated++; else stats.added++;
      }
      return stats;
    }
    async function migrateInsert(items) {
      for (const raw of items) videos.set(String(raw.id), newRecord(raw));
    }
    async function applyCategories(entries, by) {
      let changed = 0;
      for (const entry of entries) {
        const rec = videos.get(String(entry.id));
        if (!rec) continue;
        const cat = entry.category || null;
        if ((rec.category || null) === cat && rec.categoryBy === by) continue;
        rec.category = cat; rec.categoryBy = by; rec.catKey = computeCatKey(cat);
        appendHistory(rec, cat, by); rec.lastUpdated = now();
        changed++;
      }
      return { changed };
    }
    async function deleteVideo(id) {
      id = String(id);
      if (!isValidId(id)) return false;
      videos.delete(id);
      tombs.set(id, { id, deletedAt: now() });
      return true;
    }
    async function allVideos() { return Array.from(videos.values()); }
    async function counts() {
      let un = 0;
      for (const v of videos.values()) if (computeCatKey(v.category) === UNCLASSIFIED_KEY) un++;
      const total = videos.size;
      return { total, unclassified: un, classified: total - un };
    }
    async function countByCategory() {
      const out = {};
      for (const v of videos.values()) {
        const k = computeCatKey(v.category);
        out[k] = (out[k] || 0) + 1;
      }
      return out;
    }
    async function page(opts = {}) {
      const { catKey, source, sort = 'firstSeenDesc', offset = 0, limit = 50 } = opts;
      let list = Array.from(videos.values());
      if (catKey) list = list.filter((v) => computeCatKey(v.category) === catKey);
      if (source) list = list.filter((v) => (v.sources || []).includes(source));
      if (sort === 'title') list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
      else list.sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
      return { items: list.slice(offset, offset + limit), total: list.length };
    }
    async function getMeta(key) { return meta.get(key); }
    async function setMeta(key, value) { meta.set(key, value); }
    async function allTombstones() { return Array.from(tombs.values()); }
    async function applyCategoriesForce(entries) {
      // 导入恢复分类用：按各条目自带的 categoryBy 强制覆盖
      let changed = 0;
      for (const entry of entries) {
        const rec = videos.get(String(entry.id));
        if (!rec) continue;
        const cat = entry.category || null;
        const by = entry.categoryBy || 'import';
        if ((rec.category || null) === cat && rec.categoryBy === by) continue;
        rec.category = cat;
        rec.categoryBy = by;
        rec.catKey = computeCatKey(cat);
        appendHistory(rec, cat, by);
        rec.lastUpdated = now();
        changed++;
      }
      return { changed };
    }
    async function putTombstones(items) {
      for (const t of items) tombs.set(String(t.id), { id: String(t.id), deletedAt: Number(t.deletedAt) || now() });
    }
    async function clearData() { videos.clear(); tombs.clear(); meta.clear(); }

    return {
      kind: 'memory',
      putVideos, migrateInsert, applyCategories, applyCategoriesForce,
      putTombstones, clearData, deleteVideo,
      allVideos, counts, countByCategory, page,
      getMeta, setMeta, allTombstones,
    };
  }

  // ---------- 高层 API（迁移 / 备份 / 清理，两个后端共用） ----------
  function createVideoDB(opts = {}) {
    const hooks = {
      failQueue: [],
      consumeFail(kind) {
        const q = hooks.failQueue;
        if (!q.length) return false;
        const want = q[0];
        if (want === kind || want === '*') { q.shift(); return true; }
        return false;
      },
      // 测试注入：迁移时读取的"旧版数据"，未注入时读真实 chrome.storage
      legacyGet: opts.legacyGet || null,
    };
    const backend = opts.backend === 'memory' ? createMemBackend()
      : opts.backend === 'idb' ? createIdbBackend(hooks, opts)
      : (typeof indexedDB !== 'undefined' ? createIdbBackend(hooks, opts) : createMemBackend());

    // 兼容 shim：旧的 upsertVideos 语义（content script 之外的调用方）
    async function upsertVideosCompat(list) { return backend.putVideos(list || []); }

    // 分类规则批量重算（keepManual=true 时保留 manual 与 ai 的结果）
    async function classifyAll(rules, keepManual = true) {
      const items = await backend.allVideos();
      const changed = [];
      for (const rec of items) {
        if (keepManual && (rec.categoryBy === 'manual' || rec.categoryBy === 'ai')) continue;
        const hit = classifyOne(rec, rules);
        const cat = hit ? hit.name : null;
        if ((rec.category || null) !== cat) changed.push({ id: rec.id, category: cat });
      }
      const res = await backend.applyCategories(changed, 'rule');
      return { ...res, matched: items.length, changed: res.changed };
    }

    // 由 common.js 注入的单条分类函数，避免 db.js 反向依赖 common.js
    let classifyFn = null;
    function setClassifier(fn) { classifyFn = fn; }
    function classifyOne(rec, rules) {
      if (!classifyFn) return null;
      return classifyFn(rec, rules);
    }

    // 旧版 chrome.storage 数据 → 新记录
    function convertLegacy(id, v) {
      if (!isValidId(String(id))) return null;
      if (!v || typeof v !== 'object') return null;
      return {
        id: String(id),
        title: String(v.title || ''),
        author: String(v.author || ''),
        url: v.url || ('https://www.douyin.com/video/' + id),
        cover: String(v.cover || ''),
        postDate: String(v.postDate || ''),
        sources: Array.isArray(v.sources) ? v.sources : [],
        firstSeen: Number(v.firstSeen) || now(),
        category: v.category || null,
        categoryBy: v.categoryBy || null,
        categoryHistory: v.category ? [{ category: v.category, by: v.categoryBy || 'legacy', at: Number(v.firstSeen) || now() }] : [],
        tags: [],
      };
    }

    // ---------- 迁移（幂等，失败不破坏旧数据） ----------
    async function runMigrationIfNeeded() {
      const existing = await backend.getMeta('migration');
      if (existing && existing.state === 'done') return { state: 'done', skipped: true };
      const legacyPayload = hooks.legacyGet
        ? await hooks.legacyGet('videos')
        : await csGet('videos');
      const legacy = legacyPayload.videos;
      const total = legacy ? Object.keys(legacy).length : 0;
      if (!total) {
        const st = { state: 'done', at: now(), count: 0, fresh: true };
        await backend.setMeta('migration', st);
        return st;
      }
      // 迁移前备份：写入库内 meta，同时旧 chrome.storage 键永不删除
      await backend.setMeta('backup:v1', { savedAt: now(), data: legacy });
      const items = [];
      let invalid = 0;
      for (const [id, v] of Object.entries(legacy)) {
        const rec = convertLegacy(id, v);
        if (rec) items.push(rec); else invalid++;
      }
      try {
        await backend.migrateInsert(items);
      } catch (e) {
        const st = { state: 'failed', error: String((e && e.message) || e).slice(0, 300), at: now() };
        await backend.setMeta('migration', st);
        return st;
      }
      const c = await backend.counts();
      if (c.total + invalid < total) {
        const st = { state: 'failed', error: `count mismatch: ${c.total} < ${total}`, at: now() };
        await backend.setMeta('migration', st);
        return st;
      }
      const st = { state: 'done', at: now(), count: items.length, invalid };
      await backend.setMeta('migration', st);
      return st;
    }

    // ---------- 备份与恢复 ----------
    async function exportAll() {
      const [videos, tombstones, lastSync, migration] = await Promise.all([
        backend.allVideos(), backend.allTombstones(),
        backend.getMeta('lastSync'), backend.getMeta('migration'),
      ]);
      return {
        schema: 2,
        exportedAt: new Date().toISOString(),
        videos: Array.isArray(videos) ? videos : Array.from(videos || []),
        tombstones: tombstones || [],
        meta: { lastSync: lastSync || null, migration: migration || null },
      };
    }

    function normalizeImportItem(v) {
      if (!v || !isValidId(String(v.id))) return null;
      const rec = newRecord(v);
      rec.category = v.category || null;
      rec.categoryBy = v.categoryBy || null;
      rec.catKey = computeCatKey(rec.category);
      if (Array.isArray(v.categoryHistory)) rec.categoryHistory = v.categoryHistory.slice(-HISTORY_LIMIT);
      if (Array.isArray(v.tags)) rec.tags = v.tags;
      return rec;
    }

    async function importAll(payload, opts = {}) {
      const { restoreCategories = true } = opts;
      if (!payload || typeof payload !== 'object') throw new Error('备份文件格式不正确');
      let videoEntries, tombstones = [];
      if (payload.schema === 2) {
        videoEntries = payload.videos || [];
        tombstones = payload.tombstones || [];
      } else if (payload.videos && typeof payload.videos === 'object') {
        videoEntries = Object.values(payload.videos); // 旧版 v1 格式兼容
      } else {
        throw new Error('备份文件缺少 videos 数据');
      }
      if (videoEntries.length > 200000) throw new Error('备份数量过大，拒绝导入');
      const items = [];
      let invalid = 0;
      for (const v of videoEntries) {
        const rec = normalizeImportItem(v);
        if (rec) items.push(rec); else invalid++;
      }
      // 合并写入（幂等），随后按"导入时恢复分类"策略覆盖已存在记录的分类字段
      for (const chunk of chunkArr(items, CHUNK)) await backend.putVideos(chunk);
      if (restoreCategories) {
        const entries = items
          .filter((it) => it.categoryBy)
          .map((it) => ({ id: it.id, category: it.category, categoryBy: it.categoryBy }));
        await backend.applyCategoriesForce(entries);
      }
      // 墓碑取并集，防止备份中已删除的视频被再次采集进来
      if (tombstones.length) {
        for (const chunk of chunkArr(tombstones, CHUNK)) await backend.putTombstones(chunk);
      }
      return { imported: items.length, invalid, tombstones: tombstones.length };
    }

    async function clearAll() {
      await backend.clearData();
      await backend.setMeta('schemaVersion', 1);
    }

    return {
      kind: backend.kind,
      putVideos: upsertVideosCompat,
      migrateInsert: backend.migrateInsert.bind(backend),
      applyCategories: backend.applyCategories.bind(backend),
      deleteVideo: backend.deleteVideo.bind(backend),
      allVideos: backend.allVideos.bind(backend),
      counts: backend.counts.bind(backend),
      countByCategory: backend.countByCategory.bind(backend),
      page: backend.page.bind(backend),
      getMeta: backend.getMeta.bind(backend),
      setMeta: backend.setMeta.bind(backend),
      allTombstones: backend.allTombstones.bind(backend),
      classifyAll,
      setClassifier,
      runMigrationIfNeeded,
      exportAll,
      importAll,
      clearAll,
      _testHooks: hooks,
      _backend: backend,
    };
  }

  // 默认单例：扩展页面走 IndexedDB，非扩展环境（演示预览）走内存
  const VideoDB = createVideoDB({});
  globalThis.VideoDB = VideoDB;
  globalThis.createVideoDB = createVideoDB;
  globalThis.UNCLASSIFIED_KEY = UNCLASSIFIED_KEY;
})();
