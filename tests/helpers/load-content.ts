import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 在 Node 里加载内容脚本（content.js / subtitle.js）。
 *
 * vitest 跑在 node 环境，没有 jsdom。内容脚本用到的 DOM 面其实很窄
 * （createElement / appendChild / classList / textContent / addEventListener），
 * 所以这里给一份最小实现，比拉一整个 jsdom 更可控：
 *   - 每个假节点记录自己的监听器，测试可以 fire('click') 真的点一下；
 *   - classList 与 className 双向同步，断言看得见脚本改了什么；
 *   - querySelector('.x') 找不到时返回一个占位节点（真实 DOM 里字幕面板
 *     的列表节点是脚本自己建出来的，这里只要「写进去的东西读得回来」）。
 *
 * 注意：这不是 DOM 模拟器，只是让内容脚本能在 node 里真的跑起来。
 */

type Dict = Record<string, any>;

const VISIBLE = { display: 'block', visibility: 'visible', opacity: '1' };

function splitClasses(v: string): string[] {
  return String(v || '')
    .split(/\s+/)
    .filter(Boolean);
}

let seq = 0;

export class FakeElement {
  tagName: string;
  textRaw = '';
  style: Dict;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  shadowRoot: FakeElement | null = null;
  listeners: Record<string, ((ev?: any) => void)[]> = {};
  attrs: Dict = {};
  dataset: Dict = {};
  value = '';
  checked = false;
  disabled = false;
  title = '';
  type = '';
  src = '';
  label = '';
  srclang = '';
  kind = '';
  muted = false;
  default = false;
  currentTime = 0;
  textTracks: any[] = [];
  readonly __seq = ++seq;
  private privateId = '';
  private privateClass = '';
  private qcache = new Map<string, FakeElement>();

  constructor(
    tagName: string,
    private readonly doc: FakeDocument
  ) {
    this.tagName = String(tagName || 'div').toUpperCase();
    const self = this;
    this.style = {
      setProperty(k: string, v: string) {
        self.style[k] = v;
      },
      removeProperty(k: string) {
        delete self.style[k];
      }
    };
  }

  /* ------------------------- 标识 ------------------------- */

  get id(): string {
    return this.privateId;
  }

  set id(v: string) {
    this.privateId = String(v ?? '');
    if (this.privateId) this.doc.register(this.privateId, this);
  }

  get className(): string {
    return this.privateClass;
  }

  set className(v: string) {
    this.privateClass = String(v ?? '');
  }

  get classList() {
    const self = this;
    const has = (n: string) => splitClasses(self.privateClass).includes(n);
    return {
      add: (...names: string[]) => {
        for (const n of names) if (!has(n)) self.privateClass = [...splitClasses(self.privateClass), n].join(' ');
      },
      remove: (...names: string[]) => {
        self.privateClass = splitClasses(self.privateClass)
          .filter(n => !names.includes(n))
          .join(' ');
      },
      contains: (n: string) => has(n),
      toggle: (n: string, force?: boolean) => {
        const want = force === undefined ? !has(n) : force;
        if (want) self.classList.add(n);
        else self.classList.remove(n);
        return want;
      },
      toString: () => self.privateClass
    };
  }

  /* ------------------------- 文本 ------------------------- */

  get textContent(): string {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this.textRaw;
  }

  set textContent(v: string) {
    this.textRaw = String(v ?? '');
    this.children = [];
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(v: string) {
    this.textContent = v;
  }

  /* ------------------------- 树 ------------------------- */

  appendChild<T extends FakeElement>(child: T): T {
    if (child.tagName === '#DOCUMENT-FRAGMENT') {
      for (const c of [...child.children]) this.appendChild(c);
      child.children = [];
      return child;
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  insertBefore<T extends FakeElement>(node: T, ref: FakeElement | null): T {
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) return this.appendChild(node);
    this.children.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild<T extends FakeElement>(child: T): T {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [];
    this.textRaw = '';
    for (const n of nodes) this.appendChild(n);
  }

  replaceWith(node: FakeElement): void {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  contains(node: FakeElement | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some(c => c.contains(node));
  }

  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
  }

  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k] : null;
  }

  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }

  /* ------------------------- 查询 ------------------------- */

