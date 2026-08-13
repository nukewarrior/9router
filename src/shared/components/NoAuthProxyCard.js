"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

async function responseErrorMessage(response, fallback) {
  try {
    const data = await response.json();
    if (data?.error) return String(data.error);
  } catch {
    // Keep the local fallback when the server did not return JSON.
  }
  return fallback;
}

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error(await responseErrorMessage(response, "Unable to load proxy pools"));
        return response.json();
      }),
      fetch("/api/settings", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error(await responseErrorMessage(response, "Unable to load proxy settings"));
        return response.json();
      }),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      const selectedPool = (poolData.proxyPools || []).find((pool) => pool.id === override.proxyPoolId);
      setRotateStrategy(selectedPool?.type === "mihomo" ? "none" : (override.rotateStrategy || "none"));
      if (selectedPool?.type === "mihomo" && override.rotateStrategy && override.rotateStrategy !== "none") {
        const repaired = { ...override };
        delete repaired.rotateStrategy;
        fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerStrategies: { ...(settingsData.providerStrategies || {}), [providerId]: repaired },
          }),
        }).then(async (response) => {
          if (response.ok || cancelled) return;
          const message = await responseErrorMessage(response, "Unable to repair proxy settings");
          setSaveError(message);
          console.error("[NoAuthProxyCard] Automatic settings repair failed:", message);
        }).catch((error) => {
          if (cancelled) return;
          const message = error?.message || "Unable to repair proxy settings";
          setSaveError(message);
          console.error("[NoAuthProxyCard] Automatic settings repair failed:", error);
        });
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = error?.message || "Unable to load proxy settings";
      setSaveError(message);
      console.error("[NoAuthProxyCard] Loading proxy settings failed:", error);
    });
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy, previousState = null) => {
    setSaving(true);
    setSavedFlash(false);
    setSaveError("");
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Unable to load proxy settings"));
      const data = await res.json();
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      const saveResponse = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      if (!saveResponse.ok) {
        throw new Error(await responseErrorMessage(saveResponse, "Failed to save proxy config"));
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (error) {
      if (previousState) {
        setProxyPoolId(previousState.proxyPoolId);
        setRotateStrategy(previousState.rotateStrategy);
      }
      const message = error?.message || "Failed to save proxy config";
      setSaveError(message);
      console.error("[NoAuthProxyCard] Save proxy config failed:", error);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handleStrategyChange = (newStrategy) => {
    const previousState = { proxyPoolId, rotateStrategy };
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy, previousState);
  };

  const isRotation = rotateStrategy !== "none";
  const selectedPool = proxyPools.find((pool) => pool.id === proxyPoolId);
  const isMihomoManaged = selectedPool?.type === "mihomo";
  const rotatableProxyPools = proxyPools.filter((pool) => pool.type !== "mihomo");
  const canRotate = rotatableProxyPools.length >= 2;

  const handlePoolChangeSafe = (newPoolId) => {
    const nextPool = proxyPools.find((pool) => pool.id === newPoolId);
    const nextStrategy = nextPool?.type === "mihomo" ? "none" : rotateStrategy;
    const previousState = { proxyPoolId, rotateStrategy };
    setProxyPoolId(newPoolId);
    setRotateStrategy(nextStrategy);
    save(newPoolId, nextStrategy, previousState);
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      {saveError && (
        <p role="alert" className="mb-3 text-xs text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChangeSafe(e.target.value)}
        disabled={saving || (isRotation && !isMihomoManaged)}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isMihomoManaged
          ? "Managed by Mihomo node routing. Outer pool rotation is disabled for this selection."
          : isRotation
            ? "Pool selector is ignored when rotation is active — all active non-Mihomo pools are used."
            : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving || isMihomoManaged}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {isMihomoManaged
            ? "This pool manages its own Mihomo nodes and cannot participate in outer proxy pool rotation."
            : !canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${rotatableProxyPools.length} active non-Mihomo pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${rotatableProxyPools.length} active non-Mihomo pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
