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

  const counts = await VideoDB.counts();
  const { rules = [] } = await DB.get('rules');
  $('#statTotal').textContent = counts.total;
  $('#statUncat').textContent = counts.unclassified;
  if (counts.total) {
    const byCat = await VideoDB.countByCategory();
    $('#statCats').textContent = Object.keys(byCat).filter((k) => k !== UNCLASSIFIED_KEY).length;
  } else {
    $('#statCats').textContent = rules.length || 0;
  }

  $('#btnDash').addEventListener('click', () => { chrome.tabs.create({ url: dashUrl() }); });
  $('#btnOptions').addEventListener('click', () => { chrome.tabs.create({ url: optionsUrl() }); });
}

init();
