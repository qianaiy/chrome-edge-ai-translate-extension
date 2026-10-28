# ADR-0007 消息回执契约：四态 status 与字幕关闭事务

- 状态：已接受（本 ADR 冻结契约；实现分两次提交落地）
- 日期：2026-10-29
- 影响面：`src/extension/background.js`、`src/extension/popup/popup.js`、`src/extension/content/content.js`、`src/extension/content/subtitle.js`
- 不动：`src/core/**`、`src/extension/content/comic.js`、`content.css`、`manifest.json`、`options/**`、`popup.html`、`scripts/**`

## 1. 背景

弹窗（popup）把「动作已经发出去」当成「动作已经做完」：只要 background 回了 `{ok:true}` 就关窗，
而 background 在 `tabToggle / tabDisplay / tabSubtitle / tabComic` 四个入口里**无条件**返回 `{ok:true}`
（`background.js:1790-1821`）。于是：

- 受限页（`chrome://`、扩展商店、PDF 阅读器）上点「翻译整页」，弹窗照样关闭，用户以为在翻；
- 内容脚本根本没被注入、或注入了但没接住消息，弹窗也照样关闭；
- 内容脚本把异步任务「开始」当「完成」回执（`content.js:1969-2010`、`subtitle.js:621-631`），
  这类回执里没有任何字段能区分「已开始」与「已完成」；
- 同一个 `ok` 布尔值被三处代码各自解释语义，前端的关闭判定与后端的定级逻辑互相看不见。

同时，字幕面板的关闭按钮只做了一件视觉上的事——`host.classList.remove('mxt-sub-open')`
（`subtitle.js:433`）。它不停音频采集、不清 120 秒等待定时器（`subtitle.js:227-269`）、
不丢弃在途结果。关闭面板之后，采集仍在跑、ASR 请求仍会发出、翻译请求仍会发出、`<track>` 仍在播放。

## 2. 决策

### 2.1 回执四态

所有跨进程动作回执（background → popup / 命令 / 右键菜单）统一为一个**归一化对象**，
`status` 取四值之一：

| status | 含义 | 谁可以给出 |
| --- | --- | --- |
| `executed` | 动作**已同步完成**，结果在同一个回执里 | 内容脚本（同步完成的动作）、background（本地完成） |
| `accepted` | 动作**已被接管**，异步进行中，结果不会在这个回执里出现 | 内容脚本（异步任务入口） |
| `failed` | 明确失败，`message` 说明原因 | 任何一层 |
| `unknown` | 没有可判定的回执（超时、通道断开、对端静默） | background |

配套字段：

- `ok`：**派生值**，`ok === (status === 'executed') || (status === 'accepted' && takeover === true)`。
  它不是输入，只用于「能不能关窗 / 要不要闪红」这类动作判定。
- `takeover`：`accepted` 且**已确认接管**时为 `true`。确认来源是内容脚本显式声明，
  或「本次确实把内容脚本注入进去了并且拿到了回执」。
- `message`：人类可读原因；`error` 是 `message` 的别名，仅为兼容既有调用点保留，二者同值。
- `code`：机器可读短码（`restricted-page` / `no-receipt` / `legacy-content` / `no-tab` / `port-closed` …）。
- `retryable`：`failed` / `unknown` 默认 `true`；`restricted-page` 为 `false`（换页面才有意义，重试无意义）。
- `frames`：`{total, executed, failed}`，只做计数，不参与定级。

### 2.2 归一化只有一个入口

`background.js` 内的 `normalizeReceipt()` 是**全仓唯一**把原始回执解释成语义状态的地方。
禁止第二处 `if (r.ok)` 判定语义：任何 `if (r.ok)` 只允许出现在
「consumer 读派生 ok 决定 UI 动作」的位置，不允许出现在「猜它完成没完成」的位置。

为此配一条源码扫描测试：`status === 'executed'` 的语义比较只允许在 `normalizeReceipt` 里出现。

### 2.3 旧内容脚本 = accepted，绝不当 executed

浏览器里可能还跑着旧版本注入的内容脚本。旧回执形如 `{ok:true}`，没有 `status`。
归一化必须把它读成 `accepted` 并打 `warn:'legacy-content'`、`code:'legacy-content'`，
**永不**升级为 `executed`。`{ok:false}` 无 `status` 则读成 `failed`。

