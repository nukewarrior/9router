# Mihomo 智能节点调度基线

## 基线

- 分支：`codex/mihomo-smart-routing`
- 基线分支：`master`
- 基线 SHA：`15223724c3e1ad898e84ef6e0cc1686cbafc8290`
- 开发文档：`docs/MIHOMO-EGRESS-HEALTH-POOL-DEVELOPMENT-PLAN.md`

## Current Request Flow

```text
Client
  ↓
src/sse/handlers/chat.js
  ↓
getProviderCredentials()
  ↓
resolveConnectionProxyConfig()
  ↓
open-sse/handlers/chatCore.js
  ↓
executor.execute()
  ↓
open-sse/utils/proxyFetch.js
  ↓
ProxyAgent / environment proxy
  ↓
Mihomo listener
  ↓
Mihomo Selector
  ↓
leaf proxy node
  ↓
OpenCode

后台维护服务并行读取 Controller 目录，按节点出口 IP 建立主备出口组，为每个“选中模型 × 独立出口”执行业务探针，并发布不可变健康 Snapshot。请求只消费健康 Snapshot，不在请求路径重新发现完整节点目录。
```

Mihomo 路由将插入以下位置：

- `src/sse/handlers/chat.js`：no-auth Mihomo route fallback loop。
- `src/lib/network/mihomoRouteManager.js`：候选节点、Selector lease、节点业务状态与失败处理。
- `src/lib/network/mihomoClient.js`：Controller control plane；不进入 credentials。
- `open-sse/handlers/chatCore.js`：把严格代理与 ephemeral dispatcher 选项传到执行层。
- `open-sse/utils/proxyFetch.js`：managed attempt 使用全新的 ProxyAgent，并保持 fail-closed。

## File Change Map

### Proxy 基础

- `src/lib/network/proxyPoolTypes.js`
- `src/lib/network/connectionProxy.js`
- `src/sse/services/auth.js`
- `open-sse/handlers/chatCore.js`
- `open-sse/executors/base.js`
- `open-sse/utils/proxyFetch.js`

### Mihomo 控制与状态

- `src/lib/network/mihomoClient.js`
- `src/lib/network/mihomoState.js`
- `src/lib/network/mihomoRouteManager.js`
- `src/lib/network/keyedMutex.js`
- `open-sse/services/errorClassification.js`
- `src/lib/network/mihomoHealthPool.js`
- `src/lib/network/mihomoBusinessProbe.js`
- `src/lib/network/mihomoMaintenanceScheduler.js`
- `src/lib/network/mihomoMaintenanceService.js`
- `src/lib/network/mihomoHealthAdmin.js`

### 持久化、API 与 DTO

- `src/lib/db/repos/proxyPoolsRepo.js`
- `src/lib/db/index.js`
- `src/models/index.js`
- `src/lib/network/proxyPoolDto.js`
- `src/app/api/proxy-pools/route.js`
- `src/app/api/proxy-pools/[id]/route.js`
- Mihomo health/refresh/nodes/egress-probe/cooldown routes

### UI 与测试

- `src/shared/components/NoAuthProxyCard.js`
- `src/app/(dashboard)/dashboard/proxy-pools/page.js`
- `tests/unit/mihomo-*.test.js`
- `tests/unit/proxy-*.test.js`
- `tests/unit/chat-mihomo-fallback.test.js`

## Troubleshooting / Debug Logging

Mihomo 专用详细日志默认关闭；不需要把整个 9Router 切换到 development：

```env
MIHOMO_DEBUG=true
```

在生产容器重启后，日志会以单行形式记录同一请求的 `req`、同一轮路由的
`route` 和每次 `attempt`，覆盖候选统计、节点与出口身份、Selector 切换/verify
耗时、Listener 请求耗时、底层 transport cause、cooldown 和实际 retry decision。

```bash
docker logs 9router 2>&1 | grep '\[MIHOMO\]'
docker logs 9router 2>&1 | grep '\[PROXY\]'
docker logs 9router 2>&1 | grep 'req=91bc23'
```

请求会优先复用入站的 `x-request-id` / correlation ID；没有时生成短 ID，内部
retry 不会改变它。日志只输出代理地址的协议、主机和端口，以及节点/出口身份；
Controller secret、Listener 凭证、Authorization、Cookie、API key、token、请求
body 和用户消息不会输出。排障完成后应关闭该开关并重启容器。

## 最高风险

1. Controller Selector 切换后按 proxy URL 复用旧 ProxyAgent/CONNECT，会让日志节点与真实出口不一致；managed attempt 必须使用 ephemeral dispatcher。
2. `strictProxy`、`ephemeralProxyDispatcher` 和空 `connectionNoProxy` 已作为 Mihomo managed attempt 的硬约束；Listener 故障必须 fail-closed，禁止 DIRECT。
3. OpenCode 业务 429 只更新“模型 × 出口 identity”状态；transport failure 先更新 Node transport 并尝试同 IP 备用节点，普通 5xx 不切换出口。
4. 后台探针使用低优先级 Selector lease，请求使用高优先级 lease；旧 Route Snapshot 的成功/失败不能覆盖更新版本的状态。

## Phase 0 验收记录

- 代码基线 SHA 已与开发文档一致。
- 工作区在创建分支前干净。
- 文档指定的关键文件均存在并已阅读。
- 当前实现环境使用 Node.js `v22.14.0`、npm `10.9.2`，Vitest 和 ESLint 通过仓库依赖执行。

## Phase 8 迁移记录

- 配置读取会忽略旧 `regionOrder`、`preferDistinctEgress`、`egressScopedCooldown`，规范化后不再输出；`samplesPerNode` 至少为 2，业务 TTL 至少为刷新周期的 2 倍。
- v1 `mihomoState` 保留合法 Node Egress Mapping，并补齐 `mappingVersion=1`；旧的 model-less Node/business cooldown 不迁移为模型健康证据。
- 首次升级后，旧出口映射可减少出口 IP 探针，但模型健康池从冷状态开始；后台首次 cycle 会为 Available Models 中 `providerAlias=oc` 且 `type=llm` 的模型逐步建立健康证据。
- 重启时仅恢复未过期模型健康证据并重建 Snapshot，in-flight reservation 不持久化；删除模型或停用/删除 Pool 会清理对应 Snapshot、维护作业和持久化模型健康状态。
- 真实环境脚本 `scripts/validate-mihomo.mjs` 只验证 Controller/Listener/出口与 Health API，不主动发起 OpenCode 请求；429、同 IP backup、不同出口 retry 和流式请求完整性按 `docs/MIHOMO-REAL-VALIDATION.md` 手动记录。
