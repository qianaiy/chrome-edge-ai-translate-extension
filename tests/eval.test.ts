import { describe, it, expect } from 'vitest';
import {
  scoreTranslation,
  summarize,
  parseModelOutput,
  effectiveLength,
  lengthRatio,
  stripCodeFence,
  LENGTH_RATIO_MIN,
  LENGTH_RATIO_MAX,
  type EvalCase,
  type CaseScore
} from '../src/core/eval.js';

/* ------------------------------------------------------------------ *
 * 测试用的用例
 * ------------------------------------------------------------------ */

const plainCase: EvalCase = {
  id: 'plain-1',
  category: 'plain',
  source: 'Welcome aboard! Your account is ready.',
  targetLang: '简体中文',
  mustKeep: []
};

const placeholderCase: EvalCase = {
  id: 'ph-1',
  category: 'placeholder',
  source: 'Hello {name}, your invoice for %s is ready. Ref: {{1}}',
  targetLang: '简体中文',
  mustKeep: ['{name}', '%s', '{{1}}']
};

const targetCase: EvalCase = {
  id: 'at-1',
  category: 'already-target',
  source: '今天的会议改到下午三点。',
  targetLang: '简体中文',
  mustKeep: [],
  alreadyTarget: true
};

const longCase: EvalCase = {
  id: 'long-1',
  category: 'long',
  source:
    'Our team has been working on the new billing system for the past six months. The goal was to make invoices easier to read and to give customers a clear view of what they are paying for each month. During the rewrite we replaced a single large table with a set of smaller ones.',
  targetLang: '简体中文',
  mustKeep: []
};

/* ------------------------------------------------------------------ *
 * scoreTranslation
 * ------------------------------------------------------------------ */

