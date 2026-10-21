import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRequest, redactSecrets } from '../src/core/protocol.js';
import { loadBackground } from './helpers/load-background.js';

/**
 * 安全基线：API Key 的取用与暴露面。
 *
 * 这些用例对应的都是「看起来能跑、实际上有风险」的地方：
 *   - key 拼在 URL 查询串里 → 进浏览器历史、日志、Referer、代理访问记录
 *   - key 跟着 getSettings 发给内容脚本 → 每一个翻译过的页面都能拿到
 *   - 401/403 当成「协议不对」去重试 → 三倍无意义请求，还把真错误埋掉
 */

const KEY = 'sk-secret-abc123';
const gemini = {
  baseURL: 'https://generativelanguage.googleapis.com',
  apiKey: 'AIza-test',
  model: 'gemini-2.0-flash',
  temperature: 0.2
};

const messages = [{ role: 'user' as const, content: 'hi' }];

/* ------------------------- S1：Gemini 的 key 不进 URL ------------------------- */

describe('Gemini 用请求头鉴权，不用查询串', () => {
  it('★ URL 里不再出现 key=', () => {
    const req = buildRequest('gemini', gemini, messages);
    expect(req.url).not.toContain('key=');
    expect(req.url).not.toContain('AIza-test');
  });

  it('★ key 放在 x-goog-api-key 请求头里', () => {
    const req = buildRequest('gemini', gemini, messages);
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('流式请求仍然带 alt=sse，且 key 也不进 URL', () => {
    const req = buildRequest('gemini', gemini, messages, { stream: true });
    expect(req.url).toContain('alt=sse');
    expect(req.url).not.toContain('key=');
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('没有 key 时不发 x-goog-api-key 头', () => {
    const req = buildRequest('gemini', { ...gemini, apiKey: '' }, messages);
    expect(req.headers['x-goog-api-key']).toBeUndefined();
    expect(req.url).not.toContain('key=');
  });

  it('扩展里的 buildRequest 与核心库一致：key 不进 URL', async () => {
    const bg = await loadBackground();
    const req = bg.fns.buildRequest('gemini', gemini, messages);
    expect(req.url).not.toContain('key=');
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('扩展拉模型列表时也不把 key 拼进查询串', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"models":[]}' })
    });
    await bg.fns.listModelsOnce('gemini', gemini).catch(() => {});
    expect(bg.calls).toHaveLength(1);
    expect(bg.calls[0].url).not.toContain('key=');
    expect(bg.calls[0].url).not.toContain('AIza-test');
  });
});

/* ------------------------- S3：错误信息里不留 key ------------------------- */

describe('redactSecrets', () => {
  it('把出现过的 key 换成占位符', () => {
    expect(redactSecrets(`Incorrect API key provided: ${KEY}`, KEY)).toBe(
      'Incorrect API key provided: <已隐藏>'
    );
  });

  it('同一段里的多次出现全部替换', () => {
    const out = redactSecrets(`${KEY} / ${KEY}`, KEY);
    expect(out).not.toContain(KEY);
    expect(out.match(/<已隐藏>/g)?.length).toBe(2);
  });

  it('key 为空时原样返回，不做任何替换', () => {
    expect(redactSecrets('接口 401：未授权', '')).toBe('接口 401：未授权');
  });

  it('不误伤其他文本', () => {
    expect(redactSecrets('接口 404：not found', KEY)).toBe('接口 404：not found');
  });

  it('工具函数不做正则解释（key 里有特殊字符也照替换）', () => {
    expect(redactSecrets('x a.b*c y', 'a.b*c')).toBe('x <已隐藏> y');
  });
});

/* ------------------------- S4：401/403 不再触发协议回退 ------------------------- */

describe('401 / 403 是鉴权失败，不该换协议重试', () => {
  it('★ 401 只尝试一次协议，不跑满三种', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
      })
    });
    await expect(bg.fns.chat({ ...gemini, apiKey: KEY }, messages)).rejects.toThrow();
    expect(bg.calls).toHaveLength(1);
  });

  it('★ 403 也只尝试一次', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'forbidden' } })
      })
    });
    await expect(bg.fns.chat({ ...gemini, apiKey: KEY }, messages)).rejects.toThrow();
    expect(bg.calls).toHaveLength(1);
  });

  it('★ 401 的报错要说清是 Key 的问题，并回显状态码', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
      })
    });
    const err = await bg.fns.chat({ ...gemini, apiKey: KEY }, messages).catch((e: Error) => e);
    expect(String(err.message)).toContain('401');
    expect(String(err.message)).toMatch(/Key|密钥|鉴权/i);
  });

  it('★ 上游把 key 回显在错误体里时，最终报错不含 key', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } })
      })
    });
    const err = await bg.fns.chat({ ...gemini, apiKey: KEY }, messages).catch((e: Error) => e);
    expect(String(err.message)).not.toContain(KEY);
    expect(String(err.message)).toContain('<已隐藏>');
  });

  it('404 仍然回退试满三种协议（协议形状不对才是要重试的情况）', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { message: 'not found' } })
      })
    });
    await expect(bg.fns.chat({ ...gemini, apiKey: KEY }, messages)).rejects.toThrow();
    expect(bg.calls.length).toBeGreaterThan(1);
  });

  it('400 仍然回退（可能是 body 形状不对）', async () => {
    const bg = await loadBackground({
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'bad request' } })
      })
    });
    await expect(bg.fns.chat({ ...gemini, apiKey: KEY }, messages)).rejects.toThrow();
    expect(bg.calls.length).toBeGreaterThan(1);
  });
});

