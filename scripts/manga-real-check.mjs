/* 真实样本嵌字验证：用真实多模态模型 + 独立真值，量出「模型给的坐标到底准不准」
 *
 * 与 manga-typeset-check.mjs 的分工：
 *   - manga-typeset-check.mjs：合成页 + 假服务，验证「管线」对不对（坐标怎么用、怎么画）
 *   - 本脚本：真实版式图 + 真实模型，验证「模型」给不给得出可用坐标
 *
 * 真值来自 scripts/make-real-samples.py（本仓库自建，无第三方版权），只用于打分，
 * 绝不发给模型 —— 否则就是「用正确坐标冒充检测成功」。
 *
 * 运行：
 *   MXT_VISION_KEY=... node scripts/manga-real-check.mjs
 *   MXT_VISION_MODEL=... 可换模型（默认本地网关上的 sn-sensenova-6-8-flash-lite）
 *
 * 产物：
 *   artifacts/real-samples/responses/<样本>.json   模型的原始回答
 *   artifacts/real-samples/metrics.json            逐项判定与统计
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIR = join(ROOT, 'artifacts', 'real-samples');
const RES_DIR = join(DIR, 'responses');

const ENDPOINT = process.env.MXT_VISION_ENDPOINT || 'http://127.0.0.1:8326/v1/chat/completions';
const KEY = process.env.MXT_VISION_KEY || '';
const MODEL = process.env.MXT_VISION_MODEL || 'raccoon/sn-sensenova-6-8-flash-lite';
const TARGET = process.env.MXT_TARGET_LANG || '简体中文';
const TIMEOUT = Number(process.env.MXT_VISION_TIMEOUT || 180000);

/* 与 background.js 的 translateImage 完全一致的提示词。
   复用同一段文字很重要：改了提示词就得重测，否则测的不是线上行为。 */
const SYSTEM =
  '你是漫画/图片翻译助手。看图里的文字（对白、旁白、拟声词），' +
  `把它们翻译成${TARGET}。只输出 JSON，格式：` +
  '[{"text":"原文","zh":"译文","box":[左,上,右,下]}]。' +
  'box 是文字在图里的位置，用 0-100 的百分比。没文字就输出 []。';

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

if (!KEY) {
  fail('缺少 MXT_VISION_KEY。真实模型测试要真 key，脚本不读仓库里的任何密钥。');
}
if (!existsSync(join(DIR, 'manifest.json'))) {
  fail('缺少 artifacts/real-samples/manifest.json，先跑 python scripts/make-real-samples.py');
}
mkdirSync(RES_DIR, { recursive: true });

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));

/* 用扩展真正跑的那份共享核心做规范化 —— 脚本不能自带一套跨坐标系的换算，
   否则测的是脚本，不是产品。dist/core.js 就是服务工作者 importScripts 的那个文件。 */
const CORE_PATH = join(ROOT, 'dist', 'core.js');
if (!existsSync(CORE_PATH)) {
  console.error('✗ 缺少 dist/core.js，先跑 npm run build');
  process.exit(1);
}
/* dist/core.js 里是 `var MXTCore = (() => ...)()`。浏览器把它当顶层脚本，
   var 会挂到全局；放进 new Function 里就是函数作用域，挂不上去。
   所以在末尾显式赋一次。 */
new Function(
  'globalThis',
  readFileSync(CORE_PATH, 'utf8') + '\n;globalThis.MXTCore = MXTCore;'
)(globalThis);
const Core = globalThis.MXTCore;
if (!Core || typeof Core.sanitizeVisionItems !== 'function') {
  console.error('✗ dist/core.js 里没有 sanitizeVisionItems，先 npm run build');
  process.exit(1);
}

/* ---------------- 模型调用 ---------------- */

async function askModel(file) {
  const b64 = readFileSync(join(DIR, file)).toString('base64');
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '翻译这张图里的所有文字。' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
        ]
      }
    ],
    /* 这些视觉模型是推理模型：额度给小了会把 token 全花在思考上，
       正文是空的。4096 与扩展默认值一致。 */
    max_tokens: 4096
  };
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, ms, error: '响应不是 JSON：' + raw.slice(0, 120) };
  }
  const msg = json?.choices?.[0]?.message || {};
  return {
    ok: true,
    ms,
    content: (msg.content || '').trim(),
    reasoningTokens: json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    finish: json?.choices?.[0]?.finish_reason,
    usage: json?.usage
  };
}

