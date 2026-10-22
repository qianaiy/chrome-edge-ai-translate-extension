import { describe, it, expect } from 'vitest';
import { findBubbleRegion, eraseBubble, getPixel, type PixelBuffer } from '../src/core/inpaint.js';

/* 全部用代码合成像素：不读任何外部图片，跑在哪台机器上都一样。 */

const PAGE = 210;

function makeBuf(w = 300, h = 300, bg = PAGE): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg;
    data[i * 4 + 1] = bg;
    data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function put(buf: PixelBuffer, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
  const i = (y * buf.width + x) * 4;
  buf.data[i] = v;
  buf.data[i + 1] = v;
  buf.data[i + 2] = v;
}

function fillRect(buf: PixelBuffer, x1: number, y1: number, x2: number, y2: number, v: number) {
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) put(buf, x, y, v);
}

/** 实心椭圆（气泡底） */
function ellipseFill(buf: PixelBuffer, cx: number, cy: number, rx: number, ry: number, v: number) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) put(buf, x, y, v);
    }
  }
}

/** 椭圆描边环：归一化半径落在 [inner, 1] 之间 */
function ellipseRing(
  buf: PixelBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  inner: number,
  v: number
) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r <= 1 && r >= inner) put(buf, x, y, v);
    }
  }
}

/** 模拟气泡里的原文：几行深色横杠 */
function drawBars(buf: PixelBuffer, cx: number, cy: number, halfWidth: number, rows: number, color = 25) {
  for (let r = 0; r < rows; r++) {
    const y = cy - 12 + r * 12;
    fillRect(buf, cx - halfWidth, y, cx + halfWidth, y + 5, color);
  }
}

const ELLIPSE = { cx: 150, cy: 150, rx: 80, ry: 60 };

/** 文字框只盖住气泡中间那一块（真实模型给的框就是这样，比气泡小） */
const TEXT_BOX = { x1: 33, y1: 40, x2: 67, y2: 60 };

function whiteBubblePage() {
  const buf = makeBuf(300, 300, PAGE);
  ellipseFill(buf, ELLIPSE.cx, ELLIPSE.cy, ELLIPSE.rx, ELLIPSE.ry, 255);
  ellipseRing(buf, ELLIPSE.cx, ELLIPSE.cy, ELLIPSE.rx, ELLIPSE.ry, 0.93, 0);
  drawBars(buf, ELLIPSE.cx, ELLIPSE.cy, 40, 3);
  return buf;
}

describe('findBubbleRegion：白色气泡', () => {
  it('认出气泡并贴合外接框', () => {
    const reg = findBubbleRegion(whiteBubblePage(), TEXT_BOX);
    expect(reg.isBubble).toBe(true);
    /* 认出来的是「描边内侧」的气泡内部：左/上边缘最多比椭圆外接框缩进描边厚度，
       右/下同理。所以只要求它落在 [外接框 - 阈值, 外接框] 之间，且不越出外接框。 */
    const left = reg.rect.x1 - (ELLIPSE.cx - ELLIPSE.rx);
    const top = reg.rect.y1 - (ELLIPSE.cy - ELLIPSE.ry);
    const right = ELLIPSE.cx + ELLIPSE.rx - reg.rect.x2;
    const bottom = ELLIPSE.cy + ELLIPSE.ry - reg.rect.y2;
    for (const d of [left, top, right, bottom]) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(10);
    }
    // 椭圆面积 / 外接框面积 ≈ π/4 ≈ 0.785，被文字再打掉一点
    expect(reg.fillRatio).toBeGreaterThan(0.4);
    expect(reg.fillRatio).toBeLessThan(0.9);
  });

  it('掩码盖住文字，但四角留空（说明认出了形状而不是退化成矩形）', () => {
    const buf = whiteBubblePage();
    const reg = findBubbleRegion(buf, TEXT_BOX);
    const { rect, mask } = reg;
    const rw = rect.x2 - rect.x1;
    const at = (x: number, y: number) => mask[(y - rect.y1) * rw + (x - rect.x1)];

    // 文字笔画所在位置必须可擦，否则字擦不掉
    expect(at(ELLIPSE.cx, ELLIPSE.cy - 10)).toBe(1);
    expect(at(ELLIPSE.cx - 30, ELLIPSE.cy - 10)).toBe(1);

    // 外接框四角在椭圆之外，掩码必须是 0
    expect(at(rect.x1 + 2, rect.y1 + 2)).toBe(0);
    expect(at(rect.x2 - 3, rect.y1 + 2)).toBe(0);
    expect(at(rect.x1 + 2, rect.y2 - 3)).toBe(0);
    expect(at(rect.x2 - 3, rect.y2 - 3)).toBe(0);
  });

  it('安全区在气泡内部且非空', () => {
    const reg = findBubbleRegion(whiteBubblePage(), TEXT_BOX);
    const { safe, rect } = reg;
    expect(safe.x1).toBeGreaterThanOrEqual(rect.x1);
    expect(safe.y1).toBeGreaterThanOrEqual(rect.y1);
    expect(safe.x2).toBeLessThanOrEqual(rect.x2);
    expect(safe.y2).toBeLessThanOrEqual(rect.y2);
    expect(safe.x2 - safe.x1).toBeGreaterThan(20);
    expect(safe.y2 - safe.y1).toBeGreaterThan(10);
  });

  it('底色识别为气泡填充色', () => {
    const reg = findBubbleRegion(whiteBubblePage(), TEXT_BOX);
    expect(reg.bg.r).toBeGreaterThan(200);
  });
});

