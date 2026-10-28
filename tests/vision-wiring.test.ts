/* 接线测试：后台真的把「模型给的框」规范化了，而不是只保证核心库函数正确。
 *
 * 这条测试用真实的消息通路（chrome.runtime.onMessage）走一遍，喂一个返回
 * 像素坐标的假上游 —— 这正是真实模型对 jp-burst 那张图的行为。
 */

import { describe, expect, it } from 'vitest';

import { loadBackground } from './helpers/load-background.js';

const SETTINGS = {
  baseURL: 'https://api.example.com/v1',
  apiKey: 'placeholder-key-not-a-secret',
  model: 'test-vision',
  visionModel: 'test-vision',
  protocol: 'openai',
  targetLang: '简体中文'
};

function upstream(content: string) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] })
  });
}

describe('mxt:translateImage 的坐标规范化', () => {
  it('上游返回 0-1000 坐标时，回给内容脚本的是 0-100 百分比', async () => {
    const body = JSON.stringify([
      { text: 'うわあぁっ！', zh: '哇啊！', box: [210, 300, 460, 340] },
      { text: '行く。', zh: '去。', box: [190, 760, 280, 800] }
    ]);
    const bg = await loadBackground({ settings: SETTINGS, fetchImpl: upstream(body) });

    const res = await bg.send({
      type: 'mxt:translateImage',
      image: 'AAAA',
      mediaType: 'image/png',
      width: 800,
      height: 1000
    });

    expect(res.ok).toBe(true);
    expect(res.boxSystem).toBe('thousandth');
    expect(res.items).toHaveLength(2);
    for (const it of res.items) {
      for (const v of it.box) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    /* 0-1000 归一化：210/10 = 21，460/10 = 46 */
    expect(res.items[0].box).toEqual([21, 30, 46, 34]);
  });

  it('上游已经是百分比时保持原值', async () => {
    const body = JSON.stringify([{ text: 'もう帰ろうか', zh: '该回家了吧', box: [62, 10, 88, 35] }]);
    const bg = await loadBackground({ settings: SETTINGS, fetchImpl: upstream(body) });

    const res = await bg.send({
      type: 'mxt:translateImage',
      image: 'AAAA',
      mediaType: 'image/png',
      width: 800,
      height: 1200
    });

    expect(res.boxSystem).toBe('percent');
    expect(res.items[0].box).toEqual([62, 10, 88, 35]);
  });

  it('框退化成一条线时降级成 null，但译文保留（交给气泡检测兜底）', async () => {
    const body = JSON.stringify([{ text: '行く。', zh: '去。', box: [10, 20, 10, 60] }]);
    const bg = await loadBackground({ settings: SETTINGS, fetchImpl: upstream(body) });

    const res = await bg.send({
      type: 'mxt:translateImage',
      image: 'AAAA',
      mediaType: 'image/png',
      width: 800,
      height: 1000
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].box).toBeNull();
    expect(res.items[0].zh).toBe('去。');
    expect(res.droppedBox).toBe(1);
  });

  it('同一块被报两次时合并，避免擦两遍留下残影', async () => {
    const body = JSON.stringify([
      { text: 'でも、まだ', zh: '可是，还有', box: [17, 42, 53, 63] },
      { text: 'でも、まだ言えてないことがある', zh: '可是，还有话没说出来', box: [18, 43, 54, 64] }
    ]);
    const bg = await loadBackground({ settings: SETTINGS, fetchImpl: upstream(body) });

    const res = await bg.send({
      type: 'mxt:translateImage',
      image: 'AAAA',
      mediaType: 'image/png',
      width: 800,
      height: 1200
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].text).toBe('でも、まだ言えてないことがある');
    expect(res.merged).toBe(1);
  });

  it('没传图片尺寸时，0-1000 仍然能换算（不再依赖尺寸）', async () => {
    const body = JSON.stringify([{ text: '行く。', zh: '去。', box: [210, 300, 460, 340] }]);
    const bg = await loadBackground({ settings: SETTINGS, fetchImpl: upstream(body) });

    const res = await bg.send({
      type: 'mxt:translateImage',
      image: 'AAAA',
      mediaType: 'image/png'
    });

    expect(res.boxSystem).toBe('thousandth');
    expect(res.items[0].box).toEqual([21, 30, 46, 34]);
  });
});
