import { describe, it, expect } from 'vitest';
import {
  buildRequest,
  extractText,
  extractDelta,
  type Message,
  type TranslationSettings
} from '../src/core/protocol.js';

/** body 是 Record<string, unknown>，取消息数组时统一走这个 helper */
function messagesOf(body: Record<string, unknown>): { role: string; content: unknown }[] {
  return body.messages as { role: string; content: unknown }[];
}

function generationConfigOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.generationConfig as Record<string, unknown>;
}

const openaiSettings: TranslationSettings = {
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-key',
  model: 'deepseek-chat',
  temperature: 0.3
};

const anthropicSettings: TranslationSettings = {
  baseURL: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-3-5-haiku',
  temperature: 0.3
};

const geminiSettings: TranslationSettings = {
  baseURL: 'https://generativelanguage.googleapis.com',
  apiKey: 'AIza-test',
  model: 'gemini-2.0-flash',
  temperature: 0.3
};

describe('buildRequest · openai 兼容', () => {
  it('地址补上 /chat/completions', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('地址已经带 /chat/completions 时不重复拼接', () => {
    const req = buildRequest(
      'openai',
      { ...openaiSettings, baseURL: 'https://api.deepseek.com/v1/chat/completions' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(req.url.match(/chat\/completions/g)?.length).toBe(1);
  });

  it('有 apiKey 时带 Authorization: Bearer', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('apiKey 为空时不带 Authorization', () => {
    const req = buildRequest(
      'openai',
      { ...openaiSettings, apiKey: '' },
      [{ role: 'user', content: 'hi' }]
    );
    expect('Authorization' in req.headers).toBe(false);
  });

  it('apiKey 只有空白时同样不带 Authorization', () => {
    const req = buildRequest(
      'openai',
      { ...openaiSettings, apiKey: '   ' },
      [{ role: 'user', content: 'hi' }]
    );
    expect('Authorization' in req.headers).toBe(false);
  });

  it('body 含 model / messages / temperature', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.body.model).toBe('deepseek-chat');
    expect(req.body.temperature).toBe(0.3);
    expect(messagesOf(req.body)).toHaveLength(1);
    expect(messagesOf(req.body)[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('system 消息留在 messages[] 里', () => {
    const req = buildRequest('openai', openaiSettings, [
      { role: 'system', content: '你是翻译' },
      { role: 'user', content: 'hi' }
    ]);
    const msgs = messagesOf(req.body);
    expect(msgs.map(m => m.role)).toEqual(['system', 'user']);
    expect(msgs[0].content).toBe('你是翻译');
    expect('system' in req.body).toBe(false);
  });

  it('没给 temperature 时用默认 0.2', () => {
    const req = buildRequest(
      'openai',
      { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.body.temperature).toBe(0.2);
  });

  it('图片消息转成 image_url 的 data URL', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', data: 'QUJD', mediaType: 'image/jpeg' }
        ]
      }
    ];
    const req = buildRequest('openai', openaiSettings, messages);
    const parts = messagesOf(req.body)[0].content as { type: string; image_url?: { url: string } }[];
    expect(parts[0]).toEqual({ type: 'text', text: '这是什么' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,QUJD' }
    });
  });

  it('图片没写 mediaType 时默认 image/jpeg', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'image', data: 'QUJD' }] }
    ];
    const req = buildRequest('openai', openaiSettings, messages);
    const parts = messagesOf(req.body)[0].content as { image_url: { url: string } }[];
    expect(parts[0].image_url.url).toBe('data:image/jpeg;base64,QUJD');
  });

  it('给了 maxTokens 时 body 带 max_tokens', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }], {
      maxTokens: 512
    });
    expect(req.body.max_tokens).toBe(512);
  });

  it('没给 maxTokens 时不带 max_tokens', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }]);
    expect('max_tokens' in req.body).toBe(false);
  });
});

