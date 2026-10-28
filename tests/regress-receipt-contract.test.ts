import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBackground } from './helpers/load-background.js';

/**
 * ADR-0007 回执契约：status 四态 + 单一归一化点。
 *
 * 这一批要修的是「把请求发出去」被当成「动作做完了」。判据必须落在后台的
 * normalizeReceipt：只有这里允许解释原始回执的语义，其它地方（popup、content）
 * 只许读派生出来的 ok。所以下面既测归一化的四态，也测「全仓只有这一处」。
 */

const BG_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'background.js'), 'utf8');
const CONTENT_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'content', 'content.js'), 'utf8');
const SUB_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'content', 'subtitle.js'), 'utf8');
const POPUP_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'popup', 'popup.js'), 'utf8');
const COMIC_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'content', 'comic.js'), 'utf8');

type Dict = Record<string, any>;

const EXPORTS = [
  'normalizeReceipt',
  'sendToAllFrames',
  'sendToTab',
  'restrictedReason',
  'injectable',
  'injectFiles',
  'runSubtitle',
  'runComic'
];

/** 后台加载失败时退化成空壳，让每条用例自己报「契约不存在」，而不是整文件报错 */
async function bg(opts: Dict = {}): Promise<Dict> {
  try {
    return (await loadBackground({ ...opts, exports: EXPORTS })) as unknown as Dict;
  } catch (e) {
    return { fns: {}, send: async () => undefined, calls: [], storage: {}, loadError: e };
  }
}

function needs(h: Dict) {
  expect(typeof h.fns?.normalizeReceipt, 'ADR-0007：后台必须有唯一的 normalizeReceipt()').toBe('function');
}

describe('normalizeReceipt 四态', () => {
  it('executed 是唯一可以当「已完成」的态', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ status: 'executed', displayMode: 'translation' });
    expect(r.status).toBe('executed');
    expect(r.ok).toBe(true);
    expect(r.takeover).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it('accepted 且已接管 → ok', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ status: 'accepted', takeover: true, message: '整页翻译已开始' });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('整页翻译已开始');
  });

  it('accepted 但没声明接管 → 不许当成成功', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ status: 'accepted' });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('旧内容脚本的 {ok:true} 只能读成 accepted + legacy，绝不是 executed', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ ok: true });
    expect(r.status).toBe('accepted');
    expect(r.warn).toBe('legacy-content');
    expect(r.code).toBe('legacy-content');
    expect(r.ok).toBe(false);
    expect(r.status).not.toBe('executed');
  });

  it('旧回执 + 本次确实注入成功 → accepted 且接管（漫画那条路径要保持 ok）', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ ok: true }, { injected: true });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.warn).toBe('legacy-content');
  });

  it('failed 的 error 是 message 的别名，且可重试', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt({ status: 'failed', message: '这个页面不允许扩展运行' });
    expect(r.status).toBe('failed');
    expect(r.message).toBe('这个页面不允许扩展运行');
    expect(r.error).toBe(r.message);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('没有回执 → unknown + no-receipt', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt(null);
    expect(r.status).toBe('unknown');
    expect(r.code).toBe('no-receipt');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('受限页不可重试', async () => {
    const h = await bg();
    needs(h);
    const r = h.fns.normalizeReceipt(null, {
      code: 'restricted-page',
      message: '这个页面不允许扩展运行（chrome:// 页面、扩展商店、PDF 阅读器都不行）'
    });
    expect(r.status).toBe('failed');
    expect(r.code).toBe('restricted-page');
    expect(r.retryable).toBe(false);
  });

  it('frames 计数由归一化点自己累加，主 frame 与子 frame 共用一份', async () => {
    const h = await bg();
    needs(h);
    const frames = { total: 0, executed: 0, failed: 0 };
    const main = h.fns.normalizeReceipt({ status: 'executed' }, { frames });
    const sub = h.fns.normalizeReceipt({ status: 'executed' }, { frames });
    const bad = h.fns.normalizeReceipt(null, { frames });
    expect(main.frames).toBe(frames);
    expect(sub.frames).toBe(frames);
    expect(bad.frames).toBe(frames);
    expect(frames.total).toBe(3);
    expect(frames.executed).toBe(2);
    expect(frames.failed).toBe(1);
  });
});

