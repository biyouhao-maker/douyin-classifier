# douyin-classifier 第一阶段：架构审查报告与升级计划

- **项目**：抖音收藏分类助手（Chrome/Edge MV3 浏览器扩展）
- **仓库**：https://github.com/biyouhao-maker/douyin-classifier
- **阶段**：第一阶段 —— 代码审查与数据库架构升级（IndexedDB）
- **审查日期**：2026-11-07
- **审查范围**：manifest.json、background.js、lib/common.js、content/content.js、dashboard/、options/、popup/ 全部源码
- **状态**：报告中的全部问题已在本阶段实施修复（v1.1.0，提交 `64c9aba` + `b21cbd1`），13 项测试双端通过

---

## 一、现有架构问题清单

### 1.1 数据丢失风险（最优先）

| # | 问题 | 位置 | 严重度 | 说明 | 状态 |
|---|------|------|--------|------|------|
| L1 | 读-改-写竞态导致丢数据 | `lib/common.js` `upsertVideos`/`classifyAll`；`dashboard.js` 改分类/删除；`options.js` 导入 | 高 | 三个上下文（采集中的 content script、看板、设置页）都对 `chrome.storage.local` 的 `videos` 大对象做"读全量→内存改→写全量"。采集时每轮滚动（约 650ms）写一次全量，用户此时在看板改分类/删视频，双方互相覆盖，分类修改被静默丢失 | ✅ v1.1.0 已修（事务内合并 + SW 统一写库通道） |
| L2 | 增量采集逻辑失效 | `content/content.js` `runScan` | 高 | 结束条件按"连续 8 轮没有新视频"判定。首次采集每轮都有新视频没问题；但二次采集时页面全是已入库视频，`newFound=0` 连续累积，8 轮后中断——只能扫到前 8~10 屏，永远滚不到列表底部。"增量同步"实际是坏的 | ✅ 已修（滚动进度驱动判定 + 轮数/时长安全上限） |
| L3 | 删除的视频被"复活" | 删除入口 `dashboard.js`；采集 `content.js` | 中高 | 看板删除只移除记录，无墓碑机制；下次采集同一视频重新入库 | ✅ 已修（tombstones 仓库） |
| L4 | AI 分类结果被规则重分类覆盖 | `options.js` 保存规则调用 `classifyAll(true)` 只保留 `manual` | 中 | 用户跑完 AI 分类后点一次"保存规则并重新分类"，所有 `categoryBy:'ai'` 的结果被清空重算 | ✅ 已修（保留 manual 与 ai，已确认的决策） |
| L5 | 导入备份不能恢复已有视频的分类 | `upsertVideos` 对已存在记录忽略导入的 category | 中 | "导入备份"应当尽量还原，当前对重叠视频的分类字段直接丢弃 | ✅ 已修（`restoreCategories` 策略，已确认的决策） |

### 1.2 潜在 Bug

| # | 问题 | 位置 | 说明 | 状态 |
|---|------|------|------|------|
| B1 | `clickMore()` 文本兜底误点 | `content.js` | 兜底会点击任何含"查看更多"的叶子元素，可能误点简介区展开按钮；抖音改版后可能点到跳转元素打断采集 | ✅ 已收紧（文本兜底仅匹配"点击查看更多"完整词，data-e2e 优先） |
| B2 | 标题合并取"更长者" | `common.js` `upsertVideos` | 重扫时若 DOM 解析异常取到带杂质的长文本，覆盖正确的短标题 | ✅ 已修（旧标题非空则保留，仅补空字段） |
| B3 | 未分类哨兵值可被规则名撞车 | `common.js` `UNCLASSIFIED='未分类'` | 用户自建"未分类"分类与哨兵冲突，看板出现重复分组 | ✅ 已修（设置页保存时校验保留字） |
| B4 | 弹窗统计 quirk | `popup.js` | 无数据时"分类数"显示规则数，语义混淆 | ✅ 已修（走 VideoDB.counts，语义清晰） |

### 1.3 性能问题

