'use strict';

const DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  temperature: 0.2,
  extraPrompt: '',
  protocol: 'auto',
  autoDynamic: true,
  displayMode: 'bilingual',
  showFab: true,
  autoTranslate: false,
  autoTranslateMinChars: 200
};

const PRESETS = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'auto' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai' },
  siliconflow: { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', protocol: 'openai' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', protocol: 'openai' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', protocol: 'openai' },
  claude: { baseURL: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest', protocol: 'anthropic' },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash',
    protocol: 'gemini'
  },
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', protocol: 'auto' }
};

const $ = id => document.getElementById(id);
const FIELDS = ['baseURL', 'apiKey', 'model', 'visionModel', 'asrModel', 'targetLang', 'temperature', 'extraPrompt', 'protocol', 'displayMode', 'autoTranslateMinChars'];
const BOOLS = ['autoDynamic', 'showFab', 'autoTranslate'];

/* 改完立刻生效的字段：勾一下 / 改一下就存，不用再点「保存」。
   「保存」按钮仍然保留 —— 它现在只是把整个表单写一遍（比如批量改完多个字段）。 */
const INSTANT = [...BOOLS, 'targetLang', 'displayMode', 'autoTranslateMinChars'];

/** 把当前表单写进 storage（只改传进来的字段，不动别的） */
async function patchSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...(settings || {}), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** 输入类字段防抖：打字过程中不反复写 */
function debounce(fn, ms = 400) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    out[f] = el.value.trim();
  }
  for (const b of BOOLS) {
    const el = $(b);
    if (el) out[b] = !!el.checked;
  }
  out.temperature = Math.min(2, Math.max(0, Number(out.temperature) || 0));
  out.autoTranslateMinChars = Math.max(0, Math.min(100000, Number(out.autoTranslateMinChars) || 0));
  return out;
}

function writeForm(settings) {
  for (const f of FIELDS) {
    const el = $(f);
    el.value = settings[f] ?? DEFAULTS[f] ?? '';
  }
  for (const b of BOOLS) {
    const el = $(b);
    if (el) el.checked = (settings[b] ?? DEFAULTS[b]) !== false;
  }
}

function setResult(text, kind) {
  const el = $('testResult');
  el.textContent = text;
  el.className = kind || '';
}

async function load() {
  const store = await chrome.storage.local.get(['settings', 'modelCache', 'modelSpeed', 'sortBySpeed']);
  writeForm({ ...DEFAULTS, ...(store.settings || {}) });
  checkBackgroundVersion();
  resolvedBase = await refreshDetection();

  const modelCache = store.modelCache;
  if (
    modelCache &&
    modelCache.baseURL &&
    modelCache.baseURL === resolvedBase &&
    Array.isArray(modelCache.models) &&
    modelCache.models.length
  ) {
    allModels = modelCache.models;
    const when = modelCache.fetchedAt ? new Date(modelCache.fetchedAt).toLocaleString() : '';
    const chatCount = allModels.filter(m => m.chat).length;
    $('modelHint').textContent =
      `已缓存 ${allModels.length} 个模型（对话 ${chatCount}）` +
      (when ? `，${when} 读取` : '') +
      '。点 ▾ 打开列表，Esc 关闭后可直接手打模型名。';
  }

  $('sortBySpeed').checked = !!store.sortBySpeed;

  const modelSpeed = store.modelSpeed;
  if (modelSpeed && modelSpeed.baseURL === resolvedBase && modelSpeed.map) {
    speedMap = modelSpeed.map;
    const at = modelSpeed.at ? new Date(modelSpeed.at).toLocaleString() : '';
    const cur = speedMap[$('model').value.trim()];
    $('speedHint').className = 'hint';
    $('speedHint').textContent = cur
      ? `${$('model').value.trim()}：${speedSummary(cur)}` + (at ? `（${at} 测）` : '')
      : `已缓存 ${Object.keys(speedMap).length} 个模型的测速结果` + (at ? `（${at} 测）` : '') + '。点模型列表即可看速度。';
  }
}

/* ------------------------- 后台版本检查 ------------------------- */

