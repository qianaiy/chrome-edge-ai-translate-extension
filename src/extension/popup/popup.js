'use strict';

const $ = id => document.getElementById(id);

let activeTabId = null;
let currentSettings = null;
let resolvedBase = '';
let pageStatus = null;

async function getSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'mxt:getSettings' });
  return res && res.ok ? res.settings : null;
}

/* ------------------------- 速度显示 ------------------------- */

function fmtSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function ago(at) {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.round(hour / 24)} 天前`;
}

function speedLine(s, at) {
  if (!s) return '还没测过速度，点下面「测速」。';
  if (s.busy) return '测试中…';
  if (!s.ok) return '不可用：' + (s.error || '请求失败');
  return (
    `首字 ${fmtSec(s.ttftMs)} · 总 ${fmtSec(s.totalMs)} · 约 ${s.charsPerSec} 字/秒` +
    (s.protocolLabel ? ` · ${s.protocolLabel}` : '') +
    (at ? ` · ${ago(at)}` : '')
  );
}

function showSpeed(entry, at) {
  const el = $('speed');
  el.textContent = speedLine(entry, at);
  el.style.color = entry && entry.ok === false ? '#b91c1c' : '';
}

async function loadSpeed(base) {
  const { modelSpeed } = await chrome.storage.local.get('modelSpeed');
  if (!modelSpeed || modelSpeed.baseURL !== base || !currentSettings) {
    showSpeed(null, 0);
    return;
  }
  showSpeed(modelSpeed.map[currentSettings.model], modelSpeed.at);
}

async function saveSpeedEntry(base, model, entry) {
  const { modelSpeed } = await chrome.storage.local.get('modelSpeed');
  const box =
    modelSpeed && modelSpeed.baseURL === base
      ? modelSpeed
      : { baseURL: base, at: 0, map: {} };
  box.at = Date.now();
  box.map = { ...(box.map || {}), [model]: entry };
  await chrome.storage.local.set({ modelSpeed: box });
}

async function init() {
  const settings = await getSettings();
  const status = $('status');

  if (!settings) {
    status.textContent = '读不到配置，重启一下扩展';
    return;
  }

  currentSettings = settings;
  $('model').textContent = settings.model;
  $('lang').value = settings.targetLang;
  $('autoTranslate').checked = settings.autoTranslate === true;

  /* 配置体检交给后台，弹窗和后台共用同一套规则 */
  const cfg = await chrome.runtime.sendMessage({ type: 'mxt:configStatus' }).catch(() => null);
  const det = await chrome.runtime
    .sendMessage({ type: 'mxt:detect', baseURL: settings.baseURL })
    .catch(() => null);
  resolvedBase = det?.baseURL || settings.baseURL;

  if (cfg && cfg.configured) {
    const where = det?.providerName || '自定义接口';
    status.textContent = `${where} · ${settings.model || '未选模型'}`;
    await loadSpeed(resolvedBase);
  } else {
    const msg =
      (cfg && cfg.problem) || '还没配好接口。点下面的「设置」填 Base URL 和 API Key。';
    status.innerHTML = `<span style="color:#b45309">${msg}</span>`;
    $('speed').textContent = '配好接口后可以测速。';
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  const usable = /^https?:/i.test(tab?.url || '');
  if (!usable) {
    $('translatePage').disabled = true;
    status.textContent = '当前页面不支持（只能是普通网页）';
    $('translatePage').textContent = '翻译正文';
    $('translateAll').disabled = true;
    $('toggleDisplay').disabled = true;
    return;
  }

  // 看看这一页是不是已经翻译过（顺带确认内容脚本在岗，不在就注入）
  const st = await chrome.runtime
    .sendMessage({ type: 'mxt:tabStatus', tabId: activeTabId })
    .catch(() => null);

  pageStatus = st?.status || null;
  const status2 = pageStatus;
  if (status2) {
    const modeNote = status2.mode === 'full' ? '整页' : '正文';
    $('translatePage').textContent = status2.translated ? '还原原文' : '翻译正文';
    $('translateAll').textContent =
      status2.translated && status2.mode === 'smart' ? '换成整页' : '翻整页（含侧栏）';
    $('toggleDisplay').textContent = status2.displayMode === 'translation' ? '切回双语' : '仅译文';
    $('shortcut').textContent = status2.translated
      ? `已译 ${status2.translated} 段（${modeNote}）${status2.observing ? ' · 新内容会自动接着翻' : ''}`
      : '快捷键：Alt+T 正文 · Alt+W 整页 · Alt+Y 仅译文';
  } else {
    $('translatePage').disabled = true;
    $('translateAll').disabled = true;
    $('toggleDisplay').disabled = true;
    $('translatePage').textContent = '翻译正文';
    status.textContent = st?.reason || '这个页面不允许扩展运行';
  }
}

$('lang').addEventListener('change', async () => {
  const settings = (await getSettings()) || {};
  await chrome.storage.local.set({ settings: { ...settings, targetLang: $('lang').value } });
});

/* 「自动翻译外文网页」开关：勾上就存，不用再点保存 */
$('autoTranslate').addEventListener('change', async () => {
  const on = $('autoTranslate').checked;
  const settings = (await getSettings()) || {};
  await chrome.storage.local.set({ settings: { ...settings, autoTranslate: on } });
  const status = $('status');
  status.textContent = on ? '已开启：以后打开外文网页会自动翻译' : '已关闭：外文网页不会自动翻译';
  status.style.color = on ? '#15803d' : '#6b7280';
});

/* ------------------------- 页面操作 ------------------------- */

async function sendTab(type, extra) {
  if (activeTabId == null) return;
  const status = $('status');
  const res = await chrome.runtime
    .sendMessage({ type, tabId: activeTabId, ...(extra || {}) })
    .catch(e => ({ ok: false, error: e?.message || String(e) }));

  if (res && res.ok) {
    window.close();
    return;
  }
  status.style.color = '#b91c1c';
  status.textContent = res?.error || '没发出去，刷新页面再试';
}

async function togglePage(mode) {
  const btn = mode === 'full' ? $('translateAll') : $('translatePage');
  btn.disabled = true;
  await sendTab('mxt:tabToggle', { mode });
  btn.disabled = false;
}

$('translatePage').addEventListener('click', () => togglePage('smart'));

$('translateAll').addEventListener('click', () => togglePage('full'));

$('toggleDisplay').addEventListener('click', async () => {
  const btn = $('toggleDisplay');
  btn.disabled = true;
  await sendTab('mxt:tabDisplay');
  btn.disabled = false;
});

$('translateSubtitle').addEventListener('click', async () => {
  const btn = $('translateSubtitle');
  btn.disabled = true;
  btn.textContent = '字幕处理中…';
  await sendTab('mxt:tabSubtitle');
  btn.disabled = false;
  btn.textContent = '翻译视频字幕';
});

$('translateComic').addEventListener('click', async () => {
  const btn = $('translateComic');
  btn.disabled = true;
  btn.textContent = '识别中…';
  await sendTab('mxt:tabComic');
  btn.disabled = false;
  btn.textContent = '翻漫画';
});

$('probe').addEventListener('click', async () => {
  if (!currentSettings) return;

  const btn = $('probe');
  const el = $('speed');

  btn.disabled = true;
  btn.textContent = '测速中…';
  el.style.color = '';
  el.textContent = `正在请求 ${currentSettings.model}…（最长 15 秒）`;

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'mxt:probe',
      settings: currentSettings,
      model: currentSettings.model,
      timeoutMs: 15000
    });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }

  const entry = res && res.ok
    ? {
        ok: true,
        ttftMs: res.ttftMs,
        totalMs: res.totalMs,
        chars: res.chars,
        charsPerSec: res.charsPerSec,
        protocol: res.protocol,
        protocolLabel: res.protocolLabel
      }
    : { ok: false, error: res?.error || '请求失败', timeout: /超时/.test(res?.error || '') };

  await saveSpeedEntry(resolvedBase || currentSettings.baseURL, currentSettings.model, entry);
  showSpeed(entry, Date.now());

  btn.disabled = false;
  btn.textContent = '测速';
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'mxt:clearCache' });
  const status = $('status');
  const old = status.textContent;
  status.textContent = '翻译缓存已清空';
  setTimeout(() => (status.textContent = old), 1500);
});

init();
