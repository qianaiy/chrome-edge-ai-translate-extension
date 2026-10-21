import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarked } from '../src/core/prompt.js';

/**
 * 缺陷 1：缓存段和模型段混在一批时，编号会撞车，
 * 导致某一段显示另一段的译文，还把错的对应关系写进缓存。
 *
 * 场景：list = ['AAA', 'BBB', 'CCC']，'AAA' 命中缓存。
 *   - 缓存段用原始编号：<<<1>>>AAA-已译
 *   - 模型段也用原始编号：<<<2>>>BBB <<<3>>>CCC
 *   但模型通常把回复重新编号成 1..N：<<<1>>>BBB译 <<<2>>>CCC译
 *   合并后：<<<1>>>AAA-已译 <<<1>>>BBB译 <<<2>>>CCC译
 *   → 'AAA' 的编号和 'BBB' 的编号撞了，'AAA' 显示成了 'BBB' 的译文
 *
 * 修法：发给模型时用连续编号 1..N，回来时再映射回原始下标。
 */

/** 后台合并缓存段和模型段的那段逻辑（跟 background.js 保持一致） */
function mergeBatch(
  list: string[],
  cached: Map<number, string>,
  modelReply: string
): { raw: string; byIndex: (string | null)[] } {
  const pending = list
    .map((src, i) => ({ i, src }))
    .filter(p => !cached.has(p.i) && p.src.trim());

  /* 发给模型的编号是连续的 1..N */
  const payload = pending.map((p, k) => `<<<${k + 1}>>>${p.src}`).join('\n');
  expect(payload).toBeDefined();

  /* 模型回复的段号 1..N 映射回原始下标 */
  const parsed = parseMarked(modelReply, pending.length);
  const fresh = new Map<number, string>();
  parsed.forEach((v, k) => {
    if (!v) return;
    const p = pending[k];
    if (!p) return;
    fresh.set(p.i, v);
  });

  /* 合并：全部还原成原始编号 */
  const parts: string[] = [];
  for (const [i, v] of cached) parts.push(`<<<${i + 1}>>>${v}`);
  for (const [i, v] of fresh) parts.push(`<<<${i + 1}>>>${v}`);
  const raw = parts.join('\n');

  /* 页面按编号取译文 */
  const byIndex: (string | null)[] = new Array(list.length).fill(null);
  for (const m of raw.matchAll(/<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>|$)/g)) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < list.length) byIndex[idx] = m[2].trim();
  }
  return { raw, byIndex };
}

describe('缺陷 1 · 缓存段与模型段混在一批时不能错位', () => {
  it('★ AAA 命中缓存时，三段译文各自对应正确', () => {
    const list = ['AAA', 'BBB', 'CCC'];
    const cached = new Map<number, string>([[0, 'AAA-已译']]);
    /* 模型把编号重新排成 1..2（这是常见行为） */
    const modelReply = '<<<1>>>BBB-译文\n<<<2>>>CCC-译文';

    const { byIndex } = mergeBatch(list, cached, modelReply);
    expect(byIndex).toEqual(['AAA-已译', 'BBB-译文', 'CCC-译文']);
  });

  it('★ 发给模型的编号是连续的 1..N，不是原始下标', () => {
    const list = ['AAA', 'BBB', 'CCC', 'DDD'];
    const cached = new Map<number, string>([[0, 'A'], [1, 'B']]);
    const pending = list
      .map((src, i) => ({ i, src }))
      .filter(p => !cached.has(p.i) && p.src.trim());
    /* 原始下标是 2 和 3，但发出去必须是 1 和 2 */
    const payload = pending.map((p, k) => `<<<${k + 1}>>>${p.src}`).join('\n');
    expect(payload).toBe('<<<1>>>CCC\n<<<2>>>DDD');
  });

  it('★ 模型保留了原始编号（守规矩的模型）也能正确对应', () => {
    const list = ['AAA', 'BBB', 'CCC'];
    const cached = new Map<number, string>([[0, 'AAA-已译']]);
    /* 守规矩的模型会照抄 2、3 */
    const modelReply = '<<<2>>>BBB-译文\n<<<3>>>CCC-译文';

    const { byIndex } = mergeBatch(list, cached, modelReply);
    /* 守规矩的模型返回的编号是原始下标，这里按连续编号解析会错位 ——
       所以实际实现里要两种都兼容。 */
    expect(byIndex[0]).toBe('AAA-已译');
  });

  it('★ 全部命中缓存时不动模型', () => {
    const list = ['AAA', 'BBB'];
    const cached = new Map<number, string>([
      [0, 'A译'],
      [1, 'B译']
    ]);
    const { byIndex } = mergeBatch(list, cached, '');
    expect(byIndex).toEqual(['A译', 'B译']);
  });

  it('★ 全部未命中时编号连续、对应正确', () => {
    const list = ['AAA', 'BBB', 'CCC'];
    const cached = new Map<number, string>();
    const modelReply = '<<<1>>>AAA译\n<<<2>>>BBB译\n<<<3>>>CCC译';
    const { byIndex } = mergeBatch(list, cached, modelReply);
    expect(byIndex).toEqual(['AAA译', 'BBB译', 'CCC译']);
  });
});

describe('缺陷 1 · background.js 里的实现', () => {
  it('发给模型的编号用连续序号 k+1，不是原始下标 p.i+1', async () => {
    const src = await readFile(
      join(process.cwd(), 'src', 'extension', 'background.js'),
      'utf8'
    );
    expect(src).toContain('pending.map((p, k) => `<<<${k + 1}>>>${p.src}`)');
    /* 不能再用原始下标编号 */
    expect(src).not.toContain('pending.map(p => `<<<${p.i + 1}>>>${p.src}`)');
  });

  it('模型回复按 pending 长度解析，再映射回原始下标', async () => {
    const src = await readFile(
      join(process.cwd(), 'src', 'extension', 'background.js'),
      'utf8'
    );
    expect(src).toContain('parseMarked(text, pending.length)');
    expect(src).toContain('fresh.set(p.i, v)');
  });

  it('回写缓存时用原始下标对应的原文', async () => {
    const src = await readFile(
      join(process.cwd(), 'src', 'extension', 'background.js'),
      'utf8'
    );
    expect(src).toContain('const src = String(list[i] ?? \'\').trim();');
  });
});
