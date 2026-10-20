/**
 * 服务商识别 / Base URL 归一化 / 协议推断
 * ------------------------------------------------------------------
 * 纯函数，不依赖 chrome.* 与 DOM，可在 Node 里直接测试。
 */

export type Protocol = 'openai' | 'anthropic' | 'gemini';

export const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'gemini'];

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini'
};

export interface Provider {
  id: string;
  name: string;
  /** 主机名匹配 */
  host: RegExp;
  protocol: Protocol;
  /** 用户只填域名时自动补的路径 */
  path: string;
}

/** 内置服务商表。host 是主机名匹配，path 是用户只填域名时自动补的路径。 */
export const PROVIDERS: Provider[] = [
  { id: 'openai', name: 'OpenAI', host: /(^|\.)api\.openai\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'azure', name: 'Azure OpenAI', host: /\.openai\.azure\.com$/i, protocol: 'openai', path: '' },
  { id: 'deepseek', name: 'DeepSeek', host: /(^|\.)api\.deepseek\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'moonshot', name: 'Moonshot 月之暗面', host: /(^|\.)api\.moonshot\.(cn|ai)$/i, protocol: 'openai', path: '/v1' },
  { id: 'zhipu', name: '智谱 GLM', host: /(^|\.)open\.bigmodel\.cn$/i, protocol: 'openai', path: '/api/paas/v4' },
  { id: 'siliconflow', name: '硅基流动', host: /(^|\.)api\.siliconflow\.(cn|com)$/i, protocol: 'openai', path: '/v1' },
  { id: 'dashscope', name: '阿里云百炼', host: /dashscope\.aliyuncs\.com$/i, protocol: 'openai', path: '/compatible-mode/v1' },
  { id: 'volcengine', name: '火山方舟', host: /ark\.cn-beijing\.volces\.com$/i, protocol: 'openai', path: '/api/v3' },
  { id: 'qianfan', name: '百度千帆', host: /qianfan\.baidubce\.com$/i, protocol: 'openai', path: '/v2' },
  { id: 'tencent', name: '腾讯混元', host: /(^|\.)api\.hunyuan\.tencentcloudapi\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'groq', name: 'Groq', host: /(^|\.)api\.groq\.com$/i, protocol: 'openai', path: '/openai/v1' },
  { id: 'openrouter', name: 'OpenRouter', host: /(^|\.)openrouter\.ai$/i, protocol: 'openai', path: '/api/v1' },
  { id: 'together', name: 'Together AI', host: /(^|\.)api\.together\.(xyz|ai)$/i, protocol: 'openai', path: '/v1' },
  { id: 'mistral', name: 'Mistral', host: /(^|\.)api\.mistral\.ai$/i, protocol: 'openai', path: '/v1' },
  { id: 'xai', name: 'xAI Grok', host: /(^|\.)api\.x\.ai$/i, protocol: 'openai', path: '/v1' },
  { id: 'minimax', name: 'MiniMax', host: /(^|\.)api\.minimax(chat)?\.(chat|com)$/i, protocol: 'openai', path: '/v1' },
  { id: 'stepfun', name: '阶跃星辰', host: /(^|\.)api\.stepfun\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'lingyi', name: '零一万物', host: /(^|\.)api\.lingyiwanwu\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'baichuan', name: '百川智能', host: /(^|\.)api\.baichuan-ai\.com$/i, protocol: 'openai', path: '/v1' },
  { id: 'anthropic', name: 'Anthropic Claude', host: /(^|\.)api\.anthropic\.com$/i, protocol: 'anthropic', path: '' },
  { id: 'gemini', name: 'Google Gemini', host: /generativelanguage\.googleapis\.com$/i, protocol: 'gemini', path: '' },
  { id: 'ollama', name: 'Ollama 本地', host: /^(localhost|127\.0\.0\.1|\[::1\]):11434$/i, protocol: 'openai', path: '/v1' },
  { id: 'lmstudio', name: 'LM Studio 本地', host: /^(localhost|127\.0\.0\.1|\[::1\]):1234$/i, protocol: 'openai', path: '/v1' },
  { id: 'local', name: '本地接口', host: /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i, protocol: 'openai', path: '/v1' }
];

/** 去掉尾部斜杠与空白 */
export function normBase(baseURL: string): string {
  return String(baseURL || '')
    .trim()
    .replace(/\/+$/, '');
}

/** 按主机名识别服务商；识别不出返回 null */
export function detectProvider(rawURL: string): Provider | null {
  const base = normBase(rawURL);
  if (!base) return null;
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return null;
  }
  return PROVIDERS.find(p => p.host.test(host)) || null;
}

/**
 * 用户只填域名时，按服务商补上必要路径（api.deepseek.com → .../v1）。
 * 用户自己写了路径就尊重他，不动。
 */
