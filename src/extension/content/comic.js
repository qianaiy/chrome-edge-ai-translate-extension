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
    busy: false,
    mode: 'inpaint', // 'inpaint' = 擦字重绘 | 'overlay' = 浮层覆盖
    debug: false, // 调试模式：框位、字号、行数、溢出都直接标在图上
    layouts: [] // 每张图最近一次的排版结果，给 debug 面板读
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
      .mxt-comic-note { color: #f5c451; font-size: 11px; margin-top: 6px; }
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
    const allBtn = document.createElement('button');
    allBtn.className = 'mxt-comic-all';
    allBtn.textContent = '全部翻译';
    allBtn.title = '从当前张开始，依次翻译后面所有图（失败的跳过）';
    const modeBtn = document.createElement('button');
    modeBtn.className = 'mxt-comic-mode';
    modeBtn.textContent = '擦字版';
    modeBtn.title = '切换：擦字重绘 / 浮层覆盖';
    const debugBtn = document.createElement('button');
    debugBtn.className = 'mxt-comic-debug-btn';
    debugBtn.textContent = '调试';
    debugBtn.title = '显示图片尺寸、每个气泡的框位、字号、行数与溢出情况';
    bar.append(prog, modeBtn, debugBtn, again, allBtn);

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
    allBtn.addEventListener('click', () => translateAll());
    modeBtn.addEventListener('click', () => {
      state.mode = state.mode === 'inpaint' ? 'overlay' : 'inpaint';
      modeBtn.textContent = state.mode === 'inpaint' ? '擦字版' : '浮层版';
      /* 切模式后把当前这张重画一遍。
         必须把 rec.drawable 一起传下去：跨域图片的原图是污染画布，
         readPixels 会失败，renderTranslated 返回 null 后退回浮层——
         表现就是「点了擦字版，还是一堆白框」。 */
      const img = state.images[state.index];
      if (img) {
        const rec = state.done.get(img);
        clearOverlays();
        if (rec) applyToImage(img, rec.items, rec.drawable);
      }
    });

    /* 调试开关只影响「怎么显示」，不重新请求接口：切菜一样快，也不浪费额度。 */
    debugBtn.addEventListener('click', () => {
      state.debug = !state.debug;
      debugBtn.textContent = state.debug ? '调试中' : '调试';
      debugBtn.style.background = state.debug ? 'rgba(52,199,89,0.35)' : '';
      const img = state.images[state.index];
      if (!img) return;
      const rec = state.done.get(img);
      clearOverlays();
      const body = h.shadowRoot.querySelector('.mxt-comic-body');
      if (body) for (const n of body.querySelectorAll('.mxt-comic-debug')) n.remove();
      if (rec) applyToImage(img, rec.items, rec.drawable);
    });

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

  /* 擦字失败时不要静默退回浮层：用户看到的是「擦字功能坏了」，
     却不知道是跨域读不到像素。这里追加一行提示，不清空已渲染的译文列表。 */
  function note(text) {
    const h = host();
    const body = h.shadowRoot.querySelector('.mxt-comic-body');
    if (!body) return;
    for (const n of body.querySelectorAll('.mxt-comic-note')) n.remove();
    if (!text) return;
    const d = document.createElement('div');
    d.className = 'mxt-comic-note';
    d.textContent = text;
    body.appendChild(d);
  }

  /* ---------------- 覆盖层 ---------------- */

  function clearOverlays() {
    for (const n of document.querySelectorAll('.' + OVERLAY_CLASS)) n.remove();
  }

  /* ---------------- 气泡内排版 ---------------- */

  const MIN_FONT = 10;
  const MAX_FONT = 44;
  const LINE_H = 1.28;
  /* 安全边距：气泡是不规则的椭圆，贴着外接矩形的边写会压到描边 */
  const SAFE_W = 0.88;
  const SAFE_H = 0.86;

  /* CJK 禁则：这些标点不能出现在行首（要跟着上一行走） */
  const NO_LINE_START = '、。，．・：；？！）〕」』】》〉”’ー～…—·%';
  /* 这些不能留在行尾 */
  const NO_LINE_END = '（〔「『【《〈“‘';

  let measureCtx = null;

  /* 真实测量。之前用的是「汉字≈1 字号宽、拉丁≈0.55」的粗估，
     中英混排、数字、标点一多就明显偏差，字号算出来不是太小就是溢出。 */
  function textWidth(text, size, weight) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${weight || 700} ${size}px sans-serif`;
    return measureCtx.measureText(text).width;
  }

  /** 按宽度折行，带 CJK 行首/行尾禁则 */
  function wrapText(text, size, maxWidth) {
    const chars = Array.from(String(text).replace(/\s+/g, ' ').trim());
    const lines = [];
    let cur = '';
    for (const ch of chars) {
      if (cur && textWidth(cur + ch, size) > maxWidth) {
        let carry = '';
        if (NO_LINE_START.includes(ch) && cur.length > 1) {
          carry = cur.slice(-1);
          cur = cur.slice(0, -1);
        } else if (NO_LINE_END.includes(cur.slice(-1)) && cur.length > 1) {
          carry = cur.slice(-1);
          cur = cur.slice(0, -1);
        }
        lines.push(cur);
        cur = carry + ch;
      } else {
        cur += ch;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /** 横排：从大字号往下找放得下的最大字号 */
  function layoutH(text, boxW, boxH) {
    const maxW = Math.max(16, boxW * SAFE_W);
    const maxH = Math.max(16, boxH * SAFE_H);
    const top = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(maxW / 2), Math.floor(maxH / 2)));
    for (let size = top; size >= MIN_FONT; size--) {
      const lines = wrapText(text, size, maxW);
      if (lines.length * size * LINE_H <= maxH) return { size, lines: lines.length, overflow: false };
    }
    return { size: MIN_FONT, lines: wrapText(text, MIN_FONT, maxW).length, overflow: true };
  }

  /** 竖排：按「每列几个字」推列数，再从大字号往下试 */
  function layoutV(text, boxW, boxH) {
    const maxH = Math.max(16, boxH * SAFE_H);
    const maxW = Math.max(16, boxW * SAFE_W);
    const count = Array.from(String(text).replace(/\s+/g, '')).length;
    if (!count) return { size: MIN_FONT, lines: 0, overflow: true };
    for (let size = Math.min(MAX_FONT, Math.floor(maxH / 2)); size >= MIN_FONT; size--) {
      const perCol = Math.max(1, Math.floor(maxH / (size * LINE_H)));
      const cols = Math.ceil(count / perCol);
      if (cols * size * LINE_H <= maxW) return { size, lines: cols, overflow: false };
    }
    return { size: MIN_FONT, lines: 1, overflow: true };
  }

  /* 竖排判定：框明显窄高，或者译文里有假名（日漫以竖排为主）。
     中文横排更常见，所以不能一律按框形判。 */
  function isVerticalBox(boxW, boxH, text) {
    if (boxH < boxW * 1.5) return false;
    return boxW <= Math.max(64, boxH * 0.32) || /[\u3040-\u30ff]/.test(text);
  }

  function paintOverlays(img, items) {
    for (const n of img.parentElement?.querySelectorAll?.('.' + OVERLAY_CLASS) || []) n.remove();
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    const wr = wrap.getBoundingClientRect();

    state.layouts = [];

    items.forEach((it, idx) => {
      if (!it.box || it.box.length !== 4 || !it.zh) return;
      const [x1, y1, x2, y2] = it.box.map(Number);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return;

      const left = (Math.min(x1, x2) / 100) * r.width + r.left - wr.left;
      const top = (Math.min(y1, y2) / 100) * r.height + r.top - wr.top;
      const bw = Math.max(18, (Math.abs(x2 - x1) / 100) * r.width);
      const bh = Math.max(14, (Math.abs(y2 - y1) / 100) * r.height);

      const vertical = isVerticalBox(bw, bh, it.zh);
      const fit = vertical ? layoutV(it.zh, bw, bh) : layoutH(it.zh, bw, bh);

      const d = document.createElement('div');
      d.className = OVERLAY_CLASS;
      d.dataset.zh = it.zh;
      d.dataset.src = it.text || '';
      d.dataset.box = it.box.join(',');

      Object.assign(d.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: `${bw}px`,
        height: `${bh}px`,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1px',
        borderRadius: '6px',
        /* 普通气泡底色就是白的，用白底把被挡住的原文盖掉 */
        background: 'rgba(255,255,255,0.96)',
        color: '#111',
        font: `700 ${fit.size}px/${LINE_H} "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`,
        textAlign: 'center',
        overflow: 'hidden',
        pointerEvents: 'auto',
        cursor: 'pointer',
        zIndex: '2147483000'
      });

      const span = document.createElement('span');
      span.textContent = it.zh;
      if (vertical) {
        Object.assign(span.style, {
          writingMode: 'vertical-rl',
          textOrientation: 'upright',
          maxHeight: '100%',
          maxWidth: '100%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        });
      } else {
        Object.assign(span.style, {
          maxWidth: '100%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        });
      }
      d.appendChild(span);

      /* 自动排版装不下也不能把字丢掉：转成可编辑，用户自己改短或调位置。 */
      if (fit.overflow) {
        span.contentEditable = 'true';
        d.style.outline = '2px dashed #ff9f0a';
        d.title = '译文太长，气泡装不下。可以直接在这里改短。';
      }

      let showingOriginal = false;
      d.addEventListener('click', ev => {
        ev.stopPropagation();
        if (fit.overflow && span.isContentEditable && document.activeElement === span) return;
        showingOriginal = !showingOriginal;
        span.textContent = showingOriginal ? d.dataset.src || '（没拿到原文）' : it.zh;
        d.style.background = showingOriginal ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.96)';
        d.style.border = showingOriginal ? '1px dashed rgba(0,0,0,0.5)' : 'none';
      });

      if (state.debug) {
        d.style.outline = `2px solid ${fit.overflow ? '#ff3b30' : '#34c759'}`;
        const tag = document.createElement('div');
        tag.textContent = `#${idx} ${Math.round(bw)}×${Math.round(bh)} ${fit.size}px ${vertical ? '竖' : '横'}${fit.overflow ? ' 溢出' : ''}`;
        Object.assign(tag.style, {
          position: 'absolute',
          left: '0',
          top: '-15px',
          font: '600 10px/1.3 monospace',
          color: '#fff',
          background: 'rgba(0,0,0,0.78)',
          padding: '1px 3px',
          borderRadius: '3px',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        });
        d.appendChild(tag);
      }

      state.layouts.push({
        id: idx,
        box: it.box,
        px: { left: Math.round(left), top: Math.round(top), w: Math.round(bw), h: Math.round(bh) },
        fontSize: fit.size,
        lines: fit.lines,
        vertical,
        overflow: !!fit.overflow,
        text: it.text || '',
        zh: it.zh
      });

      wrap.appendChild(d);
    });

    if (state.debug) debugReport(img, items);
  }

  /* Debug Mode 的文本框输出：把每个阶段的实际数字写进面板，不靠猜。 */
  function debugReport(img, items) {
    const h = host();
    h.classList.add('mxt-comic-open');
    const body = h.shadowRoot.querySelector('.mxt-comic-body');
    if (!body) return;
    for (const n of body.querySelectorAll('.mxt-comic-debug')) n.remove();

    const r = img.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'mxt-comic-debug';
    const lines = [
      `图片原始尺寸 ${img.naturalWidth || '?'}×${img.naturalHeight || '?'}`,
      `图片显示尺寸 ${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`,
      `识别到文字块 ${items.filter(i => i.box && i.box.length === 4).length} / 共 ${items.length}`,
      `气泡识别 ${state.lastPlan ? state.lastPlan.bubble + '/' + state.lastPlan.total + ' core=' + (state.lastPlan.core ? 'y' : 'n') + ' fn=' + (state.lastPlan.hasFn ? 'y' : 'n') + ' err=' + state.lastPlan.err : '未经过擦字版'}`,
      `规划明细 ${state.lastPlan && state.lastPlan.detail ? state.lastPlan.detail : '无'}`,
      `像素缓冲 ${state.lastPlan && state.lastPlan.buf || '无'}`,

      ...state.layouts.map(l => `#${l.id} ${l.vertical ? '竖' : '横'} ${l.fontSize}px ${l.lines}行 ${l.px.w}×${l.px.h}${l.overflow ? ' 溢出' : ''}`)
    ];
    d.textContent = lines.join('\n');
    Object.assign(d.style, {
      marginTop: '6px',
      font: '11px/1.5 monospace',
      color: '#8ab4f8',
      whiteSpace: 'pre-wrap',
      borderTop: '1px solid rgba(255,255,255,0.12)',
      paddingTop: '6px'
    });
    body.appendChild(d);
  }

  /* ---------------- 图片转 base64 ---------------- */

  /* 跨域图片的绕行路线：后台取字节 → 页面里造一张同源副本 → 画布不再被污染。
     按 url 缓存，翻回上一张不用重下。 */
  const localImages = new Map();

  function loadDataUrl(src) {
    return new Promise(resolve => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  async function drawableImage(img) {
    const url = img.currentSrc || img.src || '';
    if (!url) return img;
    if (localImages.has(url)) return localImages.get(url) || img;
    let copy = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'mxt:fetchImage', url });
      if (res && res.ok && res.data) {
        copy = await loadDataUrl(`data:${res.mediaType || 'image/jpeg'};base64,${res.data}`);
      }
    } catch (_) {
      copy = null;
    }
    localImages.set(url, copy);
    return copy || img;
  }

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

  /* ---------------- 译文排版 ---------------- */

  /* 一个字在给定字号下大概多宽（相对字号的倍数）。
     中日文一个字约等于字号宽度；拉丁字母平均约 0.55 倍。 */
  function estimateTextWidth(text, fontSize) {
    let units = 0;
    for (const ch of String(text || '')) {
      const c = ch.codePointAt(0);
      if (c < 0x41) continue;
      if (c >= 0x4e00 && c <= 0x9fff) units += 1;
      else if (c >= 0x3040 && c <= 0x30ff) units += 1;
      else if (c >= 0xac00 && c <= 0xd7af) units += 1;
      else units += 0.55;
    }
    return units * fontSize;
  }

  /**
   * 把译文塞进原文字的框里。
   * 漫画里常见「原文很短、译文很长」—— 英文一句话翻成中文可能长一倍多，
   * 直接画上去会溢出气泡、盖住旁边的画面。
   * 做法：按框高算理想字号 → 放不下就缩字号 → 缩到底就折行 →
   * 还放不下就截断加省略号。宁可少显示，也不能画到框外面。
   */
  function fitText(text, boxWidth, boxHeight, opts) {
    const o = opts || {};
    const minFont = Math.max(8, o.minFontSize ?? 10);
    const maxFont = Math.max(minFont, o.maxFontSize ?? 34);
    const lineHeight = o.lineHeight ?? 1.22;
    const src = String(text || '').trim();
    if (!src) return { fontSize: minFont, lines: [''], height: 0, shrunk: false };

    const w = Math.max(1, boxWidth);
    const h = Math.max(1, boxHeight);
    const maxLines = Math.max(1, o.maxLines ?? Math.max(1, Math.floor(h / (minFont * lineHeight))));

    let fontSize = Math.min(maxFont, Math.max(minFont, Math.round(h * 0.72)));

    const linesFor = size => {
      const perLine = Math.max(1, Math.floor(w / size));
      const out = [];
      let cur = '';
      let units = 0;
      const words = src.match(/\S+\s*|\s+/g) || [];

      for (const word of words) {
        const wu = estimateTextWidth(word, 1);
        if (units + wu > perLine && cur) {
          out.push(cur.trimEnd());
          cur = '';
          units = 0;
        }
        if (wu > perLine) {
          /* 单个词就超宽（长英文单词或一整段没空格的中文）：按字切 */
          let piece = '';
          let pu = 0;
          for (const ch of word) {
            const cu = estimateTextWidth(ch, 1);
            if (pu + cu > perLine && piece) {
              out.push(piece);
              piece = '';
              pu = 0;
            }
            piece += ch;
            pu += cu;
          }
          cur = piece;
          units = pu;
        } else {
          cur += word;
          units += wu;
        }
      }
      if (cur.trim()) out.push(cur.trimEnd());
      return out.length ? out : [''];
    };

    let lines = linesFor(fontSize);
    let shrunk = false;

    while (
      fontSize > minFont &&
      (lines.length > maxLines ||
        lines.reduce((a, l) => a + estimateTextWidth(l, fontSize), 0) > w * 1.02)
    ) {
      fontSize -= 1;
      lines = linesFor(fontSize);
      shrunk = true;
    }

    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : last;
      shrunk = true;
    }

    return { fontSize, lines, height: lines.length * fontSize * lineHeight, shrunk };
  }

  /* ---------------- 擦字 + 背景修复 ---------------- */

  /* 画一版「擦掉原文、画上译文」的图。
     原来的做法是把译文盖成浮层，原文还在底下透出来，两个字叠在一起很难看。
     这里改成：先按模型给的文字位置把原文擦掉（用周围底色填），
     再把译文直接画在那个位置——跟原生汉化漫画的做法一样。 */

  /** 把图片画进 canvas，取出像素 */
  function readPixels(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (_) {
      return null; // 跨域
    }
    return { canvas, ctx, buf: { width: data.width, height: data.height, data: data.data } };
  }

  /** 估算背景色：取框外一圈像素的中位色 */
  function estimateBackground(buf, x1, y1, x2, y2) {
    const band = Math.max(2, Math.round(Math.min(x2 - x1, y2 - y1) * 0.12));
    const rs = [], gs = [], bs = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
      const i = (y * buf.width + x) * 4;
      rs.push(buf.data[i]); gs.push(buf.data[i + 1]); bs.push(buf.data[i + 2]);
    };
    for (let x = x1; x < x2; x++) for (let d = 0; d < band; d++) { push(x, y1 - 1 - d); push(x, y2 + d); }
    for (let y = y1; y < y2; y++) for (let d = 0; d < band; d++) { push(x1 - 1 - d, y); push(x2 + d, y); }
    if (!rs.length) {
      for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
        const i = (y * buf.width + x) * 4;
        rs.push(buf.data[i]); gs.push(buf.data[i + 1]); bs.push(buf.data[i + 2]);
      }
    }
    if (!rs.length) return { r: 255, g: 255, b: 255, a: 255 };
    const med = arr => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; };
    return { r: med(rs), g: med(gs), b: med(bs), a: 255 };
  }

  /** 擦掉框里的文字：按「和背景色的差距」加权混合，保留渐变和纹理 */
  function eraseBox(buf, x1, y1, x2, y2, bg) {
    const w = x2 - x1, h = y2 - y1;
    if (w <= 0 || h <= 0) return;
    const feather = Math.max(1, Math.round(Math.min(w, h) * 0.12));
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) continue;
        const i = (y * buf.width + x) * 4;
        const cr = buf.data[i], cg = buf.data[i + 1], cb = buf.data[i + 2];
        const diff = Math.abs(cr - bg.r) + Math.abs(cg - bg.g) + Math.abs(cb - bg.b);
        const t = Math.min(1, diff / 255);
        /* 差得很少的才算底色；抗锯齿边缘要一起擦掉，不然留残影 */
        if (t < 0.015) continue;
        const edge = Math.min(x - x1, x2 - 1 - x, y - y1, y2 - 1 - y);
        const fw = edge >= feather ? 1 : edge / feather;
        /* 差得越多替换越彻底；底色附近只轻轻带一下。
           指数小于 1，让「差一点点」的抗锯齿边缘也擦得掉 —— 不然会留淡淡的残影。 */
        const k = Math.min(1, Math.pow(t, 0.45)) * (0.7 + 0.3 * fw);
        buf.data[i] = cr + (bg.r - cr) * k;
        buf.data[i + 1] = cg + (bg.g - cg) * k;
        buf.data[i + 2] = cb + (bg.b - cb) * k;
      }
    }
  }

  /** 深底浅字、浅底深字 */
  function readableColor(bg) {
    const lum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
    return lum > 0.55 ? '#111111' : '#ffffff';
  }

  /** 按框的大小算自适应余量：模型给的位置常偏半个字高，不留余量会擦不干净。
      垂直方向留得更多——模型框竖直方向最容易偏，水平方向偏一点无所谓。
      垂直余量给到 0.5 倍字高，这样框偏一整行也还能盖住。 */
  function adaptivePad(box, w, h) {
    const bw = (Math.abs(box.x2 - box.x1) / 100) * w;
    const bh = (Math.abs(box.y2 - box.y1) / 100) * h;
    return {
      x: Math.round(Math.min(Math.max(bw * 0.1, 4), 24)),
      y: Math.round(Math.min(Math.max(bh * 0.5, 8), 44))
    };
  }

  /** 擦掉一个框：先把框撑大一点，再按「和背景色的差距」加权抹掉 */
  function eraseRect(buf, x1, y1, x2, y2) {
    const bg = estimateBackground(buf, x1, y1, x2, y2);
    eraseBox(buf, x1, y1, x2, y2, bg);
    return bg;
  }

  /**
   * 生成擦字+译文后的图片（dataURL）。
   * @returns { url, bgs } url 是新图，bgs 是每个文字块的背景色（决定字色）
   */
  function renderTranslated(img, items) {
    const px = readPixels(img);
    if (!px) return null;
    const { canvas, ctx, buf } = px;

    const boxes = items.filter(it => it.box && it.box.length === 4 && it.zh);

    /* 每个文字块先决定「用气泡掩码」还是「退回矩形」。
       气泡识别必须在擦之前做——它要读原始像素才能找到气泡底色和边界。
       识别不出来（字直接压在画面上、根本没有气泡）就老实退回矩形，不假装认到了。 */
    const core = typeof MXTCore === 'undefined' ? null : MXTCore;
    let bubbleErr = 0;
    const plans = boxes.map(b => {
      const [ax1, ay1, ax2, ay2] = b.box.map(Number);
      const bx = Math.min(ax1, ax2);
      const by = Math.min(ay1, ay2);
      const bw = Math.abs(ax2 - ax1);
      const bh = Math.abs(ay2 - ay1);
      if (core && typeof core.findBubbleRegion === 'function') {
        try {
          const reg = core.findBubbleRegion(buf, { x1: bx, y1: by, x2: bx + bw, y2: by + bh });
          if (reg && reg.isBubble) return { kind: 'bubble', reg };
        } catch (e) {
          /* 识别失败不影响主流程，退回矩形即可；但计数留着，便于排查 */
          bubbleErr++;
        }
      }
      const pad = adaptivePad(b, buf.width, buf.height);
      return {
        kind: 'rect',
        reg: null,
        rect: {
          x1: Math.max(0, Math.round((bx / 100) * buf.width) - pad.x),
          y1: Math.max(0, Math.round((by / 100) * buf.height) - pad.y),
          x2: Math.min(buf.width, Math.round(((bx + bw) / 100) * buf.width) + pad.x),
          y2: Math.min(buf.height, Math.round(((by + bh) / 100) * buf.height) + pad.y)
        }
      };
    });

    /* 排版区必须落在「已经擦干净」的地方：
       气泡用它自己收窄出来的安全区（椭圆不会被当成矩形撑满），
       矩形用擦过的范围。两者都不用模型给的原始框——原始框常常没盖住整个字。 */
    state.lastPlan = {
      bubble: plans.filter(p => p.kind === 'bubble').length,
      total: plans.length,
      core: !!core,
      hasFn: !!(core && typeof core.findBubbleRegion === 'function'),
      err: bubbleErr,
      buf: buf.width + 'x' + buf.height + ' len=' + (buf.data ? buf.data.length : '?'),
      detail: plans
        .map(p =>
          p.kind === 'bubble'
            ? 'B' + p.reg.fillRatio.toFixed(2)
            : 'R' + (p.rect.x2 - p.rect.x1) + 'x' + (p.rect.y2 - p.rect.y1)
        )
        .join(',')
    };

    const areas = plans.map(p => (p.kind === 'bubble' ? p.reg.safe : p.rect));

    const fits = boxes.map((it, i) => {
      const a = areas[i];
      const w = Math.max(20, a.x2 - a.x1);
      const h = Math.max(14, a.y2 - a.y1);
      return fitText(it.zh, w, h);
    });

    /* 背景色必须在擦之前全估好：边擦边估的话，后一个框会拿
       「上一个框刚擦出来的白」当背景，越擦越白，整块图都漂移掉。 */
    const bgs = plans.map(p =>
      p.kind === 'bubble'
        ? p.reg.bg
        : estimateBackground(buf, p.rect.x1, p.rect.y1, p.rect.x2, p.rect.y2)
    );

    /* 再逐个擦：认出气泡的只擦气泡内部（描边和气泡外的画面一个像素都不动），
       没认出来的退回矩形擦除。 */
    plans.forEach((p, i) => {
      if (p.kind === 'bubble' && core && typeof core.eraseBubble === 'function') {
        core.eraseBubble(buf, p.reg, 1);
      } else {
        eraseBox(buf, p.rect.x1, p.rect.y1, p.rect.x2, p.rect.y2, bgs[i]);
      }
    });

    /* 把擦过的像素写回 canvas */
    ctx.putImageData(new ImageData(buf.data, buf.width, buf.height), 0, 0);

    /* 画译文：字号和行数上面已经算好了，直接用 */
    boxes.forEach((it, i) => {
      const a = areas[i];
      const bg = bgs[i] || { r: 255, g: 255, b: 255 };
      const h = Math.max(14, a.y2 - a.y1);
      const fit = fits[i];
      const fontSize = fit.fontSize;

      ctx.save();
      ctx.font = `600 ${fontSize}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';

      const cx = (a.x1 + a.x2) / 2;
      /* 整体垂直居中 */
      const totalH = fit.lines.length * fontSize * 1.22;
      let ty = a.y1 + Math.max(0, (h - totalH) / 2);

      /* 描边：不管底色深浅都看得清 */
      ctx.lineWidth = Math.max(2, fontSize / 7);
      ctx.strokeStyle = readableColor(bg) === '#ffffff' ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
      ctx.lineJoin = 'round';
      for (const line of fit.lines) {
        ctx.strokeText(line, cx, ty);
        ctx.fillStyle = readableColor(bg);
        ctx.fillText(line, cx, ty);
        ty += fontSize * 1.22;
      }
      ctx.restore();
    });

    try {
      return { url: canvas.toDataURL('image/jpeg', 0.92), bgs };
    } catch (_) {
      return null;
    }
  }

  /* 覆盖层必须精确压住「图片盒」，不是父容器。
     之前用的是 left/top/width/height 100% + object-fit:contain：父容器往往是整块版面
     （实测 1264×798，图片盒只有 420×630 且偏移 60/48），于是整张图被按 contain
     缩放居中，气泡文字跟用户看到的图片完全对不上——看起来就是「译文没写进气泡」。
     正确做法：按 getBoundingClientRect 的差值定位，并用 fill 保证缩放比例和原图一致。 */
  const overlayOwners = [];

  function placeOver(img, d) {
    const wrap = img.parentElement;
    if (!wrap || !d.isConnected) return;
    const wr = wrap.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    if (!ir.width || !ir.height) return;
    Object.assign(d.style, {
      left: `${ir.left - wr.left}px`,
      top: `${ir.top - wr.top}px`,
      width: `${ir.width}px`,
      height: `${ir.height}px`
    });
  }

  function trackOverlay(img, d) {
    overlayOwners.push({ img, el: d });
    placeOver(img, d);
  }

  /* 页面滚动不改变相对位置，但缩放、响应式布局、图片懒加载完成都会改。
     统一在这种时机重算一次，避免「改成 50% 之后错位」。 */
  function repositionOverlays() {
    for (let i = overlayOwners.length - 1; i >= 0; i--) {
      const pair = overlayOwners[i];
      if (!pair.el.isConnected) {
        overlayOwners.splice(i, 1);
        continue;
      }
      placeOver(pair.img, pair.el);
    }
  }

  window.addEventListener('resize', repositionOverlays, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => repositionOverlays());
    const watch = img => {
      try {
        ro.observe(img);
        if (img.parentElement) ro.observe(img.parentElement);
      } catch (_) {
        /* 已经销毁的节点忽略 */
      }
    };
    window.__mxtWatchOverlay = watch;
  }

  /** 把擦好的图盖在原图上（原图保留在下面，撤销时能还原） */
  function paintInpainted(img, url) {
    for (const n of img.parentElement?.querySelectorAll?.('.' + OVERLAY_CLASS) || []) n.remove();
    for (let i = overlayOwners.length - 1; i >= 0; i--) {
      if (!overlayOwners[i].el.isConnected) overlayOwners.splice(i, 1);
    }
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    const d = document.createElement('img');
    d.className = OVERLAY_CLASS;
    d.src = url;
    d.alt = '';
    Object.assign(d.style, {
      position: 'absolute',
      objectFit: 'fill',
      pointerEvents: 'none',
      zIndex: '2147483000'
    });
    wrap.appendChild(d);
    trackOverlay(img, d);
    if (typeof window.__mxtWatchOverlay === 'function') window.__mxtWatchOverlay(img);
    // 图片自身尺寸变化（懒加载完成、百分比宽度）也要跟上
    img.addEventListener('load', () => placeOver(img, d), { passive: true });
    repositionOverlays();
  }

  /* ---------------- 主流程 ---------------- */

  /* 识别请求原本没有任何上限：模型卡住时界面会永远停在「正在识别并翻译」，
     用户既看不出是超时也不知道能不能跳过。加超时，让失败可见。 */
  const REQUEST_TIMEOUT_MS = 120000;
  const BATCH_CONCURRENCY = 2;

  function withTimeout(promise, ms, label) {
    if (!ms || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label || '请求'}超时（${Math.round(ms / 1000)} 秒）`));
      }, ms);
      Promise.resolve(promise).then(
        v => {
          clearTimeout(timer);
          resolve(v);
        },
        e => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /** 最多同时跑 limit 个；单张失败由 worker 自己处理，不影响其他张 */
  async function runPool(items, limit, worker, shouldStop) {
    let next = 0;
    const lanes = Math.max(1, Math.min(limit || 1, items.length || 1));
    const lane = async () => {
      while (next < items.length) {
        if (shouldStop && shouldStop()) return;
        const i = next++;
        try {
          await worker(items[i], i);
        } catch (_) {
          /* 单张出问题不能拖垮整批；worker 自己负责计失败 */
        }
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  /** 识别一张图，不碰界面，方便批量复用 */
  async function recognise(img) {
    const drawable = await drawableImage(img);
    const b64 = await toBase64(drawable);
    if (!b64) return { ok: false, error: '这张图读不出来（跨域，且后台也取不到原图）' };
    let res = null;
    try {
      res = await withTimeout(
        chrome.runtime.sendMessage({
          type: 'mxt:translateImage',
          image: b64.data,
          mediaType: b64.mediaType
        }),
        REQUEST_TIMEOUT_MS,
        '识图'
      );
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
    if (!res || !res.ok) return { ok: false, error: res?.error || '翻译失败' };
    return { ok: true, items: res.items || [], drawable };
  }

  async function translateCurrent(force) {
    const img = state.images[state.index];
    if (!img) return;
    if (!force && state.done.has(img)) {
      /* 翻回翻过的一张时重画。这里以前写死 paintOverlays，
         等于每次切换图片都退回浮层——擦字版只在第一次翻译时出现过一次。 */
      const rec = state.done.get(img);
      renderItems(rec.items);
      applyToImage(img, rec.items, rec.drawable);
      return;
    }
    setMsg('正在读图…');
    const r = await recognise(img);
    if (!r.ok) {
      setMsg(r.error);
      return;
    }
    /* drawable 要一起存：它是后台取回来的同源副本，重画擦字版时还得用它 */
    state.done.set(img, { items: r.items, at: Date.now(), drawable: r.drawable });
    renderItems(r.items);
    applyToImage(img, r.items, r.drawable);
    updateBar();
  }

  const batch = { running: false, stop: false };

  /** 从当前张往后批量翻译；失败的跳过并计数，随时可停 */
  async function translateAll() {
    if (batch.running) {
      batch.stop = true;
      setMsg('正在停止…');
      return;
    }
    const imgs = state.images.slice(state.index);
    if (!imgs.length) return;
    batch.running = true;
    batch.stop = false;
    const btn = () => {
      const h = document.getElementById(HOST_ID);
      return h && h.shadowRoot ? h.shadowRoot.querySelector('.mxt-comic-all') : null;
    };
    if (btn()) btn().textContent = '停止';
    setMsg(`批量翻译中（同时 ${BATCH_CONCURRENCY} 张）…`);
    let ok = 0;
    let failed = 0;
    let handled = 0;
    await runPool(
      imgs,
      BATCH_CONCURRENCY,
      async img => {
        if (batch.stop) return;
        let r = await recognise(img);
        if (!r.ok && !batch.stop) {
          /* 重试一次：多半是超时或上游偶发错误 */
          r = await recognise(img);
        }
        handled += 1;
        if (r.ok) {
          ok += 1;
          /* drawable 要一起存：它是后台取回来的同源副本，重画擦字版时还得用它 */
    state.done.set(img, { items: r.items, at: Date.now(), drawable: r.drawable });
          applyToImage(img, r.items, r.drawable);
        } else if (!batch.stop) {
          failed += 1;
        }
        setMsg(`批量翻译中：${handled} / ${imgs.length} 张，成功 ${ok}，失败 ${failed}`);
      },
      () => batch.stop
    );
    const stopped = batch.stop;
    batch.running = false;
    batch.stop = false;
    if (btn()) btn().textContent = '全部翻译';
    setMsg(
      stopped
        ? `已停止：处理 ${handled} / ${imgs.length} 张，成功 ${ok}，失败 ${failed}`
        : `完成：成功 ${ok} 张，失败 ${failed} 张`
    );
  }

  /** 按当前模式把译文画到图上：擦字重绘，或者浮层覆盖 */
  function applyToImage(img, items, drawable) {
    /* 只给了译文、没给坐标的块无法定位。数量对上时不说，数量为 0 才说：
       这是模型没按格式回答，用户看到的是「图没有变化」，不说明就像功能坏了。 */
    const placeable = items.filter(it => it.box && it.box.length === 4 && it.zh).length;
    if (items.length && !placeable) {
      note('模型这次只给了译文、没给文字位置，所以图上没画。面板里可以逐条看。');
      return;
    }

    if (state.mode === 'inpaint') {
      const r = renderTranslated(drawable || img, items);
      if (r) {
        paintInpainted(img, r.url);
        note('');
        if (state.debug) debugReport(img, items);
        return;
      }
      /* 擦不动就退回浮层，至少能看见译文；但要说明原因，
         否则用户只会看到「一片白框」，以为擦字功能坏了。 */
      note(
        drawable
          ? '这张图擦字失败（画面太大或像素读取异常），已退回浮层覆盖。'
          : '这张图跨域取不到原图，擦不了字，已退回浮层覆盖。'
      );
    }
    paintOverlays(img, items);
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

