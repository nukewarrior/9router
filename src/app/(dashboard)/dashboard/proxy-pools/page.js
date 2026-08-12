"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function getStatusVariant(status) {
  if (status === "active") return "success";
  if (status === "error") return "error";
  return "default";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function normalizeFormData(data = {}) {
  return {
    name: data.name || "",
    proxyUrl: data.proxyUrl || "",
    noProxy: data.noProxy || "",
    isActive: data.isActive !== false,
    strictProxy: data.strictProxy === true,
  };
}

const DEFAULT_MIHOMO_CONFIG = {
  id: null,
  enabled: false,
  controllerUrl: "",
  proxyUrl: "",
  selectorName: "",
  providerNames: [],
  syncIntervalMinutes: 5,
  secretConfigured: false,
};

const DEFAULT_MIHOMO_STATUS = {
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncSummary: null,
};

function normalizeMihomoConfig(data = {}) {
  data = data || {};
  const interval = Number(data.syncIntervalMinutes);
  return {
    ...DEFAULT_MIHOMO_CONFIG,
    ...data,
    id: data.id || null,
    enabled: data.enabled === true,
    controllerUrl: typeof data.controllerUrl === "string" ? data.controllerUrl : "",
    proxyUrl: typeof data.proxyUrl === "string" ? data.proxyUrl : "",
    selectorName: typeof data.selectorName === "string" ? data.selectorName : "",
    providerNames: Array.isArray(data.providerNames)
      ? data.providerNames.filter((name) => typeof name === "string")
      : [],
    syncIntervalMinutes: Number.isFinite(interval)
      ? Math.min(1440, Math.max(1, Math.round(interval)))
      : 5,
    secretConfigured: data.secretConfigured === true,
  };
}

function normalizeMihomoStatus(data = {}) {
  data = data || {};
  return {
    ...DEFAULT_MIHOMO_STATUS,
    ...data,
    lastSyncAt: data.lastSyncAt || null,
    lastSyncError: data.lastSyncError || null,
    lastSyncSummary: data.lastSyncSummary || null,
  };
}

function isMihomoPool(pool) {
  return pool?.type === "mihomo";
}

function getMihomoBooleanLabel(value, trueLabel, falseLabel) {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return "unknown";
}

function getMihomoBooleanVariant(value) {
  if (value === true) return "success";
  if (value === false) return "error";
  return "default";
}

function getPreviewItemLabel(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item || "Unknown");

  const providerName = item.providerName || item.provider || "";
  const nodeName = item.nodeName || item.node || item.name || "";
  const type = item.type ? ` (${item.type})` : "";
  const reason = item.reason || item.error || item.message;
  const label = [providerName, nodeName].filter(Boolean).join(" / ") || item.name || "Unknown";
  return `${label}${type}${reason ? ` — ${reason}` : ""}`;
}

function getSummaryCount(summary, key) {
  const value = Number(summary?.[key]);
  if (!Number.isFinite(value) && key === "unavailable") {
    const markedUnavailable = Number(summary?.markedUnavailable);
    return Number.isFinite(markedUnavailable) ? markedUnavailable : 0;
  }
  return Number.isFinite(value) ? value : 0;
}

function MihomoPreviewList({ items = [], emptyText }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div className="rounded-lg border border-border-subtle bg-bg p-3">
      <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto text-xs">
        {list.length > 0 ? list.map((item, index) => {
          const alive = item && typeof item === "object" ? item.alive : undefined;
          return (
            <li key={`${getPreviewItemLabel(item)}-${index}`} className="flex min-w-0 items-start gap-2">
              <span className="material-symbols-outlined mt-0.5 text-[14px] text-text-muted" aria-hidden="true">
                {alive === true ? "check_circle" : alive === false ? "cancel" : "info"}
              </span>
              <span className="min-w-0 flex-1 break-words text-text-main">{getPreviewItemLabel(item)}</span>
              {alive !== undefined && (
                <Badge variant={getMihomoBooleanVariant(alive)} size="sm">
                  {getMihomoBooleanLabel(alive, "alive", "unavailable")}
                </Badge>
              )}
            </li>
          );
        }) : (
          <li className="text-text-muted">{emptyText}</li>
        )}
      </ul>
    </div>
  );
}

