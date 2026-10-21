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
