import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'background.js'), 'utf8');

/** 从源码里读出 MESSAGE_TYPES 白名单 */
function declaredTypes(): Set<string> {
  const m = SRC.match(/const MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  expect(m, 'background.js 里应该有 MESSAGE_TYPES 白名单').toBeTruthy();
  return new Set([...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}

/** 源码里所有被 if 分支处理的消息类型 */
function handledTypes(): Set<string> {
  return new Set([...SRC.matchAll(/msg\.type === '([^']+)'/g)].map(x => x[1]));
}

describe('后台消息白名单', () => {
  it('每个被处理的消息类型都在白名单里', () => {
    const declared = declaredTypes();
    const missing = [...handledTypes()].filter(t => !declared.has(t));
    expect(missing, `这些类型有分支但没登记白名单：${missing.join(', ')}`).toEqual([]);
  });

  it('白名单里没有多余的类型', () => {
    const handled = handledTypes();
    const stale = [...declaredTypes()].filter(t => !handled.has(t));
    expect(stale, `这些类型登记了但没有处理分支：${stale.join(', ')}`).toEqual([]);
  });

  it('白名单不为空，且类型名都带 mxt: 前缀', () => {
    const declared = declaredTypes();
    expect(declared.size).toBeGreaterThan(10);
    for (const t of declared) {
      expect(t.startsWith('mxt:'), `类型名应该带前缀：${t}`).toBe(true);
    }
  });

  it('未知类型在分发前就被拒掉', () => {
    // 白名单检查必须出现在第一个 msg.type 比较之前
    const guardAt = SRC.indexOf('MESSAGE_TYPES.has(msg.type)');
    const firstBranchAt = SRC.search(/msg\.type === '/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstBranchAt).toBeGreaterThan(-1);
    expect(guardAt, '白名单检查应该早于任何具体分支').toBeLessThan(firstBranchAt);
  });

  it('「清除全部数据」是登记过的类型', () => {
    expect(declaredTypes().has('mxt:clearAll')).toBe(true);
    expect(SRC).toContain("if (msg.type === 'mxt:clearAll')");
    // 必须真的把存储抹掉，不能只清内存缓存
    expect(SRC).toMatch(/mxt:clearAll[\s\S]{0,400}chrome\.storage\.local\.clear\(\)/);
  });
});
