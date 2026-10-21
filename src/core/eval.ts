/**
 * 翻译质量评测 · 纯函数
 * ------------------------------------------------------------------
 * 这套评分不联网、不碰 chrome.*、不碰 DOM，所以能在 Node 里直接跑，
 * 也能被扩展将来复用（比如设置页里的「自检」按钮）。
 *
 * 设计思路：
 *   评测要回答的问题是「换了个提示词 / 换了个模型，翻译质量是变好还是变坏」。
 *   要回答这个问题，指标必须满足三个条件：
 *     1. 可自动判定 —— 人肉看译文的「地道不地道」没法复现，也没法比较。
 *     2. 贴近真实故障 —— 只统计模型「不听话」的地方：占位符被吃掉、
 *        原文照抄没翻、译文被截断、标记漏了。
 *     3. 与扩展行为一致 —— 解析模型回复的逻辑必须和 prompt.ts 一致，
 *        否则测的是「解析器」而不是「模型」。
 *
 * 长度比只是一个粗筛（截断 / 复读的信号），不是翻译质量本身，
 * 所以区间取得很宽，避免因为中文压缩率高就误杀。
 */

import { MARK_RE, systemPrompt } from './prompt.js';
import { buildRequest, extractText } from './protocol.js';
import { guessProtocol, describeEndpoint } from './provider.js';

/* 评测脚本要「用扩展那套逻辑」去构造请求，所以这些一并从这里导出。
   不重新实现，是为了让评测结果反映扩展的真实行为。 */
export { buildRequest, extractText, guessProtocol, describeEndpoint, systemPrompt };

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

/** 评测用例 */
export interface EvalCase {
  /** 唯一 id，报告与 --cases 都用它 */
  id: string;
  /** 分类，用于分组统计（plain / placeholder / code / ...） */
  category: string;
  /** 待翻译原文 */
  source: string;
  /** 目标语言名，跟扩展设置里的写法一致（如「简体中文」「English」） */
  targetLang: string;
  /** 必须原样出现的子串（占位符、URL、邮箱、代码标识符……） */
  mustKeep: string[];
  /**
   * 原文本身已经是目标语言 —— 这类用例要求模型原样返回。
   * 不显式写这个字段时不做「必须原样」的判定，避免误伤
   * 「中英混排」这类本来就应该被改写的用例。
   */
  alreadyTarget?: boolean;
  /** 备注，只给人看 */
  note?: string;
}

/** 单项检查结果 */
export interface CheckResult {
  /** 检查名，报告里按它归类 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 给人看的说明 */
  detail: string;
  /** 这条检查对本用例不适用（例如非目标语言原文不做「原样返回」判定） */
  skipped?: boolean;
}

/** 单个用例的评分结果 */
export interface CaseScore {
  id: string;
  category: string;
  /** 所有适用的检查都通过才算通过 */
  passed: boolean;
  /** 实际送进评分的译文 */
  output: string;
  /** 每项检查的明细 */
  checks: CheckResult[];
  /** 没通过的检查名 */
  failed: string[];
}

/** 分类小计 */
export interface CategorySummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

/** 总览 */
export interface Summary {
  total: number;
  passed: number;
  failed: number;
  /** 0..1；total 为 0 时是 0 */
  passRate: number;
  /** 按分类拆开 */
  byCategory: Record<string, CategorySummary>;
  /** 没通过的用例 id */
  failingIds: string[];
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 去掉空白后的字符数（按码点算，中文一个字算一个） */
export function effectiveLength(text: string): number {
  return Array.from(String(text || '').replace(/\s+/g, '')).length;
}

/** 译文 / 原文的长度比 */
export function lengthRatio(source: string, output: string): number {
  const s = effectiveLength(source);
  if (!s) return output ? Number.POSITIVE_INFINITY : 0;
  return effectiveLength(output) / s;
}

/**
 * 长度比的合理区间。
 * 上界抓「复读机」和「越翻越长」，下界抓「只翻了一半」。
 * 区间取得宽，是因为中文压缩率天然比英文高，
 * 真正的质量判断交给 mustKeep 与「原样返回」这两项硬指标。
 */
export const LENGTH_RATIO_MIN = 0.15;
export const LENGTH_RATIO_MAX = 6;
/** 原文短于这个长度就不做长度比判定（片段类用例没有统计意义） */
export const LENGTH_RATIO_MIN_SOURCE = 12;

/**
 * 比较用的规范化：去掉所有空白、去掉常见标点，统一大小写。
 * 用来判断「译文是不是就是原文」—— 空白和标点差异不算翻译。
 */
function normalized(text: string): string {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》…—~,.!?;:"'()[\]<>]/g, '')
    .toLowerCase();
}

/** 数一下 needle 在 haystack 里出现了几次（不重叠计数） */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 去掉代码围栏（```json ... ``` / ``` ... ```） */
export function stripCodeFence(text: string): string {
  const t = String(text || '').trim();
  const closed = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  if (closed) return closed[1];
  const open = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*)$/.exec(t);
  if (open) return open[1];
  return t;
}