describe('buildRequest · anthropic', () => {
  it('裸域名补成 <base>/v1/messages', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('base 已经以 /v1 结尾时只补 /messages', () => {
    const req = buildRequest(
      'anthropic',
      { ...anthropicSettings, baseURL: 'https://api.anthropic.com/v1' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('base 已经以 /messages 结尾时保持原样', () => {
    const req = buildRequest(
      'anthropic',
      { ...anthropicSettings, baseURL: 'https://api.anthropic.com/v1/messages' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('带 x-api-key 与 anthropic-version 头', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('官方域名下不加 Bearer', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect('Authorization' in req.headers).toBe(false);
  });

  it('第三方代理域名下额外加 Bearer', () => {
    const req = buildRequest(
      'anthropic',
      { ...anthropicSettings, baseURL: 'https://proxy.example.com/v1' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toBe('https://proxy.example.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers.Authorization).toBe('Bearer sk-ant-test');
  });

  it('system 消息被提到 body.system，并从 messages[] 里移除', () => {
    const req = buildRequest('anthropic', anthropicSettings, [
      { role: 'system', content: '你是翻译' },
      { role: 'user', content: 'hi' }
    ]);
    expect(req.body.system).toBe('你是翻译');
    const msgs = messagesOf(req.body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs.some(m => m.role === 'system')).toBe(false);
  });

  it('没有 system 消息时 body 里没有 system 字段', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect('system' in req.body).toBe(false);
  });

  it('给了 maxTokens 时 body 带 max_tokens', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }], {
      maxTokens: 1024
    });
    expect(req.body.max_tokens).toBe(1024);
  });

  it('没给 maxTokens 时用兜底 4096', () => {
    const req = buildRequest('anthropic', anthropicSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.body.max_tokens).toBe(4096);
  });
});

describe('buildRequest · gemini', () => {
  it('URL 是 <root>/v1beta/models/<model>:generateContent', () => {
    const req = buildRequest('gemini', geminiSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
    );
  });

  it('有 apiKey 时查询串带 key', () => {
    const req = buildRequest('gemini', geminiSettings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toContain('?key=AIza-test');
  });

  it('apiKey 为空时查询串没有 key', () => {
    const req = buildRequest(
      'gemini',
      { ...geminiSettings, apiKey: '' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).not.toContain('key=');
  });

  it('apiKey 会被 URL 编码', () => {
    const req = buildRequest(
      'gemini',
      { ...geminiSettings, apiKey: 'a b&c' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toContain('key=a%20b%26c');
  });

  it('base 以 /v1beta 结尾时不会重复拼路径', () => {
    const req = buildRequest(
      'gemini',
      { ...geminiSettings, baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
    );
    expect(req.url).not.toContain('/v1beta/v1beta/');
  });

  it('base 以 /v1 结尾时用 v1 版本', () => {
    const req = buildRequest(
      'gemini',
      { ...geminiSettings, baseURL: 'https://generativelanguage.googleapis.com/v1' },
      [{ role: 'user', content: 'hi' }]
    );
    expect(req.url).toContain(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent'
    );
    expect(req.url).not.toContain('/v1/v1/');
  });

  it('流式用 :streamGenerateContent 和 alt=sse', () => {
    const req = buildRequest('gemini', geminiSettings, [{ role: 'user', content: 'hi' }], {
      stream: true
    });
    expect(req.url).toContain(':streamGenerateContent');
    expect(req.url).toContain('alt=sse');
    expect(req.url).not.toContain(':generateContent');
  });

  it('assistant 角色映射成 model，system 映射成 systemInstruction', () => {
    const req = buildRequest('gemini', geminiSettings, [
      { role: 'system', content: '你是翻译' },
      { role: 'assistant', content: '上一轮译文' },
      { role: 'user', content: 'hi' }
    ]);
    const contents = req.body.contents as { role: string; parts: unknown }[];
    expect(contents.map(c => c.role)).toEqual(['model', 'user']);
    expect(req.body.systemInstruction).toEqual({ parts: [{ text: '你是翻译' }] });
  });

  it('图片消息转成 inline_data 部件', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image', data: 'QUJD', mediaType: 'image/png' }
        ]
      }
    ];
    const req = buildRequest('gemini', geminiSettings, messages);
    const contents = req.body.contents as { parts: unknown }[];
    expect(contents[0].parts).toEqual([
      { text: '这是什么' },
      { inline_data: { mime_type: 'image/png', data: 'QUJD' } }
    ]);
  });

  it('给了 maxTokens 时进 generationConfig.maxOutputTokens', () => {
    const req = buildRequest('gemini', geminiSettings, [{ role: 'user', content: 'hi' }], {
      maxTokens: 256
    });
    expect(generationConfigOf(req.body).maxOutputTokens).toBe(256);
    expect(generationConfigOf(req.body).temperature).toBe(0.3);
  });

  it('没给 maxTokens 时 generationConfig 里没有 maxOutputTokens', () => {
    const req = buildRequest('gemini', geminiSettings, [{ role: 'user', content: 'hi' }]);
    expect('maxOutputTokens' in generationConfigOf(req.body)).toBe(false);
  });
});

describe('buildRequest · 通用', () => {
  it('baseURL 为空时抛错', () => {
    expect(() =>
      buildRequest('openai', { baseURL: '', model: 'gpt-4o' }, [{ role: 'user', content: 'hi' }])
    ).toThrow();
  });

  it('baseURL 只有空白时也抛错', () => {
    expect(() =>
      buildRequest(
        'openai',
        { baseURL: '   ', model: 'gpt-4o' },
        [{ role: 'user', content: 'hi' }]
      )
    ).toThrow();
  });

  it('stream 为 false 时 openai body 里 stream=false', () => {
    const req = buildRequest('openai', openaiSettings, [{ role: 'user', content: 'hi' }], {
      stream: false
    });
    expect(req.body.stream).toBe(false);
  });
});

describe('extractText', () => {
  it('识别 OpenAI 形状', () => {
    expect(extractText({ choices: [{ message: { content: 'x' } }] })).toBe('x');
  });

  it('识别 Anthropic 形状', () => {
    expect(extractText({ content: [{ text: 'x' }] })).toBe('x');
  });

  it('识别 Gemini 形状', () => {
    expect(extractText({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })).toBe('x');
  });

  it('OpenAI 的 content 是字符串数组时拼接', () => {
    expect(extractText({ choices: [{ message: { content: ['a', 'b'] } }] })).toBe('ab');
  });

  it('OpenAI 的 content 是分块数组时取 text 拼接', () => {
    expect(extractText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe(
      'ab'
    );
  });

  it('未知形状返回 null', () => {
    expect(extractText({ foo: 'bar' })).toBeNull();
    expect(extractText({})).toBeNull();
    expect(extractText(null)).toBeNull();
    expect(extractText('字符串不是对象')).toBeNull();
  });
});

describe('extractDelta', () => {
  it('识别 OpenAI 的 delta.content', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'x' } }] })).toBe('x');
  });

  it('识别 Anthropic 的 delta.text', () => {
    expect(extractDelta({ delta: { text: 'x' } })).toBe('x');
  });

  it('识别 Gemini 的 candidates 结构', () => {
    expect(extractDelta({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })).toBe('x');
  });

  it('未知形状返回空串', () => {
    expect(extractDelta({ foo: 'bar' })).toBe('');
    expect(extractDelta({})).toBe('');
    expect(extractDelta(null)).toBe('');
  });
});