export function resolveBase(rawURL: string): string {
  const base = normBase(rawURL);
  if (!base) return base;
  const provider = detectProvider(base);
  if (!provider || !provider.path) return base;

  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return base;
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (path && path !== '/') return base;
  return base + provider.path;
}

export interface ProtocolGuessInput {
  baseURL: string;
  model?: string;
  protocol?: string;
}

/** 启发式推断协议：显式指定 > 服务商 > 模型名前缀 */
export function guessProtocol(settings: ProtocolGuessInput): Protocol {
  const provider = detectProvider(settings.baseURL);
  if (provider && String(settings.protocol || 'auto').toLowerCase() === 'auto') {
    return provider.protocol;
  }

  const model = String(settings.model || '')
    .trim()
    .toLowerCase();
  if (/^claude/.test(model)) return 'anthropic';
  if (/^gemini/.test(model)) return 'gemini';
  return provider ? provider.protocol : 'openai';
}

/**
 * 协议尝试顺序：
 *   1. 显式指定 —— 只试这一个，不回退
 *   2. 上次成功的协议排最前
 *   3. 启发式猜的排最前，其余兜底
 */
export function protocolOrder(settings: ProtocolGuessInput, learned?: Protocol): Protocol[] {
  const explicit = String(settings.protocol || 'auto').toLowerCase();
  if ((PROTOCOLS as string[]).includes(explicit)) return [explicit as Protocol];

  const guessed = guessProtocol(settings);
  let order: Protocol[] = [guessed, ...PROTOCOLS.filter(p => p !== guessed)];
  if (learned && order.includes(learned)) {
    order = [learned, ...order.filter(p => p !== learned)];
  }
  return order;
}

export interface EndpointDescription {
  provider: string | null;
  providerName: string | null;
  protocol: Protocol;
  baseURL: string;
  resolved: string;
  endpoint: string;
}

/** 给设置页用的「这个地址到底是什么」描述 */
export function describeEndpoint(input: { baseURL: string; model?: string; protocol?: string }): EndpointDescription {
  const provider = detectProvider(input.baseURL);
  const resolved = resolveBase(input.baseURL);
  const protocol = guessProtocol(input);
  let endpoint = resolved;
  if (protocol === 'anthropic') {
    endpoint = /\/messages$/.test(resolved)
      ? resolved
      : /\/v\d+$/.test(resolved)
        ? resolved + '/messages'
        : resolved + '/v1/messages';
  } else if (protocol === 'gemini') {
    const root = resolved.replace(/\/models\/[^/]+$/i, '').replace(/\/(v1beta|v1)$/i, '');
    endpoint = root || resolved;
  } else {
    endpoint = /\/chat\/completions$/.test(resolved) ? resolved : resolved + '/chat/completions';
  }

  return {
    provider: provider?.id ?? null,
    providerName: provider?.name ?? null,
    protocol,
    baseURL: normBase(input.baseURL),
    resolved,
    endpoint
  };
}

/** 本地服务不需要 API Key */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'local']);

export interface ConfigCheck {
  /** 能不能直接开始翻译 */
  ok: boolean;
  /** 缺了什么 */
  missing: 'baseURL' | 'apiKey' | 'model' | null;
  /** 给用户看的话 */
  message: string | null;
}

/**
 * 检查配置够不够开始翻译。
 *
 * 规则（弹窗和后台必须一致，否则会出现「弹窗说没配好、后台却能翻译」的矛盾）：
 *   - baseURL 必须有
 *   - model 必须有
 *   - apiKey：远程服务必须要；本地服务（Ollama / LM Studio）可以为空
 */
export function checkConfigured(input: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}): ConfigCheck {
  const baseURL = String(input.baseURL || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const model = String(input.model || '').trim();

  if (!baseURL) {
    return {
      ok: false,
      missing: 'baseURL',
      message: '还没配好接口。点「设置」填 Base URL 和 API Key。'
    };
  }

  if (!model) {
    return { ok: false, missing: 'model', message: '还没选模型。点「设置」选一个模型。' };
  }

  const provider = detectProvider(baseURL);
  const isLocal = !!provider && LOCAL_PROVIDERS.has(provider.id);

  if (!apiKey && !isLocal) {
    return {
      ok: false,
      missing: 'apiKey',
      message: '还没填 API Key。点「设置」填一下（本地服务可以不填）。'
    };
  }

  return { ok: true, missing: null, message: null };
}

/** 这个地址是不是本地服务（本地可以不填 Key） */
export function isLocalEndpoint(baseURL: string): boolean {
  const provider = detectProvider(baseURL);
  return !!provider && LOCAL_PROVIDERS.has(provider.id);
}
