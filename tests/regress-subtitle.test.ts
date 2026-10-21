import { describe, it, expect } from 'vitest';
import { parseVtt, parseSrt, parseCueTiming, fmtVttTime, toVtt } from '../src/core/subtitle.js';

/**
 * 缺陷 4：带 cue 设置的 WebVTT 解析出 0 条。
 *
 * 真实世界的 VTT（YouTube、Netflix、各种 CMS 播放器）时间行后面都带
 * cue 设置：align:start position:0% line:85% ...
 * 之前直接 split('-->') 再解析整个后半段，锚定过的正则认不出来，
 * 整条 cue 被丢掉 —— 字幕翻译于是「找不到字幕轨」。
 *
 * 缺陷 5：toVtt 用秒级精度，把 1.2s–1.8s 压成 "00:01 --> 00:01"，
 * 零长度的 cue 播放器显示不出来，相邻短字幕还会叠在一起。
 */

const VTT_WITH_SETTINGS = `WEBVTT

1
00:00:01.000 --> 00:00:02.000 align:start position:0%
Hello there

2
00:00:03.000 --> 00:00:04.500 align:middle position:50% line:85%
Second line
`;

const VTT_PLAIN = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
Hello there

2
00:00:03.000 --> 00:00:04.500
Second line
`;

describe('缺陷 4 · 带 cue 设置的 VTT 要能解析', () => {
  it('★ 带 cue 设置的 VTT 解析出正确条数', () => {
    const cues = parseVtt(VTT_WITH_SETTINGS);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('Hello there');
    expect(cues[1].text).toBe('Second line');
  });

  it('★ 时间和普通 VTT 一致', () => {
    const a = parseVtt(VTT_WITH_SETTINGS);
    const b = parseVtt(VTT_PLAIN);
    expect(a.map(c => [c.start, c.end])).toEqual(b.map(c => [c.start, c.end]));
  });

  it('带 cue 设置的结束时间也认得出来', () => {
    const cues = parseVtt(VTT_WITH_SETTINGS);
    expect(cues[1].end).toBeCloseTo(4.5);
  });

  it('各种 cue 设置组合都能处理', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.000 align:start
a

2
00:00:01.000 --> 00:00:02.000 line:85% position:50%
b

3
00:00:01.000 --> 00:00:02.000 align:middle line:0% position:0% size:100%
c
`;
    expect(parseVtt(vtt)).toHaveLength(3);
  });

  it('SRT 不受影响', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,000', 'Hello', '', '2', '00:00:03,000 --> 00:00:04,000', 'World'].join('\n');
    expect(parseSrt(srt)).toHaveLength(2);
  });
});

describe('parseCueTiming', () => {
  it('普通时间行', () => {
    expect(parseCueTiming('00:00:01.000 --> 00:00:02.000')).toEqual({ start: 1, end: 2 });
  });

  it('带 cue 设置', () => {
    expect(parseCueTiming('00:00:03.000 --> 00:00:04.000 align:start position:0%')).toEqual({
      start: 3,
      end: 4
    });
  });

  it('没有 --> 返回 null', () => {
    expect(parseCueTiming('not a timing line')).toBeNull();
  });

  it('时间本身非法时返回 null', () => {
    expect(parseCueTiming('abc --> def')).toBeNull();
  });
});

describe('缺陷 5 · toVtt 要保留毫秒', () => {
  it('★ 亚秒级的时间不会被压成同一个秒', () => {
    const vtt = toVtt(
      [
        { start: 1.2, end: 1.8, text: 'a' },
        { start: 12.5, end: 13.9, text: 'b' }
      ],
      c => c.text
    );
    const lines = vtt.split('\n').filter(l => l.includes('-->'));
    expect(lines[0]).toBe('00:00:01.200 --> 00:00:01.800');
    expect(lines[1]).toBe('00:00:12.500 --> 00:00:13.900');
  });

  it('★ 零长度的 cue 不会出现', () => {
    const vtt = toVtt([{ start: 1.2, end: 1.8, text: 'a' }], c => c.text);
    const line = vtt.split('\n').find(l => l.includes('-->'))!;
    const [s, e] = line.split('-->').map(x => x.trim());
    expect(s).not.toBe(e);
  });

  it('整秒的时间照常', () => {
    expect(fmtVttTime(0)).toBe('00:00:00.000');
    expect(fmtVttTime(61.5)).toBe('00:01:01.500');
    expect(fmtVttTime(3661.25)).toBe('01:01:01.250');
  });

  it('毫秒舍入到 1000 时要进位', () => {
    expect(fmtVttTime(1.9999)).toBe('00:00:02.000');
  });

  it('生成的 VTT 能被自己解析回来', () => {
    const cues = [
      { start: 1.2, end: 1.8, text: 'a' },
      { start: 12.5, end: 13.9, text: 'b' }
    ];
    const back = parseVtt(toVtt(cues, c => c.text));
    expect(back[0].start).toBeCloseTo(1.2, 2);
    expect(back[0].end).toBeCloseTo(1.8, 2);
    expect(back[1].start).toBeCloseTo(12.5, 2);
  });
});
