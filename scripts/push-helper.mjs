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
import { request as httpsRequest } from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'qianaiy/chrome-edge-ai-translate-extension';
const API = `https://api.github.com/repos/${REPO}`;

/**
 * github.com 的可用 IP —— 这个网络环境里 DNS 给出的地址连不上 443，
 * 但 api.github.com 正常。可以用 MXT_GITHUB_IP 强制指定。
 *
 * 以前这里是**一个写死的 IP**，结果那个 IP 死掉之后推送就整个不能用了，
 * 而报错信息只说「连不上 443」，看不出是 IP 过期而不是网络断了。
 * 现在每次先探测一轮，挑第一个真的能完成 TLS 握手的。
 *
 * 注意：TCP 通不代表能用 —— 中间可能只放行特定 SNI/线路。
 * 所以探测要带 servername 做真实 TLS，光测端口会选到假可用的 IP。
 */
const IP_CANDIDATES = [
  '140.82.113.3',
  '140.82.114.3',
  '140.82.116.3',
  '20.205.243.166',
  '20.27.177.113',
  '20.200.245.247',
  '140.82.112.3',
  '140.82.121.3'
];

/**
 * 探一个 IP 能不能真的和 github.com 握手。
 * 只测 TCP 端口不够：中间设备可能只放行特定线路，端口通但 TLS 被掐，
 * 选到那种 IP 会得到一个和「IP 已经死了」一模一样的报错。
 */
function probeIp(ip, timeoutMs = 6000) {
  return new Promise(done => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      done(ok);
    };
    const req = httpsRequest(
      {
        host: ip,
        port: 443,
        servername: 'github.com',
        path: '/',
        method: 'HEAD',
        timeout: timeoutMs,
        headers: { Host: 'github.com', 'User-Agent': 'dsh-push-helper' },
        /* 探测只关心「能不能通」，不关心证书链 */
        rejectUnauthorized: false
      },
      res => {
        res.resume();
        finish(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

async function pickReachableIp() {
  const forced = String(process.env.MXT_GITHUB_IP || '').trim();
  if (forced) {
    const ok = await probeIp(forced);
    console.log(ok ? `  指定 IP ${forced} 可用` : `  ! 指定 IP ${forced} 探测不通，仍按它尝试`);
    return forced;
  }
  for (const ip of IP_CANDIDATES) {
    const ok = await probeIp(ip);
    console.log(`  探测 ${ip} … ${ok ? '通' : '不通'}`);
    if (ok) return ip;
  }
  return null;
}

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

  /* ---- 3. 推送（这条链路时好时坏，先挑一个真能连上的 IP，再重试几次） ---- */
  console.log('寻找可用的 github.com 地址 …');
  const resolvedIp = await pickReachableIp();

  const dir = mkdtempSync(join(tmpdir(), 'mxt-askpass-'));
  const askpass = join(dir, 'askpass.cmd');
  writeFileSync(askpass, `@echo off\r\necho ${token}\r\n`, 'utf8');

  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
  /* 用环境变量传 -c 参数：在 Windows 上 shell:true 会把 "key=value" 里的
     等号和引号搅乱，导致这个覆盖没生效、git 又连回那个坏 IP。 */
  if (resolvedIp) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.curloptResolve';
    env.GIT_CONFIG_VALUE_0 = `github.com:443:${resolvedIp}`;
    console.log(`  使用 ${resolvedIp}`);
  } else {
    console.log('  ! 没有探测到可用地址，先按系统 DNS 尝试');
  }

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
