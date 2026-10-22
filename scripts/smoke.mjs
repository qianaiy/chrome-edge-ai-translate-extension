/**
 * 冒烟验证：用 CDP 把扩展装进 Chrome/Edge，验证后台真的能响应。
 *
 * Chrome 137+ 起 --load-extension 命令行开关在非企业版构建里被移除了，
 * 只能走 CDP 的 Extensions.loadUnpacked 域。
 *
 * 用法：node scripts/smoke.mjs [--edge] [--ext <path>]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* Node 22+ 自带全局 WebSocket，不用装依赖 */
const WebSocket = globalThis.WebSocket;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useEdge = args.includes('--edge');
const extArg = args.indexOf('--ext');
/* 冒烟测的是「构建产物」，必须从 dist 加载 —— src/extension 里没有 core.js，
   服务工作者会 importScripts 失败、整个后台起不来（症状是消息永远不返回）。 */
const extPath = extArg >= 0 ? resolve(root, args[extArg + 1]) : join(root, 'dist');
const port = useEdge ? 9223 : 9222;

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
  console.error(`扩展目录不合法：${extPath}`);
  if (extPath === join(root, 'dist')) console.error('先跑 npm run build 生成 dist/');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'mxt-smoke-'));
const proc = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

/* CDP 客户端：用 Node 内置的 WebSocket */
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
  /* 每条命令都设上限：CDP 不回包时宁可报错，也不要让 CI 挂十分钟。
     之前就是这里没上限，一次「消息没人应答」把流水线拖到超时，看不出任何原因。 */
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP 超时 ${timeoutMs}ms：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer);
          res(v);
        },
        reject: e => {
          clearTimeout(timer);
          rej(e);
        }
      });
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

