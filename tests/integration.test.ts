import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRequest, extractText } from '../src/core/protocol.js';
import { resolveBase, detectProvider, checkConfigured, isLocalEndpoint } from '../src/core/provider.js';
import { isTargetLanguage } from '../src/core/detect.js';
import { systemPrompt, systemPromptSingle } from '../src/core/prompt.js';

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
  const wrapped = `return (function(){ ${src}\n return { normBase, detectProvider, resolveBase, guessProtocol, protocolOrder, buildRequest, extractText, extractDelta, parseMarked, systemPrompt, systemPromptSingle, stripMarkers, configProblem, isLocalEndpoint }; })();`;

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

  /* 配置检查：弹窗和后台必须用同一套规则，否则会出现
     「弹窗说没配好、后台却能翻译」或者「后台报 401 而不是提示去设置」 */
  const configCases = [
    { baseURL: '', apiKey: '', model: '' },
    { baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
    { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' },
    { baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' },
    { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: '' },
    { baseURL: 'https://unknown.example.com/v1', apiKey: '', model: 'm' }
  ];

  it.each(configCases)('configProblem 与核心 checkConfigured 一致：%j', c => {
    const core = checkConfigured(c);
    const ext = bg.configProblem(c);
    /* 核心返回 ok 时扩展不该报错；核心报错时扩展必须报错 */
    expect(ext === null).toBe(core.ok);
  });

  it.each(configCases)('isLocalEndpoint 与核心一致：%j', c => {
    expect(bg.isLocalEndpoint(c.baseURL)).toBe(isLocalEndpoint(c.baseURL));
  });

  /* 协议构造：两边必须完全一致，包括修过的 Gemini 版本号和 Anthropic system */
  const protoCases = [
    { protocol: 'openai' as const, baseURL: 'https://api.deepseek.com/v1' },
    { protocol: 'anthropic' as const, baseURL: 'https://api.anthropic.com' },
    { protocol: 'gemini' as const, baseURL: 'https://generativelanguage.googleapis.com' },
    { protocol: 'gemini' as const, baseURL: 'https://generativelanguage.googleapis.com/v1' },
    { protocol: 'gemini' as const, baseURL: 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash' }
  ];

  it.each(protoCases)('buildRequest 与核心一致：%s %s', p => {
    const s = { baseURL: p.baseURL, apiKey: 'test-key', model: 'm', temperature: 0.2 };
    const msgs = [
      { role: 'system' as const, content: '你是翻译' },
      { role: 'user' as const, content: 'hello' }
    ];
    expect(bg.buildRequest(p.protocol, s, msgs)).toEqual(buildRequest(p.protocol, s, msgs));
  });

  it('Anthropic 的数组 system 提示词两边都保留', () => {
    const s = { baseURL: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-3', temperature: 0.2 };
    const msgs = [
      { role: 'system' as const, content: [{ type: 'text' as const, text: '你是翻译' }] },
      { role: 'user' as const, content: 'hello' }
    ];
    expect(bg.buildRequest('anthropic', s, msgs).body.system).toBe('你是翻译');
    expect(buildRequest('anthropic', s, msgs).body.system).toBe('你是翻译');
  });

  it('systemPrompt 两边完全一致', () => {
    const s = { targetLang: '简体中文', extraPrompt: '保持正式语气' };
    expect(bg.systemPrompt(s)).toBe(systemPrompt(s));
    expect(bg.systemPromptSingle(s)).toBe(systemPromptSingle(s));
  });
});

describe('页面语言判断', () => {
  const CASES: { text: string; lang: string; target: string; want: boolean }[] = [
    { text: '这是一段完整的中文网页正文，用来测试语言判断。', lang: 'zh-CN', target: '简体中文', want: true },
    { text: 'This is an English paragraph of web page text for testing.', lang: 'en', target: '简体中文', want: false },
    { text: 'This is an English paragraph of web page text for testing.', lang: 'en', target: 'English', want: true },
    { text: 'これは日本語のテキストです。', lang: 'ja', target: '日本語', want: true },
    { text: 'これは日本語のテキストです。', lang: 'ja', target: '简体中文', want: false },
    { text: '这是一段中文正文，没有假名。', lang: '', target: '日本語', want: false },
    { text: 'Это текст на русском языке для теста.', lang: 'ru', target: 'Русский', want: true },
    { text: '이것은 한국어 텍스트입니다.', lang: 'ko', target: '한국어', want: true }
  ];

  it.each(CASES)('lang=$lang target=$target → $want', c => {
    expect(isTargetLanguage(c.text, c.target, c.lang)).toBe(c.want);
  });
});
