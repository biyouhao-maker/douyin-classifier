// dashboard/dashboard.js —— 分类看板
// 数据读取走 VideoDB（IndexedDB / 演示模式内存实现）；改分类与删除落库（含历史与墓碑）；
// 分组渲染采用懒加载（每组默认渲染 120 条，滚动到底自动追加），外观与原有界面保持一致。
const $ = (s) => document.querySelector(s);

const GROUP_PAGE = 120; // 每个分类初始渲染条数，滚动自动追加

const state = {
  items: [],
  rules: [],
  activeCat: '__all__',
  search: '',
  source: 'all',
  sort: 'time',
  rendered: {}, // catKey -> 已渲染条数
};

function ruleColor(name) {
  const r = state.rules.find((r) => r.name === name);
  return r ? r.color : '#adb5bd';
}

function catKeyOf(v) {
  const names = state.rules.map((r) => r.name);
  return v.category && names.includes(v.category) ? v.category : UNCLASSIFIED;
}

function filteredList() {
  const kw = state.search.trim().toLowerCase();
  let list = state.items;
  if (state.source !== 'all') list = list.filter((v) => (v.sources || []).includes(state.source));
  if (state.activeCat !== '__all__') list = list.filter((v) => catKeyOf(v) === state.activeCat);
  if (kw) list = list.filter((v) => ((v.title || '') + ' ' + (v.author || '')).toLowerCase().includes(kw));
  list.sort(state.sort === 'title'
    ? (a, b) => (a.title || '').localeCompare(b.title || '', 'zh')
    : (a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  return list;
}

function render() {
  const list = filteredList();

  // —— 侧栏 ——
  const groups = {};
  for (const name of state.rules.map((r) => r.name)) groups[name] = [];
  for (const v of state.items) (groups[catKeyOf(v)] = groups[catKeyOf(v)] || []).push(v);

  const side = $('#sidebar');
  side.innerHTML = '';
  const mk = (key, label, count, color) => {
    const div = document.createElement('div');
    div.className = 'cat-item' + (state.activeCat === key ? ' active' : '');
    div.innerHTML = `<span class="dot" style="background:${color}"></span><span class="lbl"></span><span class="count">${count}</span>`;
    div.querySelector('.lbl').textContent = label;
    div.addEventListener('click', () => { state.activeCat = key; render(); });
    side.appendChild(div);
  };
  mk('__all__', '全部视频', state.items.length, '#222');
  side.appendChild(Object.assign(document.createElement('h4'), { textContent: '分类' }));
  for (const r of state.rules) mk(r.name, r.name, (groups[r.name] || []).length, r.color);
  const un = groups[UNCLASSIFIED] || [];
  if (un.length || state.items.length) mk(UNCLASSIFIED, UNCLASSIFIED, un.length, '#adb5bd');

  // —— 汇总 ——
  const total = state.items.length;
  const classified = total - un.length;
  $('#summary').innerHTML = total
    ? `共 <b>${total}</b> 条视频 · 已分类 <b>${classified}</b> 条 · 待分类 <b>${un.length}</b> 条 <span class="ai-progress" id="aiProgress"></span>`
    : '还没有数据 —— 打开抖音网页版，点右下角悬浮球开始采集';

  // —— 网格（分组 + 懒加载）——
  const grid = $('#grid');
  grid.innerHTML = '';
  state.rendered = {};
  if (groupObserver) groupObserver.disconnect();
  if (!list.length) {
    grid.innerHTML = `<div class="empty">这里空空如也<br>去抖音网页版采集「喜欢」和「收藏」的视频吧</div>`;
    return;
  }
  const byCat = {};
  for (const v of list) (byCat[catKeyOf(v)] = byCat[catKeyOf(v)] || []).push(v);
  const order = state.rules.map((r) => r.name).filter((n) => byCat[n]).concat(byCat[UNCLASSIFIED] ? [UNCLASSIFIED] : []);
  for (const cat of order) {
    const items = byCat[cat];
    const title = document.createElement('div');
    title.className = 'group-title';
    title.innerHTML = `<span class="gdot" style="background:${ruleColor(cat)}"></span><span></span><small>${items.length} 条</small>`;
    title.querySelector('span').textContent = cat;
    grid.appendChild(title);
    const vg = document.createElement('div');
    vg.className = 'vgrid';
    vg.dataset.cat = cat;
    grid.appendChild(vg);
    appendGroupItems(cat, items);
  }
}

function appendGroupItems(cat, items) {
  const grid = $('#grid');
  const target = Array.from(grid.querySelectorAll('.vgrid')).find((el) => el.dataset.cat === cat);
  if (!target) return;
  const done = state.rendered[cat] || 0;
  const slice = items.slice(done, done + GROUP_PAGE);
  for (const v of slice) target.appendChild(renderCard(v));
  state.rendered[cat] = done + slice.length;
  const remaining = items.length - state.rendered[cat];
  Array.from(grid.querySelectorAll('.lazy-note')).forEach((n) => { if (n.dataset.cat === cat) n.remove(); });
  if (remaining > 0) {
    // 懒加载哨兵：滚动临近时自动追加下一页，不改变界面结构
    const sentinel = document.createElement('div');
    sentinel.className = 'lazy-note';
    sentinel.dataset.cat = cat;
    sentinel.textContent = `滚动加载更多（${cat} 还剩 ${remaining} 条）…`;
    sentinel.style.cssText = 'padding:14px 4px;font-size:12px;color:#aaa;';
    grid.appendChild(sentinel);
    groupObserver.observe(sentinel);
  }
}

function appendMore(cat) {
  const list = filteredList().filter((v) => catKeyOf(v) === cat);
  appendGroupItems(cat, list);
}

let groupObserver = null;
if ('IntersectionObserver' in window) {
  groupObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const cat = e.target.dataset.cat;
        e.target.remove();
        appendMore(cat);
      }
    }
  }, { rootMargin: '600px' });
} else {
  // 兜底：不支持 IntersectionObserver 时直接全量渲染
  groupObserver = { observe(el) { const cat = el.dataset.cat; el.remove(); appendMore(cat); }, disconnect() {} };
}

