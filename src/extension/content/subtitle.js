'use strict';

/* ------------------------------------------------------------------ *
 * 译点 · 视频字幕翻译
 * 找出页面上的 <video>，把它的字幕抓下来、翻译成双语，再挂回播放器。
 *
 * 支持的字幕来源：
 *   1. <track> 标签（同源或跨域的 .vtt / .srt）
 *   2. 页面上已经加载好的字幕（<track> 的 TextTrack 轨道）
 *   3. 常见的字幕 API（YouTube / Bilibili 等，见 fetchCaptions）
 *
 * 界面：播放器下方浮一块字幕列表，点一条就跳到那个时间点。
 * ------------------------------------------------------------------ */

(() => {
  if (window.__MXT_SUB_ACTIVE__) return;
  window.__MXT_SUB_ACTIVE__ = true;

  const HOST_ID = 'mxt-sub-host';

  /* ------------------------- 字幕解析 ------------------------- */

  /* 从一行时间轴里取出起止时间。
     WebVTT 的时间行后面会跟一串 cue 设置：
       "00:00:03.000 --> 00:00:04.000 align:start position:0%"
     这些设置只影响排版，不影响时间，所以要**先切掉**再解析时间 ——
     否则锚定过的正则会把整行判为非法，整条 cue 被丢掉。
     （切掉设置之后正则仍然要锚定，否则 "abc 01:02.500" 又会被误解析。） */
  function parseCueTiming(line) {
    const t = String(line || '');
    const i = t.indexOf('-->');
    if (i < 0) return null;
    const start = parseTime(t.slice(0, i));
    const endPart = t.slice(i + 3).trim().split(/\s+/)[0] || '';
    const end = parseTime(endPart);
    if (start == null || end == null) return null;
    return { start, end };
  }

  /* WebVTT -> [{ start, end, text }] */
  function parseVtt(raw) {
    const cues = [];
    const blocks = String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^WEBVTT[^\n]*\n/, '')
      .split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n').filter(Boolean);
      if (!lines.length) continue;
      let i = 0;
      /* 跳过序号行 */
      if (!lines[i].includes('-->')) i++;
      const tl = lines[i] || '';
      if (!tl.includes('-->')) continue;
      const timing = parseCueTiming(tl);
      if (!timing) continue;
      const { start, end } = timing;
      const text = lines
        .slice(i + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (text) cues.push({ start, end, text });
    }
    return cues;
  }

  /* SRT -> [{ start, end, text }] */
  function parseSrt(raw) {
    const cues = [];
    const blocks = String(raw || '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n').filter(Boolean);
      if (!lines.length) continue;
      let i = 0;
      if (!lines[i].includes('-->')) i++;
      const tl = lines[i] || '';
      if (!tl.includes('-->')) continue;
      const timing = parseCueTiming(tl);
      if (!timing) continue;
      const { start, end } = timing;
      const text = lines
        .slice(i + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (text) cues.push({ start, end, text });
    }
    return cues;
  }

  function parseTime(s) {
    /* 正则必须锚定：字幕里常有 "align:start" 这类尾巴，
       不锚定的话 "abc 01:02.500" 也会被解析成 62.5，静默产生错误时间点。 */
    const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if (!m) return null;
    const h = Number(m[1] || 0);
    const min = Number(m[2] || 0);
    const sec = Number(m[3] || 0);
    if (min > 59 || sec > 59) return null;
    const ms = Number(String(m[4] || '0').padEnd(3, '0'));
    return h * 3600 + min * 60 + sec + ms / 1000;
  }

  function fmtTime(t) {
    const s = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function fmtSrtTime(t) {
    const s = Math.max(0, t || 0);
    /* 毫秒必须落在 000–999。先把毫秒单独算出来，再判断是否要进位到秒，
       否则 Math.round 会算出 1000，输出 "00:00:01,1000" 这种非法时间戳。 */
    let totalSec = Math.floor(s);
    let ms = Math.round((s - totalSec) * 1000);
    if (ms >= 1000) {
      ms -= 1000;
      totalSec += 1;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
  }

  /* 秒 → "00:00:01.200"（WebVTT 的时间格式，带毫秒） */
  function fmtVttTime(t) {
    const s = Math.max(0, t || 0);
    let totalSec = Math.floor(s);
    let ms = Math.round((s - totalSec) * 1000);
    /* 舍入到 1000 毫秒时要进位 */
    if (ms >= 1000) {
      ms -= 1000;
      totalSec += 1;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(sec)}.${p(ms, 3)}`;
  }

  function toVtt(cues, getText) {
    const out = ['WEBVTT', ''];
    cues.forEach((c, i) => {
      out.push(String(i + 1));
      /* 用带毫秒的格式：秒级精度会把 1.2s–1.8s 压成 "00:01 --> 00:01"，
         零长度的 cue 播放器显示不出来，相邻的短字幕还会叠在一起。 */
      out.push(`${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}`);
      out.push(getText(c));
      out.push('');
    });
    return out.join('\n');
  }

  /* ------------------------- 抓字幕 ------------------------- */

  function tracksOf(video) {
    const out = [];
    try {
      for (const t of video.textTracks || []) {
        if (t.kind === 'captions' || t.kind === 'subtitles') {
          out.push({ kind: 'track', cues: cuesOfTrack(t), label: t.label || t.language || '', lang: t.language || '' });
        }
      }
    } catch (_) {
      /* 某些浏览器不让读 textTracks */
    }
    try {
      for (const el of video.querySelectorAll('track')) {
        if (!el.src) continue;
        out.push({ kind: 'src', url: el.src, label: el.label || '', lang: el.srclang || '', el });
      }
    } catch (_) {
      /* 忽略 */
    }
    return out;
  }

  function cuesOfTrack(track) {
    const cues = [];
    try {
      const list = track.cues;
      if (!list) return cues;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c && c.text) cues.push({ start: c.startTime, end: c.endTime, text: c.text });
      }
    } catch (_) {
      /* 忽略 */
    }
    return cues;
  }

  async function fetchText(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return '';
      return await res.text();
    } catch (_) {
      return '';
    }
  }

  function parseByExt(url, raw) {
    const u = String(url || '').toLowerCase();
    if (u.includes('.srt')) return parseSrt(raw);
    return parseVtt(raw);
  }

  /* ------------------------- 抓音频（没字幕时） ------------------------- */

  /* 从 <video> 抽音频。
     用 MediaElementAudioSourceNode + AudioContext：把声音同时接到扬声器（用户照常能听）
     和一个 ScriptProcessor/Analyser 上，攒够数据就编码成 WAV 送去识别。 */
  const audioState = { ctx: null, source: null, proc: null, chunks: [], capturing: false, sampleRate: 44100 };

  async function captureAudio(video, { seconds = 120 } = {}) {
    if (audioState.capturing) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('这个浏览器不支持抓音频');

    const ctx = new Ctx();
    await ctx.resume?.();
    const src = ctx.createMediaElementSource(video);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];

    proc.onaudioprocess = e => {
      if (!audioState.capturing) return;
      const input = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
    };

    /* 声音照常放出来（不然用户听不到声音了） */
    src.connect(gain);
    gain.connect(ctx.destination);
    src.connect(proc);
    proc.connect(ctx.destination);

    audioState.ctx = ctx;
    audioState.source = src;
    audioState.proc = proc;
    audioState.chunks = chunks;
    audioState.capturing = true;
    audioState.sampleRate = ctx.sampleRate;

    /* 视频在播才录得到声音 */
    try {
      video.muted = false;
      await video.play();
    } catch (_) {
      /* 自动播放被拦了：让用户点一下播放 */
    }

    await new Promise(r => setTimeout(r, seconds * 1000));
    return stopAudio(ctx);
  }

  function stopAudio(ctx) {
    audioState.capturing = false;
    const chunks = audioState.chunks || [];
    const rate = audioState.sampleRate || 44100;
    try {
      audioState.proc?.disconnect();
      audioState.source?.disconnect();
      ctx?.close?.();
    } catch (_) {
      /* 忽略 */
    }
    audioState.ctx = null;
    audioState.source = null;
    audioState.proc = null;
    audioState.chunks = [];
    if (!chunks.length) return null;
    return { data: encodeWav(chunks, rate), mediaType: 'audio/wav' };
  }

  /* Float32 采样 -> WAV（16bit PCM，单声道） */
  function encodeWav(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buffer = new ArrayBuffer(44 + total * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + total * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, total * 2, true);
    let off = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        let s = Math.max(-1, Math.min(1, c[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    /* 转成 base64（分块避免爆栈） */
    const bytes = new Uint8Array(buffer);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  async function transcribe(audio) {
    const res = await chrome.runtime.sendMessage({
      type: 'mxt:transcribe',
      audio: audio.data,
      mediaType: audio.mediaType
    });
    if (!res || !res.ok) throw new Error(res?.error || '语音识别失败');
    return res.cues || [];
  }

  /* ------------------------- 翻译 ------------------------- */

  async function translateCues(cues, targetLang) {
    if (!cues.length) return [];
    /* 一次最多 60 条，太多就分批 */
    const CHUNK = 60;
    const out = [];
    let failed = 0;
    for (let i = 0; i < cues.length; i += CHUNK) {
      const part = cues.slice(i, i + CHUNK);
      const texts = part.map(c => c.text);
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'mxt:translate', texts });
      } catch (_) {
        res = null;
      }
      const list = res && res.ok && Array.isArray(res.translations) ? res.translations : [];
      part.forEach((c, j) => {
        const zh = String(list[j] || '').trim();
        if (zh) {
          out.push({ ...c, zh });
        } else {
          /* 没翻出来就留空，不要拿原文冒充译文 ——
             那样用户看到「双语字幕」里两行一样的内容，以为没翻成功又不知道差在哪。 */
          failed++;
          out.push({ ...c, zh: '', failed: true });
        }
      });
      /* 让出一帧，别把页面卡住 */
      await new Promise(r => setTimeout(r, 0));
    }
    /* 告诉调用方有几条没翻成，界面上要说明 */
    if (failed) out.failedCount = failed;
    return out;
  }

  /* ------------------------- 界面 ------------------------- */

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    const style = document.createElement('style');
    /* 注意：影子树里要用 :host 才有作用（#id 选择器匹配不到影子树外的宿主） */
    style.textContent = `
      :host {
        all: initial;
        position: fixed; z-index: 2147483600;
        right: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px);
        max-height: 46vh; display: none; flex-direction: column;
        background: rgba(17, 17, 20, 0.94); color: #eee;
        border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      }
      :host(.mxt-sub-open) { display: flex; }
      .mxt-sub-head {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.12);
        font-weight: 600; flex: none;
      }
      .mxt-sub-title { flex: 1; }
      button {
        background: rgba(255,255,255,0.10); color: #eee; border: 0;
        border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit;
      }
      button:hover { background: rgba(255,255,255,0.2); }
      .mxt-sub-list { overflow: auto; padding: 4px 0; }
      .mxt-sub-row { padding: 4px 10px; cursor: pointer; }
      .mxt-sub-row:hover { background: rgba(255,255,255,0.08); }
      .mxt-sub-time { color: #9aa0a6; font-size: 11px; font-variant-numeric: tabular-nums; }
      .mxt-sub-orig { color: #cfd3d8; }
      .mxt-sub-zh { color: #fff; }
      .mxt-sub-failed { color: #f28b82; font-style: italic; }
      .mxt-sub-row-failed { opacity: .7; }
      .mxt-sub-empty { padding: 12px 10px; color: #9aa0a6; }
    `;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(style);
    const head = document.createElement('div');
    head.className = 'mxt-sub-head';
    const title = document.createElement('span');
    title.className = 'mxt-sub-title';
    title.textContent = '字幕';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '关闭';
    head.append(title, close);
    const list = document.createElement('div');
    list.className = 'mxt-sub-list';
    shadow.append(head, list);
    close.addEventListener('click', () => host.classList.remove('mxt-sub-open'));
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function renderCues(host, cues, video) {
    const shadow = host.shadowRoot;
    const list = shadow.querySelector('.mxt-sub-list');
    const title = shadow.querySelector('.mxt-sub-title');
    list.textContent = '';
    if (!cues.length) {
      title.textContent = '字幕';
      const empty = document.createElement('div');
      empty.className = 'mxt-sub-empty';
      empty.textContent = '没找到可翻译的字幕';
      list.appendChild(empty);
      return;
    }
    title.textContent = `字幕（${cues.length} 条）`;
    const failed = cues.filter(c => c.failed).length;
    if (failed) {
      const note = document.createElement('div');
      note.className = 'mxt-sub-empty';
      note.textContent = `有 ${failed} 条没翻出来（接口失败或返回为空），这些只显示原文`;
      list.appendChild(note);
    }
    for (const c of cues) {
      const row = document.createElement('div');
      row.className = 'mxt-sub-row';
      if (c.failed) row.classList.add('mxt-sub-row-failed');
      const time = document.createElement('div');
      time.className = 'mxt-sub-time';
      time.textContent = fmtTime(c.start);
      const orig = document.createElement('div');
      orig.className = 'mxt-sub-orig';
      orig.textContent = c.text;
      const zh = document.createElement('div');
      zh.className = 'mxt-sub-zh';
      if (c.failed) {
        zh.textContent = '（没翻出来）';
        zh.classList.add('mxt-sub-failed');
      } else {
        zh.textContent = c.zh || '';
      }
      row.append(time, orig, zh);
      row.addEventListener('click', () => {
        try {
          video.currentTime = c.start + 0.05;
          video.play?.();
        } catch (_) {
          /* 忽略 */
        }
      });
      list.appendChild(row);
    }
  }

  /* ------------------------- 主流程 ------------------------- */

  async function collectFromVideo(video) {
    const tracks = tracksOf(video);
    for (const t of tracks) {
      if (t.kind === 'track' && t.cues && t.cues.length) return { cues: t.cues, label: t.label || '字幕' };
    }
    for (const t of tracks) {
      if (t.kind !== 'src' || !t.url) continue;
      const raw = await fetchText(t.url);
      if (!raw) continue;
      const cues = parseByExt(t.url, raw);
      if (cues.length) return { cues, label: t.label || t.lang || '字幕' };
    }
    return null;
  }

  async function run(targetLang) {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) {
      showMsg('页面上没有找到视频');
      return;
    }
    const host = ensureHost();
    const video = videos[0];
    host.classList.add('mxt-sub-open');
    const shadow = host.shadowRoot;
    const list = shadow.querySelector('.mxt-sub-list');
    list.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'mxt-sub-empty';
    loading.textContent = '正在找字幕…';
    list.appendChild(loading);

    const found = await collectFromVideo(video);
    if (!found) {
      /* 没有字幕轨：试试从视频里抽音频做语音识别 */
      loading.textContent = '没找到字幕轨，正在试着听声音识别…';
      const asr = await tryAsr(video, loading);
      if (!asr || !asr.length) {
        loading.textContent =
          '这个视频既没有字幕轨，语音识别也没成功（可在设置里填「语音识别模型」后再试）';
        return;
      }
      loading.textContent = `识别出 ${asr.length} 句，正在翻译…`;
      const asrCues = await translateCues(asr, targetLang);
      renderCues(host, asrCues, video);
      attachTrack(video, asrCues);
      return;
    }
    loading.textContent = `找到 ${found.cues.length} 条字幕，正在翻译…`;

    const cues = await translateCues(found.cues, targetLang);
    renderCues(host, cues, video);
    attachTrack(video, cues);
  }

  /* 没字幕轨时：抓音频 -> 语音识别 */
  async function tryAsr(video, loading) {
    try {
      loading.textContent = '正在录声音（最多 2 分钟，请让视频播着）…';
      const audio = await captureAudio(video, { seconds: 120 });
      if (!audio) {
        loading.textContent = '没录到声音（视频可能没在播，或者跨域不让抓）';
        return null;
      }
      loading.textContent = '录音完成，正在识别…';
      const cues = await transcribe(audio);
      return cues;
    } catch (e) {
      loading.textContent = '语音识别失败：' + (e?.message || e);
      return null;
    }
  }

  /* 把双语字幕塞进播放器（浏览器会显示成原生字幕） */
  function attachTrack(video, cues) {
    let url = null;
    try {
      const vtt = toVtt(cues, c => (c.failed ? c.text : `${c.text}\n${c.zh || ''}`));
      const blob = new Blob([vtt], { type: 'text/vtt' });
      url = URL.createObjectURL(blob);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = '中文（译点）';
      track.srclang = 'zh';
      track.src = url;
      track.default = true;
      video.appendChild(track);
      if (video.textTracks && video.textTracks.length) {
        for (const t of video.textTracks) t.mode = 'showing';
      }
      /* 记住这条轨道，下次重翻之前先撤掉。
         不撤的话会一条叠一条，播放器里出现好几份字幕轨。 */
      const prev = video.__mxtTrack;
      if (prev && prev.parentNode) {
        prev.parentNode.removeChild(prev);
        if (prev.__mxtUrl) URL.revokeObjectURL(prev.__mxtUrl);
      }
      track.__mxtUrl = url;
      video.__mxtTrack = track;
      url = null; // 所有权交给 track，别在这里释放
    } catch (_) {
      /* 塞不进去就算了，列表里也能看 */
    } finally {
      /* 上面抛错的话，这个 url 就没人管了，必须释放 */
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* 忽略 */
        }
      }
    }
  }

  function showMsg(text) {
    const host = ensureHost();
    host.classList.add('mxt-sub-open');
    const shadow = host.shadowRoot;
    const list = shadow.querySelector('.mxt-sub-list');
    list.textContent = '';
    const d = document.createElement('div');
    d.className = 'mxt-sub-empty';
    d.textContent = text;
    list.appendChild(d);
  }

  /* 纯函数挂出去，方便单独测试 */
  window.__MXT_SUB_API__ = { parseVtt, parseSrt, parseTime, fmtTime, fmtSrtTime, toVtt };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'mxt:translateSubs') {
      const settingsRes = chrome.runtime.sendMessage({ type: 'mxt:getSettings' }).catch(() => null);
      settingsRes.then(res => {
        const lang = (res && res.settings && res.settings.targetLang) || '简体中文';
        return run(lang);
      });
      sendResponse({ ok: true });
      return;
    }
  });
})();
