/* 视觉模型返回的框，坐标系并不可信。
 *
 * 真实证据（artifacts/real-samples/responses）：
 *   jp-vertical / kr-strip 返回 0-100 百分比，jp-burst 返回像素坐标。
 * 扩展过去一律当百分比用，于是 [210,300,460,340] 被画到图的 210% 处 ——
 * 译文直接跑出画面。这不是「偶尔不准」，是「同一批请求里坐标系会变」。
 */

import { describe, expect, it } from 'vitest';

import {
  detectBoxSystem,
  mergeDuplicateBoxes,
  sanitizeVisionItems,
  toPercentBox
} from '../src/core/vision-box.js';

describe('detectBoxSystem', () => {
  it('全是 0-100 判为 percent', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [10, 20, 60, 40] }], 800, 1200)).toBe('percent');
  });

  it('全是 0-1 判为 normalized', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [0.1, 0.2, 0.6, 0.4] }], 800, 1200)).toBe('normalized');
  });

  it('超过 100 且不超过 1000 判为 thousandth（0-1000 归一化）', () => {
    /* 实测证据：kr-strip 900×1600 返回最大 827，按像素算覆盖率 0.05，
       按 0-1000 算覆盖率 0.88 —— 像素解释是错的，别再按「在图片内就是像素」判。 */
    const items = [
      { text: 'うわあぁっ！', zh: '哇啊！', box: [210, 300, 460, 340] },
      { text: '行く。', zh: '去。', box: [190, 760, 280, 800] }
    ];
    expect(detectBoxSystem(items, 800, 1000)).toBe('thousandth');
  });

  it('超过 1000 且落在图片范围内才判 pixels', () => {
    const items = [{ text: 'a', zh: 'A', box: [1200, 300, 2600, 900] }];
    expect(detectBoxSystem(items, 3000, 4000)).toBe('pixels');
  });

  it('小图上也不把 900 当像素', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [100, 300, 900, 700] }], 400, 300)).toBe('thousandth');
  });

  it('超过 1000 且超出图片范围，判为 unknown', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [10, 20, 5000, 40] }], 800, 1200)).toBe('unknown');
  });

  it('没有框时返回 unknown', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: null }], 800, 1200)).toBe('unknown');
  });

  it('图片尺寸未知也能判 0-1000 —— 这个约定不依赖尺寸', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [210, 300, 460, 340] }], 0, 0)).toBe('thousandth');
  });

  it('尺寸未知且数值超过 1000 时判 unknown（没法确认是像素）', () => {
    expect(detectBoxSystem([{ text: 'a', zh: 'A', box: [1200, 300, 2600, 900] }], 0, 0)).toBe('unknown');
  });
});

describe('toPercentBox', () => {
  it('percent 原样保留', () => {
    expect(toPercentBox([10, 20, 60, 40], 'percent', 800, 1200)).toEqual([10, 20, 60, 40]);
  });

  it('normalized 乘 100', () => {
    expect(toPercentBox([0.1, 0.25, 0.6, 0.5], 'normalized', 800, 1200)).toEqual([10, 25, 60, 50]);
  });

  it('pixels 按图片宽高分别换算', () => {
    /* 800×1000 的图上，x 除以 800、y 除以 1000 */
    expect(toPercentBox([80, 300, 400, 500], 'pixels', 800, 1000)).toEqual([10, 30, 50, 50]);
  });

  it('thousandth 除以 10', () => {
    expect(toPercentBox([100, 200, 600, 400], 'thousandth', 800, 1000)).toEqual([10, 20, 60, 40]);
  });

  it('坐标反写（x2 < x1）自动纠正顺序', () => {
    expect(toPercentBox([60, 40, 10, 20], 'percent', 800, 1200)).toEqual([10, 20, 60, 40]);
  });

  it('越界钳制到 0-100', () => {
    expect(toPercentBox([-20, -5, 210, 130], 'percent', 800, 1200)).toEqual([0, 0, 100, 100]);
  });

  it('像素坐标换算后越界也要钳制（模型给的框经常超出图片）', () => {
    expect(toPercentBox([620, 550, 910, 620], 'pixels', 800, 1000)).toEqual([77.5, 55, 100, 62]);
  });

  it('面积为 0 返回 null', () => {
    expect(toPercentBox([10, 20, 10, 40], 'percent', 800, 1200)).toBeNull();
  });

  it('窄到 0.5% 以下的框算不可用', () => {
    expect(toPercentBox([10, 20, 10.2, 40], 'percent', 800, 1200)).toBeNull();
  });

  it('含 NaN 返回 null', () => {
    expect(toPercentBox([Number.NaN, 20, 60, 40], 'percent', 800, 1200)).toBeNull();
  });

  it('长度不是 4 返回 null', () => {
    expect(toPercentBox([10, 20, 60] as unknown as number[], 'percent', 800, 1200)).toBeNull();
  });
});