/* 模型可能把 JSON 包在 ```json 里，或前后带话（与 background.js 的 parseImageJson 同逻辑） */
function parseItems(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const cands = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cands.push(fence[1].trim());
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first >= 0 && last > first) cands.push(s.slice(first, last + 1));
  cands.push(s);
  for (const c of cands) {
    try {
      const arr = JSON.parse(c);
      if (!Array.isArray(arr)) continue;
      return arr
        .map((x) => ({
          text: String(x.text ?? '').trim(),
          zh: String(x.zh ?? x.translation ?? '').trim(),
          box: Array.isArray(x.box) && x.box.length === 4 ? x.box.map(Number) : null
        }))
        .filter((x) => x.text);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/* ---------------- 坐标系统判定 ---------------- */

/* 模型可能把 box 理解成：百分比 0-100 / 归一化 0-1 / 像素坐标。
   不做这一步就会出现「整体缩到左上角」这种看起来像坐标 bug 的现象。 */
function detectCoordinateSystem(items, imgW, imgH) {
  const vals = items.flatMap((it) => it.box || []).filter((v) => Number.isFinite(v));
  if (!vals.length) return { system: 'unknown', note: '没有任何数值' };
  const max = Math.max(...vals);
  if (max <= 1.001) return { system: 'normalized', max, note: '0-1 归一化' };
  if (max <= 100.001) return { system: 'percent', max, note: '0-100 百分比' };
  const fitsPixels = max <= Math.max(imgW, imgH) * 1.2;
  return {
    system: fitsPixels ? 'pixels' : 'out-of-range',
    max,
    note: fitsPixels ? `像素坐标（图 ${imgW}×${imgH}）` : `超出图片尺寸（图 ${imgW}×${imgH}）`
  };
}

function toPercent(box, sys, imgW, imgH) {
  if (!box) return null;
  const conv = (v, i) => {
    if (!Number.isFinite(v)) return NaN;
    if (sys === 'normalized') return v * 100;
    if (sys === 'pixels') return (v / (i % 2 === 0 ? imgW : imgH)) * 100;
    return v;
  };
  const [x1, y1, x2, y2] = box.map(conv);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/* 匹配判定用「覆盖」而不是 IoU：
 * 模型的框普遍比文字墨迹宽（它框的是整块文字区甚至整个气泡），拿 IoU 会
 * 把「框对了」误判成「没框对」。真正该问的是两件事：
 *   1. 真值文字区有没有被框住（漏了就是译文压不住原文）
 *   2. 框有没有超出气泡（超了就会擦掉描边、盖到画面上）
 * IoU 仍然记录，用于观察框的紧致程度，但不作为通过标准。
 */
const COVER_MIN = 0.6;
const SPILL_TOL = 2; // 百分比

function area(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function inter(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function iou(a, b) {
  const i = inter(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

function normalize(s) {
  return String(s || '').replace(/[\s、。，．,.!?！？「」『』…·\-ー]/g, '');
}

/** 原文相似度：区分「框对了但文字配错」和正常识别 */
function similarity(a, b) {
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  const sa = new Set(A);
  const sb = new Set(B);
  let hit = 0;
  for (const ch of sa) if (sb.has(ch)) hit++;
  return hit / Math.max(sa.size, sb.size);
}

const report = {
  model: MODEL,
  endpoint: ENDPOINT,
  startedAt: new Date().toISOString(),
  threshold: { cover: COVER_MIN, spillTolerance: SPILL_TOL },
  samples: []
};

for (const sample of manifest.samples) {
  console.log(`\n===== ${sample.name}  ${sample.width}×${sample.height} =====`);
  const res = await askModel(sample.file);
  if (!res.ok) {
    console.log(`  ✗ 调用失败：${res.error}`);
    report.samples.push({ name: sample.name, error: res.error });
    continue;
  }
  const rawItems = parseItems(res.content);
  writeFileSync(
    join(RES_DIR, sample.name + '.json'),
    JSON.stringify(
      { model: MODEL, ms: res.ms, finish: res.finish, usage: res.usage, content: res.content, items: rawItems },
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `  模型：${(res.ms / 1000).toFixed(1)}s  finish=${res.finish}  推理token=${res.reasoningTokens}  ` +
      `正文${res.content ? res.content.length + '字' : '为空'}`
  );

  if (rawItems === null) {
    console.log('  ✗ 正文解析不出 JSON');
    report.samples.push({ name: sample.name, parse: 'failed', raw: res.content.slice(0, 200) });
    continue;
  }

  const rawSystem = Core.detectBoxSystem(rawItems, sample.width, sample.height);
  const clean = Core.sanitizeVisionItems(rawItems, sample.width, sample.height);
  const merged = Core.mergeDuplicateBoxes(clean.items);
  const items = merged.items;

  console.log(`  坐标系统：${rawSystem}（规范化后 ${clean.system}）`);
  console.log(
    `  模型给 ${rawItems.length} 条 → 去重后 ${items.length} 条` +
      `（合并 ${merged.merged}，框降级 ${clean.droppedBox}）`
  );

  /* 逐条真值找最佳匹配 */
  const rows = [];
  const used = new Set();
  for (const gt of sample.items) {
    let best = -1;
    let bestCover = 0;
    items.forEach((mi, idx) => {
      if (!mi.box || used.has(idx)) return;
      const cover = inter(mi.box, gt.text) / Math.max(1e-6, area(gt.text));
      if (cover > bestCover) {
        bestCover = cover;
        best = idx;
      }
    });
    const matched = best >= 0 && bestCover >= COVER_MIN;
    if (matched) used.add(best);
    const mi = matched ? items[best] : null;
    const spill =
      matched && gt.bubble
        ? mi.box[0] < gt.bubble[0] - SPILL_TOL ||
          mi.box[1] < gt.bubble[1] - SPILL_TOL ||
          mi.box[2] > gt.bubble[2] + SPILL_TOL ||
          mi.box[3] > gt.bubble[3] + SPILL_TOL
        : false;
    /* 译文能不能装进这个框 —— 这才是用户看到的「溢出」。
       框超出气泡是另一件事（spill），两者不能混。 */
    let textOver = false;
    let fitInfo = null;
    if (matched) {
      const bwPx = ((mi.box[2] - mi.box[0]) / 100) * sample.width;
      const bhPx = ((mi.box[3] - mi.box[1]) / 100) * sample.height;
      fitInfo = Core.fitText(mi.zh || '', Math.max(8, bwPx), Math.max(8, bhPx));
      textOver = !!fitInfo.overflow;
    }

    rows.push({
      id: gt.id,
      textOver,
      fit: fitInfo ? { fontSize: fitInfo.fontSize, lines: fitInfo.lines.length } : null,
      kind: gt.kind,
      matched,
      cover: +bestCover.toFixed(2),
      iou: matched ? +iou(mi.box, gt.text).toFixed(2) : 0,
      textSim: matched ? +similarity(gt.source, mi.text).toFixed(2) : 0,
      spill,
      areaRatio: matched && gt.bubble
        ? +(((mi.box[2] - mi.box[0]) * (mi.box[3] - mi.box[1])) /
            Math.max(0.01, (gt.bubble[2] - gt.bubble[0]) * (gt.bubble[3] - gt.bubble[1]))).toFixed(2)
        : null,
      gtText: gt.source.slice(0, 26),
      modelText: matched ? mi.text.replace(/\n/g, '/').slice(0, 26) : '',
      modelBox: matched ? mi.box : null,
      gtBox: gt.text.map((v) => +v.toFixed(1))
    });
  }

  const extra = items.filter((_, idx) => !used.has(idx) && items[idx].box);

  for (const r of rows) {
    const flag = r.matched ? (r.spill ? '⚠' : '✓') : '✗';
    console.log(
      `  ${flag} ${r.id.padEnd(8)} ${r.kind.padEnd(20)} ` +
        (r.matched
          ? `覆盖=${r.cover} IoU=${r.iou} 文字相似=${r.textSim}${r.spill ? ' 超出气泡' : ''}  「${r.modelText}」`
          : `未覆盖（真值「${r.gtText}」）`)
    );
  }
  if (extra.length) {
    console.log(`  未对上真值的框 ${extra.length} 条：${extra.map((e) => `「${e.text.slice(0, 14)}」`).join(' ')}`);
  }

  const gt = sample.items.length;
  const hit = rows.filter((r) => r.matched).length;
  const spillCount = rows.filter((r) => r.spill).length;
  const mismatch = rows.filter((r) => r.matched && r.textSim < 0.5).length;
  const meanIou = hit ? rows.filter((r) => r.matched).reduce((n, r) => n + r.iou, 0) / hit : 0;

  report.samples.push({
    name: sample.name,
    size: [sample.width, sample.height],
    ms: res.ms,
    finish: res.finish,
    reasoningTokens: res.reasoningTokens,
    boxSystem: rawSystem,
    counts: {
      gt,
      model: items.length,
      raw: rawItems.length,
      matched: hit,
      spilled: spillCount,
      mismatched: mismatch,
      extra: extra.length,
      mergedIn: merged.merged,
      droppedBox: clean.droppedBox
    },
    meanIou: +meanIou.toFixed(3),
    rows
  });
}

/* ---------------- 汇总 ---------------- */

const ok = report.samples.filter((s) => s.counts);
const sum = (k) => ok.reduce((n, s) => n + s.counts[k], 0);
const totals = {
  gt: sum('gt'),
  model: sum('model'),
  raw: sum('raw'),
  matched: sum('matched'),
  spilled: sum('spilled'),
  mismatched: sum('mismatched'),
  textOver: ok.reduce((n, s) => n + s.rows.filter(r => r.textOver).length, 0),
  /* 框是不是大得离谱 —— 「框很大所以什么都盖住」也是一种假成功 */
  oversized: ok.reduce((n, s) => n + s.rows.filter(r => r.areaRatio && (r.areaRatio > 3 || r.areaRatio < 0.25)).length, 0),
  extra: sum('extra'),
  mergedIn: sum('mergedIn'),
  droppedBox: sum('droppedBox')
};
report.totals = {
  ...totals,
  placeRate: totals.gt ? +(totals.matched / totals.gt).toFixed(3) : 0,
  spillRate: totals.matched ? +(totals.spilled / totals.matched).toFixed(3) : 0,
  mismatchRate: totals.matched ? +(totals.mismatched / totals.matched).toFixed(3) : 0,
  textOverRate: totals.matched ? +(totals.textOver / totals.matched).toFixed(3) : 0,
  extraRate: totals.model ? +(totals.extra / totals.model).toFixed(3) : 0
};

writeFileSync(join(DIR, 'metrics.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('\n===== 汇总 =====');
if (!ok.length) {
  console.log('没有任何样本跑成功');
  process.exit(1);
}
console.log(`真值 ${totals.gt} 条，模型原始 ${totals.raw} 条，去重后 ${totals.model} 条`);
console.log(`嵌字成功率（真值文字区被框覆盖 ≥${COVER_MIN}）  ${(report.totals.placeRate * 100).toFixed(1)}%  ${totals.matched}/${totals.gt}`);
console.log(`框超出气泡率（框超出气泡 >${SPILL_TOL}%）      ${(report.totals.spillRate * 100).toFixed(1)}%  ${totals.spilled}/${totals.matched}`);
console.log(`译文溢出率（排完仍装不下框）              ${(report.totals.textOverRate * 100).toFixed(1)}%  ${totals.textOver}/${totals.matched}`);
console.log(`错误匹配率（框对但文字对不上）              ${(report.totals.mismatchRate * 100).toFixed(1)}%  ${totals.mismatched}/${totals.matched}`);
console.log(`框面积离谱（>3 倍或 <0.25 倍气泡）      ${totals.oversized}/${totals.matched}`);
console.log(`多余框占比                                  ${(report.totals.extraRate * 100).toFixed(1)}%  ${totals.extra}/${totals.model}`);
console.log(`\n明细：${join(DIR, 'metrics.json')}`);

process.exit(report.totals.placeRate < 0.8 ? 1 : 0);
