# dsh-token-gateway

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![DSH](https://img.shields.io/badge/dsh-0.2.2--rc.1-4f6bed)](package.json)

DSH（DeepSeek Harness）的预算网关插件。主循环、子代理、会话标题、压缩摘要，所有模型调用都要经过 `llm/stream`。插件挂在这个接缝上：调用前用会话 / 每日 / 每月三档预算决定放行、告警还是拦截，调用后按 provider 返回的 `usage` 记账，超限时也可以把请求改派给更便宜的模型。

只治理 DSH 内部的调用，不对外提供 OpenAI 兼容代理。零运行时依赖，无构建步骤。要求 Node ≥ 22.19、DSH 0.2.2-rc.1。

## 安装

```bash
dsh plugin --profile web add github:Yuaneen/dsh-token-gateway
```

重启 `dsh web` 后在会话里执行 `/gateway`：

```text
Token Gateway · policy block · action allow
session  0.000 CNY / 14.400 CNY  (0%)
today    0.000 CNY / 72.000 CNY  (0%)
month    0.000 CNY / 720.000 CNY  (0%)
warn at 80% · highest session budget at 0%
```

本地开发可以直接加载工作目录：

```bash
git clone https://github.com/Yuaneen/dsh-token-gateway.git
cd dsh-token-gateway
dsh plugin --profile web add .
```

默认值：会话 $2、每日 $10、每月 $100（USD），超限 `block`，HTTP 控制面只接受回环地址。要调整就改 profile 里的 `cordis.patch.yml`；[仓库里这份](cordis.patch.yml)带逐项注释，可以直接当模板。

## 配置

所有字段都在 `src/config.js` 里校验。非法值会让插件加载失败，而不是静默关掉某项预算。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `budgets.session` / `daily` / `monthly` | `2` / `10` / `100` | USD；`null` 表示不限；`0` 会被拒绝 |
| `warnRatio` | `0.8` | 首次告警的花费比例 |
| `overLimit` | `block` | `alert` / `block` / `degrade` |
| `degradation` | `{}` | 模型 → 同 provider 的便宜模型 |
| `degradeAt` | `warn` | 到 `warnRatio` 就降级（`warn`），或到上限才降级（`hard`） |
| `alertCooldownMs` | `60000` | 同一 scope 两次告警的最小间隔 |
| `currency` | `{ code: 'CNY', rate: 7.2, decimals: 3 }` | 仅用于展示，记账始终是 USD |
| `pricing.prices` | `{}` | USD / 1M tokens，覆盖内置价格表；key 为 `model` 或 `provider/model` |
| `pricing.defaultPrice` | `{ input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1, priced: false }` | 未定价模型的兜底；`priced: false` 时按 0 计 |
| `pricing.peak.windows` | 工作日 09:00–12:00、14:00–18:00 | 峰时窗口，时区取 `pricing.peak.timeZone` |
| `pricing.peak.holidays` | `[]` | `YYYY-MM-DD`，全天按谷时计价 |
| `gateway.http` | `true` | 是否注册 HTTP 控制面 |
| `gateway.basePath` | `/token-gateway` | 挂载路径 |
| `gateway.token` | `''` | 空 = 只允许回环访问；非空 = 需要 Bearer token |
| `persistence.enabled` | `true` | 关闭后退化为纯内存，重启归零 |
| `persistence.file` | `$DSH_HOME/token-gateway/ledger.json` | 支持 `~` 和 `$DSH_HOME` |
| `persistence.flushMs` | `500` | 写盘防抖间隔 |

## 控制面

### `/gateway`

```text
/gateway                  当前花费、预算、策略和决策原因
/gateway usage            花费汇总 + 按模型归因（Top 10）
/gateway unblock <scope>  解除当前花费水位线以内的拦截
/gateway help
```

### HTTP API

挂在 `gateway.basePath` 下，只注册一个 prefix 路由。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` 或 `/v1/status?session=<id>` | 预算、花费、比率、策略、水位线、按模型归因 |
| `GET` | `/v1/usage?session=<id>` | 花费汇总与按模型归因 |
| `POST` | `/v1/unblock` | `{ "scope": "session", "sessionId": "..." }` |

`session` 省略时取最近活跃会话，再回退到 `__global__`。按模型归因是进程内全部会话的合计，不按 session 过滤。

鉴权：`gateway.token` 为空时只接受回环地址（`127.0.0.1`、`::1`）；设置之后所有请求都要带 `Authorization: Bearer <token>`。把 `dsh web` 暴露到 LAN 或公网之前先设置 token。

## 预算策略

| 条件 | `alert` | `block` | `degrade` |
| --- | --- | --- | --- |
| 所有 scope 低于 `warnRatio` | 放行 | 放行 | 放行 |
| 最高 scope ≥ `warnRatio`，未到上限 | 告警 | 告警 | `degradeAt: warn` 且有映射时降级，否则告警 |
| 任一 scope ≥ 上限 | 告警 | 拦截 | 有映射时降级，否则拦截 |
| 执行过 `unblock <scope>` | 记录水位线 | 水位线以内不再拦截 | 同 block |

`unblock` 是按当前花费打的水位线，不是永久开关：花费继续增长、越过水位线后会重新拦截。`session` 的水位线按会话隔离，`daily` / `monthly` 是全局的。

`degradation` 只支持同 provider 的映射：

```yaml
degradation:
  deepseek-v4-pro: deepseek-v4-flash
```

跨 provider 的上下文窗口、工具 schema、视觉能力都可能不同，这一版不处理。

## 计价与归属

- `TokenUsage` 的四个桶互斥：`inputTokens`（未缓存输入）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`，每个桶只计一次价。
- 内置价格表是 USD / 1M tokens 的峰时快照（与 `dsh-budget` 同口径），覆盖 `deepseek-chat`、`deepseek-reasoner`、`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-pro`。谷时乘以 `pricing.peak.offPeakMultiplier`（默认 0.5）。
- 表外模型走 `pricing.defaultPrice`，默认 `priced: false`，按 0 计费并在日志里告警一次。上线前对照官方价目，用 `pricing.prices` 覆盖。
- 计费只认 `usage`。provider 没返回 usage 的失败调用不收费，也不按字符数估算。
- 归属：带 `sessionId` 的调用记到该会话；标题、压缩等不带 `sessionId` 的辅助调用回退到最近活跃会话，再回退到 `__global__`。重试的每次尝试分别计量，provider 那边也是分别计费的。

## 实现说明

- 挂载在 `llm/stream` 上（`prepend: true`），在 `next()` 之前决策，能看到全部调用。没有用 `agent/request`：该接缝已标记废弃，且不允许修改 provider / model。
- 拦截不抛异常。返回一段普通文本，并以 `finish { kind: 'error', failure.code: 'BUDGET_BLOCKED' }` 结束，agent loop 正常结算，不会触发传输层重试。
- 降级会把请求换成新模型重新下发，再次进入 waterfall；用 `WeakSet` 认出这些对象，只计量、不再准入，避免递归。
- 账本在内存里按 session / day / month / model 聚合，写盘走 `tmp` + `rename` 原子替换（`0600`），按 `flushMs` 防抖，插件 dispose 时强制 flush。文件损坏只丢快照，不影响进程内数据。
- `policy.js`、`ledger.js`、`pricing.js` 不依赖 cordis，可以直接单测；`index.js` 只负责生命周期接线。

## 已知限制

1. 降级后的请求，会话日志的 `request/header` 仍记录原模型，账本按实际下发的模型计费，两者可能不一致。
2. 工具调用费用（web search / fetch、文件解析等）不在 `TokenUsage` 里，不会被计入。
3. `unblock` 是水位线语义，继续花费会再次触发拦截。
4. 没有 `sessionId` 的辅助调用会落到最近活跃会话。需要严格审计的话，应改成只在明确携带 `sessionId` 时记账（目前要改代码）。
5. 账本在进程内聚合，多实例部署不共享数据。
6. 内置价格是快照，不是实时价目。
7. HTTP 控制面默认只允许回环访问。

## 开发

```bash
npm test        # node --test test/*.test.js
npm run check   # node --check，逐个检查源码
```

```text
src/
  index.js     cordis 接线：llm/stream、commands、webServer
  gateway.js   准入、计量与控制面实现（不依赖 cordis）
  config.js    默认值与校验
  policy.js    预算决策（纯函数）
  ledger.js    会话 / 日 / 月 / 模型账本
  pricing.js   价格表、峰谷窗口、金额格式化
  store.js     原子 JSON 持久化
  stream.js    拦截流与 usage 旁路计量
test/          node:test 用例，含用假 ctx 驱动的接线测试
```

提交前跑 `npm test && npm run check`。新增配置字段时，同步更新 `src/config.js` 的校验、`cordis.patch.yml` 的示例和上面的配置表。

## License

MIT © 2026 DSH Market contributors
