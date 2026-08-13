# Mihomo/Nikki 真实环境验收

脚本不会主动请求 OpenCode，只验证 Controller、Selector、节点发现、listener 代理出口和可选的 fail-closed。

## Nikki mixin

以下是 Nikki mixin 约定；`nikki-proxy-groups` 不是标准 Mihomo 配置中的 `proxy-groups` 字段。节点选择权由 9Router 接管，因此必须使用 `type: select`，不要使用 `load-balance` 或 `round-robin`。

```yaml
listeners:
  - name: opencode-free
    type: mixed
    listen: 0.0.0.0
    port: 17891
    proxy: "🤖 OpenCode调度"

nikki-proxy-groups:
  - name: "🤖 OpenCode调度"
    type: select
    use:
      - 订阅一
    filter: "(?i)🇹🇼|台湾|tw|taiwan|🇯🇵|日本|jp|japan|🇸🇬|新加坡|sg|singapore|🇺🇸|美国|us|usa|united states"
    exclude-filter: "(?i)剩余|流量|套餐|到期|过期|官网|客服|公告|重置|traffic|expire|expired"

nikki-rules:
  - DOMAIN-KEYWORD,tailscale,DIRECT
```

Controller 建议只监听 LAN，并限制为 9Router 主机可访问：

```yaml
external-controller: 0.0.0.0:9090
secret: "替换为强 secret"
```

不要把 `9090` 或 `17891` 暴露到公网；Controller secret 只填入 9Router 的 Mihomo Pool，不会出现在 GET API 或脚本日志中。

## Controller 预检

```bash
curl -H "Authorization: Bearer $MIHOMO_CONTROLLER_SECRET" \
  "$MIHOMO_CONTROLLER_URL/proxies/$(python -c 'import urllib.parse,os; print(urllib.parse.quote(os.environ["MIHOMO_SELECTOR"], safe=""))')"
```

## 9Router 真实出口验收

从 9Router 工作目录执行。`MIHOMO_NODE_NAMES` 使用 Mihomo 返回的精确节点名称；不设置时只验证当前 Selector 节点。

```bash
export MIHOMO_CONTROLLER_URL="http://10.11.11.1:9090"
export MIHOMO_CONTROLLER_SECRET="替换为实际 secret"
export MIHOMO_SELECTOR="🤖 OpenCode调度"
export MIHOMO_LISTENER_URL="http://10.11.11.1:17891"
export MIHOMO_PROVIDER_NAMES="订阅一"
export MIHOMO_NODE_NAMES="🇹🇼 台湾 A30,🇯🇵 日本 A01"

node scripts/validate-mihomo.mjs
```

验收应确认：

1. Controller `/version`、Selector 和 Provider leaf 均可读。
2. 每个节点执行 `PUT Selector` 后，GET verify 的 `now` 与目标名称一致。
3. `api.ipify.org` 的出口随节点改变；不能只看 PUT 调用顺序。
4. `/connections` 可读，必要时在慢请求存活期间核对 chain。
5. 关闭 listener 后，设置 `MIHOMO_FAILURE_LISTENER_URL` 指向故障地址，脚本必须失败闭环，而不是获得直连结果：

```bash
export MIHOMO_FAILURE_LISTENER_URL="http://10.11.11.1:17892"
node scripts/validate-mihomo.mjs
```

真实 OpenCode 429 验收应最后进行，并且只在用户明确准备好测试节点时运行：

```bash
# 观察 9Router 日志与 Mihomo /connections chain
# 使用实际 OpenCode Free 模型发起一次请求：
# TW-A30 -> 429/FreeUsageLimitError -> node cooldown -> JP-A01 -> 200
```

当前开发环境没有用户的 Nikki Controller、listener 或真实出口，因此本阶段只能完成脚本、离线集成测试和静态验收；上述命令需在真实路由器网络中执行。