/* 设置页每次打开都从磁盘重新读，后台 Service Worker 却要重载扩展才会更新。
   两边版本不一致时，新功能会报「未知消息类型」，这里直接点破。 */
async function checkBackgroundVersion() {
  const pageVersion = chrome.runtime.getManifest().version;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'mxt:version' });
  } catch (_) {
    res = null;
  }

  const swVersion = res && res.ok ? res.version : '未知';
  if (!res || !res.ok || swVersion !== pageVersion) {
    $('pageVersion').textContent = pageVersion;
    $('swVersion').textContent = swVersion;
    $('stale').hidden = false;
  }
}

/* ------------------------- 服务商识别 ------------------------- */

let detectTimer = null;
let resolvedBase = '';

async function refreshDetection() {
  const el = $('detected');
  const base = $('baseURL').value.trim();

  if (!base) {
    el.className = 'hint';
    el.textContent = '只填域名也能用（比如 https://api.deepseek.com），路径会自动补全。';
    return '';
  }

  const res = await chrome.runtime
    .sendMessage({ type: 'mxt:detect', baseURL: base })
    .catch(() => null);

  if (!res || !res.ok) return '';

  el.className = 'hint good';
  if (res.known) {
    el.textContent = `识别为 ${res.providerName} · ${res.protocolLabel} · 实际请求 ${res.baseURL}`;
  } else {
    el.textContent = `没认出来是哪家，按 ${res.protocolLabel} 协议请求 ${res.baseURL}`;
  }
  return res.baseURL;
}

$('baseURL').addEventListener('input', () => {
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(async () => {
    const next = await refreshDetection();
    if (next && resolvedBase && next !== resolvedBase) {
      resolvedBase = next;
      allModels = [];
      speedMap = {};
      closePanel();
      $('modelHint').className = 'hint';
      $('modelHint').textContent = '接口地址变了，重新点「拉取模型」获取模型列表。';
      $('speedHint').className = 'hint';
      $('speedHint').textContent = '接口地址变了，之前的测速结果作废。';
    } else if (next) {
      resolvedBase = next;
    }
  }, 250);
});

/* ------------------------- 模型下拉面板 ------------------------- */

let allModels = [];
let speedMap = {};
let panelIndex = -1;
let lastQuery = '';
let itemEls = new Map();
let badgeEls = new Map();

/* 纯函数：按 id / 展示名做子串匹配 */
function filterModels(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    m => m.id.toLowerCase().includes(q) || String(m.label || '').toLowerCase().includes(q)
  );
}

function isPanelOpen() {
  return !$('modelPanel').hidden;
}

function openPanel() {
  if (!allModels.length) return;
  $('modelPanel').hidden = false;
  $('modelSearch').value = '';
  panelIndex = -1;
  renderPanel('');
  $('modelSearch').focus();
}

function closePanel() {
  $('modelPanel').hidden = true;
  panelIndex = -1;
}

function selectModel(m) {
  $('model').value = m.id;
  closePanel();
  const hint = $('modelHint');
  hint.className = m.chat ? 'hint good' : 'hint bad';
  hint.textContent = m.chat
    ? `已选 ${m.id}`
    : `已选 ${m.id}（非对话模型，翻译大概率用不了）`;
}

function renderPanel(query) {
  const list = $('modelList');
  const current = $('model').value.trim();
  const filtered = filterModels(visibleModels(), query);
  const shown = filtered.slice(0, 300);

  lastQuery = query || '';
  itemEls = new Map();
  badgeEls = new Map();

  list.replaceChildren();

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = allModels.length ? '没有匹配的模型' : '还没有列表，先点「拉取模型」';
    list.appendChild(empty);
  }

  shown.forEach((m, i) => {
    const item = document.createElement('div');
    item.className =
      'combo-item' + (i === panelIndex ? ' active' : '') + (m.id === current ? ' is-current' : '');
    item.title = m.label && m.label !== m.id ? `${m.id}\n${m.label}` : m.id;

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = m.id;
    item.appendChild(id);

    const tagText = m.chat ? (m.label && m.label !== m.id ? m.label : '') : '非对话';
    if (tagText) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tagText;
      item.appendChild(tag);
    }

    const speed = speedMap[m.id];
    const badgeText = speedText(speed);
    if (badgeText) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + speedClass(speed);
      badge.textContent = badgeText;
      badge.title = speedDetail(speed, m.id);
      item.appendChild(badge);
      badgeEls.set(m.id, badge);
    }

    /* 用 mousedown 阻止默认，避免输入框先 blur 把面板关掉 */
    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', () => selectModel(m));
    list.appendChild(item);
    itemEls.set(m.id, item);
  });

  updateFoot();
  return shown;
}

