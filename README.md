# 译点 · Chrome/Edge AI 翻译扩展

一个 Chrome / Edge 通用 AI 翻译扩展：划词翻译、整页双语对照、视频字幕翻译、漫画翻译，
翻译请求直接发到你自己的 OpenAI 兼容接口。**无订阅、无额度限制、密钥只存本机。**

> 扩展的完整使用说明在 [`src/extension/README.md`](src/extension/README.md)（中文）。
> 本文件讲的是**仓库结构**和**怎么开发**。

---

## 当前状态

| 阶段 | 范围 | 状态 |
|---|---|---|
| P0 | 最小可运行版本（弹窗 / 划词翻译 / API 配置 / 原文切换 / 错误提示） | ✅ 已实现 |
| P1 | 网页段落翻译、双语对照、DOM 动态更新、批量翻译、本地缓存、一键还原 | ✅ 已实现 |
| P1 | 视频字幕提取、VTT/SRT 解析、双语字幕上屏 | ✅ 已实现 |
| P2 | 漫画图片选择、OCR 取文、上下文翻译、译文覆盖层 | ✅ 已实现（擦字/修复待做） |
| P3 | 质量评测集、失败案例记录、新旧版本对比 | 🔜 进行中 |

扩展本体是 **Manifest V3 + 免构建的原生 JavaScript**，已经在 Chrome / Edge 上验证可用。
共享核心（`src/core/`）是 **TypeScript**，有完整单元测试。

---

## 仓库结构

```
.
├── src/
│   ├── core/            共享核心：与浏览器无关的纯逻辑，可独立复用
│   │   ├── provider.ts  服务商识别 / Base URL 归一化 / 协议推断
│   │   ├── protocol.ts  三种协议的请求构造与响应解析
│   │   ├── prompt.ts    翻译提示词与分段标记解析
│   │   ├── subtitle.ts  WebVTT / SRT 解析与时间轴格式化
│   │   └── core.ts      统一导出入口
│   └── extension/       扩展本体（原生 JS，直接加载，无构建步骤）
│       ├── manifest.json
│       ├── background.js    后台：配置、协议识别、调用模型、缓存
│       ├── content/         内容脚本：划词气泡 / 整页注入 / 字幕 / 漫画
│       ├── popup/           弹窗
│       ├── options/         设置页
│       └── icons/
├── tests/               单元测试 + 回归测试 + 扩展与核心的一致性测试
├── scripts/
│   ├── build.mjs        构建 dist/（可加载的扩展目录）
│   ├── smoke.mjs        浏览器冒烟测试（Chrome / Edge）
│   └── secret-scan.mjs 敏感信息扫描
└── .github/workflows/   CI
```

**为什么核心和扩展分开？**
扩展本体是已经在浏览器里验证过的代码，把它改成构建产物只会平白增加回归风险。
所以做法是：把其中「与浏览器无关的纯逻辑」抽到 `src/core/`，用 TypeScript 重写并单测，
再用 `tests/integration.test.ts` 断言**扩展里的同名函数与核心库行为完全一致**——
两边一旦漂移，测试立刻失败。

---

## 开发

```bash
npm install          # 安装依赖
npm run typecheck    # TypeScript 严格类型检查
npm test             # 单元测试（vitest）
npm run build        # 产出 dist/，可直接加载的扩展目录
npm run verify       # typecheck + test + build 全跑一遍
npm run lint:secrets # 敏感信息扫描
npm run smoke        # 浏览器冒烟测试（Chrome）
npm run smoke:edge   # 浏览器冒烟测试（Edge）
npm run smoke:all    # 两个浏览器都跑
```

### 浏览器冒烟测试

`npm run smoke` 会用 CDP 真正把扩展装进浏览器，验证：

- 扩展能加载，后台 service worker 注册成功
- `mxt:getSettings` / `mxt:version` / `mxt:detect` 有正确响应
- 缺 API Key 时给的是友好提示，不是崩溃也不是裸 401
- 未知消息类型不会抛错
- 内容脚本在真实网页上注入成功，且**没有破坏网页内容**

> Chrome 137+ 已经忽略 `--load-extension` 命令行开关，所以脚本走 CDP 的
> `Extensions.loadUnpacked`（要连 **browser 级** WebSocket，page target 上没这个方法）。
> 消息必须从扩展页面发出——service worker 给自己发消息，它自己的
> `onMessage` 监听器收不到。

### 装载扩展

**方式一：直接加载源码**（改完即生效，不用构建）

```
chrome://extensions/  →  开发者模式  →  加载已解压的扩展程序  →  选 src/extension/
```

Edge 用 `edge://extensions/`，步骤相同。

**方式二：加载构建产物**

```
npm run build  →  加载已解压的扩展程序  →  选 dist/
```

`npm run build` 会校验 `manifest.json` 引用的每个文件都真实存在——
Chrome 在文件缺失时会静默失败，这个校验能在构建期就暴露出来。

---

## 配置

扩展本体是免构建的，改完直接刷新扩展即可。核心库改完需要 `npm run build`。

### 密钥

扩展跑在浏览器里，没有环境变量。
**API Key 只存在 `chrome.storage.local`，只在本机，不随账号同步。**

仓库里绝不能出现真实密钥。提交前跑一次：

```bash
npm run lint:secrets
```

CI 也会跑这一步。仓库已忽略 `.env` / `.env.*`（`.env.example` 除外）。

---

## 翻译引擎

支持三种协议，识别顺序：**显式指定 → 上次成功的协议 → URL/模型名启发式 → 依次回退**。

| 协议 | 路径 | 鉴权 | system 放哪 |
|---|---|---|---|
| OpenAI 兼容 | `/chat/completions` | `Authorization: Bearer` | messages 里 |
| Anthropic | `/v1/messages` | `x-api-key` | 顶层 `system` 字段 |
| Gemini | `/v1beta/models/{model}:generateContent` | `?key=` 查询参数 | `systemInstruction` |

响应解析**不依赖协议**：`choices[].message.content`、`content[].text`、
`candidates[].content.parts[].text` 三种形状哪个有内容就读哪个。
所以只要接口吐出这三种形状之一就能用。

内置 22 家服务商预设（OpenAI / DeepSeek / 硅基流动 / 智谱 / 百炼 / 火山方舟 / Ollama …），
只填域名时自动补路径，识别不了也能手打 Base URL。

---

## 开发约定

1. **一次只推进一组有明确依赖的任务。**
2. **分支开发，不直接改 `main`。** 本仓库的开发基线在 `feature/p0-baseline`。
3. **新功能必须能构建、能测试。** `npm run verify` 必须绿。
4. **不许硬编码或提交密钥。**
5. **第三方网页内容发给翻译 API 前要有明确的用户操作触发**——扩展里的翻译全部是
   用户主动点击（划词气泡、快捷键、弹窗按钮），不做后台自动抓取。
6. **发布前检查权限和隐私要求。** 当前权限：
   `storage` / `contextMenus` / `activeTab` / `scripting` / `webNavigation`，
   `host_permissions: <all_urls>`（整页翻译需要）。发布到商店前需要复核
   `<all_urls>` 的用途说明，并补充隐私政策（用户数据只在本机，不上传）。

---

## 许可

MIT
