import { describe, it, expect } from 'vitest';
import {
  parseVtt,
  parseSrt,
  parseTime,
  fmtTime,
  fmtSrtTime,
  toVtt,
  type Cue
} from '../src/core/subtitle.js';

const VTT = `WEBVTT
Kind: captions
Language: zh-CN

1
00:00:01.000 --> 00:00:03.500
你好，世界

2
00:01.000 --> 00:02.250
第二条字幕

3
01:02:03.000 --> 01:02:05.000
带 <c.bgBlue>颜色</c> 的行
`;

const SRT = `1
00:00:01,000 --> 00:00:03,500
你好，世界

2
00:01,000 --> 00:02,250
第二条字幕

3
01:02:03,000 --> 01:02:05,000
第三条字幕
`;

describe('parseVtt', () => {
  it('解析出全部 cue', () => {
    const cues = parseVtt(VTT);
    expect(cues).toHaveLength(3);
  });

  it('解析 MM:SS.mmm 时间戳', () => {
    const cues = parseVtt(VTT);
    expect(cues[1].start).toBeCloseTo(1, 3);
    expect(cues[1].end).toBeCloseTo(2.25, 3);
  });

  it('解析 HH:MM:SS.mmm 时间戳', () => {
    const cues = parseVtt(VTT);
    expect(cues[0].start).toBeCloseTo(1, 3);
    expect(cues[0].end).toBeCloseTo(3.5, 3);
    expect(cues[2].start).toBeCloseTo(3723, 3);
    expect(cues[2].end).toBeCloseTo(3725, 3);
  });

  it('跳过 WEBVTT 头部块', () => {
    const cues = parseVtt(VTT);
    expect(cues.every(c => c.text !== 'Kind: captions')).toBe(true);
    expect(cues.some(c => c.text.includes('Language'))).toBe(false);
  });

  it('去掉 <c> 之类标签', () => {
    const cues = parseVtt(VTT);
    expect(cues[2].text).toBe('带 颜色 的行');
    expect(cues[2].text).not.toContain('<c.');
  });

  it('没有 --> 的块被跳过', () => {
    const raw = `WEBVTT

这是一段没有时间轴的文字

00:00:00.000 --> 00:00:01.000
有效字幕
`;
    const cues = parseVtt(raw);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('有效字幕');
  });

  it('空输入返回空数组', () => {
    expect(parseVtt('')).toEqual([]);
  });
});

describe('parseSrt', () => {
  it('解析出全部 cue', () => {
    const cues = parseSrt(SRT);
    expect(cues).toHaveLength(3);
  });

  it('逗号毫秒被正确解析', () => {
    const cues = parseSrt(SRT);
    expect(cues[0].start).toBeCloseTo(1, 3);
    expect(cues[0].end).toBeCloseTo(3.5, 3);
    expect(cues[1].start).toBeCloseTo(1, 3);
    expect(cues[1].end).toBeCloseTo(2.25, 3);
    expect(cues[2].start).toBeCloseTo(3723, 3);
  });

  it('忽略序号行，只取文字', () => {
    const cues = parseSrt(SRT);
    expect(cues.map(c => c.text)).toEqual(['你好，世界', '第二条字幕', '第三条字幕']);
  });

  it('空输入返回空数组', () => {
    expect(parseSrt('')).toEqual([]);
  });
});

describe('parseTime', () => {
  it('解析 MM:SS.mmm', () => {
    expect(parseTime('01:02.500')).toBeCloseTo(62.5, 3);
  });

  it('解析 HH:MM:SS.mmm', () => {
    expect(parseTime('00:01:02.500')).toBeCloseTo(62.5, 3);
  });

  it('解析逗号毫秒', () => {
    expect(parseTime('01:02,500')).toBeCloseTo(62.5, 3);
  });

  it('没有毫秒部分也能解析', () => {
    expect(parseTime('01:02')).toBeCloseTo(62, 3);
  });

  it('垃圾输入返回 null', () => {
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime('   ')).toBeNull();
  });
});

describe('fmtTime', () => {
  it('小于一小时用 mm:ss', () => {
    expect(fmtTime(65)).toBe('01:05');
  });

  it('超过一小时用 h:mm:ss', () => {
    expect(fmtTime(3665)).toBe('1:01:05');
  });

  it('负数被夹到 0', () => {
    expect(fmtTime(-10)).toBe('00:00');
  });
});

describe('fmtSrtTime', () => {
  it('输出 00:00:00,000 形态', () => {
    expect(fmtSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('整秒没有毫秒', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(61)).toBe('00:01:01,000');
  });
});

describe('toVtt', () => {
  const cues: Cue[] = [
    { start: 0, end: 5, text: '一' },
    { start: 5, end: 10, text: '二' }
  ];

  it('带 WEBVTT 头', () => {
    const vtt = toVtt(cues, c => c.text);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  });

  it('cue 从 1 开始编号', () => {
    const vtt = toVtt(cues, c => c.text);
    expect(vtt).toContain('\n1\n');
    expect(vtt).toContain('\n2\n');
  });

  it('用 --> 分隔时间轴（带毫秒，避免零长度 cue）', () => {
    const vtt = toVtt(cues, c => c.text);
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    expect(vtt).toContain('00:00:05.000 --> 00:00:10.000');
  });

  it('使用 getText 回调取文本', () => {
    const vtt = toVtt(cues, c => `${c.text}!`);
    expect(vtt).toContain('一!');
    expect(vtt).toContain('二!');
  });

  it('空 cue 列表只输出头', () => {
    expect(toVtt([], c => c.text)).toBe('WEBVTT\n');
  });
});

describe('round-trip', () => {
  it('parseVtt(toVtt(cues)) 保留 start/end/text', () => {
    const cues: Cue[] = [
      { start: 0, end: 5, text: '第一句' },
      { start: 5, end: 10, text: '第二句' },
      { start: 3723, end: 3725, text: '第三句' }
    ];
    const back = parseVtt(toVtt(cues, c => c.text));
    expect(back).toHaveLength(cues.length);
    back.forEach((c, i) => {
      expect(c.start).toBe(cues[i].start);
      expect(c.end).toBe(cues[i].end);
      expect(c.text).toBe(cues[i].text);
    });
  });

  it('toVtt 的输出能被 parseVtt 重新读出（带前后空行的标准写法）', () => {
    const cues: Cue[] = [{ start: 1, end: 2, text: 'hello' }];
    const vtt = `WEBVTT\n\n${toVtt(cues, c => c.text).replace(/^WEBVTT\n/, '')}`;
    const back = parseVtt(vtt);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual({ start: 1, end: 2, text: 'hello' });
  });
});
