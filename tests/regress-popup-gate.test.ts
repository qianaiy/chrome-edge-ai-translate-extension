import { describe, expect, it } from 'vitest';
import { loadBackground } from './helpers/load-background.js';
import { loadPopup } from './helpers/load-popup.js';

/**
 * 弹窗的关闭门（ADR-0007 §2.4）。
 *
 * 判据只有一条：后台归一化之后的 ok 为真才许关窗。
 * 失败/未知/没接管都要留在弹窗里把原因说清楚，而且不许自动重试。
 *
 * 注意：这里弹窗接的是真的 background（同一个 harness），不是手搓的应答。
 * 因为要修的恰恰是「弹窗看到的回执形状」这件事，手搓一个 ok:true 就把它测没了。
 */

type Dict = Record<string, any>;

interface SetupOptions {
  tabUrl?: string;
  /** 动作类消息的 frame 应答；抛错=那个 frame 没人在听 */
  frame?: (o: { frameId: number; msg: Dict }) => Dict;
  injectThrows?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const tabUrl = opts.tabUrl ?? 'https://example.com/';
  const http = /^https?:/i.test(tabUrl);
  const replies: { msg: Dict; res: Dict }[] = [];
  const injections: Dict[] = [];

  const bg = await loadBackground({
    timeoutMs: 5000,
    settings: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    exports: ['normalizeReceipt', 'sendToAllFrames', 'restrictedReason'],
    tabs: {
      get: async (id: number) => ({ id, url: tabUrl }),
      query: async () => [{ id: 1, url: tabUrl }],
      sendMessage: async (_tabId: number, msg: Dict, o?: Dict) => {
        const frameId = o?.frameId ?? 0;
        if (msg.type === 'mxt:ping') {
          if (!http) throw new Error('Receiving end does not exist');
          return { ok: true, ready: true };
        }
        if (msg.type === 'mxt:status') {
          if (!http) throw new Error('Receiving end does not exist');
          return { ok: true, translated: 0, mode: 'smart', displayMode: 'bilingual' };
        }
        return opts.frame ? opts.frame({ frameId, msg }) : { status: 'executed' };
      }
    },
    scripting: {
      executeScript: async (arg: Dict) => {
        injections.push(arg);
        if (opts.injectThrows) throw new Error('Cannot access contents of the page');
        return [];
      },
      insertCSS: async () => {}
    }
  });

  const popup = await loadPopup({
    tab: { id: 1, url: tabUrl },
    sendMessage: async (msg: Dict) => {
      const res = await bg.send(msg);
      replies.push({ msg, res });
      return res;
    }
  });

  await popup.ready();

  const replyOf = (type: string): Dict => {
    const hit = [...replies].reverse().find(r => r.msg.type === type);
    return hit ? hit.res : {};
  };

  return { bg, popup, replies, injections, replyOf };
}

describe('弹窗关闭门', () => {
  it('executed → 关窗，而且关窗依据的是归一化回执', async () => {
    const { popup, replyOf } = await setup({
      frame: ({ msg }) => (msg.type === 'mxt:togglePage' ? { status: 'executed' } : { status: 'executed' })
    });
    await popup.click('translateAll');
    expect(popup.closedCount()).toBe(1);
    const r = replyOf('mxt:tabToggle');
    expect(r.status).toBe('executed');
    expect(r.ok).toBe(true);
  });

  it('accepted + takeover → 关窗（异步任务已经开始，用户不用守着弹窗）', async () => {
    const { popup, replyOf } = await setup({
      frame: () => ({ status: 'accepted', takeover: true, message: '整页翻译已开始' })
    });
    await popup.click('translateAll');
    expect(replyOf('mxt:tabToggle').status).toBe('accepted');
    expect(popup.closedCount()).toBe(1);
  });

  it('accepted 但没人接管 → 不关窗', async () => {
    const { popup, replyOf } = await setup({ frame: () => ({ status: 'accepted' }) });
    await popup.click('translateAll');
    expect(replyOf('mxt:tabToggle').takeover).toBe(false);
    expect(popup.closedCount()).toBe(0);
    expect(popup.statusText().length).toBeGreaterThan(0);
  });

  it('受限页 → 不关窗，并把后台的理由显示出来（弹窗不再自建判定）', async () => {
    const { popup } = await setup({ tabUrl: 'chrome://settings/' });
    expect(popup.el('translateAll').disabled).toBe(true);
    expect(popup.statusText()).toContain('不允许扩展运行');
    await popup.click('translateAll');
    expect(popup.closedCount()).toBe(0);
  });

  it('主 frame 静默但注入成功 → 算接管，关窗', async () => {
    let first = true;
    const { popup, replyOf, injections } = await setup({
      frame: () => {
        if (first) {
          first = false;
          throw new Error('Receiving end does not exist');
        }
        return { ok: true };
      }
    });
    await popup.click('translateAll');
    expect(injections.length).toBe(1);
    const r = replyOf('mxt:tabToggle');
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(popup.closedCount()).toBe(1);
  });

  it('注入失败 → 不关窗，弹出真实原因，且不自动重试', async () => {
    const { popup, replies, injections } = await setup({
      frame: () => {
        throw new Error('Receiving end does not exist');
      },
      injectThrows: true
    });
    await popup.click('translateAll');
    expect(injections.length).toBe(1);
    expect(popup.closedCount()).toBe(0);
    expect(popup.statusText()).toContain('Cannot access');
    const toggles = replies.filter(r => r.msg.type === 'mxt:tabToggle');
    expect(toggles.length).toBe(1);
  });

  it('failed → 不关窗，显示 message，不自动重试', async () => {
    const { popup, replies } = await setup({
      frame: () => ({ status: 'failed', message: '页面上没找到可翻译的内容' })
    });
    await popup.click('translatePage');
    expect(popup.closedCount()).toBe(0);
    expect(popup.statusText()).toContain('没找到可翻译的内容');
    expect(replies.filter(r => r.msg.type === 'mxt:tabToggle').length).toBe(1);
  });
});