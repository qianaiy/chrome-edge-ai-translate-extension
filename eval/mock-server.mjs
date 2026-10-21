/**
 * 本地假接口 —— 用来验证评测脚本的「实时评测」这条路真的能跑通。
 * 不属于评测套件本身，只是开发时的自检工具。
 *
 * 用法：node eval/mock-server.mjs  （默认 127.0.0.1:8931）
 * 然后：MXT_BASE_URL=http://127.0.0.1:8931/v1 MXT_MODEL=mock node eval/run.mjs
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8931);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    const userMsg = (payload.messages || []).find(m => m.role === 'user')?.content || '';

    /* 照着 <<<n>>> 标记切出一段假译文，验证解析链路 */
    const segs = [];
    const re = /<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>|$)/g;
    let m;
    while ((m = re.exec(userMsg)) !== null) {
      segs.push({ n: Number(m[1]), text: m[2] });
    }

    const lines = segs.map(s => `<<<${s.n}>>>[译] ${s.text}`);
    const content = lines.join('\n');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        model: payload.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock server on http://127.0.0.1:${PORT}/v1`);
});
