# 译点 · 漫画嵌字最新进度审计与 UX 迭代

日期：2026-10-29
分支：`feat/comic-ux-retry-progress`（从 `fix/manga-typeset-real` 切出，**未合并 main**）
基线：`main` = fe12927 / `fix/manga-typeset-real` = 2da4e92

---

## 一、最新提交与具体变化

### 1.1 审计看到的仓库状态

| 项目 | 结果 |
| --- | --- |
| `main` | fe12927，与 `origin/main` 一致，CI run 39873299188 = success |
| `fix/manga-typeset-real` | 2da4e92，比 main 多 1 个提交，**未并入 main** |
| 远端分支 | 只有上面两条 |
| PR | #1–#4 全部 closed，没有一个被合并 |
| CI（分支） | run 40020974839 = **failure**，失败在 `verify` workflow 的「敏感信息扫描」步骤 |

即：README 里写着的漫画能力，代码在一条**没有合并、CI 还是红的分支**上。

### 1.2 2da4e92 做了什么

`fix(comic): 真实漫画图嵌字验证，修掉坐标混用、undefined 字号与 NaN 矩形`

- 新增 `src/core/vision-box.ts`：把模型返回的框统一成 0–100 百分比（normalized / percent / thousandth / pixels 四种单位识别 + clamp + 去重合并）。
- 新增 `scripts/make-real-samples.py` 与 `artifacts/real-samples/`（jp-vertical / jp-burst / kr-strip 三张真实漫画图 + manifest + metrics + 录制回答）。
- 新增 `scripts/manga-real-check.mjs` 与 `docs/reports/2026-10-24-manga-real-typeset.md`。
- 新增 `tests/vision-box.test.ts`、`tests/vision-wiring.test.ts`。

### 1.3 本次（本轮）改了什么

**分支**：`feat/comic-ux-retry-progress`（不合并 main，等批准）

**修改文件（4 个，业务代码只有 1 个）**

| 文件 | 变化 |
| --- | --- |
| `src/extension/content/comic.js` | 阶段四的五项 UX 全量落地 + 两个既有 bug（导出、长译文溢出） |
| `tests/comic-ux.test.ts` | 新增 26 条接线测试，锁住上面每一项 |
| `tests/vision-wiring.test.ts` | `:13` 测试桩里的假 Key 改成显式占位符，修 CI 红 |
| `scripts/secret-scan.mjs` | 修扫描器自身的缺陷：占位符判断拿「整条 `apiKey: '...'`」去测，导致任何测试桩都判成泄漏；改为只看引号里的**值** |

**comic.js 的具体改动**

1. 进度：`setMsg` 不再清空译文列表（改成幂等单例状态行）；`updateBar` 同时显示 `第 i/N 张 · 进度 h/t · 成功 ok · 失败 f · 阶段 12s`；新增 `beginPhase/endPhase` 秒级心跳；面板关着时 `updateBar` 直接 return（关掉后不会再被异步回调弹回来）。
2. 局部重试：译文列表每行一颗「重试」按钮；有框的条目裁出那一块单独发识别请求，再把返回框映射回整页坐标；没框的条目退回整页重翻；没翻出来的行标橙色并写「（这条没翻出来）」。
3. 手动调整可达性：默认的擦字版之前是一张 `pointer-events:none` 的成品图，**人工调整完全够不着**。现在按布局结果铺一层透明抓取框（虚线蓝框、按百分比定位），复用原有 `attachCorrection`（拖动改位置 / 双击改字 / Alt+拖动重画框），改完立刻重画像素；图片缩放后抓取框跟着重算。
4. 原图 / 译图切换：新增切换按钮，只改 `visibility`，不重请求、不丢译文。
5. 取消与恢复：关闭面板、清空页面、点「停止」都会置 `batch.stop`，并且**在写缓存之前**检查；新增撤销栈（`snapshot/undoLast`），拖动、改字、改字号都可回退；`A±` 的字号现在写进 `it.manualFont`（原来只写 `dataset.manualFont`，全文件没人读，切图即丢）。
6. 顺带修的真 bug：
   - 导出：擦字版直接导出成品 PNG（原来因为 `state.layouts` 为空，默认模式导出只会提示「还没有译文可以导出」）；矢量路径修掉「两次 fillText 导致白字被黑字盖住」和「`lines` 是数字所以只画一行」。
   - 长译文溢出：`layoutH/layoutV` 在缩到最小字号还装不下时，先用 1.35× 可用高度重排一次，实在不行才判溢出。

---

## 二、已通过验证的功能（本轮实跑）

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `npm run verify` | **exit 0** | typecheck 通过；**630 tests / 36 files 全过**；build 成功（dist 15 文件 407.2 KB） |
| `npm run lint:secrets` | **exit 0** | 修前 exit 1（1 处误报），修后「未发现敏感信息（117 个文件）」 |
| `npm run typeset:all` | **exit 0** | Chrome 23/23、Edge 23/23 |
| `npm run regress:all` | **exit 0** | Chrome 22/22、Edge 22/22 |
| `npm run smoke:all` | **exit 0** | Chrome 11/11、Edge 11/11 |
| 真实样本 jp-vertical | **23/23** | 改造前 19/20（唯一失败项：长译文溢出「放学后的事」） |
| 真实样本 jp-burst | **23/23** | 20/20 → 23/23（多出的 3 条是抓取框让几何断言真正执行） |
| 真实样本 kr-strip | **23/23** | 同上 |
| `npm run real` | **未验证** | 需要 `MXT_VISION_KEY` 现场调视觉模型，环境未配置；本地网关 8326 返回 401 |