  matches(sel: string): boolean {
    const s = sel.trim();
    if (!s) return false;
    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('.')) return this.classList.contains(s.slice(1));
    const [tag, cls] = s.split('.');
    const tagOk = tag === '*' || this.tagName === tag.toUpperCase();
    return tagOk && (!cls || this.classList.contains(cls));
  }

  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel: string): FakeElement | null {
    const hit = this.querySelectorAll(sel)[0];
    if (hit) return hit;
    /* 脚本自己建面板时，列表节点写进去的值要读得回来。
       找不到就把占位节点缓存住，让 .textContent 的写入有落点。 */
    if (sel.startsWith('.')) {
      const cached = this.qcache.get(sel);
      if (cached) return cached;
      const made = new FakeElement('div', this.doc);
      made.className = sel.slice(1);
      this.qcache.set(sel, made);
      return made;
    }
    return null;
  }

  closest(): FakeElement | null {
    return null;
  }

  attachShadow(): FakeElement {
    const root = new FakeElement('#shadow-root', this.doc);
    this.shadowRoot = root;
    return root;
  }

  getBoundingClientRect() {
    return { width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200, x: 0, y: 0 };
  }

  getClientRects() {
    return [this.getBoundingClientRect()];
  }

  get isConnected(): boolean {
    return true;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] || null;
  }

  get offsetWidth(): number {
    return 600;
  }

  get offsetHeight(): number {
    return 200;
  }

  /* ------------------------- 事件 ------------------------- */

  addEventListener(type: string, fn: (ev?: any) => void): void {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type: string, fn: (ev?: any) => void): void {
    const list = this.listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  /** 测试用：真的把事件派给已注册的监听器 */
  fire(type: string, ev: Dict = {}): void {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
  }

  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  click(): void {
    this.fire('click');
  }
}

export class FakeDocument {
  body: FakeElement;
  documentElement: FakeElement;
  head: FakeElement;
  readyState = 'complete';
  title = '测试页';
  private registry = new Map<string, FakeElement>();
  listeners: Record<string, ((ev?: any) => void)[]> = {};

  constructor(
    /** 某个选择器要返回哪些节点（内容脚本靠 querySelectorAll 找段落/视频） */
    private readonly queryAll: (sel: string) => FakeElement[] = () => []
  ) {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.head = new FakeElement('head', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement('#text', this);
    node.textContent = text;
    return node;
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement('#document-fragment', this);
  }

  register(id: string, el: FakeElement): void {
    this.registry.set(id, el);
  }

  getElementById(id: string): FakeElement | null {
    return this.registry.get(id) || null;
  }

  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel: string): FakeElement[] {
    const hooked = this.queryAll(sel);
    if (hooked.length) return hooked;
    return this.documentElement.querySelectorAll(sel);
  }

  execCommand(): boolean {
    return false;
  }

  addEventListener(type: string, fn: (ev?: any) => void): void {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type: string, fn: (ev?: any) => void): void {
    const list = this.listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  fire(type: string, ev: Dict = {}): void {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
  }
}

/** 任意属性访问都返回可调用对象，避免脚本因为缺 API 直接崩 */
export function looseStub<T extends object>(target: T): T {
  const makeLeaf = (): any =>
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

export interface DomOptions {
  /** querySelectorAll 的钩子：返回 [] 表示这个选择器没有命中 */
  queryAll?: (sel: string) => FakeElement[];
  /** 预先登记好的节点（按 id） */
  elements?: Record<string, FakeElement>;
  /** 全局 AudioContext 的假实现（字幕抓音频用） */
  AudioContext?: unknown;
}

export interface ChromeSpy {
  /** 内容脚本发给后台的全部消息 */
  sent: Dict[];
  /** 测试改写的应答函数 */
  reply: (msg: Dict) => unknown;
  chrome: Dict;
}

export interface ContentHarness {
  document: FakeDocument;
  window: Dict;
  chrome: Dict;
  spy: ChromeSpy;
  /** 给内容脚本发一条消息，返回它 sendResponse 的内容 */
  send(msg: Dict): Promise<any>;
  /** 当前注册的消息监听器数量 */
  listenerCount(): number;
  /** 已经创建的节点（按标签名） */
  created(tag: string): FakeElement[];
}

export function createChromeSpy(opts: { reply?: (msg: Dict) => unknown; settings?: Dict } = {}): ChromeSpy {
  const sent: Dict[] = [];
  const listeners: ((msg: any, sender: any, sendResponse: (v: any) => void) => void)[] = [];
  const storage: Dict = { settings: { targetLang: '简体中文', ...(opts.settings || {}) } };
  const spy: ChromeSpy = {
    sent,
    reply: opts.reply || (() => ({ ok: true })),
    chrome: null as unknown as Dict
  };

  spy.chrome = looseStub({
    runtime: {
      id: 'test-extension',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: '1.7.7' }),
      sendMessage: async (msg: Dict) => {
        sent.push(msg);
        return spy.reply(msg);
      },
      connect: () => null,
      onMessage: {
        addListener: (fn: (msg: any, sender: any, sendResponse: (v: any) => void) => void) => {
          listeners.push(fn);
        }
      },
      onMessageExternal: { addListener: () => {} }
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
      sync: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} }
    },
    tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }], sendMessage: async () => ({}) },
    i18n: { getMessage: (k: string) => k }
  });

  (spy.chrome as Dict).__listeners = listeners;
  return spy;
}

