'use strict';

/* ------------------------------------------------------------------ *
 * 译点 · 自建 AI 翻译 —— 内容脚本
 * 职责：划词气泡 / 结果卡片 / 整页双语注入 / 进度提示
 * UI 挂在 Shadow DOM 里，避免被页面 CSS 和全局事件干扰
 * ------------------------------------------------------------------ */

(() => {
  if (window.__MXT_ACTIVE__) return;
  window.__MXT_ACTIVE__ = true;

  const BLOCK_SELECTOR =
    'p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,figcaption,blockquote,summary,' +
    /* 论文站点常用 div 当段落（arXiv 的 LaTeXML、Springer、ScienceDirect 等） */
    '.ltx_para,.ltx_p,.ltx_abstract,.para,.article-paragraph,.c-article-paragraph,' +
    '.AbstractText,.abstract-section,.ref-list li,.c-article-subject-group';
  const APPEND_INSIDE = new Set(['TD', 'TH', 'LI', 'DD', 'DT']);
  /* 带这些东西的元素在「仅译文」时不能整块藏掉 */
  const MEDIA_SELECTOR = 'img, picture, video, canvas, svg, iframe, object, embed';
  const CHUNK_SIZE = 8;
  const CONCURRENCY = 2;

  const state = {
    nodes: [],
    sources: [],
    recs: [],
    skipped: new Set(), // 这轮「别整块翻」的容器（用 Set 记，不往 DOM 上加 class）
    busy: false,
    observing: false,
    targetLang: '简体中文',
    root: null,
    mode: 'smart',
    displayMode: 'bilingual'
  };

  let runToken = 0; // 每轮翻译一个令牌，还原或重来时作废在途结果

  /* ============================ UI ============================ */

  const host = document.createElement('div');
  host.id = 'mxt-host';
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    top: '0px',
    left: '0px',
    width: '0px',
    height: '0px',
    zIndex: '2147483647'
  });

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    :host { all: initial; }
    .mxt-bubble {
      position: fixed; display: none; align-items: center; gap: 6px;
      padding: 6px 11px; border-radius: 8px; background: #111827; color: #fff;
      font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.28); cursor: pointer; user-select: none;
      border: 1px solid rgba(255,255,255,.1); white-space: nowrap;
    }
    .mxt-bubble:hover { background: #1f2937; }
    .mxt-card {
      position: fixed; display: none; flex-direction: column;
      width: 400px; max-width: 92vw; max-height: 70vh;
      background: #fff; color: #111827; border-radius: 12px; overflow: hidden;
      box-shadow: 0 16px 48px rgba(0,0,0,.24); border: 1px solid rgba(0,0,0,.08);
      font: 400 14px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .mxt-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px 8px 14px; background: #f9fafb;
      border-bottom: 1px solid rgba(0,0,0,.06); font-size: 12px; color: #6b7280;
      flex: 0 0 auto;
    }
    .mxt-head b { font-weight: 600; color: #374151; }
    .mxt-actions { display: flex; gap: 4px; }
    .mxt-mini {
      border: 0; background: transparent; color: #6b7280; cursor: pointer;
      font: inherit; padding: 3px 7px; border-radius: 6px;
    }
    .mxt-mini:hover { background: rgba(0,0,0,.06); color: #111827; }
    .mxt-body { padding: 12px 14px 14px; overflow: auto; flex: 1 1 auto; }
    .mxt-src {
      color: #9ca3af; font-size: 12px; line-height: 1.5; margin-bottom: 8px;
      max-height: 5.5em; overflow: hidden; white-space: pre-wrap; word-break: break-word;
      border-left: 2px solid #e5e7eb; padding-left: 8px;
    }
    .mxt-trans { white-space: pre-wrap; word-break: break-word; }
    .mxt-err { color: #b91c1c; white-space: pre-wrap; word-break: break-word; }
    .mxt-stat {
      margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(0,0,0,.06);
      color: #9ca3af; font-size: 11px; line-height: 1.5;
    }
    .mxt-dots::after {
      content: ""; animation: mxt-dots 1.2s steps(4, end) infinite;
    }
    @keyframes mxt-dots {
      0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; }
    }
    .mxt-toast {
      position: fixed; right: 20px; bottom: 20px; display: none;
      max-width: 320px; padding: 10px 14px; border-radius: 10px;
      background: rgba(17,24,39,.94); color: #fff;
      font: 400 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.3); white-space: pre-wrap; word-break: break-word;
    }
    .mxt-fab {
      position: fixed; right: 0; top: 50%; transform: translateY(-50%);
      display: none; align-items: center; justify-content: center;
      width: 32px; height: 32px; padding: 0; border: 0; border-radius: 10px 0 0 10px;
      background: rgba(17,24,39,.86); color: #fff;
      font: 600 13px/1 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: -1px 0 8px rgba(0,0,0,.22); cursor: pointer; opacity: .42;
      transition: opacity .15s ease, width .15s ease; user-select: none;
    }
    .mxt-fab:hover { opacity: 1; width: 38px; }
    .mxt-fab.mxt-on { opacity: .95; }
  `;
  shadow.appendChild(styleEl);

  const bubble = document.createElement('div');
  bubble.className = 'mxt-bubble';
  bubble.textContent = '译';
  bubble.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'mxt-card';
  card.style.display = 'none';

  const toast = document.createElement('div');
  toast.className = 'mxt-toast';
  toast.style.display = 'none';

  /* 网页右侧的快捷图标：不用记快捷键也能翻 */
  const fab = document.createElement('button');
  fab.className = 'mxt-fab';
  fab.type = 'button';
  fab.title = '译点：翻译这一页';
  fab.textContent = '译';
  fab.style.display = 'none';

  shadow.append(bubble, card, toast, fab);

  function mount() {
    if (!host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
    }
  }
  mount();

  /* ------------------------- 右侧快捷图标 ------------------------- */

  let fabWanted = true;
  let fabLabel = '';

  function setFab() {
    if (!fabWanted) {
      if (fab.style.display !== 'none') fab.style.display = 'none';
      return;
    }
    mount();
    if (fab.style.display !== 'flex') fab.style.display = 'flex';

    const label = state.busy ? '…' : state.nodes.length ? '原' : '译';
    if (label === fabLabel) return;
    fabLabel = label;
    fab.textContent = label;
    fab.title =
      label === '原'
        ? '译点：还原原文'
        : label === '…'
          ? '译点：正在翻译'
          : '译点：翻译这一页（Alt+T）';
    fab.classList.toggle('mxt-on', label !== '译');
  }

  fab.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });

  fab.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    togglePage('smart');
  });

  /* ------------------------- 提示条 ------------------------- */

  let toastTimer = null;
  function showToast(text, duration = 2200) {
    mount();
    toast.textContent = text;
    toast.style.display = 'block';
    setFab();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = duration ? setTimeout(() => (toast.style.display = 'none'), duration) : null;
  }
  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    toast.style.display = 'none';
  }

  /* ------------------------- 划词气泡 ------------------------- */

  let pendingText = '';
  let cardOut = null;
  let cardStat = null;
  let cardText = '';

  function getSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length > 8000) return { text: text.slice(0, 8000), rect: sel.getRangeAt(0).getBoundingClientRect() };
    return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
  }

  function showBubble(rect, text) {
    pendingText = text;
    const top = Math.min(Math.max(rect.bottom + 8, 8), window.innerHeight - 48);
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 70);
    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';
    bubble.style.display = 'flex';
  }

  function hideBubble() {
    bubble.style.display = 'none';
    pendingText = '';
  }

  bubble.addEventListener('mousedown', e => {
    // 保住选区，别让点击把 selection 清掉
    e.preventDefault();
    e.stopPropagation();
  });

  bubble.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const text = pendingText;
    const rect = bubble.getBoundingClientRect();
    hideBubble();
    if (text) openCard(text, rect);
  });

  document.addEventListener(
    'mouseup',
    e => {
      if (e.target === host) return;
      setTimeout(() => {
        const info = getSelectionInfo();
        if (info) showBubble(info.rect, info.text);
        else hideBubble();
      }, 10);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    e => {
      if (e.target === host) return;
      hideBubble();
      if (card.style.display === 'block' && e.target !== host) {
        // 点卡片外面就关掉
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(card)) closeCard();
      }
    },
    true
  );

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      hideBubble();
      closeCard();
    }
  });

  /* ------------------------- 结果卡片 ------------------------- */

  function closeCard() {
    card.style.display = 'none';
    card.replaceChildren();
  }

  function placeCard(rect) {
    const width = Math.min(400, window.innerWidth - 24);
    let left = Math.min(Math.max(rect.left, 12), window.innerWidth - width - 12);
    let top = rect.bottom + 10;
    card.style.width = width + 'px';
    card.style.left = left + 'px';
    // 先放到下方，放不下再翻到上方
    card.style.top = top + 'px';
    const h = card.offsetHeight || 240;
    if (top + h > window.innerHeight - 12) {
      top = Math.max(12, rect.top - h - 10);
      card.style.top = top + 'px';
    }
  }

  function buildCard({ source, translation, error, loading }) {
    card.replaceChildren();
    cardOut = null;
    cardStat = null;
    cardText = translation || '';

    const head = document.createElement('div');
    head.className = 'mxt-head';

    const title = document.createElement('span');
    title.innerHTML = '<b>译点</b>';

    const actions = document.createElement('div');
    actions.className = 'mxt-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mxt-mini';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('mousedown', ev => ev.preventDefault());
    copyBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ok = await copyText(cardText);
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => (copyBtn.textContent = '复制'), 1200);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'mxt-mini';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('mousedown', ev => ev.preventDefault());
    closeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      closeCard();
    });

    actions.append(copyBtn, closeBtn);
    head.append(title, actions);

    const body = document.createElement('div');
    body.className = 'mxt-body';

    if (source) {
      const src = document.createElement('div');
      src.className = 'mxt-src';
      src.textContent = source;
      body.appendChild(src);
    }

    const out = document.createElement('div');
    if (error) {
      out.className = 'mxt-err';
      out.textContent = error;
    } else if (loading) {
      out.className = 'mxt-trans mxt-dots';
      out.textContent = '翻译中';
    } else {
      out.className = 'mxt-trans';
      out.textContent = translation || '';
    }
    body.appendChild(out);

    const stat = document.createElement('div');
    stat.className = 'mxt-stat';
    body.appendChild(stat);

    cardOut = out;
    cardStat = stat;
    card.append(head, body);
    card.style.display = 'flex';
  }

  /* 流式过程中只改文本，不重建 DOM，避免滚动位置和选中状态被重置 */
  function setCardText(text) {
    cardText = stripMarkers(text);
    if (!cardOut) return;
    cardOut.className = 'mxt-trans';
    cardOut.textContent = cardText;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        host.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  /* 翻译速度：首字延迟最接近「点下去多久有反应」的感觉 */
  function fmtSec(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
  }

  function setCardStat(text) {
    if (cardStat) cardStat.textContent = text || '';
  }

  async function openCard(text, rect) {
    const src = text.trim();
    if (!src) return;
    const anchor = rect || { left: 20, top: 20, bottom: 20 };
    buildCard({ source: src, loading: true });
    placeCard(anchor);

    const started = Date.now();
    let firstAt = 0;
    let chars = 0;

    setCardStat('请求中…');

    const res = await streamSingle(src, partial => {
      if (!firstAt) firstAt = Date.now() - started;
      chars = partial.length;
      setCardText(partial);
    });

    if (!res.ok) {
      buildCard({ source: src, error: res.error || '翻译失败' });
      placeCard(anchor);
      setCardStat(`等了 ${fmtSec(Date.now() - started)} 才失败`);
      return;
    }

    const totalMs = Date.now() - started;
    const out = res.text || '（模型返回空）';
    setCardText(out);

    const total = Math.max(1, totalMs);
    const ttft = firstAt || total;
    const cps = Math.round((String(out).length / Math.max(1, total - ttft)) * 1000 * 10) / 10;
    const label =
      { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' }[res.protocol] ||
      res.protocol ||
      '';
    setCardStat(
      `首字 ${fmtSec(ttft)} · 总 ${fmtSec(total)} · 约 ${cps} 字/秒` + (label ? ` · ${label}` : '')
    );
  }

  /* ------------------------- 与后台通信 ------------------------- */

  function connectStream() {
    try {
      return chrome.runtime.connect({ name: 'mxt-stream' });
    } catch (_) {
      return null;
    }
  }

  /* 后台太久没回音（Service Worker 被浏览器挂起时可能出现）就别一直等，
     否则页面会永远停在「翻译中」，只能刷新 */
  const STREAM_IDLE_MS = 45000;

  function idleWatchdog(finish) {
    let timer = null;
    return {
      arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          finish();
        }, STREAM_IDLE_MS);
      },
      stop() {
        if (timer) clearTimeout(timer);
        timer = null;
      }
    };
  }

  /* 单段流式：每来一段就回调一次 */
  function streamSingle(text, onDelta) {
    return new Promise(resolve => {
      const port = connectStream();
      if (!port) {
        resolve({ ok: false, error: '扩展后台不可用，刷新页面后重试' });
        return;
      }
      let acc = '';
      let settled = false;
      const finish = r => {
        if (settled) return;
        settled = true;
        dog.stop();
        resolve(r);
      };
      const dog = idleWatchdog(() => {
        finish({ ok: false, error: '后台很久没有响应，先停下了（刷新页面可以重试）' });
        try {
          port.disconnect();
        } catch (_) {
          /* 忽略 */
        }
      });

      port.onMessage.addListener(m => {
        dog.arm();
        if (m.type === 'delta') {
          acc += m.text;
          if (onDelta) onDelta(acc);
        } else if (m.type === 'done') {
          finish({ ok: true, text: m.translation ?? acc, protocol: m.protocol });
          port.disconnect();
        } else if (m.type === 'error') {
          finish({ ok: false, error: m.error });
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => {
        finish(acc ? { ok: true, text: acc } : { ok: false, error: '连接被后台断开' });
      });

      dog.arm();
      port.postMessage({ type: 'stream', mode: 'single', texts: [text] });
    });
  }

  /* 整批流式：边收边插入已经完整的段落 */
  function makeInserter(blocks, onInsert, token) {
    const seen = new Set();
    let count = 0;

    function take(index, text) {
      if (!text || index < 0 || index >= blocks.length || seen.has(index)) return;
      seen.add(index);
      if (text !== blocks[index].text) {
        insertTranslation(blocks[index].el, text, token, blocks[index].inside, blocks[index].parts, {
          partial: !!blocks[index].partial
        });
        count++;
        if (onInsert) onInsert(count);
      }
    }

    return {
      /* 只有后面跟着新编号的段落才算写完，避免插入半截句子 */
      complete(raw) {
        const re = /<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>)/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
          take(Number(m[1]) - 1, m[2].trim());
        }
      },
      all(raw) {
        parseMarkedLocal(raw, blocks.length).forEach((text, i) => take(i, text));
      },
      get count() {
        return count;
      }
    };
  }

  function streamBatch(blocks, onInsert, token) {
    return new Promise(resolve => {
      const port = connectStream();
      if (!port) {
        resolve({ ok: false, error: '扩展后台不可用，刷新页面后重试' });
        return;
      }

      const inserter = makeInserter(blocks, onInsert, token);
      let raw = '';
      let settled = false;
      const finish = r => {
        if (settled) return;
        settled = true;
        dog.stop();
        resolve(r);
      };
      const dog = idleWatchdog(() => {
        inserter.all(raw);
        finish({ ok: false, error: '后台很久没有响应，先停下了（刷新页面可以重试）', inserted: inserter.count });
        try {
          port.disconnect();
        } catch (_) {
          /* 忽略 */
        }
      });

      port.onMessage.addListener(m => {
        dog.arm();
        if (m.type === 'delta') {
          raw += m.text;
          inserter.complete(raw);
        } else if (m.type === 'done') {
          inserter.all(m.raw || raw);
          finish({ ok: true, inserted: inserter.count });
          port.disconnect();
        } else if (m.type === 'error') {
          inserter.all(raw);
          finish({ ok: false, error: m.error, inserted: inserter.count });
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => {
        inserter.all(raw);
        finish({ ok: true, inserted: inserter.count });
      });

      dog.arm();
      port.postMessage({ type: 'stream', mode: 'batch', texts: blocks.map(b => b.text) });
    });
  }

  /* ------------------------- 整页翻译 ------------------------- */

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }

  /* 判断一段文字是不是目标语言。
     汉字、假名、谚文必须分开算：中文页和日文页都是汉字为主，
     早先把它们合在一起算「cjk」，结果日文页、韩文页被判成「已经是中文」，
     一个块都不收，页面完全不翻。 */
  function isSameLanguage(text, target) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (!letters) return true;
    const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    const kana = (text.match(/[\u3040-\u30ff\uff66-\uff9d]/gu) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/gu) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const t = String(target || '');

    /* 简体中文 / 繁体中文：汉字为主，且没有明显假名（否则是日文） */
    if (/中文|汉语|漢語|繁体|繁體|chinese|zh/i.test(t)) {
      return kana < letters * 0.05 && hangul < letters * 0.05 && han / letters > 0.6;
    }
    /* 日文：得真的有假名。
       纯汉字的页面（日文也常用汉字）光看文字分不出来，
       这时候只有 <html lang> 能判定 —— 拿不到就当它不是目标语言，
       宁可多翻一次，也不要整页不翻。 */
    if (/日|japanese|jp/i.test(t)) {
      if (kana / letters > 0.05) return true;
      if (hangul / letters > 0.05) return false;
      const htmlLang = String((document.documentElement && document.documentElement.lang) || '')
        .trim()
        .toLowerCase();
      if (htmlLang.startsWith('ja')) return true;
      return false;
    }
    /* 韩文：谚文为主 */
    if (/한|韩|韓|korean|ko/i.test(t)) {
      return hangul / letters > 0.1;
    }
    if (/英语|英文|english/i.test(t)) return latin / letters > 0.9;
    return false;
  }

  /* --------------------- 页面语言判断 --------------------- */

  /* 各书写系统的字符比例 */
  function scriptRatio(text) {
    const s = String(text || '');
    const c = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0, other: 0 };
    let total = 0;
    for (const ch of s) {
      const p = ch.codePointAt(0);
      if (p < 0x41) continue; // 标点、数字、控制字符
      total++;
      if (p >= 0x4e00 && p <= 0x9fff) c.han++;
      else if ((p >= 0x3040 && p <= 0x30ff) || (p >= 0xff66 && p <= 0xff9d)) c.kana++;
      else if ((p >= 0xac00 && p <= 0xd7af) || (p >= 0x1100 && p <= 0x11ff)) c.hangul++;
      else if ((p >= 0x41 && p <= 0x5a) || (p >= 0x61 && p <= 0x7a) || (p >= 0xc0 && p <= 0x24f)) c.latin++;
      else if (p >= 0x400 && p <= 0x4ff) c.cyrillic++;
      else c.other++;
    }
    if (!total) return null;
    return { ...c, total };
  }

  /* 目标语言名 → 大致的书写系统 */
  function targetScript(target) {
    const t = String(target || '').toLowerCase();
    if (/中文|漢語|汉语|chinese|zh/.test(t)) return 'han';
    if (/日|japanese|jp/.test(t)) return 'kana';
    if (/한|韩|韓|korean|ko/.test(t)) return 'hangul';
    if (/英语|英文|english|^en/.test(t)) return 'latin';
    if (/俄|рус|russian/.test(t)) return 'cyrillic';
    return null;
  }

  /**
   * 这个页面是不是目标语言？
   * 依据：<html lang> 优先（站点自己声明的最准），其次看正文文字的构成。
   */
  function pageIsTargetLanguage(text, target) {
    const htmlLang = (document.documentElement && document.documentElement.lang) || '';
    const t = String(target || '').trim();
    const want = targetScript(t);

    /* --- <html lang> 明确说了 --- */
    const hl = String(htmlLang).trim().toLowerCase();
    if (hl && hl !== 'und' && hl !== 'zxx') {
      const base = hl.split('-')[0];
      if (want === 'han' && base === 'zh') return true;
      if (want === 'kana' && base === 'ja') return true;
      if (want === 'hangul' && base === 'ko') return true;
      if (want === 'latin' && base === 'en') return true;
      if (want === 'cyrillic' && base === 'ru') return true;
      /* 说是别的语言，且书写系统跟目标不一样 —— 肯定要翻 */
      if (want && /^[a-z]{2,3}$/.test(base)) {
        const s = scriptRatio(base);
        if (s) {
          /* 用 base 自己的文字判断不了书写系统，改用已知映射 */
          const map = { ru: 'cyrillic', en: 'latin', ja: 'kana', ko: 'hangul', zh: 'han' };
          const bs = map[base];
          if (bs && bs !== want) return false;
        }
      }
    }

    /* --- 看文字构成 --- */
    const r = scriptRatio(text);
    if (!r) return true; // 没文字，先当是目标语言，不打扰用户
    const cjk = r.han + r.kana + r.hangul;
    if (want === 'han') return r.kana <= r.han * 0.3 && r.han / (cjk + r.latin + r.cyrillic || 1) > 0.3;
    if (want === 'kana') {
      /* 日语：得真的有假名。纯汉字的中文页面不算日语 ——
         中文里也常用汉字，光看「汉字占主导」会把中文页面误判成日文。 */
      if (r.kana > 0.05) return true;
      return hl.startsWith('ja');
    }
    if (want === 'hangul') return r.hangul > 0.1;
    if (want === 'latin') return r.latin > 0.5 && r.han < r.total * 0.1;
    if (want === 'cyrillic') return r.cyrillic > 0.4;
    return true; // 认不出目标语言就不自动翻
  }

  /* 抽样页面的正文，用来判断语言 */
  function samplePageText() {
    const parts = [];
    let n = 0;
    const walk = el => {
      if (n > 4000) return;
      for (const c of el.childNodes || []) {
        if (n > 4000) return;
        if (c.nodeType === 3) {
          const s = String(c.nodeValue || '').trim();
          if (s.length >= 2) {
            parts.push(s);
            n += s.length;
          }
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') continue;
          walk(c);
        }
      }
    };
    try {
      walk(document.body || document.documentElement);
    } catch (_) {
      /* 忽略 */
    }
    return parts.join(' ').slice(0, 4000);
  }

  /* 已经翻过的段落别再翻一次 —— 动态加载时要靠它避免重复插入 */
  function alreadyTranslated(el) {
    if (el.querySelector && el.querySelector(':scope > .mxt-trans')) return true;
    const next = el.nextElementSibling;
    return !!next && typeof next.getAttribute === 'function' && next.getAttribute('data-mxt') === '1';
  }

  /* React / Vue 这类框架更新内容时，会直接改文本节点，把我们的译文顶回原文，
     但 DOM 结构没变、class 也留着（于是 mxt-swapped 还在，看着像「翻过了」）。
     结果就是：框架一更新，那几行又变回英文，而且因为还带着 mxt-orig，
     后面收集时会被 closest('.mxt-orig') 挡掉，再也补不回来。

     这里判断「这个块标着已翻译，但当前文字其实还是原文」——是的话，
     就把旧的翻译记录作废，让它能被重新收集、重新翻译。

     两种换字方式都要管：
       - parts（按文本节点换）：框架改了那几个文本节点
       - 整块换：框架把子元素换回去了（我们插进去的文本节点被冲掉） */
  function invalidateIfReverted(rec, targetLang) {
    if (!rec || !rec.swapped) return false;
    const el = rec.el;
    if (!el || el.isConnected === false) return false;

    const nowText = ownText(el);
    if (!nowText) return false;

    /* 拿当前文字和「我们翻之前的原文」比：一样就说明被顶回去了 */
    const origText = rec.origText || '';
    if (!origText) return false;
    if (nowText !== origText) return false; // 译文还在，不用管

    /* 文字确实被顶回原文了：作废这条记录，让它能被重新翻译 */
    if (rec.node && rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
    if (el.classList) {
      el.classList.remove('mxt-swapped');
      el.classList.remove('mxt-orig');
    }
    rec.swapped = false;
    rec.savedTexts = null;
    rec.parts = null;
    rec.segs = null;
    rec.text = '';
    rec.origText = '';
    /* 从全局列表里摘掉，否则还原时会对一个已经不存在的节点操作 */
    const i = state.recs.indexOf(rec);
    if (i >= 0) state.recs.splice(i, 1);
    const j = state.nodes.indexOf(rec.node);
    if (j >= 0) state.nodes.splice(j, 1);
    const k = state.sources.indexOf(el);
    if (k >= 0) state.sources.splice(k, 1);
    return true;
  }

  /* ------------------------- 正文区域识别 ------------------------- */

  /* 常见的主内容容器。都不匹配就跟以前一样翻整页 */
  const MAIN_SELECTOR = [
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    '#content',
    '#main',
    '.content',
    '.main',
    '.post',
    '.post-content',
    '.post-body',
    '.article',
    '.article-content',
    '.article-body',
    '.entry-content',
    '.markdown-body',
    '.doc-content',
    '.rich_media_content',
    /* 论文站点（arXiv / PMC / Springer / JSTOR / IEEE / ScienceDirect 等） */
    '.ltx_document',
    '.ltx_para',
    '.abstract',
    '.abstract-content',
    '.article-body',
    '.article__body',
    '.c-article-body',
    '.hlFld-Fulltext',
    '.fulltext',
    '.FullText',
    '.article-section',
    '.paper-body',
    '.document-content',
    '.content-container',
    '.body-content',
    '#bodyContent',
    '.j-full-text',
    '.article-fulltext'
  ].join(',');

  function charCount(el) {
    return String(el.textContent || '').replace(/\s+/g, '').length;
  }

  /* 挑一个「装着最多正文」的容器。挑不出来就返回 null（=翻整页） */
  function pickScope() {
    let best = null;
    let total = 0;
    try {
      total = charCount(document.body || document.documentElement);
    } catch (_) {
      return null;
    }
    if (total < 400) return null; // 内容太少，不值得锁定

    let candidates = [];
    try {
      candidates = Array.from(document.querySelectorAll(MAIN_SELECTOR));
    } catch (_) {
      return null;
    }

    for (const el of candidates) {
      if (el.closest('#mxt-host')) continue;
      let blocks;
      try {
        blocks = el.querySelectorAll(BLOCK_SELECTOR);
      } catch (_) {
        continue;
      }
      if (blocks.length < 3) continue; // 太小的容器不算正文
      let chars = 0;
      for (const b of blocks) chars += charCount(b);
      if (!best || chars > best.chars) best = { el, chars };
    }

    if (!best) return null;
    // 候选几乎就是整页（比如博客首页只有一篇文章），锁不锁没区别
    if (best.chars / total > 0.8) return null;
    return best.el;
  }

  /* 这些地方不该翻：代码、输入框、用户内容、标了 don't translate 的，以及 SVG
     （svg 里的 <text> 是图标/logo 的一部分，innerText 会把它当成正文带出去，
      翻出来就成了「图标上的中文」，只会把图形弄坏） */
  const SKIP_SELECTOR =
    'pre,code,kbd,samp,var,script,style,textarea,input,select,option,svg,math,[contenteditable],[contenteditable="true"],[translate="no"],.notranslate,#mxt-host';

  function shouldSkip(el) {
    if (el.matches && el.matches(SKIP_SELECTOR)) return true;
    if (el.closest && el.closest(SKIP_SELECTOR)) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  }

  /* 一个元素能不能当成「一段」来翻 */
  function makeBlock(el, targetLang, inside) {
    if (el.closest('.mxt-trans')) return null;
    if (el.closest('.mxt-orig')) return null; // 已经在翻过的容器里（它的子元素不用再翻一遍）
    if (alreadyTranslated(el)) return null;
    if (shouldSkip(el)) return null;
    if (!isVisible(el)) return null;
    const text = blockText(el);
    if (text.length < 2 || text.length > 4000) return null;
    if (!/[\p{L}]/u.test(text)) return null;
    if (isSameLanguage(text, targetLang)) return null;

    /* 段落里有链接、按钮或图标 svg 时，用 {{k}} 标出每个文本节点的位置：
       译文回来后只换文字，<a>、<button>、<svg> 这些结构原样留下，
       链接照样能点、按钮照样能按、图标不会没。

       注意：自己被包在 <a> / <button> 里也算（比如导航 <button><span>Games</span></button>
       里的 span）——这种整块换字会把文字挪出链接/按钮，点了就没反应。 */
    let parts = null;
    let out = text;
    let wantParts = false;
    try {
      const inLink = el.closest && el.closest('a, button') ? true : false;
      /* 元素自己就是 <a> 时，里面的 svg/文字也该按文本节点换：
         <a class="button"><svg/><span>Mod faster with premium</span></a>
         整块换会把图标和文字一起干掉，只有按文本节点换才行 */
      const hasInner =
        !!el.querySelector &&
        !!(el.querySelector('a') || el.querySelector('button') || el.querySelector('svg,math'));
      wantParts = !!(inLink || hasInner);
    } catch (_) {
      wantParts = false;
    }
    if (wantParts) {
      try {
        const nodes = inlineTextNodes(el);
        /* 只要有文字节点就行：<button><span>Games</span></button> 这种只有一段文字，
           但文字在按钮里面，必须按文本节点换，不能整块换 */
        if (nodes.length >= 1 && nodes.length <= 8) {
          const marked = markedTextOf(el, nodes);
          if (marked && marked.length <= 4000) {
            parts = nodes;
            out = marked;
          }
        }
      } catch (_) {
        parts = null;
      }
    }

    return { el, text: out, inside: !!inside, parts };
  }

  function collectBlocks(targetLang) {
    /* SPA 把正文容器整个换掉时，旧的锁定目标已经不在页面上了，重新识别一次 */
    if (state.root && !state.root.isConnected) {
      state.root = state.mode === 'full' ? null : pickScope();
    }
    const scope = state.root || document;
    let all = [];
    try {
      all = Array.from(scope.querySelectorAll(BLOCK_SELECTOR));
    } catch (_) {
      all = Array.from(document.querySelectorAll(BLOCK_SELECTOR));
    }
    const picked = [];
    for (const el of all) {
      if (el.querySelector(BLOCK_SELECTOR)) continue; // 只取最内层块
      const b = makeBlock(el, targetLang, false);
      if (b) picked.push(b);
    }

    for (const b of collectTextContainers(scope, targetLang, picked)) picked.push(b);
    return picked;
  }

  /* ------------------ 卡片标题 / 摘要 / 分类这种「纯文本容器」 ------------------ */

  /* 会形成版面结构的标签。容器里有这些就说明它是个「区块」，交给里面的小块去翻 */
  const BLOCKISH = new Set(
    (
      BLOCK_SELECTOR +
      ',div,section,article,header,footer,aside,nav,main,ul,ol,dl,table,form,figure,pre,address,fieldset,details,hr,iframe,video,audio,canvas'
    )
      .split(',')
      .map(s => s.trim().toUpperCase())
  );

  /* 可能是「一段文字」的容器：Nexus 的模组标题是 a、摘要是 div、分类是 div */
  const TEXT_CONTAINER = 'div,span,a,strong,em,b,i,label,small,time,cite,q,abbr,font';

  function collectTextContainers(scope, targetLang, picked) {    const out = [];
    let all = [];
    try {
      all = Array.from(scope.querySelectorAll('*'));
    } catch (_) {
      return out;
    }

    /* 先把「被框架顶回原文」的块作废，让它们能被重新收集、重新翻译。
       不做这一步的话，它们带着 mxt-orig，会被 closest('.mxt-orig') 挡掉，
       永远翻不回来了。 */
    for (const rec of state.recs.slice()) {
      invalidateIfReverted(rec, targetLang);
    }

    /* 先标出「内部还有块级结构」的元素，避免把一个区块当成一段话整个翻掉 */
    const hasBlocks = new Set();
    for (const el of all) {
      if (!BLOCKISH.has(el.tagName)) continue;
      let p = el.parentElement;
      while (p && p !== scope && p !== scope.parentElement) {
        hasBlocks.add(p);
        if (p === scope) break;
        p = p.parentElement;
      }
    }

    const taken = new Set(picked.map(b => b.el));

    for (const el of all) {
      if (!el.matches || !el.matches(TEXT_CONTAINER)) continue;
      if (taken.has(el)) continue; // 外层混合容器已经把它算进同一段了
      if (state.skipped.has(el)) continue; // 块级容器已被跳过
      if (hasBlocks.has(el)) {
        /* div 里夹着 div：整块跳过会漏掉外层自己那点文字
           （「Uploaded by <a>xxx</a>」+ 里面的日期 div），单独挑出块级子元素之外的文字
           但如果是「装块级子元素的容器」（如 tile-body、article 正文等），不让它当混合块翻，
           让里面的子块各自独立翻 */
        if (BLOCKISH.has(el.tagName)) {
          /* 块级容器（如 tile、card）：不把它当混合块翻，也不把它当普通文本块翻。
             把它从 hasBlocks 摘掉，让子元素能正常收集。
             记进 state.skipped（不往 DOM 上加 class，免得几千个元素都挂个标记）。 */
          hasBlocks.delete(el);
          state.skipped.add(el);
        } else {
          /* 真正的混合容器（span 里夹 div 之类）：挑出块外文字 */
          const pb = makePartialBlock(el, targetLang, taken, scope);
          if (pb) {
            out.push(pb);
            taken.add(el);
            hasBlocks.delete(el);
            try {
              for (const d of el.querySelectorAll('*')) {
                if (BLOCKISH.has(d.tagName)) continue;
                if (d.matches && d.matches(TEXT_CONTAINER)) taken.add(d);
              }
            } catch (_) {}
          }
        }
        continue;
      }
      if (el.closest(BLOCK_SELECTOR)) continue; // 已经在第一遍的块里
      if (inTaken(el, taken, scope)) continue; // 祖先是同一段文字，避免拆碎重复翻
      /* 上面标了「跳过」的容器不能再整块翻：
         里面的文字（比如导航 <button><span>Games</span></button>）要各自单独翻，
         整块翻的话译文会插到按钮外面，文字既没换、按钮也没法点。
         注意只拦容器自己，容器里面的元素还是要翻。 */
      if (state.skipped.has(el)) continue;

      /* 父级是 flex/grid 时，插到元素后面会变成「另一个格子」被挤扁，所以插到里面 */
      const b = makeBlock(el, targetLang, flexParent(el));
      if (!b) continue;
      out.push(b);
      taken.add(el);
    }
    return out;
  }

  /* 混合容器：只翻「块级子元素之外」的那部分文字。
     用 {{k}} 标记各文本节点，仅译文模式下只替换这些文字，div / a 结构不动。 */
  function makePartialBlock(el, targetLang, taken, scope) {
    if (el.closest('.mxt-trans')) return null;
    if (el.closest('.mxt-orig')) return null;
    if (alreadyTranslated(el)) return null;
    if (shouldSkip(el)) return null;
    if (inTaken(el, taken, scope)) return null;
    if (!isVisible(el)) return null;
    if (el.closest(BLOCK_SELECTOR)) return null; // 已经在第一遍的块里

    let nodes;
    let text;
    try {
      nodes = inlineTextNodes(el, { stopAtBlocks: true });
      if (!nodes.length || nodes.length > 8) return null;
      text = markedTextOf(el, nodes, { stopAtBlocks: true });
    } catch (_) {
      return null;
    }
    if (!text || text.length < 2 || text.length > 2000) return null;
    if (!/[\p{L}]/u.test(text)) return null;
    if (isSameLanguage(text, targetLang)) return null;
    return { el, text, inside: true, parts: nodes, partial: true };
  }

  function flexParent(el) {
    const p = el.parentElement;
    if (!p) return false;
    try {
      return /flex|grid/.test(getComputedStyle(p).display);
    } catch (_) {
      return false;
    }
  }

  function inTaken(el, taken, scope) {
    let p = el.parentElement;
    while (p && p !== scope.parentElement) {
      if (taken.has(p)) return true;
      if (p === scope) break;
      p = p.parentElement;
    }
    return false;
  }

  const MARK_RE = /<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>|$)/g;

  /* ------------------- 带链接的段落：按文本节点切段 ------------------- */
  const INLINE_MARK = /\{\{\s*(\d+)\s*\}\}/g;

  /* 元素里要参与翻译的文本节点（跳过脚本/样式/代码/输入框/SVG）
     stopAtBlocks: 只取「块级子元素之外」的文字，用于 div 里夹着 div 的混合容器 */
  function inlineTextNodes(el, opts) {
    const stopAtBlocks = !!(opts && opts.stopAtBlocks);
    const out = [];
    const walk = node => {
      for (const c of node.childNodes || []) {
        if (c.nodeType === 3) {
          if (c.nodeValue && /[\p{L}\p{N}]/u.test(c.nodeValue)) out.push(c);
        } else if (c.nodeType === 1) {
          if (c.tagName === 'BR' || shouldSkip(c)) continue;
          if (stopAtBlocks && BLOCKISH.has(c.tagName)) continue;
          walk(c);
        }
      }
    };
    walk(el);
    return out;
  }

  /* 不带标记的纯文本（排除 SVG / 代码 / 脚本），innerText 会把 svg 里的 <text> 算进来 */
  function plainTextOf(el) {
    let out = '';
    const walk = node => {
      for (const c of node.childNodes || []) {
        if (c.nodeType === 3) {
          out += c.nodeValue;
        } else if (c.nodeType === 1) {
          if (c.tagName === 'BR') {
            out += '\n';
            continue;
          }
          if (shouldSkip(c)) continue;
          walk(c);
        }
      }
    };
    walk(el);
    return out.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  /* 一段的文字：普通块用 innerText（会把隐藏文字、<br> 都处理好）；
     里面有 svg 时改用自己的遍历，别把图标的 <text> 当成正文 */
  function blockText(el) {
    let hasSvg = null;
    try {
      hasSvg = typeof el.querySelector === 'function' && el.querySelector('svg,math');
    } catch (_) {
      hasSvg = null;
    }
    if (!hasSvg) return (el.innerText || '').replace(/[ \t]+/g, ' ').trim();
    return plainTextOf(el);
  }

  /* 用 {{1}} {{2}} 标出每个文本节点的位置，模型照着保留，回来就能按位置分配 */
  function markedTextOf(el, nodes, opts) {
    const stopAtBlocks = !!(opts && opts.stopAtBlocks);
    const idx = new Map(nodes.map((n, i) => [n, i + 1]));
    let out = '';
    const walk = node => {
      for (const c of node.childNodes || []) {
        if (c.nodeType === 3) {
          const k = idx.get(c);
          if (k) out += `{{${k}}}${c.nodeValue}`;
          else out += c.nodeValue;
        } else if (c.nodeType === 1) {
          /* 换行要留下来，不然两行字会粘成一行交给模型 */
          if (c.tagName === 'BR') {
            out += '\n';
            continue;
          }
          if (shouldSkip(c)) continue;
          if (stopAtBlocks && BLOCKISH.has(c.tagName)) {
            out += '\n';
            continue;
          }
          walk(c);
        }
      }
    };
    walk(el);
    return out.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  function stripInlineMarks(text) {
    return String(text || '')
      .replace(/\{\{\s*\d+\s*\}\}/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function splitInlineMarks(text, count) {
    const s = String(text || '');
    /* count 为 0 时后面 found[0] 会越界，直接返回空数组 */
    if (count <= 0) return count === 0 ? [] : null;
    const found = [];
    INLINE_MARK.lastIndex = 0;
    let m;
    while ((m = INLINE_MARK.exec(s)) !== null) {
      found.push({ k: Number(m[1]), at: m.index, end: m.index + m[0].length });
    }
    if (found.length !== count) return null; // 模型没保住标记，走兜底
    /* 编号必须在 1..count 之内。模型偶尔会把编号写成 2,3,4（以为从 1 开始数），
       这时 found.length 刚好等于 count，但 k-1 会越界写数组，
       把后面几段的内容挤到错误的位置上。 */
    for (const f of found) {
      if (!Number.isInteger(f.k) || f.k < 1 || f.k > count) return null;
    }
    const out = new Array(count).fill('');
    /* 第一个标记前面的内容（比如模型自己加的前缀）不能丢，
       接到第一段文字前面，不然这段就没被翻译 */
    const head = s.slice(0, found[0].at);
    for (let i = 0; i < found.length; i++) {
      const start = found[i].end;
      const stop = i + 1 < found.length ? found[i + 1].at : s.length;
      let seg = s.slice(start, stop);
      if (i === 0 && head) seg = head + seg;
      out[found[i].k - 1] = seg;
    }
    return out;
  }

  function parseMarkedLocal(text, count) {
    const out = new Array(count).fill(null);
    MARK_RE.lastIndex = 0;
    let m;
    while ((m = MARK_RE.exec(text)) !== null) {
      const i = Number(m[1]) - 1;
      if (i >= 0 && i < count) {
        const v = m[2].trim();
        if (v) out[i] = v;
      }
    }
    return out;
  }

  function stripMarkers(text) {
    return String(text || '')
      .replace(/^\s*<<<\s*\d+\s*>>>\s*/, '')
      .trim();
  }

  /* 模型没保住 {{k}} 标记时的兜底：把每个文本节点单独再翻一遍。
     这样链接文字一定会被替换掉，而不是退回「原文透明」。 */
  async function retranslateParts(rec, token) {
    if (!rec || !rec.parts || !rec.parts.length) return false;
    if (token !== runToken) return false;
    const segs = [];
    for (const node of rec.parts) {
      const src = String(node.nodeValue || '').trim();
      if (!src || !/[\p{L}]/u.test(src)) {
        segs.push('');
        continue;
      }
      /* eslint-disable no-await-in-loop */
      const res = await streamSingle(src, null);
      if (!res || !res.ok || !res.text) {
        segs.push('');
        continue;
      }
      segs.push(String(res.text).trim());
    }
    if (token !== runToken) return false;
    rec.segs = segs;
    return segs.some(s => s);
  }

  function insertTranslation(el, text, token, inside, parts, opts) {
    if (token !== undefined && token !== runToken) return; // 已经还原/重来了，迟到的译文丢掉
    const partial = !!(opts && opts.partial);
    const plain = parts ? stripInlineMarks(text) : text;
    /* 换字目标必须在插入译文节点之前算好：
       swapTargetOf() 靠 children.length 判断「这个块是不是只有一个 <a>」，
       要是译文 div 已经插进去了，<li><a>News</a></li> 就认不出 <a>，
       文字会停在一个不能点的独立 div 里。 */
    const target = swapTargetOf(el);
    /* 记下「翻译前的原文」：框架（React 等）更新内容时会把文字顶回原文，
       拿这个对比就能发现「被顶回去了」，好把它作废、重新翻译。 */
    const origText = ownText(target);
    const div = document.createElement('div');
    div.className = 'mxt-trans';
    div.setAttribute('data-mxt', '1');
    div.textContent = plain;
    const putInside = inside || APPEND_INSIDE.has(el.tagName) || partial;
    if (putInside) {
      el.appendChild(div);
    } else if (el.parentElement) {
      el.insertAdjacentElement('afterend', div);
      /* 原地换字换不了时的兜底：整段隐藏，免得空出和原文一样高的一片白。
         带图片/视频的容器不能隐藏，不然图也没了，那种继续用「文字透明」。
         带链接的段落也不能藏（藏了链接就点不了），留给透明兜底。 */
      let media = null;
      try {
        media = typeof el.querySelector === 'function' && el.querySelector(MEDIA_SELECTOR);
      } catch (_) {
        media = null;
      }
      const hasParts = !!(parts && parts.length);
      if (!media && !hasParts && typeof el.setAttribute === 'function') el.setAttribute('data-mxt-out', '1');
    } else {
      return;
    }
    /* 混合容器（div 里夹着 div）只标注一部分文字，不能打 mxt-orig，
       否则里面的子块以后再也翻不了 */
    /* 「跳过」的容器（导航那种，里面是 button/a）也不能打 mxt-orig：
       否则里面的文字元素会被 closest('.mxt-orig') 拦掉，一个都翻不了。
       这种容器本来就没被翻译，只是拿它当「这块别整块翻」的标记。 */
    if (!partial && !state.skipped.has(el) && el.classList) el.classList.add('mxt-orig');
    state.sources.push(el);
    state.nodes.push(div);

    const rec = {
      el,
      node: div,
      text: plain,
      inside: putInside,
      partial,
      target,
      origText,
      parts: parts && parts.length ? parts : null,
      segs: parts && parts.length ? splitInlineMarks(text, parts.length) : null,
      saved: null,
      savedTexts: null,
      injected: null,
      swapped: false
    };
    state.recs.push(rec);
    if (state.displayMode === 'translation') swapIn(rec);

    /* 模型没保住 {{k}} 标记：把每个文本节点单独再翻一遍，
       保证链接文字一定被替换，而不是停在原文上 */
    if (rec.parts && !rec.segs) {
      const myToken = token === undefined ? runToken : token;
      retranslateParts(rec, myToken).then(ok => {
        if (!ok) return;
        /* 按文本节点替换。
           注意：这里不能只在「还没记过原文」时才写 ——
           「仅译文」模式下 swapIn() 早就把 savedTexts 记好了，
           如果这里跳过，页面上的文字就还是原文，
           而真正装着译文的 .mxt-trans 节点又被藏起来 —— 用户什么都看不到。
           所以：原文该记就记（只在没记过时），文字**一定要写**。 */
        if (!rec.savedTexts) {
          rec.savedTexts = rec.parts.map(n => n.nodeValue);
        }
        rec.parts.forEach((n, i) => {
          const v = rec.segs[i];
          if (typeof v === 'string' && v) n.nodeValue = v;
        });
        if (rec.node && rec.node.classList) rec.node.classList.add('mxt-hidden');
        if (rec.el && rec.el.classList) rec.el.classList.add('mxt-swapped');
        rec.swapped = true;
      });
    }
  }

  /* ------------------- 「仅译文」：原地换字 ------------------- */

  /* 译文块里出现这些标签就不能整块换字，否则图片、嵌套列表、按钮会一起被吃掉 */
  const NO_SWAP_IN =
    /^(IMG|PICTURE|VIDEO|CANVAS|SVG|IFRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT|BUTTON|PRE|DIV|P|UL|OL|TABLE|SECTION|ARTICLE|NAV|HEADER|FOOTER|FORM|FIGURE|BLOCKQUOTE|H1|H2|H3|H4|H5|H6)$/;

  /* 去掉我们自己插的译文节点之后，元素还剩多少字 */
  function ownText(el) {
    let s = '';
    for (const c of el.childNodes || []) {
      if (c.nodeType === 3) {
        s += c.nodeValue;
      } else if (c.nodeType === 1) {
        if (c.classList && c.classList.contains('mxt-trans')) continue;
        s += c.textContent || '';
      }
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function swapTargetOf(el) {
    /* <h2><a>标题</a></h2>、<li><a>News</a></li> 这种只换 <a> 里的字：
       标题的字号字重、链接本身都还在，文字也还在链接里面（照样能点）。
       比较文字时要排除我们自己的译文节点，不然插进去之后就对不上了。 */
    const kids = el.children ? Array.from(el.children).filter(c => {
      /* 我们自己插的译文节点不算 */
      if (c.classList && c.classList.contains('mxt-trans')) return false;
      return true;
    }) : [];
    if (kids.length === 1) {
      const only = kids[0];
      const all = ownText(el);
      const inner = ownText(only);
      if (inner && inner === all && !NO_SWAP_IN.test(String(only.tagName || '').toUpperCase())) return only;
    }
    return el;
  }

  function canSwap(target) {
    const kids = target.children || [];
    for (const k of kids) {
      /* 我们自己插的译文节点不算：它一会儿就会被收进 fragment，
         不该因为「里面有个 div」就放弃换字 */
      if (k.classList && k.classList.contains('mxt-trans')) continue;
      /* SVG 元素的 tagName 是小写 'svg'，必须转成大写再比，否则图标会被整块换掉 */
      if (NO_SWAP_IN.test(String(k.tagName || '').toUpperCase())) return false;
    }
    return true;
  }

  /* 把原文的子节点挪进 fragment（不克隆，事件监听和状态都还在），换成译文文字。
     元素本身、class、行内样式都不动，所以布局和样式跟原文一模一样。 */
  function swapIn(rec) {
    if (!rec || rec.swapped) return;
    const el = rec.el;
    if (!el || el.isConnected === false) return;

    /* 带链接的段落：只换每个文本节点的文字，<a>、<b> 这些结构一个都不动 */
    if (rec.segs && rec.parts) {
      /* 这里不需要再检查「目标有几个含文字的子元素」：
         按文本节点换字根本不动结构，<a>、<b> 全都原地保留，
         哪怕这个块里有好几个链接也一样安全。 */
      rec.savedTexts = rec.parts.map(n => n.nodeValue);
      rec.parts.forEach((n, i) => {
        const v = rec.segs[i];
        if (typeof v === 'string' && v) n.nodeValue = v;
      });
      rec.swapped = true;
      if (el.classList) el.classList.add('mxt-swapped');
      if (rec.node && rec.node.classList) rec.node.classList.add('mxt-hidden');
      return;
    }

    /* 有链接但模型没保住 {{k}} 标记：先不动原文（保持可读、链接可点），
       等 insertTranslation 里的逐段重译回来再替换。
       绝不能整段换字把 <a> 吃掉——链接点不了比多一行空白难受得多。
       这里先记下原文并打上 mxt-swapped，避免原文被「仅译文」的透明样式弄没。 */
    if (rec.parts) {
      /* 记下原文（还原时要用）。只记一次 —— 反复进入这个分支会把
         已经换上的译文当成「原文」记下来，还原之后就回不去了。 */
      if (!rec.savedTexts) rec.savedTexts = rec.parts.map(n => n.nodeValue);
      if (el.classList) el.classList.add('mxt-swapped');
      rec.swapped = true;
      return;
    }

    const target = rec.target;
    if (!target || !canSwap(target)) return;

    /* 如果目标元素有多个直接子元素各自含文字（比如 tile-body 里有 title + author + summary），
       整体换字会把它们全吞掉，子块再也翻不了。此时只藏译文节点，让孩子块各自独立翻译。
       注意排除我们已经插入的 .mxt-trans 译文节点，避免它们干扰判断。 */
    const multiTextKids = Array.from(target.children || []).filter(c => {
      if (c.classList && c.classList.contains('mxt-trans')) return false;
      const t = (c.textContent || '').trim();
      return t.length >= 2 && /[\p{L}]/u.test(t);
    });
    if (multiTextKids.length > 1) {
      /* 多子块容器：不动文字，让子块各自独立翻译。
         不加 mxt-orig，否则子块会被 closest('.mxt-orig') 拦掉。 */
      if (rec.node && rec.node.classList) rec.node.classList.add('mxt-hidden');
      rec.swapped = true;
      return;
    }

    let frag;
    try {
      frag = document.createDocumentFragment();
    } catch (_) {
      return;
    }

    const kids = target.childNodes ? Array.from(target.childNodes) : [];
    for (const kid of kids) {
      if (kid === rec.node) continue; // 译文节点留在原地，只是藏起来
      frag.appendChild(kid);
    }
    rec.saved = frag;

    let textNode = null;
    try {
      textNode = document.createTextNode(rec.text);
    } catch (_) {
      textNode = null;
    }
    if (textNode) {
      rec.injected = textNode;
      target.appendChild(textNode);
    }

    rec.swapped = true;
    if (el.classList) el.classList.add('mxt-swapped');
    if (rec.node && rec.node.classList) rec.node.classList.add('mxt-hidden');
  }

  function unswap(rec) {
    if (!rec || !rec.swapped) return;
    const target = rec.target;
    if (rec.savedTexts && rec.parts) {
      /* 按文本节点换的字：一个个还回去 */
      rec.parts.forEach((n, i) => {
        const v = rec.savedTexts[i];
        if (typeof v === 'string') n.nodeValue = v;
      });
      rec.savedTexts = null;
    } else if (target) {
      if (rec.injected && rec.injected.parentNode === target) target.removeChild(rec.injected);
      if (rec.saved) {
        target.appendChild(rec.saved);
        rec.saved = null;
      }
      /* 插在元素内部的译文节点，恢复后要挪回最后（原文在前、译文在后） */
      if (rec.inside && rec.node && rec.node.parentElement === target) target.appendChild(rec.node);
      rec.injected = null;
    }
    rec.swapped = false;
    if (rec.el && rec.el.classList) rec.el.classList.remove('mxt-swapped');
    if (rec.node && rec.node.classList) rec.node.classList.remove('mxt-hidden');
  }

  function clearPage() {
    runToken++; // 作废在途的翻译，免得还原后又被插回来
    state.busy = false; // 旧批次不会再回调有效结果，别让「正在翻译」卡住
    for (const rec of state.recs) unswap(rec);
    for (const n of state.nodes) n.remove();
    for (const el of state.sources) {
      if (el.classList) el.classList.remove('mxt-orig');
      if (typeof el.removeAttribute === 'function') el.removeAttribute('data-mxt-out');
    }
    /* 「跳过」标记是这一轮收集时打的，页面还原后要清掉，
       不然下一轮会把这些容器当成「已经处理过」，行为就不对了 */
    state.skipped.clear();
    state.nodes = [];
    state.sources = [];
    state.recs = [];
    if (document.body) {
      document.body.classList.remove('mxt-hide-trans');
      document.body.classList.remove('mxt-only-trans');
    }
    hideToast();
    setFab();
  }

  /* ------------------------- 双语 / 仅译文 ------------------------- */

  async function saveDisplayMode(mode) {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), displayMode: mode } });
    } catch (_) {
      /* 存不上就算了，本次会话仍然生效 */
    }
  }

  function applyDisplay(mode, { quiet = false } = {}) {
    state.displayMode = mode === 'translation' ? 'translation' : 'bilingual';

    /* 一个字都还没翻的时候千万别加这个类，否则整页原文全变透明 */
    const active = state.displayMode === 'translation' && state.sources.length > 0;
    if (document.body) document.body.classList.toggle('mxt-only-trans', active);

    /* 仅译文：能原地换字的就原地换（布局、字号、颜色全部保持站点的样子） */
    if (active) {
      for (const rec of state.recs) swapIn(rec);
    } else {
      for (const rec of state.recs) unswap(rec);
    }

    if (quiet) return;
    if (state.displayMode === 'translation') {
      showToast(active ? '只看译文（Alt+Y 切回双语）' : '已设为「仅译文」，下次翻译生效', 1800);
    } else {
      showToast('双语对照（Alt+Y 切到仅译文）', 1800);
    }
  }

  async function toggleDisplay() {
    const next = state.displayMode === 'translation' ? 'bilingual' : 'translation';
    applyDisplay(next);
    await saveDisplayMode(next);
  }

  /* 页面还在加载就动手，会漏掉后面才出来的正文，也容易插到一半被重绘冲掉。
     等 load（最多 6 秒），再给 300ms 让页面自己稳一下。 */
  function pageSettled(maxWait = 6000) {
    if (document.readyState === 'complete') {
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(document.readyState === 'complete');
      };
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'complete') finish();
      });
      window.addEventListener('load', finish, { once: true });
      setTimeout(finish, maxWait);
    });
  }

  /* 把一批段落按 CHUNK_SIZE 并发跑完，progress 用来更新提示 */
  async function runChunks(blocks, progress, token = runToken) {
    const chunks = [];
    for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
      chunks.push(blocks.slice(i, i + CHUNK_SIZE));
    }

    const stat = { total: blocks.length, done: 0, failed: 0, lastError: '' };
    let cursor = 0;

    state.busy = true;
    setFab();
    try {
      const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          const res = await streamBatch(chunk, () => progress && progress(stat), token);
          if (!res.ok) {
            stat.failed += chunk.length;
            stat.lastError = res.error || stat.lastError;
          }
          stat.done += chunk.length;
          if (progress) progress(stat);
        }
      });
      await Promise.all(workers);
    } finally {
      if (token === runToken) {
        state.busy = false;
        applyDisplay(state.displayMode, { quiet: true }); // 有了译文才能进「仅译文」
      }
      setFab();
    }

    return stat;
  }

  /* 离视口多远：0 = 正在看，越小越优先。先翻看得见的，剩下的继续补 */
  function viewportDistance(el) {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (rect.bottom < 0) return -rect.bottom; // 已经在上面滚过去了
    if (rect.top > vh) return rect.top - vh; // 还在下面
    return 0;
  }

  function byViewportFirst(blocks) {
    return blocks
      .map((b, i) => ({ b, i, d: viewportDistance(b.el) }))
      .sort((x, y) => x.d - y.d || x.i - y.i)
      .map(x => x.b);
  }

  /* ------------------ 动态内容（SPA / 无限滚动 / 懒加载） ------------------ */

  const AUTO_DELAY = 700; // DOM 安静这么久才动手，滚动时不会翻一半
  const AUTO_BACKLOG = 80; // 还有一大堆没翻完时别干等，紧接着排下一轮
  const AUTO_MAX_PER_CYCLE = 40; // 一轮上限，别一次把整页塞给模型

  let observer = null;
  let autoTimer = null;
  let observedBody = null;

  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    if (el.id === 'mxt-host') return true;
    if (typeof el.getAttribute === 'function' && el.getAttribute('data-mxt') === '1') return true;
    return !!(el.closest && el.closest('#mxt-host'));
  }

  /* 展开一个隐藏的菜单，会改 class / style，而不是插入新节点。
     之前的 observer 只听 addedNodes，所以「展开下拉菜单」这个动作不触发补翻，
     结果就是：收起状态下翻过的页面，展开菜单后里面全是英文。
     这里同时监听属性变化，展开/收起菜单都能触发一轮补翻。 */
  function startObserver() {
    if (observer || !document.body || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) {
            if (!isOwnNode(n)) {
              scheduleAuto(); // 只认新内容，自己的译文节点不算
              return;
            }
          }
        } else if (r.type === 'attributes') {
          /* 只认「可能改变可见性」的属性。
             关键：要排除我们自己改过的元素——翻译时会给元素加 mxt-swapped /
             mxt-orig class，如果这些也触发补翻，就会自激成死循环
             （翻译 → 改 class → 触发补翻 → 翻译 → …），页面卡在「翻译中」。
             所以只认「不是我们自己动过」的属性变化。 */
          const target = r.target;
          if (
            target &&
            target.classList &&
            (target.classList.contains('mxt-swapped') ||
              target.classList.contains('mxt-orig') ||
              target.classList.contains('mxt-trans'))
          ) {
            continue;
          }
          const name = r.attributeName || '';
          if (name === 'class' || name === 'style' || name === 'hidden' || name === 'open') {
            scheduleAuto();
            return;
          }
        }
      }
    });
    observedBody = document.body;
    observer.observe(observedBody, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open']
    });
    state.observing = true;
  }

  function stopAuto() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    observedBody = null;
    state.observing = false;
    stopAuto();
  }

  function scheduleAuto(delay = AUTO_DELAY) {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      translateNewBlocks();
    }, delay);
  }

  /* 一轮：翻看得见的一批，剩下的排下一轮（滚动、动态加载都会触发） */
  async function translateNewBlocks() {
    if (!state.observing) return;
    if (state.busy) {
      scheduleAuto(); // 上一轮还没跑完，等它
      return;
    }

    const pending = byViewportFirst(collectBlocks(state.targetLang));
    if (!pending.length) return;

    const batch = pending.slice(0, AUTO_MAX_PER_CYCLE);
    const before = state.nodes.length;
    const noisy = batch.length >= 4;
    const token = runToken;

    const stat = await runChunks(
      batch,
      s => {
        if (noisy) showToast(`翻译中 ${Math.min(s.done, s.total)}/${s.total}`, 0);
      },
      token
    );

    if (token !== runToken) return; // 中途被还原了

    const added = state.nodes.length - before;
    if (added) showToast(`又译了 ${added} 段`, 1400);
    else if (stat.failed) showToast(`翻译失败：\n${stat.lastError}`, 4000);
    else hideToast();

    if (pending.length > batch.length) scheduleAuto(AUTO_BACKLOG); // 还有没翻完的，接着来
  }

  async function togglePage(mode = 'smart') {
    const nextMode = mode === 'full' ? 'full' : 'smart';

    /* 还原永远优先：即使后台还在补翻，也要能立刻停下 */
    if (state.nodes.length) {
      const sameMode = state.mode === nextMode;
      stopObserver();
      stopAuto();
      clearPage();
      if (sameMode) {
        showToast('已还原原文', 1500);
        return;
      }
      showToast('换个范围重翻…', 900);
      await new Promise(r => setTimeout(r, 150));
    } else if (state.busy) {
      showToast('正在翻译中，稍等一下');
      return;
    }

    if (document.readyState !== 'complete') {
      showToast('页面还在加载，等它加载完再翻…', 0);
      const settled = await pageSettled();
      hideToast();
      await new Promise(r => setTimeout(r, 300));
      if (!settled) showToast('页面加载有点慢，先翻已经出来的部分', 2500);
    }

    const settingsRes = await chrome.runtime.sendMessage({ type: 'mxt:getSettings' }).catch(() => null);
    if (!settingsRes || !settingsRes.ok) {
      showToast('读不到设置，重新加载扩展试试');
      return;
    }
    const settings = settingsRes.settings || {};
    const targetLang = settings.targetLang || '简体中文';
    const autoDynamic = settings.autoDynamic !== false; // 默认开
    fabWanted = settings.showFab !== false; // 默认显示
    state.targetLang = targetLang;
    setFab();

    /* smart = 只翻识别出的正文区域；full = 整页（含导航/侧边栏/页脚） */
    const full = mode === 'full';
    state.mode = full ? 'full' : 'smart';
    state.root = full ? null : pickScope();

    const all = byViewportFirst(collectBlocks(targetLang));
    if (!all.length) {
      showToast(
        full
          ? '这一页没找到需要翻译的正文'
          : '正文区域里没有可翻的内容，按 Alt+W 试试翻整页',
        3000
      );
      return;
    }

    /* 先翻看得见的那一批，其余交给后面的轮次接着补 */
    const first = all.slice(0, AUTO_MAX_PER_CYCLE);
    const rest = all.length - first.length;
    const token = runToken;

    showToast(`翻译中 0/${first.length}${rest ? `（共 ${all.length} 段）` : ''}`, 0);
    const stat = await runChunks(
      first,
      s =>
        showToast(
          `翻译中 ${Math.min(s.done, s.total)}/${s.total}，已出 ${state.nodes.length} 段`,
          0
        ),
      token
    );

    if (token !== runToken) return; // 用户已经还原了

    if (!state.nodes.length) {
      showToast(stat.failed ? `翻译失败：\n${stat.lastError}` : '没有可插入的译文', 6000);
      return;
    }

    /* 之后：动态加载的新内容 + 还没翻的部分，都由后台轮次接手 */
    if (autoDynamic) {
      startObserver();
      if (rest) scheduleAuto(AUTO_BACKLOG);
    }

    const scopeNote = state.root ? '\n（只翻了正文，整页翻按 Alt+W）' : '';

    if (stat.failed) {
      showToast(`翻译完成，${stat.failed} 段失败\n${stat.lastError}`, 6000);
    } else if (!autoDynamic) {
      showToast(`翻译完成，共 ${state.nodes.length} 段${scopeNote}`, 2600);
    } else if (rest) {
      showToast(`先译了 ${state.nodes.length} 段，其余继续${scopeNote}`, 3200);
    } else {
      showToast(`翻译完成，共 ${state.nodes.length} 段\n新加载的内容会自动接着翻${scopeNote}`, 3600);
    }
  }

  /* ------------------------- 消息入口 ------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'mxt:ping') {
      sendResponse({
        ok: true,
        ready: true,
        translated: state.nodes.length,
        busy: state.busy,
        observing: state.observing,
        mode: state.mode,
        displayMode: state.displayMode,
        fab: fabWanted
      });
      return;
    }

    if (msg.type === 'mxt:togglePage') {
      togglePage(msg.mode === 'full' ? 'full' : 'smart');
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'mxt:toggleDisplay') {
      toggleDisplay();
      sendResponse({ ok: true, displayMode: state.displayMode });
      return;
    }

    if (msg.type === 'mxt:translateSelection') {
      const text = String(msg.text || '').trim() || (getSelectionInfo()?.text ?? '');
      if (text) openCard(text, null);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'mxt:status') {
      sendResponse({
        ok: true,
        translated: state.nodes.length,
        busy: state.busy,
        observing: state.observing,
        mode: state.mode,
        displayMode: state.displayMode,
        fab: fabWanted
      });
      return;
    }
  });

  /* 首次进页面就按用户设置决定要不要显示右侧图标 */
  try {
    chrome.storage.local
      .get('settings')
      .then(({ settings }) => {
        if (settings) {
          if (settings.showFab !== undefined) fabWanted = settings.showFab !== false;
          if (settings.displayMode) state.displayMode = settings.displayMode;
        }
        setFab();
        maybeAutoTranslate(settings);
      })
      .catch(() => setFab());
  } catch (_) {
    setFab(); // storage 不可用（极少见），至少让图标出来
  }

  /* 「自动翻译非目标语言页面」：页面加载完，判断语言，不是目标语言就自动翻 */
  let autoTranslateTried = false;

  async function maybeAutoTranslate(settings) {
    const s = settings || {};
    if (!s.autoTranslate) return; // 开关没开
    if (autoTranslateTried) return; // 每个页面只试一次
    if (state.nodes.length || state.busy) return; // 已经翻过了
    /* 等页面先加载完，不然正文还没出来，判断不出语言 */
    if (document.readyState !== 'complete') {
      await new Promise(r => {
        const done = () => r();
        window.addEventListener('load', done, { once: true });
        setTimeout(done, 8000);
      });
      await new Promise(r => setTimeout(r, 400));
    }

    autoTranslateTried = true;

    /* 没配接口就别自动翻了，免得直接报错 */
    const res = await chrome.runtime.sendMessage({ type: 'mxt:configStatus' }).catch(() => null);
    if (!res || !res.configured) return;

    const target = s.targetLang || '简体中文';
    const minChars = Number(s.autoTranslateMinChars) > 0 ? Number(s.autoTranslateMinChars) : 200;
    const text = samplePageText();

    /* 文字太少的多半是登录页、报错页、纯工具页，不自动翻 */
    if (text.length < minChars) return;

    if (pageIsTargetLanguage(text, target)) return; // 已经是目标语言了

    try {
      await togglePage('full');
    } catch (_) {
      /* 失败就算了，不打扰用户 */
    }
  }

  /* 设置页一改就跟着变，不用刷新页面 */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes.settings) return;
      const s = changes.settings.newValue || {};
      if (s.showFab !== undefined) fabWanted = s.showFab !== false;
      if (s.displayMode) {
        state.displayMode = s.displayMode;
        applyDisplay(state.displayMode, { quiet: true });
      }
      setFab();
    });
  } catch (_) {
    /* 老浏览器/测试环境没有 onChanged */
  }

  /* 页面重绘后把 host 找回来（有些站点会清空 documentElement） */
  let lastURL = location.href;

  function housekeeping() {
    if (!host.isConnected) mount();
    setFab();

    // 框架换了 body，观察者会跟着失效，重新挂上
    if (state.observing && observedBody !== document.body) {
      stopObserver();
      startObserver();
    }

    // SPA 换页：把已经不存在的译文从账上划掉，新内容交给轮次继续翻
    if (state.nodes.length) {
      const alive = state.nodes.filter(n => n.isConnected);
      if (alive.length !== state.nodes.length) state.nodes = alive;
    }
    if (state.sources.length) {
      const alive = state.sources.filter(el => el.isConnected);
      if (alive.length !== state.sources.length) state.sources = alive;
    }

    // body 被换掉会丢掉「仅译文」的类，补回来
    if (document.body && state.displayMode === 'translation' && state.sources.length) {
      if (!document.body.classList.contains('mxt-only-trans')) {
        document.body.classList.add('mxt-only-trans');
      }
    }

    const url = location.href;
    if (url !== lastURL) {
      lastURL = url;
      if (!state.nodes.length) runToken++; // 旧页面没了，作废在途结果
      if (state.observing) scheduleAuto();
    }
  }

  let housekeepingTimer = setInterval(housekeeping, 3000);
  /* 别用 unload：越来越多站点（或 Chrome 的默认策略）禁掉 unload，
     注册监听会被记成「Permissions policy violation」并出现在扩展错误列表里。
     pagehide 同样在离开页面时触发，进 bfcache 再回来还能用 pageshow 接上。 */
  window.addEventListener('pagehide', () => {
    if (housekeepingTimer) {
      clearInterval(housekeepingTimer);
      housekeepingTimer = null;
    }
  });
  window.addEventListener('pageshow', () => {
    if (!housekeepingTimer) housekeepingTimer = setInterval(housekeeping, 3000);
  });
})();
