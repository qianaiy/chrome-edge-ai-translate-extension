import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 面板的批量翻译不依赖 DOM 也能测：withTimeout 和 runPool 是纯逻辑。
 * 这两个函数住在内容脚本里（content script 拿不到 dist/core.js），
 * 所以按仓库既定做法从源码抠出来在 Node 里跑。
 */
const SRC = readFileSync(
  join(process.cwd(), 'src', 'extension', 'content', 'comic.js'),
  'utf8'
);

function grabBalanced(src: string, name: string): string {
  /* runPool 是 async 的，抠源码时必须把 async 一起带上，否则语法非法 */
  const asAsync = src.indexOf(`async function ${name}(`);
  const start = asAsync >= 0 ? asAsync : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`comic.js 里找不到 ${name}`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的括号没配平`);
}

function build() {
  const code = [
    grabBalanced(SRC, 'withTimeout'),
    grabBalanced(SRC, 'runPool'),
    'return { withTimeout, runPool };'
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(code)() as {
    withTimeout: <T>(p: Promise<T> | PromiseLike<T>, ms: number, label?: string) => Promise<T>;
    runPool: <T>(
      items: T[],
      limit: number,
      worker: (item: T, index: number) => Promise<void>,
      shouldStop?: () => boolean
    ) => Promise<void>;
  };
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('withTimeout', () => {
  it('正常完成时原样返回结果', async () => {
    const { withTimeout } = build();
    await expect(withTimeout(Promise.resolve('好'), 1000, '识图')).resolves.toBe('好');
  });

  it('超时报错并说明等了多久', async () => {
    const { withTimeout } = build();
    const hang = new Promise(r => setTimeout(() => r('太晚'), 500));
    await expect(withTimeout(hang, 30, '识图')).rejects.toThrow('识图超时（0 秒）');
  });

  it('把底层失败原样往上抛，不吞成超时', async () => {
    const { withTimeout } = build();
    await expect(withTimeout(Promise.reject(new Error('连不上')), 1000, '识图')).rejects.toThrow(
      '连不上'
    );
  });

  it('ms 为 0 表示不设限，返回原 promise', async () => {
    const { withTimeout } = build();
    const p = Promise.resolve(1);
    expect(withTimeout(p, 0)).toBe(p);
  });

  it('超时之后底层才失败，不会冒出未处理的 rejection', async () => {
    const { withTimeout } = build();
    let failed = 0;
    const late = new Promise((_resolve, reject) => {
      setTimeout(() => {
        failed += 1;
        reject(new Error('回来后失败'));
      }, 60);
    });
    await expect(withTimeout(late, 20, '识图')).rejects.toThrow('超时');
    await wait(120);
    expect(failed).toBe(1);
  });
});

describe('runPool', () => {
  it('每一项都跑且只跑一次', async () => {
    const { runPool } = build();
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async n => {
      await wait(1);
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('同时进行的数量不超过 limit', async () => {
    const { runPool } = build();
    let flying = 0;
    let peak = 0;
    await runPool(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      flying += 1;
      peak = Math.max(peak, flying);
      await wait(5);
      flying -= 1;
    });
    expect(peak).toBe(3);
  });

  it('limit 大于总数时不会超出实际条数', async () => {
    const { runPool } = build();
    let flying = 0;
    let peak = 0;
    await runPool([1, 2], 10, async () => {
      flying += 1;
      peak = Math.max(peak, flying);
      await wait(5);
      flying -= 1;
    });
    expect(peak).toBe(2);
  });

  it('某一张抛错不会拖垮其他张', async () => {
    const { runPool } = build();
    const done: number[] = [];
    await runPool([1, 2, 3, 4], 2, async n => {
      if (n === 2) throw new Error('这张炸了');
      await wait(1);
      done.push(n);
    });
    expect(done.sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('点了停止就不再领新任务', async () => {
    const { runPool } = build();
    const done: number[] = [];
    let stop = false;
    await runPool(
      [1, 2, 3, 4, 5, 6, 7, 8],
      1,
      async n => {
        await wait(1);
        done.push(n);
        if (done.length === 2) stop = true;
      },
      () => stop
    );
    expect(done).toEqual([1, 2]);
  });

  it('空列表直接返回，不卡住', async () => {
    const { runPool } = build();
    await expect(runPool([], 3, async () => {})).resolves.toBeUndefined();
  });
});
