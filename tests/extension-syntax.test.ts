import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 扩展脚本的语法检查。
 *
 * 扩展本体是免构建的原生 JS，语法错误不会在构建期暴露 ——
 * 只能等到浏览器加载时才发现，表现为「扩展加载失败」或者「点了没反应」。
 * 所以这里用 Node 的解析器把每个脚本过一遍。
 */

const EXT = join(process.cwd(), 'src', 'extension');

async function listJs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJs(p)));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('扩展脚本语法', () => {
  it('每个脚本都能被解析', async () => {
    const files = await listJs(EXT);
    expect(files.length).toBeGreaterThan(4);

    const vm = await import('node:vm');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      try {
        new vm.Script(src, { filename: f });
      } catch (e) {
        throw new Error(`${f} 语法错误：${(e as Error).message}`);
      }
    }
  });
});

describe('dist 产物', () => {
  it('构建后每个脚本都能被解析', async () => {
    const dist = join(process.cwd(), 'dist');
    let exists = true;
    try {
      await stat(dist);
    } catch {
      exists = false;
    }
    if (!exists) return; // 没构建就跳过

    const files = await listJs(dist);
    expect(files.length).toBeGreaterThan(4);

    const vm = await import('node:vm');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      try {
        new vm.Script(src, { filename: f });
      } catch (e) {
        throw new Error(`${f} 语法错误：${(e as Error).message}`);
      }
    }
  });
});

describe('manifest 引用完整', () => {
  it('manifest 里引用的文件都存在', async () => {
    const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
    const refs: string[] = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.options_ui?.page,
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
      ...(manifest.content_scripts || []).flatMap((cs: any) => [...(cs.js || []), ...(cs.css || [])])
    ].filter(Boolean) as string[];

    expect(refs.length).toBeGreaterThan(5);
    for (const r of refs) {
      let ok = true;
      try {
        await stat(join(EXT, r));
      } catch {
        ok = false;
      }
      expect(ok, `manifest 引用了不存在的文件：${r}`).toBe(true);
    }
  });
});
