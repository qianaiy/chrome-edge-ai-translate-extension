import { describe, it, expect } from 'vitest';
import {
  boxToPixels,
  adaptivePad,
  estimateBackground,
  eraseBox,
  eraseAll,
  getPixel,
  setPixel,
  type PixelBuffer
} from '../src/core/inpaint.js';

/**
 * 造一张「白底 + 黑色文字块」的图，模拟漫画气泡里的文字。
 * 关键：文字块的像素位置是**已知**的，这样能精确验证擦除效果。
 */
function makeComicLike(w: number, h: number, glyphs: { x: number; y: number; w: number; h: number }[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const buf: PixelBuffer = { width: w, height: h, data };
  for (const g of glyphs) {
    for (let y = g.y; y < g.y + g.h; y++) {
      for (let x = g.x; x < g.x + g.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        setPixel(buf, x, y, { r: 20, g: 20, b: 20, a: 255 });
      }
    }
  }
  return buf;
}

function darkCount(buf: PixelBuffer): number {
  let n = 0;
  for (let i = 0; i < buf.data.length; i += 4) {
    if (buf.data[i] < 128) n++;
  }
  return n;
}

describe('擦字 · 已知位置的文字块', () => {
  /* 一行字：8 个字，每个 20x30 像素，起点 (50, 40) */
  const glyphs = [{ x: 50, y: 40, w: 160, h: 30 }];

  it('框正好罩住文字时，擦完基本没有残留', () => {
    const buf = makeComicLike(400, 200, glyphs);
    const before = darkCount(buf);
    expect(before).toBeGreaterThan(0);

    /* 框：0-100 百分比，正好罩住 x 50-210, y 40-70 */
    const box = {
      x1: (50 / 400) * 100,
      y1: (40 / 200) * 100,
      x2: (210 / 400) * 100,
      y2: (70 / 200) * 100
    };
    const p = adaptivePad(box, buf.width, buf.height);
    const r = boxToPixels(box, buf.width, buf.height, p);
    const bg = estimateBackground(buf, r.x1, r.y1, r.x2, r.y2);
    eraseBox(buf, r.x1, r.y1, r.x2, r.y2, bg);

    const after = darkCount(buf);
    expect(after).toBeLessThan(before * 0.05); // 残留不到 5%
  });

  it('框偏高一半字高时，靠余量也能擦干净', () => {
    const buf = makeComicLike(400, 200, glyphs);
    const before = darkCount(buf);

    /* 模型给的框偏上 15 像素（半个字高），模拟定位不准 */
    const box = {
      x1: (50 / 400) * 100,
      y1: ((40 - 15) / 200) * 100,
      x2: (210 / 400) * 100,
      y2: ((70 - 15) / 200) * 100
    };
    const p = adaptivePad(box, buf.width, buf.height);
    const r = boxToPixels(box, buf.width, buf.height, p);
    const bg = estimateBackground(buf, r.x1, r.y1, r.x2, r.y2);
    eraseBox(buf, r.x1, r.y1, r.x2, r.y2, bg);

    const after = darkCount(buf);
    expect(after).toBeLessThan(before * 0.15);
  });

  it('框偏上 15 像素时，垂直余量确实把字尾盖住了', () => {
    const buf = makeComicLike(400, 200, glyphs);
    const box = {
      x1: (50 / 400) * 100,
      y1: ((40 - 15) / 200) * 100,
      x2: (210 / 400) * 100,
      y2: ((70 - 15) / 200) * 100
    };
    const p = adaptivePad(box, buf.width, buf.height);
    const r = boxToPixels(box, buf.width, buf.height, p);
    /* 文字底边在 y=70，框的底边（+余量后）必须够到 */
    expect(r.y2).toBeGreaterThanOrEqual(70);
  });
});

describe('eraseAll · 多个框不互相污染', () => {
  it('第二个框的背景色不受第一个框被擦的影响', () => {
    const buf = makeComicLike(400, 400, [
      { x: 50, y: 40, w: 100, h: 30 },
      { x: 50, y: 200, w: 100, h: 30 }
    ]);
    const boxes = [
      { x1: (50 / 400) * 100, y1: (40 / 400) * 100, x2: (150 / 400) * 100, y2: (70 / 400) * 100 },
      { x1: (50 / 400) * 100, y1: (200 / 400) * 100, x2: (150 / 400) * 100, y2: (230 / 400) * 100 }
    ];
    const bgs = eraseAll(buf, boxes);
    /* 两个框的背景色应该一致（都是白底），不会因为第一个被擦而变 */
    expect(bgs[0].r).toBe(bgs[1].r);
    expect(Math.abs(bgs[0].r - bgs[1].r)).toBeLessThan(6);
  });

  it('擦完两块，残留都很少', () => {
    const buf = makeComicLike(400, 400, [
      { x: 50, y: 40, w: 100, h: 30 },
      { x: 50, y: 200, w: 100, h: 30 }
    ]);
    const before = darkCount(buf);
    eraseAll(buf, [
      { x1: (50 / 400) * 100, y1: (40 / 400) * 100, x2: (150 / 400) * 100, y2: (70 / 400) * 100 },
      { x1: (50 / 400) * 100, y1: (200 / 400) * 100, x2: (150 / 400) * 100, y2: (230 / 400) * 100 }
    ]);
    expect(darkCount(buf)).toBeLessThan(before * 0.05);
  });
});

describe('擦除不会破坏背景纹理', () => {
  it('渐变背景擦完还是渐变，不是死板的一块', () => {
    const w = 200, h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = 100 + Math.round((y / h) * 120);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const buf: PixelBuffer = { width: w, height: h, data };
    /* 放一块深色「文字」 */
    for (let y = 40; y < 60; y++) {
      for (let x = 60; x < 140; x++) setPixel(buf, x, y, { r: 10, g: 10, b: 10, a: 255 });
    }

    const box = { x1: 30, y1: 40, x2: 70, y2: 60 };
    const p = adaptivePad(box, w, h);
    const r = boxToPixels(box, w, h, p);
    const bg = estimateBackground(buf, r.x1, r.y1, r.x2, r.y2);
    eraseBox(buf, r.x1, r.y1, r.x2, r.y2, bg);

    /* 擦过的区域，竖直方向还应该看得出渐变（上半和下半有差别） */
    const top = getPixel(buf, 100, r.y1 + 2).r;
    const bottom = getPixel(buf, 100, r.y2 - 2).r;
    expect(Math.abs(top - bottom)).toBeGreaterThan(3);
  });
});
