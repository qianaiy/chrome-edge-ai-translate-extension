import { describe, it, expect } from 'vitest';
import { fitText } from '../src/core/inpaint.js';

/**
 * 竖排文字的框（又高又窄）。
 *
 * 日式漫画里竖排对白很常见，模型给的框因此可能又窄又高。
 * 中文译文按横排塞进一个 60×300 的窄框里，会遇到两个问题：
 *   - 每行只能放两三个字 → 行数爆炸
 *   - 行数超过框高能容纳的数量 → 被截断成一堆省略号
 *
 * 结论：窄高框里的译文要**允许字号更小**，否则根本排不下。
 */
describe('竖排文字框（窄高）', () => {
  it('★ 窄高框里的译文能排完，不会只剩省略号', () => {
    const r = fitText('这是竖排文字的译文', 60, 300);
    /* 不能全是省略号 —— 至少要有实际内容 */
    const realText = r.lines.join('').replace(/…/g, '');
    expect(realText.length).toBeGreaterThan(0);
  });

  it('★ 窄高框的每一行都不超过框宽', () => {
    const r = fitText('这是竖排文字的译文', 60, 300);
    for (const line of r.lines) {
      /* 字号小时一行 60px 能放几个汉字 */
      expect(line.length * r.fontSize).toBeLessThanOrEqual(60 * 1.2);
    }
  });

  it('★ 窄高框不会把字号缩到看不见', () => {
    const r = fitText('这是竖排文字的译文', 60, 300);
    expect(r.fontSize).toBeGreaterThanOrEqual(10);
  });

  it('★ 高框能容纳很多行，长文本也排得下', () => {
    const r = fitText('这是一段比较长的竖排对白内容需要好好排一下', 80, 400);
    expect(r.lines.length).toBeGreaterThan(1);
    /* 框高 400，最小字号 10、行高 1.22 → 能放 32 行，够用 */
    expect(r.lines.length).toBeLessThanOrEqual(32);
  });

  it('横排对照：宽扁框正常放一行', () => {
    const r = fitText('这是横排文字的译文', 300, 60);
    expect(r.lines.length).toBeGreaterThanOrEqual(1);
    expect(r.fontSize).toBeGreaterThan(15);
  });

  it('极窄的框（比一个字还窄）也不崩', () => {
    expect(() => fitText('测试文本', 8, 200)).not.toThrow();
    const r = fitText('测试文本', 8, 200);
    expect(r.fontSize).toBeGreaterThanOrEqual(10);
  });
});
