import { describe, it, expect } from 'vitest';
import { parseTime, fmtSrtTime, parseVtt, parseSrt, toVtt } from '../src/core/subtitle.js';
import { buildRequest } from '../src/core/protocol.js';

/**
 * 回归测试：这些是实际查出来的缺陷，不是假想。
 * 每条都对应一个可复现的错误输入。
 */

describe('回归 · fmtSrtTime 毫秒进位', () => {
  it('毫秒四舍五入到 1000 时必须进位到秒，不能输出 ,1000', () => {
    /* Math.round((1.9999 - 1) * 1000) === 1000，padStart 不会进位 */
    expect(fmtSrtTime(1.9999)).toBe('00:00:02,000');
  });

  it('正常值不受影响', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(1.5)).toBe('00:00:01,500');
    expect(fmtSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('产出的时间戳毫秒部分永远落在 000–999', () => {
    for (const t of [0, 0.0004, 0.0005, 1.9994, 1.9995, 1.9999, 59.9999, 3599.9999]) {
      const ms = fmtSrtTime(t).split(',')[1];
      expect(Number(ms), `t=${t}`).toBeLessThan(1000);
      expect(ms.length, `t=${t}`).toBe(3);
    }
  });

  it('进位后小时位也跟着涨', () => {
    expect(fmtSrtTime(3599.9999)).toBe('01:00:00,000');
  });
});

describe('回归 · parseTime 必须锚定', () => {
  it('不会在垃圾前缀里「找到」一个时间', () => {
    expect(parseTime('abc 01:02.500')).toBeNull();
    expect(parseTime('x1:02')).toBeNull();
    expect(parseTime('garbage')).toBeNull();
  });

  it('不会丢掉多余字段', () => {
    expect(parseTime('12:34:56:78')).toBeNull();
  });

  it('分秒越界返回 null', () => {
    expect(parseTime('00:99:00')).toBeNull();
    expect(parseTime('00:00:99')).toBeNull();
  });

  it('正常格式照常解析', () => {
    expect(parseTime('01:02.500')).toBeCloseTo(62.5);
    expect(parseTime('00:01:02.500')).toBeCloseTo(62.5);
    expect(parseTime('01:02,500')).toBeCloseTo(62.5);
    expect(parseTime('02:03')).toBeCloseTo(123);
  });
});

describe('回归 · VTT/SRT 解析忽略带尾巴的时间行', () => {
  it('VTT 带 align 参数的行被跳过，不产生错位的时间点', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:02.000 align:start position:10%',
      'Hello'
    ].join('\n');
    /* 整行不是纯时间戳 → 这条 cue 不该被解析出来 */
    expect(parseVtt(vtt)).toEqual([]);
  });

  it('正常 VTT 仍能解析', () => {
    const vtt = ['WEBVTT', '', '1', '00:00:01.000 --> 00:00:02.000', 'Hello'].join('\n');
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('SRT 正常解析不受影响', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,000', '你好'].join('\n');
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBeCloseTo(1);
    expect(cues[0].end).toBeCloseTo(2);
  });
});

describe('回归 · Anthropic 的 system 提示词不能丢', () => {
  const settings = {
    baseURL: 'https://api.anthropic.com',
    apiKey: 'k',
    model: 'claude-3-5-haiku',
    temperature: 0.2
  };

  it('system 是数组形式时也要进 body.system', () => {
    const req = buildRequest('anthropic', settings, [
      { role: 'system', content: [{ type: 'text', text: '你是翻译' }] },
      { role: 'user', content: 'hello' }
    ]);
    expect(req.body.system).toBe('你是翻译');
  });

  it('system 是字符串时行为不变', () => {
    const req = buildRequest('anthropic', settings, [
      { role: 'system', content: '你是翻译' },
      { role: 'user', content: 'hello' }
    ]);
    expect(req.body.system).toBe('你是翻译');
  });

  it('system 消息不会残留在 messages[] 里', () => {
    const req = buildRequest('anthropic', settings, [
      { role: 'system', content: [{ type: 'text', text: '你是翻译' }] },
      { role: 'user', content: 'hello' }
    ]);
    const msgs = req.body.messages as { role: string }[];
    expect(msgs.every(m => m.role !== 'system')).toBe(true);
    expect(msgs).toHaveLength(1);
  });

  it('OpenAI 分支不受影响：system 仍在 messages[] 里', () => {
    const req = buildRequest('openai', settings, [
      { role: 'system', content: '你是翻译' },
      { role: 'user', content: 'hello' }
    ]);
    const msgs = req.body.messages as { role: string }[];
    expect(msgs.some(m => m.role === 'system')).toBe(true);
  });
});

describe('回归 · Gemini 版本号判断', () => {
  const settings = { apiKey: 'k', model: 'gemini-2.0-flash', temperature: 0.2 };

  it('base 形如 /v1/models/<model> 时应判成 v1', () => {
    const req = buildRequest('gemini', {
      ...settings,
      baseURL: 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash'
    }, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toContain('/v1/models/gemini-2.0-flash:generateContent');
    expect(req.url).not.toContain('v1beta');
  });

  it('base 形如 /v1 时应判成 v1', () => {
    const req = buildRequest('gemini', {
      ...settings,
      baseURL: 'https://generativelanguage.googleapis.com/v1'
    }, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toContain('/v1/models/gemini-2.0-flash:generateContent');
  });

  it('base 不带版本时默认 v1beta', () => {
    const req = buildRequest('gemini', {
      ...settings,
      baseURL: 'https://generativelanguage.googleapis.com'
    }, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toContain('/v1beta/models/gemini-2.0-flash:generateContent');
  });
});

describe('回归 · toVtt 往返', () => {
  it('整秒 cue 往返后 start/end/text 不变', () => {
    const cues = [
      { start: 0, end: 2, text: 'Hello' },
      { start: 2, end: 4, text: 'World' }
    ];
    const back = parseVtt(toVtt(cues, c => c.text));
    expect(back).toHaveLength(2);
    expect(back[0].start).toBeCloseTo(0);
    expect(back[0].end).toBeCloseTo(2);
    expect(back[0].text).toBe('Hello');
    expect(back[1].end).toBeCloseTo(4);
  });

  it('toVtt 用秒级精度，小数秒会被取整（这是既有设计，不是缺陷）', () => {
    const vtt = toVtt([{ start: 0, end: 4.5, text: 'x' }], c => c.text);
    expect(vtt).toContain('00:00 --> 00:04');
  });
});