/* ------------------------- S2：getSettings 不把 key 发给调用方 ------------------------- */

describe('mxt:getSettings 不把 apiKey 交给内容脚本', () => {
  it('★ 返回里没有 apiKey 字段', async () => {
    const bg = await loadBackground({
      settings: { apiKey: KEY, baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    });
    const res = await bg.send({ type: 'mxt:getSettings' });
    expect(res?.ok).toBe(true);
    expect(res.settings.apiKey).toBeUndefined();
  });

  it('★ 用 hasKey 布尔值告知「配没配 Key」', async () => {
    const bg = await loadBackground({ settings: { apiKey: KEY } });
    const res = await bg.send({ type: 'mxt:getSettings' });
    expect(res.settings.hasKey).toBe(true);
  });

  it('没配 Key 时 hasKey 为 false', async () => {
    const bg = await loadBackground({ settings: { baseURL: 'https://api.deepseek.com/v1' } });
    const res = await bg.send({ type: 'mxt:getSettings' });
    expect(res.settings.hasKey).toBe(false);
  });

  it('内容脚本要用的字段仍然都在', async () => {
    const bg = await loadBackground({
      settings: { apiKey: KEY, targetLang: '日文', displayMode: 'translated' }
    });
    const res = await bg.send({ type: 'mxt:getSettings' });
    expect(res.settings.targetLang).toBe('日文');
    expect(res.settings.displayMode).toBe('translated');
    expect(res.settings.autoDynamic).toBe(true);
  });

  it('设置页自己做翻译时后台仍然拿得到 Key（不能把功能修没了）', async () => {
    /* 后台自己读 storage，不经过 mxt:getSettings，所以收敛暴露面不影响翻译 */
    const bg = await loadBackground({ settings: { apiKey: KEY } });
    const s = await bg.fns.getSettings();
    expect(s.apiKey).toBe(KEY);
  });
});

/* ------------------------- S5：权限收窄 ------------------------- */

describe('manifest 权限收窄', () => {
  const load = async () =>
    JSON.parse(await readFile(join(process.cwd(), 'src', 'extension', 'manifest.json'), 'utf8'));

  it('★ host_permissions 不再用 <all_urls>', async () => {
    const m = await load();
    expect(m.host_permissions).not.toContain('<all_urls>');
  });

  it('★ host_permissions 只覆盖 http / https', async () => {
    const m = await load();
    expect(new Set(m.host_permissions)).toEqual(new Set(['http://*/*', 'https://*/*']));
  });

  it('★ content_scripts 的 matches 同样只覆盖 http / https', async () => {
    const m = await load();
    expect(new Set(m.content_scripts[0].matches)).toEqual(
      new Set(['http://*/*', 'https://*/*'])
    );
  });

  it('整个 manifest 里不再出现 <all_urls>', async () => {
    const raw = await readFile(join(process.cwd(), 'src', 'extension', 'manifest.json'), 'utf8');
    expect(raw).not.toContain('<all_urls>');
  });

  it('仍然保留 manifest v3 与最小权限集', async () => {
    const m = await load();
    expect(m.manifest_version).toBe(3);
    for (const p of ['storage', 'scripting', 'activeTab']) {
      expect(m.permissions).toContain(p);
    }
  });
});
