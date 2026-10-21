# 翻译质量评测

改提示词、换模型之后，翻译是变好还是变坏？靠感觉判断不算数 —— 这套脚本给你一个可复现的数字。

跑一遍要回答的问题只有一个：**同一个用例集，换个提示词或换个模型，通过率变了没有。**

---

## 快速开始

### 离线自检（不联网，先确认流水线本身没坏）

```powershell
node eval/run.mjs --dry-run
```

用 `eval/expected.json` 里人工写的「参考答案」跑一遍全部用例。
它验证的是评测流水线（打分器、解析器、用例校验、报告输出）是否正常，
**不衡量任何真实模型**。正常情况下输出 44/44 通过、退出码 0。

### 实时评测（打真实接口）

```powershell
$env:MXT_BASE_URL = "https://api.deepseek.com/v1"   # 你自己的接口
$env:MXT_API_KEY  = "你的 API Key"                  # 本地服务可以留空
$env:MXT_MODEL    = "deepseek-chat"

node eval/run.mjs
```

密钥只从环境变量读，仓库里没有任何硬编码密钥。

---

## 命令行用法

```
node eval/run.mjs [--dry-run] [--cases <id,id>] [--out <path>] [--batch <n>]
```

| 选项 | 说明 |
|---|---|
| `--dry-run` | 不联网，用 `eval/expected.json` 离线跑一遍 |
| `--cases <id,id>` | 只跑指定用例，逗号分隔，按 id 精确匹配 |
| `--out <path>` | 报告输出路径，默认 `eval/reports/<时间戳>.json` |
| `--batch <n>` | 每批多少条（默认 6，最大 20） |
| `--help` | 用法说明 |

### 环境变量

| 变量 | 是否必需 | 说明 |
|---|---|---|
| `MXT_BASE_URL` | 实时评测必需 | OpenAI 兼容接口地址 |
| `MXT_API_KEY` | 远程服务必需，本地服务可空 | 接口密钥 |
| `MXT_MODEL` | 实时评测必需 | 模型名 |
| `MXT_TARGET_LANG` | 可选 | 目标语言，默认「简体中文」 |
| `MXT_PROTOCOL` | 可选 | `auto` / `openai` / `anthropic` / `gemini`，默认 `auto` |
| `MXT_EXTRA_PROMPT` | 可选 | 追加到系统提示词末尾的要求 |
| `MXT_TEMPERATURE` | 可选 | 采样温度，默认 `0.2`（与扩展一致） |

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 全部通过 |
| `1` | 有用例没通过 |
| `2` | 配置问题（没配接口、参数非法、用例 id 不存在） |
| `3` | 运行出错（网络、解析） |

没配接口时脚本会打印清楚的提示并以 `2` 退出，**不会抛栈**：

```
✗ 没有配置评测接口，本次不跑。
  缺少的环境变量：MXT_BASE_URL、MXT_MODEL
  ...
  想先看看评测流水线跑不跑得通，用离线模式：
    node eval/run.mjs --dry-run
```

---

## 评测测的是什么

**测的是模型「不听话」的地方，不是「译得好不好」。**

「地道不地道」没法自动判定，也没法复现 —— 今天觉得好的译文，明天换个模型就说不清了。
所以这套评测只做能自动判、且贴近真实故障的检查：

| 检查项 | 判定 | 为什么要有 |
|---|---|---|
| `notEmpty` | 译文非空 | 模型拒答、超时、被截断 |
| `placeholders` | `mustKeep` 里的每一项都原样出现 | 提示词第 4、6 条明确承诺「占位符原样保留」，这是最常见的翻车点 |
| `unchanged` | 原文已是目标语言时，译文必须与原文一致 | 提示词第 5 条：已是目标语言就原样返回 |
| `lengthRatio` | 译文/原文长度比落在 `[0.15, 6]` | 粗筛截断与复读。区间取得很宽，因为中文压缩率天然比英文高 |
| `copySource` | 译文不能和原文一样，也不能复读原文 | 模型不翻译、直接把原文吐回来 —— 长度比抓不到（1:1 正好在区间里），所以单列 |
| `markerLeak` | 译文里不该残留 `<<<n>>>` | 标记泄漏会让扩展切段错位 |