async function main() {
  const label = useEdge ? 'Edge' : 'Chrome';

  /* Extensions 域只挂在 browser 级别的连接上，page target 上没有这个方法 */
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

  /* 装载扩展 */
  let loadResult = null;
  try {
    loadResult = await browser.send('Extensions.loadUnpacked', { path: extPath });
  } catch (e) {
    throw new Error(`Extensions.loadUnpacked 失败：${e.message}`);
  }
  console.log(`[${label}] 扩展已装载：${loadResult.id}`);

  /* 等 service worker 出现 */
  let swTarget = null;
  for (let i = 0; i < 40; i++) {
    const list = await httpJson('/json/list');
    swTarget = list.find(t => t.type === 'service_worker' && t.url.includes(loadResult.id));
    if (swTarget) break;
    await sleep(300);
  }
  if (!swTarget) throw new Error('扩展的 service worker 没注册');

  /* 用 browser 级别的连接 attach 到 SW，flatten 模式下所有命令都走同一条连接，
     不用再单独开一个 WebSocket —— 直接连 SW 的 wsUrl 时 chrome.* 还没初始化。 */
  const attach = await browser.send('Target.attachToTarget', {
    targetId: swTarget.id,
    flatten: true
  });
  const sessionId = attach.sessionId;

  /* 必须先 enable，否则 SW 的执行上下文里还没注入 chrome.* */
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId).catch(() => {});
  await sleep(500);
  /* 把 service worker 的真实状态打出来：出问题时这几行能直接指出
     「是没加载共享核心」「还是监听器没注册」。 */
  /* 服务工作者状态：出故障时这几行能直接指出是「共享核心没加载」还是「监听器没注册」 */
  const PROBE =
    'location.pathname' +
    ' + " / MXTCore:" + (typeof MXTCore)' +
    ' + " / onMessage:" + (typeof (chrome && chrome.runtime && chrome.runtime.onMessage))';
  const swState = await browser.send(
    'Runtime.evaluate',
    { expression: PROBE, returnByValue: true },
    sessionId,
    8000
  );
  console.log(`[${label}] service worker：${swState.result?.value}`);

  /* 消息必须从一个扩展页面发出去 —— service worker 给自己发消息，
     自己的 onMessage 监听器收不到（没有「接收端」）。
     所以开一个 popup 页面，用它的上下文来发消息。 */
  const popupUrl = `chrome-extension://${loadResult.id}/popup/popup.html`;
  const { targetId: popupTargetId } = await browser.send('Target.createTarget', { url: popupUrl });
  const popupAttach = await browser.send('Target.attachToTarget', {
    targetId: popupTargetId,
    flatten: true
  });
  const popupSession = popupAttach.sessionId;
  await browser.send('Runtime.enable', {}, popupSession);
  await sleep(800);
  const popupState = await browser.send(
    'Runtime.evaluate',
    {
      expression: 'document.readyState + " / runtime:" + (typeof chrome?.runtime)',
      returnByValue: true
    },
    popupSession,
    8000
  );
  console.log(`[${label}] popup 上下文：${popupState.result?.value}`);

  const evalIn = async expr => {
    const r = await browser
      .send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        popupSession,
        12000
      )
      .catch(e => {
        throw new Error(`求值失败（${e.message}）：${expr.slice(0, 70)}`);
      });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
    }
    return r.result.value;
  };
  /* 跑一遍检查 */
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  };

  const version = await evalIn('chrome.runtime.getManifest().version');
  check('manifest 版本', version === '1.7.7', `= ${version}`);

  const mv = await evalIn('chrome.runtime.getManifest().manifest_version');
  check('Manifest V3', mv === 3, `= ${mv}`);

  const settings = await evalIn(
    'chrome.runtime.sendMessage({type:"mxt:getSettings"}).then(r=>r)'
  );
  check('mxt:getSettings', settings?.ok === true, JSON.stringify(settings?.ok));

  const ver = await evalIn('chrome.runtime.sendMessage({type:"mxt:version"}).then(r=>r)');
  check('mxt:version', ver?.ok === true && ver?.version === '1.7.7');

  const det = await evalIn(
    'chrome.runtime.sendMessage({type:"mxt:detect",baseURL:"https://api.deepseek.com"}).then(r=>r)'
  );
  check(
    'mxt:detect 解析服务商',
    det?.ok === true && det?.providerId === 'deepseek' && det?.baseURL === 'https://api.deepseek.com/v1',
    JSON.stringify(det?.providerId)
  );

  const cfg = await evalIn('chrome.runtime.sendMessage({type:"mxt:configStatus"}).then(r=>r)');
  check('mxt:configStatus 可用', cfg?.ok === true, JSON.stringify(cfg));

  /* 没有 API Key 时必须给友好提示，而不是抛错 */
  const noKey = await evalIn(
    'chrome.runtime.sendMessage({type:"mxt:translate",texts:["hello"]}).then(r=>r).catch(e=>({ok:false,thrown:String(e)}))'
  );
  check(
    '缺 Key 时给友好提示',
    noKey?.ok === false && typeof noKey?.error === 'string' && noKey.error.length > 0,
    JSON.stringify(noKey?.error)
  );

  const unknown = await evalIn(
    'chrome.runtime.sendMessage({type:"mxt:nonexistentType"}).then(r=>r).catch(e=>({ok:false,thrown:String(e)}))'
  );
  check('未知消息类型不崩', unknown?.ok === false);

  const lastErr = await evalIn('chrome.runtime.lastError');
  check('runtime.lastError 为空', lastErr === null || lastErr === undefined, String(lastErr));

  /* ---- 内容脚本注入检查 ----
     内容脚本跑在隔离世界（isolated world）里，页面主世界看不到 window.__MXT_ACTIVE__。
     但它注入的 #mxt-host 元素在页面 DOM 里，主世界能看到，所以用这个来验证。

     注意：内容脚本的 matches 是 http/https，data: URL 不在内，
     所以必须起一个真的 http 服务来测。 */
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><p id="t">Hello world</p></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const testPage = `http://127.0.0.1:${server.address().port}/`;

  const { targetId: pageTargetId } = await browser.send('Target.createTarget', { url: testPage });
  const pageAttach = await browser.send('Target.attachToTarget', {
    targetId: pageTargetId,
    flatten: true
  });
  const pageSession = pageAttach.sessionId;
  await browser.send('Runtime.enable', {}, pageSession);
  await sleep(1500);

  const evalPage = async expr => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      pageSession
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
    }
    return r.result.value;
  };

  const hostInfo = await evalPage(
    '(()=>{const h=document.getElementById("mxt-host");return h?{present:true,hasShadow:!!h.shadowRoot,shadowChildren:h.shadowRoot?h.shadowRoot.children.length:0,inDom:document.body.contains(h)}:{present:false};})()'
  );
  check(
    '内容脚本注入 #mxt-host',
    hostInfo?.present === true && hostInfo?.hasShadow === true,
    JSON.stringify(hostInfo)
  );

  /* 页面内容没被内容脚本破坏 */
  const pageText = await evalPage('document.getElementById("t")?.textContent');
  check('网页内容未被破坏', pageText === 'Hello world', JSON.stringify(pageText));

  server.close();
  bws.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n[${label}] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.error('失败项：\n' + failed.map(f => `  - ${f.name} ${f.detail}`).join('\n'));
  }
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error('冒烟失败：', e.message);
} finally {
  try {
    proc.kill();
  } catch {
    /* 忽略 */
  }
  /* 等浏览器真正退出，否则它还占着 profile 目录的文件锁 */
  for (let i = 0; i < 20; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await sleep(250);
  }
  await sleep(500);

  /* 浏览器进程退出后文件锁可能还没立刻释放，直接删会 EPERM。
     重试几次，并且失败也别让冒烟测试整体失败 —— 临时目录残留不是测试的失败原因。 */
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      break;
    } catch {
      await sleep(1000);
    }
  }
}
process.exit(ok ? 0 : 1);
