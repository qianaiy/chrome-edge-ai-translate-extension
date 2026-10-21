import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 评测用例集本身的完整性。
 *
 * 用例写错会让「模型做对了」被记成失败，或者反过来漏掉真问题。
 * 这组测试盯着几件容易写错的事。
 */

const CASES = join(process.cwd(), 'eval', 'cases.json');
const EXPECTED = join(process.cwd(), 'eval', 'expected.json');

interface EvalCase {
  id: string;
  category: string;
  source: string;
  targetLang: string;
  mustKeep: string[];
  note?: string;
}

const cases = JSON.parse(readFileSync(CASES, 'utf8')) as EvalCase[];
const expectedRaw = JSON.parse(readFileSync(EXPECTED, 'utf8')) as Record<string, unknown>;
const expected = (
  expectedRaw.answers && typeof expectedRaw.answers === 'object'
    ? expectedRaw.answers
    : expectedRaw
) as Record<string, string>;

const CATEGORIES = [
  'plain',
  'placeholder',
  'code',
  'already-target',
  'long',
  'mixed',
  'tricky',
  'subtitle',
  'comic'
];

describe('评测用例集 · 结构', () => {
  it('每条用例都有必需字段', () => {
    for (const c of cases) {
      expect(c.id, `用例缺 id: ${JSON.stringify(c)}`).toBeTruthy();
      expect(c.category, `${c.id} 缺 category`).toBeTruthy();
      expect(typeof c.source, `${c.id} 缺 source`).toBe('string');
      expect(c.targetLang, `${c.id} 缺 targetLang`).toBeTruthy();
      expect(Array.isArray(c.mustKeep), `${c.id} 的 mustKeep 应该是数组`).toBe(true);
    }
  });

  it('id 不重复', () => {
    const ids = cases.map(c => c.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup, `重复的 id: ${dup.join(', ')}`).toEqual([]);
  });

  it('分类都在允许列表里', () => {
    for (const c of cases) {
      expect(CATEGORIES, `${c.id} 的分类 ${c.category} 不在允许列表`).toContain(c.category);
    }
  });

  it('★ mustKeep 里的每一项都真的出现在 source 里', () => {
    /* 写错了的话，这个检查永远失败，但用户会以为模型没做好 */
    for (const c of cases) {
      if (!c.mustKeep || !c.mustKeep.length) continue;
      for (const k of c.mustKeep) {
        expect(c.source, `${c.id} 的 mustKeep「${k}」不在原文里`).toContain(k);
      }
    }
  });

  it('★ 每条用例都有参考答案（否则 dry-run 会跳过它）', () => {
    const missing = cases.filter(c => !(c.id in expected)).map(c => c.id);
    expect(missing, `缺参考答案: ${missing.join(', ')}`).toEqual([]);
  });

  it('参考答案里不该残留分段标记', () => {
    for (const [id, text] of Object.entries(expected)) {
      expect(String(text), `${id} 的参考答案里残留了 <<<>>>`).not.toMatch(/<<<\s*\d+\s*>>>/);
    }
  });

  it('每个分类至少有 3 条用例', () => {
    /* 少于 3 条的话，这一类的通过率没什么统计意义 */
    const byCat: Record<string, number> = {};
    for (const c of cases) byCat[c.category] = (byCat[c.category] || 0) + 1;
    for (const cat of CATEGORIES) {
      expect(byCat[cat] || 0, `分类 ${cat} 只有 ${byCat[cat] || 0} 条`).toBeGreaterThanOrEqual(3);
    }
  });

  it('★ mustKeep 里只有一个首字母大写单词的，只列出来供复核，不算失败', () => {
    /* mustKeep 是「提示词承诺原样保留的东西」（占位符/代码/URL）。
       单个人名不该写在这里 —— 人名要不要保留原文是术语表的职责，
       官方汉化里人名音译（Sophie→索菲）才是对的。

       但「单个首字母大写单词」也可能是产品名（Windows、Dashboard），
       保留原文是合理的。机器分不清这两者，所以这里只**列出来**，
       由人复核，不直接判失败 —— 否则这个测试会逼着人写死一份产品名清单，
       而那清单永远不全。

       真正的约束在上面那条：mustKeep 必须真的出现在 source 里。 */
    const singleWord = /^[A-Z][a-z]{2,}$/;
    const candidates: string[] = [];
    for (const c of cases) {
      for (const k of c.mustKeep || []) {
        if (singleWord.test(k)) candidates.push(`${c.id}: ${k}`);
      }
    }
    /* 只是提示，不失败 */
    if (candidates.length) {
      console.log(
        `\n  [复核提示] mustKeep 里的单个大写单词（可能是人名，也可能是产品名）：\n    ${candidates.join(
          '\n    '
        )}\n`
      );
    }
    expect(true).toBe(true);
  });
});

describe('评测用例集 · 覆盖度', () => {
  it('覆盖了字幕和漫画两类', () => {
    const cats = new Set(cases.map(c => c.category));
    expect(cats.has('subtitle')).toBe(true);
    expect(cats.has('comic')).toBe(true);
  });

  it('字幕类覆盖了口语特征（无标点 / 断句 / 重复）', () => {
    const subs = cases.filter(c => c.category === 'subtitle');
    const joined = subs.map(c => c.source).join(' ');
    /* 至少要有：没有句末标点的、带破折号的、重复词的 */
    expect(subs.some(c => !/[.!?]$/.test(c.source))).toBe(true);
    expect(joined).toMatch(/—/);
    expect(joined).toMatch(/\b(\w+)\s+\1\b/i);
  });

  it('漫画类覆盖了拟声词和语气差异', () => {
    const comics = cases.filter(c => c.category === 'comic');
    const ids = comics.map(c => c.id).join(' ');
    expect(ids).toMatch(/sfx/);
    expect(ids).toMatch(/sarcasm|threat|honorific/);
  });

  it('每个分类都有 targetLang', () => {
    for (const c of cases) {
      expect(typeof c.targetLang).toBe('string');
      expect(c.targetLang.length).toBeGreaterThan(0);
    }
  });
});
