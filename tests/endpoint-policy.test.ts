import { describe, expect, it } from 'vitest';
import { checkEndpoint, isLocalHost, redirectWarning, sameOrigin } from '../src/core/endpoint.js';

describe('isLocalHost', () => {
  it('把 localhost 的各种写法当作本机', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('LOCALHOST')).toBe(true);
    expect(isLocalHost('  localhost  ')).toBe(true);
    expect(isLocalHost('app.localhost')).toBe(true);
  });

  it('认得 IPv4 回环的整个 127/8 段', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('127.1.2.3')).toBe(true);
    expect(isLocalHost('127.255.255.254')).toBe(true);
  });

  it('认得 IPv6 回环，带方括号也能认', () => {
    expect(isLocalHost('::1')).toBe(true);
    expect(isLocalHost('[::1]')).toBe(true);
    expect(isLocalHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLocalHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('认得三个私有网段', () => {
    expect(isLocalHost('10.0.0.1')).toBe(true);
    expect(isLocalHost('10.255.255.255')).toBe(true);
    expect(isLocalHost('192.168.1.50')).toBe(true);
    expect(isLocalHost('192.168.255.255')).toBe(true);
    expect(isLocalHost('172.16.0.1')).toBe(true);
    expect(isLocalHost('172.31.255.255')).toBe(true);
  });

  it('172.32 已经出了私有网段', () => {
    expect(isLocalHost('172.32.0.1')).toBe(false);
    expect(isLocalHost('172.15.0.1')).toBe(false);
  });

  it('公网地址不是本机', () => {
    expect(isLocalHost('8.8.8.8')).toBe(false);
    expect(isLocalHost('api.deepseek.com')).toBe(false);
    expect(isLocalHost('example.com')).toBe(false);
  });

  it('伪装成本地的域名不算本机', () => {
    // 关键：只按主机名后缀匹配 localhost 会和 localhost.evil.com 混淆
    expect(isLocalHost('localhost.evil.com')).toBe(false);
    expect(isLocalHost('evil-localhost')).toBe(false);
    expect(isLocalHost('127.0.0.1.evil.com')).toBe(false);
  });

  it('空值不是本机', () => {
    expect(isLocalHost('')).toBe(false);
    expect(isLocalHost('   ')).toBe(false);
  });
});

describe('checkEndpoint 基本形态', () => {
  it('没填地址时给出明确提示，而不是等到发请求才报错', () => {
    const r = checkEndpoint('');
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('empty');
    expect(r.message).toContain('翻译服务地址');
    expect(r.url).toBe('');
  });

  it('纯空白按没填处理', () => {
    expect(checkEndpoint('   ').problem).toBe('empty');
  });

  it('解析不了的地址判为格式错误', () => {
    const r = checkEndpoint('api.example.com/v1');
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('malformed');
    expect(r.message).toContain('https://');
  });

  it('非 http(s) 协议一律拒绝', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///c:/x', 'ftp://example.com']) {
      const r = checkEndpoint(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.problem, bad).toBe('not-http');
    }
  });

  it('正常 https 地址通过，并去掉结尾斜杠', () => {
    const r = checkEndpoint('https://api.deepseek.com/v1/');
    expect(r.ok).toBe(true);
    expect(r.problem).toBeNull();
    expect(r.message).toBeNull();
    expect(r.url).toBe('https://api.deepseek.com/v1');
    expect(r.local).toBe(false);
  });

  it('前后空白不影响判定', () => {
    expect(checkEndpoint('  https://api.deepseek.com  ').url).toBe('https://api.deepseek.com');
  });
});

describe('checkEndpoint 凭证不进地址', () => {
  it('拒绝把账号密码写进 URL', () => {
    const r = checkEndpoint('https://user:pass@api.example.com/v1');
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('credentials-in-url');
    expect(r.message).toContain('API Key 输入框');
  });

  it('只有用户名也拒绝', () => {
    expect(checkEndpoint('https://user@api.example.com/v1').problem).toBe('credentials-in-url');
  });

  it('本机地址里带凭证同样拒绝', () => {
    // 凭证进 URL 的问题和地址是不是本地无关
    expect(checkEndpoint('http://user:pass@127.0.0.1:8000').problem).toBe('credentials-in-url');
  });

  it('凭证检查优先于明文检查', () => {
    // http + 公网 + 带凭证时，应该先提示「别把 Key 写进地址」这条更具体的
    expect(checkEndpoint('http://user:pass@api.example.com').problem).toBe('credentials-in-url');
  });
});

describe('checkEndpoint 明文边界', () => {
  it('公网 http 拒绝，并说明原因', () => {
    const r = checkEndpoint('http://api.deepseek.com/v1');
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('insecure-remote');
    expect(r.message).toContain('https');
  });

  it('本机 http 允许（Ollama / LM Studio 的默认形态）', () => {
    for (const ok of [
      'http://localhost:11434',
      'http://127.0.0.1:1234',
      'http://127.1.2.3:8080',
      'http://[::1]:11434'
    ]) {
      const r = checkEndpoint(ok);
      expect(r.ok, ok).toBe(true);
      expect(r.local, ok).toBe(true);
    }
  });

  it('局域网 http 允许，并标记为 local', () => {
    for (const ok of ['http://192.168.1.50:1234', 'http://10.1.2.3:8000', 'http://172.16.0.9:8000']) {
      const r = checkEndpoint(ok);
      expect(r.ok, ok).toBe(true);
      expect(r.local, ok).toBe(true);
    }
  });

  it('局域网之外的内网段仍按公网处理', () => {
    expect(checkEndpoint('http://172.32.0.9:8000').problem).toBe('insecure-remote');
    expect(checkEndpoint('http://11.0.0.1:8000').problem).toBe('insecure-remote');
  });

  it('本机 https 也允许', () => {
    expect(checkEndpoint('https://localhost:8443').ok).toBe(true);
  });

  it('主机名大小写不影响判定', () => {
    expect(checkEndpoint('http://LOCALHOST:11434').ok).toBe(true);
  });
});

describe('sameOrigin', () => {
  it('协议、主机、端口都一样才算同源', () => {
    expect(sameOrigin('https://a.com/v1', 'https://a.com/v2')).toBe(true);
    expect(sameOrigin('https://a.com/v1', 'https://a.com:8443/v1')).toBe(false);
    expect(sameOrigin('https://a.com/v1', 'http://a.com/v1')).toBe(false);
    expect(sameOrigin('https://a.com/v1', 'https://b.a.com/v1')).toBe(false);
  });

  it('解析不了就当作不同源（失败关闭）', () => {
    expect(sameOrigin('not a url', 'https://a.com')).toBe(false);
    expect(sameOrigin('https://a.com', '')).toBe(false);
  });
});

describe('redirectWarning', () => {
  it('同一来源不提示', () => {
    expect(redirectWarning('https://a.com/v1/chat/completions', 'https://a.com/v1/chat/completions')).toBeNull();
  });

  it('没有最终地址时不提示', () => {
    expect(redirectWarning('https://a.com/v1', '')).toBeNull();
  });

  it('跨站重定向要明确报出来并带上目标站点', () => {
    const msg = redirectWarning('https://a.com/v1/x', 'https://evil.example.net/x');
    expect(msg).not.toBeNull();
    expect(msg).toContain('https://evil.example.net');
    expect(msg).toContain('已丢弃');
  });

  it('最终地址解析不了时退回显示原始字符串', () => {
    const msg = redirectWarning('https://a.com/v1/x', 'weird-value');
    expect(msg).not.toBeNull();
    expect(msg).toContain('weird-value');
  });
});
