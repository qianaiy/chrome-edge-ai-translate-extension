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
    mode: 'inpaint' // 'inpaint' = 擦字重绘 | 'overlay' = 浮层覆盖
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
    const modeBtn = document.createElement('button');
    modeBtn.className = 'mxt-comic-mode';
    modeBtn.textContent = '擦字版';
    modeBtn.title = '切换：擦字重绘 / 浮层覆盖';
    bar.append(prog, modeBtn, again);

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
    modeBtn.addEventListener('click', () => {
      state.mode = state.mode === 'inpaint' ? 'overlay' : 'inpaint';
      modeBtn.textContent = state.mode === 'inpaint' ? '擦字版' : '浮层版';
      /* 切模式后把当前这张重画一遍 */
      const img = state.images[state.index];
      if (img) {
        const rec = state.done.get(img);
        clearOverlays();
        if (rec) applyToImage(img, rec.items);
      }
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

    /* 先算好每个框的像素范围（还没擦，用的是原始图）
       擦除范围 = 模型给的框 + 余量。
       擦的范围必须跟画译文的范围一致，否则会「擦了一半、画到别处」，
       英文原文还露在外面，译文又压在上面，两层字叠着。 */
    const rects = boxes.map(b => {
      const [ax1, ay1, ax2, ay2] = b.box.map(Number);
      const pad = adaptivePad(b, buf.width, buf.height);
      return {
        x1: Math.max(0, Math.round((Math.min(ax1, ax2) / 100) * buf.width) - pad.x),
        y1: Math.max(0, Math.round((Math.min(ay1, ay2) / 100) * buf.height) - pad.y),
        x2: Math.min(buf.width, Math.round((Math.max(ax1, ax2) / 100) * buf.width) + pad.x),
        y2: Math.min(buf.height, Math.round((Math.max(ay1, ay2) / 100) * buf.height) + pad.y)
      };
    });

    /* 译文排版要按「擦干净的那块区域」来算，而不是模型给的原始框。
       原始框可能没盖住整个字，擦过之后真正的空白区域更大，
       译文按大一点的区域排，才不会跟没擦干净的笔画打架。 */
    const fits = boxes.map((it, i) => {
      const r = rects[i];
      const w = Math.max(20, r.x2 - r.x1);
      const h = Math.max(14, r.y2 - r.y1);
      return fitText(it.zh, w, h);
    });

    /* 背景色必须在擦之前全估好：边擦边估的话，后一个框会拿
       「上一个框刚擦出来的白」当背景，越擦越白，整块图都漂移掉。 */
    const bgs = rects.map(r => estimateBackground(buf, r.x1, r.y1, r.x2, r.y2));

    /* 再逐个擦 */
    rects.forEach((r, i) => eraseBox(buf, r.x1, r.y1, r.x2, r.y2, bgs[i]));

    /* 把擦过的像素写回 canvas */
    ctx.putImageData(new ImageData(buf.data, buf.width, buf.height), 0, 0);

    /* 画译文：字号和行数上面已经算好了，直接用 */
    boxes.forEach((it, i) => {
      const r = rects[i];
      const bg = bgs[i] || { r: 255, g: 255, b: 255 };
      const h = Math.max(14, r.y2 - r.y1);
      const fit = fits[i];
      const fontSize = fit.fontSize;

      ctx.save();
      ctx.font = `600 ${fontSize}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';

      const cx = (r.x1 + r.x2) / 2;
      /* 整体垂直居中 */
      const totalH = fit.lines.length * fontSize * 1.22;
      let ty = r.y1 + Math.max(0, (h - totalH) / 2);

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

  /** 把擦好的图盖在原图上（原图保留在下面，撤销时能还原） */
  function paintInpainted(img, url) {
    for (const n of img.parentElement?.querySelectorAll?.('.' + OVERLAY_CLASS) || []) n.remove();
    const wrap = img.parentElement;
    if (!wrap) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    const d = document.createElement('img');
    d.className = OVERLAY_CLASS;
    d.src = url;
    d.alt = '';
    Object.assign(d.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      pointerEvents: 'none',
      zIndex: '2147483000'
    });
    wrap.appendChild(d);
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
    /* 漫画站的图多半在 CDN 上且没有 CORS 头，直接 drawImage 会污染画布。
       先让后台把字节取回来，在页面里造一份同源副本再画。 */
    const drawable = await drawableImage(img);
    const b64 = await toBase64(drawable);
    if (!b64) {
      setMsg('这张图读不出来（跨域，且后台也取不到原图）');
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
    applyToImage(img, items, drawable);
    updateBar();
  }

  /** 按当前模式把译文画到图上：擦字重绘，或者浮层覆盖 */
  function applyToImage(img, items, drawable) {
    if (state.mode === 'inpaint') {
      const r = renderTranslated(drawable || img, items);
      if (r) {
        paintInpainted(img, r.url);
        return;
      }
      /* 擦不动（跨域之类）就退回浮层，至少能看见译文 */
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

