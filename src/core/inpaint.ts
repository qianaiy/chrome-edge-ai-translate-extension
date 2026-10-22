/**
 * 漫画擦字与背景修复
 * ------------------------------------------------------------------
 * 模型给出的是「文字在图里的位置」（0-100 的百分比框）。拿到这些框就能：
 *   1. 擦掉原文字：把框里的像素抹掉（用周围的背景色填）
 *   2. 上面写译文
 *
 * 这里的算法是纯像素操作，不依赖浏览器 API，方便单测：
 *   - 背景色估计：取框周围一圈像素的中位色（比均值抗噪）
 *   - 擦除：把框内像素往背景色靠拢，带一点边缘羽化
 *   - 描边：文字下面加一圈深色描边，白底黑字也能看清
 *
 * 为什么不做真正的「AI 修复」（inpainting）：那要再调一次多模态接口，
 * 慢、贵、还不一定比纯色填充好。漫画的气泡框本身是纯色，
 * 周围的底色也大多均匀，纯色填充 + 轻微羽化的效果足够好。
 */

export interface Box {
  /** 0-100 的百分比坐标 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

/** 百分比框 → 像素框（带边距） */
export function boxToPixels(
  box: Box,
  width: number,
  height: number,
  pad: number | { x: number; y: number } = 0
): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const px = typeof pad === 'number' ? { x: pad, y: pad } : pad;
  const x1 = Math.round((Math.min(box.x1, box.x2) / 100) * width);
  const y1 = Math.round((Math.min(box.y1, box.y2) / 100) * height);
  const x2 = Math.round((Math.max(box.x1, box.x2) / 100) * width);
  const y2 = Math.round((Math.max(box.y1, box.y2) / 100) * height);
  return {
    x1: Math.max(0, x1 - px.x),
    y1: Math.max(0, y1 - px.y),
    x2: Math.min(width, x2 + px.x),
    y2: Math.min(height, y2 + px.y)
  };
}

/**
 * 按框的大小算一个「自适应余量」。
 *
 * 模型给的位置框往往不精确 —— 框偏了半个字高，擦的时候就会把字留下半截，
 * 看着像没擦干净。
 *
 * 垂直方向留得比水平方向多：模型框竖直方向最容易偏（上下差一点，
 * 就会露出字头或字尾），而水平方向偏一点只是多擦一点底色，无所谓。
 *
 * 垂直余量按「字高」算，而且要给足一整行：
 * 模型框偏一整个字高是很常见的，所以余量至少 0.5 倍字高，
 * 这样偏一整行也还能盖住。
 */
export function adaptivePad(box: Box, width: number, height: number): { x: number; y: number } {
  const w = (Math.abs(box.x2 - box.x1) / 100) * width;
  const h = (Math.abs(box.y2 - box.y1) / 100) * height;
  return {
    x: Math.round(Math.min(Math.max(w * 0.1, 4), 24)),
    y: Math.round(Math.min(Math.max(h * 0.5, 8), 44))
  };
}

/** 读某个像素 */
export function getPixel(buf: PixelBuffer, x: number, y: number): RGBA {
  const i = (y * buf.width + x) * 4;
  return {
    r: buf.data[i],
    g: buf.data[i + 1],
    b: buf.data[i + 2],
    a: buf.data[i + 3]
  };
}

/** 写某个像素 */
export function setPixel(buf: PixelBuffer, x: number, y: number, c: RGBA): void {
  const i = (y * buf.width + x) * 4;
  buf.data[i] = c.r;
  buf.data[i + 1] = c.g;
  buf.data[i + 2] = c.b;
  buf.data[i + 3] = c.a;
}

/**
 * 估计背景色：取框外一圈像素，按通道取中位数。
 * 用中位数而不是均值——均值会被残留的笔画和描边拉偏。
 */
