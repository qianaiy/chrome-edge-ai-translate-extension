#!/usr/bin/env node
/**
 * 翻译质量评测 · 命令行
 * ------------------------------------------------------------------
 * 读 eval/cases.json → 打真实接口 → 打分 → 写报告。
 *
 * 用法：
 *   node eval/run.mjs                       用环境变量跑全部用例
 *   node eval/run.mjs --dry-run             不联网，用 eval/expected.json 跑一遍
 *   node eval/run.mjs --cases ph-01,code-02 只跑指定用例
 *   node eval/run.mjs --out reports/x.json  指定报告路径
 *   node eval/run.mjs --help                看用法
 *
 * 环境变量（全部可选，只有实时评测需要 BASE_URL / API_KEY / MODEL）：
 *   MXT_BASE_URL    OpenAI 兼容接口地址，如 https://api.deepseek.com/v1
 *   MXT_API_KEY     接口密钥（本地服务可以留空）
 *   MXT_MODEL       模型名
 *   MXT_TARGET_LANG 目标语言（默认「简体中文」；用例自带 targetLang 时以用例为准）
 *   MXT_PROTOCOL    协议：auto | openai | anthropic | gemini（默认 auto）
 *   MXT_EXTRA_PROMPT 追加到系统提示词末尾的要求
 *   MXT_TEMPERATURE 采样温度（默认 0.2，与扩展一致）
 *   MXT_CONCURRENCY 并发请求数（默认 3）
 *
 * 退出码：
 *   0  全部通过
 *   1  有用例没通过
 *   2  配置问题（没配接口、参数非法等）
 *   3  运行出错（网络、解析等）
 *
 * 注意：这里只读环境变量，绝不硬编码任何密钥。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvalCore } from './load-core.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..');

const EXIT_OK = 0;
const EXIT_FAILED_CASES = 1;
const EXIT_CONFIG = 2;
const EXIT_RUNTIME = 3;

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    dryRun: false,
    help: false,
    cases: null,
    out: null,
    batch: 0
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--cases') args.cases = String(argv[++i] ?? '');
    else if (a === '--out') args.out = String(argv[++i] ?? '');
    else if (a === '--batch') args.batch = Number(argv[++i]);
    else if (a.startsWith('--cases=')) args.cases = a.slice('--cases='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a.startsWith('--batch=')) args.batch = Number(a.slice('--batch='.length));
    else {
      console.error(`不认识的参数：${a}`);
      console.error('用 --help 看用法。');
      process.exit(EXIT_CONFIG);
    }
  }
  return args;
}

function usage() {
  console.log(`翻译质量评测 · 译点

用法：
  node eval/run.mjs [--dry-run] [--cases <id,id>] [--out <path>] [--batch <n>]

选项：
  --dry-run        不联网，用 eval/expected.json 离线跑一遍（验证评测流水线本身）
  --cases <id,id>  只跑指定用例（逗号分隔，按 id 匹配）
  --out <path>     报告输出路径（默认 eval/reports/<时间戳>.json）
  --batch <n>      每批多少条（默认 6，最大 20）
  --help           显示这段话

环境变量：
  MXT_BASE_URL     接口地址（实时评测必需）
  MXT_API_KEY      接口密钥（本地服务可空）
  MXT_MODEL        模型名（实时评测必需）
  MXT_TARGET_LANG  目标语言，默认「简体中文」
  MXT_PROTOCOL     auto | openai | anthropic | gemini，默认 auto
  MXT_EXTRA_PROMPT 追加到系统提示词的要求
  MXT_TEMPERATURE  采样温度，默认 0.2

退出码：0 全通过 / 1 有用例没过 / 2 配置问题 / 3 运行出错`);
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

function readConfig() {
  const cfg = {
    baseURL: String(process.env.MXT_BASE_URL || '').trim(),
    apiKey: String(process.env.MXT_API_KEY || '').trim(),
    model: String(process.env.MXT_MODEL || '').trim(),
    targetLang: String(process.env.MXT_TARGET_LANG || '简体中文').trim() || '简体中文',
    protocol: String(process.env.MXT_PROTOCOL || 'auto').trim() || 'auto',
    extraPrompt: String(process.env.MXT_EXTRA_PROMPT || '').trim(),
    temperature: Number(process.env.MXT_TEMPERATURE ?? 0.2)
  };
  if (!Number.isFinite(cfg.temperature)) cfg.temperature = 0.2;
  return cfg;
}

/* ------------------------------------------------------------------ *
 * 请求（复用扩展的请求构造与响应解析）
 * ------------------------------------------------------------------ */

