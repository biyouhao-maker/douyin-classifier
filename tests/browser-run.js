// tests/browser-run.js —— test/test.html 的浏览器运行器（真 IndexedDB、独立测试库）
(async () => {
  const env = {
    createCaseDB(opts = {}) {
      // 测试库名需要唯一性：使用 crypto 级随机（非安全敏感场景，但统一走 CSPRNG）
      const suffix = crypto.randomUUID().slice(0, 13);
      return globalThis.createVideoDB({
        backend: 'idb',
        dbName: 'dy-classifier-selftest-' + suffix,
        ...opts,
      });
    },
    classifyVideo: globalThis.classifyVideo,
    DEFAULT_RULES: globalThis.DEFAULT_RULES,
    UNCLASSIFIED_KEY: globalThis.UNCLASSIFIED_KEY,
    buildStaticHTML: globalThis.buildStaticHTML,
    buildCSV: globalThis.buildCSV,
  };
  const results = await globalThis.DBCases.runAll(env);
  const box = document.getElementById('results');
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'case';
    div.innerHTML = `<b class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✓ PASS' : '✗ FAIL'}</b> ${r.name}`;
    if (!r.ok) {
      const d = document.createElement('div');
      d.className = 'err-detail';
      d.textContent = r.error;
      div.appendChild(d);
    }
    box.appendChild(div);
  }
  const pass = results.filter((r) => r.ok).length;
  const s = document.getElementById('summary');
  s.textContent = `通过 ${pass} / ${results.length}`;
  s.className = pass === results.length ? 'ok' : 'err';
})();