export function estimateBackground(buf: PixelBuffer, x1: number, y1: number, x2: number, y2: number): RGBA {
  const band = Math.max(2, Math.round(Math.min(x2 - x1, y2 - y1) * 0.12));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const as: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
    const c = getPixel(buf, x, y);
    rs.push(c.r);
    gs.push(c.g);
    bs.push(c.b);
    as.push(c.a);
  };

  /* 框上下两条带 */
  for (let x = x1; x < x2; x++) {
    for (let d = 0; d < band; d++) {
      push(x, y1 - 1 - d);
      push(x, y2 + d);
    }
  }
  /* 框左右两条带 */
  for (let y = y1; y < y2; y++) {
    for (let d = 0; d < band; d++) {
      push(x1 - 1 - d, y);
      push(x2 + d, y);
    }
  }

  if (!rs.length) {
    /* 框贴着图边，外面没像素：退回用框内的中位色 */
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const c = getPixel(buf, x, y);
        rs.push(c.r);
        gs.push(c.g);
        bs.push(c.b);
        as.push(c.a);
      }
    }
  }
  if (!rs.length) return { r: 255, g: 255, b: 255, a: 255 };

  const med = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return { r: med(rs), g: med(gs), b: med(bs), a: med(as) };
}

/**
 * 擦掉一个框里的文字。
 *
 * 做法：把框内像素按「和背景色的差距」加权混合过去。
 * 差距越大（越是笔画）替换得越彻底，差距小的（本来就是底色）基本不动，
 * 这样能保住渐变和纹理，不会糊成一块死板的白。
 *
 * 强度要够大：抗锯齿的笔画边缘和背景只差一点点，
 * 混合系数太小就会留下「残影」，看着像没擦干净。
 */
export function eraseBox(
  buf: PixelBuffer,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bg: RGBA,
  strength = 1
): void {
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return;

  /* 边缘羽化：靠近框边的地方替换得轻一些，避免出现明显的矩形硬边 */
  const feather = Math.max(1, Math.round(Math.min(w, h) * 0.12));

  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) continue;

      const c = getPixel(buf, x, y);
      const diff =
        Math.abs(c.r - bg.r) + Math.abs(c.g - bg.g) + Math.abs(c.b - bg.b);

      /* 255*3 是「和背景完全不同」的上限 */
      const t = Math.min(1, diff / 255);
      /* 差得很少的才算底色；抗锯齿边缘要一起擦掉，不然留残影 */
      if (t < 0.015) continue;

      /* 到框边的距离决定羽化权重 */
      const edge = Math.min(x - x1, x2 - 1 - x, y - y1, y2 - 1 - y);
      const fw = edge >= feather ? 1 : edge / feather;
      /* 差得越多替换越彻底；底色附近只轻轻带一下。
         指数小于 1，让「差一点点」的抗锯齿边缘也擦得掉 —— 不然会留淡淡的残影。 */
      const k = Math.min(1, Math.pow(t, 0.45) * strength) * (0.7 + 0.3 * fw);

      setPixel(buf, x, y, {
        r: c.r + (bg.r - c.r) * k,
        g: c.g + (bg.g - c.g) * k,
        b: c.b + (bg.b - c.b) * k,
        a: c.a
      });
    }
  }
}

/** 颜色转 CSS */
export function toCss(c: RGBA): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/* ------------------------------------------------------------------ *
 * 译文排版
 * ------------------------------------------------------------------ */

/** 一个字在给定字号下大概多宽（相对字号的倍数）。
 *  中日文一个字约等于字号宽度；拉丁字母平均约 0.55 倍。
 *  纯估算，不依赖字体度量，但足够用来决定字号和要不要换行。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0)!;
    if (c < 0x41) continue; // 空格和标点不算宽度
    if (c >= 0x4e00 && c <= 0x9fff) units += 1; // 汉字
    else if (c >= 0x3040 && c <= 0x30ff) units += 1; // 假名
    else if (c >= 0xac00 && c <= 0xd7af) units += 1; // 谚文
    else units += 0.55; // 拉丁字母等
  }
  return units * fontSize;
}

export interface FitResult {
  /** 最终字号 */
  fontSize: number;
  /** 排成几行 */
  lines: string[];
  /** 估算的总高度 */
  height: number;
  /** 有没有缩到比最小字号还小 */
  shrunk: boolean;
}

/**
 * 把译文塞进原文字的框里。
 *
 * 漫画里常见的是「原文很短、译文很长」——
 * 英文一句话翻成中文可能长一倍多，塞不下就会溢出气泡，
 * 盖住旁边的画面。
 *
 * 做法：
 *   1. 先按框高算一个理想字号
 *   2. 试着放进框宽，放不下就缩字号
 *   3. 缩到最小字号还放不下，就按框宽折行，行数不能超过框高能容纳的
 *   4. 实在放不下就截断加省略号 —— 宁可少显示，也不能画到框外面去
 */
