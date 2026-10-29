// lib/common.js —— 数据层与分类逻辑（content script 与扩展页面共用）

const HAS_CHROME = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
const memStore = {}; // 非扩展环境（如直接用浏览器打开看板页预览）的兜底存储

const DB = {
  async get(keys) {
    if (HAS_CHROME) return chrome.storage.local.get(keys);
    if (keys === null || keys === undefined) return { ...memStore };
    if (typeof keys === 'string') return keys in memStore ? { [keys]: memStore[keys] } : {};
    if (Array.isArray(keys)) {
      const o = {};
      keys.forEach((k) => { if (k in memStore) o[k] = memStore[k]; });
      return o;
    }
    return Object.assign({}, keys, memStore);
  },
  async set(obj) {
    if (HAS_CHROME) return chrome.storage.local.set(obj);
    Object.assign(memStore, obj);
  },
  async remove(key) {
    if (HAS_CHROME) return chrome.storage.local.remove(key);
    delete memStore[key];
  },
};

// —— 默认分类规则（可在设置页增删改）——
const DEFAULT_RULES = [
  { name: '美食', color: '#fe2c55', keywords: ['美食', '做菜', '菜谱', '食谱', '烘焙', '探店', '吃播', '火锅', '烧烤', '甜品', '蛋糕', '面食', '早餐', '晚餐', '午餐', '小吃', '厨房', '做饭', '奶茶', '咖啡', '菜', '吃'] },
  { name: '旅行', color: '#4dabf7', keywords: ['旅行', '旅游', '攻略', '景点', '自驾', '徒步', '露营', '海边', '雪山', '古镇', '民宿', '签证', '机票', '出行', '景区', '出国', '环游'] },
  { name: '知识/学习', color: '#51cf66', keywords: ['知识', '科普', '学习', '教程', '课程', '干货', '历史', '物理', '化学', '数学', '英语', '考研', '考证', '心理学', '经济学', '法律', '编程', '考试', '冷知识', '涨知识'] },
  { name: '音乐', color: '#cc5de8', keywords: ['音乐', '歌曲', '翻唱', '演唱会', '吉他', '钢琴', '编曲', 'MV', '唱歌', '歌声', '调音', '乐评'] },
  { name: '影视/综艺', color: '#fab005', keywords: ['电影', '电视剧', '影视', '剪辑', '解说', '综艺', '追剧', '片段', '预告', '番剧', '动漫', '动画', '片单', '导演', '票房'] },
  { name: '搞笑/娱乐', color: '#ff922b', keywords: ['搞笑', '沙雕', '段子', '整活', '恶搞', '爆笑', '迷惑行为', '哈哈哈', '喜剧', '小品', '相声'] },
  { name: '生活/日常', color: '#20c997', keywords: ['生活', '日常', 'vlog', '记录', '家居', '装修', '收纳', '好物', '开箱', '测评', '种草', '省钱', '购物', '妙招', '整理'] },
  { name: '科技/数码', color: '#228be6', keywords: ['科技', '数码', '手机', '电脑', 'AI', '人工智能', '软件', 'APP', '互联网', '程序员', '芯片', '无人机', '耳机', '显卡', '机器人', '大模型'] },
  { name: '健身/运动', color: '#e64980', keywords: ['健身', '运动', '跑步', '瑜伽', '减脂', '增肌', '塑形', '篮球', '足球', '羽毛球', '游泳', '跳绳', '撸铁', '身材管理'] },
  { name: '宠物/动物', color: '#845ef7', keywords: ['宠物', '猫咪', '狗狗', '猫', '狗', '萌宠', '仓鼠', '兔子', '鹦鹉', '动物', '遛狗', '铲屎'] },
  { name: '穿搭/美妆', color: '#f783ac', keywords: ['穿搭', '美妆', '化妆', '护肤', '口红', '发型', '变美', '气质', '时尚', '配色', '博主同款', '显瘦'] },
  { name: '三农/田园', color: '#94d82d', keywords: ['农村', '田园', '种植', '养殖', '农民', '乡村', '菜园', '果园', '庄稼', '赶集'] },
  { name: '情感/语录', color: '#748ffc', keywords: ['情感', '语录', '文案', '治愈', '共鸣', '人生', '道理', '恋爱', '婚姻', '成长'] },
];

const UNCLASSIFIED = '未分类';

// 单条视频按规则分类（标题 + 作者名参与匹配），返回命中的规则或 null
function classifyVideo(video, rules) {
  const text = ((video.title || '') + ' ' + (video.author || '')).toLowerCase();
  if (!text.trim()) return null;
  for (const rule of rules) {
    for (const kw of rule.keywords || []) {
      const k = String(kw).trim().toLowerCase();
      if (k && text.includes(k)) return rule;
    }
  }
  return null;
}

