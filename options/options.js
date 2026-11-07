// options/options.js —— 规则管理、AI 配置、数据管理
// 视频数据操作全部走 VideoDB（IndexedDB）；规则/AI 配置仍存 chrome.storage。
const $ = (s) => document.querySelector(s);
let rules = [];

function tip(msg = '✓ 已保存') {
  const t = $('#savedTip');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- 分类规则 ----------
function renderRules() {
  const list = $('#ruleList');
  list.innerHTML = '';
  rules.forEach((rule, i) => {
    const div = document.createElement('div');
    div.className = 'rule';
    div.innerHTML = `
      <input type="color" value="${rule.color || '#fe2c55'}" title="颜色" />
      <input type="text" class="name" placeholder="分类名" />
      <input type="text" class="kw" placeholder="关键词，用逗号分隔，如：美食,探店,烘焙" />
      <button class="rm" title="删除该分类">×</button>`;
    div.querySelector('input[type=color]').addEventListener('input', (e) => { rule.color = e.target.value; });
    const nameEl = div.querySelector('.name');
    nameEl.value = rule.name;
    nameEl.addEventListener('input', () => { rule.name = nameEl.value; });
    const kwEl = div.querySelector('.kw');
    kwEl.value = (rule.keywords || []).join(', ');
    kwEl.addEventListener('input', () => {
      rule.keywords = kwEl.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    });
    div.querySelector('.rm').addEventListener('click', () => { rules.splice(i, 1); renderRules(); });
    list.appendChild(div);
  });
}

$('#btnAddRule').addEventListener('click', () => {
  rules.push({ name: '新分类', color: '#4dabf7', keywords: [] });
  renderRules();
});

$('#btnResetRules').addEventListener('click', () => {
  if (!confirm('确定恢复为默认分类规则吗？当前自定义规则将被覆盖。')) return;
  rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  renderRules();
});

$('#btnSaveRules').addEventListener('click', async () => {
  rules = rules.filter((r) => r.name && r.name.trim());
  // "未分类"是保留字，避免与未分组哨兵冲突
  const reserved = rules.find((r) => r.name.trim() === UNCLASSIFIED);
  if (reserved) { alert('分类名"未分类"是保留字，请改用其他名称。'); return; }
  await DB.set({ rules });
  await classifyAll(true); // 保留手动与 AI 指定的分类
  tip('✓ 已保存并重新分类');
});

// ---------- AI 设置 ----------
let mem = { settings: {} };

function fillAI() {
  const { settings = {} } = mem;
  const ai = settings.ai || {};
  $('#aiEnabled').checked = !!ai.enabled;
  $('#aiBaseUrl').value = ai.baseUrl || '';
  $('#aiKey').value = ai.apiKey || '';
  $('#aiModel').value = ai.model || '';
}

$('#btnPerm').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
    const st = $('#aiStatus');
    st.className = granted ? 'ok' : 'err';
    st.textContent = granted ? '✓ 已授权网络访问，可以测试连接了' : '未授权 —— AI 分类将无法请求接口';
  } catch (e) {
    const st = $('#aiStatus');
    st.className = 'err';
    st.textContent = '授权失败：' + e.message;
  }
});

$('#btnTestAI').addEventListener('click', async () => {
  const st = $('#aiStatus');
  const cfg = {
    baseUrl: $('#aiBaseUrl').value.trim(),
    apiKey: $('#aiKey').value.trim(),
    model: $('#aiModel').value.trim() || 'deepseek-chat',
  };
  if (!cfg.baseUrl || !cfg.apiKey) { st.className = 'err'; st.textContent = '请先填写接口地址和 API Key'; return; }
  st.className = ''; st.textContent = '测试中…';
  try {
    const text = await chatOnce(cfg, '只回复两个字：成功');
    st.className = 'ok';
    st.textContent = '✓ 连接成功：' + text.slice(0, 50);
  } catch (e) {
    st.className = 'err';
    st.textContent = '连接失败：' + e.message;
  }
});

