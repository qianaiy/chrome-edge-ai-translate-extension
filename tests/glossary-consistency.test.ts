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
import { systemPrompt, systemPromptSingle } from '../src/core/prompt.js';

/**
 * 术语表以前在扩展里有一份复制品：两边算出的命中项如果不一样，
 * 扩展发出的提示词就跟测试里验证过的预期不符，而且没人会察觉。
 *
 * 现在 background.js 直接使用 src/core 的实现（importScripts 加载的 MXTCore），
 * 所以这里要守的不再是「两份实现结果相同」——而是**不许再长出第二份**。
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

describe('术语表 · 扩展不再保留第二份实现', () => {
  it('★ background.js 通过 MXT_CORE 拿到术语表与提示词函数', async () => {
    const src = await readFile(BG, 'utf8');
    const blocks = [...src.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*MXT_CORE;/g)].map(m => m[1]);

    const need = [
      'systemPrompt',
      'systemPromptSingle',
      'stripMarkers',
      'parseMarked',
      'MARK_RE',
      'looksTechnical',
      'selectGlossaryEntries'
    ];
    const found = blocks.map(b => new Set(b.split(',').map(s => s.trim()).filter(Boolean)));
    for (const name of need) {
      expect(
        found.some(set => set.has(name)),
        `MXT_CORE 解构里缺少 ${name}（实际块：${blocks.length} 个）`
      ).toBe(true);
    }
  });

  it('★ background.js 里没有这些函数的本地定义', async () => {
    const src = await readFile(BG, 'utf8');
    for (const name of [
      'systemPrompt',
      'systemPromptSingle',
      'stripMarkers',
      'parseMarked',
      'looksTechnical',
      'selectGlossaryEntries',
      'glossaryInstruction',
      'escapeRegExp'
    ]) {
      expect(src.includes(`function ${name}(`), `background.js 里又长出了 function ${name}`).toBe(false);
    }
  });

  it('★ selectGlossary 只是 settings 形状的薄包装', async () => {
    const src = await readFile(BG, 'utf8');
    const fn = grabBalanced(src, 'selectGlossary');
    expect(fn).toContain('selectGlossaryEntries(');
    /* 薄包装不该自己实现匹配逻辑 */
    expect(fn).not.toContain('toLowerCase');
    expect(fn).not.toContain('RegExp');
    /* 行数控制：真变厚了说明又抄回来了 */
    expect(fn.split('\n').length).toBeLessThanOrEqual(8);
  });
});

describe('术语表 · 确实进入提示词', () => {
  it('批量提示词带上这一批命中的术语', () => {
    const entries = selectGlossaryEntries(GLOSSARY, 'The service worker handles it.');
    const p = systemPrompt({ targetLang: '简体中文' }, entries);
    expect(p).toContain(glossaryInstruction(entries));
    expect(p).toContain('服务工作线程');
  });

  it('单段提示词同样带术语', () => {
    const entries = selectGlossaryEntries(GLOSSARY, 'clear the cache in config.json');
    const p = systemPromptSingle({ targetLang: '简体中文' }, entries);
    expect(p).toContain('缓存');
  });

  it('没有命中项时不塞术语段落', () => {
    const entries = selectGlossaryEntries(GLOSSARY, 'a nice afternoon walk');
    expect(entries.length).toBe(0);
    const p = systemPrompt({ targetLang: '简体中文' }, entries);
    /* 注意：提示词里本来就有一句「保持原文语气与术语」，所以不能拿「术语」二字判断，
       要比的是「跟不传术语时完全一致」，也就是没有多出任何术语段落。 */
    expect(p).toBe(systemPrompt({ targetLang: '简体中文' }));
  });

  it('不传术语时提示词与传空数组一致（缓存键不变的前提）', () => {
    const s = { targetLang: '简体中文' };
    expect(systemPrompt(s)).toBe(systemPrompt(s, []));
    expect(systemPromptSingle(s)).toBe(systemPromptSingle(s, []));
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

describe('looksTechnical · 核心实现（扩展直接使用）', () => {
  it('识别出代码与技术文本', () => {
    expect(looksTechnical('const timeout = 30;')).toBe(true);
    expect(looksTechnical('a nice afternoon walk')).toBe(false);
    for (const t of TEXTS) {
      /* 只要求是布尔值且不抛错；具体取值由 cache.test.ts 全面覆盖 */
      expect(typeof looksTechnical(t)).toBe('boolean');
    }
  });
});
