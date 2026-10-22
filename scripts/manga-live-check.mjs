/* 日韩漫画站实时实测
 * ------------------------------------------------------------------
 * 跟 scripts/browser-regress.mjs 的区别：那个用本地假翻译服务验证「管线」，
 * 这个连**真实站点 + 真实翻译接口**，验证「到底能不能用」。
 *
 * 用法（密钥从环境变量读，不落盘、不进仓库）：
 *   $env:MXT_TEST_KEY = '<你的 API Key>'
 *   node scripts/manga-live-check.mjs
 *
 * 可选：
 *   MXT_TEST_BASE    默认 http://127.0.0.1:8326/v1
 *   MXT_TEST_MODEL   默认 lobsterai/MiniMax-M3.1-Flash
 *   MXT_TEST_VISION  视觉模型（漫画 OCR 用）
 *   MXT_TEST_ONLY    jp / kr / comic，只跑其中一项
 *   MXT_TEST_PROXY   给浏览器挂代理，如 http://127.0.0.1:7893（localhost 自动绕过）
 *   MXT_TEST_COMIC_URL     指定某一集漫画页（换站不用改代码）
 *   MXT_TEST_COMIC_DOMAIN  该站的域名，用于找标签页，默认 comic.naver.com
 *   MXT_TEST_POLL    轮询上限（次 × 1.5 秒），默认 30
 *
 * 注意：漫画站的图片 CDN 未必可达。Naver 的 image-comic.pstatic.net 在部分网络下
 * 无论直连还是走代理都取不到图（页面打得开、但所有 <img> 的 naturalWidth 都是 0）。
 * 那是网络问题，不是扩展问题——换一个可达的站（例如 shonenjumpplus.com）即可验证。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 9234;
const EXE = process.env.MXT_TEST_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extPath = join(process.cwd(), 'dist');

const KEY = process.env.MXT_TEST_KEY || '';
const BASE = process.env.MXT_TEST_BASE || 'http://127.0.0.1:8326/v1';
const MODEL = process.env.MXT_TEST_MODEL || 'lobsterai/MiniMax-M3.1-Flash';
// 默认值挑「真的能读图」的那个。同名不同命名空间差别很大：
//   cline/* 的 nemotron VL 收不到图片（模型自己回答「我无法查看这张图片」）；
//   raccoon/sn-deepseek-v4-1-flash-1017 是纯文本模型，网关直接把图片丢掉。
// 详见 docs/vision-models.md。
const VISION = process.env.MXT_TEST_VISION || 'our-free-model/nvidia/nemotron-3.5-super-vl:free';
const ONLY = (process.env.MXT_TEST_ONLY || '').toLowerCase();

/* 可选代理。漫画站的图片 CDN（如 image-comic.pstatic.net）在部分网络下
   直连取不到图，表现为「页面打得开、但一张长条图都没有」（comic: 0）。
   这时给浏览器挂代理：MXT_TEST_PROXY=http://127.0.0.1:7890
   localhost 必须绕过，否则连本地网关的请求也会被转发出去。 */
const PROXY = process.env.MXT_TEST_PROXY || '';

/* 漫画站可换。默认从 Naver 列表页自己找一集；也可以直接指一个分集页，
   这样换到日站（Jump+ / comic-days 等）不用改代码：
     MXT_TEST_COMIC_URL=https://shonenjumpplus.com/episode/xxx
     MXT_TEST_COMIC_DOMAIN=shonenjumpplus.com
   注意：Naver 的图片 CDN（image-comic.pstatic.net）在部分网络下完全不可达，
   表现为页面打得开、但所有 <img> 都是 naturalWidth=0。这是网络问题，不是扩展问题。 */
const COMIC_URL = process.env.MXT_TEST_COMIC_URL || '';
const COMIC_DOMAIN = process.env.MXT_TEST_COMIC_DOMAIN || 'comic.naver.com';

