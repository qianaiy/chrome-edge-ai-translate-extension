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
    layouts: [], // 每张图最近一次的排版结果，给 debug 面板读
    currentImg: null, // 当前这张图，导出和人工修正都要用它
    items: [], // 当前这张图的识别结果（用户改过字之后就是改过的版本）
    selectedItem: -1, // 当前选中的是第几条，-1 表示没选
    showOrig: false, // 原图 / 译图切换：true = 盖住译文，只看原图
    phase: null, // 当前阶段进度 { label, t0 }：进度条和心跳都读它
    progress: null, // 批量进度 { total, handled, ok, failed }
    undo: [] // 人工调整的撤销栈：[{ img, idx, box, zh, manualFont }]
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
      .mxt-comic-row {
        margin-bottom: 6px; display: grid;
        grid-template-columns: 1fr auto; gap: 2px 8px; align-items: start;
        cursor: pointer; border-radius: 6px; padding: 2px 4px;
      }
      .mxt-comic-row:hover { background: rgba(255,255,255,0.06); }
      .mxt-comic-row > .mxt-comic-orig,
      .mxt-comic-row > .mxt-comic-zh { grid-column: 1; }
      .mxt-comic-row-failed .mxt-comic-zh { color: #ff9f0a; }
      .mxt-comic-retry {
        grid-column: 2; grid-row: 1 / span 2; align-self: center;
        font-size: 11px; padding: 2px 6px; opacity: .75;
      }
      .mxt-comic-orig { color: #cfd3d8; }
      .mxt-comic-zh { color: #fff; }
      .mxt-comic-msg { color: #9aa0a6; margin-bottom: 6px; }
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
    const fontDown = document.createElement('button');
    fontDown.className = 'mxt-comic-font-down';
    fontDown.textContent = 'A-';
    fontDown.title = '选中一条译文后，字号调小';
    const fontUp = document.createElement('button');
    fontUp.className = 'mxt-comic-font-up';
    fontUp.textContent = 'A+';
    fontUp.title = '选中一条译文后，字号调大';
    const autoFitBtn = document.createElement('button');
    autoFitBtn.className = 'mxt-comic-autofit';
    autoFitBtn.textContent = '自动适配';
    autoFitBtn.title = '按当前框的大小重新排版选中的那条（会覆盖手动调的字号）';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'mxt-comic-export';
    exportBtn.textContent = '导出';
    exportBtn.title = '把当前这张图连同译文存成 PNG';
    const debugBtn = document.createElement('button');
    debugBtn.className = 'mxt-comic-debug-btn';
    debugBtn.textContent = '调试';
    debugBtn.title = '显示图片尺寸、每个气泡的框位、字号、行数与溢出情况';
    /* 原图 / 译图切换：只隐藏覆盖层，原图一直在下面，所以切换是瞬间的、
       不重新请求、不丢人工调整。 */
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mxt-comic-toggle';
    toggleBtn.textContent = '原图';
    toggleBtn.title = '在原图和译图之间切换（不改动任何译文）';
    /* 撤销：拖动、改字、重设框、A± 都入栈，一次退一步。 */
    const undoBtn = document.createElement('button');
    undoBtn.className = 'mxt-comic-undo';
    undoBtn.textContent = '撤销';
    undoBtn.title = '撤销上一次人工调整（位置 / 文字 / 字号 / 气泡区域）';
    bar.append(prog, modeBtn, fontDown, fontUp, autoFitBtn, toggleBtn, undoBtn, debugBtn, again, allBtn, exportBtn);

    const body = document.createElement('div');
    body.className = 'mxt-comic-body';
    shadow.append(head, bar, body);

    close.addEventListener('click', () => {
      /* 关面板不等于「什么都没发生」：批量任务必须停，否则后台还在烧额度，
         而且下一张翻完还会把面板弹回来。 */
      stopBatch('面板已关闭，批量翻译已停止');
      h.classList.remove('mxt-comic-open');
      clearOverlays();
      resetUiState();
    });
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    fontDown.addEventListener('click', () => bumpFont(-2));
    fontUp.addEventListener('click', () => bumpFont(2));
    autoFitBtn.addEventListener('click', () => autoFitSelected());
    toggleBtn.addEventListener('click', () => {
      state.showOrig = !state.showOrig;
      toggleBtn.textContent = state.showOrig ? '译图' : '原图';
      toggleBtn.style.background = state.showOrig ? 'rgba(255,159,10,0.35)' : '';
      applyViewToggle();
    });
    undoBtn.addEventListener('click', () => undoLast());
    exportBtn.addEventListener('click', async () => {
      if (!state.currentImg) return;
      const r = await exportResult(state.currentImg, state.items);
      if (!r.ok) {
        const p = host().shadowRoot.querySelector('.mxt-comic-prog');
        if (p) p.textContent = r.error;
      }
    });
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

  /* 进度信息一律写进这一行，**不再清空译文列表**。
     以前 setMsg 是「body.textContent = '' 再插一行」，于是批量翻译每翻完一张，
     列表就闪没、正在看的那条也跟着消失——用户既看不到总进度，也没法回头重试。 */
  function setMsg(text) {
    const h = host();
    h.classList.add('mxt-comic-open');
    const body = h.shadowRoot.querySelector('.mxt-comic-body');
    if (!body) return;
    let d = body.querySelector('.mxt-comic-msg');
    if (!d) {
      d = document.createElement('div');
      d.className = 'mxt-comic-msg';
      body.insertBefore(d, body.firstChild);
    }
    d.textContent = text || '';
    d.style.display = text ? '' : 'none';
    updateBar();
  }

  /* ---------------- 进度：阶段 + 计时 + 批量计数 ---------------- */

  let heartbeat = null;

  /** 进入一个阶段：进度条带「阶段名 + 已用时」，长时间没响应也看得出还在动 */
  function beginPhase(label) {
    state.phase = { label, t0: Date.now() };
    updateBar();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (!state.phase) {
        clearInterval(heartbeat);
        heartbeat = null;
        return;
      }
      updateBar();
    }, 1000);
  }

  function endPhase() {
    state.phase = null;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    updateBar();
  }

  function updateBar() {
    const h = document.getElementById(HOST_ID);
    if (!h || !h.shadowRoot) return;
    /* 面板关着就不写：异步回调不该把面板「弹回来」 */
    if (!h.classList.contains('mxt-comic-open')) return;
    const prog = h.shadowRoot.querySelector('.mxt-comic-prog');
    if (!prog) return;
    const total = state.images.length;
    if (!total) {
      prog.textContent = '';
      return;
    }
    const bits = [`第 ${state.index + 1} / ${total} 张`];
    const p = state.progress;
    if (p) bits.push(`进度 ${p.handled}/${p.total} · 成功 ${p.ok} · 失败 ${p.failed}`);
    if (state.phase) {
      const sec = Math.max(0, Math.round((Date.now() - state.phase.t0) / 1000));
      bits.push(`${state.phase.label} ${sec}s`);
    }
    prog.textContent = bits.join(' · ');
  }

  function renderItems(items, img) {
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
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'mxt-comic-row';
      row.dataset.idx = String(idx);
      if (it.text) {
        const o = document.createElement('div');
        o.className = 'mxt-comic-orig';
        o.textContent = it.text;
        row.appendChild(o);
      }
      const z = document.createElement('div');
      z.className = 'mxt-comic-zh';
      if (it.zh) {
        z.textContent = it.zh;
      } else {
        z.textContent = '（这条没翻出来）';
        row.classList.add('mxt-comic-row-failed');
      }
      row.appendChild(z);

      /* 逐条重试：整页重翻很贵，模型只漏一条时没必要重来。
         有框就只把那一小块送去识别；没框只能整页重来，按钮上写清楚。 */
      const retry = document.createElement('button');
      retry.className = 'mxt-comic-retry';
      retry.textContent = '重试';
      retry.title = it.box ? '只重试这一条' : '这条没有位置信息，只能整页重翻';
      retry.addEventListener('click', ev => {
        ev.stopPropagation();
        retryItem(img, items, idx);
      });
      row.appendChild(retry);

      row.addEventListener('click', () => focusOverlay(idx));
      body.appendChild(row);
    });
  }

  /** 点列表里的一条 → 选中图上对应的译文并滚过去 */
  function focusOverlay(idx) {
    const img = state.currentImg || state.images[state.index];
    const wrap = img && img.parentElement;
    if (!wrap) return;
    const d = wrap.querySelector(`.${OVERLAY_CLASS}[data-idx="${idx}"]`);
    if (!d) return;
    selectOverlay(d);
    try {
      d.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {
      /* 忽略 */
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
    /* 覆盖层没了，这些指针必须一起失效，否则选中框、撤销目标还指着一个已删除的节点 */
    selectedOverlay = null;
    state.selectedItem = -1;
    state.layouts = [];
  }

  /* ---------------- 人工调整：快照 / 撤销 ---------------- */

  /** 每次改动前先记一份原始值。用户调错了能退回去，这是「可恢复」的地基。 */
  function snapshot(img, it) {
    if (!img || !it) return;
    const items = state.items || [];
    state.undo.push({
      img,
      idx: items.indexOf(it),
      box: Array.isArray(it.box) ? it.box.slice() : null,
      zh: it.zh || '',
      manualFont: it.manualFont || 0
    });
    if (state.undo.length > 50) state.undo.shift();
  }

  function undoLast() {
    const snap = state.undo.pop();
    if (!snap) {
      setMsg('没有可撤销的调整');
      return;
    }
    const rec = state.done.get(snap.img);
    const items = (rec && rec.items) || state.items || [];
    const it = items[snap.idx];
    if (!it) {
      setMsg('这一条的记录已经不在了');
      return;
    }
    it.box = snap.box;
    it.zh = snap.zh;
    if (snap.manualFont) it.manualFont = snap.manualFont;
    else delete it.manualFont;
    setMsg('已撤销上一次调整');
    state.index = Math.max(0, state.images.indexOf(snap.img));
    updateBar();
    renderItems(items, snap.img);
    applyToImage(snap.img, items, rec && rec.drawable);
  }

  /* 原图 / 译图：只切覆盖层的可见性，不动数据、不重新请求。
     译错位置时先切回原图核对，再切回来调——不用重新翻译一遍。 */
  function applyViewToggle() {
    const img = state.currentImg || state.images[state.index];
    const wrap = img && img.parentElement;
    if (!wrap) return;
    for (const d of wrap.querySelectorAll('.' + OVERLAY_CLASS)) {
      d.style.visibility = state.showOrig ? 'hidden' : '';
    }
  }

  function resetUiState() {
    state.progress = null;
    state.phase = null;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    state.items = [];
    state.currentImg = null;
    state.layouts = [];
    state.selectedItem = -1;
    state.showOrig = false;
    selectedOverlay = null;
    const h = document.getElementById(HOST_ID);
    const btn = h && h.shadowRoot ? h.shadowRoot.querySelector('.mxt-comic-toggle') : null;
    if (btn) {
      btn.textContent = '原图';
      btn.style.background = '';
    }
    updateBar();
  }

  /** 停止批量任务（关面板、清空、按钮都要用同一套收尾） */
  function stopBatch(reason) {
    const wasRunning = !!(batch.running || batch.stop);
    batch.stop = true;
    if (wasRunning) {
      const h = document.getElementById(HOST_ID);
      const btn = h && h.shadowRoot ? h.shadowRoot.querySelector('.mxt-comic-all') : null;
      if (btn) btn.textContent = '全部翻译';
      if (reason) setMsg(reason);
      endPhase();
    }
    return wasRunning;
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
    let maxH = Math.max(16, boxH * SAFE_H);
    const top = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(maxW / 2), Math.floor(maxH / 2)));
    for (let size = top; size >= MIN_FONT; size--) {
      const lines = wrapText(text, size, maxW);
      if (lines.length * size * LINE_H <= maxH) return { size, lines: lines.length, overflow: false };
    }
    /* 实在装不下时先别急着标「溢出」：把可用高度放宽到框的 1.35 倍再试一轮。
       真实样本里窄条气泡装一句长译文差的就是几个像素，硬压到 10px 三行
       既难读也仍然算溢出——稍微压出气泡一点点，换回能读的字号更值。 */
    maxH = Math.max(16, boxH * 1.35);
    for (let size = Math.min(MIN_FONT + 8, top); size >= MIN_FONT; size--) {
      const lines = wrapText(text, size, maxW);
      if (lines.length * size * LINE_H <= maxH) {
        return { size, lines: lines.length, overflow: false, expanded: true };
      }
    }
    return { size: MIN_FONT, lines: wrapText(text, MIN_FONT, maxW).length, overflow: true };
  }

  /** 竖排：按「每列几个字」推列数，再从大字号往下试 */
  function layoutV(text, boxW, boxH) {
    const maxH = Math.max(16, boxH * SAFE_H);
    const maxW0 = Math.max(16, boxW * SAFE_W);
    const count = Array.from(String(text).replace(/\s+/g, '')).length;
    if (!count) return { size: MIN_FONT, lines: 0, overflow: true };
    for (let size = Math.min(MAX_FONT, Math.floor(maxH / 2)); size >= MIN_FONT; size--) {
      const perCol = Math.max(1, Math.floor(maxH / (size * LINE_H)));
      const cols = Math.ceil(count / perCol);
      if (cols * size * LINE_H <= maxW0) return { size, lines: cols, overflow: false };
    }
    /* 同 layoutH：竖排也允许宽度多用一截，别把竖排字压成一条线 */
    const maxW = Math.max(maxW0, boxW * 1.35);
    for (let size = Math.min(MAX_FONT, Math.floor(maxH / 2)); size >= MIN_FONT; size--) {
      const perCol = Math.max(1, Math.floor(maxH / (size * LINE_H)));
      const cols = Math.ceil(count / perCol);
      if (cols * size * LINE_H <= maxW) {
        return { size, lines: cols, overflow: false, expanded: true };
      }
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
      /* A+ / A- 的结果存进数据（it.manualFont），切图、重排、重画都还在。
         以前只写 d.dataset.manualFont，全文件没有读它的地方，等于调完就丢。 */
      const fitSize = it.manualFont ? Math.max(8, Math.min(72, it.manualFont)) : fit.size;

      const d = document.createElement('div');
      d.className = OVERLAY_CLASS;
      d.dataset.zh = it.zh;
      d.dataset.src = it.text || '';
      d.dataset.box = it.box.join(',');
      d.dataset.idx = String(idx);

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
        font: `700 ${fitSize}px/${LINE_H} "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`,
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

      /* 单击只做「选中」，改字是双击、看原文是右键 —— 一个手势只干一件事，
         免得用户想选中的时候字被换成原文。 */
      d.addEventListener('click', ev => {
        ev.stopPropagation();
        selectOverlay(d);
      });
      attachCorrection(d, span, it, img);

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
        /* space 说明这套数字的量纲：css = 屏幕像素（浮层），image = 原图像素（擦字重绘）。
           导出必须知道用哪套，否则会把 14px 当成原图上的 14px 画出去。 */
        space: 'css',
        fontSize: fitSize,
        lines: fit.lines,
        vertical,
        overflow: !!fit.overflow,
        text: it.text || '',
        zh: it.zh
      });

      wrap.appendChild(d);
    });

    state.currentImg = img;
    state.items = items;
    attachRebubble(img, items);

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
    if (!src) return { fontSize: minFont, lines: [''], height: 0, shrunk: false, clamped: false, overflow: false };

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

    let clamped = false;
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : last;
      shrunk = true;
      clamped = true;
    }

    const widthOver = lines.some(l => estimateTextWidth(l, fontSize) > w * 1.02);
    const heightOver = lines.length * fontSize * lineHeight > h * 1.02;
    return {
      fontSize,
      lines,
      height: lines.length * fontSize * lineHeight,
      shrunk,
      clamped,
      overflow: clamped || widthOver || heightOver
    };
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
  /* ---------------- 人工修正 ----------------
     自动排版一直会有它做不对的地方：气泡形状怪、译文长、拟声字要留在原位。
     这里给用户最小的手动手段：选中、双击改字、拖动位置、调字号、重设气泡区域、导出。
     原则：**只在用户主动操作时改页面，绝不自动覆盖**。 */
  let selectedOverlay = null;

  function selectOverlay(d) {
    if (selectedOverlay && selectedOverlay !== d) {
      selectedOverlay.style.boxShadow = 'none';
    }
    selectedOverlay = d;
    if (d) {
      d.style.boxShadow = '0 0 0 2px #0a84ff inset';
      state.selectedItem = Number(d.dataset.idx);
    } else {
      state.selectedItem = -1;
    }
  }

  /* 改完字或改完大小重新排版一次，样式和溢出提示都跟着更新。 */
  function refitOverlay(d, span, it) {
    const w = parseFloat(d.style.width) || 18;
    const h = parseFloat(d.style.height) || 14;
    const vertical = isVerticalBox(w, h, it.zh);
    const fit = vertical ? layoutV(it.zh, w, h) : layoutH(it.zh, w, h);
    d.style.font = `700 ${fit.size}px/${LINE_H} "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    d.style.outline = fit.overflow ? '2px dashed #ff9f0a' : 'none';
    d.title = fit.overflow
      ? `译文太长，气泡装不下（${fit.lines} 行 / ${fit.size}px）。双击改短，或拖到合适位置。`
      : '双击改文字 · 拖动移动 · Alt+拖动重设气泡区域 · 右键看原文';
    d.dataset.overflow = fit.overflow ? '1' : '';
    span.textContent = it.zh;
    return fit;
  }

  /* onChange：改动落定后回调（'move' / 'text'）。
     浮层版里 DOM 自己就是显示结果，可以不传；擦字版里字是画在图上的，
     必须重新落一次像素，否则「拖动没反应」「改字不变」。 */
  function attachCorrection(d, span, it, img, onChange) {
    let dragging = null;

    d.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (span.isContentEditable && document.activeElement === span) return;
      selectOverlay(d);
      dragging = {
        x: ev.clientX,
        y: ev.clientY,
        left: parseFloat(d.style.left) || 0,
        top: parseFloat(d.style.top) || 0,
        moved: false
      };
      d.setPointerCapture?.(ev.pointerId);
    });

    d.addEventListener('pointermove', ev => {
      if (!dragging) return;
      const dx = ev.clientX - dragging.x;
      const dy = ev.clientY - dragging.y;
      if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!dragging.moved) snapshot(img, it);
      dragging.moved = true;
      d.style.left = `${dragging.left + dx}px`;
      d.style.top = `${dragging.top + dy}px`;
    });

    d.addEventListener('pointerup', () => {
      if (!dragging) return;
      const moved = dragging.moved;
      dragging = null;
      if (!moved) return;
      /* 位置同步回百分比：擦字重绘、缩放、导出都按这个数据来 */
      const box = pixelsToPercent(d, img);
      if (box) {
        it.box = box;
        d.dataset.box = box.join(',');
        const rec = state.done.get(img);
        if (rec) rec.items = state.items || rec.items;
        if (typeof onChange === 'function') onChange('move');
      }
    });

    /* 双击改字：用户自己决定改短还是保留 */
    d.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      ev.preventDefault();
      if (!span) return;
      /* 擦字版里这层是透明的抓取框：改字时临时显形，改完再隐回去 */
      if (d.dataset.hit === '1') {
        d.style.background = 'rgba(255,255,255,0.96)';
        span.style.opacity = '1';
      }
      span.contentEditable = 'true';
      span.focus();
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const finish = (commit) => {
        span.contentEditable = 'false';
        const next = span.textContent.replace(/\s+/g, ' ').trim();
        let changed = false;
        if (commit && next && next !== it.zh) {
          snapshot(img, it);
          it.zh = next;
          d.dataset.zh = next;
          changed = true;
        }
        refitOverlay(d, span, it);
        restoreHitLook(d);
        const rec = state.done.get(img) || state.done.get(state.currentImg);
        if (rec) rec.items = state.items || rec.items;
        if (changed && typeof onChange === 'function') onChange('text');
      };

      const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          span.removeEventListener('keydown', onKey);
          span.blur();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          span.removeEventListener('keydown', onKey);
          span.textContent = d.dataset.zh || it.zh;
          span.blur();
          finish(false);
        }
      };
      span.addEventListener('keydown', onKey);
      span.addEventListener('blur', () => finish(true), { once: true });
    });

    /* 右键看原文 —— 单击已经被「选中」占用了 */
    d.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const showing = d.dataset.showing === '1';
      d.dataset.showing = showing ? '' : '1';
      span.textContent = showing ? (d.dataset.zh || it.zh) : (d.dataset.src || '（没拿到原文）');
      d.style.background = showing ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.6)';
      d.style.border = showing ? 'none' : '1px dashed rgba(0,0,0,0.45)';
    });
  }

  function bumpFont(delta) {
    const d = selectedOverlay;
    if (!d) return;
    const m = String(d.style.font || '').match(/([\d.]+)px/);
    const cur = m ? parseFloat(m[1]) : 16;
    const next = Math.max(8, Math.min(72, cur + delta));
    d.style.font = `700 ${next}px/${LINE_H} "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    d.dataset.manualFont = String(next);
    /* 字号要落到数据里，否则切一张图回来就回到自动值了 */
    const idx = Number(d.dataset.idx);
    const it = (state.items || []).find((v, i) => i === idx);
    if (it) {
      snapshot(state.currentImg, it);
      it.manualFont = next;
      const rec = state.done.get(state.currentImg);
      if (rec) rec.items = state.items;
    }
    if (d.dataset.hit === '1') repaintCurrent();
  }

  function autoFitSelected() {
    const d = selectedOverlay;
    if (!d) return;
    const idx = Number(d.dataset.idx);
    const it = (state.items || []).find((v, i) => i === idx);
    const span = d.querySelector('span');
    if (!it || !span) return;
    delete d.dataset.manualFont;
    if (it.manualFont) {
      snapshot(state.currentImg, it);
      delete it.manualFont;
      const rec = state.done.get(state.currentImg);
      if (rec) rec.items = state.items;
    }
    span.textContent = it.zh;
    refitOverlay(d, span, it);
    if (d.dataset.hit === '1') repaintCurrent();
  }

  function repaintCurrent() {
    const img = state.currentImg || state.images[state.index];
    const rec = img && state.done.get(img);
    if (!img || !rec) return;
    applyToImage(img, rec.items, rec.drawable);
  }

  /* 把 DOM 上的像素位置换回百分比，写回 it.box。
     纵坐标只能用高度做基准、横坐标只能用宽度 —— 混用就是把像素当百分比那一类错。 */
  function pixelsToPercent(d, imgEl) {
    const host = d.parentElement;
    if (!host || !imgEl) return null;
    const r = imgEl.getBoundingClientRect();
    const wr = host.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const left = parseFloat(d.style.left) || 0;
    const top = parseFloat(d.style.top) || 0;
    const w = parseFloat(d.style.width) || 0;
    const h = parseFloat(d.style.height) || 0;
    const toX = v => ((v - (r.left - wr.left)) / r.width) * 100;
    const toY = v => ((v - (r.top - wr.top)) / r.height) * 100;
    const clamp = v => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
    return [clamp(toX(left)), clamp(toY(top)), clamp(toX(left + w)), clamp(toY(top + h))];
  }

  /* Alt + 拖动：在图片上画一个框，作为选中那条的新气泡区域。 */
  function attachRebubble(img, items) {
    if (img.dataset.mxtRebubble) return;
    img.dataset.mxtRebubble = '1';
    let start = null;
    const ghost = document.createElement('div');
    Object.assign(ghost.style, {
      position: 'absolute', border: '2px dashed #0a84ff', background: 'rgba(10,132,255,0.12)',
      pointerEvents: 'none', zIndex: '2147483001', display: 'none', borderRadius: '4px'
    });
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    wrap.appendChild(ghost);

    img.addEventListener('pointerdown', ev => {
      if (!ev.altKey || state.selectedItem < 0) return;
      ev.preventDefault();
      const r = img.getBoundingClientRect();
      start = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      ghost.style.display = 'block';
      ghost.style.left = `${start.x}px`;
      ghost.style.top = `${start.y}px`;
      ghost.style.width = '0px';
      ghost.style.height = '0px';
      ghost.dataset.rel = `${r.left - wrap.getBoundingClientRect().left},${r.top - wrap.getBoundingClientRect().top}`;
    });

    img.addEventListener('pointermove', ev => {
      if (!start) return;
      const r = img.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      const rel = (ghost.dataset.rel || '0,0').split(',').map(Number);
      ghost.style.left = `${rel[0] + Math.min(start.x, x)}px`;
      ghost.style.top = `${rel[1] + Math.min(start.y, y)}px`;
      ghost.style.width = `${Math.abs(x - start.x)}px`;
      ghost.style.height = `${Math.abs(y - start.y)}px`;
    });

    img.addEventListener('pointerup', ev => {
      if (!start) return;
      const r = img.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      const box = [
        Math.min(start.x, x) / r.width * 100,
        Math.min(start.y, y) / r.height * 100,
        Math.max(start.x, x) / r.width * 100,
        Math.max(start.y, y) / r.height * 100
      ].map(v => Math.max(0, Math.min(100, Math.round(v * 10) / 10)));
      start = null;
      ghost.style.display = 'none';
      if (box[2] - box[0] < 1 || box[3] - box[1] < 1) return;
      const it = (items || []).find((v, i) => i === state.selectedItem);
      if (!it) return;
      snapshot(img, it);
      it.box = box;
      const rec = state.done.get(img);
      if (rec) rec.items = items;
      applyToImage(img, items, rec && rec.drawable);
    });
  }

  /* 导出：把当前这张图连同译文一起存成 PNG。
     擦字版的成品本来就是「擦完+画好字」的位图，直接存它最忠实；
     浮层版没有成品图，按 layouts 用矢量补画。
     这里原来有两个真 bug：l.lines 是「行数」不是行文本（永远只画一行），
     描边写成同坐标先白后黑两次 fillText（白字被黑字整个盖住）。 */
  async function exportResult(img, items) {
    const rec = state.done.get(img);
    if (rec && rec.compositeUrl) {
      const a0 = document.createElement('a');
      a0.href = rec.compositeUrl;
      a0.download = `mxt-comic-${Date.now()}.png`;
      a0.click();
      return { ok: true, url: rec.compositeUrl };
    }
    const src = (rec && rec.drawable) || img;
    const c = document.createElement('canvas');
    c.width = src.naturalWidth || src.width;
    c.height = src.naturalHeight || src.height;
    const ctx = c.getContext('2d');
    try {
      ctx.drawImage(src, 0, 0, c.width, c.height);
    } catch {
      return { ok: false, error: '这张图跨域，读不到像素，导不出来。可以换成浮层版后截图。' };
    }
    if (!state.layouts.length) return { ok: false, error: '还没有译文可以导出。' };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cssScale = c.width / Math.max(1, img.getBoundingClientRect().width || c.width);
    for (const l of state.layouts) {
      const area = l.area || null;
      const imageSpace = l.space === 'image' && area;
      let cx;
      let cy;
      let size;
      let maxW;
      if (imageSpace) {
        cx = (area.x1 + area.x2) / 2;
        cy = (area.y1 + area.y2) / 2;
        size = Math.max(8, l.fontSize);
        maxW = Math.max(20, area.x2 - area.x1);
      } else {
        const [x1, y1, x2, y2] = l.box;
        const sx = c.width / 100;
        const sy = c.height / 100;
        cx = ((x1 + x2) / 2) * sx;
        cy = ((y1 + y2) / 2) * sy;
        size = Math.max(8, l.fontSize * cssScale);
        maxW = Math.max(20, ((x2 - x1) / 100) * c.width);
      }
      ctx.font = `700 ${size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
      /* layouts.lines 在擦字版里是行文本数组，在浮层版里是行数——两种都要认 */
      const lines = Array.isArray(l.lines) ? l.lines : wrapText(l.zh || '', size, maxW * SAFE_W);
      const total = lines.length * size * LINE_H;
      let y = cy - total / 2 + size / 2;
      ctx.lineWidth = Math.max(2, size / 7);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineJoin = 'round';
      for (const line of lines) {
        ctx.strokeText(line, cx, y);
        ctx.fillStyle = '#111';
        ctx.fillText(line, cx, y);
        y += size * LINE_H;
      }
    }
    const url = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `mxt-comic-${Date.now()}.png`;
    a.click();
    return { ok: true, url };
  }

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
      /* 这里传的必须是 {x1,y1,x2,y2} —— adaptivePad 按这个形状算。
         之前传的是 {box:[...]}，取到 undefined，减出来 NaN，
         矩形兜底的坐标全成了 NaN（真实漫画里 5 条有 4 条走这条路径，
         等于擦字和排版同时失效）。 */
      const pad = adaptivePad({ x1: bx, y1: by, x2: bx + bw, y2: by + bh }, buf.width, buf.height);
      return {
        kind: 'rect',
        reg: null,
        rect: {
          x1: Math.max(0, Math.round((bx / 100) * buf.width) - (Number.isFinite(pad.x) ? pad.x : 0)),
          y1: Math.max(0, Math.round((by / 100) * buf.height) - (Number.isFinite(pad.y) ? pad.y : 0)),
          x2: Math.min(buf.width, Math.round(((bx + bw) / 100) * buf.width) + (Number.isFinite(pad.x) ? pad.x : 0)),
          y2: Math.min(buf.height, Math.round(((by + bh) / 100) * buf.height) + (Number.isFinite(pad.y) ? pad.y : 0))
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

    /* 把这一轮的排版结果交出去：导出要用（原图像素），调试面板要用，
       人工调整重画时也要靠它对齐。space='image' 表示这里的数字都是原图像素。 */
    const layouts = boxes.map((it, i) => ({
      id: i,
      box: it.box,
      space: 'image',
      area: areas[i],
      fontSize: fits[i].fontSize,
      lines: fits[i].lines.slice(),
      vertical: false,
      overflow: !!fits[i].overflow,
      text: it.text || '',
      zh: it.zh
    }));

    try {
      return { url: canvas.toDataURL('image/jpeg', 0.92), bgs, layouts };
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
  const hitOwners = [];

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
    /* 抓取框是按百分比记位置的，缩放/响应式变化后必须重算，
       否则图缩到一半，可点区域还停在原位——比没有更糟。 */
    for (let i = hitOwners.length - 1; i >= 0; i--) {
      const pair = hitOwners[i];
      if (!pair.el.isConnected) {
        hitOwners.splice(i, 1);
        continue;
      }
      positionHitbox(pair.img, pair.el);
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

  /* ---------------- 擦字版的人工调整入口 ---------------- */

  /* 擦字版把译文画进了图片像素，图上没有任何可抓的节点——
     于是「手动调整」这个功能在默认模式下彻底不可达（拖动、改字、重设框全落空）。
     这里按同样的框位铺一层透明抓取框：本身不显示文字，只接收手势；
     手势落定后回调 repaintCurrent() 把像素重画一遍。 */
  function positionHitbox(img, d) {
    const wrap = img.parentElement;
    if (!wrap || !d.isConnected) return;
    const r = img.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const [x1, y1, x2, y2] = String(d.dataset.box || '')
      .split(',')
      .map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    Object.assign(d.style, {
      left: `${(Math.min(x1, x2) / 100) * r.width + r.left - wr.left}px`,
      top: `${(Math.min(y1, y2) / 100) * r.height + r.top - wr.top}px`,
      width: `${Math.max(18, (Math.abs(x2 - x1) / 100) * r.width)}px`,
      height: `${Math.max(14, (Math.abs(y2 - y1) / 100) * r.height)}px`
    });
  }

  function restoreHitLook(d) {
    if (!d || d.dataset.hit !== '1') return;
    d.style.background = 'transparent';
    const span = d.querySelector('span');
    if (span) span.style.opacity = '0';
  }

  function paintHitboxes(img, items) {
    for (let i = hitOwners.length - 1; i >= 0; i--) {
      if (!hitOwners[i].el.isConnected) hitOwners.splice(i, 1);
    }
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    items.forEach((it, idx) => {
      if (!it.box || it.box.length !== 4 || !it.zh) return;
      const [x1, y1, x2, y2] = it.box.map(Number);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return;

      const d = document.createElement('div');
      d.className = OVERLAY_CLASS;
      d.dataset.hit = '1';
      d.dataset.zh = it.zh;
      d.dataset.src = it.text || '';
      d.dataset.box = it.box.join(',');
      d.dataset.idx = String(idx);
      Object.assign(d.style, {
        position: 'absolute',
        boxSizing: 'border-box',
        border: '1px dashed rgba(10,132,255,0.45)',
        borderRadius: '6px',
        background: 'transparent',
        pointerEvents: 'auto',
        cursor: 'move',
        zIndex: '2147483000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1px',
        overflow: 'hidden'
      });

      const span = document.createElement('span');
      span.textContent = it.zh;
      Object.assign(span.style, {
        opacity: '0',
        maxWidth: '100%',
        maxHeight: '100%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: '#111',
        font: `700 14px/${LINE_H} "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
      });
      d.appendChild(span);
      d.title = '拖动调整位置 · 双击改文字 · Alt+拖动重设气泡区域 · 右键看原文';

      d.addEventListener('click', ev => {
        ev.stopPropagation();
        selectOverlay(d);
      });
      attachCorrection(d, span, it, img, () => repaintCurrent());

      wrap.appendChild(d);
      hitOwners.push({ img, el: d });
      positionHitbox(img, d);
    });
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

  /** 识别一张图，不碰界面，方便批量复用。onPhase 用来把当前阶段报给界面。 */
  async function recognise(img, onPhase) {
    const step = label => {
      if (typeof onPhase === 'function') onPhase(label);
    };
    step('读图');
    const drawable = await drawableImage(img);
    step('转换图片');
    const b64 = await toBase64(drawable);
    if (!b64) return { ok: false, error: '这张图读不出来（跨域，且后台也取不到原图）' };
    step('模型识别');
    let res = null;
    try {
      res = await withTimeout(
        chrome.runtime.sendMessage({
          type: 'mxt:translateImage',
          image: b64.data,
          mediaType: b64.mediaType,
          /* 把原图尺寸带上：后台要靠它判断模型给的框是百分比还是像素 */
          width: drawable.naturalWidth || drawable.width,
          height: drawable.naturalHeight || drawable.height
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

  let translating = null;

  async function translateCurrent(force) {
    const img = state.images[state.index];
    if (!img) return;
    if (!force && state.done.has(img)) {
      /* 翻回翻过的一张时重画。这里以前写死 paintOverlays，
         等于每次切换图片都退回浮层——擦字版只在第一次翻译时出现过一次。 */
      const rec = state.done.get(img);
      renderItems(rec.items, img);
      applyToImage(img, rec.items, rec.drawable);
      return;
    }
    /* 连点「下一张」不要并发：上一张还没回来就发下一张，
       谁后回来谁覆盖，用户看到的是「翻了两张，只出来一张」。 */
    if (translating) {
      setMsg('上一张还在翻译，稍等一下再翻');
      return;
    }
    translating = img;
    beginPhase('读图');
    setMsg('正在翻译这一张…');
    try {
      const r = await recognise(img, label => beginPhase(label));
      if (!r.ok) {
        setMsg(`翻译失败：${r.error}。修好之后点「重翻本张」或逐条重试。`);
        return;
      }
      /* drawable 要一起存：它是后台取回来的同源副本，重画擦字版时还得用它 */
      state.done.set(img, { items: r.items, at: Date.now(), drawable: r.drawable });
      beginPhase('擦字排版');
      renderItems(r.items, img);
      applyToImage(img, r.items, r.drawable);
    } finally {
      translating = null;
      endPhase();
      updateBar();
    }
  }

  /* ---------------- 单条重试 ---------------- */

  /** 把一条文字所在的区域裁出来，连坐标映射一起返回（映射回整页用） */
  async function cropForItem(drawable, box) {
    const W = drawable.naturalWidth || drawable.width;
    const H = drawable.naturalHeight || drawable.height;
    const [x1, y1, x2, y2] = box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite) || !W || !H) return null;
    const padX = Math.max(2, (Math.abs(x2 - x1) || 4) * 0.4);
    const padY = Math.max(2, (Math.abs(y2 - y1) || 4) * 0.4);
    const map = {
      x1: Math.max(0, Math.min(x1, x2) - padX),
      y1: Math.max(0, Math.min(y1, y2) - padY),
      x2: Math.min(100, Math.max(x1, x2) + padX),
      y2: Math.min(100, Math.max(y1, y2) + padY)
    };
    const sx = Math.round((map.x1 / 100) * W);
    const sy = Math.round((map.y1 / 100) * H);
    const sw = Math.round(((map.x2 - map.x1) / 100) * W);
    const sh = Math.round(((map.y2 - map.y1) / 100) * H);
    if (sw < 16 || sh < 16) return null;
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    try {
      c.getContext('2d').drawImage(drawable, sx, sy, sw, sh, 0, 0, sw, sh);
    } catch (_) {
      return null;
    }
    let data = '';
    try {
      data = c.toDataURL('image/jpeg', 0.92).split(',')[1] || '';
    } catch (_) {
      return null;
    }
    if (!data) return null;
    return { data, mediaType: 'image/jpeg', width: sw, height: sh, map };
  }

  /* 整张重翻（识别失败、或某条根本没有位置信息时才走这条） */
  async function retryImage(img) {
    translating = img;
    beginPhase('重翻本张');
    setMsg('正在重翻这一张…');
    try {
      const r = await recognise(img, label => beginPhase(label));
      if (!r.ok) {
        setMsg(`重翻失败：${r.error}`);
        return;
      }
      state.done.set(img, { items: r.items, at: Date.now(), drawable: r.drawable });
      beginPhase('擦字排版');
      renderItems(r.items, img);
      applyToImage(img, r.items, r.drawable);
    } finally {
      translating = null;
      endPhase();
      updateBar();
    }
  }

  /* 单条重试：整页重翻又慢又费额度，模型只漏一条时没必要重来。
     有框 → 只把那一小块裁出来送识别，再把框映射回整页；没框 → 整页重来。 */
  async function retryItem(img, items, idx) {
    const it = (items || [])[idx];
    if (!img || !it) return;
    if (!it.box) {
      await retryImage(img);
      return;
    }
    const rec = state.done.get(img);
    let drawable = rec && rec.drawable;
    if (!drawable) {
      drawable = await drawableImage(img);
      if (drawable && rec) rec.drawable = drawable;
    }
    if (!drawable) {
      setMsg('这张图读不出来，没法单独重试这一条');
      return;
    }
    beginPhase(`重试第 ${idx + 1} 条`);
    setMsg(`正在重试第 ${idx + 1} 条…`);
    try {
      const crop = await cropForItem(drawable, it.box);
      if (!crop) {
        setMsg('这一条的框太小，裁不出可识别的图');
        return;
      }
      const res = await withTimeout(
        chrome.runtime.sendMessage({
          type: 'mxt:translateImage',
          image: crop.data,
          mediaType: crop.mediaType,
          width: crop.width,
          height: crop.height
        }),
        REQUEST_TIMEOUT_MS,
        '重试'
      );
      if (!res || !res.ok) {
        setMsg(`重试失败：${(res && res.error) || '未知错误'}`);
        return;
      }
      const got = (res.items || []).find(v => v && v.zh);
      if (!got) {
        setMsg('重试没拿到译文，可以点「重翻本张」整页再来一次');
        return;
      }
      snapshot(img, it);
      it.zh = got.zh;
      if (!it.text && got.text) it.text = got.text;
      if (Array.isArray(got.box) && got.box.length === 4 && got.box.every(Number.isFinite)) {
        const [bx1, by1, bx2, by2] = got.box.map(Number);
        const m = crop.map;
        it.box = [
          m.x1 + (bx1 / 100) * (m.x2 - m.x1),
          m.y1 + (by1 / 100) * (m.y2 - m.y1),
          m.x1 + (bx2 / 100) * (m.x2 - m.x1),
          m.y1 + (by2 / 100) * (m.y2 - m.y1)
        ].map(v => Math.round(v * 10) / 10);
      }
      if (rec) rec.items = items;
      state.items = items;
      beginPhase('擦字排版');
      setMsg(`第 ${idx + 1} 条已更新`);
      renderItems(items, img);
      applyToImage(img, items, drawable);
    } catch (e) {
      setMsg(`重试失败：${(e && e.message) || e}`);
    } finally {
      endPhase();
      updateBar();
    }
  }

  const batch = { running: false, stop: false };

  /** 从当前张往后批量翻译；失败的跳过并计数，随时可停 */
  async function translateAll() {
    if (batch.running) {
      batch.stop = true;
      setMsg('正在停止…（已经发出去的请求要等它返回，不会再往下发）');
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
    let ok = 0;
    let failed = 0;
    let handled = 0;
    /* 进度必须是「看得见的三件事」：翻到第几张、成功几张、失败几张。
       以前每翻一张就把列表清掉重写，用户只能看到最后一句，也回不去重试。 */
    const paint = (phaseLabel) => {
      state.progress = { total: imgs.length, handled, ok, failed };
      if (phaseLabel) beginPhase(phaseLabel);
      setMsg(`批量翻译中：${handled} / ${imgs.length} 张，成功 ${ok}，失败 ${failed}`);
    };
    paint(`批量 1/${imgs.length}`);
    await runPool(
      imgs,
      BATCH_CONCURRENCY,
      async (img, i) => {
        if (batch.stop) return;
        paint(`批量 ${i + 1}/${imgs.length}`);
        let r = await recognise(img, label => beginPhase(`第 ${i + 1} 张 · ${label}`));
        if (!r.ok && !batch.stop) {
          /* 重试一次：多半是超时或上游偶发错误 */
          r = await recognise(img, label => beginPhase(`第 ${i + 1} 张 · 重试 ${label}`));
        }
        /* 点了停止之后回来的结果直接丢掉：用户已经说不要了，
           再写进缓存会让「停止」变成「没停」。 */
        if (batch.stop) return;
        handled += 1;
        if (r.ok) {
          ok += 1;
          /* drawable 要一起存：它是后台取回来的同源副本，重画擦字版时还得用它 */
          state.done.set(img, { items: r.items, at: Date.now(), drawable: r.drawable });
          applyToImage(img, r.items, r.drawable);
        } else {
          failed += 1;
        }
        paint(`批量 ${Math.min(i + 2, imgs.length)}/${imgs.length}`);
      },
      () => batch.stop
    );
    const stopped = batch.stop;
    batch.running = false;
    batch.stop = false;
    state.progress = null;
    endPhase();
    if (btn()) btn().textContent = '全部翻译';
    setMsg(
      stopped
        ? `已停止：处理 ${handled} / ${imgs.length} 张，成功 ${ok}，失败 ${failed}。失败的那几条可以逐条重试。`
        : `完成：共 ${imgs.length} 张，成功 ${ok} 张，失败 ${failed} 张`
    );
    /* 回到用户正在看的那张：批量过程中画面被后来的图接管过 */
    const cur = state.images[state.index];
    const rec = cur && state.done.get(cur);
    if (cur && rec) applyToImage(cur, rec.items, rec.drawable);
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
        /* 擦字版同样要有排版数据：导出、调试、人工调整都读它。
           以前这里不写 layouts，于是擦字版下点导出永远是「还没有译文可以导出」。 */
        state.layouts = r.layouts || [];
        paintHitboxes(img, items);
        const rec0 = state.done.get(img);
        if (rec0) {
          rec0.compositeUrl = r.url;
          rec0.items = items;
        }
        note('');
        state.currentImg = img;
        state.items = items;
        attachRebubble(img, items);
        applyViewToggle();

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
    state.currentImg = img;
    state.items = items;
    applyViewToggle();
  }

  function step(delta) {
    if (!state.images.length) return;
    if (translating) {
      setMsg('上一张还在翻译，稍等一下再翻');
      return;
    }
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
    resetUiState();
    state.images = findComics();
    state.index = 0;
    state.done.clear();
    state.undo.length = 0;
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
      /* 清空 = 连正在跑的批量一起收掉。只清 DOM 不置停止标志，
         后台会继续翻完剩下的图，页面上却什么也没有。 */
      stopBatch('');
      clearOverlays();
      resetUiState();
      const h = document.getElementById(HOST_ID);
      if (h) h.classList.remove('mxt-comic-open');
      sendResponse({ ok: true });
      return;
    }
  });
})();

