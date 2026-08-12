import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}

function isManagedMihomoPool(pool, controllerId) {
  return pool?.type === "mihomo" && pool?.controllerId === controllerId;
}

/**
 * Transactionally mirror the currently eligible Mihomo nodes. Existing pool
 * state that belongs to routing/cooldown/manual operation is intentionally
 * carried forward by merging only the source metadata fields below.
 */
export async function syncMihomoProxyPools({
  controllerId,
  proxyUrl,
  selectorName,
  entries = [],
  now = new Date().toISOString(),
}) {
  if (typeof controllerId !== "string" || !controllerId.trim()) {
    throw new Error("Mihomo controllerId is required");
  }
  const db = await getAdapter();
  const summary = {
    created: 0,
    updated: 0,
    recovered: 0,
    markedUnavailable: 0,
    eligible: entries.length,
  };

  db.transaction(() => {
    const rows = db.all(`SELECT * FROM proxyPools`);
    const pools = rows.map(rowToPool);
    const byId = new Map(pools.map((pool) => [pool.id, pool]));
    const seenIds = new Set();

    for (const entry of entries) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id) throw new Error("Mihomo pool id is required");
      if (seenIds.has(id)) throw new Error("Duplicate Mihomo pool id");
      seenIds.add(id);

      const existing = byId.get(id);
      if (existing && !isManagedMihomoPool(existing, controllerId)) {
        const conflict = new Error("Mihomo pool id conflicts with an existing non-Mihomo pool");
        conflict.code = "MIHOMO_POOL_ID_CONFLICT";
        throw conflict;
      }

      if (existing) {
        if (existing.sourceAvailable === false) summary.recovered++;
        const merged = {
          ...existing,
          name: entry.nodeName,
          proxyUrl,
          type: "mihomo",
          strictProxy: true,
          controllerId,
          providerName: entry.providerName,
          nodeName: entry.nodeName,
          selectorName,
          sourceAvailable: true,
          sourceAlive: entry.sourceAlive ?? null,
          lastSeenAt: entry.lastSeenAt || now,
          updatedAt: now,
        };
        upsert(db, merged);
        summary.updated++;
        continue;
      }

      const created = {
        id,
        name: entry.nodeName,
        proxyUrl,
        noProxy: "",
        type: "mihomo",
        isActive: true,
        strictProxy: true,
        testStatus: "unknown",
        lastTestedAt: null,
        lastError: null,
        controllerId,
        providerName: entry.providerName,
        nodeName: entry.nodeName,
        selectorName,
        sourceAvailable: true,
        sourceAlive: entry.sourceAlive ?? null,
        lastSeenAt: entry.lastSeenAt || now,
        createdAt: now,
        updatedAt: now,
      };
      upsert(db, created);
      summary.created++;
    }

    for (const pool of pools) {
      if (!isManagedMihomoPool(pool, controllerId) || seenIds.has(pool.id)) continue;
      if (pool.sourceAvailable === false) continue;
      upsert(db, { ...pool, sourceAvailable: false, updatedAt: now });
      summary.markedUnavailable++;
    }
  });

  return summary;
}

export async function markMihomoPoolsUnavailable(controllerId) {
  if (typeof controllerId !== "string" || !controllerId.trim()) return 0;
  const db = await getAdapter();
  let marked = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM proxyPools`);
    for (const row of rows) {
      const pool = rowToPool(row);
      if (!isManagedMihomoPool(pool, controllerId) || pool.sourceAvailable === false) continue;
      upsert(db, { ...pool, sourceAvailable: false, updatedAt: new Date().toISOString() });
      marked++;
    }
  });
  return marked;
}
