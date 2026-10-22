# 视觉模型可用性实测

漫画模式需要「模型看图 → 返回文字和位置」。这条链路的可靠性完全取决于所用模型是否**真的收到了图片**，而这一点从接口返回是看不出来的：模型可能礼貌地说「我无法查看图片」，也可能干脆编一段无关的话。

## 测试方法

- 输入：480×320 白底黑字合成图，两行文字 `こんにちは世界` / `漫画のテスト`
- 提示词：`识别这张图片里的所有文字，原样输出，不要解释。`
- 参数：`temperature: 0`，`max_tokens: 200`
- 端点：本地网关 `http://127.0.0.1:8326/v1`（74 个模型），图片以 base64 `image_url` 发送
- 判定：输出中是否原样出现 `こんにちは` 或 `漫画`

## 结果（2026-10-22 实测）

| 模型 | 耗时 | 结果 | 输出 |
| --- | --- | --- | --- |
| `raccoon/sn-deepseek-v4-1-flash-1017` | 2.6s | ✗ 读不到图 | `{"lines":[]}`；思考内容自述「image omitted because model accepts text only. We cannot see image.」 |
| `cline/cline-free/nemotron-3.5-super-vl` | 2.3s | ✗ 读不到图 | 抱歉，我无法查看或访问这张图片…… |
| `cline/nvidia/nemotron-3.5-super-vl:free` | 2.1s | ✗ 空回复 | （空） |
| `our-free-model/nemotron-3.5-super-vl-free` | 1.1s | ✗ 429 | 上游限流 |
| `our-free-model/nvidia/nemotron-3.5-super-vl:free` | 9.3s | ✓ 正确 | `こんにちは世界 漫画のテスト` |
| `our-free-model/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 4.7s | ✓ 正确 | `こんにちは世界 漫画のテスト` |
| `our-free-model/gemini/gemini-3.5-flash` | 2.8s | ✗ **幻觉** | 「人活在世上，要学会爱自己，无论发生什么事，都不要为难自己。」 |
| `our-free-model/gemini/gemini-3.6-flash` | 5.2s | ✗ 空回复 | （空） |

## 结论

1. **这轮对话背后的 `raccoon/sn-deepseek-v4-1-flash-1017` 是纯文本模型**，网关交付时把图片剥掉了，`usage.prompt_tokens` 只有 98（纯文字）。它不能拿来做漫画识图。

2. **同名不同命名空间差别极大**。`nemotron-3.5-super-vl` 在 `cline/` 下读不到图，在 `our-free-model/` 下正常。按模型家族名挑模型不可靠，必须实测。

3. **最危险的不是报错，是幻觉**。`gemini-3.5-flash` 返回了一段通顺但完全无关的中文，接口 200、格式合法。如果这种输出被当成译文画到漫画上，用户看到的是「翻译出来了，但内容莫名其妙」。所以漫画模式必须保留「模型说的文字是否在原图里」这种可校验的环节，不能只看请求成功。

4. **上游并发有硬上限**。真实漫画页实测时遇到 `502 Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)`。免费视觉上游不能作为产品可靠性的唯一依赖。

## 对产品的影响

漫画模式现阶段只能定位为「实验功能」：能读图的模型都是免费上游，存在限流与分钟级延迟。要做到可用，需要下列之一：

- 付费或自建视觉模型（成本可控但需授权）
- **本地 OCR**（Tesseract.js 等），只把文字送翻译模型，完全绕开视觉上游——代价是版本体积增加，且对艺术字识别率有限
- 保留视觉模型但明确标注实验性，并在面板里暴露「换模型重试」

`scripts/manga-live-check.mjs` 的默认视觉模型已改为实测可用的那个，并注明原因。
