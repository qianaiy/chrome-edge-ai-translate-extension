import { describe, it, expect } from 'vitest';
import {
  boxToPixels,
  adaptivePad,
  getPixel,
  setPixel,
  estimateBackground,
  eraseBox,
  eraseAll,
  readableColor,
  toCss,
  type PixelBuffer
} from '../src/core/inpaint.js';

/** 造一张纯色图，中间画一个深色方块（模拟文字） */
function makeBuf(w: number, h: number, bg = 240) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg;
    data[i * 4 + 1] = bg;
    data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function fillRect(buf: PixelBuffer, x1: number, y1: number, x2: number, y2: number, v: number) {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) continue;
      const i = (y * buf.width + x) * 4;
      buf.data[i] = v;
      buf.data[i + 1] = v;
      buf.data[i + 2] = v;
    }
  }
}

describe('boxToPixels', () => {
  it('百分比框转像素', () => {
    expect(boxToPixels({ x1: 10, y1: 20, x2: 30, y2: 40 }, 1000, 500)).toEqual({
      x1: 100,
      y1: 100,
      x2: 300,
      y2: 200
    });
  });

  it('x1 大于 x2 也能算（模型可能给反了）', () => {
    const r = boxToPixels({ x1: 30, y1: 40, x2: 10, y2: 20 }, 1000, 500);
    expect(r.x1).toBe(100);
    expect(r.x2).toBe(300);
  });

  it('带边距', () => {
    const r = boxToPixels({ x1: 10, y1: 10, x2: 20, y2: 20 }, 100, 100, 5);
    expect(r.x1).toBe(5);
    expect(r.y1).toBe(5);
    expect(r.x2).toBe(25);
    expect(r.y2).toBe(25);
  });

  it('分轴的边距', () => {
    const r = boxToPixels({ x1: 10, y1: 10, x2: 20, y2: 20 }, 100, 100, { x: 2, y: 8 });
    expect(r.x1).toBe(8);
    expect(r.y1).toBe(2);
    expect(r.x2).toBe(22);
    expect(r.y2).toBe(28);
  });

  it('不会越出图片边界', () => {
    const r = boxToPixels({ x1: 0, y1: 0, x2: 100, y2: 100 }, 50, 50, 10);
    expect(r.x1).toBe(0);
    expect(r.y1).toBe(0);
    expect(r.x2).toBe(50);
    expect(r.y2).toBe(50);
  });
});

describe('adaptivePad', () => {
  it('垂直方向的余量按字高算，水平方向按字宽算', () => {
    /* 字高 40 像素 → 垂直余量 20（0.5 倍）；字宽 200 像素 → 水平余量 20（0.1 倍） */
    const p = adaptivePad({ x1: 0, y1: 0, x2: 20, y2: 4 }, 1000, 1000);
    expect(p.y).toBe(20);
    expect(p.x).toBe(20);
  });

  it('矮胖的框：垂直余量仍然够盖住一个偏掉的字高', () => {
    /* 框高 10 像素 → 垂直余量至少 4（0.4 倍字高） */
    const p = adaptivePad({ x1: 0, y1: 0, x2: 40, y2: 1 }, 1000, 1000);
    expect(p.y).toBeGreaterThanOrEqual(4);
  });

  it('余量有上限，不至于把整张图都擦了', () => {
    const p = adaptivePad({ x1: 0, y1: 0, x2: 100, y2: 100 }, 2000, 2000);
    expect(p.x).toBeLessThanOrEqual(24);
    expect(p.y).toBeLessThanOrEqual(44);
  });

  it('垂直余量至少覆盖半个字高（框偏一整行也还要能盖住）', () => {
    /* 字高 30 像素 → 垂直余量至少 15 */
    const p = adaptivePad({ x1: 0, y1: 0, x2: 40, y2: 3 }, 1000, 1000);
    expect(p.y).toBeGreaterThanOrEqual(15);
  });

  it('小框也有一点余量', () => {
    const p = adaptivePad({ x1: 0, y1: 0, x2: 5, y2: 5 }, 1000, 1000);
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
  });
});

describe('getPixel / setPixel', () => {
  it('读写像素', () => {
    const buf = makeBuf(4, 4);
    setPixel(buf, 2, 1, { r: 10, g: 20, b: 30, a: 255 });
    expect(getPixel(buf, 2, 1)).toEqual({ r: 10, g: 20, b: 30, a: 255 });
  });

  it('改一个像素不影响别的', () => {
    const buf = makeBuf(4, 4);
    setPixel(buf, 0, 0, { r: 0, g: 0, b: 0, a: 255 });
    expect(getPixel(buf, 1, 0).r).toBe(240);
  });
});