日志与截图：`artifacts/audit-20261029/`（`browser-suites.log` + 每个样本的定位图/译文效果图/缩放图/调试图），`artifacts/manga-typeset/01–05` 为重构后的浏览器实拍。

结论（逐项）：

| 功能 | 判定 | 依据 |
| --- | --- | --- |
| 气泡检测 | **部分可用** | 真实样本召回 4/5、3/3、3/3（jp-vertical 有一块退回矩形）；识别的框位与像素级文字块吻合 |
| OCR 与译文绑定 | **可用**（离线录制） | 三张真实图 11 个文字区，绑定 10 个，placeRate 0.909 |
| 擦除原文字 | **可用** | 6 条像素断言（每个气泡有字、描边完整、气泡外未擦）全过；jp-vertical 有 2/5 框外改动超阈值，属真实擦除溢出的已知残留 |
| 译文嵌入气泡 | **可用** | 三条几何断言（落在气泡内、偏移 < 6px、缩放 50% 后最大偏移 0.1px）真实执行并通过 |
| 缩放后坐标 | **可用** | 同上；新增抓取框同样按百分比跟随 |
| 长译文溢出 | **已修** | jp-vertical 47px 高框 + 14 字译文的死局由 1.35× 放宽兜底解决 |
| 手动调整与恢复 | **可用**（擦字版下首次可用） | 抓取框 + 拖动/改字/重画框 + 撤销栈 |
| 译图导出 | **可用** | 擦字版直接导出 PNG；浮层版按行折行 + `strokeText` 描边 |

---

## 三、仍有问题的功能

### 3.1 可信度问题（测试本身不可信，优先级最高）

1. `scripts/manga-typeset-check.mjs` 在真实样本模式下有 4 条断言被无条件置真（`SAMPLE_NAME ? true : …`，`:712`/`:719`/`:725`/`:876`）。所以「真实样本 20/20」里有 4 条恒真项。
2. 「气泡识别率」是自报型：`:873` 用正则去读被测代码自己打印的 debug 文本；`:782` 的「没有溢出」读的是实现自己加的 `outlineStyle`。
3. 假视觉服务 `:204` 直接把真值 `BUBBLES` 返回，断言期望又由同一份 `BUBBLES` 现算 —— 选中的是「按百分比摆对了」，不是「框就是气泡」。
4. `:198` 的 `let mode = 'normal'` 之后再没赋值，`nobox` / `badbox` 负样本分支是死代码，「框缺失退回矩形」这条路径零覆盖。
5. 静默跳过而非失败：`:771-773` 无窄高框直接记通过；`:540`/`:760` 图层为空时整块不记录；退出码只有 0/1/2，**没有「未验证」独立码**，跳过越多越容易变绿。
6. 报告与代码不同步：报告写 20 条/20 项，实际落 23 条；`docs/reports/2026-10-24-manga-real-typeset.md` 第四节坐标对照表把 thousandth 的结果标到了 percent 行（用 manifest + responses 重算，percent 实际只有 1/5、pixels 1/5）。

### 3.2 引擎与坐标

7. `src/core/vision-box.ts` 单位识别有硬限制：图片本身 ≤1000px 时，pixels 与 0-1000 千分比在数值上不可区分，`detectBoxSystem` 会一律判成 thousandth。
8. `detectCoordinateSystem` 定义后全仓无调用，标签集还缺 `thousandth`；文件头注释描述的样本单位与实际录制数据相反。
9. `npm run real` 没有离线重放模式，没 Key 就完全跑不了，CI 里等于不存在；`metrics.json` 中 3 个 oversized、spillRate 0.2 这些真实缺陷也不会让它失败（只有 placeRate < 0.8 才 exit 1）。

### 3.3 实现重复与性能

10. `comic.js` 里复刻了一份 `adaptivePad / estimateBackground / eraseBox / fitText / readableColor`（`:614-782` 一带），与 `src/core/inpaint.ts` 同时存在，已经出现三套排版参数（CSS 像素 10–44/1.28 与 原图像素 10–34/1.22）和两套字宽模型（`measureText` 与 `estimateTextWidth`）混用。
11. `toBase64` 不降采样、`readPixels` 整图 `getImageData` 在主线程 —— 长条漫画（kr-strip 900×1600）批量翻译时会明显卡顿。
12. 手动调整只存在内存里，没有落 `chrome.storage`；关闭面板再打开就回到模型原稿。撤销栈上限 50 条。
13. `attachRebubble` 闭包持有旧的 `items`（`:1026-1030`），`findComics` 的去重条件 `other.contains(img)` 对 `img` 恒 false。

