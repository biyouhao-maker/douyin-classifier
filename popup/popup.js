// popup/popup.js
const $ = (s) => document.querySelector(s);

function dashUrl() { return chrome.runtime.getURL('dashboard/dashboard.html'); }
function optionsUrl() { return chrome.runtime.getURL('options/options.html'); }

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDouyin = !!(tab && tab.url && /douyin\.com/.test(tab.url));
  if (isDouyin) {
    $('#pageStatus').textContent = '当前在抖音网页版 ✓';
    $('#btnPanel').style.display = '';
    $('#btnPanel').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'show-panel' });
        window.close();
      } catch (e) {
        // content script 未注入（扩展刚加载页面未刷新），提示刷新
        $('#pageStatus').textContent = '请刷新抖音页面后重试';
      }
    });
  } else {
    $('#pageStatus').textContent = '请先打开 www.douyin.com';
  }

  const { videos = {}, rules = [] } = await DB.get(['videos', 'rules']);
  const list = Object.values(videos);
  $('#statTotal').textContent = list.length;
  $('#statCats').textContent = new Set(list.map((v) => v.category).filter(Boolean)).size;
  $('#statUncat').textContent = list.filter((v) => !v.category).length;
  if (!list.length) $('#statCats').textContent = rules.length || 0;

  $('#btnDash').addEventListener('click', () => { chrome.tabs.create({ url: dashUrl() }); });
  $('#btnOptions').addEventListener('click', () => { chrome.tabs.create({ url: optionsUrl() }); });
}

init();
