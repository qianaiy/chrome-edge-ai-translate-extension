import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeDocument, FakeElement, looseStub } from './load-content.js';

/**
 * 在 Node 里加载弹窗脚本 popup/popup.js。
 *
 * 弹窗只有三个它真正在意的东西：DOM 节点、window.close、chrome.runtime.sendMessage。
 * 这里把三者都换成可观测的假实现，特别是 window.close——「回执不成功就不许关窗」
 * 这条判据必须能被断言，而不是靠人工点。
 *
 * 弹窗脚本最后一行是 `init();`（不是 await），所以加载时把它改存成 __ready，
 * 测试就能确定地等初始化跑完，不用 sleep 猜。
 */

type Dict = Record<string, any>;

export const POPUP_IDS = [
  'model',
  'status',
  'lang',
  'autoTranslate',
  'translatePage',
  'translateAll',
  'toggleDisplay',
  'translateSubtitle',
  'translateComic',
  'shortcut',
  'speed',
  'probe',
  'openOptions',
  'clearCache'
] as const;

export interface PopupHarness {
  document: FakeDocument;
  el(id: string): FakeElement;
  /** window.close 被调用了几次 */
  closedCount(): number;
  /** 弹窗发给后台的消息（按顺序） */
  sends: Dict[];
  /** 等 init() 跑完 */
  ready(): Promise<void>;
  /** 推几轮事件循环，等 click 里的 async 处理器落定 */
  flush(ms?: number): Promise<void>;
  /** 轮询直到条件成立 */
  waitFor(check: () => boolean, timeoutMs?: number): Promise<void>;
  /** 点一下某个 id 的按钮 */
  click(id: string): Promise<void>;
  statusText(): string;
}

export interface LoadPopupOptions {
  /** 后台消息通道；不给就让所有 sendMessage 返回 {ok:true} */
  sendMessage?: (msg: Dict) => unknown;
  /** 标签页（决定 activeTabId 与受限页判定） */
  tab?: Dict | null;
  /** 预置 storage.local 内容 */
  storage?: Dict;
}

export async function loadPopup(opts: LoadPopupOptions = {}): Promise<PopupHarness> {
  const src = await readFile(join(process.cwd(), 'src', 'extension', 'popup', 'popup.js'), 'utf8');

  const doc = new FakeDocument();
  const elements = new Map<string, FakeElement>();
  for (const id of POPUP_IDS) {
    const el = new FakeElement('div', doc);
    el.id = id;
    elements.set(id, el);
  }

  let closed = 0;
  const sends: Dict[] = [];
  const storage: Dict = { ...(opts.storage || {}) };

  const documentStub = {
    getElementById: (id: string) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => new FakeElement(tag, doc),
    addEventListener() {},
    readyState: 'complete',
    body: doc.body,
    documentElement: doc.documentElement
  };

  const chrome = looseStub({
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.7.7' }),
      sendMessage: async (msg: Dict) => {
        sends.push(msg);
        if (opts.sendMessage) return opts.sendMessage(msg);
        return { ok: true };
      },
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} }
    },
    tabs: {
      query: async () => (opts.tab === undefined ? [{ id: 1, url: 'https://example.com/' }] : opts.tab ? [opts.tab] : []),
      create: async () => ({}),
      update: async () => ({})
    },
    storage: {
      local: {
        get: async (key?: unknown) => {
          if (typeof key === 'string') return { [key]: storage[key] };
          if (Array.isArray(key)) {
            const out: Dict = {};
            for (const k of key) out[String(k)] = storage[k as string];
            return out;
          }
          return { ...storage };
        },
        set: async (obj: Dict) => {
          Object.assign(storage, obj);
        },
        remove: async (key: string) => {
          delete storage[key];
        }
      },
      onChanged: { addListener: () => {} }
    }
  });

  const windowStub = {
    close() {
      closed++;
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 380,
    innerHeight: 600
  };

  /* 弹窗脚本结尾是裸调用 init()；改成存下来，测试才能确定地等它跑完 */
  const readyMarker = 'init();';
  const at = src.lastIndexOf(readyMarker);
  if (at < 0) throw new Error('popup.js 里找不到 init();，测试无法确定初始化何时结束');
  const patched = `${src.slice(0, at)}const __mxtReady = init();${src.slice(at + readyMarker.length)}`;

  const wrapped = `return (function(){ ${patched}
    return { __ready: __mxtReady, sendTab, init }; })();`;

  const fn = new Function('window', 'document', 'chrome', 'console', wrapped);
  const mod = fn(windowStub, documentStub, chrome, console) as Dict;

  const el = (id: string): FakeElement => {
    const hit = elements.get(id);
    if (!hit) throw new Error(`popup.html 里没有 id=${id}`);
    return hit;
  };

  const flush = async (ms = 40) => {
    const until = Date.now() + ms;
    while (Date.now() < until) await new Promise(r => setTimeout(r, 5));
  };

  const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (check()) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('等待弹窗状态超时');
  };

  const harness: PopupHarness = {
    document: doc,
    el,
    closedCount: () => closed,
    sends,
    ready: async () => {
      await mod.__ready;
      await flush(10);
    },
    flush,
    waitFor,
    click: async (id: string) => {
      el(id).fire('click');
      await flush(60);
    },
    statusText: () => el('status').textContent
  };

  return harness;
}