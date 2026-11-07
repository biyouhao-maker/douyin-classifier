// tests/db.test.mjs —— Node 测试入口：fake-indexeddb + node:test
// 用法：cd douyin-classifier && npm install && node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// 浏览器/SW 中为全局的 IDBKeyRange，在 Node 里由 fake-indexeddb 提供并挂到 globalThis
globalThis.IDBKeyRange = IDBKeyRange;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 以经典脚本方式加载（与浏览器/script 标签一致的词法行为），显式 globalThis 挂载见文件尾部
for (const f of ['lib/db.js', 'lib/common.js', 'tests/cases.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

const env = {
  createCaseDB(opts = {}) {
    return globalThis.createVideoDB({
      backend: 'idb',
      indexedDB: new IDBFactory(), // 每个用例独立的隔离数据库
      dbName: 'case-' + crypto.randomUUID().slice(0, 13),
      ...opts,
    });
  },
  // 两个共享同一底层库的实例（模拟多标签页 / SW 重启后重新打开）
  createPair(dbName) {
    const name = dbName || ('pair-' + crypto.randomUUID().slice(0, 13));
    const f = new IDBFactory();
    return [
      globalThis.createVideoDB({ backend: 'idb', indexedDB: f, dbName: name }),
      globalThis.createVideoDB({ backend: 'idb', indexedDB: f, dbName: name }),
    ];
  },
  IDBFactory,
  classifyVideo: globalThis.classifyVideo,
  DEFAULT_RULES: globalThis.DEFAULT_RULES,
  UNCLASSIFIED_KEY: globalThis.UNCLASSIFIED_KEY,
  buildStaticHTML: globalThis.buildStaticHTML,
  buildCSV: globalThis.buildCSV,
  patternHasInterleave: globalThis.patternHasInterleave,
  shouldStopIncremental: globalThis.shouldStopIncremental,
  SYNC_STATUS: globalThis.SYNC_STATUS,
};

for (const c of globalThis.DBCases.caseList) {
  test(c.name, { timeout: 120000 }, async () => {
    const r = await globalThis.DBCases.runOne(c.name, env);
    if (!r.ok) assert.fail(r.error);
  });
}
