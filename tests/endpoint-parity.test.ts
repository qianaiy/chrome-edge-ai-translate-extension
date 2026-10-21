import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEndpoint, isLocalHost, redirectWarning, sameOrigin } from '../src/core/endpoint.js';

/**
 * 扩展是普通 JS，不能 import TS 核心，所以两边各有一份实现。
 * 这个测试把 background.js 里那段实现抠出来，和核心库跑同一批输入比对 ——
 * 一旦有人只改了一边，这里就会炸。
 */
function loadExtensionEndpoint() {
  const src = readFileSync(join(process.cwd(), 'src', 'extension', 'background.js'), 'utf8');

  const start = src.indexOf('/* ---------------------- 地址信任边界');
  expect(start, 'background.js 里应该有「地址信任边界」小节').toBeGreaterThan(-1);

  const end = src.indexOf('function sameOrigin(', start);
  expect(end, '地址信任边界小节应该以 sameOrigin 结束').toBeGreaterThan(start);

  const block = src.slice(start, end);
  const factory = new Function(`${block}\nreturn { checkEndpoint, isLocalHost };`);
  return factory() as {
    checkEndpoint: typeof checkEndpoint;
    isLocalHost: typeof isLocalHost;
  };
}

const ext = loadExtensionEndpoint();

const HOSTS = [
  'localhost',
  'LOCALHOST',
  'app.localhost',
  'localhost.evil.com',
  'evil-localhost',
  '127.0.0.1',
  '127.0.0.1.evil.com',
  '127.1.2.3',
  '127.255.255.254',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '10.0.0.1',
  '192.168.1.50',
  '172.16.0.1',
  '172.31.255.255',
  '172.32.0.1',
  '172.15.0.1',
  '8.8.8.8',
  '256.1.1.1',
  'api.deepseek.com',
  '',
  '   '
];

const URLS = [
  '',
  '   ',
  'api.example.com/v1',
  'javascript:alert(1)',
  'data:text/html,x',
  'file:///c:/x',
  'ftp://example.com',
  'https://api.deepseek.com/v1',
  'https://api.deepseek.com/v1/',
  'http://api.deepseek.com/v1',
  'http://localhost:11434',
  'http://127.0.0.1:1234',
  'http://[::1]:11434',
  'http://192.168.1.50:1234',
  'http://10.1.2.3:8000',
  'http://172.16.0.9:8000',
  'http://172.32.0.9:8000',
  'https://localhost:8443',
  'http://LOCALHOST:11434',
  'https://user:pass@api.example.com/v1',
  'https://user@api.example.com/v1',
  'http://user:pass@127.0.0.1:8000'
];

describe('isLocalHost：扩展与核心一致', () => {
  it('每个主机名的判定都相同', () => {
    for (const host of HOSTS) {
      expect(ext.isLocalHost(host), `host=${JSON.stringify(host)}`).toBe(isLocalHost(host));
    }
  });
});

describe('checkEndpoint：扩展与核心一致', () => {
  it('每个地址的判定、问题类型、提示语都相同', () => {
    for (const url of URLS) {
      const a = checkEndpoint(url);
      const b = ext.checkEndpoint(url);
      expect(b.ok, `url=${JSON.stringify(url)}`).toBe(a.ok);
      expect(b.problem, `url=${JSON.stringify(url)}`).toBe(a.problem);
      expect(b.message, `url=${JSON.stringify(url)}`).toBe(a.message);
      expect(b.url, `url=${JSON.stringify(url)}`).toBe(a.url);
      expect(b.local, `url=${JSON.stringify(url)}`).toBe(a.local);
    }
  });
});

describe('重定向判定的语义', () => {
  it('同源不报警，跨源报警', () => {
    expect(redirectWarning('https://a.com/x', 'https://a.com/y')).toBeNull();
    expect(sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(redirectWarning('https://a.com/x', 'https://evil.net/x')).not.toBeNull();
    expect(sameOrigin('https://a.com/x', 'https://evil.net/x')).toBe(false);
  });
});