不适用某项检查时，该项标记为 `skipped`（跳过）而不是失败 —— 比如非目标语言原文不做 `unchanged` 判定，
很短的原文不做长度比判定（统计上没有意义）。

### 为什么用「必须保留的子串」而不是正则

`mustKeep` 是一组**必须原样出现的子串**，比如 `{name}`、`%s`、`{{1}}`、`https://example.com/docs`、
`support@example.com`、`ECONNRESET`。

不用正则是因为正则匹配本身容易写错（转义、贪婪），写错一个正则就会让整条用例的分数失真，
而且这种失真是静默的。子串判定简单到一眼能看出对不对。

### 为什么长度比只是一个粗筛

长度比**不是**翻译质量指标。中文压成英文通常在 0.6 左右，反过来能到 1.5，
不同语言差异很大，区间取得很宽，只用来抓「只翻了一半」和「复读机」这两种极端情况。
真正的质量判断交给 `mustKeep` 和 `unchanged` 这两项硬指标。

### 通过率怎么读

- **≥ 95%**：这个提示词/模型在这批用例上基本没问题。
- **85%–95%**：能用，但有明确的翻车点 —— 看失败用例集中在哪个分类。
- **< 85%**：先别上线，看看 `placeholders` 是不是大面积失败（多半是提示词问题，不是模型问题）。

**按分类看比看总数有用得多。** 总数掉 10% 可能是 44 条里某一条长用例截断；
但如果 `placeholder` 这一类掉了一半，那是提示词里关于占位符的约束不够硬，该改提示词而不是换模型。

比较两个版本时，**同一条用例的变化**比聚合数字更有价值：

```powershell
node eval/run.mjs --cases ph-01-curly-name,ph-04-double-brace --out reports/after.json
```

---

## 用例集

`eval/cases.json`，44 条，分 7 类。每条用例的字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一 id，`--cases` 用它筛选，报告里用它定位 |
| `category` | 分类，见下表 |
| `source` | 待翻译原文 |
| `targetLang` | 目标语言（写法跟扩展设置页一致） |
| `mustKeep` | 必须原样出现的子串数组，没有就写 `[]` |
| `alreadyTarget` | 原文已是目标语言 —— 这类要求原样返回。不写这个字段就不做「必须原样」的判定 |
| `note` | 备注，只给人看 |

| 分类 | 条数 | 测什么 |
|---|---|---|
| `plain` | 8 | 普通散文：通知、邮件、商品描述、路线指引 |
| `placeholder` | 7 | 占位符：`{name}`、`%s`、`<tag>`、`{{1}}`、ICU 复数表达式、模板字面量 |
| `code` | 7 | 代码与命令、错误码、URL、邮箱、路径、查询串 |
| `already-target` | 7 | 原文已是目标语言（中文/英文/日文），必须原样返回 |
| `long` | 4 | 长段落，检查被不被截断；其中一条整段全是占位符 |
| `mixed` | 4 | 中英混排：中文夹英文标识符、英文夹中文 |
| `tricky` | 7 | HTML 片段、Markdown、emoji、HTML 实体、极短片段、纯数字 |

`mustKeep` 里的每一项都必须在 `source` 里真实存在 —— `eval/score.ts` 的 `validateCases()` 会检查，
不存在的直接报错，因为那种用例永远过不了，会静默拉低通过率。

---

## 加一条新用例

1. 编辑 `eval/cases.json`，在数组里加一条：

   ```json
   {
     "id": "plain-09-new-hint",
     "category": "plain",
     "source": "Your verification code is 123456. It expires in 10 minutes.",
     "targetLang": "简体中文",
     "mustKeep": ["123456"],
     "note": "短信验证码，数字要保住"
   }
   ```

