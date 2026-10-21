import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  selectGlossaryEntries,
  glossaryInstruction,
  looksTechnical,
  translationCacheKey,
  type Glossary
} from '../src/core/cache.js';

/**
 * 扩展里的术语表逻辑跟核心库必须一致 ——
 * 两边算出的命中项不一样的话，扩展发出的提示词就跟预期不符。
 */

const BG = join(process.cwd(), 'src', 'extension', 'background.js');

/** 按括号配平抠出一个函数的完整源码 */
function grabBalanced(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`background.js 里找不到 ${name}`);
  let depth = 0;
  const bodyStart = src.indexOf('{', start);
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的括号没配平`);
}

/** 把 background.js 里的这几个函数抠出来跑 */
async function loadFns() {
  const src = await readFile(BG, 'utf8');
  const code = [
    grabBalanced(src, 'looksTechnical'),
    grabBalanced(src, 'escapeRegExp'),
    grabBalanced(src, 'selectGlossaryEntries'),
    grabBalanced(src, 'glossaryInstruction'),
    'return { looksTechnical, selectGlossaryEntries, glossaryInstruction };'
  ].join('\n');
  return new Function(`${code}`)() as {
    looksTechnical: (t: string) => boolean;
    selectGlossaryEntries: (g: any, t: string, scope?: string) => any[];
    glossaryInstruction: (e: any[]) => string;
  };
}

describe('术语表 · 扩展与核心一致', () => {
  let ext: Awaited<ReturnType<typeof loadFns>>;

  beforeAll(async () => {
    ext = await loadFns();
  });

  const GLOSSARY: Glossary = {
    entries: [
      { source: 'service worker', target: '服务工作线程' },
      { source: 'mod', target: '模组' },
      { source: 'Shadow DOM', target: 'Shadow DOM', match: 'exact' },
      { source: 'cache', target: '缓存', scope: 'technical' }
    ]
  };

  const TEXTS = [
    'The service worker handles it.',
    'completely unrelated text',
    'Shadow DOM is tricky',
    'shadow dom is tricky',
    'SERVICE WORKER',
    'clear the cache in config.json',
    'a nice afternoon walk',
    'const timeout = 30;',
    ''
  ];

  it('★ selectGlossaryEntries 结果完全一致', () => {
    for (const t of TEXTS) {
      expect(ext.selectGlossaryEntries(GLOSSARY, t), `text=${JSON.stringify(t)}`).toEqual(
        selectGlossaryEntries(GLOSSARY, t)
      );
    }
  });

  it('★ glossaryInstruction 结果完全一致', () => {
    for (const t of TEXTS) {
      const a = ext.selectGlossaryEntries(GLOSSARY, t);
      const b = selectGlossaryEntries(GLOSSARY, t);
      expect(ext.glossaryInstruction(a)).toBe(glossaryInstruction(b));
    }
  });

  it('★ looksTechnical 结果完全一致', () => {
    for (const t of TEXTS) {
      expect(ext.looksTechnical(t), `text=${JSON.stringify(t)}`).toBe(looksTechnical(t));
    }
  });
});

describe('缓存键 · 扩展与核心一致', () => {
  it('★ 扩展算出的键跟核心一致', async () => {
    const src = await readFile(BG, 'utf8');

    const code = [
      grabBalanced(src, 'fnv'),
      grabBalanced(src, 'cacheKey'),
      /* cacheKey 依赖 systemPrompt，这里给个固定的替身 */
      'function systemPrompt(s){ return "P:" + s.targetLang; }',
      'return cacheKey;'
    ].join('\n');
    const extCacheKey = new Function(code)() as (s: any, t: string) => string;

    const settings = {
      model: 'gpt-4o-mini',
      targetLang: '简体中文',
      extraPrompt: '统一用你',
      glossaryVersion: 'v1'
    };
    const text = 'Hello world';

    /* 核心这边也用同样的 systemPrompt 替身算一遍 */
    const coreKey = translationCacheKey({
      model: settings.model,
      targetLang: settings.targetLang,
      prompt: 'P:简体中文',
      extraPrompt: settings.extraPrompt,
      glossaryVersion: settings.glossaryVersion,
      text
    });

    expect(extCacheKey(settings, text)).toBe(coreKey);
  });
});
