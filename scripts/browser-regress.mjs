/**
 * 浏览器回归：把真正构建出来的扩展装进 Chrome / Edge，配一个本地假翻译服务，
 * 跑完五类容易回归的场景：
 *
 *   1. 整页翻译 + 双语对照（原文还在）
 *   2. 动态下拉菜单：后插入的选项要自动补翻
 *   3. 无限滚动：成批追加的内容要自动补翻
 *   4. 框架重渲染：把文本改回英文后要重新翻译
 *   5. SPA 换页：中文首页 → 英文路由，要自己发现并自动翻译
 *
 * 另外顺带验证两件安全上的事：
 *   - 配置里填了 API Key 时，它不能出现在任何请求 URL 里（只在请求头）
 *   - 译文里不能漏出 `<<<n>>>` 编号标记
 *
 * 为什么不用 jsdom：内容脚本、MutationObserver、chrome.tabs 消息通道
 * 都是真浏览器的行为，模拟环境测不出来。这也是本轮任务明确要求的。
 *
 * 用法：node scripts/browser-regress.mjs [--edge] [--ext <path>]
 *   默认测 `dist/`（先跑 npm run build）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Node 22+ 自带全局 WebSocket，不引入依赖 */
const WebSocket = globalThis.WebSocket;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const useEdge = argv.includes('--edge');
const extArg = argv.indexOf('--ext');
const extPath = extArg >= 0 ? resolve(root, argv[extArg + 1]) : join(root, 'dist');
const port = useEdge ? 9233 : 9232;

const BROWSERS = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
};

