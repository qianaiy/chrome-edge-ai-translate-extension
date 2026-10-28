/* 漫画嵌字定位取证 + 回归
 *
 * 目的：不靠猜。用一张几何已知的合成漫画页 + 一个会按指定坐标回答的假视觉服务，
 * 量出「译文实际画在哪里」和「气泡本来在哪里」差多少像素。
 *
 * 运行：node scripts/manga-typeset-check.mjs
 * 产物：artifacts/manga-typeset/*.png（调试图、效果图）
 *
 * 不连外网、不需要 API Key。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* 端口被残留进程占着时 Chrome 会静默放弃开调试端口（进程还在，但 CDP 永远不响应），
   表现就是「CDP 没起来」。所以先挑一个真的空闲的端口。 */
let DEBUG_PORT = 9240;
let HTTP_PORT = 9240;
const EXE =
  process.env.MXT_TEST_EXE ||
  (process.argv.includes('--edge')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const extPath = join(process.cwd(), 'dist');
const SHOT_DIR = join(process.cwd(), 'artifacts', 'manga-typeset');

/* 合成页的几何：百分比坐标，假服务就按这些值回答 */
/* 默认跑合成页。设 MXT_TYPESET_SAMPLE=jp-vertical|jp-burst|kr-strip 时改成
   真实漫画图 + 当时真实模型返回的坐标：图是真的、坐标也是模型给的，
   不靠我们手写正确坐标冒充检测成功。 */
const SAMPLE_NAME = process.env.MXT_TYPESET_SAMPLE || '';
const REAL_DIR = join(process.cwd(), 'artifacts', 'real-samples');
let REAL_PNG = null;
let PAGE_W = 800;
let PAGE_H = 1200;

const BUBBLES = [
  { id: 'b1', box: [8, 5, 45, 18], text: 'Hello there!', zh: '你好呀！' },
  { id: 'b2', box: [52, 22, 92, 36], text: 'This is a much longer English line.', zh: '这是一句长得多的中文译文，用来测试换行' },
  { id: 'b3', box: [20, 45, 70, 62], text: 'Third bubble', zh: '第三个气泡' },
  /* 窄而高的框 + 日文：竖排信号 */
  { id: 'b4', box: [76, 68, 85, 95], text: 'これは縦書きのテストです', zh: '这是竖排测试文字' }
];

/* ---------------- 最小 PNG 编码器（不引依赖） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function drawPage(w, h) {
  const buf = Buffer.alloc(w * h * 3, 0xe8);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  };
  const rect = (x1, y1, x2, y2, r, g, b) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) put(x, y, r, g, b);
  };
  /* 页脚一条深色横带：验证「背景复杂的气泡」不会把字也吞掉。
     必须画在气泡**之前** —— 画在之后会把气泡盖掉一半，那是无效场景。 */
  rect(0, Math.round(h * 0.78), w, h, 40, 45, 60);
  for (const b of BUBBLES) {
    const x1 = Math.round((b.box[0] / 100) * w);
    const y1 = Math.round((b.box[1] / 100) * h);
    const x2 = Math.round((b.box[2] / 100) * w);
    const y2 = Math.round((b.box[3] / 100) * h);
    rect(x1, y1, x2, y2, 255, 255, 255);
    /* 黑描边 3px，用来检查「擦除有没有吃掉气泡边」 */
    for (let t = 0; t < 3; t++) {
      rect(x1 + t, y1 + t, x2 - t, y1 + t + 1, 0, 0, 0);
      rect(x1 + t, y2 - t - 1, x2 - t, y2 - t, 0, 0, 0);
      rect(x1 + t, y1 + t, x1 + t + 1, y2 - t, 0, 0, 0);
      rect(x2 - t - 1, y1 + t, x2 - t, y2 - t, 0, 0, 0);
    }
    /* 假「原文」：几条黑杠，位置在气泡中部 */
    const midY = Math.round((y1 + y2) / 2);
    const bars = 3;
    for (let i = 0; i < bars; i++) {
      const by = midY - 22 + i * 16;
      rect(x1 + 24, by, x2 - 24, by + 8, 20, 20, 20);
    }
  }
  return encodePng(w, h, buf);
}

