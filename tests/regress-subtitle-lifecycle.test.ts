import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, createChromeSpy, loadContent } from './helpers/load-content.js';

/**
 * 字幕关闭 = 一个事务（ADR-0007 §2.7）。
 *
 * 关面板必须真的停下来：停音频采集、清计时器、丢在途结果、撤 track。
 * 但「已经发出去的识别请求」撤不回来——所以只能丢结果，不许在界面上说「已取消」。
 *
 * 这里用假时钟把 120 秒的采集窗口压缩成 0，否则一条用例要跑两分钟。
 */

type Dict = Record<string, any>;

function makeAudio() {
  const state = { closed: 0, disconnects: 0, procs: [] as Dict[] };
  class FakeAudioContext {
    sampleRate = 44100;
    destination = {};
    createMediaElementSource() {
      return {
        connect() {},
        disconnect() {
          state.disconnects++;
        }
      };
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {
          state.disconnects++;
        }
      };
    }
    createScriptProcessor() {
      const proc: Dict = {
        connect() {},
        disconnect() {
          state.disconnects++;
        },
        onaudioprocess: null
      };
      state.procs.push(proc);
      return proc;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      state.closed++;
      return Promise.resolve();
    }
  }
  return { Ctx: FakeAudioContext, state };
}

function makeChrome() {
  return createChromeSpy({
    settings: { targetLang: '简体中文' },
    reply: (msg: Dict) => {
      if (msg.type === 'mxt:transcribe') return { ok: true, cues: [{ start: 0, end: 1.5, text: 'hello' }] };
      if (msg.type === 'mxt:translate') return { ok: true, translations: ['你好'] };
      return { ok: true };
    }
  });
}

async function setup() {
  const video = new FakeElement('video', new FakeDocument());
  const audio = makeAudio();
  const spy = makeChrome();
  const urls: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const urlImpl = {
    createObjectURL: () => {
      const u = `blob:mxt-${++n}`;
      urls.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(String(u));
    }
  };
  const h = await loadContent({
    file: 'subtitle.js',
    dom: { queryAll: sel => (sel === 'video' ? [video] : []), AudioContext: audio.Ctx },
    chrome: spy.chrome,
    urlImpl
  });
  const host = () => h.document.getElementById('mxt-sub-host')!;
  const listText = () => host().shadowRoot!.querySelector('.mxt-sub-list')!.textContent;
  const closeButton = () => h.created('button')[0];
  const tracks = () => video.children.filter(c => c.tagName === 'TRACK');
  const countOf = (type: string) => spy.sent.filter(m => m.type === type).length;
  return { h, video, audio, spy, urls, revoked, host, listText, closeButton, tracks, countOf };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('字幕关闭事务', () => {
  it('mxt:translateSubs 的回执是 accepted + takeover', async () => {
    vi.useFakeTimers();
    const s = await setup();
    const r = await s.h.send({ type: 'mxt:translateSubs' });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(r.ok).toBeUndefined();
  });

  it('录声音的 120 秒等待里关掉：停采集、清计时器、不再发识别与翻译', async () => {
    vi.useFakeTimers();
    const s = await setup();
    void s.h.send({ type: 'mxt:translateSubs' });
    await vi.advanceTimersByTimeAsync(20);

    expect(s.audio.state.procs.length).toBe(1);
    expect(s.countOf('mxt:transcribe')).toBe(0);

    s.closeButton().fire('click');
    expect(s.audio.state.closed).toBe(1);
    expect(s.audio.state.disconnects).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(130_000);
    expect(s.countOf('mxt:transcribe')).toBe(0);
    expect(s.countOf('mxt:translate')).toBe(0);
    expect(s.tracks().length).toBe(0);
  });

  it('关闭后的提示如实说明「已发出的请求无法撤回」，不许说已取消', async () => {
    vi.useFakeTimers();
    const s = await setup();
    void s.h.send({ type: 'mxt:translateSubs' });
    await vi.advanceTimersByTimeAsync(20);
    s.closeButton().fire('click');
    await vi.advanceTimersByTimeAsync(10);

    const text = s.listText();
    expect(text).toContain('无法撤回');
    expect(text).not.toContain('已取消');
  });

  it('识别已经发出去、结果还在路上时关掉：结果被丢弃，不挂 track', async () => {
    vi.useFakeTimers();
    const s = await setup();
    void s.h.send({ type: 'mxt:translateSubs' });
    await vi.advanceTimersByTimeAsync(20);

    /* 让识别请求停在「已发出、没回来」的状态：这才是用户点关闭时的真实瞬间。
       不这么做的话，假时钟会在同一次 advance 里把应答也走完，就测不到「在途」这件事。 */
    let release: (v: Dict) => void = () => {};
    const inflight = new Promise<Dict>(r => {
      release = r;
    });
    const realSend = s.spy.chrome.runtime.sendMessage as (m: Dict) => Promise<Dict>;
    s.spy.chrome.runtime.sendMessage = (msg: Dict) => {
      const p = realSend(msg);
      return msg.type === 'mxt:transcribe' ? inflight : p;
    };

    /* 喂一段录音，让 120 秒到点后有东西可编码 */
    s.audio.state.procs[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.1) } });
    await vi.advanceTimersByTimeAsync(120_000);

    /* 请求已经发出去了（这一步无法撤回），此时用户关掉面板 */
    expect(s.countOf('mxt:transcribe')).toBe(1);
    s.closeButton().fire('click');
    release({ ok: true, cues: [{ start: 0, end: 1, text: 'hello' }] });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(s.countOf('mxt:translate')).toBe(0);
    expect(s.tracks().length).toBe(0);
    expect((s.video as unknown as Record<string, any>).__mxtTrack || null).toBe(null);
  });

  it('结果已经上屏后关掉：撤 track 并 revokeObjectURL', async () => {
    vi.useFakeTimers();
    const s = await setup();
    void s.h.send({ type: 'mxt:translateSubs' });
    await vi.advanceTimersByTimeAsync(20);
    s.audio.state.procs[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.1) } });
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(s.tracks().length).toBe(1);
    const track = s.tracks()[0];
    const trackUrl = track.src;

    s.closeButton().fire('click');
    await vi.advanceTimersByTimeAsync(10);

    expect(s.tracks().length).toBe(0);
    expect(s.revoked).toContain(trackUrl);
    expect(s.host().classList.contains('mxt-sub-open')).toBe(false);
  });
});