| # | 问题 | 位置 | 说明 | 状态 |
|---|------|------|------|------|
| P1 | 悬浮球每 2 秒读全量视频库 | `content.js` `setInterval(render, 2000)` | 库 5000 条（约 1~2MB）后，抖音标签页开着每 2 秒全量反序列化一次 | ✅ 已修（轮询只做 DOM 识别；已采总数走一次性 counts 缓存 + 本地累加） |
| P2 | 采集期间每轮滚动全量读写 | `runScan` 每轮 `upsertVideos` + `render()` | 5000 条 × 200 轮 = 数百次 MB 级序列化 | ✅ 已修（IndexedDB 批量事务写入；渲染不读库） |
| P3 | `extractVideos()` 每轮处理全部已加载卡片 | `content.js` | 已加载 1 万张卡后每轮全量提取，即使全是旧视频 | ✅ 已修（先按链接 id 剪枝，只为新 id 提取详情） |
| P4 | 看板一次性渲染全部卡片 | `dashboard.js` `render()` | 几千条时 DOM 卡顿 | ✅ 已修（分组懒加载：每组 120 条，IntersectionObserver 滚动自动追加，外观不变） |

### 1.4 安全问题

| # | 问题 | 位置 | 说明 | 状态 |
|---|------|------|------|------|
| S1 | 导出 HTML 的作者字段未转义（XSS） | `common.js` `buildStaticHTML` | 标题有 `<` 转义、封面有引号转义，但 `<em>${v.author}</em>` 原样注入。作者名来自抖音页面 DOM 文本，恶意作者名可在导出的 HTML 文件里注入标签 | ✅ 已修（全字段 HTML 转义 + 回归用例） |
| S2 | 导入备份缺字段校验（原型污染） | `options.js` → `upsertVideos` | 恶意构造的备份 JSON `id:"__proto__"` 会写成对象原型 | ✅ 已修（id 强校验 `/^\d{1,25}$/`、数量上限、文件大小校验） |
| S3 | background 打开 URL 白名单过宽 | `background.js` | 允许任意 `http(s)`。消息只能来自本扩展上下文，实际风险低 | ✅ 已修（仅允许扩展自身页面） |
| S4 | AI Key 明文存于 chrome.storage | `options.js` | 单机本地存储、按扩展隔离，属可接受风险；备份导出默认剥离 API Key | ✅ 已确认并在设计中落实（v2 备份不含 Key），README 明示 |

### 1.5 浏览器权限

- `optional_host_permissions: ["https://*/*", "http://*/*"]`：AI 接口按需授权，设计合理。可改进项（未实施，后续版本）：把授权粒度缩小到用户配置的 API 域名（兼容本地大模型时保留手动放行）。
- `popup.js` 依赖 `tab.url` 判断页面：当前因 douyin host 权限而工作正常，属"碰巧正确"；重构中改为显式依赖 counts 接口，消除隐患。

### 1.6 模块耦合

- `lib/common.js` 是"上帝文件"（存储层+规则+AI+导出+分组）。✅ 已拆分：`lib/db.js`（IndexedDB 数据层）/ `lib/common.js`（门面：chrome.storage 设置层、规则、AI、导出）/ `background.js`（采集唯一写库通道）。
- **关键平台约束（决定整体架构）**：content script 的 IndexedDB 属于宿主页面源（douyin.com），扩展数据若写进去会被页面脚本读取/清除。因此采集端必须经 `chrome.runtime.sendMessage` 交给 service worker 写扩展自己的 IndexedDB（采集期间消息每秒进入，SW 空闲计时器持续重置，不会中途被杀）。✅ 已按此实现。

---

## 二、新数据库设计（IndexedDB）

数据库名 `dy-classifier`，版本从 1 起。`chrome.storage.local` 继续保存：`rules`（分类规则）、`settings`（AI 配置）、`pendingTask`（任务状态）、迁移完成前的旧 `videos` 键。

```
videos（keyPath: 'id'）
├─ 主键 id：抖音视频 id，纯数字字符串（写入前校验 /^\d{1,25}$/）
├─ 索引 firstSeen   ：按采集时间排序/分页
├─ 索引 catKey      ：分类筛选（category || '__unclassified__'）
├─ 索引 sources     ：数组键 → 自动多值索引，按点赞/收藏筛选
├─ 索引 title / lastUpdated
└─ 记录结构：
   { id, title, author, url, cover, postDate,
     sources: ['like','collect'],
     firstSeen, lastUpdated,
     category, categoryBy: 'rule'|'ai'|'manual'|null,
     categoryHistory: [{category, by, at}],   // 保留人工修改记录，上限 50 条
     tags: [string],
     catKey }

tombstones（keyPath: 'id'）{ id, deletedAt }     // 删除墓碑：采集时跳过

meta（keyPath: 'key'）
├─ 'schemaVersion'  ：数据结构版本
├─ 'migration'      ：{ state: not-started|backup-saved|done|failed, at, count, error }
├─ 'lastSync'       ：{ like: ts, collect: ts }   // 为自动同步预留
└─ 'backup:v1'      ：迁移前的旧版全量数据快照
```

