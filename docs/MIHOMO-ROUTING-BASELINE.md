# Mihomo 智能节点调度基线

## 基线

- 分支：`codex/mihomo-smart-routing`
- 基线分支：`master`
- 基线 SHA：`15223724c3e1ad898e84ef6e0cc1686cbafc8290`
- 开发文档：`9router-mihomo-development-plan-master-rewrite.md`

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

### 持久化、API 与 DTO

- `src/lib/db/repos/proxyPoolsRepo.js`
- `src/lib/db/index.js`
- `src/models/index.js`
- `src/lib/network/proxyPoolDto.js`
- `src/app/api/proxy-pools/route.js`
- `src/app/api/proxy-pools/[id]/route.js`
- Mihomo test/nodes/clear-cooldown routes

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
2. `strictProxy` 当前在 `connectionProxy.js` 已计算但未完整进入 credentials 与 `chatCore`，异常时可能 DIRECT；Mihomo 必须强制 fail-closed。
3. OpenCode 业务 429 必须只更新 `proxyProvider + node + businessProvider` 状态，不能写 pool-level cooldown，也不能复用 account fallback 的状态。

## Phase 0 验收记录

- 代码基线 SHA 已与开发文档一致。
- 工作区在创建分支前干净。
- 文档指定的关键文件均存在并已阅读。
- 当前执行容器没有 Node.js/npm/bun，Vitest、lint、build 需在安装 Node 依赖的环境中执行。