/* ------------------------------------------------------------------ *
 * 解析模型回复
 * ------------------------------------------------------------------ */

/**
 * 从模型回复里抽出译文分段。
 *
 * 刻意复刻 src/core/prompt.ts 与扩展后台的取段逻辑，
 * 让评测看到的分段 == 用户在页面上看到的分段：
 *   1. 整段是 JSON 数组 —— 取数组元素（模型爱把结果包成 JSON）
 *   2. 有 <<<n>>> 标记 —— 按标记序号切（缺段留空字符串，位置不变）
 *   3. 都没有 —— 按行切，并去掉行首的列表符号（后台 translateChunk 的兜底）
 *
 * JSON 排在标记前面：JSON 数组的分段是模型明说的，切它最准。
 * 数组元素里如果还带 <<<n>>> 标记，就把标记剥掉再算内容。
 */
export function parseModelOutput(raw: string): string[] {
  const text = stripCodeFence(String(raw || ''));

  /* --- 1. JSON 数组 --- */
  const jsonSegs = jsonSegments(text);
  if (jsonSegs) return jsonSegs.map(s => stripLeadingMark(s));

  /* --- 2. 标记分段 --- */
  const marked = new Map<number, string>();
  MARK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_RE.exec(text)) !== null) {
    const i = Number(m[1]);
    if (Number.isFinite(i) && i >= 1) {
      const v = m[2].trim();
      /* 与 parseMarked 一致：后出现的同名标记覆盖前面的 */
      if (v) marked.set(i, v);
      else marked.set(i, '');
    }
  }
  if (marked.size) {
    const max = Math.max(...marked.keys());
    const out: string[] = [];
    for (let i = 1; i <= max; i++) out.push(marked.get(i) ?? '');
    return out;
  }

  /* --- 3. 按行切 --- */
  return text
    .split('\n')
    .map(s => s.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter(Boolean);
}

/** 剥掉一段开头可能带的 <<<n>>> 标记 */
function stripLeadingMark(segment: string): string {
  return String(segment || '')
    .replace(/^\s*<<<\s*\d+\s*>>>\s*/, '')
    .trim();
}

