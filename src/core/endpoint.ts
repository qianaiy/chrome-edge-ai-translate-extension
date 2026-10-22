/**
 * 翻译服务地址的信任边界。
 *
 * 这个地址是用户自己填的，也是扩展唯一会主动发请求出去的地方。它一旦被填错
 * 或被别人改掉，代价很直接：用户的 API Key、以及整页的网页正文，都会发到那个
 * 地址上去。所以这里不把它当成一个普通字符串，而是当成一条安全边界来检查。
 *
 * 检查的几件事：
 *   1. 必须是能解析的 http(s) 地址（javascript:、data:、file: 一律拒绝）
 *   2. 不许把凭证写进地址（https://user:pass@host）——URL 会进浏览器历史、
 *      崩溃报告、代理日志、Referer，写在这里等于半公开
 *   3. 公网地址必须 https。本机和局域网允许 http，因为那是用户自己的机器，
 *      而且 Ollama / LM Studio 默认就是 http；但会把 local 标出来，界面上提示
 */

/** 地址被判定的问题类型；null 表示没问题 */
export type EndpointProblem =
  | 'empty'
  | 'malformed'
  | 'not-http'
  | 'credentials-in-url'
  | 'insecure-remote'
  | null;

export interface EndpointPolicy {
  /** 能不能拿这个地址发请求 */
  ok: boolean;
  problem: EndpointProblem;
  /** 给用户看的话；ok 时为 null */
  message: string | null;
  /** 规范化后的地址；ok=false 时为空串 */
  url: string;
  /** 是不是本机 / 局域网（允许 http，且可以不填 Key） */
  local: boolean;
}

/** 私有网段与回环；这些地址上允许用 http */
const PRIVATE_V4 = [
  /^127\./, // 回环
  /^10\./, // 10.0.0.0/8
  /^192\.168\./, // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\./ // 172.16.0.0/12
];

/**
 * 判断主机名是不是本机或局域网。
 *
 * 只认主流写法，不做 DNS 解析——这里的用途是「敢不敢允许明文 http」，
 * 放过一个伪装成本地的公网域名才是真问题，宁可判为远程。
 */
export function isLocalHost(hostname: string): boolean {
  const raw = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!raw) return false;

  // IPv6 在 URL 里带方括号：[::1]
  const h = raw.replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  // 写成完整形式的回环地址
  if (h === '0:0:0:0:0:0:0:1') return true;

  // IPv4 映射的 IPv6 回环：::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : h;

  return isPrivateV4(v4);
}

/** 严格的点分四段 IPv4；不合法的写法（127.0.0.1.evil.com）不算 */
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateV4(host: string): boolean {
  const m = host.match(V4_RE);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some(o => o > 255)) return false;
  return PRIVATE_V4.some(re => re.test(host));
}

/** 去掉结尾斜杠；和 provider.ts 的 normBase 保持一致的语义 */
function norm(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * 检查一个翻译服务地址能不能用。
 *
 * 纯函数，不发请求：设置页每次输入都可以调，后台在真正发请求前再调一次。
 */
export function checkEndpoint(rawURL: string): EndpointPolicy {
  const url = norm(rawURL);
  if (!url) {
    return {
      ok: false,
      problem: 'empty',
      message: '还没有填翻译服务地址',
      url: '',
      local: false
    };
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {
      ok: false,
      problem: 'malformed',
      message: '地址格式不对，应该像 https://api.example.com/v1 这样',
      url: '',
      local: false
    };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      problem: 'not-http',
      message: '地址必须以 http:// 或 https:// 开头',
      url: '',
      local: false
    };
  }

  const local = isLocalHost(u.hostname);

  if (u.username || u.password) {
    return {
      ok: false,
      problem: 'credentials-in-url',
      message:
        '不要把 Key 写进地址：带凭证的 URL 会进浏览器历史、代理日志和崩溃报告。请把它填到 API Key 输入框。',
      url: '',
      local
    };
  }

  if (u.protocol === 'http:' && !local) {
    return {
      ok: false,
      problem: 'insecure-remote',
      message: `远程地址必须用 https://，否则 API Key 和网页内容都是明文传输（${u.hostname} 不是本机或局域网地址）`,
      url: '',
      local
    };
  }

  return { ok: true, problem: null, message: null, url, local };
}

/** 两个地址是不是同一个来源；用于识别请求被重定向到了别的站点 */
export function sameOrigin(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(String(a || ''));
    ub = new URL(String(b || ''));
  } catch {
    return false;
  }
  return ua.origin === ub.origin;
}

/** 重定向到别的站点时的提示语；null 表示同一来源，没问题 */
export function redirectWarning(requestURL: string, finalURL: string): string | null {
  if (!finalURL) return null;
  if (sameOrigin(requestURL, finalURL)) return null;
  let host = finalURL;
  try {
    host = new URL(finalURL).origin;
  } catch {
    /* 用原始字符串 */
  }
  return `翻译服务的地址被重定向到了别的站点（${host}），出于安全考虑这次结果已丢弃。请检查服务地址是否被劫持或写错。`;
}
