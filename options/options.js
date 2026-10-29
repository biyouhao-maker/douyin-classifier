// options/options.js —— 规则管理、AI 配置、数据管理
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
  await DB.set({ rules });
  await classifyAll(true); // 保留手动指定的分类
  tip('✓ 已保存并重新分类');
});

// ---------- AI 设置 ----------
function fillAI() {
  const { settings = {} } = mem;
  const ai = settings.ai || {};
  $('#aiEnabled').checked = !!ai.enabled;
  $('#aiBaseUrl').value = ai.baseUrl || '';
  $('#aiKey').value = ai.apiKey || '';
  $('#aiModel').value = ai.model || '';
}

let mem = { settings: {} };

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
  const all = await DB.get(null);
  downloadFile('douyin-classifier-backup.json', JSON.stringify(all, null, 2), 'application/json');
});

$('#btnImport').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !('videos' in data)) throw new Error('文件格式不正确');
    if (!confirm('导入将合并到现有数据中，继续吗？')) return;
    if (data.videos) await upsertVideos(Object.values(data.videos));
    if (Array.isArray(data.rules) && data.rules.length) await DB.set({ rules: data.rules });
    if (data.settings) await DB.set({ settings: data.settings });
    await init();
    tip('✓ 导入完成');
  } catch (err) {
    alert('导入失败：' + err.message);
  } finally {
    e.target.value = '';
  }
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('确定清空所有已采集的数据吗？此操作不可恢复！')) return;
  if (!confirm('再次确认：真的要清空吗？建议先导出备份。')) return;
  await DB.remove('videos');
  tip('✓ 已清空');
});

// ---------- 初始化 ----------
async function init() {
  const { rules: saved = null, settings = {} } = await DB.get(['rules', 'settings']);
  mem = { settings };
  rules = saved || JSON.parse(JSON.stringify(DEFAULT_RULES));
  renderRules();
  fillAI();
}
init();
