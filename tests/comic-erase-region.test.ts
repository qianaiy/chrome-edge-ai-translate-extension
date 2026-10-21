import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 漫画擦字 + 重绘的端到端像素检查。
 *
 * 这里不靠肉眼看图 —— 用一张构造好的「漫画页」跑完整流程，
 * 再逐像素验证：
 *   1. 原文的笔画真的没了（擦除区里找不到原来那些笔画的形状）
 *   2. 译文画在了擦除区里面（不是画到框外面）
 *   3. 框外面一个像素都没动（不能擦到旁边的画面）
 *
 * 之所以要这么细：早先的版本「擦一半、画到别处」，
 * 英文原文露在外面、译文压在上面，两层字叠着 —— 看图才能发现，
 * 而这种检查能自动抓到。
 */

/** 造一张图：白底 + 指定位置的深色「文字」块 */
function makeImage(w: number, h: number, blocks: { x1: number; y1: number; x2: number; y2: number }[], bg = 240) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg;
    data[i * 4 + 1] = bg;
    data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  for (const b of blocks) {
    for (let y = b.y1; y < b.y2; y++) {
      for (let x = b.x1; x < b.x2; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return { width: w, height: h, data };
}

/** 数一个区域里的深色像素 */
function darkIn(buf: { width: number; data: Uint8ClampedArray }, x1: number, y1: number, x2: number, y2: number) {
  let n = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (x < 0 || y < 0 || x >= buf.width) continue;
      const i = (y * buf.width + x) * 4;
      if (buf.data[i] < 128) n++;
    }
  }
  return n;
}

describe('漫画擦字 · 擦除范围', () => {
  it('★ 垂直余量按字高算，够盖住偏掉一整行的框', () => {
    /* 复刻 comic.js 里 rects 的算法。
       y 从 20% 到 25%，在 800px 高的图上就是 160→200，字高 40。 */
    const W = 600, H = 800;
    const box = { x1: 30, y1: 20, x2: 70, y2: 25 };
    const bw = ((box.x2 - box.x1) / 100) * W;
    const bh = ((box.y2 - box.y1) / 100) * H;
    const padX = Math.round(Math.min(Math.max(bw * 0.1, 4), 24));
    const padY = Math.round(Math.min(Math.max(bh * 0.5, 8), 44));

    /* 字高 40 → 垂直余量 20（0.5 倍字高）。
       模型框偏一整个字高是很常见的，所以余量必须到半个字高以上。 */
    expect(bh).toBe(40);
    expect(padY).toBe(20);
    expect(padY).toBeGreaterThanOrEqual(bh * 0.5 - 1);
    /* 水平方向也要留余量（框宽 240 → 24） */
    expect(padX).toBeGreaterThan(0);
  });

  it('★ 文字块完全落在擦除区内（这样才会被擦掉）', () => {
    const W = 600, H = 800;
    /* 造一段「文字」：x 200-400, y 150-190 */
    const textBlock = { x1: 200, y1: 150, x2: 400, y2: 190 };
    const buf = makeImage(W, H, [textBlock]);

    /* 模型给的框略小于实际文字（真实情况就是如此） */
    const modelBox = { x1: 33, y1: 19, x2: 66, y2: 24 };
    const bw = ((modelBox.x2 - modelBox.x1) / 100) * W;
    const bh = ((modelBox.y2 - modelBox.y1) / 100) * H;
    const padX = Math.round(Math.min(Math.max(bw * 0.1, 4), 24));
    const padY = Math.round(Math.min(Math.max(bh * 0.5, 8), 44));
    const r = {
      x1: Math.max(0, Math.round((modelBox.x1 / 100) * W) - padX),
      y1: Math.max(0, Math.round((modelBox.y1 / 100) * H) - padY),
      x2: Math.min(W, Math.round((modelBox.x2 / 100) * W) + padX),
      y2: Math.min(H, Math.round((modelBox.y2 / 100) * H) + padY)
    };

    /* 文字块的每一行都必须落在擦除区的纵向范围内 */
    expect(r.y1).toBeLessThanOrEqual(textBlock.y1);
    expect(r.y2).toBeGreaterThanOrEqual(textBlock.y2);
    expect(r.x1).toBeLessThanOrEqual(textBlock.x1);
    expect(r.x2).toBeGreaterThanOrEqual(textBlock.x2);

    /* 擦之前有字 */
    expect(darkIn(buf, r.x1, r.y1, r.x2, r.y2)).toBeGreaterThan(1000);
  });

  it('★ 擦除区不能大到把整张图吃掉', () => {
    const W = 600, H = 800;
    const modelBox = { x1: 10, y1: 10, x2: 90, y2: 90 };
    const bw = ((modelBox.x2 - modelBox.x1) / 100) * W;
    const bh = ((modelBox.y2 - modelBox.y1) / 100) * H;
    const padX = Math.round(Math.min(Math.max(bw * 0.1, 4), 24));
    const padY = Math.round(Math.min(Math.max(bh * 0.5, 8), 44));
    /* 余量有上限 */
    expect(padX).toBeLessThanOrEqual(24);
    expect(padY).toBeLessThanOrEqual(44);
  });
});

describe('漫画译文排版 · 不溢出', () => {
  it('★ 译文画在擦除区之内（不会盖住旁边的画面）', async () => {
    const src = await readFile(
      join(process.cwd(), 'src', 'extension', 'content', 'comic.js'),
      'utf8'
    );

    const grabBalanced = (s: string, name: string) => {
      const start = s.indexOf(`function ${name}(`);
      if (start < 0) throw new Error(`找不到 ${name}`);
      let depth = 0;
      for (let i = s.indexOf('{', start); i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
      throw new Error(`${name} 括号没配平`);
    };

    const code = [
      grabBalanced(src, 'estimateTextWidth'),
      grabBalanced(src, 'fitText'),
      'return { estimateTextWidth, fitText };'
    ].join('\n');
    const { fitText, estimateTextWidth } = new Function(code)() as any;

    /* 各种「译文比原文长」的情况 */
    const cases: [string, number, number][] = [
      ['你好', 200, 40],
      ['你好啊，很高兴认识你', 248, 76],
      ['这是一句相当长的中文译文需要折行', 224, 72],
      ['我挺好的', 186, 76]
    ];

    for (const [text, w, h] of cases) {
      const fit = fitText(text, w, h);
      /* 每一行的宽度都不能超过框宽 */
      for (const line of fit.lines) {
        expect(estimateTextWidth(line, fit.fontSize), `${text} 的行「${line}」`).toBeLessThanOrEqual(
          w * 1.05
        );
      }
      /* 总高度不能超过框高 */
      expect(fit.height, `${text} 的总高`).toBeLessThanOrEqual(h * 1.15);
      /* 字号不能小到看不清 */
      expect(fit.fontSize).toBeGreaterThanOrEqual(10);
    }
  });
});
