/**
 * 翻译提示词与分段标记解析
 * ------------------------------------------------------------------
 * 批量翻译用 <<<n>>> 标记把多段文本塞进一次请求，靠标记切回每一段。
 * 模型不听话时由调用方退回「逐条重试」，见 parseMarked 的 null 语义。
 */

export interface PromptSettings {
  targetLang: string;
  extraPrompt?: string;
}

/** 单段翻译（划词翻译）用的提示词 */
export function systemPromptSingle(s: PromptSettings): string {
  const extra = String(s.extraPrompt || '').trim();
  const lines = [
    `你是专业翻译。把用户给出的一段文本翻译成${s.targetLang}。`,
    '要求：只输出译文本身，不要编号、不要解释、不要加引号、不要复述原文。',
    '保持原文语气与术语；代码、URL、变量名、占位符原样保留。',
    '若原文已是目标语言，直接原样输出。'
  ];
  if (extra) lines.push(`额外要求：${extra}`);
  return lines.join('\n');
}

/** 批量翻译用的提示词 */
export function systemPrompt(s: PromptSettings): string {
  const extra = String(s.extraPrompt || '').trim();
  const lines = [
    `你是专业翻译。把用户给出的每一段文本翻译成${s.targetLang}。`,
    '严格遵守：',
    '1. 输出必须沿用输入的编号标记 <<<n>>>，每段译文前一个，数量和顺序都不能变。',
    '2. 只输出译文，不要解释、不要加引号、不要拆分或合并段落。',
    '3. 保持原文语气与术语统一；技术内容按行业惯例翻译，不要生硬直译。',
    '4. 代码、命令、URL、邮箱、变量名、占位符（如 %s、{name}、<tag>）保持原样。',
    '5. 数字加单位（如 25 MB）、HTML 实体（如 &amp; &nbsp; &mdash;）也保持原样，不要换算、不要解码。',
    '6. 某段本身已是目标语言、或只是数字/符号，就原样返回该段，一个字都不要改。',
    '7. 每一段都必须真的翻译：哪怕原文很短、像命令或技术名词，也要给出目标语言的版本，不要把原文原样抄回来。',
    '8. 原文里形如 {{1}}、{{2}} 的标记表示分段位置，必须原样保留、顺序不变，只翻译标记后面的文字。'
  ];
  if (extra) lines.push(`额外要求：${extra}`);
  return lines.join('\n');
}

export const MARK_RE = /<<<\s*(\d+)\s*>>>([\s\S]*?)(?=<<<\s*\d+\s*>>>|$)/g;

/**
 * 解析带编号标记的返回。
 * @returns 长度恒为 count 的数组；无法解析的段为 null（表示需要重试）。
 */
export function parseMarked(text: string, count: number): (string | null)[] {
  const out: (string | null)[] = new Array(count).fill(null);
  MARK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_RE.exec(text)) !== null) {
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < count) {
      const v = m[2].trim();
      if (v) out[i] = v;
    }
  }
  return out;
}

/** 去掉最前面可能出现的编号标记 */
export function stripMarkers(text: string): string {
  return String(text || '')
    .replace(/^\s*<<<\s*\d+\s*>>>\s*/, '')
    .trim();
}

export const INLINE_MARK = /\{\{\s*(\d+)\s*\}\}/g;

/**
 * 按 {{k}} 标记把译文切回各个文本节点。
 *
 * 段落里有链接/加粗时，扩展会先用 {{1}} {{2}} 标出每个文本节点的位置，
 * 模型照着保留，回来就能按位置分配 —— 这样 <a>、<b> 这些结构原样留着。
 *
 * @param text  模型返回的译文
 * @param count 文本节点的数量
 * @returns 长度恒为 count 的数组；标记对不上时返回 null（调用方应退回逐条重译）
 */
export function splitInlineMarks(text: string, count: number): (string | null)[] | null {
  const s = String(text || '');
  if (count <= 0) return count === 0 ? [] : null;

  const found: { k: number; at: number; end: number }[] = [];
  INLINE_MARK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_MARK.exec(s)) !== null) {
    found.push({ k: Number(m[1]), at: m.index, end: m.index + m[0].length });
  }
  if (found.length !== count) return null; // 模型没保住标记，走兜底

  /* 编号必须在 1..count 之内。模型偶尔会把编号写成 2,3,4（以为从 1 开始数），
     这时标记数量刚好等于 count，但 k-1 会越界写数组，
     把后面几段的内容挤到错误的位置上。 */
  for (const f of found) {
    if (!Number.isInteger(f.k) || f.k < 1 || f.k > count) return null;
  }

  const out: (string | null)[] = new Array(count).fill('');
  /* 第一个标记前面的内容（比如模型自己加的前缀）不能丢，
     接到第一段文字前面，不然这段就没被翻译 */
  const head = s.slice(0, found[0].at);
  for (let i = 0; i < found.length; i++) {
    const start = found[i].end;
    const stop = i + 1 < found.length ? found[i + 1].at : s.length;
    let seg = s.slice(start, stop);
    if (i === 0 && head) seg = head + seg;
    out[found[i].k - 1] = seg;
  }
  return out;
}
