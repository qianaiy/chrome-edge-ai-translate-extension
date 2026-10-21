import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fitText, estimateTextWidth } from '../src/core/inpaint.js';

/**
 * 漫画译文的排版。
 *
 * 漫画里「原文很短、译文很长」很常见：一句英文翻成中文可能长一倍多。
 * 直接按原框高度画字号，译文就会溢出气泡、盖住旁边的画面。
 */

describe('estimateTextWidth', () => {
  it('汉字约等于一个字号的宽度', () => {
    expect(estimateTextWidth('中文', 20)).toBeCloseTo(40);
  });

  it('拉丁字母窄一些', () => {
    expect(estimateTextWidth('ab', 20)).toBeLessThan(40);
    expect(estimateTextWidth('ab', 20)).toBeGreaterThan(15);
  });

  it('空格和标点不算宽度', () => {
    expect(estimateTextWidth('   ', 20)).toBe(0);
  });
});

describe('fitText', () => {
  it('★ 短译文用大字号（贴着框高）', () => {
    const r = fitText('好', 200, 40);
    expect(r.fontSize).toBeGreaterThan(20);
    expect(r.lines).toHaveLength(1);
    expect(r.shrunk).toBe(false);
  });

  it('★ 长译文会缩字号', () => {
    const short = fitText('好', 200, 40);
    const long = fitText(
      '这是一句相当长的中文译文，原文只是短短几个英文单词而已所以这里会放不下',
      200,
      40
    );
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(long.shrunk).toBe(true);
  });

  it('★ 不会超出框的宽度', () => {
    const w = 200;
    const r = fitText('这是一段很长的中文译文需要折行才能放进这个框子里', w, 40);
    for (const line of r.lines) {
      expect(estimateTextWidth(line, r.fontSize)).toBeLessThanOrEqual(w * 1.05);
    }
  });

  it('★ 行数不超过框高能容纳的行数', () => {
    const h = 40;
    const r = fitText('很长很长的译文'.repeat(20), 200, h);
    const maxLines = Math.max(1, Math.floor(h / (10 * 1.22)));
    expect(r.lines.length).toBeLessThanOrEqual(maxLines);
  });

  it('★ 放不下时截断加省略号，不会画到框外面', () => {
    const r = fitText('很长很长的译文'.repeat(50), 100, 20, { minFontSize: 10 });
    expect(r.lines.length).toBeLessThanOrEqual(1);
    expect(r.lines[0].endsWith('…')).toBe(true);
  });

  it('★ 缩到最小字号还是放不下，也要保证不超行数', () => {
    const r = fitText('A'.repeat(500), 60, 20, { minFontSize: 12, maxFontSize: 30 });
    expect(r.fontSize).toBeGreaterThanOrEqual(12);
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });

  it('英文按词断行', () => {
    const r = fitText('the quick brown fox jumps over the lazy dog', 200, 40);
    expect(r.lines.length).toBeGreaterThanOrEqual(1);
    for (const line of r.lines) {
      expect(line).not.toMatch(/^\s/);
    }
  });

  it('没有空格的长文本按字断', () => {
    const r = fitText('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 100, 30);
    expect(r.lines.length).toBeGreaterThan(1);
  });

  it('空文本不崩', () => {
    const r = fitText('', 100, 30);
    expect(r.lines).toEqual(['']);
    expect(r.height).toBe(0);
  });

  it('框尺寸为 0 也不崩', () => {
    expect(() => fitText('测试', 0, 0)).not.toThrow();
  });
});

describe('fitText · 扩展与核心一致', () => {
  it('★ comic.js 里的实现跟核心行为相同', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'extension', 'content', 'comic.js'), 'utf8');

    const grabBalanced = (s: string, name: string) => {
      const start = s.indexOf(`function ${name}(`);
      if (start < 0) throw new Error(`comic.js 里找不到 ${name}`);
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
    const ext = new Function(code)() as {
      estimateTextWidth: (t: string, s: number) => number;
      fitText: (t: string, w: number, h: number, o?: any) => any;
    };

    const cases: [string, number, number][] = [
      ['好', 200, 40],
      ['这是一段很长的中文译文需要折行', 200, 40],
      ['很长很长的译文'.repeat(20), 100, 20],
      ['the quick brown fox jumps over the lazy dog', 200, 40],
      ['一二三四五六七八九十'.repeat(6), 100, 30],
      ['', 100, 30]
    ];

    for (const [t, w, h] of cases) {
      expect(ext.fitText(t, w, h), `fitText(${JSON.stringify(t)}, ${w}, ${h})`).toEqual(
        fitText(t, w, h)
      );
      expect(ext.estimateTextWidth(t, 20)).toBe(estimateTextWidth(t, 20));
    }
  });
});