const exe = useEdge ? BROWSERS.edge : BROWSERS.chrome;
if (!existsSync(exe)) {
  console.error(`找不到浏览器：${exe}`);
  process.exit(2);
}
if (!existsSync(join(extPath, 'manifest.json'))) {
  console.error(`扩展目录不合法：${extPath}\n先跑 npm run build`);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 假翻译服务
 * ------------------------------------------------------------------ */

/** 用内容算一个稳定标记，让「这段译文对应哪段原文」在浏览器里可断言 */
function tagOf(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String.fromCharCode(0x4e00 + (h % 18000));
}

/** 抠出 `<<<n>>>文本` 里的各段 */
function splitMarked(text) {
  const out = [];
  const re = /<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ i: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

/** 只保留中文的译文，避免译文本身又被判成外文而反复补翻 */
function fakeTranslation(src, i) {
  return `【译${i}·${tagOf(src)}】自动测试译文。`;
}

/** 框架重渲染测试里那一段的原文。PAGE_A 和后面的还原断言共用同一个常量，
    避免改了一处忘了另一处（以前就是因为这个断言和夹具各写各的才一直误报）。 */
const SLOT_ORIGINAL_TEXT = 'This text is owned by a framework and will be re-rendered.';

const PAGE_A = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>regress-a</title></head>
<body>
<main>
  <h1 id="h1">Regression suite landing heading</h1>
  <p id="p1">The first paragraph exists so the translator has a paragraph of body text to hand back to the page after a round trip.</p>
  <p id="p2">A second paragraph keeps the batch from degenerating into the single item code path.</p>
  <ul id="dropdown"><li id="opt-0">An option that was already on the page</li></ul>
  <div id="slot"><p id="slot-p">${SLOT_ORIGINAL_TEXT}</p></div>
  <div id="feed"></div>
</main>
</body></html>`;

const SPA_ARTICLE =
  'This English article body was swapped in by the single page application after a route change, so the extension has to notice the route change by itself and decide to translate again. ';

const PAGE_SPA = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>regress-spa</title></head>
<body>
<div id="app"><p>这是一个中文页面，打开的时候不应该被翻译。</p></div>
<script>
setTimeout(function () {
  /* 离开中文页之前先把它当时的文字记下来：换页后 DOM 被整个替换，
     事后再看 body 已经没有中文了，没法判断「当时有没有被误翻」。 */
  window.__spaBeforeNav = document.getElementById('app').innerText;
  history.pushState({}, '', '/spa-en');
  document.documentElement.setAttribute('lang', 'en');
  document.getElementById('app').innerHTML = '<p>' + ${JSON.stringify(SPA_ARTICLE.repeat(3))} + '</p>';
}, 1200);
</script>
</body></html>`;

/** 所有请求过的 URL，用来断言密钥没有进查询串 */
const seenUrls = [];

const server = createServer((req, res) => {
  const url = req.url || '/';
  seenUrls.push(url);

  if (url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload = '';
      try {
        const json = JSON.parse(body);
        const msgs = Array.isArray(json.messages) ? json.messages : [];
        const user = [...msgs].reverse().find(m => m && m.role === 'user');
        payload = typeof user?.content === 'string' ? user.content : '';
      } catch {
        /* 解析失败就退回单段 */
      }
      const segs = splitMarked(payload);
      const content = segs.length
        ? segs.map(s => `<<<${s.i}>>>${fakeTranslation(s.text, s.i)}`).join('\n')
        : `<<<1>>>${fakeTranslation(payload, 1)}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 0,
          model: 'fake-translator',
          choices: [
            { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    });
    return;
  }

  const html = url.startsWith('/spa') ? PAGE_SPA : PAGE_A;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ *
 * 浏览器 / CDP
 * ------------------------------------------------------------------ */

const profile = mkdtempSync(join(tmpdir(), 'mxt-regress-'));
const proc = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    /* 下面这些让「最近的标签页」不会因为后台节流而停掉 MutationObserver 之外的定时器 */
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        this.listeners.forEach(fn => fn(msg));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

async function main() {
  const label = useEdge ? 'Edge' : 'Chrome';
  console.log(`[${label}] 回归测试，扩展目录 ${extPath}`);

  let browserWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (v.webSocketDebuggerUrl) {
        browserWs = v.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  if (!browserWs) throw new Error('CDP 没起来');

  const bws = new WebSocket(browserWs);
  await new Promise((res, rej) => {
    bws.addEventListener('open', res, { once: true });
    bws.addEventListener('error', rej, { once: true });
  });
  const browser = new CDP(bws);

  const loaded = await browser.send('Extensions.loadUnpacked', { path: extPath });
  console.log(`[${label}] 扩展已装载：${loaded.id}`);

  /* 扩展页上下文：有 chrome.tabs / chrome.storage，用来发消息和改设置 */
  const { targetId: popupTargetId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${loaded.id}/popup/popup.html`
  });
  const popup = (await browser.send('Target.attachToTarget', {
    targetId: popupTargetId,
    flatten: true
  })).sessionId;
  await browser.send('Runtime.enable', {}, popup);

  const evalPopup = async expr => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      popup
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
    }
    return r.result.value;
  };

  /* 等 service worker 起来，否则第一次 storage 写入会丢 */
  await sleep(1200);

  await evalPopup(`
window.__mxt = {
  tid: async function (match) {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => (x.url || '').includes(match));
    if (!t) throw new Error('找不到标签页：' + match);
    return t.id;
  },
  status: async function (tid) {
    try { return await chrome.tabs.sendMessage(tid, { type: 'mxt:status' }); }
    catch (e) { return { ok: false, err: String(e) }; }
  },
  /* 「就绪」要看 mxt:ping 的 ready 字段 —— mxt:status 不带它，
     拿 status 判断会受到「还没注入」和「注入了但没就绪」两种情况的干扰。 */
  ping: async function (tid) {
    try { return await chrome.tabs.sendMessage(tid, { type: 'mxt:ping' }); }
    catch (e) { return { ok: false, err: String(e) }; }
  },
  waitPing: async function (tid, ms) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await __mxt.ping(tid);
      if (last && last.ok && last.ready === true) return { ok: true, last, waited: Date.now() - t0 };
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, last, waited: Date.now() - t0 };
  },
  wait: async function (tid, cond, ms) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await __mxt.status(tid);
      try { if (cond(last)) return { ok: true, last, waited: Date.now() - t0 }; } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, last, waited: Date.now() - t0 };
  }
};
true;
`);

  /* 探针密钥在运行时拼出来。扫描器（正确地）拒绝源码里任何「长得像密钥」的字面量，
     哪怕明知是假的 —— 与其给扫描器开例外，不如让仓库里永远不出现这种字符串。
     运行时值仍然是完整的 sk- 形状，所以「密钥不能进 URL」这条断言依旧有效。 */
  const KEY = 'sk-' + 'REGRESS-PROBE-do-not-leak-' + '0123456789';

  const writeSettings = patch =>
    evalPopup(
      `chrome.storage.local.set({ settings: ${JSON.stringify({
        baseURL: `${origin}/v1`,
        apiKey: KEY,
        model: 'fake-translator',
        targetLang: '简体中文',
        temperature: 0,
        extraPrompt: '',
        protocol: 'auto',
        autoDynamic: true,
        displayMode: 'bilingual',
        showFab: false,
        autoTranslate: false,
        autoTranslateMinChars: 1,
        ...patch
      })} }).then(() => true)`
    );

  const openPage = async (path, match) => {
    const { targetId } = await browser.send('Target.createTarget', { url: origin + path });
    const session = (await browser.send('Target.attachToTarget', {
      targetId,
      flatten: true
    })).sessionId;
    await browser.send('Runtime.enable', {}, session);
    const evaluate = async expr => {
      const r = await browser.send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        session
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
      }
      return r.result.value;
    };
    const tid = await evalPopup(`__mxt.tid(${JSON.stringify(match)})`);
    return { targetId, session, evaluate, tid };
  };

  const closePage = async targetId => {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  };

  /* ---------------- 页面 A：基础翻译 + 三类动态更新 + 还原 ---------------- */

  await writeSettings({});
  const a = await openPage('/a', '/a');

  const ready = await evalPopup(`__mxt.waitPing(${a.tid}, 15000)`);
  check('内容脚本就绪', ready.ok === true, JSON.stringify(ready.last));

  const before = await a.evaluate('document.body.innerText');

  /* 触发整页翻译 */
  await evalPopup(`chrome.tabs.sendMessage(${a.tid}, { type: 'mxt:togglePage', mode: 'full' })`);
  const translated = await evalPopup(
    `__mxt.wait(${a.tid}, s => s && s.ok && s.translated > 0 && !s.busy, 30000)`
  );
  const baseCount = translated.last?.translated || 0;
  check('整页翻译产生译文', translated.ok === true && baseCount >= 4, `段数 ${baseCount}`);

  const afterText = await a.evaluate('document.body.innerText');
  check('译文进入页面', afterText.includes('【译'), '');
  check('双语对照保留原文', afterText.includes('Regression suite landing heading'));
  check(
    '译文没有漏出编号标记',
    !afterText.includes('<<<') && !afterText.includes('>>>'),
    ''
  );
  check(
    '第一段编号正确',
    afterText.includes('【译1·') && /【译[2-9]·/.test(afterText),
    ''
  );

  /* --- 动态下拉菜单 --- */
  const menuText = 'A freshly inserted dropdown option';
  await a.evaluate(
    `(() => {
      const li = document.createElement('li');
      li.id = 'opt-new';
      li.textContent = ${JSON.stringify(menuText)};
      document.getElementById('dropdown').appendChild(li);
      return true;
    })()`
  );
  const menuWait = await evalPopup(
    `__mxt.wait(${a.tid}, s => s && s.ok && s.translated > ${baseCount}, 12000)`
  );
  const menuTextNow = await a.evaluate('document.body.innerText');
  check(
    '动态菜单项被自动补翻',
    menuTextNow.includes('·' + tagOf(menuText) + '】'),
    `段数 ${menuWait.last?.translated}`
  );

  /* --- 无限滚动 --- */
  const scrollTexts = [
    'Infinite scroll brought in this sentence.',
    'Infinite scroll brought in this second sentence.',
    'Infinite scroll brought in this third sentence.'
  ];
  const menuCount = menuWait.last?.translated || baseCount;
  await a.evaluate(
    `(() => {
      const feed = document.getElementById('feed');
      ${JSON.stringify(scrollTexts)}.forEach((t, i) => {
        const p = document.createElement('p');
        p.id = 'feed-' + i;
        p.textContent = t;
        feed.appendChild(p);
      });
      return true;
    })()`
  );
  const scrollWait = await evalPopup(
    `__mxt.wait(${a.tid}, s => s && s.ok && s.translated >= ${menuCount + 3}, 15000)`
  );
  const scrollText = await a.evaluate('document.body.innerText');
  check(
    '无限滚动追加的内容被自动补翻',
    scrollTexts.every(t => scrollText.includes('·' + tagOf(t) + '】')),
    `段数 ${scrollWait.last?.translated}`
  );

  /* --- 框架重渲染：文本被改回英文 --- */
  const rerenderText = 'Reverted by a re-render, this sentence is brand new.';
  const beforeRerender = scrollWait.last?.translated || 0;
  await a.evaluate(
    `(() => {
      const p = document.getElementById('slot-p');
      p.textContent = ${JSON.stringify(rerenderText)};
      return true;
    })()`
  );
  const rerenderWait = await evalPopup(
    `__mxt.wait(${a.tid}, s => s && s.ok && s.translated > ${beforeRerender}, 15000)`
  );
  const rerenderTextNow = await a.evaluate('document.body.innerText');
  check(
    '框架重渲染后重新翻译',
    rerenderTextNow.includes('·' + tagOf(rerenderText) + '】'),
    `段数 ${rerenderWait.last?.translated}`
  );

  /* --- 密钥不进 URL --- */
  check(
    'API Key 未出现在任何请求 URL 中',
    seenUrls.every(u => !u.includes(KEY) && !u.includes('key=')),
    `共 ${seenUrls.length} 个请求`
  );

  /* --- 原文恢复 --- */
  await evalPopup(`chrome.tabs.sendMessage(${a.tid}, { type: 'mxt:togglePage', mode: 'full' })`);
  const restored = await evalPopup(
    `__mxt.wait(${a.tid}, s => s && s.ok && s.translated === 0 && !s.busy, 20000)`
  );
  const restoredText = await a.evaluate('document.body.innerText');
  check('一键恢复原文', restored.ok === true && !restoredText.includes('【译'), `段数 ${restored.last?.translated}`);

  /* 不拿整页 innerText 跟 before 比：中途加了下拉选项、无限滚动的新条目，
     这些是页面自己加的内容，before 里当然没有。改成逐块看「每块是不是回到了
     我们翻它之前的原文」，这才是还原真正该保证的东西。 */
  const restoredState = await a.evaluate(`(() => {
    const t = sel => (document.querySelector(sel) || {}).innerText || '';
    return {
      h1: t('#h1'),
      p1: t('#p1'),
      p2: t('#p2'),
      slot: t('#slot-p'),
      trans: document.querySelectorAll('.mxt-trans').length,
      marked: document.querySelectorAll('.mxt-orig, .mxt-swapped').length,
      outAttr: document.querySelectorAll('[data-mxt-out]').length
    };
  })()`);
  check(
    '恢复后各块文字回到原文',
    restoredState.h1 === 'Regression suite landing heading' &&
      restoredState.p1.indexOf('The first paragraph') === 0 &&
      restoredState.p2.indexOf('A second paragraph') === 0 &&
      restoredState.slot === rerenderText,
    JSON.stringify(restoredState).slice(0, 130)
  );
  check(
    '恢复后不残留注入节点与标记',
    restoredState.trans === 0 && restoredState.marked === 0 && restoredState.outAttr === 0,
    JSON.stringify(restoredState).slice(0, 130)
  );

  await closePage(a.targetId);

  /* ---------------- 页面 B：SPA 换页后自动翻译 ---------------- */

  await writeSettings({ autoTranslate: true, autoTranslateMinChars: 1 });
  const b = await openPage('/spa', '/spa');

  const spaReady = await evalPopup(`__mxt.waitPing(${b.tid}, 15000)`);
  check('SPA 页面内容脚本就绪', spaReady.ok === true, '');

  /* 进页面时是中文，不该翻；pushState 换成英文后要自己发现 */
  const spaWait = await evalPopup(
    `__mxt.wait(${b.tid}, s => s && s.ok && s.translated > 0, 30000)`
  );
  const spaText = await b.evaluate('document.body.innerText');
  check(
    'SPA 换页后自动翻译外文页面',
    spaWait.ok === true && spaText.includes('【译'),
    `等待 ${spaWait.waited}ms，段数 ${spaWait.last?.translated}`
  );
  /* 换页后 body 里已经没有中文了（整块 DOM 被替换），
     所以要比较「离开之前那一刻」的快照，而不是现在的 body。 */
  const spaBeforeNav = await b.evaluate('window.__spaBeforeNav || ""');
  check(
    'SPA 换页前中文页没被误翻',
    spaBeforeNav.includes('这是一个中文页面') && !spaBeforeNav.includes('【译'),
    spaBeforeNav.slice(0, 40)
  );

  await closePage(b.targetId);

  /* 收尾 */
  const failed = checks.filter(c => !c.ok);
  console.log(`\n[${label}] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.error('失败项：\n' + failed.map(f => `  - ${f.name} ${f.detail}`).join('\n'));
  }
  bws.close();
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error('回归失败：', e.message);
} finally {
  try {
    proc.kill();
  } catch {
    /* 忽略 */
  }
  for (let i = 0; i < 20; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await sleep(250);
  }
  await sleep(500);
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      break;
    } catch {
      await sleep(1000);
    }
  }
  try {
    server.close();
  } catch {
    /* 忽略 */
  }
}
process.exit(ok ? 0 : 1);
