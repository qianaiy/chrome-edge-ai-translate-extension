/**
 * 翻译缓存键与术语表
 * ------------------------------------------------------------------
 * 缓存键为什么不能只用原文：
 *   用户改了提示词、换了模型、加了术语表之后，旧的译文其实已经不对了，
 *   但只要原文一样就会命中旧缓存 —— 用户看到的还是老译文，
 *   还会以为是「模型没生效」。所以键里必须带上「影响译文的那些设置」。
 *
 * 术语表为什么不在这里做替换：
 *   同一个词在不同语境下译法不同，硬替换会把对的译文改错。
 *   正确做法是把命中的术语作为约束告诉模型，再对结果做针对性检查。
 */

/** 影响译文的所有设置 */
export interface CacheKeyInput {
  model: string;
  targetLang: string;
  /** 系统提示词的内容（改了就该失效） */
  prompt: string;
  /** 用户附加的要求 */
  extraPrompt?: string;
  /** 术语表版本（改了术语表就该失效） */
  glossaryVersion?: string;
  /** 原文 */
  text: string;
}

/**
 * 算缓存键。
 *
 * 用 FNV-1a：快、无依赖，够用（不是安全场景，不需要抗碰撞的哈希）。
 */
export function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + '-' + str.length.toString(36);
}

/** 把影响译文的设置拼成一个稳定的串 */
export function cacheKeyParts(input: CacheKeyInput): string {
  return [
    input.model || '',
    input.targetLang || '',
    input.prompt || '',
    input.extraPrompt || '',
    input.glossaryVersion || '',
    input.text || ''
  ].join('\u0001');
}

/** 缓存键 */
export function translationCacheKey(input: CacheKeyInput): string {
  return fnv(cacheKeyParts(input));
}

/* ------------------------------------------------------------------ *
 * 术语表
 * ------------------------------------------------------------------ */

export type GlossaryMatch = 'exact' | 'case-insensitive' | 'word';

export interface GlossaryEntry {
  /** 原文里的词 */
  source: string;
  /** 译法 */
  target: string;
  /** 怎么匹配。默认 case-insensitive */
  match?: GlossaryMatch;
  /** 什么时候才生效：global=总是，technical=只在技术类内容里 */
  scope?: 'global' | 'technical';
  /** 更高优先级的条目先匹配 */
  priority?: number;
}

export interface Glossary {
  entries: GlossaryEntry[];
  /** 改一次术语表就换一次，缓存自动失效 */
  version?: string;
}

/** 判断一段内容算不算「技术类」—— 靠特征词粗略判断，够用 */
export function looksTechnical(text: string): boolean {
  const s = String(text || '');
  if (!s.trim()) return false;
  return (
    /[{}<>]/.test(s) ||
    /\b(?:const|let|var|function|return|import|export|class|def|async|await|public|private|static)\b/.test(s) ||
    /\b\w+\([^)]*\)/.test(s) ||
    /\b[a-z]+_[a-z]+\b/.test(s) ||
    /https?:\/\//.test(s) ||
    /=>|::|\$[A-Za-z_]/.test(s) ||
    /\b(?:npm|yarn|pnpm|git|docker|kubectl|curl|apt|pip|node|python|api|json|xml|yaml|sql|html|css|javascript|typescript|py|go|rust|java)\b/i.test(
      s
    )
  );
}

/**
 * 从术语表里挑出这一批文本该用的术语。
 *
 * 只挑命中的 —— 整本词典塞进每次请求既费 token 又干扰模型。
 */
export function selectGlossaryEntries(
  glossary: Glossary | null | undefined,
  text: string,
  scope: 'global' | 'technical' = 'global'
): GlossaryEntry[] {
  if (!glossary || !Array.isArray(glossary.entries) || !glossary.entries.length) return [];
  const s = String(text || '');
  if (!s) return [];

  const tech = scope === 'technical' || looksTechnical(s);
  const hits: GlossaryEntry[] = [];

  for (const e of glossary.entries) {
    if (!e || !e.source || !e.target) continue;
    /* 只在技术语境生效的条目，非技术内容里不用 */
    if (e.scope === 'technical' && !tech) continue;

    const match = e.match || 'case-insensitive';
    let found = false;
    if (match === 'exact') {
      found = s.includes(e.source);
    } else if (match === 'word') {
      /* 整词匹配，避免 "app" 命中 "apple" */
      const re = new RegExp(`\\b${escapeRegExp(e.source)}\\b`, 'i');
      found = re.test(s);
    } else {
      found = s.toLowerCase().includes(e.source.toLowerCase());
    }
    if (found) hits.push(e);
  }

  /* 优先级高的先排，模型看到的顺序也就更符合预期 */
  hits.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return hits;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把命中的术语整理成可以拼进系统提示词的一段话。
 *
 * 用的是「约束」而不是「替换」——
 * 告诉模型这些词该这么译，让模型结合上下文处理，
 * 比事后用字符串替换安全得多。
 */
export function glossaryInstruction(entries: GlossaryEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map(e => `- ${e.source} → ${e.target}`);
  return [
    '以下是本批文本中必须用到的术语（只译这些词，其余照常翻译）：',
    ...lines
  ].join('\n');
}

/**
 * 检查译文里该用的术语有没有被用上。
 *
 * 用来在评测和调试时发现「术语表没生效」。
 *
 * @param source 原文 —— 用来判断这个术语原文里到底有没有出现。
 *                 没出现的话，译文里没有它是正常的，不该算失败。
 */
export function checkGlossary(
  entries: GlossaryEntry[],
  source: string,
  translation: string
): { source: string; expected: string; ok: boolean; inSource: boolean }[] {
  const src = String(source || '');
  const out = String(translation || '');
  return entries.map(e => {
    const inSource = src.toLowerCase().includes(e.source.toLowerCase());
    return {
      source: e.source,
      expected: e.target,
      /* 原文里没有的词，译文里没有也不算错 */
      ok: !inSource || out.includes(e.target),
      inSource
    };
  });
}
