import { describe, it, expect } from 'vitest';
import { systemPrompt, systemPromptSingle, parseMarked, stripMarkers } from '../src/core/prompt.js';

describe('systemPrompt', () => {
  it('包含目标语言', () => {
    const p = systemPrompt({ targetLang: '英文' });
    expect(p).toContain('英文');
  });

  it('包含编号规则列表 1..6', () => {
    const p = systemPrompt({ targetLang: '英文' });
    expect(p).toContain('1.');
    expect(p).toContain('2.');
    expect(p).toContain('3.');
    expect(p).toContain('4.');
    expect(p).toContain('5.');
    expect(p).toContain('6.');
  });

  it('规则里要求沿用 <<<n>>> 标记', () => {
    expect(systemPrompt({ targetLang: '英文' })).toContain('<<<n>>>');
  });

  it('有 extraPrompt 时附加在末尾', () => {
    const p = systemPrompt({ targetLang: '英文', extraPrompt: '保持正式语气' });
    expect(p).toContain('额外要求：保持正式语气');
    expect(p.trim().endsWith('额外要求：保持正式语气')).toBe(true);
  });

  it('没有 extraPrompt 时不出现附加要求', () => {
    expect(systemPrompt({ targetLang: '英文' })).not.toContain('额外要求');
  });

  it('extraPrompt 为空串时不出现附加要求', () => {
    expect(systemPrompt({ targetLang: '英文', extraPrompt: '' })).not.toContain('额外要求');
  });

  it('extraPrompt 只有空白时不出现附加要求', () => {
    expect(systemPrompt({ targetLang: '英文', extraPrompt: '   \n  ' })).not.toContain('额外要求');
  });

  it('目标语言不同则内容不同', () => {
    expect(systemPrompt({ targetLang: '日文' })).toContain('日文');
    expect(systemPrompt({ targetLang: '日文' })).not.toBe(systemPrompt({ targetLang: '英文' }));
  });
});

describe('systemPromptSingle', () => {
  it('包含目标语言', () => {
    expect(systemPromptSingle({ targetLang: '英文' })).toContain('英文');
  });

  it('不含 <<<n>>> 标记规则', () => {
    expect(systemPromptSingle({ targetLang: '英文' })).not.toContain('<<<n>>>');
  });

  it('与批量版 systemPrompt 不同', () => {
    expect(systemPromptSingle({ targetLang: '英文' })).not.toBe(systemPrompt({ targetLang: '英文' }));
  });

  it('有 extraPrompt 时附加在末尾', () => {
    const p = systemPromptSingle({ targetLang: '英文', extraPrompt: '保持正式语气' });
    expect(p).toContain('额外要求：保持正式语气');
  });

  it('extraPrompt 为空白时不出现附加要求', () => {
    expect(systemPromptSingle({ targetLang: '英文', extraPrompt: '  ' })).not.toContain('额外要求');
  });
});

describe('parseMarked', () => {
  it('按标记切分出每一段', () => {
    expect(parseMarked('<<<1>>>a\n<<<2>>>b', 2)).toEqual(['a', 'b']);
  });

  it('标记后有多行文本时保留换行', () => {
    expect(parseMarked('<<<1>>>第一行\n第二行\n<<<2>>>b', 2)).toEqual(['第一行\n第二行', 'b']);
  });

  it('缺少某段时该位为 null（驱动逐条重试）', () => {
    const out = parseMarked('<<<1>>>a\n<<<2>>>b', 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('a');
    expect(out[1]).toBe('b');
    expect(out[2]).toBeNull();
  });

  it('完全没标记时全是 null', () => {
    expect(parseMarked('没有任何标记', 2)).toEqual([null, null]);
  });

  it('某段内容为空时该位保持 null', () => {
    const out = parseMarked('<<<1>>>\n<<<2>>>b', 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe('b');
  });

  it('序号超出范围时不抛错', () => {
    const out = parseMarked('<<<1>>>a\n<<<99>>>x', 2);
    expect(out).toEqual(['a', null]);
  });

  it('序号为 0 或负号时忽略且不抛错', () => {
    const out = parseMarked('<<<0>>>x\n<<<1>>>a', 1);
    expect(out).toEqual(['a']);
  });

  it('标记内有空格也能识别', () => {
    expect(parseMarked('<<< 1 >>>a\n<<< 2 >>>b', 2)).toEqual(['a', 'b']);
  });

  it('count=0 时返回空数组', () => {
    expect(parseMarked('<<<1>>>a', 0)).toEqual([]);
  });

  it('重复调用不会受上次 lastIndex 影响', () => {
    const first = parseMarked('<<<1>>>a\n<<<2>>>b', 2);
    const second = parseMarked('<<<1>>>a\n<<<2>>>b', 2);
    expect(second).toEqual(first);
  });

  it('标记前有前言不影响切分', () => {
    expect(parseMarked('好的：\n<<<1>>>a\n<<<2>>>b', 2)).toEqual(['a', 'b']);
  });
});

describe('stripMarkers', () => {
  it('去掉开头的编号标记并 trim', () => {
    expect(stripMarkers('<<<1>>>hello')).toBe('hello');
  });

  it('带空格也能去掉', () => {
    expect(stripMarkers('  <<< 12 >>>  hello  ')).toBe('hello');
  });

  it('没有标记时原样返回并 trim', () => {
    expect(stripMarkers('  hello  ')).toBe('hello');
  });

  it('空串返回空串', () => {
    expect(stripMarkers('')).toBe('');
  });

  it('只去掉最前面的一个标记', () => {
    expect(stripMarkers('<<<1>>><<<2>>>x')).toBe('<<<2>>>x');
  });
});