/* 底部统计：不重建列表，测速时每出一条结果只改这一行 */
function updateFoot() {
  const chatCount = allModels.filter(m => m.chat).length;
  $('modelFoot').textContent = allModels.length
    ? `共 ${allModels.length} 个 · 对话 ${chatCount} · 非对话 ${allModels.length - chatCount}` +
      (lastQuery ? ` · 匹配 ${filterModels(allModels, lastQuery).length}` : '') +
      (speedCount() ? ` · 已测速 ${speedCount()}` : '')
    : '还没有模型列表';
}

/* 测速结果回来时只改那一个徽标，避免 66 次全量重绘 */
function refreshBadge(id) {
  if (!itemEls.has(id)) return;
  const item = itemEls.get(id);
  const speed = speedMap[id];
  const text = speedText(speed);
  let badge = badgeEls.get(id);

  if (!badge) {
    if (!text) return;
    badge = document.createElement('span');
    item.appendChild(badge);
    badgeEls.set(id, badge);
  }

  badge.className = 'badge ' + speedClass(speed);
  badge.textContent = text;
  badge.title = speedDetail(speed, id);
  updateFoot();
}

function movePanelIndex(step) {
  const shown = filterModels(visibleModels(), $('modelSearch').value);
  if (!shown.length) return;
  const next = panelIndex + step;
  panelIndex = next < 0 ? shown.length - 1 : next >= shown.length ? 0 : next;
  renderPanel($('modelSearch').value);

  const active = $('modelList').querySelector('.combo-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

$('model').addEventListener('click', () => {
  if (!isPanelOpen()) openPanel();
});

$('model').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isPanelOpen()) openPanel();
    else movePanelIndex(e.key === 'ArrowDown' ? 1 : -1);
  }
});

$('modelToggle').addEventListener('click', () => {
  if (isPanelOpen()) {
    closePanel();
    return;
  }
  if (allModels.length) openPanel();
  else $('loadModels').click();
});

$('modelSearch').addEventListener('input', () => {
  panelIndex = -1;
  renderPanel($('modelSearch').value);
});

$('modelSearch').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    movePanelIndex(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const shown = filterModels(visibleModels(), $('modelSearch').value);
    const pick = shown[panelIndex] || shown[0];
    if (pick) selectModel(pick);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closePanel();
    $('model').focus();
  }
});

document.addEventListener('mousedown', e => {
  if (!isPanelOpen()) return;
  const t = e.target;
  if (!t || typeof t.closest !== 'function' || !t.closest('.combo-wrap')) closePanel();
});

/* ------------------------- 拉取模型列表 ------------------------- */

$('loadModels').addEventListener('click', async () => {
  const btn = $('loadModels');
  const hint = $('modelHint');

  btn.disabled = true;
  btn.textContent = '拉取中…';
  hint.className = 'hint';
  hint.textContent = '正在读取模型列表…';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'mxt:models', settings: readForm() });

    if (!res || !res.ok) {
      hint.className = 'hint bad';
      hint.textContent = '拉取失败：' + (res?.error || '未知错误');
      return;
    }

    allModels = res.models;
    resolvedBase = res.baseURL || resolvedBase;

    const chat = allModels.filter(m => m.chat);

    hint.className = 'hint good';
    hint.textContent =
      `读到 ${allModels.length} 个模型（对话 ${chat.length}）` +
      ` · ${res.protocolLabel}` +
      (res.provider ? ` · ${res.provider}` : '') +
      ' · 点 ▾ 或输入框右侧搜索';

    if (!$('model').value.trim() && chat.length) {
      $('model').value = chat[0].id;
    }

    panelIndex = -1;
    if (isPanelOpen()) renderPanel($('modelSearch').value);

    await chrome.storage.local.set({
      modelCache: { baseURL: res.baseURL || resolvedBase, fetchedAt: Date.now(), models: allModels }
    });
  } catch (e) {
    hint.className = 'hint bad';
    hint.textContent = '拉取失败：' + (e?.message || e);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型';
  }
});