2. 想让离线自检也覆盖它，就在 `eval/expected.json` 里加一行同名 key（值是参考答案）。
   不加的话这条用例在 `--dry-run` 下会因为译文为空而失败 —— 这是故意的，提醒你补参考答案。

3. 跑一下确认没写错：

   ```powershell
   node eval/run.mjs --dry-run --cases plain-09-new-hint
   ```

### 写用例的几条经验

- **id 要能看懂**。`ph-04-double-brace` 比 `case-17` 有用得多 —— 报告里一眼就知道是哪个场景挂了。
- **`mustKeep` 只放真正必须原样的东西**。放太多会让用例变成「逐字比对」，测的就不是翻译了。
- **`alreadyTarget` 要显式写**。不写的话这条用例不会被要求原样返回，中文原文被乱翻也测不出来。
- **一条用例只测一件事**。想同时测占位符和长段落，就拆成两条。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `eval/cases.json` | 用例集 |
| `eval/expected.json` | 参考答案，`--dry-run` 用。人工写的「一个听话的模型应该返回什么」 |
| `eval/score.ts` | 评测入口：重新导出 `src/core/eval.ts` 的能力，外加用例校验、批量请求拼装、批量回复解析 |
| `eval/run.mjs` | 命令行 |
| `eval/load-core.mjs` | 用 esbuild 把 TypeScript 核心打成内存里的 ESM 再加载 |
| `eval/reports/` | 生成的报告（已 gitignore） |

### 为什么要 `load-core.mjs`

`src/core` 里的模块按项目约定互相 `import './xxx.js'`（TypeScript 的 ESM 写法）。
Node 直接跑 `.ts` 时不会把 `./prompt.js` 映射到 `./prompt.ts`，会报 `ERR_MODULE_NOT_FOUND`。
所以这里用项目自带的 esbuild 把 `eval/score.ts` 打包成内存里的 ESM 再 import。

这样做的额外好处：**评测跑的和扩展跑的是同一份代码**，不存在「评测用一套解析、线上用另一套」的偏差。

---

## 和扩展的关系

评测复用了扩展的实现：

- **提示词** —— `src/core/prompt.ts` 的 `systemPrompt()`
- **请求构造** —— `src/core/protocol.ts` 的 `buildRequest()`
- **响应解析** —— `src/core/protocol.ts` 的 `extractText()`
- **分段解析** —— 照抄 `src/core/prompt.ts` 的 `parseMarked()` 与扩展后台 `translateChunk()` 的兜底逻辑

所以评测测到的「模型丢占位符」「模型不按编号返回」，都是用户在页面上真实会遇到的故障。

评分实现在 `src/core/eval.ts`，是纯函数、不联网、不碰 `chrome.*`，
也从 `src/core/core.ts` 导出了 —— 扩展将来想在自己设置页里加个「自检」按钮，直接用就行。

---

## 常见问题

**Q：报告里的 `endpoint.url` 显示的是我填的地址吗？**
A：不是，是 `describeEndpoint()` 归一化之后的完整地址（会补 `/v1` 之类的路径）。
这是扩展实际会请求的地址。

**Q：为什么实时评测是分批发的？**
A：扩展本身就是分批翻译（后台 `translateChunk`），而且批量能测出「模型不按 `<<<n>>>` 编号返回」这个真实故障。
一批里的某段漏了，脚本会照扩展的做法逐条重试 —— 这一步测的正是「模型第一次没听话时兜底能不能救回来」。

**Q：模型返回的 JSON 包着译文会怎样？**
A：`parseModelOutput()` 会优先尝试按 JSON 数组解析（模型经常爱把结果包成 JSON），
再退回按 `<<<n>>>` 标记切，最后按行切。三条路都覆盖了。

**Q：能不能只跑某一类？**
A：`--cases` 按 id 精确匹配，不支持分类名。要跑某一类，先从 `eval/cases.json` 里把 id 挑出来。
