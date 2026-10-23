/**
 * 译点 · 共享核心
 * ------------------------------------------------------------------
 * 这里是扩展里所有「与浏览器无关的纯逻辑」的集中地：
 *   - provider.ts  服务商识别 / Base URL 归一化 / 协议推断
 *   - protocol.ts  三种协议的请求体构造与响应解析
 *   - prompt.ts    翻译提示词与分段标记解析
 *   - subtitle.ts  WebVTT / SRT 解析与时间轴格式化
 *   - endpoint.ts  翻译服务地址的信任边界（协议、明文、凭证、重定向）
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
  checkEndpoint,
  isLocalHost,
  sameOrigin,
  redirectWarning,
  type EndpointProblem,
  type EndpointPolicy
} from './endpoint.js';

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
  splitInlineMarks,
  INLINE_MARK,
  MARK_RE
} from './prompt.js';

export {
  parseVtt,
  parseSrt,
  parseTime,
  parseCueTiming,
  fmtTime,
  fmtVttTime,
  fmtSrtTime,
  toVtt,
  type Cue
} from './subtitle.js';

export {
  scriptRatio,
  isTargetLanguage,
  isHanLanguage,
  scriptOfLang,
  type Script,
  type LangSample
} from './detect.js';

export {
  boxToPixels,
  adaptivePad,
  getPixel,
  setPixel,
  estimateBackground,
  eraseBox,
  eraseAll,
  readableColor,
  toCss,
  estimateTextWidth,
  fitText,
  findBubbleRegion,
  eraseBubble,
  type Box,
  type RGBA,
  type PixelBuffer,
  type FitResult,
  type BubbleRegion
} from './inpaint.js';

export {
  fnv,
  cacheKeyParts,
  translationCacheKey,
  selectGlossaryEntries,
  glossaryInstruction,
  checkGlossary,
  looksTechnical,
  type CacheKeyInput,
  type Glossary,
  type GlossaryEntry,
  type GlossaryMatch
} from './cache.js';

export {
  detectBoxSystem,
  toPercentBox,
  sanitizeVisionItems,
  mergeDuplicateBoxes,
  type BoxSystem,
  type VisionItem,
  type SanitizeResult
} from './vision-box.js';

export {
  scoreTranslation,
  summarize,
  parseModelOutput,
  effectiveLength,
  lengthRatio,
  stripCodeFence,
  LENGTH_RATIO_MIN,
  LENGTH_RATIO_MAX,
  LENGTH_RATIO_MIN_SOURCE,
  type EvalCase,
  type CaseScore,
  type Summary,
  type CheckResult,
  type CategorySummary
} from './eval.js';