理由：旧脚本的 `ok:true` 与新区间的 `executed` 不是同一个判断，把它当完成正是本次要修的缺陷。
代价是升级瞬间旧页面上的「整页翻译」不接受自动关窗——这是正确的保守方向。

### 2.4 弹窗关闭门

弹窗只认 `ok === true`：即 `executed`，或 `accepted && takeover`。
`failed` / `unknown` 一律不关窗，并把 `message` 显示在状态行。
**禁止自动重试**：弹窗不得因为回执失败而重发请求（付费请求尤其）。

### 2.5 受限页判定只有一个出处

原来 popup 自己用 `/^https?:/i.test(tab.url)` 判一次，background 的 `injectable()` 又判一次，
两处文案还不一样。现在 popup 不自建谓词，改用 background 的 `mxt:tabStatus`：
该查询返回 `{ok, status:null | <content 回执>, message, code}`，`status === null` 即不可操作，
`message` 直接展示。background 侧由 `restrictedReason(tabId)` 单点给出原因串。

`mxt:tabStatus` 是**查询**不是动作回执，因此不复用 `status` 的四态语义（它的 `status` 字段承载
内容脚本的状态快照），这也是它保留 `ok` 而不是四态的原因。

### 2.6 多 frame 定级

`sendToAllFrames()` 的定级**只看主 frame 的第一个回执 + 注入结果**：

1. 主 frame 发一次；拿到合法回执 → 归一化（`injected` 视本次是否注入而定）。
2. 没拿到 → `restrictedReason()`；受限 → `failed` + `code:'restricted-page'` + `retryable:false`。
3. 不受限 → 注入内容脚本；注入成功则记 `injected=true` 并重发一次主 frame。
4. 子 frame 的 sweep 是旁路：只累加 `frames` 计数，**不影响** `status` / `ok`。
   子 frame 成功不能把主 frame 的 `unknown` 抬成 `executed`。

理由：动作的完成与否取决于承载 UI 的主 frame；子 frame 是尽力而为的扩散。

### 2.7 字幕关闭是一个事务

关闭字幕面板 = 终止一个会话，顺序固定：

1. `gen++`（会话代号自增，此后所有在途回调都拿旧 `gen`，一律作废）；
2. 停音频采集：`AudioContext.close()`、断开 `MediaElementSource` / `Gain` / `ScriptProcessor`、清空已采样本；
3. 清计时器：可取消的 120 秒等待（保存 timer 句柄，取消时 `clearTimeout` 并 resolve 为「已取消」）；
4. 丢弃旧 `gen` 的结果：任何 `await` 之后先校验 `my === gen`，不等就 `return`，不再发新请求；
5. 撤 `<track>` 与 `revokeObjectURL`，避免残留字幕继续显示与内存泄漏；
6. 面板里写一条提示，说明**已发出的识别请求无法撤回**。

要点：**已发出的 ASR 请求不可撤销**。这段代码只能丢弃结果，不能宣称「已取消计费」或「已停止服务端处理」。
提示文案必须如实说明这一点（实现里用「已经发出的识别请求无法撤回」）。

## 3. 后果

- 弹窗不再对「没接住」说谎：受限页、静默、失败都会留在弹窗里说明原因。
- 调用方（右键菜单、快捷键）从「try/catch 猜」改为「读 `ok` / `code`」。
- `ping` / `status` 两个**查询类**回执保留 `ok:true`（真实浏览器回归脚本 `scripts/browser-regress.mjs`
  断言了它们），但额外带上 `status:'executed'`，让它们也进入同一套语义。
- `comic.js` 是红线不可改，它的 `mxt:translateComic` 仍是 `{ok:true}`；归一化把它读成
  `accepted + legacy-content`，由于本次调用必然伴随注入成功，`takeover` 为真，
  所以外部看到的 `ok` 仍为 `true`——既有 `scripts/manga-*.mjs` 的 `trig.ok !== false` 判据不受影响。
- 新增 4 个回归测试文件，全部在修复前为红。

## 4. 备选方案与被否理由

- **在 popup 里补 `if (res.status === ...)`**：把语义判定又搬回 consumer，第二处 `if (r.ok)` 换个写法复活。否。
- **给旧回执加「超时后轮询状态」**：会引出新的轮询生命周期与新的付费请求路径，与本批风险预算不符。否。
- **关闭字幕时回收服务端任务**：服务端没有取消接口；凭空宣称取消等于撒谎。否。
- **让子 frame 回执参与定级（取多数）**：主 frame 静默时多数票会把「没接住」说成「已开始」。否。
