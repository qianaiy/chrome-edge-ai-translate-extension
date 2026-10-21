import { describe, it, expect } from 'vitest';
import { parseMarked } from '../src/core/prompt.js';

/**
 * 后台批量翻译的缓存回写：索引空间是否一致。
 *
 * 后台把「命中缓存的段落」和「要问模型的段落」分开处理：
 *   - pending 里的项用**原始下标**编号：'<<<i+1>>>'
 *   - 缓存回写用 parseMarked(text, list.length)，再按 i 取 list[i]
 *
 * 只要模型照抄编号，索引空间就是一致的。这组测试把这条性质钉住，
 * 免得以后改编号方式时悄悄错位。
 */

describe('批量翻译的索引空间', () => {
  it('编号不连续时，parseMarked 仍按标记数字定位', () => {
    /* list 里只有下标 5 和 9 有内容 */
    const list = ['', '', '', '', '', 'A', '', '', '', 'B'];
    const reply = '<<<6>>>A译文\n<<<10>>>B译文';
    const parsed = parseMarked(reply, list.length);
    expect(parsed[5]).toBe('A译文');
    expect(parsed[9]).toBe('B译文');
  });

  it('模型把编号改成连续时会错位（这正是不能依赖模型的原因）', () => {
    const list = ['', '', '', '', '', 'A', '', '', '', 'B'];
    /* 模型「好心」把编号改成 1,2 —— 这时候按标记数字定位就全错了 */
    const reply = '<<<1>>>A译文\n<<<2>>>B译文';
    const parsed = parseMarked(reply, list.length);
    expect(parsed[5]).toBeNull();
    expect(parsed[9]).toBeNull();
  });

  it('模型漏掉某段时，那一段是 null（触发逐条重试）', () => {
    const list = ['A', 'B', 'C'];
    const reply = '<<<1>>>A译文\n<<<3>>>C译文';
    const parsed = parseMarked(reply, list.length);
    expect(parsed[0]).toBe('A译文');
    expect(parsed[1]).toBeNull();
    expect(parsed[2]).toBe('C译文');
  });

  it('越界的标记号被忽略，不会越界写数组', () => {
    const list = ['A', 'B'];
    const reply = '<<<1>>>A译文\n<<<99>>>越界';
    const parsed = parseMarked(reply, list.length);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe('A译文');
    expect(parsed[1]).toBeNull();
  });

  it('模型给重复的编号时，后一个覆盖前一个', () => {
    const list = ['A', 'B'];
    const reply = '<<<1>>>第一个\n<<<1>>>第二个';
    const parsed = parseMarked(reply, list.length);
    expect(parsed[0]).toBe('第二个');
  });
});
