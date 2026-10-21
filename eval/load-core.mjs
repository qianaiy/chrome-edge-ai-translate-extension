/**
 * 把 TypeScript 的评测核心加载进 Node
 * ------------------------------------------------------------------
 * 为什么需要这一步：
 *   src/core 里的模块按项目约定互相 import './xxx.js'（TypeScript 的
 *   ESM 写法，保证编译产物路径正确）。Node 直接跑 .ts 时不会把
 *   './prompt.js' 映射到 './prompt.ts'，会报 ERR_MODULE_NOT_FOUND。
 *   所以这里用项目自带的 esbuild 把 eval/score.ts 打包成一份内存里的
 *   ESM 再 import —— 打包出来的代码和扩展里跑的是同一份逻辑。
 *
 * 用 data: URL 载入，不落盘、不写工作区、不依赖临时目录权限。
 * 只依赖 esbuild（devDependency），不联网。
 */

import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..');

/**
 * 打包并加载评测核心。
 * @returns {Promise<any>} eval/score.ts 的导出
 */
export async function loadEvalCore() {
  const result = await build({
    entryPoints: [joinPath(root, 'eval', 'score.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    write: false,
    logLevel: 'silent'
  });

  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error('esbuild 没有产出代码，评测核心加载失败');

  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
  return import(url);
}

/** 拼路径（Windows 下要用反斜杠，path.join 干这事正好） */
function joinPath(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}
