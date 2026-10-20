/**
 * 构建脚本
 * ------------------------------------------------------------------
 * 产出 dist/ —— 一个可以直接「加载已解压的扩展程序」的目录。
 *
 * 做两件事：
 *   1. 把 src/core（TypeScript）打成 dist/core.js，给后台脚本用
 *   2. 把 src/extension 原样拷到 dist/（扩展本身是免构建的纯 JS）
 *
 * 扩展代码保持免构建，是因为它已经在 Chrome/Edge 上验证可用；
 * 引入打包器只会增加回归风险，收益却只有「语法糖」。
 */

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outDir = join(root, 'dist');

const watch = process.argv.includes('--watch');

/** 复制一个目录的内容（递归），保持结构 */
async function copyDir(from, to) {
  await cp(from, to, { recursive: true });
}

/** 递归列出目录下所有文件（相对路径） */
async function listFiles(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, rel)));
    else out.push(rel);
  }
  return out;
}

async function buildCore() {
  await build({
    entryPoints: [join(srcDir, 'core', 'core.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'MXTCore',
    platform: 'browser',
    target: ['chrome110', 'edge110'],
    outfile: join(outDir, 'core.js'),
    banner: {
      js: '/* 译点 · 共享核心（自动生成，请改 src/core/*.ts 后重新构建）*/'
    },
    logLevel: 'warning'
  });
  console.log('  ✓ core.js');
}

async function buildExtension() {
  const from = join(srcDir, 'extension');
  const to = join(outDir);
  await copyDir(from, to);
  console.log('  ✓ extension/');
}

async function writeManifestMeta() {
  /* 在 manifest 里不写死 core.js —— 后台脚本用 importScripts 加载，
     这里只做一次校验：确认 manifest 是合法的 MV3 且引用了后台脚本。 */
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('dist/manifest.json 缺失');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3) {
    throw new Error(`manifest_version 必须是 3，实际是 ${manifest.manifest_version}`);
  }
  if (!manifest.background?.service_worker) {
    throw new Error('manifest 缺少 background.service_worker');
  }
  /* 所有 manifest 引用的文件都必须真实存在，否则 Chrome 加载会静默失败 */
  const missing = [];
  const referenced = [
    manifest.background.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.icons ? Object.values(manifest.icons) : []),
    ...(manifest.action?.default_icon ? Object.values(manifest.action.default_icon) : []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])])
  ].filter(Boolean);
  for (const rel of referenced) {
    if (!existsSync(join(outDir, rel))) missing.push(rel);
  }
  if (missing.length) {
    throw new Error(`manifest 引用了不存在的文件：\n  - ${missing.join('\n  - ')}`);
  }
  console.log(`  ✓ manifest 校验通过（${referenced.length} 个引用文件）`);
}

async function main() {
  console.log('构建 译点 扩展…');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await buildCore();
  await buildExtension();
  await writeManifestMeta();

  const files = await listFiles(outDir);
  const total = (
    await Promise.all(files.map(async f => (await stat(join(outDir, f))).size))
  ).reduce((a, b) => a + b, 0);
  console.log(`\n完成：dist/ 共 ${files.length} 个文件，${(total / 1024).toFixed(1)} KB`);
  console.log('在 chrome://extensions/ 打开开发者模式 → 加载已解压的扩展程序 → 选 dist/');
}

await main();
