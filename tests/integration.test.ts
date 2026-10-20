import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRequest, extractText } from '../src/core/protocol.js';
import { resolveBase, detectProvider } from '../src/core/provider.js';

/**
 * 扩展脚本（src/extension/background.js）与共享核心（src/core/）的一致性测试。
 *
 * 背景：扩展本体是免构建的纯 JS，共享核心是 TypeScript。二者必须保持行为一致，
 * 否则「核心库测试全绿、扩展实际行为却不同」就会发生。这里在 Node 里加载
 * background.js 源码、抽取其中的纯函数来验证两侧不漂移。
 */

const BG = join(process.cwd(), 'src', 'extension', 'background.js');

/** 构造一个「怎么调都不报错」的 chrome 桩：任何属性访问都返回可调用的空函数 */
function stub<T extends object>(obj: T): T {
  const makeLeaf = (): any =>
    new Proxy(function () {} as unknown as object, {
      get(_t, p) {
        if (p === 'then') return undefined; // 别被当成 thenable
        if (p === Symbol.toPrimitive || p === Symbol.iterator) return undefined;
        return makeLeaf();
      },
      apply: () => makeLeaf()
    });

  return new Proxy(obj as object, {
    get(target, prop) {
      if (!(prop in target)) return makeLeaf();
      const v = (target as any)[prop];
      /* 普通对象继续往下包，保证任意深度都能链式调用 */
      if (v && typeof v === 'object' && !Array.isArray(v)) return stub(v);
      return v;
    }
  }) as T;
}

async function loadBackgroundFns(): Promise<Record<string, any>> {
  const src = await readFile(BG, 'utf8');

  const chromeStub = stub({
    runtime: {
      getManifest: () => ({ version: '1.7.7' }),
      id: 'test'
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({}),
      update: async () => {}
    }
  });

  /* new Function 的函数体是语句列表，必须显式 return 才有值 */
  const wrapped = `return (function(){ ${src}\n return { normBase, detectProvider, resolveBase, guessProtocol, protocolOrder, buildRequest, extractText, extractDelta, parseMarked, systemPrompt, systemPromptSingle, stripMarkers }; })();`;

  const fn = new Function('chrome', 'fetch', 'console', wrapped);
  return fn(chromeStub, globalThis.fetch, console);
}

describe('扩展脚本与共享核心的一致性', () => {
  let bg: Record<string, any>;

  beforeAll(async () => {
    bg = await loadBackgroundFns();
  });

  it('background.js 的纯函数都能取到', () => {
    for (const name of [
      'normBase',
      'detectProvider',
      'resolveBase',
      'guessProtocol',
      'protocolOrder',
      'buildRequest',
      'extractText',
      'parseMarked'
    ]) {
      expect(typeof bg[name], name).toBe('function');
    }
  });

  const cases = [
    'https://api.openai.com/v1',
    'https://api.deepseek.com',
    'https://open.bigmodel.cn',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    'http://localhost:11434/v1',
    'https://dashscope.aliyuncs.com',
    'https://ark.cn-beijing.volces.com/api/v3'
  ];

  it.each(cases)('resolveBase 与核心一致：%s', url => {
    expect(bg.resolveBase(url)).toBe(resolveBase(url));
  });

  it.each(cases)('detectProvider 与核心一致：%s', url => {
    const a = bg.detectProvider(url);
    const b = detectProvider(url);
    expect(a?.id ?? null).toBe(b?.id ?? null);
    expect(a?.protocol ?? null).toBe(b?.protocol ?? null);
  });

  const settings = {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    temperature: 0.2
  };
  const messages = [
    { role: 'system' as const, content: '你是翻译' },
    { role: 'user' as const, content: 'hello' }
  ];

  it('buildRequest(openai) 与核心一致', () => {
    expect(bg.buildRequest('openai', settings, messages)).toEqual(
      buildRequest('openai', settings, messages)
    );
  });

  it('buildRequest(anthropic) 与核心一致', () => {
    expect(bg.buildRequest('anthropic', settings, messages)).toEqual(
      buildRequest('anthropic', settings, messages)
    );
  });

  it('buildRequest(gemini) 与核心一致', () => {
    expect(bg.buildRequest('gemini', settings, messages)).toEqual(
      buildRequest('gemini', settings, messages)
    );
  });

  it('extractText 与核心一致', () => {
    const samples = [
      { choices: [{ message: { content: '你好' } }] },
      { content: [{ text: '你好' }] },
      { candidates: [{ content: { parts: [{ text: '你好' }] } }] },
      { nope: 1 }
    ];
    for (const s of samples) {
      expect(bg.extractText(s)).toBe(extractText(s));
    }
  });
});
