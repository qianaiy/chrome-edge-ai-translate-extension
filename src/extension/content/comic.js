'use strict';

/* ------------------------------------------------------------------ *
 * 译点 · 漫画翻译（自动识别）
 *
 * 不需要用户框选：自动把页面里「像漫画页」的图片找出来，
 * 排队逐张送去多模态模型识别+翻译，译文按位置盖在图上。
 *
 * 怎么判断「像漫画页」：
 *   1. 图片本身够大（宽度占容器 60% 以上，且不小于 400px）
 *   2. 竖长比例（高度 > 宽度的 1.1 倍）——漫画页基本都是竖的
 *   3. 或者图片数量多 + 尺寸相近（连载漫画常见）
 *
 * 流程：Alt+C / 弹窗「翻漫画」→ 自动找出所有漫画图 → 逐张翻 →
 *       译文盖在图上，点「下一张」可以跳到还没翻的那张。
 * ------------------------------------------------------------------ */

(() => {
  if (window.__MXT_COMIC_ACTIVE__) return;
  window.__MXT_COMIC_ACTIVE__ = true;

  const HOST_ID = 'mxt-comic-host';
  const OVERLAY_CLASS = 'mxt-comic-overlay';

  const state = {
    images: [], // 找到的漫画图
    index: 0, // 当前翻到第几张
    done: new Map(), // img -> { items, at }
    busy: false
  };

  /* ---------------- 找漫画图 ---------------- */

  function isComicLike(img) {
    const r = img.getBoundingClientRect();
    if (r.width < 260 || r.height < 340) return false;
    if (!img.naturalWidth || !img.naturalHeight) return false;
    /* 原图太小的不看（多半是图标、缩略图） */
    if (img.naturalWidth < 350) return false;
    const ratio = r.height / r.width;
    /* 竖长的最像漫画页 */
    if (ratio > 1.12) return true;
    /* 横的：占了大半个屏也算（整页大图） */
    const vw = document.documentElement.clientWidth || 800;
    if (r.width >= vw * 0.7 && r.height >= 420) return true;
    return false;
  }

  function findComics() {
    const imgs = Array.from(document.querySelectorAll('img'));
    const list = imgs.filter(isComicLike);
    /* 去掉被包含的（同一张图的不同尺寸版本），只留最外层的 */
    const out = [];
    for (const img of list) {
      const covered = list.some(other => other !== img && other.contains && other.contains(img));
      if (!covered) out.push(img);
    }
    return out;
  }

  /* ---------------- 界面 ---------------- */

  function host() {
    let h = document.getElementById(HOST_ID);
    if (h) return h;
    h = document.createElement('div');
    h.id = HOST_ID;
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed; z-index: 2147483600;
        right: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px);
        display: none; flex-direction: column;
        background: rgba(17, 17, 20, 0.95); color: #eee;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      }
      :host(.mxt-comic-open) { display: flex; }
      .mxt-comic-head {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.12);
        font-weight: 600; flex: none;
      }
      .mxt-comic-title { flex: 1; font-weight: 600; }
      button {
        background: rgba(255,255,255,0.10); color: #eee; border: 0;
        border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit;
      }
      button:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
      button:disabled { opacity: .4; cursor: not-allowed; }
      .mxt-comic-bar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.08);
        font-size: 12px; color: #9aa0a6; flex: none;
      }
      .mxt-comic-bar .mxt-comic-prog { flex: 1; }
      .mxt-comic-body { padding: 8px 10px; overflow: auto; max-height: 40vh; }
      .mxt-comic-row { margin-bottom: 6px; }
      .mxt-comic-orig { color: #cfd3d8; }
      .mxt-comic-zh { color: #fff; }
      .mxt-comic-msg { color: #9aa0a6; }
    `;
    const shadow = h.attachShadow({ mode: 'open' });
    shadow.appendChild(style);

    const head = document.createElement('div');
    head.className = 'mxt-comic-head';
    const title = document.createElement('span');
    title.className = 'mxt-comic-title';
    title.textContent = '漫画翻译';
    const prev = document.createElement('button');
    prev.textContent = '←';
    prev.title = '上一张';
    const next = document.createElement('button');
    next.textContent = '→';
    next.title = '下一张';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '关闭';
    head.append(title, prev, next, close);

    const bar = document.createElement('div');
    bar.className = 'mxt-comic-bar';
    const prog = document.createElement('span');
    prog.className = 'mxt-comic-prog';
    const again = document.createElement('button');
    again.textContent = '重翻本张';
    bar.append(prog, again);

    const body = document.createElement('div');
    body.className = 'mxt-comic-body';
    shadow.append(head, bar, body);

    close.addEventListener('click', () => {
      h.classList.remove('mxt-comic-open');
      clearOverlays();
    });
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    again.addEventListener('click', () => translateCurrent(true));

    (document.body || document.documentElement).appendChild(h);
    return h;
  }

  function setMsg(text) {
    const h = host();
    h.classList.add('mxt-comic-open');
    const body = h.shadowRoot.querySelector('.mxt-comic-body');
    body.textContent = '';
    const d = document.createElement('div');
    d.className = 'mxt-comic-msg';
    d.textContent = text;
    body.appendChild(d);
    updateBar();
  }

  function updateBar() {
    const h = document.getElementById(HOST_ID);
    if (!h || !h.shadowRoot) return;
    const prog = h.shadowRoot.querySelector('.mxt-comic-prog');
    if (!prog) return;
    const total = state.images.length;
    if (!total) {
      prog.textContent = '';
      return;
    }
    prog.textContent = `第 ${state.index + 1} / ${total} 张`;
  }

  function renderItems(items) {
    const h = host();
    h.classList.add('mxt-comic-open');
    const body = h.shadowRoot.querySelector('.mxt-comic-body');
    body.textContent = '';
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'mxt-comic-msg';
      d.textContent = '这一页没识别到文字';
      body.appendChild(d);
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'mxt-comic-row';
      if (it.text) {
        const o = document.createElement('div');
        o.className = 'mxt-comic-orig';
        o.textContent = it.text;
        row.appendChild(o);
      }
      const z = document.createElement('div');
      z.className = 'mxt-comic-zh';
      z.textContent = it.zh || '';
      row.appendChild(z);
      body.appendChild(row);
    }
  }

  /* ---------------- 覆盖层 ---------------- */

  function clearOverlays() {
    for (const n of document.querySelectorAll('.' + OVERLAY_CLASS)) n.remove();
  }

  function paintOverlays(img, items) {
    for (const n of img.parentElement?.querySelectorAll?.('.' + OVERLAY_CLASS) || []) n.remove();
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    const wr = wrap.getBoundingClientRect();

    for (const it of items) {
      if (!it.box || it.box.length !== 4 || !it.zh) continue;
      const [x1, y1, x2, y2] = it.box.map(Number);
      const d = document.createElement('div');
      d.className = OVERLAY_CLASS;
      d.textContent = it.zh;
      const left = (Math.min(x1, x2) / 100) * r.width + r.left - wr.left;
      const top = (Math.min(y1, y2) / 100) * r.height + r.top - wr.top;
      const w = (Math.abs(x2 - x1) / 100) * r.width;
      Object.assign(d.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        minWidth: `${Math.max(w, 36)}px`,
        maxWidth: `${Math.max(w, 36) * 2.6}px`,
        padding: '2px 5px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.94)',
        color: '#111',
        font: '600 15px/1.25 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        textShadow: 'none',
        boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
        pointerEvents: 'none',
        zIndex: '2147483000',
        whiteSpace: 'pre-wrap'
      });
      wrap.appendChild(d);
    }
  }

  /* ---------------- 图片转 base64 ---------------- */

  async function toBase64(img) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      const idx = dataUrl.indexOf(',');
      return { data: dataUrl.slice(idx + 1), mediaType: 'image/jpeg' };
    } catch (_) {
      /* 跨域图片会污染画布 */
      return null;
    }
  }

  /* ---------------- 主流程 ---------------- */

  async function translateCurrent(force) {
    const img = state.images[state.index];
    if (!img) return;
    if (!force && state.done.has(img)) {
      const rec = state.done.get(img);
      renderItems(rec.items);
      paintOverlays(img, rec.items);
      return;
    }
    setMsg('正在读图…');
    const b64 = await toBase64(img);
    if (!b64) {
      setMsg('这张图跨域了读不出来（换个图源，或把图片存下来再试）');
      return;
    }
    setMsg('正在识别并翻译（可能十几秒）…');
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'mxt:translateImage',
        image: b64.data,
        mediaType: b64.mediaType
      });
    } catch (e) {
      res = { ok: false, error: e?.message || String(e) };
    }
    if (!res || !res.ok) {
      setMsg(res?.error || '翻译失败');
      return;
    }
    const items = res.items || [];
    state.done.set(img, { items, at: Date.now() });
    renderItems(items);
    paintOverlays(img, items);
    updateBar();
  }

  function step(delta) {
    if (!state.images.length) return;
    clearOverlays();
    state.index = (state.index + delta + state.images.length) % state.images.length;
    updateBar();
    const img = state.images[state.index];
    try {
      img.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {
      /* 忽略 */
    }
    translateCurrent(false);
  }

  async function start() {
    const h = host();
    h.classList.add('mxt-comic-open');
    clearOverlays();
    state.images = findComics();
    state.index = 0;
    state.done.clear();
    updateBar();
    if (!state.images.length) {
      setMsg('没在页面上找到漫画图（要够大的竖图）');
      return;
    }
    if (state.images.length > 1) {
      const first = state.images[0];
      try {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_) {
        /* 忽略 */
      }
    }
    await translateCurrent(false);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'mxt:translateComic') {
      start();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'mxt:comicStep') {
      step(Number(msg.delta) || 1);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'mxt:clearComic') {
      clearOverlays();
      const h = document.getElementById(HOST_ID);
      if (h) h.classList.remove('mxt-comic-open');
      sendResponse({ ok: true });
      return;
    }
  });
})();