$('#btnSaveAI').addEventListener('click', async () => {
  const { settings = {} } = await DB.get('settings');
  settings.ai = {
    enabled: $('#aiEnabled').checked,
    baseUrl: $('#aiBaseUrl').value.trim(),
    apiKey: $('#aiKey').value.trim(),
    model: $('#aiModel').value.trim() || 'deepseek-chat',
  };
  await DB.set({ settings });
  tip();
});

// ---------- 数据管理 ----------
$('#btnExport').addEventListener('click', async () => {
  // v2 备份：视频数组 + 墓碑 + 元信息 + 规则（不含 AI Key 等敏感设置）
  const backup = await VideoDB.exportAll();
  backup.rules = rules;
  downloadFile('douyin-classifier-backup.json', JSON.stringify(backup, null, 2), 'application/json');
});

$('#btnImport').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB，请确认是否为有效备份');
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !('videos' in data)) throw new Error('文件格式不正确');
    if (!confirm('导入将合并到现有数据中（同 id 视频恢复备份中的分类），继续吗？')) return;
    const res = await VideoDB.importAll(data, { restoreCategories: true });
    if (Array.isArray(data.rules) && data.rules.length) {
      await DB.set({ rules: data.rules });
      await initRules();
    }
    tip(`✓ 导入完成：${res.imported} 条${res.invalid ? `（跳过异常 ${res.invalid} 条）` : ''}`);
  } catch (err) {
    alert('导入失败：' + err.message);
  } finally {
    e.target.value = '';
  }
});

// 迁移成功后的可选清理：删除 chrome.storage 中的旧版 videos 与库内 backup:v1 数据（手动触发）
async function refreshLegacySection() {
  const btn = $('#btnCleanLegacy');
  const hint = $('#legacyHint');
  const mig = await VideoDB.getMeta('migration');
  const hasLegacy = Object.keys(await DB.get('videos')).length > 0;
  const backupRec = await VideoDB.getMeta('backup:v1');
  const hasBackup = !!(backupRec && backupRec.data);
  if (mig && mig.state === 'done' && (hasLegacy || hasBackup)) {
    btn.style.display = '';
    hint.textContent = `检测到旧版数据残留（chrome.storage 视频 ${hasLegacy ? '有' : '无'}、迁移备份 ${hasBackup ? '有' : '无'}），确认新数据库工作正常后可清理。`;
  } else {
    btn.style.display = 'none';
    if (mig && mig.state === 'failed') hint.textContent = '上次数据迁移失败：' + (mig.error || '未知原因') + '。旧数据完好，下次启动将自动重试。';
    else hint.textContent = '';
  }
}

$('#btnCleanLegacy').addEventListener('click', async () => {
  if (!confirm('清理旧版备份数据？新数据库不受影响。建议先导出一份 JSON 备份再清理。')) return;
  await DB.remove('videos');
  // backup:v1 记录本身保留为占位标记（防止重复迁移判断依赖它），只移除其中的数据体
  await VideoDB.setMeta('backup:v1', { clearedAt: Date.now() });
  await refreshLegacySection();
  tip('✓ 已清理');
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('确定清空所有已采集的视频数据吗？此操作不可恢复！')) return;
  if (!confirm('再次确认：真的要清空吗？建议先导出备份。')) return;
  await VideoDB.clearAll();
  await DB.remove('videos'); // 顺带清掉可能残留的旧版数据
  await DB.remove('pendingTask');
  await refreshLegacySection();
  tip('✓ 已清空');
});

// ---------- 初始化 ----------
async function initRules() {
  const { rules: saved = null } = await DB.get('rules');
  rules = saved || JSON.parse(JSON.stringify(DEFAULT_RULES));
  renderRules();
}

async function init() {
  await VideoDB.runMigrationIfNeeded();
  await initRules();
  fillAI();
  await refreshLegacySection();
}
init();
