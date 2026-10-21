import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 缺陷 2：isSameLanguage 把日文、韩文都当成中文。
 *
 * 原文的正则把汉字、假名、谚文一起算成「cjk」，所以目标语言是中文时，
 * 日文页面和韩文页面都被判为「已经是目标语言」，一个块都不收。
 *
 * 结果：用户翻日文页 / 韩文页，页面一个字都不变，提示还写「没有可翻的内容」。
 */

const CONTENT = join(process.cwd(), 'src', 'extension', 'content', 'content.js');

/** 把 content.js 里的 isSameLanguage 抠出来跑 */
async function loadIsSameLanguage(): Promise<(text: string, target: string) => boolean> {
  const src = await readFile(CONTENT, 'utf8');
  const m = src.match(/function isSameLanguage\(text, target\) \{[\s\S]*?\n {2}\}/);
  expect(m, 'content.js 里应该能找到 isSameLanguage').toBeTruthy();
  /* 日文页面光看汉字分不出来，要读 <html lang>，所以给个最小的 document 桩 */
  const documentStub = { documentElement: { lang: '' } };
  return new Function('document', `${m![0]}; return isSameLanguage;`)(documentStub) as (
    t: string,
    g: string
  ) => boolean;
}

describe('缺陷 2 · isSameLanguage 不该把日文/韩文当中文', () => {
  let isSame: (text: string, target: string) => boolean;

  beforeAll(async () => {
    isSame = await loadIsSameLanguage();
  });

  it('★ 日文不是简体中文', () => {
    expect(isSame('これは日本語のテキストです。', '简体中文')).toBe(false);
  });

  it('★ 韩文不是简体中文', () => {
    expect(isSame('이것은 한국어 텍스트입니다.', '简体中文')).toBe(false);
  });

  it('★ 繁体中文也是目标语言（简体/繁体算同一种）', () => {
    expect(isSame('這是繁體中文的句子。', '简体中文')).toBe(true);
  });

  it('★ 简体中文是目标语言', () => {
    expect(isSame('这是简体中文的句子。', '简体中文')).toBe(true);
  });

  it('英文不是简体中文', () => {
    expect(isSame('This is an English sentence.', '简体中文')).toBe(false);
  });

  it('目标语言是日文时，日文是目标语言', () => {
    expect(isSame('これは日本語です。', '日本語')).toBe(true);
  });

  it('目标语言是日文时，中文不是', () => {
    expect(isSame('这是中文。', '日本語')).toBe(false);
  });

  it('目标语言是韩文时，韩文是目标语言', () => {
    expect(isSame('이것은 한국어입니다.', '한국어')).toBe(true);
  });

  it('目标语言是英文时，英文是目标语言', () => {
    expect(isSame('This is English.', 'English')).toBe(true);
  });

  it('没有文字时不当成别的语言（不打扰用户）', () => {
    expect(isSame('', '简体中文')).toBe(true);
    expect(isSame('123 456', '简体中文')).toBe(true);
  });
});
