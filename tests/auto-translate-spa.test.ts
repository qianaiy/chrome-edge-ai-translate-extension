import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 自动翻译在 SPA 换页时的行为。
 *
 * 单页应用在同一个地址栏下面换内容很常见（点进一篇文章、切到另一个频道）。
 * 新页面的语言可能跟上一页完全不同：中文首页点进一篇英文文章。
 *
 * 早先的实现只用一个 `autoTranslateTried` 布尔记住「这个页面判断过了」，
 * 换页后永远不再判断 —— 英文文章不会自动翻，
 * 而如果第一页是外文、换成一页中文，也不会重新判断。
 */

const CONTENT = join(process.cwd(), 'src', 'extension', 'content', 'content.js');

describe('自动翻译 · SPA 换页要重新判断语言', () => {
  let src: string;

  beforeAll(async () => {
    src = await readFile(CONTENT, 'utf8');
  });

  it('★ 用「已判断过的 URL 集合」而不是一个全局布尔', () => {
    expect(src).toContain('autoTriedUrls');
    /* 老的写法：一个布尔，判断过就再也不判断了 */
    expect(src).not.toMatch(/let autoTranslateTried\s*=\s*false/);
  });

  /** 取 housekeeping 里 URL 变化那一段（用最后一次出现，避免匹配到别处的同名局部变量） */
  const urlChangeBlock = () => {
    const marker = 'const url = location.href;';
    const i = src.lastIndexOf(marker);
    expect(i, '应该能在 housekeeping 里找到 URL 变化处理').toBeGreaterThan(0);
    return src.slice(i, i + 700);
  };

  it('★ URL 变了要重新调度一次语言判断', () => {
    expect(urlChangeBlock()).toContain('scheduleAutoRecheck()');
  });

  it('★ 只在「这一页还没翻过」时才重新判断', () => {
    const b = urlChangeBlock();
    expect(b).toContain('!state.nodes.length');
    expect(b).toContain('!state.busy');
  });

  it('★ 同一地址不会重复判断', () => {
    expect(src).toMatch(/autoTriedUrls\.has\(url\)\)\s*return/);
  });

  it('★ 文字太少的页面不算「判断过」，后面加载出正文还能再判', () => {
    /* 否则短页面（如加载中的骨架屏）会把这一页永久标记成「不用翻」 */
    const block = src.match(/if \(text\.length < minChars\) \{[\s\S]*?\n {4}\}/);
    expect(block, '应该能找到文字量门槛那段').toBeTruthy();
    expect(block![0]).toContain('autoTriedUrls.delete(url)');
  });

  it('★ 重新判断会等页面稳一下，避免拿到上一页的残留文字', () => {
    const fn = src.match(/function scheduleAutoRecheck\(\)[\s\S]*?\n {2}\}/);
    expect(fn, '应该能找到 scheduleAutoRecheck').toBeTruthy();
    expect(fn![0]).toMatch(/setTimeout\([\s\S]*?\d{3,}/); // 有等待
  });

  it('★ 设置里刚打开开关时，当前页也立刻判一次', () => {
    const block = src.match(/chrome\.storage\.onChanged\.addListener[\s\S]*?\n {2}\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('scheduleAutoRecheck()');
    expect(block![0]).toMatch(/wasOn/);
  });

  it('判断前会检查接口有没有配好', () => {
    expect(src).toContain("type: 'mxt:configStatus'");
  });
});

describe('自动翻译 · 语言判断边界', () => {
  let src: string;

  beforeAll(async () => {
    src = await readFile(CONTENT, 'utf8');
  });

  it('★ 页面语言判断会读 <html lang>', () => {
    /* pageIsTargetLanguage 用 html lang 优先判断 */
    expect(src).toContain('document.documentElement.lang');
  });

  it('★ 抽样文字时跳过 script / style，不把代码当正文', () => {
    const fn = src.match(/function samplePageText\(\)[\s\S]*?\n {2}\}/);
    expect(fn, '应该能找到 samplePageText').toBeTruthy();
    expect(fn![0]).toContain('SCRIPT');
    expect(fn![0]).toContain('STYLE');
  });

  it('抽样有上限，长页面不会把整页读一遍', () => {
    const fn = src.match(/function samplePageText\(\)[\s\S]*?\n {2}\}/);
    expect(fn![0]).toMatch(/4000/);
  });
});