版本迁移机制：`onupgradeneeded` 内 `switch (e.oldVersion)` 逐级升级（v1 建全部仓库与索引；未来 v2 增量加仓，不触碰 v1 数据）。`versionchange` 事件处理旧页面占库。

`lib/db.js` 提供双实现（扩展环境 IndexedDB / 非扩展环境内存），API：`putVideos`（事务内读旧→合并→写）、`applyCategories` / `applyCategoriesForce`（含历史追加）、`deleteVideo`（写墓碑）、`page`（游标分页）、`counts` / `countByCategory`（索引计数）、`exportAll` / `importAll`（v2 备份格式，兼容 v1 导入）、`runMigrationIfNeeded`（幂等迁移）、`clearAll`。

**并发正确性**：所有"读-改-写"合并都在同一 IndexedDB 事务内完成（事务串行化），三个上下文并发写同一视频不再互相覆盖。

---

## 三、迁移方案（兼容现有用户数据）

触发点：扩展页面（popup/看板/设置）启动和 background 收到第一条写库消息时调用 `runMigrationIfNeeded()`。

| 步骤 | 动作 | 失败时 |
|------|------|--------|
| 1 | 读 `meta.migration`，`done=true` 直接返回（幂等，杜绝重复迁移） | — |
| 2 | 检测 chrome.storage 旧 `videos` 键；不存在或为空 → 视为新用户，标记 done | — |
| 3 | 先备份：旧全量数据写入 IDB `meta['backup:v1']`（旧键本身继续保留，永不自动删除） | 备份失败 → 中止，状态 failed，旧数据原封不动 |
| 4 | 旧对象 → 记录数组：字段映射，补充 `tags`/`categoryHistory`（已有分类的合成一条历史）/`catKey`/`lastUpdated`；id 非纯数字的脏数据跳过并计数 | — |
| 5 | **单事务**写入（任何一条失败整体回滚，无半截数据） | 事务 abort → IDB 无残留，旧数据完好，状态 `failed:{error}`，下次启动自动重试 |
| 6 | 校验入库计数 → 写 `meta.migration={done, at, count}` | 校验不过 → 同上回滚处理 |

迁移成功后，设置页"数据管理"区出现手动"清理旧版备份数据"按钮（唯一新增 UI，已确认的决策）。

---

## 四、修改文件清单（实施状态）

| 文件 | 改动 | 状态 |
|------|------|------|
| `lib/db.js` | 新增：IndexedDB 数据层（建库/索引/批量写/分页/计数/墓碑/备份导入导出/迁移/版本机制，双实现） | ✅ |
| `lib/common.js` | 门面化：保留规则/分类/导出（入参兼容数组与对象）；`DB` 收窄为 settings/rules/pendingTask；修 S1/S2/B2/B3 | ✅ |
| `background.js` | 消息路由 `upsertVideos`/`getCounts`（先确保迁移完成）；收紧 `open` 白名单（S3） | ✅ |
| `content/content.js` | 内存缓冲 + 批量 sendMessage（跳转前 await ACK）；修 L2（滚动进度判定 + 安全上限）；id 剪枝（P3）；`render()` 不读全量库（P1）；tombstone 生效（L3）；收紧 clickMore（B1） | ✅ |
| `dashboard/dashboard.js` | 走 db 层；分组懒加载（P4）；删除走墓碑（L3）；改分类追加历史；AI/重分类适配（L4）；UI 外观不变 | ✅ |
| `dashboard/dashboard.html` / `popup/popup.html` / `options/options.html` | script 顺序调整（db.js 先于 common.js）；options 新增清理按钮 | ✅ |
| `options/options.js` | 导入/导出走 db（v2 格式 + 校验 + L5 恢复策略）；清空走 db；清理旧版备份按钮；保留字校验（B3） | ✅ |
| `popup/popup.js` | 统计走 `VideoDB.counts`/`countByCategory`（B4/P1） | ✅ |
| `tests/cases.js` | 新增：13 项共享用例 | ✅ |
| `tests/db.test.mjs` | 新增：Node 套件（fake-indexeddb + node:test，隔离 factory） | ✅ |
| `tests/browser-run.js` + `test/test.html` | 新增：扩展内真 IndexedDB 自检页（独立测试库，不碰用户数据） | ✅ |
| `manifest.json` | version → 1.1.0，**权限零变化** | ✅ |
| `package.json` / `.gitignore` | 测试依赖声明（fake-indexeddb 仅开发用）；忽略 node_modules | ✅ |
| `README.md` | 数据架构、迁移、备份格式 v2、测试说明 | ✅ |

