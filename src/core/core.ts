/**
 * 译点 · 共享核心
 * ------------------------------------------------------------------
 * 这里是扩展里所有「与浏览器无关的纯逻辑」的集中地：
 *   - provider.ts  服务商识别 / Base URL 归一化 / 协议推断
 *   - protocol.ts  三种协议的请求体构造与响应解析
 *   - prompt.ts    翻译提示词与分段标记解析
 *   - subtitle.ts  WebVTT / SRT 解析与时间轴格式化
 *
 * 设计约束：
 *   1. 不引用任何 chrome.* API —— 这样能在 Node 里直接跑单元测试。
 *   2. 不引用 DOM —— content 脚本要用的话自己负责。
 *   3. 单一导出入口 core.ts，方便后台和内容脚本共用。
 */

export {
  PROTOCOLS,
  PROTOCOL_LABEL,
  PROVIDERS,
  type Protocol,
  type Provider,
  detectProvider,
  resolveBase,
  normBase,
  guessProtocol,
  protocolOrder,
  describeEndpoint,
  checkConfigured,
  isLocalEndpoint,
  type ConfigCheck
} from './provider.js';

export {
  buildRequest,
  extractText,
  extractDelta,
  type BuildRequestOptions,
  type BuiltRequest,
  type ProviderResponse
} from './protocol.js';

export {
  systemPrompt,
  systemPromptSingle,
  parseMarked,
  stripMarkers,
  MARK_RE
} from './prompt.js';

export {
  parseVtt,
  parseSrt,
  parseTime,
  fmtTime,
  fmtSrtTime,
  toVtt,
  type Cue
} from './subtitle.js';