/* ------------------------- 测速 ------------------------- */

const PROBE_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 3;

let probeRunning = false;
let probeStop = false;

function fmtSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function speedClass(s) {
  if (!s) return '';
  if (s.busy) return 'busy';
  if (!s.ok) return 'fail';
  if (s.ttftMs < 1500) return 'fast';
  if (s.ttftMs < 5000) return 'mid';
  return 'slow';
}

function speedText(s) {
  if (!s) return '';
  if (s.busy) return '测试中';
  if (!s.ok) return s.timeout ? '超时' : '失败';
  return fmtSec(s.ttftMs);
}

function speedSummary(s) {
  if (!s) return '还没测过';
  if (s.busy) return '测试中…';
  if (!s.ok) return s.error || '失败';
  return `首字 ${fmtSec(s.ttftMs)} · 总 ${fmtSec(s.totalMs)} · ${s.chars} 字 · 约 ${s.charsPerSec} 字/秒 · ${s.protocolLabel} · 可用`;
}

function speedDetail(s, id) {
  if (!s) return `${id}\n还没测过速度`;
  return `${id}\n${speedSummary(s)}`;
}

function speedCount() {
  return Object.keys(speedMap).filter(k => speedMap[k] && speedMap[k].ok).length;
}

/* 开了「按速度排序」就按首字延迟排；没测过的排到最后 */
function visibleModels() {
  if (!$('sortBySpeed').checked) return allModels;
  const rank = m => {
    const s = speedMap[m.id];
    if (s && s.ok) return s.ttftMs;
    return m.chat ? 1e9 : 1e9 + 1;
  };
  return [...allModels].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

async function saveSpeed() {
  await chrome.storage.local.set({
    modelSpeed: { baseURL: resolvedBase, at: Date.now(), map: speedMap }
  });
}

async function probeOne(modelId) {
  speedMap[modelId] = { busy: true };
  refreshBadge(modelId);

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'mxt:probe',
      settings: readForm(),
      model: modelId,
      timeoutMs: PROBE_TIMEOUT_MS
    });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }

  if (res && res.ok) {
    speedMap[modelId] = {
      ok: true,
      ttftMs: res.ttftMs,
      totalMs: res.totalMs,
      chars: res.chars,
      charsPerSec: res.charsPerSec,
      protocol: res.protocol,
      protocolLabel: res.protocolLabel
    };
  } else {
    const error = res?.error || '请求失败';
    speedMap[modelId] = { ok: false, error, timeout: /超时/.test(error) };
  }

  refreshBadge(modelId);
  return speedMap[modelId];
}

/* 固定并发跑一批，别把本地网关打爆 */
async function runPool(items, worker, concurrency) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (probeStop) return;
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

$('probeModel').addEventListener('click', async () => {
  const model = $('model').value.trim();
  const hint = $('speedHint');
  const btn = $('probeModel');

  if (!model) {
    hint.className = 'hint bad';
    hint.textContent = '先在模型框里选一个模型，再点测速。';
    return;
  }

  btn.disabled = true;
  btn.textContent = '测速中…';
  hint.className = 'hint';
  hint.textContent = `正在测 ${model}…（最长 ${PROBE_TIMEOUT_MS / 1000} 秒）`;

  const s = await probeOne(model);

  btn.disabled = false;
  btn.textContent = '测速';
  hint.className = s.ok ? 'hint good' : 'hint bad';
  hint.textContent = `${model}：${speedSummary(s)}`;
  await saveSpeed();
});