不推翻现有项目、不删任何功能、UI 外观不变。

---

## 五、测试计划与结果

按要求 4 的八项逐条建测试，Node 侧用 fake-indexeddb，扩展内 `test/test.html` 用真实 IndexedDB 复跑同一套用例：

| # | 要求 | 用例 | 结果（Node） | 结果（浏览器真 IDB） |
|---|------|------|------|------|
| 1 | 新增视频 | 写入与字段映射 + 非法 id 跳过 | ✔ | ✔ |
| 2 | 重复视频去重 | added=0/updated=1、旧标题保留、空字段补全 | ✔ | ✔ |
| 3 | 点赞和收藏来源合并 | 双来源、重复来源不膨胀 | ✔ | ✔ |
| 4 | 修改分类 | category/categoryBy/catKey/history 追加、无变化不追加 | ✔ | ✔ |
| 5 | 删除视频 | 记录消失 + 墓碑存在 + 同 id 再采集不复活 | ✔ | ✔ |
| 6 | 大批量写入 | 5000 条分批事务，总数一致（约 170ms） | ✔ | ✔ |
| 7 | 导入和导出 | v2 roundtrip、分类恢复、墓碑合并、v1 旧格式兼容 | ✔ | ✔ |
| 8 | 迁移失败恢复 | 注入写入失败 → 事务回滚无半截数据 → 旧数据完好 → 重试成功 → 幂等跳过 → 备份存在 | ✔ | ✔ |
| + | 回归：L4 | 重分类保留 manual 与 ai；keepManual=false 时 AI 被重算 | ✔ | ✔ |
| + | 回归：S1 | 导出 HTML 作者/标题恶意文本转义 | ✔ | ✔ |
| + | 回归：分页 | 排序/偏移/分类过滤/来源过滤 | ✔ | ✔ |
| + | 回归：L5 | restoreCategories 开关两种取值 | ✔ | ✔ |
| + | 回归：CSV | 引号/逗号/换行转义 | ✔ | ✔ |

**合计 13/13 通过，双端一致。** 运行方式：`npm install && npm test`；浏览器端访问扩展内 `test/test.html`。

---

## 六、后续自动同步模块技术方案（本阶段只出方案，未实现）

- **触发**：content script 监听 SPA 路由与列表 MutationObserver，抖音页面空闲时自动同步；设置页加开关（默认关闭，成熟后默认开），带频率上限与失败退避。
- **增量策略**：抖音喜欢/收藏列表按时间倒序——从顶部扫起，连续 30 条已入库即停止（前提是 L2 修复后滚动逻辑可靠）；首次安装仍全量滚动。
- **通道**：复用本阶段建立的 content → service worker → IndexedDB 批量写入通道；`meta.lastSync` 记录各来源上次同步时间。
- **对账**：取消点赞的视频会从列表消失，本地默认保留；提供手动"全量重扫"，重扫时对消失项仅移除对应 `sources` 标记、不删记录。
- **扩展位**：v2 库版本升级时加 `jobs` 队列仓库，承载 AI 标签、摘要任务。
- **边界**：不实现任何未经授权的抖音数据接口，只用页面可见数据（遵守严格要求 4）。

---

## 七、实施记录

- 提交：`64c9aba`（v1.1.0 主体）、`b21cbd1`（npm test 脚本修正）
- 已推送 GitHub：https://github.com/biyouhao-maker/douyin-classifier
- 待用户实测项：① 升级后首次打开确认自动迁移（旧数据无损）；② 在抖音"喜欢/收藏"页二次采集，确认能滚到列表底部且只补新视频（L2 修复的线上验证——审查与测试环境无法登录抖音实测）；③ 完整扩展环境下 SW 消息链路端到端确认。