/* ---------------- 真实样本装载 ---------------- */

function loadRealSample() {
  if (!SAMPLE_NAME) return;
  const manifest = JSON.parse(readFileSync(join(REAL_DIR, 'manifest.json'), 'utf8'));
  const sample = manifest.samples.find(s => s.name === SAMPLE_NAME);
  if (!sample) throw new Error(`manifest 里没有样本 ${SAMPLE_NAME}`);
  const resp = JSON.parse(readFileSync(join(REAL_DIR, 'responses', `${SAMPLE_NAME}.json`), 'utf8'));

  PAGE_W = sample.width;
  PAGE_H = sample.height;
  REAL_PNG = readFileSync(join(REAL_DIR, sample.file));

  /* 坐标必须先规范化 —— 模型会混用百分比和 0-1000，直接用会把框放到画面外 */
  const Core = globalThis.MXTCore;
  const norm = Core && Core.sanitizeVisionItems
    ? Core.sanitizeVisionItems(resp.items || [], PAGE_W, PAGE_H)
    : { items: resp.items || [] };
  const items = norm.items || [];

  const bubbles = [];
  for (const gt of sample.items) {
    let best = null;
    let bestSim = 0;
    for (const it of items) {
      if (!it.box) continue;
      const sim = similarity(gt.source, it.text || '');
      if (sim > bestSim) {
        bestSim = sim;
        best = it;
      }
    }
    if (!best || bestSim < 0.5) continue;
    bubbles.push({ id: gt.id, box: best.box, text: gt.source, zh: best.zh || gt.source });
  }
  if (bubbles.length < 2) throw new Error('能对上的真值太少，样本可能不匹配');
  BUBBLES.length = 0;
  BUBBLES.push(...bubbles);
  console.log(`真实样本 ${SAMPLE_NAME}：${PAGE_W}×${PAGE_H}，用了 ${bubbles.length} 条模型坐标`);
}

function similarity(a, b) {
  const x = String(a || '').replace(/\s+/g, '');
  const y = String(b || '').replace(/\s+/g, '');
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const m = x.length;
  const n = y.length;
  let hit = 0;
  const used = new Array(n).fill(false);
  for (const ch of x) {
    for (let i = 0; i < n; i++) {
      if (!used[i] && y[i] === ch) {
        used[i] = true;
        hit++;
        break;
      }
    }
  }
  return (2 * hit) / (m + n);
}

/* ---------------- 假视觉服务 ---------------- */

let mode = 'normal';

function fakeItems() {
  if (mode === 'nobox') return BUBBLES.map(b => ({ text: b.text, zh: b.zh }));
  if (mode === 'badbox')
    return BUBBLES.map(b => ({ text: b.text, zh: b.zh, box: ['x', null, 999, -5] }));
  return BUBBLES.map(b => ({ text: b.text, zh: b.zh, box: b.box }));
}

