import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Core from '../src/core/core.js';

/**
 * 共享核心的「接线」测试。
 *
 * 这个文件以前叫「扩展与核心一致」：把 background.js 里的复制品抠出来，
 * 和核心库跑同一批输入比对。那是在给一份不该存在的副本做体检 ——
 * 两份都改对了才算过，改对一份就炸，成本全花在维护重复本身上。
 *
 * 现在地址策略只有一份实现（src/core/endpoint.ts → 构建成 core.js），
 * 服务工作者启动时用 importScripts 加载。要守的东西变成「接线别断」：
 *   1. 后台脚本确实加载 core.js
 *   2. 后台脚本里不再有本地实现
 *   3. 后台从 MXTCore 取的名字，核心库真的导出
 *   4. 加载失败时明确报错，而不是悄悄退回一份自己的实现
 */
const BG = readFileSync(join(process.cwd(), 'src', 'extension', 'background.js'), 'utf8');

const DELEGATED = ['checkEndpoint', 'isLocalHost', 'sameOrigin', 'redirectWarning'];

describe('后台脚本加载共享核心', () => {
  it('启动时 importScripts(core.js)', () => {
    expect(BG).toContain("importScripts('core.js')");
  });

  it('加载失败时明确报错', () => {
    expect(BG).toContain('共享核心 core.js 没有加载');
  });

  it('地址策略没有留下本地实现', () => {
    for (const name of DELEGATED) {
      expect(BG, `background.js 不该自己定义 ${name}`).not.toMatch(new RegExp(`function\\s+${name}\\s*\\(`));
    }
  });

  it('从 MXTCore 解构，并逐个校验是否存在', () => {
    expect(BG).toMatch(/const\s*\{\s*checkEndpoint[^}]*\}\s*=\s*MXT_CORE/);
    /* 解构拿到 undefined 时要立刻报出可操作的错误，否则表现是调用时
       「checkEndpoint is not a function」，看不出是没重新构建 */
    expect(BG).toContain('共享核心缺少');
  });
});

describe('核心库真的导出这些能力', () => {
  it('四个地址策略函数都在 core.ts 的导出里', () => {
    for (const name of DELEGATED) {
      expect(typeof (Core as unknown as Record<string, unknown>)[name], `core 缺少 ${name}`).toBe(
        'function'
      );
    }
  });

  it('重定向判定的语义', () => {
    expect(Core.sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(Core.redirectWarning('https://a.com/x', 'https://a.com/y')).toBeNull();
    expect(Core.sameOrigin('https://a.com/x', 'https://evil.net/x')).toBe(false);
    expect(Core.redirectWarning('https://a.com/x', 'https://evil.net/x')).not.toBeNull();
  });
});
