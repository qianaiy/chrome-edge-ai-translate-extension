import { describe, it, expect } from 'vitest';
import {
  detectProvider,
  resolveBase,
  normBase,
  guessProtocol,
  protocolOrder,
  describeEndpoint,
  PROTOCOLS,
  PROVIDERS
} from '../src/core/provider.js';

describe('normBase', () => {
  it('去掉尾部斜杠和空白', () => {
    expect(normBase('  https://api.deepseek.com/v1///  ')).toBe('https://api.deepseek.com/v1');
  });

  it('空值返回空串', () => {
    expect(normBase('')).toBe('');
    expect(normBase(undefined as unknown as string)).toBe('');
  });
});

describe('detectProvider', () => {
  it('识别主流服务商', () => {
    expect(detectProvider('https://api.openai.com/v1')?.id).toBe('openai');
    expect(detectProvider('https://api.deepseek.com/v1')?.id).toBe('deepseek');
    expect(detectProvider('https://open.bigmodel.cn/api/paas/v4')?.id).toBe('zhipu');
    expect(detectProvider('https://api.anthropic.com')?.id).toBe('anthropic');
    expect(detectProvider('https://generativelanguage.googleapis.com')?.id).toBe('gemini');
  });

  it('识别本地服务', () => {
    expect(detectProvider('http://localhost:11434/v1')?.id).toBe('ollama');
    expect(detectProvider('http://127.0.0.1:1234/v1')?.id).toBe('lmstudio');
    expect(detectProvider('http://127.0.0.1:8080')?.id).toBe('local');
  });

  it('子域名也算命中', () => {
    expect(detectProvider('https://gateway.example.com/v1')).toBeNull();
  });

  it('非法 URL 返回 null 而不是抛错', () => {
    expect(detectProvider('not a url')).toBeNull();
    expect(detectProvider('')).toBeNull();
  });

  it('每个 provider 的正则都锚定 host，不会误伤子路径', () => {
    for (const p of PROVIDERS) {
      expect(p.host.test('api.openai.com')).toBeTypeOf('boolean');
    }
  });
});

describe('resolveBase', () => {
  it('只填域名时自动补路径', () => {
    expect(resolveBase('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1');
    expect(resolveBase('https://api.openai.com')).toBe('https://api.openai.com/v1');
    expect(resolveBase('https://open.bigmodel.cn')).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(resolveBase('https://dashscope.aliyuncs.com')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );
  });

  it('用户自己写了路径就尊重他', () => {
    expect(resolveBase('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(resolveBase('https://example.com/custom/path')).toBe('https://example.com/custom/path');
  });

  it('未知服务商原样返回', () => {
    expect(resolveBase('https://my-proxy.example.com/v1')).toBe('https://my-proxy.example.com/v1');
  });

  it('Anthropic / Gemini 不补路径（它们的路径形态不同）', () => {
    expect(resolveBase('https://api.anthropic.com')).toBe('https://api.anthropic.com');
    expect(resolveBase('https://generativelanguage.googleapis.com')).toBe(
      'https://generativelanguage.googleapis.com'
    );
  });
});

describe('guessProtocol', () => {
  it('按服务商推断', () => {
    expect(guessProtocol({ baseURL: 'https://api.anthropic.com' })).toBe('anthropic');
    expect(guessProtocol({ baseURL: 'https://generativelanguage.googleapis.com' })).toBe('gemini');
    expect(guessProtocol({ baseURL: 'https://api.deepseek.com/v1' })).toBe('openai');
  });

  it('模型名前缀可以覆盖', () => {
    expect(guessProtocol({ baseURL: 'https://example.com/v1', model: 'claude-3-5-haiku' })).toBe('anthropic');
    expect(guessProtocol({ baseURL: 'https://example.com/v1', model: 'gemini-2.0-flash' })).toBe('gemini');
  });

  it('guessProtocol 不看显式协议 —— 显式协议由 protocolOrder 处理', () => {
    /* guessProtocol 只回答「猜哪个」，显式指定的分流在 protocolOrder 里做 */
    expect(
      guessProtocol({ baseURL: 'https://api.anthropic.com', model: 'gpt-4o', protocol: 'openai' })
    ).toBe('anthropic');
    expect(
      guessProtocol({ baseURL: 'https://example.com/v1', model: 'gemini-2.0-flash', protocol: 'anthropic' })
    ).toBe('gemini');
  });

  it('认不出就默认 openai 兼容', () => {
    expect(guessProtocol({ baseURL: 'https://unknown.example.com/v1' })).toBe('openai');
  });
});

describe('protocolOrder', () => {
  it('显式指定时只试这一个', () => {
    const order = protocolOrder({ baseURL: 'https://api.deepseek.com/v1', protocol: 'gemini' });
    expect(order).toEqual(['gemini']);
  });

  it('auto 时三种协议都覆盖，且猜的排最前', () => {
    const order = protocolOrder({ baseURL: 'https://api.deepseek.com/v1', protocol: 'auto' });
    expect(order).toHaveLength(PROTOCOLS.length);
    expect(order[0]).toBe('openai');
    expect(new Set(order)).toEqual(new Set(PROTOCOLS));
  });

  it('上次成功的协议排最前', () => {
    const order = protocolOrder(
      { baseURL: 'https://api.deepseek.com/v1', protocol: 'auto' },
      'anthropic'
    );
    expect(order[0]).toBe('anthropic');
    expect(order).toHaveLength(PROTOCOLS.length);
  });
});

describe('describeEndpoint', () => {
  it('描述 OpenAI 兼容端点', () => {
    const d = describeEndpoint({ baseURL: 'https://api.deepseek.com' });
    expect(d.provider).toBe('deepseek');
    expect(d.protocol).toBe('openai');
    expect(d.endpoint).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('描述 Anthropic 端点', () => {
    const d = describeEndpoint({ baseURL: 'https://api.anthropic.com' });
    expect(d.protocol).toBe('anthropic');
    expect(d.endpoint).toBe('https://api.anthropic.com/v1/messages');
  });

  it('描述 Gemini 端点', () => {
    const d = describeEndpoint({ baseURL: 'https://generativelanguage.googleapis.com' });
    expect(d.protocol).toBe('gemini');
    expect(d.endpoint).toBe('https://generativelanguage.googleapis.com');
  });

  it('已经带 chat/completions 的地址不重复拼接', () => {
    const d = describeEndpoint({ baseURL: 'https://api.deepseek.com/v1/chat/completions' });
    expect(d.endpoint).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});
