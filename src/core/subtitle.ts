/**
 * 字幕解析与时间轴格式化
 * ------------------------------------------------------------------
 * WebVTT / SRT 互转，供视频字幕翻译使用。
 * 纯函数，不碰 DOM。
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * "00:01:02.500" / "01:02.500" / "01:02,500" → 秒（小数）
 *
 * 正则必须锚定：字幕里常有 "align:start" 这类尾巴，
 * 不锚定的话 "abc 01:02.500" 也会被解析成 62.5，静默产生错误时间点。
 */
export function parseTime(s: string): number | null {
  const m = String(s || '')
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  if (min > 59 || sec > 59) return null;
  const ms = Number(String(m[4] || '0').padEnd(3, '0'));
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/**
 * 从一行时间轴里取出起止时间。
 *
 * WebVTT 的时间行后面会跟一串 cue 设置：
 *   "00:00:03.000 --> 00:00:04.000 align:start position:0%"
 * 这些设置只影响排版，不影响时间，所以要**先切掉**再解析时间 ——
 * 否则锚定过的正则会把整行判为非法，整条 cue 被丢掉。
 * （切掉设置之后正则仍然要锚定，否则 "abc 01:02.500" 又会被误解析。）
 */
export function parseCueTiming(line: string): { start: number; end: number } | null {
  const t = String(line || '');
  const i = t.indexOf('-->');
  if (i < 0) return null;
  const start = parseTime(t.slice(0, i));
  /* 结束时间后面可能跟着 cue 设置，只取到空白为止 */
  const endPart = t.slice(i + 3).trim().split(/\s+/)[0] || '';
  const end = parseTime(endPart);
  if (start == null || end == null) return null;
  return { start, end };
}

/** 秒 → "mm:ss" 或 "h:mm:ss" */
export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 秒 → "00:00:00,000"（SRT 时间格式）
 *
 * 毫秒必须落在 000–999。先把毫秒单独算出来，再判断是否要进位到秒，
 * 否则 Math.round 会算出 1000，输出 "00:00:01,1000" 这种非法时间戳。
 */
export function fmtSrtTime(t: number): string {
  const s = Math.max(0, t || 0);
  let totalSec = Math.floor(s);
  let ms = Math.round((s - totalSec) * 1000);
  if (ms >= 1000) {
    ms -= 1000;
    totalSec += 1;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}

/** WebVTT → cues */
export function parseVtt(raw: string): Cue[] {
  const cues: Cue[] = [];
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
    /* 用 parseCueTiming 切掉 cue 设置（align:start position:0% 之类） */
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

/** SRT → cues */
export function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];
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

/**
 * cues → WebVTT 文本。
 * @param getText 取每条字幕的显示文本（通常是「原文 + 译文」）。
 */
export function toVtt(cues: Cue[], getText: (cue: Cue) => string): string {
  const out: string[] = ['WEBVTT', ''];
  cues.forEach((c, i) => {
    out.push(String(i + 1));
    /* 用带毫秒的格式：秒级精度会把 1.2s–1.8s 压成 "00:01 --> 00:01"，
       零长度的 cue 播放器会显示不出来，相邻的短字幕还会叠在一起。 */
    out.push(`${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}`);
    out.push(getText(c));
    out.push('');
  });
  return out.join('\n');
}

/** 秒 → "00:00:01.200"（WebVTT 的时间格式，带毫秒） */
export function fmtVttTime(t: number): string {
  const s = Math.max(0, t || 0);
  const totalSec = Math.floor(s);
  const ms = Math.round((s - totalSec) * 1000);
  /* 舍入到 1000 毫秒时要进位 */
  let sec = totalSec;
  let milli = ms;
  if (milli >= 1000) {
    milli -= 1000;
    sec += 1;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(ss)}.${p(milli, 3)}`;
}