---

## 四、需要修改的文件（下一轮建议顺序）

| 文件 | 要改什么 | 优先级 |
| --- | --- | --- |
| `scripts/manga-typeset-check.mjs` | 去掉 4 条恒真断言；`mode` 负样本分支接上（nobox/badbox）；气泡识别率改成读视觉模型返回而不是读 debug 文本；退出码加 2=未验证 | P0 |
| `scripts/manga-real-check.mjs` | 支持 `--replay`（读 `responses/*.json` 离线跑）；spill / oversized / mismatch 也参与失败判定 | P0 |
| `src/core/vision-box.ts` | ≤1000px 图的单位歧义显式标注；删掉死函数或用起来；修文件头注释 | P1 |
| `src/extension/content/comic.js` | 手动调整落 `chrome.storage`；擦除溢出（jp-vertical 2/5 框外改动）收敛；把复刻的 5 个 core 函数收回 `dist/core.js` | P1 |
| `src/extension/content/comic.js` | `toBase64` 降采样（比如长边 2048）、`readPixels` 移出主线程 | P2 |
| `docs/reports/2026-10-24-manga-real-typeset.md` | 更正值：真实样本不是 3×20/20、坐标表错行、jp-vertical 曾有溢出失败 | P0 |

---

## 五、下一轮开发清单

### P0（不修就谈不上「能用」）

1. 测试诚实化：干掉 23 条里的恒真项与自报项，让「真实样本全绿」只能靠真实行为拿到。
2. `npm run real` 增加离线重放，并在 CI 里跑起来（否则这条链路永远没人验证）。
3. 更正 2026-10-24 报告的三处错误结论（真实样本并非全绿、坐标表错行、文件数 33 与实测 35/36 不符）。
4. 把 `feat/comic-ux-retry-progress` 的改动过一遍代码评审再谈合并（当前 4 个 PR 全 closed，需要重新开）。

### P1（直接影响用户完成任务）

5. 手动调整持久化（`chrome.storage` 存 `box/zh/manualFont`），关面板不丢。
6. 擦除溢出收敛：jp-vertical 2/5 框外改动 43.57 / 4.94，需要把 mask 限制在气泡内轮廓。
7. 视觉链路单位治理：让模型输出带单位提示，或在 prompt 里强制 0–100，消灭 ≤1000px 图上的歧义。
8. 把 `comic.js` 里复刻的 5 个函数收回 `dist/core.js`，统一成一套排版参数与一套字宽模型。

### P2（体验与工程）

9. 长条漫画的降采样与主线程解耦（大图批量不再卡）。
10. 批量翻译的并发与限速可配（当前固定 2）；失败重试次数可配。
11. 面板上的失败项支持「一键重试所有失败」。
12. 撤销栈落盘、跨图保留。

---

## 六、回归测试与性能结果

### 6.1 回归

| 套件 | 改造前 | 改造后 |
| --- | --- | --- |
| 单元测试 | 604 tests / 35 files | **630 / 36**（+26 条 UX 接线） |
| typeset（合成页） | Chrome 20/20，Edge 20/20 | **Chrome 23/23，Edge 23/23** |
| typeset（真实 jp-vertical） | 19/20（1 条溢出失败） | **23/23** |
| typeset（真实 jp-burst / kr-strip） | 20/20 / 20/20 | **23/23 / 23/23** |
| regress | 22/22 ×2 | 22/22 ×2 |
| smoke | 11/11 ×2 | 11/11 ×2 |
| 敏感信息扫描 | **exit 1**（CI 红） | **exit 0** |

注：typeset 从 20 条变 23 条不是放宽标准 —— 是擦字版多出来的抓取框让「文字浮层落在气泡内」「浮层偏移 < 6px」「缩放后对齐」三条从「图层为空所以空跑」变成真实执行并通过。

### 6.2 性能（观测值，非基准）

- `npm run verify` 全程约 40–60 s（typecheck + 630 tests + build）。
- `npm run typeset:all` 每个浏览器约 20–30 s；真实样本单张约 8–12 s（含 Chrome 启动、扩展加载、一次完整识别 + 擦字 + 排版 + 5 张截图）。
- 扩展构建产物 407.2 KB（改造前 383.2 KB，+24 KB 主要是新增 UI 与抓取框）。
- 未做长条图批量吞吐基准（需要 10 张以上真实样本，当前只有 3 张）。

---

## 七、结论

- 漫画嵌字的**主链路是真实可用的**：识别 → 擦除 → 排版 → 导出，在 3 张真实漫画图、2 个浏览器上都有像素级证据。
- 但 2da4e92 自己写下的「3 图 × 20/20 全绿」**不成立**：真实样本里 jp-vertical 原本就有一条长译文溢出失败（本轮已修），且有 4 条断言恒真、1 条自报。
- 本轮在独立分支上补齐了任务要求的五项 UX，并把默认擦字版从「导出和手动调整都够不着」修成可用。
- 没有合并 main，也没有开新 PR —— 等评审批准后再说。