describe('estimateBackground', () => {
  it('纯色背景估出纯色', () => {
    const buf = makeBuf(100, 100, 200);
    const bg = estimateBackground(buf, 40, 40, 60, 60);
    expect(bg.r).toBe(200);
  });

  it('有文字时估的是背景色而不是文字色', () => {
    const buf = makeBuf(100, 100, 240);
    fillRect(buf, 45, 45, 55, 55, 10); // 中间是"文字"
    const bg = estimateBackground(buf, 40, 40, 60, 60);
    expect(bg.r).toBeGreaterThan(200);
  });

  it('用中位数：少数深色像素不会带偏结果', () => {
    const buf = makeBuf(100, 100, 240);
    /* 在背景带里撒几个深色噪点 */
    fillRect(buf, 40, 38, 42, 40, 0);
    fillRect(buf, 55, 60, 58, 62, 0);
    const bg = estimateBackground(buf, 42, 40, 58, 60);
    expect(bg.r).toBe(240);
  });

  it('框贴边时退回用框内的颜色', () => {
    const buf = makeBuf(20, 20, 180);
    const bg = estimateBackground(buf, 0, 0, 10, 10);
    expect(bg.r).toBeGreaterThan(0);
  });
});

describe('eraseBox', () => {
  it('把深色笔画擦成背景色', () => {
    const buf = makeBuf(100, 100, 240);
    fillRect(buf, 40, 40, 60, 60, 10);
    eraseBox(buf, 38, 38, 62, 62, { r: 240, g: 240, b: 240, a: 255 });
    /* 中心原来是最深的，现在应该接近背景 */
    const c = getPixel(buf, 50, 50);
    expect(c.r).toBeGreaterThan(200);
  });

  it('本来就是背景色的像素基本不动', () => {
    const buf = makeBuf(100, 100, 240);
    eraseBox(buf, 38, 38, 62, 62, { r: 240, g: 240, b: 240, a: 255 });
    const c = getPixel(buf, 50, 50);
    expect(c.r).toBe(240);
  });

  it('保留 alpha 通道', () => {
    const buf = makeBuf(100, 100, 240);
    buf.data[3] = 128; // 左上角半透明
    eraseBox(buf, 0, 0, 20, 20, { r: 255, g: 255, b: 255, a: 255 });
    expect(getPixel(buf, 0, 0).a).toBe(128);
  });

  it('不会写出图片边界', () => {
    const buf = makeBuf(10, 10, 100);
    expect(() => eraseBox(buf, -5, -5, 50, 50, { r: 0, g: 0, b: 0, a: 255 })).not.toThrow();
  });

  it('零尺寸的框不做事', () => {
    const buf = makeBuf(10, 10, 100);
    const before = getPixel(buf, 5, 5).r;
    eraseBox(buf, 5, 5, 5, 5, { r: 0, g: 0, b: 0, a: 255 });
    expect(getPixel(buf, 5, 5).r).toBe(before);
  });

  it('strength 越小擦得越轻', () => {
    const strong = makeBuf(100, 100, 240);
    fillRect(strong, 40, 40, 60, 60, 10);
    eraseBox(strong, 38, 38, 62, 62, { r: 240, g: 240, b: 240, a: 255 }, 1);

    const light = makeBuf(100, 100, 240);
    fillRect(light, 40, 40, 60, 60, 10);
    eraseBox(light, 38, 38, 62, 62, { r: 240, g: 240, b: 240, a: 255 }, 0.2);

    expect(getPixel(strong, 50, 50).r).toBeGreaterThan(getPixel(light, 50, 50).r);
  });
});

describe('eraseAll', () => {
  it('擦掉多个框并返回各自的背景色', () => {
    const buf = makeBuf(200, 200, 240);
    fillRect(buf, 20, 20, 60, 40, 10);
    fillRect(buf, 100, 100, 160, 120, 10);
    const bgs = eraseAll(buf, [
      { x1: 10, y1: 10, x2: 30, y2: 20 },
      { x1: 50, y1: 50, x2: 80, y2: 60 }
    ]);
    expect(bgs).toHaveLength(2);
    expect(getPixel(buf, 40, 30).r).toBeGreaterThan(200);
    expect(getPixel(buf, 130, 110).r).toBeGreaterThan(200);
  });

  it('没有框就返回空数组', () => {
    const buf = makeBuf(10, 10);
    expect(eraseAll(buf, [])).toEqual([]);
  });
});

describe('readableColor', () => {
  it('浅背景用深字', () => {
    expect(readableColor({ r: 240, g: 240, b: 240, a: 255 })).toBe('#111111');
  });

  it('深背景用浅字', () => {
    expect(readableColor({ r: 20, g: 20, b: 20, a: 255 })).toBe('#ffffff');
  });

  it('中间灰也能给出合理结果', () => {
    const c = readableColor({ r: 128, g: 128, b: 128, a: 255 });
    expect(['#111111', '#ffffff']).toContain(c);
  });
});

describe('toCss', () => {
  it('转成 CSS 颜色', () => {
    expect(toCss({ r: 1, g: 2, b: 3, a: 255 })).toBe('rgb(1, 2, 3)');
  });
});
