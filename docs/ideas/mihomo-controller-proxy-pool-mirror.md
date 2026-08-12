# Mihomo Controller Proxy Pool Mirror

## Problem Statement

9Router can rotate ordinary proxy pools after a provider-scoped 429 cooldown, but a Mihomo mixed port exposes whichever node is currently selected by a policy group. Treating that mixed port as several ordinary pools would therefore label nodes without actually changing the outbound route.

For a personal, self-hosted deployment, 9Router needs to discover the selectable leaf nodes exposed by one Mihomo Controller, mirror them as managed Proxy Pools, and select the matching Mihomo node before each upstream attempt. The success criterion is observable routing: if node A receives a 429, the existing cooldown excludes A, the retry selects node B, Mihomo switches the target Selector to B, and the request leaves through B.

## Recommended Direction

Implement a read/select-only Controller integration:

- Store one server-only Mihomo connection configuration and periodically synchronize the intersection of selected Proxy Providers and one target Selector.
- Mirror every uniquely selectable node as a managed `mihomo` Proxy Pool with a stable identity derived from controller, provider, and node names.
- Keep the existing Proxy Pool cooldown as the sole rate-limit state. Synchronization must preserve that state, manual Active changes, bindings, and creation timestamps.
- Serialize node selection and connection establishment per Controller + Selector. Each managed pool receives a distinct dispatcher cache entry even though all entries share the same mixed proxy URL.
- Fail closed whenever Controller selection or proxy connection fails. The integration never edits or reloads Mihomo configuration and never falls back to a direct connection.

## Assumptions

- The 9Router server can directly reach both the Mihomo Controller URL and the configured HTTP(S) mixed proxy URL.
- A node is eligible only when it belongs to a selected Proxy Provider and appears in the target `Selector.all` list.
- Duplicate node names across selected Providers cannot be uniquely selected through Mihomo's name-based Selector API, so they are excluded and reported.
- Mihomo's transient proxy IDs are not stable across reloads. The stable pool identity is a SHA-256 digest of `controllerId + providerName + nodeName`.
- Pool-specific dispatcher instances are required to keep tunnels established under different Selector choices isolated.
- Mihomo `alive` and history data are informational in this MVP and do not control automatic eligibility.

## MVP Scope

- Dashboard configuration for Controller URL, secret, mixed proxy URL, Provider selection, Selector selection, node preview, synchronization interval, connection test, save-and-sync, manual sync, and disable.
- Server-only secret handling with sanitized API responses and protection from the generic Settings PATCH endpoint.
- Immediate synchronization after save and process startup, followed by a configurable 1–1440 minute interval (default 5 minutes), with process-level singleton and single-flight protection.
- Transactional managed-pool upsert, stale-node marking with `sourceAvailable=false`, recovery on reappearance, duplicate reporting, and no mutation of ordinary Proxy Pools.
- Runtime propagation of Mihomo routing metadata and `strictProxy`, serialized Selector switching, pool-keyed bounded LRU dispatchers, and fail-closed request behavior.
- Reuse of provider-scoped 429 cooldown and attempted-pool exclusion so retries automatically move to a different selectable node.
- Unit and integration-style tests using controlled Controller and proxy stubs, plus an optional real-Mihomo test path.

## Not Doing

- Modifying or reloading Mihomo configuration.
- Multiple Controllers, multiple 9Router processes sharing a distributed lock, or protection from external panels changing the same Selector.
- Region or latency policies, automatic health-based filtering, or automatic deletion of disappeared nodes.
- Environment-variable configuration or expansion of the first-step cooldown feature beyond what this integration needs.
- Opening a pull request from this implementation branch.

## Open Questions

None for the MVP. The accepted defaults are one Controller, one target Selector, selected Provider intersection, five-minute synchronization, retained unavailable records, and read/select-only Controller access.