describe('findBubbleRegion：没有气泡', () => {
  it('字直接压在灰底上时退回矩形', () => {
    const buf = makeBuf(300, 300, PAGE);
    drawBars(buf, 150, 150, 60, 3, 10);
    const reg = findBubbleRegion(buf, TEXT_BOX);
    expect(reg.isBubble).toBe(false);
    // 退回语义：整块都可擦，交给调用方用矩形策略
    expect(reg.mask.every(v => v === 1)).toBe(true);
  });
});

describe('findBubbleRegion：深色气泡', () => {
  it('黑底白字也能认出来', () => {
    const buf = makeBuf(300, 300, PAGE);
    ellipseFill(buf, ELLIPSE.cx, ELLIPSE.cy, ELLIPSE.rx, ELLIPSE.ry, 20);
    ellipseRing(buf, ELLIPSE.cx, ELLIPSE.cy, ELLIPSE.rx, ELLIPSE.ry, 0.93, 90);
    drawBars(buf, ELLIPSE.cx, ELLIPSE.cy, 40, 3, 250);

    const reg = findBubbleRegion(buf, TEXT_BOX);
    expect(reg.isBubble).toBe(true);
    expect(reg.bg.r).toBeLessThan(80);

    const { rect, mask } = reg;
    const rw = rect.x2 - rect.x1;
    const at = (x: number, y: number) => mask[(y - rect.y1) * rw + (x - rect.x1)];
    // 白色文字同样要被掩码盖住，不然黑底白字擦不掉
    expect(at(ELLIPSE.cx, ELLIPSE.cy - 10)).toBe(1);
  });
});

describe('eraseBubble', () => {
  it('只擦气泡内部：描边与外部一个像素不动', () => {
    const buf = whiteBubblePage();
    const reg = findBubbleRegion(buf, TEXT_BOX);

    // 挑几个「擦之前」的参考点
    const borderPoint = { x: ELLIPSE.cx, y: ELLIPSE.cy - ELLIPSE.ry + 1 };
    const outsidePoint = { x: 5, y: 5 };
    const borderBefore = getPixel(buf, borderPoint.x, borderPoint.y);
    const outsideBefore = getPixel(buf, outsidePoint.x, outsidePoint.y);

    eraseBubble(buf, reg, 1);

    const borderAfter = getPixel(buf, borderPoint.x, borderPoint.y);
    const outsideAfter = getPixel(buf, outsidePoint.x, outsidePoint.y);
    expect(borderAfter).toEqual(borderBefore);
    expect(outsideAfter).toEqual(outsideBefore);

    // 气泡里的字被擦掉：原来深色的笔画位置应该接近底色
    const ink = getPixel(buf, ELLIPSE.cx, ELLIPSE.cy - 10);
    expect(ink.r).toBeGreaterThan(200);
  });

  it('本来就和底色一样的地方不改动', () => {
    const buf = makeBuf(300, 300, 200);
    // 造一个纯色「气泡」，内部零对比度
    fillRect(buf, 100, 100, 200, 180, 200);
    const reg = {
      rect: { x1: 100, y1: 100, x2: 200, y2: 180 },
      mask: new Uint8Array(100 * 80).fill(1),
      fillRatio: 1,
      isBubble: false,
      safe: { x1: 100, y1: 100, x2: 200, y2: 180 },
      bg: { r: 200, g: 200, b: 200, a: 255 }
    };
    const before = getPixel(buf, 150, 140);
    eraseBubble(buf, reg, 1);
    expect(getPixel(buf, 150, 140)).toEqual(before);
  });
});

describe('findBubbleRegion：退化输入', () => {
  it('框太小直接退回矩形，不崩', () => {
    const reg = findBubbleRegion(whiteBubblePage(), { x1: 40, y1: 40, x2: 41, y2: 41 });
    expect(reg.isBubble).toBe(false);
    expect(reg.mask.length).toBeGreaterThanOrEqual(0);
  });

  it('框超出画布边界不崩', () => {
    const reg = findBubbleRegion(whiteBubblePage(), { x1: 90, y1: 90, x2: 130, y2: 130 });
    expect(typeof reg.isBubble).toBe('boolean');
    expect(reg.rect.x2).toBeLessThanOrEqual(300);
    expect(reg.rect.y2).toBeLessThanOrEqual(300);
  });

  it('空图不崩', () => {
    const buf = makeBuf(20, 20, 255);
    const reg = findBubbleRegion(buf, { x1: 10, y1: 10, x2: 60, y2: 60 });
    expect(typeof reg.isBubble).toBe('boolean');
  });
});
