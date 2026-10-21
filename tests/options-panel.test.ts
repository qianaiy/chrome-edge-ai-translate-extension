import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 设置页的模型下拉面板。
 *
 * 列表可能有几千个模型，渲染时只显示前 300 个。
 * 「当前选中第几项」的所有判断都必须基于**同一个截断后的列表**，
 * 否则键盘上下键能走到没渲染出来的项上，Enter 选中的东西跟看到的对不上。
 */
const OPTIONS = join(process.cwd(), 'src', 'extension', 'options', 'options.js');

describe('模型下拉面板', () => {
  let src: string;

  beforeAll(async () => {
    src = await readFile(OPTIONS, 'utf8');
  });

  it('渲染和键盘导航用同一个截断上限', () => {
    /* PANEL_MAX 只能定义一次，所有地方都引用它 */
    const defs = src.match(/const PANEL_MAX\s*=/g) || [];
    expect(defs.length).toBe(1);
  });

  it('shownModels() 会截断到 PANEL_MAX', () => {
    expect(src).toMatch(/function shownModels\(\)\s*\{[\s\S]*?slice\(0,\s*PANEL_MAX\)/);
  });

  it('键盘上下键用的是 shownModels()（截断后的），不是完整列表', () => {
    const move = src.match(/function movePanelIndex\(step\)\s*\{[\s\S]*?\n {2}\}/);
    expect(move, '应该能找到 movePanelIndex').toBeTruthy();
    expect(move![0]).toContain('shownModels()');
    expect(move![0]).not.toMatch(/filterModels\(visibleModels\(\)/);
  });

  it('回车选中用的是 shownModels()（截断后的）', () => {
    const enter = src.match(/if \(e\.key === 'Enter'\) \{[\s\S]*?\n {4}\}/);
    expect(enter, '应该能找到 Enter 处理').toBeTruthy();
    expect(enter![0]).toContain('shownModels()');
  });

  it('渲染列表时也用 PANEL_MAX 截断', () => {
    expect(src).toMatch(/const shown = filtered\.slice\(0,\s*PANEL_MAX\)/);
    /* 不该再有写死的 300 */
    expect(src).not.toMatch(/slice\(0,\s*300\)/);
  });
});