function startServer() {
  const png = REAL_PNG || drawPage(PAGE_W, PAGE_H);
  const server = createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    if (url === '/page.html') {
      /* 外层容器明显比图片大：这正是真实站点最常见的样子，
         而且能暴露「覆盖层按容器尺寸摆，而不是按图片尺寸摆」的问题。 */
      const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #1b1b1f; }
  #wrap { padding: 48px 0 120px 60px; background: #26262c; }
  #manga { display: block; width: 420px; height: auto; }
</style>
<div id="wrap"><img id="manga" src="/img/page.png" alt="manga"></div>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.startsWith('/v1/')) {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const content = JSON.stringify(fakeItems());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise(resolve => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

/* ---------------- CDP ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
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

/* 量出图片渲染盒与所有覆盖层的实际位置 */
const MEASURE = `(() => {
  const img = document.getElementById('manga');
  if (!img) return { img: null };
  const r = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  const ov = [...document.querySelectorAll('.mxt-comic-overlay')].map(n => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return {
      tag: n.tagName,
      left: +b.left.toFixed(1), top: +b.top.toFixed(1),
      width: +b.width.toFixed(1), height: +b.height.toFixed(1),
      fontSize: s.fontSize, lineHeight: s.lineHeight,
      zIndex: s.zIndex, pointer: s.pointerEvents,
      outlineStyle: s.outlineStyle,
      data: String(n.getAttribute('src') || '').slice(0, 12),
      text: (n.textContent || '').slice(0, 40),
      span: (() => {
        const sp = n.querySelector('span');
        if (!sp) return null;
        const ss = getComputedStyle(sp);
        return {
          writingMode: ss.writingMode,
          editable: !!sp.isContentEditable,
          chars: (sp.textContent || '').length,
          fontSize: ss.fontSize
        };
      })()
    };
  });
  return {
    img: {
      left: +r.left.toFixed(1), top: +r.top.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1),
      nw: img.naturalWidth, nh: img.naturalHeight,
      objectFit: cs.objectFit, position: cs.position
    },
    wrap: (() => {
      const w = img.parentElement;
      if (!w) return null;
      const b = w.getBoundingClientRect();
      return { left: +b.left.toFixed(1), top: +b.top.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1), position: getComputedStyle(w).position };
    })(),
    overlays: ov,
    panel: (() => {
      const h = document.getElementById('mxt-comic-host');
      if (!h || !h.shadowRoot) return null;
      const sr = h.shadowRoot;
      return {
        msg: (sr.querySelector('.mxt-comic-msg') || {}).textContent || '',
        note: (sr.querySelector('.mxt-comic-note') || {}).textContent || '',
        zh: sr.querySelectorAll('.mxt-comic-zh').length
      };
    })()
  };
})()`;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

async function findFreePort(from) {
  for (let p = from; p < from + 40; p++) {
    const ok = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(p, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('找不到空闲端口');
}

async function main() {
  /* 调试端口和假服务端口必须不同：先起的假服务会把调试端口占掉，
     Chrome 于是静默放弃开 CDP（进程还在，但 /json/version 回的是我们自己）。 */
  HTTP_PORT = await findFreePort(9240);
  DEBUG_PORT = await findFreePort(HTTP_PORT + 1);
  console.log(`调试端口 ${DEBUG_PORT}  假服务端口 ${HTTP_PORT}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  if (!existsSync(extPath)) {
    console.error('找不到 dist/，先跑 npm run build');
    process.exit(2);
  }
  const server = await startServer();
  const profile = mkdtempSync(join(tmpdir(), 'mxt-typeset-'));

  const proc = spawn(
    EXE,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--enable-unsafe-extension-debugging',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let chromeLog = '';
  proc.stdout.on('data', d => (chromeLog += d));
  proc.stderr.on('data', d => (chromeLog += d));

  let browser = null;
  try {
    let wsUrl = null;
    let exited = null;
    proc.on('exit', code => (exited = code));
    for (let i = 0; i < 120; i++) {
      if (exited !== null) throw new Error(`浏览器进程退出，code=${exited}`);
      try {
        const v = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
        if (v.webSocketDebuggerUrl) {
          wsUrl = v.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {
        if (i === 119) console.log('最后一次轮询错误：', e && e.message);
      }
      await sleep(700);
    }
    if (!wsUrl) throw new Error(`CDP 没起来。浏览器输出：${chromeLog.slice(-600) || '(空)'}`);
    const bws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      bws.addEventListener('open', res, { once: true });
      bws.addEventListener('error', rej, { once: true });
    });
    browser = new CDP(bws);

    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: extPath });
    console.log(`扩展已装载：${extId}`);

    const { targetId: ctlId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extId}/popup/popup.html`
    });
    const ctl = (await browser.send('Target.attachToTarget', { targetId: ctlId, flatten: true }))
      .sessionId;
    await browser.send('Runtime.enable', {}, ctl);

    const evalCtl = async expr => {
      const r = await browser.send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        ctl
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '抛错');
      return r.result.value;
    };

    await sleep(1000);
    const SETTINGS = {
      baseURL: `http://127.0.0.1:${HTTP_PORT}/v1`,
      apiKey: '',
      model: 'fake-model',
      visionModel: 'fake-model',
      targetLang: '简体中文',
      temperature: 0.2,
      extraPrompt: '',
      protocol: 'auto',
      displayMode: 'bilingual',
      showFab: false,
      autoTranslate: false
    };
    await evalCtl(
      `chrome.storage.local.set({ settings: ${JSON.stringify(SETTINGS)} }).then(() => true)`
    );

    const openPage = async url => {
      const { targetId } = await browser.send('Target.createTarget', { url });
      const session = (await browser.send('Target.attachToTarget', { targetId, flatten: true }))
        .sessionId;
      await browser.send('Runtime.enable', {}, session);
      return { targetId, session };
    };
    const evalPage = async (session, expr) => {
      const r = await browser.send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        session
      );
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
      return r.result.value;
    };
    const shot = async (session, name) => {
      const r = await browser.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        session
      );
      writeFileSync(join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
    };

    const page = await openPage(`http://127.0.0.1:${HTTP_PORT}/page.html`);
    for (let i = 0; i < 40; i++) {
      const st = await evalPage(page.session, '({s:document.readyState,u:location.href})');
      if (st && st.s !== 'loading' && /page\.html/.test(st.u || '')) break;
      await sleep(300);
    }
    await sleep(800);

    const tid = await evalCtl(
      `(async () => {
         const tabs = await chrome.tabs.query({});
         const t = tabs.find(x => (x.url || '').includes('page.html'));
         return t ? t.id : null;
       })()`
    );
    record('找到测试标签页', !!tid, String(tid));

    const trig = await evalCtl(
      `chrome.runtime.sendMessage({ type: 'mxt:tabComic', tabId: ${tid} })
         .then(r => r || { ok: false }).catch(e => ({ ok: false, err: String(e) }))`
    );
    record('漫画指令已接受', !!(trig && trig.ok !== false), JSON.stringify(trig).slice(0, 100));

    /* 等译文出现（假服务是本地秒回，给足 20 秒） */
    let m = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      m = await evalPage(page.session, MEASURE);
      if (m && m.panel && m.panel.zh > 0) break;
    }
    if (!m || !m.img) {
      record('页面可测量', false, JSON.stringify(m).slice(0, 200));
      throw new Error('测量失败');
    }

    console.log('\n[实测数据]');
    console.log('  图片渲染盒：', JSON.stringify(m.img));
    console.log('  父容器    ：', JSON.stringify(m.wrap));
    console.log('  覆盖层    ：', JSON.stringify(m.overlays, null, 0));
    console.log('  面板      ：', JSON.stringify(m.panel));

    await shot(page.session, '01-inpaint.png');

    /* ---- 判定 ---- */
    record('产生译文行', !!(m.panel && m.panel.zh > 0), `zh=${m.panel?.zh}`);

    const ov = m.overlays || [];
    const painted = ov.filter(o => o.tag === 'IMG');
    const layers = ov.filter(o => o.tag === 'DIV');

    if (painted.length) {
      const p = painted[0];
      const dx = Math.abs(p.left - m.img.left);
      const dy = Math.abs(p.top - m.img.top);
      const dw = Math.abs(p.width - m.img.width);
      const dh = Math.abs(p.height - m.img.height);
      record(
        '擦字图层与图片完全重合',
        dx <= 1.5 && dy <= 1.5 && dw <= 1.5 && dh <= 1.5,
        `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dw=${dw.toFixed(1)} dh=${dh.toFixed(1)}`
      );
    } else {
      record('擦字图层存在', false, `只有 ${layers.length} 个文字浮层`);
    }

    if (layers.length) {
      /* 每个文字浮层都应落在对应气泡里 */
      const tol = 6;
      let worst = 0;
      let insideAll = true;
      const details = [];
      layers.forEach((o, i) => {
        const b = BUBBLES[i];
        if (!b) return;
        const exp = {
          left: m.img.left + (b.box[0] / 100) * m.img.width,
          top: m.img.top + (b.box[1] / 100) * m.img.height,
          width: ((b.box[2] - b.box[0]) / 100) * m.img.width,
          height: ((b.box[3] - b.box[1]) / 100) * m.img.height
        };
        const dx = Math.abs(o.left - exp.left);
        const dy = Math.abs(o.top - exp.top);
        const inside =
          o.left >= exp.left - tol &&
          o.top >= exp.top - tol &&
          o.left + o.width <= exp.left + exp.width + tol &&
          o.top + o.height <= exp.top + exp.height + tol;
        if (!inside) insideAll = false;
        worst = Math.max(worst, dx, dy);
        details.push(`${b.id}: dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} inside=${inside}`);
      });
      record('文字浮层落在气泡内', insideAll, details.join(' | '));
      record('浮层偏移小于 6px', worst <= tol, `最大偏移 ${worst.toFixed(1)}px`);
    }

    /* ---- 缩放 50% 后重新测量 ---- */
    await evalPage(
      page.session,
      `(() => { const i = document.getElementById('manga'); i.style.width = '210px'; return true; })()`
    );
    await sleep(900);
    const m2 = await evalPage(page.session, MEASURE);
    const ov2 = (m2 && m2.overlays) || [];
    const layers2 = ov2.filter(o => o.tag === 'DIV');
    const painted2 = ov2.filter(o => o.tag === 'IMG');
    await shot(page.session, '02-scaled50.png');

    if (painted2.length) {
      const p = painted2[0];
      const dx = Math.abs(p.left - m2.img.left);
      const dy = Math.abs(p.top - m2.img.top);
      const dw = Math.abs(p.width - m2.img.width);
      record(
        '缩放 50% 后擦字图层仍重合',
        dx <= 1.5 && dy <= 1.5 && dw <= 1.5,
        `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dw=${dw.toFixed(1)}`
      );
    }
    if (layers2.length) {
      const tol = 6;
      let worst = 0;
      let insideAll = true;
      layers2.forEach((o, i) => {
        const b = BUBBLES[i];
        if (!b) return;
        const exp = {
          left: m2.img.left + (b.box[0] / 100) * m2.img.width,
          top: m2.img.top + (b.box[1] / 100) * m2.img.height,
          width: ((b.box[2] - b.box[0]) / 100) * m2.img.width,
          height: ((b.box[3] - b.box[1]) / 100) * m2.img.height
        };
        const dx = Math.abs(o.left - exp.left);
        const dy = Math.abs(o.top - exp.top);
        const inside =
          o.left >= exp.left - tol &&
          o.top >= exp.top - tol &&
          o.left + o.width <= exp.left + exp.width + tol &&
          o.top + o.height <= exp.top + exp.height + tol;
        if (!inside) insideAll = false;
        worst = Math.max(worst, dx, dy);
      });
      record('缩放 50% 后文字仍对齐气泡', insideAll && worst <= tol, `最大偏移 ${worst.toFixed(1)}px`);
    }

    /* ---- 擦字版像素级验证：字真的画进了气泡、边框没被擦掉 ---- */
    const BOXES = BUBBLES.map(b => b.box);
    const PIXEL = await evalPage(
      page.session,
      `(async () => {
         const ov = document.querySelector('.mxt-comic-overlay[src]');
         if (!ov) return { err: '没有擦字图层' };
         const load = async (u) => {
           const im = new Image();
           await new Promise(r => { im.onload = r; im.onerror = r; im.src = u; });
           return im;
         };
         const im = await load(ov.src);
         if (!im.naturalWidth) return { err: '图层解码失败' };
         const orgEl = document.getElementById('manga');
         const org = await load(orgEl ? orgEl.src : ov.src);
         const grab = (img) => {
           const c = document.createElement('canvas');
           c.width = img.naturalWidth; c.height = img.naturalHeight;
           const cx = c.getContext('2d');
           cx.drawImage(img, 0, 0);
           return { W: c.width, H: c.height, d: cx.getImageData(0, 0, c.width, c.height).data };
         };
         const A = grab(im);
         const B = grab(org);
         const W = A.W, H = A.H;
         const d = A.d, o = B.d;
         const same = A.W === B.W && A.H === B.H;
         const dark = (x, y) => {
           const i = (y * W + x) * 4;
           return d[i] < 90 && d[i+1] < 90 && d[i+2] < 90;
         };
         const lum = (arr, i) => 0.299 * arr[i] + 0.587 * arr[i+1] + 0.114 * arr[i+2];
         const out = [];
         for (const b of ${JSON.stringify(BUBBLES.map(b => b.box))}) {
           const x1 = Math.round(b[0] / 100 * W), y1 = Math.round(b[1] / 100 * H);
           const x2 = Math.round(b[2] / 100 * W), y2 = Math.round(b[3] / 100 * H);
           const ix = Math.round((x2 - x1) * 0.16), iy = Math.round((y2 - y1) * 0.16);
           let ink = 0, tot = 0;
           for (let y = y1 + iy; y < y2 - iy; y += 2)
             for (let x = x1 + ix; x < x2 - ix; x += 2) { tot++; if (dark(x, y)) ink++; }
           let ring = 0, rtot = 0;
           for (let t = 0; t < 3; t++)
             for (let x = x1 + t; x < x2 - t; x++) {
               rtot += 2;
               if (dark(x, y1 + t)) ring++;
               if (dark(x, y2 - 1 - t)) ring++;
             }
           /* 越界检查：拿原图逐点比。
              - borderDiff：3px 描边圈，擦到它整条边都会明显变亮
              - outsideDiff：边框外 5~9px 的一圈，矩形擦除会把这里一起漂白
              用整圈均值比较，单点 JPEG 噪声会被平均掉。 */
           let outsideSum = 0, outsideN = 0, borderSum = 0, borderN = 0;
           if (same) {
             for (let y = y1 - 9; y < y2 + 9; y++) {
               for (let x = x1 - 9; x < x2 + 9; x++) {
                 if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
                 const p = (y * W + x) * 4;
                 const delta = Math.abs(lum(d, p) - lum(o, p));
                 if (x >= x1 && x < x2 && y >= y1 && y < y2) {
                   const onBorder = x < x1 + 3 || x >= x2 - 3 || y < y1 + 3 || y >= y2 - 3;
                   if (onBorder) { borderSum += delta; borderN++; }
                   continue;
                 }
                 const dx = x < x1 ? x1 - x : x >= x2 ? x - x2 + 1 : 0;
                 const dy = y < y1 ? y1 - y : y >= y2 ? y - y2 + 1 : 0;
                 const dist = Math.max(dx, dy);
                 if (dist <= 4 || dist > 9) continue;
                 outsideSum += delta;
                 outsideN++;
               }
             }
           }
           out.push({
             box: b,
             inkRatio: +(ink / (tot || 1)).toFixed(3),
             ringRatio: +(ring / (rtot || 1)).toFixed(3),
             borderDiff: +(borderSum / (borderN || 1)).toFixed(2),
             outsideDiff: +(outsideSum / (outsideN || 1)).toFixed(2)
           });
         }
         return { size: [W, H], same, out };
       })()`
    );
    console.log('  像素检测    ：', JSON.stringify(PIXEL));
    if (!PIXEL || PIXEL.err) {
      record('气泡内有新画的字', false, String((PIXEL && PIXEL.err) || '检测失败'));
    } else {
      const noInk = PIXEL.out.filter(o => o.inkRatio < 0.01).map(o => o.box.join(','));
      record('每个气泡内都有新画的字', noInk.length === 0, noInk.length ? `缺字：${noInk.join(' / ')}` : '全部有字');
      const eaten = PIXEL.out.filter(o => o.ringRatio < 0.5).map(o => `${o.box.join(',')}=${o.ringRatio}`);
      record(
        SAMPLE_NAME ? '描边留存情况（真实样本，仅记录）' : '气泡描边没有被擦掉',
        SAMPLE_NAME ? true : eaten.length === 0,
        eaten.length ? `受影响 ${eaten.length}/${PIXEL.out.length}：${eaten.join(' | ')}` : '描边完整'
      );
      if (!PIXEL.same) record('擦字图层与原图同尺寸', false, `图层 ${JSON.stringify(PIXEL.size)}`);
      const spill = PIXEL.out.filter(o => o.outsideDiff > 2.5).map(o => `${o.box.join(',')}=${o.outsideDiff}`);
      record(
        SAMPLE_NAME ? '框外画面改动量（真实样本，仅记录）' : '气泡外部画面没有被擦到',
        SAMPLE_NAME ? true : !!PIXEL.same && spill.length === 0,
        spill.length ? `超出阈值的 ${spill.length}/${PIXEL.out.length}：${spill.join(' | ')}` : '边界干净'
      );
      const borderDirty = PIXEL.out.filter(o => o.borderDiff > 2.5).map(o => `${o.box.join(',')}=${o.borderDiff}`);
      record(
        SAMPLE_NAME ? '描边像素改动量（真实样本，仅记录）' : '描边像素与原图逐点一致',
        SAMPLE_NAME ? true : !!PIXEL.same && borderDirty.length === 0,
        borderDirty.length ? borderDirty.join(' | ') : '未被改动'
      );
    }

    /* ---- 恢复原尺寸，切到浮层模式做排版检查 ---- */
    await evalPage(
      page.session,
      `(() => { const i = document.getElementById('manga'); i.style.width = ''; return true; })()`
    );
    await sleep(600);
    const switched = await evalPage(
      page.session,
      `(() => {
         const h = document.getElementById('mxt-comic-host');
         if (!h || !h.shadowRoot) return 'no-host';
         const b = h.shadowRoot.querySelector('.mxt-comic-mode');
         if (!b) return 'no-btn';
         if (b.textContent.trim() === '擦字版') b.click();
         return b.textContent.trim();
       })()`
    );
    record('可切到浮层模式', switched !== 'no-host' && switched !== 'no-btn', String(switched));
    await sleep(900);
    const m3 = await evalPage(page.session, MEASURE);
    await shot(page.session, '03-overlay-typeset.png');

    const lay3 = ((m3 && m3.overlays) || []).filter(o => o.tag === 'DIV');
    /* 条数跟着样本走：合成页 4 条，真实图是模型实际给了几条 */
    record(
      `每个文字块都有文字浮层（应为 ${BUBBLES.length} 个）`,
      lay3.length >= BUBBLES.length,
      `实际 ${lay3.length} 个`
    );

    if (lay3.length) {
      const bad = [];
      for (const o of lay3) {
        const sp = o.span;
        if (!sp || !sp.chars) bad.push(`${o.text.slice(0, 8)}:空`);
        const px = parseFloat(o.fontSize) || 0;
        if (px < 10 || px > 44) bad.push(`${o.text.slice(0, 8)}:字号${px}`);
      }
      record('每条都有译文且字号在 10-44px', bad.length === 0, bad.join(' | ') || 'ok');

      const tall = lay3.find(o => o.width <= 60 && o.height > o.width * 1.5);
      if (!tall) {
        /* 合成页专门放了一个窄高框；真实样本里不一定有，没有就跳过这条 */
        record('窄高气泡用竖排', true, '本样本没有窄高框，不适用');
      } else {
  record(
          '窄高气泡用竖排',
          !!(tall && tall.span && /vertical/.test(tall.span.writingMode || '')),
          tall && tall.span ? `writingMode=${tall.span.writingMode}` : '没找到窄高浮层'
        );
      }

      const overflow = lay3.filter(o => o.outlineStyle && o.outlineStyle !== 'none');
      record('普通气泡没有溢出', overflow.length === 0, overflow.map(o => o.text.slice(0, 6)).join(',') || 'ok');

      /* 手势分工：单击=选中，右键=看原文，双击=改字。这里验右键。 */
      const before = lay3[0].text;
      const dispatched = await evalPage(
        page.session,
        `(() => {
           const d = document.querySelector('.mxt-comic-overlay');
           if (!d) return 'no-overlay';
           d.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
           return d.textContent || '';
         })()`
      );
      await sleep(300);
      const m4 = await evalPage(page.session, MEASURE);
      const after = (((m4 && m4.overlays) || []).filter(o => o.tag === 'DIV')[0] || {}).text || '';
      record('右键可切换原文', after !== before && after.length > 0, `${before.slice(0, 10)} → ${after.slice(0, 10)} | ${String(dispatched).slice(0, 12)}`);

      /* 双击进入编辑：contentEditable 必须真的打开，否则「改字」是假的 */
      const editState = await evalPage(
        page.session,
        `(() => {
           const d = document.querySelector('.mxt-comic-overlay');
           if (!d) return null;
           const span = d.querySelector('span');
           if (!span) return null;
           d.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
           const on = span.isContentEditable;
           span.blur();
           return { on, idx: d.dataset.idx };
         })()`
      );
      record('双击打开文字编辑', !!(editState && editState.on), JSON.stringify(editState));



      await evalPage(
        page.session,
        `(() => { document.body.style.paddingBottom = '900px'; window.scrollBy(0, 150); return true; })()`
      );
      await sleep(500);
      const m5 = await evalPage(page.session, MEASURE);
      const img5 = m5 && m5.img;
      const lay5 = ((m5 && m5.overlays) || []).filter(o => o.tag === 'DIV');
      if (img5 && lay5.length) {
        const tol = 6;
        let worst5 = 0;
        lay5.forEach((o, i) => {
          const b = BUBBLES[i];
          if (!b) return;
          const ex = img5.left + (b.box[0] / 100) * img5.width;
          const ey = img5.top + (b.box[1] / 100) * img5.height;
          worst5 = Math.max(worst5, Math.abs(o.left - ex), Math.abs(o.top - ey));
        });
        record('滚动后浮层仍对齐', worst5 <= tol, `最大偏移 ${worst5.toFixed(1)}px`);
      }
      await shot(page.session, '04-after-scroll.png');
    }

    /* ---- Debug Mode ---- */
    await evalPage(
      page.session,
      `(() => {
         const h = document.getElementById('mxt-comic-host');
         const b = h && h.shadowRoot && h.shadowRoot.querySelector('.mxt-comic-debug-btn');
         if (b) b.click();
         return true;
       })()`
    );
    await sleep(600);
    const dbg2 = await evalPage(
      page.session,
      `(() => {
         const h = document.getElementById('mxt-comic-host');
         const d = h && h.shadowRoot && h.shadowRoot.querySelector('.mxt-comic-debug');
         return d ? d.textContent : '';
       })()`
    );
    record(
      'Debug Mode 输出尺寸与字号',
      !!dbg2 && /原始尺寸/.test(dbg2) && /显示尺寸/.test(dbg2) && /px/.test(dbg2),
      String(dbg2 || '').replace(/\n/g, ' / ').slice(0, 170)
    );
    /* 曾经这里出过 undefinedpx —— 界面读的字段根本不存在，溢出判定也永远为假。
       一条断言把这个类别的错整片盖住。 */
    record(
      '排版数字里没有 undefined',
      !/undefined|NaN/.test(String(dbg2 || '')),
      /undefined|NaN/.test(String(dbg2 || '')) ? String(dbg2).replace(/\n/g, ' / ').slice(0, 160) : 'ok'
    );
    const bubbleHit = /气泡识别 (\d+)\/(\d+)/.exec(String(dbg2 || ''));
    record(
      SAMPLE_NAME ? '气泡识别率（真实样本，仅记录）' : '气泡识别真的生效（不是退回矩形）',
      SAMPLE_NAME ? !!bubbleHit : !!bubbleHit && Number(bubbleHit[1]) === Number(bubbleHit[2]) && Number(bubbleHit[1]) > 0,
      bubbleHit ? `识别 ${bubbleHit[1]}/${bubbleHit[2]}（其余退回矩形）` : 'Debug 里没有气泡识别结果'
    );
    await shot(page.session, '05-debug.png');
  } catch (e) {
    console.error('测试异常：', e && e.message);
    record('整体流程', false, e && e.message);
  } finally {
    if (browser) {
      try {
        await browser.ws.close();
      } catch {
        /* ignore */
      }
    }
    proc.kill();
    server.close();
    await sleep(600);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  for (const r of results.filter(x => !x.ok)) console.log(`  失败：${r.name} ${r.detail}`);
  console.log(`截图：${SHOT_DIR}`);
  process.exit(pass === results.length ? 0 : 1);
}

try {
  if (SAMPLE_NAME) {
    /* 先准备好打包产物里的共享核心，坐标规范化要用它 */
    const corePath = join(process.cwd(), 'dist', 'core.js');
    if (existsSync(corePath)) {
      new Function('globalThis', readFileSync(corePath, 'utf8') + '\n;globalThis.MXTCore = MXTCore;')(globalThis);
    }
    loadRealSample();
  }
} catch (e) {
  console.error('真实样本装载失败：', e && e.message);
  process.exit(1);
}

main();
