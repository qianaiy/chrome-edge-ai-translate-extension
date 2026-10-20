import { describe, it, expect } from 'vitest';
import { checkConfigured, isLocalEndpoint } from '../src/core/provider.js';

describe('checkConfigured', () => {
  it('三样都齐了才算配置好', () => {
    const r = checkConfigured({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-xxx',
      model: 'deepseek-chat'
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toBeNull();
    expect(r.message).toBeNull();
  });

  it('缺 baseURL 给出 baseURL 的提示', () => {
    const r = checkConfigured({ baseURL: '', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('baseURL');
    expect(r.message).toContain('Base URL');
  });

  it('缺 model 给出 model 的提示', () => {
    const r = checkConfigured({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'k', model: '' });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('model');
  });

  it('远程服务缺 API Key 时提示', () => {
    const r = checkConfigured({ baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('apiKey');
    expect(r.message).toContain('API Key');
  });

  it('本地服务可以不填 API Key', () => {
    for (const base of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:8080']) {
      const r = checkConfigured({ baseURL: base, apiKey: '', model: 'qwen2.5:7b' });
      expect(r.ok, base).toBe(true);
      expect(r.missing, base).toBeNull();
    }
  });

  it('未知服务商按远程处理，缺 Key 会提示', () => {
    const r = checkConfigured({
      baseURL: 'https://my-proxy.example.com/v1',
      apiKey: '',
      model: 'some-model'
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('apiKey');
  });

  it('空白字符串等同于没填', () => {
    const r = checkConfigured({ baseURL: '   ', apiKey: '  ', model: '  ' });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe('baseURL');
  });
});

describe('isLocalEndpoint', () => {
  it('认出本地服务', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:8080')).toBe(true);
  });

  it('远程服务不算本地', () => {
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(isLocalEndpoint('https://example.com')).toBe(false);
    expect(isLocalEndpoint('')).toBe(false);
  });
});
