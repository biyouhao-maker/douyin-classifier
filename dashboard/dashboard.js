// dashboard/dashboard.js —— 分类看板
const $ = (s) => document.querySelector(s);

const state = {
  videos: {},
  rules: [],
  activeCat: '__all__',
  search: '',
  source: 'all',
  sort: 'time',
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
  let list = Object.values(state.videos);
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
  for (const v of Object.values(state.videos)) (groups[catKeyOf(v)] = groups[catKeyOf(v)] || []).push(v);

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
  mk('__all__', '全部视频', Object.keys(state.videos).length, '#222');
  side.appendChild(Object.assign(document.createElement('h4'), { textContent: '分类' }));
  for (const r of state.rules) mk(r.name, r.name, (groups[r.name] || []).length, r.color);
  const un = groups[UNCLASSIFIED] || [];
  if (un.length || Object.keys(state.videos).length) mk(UNCLASSIFIED, UNCLASSIFIED, un.length, '#adb5bd');

  // —— 汇总 ——
  const total = Object.keys(state.videos).length;
  const classified = total - un.length;
  $('#summary').innerHTML = total
    ? `共 <b>${total}</b> 条视频 · 已分类 <b>${classified}</b> 条 · 待分类 <b>${un.length}</b> 条 <span class="ai-progress" id="aiProgress"></span>`
    : '还没有数据 —— 打开抖音网页版，点右下角悬浮球开始采集';

  // —— 网格 ——
  const grid = $('#grid');
  grid.innerHTML = '';
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
    items.forEach((v) => vg.appendChild(renderCard(v)));
    grid.appendChild(vg);
  }
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
  meta.innerHTML = `<span class="author"></span><span>${v.postDate || ''}</span>`;
  meta.querySelector('.author').textContent = v.author ? '@' + v.author : '';

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
    const { videos } = await DB.get('videos');
    const t = videos[v.id];
    if (!t) return;
    if (sel.value === UNCLASSIFIED) { t.category = null; t.categoryBy = null; }
    else { t.category = sel.value; t.categoryBy = 'manual'; }
    await DB.set({ videos });
    render();
  });
  const del = document.createElement('button');
  del.className = 'del'; del.title = '从库中删除';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    if (!confirm('确定从库中删除这条视频吗？')) return;
    const { videos } = await DB.get('videos');
    delete videos[v.id];
    await DB.set({ videos });
    delete state.videos[v.id];
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
  await classifyAll(true);
  await load();
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
  const todo = Object.values(state.videos).filter((v) => !v.category);
  if (!todo.length) { alert('没有待分类的视频（未分类为 0）。'); return; }
  const btn = $('#btnAI');
  btn.disabled = true;
  const prog = () => $('#aiProgress');
  try {
    const result = await aiClassify(todo, { ...ai, categories: state.rules.map((r) => r.name) },
      (done, total) => { const p = prog(); if (p) p.textContent = `AI 分类中… ${done}/${total}`; });
    const { videos } = await DB.get('videos');
    for (const [id, cat] of Object.entries(result)) {
      if (videos[id] && cat !== UNCLASSIFIED) { videos[id].category = cat; videos[id].categoryBy = 'ai'; }
    }
    await DB.set({ videos });
    await load();
    alert(`AI 分类完成：成功 ${Object.keys(result).length} / ${todo.length} 条`);
  } catch (e) {
    alert('AI 分类失败：' + e.message);
  } finally {
    btn.disabled = false;
    const p = prog(); if (p) p.textContent = '';
  }
});

$('#btnCsv').addEventListener('click', async () => {
  const { videos = {} } = await DB.get('videos');
  downloadFile('douyin-videos.csv', buildCSV(videos), 'text/csv;charset=utf-8');
});
$('#btnJson').addEventListener('click', async () => {
  const { videos = {}, rules = [] } = await DB.get(['videos', 'rules']);
  downloadFile('douyin-videos.json', JSON.stringify({ exportedAt: new Date().toISOString(), rules, videos }, null, 2), 'application/json');
});
$('#btnHtml').addEventListener('click', async () => {
  const { videos = {}, rules = [] } = await DB.get(['videos', 'rules']);
  downloadFile('douyin-videos.html', buildStaticHTML(videos, rules), 'text/html;charset=utf-8');
});
$('#btnOptions').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
});

// —— 静态 HTML 导出（按分类分组的可分享页面）——
function buildStaticHTML(videos, rules) {
  const groups = groupVideos(videos, rules);
  const names = rules.map((r) => r.name).filter((n) => groups[n]);
  if (groups[UNCLASSIFIED]) names.push(UNCLASSIFIED);
  const colorOf = (n) => { const r = rules.find((r) => r.name === n); return r ? r.color : '#adb5bd'; };
  let body = '';
  for (const n of names) {
    const items = groups[n];
    body += `<h2><i style="background:${colorOf(n)}"></i>${n}<small>（${items.length}）</small></h2><div class="g">`;
    for (const v of items) {
      const cover = v.cover ? `<img src="${v.cover.replace(/"/g, '&quot;')}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : '';
      const badges = (v.sources || []).map((s) => `<span class="${s}">${s === 'like' ? '❤' : '★'}</span>`).join('');
      body += `<a class="c" href="${v.url}" target="_blank" rel="noopener">${cover}${badges}<p>${(v.title || '(无标题)').replace(/</g, '&lt;')}</p><em>${v.author ? '@' + v.author : ''}</em></a>`;
    }
    body += '</div>';
  }
  const total = Object.keys(videos).length;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>抖音收藏分类 · ${total} 条</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#f5f6f8}
h1{font-size:20px}h2{display:flex;align-items:center;gap:8px;font-size:16px;margin:26px 0 12px}
h2 i{width:11px;height:11px;border-radius:50%}h2 small{color:#999;font-weight:400}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.c{position:relative;display:block;background:#fff;border:1px solid #e8e8ec;border-radius:12px;overflow:hidden;text-decoration:none;color:#222}
.c img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.c p{font-size:12.5px;line-height:1.45;margin:8px 10px;max-height:3.6em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.c em{display:block;font-size:11px;color:#999;font-style:normal;margin:0 10px 10px}
.c span{position:absolute;top:8px;left:8px;padding:1px 6px;border-radius:6px;font-size:11px;color:#fff}
.c span.like{background:rgba(254,44,85,.85)}.c span.collect{background:rgba(255,180,0,.9)}
</style></head><body><h1>抖音收藏分类 · 共 ${total} 条</h1>${body}</body></html>`;
}

// —— 数据加载（含演示模式兜底）——
const DEMO = {
  rules: DEFAULT_RULES,
  videos: Object.fromEntries([
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
  ].map(([id, title, author, src, cat]) => [id, {
    id, title, author,
    url: 'https://www.douyin.com/video/' + id,
    cover: '', postDate: '2025-0' + (1 + (id % 9)) + '-1' + (id % 9),
    sources: [src], firstSeen: Date.now() - id * 100000,
    category: cat, categoryBy: cat ? 'rule' : null,
  }])),
};

async function load() {
  if (HAS_CHROME) {
    const { videos = {}, rules = null } = await DB.get(['videos', 'rules']);
    state.videos = videos;
    state.rules = rules || DEFAULT_RULES;
  } else {
    document.getElementById('demoBanner').style.display = '';
    state.videos = DEMO.videos;
    state.rules = DEMO.rules;
  }
  render();
}

load();
