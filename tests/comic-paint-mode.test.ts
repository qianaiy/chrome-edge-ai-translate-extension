import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「没有擦字」这组回归的守卫。
 *
 * 用户看到的现象是：译文出来了，但原文还压在下面——说明走的是浮层覆盖，
 * 不是擦字重绘。根因不是擦字算法坏了，而是**重画时把 drawable 丢掉了**：
 * 跨域图片的原图是污染画布，readPixels 会失败，renderTranslated 返回 null，
 * 于是安静地退回浮层。三处调用都可能丢，而且丢了不报错，只能靠盯源码。
 *
 * 所以这里测的是「接线」而不是算法：只要哪次改动又把 drawable 漏掉，立刻红。
 */
const SRC = readFileSync(
  join(process.cwd(), 'src', 'extension', 'content', 'comic.js'),
  'utf8'
);

/** 从 `startMarker` 起，取到括号配平的那一段 */
function block(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`comic.js 里找不到 ${startMarker}`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${startMarker} 的括号没配平`);
}

describe('漫画：重画时必须带上同源副本', () => {
  it('缓存命中（翻回翻过的一张）也走 applyToImage，而不是写死浮层', () => {
    const branch = block(SRC, 'if (!force && state.done.has(img)) {');
    expect(branch).toContain('applyToImage(img, rec.items, rec.drawable)');
    /* 这是那个 bug 的原形：翻回一张就退回浮层，擦字只在第一次出现过。
       只有真的「调用」paintOverlays 才算退回，注释里提到它不算。 */
    expect(branch).not.toMatch(/paintOverlays\s*\(/);
  });

  it('切换「擦字版 / 浮层版」时把 drawable 传下去', () => {
    const toggle = block(SRC, "modeBtn.addEventListener('click', () => {");
    expect(toggle).toContain('applyToImage(img, rec.items, rec.drawable)');
  });

  it('每一条识别记录都把 drawable 存下来，后面重画才有得用', () => {
    const sets = SRC.match(/state\.done\.set\(img, \{[^}]*\}\)/g) || [];
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const s of sets) expect(s).toContain('drawable: r.drawable');
  });

  it('擦不动时说明原因，而不是安静退回浮层', () => {
    const apply = block(SRC, 'function applyToImage(img, items, drawable) {');
    expect(apply).toContain('note(');
    expect(apply).toContain('跨域取不到原图');
    expect(apply).toContain('paintOverlays(img, items)');
  });

  it('提示是追加的，不会清空已经渲染好的译文列表', () => {
    const note = block(SRC, 'function note(text) {');
    expect(note).toContain('mxt-comic-note');
    expect(note).not.toContain("body.textContent = ''");
    expect(note).toContain('if (!text) return;');
  });

  it('样式里给提示留了位置（不然写了也看不见）', () => {
    expect(SRC).toMatch(/\.mxt-comic-note\s*\{[^}]*color/);
  });
});
