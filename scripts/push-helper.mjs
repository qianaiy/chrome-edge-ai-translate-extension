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

/**
 * github.com 可用的 IP —— 这个网络环境里 DNS 给出的地址连不上 443，
 * 但 api.github.com 正常。可以用 MXT_GITHUB_IP 覆盖。
 * 注意：这条链路时好时坏，所以下面有重试。
 */
const RESOLVED_IP = process.env.MXT_GITHUB_IP || '20.27.177.113';

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
  /* ---- 1. 先确认 token 有没有写权限，别推了半天才失败 ----
     探针走一条专门的临时分支，绝不碰 main —— 否则每次跑都会在 main 上
     留下两个「probe / remove probe」提交，把 main 的历史弄脏。 */
  const PROBE_BRANCH = 'mxt-push-probe';
  console.log('检查 token 写权限 …');

  const baseRef = await api('/git/ref/heads/main');
  const baseSha = baseRef.ok ? baseRef.json.object.sha : null;
  if (!baseSha) {
    console.error('  ✗ 读不到 main 分支，无法建立探针分支');
    process.exit(1);
  }

  /* 删掉可能残留的旧探针分支 */
  await api(`/git/refs/heads/${PROBE_BRANCH}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  });

  const mkBranch = await api('/git/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${PROBE_BRANCH}`, sha: baseSha })
  });
  if (!mkBranch.ok) {
    console.error(`  ✗ 建探针分支失败：${mkBranch.json?.message || mkBranch.text}`);
    process.exit(1);
  }

  const probe = await api('/contents/.push-probe', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'probe',
      content: Buffer.from('probe', 'utf8').toString('base64'),
      branch: PROBE_BRANCH
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
    /* 清理探针分支再退出 */
    await api(`/git/refs/heads/${PROBE_BRANCH}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    process.exit(1);
  }
  console.log('  ✓ token 有写权限');

  /* ---- 2. 删掉探针分支（main 始终没被动过） ---- */
  try {
    await api(`/git/refs/heads/${PROBE_BRANCH}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('  ✓ 探针分支已清理');
  } catch {
    console.log(`  ! 探针分支未能清理，请手动删除 ${PROBE_BRANCH}`);
  }

  /* ---- 3. 推送（这条链路时好时坏，重试几次） ---- */
  const dir = mkdtempSync(join(tmpdir(), 'mxt-askpass-'));
  const askpass = join(dir, 'askpass.cmd');
  writeFileSync(askpass, `@echo off\r\necho ${token}\r\n`, 'utf8');

  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    /* 用环境变量传 -c 参数：在 Windows 上 shell:true 会把 "key=value" 里的
       等号和引号搅乱，导致这个覆盖没生效、git 又连回那个坏 IP。 */
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.curloptResolve',
    GIT_CONFIG_VALUE_0: `github.com:443:${RESOLVED_IP}`
  };

  const ATTEMPTS = 4;
  let push = { status: 1 };
  for (let i = 1; i <= ATTEMPTS; i++) {
    console.log(`推送 ${branch} → ${remote} （第 ${i}/${ATTEMPTS} 次）…`);
    push = spawnSync('git', ['push', '-u', remote, branch], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: true
    });
    if (push.status === 0) break;
    if (i < ATTEMPTS) {
      console.log('  连接失败，等一下重试…');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (push.status !== 0) {
    console.error('');
    console.error('推送失败。已删除临时凭据脚本。');
    rmSync(dir, { recursive: true, force: true });
    process.exit(push.status || 1);
  }

  /* ---- 4. 用 API 校验（api.github.com 比 github.com 稳） ---- */
  console.log('');
  const verify = await api(`/branches/${encodeURIComponent(branch)}`);
  if (verify.ok) {
    console.log(`完成。远端 ${branch} = ${verify.json.commit.sha}`);
  } else {
    console.log('推送已完成，但校验失败，请手动确认。');
  }

  rmSync(dir, { recursive: true, force: true });
  process.exit(verify.ok ? 0 : 1);
}
await main();