if (!KEY) {
  console.error('缺少 MXT_TEST_KEY 环境变量。密钥不写进仓库，也不写进脚本。');
  process.exit(2);
}
if (!existsSync(extPath)) {
  console.error('找不到 dist/，先跑 npm run build');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const record = (site, name, ok, detail = '') => {
  results.push({ site, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

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

const SITES = [
  { key: 'jp', name: '日文 · 少年ジャンプ+', url: 'https://shonenjumpplus.com/' },
  { key: 'kr', name: '韩文 · 네이버 웹툰', url: 'https://comic.naver.com/webtoon' }
];

/** 面板在 shadow root 里，document.querySelector 找不到，必须钻进去 */
const PANEL_PROBE = `(() => {
  const h = document.getElementById('mxt-comic-host');
  if (!h) return { host: false };
  const sr = h.shadowRoot;
  if (!sr) return { host: true, shadow: false };
  return {
    host: true,
    shadow: true,
    open: h.classList.contains('mxt-comic-open'),
    head: !!sr.querySelector('.mxt-comic-head'),
    body: sr.querySelectorAll('.mxt-comic-body > *').length,
    imgs: sr.querySelectorAll('.mxt-comic-body img').length,
    prog: (sr.querySelector('.mxt-comic-prog') || {}).textContent || '',
    msg: (sr.querySelector('.mxt-comic-msg') || {}).textContent || '',
    zh: sr.querySelectorAll('.mxt-comic-zh').length,
    orig: sr.querySelectorAll('.mxt-comic-orig').length,
    /* 抽前 3 组原文/译文，用来肉眼判断「真的翻对了」而不是只数了行数 */
    pairs: [...sr.querySelectorAll('.mxt-comic-body > *')].slice(0, 3).map(row => {
      const o = row.querySelector('.mxt-comic-orig');
      const z = row.querySelector('.mxt-comic-zh');
      return [((o && o.textContent) || '').slice(0, 40), ((z && z.textContent) || '').slice(0, 40)];
    })
  };
})()`;

const TRANS_COUNT = `document.querySelectorAll('.mxt-trans').length`;

async function main() {
  console.log(`实时实测：${BASE}  模型 ${MODEL}`);
  const profile = mkdtempSync(join(tmpdir(), 'mxt-live-'));

  if (!existsSync(EXE)) {
    console.error(`找不到浏览器：${EXE}`);
    process.exit(2);
  }

  const proc = spawn(
    EXE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1280,900',
      ...(PROXY ? [`--proxy-server=${PROXY}`, '--proxy-bypass-list=<local>'] : []),
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let browser = null;
  try {
    let browserWs = null;
    for (let i = 0; i < 40; i++) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
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
    browser = new CDP(bws);

    const loaded = await browser.send('Extensions.loadUnpacked', { path: extPath });
    console.log(`扩展已装载：${loaded.id}`);

    /* 扩展页上下文：有 chrome.tabs / chrome.storage */
    const { targetId: ctlId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${loaded.id}/popup/popup.html`
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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
      }
      return r.result.value;
    };

    await sleep(1200);

    const SETTINGS = {
      baseURL: BASE,
      apiKey: KEY,
      model: MODEL,
      visionModel: VISION,
      targetLang: '简体中文',
      temperature: 0.2,
      extraPrompt: '',
      protocol: 'auto',
      autoDynamic: true,
      displayMode: 'bilingual',
      showFab: false,
      autoTranslate: true,
      autoTranslateMinChars: 1
    };

    const writeSettings = patch =>
      evalCtl(
        `chrome.storage.local.set({ settings: ${JSON.stringify({ ...SETTINGS, ...patch })} })
           .then(() => true)`
      );

    await writeSettings({});

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
      if (r.exceptionDetails) {
        return { __err: r.exceptionDetails.exception?.description || 'evaluate 抛错' };
      }
      return r.result.value;
    };

    const waitComplete = async session => {
      /* Target.createTarget 有一个很短的时间窗：目标已经建好、但导航还没提交，
         此时 document.readyState 就已经是 complete（about:blank），
         早读一步就会读到空白页。必须等到真的落在目标网址上。 */
      for (let i = 0; i < 60; i++) {
        const st = await evalPage(session, '({ s: document.readyState, u: location.href })');
        /* interactive 也算——有的漫画站会挂着一个永远不结束的广告请求，
           readyState 一直停在 interactive，等 complete 会白等 30 秒。 */
        if (st && st.s !== 'loading' && st.u && st.u !== 'about:blank') return true;
        await sleep(500);
      }
      return false;
    };

    const tidOf = async match =>
      evalCtl(
        `(async () => {
           const tabs = await chrome.tabs.query({});
           const t = tabs.find(x => (x.url || '').includes(${JSON.stringify(match)}));
           return t ? t.id : null;
         })()`
      );

    const statusOf = async tid => {
      try {
        return await evalCtl(
          `chrome.tabs.sendMessage(${tid}, { type: 'mxt:status' })
             .catch(e => ({ ok: false, err: String(e) }))`
        );
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    };

    /* ---------------- 一、网页翻译 ---------------- */
    const pages = {};
    const tids = {};

    for (const site of SITES) {
      if (ONLY && ONLY !== site.key) continue;
      console.log(`\n[${site.name}] ${site.url}`);
      const page = await openPage(site.url);
      pages[site.key] = page;

      const ready = await waitComplete(page.session);
      record(site.name, '页面加载完成', ready);
      if (!ready) continue;

      /* 标题可能由站点脚本延迟写入 */
      let title = '';
      for (let i = 0; i < 10; i++) {
        title = await evalPage(page.session, 'document.title');
        if (title && String(title).trim()) break;
        await sleep(500);
      }
      record(site.name, '页面标题可读', !!(title && String(title).trim()), String(title).slice(0, 60));

      /* 等自动翻译：看双语节点数，连续两次不再增长就算稳定 */
      let segs = 0;
      let stalled = 0;
      for (let i = 0; i < 150; i++) {
        segs = await evalPage(page.session, TRANS_COUNT);
        if (typeof segs !== 'number') segs = 0;
        if (segs > 0) {
          await sleep(1500);
          const again = await evalPage(page.session, TRANS_COUNT);
          if (again === segs) stalled++;
          else stalled = 0;
          segs = typeof again === 'number' ? again : segs;
          if (stalled >= 2) break;
        }
        await sleep(500);
      }
      record(site.name, '自动翻译产生译文', segs > 0, `段数 ${segs}`);

      const tid = await tidOf(site.url.replace(/^https?:\/\//, '').split('/')[0]);
      if (tid) tids[site.key] = tid;

      if (tid) {
        const st = await statusOf(tid);
        record(
          site.name,
          '状态接口无报错',
          !(st && st.error),
          st && st.error ? String(st.error).slice(0, 120) : ''
        );
      }

      const samples = await evalPage(
        page.session,
        `(() => {
           const out = [];
           for (const el of document.querySelectorAll('.mxt-trans')) {
             const t = (el.textContent || '').trim();
             if (t) out.push(t.slice(0, 70));
             if (out.length >= 8) break;
           }
           return out;
         })()`
      );
      if (Array.isArray(samples)) for (const s of samples) console.log(`      译文样例：${s}`);

      const bodyLen = await evalPage(page.session, 'document.body.innerText.length');
      record(
        site.name,
        '页面文字未被破坏',
        typeof bodyLen === 'number' && bodyLen > 200,
        `正文字符 ${bodyLen}`
      );

      /* 还原。扩展没有独立的「还原」消息，是用 mxt:togglePage 切回原文。
         先关掉自动翻译，否则刚还原就又被翻一遍，会把「重新翻译」误报成「没还原」。 */
      if (tid) {
        await writeSettings({ autoTranslate: false });
        await sleep(600);

        await evalCtl(
          `chrome.tabs.sendMessage(${tid}, { type: 'mxt:togglePage', mode: 'full' })
             .catch(() => null)`
        );

        let left = -1;
        for (let i = 0; i < 40; i++) {
          await sleep(400);
          left = await evalPage(page.session, TRANS_COUNT);
          if (left === 0) break;
        }
        record(site.name, '一键还原后译文清空', left === 0, `残留 ${left}`);

        const leftovers = await evalPage(
          page.session,
          `(() => ({
             trans: document.querySelectorAll('.mxt-trans').length,
             marked: document.querySelectorAll('[data-mxt-out]').length,
             emptied: [...document.querySelectorAll('[data-mxt-out]')]
               .filter(e => !(e.textContent || '').trim()).length
           }))()`
        );
        record(
          site.name,
          '还原后没有留下空块',
          !!(leftovers && leftovers.emptied === 0),
          JSON.stringify(leftovers)
        );

        /* 下一个站点要重新打开自动翻译 */
        await writeSettings({ autoTranslate: true });
      }
    }

    /* ---------------- 二、漫画模式 ----------------
       首页封面多半达不到「够大的竖图」的门槛，所以先找一集真实的网页漫画。 */
    if (!ONLY || ONLY === 'comic') {
      console.log('\n[漫画模式] 从韩文站找一集网页漫画');
      const kr = pages.kr || (await openPage('https://comic.naver.com/webtoon'));

      if (!pages.kr) pages.kr = kr;
      /* 只跑 --only=comic 时这条页面是新开的，导航可能还没提交 */
      const here = String(await evalPage(kr.session, 'location.href'));
      if (!/comic\.naver\.com/.test(here)) {
        await browser.send('Page.navigate', { url: 'https://comic.naver.com/webtoon' }, kr.session);
      }
      await waitComplete(kr.session);

      /* 列表是客户端渲染的：外框先到，作品列表要等接口回来。
         早一步去查链接会查了个空，被误判成「页面没有漫画」。 */
      for (let i = 0; i < 40; i++) {
        const n = await evalPage(
          kr.session,
          `document.querySelectorAll('a[href*="titleId"]').length`
        );
        if (typeof n === 'number' && n > 0) break;
        await sleep(500);
      }

      const pageInfo = await evalPage(
        kr.session,
        `(() => ({
           href: location.href,
           title: document.title,
           anchors: document.querySelectorAll('a').length,
           detailLinks: document.querySelectorAll('a[href*="detail?titleId="]').length,
           listLinks: document.querySelectorAll('a[href*="/webtoon/list?titleId="]').length,
           body: document.body ? document.body.innerText.slice(0, 60) : ''
         }))()`
      );
      console.log(`      列表页：${JSON.stringify(pageInfo)}`);

      const pick = async sel =>
        evalPage(
          kr.session,
          `(() => {
             const a = [...document.querySelectorAll(${JSON.stringify(sel)})]
               .map(x => x.getAttribute('href') || '')
               .filter(Boolean)[0];
             return a ? new URL(a, location.href).href : '';
           })()`
        );

      /* 一级列表页上只有作品页链接（/webtoon/list?titleId=…），
         具体某一集（/webtoon/detail?…）要点进作品页才拿得到。
         以前只查 detail，所以在列表页永远找不到，漫画模式被判成「不可用」。 */
      /* 判定条件必须跟 comic.js 的 isComicLike 一致，否则会出现
         「扩展本来能翻，但测试脚本说没有合格图片」的假失败。
         实测过的例子：MangaDex 默认「单页」模式，页面图是 955×866 的横图，
         按「竖长」判是有 0 张，但扩展的横图分支（宽度占视口 70% 且高 ≥420）
         是认的。 */
      const COMIC_PROBE = `(() => {
         const vw = document.documentElement.clientWidth || 800;
         let comic = 0, long = 0;
         const imgs = [...document.querySelectorAll('img')];
         const total = imgs.length;
         const sample = [];
         for (const img of imgs) {
           const r = img.getBoundingClientRect();
           if (sample.length < 3) sample.push({
             nw: img.naturalWidth, nh: img.naturalHeight,
             w: Math.round(r.width), h: Math.round(r.height),
             loading: img.getAttribute('loading') || '',
             src: (img.currentSrc || img.src || '').slice(0, 50)
           });
           if (!img.naturalWidth || !img.naturalHeight) continue;
           if (r.width < 260 || r.height < 340) continue;
           if (img.naturalWidth < 350) continue;
           const ratio = r.height / r.width;
           if (ratio > 1.12) { long++; comic++; continue; }
           if (r.width >= vw * 0.7 && r.height >= 420) comic++;
         }
         return { total, comic, long, y: Math.round(scrollY),
                  dh: document.documentElement.scrollHeight, ih: innerHeight, sample };
       })()`;

      let candidates = [];
      const direct = COMIC_URL || (await pick('a[href*="detail?titleId="]'));
      if (direct) {
        candidates = [direct];
      } else {
        const seriesList = await evalPage(
          kr.session,
          `(() => [...document.querySelectorAll('a[href*="/webtoon/list?titleId="]')]
             .map(x => new URL(x.getAttribute('href') || '', location.href).href)
             .filter(h => /titleId=\\d+/.test(h))
             .slice(0, 3))()`
        );
        for (const s of Array.isArray(seriesList) ? seriesList : []) {
          await browser.send('Page.navigate', { url: s }, kr.session);
          await waitComplete(kr.session);
          for (let i = 0; i < 3; i++) {
            await evalPage(kr.session, 'window.scrollBy(0, 600), 1');
            await sleep(600);
          }
          const d = await pick('a[href*="detail?titleId="]');
          if (d) {
            candidates.push(d);
          } else {
            const tid = new URL(s).searchParams.get('titleId');
            if (tid) candidates.push(`https://comic.naver.com/webtoon/detail?titleId=${tid}&no=1`);
          }
        }
      }
      console.log(`      候选分集：${candidates.length} 个`);

      /* 不是每一集都能翻：付费/预告/横排版式的分集里没有够大的竖图。
         试几集，找到第一集真的能翻的为止，而不是随机撞一集就下结论。 */
      let link = '';
      let cand = null;
      for (const url of candidates) {
        await browser.send('Page.navigate', { url }, kr.session);
        await waitComplete(kr.session);
        /* 长条图是懒加载的，一屏一屏往下走，走到滚不动为止 */
        for (let i = 0; i < 40; i++) {
          const before = await evalPage(kr.session, 'window.scrollY');
          await evalPage(kr.session, 'window.scrollBy(0, window.innerHeight * 1.4), 1');
          await sleep(650);
          cand = await evalPage(kr.session, COMIC_PROBE);
          if (cand && cand.comic > 0) break;
          const after = await evalPage(kr.session, 'window.scrollY');
          if (after === before && i > 2) break;
        }
        console.log(`      ${url} → 图片 ${JSON.stringify(cand)}`);
        if (cand && cand.comic > 0) {
          link = url;
          break;
        }
      }

      record('漫画模式', '找到一集可翻译的漫画', !!link, link || `试了 ${candidates.length} 集都没有可翻的漫画图`);
      if (link) {
        const href = await evalPage(kr.session, 'location.href');
        record('漫画模式', '漫画阅读页已打开', true, String(href).slice(0, 90));
        record('漫画模式', '页面存在可翻译的漫画图', true, JSON.stringify(cand));

        const krTid = (await tidOf(COMIC_DOMAIN)) || tids.kr;
        record('漫画模式', '拿到标签页 id', !!krTid, String(krTid));

        if (krTid) {
          const trig = await evalCtl(
            `chrome.runtime.sendMessage({ type: 'mxt:tabComic', tabId: ${krTid} })
               .then(r => r || { ok: false })
               .catch(e => ({ ok: false, err: String(e) }))`
          );
          record('漫画模式', '触发指令已接受', !!(trig && trig.ok !== false), JSON.stringify(trig).slice(0, 120));
          await sleep(3000);

          const panel = await evalPage(kr.session, PANEL_PROBE);
          record('漫画模式', '面板已注入', !!(panel && panel.head), JSON.stringify(panel).slice(0, 160));
          record('漫画模式', '收集到图片', !!(panel && panel.body > 0), `图片 ${panel && panel.body}`);

          if (panel && panel.body > 0) {
            let state = '';
            const polls = Number(process.env.MXT_TEST_POLL || 30);
            for (let i = 0; i < polls; i++) {
              await sleep(1500);
              const now = await evalPage(kr.session, PANEL_PROBE);
              state = JSON.stringify(now);
              if (now && now.zh > 0) break;
              if (now && now.msg && /失败|错误|没有|找不到|不支持/.test(now.msg)) break;
            }
            console.log(`      面板状态：${state}`);
            record('漫画模式', '产生译文行', /"zh":[1-9]/.test(state), state.slice(0, 180));

            /* 面板按钮在 shadow root 里，页面上下文点得到，不需要额外消息通道 */
            const CLICK_ALL = `(() => {
              const h = document.getElementById('mxt-comic-host');
              const b = h && h.shadowRoot && h.shadowRoot.querySelector('.mxt-comic-all');
              if (!b) return false;
              b.click();
              return true;
            })()`;
            const clicked = await evalPage(kr.session, CLICK_ALL);
            await sleep(2500);
            const after = await evalPage(kr.session, PANEL_PROBE);
            record(
              '漫画模式',
              '批量翻译已启动',
              /* 只有一两张图时批量会秒完，等我们再查时 msg 已经是「完成：成功 N 张」。
                 两种状态都算启动过，否则就是测试自己跟自己抢时间。 */
              !!clicked && /批量翻译|完成：成功/.test((after && after.msg) || ''),
              JSON.stringify(after).slice(0, 160)
            );
            /* 立刻停掉，别把一集上百张真跑一遍 */
            await evalPage(kr.session, CLICK_ALL);
            await sleep(800);
          }
        }
      }
    }
  } catch (e) {
    console.error('测试异常：', e && e.message);
  } finally {
    if (browser) {
      try {
        await browser.ws.close();
      } catch {
        /* ignore */
      }
    }
    proc.kill();
    await sleep(800);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch {
      /* Windows 上偶尔删不掉，不影响结论 */
    }
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  for (const r of results.filter(x => !x.ok)) {
    console.log(`  失败：${r.site} · ${r.name} ${r.detail}`);
  }
  process.exit(pass === results.length ? 0 : 1);
}

main();
