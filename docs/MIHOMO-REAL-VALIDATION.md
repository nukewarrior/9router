# Mihomo/Nikki 真实环境验收

脚本不会主动请求 OpenCode，只验证 Controller、Selector、节点发现、listener 代理出口和可选的 fail-closed。

## Nikki mixin

以下是 Nikki mixin 约定；`nikki-proxy-groups` 不是标准 Mihomo 配置中的 `proxy-groups` 字段。节点选择权由 9Router 接管，因此必须使用 `type: select`，不要使用 `load-balance` 或 `round-robin`。

```yaml
listeners:
  - name: opencode-free
    type: mixed
    listen: 0.0.0.0
    port: 18080
    proxy: "Test Selector"

nikki-proxy-groups:
  - name: "Test Selector"
    type: select
    use:
      - Test Provider
    filter: "(?i)🇹🇼|台湾|tw|taiwan|🇯🇵|日本|jp|japan|🇸🇬|新加坡|sg|singapore|🇺🇸|美国|us|usa|united states"
    exclude-filter: "(?i)剩余|流量|套餐|到期|过期|官网|客服|公告|重置|traffic|expire|expired"

nikki-rules:
  - DOMAIN-KEYWORD,tailscale,DIRECT
```

Controller 建议只监听 LAN，并限制为 9Router 主机可访问：

```yaml
external-controller: 0.0.0.0:9090
secret: "replace-locally"
```

不要把 `9090` 或 `18080` 暴露到公网；Controller secret 只填入 9Router 的 Mihomo Pool，不会出现在 GET API 或脚本日志中。

## 9Router Mihomo Pool 配置示例

在控制面板创建 `Mihomo / Clash Controller` 类型的 Proxy Pool。以下字段是当前健康池语义；`controllerSecret` 只在保存时填写，不要提交到配置文件或日志：

```json
{
  "type": "mihomo",
  "proxyUrl": "http://127.0.0.1:18080",
  "strictProxy": true,
  "mihomo": {
    "controllerUrl": "http://192.0.2.10:9090",
    "controllerSecret": "replace-locally",
    "selectorName": "Test Selector",
    "providerNames": ["Test Provider"],
    "includeRegex": "",
    "excludeRegex": "",
    "inventoryRefreshMs": 300000,
    "egressProbeTimeoutMs": 8000,
    "samplesPerNode": 2,
    "egressProbeTtlMs": 21600000,
    "businessHealthRefreshMs": 900000,
    "businessHealthTtlMs": 2700000,
    "businessProbeTimeoutMs": 15000,
    "admissionWaitMs": 3000,
    "maxInFlightStartsPerEgress": 1,
    "maxAttemptsPerRequest": 6,
    "egressProbeUrl": "https://api.ipify.org",
    "cooldown": {
      "baseMs": 300000,
      "multiplier": 3,
      "maxMs": 1800000
    }
  }
}
```

健康粒度固定为“选中模型 × 独立出口 IP”；同一出口 IP 下的节点是一个主备出口组。配置中不再使用 Region Order、Prefer distinct exit identities 或 Exit-IP scoped cooldown 控件。

## Controller 预检

```bash
curl -H "Authorization: Bearer $MIHOMO_CONTROLLER_SECRET" \
  "$MIHOMO_CONTROLLER_URL/proxies/$(python -c 'import urllib.parse,os; print(urllib.parse.quote(os.environ["MIHOMO_SELECTOR"], safe=""))')"
```

## 9Router 真实出口验收

从 9Router 工作目录执行。`MIHOMO_NODE_NAMES` 使用 Mihomo 返回的精确节点名称；不设置时只验证当前 Selector 节点。

```bash
export MIHOMO_CONTROLLER_URL="http://192.0.2.10:9090"
export MIHOMO_CONTROLLER_SECRET="replace-locally"
export MIHOMO_SELECTOR="Test Selector"
export MIHOMO_LISTENER_URL="http://198.51.100.10:18080"
export MIHOMO_PROVIDER_NAMES="Test Provider"
export MIHOMO_NODE_NAMES="Example Taiwan Node A,Example Taiwan Node B,Example Japan Node A"

# 可选：让脚本继续轮询 9Router Health API，记录后台 cycle 进度。
export MIHOMO_ROUTER_URL="http://127.0.0.1:20128"
export MIHOMO_POOL_ID="mihomo-pool-id"
export MIHOMO_MODEL_ID="opencode-free-model-id"
# 按现有 dashboard guard 选择其一；值不会被脚本输出。
# export MIHOMO_ROUTER_API_KEY="..."
# export MIHOMO_ROUTER_AUTHORIZATION="Bearer ..."
# export MIHOMO_ROUTER_COOKIE="..."

# 可选：对真实环境中的同 IP 主备和不同 IP 节点做断言。
export MIHOMO_EXPECTED_SAME_IP_NODES="Example Taiwan Node A,Example Taiwan Node B"
export MIHOMO_EXPECTED_DISTINCT_NODES="Example Japan Node A"

node scripts/validate-mihomo.mjs
```

验收应确认：

1. Controller `/version`、Selector 和 Provider leaf 均可读。
2. 每个节点执行 `PUT Selector` 后，GET verify 的 `now` 与目标名称一致。
3. `api.ipify.org` 的出口随节点改变；脚本会记录脱敏后的节点→出口映射并汇总同 IP group，不能只看 PUT 调用顺序。
4. 设置 `MIHOMO_ROUTER_URL` 后，脚本会轮询 Health API，记录 cycle、节点发现/映射、独立出口和业务探针进度，并在 cycle 完成后校验同/不同出口断言。
5. `/connections` 可读，必要时在慢请求存活期间核对 chain。
6. 关闭 listener 后，设置 `MIHOMO_FAILURE_LISTENER_URL` 指向故障地址，脚本必须失败闭环，而不是获得直连结果：

```bash
export MIHOMO_FAILURE_LISTENER_URL="http://198.51.100.10:18081"
node scripts/validate-mihomo.mjs
```

真实 OpenCode 429、同 IP backup 和不同出口 retry 验收应最后进行，并且只在用户明确准备好测试节点时运行。验证脚本不会主动调用 OpenCode：

```bash
# 观察 9Router 日志与 Mihomo /connections chain
# 使用实际 OpenCode Free 模型发起一次请求，记录：
# N1/N2 -> 同一 E1；N3 -> E2；N1 transport failure -> N2；E1 429 -> E2。
# Example Taiwan Node A -> 429/FreeUsageLimitError -> E1 cooling -> Example Japan Node A -> 200
```

当前开发环境没有用户的 Nikki Controller、listener 或真实出口，因此本阶段只能完成脚本、离线集成测试和静态验收；上述命令需在真实路由器网络中执行。真实记录至少保存：脱敏节点→出口映射、cycle 时间线、模型容量变化、429 前后 identity、同 IP backup 证据、fail-closed 证据，以及日志未出现 secret/token/body 的检查结果。