function renderCard(v) {
  const card = document.createElement('div');
  card.className = 'vcard';

  const cover = document.createElement('div');
  cover.className = 'cover';
  if (v.cover) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = v.cover;
    img.addEventListener('error', () => { img.remove(); const n = document.createElement('div'); n.className = 'noimg'; n.textContent = '封面不可用'; cover.appendChild(n); });
    cover.appendChild(img);
  } else {
    const n = document.createElement('div'); n.className = 'noimg'; n.textContent = '无封面'; cover.appendChild(n);
  }
  const badges = document.createElement('div');
  badges.className = 'badges';
  for (const s of v.sources || []) {
    const b = document.createElement('span');
    b.className = 'badge ' + s;
    b.textContent = s === 'like' ? '❤ 点赞' : '★ 收藏';
    badges.appendChild(b);
  }
  cover.appendChild(badges);
  cover.addEventListener('click', () => window.open(v.url, '_blank'));

  const body = document.createElement('div');
  body.className = 'vbody';

  const title = document.createElement('div');
  title.className = 'vtitle';
  const a = document.createElement('a');
  a.href = v.url; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = v.title || '(无标题)';
  title.appendChild(a);

  const meta = document.createElement('div');
  meta.className = 'vmeta';
  meta.innerHTML = `<span class="author"></span><span></span>`;
  meta.querySelector('.author').textContent = v.author ? '@' + v.author : '';
  meta.lastElementChild.textContent = v.postDate || '';

  const foot = document.createElement('div');
  foot.className = 'vfoot';
  const sel = document.createElement('select');
  const options = state.rules.map((r) => r.name).concat([UNCLASSIFIED]);
  for (const name of options) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    if (name === catKeyOf(v)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    const cat = sel.value === UNCLASSIFIED ? null : sel.value;
    const by = cat ? 'manual' : null;
    const res = await VideoDB.applyCategories([{ id: v.id, category: cat }], by);
    if (res.changed) {
      const item = state.items.find((x) => x.id === v.id);
      if (item) { item.category = cat; item.categoryBy = by; }
      render();
    }
  });
  const del = document.createElement('button');
  del.className = 'del'; del.title = '从库中删除';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    if (!confirm('确定从库中删除这条视频吗？删除后重新采集也不会再收录它。')) return;
    await VideoDB.deleteVideo(v.id);
    state.items = state.items.filter((x) => x.id !== v.id);
    render();
  });
  foot.appendChild(sel); foot.appendChild(del);

  body.appendChild(title); body.appendChild(meta); body.appendChild(foot);
  card.appendChild(cover); card.appendChild(body);
  return card;
}

