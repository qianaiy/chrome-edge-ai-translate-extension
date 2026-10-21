/**
 * 翻译质量评测 · 评测入口
 * ------------------------------------------------------------------
 * 实现放在 src/core/eval.ts —— 那里的代码是纯函数、不联网、不碰 chrome.*，
 * 所以扩展将来也能直接复用同一份实现（设置页里加个「自检」按钮不是梦）。
 *
 * 这里做两件事：
 *   1. 把 src/core/eval.ts 的能力重新导出，方便评测脚本只认一个入口
 *   2. 补上「评测侧」才需要的东西：用例装载/校验、批量请求拼装、
 *      以及照抄扩展后台行为的批量回复解析
 *
 * 为什么要复用扩展的实现：评测要能回答「换提示词/换模型之后变好还是变坏」。
 * 如果评测自己另写一套解析，测的就不是线上跑的那套逻辑了。
 */

import {
  parseModelOutput,
  scoreTranslation,
  summarize,
  effectiveLength,
  lengthRatio,
  stripCodeFence,
  LENGTH_RATIO_MIN,
  LENGTH_RATIO_MAX,
  LENGTH_RATIO_MIN_SOURCE,
  /* 评测脚本还要用这些来构造请求，跟扩展走同一套逻辑 */
  guessProtocol,
  describeEndpoint,
  buildRequest,
  extractText,
  systemPrompt,
  type EvalCase,
  type CaseScore,
  type Summary,
  type CheckResult,
  type CategorySummary
} from '../src/core/eval.js';

/* 重新导出，让评测脚本只认 eval/score.ts 这一个入口 */
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
  guessProtocol,
  describeEndpoint,
  buildRequest,
  extractText,
  systemPrompt
};
export type {
  EvalCase,
  CaseScore,
  Summary,
  CheckResult,
  CategorySummary
};

/* ------------------------------------------------------------------ *
 * 用例装载与校验
 * ------------------------------------------------------------------ */

/** 用例里允许出现的分类。新增分类时这里也要加，否则 validateCases 会报警。 */
export const EVAL_CATEGORIES = [
  'plain',
  'placeholder',
  'code',
  'already-target',
  'long',
  'mixed',
  'tricky'
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** 校验结果：一处问题一条 */
export interface CaseProblem {
  id: string;
  level: 'error' | 'warning';
  message: string;
}

/**
 * 校验一批用例。
 * error = 用例本身坏了，跑不出有意义的分数；
 * warning = 能跑，但很可能不是你想测的那个东西。
 */
export function validateCases(cases: unknown): CaseProblem[] {
  const problems: CaseProblem[] = [];
  const list = Array.isArray(cases) ? cases : [];

  if (!Array.isArray(cases)) {
    problems.push({ id: '-', level: 'error', message: '用例文件顶层必须是数组' });
    return problems;
  }
  if (!list.length) {
    problems.push({ id: '-', level: 'error', message: '用例文件是空的' });
    return problems;
  }

  const seen = new Set<string>();

  for (const raw of list) {
    const c = raw as Partial<EvalCase> & { id?: unknown };
    const id = typeof c?.id === 'string' ? c.id : '(缺 id)';
    const push = (level: CaseProblem['level'], message: string) =>
      problems.push({ id, level, message });

    if (typeof c?.id !== 'string' || !c.id.trim()) push('error', '缺少 id');
    else if (seen.has(c.id)) push('error', `id 重复：${c.id}`);
    else seen.add(c.id);

    if (typeof c?.category !== 'string' || !c.category.trim()) {
      push('error', '缺少 category');
    } else if (!(EVAL_CATEGORIES as readonly string[]).includes(c.category)) {
      push('warning', `未知分类「${c.category}」，不在 EVAL_CATEGORIES 里`);
    }

    if (typeof c?.source !== 'string' || !c.source.length) {
      push('error', 'source 必须是非空字符串');
    }
    if (typeof c?.targetLang !== 'string' || !c.targetLang.trim()) {
      push('error', '缺少 targetLang');
    }
    if (c?.mustKeep !== undefined && !Array.isArray(c.mustKeep)) {
      push('error', 'mustKeep 必须是数组');
    } else if (Array.isArray(c.mustKeep)) {
      for (const k of c.mustKeep) {
        if (typeof k !== 'string' || !k.length) {
          push('error', 'mustKeep 里不能有空字符串');
        } else if (typeof c.source === 'string' && !c.source.includes(k)) {
          push('error', `mustKeep 里的「${k}」在 source 里根本不存在，这条用例永远过不了`);
        }
      }
    }
  }

  return problems;
}

/** 校验并返回用例；有问题就抛错（带可读信息） */
export function loadCases(raw: unknown): EvalCase[] {
  const problems = validateCases(raw);
  const errors = problems.filter(p => p.level === 'error');
  if (errors.length) {
    const detail = errors.map(p => `  - ${p.id}: ${p.message}`).join('\n');
    throw new Error(`用例文件有问题：\n${detail}`);
  }
  return raw as EvalCase[];
}

/** 只取 warning（给 CLI 打提示用，不阻断） */
export function caseWarnings(raw: unknown): string[] {
  return validateCases(raw)
    .filter(p => p.level === 'warning')
    .map(p => `${p.id}: ${p.message}`);
}

/* ------------------------------------------------------------------ *
 * 请求拼装（照抄扩展后台的行为）
 * ------------------------------------------------------------------ */

/**
 * 把多条文本拼成扩展后台 translateChunk 那种带编号标记的请求体。
 *
 * 扩展里是这样拼的：
 *   const payload = list.map((t, i) => `<<<${i + 1}>>>${t}`).join('\n');
 * 这里必须一模一样，否则测出来的「标记丢失率」没有意义。
 */
export function buildBatchPayload(texts: string[]): string {
  return (texts || []).map((t, i) => `<<<${i + 1}>>>${String(t ?? '')}`).join('\n');
}

/**
 * 解析批量回复，缺段的下标返回 undefined —— 调用方据此逐条重试。
 *
 * 这就是扩展后台 translateChunk 的解析部分：
 *   1. 先按 <<<n>>> 切
 *   2. 一个都没切出来时，退回按行切（模型有时会忘记加标记）
 */
export function parseBatchReply(raw: string, count: number): (string | undefined)[] {
  const segs = parseModelOutput(raw);
  const out: (string | undefined)[] = new Array(count).fill(undefined);

  if (segs.length === count) {
    for (let i = 0; i < count; i++) {
      const v = (segs[i] || '').trim();
      out[i] = v.length ? v : undefined;
    }
    return out;
  }

  /* 行数对不上 —— 扩展后台在这里会直接抛错，
     评测里不抛：当成「模型没按格式返回」，整条用例的译文记为空。 */
  return out;
}

/* ------------------------------------------------------------------ *
 * 打分便捷函数
 * ------------------------------------------------------------------ */

/**
 * 对一批「用例 + 译文」打分并汇总。
 * @param answers  与 cases 同序的译文（可以是数组分段，也可以是整段字符串）
 */
export function scoreAll(
  cases: EvalCase[],
  answers: (string | string[])[]
): { scores: CaseScore[]; summary: Summary } {
  const scores = (cases || []).map((c, i) => {
    const a = answers[i];
    return scoreTranslation(c, a === undefined ? '' : a);
  });
  return { scores, summary: summarize(scores) };
}
