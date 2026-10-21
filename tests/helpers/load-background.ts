import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 在 Node 里加载 src/extension/background.js，用于验证扩展真实的运行时行为。
 *
 * 与 tests/integration.test.ts 的做法一致（用 new Function 注入 chrome / fetch），
 * 但这里多做两件事：
 *   1. 捕获 chrome.runtime.onMessage 注册的监听器，可以直接发消息给后台；
 *   2. 记录所有 fetch 调用，用来断言「试了几次协议」「key 有没有进 URL」。
 */

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export interface LoadOptions {
  /** 预置到 chrome.storage.local 的 settings */
  settings?: Record<string, unknown>;
  /** 替换 fetch；默认返回一个 401 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<unknown>;
}

export interface BackgroundHarness {
  fns: Record<string, any>;
  /** 给后台发一条消息，返回 sendResponse 收到的内容 */
  send(msg: unknown): Promise<any>;
  /** 本次加载期间的全部 fetch 调用 */
  calls: FetchCall[];
  /** 当前 chrome.storage.local 的内容 */
  storage: Record<string, any>;
}

type Leaf = any;

/** 任意属性访问都返回可调用对象，避免后台脚本因为缺 API 直接崩 */
function looseStub<T extends object>(target: T): T {
  const makeLeaf = (): Leaf =>
    new Proxy(function () {} as unknown as object, {
      get(_t, p) {
        if (p === 'then') return undefined;
        if (p === Symbol.toPrimitive || p === Symbol.iterator) return undefined;
        return makeLeaf();
      },
      apply: () => makeLeaf()
    });

  return new Proxy(target as object, {
    get(obj, prop) {
      if (!(prop in obj)) return makeLeaf();
      const v = (obj as any)[prop];
      if (v && typeof v === 'object' && !Array.isArray(v)) return looseStub(v);
      return v;
    }
  }) as T;
}

export async function loadBackground(opts: LoadOptions = {}): Promise<BackgroundHarness> {
  const src = await readFile(join(process.cwd(), 'src', 'extension', 'background.js'), 'utf8');

  const storage: Record<string, any> = {};
  if (opts.settings) storage.settings = { ...opts.settings };

  let listener: ((msg: any, sender: any, sendResponse: (v: any) => void) => void) | null = null;
  const calls: FetchCall[] = [];

  const chrome = looseStub({
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.7.7' }),
      onMessage: {
        addListener: (fn: (msg: any, sender: any, sendResponse: (v: any) => void) => void) => {
          listener = fn;
        }
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      lastError: undefined
    },
    storage: {
      local: {
        get: async (key?: unknown) => {
          if (key == null) return { ...storage };
          if (typeof key === 'string') return { [key]: storage[key] };
          if (Array.isArray(key)) {
            const out: Record<string, any> = {};
            for (const k of key) out[String(k)] = storage[k as string];
            return out;
          }
          return { ...storage };
        },
        set: async (obj: Record<string, any>) => {
          Object.assign(storage, obj);
        },
        remove: async (key: string) => {
          delete storage[key];
        }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/' }],
      get: async (id: number) => ({ id, url: 'https://example.com/' }),
      sendMessage: async () => ({ ok: true }),
      update: async () => ({})
    },
    scripting: {
      executeScript: async () => [],
      insertCSS: async () => {}
    },
    contextMenus: {
      removeAll: () => {},
      create: () => {},
      onClicked: { addListener: () => {} }
    },
    commands: { onCommand: { addListener: () => {} } },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, url: 'https://example.com/' }]
    }
  });

  const fetchImpl =
    opts.fetchImpl ||
    (async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
    }));

  const fetchSpy = async (url: any, init: any) => {
    calls.push({ url: String(url), init: init || {} });
    return fetchImpl(String(url), init || {});
  };

  const wrapped = `return (function(){ ${src}
    return {
      DEFAULTS, PROTOCOLS, RETRYABLE_STATUS, getSettings, cacheKey,
      buildRequest, extractText, extractDelta, callOnce, chat,
      parseMarked, systemPrompt, systemPromptSingle, stripMarkers,
      resolveBase, detectProvider, guessProtocol, protocolOrder,
      configProblem, isLocalEndpoint, redactSecrets, listModelsOnce
    }; })();`;

  const fn = new Function('chrome', 'fetch', 'console', wrapped);
  const fns = fn(chrome, fetchSpy, console) as Record<string, any>;

  const send = async (msg: unknown): Promise<any> => {
    if (!listener) throw new Error('background.js 没有注册 onMessage 监听器');
    let resolveFn: (v: any) => void = () => {};
    const answered = new Promise<any>(res => {
      resolveFn = res;
    });
    listener(msg, { tab: { id: 1, url: 'https://example.com/' }, frameId: 0 }, resolveFn);
    /* 监听器内部是 async IIFE，用超时兜底避免测试挂死 */
    return Promise.race([
      answered,
      new Promise(res => setTimeout(() => res(undefined), 1000))
    ]);
  };

  return { fns, send, calls, storage };
}