// 批量写入/更新视频，返回 {added, updated}；重复视频会合并来源（点赞+收藏）
async function upsertVideos(list) {
  const { videos = {} } = await DB.get('videos');
  let added = 0, updated = 0;
  const now = Date.now();
  for (const v of list) {
    if (!v || !v.id) continue;
    const old = videos[v.id];
    if (old) {
      old.sources = Array.from(new Set([...(old.sources || []), ...(v.sources || [])]));
      if (!old.cover && v.cover) old.cover = v.cover;
      if (v.title && (!old.title || v.title.length > old.title.length)) old.title = v.title;
      if (v.author && !old.author) old.author = v.author;
      if (v.postDate && !old.postDate) old.postDate = v.postDate;
      updated++;
    } else {
      videos[v.id] = {
        id: v.id,
        title: v.title || '',
        author: v.author || '',
        url: v.url || ('https://www.douyin.com/video/' + v.id),
        cover: v.cover || '',
        postDate: v.postDate || '',
        sources: v.sources || [],
        firstSeen: now,
        category: null,
        categoryBy: null, // rule | ai | manual
      };
      added++;
    }
  }
  await DB.set({ videos });
  return { added, updated };
}

// 按规则重新分类（默认保留手动指定的分类）
async function classifyAll(keepManual = true) {
  const { videos = {}, rules = DEFAULT_RULES } = await DB.get(['videos', 'rules']);
  for (const v of Object.values(videos)) {
    if (keepManual && v.categoryBy === 'manual') continue;
    const hit = classifyVideo(v, rules);
    v.category = hit ? hit.name : null;
    v.categoryBy = hit ? 'rule' : null;
  }
  await DB.set({ videos });
}

// —— AI 智能分类（OpenAI 兼容接口，需在设置页开启并授权网络访问）——
async function aiClassify(videos, cfg, onProgress) {
  const names = (cfg.categories || []).filter(Boolean);
  if (!names.length) throw new Error('没有可用分类，请先配置分类规则');
  const result = {}; // id -> category
  const batchSize = 15;
  for (let i = 0; i < videos.length; i += batchSize) {
    const chunk = videos.slice(i, i + batchSize);
    const prompt = [
      '你是视频分类助手。给定抖音视频列表（JSON 数组，每项含 id、title、author），请为每条视频从以下分类中选出唯一最合适的一个分类：',
      names.join('、'),
      '要求：只能从上述分类中选择；如确实都不合适，选"未分类"。只输出 JSON，格式 {"items":[{"id":"视频id","category":"分类名"}]}，不要输出任何其他文字。',
      '视频列表：' + JSON.stringify(chunk.map((v) => ({ id: v.id, title: v.title || '', author: v.author || '' }))),
    ].join('\n');
    const text = await chatOnce(cfg, prompt);
    const parsed = parseAIJson(text);
    for (const it of parsed) {
      if (it && it.id && it.category && names.includes(it.category)) result[it.id] = it.category;
    }
    if (onProgress) onProgress(Math.min(i + batchSize, videos.length), videos.length);
  }
  return result;
}

async function chatOnce(cfg, prompt) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.apiKey || '') },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('API 返回 ' + res.status + '：' + t.slice(0, 200));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function parseAIJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 未返回 JSON：' + text.slice(0, 120));
  const obj = JSON.parse(m[0]);
  return obj.items || [];
}

// —— 导出辅助 ——
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function sourceText(v) {
  const map = { like: '点赞', collect: '收藏' };
  return (v.sources || []).map((s) => map[s] || s).join('+') || '-';
}

function csvEscape(s) {
  s = String(s ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCSV(videos) {
  const head = ['分类', '来源', '标题', '作者', '发布时间', '链接', '封面', '采集时间'];
  const lines = [head.join(',')];
  for (const v of Object.values(videos)) {
    lines.push([
      v.category || UNCLASSIFIED,
      sourceText(v),
      v.title || '',
      v.author || '',
      v.postDate || '',
      v.url || '',
      v.cover || '',
      fmtTime(v.firstSeen),
    ].map(csvEscape).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function groupVideos(videos, rules) {
  const groups = {};
  const names = rules.map((r) => r.name);
  for (const v of Object.values(videos)) {
    const key = v.category && names.includes(v.category) ? v.category : UNCLASSIFIED;
    (groups[key] = groups[key] || []).push(v);
  }
  return groups;
}
