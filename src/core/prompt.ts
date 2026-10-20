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
    '5. 某段本身已是目标语言、或只是数字/符号，就原样返回该段。',
    '6. 原文里形如 {{1}}、{{2}} 的标记表示分段位置，必须原样保留、顺序不变，只翻译标记后面的文字。'
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
