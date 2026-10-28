/**
 * 敏感信息扫描
 * ------------------------------------------------------------------
 * 在提交前扫描仓库里可能被误提交的东西：
 *   - 各家 AI 服务的 API Key
 *   - GitHub / AWS / Slack 等 token
 *   - 私钥文件
 *
 * 用法：node scripts/secret-scan.mjs [要扫描的目录...]
 * 退出码：0 = 干净，1 = 发现疑似密钥
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.acl-recovery', '.vite', '_bili-handoff']);
const SKIP_FILES = new Set(['package-lock.json']);

const NUL = String.fromCharCode(0);

/** 各类密钥的特征 */
const PATTERNS = [
  { name: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Anthropic 密钥', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Google API Key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: 'AWS Access Key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: '疑似硬编码的 apiKey 值',
    /* 值本身单独成组：占位符判断要看的是「值」，不是整条 `apiKey: '...'` */
    re: /["']?(?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi
  }
];

/** 明显是占位符 / 示例的值，不算泄漏 */
const PLACEHOLDER = [
  /^(your|my|example|test|dummy|fake|sample|placeholder|xxx+)/i,
  /^(请填|填写|你的|示例|占位)/,
  /^<.*>$/,
  /^\$\{.*\}$/,
  /^(sk-|pk-)?(xxx|your[-_]?key)/i,
  /^(process\.env|import\.meta\.env)/,
  /^undefined$|^null$/i
];

function isPlaceholder(line) {
  return PLACEHOLDER.some(p => p.test(line.trim()));
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      yield abs;
    }
  }
}

/**
 * 「可能被提交的文件」= 已跟踪 + 未跟踪但没被 .gitignore 排除的。
 * 这才是「会不会进仓库」的真实集合。被忽略的本地文件（会话转写、构建产物）
 * 本来就不可能提交；把它们算进来只会让扫描频繁误报，最后逼人加白名单放水。
 */
async function gitVisibleFiles() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout.split(NUL).filter(Boolean).map(p => join(root, p));
  } catch {
    return null;
  }
}

async function collect(dir) {
  const out = [];
  for await (const f of walk(dir)) out.push(f);
  return out;
}

async function main() {
  const targets = process.argv.slice(2);
  const dirs = targets.length ? targets.map(t => resolve(root, t)) : [root];

  /* 显式指定目录时按目录全量扫；默认只扫 git 看得见的文件 */
  const gitFiles = targets.length ? null : await gitVisibleFiles();

  const findings = [];
  let scanned = 0;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = gitFiles
      ? gitFiles.filter(f => f === dir || f.startsWith(dir.endsWith(sep) ? dir : dir + sep))
      : await collect(dir);
    for (const file of files) {
      const rel = relative(root, file);

      /* 私钥文件单独查 */
      if (/\.(pem|key|p12|pfx)$/i.test(file)) {
        findings.push({ rel, line: 1, name: '私钥文件', snippet: '(文件本身)' });
        continue;
      }

      /* 太大或二进制就跳过 */
      const st = await stat(file);
      if (st.size > 2 * 1024 * 1024) continue;

      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue;

      scanned++;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { name, re } of PATTERNS) {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (!m) continue;
          if (isPlaceholder(m[1] || m[0])) continue;
          findings.push({
            rel,
            line: i + 1,
            name,
            snippet: line.trim().slice(0, 120)
          });
        }
      }
    }
  }

  if (findings.length) {
    console.error(`\n✗ 发现 ${findings.length} 处疑似敏感信息：\n`);
    for (const f of findings) {
      console.error(`  ${f.rel}:${f.line}  [${f.name}]`);
      console.error(`      ${f.snippet}`);
    }
    console.error('\n这些内容不应进入 Git 仓库。请移除或改用环境变量。\n');
    process.exit(1);
  }

  console.log(`✓ 未发现敏感信息（扫描了 ${scanned} 个文件）`);
}

await main();