/**
 * 发一次聊天请求。
 * 请求体由 src/core/protocol.ts 的 buildRequest 构造 —— 与扩展后台同一个函数，
 * 所以评测测的就是扩展真正会发出去的东西。
 */
async function chat(core, cfg, messages, protocol) {
  const built = core.buildRequest(
    protocol,
    { baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, temperature: cfg.temperature },
    messages,
    { maxTokens: 8192 }
  );

  const res = await fetch(built.url, {
    method: 'POST',
    headers: built.headers,
    body: JSON.stringify(built.body)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`接口返回 ${res.status} ${res.statusText}：${text.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON：${text.slice(0, 300)}`);
  }

  const out = core.extractText(json);
  if (out === null) throw new Error('接口返回里找不到文本内容');
  return out;
}

/** 把一批用例发给模型，返回每条用例的译文 */
async function translateBatch(core, cfg, protocol, batch) {
  const payload = core.buildBatchPayload(batch.map(c => c.source));
  const raw = await chat(
    core,
    cfg,
    [
      { role: 'system', content: core.systemPrompt({ targetLang: cfg.targetLang, extraPrompt: cfg.extraPrompt }) },
      { role: 'user', content: payload }
    ],
    protocol
  );

  const segs = core.parseBatchReply(raw, batch.length);
  const missing = [];
  const out = segs.map((v, i) => {
    if (v === undefined) {
      missing.push(batch[i]);
      return '';
    }
    return v;
  });

  /* 缺段 —— 照扩展后台的做法，逐条重试。
     这一步很重要：它测的是「模型第一次没听话时，兜底能不能救回来」。 */
  for (const c of missing) {
    try {
      const one = await chat(
        core,
        cfg,
        [
          { role: 'system', content: core.systemPrompt({ targetLang: cfg.targetLang, extraPrompt: cfg.extraPrompt }) },
          { role: 'user', content: core.buildBatchPayload([c.source]) }
        ],
        protocol
      );
      const v = core.parseBatchReply(one, 1)[0];
      const idx = out.findIndex((_, i) => batch[i].id === c.id);
      if (v !== undefined && idx >= 0) out[idx] = v;
    } catch {
      /* 单条失败就留空，评分时会判 notEmpty 不通过 */
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function printReport(report) {
  const s = report.summary;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(` 翻译质量评测 · ${report.mode === 'dry-run' ? '离线自检 (dry-run)' : '实时评测'}`);
  console.log('══════════════════════════════════════════════════════');
  if (report.endpoint) {
    console.log(` 接口  ${report.endpoint.url}`);
    console.log(` 模型  ${report.endpoint.model}`);
  }
  console.log(` 用例  ${s.total} 条，通过 ${s.passed} 条，失败 ${s.failed} 条`);
  console.log(` 通过率  ${pct(s.passRate)}`);
  console.log('');
  console.log(' 按分类：');
  for (const [cat, b] of Object.entries(s.byCategory)) {
    const bar = '█'.repeat(Math.round(b.passRate * 10)).padEnd(10, '░');
    console.log(`   ${cat.padEnd(15)} ${bar} ${b.passed}/${b.total}  ${pct(b.passRate)}`);
  }

  if (s.failingIds.length) {
    console.log('');
    console.log(' 失败用例：');
    for (const f of report.failures) {
      console.log(`   ✗ ${f.id}  [${f.category}]`);
      for (const c of f.checks.filter(x => !x.passed)) {
        console.log(`       ${c.name}: ${c.detail}`);
      }
    }
  }

  console.log('');
  console.log(` 报告  ${report.reportPath}`);
  console.log('');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return EXIT_OK;
  }

  const core = await loadEvalCore();

  /* --- 用例 --- */
  const casesPath = join(here, 'cases.json');
  let rawCases;
  try {
    rawCases = JSON.parse(await readFile(casesPath, 'utf8'));
  } catch (e) {
    console.error(`读不了用例文件 ${casesPath}：${e.message}`);
    return EXIT_CONFIG;
  }

  const warnings = core.caseWarnings(rawCases);
  for (const w of warnings) console.warn(`⚠ 用例告警：${w}`);

  let cases;
  try {
    cases = core.loadCases(rawCases);
  } catch (e) {
    console.error(e.message);
    return EXIT_CONFIG;
  }

  /* --- 子集 --- */
  if (args.cases) {
    const wanted = args.cases
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const known = new Set(cases.map(c => c.id));
    const missing = wanted.filter(id => !known.has(id));
    if (missing.length) {
      console.error(`找不到这些用例 id：${missing.join(', ')}`);
      console.error('用 node eval/run.mjs --help 看用法；用例 id 见 eval/cases.json。');
      return EXIT_CONFIG;
    }
    cases = cases.filter(c => wanted.includes(c.id));
  }

  if (!cases.length) {
    console.error('没有要跑的用例。');
    return EXIT_CONFIG;
  }

  const cfg = readConfig();
  const mode = args.dryRun ? 'dry-run' : 'live';

  /* --- 答案 --- */
  const answers = new Array(cases.length).fill('');

  if (args.dryRun) {
    const expectedPath = join(here, 'expected.json');
    let expected;
    try {
      expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    } catch (e) {
      console.error(`读不了参考答案 ${expectedPath}：${e.message}`);
      return EXIT_CONFIG;
    }
    for (let i = 0; i < cases.length; i++) {
      const v = expected[cases[i].id];
      answers[i] = typeof v === 'string' ? v : '';
    }
    console.log('离线自检：用 eval/expected.json 里的参考答案打分（不联网）。');
  } else {
    /* 没配接口 —— 给清楚的话，不抛栈 */
    const missingVars = [];
    if (!cfg.baseURL) missingVars.push('MXT_BASE_URL');
    if (!cfg.model) missingVars.push('MXT_MODEL');
    if (missingVars.length) {
      console.error('');
      console.error('✗ 没有配置评测接口，本次不跑。');
      console.error('');
      console.error('  缺少的环境变量：' + missingVars.join('、'));
      console.error('');
      console.error('  配置方法（把值换成你自己的接口信息）：');
      console.error('    $env:MXT_BASE_URL = "https://api.deepseek.com/v1"');
      console.error('    $env:MXT_API_KEY  = "你的 API Key"');
      console.error('    $env:MXT_MODEL    = "你的模型名"');
      console.error('');
      console.error('  想先看看评测流水线跑不跑得通，用离线模式：');
      console.error('    node eval/run.mjs --dry-run');
      console.error('');
      return EXIT_CONFIG;
    }

    const protocol = core.guessProtocol({
      baseURL: cfg.baseURL,
      model: cfg.model,
      protocol: cfg.protocol
    });

    const batchSize = Math.min(20, Math.max(1, args.batch || 6));
    console.log(`实时评测：${cases.length} 条用例，每批 ${batchSize} 条，协议 ${protocol}。`);

    for (let i = 0; i < cases.length; i += batchSize) {
      const batch = cases.slice(i, i + batchSize);
      const label = `${i + 1}-${i + batch.length}`;
      process.stdout.write(`  [${label}/${cases.length}] 请求中… `);
      try {
        const got = await translateBatch(core, cfg, protocol, batch);
        for (let j = 0; j < batch.length; j++) answers[i + j] = got[j];
        console.log('完成');
      } catch (e) {
        console.log('失败');
        console.error(`    ✗ 这一批请求失败：${e.message}`);
        /* 这一批全记空，评分会如实反映出来 */
      }
    }
  }

  /* --- 打分 --- */
  const { scores, summary } = core.scoreAll(cases, answers);

  /* --- 报告 --- */
  const outPath = args.out
    ? resolve(root, args.out)
    : join(here, 'reports', `${timestamp()}.json`);
  await mkdir(dirname(outPath), { recursive: true });

  const report = {
    mode,
    generatedAt: new Date().toISOString(),
    endpoint:
      mode === 'live'
        ? {
            baseURL: cfg.baseURL,
            model: cfg.model,
            protocol: cfg.protocol,
            targetLang: cfg.targetLang,
            url: core.describeEndpoint({
              baseURL: cfg.baseURL,
              model: cfg.model,
              protocol: cfg.protocol
            }).endpoint
          }
        : null,
    summary,
    failures: scores.filter(s => !s.passed),
    scores,
    reportPath: outPath
  };

  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  printReport(report);

  return summary.failed === 0 ? EXIT_OK : EXIT_FAILED_CASES;
}

try {
  process.exit(await main());
} catch (e) {
  console.error('');
  console.error('✗ 评测运行出错：');
  console.error('  ' + (e && e.message ? e.message : String(e)));
  if (process.env.MXT_DEBUG) console.error(e);
  console.error('');
  process.exit(EXIT_RUNTIME);
}
