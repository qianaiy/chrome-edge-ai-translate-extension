import { describe, it, expect } from 'vitest';
import { splitInlineMarks } from '../src/core/prompt.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 按文本节点分段的标记（{{1}} {{2}} …）。
 *
 * 段落里有链接/加粗时，扩展用这些标记把每个文本节点的位置标出来，
 * 模型照着保留，回来就能按位置分配 —— <a>、<b> 这些结构原样留着。
 */

describe('splitInlineMarks', () => {
  it('正常情况：每段落在自己的位置上', () => {
    expect(splitInlineMarks('{{1}}你好{{2}}世界', 2)).toEqual(['你好', '世界']);
  });

  it('模型在标记之间插了内容也各归各位', () => {
    expect(splitInlineMarks('{{1}}你好，{{2}}世界！', 2)).toEqual(['你好，', '世界！']);
  });

  it('标记数量对不上时返回 null（走逐条重译的兜底）', () => {
    expect(splitInlineMarks('{{1}}你好', 2)).toBeNull();
    expect(splitInlineMarks('你好世界', 2)).toBeNull();
  });

  it('模型丢掉某个标记时返回 null', () => {
    expect(splitInlineMarks('{{2}}世界', 2)).toBeNull();
  });

  it('标记前的多余内容接到第一段', () => {
    expect(splitInlineMarks('译文：{{1}}你好{{2}}世界', 2)).toEqual(['译文：你好', '世界']);
  });

  it('标记编号乱序时仍然按编号落位', () => {
    expect(splitInlineMarks('{{2}}世界{{1}}你好', 2)).toEqual(['你好', '世界']);
  });

  it('★ 编号超出范围时返回 null，不越界写数组', () => {
    /* count=3 但模型写成 {{2}}{{3}}{{4}} —— 数量刚好相等，
       如果不检查范围，k-1 会写到 out[3]，把内容挤到错误位置 */
    const r = splitInlineMarks('{{2}}甲{{3}}乙{{4}}丙', 3);
    expect(r).toBeNull();
  });

  it('★ 编号为 0 或负数时也返回 null', () => {
    expect(splitInlineMarks('{{0}}甲{{1}}乙', 2)).toBeNull();
    expect(splitInlineMarks('{{-1}}甲{{1}}乙', 2)).toBeNull();
  });

  it('★ 重复编号时返回 null，而不是让后一段覆盖前一段', () => {
    /* 老断言是 ['乙','']：第一段节点显示第二段的内容，第二段节点变成空，
       而且不触发任何重试 —— 用户看到的是一段错位且缺字的译文 */
    expect(splitInlineMarks('{{1}}甲{{1}}乙', 2)).toBeNull();
  });

  it('count=0 时空文本返回空数组', () => {
    expect(splitInlineMarks('', 0)).toEqual([]);
  });
});

describe('扩展里的 splitInlineMarks 与核心一致', () => {
  it('content.js 里的实现跟核心库行为相同', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'extension', 'content', 'content.js'), 'utf8');

    /* 把扩展里的实现抠出来单独跑 */
    const body = src.match(/function splitInlineMarks\(text, count\) \{[\s\S]*?\n {2}\}/);
    expect(body, 'content.js 里应该能找到 splitInlineMarks').toBeTruthy();

    const INLINE_MARK = /\{\{\s*(\d+)\s*\}\}/g;
    const fn = new Function(
      'INLINE_MARK',
      `${body![0]}; return splitInlineMarks;`
    )(INLINE_MARK);

    const cases: [string, number][] = [
      ['{{1}}你好{{2}}世界', 2],
      ['{{1}}你好', 2],
      ['{{2}}世界', 2],
      ['译文：{{1}}你好{{2}}世界', 2],
      ['{{2}}甲{{3}}乙{{4}}丙', 3],
      ['{{0}}甲{{1}}乙', 2],
      ['{{1}}甲{{1}}乙', 2],
      ['', 0]
    ];

    for (const [text, count] of cases) {
      expect(fn(text, count), `text=${JSON.stringify(text)} count=${count}`).toEqual(
        splitInlineMarks(text, count)
      );
    }
  });
});