export default function ProxyPoolsPage() {
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBatchImportModal, setShowBatchImportModal] = useState(false);
  const [showVercelModal, setShowVercelModal] = useState(false);
  const [showCloudflareModal, setShowCloudflareModal] = useState(false);
  const [showDenoModal, setShowDenoModal] = useState(false);
  const [showRelayMenu, setShowRelayMenu] = useState(false);
  const [editingProxyPool, setEditingProxyPool] = useState(null);
  const [formData, setFormData] = useState(normalizeFormData());
  const [batchImportText, setBatchImportText] = useState("");
  const [vercelForm, setVercelForm] = useState({ vercelToken: "", projectName: "vercel-relay" });
  const [cloudflareForm, setCloudflareForm] = useState({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
  const [denoForm, setDenoForm] = useState({ denoToken: "", orgDomain: "", projectName: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthProgress, setHealthProgress] = useState({ current: 0, total: 0 });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [mihomoConfig, setMihomoConfig] = useState(DEFAULT_MIHOMO_CONFIG);
  const [mihomoStatus, setMihomoStatus] = useState(DEFAULT_MIHOMO_STATUS);
  const [mihomoSummary, setMihomoSummary] = useState(null);
  const [mihomoForm, setMihomoForm] = useState({
    controllerUrl: "",
    secret: "",
    proxyUrl: "",
    selectorName: "",
    providerNames: [],
    syncIntervalMinutes: "5",
  });
  const [mihomoProviders, setMihomoProviders] = useState([]);
  const [mihomoSelectors, setMihomoSelectors] = useState([]);
  const [mihomoPreview, setMihomoPreview] = useState(null);
  const [mihomoVersion, setMihomoVersion] = useState(null);
  const [mihomoLoading, setMihomoLoading] = useState(true);
  const [mihomoTesting, setMihomoTesting] = useState(false);
  const [mihomoSaving, setMihomoSaving] = useState(false);
  const [mihomoSyncing, setMihomoSyncing] = useState(false);
  const [mihomoDisabling, setMihomoDisabling] = useState(false);
  const [mihomoClearSecret, setMihomoClearSecret] = useState(false);
  const [mihomoError, setMihomoError] = useState("");
  const relayMenuRef = useRef(null);
  const notify = useNotificationStore();

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (relayMenuRef.current && !relayMenuRef.current.contains(e.target)) {
        setShowRelayMenu(false);
      }
    };
    if (showRelayMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRelayMenu]);

  const fetchProxyPools = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setProxyPools(data.proxyPools || []);
      }
    } catch (error) {
      console.log("Error fetching proxy pools:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      fetchProxyPools();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [fetchProxyPools]);

  const fetchMihomoConfig = useCallback(async ({ silent = false } = {}) => {
    setMihomoLoading(true);
    try {
      const res = await fetch("/api/proxy-pools/mihomo", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));

      if (res.status === 404) {
        setMihomoConfig(DEFAULT_MIHOMO_CONFIG);
        setMihomoStatus(DEFAULT_MIHOMO_STATUS);
        setMihomoSummary(null);
        setMihomoForm({
          controllerUrl: "",
          secret: "",
          proxyUrl: "",
          selectorName: "",
          providerNames: [],
          syncIntervalMinutes: "5",
        });
        setMihomoProviders([]);
        setMihomoSelectors([]);
        setMihomoPreview(null);
        setMihomoVersion(null);
        setMihomoError("");
        return null;
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to load Mihomo configuration");
      }

      const config = normalizeMihomoConfig(data.config);
      const status = normalizeMihomoStatus(data.status);
      setMihomoConfig(config);
      setMihomoStatus(status);
      setMihomoSummary(status.lastSyncSummary);
      setMihomoForm((prev) => ({
        ...prev,
        controllerUrl: config.controllerUrl,
        proxyUrl: config.proxyUrl,
        selectorName: config.selectorName,
        providerNames: config.providerNames,
        syncIntervalMinutes: String(config.syncIntervalMinutes),
        secret: "",
      }));
      setMihomoClearSecret(false);
      setMihomoError("");
      return data;
    } catch {
      if (!silent) setMihomoError("Unable to load Mihomo Controller configuration.");
      return null;
    } finally {
      setMihomoLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      fetchMihomoConfig();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [fetchMihomoConfig]);

  const applyMihomoResponse = (data = {}) => {
    if (data.config) {
      setMihomoConfig(normalizeMihomoConfig(data.config));
    }
    if (data.status) {
      const status = normalizeMihomoStatus(data.status);
      setMihomoStatus(status);
      if (!data.summary) setMihomoSummary(status.lastSyncSummary);
    }
    if (data.summary) setMihomoSummary(data.summary);
  };

  const handleMihomoTest = async () => {
    const controllerUrl = mihomoForm.controllerUrl.trim();
    const proxyUrl = mihomoForm.proxyUrl.trim();
    if (!controllerUrl || !proxyUrl) {
      setMihomoError("Controller URL and mixed proxy URL are required before testing.");
      return;
    }

    const firstProviderDiscovery = mihomoProviders.length === 0 && mihomoForm.providerNames.length === 0;
    const payload = {
      controllerUrl,
      secret: mihomoForm.secret.trim(),
      proxyUrl,
    };
    if (mihomoForm.selectorName.trim()) payload.selectorName = mihomoForm.selectorName.trim();
    if (mihomoForm.providerNames.length > 0) payload.providerNames = mihomoForm.providerNames;

    setMihomoTesting(true);
    setMihomoError("");
    try {
      const res = await fetch("/api/proxy-pools/mihomo/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Mihomo connection test failed");
      }

      const providers = Array.isArray(data.providers) ? data.providers : [];
      const selectors = Array.isArray(data.selectors) ? data.selectors : [];
      setMihomoVersion(data.version || null);
      setMihomoProviders(providers);
      setMihomoSelectors(selectors);
      setMihomoPreview(data.preview || null);
      if (firstProviderDiscovery) {
        setMihomoForm((prev) => ({
          ...prev,
          providerNames: providers
            .map((provider) => provider?.name)
            .filter((name) => typeof name === "string" && name.length > 0),
        }));
      }
      if (!mihomoForm.selectorName.trim() && selectors.length === 1 && selectors[0]?.name) {
        setMihomoForm((prev) => ({ ...prev, selectorName: selectors[0].name }));
      }
      notify.success("Mihomo connection test passed");
    } catch (error) {
      setMihomoError(error.message || "Mihomo connection test failed");
      notify.error(error.message || "Mihomo connection test failed");
    } finally {
      setMihomoTesting(false);
    }
  };

  const handleMihomoSync = async ({ notifyOnSuccess = true } = {}) => {
    setMihomoSyncing(true);
    setMihomoError("");
    try {
      const res = await fetch("/api/proxy-pools/mihomo/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Mihomo sync failed");
      }

      applyMihomoResponse(data);
      await Promise.all([
        fetchMihomoConfig({ silent: true }),
        fetchProxyPools(),
      ]);
      if (notifyOnSuccess) notify.success("Mihomo pools synchronized");
      return data;
    } catch (error) {
      setMihomoError(error.message || "Mihomo sync failed");
      if (notifyOnSuccess) notify.error(error.message || "Mihomo sync failed");
      return null;
    } finally {
      setMihomoSyncing(false);
    }
  };

  const handleMihomoSave = async () => {
    const controllerUrl = mihomoForm.controllerUrl.trim();
    const proxyUrl = mihomoForm.proxyUrl.trim();
    const syncIntervalMinutes = Number(mihomoForm.syncIntervalMinutes);
    if (!controllerUrl || !proxyUrl) {
      setMihomoError("Controller URL and mixed proxy URL are required.");
      return;
    }
    if (mihomoForm.providerNames.length === 0) {
      setMihomoError("Select at least one provider after testing the connection.");
      return;
    }
    if (!mihomoForm.selectorName.trim()) {
      setMihomoError("Select a Mihomo Selector after testing the connection.");
      return;
    }
    if (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < 1 || syncIntervalMinutes > 1440) {
      setMihomoError("Sync interval must be a whole number from 1 to 1440 minutes.");
      return;
    }

    const payload = {
      enabled: true,
      controllerUrl,
      proxyUrl,
      selectorName: mihomoForm.selectorName.trim(),
      providerNames: mihomoForm.providerNames,
      syncIntervalMinutes,
    };
    const secret = mihomoForm.secret.trim();
    if (secret) payload.secret = secret;
    if (mihomoClearSecret) payload.clearSecret = true;

    setMihomoSaving(true);
    setMihomoError("");
    try {
      const res = await fetch("/api/proxy-pools/mihomo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save Mihomo configuration");
      }

      applyMihomoResponse(data);
      if (!data.summary) {
        const syncData = await handleMihomoSync({ notifyOnSuccess: false });
        if (!syncData) throw new Error("Configuration saved, but Mihomo sync failed");
      } else {
        await Promise.all([
          fetchMihomoConfig({ silent: true }),
          fetchProxyPools(),
        ]);
      }
      notify.success("Mihomo configuration saved and synchronized");
    } catch (error) {
      setMihomoError(error.message || "Failed to save Mihomo configuration");
      notify.error(error.message || "Failed to save Mihomo configuration");
    } finally {
      setMihomoSaving(false);
    }
  };

  const handleMihomoDisable = async () => {
    if (!mihomoConfig.id) return;
    setMihomoDisabling(true);
    setMihomoError("");
    try {
      const res = await fetch("/api/proxy-pools/mihomo", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to disable Mihomo Controller");
      }
      await Promise.all([
        fetchMihomoConfig({ silent: true }),
        fetchProxyPools(),
      ]);
      notify.success("Mihomo Controller disabled");
    } catch (error) {
      setMihomoError(error.message || "Failed to disable Mihomo Controller");
      notify.error(error.message || "Failed to disable Mihomo Controller");
    } finally {
      setMihomoDisabling(false);
    }
  };

  const toggleMihomoProvider = (providerName) => {
    setMihomoForm((prev) => ({
      ...prev,
      providerNames: prev.providerNames.includes(providerName)
        ? prev.providerNames.filter((name) => name !== providerName)
        : [...prev.providerNames, providerName],
    }));
    setMihomoPreview(null);
  };

  const handleMihomoSelectorChange = (selectorName) => {
    setMihomoForm((prev) => ({ ...prev, selectorName }));
    setMihomoPreview(null);
  };

  const resetForm = () => {
    setEditingProxyPool(null);
    setFormData(normalizeFormData());
  };

  const openCreateModal = () => {
    resetForm();
    setShowFormModal(true);
  };

  const openEditModal = (proxyPool) => {
    setEditingProxyPool(proxyPool);
    setFormData(normalizeFormData(proxyPool));
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    setShowFormModal(false);
    resetForm();
  };

  const handleSave = async () => {
    const payload = {
      name: formData.name.trim(),
      proxyUrl: formData.proxyUrl.trim(),
      noProxy: formData.noProxy.trim(),
      isActive: formData.isActive === true,
      strictProxy: formData.strictProxy === true,
    };

    if (!payload.name || !payload.proxyUrl) return;

    setSaving(true);
    try {
      const isEdit = !!editingProxyPool;
      const res = await fetch(isEdit ? `/api/proxy-pools/${editingProxyPool.id}` : "/api/proxy-pools", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchProxyPools();
        closeFormModal();
        notify.success(editingProxyPool ? "Proxy pool updated" : "Proxy pool created");
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to save proxy pool");
      }
    } catch (error) {
      console.log("Error saving proxy pool:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (proxyPool) => {
    setConfirmState({
      title: "Delete Proxy Pool",
      message: `Delete proxy pool "${proxyPool.name}"?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/proxy-pools/${proxyPool.id}`, { method: "DELETE" });
          if (res.ok) {
            setProxyPools((prev) => prev.filter((item) => item.id !== proxyPool.id));
            notify.success("Proxy pool deleted");
            return;
          }

          const data = await res.json();
          if (res.status === 409) {
            notify.warning(`Cannot delete: ${data.boundConnectionCount || 0} connection(s) are still using this pool.`);
          } else {
            notify.error(data.error || "Failed to delete proxy pool");
          }
        } catch (error) {
          console.log("Error deleting proxy pool:", error);
          notify.error("Failed to delete proxy pool");
        }
      }
    });
  };

  const handleTest = async (proxyPoolId) => {
    setTestingId(proxyPoolId);
    try {
      const res = await fetch(`/api/proxy-pools/${proxyPoolId}/test`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        notify.error(data.error || "Failed to test proxy");
        return;
      }

      await fetchProxyPools();
      notify.success(data.ok ? "Proxy test passed" : "Proxy test failed");
    } catch (error) {
      console.log("Error testing proxy pool:", error);
      notify.error("Failed to test proxy");
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (pool) => {
    const next = !pool.isActive;
    setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: next } : p));
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
        notify.error("Failed to update active state");
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
    }
  };

  const manageableProxyPools = useMemo(
    () => proxyPools.filter((pool) => !isMihomoPool(pool)),
    [proxyPools]
  );
  const allSelected = manageableProxyPools.length > 0 && selectedIds.length === manageableProxyPools.length;
  const toggleSelect = (id) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : manageableProxyPools.map((p) => p.id));
  const clearSelection = () => setSelectedIds([]);

  const bulkSetActive = async (isActive) => {
    const targets = selectedIds.length > 0 ? selectedIds : manageableProxyPools.map((p) => p.id);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0; let failed = 0;
      for (const id of targets) {
        try {
          const res = await fetch(`/api/proxy-pools/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive }),
          });
          if (res.ok) ok += 1; else failed += 1;
        } catch { failed += 1; }
      }
      await fetchProxyPools();
      notify.success(`${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, failed ${failed}` : ""}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setConfirmState({
      title: "Delete Proxy Pools",
      message: `Delete ${selectedIds.length} proxy pool(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setBulkBusy(true);
        try {
          let ok = 0; let blocked = 0; let failed = 0;
          for (const id of selectedIds) {
            try {
              const res = await fetch(`/api/proxy-pools/${id}`, { method: "DELETE" });
              if (res.ok) ok += 1;
              else if (res.status === 409) blocked += 1;
              else failed += 1;
            } catch { failed += 1; }
          }
          await fetchProxyPools();
          clearSelection();
          notify.success(`Deleted ${ok}${blocked ? `, ${blocked} bound` : ""}${failed ? `, ${failed} failed` : ""}`);
        } finally {
          setBulkBusy(false);
        }
      }
    });
  };

  const handleHealthCheck = async () => {
    const targets = selectedIds.length > 0
      ? manageableProxyPools.filter((p) => selectedIds.includes(p.id))
      : manageableProxyPools;
    if (targets.length === 0) return;
    setHealthChecking(true);
    setHealthProgress({ current: 0, total: targets.length });
    let alive = 0; const deadIds = [];
    let done = 0;
    const CONCURRENCY = 10;
    const queue = [...targets];

    const worker = async () => {
      while (queue.length > 0) {
        const pool = queue.shift();
        if (!pool) break;
        try {
          const res = await fetch(`/api/proxy-pools/${pool.id}/test`, { method: "POST" });
          const data = await res.json();
          if (res.ok && data.ok) alive += 1; else deadIds.push(pool.id);
        } catch {
          deadIds.push(pool.id);
        } finally {
          done += 1;
          setHealthProgress({ current: done, total: targets.length });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    await fetchProxyPools();
    setHealthChecking(false);
    setHealthProgress({ current: 0, total: 0 });

    if (deadIds.length > 0) {
      setConfirmState({
        title: "Disable Dead Proxies",
        message: `Alive: ${alive}, Dead: ${deadIds.length}.\n\nDisable ${deadIds.length} dead proxies?`,
        onConfirm: async () => {
          setConfirmState(null);
          setBulkBusy(true);
          try {
            for (const id of deadIds) {
              try {
                await fetch(`/api/proxy-pools/${id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ isActive: false }),
                });
              } catch {}
            }
            await fetchProxyPools();
            notify.success(`Disabled ${deadIds.length} dead proxies`);
          } finally {
            setBulkBusy(false);
          }
        }
      });
    } else {
      notify.success(`Health check done. Alive: ${alive}, Dead: ${deadIds.length}`);
    }
  };

  // Cleanup selectedIds when pools change
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setSelectedIds((prev) => prev.filter((id) => manageableProxyPools.some((p) => p.id === id)));
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [manageableProxyPools]);

  const openBatchImportModal = () => {
    setBatchImportText("");
    setShowBatchImportModal(true);
  };

  const closeBatchImportModal = () => {
    if (importing) return;
    setShowBatchImportModal(false);
  };

  const openVercelModal = () => {
    setVercelForm({ vercelToken: "", projectName: "vercel-relay" });
    setShowVercelModal(true);
  };

  const closeVercelModal = () => {
    if (deploying) return;
    setShowVercelModal(false);
  };

  const openCloudflareModal = () => {
    setCloudflareForm({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
    setShowCloudflareModal(true);
  };

  const closeCloudflareModal = () => {
    if (deploying) return;
    setShowCloudflareModal(false);
  };

  const openDenoModal = () => {
    setDenoForm({ denoToken: "", orgDomain: "", projectName: "" });
    setShowDenoModal(true);
  };

  const closeDenoModal = () => {
    if (deploying) return;
    setShowDenoModal(false);
  };

  const handleVercelDeploy = async () => {
    if (!vercelForm.vercelToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/vercel-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vercelForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeVercelModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Vercel relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleCloudflareDeploy = async () => {
    if (!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/cloudflare-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cloudflareForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeCloudflareModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Cloudflare relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleDenoDeploy = async () => {
    if (!denoForm.denoToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/deno-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(denoForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeDenoModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Deno relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const parseProxyLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      return {
        proxyUrl: parsed.toString(),
        name: `Imported ${hostLabel}`,
      };
    }

    const parts = trimmed.split(":");
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      if (!host || !port || !username || !password) {
        throw new Error("Invalid host:port:user:pass format");
      }

      const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      const parsed = new URL(proxyUrl);
      return {
        proxyUrl: parsed.toString(),
        name: `Imported ${host}:${port}`,
      };
    }

    throw new Error("Unsupported format");
  };

  const handleBatchImport = async () => {
    const lines = batchImportText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      notify.warning("Please paste at least one proxy line.");
      return;
    }

    const parsedEntries = [];
    const invalidLines = [];

    lines.forEach((line, index) => {
      try {
        const parsed = parseProxyLine(line);
        if (parsed) {
          parsedEntries.push({
            ...parsed,
            lineNumber: index + 1,
          });
        }
      } catch (error) {
        invalidLines.push(`Line ${index + 1}: ${error.message}`);
      }
    });

    if (invalidLines.length > 0) {
      notify.error(`Invalid proxy format:\n${invalidLines.join("\n")}`);
      return;
    }

    setImporting(true);
    try {
      const existingKeys = new Set(
        proxyPools.map((pool) => `${(pool.proxyUrl || "").trim()}|||${(pool.noProxy || "").trim()}`)
      );

      let created = 0;
      let skipped = 0;
      let failed = 0;

      for (const entry of parsedEntries) {
        const dedupeKey = `${entry.proxyUrl}|||`;
        if (existingKeys.has(dedupeKey)) {
          skipped += 1;
          continue;
        }

        const res = await fetch("/api/proxy-pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: entry.name,
            proxyUrl: entry.proxyUrl,
            noProxy: "",
            isActive: true,
          }),
        });

        if (res.ok) {
          created += 1;
          existingKeys.add(dedupeKey);
        } else {
          failed += 1;
        }
      }

      await fetchProxyPools();
      setShowBatchImportModal(false);
      notify.success(`Batch import completed: Created ${created}, Skipped ${skipped}, Failed ${failed}`);
    } catch (error) {
      console.log("Error batch importing proxies:", error);
      notify.error("Batch import failed");
    } finally {
      setImporting(false);
    }
  };

  const activeCount = useMemo(
    () => proxyPools.filter((pool) => pool.isActive === true).length,
    [proxyPools]
  );

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Proxy Pools</h1>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <div className="relative" ref={relayMenuRef}>
            <Button
              size="sm"
              variant="secondary"
              icon="rocket_launch"
              onClick={() => setShowRelayMenu(!showRelayMenu)}
            >
              Deploy Relay
              <span className="material-symbols-outlined ml-1 text-[18px]">
                {showRelayMenu ? "expand_less" : "expand_more"}
              </span>
            </Button>

            {showRelayMenu && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-zinc-900 sm:left-auto sm:right-0">
                <button
                  onClick={() => {
                    openCloudflareModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-orange-500">cloud</span>
                  Cloudflare Relay
                </button>
                <button
                  onClick={() => {
                    openVercelModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-blue-500">cloud_upload</span>
                  Vercel Relay
                </button>
                <button
                  onClick={() => {
                    openDenoModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-green-500">terminal</span>
                  Deno Relay
                </button>
              </div>
            )}
          </div>

          <Button size="sm" variant="secondary" icon="upload" onClick={openBatchImportModal}>
            Batch Import
          </Button>
          <Button size="sm" icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
        </div>
      </div>

      <Card>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="material-symbols-outlined text-[22px] text-primary" aria-hidden="true">hub</span>
              <h2 className="text-base font-semibold text-text-main sm:text-lg">Mihomo Controller</h2>
              <Badge variant={mihomoConfig.enabled ? "success" : "default"} size="sm" dot>
                {mihomoConfig.enabled ? "enabled" : "disabled"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Discover eligible Mihomo nodes and keep a managed Proxy Pool in sync.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="sync"
              onClick={() => handleMihomoSync()}
              loading={mihomoSyncing}
              disabled={!mihomoConfig.id || !mihomoConfig.enabled || mihomoSaving || mihomoTesting || mihomoDisabling}
            >
              Sync Now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="block"
              onClick={handleMihomoDisable}
              loading={mihomoDisabling}
              disabled={!mihomoConfig.id || !mihomoConfig.enabled || mihomoSaving || mihomoTesting || mihomoSyncing}
            >
              Disable
            </Button>
          </div>
        </div>

        {mihomoLoading ? (
          <div className="rounded-lg border border-border-subtle bg-bg px-3 py-4 text-sm text-text-muted" role="status">
            Loading Mihomo Controller configuration…
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="mihomo-controller-url" className="text-sm font-medium text-text-main">
                  Controller URL
                </label>
                <input
                  id="mihomo-controller-url"
                  name="controllerUrl"
                  type="url"
                  autoComplete="url"
                  value={mihomoForm.controllerUrl}
                  onChange={(e) => {
                    setMihomoForm((prev) => ({ ...prev, controllerUrl: e.target.value }));
                    setMihomoPreview(null);
                  }}
                  placeholder="http://127.0.0.1:9090"
                  aria-describedby="mihomo-controller-url-hint"
                  className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main placeholder-text-muted/70 transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                />
                <p id="mihomo-controller-url-hint" className="text-xs text-text-muted">
                  Mihomo external controller endpoint.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="mihomo-proxy-url" className="text-sm font-medium text-text-main">
                  Mixed proxy URL
                </label>
                <input
                  id="mihomo-proxy-url"
                  name="proxyUrl"
                  type="url"
                  autoComplete="url"
                  value={mihomoForm.proxyUrl}
                  onChange={(e) => {
                    setMihomoForm((prev) => ({ ...prev, proxyUrl: e.target.value }));
                    setMihomoPreview(null);
                  }}
                  placeholder="http://127.0.0.1:7890"
                  aria-describedby="mihomo-proxy-url-hint"
                  className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main placeholder-text-muted/70 transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                />
                <p id="mihomo-proxy-url-hint" className="text-xs text-text-muted">
                  The local mixed port used by managed pools.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="mihomo-secret" className="text-sm font-medium text-text-main">
                  Secret
                </label>
                <input
                  id="mihomo-secret"
                  name="secret"
                  type="password"
                  autoComplete="new-password"
                  value={mihomoForm.secret}
                  onChange={(e) => {
                    setMihomoForm((prev) => ({ ...prev, secret: e.target.value }));
                    if (e.target.value) setMihomoClearSecret(false);
                    setMihomoPreview(null);
                  }}
                  placeholder={mihomoConfig.secretConfigured ? "Leave blank to keep current secret" : "Optional controller secret"}
                  aria-describedby="mihomo-secret-hint"
                  className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main placeholder-text-muted/70 transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                />
                <p id="mihomo-secret-hint" className="text-xs text-text-muted">
                  {mihomoConfig.secretConfigured
                    ? "A stored secret is configured. Leave this empty to preserve it."
                    : "Secret is never shown after it is saved."}
                </p>
                {mihomoConfig.secretConfigured && (
                  <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-text-muted">
                    <input
                      type="checkbox"
                      checked={mihomoClearSecret}
                      onChange={(e) => setMihomoClearSecret(e.target.checked)}
                      className="size-4 rounded border-black/20 dark:border-white/20"
                    />
                    Clear stored secret
                  </label>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="mihomo-sync-interval" className="text-sm font-medium text-text-main">
                  Sync interval (minutes)
                </label>
                <input
                  id="mihomo-sync-interval"
                  name="syncIntervalMinutes"
                  type="number"
                  min="1"
                  max="1440"
                  step="1"
                  inputMode="numeric"
                  value={mihomoForm.syncIntervalMinutes}
                  onChange={(e) => setMihomoForm((prev) => ({ ...prev, syncIntervalMinutes: e.target.value }))}
                  aria-describedby="mihomo-sync-interval-hint"
                  className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main placeholder-text-muted/70 transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                />
                <p id="mihomo-sync-interval-hint" className="text-xs text-text-muted">Choose a whole number from 1 to 1440. Default: 5.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <fieldset className="min-w-0 rounded-lg border border-border-subtle p-3">
                <legend className="px-1 text-sm font-medium text-text-main">Providers</legend>
                <p className="mb-3 text-xs text-text-muted">
                  {mihomoForm.providerNames.length > 0
                    ? `${mihomoForm.providerNames.length} provider(s) selected`
                    : "Select one or more discovered providers."}
                </p>
                {mihomoProviders.length > 0 ? (
                  <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                    {mihomoProviders.map((provider, index) => {
                      const providerName = provider?.name;
                      if (!providerName) return null;
                      return (
                        <label
                          key={`${providerName}-${index}`}
                          className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-bg px-2.5 py-2 text-sm hover:bg-surface-2"
                        >
                          <input
                            type="checkbox"
                            checked={mihomoForm.providerNames.includes(providerName)}
                            onChange={() => toggleMihomoProvider(providerName)}
                            className="mt-0.5 size-4 shrink-0 rounded border-black/20 dark:border-white/20"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-text-main">{providerName}</span>
                            <span className="block text-[11px] text-text-muted">
                              {provider.vehicleType || "provider"} · {provider.nodeCount ?? provider.nodes?.length ?? 0} node(s)
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg bg-bg px-3 py-3 text-xs text-text-muted">
                    Test the connection to discover available providers.
                  </p>
                )}
              </fieldset>

              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="mihomo-selector" className="text-sm font-medium text-text-main">Selector</label>
                <select
                  id="mihomo-selector"
                  name="selectorName"
                  value={mihomoForm.selectorName}
                  onChange={(e) => handleMihomoSelectorChange(e.target.value)}
                  className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main transition-all focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                >
                  <option value="">Use controller default</option>
                  {mihomoForm.selectorName && !mihomoSelectors.some((selector) => selector?.name === mihomoForm.selectorName) && (
                    <option value={mihomoForm.selectorName}>{mihomoForm.selectorName}</option>
                  )}
                  {mihomoSelectors.map((selector, index) => (
                    <option key={`${selector?.name || "selector"}-${index}`} value={selector?.name || ""}>
                      {selector?.name || "Unnamed selector"}{selector?.now ? ` · ${selector.now}` : ""}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-text-muted">Optional selector used when choosing the source node.</p>
                {mihomoSelectors.length === 0 && (
                  <p className="rounded-lg bg-bg px-3 py-3 text-xs text-text-muted">
                    Test the connection to discover selectors.
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-text-main">Connection and node preview</h3>
                  <p className="text-xs text-text-muted">
                    {mihomoVersion?.version ? `Mihomo ${mihomoVersion.version}` : "Run a test after changing providers or selector to refresh the preview."}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="science"
                  onClick={handleMihomoTest}
                  loading={mihomoTesting}
                  disabled={mihomoSaving || mihomoSyncing || mihomoDisabling || !mihomoForm.controllerUrl.trim() || !mihomoForm.proxyUrl.trim()}
                >
                  Test Connection
                </Button>
              </div>
              {mihomoPreview ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Eligible</h4>
                      <Badge variant="success" size="sm">{mihomoPreview.eligible?.length || 0}</Badge>
                    </div>
                    <MihomoPreviewList items={mihomoPreview.eligible} emptyText="No eligible nodes" />
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Duplicates</h4>
                      <Badge variant="warning" size="sm">{mihomoPreview.duplicates?.length || 0}</Badge>
                    </div>
                    <MihomoPreviewList items={mihomoPreview.duplicates} emptyText="No duplicates" />
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Excluded</h4>
                      <Badge variant="default" size="sm">{mihomoPreview.excluded?.length || 0}</Badge>
                    </div>
                    <MihomoPreviewList items={mihomoPreview.excluded} emptyText="No excluded nodes" />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-text-muted">No preview yet.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {["created", "updated", "unavailable", "excluded", "eligible", "duplicates"].map((key) => (
                <div key={key} className="rounded-lg border border-border-subtle bg-bg px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">{key}</p>
                  <p className="mt-1 text-lg font-semibold text-text-main">{getSummaryCount(mihomoSummary, key)}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-3 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
              <span className="text-text-muted">Enabled: <strong className="text-text-main">{mihomoConfig.enabled ? "yes" : "no"}</strong></span>
              <span className="text-text-muted">Last sync: <strong className="text-text-main">{formatDateTime(mihomoStatus.lastSyncAt)}</strong></span>
              {mihomoConfig.secretConfigured && <Badge variant="success" size="sm" icon="key">Secret configured</Badge>}
            </div>

            {(mihomoError || mihomoStatus.lastSyncError) && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">
                {mihomoError || mihomoStatus.lastSyncError}
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                fullWidth
                className="sm:w-auto"
                onClick={handleMihomoSave}
                loading={mihomoSaving}
                disabled={mihomoLoading || mihomoTesting || mihomoSyncing || mihomoDisabling || !mihomoForm.controllerUrl.trim() || !mihomoForm.proxyUrl.trim()}
              >
                Save &amp; Sync
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {manageableProxyPools.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="size-4 rounded border-black/20 dark:border-white/20"
              />
              {allSelected ? "Unselect all" : "Select all"}
            </label>
          )}
          <Badge variant="default">Total: {proxyPools.length}</Badge>
          <Badge variant="success">Active: {activeCount}</Badge>
        </div>

        {(selectedIds.length > 0 || healthChecking) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="material-symbols-outlined text-[18px] text-primary">checklist</span>
            <span className="text-xs font-medium text-primary">
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : "All pools"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={healthChecking ? "progress_activity" : "health_and_safety"}
                onClick={handleHealthCheck}
                disabled={healthChecking || bulkBusy || manageableProxyPools.length === 0}
              >
                {healthChecking ? `Checking ${healthProgress.current}/${healthProgress.total}` : "Health Check"}
              </Button>
              {selectedIds.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" icon="toggle_on" onClick={() => bulkSetActive(true)} disabled={bulkBusy || healthChecking}>
                    Activate
                  </Button>
                  <Button size="sm" variant="secondary" icon="toggle_off" onClick={() => bulkSetActive(false)} disabled={bulkBusy || healthChecking}>
                    Deactivate
                  </Button>
                  <Button size="sm" variant="secondary" icon="delete" onClick={bulkDelete} disabled={bulkBusy || healthChecking}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy || healthChecking}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {proxyPools.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-text-main font-medium mb-1">No proxy pool entries yet</p>
            <p className="text-sm text-text-muted mb-4">
              Create a proxy pool entry, then assign it to connections.
            </p>
            <Button icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {proxyPools.map((pool) => {
              const mihomoPool = isMihomoPool(pool);
              return (
                <div key={pool.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {!mihomoPool && (
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(pool.id)}
                        onChange={() => toggleSelect(pool.id)}
                        aria-label={`Select ${pool.name}`}
                        className="mt-1 size-4 shrink-0 rounded border-black/20 dark:border-white/20"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[18rem]">{pool.name}</p>
                        {mihomoPool ? (
                          <>
                            <Badge variant="primary" size="sm">mihomo managed</Badge>
                            <Badge variant={getMihomoBooleanVariant(pool.sourceAlive)} size="sm" dot>
                              source {getMihomoBooleanLabel(pool.sourceAlive, "alive", "unavailable")}
                            </Badge>
                            <Badge variant={getMihomoBooleanVariant(pool.sourceAvailable)} size="sm">
                              {getMihomoBooleanLabel(pool.sourceAvailable, "source available", "source unavailable")}
                            </Badge>
                            <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                              {pool.isActive ? "active" : "inactive"}
                            </Badge>
                            {pool.strictProxy === true && <Badge variant="warning" size="sm">strict proxy</Badge>}
                          </>
                        ) : (
                          <>
                            <Badge variant={getStatusVariant(pool.testStatus)} size="sm" dot>
                              {pool.testStatus || "unknown"}
                            </Badge>
                            <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                              {pool.isActive ? "active" : "inactive"}
                            </Badge>
                            {pool.type === "vercel" && (
                              <Badge variant="default" size="sm">vercel relay</Badge>
                            )}
                            {pool.type === "cloudflare" && (
                              <Badge variant="default" size="sm">cloudflare relay</Badge>
                            )}
                          </>
                        )}
                        <Badge variant="default" size="sm">
                          {pool.boundConnectionCount || 0} bound
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-text-muted">Proxy URL: {pool.proxyUrl}</p>
                      {mihomoPool ? (
                        <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-muted">
                          <p className="break-words">Source: {pool.controllerId || "Mihomo Controller"} · Provider: {pool.providerName || "—"} · Node: {pool.nodeName || "—"}</p>
                          <p className="break-words">Selector: {pool.selectorName || "—"} · Last seen: {formatDateTime(pool.lastSeenAt)}</p>
                        </div>
                      ) : (
                        <>
                          {pool.noProxy ? (
                            <p className="mt-1 truncate text-xs text-text-muted">No proxy: {pool.noProxy}</p>
                          ) : null}
                          <p className="mt-1 text-[11px] text-text-muted">
                            Last tested: {formatDateTime(pool.lastTestedAt)}
                            {pool.lastError ? ` · ${pool.lastError}` : ""}
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-1">
                    <Toggle
                      size="sm"
                      checked={pool.isActive === true}
                      onChange={() => handleToggleActive(pool)}
                      label={mihomoPool ? (pool.isActive ? "Active" : "Inactive") : undefined}
                    />
                    {!mihomoPool && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleTest(pool.id)}
                          className="rounded p-2 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                          title="Test proxy"
                          aria-label={`Test ${pool.name}`}
                          disabled={testingId === pool.id}
                        >
                          <span
                            className="material-symbols-outlined text-[18px]"
                            style={testingId === pool.id ? { animation: "spin 1s linear infinite" } : undefined}
                            aria-hidden="true"
                          >
                            {testingId === pool.id ? "progress_activity" : "science"}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(pool)}
                          className="rounded p-2 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                          title="Edit"
                          aria-label={`Edit ${pool.name}`}
                        >
                          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(pool)}
                          className="rounded p-2 text-red-500 hover:bg-red-500/10"
                          title="Delete"
                          aria-label={`Delete ${pool.name}`}
                        >
                          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">delete</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        isOpen={showBatchImportModal}
        title="Batch Import Proxies"
        onClose={closeBatchImportModal}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste Proxy List (One per line)</label>
            <textarea
              value={batchImportText}
              onChange={(e) => setBatchImportText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
              className="w-full min-h-[180px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <p className="text-xs text-text-muted mt-1">
              Supported formats: protocol://user:pass@host:port, host:port:user:pass
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth onClick={handleBatchImport} disabled={!batchImportText.trim() || importing}>
              {importing ? "Importing..." : "Import"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeBatchImportModal} disabled={importing}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showVercelModal}
        title="Deploy Vercel Relay"
        onClose={closeVercelModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Vercel Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys an edge relay function to Vercel. All AI provider requests will be forwarded through Vercel&apos;s edge network, masking your real IP from providers.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Your IP is replaced by Vercel&apos;s dynamic edge IPs (hundreds of IPs across 20+ global regions)</li>
              <li>Vercel serves millions of apps — providers can&apos;t block Vercel IPs without affecting legitimate traffic</li>
              <li>Free tier: 100GB bandwidth/month, 500K edge invocations</li>
              <li>Deploy multiple relays on different accounts for more IP diversity</li>
            </ul>
          </div>
          <Input
            label="Vercel API Token"
            value={vercelForm.vercelToken}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, vercelToken: e.target.value }))}
            placeholder="your-vercel-api-token"
            hint={<>Token is used once for deployment and not stored. <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Project Name"
            value={vercelForm.projectName}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Vercel project. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleVercelDeploy}
              disabled={!vercelForm.vercelToken.trim() || deploying}
            >
              {deploying ? "Deploying... (may take ~1 min)" : "Deploy"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeVercelModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCloudflareModal}
        title="Deploy Cloudflare Relay"
        onClose={closeCloudflareModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-orange-500/5 border border-orange-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Cloudflare Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a Cloudflare Worker as a proxy relay. All AI provider requests will be forwarded through Cloudflare&apos;s global edge network.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>High performance global routing and IP masking via Cloudflare Workers</li>
              <li>Free tier: 100,000 requests per day</li>
              <li>Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-orange-500/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate your API Token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>My Profile</b> → <b>API Tokens</b> → <b>Create Token</b></li>
                <li>Scroll down to <b>Custom Token</b> and click <b>Get started</b></li>
                <li>Under <b>Permissions</b>: Account | Workers Scripts | Edit</li>
                <li>Under <b>Account Resources</b>: Include | Account | <i>Your Account Name</i></li>
                <li>Click <b>Continue to summary</b> → <b>Create Token</b></li>
              </ol>
            </div>
          </div>
          <Input
            label="Account ID"
            value={cloudflareForm.accountId}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, accountId: e.target.value }))}
            placeholder="your-cloudflare-account-id"
            hint={<>Found on the right side of the Cloudflare dashboard overview page.</>}
          />
          <Input
            label="API Token"
            value={cloudflareForm.apiToken}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, apiToken: e.target.value }))}
            placeholder="your-cloudflare-api-token"
            hint={<>Requires &quot;Workers Scripts: Edit&quot; permission. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Worker Name"
            value={cloudflareForm.projectName}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Cloudflare Worker. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleCloudflareDeploy}
              disabled={!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Worker"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeCloudflareModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showDenoModal}
        title="Deploy Deno Relay"
        onClose={closeDenoModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Deno Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a relay worker to Deno Deploy&apos;s global edge network. All AI provider requests are forwarded through Deno&apos;s edge, masking your real IP.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Deno Deploy v2 runs on a high-performance global edge network</li>
              <li>Free tier: 1M requests & 100GiB outbound traffic per month</li>
              <li>No per-request CPU time limits (unlike Vercel/Cloudflare)</li>
              <li>Support up to 20 active apps & 50 custom domains</li>
              <li>Deploy multiple relays for maximum IP diversity</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-black/10 dark:border-white/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate API token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>console.deno.com</b></li>
                <li>Select your <b>Organization</b> → <b>Settings</b> → <b>Organization Tokens</b></li>
                <li>Create a <b>Organization Token</b> (prefix <b>ddo_</b>)</li>
              </ol>
            </div>
          </div>
          <Input
            label="Deno Deploy API Token"
            value={denoForm.denoToken}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, denoToken: e.target.value }))}
            placeholder="ddo_xxxxxxxxxxxxxxxx"
            hint={<>Token is used once for deployment, not stored. Found in Organization Settings.</>}
            type="password"
          />
          <Input
            label="Organization Domain"
            value={denoForm.orgDomain}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, orgDomain: e.target.value }))}
            placeholder="your-org.deno.net"
            hint="Organization's default domain. Your relay URL will be in the format: https://my-relay.your-org.deno.net"
          />
          <Input
            label="App Name"
            value={denoForm.projectName}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="deno-relay"
            hint="Unique app name. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleDenoDeploy}
              disabled={!denoForm.denoToken.trim() || !denoForm.orgDomain.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Relay"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeDenoModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showFormModal}
        title={editingProxyPool ? "Edit Proxy Pool" : "Add Proxy Pool"}
        onClose={closeFormModal}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Office Proxy"
          />
          <Input
            label="Proxy URL"
            value={formData.proxyUrl}
            onChange={(e) => setFormData((prev) => ({ ...prev, proxyUrl: e.target.value }))}
            placeholder="http://127.0.0.1:7897"
          />
          <Input
            label="No Proxy"
            value={formData.noProxy}
            onChange={(e) => setFormData((prev) => ({ ...prev, noProxy: e.target.value }))}
            placeholder="localhost,127.0.0.1,.internal"
            hint="Comma-separated hosts/domains to bypass proxy"
          />

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Active</p>
              <p className="text-xs text-text-muted">Inactive pools are ignored by runtime resolution.</p>
            </div>
            <Toggle
              checked={formData.isActive === true}
              onChange={() => setFormData((prev) => ({ ...prev, isActive: !prev.isActive }))}
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Strict Proxy</p>
              <p className="text-xs text-text-muted">Fail request if proxy is unreachable instead of falling back to direct.</p>
            </div>
            <Toggle
              checked={formData.strictProxy === true}
              onChange={() => setFormData((prev) => ({ ...prev, strictProxy: !prev.strictProxy }))}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleSave}
              disabled={!formData.name.trim() || !formData.proxyUrl.trim() || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeFormModal} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
