// tests/cases.js —— 数据库测试用例（Node 与浏览器 test.html 共用）
// 依赖：globalThis.createVideoDB / globalThis.classifyVideo / globalThis.DEFAULT_RULES /
//       globalThis.UNCLASSIFIED_KEY / globalThis.buildStaticHTML / globalThis.buildCSV
// 由 lib/db.js 与 lib/common.js 提供（宿主负责先加载）。
(() => {
  function assert(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }
  function assertEq(a, b, msg) {
    if (a !== b) throw new Error('断言失败: ' + msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）');
  }

  function v(id, extra = {}) {
    return {
      id: String(id),
      title: '测试视频 ' + id,
      author: '作者' + id,
      url: 'https://www.douyin.com/video/' + id,
      cover: '',
      postDate: '',
      sources: ['like'],
      firstSeen: 1700000000000 + Number(id) * 1000,
      ...extra,
    };
  }

  const CASES = [
    // ---- 第三阶段：同步任务队列 CRUD ----
    {
      name: '同步任务 CRUD：字段完整、更新、完成与报告',
      async fn(env) {
        const db = env.createCaseDB();
        const acq = await db.acquireSyncJob('like', { trigger: 'auto' });
        assertEq(acq.acquired, true, '首次获取任务');
        const job = acq.job;
        assertEq(job.id, 'sync:like', '任务 ID 固定键');
        assertEq(job.source, 'like', '数据来源');
        assertEq(job.status, 'running', '状态 running');
        assertEq(job.collected, 0, '已采集数量');
        assertEq(job.failed, 0, '失败数量');
        assertEq(job.createdAt > 0 && job.updatedAt > 0 && job.heartbeatAt > 0, true, '时间字段齐全');
        assertEq(typeof job.lastProcessedId === 'string' || job.lastProcessedId === null, true, 'lastProcessedId 类型');
        await db.updateSyncJob('like', { collected: 12, added: 3, existing: 9, failed: 1, lastProcessedId: '999', scanRounds: 4 });
        let j = await db.getSyncJob('like');
        assertEq(j.collected, 12, '更新已采集');
        assertEq(j.lastProcessedId, '999', '更新最后处理 id');
        await db.heartbeatSyncJob('like', { scanRounds: 5 });
        j = await db.getSyncJob('like');
        assertEq(j.scanRounds, 5, '心跳更新进度');
        const fin = await db.finishSyncJob('like', { status: 'done', earlyStop: true });
        assertEq(fin.status, 'done', '完成状态');
        assertEq(fin.finishedAt > 0, true, '完成时间');
        const last = await db.getLastSync('like');
        assertEq(last.status, 'done', '报告 status');
        assertEq(last.added, 3, '报告新增');
        assertEq(last.existing, 9, '报告已存在');
        assertEq(last.failed, 1, '报告失败');
        assertEq(last.earlyStop, true, '报告 earlyStop');
        assertEq(last.at > 0, true, '报告时间');
      },
    },
    // ---- 第三阶段：单来源单任务锁 + 心跳接管 ----
    {
      name: '单来源单任务锁：心跳新鲜拒绝、过期接管、paused/error/done 可新建',
      async fn(env) {
        const db = env.createCaseDB();
        const a1 = await db.acquireSyncJob('like', {});
        assertEq(a1.acquired, true, '第一次获取');
        const a2 = await db.acquireSyncJob('like', {});
        assertEq(a2.acquired, false, 'running 中拒绝');
        assertEq(a2.reason, 'locked', '拒绝原因');
        // 不同来源互不影响
        const a3 = await db.acquireSyncJob('collect', {});
        assertEq(a3.acquired, true, '另一来源不受锁影响');
        // 心跳过期（模拟 SW 被杀后超过阈值）→ 可接管
        await db.updateSyncJob('like', { heartbeatAt: Date.now() - env.SYNC_HEARTBEAT_MS - 1000 });
        const a4 = await db.acquireSyncJob('like', {});
        assertEq(a4.acquired, true, '心跳过期后接管');
        assertEq(a4.reason, 'took-over', '接管标记');
        assertEq(a4.resumed, true, '属于恢复语义');
        assertEq(a4.job.createdAt === a1.job.createdAt, true, '接管保留原 createdAt');
        // paused 状态可接管
        await db.updateSyncJob('like', { status: 'paused', heartbeatAt: Date.now() });
        const a5 = await db.acquireSyncJob('like', {});
        assertEq(a5.acquired, true, 'paused 可接管');
        // done 状态可新建
        await db.finishSyncJob('like', { status: 'done' });
        const a6 = await db.acquireSyncJob('like', {});
        assertEq(a6.acquired, true, 'done 后可新建');
      },
    },
    // ---- 第三阶段：DB v1→v2 升级路径 ----
    {
      name: 'DB v1→v2 升级：jobs 仓库增量创建，旧数据完好',
      async fn(env) {
        if (!env.IDBFactory) {
          // 浏览器端无法手动降版本建 v1 库，退化验证 jobs 仓库可用
          const db = env.createCaseDB();
          const r = await db.acquireSyncJob('like', {});
          assertEq(r.acquired, true, 'jobs 仓库可用');
          return;
        }
        const f = new env.IDBFactory();
        const name = 'upgrade-' + crypto.randomUUID().slice(0, 8);
        // 手动建 v1 结构并写入一条旧数据
        await new Promise((resolve, reject) => {
          const req = f.open(name, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            const videos = db.createObjectStore('videos', { keyPath: 'id' });
            videos.createIndex('firstSeen', 'firstSeen');
            videos.createIndex('lastUpdated', 'lastUpdated');
            videos.createIndex('catKey', 'catKey');
            videos.createIndex('title', 'title');
            videos.createIndex('sources', 'sources', { multiEntry: true });
            db.createObjectStore('tombstones', { keyPath: 'id' });
            const meta = db.createObjectStore('meta', { keyPath: 'key' });
            meta.put({ key: 'schemaVersion', value: 1 });
            videos.add({ id: '111', title: '旧版本数据', author: '', url: 'https://www.douyin.com/video/111', cover: '', postDate: '', sources: ['like'], firstSeen: 1700000000000, lastUpdated: 1700000000000, category: null, categoryBy: null, categoryHistory: [], tags: [], catKey: '__unclassified__' });
          };
          req.onsuccess = () => { req.result.close(); resolve(); };
          req.onerror = () => reject(req.error);
        });
        // 用当前实现打开（DB_VERSION=2）：增量升级
        const db = env.createCaseDB({ indexedDB: f, dbName: name });
        const c = await db.counts();
        assertEq(c.total, 1, 'v1 数据完好');
        const sv = await db.getMeta('schemaVersion');
        assertEq(sv, 2, 'schemaVersion 升级到 2');
        const r = await db.acquireSyncJob('like', {});
        assertEq(r.acquired, true, '升级后 jobs 仓库可用');
      },
    },
    // ---- 第三阶段：SW 重启恢复（双实例共享底层库）----
    {
      name: 'SW 重启恢复：双实例接管 running 孤儿任务并续跑完成',
      async fn(env) {
        const [a, b] = env.createPair();
        await a.putVideos([{ id: '20001', title: '已有视频', url: 'u', sources: ['like'], firstSeen: 1700000000000 }]);
        // 实例 A 开始任务（running，心跳新鲜）
        const acq = await a.acquireSyncJob('like', { trigger: 'auto' });
        assertEq(acq.acquired, true, 'A 获取任务');
        await a.updateSyncJob('like', { collected: 5, lastProcessedId: '20001' });
        // 模拟 SW 被杀：A 停止心跳（把心跳改为过期）
        await a.updateSyncJob('like', { heartbeatAt: Date.now() - env.SYNC_HEARTBEAT_MS - 1000 });
        // 实例 B（重启后的 SW / 另一标签页）接管恢复
        const bAcq = await b.acquireSyncJob('like', { trigger: 'auto' });
        assertEq(bAcq.acquired, true, 'B 接管成功');
        assertEq(bAcq.resumed, true, '标记为恢复');
        const j = await b.getSyncJob('like');
        assertEq(j.collected, 5, '恢复时保留进度记录');
        assertEq(j.lastProcessedId, '20001', '恢复时保留 lastProcessedId');
        // B 续跑完成 → 报告落库
        await b.finishSyncJob('like', { status: 'done', earlyStop: false });
        const last = await b.getLastSync('like');
        assertEq(last.status, 'done', '恢复后完成报告');
        // 已有数据未被破坏
        const c = await b.counts();
        assertEq(c.total, 1, '库数据完好');
      },
    },
    // ---- 第三阶段：getKnownIds（含墓碑）----
    {
      name: 'getKnownIds：按来源返回已入库 id 与墓碑 id',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([
          { id: '30001', title: 'a', url: 'u', sources: ['like'], firstSeen: 1 },
          { id: '30002', title: 'b', url: 'u', sources: ['like'], firstSeen: 2 },
          { id: '30003', title: 'c', url: 'u', sources: ['collect'], firstSeen: 3 },
        ]);
        let k = await db.getKnownIds('like');
        assertEq(k.ids.length, 2, 'like 已入库 2');
        assertEq(k.tombstoneIds.length, 0, '无墓碑');
        await db.deleteVideo('30001');
        k = await db.getKnownIds('like');
        assertEq(k.ids.length, 1, '删除后已入库 1');
        assertEq(k.tombstoneIds.includes('30001'), true, '墓碑单独返回');
        k = await db.getKnownIds('collect');
        assertEq(k.ids.length, 1, 'collect 已入库 1');
      },
    },
    // ---- 第三阶段：失败统计不破坏数据 + error 后可重试 ----
    {
      name: '失败统计：failed 计数、error 状态，已有数据完好、可重新获取任务',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([{ id: '40001', title: 'x', url: 'u', sources: ['like'], firstSeen: 1 }]);
        await db.acquireSyncJob('like', {});
        await db.updateSyncJob('like', { failed: 7 });
        await db.finishSyncJob('like', { status: 'error', error: '网络异常' });
        const j = await db.getSyncJob('like');
        assertEq(j.status, 'error', '任务 error');
        assertEq(j.failed, 7, '失败计数保留');
        const last = await db.getLastSync('like');
        assertEq(last.status, 'error', '报告记录失败');
        assertEq(last.error, '网络异常', '报告错误信息');
        // 已有数据完好
        assertEq((await db.counts()).total, 1, '库数据不受失败影响');
        // error 后可重新获取（允许失败后继续）
        const r = await db.acquireSyncJob('like', {});
        assertEq(r.acquired, true, 'error 后可重新开始');
      },
    },
    // ---- 第三阶段：多标签页并发写同一视频 ----
    {
      name: '多标签页并发：双实例同时写同一视频，来源合并不冲突',
      async fn(env) {
        const [a, b] = env.createPair();
        await Promise.all([
          a.putVideos([{ id: '50001', title: '并发写', url: 'u', sources: ['like'], firstSeen: 1 }]),
          b.putVideos([{ id: '50001', title: '并发写', url: 'u', sources: ['collect'], firstSeen: 1 }]),
        ]);
        const rec = (await a.allVideos()).find((v) => v.id === '50001');
        assertEq(rec.sources.includes('like') && rec.sources.includes('collect'), true, '双来源合并');
        assertEq((await b.counts()).total, 1, '两实例看到同一份数据');
      },
    },
    // ---- 第三阶段：增量停止与异常排序纯函数 ----
    {
      name: '增量判定：正常倒序提前停止，异常排序转深扫',
      async fn(env) {
        const pi = env.patternHasInterleave;
        const ss = env.shouldStopIncremental;
        assertEq(pi(['N', 'N', 'E', 'E']), false, '新→旧 正常倒序');
        assertEq(pi(['N', 'E', 'E', 'N', 'E']), true, '已存在后又出现新视频 → 异常');
        assertEq(pi(['E', 'N', 'E']), true, '新视频夹在已存在之间 → 异常');
        assertEq(pi(['E', 'E', 'E']), false, '全为已存在');
        assertEq(pi(['N', 'N', 'N']), false, '全新');
        assertEq(ss(30, false, 30), true, '连续 30 条已存在 → 停止');
        assertEq(ss(29, false, 30), false, '不足阈值继续');
        assertEq(ss(100, true, 30), false, 'deepScan 模式不提前停止');
        assertEq(pi([]), false, '空序列');
      },
    },
    // ---- 要求 4-1：新增视频 ----
    {
      name: '新增视频：写入与字段映射',
      async fn(env) {
        const db = env.createCaseDB();
        const stats = await db.putVideos([v('1001', { cover: 'http://c/1.jpg', postDate: '2025-01-02' })]);
        assertEq(stats.added, 1, 'added');
        const c = await db.counts();
        assertEq(c.total, 1, 'total');
        const rec = (await db.allVideos())[0];
        assertEq(rec.id, '1001', 'id');
        assertEq(rec.title, '测试视频 1001', 'title');
        assertEq(rec.url, 'https://www.douyin.com/video/1001', 'url');
        assertEq(rec.catKey, '__unclassified__', 'catKey 初始未分类');
        assertEq(rec.category, null, 'category 初始 null');
        assertEq(rec.categoryBy, null, 'categoryBy 初始 null');
        assertEq(rec.lastUpdated > 0, true, 'lastUpdated 存在');
        // 非法 id 被跳过（S2：导入/采集侧校验）
        const s2 = await db.putVideos([{ id: '__proto__', title: 'x' }, { id: 'bad-id', title: 'y' }]);
        assertEq(s2.skipped, 2, '非法 id 全部跳过');
        assertEq((await db.counts()).total, 1, '总数不变');
      },
    },
    // ---- 要求 4-2：重复视频去重 ----
    {
      name: '重复视频去重：added=0 updated=1，旧标题保留',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([v('2001', { title: '原始标题' })]);
        const stats = await db.putVideos([v('2001', { title: '更长的可疑标题带杂质' })]);
        assertEq(stats.added, 0, '不重复新增');
        assertEq(stats.updated, 1, '更新一次');
        assertEq((await db.counts()).total, 1, '总数不变');
        const rec = (await db.allVideos())[0];
        assertEq(rec.title, '原始标题', '旧标题保留（B2：重扫不覆盖）');
        // 空字段补全
        await db.deleteVideo('2001');
        await db.putVideos([v('2002', { title: '' })]);
        await db.putVideos([v('2002', { title: '补充标题' })]);
        const rec2 = (await db.allVideos()).find((x) => x.id === '2002');
        assertEq(rec2.title, '补充标题', '空标题被补全');
      },
    },
    // ---- 要求 4-3：点赞和收藏来源合并 ----
    {
      name: '来源合并：点赞+收藏双标记',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([v('3001', { sources: ['like'] })]);
        await db.putVideos([v('3001', { sources: ['collect'] })]);
        const rec = (await db.allVideos())[0];
        assertEq(rec.sources.length, 2, '双来源');
        assertEq(rec.sources.includes('like') && rec.sources.includes('collect'), true, 'like 与 collect 齐全');
        await db.putVideos([v('3001', { sources: ['like', 'like'] })]);
        const rec2 = (await db.allVideos())[0];
        assertEq(rec2.sources.length, 2, '重复来源不膨胀');
      },
    },
    // ---- 要求 4-4：修改分类（含历史记录）----
    {
      name: '修改分类：categoryBy 与 categoryHistory 记录',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([v('4001')]);
        await db.applyCategories([{ id: '4001', category: '美食' }], 'manual');
        let rec = (await db.allVideos())[0];
        assertEq(rec.category, '美食', 'category');
        assertEq(rec.categoryBy, 'manual', 'categoryBy');
        assertEq(rec.catKey, '美食', 'catKey');
        assertEq(rec.categoryHistory.length, 1, '历史 1 条');
        assertEq(rec.categoryHistory[0].by, 'manual', '历史来源 manual');
        await db.applyCategories([{ id: '4001', category: null }], 'manual');
        rec = (await db.allVideos())[0];
        assertEq(rec.category, null, '改回未分类');
        assertEq(rec.catKey, '__unclassified__', 'catKey 回退');
        assertEq(rec.categoryHistory.length, 2, '历史 2 条');
        // 相同值重复设置不追加历史
        await db.applyCategories([{ id: '4001', category: null }], 'manual');
        rec = (await db.allVideos())[0];
        assertEq(rec.categoryHistory.length, 2, '无变化不追加历史');
      },
    },
    // ---- 要求 4-5：删除视频 + 墓碑防复活 ----
    {
      name: '删除视频：墓碑生效，重新采集不复活（L3）',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([v('5001'), v('5002')]);
        await db.deleteVideo('5001');
        assertEq((await db.counts()).total, 1, '删除后总数');
        const tombs = await db.allTombstones();
        assertEq(tombs.length, 1, '墓碑 1 条');
        assertEq(tombs[0].id, '5001', '墓碑 id');
        // 同一视频再次被采集 → 跳过
        const stats = await db.putVideos([v('5001'), v('5003')]);
        assertEq(stats.skippedTombstone, 1, '墓碑命中跳过');
        assertEq((await db.counts()).total, 2, '不复活，仅新增 5003');
      },
    },
    // ---- 要求 4-6：大批量写入 ----
    {
      name: '大批量写入：5000 条分批事务',
      async fn(env) {
        const db = env.createCaseDB();
        const items = [];
        for (let i = 1; i <= 5000; i++) items.push(v('9' + String(i).padStart(6, '0')));
        const t0 = Date.now();
        const stats = await db.putVideos(items);
        const ms = Date.now() - t0;
        assertEq(stats.added, 5000, '全部新增');
        assertEq((await db.counts()).total, 5000, '总数一致');
        assertEq(ms < 60000, true, '耗时 ' + ms + 'ms（<60s）');
      },
    },
    // ---- 要求 4-7：导入和导出 ----
    {
      name: '导入导出：v2 roundtrip + 分类恢复 + 墓碑合并 + v1 兼容',
      async fn(env) {
        // 导出侧
        const dbA = env.createCaseDB();
        await dbA.putVideos([
          v('6001', { sources: ['like'] }),
          v('6002', { sources: ['collect'] }),
          v('6003'),
        ]);
        await dbA.applyCategories([{ id: '6001', category: '旅行' }], 'manual');
        await dbA.applyCategories([{ id: '6002', category: '美食' }], 'ai');
        await dbA.deleteVideo('6003');
        const backup = await dbA.exportAll();
        assertEq(backup.schema, 2, 'schema=2');
        assertEq(backup.videos.length, 2, '导出视频数');
        assertEq(backup.tombstones.length, 1, '导出墓碑数');

        // 导入到全新库
        const dbB = env.createCaseDB();
        const res = await dbB.importAll(backup, { restoreCategories: true });
        assertEq(res.imported, 2, '导入视频数');
        assertEq((await dbB.counts()).total, 2, '导入后总数');
        const recs = await dbB.allVideos();
        const r1 = recs.find((x) => x.id === '6001');
        const r2 = recs.find((x) => x.id === '6002');
        assertEq(r1.category, '旅行', '恢复分类 6001');
        assertEq(r1.categoryBy, 'manual', '恢复 categoryBy');
        assertEq(r2.categoryBy, 'ai', '恢复 AI 标记');
        // 墓碑一并导入：6003 不会被再次采入
        const s = await dbB.putVideos([v('6003')]);
        assertEq(s.skippedTombstone, 1, '导入的墓碑生效');

        // 旧版 v1 格式（videos 为对象）兼容导入
        const dbC = env.createCaseDB();
        await dbC.importAll({
          videos: { '7001': { ...v('7001'), category: '搞笑/娱乐', categoryBy: 'rule' } },
        }, { restoreCategories: true });
        const recC = (await dbC.allVideos())[0];
        assertEq(recC.id, '7001', 'v1 导入 id');
        assertEq(recC.category, '搞笑/娱乐', 'v1 导入分类');
      },
    },
    // ---- 要求 4-8：迁移失败恢复 ----
    {
      name: '迁移：失败回滚 → 旧数据完好 → 重试成功 → 幂等',
      async fn(env) {
        const legacy = {
          videos: {
            '8001': { ...v('8001'), category: '美食', categoryBy: 'rule' },
            '8002': v('8002'),
            'bad': { title: '非法 id' },
          },
        };
        // 第一次：注入写入失败
        const db = env.createCaseDB({ legacyGet: () => Promise.resolve(legacy) });
        db._testHooks.failQueue = ['migrate'];
        const r1 = await db.runMigrationIfNeeded();
        assertEq(r1.state, 'failed', '首次迁移失败');
        assertEq((await db.allVideos()).length, 0, '事务回滚，无半截数据');
        // 旧数据仍可读取（legacyGet 持续提供旧数据，模拟"旧数据完好不删除"）
        // 第二次：恢复后重试
        const r2 = await db.runMigrationIfNeeded();
        assertEq(r2.state, 'done', '重试成功');
        assertEq(r2.count, 2, '有效条数（非法 id 剔除）');
        assertEq((await db.counts()).total, 2, '入库总数');
        const rec = (await db.allVideos()).find((x) => x.id === '8001');
        assertEq(rec.category, '美食', '旧分类迁移保留');
        assertEq(rec.categoryHistory.length, 1, '合成历史记录');
        // 第三次：幂等，不再迁移
        const r3 = await db.runMigrationIfNeeded();
        assertEq(r3.state, 'done', 'done');
        assertEq(r3.skipped, true, '幂等跳过');
        // 迁移备份已写入 meta
        const backup = await db.getMeta('backup:v1');
        assertEq(!!(backup && backup.data), true, '迁移前备份存在');
        // 新用户（无旧数据）也标记 done
        const dbFresh = env.createCaseDB({ legacyGet: () => Promise.resolve({}) });
        const rf = await dbFresh.runMigrationIfNeeded();
        assertEq(rf.state, 'done', '新用户直接 done');
        assertEq(rf.fresh, true, '标记 fresh');
      },
    },
    // ---- 行为决策回归：重分类保留 manual 与 ai ----
    {
      name: '按规则重分类：保留手动与 AI 结果（L4）',
      async fn(env) {
        const db = env.createCaseDB();
        db.setClassifier(env.classifyVideo); // 生产环境由 common.classifyAll 惰性注入；测试直接调用需手动注入
        await db.putVideos([
          v('9001', { title: '家常菜做法教学，超下饭' }), // 将被规则归入 美食（关键词"菜"）
          v('9002', { title: '云南旅行攻略，人均800' }), // 将被规则归入 旅行（关键词"旅行/攻略"）
        ]);
        await db.applyCategories([{ id: '9002', category: '知识/学习' }], 'ai');
        await db.putVideos([v('9003')]);
        await db.applyCategories([{ id: '9003', category: '自定义' }], 'manual');
        const rules = env.DEFAULT_RULES;
        const res = await db.classifyAll(rules, true);
        const recs = await db.allVideos();
        const m = Object.fromEntries(recs.map((r) => [r.id, r]));
        assertEq(m['9001'].category, '美食', '9001 命中规则');
        assertEq(m['9001'].categoryBy, 'rule', 'rule 标记');
        assertEq(m['9002'].category, '知识/学习', 'AI 结果保留');
        assertEq(m['9002'].categoryBy, 'ai', 'AI 标记保留');
        assertEq(m['9003'].category, '自定义', '手动结果保留');
        assertEq(m['9003'].categoryBy, 'manual', 'manual 标记保留');
        assertEq(res.changed >= 1, true, '至少改写 9001');
        // keepManual=false 时 AI 被重算
        await db.classifyAll(rules, false);
        const m2 = Object.fromEntries((await db.allVideos()).map((r) => [r.id, r]));
        assertEq(m2['9002'].category, '旅行', 'keepManual=false 时 AI 被规则覆盖');
      },
    },
    // ---- 安全回归：S1 导出 HTML 全字段转义 ----
    {
      name: '导出 HTML：作者/标题恶意文本被转义（S1 XSS）',
      async fn(env) {
        const html = env.buildStaticHTML(
          [{ id: '1001', title: '<img src=x onerror=alert(1)>', author: '<script>bad()</script>', url: 'https://www.douyin.com/video/1001', sources: ['like'], category: '美食' }],
          env.DEFAULT_RULES,
        );
        assertEq(html.includes('<img src=x'), false, '标题标签未注入');
        assertEq(html.includes('<script>bad()'), false, '作者 script 未注入');
        assertEq(html.includes('&lt;img src=x'), true, '标题已转义');
        assertEq(html.includes('&lt;script&gt;'), true, '作者已转义');
      },
    },
    // ---- 数据库能力：分页查询 ----
    {
      name: '分页查询：排序/偏移/分类过滤/来源过滤',
      async fn(env) {
        const db = env.createCaseDB();
        const items = [];
        for (let i = 1; i <= 50; i++) items.push(v(String(10000 + i)));
        await db.putVideos(items);
        await db.applyCategories(items.slice(0, 10).map((x) => ({ id: x.id, category: '美食' })), 'manual');
        const p1 = await db.page({ sort: 'firstSeenDesc', offset: 0, limit: 10 });
        assertEq(p1.total, 50, 'total');
        assertEq(p1.items.length, 10, '页大小');
        assertEq(p1.items[0].id, '10050', 'firstSeenDesc 首条');
        const p2 = await db.page({ sort: 'firstSeenDesc', offset: 10, limit: 10 });
        assertEq(p2.items[0].id, '10040', '第二页首条');
        const pc = await db.page({ catKey: '美食', sort: 'firstSeenAsc', offset: 0, limit: 100 });
        assertEq(pc.total, 10, '分类过滤 total');
        const ps = await db.page({ source: 'like', sort: 'firstSeenDesc', offset: 0, limit: 100 });
        assertEq(ps.total, 50, '来源过滤 total');
      },
    },
    // ---- 行为决策回归：导入恢复分类 ----
    {
      name: '导入恢复分类：restoreCategories 开关生效（L5）',
      async fn(env) {
        const db = env.createCaseDB();
        await db.putVideos([v('1101')]); // 本地无分类
        const backup = { schema: 2, videos: [{ ...v('1101'), category: '宠物/动物', categoryBy: 'rule' }], tombstones: [] };
        await db.importAll(backup, { restoreCategories: true });
        let rec = (await db.allVideos())[0];
        assertEq(rec.category, '宠物/动物', '恢复导入分类');
        // 关闭开关：已存在记录不覆盖
        await db.applyCategories([{ id: '1101', category: null }], 'manual');
        await db.importAll(backup, { restoreCategories: false });
        rec = (await db.allVideos())[0];
        assertEq(rec.category, null, '关闭恢复时保留本地状态');
      },
    },
    // ---- CSV 转义回归 ----
    {
      name: 'CSV 导出：引号/逗号/换行转义正确',
      async fn(env) {
        const csv = env.buildCSV([{ id: '1201', title: '带"引号",逗号\n换行', author: 'a"b', url: 'u', sources: ['like'], category: '美食', firstSeen: 1700000000000 }]);
        const line = csv.split('\r\n')[1];
        assertEq(line.includes('""'), true, '引号翻倍');
        assertEq(csv.split('\r\n').length, 2, '字段内换行被引号包裹');
        assertEq(line.startsWith('美食,点赞,"带'), true, '字段结构正确');
      },
    },
  ];

  globalThis.DBCases = {
    caseList: CASES,
    async runAll(env) {
      const results = [];
      for (const c of CASES) {
        try { await c.fn(env); results.push({ name: c.name, ok: true }); }
        catch (e) { results.push({ name: c.name, ok: false, error: String((e && e.message) || e) }); }
      }
      return results;
    },
    async runOne(name, env) {
      const c = CASES.find((x) => x.name === name);
      if (!c) throw new Error('未知用例: ' + name);
      try { await c.fn(env); return { name, ok: true }; }
      catch (e) { return { name, ok: false, error: String((e && e.message) || e) }; }
    },
  };
})();
