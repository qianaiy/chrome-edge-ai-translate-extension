import { describe, it, expect } from 'vitest';
import {
  fnv,
  translationCacheKey,
  cacheKeyParts,
  selectGlossaryEntries,
  glossaryInstruction,
  checkGlossary,
  looksTechnical,
  type Glossary
} from '../src/core/cache.js';

describe('缓存键', () => {
  const base = {
    model: 'gpt-4o-mini',
    targetLang: '简体中文',
    prompt: '你是专业翻译…',
    extraPrompt: '',
    glossaryVersion: '',
    text: 'Hello world'
  };

  it('同样的输入得到同样的键', () => {
    expect(translationCacheKey(base)).toBe(translationCacheKey({ ...base }));
  });

  it('★ 改提示词后键要变（否则改了提示词还拿旧译文）', () => {
    const a = translationCacheKey(base);
    const b = translationCacheKey({ ...base, prompt: base.prompt + ' 多加一条规则' });
    expect(a).not.toBe(b);
  });

  it('★ 改附加要求后键要变', () => {
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, extraPrompt: '统一用「你」' })
    );
  });

  it('★ 改模型后键要变', () => {
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, model: 'deepseek-chat' })
    );
  });

  it('★ 改目标语言后键要变', () => {
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, targetLang: 'English' })
    );
  });

  it('★ 改术语表版本后键要变', () => {
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, glossaryVersion: 'abc123' })
    );
  });

  it('★ 原文不同键要不同', () => {
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, text: 'Hello world!' })
    );
  });

  it('缺字段也不会崩', () => {
    expect(() => translationCacheKey({} as any)).not.toThrow();
    expect(() => translationCacheKey({ text: 'x' } as any)).not.toThrow();
  });

  it('cacheKeyParts 把所有影响因素都带上', () => {
    const parts = cacheKeyParts(base);
    for (const v of [base.model, base.targetLang, base.prompt, base.text]) {
      expect(parts).toContain(v);
    }
  });

  it('fnv 稳定且不同输入不同', () => {
    expect(fnv('abc')).toBe(fnv('abc'));
    expect(fnv('abc')).not.toBe(fnv('abd'));
  });
});

describe('术语表 · 挑选', () => {
  const glossary: Glossary = {
    entries: [
      { source: 'service worker', target: '服务工作线程' },
      { source: 'mod', target: '模组' },
      { source: 'Shadow DOM', target: 'Shadow DOM', match: 'exact' },
      { source: 'cache', target: '缓存', scope: 'technical' }
    ]
  };

  it('命中原文里的术语', () => {
    const hits = selectGlossaryEntries(glossary, 'The service worker handles it.');
    expect(hits.map(h => h.source)).toContain('service worker');
  });

  it('没命中就不返回', () => {
    const hits = selectGlossaryEntries(glossary, 'completely unrelated text');
    expect(hits).toHaveLength(0);
  });

  it('★ exact 匹配区分大小写', () => {
    expect(selectGlossaryEntries(glossary, 'Shadow DOM is tricky')).toHaveLength(1);
    expect(selectGlossaryEntries(glossary, 'shadow dom is tricky')).toHaveLength(0);
  });

  it('默认是大小写不敏感', () => {
    const hits = selectGlossaryEntries(glossary, 'SERVICE WORKER');
    expect(hits.map(h => h.source)).toContain('service worker');
  });

  it('★ technical 范围的术语只在技术内容里出现', () => {
    const tech = selectGlossaryEntries(glossary, 'clear the cache in the config.json');
    expect(tech.map(h => h.source)).toContain('cache');

    const plain = selectGlossaryEntries(glossary, 'a nice afternoon walk');
    expect(plain.map(h => h.source)).not.toContain('cache');
  });

  it('空术语表 / 空文本都不崩', () => {
    expect(selectGlossaryEntries(null, 'text')).toEqual([]);
    expect(selectGlossaryEntries({ entries: [] }, 'text')).toEqual([]);
    expect(selectGlossaryEntries(glossary, '')).toEqual([]);
  });

  it('优先级高的排前面', () => {
    const g = {
      entries: [
        { source: 'a', target: 'A' },
        { source: 'b', target: 'B', priority: 10 }
      ]
    };
    const hits = selectGlossaryEntries(g, 'a and b');
    expect(hits[0].source).toBe('b');
  });
});

describe('术语表 · 拼进提示词', () => {
  it('生成可读的约束说明', () => {
    const s = glossaryInstruction([{ source: 'mod', target: '模组' }]);
    expect(s).toContain('mod');
    expect(s).toContain('模组');
  });

  it('没有命中就不生成任何内容', () => {
    expect(glossaryInstruction([])).toBe('');
  });
});

describe('术语表 · 检查译文', () => {
  it('译文用了正确译法就通过', () => {
    const r = checkGlossary([{ source: 'mod', target: '模组' }], 'mod', '这个模组不错');
    expect(r[0].ok).toBe(true);
    expect(r[0].inSource).toBe(true);
  });

  it('译文没用规定译法就不通过', () => {
    const r = checkGlossary([{ source: 'mod', target: '模组' }], 'mod', '这个 MOD 不错');
    expect(r[0].ok).toBe(false);
  });

  it('★ 原文里根本没出现的词，译文里没有不算错', () => {
    const r = checkGlossary([{ source: 'service worker', target: '服务工作线程' }], 'mod', '这个模组');
    expect(r[0].inSource).toBe(false);
    expect(r[0].ok).toBe(true);
  });
});

describe('looksTechnical', () => {
  it('有代码特征算技术内容', () => {
    expect(looksTechnical('const timeout = 30;')).toBe(true);
    expect(looksTechnical('See https://example.com')).toBe(true);
    expect(looksTechnical('run npm install')).toBe(true);
  });

  it('普通句子不算', () => {
    expect(looksTechnical('今天天气不错，我们去公园散步吧。')).toBe(false);
  });
});