describe('sendToAllFrames 的定级', () => {
  it('主 frame 的旧回执 → accepted，不因为「有人回了」就当成做完', async () => {
    const h = await bg({ tabs: { sendMessage: async () => ({ ok: true }) } });
    needs(h);
    const r = await h.fns.sendToAllFrames(1, { type: 'mxt:togglePage' });
    expect(r.status).toBe('accepted');
    expect(r.warn).toBe('legacy-content');
    expect(r.ok).toBe(false);
  });

  it('主 frame 不回话但注入成功并拿到回执 → accepted + takeover', async () => {
    let injected = 0;
    let round = 0;
    const h = await bg({
      tabs: {
        sendMessage: async () => {
          round++;
          if (round === 1) throw new Error('Receiving end does not exist');
          return { ok: true };
        }
      },
      scripting: {
        executeScript: async () => {
          injected++;
          return [];
        }
      }
    });
    needs(h);
    const r = await h.fns.sendToAllFrames(1, { type: 'mxt:tabComic' });
    expect(injected).toBe(1);
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('注入抛错 → failed，不能假装没事', async () => {
    const h = await bg({
      tabs: { sendMessage: async () => { throw new Error('Receiving end does not exist'); } },
      scripting: { executeScript: async () => { throw new Error('Cannot access contents of the page'); } }
    });
    needs(h);
    const r = await h.fns.sendToAllFrames(1, { type: 'mxt:translateSubs' });
    expect(r.status).toBe('failed');
    expect(r.code).toBe('inject-failed');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Cannot access contents of the page');
  });

  it('受限页 → failed + restricted-page，且根本不尝试注入', async () => {
    let injected = 0;
    const h = await bg({
      tabs: {
        get: async (id: number) => ({ id, url: 'chrome://settings/' }),
        sendMessage: async () => { throw new Error('Receiving end does not exist'); }
      },
      scripting: { executeScript: async () => { injected++; return []; } }
    });
    needs(h);
    const r = await h.fns.sendToAllFrames(1, { type: 'mxt:togglePage' });
    expect(injected).toBe(0);
    expect(r.status).toBe('failed');
    expect(r.code).toBe('restricted-page');
    expect(r.retryable).toBe(false);
    expect(r.message).toContain('不允许扩展运行');
  });

  it('子 frame 的成功不能把主 frame 的静默抬成成功（waitAll 下看计数）', async () => {
    const h = await bg({
      tabs: {
        sendMessage: async (_tabId: number, _msg: unknown, opts: { frameId: number }) =>
          opts.frameId === 0 ? { status: 'accepted' } : { status: 'executed' }
      },
      webNavigation: {
        getAllFrames: async () => [
          { frameId: 0, url: 'https://example.com/' },
          { frameId: 1, url: 'https://example.com/a' },
          { frameId: 2, url: 'https://example.com/b' }
        ]
      }
    });
    needs(h);
    const r = await h.fns.sendToAllFrames(1, { type: 'mxt:togglePage' }, { waitAll: true });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.frames.total).toBe(3);
    expect(r.frames.executed).toBe(2);
  });
});

describe('归一化只有一个出处（源码扫描）', () => {
  const definedTimes = (src: string, name: string) =>
    (src.match(new RegExp(`function\\s+${name}\\s*\\(`, 'g')) || []).length;

  it('normalizeReceipt 全仓只定义一次', () => {
    const all = [BG_SRC, CONTENT_SRC, SUB_SRC, POPUP_SRC, COMIC_SRC].map(s => definedTimes(s, 'normalizeReceipt'));
    expect(all.reduce((a, b) => a + b, 0)).toBe(1);
    expect(definedTimes(BG_SRC, 'normalizeReceipt')).toBe(1);
  });

  it('语义判定 status==="executed" 只允许出现在 background 的归一化点上', () => {
    const hits = (src: string) => (src.match(/status\s*===\s*['"]executed['"]/g) || []).length;
    expect(hits(BG_SRC)).toBe(1);
    expect(hits(POPUP_SRC)).toBe(0);
    expect(hits(CONTENT_SRC)).toBe(0);
    expect(hits(SUB_SRC)).toBe(0);
  });

  it('内容脚本的每条 sendResponse 都带 status（不许再发无状态回执）', () => {
    const offenders: string[] = [];
    for (const [name, src] of [
      ['content.js', CONTENT_SRC],
      ['subtitle.js', SUB_SRC]
    ] as const) {
      let from = 0;
      for (;;) {
        const at = src.indexOf('sendResponse(', from);
        if (at < 0) break;
        from = at + 1;
        const end = src.indexOf('});', at);
        const body = src.slice(at, end < 0 ? at + 600 : end);
        if (!/status\s*:/.test(body)) offenders.push(`${name}: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('受限页判定的 URL 谓词只在 background 里出现一次', () => {
    const urlPredicate = (src: string) => (src.match(/\^https\?:/g) || []).length;
    expect(urlPredicate(POPUP_SRC)).toBe(0);
    expect(urlPredicate(BG_SRC)).toBe(1);
  });
});