describe('scoreTranslation', () => {
  it('译文合格时通过，所有检查项都是通过的', () => {
    const s = scoreTranslation(plainCase, '欢迎加入！您的账户已经就绪。');
    expect(s.passed).toBe(true);
    expect(s.failed).toEqual([]);
    expect(s.id).toBe('plain-1');
    expect(s.category).toBe('plain');
    expect(s.checks.length).toBeGreaterThanOrEqual(4);
  });

  it('译文为空时不通过（notEmpty 失败）', () => {
    const s = scoreTranslation(plainCase, '');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('notEmpty');
  });

  it('只有空白也算空译文', () => {
    const s = scoreTranslation(plainCase, '   \n  ');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('notEmpty');
  });

  it('占位符全部保留时通过', () => {
    const s = scoreTranslation(
      placeholderCase,
      '您好 {name}，您的 %s 发票已经生成。编号：{{1}}'
    );
    expect(s.passed).toBe(true);
    expect(s.failed).toEqual([]);
  });

  it('占位符被吃掉时不通过，并报出丢了哪些', () => {
    const s = scoreTranslation(placeholderCase, '您好，您的发票已经生成。');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('placeholders');
    const detail = s.checks.find(c => c.name === 'placeholders')!.detail;
    expect(detail).toContain('{name}');
    expect(detail).toContain('{{1}}');
  });

  it('只丢一个占位符也会被抓到', () => {
    const s = scoreTranslation(
      placeholderCase,
      '您好 {name}，您的 %s 发票已经生成。编号：{{2}}'
    );
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('placeholders');
  });

  it('原文已是目标语言时，译文必须与原文一致', () => {
    const s = scoreTranslation(targetCase, targetCase.source);
    expect(s.passed).toBe(true);
    expect(s.checks.find(c => c.name === 'unchanged')!.passed).toBe(true);
  });

  it('原文已是目标语言却被改写时不通过', () => {
    const s = scoreTranslation(targetCase, '会议改到了下午 3 点。');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('unchanged');
  });

  it('非目标语言原文不做 unchanged 判定（标记为跳过）', () => {
    const s = scoreTranslation(plainCase, '欢迎加入！');
    const unchanged = s.checks.find(c => c.name === 'unchanged')!;
    expect(unchanged.skipped).toBe(true);
    expect(unchanged.passed).toBe(true);
  });

  it('译文被截断时长度比检查会失败', () => {
    const s = scoreTranslation(longCase, '我们的团队');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('lengthRatio');
  });



  it('原文复读两遍会被复读检查抓出来', () => {
    const repeated = longCase.source + ' ' + longCase.source;
    const s = scoreTranslation(longCase, repeated);
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('copySource');
  });

  it('译文只翻了一半（严重偏短）会被长度比抓出来', () => {
    const s = scoreTranslation(longCase, '我们的团队');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('lengthRatio');
  });

  it('模型没翻译、直接把原文吐回来会被抓出来', () => {
    const s = scoreTranslation(longCase, longCase.source);
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('copySource');
  });

  it('原文已是目标语言时不做复读检查（跳过）', () => {
    const s = scoreTranslation(targetCase, targetCase.source);
    expect(s.checks.find(c => c.name === 'copySource')!.skipped).toBe(true);
    expect(s.passed).toBe(true);
  });

  it('很短的原��不做长度比判定（跳过）', () => {
    const short: EvalCase = {
      id: 'short-1',
      category: 'tricky',
      source: '保存',
      targetLang: 'English',
      mustKeep: []
    };
    const s = scoreTranslation(short, 'Save');
    expect(s.passed).toBe(true);
    expect(s.checks.find(c => c.name === 'lengthRatio')!.skipped).toBe(true);
  });

  it('译文里残留 <<<n>>> 标记会被抓出来', () => {
    const s = scoreTranslation(plainCase, '<<<1>>>欢迎加入！');
    expect(s.passed).toBe(false);
    expect(s.failed).toContain('markerLeak');
  });

  it('没有 mustKeep 时 placeholders 检查标记为跳过', () => {
    const s = scoreTranslation(plainCase, '欢迎加入！');
    expect(s.checks.find(c => c.name === 'placeholders')!.skipped).toBe(true);
  });

  it('译文可以是数组（多段拼接后打分）', () => {
    const s = scoreTranslation(plainCase, ['欢迎加入！', '您的账户已经就绪。']);
    expect(s.passed).toBe(true);
    expect(s.output).toContain('欢迎加入！');
  });

  it('mustKeep 为 undefined 时不报错', () => {
    const s = scoreTranslation(
      { id: 'x', category: 'plain', source: 'Hello world', targetLang: '简体中文' } as EvalCase,
      '你好世界'
    );
    expect(s.passed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * summarize
 * ------------------------------------------------------------------ */

describe('summarize', () => {
  const mk = (id: string, category: string, passed: boolean): CaseScore => ({
    id,
    category,
    passed,
    output: '',
    checks: [],
    failed: passed ? [] : ['notEmpty']
  });

  it('统计总数、通过数与通过率', () => {
    const s = summarize([mk('a', 'plain', true), mk('b', 'plain', false), mk('c', 'code', true)]);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3);
  });

  it('按分类给出小计', () => {
    const s = summarize([
      mk('a', 'plain', true),
      mk('b', 'plain', true),
      mk('c', 'code', false)
    ]);
    expect(s.byCategory.plain.total).toBe(2);
    expect(s.byCategory.plain.passed).toBe(2);
    expect(s.byCategory.plain.passRate).toBe(1);
    expect(s.byCategory.code.total).toBe(1);
    expect(s.byCategory.code.failed).toBe(1);
  });

  it('列出失败的用例 id', () => {
    const s = summarize([mk('a', 'plain', true), mk('bad-1', 'code', false)]);
    expect(s.failingIds).toEqual(['bad-1']);
  });

  it('空数组的通过率是 0，不报 NaN', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.failingIds).toEqual([]);
  });

  it('全部通过时失败列表为空', () => {
    const s = summarize([mk('a', 'plain', true)]);
    expect(s.failed).toBe(0);
    expect(s.failingIds).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * parseModelOutput
 * ------------------------------------------------------------------ */

describe('parseModelOutput', () => {
  it('带 <<<n>>> 标记时按序号切分', () => {
    expect(parseModelOutput('<<<1>>>你好\n<<<2>>>世界')).toEqual(['你好', '世界']);
  });

  it('标记带空格也能识别', () => {
    expect(parseModelOutput('<<< 1 >>>你好\n<<< 2 >>>世界')).toEqual(['你好', '世界']);
  });

  it('没有标记时按行切分', () => {
    expect(parseModelOutput('第一行\n第二行\n第三行')).toEqual(['第一行', '第二行', '第三行']);
  });

  it('没有标记时去掉行首的列表符号', () => {
    expect(parseModelOutput('- 第一条\n2. 第二条')).toEqual(['第一条', '第二条']);
  });

  it('包在 ```json 围栏里也能取出内容', () => {
    const raw = '```json\n["你好", "世界"]\n```';
    expect(parseModelOutput(raw)).toEqual(['你好', '世界']);
  });

  it('包在普通代码围栏里也能取出内容', () => {
    const raw = '```\n<<<1>>>你好\n<<<2>>>世界\n```';
    expect(parseModelOutput(raw)).toEqual(['你好', '世界']);
  });

  it('JSON 数组里带标记时把标记剥掉', () => {
    const raw = '```json\n["<<<1>>>你好"]\n```';
    expect(parseModelOutput(raw)).toEqual(['你好']);
  });

  it('缺段时保留位置（空字符串），不塌陷', () => {
    const out = parseModelOutput('<<<1>>>你好\n<<<3>>>世界');
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('你好');
    expect(out[1]).toBe('');
    expect(out[2]).toBe('世界');
  });

  it('完全没有任何标记也没有换行时返回整段', () => {
    expect(parseModelOutput('只有一个译文')).toEqual(['只有一个译文']);
  });

  it('标记前有前言不影响切分', () => {
    expect(parseModelOutput('好的：\n<<<1>>>你好')).toEqual(['你好']);
  });

  it('JSON 对象里的 translations 数组也能取出来', () => {
    const raw = '{"translations":["你好","世界"]}';
    expect(parseModelOutput(raw)).toEqual(['你好', '世界']);
  });

  it('空字符串返回空数组', () => {
    expect(parseModelOutput('')).toEqual([]);
  });

  it('标记里的换行保留在段内', () => {
    expect(parseModelOutput('<<<1>>>第一行\n第二行\n<<<2>>>b')).toEqual(['第一行\n第二行', 'b']);
  });
});

/* ------------------------------------------------------------------ *
 * 辅助函数
 * ------------------------------------------------------------------ */

describe('effectiveLength / lengthRatio', () => {
  it('空白不计入长度', () => {
    expect(effectiveLength('a b\nc')).toBe(3);
  });

  it('中文按字算', () => {
    expect(effectiveLength('你好世界')).toBe(4);
  });

  it('长度比是译文长度除以原文长度', () => {
    expect(lengthRatio('abcd', 'abcd')).toBe(1);
    expect(lengthRatio('abcd', 'ab')).toBe(0.5);
  });

  it('原文为空时长度比不报 NaN', () => {
    expect(Number.isNaN(lengthRatio('', 'x'))).toBe(false);
  });

  it('合理区间是常量，不会被改坏', () => {
    expect(LENGTH_RATIO_MIN).toBeGreaterThan(0);
    expect(LENGTH_RATIO_MAX).toBeGreaterThan(LENGTH_RATIO_MIN);
  });
});

describe('stripCodeFence', () => {
  it('去掉带语言标记的围栏', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('没有围栏时原样返回', () => {
    expect(stripCodeFence('hello')).toBe('hello');
  });

  it('去掉没闭合的围栏开头', () => {
    expect(stripCodeFence('```\nhello')).toBe('hello');
  });
});
