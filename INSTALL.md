# 安装指南

把「译点」装进 Chrome / Edge，三分钟。

---

## Chrome

### 1. 构建

在项目根目录（`默认项目`）执行：

```bash
npm install      # 第一次才需要
npm run build
```

输出 `完成：dist/ 共 15 个文件` 即成功。

### 2. 加载

1. 地址栏输入 `chrome://extensions/` 回车
2. 右上角打开 **开发者模式**
3. 点左上角 **加载已解压的扩展程序**
4. 选中 **`dist`** 文件夹 → 确定

> ⚠️ 选**文件夹**，不是选文件。选到 `dist` 这一层——它里面要有 `manifest.json`。
> 选成 `dist/src` 或 `dist/extension` 会报 manifest 解析失败。

### 3. 配置

点工具栏的扩展图标（可能在「拼图」图标里，要点一下钉到工具栏）：

- 弹窗提示「还没填 API Key」→ 点 **设置**
- 填 **Base URL**、**API Key**、**模型**
- 点 **测试连接**，通了再点 **保存**

---

## Edge

1. 地址栏输入 `edge://extensions/`
2. 左下角打开 **开发人员模式**
3. 点 **加载解压缩的扩展**
4. 选 `dist` 文件夹

配置步骤和 Chrome 一样。

---

## 配置项说明

| 项 | 填什么 | 说明 |
|---|---|---|
| **Base URL** | OpenAI 兼容接口地址 | **不要**带 `/chat/completions`。只填域名也行，路径会自动补 |
| **API Key** | 你的密钥 | 用本地 Ollama / LM Studio 就留空 |
| **模型** | 模型名 | 内置预设会帮你填好，也能手打 |
| **目标语言** | 默认简体中文 | 弹窗里可以临时改 |
| **温度** | 建议 0 ~ 0.2 | 翻译是确定性任务，温度高了模型会自作主张改写 |
| **附加要求** | 可选 | 术语保留策略、人称统一等，对翻译质量影响很大 |

### 内置服务商预设

选完自动填 Base URL 和模型：

| 服务商 | Base URL | 推荐模型 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-pro` |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen2.5:7b` |
| LM Studio 本地 | `http://127.0.0.1:1234/v1` | 本地已加载的模型 |

共 22 家，完整列表见设置页。

**协议不用你操心** —— OpenAI 兼容 / Anthropic / Gemini 三种格式自动识别，
连猜错时会自动换协议重试。

---

## 用法

| 操作 | 快捷键 / 方式 |
|---|---|
| 划词翻译 | 选中文字 → 点浮出的「译」 |
| 右键翻译 | 选中文字 → 右键 → 翻译「…」 |
| 翻译正文 | `Alt+T` |
| 翻译整页（含侧栏页脚） | `Alt+W` |
| 还原原文 | 再按一次 `Alt+T` |
| 仅译文 / 双语对照 | `Alt+Y` |
| 翻译视频字幕 | `Alt+S` |
| 翻漫画 | 弹窗里「翻漫画」 |

快捷键被别的软件占了就去 `chrome://extensions/shortcuts` 改。

### 整页翻译的两种显示

- **双语对照**（默认）：译文插在每段原文下面，原文不动。适合精读校对。
- **仅译文**：把原文直接换成译文，元素/字号/行高全不动，看起来像原生中文页面。适合截图分享。

---

## 改代码后

| 改了什么 | 要做什么 |
|---|---|
| `src/extension/**` | 到扩展管理页点扩展卡片上的**刷新**（圆形箭头） |
| `src/core/**` | 先 `npm run build`，再刷新扩展 |

---

## 常见问题

**Q：按钮是灰的？**
开发者模式没打开。

**Q：提示 manifest 解析失败？**
选错文件夹了。要选含 `manifest.json` 的那一层，也就是 `dist`。

**Q：装上了但页面上没反应？**
内容脚本只对 `http/https` 页面生效。`chrome://` 页面、扩展商店页面都不行。

**Q：划词气泡不出现？**
确认装的是最新版——在扩展管理页点「详细信息」看版本号应该是 1.7.7。

**Q：一直报 401？**
API Key 没填或填错。用本地模型的话要确认 Base URL 指向 `localhost:11434`（Ollama）。

**Q：能删掉 dist 文件夹吗？**
不能。解压版扩展直接从磁盘读，文件夹挪走扩展就失效了。重新 `npm run build` 可以重建。

**Q：会不会把我的网页内容传出去？**
只有你**主动**触发翻译时（划词、快捷键、弹窗按钮），被选中的那部分文本才会发到你配置的接口。
不会后台自动抓取整页。API Key 只存在 `chrome.storage.local`，只在本机，不随账号同步。

**Q：怎么更新？**
拉新代码 → `npm install && npm run build` → 扩展管理页点刷新。