describe('sanitizeVisionItems', () => {
  it('0-1000 坐标的一批条目全部被换算成百分比', () => {
    const items = [
      { text: 'うわあぁっ！', zh: '哇啊！', box: [210, 300, 460, 340] },
      { text: '本当に行くの？', zh: '你真的要去吗？', box: [620, 550, 910, 620] }
    ];
    const out = sanitizeVisionItems(items, 800, 1000);
    expect(out.system).toBe('thousandth');
    expect(out.items).toHaveLength(2);
    for (const it of out.items) {
      for (const v of it.box!) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    /* 210/10 = 21，460/10 = 46 —— 0-1000 归一化的换算 */
    expect(out.items[0].box).toEqual([21, 30, 46, 34]);
  });

  it('没有文本的条目被丢掉', () => {
    const out = sanitizeVisionItems([{ text: '  ', zh: 'x', box: [1, 1, 20, 20] }], 800, 1200);
    expect(out.items).toHaveLength(0);
  });

  it('框不可用但译文有用的条目被保留，box 变成 null（交由气泡检测兜底）', () => {
    const out = sanitizeVisionItems([{ text: '你好', zh: '你好', box: [10, 10, 10, 10] }], 800, 1200);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].box).toBeNull();
    expect(out.droppedBox).toBe(1);
  });

  it('统计越界钳制的条目数', () => {
    const out = sanitizeVisionItems(
      [
        { text: 'a', zh: 'A', box: [-5, 10, 40, 30] },
        { text: 'b', zh: 'B', box: [10, 10, 40, 30] }
      ],
      800,
      1200
    );
    expect(out.clamped).toBe(1);
  });
});

describe('mergeDuplicateBoxes', () => {
  it('同一块被报两次时合并成一条，保留更长的原文', () => {
    const items = [
      { text: 'でも、まだ言えてないことがあ', zh: '可是，还有话没说出来', box: [17, 42, 53, 63] as number[] | null },
      { text: 'でも、まだ言えてないことがある', zh: '可是，还有话没说出来', box: [18, 43, 54, 64] as number[] | null }
    ];
    const out = mergeDuplicateBoxes(items);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].text).toBe('でも、まだ言えてないことがある');
    expect(out.merged).toBe(1);
  });

  it('竖排两列（框相邻不重叠）不合并 —— 它们是同一气泡里的两列，但各自都要画', () => {
    const items = [
      { text: 'でも、まだ', zh: 'A', box: [40, 44, 48, 61] as number[] | null },
      { text: '言えてない', zh: 'B', box: [35, 44, 40, 61] as number[] | null }
    ];
    const out = mergeDuplicateBoxes(items);
    expect(out.items).toHaveLength(2);
  });

  it('框完全无关的不合并', () => {
    const items = [
      { text: 'ひとつ', zh: 'A', box: [5, 5, 20, 15] as number[] | null },
      { text: 'ふたつ', zh: 'B', box: [60, 60, 90, 80] as number[] | null }
    ];
    expect(mergeDuplicateBoxes(items).items).toHaveLength(2);
  });

  it('没有 box 的条目不参与合并', () => {
    const items = [
      { text: 'a', zh: 'A', box: null },
      { text: 'b', zh: 'B', box: null }
    ];
    expect(mergeDuplicateBoxes(items).items).toHaveLength(2);
  });
});