/** 从一段文本里解析 JSON 分段；不是 JSON 就返回 null */
function jsonSegments(text: string): string[] | null {
  const candidates = [text];
  const fenced = /```(?:json)?\s*\r?\n([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1]);
  for (const c of candidates) {
    const t = c.trim();
    if (!t || (t[0] !== '[' && t[0] !== '{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const arr = pickArray(parsed);
    if (arr) {
      const segs = arr
        .map(v => (typeof v === 'string' ? v : v == null ? '' : String(v)))
        .map(v => v.trim())
        .filter(v => v.length > 0);
      if (segs.length) return segs;
    }
  }
  return null;
}

/** 从解析出来的 JSON 里找出字符串数组 */
function pickArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['segments', 'translations', 'results', 'texts', 'output', 'outputs', 'lines']) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 评分
 * ------------------------------------------------------------------ */

function check(name: string, passed: boolean, detail: string, skipped = false): CheckResult {
  return { name, passed, detail, ...(skipped ? { skipped: true } : {}) };
}

/**
 * 给一个用例的译文打分。
 *
 * 检查项：
 *   1. notEmpty   —— 译文非空（模型拒答 / 截断 / 解析失败）
 *   2. placeholders —— mustKeep 里的每一项都原样出现
 *   3. unchanged  —— 原文已是目标语言时，译文必须与原文一致
 *   4. lengthRatio —— 长度比落在合理区间（粗筛截断 / 复读）
 *   5. markerLeak —— 译文里不该残留 <<<n>>> 标记
 *
 * @param output 译文；传数组时按行拼接（模型多段返回的情况）
 */
export function scoreTranslation(evalCase: EvalCase, output: string | string[]): CaseScore {
  const text = Array.isArray(output) ? output.join('\n') : String(output ?? '');
  const source = String(evalCase?.source ?? '');
  const mustKeep = Array.isArray(evalCase?.mustKeep) ? evalCase.mustKeep : [];
  const checks: CheckResult[] = [];

  /* 1. 非空 */
  const trimmed = text.trim();
  checks.push(
    trimmed
      ? check('notEmpty', true, `译文 ${effectiveLength(text)} 字`)
      : check('notEmpty', false, '译文是空的')
  );

  /* 2. 占位符 / 必须保留的片段 */
  const missing = mustKeep.filter(k => !trimmed.includes(String(k)));
  checks.push(
    mustKeep.length === 0
      ? check('placeholders', true, '本用例没有必须保留的片段', true)
      : missing.length === 0
        ? check('placeholders', true, `${mustKeep.length} 个必须保留的片段都在`)
        : check('placeholders', false, `丢了 ${missing.length}/${mustKeep.length} 个：${missing.map(x => JSON.stringify(x)).join(' ')}`)
  );

  /* 3. 原文已是目标语言 → 必须原样返回 */
  if (evalCase?.alreadyTarget) {
    checks.push(
      trimmed === source.trim()
        ? check('unchanged', true, '目标语言原文被原样返回')
        : check('unchanged', false, '原文已是目标语言，译文却改了内容')
    );
  } else {
    checks.push(check('unchanged', true, '原文不是目标语言，本项不适用', true));
  }

  /* 4. 长度比粗筛 */
  const srcLen = effectiveLength(source);
  const ratio = lengthRatio(source, text);
  if (srcLen < LENGTH_RATIO_MIN_SOURCE) {
    checks.push(check('lengthRatio', true, `原文只有 ${srcLen} 字，长度比不判定`, true));
  } else if (!Number.isFinite(ratio) || ratio < LENGTH_RATIO_MIN || ratio > LENGTH_RATIO_MAX) {
    checks.push(
      check(
        'lengthRatio',
        false,
        `长度比 ${ratio.toFixed(2)} 超出合理区间 [${LENGTH_RATIO_MIN}, ${LENGTH_RATIO_MAX}]（原文 ${srcLen} 字 / 译文 ${effectiveLength(text)} 字）`
      )
    );
  } else {
    checks.push(check('lengthRatio', true, `长度比 ${ratio.toFixed(2)}`));
  }

  /* 5. 复读原文 —— 模型不翻译、直接把原文吐回来，或者把原文重复几遍。
        长度比抓不到这两种情况（1:1 与 2:1 都落在合理区间里），
        所以单列一条。 */
  if (evalCase?.alreadyTarget) {
    checks.push(check('copySource', true, '原文已是目标语言，不适用复读检查', true));
  } else if (srcLen < LENGTH_RATIO_MIN_SOURCE) {
    checks.push(check('copySource', true, '原文太短，不做复读检查', true));
  } else {
    const normSrc = normalized(source);
    const normOut = normalized(text);
    if (normSrc === normOut) {
      checks.push(check('copySource', false, '译文和原文一模一样 —— 模型根本没翻译'));
    } else {
      const repeats = countOccurrences(normOut, normSrc);
      checks.push(
        repeats >= 2
          ? check('copySource', false, `译文里原文出现了 ${repeats} 次 —— 模型在复读`)
          : check('copySource', true, '译文与原文不同，也没有复读')
      );
    }
  }

  /* 6. 标记泄漏 */
  checks.push(
    /<<<\s*\d+\s*>>>/.test(text)
      ? check('markerLeak', false, '译文里残留了 <<<n>>> 标记')
      : check('markerLeak', true, '没有残留标记')
  );

  const failed = checks.filter(c => !c.passed).map(c => c.name);
  return {
    id: String(evalCase?.id ?? ''),
    category: String(evalCase?.category ?? 'unknown'),
    passed: failed.length === 0,
    output: text,
    checks,
    failed
  };
}

/**
 * 汇总一组评分结果。
 * @returns 总数、通过数、通过率、分类小计、失败用例 id
 */
export function summarize(scores: CaseScore[]): Summary {
  const list = Array.isArray(scores) ? scores : [];
  const byCategory: Record<string, CategorySummary> = {};
  const failingIds: string[] = [];
  let passed = 0;

  for (const s of list) {
    const cat = s?.category || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, failed: 0, passRate: 0 };
    const bucket = byCategory[cat];
    bucket.total++;
    if (s?.passed) {
      passed++;
      bucket.passed++;
    } else {
      bucket.failed++;
      failingIds.push(s?.id ?? '');
    }
  }

  for (const bucket of Object.values(byCategory)) {
    bucket.passRate = bucket.total ? bucket.passed / bucket.total : 0;
  }

  const total = list.length;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    byCategory,
    failingIds
  };
}
