/**
 * 三种协议的请求构造与响应解析
 * ------------------------------------------------------------------
 * 构造：OpenAI 兼容 / Anthropic Messages / Gemini generateContent
 * 解析：不按协议认，按返回结构认 —— 三种协议的文本形状互不重叠
 */

import { resolveBase, type Protocol } from './provider.js';

/** 一条消息的内容可能是纯文本，也可能是图文混合数组 */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType?: string };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export interface TranslationSettings {
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  [k: string]: unknown;
}

export interface BuildRequestOptions {
  stream?: boolean;
  maxTokens?: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * 按协议构造一次请求。
 * @throws 当 baseURL 为空或 Gemini 地址里解析不出主机名。
 */
export function buildRequest(
  protocol: Protocol,
  settings: TranslationSettings,
  messages: Message[],
  opts: BuildRequestOptions = {}
): BuiltRequest {
  const stream = !!opts.stream;
  const maxTokens = Number(opts.maxTokens) > 0 ? Math.floor(Number(opts.maxTokens)) : 0;
  const key = String(settings.apiKey || '').trim();
  const model = String(settings.model || '').trim();
  const temperature = Number(settings.temperature ?? 0.2);
  const base = resolveBase(settings.baseURL);

  if (!base) throw new Error('还没填接口地址，先去设置页填 Base URL');

  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');

  if (protocol === 'anthropic') {
    let url: string;
    if (/\/messages$/.test(base)) url = base;
    else if (/\/v\d+$/.test(base)) url = base + '/messages';
    else url = base + '/v1/messages';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };
    if (key) {
      headers['x-api-key'] = key;
      /* 走第三方 Anthropic 兼容代理时，有些只认 Bearer */
      if (!/anthropic\.com/i.test(base)) headers.Authorization = 'Bearer ' + key;
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens || 4096,
      temperature,
      stream,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: Array.isArray(m.content)
            ? m.content.map(p =>
                p.type === 'image'
                  ? {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: p.mediaType || 'image/jpeg',
                        data: p.data
                      }
                    }
                  : { type: 'text', text: String(p.text || '') }
              )
            : String(m.content)
        }))
    };
    if (systemText) body.system = systemText;

    return { url, headers, body };
  }

  if (protocol === 'gemini') {
    const root = base
      .replace(/\/models\/[^/]+$/i, '')
      .replace(/\/(v1beta|v1)$/i, '');
    if (!root) throw new Error('Base URL 里没解析出主机名');

    const version = /\/v1$/i.test(base) && !/v1beta/i.test(base) ? 'v1' : 'v1beta';
    const cleanModel = model.replace(/^models\//, '');
    const method = stream ? 'streamGenerateContent' : 'generateContent';

    const qs: string[] = [];
    if (stream) qs.push('alt=sse');
    if (key) qs.push('key=' + encodeURIComponent(key));

    const url =
      `${root}/${version}/models/${encodeURIComponent(cleanModel)}:${method}` +
      (qs.length ? `?${qs.join('&')}` : '');

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content)
          ? m.content.map(p =>
              p.type === 'image'
                ? { inline_data: { mime_type: p.mediaType || 'image/jpeg', data: p.data } }
                : { text: String(p.text || '') }
            )
          : [{ text: String(m.content) }]
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature }
    };
    if (maxTokens) (body.generationConfig as Record<string, unknown>).maxOutputTokens = maxTokens;
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    return { url, headers: { 'Content-Type': 'application/json' }, body };
  }

  /* openai 兼容 */
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;

  return {
    url,
    headers,
    body: {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map(p =>
              p.type === 'image'
                ? { type: 'image_url', image_url: { url: `data:${p.mediaType || 'image/jpeg'};base64,${p.data}` } }
                : { type: 'text', text: String(p.text || '') }
            )
          : String(m.content)
      })),
      temperature,
      stream,
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    }
  };
}

export type ProviderResponse = Record<string, unknown>;

/**
 * 按返回结构提取文本，不依赖协议。
 * 覆盖三种形状：choices[].message.content / content[].text / candidates[].content.parts[].text
 */
export function extractText(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as ProviderResponse;

  /* OpenAI 兼容 */
  const choice = (root as any).choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) {
    const t = choice.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
    if (t) return t;
  }

  /* Anthropic Messages */
  if (Array.isArray(root.content)) {
    const t = (root.content as any[]).map(p => p?.text || '').join('');
    if (t) return t;
  }

  /* Gemini generateContent */
  const parts = (root as any).candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p: any) => p?.text || '').join('');
    if (t) return t;
  }

  return null;
}

/** 流式增量提取，形状同上但取 delta */
export function extractDelta(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const root = json as ProviderResponse;

  /* OpenAI 兼容 */
  const d = (root as any).choices?.[0]?.delta?.content;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    const t = d.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
    if (t) return t;
  }

  /* Anthropic */
  if (typeof (root as any).delta?.text === 'string') return (root as any).delta.text;

  /* Gemini */
  const parts = (root as any).candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p: any) => p?.text || '').join('');

  return '';
}

/** 构造请求时是否含图片 —— 供调用方决定要不要换多模态模型 */
export function hasImageContent(messages: Message[]): boolean {
  return messages.some(m => Array.isArray(m.content));
}
