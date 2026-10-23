/* 视觉模型返回的框，坐标系并不可信 —— 必须先在核心库里把它规范化。
 *
 * 实测证据（artifacts/real-samples/responses/*.json，同一批请求、同一个模型）：
 *   - jp-vertical / kr-strip 返回 0-100 百分比
 *   - jp-burst 返回像素坐标 [210,300,460,340]（图 800×1000）
 * 扩展过去一律按百分比用，于是像素框被画到 210% 的位置，译文直接跑出画面。
 *
 * 这里的策略是「先判坐标系、再换算、最后钳制」：
 *   1. 判不出来（数值超出图片又超出 1000）就丢掉框，交给气泡检测兜底，
 *      宁可少画一块，也不要把字画到画面外。
 *   2. 换算后越界的框钳到 0-100 —— 模型给的框经常半个压在画面外。
 *   3. 面积为 0 或窄到 0.5% 以下的框算不可用，等于没给。
 */

export type BoxSystem = 'percent' | 'normalized' | 'pixels' | 'thousandth' | 'unknown';

export interface VisionItem {
  text: string;
  zh: string;
  box: number[] | null;
}

const EPS = 1.001;

function finiteBox(box: unknown): number[] | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return nums;
}

/**
 * 判断这批框用的是什么坐标系。
 *
 * 判断顺序很重要：0-100 与像素在「图片很小时」会混淆（比如 80×60 的图，
 * 像素值也就几十）。所以先看是否全部 ≤1（归一化），再看是否全部 ≤100
 * （百分比，这是提示词要求的形状），最后才用图片尺寸兜底认像素。
 */
export function detectBoxSystem(
  items: readonly VisionItem[],
  width: number,
  height: number
): BoxSystem {
  const vals: number[] = [];
  for (const it of items) {
    const b = finiteBox(it.box);
    if (b) vals.push(...b);
  }
  if (!vals.length) return 'unknown';

  const max = Math.max(...vals.map(Math.abs));
  if (max <= EPS) return 'normalized';
  if (max <= 100 + EPS) return 'percent';

  /* 分界线：100 与 1000。
   *
   * 为什么不是「在图片尺寸内就是像素」—— 实测证明那是错的：
   * kr-strip（900×1600）返回最大 827，按像素算覆盖率 0.05，按 0-1000 归一化
   * 算覆盖率 0.88。0-1000 是常见的归一化约定，而真实像素坐标只可能出现在
   * 图片本身超过 1000px 的情况下。所以：
   *   ≤100  → 百分比（提示词要求的形式）
   *   ≤1000 → 0-1000 归一化
   *    >1000 → 只能是像素（前提是落在图片范围内）
   */
  if (max <= 1000 + EPS) return 'thousandth';

  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w > 0 && h > 0 && max <= Math.max(w, h) * 1.05) return 'pixels';
  return 'unknown';
}

/** 换成 0-100 百分比；不可用返回 null。 */
export function toPercentBox(
  box: readonly number[] | null | undefined,
  system: BoxSystem,
  width: number,
  height: number
): [number, number, number, number] | null {
  const b = finiteBox(box);
  if (!b || system === 'unknown') return null;

  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const conv = (v: number, isX: boolean): number => {
    switch (system) {
      case 'normalized':
        return v * 100;
      case 'pixels':
        if (!w || !h) return Number.NaN;
        return (v / (isX ? w : h)) * 100;
      case 'thousandth':
        return v / 10;
      default:
        return v;
    }
  };

  const x1 = conv(b[0], true);
  const y1 = conv(b[1], false);
  const x2 = conv(b[2], true);
  const y2 = conv(b[3], false);
  if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) return null;

  /* 保留两位小数：百分比到这个精度已经足够，也避免 55.00000000000001 这种噪声 */
  const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
  const left = clamp(Math.min(x1, x2));
  const right = clamp(Math.max(x1, x2));
  const top = clamp(Math.min(y1, y2));
  const bottom = clamp(Math.max(y1, y2));

  /* 窄到 0.5% 以下的框画不出任何可读的字，等同于没给 */
  if (right - left < 0.5 || bottom - top < 0.5) return null;
  return [left, top, right, bottom];
}

export interface SanitizeResult {
  items: VisionItem[];
  system: BoxSystem;
  /** 框不可用、被降级成 null 的条目数 */
  droppedBox: number;
  /** 有数值越界的条目数 */
  clamped: number;
}

/**
 * 把一批模型返回的条目整理成「可以直接用」的形状：
 * 统一成百分比、越界钳制、不可用的框降级成 null（而不是丢掉整条译文）。
 */
export function sanitizeVisionItems(
  items: readonly VisionItem[],
  width: number,
  height: number
): SanitizeResult {
  const live = items.filter((it) => String(it?.text ?? '').trim().length > 0);
  const system = detectBoxSystem(live, width, height);

  let droppedBox = 0;
  let clamped = 0;
  const out: VisionItem[] = [];

  for (const it of live) {
    const raw = finiteBox(it.box);
    const pct = toPercentBox(raw, system, width, height);
    if (raw) {
      if (
        (system === 'percent' || system === 'normalized' || system === 'pixels') &&
        raw.some((v) => v < 0 || v > 100)
      ) {
        clamped++;
      }
    }
    if (!pct) {
      if (raw) droppedBox++;
      out.push({ text: String(it.text).trim(), zh: String(it.zh ?? '').trim(), box: null });
      continue;
    }
    out.push({ text: String(it.text).trim(), zh: String(it.zh ?? '').trim(), box: pct });
  }

  return { items: out, system, droppedBox, clamped };
}

function boxArea(b: readonly number[]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function boxIou(a: readonly number[], b: readonly number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = boxArea(a) + boxArea(b) - inter;
  return uni > 0 ? inter / uni : 0;
}

function normText(s: string): string {
  return String(s || '').replace(/[\s、。，．,.!?！？「」『』…·\-ー]/g, '');
}

/** 同一块文字被报了两遍时，留一条并取框的并集。 */
export function mergeDuplicateBoxes(items: readonly VisionItem[]): {
  items: VisionItem[];
  merged: number;
} {
  const out: VisionItem[] = [];
  let merged = 0;

  for (const it of items) {
    if (!it.box) {
      out.push(it);
      continue;
    }
    const dup = out.findIndex(
      (o) => o.box && (boxIou(o.box, it.box as number[]) > 0.6 || normText(o.text) === normText(it.text))
    );
    if (dup < 0) {
      out.push(it);
      continue;
    }
    /* 合并：框取并集，原文取更长的那条（模型常常把同一句截断两次） */
    const a = out[dup];
    const box = [
      Math.min(a.box![0], it.box[0]),
      Math.min(a.box![1], it.box[1]),
      Math.max(a.box![2], it.box[2]),
      Math.max(a.box![3], it.box[3])
    ];
    out[dup] = {
      text: a.text.length >= it.text.length ? a.text : it.text,
      zh: (a.zh || '').length >= (it.zh || '').length ? a.zh : it.zh,
      box
    };
    merged++;
  }

  return { items: out, merged };
}
