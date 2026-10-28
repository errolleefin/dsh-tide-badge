# 变更记录

本仓库是 [`xiangrikuibaize/dsh-tide-badge`](https://github.com/xiangrikuibaize/dsh-tide-badge) 的修改版，
版本号在本仓库内独立递增；`0.2.3` 对应上游的最后一个导入版本。

## 0.3.0 — 2026-10-28

基于上游 **v0.2.3**。主题只有一个：修掉「本次对话花费」的串账，改为方案 A（按会话 token 用量 × 价目表）。

### 破坏性变更

- 「本次」的语义从"账户自上次观察以来掉了多少钱（记在当前前台对话头上）"改为"**本会话**累计 token 用量 × 官方价目表"。
  旧口径下同一笔扣费会被多个对话各记一遍，且余额是账户级读数，其他设备 / 其他 API Key 的消耗也会被算进来。
- 账本从 `dsh-tide-badge/session-cost`（每个对话一份余额基准）换成 `dsh-tide-badge/session-cost/v2`
  （按 `sessionId` 分行存四桶累计用量与已计价金额）；升级时清掉旧键。
- 取不到会话 id 时不再记账（旧版会落到共用 `"default"` 一行）。

### 新增

- `lib/pricing.mjs`：deepseek-flash 官价（元 / 百万 token）——缓存命中 0.02 / 0.04、未命中 1 / 2、
  缓存写入同未命中、输出 4 / 8（谷价 / 峰价），逐桶计价 `unitsForBuckets` 与账本推进规则 `nextCostRow`；
  由 `build.mjs` 与 `season.mjs` 一起内联进 `client.js`，前端不需要另抄一份。
- 面板新增「本次花费」与未命中 / 缓存命中 / 缓存写入 / 输出四行用量，脚注给出当前档位与完整价目，并注明"不含子代理会话"。
- `lib/pricing.test.mjs`（22 项）：价目表形状、每 token 单价整数性、真实会话 A 的 ¥0.2921 回归、
  归一化、增量、回退不写负数、两会话不串账。
- `tools/client-smoke.mjs`（9 项）：用最小 DOM/React 桩直接跑**构建产物** `lib/client.js`，
  覆盖挂载、算账、切会话再切回、重复快照、面板与价目脚注。
- `tools/session-cost.mjs`：解析 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，按每条 `assistant/message`
  的 provider usage 与消息时间复算每会话花费，用来对账。

### 修复

- `anySessionRunning()`：改读 `sessions.list.getSnapshot().byId[id].running`。上游读 `snap.sessions`，
  在 DSH 0.2.x 上恒为空数组，于是"有会话在跑就不刷新余额"这层保护从未生效。
- 币种：金额固定按人民币格式化，不再拿余额币种去格式化累计值（来源切换时会给人民币数字标 `$`）。

### 已知边界

- 首次见到某个会话（没有账本行）时，把它的累计用量整体按**当前**档位计价；重开横跨峰谷的旧会话最坏差 2 倍。
- 单轮若跨 09:00 / 12:00 / 14:00 / 18:00 边界，按观察时刻的档位计价，最多错一轮。
- 子代理是独立 session，不计入父会话的「本次」。
- 价目表按官方定价页维护；价格变动时需要改 `lib/pricing.mjs` 的 `PRICE_PER_MILLION`。

### 校验记录

- `npm run check`：构建 + 语法校验 + 51 项单元测试。
- `tools/session-cost.mjs` 对本机 8 个历史会话的复算与实测账本表格逐行吻合（会话 A 62 轮 = ¥0.2921）。
- 桌面端真实页面中，`session-cost/v2` 账本只含当前会话一行，金额与按谷价全量复算一致。

## 0.2.3

上游版本，原样导入为本仓库第一个提交（tag `v0.2.3`）：
<https://github.com/xiangrikuibaize/dsh-tide-badge>