// —— 工具栏动作 ——
$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('#sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; render(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

$('#btnRecalc').addEventListener('click', async () => {
  const btn = $('#btnRecalc');
  btn.disabled = true;
  try { await classifyAll(true); await load(); }
  finally { btn.disabled = false; }
});

$('#btnAI').addEventListener('click', async () => {
  const { settings } = await DB.get('settings');
  const ai = settings && settings.ai;
  if (!ai || !ai.enabled) {
    if (confirm('AI 智能分类需要先在设置页配置 API（OpenAI 兼容接口）。\n现在打开设置页吗？')) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    }
    return;
  }
  if (!(await chrome.permissions.contains({ origins: ['https://*/*'] }))) {
    alert('AI 分类需要「访问网络 API」的权限授权，请在设置页点击「授权网络访问」按钮。');
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    return;
  }
  const todo = state.items.filter((v) => !v.category);
  if (!todo.length) { alert('没有待分类的视频（未分类为 0）。'); return; }
  const btn = $('#btnAI');
  btn.disabled = true;
  const prog = () => $('#aiProgress');
  try {
    const result = await aiClassify(todo, { ...ai, categories: state.rules.map((r) => r.name) },
      (done, total) => { const p = prog(); if (p) p.textContent = `AI 分类中… ${done}/${total}`; });
    const entries = Object.entries(result)
      .filter(([id, cat]) => cat !== UNCLASSIFIED)
      .map(([id, cat]) => ({ id, category: cat, categoryBy: 'ai' }));
    await VideoDB.applyCategoriesForce(entries);
    for (const [id, cat] of Object.entries(result)) {
      const item = state.items.find((x) => x.id === id);
      if (item && cat !== UNCLASSIFIED) { item.category = cat; item.categoryBy = 'ai'; }
    }
    render();
    alert(`AI 分类完成：成功 ${entries.length} / ${todo.length} 条`);
  } catch (e) {
    alert('AI 分类失败：' + e.message);
  } finally {
    btn.disabled = false;
    const p = prog(); if (p) p.textContent = '';
  }
});

$('#btnCsv').addEventListener('click', () => downloadFile('douyin-videos.csv', buildCSV(state.items), 'text/csv;charset=utf-8'));
$('#btnJson').addEventListener('click', async () => {
  // JSON 导出 = 完整备份（v2 格式：videos 数组 + 墓碑 + 规则；不含 AI Key 等敏感设置）
  const backup = await VideoDB.exportAll();
  const { rules = [] } = await DB.get('rules');
  backup.rules = rules;
  downloadFile('douyin-videos.json', JSON.stringify(backup, null, 2), 'application/json');
});
$('#btnHtml').addEventListener('click', () => downloadFile('douyin-videos.html', buildStaticHTML(state.items, state.rules), 'text/html;charset=utf-8'));
$('#btnOptions').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
});

// —— 演示数据（非扩展环境预览用）——
const DEMO = [
  ['731', '家常红烧肉的做法，软烂入味超下饭', '厨房日记', 'like', '美食'],
  ['732', '成都三日游保姆级攻略，人均800', '旅行家小鹿', 'collect', '旅行'],
  ['733', '为什么飞机窗户是圆的？冷知识', '科普君', 'like', '知识/学习'],
  ['734', '翻唱《起风了》，一开口就沦陷了', '音乐人阿哲', 'like', '音乐'],
  ['735', '这部电影结尾封神，解说奉上', '老片复刻', 'collect', '影视/综艺'],
  ['736', '沙雕室友日常，笑到打鸣', '快乐源泉', 'like', '搞笑/娱乐'],
  ['737', 'vlog｜独居女孩的一天', '小满生活', 'collect', '生活/日常'],
  ['738', '新手机开箱测评，优缺点全说', '数码大聪明', 'like', '科技/数码'],
  ['739', '十分钟居家健身操，暴汗燃脂', '健身教练阿伟', 'like', '健身/运动'],
  ['740', '我家猫会自己开门了！', '猫咪日常', 'collect', '宠物/动物'],
  ['741', '秋冬通勤穿搭，显瘦又高级', '穿搭笔记', 'like', '穿搭/美妆'],
  ['742', '农村小院改造第30天', '田园生活记', 'collect', '三农/田园'],
  ['743', '关于成长的十句话，共勉', '治愈语录', 'like', '情感/语录'],
  ['744', '宝藏小众露营地点分享', '户外队长', 'like', null],
  ['745', '今天也是想退休的一天', '摸鱼日常', 'collect', null],
].map(([id, title, author, src, cat]) => ({
  id, title, author,
  url: 'https://www.douyin.com/video/' + id,
  cover: '', postDate: '2025-0' + (1 + (id % 9)) + '-1' + (id % 9),
  sources: [src], firstSeen: Date.now() - id * 100000,
  category: cat, categoryBy: cat ? 'rule' : null,
}));

async function load() {
  if (HAS_CHROME) {
    await VideoDB.runMigrationIfNeeded();
    state.items = await VideoDB.allVideos();
    const { rules = null } = await DB.get('rules');
    state.rules = rules || DEFAULT_RULES;
  } else {
    document.getElementById('demoBanner').style.display = '';
    await VideoDB.putVideos(DEMO);
    state.items = await VideoDB.allVideos();
    state.rules = DEFAULT_RULES;
  }
  render();
}

load();
