import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from './helpers/load-content.js';

/**
 * 内容脚本的回执语义（ADR-0007 的另一半）。
 *
 * 内容脚本是「动作真正发生」的地方，它必须说清楚自己是哪一种：
 * 同步做完（executed）、已经被接管（accepted + takeover）、还是失败。
 * 之前它一律回 {ok:true}，后台与弹窗只能靠猜。
 *
 * 流式翻译的收尾（port 断连）没法从外面观察结果对象，所以那两条用源码接线断言，
 * 与仓库既有的 comic-ux.test.ts 同一套做法。
 */

const CONTENT_SRC = readFileSync(join(process.cwd(), 'src', 'extension', 'content', 'content.js'), 'utf8');

/** 按函数名抠出整段源码（含 async 前缀），括号配平 */
function grab(src: string, name: string): string {
  const asAsync = src.indexOf(`async function ${name}(`);
  const start = asAsync >= 0 ? asAsync : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`content.js 里找不到 ${name}`);
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

async function load() {
  return loadContent({ file: 'content.js' });
}

describe('内容脚本回执', () => {
  it('mxt:togglePage 是 accepted + takeover，不许声称已完成', async () => {
    const h = await load();
    const r = await h.send({ type: 'mxt:togglePage', mode: 'smart' });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
    expect(r.ok).toBeUndefined();
    expect(r.message).toContain('翻译');
  });

  it('mxt:toggleDisplay 是同步换显示模式，回 executed', async () => {
    const h = await load();
    const r = await h.send({ type: 'mxt:toggleDisplay' });
    expect(r.status).toBe('executed');
    expect(typeof r.displayMode).toBe('string');
  });

  it('mxt:translateSelection 是 accepted + takeover（划词卡片后面才出结果）', async () => {
    const h = await load();
    const r = await h.send({ type: 'mxt:translateSelection', text: 'hello world' });
    expect(r.status).toBe('accepted');
    expect(r.takeover).toBe(true);
  });

  it('mxt:status 仍然是查询，保留 ok:true 但要带上 executed', async () => {
    const h = await load();
    const r = await h.send({ type: 'mxt:status' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('executed');
    expect(typeof r.translated).toBe('number');
  });

  it('mxt:ping 仍然是查询，保留 ok/ready（真实浏览器回归脚本依赖它）', async () => {
    const h = await load();
    const r = await h.send({ type: 'mxt:ping' });
    expect(r.ok).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.status).toBe('executed');
  });
});

describe('流式翻译收尾不许伪造成功', () => {
  it('streamSingle 断连时不能再交回 {ok:true}', () => {
    const body = grab(CONTENT_SRC, 'streamSingle');
    const disconnect = body.slice(body.indexOf('port.onDisconnect.addListener'));
    expect(disconnect).toContain("status: 'unknown'");
    expect(disconnect).not.toMatch(/\{\s*ok:\s*true/);
    expect(disconnect).toContain("code: 'port-closed'");
  });

  it('streamBatch 断连时也不能再交回 {ok:true}', () => {
    const body = grab(CONTENT_SRC, 'streamBatch');
    const disconnect = body.slice(body.indexOf('port.onDisconnect.addListener'));
    expect(disconnect).toContain("status: 'unknown'");
    expect(disconnect).not.toMatch(/\{\s*ok:\s*true/);
  });
});