export function fitText(
  text: string,
  boxWidth: number,
  boxHeight: number,
  opts: { minFontSize?: number; maxFontSize?: number; lineHeight?: number; maxLines?: number } = {}
): FitResult {
  const minFont = Math.max(8, opts.minFontSize ?? 10);
  const maxFont = Math.max(minFont, opts.maxFontSize ?? 34);
  const lineHeight = opts.lineHeight ?? 1.22;
  const src = String(text || '').trim();

  if (!src) return { fontSize: minFont, lines: [''], height: 0, shrunk: false };

  const w = Math.max(1, boxWidth);
  const h = Math.max(1, boxHeight);
  const maxLines = Math.max(1, opts.maxLines ?? Math.max(1, Math.floor(h / (minFont * lineHeight))));

  /* 理想字号：跟着框高走 */
  let fontSize = Math.min(maxFont, Math.max(minFont, Math.round(h * 0.72)));

  const linesFor = (size: number): string[] => {
    const perLine = Math.max(1, Math.floor(w / size));
    /* 先按词断（拉丁文），断不了就按字断（中日文） */
    const out: string[] = [];
    let cur = '';
    let units = 0;
    const words = src.match(/\S+\s*|\s+/g) || [];
    const hasSpaces = /\s/.test(src);

    for (const word of words) {
      const wu = estimateTextWidth(word, 1) / 1; // 以「一个字号宽」为单位
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
    void hasSpaces;
    return out.length ? out : [''];
  };

  let lines = linesFor(fontSize);
  let shrunk = false;

  /* 放不下就缩字号 */
  while (
    fontSize > minFont &&
    (lines.length > maxLines || lines.reduce((a, l) => a + estimateTextWidth(l, fontSize), 0) > w * 1.02)
  ) {
    fontSize -= 1;
    lines = linesFor(fontSize);
    shrunk = true;
  }

  /* 还是太长：截断 */
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : last;
    shrunk = true;
  }

  return {
    fontSize,
    lines,
    height: lines.length * fontSize * lineHeight,
    shrunk
  };
}

/**
 * 给一个文字区域挑一个可读的前景色。
 * 背景深就用浅字，背景浅就用深字。
 */
export function readableColor(bg: RGBA): string {
  /* 感知亮度 */
  const lum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
  return lum > 0.55 ? '#111111' : '#ffffff';
}

/**
 * 一整张图擦掉所有文字框。
 *
 * 关键：所有框的背景色必须在**擦之前**全部估好。
 * 边擦边估的话，后一个框会拿「上一个框刚擦出来的白」当背景，
 * 越擦越白，最后整块图都被漂移掉了。
 *
 * @param boxes 每个文字的位置
 * @returns 擦完之后每个框的背景色（用来决定译文用什么字色）
 */
export function eraseAll(buf: PixelBuffer, boxes: Box[], pad?: number): RGBA[] {
  const rects = boxes.map(b => {
    const p = pad === undefined ? adaptivePad(b, buf.width, buf.height) : pad;
    return boxToPixels(b, buf.width, buf.height, p);
  });

  /* 先把背景色全估好（基于原始像素） */
  const bgs = rects.map(r => estimateBackground(buf, r.x1, r.y1, r.x2, r.y2));

  /* 再逐个擦 */
  rects.forEach((r, i) => eraseBox(buf, r.x1, r.y1, r.x2, r.y2, bgs[i]));

  return bgs;
}

/* ------------------------------------------------------------------ *
 * 气泡区域识别
 *
 * 模型只给「文字区」一个矩形。直接按矩形擦、按矩形排版有两个问题：
 *  - 矩形比气泡大时，会把气泡描边一起擦掉（画面缺一圈线）
 *  - 矩形比气泡小时，排版的可用区域算小了，长译文被过早缩字号
 *
 * 这里用像素找气泡本体：从文字框出发，在扩散出来的窗口里找「与气泡底色
 * 相近」的最大连通域，它的外接框就是气泡框，掩码就是可安全操作的区域。
 * 找不到（比如字直接压在画面上、根本没有气泡）就老实退回矩形，不假装识别到了。
 * ------------------------------------------------------------------ */

