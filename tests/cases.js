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
