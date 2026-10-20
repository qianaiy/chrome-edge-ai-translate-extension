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

/** "00:01:02.500" / "01:02.500" / "01:02,500" → 秒（小数） */
export function parseTime(s: string): number | null {
  const m = String(s || '')
    .trim()
    .match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  const ms = Number(String(m[4] || '0').padEnd(3, '0'));
  return h * 3600 + min * 60 + sec + ms / 1000;
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

/** 秒 → "00:00:00,000"（SRT 时间格式） */
export function fmtSrtTime(t: number): string {
  const s = Math.max(0, t || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
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
    const [a, z] = tl.split('-->');
    const start = parseTime(a);
    const end = parseTime(z);
    if (start == null || end == null) continue;
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
    const [a, z] = tl.split('-->');
    const start = parseTime(a);
    const end = parseTime(z);
    if (start == null || end == null) continue;
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
    out.push(`${fmtTime(c.start)} --> ${fmtTime(c.end)}`);
    out.push(getText(c));
    out.push('');
  });
  return out.join('\n');
}