export interface BubbleRegion {
  /** 气泡外接框（像素） */
  rect: { x1: number; y1: number; x2: number; y2: number };
  /** 气泡内部掩码，1 = 属于气泡内部。长度 = 框宽 × 框高 */
  mask: Uint8Array;
  /** 掩码面积 / 外接框面积。椭圆气泡约 0.6-0.8，矩形接近 1 */
  fillRatio: number;
  /** 是否真的认出了气泡；false 时调用方应退回矩形处理 */
  isBubble: boolean;
  /** 排版安全区（像素）：按掩码逐行逐列收窄，比固定比例更贴合不规则气泡 */
  safe: { x1: number; y1: number; x2: number; y2: number };
  /** 气泡填充色 */
  bg: RGBA;
}

function colorDist(a: RGBA, b: RGBA): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function rectFallback(
  px: { x1: number; y1: number; x2: number; y2: number },
  bg: RGBA
): BubbleRegion {
  const w = Math.max(0, px.x2 - px.x1);
  const h = Math.max(0, px.y2 - px.y1);
  const mask = new Uint8Array(w * h);
  mask.fill(1);
  return { rect: px, mask, fillRatio: 1, isBubble: false, safe: px, bg };
}

/** 从掩码里取「最宽的一整段」当安全区，太窄的边缘不要 */
function safeFromMask(
  mask: Uint8Array,
  rw: number,
  rh: number,
  centreX: number,
  centreY: number
): { x1: number; y1: number; x2: number; y2: number } {
  const rowSpan = (y: number) => {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < rw; x++) {
      if (mask[y * rw + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    return { lo, hi };
  };
  const colSpan = (x: number) => {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < rh; y++) {
      if (mask[y * rw + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    return { lo, hi };
  };

  let maxRow = 0;
  for (let y = 0; y < rh; y++) {
    const sp = rowSpan(y);
    if (sp.lo >= 0) maxRow = Math.max(maxRow, sp.hi - sp.lo + 1);
  }
  let maxCol = 0;
  for (let x = 0; x < rw; x++) {
    const sp = colSpan(x);
    if (sp.lo >= 0) maxCol = Math.max(maxCol, sp.hi - sp.lo + 1);
  }

  /* 以文字框中心所在的行/列为中心，向两侧扩展到「够宽」为止 */
  const widen = (from: number, limit: number, ok: (i: number) => boolean) => {
    let a = from;
    let b = from;
    while (a - 1 >= 0 && ok(a - 1)) a--;
    while (b + 1 < limit && ok(b + 1)) b++;
    return { a, b };
  };
  const rowOk = (y: number) => {
    const sp = rowSpan(y);
    return sp.lo >= 0 && sp.hi - sp.lo + 1 >= maxRow * 0.62;
  };
  const colOk = (x: number) => {
    const sp = colSpan(x);
    return sp.lo >= 0 && sp.hi - sp.lo + 1 >= maxCol * 0.62;
  };
  const ry = widen(Math.min(rh - 1, Math.max(0, centreY)), rh, rowOk);
  const cx = widen(Math.min(rw - 1, Math.max(0, centreX)), rw, colOk);

  const inset = Math.max(1, Math.round(Math.min(rw, rh) * 0.03));
  const x1 = Math.min(rw, Math.max(0, cx.a + inset));
  const x2 = Math.max(0, Math.min(rw, cx.b + 1 - inset));
  const y1 = Math.min(rh, Math.max(0, ry.a + inset));
  const y2 = Math.max(0, Math.min(rh, ry.b + 1 - inset));
  if (x2 <= x1 || y2 <= y1) return { x1: 0, y1: 0, x2: rw, y2: rh };
  return { x1, y1, x2, y2 };
}

/** 框内像素的中位色：比平均值抗文字笔画干扰，比取样点更稳。 */
function medianColorIn(buf: PixelBuffer, x1: number, y1: number, x2: number, y2: number): RGBA {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const as: number[] = [];
  const step = Math.max(1, Math.round(Math.min(x2 - x1, y2 - y1) / 24));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const c = getPixel(buf, x, y);
      if (c.a <= 8) continue;
      rs.push(c.r);
      gs.push(c.g);
      bs.push(c.b);
      as.push(c.a);
    }
  }
  if (!rs.length) return { r: 255, g: 255, b: 255, a: 255 };
  const mid = (v: number[]) => {
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return { r: mid(rs), g: mid(gs), b: mid(bs), a: mid(as) };
}

export function findBubbleRegion(
  buf: PixelBuffer,
  box: Box,
  opts: { tolerance?: number; minFill?: number } = {}
): BubbleRegion {
  const tolerance = opts.tolerance ?? 42;
  const minFill = opts.minFill ?? 0.42;

  const px = boxToPixels(box, buf.width, buf.height, 0);
  const boxW = px.x2 - px.x1;
  const boxH = px.y2 - px.y1;
  if (boxW < 6 || boxH < 6) return rectFallback(px, { r: 255, g: 255, b: 255, a: 255 });

  /* 气泡底色要取「框里面」的主流色，而不是框外面那一圈 ——
     框外是页面底色，照它去判定可通行区域，气泡内部反而被判成不可通行，
     整页底色反倒成了候选连通域，最后一定认不出气泡。 */
  const bg = medianColorIn(buf, px.x1, px.y1, px.x2, px.y2);

  /* 搜索窗口放 0.75 个框宽高：气泡一般只比文字大一圈，
     放太宽会把相邻气泡或页面白底吃进来。 */
  const win = {
    x1: Math.max(0, px.x1 - Math.round(boxW * 0.75)),
    y1: Math.max(0, px.y1 - Math.round(boxH * 0.75)),
    x2: Math.min(buf.width, px.x2 + Math.round(boxW * 0.75)),
    y2: Math.min(buf.height, px.y2 + Math.round(boxH * 0.75))
  };
  const ww = win.x2 - win.x1;
  const wh = win.y2 - win.y1;
  if (ww <= 0 || wh <= 0) return rectFallback(px, bg);

  const passable = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const c = getPixel(buf, win.x1 + x, win.y1 + y);
      if (c.a > 8 && colorDist(c, bg) <= tolerance) passable[y * ww + x] = 1;
    }
  }

  /* 连通域：挑「和文字框重叠最多」的那一块 —— 气泡内部就是它 */
  const label = new Int32Array(ww * wh);
  const stack = new Int32Array(ww * wh);
  const cands: { id: number; area: number; x1: number; y1: number; x2: number; y2: number; overlap: number }[] =
    [];
  let nextId = 0;

  for (let start = 0; start < passable.length; start++) {
    if (!passable[start] || label[start]) continue;
    const id = ++nextId;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let area = 0;
    let bx1 = ww;
    let by1 = wh;
    let bx2 = -1;
    let by2 = -1;
    let overlap = 0;
    while (sp) {
      const idx = stack[--sp];
      const x = idx % ww;
      const y = (idx - x) / ww;
      area++;
      if (x < bx1) bx1 = x;
      if (x > bx2) bx2 = x;
      if (y < by1) by1 = y;
      if (y > by2) by2 = y;
      const gx = win.x1 + x;
      const gy = win.y1 + y;
      if (gx >= px.x1 && gx < px.x2 && gy >= px.y1 && gy < px.y2) overlap++;

      if (x > 0 && passable[idx - 1] && !label[idx - 1]) {
        label[idx - 1] = id;
        stack[sp++] = idx - 1;
      }
      if (x + 1 < ww && passable[idx + 1] && !label[idx + 1]) {
        label[idx + 1] = id;
        stack[sp++] = idx + 1;
      }
      if (y > 0 && passable[idx - ww] && !label[idx - ww]) {
        label[idx - ww] = id;
        stack[sp++] = idx - ww;
      }
      if (y + 1 < wh && passable[idx + ww] && !label[idx + ww]) {
        label[idx + ww] = id;
        stack[sp++] = idx + ww;
      }
    }
    /* 只有和文字框真的有交集的连通域才算「候选气泡内部」 */
    if (overlap > 0) cands.push({ id, area, x1: bx1, y1: by1, x2: bx2, y2: by2, overlap });
  }

  if (!cands.length) return rectFallback(px, bg);

  /* 字、拟声字、速度线会把气泡内部分成好几块。只取最大那块，判定会失败（框不住文字），
     擦的时候也只擦一块，原文会留半截。所以把所有和文字框有交集的连通域并起来。 */
  let ux1 = ww;
  let uy1 = wh;
  let ux2 = -1;
  let uy2 = -1;
  let uArea = 0;
  for (const c of cands) {
    if (c.x1 < ux1) ux1 = c.x1;
    if (c.y1 < uy1) uy1 = c.y1;
    if (c.x2 > ux2) ux2 = c.x2;
    if (c.y2 > uy2) uy2 = c.y2;
    uArea += c.area;
  }
  const bw = ux2 - ux1 + 1;
  const bh = uy2 - uy1 + 1;
  /* 被切开的气泡 fillRatio 天然偏低（中间隔着黑条），所以按「并起来之后的占比」算，
     量纲仍然是「候选区域的像素有多稠密」。 */
  const fillRatio = uArea / (bw * bh);
  /* 气泡内部天然比模型给的框小一圈（描边、圆角），窄框上 5% 的阈值会直接判死；
     也不能大得离谱 —— 那多半是把整片白底当成了气泡。 */
  const encloses =
    bw >= boxW * 0.75 && bh >= boxH * 0.75 && bw <= boxW * 2.6 && bh <= boxH * 2.6;
  const notWholePage = bw <= buf.width * 0.97 && bh <= buf.height * 0.97;
  /* 连通域把整个搜索窗口撑满，说明窗口里没有闭合边界（字直接压在画面/底色上），
     那它就不是气泡。少了这一条，一整片浅色画面会被当成一个巨大气泡。 */
  const touchesEdge = ux1 === 0 || uy1 === 0 || ux2 === ww - 1 || uy2 === wh - 1;
  const isBubble =
    encloses && notWholePage && !touchesEdge && fillRatio >= minFill && fillRatio <= 0.995;

  const rect = {
    x1: win.x1 + ux1,
    y1: win.y1 + uy1,
    x2: win.x1 + ux2 + 1,
    y2: win.y1 + uy2 + 1
  };
  const rw = rect.x2 - rect.x1;
  const rh = rect.y2 - rect.y1;

  if (!isBubble) return { ...rectFallback(rect, bg), fillRatio, isBubble: false };

  const ids = new Set(cands.map(c => c.id));
  const comp = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (ids.has(label[(uy1 + y) * ww + (ux1 + x)])) comp[y * rw + x] = 1;
    }
  }

  /* 文字笔画本身不是「气泡底色」，会把掩码戳出一堆洞。
     逐行、逐列各自补一次（正交凸包），洞就被填上，形状仍然是气泡的。 */
  const rowFill = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < rw; x++) {
      if (comp[y * rw + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) for (let x = lo; x <= hi; x++) rowFill[y * rw + x] = 1;
  }
  const colFill = new Uint8Array(rw * rh);
  for (let x = 0; x < rw; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < rh; y++) {
      if (comp[y * rw + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    if (lo >= 0) for (let y = lo; y <= hi; y++) colFill[y * rw + x] = 1;
  }
  const mask = new Uint8Array(rw * rh);
  for (let i = 0; i < mask.length; i++) mask[i] = rowFill[i] && colFill[i] ? 1 : 0;

  const rel = safeFromMask(
    mask,
    rw,
    rh,
    Math.round((px.x1 + px.x2) / 2) - rect.x1,
    Math.round((px.y1 + px.y2) / 2) - rect.y1
  );
  /* 对外一律给「整张图坐标系」的绝对像素，和 rectFallback 保持一致，
     免得调用方一半用相对、一半用绝对。 */
  const safe = { x1: rect.x1 + rel.x1, y1: rect.y1 + rel.y1, x2: rect.x1 + rel.x2, y2: rect.y1 + rel.y2 };

  return { rect, mask, fillRatio, isBubble: true, safe, bg };
}

/**
 * 按气泡掩码擦字：只动气泡内部，描边和外部画面一个像素都不碰。
 * 权重和 eraseBox 一致（按与底色的差距），靠近掩码边界的地方减半，避免硬边。
 */
export function eraseBubble(buf: PixelBuffer, region: BubbleRegion, strength = 1): void {
  const { rect, mask, bg } = region;
  const rw = rect.x2 - rect.x1;
  const rh = rect.y2 - rect.y1;
  if (rw <= 0 || rh <= 0) return;

  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < rw && y < rh && mask[y * rw + x] === 1;

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!inside(x, y)) continue;
      const gx = rect.x1 + x;
      const gy = rect.y1 + y;
      const c = getPixel(buf, gx, gy);
      const diff = colorDist(c, bg) / 255;
      if (diff < 0.015) continue;
      const edge = inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1) ? 1 : 0.55;
      const k = Math.min(1, Math.pow(diff, 0.45) * strength) * edge;
      setPixel(buf, gx, gy, {
        r: c.r + (bg.r - c.r) * k,
        g: c.g + (bg.g - c.g) * k,
        b: c.b + (bg.b - c.b) * k,
        a: c.a
      });
    }
  }
}
