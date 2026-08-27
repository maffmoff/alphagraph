import { assertNumber, assertString } from "./core.mjs";

// ClickHouse Cloud のコントロールプレーン（api.clickhouse.cloud）。
// Warehouse/サービスの新設・コスト監視をコンソール手作業からAPIに置き換える。
// tenant-admin.mjs（データプレーン）と同じ規律で用途分離を構造で守る:
//   1. 読む環境変数は ALPHAGRAPH_TENANT_CLOUD_* の3つだけ。フォールバック経路なし。
//      keyはテナント用organization専用に発行する（bot-2509本番のorg keyを流用しない）
//   2. 接続先は https://api.clickhouse.cloud 固定。資格情報が他所へ向かう経路がない
// 旧secondary事故(#3812)の核心は「idle停止が発動していないことに誰も気付かなかった」なので、
// 作成時に idleScaling の実効値を検証し、日次コストをAPIで読める形にしておく。

export const CLOUD_API_ROOT = "https://api.clickhouse.cloud";

export function tenantCloudFromEnv(env = process.env) {
  const keyId = env.ALPHAGRAPH_TENANT_CLOUD_KEY_ID;
  const keySecret = env.ALPHAGRAPH_TENANT_CLOUD_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error(
      "Set ALPHAGRAPH_TENANT_CLOUD_KEY_ID and ALPHAGRAPH_TENANT_CLOUD_KEY_SECRET. "
      + "Issue this OpenAPI key for the tenant organization only; never reuse a bot-2509 production key.",
    );
  }
  return {
    apiRoot: CLOUD_API_ROOT,
    keyId: assertString(keyId, "cloud key id", { max: 100 }),
    keySecret: assertString(keySecret, "cloud key secret", { max: 200 }),
    organizationId: env.ALPHAGRAPH_TENANT_CLOUD_ORG_ID ?? null,
  };
}

async function api(client, method, path, body, fetchImpl = fetch, timeoutMs = 60_000) {
  const url = new URL(client.apiRoot + path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${client.keyId}:${client.keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse Cloud API ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text).result;
    } catch {
      throw new Error(`ClickHouse Cloud API ${method} ${path} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveOrganizationId(client, fetchImpl = fetch) {
  if (client.organizationId) return client.organizationId;
  const organizations = await api(client, "GET", "/v1/organizations", undefined, fetchImpl);
  if (!Array.isArray(organizations) || organizations.length !== 1) {
    throw new Error(
      `The API key sees ${Array.isArray(organizations) ? organizations.length : 0} organizations. `
      + "Set ALPHAGRAPH_TENANT_CLOUD_ORG_ID explicitly so the service cannot land in the wrong one.",
    );
  }
  return organizations[0].id;
}

// ingress は明示させる。段階ロールアウト（docs/data-tenancy.md §5）の Phase 1 は自分だけなので、
// 全開は 'anywhere' と書いた時だけ。黙って 0.0.0.0/0 にしない。
export function parseIpAllowList(value) {
  const raw = assertString(value, "ip allow list", { max: 2000 });
  if (raw === "anywhere") {
    return [{ source: "0.0.0.0/0", description: "open ingress (deliberate; RBAC and quotas are the enforcement)" }];
  }
  return raw.split(",").map((entry) => {
    const source = assertString(entry.trim(), "ip entry", { max: 60, pattern: /^[0-9a-fA-F.:]+(\/\d{1,3})?$/ });
    return { source, description: "alphagraph tenant allowlist" };
  });
}

// 小構成・idle停止つきの専用サービスを新設する。warehouseId を渡すと既存Warehouseの
// read-only secondary（compute-compute separation、設計の方式A）として立てる。
export async function provisionTenantService(client, options, fetchImpl = fetch) {
  const organizationId = await resolveOrganizationId(client, fetchImpl);
  const name = assertString(options.name ?? "alphagraph-tenant", "service name", { max: 50, pattern: /^[A-Za-z0-9 _-]+$/ });
  const provider = assertString(options.provider, "provider", { max: 10, pattern: /^(aws|gcp|azure)$/ });
  const region = assertString(options.region, "region", { max: 30, pattern: /^[a-z0-9-]+$/ });
  const memoryGb = assertNumber(options.memoryGb ?? 8, "memoryGb", { min: 8, max: 356, integer: true });
  const idleTimeoutMinutes = assertNumber(options.idleTimeoutMinutes ?? 15, "idleTimeoutMinutes", { min: 5, max: 1440, integer: true });
  if (!Array.isArray(options.ipAccessList) || !options.ipAccessList.length) {
    throw new Error("provisionTenantService requires an explicit ipAccessList.");
  }
  const request = {
    name,
    provider,
    region,
    ipAccessList: options.ipAccessList,
    minReplicaMemoryGb: memoryGb,
    maxReplicaMemoryGb: memoryGb,
    numReplicas: 1,
    idleScaling: true,
    idleTimeoutMinutes,
    ...(options.warehouseId
      ? { dataWarehouseId: assertString(options.warehouseId, "warehouseId", { max: 60 }), isReadonly: true }
      : {}),
  };
  const result = await api(client, "POST", `/v1/organizations/${organizationId}/services`, request, fetchImpl);
  const service = result?.service;
  if (!service?.id || typeof result?.password !== "string") {
    throw new Error("ClickHouse Cloud did not return a service and its password.");
  }
  const warnings = [];
  // #3812 の再演防止: 「idle停止を頼んだ」ではなく「idle停止が設定された」を実測で確認する。
  if (service.idleScaling !== true) warnings.push("idleScaling did NOT come back enabled. Fix it before leaving the service running.");
  const https = (service.endpoints ?? []).find((endpoint) => endpoint.protocol === "https");
  if (!https) warnings.push("No https endpoint was returned; look the endpoint up in the console.");
  return {
    organizationId,
    service,
    password: result.password,
    adminUrl: https ? `https://${https.host}:${https.port}` : null,
    warnings,
  };
}

// 日次コスト（CHC建て）。予算アラートの代替ではなく先行線: コンソールの請求通知とは別に、
// 機械が毎日読める数字をここから取る（cron候補、flop-watch と同型）。
export async function fetchUsageCost(client, { fromDate, toDate }, fetchImpl = fetch) {
  const organizationId = await resolveOrganizationId(client, fetchImpl);
  for (const [label, value] of [["fromDate", fromDate], ["toDate", toDate]]) {
    assertString(value, label, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  }
  const path = `/v1/organizations/${organizationId}/usageCost?from_date=${fromDate}&to_date=${toDate}`;
  const result = await api(client, "GET", path, undefined, fetchImpl);
  const services = new Map();
  for (const record of result?.costs ?? []) {
    if (record.entityType !== "service") continue;
    const entry = services.get(record.entityName) ?? { entityName: record.entityName, totalCHC: 0, days: 0 };
    entry.totalCHC += Number(record.totalCHC) || 0;
    entry.days += 1;
    services.set(record.entityName, entry);
  }
  return {
    organizationId,
    fromDate,
    toDate,
    grandTotalCHC: Number(result?.grandTotalCHC) || 0,
    services: [...services.values()].sort((a, b) => b.totalCHC - a.totalCHC),
  };
}