export interface LoadContentOptions {
  file?: 'content.js' | 'subtitle.js';
  dom?: DomOptions;
  chrome?: Dict;
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
  /** 转发给内容脚本的 URL 假对象（字幕的 createObjectURL 断言用） */
  urlImpl?: Dict;
}

export async function loadContent(opts: LoadContentOptions = {}): Promise<ContentHarness> {
  const file = opts.file || 'content.js';
  const src = await readFile(join(process.cwd(), 'src', 'extension', 'content', file), 'utf8');

  const createdByTag = new Map<string, FakeElement[]>();
  const domOpts = opts.dom || {};
  const doc = new FakeDocument(domOpts.queryAll || (() => []));
  const tracked = doc as FakeDocument & { createElement: (t: string) => FakeElement };
  const rawCreate = FakeDocument.prototype.createElement.bind(doc);
  tracked.createElement = (tag: string) => {
    const el = rawCreate(tag);
    const key = String(tag).toLowerCase();
    createdByTag.set(key, [...(createdByTag.get(key) || []), el]);
    return el;
  };
  for (const [id, el] of Object.entries(domOpts.elements || {})) doc.register(id, el);

  const spy = opts.chrome ? null : createChromeSpy();
  const chrome = opts.chrome || (spy as ChromeSpy).chrome;
  const listeners: ((msg: any, sender: any, sendResponse: (v: any) => void) => void)[] =
    (chrome as Dict).__listeners || [];

  const windowStub: Dict = {
    __MXT_ACTIVE__: undefined,
    __MXT_SUB_ACTIVE__: undefined,
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    scrollX: 0,
    devicePixelRatio: 1,
    listeners: {} as Record<string, ((ev?: any) => void)[]>,
    addEventListener(type: string, fn: (ev?: any) => void) {
      (windowStub.listeners[type] = windowStub.listeners[type] || []).push(fn);
    },
    removeEventListener(type: string, fn: (ev?: any) => void) {
      const list: ((ev?: any) => void)[] = windowStub.listeners[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    getSelection: () => ({
      toString: () => '',
      rangeCount: 0,
      isCollapsed: true,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) })
    }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} })
  };
  if (domOpts.AudioContext) {
    windowStub.AudioContext = domOpts.AudioContext;
    windowStub.webkitAudioContext = domOpts.AudioContext;
  }

  const locationStub = { href: 'https://example.com/watch', hostname: 'example.com', origin: 'https://example.com', protocol: 'https:' };
  const navigatorStub = { userAgent: 'node-test', language: 'zh-CN', languages: ['zh-CN'] };

  class MutationObserverStub {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  const fetchImpl = opts.fetchImpl || (async () => ({ ok: false, status: 404, text: async () => '' }));
  const fetchSpy = async (url: any, init?: any) => fetchImpl(String(url), init);
  const urlImpl = opts.urlImpl || { createObjectURL: () => 'blob:mxt-test', revokeObjectURL() {} };

  const wrapped = `return (function(){ ${src} })();`;
  const fn = new Function(
    'window',
    'document',
    'chrome',
    'location',
    'navigator',
    'getComputedStyle',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'fetch',
    'URL',
    'Blob',
    'btoa',
    'atob',
    'console',
    wrapped
  );
  fn(
    windowStub,
    tracked,
    chrome,
    locationStub,
    navigatorStub,
    () => ({ ...VISIBLE }),
    MutationObserverStub,
    (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
    () => {},
    fetchSpy,
    urlImpl,
    globalThis.Blob,
    (s: string) => Buffer.from(s, 'binary').toString('base64'),
    (s: string) => Buffer.from(s, 'base64').toString('binary'),
    console
  );

  const send = async (msg: Dict): Promise<any> => {
    if (!listeners.length) throw new Error(`${file} 没有注册 onMessage 监听器`);
    return new Promise<any>(resolve => {
      let done = false;
      const finish = (v: any) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      for (const fn of listeners) fn(msg, { id: 'test-extension', frameId: 0, tab: { id: 1 } }, finish);
      setTimeout(() => finish(undefined), 1000);
    });
  };

  return {
    document: doc,
    window: windowStub,
    chrome,
    spy: spy as ChromeSpy,
    send,
    listenerCount: () => listeners.length,
    created: (tag: string) => createdByTag.get(String(tag).toLowerCase()) || []
  };
}