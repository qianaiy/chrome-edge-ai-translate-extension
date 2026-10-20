/**
 * 把本地 feature/p0-baseline 分支推到 GitHub。
 *
 * 为什么需要这个脚本：
 *   这个网络环境里 github.com 被 DNS 解析到了一个连不上 443 的 IP
 *   （api.github.com 正常，github.com 不正常）。所以用 git 的
 *   http.curloptResolve 强制走一个可用的 IP —— 不用改 hosts，也不用管理员权限。
 *
 * 凭据通过临时的 GIT_ASKPASS 脚本传入，用完立刻删除：
 *   - 不留在磁盘上
 *   - 不写进 git config
 *   - 不会进仓库
 *
 * 用法：node scripts/push-helper.mjs <token> [分支名]
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'qianaiy/chrome-edge-ai-translate-extension';
const API = `https://api.github.com/repos/${REPO}`;

/** github.com 可用的 IP —— api.github.com 正常，github.com 不正常，只能绕 */
const RESOLVED_IP = process.env.MXT_GITHUB_IP || '172.182.252.133';

const token = process.argv[2];
const branch = process.argv[3] || 'feature/p0-baseline';
const remote = 'origin';

if (!token) {
  console.error('用法：node scripts/push-helper.mjs <token> [分支名]');
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'dsh-push-helper',
  Accept: 'application/vnd.github+json'
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  /* ---- 1. 先确认 token 有没有写权限，别推了半天才失败 ---- */
  console.log('检查 token 写权限 …');
  const probe = await api('/contents/.push-probe', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'probe',
      content: Buffer.from('probe', 'utf8').toString('base64'),
      branch: 'main'
    })
  });

  if (!probe.ok) {
    const msg = probe.json?.message || probe.text || '未知错误';
    console.error(`  ✗ token 没有写权限：${msg}`);
    console.error('');
    console.error('  需要的是：');
    console.error('    细粒度 PAT（github_pat_ 开头）：');
    console.error('      Settings → Developer settings → Personal access tokens');
    console.error('      → Fine-grained tokens → 编辑该 token');
    console.error('      → Repository access：选中 chrome-edge-ai-translate-extension');
    console.error('      → Permissions → Repository permissions → Contents 选 Read and write');
    console.error('    经典 PAT（ghp_ 开头）：勾选 repo 权限');
    console.error('');
    console.error('  注意：令牌创建后可能需要等一两分钟才生效。');
    process.exit(1);
  }
  console.log('  ✓ token 有写权限');

  /* ---- 2. 删掉探针 ---- */
  try {
    const got = await api('/contents/.push-probe');
    if (got.ok) {
      await api('/contents/.push-probe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'remove probe', sha: got.json.sha, branch: 'main' })
      });
      console.log('  ✓ 探针已清理');
    }
  } catch {
    console.log('  ! 探针未能清理，稍后请手动删除 .push-probe');
  }

  /* ---- 3. 推送 ---- */
  const dir = mkdtempSync(join(tmpdir(), 'mxt-askpass-'));
  const askpass = join(dir, 'askpass.cmd');
  writeFileSync(askpass, `@echo off\r\necho ${token}\r\n`, 'utf8');

  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };

  console.log(`推送 ${branch} → ${remote} …`);
  const push = spawnSync(
    'git',
    ['-c', `http.curloptResolve=github.com:443:${RESOLVED_IP}`, 'push', '-u', remote, branch],
    { cwd: root, env, stdio: 'inherit', shell: true }
  );

  rmSync(dir, { recursive: true, force: true });

  if (push.status !== 0) {
    console.error('');
    console.error('推送失败。已删除临时凭据脚本。');
    process.exit(push.status || 1);
  }

  console.log('');
  console.log('完成。远端分支：');
  const ls = spawnSync('git', ['ls-remote', '--heads', remote, branch], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: 'inherit',
    shell: true
  });
  process.exit(ls.status === 0 ? 0 : 1);
}

await main();