$('probeAll').addEventListener('click', async () => {
  const btn = $('probeAll');
  const hint = $('speedHint');

  if (probeRunning) {
    probeStop = true;
    btn.textContent = '停止中…';
    hint.textContent = '正在停下，等已经在跑的请求结束…';
    return;
  }

  const targets = visibleModels()
    .filter(m => m.chat)
    .map(m => m.id);
  if (!targets.length) {
    hint.className = 'hint bad';
    hint.textContent = '还没有模型列表，先点「拉取模型」。';
    return;
  }

  probeRunning = true;
  probeStop = false;
  btn.textContent = '停止';

  let done = 0;
  let okCount = 0;

  const refresh = () => {
    hint.className = 'hint';
    hint.textContent = `测速中 ${done}/${targets.length} · 可用 ${okCount} · 失败 ${done - okCount}（可点「停止」中断）`;
  };
  refresh();

  await runPool(
    targets,
    async id => {
      const s = await probeOne(id);
      done++;
      if (s.ok) okCount++;
      refresh();
    },
    PROBE_CONCURRENCY
  );

  const stopped = probeStop;
  probeRunning = false;
  probeStop = false;
  btn.textContent = '测全部';
  await saveSpeed();

  const doneIds = targets.slice(0, done);
  const okIds = doneIds.filter(id => speedMap[id] && speedMap[id].ok);
  const speeds = okIds.map(id => speedMap[id].ttftMs).sort((a, b) => a - b);

  hint.className = okIds.length ? 'hint good' : 'hint bad';
  hint.textContent =
    `${stopped ? '已中断：' : '测完 '}${done} 个模型，可用 ${okIds.length}，失败 ${done - okIds.length}` +
    (speeds.length ? ` · 最快 ${fmtSec(speeds[0])}，最慢可用 ${fmtSec(speeds[speeds.length - 1])}` : '') +
    '（打开模型列表看逐个结果）';
});

$('clearSpeed').addEventListener('click', async () => {
  speedMap = {};
  await chrome.storage.local.remove('modelSpeed');
  if (isPanelOpen()) renderPanel($('modelSearch').value);
  $('speedHint').className = 'hint';
  $('speedHint').textContent = '测速结果已清除。';
});

$('sortBySpeed').addEventListener('change', async () => {
  await chrome.storage.local.set({ sortBySpeed: $('sortBySpeed').checked });
  if (isPanelOpen()) renderPanel($('modelSearch').value);
});

$('preset').addEventListener('change', () => {
  const p = PRESETS[$('preset').value];
  if (!p) return;
  $('baseURL').value = p.baseURL;
  $('model').value = p.model;
  $('protocol').value = p.protocol;
  setResult('已填入预设，别忘了填 API Key 再保存', '');
  refreshDetection();
});

$('save').addEventListener('click', async () => {
  const settings = readForm();
  await chrome.storage.local.set({ settings });
  setResult('已保存', 'ok');
  setTimeout(() => setResult('', ''), 2000);
});

/* 勾选框：一点就存，立刻生效，不用再点「保存」 */
for (const b of BOOLS) {
  const el = $(b);
  if (!el) continue;
  el.addEventListener('change', async () => {
    await patchSettings({ [b]: el.checked });
    setResult('已生效', 'ok');
    setTimeout(() => setResult('', ''), 1500);
  });
}

/* 下拉框和数字框：改完就存 */
for (const f of ['targetLang', 'displayMode', 'autoTranslateMinChars']) {
  const el = $(f);
  if (!el) continue;
  const save = debounce(async () => {
    let v = el.value;
    if (f === 'autoTranslateMinChars') v = Math.max(0, Math.min(100000, Number(v) || 0));
    await patchSettings({ [f]: v });
    setResult('已生效', 'ok');
    setTimeout(() => setResult('', ''), 1500);
  });
  el.addEventListener('change', save);
}

$('test').addEventListener('click', async () => {
  const btn = $('test');
  btn.disabled = true;
  setResult('测试中…', '');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mxt:test', settings: readForm() });
    if (res && res.ok) {
      setResult(`连接成功（识别为 ${res.protocolLabel}），返回：${res.sample}`, 'ok');
    } else {
      setResult('失败：' + (res?.error || '未知错误'), 'bad');
    }
  } catch (e) {
    setResult('失败：' + (e?.message || e), 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'mxt:clearCache' });
  setResult('翻译缓存和协议记忆已清空', 'ok');
  setTimeout(() => setResult('', ''), 2000);
});

load();
