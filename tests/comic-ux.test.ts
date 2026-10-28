import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 漫画面板的 UX 接线测试。
 *
 * 这一批行为都是「用户能不能把活干完」级别的：翻失败了能不能只重试一条、
 * 翻的过程看不看得见进度、擦字版能不能动手调位置、调错了能不能退回去、
 * 能不能在译图和原图之间切。它们全住在内容脚本里（content script 用不了 import），
 * 仓库既定做法是从 src/extension/content/comic.js 抠源码做接线断言，
 * 真正的像素结果由 scripts/manga-typeset-check.mjs 在真实浏览器里跑。
 */
const SRC = readFileSync(
  join(process.cwd(), 'src', 'extension', 'content', 'comic.js'),
  'utf8'
);

/** 按函数名抠出整段源码（含 async 前缀），括号配平 */
function grab(src: string, name: string): string {
  const asAsync = src.indexOf(`async function ${name}(`);
  const start = asAsync >= 0 ? asAsync : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`comic.js 里找不到 ${name}`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的括号没配平`);
}

const idx = (needle: string, from = 0) => {
  const at = SRC.indexOf(needle, from);
  expect(at, `源码里应该有：${needle}`).toBeGreaterThanOrEqual(0);
  return at;
};

describe('翻译失败后可局部重试', () => {
  it('译文列表每一行都有重试按钮，并接到 retryItem', () => {
    const body = grab(SRC, 'renderItems');
    expect(body).toMatch(/mxt-comic-retry/);
    expect(body).toMatch(/retryItem\(img, items, idx\)/);
  });

  it('没翻出来的那一条有可辨认的样式，不静默显示为空行', () => {
    const body = grab(SRC, 'renderItems');
    expect(body).toMatch(/mxt-comic-row-failed/);
    expect(body).toMatch(/没翻出来/);
  });

  it('单条重试只裁那一块，再把框映射回整页', () => {
    const body = grab(SRC, 'retryItem');
    expect(body).toMatch(/cropForItem\(/);
    expect(body).toMatch(/crop\.map/);
    /* 映射必须是「裁剪框起点 + 局部百分比 × 裁剪框跨度」 */
    expect(body).toMatch(/m\.x1 \+ \(bx1 \/ 100\) \* \(m\.x2 - m\.x1\)/);
    expect(body).toMatch(/snapshot\(img, it\)/);
  });

  it('没有框的那一条退回整页重翻，而不是什么都不做', () => {
    const body = grab(SRC, 'retryItem');
    expect(body).toMatch(/if \(!it\.box\) \{[\s\S]*retryImage\(img\)/);
  });
});

describe('翻译过程有明确进度', () => {
  it('setMsg 不再清空译文列表', () => {
    const body = grab(SRC, 'setMsg');
    expect(body).not.toMatch(/body\.textContent = ''/);
    expect(body).toMatch(/querySelector\('\.mxt-comic-msg'\)/);
  });

  it('进度条同时给出张数、成功数、失败数与当前阶段', () => {
    const body = grab(SRC, 'updateBar');
    expect(body).toMatch(/第 \$\{state\.index \+ 1\} \/ \$\{total\} 张/);
    expect(body).toMatch(/成功 \$\{p\.ok\}/);
    expect(body).toMatch(/失败 \$\{p\.failed\}/);
    expect(body).toMatch(/state\.phase\.label/);
  });

  it('阶段带计时心跳，长时间没响应也看得出还在动', () => {
    const body = grab(SRC, 'beginPhase');
    expect(body).toMatch(/setInterval/);
    const bar = grab(SRC, 'updateBar');
    expect(bar).toMatch(/Date\.now\(\) - state\.phase\.t0/);
  });

  it('面板关着的时候异步回调不会把它弹回来', () => {
    const body = grab(SRC, 'updateBar');
    expect(body).toMatch(/classList\.contains\('mxt-comic-open'\)/);
  });

  it('批量结束会报告成功/失败张数', () => {
    const body = grab(SRC, 'translateAll');
    expect(body).toMatch(/成功 \$\{ok\} 张，失败 \$\{failed\} 张/);
  });
});

describe('译文位置可以人工调整（默认擦字版下也够得着）', () => {
  it('擦字版画完图后铺一层可操作的抓取框', () => {
    const body = grab(SRC, 'applyToImage');
    expect(body).toMatch(/paintInpainted\(img, r\.url\)/);
    const at = body.indexOf('paintInpainted(img, r.url)');
    expect(body.slice(at)).toMatch(/paintHitboxes\(img, items\)/);
  });

  it('抓取框可点击可拖、并复用同一套人工修正逻辑', () => {
    const body = grab(SRC, 'paintHitboxes');
    expect(body).toMatch(/pointerEvents: 'auto'/);
    expect(body).toMatch(/attachCorrection\(d, span, it, img, \(\) => repaintCurrent\(\)\)/);
    expect(body).toMatch(/dataset\.hit = '1'/);
  });

  it('拖完/改完会重画像素，而不是只挪 DOM', () => {
    expect(grab(SRC, 'attachCorrection')).toMatch(/onChange\('move'\)/);
    expect(grab(SRC, 'attachCorrection')).toMatch(/onChange\('text'\)/);
    expect(grab(SRC, 'repaintCurrent')).toMatch(/applyToImage\(/);
  });

  it('图片缩放后抓取框跟着重算，不会停在原位', () => {
    expect(grab(SRC, 'repositionOverlays')).toMatch(/positionHitbox\(pair\.img, pair\.el\)/);
    expect(grab(SRC, 'positionHitbox')).toMatch(/getBoundingClientRect\(\)/);
  });

  it('A± 的字号写进数据，切图回来还在', () => {
    const body = grab(SRC, 'bumpFont');
    expect(body).toMatch(/it\.manualFont = next/);
    const paint = grab(SRC, 'paintOverlays');
    expect(paint).toMatch(/it\.manualFont \?/);
  });
});

describe('原图 / 译图可切换', () => {
  it('切换只改可见性，不重新请求也不丢译文', () => {
    const body = grab(SRC, 'applyViewToggle');
    expect(body).toMatch(/visibility = state\.showOrig \? 'hidden' : ''/);
    expect(body).not.toMatch(/recognise\(/);
  });

  it('工具栏有切换按钮，且状态默认是译图', () => {
    expect(SRC).toMatch(/className = 'mxt-comic-toggle'/);
    expect(SRC).toMatch(/showOrig: false/);
  });
});

describe('操作可以取消和恢复', () => {
  it('关闭面板会停掉正在跑的批量任务', () => {
    expect(SRC).toMatch(/stopBatch\('面板已关闭，批量翻译已停止'\)/);
    const body = grab(SRC, 'stopBatch');
    expect(body).toMatch(/batch\.stop = true/);
  });

  it('清空页面同样置停止标志，后台不会继续烧额度', () => {
    const at = idx("msg.type === 'mxt:clearComic'");
    const block = SRC.slice(at, at + 400);
    expect(block).toMatch(/stopBatch\(''\)/);
    expect(block).toMatch(/resetUiState\(\)/);
  });

  it('点了停止之后回来的结果不再写进缓存', () => {
    const body = grab(SRC, 'translateAll');
    const guard = body.indexOf('if (batch.stop) return;');
    const write = body.indexOf('state.done.set(img');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(guard);
  });

  it('人工调整可撤销：改之前存快照，撤销后写回原值', () => {
    const snap = grab(SRC, 'snapshot');
    expect(snap).toMatch(/box: Array\.isArray\(it\.box\) \? it\.box\.slice\(\) : null/);
    expect(snap).toMatch(/zh: it\.zh \|\| ''/);
    const undo = grab(SRC, 'undoLast');
    expect(undo).toMatch(/it\.box = snap\.box/);
    expect(undo).toMatch(/it\.zh = snap\.zh/);
  });

  it('连续点「下一张」不会并发抢同一张图', () => {
    expect(grab(SRC, 'step')).toMatch(/if \(translating\)/);
    expect(grab(SRC, 'translateCurrent')).toMatch(/if \(translating\)/);
  });
});

describe('译图导出', () => {
  it('擦字版直接导出成品位图', () => {
    const body = grab(SRC, 'exportResult');
    expect(body).toMatch(/rec\.compositeUrl/);
    expect(body).toMatch(/a0\.download/);
  });

  it('浮层版按行文本折行，且描边用 strokeText 不再盖掉白字', () => {
    const body = grab(SRC, 'exportResult');
    expect(body).toMatch(/Array\.isArray\(l\.lines\)/);
    expect(body).toMatch(/ctx\.strokeText\(line, cx, y\)/);
    expect(body).not.toMatch(/fillStyle = 'rgba\(255,255,255,0\.92\)';\s*\n\s*ctx\.fillText/);
  });

  it('擦字重绘把排版结果交出来，导出才有数据可用', () => {
    const body = grab(SRC, 'renderTranslated');
    expect(body).toMatch(/space: 'image'/);
    expect(body).toMatch(/layouts/);
  });
});

describe('长译文溢出', () => {
  it('装不下时先把可用高度放宽一截再判溢出', () => {
    const body = grab(SRC, 'layoutH');
    expect(body).toMatch(/boxH \* 1\.35/);
    expect(body).toMatch(/expanded: true/);
  });

  it('竖排同样有放宽兜底', () => {
    expect(grab(SRC, 'layoutV')).toMatch(/expanded: true/);
  });
});
