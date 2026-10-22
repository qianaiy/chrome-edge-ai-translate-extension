import { describe, it, expect } from 'vitest';
import { parseMarked, splitInlineMarks } from '../src/core/prompt.js';
import { loadBackground } from './helpers/load-background.js';

/**
 * 分段标记的完整性与唯一性。
 *
 * 批量翻译把所有段落塞进一次请求，靠 <<<n>>> 切回来。模型偶尔会：
 *   - 把同一个编号写两次（复制粘贴、或被上一段的结尾带进去）
 *   - 跳过某个编号
 *   - 从 0 开始数
 *
 * 原来的实现遇到「同一编号出现两次」会**静默覆盖**：后一段的内容盖掉前一段，
 * 而该位置又不是 null，于是重试逻辑根本不会触发 —— 用户拿到一段错位的译文，
 * 不报错、不重试、无从察觉。这就是「结果覆盖」。
 *
 * 正确语义：同一编号出现多次时无法判断哪一份才是该段的译文，该位置必须是 null
 * （交给逐段重试），而不是随便挑一个。
 */

describe('parseMarked · 重复编号', () => {
  it('★ 同一编号出现两次时该位为 null，不拿后一段覆盖前一段', () => {
    const out = parseMarked('<<<1>>>甲\n<<<1>>>乙\n<<<2>>>丙', 2);
    expect(out[1]).toBe('丙');
    expect(out[0]).toBeNull();
  });

  it('★ 更重要的：被覆盖的内容不会冒充成该段的译文', () => {
    /* 老实现返回 ['乙','丙']：第一段显示的是第二段的内容，且不触发重试 */
    const out = parseMarked('<<<1>>>甲\n<<<1>>>乙\n<<<2>>>丙', 2);
    expect(out[0]).not.toBe('乙');
    expect(out[0]).not.toBe('甲');
  });

  it('中间某段重复时，只影响那一段，前后段照常', () => {
    const out = parseMarked('<<<1>>>甲\n<<<2>>>乙\n<<<2>>>丙\n<<<3>>>丁', 3);
    expect(out[0]).toBe('甲');
    expect(out[1]).toBeNull();
    expect(out[2]).toBe('丁');
  });

  it('只有一个编号且重复出现时也是 null', () => {
    expect(parseMarked('<<<1>>>甲\n<<<1>>>乙', 1)).toEqual([null]);
  });

  it('重复三次同样判为歧义', () => {
    expect(parseMarked('<<<1>>>甲\n<<<1>>>乙\n<<<1>>>丙', 1)).toEqual([null]);
  });

  it('重复的是空段时也不影响其他段', () => {
    const out = parseMarked('<<<1>>>甲\n<<<2>>>\n<<<2>>>\n<<<3>>>丙', 3);
    expect(out[0]).toBe('甲');
    expect(out[1]).toBeNull();
    expect(out[2]).toBe('丙');
  });
});

describe('parseMarked · 正常路径不能被改坏', () => {
  it('编号齐全时照常切分', () => {
    expect(parseMarked('<<<1>>>甲\n<<<2>>>乙\n<<<3>>>丙', 3)).toEqual(['甲', '乙', '丙']);
  });

  it('乱序但编号唯一时按编号落位', () => {
    expect(parseMarked('<<<3>>>丙\n<<<1>>>甲\n<<<2>>>乙', 3)).toEqual(['甲', '乙', '丙']);
  });

  it('缺一段时该段为 null，其余保留', () => {
    const out = parseMarked('<<<1>>>甲\n<<<3>>>丙', 3);
    expect(out).toEqual(['甲', null, '丙']);
  });

  it('越界编号被忽略，不影响合法编号', () => {
    expect(parseMarked('<<<1>>>甲\n<<<99>>>x\n<<<2>>>乙', 2)).toEqual(['甲', '乙']);
  });

  it('完全没有标记时全是 null', () => {
    expect(parseMarked('一段没有标记的文字', 2)).toEqual([null, null]);
  });

  it('count=0 返回空数组', () => {
    expect(parseMarked('<<<1>>>甲', 0)).toEqual([]);
  });
});

describe('parseMarked · 结果只能来自本段或 null', () => {
  /* 把「静默覆盖」表达成一条可枚举的性质：第 i 个位置的返回值，
     要么是 null，要么是原文里被标成 <<<i+1>>> 的那几段内容之一 ——
     绝不会是别的编号的段落。 */
  const cases: { text: string; count: number; allowed: string[][] }[] = [
    {
      text: '<<<1>>>甲\n<<<1>>>乙\n<<<2>>>丙',
      count: 2,
      allowed: [['甲', '乙'], ['丙']]
    },
    {
      /* 第 1 段根本没出现，所以只允许 null */
      text: '<<<2>>>乙\n<<<2>>>丙\n<<<3>>>丁',
      count: 3,
      allowed: [[], ['乙', '丙'], ['丁']]
    },
    {
      text: '<<<1>>>甲\n<<<1>>>甲',
      count: 1,
      allowed: [['甲']]
    }
  ];

  for (const c of cases) {
    it(`不串味：${JSON.stringify(c.text)}`, () => {
      const out = parseMarked(c.text, c.count);
      expect(out).toHaveLength(c.count);
      out.forEach((v, i) => {
        if (v !== null) {
          expect(
            c.allowed[i],
            `第 ${i + 1} 段出现了别段的内容：${JSON.stringify(v)}`
          ).toContain(v);
        }
      });
    });
  }
});

describe('splitInlineMarks · 重复编号', () => {
  it('★ 重复编号时返回 null（走逐条重译），不静默覆盖', () => {
    expect(splitInlineMarks('{{1}}甲{{1}}乙', 2)).toBeNull();
  });

  it('★ 不会把第二份内容当成第一段的译文', () => {
    const r = splitInlineMarks('{{1}}甲{{1}}乙', 2);
    expect(r).toBeNull();
  });

  it('重复 + 缺编号的组合同样返回 null', () => {
    expect(splitInlineMarks('{{2}}甲{{2}}乙', 2)).toBeNull();
  });

  it('正常唯一编号不受影响', () => {
    expect(splitInlineMarks('{{1}}甲{{2}}乙', 2)).toEqual(['甲', '乙']);
  });

  it('乱序但唯一时按编号落位', () => {
    expect(splitInlineMarks('{{2}}乙{{1}}甲', 2)).toEqual(['甲', '乙']);
  });
});

describe('扩展与核心的分段解析保持一致', () => {
  it('background.js 的 parseMarked 对重复编号同样返回 null', async () => {
    const bg = await loadBackground();
    const cases: [string, number][] = [
      ['<<<1>>>甲\n<<<1>>>乙\n<<<2>>>丙', 2],
      ['<<<1>>>甲\n<<<2>>>乙\n<<<2>>>丙\n<<<3>>>丁', 3],
      ['<<<1>>>甲\n<<<1>>>乙', 1],
      ['<<<1>>>甲\n<<<2>>>乙\n<<<3>>>丙', 3],
      ['<<<3>>>丙\n<<<1>>>甲\n<<<2>>>乙', 3],
      ['<<<1>>>甲\n<<<99>>>x\n<<<2>>>乙', 2],
      ['一段没有标记的文字', 2]
    ];
    for (const [text, count] of cases) {
      expect(bg.fns.parseMarked(text, count), `text=${JSON.stringify(text)} count=${count}`).toEqual(
        parseMarked(text, count)
      );
    }
  });
});
